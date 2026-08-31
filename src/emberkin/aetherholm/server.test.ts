// End-to-end HTTP tests through the real server: health, metrics, authentication boundaries,
// founding and reading a city with computed stocks, and the Idempotency-Key discipline on the
// queue routes. The title contract has its own file — titlecontract.test.ts — because it is a
// contract with another service and deserves its own record.

import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { RESEARCH_NODES, buildingCost, buildingDurationSeconds, researchCost, researchDurationSeconds } from './content.ts';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type postgres from 'postgres';
import { Lifecycle, postgresProbe } from '@cloudsforge/lifecycle';
import { TokenError, type Principal } from '@cloudsforge/auth';
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs';
import { createServer, type PrincipalVerifier } from './server.ts';
import { CITY_QUEUE_KIND } from './jobs.ts';
import { ensureOpenSeason, insertIslands, listIslands } from './seasons.ts';
import { generateIslands } from './world.ts';
import { sealSeason } from './sealing.ts';
import { withOutbox } from './outbox.ts';
import {
  enabled,
  skip,
  openDb,
  migrateTestDb,
  resetAetherholm,
  asDb,
  quietLogger,
  testMetrics,
  ALICE,
  BOB,
  CAROL,
  TEST_EVENT_SECRET,
} from './testsupport.ts';

let sql: postgres.Sql;
let server: Server;
let base: string;
let queue: JobQueue;

/**
 * The verifier fake speaks the estate's Principal vocabulary:
 *   'alice' / 'bob'   — players
 *   'carol'           — a player who owns nothing and guests nowhere. `admin` IS bob, so bob
 *                       cannot stand for "a refused stranger" without the test passing for the
 *                       wrong reason (micro-org#341).
 *   'platform'        — a service token carrying aetherholm:provision (worlds' shape)
 *   'reader'          — a service token with aetherholm:read only
 *   anything else     — TokenError, exactly as a forged JWT fails signature verification
 */
const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    if (token === 'alice') return { kind: 'user', userId: ALICE, handle: 'alice', roles: [] };
    if (token === 'bob') return { kind: 'user', userId: BOB, handle: 'bob', roles: [] };
    if (token === 'carol') return { kind: 'user', userId: CAROL, handle: 'carol', roles: [] };
    if (token === 'admin') {
      return { kind: 'user', userId: BOB, handle: 'op', roles: ['admin'] };
    }
    if (token === 'platform') {
      return { kind: 'service', service: 'worlds', scopes: ['aetherholm:provision'] };
    }
    if (token === 'reader') return { kind: 'service', service: 'hub-api', scopes: ['aetherholm:read'] };
    throw new TokenError('unknown token', 'invalid');
  },
};

