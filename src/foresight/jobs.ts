/**
 * Every piece of background work this service does, and the key each one is leased on.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE LEASE KEY NAMES THE CONTENDED RESOURCE, NOT THE ROW.** `@cloudsforge/jobs`'s own header
 * says it and it is the thing most likely to be got wrong by someone adding a job here.
 *
 *   | Work              | Key                        | Why                                       |
 *   |-------------------|----------------------------|-------------------------------------------|
 *   | idea.propose      | global                     | One pipeline run per period. Two would    |
 *   |                   |                            | double the operator's queue and double    |
 *   |                   |                            | the model bill.                           |
 *   | market.deploy     | market id                  | Genuinely parallel: every market has its  |
 *   |                   |                            | OWN custody deployer address, so no two   |
 *   |                   |                            | deploys share a nonce. The row IS the     |
 *   |                   |                            | resource.                                 |
 *   | resolution.post   | oracle:chain:network       | **The opposite case.** Every market on a  |
 *   |                   |                            | chain resolves through ONE oracle address,|
 *   |                   |                            | so the contended resource is that         |
 *   |                   |                            | address's nonce. Keying on the market     |
 *   |                   |                            | would let two resolutions sign against one|
 *   |                   |                            | nonce and lose one of them permanently.   |
 *   | market.close      | global                     | A scan, not a row. Two scanners would do  |
 *   |                   |                            | the same work twice for nothing.          |
 *   | mirror.sync       | market id                  | Parallel; one market's chain reads do not |
 *   |                   |                            | contend with another's.                   |
 *   | fee.report        | global                     | One posting pass; the ledger's own key    |
 *   |                   |                            | makes a duplicate a replay, but a second  |
 *   |                   |                            | worker is still wasted round trips.       |
 *   | outbox.relay      | global                     | Two relays deliver every event twice.     |
 *   | deploy.sweep      | global                     | A scan. Two scanners enqueue the same set |
 *   |                   |                            | twice for nothing.                        |
 *   | mirror.sweep      | global                     | The same, for the mirror.                 |
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **There is no `setInterval` in this repository.** Recurrence is a job that re-enqueues itself
 * with a future `runAt`, which is the only form that is correct with two replicas: a timer is a
 * variable in one process and is by construction invisible to the other.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## AND A HANDLER MUST NOT RE-ENQUEUE ITSELF. IT DID, AND IT COST THIS SERVICE EVERY TIMER IT HAS.
 *
 * Until this change every recurring handler in this file ended with an enqueue of its own
 * `(kind, key)` — `ideaProposeHandler`'s `finally`, `marketCloseHandler`'s tail, `mirrorSyncHandler`,
 * `resolutionPostHandler`, and `marketDeployHandler`'s fast path. The header above even described
 * that as the design. **All five were undone a moment later by the runner**, and the mechanism is
 * three lines of `@cloudsforge/jobs`:
 *
 *   * `JobQueue.enqueue` is `insert … on conflict (kind, key) do nothing` (`jobs/src/index.ts`).
 *     The row it conflicts with is the handler's OWN row, which is still there, claimed and locked.
 *     So the self-enqueue never inserts anything — it updates, or ignores, the row already present.
 *   * `JobRunner.#run` then calls `queue.complete(job.id)` (`jobs/src/index.ts`), and `complete`
 *     is `delete from jobs where id = $1`.
 *   * The row the reschedule "created" and the row the delete removes **are the same row**.
 *
 * Net effect: every background thing this service does ran exactly once per boot and then never
 * again, silently, because an empty `jobs` table looks like a service with nothing to do. Observed
 * in the live estate: foresight's `jobs` table held **0 rows 47 minutes after start** while nine
 * other services held live ones, and its `outbox` showed the signature — each event's `published_at`
 * equals the timestamp of the NEXT CONTAINER BOOT, because `outbox.relay` only ever ran at boot.
 *
 * A test that asserts "the handler enqueued a follow-up" passes against that broken code, because
 * the enqueue does happen. **The delete afterwards is the defect**, so the only test that can see it
 * is one that drives a real `JobRunner` through a whole claim → run → complete cycle and then looks
 * for the row. That is `jobs.test.ts`'s `THE PROPERTY: a recurring row SURVIVES its own completion`.
 *
 * `ledger/src/jobs.ts` names this trap and gives the fix, and it is the one used here rather
 * than a third pattern: a recurring job is **a boot seed plus a re-arm driven by the runner's
 * `completed` event**, which is the only point at which the row is provably gone. `recurringJobs`
 * below is the table, `seedRecurring` is the seed, `rescheduleRecurring` is the re-arm.
 *
 * ## THE TWO KINDS WHOSE KEY IS NOT KNOWN AT BOOT
 *
 * `market.deploy` and `mirror.sync` are keyed on a market id, so they cannot appear in a fixed
 * table — the key set changes every time an operator approves a market. They are driven instead by
 * `deploy.sweep` and `mirror.sweep`, which ARE recurring, scan the database and enqueue one job per
 * outstanding row. That is the same shape `micro-mint`'s `chain.sweep` has, and `deploySweepHandler`
 * was already written and tested here for exactly this purpose — **and never registered**, which is
 * why a broadcast deploy had no reconciler of any kind once its self-enqueue was eaten.
 */

