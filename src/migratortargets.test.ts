/**
 * Five modules, five migration ledgers, and the assertion that keeps them apart.
 *
 * `@cloudsforge/db` records applied migrations in a table called `schema_migrations`. The name is a
 * literal in that package — `LEDGER_SQL` — and `MigrateOptions` offers no way to change it, so two
 * modules migrating ONE database write into ONE ledger keyed by `version`. Every module numbers its
 * migrations from 1.
 *
 * The failure that produces is not a crash and would not be found by reading a log. Whichever
 * module runs first records versions 1..N; the second finds those rows, treats its own 1..N as
 * applied, creates nothing, and the migrator exits 0. Nothing is red until the NEXT release's
 * `assertSchemaAtLeast` refuses to serve — naming a version number, in a service, hours later.
 *
 * Nor does anything else catch it: the advisory lock is derived from the SERVICE name and the five
 * names differ, so the runs do not even serialise against each other.
 *
 * So it is refused before a statement is issued, and this file is why that refusal is trustworthy.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AND IT HOLDS THE FIVE-WAY TABLE-COLLISION MATRIX, COMPUTED RATHER THAN REMEMBERED.**
 *
 * The matrix is derived from the migration DDL itself — every `create table` in every module's
 * `MIGRATIONS`, with SQL comments stripped — and not from the hand-maintained `TABLES` exports.
 * That distinction earned its place immediately: agora's and devplatform's `TABLES` deliberately
 * OMIT `jobs`, because their `testsupport.ts` appends it to the truncate list separately. A matrix
 * built from those lists would have reported `jobs` as shared by three modules when it is shared by
 * all five — under-reporting the sharpest collision in the process, and under-reporting is
 * indistinguishable from passing.
 *
 * The two lists are reconciled against each other below, so `TABLES` cannot quietly fall behind
 * the DDL either.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { lockKeyFor } from '@cloudsforge/db'
import { addresses, assertDistinct, type Target } from './migratortargets.ts'
import { MIGRATIONS, TABLES } from './migrations.ts'
import {
  MIGRATIONS as DEVPLATFORM_MIGRATIONS,
  TABLES as DEVPLATFORM_TABLES,
} from './devplatform/migrations.ts'
import { MIGRATIONS as POLICY_MIGRATIONS, TABLES as POLICY_TABLES } from './policy/migrations.ts'
import { MIGRATIONS as PRICING_MIGRATIONS, TABLES as PRICING_TABLES } from './pricing/migrations.ts'
import { MIGRATIONS as STUDIO_MIGRATIONS, TABLES as STUDIO_TABLES } from './studio/migrations.ts'

/** A DSN assembled rather than written, so this file holds no string shaped like a credential. */
function dsn(host: string, port: number | '', database: string): string {
  return ['postgres://u:p@', host, port === '' ? '' : `:${port}`, '/', database].join('')
}

function target(module: string, network: string, url: string): Target {
  return { module, network, url, migrations: [], baselineVersion: 0 }
}

describe('what a DSN addresses', () => {
  it('is the host, the port and the database, and nothing that identifies the caller', () => {
    // Two DSNs differing only in the user still address ONE ledger. Comparing whole strings would
    // call them distinct and let the collision through.
    assert.equal(
      addresses('postgres://alice:x@db.internal:5432/policy'),
      addresses('postgres://bob:y@db.internal:5432/policy'),
    )
  })

  it('defaults the port, because an omitted 5432 is still 5432', () => {
    assert.equal(addresses(dsn('db.internal', '', 'agora')), addresses(dsn('db.internal', 5432, 'agora')))
  })

  it('is case-insensitive on the host and the database name', () => {
    assert.equal(addresses(dsn('DB.Internal', 5432, 'Agora')), addresses(dsn('db.internal', 5432, 'agora')))
  })

  it('keeps two different databases on one server apart', () => {
    assert.notEqual(addresses(dsn('db.internal', 5432, 'agora')), addresses(dsn('db.internal', 5432, 'studio')))
  })

  it('never returns the credential half of the string', () => {
    // This value is put in an error message, and an error message reaches a log. The password may
    // not be in it — never redacted, simply never assembled into it.
    const address = addresses('postgres://someuser:somepassword@db.internal:5432/studio')
    assert.ok(!address.includes('somepassword'))
    assert.ok(!address.includes('someuser'))
    assert.ok(!address.includes('@'))
  })

  it('degrades to "cannot prove" rather than refusing a DSN shape postgres.js accepts', () => {
    // A key/value connection string is not a URL. Refusing it here would break a deployment that
    // works; returning '' means this check abstains and the migration itself still fails loudly.
    assert.equal(addresses('host=db.internal dbname=agora'), '')
  })
})

