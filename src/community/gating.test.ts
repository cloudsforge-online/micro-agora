/**
 * Token-gated membership, re-evaluated.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE TEST THIS FILE EXISTS FOR IS `AN UNKNOWN HOLDING NEVER DEMOTES`.**
 *
 * `micro-indexer` has no balance route and no balances table — verified in `clients.test.ts` and
 * recorded in the README — so the oracle this job depends on frequently cannot answer. The only
 * safe reading of "cannot answer" is *no information*, and the failure a careless implementation
 * produces is not subtle: assume zero, and the first pass evicts every token-gated member of every
 * community on the platform.
 *
 * The other half is that the check must actually work when the oracle CAN answer. A guard that
 * never demoted anybody would pass the first test and be useless — 04-domain-model §9.2:
 * "membership that is never re-checked is not token-gating."
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { membersDueForRecheck, recheckMember } from './gating.ts'
import { findMembership, roleIn } from './communities.ts'
import { TOPICS } from './events.ts'
import {
  asTx,
  collector,
  fakeOracle,
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
let gated: Community

const OWNER = subject('owner')
const HOLDER = subject('holder')
const SELLER = subject('seller')
const MIN = 1_000n

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
  gated = await seedCommunity(sql, {
    kind: 'token_gated',
    ownerSubject: OWNER,
    gate: { chainId: 7411, contract: '0xabc', minHolding: MIN },
    gateGraceHours: 24,
  })
  await seedMember(sql, gated, HOLDER)
  await seedMember(sql, gated, SELLER)
})

async function recheck(
  who: string,
  balances: Record<string, bigint | undefined>,
  graceUntil: Date | null,
) {
  const { emit, events } = collector()
  const outcome = await sql.begin(async (tx) => ({
    value: await recheckMember(asTx(tx), emit, fakeOracle(balances), gated, who, graceUntil),
  }))
  return { check: outcome.value, events }
}

/* ------------------------------------------------------------------ unknown never demotes */

test('an unknown holding never demotes, and records no check', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // `undefined` in the fake means the oracle answered null — which is what the real one does for a
  // 404, a 500, a timeout, and for the route micro-indexer does not serve at all.
  //
  // Nothing is written, INCLUDING the check timestamp. Recording a check that did not happen would
  // push this member to the back of the `holdings_checked_at` queue and hide the fact that they
  // have not actually been verified.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const { check, events } = await recheck(SELLER, {}, null)
  assert.equal(check.outcome, 'unknown')
  assert.equal(check.demoted, false)
  assert.deepEqual(events, [])

  const membership = await findMembership(sql, gated.id, SELLER)
  assert.equal(membership?.status, 'active', 'an unknown holding evicted a member')
  assert.equal(membership?.holdingsCheckedAt, null, 'a check that did not happen was recorded')
  assert.equal(membership?.graceUntil, null)
})

test('an unknown holding does not demote even after the grace has expired', { skip }, async () => {
  // The dangerous case: a member already in grace, and the oracle goes dark. Assuming the worst
  // here is what turns an indexer outage into a mass eviction.
  const expired = new Date(Date.now() - 3_600_000)
  const { check } = await recheck(SELLER, {}, expired)
  assert.equal(check.outcome, 'unknown')
  assert.equal(check.demoted, false)
  assert.equal((await findMembership(sql, gated.id, SELLER))?.status, 'active')
})

/* ------------------------------------------------------------------ but the gate does work */

test('a member who holds enough is confirmed and their grace cleared', { skip }, async () => {
  const inGrace = new Date(Date.now() + 3_600_000)
  const { check } = await recheck(HOLDER, { [HOLDER]: MIN }, inGrace)
  assert.equal(check.outcome, 'holds')
  const membership = await findMembership(sql, gated.id, HOLDER)
  assert.ok(membership?.holdingsCheckedAt !== null)
  // A recovery is immediate and complete.
  assert.equal(membership?.graceUntil, null)
})

test('exactly the minimum is enough; one unit less is not', { skip }, async () => {
  assert.equal((await recheck(HOLDER, { [HOLDER]: MIN }, null)).check.outcome, 'holds')
  assert.equal((await recheck(SELLER, { [SELLER]: MIN - 1n }, null)).check.outcome, 'short')
})

test('a member found short starts a grace period rather than being demoted', { skip }, async () => {
  // Demoting on the first bad read would turn one indexer hiccup — or one member moving tokens
  // between their own wallets — into an eviction.
  const { check } = await recheck(SELLER, { [SELLER]: 0n }, null)
  assert.equal(check.outcome, 'short')
  assert.equal(check.demoted, false)
  const membership = await findMembership(sql, gated.id, SELLER)
  assert.equal(membership?.status, 'active')
  assert.ok(membership?.graceUntil !== null, 'no grace period was started')
  // 24 hours, from the community's own `gate_grace_hours`.
  const hours = (membership!.graceUntil!.getTime() - Date.now()) / 3_600_000
  assert.ok(hours > 23 && hours < 25, `grace was ${hours} hours`)
})

