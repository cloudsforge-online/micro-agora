// Season close and the seal (20-aetherholm.md §9.5): at day 120 the archipelago freezes — the
// chronicle is written, the victors are read off the Aether Spires, and from that commit on an
// UPDATE or DELETE on the sealed season is a DATABASE error, proven here with raw SQL against a
// caller holding a connection. Battles and chronicles are append-only from birth.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { generateIslands } from './world.ts';
import { insertIslands, SeasonSealedError } from './seasons.ts';
import { ensureLattice } from './lattice.ts';
import { canonicalise } from './battles.ts';
import { foundCity, queueWork } from './cities.ts';
import { launchFleet } from './fleets.ts';
import { foundAlliance } from './alliances.ts';
import { getChronicle, listChronicles, listSealedBattles, sealSeason } from './sealing.ts';
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

const CARA = '33333333-3333-4333-8333-333333333333';

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

/** A small PUBLIC season, opened 120 days ago so its closing day has come. */
async function dueSeason(seed = 9001n): Promise<{ seasonId: string; archipelagoId: string; islands: string[] }> {
  const created = await withOutbox(asDb(sql), 'aetherholm-test', async (tx: Tx) => {
    const seasons = await tx<{ id: string }[]>`
      insert into seasons (name, seed, status, opened_at, ends_at)
      values ('Season T', ${seed.toString()}, 'open', now() - interval '121 days', now() - interval '1 day')
      returning id
    `;
    const archipelagos = await tx<{ id: string }[]>`
      insert into archipelagos (kind, season_id, name, seed)
      values ('public', ${seasons[0]!.id}, 'A', ${seed.toString()})
      returning id
    `;
    await insertIslands(tx, archipelagos[0]!.id, generateIslands(seed, 12));
    await ensureLattice(tx, archipelagos[0]!.id);
    return { seasonId: seasons[0]!.id, archipelagoId: archipelagos[0]!.id };
  });
  const islands = await sql<{ id: string }[]>`
    select id from islands where archipelago_id = ${created.archipelagoId} order by idx
  `;
  return { ...created, islands: islands.map((row) => row.id) };
}

async function spireIslandOf(archipelagoId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    select id from islands where archipelago_id = ${archipelagoId} and is_spire order by idx limit 1
  `;
  return rows[0]!.id;
}

const found = (islandId: string, userId: string, plot: number) =>
  foundCity(asDb(sql), 'aetherholm-test', { userId, islandId, plot, name: 'C', correlationId: 't' });

test('sealing: an early bell seals nothing; the due bell seals once, idempotently', { skip }, async () => {
  const { seasonId } = await dueSeason();
  // Pretend it is not due: a "now" before ends_at.
  const early = await sealSeason(asDb(sql), 'aetherholm-test', seasonId, new Date(Date.now() - 3 * 86_400_000));
  assert.equal(early, null, 'a season is never sealed before its day');
  const sealed = await sealSeason(asDb(sql), 'aetherholm-test', seasonId);
  assert.ok(sealed, 'the due season sealed');
  const again = await sealSeason(asDb(sql), 'aetherholm-test', seasonId);
  assert.equal(again, null, 'the second bell finds nothing open');
});

test('sealing: a sealed season refuses UPDATE and DELETE at the database — §9.5, raw SQL', { skip }, async () => {
  const { seasonId } = await dueSeason();
  await sealSeason(asDb(sql), 'aetherholm-test', seasonId);
  // The exact threat the trigger exists for: a caller holding a connection, no handler in sight.
  await assert.rejects(
    () => sql`update seasons set name = 'Rewritten' where id = ${seasonId}`,
    /sealed history is immutable/,
  );
  await assert.rejects(
    () => sql`update seasons set status = 'open', sealed_at = null where id = ${seasonId}`,
    /sealed history is immutable/,
    'not even un-sealing is writable',
  );
  await assert.rejects(
    () => sql`delete from seasons where id = ${seasonId}`,
    /sealed history is immutable/,
  );
  // MUTATION CHECK on the guard itself: the trigger must still exist. If a migration dropped it,
  // this row would quietly become editable, so assert the trigger's presence by name.
  const triggers = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_trigger where tgname = 'seasons_sealed_immutable'
  `;
  assert.equal(triggers[0]!.n, 1);
});

