/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no `setInterval`
 * doing domain work in this repository and CI greps for one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHAT AN UNLEASED TIMER WOULD COST *HERE*, SPECIFICALLY.**
 *
 * The rule reads like tidiness until it is priced per job, and this service's most expensive one
 * is the most expensive in the estate:
 *
 *   `proposal.execute`   Two replicas both find the same passed, timelocked proposal and both
 *                        execute it. **The community's treasury is spent twice** — two ledger
 *                        entries, real money, out of an account whose owners agreed to spend it
 *                        once. This is `micro-settlement`'s lost-payment race wearing governance
 *                        clothes, and it is why this job's lease key is the PROPOSAL rather than
 *                        `global`: the contended resource is one proposal's execution, and two
 *                        different proposals may safely execute at once.
 *
 *   `proposal.transition` Two replicas both close the same proposal. Harmless in itself — the
 *                        transition is claimed with `where status = 'voting'` and one UPDATE
 *                        matches nothing — but both would enqueue an execution, and the tally
 *                        would be computed twice for no reason. Keyed `global` because it scans a
 *                        shared range.
 *
 *   `membership.recheck` Two replicas both re-check the same token-gated members. Doubles the
 *                        outbound load on the indexer, which is the upstream this service is
 *                        already told is hard for this job. Keyed `global`.
 *
 *   `outbox.relay`       Every internal subscriber receives every event twice. Here that means
 *                        `community.proposal.executed` delivered twice, and its consumers are
 *                        ledger, activity and notify — so a member is told twice that their
 *                        community spent money, and the feed shows two spends where one happened.
 *
 *   `retention`          Two DELETEs over the same range. Harmless, and doubles the load of the
 *                        heaviest statement this service runs.
 *
 * The lease key names the contended resource, not the row — `@cloudsforge/jobs` `index.ts`. For
 * four of these that resource is a shared range, so the key is `global`. For `proposal.execute` the
 * resource genuinely IS the row, and `jobs.test.ts` proves both halves: two runners with different
 * owners and one due execution produce exactly one execution and one ledger entry, and two
 * DIFFERENT proposals still execute concurrently rather than queueing behind each other.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { type Job, type JobQueue, type JobRunner, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import type { Db, Emit, Tx } from './outbox.ts'
import { createRelay } from './outbox.ts'
import { reapIdempotencyKeys } from './idempotency.ts'
import { findCommunity } from './communities.ts'
import {
  findProposal,
  proposalsDueToClose,
  proposalsDueToExecute,
  proposalsDueToOpen,
  transition,
} from './proposals.ts'
import { weightsFor } from './votes.ts'
import { rejectionReason, tally } from './tally.ts'
import { TOPICS } from './events.ts'
import {
  executeProposal,
  SpendRefusedError,
  TimelockError,
  type ExecuteDeps,
} from './executions.ts'
import { PolicyUnavailableError } from './policyclient.ts'
import { membersDueForRecheck, recheckMember, type HoldingsOracle } from './gating.ts'

export const RELAY_KIND = 'outbox.relay'
export const TRANSITION_KIND = 'proposal.transition'
export const EXECUTE_KIND = 'proposal.execute'
export const RECHECK_KIND = 'membership.recheck'
export const RETENTION_KIND = 'retention'

export interface Recurring {
  readonly kind: string
  readonly key: string
  readonly everyMs: number
}

/**
 * The recurring set.
 *
 * `proposal.execute` is NOT here: it is enqueued per proposal, keyed by that proposal, at the
 * moment the transition job puts one into `timelocked`. A recurring `global` execute job would
 * serialise every community's treasury behind one lease, so one slow ledger call would delay every
 * other community's execution — and the lease key would then be lying about what it protects.
 *
 * The transition job ticks every ten seconds because a proposal's close time is a promise made to
 * the people who voted: "voting closes at 18:00" meaning "some time in the next minute" is the
 * kind of imprecision that produces support tickets during a contested vote.
 */
export const RECURRING: readonly Recurring[] = Object.freeze([
  { kind: RELAY_KIND, key: 'global', everyMs: 1_000 },
  { kind: TRANSITION_KIND, key: 'global', everyMs: 10_000 },
  { kind: RECHECK_KIND, key: 'global', everyMs: 300_000 },
  { kind: RETENTION_KIND, key: 'global', everyMs: 3_600_000 },
])

/** The lease key for one proposal's execution. The contended resource is the proposal. */
export function executeKey(proposalId: string): string {
  return `proposal:${proposalId}`
}

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue): Promise<void> {
  for (const job of RECURRING) {
    await queue.enqueue({ kind: job.kind, key: job.key, onConflict: 'keep', payload: {} })
  }
}

