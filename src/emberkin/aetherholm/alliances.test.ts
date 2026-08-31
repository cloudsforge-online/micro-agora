// An alliance IS a micro-community community (20-aetherholm.md §6). This service stores the
// binding and the PLAY — membership, claims, beacons, shared lanes — and refuses to grow a second
// governance system. Proven structurally (the module cannot reach community at all) and
// behaviourally (one banner per player per world, first claim wins, the shared-lane discount
// genuinely reaches a launch's arithmetic).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type postgres from 'postgres';
import { AIRSHIPS } from './content.ts';
import { generateIslands } from './world.ts';
import { insertIslands } from './seasons.ts';
import { ensureLattice, listLanes, shortestPath } from './lattice.ts';
import { foundCity } from './cities.ts';
import {
  AlreadyAlignedError,
  ClaimTakenError,
  NotMemberError,
  claimIsland,
  foundAlliance,
  getAlliance,
  joinAlliance,
  leaveAlliance,
} from './alliances.ts';
import { launchFleet } from './fleets.ts';
import { withOutbox, type Tx } from './outbox.ts';
import {
  ALICE,
  BOB,
  asDb,
  enabled,
  migrateTestDb,
  openDb,
  resetAetherholm,
  skip,
  stripComments,
} from './testsupport.ts';

const CARA = '33333333-3333-4333-8333-333333333333';
const COMMUNITY = '55555555-5555-4555-8555-555555555555';

let sql: postgres.Sql;

before(async () => {
  if (!enabled) return;
  sql = openDb(8);
  await migrateTestDb(sql);
});
beforeEach(async () => {
  if (enabled) await resetAetherholm(sql);
});
after(async () => {
  if (sql) await sql.end();
});

let entropy = 0;