test('a member still short after their grace expires is demoted', { skip }, async () => {
  const expired = new Date(Date.now() - 60_000)
  const { check, events } = await recheck(SELLER, { [SELLER]: 0n }, expired)
  assert.equal(check.demoted, true)

  const membership = await findMembership(sql, gated.id, SELLER)
  // A status, never a DELETE: the row is the record that this subject WAS a member and why they
  // stopped being one.
  assert.equal(membership?.status, 'demoted')
  // And a demoted member has no role, so every authority check answers the same way.
  assert.equal(await roleIn(sql, gated.id, SELLER), null)

  assert.equal(events.length, 1)
  assert.equal(events[0]?.topic, TOPICS.memberDemoted)
  assert.equal(events[0]?.payload['reason'], 'token_holding_below_minimum')
  // Decimal strings — a holding is a uint256.
  assert.equal(events[0]?.payload['minHolding'], MIN.toString())
  assert.equal(events[0]?.payload['observed'], '0')
})

test('a member still short but inside their grace is not demoted', { skip }, async () => {
  const active = new Date(Date.now() + 3_600_000)
  const { check } = await recheck(SELLER, { [SELLER]: 0n }, active)
  assert.equal(check.demoted, false)
  assert.equal((await findMembership(sql, gated.id, SELLER))?.status, 'active')
  // The check is still recorded, so the member moves through the queue.
  assert.ok((await findMembership(sql, gated.id, SELLER))?.holdingsCheckedAt !== null)
})

test('a demoted member who buys back in is restored', { skip }, async () => {
  await recheck(SELLER, { [SELLER]: 0n }, new Date(Date.now() - 60_000))
  assert.equal((await findMembership(sql, gated.id, SELLER))?.status, 'demoted')

  const { check } = await recheck(SELLER, { [SELLER]: MIN }, null)
  assert.equal(check.outcome, 'holds')
  assert.equal((await findMembership(sql, gated.id, SELLER))?.status, 'active')
  assert.equal(await roleIn(sql, gated.id, SELLER), 'member')
})

test('an owner is never demoted by the gate', { skip }, async () => {
  // A community whose owner sold their tokens is a governance problem for the community; evicting
  // the only account that can administer it turns that into a problem nobody in the estate can
  // solve. 18-build-status.md §3.3g is the estate's record of what an unrecoverable role costs.
  const { check } = await recheck(OWNER, { [OWNER]: 0n }, new Date(Date.now() - 60_000))
  assert.equal(check.demoted, false)
  assert.equal((await findMembership(sql, gated.id, OWNER))?.status, 'active')
})

test('a huge holding is compared exactly', { skip }, async () => {
  const huge = 2n ** 100n
  const big = await seedCommunity(sql, {
    kind: 'token_gated',
    ownerSubject: OWNER,
    gate: { chainId: 7411, contract: '0xabc', minHolding: huge },
  })
  await seedMember(sql, big, HOLDER)
  const { emit } = collector()
  const outcome = await sql.begin(async (tx) => ({
    value: await recheckMember(asTx(tx), emit, fakeOracle({ [HOLDER]: huge - 1n }), big, HOLDER, null),
  }))
  // One unit short, above the double's precision. A `Number` comparison would call this equal.
  assert.equal(outcome.value.outcome, 'short')
})

/* ------------------------------------------------------------------ the queue */

test('the never-checked are re-checked first', { skip }, async () => {
  // A member granted access and never verified is the exact state 04-domain-model §9.2 says is not
  // token-gating.
  await sql`
    update memberships set holdings_checked_at = now() - interval '1 hour'
     where community_id = ${gated.id} and subject = ${HOLDER}
  `
  const due = await membersDueForRecheck(sql, 0, 10)
  const order = due.map((member) => member.subject)
  // `nulls first`: everybody never checked comes before anybody who has been. The owner is also
  // never-checked here, so the assertion is on the RELATIVE order rather than on position 0 —
  // asserting `due[0] === SELLER` would be asserting an ordering among the nulls that the query
  // does not promise and that a future index change could reverse.
  assert.ok(
    order.indexOf(SELLER) < order.indexOf(HOLDER),
    `a never-checked member was not ahead of a recently-checked one: ${order.join(', ')}`,
  )
})

test('only token_gated communities are re-checked', { skip }, async () => {
  const plain = await seedCommunity(sql, { ownerSubject: OWNER })
  await seedMember(sql, plain, HOLDER)
  const due = await membersDueForRecheck(sql, 0, 50)
  assert.ok(!due.some((member) => member.communityId === plain.id))
})

test('a member checked recently is not re-checked', { skip }, async () => {
  await sql`update memberships set holdings_checked_at = now() where community_id = ${gated.id}`
  assert.deepEqual([...(await membersDueForRecheck(sql, 6, 10))], [])
})

test('demoted members stay in the queue so they can be restored', { skip }, async () => {
  await sql`
    update memberships set status = 'demoted', holdings_checked_at = null
     where community_id = ${gated.id} and subject = ${SELLER}
  `
  const due = await membersDueForRecheck(sql, 6, 10)
  assert.ok(due.some((member) => member.subject === SELLER))
})

test('a community with no gate is a no-op rather than an error', { skip }, async () => {
  const plain = await seedCommunity(sql, { ownerSubject: OWNER })
  await seedMember(sql, plain, HOLDER)
  const { emit } = collector()
  const outcome = await sql.begin(async (tx) => ({
    value: await recheckMember(asTx(tx), emit, fakeOracle({}), plain, HOLDER, null),
  }))
  assert.equal(outcome.value.outcome, 'holds')
  assert.equal(outcome.value.demoted, false)
})
