/**
 * Delegation: no cycle, no double count, no lost power.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE TEST THIS FILE EXISTS FOR IS `TWO CONCURRENT DELEGATIONS CANNOT CLOSE A LOOP`.**
 *
 * The single-transaction cycle test is easy and would pass against a trigger with no advisory
 * lock. The concurrent one is the whole reason the lock is there: A→B and B→A inserted at the same
 * moment, on two connections, each walking a graph that does not yet contain the other's
 * uncommitted row. Without `pg_advisory_xact_lock` both find no cycle and both commit one, and the
 * next tally that walks the graph never returns.
 *
 * Every cycle test below uses a raw INSERT as well as `delegate`, because the property has to
 * belong to the database rather than to the handler.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  DelegationCycleError,
  MAX_DELEGATION_DEPTH,
  activeDelegation,
  delegate,
  delegatorsFor,
  revokeDelegation,
} from './delegations.ts'
import { ConflictError, ValidationError } from './communities.ts'
import {
  asTx,
  collector,
  migrateTestDb,
  openDb,
  resetCommunity,
  seedCommunity,
  seedMember,
  skip,
  subject,
} from './testsupport.ts'
import type { Community } from './communities.ts'

let sql: postgres.Sql
let community: Community

const A = subject('a')
const B = subject('b')
const C = subject('c')
const D = subject('d')

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
  community = await seedCommunity(sql, { ownerSubject: A })
  for (const who of [B, C, D]) await seedMember(sql, community, who)
})

async function link(from: string, to: string): Promise<void> {
  await sql.begin(async (tx) => {
    const { emit } = collector()
    await delegate(asTx(tx), emit, {
      communityId: community.id,
      delegatorSubject: from,
      delegateSubject: to,
    })
    return { done: true }
  })
}

/** The same insert with no handler in the way. */
function rawLink(client: postgres.Sql, from: string, to: string): Promise<unknown> {
  return client`
    insert into delegations (community_id, delegator_subject, delegate_subject)
    values (${community.id}, ${from}, ${to})
  `
}

/* ------------------------------------------------------------------ cycles */

test('self-delegation is refused by the database', { skip }, async () => {
  await assert.rejects(
    () => rawLink(sql, A, A),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23514')
      // Either object may catch it and both are correct: the BEFORE trigger runs ahead of the
      // table's CHECKs, and a zero-length chain from A back to A is a cycle by the trigger's own
      // definition. Asserting on the SQLSTATE rather than on which one fired is the honest test —
      // pinning the message would make the test fail the day the trigger is (correctly) reordered,
      // while `delegations_not_self` still stands behind it.
      assert.match(String((err as Error).message), /would create a cycle|delegations_not_self/)
      return true
    },
  )
})

test('the not-self CHECK stands on its own, with the cycle trigger removed', { skip }, async () => {
  // The reason the previous test cannot say which object fired is that one hides the other. This
  // one drops the trigger inside a transaction that is then rolled back, so the CHECK is observed
  // alone — and the schema is unchanged afterwards.
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await tx.unsafe('drop trigger delegations_no_cycle on delegations')
        await tx`
          insert into delegations (community_id, delegator_subject, delegate_subject)
          values (${community.id}, ${A}, ${A})
        `
        return { done: true }
      }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23514')
      assert.match(String((err as { constraint_name?: string }).constraint_name ?? ''), /delegations_not_self/)
      return true
    },
  )
  // The rollback put it back. If it had not, every later cycle test would silently pass on nothing.
  const triggers = await sql<{ tgname: string }[]>`
    select tgname from pg_trigger where tgname = 'delegations_no_cycle'
  `
  assert.equal(triggers.length, 1, 'the cycle trigger did not survive the rolled-back drop')
})

test('self-delegation is also refused by the handler, with a readable message', { skip }, async () => {
  await assert.rejects(() => link(A, A), ValidationError)
})

test('a two-hop cycle is refused by the database', { skip }, async () => {
  await link(A, B)
  await assert.rejects(
    () => rawLink(sql, B, A),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23514')
      assert.match(String((err as Error).message), /would create a cycle/)
      return true
    },
  )
})

test('a long cycle is refused by the database', { skip }, async () => {
  await link(A, B)
  await link(B, C)
  await link(C, D)
  // D → A closes A→B→C→D→A.
  await assert.rejects(
    () => rawLink(sql, D, A),
    (err: unknown) => {
      assert.match(String((err as Error).message), /would create a cycle/)
      return true
    },
  )
  // And the handler translates it into something a caller can act on.
  await assert.rejects(() => link(D, A), DelegationCycleError)
})

test('a diamond is NOT a cycle and is allowed', { skip }, async () => {
  // A and B both delegate to C. That is two people trusting one person, which is the ordinary
  // case, and a naive "has this subject already appeared" check would refuse it.
  await link(A, C)
  await link(B, C)
  const delegators = await delegatorsFor(sql, community.id, C)
  assert.deepEqual([...delegators].sort(), [A, B].sort())
})

test('a revoked edge does not count toward a cycle', { skip }, async () => {
  await link(A, B)
  await sql.begin(async (tx) => {
    const { emit } = collector()
    await revokeDelegation(asTx(tx), emit, community.id, A)
    return { done: true }
  })
  // With A→B revoked, B→A is no longer a loop.
  await link(B, A)
  assert.equal((await activeDelegation(sql, community.id, B))?.delegateSubject, A)
})

