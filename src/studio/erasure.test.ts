/**
 * Right to erasure — micro-org#534, studio's half.
 *
 * The load-bearing case is `tracesOf`: a sweep of EVERY base table in the schema for the raw
 * subject, driven off `information_schema` rather than a hand-written list. A per-table assertion
 * proves only the tables somebody remembered; this one fails on the column a future migration adds
 * and nobody wires into `eraseSubject`. It is the case that caught `reward_grants.idempotency_key`
 * in worlds a day before this file was written, and the reason that file was worth copying the
 * shape of.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { eraseSubject } from './erasure.ts'
import type { Db, Tx } from './outbox.ts'
import { enabled, migrateTestDb, openDb, resetStudio, skip } from './testsupport.ts'

let sql: postgres.Sql

const OWNER = 'user:33333333-3333-4333-8333-333333333333'
const BARE = '33333333-3333-4333-8333-333333333333'
const OTHER = 'user:44444444-4444-4444-8444-444444444444'

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
  await resetStudio(sql)
})

/**
 * Every base table still containing the subject anywhere in any column.
 *
 * `t::text` casts the whole row — jsonb included — so this finds the id in a payload as readily as
 * in a text column, and the table list comes from the catalogue so a table added tomorrow is swept
 * without anybody remembering to add it here.
 */
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

async function seed(owner: string): Promise<void> {
  const kit = await sql<{ id: string }[]>`
    insert into brand_kits (owner_subject, name, accent) values (${owner}, 'Kit', '#aabbcc')
    returning id
  `
  await sql`
    insert into generation_jobs (brand_kit_id, owner_subject, kind, width, height, format, prompt)
    values (${kit[0]!.id}, ${owner}, 'mark', 64, 64, 'png', 'a prompt this person wrote')
  `
  await sql`
    insert into credit_accounts (owner_subject, cap_usd_micros) values (${owner}, 5000000)
  `
  await sql`
    insert into outbox (topic, key, producer, actor, payload)
    values ('studio.asset.generated', ${`asset:${owner}`}, 'studio', ${owner},
            ${sql.json({ ownerSubject: owner })})
  `
}

test('nothing in the schema still names the subject afterwards', { skip }, async () => {
  await seed(OWNER)
  assert.ok((await tracesOf(BARE)).length > 0, 'the fixture must actually hold the subject')

  const outcome = await (sql as unknown as Db).begin(async (tx) =>
    eraseSubject(tx as unknown as Tx, OWNER),
  )

  assert.ok(outcome.brandKits > 0, 'the brand kit is gone')
  assert.ok(outcome.creditAccounts > 0, 'the spending cap is gone')
  assert.deepEqual(
    await tracesOf(BARE),
    [],
    'a table still names the erased subject — wire it into eraseSubject',
  )
})

test('it erases the subject it names and nobody else', { skip }, async () => {
  await seed(OWNER)
  await seed(OTHER)

  await (sql as unknown as Db).begin(async (tx) => eraseSubject(tx as unknown as Tx, OWNER))

  const survivors = await sql<{ n: number }[]>`
    select count(*)::int as n from brand_kits where owner_subject = ${OTHER}
  `
  assert.equal(survivors[0]?.n, 1, 'the other owner keeps their brand kit')
})

test('a second pass over the same subject is a no-op, which is what makes a replay safe', { skip }, async () => {
  await seed(OWNER)
  await (sql as unknown as Db).begin(async (tx) => eraseSubject(tx as unknown as Tx, OWNER))
  const second = await (sql as unknown as Db).begin(async (tx) =>
    eraseSubject(tx as unknown as Tx, OWNER),
  )
  assert.equal(second.brandKits, 0)
  assert.equal(second.creditAccounts, 0)
  assert.equal(second.outbox, 0)
})
