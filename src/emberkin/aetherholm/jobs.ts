/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no `setInterval`
 * in this repository doing domain work and CI greps for one. The lease key names the contended
 * resource, not the row:
 *
 *   | Work          | Key                    | Why                                             |
 *   |---------------|------------------------|-------------------------------------------------|
 *   | outbox.relay  | `stream`               | The outbox stream. Keying on an event id would  |
 *   |               |                        | let two relays deliver one batch twice.         |
 *   | season.ensure | `stream`               | At most one open season; the partial unique     |
 *   |               |                        | index is the second guard behind the lease.     |
 *   | city.queue    | `city:<id>`            | Queue completion for ONE city. Two replicas     |
 *   |               |                        | cannot both apply its due items — and the       |
 *   |               |                        | `status = 'queued'` guard holds even if they    |
 *   |               |                        | could.                                          |
 *   | fleet.arrive  | `fleet:<id>`           | ONE fleet's arrival — and later its return. The |
 *   |               |                        | key names the fleet, so two replicas racing one |
 *   |               |                        | arrival produce one battle; `battles_fleet_uniq`|
 *   |               |                        | is the structural floor beneath the lease.      |
 *   | siege.resolve | `plot:<islandId>:<n>`  | The CONTENDED PLOT, not any one fleet: every    |
 *   |               |                        | battle for a besieged plot serialises under one |
 *   |               |                        | lease, in arrival order, against a garrison     |
 *   |               |                        | that carries its losses forward.                |
 *   | season.close  | `season:<id>`          | Day 120. Enqueued for `ends_at` when the season |
 *   |               |                        | opens; `season.ensure` re-enqueues (`keep`) so  |
 *   |               |                        | a season opened before this job existed still   |
 *   |               |                        | gets its closing day. Not a timer.              |
 *
 * There is no per-minute economy tick anywhere in this table, and that is the design: resource
 * stocks are lazy (src/economy.ts) and need no job at all.
 */

import type { Job, JobQueue, JobRunner, RunnerEvent } from '@cloudsforge/jobs';
import type { Logger, Metrics } from '@cloudsforge/telemetry';
import { createRelay, withOutbox, type Db } from './outbox.ts';
import { completeDue } from './cities.ts';
import { ensureOpenSeason } from './seasons.ts';
import { completeReturn, resolveArrival, resolveSieges, type ArrivalInstruction } from './fleets.ts';
import { ensureLattice } from './lattice.ts';
import { sealSeason } from './sealing.ts';

export const RELAY_KIND = 'outbox.relay';
export const SEASON_ENSURE_KIND = 'season.ensure';
export const CITY_QUEUE_KIND = 'city.queue';
export const FLEET_KIND = 'fleet.arrive';
export const SIEGE_KIND = 'siege.resolve';
export const SEASON_CLOSE_KIND = 'season.close';

export function cityQueueKey(cityId: string): string {
  return `city:${cityId}`;
}

export function fleetKey(fleetId: string): string {
  return `fleet:${fleetId}`;
}

export function plotKey(islandId: string, plot: number): string {
  return `plot:${islandId}:${plot}`;
}

export function seasonKey(seasonId: string): string {
  return `season:${seasonId}`;
}

export interface JobDeps {
  readonly sql: Db;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly producer: string;
  readonly signingSecret: string;
  readonly queue: Pick<JobQueue, 'enqueue'>;
}

export interface Recurring {
  readonly kind: string;
  readonly key: string;
  readonly everyMs: number;
}

export const RECURRING: readonly Recurring[] = Object.freeze([
  { kind: RELAY_KIND, key: 'stream', everyMs: 1_000 },
  { kind: SEASON_ENSURE_KIND, key: 'stream', everyMs: 60_000 },
]);

/** Enqueue each recurring job once. `keep` collapses N replicas booting into one row. */
export async function seedRecurring(queue: Pick<JobQueue, 'enqueue'>): Promise<void> {
  for (const r of RECURRING) await queue.enqueue({ kind: r.kind, key: r.key, onConflict: 'keep' });
}

