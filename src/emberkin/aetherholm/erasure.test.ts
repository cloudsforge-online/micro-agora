// Right to erasure (rule 6 of docs/ecosystem/03 §2; GDPR Art. 17), end to end.
//
// The load-bearing test in this file is `tracesOf`: a sweep of EVERY base table in the schema for
// the raw uuid, driven off `information_schema` rather than a hand-written list. A per-table
// assertion can only find the columns its author remembered, and the column nobody remembered is
// precisely the one that leaves a deletion request quietly unfulfilled.
//
// The rest is the shape of the compromise: what survives an erasure, why it is allowed to, and the
// database-level guarantees that it can never be turned back into a person.

import { singleNetworkSql } from './server.test.ts'
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type postgres from 'postgres';
import { Lifecycle, postgresProbe } from '@cloudsforge/lifecycle';
import { TokenError, type Principal } from '@cloudsforge/auth';
import { canonicalise } from './battles.ts';
import { ensureLattice } from './lattice.ts';
import { insertIslands } from './seasons.ts';
import { sealSeason } from './sealing.ts';
import { generateIslands } from './world.ts';
import { foundCity } from './cities.ts';
import { USER_DELETED_TOPIC, eraseUser, type ErasureOutcome } from './erasure.ts';
import { SIGNATURE_HEADER, signEvent, withOutbox, type Tx } from './outbox.ts';
import { createServer, type PrincipalVerifier } from './server.ts';
import {
  ALICE,
  BOB,
  TEST_EVENT_SECRET,
  asDb,
  enabled,
  migrateTestDb,
  openDb,
  quietLogger,
  resetAetherholm,
  skip,
  testMetrics,
} from './testsupport.ts';

let sql: postgres.Sql;
let server: Server;
let base: string;

const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    if (token === 'alice') return { kind: 'user', userId: ALICE, handle: 'alice', roles: [] };
    throw new TokenError('unknown token', 'invalid');
  },
};

