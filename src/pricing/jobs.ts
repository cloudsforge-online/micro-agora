/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no
 * `setInterval` in this repository doing domain work, and adding one fails review.
 *
 * **This service is the clearest case for that rule in the estate.** The oracle it replaces runs
 * `setInterval(tick, env.oracleRefreshSeconds * 1000)` at `pricing.ts`, guarded by nothing at
 * all. With three replicas that is three refresh rounds a minute against four exchanges — three
 * times the rate-limit consumption, and three different medians written to three different Maps,
 * so which rate a user is quoted depends on which replica the balancer picked.
 *
 * **The lease key names the contended resource, not the row.** Ask: what would break if two of
 * these ran at once? Whatever the answer names, that is the key.
 *
 *   | Work          | Key      | What two at once would break                                    |
 *   |---------------|----------|-----------------------------------------------------------------|
 *   | outbox.relay  | `stream` | The outbox stream. Two relays deliver one batch twice.          |
 *   | price.refresh | `global` | The quote set, which is one set for the whole estate. Keying on |
 *   |               |          | the asset instead would let four rounds run concurrently, each  |
 *   |               |          | making its own request to every exchange for every asset, and   |
 *   |               |          | the rate-limit rejection that follows would take out the source |
 *   |               |          | count for all of them at once. `global` is also the key         |
 *   |               |          | docs/ecosystem records for `price.refresh` in the jobs package. |
 */

import { JobRunner, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { createRelay, type RelayDeps, type Db } from './outbox.ts'
import { refreshRound } from './oracle.ts'
import type { PriceSource } from './sources.ts'

export const RELAY_KIND = 'outbox.relay'
export const REFRESH_KIND = 'price.refresh'

export interface JobDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly signingSecret: string
  readonly sources: readonly PriceSource[]
  readonly minSources: number
  readonly maxDivergenceBps: number
  readonly refreshSeconds: number
}

export interface RecurringJob {
  readonly kind: string
  readonly key: string
  readonly everyMs: number
}

/**
 * Jobs that must exist whether or not anything enqueued them, and how often they repeat.
 *
 * A recurring job is a producer plus a leased job, never a timer. The producer is the boot seed
 * plus the reschedule on completion — so the interval survives a restart, is visible in a table an
 * operator can query, and is claimed by exactly one replica.
 */
export function recurringJobs(deps: Pick<JobDeps, 'refreshSeconds'>): RecurringJob[] {
  return [
    { kind: RELAY_KIND, key: 'stream', everyMs: 1_000 },
    { kind: REFRESH_KIND, key: 'global', everyMs: deps.refreshSeconds * 1_000 },
  ]
}

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue, deps: Pick<JobDeps, 'refreshSeconds'>): Promise<void> {
  for (const job of recurringJobs(deps)) {
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
 * a job that has failed its full attempt budget hides a permanent fault behind a busy loop — and a
 * refresh that has stopped is an estate whose rates go stale and then, correctly, unusable.
 */
export function rescheduleRecurring(
  queue: JobQueue,
  logger: Logger,
  deps: Pick<JobDeps, 'refreshSeconds'>,
): (event: RunnerEvent) => void {
  const byKey = new Map(recurringJobs(deps).map((job) => [`${job.kind}|${job.key}`, job]))
  return (event) => {
    if (event.type !== 'completed') return
    const recurring = event.kind && event.key ? byKey.get(`${event.kind}|${event.key}`) : undefined
    if (!recurring) return
    void queue
      .enqueue({
        kind: recurring.kind,
        key: recurring.key,
        runAt: new Date(Date.now() + recurring.everyMs),
        onConflict: 'earliest',
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: recurring.kind, err }))
  }
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  const relayDeps: RelayDeps = {
    sql: deps.sql,
    logger: deps.logger.child({ job: RELAY_KIND }),
    signingSecret: deps.signingSecret,
  }
  runner.register(RELAY_KIND, createRelay(relayDeps))

  runner.register(REFRESH_KIND, async (_job, ctx) => {
    const log = deps.logger.child({ job: REFRESH_KIND })
    const report = await refreshRound({
      sql: deps.sql,
      logger: log,
      metrics: deps.metrics,
      sources: deps.sources,
      minSources: deps.minSources,
      maxDivergenceBps: deps.maxDivergenceBps,
    })
    // The round is short, but the lease must outlive the slowest exchange and four HTTP deadlines
    // can add up. A heartbeat after the writes is what stops a second replica claiming the refresh
    // while this one is still finishing it.
    await ctx.heartbeat()
    log.info('price round complete', {
      sourcesAnswered: report.sourcesAnswered,
      sourcesAttempted: report.sourcesAttempted,
      accepted: report.assets.filter((a) => a.outcome === 'accepted').length,
      rejected: report.assets.filter((a) => a.outcome !== 'accepted').map((a) => a.asset),
    })
  })

  return runner
}
