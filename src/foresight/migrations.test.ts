/**
 * The migrator, exercised as a migrator: on an empty database, exactly as a deploy runs it.
 *
 * A schema created by the test suite instead would never prove the one-shot job works — and this
 * service's constraints only exist because that job ran. `micro-mint`'s CI makes the same point by
 * running `pnpm migrate` before `pnpm test`.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { migrate, type Sql } from '@cloudsforge/db'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts'
import { STAKE_ASSET_REGISTRY } from './stakeassets.ts'
import { enabled, openDb, skip } from './testsupport.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb(2)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

test('every version is unique and monotonic', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(new Set(versions).size, versions.length)
  assert.equal(SCHEMA_VERSION, Math.max(...versions))
  // A NEW service adopts nothing. A baseline that claimed a version already applied would be a lie
  // about exactly the guarantees `markets_unapproved_never_opens` exists to make.
  assert.equal(BASELINE_VERSION, 0)
})

test('the migrations are idempotent and reach the declared version', { skip }, async () => {
  const first = await migrate(sql as unknown as Sql, MIGRATIONS, { service: 'foresight-migrations-test' })
  assert.equal(first.nowAt, SCHEMA_VERSION)
  // Run again. `@cloudsforge/db` checksums each one, so this also proves nothing has been edited
  // after being applied — two databases would otherwise disagree about what "version 5" means.
  const second = await migrate(sql as unknown as Sql, MIGRATIONS, { service: 'foresight-migrations-test' })
  assert.equal(second.applied.length, 0)
  assert.equal(second.nowAt, SCHEMA_VERSION)
})

test('every table the harness truncates actually exists', { skip }, async () => {
  await migrate(sql as unknown as Sql, MIGRATIONS, { service: 'foresight-migrations-test' })
  const rows = await sql<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public'
  `
  const present = new Set(rows.map((row) => row.tablename))
  for (const table of TABLES) {
    assert.ok(present.has(table), `${table} is in TABLES but not in the schema`)
  }
  assert.ok(present.has('jobs'), 'the jobs table is missing; every lease in this service needs it')
})

/**
 * The constraints, listed by name.
 *
 * Not a substitute for the tests that FIRE them — those are in `markets.test.ts`, `mirror.test.ts`,
 * `deploy.test.ts` and `resolve.test.ts`. This is the cheap check that catches a migration edited
 * in a way that quietly dropped one, which is a failure the firing tests would only notice if
 * somebody happened to run them against a rebuilt database.
 */
test('the constraints this service depends on are all present', { skip }, async () => {
  await migrate(sql as unknown as Sql, MIGRATIONS, { service: 'foresight-migrations-test' })

  const checks = await sql<{ conname: string }[]>`
    select conname from pg_constraint where connamespace = 'public'::regnamespace
  `
  const names = new Set(checks.map((row) => row.conname))
  for (const required of [
    // The one the whole product rests on.
    'markets_unapproved_never_opens',
    'markets_open_has_contract',
    'markets_resolved_has_outcome',
    'markets_void_has_reason',
    'markets_broadcast_has_hash',
    'markets_signed_has_bytes',
    'markets_idea_fk',
    'ideas_decision_is_a_person',
    'ideas_model_has_provenance',
    'ideas_discard_has_reason',
    // Half a reference is a claim nothing backs — tessera's `objects_anchor_is_whole`, applied to
    // an image. `images.test.ts` is what FIRES these; this is the cheap check that catches a
    // migration edited in a way that quietly dropped one.
    'markets_image_is_whole',
    'markets_image_checksum_shape',
    'ideas_image_is_whole',
    'ideas_image_checksum_shape',
    'positions_amount_ck',
    'positions_orphan_has_time',
    'resolutions_broadcast_has_hash',
    'jobs_kind_key_uniq',
  ]) {
    assert.ok(names.has(required), `the constraint ${required} is missing`)
  }

  const indexes = await sql<{ indexname: string }[]>`
    select indexname from pg_indexes where schemaname = 'public'
  `
  const indexNames = new Set(indexes.map((row) => row.indexname))
  for (const required of [
    // The mirror's whole reorg story.
    'positions_source_uniq',
    // Settlement's invariant, twice: per deployer for the market creation, per chain for the oracle.
    'markets_deploy_in_flight_uniq',
    'resolutions_in_flight_uniq',
    'markets_deploy_tx_hash_uniq',
    'markets_contract_uniq',
    'resolutions_market_uniq',
    'fee_reports_source_uniq',
    'ideas_id_status_uniq',
  ]) {
    assert.ok(indexNames.has(required), `the index ${required} is missing`)
  }
})

