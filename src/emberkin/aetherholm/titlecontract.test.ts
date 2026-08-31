// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE TITLE CONTRACT, proven against worlds' real client shape.
//
// `worlds/src/conformance.ts` is the executable statement of what a title must satisfy — nine
// checks, run over HTTP against a base URL. This repository cannot import another service's
// source (estate rule 2), so this file MIRRORS those checks one for one against the real server
// and real database, each carrying the worlds citation it reproduces. The request and response
// shapes below are worlds' own:
//
//   - `GET /v1/title` must answer a JSON object whose `slug` is a string and whose
//     `capabilities` is an array, or worlds' client throws
//     ("a title descriptor must carry a slug and capabilities", worlds/src/titleclient.ts).
//   - `POST /v1/provision` receives {entitlementId, subject, userId, sku, scope, metadata} with
//     the entitlement id repeated as the Idempotency-Key header (worlds/src/titleclient.ts)
//     and must answer a non-empty string `urn`; `replayed` is read as `=== true`
//     (worlds/src/titleclient.ts).
//
// Slug and capability validity are pinned against worlds' OWN rules, restated as literals with
// citations — the surfaces.test.ts BOUND-table technique: a second independent copy, so a drift
// in either repository fails a test instead of a customer.
// ═══════════════════════════════════════════════════════════════════════════════════════════

import { singleNetworkSql } from './server.test.ts'
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type postgres from 'postgres';
import { Lifecycle, postgresProbe } from '@cloudsforge/lifecycle';
import { TokenError, type Principal } from '@cloudsforge/auth';
import {
  PROVISION_REQUEST_FIELDS,
  isCapability,
  parseProvisionResult,
  parseTitleDescriptor,
  parseTitleUrn,
  provisionIdempotencyKey,
  provisionScopeFor,
  serialiseProvisionRequest,
  type ProvisionRequest,
} from '@cloudsforge/contracts-worlds';
import {
  createServer,
  AETHERHOLM_PROVISION_SCOPE,
  TITLE_DESCRIPTOR,
  TITLE_SLUG,
  type PrincipalVerifier,
} from './server.ts';
import { SKERRY_ISLAND_COUNT } from './world.ts';
import { SKERRY_PROVISIONED_TOPIC } from './provisioning.ts';
import {
  enabled,
  skip,
  openDb,
  migrateTestDb,
  resetAetherholm,
  asDb,
  quietLogger,
  stripComments,
  testMetrics,
  ALICE,
  TEST_EVENT_SECRET,
} from './testsupport.ts';

/** worlds/src/conformance.ts — the slug rule, restated. */
const WORLDS_SLUG_RULE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
/** worlds/src/titles.ts — the closed capability set, restated. 'provision' is NOT in it. */
const WORLDS_KNOWN_CAPABILITIES = ['private_world', 'cosmetics', 'achievements', 'seasons', 'inventory'];

let sql: postgres.Sql;
let server: Server;
let base: string;

const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    // 'platform' is the shape of WORLDS_SERVICE_TOKEN: a service principal whose scopes include
    // this title's provision scope (worlds/.env.example:31-34 — "the credential a TITLE service
    // sees on a provisioning call, so a title can and must check it").
    if (token === 'platform') {
      return { kind: 'service', service: 'worlds', scopes: ['aetherholm:provision', 'billing:read'] };
    }
    if (token === 'other-service') {
      return { kind: 'service', service: 'hub-api', scopes: ['aetherholm:read'] };
    }
    if (token === 'alice') return { kind: 'user', userId: ALICE, handle: 'alice', roles: [] };
    // A token identity did not issue fails verification — the forged-credential path.
    throw new TokenError('signature verification failed', 'invalid');
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

/** The provision body exactly as worlds' bridge sends it (worlds/src/titleclient.ts,
 *  fed by worlds/src/provisioning.ts) — plus the Idempotency-Key header it always adds. */
function provisionRequest(entitlementId: string, overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer platform',
      'idempotency-key': entitlementId,
    },
    body: JSON.stringify({
      entitlementId,
      subject: `user:${ALICE}`,
      userId: ALICE,
      sku: 'private_skerry',
      scope: 'title:aetherholm-title-id',
      metadata: { name: 'The Gullery' },
      ...overrides,
    }),
  };
}

/* conformance check 1 — worlds/src/conformance.ts */
test('contract 1: the title answers /livez', { skip }, async () => {
  assert.equal((await fetch(`${base}/livez`)).status, 200);
});