before(async () => {
  if (!enabled) return;
  sql = openDb(8);
  await migrateTestDb(sql);
  queue = new JobQueue(sql as unknown as JobsSql, { owner: 'test' });
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
    queue,
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

const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function anIsland(): Promise<string> {
  const season = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  const islands = await listIslands(asDb(sql), season.archipelagoId);
  return islands[0]!.id;
}

test('server: /livez and /readyz answer', { skip }, async () => {
  assert.equal((await fetch(`${base}/livez`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
});

test('server: /metrics is prometheus text', { skip }, async () => {
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
});

test('server: an unauthenticated read is 401 and carries the request id', { skip }, async () => {
  const res = await fetch(`${base}/v1/cities`);
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: { code: string; requestId: string } };
  assert.equal(body.error.code, 'unauthenticated');
  assert.equal(body.error.requestId, res.headers.get('x-request-id'));
});

test('server: the season and its islands read back; a service needs aetherholm:read', { skip }, async () => {
  await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  const season = await fetch(`${base}/v1/seasons/current`, { headers: auth('alice') });
  assert.equal(season.status, 200);
  const body = (await season.json()) as { archipelagoId: string; seed: string; endsAt: string };
  assert.match(body.seed, /^\d+$/, 'the seed travels as a decimal string, never a float');

  const islands = await fetch(`${base}/v1/archipelagos/${body.archipelagoId}/islands`, {
    headers: auth('reader'),
  });
  assert.equal(islands.status, 200);
  const listed = (await islands.json()) as { islands: { band: string; freePlots: number }[] };
  assert.equal(listed.islands.length, 200);
  assert.equal(listed.islands[0]!.freePlots, 12);

  // The platform's provision-scoped token is NOT a read token.
  const refused = await fetch(`${base}/v1/seasons/current`, { headers: auth('platform') });
  assert.equal(refused.status, 403);
});

/**
 * The pair micro-org#332 was opened about: a skerry that is bought must be findable by the person
 * who bought it. Written as ONE journey deliberately — provision through the real contract route,
 * then read through the user route, then dereference the id it hands back — because the defect was
 * never in either half alone. `POST /v1/provision` worked; the buyer simply had nowhere to learn
 * the id it had minted. So the assertion that matters is the last one: the id from this list is
 * accepted by /v1/archipelagos/:id/islands.
 */
async function provision(entitlementId: string, subject: string, name: string): Promise<void> {
  const res = await fetch(`${base}/v1/provision`, {
    method: 'POST',
    headers: { ...auth('platform'), 'idempotency-key': entitlementId },
    body: JSON.stringify({
      entitlementId,
      subject: `user:${subject}`,
      userId: subject,
      sku: 'private_skerry',
      scope: 'title:aetherholm-title-id',
      metadata: { name },
    }),
  });
  assert.equal(res.status, 201, `provision ${entitlementId}: ${res.status}`);
}

test('server: a buyer lists the skerries they own and can open one', { skip }, async () => {
  // A public season exists throughout: its archipelago is owned by nobody, and must not appear in
  // anybody's list. That is the whole difference between this route and /v1/seasons/current.
  const season = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  await provision('ent-332-a', ALICE, 'The Gullery');
  await provision('ent-332-b', ALICE, 'Windward Rock');
  await provision('ent-332-c', BOB, 'The Cormorant');

  const mine = await fetch(`${base}/v1/archipelagos`, { headers: auth('alice') });
  assert.equal(mine.status, 200);
  const owned = ((await mine.json()) as {
    archipelagos: { id: string; kind: string; name: string; urn: string; createdAt: string }[];
  }).archipelagos;
  assert.equal(owned.length, 2, "both of alice's skerries, and nobody else's, and not the season");
  assert.deepEqual(
    owned.map((a) => a.name).sort(),
    ['The Gullery', 'Windward Rock'],
    'the name the buyer chose at purchase is what names the world back to them',
  );
  for (const a of owned) {
    assert.equal(a.kind, 'skerry');
    assert.equal(a.urn, `cf:aetherholm:skerry:${a.id}`, 'the urn worlds was told, not one re-derived');
    assert.ok(!Number.isNaN(Date.parse(a.createdAt)));
  }
  assert.ok(
    !owned.some((a) => a.id === season.archipelagoId),
    'the public season world has no owner and belongs to no list',
  );

  // The point of the whole route: an id from here is an id the rest of the surface accepts.
  const islands = await fetch(`${base}/v1/archipelagos/${owned[0]!.id}/islands`, {
    headers: auth('alice'),
  });
  assert.equal(islands.status, 200);
  assert.equal(((await islands.json()) as { islands: unknown[] }).islands.length, 12);

  // The cities/battles owner pattern, verbatim: another player's list needs admin, a service must
  // name whose list it wants, and the provision scope is not a read scope.
  assert.equal((await fetch(`${base}/v1/archipelagos?userId=${BOB}`, { headers: auth('alice') })).status, 403);
  const operator = await fetch(`${base}/v1/archipelagos?userId=${BOB}`, { headers: auth('admin') });
  assert.equal(operator.status, 200);
  assert.equal(((await operator.json()) as { archipelagos: unknown[] }).archipelagos.length, 1);
  assert.equal((await fetch(`${base}/v1/archipelagos`, { headers: auth('reader') })).status, 400);
  assert.equal(
    (await fetch(`${base}/v1/archipelagos?userId=${ALICE}`, { headers: auth('reader') })).status,
    200,
  );
  assert.equal(
    (await fetch(`${base}/v1/archipelagos?userId=${ALICE}`, { headers: auth('platform') })).status,
    403,
  );
  assert.equal((await fetch(`${base}/v1/archipelagos`)).status, 401);
});

/**
 * The ORDER of that list, pinned — the one part of #332 nothing was grading.
 *
 * The case above sorts the names before comparing them, deliberately, because it is asking WHICH
 * worlds come back and not in what sequence. That left `order by a.created_at desc, a.id` in
 * `listArchipelagosOwnedBy` unmeasured: deleting the whole clause on 2026-08-10 kept all 168 tests
 * green. A clause no test can fail is the defect class this suite exists to catch, so here it is
 * graded directly.
 *
 * It is worth grading because the order is READ BY A PERSON. `aetherholm-web`'s map page renders
 * this list straight into the world switcher and imposes no order of its own, so whatever arrives
 * is the menu an owner sees. Unordered, the planner may return a heap in any sequence it likes and
 * may change its mind after a VACUUM or a plan flip — a menu that reshuffles between two visits,
 * which is a worse bug than a wrong first row because nothing about it looks broken.
 *
 * Two keys, so two assertions:
 *
 *   - `created_at desc` is the one a buyer feels. The world they just paid for is the one they
 *     came to look at.
 *   - `id` is the tie-break, and it is not decoration. Two entitlements the bridge delivers inside
 *     one clock tick share a `created_at`, and without a second key such a pair is ordered by
 *     nothing at all. The tie is manufactured with an UPDATE, because the bridge cannot be asked to
 *     race on demand and a test that waited for a real race would be a test that usually proves
 *     nothing.
 *
 * ## Why both fixtures are sixteen rows, and this is the whole point of the case
 *
 * Both halves were first written with two rows, and BOTH killed their mutation on roughly half of
 * their runs (measured 2026-08-10, five runs each: two kills, then zero). That is not a proof, it
 * is a coin flip wearing a green tick — the exact "check that cannot fail" this suite is supposed
 * to catch, arrived at while writing a check meant to catch one.
 *
 * The reason is `gen_random_uuid`. With two rows, `order by a.id` agrees with `created_at desc` at
 * random half the time, and a tied pair comes back ascending at random half the time, so each
 * mutant survived whenever the dice said so. Steering the physical layout did not help either:
 * this query JOINS `provisions`, so the output order belongs to the join algorithm and not to the
 * heap, and nothing a test does to tuple placement binds it.
 *
 * So the fixtures are SIZED rather than steered. Sixteen rows have 16! orderings and exactly one of
 * them is the one asserted, so a mutant survives about one run in 20,922,789,888,000 instead of one
 * in two. Sixteen is the smallest round size that buys that; the cap is 100
 * (`OWNED_ARCHIPELAGO_LIMIT`), so eighteen rows also read back whole and prove the cap is not
 * trimming the fixture out from under the assertion.
 *
 * The sixteen are inserted directly, because this case is about the ORDER BY and not about
 * provisioning — the case above already drives provisioning through the real route, and the two
 * real skerries here ride along to prove that provisioned rows sort by the same rule as inserted
 * ones. `urn` is null on the inserted sixteen and is not read here.
 *
 * Mutation-proved 2026-08-10, five runs each, killed on every run: `order by a.id` alone reddens
 * the newest-first assertion, `order by a.created_at desc` alone reddens the tie-break assertion,
 * and deleting the clause outright reddens both.
 */
test('server: the owner list is ordered newest first, and ties break on id', { skip }, async () => {
  const read = async (): Promise<{ id: string; name: string }[]> =>
    (
      (await (await fetch(`${base}/v1/archipelagos`, { headers: auth('alice') })).json()) as {
        archipelagos: { id: string; name: string }[];
      }
    ).archipelagos;

  // Sixteen worlds a minute apart in 2020, inserted OLDEST FIRST so that insertion order is the
  // reverse of the order the route owes — an unordered read cannot accidentally agree.
  const olderAt = (i: number) => new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString();
  for (let i = 0; i < 16; i += 1) {
    await sql`
      insert into archipelagos (kind, owner_subject, entitlement_id, name, seed, created_at)
      values ('skerry', ${`user:${ALICE}`}, ${`ent-332-order-${i}`}, ${`World ${i}`}, ${i}, ${olderAt(i)})
    `;
  }
  // Two REAL ones on top, through the bridge's own route, so the newest rows in the list are rows
  // provisioning actually made. They are the newest because `created_at` defaults to now() and the
  // sixteen above are five years stale.
  await provision('ent-332-order-a', ALICE, 'First Bought');
  await provision('ent-332-order-b', ALICE, 'Second Bought');

  const expected = ['Second Bought', 'First Bought'];
  for (let i = 15; i >= 0; i -= 1) expected.push(`World ${i}`);
  assert.deepEqual(
    (await read()).map((a) => a.name),
    expected,
    'newest first, all eighteen: the skerry just bought is the one its buyer came looking for',
  );

  // Now one clock tick for all eighteen, which is what a batch the bridge delivers together looks
  // like. `created_at desc` has nothing left to say and only the id can order them.
  await sql`
    update archipelagos set created_at = timestamptz '2026-08-10 00:00:00+00'
     where owner_subject = ${`user:${ALICE}`}
  `;
  const tied = await read();
  assert.equal(tied.length, 18, 'the whole fixture came back, so the cap did not trim it');
  assert.deepEqual(
    tied.map((a) => a.id),
    [...tied.map((a) => a.id)].sort(),
    'with created_at tied the list still has exactly one order, and it is ascending by id',
  );
});

/**
 * The other half of #332, over HTTP: the id that route hands out must not be a capability.
 *
 * micro-org#341. `/islands` and `/lanes` authenticated and then asked no further questions, so any
 * subject in the estate holding a skerry's uuid could enumerate its islands — and, because `/lanes`
 * calls `ensureLattice`, could MAKE its winds by asking. Every assertion below is red against the
 * 2.5.14 service.
 */
test('server: a stranger cannot open, or grow, somebody else’s skerry', { skip }, async () => {
  const season = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  await provision('ent-341-http', ALICE, 'The Gannetry');
  const owned = ((await (await fetch(`${base}/v1/archipelagos`, { headers: auth('alice') })).json()) as {
    archipelagos: { id: string }[];
  }).archipelagos;
  const id = owned[0]!.id;

  const islands = (path: string, token: string) => fetch(`${base}${path}`, { headers: auth(token) });

  // The owner opens it; the operator and a read-scoped service may too.
  assert.equal((await islands(`/v1/archipelagos/${id}/islands`, 'alice')).status, 200);
  assert.equal((await islands(`/v1/archipelagos/${id}/islands`, 'admin')).status, 200);
  assert.equal((await islands(`/v1/archipelagos/${id}/islands`, 'reader')).status, 200);

  // The stranger gets 404, NOT 403: a 403 would confirm the uuid names a real private world, and
  // an unguessable id whose existence can be confirmed is no longer unguessable in the way that
  // matters. The body is word-for-word the one an id naming nothing gets.
  const refused = await islands(`/v1/archipelagos/${id}/islands`, 'carol');
  assert.equal(refused.status, 404);
  const missing = await islands('/v1/archipelagos/44444444-4444-4444-8444-444444444444/islands', 'carol');
  assert.equal(missing.status, 404);
  assert.deepEqual(
    ((await refused.json()) as { error: { code: string; message: string } }).error.message,
    ((await missing.json()) as { error: { code: string; message: string } }).error.message,
  );

  // And the lanes route, which WRITES. Provisioning seeds the lattice, so the fixture is the world
  // with its lanes removed — what every archipelago that predates the lattice looks like.
  await sql`delete from lanes where archipelago_id = ${id}`;
  assert.equal((await islands(`/v1/archipelagos/${id}/lanes`, 'carol')).status, 404);
  const after = await sql<{ n: string }[]>`select count(*) as n from lanes where archipelago_id = ${id}`;
  assert.equal(after[0]!.n, '0', 'a refused GET /lanes generated the wind lattice of a world it refused');
  assert.equal((await islands(`/v1/archipelagos/${id}/lanes`, 'alice')).status, 200);

  // The season world is untouched by all of this — carol plays there like everybody else.
  assert.equal((await islands(`/v1/archipelagos/${season.archipelagoId}/islands`, 'carol')).status, 200);
  assert.equal((await islands(`/v1/archipelagos/${season.archipelagoId}/lanes`, 'carol')).status, 200);
});

test('server: found a city, read it back with computed stocks, refuse the other player', { skip }, async () => {
  const islandId = await anIsland();
  const create = await fetch(`${base}/v1/cities`, {
    method: 'POST',
    headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  assert.equal(create.status, 201);
  const { city } = (await create.json()) as { city: { id: string; stocks: Record<string, string> } };
  assert.match(city.stocks['aether']!, /^\d+$/, 'stocks travel as decimal strings');

  const mine = await fetch(`${base}/v1/cities/${city.id}`, { headers: auth('alice') });
  assert.equal(mine.status, 200);

  // Bob can see the island's plot is taken (public), but not Alice's economy.
  const theirs = await fetch(`${base}/v1/cities/${city.id}`, { headers: auth('bob') });
  assert.equal(theirs.status, 403);
  // An admin can.
  const operator = await fetch(`${base}/v1/cities/${city.id}`, { headers: auth('admin') });
  assert.equal(operator.status, 200);
});

test('server: refounding on the same island replays with 200, not 201 and not 409', { skip }, async () => {
  const islandId = await anIsland();
  const body = JSON.stringify({ islandId, plot: 1, name: 'Aerie' });
  const first = await fetch(`${base}/v1/cities`, { method: 'POST', headers: auth('alice'), body });
  assert.equal(first.status, 201);
  const retry = await fetch(`${base}/v1/cities`, { method: 'POST', headers: auth('alice'), body });
  assert.equal(retry.status, 200);
  const cities = await sql<{ n: number }[]>`select count(*)::int as n from cities`;
  assert.equal(cities[0]!.n, 1);
});

test('server: a taken plot is 409 plot_taken', { skip }, async () => {
  const islandId = await anIsland();
  await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  const refused = await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('bob'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Roost' }),
  });
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'plot_taken');
});

test('server: a queue submission without an Idempotency-Key is 400; with one it replays', { skip }, async () => {
  const islandId = await anIsland();
  const create = await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  const { city } = (await create.json()) as { city: { id: string } };

  const bare = await fetch(`${base}/v1/cities/${city.id}/buildings`, {
    method: 'POST', headers: auth('alice'), body: JSON.stringify({ type: 'warehouse' }),
  });
  assert.equal(bare.status, 400);

  const submit = () =>
    fetch(`${base}/v1/cities/${city.id}/buildings`, {
      method: 'POST',
      headers: { ...auth('alice'), 'idempotency-key': 'k-house' },
      body: JSON.stringify({ type: 'warehouse' }),
    });
  const first = await submit();
  assert.equal(first.status, 200);
  const b1 = (await first.json()) as { item: { id: string }; replayed: boolean };
  assert.equal(b1.replayed, false);

  const second = await submit();
  assert.equal(second.status, 200, 'a retry must not 409');
  const b2 = (await second.json()) as { item: { id: string }; replayed: boolean };
  assert.equal(b2.replayed, true);
  assert.equal(b2.item.id, b1.item.id);

  // The completion job is scheduled under the city's key, once.
  const jobs = await sql<{ kind: string; key: string }[]>`select kind, key from jobs`;
  assert.deepEqual([...jobs], [{ kind: CITY_QUEUE_KIND, key: `city:${city.id}` }]);
});

test('server: bob cannot queue in alice\'s city — 403 not_owner', { skip }, async () => {
  const islandId = await anIsland();
  const create = await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  const { city } = (await create.json()) as { city: { id: string } };
  const refused = await fetch(`${base}/v1/cities/${city.id}/research`, {
    method: 'POST',
    headers: { ...auth('bob'), 'idempotency-key': 'k1' },
    body: JSON.stringify({ node: 'well_lore' }),
  });
  assert.equal(refused.status, 403);
  const body = (await refused.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'not_owner');
});

/* --------------------------------------------------- the reads the client asked for */

test('server: building and research content is public, exact, and mirrors the engine', { skip }, async () => {
  const b = await fetch(`${base}/v1/content/buildings`);
  assert.equal(b.status, 200);
  const buildings = ((await b.json()) as { buildings: Record<string, { baseCost: Record<string, string>; durationSecondsPerLevel: number }> }).buildings;
  assert.equal(Object.keys(buildings).length, 20);
  // The served base IS the engine's level-1 charge — one source, no restated arithmetic.
  const skyhall = buildings['skyhall']!;
  assert.equal(skyhall.baseCost['aether'], buildingCost('skyhall', 1).aether.toString());
  assert.equal(skyhall.durationSecondsPerLevel, buildingDurationSeconds('skyhall', 1));

  const r = await fetch(`${base}/v1/content/research`);
  const research = ((await r.json()) as { research: Record<string, { branch: string; cost: Record<string, string>; durationSeconds: number }> }).research;
  assert.equal(Object.keys(research).length, 32);
  const node = RESEARCH_NODES['economy'][0]!;
  assert.equal(research[node]!.cost['aether'], researchCost(node).aether.toString());
  assert.equal(research[node]!.durationSeconds, researchDurationSeconds(node));
});

test('server: a player lists their own battles and nobody else\'s, digests included', { skip }, async () => {
  const season = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  const islands = await listIslands(asDb(sql), season.archipelagoId);
  // Two battles for Alice (one as defender), one for Bob alone — fixture rows, since resolution
  // itself is proven elsewhere and this read serves STORED truth only.
  // battles_fleet_uniq is phase 2's race floor — one battle per fleet — so each fixture battle
  // gets its own fleet, which is exactly what the constraint exists to demand.
  const mk = async (attacker: string, defender: string, n: number) => {
    const fleet = await sql<{ id: string }[]>`
      insert into fleets (origin_city_id, user_id, mission, status, target_island_id,
                          arrives_at, travel_seconds, return_seconds, aether_lift, idempotency_key)
      values (${home[0]!.id}, ${attacker}, 'raid', 'done', ${islands[0]!.id},
              now() + interval '1 hour', 3600, 3600, 0, ${'battle-list-fixture-' + n})
      returning id
    `;
    await sql`
      insert into battles (archipelago_id, island_id, fleet_id, mission, attacker_user_id, defender_user_id,
                           seed, wind_bp, attacker_oob, defender_oob, result, digest)
      values (${season.archipelagoId}, ${islands[0]!.id}, ${fleet[0]!.id}, 'raid', ${attacker}, ${defender},
              1, 0, '{}'::jsonb, '{}'::jsonb, ${sql.json({ outcome: 'raided' })}, ${'ab'.repeat(32)})
    `;
  };
  // A fleet row must exist for the FK; found one? If none, create the minimal ancestry via a city
  // launch is overkill — insert a fleet directly.
  const city = await sql`select id, user_id, island_id from cities limit 1`;
  if (city.length === 0) {
    // No city yet in this suite ordering: found one for Alice.
    await fetch(`${base}/v1/cities`, { method: 'POST', headers: auth('alice'),
      body: JSON.stringify({ islandId: islands[1]!.id, plot: 1, name: 'Historia' }) });
  }
  const home = await sql`select id, user_id, island_id from cities limit 1`;
  await mk(ALICE, BOB, 1);
  await mk(BOB, ALICE, 2);
  await mk(BOB, '33333333-3333-4333-8333-333333333333', 3);

  const mine = await fetch(`${base}/v1/battles`, { headers: auth('alice') });
  assert.equal(mine.status, 200);
  const battles = ((await mine.json()) as { battles: { attackerUserId: string; defenderUserId: string; digest: string; outcome: string }[] }).battles;
  assert.equal(battles.length, 2, 'both sides of the war, nobody else\'s');
  for (const b of battles) {
    assert.ok(b.attackerUserId === ALICE || b.defenderUserId === ALICE);
    assert.match(b.digest, /^[0-9a-f]{64}$/);
    assert.equal(b.outcome, 'raided', 'stored truth, never recomputed');
  }
  // The fleets-list owner pattern, verbatim: another user is forbidden without admin.
  const peek = await fetch(`${base}/v1/battles?userId=${BOB}`, { headers: auth('alice') });
  assert.equal(peek.status, 403);
});

test('server: the alliance directory lists the world and marks mine', { skip }, async () => {
  const founded = await fetch(`${base}/v1/alliances`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({
      archipelagoId: (await ensureOpenSeason(asDb(sql), 'aetherholm', new Date())).archipelagoId,
      name: 'Skyward Compact',
      communityId: '99999999-9999-4999-8999-999999999999',
    }),
  });
  assert.ok(founded.status === 201 || founded.status === 200, `found: ${founded.status}`);
  const list = await fetch(`${base}/v1/alliances`, { headers: auth('bob') });
  assert.equal(list.status, 200);
  const alliances = ((await list.json()) as { alliances: { name: string; memberCount: number; mine: boolean }[] }).alliances;
  const mine = alliances.find((a) => a.name === 'Skyward Compact');
  assert.ok(mine, 'the directory lists what was founded');
  assert.equal(mine!.mine, false, 'bob is not in it');
  const asAlice = await fetch(`${base}/v1/alliances`, { headers: auth('alice') });
  const own = ((await asAlice.json()) as { alliances: { name: string; mine: boolean }[] }).alliances
    .find((a) => a.name === 'Skyward Compact');
  assert.equal(own!.mine, true, 'which-am-I-in is answered by the directory itself');
});

/* ------------------------------------------------------------------ phase 2 surfaces */

test('server: the airship content is public and every amount is a decimal string', { skip }, async () => {
  const res = await fetch(`${base}/v1/content/airships`);
  assert.equal(res.status, 200, 'content is a capability statement, like /v1/title');
  const body = (await res.json()) as { airships: Record<string, { cargo: string; attack: string }> };
  assert.equal(Object.keys(body.airships).length, 10);
  assert.match(body.airships['hauler']!.cargo, /^\d+$/);
  assert.equal(body.airships['ironclad']!.cargo, '0', 'war classes carry nothing — the split, on the wire');
});

test('server: lanes serve authenticated, and backfill a world that predates the lattice', { skip }, async () => {
  const season = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  // Simulate a phase-1 world: strip the lanes the season fixture created.
  await sql`delete from lanes`;
  await sql`update islands set is_spire = false`;
  const anonymous = await fetch(`${base}/v1/archipelagos/${season.archipelagoId}/lanes`);
  assert.equal(anonymous.status, 401, 'the live lattice is player data, not public data');
  const res = await fetch(`${base}/v1/archipelagos/${season.archipelagoId}/lanes`, {
    headers: auth('reader'),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { lanes: { multiplierBp: number }[] };
  assert.ok(body.lanes.length > 0, 'the ask itself grew the lanes from the stored seed');
});

test('server: a fleet launch demands an Idempotency-Key and a real mission', { skip }, async () => {
  const islandId = await anIsland();
  const create = await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  const { city } = (await create.json()) as { city: { id: string } };
  const bare = await fetch(`${base}/v1/fleets`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ cityId: city.id, mission: 'raid', ships: { cutter: 1 }, targetIslandId: islandId }),
  });
  assert.equal(bare.status, 400, 'no Idempotency-Key, no launch');
  const nonsense = await fetch(`${base}/v1/fleets`, {
    method: 'POST', headers: { ...auth('alice'), 'idempotency-key': 'k-f1' },
    body: JSON.stringify({ cityId: city.id, mission: 'parade', ships: { cutter: 1 }, targetIslandId: islandId }),
  });
  assert.equal(nonsense.status, 400);
  const floaty = await fetch(`${base}/v1/fleets`, {
    method: 'POST', headers: { ...auth('alice'), 'idempotency-key': 'k-f2' },
    body: JSON.stringify({
      cityId: city.id, mission: 'transfer', ships: { hauler: 1 },
      cargo: { aether: 1.5 }, targetIslandId: islandId,
    }),
  });
  assert.equal(floaty.status, 400, 'cargo is decimal strings — a float near an amount is refused');
});

test('server: a shipyard queue item needs its aerodock, and replays on its key', { skip }, async () => {
  const islandId = await anIsland();
  const create = await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  const { city } = (await create.json()) as { city: { id: string } };
  const submit = () =>
    fetch(`${base}/v1/cities/${city.id}/ships`, {
      method: 'POST',
      headers: { ...auth('alice'), 'idempotency-key': 'k-keel' },
      body: JSON.stringify({ class: 'skiff' }),
    });
  const dockless = await submit();
  assert.equal(dockless.status, 400, 'a keel needs its aerodock');
  await sql`insert into buildings (city_id, type, level) values (${city.id}, 'aerodock', 1)`;
  const first = await submit();
  assert.equal(first.status, 200);
  const b1 = (await first.json()) as { item: { id: string }; replayed: boolean };
  assert.equal(b1.replayed, false);
  const second = await submit();
  const b2 = (await second.json()) as { item: { id: string }; replayed: boolean };
  assert.equal(b2.replayed, true);
  assert.equal(b2.item.id, b1.item.id);
});

test('server: an alliance cannot be founded without its community', { skip }, async () => {
  const season = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  const missing = await fetch(`${base}/v1/alliances`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ archipelagoId: season.archipelagoId, name: 'Compact' }),
  });
  assert.equal(missing.status, 400, 'communityId is required — this service refuses to create communities');
  const created = await fetch(`${base}/v1/alliances`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({
      archipelagoId: season.archipelagoId,
      communityId: '55555555-5555-4555-8555-555555555555',
      name: 'Compact',
    }),
  });
  assert.equal(created.status, 201);
  const { alliance } = (await created.json()) as { alliance: { id: string; communityId: string } };
  assert.equal(alliance.communityId, '55555555-5555-4555-8555-555555555555');
});

