/**
 * Casting and counting votes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A VOTE IS COUNTED ONCE, AND THE CONSTRAINT IS WHAT SAYS SO.**
 *
 * `votes_proposal_subject_uniq` is `unique (proposal_id, subject)` where `subject` is *whose
 * voting power the row spends*, not who pressed the button. Everything below is downstream of
 * that one choice:
 *
 *   * **A member voting twice** — the second INSERT raises 23505. Under concurrency the second
 *     INSERT *blocks* on the first transaction's uncommitted row and then raises when it commits,
 *     so two simultaneous requests cannot both succeed. Proven with two connections in
 *     `votes.test.ts`.
 *
 *   * **A delegate voting, then the delegator voting** — the delegator's own INSERT hits the row
 *     their delegate wrote and raises. They are told their power was already cast and by whom,
 *     which is the answer that lets them do something about it (revoke, or ask the delegate to
 *     withdraw).
 *
 *   * **The delegator voting, then the delegate voting** — the delegate's INSERT for that
 *     delegator is `on conflict do nothing` and skips; the delegate's OWN row is a plain INSERT
 *     and stands. The delegator is counted once, by themselves, which is the right answer: a
 *     member who turns up in person has overridden their proxy.
 *
 * The asymmetry is deliberate and is the only interesting line in this file. The delegate's own
 * power must not be silently swallowed by a conflict — if it were, a delegate whose delegator had
 * already voted would think they had voted and have no row at all. So `do nothing` applies ONLY
 * to delegated rows, and the delegate's own row is the one that can raise.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **WEIGHT COMES FROM THE MODEL, NOT FROM THE REQUEST.** A caller never supplies a weight. For
 * `one_member_one_vote` it is 1 per subject; for `token_weighted` it is the subject's holding at
 * the proposal's snapshot block; for `reputation_weighted` it is the community's reputation read.
 * A weight a caller could choose is a vote a caller could inflate.
 */

import type { Db, Emit, Tx } from './outbox.ts'
import { TOPICS } from './events.ts'
import { ConflictError, ValidationError } from './communities.ts'
import { isPgError, delegatorsFor } from './delegations.ts'
import type { Proposal } from './proposals.ts'
import { type Choice, type Weights } from './tally.ts'

/** Raised when a subject's voting power has already been recorded on this proposal. */
export class AlreadyVotedError extends Error {
  readonly subject: string
  readonly castBy: string
  constructor(subject: string, castBy: string) {
    super(
      subject === castBy
        ? `${subject} has already voted on this proposal`
        : `${subject}'s voting power was already cast on this proposal by their delegate ${castBy}`,
    )
    this.name = 'AlreadyVotedError'
    this.subject = subject
    this.castBy = castBy
  }
}

/** Raised when the database refuses the vote because the proposal is not open. */
export class VotingClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VotingClosedError'
  }
}

export interface Vote {
  readonly id: string
  readonly proposalId: string
  readonly subject: string
  readonly castBy: string
  readonly choice: Choice
  readonly weight: bigint
  readonly castAt: Date
}

interface VoteRow {
  readonly id: string
  readonly proposal_id: string
  readonly subject: string
  readonly cast_by: string
  readonly choice: Choice
  readonly weight: string
  readonly cast_at: Date
}

const COLUMNS = `id, proposal_id, subject, cast_by, choice, weight::text as weight, cast_at`

function toVote(row: VoteRow): Vote {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    subject: row.subject,
    castBy: row.cast_by,
    choice: row.choice,
    // `::text` then `BigInt`, never `Number`. A token-weighted vote is a uint256.
    weight: BigInt(row.weight),
    castAt: row.cast_at,
  }
}

/**
 * How much a subject's vote is worth, under a given model.
 *
 * A seam rather than a switch buried in `castVote`, because `token_weighted` needs the indexer at
 * a snapshot block and `reputation_weighted` needs `micro-worlds`, and neither should be reachable
 * from a database transaction. The resolver is called BEFORE the transaction opens.
 */
export interface WeightResolver {
  /** Zero means "this subject has no voting power", and the vote is refused rather than recorded. */
  weightFor(proposal: Proposal, subject: string): Promise<bigint>
}

/**
 * One member, one vote. The default, and the only model that needs nothing outside this service.
 *
 * Every eligible subject weighs exactly 1, which makes `quorum` a head count and the threshold a
 * plain fraction of the people who turned up.
 */
export const oneMemberOneVote: WeightResolver = {
  weightFor: async () => 1n,
}