/* conformance checks 2, 3, 4 — worlds/src/conformance.ts */
test('contract 2-4: GET /v1/title describes the title; the slug and capabilities pass worlds\' own rules', { skip }, async () => {
  const res = await fetch(`${base}/v1/title`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { slug?: unknown; name?: unknown; capabilities?: unknown };

  // worlds/src/titleclient.ts — the two fields the client refuses to live without.
  assert.equal(typeof body.slug, 'string');
  assert.ok(Array.isArray(body.capabilities));

  assert.equal(body.slug, 'aetherholm');
  assert.match(body.slug as string, WORLDS_SLUG_RULE);

  // Every declared capability must be one worlds knows (conformance check 4) — a typo'd
  // capability is a purchase accepted and never delivered. In particular this is why the
  // descriptor says 'private_world' and NOT 'provision': the bridge asks hasCapability(title,
  // 'private_world') before calling at all (worlds/src/provisioning.ts).
  for (const capability of body.capabilities as unknown[]) {
    assert.ok(
      WORLDS_KNOWN_CAPABILITIES.includes(capability as string),
      `${String(capability)} is not a capability worlds knows`,
    );
  }
  assert.deepEqual(body.capabilities, ['private_world']);
  assert.deepEqual(body, { ...TITLE_DESCRIPTOR, capabilities: ['private_world'] });
});

/* conformance check 8 — worlds/src/conformance.ts */
test('contract 8: an unauthenticated provision is refused with 401', { skip }, async () => {
  const request = provisionRequest('ent-unauth');
  const res = await fetch(`${base}/v1/provision`, {
    ...request,
    headers: { 'content-type': 'application/json', 'idempotency-key': 'ent-unauth' },
  });
  assert.ok(res.status === 401 || res.status === 403, `status ${res.status}`);
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from archipelagos`;
  assert.equal(rows[0]!.n, 0, 'nothing may be provisioned for an unauthenticated caller');
});

/* conformance check 9 — worlds/src/conformance.ts */
test('contract 9: a credential this platform did not issue is refused; presence is not enough', { skip }, async () => {
  const forged = await fetch(`${base}/v1/provision`, {
    ...provisionRequest('ent-forged'),
    headers: { ...provisionRequest('ent-forged').headers, authorization: 'Bearer not-this-platforms-token' },
  });
  assert.ok(forged.status === 401 || forged.status === 403, `status ${forged.status}`);

  // A REAL principal without the provision scope is refused too — the scope is the check, not
  // the header. And a player token can never provision a world for themselves.
  const wrongScope = await fetch(`${base}/v1/provision`, {
    ...provisionRequest('ent-scope'),
    headers: { ...provisionRequest('ent-scope').headers, authorization: 'Bearer other-service' },
  });
  assert.equal(wrongScope.status, 403);
  const player = await fetch(`${base}/v1/provision`, {
    ...provisionRequest('ent-player'),
    headers: { ...provisionRequest('ent-player').headers, authorization: 'Bearer alice' },
  });
  assert.equal(player.status, 403);
});

/* conformance checks 5 and 6 — worlds/src/conformance.ts. THE ONE THAT MATTERS. */
test('contract 5-6: a provision returns a urn; provisioning twice returns the SAME urn, replayed', { skip }, async () => {
  const first = await fetch(`${base}/v1/provision`, provisionRequest('ent-1'));
  assert.ok(first.status === 200 || first.status === 201, `status ${first.status}`);
  const b1 = (await first.json()) as { urn?: unknown; replayed?: unknown };
  // worlds/src/titleclient.ts — a 2xx with no urn is treated as an outage.
  assert.equal(typeof b1.urn, 'string');
  assert.ok((b1.urn as string).length > 0);
  assert.match(b1.urn as string, /^cf:aetherholm:skerry:/, 'the urn names what was created');
  assert.equal(b1.replayed, false);

  const second = await fetch(`${base}/v1/provision`, provisionRequest('ent-1'));
  assert.ok(second.status === 200 || second.status === 201);
  const b2 = (await second.json()) as { urn?: unknown; replayed?: unknown };
  assert.equal(b2.urn, b1.urn, 'a second urn would be a SECOND world for one purchase');
  // worlds reads replayed strictly as `=== true` (titleclient.ts).
  assert.equal(b2.replayed, true);

  // One skerry, its islands, one provision row, one event.
  const skerries = await sql<{ n: number }[]>`
    select count(*)::int as n from archipelagos where kind = 'skerry'
  `;
  assert.equal(skerries[0]!.n, 1);
  const islands = await sql<{ n: number }[]>`select count(*)::int as n from islands`;
  assert.equal(islands[0]!.n, SKERRY_ISLAND_COUNT);
  const events = await sql<{ n: number }[]>`
    select count(*)::int as n from outbox where topic = ${SKERRY_PROVISIONED_TOPIC}
  `;
  assert.equal(events[0]!.n, 1, 'the replay must not emit a second provisioned event');
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * The contract package, driven SENDER THROUGH TO RECEIVER.
 *
 * Everything above restates worlds' shapes as literals with citations, which catches a drift only
 * as long as someone keeps the literals up to date. This drives the actual bytes: the request body
 * is built by `serialiseProvisionRequest` — the function worlds' bridge calls — and the answer is
 * read by `parseProvisionResult`, the function worlds' bridge reads it with. Nothing in between is
 * hand-written, so a rename on either side moves the keys and this goes red.
 *
 * That is the property `contracts-worlds` exists for, and the one a types-only package cannot
 * provide: `ProvisionRequest` and `ProvisionInput` were structurally identical types in two
 * repositories and would have typechecked green through any renaming of the wire keys.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test(
  'contract: the document worlds SERIALISES is the document this service PARSES, and back',
  { skip },
  async () => {
    const request: ProvisionRequest = {
      entitlementId: 'ent-contract',
      subject: `user:${ALICE}`,
      userId: ALICE,
      sku: 'private_skerry',
      scope: 'title:aetherholm-title-id',
      metadata: { name: 'The Contract' },
      // Carried as the request id HEADER, never in the body. A receiver that made this a required
      // body field would 400 every real request from the bridge and would still pass every test
      // written from the interface — so the serialiser dropping it is load-bearing, and this test
      // is what holds the two ends to the same asymmetry.
      correlationId: 'corr-contract',
    };

    const body = serialiseProvisionRequest(request);
    assert.deepEqual(
      Object.keys(body).sort(),
      [...PROVISION_REQUEST_FIELDS].sort(),
      'the bridge sends a different set of fields than the contract pins',
    );
    assert.ok(!('correlationId' in body), 'the correlation id must not be a body field');

    const res = await fetch(`${base}/v1/provision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer platform',
        // provisionIdempotencyKey is the contract's single spelling of the key, derived from the
        // entitlement id and from nothing else.
        'idempotency-key': provisionIdempotencyKey(request),
        'x-request-id': request.correlationId,
      },
      body: JSON.stringify(body),
    });
    assert.ok(res.status === 200 || res.status === 201, `status ${res.status}`);

    const parsed = parseProvisionResult(await res.json());
    assert.ok(parsed.ok, `worlds could not read this title's answer: ${
      parsed.ok ? '' : parsed.errors.join('; ')
    }`);
    assert.equal(parsed.value.replayed, false);

    // The urn is not merely a non-empty string: it is a well-formed title urn, which is what makes
    // it safe to store and point at. An ill-formed one is recorded for ever.
    const urn = parseTitleUrn(parsed.value.urn);
    assert.ok(urn.ok, `the urn is not a title urn: ${urn.ok ? '' : urn.errors.join('; ')}`);
    assert.deepEqual(
      urn.ok ? { title: urn.value.title, kind: urn.value.kind } : null,
      { title: 'aetherholm', kind: 'skerry' },
    );
  },
);