test('server: the chronicle is anonymous for SEALED seasons only', { skip }, async () => {
  // Anonymous list: empty while nothing has sealed.
  const empty = await fetch(`${base}/v1/chronicle/seasons`);
  assert.equal(empty.status, 200, 'the chronicle list needs no bearer');
  assert.deepEqual((await empty.json()) as unknown, { seasons: [] });

  // Seal a season whose day has come.
  const seasons = await sql<{ id: string }[]>`
    insert into seasons (name, seed, status, opened_at, ends_at)
    values ('Old', 3, 'open', now() - interval '121 days', now() - interval '1 day')
    returning id
  `;
  await sql`insert into archipelagos (kind, season_id, name, seed)
            values ('public', ${seasons[0]!.id}, 'A', 3)`;
  const arch = await sql<{ id: string }[]>`
    select id from archipelagos where season_id = ${seasons[0]!.id}
  `;
  await withOutbox(asDb(sql), 'aetherholm', async (tx) => {
    await insertIslands(tx, arch[0]!.id, generateIslands(3n, 12));
  });
  await sealSeason(asDb(sql), 'aetherholm', seasons[0]!.id);

  const listed = await fetch(`${base}/v1/chronicle/seasons`);
  const body = (await listed.json()) as { seasons: { seasonId: string; digest: string }[] };
  assert.equal(body.seasons.length, 1);
  assert.equal(body.seasons[0]!.seasonId, seasons[0]!.id);

  const detail = await fetch(`${base}/v1/chronicle/seasons/${seasons[0]!.id}`);
  assert.equal(detail.status, 200, 'a sealed season reads anonymously');
  const battles = await fetch(`${base}/v1/chronicle/seasons/${seasons[0]!.id}/battles`);
  assert.equal(battles.status, 200);

  // A LIVE season is not history and stays scoped.
  const live = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  const refused = await fetch(`${base}/v1/chronicle/seasons/${live.id}`);
  assert.equal(refused.status, 404, 'live-season data never leaks through the anonymous surface');
});

test('server: an empty treasury is 409 insufficient_stock, and charges nothing', { skip }, async () => {
  const islandId = await anIsland();
  const create = await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  const { city } = (await create.json()) as { city: { id: string } };
  await sql`update cities set aether = 0, cloudstone = 0, skysteel = 0, provisions = 0,
            last_settled_at = now() where id = ${city.id}`;
  const refused = await fetch(`${base}/v1/cities/${city.id}/buildings`, {
    method: 'POST',
    headers: { ...auth('alice'), 'idempotency-key': 'k1' },
    body: JSON.stringify({ type: 'warehouse' }),
  });
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'insufficient_stock');
});

/**
 * One handle, presented as the per-network selector the server now takes. The fixture runs against
 * a single test database, so mainnet is the only configured network — which exercises the REFUSAL
 * path for free: anything reaching for testnet throws rather than reusing this handle.
 */
export function singleNetworkSql(db: unknown) {
  return networkSql({ mainnet: db as RuntimeSql })
}