test('sealing: battles and chronicles are append-only from birth', { skip }, async () => {
  const { seasonId, archipelagoId, islands } = await dueSeason();
  // Simplest honest fixture: a city to hang the fleet on, then a battle row.
  await found(islands[0]!, ALICE, 1);
  const fleets = await sql<{ id: string }[]>`
    insert into fleets (origin_city_id, user_id, mission, status, target_island_id,
                        departed_at, arrives_at, travel_seconds, return_seconds, aether_lift,
                        idempotency_key)
    select id, ${ALICE}, 'raid', 'done', ${islands[1]!}, now() - interval '2 hours',
           now() - interval '1 hour', 3600, 3600, 10, 'k-b'
      from cities limit 1
    returning id
  `;
  const digest = 'a'.repeat(64);
  const battles = await sql<{ id: string }[]>`
    insert into battles (archipelago_id, island_id, fleet_id, mission, attacker_user_id,
                         defender_user_id, seed, wind_bp, attacker_oob, defender_oob, result, digest)
    values (${archipelagoId}, ${islands[1]!}, ${fleets[0]!.id}, 'raid', ${ALICE}, ${BOB},
            1, 10000, '{}', '{}', '{}', ${digest})
    returning id
  `;
  await assert.rejects(
    () => sql`update battles set digest = ${'b'.repeat(64)} where id = ${battles[0]!.id}`,
    /immutable history/,
  );
  await assert.rejects(() => sql`delete from battles where id = ${battles[0]!.id}`, /immutable history/);

  await sealSeason(asDb(sql), 'aetherholm-test', seasonId);
  await assert.rejects(
    () => sql`update chronicles set digest = ${'c'.repeat(64)} where season_id = ${seasonId}`,
    /chronicle is immutable/,
  );
  await assert.rejects(() => sql`delete from chronicles where season_id = ${seasonId}`, /chronicle is immutable/);
});

test('sealing: a sealed world refuses play — founding, queueing and launching all 409', { skip }, async () => {
  const { seasonId, islands } = await dueSeason();
  const settled = await found(islands[0]!, ALICE, 1);
  await sql`update cities set aegis_until = founded_at where id = ${settled.city.id}`;
  await sql`insert into city_ships (city_id, class, count) values (${settled.city.id}, 'skiff', 1)`;
  await sealSeason(asDb(sql), 'aetherholm-test', seasonId);

  await assert.rejects(() => found(islands[1]!, BOB, 1), SeasonSealedError);
  await assert.rejects(
    () =>
      queueWork(asDb(sql), 'aetherholm-test', {
        cityId: settled.city.id,
        userId: ALICE,
        kind: 'building',
        target: 'warehouse',
        idempotencyKey: 'k-late',
        correlationId: 't',
      }),
    SeasonSealedError,
  );
  await assert.rejects(
    () =>
      launchFleet(asDb(sql), 'aetherholm-test', {
        cityId: settled.city.id,
        userId: ALICE,
        mission: 'transfer',
        ships: { skiff: 1 },
        targetIslandId: islands[1]!,
        idempotencyKey: 'k-late-fleet',
        correlationId: 't',
      }),
    SeasonSealedError,
  );
});

