/**
 * One member, one counted vote — proven against a real database, and under concurrency.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE FOUR TESTS THIS FILE EXISTS FOR.**
 *
 *   1. `a member cannot vote twice`                      — the plain case, 23505.
 *   2. `two concurrent votes by one member produce one`  — TWO CONNECTIONS, not two awaits. A
 *                                                          single-connection test proves nothing
 *                                                          about a race, because postgres.js
 *                                                          serialises statements on one connection
 *                                                          and both would run in order anyway.
 *   3. `a delegate's vote and the delegator's own vote cannot both count` — in BOTH orders, which
 *                                                          are genuinely different code paths:
 *                                                          one is `on conflict do nothing` and the
 *                                                          other is a raised 23505.
 *   4. `the constraint holds with the handler bypassed`  — a raw INSERT. Everything above goes
 *                                                          through `castVote`; this is what says
 *                                                          the property belongs to the database.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  AlreadyVotedError,
  VotingClosedError,
  castVote,
  findVoteFor,
  listVotes,
  oneMemberOneVote,
  resolveBallot,
  weightsFor,
  withdrawVote,
} from './votes.ts'
import { delegate } from './delegations.ts'
import { tally } from './tally.ts'
import {
  asTx,
  collector,
  migrateTestDb,
  openDb,
  resetCommunity,
  seedCommunity,
  seedMember,
  seedProposal,
  skip,
  subject,
} from './testsupport.ts'
import type { Community } from './communities.ts'
import type { Proposal } from './proposals.ts'

let sql: postgres.Sql
let community: Community
let proposal: Proposal

const ALICE = subject('alice')
const BOB = subject('bob')
const CARLA = subject('carla')
const DEV = subject('dev')

before(async () => {
  if (!skip) {
    sql = openDb()
    await migrateTestDb(sql)
  }
})

after(async () => {
  if (!skip) await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (skip) return
  await resetCommunity(sql)
  community = await seedCommunity(sql, { ownerSubject: ALICE })
  await seedMember(sql, community, BOB)
  await seedMember(sql, community, CARLA)
  await seedMember(sql, community, DEV)
  proposal = await seedProposal(sql, community, { status: 'voting', quorum: 1n })
})

/** Cast a vote the way the route does: resolve, then run in one transaction. */
async function vote(
  voter: string,
  choice: 'for' | 'against' | 'abstain',
): Promise<{ counted: number; overridden: readonly string[] }> {
  const ballot = await resolveBallot(sql, oneMemberOneVote, proposal, voter)
  const outcome = await sql.begin(async (tx) => {
    const { emit } = collector()
    const result = await castVote(asTx(tx), emit, {
      proposal,
      voter,
      choice,
      ownWeight: ballot.ownWeight,
      delegatedWeights: ballot.delegatedWeights,
    })
    return { value: result }
  })
  return {
    counted: 1 + outcome.value.delegated.length,
    overridden: outcome.value.overriddenBy,
  }
}

/* ------------------------------------------------------------------ 1. voting twice */

test('a member cannot vote twice', { skip }, async () => {
  await vote(BOB, 'for')
  await assert.rejects(() => vote(BOB, 'against'), AlreadyVotedError)

  const rows = await listVotes(sql, proposal.id, 100)
  assert.equal(rows.length, 1, 'a second vote left a second row')
  assert.equal(rows[0]?.choice, 'for', 'the second attempt overwrote the first')
})

test('the error names who cast the power, which is what makes it actionable', { skip }, async () => {
  await vote(BOB, 'for')
  await assert.rejects(
    () => vote(BOB, 'for'),
    (err: unknown) => {
      assert.ok(err instanceof AlreadyVotedError)
      assert.equal(err.subject, BOB)
      assert.equal(err.castBy, BOB)
      return true
    },
  )
})

/* ------------------------------------------------------------------ 2. concurrency */