test('the in-flight indexes are PARTIAL, or they would forbid history', { skip }, async () => {
  await migrate(sql as unknown as Sql, MIGRATIONS, { service: 'foresight-migrations-test' })
  const rows = await sql<{ indexname: string; indexdef: string }[]>`
    select indexname, indexdef from pg_indexes
     where schemaname = 'public'
       and indexname in ('markets_deploy_in_flight_uniq', 'resolutions_in_flight_uniq')
  `
  assert.equal(rows.length, 2)
  for (const row of rows) {
    // Without the WHERE these would be unique over ALL history, so a second market could never be
    // deployed from an address that had ever deployed one. The partiality is the point.
    assert.match(row.indexdef, / WHERE /, `${row.indexname} is not partial`)
    assert.match(row.indexdef, /building/, `${row.indexname} does not start at 'building'`)
  }
})

/**
 * The declared registry IS the seeded one — every column, both directions.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR (micro-org#291). `STAKE_ASSET_REGISTRY` is the only statement of "which assets
 * can be staked" that exists outside a running database, and a file restating a table is worth
 * nothing unless something compares them. This is that comparison, and it is deliberately made
 * against a database built by the REAL migrations on an empty schema rather than against a fixture:
 * the answer is the seed of migration 9 plus every UPDATE since, which is a fact only the migrator
 * can produce.
 *
 * BOTH DIRECTIONS AND EVERY COLUMN. A row seeded and not declared is a promise the copy will
 * under-state; a row declared and not seeded is a promise it will over-state, which is the whole of
 * #291 — micro-site read `ON_CHAIN_ASSETS` and offered eight chains where four can be staked.
 * `decimals` is compared because a registry that disagrees with `contracts-chain` sizes a stake
 * wrongly by a power of ten, and `blocked_reason` because that sentence is SERVED to the user.
 *
 * MUTATION: enable LTC in the declaration and delete migration 10, or add a `stakeable('SOL', …)`
 * row — this reddens naming the asset, and it is the only test that does.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('the declared stake registry IS the one the migrations seed', { skip }, async () => {
  await migrate(sql as unknown as Sql, MIGRATIONS, { service: 'foresight-migrations-test' })

  const rows = await sql<
    { asset_code: string; decimals: number; display_name: string; enabled: boolean; blocked_reason: string | null }[]
  >`
    select asset_code, decimals, display_name, enabled, blocked_reason
      from stake_assets order by asset_code
  `
  // Guards the whole comparison against passing on two empty sets, which is how a check like this
  // usually fails to fail.
  assert.ok(rows.length > 0, 'the migrations seeded no stake assets')

  const seeded = rows.map((row) => ({
    assetCode: row.asset_code,
    decimals: row.decimals,
    displayName: row.display_name,
    enabled: row.enabled,
    blockedReason: row.blocked_reason,
  }))
  const declared = [...STAKE_ASSET_REGISTRY]
    .map((asset) => ({ ...asset }))
    .sort((a, b) => (a.assetCode < b.assetCode ? -1 : 1))

  // Named before the deep comparison, because "which asset" is the sentence somebody needs and a
  // diff of five objects is not it.
  assert.deepEqual(
    seeded.map((a) => a.assetCode),
    declared.map((a) => a.assetCode),
    'stakeassets.ts and the migrations disagree about WHICH assets the registry holds',
  )
  assert.deepEqual(
    seeded.filter((a) => a.enabled).map((a) => a.assetCode),
    declared.filter((a) => a.enabled).map((a) => a.assetCode),
    'stakeassets.ts and the migrations disagree about which assets are ENABLED',
  )
  assert.deepEqual(seeded, declared)
})

test('amounts are numeric(78,0) — never a float, never text', { skip }, async () => {
  await migrate(sql as unknown as Sql, MIGRATIONS, { service: 'foresight-migrations-test' })
  const rows = await sql<{ table_name: string; column_name: string; data_type: string; numeric_precision: number }[]>`
    select table_name, column_name, data_type, numeric_precision
      from information_schema.columns
     where table_schema = 'public'
       and column_name in ('amount', 'amount_wei')
  `
  assert.ok(rows.length >= 2)
  for (const row of rows) {
    // 2^256 is 78 digits. A double loses the bottom of an 18-decimal amount, and TEXT means the
    // database cannot add them up — which is how a pool that does not balance goes unnoticed.
    assert.equal(row.data_type, 'numeric', `${row.table_name}.${row.column_name} is ${row.data_type}`)
    assert.equal(row.numeric_precision, 78)
  }
})