import { JobQueue, type Handler, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import type { Network } from '@cloudsforge/contracts-chain'
import { CATEGORY_VERSION } from './categories.ts'
import {
  markPaid,
  markRefunded,
  marketsAwaitingCustodialSettlement,
  poolPayoutPostings,
  refundPostings,
  splitPayouts,
  stakeIdempotencyKey,
  unresolvedStakes,
  type CustodialStake,
} from './custodialstakes.ts'
import { chainKey, type ChainId } from './chains.ts'
import { driveDeploy, listOutstandingDeploys, type DeployDeps } from './deploy.ts'
import { insertIdea, IdeaError } from './ideas.ts'
import {
  feeIdempotencyKey,
  feePostings,
  FEE_ENTRY_KIND,
  LedgerUnavailableError,
  type LedgerClient,
} from './ledgerclient.ts'
import { closeMarket, listDueToClose, markResolved, markSettled, voidMarket } from './markets.ts'
import { listMirrorable, recordSyncError, syncMarket, type MirrorDeps } from './mirror.ts'
import { withOutbox, type Db } from './outbox.ts'
import type { Proposer } from './proposer.ts'
import {
  ACTION_VOID,
  driveResolution,
  listOutstandingResolutions,
  resolutionLeaseKey,
  type ResolveDeps,
} from './resolve.ts'

export const IDEA_PROPOSE = 'idea.propose'
export const MARKET_DEPLOY = 'market.deploy'
export const MARKET_CLOSE = 'market.close'
export const MIRROR_SYNC = 'mirror.sync'
export const RESOLUTION_POST = 'resolution.post'
export const FEE_REPORT = 'fee.report'
export const OUTBOX_RELAY = 'outbox.relay'
export const DEPLOY_SWEEP = 'deploy.sweep'
export const MIRROR_SWEEP = 'mirror.sweep'
export const CUSTODIAL_SETTLE = 'custodial.settle'

export const JOB_KINDS: readonly string[] = Object.freeze([
  IDEA_PROPOSE,
  MARKET_DEPLOY,
  MARKET_CLOSE,
  MIRROR_SYNC,
  RESOLUTION_POST,
  FEE_REPORT,
  OUTBOX_RELAY,
  DEPLOY_SWEEP,
  MIRROR_SWEEP,
  CUSTODIAL_SETTLE,
])

const SECOND = 1_000
const MINUTE = 60 * SECOND

/** The topics the idea pipeline searches. Configuration would be nicer; a constant is honest. */
export const PROPOSAL_TOPICS: readonly string[] = Object.freeze([
  'blockchain protocol upgrades and network milestones scheduled in the coming months',
  'publicly scheduled software and hardware releases with announced dates',
  'published cryptocurrency and commodity price levels from named exchanges',
])

export interface JobDeps {
  readonly sql: Db
  readonly queue: JobQueue
  readonly producer: string
  readonly network: Network
  readonly chain: ChainId
  readonly logger: Logger
  readonly metrics: Metrics
  readonly proposer: Proposer
  readonly proposalBatchSize: number
  readonly proposeEveryMinutes: number
  readonly deploy: DeployDeps
  readonly resolve: ResolveDeps
  readonly mirror: MirrorDeps
  readonly ledger: LedgerClient
  readonly now?: () => Date
}

/* ------------------------------------------------------------------ the idea pipeline */

/**
 * Search, ask a model, store what comes back as PROPOSALS.
 *
 * **Recurrence is not this handler's business.** It used to end in a `finally` that enqueued the
 * next run, and that enqueue was deleted by `complete()` the instant the handler returned — see the
 * file header. The next run is armed by `rescheduleRecurring` off the runner's `completed` event.
 *
 * That relocation preserves the reason the old enqueue was in a `finally`, and it is worth saying
 * why: a run that THROWS must not stop the schedule. It does not. A failure is retried with backoff
 * by the runner itself, and only a job that exhausts its whole attempt budget stops recurring — at
 * which point the dead row and `jobs_dead_total` are how an operator finds out, which is louder than
 * a silent reschedule ever was.
 *
 * An unconfigured proposer is a normal outcome: the run records "not configured" and completes. It
 * does not throw, so nothing backs off into a dead letter and nothing logs an error every six hours
 * for a thing nobody has set up.
 */
export function ideaProposeHandler(deps: JobDeps): Handler {
  return async (job) => {
    const now = (deps.now ?? (() => new Date()))()
    if (!deps.proposer.configured) {
      deps.logger.info('idea pipeline: no proposer is configured, so there are no proposals', {
        jobKey: job.key,
      })
      deps.metrics.increment('foresight_idea_runs_total', { outcome: 'not_configured' })
      return
    }

    let stored = 0
    let dropped = 0
    for (const topic of PROPOSAL_TOPICS) {
      const run = await deps.proposer.propose({
        topic,
        count: deps.proposalBatchSize,
        now,
      })
      deps.metrics.increment('foresight_idea_runs_total', { outcome: run.reason })
      for (const proposal of run.proposals) {
        try {
          await insertIdea(deps.sql, { ...proposal, categoryVersion: CATEGORY_VERSION }, now)
          stored += 1
        } catch (err) {
          // A proposal that fails validation is DROPPED and counted, never repaired. Filling in a
          // missing resolution source with a plausible default is how a market ends up settling
          // from somewhere nobody named.
          if (err instanceof IdeaError) {
            dropped += 1
            deps.metrics.increment('foresight_proposals_dropped_total', { reason: err.code })
            continue
          }
          throw err
        }
      }
    }
    deps.logger.info('idea pipeline ran', { stored, dropped })
    deps.metrics.increment('foresight_proposals_stored_total', {}, stored)
  }
}

/* ------------------------------------------------------------------ deploy */

/**
 * Advance one market's deploy by one step.
 *
 * **It does not re-enqueue itself for the next step**, and the deletion of the four lines that did
 * is the point of this change rather than an omission. `market.deploy` is keyed on a market id, so
 * the runner's `completed` re-arm cannot reach it — the key is not known at boot. `deploy.sweep`
 * below is what brings it back, unconditionally, off the database rather than off a memory of
 * having asked.
 *
 * The `deployed` enqueue STAYS, because it is a different `(kind, key)`: `mirror.sync` for this
 * market, which the row being deleted a moment later cannot touch. That is the distinction the old
 * code missed — an enqueue of somebody else's key survives `complete()`; an enqueue of your own does
 * not.
 */
export function marketDeployHandler(deps: JobDeps): Handler {
  return async (job, ctx) => {
    const marketId = typeof job.payload['marketId'] === 'string' ? job.payload['marketId'] : job.key
    const result = await driveDeploy(deps.deploy, marketId)
    await ctx.heartbeat()
    if (result === 'deployed') {
      // The mirror starts following the moment there is something to follow.
      await deps.queue.enqueue({ kind: MIRROR_SYNC, key: marketId, payload: { marketId } })
    }
  }
}

/**
 * The sweep: walk every outstanding deploy.
 *
 * `micro-mint`'s `chain.sweep`, and the defect it names is worth restating — the frozen service had
 * no reconciler at all, so a customer who closed the tab left a broadcast deploy in `deploying` for
 * ever. Here nothing depends on a request ever coming back.
 *
 * **This handler existed, was tested, and was never registered.** `registerHandlers` below did not
 * mention it, so the safety net the comment above promised was not in the process at all — which is
 * why the annihilated self-enqueue in `marketDeployHandler` had nothing beneath it and an approved
 * market could sit in `pending` until somebody restarted the container. It is registered now, and
 * `jobs.test.ts` asserts that every handler in `JOB_KINDS` is.
 */
export function deploySweepHandler(deps: JobDeps): Handler {
  return async () => {
    const outstanding = await listOutstandingDeploys(deps.sql, 50)
    for (const market of outstanding) {
      await deps.queue.enqueue({
        kind: MARKET_DEPLOY,
        key: market.id,
        payload: { marketId: market.id },
        onConflict: 'earliest',
      })
    }
  }
}

/* ------------------------------------------------------------------ close */

/**
 * Close every market whose time is up.
 *
 * **Bookkeeping only.** The CONTRACT stops taking stakes at `closeTime` by itself; if this job
 * never ran, not one extra wei could be staked. What it buys is that the operator queue and the
 * public page agree with the chain, and that the resolution queue has something to work from.
 */
export function marketCloseHandler(deps: JobDeps): Handler {
  return async () => {
    const now = (deps.now ?? (() => new Date()))()
    const due = await listDueToClose(deps.sql, now, 100)
    for (const market of due) {
      await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
        await closeMarket(tx, emit, market.id, `service:${deps.producer}`, now, null)
      })
      deps.metrics.increment('foresight_markets_closed_total')
    }
    // One scan per minute. The interval lives in `recurringJobs`, not here: a scan that scheduled
    // its own next run scheduled a row the runner deleted a moment later.
  }
}

