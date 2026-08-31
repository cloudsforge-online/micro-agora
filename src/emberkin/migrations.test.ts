// Schema tests. Prove the migrations apply to SCHEMA_VERSION, every owned table exists, and the
// CHECK constraints actually fire — by inserting the illegal row and matching the constraint name
// in the error.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { migrate, type Sql as DbSql } from '@cloudsforge/db';
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts';
import { ALICE, enabled, skip, openDb, migrateTestDb, resetEmberkin } from './testsupport.ts';

let sql: postgres.Sql;

before(async () => {
  if (!enabled) return;
  sql = openDb();
  await migrateTestDb(sql);
  await resetEmberkin(sql);
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

test('migrations: the saves seed range constraint fires', { skip }, async () => {
  await assert.rejects(
    () => sql`insert into saves (user_id, warden_name, seed, current_region) values (gen_random_uuid(), 'W', -1, 'r')`,
    /saves_seed_range/,
  );
});

test('migrations: the warden name length constraint fires', { skip }, async () => {
  await assert.rejects(
    () => sql`insert into saves (user_id, warden_name, seed, current_region) values (gen_random_uuid(), '', 1, 'r')`,
    /saves_warden_name_length/,
  );
});

test('migrations: the battles outcome constraint fires', { skip }, async () => {
  const u = '11111111-1111-4111-8111-111111111111';
  await sql`insert into saves (user_id, warden_name, seed, current_region) values (${u}, 'W', 1, 'r')`;
  await assert.rejects(
    () => sql`insert into battles (user_id, seed, spec, outcome, idempotency_key) values (${u}, 1, '{}', 'Nonsense', 'k')`,
    /battles_outcome_known/,
  );
  await resetEmberkin(sql);
});

test('migrations: a battle idempotency key is unique per user', { skip }, async () => {
  const u = '22222222-2222-4222-8222-222222222222';
  await sql`insert into saves (user_id, warden_name, seed, current_region) values (${u}, 'W', 1, 'r')`;
  await sql`insert into battles (user_id, seed, spec, outcome, idempotency_key) values (${u}, 1, '{}', 'PlayerWin', 'dup')`;
  await assert.rejects(
    () => sql`insert into battles (user_id, seed, spec, outcome, idempotency_key) values (${u}, 1, '{}', 'PlayerWin', 'dup')`,
    /battles_key_uniq/,
  );
  await resetEmberkin(sql);
});

test('migrations: the season budget-cap constraint fires', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into seasons (slug, name, starts_at, ends_at, reward_budget_wei, rewards_granted_wei)
      values ('s1', 'S', now(), now() + interval '30 days', 100, 200)
    `,
    /seasons_within_budget_wei/,
  );
});

test('migrations: an achievement unlocks once per account', { skip }, async () => {
  const u = '33333333-3333-4333-8333-333333333333';
  await sql`insert into player_achievements (user_id, code, name) values (${u}, 'x', 'X')`;
  await assert.rejects(
    () => sql`insert into player_achievements (user_id, code, name) values (${u}, 'x', 'X')`,
    /player_achievements_uniq/,
  );
  await resetEmberkin(sql);
});

test('migrations: there is no money/balance column anywhere (service holds no money)', { skip }, async () => {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
     where table_schema = 'public'
       and (column_name like '%balance%' or column_name = 'shards' or column_name like '%_balance%')
  `;
  assert.equal(rows.length, 0, `unexpected balance column: ${JSON.stringify(rows)}`);
});

/**
 * micro-org#226. The rename is only finished if NO `_shards` column survives it — one missed
 * column would be a figure still meaning Shards sitting beside three that mean wei, which is the
 * two-spellings-of-one-budget failure the migration argues against in its own header.
 */
test('migrations: no column is still denominated in the retired asset', { skip }, async () => {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
     where table_schema = 'public' and column_name like '%shard%'
  `;
  assert.equal(rows.length, 0, `still denominated in SHARD: ${JSON.stringify(rows)}`);
});

/* ----------------------------------------------- migration 9: Shards become EMBER wei (#226) */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE RENAME IS A CONVERSION, AND A CONVERSION HAS TO BE REPLAYED TO BE BELIEVED.**
 *
 * micro-org#226. Every other test in this file runs against a database the migrator brought
 * straight to the head version, so it can only ever see the world AFTER migration 9 — which means
 * it cannot see the one thing that migration does beyond renaming: multiply Shard-era figures by
 * 4e16 so they mean the same money in a unit with eighteen decimals instead of none.
 *
 * This test replays the upgrade. It brings a scratch schema to version 8, writes the rows a
 * pre-#226 database would hold, applies 9 and reads them back. This is not hypothetical here the
 * way it was in micro-worlds: mainnet holds one real season row (slug 'season-688', budget 100000
 * Shards, measured 2026-08-10) which this migration converts to 4e21 wei.
 *
 * The erasure trigger is asserted for a second reason. `reward_grants_one_way_erasure` fires on
 * the conversion UPDATE itself, once per grant, and an ERASED grant takes the branch that raises.
 * A migration that converted amounts without considering it would fail on exactly the rows the
 * estate is legally required to keep — and only on a database that had ever erased a user, which
 * is to say not in CI and not in staging. So the fixture below erases one of its two grants.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('migration 9 converts Shard figures at 4e16 and keeps the erasure trigger bound', { skip }, async () => {
  const SCHEMA = 'mig9_replay';
  await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  await sql.unsafe(`create schema ${SCHEMA}`);
  // A separate connection whose search_path is the scratch schema: every statement in MIGRATIONS
  // names its tables unqualified, so this is what makes the replay land BESIDE the real schema
  // instead of on top of it.
  const scratch = postgres(process.env['EMBERKIN_TEST_DATABASE_URL']!, {
    max: 1,
    onnotice: () => {},
    connection: { search_path: SCHEMA },
  });
  try {
    const upTo = (version: number) => MIGRATIONS.filter((m) => m.version <= version);
    await migrate(scratch as unknown as DbSql, upTo(8), { service: 'emberkin-mig9-replay' });

    // The shape mainnet actually holds: one active season opened out of the default budget.
    const seasons = await scratch<{ id: string }[]>`
      insert into seasons (slug, name, starts_at, ends_at, status,
                           reward_budget_shards, rewards_granted_shards)
      values ('season-688', 'Emberkin season-688', now(), now() + interval '30 days', 'active',
              100000, 1000)
      returning id
    `;
    const seasonId = seasons[0]!.id;

    // Two grants summing to the season's spend, so the budget CHECK is satisfied before and after.
    // 500 Shards is the old WELCOME_REWARD_SHARDS: USD 5, which is 20 EMBER.
    await scratch`
      insert into reward_grants (season_id, user_id, reason, amount_shards, journal_entry_id,
                                 idempotency_key)
      values (${seasonId}, ${ALICE}, 'season_pass:ent-1', 500, 'entry-1', 'key-1')
    `;
    // The second is an ERASED grant — a random uuid, the erased key form, and the stamp that makes
    // the one-way trigger take its raising branch on any update. This is the row that would have
    // broken a migration written without thinking about migration 8.
    const erasedUser = '99999999-9999-4999-8999-999999999999';
    await scratch`
      insert into reward_grants (season_id, user_id, reason, amount_shards, journal_entry_id,
                                 idempotency_key, user_erased_at)
      values (${seasonId}, ${erasedUser}, 'season_pass:ent-2', 500, 'entry-2',
              ${`emberkin:reward:erased:${erasedUser}`}, now())
    `;

    await migrate(scratch as unknown as DbSql, MIGRATIONS, { service: 'emberkin-mig9-replay' });

    const WEI_PER_SHARD = 40_000_000_000_000_000n;
    const season = await scratch<{ reward_budget_wei: string; rewards_granted_wei: string }[]>`
      select reward_budget_wei, rewards_granted_wei from seasons where id = ${seasonId}
    `;
    // 100,000 Shards is USD 1,000 is 4,000 EMBER — and is exactly what a season opened AFTER this
    // migration gets from the new default, which is the point of using the same rate in both.
    assert.equal(BigInt(season[0]!.reward_budget_wei), 100_000n * WEI_PER_SHARD);
    assert.equal(BigInt(season[0]!.reward_budget_wei), 4_000_000_000_000_000_000_000n);
    assert.equal(BigInt(season[0]!.rewards_granted_wei), 1_000n * WEI_PER_SHARD);

    // BOTH grants convert — the erased one included. Its amount is an accounting record the estate
    // keeps under Art. 17(3)(b), and a record left in the old unit would silently stop reconciling.
    const grants = await scratch<{ amount_wei: string; user_erased_at: Date | null }[]>`
      select amount_wei, user_erased_at from reward_grants order by journal_entry_id
    `;
    assert.equal(grants.length, 2, 'the erased grant is retained, not deleted');
    for (const grant of grants) {
      assert.equal(BigInt(grant.amount_wei), 500n * WEI_PER_SHARD, '20 EMBER, not 500 wei');
    }
    assert.ok(grants[1]!.user_erased_at instanceof Date, 'the erasure stamp survives the conversion');

    // The converted budget and the converted spend still satisfy the renamed CHECK. A conversion
    // that scaled one and not the other would fail here rather than at the next grant.
    await assert.rejects(
      () => scratch`
        update seasons set rewards_granted_wei = reward_budget_wei + 1 where id = ${seasonId}
      `,
      /seasons_within_budget_wei/,
    );

    // And the season total still reconciles against the sum of its grants, in the new unit.
    const reconciled = await scratch<{ granted: string; total: string }[]>`
      select s.rewards_granted_wei::text as granted,
             coalesce(sum(g.amount_wei), 0)::text as total
        from seasons s left join reward_grants g on g.season_id = s.id
       where s.id = ${seasonId}
       group by s.rewards_granted_wei
    `;
    assert.equal(reconciled[0]!.granted, reconciled[0]!.total);

    // The trigger was dropped and recreated by the migration. Proving it is BOUND again is the
    // whole reason to recreate it: erasure being one-way is a promise made to a person, and a
    // trigger that quietly failed to come back would break it with no error anywhere.
    await assert.rejects(
      () => scratch`
        update reward_grants set user_erased_at = null where journal_entry_id = 'entry-2'
      `,
      /an erasure cannot be undone/,
    );
    await assert.rejects(
      () => scratch`
        update reward_grants set user_id = ${ALICE} where journal_entry_id = 'entry-2'
      `,
      /cannot be re-attributed to a person/,
    );

    // The renamed positive-amount CHECK fires under its new name too.
    await assert.rejects(
      () => scratch`
        insert into reward_grants (season_id, user_id, reason, amount_wei, journal_entry_id,
                                   idempotency_key)
        values (${seasonId}, ${ALICE}, 'r', 0, 'entry-3', 'key-3')
      `,
      /reward_grants_amount_wei_positive/,
    );
  } finally {
    await scratch.end({ timeout: 5 });
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  }
});
