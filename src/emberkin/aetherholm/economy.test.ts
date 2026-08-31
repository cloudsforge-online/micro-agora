// The lazy economy, proven from both sides:
//
//   1. PROPERTY: `accrue` can never return a negative stock or one above cap, swept across
//      random (stock, rate, cap, elapsed) quadruples including hostile ones — clocks that step
//      backwards, elapsed centuries, rate zero, stock already at cap.
//   2. SCHEMA: even if `accrue` were wrong, the `cities_stocks_settled_within_caps` CHECK
//      refuses the write (migrations.test.ts proves the CHECK; here we prove settle() and the
//      CHECK agree on the same clamp).
//   3. AGREEMENT: the read path (snapshotAt) and the write path (settle) compute the same
//      number for the same instant — the whole reason both share `accrue`.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import type postgres from 'postgres';
import { accrue, economyRow, settle, snapshotAt, InsufficientStockError } from './economy.ts';
import { enabled, skip, openDb, migrateTestDb, resetAetherholm, ALICE } from './testsupport.ts';

test('economy: accrue never leaves [0, cap] — property, 10k random quadruples', () => {
  for (let round = 0; round < 10_000; round += 1) {
    const cap = BigInt(randomInt(1, 1_000_000));
    const stock = BigInt(randomInt(0, Number(cap) + 1));
    const rate = BigInt(randomInt(0, 10_000));
    // Hostile elapsed values: negative (clock stepped back), zero, sub-second, and centuries.
    const elapsedMs = randomInt(0, 5) === 0 ? -randomInt(0, 10 ** 9) : randomInt(0, 10 ** 13);
    const result = accrue(stock, rate, cap, elapsedMs);
    assert.ok(result >= 0n, `negative stock from (${stock}, ${rate}, ${cap}, ${elapsedMs})`);
    assert.ok(result <= cap, `above cap from (${stock}, ${rate}, ${cap}, ${elapsedMs})`);
    // Monotonic: accrual never destroys what was held (rate >= 0, stock <= cap here).
    assert.ok(result >= (stock > cap ? cap : stock));
  }
});

test('economy: accrual is floor arithmetic, deterministic to the second', () => {
  // 90 minutes at 8/hour from 10 → 10 + 12 = 22.
  assert.equal(accrue(10n, 8n, 1_000n, 90 * 60 * 1000), 22n);
  // 59 seconds at 60/hour → floor(60*59/3600) = 0: sub-quantum time pays nothing…
  assert.equal(accrue(0n, 60n, 1_000n, 59_000), 0n);
  // …and a clock that stepped backwards pays nothing rather than stealing.
  assert.equal(accrue(10n, 8n, 1_000n, -60_000), 10n);
  // The cap clamps.
  assert.equal(accrue(999n, 3_600n, 1_000n, 60 * 60 * 1000), 1_000n);
});

/* ------------------------------------------------------------------ against the database */

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

async function fixtureCity(
  stocks: { aether: bigint; cap: bigint; rate: bigint },
  settledAt: Date,
): Promise<string> {
  const seasons = await sql<{ id: string }[]>`
    insert into seasons (name, seed, status, opened_at, ends_at)
    values ('S', 1, 'open', now(), now() + interval '120 days') returning id
  `;
  const archipelagos = await sql<{ id: string }[]>`
    insert into archipelagos (kind, season_id, name, seed)
    values ('public', ${seasons[0]!.id}, 'A', 1) returning id
  `;
  const islands = await sql<{ id: string }[]>`
    insert into islands (archipelago_id, idx, band) values (${archipelagos[0]!.id}, 0, 'shallows')
    returning id
  `;
  const cities = await sql<{ id: string }[]>`
    insert into cities (
      island_id, user_id, plot, name, aegis_until, last_settled_at,
      aether, cloudstone, skysteel, provisions, storage_cap,
      rate_aether, rate_cloudstone, rate_skysteel, rate_provisions
    ) values (${islands[0]!.id}, ${ALICE}, 1, 'C', now() + interval '7 days', ${settledAt},
              ${stocks.aether.toString()}::bigint, 50, 50, 50, ${stocks.cap.toString()}::bigint,
              ${stocks.rate.toString()}::bigint, 0, 0, 0)
    returning id
  `;
  return cities[0]!.id;
}

test('economy: the read path computes without writing; the write path settles the same number', { skip }, async () => {
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const cityId = await fixtureCity({ aether: 100n, cap: 500n, rate: 12n }, anHourAgo);

  const now = new Date();
  const row = await economyRow(sql, cityId);
  const read = snapshotAt(row!, now);
  assert.equal(read.stocks.aether, 112n, 'an hour at 12/h from 100');

  // Nothing was written by the read.
  const stored = await sql<{ aether: string }[]>`select aether::text from cities where id = ${cityId}`;
  assert.equal(stored[0]!.aether, '100');

  // The write path settles exactly what the read showed.
  const settled = await sql.begin((tx) => settle(tx as never, cityId, now));
  assert.equal(settled.stocks.aether, read.stocks.aether);
  const after = await sql<{ aether: string }[]>`select aether::text from cities where id = ${cityId}`;
  assert.equal(after[0]!.aether, '112');
});

test('economy: accrual clamps at the warehouse cap on settlement', { skip }, async () => {
  const aDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cityId = await fixtureCity({ aether: 490n, cap: 500n, rate: 100n }, aDayAgo);
  const settled = await sql.begin((tx) => settle(tx as never, cityId, new Date()));
  assert.equal(settled.stocks.aether, 500n);
});

test('economy: a spend beyond the settled stock throws and rolls the transaction back', { skip }, async () => {
  const cityId = await fixtureCity({ aether: 100n, cap: 500n, rate: 0n }, new Date());
  await assert.rejects(
    () => sql.begin((tx) => settle(tx as never, cityId, new Date(), { aether: 101n })),
    InsufficientStockError,
  );
  const stored = await sql<{ aether: string }[]>`select aether::text from cities where id = ${cityId}`;
  assert.equal(stored[0]!.aether, '100', 'the failed spend must leave the stock untouched');
});

test('economy: an exact-stock spend succeeds and settles to zero, never below', { skip }, async () => {
  const cityId = await fixtureCity({ aether: 100n, cap: 500n, rate: 0n }, new Date());
  const settled = await sql.begin((tx) => settle(tx as never, cityId, new Date(), { aether: 100n }));
  assert.equal(settled.stocks.aether, 0n);
});

test('economy: two concurrent settlements serialise on the row lock — no lost accrual', { skip }, async () => {
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const cityId = await fixtureCity({ aether: 100n, cap: 10_000n, rate: 60n }, anHourAgo);
  const now = new Date();
  await Promise.all([
    sql.begin((tx) => settle(tx as never, cityId, now)),
    sql.begin((tx) => settle(tx as never, cityId, now)),
  ]);
  // The first settlement moves last_settled_at to `now`; the second sees zero elapsed and adds
  // nothing. 100 + 60 exactly once.
  const stored = await sql<{ aether: string }[]>`select aether::text from cities where id = ${cityId}`;
  assert.equal(stored[0]!.aether, '160');
});