/* ------------------------------------------------------------------ mirror */

/**
 * Follow one market's chain activity.
 *
 * Keyed on the market, so — like `market.deploy` — the runner's `completed` re-arm cannot reach it
 * and its old self-enqueue was eaten by `complete()`. `mirror.sweep` below re-enqueues it from the
 * set of markets that have something to follow.
 */
export function mirrorSyncHandler(deps: JobDeps): Handler {
  return async (job) => {
    const marketId = typeof job.payload['marketId'] === 'string' ? job.payload['marketId'] : job.key
    try {
      const result = await syncMarket(deps.mirror, marketId)
      deps.logger.debug('mirror synced', { marketId, ...result })
    } catch (err) {
      // Recorded on the cursor and swallowed. A mirror that cannot reach the indexer is a DEGRADED
      // read, and the page says "as of" rather than showing a smaller pool — throwing here would
      // dead-letter the job and stop the market ever syncing again.
      const message = err instanceof Error ? err.message : String(err)
      await recordSyncError(deps.sql, marketId, message)
      deps.metrics.increment('foresight_mirror_errors_total')
      deps.logger.warn('mirror sync failed', { marketId, err: message })
    }
  }
}

/**
 * The mirror's sweep: every market with a contract and an unfinished life gets a sync.
 *
 * Written for this change, because there was no equivalent of `deploySweepHandler` here at all —
 * `mirror.sync` was seeded only by a deploy reaching `deployed`, and then kept alive purely by the
 * self-enqueue the runner deleted. So the mirror followed each market for exactly one pass and then
 * stopped, and the public pool on the page froze at whatever it had read in that one pass.
 */
