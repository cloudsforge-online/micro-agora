/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no `setInterval`
 * in this repository doing domain work and CI greps for one. The lease key names the contended
 * resource, not the row:
 *
 *   | Work                 | Key            | Why                                                  |
 *   |----------------------|----------------|------------------------------------------------------|
 *   | outbox.relay         | `stream`       | The outbox stream. Keying on an event id would let    |
 *   |                      |                | two relays deliver one batch to a subscriber twice.   |
 *   | achievement.sweep    | `stream`       | The backlog of undelivered achievements. Enqueues and |
 *   |                      |                | nothing else.                                         |
 *   | achievement.deliver  | `<ach id>`     | The one job that posts to worlds. Keyed per           |
 *   |                      |                | achievement, so two workers cannot both deliver one.  |
 *   | season.rollover      | `stream`       | Keeps exactly one season active.                      |
 */

import { JobRunner, type Job, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs';
import type { Logger, Metrics } from '@cloudsforge/telemetry';
import type { LedgerClient } from './ledgerclient.ts';
import type { WorldsClient } from './worldsclient.ts';
import { createRelay, withOutbox, type Db } from './outbox.ts';
import { deliverAchievement, outstandingAchievementIds } from './achievements.ts';
import { ensureActiveSeason, grantSeasonReward, BudgetExceededError } from './seasons.ts';

export const RELAY_KIND = 'outbox.relay';
export const ACH_SWEEP_KIND = 'achievement.sweep';
export const ACH_DELIVER_KIND = 'achievement.deliver';
export const SEASON_ROLLOVER_KIND = 'season.rollover';
/** Grants a season pass its welcome reward, keyed by the entitlement so it pays once. */
export const SEASON_REWARD_KIND = 'season.reward';

/**
 * The welcome reward a season pass grants, in EMBER wei. A modest, budget-capped amount.
 *
 * 20 EMBER. This was `WELCOME_REWARD_SHARDS = 500n` until micro-org#226, and the figure is the
 * same money CONVERTED, not relabelled: 500 Shards at 100 Shards to the USD (SHARDS_PER_USD) is
 * USD 5, and at EMBER's administered 0.25 USD that is 20 EMBER — 2e19 wei, the frozen rate
 * migration 9 uses. Grouped so the eighteen zeroes can be counted rather than trusted.
 */
export const WELCOME_REWARD_WEI = 20_000_000_000_000_000_000n;

export interface JobDeps {
  readonly sql: Db;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly worlds: WorldsClient;
  readonly ledger: LedgerClient;
  readonly producer: string;
  readonly signingSecret: string;
  readonly seasonBudgetWei: bigint;
  readonly queue: Pick<JobQueue, 'enqueue'>;
}

export interface Recurring {
  readonly kind: string;
  readonly key: string;
  readonly everyMs: number;
}

export const RECURRING: readonly Recurring[] = Object.freeze([
  { kind: RELAY_KIND, key: 'stream', everyMs: 1_000 },
  { kind: ACH_SWEEP_KIND, key: 'stream', everyMs: 5_000 },
  { kind: SEASON_ROLLOVER_KIND, key: 'stream', everyMs: 60_000 },
]);

/** Enqueue each recurring job once. `keep` collapses N replicas booting into one row. */
export async function seedRecurring(queue: Pick<JobQueue, 'enqueue'>): Promise<void> {
  for (const r of RECURRING) await queue.enqueue({ kind: r.kind, key: r.key, onConflict: 'keep' });
}

/** Re-arm a recurring job after it completes (never from inside the handler). */
export async function rescheduleRecurring(queue: Pick<JobQueue, 'enqueue'>, kind: string, key: string): Promise<void> {
  const r = RECURRING.find((x) => x.kind === kind && x.key === key);
  if (!r) return;
  await queue.enqueue({ kind, key, runAt: new Date(Date.now() + r.everyMs), onConflict: 'keep' });
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): void {
  runner.register(RELAY_KIND, createRelay({ sql: deps.sql, logger: deps.logger, signingSecret: deps.signingSecret }));

  runner.register(ACH_SWEEP_KIND, async () => {
    const ids = await outstandingAchievementIds(deps.sql);
    for (const id of ids) await deps.queue.enqueue({ kind: ACH_DELIVER_KIND, key: id, payload: { id }, onConflict: 'keep' });
  });

  runner.register<{ id?: string }>(ACH_DELIVER_KIND, async (job: Job<{ id?: string }>) => {
    const id = job.payload.id ?? job.key;
    await deliverAchievement({ sql: deps.sql, worlds: deps.worlds, logger: deps.logger }, id, `ach:${job.id}`);
  });

  runner.register(SEASON_ROLLOVER_KIND, async () => {
    await ensureActiveSeason(deps.sql, deps.producer, deps.seasonBudgetWei, new Date(), withOutbox);
  });

  runner.register<{ userId?: string; entitlementId?: string; amount?: string }>(
    SEASON_REWARD_KIND,
    async (job: Job<{ userId?: string; entitlementId?: string; amount?: string }>) => {
      const userId = job.payload.userId;
      const entitlementId = job.payload.entitlementId ?? job.key;
      if (!userId) return;
      const amount = job.payload.amount ? BigInt(job.payload.amount) : WELCOME_REWARD_WEI;
      const seasonId = await ensureActiveSeason(deps.sql, deps.producer, deps.seasonBudgetWei, new Date(), withOutbox);
      try {
        await grantSeasonReward(
          deps.sql,
          deps.producer,
          deps.ledger,
          { seasonId, userId, reason: `season_pass:${entitlementId}`, amount, correlationId: `reward:${job.id}` },
          withOutbox,
        );
      } catch (err) {
        // A budget exhaustion is terminal, not a retry: the cap did its job. Anything else (a ledger
        // outage) throws and the runner reschedules with the same derived key.
        if (err instanceof BudgetExceededError) {
          deps.logger.warn('season reward refused by budget', { entitlementId, err: err.message });
          return;
        }
        throw err;
      }
    },
  );
}

/** Wire recurring re-arm to the runner's completed event. */
export function onRunnerEvent(queue: Pick<JobQueue, 'enqueue'>, logger: Logger): (event: RunnerEvent) => void {
  return (event) => {
    if (event.type === 'completed' && event.kind && event.key) {
      void rescheduleRecurring(queue, event.kind, event.key).catch((err) =>
        logger.warn('reschedule failed', { kind: event.kind, err: err instanceof Error ? err.message : String(err) }),
      );
    }
    if (event.type === 'dead' || event.type === 'error') {
      logger.warn('job event', { type: event.type, kind: event.kind, err: event.error });
    }
  };
}
