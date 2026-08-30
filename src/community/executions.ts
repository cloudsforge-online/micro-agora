/**
 * Execution: where a vote becomes a ledger posting.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EXECUTED EXACTLY ONCE, AND THERE ARE FOUR INDEPENDENT REASONS IT IS.**
 *
 *   1. **The job lease.** `proposal.execute` is enqueued with `key = proposal:<id>`, so the
 *      contended resource named in the lease IS the proposal. Two replicas claim with
 *      `for update skip locked`; one takes the row and the other skips it. This is the design, and
 *      `jobs.test.ts` proves it with two runners and different owners.
 *   2. **`select … for update` on the proposal row.** Two callers that reached the executor
 *      anyway — a manual `POST /internal/…/execute` racing the job, say — serialise here. The
 *      loser re-reads the committed row, finds `status = 'executed'`, and answers "already"
 *      without calling the ledger at all. `for update`, NOT `skip locked`: skipping would let the
 *      second caller conclude "no such proposal" and carry on.
 *   3. **`executions_proposal_uniq`.** One execution row per proposal, enforced by Postgres. This
 *      is the one that survives a code change.
 *   4. **The ledger's own idempotency key**, `community:execute:<proposalId>`, DERIVED from the
 *      proposal. Even if two callers reached the ledger, the second is answered from the stored
 *      response and posts nothing.
 *
 * Four, because the cost of a double execution is a community's treasury spent twice — real money,
 * out of an account whose owner is a group of people who agreed to spend it once, and invisible
 * until somebody reads the journal.
 *
 * **THE ORDER INSIDE THE TRANSACTION IS THE OTHER HALF, AND IT IS NOT THE SAME AS MARKET'S.**
 *
 * `market/src/escrow.ts` calls the ledger first and then writes its row. This writes the execution
 * row FIRST and calls the ledger second, because the timelock is enforced by a BEFORE INSERT
 * trigger on that row. Calling the ledger first would mean an early execution attempt moves money
 * and *then* gets refused — leaving a posting with no execution behind it, which is the one state
 * neither system can explain. Inserting first means the database refuses before a single unit
 * moves.
 *
 * The cost of that ordering is a row that exists for a moment without naming its entry. That is
 * what `executions_spend_names_entry` is for: a DEFERRED constraint trigger, checked at COMMIT, so
 * a treasury spend cannot become durable without its ledger entry id. The same mechanism
 * `ledger/src/migrations.ts` uses for the balancing invariant, chosen for the same reason —
 * the fact is only true once the transaction has finished writing.
 *
 * **THE LEDGER CALL HAPPENS INSIDE THE DATABASE TRANSACTION**, which holds a Postgres transaction
 * open across a network call. Deliberate, and the same cost `market/src/escrow.ts` takes: the
 * alternative is a window in which the row says executed and no posting exists, or a posting
 * exists and no row says so. The upstream deadline bounds how long the transaction is held.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Actor, AccountSubject, LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { Db, Emit, Tx } from './outbox.ts'
import { TOPICS } from './events.ts'
import { ConflictError, NotFoundError, findCommunity, findTreasuryAccount } from './communities.ts'
import { lockProposal, markExecuted, type Proposal } from './proposals.ts'
import { idempotencyKeys, spendPostings, type LedgerClient } from './ledgerclient.ts'
import type { PolicyClient } from './policyclient.ts'
import { isPgError } from './delegations.ts'

/** The actor this service posts as. A service, never a user: no member signs the entry. */
export const EXECUTOR_ACTOR: Actor = 'service:community'

export interface Execution {
  readonly id: string
  readonly proposalId: string
  readonly kind: string
  readonly executedBy: string
  readonly idempotencyKey: string
  readonly ledgerEntryId: string | null
  readonly correlationId: string
  readonly executedAt: Date
}

interface ExecutionRow {
  readonly id: string
  readonly proposal_id: string
  readonly kind: string
  readonly executed_by: string
  readonly idempotency_key: string
  readonly ledger_entry_id: string | null
  readonly correlation_id: string
  readonly executed_at: Date
}

const COLUMNS = `id, proposal_id, kind, executed_by, idempotency_key, ledger_entry_id,
                 correlation_id, executed_at`

function toExecution(row: ExecutionRow): Execution {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    kind: row.kind,
    executedBy: row.executed_by,
    idempotencyKey: row.idempotency_key,
    ledgerEntryId: row.ledger_entry_id,
    correlationId: row.correlation_id,
    executedAt: row.executed_at,
  }
}

/** The timelock trigger fired, or the proposal is not in a state that may execute. */
export class TimelockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimelockError'
  }
}

/** Policy refused the spend. A decision, not a fault — never retried with the same request. */
export class SpendRefusedError extends Error {
  readonly reasons: readonly string[]
  constructor(reasons: readonly string[]) {
    super(`the treasury spend was refused by policy: ${reasons.join(', ') || 'no reason given'}`)
    this.name = 'SpendRefusedError'
    this.reasons = reasons
  }
}

