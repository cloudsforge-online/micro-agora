/**
 * The schema, asserted by enumeration rather than by memory.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE TEST THIS FILE EXISTS FOR IS `NO COLUMN IN THIS SCHEMA IS A BALANCE`.**
 *
 * It reads `information_schema.columns` and fails on anything that looks like a store of value.
 * A comment saying "this service holds no money" is a promise nobody checks; a query over every
 * column in the database is one that fails the day somebody adds `treasury_accounts.balance`
 * because it seemed convenient.
 *
 * The two exceptions are named individually, with the reason each is a *description* of an amount
 * rather than a *store* of one — and naming them individually is deliberate, so that a third
 * cannot be added without editing this list and thinking about it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts'
import { migrateTestDb, openDb, skip } from './testsupport.ts'

let sql: postgres.Sql

before(async () => {
  if (!skip) {
    sql = openDb(2)
    await migrateTestDb(sql)
  }
})

after(async () => {
  if (!skip) await sql.end({ timeout: 5 })
})

/* ------------------------------------------------------------------ no money here */

/**
 * The columns that carry an amount, and why each is a description rather than a store.
 *
 * `proposals.spend_amount`   What the community VOTED to spend. It is the mandate, written before
 *                            the money moves and never changed after; the movement itself is a
 *                            `micro-ledger` entry named by `executions.ledger_entry_id`. Deleting
 *                            this column would leave an execution nobody could audit.
 *
 * `communities.gate_min_holding` The token-gate threshold. Not money at all — it is a number this
 *                            service COMPARES an indexer's answer against, and it holds nothing.
 *
 * `votes.weight`             Voting power, which is a token balance in one model. It is a snapshot
 *                            used for arithmetic, never spendable, and never decremented — the
 *                            `votes_immutable` trigger refuses any UPDATE that touches it.
 *
 * `proposals.quorum`         A floor on participation, compared against the summed weight. It is
 *                            numeric(78,0) rather than bigint so the comparison is between things
 *                            of the same size; it holds nothing.
 */
const AMOUNT_COLUMNS_WITH_REASONS: Readonly<Record<string, string>> = {
  'proposals.spend_amount': 'the mandate a community voted for; the movement is a ledger entry',
  'communities.gate_min_holding': 'a threshold this service compares against; it holds nothing',
  'votes.weight': 'voting power, immutable and never spendable',
  'proposals.quorum': 'a floor on participation, compared against a sum; it holds nothing',
}

