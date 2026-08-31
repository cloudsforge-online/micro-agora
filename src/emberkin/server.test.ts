// End-to-end HTTP tests through the real server: health, metrics, the signed webhook, starting a
// game, an idempotent battle submission that REPLAYS (never 409s), and cosmetic entitlement gating.

import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type postgres from 'postgres';
import { Lifecycle, postgresProbe } from '@cloudsforge/lifecycle';
import { TokenError, type Principal } from '@cloudsforge/auth';

import { GameData } from './content/gamedata.ts';
import { createServer, type PrincipalVerifier } from './server.ts';
import { SEASON_REWARD_KIND } from './jobs.ts';
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
} from './testsupport.ts';

const data = GameData.loadFromDirectory();
const SECRET = 'test-signing-secret-of-good-length-000';

let sql: postgres.Sql;
let server: Server;
let base: string;
let billing: ReturnType<typeof fakeBilling>;
const enqueued: { kind: string; key: string }[] = [];

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
  billing = fakeBilling();
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
    billing,
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

const auth = { authorization: 'Bearer alice', 'content-type': 'application/json' };

test('server: /livez and /readyz answer', { skip }, async () => {
  const live = await fetch(`${base}/livez`);
  assert.equal(live.status, 200);
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 200);
});

test('server: /metrics is prometheus text', { skip }, async () => {
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
});

test('server: an unauthenticated call is 401', { skip }, async () => {
  const res = await fetch(`${base}/v1/saves/me`);
  assert.equal(res.status, 401);
});

test('server: start a game, then read it back', { skip }, async () => {
  const create = await fetch(`${base}/v1/saves`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ wardenName: 'Sella', starter: 'cindercub', seed: '100' }),
  });
  assert.equal(create.status, 201);
  const me = await fetch(`${base}/v1/saves/me`, { headers: auth });
  assert.equal(me.status, 200);
  const body = (await me.json()) as { party: { speciesId: string }[]; seed: string };
  assert.equal(body.party[0]!.speciesId, 'cindercub');
  assert.equal(body.seed, '100');
});

test('server: a battle submission is idempotent — the retry REPLAYS, it does not 409', { skip }, async () => {
  await fetch(`${base}/v1/saves`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ wardenName: 'W', starter: 'seedling', seed: '7' }),
  });
  const submit = (): Promise<Response> =>
    fetch(`${base}/v1/saves/me/battles`, {
      method: 'POST',
      headers: { ...auth, 'idempotency-key': 'k-abc' },
      body: JSON.stringify({ enemy: { name: 'Wild', isWild: true, party: [{ species: 'pebblit', level: 3 }] }, script: [], seed: '5' }),
    });

  const first = await submit();
  assert.equal(first.status, 200);
  const b1 = (await first.json()) as { battleId: string; replayed: boolean; outcome: string };
  assert.equal(b1.replayed, false);

  const second = await submit();
  assert.equal(second.status, 200, 'a retry must not 409');
  const b2 = (await second.json()) as { battleId: string; replayed: boolean; outcome: string };
  assert.equal(b2.replayed, true);
  assert.equal(b2.battleId, b1.battleId);
  assert.equal(b2.outcome, b1.outcome);

  const rows = await sql<{ n: number }[]>`select count(*)::int as n from battles`;
  assert.equal(rows[0]!.n, 1);
});

test('server: a battle without an Idempotency-Key is 400', { skip }, async () => {
  await fetch(`${base}/v1/saves`, { method: 'POST', headers: auth, body: JSON.stringify({ wardenName: 'W', starter: 'seedling' }) });
  const res = await fetch(`${base}/v1/saves/me/battles`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ enemy: { name: 'Wild', isWild: true, party: [{ species: 'pebblit', level: 3 }] } }),
  });
  assert.equal(res.status, 400);
});

test('server: equipping a cosmetic is 403 when unowned, 200 when owned', { skip }, async () => {
  await fetch(`${base}/v1/saves`, { method: 'POST', headers: auth, body: JSON.stringify({ wardenName: 'W', starter: 'tidepup' }) });
  const itemUrn = 'cf:catalogue:item:tide_frame';

  const refused = await fetch(`${base}/v1/saves/me/cosmetics`, { method: 'PUT', headers: auth, body: JSON.stringify({ slot: 'frame', itemUrn }) });
  assert.equal(refused.status, 403);
  const err = (await refused.json()) as { error: { code: string } };
  assert.equal(err.error.code, 'cosmetic_not_owned');

  billing.grant(ALICE, { id: 'e1', sku: 'tide_frame', scope: 'platform', active: true });
  const ok = await fetch(`${base}/v1/saves/me/cosmetics`, { method: 'PUT', headers: auth, body: JSON.stringify({ slot: 'frame', itemUrn }) });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { equippedCosmetics: Record<string, string> };
  assert.equal(body.equippedCosmetics['frame'], itemUrn);
});

test('server: the webhook rejects a bad signature and dedupes a valid one', { skip }, async () => {
  const envelope = {
    id: '44444444-4444-4444-8444-444444444444',
    topic: 'billing.entitlement.granted',
    payload: { sku: 'emberkin_season_pass', subject: `user:${ALICE}`, entitlementId: 'ent-9' },
  };
  const { body, signature } = await signedEvent(SECRET, envelope);

  const bad = await fetch(`${base}/v1/events`, { method: 'POST', headers: { 'x-cloudsforge-signature': 'sha256=deadbeef', 'content-type': 'application/json' }, body });
  // 403, not 401: the MAC is the credential on this surface, and a 401 would invite the caller to
  // go and find a token that does not exist. See the comment at the check in server.ts.
  assert.equal(bad.status, 403);

  const good = await fetch(`${base}/v1/events`, { method: 'POST', headers: { [CONTRACT_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' }, body });
  assert.equal(good.status, 202);
  const accepted = (await good.json()) as { status: string };
  assert.equal(accepted.status, 'accepted');
  assert.ok(enqueued.some((e) => e.kind === SEASON_REWARD_KIND && e.key === 'ent-9'), 'a season reward job must be enqueued');

  // Same event id again: deduped by the inbox.
  const dup = await fetch(`${base}/v1/events`, { method: 'POST', headers: { [CONTRACT_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' }, body });
  assert.equal(dup.status, 202);
  const dupBody = (await dup.json()) as { status: string };
  assert.equal(dupBody.status, 'duplicate');
});
