import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { checksumOf, type Migration } from '@cloudsforge/db'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { enabled, migrateTestDb, openDb, resetPricing, skip } from './testsupport.ts'

const sql = MIGRATIONS.map((m) => m.up).join('\n')

/** One migration by version, by lookup rather than by index, so a reorder cannot silently re-point. */
const migration = (version: number): Migration => {
  const found = MIGRATIONS.find((m) => m.version === version)
  if (!found) throw new Error(`no migration at version ${version}`)
  return found
}

/**
 * The DDL with `--` comments removed.
 *
 * Assertions that a migration does *not* contain something must run against the statements, not
 * the prose: these migrations explain their reasoning at length, and a comment about why a column
 * is not a float contains the word "float".
 */
const statementsOf = (text: string): string => text.replace(/--[^\n]*/g, '')

test('versions are unique and ascending', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(new Set(versions).size, versions.length, 'a duplicate version makes the run refuse')
})

test('SCHEMA_VERSION is the highest migration, so a new one raises the boot assertion', () => {
  assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
})

test('a new service baselines nothing', () => {
  assert.equal(BASELINE_VERSION, 0, 'a non-zero baseline records migrations as applied without running them')
})

test('no migration interpolates anything into its SQL', () => {
  // The `up` strings are template literals. A stray substitution would ship DDL nobody wrote — and
  // because the checksum is taken over the substituted text, two environments could disagree about
  // what a migration even says.
  for (const m of MIGRATIONS) {
    assert.doesNotMatch(m.up, /\$\{/, `${m.name} interpolates into its SQL`)
  }
})

test('checksums are whitespace-insensitive at the edges, and nowhere else', () => {
  for (const m of MIGRATIONS) {
    assert.equal(checksumOf(m), checksumOf({ ...m, up: `\n  ${m.up}  \n` }), `${m.name} is whitespace-sensitive`)
    assert.notEqual(checksumOf(m), checksumOf({ ...m, up: `${m.up}\nselect 1;` }))
  }
})

test('every table the service reads or writes is created', () => {
  for (const table of [
    'jobs',
    'outbox',
    'event_subscriptions',
    'outbox_deliveries',
    'inbox',
    'price_quotes',
    'administered_prices',
    'price_history',
  ]) {
    assert.match(sql, new RegExp(`create table if not exists ${table}\\b`), `${table} is missing`)
  }
})

test('THE FIX: the quote lives in a table, and its rate column is numeric', () => {
  // The whole service in one assertion. A Map cannot be shared between replicas; a table is.
  assert.match(statementsOf(sql), /create table if not exists price_quotes[\s\S]*?usd_scaled\s+numeric\(78,\s*0\)/)
})

test('a quote cannot be zero or negative, whatever writes it', () => {
  // In the constraint rather than the application, so a psql session obeys it too.
  assert.match(statementsOf(sql), /usd_scaled is null or usd_scaled > 0/)
  assert.match(statementsOf(sql), /administered_prices[\s\S]*?check \(usd_scaled > 0\)/)
})

test('the source column is a closed set, so a third kind cannot appear by accident', () => {
  // Both tables that carry a source: price_quotes and price_history. administered_prices has no
  // such column, because everything in it is administered by definition.
  const checks = statementsOf(sql).match(/check \(source in \('market', 'administered'\)\)/g) ?? []
  assert.equal(checks.length, 2, 'a source column is unconstrained')
})

test('EMBER is seeded, and the seed records that nobody has decided the price yet', () => {
  assert.match(sql, /insert into administered_prices \(asset, usd_scaled, set_by, set_by_handle\)/)

  // **Version 4 still reads 250000, and that is not a stale assertion.** A released migration is
  // immutable — `@cloudsforge/db` checksums it and refuses a database whose recorded text differs —
  // so the seed's own literal can never change, whatever the estate later decides EMBER is worth.
  // 0.25 came from PAY_EMBER_USD and was never a market price; version 5 lowers it to 0.0001, and
  // the test below is where that number is pinned. What this assertion still protects is the form:
  // an integer literal rather than an expression Postgres would evaluate in floating point.
  assert.match(sql, /values \('EMBER', 250000, null, null\)/)

  // And the two nulls, which version 5's predicate reads as "still a default". If the seed ever
  // started claiming a setter, that predicate would stop matching a fresh database.
  assert.match(migration(4).up, /values \('EMBER', 250000, null, null\)/)
})

test('version 5 lowers the seed as an integer literal, never an expression', () => {
  // 100 is 0.0001 x RATE_SCALE. `250000 / 2500` would be the same number on paper and a numeric
  // division in the database, which is the class of thing this service exists to keep off the
  // money path.
  assert.match(statementsOf(migration(5).up), /set usd_scaled = 100\b/)
  assert.doesNotMatch(statementsOf(migration(5).up), /usd_scaled\s*=\s*[\d_]+\s*[-+*/]/)
})

/* ---------------------------------------------------------------- against a real Postgres */

let db: postgres.Sql

before(async () => {
  if (!enabled) return
  db = openDb(2)
  await migrateTestDb(db)
})

after(async () => {
  if (!enabled) return
  // Put the schema's seeded state back for whichever file runs next.
  await resetPricing(db)
  await db.end({ timeout: 5 })
})

/**
 * Replay version 5 against a row of a given shape and report what it did to both tables.
 *
 * The migration's own DDL, executed — not a regex over it. The property under test is a WHERE
 * clause, and a text assertion would pass just as happily if that clause read `set_by is not null`.
 */
async function replayVersion5(row: {
  readonly asset: string
  readonly setBy: string | null
  readonly setByHandle: string | null
}): Promise<{
  readonly usdScaled: string
  readonly quoteUsdScaled: string
  /** `updated_at` before and after the replay. Equal means the row was not written at all. */
  readonly updatedAtBefore: number
  readonly updatedAtAfter: number
}> {
  await db.unsafe('truncate price_quotes, administered_prices restart identity cascade')
  const seeded = await db<{ updated_at: Date }[]>`
    insert into administered_prices (asset, usd_scaled, set_by, set_by_handle)
    values (${row.asset}, 250000, ${row.setBy}, ${row.setByHandle})
    returning updated_at
  `
  await db`
    insert into price_quotes (asset, usd_scaled, source, source_count, quoted_at)
    select asset, usd_scaled, 'administered', 0, updated_at
      from administered_prices where asset = ${row.asset}
  `
  await db.unsafe(migration(5).up)

  const prices = await db<{ usd_scaled: string; updated_at: Date }[]>`
    select usd_scaled, updated_at from administered_prices where asset = ${row.asset}
  `
  const quotes = await db<{ usd_scaled: string }[]>`
    select usd_scaled from price_quotes where asset = ${row.asset}
  `
  return {
    usdScaled: prices[0]!.usd_scaled,
    quoteUsdScaled: quotes[0]!.usd_scaled,
    updatedAtBefore: seeded[0]!.updated_at.getTime(),
    updatedAtAfter: prices[0]!.updated_at.getTime(),
  }
}

test('version 5 lowers a seed nobody has decided, in the quote row as well as the price', { skip }, async () => {
  const after5 = await replayVersion5({ asset: 'EMBER', setBy: null, setByHandle: null })
  assert.equal(after5.usdScaled, '100', 'the seeded 0.25 survived the migration')

  // Both rows, because `price_quotes` is what a rate lookup reads. A migration that moved only
  // `administered_prices` would leave GET /rates serving 0.25 until the refresh job's repair pass.
  assert.equal(after5.quoteUsdScaled, '100', 'the rate board would still have served 0.25')
})

test('VERSION 5 IS A NO-OP ON A PRICE AN OPERATOR SET — which is why mainnet is safe', { skip }, async () => {
  // The mainnet row's shape, measured 2026-08-10T19:13:30Z: set_by and set_by_handle both filled by
  // `PUT /admin/prices/:asset`. A migration that clobbered this would overwrite a decision somebody
  // took and be checksummed as correct for ever after.
  const after5 = await replayVersion5({ asset: 'EMBER', setBy: 'user:2f0c', setByHandle: 'ops-jane' })

  assert.equal(after5.usdScaled, '250000', "an operator's price was overwritten by a migration")
  assert.equal(after5.quoteUsdScaled, '250000', 'the quote row was overwritten under the operator')

  // Untouched, not merely unchanged in value: `updated_at` is set to now() by any write, so an
  // equal timestamp is the proof no row was rewritten. A migration that wrote 250000 back over
  // 250000 would pass the two assertions above and still move the audit trail under an operator.
  assert.equal(after5.updatedAtAfter, after5.updatedAtBefore, 'the row was rewritten')
})

test('version 5 touches EMBER and no other administered asset', { skip }, async () => {
  // `administered_prices` holds one asset today, and the predicate names it. If a second asset is
  // ever administered, it must not be dragged to Hearth's price by a migration written before it
  // existed.
  const after5 = await replayVersion5({ asset: 'SHARD', setBy: null, setByHandle: null })
  assert.equal(after5.usdScaled, '250000', 'a non-EMBER administered price was lowered')
  assert.equal(after5.quoteUsdScaled, '250000')
})
