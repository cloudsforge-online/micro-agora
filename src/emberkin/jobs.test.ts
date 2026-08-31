// Leased-job safety. The estate rule is that background work is a leased job claimed FOR UPDATE
// SKIP LOCKED, and that two workers on one job produce exactly one run. Proven with the real
// JobQueue primitive and with the domain rollover.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs';
import { enabled, skip, openDb, migrateTestDb, resetEmberkin, asDb } from './testsupport.ts';
import { ensureActiveSeason } from './seasons.ts';
import { withOutbox } from './outbox.ts';

let sql: postgres.Sql;

before(async () => {
  if (!enabled) return;
  sql = openDb(6);
  await migrateTestDb(sql);
});
beforeEach(async () => {
  if (enabled) await resetEmberkin(sql);
});
after(async () => {
  if (sql) await sql.end();
});

test('jobs: two workers racing one job — exactly one claims it', { skip }, async () => {
  const a = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  const b = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-b' });
  await a.enqueue({ kind: 'test.work', key: 'k1' });

  const [ca, cb] = await Promise.all([a.claim(1, ['test.work']), b.claim(1, ['test.work'])]);
  const claimed = [...ca, ...cb];
  assert.equal(claimed.length, 1, 'exactly one worker must claim the single job');
});

test('jobs: enqueue is idempotent per (kind, key)', { skip }, async () => {
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  await q.enqueue({ kind: 'test.recurring', key: 'stream', onConflict: 'keep' });
  await q.enqueue({ kind: 'test.recurring', key: 'stream', onConflict: 'keep' });
  await q.enqueue({ kind: 'test.recurring', key: 'stream', onConflict: 'keep' });
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from jobs where kind = 'test.recurring'`;
  assert.equal(rows[0]!.n, 1);
});

test('jobs: season rollover under two racing runs creates exactly one active season', { skip }, async () => {
  const db = asDb(sql);
  const now = new Date();
  const [id1, id2] = await Promise.all([
    ensureActiveSeason(db, 'emberkin', 100_000n, now, withOutbox),
    ensureActiveSeason(db, 'emberkin', 100_000n, now, withOutbox),
  ]);
  assert.equal(id1, id2, 'both runs must converge on one season id');
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from seasons where status = 'active'`;
  assert.equal(rows[0]!.n, 1);
});
