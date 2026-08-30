/**
 * Background work. Every piece of it is a leased job.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THERE IS NO `setInterval` IN THIS REPOSITORY AND NO `cfctl-allow` ESCAPE HATCH ANYWHERE.**
 *
 * §11.4 and §12's test 13. The rule is enforced by a CI grep, not a lint rule —
 * `org/.github/workflows/service-ci.yml`, exiting 1 on a hit, with an inline
 * `cfctl-allow setInterval` comment as the only way past it. This repository uses no escape hatch,
 * and `jobs.test.ts` greps its own source for both the timer and the hatch so the claim is
 * measured rather than asserted.
 *
 * It does not need one, because the two things that look like they want a timer do not:
 *
 *   * **Presence** is push-on-change — a move writes a row and a database trigger raises
 *     `pg_notify`; the hub forwards it. No broadcast loop exists (`presence.ts`).
 *   * **Fallow** is lazy — computed on read from three columns and settled on write, so there is
 *     no nightly sweep marking parcels dead (`fallow.ts`, and the absence of a `fallow` status in
 *     migration 4).
 *
 * The recurring jobs below ARE periodic, and that is a different thing: a producer plus a leased
 * job, re-armed from the runner's completion event. The interval survives a restart, is visible in
 * a table an operator can query, and is claimed by exactly one replica.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **THE LEASE KEY NAMES THE CONTENDED RESOURCE, NOT THE ROW.** This is the decision most likely to
 * be got wrong by whoever extends this file, and it is where the correctness lives. Ask: what
 * would break if two of these ran at once? Whatever the answer names, that is the key.
 *
 *   | Work                | Key                | The contended resource                          |
 *   |---------------------|--------------------|-------------------------------------------------|
 *   | outbox.relay        | `stream`           | The outbox stream. Keying on the event id would  |
 *   |                     |                    | let two relays deliver one batch twice. The same |
 *   |                     |                    | key market/src/jobs.ts and               |
 *   |                     |                    | settlement/src/jobs.ts both use.              |
 *   | ward.mint           | `ward:<wardId>`    | The ward's occupancy, and the decision to mint a |
 *   |                     |                    | neighbour. Two runs mint two wards for one       |
 *   |                     |                    | crossing of 70%.                                 |
 *   | parcel.settle       | `parcel:<id>`      | ONE parcel's claim, transfer, fallow settlement  |
 *   |                     |                    | and contest resolution — §11.4. Not `contest:    |
 *   |                     |                    | <id>`: two contests on one parcel are exactly    |
 *   |                     |                    | the pair that must not resolve concurrently.     |
 *   | kiln.fire           | `owner:<subject>`  | The player's place in the provider queue.        |
 *   |                     |                    | DELIBERATELY the same key shape studio uses      |
 *   |                     |                    | (studio/src/generation.ts), so one player's  |
 *   |                     |                    | firings serialise consistently on BOTH sides.    |
 */

import { JobRunner, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger } from '@cloudsforge/telemetry'
import { createRelay, type Db, type RelayDeps } from './outbox.ts'
import {
  completeFiring,
  failFiring,
  firingLeaseKey,
  firingProgressOf,
  recordBrandKit,
  recordGeneration,
} from './kiln.ts'
import { openWard, resolveContest, wardsNeedingANeighbour, type Archetype } from './world.ts'
import type { StudioClient } from './studioclient.ts'

export const RELAY_KIND = 'outbox.relay'
export const WARD_MINT_KIND = 'ward.mint'
export const PARCEL_SETTLE_KIND = 'parcel.settle'
export const KILN_FIRE_KIND = 'kiln.fire'

/**
 * Jobs that must exist whether or not anything enqueued them, and how often they repeat.
 *
 * `ward.mint` is keyed `sweep` rather than by a ward id because it is the job that ASKS which
 * wards need a neighbour; the answer names wards, and the minting of each one takes the
 * `ward:<id>` key. Keying the asking job by a ward would need a ward to ask about first.
 */