/**
 * Re-arm a recurring job from its completion event — the only moment the row is gone.
 *
 * A dead-lettered recurring job is deliberately NOT re-armed: the row stays, `jobs_dead_total`
 * climbs, and that is how an operator learns the thing scheduling everything else has stopped. A
 * silent re-arm would turn a permanently failing job into an invisible one.
 *
 * `proposal.execute` is absent from the map, so a completed execution is not re-armed and a dead
 * one is not either — the row remains, naming the proposal that could not be executed, which is
 * exactly what an operator needs to see.
 */
export function rescheduleRecurring(queue: JobQueue, logger: Logger): (event: RunnerEvent) => void {
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
        payload: {},
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: job.kind, err }))
  }
}

export interface JobDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly queue: JobQueue
  readonly signingSecret: string
  readonly producer: string
  readonly execute: Pick<ExecuteDeps, 'ledger' | 'policy'>
  readonly oracle: HoldingsOracle
  readonly gate: {
    readonly intervalHours: number
    readonly batchSize?: number
  }
  readonly idempotencyTtlDays: number
  readonly batchSize?: number
}

/** Write an outbox row on a transaction the caller already holds. */
export function emitOn(tx: Tx, producer: string, event: Parameters<Emit>[0]): Promise<void> {
  return tx`
    insert into outbox (topic, key, producer, version, actor, correlation_id, payload)
    values (${event.topic}, ${event.key}, ${producer}, ${event.version ?? 1},
            ${event.actor ?? null}, ${event.correlationId ?? null},
            ${tx.json(event.payload as Record<string, never>)})
  `.then(() => undefined)
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  return runner
    .register(RELAY_KIND, createRelay({
      sql: deps.sql,
      logger: deps.logger,
      signingSecret: deps.signingSecret,
      ...(deps.batchSize !== undefined ? { batchSize: deps.batchSize } : {}),
    }))
    .register(TRANSITION_KIND, async (_job, ctx) => {
      await runTransitions(deps, ctx.signal)
    })
    .register(EXECUTE_KIND, async (job: Job) => {
      const proposalId = typeof job.payload['proposalId'] === 'string' ? job.payload['proposalId'] : null
      if (proposalId === null) {
        // A malformed payload is not retryable. Logged and dropped by completing, rather than
        // failed — a job that can never succeed occupying the dead-letter queue tells an operator
        // nothing they can act on.
        deps.logger.error('execute job has no proposalId', { jobId: job.id })
        return
      }
      await runExecution(deps, proposalId)
    })
    .register(RECHECK_KIND, async (_job, ctx) => {
      await runRechecks(deps, ctx.signal)
    })
    .register(RETENTION_KIND, async () => {
      const reaped = await reapIdempotencyKeys(deps.sql, deps.idempotencyTtlDays)
      if (reaped > 0) deps.logger.info('idempotency keys reaped', { reaped })
    })
}

/* ------------------------------------------------------------------ transitions */

/**
 * Move every proposal whose window has passed, and enqueue an execution for each that passed.
 *
 * The tally is computed here and the outcome is recorded as a status change — `passed` for a
 * proposal that will still wait out its timelock, `rejected` for one that will not. The tally
 * itself is not stored: it is recomputable from the `votes` rows at any time, and a stored copy is
 * a second number that can disagree with the first.
 */
