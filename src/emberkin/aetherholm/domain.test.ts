// City play at the domain layer: founding (idempotent by constraint), queueing (settle-then-
// charge, replay on the Idempotency-Key, slot limits), and completion (leased job semantics,
// applied exactly once, economy recomputed AFTER the past is settled at the old rates).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
import {
  IdempotencyConflictError,
  PlotTakenError,
  QueueFullError,
  ValidationError,
  completeDue,
  foundCity,
  getCity,
  listCitiesFor,
  queueWork,
  CITY_FOUNDED_TOPIC,
  BUILDING_COMPLETED_TOPIC,
  RESEARCH_COMPLETED_TOPIC,
} from './cities.ts';
import { InsufficientStockError } from './economy.ts';
import { ensureOpenSeason, listIslands, openSeason, SEASON_OPENED_TOPIC } from './seasons.ts';
import { BASE_BUILD_SLOTS, STARTING_STOCKS } from './content.ts';
import {
  enabled,
  skip,
  openDb,
  migrateTestDb,
  resetAetherholm,
  asDb,
  ALICE,
  BOB,
} from './testsupport.ts';

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

test('seasons: the islands a founder reads carry the spire flag the map must mark', { skip }, async () => {
  // The column existed since the lattice migration and the summary never selected it, so no
  // client could mark a spire on any map — the one thing the archipelago screen exists to show.
  // Found by micro-aetherholm-web; this pins the read against the stored truth.
  const season = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  const islands = await listIslands(asDb(sql), season.archipelagoId);
  const served = islands.filter((i) => i.spire).length;
  assert.ok(served >= 1, 'a generated world has spires, and the read must surface them');
  const stored = await sql<{ n: number }[]>`
    select count(*)::int as n from islands where archipelago_id = ${season.archipelagoId} and is_spire
  `;
  assert.equal(served, stored[0]!.n, 'the served flags are exactly the stored ones');
});

async function firstIsland(): Promise<string> {
  const season = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  const islands = await listIslands(asDb(sql), season.archipelagoId);
  return islands[0]!.id;
}

test('seasons: ensureOpenSeason creates one season with ~200 islands, then converges', { skip }, async () => {
  const [a, b] = await Promise.all([
    ensureOpenSeason(asDb(sql), 'aetherholm', new Date()),
    ensureOpenSeason(asDb(sql), 'aetherholm', new Date()),
  ]);
  assert.equal(a.id, b.id, 'two racing runs must converge on one season');
  const seasons = await sql<{ n: number }[]>`select count(*)::int as n from seasons where status = 'open'`;
  assert.equal(seasons[0]!.n, 1);
  const islands = await sql<{ n: number }[]>`select count(*)::int as n from islands`;
  assert.equal(islands[0]!.n, 200);
  const current = await openSeason(asDb(sql));
  assert.equal(current!.id, a.id);
  const events = await sql<{ n: number }[]>`
    select count(*)::int as n from outbox where topic = ${SEASON_OPENED_TOPIC}
  `;
  assert.equal(events[0]!.n, 1, 'exactly one season.opened event');
});

test('cities: founding writes the city, its skyhall, the aegis and the event; refounding replays', { skip }, async () => {
  const islandId = await firstIsland();
  const first = await foundCity(asDb(sql), 'aetherholm', {
    userId: ALICE,
    islandId,
    plot: 1,
    name: 'Aerie',
    correlationId: 'r1',
  });
  assert.equal(first.created, true);
  assert.deepEqual([...first.city.buildings], [{ type: 'skyhall', level: 1 }]);
  assert.equal(first.city.stocks['aether'], STARTING_STOCKS.aether.toString());
  assert.ok(first.city.aegisUntil.getTime() > Date.now() + 6.9 * 24 * 60 * 60 * 1000);

  // The retry: same player, same island — the partial unique makes the second city impossible,
  // and the answer is the existing one, not an error.
  const retry = await foundCity(asDb(sql), 'aetherholm', {
    userId: ALICE,
    islandId,
    plot: 4,
    name: 'Aerie Again',
    correlationId: 'r2',
  });
  assert.equal(retry.created, false);
  assert.equal(retry.city.id, first.city.id);

  const events = await sql<{ n: number }[]>`
    select count(*)::int as n from outbox where topic = ${CITY_FOUNDED_TOPIC}
  `;
  assert.equal(events[0]!.n, 1, 'the replay must not emit a second founded event');
});