test('contract: the scope this title gates on is the scope worlds derives for it', () => {
  // `server.ts` spells AETHERHOLM_PROVISION_SCOPE as a literal deliberately — the estate's scope audit must be
  // able to resolve it to a string constant to prove identity can mint it, and it fails rather than
  // guesses at a computed one. This is where the two ends are held together instead: if the
  // contract's derivation and this service's literal ever disagree, worlds presents a scope this
  // gate does not accept and every provision 403s.
  assert.equal(AETHERHOLM_PROVISION_SCOPE, provisionScopeFor(TITLE_SLUG));
  assert.equal(TITLE_SLUG, TITLE_DESCRIPTOR.slug, 'the title is registered under a different slug');
});

test(
  'contract: every capability this title declares is one worlds actually knows',
  { skip },
  async () => {
    // The typo'd-capability defect, checked against the registry rather than against a literal
    // restated here. `aetherholm/src/server.ts` used to build this from a bare string array with
    // nothing to check it against, while worlds held the closed union — the same vocabulary in two
    // repositories, one of them unchecked. A capability worlds does not know is a claim to sell
    // something that can be bought and never delivered.
    const res = await fetch(`${base}/v1/title`);
    const descriptor = parseTitleDescriptor(await res.json());
    assert.ok(
      descriptor.ok,
      `worlds would refuse this descriptor: ${descriptor.ok ? '' : descriptor.errors.join('; ')}`,
    );
    assert.ok(descriptor.value.capabilities.length > 0, 'a title that claims nothing sells nothing');
    for (const capability of descriptor.value.capabilities) {
      assert.ok(isCapability(capability), `"${capability}" is not a registered capability`);
    }
  },
);

