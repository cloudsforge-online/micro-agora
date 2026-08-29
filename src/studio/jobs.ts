/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no
 * `setInterval` in this repository doing domain work, and adding one fails CI — the frozen estate
 * runs eight of them, each guarded only by a module-local boolean, which is a variable that by
 * construction cannot be seen by a second process.
 *
 * **The lease key names the contended resource, not the row.** This is the decision most likely to
 * be got wrong by someone extending this file, and it is where the correctness lives. Ask: what
 * would break if two of these ran at once? Whatever the answer names is the key.
 *
 *   | Work            | Key             | Why                                                    |
 *   |-----------------|-----------------|--------------------------------------------------------|
 *   | outbox.relay    | `stream`        | The contended resource is the outbox stream. Keying on  |
 *   |                 |                 | the event id would let two relays deliver one batch     |
 *   |                 |                 | twice to the same subscriber.                           |
 *   | asset.generate  | `owner:<subj>`  | The contended resource is that owner's SPEND, not the   |
 *   |                 |                 | job row. Two generations for one owner running at once  |
 *   |                 |                 | interleave a reservation with a settlement, and the cap |
 *   |                 |                 | stops being a cap. Keying on the job id would let an    |
 *   |                 |                 | owner run their whole budget in parallel.               |
 *
 * A generation is the long piece of work in this service — 20 to 40 seconds against FLUX — which
 * is exactly why it is here and not in the request handler.
 */

import { JobRunner, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger } from '@cloudsforge/telemetry'
import { createRelay, type Db, type RelayDeps } from './outbox.ts'
import { GENERATE_KIND, runGeneration, type RunDeps } from './generation.ts'

export const RELAY_KIND = 'outbox.relay'
export { GENERATE_KIND }

/**
 * Jobs that must exist whether or not anything enqueued them, and how often they repeat.
 *
 * A recurring job is a producer plus a leased job, never a timer. The producer is the boot seed
 * below plus the reschedule on completion — so the interval survives a restart, is visible in a
 * table an operator can query, and is claimed by exactly one replica.
 *
 * `asset.generate` is deliberately NOT in here: it is enqueued by a request, not by a clock.
 */
export const RECURRING: ReadonlyArray<{ kind: string; key: string; everyMs: number }> = [
  { kind: RELAY_KIND, key: 'stream', everyMs: 1_000 },
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
  readonly generation: RunDeps
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  const relayDeps: RelayDeps = {
    sql: deps.sql,
    logger: deps.logger.child({ job: RELAY_KIND }),
    signingSecret: deps.signingSecret,
  }
  runner.register(RELAY_KIND, createRelay(relayDeps))

  runner.register<{ generationJobId?: string }>(GENERATE_KIND, async (job, ctx) => {
    const generationJobId = job.payload.generationJobId
    if (typeof generationJobId !== 'string') {
      // A payload that cannot be acted on is a permanent fault. Throwing burns the attempt budget
      // and dead-letters it, which is correct: retrying will not make the payload valid.
      throw new Error(`${GENERATE_KIND} requires a string generationJobId`)
    }
    // `ctx.signal` is the drain and the lease deadline. It is threaded all the way into `fetch`,
    // so a SIGTERM aborts an in-flight image call rather than waiting out its 120-second budget.
    const outcome = await runGeneration(deps.generation, generationJobId, ctx.signal)

    // The handler SUCCEEDS even when the generation failed. That is deliberate: a 404 from an
    // undeployed model is a permanent, recorded, refunded outcome on the generation_jobs row, and
    // throwing here would instead retry it five times and then dead-letter a job whose real state
    // is already written down. The runner's failure budget is for faults it can retry past.
    await ctx.heartbeat()
    if (outcome.job.status === 'failed') {
      deps.logger.info('generation job finished as failed', {
        generationJobId,
        code: outcome.job.errorCode,
      })
    }
  })

  return runner
}