test('cities: a taken plot refuses with PlotTakenError; another plot works', { skip }, async () => {
  const islandId = await firstIsland();
  await foundCity(asDb(sql), 'aetherholm', {
    userId: ALICE, islandId, plot: 1, name: 'A', correlationId: 'r1',
  });
  await assert.rejects(
    () => foundCity(asDb(sql), 'aetherholm', {
      userId: BOB, islandId, plot: 1, name: 'B', correlationId: 'r2',
    }),
    PlotTakenError,
  );
  const ok = await foundCity(asDb(sql), 'aetherholm', {
    userId: BOB, islandId, plot: 2, name: 'B', correlationId: 'r3',
  });
  assert.equal(ok.created, true);
  const list = await listCitiesFor(asDb(sql), BOB);
  assert.equal(list.length, 1);
});

test('cities: queueing charges settled stocks once; the retry REPLAYS and charges nothing', { skip }, async () => {
  const islandId = await firstIsland();
  const { city } = await foundCity(asDb(sql), 'aetherholm', {
    userId: ALICE, islandId, plot: 1, name: 'A', correlationId: 'r1',
  });

  const submit = () =>
    queueWork(asDb(sql), 'aetherholm', {
      cityId: city.id,
      userId: ALICE,
      kind: 'building',
      target: 'warehouse',
      idempotencyKey: 'k-house',
      correlationId: 'r2',
    });

  const first = await submit();
  assert.equal(first.replayed, false);
  const chargedTo = first.stocks['cloudstone'];

  const second = await submit();
  assert.equal(second.replayed, true);
  assert.equal(second.item.id, first.item.id, 'the replay must return the same queue item');
  assert.equal(second.stocks['cloudstone'], chargedTo, 'the replay must not charge again');

  const items = await sql<{ n: number }[]>`select count(*)::int as n from queue_items`;
  assert.equal(items[0]!.n, 1);
});

test('cities: the same key with a DIFFERENT body is an idempotency conflict, not a silent replay', { skip }, async () => {
  const islandId = await firstIsland();
  const { city } = await foundCity(asDb(sql), 'aetherholm', {
    userId: ALICE, islandId, plot: 1, name: 'A', correlationId: 'r1',
  });
  await queueWork(asDb(sql), 'aetherholm', {
    cityId: city.id, userId: ALICE, kind: 'building', target: 'warehouse',
    idempotencyKey: 'k1', correlationId: 'r2',
  });
  await assert.rejects(
    () => queueWork(asDb(sql), 'aetherholm', {
      cityId: city.id, userId: ALICE, kind: 'building', target: 'vault',
      idempotencyKey: 'k1', correlationId: 'r3',
    }),
    IdempotencyConflictError,
  );
});

test('cities: an unaffordable queue refuses before writing anything', { skip }, async () => {
  const islandId = await firstIsland();
  const { city } = await foundCity(asDb(sql), 'aetherholm', {
    userId: ALICE, islandId, plot: 1, name: 'A', correlationId: 'r1',
  });
  // Drain the treasury.
  await sql`update cities set aether = 0, cloudstone = 0, skysteel = 0, provisions = 0,
            last_settled_at = now() where id = ${city.id}`;
  await assert.rejects(
    () => queueWork(asDb(sql), 'aetherholm', {
      cityId: city.id, userId: ALICE, kind: 'building', target: 'warehouse',
      idempotencyKey: 'k1', correlationId: 'r2',
    }),
    InsufficientStockError,
  );
  const items = await sql<{ n: number }[]>`select count(*)::int as n from queue_items`;
  assert.equal(items[0]!.n, 0, 'a refused spend must leave no queue item');
});

test('cities: the build queue holds BASE_BUILD_SLOTS items and refuses the next', { skip }, async () => {
  const islandId = await firstIsland();
  const { city } = await foundCity(asDb(sql), 'aetherholm', {
    userId: ALICE, islandId, plot: 1, name: 'A', correlationId: 'r1',
  });
  await sql`update cities set aether = 500, cloudstone = 500, skysteel = 500, provisions = 500,
            last_settled_at = now() where id = ${city.id}`;
  for (let slot = 0; slot < BASE_BUILD_SLOTS; slot += 1) {
    await queueWork(asDb(sql), 'aetherholm', {
      cityId: city.id, userId: ALICE, kind: 'building', target: 'terrace_farm',
      idempotencyKey: `k-${slot}`, correlationId: `r-${slot}`,
    });
  }
  await assert.rejects(
    () => queueWork(asDb(sql), 'aetherholm', {
      cityId: city.id, userId: ALICE, kind: 'building', target: 'vault',
      idempotencyKey: 'k-over', correlationId: 'r-over',
    }),
    QueueFullError,
  );
});