export function mirrorSweepHandler(deps: JobDeps): Handler {
  return async () => {
    for (const marketId of await listMirrorable(deps.sql, 200)) {
      await deps.queue.enqueue({
        kind: MIRROR_SYNC,
        key: marketId,
        payload: { marketId },
        onConflict: 'earliest',
      })
    }
  }
}

/* ------------------------------------------------------------------ resolution */

/**
 * Post outstanding resolutions on one chain, one at a time.
 *
 * The key is the CHAIN, so this handler is the only thing on a replica touching that oracle's
 * nonce. Resolutions are driven serially inside it for the same reason: two in flight at once would
 * need two nonces read before either was mined.
 */
export function resolutionPostHandler(deps: JobDeps): Handler {
  return async (_job, ctx) => {
    const outstanding = await listOutstandingResolutions(deps.sql, 20)
    for (const resolution of outstanding) {
      const result = await driveResolution(deps.resolve, resolution.id)
      await ctx.heartbeat()
      if (result === 'confirmed') {
        await applyConfirmedResolution(deps, resolution.marketId, resolution.action, resolution.rationale)
      }
      // One at a time: the next resolution needs a nonce that only exists once this one is mined.
      if (result === 'broadcast' || result === 'pending') break
    }
    // No self-enqueue. This kind IS in `recurringJobs` — its key is `oracle:<chain>:<network>`,
    // which is known at boot — so `rescheduleRecurring` re-arms it every 15 seconds whether or not
    // this pass found anything. Unconditional is the correction as much as the relocation is: the
    // old `if (outstanding.length > 0)` meant that once the queue emptied, nothing would ever look
    // again, so a market closed after that moment could never be resolved.
  }
}

