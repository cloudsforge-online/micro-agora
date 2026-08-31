/**
 * The merged surface: three titles, one listener, driven over a real socket against THREE databases.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE ONLY TEST THAT SEES WHAT THE PROCESS ACTUALLY IS.**
 *
 * `server.test.ts` drives emberkin alone, `aetherholm/server.test.ts` drives aetherholm alone and
 * `nda/server.test.ts` drives nda alone, and all three still pass unchanged — which is how we know
 * the merge did not alter any title's own surface, and also the reason none of them can see any of
 * the five things a merge can break:
 *
 *   1. **A route reading the wrong module's database.** The kernel resolves ONE handle per request
 *      from ONE selector. Mounted without `RouteSpec.sql`, a module's handlers would be handed
 *      emberkin's database — and FOUR table names exist in all three schemas with the SAME columns
 *      (`outbox`, `event_subscriptions`, `outbox_deliveries`, `inbox`), while emberkin and
 *      aetherholm share `seasons` and `battles` on top. `select … from seasons` would SUCCEED
 *      against another game's rows. No single-module suite can see it, because in each of them
 *      there is only one database.
 *   2. **Two `/livez`, `/readyz`, `/metrics`.** Matching is first-wins, so the second copy of each
 *      is simply dead — and a dead health endpoint looks exactly like a live one.
 *   3. **A `/readyz` that reports part of the process.** Emberkin's Lifecycle probing only
 *      emberkin's database answers 200 while every city, fleet, world and day resolution is
 *      failing — and `aetherholm-web` reads that endpoint through `cf-api-aetherholm-readyz` to
 *      tell a player whether the game is up.
 *   4. **An erasure that reaches one title.** ALL THREE subscribe to `identity.user.deleted`. One
 *      webhook routing it to one module answers 202 to a deletion two thirds of which never
 *      happened, and nothing retries because nothing failed.
 *   5. **Job metrics that erase each other.** `jobs_pending` and `jobs_overdue` carry no `kind`,
 *      so before the `module` label each module's sample OVERWROTE the others' and a wedged queue
 *      was ABSENT from the graph rather than high.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Three databases are required, and the suite skips without all three. It is the one file in this
 * repository that needs `EMBERKIN_TEST_DATABASE_URL`, `AETHERHOLM_TEST_DATABASE_URL` and
 * `NDA_TEST_DATABASE_URL` at once, and `service-ci.yml` provides exactly that — one CI database per
 * declared variable, for the reason `migratortargets.test.ts` measures.
 */

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type postgres from 'postgres';
import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db';
import { TokenError, type Principal } from '@cloudsforge/auth';
import { Lifecycle, postgresProbe } from '@cloudsforge/lifecycle';
import { Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry';
import { GameData } from './content/gamedata.ts';
import { createMergedServer, registerServiceMetrics, type PrincipalVerifier } from './server.ts';
import {
  ALICE,
  CONTRACT_SIGNATURE_HEADER,
  asDb,
  enabled as emberkinEnabled,
  fakeBilling,
  migrateTestDb,
  openDb,
  quietLogger,
  resetEmberkin,
  signedEvent,
  skip as emberkinSkip,
} from './testsupport.ts';
import {
  enabled as aetherholmEnabled,
  migrateTestDb as migrateAetherholmDb,
  openDb as openAetherholmDb,
  resetAetherholm,
} from './aetherholm/testsupport.ts';
import { ensureOpenSeason } from './aetherholm/seasons.ts';
import {
  enabled as ndaEnabled,
  migrateTestDb as migrateNdaDb,
  openDb as openNdaDb,
  resetNda,
  seedWorld,
} from './nda/testsupport.ts';

/*
 * ── THE AETHERHOLM MODULE VALIDATES ITS CONFIGURATION AT IMPORT AND EXITS ON A BAD ONE ─────────
 *
 * Right for a service, fatal for a test runner — `aetherholm/env.test.ts` records the same problem
 * and solves it the same way. So a complete environment is populated FIRST and the module is then
 * imported dynamically.
 *
 * The signing secret is generated per run rather than written as a literal, for the reason
 * micro-org #142 records at length: a hyphenated placeholder that clears a length check is the
 * exact family of value the estate actually shipped, and no repository should hold a string that
 * looks like key material. `assertGeneratedSecret` refuses one anyway.
 *
 * The DSN is this suite's own test database, so the module's aetherholm half reads the same
 * database `resetAetherholm` truncates.
 */
const AETHERHOLM_TEST_DSN_VAR = 'AETHERHOLM_TEST_DATABASE_URL';
const NDA_TEST_DSN_VAR = 'NDA_TEST_DATABASE_URL';
const UNSET = ['postgres://u:p@127.0.0.1:5432', 'unset_test'].join('/');
process.env['AETHERHOLM_DATABASE_URL'] = process.env[AETHERHOLM_TEST_DSN_VAR] ?? UNSET;
process.env['NDA_DATABASE_URL'] = process.env[NDA_TEST_DSN_VAR] ?? UNSET;
process.env['OUTBOX_SIGNING_SECRET'] ??= randomBytes(48).toString('base64');
process.env['IDENTITY_JWKS_URL'] ??= 'http://127.0.0.1:4001/.well-known/jwks.json';
process.env['IDENTITY_ISSUER'] ??= 'http://127.0.0.1:4001';
// nda's `env.ts` requires these two; nothing in this suite dials either, because no route under
// test calls a peer. Named `127.0.0.1` on unused ports so a mistake is a connection refused rather
// than a request to something real.
process.env['BILLING_URL'] ??= 'http://127.0.0.1:4009';
process.env['WORLDS_URL'] ??= 'http://127.0.0.1:4000';
// A credential of the right SHAPE — `cfsc_` plus 43 base64url characters, which is what
// `assertServiceCredential` demands — generated per run and thrown away. It is here because
// WITHOUT it `serviceTokenProbe` fails hard and `/readyz` is 503 for the whole process, which is
// itself one of the things this suite proves further down. `ServiceTokenProvider` mints lazily, so
// nothing ever presents it.
process.env['NDA_IDENTITY_CREDENTIAL'] ??= `cfsc_${randomBytes(33).toString('base64url').slice(0, 43)}`;
const { createAetherholmModule } = await import('./aetherholm/module.ts');
const { createNdaModule } = await import('./nda/module.ts');

/** The one secret the merged webhook verifies against — for BOTH modules. See the fan-out below. */
const EVENT_SECRET = 'test-signing-secret-of-good-length-000';

const data = GameData.loadFromDirectory();

/** ALICE is a user of all three titles here — which is the whole point of the erasure case. */
const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    if (token === 'alice') return { kind: 'user', userId: ALICE, handle: 'alice', roles: [] };
    throw new TokenError('unknown token', 'invalid');
  },
};