test('two concurrent votes by one member produce exactly one row', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // TWO SEPARATE POOLS, so the two transactions are on two connections and genuinely overlap. On
  // one pool postgres.js would run them in sequence and this test would pass without ever
  // exercising the race it is named after.
  //
  // The second INSERT BLOCKS on the first transaction's uncommitted row — it does not fail fast —
  // and raises 23505 only when the first commits. That is the behaviour that makes the constraint
  // sufficient on its own: there is no interleaving in which both succeed.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const a = openDb(2)
  const b = openDb(2)
  try {
    const cast = (client: postgres.Sql) =>
      client
        .begin(async (tx) => {
          const { emit } = collector()
          await castVote(asTx(tx), emit, {
            proposal,
            voter: BOB,
            choice: 'for',
            ownWeight: 1n,
            delegatedWeights: new Map(),
          })
          return { ok: true }
        })
        .then(
          () => 'ok' as const,
          (err: unknown) => (err instanceof AlreadyVotedError ? ('refused' as const) : Promise.reject(err)),
        )

    const results = await Promise.all([cast(a), cast(b)])
    assert.equal(results.filter((r) => r === 'ok').length, 1, `expected one winner, got ${results.join(',')}`)
    assert.equal(results.filter((r) => r === 'refused').length, 1)

    const rows = await listVotes(sql, proposal.id, 100)
    assert.equal(rows.length, 1, 'the concurrent votes both landed')
  } finally {
    await a.end({ timeout: 5 })
    await b.end({ timeout: 5 })
  }
})

/* ------------------------------------------------------------------ 3. delegation */

test("a delegate carries their delegators' power, once each", { skip }, async () => {
  await sql.begin(async (tx) => {
    const { emit } = collector()
    await delegate(asTx(tx), emit, {
      communityId: community.id,
      delegatorSubject: CARLA,
      delegateSubject: BOB,
    })
    await delegate(asTx(tx), emit, {
      communityId: community.id,
      delegatorSubject: DEV,
      delegateSubject: CARLA,
    })
    return { done: true }
  })

  // Transitive: DEV → CARLA → BOB, so BOB carries three.
  const result = await vote(BOB, 'for')
  assert.equal(result.counted, 3)
  assert.deepEqual([...result.overridden], [])

  const rows = await listVotes(sql, proposal.id, 100)
  assert.deepEqual(
    rows.map((r) => r.subject).sort(),
    [BOB, CARLA, DEV].sort(),
    'one row per subject whose power was spent',
  )
  for (const row of rows) assert.equal(row.castBy, BOB, 'every row names who actually voted')

  const weights = await weightsFor(sql, proposal.id)
  assert.equal(weights.forWeight, 3n)
})

test('the delegator votes first: the delegate does not count them again', { skip }, async () => {
  await sql.begin(async (tx) => {
    const { emit } = collector()
    await delegate(asTx(tx), emit, {
      communityId: community.id,
      delegatorSubject: CARLA,
      delegateSubject: BOB,
    })
    return { done: true }
  })

  // Carla turns up in person. Her power is hers.
  await vote(CARLA, 'against')
  // Bob votes with his own power only; Carla's row is already taken and the `on conflict do
  // nothing` skips it.
  const result = await vote(BOB, 'for')

  assert.equal(result.counted, 1, "the delegate counted their delegator's power a second time")
  assert.deepEqual([...result.overridden], [CARLA], 'the delegate was not told they were overridden')

  const weights = await weightsFor(sql, proposal.id)
  assert.equal(weights.forWeight, 1n)
  assert.equal(weights.againstWeight, 1n)
  // The whole point: two members, two units of weight. Not three.
  assert.equal(weights.forWeight + weights.againstWeight, 2n)

  const carlaVote = await findVoteFor(sql, proposal.id, CARLA)
  assert.equal(carlaVote?.choice, 'against', "the delegate overwrote their delegator's own vote")
  assert.equal(carlaVote?.castBy, CARLA)
})

test('the delegate votes first: the delegator is refused, and told why', { skip }, async () => {
  await sql.begin(async (tx) => {
    const { emit } = collector()
    await delegate(asTx(tx), emit, {
      communityId: community.id,
      delegatorSubject: CARLA,
      delegateSubject: BOB,
    })
    return { done: true }
  })

  await vote(BOB, 'for')

  await assert.rejects(
    () => vote(CARLA, 'against'),
    (err: unknown) => {
      assert.ok(err instanceof AlreadyVotedError)
      assert.equal(err.subject, CARLA)
      // Naming the delegate is what lets the member do something about it.
      assert.equal(err.castBy, BOB)
      return true
    },
  )

  const weights = await weightsFor(sql, proposal.id)
  assert.equal(weights.forWeight, 2n, 'the delegate should still carry both')
  assert.equal(weights.againstWeight, 0n)
})