async function world(seed = 6006n): Promise<{ archipelagoId: string; islands: string[] }> {
  entropy += 1;
  const archipelagoId = await withOutbox(asDb(sql), 'aetherholm-test', async (tx: Tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into archipelagos (kind, owner_subject, entitlement_id, name, seed)
      values ('skerry', 'user:t', ${`ent-a-${Date.now()}-${entropy}`}, 'T', ${seed.toString()})
      returning id
    `;
    await insertIslands(tx, rows[0]!.id, generateIslands(seed, 12));
    await ensureLattice(tx, rows[0]!.id);
    return rows[0]!.id;
  });
  const islands = await sql<{ id: string }[]>`
    select id from islands where archipelago_id = ${archipelagoId} order by idx
  `;
  return { archipelagoId, islands: islands.map((row) => row.id) };
}

const found = (islandId: string, userId: string, plot: number) =>
  foundCity(asDb(sql), 'aetherholm-test', { userId, islandId, plot, name: 'C', correlationId: 't' });

const ally = (archipelagoId: string, userId: string, communityId = COMMUNITY, name = 'Compact') =>
  foundAlliance(asDb(sql), 'aetherholm-test', { archipelagoId, communityId, name, userId, correlationId: 't' });

/* ------------------------------------------------------------------ the refusal, structural */

test('alliances: the module CANNOT create a community — no client, no community route, asserted over stripped source', async () => {
  // 20-aetherholm.md §6: the game refuses to create communities; it references one the caller
  // already has. The absence is structural: this module holds no HTTP client and never spells a
  // community route, so there is no code path to grow a second governance system through.
  const source = stripComments(await readFile(new URL('./alliances.ts', import.meta.url), 'utf8'));
  assert.ok(!/HttpClient/.test(source), 'alliances.ts must not construct an HTTP client');
  assert.ok(!/\/v1\/communities/.test(source), 'alliances.ts must not spell a community route');
  assert.ok(!/\bfetch\s*\(/.test(source), 'alliances.ts must not fetch');
});

/* ------------------------------------------------------------------ founding and membership */

test('alliances: founding requires the community reference and binds it uniquely per world', { skip }, async () => {
  const { archipelagoId } = await world();
  const alliance = await ally(archipelagoId, ALICE);
  assert.equal(alliance.communityId, COMMUNITY);
  assert.deepEqual(alliance.members.map((member) => member.userId), [ALICE]);
  // The same community cannot back a second alliance on this world.
  await assert.rejects(
    () => ally(archipelagoId, BOB, COMMUNITY, 'Second Banner'),
    /already backs an alliance/,
  );
});

test('alliances: one banner per player per world — join replays, a second banner is refused', { skip }, async () => {
  const { archipelagoId } = await world();
  const first = await ally(archipelagoId, ALICE);
  await joinAlliance(asDb(sql), 'aetherholm-test', first.id, BOB);
  await joinAlliance(asDb(sql), 'aetherholm-test', first.id, BOB); // a replay, not an error
  const other = await ally(archipelagoId, CARA, '66666666-6666-4666-8666-666666666666', 'Rival');
  await assert.rejects(
    () => joinAlliance(asDb(sql), 'aetherholm-test', other.id, BOB),
    AlreadyAlignedError,
  );
  // Founding a second alliance while aligned is the same refusal, made unrepresentable.
  await assert.rejects(
    () => ally(archipelagoId, ALICE, '77777777-7777-4777-8777-777777777777', 'Third'),
    AlreadyAlignedError,
  );
  await leaveAlliance(asDb(sql), 'aetherholm-test', first.id, BOB);
  await joinAlliance(asDb(sql), 'aetherholm-test', other.id, BOB); // free again after leaving
});

/* ------------------------------------------------------------------ claims and beacons */

test('alliances: a claim needs membership and a footing, and the first banner wins the island', { skip }, async () => {
  const { archipelagoId, islands } = await world();
  const compact = await ally(archipelagoId, ALICE);
  await assert.rejects(
    () => claimIsland(asDb(sql), 'aetherholm-test', compact.id, islands[0]!, BOB),
    NotMemberError,
  );
  await assert.rejects(
    () => claimIsland(asDb(sql), 'aetherholm-test', compact.id, islands[0]!, ALICE),
    /footing/,
  );
  await found(islands[0]!, ALICE, 1);
  await claimIsland(asDb(sql), 'aetherholm-test', compact.id, islands[0]!, ALICE);
  await claimIsland(asDb(sql), 'aetherholm-test', compact.id, islands[0]!, ALICE); // replay

  const rival = await ally(archipelagoId, BOB, '66666666-6666-4666-8666-666666666666', 'Rival');
  await found(islands[0]!, BOB, 2);
  await assert.rejects(
    () => claimIsland(asDb(sql), 'aetherholm-test', rival.id, islands[0]!, BOB),
    ClaimTakenError,
  );
});

test('alliances: beacons are the islands where a member city flies a Guild Beacon', { skip }, async () => {
  const { archipelagoId, islands } = await world();
  const compact = await ally(archipelagoId, ALICE);
  const settled = await found(islands[2]!, ALICE, 1);
  assert.deepEqual((await getAlliance(asDb(sql), compact.id))!.beacons, []);
  await sql`insert into buildings (city_id, type, level) values (${settled.city.id}, 'guild_beacon', 1)`;
  assert.deepEqual((await getAlliance(asDb(sql), compact.id))!.beacons, [islands[2]!]);
});

/* ------------------------------------------------------------------ shared lanes */

test('alliances: a shared lane is 10% faster, and the discount genuinely reaches a launch', { skip }, async () => {
  const { archipelagoId, islands } = await world();
  const lanes = await listLanes(asDb(sql), archipelagoId);

  // Find a ring-adjacent pair whose shortest path is the DIRECT lane, so claiming both
  // endpoints provably discounts the optimal route.
  let pair: { fromIdx: number; toIdx: number } | null = null;
  for (let idx = 0; idx < 11; idx += 1) {
    const path = shortestPath(lanes, islands[idx]!, islands[idx + 1]!);
    if (path && path.lanes.length === 1) {
      pair = { fromIdx: idx, toIdx: idx + 1 };
      break;
    }
  }
  assert.ok(pair, 'some adjacent pair rides its direct lane');

  const origin = islands[pair.fromIdx]!;
  const target = islands[pair.toIdx]!;
  // Cara, unaligned, flies the plain lattice.
  const caraCity = await found(origin, CARA, 3);
  await sql`insert into city_ships (city_id, class, count) values (${caraCity.city.id}, 'skiff', 2)`;
  await found(target, CARA, 3);
  const caraFlight = await launchFleet(asDb(sql), 'aetherholm-test', {
    cityId: caraCity.city.id,
    userId: CARA,
    mission: 'transfer',
    ships: { skiff: 1 },
    targetIslandId: target,
    idempotencyKey: 'k-cara',
    correlationId: 't',
  });

  // Alice claims both endpoints, then flies the same route.
  const compact = await ally(archipelagoId, ALICE);
  const aliceCity = await found(origin, ALICE, 1);
  await sql`insert into city_ships (city_id, class, count) values (${aliceCity.city.id}, 'skiff', 2)`;
  await found(target, ALICE, 1);
  await claimIsland(asDb(sql), 'aetherholm-test', compact.id, origin, ALICE);
  await claimIsland(asDb(sql), 'aetherholm-test', compact.id, target, ALICE);
  const view = await getAlliance(asDb(sql), compact.id);
  assert.ok(view!.sharedLanes.length >= 1, 'the lane between two claims is shared');

  const aliceFlight = await launchFleet(asDb(sql), 'aetherholm-test', {
    cityId: aliceCity.city.id,
    userId: ALICE,
    mission: 'transfer',
    ships: { skiff: 1 },
    targetIslandId: target,
    idempotencyKey: 'k-alice',
    correlationId: 't',
  });
  assert.ok(
    aliceFlight.fleet.travelSeconds < caraFlight.fleet.travelSeconds,
    `the shared lane must be faster: ally ${aliceFlight.fleet.travelSeconds}s vs solo ${caraFlight.fleet.travelSeconds}s`,
  );
  // And exactly 10%, floor arithmetic, through the skiff's speed factor — not "roughly".
  const direct = shortestPath(lanes, origin, target)!.lanes[0]!;
  const discounted = Math.max(1, Math.floor((direct.travelSeconds * 9000) / 10000));
  const expected = Math.max(1, Math.floor((discounted * AIRSHIPS.skiff.speedBp) / 10000));
  assert.equal(aliceFlight.fleet.travelSeconds, expected);
});