export const RECURRING: ReadonlyArray<{ kind: string; key: string; everyMs: number }> = [
  { kind: RELAY_KIND, key: 'stream', everyMs: 1_000 },
  // Once a minute. Occupancy moves at the speed of people claiming ground, and a ward that
  // crosses 70% at 12:00:30 having a neighbour at 12:01:00 is indistinguishable from instant.
  { kind: WARD_MINT_KIND, key: 'sweep', everyMs: 60_000 },
]

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue): Promise<void> {
  for (const job of RECURRING) {
    await queue.enqueue({ kind: job.kind, key: job.key, onConflict: 'keep' })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * It cannot re-arm itself from inside its own handler: the runner deletes the row on success
 * *after* the handler returns, so a self-enqueue would be deleted a moment later and the schedule
 * would stop. Doing it from the completion event is the only point at which the row is gone.
 *
 * A dead-lettered recurring job is deliberately **not** re-armed. The row stays, `jobs_dead_total`
 * increments and `jobs_overdue` climbs, which is how an operator finds out. Silently rescheduling
 * a job that has failed its full attempt budget hides a permanent fault behind a busy loop.
 */
export function rescheduleRecurring(queue: JobQueue, logger: Logger): (event: RunnerEvent) => void {
  const byKind = new Map(RECURRING.map((r) => [r.kind, r]))
  return (event) => {
    if (event.type !== 'completed') return
    const recurring = event.kind ? byKind.get(event.kind) : undefined
    if (!recurring) return
    void queue
      .enqueue({
        kind: recurring.kind,
        key: recurring.key,
        runAt: new Date(Date.now() + recurring.everyMs),
        onConflict: 'earliest',
      })
      .catch((err: unknown) =>
        logger.error('failed to re-arm recurring job', { kind: recurring.kind, err }),
      )
  }
}

export interface JobDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly signingSecret: string
  readonly studio?: StudioClient
}

/** The eight archetypes, cycled by ordinal so a new ward is not always an ashfield. */
const ARCHETYPE_CYCLE: readonly Archetype[] = Object.freeze([
  'ashfield',
  'terrace',
  'wharf',
  'undercroft',
  'glasshouse',
  'kilnyard',
  'grove',
  'saltflat',
])

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  const relayDeps: RelayDeps = {
    sql: deps.sql,
    logger: deps.logger.child({ job: RELAY_KIND }),
    signingSecret: deps.signingSecret,
  }
  runner.register(RELAY_KIND, createRelay(relayDeps))

  /**
   * Mint a neighbour for every ward past 70%.
   *
   * §4: "Supply is elastic; location is not. When a ward crosses 70% occupancy, the next ward
   * mints automatically. So there is always free ground. What there is not always is *good*
   * ground."
   *
   * The `slug` is derived from the count of wards, and `openWard` derives `ordinal` inside its own
   * transaction against a unique constraint — so two replicas that somehow both ran this produce
   * one ward and one failure rather than two wards. The lease makes that rare; the constraint
   * makes it correct.
   */
  runner.register(WARD_MINT_KIND, async (_job, ctx) => {
    const full = await wardsNeedingANeighbour(deps.sql)
    if (full.length === 0) return
    for (const ward of full) {
      if (ctx.signal.aborted) return
      const nextOrdinal = ward.ordinal + 1
      const archetype = ARCHETYPE_CYCLE[nextOrdinal % ARCHETYPE_CYCLE.length] ?? 'ashfield'
      try {
        const minted = await openWard(deps.sql, {
          slug: `ward-${nextOrdinal}`,
          name: `Ward ${nextOrdinal}`,
          archetype,
          correlationId: `ward-mint-${ward.id}`,
          actor: 'system',
        })
        deps.logger.info('ward minted', {
          because: ward.id,
          occupancy: ward.occupancy,
          minted: minted.id,
        })
      } catch (err) {
        // A slug collision means somebody else already minted this neighbour. That is the
        // constraint doing its job, not a failure worth burning an attempt over.
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('wards_slug_key') || message.includes('wards_ordinal_key')) {
          deps.logger.info('a neighbour already exists', { because: ward.id })
          continue
        }
        throw err
      }
      await ctx.heartbeat()
    }
  })

  /**
   * Settle one parcel: resolve its open contest if the window has passed.
   *
   * Keyed `parcel:<id>` — the parcel, never the contest. Two contests on one parcel are exactly
   * the pair that must not resolve concurrently, and keying by the contest would give each its own
   * lease and let both win.
   *
   * The window itself is not checked here. `resolveContest` writes through the same transaction
   * the database's `contests_respect_the_window` trigger guarded on insert, so a contest that
   * exists is one the window already permitted. Re-checking in TypeScript would be a second
   * answer, on a second clock.
   */
  runner.register<{ contestId?: string }>(PARCEL_SETTLE_KIND, async (job, ctx) => {
    const contestId = job.payload.contestId
    if (typeof contestId !== 'string') {
      // A payload that cannot be acted on is a PERMANENT fault. Throwing burns the attempt budget
      // and dead-letters it, which is correct — retrying will not make the payload valid.
      throw new Error(`${PARCEL_SETTLE_KIND} requires a string contestId`)
    }
    if (ctx.signal.aborted) return
    const parcel = await resolveContest(deps.sql, contestId, `contest-${contestId}`)
    deps.logger.info('contest resolved', { contestId, parcelId: parcel.id, to: parcel.ownerSubject })
  })

  /**
   * Fire an object against `micro-studio`.
   *
   * Keyed `owner:<subject>` — §11.4, "deliberately the same key shape studio uses
   * (`studio/src/generation.ts`), so one player's firings serialise consistently on both
   * sides." A different key here would mean Tessera dispatching ten requests studio then
   * serialises anyway, with nine holding a lease slot for nothing.
   */
  // `prompt` is deliberately NOT a payload field. It was one, in the type only — nothing ever set
  // it — and the handler read it. The description lives on the object row; see below.
  runner.register<{ objectId?: string; subject?: string }>(
    KILN_FIRE_KIND,
    async (job, ctx) => {
      const objectId = job.payload.objectId
      const subject = job.payload.subject
      if (typeof objectId !== 'string' || typeof subject !== 'string') {
        throw new Error(`${KILN_FIRE_KIND} requires a string objectId and subject`)
      }
      if (!deps.studio) {
        // No Kiln configured. The firing is marked failed with a reason rather than retried for
        // ever against an upstream that does not exist — and the route already answers 503, so
        // reaching here means the configuration changed under a queued job.
        await failFiring(deps.sql, objectId, 'no Kiln upstream is configured for this deployment')
        return
      }
      if (ctx.signal.aborted) return
      try {
        // ═════════════════════════════════════════════════════════════════════════════════════
        // THE ROW IS THE STATE, NOT THE PAYLOAD — AND THE PAYLOAD NEVER HELD THE PROMPT.
        //
        // This handler used to read `job.payload.prompt`, falling back to `''`. Nothing has ever
        // put a prompt on that payload: `index.ts` enqueues `{ objectId, subject }`. So even
        // against a route that existed, every firing would have asked studio to generate from an
        // empty description — which studio refuses outright for a `world_object`
        // (`studio/src/prompt.ts`), because an empty one "would silently generate 'a
        // Tessera', which is not an object anybody asked for".
        //
        // The row holds the description, the author, and how far the last attempt got. Reading
        // the AUTHOR from the row rather than from the payload matters for the same reason
        // migration 11 gives about market's seller: the row is who fired it, and the kit studio
        // mints has to belong to them.
        // ═════════════════════════════════════════════════════════════════════════════════════
        const progress = await firingProgressOf(deps.sql, objectId)
        if (!progress) {
          // A payload naming an object that does not exist cannot be made valid by retrying.
          throw new Error(`${KILN_FIRE_KIND} names object ${objectId}, which does not exist`)
        }
        if (progress.status !== 'firing') {
          // Already fired or already failed. A redelivery has nothing to do, and re-running would
          // buy a second generation for an object that has its bytes.
          deps.logger.info('firing already settled; the redelivery has nothing to do', {
            objectId,
            status: progress.status,
          })
          return
        }

        let statusUrl = progress.statusUrl
        if (!statusUrl) {
          let brandKitId = progress.brandKitId
          if (!brandKitId) {
            const kit = await deps.studio.createKit({
              objectId,
              authorSubject: progress.authorSubject,
              description: progress.description,
            })
            brandKitId = kit.brandKitId
            // Written BEFORE the generation is asked for. A crash in the gap is then a resumable
            // firing rather than one wedged behind a kit name studio will 409 for ever.
            await recordBrandKit(deps.sql, objectId, brandKitId)
          }
          const started = await deps.studio.startGeneration({ brandKitId })
          // Likewise, and this one is money: studio reserves and settles a real FLUX call against
          // the owner's cap, and reads no idempotency key. A retry that started a second
          // generation would charge twice for one object, quietly.
          await recordGeneration(deps.sql, objectId, started.generationJobId, started.statusUrl)
          statusUrl = started.statusUrl
        }
        await ctx.heartbeat()

        const outcome = await deps.studio.awaitGeneration({ statusUrl, signal: ctx.signal })
        await completeFiring(deps.sql, {
          objectId,
          checksum: outcome.checksum,
          // MEASURED off the bytes by studio, carried through unchanged — and `null` when studio
          // published no measurement, which is today. §2.2: "The estate measures c2pa and never
          // asserts it; a repo that asserts it is a repo that will be wrong quietly."
          c2pa: outcome.c2pa,
          correlationId: `firing-${objectId}`,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // ═══════════════════════════════════════════════════════════════════════════════════
        // THE LAST ATTEMPT MARKS THE ROW, EARLIER ONES DO NOT.
        //
        // The handler must RETHROW to get a retry — the runner's backoff is
        // min(1000 x 2^(attempt-1), 5 min) with full jitter, five attempts then `dead`
        // (runtime/packages/jobs/src/index.ts, :90). A handler that marked the object
        // `failed` on its first error would turn one provider blip into a lost object.
        //
        // But a job that dead-letters silently leaves the object stuck on `firing` for ever, and
        // the runner's `dead` EVENT cannot fix that: `RunnerEvent` carries `kind`, `key`,
        // `jobId` and `attempts` and NOT the payload, and the lease key here names the
        // OWNER rather than the object — deliberately, so firings serialise per player. So the
        // event has no way to say which object died.
        //
        // `job.attempts` and `job.maxAttempts` are on the Job the handler already holds,
        // so the last attempt marks the row and then rethrows anyway, which keeps the job's own
        // dead-letter accounting intact. Discovered by reading the runner rather than by assuming
        // the event carried enough — an earlier draft of this file wired a `dead` listener that
        // could not have worked.
        // ═══════════════════════════════════════════════════════════════════════════════════
        if (job.attempts >= job.maxAttempts) {
          await failFiring(deps.sql, objectId, message)
          deps.logger.error('firing dead-lettered', { objectId, attempts: job.attempts, err: message })
        } else {
          deps.logger.warn('firing failed, will retry', {
            objectId,
            attempt: job.attempts,
            of: job.maxAttempts,
            err: message,
          })
        }
        throw err
      }
    },
  )

  return runner
}