before(async () => {
  if (!enabled) return;
  sql = openDb(8);
  await migrateTestDb(sql);
  const lifecycle = new Lifecycle();
  lifecycle.addProbe(postgresProbe('postgres', () => sql`select 1`));
  server = createServer({
    lifecycle,
    logger: quietLogger(),
    metrics: testMetrics(),
    verifier,
    sql: singleNetworkSql(asDb(sql)),
    singleNetwork: 'mainnet' as const,
    producer: 'aetherholm',
    queue: { enqueue: async () => {} },
    eventAcceptSecrets: [TEST_EVENT_SECRET],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  lifecycle.markReady();
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  if (enabled) await resetAetherholm(sql);
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (sql) await sql.end();
});

/* ------------------------------------------------------------------ the sweep */

/**
 * Every base table in the schema that still contains the id anywhere in any column.
 *
 * `t::text` casts the whole row — every column, jsonb included — so this finds the id in a payload
 * as readily as in a `uuid`, and the table list comes from the catalogue rather than from
 * `TABLES`, so a table added tomorrow is swept without anybody remembering to add it here.
 */
async function tracesOf(userId: string): Promise<string[]> {
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name
  `;
  const found: string[] = [];
  for (const table of tables) {
    const rows = await sql.unsafe<{ n: number }[]>(
      `select count(*)::int as n from "${table.table_name}" t where t::text like $1`,
      [`%${userId}%`],
    );
    if ((rows[0]?.n ?? 0) > 0) found.push(table.table_name);
  }
  return found;
}

/** The handler, in its own transaction — the shape `withInbox` gives it. */
async function erase(userId: string): Promise<ErasureOutcome> {
  const wrapped = await sql.begin(async (tx) => ({
    value: await eraseUser(tx as unknown as Tx, userId),
  }));
  return (wrapped as unknown as { value: ErasureOutcome }).value;
}

/* ------------------------------------------------------------------ fixtures */

interface World {
  seasonId: string;
  archipelagoId: string;
  islands: string[];
}

async function openWorld(seed = 4242n, islandCount = 12): Promise<World> {
  const created = await withOutbox(asDb(sql), 'aetherholm-test', async (tx: Tx) => {
    const seasons = await tx<{ id: string }[]>`
      insert into seasons (name, seed, status, opened_at, ends_at)
      values ('Season E', ${seed.toString()}, 'open', now() - interval '121 days',
              now() - interval '1 day')
      returning id
    `;
    const archipelagos = await tx<{ id: string }[]>`
      insert into archipelagos (kind, season_id, name, seed)
      values ('public', ${seasons[0]!.id}, 'A', ${seed.toString()})
      returning id
    `;
    await insertIslands(tx, archipelagos[0]!.id, generateIslands(seed, islandCount));
    await ensureLattice(tx, archipelagos[0]!.id);
    return { seasonId: seasons[0]!.id, archipelagoId: archipelagos[0]!.id };
  });
  const islands = await sql<{ id: string }[]>`
    select id from islands where archipelago_id = ${created.archipelagoId} order by idx
  `;
  return { ...created, islands: islands.map((row) => row.id) };
}

const foundAt = (islandId: string, userId: string, plot: number, name = 'Hearthspire') =>
  foundCity(asDb(sql), 'aetherholm-test', { userId, islandId, plot, name, correlationId: 't' });

async function aFleet(input: {
  originCityId: string;
  userId: string;
  targetIslandId: string;
  targetCityId?: string;
  status: 'outbound' | 'done';
  key: string;
}): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into fleets (origin_city_id, user_id, mission, status, target_island_id, target_city_id,
                        departed_at, arrives_at, travel_seconds, return_seconds, aether_lift,
                        idempotency_key)
    values (${input.originCityId}, ${input.userId}, 'raid', ${input.status},
            ${input.targetIslandId}, ${input.targetCityId ?? null},
            now() - interval '2 hours', now() + interval '1 hour', 3600, 3600, 10, ${input.key})
    returning id
  `;
  await sql`insert into fleet_ships (fleet_id, class, count) values (${rows[0]!.id}, 'skiff', 3)`;
  return rows[0]!.id;
}

async function aBattle(input: {
  archipelagoId: string;
  islandId: string;
  fleetId: string;
  attacker: string;
  defender: string;
}): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into battles (archipelago_id, island_id, fleet_id, mission, attacker_user_id,
                         defender_user_id, seed, wind_bp, attacker_oob, defender_oob, result,
                         digest)
    values (${input.archipelagoId}, ${input.islandId}, ${input.fleetId}, 'raid',
            ${input.attacker}, ${input.defender}, 7, 10000,
            ${sql.json({ ships: { skiff: 3 }, bulwarkLevel: 0 })},
            ${sql.json({ ships: { cutter: 2 }, bulwarkLevel: 1 })},
            ${sql.json({ winner: 'attacker', rounds: 2, outcome: 'raided' })},
            ${'ab'.repeat(32)})
    returning id
  `;
  return rows[0]!.id;
}

/**
 * The whole of one player's footprint, so the erasure is exercised against every branch at once.
 *
 * Alice holds three cities, deliberately for three different reasons:
 *   `pinned`    — her own battled fleet originates there, so it cannot be deleted;
 *   `loose`     — nothing points at it, so it can;
 *   `besieged`  — ANOTHER player's fleet is inbound to it, which `fleets.target_city_id` makes a
 *                 reason to keep it that has nothing to do with Alice at all.
 */
async function aliceEverywhere(): Promise<{
  world: World;
  pinned: string;
  loose: string;
  besieged: string;
  bobCity: string;
  battledFleet: string;
  looseFleet: string;
  attackedBattle: string;
  defendedBattle: string;
  allianceId: string;
}> {
  const world = await openWorld();
  const pinned = (await foundAt(world.islands[0]!, ALICE, 1)).city.id;
  const loose = (await foundAt(world.islands[1]!, ALICE, 1, 'Windward Rest')).city.id;
  const besieged = (await foundAt(world.islands[2]!, ALICE, 1)).city.id;
  const bobCity = (await foundAt(world.islands[0]!, BOB, 2)).city.id;

  const battledFleet = await aFleet({
    originCityId: pinned,
    userId: ALICE,
    targetIslandId: world.islands[0]!,
    targetCityId: bobCity,
    status: 'done',
    key: 'k-battled',
  });
  const looseFleet = await aFleet({
    originCityId: loose,
    userId: ALICE,
    targetIslandId: world.islands[3]!,
    status: 'outbound',
    key: 'k-loose',
  });
  const bobBattled = await aFleet({
    originCityId: bobCity,
    userId: BOB,
    targetIslandId: world.islands[0]!,
    targetCityId: pinned,
    status: 'done',
    key: 'k-bob',
  });
  // Bob's unbattled fleet, inbound to a city of Alice's that nothing else holds down.
  await aFleet({
    originCityId: bobCity,
    userId: BOB,
    targetIslandId: world.islands[2]!,
    targetCityId: besieged,
    status: 'outbound',
    key: 'k-bob-inbound',
  });

  const attackedBattle = await aBattle({
    archipelagoId: world.archipelagoId,
    islandId: world.islands[0]!,
    fleetId: battledFleet,
    attacker: ALICE,
    defender: BOB,
  });
  const defendedBattle = await aBattle({
    archipelagoId: world.archipelagoId,
    islandId: world.islands[0]!,
    fleetId: bobBattled,
    attacker: BOB,
    defender: ALICE,
  });

  await sql`
    insert into research (archipelago_id, user_id, node)
    values (${world.archipelagoId}, ${ALICE}, 'well_lore'), (${world.archipelagoId}, ${ALICE}, 'ballast')
  `;
  const alliances = await sql<{ id: string }[]>`
    insert into alliances (archipelago_id, community_id, name, founded_by)
    values (${world.archipelagoId}, ${randomUUID()}, 'The Ninth Wind', ${ALICE})
    returning id
  `;
  await sql`
    insert into alliance_members (alliance_id, archipelago_id, user_id)
    values (${alliances[0]!.id}, ${world.archipelagoId}, ${ALICE}),
           (${alliances[0]!.id}, ${world.archipelagoId}, ${BOB})
  `;
  await sql`
    insert into alliance_claims (island_id, alliance_id, claimed_by)
    values (${world.islands[4]!}, ${alliances[0]!.id}, ${ALICE})
  `;

  // The paid private world, in the ledger spelling, plus its provision row.
  const skerry = await sql<{ id: string }[]>`
    insert into archipelagos (kind, owner_subject, entitlement_id, name, seed)
    values ('skerry', ${'user:' + ALICE}, 'ent-erasure', 'Alice''s Retreat', 77)
    returning id
  `;
  await sql`
    insert into provisions (entitlement_id, subject, user_id, sku, scope, archipelago_id, urn, metadata)
    values ('ent-erasure', ${'user:' + ALICE}, ${ALICE}, 'private_skerry', 'title:aetherholm',
            ${skerry[0]!.id}, ${'cf:aetherholm:skerry:' + skerry[0]!.id},
            ${sql.json({ name: "Alice's Retreat", requestedBy: ALICE })})
  `;

  return {
    world,
    pinned,
    loose,
    besieged,
    bobCity,
    battledFleet,
    looseFleet,
    attackedBattle,
    defendedBattle,
    allianceId: alliances[0]!.id,
  };
}

/* ------------------------------------------------------------------ the erasure itself */

test('erasure: the whole footprint goes, and the sweep finds the id in no column of any table', { skip }, async () => {
  const fixture = await aliceEverywhere();

  // The fixture is only meaningful if the id really was everywhere first.
  const before = await tracesOf(ALICE);
  for (const table of ['cities', 'fleets', 'battles', 'research', 'alliances', 'alliance_members',
    'alliance_claims', 'archipelagos', 'provisions', 'outbox']) {
    assert.ok(before.includes(table), `the fixture should have put alice in ${table}`);
  }

  const outcome = await erase(ALICE);

  assert.deepEqual(await tracesOf(ALICE), [], 'no column of any table may still hold the id');
  assert.equal(outcome.researchDeleted, 2);
  assert.equal(outcome.membershipsDeleted, 1);
  assert.equal(outcome.battlesAnonymised, 2);
  assert.equal(outcome.fleetsDeleted, 1);
  assert.equal(outcome.fleetsAnonymised, 1);
  assert.equal(outcome.citiesDeleted, 1);
  assert.equal(outcome.citiesAnonymised, 2);

  // Bob is untouched, in every sense that matters to Bob.
  const bobTraces = await tracesOf(BOB);
  assert.ok(bobTraces.includes('cities') && bobTraces.includes('battles') && bobTraces.includes('fleets'));

  void fixture;
});

test('erasure: the other commander keeps a coherent battle — their own side still names them', { skip }, async () => {
  const fixture = await aliceEverywhere();
  const digestsBefore = await sql<{ id: string; digest: string }[]>`
    select id, digest from battles order by id
  `;

  await erase(ALICE);

  const battles = await sql<
    {
      id: string;
      attacker_user_id: string;
      defender_user_id: string;
      digest: string;
      attacker_oob: Record<string, unknown>;
      result: Record<string, unknown>;
      attacker_erased_at: Date | null;
      defender_erased_at: Date | null;
    }[]
  >`select * from battles order by id`;
  assert.equal(battles.length, 2, 'a two-sided battle is never deleted by one side leaving');

  const attacked = battles.find((row) => row.id === fixture.attackedBattle)!;
  assert.notEqual(attacked.attacker_user_id, ALICE);
  assert.equal(attacked.defender_user_id, BOB, 'bob still names himself on the side he fought');
  assert.ok(attacked.attacker_erased_at, 'the redacted side is marked');
  assert.equal(attacked.defender_erased_at, null, 'the surviving side is not');

  const defended = battles.find((row) => row.id === fixture.defendedBattle)!;
  assert.equal(defended.attacker_user_id, BOB);
  assert.notEqual(defended.defender_user_id, ALICE);

  // ONE placeholder for the whole erasure — the retained rows stay linked to each other, which is
  // the tradeoff the header declares and the unique indexes require.
  assert.equal(attacked.attacker_user_id, defended.defender_user_id);

  // THE FINDING THIS TEST EXISTS FOR: the digest is taken over the seed, the two orders of battle
  // and the result — never over a user id (src/battles.ts `battleDigest`) — and neither
  // `attacker_oob` nor `result` carries an id or a player-chosen name (they are ship counts,
  // volley damages and an outcome). So the redaction removes ALL the personal data in the row and
  // leaves the report's proof of itself intact. Migration 14's trigger is what keeps it that way.
  for (const battle of battles) {
    const was = digestsBefore.find((row) => row.id === battle.id)!;
    assert.equal(battle.digest, was.digest, 'redacting the commanders may not disturb the digest');
  }
});

test('erasure: an unbattled fleet and its city go; a pinned city is kept, renamed and abandoned', { skip }, async () => {
  const fixture = await aliceEverywhere();
  await erase(ALICE);

  const loose = await sql`select id from fleets where id = ${fixture.looseFleet}`;
  assert.equal(loose.length, 0, 'an in-flight fleet with no battle behind it must not arrive');
  const looseShips = await sql`select 1 from fleet_ships where fleet_id = ${fixture.looseFleet}`;
  assert.equal(looseShips.length, 0, 'fleet_ships cascades — verified, not assumed');
  const looseCity = await sql`select id from cities where id = ${fixture.loose}`;
  assert.equal(looseCity.length, 0);

  const battled = await sql<{ user_id: string; user_erased_at: Date | null }[]>`
    select user_id, user_erased_at from fleets where id = ${fixture.battledFleet}
  `;
  assert.equal(battled.length, 1, 'a battle references its fleet not null; it has to survive');
  assert.notEqual(battled[0]!.user_id, ALICE);
  assert.ok(battled[0]!.user_erased_at);

  const kept = await sql<
    { user_id: string; name: string; abandoned_at: Date | null; user_erased_at: Date | null }[]
  >`select user_id, name, abandoned_at, user_erased_at from cities where id = ${fixture.pinned}`;
  assert.equal(kept.length, 1);
  assert.notEqual(kept[0]!.user_id, ALICE);
  assert.equal(kept[0]!.name, 'Abandoned Holdfast', 'a player-chosen name is free text and goes');
  assert.ok(kept[0]!.abandoned_at, 'the plot frees; the world keeps no phantom settlement');
  assert.ok(kept[0]!.user_erased_at);

  // The branch the referential chain hides: a city nothing of hers holds down, kept alive only
  // because ANOTHER player's fleet is inbound and `fleets.target_city_id` would refuse the delete.
  const besieged = await sql<{ user_id: string }[]>`
    select user_id from cities where id = ${fixture.besieged}
  `;
  assert.equal(besieged.length, 1, "another player's inbound fleet pins the city too");
  assert.notEqual(besieged[0]!.user_id, ALICE);

  // The city's children went with it.
  const orphans = await sql`
    select 1 from buildings b where not exists (select 1 from cities c where c.id = b.city_id)
  `;
  assert.equal(orphans.length, 0, 'buildings/queue_items/city_ships cascade — verified');
});

test('erasure: research and the alliance membership are DELETED; the alliance itself survives', { skip }, async () => {
  const fixture = await aliceEverywhere();
  await erase(ALICE);

  assert.equal((await sql`select 1 from research`).length, 0);
  const members = await sql<{ user_id: string }[]>`select user_id from alliance_members`;
  assert.deepEqual(members.map((row) => row.user_id), [BOB], 'the group continues without her');

  const alliance = await sql<{ name: string; founded_by: string; founder_erased_at: Date | null }[]>`
    select name, founded_by, founder_erased_at from alliances where id = ${fixture.allianceId}
  `;
  assert.equal(alliance.length, 1, 'deleting the row would destroy a live group for its members');
  assert.equal(alliance[0]!.name, 'The Ninth Wind', "the group's own name is not her personal data");
  assert.notEqual(alliance[0]!.founded_by, ALICE);
  assert.ok(alliance[0]!.founder_erased_at);

  const claims = await sql<{ claimed_by: string; claimer_erased_at: Date | null }[]>`
    select claimed_by, claimer_erased_at from alliance_claims
  `;
  assert.equal(claims.length, 1, 'the claim belongs to the alliance, not to the banner-planter');
  assert.notEqual(claims[0]!.claimed_by, ALICE);
  assert.ok(claims[0]!.claimer_erased_at);
});

test('erasure: the purchase record survives in the ledger spelling, and the CHECK pins its shape', { skip }, async () => {
  await aliceEverywhere();
  await erase(ALICE);

  const skerry = await sql<{ owner_subject: string; name: string; entitlement_id: string }[]>`
    select owner_subject, name, entitlement_id from archipelagos where kind = 'skerry'
  `;
  assert.equal(skerry.length, 1, 'a skerry may hold other players\' cities and cannot be nulled');
  assert.match(skerry[0]!.owner_subject, /^erased:[0-9a-f-]{36}$/);
  assert.equal(skerry[0]!.name, 'Private Skerry', 'the name the buyer chose is free text');
  assert.equal(skerry[0]!.entitlement_id, 'ent-erasure', 'what was bought is still recorded');

  const provision = await sql<{ subject: string; user_id: string; urn: string }[]>`
    select subject, user_id, urn from provisions
  `;
  assert.equal(provision.length, 1, "conformance check 5 needs this row: the SAME urn, forever");
  assert.match(provision[0]!.subject, /^erased:/);
  assert.match(provision[0]!.user_id, /^erased:/);
  assert.match(provision[0]!.urn, /^cf:aetherholm:skerry:/);

  // The erased spelling is structurally distinguishable: an owner is `user:…`, or the exact erased
  // form, or nothing at all. Asserted on a FRESH row, because on the erased one the one-way
  // trigger gets there first — a before-update trigger runs ahead of the CHECK, which is the right
  // order but means the CHECK needs a row that has never been erased to be observable at all.
  await assert.rejects(
    () => sql`insert into archipelagos (kind, owner_subject, entitlement_id, name, seed)
              values ('skerry', 'nobody', 'ent-shape', 'X', 1)`,
    /archipelagos_owner_subject_shape/,
  );
  await assert.rejects(
    () => sql`insert into archipelagos (kind, owner_subject, entitlement_id, name, seed)
              values ('skerry', 'erased:not-a-uuid', 'ent-shape-2', 'X', 1)`,
    /archipelagos_owner_subject_shape/,
    'the erased branch is pinned exactly, so it cannot be spoofed by prefix alone',
  );
});

/* ------------------------------------------------------------------ one-way */

test('erasure: an anonymised row can never be re-attributed to a person', { skip }, async () => {
  const fixture = await aliceEverywhere();
  await erase(ALICE);

  await assert.rejects(
    () => sql`update cities set user_id = ${ALICE} where id = ${fixture.pinned}`,
    /never be re-attributed/,
  );
  await assert.rejects(
    () => sql`update cities set user_erased_at = null where id = ${fixture.pinned}`,
    /may never be cleared/,
  );
  await assert.rejects(
    () => sql`update fleets set user_id = ${ALICE} where id = ${fixture.battledFleet}`,
    /never be re-attributed/,
  );
  await assert.rejects(
    () => sql`update alliances set founded_by = ${ALICE} where id = ${fixture.allianceId}`,
    /never be re-attributed/,
  );
  await assert.rejects(
    () => sql`update alliance_claims set claimed_by = ${ALICE}`,
    /never be re-attributed/,
  );
  await assert.rejects(
    () => sql`update archipelagos set owner_subject = ${'user:' + ALICE} where kind = 'skerry'`,
    /never be re-attributed/,
  );
  await assert.rejects(
    () => sql`update provisions set user_id = ${ALICE}`,
    /never be re-attributed/,
  );

  // A city an erasure kept is still a live row for everything else — settlement, razing, aegis.
  // The one-way trigger must not have frozen it whole.
  await sql`update cities set aether = 1 where id = ${fixture.pinned}`;
});

test('erasure: battles stay immutable history, and the exception cannot widen', { skip }, async () => {
  const fixture = await aliceEverywhere();
  await erase(ALICE);

  // Outside the erasure path, nothing has changed about a battle: the refusal is the same one it
  // always was, and it still covers DELETE — including for a second erasure, because deleting the
  // row would take the OTHER commander's history with it.
  await assert.rejects(
    () => sql`update battles set digest = ${'b'.repeat(64)} where id = ${fixture.attackedBattle}`,
    /immutable history/,
  );
  await assert.rejects(() => sql`delete from battles`, /immutable history/);

  // Inside it, the flag is a key to one narrow door: the enumeration in the trigger is what makes
  // "an erasure may not touch anything the digest is taken over" a database fact.
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await tx`select set_config('aetherholm.erasure', 'on', true)`;
        await tx`update battles set result = '{}'::jsonb where id = ${fixture.attackedBattle}`;
      }),
    /redact a battle's commanders and nothing else/,
  );
  // And erasing a side twice is refused, even holding the flag.
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await tx`select set_config('aetherholm.erasure', 'on', true)`;
        await tx`update battles set attacker_user_id = ${BOB} where id = ${fixture.attackedBattle}`;
      }),
    /attacker is erased and may never be re-attributed/,
  );
});

/* ------------------------------------------------------------------ the chronicle */

/** A sealed season whose chronicle names Alice — she holds a spire, so the summary carries her id. */
async function aSealedChronicle(): Promise<{ seasonId: string; digest: string }> {
  const world = await openWorld(9001n);
  const spires = await sql<{ id: string }[]>`
    select id from islands where archipelago_id = ${world.archipelagoId} and is_spire order by idx
  `;
  assert.ok(spires[0], 'the seed must flag at least one spire for this fixture to mean anything');
  await foundAt(spires[0]!.id, ALICE, 1);
  const sealed = await sealSeason(asDb(sql), 'aetherholm-test', world.seasonId);
  assert.ok(sealed);
  return { seasonId: world.seasonId, digest: sealed.digest };
}

test('erasure: a sealed chronicle is redacted, re-hashed, and SAYS it was rewritten', { skip }, async () => {
  const sealedAs = await aSealedChronicle();

  const born = await sql<{ summary: Record<string, unknown>; digest: string }[]>`
    select summary, digest from chronicles where season_id = ${sealedAs.seasonId}
  `;
  assert.match(JSON.stringify(born[0]!.summary), new RegExp(ALICE), 'the summary embeds real ids');
  // The recomputation this file will do after redacting is only meaningful if it reproduces the
  // stored digest exactly when nothing has been redacted. Proven here, before anything changes.
  assert.equal(
    createHash('sha256').update(canonicalise(born[0]!.summary)).digest('hex'),
    born[0]!.digest,
  );

  await erase(ALICE);

  const after = await sql<
    {
      summary: Record<string, unknown>;
      digest: string;
      digest_at_sealing: string | null;
      erasures_applied: number;
    }[]
  >`select summary, digest, digest_at_sealing, erasures_applied
      from chronicles where season_id = ${sealedAs.seasonId}`;
  const row = after[0]!;

  assert.doesNotMatch(JSON.stringify(row.summary), new RegExp(ALICE));
  assert.equal(row.digest_at_sealing, sealedAs.digest, 'what it used to hash to is preserved');
  assert.equal(row.erasures_applied, 1, 'the rewrite counts itself');
  assert.notEqual(row.digest, row.digest_at_sealing, 'a redacted chronicle does not claim to be intact');
  assert.equal(
    createHash('sha256').update(canonicalise(row.summary)).digest('hex'),
    row.digest,
    'the row is self-consistent after the redaction',
  );
  // What is not personal data about her stays: the season, its geography and its rankings.
  assert.equal(row.summary['seasonId'], sealedAs.seasonId);
  assert.ok(Array.isArray(row.summary['spires']));
});

test('erasure: a chronicle is still frozen to everything that is not an erasure', { skip }, async () => {
  const sealedAs = await aSealedChronicle();
  await erase(ALICE);

  // Outside the erasure path — an operator with psql, the case the trigger exists for.
  await assert.rejects(
    () => sql`update chronicles set digest = ${'c'.repeat(64)}`,
    /chronicle is immutable/,
  );
  await assert.rejects(() => sql`delete from chronicles`, /chronicle is immutable/);

  // Inside it, holding the flag is still not a free hand.
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await tx`select set_config('aetherholm.erasure', 'on', true)`;
        await tx`update chronicles set summary = '{}'::jsonb where season_id = ${sealedAs.seasonId}`;
      }),
    /must count itself exactly once/,
  );
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await tx`select set_config('aetherholm.erasure', 'on', true)`;
        await tx`
          update chronicles
             set erasures_applied = erasures_applied + 1, digest_at_sealing = ${'d'.repeat(64)}
           where season_id = ${sealedAs.seasonId}
        `;
      }),
    /it may not change/,
  );
  // And the season it describes was never unlocked.
  await assert.rejects(
    () => sql`update seasons set name = 'Rewritten' where id = ${sealedAs.seasonId}`,
    /sealed history is immutable/,
  );
});

/* ------------------------------------------------------------------ the webhook */

const envelopeFor = (topic: string, userId: string, id = randomUUID()) => ({
  id,
  topic,
  key: userId,
  occurredAt: new Date().toISOString(),
  producer: 'identity',
  version: '1.0',
  actor: `user:${userId}`,
  correlationId: null,
  payload: { userId, tombstoneAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'user_requested' },
});

async function postEvent(raw: string, secret = TEST_EVENT_SECRET): Promise<Response> {
  return fetch(`${base}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signEvent(raw, secret) },
    body: raw,
  });
}

