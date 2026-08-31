// Who may read an archipelago (micro-org#341). The predicate, at the database, against the two
// kinds of world the schema actually holds — the season everybody plays in and the skerry somebody
// bought. Every one of these assertions is red against the code as it stood on 2026-08-10, when
// both `:id` read routes went `authenticate() -> uuid check -> query` and consulted
// `owner_subject` nowhere.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
import type { Principal } from '@cloudsforge/auth';
import { archipelagoVisibleTo } from './visibility.ts';
import { provisionSkerry } from './provisioning.ts';
import { ensureOpenSeason, listIslands } from './seasons.ts';
import { foundCity } from './cities.ts';
import { ensureLattice } from './lattice.ts';
import {
  enabled,
  skip,
  openDb,
  migrateTestDb,
  resetAetherholm,
  asDb,
  ALICE,
  BOB,
  CAROL,
} from './testsupport.ts';

let sql: postgres.Sql;

before(async () => {
  if (!enabled) return;
  sql = openDb(4);
  await migrateTestDb(sql);
});
beforeEach(async () => {
  if (enabled) await resetAetherholm(sql);
});
after(async () => {
  if (sql) await sql.end();
});

const player = (userId: string): Principal => ({ kind: 'user', userId, handle: 'p', roles: [] });
const admin = (userId: string): Principal => ({ kind: 'user', userId, handle: 'op', roles: ['admin'] });
const service = (): Principal => ({ kind: 'service', service: 'hub-api', scopes: ['aetherholm:read'] });

/** A skerry provisioned through the real path, so its owner_subject has the ledger spelling. */
async function skerryOf(userId: string, entitlementId: string): Promise<string> {
  const outcome = await provisionSkerry(asDb(sql), 'aetherholm-test', {
    entitlementId,
    subject: `user:${userId}`,
    userId,
    sku: 'private_skerry',
    scope: 'title:aetherholm-title-id',
    metadata: {},
    correlationId: 'test',
  });
  return outcome.urn.slice(outcome.urn.lastIndexOf(':') + 1);
}

test('visibility: the public season world is readable by anybody authenticated', { skip }, async () => {
  const season = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  for (const principal of [player(ALICE), player(CAROL), admin(BOB), service()]) {
    assert.equal(
      await archipelagoVisibleTo(asDb(sql), season.archipelagoId, principal),
      true,
      'the season IS the game; scoping it would be scoping the game',
    );
  }
});

test('visibility: a skerry admits its owner and refuses a stranger', { skip }, async () => {
  const id = await skerryOf(ALICE, 'ent-341-owner');
  assert.equal(await archipelagoVisibleTo(asDb(sql), id, player(ALICE)), true);
  assert.equal(
    await archipelagoVisibleTo(asDb(sql), id, player(CAROL)),
    false,
    'an authenticated stranger holding the uuid is exactly the caller this exists to refuse',
  );
});

test('visibility: an admin and a read-scoped service pass; an unknown id refuses', { skip }, async () => {
  const id = await skerryOf(ALICE, 'ent-341-roles');
  assert.equal(await archipelagoVisibleTo(asDb(sql), id, admin(BOB)), true);
  assert.equal(await archipelagoVisibleTo(asDb(sql), id, service()), true);
  // Absent and refused answer the same, so a caller needs one query rather than two — and so a
  // 404 cannot be told from a 403 by anybody counting round trips.
  assert.equal(
    await archipelagoVisibleTo(asDb(sql), '44444444-4444-4444-8444-444444444444', player(ALICE)),
    false,
  );
});

test('visibility: a GUEST with a city on the skerry may read it', { skip }, async () => {
  // The rule `erasure.ts` already depends on: "a skerry is a PAID private world that may hold
  // other players' cities … plus the rights of the guests". Owner-only would leave BOB holding a
  // city on a world whose shape he cannot see.
  const id = await skerryOf(ALICE, 'ent-341-guest');
  const islands = await listIslands(asDb(sql), id);
  assert.equal(await archipelagoVisibleTo(asDb(sql), id, player(BOB)), false, 'not yet a guest');

  await foundCity(asDb(sql), 'aetherholm-test', {
    userId: BOB,
    islandId: islands[0]!.id,
    plot: 3,
    name: "Bob's Landing",
    correlationId: 'test',
  });

  assert.equal(await archipelagoVisibleTo(asDb(sql), id, player(BOB)), true);
  assert.equal(
    await archipelagoVisibleTo(asDb(sql), id, player(CAROL)),
    false,
    'standing is derived from where a subject IS, not from anybody being on the world',
  );
});

test('visibility: standing follows the ledger spelling, so erasure withdraws it', { skip }, async () => {
  // `listArchipelagosOwnedBy`, `eraseUser` and this predicate all key on `user:<uuid>`. After an
  // erasure the column reads `erased:<uuid>` and matches nobody — the world survives for its
  // guests, and its former owner is no longer a subject of it. Asserted here rather than assumed,
  // because three modules agreeing by convention is three chances to drift.
  const id = await skerryOf(ALICE, 'ent-341-erased');
  assert.equal(await archipelagoVisibleTo(asDb(sql), id, player(ALICE)), true);
  await sql`
    update archipelagos set owner_subject = ${`erased:${ALICE}`} where id = ${id}
  `;
  assert.equal(await archipelagoVisibleTo(asDb(sql), id, player(ALICE)), false);
});

test('visibility: a refused read does NOT grow the lattice', { skip }, async () => {
  // The reason this predicate had to land before `ensureLattice` and not after it. A phase-1 world
  // grows its winds the first time anyone asks, so an unscoped GET /lanes was a WRITE a stranger
  // could drive. Provisioning already seeds a skerry's lattice, so the honest fixture is a world
  // with the lanes deleted — which is precisely what every archipelago created before the lattice
  // existed looks like.
  const id = await skerryOf(ALICE, 'ent-341-lattice');
  await sql`delete from lanes where archipelago_id = ${id}`;
  const before = await sql<{ n: string }[]>`select count(*) as n from lanes where archipelago_id = ${id}`;
  assert.equal(before[0]!.n, '0');

  assert.equal(await archipelagoVisibleTo(asDb(sql), id, player(CAROL)), false);
  const after = await sql<{ n: string }[]>`select count(*) as n from lanes where archipelago_id = ${id}`;
  assert.equal(after[0]!.n, '0', 'the predicate itself must not touch the world it is refusing');

  // And the owner's read is what regrows them, byte-identically from the stored seed.
  assert.equal(await archipelagoVisibleTo(asDb(sql), id, player(ALICE)), true);
  const lanes = await ensureLattice(asDb(sql), id);
  assert.ok(lanes.length > 0);
});
