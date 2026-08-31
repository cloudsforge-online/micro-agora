// Schema tests. Prove the migrations apply to SCHEMA_VERSION, every owned table exists, and the
// constraints that carry the design actually fire — by writing the illegal row and matching the
// constraint name in the error. These are the invariants 20-aetherholm.md §6 puts in the schema
// on purpose: they hold against a caller with a database connection, which no handler does.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts';
import { enabled, skip, openDb, migrateTestDb, resetAetherholm, ALICE, BOB } from './testsupport.ts';

let sql: postgres.Sql;

before(async () => {
  if (!enabled) return;
  sql = openDb();
  await migrateTestDb(sql);
});
beforeEach(async () => {
  if (enabled) await resetAetherholm(sql);
});
after(async () => {
  if (sql) await sql.end();
});

test('migrations: applied up to SCHEMA_VERSION', { skip }, async () => {
  const rows = await sql<{ v: number }[]>`select max(version)::int as v from schema_migrations`;
  assert.equal(rows[0]!.v, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
});

test('migrations: every owned table exists', { skip }, async () => {
  for (const table of TABLES) {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables where table_name = ${table}
    `;
    assert.equal(rows[0]!.n, 1, `table ${table} is missing`);
  }
});

/* ------------------------------------------------------------------ fixtures */

async function fixtureIsland(): Promise<{ archipelagoId: string; islandId: string }> {
  const seasons = await sql<{ id: string }[]>`
    insert into seasons (name, seed, status, opened_at, ends_at)
    values ('S', 1, 'open', now(), now() + interval '120 days') returning id
  `;
  const archipelagos = await sql<{ id: string }[]>`
    insert into archipelagos (kind, season_id, name, seed)
    values ('public', ${seasons[0]!.id}, 'A', 1) returning id
  `;
  const islands = await sql<{ id: string }[]>`
    insert into islands (archipelago_id, idx, band) values (${archipelagos[0]!.id}, 0, 'midreach')
    returning id
  `;
  return { archipelagoId: archipelagos[0]!.id, islandId: islands[0]!.id };
}

async function fixtureCity(islandId: string, userId: string, plot = 1): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into cities (
      island_id, user_id, plot, name, aegis_until, aether, cloudstone, skysteel, provisions,
      storage_cap, rate_aether, rate_cloudstone, rate_skysteel, rate_provisions
    ) values (${islandId}, ${userId}, ${plot}, 'C', now() + interval '7 days',
              100, 100, 100, 100, 500, 4, 8, 2, 6)
    returning id
  `;
  return rows[0]!.id;
}

/* ------------------------------------------------------------------ the world */

test('migrations: a second OPEN season is unrepresentable', { skip }, async () => {
  await sql`insert into seasons (name, seed, status, opened_at, ends_at)
            values ('S1', 1, 'open', now(), now() + interval '120 days')`;
  await assert.rejects(
    () => sql`insert into seasons (name, seed, status, opened_at, ends_at)
              values ('S2', 2, 'open', now(), now() + interval '120 days')`,
    /seasons_one_open/,
  );
});

test('migrations: a season seed outside the u64 domain is refused', { skip }, async () => {
  await assert.rejects(
    () => sql`insert into seasons (name, seed, status, opened_at, ends_at)
              values ('S', -1, 'open', now(), now() + interval '120 days')`,
    /seasons_seed_range/,
  );
});

test('migrations: an archipelago cannot be half public, half private', { skip }, async () => {
  // A skerry with no owner is refused…
  await assert.rejects(
    () => sql`insert into archipelagos (kind, name, seed) values ('skerry', 'X', 1)`,
    /archipelagos_ownership_coherent/,
  );
  // …and so is a public archipelago claiming an entitlement.
  const seasons = await sql<{ id: string }[]>`
    insert into seasons (name, seed, status, opened_at, ends_at)
    values ('S', 1, 'open', now(), now() + interval '120 days') returning id
  `;
  await assert.rejects(
    () => sql`insert into archipelagos (kind, season_id, entitlement_id, name, seed)
              values ('public', ${seasons[0]!.id}, 'ent-1', 'X', 1)`,
    /archipelagos_ownership_coherent/,
  );
});

test('migrations: one entitlement can never own two skerries', { skip }, async () => {
  await sql`insert into archipelagos (kind, owner_subject, entitlement_id, name, seed)
            values ('skerry', ${'user:' + ALICE}, 'ent-dup', 'A', 1)`;
  await assert.rejects(
    () => sql`insert into archipelagos (kind, owner_subject, entitlement_id, name, seed)
              values ('skerry', ${'user:' + ALICE}, 'ent-dup', 'B', 2)`,
    /archipelagos_entitlement_uniq/,
  );
});

test('migrations: an island holds exactly 12 plots', { skip }, async () => {
  const { archipelagoId } = await fixtureIsland();
  await assert.rejects(
    () => sql`insert into islands (archipelago_id, idx, band, plots)
              values (${archipelagoId}, 1, 'shallows', 16)`,
    /islands_twelve_plots/,
  );
});

/* ------------------------------------------------------------------ cities */

test('migrations: one city per player per island is unrepresentable, not merely refused', { skip }, async () => {
  const { islandId } = await fixtureIsland();
  await fixtureCity(islandId, ALICE, 1);
  await assert.rejects(
    () => fixtureCity(islandId, ALICE, 2),
    /cities_one_per_player_per_island/,
  );
  // A different player on a different plot is fine.
  await fixtureCity(islandId, BOB, 2);
});

test('migrations: one city per plot', { skip }, async () => {
  const { islandId } = await fixtureIsland();
  await fixtureCity(islandId, ALICE, 3);
  await assert.rejects(() => fixtureCity(islandId, BOB, 3), /cities_one_per_plot/);
});

test('migrations: a settlement can write neither a negative stock nor one above cap', { skip }, async () => {
  const { islandId } = await fixtureIsland();
  const cityId = await fixtureCity(islandId, ALICE);
  // Below zero — the overdraft no handler bug may ever commit.
  await assert.rejects(
    () => sql`update cities set aether = -1 where id = ${cityId}`,
    /cities_stocks_settled_within_caps/,
  );
  // Above cap — the warehouse is the law even for a caller holding a connection.
  await assert.rejects(
    () => sql`update cities set provisions = 501 where id = ${cityId}`,
    /cities_stocks_settled_within_caps/,
  );
});

test('migrations: a plot outside 1..12 is refused', { skip }, async () => {
  const { islandId } = await fixtureIsland();
  await assert.rejects(() => fixtureCity(islandId, ALICE, 13), /cities_plot_range/);
  await assert.rejects(() => fixtureCity(islandId, ALICE, 0), /cities_plot_range/);
});

/* ------------------------------------------------------------------ queues and provisions */

test('migrations: an unknown building type is refused by the schema', { skip }, async () => {
  const { islandId } = await fixtureIsland();
  const cityId = await fixtureCity(islandId, ALICE);
  await assert.rejects(
    () => sql`insert into buildings (city_id, type, level) values (${cityId}, 'casino', 1)`,
    /buildings_type_known/,
  );
});

test('migrations: a queue item idempotency key is unique per city', { skip }, async () => {
  const { islandId } = await fixtureIsland();
  const cityId = await fixtureCity(islandId, ALICE);
  await sql`insert into queue_items (city_id, kind, target, completes_at, idempotency_key)
            values (${cityId}, 'building', 'warehouse', now() + interval '5 minutes', 'k1')`;
  await assert.rejects(
    () => sql`insert into queue_items (city_id, kind, target, completes_at, idempotency_key)
              values (${cityId}, 'building', 'vault', now() + interval '5 minutes', 'k1')`,
    /queue_items_key_uniq/,
  );
});

test('migrations: a done queue item must say when; a queued one must not', { skip }, async () => {
  const { islandId } = await fixtureIsland();
  const cityId = await fixtureCity(islandId, ALICE);
  await assert.rejects(
    () => sql`insert into queue_items (city_id, kind, target, completes_at, idempotency_key, status)
              values (${cityId}, 'building', 'warehouse', now() + interval '1 minute', 'k2', 'done')`,
    /queue_items_done_is_complete/,
  );
});

test('migrations: a provision is unique per entitlement, and its urn must be ours', { skip }, async () => {
  const arch = await sql<{ id: string }[]>`
    insert into archipelagos (kind, owner_subject, entitlement_id, name, seed)
    values ('skerry', 'user:x', 'ent-1', 'A', 1) returning id
  `;
  const archId = arch[0]!.id;
  await sql`insert into provisions (entitlement_id, subject, user_id, sku, scope, archipelago_id, urn)
            values ('ent-1', 'user:x', 'x', 'private_skerry', 'title:t', ${archId},
                    ${'cf:aetherholm:skerry:' + archId})`;
  await assert.rejects(
    () => sql`insert into provisions (entitlement_id, subject, user_id, sku, scope, archipelago_id, urn)
              values ('ent-1', 'user:x', 'x', 'private_skerry', 'title:t', ${archId},
                      ${'cf:aetherholm:skerry:' + archId})`,
    /provisions_entitlement_uniq/,
  );
  await assert.rejects(
    () => sql`insert into provisions (entitlement_id, subject, user_id, sku, scope, archipelago_id, urn)
              values ('ent-2', 'user:x', 'x', 'private_skerry', 'title:t', ${archId}, 'cf:worlds:world:1')`,
    /provisions_urn_shape/,
  );
});

test('migrations: research completes once per player per archipelago', { skip }, async () => {
  const { archipelagoId } = await fixtureIsland();
  await sql`insert into research (archipelago_id, user_id, node) values (${archipelagoId}, ${ALICE}, 'well_lore')`;
  await assert.rejects(
    () => sql`insert into research (archipelago_id, user_id, node) values (${archipelagoId}, ${ALICE}, 'well_lore')`,
    /research_pkey/,
  );
});

test('migrations: there is no money or balance column anywhere (this service holds no money)', { skip }, async () => {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
     where table_schema = 'public'
       and (column_name like '%balance%' or column_name like '%shard%' or column_name like '%amount%')
  `;
  assert.equal(rows.length, 0, `unexpected money column: ${JSON.stringify(rows)}`);
});
