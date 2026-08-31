// Right to erasure, end to end through the real HTTP surface and the real database.
//
// The load-bearing assertion is the last one: after `identity.user.deleted`, the user's uuid does
// not appear in ANY column of ANY table this service owns — searched by scanning the live catalogue
// rather than a list somebody has to remember to update. A future table holding a `user_id` fails
// this test on the day it is added, which is the point.

import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { Lifecycle, postgresProbe } from '@cloudsforge/lifecycle';
import { TokenError, type Principal } from '@cloudsforge/auth';

import { GameData } from './content/gamedata.ts';
import { createServer, type PrincipalVerifier } from './server.ts';
import { SEASON_REWARD_KIND } from './jobs.ts';
import { ERASED_REWARD_KEY_PREFIX } from './erasure.ts';
import { rewardIdempotencyKey } from './ledgerclient.ts';
import {
  enabled,
  skip,
  openDb,
  migrateTestDb,
  resetEmberkin,
  asDb,
  fakeBilling,
  quietLogger,
  testMetrics,
  signedEvent,
  CONTRACT_SIGNATURE_HEADER,
  ALICE,
  BOB,
} from './testsupport.ts';

const data = GameData.loadFromDirectory();
const SECRET = 'test-signing-secret-of-good-length-000';

let sql: postgres.Sql;
let server: Server;
let base: string;
const enqueued: { kind: string; key: string }[] = [];

const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    if (token === 'alice') return { kind: 'user', userId: ALICE, handle: 'alice', roles: [] };
    if (token === 'bob') return { kind: 'user', userId: BOB, handle: 'bob', roles: [] };
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
    sql: networkSql({ mainnet: asDb(sql) as unknown as RuntimeSql }),
    singleNetwork: 'mainnet' as const,
    producer: 'emberkin',
    data,
    billing: fakeBilling(),
    queueFor: () => ({ enqueue: async (o) => void enqueued.push({ kind: o.kind, key: o.key }) }),
    eventAcceptSecrets: [SECRET],
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  lifecycle.markReady();
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  if (enabled) {
    await resetEmberkin(sql);
    enqueued.length = 0;
  }
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (sql) await sql.end();
});

const authFor = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

/** Post a signed envelope the way the producer's relay would. */
async function postEvent(envelope: Record<string, unknown>): Promise<Response> {
  const { body, signature } = await signedEvent(SECRET, envelope);
  return fetch(`${base}/v1/events`, {
    method: 'POST',
    headers: { [CONTRACT_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' },
    body,
  });
}

function deletionEvent(userId: string, id = randomUUID()): Record<string, unknown> {
  return {
    id,
    topic: 'identity.user.deleted',
    key: userId,
    payload: { userId, tombstoneAt: new Date().toISOString(), reason: 'user_requested' },
  };
}

/** A save, one battle (so there is something to cascade) and an achievement. */
async function playAsAlice(): Promise<void> {
  const auth = authFor('alice');
  const created = await fetch(`${base}/v1/saves`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ wardenName: 'Sella', starter: 'cindercub', seed: '100' }),
  });
  assert.equal(created.status, 201);
  const battle = await fetch(`${base}/v1/saves/me/battles`, {
    method: 'POST',
    headers: { ...auth, 'idempotency-key': 'k-erasure' },
    body: JSON.stringify({
      enemy: { name: 'Wild', isWild: true, party: [{ species: 'pebblit', level: 3 }] },
      script: [],
      seed: '5',
    }),
  });
  assert.equal(battle.status, 200);
  await sql`insert into player_achievements (user_id, code, name, points) values (${ALICE}, 'resonance_attuned', 'Attuned', 10)`;
}

/** A season and a paid reward grant for `userId`, keyed exactly as `grantSeasonReward` keys it. */
async function grantReward(userId: string, amount: string, journalEntryId: string): Promise<string> {
  const seasons = await sql<{ id: string }[]>`
    insert into seasons (slug, name, starts_at, ends_at, status, reward_budget_wei, rewards_granted_wei)
    values (${`s-${journalEntryId}`}, 'S', now(), now() + interval '30 days', 'active', 100000, ${amount})
    returning id
  `;
  const seasonId = seasons[0]!.id;
  await sql`
    insert into reward_grants (season_id, user_id, reason, amount_wei, journal_entry_id, idempotency_key)
    values (${seasonId}, ${userId}, 'season_pass:ent-9', ${amount}, ${journalEntryId},
            ${rewardIdempotencyKey(seasonId, userId, 'season_pass:ent-9')})
  `;
  return seasonId;
}