/**
 * Write down what the chain has already accepted.
 *
 * **After, never before.** The outcome exists on chain by the time this runs — `driveResolution`
 * returned `confirmed`, which means a receipt with status 1. Writing the row first would make the
 * database the source of truth for an outcome the contract pays against, which is the inversion
 * §2.3.1 forbids.
 */
export async function applyConfirmedResolution(
  deps: JobDeps,
  marketId: string,
  action: number,
  rationale: string,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))()
  const actor = `service:${deps.producer}`
  await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    if (action === ACTION_VOID) {
      await voidMarket(tx, emit, marketId, rationale, actor, now, null)
      deps.metrics.increment('foresight_markets_voided_total')
      return
    }
    await markResolved(tx, emit, marketId, action, actor, now, null)
    deps.metrics.increment('foresight_markets_resolved_total')
  })
}

/* ------------------------------------------------------------------ fees */

/**
 * Report indexed settlement fees to the ledger.
 *
 * The row exists because a `FeePaid` log was indexed. This posts it and marks the market settled —
 * bookkeeping that mirrors a transfer which has already happened on a public chain and which
 * nothing here authorised.
 */
export function feeReportHandler(deps: JobDeps): Handler {
  return async () => {
    const pending = await deps.sql<
      { id: string; market_id: string; amount_wei: string; tx_hash: string }[]
    >`
      select id, market_id, amount_wei, tx_hash from fee_reports
       where reported_at is null order by created_at limit 25
    `
    for (const row of pending) {
      try {
        const entry = await deps.ledger.postEntry({
          // 'fee_charged', from the ledger's CLOSED kind vocabulary (journal_entries_kind_chk,
          // ledger/src/migrations.ts). The original 'foresight.settlement_fee' was not in the
          // list and every report died at the constraint — see feePostings' header in
          // ledgerclient.ts for the full finding.
          kind: FEE_ENTRY_KIND,
          actor: `service:${deps.producer}`,
          correlationId: row.market_id,
          idempotencyKey: feeIdempotencyKey(row.market_id),
          description: `settlement fee taken on chain by market ${row.market_id} (${row.tx_hash})`,
          postings: feePostings({ amountWei: BigInt(row.amount_wei), chain: deps.chain }),
        })
        await deps.sql`
          update fee_reports set reported_at = now(), ledger_entry_id = ${entry.id} where id = ${row.id}
        `
        const now = (deps.now ?? (() => new Date()))()
        await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
          await markSettled(tx, emit, row.market_id, `service:${deps.producer}`, now, null)
        }).catch(() => {
          // The market may already be settled or void. The fee report is what this job is for and
          // it succeeded; a status that has moved on is not a reason to repost the entry.
        })
      } catch (err) {
        if (err instanceof LedgerUnavailableError) {
          // Left unreported, deliberately. The idempotency key makes the retry a replay, so the
          // only cost of waiting is a delay in a report — and the money moved on chain regardless.
          deps.logger.warn('fee report deferred: the ledger was unavailable', {
            marketId: row.market_id,
            err: err.message,
          })
          return
        }
        throw err
      }
    }
  }
}

/* ------------------------------------------------------------------ custodial settlement */