export interface CastVoteInput {
  readonly proposal: Proposal
  readonly voter: string
  readonly choice: Choice
  /** The voter's own weight, already resolved. Never taken from the request. */
  readonly ownWeight: bigint
  /**
   * The weight of each subject who delegated to the voter, already resolved.
   *
   * A map rather than a single number, because each delegator's power is recorded as its own row —
   * which is precisely what makes the unique constraint able to refuse a double count.
   */
  readonly delegatedWeights: ReadonlyMap<string, bigint>
}

export interface CastVoteResult {
  readonly own: Vote
  /** The delegated rows that were actually written. A delegator who already voted is absent. */
  readonly delegated: readonly Vote[]
  /** Delegators whose power was NOT counted, because they had already voted themselves. */
  readonly overriddenBy: readonly string[]
}

/**
 * Record a vote and every delegated vote it carries, in one transaction.
 *
 * The whole set commits or none of it does. A design that wrote the voter's own row and then
 * looped over the delegated ones outside a transaction could leave a delegate counted and their
 * delegators not — a partial vote, which is not a thing governance has a name for.
 */
export async function castVote(tx: Tx, emit: Emit, input: CastVoteInput): Promise<CastVoteResult> {
  if (input.ownWeight <= 0n) {
    throw new ValidationError('this member has no voting power on this proposal')
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // `on conflict … do nothing returning`, and then RAISE when nothing came back.
  //
  // Not a bare INSERT catching 23505, and the reason is a Postgres fact rather than a preference:
  // **a statement that raises inside a transaction aborts the whole transaction.** The lookup that
  // makes the error useful — "your power was cast by your delegate B" — would then run on an
  // aborted transaction and fail with 25P02, so the caller would receive a driver error instead of
  // the one thing they need to know. A SAVEPOINT would also work and is more machinery for the
  // same result.
  //
  // The conflict clause is NOT swallowing the duplicate. Zero rows is treated as a hard refusal
  // three lines below, which is the same outcome the raw INSERT gives — `votes.test.ts` proves the
  // database refuses it with the handler bypassed entirely, so this is a way of ASKING the
  // constraint rather than a way around it.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  let ownRows: VoteRow[]
  try {
    ownRows = await tx<VoteRow[]>`
      insert into votes (proposal_id, subject, cast_by, choice, weight)
      values (${input.proposal.id}, ${input.voter}, ${input.voter}, ${input.choice},
              ${input.ownWeight.toString()})
      on conflict (proposal_id, subject) do nothing
      returning ${tx.unsafe(COLUMNS)}
    `
  } catch (err) {
    if (isPgError(err, '23514')) {
      // `community_assert_vote_window` — the proposal is not `voting`, or the clock is outside the
      // window. The DATABASE's clock, deliberately: see the trigger.
      throw new VotingClosedError(messageOf(err))
    }
    throw err
  }

  const own = ownRows[0]
  if (!own) {
    // Somebody already holds this subject's row: either the voter themselves, or their delegate.
    // The existing row says which, and saying which is what makes the error actionable — a member
    // told only "already voted" cannot tell a double-click from a proxy they had forgotten about.
    const existing = await findVoteFor(tx, input.proposal.id, input.voter)
    throw new AlreadyVotedError(input.voter, existing?.castBy ?? input.voter)
  }

  const delegated: Vote[] = []
  const overriddenBy: string[] = []
  for (const [subject, weight] of input.delegatedWeights) {
    if (weight <= 0n) continue
    // ══════════════════════════════════════════════════════════════════════════════════════
    // `on conflict do nothing`, and ONLY here. A delegator who has already voted in person has
    // overridden their proxy, and that is the correct outcome rather than an error — the
    // delegate's vote is still valid for everybody else's power and for their own.
    //
    // The voter's own row above is deliberately NOT written this way. Swallowing a conflict
    // there would tell a delegate their vote had been recorded when no row of theirs exists.
    // ══════════════════════════════════════════════════════════════════════════════════════
    const rows = await tx<VoteRow[]>`
      insert into votes (proposal_id, subject, cast_by, choice, weight)
      values (${input.proposal.id}, ${subject}, ${input.voter}, ${input.choice}, ${weight.toString()})
      on conflict (proposal_id, subject) do nothing
      returning ${tx.unsafe(COLUMNS)}
    `
    const row = rows[0]
    if (row) delegated.push(toVote(row))
    else overriddenBy.push(subject)
  }

  emit({
    topic: TOPICS.voteCast,
    key: input.proposal.id,
    actor: input.voter,
    payload: {
      proposalId: input.proposal.id,
      communityId: input.proposal.communityId,
      voter: input.voter,
      choice: input.choice,
      // Counts, never the individual weights: an event that carried every delegator's holding
      // would put a wallet-size disclosure on the bus for anybody subscribed to governance.
      subjectsCounted: 1 + delegated.length,
      overridden: overriddenBy.length,
    },
  })

  return { own: toVote(own), delegated, overriddenBy }
}

/**
 * Withdraw a vote while the proposal is still open.
 *
 * A DELETE rather than an UPDATE, because `votes_immutable` refuses the UPDATE — a recorded vote
 * that can be edited is a record that can be rewritten. Deleting removes the claim on the
 * subject's power, so they (or their delegate) may cast again.
 *
 * **Only the subject may withdraw their own power, and a delegate may withdraw only the rows they
 * cast.** The `cast_by` predicate is what enforces the second half: a delegate cannot delete a
 * delegator's *direct* vote and replace it with their own, which would be the exact override the
 * asymmetry in `castVote` exists to prevent.
 */
export async function withdrawVote(
  tx: Tx,
  proposalId: string,
  subject: string,
  actor: string,
): Promise<number> {
  const proposal = await tx<{ status: string }[]>`
    select status from proposals where id = ${proposalId} for share
  `
  if (proposal[0]?.status !== 'voting') {
    throw new VotingClosedError('a vote may only be withdrawn while the proposal is still voting')
  }

  const rows = await tx<{ id: string }[]>`
    delete from votes
     where proposal_id = ${proposalId}
       and (
         -- the subject withdrawing their own power, however it was cast
         (subject = ${actor} and subject = ${subject})
         -- or a delegate withdrawing a row they themselves cast
         or (cast_by = ${actor} and subject = ${subject})
       )
    returning id
  `
  return rows.length
}

export async function findVoteFor(
  sql: Db | Tx,
  proposalId: string,
  subject: string,
): Promise<Vote | null> {
  const rows = await sql<VoteRow[]>`
    select ${sql.unsafe(COLUMNS)} from votes
     where proposal_id = ${proposalId} and subject = ${subject}
  `
  const row = rows[0]
  return row ? toVote(row) : null
}

export async function listVotes(
  sql: Db | Tx,
  proposalId: string,
  limit: number,
): Promise<readonly Vote[]> {
  const rows = await sql<VoteRow[]>`
    select ${sql.unsafe(COLUMNS)} from votes
     where proposal_id = ${proposalId}
     order by cast_at
     limit ${limit}
  `
  return rows.map(toVote)
}

/**
 * The recorded weights, summed per choice.
 *
 * **The sum is done by Postgres in `numeric` and read back as text, then `BigInt`.** Summing in
 * JavaScript would mean fetching every row and adding them up, which is both a scan this service
 * pays for and an invitation to add them as numbers. `numeric` addition is exact at any size, and
 * `::text` makes the crossing explicit.
 */
export async function weightsFor(sql: Db | Tx, proposalId: string): Promise<Weights> {
  const rows = await sql<{ choice: Choice; total: string; n: number }[]>`
    select choice, sum(weight)::text as total, count(*)::int as n
      from votes where proposal_id = ${proposalId}
     group by choice
  `
  let forWeight = 0n
  let againstWeight = 0n
  let abstainWeight = 0n
  let voterCount = 0
  for (const row of rows) {
    voterCount += row.n
    if (row.choice === 'for') forWeight = BigInt(row.total)
    else if (row.choice === 'against') againstWeight = BigInt(row.total)
    else abstainWeight = BigInt(row.total)
  }
  return { forWeight, againstWeight, abstainWeight, voterCount }
}

/* ------------------------------------------------------------------ resolution */

export interface ResolvedBallot {
  readonly ownWeight: bigint
  readonly delegatedWeights: ReadonlyMap<string, bigint>
}

/**
 * Everything a voter is entitled to spend, resolved before the transaction opens.
 *
 * The weight resolver may reach the indexer (`token_weighted`), so it must not run inside a
 * database transaction — a network call under an open transaction holds a connection for as long
 * as the slowest upstream, and this one is on the path of every vote rather than of a rare
 * settlement.
 *
 * A delegator whose weight resolves to zero is dropped here rather than written as a zero row:
 * `votes_weight_positive` would refuse it anyway, and a zero-weight row would claim the subject's
 * slot on the unique constraint — locking out a member whose holdings the indexer merely could not
 * report.
 */
export async function resolveBallot(
  sql: Db | Tx,
  resolver: WeightResolver,
  proposal: Proposal,
  voter: string,
): Promise<ResolvedBallot> {
  const ownWeight = await resolver.weightFor(proposal, voter)
  const delegators = await delegatorsFor(sql, proposal.communityId, voter)
  const delegatedWeights = new Map<string, bigint>()
  for (const subject of delegators) {
    const weight = await resolver.weightFor(proposal, subject)
    if (weight > 0n) delegatedWeights.set(subject, weight)
  }
  return { ownWeight, delegatedWeights }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export { ConflictError }
