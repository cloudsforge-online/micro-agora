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
import { createHash, randomUUID } from 'node:crypto'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { eraseUser } from './erasure.ts'
import { namespacedKey } from './idempotency.ts'
import { enabled, migrateTestDb, openDb, resetWallet, skip } from './testsupport.ts'

let sql: postgres.Sql

/**
 * `ltc`, not `litecoin`. `wallets_chain_ck` (migration 10's `CHAIN_CK_V10`) admits the SHORT chain
 * ids this module uses on the wire — `ember`, `eth`, `btc`, `sol`, `xrp`, `ltc` — and micro-custody,
 * one call away, spells the same chain `litecoin`. A fixture that guesses the wrong side of that
 * boundary fails with a 23514 that says nothing about which spelling was wanted.
 */
const CHAIN = 'ltc'

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

/**
 * One person's whole trail: a wallet, a deposit address, a credit, a withdrawal, a key, an event.
 *
 * ── THE FIXTURE MUST NOT INVENT A DEFECT, WHICH IS EASIER TO DO THAN IT SOUNDS ────────────────
 *
 * Every value here is derived through `tag` — a hash of the user id, standing in for the chain
 * data a real row holds — rather than from the uuid itself. That is not cosmetic. The
 * catalogue sweep below fails on ANY column containing the raw id, so a fixture that wrote
 * `address_key = key-<userId>` would fail on a column the erasure deliberately leaves alone, and
 * the failure would look like a hole in the handler rather than a hole in the fixture.
 *
 * The real values are never derived from a person: `address_key` is the COMPARISON form of the
 * address (`addresses.ts` — lower-cased for EVM and Ember, byte-identical elsewhere), `tx_hash` is
 * whatever the chain produced, `credit_key` is `<chain>:<network>:<txHash>:<logIndex>`, and
 * `custody_key_urn` names a custody key. The two values that DO embed the person are
 * `idempotency_keys.key` and `withdrawals.idempotency_key`, both built by `namespacedKey`, and
 * those are seeded with the real thing because the erasure must rewrite them.
 *
 * `custody_key_urn` is also not optional here even though the column is nullable:
 * `wallets_custody_urn_ck` is an EQUALITY between two booleans — `(origin = 'managed') =
 * (custody_key_urn is not null)` — so a managed wallet without one fails a CHECK rather than a NOT
 * NULL, which points at the wrong column.
 */