/**
 * Pay out — or give back — every custodial stake on a market that is over.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE EXIT. BEFORE IT EXISTED, MONEY COULD GET INTO ESCROW AND NEVER GET OUT.**
 *
 * The route above takes a custodial stake by posting `market_escrow`: the user's asset leaves their
 * available balance and an EMBER position lands in their ESCROW balance. Escrow is not spendable.
 * Something has to spend it, and until this handler there was nothing that could:
 *
 *   - `markSettled` accepts only a stake in state `'staked'`;
 *   - `'staked'` requires a transaction hash (`custodial_stakes_staked_has_evidence`);
 *   - the hash can only come from custody signing `stake(uint8)` on the market contract;
 *   - custody will not. `SIGNABLE_PURPOSES` in `custody/src/gates.ts` binds every signable purpose
 *     to a creation, a bare transfer or a sweep, and `stake(uint8)` is a value-bearing CALL with
 *     calldata. `custodyclient.ts` in this service states the refusal and declines to overturn it.
 *
 * So the only reachable terminal state was `refunded`, and nothing scheduled that either. A user
 * who staked was simply short the money, indefinitely, with a row in `accepted` recording it.
 *
 * ── WHAT IS PAID, AND OUT OF WHOSE MONEY ──────────────────────────────────────────────────────
 *
 * The custodial stakes on a market form **their own parimutuel pool**, held by the platform and
 * settled here against the outcome the CHAIN resolved. It is self-funded by construction: the only
 * money paid out is money that was staked into it, so the platform is never the counterparty and
 * cannot owe what it does not hold. `splitPayouts` does the division and documents its three edges.
 *
 * It is **not** the contract's pool and is never added to it — `custodialPoolOf` says why at
 * length. The odds a custodial staker faces are the custodial pool's odds.
 *
 * ── ORDER, AND WHAT A CRASH COSTS ─────────────────────────────────────────────────────────────
 *
 * Per stake: post the entry, then mark the row. A crash between them leaves an `accepted` row whose
 * money HAS moved, and the next pass would pay it twice — except that the entry carries
 * `stakeIdempotencyKey(id, 'payout' | 'refund')`, so the second post is a replay that returns the
 * first entry's id and the row is marked from that. The key is derived from the stake id and
 * nothing else, which is what makes the retry safe rather than merely likely to be.
 *
 * The reverse order — mark then post — would strand the opposite way: a row saying paid with no
 * entry behind it, which is a user told they were paid money that never left escrow.
 *
 * A `LedgerUnavailableError` stops this market's pass and leaves the rest for the next run, exactly
 * as the fee report does. It does NOT throw, because a ledger that is down for a minute must not
 * spend this job's attempt budget and dead-letter the only thing that can release escrow.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function custodialSettleHandler(deps: JobDeps): Handler {
  return async (_job, ctx) => {
    const now = (deps.now ?? (() => new Date()))()
    const due = await marketsAwaitingCustodialSettlement(deps.sql, 20)
    for (const market of due) {
      const stakes = await unresolvedStakes(deps.sql, market.marketId)
      if (stakes.length === 0) continue

      // A void, and a resolution nobody won, are the same act: give everybody back exactly what
      // they brought, in the asset they brought it in. `splitPayouts` returns an empty list for the
      // second case precisely so that it cannot be mistaken for "pay everyone zero".
      const winners = market.status === 'void' ? [] : splitPayouts(stakes, market.outcome ?? -1)
      const refundAll = winners.length === 0

      try {
        if (refundAll) {
          for (const stake of stakes) await refundOne(deps, stake, market.marketId, now)
          deps.metrics.increment('foresight_custodial_settlements_total', {
            outcome: market.status === 'void' ? 'void_refund' : 'no_winner_refund',
          })
          continue
        }
        const payouts = new Map(winners.map((payout) => [payout.stakeId, payout.payout]))
        for (const stake of stakes) await payOne(deps, stake, payouts.get(stake.id) ?? 0n, market.marketId, now)
        deps.metrics.increment('foresight_custodial_settlements_total', { outcome: 'paid' })
      } catch (err) {
        if (err instanceof LedgerUnavailableError) {
          deps.logger.warn('custodial settlement deferred: the ledger was unavailable', {
            marketId: market.marketId,
            err: err.message,
          })
          return
        }
        throw err
      }
      await ctx.heartbeat()
    }
  }
}

/** Give one stake back whole, in the asset it arrived in. The exact reversal of the escrow entry. */
async function refundOne(deps: JobDeps, stake: CustodialStake, marketId: string, now: Date): Promise<void> {
  const entry = await deps.ledger.postEntry({
    // ────────────────────────────────────────────────────────────────────────────────────────
    // `market_settled`, NOT `reversal`, and the temptation is real: `refundPostings` is literally
    // `escrowPostings` with every direction flipped, which is what a reversal is.
    //
    // Two reasons it must not be. The ledger's `reversal` kind is defined by `reversesEntryId` —
    // `ledger/src/entries.ts` reverses an entry BY ID and sets that column — and a hand-built
    // `reversal` posted through `POST /entries` would carry the name with the column null: a
    // reversal in every report that reverses nothing anybody can point at.
    //
    // And the id may not exist. The stake route writes the row and then posts the escrow entry, so
    // a crash between them leaves `accepted` with `escrow_entry_id` null. That stake still has to
    // be refundable. A refund that depended on the entry it reverses would be exactly unavailable
    // in the case the ordering was chosen to make recoverable.
    //
    // `market_refund` is not an option at all: the vocabulary is closed
    // (`contracts/packages/money/src/index.ts` `ENTRY_KINDS`) and there is no such kind. Inventing
    // one is the defect that stopped every `item_issue` posting for a month.
    // ────────────────────────────────────────────────────────────────────────────────────────
    kind: 'market_settled',
    actor: `service:${deps.producer}`,
    correlationId: marketId,
    idempotencyKey: stakeIdempotencyKey(stake.id, 'refund'),
    description: `Foresight refund on market ${marketId}`.slice(0, 200),
    postings: refundPostings(stake),
  })
  await markRefunded(deps.sql, stake.id, entry.id, now)
}