test('no column in this schema is a balance', { skip }, async () => {
  const rows = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
    select table_name, column_name, data_type
      from information_schema.columns
     where table_schema = 'public'
     order by table_name, column_name
  `
  assert.ok(rows.length > 40, 'the schema was not read at all — this test would pass vacuously')

  // Numeric types only. A `*_checked_at` timestamp matches the name heuristic and stores no value,
  // and a heuristic that flagged it would be one people learn to work around by renaming columns.
  const NUMERIC_TYPES = new Set([
    'numeric',
    'integer',
    'bigint',
    'smallint',
    'real',
    'double precision',
    'money',
  ])
  const suspicious = rows
    .filter((row) => NUMERIC_TYPES.has(row.data_type))
    .filter((row) => /balance|amount|holding|weight|total|credit|debit|funds|value/i.test(row.column_name))
    .map((row) => `${row.table_name}.${row.column_name}`)
    .filter((name) => !(name in AMOUNT_COLUMNS_WITH_REASONS))

  assert.deepEqual(
    suspicious,
    [],
    `these columns look like stores of value, and this service holds no money:\n  ${suspicious.join('\n  ')}\n` +
      'A treasury is a micro-ledger account (AD-15). If one of these is genuinely a description ' +
      'rather than a store, add it to AMOUNT_COLUMNS_WITH_REASONS with the reason.',
  )
})

test('no exemption is stale', { skip }, async () => {
  // An exemption for a column that no longer exists is a claim nobody is checking, and it hides
  // the day that column comes back meaning something else.
  const rows = await sql<{ name: string }[]>`
    select table_name || '.' || column_name as name
      from information_schema.columns where table_schema = 'public'
  `
  const present = new Set(rows.map((row) => row.name))
  for (const name of Object.keys(AMOUNT_COLUMNS_WITH_REASONS)) {
    assert.ok(present.has(name), `${name} is exempted and does not exist`)
  }
})

test('every amount column is numeric(78,0) — never a float, never an integer', { skip }, async () => {
  const rows = await sql<
    { name: string; data_type: string; numeric_precision: number | null; numeric_scale: number | null }[]
  >`
    select table_name || '.' || column_name as name, data_type, numeric_precision, numeric_scale
      from information_schema.columns
     where table_schema = 'public'
       and table_name || '.' || column_name in ('proposals.spend_amount','communities.gate_min_holding','votes.weight','proposals.quorum')
  `
  assert.equal(rows.length, 4)
  for (const row of rows) {
    // 78 digits holds any uint256 (max ~1.16e77). Scale 0 because these are smallest units and a
    // fractional smallest unit is not a thing.
    assert.equal(row.data_type, 'numeric', `${row.name} is ${row.data_type}`)
    assert.equal(row.numeric_precision, 78, `${row.name} cannot hold a uint256`)
    assert.equal(row.numeric_scale, 0, `${row.name} admits a fraction of a smallest unit`)
  }
})

test('quorum is numeric(78,0) and threshold_bps is an integer', { skip }, async () => {
  // quorum is numeric rather than bigint because it is compared against the summed vote weight,
  // and a token-weighted weight is a uint256. A bigint quorum tops out at 2^63-1, so a community
  // holding 10^24 smallest units of its own token could not express a quorum its members could
  // reach — the comparison would be between things of different sizes.
  const rows = await sql<{ column_name: string; data_type: string; numeric_precision: number | null }[]>`
    select column_name, data_type, numeric_precision from information_schema.columns
     where table_schema = 'public' and table_name = 'proposals'
       and column_name in ('quorum','threshold_bps')
     order by column_name
  `
  assert.deepEqual(
    rows.map((row) => `${row.column_name}:${row.data_type}`),
    ['quorum:numeric', 'threshold_bps:integer'],
  )
  assert.equal(rows[0]?.numeric_precision, 78)
})

/* ------------------------------------------------------------------ the objects that matter */

test('the constraints and triggers this service exists for are present', { skip }, async () => {
  const constraints = await sql<{ conname: string }[]>`
    select conname from pg_constraint where connamespace = 'public'::regnamespace
  `
  const names = new Set(constraints.map((row) => row.conname))
  for (const required of [
    // One member, one counted vote.
    'votes_proposal_subject_uniq',
    // Exactly once.
    'executions_proposal_uniq',
    'executions_idempotency_key_uniq',
    // A timelock that expires before voting closes is not a timelock.
    'proposals_timelock_after_close',
    'proposals_spend_has_timelock',
    // No cycle, degenerate case.
    'delegations_not_self',
    // One membership per subject per community.
    'memberships_subject_uniq',
    // Integer arithmetic, bounded.
    'proposals_quorum_positive',
    'proposals_threshold_bps_ck',
    'votes_weight_positive',
  ]) {
    assert.ok(names.has(required), `${required} is missing — the invariant it carries is unenforced`)
  }

  const triggers = await sql<{ tgname: string }[]>`
    select tgname from pg_trigger where not tgisinternal
  `
  const tgnames = new Set(triggers.map((row) => row.tgname))
  for (const required of [
    'delegations_no_cycle',
    'executions_respect_timelock',
    'executions_spend_names_entry',
    'executions_append_only',
    'votes_within_window',
    'votes_immutable',
    'treasury_accounts_subject',
  ]) {
    assert.ok(tgnames.has(required), `trigger ${required} is missing`)
  }
})

test('executions_spend_names_entry is DEFERRED, not immediate', { skip }, async () => {
  // The whole ordering argument in `executions.ts` depends on this. An immediate version would
  // reject the legal write and the executor would have to call the ledger BEFORE inserting the
  // row — which is the ordering that leaves a posting with no execution when the timelock refuses.
  const rows = await sql<{ tgdeferrable: boolean; tginitdeferred: boolean }[]>`
    select tgdeferrable, tginitdeferred from pg_trigger where tgname = 'executions_spend_names_entry'
  `
  assert.equal(rows[0]?.tgdeferrable, true)
  assert.equal(rows[0]?.tginitdeferred, true)
})

test('the delegation cycle trigger takes an advisory lock', { skip }, async () => {
  // Read out of the function body, because "two concurrent inserts cannot close a loop" is proven
  // behaviourally in delegations.test.ts and this is the line that makes it true. If somebody
  // removes the lock, that test becomes flaky rather than red — which is the worst outcome — so
  // the mechanism is asserted directly as well.
  const rows = await sql<{ prosrc: string }[]>`
    select prosrc from pg_proc where proname = 'community_refuse_delegation_cycle'
  `
  assert.match(rows[0]?.prosrc ?? '', /pg_advisory_xact_lock/)
  assert.match(rows[0]?.prosrc ?? '', /with recursive/)
})

test('treasury_subject is a GENERATED column and cannot be written', { skip }, async () => {
  const rows = await sql<{ is_generated: string; generation_expression: string | null }[]>`
    select is_generated, generation_expression from information_schema.columns
     where table_schema = 'public' and table_name = 'communities' and column_name = 'treasury_subject'
  `
  assert.equal(rows[0]?.is_generated, 'ALWAYS')
  assert.match(rows[0]?.generation_expression ?? '', /community:/)

  // And the database refuses an attempt to set it, which is the property the generated column buys
  // over a CHECK: there is no code path that can write it at all.
  await assert.rejects(
    () => sql`
      insert into communities (slug, name, kind, owner_subject, join_policy, governance_model,
                               treasury_subject)
      values ('forged-treasury', 'Forged', 'guild', 'user:x', 'open', 'one_member_one_vote',
              'community:somebody-elses')
    `,
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, '428C9')
      return true
    },
  )
})

test('a treasury account may not name another community subject', { skip }, async () => {
  const created = await sql<{ id: string; treasury_subject: string }[]>`
    insert into communities (slug, name, kind, owner_subject, join_policy, governance_model)
    values (${`t-${Date.now()}`}, 'T', 'guild', 'user:x', 'open', 'one_member_one_vote')
    returning id, treasury_subject
  `
  const community = created[0]!
  await assert.rejects(
    () => sql`
      insert into treasury_accounts (community_id, asset_code, ledger_subject)
      values (${community.id}, 'EMBER', 'community:somebody-elses')
    `,
    /must name ledger subject/,
  )
  // The right one is accepted.
  await sql`
    insert into treasury_accounts (community_id, asset_code, ledger_subject)
    values (${community.id}, 'EMBER', ${community.treasury_subject})
  `
})

/* ------------------------------------------------------------------ housekeeping */

test('SCHEMA_VERSION is derived from the migrations', { skip: false }, () => {
  // Written down rather than derived is how a service ends up running happily against a schema
  // missing the CHECK it depends on.
  const highest = MIGRATIONS.reduce((n, m) => Math.max(n, m.version), 0)
  assert.equal(SCHEMA_VERSION, highest)
})

test('migration versions are unique and contiguous', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.equal(new Set(versions).size, versions.length, 'two migrations share a version')
  assert.deepEqual([...versions].sort((a, b) => a - b), versions, 'migrations are out of order')
  for (let i = 0; i < versions.length; i += 1) {
    assert.equal(versions[i], i + 1, 'migration versions must be contiguous from 1')
  }
})

test('TABLES lists every table this service owns, and nothing else', { skip }, async () => {
  const rows = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  `
  const actual = new Set(rows.map((row) => row.table_name))
  // `jobs` is the runtime package's and `schema_migrations` is @cloudsforge/db's; neither belongs
  // to TABLES, and the truncate list adds `jobs` explicitly.
  actual.delete('jobs')
  actual.delete('schema_migrations')

  assert.deepEqual([...actual].sort(), [...TABLES].sort())
})

test('the migrations are idempotent', { skip }, async () => {
  // Run twice against a database that already has them. `migrate` should observe an empty pending
  // set rather than re-running anything.
  await migrateTestDb(sql)
  await migrateTestDb(sql)
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from schema_migrations`
  assert.equal(rows[0]?.n, MIGRATIONS.length)
})
