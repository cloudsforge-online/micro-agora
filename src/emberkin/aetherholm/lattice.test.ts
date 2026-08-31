// The wind lattice: deterministic from the seed, directed (A→B ≠ B→A), strongly connected, and
// backfillable — a phase-1 archipelago that predates lanes grows byte-identical ones from its
// stored seed, on any replica, any number of times.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
import {
  generateIslands,
  generateLanes,
  spireCountFor,
  spireIdxsFor,
  LANE_MULTIPLIER_MAX_BP,
  LANE_MULTIPLIER_MIN_BP,
  PUBLIC_ISLAND_COUNT,
} from './world.ts';
import { ensureLattice, listLanes, shortestPath } from './lattice.ts';
import { insertIslands } from './seasons.ts';
import { withOutbox, type Tx } from './outbox.ts';
import { enabled, skip, openDb, migrateTestDb, resetAetherholm, asDb } from './testsupport.ts';

/* ------------------------------------------------------------------ pure generation */

test('lattice: one seed yields byte-identical lanes, every time', () => {
  const a = JSON.stringify(generateLanes(123456789n, 50));
  const b = JSON.stringify(generateLanes(123456789n, 50));
  assert.equal(a, b);
  assert.notEqual(a, JSON.stringify(generateLanes(987654321n, 50)));
});

test('lattice: lanes are DIRECTED — A→B and B→A are separate rolls that differ somewhere', () => {
  const lanes = generateLanes(42n, 30);
  const byPair = new Map(lanes.map((lane) => [`${lane.fromIdx}>${lane.toIdx}`, lane]));
  let asymmetric = 0;
  for (const lane of lanes) {
    const back = byPair.get(`${lane.toIdx}>${lane.fromIdx}`);
    assert.ok(back, `every lane has a return lane (ring + mirrored chords): ${lane.fromIdx}→${lane.toIdx}`);
    if (back.multiplierBp !== lane.multiplierBp) asymmetric += 1;
  }
  // The design's point (20-aetherholm.md §2): A→B may be 2 hours while B→A is 5. With ~120
  // directed lanes at 1-in-15001 collision odds per pair, symmetry everywhere is a broken PRNG.
  assert.ok(asymmetric > 0, 'no lane pair differs by direction; the wind is not blowing');
});

test('lattice: multipliers stay in the schema CHECK domain and travel time derives from them', () => {
  for (const lane of generateLanes(7n, PUBLIC_ISLAND_COUNT)) {
    assert.ok(lane.multiplierBp >= LANE_MULTIPLIER_MIN_BP && lane.multiplierBp <= LANE_MULTIPLIER_MAX_BP);
    assert.ok(lane.travelSeconds > 0);
    assert.equal(lane.travelSeconds, Math.floor((7200 * lane.multiplierBp) / 10000));
  }
});

test('lattice: strongly connected by construction — every island reaches every island', () => {
  const count = 25;
  const lanes = generateLanes(99n, count).map((lane, index) => ({
    id: String(index),
    fromIslandId: `i${lane.fromIdx}`,
    toIslandId: `i${lane.toIdx}`,
    multiplierBp: lane.multiplierBp,
    travelSeconds: lane.travelSeconds,
  }));
  for (const from of [0, 7, 24]) {
    for (let to = 0; to < count; to += 1) {
      if (to === from) continue;
      const path = shortestPath(lanes, `i${from}`, `i${to}`);
      assert.ok(path && path.lanes.length > 0, `no route i${from} → i${to}`);
      assert.equal(path.lanes[0]!.fromIslandId, `i${from}`);
      assert.equal(path.lanes[path.lanes.length - 1]!.toIslandId, `i${to}`);
    }
  }
});