export type ExecuteOutcome =
  | { readonly status: 'executed'; readonly execution: Execution; readonly proposal: Proposal }
  /** Already done. Not an error — this is what exactly-once looks like from the second caller. */
  | { readonly status: 'already'; readonly execution: Execution }
  | { readonly status: 'missing' }

export interface ExecuteDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly policy: PolicyClient
  readonly producer: string
}

export interface ExecuteInput {
  readonly proposalId: string
  readonly executedBy: string
  readonly correlationId: string
}

/**
 * Execute a passed, timelocked proposal.
 *
 * Safe to call from two workers, from a retry, and from a caller that has no idea whether it has
 * already been called. See the file header for the four independent reasons that is true.
 */
export async function executeProposal(
  deps: ExecuteDeps,
  emitOutbox: (tx: Tx, event: Parameters<Emit>[0]) => Promise<void>,
  input: ExecuteInput,
): Promise<ExecuteOutcome> {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE POLICY GATE RUNS BEFORE THE TRANSACTION OPENS, AND IT IS FAIL-CLOSED.
  //
  // Before, because it is a network call and holding a row lock across two upstreams doubles the
  // window. Fail-closed because `07-dependency-map.md` says so and because SD-10 puts every
  // money-movement control in that column: an unreachable policy service throws
  // `PolicyUnavailableError`, which propagates, which fails the job, which leaves the proposal
  // `timelocked` for the next attempt. Nothing is spent while we do not know whether it should be.
  //
  // Reading the proposal twice — once here without a lock, once under the lock below — is
  // deliberate. The unlocked read is only used to decide what to ask policy; the locked read is
  // what the execution is built from, and if the two disagree the locked one wins.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const preview = await deps.sql<{ id: string; kind: string; status: string }[]>`
    select id, kind, status from proposals where id = ${input.proposalId}
  `
  const seen = preview[0]
  if (!seen) return { status: 'missing' }
  if (seen.status === 'executed') {
    const existing = await findExecution(deps.sql, input.proposalId)
    if (existing) return { status: 'already', execution: existing }
  }

  if (seen.kind === 'treasury_spend') {
    await gateSpend(deps, input)
  }

  const outcome = await deps.sql.begin(async (tx) => {
    // `for update`, NOT `for update skip locked`. Reason 2 in the file header.
    const proposal = await lockProposal(tx as Tx, input.proposalId)
    if (!proposal) return { value: { status: 'missing' } as ExecuteOutcome }

    if (proposal.status === 'executed') {
      const existing = await findExecution(tx as Tx, proposal.id)
      if (existing) return { value: { status: 'already', execution: existing } as ExecuteOutcome }
      // An `executed` proposal with no execution row cannot be produced by this file — the two are
      // written in one transaction. Refusing loudly rather than executing is the only safe answer:
      // continuing would post a second entry against a proposal that already reports as spent.
      throw new ConflictError(
        `proposal ${proposal.id} reports executed but names no execution — refusing to execute again`,
      )
    }

    // ────────────────────────────────────────────────────────────────────────────────────────
    // The row goes in FIRST. `community_assert_execution_timelock` fires here, BEFORE INSERT, and
    // refuses if the proposal is not `timelocked` or its `timelock_until` is in the future — using
    // the DATABASE's clock, not this process's. No money has moved at this point, which is the
    // whole reason for the ordering. See the file header.
    // ────────────────────────────────────────────────────────────────────────────────────────
    const key = idempotencyKeys.execute(proposal.id)
    let inserted: ExecutionRow[]
    try {
      inserted = await tx<ExecutionRow[]>`
        insert into executions (proposal_id, kind, executed_by, idempotency_key, correlation_id)
        values (${proposal.id}, ${proposal.kind}, ${input.executedBy}, ${key}, ${input.correlationId})
        returning ${tx.unsafe(COLUMNS)}
      `
    } catch (err) {
      if (isPgError(err, '23505')) {
        // `executions_proposal_uniq` — reason 3. Unreachable while the row lock above is held, and
        // caught rather than assumed away.
        throw new ConflictError(`proposal ${proposal.id} has already been executed`)
      }
      if (isPgError(err, '23514')) throw new TimelockError(messageOf(err))
      throw err
    }

    const row = inserted[0]
    if (!row) throw new ConflictError('the execution row was not written')
    let execution = toExecution(row)

    if (proposal.kind === 'treasury_spend') {
      execution = await postSpend(tx as Tx, deps, proposal, execution, input)
    }

    const updated = await markExecuted(tx as Tx, proposal.id, execution.id)

    // The event and the execution commit together or not at all — rule 5. See `outbox.ts`'s
    // header for what this particular event costs if that is not true.
    await emitOutbox(tx as Tx, {
      topic: TOPICS.proposalExecuted,
      key: proposal.id,
      actor: EXECUTOR_ACTOR,
      correlationId: input.correlationId,
      payload: {
        proposalId: proposal.id,
        communityId: proposal.communityId,
        kind: proposal.kind,
        executionId: execution.id,
        // The only thing a consumer can reconcile against. Null for a non-spend, which is honest:
        // a `text` proposal executing moves nothing.
        ledgerEntryId: execution.ledgerEntryId,
        ...(proposal.spend
          ? {
              assetCode: proposal.spend.assetCode,
              // A decimal STRING on the wire. A JSON number is an IEEE 754 double.
              amount: proposal.spend.amount.toString(),
              recipient: proposal.spend.recipient,
            }
          : {}),
      },
    })

    return { value: { status: 'executed', execution, proposal: updated } as ExecuteOutcome }
  })

  // Wrapped in an object above so postgres.js does not treat an array-shaped result as a list of
  // promises to unwrap, which would rewrite the caller's return type.
  return outcome.value
}

/**
 * Ask policy. Fail-closed: anything other than `allow` stops the spend.
 *
 * `review` is treated as a refusal here and not as a hold, deliberately. A `review` verdict means
 * a human should look, and there is no human in an execution job — a design that queued it would
 * be inventing an approval workflow that `micro-admin-api` already owns. Refusing leaves the
 * proposal `timelocked` and visible, which is the state an operator can act on.
 */
async function gateSpend(deps: ExecuteDeps, input: ExecuteInput): Promise<void> {
  const rows = await deps.sql<
    {
      community_id: string
      spend_amount: string | null
      spend_asset_code: string | null
      spend_recipient: string | null
    }[]
  >`
    select community_id, spend_amount::text as spend_amount, spend_asset_code, spend_recipient
      from proposals where id = ${input.proposalId}
  `
  const row = rows[0]
  if (!row || row.spend_amount === null || row.spend_asset_code === null || row.spend_recipient === null) {
    throw new NotFoundError('this proposal is not a complete treasury spend')
  }

  const verdict = await deps.policy.evaluateSpend({
    communityId: row.community_id,
    proposalId: input.proposalId,
    amount: row.spend_amount,
    assetCode: row.spend_asset_code,
    recipientSubject: row.spend_recipient,
    correlationId: input.correlationId,
  })
  if (verdict.decision !== 'allow') {
    throw new SpendRefusedError([verdict.decision, ...verdict.reasons])
  }
}

/**
 * Post the spend and write the entry id onto the execution row.
 *
 * The community's treasury subject is read from the COMMUNITY ROW, never from the proposal and
 * never from the request. There is no shape of this call that can debit a treasury the proposal
 * does not belong to.
 *
 * The asset must have a declared `treasury_accounts` row. Refusing otherwise is not bureaucracy:
 * the ledger creates accounts on first posting, so an undeclared asset would silently open a new
 * treasury account for a community that never agreed to hold that asset, and the members voting on
 * the spend would have been shown a balance for an account that did not exist.
 */
async function postSpend(
  tx: Tx,
  deps: ExecuteDeps,
  proposal: Proposal,
  execution: Execution,
  input: ExecuteInput,
): Promise<Execution> {
  const spend = proposal.spend
  if (!spend) throw new NotFoundError('this proposal names no treasury spend')

  const community = await findCommunity(tx, proposal.communityId)
  if (!community) throw new NotFoundError('no such community')

  const account = await findTreasuryAccount(tx, community.id, spend.assetCode)
  if (!account) {
    throw new NotFoundError(
      `this community holds no declared ${spend.assetCode} treasury account`,
    )
  }

  const entry = await deps.ledger.postEntry({
    kind: 'treasury_spend',
    actor: EXECUTOR_ACTOR,
    correlationId: input.correlationId,
    idempotencyKey: execution.idempotencyKey,
    description: `community ${community.slug} executes proposal ${proposal.id}`,
    postings: spendPostings({
      // From the row. See the doc comment.
      treasurySubject: community.treasurySubject as AccountSubject,
      recipientSubject: spend.recipient as AccountSubject,
      assetCode: spend.assetCode as LedgerAssetCode,
      amount: spend.amount,
    }),
  })

  const rows = await tx<ExecutionRow[]>`
    update executions set ledger_entry_id = ${entry.id}
     where id = ${execution.id} and ledger_entry_id is null
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) {
    // `executions_append_only` refuses a re-point, so this can only mean the row moved under its
    // own lock. Asserted rather than assumed: without it a lost update here would commit a spend
    // whose recorded entry is somebody else's.
    throw new ConflictError(`execution ${execution.id} changed under its own transaction`)
  }
  return toExecution(row)
}

export async function findExecution(sql: Db | Tx, proposalId: string): Promise<Execution | null> {
  const rows = await sql<ExecutionRow[]>`
    select ${sql.unsafe(COLUMNS)} from executions where proposal_id = ${proposalId}
  `
  const row = rows[0]
  return row ? toExecution(row) : null
}

export async function countExecutions(sql: Db | Tx, proposalId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from executions where proposal_id = ${proposalId}
  `
  return rows[0]?.n ?? 0
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