/** Re-arm a recurring job after it completes (never from inside the handler). */
export async function rescheduleRecurring(
  queue: Pick<JobQueue, 'enqueue'>,
  kind: string,
  key: string,
): Promise<void> {
  const r = RECURRING.find((x) => x.kind === kind && x.key === key);
  if (!r) return;
  await queue.enqueue({ kind, key, runAt: new Date(Date.now() + r.everyMs), onConflict: 'keep' });
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): void {
  runner.register(
    RELAY_KIND,
    createRelay({ sql: deps.sql, logger: deps.logger, signingSecret: deps.signingSecret }),
  );

  runner.register(SEASON_ENSURE_KIND, async () => {
    const season = await ensureOpenSeason(deps.sql, deps.producer, new Date(), withOutbox);
    // The phase-2 companions of an open season, both idempotent and both convergent: the
    // lattice/spire backfill (a phase-1 world grows its lanes here) and the closing-day job —
    // `keep` collapses every tick's enqueue into the one row waiting for `ends_at`.
    await ensureLattice(deps.sql, season.archipelagoId);
    await deps.queue.enqueue({
      kind: SEASON_CLOSE_KIND,
      key: seasonKey(season.id),
      payload: { seasonId: season.id },
      runAt: season.endsAt,
      onConflict: 'keep',
    });
  });

  // NOTE the shape of every fleet re-arm: a handler NEVER enqueues its own (kind, key). While a
  // job runs, its row still exists and is claimed; an enqueue for the same pair is absorbed into
  // that row by the unique, and the runner's `complete()` then DELETES it — the re-arm is lost,
  // silently. Re-arms for the same key therefore happen in `onRunnerEvent`, AFTER the delete,
  // exactly as the recurring jobs always did. Cross-key enqueues (a fleet arming a plot's siege
  // job, a siege arming a fleet's return) are safe from inside a handler.
  runner.register<{ fleetId?: string }>(FLEET_KIND, async (job: Job<{ fleetId?: string }>) => {
    const fleetId = job.payload.fleetId ?? job.key.replace(/^fleet:/, '');
    const now = new Date();
    const instruction = await resolveArrival(deps.sql, deps.producer, fleetId, now, withOutbox);
    if (instruction.kind === 'siege') {
      await followInstruction(deps.queue, fleetId, instruction);
    } else if (instruction.kind === 'none') {
      // Not an outbound arrival: this fire is either the return leg coming due, or early.
      await completeReturn(deps.sql, deps.producer, fleetId, now, withOutbox);
    }
    // 'return' — and an early fire — re-arm from the completed event (rearmFleet below).
  });

  runner.register<{ islandId?: string; plot?: number }>(
    SIEGE_KIND,
    async (job: Job<{ islandId?: string; plot?: number }>) => {
      const islandId = job.payload.islandId ?? job.key.split(':')[1] ?? '';
      const plot = job.payload.plot ?? Number(job.key.split(':')[2] ?? 0);
      const instructions = await resolveSieges(deps.sql, deps.producer, islandId, plot, new Date(), withOutbox);
      for (const instruction of instructions) {
        if (instruction.fleetId) await followInstruction(deps.queue, instruction.fleetId, instruction);
      }
    },
  );

  runner.register<{ seasonId?: string }>(SEASON_CLOSE_KIND, async (job: Job<{ seasonId?: string }>) => {
    const seasonId = job.payload.seasonId ?? job.key.replace(/^season:/, '');
    await sealSeason(deps.sql, deps.producer, seasonId, new Date(), withOutbox);
    // An early fire seals nothing and needs no re-arm here: the recurring season.ensure
    // re-enqueues this job (`keep`, runAt ends_at) on its next minute, after this row is gone.
  });

  runner.register<{ cityId?: string }>(CITY_QUEUE_KIND, async (job: Job<{ cityId?: string }>) => {
    const cityId = job.payload.cityId ?? job.key.replace(/^city:/, '');
    await completeDue(deps.sql, deps.producer, cityId, new Date(), withOutbox);
    // The re-arm for the next queued item happens in rearmCityQueue, AFTER the runner deletes
    // this row. Phase 1 enqueued it right here — same kind, same key — and that enqueue was
    // absorbed into THIS claimed row and deleted with it, so the second queued item of a pair
    // only ever completed because a later submission re-armed the city by accident.
  });
}