export async function runTransitions(deps: JobDeps, signal?: AbortSignal): Promise<void> {
  const limit = deps.batchSize ?? 50

  for (const id of await proposalsDueToOpen(deps.sql, limit)) {
    if (signal?.aborted) return
    await deps.sql.begin(async (tx) => {
      const moved = await transition(tx as Tx, id, 'discussion', 'voting')
      if (moved.status === 'moved') {
        await emitOn(tx as Tx, deps.producer, {
          topic: TOPICS.proposalOpened,
          key: id,
          actor: 'service:community',
          payload: { proposalId: id, communityId: moved.proposal.communityId },
        })
      }
      return { done: true }
    })
  }

  for (const id of await proposalsDueToClose(deps.sql, limit)) {
    if (signal?.aborted) return
    await closeAndCount(deps, id)
  }

  // A proposal already in `timelocked` whose delay has expired but whose execute job was lost —
  // a replica killed between the transition commit and the enqueue, which is a real window because
  // the enqueue is not in the transaction. Re-enqueueing is safe: `onConflict: 'keep'` and the
  // (kind, key) unique constraint mean N attempts produce one row.
  for (const id of await proposalsDueToExecute(deps.sql, limit)) {
    if (signal?.aborted) return
    await deps.queue.enqueue({
      kind: EXECUTE_KIND,
      key: executeKey(id),
      onConflict: 'keep',
      payload: { proposalId: id },
    })
  }
}

/**
 * Close one proposal, count it, and move it to `passed` (then `timelocked`) or `rejected`.
 *
 * `passed → timelocked` in the same transaction rather than as a second scheduled step, because
 * the two are one decision: the timelock's duration was fixed when the proposal was created, and a
 * proposal sitting in `passed` waiting for a job to notice it would be a proposal whose delay
 * started at an unpredictable moment.
 */
export async function closeAndCount(deps: JobDeps, proposalId: string): Promise<void> {
  const outcome = await deps.sql.begin(async (tx) => {
    const claimed = await transition(tx as Tx, proposalId, 'voting', 'passed')
    if (claimed.status !== 'moved') return { value: null }

    const proposal = claimed.proposal
    const weights = await weightsFor(tx as Tx, proposalId)
    const result = tally(weights, { quorum: proposal.quorum, thresholdBps: proposal.thresholdBps })

    // Claimed into `passed` above so exactly one worker gets here; the real outcome is applied now.
    const finalStatus = result.outcome === 'passed' ? 'timelocked' : 'rejected'
    await transition(tx as Tx, proposalId, 'passed', finalStatus)

    await emitOn(tx as Tx, deps.producer, {
      topic: TOPICS.proposalClosed,
      key: proposalId,
      actor: 'service:community',
      payload: {
        proposalId,
        communityId: proposal.communityId,
        outcome: result.outcome,
        ...(result.outcome === 'rejected' ? { reason: rejectionReason(result) } : {}),
        // Decimal strings. Every one of these is a bigint on this side.
        forWeight: result.forWeight.toString(),
        againstWeight: result.againstWeight.toString(),
        abstainWeight: result.abstainWeight.toString(),
        quorum: proposal.quorum.toString(),
        thresholdBps: proposal.thresholdBps,
        ...(finalStatus === 'timelocked' ? { timelockUntil: proposal.timelockUntil.toISOString() } : {}),
      },
    })

    return { value: finalStatus === 'timelocked' ? proposalId : null }
  })

  deps.metrics.increment('community_proposals_closed_total', {
    outcome: outcome.value === null ? 'rejected' : 'passed',
  })

  if (outcome.value !== null) {
    // Enqueued AFTER the commit, deliberately: an enqueue inside the transaction would be rolled
    // back with it, and the `proposalsDueToExecute` sweep above is what covers the opposite window.
    await deps.queue.enqueue({
      kind: EXECUTE_KIND,
      key: executeKey(outcome.value),
      onConflict: 'keep',
      payload: { proposalId: outcome.value },
    })
  }
}

/* ------------------------------------------------------------------ execution */

/**
 * Execute one proposal.
 *
 * Every error here is deliberately re-thrown or swallowed on purpose, and which is which matters:
 *
 *   `TimelockError`           The database refused. Swallowed and logged — the job is complete,
 *                             because retrying now would fail identically and the transition sweep
 *                             will re-enqueue when the clock catches up.
 *   `SpendRefusedError`       Policy said no. Swallowed: a refusal is an answer, and retrying it
 *                             until the job dead-letters would turn one decision into eight.
 *   `PolicyUnavailableError`  We do not KNOW. Re-thrown, so the job fails and is retried with
 *                             backoff. This is the fail-closed branch: the treasury is not spent
 *                             while the gate is unreachable.
 *   anything else             Re-thrown. An unknown failure must not be recorded as a completed
 *                             execution.
 */