test('events: a signed identity.user.deleted erases, and a redelivery is a duplicate', { skip }, async () => {
  const fixture = await aliceEverywhere();
  const envelope = envelopeFor(USER_DELETED_TOPIC, ALICE);

  const first = await postEvent(JSON.stringify(envelope));
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { status: 'recorded' });
  assert.deepEqual(await tracesOf(ALICE), []);

  const cityAfterFirst = await sql<{ user_id: string }[]>`
    select user_id from cities where id = ${fixture.pinned}
  `;

  // The same event id again: `withInbox` claims (topic, event_id), so the handler never runs a
  // second time and the placeholder is not re-rolled.
  const again = await postEvent(JSON.stringify(envelope));
  assert.equal(again.status, 202);
  assert.deepEqual(await again.json(), { status: 'duplicate' });
  const cityAfterSecond = await sql<{ user_id: string }[]>`
    select user_id from cities where id = ${fixture.pinned}
  `;
  assert.equal(cityAfterSecond[0]!.user_id, cityAfterFirst[0]!.user_id, 'no second erasure ran');
});

test('events: a topic this service does not subscribe to is 202 ignored, never 4xx', { skip }, async () => {
  // A 4xx here would make identity's relay retry the same event for ever.
  const res = await postEvent(JSON.stringify(envelopeFor('identity.user.registered', ALICE)));
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: 'ignored' });
  const rows = await sql`select 1 from inbox`;
  assert.equal(rows.length, 0, 'an ignored event is not claimed');
});

