/**
 * Delegated voting power.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A DELEGATION MUST NOT CREATE A CYCLE, AND MUST NOT LET ONE MEMBER'S POWER BE COUNTED TWICE.**
 *
 * Two different failures, refused in two different places, and neither of them here:
 *
 *   **The cycle** is refused by `community_refuse_delegation_cycle`, a BEFORE INSERT/UPDATE
 *   trigger that walks the active delegation graph with a recursive CTE under a per-community
 *   advisory lock. A→B→C→A makes the resolution below non-terminating; the degenerate A→A is
 *   caught even more cheaply by the `delegations_not_self` CHECK. The advisory lock is what makes
 *   it hold under concurrency — two transactions inserting A→B and B→A simultaneously each see a
 *   graph without the other's uncommitted row. See `migrations.ts` version 5.
 *
 *   **The double count** is refused by `votes_proposal_subject_uniq`, because a vote row is keyed
 *   by *whose power it spends* rather than by who cast it. This file's job is only to say whose
 *   power a voter is entitled to spend; the constraint decides what happens when two claims to the
 *   same power arrive. See `votes.ts`.
 *
 * Neither is a check in a handler, and that is the point. A handler binds the code path somebody
 * wrote; a constraint binds the bulk import, the operator's psql session and the code path
 * somebody writes next year.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **DELEGATION IS TRANSITIVE, AND BOUNDED.** If A delegates to B and B to C, C votes with all
 * three. That is the behaviour members expect and the reason the cycle check has to be a graph
 * walk rather than a single self-comparison. The walk is capped at `MAX_DELEGATION_DEPTH`, which
 * is belt-and-braces given cycles are impossible: a cap that is reached means the cycle trigger
 * has been dropped, and stopping is better than looping.
 */

import type { Db, Emit, Tx } from './outbox.ts'
import { TOPICS } from './events.ts'
import { ConflictError, NotFoundError, ValidationError } from './communities.ts'

/**
 * How deep the delegator walk goes.
 *
 * Cycles are impossible, so this can only be hit by a chain 64 members long — which no community
 * has, and which would in any case be a governance structure nobody can reason about. It is here
 * so that a database whose trigger has been dropped degrades to "some power is not counted"
 * rather than to "the request never returns".
 */
export const MAX_DELEGATION_DEPTH = 64

export interface Delegation {
  readonly id: string
  readonly communityId: string
  readonly delegatorSubject: string
  readonly delegateSubject: string
  readonly createdAt: Date
  readonly revokedAt: Date | null
}

interface DelegationRow {
  readonly id: string
  readonly community_id: string
  readonly delegator_subject: string
  readonly delegate_subject: string
  readonly created_at: Date
  readonly revoked_at: Date | null
}

const COLUMNS = `id, community_id, delegator_subject, delegate_subject, created_at, revoked_at`

function toDelegation(row: DelegationRow): Delegation {
  return {
    id: row.id,
    communityId: row.community_id,
    delegatorSubject: row.delegator_subject,
    delegateSubject: row.delegate_subject,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }
}

/** Raised when the database's cycle trigger fires. Mapped to 409 rather than 500. */
export class DelegationCycleError extends Error {
  constructor(delegator: string, delegate: string) {
    super(`delegating from ${delegator} to ${delegate} would create a cycle`)
    this.name = 'DelegationCycleError'
  }
}

export interface DelegateInput {
  readonly communityId: string
  readonly delegatorSubject: string
  readonly delegateSubject: string
}

/**
 * Delegate voting power within a community.
 *
 * The self-delegation and cycle checks are the DATABASE's; what this function adds is the
 * translation of `check_violation` into an error a caller can act on. It does **not** pre-check
 * for a cycle before inserting — a pre-check would be a second implementation of the rule that
 * can disagree with the first, and the one that is authoritative is the one that fires.
 */
