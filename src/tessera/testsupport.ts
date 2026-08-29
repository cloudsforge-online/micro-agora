/**
 * The database harness and shared fixtures.
 *
 * **A database test runs only against a database whose name says it is a test database.** Not a
 * convenience: `resetTessera` truncates every table this service owns, and requiring "test" in the
 * name is the difference between a red build and an emptied world — this service holds the only
 * record of every parcel anyone has ever claimed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `skip`, NOT `return`. Six tests in this estate `return`ed when their preconditions were absent
 * and therefore PASSED, reporting green for work that never ran. Every database test in this
 * repository is declared `test(name, { skip }, fn)`, so an unconfigured database shows as SKIPPED
 * in the runner's summary and can never be mistaken for a pass.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import postgres from 'postgres'
import { migrate, networkSql, type NetworkSql, type Sql as DbSql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { MIGRATIONS, TABLES } from './migrations.ts'
import { registerServiceMetrics } from './server.ts'
import type { Db } from './outbox.ts'

export const ALICE = '11111111-1111-4111-8111-111111111111'
export const BOB = '22222222-2222-4222-8222-222222222222'
export const CAROL = '33333333-3333-4333-8333-333333333333'
export const ALICE_SUBJECT = `user:${ALICE}`
export const BOB_SUBJECT = `user:${BOB}`
export const CAROL_SUBJECT = `user:${CAROL}`

/**
 * The signing secret for `POST /v1/events` in tests. Long enough to pass `env.ts`'s 24-character
 * bar, so a test server is configured the way a real one is rather than through a loophole.
 */
export const TEST_EVENT_SECRET = 'e'.repeat(32)

const url = process.env['TESSERA_TEST_DATABASE_URL']

export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled
  ? false
  : 'set TESSERA_TEST_DATABASE_URL (the name must contain "test")'

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/** Bring the schema up. The REAL `MIGRATIONS`, so constraints cannot drift from what tests see. */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'tessera-test' })
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetTessera(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`)
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'tessera-test', sink: () => {} })
}

export function testMetrics(): Metrics {
  return registerServiceMetrics(new Metrics())
}

export function asDb(sql: postgres.Sql): Db {
  return sql as unknown as Db
}

/** A ward to hang everything else off. Returns its id. */
export async function seedWard(
  sql: postgres.Sql,
  slug = 'commons',
  archetype = 'ashfield',
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into wards (slug, name, archetype, ordinal, claimable_tiles)
    select ${slug}, ${slug}, ${archetype}, coalesce(max(ordinal) + 1, 0), 49152 from wards
    returning id
  `
  const row = rows[0]
  if (!row) throw new Error('the ward fixture did not insert')
  return row.id
}

export async function seedAccounts(sql: postgres.Sql, ...subjects: string[]): Promise<void> {
  for (const subject of subjects) {
    await sql`insert into accounts (subject) values (${subject}) on conflict do nothing`
  }
}

/** A fired object, content-addressed. `nth` varies the bytes so two fixtures do not collide. */
export async function seedObject(
  sql: postgres.Sql,
  author: string,
  nth = 1,
): Promise<string> {
  const checksum = `sha256:${String(nth).padStart(2, '0').repeat(32)}`
  const rows = await sql<{ id: string }[]>`
    insert into objects (author_subject, prompt, category, footprint, status, checksum, c2pa)
    values (${author}, 'a stool', 'seating', '1x1', 'fired', ${checksum}, true)
    returning id
  `
  const row = rows[0]
  if (!row) throw new Error('the object fixture did not insert')
  return row.id
}

/**
 * Strip line and block comments from TypeScript source, for the source-scanning assertions.
 *
 * Six guards in this estate have fired on their own prose; scanning raw source makes a rule that
 * punishes documenting the rule. This is the same stripping the estate CI's Rule 1 does, in TS,
 * taken from `aetherholm/src/testsupport.ts`.
 */
export function stripComments(source: string): string {
  let out = ''
  let inBlock = false
  for (const rawLine of source.split('\n')) {
    let line = rawLine
    let kept = ''
    while (line.length > 0) {
      if (inBlock) {
        const end = line.indexOf('*/')
        if (end === -1) {
          line = ''
          break
        }
        inBlock = false
        line = line.slice(end + 2)
        continue
      }
      const block = line.indexOf('/*')
      const lineComment = line.indexOf('//')
      if (lineComment !== -1 && (block === -1 || lineComment < block)) {
        kept += line.slice(0, lineComment)
        line = ''
        break
      }
      if (block !== -1) {
        kept += line.slice(0, block)
        line = line.slice(block + 2)
        inBlock = true
        continue
      }
      kept += line
      line = ''
    }
    out += `${kept}\n`
  }
  return out
}

/**
 * Strip quoted PROSE — single- and double-quoted string literals — leaving code and SQL.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WRITTEN BECAUSE A GUARD IN THIS REPOSITORY FIRED ON ITS OWN PROSE, AND WAS CAUGHT.
 *
 * `world.test.ts` asserts that claiming ground touches no money by scanning `world.ts` for the
 * vocabulary of a sale. Its first version failed — on this line, inside an error message:
 *
 *     'you hold as many parcels as your Deed Slots allow — Deed Slots are capped at 12, at any
 *      price (23-tessera.md §7.3)'
 *
 * A sentence QUOTING the rule, matched by the guard enforcing the rule. That is the same family
 * as the estate's reachability guard that counted an `import` as a reference, and it fails in the
 * dangerous direction as well as the annoying one: the obvious fix is to drop `price` from the
 * forbidden list, and then a `price` PARAMETER on `claimParcel` would sail through.
 *
 * Template literals are deliberately KEPT, because that is where SQL lives — a `price_wei` column
 * in a query is exactly what this must still catch.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function stripQuotedProse(source: string): string {
  return source.replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
}

/**
 * One handle, presented as the per-network selector `createServer` now takes.
 *
 * The suites run against a single test database, so mainnet is the only configured network — which
 * exercises the REFUSAL path for free: anything that asks this for testnet throws
 * `NetworkNotConfiguredError` rather than quietly reusing the handle it does have. That refusal is
 * the property the whole consolidation rests on; see micro-deploy `docs/network-consolidation.md`.
 */
export function singleNetworkSql(handle: unknown): NetworkSql {
  return networkSql({ mainnet: handle as DbSql })
}