export async function runExecution(deps: JobDeps, proposalId: string): Promise<void> {
  try {
    const outcome = await executeProposal(
      { sql: deps.sql, ledger: deps.execute.ledger, policy: deps.execute.policy, producer: deps.producer },
      (tx, event) => emitOn(tx, deps.producer, event),
      { proposalId, executedBy: 'service:community', correlationId: `execute:${proposalId}` },
    )
    if (outcome.status === 'executed') {
      deps.metrics.increment('community_executions_total', { outcome: 'executed' })
      deps.logger.info('proposal executed', {
        proposalId,
        executionId: outcome.execution.id,
        ledgerEntryId: outcome.execution.ledgerEntryId,
      })
    } else {
      deps.metrics.increment('community_executions_total', { outcome: outcome.status })
    }
  } catch (err) {
    if (err instanceof TimelockError) {
      deps.metrics.increment('community_executions_total', { outcome: 'timelocked' })
      deps.logger.warn('execution refused by the timelock', { proposalId, err })
      return
    }
    if (err instanceof SpendRefusedError) {
      deps.metrics.increment('community_executions_total', { outcome: 'refused' })
      deps.logger.warn('treasury spend refused by policy', { proposalId, reasons: err.reasons })
      return
    }
    if (err instanceof PolicyUnavailableError) {
      deps.metrics.increment('community_executions_total', { outcome: 'gate_unavailable' })
      deps.logger.error('the treasury spend gate is unavailable; not executing', { proposalId, err })
    }
    throw err
  }
}

/* ------------------------------------------------------------------ token gating */

export async function runRechecks(deps: JobDeps, signal?: AbortSignal): Promise<void> {
  const due = await membersDueForRecheck(
    deps.sql,
    deps.gate.intervalHours,
    deps.gate.batchSize ?? 100,
  )
  for (const member of due) {
    if (signal?.aborted) return
    const community = await findCommunity(deps.sql, member.communityId)
    if (!community) continue
    const check = await deps.sql.begin(async (tx) => {
      const pending: Parameters<Emit>[0][] = []
      const result = await recheckMember(
        tx as Tx,
        (event) => pending.push(event),
        deps.oracle,
        community,
        member.subject,
        member.graceUntil,
      )
      for (const event of pending) await emitOn(tx as Tx, deps.producer, event)
      return { value: result }
    })
    deps.metrics.increment('community_gate_checks_total', { outcome: check.value.outcome })
    if (check.value.demoted) {
      deps.logger.info('member demoted for a token holding below the minimum', {
        communityId: community.id,
        subject: member.subject,
      })
    }
  }
}

/* ------------------------------------------------------------------ gauges */

/** Sampled at scrape time rather than on a timer. There is no `setInterval` in this repository. */
export async function sampleQueue(sql: Db, metrics: Metrics): Promise<void> {
  const rows = await sql<{ pending: number; dead: number }[]>`
    select count(*) filter (where dead = false)::int as pending,
           count(*) filter (where dead = true)::int  as dead
      from jobs
  `
  metrics.set('community_jobs_pending', rows[0]?.pending ?? 0)
  metrics.set('community_jobs_dead', rows[0]?.dead ?? 0)
}

export async function sampleGovernance(sql: Db, metrics: Metrics): Promise<void> {
  const rows = await sql<{ voting: number; timelocked: number }[]>`
    select count(*) filter (where status = 'voting')::int     as voting,
           count(*) filter (where status = 'timelocked')::int as timelocked
      from proposals
  `
  metrics.set('community_proposals_voting', rows[0]?.voting ?? 0)
  // A climbing `timelocked` gauge is the signal that executions have stopped — a policy outage, a
  // ledger outage, or a dead execute job. It is the one number worth an alert.
  metrics.set('community_proposals_timelocked', rows[0]?.timelocked ?? 0)
}

export { findProposal }