test('cities: queued items run sequentially — the second starts when the first completes', { skip }, async () => {
  const islandId = await firstIsland();
  const { city } = await foundCity(asDb(sql), 'aetherholm', {
    userId: ALICE, islandId, plot: 1, name: 'A', correlationId: 'r1',
  });
  await sql`update cities set aether = 500, cloudstone = 500, skysteel = 500, provisions = 500,
            last_settled_at = now() where id = ${city.id}`;
  const first = await queueWork(asDb(sql), 'aetherholm', {
    cityId: city.id, userId: ALICE, kind: 'building', target: 'terrace_farm',
    idempotencyKey: 'k1', correlationId: 'r2',
  });
  const second = await queueWork(asDb(sql), 'aetherholm', {
    cityId: city.id, userId: ALICE, kind: 'building', target: 'warehouse',
    idempotencyKey: 'k2', correlationId: 'r3',
  });
  assert.ok(
    second.item.startedAt.getTime() >= first.item.completesAt.getTime(),
    'the second item must not start before the first finishes',
  );
});

test('cities: completion applies the level, recomputes the economy, emits the event — once', { skip }, async () => {
  const islandId = await firstIsland();
  const { city } = await foundCity(asDb(sql), 'aetherholm', {
    userId: ALICE, islandId, plot: 1, name: 'A', correlationId: 'r1',
  });
  await queueWork(asDb(sql), 'aetherholm', {
    cityId: city.id, userId: ALICE, kind: 'building', target: 'warehouse',
    idempotencyKey: 'k1', correlationId: 'r2',
  });
  // Time-travel the queue item into the past, then complete.
  await sql`update queue_items set started_at = now() - interval '2 hours',
            completes_at = now() - interval '1 hour' where city_id = ${city.id}`;

  const future = new Date();
  const [nextA, nextB] = await Promise.all([
    completeDue(asDb(sql), 'aetherholm', city.id, future),
    completeDue(asDb(sql), 'aetherholm', city.id, future),
  ]);
  assert.equal(nextA ?? nextB ?? null, null, 'nothing further is queued');

  const read = await getCity(asDb(sql), city.id);
  const warehouse = read!.buildings.find((building) => building.type === 'warehouse');
  assert.equal(warehouse?.level, 1, 'racing completions must apply the level exactly once');
  assert.equal(read!.storageCap, '900', 'base 500 + 400 for warehouse level 1');

  const events = await sql<{ n: number }[]>`
    select count(*)::int as n from outbox where topic = ${BUILDING_COMPLETED_TOPIC}
  `;
  assert.equal(events[0]!.n, 1, 'exactly one building.completed event');
});

test('cities: research queues per city, completes per player per archipelago, and refuses repeats', { skip }, async () => {
  const islandId = await firstIsland();
  const { city } = await foundCity(asDb(sql), 'aetherholm', {
    userId: ALICE, islandId, plot: 1, name: 'A', correlationId: 'r1',
  });
  await queueWork(asDb(sql), 'aetherholm', {
    cityId: city.id, userId: ALICE, kind: 'research', target: 'well_lore',
    idempotencyKey: 'k1', correlationId: 'r2',
  });
  await sql`update queue_items set started_at = now() - interval '2 hours',
            completes_at = now() - interval '1 hour' where city_id = ${city.id}`;
  await completeDue(asDb(sql), 'aetherholm', city.id, new Date());

  const rows = await sql<{ node: string }[]>`select node from research where user_id = ${ALICE}`;
  assert.deepEqual(rows.map((row) => row.node), ['well_lore']);
  const events = await sql<{ n: number }[]>`
    select count(*)::int as n from outbox where topic = ${RESEARCH_COMPLETED_TOPIC}
  `;
  assert.equal(events[0]!.n, 1);

  // Researching it again — already completed — is a validation refusal.
  await assert.rejects(
    () => queueWork(asDb(sql), 'aetherholm', {
      cityId: city.id, userId: ALICE, kind: 'research', target: 'well_lore',
      idempotencyKey: 'k2', correlationId: 'r3',
    }),
    ValidationError,
  );
});