/* ------------------------------------------------------------------ the concurrent cycle */

test('two concurrent delegations cannot close a loop', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE TEST THE ADVISORY LOCK EXISTS FOR.
  //
  // Two connections, two transactions, A→B and B→A started together. Neither can see the other's
  // uncommitted row, so a trigger that only walked the graph would find no cycle in either and let
  // both commit. `pg_advisory_xact_lock` on the community serialises the two checks: the second
  // waits for the first to commit, then walks a graph that contains it, and raises.
  //
  // Both barriers are needed to make the interleaving real. Without them the first transaction
  // frequently commits before the second even opens, and the test passes without racing anything.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const one = openDb(2)
  const two = openDb(2)
  try {
    let releaseFirst: () => void = () => {}
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const attempt = (
      client: postgres.Sql,
      from: string,
      to: string,
      before?: () => void,
      wait?: Promise<void>,
    ) =>
      client
        .begin(async (tx) => {
          if (wait) await wait
          await tx`
            insert into delegations (community_id, delegator_subject, delegate_subject)
            values (${community.id}, ${from}, ${to})
          `
          before?.()
          // Held open a moment so the other transaction is genuinely in flight when this one is
          // still uncommitted.
          await new Promise((resolve) => setTimeout(resolve, 150))
          return { ok: true }
        })
        .then(
          () => 'ok' as const,
          (err: unknown) =>
            (err as { code?: string }).code === '23514' ? ('refused' as const) : Promise.reject(err),
        )

    const [first, second] = await Promise.all([
      attempt(one, A, B, releaseFirst),
      attempt(two, B, A, undefined, firstReady),
    ])

    assert.deepEqual([first, second].sort(), ['ok', 'refused'], 'both concurrent delegations committed')

    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from delegations
       where community_id = ${community.id} and revoked_at is null
    `
    assert.equal(rows[0]?.n, 1, 'a cycle was committed by two concurrent transactions')
  } finally {
    await one.end({ timeout: 5 })
    await two.end({ timeout: 5 })
  }
})

/* ------------------------------------------------------------------ one active delegation */

test('a member may hold only one active delegation per community', { skip }, async () => {
  await link(A, B)
  await assert.rejects(() => link(A, C), ConflictError)
  await assert.rejects(
    () => rawLink(sql, A, C),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23505')
      return true
    },
  )
})

test('a revoked delegation frees the slot', { skip }, async () => {
  await link(A, B)
  await sql.begin(async (tx) => {
    const { emit } = collector()
    await revokeDelegation(asTx(tx), emit, community.id, A)
    return { done: true }
  })
  await link(A, C)
  assert.equal((await activeDelegation(sql, community.id, A))?.delegateSubject, C)
})

test('delegations are scoped to their community, and so are cycles', { skip }, async () => {
  const other = await seedCommunity(sql, { ownerSubject: A })
  await seedMember(sql, other, B)

  // A → B here.
  await link(A, B)
  // So B → A here is a loop, and is refused.
  await assert.rejects(() => link(B, A), DelegationCycleError)

  // The same pair, in a community with no A → B edge, is perfectly ordinary — the trigger walks
  // one community's graph and never another's.
  await sql.begin(async (tx) => {
    const { emit } = collector()
    await delegate(asTx(tx), emit, {
      communityId: other.id,
      delegatorSubject: B,
      delegateSubject: A,
    })
    return { done: true }
  })

  assert.deepEqual([...(await delegatorsFor(sql, community.id, B))], [A])
  assert.deepEqual([...(await delegatorsFor(sql, other.id, A))], [B])
  assert.equal(await activeDelegation(sql, community.id, B), null)
  assert.equal((await activeDelegation(sql, other.id, B))?.delegateSubject, A)
})

/* ------------------------------------------------------------------ resolution */

test('delegatorsFor is transitive and excludes the delegate', { skip }, async () => {
  await link(A, B)
  await link(B, C)
  const forC = await delegatorsFor(sql, community.id, C)
  assert.deepEqual([...forC].sort(), [A, B].sort())
  assert.ok(!forC.includes(C), 'the delegate must not appear among their own delegators')
})

test('a diamond contributes each subject exactly once', { skip }, async () => {
  // X delegates to Y and to Z is impossible (one active delegation), so the diamond that CAN occur
  // is two chains converging. A→C, B→C, C→D: D carries A, B and C, each once.
  await link(A, C)
  await link(B, C)
  await link(C, D)
  const forD = await delegatorsFor(sql, community.id, D)
  assert.deepEqual([...forD].sort(), [A, B, C].sort())
  assert.equal(new Set(forD).size, forD.length, 'a subject appeared twice')
})

test('the depth cap is high enough not to bind on a real chain', { skip }, () => {
  // Documented rather than exercised with a 64-deep chain: cycles are impossible, so the cap can
  // only be hit by a genuinely 64-long delegation chain, which is a governance structure nobody
  // can reason about. The assertion is that the constant has not been quietly lowered to something
  // an ordinary community would reach.
  assert.ok(MAX_DELEGATION_DEPTH >= 16, 'the delegation depth cap is low enough to drop real power')
})