test('events: a bad signature is 403 — and is refused BEFORE the body is parsed', { skip }, async () => {
  const good = JSON.stringify(envelopeFor(USER_DELETED_TOPIC, ALICE));
  const wrongSecret = await postEvent(good, 'a-different-secret-of-sufficient-len');
  assert.equal(wrongSecret.status, 403);
  assert.equal(((await wrongSecret.json()) as { error: { code: string } }).error.code, 'bad_signature');

  const missing = await fetch(`${base}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: good,
  });
  assert.equal(missing.status, 403, 'no signature is a bad signature, not a 401 invitation');

  // THE ORDERING ASSERTION: this body is not JSON at all. A 400 would prove the parser ran on an
  // unauthenticated caller's bytes; a 403 proves the MAC is checked over the raw body first.
  const unparseable = await postEvent('{not json at all', 'a-different-secret-of-sufficient-len');
  assert.equal(unparseable.status, 403);

  // A correctly signed but unparseable body is the caller's fault, and only then is it a 400.
  const signedGarbage = await postEvent('{not json at all');
  assert.equal(signedGarbage.status, 400);
});

test('events: an envelope without a uuid userId is 400, not a silent no-op', { skip }, async () => {
  const envelope = { ...envelopeFor(USER_DELETED_TOPIC, ALICE), payload: { userId: 'nobody' } };
  const res = await postEvent(JSON.stringify(envelope));
  assert.equal(res.status, 400);
  // The inbox row rolls back with the handler, so identity's retry is processed rather than
  // swallowed as a duplicate.
  assert.equal((await sql`select 1 from inbox`).length, 0);
});
