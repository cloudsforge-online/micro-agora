// Leased-job safety. The estate rule is that background work is a leased job claimed FOR UPDATE
// SKIP LOCKED, and that two workers on one job produce exactly one run. Proven with the real
// JobQueue primitive, and with the domain: the city.queue lease key names the CITY.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs';
import {
  CITY_QUEUE_KIND,
  FLEET_KIND,
  RECURRING,
  RELAY_KIND,
  SEASON_ENSURE_KIND,
  cityQueueKey,
  fleetKey,
  plotKey,
  rearmCityQueue,
  rearmFleet,
  seasonKey,
  seedRecurring,
} from './jobs.ts';
import { generateIslands } from './world.ts';
import { insertIslands } from './seasons.ts';
import { foundCity } from './cities.ts';
import { withOutbox, type Tx } from './outbox.ts';
import { asDb, enabled, skip, openDb, migrateTestDb, resetAetherholm, ALICE } from './testsupport.ts';

let sql: postgres.Sql;

before(async () => {
  if (!enabled) return;
  sql = openDb(6);
  await migrateTestDb(sql);
});
beforeEach(async () => {
  if (enabled) await resetAetherholm(sql);
});
after(async () => {
  if (sql) await sql.end();
});

test('jobs: two workers racing one job — exactly one claims it', { skip }, async () => {
  const a = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  const b = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-b' });
  await a.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1') });

  const [ca, cb] = await Promise.all([a.claim(1, [CITY_QUEUE_KIND]), b.claim(1, [CITY_QUEUE_KIND])]);
  assert.equal([...ca, ...cb].length, 1, 'exactly one worker must claim the single job');
});

test('jobs: the lease key names the city, so two cities never contend', { skip }, async () => {
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1') });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c2') });
  const claimed = await q.claim(2, [CITY_QUEUE_KIND]);
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map((job) => job.key).sort(), ['city:c1', 'city:c2']);
});

test('jobs: enqueue is idempotent per (kind, key)', { skip }, async () => {
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1'), onConflict: 'keep' });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1'), onConflict: 'keep' });
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from jobs where kind = ${CITY_QUEUE_KIND}
  `;
  assert.equal(rows[0]!.n, 1);
});

test("jobs: 'earliest' pulls a queued completion forward, never back", { skip }, async () => {
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  const later = new Date(Date.now() + 60_000);
  const sooner = new Date(Date.now() + 10_000);
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1'), runAt: later, onConflict: 'earliest' });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1'), runAt: sooner, onConflict: 'earliest' });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1'), runAt: later, onConflict: 'earliest' });
  const rows = await sql<{ run_at: Date }[]>`
    select run_at from jobs where kind = ${CITY_QUEUE_KIND}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.run_at.getTime(), sooner.getTime());
});

test('jobs: the recurring set is the relay and the season keeper — no economy tick exists', { skip }, async () => {
  // The design's rule (20-aetherholm.md §6): balances are lazy, so there is NO per-minute world
  // tick to shard or to miss. If someone adds one it will appear here first.
  assert.deepEqual(
    RECURRING.map((r) => r.kind).sort(),
    [RELAY_KIND, SEASON_ENSURE_KIND].sort(),
  );
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  await seedRecurring(q);
  await seedRecurring(q); // N replicas booting collapse to one row per job
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from jobs`;
  assert.equal(rows[0]!.n, RECURRING.length);
});

test('jobs: the lease keys name the contended resource, exactly', () => {
  assert.equal(cityQueueKey('c1'), 'city:c1');
  assert.equal(fleetKey('f1'), 'fleet:f1');
  assert.equal(plotKey('i1', 7), 'plot:i1:7');
  assert.equal(seasonKey('s1'), 'season:s1');
});

test('jobs: THE TRAP — a handler enqueueing its own (kind, key) loses the re-arm on complete', { skip }, async () => {
  // This is the defect the completed-event re-arm exists for, pinned so the runtime cannot
  // silently change under us. While a job runs its row still exists and is claimed; an enqueue
  // for the same pair is absorbed into that row ('earliest' keeps the PAST run_at), and the
  // runner's complete() then deletes it — the re-arm evaporates. Phase 1's city.queue handler
  // did exactly this, and its second queued item only ever completed because a later submission
  // re-armed the city by accident.
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1') });
  const claimed = await q.claim(1, [CITY_QUEUE_KIND]);
  assert.equal(claimed.length, 1);
  // "The handler re-arms itself" — the phase-1 pattern.
  await q.enqueue({
    kind: CITY_QUEUE_KIND,
    key: cityQueueKey('c1'),
    runAt: new Date(Date.now() + 60_000),
    onConflict: 'earliest',
  });
  await q.complete(claimed[0]!.id);
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from jobs`;
  assert.equal(rows[0]!.n, 0, 'the in-handler re-arm was deleted with the claimed row');
});