test('lattice: spires are deterministic, at least three, and scale with the world', () => {
  assert.deepEqual(spireIdxsFor(5n, 200), spireIdxsFor(5n, 200));
  assert.equal(spireIdxsFor(5n, 200).length, spireCountFor(200));
  assert.equal(spireCountFor(200), 5);
  assert.equal(spireCountFor(12), 3);
  const spires = spireIdxsFor(5n, 12);
  assert.equal(new Set(spires).size, spires.length, 'spire islands are distinct');
  for (const idx of spires) assert.ok(idx >= 0 && idx < 12);
});

test('lattice: the lane and spire streams do not disturb the island stream', () => {
  // Phase-1 archipelagos already exist: their islands were generated before lanes existed, so the
  // lattice MUST come from its own tagged stream. If generateLanes consumed the island stream,
  // this equality would break and every stored world would disagree with its own backfill.
  const before = JSON.stringify(generateIslands(31337n, 40));
  generateLanes(31337n, 40);
  spireIdxsFor(31337n, 40);
  assert.equal(JSON.stringify(generateIslands(31337n, 40)), before);
});

/* ------------------------------------------------------------------ the database half */

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

async function bareArchipelago(seed: bigint, islands: number): Promise<string> {
  // A phase-1 world: islands, no lanes, no spire flags — exactly what production holds today.
  return withOutbox(asDb(sql), 'aetherholm-test', async (tx: Tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into archipelagos (kind, owner_subject, entitlement_id, name, seed)
      values ('skerry', 'user:t', ${`ent-${seed}`}, 'T', ${seed.toString()})
      returning id
    `;
    await insertIslands(tx, rows[0]!.id, generateIslands(seed, islands));
    return rows[0]!.id;
  });
}

test('lattice: the backfill grows lanes and spires from the stored seed, idempotently', { skip }, async () => {
  const archipelagoId = await bareArchipelago(2024n, 12);
  const first = await ensureLattice(asDb(sql), archipelagoId);
  assert.ok(first.length > 0, 'lanes were generated');
  const again = await ensureLattice(asDb(sql), archipelagoId);
  assert.deepEqual(again, first, 'a second ensure is a read, not a re-roll');

  const spires = await sql<{ idx: number }[]>`
    select idx from islands
     where archipelago_id = ${archipelagoId} and is_spire order by idx
  `;
  assert.deepEqual(
    spires.map((row) => row.idx),
    [...spireIdxsFor(2024n, 12)],
    'the flagged islands are exactly what the seed says',
  );
});

test('lattice: two replicas racing one backfill converge on one set of lanes', { skip }, async () => {
  const archipelagoId = await bareArchipelago(777n, 12);
  const [a, b] = await Promise.all([
    ensureLattice(asDb(sql), archipelagoId),
    ensureLattice(asDb(sql), archipelagoId),
  ]);
  const stored = await listLanes(asDb(sql), archipelagoId);
  assert.equal(a.length, stored.length);
  assert.equal(b.length, stored.length);
  const counts = await sql<{ n: number }[]>`
    select count(*)::int as n from lanes where archipelago_id = ${archipelagoId}
  `;
  assert.equal(counts[0]!.n, stored.length, 'no duplicate lanes survived the race');
});

test('lattice: the schema refuses a self-lane and an out-of-domain multiplier', { skip }, async () => {
  const archipelagoId = await bareArchipelago(555n, 12);
  await ensureLattice(asDb(sql), archipelagoId);
  const islands = await sql<{ id: string }[]>`
    select id from islands where archipelago_id = ${archipelagoId} order by idx limit 2
  `;
  await assert.rejects(
    () => sql`insert into lanes (archipelago_id, from_island_id, to_island_id, multiplier_bp, travel_seconds)
              values (${archipelagoId}, ${islands[0]!.id}, ${islands[0]!.id}, 10000, 7200)`,
    /lanes_no_self/,
  );
  await assert.rejects(
    () => sql`insert into lanes (archipelago_id, from_island_id, to_island_id, multiplier_bp, travel_seconds)
              values (${archipelagoId}, ${islands[1]!.id}, ${islands[0]!.id}, 100000, 7200)`,
    /lanes_multiplier_range/,
  );
});