/** Turn an arrival's instruction into the next leased job. Exported for the fleet tests. */
export async function followInstruction(
  queue: Pick<JobQueue, 'enqueue'>,
  fleetId: string,
  instruction: ArrivalInstruction,
): Promise<void> {
  if (instruction.kind === 'siege' && instruction.islandId && instruction.plot !== undefined) {
    await queue.enqueue({
      kind: SIEGE_KIND,
      key: plotKey(instruction.islandId, instruction.plot),
      payload: { islandId: instruction.islandId, plot: instruction.plot },
      onConflict: 'earliest',
    });
  } else if (instruction.kind === 'return' && instruction.returnsAt) {
    await queue.enqueue({
      kind: FLEET_KIND,
      key: fleetKey(fleetId),
      payload: { fleetId },
      runAt: instruction.returnsAt,
      onConflict: 'earliest',
    });
  }
}

/** Re-arm a city's completion job from its next queued item. Runs AFTER the row was deleted. */
export async function rearmCityQueue(
  sql: Db,
  queue: Pick<JobQueue, 'enqueue'>,
  cityId: string,
): Promise<void> {
  const next = await sql<{ next: Date | null }[]>`
    select min(completes_at) as next from queue_items
     where city_id = ${cityId} and status = 'queued'
  `;
  const runAt = next[0]?.next;
  if (!runAt) return;
  await queue.enqueue({
    kind: CITY_QUEUE_KIND,
    key: cityQueueKey(cityId),
    payload: { cityId },
    runAt,
    onConflict: 'earliest',
  });
}

/** Re-arm a fleet's job from whatever leg it still owes. Runs AFTER the row was deleted. */
export async function rearmFleet(
  sql: Db,
  queue: Pick<JobQueue, 'enqueue'>,
  fleetId: string,
): Promise<void> {
  const rows = await sql<{ status: string; arrives_at: Date; returns_at: Date | null }[]>`
    select status, arrives_at, returns_at from fleets where id = ${fleetId}
  `;
  const fleet = rows[0];
  if (!fleet) return;
  // 'besieging' belongs to the plot's lease and 'done' to history; neither re-arms this key.
  const runAt =
    fleet.status === 'outbound'
      ? fleet.arrives_at
      : fleet.status === 'returning'
        ? fleet.returns_at
        : null;
  if (!runAt) return;
  await queue.enqueue({
    kind: FLEET_KIND,
    key: fleetKey(fleetId),
    payload: { fleetId },
    runAt,
    onConflict: 'earliest',
  });
}

/**
 * Wire re-arms to the runner's completed event — the one moment a same-key enqueue is safe,
 * because the finished row has just been deleted.
 */
export function onRunnerEvent(
  deps: Pick<JobDeps, 'sql' | 'queue' | 'logger'>,
): (event: RunnerEvent) => void {
  return (event) => {
    if (event.type === 'completed' && event.kind && event.key) {
      const kind = event.kind;
      const key = event.key;
      void (async () => {
        await rescheduleRecurring(deps.queue, kind, key);
        if (kind === CITY_QUEUE_KIND) {
          await rearmCityQueue(deps.sql, deps.queue, key.replace(/^city:/, ''));
        }
        if (kind === FLEET_KIND) {
          await rearmFleet(deps.sql, deps.queue, key.replace(/^fleet:/, ''));
        }
      })().catch((err) =>
        deps.logger.warn('re-arm after completion failed', {
          kind,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    if (event.type === 'dead' || event.type === 'error') {
      deps.logger.warn('job event', { type: event.type, kind: event.kind, err: event.error });
    }
  };
}
