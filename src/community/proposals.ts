/**
 * Proposals and discussion.
 *
 * 04-domain-model §9.3. The state machine is
 *
 *   draft → discussion → voting → { passed → timelocked → executed, rejected, cancelled }
 *
 * and every transition in it is claimed with `where status = <expected>`, never read-then-write.
 * That is what makes each one idempotent and safe under two workers: the second attempt matches no
 * row and answers "already", rather than moving a proposal that has since moved on.
 *
 * **The timelock is set when the proposal is created, not when it passes.** A community must know
 * before it votes how long the delay will be — a timelock chosen after the result is a timelock
 * chosen by whoever is unhappy with the result. `proposals_timelock_after_close` and
 * `proposals_spend_has_timelock` are the database saying the same thing.
 */

import type { Db, Emit, Tx } from './outbox.ts'
import { TOPICS } from './events.ts'
import { ConflictError, NotFoundError, ValidationError, type Community } from './communities.ts'
import type { GovernanceModel } from './communities.ts'

export const PROPOSAL_KINDS = Object.freeze([
  'treasury_spend',
  'role_change',
  'parameter_change',
  'text',
] as const)
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]

export const PROPOSAL_STATUSES = Object.freeze([
  'draft',
  'discussion',
  'voting',
  'passed',
  'timelocked',
  'executed',
  'rejected',
  'cancelled',
] as const)
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export function isProposalKind(value: string): value is ProposalKind {
  return (PROPOSAL_KINDS as readonly string[]).includes(value)
}

export interface TreasurySpendTarget {
  readonly assetCode: string
  /** Smallest units. `bigint` — see `tally.ts` for why nothing here is a float. */
  readonly amount: bigint
  /** A ledger account subject: `user:<id>`, `community:<id>` or `organisation:<id>`. */
  readonly recipient: string
}

export interface Proposal {
  readonly id: string
  readonly communityId: string
  readonly author: string
  readonly kind: ProposalKind
  readonly title: string
  readonly body: string
  readonly votingModel: GovernanceModel
  readonly quorum: bigint
  readonly thresholdBps: number
  readonly snapshotBlock: bigint | null
  readonly opensAt: Date
  readonly closesAt: Date
  readonly timelockUntil: Date
  readonly status: ProposalStatus
  readonly executionId: string | null
  readonly spend: TreasurySpendTarget | null
  readonly targetSubject: string | null
  readonly targetRole: string | null
  readonly createdAt: Date
}

interface ProposalRow {
  readonly id: string
  readonly community_id: string
  readonly author: string
  readonly kind: ProposalKind
  readonly title: string
  readonly body: string
  readonly voting_model: GovernanceModel
  readonly quorum: string
  readonly threshold_bps: number
  readonly snapshot_block: string | null
  readonly opens_at: Date
  readonly closes_at: Date
  readonly timelock_until: Date
  readonly status: ProposalStatus
  readonly execution_id: string | null
  readonly spend_asset_code: string | null
  readonly spend_amount: string | null
  readonly spend_recipient: string | null
  readonly target_subject: string | null
  readonly target_role: string | null
  readonly created_at: Date
}

// `::text` on every integer wider than a JS number. postgres.js hands `bigint` back as a string
// already, but the cast makes that a property of the query rather than of the driver version.
const COLUMNS = `id, community_id, author, kind, title, body, voting_model, quorum::text as quorum,
                 threshold_bps, snapshot_block::text as snapshot_block, opens_at, closes_at,
                 timelock_until, status, execution_id, spend_asset_code,
                 spend_amount::text as spend_amount, spend_recipient, target_subject, target_role,
                 created_at`

export function toProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    communityId: row.community_id,
    author: row.author,
    kind: row.kind,
    title: row.title,
    body: row.body,
    votingModel: row.voting_model,
    quorum: BigInt(row.quorum),
    thresholdBps: row.threshold_bps,
    snapshotBlock: row.snapshot_block === null ? null : BigInt(row.snapshot_block),
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    timelockUntil: row.timelock_until,
    status: row.status,
    executionId: row.execution_id,
    spend:
      row.spend_asset_code !== null && row.spend_amount !== null && row.spend_recipient !== null
        ? {
            assetCode: row.spend_asset_code,
            amount: BigInt(row.spend_amount),
            recipient: row.spend_recipient,
          }
        : null,
    targetSubject: row.target_subject,
    targetRole: row.target_role,
    createdAt: row.created_at,
  }
}

/* ------------------------------------------------------------------ create */

export interface CreateProposalInput {
  readonly author: string
  readonly kind: ProposalKind
  readonly title: string
  readonly body?: string
  readonly votingModel?: GovernanceModel
  readonly quorum: bigint
  readonly thresholdBps: number
  readonly snapshotBlock?: bigint | null
  readonly opensAt: Date
  readonly closesAt: Date
  readonly timelockUntil: Date
  readonly spend?: TreasurySpendTarget | null
  readonly targetSubject?: string | null
  readonly targetRole?: string | null
}