const skip =
  emberkinEnabled && aetherholmEnabled && ndaEnabled
    ? false
    : emberkinSkip ||
      (aetherholmEnabled ? `set ${NDA_TEST_DSN_VAR}` : `set ${AETHERHOLM_TEST_DSN_VAR}`);

describe('the merged surface', { skip }, () => {
  let emberkinSql: postgres.Sql;
  let aetherholmSql: postgres.Sql;
  let ndaSql: postgres.Sql;
  let aetherholm: Awaited<ReturnType<typeof createAetherholmModule>>;
  let nda: Awaited<ReturnType<typeof createNdaModule>>;
  let server: Server;
  let url: string;
  let registry: Metrics;
  let seasonName: string;
  let ndaWorldId: string;
  let aetherholmStopped = false;
  let ndaStopped = false;
  const enqueued: { kind: string; key: string }[] = [];

  before(async () => {
    emberkinSql = openDb();
    await migrateTestDb(emberkinSql);
    await resetEmberkin(emberkinSql);

    aetherholmSql = openAetherholmDb();
    await migrateAetherholmDb(aetherholmSql);
    await resetAetherholm(aetherholmSql);

    ndaSql = openNdaDb();
    await migrateNdaDb(ndaSql);
    await resetNda(ndaSql);

    // A real open season, made the way the `season.ensure` job makes one — so `GET
    // /v1/seasons/current` has something to answer with, out of the `seasons` table BOTH titles own.
    const season = await ensureOpenSeason(asDb(aetherholmSql) as never, 'aetherholm', new Date());
    seasonName = season.name;

    // A started world with ALICE settled in it, so `GET /v1/worlds` has something to answer with
    // out of a table only nda owns, and so the erasure case below has something to lose.
    ndaWorldId = (await seedWorld(ndaSql, { name: 'merged-test world' })).worldId;

    // Exactly the arrangement `index.ts` builds: ONE registry rendered by /metrics, a labelled view
    // per module for the JOB plane only, one Lifecycle with two hard probes, both route tables on
    // one listener, and the mounted module's inbound sink on the one webhook.
    registry = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())));
    const jobMetrics = registry.withLabels({ module: 'emberkin' });

    // `cacheMs: 0` because a case below asserts what /readyz says a moment AFTER a database goes
    // away, and the default one-second cache would answer with the report from before it did.
    const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 100, cacheMs: 0 });

    aetherholm = await createAetherholmModule({
      metrics: registry,
      verifier,
      claimingJobs: () => false,
      track: () => lifecycle.track(),
    });
    nda = await createNdaModule({
      metrics: registry,
      verifier,
      claimingJobs: () => false,
      track: () => lifecycle.track(),
    });

    lifecycle.addProbe(postgresProbe('postgres-emberkin', () => emberkinSql`select 1`));
    lifecycle.addProbe(aetherholm.probe);
    for (const probe of nda.probes) lifecycle.addProbe(probe);

    server = createMergedServer(
      {
        lifecycle,
        logger: quietLogger(),
        // The REGISTRY, not a view: /metrics renders this object, and the kernel's HTTP metrics are
        // process-wide — one listener serves both modules and `route` already says which.
        metrics: registry,
        verifier,
        sql: networkSql({ mainnet: asDb(emberkinSql) as unknown as RuntimeSql }),
        singleNetwork: 'mainnet' as const,
        producer: 'emberkin',
        data,
        billing: fakeBilling(),
        queueFor: () => ({ enqueue: async (o) => void enqueued.push({ kind: o.kind, key: o.key }) }),
        eventAcceptSecrets: [EVENT_SECRET],
        inbound: [aetherholm.inbound, nda.inbound],
        beforeScrape: async () => {
          jobMetrics.set('jobs_pending', 0, { network: 'mainnet' });
          jobMetrics.set('jobs_overdue', 0, { network: 'mainnet' });
          await aetherholm.beforeScrape();
          await nda.beforeScrape();
        },
      },
      [...aetherholm.routes, ...nda.routes],
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    lifecycle.markReady();
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!aetherholmStopped && aetherholm) await aetherholm.stop();
    if (!ndaStopped && nda) await nda.stop();
    if (emberkinSql) await emberkinSql.end({ timeout: 5 }).catch(() => {});
    if (aetherholmSql) await aetherholmSql.end({ timeout: 5 }).catch(() => {});
    if (ndaSql) await ndaSql.end({ timeout: 5 }).catch(() => {});
  });

  const auth = { authorization: 'Bearer alice', 'content-type': 'application/json' };

  /* ---------------------------------------------------------------- route table */

  describe('the three route tables are mounted, and none shadows another', () => {
    it("answers emberkin's reads", async () => {
      const res = await fetch(`${url}/v1/content/dex`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { dex: unknown[] };
      assert.ok(body.dex.length > 0, "emberkin's content is served from emberkin's own GameData");
    });

    it("answers aetherholm's title contract on the SAME listener and the SAME port", async () => {
      // The route `worlds` calls. Public and unauthenticated by design.
      //
      // ── WAVE M5d: UNDER `/aetherholm`, AND THE PATH IS NOT WHAT MOVED ────────────────────────
      //
      // `GET /v1/title` and `POST /v1/provision` are frozen constants in
      // `@cloudsforge/contracts-worlds` and BOTH aetherholm and tessera mount them. `../index.ts`'s
      // header refused tessera into this process on exactly that ground; wave M5d puts them in one
      // process anyway, because tessera has been a module of agora since M5b.
      //
      // What moved is this title's BASE URL, not the contract: `worlds/titleclient.ts` composes a
      // title's address as `base.pathname + FROZEN_SUFFIX`, so a title registered at
      // `http://agora:4000/aetherholm` is asked for exactly `TITLE_DESCRIPTOR_PATH` at that base.
      // The suffix `worlds` appends is unchanged, which is why no contract changed.
      //
      // The bare path is asserted to be SOMEBODY ELSE'S below rather than merely absent — a 404
      // here would pass whether the remount worked or the route simply stopped existing.
      const res = await fetch(`${url}/aetherholm/v1/title`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { slug: string; capabilities: string[] };
      assert.equal(body.slug, 'aetherholm');
      assert.deepEqual(body.capabilities, ['private_world']);
    });

    it("answers nda's worlds on the SAME listener and the SAME port", async () => {
      const res = await fetch(`${url}/v1/worlds`, { headers: auth });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { worlds: { id: string; name: string }[] };
      assert.ok(
        body.worlds.some((w) => w.id === ndaWorldId),
        `the seeded world must be served by the merged listener: ${JSON.stringify(body.worlds)}`,
      );
    });

    it("and the BARE /v1/title is no longer aetherholm's, which is the half that matters", async () => {
      // In THIS process — emberkin standalone — nothing else mounts it, so the bare path is a 404.
      // In agora it is TESSERA's, and that is the collision this remount exists to resolve. Both
      // are the same assertion from this listener's side: aetherholm does not answer here.
      //
      // Asserted rather than left implicit, because the failure mode is silent in exactly one
      // direction: a title left registered at an origin-only base URL is answered by whichever
      // title kept the path, with a 200, and a player who paid for an archipelago is provisioned
      // somebody else's product.
      const res = await fetch(`${url}/v1/title`);
      assert.equal(res.status, 404);
    });

    it('and an unknown path is still one 404 for the whole process', async () => {
      const res = await fetch(`${url}/v1/no-such-route`);
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'not_found');
    });
  });

  /* ---------------------------------------------------------------- the right database */

  describe("every mounted route reads ITS OWN module's database, not the host's", () => {
    it('serves a table that exists only in the aetherholm schema', async () => {
      // `archipelagos` is aetherholm's. Emberkin's database has no such table, so a route handed
      // the host's selector would 500 here rather than answer — which is the whole reason
      // `RouteSpec.sql` exists.
      const res = await fetch(`${url}/v1/archipelagos`, { headers: auth });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { archipelagos: unknown[] };
      assert.ok(Array.isArray(body.archipelagos));
    });

    it("reads the AETHERHOLM seasons table, and emberkin's identically-named one is not it", async () => {
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════════
       * BOTH MODULES OWN A TABLE CALLED `seasons`, WITH DIFFERENT COLUMNS.
       *
       * A row is planted in each. The aetherholm read must answer from the schema that has
       * `seed`, `opened_at` and a `public` archipelago joined to it; run against emberkin's
       * `seasons` — which has `slug`, `starts_at` and `reward_budget_wei` — the same statement
       * is a 500, and mounted without `RouteSpec.sql` that is exactly where it would have run.
       * ══════════════════════════════════════════════════════════════════════════════════════════
       */
      await emberkinSql`
        insert into seasons (slug, name, starts_at, ends_at, status, reward_budget_wei)
        values ('merged-test', 'AN EMBERKIN SEASON, NOT AN AETHERHOLM ONE', now(), now() + interval '30 days',
                'active', 1000)
        on conflict (slug) do nothing
      `;

      const res = await fetch(`${url}/v1/seasons/current`, { headers: auth });
      assert.equal(res.status, 200, 'against emberkin’s seasons table this statement is a 500');
      const body = (await res.json()) as { name: string; seed: string; archipelagoId: string };
      assert.equal(body.name, seasonName, 'the merged read must answer from aetherholm’s season');
      assert.notEqual(body.name, 'AN EMBERKIN SEASON, NOT AN AETHERHOLM ONE');
      assert.match(body.seed, /^\d+$/, 'aetherholm’s seasons carry a seed; emberkin’s have no such column');
    });

    it("and emberkin's own reads still see emberkin's rows", async () => {
      const rows = await emberkinSql<{ name: string }[]>`select name from seasons where slug = 'merged-test'`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.name, 'AN EMBERKIN SEASON, NOT AN AETHERHOLM ONE');

      // And aetherholm's database never saw it — the two `seasons` tables are two tables.
      const theirs = await aetherholmSql<{ n: number }[]>`
        select count(*)::int as n from seasons where name = 'AN EMBERKIN SEASON, NOT AN AETHERHOLM ONE'
      `;
      assert.equal(theirs[0]?.n, 0);
    });

    it("serves a table only NDA's schema has, which no other module's handle could answer", async () => {
      // `worlds` is nda's. Neither emberkin's nor aetherholm's database has such a table, so a
      // route handed the host's selector would 500 here rather than answer — which is the whole
      // reason `RouteSpec.sql` is stamped over the mounted table.
      const res = await fetch(`${url}/v1/worlds/${ndaWorldId}`, { headers: auth });
      assert.equal(res.status, 200, 'against emberkin’s database this statement is a 500');
      const body = (await res.json()) as { world: { id: string; status: string } };
      assert.equal(body.world.id, ndaWorldId);
      assert.equal(body.world.status, 'active');
    });

    it('and every mounted route in the process carries a selector — remove one and the cases above go red', () => {
      /*
       * Stated once, over BOTH mounted tables, because it is the property those cases depend on
       * rather than a property of either module. A spec with no `sql` resolves to the kernel's own
       * selector, which is emberkin's.
       */
      for (const spec of [...aetherholm.routes, ...nda.routes]) {
        assert.notEqual(spec.sql, undefined, `${spec.method} ${spec.path} would read emberkin's database`);
      }
      assert.ok(aetherholm.routes.length + nda.routes.length > 55, 'both modules must have mounted something');
    });
  });

  /* ---------------------------------------------------------------- one of each infra route */

  describe('one process serves exactly one of each operational route', () => {
    it('/livez answers 200', async () => {
      assert.equal((await fetch(`${url}/livez`)).status, 200);
    });

    it('/metrics answers 200 and is emberkin’s, which is what Prometheus scrapes', async () => {
      assert.equal((await fetch(`${url}/metrics`)).status, 200);
    });

    it('and every mounted module dropped all four of the paths it must not serve', async () => {
      // Stated as a test rather than in a comment, because it is the property `mountableRoutes`
      // exists for and the one a careless edit would undo. `mergedroutes.test.ts` proves the
      // overlap is exactly these four; this proves each module actually dropped them.
      for (const [name, routes, floor] of [
        ['aetherholm', aetherholm.routes, 25],
        ['nda', nda.routes, 25],
      ] as const) {
        const mounted = routes.map((r) => `${r.method} ${r.path}`);
        for (const dead of ['GET /livez', 'GET /readyz', 'GET /metrics', 'POST /v1/events']) {
          assert.ok(!mounted.includes(dead), `${name} mounted ${dead} — the second copy is dead`);
        }
        assert.ok(mounted.length > floor, `only ${mounted.length} ${name} routes mounted`);
      }
    });
  });

  /* ---------------------------------------------------------------- the shared webhook */

  describe('POST /v1/events verifies ONCE and fans out to every module that subscribes', () => {
    it("delivers identity.user.deleted to ALL THREE titles' databases, checked directly", async () => {
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════════
       * THE CASE THE FAN-OUT EXISTS FOR.
       *
       * Before the merge, identity's relay held one subscription row per service and delivered
       * this event twice. After it there is ONE endpoint. Route it to one module and the other
       * title never erases — the deletion answers 202, the producer marks it delivered, and every
       * city that person founded is still standing. Nothing retries, because nothing failed.
       *
       * So this asserts the ROWS, in both databases, and not the 202.
       *
       * The seed rows are the estate's own erasure-drill fixtures, verbatim from
       * `deploy/erasure/register.psv`.
       * ══════════════════════════════════════════════════════════════════════════════════════════
       */
      const archipelagoId = '00000000-0000-4000-8000-0000000d5111';
      await emberkinSql`
        insert into saves (user_id, warden_name, seed, current_region)
        values (${ALICE}, 'Drill', 1, 'ember-vale')
      `;
      await aetherholmSql`
        insert into archipelagos (id, kind, name, seed, owner_subject, entitlement_id)
        values (${archipelagoId}::uuid, 'skerry', 'Drill', 1, ${`user:${ALICE}`}, 'drill-ent')
        on conflict do nothing
      `;
      await aetherholmSql`
        insert into research (archipelago_id, user_id, node) values (${archipelagoId}, ${ALICE}, 'drill-node')
      `;

      const before = {
        saves: (await emberkinSql<{ n: number }[]>`select count(*)::int as n from saves where user_id = ${ALICE}`)[0]?.n,
        research: (await aetherholmSql<{ n: number }[]>`select count(*)::int as n from research where user_id = ${ALICE}`)[0]?.n,
        // nda's is the world `before` seeded: ALICE joined it, so there is a `players` row naming
        // her. Nothing extra is planted here — the fixture is the real join path.
        players: (await ndaSql<{ n: number }[]>`select count(*)::int as n from players where user_id = ${ALICE}`)[0]?.n,
      };
      assert.deepEqual(before, { saves: 1, research: 1, players: 1 }, 'all three titles must hold something to lose');

      const { body, signature } = await signedEvent(EVENT_SECRET, {
        id: randomUUID(),
        topic: 'identity.user.deleted',
        payload: { userId: ALICE },
      });
      const res = await fetch(`${url}/v1/events`, {
        method: 'POST',
        headers: { [CONTRACT_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 202);
      const reply = (await res.json()) as { status: string; erased?: boolean; fanout?: Record<string, string> };
      assert.equal(reply.status, 'accepted');
      assert.equal(reply.erased, true, "emberkin's own half ran");
      assert.deepEqual(
        reply.fanout,
        { aetherholm: 'processed', nda: 'processed' },
        'EVERY mounted module that subscribes must be named in the reply',
      );

      // THE ROWS. A 202 proves nothing on its own — that is the failure this whole route shape
      // exists to prevent.
      const afterEmberkin = await emberkinSql<{ n: number }[]>`select count(*)::int as n from saves where user_id = ${ALICE}`;
      assert.equal(afterEmberkin[0]?.n, 0, "emberkin's save survived a deletion that answered 202");
      const afterAetherholm = await aetherholmSql<{ n: number }[]>`select count(*)::int as n from research where user_id = ${ALICE}`;
      assert.equal(afterAetherholm[0]?.n, 0, "aetherholm's rows survived a deletion that answered 202");
      const owner = await aetherholmSql<{ owner_subject: string }[]>`
        select owner_subject from archipelagos where id = ${archipelagoId}
      `;
      assert.match(owner[0]?.owner_subject ?? '', /^erased:/, 'the skerry owner must be anonymised, not left named');

      const afterNda = await ndaSql<{ n: number }[]>`select count(*)::int as n from players where user_id = ${ALICE}`;
      assert.equal(afterNda[0]?.n, 0, "nda's player survived a deletion that answered 202");
    });

    it('writes an inbox row in EACH database, so redelivery is deduped per module', async () => {
      /*
       * The three `inbox` tables are three tables — one of the FOUR names every schema in this
       * process owns, and the four that share COLUMNS as well as a name. That is what makes this
       * the sharpest case in the file: a module handed another module's handle would write a row
       * that is entirely valid, in the wrong database, and the redelivery that should have carried
       * the erasure would then be deduped away for ever. Nothing errors, nothing logs, nothing
       * alerts.
       *
       * Each module's dedupe is its own, which is what makes a redelivery a no-op for all three
       * rather than for one.
       */
      for (const [name, handle] of [
        ['emberkin', emberkinSql],
        ['aetherholm', aetherholmSql],
        ['nda', ndaSql],
      ] as const) {
        const rows = await handle<{ n: number }[]>`select count(*)::int as n from inbox`;
        assert.equal(rows[0]?.n, 1, `${name} must hold exactly its own one inbox row`);
      }
    });

    it('refuses a bad signature with 403 before either module is reached', async () => {
      const res = await fetch(`${url}/v1/events`, {
        method: 'POST',
        headers: { [CONTRACT_SIGNATURE_HEADER]: 'v1=deadbeef', 'content-type': 'application/json' },
        body: JSON.stringify({ id: randomUUID(), topic: 'identity.user.deleted', payload: { userId: ALICE } }),
      });
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'bad_signature');
    });

    it('lets a sink REFUSE a malformed payload rather than acknowledging a deletion it cannot do', async () => {
      // A `userId` that is not a uuid. The standalone aetherholm route answered 400; the merged one
      // must too, and must NOT write emberkin's inbox row — because a redelivery is the only thing
      // that will ever make the other half happen.
      const inboxBefore = (await emberkinSql<{ n: number }[]>`select count(*)::int as n from inbox`)[0]?.n;
      const { body, signature } = await signedEvent(EVENT_SECRET, {
        id: randomUUID(),
        topic: 'identity.user.deleted',
        payload: { userId: 'not-a-uuid' },
      });
      const res = await fetch(`${url}/v1/events`, {
        method: 'POST',
        headers: { [CONTRACT_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 400);
      const err = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(err.error.code, 'bad_request');
      assert.match(err.error.message, /^aetherholm: /, 'the refusal must say which module refused');
      const inboxAfter = (await emberkinSql<{ n: number }[]>`select count(*)::int as n from inbox`)[0]?.n;
      assert.equal(inboxAfter, inboxBefore, 'a refused fan-out must not leave the host half acknowledged');
    });

    it('routes a topic TWO modules subscribe to, and leaves the third alone', async () => {
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════════
       * `billing.entitlement.granted` IS SUBSCRIBED BY EMBERKIN AND BY NDA, AND NOT BY AETHERHOLM.
       *
       * Wave M3's process had one shared topic. This one has two, with different memberships, and
       * that is what makes "route the event to a module" impossible rather than merely unwise: the
       * envelope carries a topic, never a destination, so there is no information in the request
       * that could tell one subscriber from two. The fan-out is taken against the union and every
       * interested module is named in the reply.
       * ══════════════════════════════════════════════════════════════════════════════════════════
       */
      const ndaInboxBefore = (await ndaSql<{ n: number }[]>`select count(*)::int as n from inbox`)[0]?.n;
      const { body, signature } = await signedEvent(EVENT_SECRET, {
        id: randomUUID(),
        topic: 'billing.entitlement.granted',
        payload: { sku: 'emberkin_season_pass', subject: `user:${ALICE}`, entitlementId: 'ent-merged-1' },
      });
      const res = await fetch(`${url}/v1/events`, {
        method: 'POST',
        headers: { [CONTRACT_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 202);
      const reply = (await res.json()) as { status: string; reward?: string; fanout?: unknown };
      assert.equal(reply.reward, 'queued');
      assert.deepEqual(
        reply.fanout,
        { nda: 'processed' },
        'aetherholm does not subscribe to this topic, so it must not be in the reply; nda does',
      );
      assert.ok(enqueued.some((e) => e.key === 'ent-merged-1'), 'the reward job must still be enqueued');

      // And nda's half was a real delivery into nda's OWN inbox, not a shrug.
      const ndaInboxAfter = (await ndaSql<{ n: number }[]>`select count(*)::int as n from inbox`)[0]?.n;
      assert.equal(ndaInboxAfter, (ndaInboxBefore ?? 0) + 1, 'nda must have deduped this event in its own database');
      const aetherholmInbox = (await aetherholmSql<{ n: number }[]>`select count(*)::int as n from inbox`)[0]?.n;
      assert.equal(aetherholmInbox, 1, 'a module that does not subscribe must not be given the event');
    });

    it('still 202-ignores a topic NEITHER module subscribes to', async () => {
      // The ignore decision is taken against the UNION. A 4xx here would make the producer's relay
      // retry the same event for ever.
      const { body, signature } = await signedEvent(EVENT_SECRET, {
        id: randomUUID(),
        topic: 'pool.share.accepted',
        payload: {},
      });
      const res = await fetch(`${url}/v1/events`, {
        method: 'POST',
        headers: { [CONTRACT_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 202);
      assert.equal(((await res.json()) as { status: string }).status, 'ignored');
    });
  });

  /* ---------------------------------------------------------------- one /metrics, two modules */

  describe('/metrics carries every module, and their job series do not erase each other', () => {
    it("renders all three modules' domain metrics from one registry", async () => {
      const text = await scrape();
      assert.match(text, /emberkin_battles_resolved_total/, "emberkin's series must be on the merged page");
      assert.match(text, /aetherholm_provisions_total/, "aetherholm's series must be on the merged page");
      assert.match(text, /nda_days_resolved_total/, "nda's series must be on the merged page");
    });

    it('keeps jobs_pending as THREE series, one per module', async () => {
      /*
       * ════════════════════════════════════════════════════════════════════════════════════════
       * THE COLLISION THIS WHOLE LABEL EXISTS FOR.
       *
       * `jobs_pending` and `jobs_overdue` carry no `kind`. Two modules calling
       * `metrics.set('jobs_pending', …)` against one registry write the IDENTICAL series, so
       * whichever samples last erases the other — and a wedged queue is then not "high" on the
       * graph, it is ABSENT from it. Nobody alerts on absent, and `JobQueueOverdue` in
       * `deploy/prometheus/rules/alerts.yaml` is `expr: jobs_overdue > 0`.
       *
       * emberkin's `network` label does NOT solve this: it distinguishes its two planes from each
       * other, never from aetherholm. `withLabels({ module })` is what makes each module's write a
       * different series. Both must be present after ONE scrape, which is the only arrangement in
       * which the erasure could have happened.
       * ════════════════════════════════════════════════════════════════════════════════════════
       */
      const lines = (await scrape()).split('\n');
      for (const metric of ['jobs_pending', 'jobs_overdue']) {
        const series = lines.filter((line) => line.startsWith(`${metric}{`));
        for (const module of ['emberkin', 'aetherholm', 'nda']) {
          assert.ok(
            series.some((line) => line.includes(`module="${module}"`)),
            `${metric} has no ${module} series — another module's sample erased it:\n${series.join('\n')}`,
          );
        }
        assert.equal(series.length, 3, `${metric} must be exactly three series, one per module`);
      }
    });

    it('labels the counters that DO carry a kind, so three relays are three series', async () => {
      // Every module registers a job `kind="outbox.relay"`. Summing them would produce a number an
      // alert still fires on and nobody can act on. `jobcomposition.test.ts` proves the same
      // property against the registry directly, and proves the unlabelled shape collapses.
      for (const module of ['aetherholm', 'emberkin', 'nda']) {
        registry.withLabels({ module }).increment('jobs_failed_total', { kind: 'outbox.relay' });
      }

      const failed = (await scrape()).split('\n').filter((line) => line.startsWith('jobs_failed_total{'));
      const relays = failed.filter((line) => line.includes('kind="outbox.relay"'));
      assert.equal(relays.length, 3, `three modules' relays must be three series:\n${failed.join('\n')}`);
      for (const line of relays) assert.match(line, / 1$/, 'each module counts its own failure, not the sum');
    });

    it('and does the same for the achievement bridge, which emberkin and nda BOTH register', async () => {
      /*
       * The collision wave M4a added, on the page rather than in a unit. `achievement.deliver` is a
       * real bridge in two different games, posting into two different `worlds` profiles — and both
       * runners label `{kind, network}`, so without `module` a mainnet failure in each is ONE
       * series. That is the number an operator reads when deliveries stop.
       */
      for (const module of ['emberkin', 'nda']) {
        registry
          .withLabels({ module })
          .increment('jobs_dead_total', { kind: 'achievement.deliver', network: 'mainnet' });
      }
      const dead = (await scrape())
        .split('\n')
        .filter((line) => line.startsWith('jobs_dead_total{') && line.includes('achievement.deliver'));
      assert.equal(dead.length, 2, `two games' bridges must be two series:\n${dead.join('\n')}`);
      assert.ok(dead.some((l) => l.includes('module="emberkin"')));
      assert.ok(dead.some((l) => l.includes('module="nda"')));
      for (const line of dead) assert.match(line, / 1$/, 'each game counts its own dead job, not the sum');
    });

    it('renders the REGISTRY, so nothing about the page depends on which module wrote a series', async () => {
      // `/metrics` is handed the registry itself, not a view. Rendering a view would work — a view
      // shares the registry's series maps — but it reads as though the view owned the endpoint, and
      // that is what the next person adding a third module would copy. The observable half is
      // asserted here: every series, whoever wrote it, on one page.
      const text = await scrape();
      assert.match(text, /aetherholm_cities_founded_total/, "an emberkin-only render would omit aetherholm's");
      assert.match(text, /nda_worlds_due/, "and would omit nda's");
      assert.match(text, /emberkin_service_token_static/);
      // And the process-wide HTTP metrics are NOT stamped with a module: one listener serves both,
      // and the `route` label already says which. A module label here would be a lie for half the
      // series on the page.
      const http = text.split('\n').filter((line) => line.startsWith('http_requests_total{'));
      assert.ok(http.length > 0, 'the kernel must have recorded the requests this suite made');
      for (const line of http) {
        assert.ok(!line.includes('module='), `http_requests_total must not claim a module: ${line}`);
      }
    });

    async function scrape(): Promise<string> {
      const res = await fetch(`${url}/metrics`);
      assert.equal(res.status, 200);
      return await res.text();
    }
  });

  /* ---------------------------------------------------------------- readiness covers both */

  describe('/readyz reflects ALL THREE databases', () => {
    it('names a hard probe for every module, and every one passes', async () => {
      const res = await fetch(`${url}/readyz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ready: boolean; checks: Array<{ name: string; state: string }> };
      assert.equal(body.ready, true);
      assert.deepEqual(
        body.checks.map((c) => c.name).sort(),
        ['nda-identity-credential', 'postgres-aetherholm', 'postgres-emberkin', 'postgres-nda'],
        'a merged /readyz that probes one database answers 200 while another module is entirely ' +
          'dead, and the balancer keeps sending traffic to it — and aetherholm-web tells the ' +
          'player the game is up',
      );
      for (const check of body.checks) assert.equal(check.state, 'pass', `${check.name} must be passing`);
    });

    it("and the fourth check is nda's CREDENTIAL, which is what this merge widened", async () => {
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════════
       * SAID OUT LOUD, WITH A TEST, BECAUSE IT IS THE ONE COST OF WAVE M4a THAT REACHES A PLAYER.
       *
       * nda's standalone `/readyz` failed HARD when `NDA_IDENTITY_CREDENTIAL` was unset: a replica
       * that cannot authenticate to billing or worlds answers 503 to every equip and delivers no
       * achievement, so it must take no traffic. That guarantee is preserved here rather than
       * quietly downgraded to a soft probe.
       *
       * The consequence is new, though. emberkin publishes NO `/readyz` router of its own, so
       * `cf-api-aetherholm-readyz` and the `Path(/worlds/aetherholm/readyz)` clause on the apex
       * (`deploy/gateway/dynamic/estate-web.yml:1850,1880`) are the only readiness this process
       * exposes — and `aetherholm-web` renders it as whether AETHERHOLM is up. An nda deployment
       * mistake therefore reads, on a public page, as a different game being down.
       *
       * The alternative was making the probe soft, which is worse: it would let a title with no
       * credential take traffic and 503 every write, which is the failure nobody notices.
       * ══════════════════════════════════════════════════════════════════════════════════════════
       */
      const res = await fetch(`${url}/readyz`);
      const body = (await res.json()) as { checks: Array<{ name: string; state: string; kind?: string }> };
      const credential = body.checks.find((c) => c.name === 'nda-identity-credential');
      assert.notEqual(credential, undefined, "nda's credential must be reported by name");
      assert.equal(credential?.kind, 'hard', 'a soft credential probe would let a dead title take traffic');
      // And it is named for the MODULE, not `identity-credential`: two modules taking the package
      // default would be two rows in this list that nobody could tell apart.
      assert.equal(body.checks.filter((c) => c.name === 'identity-credential').length, 0);
    });

    // The two destructive cases, in order, and LAST. Each takes one module away on purpose and
    // reads the endpoint the load balancer — and `cf-api-aetherholm-readyz` — read.
    it('goes UNREADY when the NDA database is the one that has gone, and says which', async () => {
      await nda.stop();
      ndaStopped = true;

      const res = await fetch(`${url}/readyz`);
      const body = (await res.json()) as { ready: boolean; checks: Array<{ name: string; state: string }> };
      assert.equal(res.status, 503);
      assert.equal(body.ready, false);
      const theirs = body.checks.find((c) => c.name === 'postgres-nda');
      assert.notEqual(theirs, undefined, 'the nda probe must still be reported');
      assert.notEqual(theirs?.state, 'pass', "nda's database is gone and /readyz must say so");

      // And the OTHER TWO are still fine, so this is not "everything broke" — it is one module
      // reported honestly, which is exactly what a merged readiness has to be able to do. This is
      // the case a two-module suite could not have: with three, "one failed" and "the rest are
      // fine" are separate claims.
      assert.equal(body.checks.find((c) => c.name === 'postgres-emberkin')?.state, 'pass');
      assert.equal(body.checks.find((c) => c.name === 'postgres-aetherholm')?.state, 'pass');
    });

    it('and stays UNREADY, now naming TWO modules, when aetherholm goes too', async () => {
      await aetherholm.stop();
      aetherholmStopped = true;

      const res = await fetch(`${url}/readyz`);
      const body = (await res.json()) as { ready: boolean; checks: Array<{ name: string; state: string }> };
      assert.equal(res.status, 503);
      assert.equal(body.ready, false);
      const failing = body.checks.filter((c) => c.state !== 'pass').map((c) => c.name).sort();
      assert.deepEqual(
        failing,
        ['postgres-aetherholm', 'postgres-nda'],
        'a readiness report that collapsed to one line would tell an operator to look in one place',
      );
      assert.equal(body.checks.find((c) => c.name === 'postgres-emberkin')?.state, 'pass');
    });
  });
});
