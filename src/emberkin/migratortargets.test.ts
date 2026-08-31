/**
 * Two modules, two migration ledgers, and the assertion that keeps them apart.
 *
 * `@cloudsforge/db` records applied migrations in a table called `schema_migrations`. The name is a
 * literal in that package — `LEDGER_SQL` — and `MigrateOptions` offers no way to change it, so two
 * modules migrating ONE database write into ONE ledger keyed by `version`. Both modules number
 * their migrations from 1.
 *
 * The failure that produces is not a crash and would not be found by reading a log. Whichever
 * module runs first records versions 1..N; the second finds those rows, treats its own 1..N as
 * applied, creates nothing, and the migrator exits 0. Nothing is red until the NEXT release's
 * `assertSchemaAtLeast` refuses to serve — naming a version number, in a service, hours later.
 *
 * Nor does anything else catch it: the advisory lock is derived from the SERVICE name and the two
 * names differ, so the two runs do not even serialise against each other.
 *
 * So it is refused before a statement is issued, and this file is why that refusal is trustworthy.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lockKeyFor } from '@cloudsforge/db';
import { addresses, assertDistinct, type Target } from '../migratortargets.ts';
import { MIGRATIONS, TABLES } from './migrations.ts';
import { MIGRATIONS as AETHERHOLM_MIGRATIONS, TABLES as AETHERHOLM_TABLES } from './aetherholm/migrations.ts';
import { MIGRATIONS as NDA_MIGRATIONS, TABLES as NDA_TABLES } from './nda/migrations.ts';

/** A DSN assembled rather than written, so this file holds no string shaped like a credential. */
function dsn(host: string, port: number | '', database: string): string {
  return ['postgres://u:p@', host, port === '' ? '' : `:${port}`, '/', database].join('');
}

function target(module: string, network: string, url: string): Target {
  return { module, network, url, migrations: [], baselineVersion: 0 };
}

describe('what a DSN addresses', () => {
  it('is the host, the port and the database, and nothing that identifies the caller', () => {
    // Two DSNs differing only in the user still address ONE ledger. Comparing whole strings would
    // call them distinct and let the collision through.
    assert.equal(
      addresses('postgres://alice:x@db.internal:5432/aetherholm'),
      addresses('postgres://bob:y@db.internal:5432/aetherholm'),
    );
  });

  it('defaults the port, because an omitted 5432 is still 5432', () => {
    assert.equal(addresses(dsn('db.internal', '', 'emberkin')), addresses(dsn('db.internal', 5432, 'emberkin')));
  });

  it('is case-insensitive on the host and the database name', () => {
    assert.equal(addresses(dsn('DB.Internal', 5432, 'Emberkin')), addresses(dsn('db.internal', 5432, 'emberkin')));
  });

  it('keeps two different databases on one server apart', () => {
    assert.notEqual(
      addresses(dsn('db.internal', 5432, 'emberkin')),
      addresses(dsn('db.internal', 5432, 'aetherholm')),
    );
  });

  it('never returns the credential half of the string', () => {
    // This value is put in an error message, and an error message reaches a log. The password may
    // not be in it — never redacted, simply never assembled into it.
    const address = addresses('postgres://someuser:somepassword@db.internal:5432/aetherholm');
    assert.ok(!address.includes('somepassword'));
    assert.ok(!address.includes('someuser'));
    assert.ok(!address.includes('@'));
  });

  it('degrades to "cannot prove" rather than refusing a DSN shape postgres.js accepts', () => {
    // A key/value connection string is not a URL. Refusing it here would break a deployment that
    // works; returning '' means this check abstains and the migration itself still fails loudly.
    assert.equal(addresses('host=db.internal dbname=emberkin'), '');
  });
});