test('sealing: the Spires crown the victors — an alliance outweighs a lone player, a tie holds for nobody', { skip }, async () => {
  const { seasonId, archipelagoId } = await dueSeason();
  const spire = await spireIslandOf(archipelagoId);
  // Alice and Bob fly one banner with two cities on the spire; Cara stands alone with one.
  await found(spire, ALICE, 1);
  await found(spire, BOB, 2);
  await found(spire, CARA, 3);
  const alliance = await foundAlliance(asDb(sql), 'aetherholm-test', {
    archipelagoId,
    communityId: '44444444-4444-4444-8444-444444444444',
    name: 'The Windward Compact',
    userId: ALICE,
    correlationId: 't',
  });
  await withOutbox(asDb(sql), 'aetherholm-test', async (tx: Tx) => {
    await tx`insert into alliance_members (alliance_id, archipelago_id, user_id)
             values (${alliance.id}, ${archipelagoId}, ${BOB})`;
  });

  const sealed = await sealSeason(asDb(sql), 'aetherholm-test', seasonId);
  assert.ok(sealed);
  const contested = sealed.spires.find((standing) => standing.islandId === spire);
  assert.ok(contested?.holder, 'the spire has a holder');
  assert.equal(contested.holder.kind, 'alliance');
  assert.equal(contested.holder.allianceId, alliance.id);
  assert.equal(contested.holder.communityId, '44444444-4444-4444-8444-444444444444');
  assert.deepEqual(contested.holder.memberUserIds, [ALICE, BOB].sort());

  // Heraldry travels as EVENTS on the outbox — worlds entitlements are granted by consuming
  // them, never by this service writing into worlds.
  const captured = await sql<{ key: string; payload: { userIds: string[]; allianceId: string } }[]>`
    select key, payload from outbox where topic = 'aetherholm.spire.captured'
  `;
  const ours = captured.find((event) => event.key === spire);
  assert.ok(ours, 'the captured spire was announced');
  assert.equal(ours.payload.allianceId, alliance.id);
  assert.deepEqual([...ours.payload.userIds].sort(), [ALICE, BOB].sort());
  const sealedEvents = await sql<{ payload: { digest: string; victors: unknown[] } }[]>`
    select payload from outbox where topic = 'aetherholm.season.sealed'
  `;
  assert.equal(sealedEvents.length, 1);
  assert.equal(sealedEvents[0]!.payload.digest, sealed.digest);
  assert.ok(sealedEvents[0]!.payload.victors.length >= 1);
});

test('sealing: a contested tie crowns nobody', { skip }, async () => {
  const { seasonId, archipelagoId } = await dueSeason(7777n);
  const spire = await spireIslandOf(archipelagoId);
  await found(spire, ALICE, 1);
  await found(spire, BOB, 2);
  const sealed = await sealSeason(asDb(sql), 'aetherholm-test', seasonId);
  const contested = sealed!.spires.find((standing) => standing.islandId === spire);
  assert.ok(contested, 'the spire is in the chronicle');
  assert.equal(contested.holder, null, 'one city each is a tie, and a tie holds for nobody');
});

test('sealing: the chronicle is checkable — its digest recomputes from the stored summary', { skip }, async () => {
  const { seasonId, islands } = await dueSeason();
  await found(islands[0]!, ALICE, 1);
  const sealed = await sealSeason(asDb(sql), 'aetherholm-test', seasonId);
  const chronicle = await getChronicle(asDb(sql), seasonId);
  assert.ok(chronicle);
  assert.equal(chronicle.digest, sealed!.digest);
  assert.equal(
    createHash('sha256').update(canonicalise(chronicle.summary)).digest('hex'),
    chronicle.digest,
    'the stored digest is the sha256 of the canonicalised stored summary',
  );
  const summary = chronicle.summary as { cities: number; battles: number };
  assert.equal(summary.cities, 1);
  assert.equal(summary.battles, 0);
});

test('sealing: the chronicle lists SEALED seasons only — a live season never leaks', { skip }, async () => {
  const { seasonId } = await dueSeason();
  assert.equal((await listChronicles(asDb(sql))).length, 0, 'nothing sealed, nothing listed');
  assert.equal(await getChronicle(asDb(sql), seasonId), null);
  assert.equal(await listSealedBattles(asDb(sql), seasonId), null);

  await sealSeason(asDb(sql), 'aetherholm-test', seasonId);
  // The successor season, live — allowed to exist only now the old one is sealed.
  const live = await sql<{ id: string }[]>`
    insert into seasons (name, seed, status, opened_at, ends_at)
    values ('Live', 2, 'open', now(), now() + interval '120 days')
    returning id
  `;
  const listed = await listChronicles(asDb(sql));
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.seasonId, seasonId);
  assert.equal(await getChronicle(asDb(sql), live[0]!.id), null, 'the live season is not history');
  assert.equal(await listSealedBattles(asDb(sql), live[0]!.id), null);
  const battles = await listSealedBattles(asDb(sql), seasonId);
  assert.ok(battles);
  assert.equal(battles.length, 0);
});