describe('the migrator refuses two modules in one database', () => {
  it('accepts the arrangement the estate actually runs', () => {
    // Ten databases, five modules, one migrator process.
    assert.doesNotThrow(() =>
      assertDistinct([
        target('agora', 'primary', dsn('db.internal', 5432, 'agora')),
        target('agora', 'testnet', dsn('db.internal', 5432, 'agora_testnet')),
        target('devplatform', 'primary', dsn('db.internal', 5432, 'devplatform')),
        target('devplatform', 'testnet', dsn('db.internal', 5432, 'devplatform_testnet')),
        target('policy', 'primary', dsn('db.internal', 5432, 'policy')),
        target('policy', 'testnet', dsn('db.internal', 5432, 'policy_testnet')),
        target('pricing', 'primary', dsn('db.internal', 5432, 'pricing')),
        target('pricing', 'testnet', dsn('db.internal', 5432, 'pricing_testnet')),
        target('studio', 'primary', dsn('db.internal', 5432, 'studio')),
        target('studio', 'testnet', dsn('db.internal', 5432, 'studio_testnet')),
      ]),
    )
  })

  it('REFUSES the FIFTH module pointed at a database four others already keep apart', () => {
    // The failure that only appears once there are five: the first four pairs are distinct, so a
    // check that stopped at the first duplicate-free pass would let this through.
    assert.throws(
      () =>
        assertDistinct([
          target('agora', 'primary', dsn('db.internal', 5432, 'agora')),
          target('devplatform', 'primary', dsn('db.internal', 5432, 'devplatform')),
          target('policy', 'primary', dsn('db.internal', 5432, 'policy')),
          target('pricing', 'primary', dsn('db.internal', 5432, 'pricing')),
          target('studio', 'primary', dsn('db.internal', 5432, 'pricing')),
        ]),
      /pricing\/primary and studio\/primary both point at/,
    )
  })

  it('REFUSES it through a spelling difference, too', () => {
    assert.throws(
      () =>
        assertDistinct([
          target('agora', 'primary', dsn('db.internal', '', 'platform')),
          target('studio', 'primary', dsn('DB.internal', 5432, 'PLATFORM')),
        ]),
      /both point at/,
    )
  })

  it("REFUSES one module's two networks pointing at one database", () => {
    // A different fault and also fatal: migrating one database twice under one ledger is at best a
    // no-op nobody asked for, and at worst two networks' rows in one place — which is the failure
    // the whole network split exists to prevent.
    assert.throws(
      () =>
        assertDistinct([
          target('pricing', 'primary', dsn('db.internal', 5432, 'pricing')),
          target('pricing', 'testnet', dsn('db.internal', 5432, 'pricing')),
        ]),
      /both point at/,
    )
  })

  it('names both offenders and the database, and no credential', () => {
    let message = ''
    try {
      assertDistinct([
        target('agora', 'primary', 'postgres://u:hunter2@db.internal:5432/platform'),
        target('policy', 'testnet', 'postgres://u:hunter2@db.internal:5432/platform'),
      ])
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    assert.match(message, /agora\/primary/)
    assert.match(message, /policy\/testnet/)
    assert.match(message, /db\.internal:5432\/platform/)
    assert.ok(!message.includes('hunter2'), 'the refusal must never carry the password')
  })
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FIVE-WAY MATRIX
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** Every table a module's own DDL creates. Comments stripped first — see the note below. */
function createdTables(migrations: readonly { readonly up: string }[]): ReadonlySet<string> {
  const found = new Set<string>()
  for (const migration of migrations) {
    // `--` comments are removed BEFORE matching, and that is not tidiness. devplatform's migration 5
    // carries the line `-- readable version parses and then fails at CREATE TABLE with 0A000`, and
    // a scan that read it found a table called `with`. A false table name in the matrix is a false
    // collision or a false absence, and neither is detectable from the assertion that follows.
    const sql = migration.up.replace(/--[^\n]*/g, '')
    for (const hit of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      found.add((hit[1] as string).toLowerCase())
    }
  }
  return found
}

const LEDGERS = [
  ['agora', MIGRATIONS, TABLES],
  ['devplatform', DEVPLATFORM_MIGRATIONS, DEVPLATFORM_TABLES],
  ['policy', POLICY_MIGRATIONS, POLICY_TABLES],
  ['pricing', PRICING_MIGRATIONS, PRICING_TABLES],
  ['studio', STUDIO_MIGRATIONS, STUDIO_TABLES],
] as const

describe('the five ledgers cannot interfere even once the databases are right', () => {
  it('every module takes a different advisory lock', () => {
    // Distinct locks are only SAFE because the databases are distinct — see `assertDistinct`. They
    // are asserted here because equal ones would be the other failure: one module's migration
    // waiting on another's, forever, in a job with no output.
    const keys = LEDGERS.map(([name]) => String(lockKeyFor(name)))
    assert.equal(new Set(keys).size, LEDGERS.length, `two modules share an advisory lock: ${keys.join(', ')}`)
  })

  it("no module applies another module's migrations", () => {
    // The ledgers are per database; the MIGRATION SETS are per module. If any two were ever the
    // same array, `assertDistinct` would pass and both databases would get both schemas.
    for (let i = 0; i < LEDGERS.length; i += 1) {
      for (let j = i + 1; j < LEDGERS.length; j += 1) {
        const [leftName, left] = LEDGERS[i]!
        const [rightName, right] = LEDGERS[j]!
        assert.notEqual(left, right, `${leftName} and ${rightName} share one MIGRATIONS array`)
        assert.notDeepEqual(
          left.map((m) => `${m.version}:${m.name}`),
          right.map((m) => `${m.version}:${m.name}`),
        )
      }
    }
  })

  it('and the detector is looking at real migration sets', () => {
    // Empty arrays would satisfy every assertion in this file.
    for (const [name, migrations] of LEDGERS) {
      assert.ok(migrations.length > 0, `${name} declares migrations`)
      // EVERY module numbers from 1, which is exactly why one ledger could not hold two of them.
      assert.equal(Math.min(...migrations.map((m) => m.version)), 1, `${name} numbers from 1`)
    }
    assert.deepEqual(
      LEDGERS.map(([name, migrations]) => `${name}:${migrations.length}`),
      ['agora:12', 'devplatform:10', 'policy:8', 'pricing:5', 'studio:11'],
      'the migration counts changed. That is ordinary; update the list. It is pinned so that an ' +
        'import resolving to the WRONG module — five near-identical file names, four of them one ' +
        'directory apart — is a red test rather than a matrix computed twice over one schema.',
    )
  })

  it('and `TABLES` has not fallen behind the DDL that creates them', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════════════════════
     * THE RECONCILIATION, AND WHY THE MATRIX BELOW IS BUILT FROM THE DDL INSTEAD.
     *
     * `TABLES` is hand-maintained and is the truncate list. agora's and devplatform's OMIT
     * `jobs` on purpose — their `testsupport.ts` appends it to the truncate string separately —
     * while policy's, pricing's and studio's include it. The two conventions are why the matrix
     * above is computed from the DDL: a matrix built from `TABLES` would have reported `jobs` as
     * shared by THREE modules when it is shared by all five.
     *
     * What must hold, per module, is that `TABLES` is a subset of what the DDL creates and that
     * the ONLY name the DDL has and `TABLES` does not is `jobs`. The per-module expectation is
     * spelled out rather than derived, so a module that quietly started omitting a second table
     * is a red test.
     *
     * A `TABLES` entry the DDL never creates is a table the harness tries to truncate and cannot,
     * which is a red suite. A DDL table missing from `TABLES` is the silent one: rows survive
     * between test files and a case passes because of something the previous file left behind.
     * ════════════════════════════════════════════════════════════════════════════════════════
     */
    const OMITS_JOBS: ReadonlySet<string> = new Set(['agora', 'devplatform'])
    for (const [name, migrations, tables] of LEDGERS) {
      const created = createdTables(migrations)
      for (const table of tables) {
        assert.ok(created.has(table), `${name} lists ${table} in TABLES but no migration creates it`)
      }
      const missing = [...created].filter((t) => !(tables as readonly string[]).includes(t)).sort()
      assert.deepEqual(
        missing,
        OMITS_JOBS.has(name) ? ['jobs'] : [],
        `${name}'s DDL creates tables TABLES does not list. Every one of them survives a reset ` +
          'between test files, so a case can pass on rows the previous file left behind.',
      )
      // And every module truncates `jobs` one way or the other, or a lease leaks between files.
      assert.ok(
        (tables as readonly string[]).includes('jobs') || OMITS_JOBS.has(name),
        `${name} neither lists jobs in TABLES nor is recorded as appending it in testsupport`,
      )
      assert.equal(new Set(tables).size, tables.length, `${name} lists a table twice`)
    }
  })

  it('THE MATRIX: `inbox` and `jobs` exist in ALL FIVE schemas, and three more in four of them', () => {
    /*
     * ════════════════════════════════════════════════════════════════════════════════════════
     * THE FULL FIVE-WAY MATRIX, COMPUTED. This is the reason `RouteSpec.sql` exists.
     *
     * At MIGRATE time a shared database is two `create table inbox` racing, and then — because the
     * ledger already records the first module's version — the later modules' tables never created
     * at all, with a migrator that exits 0.
     *
     * At RUNTIME it is worse, because these five names have the SAME COLUMNS in every module that
     * owns them. They are the estate's outbox/inbox pattern and `@cloudsforge/jobs`' schema, so a
     * handler handed another module's handle does not get a 500 from a column that is not there:
     *
     *   `insert into inbox (topic, event_id) …`   SUCCEEDS, and dedupes an event that database has
     *                                             never seen. The redelivery that should have
     *                                             carried the erasure is then swallowed for ever.
     *   `insert into jobs …`                      SUCCEEDS, into a queue no runner of that kind is
     *                                             watching. The job is never claimed and never
     *                                             found.
     *   `insert into outbox …`                    SUCCEEDS, into another module's relay, which
     *                                             signs and delivers it under the wrong producer.
     *
     * Nothing errors, nothing logs, nothing alerts. That is why `merged.test.ts` checks the ROWS in
     * each database rather than a 202, and why the selector is stamped over each mounted table
     * rather than remembered per handler.
     * ════════════════════════════════════════════════════════════════════════════════════════
     */
    const owners = new Map<string, string[]>()
    for (const [name, migrations] of LEDGERS) {
      for (const table of createdTables(migrations)) {
        owners.set(table, [...(owners.get(table) ?? []), name])
      }
    }

    const byAll = [...owners.entries()]
      .filter(([, names]) => names.length === LEDGERS.length)
      .map(([table]) => table)
      .sort()
    assert.deepEqual(
      byAll,
      ['inbox', 'jobs'],
      'the measured five-way overlap changed. These have the SAME columns in every module, so a ' +
        'handler handed the wrong handle writes a row that is valid and wrong.',
    )

    const shared = [...owners.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([table, names]) => `${table}: ${names.sort().join(', ')}`)
      .sort()
    assert.deepEqual(shared, [
      'event_subscriptions: agora, devplatform, pricing, studio',
      'inbox: agora, devplatform, policy, pricing, studio',
      'jobs: agora, devplatform, policy, pricing, studio',
      'outbox: agora, devplatform, pricing, studio',
      'outbox_deliveries: agora, devplatform, pricing, studio',
    ])

    // policy is the one module with no outbox family at all — it produces no events, and
    // `@cloudsforge/contracts-events` registers no `policy.*` topic. Stated as a measurement so
    // that a policy that STARTED producing would show up here, in a matrix, rather than as a
    // surprise in a relay.
    const policyTables = createdTables(POLICY_MIGRATIONS)
    for (const table of ['outbox', 'outbox_deliveries', 'event_subscriptions']) {
      assert.ok(!policyTables.has(table), `policy now owns ${table}; the matrix above is stale`)
    }
  })

  it('and every schema has a name of its own that no other module could answer for', () => {
    /*
     * The other half of the matrix, and the property `merged.test.ts` drives over a socket: each
     * module owns at least one table NO other module has, so a route handed the wrong handle 500s
     * loudly instead of succeeding quietly. These are the names those cases read through.
     */
    const sets = new Map<string, ReadonlySet<string>>(
      LEDGERS.map(([name, migrations]) => [name as string, createdTables(migrations)]),
    )
    const witnesses = {
      agora: 'voices',
      devplatform: 'api_keys',
      policy: 'policy_decisions',
      pricing: 'price_quotes',
      studio: 'brand_kits',
    } as const
    for (const [owner, table] of Object.entries(witnesses) as ReadonlyArray<[string, string]>) {
      assert.ok(sets.get(owner)?.has(table), `${owner} no longer owns ${table}`)
      for (const [other, tables] of sets) {
        if (other === owner) continue
        assert.ok(!tables.has(table), `${other} now owns ${table}, so it is no longer a witness`)
      }
    }
  })
})