async function seedTrail(userId: string): Promise<{ walletId: string; assignmentId: string }> {
  const walletId = randomUUID()
  const assignmentId = randomUUID()
  // Stands in for chain data. Distinct per person, and containing no part of the uuid.
  const tag = createHash('sha256').update(userId).digest('hex').slice(0, 32)
  await sql`
    insert into wallets
      (id, user_id, origin, chain, network, address, address_key, label, status, custody_key_urn)
    values (${walletId}, ${userId}, 'managed', ${CHAIN}, 'mainnet',
            ${`ltc1${tag}`}, ${`ltc1${tag}`}, 'my rent wallet', 'active',
            ${`urn:cf:custody:ltc:${tag}`})
  `
  await sql`
    insert into deposit_address_assignments
      (id, user_id, asset_code, chain, network, wallet_id, address, address_key, custody_key_urn)
    values (${assignmentId}, ${userId}, 'LTC', ${CHAIN}, 'mainnet', ${walletId},
            ${`ltc1${tag}`}, ${`ltc1${tag}`}, ${`urn:cf:custody:ltc:${tag}`})
  `
  await sql`
    insert into deposit_credits
      (id, user_id, assignment_id, wallet_id, chain, network, address_key, asset_code, amount,
       tx_hash, block_height, confirmations, credit_key)
    values (${randomUUID()}, ${userId}, ${assignmentId}, ${walletId}, ${CHAIN}, 'mainnet',
            ${`ltc1${tag}`}, 'LTC', 1000, ${`0x${tag}`}, 10, 6,
            ${`ltc:mainnet:0x${tag}:0`})
  `
  await sql`
    insert into withdrawals
      (id, user_id, chain, network, asset_code, destination_address, destination_key, amount, fee,
       net, idempotency_key)
    values (${randomUUID()}, ${userId}, ${CHAIN}, 'mainnet', 'LTC', 'ltc1destination',
            'destkey', 500, 10, 490, ${namespacedKey(userId, 'POST /v1/withdrawals', 'client-1')})
  `
  await sql`
    insert into idempotency_keys (key, user_id, route, request_hash, response)
    values (${namespacedKey(userId, 'POST /v1/wallets', 'client-1')}, ${userId},
            'POST /v1/wallets', 'hash', ${sql.json({ userId, walletId })})
  `
  // A SECOND wallet, `external` — the person's own self-custody address, linked by a signed
  // statement. Separate from the managed one above because `wallets_custody_urn_ck` is an equality:
  // an external wallet must have NO custody urn, exactly as a managed one must have one.
  const externalId = randomUUID()
  await sql`
    insert into wallets (id, user_id, origin, chain, network, address, address_key, status)
    values (${externalId}, ${userId}, 'external', ${CHAIN}, 'mainnet',
            ${`ltc1ext${tag}`}, ${`ltc1ext${tag}`}, 'active')
  `
  // The nonce is RANDOM, exactly as `links.ts`'s `newNonce()` makes it — 16 random bytes, never
  // derived from the person. Writing a fixture nonce that embedded the id would have been a fixture
  // inventing a defect: the sweep below would fail on a column the erasure deliberately keeps,
  // because it is the anti-replay record rather than a fact about anybody.
  const nonce = randomUUID().replace(/-/g, '')
  await sql`
    insert into link_challenges (nonce, wallet_id, user_id, scheme, message, domain, uri, expires_at)
    values (${nonce}, ${externalId}, ${userId}, 'eip4361',
            ${`cloudsforge.online wants you to sign in with your account ${userId}`},
            'cloudsforge.online', 'https://cloudsforge.online', now() + interval '1 hour')
  `
  await sql`
    insert into external_wallet_links (wallet_id, user_id, scheme, challenge_nonce, signature, verified_at)
    values (${externalId}, ${userId}, 'eip4361', ${nonce}, '0xdeadbeef', now())
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

test('the self-custody proof is neutralised, and the link survives', { skip }, async () => {
  await seedTrail(ALICE)
  const outcome = await eraseUser(sql as never, ALICE)
  assert.deepEqual({ links: outcome.links, challenges: outcome.challenges }, { links: 1, challenges: 1 })

  // The link stays: `external_wallet_authorisations` cascades from it and a withdrawal may name it.
  // What goes is the PROOF — a value produced by the person's own private key binding them to a
  // statement, which is an identifying artefact in a way the row's other columns are not.
  const [link] = await sql<{ signature: string | null; verified_at: Date | null }[]>`
    select signature, verified_at from external_wallet_links
  `
  assert.equal(link?.signature, null)
  assert.ok(link?.verified_at, 'the verification timestamp went with the signature')

  // A SIWE statement names the address, the domain and the intent verbatim. The nonce and the
  // timestamps stay, because they are the anti-replay record rather than a fact about a person.
  const [challenge] = await sql<{ message: string; nonce: string }[]>`select message, nonce from link_challenges`
  assert.equal(challenge?.message, '')
  assert.equal(challenge?.nonce.length, 32, 'the anti-replay nonce was swept away with the message')
})

test('the money record survives, joined and reconciling', { skip }, async () => {
  const { walletId, assignmentId } = await seedTrail(ALICE)
  const outcome = await eraseUser(sql as never, ALICE)

  assert.deepEqual(
    { wallets: outcome.wallets, credits: outcome.credits, withdrawals: outcome.withdrawals },
    { wallets: 2, credits: 1, withdrawals: 1 },
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

  // TWO: `seedTrail` gives each person a managed wallet and an external one.
  const bob = await sql`select 1 from wallets where user_id = ${BOB}`
  assert.equal(bob.length, 2, "Bob's wallets were swept up in Alice's erasure")
  const key = await sql`select 1 from idempotency_keys where key like ${`%${BOB}%`}`
  assert.equal(key.length, 1, "Bob's idempotency key was rewritten")
})

test('a second delivery of the same erasure changes nothing', { skip }, async () => {
  await seedTrail(ALICE)
  const first = await eraseUser(sql as never, ALICE)
  assert.equal(first.wallets, 2, 'the managed wallet and the external one')

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