/** Every text-ish column of every table in the public schema, scanned for a literal id. */
async function tablesMentioning(userId: string): Promise<string[]> {
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'public'
       and data_type in ('uuid', 'text', 'character varying', 'json', 'jsonb')
     order by table_name, column_name
  `;
  const hits: string[] = [];
  for (const c of columns) {
    const found = await sql.unsafe(
      `select 1 from "${c.table_name}" where "${c.column_name}"::text like $1 limit 1`,
      [`%${userId}%`],
    );
    if (found.length > 0) hits.push(`${c.table_name}.${c.column_name}`);
  }
  return hits;
}

test('erasure: identity.user.deleted removes the save and cascades its battles', { skip }, async () => {
  await playAsAlice();
  const before = await sql<{ n: number }[]>`select count(*)::int as n from battles where user_id = ${ALICE}`;
  assert.equal(before[0]!.n, 1, 'the fixture must have produced a battle to cascade');

  const res = await postEvent(deletionEvent(ALICE));
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: 'accepted', erased: true });

  const saves = await sql<{ n: number }[]>`select count(*)::int as n from saves where user_id = ${ALICE}`;
  assert.equal(saves[0]!.n, 0, 'the save is deleted');
  const battles = await sql<{ n: number }[]>`select count(*)::int as n from battles`;
  assert.equal(battles[0]!.n, 0, 'battles go with the save BY CASCADE, not by being left behind');
});

test('erasure: the battles CASCADE is what deletes them, not the fallback', { skip }, async () => {
  await playAsAlice();
  // Through `eraseUser` directly, because the proof is in the counts and the HTTP surface does not
  // return them. `battlesNotCascaded` is what the second delete found AFTER the save was removed:
  // zero means `battles.user_id references saves on delete cascade` did the work. If the foreign
  // key is ever dropped this reads 1 — the rows are still erased, and the count says why.
  const counts = await sql.begin(async (tx) => {
    const { eraseUser } = await import('./erasure.ts');
    return { value: await eraseUser(tx as unknown as Parameters<typeof eraseUser>[0], ALICE) };
  });
  assert.equal(counts.value.saves, 1);
  assert.equal(counts.value.battles, 1, 'there was a battle to cascade');
  assert.equal(counts.value.battlesNotCascaded, 0, 'the FOREIGN KEY deleted them, not the fallback');
});

test('erasure: achievements are deleted, delivered or not', { skip }, async () => {
  await playAsAlice();
  await sql`insert into player_achievements (user_id, code, name, points, delivered_at)
            values (${ALICE}, 'dex_complete', 'Dex Complete', 100, now())`;
  const before = await sql<{ n: number }[]>`select count(*)::int as n from player_achievements where user_id = ${ALICE}`;
  assert.equal(before[0]!.n, 2);

  const res = await postEvent(deletionEvent(ALICE));
  assert.equal(res.status, 202);

  const after = await sql<{ n: number }[]>`select count(*)::int as n from player_achievements`;
  assert.equal(after[0]!.n, 0, 'an undelivered achievement never delivers, which is correct');
});

test('erasure: the reward grant SURVIVES, anonymised — the ledger record is intact', { skip }, async () => {
  await playAsAlice();
  const seasonId = await grantReward(ALICE, '500', 'entry-77');

  const res = await postEvent(deletionEvent(ALICE));
  assert.equal(res.status, 202);

  const grants = await sql<
    {
      user_id: string;
      journal_entry_id: string;
      amount_wei: string;
      reason: string;
      season_id: string;
      idempotency_key: string;
      user_erased_at: Date | null;
    }[]
  >`
    select user_id, journal_entry_id, amount_wei::text as amount_wei, reason, season_id,
           idempotency_key, user_erased_at
      from reward_grants
  `;
  assert.equal(grants.length, 1, 'the row is RETAINED — it is the record of a ledger posting');
  const grant = grants[0]!;

  assert.equal(grant.journal_entry_id, 'entry-77', 'the ledger entry that paid it is untouched');
  assert.notEqual(grant.amount_wei, '', 'never BigInt("") — an empty numeric::text would read as 0n');
  assert.equal(BigInt(grant.amount_wei), 500n, 'the amount is untouched');
  assert.equal(grant.reason, 'season_pass:ent-9', 'what the payment was for is untouched');
  assert.equal(grant.season_id, seasonId, 'it still reconciles against its season');

  assert.notEqual(grant.user_id, ALICE, 'the user id is gone');
  assert.ok(grant.user_erased_at instanceof Date, 'user_erased_at makes the row distinguishable');
  assert.ok(
    grant.idempotency_key.startsWith(ERASED_REWARD_KEY_PREFIX),
    'the derived key embedded the raw uuid, so it is overwritten too',
  );
  assert.ok(!grant.idempotency_key.includes(ALICE));

  // The season total still matches the sum of the grants that remain — the whole reason to keep it.
  const season = await sql<{ granted: string; total: string }[]>`
    select s.rewards_granted_wei::text as granted,
           coalesce(sum(g.amount_wei), 0)::text as total
      from seasons s left join reward_grants g on g.season_id = s.id
     where s.id = ${seasonId}
     group by s.rewards_granted_wei
  `;
  assert.equal(season[0]!.granted, season[0]!.total, 'seasons.rewards_granted_wei still reconciles');
});

test('erasure: two grants for one user do not collide on the erased key', { skip }, async () => {
  await grantReward(ALICE, '500', 'entry-a');
  await grantReward(ALICE, '250', 'entry-b');

  const res = await postEvent(deletionEvent(ALICE));
  assert.equal(res.status, 202);

  const rows = await sql<{ user_id: string; idempotency_key: string }[]>`
    select user_id, idempotency_key from reward_grants order by journal_entry_id
  `;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.user_id, rows[1]!.user_id, 'one placeholder per erasure, shared by the rows');
  assert.notEqual(rows[0]!.idempotency_key, rows[1]!.idempotency_key, 'reward_grants_key_uniq still holds');
});

test('erasure: the placeholder is random — two erasures do not share one', { skip }, async () => {
  await grantReward(ALICE, '500', 'entry-a');
  await grantReward(BOB, '500', 'entry-b');

  assert.equal((await postEvent(deletionEvent(ALICE))).status, 202);
  assert.equal((await postEvent(deletionEvent(BOB))).status, 202);

  const rows = await sql<{ user_id: string }[]>`select user_id from reward_grants order by journal_entry_id`;
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]!.user_id, rows[1]!.user_id, 'a shared placeholder would re-link two people');
});

test('erasure: the one-way trigger refuses to un-erase a grant', { skip }, async () => {
  await grantReward(ALICE, '500', 'entry-77');
  assert.equal((await postEvent(deletionEvent(ALICE))).status, 202);

  await assert.rejects(
    () => sql`update reward_grants set user_id = ${ALICE} where user_erased_at is not null`,
    /cannot be re-attributed/,
    'an anonymised row can never be pointed back at a person',
  );
  await assert.rejects(
    () => sql`update reward_grants set user_erased_at = null where user_erased_at is not null`,
    /cannot be undone/,
  );

  // A benign update of an erased row is still allowed — the trigger guards attribution, not writes.
  await sql`update reward_grants set reason = 'season_pass:ent-9' where user_erased_at is not null`;
});

test('erasure: the erased key form is pinned by a CHECK', { skip }, async () => {
  await grantReward(ALICE, '500', 'entry-77');
  assert.equal((await postEvent(deletionEvent(ALICE))).status, 202);
  await assert.rejects(
    () => sql`update reward_grants set idempotency_key = 'emberkin:reward:s:u:r' where user_erased_at is not null`,
    /reward_grants_erased_key_form/,
    'an erased row cannot be given a key in the derived (user-bearing) form',
  );
});

test('erasure: queued work naming the user is dropped with them', { skip }, async () => {
  await playAsAlice();
  await sql`
    insert into jobs (kind, key, payload)
    values (${SEASON_REWARD_KIND}, 'ent-9', ${sql.json({ userId: ALICE, entitlementId: 'ent-9' })})
  `;
  await sql`insert into jobs (kind, key, payload) values ('outbox.relay', 'stream', '{}')`;

  assert.equal((await postEvent(deletionEvent(ALICE))).status, 202);

  const rows = await sql<{ kind: string }[]>`select kind from jobs`;
  assert.deepEqual(rows.map((r) => r.kind), ['outbox.relay'], 'the reward job goes; the relay stays');
});

test('erasure: after it, the uuid appears in NO column of ANY table', { skip }, async () => {
  await playAsAlice();
  await grantReward(ALICE, '500', 'entry-77');
  await sql`
    insert into jobs (kind, key, payload)
    values (${SEASON_REWARD_KIND}, 'ent-9', ${sql.json({ userId: ALICE, entitlementId: 'ent-9' })})
  `;

  const before = await tablesMentioning(ALICE);
  assert.ok(before.length > 0, 'the fixture must actually have written the id somewhere');

  assert.equal((await postEvent(deletionEvent(ALICE))).status, 202);

  const after = await tablesMentioning(ALICE);
  assert.deepEqual(after, [], `the user id survives in: ${after.join(', ')}`);
});

test('erasure: another user is untouched by it', { skip }, async () => {
  await playAsAlice();
  const bob = authFor('bob');
  await fetch(`${base}/v1/saves`, {
    method: 'POST',
    headers: bob,
    body: JSON.stringify({ wardenName: 'Bram', starter: 'seedling', seed: '9' }),
  });
  await fetch(`${base}/v1/saves/me/battles`, {
    method: 'POST',
    headers: { ...bob, 'idempotency-key': 'k-bob' },
    body: JSON.stringify({
      enemy: { name: 'Wild', isWild: true, party: [{ species: 'pebblit', level: 3 }] },
      script: [],
      seed: '5',
    }),
  });

  assert.equal((await postEvent(deletionEvent(ALICE))).status, 202);

  const saves = await sql<{ user_id: string }[]>`select user_id from saves`;
  assert.deepEqual(saves.map((s) => s.user_id), [BOB]);
  const battles = await sql<{ n: number }[]>`select count(*)::int as n from battles where user_id = ${BOB}`;
  assert.equal(battles[0]!.n, 1, "the other participant keeps their own history");
});

test('erasure: a redelivered deletion is a duplicate, not a second erasure', { skip }, async () => {
  await playAsAlice();
  await grantReward(ALICE, '500', 'entry-77');
  const event = deletionEvent(ALICE);

  const first = await postEvent(event);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { status: 'accepted', erased: true });
  const erased = await sql<{ user_id: string; user_erased_at: Date }[]>`
    select user_id, user_erased_at from reward_grants
  `;

  const second = await postEvent(event);
  assert.equal(second.status, 202);
  assert.deepEqual(await second.json(), { status: 'duplicate' });

  const again = await sql<{ user_id: string; user_erased_at: Date }[]>`
    select user_id, user_erased_at from reward_grants
  `;
  assert.equal(again[0]!.user_id, erased[0]!.user_id, 'the placeholder is not re-rolled');
  assert.deepEqual(again[0]!.user_erased_at, erased[0]!.user_erased_at, 'the erasure timestamp is not moved');
});

test('erasure: a deletion with no uuid userId is 400, not a silent success', { skip }, async () => {
  await playAsAlice();
  const res = await postEvent({
    id: randomUUID(),
    topic: 'identity.user.deleted',
    key: 'nobody',
    payload: { userId: 'not-a-uuid' },
  });
  assert.equal(res.status, 400);
  const saves = await sql<{ n: number }[]>`select count(*)::int as n from saves`;
  assert.equal(saves[0]!.n, 1, 'nothing was erased, and nothing claimed to be');
});

test('erasure: a bad signature is 403 and is rejected before the body is parsed', { skip }, async () => {
  await playAsAlice();
  const { body } = await signedEvent(SECRET, deletionEvent(ALICE));

  const forged = await fetch(`${base}/v1/events`, {
    method: 'POST',
    headers: { 'x-cloudsforge-signature': 'sha256=deadbeef', 'content-type': 'application/json' },
    body,
  });
  // 403, not 401: the MAC is the credential, so there is no token for the caller to go and find.
  assert.equal(forged.status, 403);
  const err = (await forged.json()) as { error: { code: string } };
  assert.equal(err.error.code, 'bad_signature');

  // Unsigned AND unparseable: still 403, which proves the signature is checked first. A body-first
  // handler would answer 400 here, and would have run JSON.parse for an unauthenticated caller.
  const garbage = await fetch(`${base}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(garbage.status, 403);

  const saves = await sql<{ n: number }[]>`select count(*)::int as n from saves where user_id = ${ALICE}`;
  assert.equal(saves[0]!.n, 1, 'a forged deletion erases nothing');
});

test('erasure: an unsubscribed topic is still 202-ignored', { skip }, async () => {
  await playAsAlice();
  const res = await postEvent({
    id: randomUUID(),
    topic: 'billing.entitlement.revoked',
    key: ALICE,
    payload: { userId: ALICE },
  });
  // Never 4xx: a 4xx makes the producer's relay retry the same event for ever.
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: 'ignored', topic: 'billing.entitlement.revoked' });
  const saves = await sql<{ n: number }[]>`select count(*)::int as n from saves where user_id = ${ALICE}`;
  assert.equal(saves[0]!.n, 1, 'an ignored topic erases nothing');
});

test('erasure: the season-pass path still works unchanged', { skip }, async () => {
  const res = await postEvent({
    id: randomUUID(),
    topic: 'billing.entitlement.granted',
    key: ALICE,
    payload: { sku: 'emberkin_season_pass', subject: `user:${ALICE}`, entitlementId: 'ent-9' },
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: 'accepted', reward: 'queued' });
  assert.ok(
    enqueued.some((e) => e.kind === SEASON_REWARD_KIND && e.key === 'ent-9'),
    'the `user:` prefix conversion on billing subjects is untouched by the erasure work',
  );
});
