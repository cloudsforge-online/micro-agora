// Fleets against a real Postgres: a launch is CHARGED, never clamped; the garrison cannot go
// negative; cargo never exceeds the freight holds (a DEFERRED constraint, judged at commit);
// loot rides only in Haulers and never touches the Vault's floor; and — §9.3 — two replicas
// racing one arrival produce exactly one battle, proven by racing them.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
import { AIRSHIPS, AIRSHIP_CLASSES, VAULT_PROTECTION_PER_LEVEL } from './content.ts';
import { resolveBattle, battleDigest, type OrderOfBattle } from './battles.ts';
import { generateIslands } from './world.ts';
import { insertIslands } from './seasons.ts';
import { ensureLattice } from './lattice.ts';
import { foundCity } from './cities.ts';
import { InsufficientStockError } from './economy.ts';
import {
  AegisError,
  InsufficientShipsError,
  completeReturn,
  getFleet,
  launchFleet,
  resolveArrival,
  resolveSieges,
} from './fleets.ts';
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
} from './testsupport.ts';

let sql: postgres.Sql;

before(async () => {
  if (!enabled) return;
  sql = openDb(10);
  await migrateTestDb(sql);
});
beforeEach(async () => {
  if (enabled) await resetAetherholm(sql);
});
after(async () => {
  if (sql) await sql.end();
});

/* ------------------------------------------------------------------ fixtures */

let entropy = 0;