/* conformance check 5 under a genuine race: two replicas, one entitlement, one skerry. */
test('contract 5 (race): two concurrent provisions of one entitlement yield one skerry, one urn', { skip }, async () => {
  const [a, b] = await Promise.all([
    fetch(`${base}/v1/provision`, provisionRequest('ent-race')),
    fetch(`${base}/v1/provision`, provisionRequest('ent-race')),
  ]);
  const bodyA = (await a.json()) as { urn: string };
  const bodyB = (await b.json()) as { urn: string };
  assert.equal(bodyA.urn, bodyB.urn);
  const skerries = await sql<{ n: number }[]>`
    select count(*)::int as n from archipelagos where kind = 'skerry'
  `;
  assert.equal(skerries[0]!.n, 1);
});

/* conformance check 7 — worlds/src/conformance.ts */
test('contract 7: an unknown sku is refused with 422 and code unsupported — an ANSWER, not a fault', { skip }, async () => {
  const res = await fetch(
    `${base}/v1/provision`,
    provisionRequest('ent-unknown', { sku: 'definitely_not_a_real_sku' }),
  );
  assert.equal(res.status, 422);
  const body = (await res.json()) as { error: { code: string } };
  // worlds/src/titleclient.ts translates exactly this into TitleUnsupportedError, which the
  // bridge records as a TERMINAL 'unsupported' row rather than retrying (provisioning.ts).
  assert.equal(body.error.code, 'unsupported');
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from archipelagos`;
  assert.equal(rows[0]!.n, 0);
});

test('contract: a malformed provision (missing entitlementId) is 400, never a 500', { skip }, async () => {
  const res = await fetch(
    `${base}/v1/provision`,
    provisionRequest('ent-x', { entitlementId: undefined as unknown as string }),
  );
  assert.equal(res.status, 400);
});

test('contract: the skerry is deterministic per entitlement — same geography on both sides of a race', { skip }, async () => {
  await fetch(`${base}/v1/provision`, provisionRequest('ent-geo'));
  const islands = await sql<{ idx: number; band: string }[]>`
    select i.idx, i.band from islands i
      join archipelagos a on a.id = i.archipelago_id
     where a.entitlement_id = 'ent-geo' order by i.idx
  `;
  // The seed is sha256(entitlementId) folded to u64 (src/world.ts skerrySeed), so this exact
  // sequence is a fixture: if generation drifts, the chronicle's replay promise is already broken.
  assert.equal(islands.length, SKERRY_ISLAND_COUNT);
  const bands = new Set(islands.map((island) => island.band));
  assert.equal(bands.size, 3, 'a skerry carries all three bands');
});

/* ------------------------------------------------------------------ the aegis absence */

test('aegis: no provision or purchase path can grant protection — an absence, asserted', { skip }, async () => {
  // Behavioural half: an aegis-shaped SKU is not sold, it is 422 unsupported.
  for (const sku of ['aegis', 'aegis_shield', 'shield_7d']) {
    const res = await fetch(`${base}/v1/provision`, provisionRequest(`ent-${sku}`, { sku }));
    assert.equal(res.status, 422, `${sku} must be unsupported`);
  }

  // Source half, over comment-stripped source (six estate guards have fired on their own prose):
  // the provisioning module never touches the aegis column; the ONLY writer of aegis_until in
  // this repository is city founding.
  const here = (name: string) =>
    stripComments(readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8'));
  assert.ok(!here('./provisioning.ts').includes('aegis'), 'provisioning.ts must not know the aegis exists');
  assert.ok(!here('./server.ts').includes('aegis_until'), 'no route writes aegis_until directly');
  const writers = ['cities.ts', 'provisioning.ts', 'seasons.ts', 'jobs.ts', 'economy.ts', 'server.ts']
    .filter((name) => /aegis_until\s*=|aegis_until\s*,/.test(here(`./${name}`)));
  assert.deepEqual(writers, ['cities.ts'], 'only founding may set the aegis');
});
