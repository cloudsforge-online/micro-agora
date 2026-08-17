/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no
 * `setInterval` in this repository doing domain work and CI greps for one — a module-local boolean
 * guard is, by construction, invisible to a second process.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE LEASE KEY NAMES THE CONTENDED RESOURCE, NOT THE ROW.**
 *
 * Ask: what would break if two of these ran at once? Whatever the answer names is the key.
 *
 *   | Work                | Key      | Why                                                       |
 *   |---------------------|----------|-----------------------------------------------------------|
 *   | outbox.relay        | `stream` | The outbox stream. Keying on the event id would let two    |
 *   |                     |          | relays deliver one batch twice.                            |
 *   | agora.email         | `stream` | The mail sweep. This is the one that MATTERS: two workers  |
 *   |                     |          | over one window emit two mail_requested events for one     |
 *   |                     |          | notification, and notify sends the person two              |
 *   |                     |          | copies. A duplicate email is the most visible failure this |
 *   |                     |          | service can produce, because it lands in somebody's inbox  |
 *   |                     |          | rather than in a log.                                      |
 *   | agora.notifications | `stream` | Retention. Two of them delete the same rows and the second |
 *   |                     | .reap    | finds none.                                                |
 *   | agora.buckets.reap  | `stream` | Rate-bucket housekeeping. Same argument.                   |
 *
 * **A KEY IS NOT A LOCK ACROSS KINDS.** The jobs table is unique on `(kind, key)`, so all four
 * rows above may be held at the same instant by four workers. That is safe here because no two of
 * them write the same table: the relay reads `outbox`, the mail sweep reads `notifications` and
 * writes `outbox`, and the two reapers delete from tables nothing else is holding.
 *
 * The relay and the mail sweep DO both write `outbox`, and that is fine: the sweep inserts and the
 * relay marks published. An insert and an update of different rows do not contend.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { JobRunner, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { createRelay, type Db, type RelayDeps } from './outbox.ts'
import { sweepEmail, sweepOld, type NotificationDeps } from './notifications.ts'
import { sweepBuckets } from './ratelimit.ts'
import { countOpen } from './moderation.ts'

export const RELAY_KIND = 'outbox.relay'
/** The ONLY job that emits opted-in mail events. See the header — duplicates land in an inbox. */
export const EMAIL_KIND = 'agora.email'
export const NOTIFICATION_REAP_KIND = 'agora.notifications.reap'
export const BUCKET_REAP_KIND = 'agora.buckets.reap'

export interface Recurring {
  readonly kind: string
  readonly key: string
  readonly everyMs: number
  readonly payload?: Record<string, unknown>
}

/**
 * The mail sweep's period, and the window it reads, are deliberately the same order of magnitude.
 *
 * Fifteen minutes: long enough that a burst of replies to one thread becomes one mail rather than
 * six, and long enough that somebody who opens the app reads the notification before it is sent.
 * `sweepEmail`'s `until` is one minute in the past so a notification written a moment ago is not
 * mailed before the person has had any chance to see it.
 */
const EMAIL_EVERY_MS = 15 * 60_000

export const RECURRING: readonly Recurring[] = Object.freeze([
  { kind: RELAY_KIND, key: 'stream', everyMs: 1_000, payload: {} },
  { kind: EMAIL_KIND, key: 'stream', everyMs: EMAIL_EVERY_MS, payload: {} },
  { kind: NOTIFICATION_REAP_KIND, key: 'stream', everyMs: 6 * 3_600_000, payload: {} },
  { kind: BUCKET_REAP_KIND, key: 'stream', everyMs: 3_600_000, payload: {} },
])

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: Pick<JobQueue, 'enqueue'>): Promise<void> {
  for (const job of RECURRING) {
    await queue.enqueue({
      kind: job.kind,
      key: job.key,
      onConflict: 'keep',
      ...(job.payload ? { payload: job.payload } : {}),
    })
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
 * increments and `jobs_overdue` climbs, which is how an operator finds out.
 */
export function rescheduleRecurring(
  queue: Pick<JobQueue, 'enqueue'>,
  logger: Logger,
): (event: RunnerEvent) => void {
  const byKey = new Map(RECURRING.map((job) => [`${job.kind} ${job.key}`, job]))
  return (event) => {
    if (event.type !== 'completed' || !event.kind || !event.key) return
    const job = byKey.get(`${event.kind} ${event.key}`)
    if (!job) return
    void queue
      .enqueue({
        kind: job.kind,
        key: job.key,
        runAt: new Date(Date.now() + job.everyMs),
        onConflict: 'earliest',
        ...(job.payload ? { payload: job.payload } : {}),
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: job.kind, err }))
  }
}

export interface JobDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly signingSecret: string
  readonly notifications: NotificationDeps
  /**
   * The queue the sweeps enqueue onto.
   *
   * Passed in rather than closed over at module scope. A module-local queue would be exactly the
   * shape of the module-local boolean rule 8 exists to keep out: invisible to a second process,
   * and impossible to substitute in a test.
   */
  readonly queue: Pick<JobQueue, 'enqueue'>
}

/* ------------------------------------------------------------------ the handlers, as functions */

/** Exposed so tests drive them directly, without a runner, a lease or a sleep. */
export async function runEmailSweep(deps: JobDeps): Promise<number> {
  const result = await sweepEmail(deps.notifications, EMAIL_EVERY_MS / 60_000)
  deps.metrics.increment('agora_notification_emails_total', {}, result.emitted)
  deps.metrics.set('agora_email_sweep_considered', result.considered)
  return result.emitted
}

export async function runNotificationReap(deps: JobDeps): Promise<number> {
  const deleted = await sweepOld(deps.notifications)
  if (deleted > 0) deps.metrics.increment('agora_notifications_reaped_total', {}, deleted)
  return deleted
}

export async function runBucketReap(deps: JobDeps): Promise<number> {
  return sweepBuckets(deps.sql)
}

/**
 * The open-report gauge, sampled by the reapers rather than given a job of its own.
 *
 * A count is not work, so it does not need a lease. Hanging it off a job that already runs is one
 * fewer row in the jobs table and one fewer thing to re-arm — and the number an operator wants
 * from `agora_reports_open` is "roughly how big is the queue", which an hourly sample answers.
 */
export async function sampleQueueDepth(deps: JobDeps): Promise<void> {
  deps.metrics.set('agora_reports_open', await countOpen(deps.sql))
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  const relayDeps: RelayDeps = {
    sql: deps.sql,
    logger: deps.logger.child({ job: RELAY_KIND }),
    signingSecret: deps.signingSecret,
  }
  runner.register(RELAY_KIND, createRelay(relayDeps))

  runner.register(EMAIL_KIND, async (_job, ctx) => {
    if (ctx.signal.aborted) return
    const emitted = await runEmailSweep(deps)
    if (emitted > 0) deps.logger.info('mail sweep', { emitted })
  })

  runner.register(NOTIFICATION_REAP_KIND, async (_job, ctx) => {
    if (ctx.signal.aborted) return
    const deleted = await runNotificationReap(deps)
    if (deleted > 0) deps.logger.info('notification retention sweep', { deleted })
    await sampleQueueDepth(deps)
  })

  runner.register(BUCKET_REAP_KIND, async (_job, ctx) => {
    if (ctx.signal.aborted) return
    const deleted = await runBucketReap(deps)
    if (deleted > 0) deps.logger.debug('rate buckets swept', { deleted })
    await sampleQueueDepth(deps)
  })

  return runner
}