test("a delegate's own vote is never swallowed by a conflict", { skip }, async () => {
  // The asymmetry in `castVote`: `on conflict do nothing` applies to DELEGATED rows only. If it
  // applied to the delegate's own row too, a delegate whose delegator had already voted would be
  // told they voted while holding no row at all.
  await sql.begin(async (tx) => {
    const { emit } = collector()
    await delegate(asTx(tx), emit, {
      communityId: community.id,
      delegatorSubject: CARLA,
      delegateSubject: BOB,
    })
    return { done: true }
  })
  await vote(CARLA, 'for')
  await vote(BOB, 'for')

  const bobVote = await findVoteFor(sql, proposal.id, BOB)
  assert.ok(bobVote, "the delegate's own vote was swallowed")
  assert.equal(bobVote.castBy, BOB)
})

/* ------------------------------------------------------------------ 4. handler bypassed */

test('the unique constraint holds with the handler bypassed entirely', { skip }, async () => {
  // A raw INSERT. No `castVote`, no error translation, no branch. If this passes, the property
  // belongs to the database and survives any rewrite of the application.
  await sql`
    insert into votes (proposal_id, subject, cast_by, choice, weight)
    values (${proposal.id}, ${BOB}, ${BOB}, 'for', 1)
  `
  await assert.rejects(
    () => sql`
      insert into votes (proposal_id, subject, cast_by, choice, weight)
      values (${proposal.id}, ${BOB}, ${CARLA}, 'against', 5)
    `,
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23505')
      return true
    },
  )
})

test('a vote is immutable, with the handler bypassed', { skip }, async () => {
  await vote(BOB, 'for')
  await assert.rejects(
    () => sql`update votes set choice = 'against' where proposal_id = ${proposal.id}`,
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23514')
      return true
    },
  )
})

test('a zero or negative weight is refused by the database', { skip }, async () => {
  for (const weight of ['0', '-1']) {
    await assert.rejects(
      () => sql`
        insert into votes (proposal_id, subject, cast_by, choice, weight)
        values (${proposal.id}, ${subject('ghost')}, ${subject('ghost')}, 'for', ${weight})
      `,
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, '23514')
        return true
      },
    )
  }
})

/* ------------------------------------------------------------------ the window */

test('a vote outside the window is refused by the database, not by the handler', { skip }, async () => {
  const closed = await seedProposal(sql, community, {
    status: 'voting',
    opensAt: new Date(Date.now() - 7_200_000),
    closesAt: new Date(Date.now() - 3_600_000),
    timelockUntil: new Date(Date.now() - 60_000),
  })
  // Raw INSERT: the trigger, not a guard in `castVote`.
  await assert.rejects(
    () => sql`
      insert into votes (proposal_id, subject, cast_by, choice, weight)
      values (${closed.id}, ${BOB}, ${BOB}, 'for', 1)
    `,
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23514')
      assert.match(String((err as Error).message), /outside its voting window/)
      return true
    },
  )
})

test('a proposal that is not `voting` accepts no votes', { skip }, async () => {
  const draft = await seedProposal(sql, community, { status: 'discussion' })
  await assert.rejects(
    () => sql`
      insert into votes (proposal_id, subject, cast_by, choice, weight)
      values (${draft.id}, ${BOB}, ${BOB}, 'for', 1)
    `,
    (err: unknown) => {
      assert.match(String((err as Error).message), /is discussion and is not accepting votes/)
      return true
    },
  )
})

test('castVote translates the window trigger into VotingClosedError', { skip }, async () => {
  const draft = await seedProposal(sql, community, { status: 'discussion' })
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        const { emit } = collector()
        await castVote(asTx(tx), emit, {
          proposal: draft,
          voter: BOB,
          choice: 'for',
          ownWeight: 1n,
          delegatedWeights: new Map(),
        })
        return { done: true }
      }),
    VotingClosedError,
  )
})

/* ------------------------------------------------------------------ withdrawal */

test('a member may withdraw their own vote and cast again', { skip }, async () => {
  await vote(BOB, 'for')
  const removed = await sql.begin(async (tx) => ({
    value: await withdrawVote(asTx(tx), proposal.id, BOB, BOB),
  }))
  assert.equal(removed.value, 1)
  await vote(BOB, 'against')
  const weights = await weightsFor(sql, proposal.id)
  assert.equal(weights.againstWeight, 1n)
  assert.equal(weights.forWeight, 0n)
})

