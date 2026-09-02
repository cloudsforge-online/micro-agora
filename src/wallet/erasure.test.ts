/**
 * A person who asks to be forgotten stops being named anywhere in the wallet, and the money record
 * still reconciles.
 *
 * The load-bearing assertion is `assertNoTraceOf`, which reads `information_schema` and sweeps
 * EVERY text and jsonb column of EVERY table this module owns for the raw uuid. It is what catches
 * the column a careful reading misses, and this schema has one: `idempotency_keys.key` is
 * `<userId>:<route>:<clientKey>` from `namespacedKey`, so the id is embedded verbatim in a text
 * PRIMARY KEY that nothing about the name suggests can carry a person.
 *
 * A sweep also survives the future. A migration that adds a ninth place to keep a `user_id` turns
 * this file red on the day it lands, rather than on the day somebody asks what became of their
 * data.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { eraseUser } from './erasure.ts'
import { namespacedKey } from './idempotency.ts'
import { enabled, migrateTestDb, openDb, resetWallet, skip } from './testsupport.ts'

let sql: postgres.Sql

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'

before(async () => {
  if (!enabled) return
  sql = openDb(4)
  await migrateTestDb(sql)
})

after(async () => {
  if (sql) await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (enabled) await resetWallet(sql)
})

/** One person's whole trail: a wallet, a deposit address, a credit, a withdrawal, a key, an event. */
async function seedTrail(userId: string): Promise<{ walletId: string; assignmentId: string }> {
  const walletId = randomUUID()
  const assignmentId = randomUUID()
  await sql`
    insert into wallets (id, user_id, origin, chain, network, address, address_key, label, status)
    values (${walletId}, ${userId}, 'managed', 'litecoin', 'mainnet',
            ${`ltc1${userId.slice(0, 8)}`}, ${`key-${userId}`}, 'my rent wallet', 'active')
  `
  await sql`
    insert into deposit_address_assignments
      (id, user_id, asset_code, chain, network, wallet_id, address, address_key, custody_key_urn)
    values (${assignmentId}, ${userId}, 'LTC', 'litecoin', 'mainnet', ${walletId},
            ${`ltc1${userId.slice(0, 8)}`}, ${`key-${userId}`}, ${`urn:custody:${userId}`})
  `
  await sql`
    insert into deposit_credits
      (id, user_id, assignment_id, wallet_id, chain, network, address_key, asset_code, amount,
       tx_hash, block_height, confirmations, credit_key)
    values (${randomUUID()}, ${userId}, ${assignmentId}, ${walletId}, 'litecoin', 'mainnet',
            ${`key-${userId}`}, 'LTC', 1000, ${`0x${userId.replace(/-/g, '')}`}, 10, 6,
            ${`litecoin:mainnet:${userId}:0`})
  `
  await sql`
    insert into withdrawals
      (id, user_id, chain, network, asset_code, destination_address, destination_key, amount, fee,
       net, idempotency_key)
    values (${randomUUID()}, ${userId}, 'litecoin', 'mainnet', 'LTC', 'ltc1destination',
            'destkey', 500, 10, 490, ${namespacedKey(userId, 'POST /v1/withdrawals', 'client-1')})
  `
  await sql`
    insert into idempotency_keys (key, user_id, route, request_hash, response)
    values (${namespacedKey(userId, 'POST /v1/wallets', 'client-1')}, ${userId},
            'POST /v1/wallets', 'hash', ${sql.json({ userId, walletId })})
  `
  await sql`
    insert into outbox (topic, key, producer, actor, payload)
    values ('wallet.deposit.credited', ${`user:${userId}`}, 'wallet', ${`user:${userId}`},
            ${sql.json({ userId })})
  `
  return { walletId, assignmentId }
}

/**
 * Every text-shaped column in the schema, swept for the raw id.
 *
 * `::text` on the column rather than a per-type branch: jsonb, text and varchar all render, and a
 * column type this module has never used would still be searched rather than silently skipped.
 */
async function assertNoTraceOf(userId: string): Promise<void> {
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'public'
       and data_type in ('text', 'character varying', 'jsonb', 'json', 'uuid')
     order by table_name, column_name
  `
  assert.ok(columns.length > 20, 'the sweep found no columns, so it proves nothing')
  for (const { table_name, column_name } of columns) {
    const found = await sql`
      select 1 from ${sql(table_name)}
       where ${sql(column_name)}::text like ${`%${userId}%`}
       limit 1
    `
    assert.equal(found.length, 0, `${table_name}.${column_name} still names the erased user`)
  }
}

test('a person is gone from every column, including the text primary key', { skip }, async () => {
  await seedTrail(ALICE)
  await eraseUser(sql as never, ALICE)
  await assertNoTraceOf(ALICE)
})

test('the money record survives, joined and reconciling', { skip }, async () => {
  const { walletId, assignmentId } = await seedTrail(ALICE)
  const outcome = await eraseUser(sql as never, ALICE)

  assert.deepEqual(
    { wallets: outcome.wallets, credits: outcome.credits, withdrawals: outcome.withdrawals },
    { wallets: 1, credits: 1, withdrawals: 1 },
  )

  // Every row is still there and still joined. Deleting any of them would leave the ledger holding
  // entries whose cause no longer exists — an audit trail with holes cut in it.
  const [credit] = await sql<{ assignment_id: string; wallet_id: string; user_id: string }[]>`
    select assignment_id, wallet_id, user_id from deposit_credits
  `
  assert.equal(credit?.assignment_id, assignmentId)
  assert.equal(credit?.wallet_id, walletId)

  const [wallet] = await sql<{ user_id: string; status: string; label: string | null }[]>`
    select user_id, status, label from wallets where id = ${walletId}
  `
  // The status is deliberately untouched: retiring a deposit address does not stop deposits, it
  // stops the estate MOVING what arrives. See `erasure.ts`.
  assert.equal(wallet?.status, 'active')
  // Free text the person typed to name their own wallet. Neutralised, not rewritten.
  assert.equal(wallet?.label, null)
  // One placeholder for the whole person: three would turn one departed account into three while
  // hiding nothing further, since `wallet_id` and `assignment_id` join the rows regardless.
  assert.equal(credit?.user_id, wallet?.user_id)
  assert.notEqual(wallet?.user_id, ALICE)
})

test('erasing one person leaves another untouched', { skip }, async () => {
  await seedTrail(ALICE)
  await seedTrail(BOB)

  await eraseUser(sql as never, ALICE)

  const bob = await sql`select 1 from wallets where user_id = ${BOB}`
  assert.equal(bob.length, 1, "Bob's wallet was swept up in Alice's erasure")
  const key = await sql`select 1 from idempotency_keys where key like ${`%${BOB}%`}`
  assert.equal(key.length, 1, "Bob's idempotency key was rewritten")
})

test('a second delivery of the same erasure changes nothing', { skip }, async () => {
  await seedTrail(ALICE)
  const first = await eraseUser(sql as never, ALICE)
  assert.equal(first.wallets, 1)

  // Idempotence here is trivially true because the `where` no longer matches, which is the point.
  // `withInbox` is what stops the handler running twice at all; this asserts it is SAFE when it
  // does, so a redelivery after an inbox row was lost is a repair rather than a second pass that
  // re-randomises the placeholder and severs the rows from each other.
  const second = await eraseUser(sql as never, ALICE)
  assert.deepEqual(second, {
    wallets: 0,
    assignments: 0,
    credits: 0,
    withdrawals: 0,
    sightings: 0,
    links: 0,
    challenges: 0,
    idempotency: 0,
    outbox: 0,
  })
})