/**
 * Settle one stake out of the platform pool: escrow is spent, and a winner's share arrives.
 *
 * A payout of zero is still an entry, and still marks the row `paid`. That is not bookkeeping
 * pedantry — the escrowed EMBER has to LEAVE the loser's escrow balance, or their available balance
 * stays short for ever and the pool it was paid out of never balances.
 */
async function payOne(
  deps: JobDeps,
  stake: CustodialStake,
  payout: bigint,
  marketId: string,
  now: Date,
): Promise<void> {
  const entry = await deps.ledger.postEntry({
    kind: 'market_settled',
    actor: `service:${deps.producer}`,
    correlationId: marketId,
    idempotencyKey: stakeIdempotencyKey(stake.id, 'payout'),
    description: `Foresight settlement on market ${marketId}`.slice(0, 200),
    postings: poolPayoutPostings(stake, payout),
  })
  await markPaid(deps.sql, stake.id, entry.id, now)
}

/* ------------------------------------------------------------------ registration */

/**
 * Everything a runner needs, in one place, so a job cannot exist without a documented key.
 *
 * **A kind in `JOB_KINDS` with no handler here is a kind nothing runs**, and that was not a
 * hypothetical: `deploySweepHandler` was written, documented as the thing that "catches a row
 * nothing re-enqueued", covered by a test, and absent from this function. `jobs.test.ts` now asserts
 * this list and `JOB_KINDS` are the same set, so the next omission is a red build rather than a
 * market stuck in `pending`.
 */
export function registerHandlers(
  deps: JobDeps,
  relay: Handler,
  register: (kind: string, handler: Handler) => void,
): void {
  register(IDEA_PROPOSE, ideaProposeHandler(deps))
  register(MARKET_DEPLOY, marketDeployHandler(deps))
  register(DEPLOY_SWEEP, deploySweepHandler(deps))
  register(MARKET_CLOSE, marketCloseHandler(deps))
  register(MIRROR_SYNC, mirrorSyncHandler(deps))
  register(MIRROR_SWEEP, mirrorSweepHandler(deps))
  register(RESOLUTION_POST, resolutionPostHandler(deps))
  register(FEE_REPORT, feeReportHandler(deps))
  register(CUSTODIAL_SETTLE, custodialSettleHandler(deps))
  register(OUTBOX_RELAY, relay)
}

/* ------------------------------------------------------------------ recurrence */

export interface RecurringJob {
  readonly kind: string
  readonly key: string
  readonly everyMs: number
}

/** The subset of `JobDeps` the schedule is computed from. Narrow so a test need not build a world. */
export type ScheduleDeps = Pick<JobDeps, 'chain' | 'network' | 'proposeEveryMinutes'>