/** A 12-island world with its lattice, like a skerry: small enough to reason about exactly. */
async function world(seed = 4242n): Promise<{ archipelagoId: string; islands: string[] }> {
  entropy += 1;
  const suffix = `${Date.now()}-${entropy}`;
  const archipelagoId = await withOutbox(asDb(sql), 'aetherholm-test', async (tx: Tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into archipelagos (kind, owner_subject, entitlement_id, name, seed)
      values ('skerry', 'user:t', ${`ent-${suffix}`}, 'T', ${seed.toString()})
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

/** A city with a KNOWN, static economy: rates zeroed, stocks set, aegis lapsed. */
async function city(
  islandId: string,
  userId: string,
  options: { stocks?: bigint; aegis?: boolean; plot?: number } = {},
): Promise<string> {
  const result = await foundCity(asDb(sql), 'aetherholm-test', {
    userId,
    islandId,
    plot: options.plot ?? 1,
    name: 'T',
    correlationId: 'test',
  });
  const id = result.city.id;
  const stocks = (options.stocks ?? 400n).toString();
  await sql`
    update cities
       set aether = ${stocks}::bigint, cloudstone = ${stocks}::bigint,
           skysteel = ${stocks}::bigint, provisions = ${stocks}::bigint,
           rate_aether = 0, rate_cloudstone = 0, rate_skysteel = 0, rate_provisions = 0,
           last_settled_at = now()
       ${options.aegis ? sql`` : sql`, aegis_until = founded_at`}
     where id = ${id}
  `;
  return id;
}

async function garrison(cityId: string, ships: Record<string, number>): Promise<void> {
  for (const [cls, count] of Object.entries(ships)) {
    await sql`
      insert into city_ships (city_id, class, count) values (${cityId}, ${cls}, ${count})
      on conflict (city_id, class) do update set count = ${count}
    `;
  }
}

async function stocksOf(
  cityId: string,
): Promise<{ aether: bigint; cloudstone: bigint; skysteel: bigint; provisions: bigint }> {
  const rows = await sql<{ aether: string; cloudstone: string; skysteel: string; provisions: string }[]>`
    select aether::text, cloudstone::text, skysteel::text, provisions::text
      from cities where id = ${cityId}
  `;
  const row = rows[0]!;
  return {
    aether: BigInt(row.aether),
    cloudstone: BigInt(row.cloudstone),
    skysteel: BigInt(row.skysteel),
    provisions: BigInt(row.provisions),
  };
}

const launch = (input: Parameters<typeof launchFleet>[2]) =>
  launchFleet(asDb(sql), 'aetherholm-test', input);

/* ------------------------------------------------------------------ launching */

test('fleets: lift is charged at launch; an unaffordable launch is REFUSED, never clamped', { skip }, async () => {
  const { islands } = await world();
  const origin = await city(islands[0]!, ALICE);
  await garrison(origin, { cutter: 5 });
  const target = await city(islands[1]!, BOB);
  void target;
  // Drain the aether. The launch must throw and leave EVERYTHING untouched.
  await sql`update cities set aether = 0, last_settled_at = now() where id = ${origin}`;
  const bobCity = await sql<{ id: string }[]>`
    select id from cities where island_id = ${islands[1]!} and user_id = ${BOB}
  `;
  await assert.rejects(
    () =>
      launch({
        cityId: origin,
        userId: ALICE,
        mission: 'raid',
        ships: { cutter: 5 },
        targetIslandId: islands[1]!,
        targetCityId: bobCity[0]!.id,
        idempotencyKey: 'k-broke',
        correlationId: 't',
      }),
    InsufficientStockError,
  );
  const fleets = await sql<{ n: number }[]>`select count(*)::int as n from fleets`;
  assert.equal(fleets[0]!.n, 0, 'the refused launch left no fleet');
  const held = await sql<{ count: string }[]>`
    select count::text from city_ships where city_id = ${origin} and class = 'cutter'
  `;
  assert.equal(held[0]!.count, '5', 'the refused launch returned the garrison untouched');
});

test('fleets: the launch is charged exactly — lift (and cargo) leave the settled stocks', { skip }, async () => {
  const { islands } = await world();
  const origin = await city(islands[0]!, ALICE);
  await city(islands[1]!, ALICE); // transfer destination
  await garrison(origin, { hauler: 2 });
  const before = await stocksOf(origin);
  const result = await launch({
    cityId: origin,
    userId: ALICE,
    mission: 'transfer',
    ships: { hauler: 2 },
    cargo: { cloudstone: 100n },
    targetIslandId: islands[1]!,
    idempotencyKey: 'k-exact',
    correlationId: 't',
  });
  const lift = BigInt(result.fleet.aetherLift);
  assert.ok(lift > 0n, 'a round trip costs lift');
  const after = await stocksOf(origin);
  assert.equal(after.aether, before.aether - lift);
  assert.equal(after.cloudstone, before.cloudstone - 100n);
  // And the replay reads, never re-charges.
  const replay = await launch({
    cityId: origin,
    userId: ALICE,
    mission: 'transfer',
    ships: { hauler: 2 },
    cargo: { cloudstone: 100n },
    targetIslandId: islands[1]!,
    idempotencyKey: 'k-exact',
    correlationId: 't2',
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.fleet.id, result.fleet.id);
  assert.deepEqual(await stocksOf(origin), after, 'the retry charged nothing');
});

test('fleets: the garrison cannot be overdrawn — by the handler or by SQL', { skip }, async () => {
  const { islands } = await world();
  const origin = await city(islands[0]!, ALICE);
  await garrison(origin, { cutter: 2 });
  const bobCity = await city(islands[1]!, BOB);
  await assert.rejects(
    () =>
      launch({
        cityId: origin,
        userId: ALICE,
        mission: 'raid',
        ships: { cutter: 3 },
        targetIslandId: islands[1]!,
        targetCityId: bobCity,
        idempotencyKey: 'k-overdraw',
        correlationId: 't',
      }),
    InsufficientShipsError,
  );
  await assert.rejects(
    () => sql`update city_ships set count = -1 where city_id = ${origin} and class = 'cutter'`,
    /city_ships_count_non_negative/,
  );
});

test('fleets: a fleet never departs with more cargo than hold — deferred, judged at commit', { skip }, async () => {
  const { islands } = await world();
  const origin = await city(islands[0]!, ALICE);
  await city(islands[1]!, ALICE);
  await garrison(origin, { hauler: 1, ironclad: 5 });
  // One hauler holds 120; five ironclads hold NOTHING — that is the freight/war split.
  await assert.rejects(
    () =>
      launch({
        cityId: origin,
        userId: ALICE,
        mission: 'transfer',
        ships: { hauler: 1, ironclad: 5 },
        cargo: { provisions: 121n },
        targetIslandId: islands[1]!,
        idempotencyKey: 'k-overload',
        correlationId: 't',
      }),
    /fleets_cargo_within_hold|carries.*cargo but holds only/,
  );
  const fleets = await sql<{ n: number }[]>`select count(*)::int as n from fleets`;
  assert.equal(fleets[0]!.n, 0);
  // At exactly the hold, it sails.
  const ok = await launch({
    cityId: origin,
    userId: ALICE,
    mission: 'transfer',
    ships: { hauler: 1 },
    cargo: { provisions: 120n },
    targetIslandId: islands[1]!,
    idempotencyKey: 'k-full',
    correlationId: 't',
  });
  assert.equal(ok.replayed, false);
});

test('fleets: the SQL hold table cannot drift from the content table', { skip }, async () => {
  // aetherholm_class_cargo is the deferred constraint's copy of AIRSHIPS[*].cargo. If someone
  // rebalances the content and forgets the migration (or vice versa), this is the red build.
  for (const cls of AIRSHIP_CLASSES) {
    const rows = await sql<{ cargo: string }[]>`select aetherholm_class_cargo(${cls})::text as cargo`;
    assert.equal(BigInt(rows[0]!.cargo), AIRSHIPS[cls].cargo, `${cls} hold drifted`);
  }
});

test('fleets: a raid may not launch against an aegis, and a siege needs its Breaker', { skip }, async () => {
  const { islands } = await world();
  const origin = await city(islands[0]!, ALICE);
  await garrison(origin, { gunship: 3, breaker: 1 });
  const shielded = await city(islands[1]!, BOB, { aegis: true });
  await assert.rejects(
    () =>
      launch({
        cityId: origin,
        userId: ALICE,
        mission: 'raid',
        ships: { gunship: 3 },
        targetIslandId: islands[1]!,
        targetCityId: shielded,
        idempotencyKey: 'k-aegis',
        correlationId: 't',
      }),
    AegisError,
  );
  const open = await city(islands[2]!, BOB);
  await assert.rejects(
    () =>
      launch({
        cityId: origin,
        userId: ALICE,
        mission: 'siege',
        ships: { gunship: 3 },
        targetIslandId: islands[2]!,
        targetCityId: open,
        idempotencyKey: 'k-nobreaker',
        correlationId: 't',
      }),
    /Breaker/,
  );
});

/* ------------------------------------------------------------------ travel and transfer */

test('fleets: a transfer sails, lands its cargo under the cap, and the ships come home', { skip }, async () => {
  const { islands } = await world();
  const origin = await city(islands[0]!, ALICE);
  const destination = await city(islands[1]!, ALICE, { plot: 2 });
  await garrison(origin, { hauler: 1 });
  const result = await launch({
    cityId: origin,
    userId: ALICE,
    mission: 'transfer',
    ships: { hauler: 1 },
    cargo: { skysteel: 90n },
    targetIslandId: islands[1]!,
    idempotencyKey: 'k-move',
    correlationId: 't',
  });
  const destinationBefore = await stocksOf(destination);

  const arrival = new Date(result.fleet.arrivesAt.getTime() + 1000);
  const instruction = await resolveArrival(asDb(sql), 'aetherholm-test', result.fleet.id, arrival);
  assert.equal(instruction.kind, 'return');

  const destinationAfter = await stocksOf(destination);
  assert.equal(destinationAfter.skysteel, destinationBefore.skysteel + 90n);

  const returning = await getFleet(asDb(sql), result.fleet.id);
  assert.equal(returning!.status, 'returning');
  assert.equal(returning!.cargo['skysteel'], '0', 'the holds emptied at the destination');

  await completeReturn(asDb(sql), 'aetherholm-test', result.fleet.id, new Date(returning!.returnsAt!.getTime() + 1000));
  const home = await sql<{ count: string }[]>`
    select count::text from city_ships where city_id = ${origin} and class = 'hauler'
  `;
  assert.equal(home[0]!.count, '1', 'the hauler rejoined its garrison');
  const doneFleet = await getFleet(asDb(sql), result.fleet.id);
  assert.equal(doneFleet!.status, 'done');
});

/* ------------------------------------------------------------------ raids */

test('fleets: a raid loots only what the surviving Haulers hold, and never the Vault floor', { skip }, async () => {
  const { islands } = await world();
  const origin = await city(islands[0]!, ALICE, { stocks: 450n });
  await garrison(origin, { gunship: 10, hauler: 2 });
  const victim = await city(islands[1]!, BOB, { stocks: 400n });
  await sql`insert into buildings (city_id, type, level) values (${victim}, 'vault', 2)`;
  await garrison(victim, { skiff: 1 });

  const result = await launch({
    cityId: origin,
    userId: ALICE,
    mission: 'raid',
    ships: { gunship: 10, hauler: 2 },
    targetIslandId: islands[1]!,
    targetCityId: victim,
    idempotencyKey: 'k-raid',
    correlationId: 't',
  });
  const arrival = new Date(result.fleet.arrivesAt.getTime() + 1000);
  await resolveArrival(asDb(sql), 'aetherholm-test', result.fleet.id, arrival);

  const battles = await sql<
    { id: string; digest: string; result: { winner: string }; mission: string }[]
  >`select id, digest, result, mission from battles`;
  assert.equal(battles.length, 1);
  assert.equal(battles[0]!.mission, 'raid');
  assert.equal(battles[0]!.result.winner, 'attacker');

  const floor = VAULT_PROTECTION_PER_LEVEL * 2n; // vault level 2
  const victimAfter = await stocksOf(victim);
  for (const [resource, held] of Object.entries(victimAfter)) {
    assert.ok(held >= floor, `${resource} was looted below the Vault floor: ${held} < ${floor}`);
  }

  const fleet = await getFleet(asDb(sql), result.fleet.id);
  const capacity = AIRSHIPS.hauler.cargo * BigInt(fleet!.ships['hauler'] ?? '0');
  const aboard = Object.values(fleet!.cargo).reduce((sum, value) => sum + BigInt(value), 0n);
  assert.ok(aboard > 0n, 'the raid carried something home');
  assert.ok(aboard <= capacity, `the holds carry ${aboard} but only fit ${capacity}`);

  // The report is REPLAYABLE: re-resolve from the stored row and the digest must agree.
  const stored = await sql<
    { id: string; seed: string; wind_bp: number; attacker_oob: OrderOfBattle; defender_oob: OrderOfBattle }[]
  >`select id, seed::text, wind_bp, attacker_oob, defender_oob from battles`;
  const input = {
    battleId: stored[0]!.id,
    seed: BigInt(stored[0]!.seed),
    attacker: stored[0]!.attacker_oob,
    defender: stored[0]!.defender_oob,
    windBp: stored[0]!.wind_bp,
  };
  assert.equal(battleDigest(input, resolveBattle(input)), battles[0]!.digest);

  // And the defender heard about it: the outbox carries the battle, keyed by battle id.
  const events = await sql<{ topic: string; key: string; payload: { outcome: string; defenderUserId: string } }[]>`
    select topic, key, payload from outbox where topic = 'aetherholm.battle.resolved'
  `;
  assert.equal(events.length, 1);
  assert.equal(events[0]!.key, battles[0]!.id);
  assert.equal(events[0]!.payload.outcome, 'raided');
  assert.equal(events[0]!.payload.defenderUserId, BOB);
});

test('fleets: §9.3 — two replicas racing one arrival produce exactly one battle', { skip }, async () => {
  const { islands } = await world();
  const origin = await city(islands[0]!, ALICE);
  await garrison(origin, { gunship: 5 });
  const victim = await city(islands[1]!, BOB);
  await garrison(victim, { cutter: 2 });
  const result = await launch({
    cityId: origin,
    userId: ALICE,
    mission: 'raid',
    ships: { gunship: 5 },
    targetIslandId: islands[1]!,
    targetCityId: victim,
    idempotencyKey: 'k-race',
    correlationId: 't',
  });
  const arrival = new Date(result.fleet.arrivesAt.getTime() + 1000);
  // Two "replicas": two concurrent resolutions against the same database. The lease normally
  // keeps them apart; this proves the row guard and battles_fleet_uniq hold even if it did not.
  const [a, b] = await Promise.all([
    resolveArrival(asDb(sql), 'replica-a', result.fleet.id, arrival),
    resolveArrival(asDb(sql), 'replica-b', result.fleet.id, arrival),
  ]);
  const battles = await sql<{ n: number }[]>`select count(*)::int as n from battles`;
  assert.equal(battles[0]!.n, 1, 'exactly one battle, however many replicas raced');
  const outcomes = [a.kind, b.kind].sort();
  assert.deepEqual(outcomes, ['none', 'return'], 'one replica resolved; the other applied nothing');
  const events = await sql<{ n: number }[]>`
    select count(*)::int as n from outbox where topic = 'aetherholm.battle.resolved'
  `;
  assert.equal(events[0]!.n, 1, 'one battle, one event');
});

/* ------------------------------------------------------------------ sieges */

test('fleets: a siege resolves under the plot lease and razes the city, freeing the plot', { skip }, async () => {
  const { islands } = await world();
  const origin = await city(islands[0]!, ALICE);
  await garrison(origin, { ironclad: 3, breaker: 1 });
  const doomed = await city(islands[1]!, BOB, { plot: 3 });
  await garrison(doomed, { cutter: 1 });

  const result = await launch({
    cityId: origin,
    userId: ALICE,
    mission: 'siege',
    ships: { ironclad: 3, breaker: 1 },
    targetIslandId: islands[1]!,
    targetCityId: doomed,
    idempotencyKey: 'k-siege',
    correlationId: 't',
  });
  const arrival = new Date(result.fleet.arrivesAt.getTime() + 1000);
  const instruction = await resolveArrival(asDb(sql), 'aetherholm-test', result.fleet.id, arrival);
  assert.equal(instruction.kind, 'siege', 'arrival hands the battle to the plot lease');
  assert.equal(instruction.islandId, islands[1]!);
  assert.equal(instruction.plot, 3);

  const battlesBefore = await sql<{ n: number }[]>`select count(*)::int as n from battles`;
  assert.equal(battlesBefore[0]!.n, 0, 'no battle happened at arrival — the plot lease owns it');

  const instructions = await resolveSieges(asDb(sql), 'aetherholm-test', islands[1]!, 3, arrival);
  assert.equal(instructions.length, 1);

  const razed = await sql<{ abandoned_at: Date | null }[]>`
    select abandoned_at from cities where id = ${doomed}
  `;
  assert.ok(razed[0]!.abandoned_at, 'the city fell');
  const events = await sql<{ payload: { outcome: string } }[]>`
    select payload from outbox where topic = 'aetherholm.battle.resolved'
  `;
  assert.equal(events[0]!.payload.outcome, 'razed');

  // The plot is genuinely free again: the partial unique no longer sees the razed city.
  const rebuilt = await foundCity(asDb(sql), 'aetherholm-test', {
    userId: ALICE,
    islandId: islands[1]!,
    plot: 3,
    name: 'Ashes',
    correlationId: 't',
  });
  assert.equal(rebuilt.created, true);

  // Idempotent: running the plot's lease again finds nothing left to fight.
  const again = await resolveSieges(asDb(sql), 'aetherholm-test', islands[1]!, 3, arrival);
  assert.equal(again.length, 0);
  const battlesAfter = await sql<{ n: number }[]>`select count(*)::int as n from battles`;
  assert.equal(battlesAfter[0]!.n, 1);
});
