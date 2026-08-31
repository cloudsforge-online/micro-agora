/**
 * The database harness and shared fixtures.
 *
 * **A database test runs only against a database whose name says it is a test database.** Not a
 * convenience: `resetAetherholm` truncates every table this service owns, and requiring "test" in
 * the name is the difference between a red build and an emptied world — this service holds the
 * only record of every city ever founded.
 */

import postgres from 'postgres';
import { migrate, type Sql as DbSql } from '@cloudsforge/db';
import { Logger, Metrics } from '@cloudsforge/telemetry';
import { MIGRATIONS, TABLES } from './migrations.ts';
import { registerServiceMetrics } from './server.ts';
import type { Db } from './outbox.ts';

export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';
/**
 * A THIRD player, and the reason there has to be one.
 *
 * `server.test.ts`'s admin fake is BOB with `roles: ['admin']`, so BOB can never stand for "a
 * stranger who is refused" — every refusal test written against him would pass for the wrong
 * reason the day somebody gave him a skerry. micro-org#341 needs a subject who owns nothing,
 * guests nowhere and holds no role.
 */
export const CAROL = '33333333-3333-4333-8333-333333333333';

/**
 * The signing secret every test server accepts on `POST /v1/events`.
 *
 * Declared once here rather than per file, so a test that means to sign a delivery correctly and a
 * test that means to forge one cannot accidentally agree by both using a local literal.
 */
export const TEST_EVENT_SECRET = 'a-test-event-signing-secret-000000';

const url = process.env['AETHERHOLM_TEST_DATABASE_URL'];

export const enabled = Boolean(url && /test/i.test(url));

export const skip = enabled ? false : 'set AETHERHOLM_TEST_DATABASE_URL (name must contain "test")';

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled');
  return postgres(url!, { max, onnotice: () => {} });
}

/** Bring the schema up. Idempotent — the real MIGRATIONS, so constraints cannot drift from tests. */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'aetherholm-test' });
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetAetherholm(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`);
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'aetherholm-test', sink: () => {} });
}

export function testMetrics(): Metrics {
  return registerServiceMetrics(new Metrics());
}

export function asDb(sql: postgres.Sql): Db {
  return sql as unknown as Db;
}

/**
 * Strip line and block comments from TypeScript source, for the source-scanning assertions.
 *
 * Six guards in this estate have fired on their own prose; scanning raw source makes a rule that
 * punishes documenting the rule. This is the same stripping the estate CI's Rule 1 does, in TS.
 */
export function stripComments(source: string): string {
  let out = '';
  let inBlock = false;
  for (const rawLine of source.split('\n')) {
    let line = rawLine;
    let kept = '';
    while (line.length > 0) {
      if (inBlock) {
        const end = line.indexOf('*/');
        if (end === -1) {
          line = '';
          break;
        }
        inBlock = false;
        line = line.slice(end + 2);
        continue;
      }
      const block = line.indexOf('/*');
      const lineComment = line.indexOf('//');
      if (lineComment !== -1 && (block === -1 || lineComment < block)) {
        kept += line.slice(0, lineComment);
        line = '';
        break;
      }
      if (block !== -1) {
        kept += line.slice(0, block);
        line = line.slice(block + 2);
        inBlock = true;
        continue;
      }
      kept += line;
      line = '';
    }
    out += `${kept}\n`;
  }
  return out;
}