/**
 * Every job that must exist whether or not anything enqueued it, and how often it repeats.
 *
 * A recurring job is **a producer plus a leased job, never a timer**: the boot seed below plus the
 * re-arm in `rescheduleRecurring`. So the interval survives a restart, is visible in a table an
 * operator can query, and is claimed by exactly one replica.
 *
 * The intervals are the ones the old self-enqueues asked for, kept deliberately identical so that
 * this change is a fix and not also a retuning:
 *
 *   | Kind             | Every | Where the number comes from                                      |
 *   |------------------|-------|------------------------------------------------------------------|
 *   | outbox.relay     | 1s    | ledger's relay cadence. Nothing else moves an event off this box. |
 *   | deploy.sweep     | 15s   | `marketDeployHandler`'s old 15s follow-up.                        |
 *   | resolution.post  | 15s   | `resolutionPostHandler`'s old 15s follow-up.                      |
 *   | mirror.sweep     | 30s   | `mirrorSyncHandler`'s old 30s follow-up.                          |
 *   | market.close     | 60s   | `marketCloseHandler`'s old 60s scan.                              |
 *   | fee.report       | 60s   | **NEW.** This one never had a follow-up at all — it was seeded at |
 *   |                  |       | boot and nothing rescheduled it even in intent, so a fee indexed  |
 *   |                  |       | after boot was never posted to the ledger until a restart.        |
 *   | idea.propose     | env   | `FORESIGHT_PROPOSE_EVERY_MINUTES`.                                |
 *
 * `deploy.sweep` at 15s is the fast path for a market mid-deploy, with one honest caveat:
 * `listOutstandingDeploys` skips a row whose market lease is still held, and `markSigned` holds that
 * lease for `leaseMs` (120s). So a market that has just been signed is re-driven when its lease
 * lapses rather than 15 seconds later. That is a bounded delay on a poll, not a lost deploy, and it
 * is the property that actually matters: **nothing can be stranded, because the scan is
 * unconditional and does not depend on any earlier run having enqueued anything.**
 */
export function recurringJobs(deps: ScheduleDeps): RecurringJob[] {
  return [
    { kind: OUTBOX_RELAY, key: 'global', everyMs: 1 * SECOND },
    { kind: DEPLOY_SWEEP, key: 'global', everyMs: 15 * SECOND },
    { kind: RESOLUTION_POST, key: resolutionLeaseKey(deps.chain, deps.network), everyMs: 15 * SECOND },
    { kind: MIRROR_SWEEP, key: 'global', everyMs: 30 * SECOND },
    { kind: MARKET_CLOSE, key: 'global', everyMs: 60 * SECOND },
    { kind: FEE_REPORT, key: 'global', everyMs: 60 * SECOND },
    { kind: CUSTODIAL_SETTLE, key: 'global', everyMs: 60 * SECOND },
    { kind: IDEA_PROPOSE, key: 'global', everyMs: deps.proposeEveryMinutes * MINUTE },
  ]
}

/**
 * The recurring jobs, enqueued at boot.
 *
 * `onConflict: 'keep'` throughout, so N replicas booting together produce one pending run of each
 * rather than N. The `(kind, key)` unique constraint in `JOBS_SCHEMA_SQL` is what makes that true.
 */
export async function seedRecurring(queue: JobQueue, deps: ScheduleDeps): Promise<void> {
  for (const job of recurringJobs(deps)) {
    await queue.enqueue({ kind: job.kind, key: job.key, onConflict: 'keep' })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * **It cannot re-arm itself from inside its own handler**, and this function exists because for the
 * whole life of this service it tried to. The runner deletes the row on success AFTER the handler
 * returns (`jobs/src/index.ts` →), and `enqueue` conflicts on `(kind, key)` against the
 * handler's own still-present row — so a self-enqueue was annihilated by the delete that followed
 * it and the schedule stopped dead at the first completion. The `completed` event is emitted after
 * `complete()` resolves, which is the only point at which the row is provably gone.
 *
 * A dead-lettered recurring job is deliberately **not** re-armed. The row stays, `jobs_dead_total`
 * increments and `jobs_overdue` climbs, which is how an operator finds out. Silently rescheduling a
 * job that has exhausted its attempt budget hides a permanent fault behind a busy loop.
 *
 * `earliest` rather than `keep`: if something else has already asked for this kind sooner — the
 * approve route enqueuing a deploy, say — the sooner time wins and the periodic re-arm never pushes
 * it out.
 */
export function rescheduleRecurring(
  queue: JobQueue,
  logger: Logger,
  deps: ScheduleDeps,
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
      .catch((err: unknown) =>
        logger.error('failed to re-arm a recurring job', { kind: recurring.kind, key: recurring.key, err }),
      )
  }
}

export { chainKey }
