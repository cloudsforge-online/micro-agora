/**
 * Shared setup for the database tests, and the fake-source harness.
 *
 * **A database test runs only against a database whose name says it is a test database.** That is
 * not a convenience: `resetPricing` truncates every table in the schema, and requiring "test" in
 * the name is the difference between a red build and an emptied environment.
 *
 * **No test in this repository touches a live exchange.** `fixedSource` and `failingSource` below
 * are the whole transport for every oracle test: a suite that reached CoinGecko would be a suite
 * that fails when CoinGecko rate-limits it, that cannot reproduce a divergence, and that cannot
 * test the fail-closed staleness rule at all because it has no control over the price it is given.
 *
 * Not a test file itself — it is excluded from the build and contains no `test()` call.
 */

import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import type { AssetCode } from '@cloudsforge/contracts-chain'
import { MIGRATIONS, TABLES } from './migrations.ts'
import type { PriceSource, SourceQuotes } from './sources.ts'

const url = process.env['PRICING_TEST_DATABASE_URL']

/** Both halves are required: a URL, and a URL that names a test database. */
export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set PRICING_TEST_DATABASE_URL (name must contain "test")'

/**
 * The truncate list, DERIVED from the schema's own `TABLES` rather than written twice.
 *
 * Wave M5a exported `TABLES` from `migrations.ts` so the merged process could compute its
 * five-way table-collision matrix. Two hand-maintained copies of one list is how a table added
 * in a migration stops being truncated between cases, which reads as a flake.
 */
const ALL_TABLES = TABLES.join(', ')

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the CHECK constraints drift away from the tests that are supposed to prove they hold.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'pricing-test' })
}

/**
 * Empty every table, then put back what the migrations seed.
 *
 * The EMBER seed is part of the schema, not part of any one test's fixture: a suite that truncated
 * it away would be testing a database shape that no deployment ever has.
 *
 * **100, because that is where a migrated database ends up.** Version 4 inserts 250000 and version
 * 5 lowers it to 100 wherever set_by is still null, which every fresh database is; restoring 250000
 * here would hand the suite a starting state no deployment has had since version 5 shipped.
 * `migrations.test.ts` runs version 5's real DDL against both starting rows, so the two values
 * cannot drift apart silently.
 */
export async function resetPricing(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${ALL_TABLES} restart identity cascade`)
  await sql`
    insert into administered_prices (asset, usd_scaled, set_by, set_by_handle)
    values ('EMBER', 100, null, null)
    on conflict (asset) do nothing
  `
  await sql`
    insert into price_quotes (asset, usd_scaled, source, source_count, quoted_at)
    select 'EMBER', usd_scaled, 'administered', 0, updated_at from administered_prices
     where asset = 'EMBER'
    on conflict (asset) do nothing
  `
}

/* ------------------------------------------------------------------ the fake-source harness */

/** A source that always answers with the same decimal strings. */
export function fixedSource(name: string, quotes: SourceQuotes): PriceSource {
  return { name, fetch: async () => ({ ...quotes }) }
}

/** A source that always throws, so `Promise.allSettled` has a rejection to handle. */
export function failingSource(name: string, message = 'connection refused'): PriceSource {
  return {
    name,
    fetch: async () => {
      throw new Error(message)
    },
  }
}

/**
 * Four sources quoting one asset at four given prices — the shape of nearly every oracle test.
 *
 * Prices are decimal strings, never numbers, for the same reason the real sources yield strings:
 * a test fixture written as `64231.5` would be a float in the test even though it is not one in
 * the service, and the test would then be unable to detect the bug it exists to catch.
 */
export function sourcesQuoting(asset: AssetCode, prices: readonly string[]): PriceSource[] {
  return prices.map((price, index) => fixedSource(`source-${index}`, { [asset]: price }))
}