/**
 * The shortest delay a treasury spend may carry, in minutes.
 *
 * A floor rather than the value itself: a community chooses its own timelock, and this is the
 * point below which the delay stops being a delay. Fifteen minutes is enough for an alert to fire
 * and a human to read it, which is the operation AD-15's timelock exists to make possible.
 * Enforced here AND by `proposals_spend_has_timelock` (which requires only `>` close) — the
 * database refuses the degenerate case and this refuses the useless one.
 */
export const MIN_SPEND_TIMELOCK_MINUTES = 15

export async function createProposal(
  tx: Tx,
  emit: Emit,
  community: Community,
  input: CreateProposalInput,
): Promise<Proposal> {
  const votingModel = input.votingModel ?? community.governanceModel

  if (input.kind === 'treasury_spend') {
    if (!input.spend) throw new ValidationError('a treasury_spend proposal must name asset, amount and recipient')
    if (input.spend.amount <= 0n) throw new ValidationError('a treasury spend amount must be positive')
    const delayMs = input.timelockUntil.getTime() - input.closesAt.getTime()
    if (delayMs < MIN_SPEND_TIMELOCK_MINUTES * 60_000) {
      throw new ValidationError(
        `a treasury spend must carry a timelock of at least ${MIN_SPEND_TIMELOCK_MINUTES} minutes after voting closes`,
      )
    }
  } else if (input.spend) {
    throw new ValidationError(`a ${input.kind} proposal may not name a treasury spend`)
  }

  if (votingModel === 'token_weighted' && (input.snapshotBlock === undefined || input.snapshotBlock === null)) {
    throw new ValidationError(
      'a token_weighted proposal must name a snapshotBlock — without one, buying tokens, voting and selling them is a single transaction',
    )
  }

  const rows = await tx<ProposalRow[]>`
    insert into proposals (community_id, author, kind, title, body, voting_model, quorum,
                           threshold_bps, snapshot_block, opens_at, closes_at, timelock_until,
                           spend_asset_code, spend_amount, spend_recipient, target_subject,
                           target_role)
    values (${community.id}, ${input.author}, ${input.kind}, ${input.title}, ${input.body ?? ''},
            ${votingModel}, ${input.quorum.toString()}, ${input.thresholdBps},
            ${input.snapshotBlock === undefined || input.snapshotBlock === null ? null : input.snapshotBlock.toString()},
            ${input.opensAt}, ${input.closesAt}, ${input.timelockUntil},
            ${input.spend?.assetCode ?? null},
            ${input.spend ? input.spend.amount.toString() : null},
            ${input.spend?.recipient ?? null},
            ${input.targetSubject ?? null}, ${input.targetRole ?? null})
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new ValidationError('the proposal row was not written')
  const proposal = toProposal(row)

  emit({
    topic: TOPICS.proposalCreated,
    key: proposal.id,
    actor: input.author,
    payload: {
      proposalId: proposal.id,
      communityId: proposal.communityId,
      kind: proposal.kind,
      votingModel: proposal.votingModel,
      opensAt: proposal.opensAt.toISOString(),
      closesAt: proposal.closesAt.toISOString(),
      timelockUntil: proposal.timelockUntil.toISOString(),
    },
  })
  return proposal
}

export async function findProposal(sql: Db | Tx, id: string): Promise<Proposal | null> {
  const rows = await sql<ProposalRow[]>`
    select ${sql.unsafe(COLUMNS)} from proposals where id = ${id}
  `
  const row = rows[0]
  return row ? toProposal(row) : null
}

/** The same read, holding the row. Every transition that moves money takes this path. */
export async function lockProposal(tx: Tx, id: string): Promise<Proposal | null> {
  const rows = await tx<ProposalRow[]>`
    select ${tx.unsafe(COLUMNS)} from proposals where id = ${id} for update
  `
  const row = rows[0]
  return row ? toProposal(row) : null
}

export async function listProposals(
  sql: Db | Tx,
  communityId: string,
  limit: number,
): Promise<readonly Proposal[]> {
  const rows = await sql<ProposalRow[]>`
    select ${sql.unsafe(COLUMNS)} from proposals
     where community_id = ${communityId}
     order by created_at desc
     limit ${limit}
  `
  return rows.map(toProposal)
}

/* ------------------------------------------------------------------ transitions */

export type TransitionOutcome =
  | { readonly status: 'moved'; readonly proposal: Proposal }
  /** It was already there, or somewhere further on. Not an error — this is idempotence. */
  | { readonly status: 'already'; readonly proposal: Proposal }
  | { readonly status: 'missing' }

/**
 * Move a proposal from one status to another, claimed on the status it is expected to be in.
 *
 * `where status = ${from}` is the whole of the concurrency safety. Two workers both deciding that
 * a closed proposal has passed will both run this; one UPDATE matches a row and the other matches
 * none, and the loser reports `already` without emitting a second event or scheduling a second
 * execution.
 */
export async function transition(
  tx: Tx,
  id: string,
  from: ProposalStatus,
  to: ProposalStatus,
): Promise<TransitionOutcome> {
  const rows = await tx<ProposalRow[]>`
    update proposals set status = ${to}, updated_at = now()
     where id = ${id} and status = ${from}
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (row) return { status: 'moved', proposal: toProposal(row) }

  const current = await findProposal(tx, id)
  if (!current) return { status: 'missing' }
  return { status: 'already', proposal: current }
}

