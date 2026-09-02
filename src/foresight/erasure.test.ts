/**
 * Right to erasure — micro-org#534, foresight's half.
 *
 * Two things are pinned here and the second is the reason migration 14 exists.
 *
 * `tracesOf` sweeps EVERY base table in the schema for the raw uuid, driven off
 * `information_schema` rather than a remembered list, so it fails on the column a future migration
 * adds and nobody wires into `eraseSubject`.
 *
 * And `custodial_stakes_money_is_immutable` still refuses everything it refused before. The
 * migration permits exactly one transition; a test that only proved the erasure works would not
 * notice if it had permitted more.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { eraseSubject } from './erasure.ts'
import type { Db, Tx } from './outbox.ts'
import {
  enabled,
  migrateTestDb,
  openDb,
  openDirect,
  resetForesight,
  seedDraft,
  skip,
} from './testsupport.ts'

let sql: postgres.Sql

const SUBJECT = 'user:55555555-5555-4555-8555-555555555555'
const BARE = '55555555-5555-4555-8555-555555555555'

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetForesight(sql)
})

async function tracesOf(needle: string): Promise<string[]> {
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name
  `
  const found: string[] = []
  for (const { table_name: table } of tables) {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from ${sql(table)} t where t::text like ${`%${needle}%`}
    `
    if ((rows[0]?.n ?? 0) > 0) found.push(table)
  }
  return found
}

/**
 * A market and one custodial stake on it, which is the only row in this schema naming a person.
 *
 * `seedDraft` and not a hand-written INSERT: `markets` has NOT NULL columns a test has no business
 * knowing about — `question_hash` among them — and the first version of this fixture omitted one
 * and failed with `23502` rather than with anything about erasure. The suite already owns a helper
 * that builds a valid market; using it means a column added tomorrow does not break this file.
 */
async function seedStake(subject: string): Promise<string> {
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  const id = market.id
  await sql`
    insert into custodial_stakes
      (market_id, subject, outcome, stake_asset_code, stake_amount, pool_amount,
       stake_rate_usd_scaled, pool_rate_usd_scaled)
    values (${id}, ${subject}, 1, 'EMBER', 1000, 1000, 1, 1)
  `
  return id
}

test('the stake is RETAINED and only its subject changes', { skip }, async () => {
  await seedStake(SUBJECT)
  assert.ok((await tracesOf(BARE)).length > 0, 'the fixture must actually hold the subject')

  const outcome = await (sql as unknown as Db).begin(async (tx) =>
    eraseSubject(tx as unknown as Tx, SUBJECT),
  )
  assert.equal(outcome.stakes, 1)

  const kept = await sql<{ subject: string; stake_amount: string; pool_amount: string }[]>`
    select subject, stake_amount, pool_amount from custodial_stakes
  `
  assert.equal(kept.length, 1, 'the row survives — a refund is paid from it')
  assert.match(kept[0]!.subject, /^erased:/, 'and the person is gone from it')
  assert.equal(String(kept[0]!.stake_amount), '1000', 'the money is untouched')
  assert.equal(String(kept[0]!.pool_amount), '1000')
  assert.deepEqual(await tracesOf(BARE), [], 'nothing in the schema still names the subject')
})

test('the money is still immutable, which migration 14 did NOT relax', { skip }, async () => {
  await seedStake(SUBJECT)
  await assert.rejects(
    sql`update custodial_stakes set stake_amount = 999 where subject = ${SUBJECT}`,
    /a recorded stake is immutable/,
  )
})

test('a subject may only become an erased placeholder, and never move off one', { skip }, async () => {
  await seedStake(SUBJECT)
  await assert.rejects(
    sql`update custodial_stakes set subject = 'user:66666666-6666-4666-8666-666666666666'
         where subject = ${SUBJECT}`,
    /may only be repointed onto an erased: placeholder/,
    'a stake cannot be re-attributed to another person',
  )

  await (sql as unknown as Db).begin(async (tx) => eraseSubject(tx as unknown as Tx, SUBJECT))
  const erased = await sql<{ subject: string }[]>`select subject from custodial_stakes`
  await assert.rejects(
    sql`update custodial_stakes set subject = ${SUBJECT} where subject = ${erased[0]!.subject}`,
    /may only be repointed onto an erased: placeholder/,
    'and an erased stake cannot be re-attributed to anybody',
  )
})

test('a second pass is a no-op, which is what makes a replay safe', { skip }, async () => {
  await seedStake(SUBJECT)
  await (sql as unknown as Db).begin(async (tx) => eraseSubject(tx as unknown as Tx, SUBJECT))
  const second = await (sql as unknown as Db).begin(async (tx) =>
    eraseSubject(tx as unknown as Tx, SUBJECT),
  )
  assert.equal(second.stakes, 0)
  assert.equal(second.outbox, 0)
})