export async function delegate(tx: Tx, emit: Emit, input: DelegateInput): Promise<Delegation> {
  if (input.delegatorSubject === input.delegateSubject) {
    // Caught here as well as by `delegations_not_self`, so the message names the mistake rather
    // than a constraint. The CHECK is still what makes it impossible.
    throw new ValidationError('a member may not delegate to themselves')
  }

  let rows: DelegationRow[]
  try {
    rows = await tx<DelegationRow[]>`
      insert into delegations (community_id, delegator_subject, delegate_subject)
      values (${input.communityId}, ${input.delegatorSubject}, ${input.delegateSubject})
      returning ${tx.unsafe(COLUMNS)}
    `
  } catch (err) {
    if (isPgError(err, '23514')) {
      // check_violation — the cycle trigger, or `delegations_not_self`.
      throw new DelegationCycleError(input.delegatorSubject, input.delegateSubject)
    }
    if (isPgError(err, '23505')) {
      // `delegations_active_uniq`. One active delegation per member per community: two would mean
      // a member's power is claimed by two delegates and the tally would have to pick one.
      throw new ConflictError('this member already has an active delegation in this community')
    }
    throw err
  }

  const row = rows[0]
  if (!row) throw new ValidationError('the delegation row was not written')
  const created = toDelegation(row)

  emit({
    topic: TOPICS.delegationCreated,
    key: input.communityId,
    actor: input.delegatorSubject,
    payload: {
      delegationId: created.id,
      communityId: created.communityId,
      delegator: created.delegatorSubject,
      delegate: created.delegateSubject,
    },
  })
  return created
}

/**
 * Revoke a delegation.
 *
 * **A revocation does not un-cast a vote.** If the delegate has already voted on an open proposal
 * using this power, the vote row stands — the delegate acted with authority they held at the time,
 * and rewriting a recorded vote is the thing `votes_immutable` exists to prevent. What revocation
 * changes is every proposal opened afterwards. `withdrawVote` is the route for the other case, and
 * it belongs to the person whose power it is.
 */
export async function revokeDelegation(
  tx: Tx,
  emit: Emit,
  communityId: string,
  delegatorSubject: string,
): Promise<Delegation> {
  const rows = await tx<DelegationRow[]>`
    update delegations set revoked_at = now()
     where community_id = ${communityId}
       and delegator_subject = ${delegatorSubject}
       and revoked_at is null
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new NotFoundError('no active delegation for this member in this community')
  const revoked = toDelegation(row)

  emit({
    topic: TOPICS.delegationRevoked,
    key: communityId,
    actor: delegatorSubject,
    payload: {
      delegationId: revoked.id,
      communityId,
      delegator: revoked.delegatorSubject,
      delegate: revoked.delegateSubject,
    },
  })
  return revoked
}

export async function activeDelegation(
  sql: Db | Tx,
  communityId: string,
  delegatorSubject: string,
): Promise<Delegation | null> {
  const rows = await sql<DelegationRow[]>`
    select ${sql.unsafe(COLUMNS)} from delegations
     where community_id = ${communityId}
       and delegator_subject = ${delegatorSubject}
       and revoked_at is null
  `
  const row = rows[0]
  return row ? toDelegation(row) : null
}

/**
 * Every subject whose power a voter may spend, NOT including the voter.
 *
 * The transitive closure of delegators, walked backwards from the voter. Because the trigger makes
 * cycles impossible the walk terminates on its own; `MAX_DELEGATION_DEPTH` is the guard for the
 * database that has lost its trigger.
 *
 * The result is deliberately ordered and de-duplicated by the CTE's `union` — `union` rather than
 * `union all`, so that a diamond (X delegates to Y and Z, both of whom delegate to V) contributes
 * X exactly once. A diamond is not a cycle and is perfectly legal; counting X twice through it
 * would be the same double count the vote constraint exists to prevent, arriving from the other
 * direction.
 */
export async function delegatorsFor(
  sql: Db | Tx,
  communityId: string,
  delegateSubject: string,
): Promise<readonly string[]> {
  const rows = await sql<{ subject: string }[]>`
    with recursive chain as (
      select d.delegator_subject as subject, 1 as depth
        from delegations d
       where d.community_id = ${communityId}
         and d.delegate_subject = ${delegateSubject}
         and d.revoked_at is null
      union
      select d.delegator_subject, chain.depth + 1
        from delegations d
        join chain on d.delegate_subject = chain.subject
       where d.community_id = ${communityId}
         and d.revoked_at is null
         and chain.depth < ${MAX_DELEGATION_DEPTH}
    )
    select distinct subject from chain order by subject
  `
  return rows.map((row) => row.subject)
}

/** postgres.js surfaces the server's SQLSTATE on `err.code`. */
function isPgError(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  )
}

export { isPgError }