/** Open a draft for discussion. Author or an admin; the caller checks that. */
export async function openForDiscussion(tx: Tx, id: string): Promise<TransitionOutcome> {
  return transition(tx, id, 'draft', 'discussion')
}

/**
 * Cancel a proposal, from any state that has not yet moved money.
 *
 * `executed` is deliberately absent from the claimable set: an executed proposal has produced a
 * ledger entry, and marking it cancelled would leave the record saying a spend was cancelled while
 * the money is gone. The correction for a bad execution is a ledger reversal, not an edit here.
 */
export async function cancelProposal(tx: Tx, id: string): Promise<TransitionOutcome> {
  const rows = await tx<ProposalRow[]>`
    update proposals set status = 'cancelled', updated_at = now()
     where id = ${id} and status in ('draft','discussion','voting','passed','timelocked')
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (row) return { status: 'moved', proposal: toProposal(row) }
  const current = await findProposal(tx, id)
  if (!current) return { status: 'missing' }
  return { status: 'already', proposal: current }
}

/** Attach the execution to the proposal. Called inside the execution's own transaction. */
export async function markExecuted(tx: Tx, id: string, executionId: string): Promise<Proposal> {
  const rows = await tx<ProposalRow[]>`
    update proposals set status = 'executed', execution_id = ${executionId}, updated_at = now()
     where id = ${id} and status = 'timelocked'
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) {
    // Unreachable while the execution path holds the proposal's row lock, and asserted rather than
    // assumed: if a future change drops the lock, this is what turns a double execution into a
    // failure instead of a treasury spent twice.
    throw new ConflictError(`proposal ${id} was not timelocked when its execution committed`)
  }
  return toProposal(row)
}

/* ------------------------------------------------------------------ due work */

/** Proposals whose discussion window has opened. The transition job's first question. */
export async function proposalsDueToOpen(sql: Db | Tx, limit: number): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from proposals
     where status = 'discussion' and opens_at <= now()
     order by opens_at
     limit ${limit}
  `
  return rows.map((row) => row.id)
}

/** Proposals whose voting window has closed and which have not yet been counted. */
export async function proposalsDueToClose(sql: Db | Tx, limit: number): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from proposals
     where status = 'voting' and closes_at <= now()
     order by closes_at
     limit ${limit}
  `
  return rows.map((row) => row.id)
}

/**
 * Passed proposals whose timelock has expired.
 *
 * `now()` is the DATABASE's clock, the same one `community_assert_execution_timelock` reads. A
 * job that selected on its own clock would hand work to the executor that the database is about to
 * refuse, which turns a clock skew into a stream of failed jobs rather than a wait.
 */
export async function proposalsDueToExecute(sql: Db | Tx, limit: number): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from proposals
     where status = 'timelocked' and timelock_until <= now()
     order by timelock_until
     limit ${limit}
  `
  return rows.map((row) => row.id)
}

/* ------------------------------------------------------------------ discussion */

export interface DiscussionPost {
  readonly id: string
  readonly proposalId: string
  readonly author: string
  readonly body: string
  readonly createdAt: Date
  readonly redactedAt: Date | null
}

interface PostRow {
  readonly id: string
  readonly proposal_id: string
  readonly author: string
  readonly body: string
  readonly created_at: Date
  readonly redacted_at: Date | null
}

export async function addDiscussionPost(
  tx: Tx,
  proposalId: string,
  author: string,
  body: string,
): Promise<DiscussionPost> {
  const trimmed = body.trim()
  if (trimmed.length === 0) throw new ValidationError('a discussion post must have a body')
  const rows = await tx<PostRow[]>`
    insert into discussion_posts (proposal_id, author, body)
    values (${proposalId}, ${author}, ${trimmed})
    returning id, proposal_id, author, body, created_at, redacted_at
  `
  const row = rows[0]
  if (!row) throw new NotFoundError('no such proposal')
  return {
    id: row.id,
    proposalId: row.proposal_id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
    redactedAt: row.redacted_at,
  }
}

export async function listDiscussion(
  sql: Db | Tx,
  proposalId: string,
  limit: number,
): Promise<readonly DiscussionPost[]> {
  const rows = await sql<PostRow[]>`
    select id, proposal_id, author, body, created_at, redacted_at from discussion_posts
     where proposal_id = ${proposalId}
     order by created_at
     limit ${limit}
  `
  return rows.map((row) => ({
    id: row.id,
    proposalId: row.proposal_id,
    author: row.author,
    // A redacted post keeps its row and loses its text. The row is what makes the thread readable
    // — "[redacted]" between two replies is comprehensible, a missing post is not.
    body: row.redacted_at === null ? row.body : '[redacted]',
    createdAt: row.created_at,
    redactedAt: row.redacted_at,
  }))
}

export async function redactPost(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    update discussion_posts set redacted_at = now()
     where id = ${id} and redacted_at is null
    returning id
  `
  return rows.length > 0
}