test('jobs: the completed-event re-arm survives, from the domain tables', { skip }, async () => {
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  // A city with a queued item due in the future…
  const archipelagoId = await withOutbox(asDb(sql), 'aetherholm-test', async (tx: Tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into archipelagos (kind, owner_subject, entitlement_id, name, seed)
      values ('skerry', 'user:t', 'ent-jobs', 'T', 1)
      returning id
    `;
    await insertIslands(tx, rows[0]!.id, generateIslands(1n, 12));
    return rows[0]!.id;
  });
  const islands = await sql<{ id: string }[]>`
    select id from islands where archipelago_id = ${archipelagoId} order by idx limit 2
  `;
  const city = await foundCity(asDb(sql), 'aetherholm-test', {
    userId: ALICE,
    islandId: islands[0]!.id,
    plot: 1,
    name: 'C',
    correlationId: 't',
  });
  const due = new Date(Date.now() + 300_000);
  await sql`insert into queue_items (city_id, kind, target, completes_at, idempotency_key)
            values (${city.city.id}, 'building', 'warehouse', ${due}, 'k-rearm')`;
  await rearmCityQueue(asDb(sql), q, city.city.id);
  const cityJobs = await sql<{ kind: string; key: string; run_at: Date }[]>`
    select kind, key, run_at from jobs where kind = ${CITY_QUEUE_KIND}
  `;
  assert.equal(cityJobs.length, 1);
  assert.equal(cityJobs[0]!.key, cityQueueKey(city.city.id));
  assert.equal(cityJobs[0]!.run_at.getTime(), due.getTime());

  // …and a fleet still owed its outbound leg.
  const arrives = new Date(Date.now() + 120_000);
  const fleets = await sql<{ id: string }[]>`
    insert into fleets (origin_city_id, user_id, mission, status, target_island_id,
                        departed_at, arrives_at, travel_seconds, return_seconds, aether_lift,
                        idempotency_key)
    values (${city.city.id}, ${ALICE}, 'raid', 'outbound', ${islands[1]!.id},
            now(), ${arrives}, 120, 120, 5, 'k-f')
    returning id
  `;
  await rearmFleet(asDb(sql), q, fleets[0]!.id);
  const fleetJobs = await sql<{ key: string; run_at: Date }[]>`
    select key, run_at from jobs where kind = ${FLEET_KIND}
  `;
  assert.equal(fleetJobs.length, 1);
  assert.equal(fleetJobs[0]!.key, fleetKey(fleets[0]!.id));
  assert.equal(fleetJobs[0]!.run_at.getTime(), arrives.getTime());

  // A finished fleet re-arms nothing.
  await sql`delete from jobs where kind = ${FLEET_KIND}`;
  await sql`update fleets set status = 'done', resolved_at = now() where id = ${fleets[0]!.id}`;
  await rearmFleet(asDb(sql), q, fleets[0]!.id);
  const after = await sql<{ n: number }[]>`select count(*)::int as n from jobs where kind = ${FLEET_KIND}`;
  assert.equal(after[0]!.n, 0);
});