describe('the migrator refuses two modules in one database', () => {
  it('accepts the arrangement the estate actually runs', () => {
    // Six databases, three modules, one migrator process. The estate's own values:
    // `deploy/k8s/estate/mainnet/50-deployments.yaml` gives the emberkin pod all six DSNs.
    assert.doesNotThrow(() =>
      assertDistinct([
        target('emberkin', 'primary', dsn('db.internal', 5432, 'emberkin')),
        target('emberkin', 'testnet', dsn('db.internal', 5432, 'emberkin_testnet')),
        target('aetherholm', 'primary', dsn('db.internal', 5432, 'aetherholm')),
        target('aetherholm', 'testnet', dsn('db.internal', 5432, 'aetherholm_testnet')),
        target('nda', 'primary', dsn('db.internal', 5432, 'nda')),
        target('nda', 'testnet', dsn('db.internal', 5432, 'nda_testnet')),
      ]),
    );
  });

  it('REFUSES a THIRD module pointed at a database two others already keep apart', () => {
    // The failure that only appears once there are three: the first pair is distinct, so a check
    // that stopped at the first duplicate-free pass would let this through.
    assert.throws(
      () =>
        assertDistinct([
          target('emberkin', 'primary', dsn('db.internal', 5432, 'emberkin')),
          target('aetherholm', 'primary', dsn('db.internal', 5432, 'aetherholm')),
          target('nda', 'primary', dsn('db.internal', 5432, 'aetherholm')),
        ]),
      /aetherholm\/primary and nda\/primary both point at/,
    );
  });

  it('REFUSES when the two modules name one database', () => {
    // The assertion this whole file exists for.
    assert.throws(
      () =>
        assertDistinct([
          target('emberkin', 'primary', dsn('db.internal', 5432, 'titles')),
          target('aetherholm', 'primary', dsn('db.internal', 5432, 'titles')),
        ]),
      /both point at/,
    );
  });

  it('REFUSES it through a spelling difference, too', () => {
    assert.throws(
      () =>
        assertDistinct([
          target('emberkin', 'primary', dsn('db.internal', '', 'titles')),
          target('aetherholm', 'primary', dsn('DB.internal', 5432, 'TITLES')),
        ]),
      /both point at/,
    );
  });

  it("REFUSES one module's two networks pointing at one database", () => {
    // A different fault and also fatal: migrating one database twice under one ledger is at best a
    // no-op nobody asked for, and at worst two networks' rows in one place — which is the failure
    // the whole network split exists to prevent.
    assert.throws(
      () =>
        assertDistinct([
          target('aetherholm', 'primary', dsn('db.internal', 5432, 'aetherholm')),
          target('aetherholm', 'testnet', dsn('db.internal', 5432, 'aetherholm')),
        ]),
      /both point at/,
    );
  });

  it('names both offenders and the database, and no credential', () => {
    let message = '';
    try {
      assertDistinct([
        target('emberkin', 'primary', 'postgres://u:hunter2@db.internal:5432/titles'),
        target('aetherholm', 'testnet', 'postgres://u:hunter2@db.internal:5432/titles'),
      ]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert.match(message, /emberkin\/primary/);
    assert.match(message, /aetherholm\/testnet/);
    assert.match(message, /db\.internal:5432\/titles/);
    assert.ok(!message.includes('hunter2'), 'the refusal must never carry the password');
  });
});

describe('the three ledgers cannot interfere even once the databases are right', () => {
  const LEDGERS = [
    ['emberkin', MIGRATIONS, TABLES],
    ['aetherholm', AETHERHOLM_MIGRATIONS, AETHERHOLM_TABLES],
    ['nda', NDA_MIGRATIONS, NDA_TABLES],
  ] as const;

  it('every module takes a different advisory lock', () => {
    // Distinct locks are only SAFE because the databases are distinct — see `assertDistinct`. They
    // are asserted here because equal ones would be the other failure: one module's migration
    // waiting on another's, forever, in a job with no output.
    const keys = LEDGERS.map(([name]) => String(lockKeyFor(name)));
    assert.equal(new Set(keys).size, LEDGERS.length, `two modules share an advisory lock: ${keys.join(', ')}`);
  });

  it("no module applies another module's migrations", () => {
    // The ledgers are per database; the MIGRATION SETS are per module. If any two were ever the
    // same array, `assertDistinct` would pass and both databases would get both schemas.
    for (let i = 0; i < LEDGERS.length; i += 1) {
      for (let j = i + 1; j < LEDGERS.length; j += 1) {
        const [leftName, left] = LEDGERS[i]!;
        const [rightName, right] = LEDGERS[j]!;
        assert.notEqual(left, right, `${leftName} and ${rightName} share one MIGRATIONS array`);
        assert.notDeepEqual(
          left.map((m) => `${m.version}:${m.name}`),
          right.map((m) => `${m.version}:${m.name}`),
        );
      }
    }
  });

  it('and the two OLDEST schemas genuinely collide — SIX tables, measured', () => {
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * MEASURED, NOT ASSUMED — and it is worse than a ledger collision.
     *
     * `outbox`, `event_subscriptions`, `outbox_deliveries`, `inbox`, `seasons` and `battles` exist
     * in BOTH schemas with different columns. So one shared database is not "two ledgers that
     * confuse each other"; it is two `create table seasons` racing, and then — because the ledger
     * would already record the first module's version — the SECOND module's twenty-one tables
     * never created at all, with a green migrator.
     *
     * The same six names are also why `RouteSpec.sql` exists: at RUNTIME, a handler handed the
     * wrong handle runs `select … from seasons` against a table that EXISTS, succeeds, and returns
     * another game's rows. `merged.test.ts` is where that half is proven.
     *
     * Written down where somebody tempted to delete `assertDistinct` will read it. It is also why
     * `service-ci.yml` is given both `EMBERKIN_DATABASE_URL` and `AETHERHOLM_DATABASE_URL` — it
     * creates `ci_emberkin_test` and `ci_aetherholm_test` rather than pointing both at `ci_test` —
     * and why this repository's `pnpm test` needs two DSNs.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    const shared = TABLES.filter((table) => (AETHERHOLM_TABLES as readonly string[]).includes(table)).sort();
    assert.deepEqual(
      shared,
      ['battles', 'event_subscriptions', 'inbox', 'outbox', 'outbox_deliveries', 'seasons'],
      'the measured overlap changed. If it SHRANK the refusal is cheaper than it was, but do not ' +
        'delete it: the ledger is keyed on VERSION and both modules still number from 1. If it ' +
        'GREW, check that merged.test.ts still proves the new name is read from the right database.',
    );
  });

  it('and the detector is looking at real migration sets', () => {
    // Empty arrays would satisfy every assertion above.
    for (const [name, migrations] of LEDGERS) {
      assert.ok(migrations.length > 0, `${name} declares migrations`);
      // EVERY module numbers from 1, which is exactly why one ledger could not hold two of them.
      assert.equal(Math.min(...migrations.map((m) => m.version)), 1, `${name} numbers from 1`);
    }
    // And the table lists are the real ones, not a stub.
    assert.equal(TABLES.length, 9, 'emberkin owns nine tables');
    assert.equal(AETHERHOLM_TABLES.length, 21, 'aetherholm owns twenty-one');
    assert.equal(NDA_TABLES.length, 16, 'nda owns sixteen');
  });

  it('and the FOUR names every one of the three schemas owns are the reason none may share a database', () => {
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * THE FULL MATRIX, COMPUTED. Wave M4a's contribution to this file.
     *
     * Six names are shared by at least two of the three schemas, and FOUR of them are shared by
     * all three: `outbox`, `event_subscriptions`, `outbox_deliveries` and `inbox`. Those four are
     * the estate's outbox/inbox pattern, so they have the same columns in every module — which
     * makes a mis-aimed handle worse here than the `seasons` case emberkin and aetherholm share.
     * `select … from seasons` against the wrong schema is at least a 500, because the columns
     * differ. `insert into inbox (topic, event_id) …` against the wrong schema SUCCEEDS, dedupes
     * an event that database has never seen, and the redelivery is then swallowed for ever.
     *
     * That is why `merged.test.ts` checks the ROWS in each database rather than the 202, and why
     * `RouteSpec.sql` is stamped over each mounted table rather than remembered per handler.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    const owners = new Map<string, string[]>();
    for (const [name, , tables] of LEDGERS) {
      for (const table of tables) owners.set(table, [...(owners.get(table) ?? []), name]);
    }
    const byAll = [...owners.entries()]
      .filter(([, names]) => names.length === LEDGERS.length)
      .map(([table]) => table)
      .sort();
    assert.deepEqual(
      byAll,
      ['event_subscriptions', 'inbox', 'outbox', 'outbox_deliveries'],
      'the measured three-way overlap changed. These four have the SAME columns in every module, ' +
        'so a handler handed the wrong handle writes a row that is valid and wrong.',
    );

    const shared = [...owners.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([table, names]) => `${table}: ${names.sort().join(', ')}`)
      .sort();
    assert.deepEqual(shared, [
      'battles: aetherholm, emberkin',
      'event_subscriptions: aetherholm, emberkin, nda',
      'inbox: aetherholm, emberkin, nda',
      'outbox: aetherholm, emberkin, nda',
      'outbox_deliveries: aetherholm, emberkin, nda',
      'seasons: aetherholm, emberkin',
    ]);

    // And every module's own list is free of duplicates, or the counts above mean nothing.
    for (const [name, , tables] of LEDGERS) {
      assert.equal(new Set(tables).size, tables.length, `${name} lists a table twice`);
    }
  });
});