test("a delegate may not withdraw a delegator's own direct vote", { skip }, async () => {
  await sql.begin(async (tx) => {
    const { emit } = collector()
    await delegate(asTx(tx), emit, {
      communityId: community.id,
      delegatorSubject: CARLA,
      delegateSubject: BOB,
    })
    return { done: true }
  })
  await vote(CARLA, 'against')

  const removed = await sql.begin(async (tx) => ({
    value: await withdrawVote(asTx(tx), proposal.id, CARLA, BOB),
  }))
  assert.equal(removed.value, 0, "a delegate deleted their delegator's direct vote")
  const still = await findVoteFor(sql, proposal.id, CARLA)
  assert.equal(still?.castBy, CARLA)
})

test('a delegate may withdraw a row they themselves cast', { skip }, async () => {
  await sql.begin(async (tx) => {
    const { emit } = collector()
    await delegate(asTx(tx), emit, {
      communityId: community.id,
      delegatorSubject: CARLA,
      delegateSubject: BOB,
    })
    return { done: true }
  })
  await vote(BOB, 'for')
  const removed = await sql.begin(async (tx) => ({
    value: await withdrawVote(asTx(tx), proposal.id, CARLA, BOB),
  }))
  assert.equal(removed.value, 1)
  // Carla is now free to vote for herself.
  await vote(CARLA, 'against')
  const weights = await weightsFor(sql, proposal.id)
  assert.equal(weights.forWeight, 1n)
  assert.equal(weights.againstWeight, 1n)
})

/* ------------------------------------------------------------------ weights, summed */

test('weights are summed by Postgres in numeric and cross as text', { skip }, async () => {
  // Above 2^53. If any part of this path went through a JS number these would not come back exact.
  const huge = 10_000_000_000_000_000_000_000n
  await sql`
    insert into votes (proposal_id, subject, cast_by, choice, weight)
    values (${proposal.id}, ${BOB}, ${BOB}, 'for', ${huge.toString()}),
           (${proposal.id}, ${CARLA}, ${CARLA}, 'for', ${(huge + 1n).toString()}),
           (${proposal.id}, ${DEV}, ${DEV}, 'against', ${huge.toString()})
  `
  const weights = await weightsFor(sql, proposal.id)
  assert.equal(weights.forWeight, huge * 2n + 1n)
  assert.equal(weights.againstWeight, huge)
  assert.equal(weights.voterCount, 3)

  // And the tally decides on those exact integers.
  const result = tally(weights, { quorum: 1n, thresholdBps: 5_000 })
  assert.equal(result.outcome, 'passed')
  assert.equal(result.decidedWeight, huge * 3n + 1n)
})

test('a vote with no power is refused before it reaches the database', { skip }, async () => {
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        const { emit } = collector()
        await castVote(asTx(tx), emit, {
          proposal,
          voter: BOB,
          choice: 'for',
          ownWeight: 0n,
          delegatedWeights: new Map(),
        })
        return { done: true }
      }),
    /no voting power/,
  )
})

test('a delegator whose weight is zero occupies no row', { skip }, async () => {
  // A zero-weight row would claim the subject's slot on the unique constraint, locking out a
  // member whose holdings the indexer merely could not report. `resolveBallot` drops them.
  await sql.begin(async (tx) => {
    const { emit } = collector()
    await delegate(asTx(tx), emit, {
      communityId: community.id,
      delegatorSubject: CARLA,
      delegateSubject: BOB,
    })
    return { done: true }
  })

  const ballot = await resolveBallot(
    sql,
    { weightFor: async (_p, who) => (who === CARLA ? 0n : 1n) },
    proposal,
    BOB,
  )
  assert.equal(ballot.delegatedWeights.size, 0)

  await sql.begin(async (tx) => {
    const { emit } = collector()
    await castVote(asTx(tx), emit, {
      proposal,
      voter: BOB,
      choice: 'for',
      ownWeight: ballot.ownWeight,
      delegatedWeights: ballot.delegatedWeights,
    })
    return { done: true }
  })

  assert.equal(await findVoteFor(sql, proposal.id, CARLA), null)
  // And she can still vote for herself once the indexer recovers.
  await vote(CARLA, 'against')
  assert.ok(await findVoteFor(sql, proposal.id, CARLA))
})
