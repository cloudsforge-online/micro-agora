/**
 * The merged surface: five modules, one listener, driven over a real socket against FIVE databases.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE ONLY TEST THAT SEES WHAT THE PROCESS ACTUALLY IS.**
 *
 * `server.test.ts` drives agora alone, and `devplatform/server.test.ts`, `policy/server.test.ts`,
 * `pricing/server.test.ts` and `studio/server.test.ts` each drive their module alone. All five
 * still pass unchanged — which is how we know the merge did not alter any module's own surface,
 * and also the reason none of them can see any of the five things a merge can break:
 *
 *   1. **A route reading the wrong module's database.** The kernel resolves ONE handle per request
 *      from ONE selector. Mounted without `RouteSpec.sql`, a module's handlers would be handed
 *      agora's database — and `inbox` and `jobs` exist in ALL FIVE schemas with the same columns,
 *      while `outbox`, `event_subscriptions` and `outbox_deliveries` exist in four.
 *      `insert into inbox …` would SUCCEED against the wrong database and dedupe an event it has
 *      never seen. No single-module suite can see it, because in each of them there is only one
 *      database.
 *   2. **Two `/livez`, `/readyz`, `/metrics`.** Matching is first-wins, so the second copy of each
 *      is simply dead — and a dead health endpoint looks exactly like a live one.
 *   3. **A `/readyz` that reports part of the process.** agora's Lifecycle probing only agora's
 *      database answers 200 while every developer key, policy decision, rate quote and brand kit
 *      is failing, and the balancer keeps sending traffic to it.
 *   4. **An event webhook that verifies with the wrong key.** THREE modules mount `POST
 *      /v1/events` and none of them verifies with the same secret. One shared route would be one
 *      key deciding for three — either refusing deliveries that are correctly signed, or
 *      accepting into the wrong module's database deliveries the owning module would have refused.
 *   5. **Job metrics that erase each other.** `jobs_pending` and `jobs_overdue` carry no `kind`,
 *      so without the `module` label each module's sample OVERWRITES the others' and a wedged
 *      queue is ABSENT from the graph rather than high.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Five databases are required, and the suite skips without all five. It is the one file in this
 * repository besides `studio/boot.test.ts` that needs `AGORA_TEST_DATABASE_URL`,
 * `DEVPLATFORM_TEST_DATABASE_URL`, `POLICY_TEST_DATABASE_URL`, `PRICING_TEST_DATABASE_URL` and
 * `STUDIO_TEST_DATABASE_URL` at once, and `service-ci.yml` provides exactly that — one CI database
 * per declared `database-env-var` entry, for the reason `migratortargets.test.ts` measures.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { TokenError, type Principal } from '@cloudsforge/auth'
import { Lifecycle, postgresProbe } from '@cloudsforge/lifecycle'
import { Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { createMergedServer, registerServiceMetrics, EVENTS_PATH, MOUNTED_EVENTS_PATH } from './server.ts'
import type { PrincipalVerifier } from './server.ts'
import { SIGNATURE_HEADER, signEvent, type Db as AgoraDb } from './outbox.ts'
import {
  db as _asDb,
  enabled as agoraEnabled,
  migrateTestDb as migrateAgora,
  openDb as openAgora,
  quietLogger,
  resetAgora,
  fakePolicy,
} from './testsupport.ts'
import {
  enabled as devplatformEnabled,
  migrateTestDb as migrateDevplatform,
  openDb as openDevplatform,
  resetDevplatform,
} from './devplatform/testsupport.ts'
import {
  enabled as policyEnabled,
  migrateTestDb as migratePolicy,
  openDb as openPolicy,
  resetPolicy,
} from './policy/testsupport.ts'
import {
  enabled as pricingEnabled,
  migrateTestDb as migratePricing,
  openDb as openPricing,
  resetPricing,
} from './pricing/testsupport.ts'
import {
  enabled as studioEnabled,
  migrateTestDb as migrateStudio,
  openDb as openStudio,
  resetStudio,
} from './studio/testsupport.ts'

/*
 * ── EVERY MOUNTED MODULE VALIDATES ITS CONFIGURATION AT IMPORT AND EXITS ON A BAD ONE ─────────
 *
 * Right for a service, fatal for a test runner. So a complete environment is populated FIRST and
 * the four modules are then imported dynamically.
 *
 * The three secrets are generated per run rather than written as literals, for the reason
 * micro-org #142 records at length: a hyphenated placeholder that clears a length check is the
 * exact family of value the estate actually shipped, and no repository should hold a string that
 * looks like key material. `assertGeneratedSecret` refuses one anyway.
 *
 * ── AND THE THREE SECRETS ARE DELIBERATELY DIFFERENT ──────────────────────────────────────────
 *
 * That is the whole point of the event-split cases below. If this file used one secret for all
 * three webhooks, a shared route would pass every case in it and the split would look like
 * ceremony. Three different generated values make "one key deciding for three" a thing the suite
 * can observe: a delivery signed for one module is REFUSED by the other two.
 */
const AGORA_EVENT_SECRET = randomBytes(48).toString('base64')
const DEVPLATFORM_INGEST_SECRET = randomBytes(48).toString('base64')
const POLICY_EVENT_SECRET = randomBytes(48).toString('base64')

const assetRoot = await mkdtemp(join(tmpdir(), 'platform-merged-'))

process.env['DEVPLATFORM_DATABASE_URL'] = process.env['DEVPLATFORM_TEST_DATABASE_URL'] ?? ''
process.env['POLICY_DATABASE_URL'] = process.env['POLICY_TEST_DATABASE_URL'] ?? ''
process.env['PRICING_DATABASE_URL'] = process.env['PRICING_TEST_DATABASE_URL'] ?? ''
process.env['STUDIO_DATABASE_URL'] = process.env['STUDIO_TEST_DATABASE_URL'] ?? ''
process.env['IDENTITY_JWKS_URL'] ??= 'http://127.0.0.1:4001/.well-known/jwks.json'
process.env['IDENTITY_ISSUER'] ??= 'http://127.0.0.1:4001'
process.env['OUTBOX_SIGNING_SECRET'] ??= randomBytes(48).toString('base64')
process.env['DEVPLATFORM_INGEST_SECRETS'] = DEVPLATFORM_INGEST_SECRET
process.env['OUTBOX_ACCEPT_SECRETS'] = POLICY_EVENT_SECRET
// A real directory, so studio's boot-time write check passes. Removed in `after`.
process.env['STUDIO_ASSET_ROOT'] = assetRoot
// No image model: the placeholder backend always exists, so this module is fully constructible
// without a spend credential, and a merged suite that could spend money is a suite nobody runs.
process.env['AZURE_FOUNDRY_ENDPOINT'] = ''
process.env['AZURE_FOUNDRY_API_KEY'] = ''

const enabled = agoraEnabled && devplatformEnabled && policyEnabled && pricingEnabled && studioEnabled
const missing = [
  ['AGORA_TEST_DATABASE_URL', agoraEnabled],
  ['DEVPLATFORM_TEST_DATABASE_URL', devplatformEnabled],
  ['POLICY_TEST_DATABASE_URL', policyEnabled],
  ['PRICING_TEST_DATABASE_URL', pricingEnabled],
  ['STUDIO_TEST_DATABASE_URL', studioEnabled],
]
  .filter(([, ok]) => !ok)
  .map(([name]) => name as string)

/**
 * The skip reason names EVERY missing database, not the first.
 *
 * `service-ci.yml`'s skip scan reads this line and judges it against the variables the job
 * exported: a message naming only variables it DID provide is the false-green disaster and fails
 * the build. All five are declared in `database-env-var`, so any of these skipping is fatal there,
 * which is exactly right — a merged suite that quietly did not run is the thing this whole file
 * exists to prevent one level down.
 */
const skip = enabled ? false : `set ${missing.join(', ')}`

const { createDevplatformModule } = await import('./devplatform/module.ts')
const { createPolicyModule } = await import('./policy/module.ts')
const { createPricingModule } = await import('./pricing/module.ts')
const { createStudioModule } = await import('./studio/module.ts')

/**
 * agora's own `Db` view of a postgres handle.
 *
 * `testsupport.ts` exports `db` typed as the runtime package's minimal `Sql`, which is the right
 * shape for the helpers that take one. The five domain dep objects below want the DRIVER's handle,
 * because their queries are tagged templates the minimal interface does not publish — the same
 * distinction `kernel.ts` takes `TSql` as a parameter for.
 */
const asDb = (sql: postgres.Sql): AgoraDb => sql as unknown as AgoraDb

const ALICE = '11111111-1111-4111-8111-111111111111'

/** One verifier for the process, as `index.ts` builds one. ALICE is an admin here. */
const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    if (token === 'alice') return { kind: 'user', userId: ALICE, handle: 'alice', roles: ['admin'] }
    throw new TokenError('unknown token', 'invalid')
  },
}

/** An envelope, signed the way every producer in the estate signs one — one scheme, three keys. */
function signed(secret: string, topic: string, payload: Record<string, unknown>): { body: string; headers: Record<string, string> } {
  const id = randomUUID()
  const body = JSON.stringify({
    id,
    topic,
    key: String(payload['userId'] ?? id),
    occurredAt: new Date().toISOString(),
    producer: 'identity',
    version: 1,
    actor: null,
    correlationId: null,
    payload,
  })
  return { body, headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signEvent(body, secret) } }
}

describe('the merged surface', { skip }, () => {
  let agoraSql: postgres.Sql
  let devplatformSql: postgres.Sql
  let policySql: postgres.Sql
  let pricingSql: postgres.Sql
  let studioSql: postgres.Sql
  let devplatform: Awaited<ReturnType<typeof createDevplatformModule>>
  let policy: Awaited<ReturnType<typeof createPolicyModule>>
  let pricing: Awaited<ReturnType<typeof createPricingModule>>
  let studio: Awaited<ReturnType<typeof createStudioModule>>
  let server: Server
  let url: string
  let registry: Metrics
  const stopped = new Set<string>()

  before(async () => {
    agoraSql = openAgora()
    await migrateAgora(agoraSql)
    await resetAgora(agoraSql)

    devplatformSql = openDevplatform()
    await migrateDevplatform(devplatformSql)
    await resetDevplatform(devplatformSql)

    policySql = openPolicy()
    await migratePolicy(policySql)
    await resetPolicy(policySql)

    pricingSql = openPricing()
    await migratePricing(pricingSql)
    await resetPricing(pricingSql)

    studioSql = openStudio()
    await migrateStudio(studioSql)
    await resetStudio(studioSql)

    // Exactly the arrangement `index.ts` builds: ONE registry rendered by /metrics, a labelled view
    // per module for the JOB plane only, one Lifecycle carrying every module's probes, and all five
    // route tables on one listener.
    registry = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
    const jobMetrics = registry.withLabels({ module: 'agora' })

    // `cacheMs: 0` because the cases at the end assert what /readyz says a moment AFTER a module's
    // database goes away, and the default one-second cache would answer with the report from
    // before it did.
    const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 100, cacheMs: 0 })
    const host = {
      metrics: registry,
      verifier,
      claimingJobs: () => false,
      track: () => lifecycle.track(),
    }

    devplatform = await createDevplatformModule(host)
    policy = await createPolicyModule(host)
    pricing = await createPricingModule(host)
    studio = await createStudioModule(host)

    lifecycle.addProbe(postgresProbe('postgres-agora', () => agoraSql`select 1`))
    for (const probe of [...devplatform.probes, ...policy.probes, ...pricing.probes, ...studio.probes]) {
      lifecycle.addProbe(probe)
    }

    server = createMergedServer(
      {
        lifecycle,
        logger: quietLogger(),
        // The REGISTRY, not a view: /metrics renders this object, and the kernel's HTTP metrics are
        // process-wide — one listener serves five modules and `route` already says which.
        metrics: registry,
        verifier,
        sql: networkSql({ mainnet: asDb(agoraSql) as unknown as RuntimeSql }),
        singleNetwork: 'mainnet' as const,
        producer: 'agora',
        posts: {
          sql: asDb(agoraSql),
          producer: 'agora',
          policy: fakePolicy(),
          postsPerHour: 60,
          postMaxChars: 500,
          pageSizeMax: 50,
          postingEnabled: true,
        },
        circles: { sql: asDb(agoraSql), producer: 'agora' },
        whispers: { sql: asDb(agoraSql), producer: 'agora', whispersPerHour: 30, postMaxChars: 500 },
        notifications: {
          sql: asDb(agoraSql),
          producer: 'agora',
          notificationTtlDays: 90,
          publicUrl: '',
        },
        moderation: { sql: asDb(agoraSql), producer: 'agora', reportsPerHour: 30 },
        followsPerHour: 100,
        studioPublicUrl: '',
        queue: { enqueue: async () => undefined },
        eventSigningSecret: AGORA_EVENT_SECRET,
        pageSizeMax: 50,
        beforeScrape: async () => {
          jobMetrics.set('jobs_pending', 0, { network: 'mainnet' })
          jobMetrics.set('jobs_overdue', 0, { network: 'mainnet' })
          await devplatform.beforeScrape()
          await policy.beforeScrape()
          await pricing.beforeScrape()
          await studio.beforeScrape()
        },
      },
      [...devplatform.routes, ...policy.routes, ...pricing.routes, ...studio.routes],
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    lifecycle.markReady()
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const [name, module] of [
      ['devplatform', devplatform],
      ['policy', policy],
      ['pricing', pricing],
      ['studio', studio],
    ] as const) {
      if (module && !stopped.has(name)) await module.stop().catch(() => {})
    }
    for (const handle of [agoraSql, devplatformSql, policySql, pricingSql, studioSql]) {
      if (handle) await handle.end({ timeout: 5 }).catch(() => {})
    }
    await rm(assetRoot, { recursive: true, force: true })
  })

  const auth = { authorization: 'Bearer alice', 'content-type': 'application/json' }

  /* ---------------------------------------------------------------- route table */

  describe('the five route tables are mounted, and none shadows another', () => {
    it("answers agora's reads", async () => {
      const res = await fetch(`${url}/v1/timeline/latest`)
      assert.equal(res.status, 200)
      const body = (await res.json()) as { posts: unknown[] }
      assert.ok(Array.isArray(body.posts), "agora's timeline must be served from agora's own tables")
    })

    it("answers devplatform's app catalogue on the SAME listener and the SAME port", async () => {
      const res = await fetch(`${url}/v1/apps`)
      assert.equal(res.status, 200)
      const body = (await res.json()) as { applications: unknown[] }
      assert.ok(Array.isArray(body.applications))
    })

    it("answers policy's unversioned rule list, which no other module has a path near", async () => {
      const res = await fetch(`${url}/rules`, { headers: auth })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { rules: unknown[] }
      assert.ok(Array.isArray(body.rules))
    })

    it("answers pricing's public rate board", async () => {
      const res = await fetch(`${url}/rates`)
      assert.equal(res.status, 200)
      const body = (await res.json()) as Record<string, unknown>
      assert.equal(typeof body, 'object', "pricing's rate board must answer from pricing's quotes")
    })

    it("answers studio's brand kits", async () => {
      const res = await fetch(`${url}/v1/brand-kits`, { headers: auth })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { brandKits: unknown[] }
      assert.ok(Array.isArray(body.brandKits))
    })

    it('and an unknown path is still one 404 for the whole process', async () => {
      const res = await fetch(`${url}/v1/no-such-route`)
      assert.equal(res.status, 404)
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'not_found')
    })
  })

  /* ---------------------------------------------------------------- the right database */

  describe("every mounted route reads ITS OWN module's database, not the host's", () => {
    it('every mounted spec carries a selector — remove one and the cases here go red', () => {
      /*
       * Stated once, over ALL FOUR mounted tables, because it is the property those cases depend on
       * rather than a property of any one module. A spec with no `sql` resolves to the kernel's own
       * selector, which is agora's.
       */
      const mounted = [...devplatform.routes, ...policy.routes, ...pricing.routes, ...studio.routes]
      for (const spec of mounted) {
        assert.notEqual(spec.sql, undefined, `${spec.method} ${spec.path} would read agora's database`)
      }
      assert.ok(mounted.length > 60, `only ${mounted.length} routes mounted; four modules must contribute`)
    })

    it('serves a table that exists only in the devplatform schema', async () => {
      // `applications` is devplatform's. agora's database has no such table, so a route handed the
      // host's selector would 500 here rather than answer — which is the whole reason
      // `RouteSpec.sql` exists.
      await devplatformSql`
        insert into developer_orgs (id, identity_org_id, name, slug)
        values ('00000000-0000-4000-8000-0000000d5100'::uuid, 'merged-org', 'Merged', 'merged-org')
        on conflict do nothing
      `
      const res = await fetch(`${url}/v1/apps`)
      assert.equal(res.status, 200, "against agora's database this statement is a 500")
    })

    it('serves a table only POLICY has, and writes land in policy’s database', async () => {
      const key = `merged-${randomUUID().slice(0, 8)}`
      const put = await fetch(`${url}/rules`, {
        method: 'POST',
        headers: auth,
        // A REAL action name and a REAL rule definition. `policy/actions.ts` holds the action
        // registry and `policy/rules.ts` parses the definition; both refuse anything else, which
        // is what makes a decision a decision rather than a free-text field.
        body: JSON.stringify({
          key,
          action: 'wallet.withdrawal',
          enabled: true,
          definition: {
            kind: 'amount_limit',
            asset: 'EMBER',
            thresholds: [{ atOrAbove: '1000', verdict: 'challenge' }],
          },
        }),
      })
      assert.ok(put.status === 200 || put.status === 201, `unexpected ${put.status}: ${await put.text()}`)

      const rows = await policySql<{ n: number }[]>`select count(*)::int as n from policy_rules where rule_key = ${key}`
      assert.equal(rows[0]?.n, 1, "the rule must be in POLICY's database")
      // And nowhere else. `policy_rules` exists in no other schema, so this is the loud half of the
      // proof; the silent half is the `inbox` case further down.
      const agoraHas = await agoraSql<{ n: number }[]>`
        select count(*)::int as n from information_schema.tables where table_name = 'policy_rules'
      `
      assert.equal(agoraHas[0]?.n, 0, "agora's database must not have policy's table at all")
    })

    it('serves a table only PRICING has, and reads it out of pricing’s database', async () => {
      await pricingSql`
        insert into administered_prices (asset, usd_scaled, set_by)
        values ('EMBER', 250000, 'merged-test')
        on conflict (asset) do update set usd_scaled = excluded.usd_scaled, set_by = excluded.set_by
      `
      const res = await fetch(`${url}/rates/EMBER`)
      assert.equal(res.status, 200, "against agora's database this statement is a 500")
      const body = (await res.json()) as { rate: { asset: string; usd: string | null } }
      assert.equal(body.rate.asset, 'EMBER')
      assert.notEqual(body.rate.usd, null, "the administered price planted in PRICING's database must be the one read")
    })

    it('serves a table only STUDIO has, and writes land in studio’s database', async () => {
      const res = await fetch(`${url}/v1/brand-kits`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'Merged kit', accent: '#ff4d00', palette: ['#101010', '#f0f0f0'] }),
      })
      assert.ok(res.status === 200 || res.status === 201, `unexpected ${res.status}: ${await res.text()}`)
      const rows = await studioSql<{ n: number }[]>`select count(*)::int as n from brand_kits`
      assert.equal(rows[0]?.n, 1, "the brand kit must be in STUDIO's database")
    })
  })

  /* ---------------------------------------------------------------- one of each infra route */

  describe('one process serves exactly one of each operational route', () => {
    it('/livez answers 200', async () => {
      assert.equal((await fetch(`${url}/livez`)).status, 200)
    })

    it('/metrics answers 200 and is agora’s, which is what Prometheus scrapes', async () => {
      assert.equal((await fetch(`${url}/metrics`)).status, 200)
    })

    it('and every mounted module dropped all three of the paths it must not serve', () => {
      // Stated as a test rather than in a comment, because it is the property `mountableRoutes`
      // exists for and the one a careless edit would undo.
      for (const [name, routes, floor] of [
        ['devplatform', devplatform.routes, 30],
        ['policy', policy.routes, 10],
        ['pricing', pricing.routes, 4],
        ['studio', studio.routes, 10],
      ] as const) {
        const mounted = routes.map((r) => `${r.method} ${r.path}`)
        for (const dead of ['GET /livez', 'GET /readyz', 'GET /metrics']) {
          assert.ok(!mounted.includes(dead), `${name} mounted ${dead} — the second copy is dead`)
        }
        assert.ok(mounted.length > floor, `only ${mounted.length} ${name} routes mounted`)
      }
    })
  })

  /* ---------------------------------------------------------------- the three webhooks */

  describe('POST /v1/events splits three ways, because three keys cannot share one route', () => {
    it('erases in AGORA’s database through agora’s path, with agora’s key', async () => {
      await agoraSql`insert into voices (subject, handle, display_name) values (${`user:${ALICE}`}, 'gone', 'Gone')`
      const before = await agoraSql<{ n: number }[]>`select count(*)::int as n from voices where subject = ${`user:${ALICE}`}`
      assert.equal(before[0]?.n, 1, 'agora must hold something to lose')

      const { body, headers } = signed(AGORA_EVENT_SECRET, 'identity.user.deleted', { userId: ALICE })
      const res = await fetch(`${url}${MOUNTED_EVENTS_PATH}`, { method: 'POST', headers, body })
      // 200, not 202: agora's erasure is SYNCHRONOUS — `withInbox` and `eraseSubject` share one
      // transaction, so by the time this answers the rows are gone. Preserved exactly as the
      // standalone route answered it, because a producer's relay reads the status.
      const reply = (await res.json()) as { status: string; erased: boolean }
      assert.equal(res.status, 200, JSON.stringify(reply))
      assert.equal(reply.status, 'processed')
      assert.equal(reply.erased, true)

      const after = await agoraSql<{ n: number }[]>`select count(*)::int as n from voices where subject = ${`user:${ALICE}`}`
      assert.equal(after[0]?.n, 0, "agora's voice survived a deletion that answered 202")
    })

    it('and writes agora’s inbox row in AGORA’s database and NOWHERE else', async () => {
      /*
       * ════════════════════════════════════════════════════════════════════════════════════════
       * THE SHARPEST CASE IN THE FILE.
       *
       * `inbox` is one of the two names ALL FIVE schemas own, and it has the SAME columns in every
       * one of them. A module handed another module's handle would write a row that is entirely
       * valid, in the wrong database — and the redelivery that should have carried the erasure
       * would then be deduped away for ever. Nothing errors, nothing logs, nothing alerts.
       *
       * So the ROWS are counted, in all five, rather than the 202 being trusted.
       * ════════════════════════════════════════════════════════════════════════════════════════
       */
      const counts = await Promise.all(
        ([
          ['agora', agoraSql],
          ['devplatform', devplatformSql],
          ['policy', policySql],
          ['pricing', pricingSql],
          ['studio', studioSql],
        ] as const).map(async ([name, handle]) => {
          const rows = await handle<{ n: number }[]>`select count(*)::int as n from inbox`
          return [name, rows[0]?.n ?? -1] as const
        }),
      )
      assert.deepEqual(Object.fromEntries(counts), {
        agora: 1,
        devplatform: 0,
        policy: 0,
        pricing: 0,
        studio: 0,
      })
    })

    it('erases in POLICY’s database through policy’s path, with POLICY’s key', async () => {
      await policySql`
        insert into trusted_addresses (subject, address, effective_at, added_by)
        values (${`user:${ALICE}`}, '0xd5110000000000000000000000000000000d5111', now(), 'merged-test')
      `
      const { body, headers } = signed(POLICY_EVENT_SECRET, 'identity.user.deleted', { userId: ALICE })
      const res = await fetch(`${url}/v1/events/policy`, { method: 'POST', headers, body })
      assert.equal(res.status, 202, await res.text())

      const rows = await policySql<{ n: number }[]>`
        select count(*)::int as n from trusted_addresses where subject = ${`user:${ALICE}`}
      `
      assert.equal(rows[0]?.n, 0, "policy's trusted address survived a deletion that answered 202")
      const inbox = await policySql<{ n: number }[]>`select count(*)::int as n from inbox`
      assert.equal(inbox[0]?.n, 1, "policy must have deduped this event in its OWN database")
    })

    it('accepts a delivery on DEVPLATFORM’s path, with DEVPLATFORM’s key', async () => {
      const { body, headers } = signed(DEVPLATFORM_INGEST_SECRET, 'identity.user.deleted', { userId: ALICE })
      const res = await fetch(`${url}/v1/events/devplatform`, { method: 'POST', headers, body })
      assert.equal(res.status, 202, await res.text())
      const inbox = await devplatformSql<{ n: number }[]>`select count(*)::int as n from inbox`
      assert.equal(inbox[0]?.n, 1, "devplatform must have deduped this event in its OWN database")
    })

    it('REFUSES a delivery signed with another module’s key — the reason the split exists', async () => {
      /*
       * ════════════════════════════════════════════════════════════════════════════════════════
       * If one route verified for all three, this case could not exist.
       *
       * These three secrets are three different generated values, exactly as the estate has them:
       * `OUTBOX_SIGNING_SECRET`, `OUTBOX_ACCEPT_SECRETS` and `DEVPLATFORM_INGEST_SECRETS`. A single
       * shared webhook would verify against ONE of them, so either two modules' correctly-signed
       * deliveries would be refused for ever, or — worse — a delivery signed with the estate-wide
       * key would be accepted as devplatform's, into devplatform's database, when devplatform's own
       * listener would have refused it.
       *
       * Both refusal statuses are asserted as they are, and they DIFFER: devplatform answers 401,
       * policy answers 403. Neither was changed by this merge, and neither should be — they are
       * two services' published behaviour, and a "tidy-up" that unified them would be a silent
       * contract change for every producer that reads the status.
       * ════════════════════════════════════════════════════════════════════════════════════════
       */
      const wrongForDevplatform = signed(AGORA_EVENT_SECRET, 'identity.user.deleted', { userId: ALICE })
      const dev = await fetch(`${url}/v1/events/devplatform`, {
        method: 'POST',
        headers: wrongForDevplatform.headers,
        body: wrongForDevplatform.body,
      })
      assert.equal(dev.status, 401, 'devplatform must refuse a delivery it did not have the key for')

      const wrongForPolicy = signed(DEVPLATFORM_INGEST_SECRET, 'identity.user.deleted', { userId: ALICE })
      const pol = await fetch(`${url}/v1/events/policy`, {
        method: 'POST',
        headers: wrongForPolicy.headers,
        body: wrongForPolicy.body,
      })
      assert.equal(pol.status, 403, 'policy must refuse a delivery it did not have the key for')

      const wrongForAgora = signed(POLICY_EVENT_SECRET, 'identity.user.deleted', { userId: ALICE })
      const ago = await fetch(`${url}${MOUNTED_EVENTS_PATH}`, {
        method: 'POST',
        headers: wrongForAgora.headers,
        body: wrongForAgora.body,
      })
      assert.equal(ago.status, 401, 'agora must refuse a delivery it did not have the key for')
    })

    it('and the BARE path answers 410 naming the split, not 404 and not a silent success', async () => {
      /*
       * ════════════════════════════════════════════════════════════════════════════════════════
       * THE ROW NOBODY RE-POINTED, MADE LOUD.
       *
       * `deploy/erasure/register.psv` holds `http://devplatform:4000/v1/events` and
       * `http://policy:4000/v1/events`. After cutover both names resolve, by ExternalName, to this
       * pod — and both land here. A 404 would be indistinguishable from a typo, and a fall-through
       * to agora's handler would be an erasure that reached one database out of three and answered
       * 202 to a deletion that mostly did not happen.
       *
       * 410 is "this existed and was deliberately withdrawn", the body carries all three
       * replacements, and it lands in the producer's `outbox_deliveries.last_error` where the
       * subscription sweep can read it.
       * ════════════════════════════════════════════════════════════════════════════════════════
       */
      const { body, headers } = signed(AGORA_EVENT_SECRET, 'identity.user.deleted', { userId: ALICE })
      const res = await fetch(`${url}${EVENTS_PATH}`, { method: 'POST', headers, body })
      assert.equal(res.status, 410)
      const reply = (await res.json()) as { error: { code: string; paths: Record<string, string> } }
      assert.equal(reply.error.code, 'events_path_split')
      // All TWELVE module webhooks, because the 410 body is the process's `SPLIT_EVENT_PATHS` —
      // even though THIS suite mounts only the M5a five, the bare-path handler names every split
      // the process serves. Wave M5b added six (community, market, billing, mint, worlds,
      // tessera) and M5d three more (trade, admin-api, emberkin).
      //
      // `hub` and `wallet` are ABSENT and each for its own reason, which is why the map is
      // asserted whole rather than by membership. hub consumes no bus at all — a
      // backend-for-frontend owns no inbox to deliver into. wallet's webhook is `POST /events`,
      // UNVERSIONED: a disjoint third family that nothing else in this process declares, so it
      // needs no suffix and naming it here would send a producer at a path this 410 does not
      // describe.
      assert.deepEqual(reply.error.paths, {
        agora: '/v1/events/agora',
        devplatform: '/v1/events/devplatform',
        policy: '/v1/events/policy',
        community: '/v1/events/community',
        market: '/v1/events/market',
        billing: '/v1/events/billing',
        mint: '/v1/events/mint',
        worlds: '/v1/events/worlds',
        tessera: '/v1/events/tessera',
        trade: '/v1/events/trade',
        'admin-api': '/v1/events/admin-api',
        emberkin: '/v1/events/emberkin',
      })
    })

    it('and a topic no module subscribes to is still 202-ignored rather than 4xx’d', async () => {
      // A 4xx here would make the producer's relay retry an event it is correct to send and every
      // module is correct not to act on, for ever.
      const { body, headers } = signed(AGORA_EVENT_SECRET, 'pool.share.accepted', {})
      const res = await fetch(`${url}${MOUNTED_EVENTS_PATH}`, { method: 'POST', headers, body })
      assert.equal(res.status, 202)
      assert.equal(((await res.json()) as { status: string }).status, 'ignored')

      // And the same on the other two paths, because the ignore decision is per module and each
      // one has a different subscribed set. policy consumes only `identity.user.deleted`;
      // devplatform consumes that and `identity.organisation.deleted`.
      for (const [path, secret] of [
        ['/v1/events/policy', POLICY_EVENT_SECRET],
        ['/v1/events/devplatform', DEVPLATFORM_INGEST_SECRET],
      ] as const) {
        const other = signed(secret, 'pool.share.accepted', {})
        const ignored = await fetch(`${url}${path}`, { method: 'POST', headers: other.headers, body: other.body })
        assert.equal(ignored.status, 202, `${path} must acknowledge and ignore, never 4xx`)
      }
    })
  })

  /* ---------------------------------------------------------------- one /metrics, five modules */

  describe('/metrics carries every module, and their job series do not erase each other', () => {
    it("renders all five modules' domain metrics from one registry", async () => {
      const text = await scrape()
      assert.match(text, /agora_posts_total/, "agora's series must be on the merged page")
      assert.match(text, /devplatform_up/, "devplatform's series must be on the merged page")
      assert.match(text, /policy_freezes_active/, "policy's series must be on the merged page")
      assert.match(text, /pricing_rate_age_seconds/, "pricing's series must be on the merged page")
      assert.match(text, /studio_/, "studio's series must be on the merged page")
    })

    it('keeps jobs_pending and jobs_overdue as FIVE series, one per module', async () => {
      /*
       * ════════════════════════════════════════════════════════════════════════════════════════
       * THE COLLISION THIS WHOLE LABEL EXISTS FOR.
       *
       * `jobs_pending` and `jobs_overdue` carry no `kind`. Five modules calling
       * `metrics.set('jobs_pending', …)` against one registry write the IDENTICAL series, so
       * whichever samples last erases the other four — and a wedged queue is then not "high" on
       * the graph, it is ABSENT from it. Nobody alerts on absent, and `JobQueueOverdue` in
       * `deploy/prometheus/rules/alerts.yaml` is `expr: jobs_overdue > 0`.
       *
       * `network` does NOT solve this: every module labels its gauges with it, so five modules'
       * mainnet samples are one series without `module`. All five must be present after ONE
       * scrape, which is the only arrangement in which the erasure could have happened.
       * ════════════════════════════════════════════════════════════════════════════════════════
       */
      const lines = (await scrape()).split('\n')
      for (const metric of ['jobs_pending', 'jobs_overdue']) {
        const series = lines.filter((line) => line.startsWith(`${metric}{`))
        for (const module of ['agora', 'devplatform', 'policy', 'pricing', 'studio']) {
          assert.ok(
            series.some((line) => line.includes(`module="${module}"`)),
            `${metric} has no ${module} series — another module's sample erased it:\n${series.join('\n')}`,
          )
        }
        assert.equal(series.length, 5, `${metric} must be exactly five series, one per module`)
      }
    })

    it('labels the counters that DO carry a kind, so four relays are four series', async () => {
      // agora, devplatform, pricing and studio all register a job `kind="outbox.relay"`. Summing
      // them would produce a number an alert still fires on and nobody can act on.
      for (const module of ['agora', 'devplatform', 'pricing', 'studio']) {
        registry.withLabels({ module }).increment('jobs_failed_total', { kind: 'outbox.relay' })
      }
      const relays = (await scrape())
        .split('\n')
        .filter((line) => line.startsWith('jobs_failed_total{') && line.includes('outbox.relay'))
      assert.equal(relays.length, 4, `four modules' relays must be four series:\n${relays.join('\n')}`)
      for (const line of relays) assert.match(line, / 1$/, 'each module counts its own failure, not the sum')
    })

    it('and the process-wide HTTP metrics are NOT stamped with a module', async () => {
      // One listener serves all five and the `route` label already says which. A module label here
      // would be a lie for four fifths of the series on the page.
      const http = (await scrape()).split('\n').filter((line) => line.startsWith('http_requests_total{'))
      assert.ok(http.length > 0, 'the kernel must have recorded the requests this suite made')
      for (const line of http) {
        assert.ok(!line.includes('module='), `http_requests_total must not claim a module: ${line}`)
      }
    })

    async function scrape(): Promise<string> {
      const res = await fetch(`${url}/metrics`)
      assert.equal(res.status, 200)
      return await res.text()
    }
  })

  /* ---------------------------------------------------------------- readiness covers all five */

  describe('/readyz reflects ALL FIVE databases', () => {
    it('names a hard probe for every module, and every one passes', async () => {
      const res = await fetch(`${url}/readyz`)
      const body = (await res.json()) as { ready: boolean; checks: Array<{ name: string; state: string }> }
      assert.equal(res.status, 200, JSON.stringify(body))
      assert.equal(body.ready, true)
      assert.deepEqual(
        body.checks.map((c) => c.name).sort(),
        [
          'asset-root',
          'image-backend',
          'postgres-agora',
          'postgres-devplatform',
          'postgres-policy',
          'postgres-pricing',
          'postgres-studio',
        ],
        'a merged /readyz that probes one database answers 200 while another module is entirely ' +
          'dead, and the balancer keeps sending traffic to it',
      )
      for (const check of body.checks) {
        // `image-backend` is soft and reports `degraded` with no model configured, which is the
        // honest answer and is NOT a failure — the placeholder backend still generates.
        if (check.name === 'image-backend') continue
        assert.equal(check.state, 'pass', `${check.name} must be passing`)
      }
    })

    // The destructive cases, in order, and LAST. Each takes one module away on purpose and reads
    // the endpoint the load balancer reads.
    it('goes UNREADY when PRICING’s database is the one that has gone, and says which', async () => {
      await pricing.stop()
      stopped.add('pricing')

      const res = await fetch(`${url}/readyz`)
      const body = (await res.json()) as { ready: boolean; checks: Array<{ name: string; state: string }> }
      assert.equal(res.status, 503)
      assert.equal(body.ready, false)
      const theirs = body.checks.find((c) => c.name === 'postgres-pricing')
      assert.notEqual(theirs, undefined, 'the pricing probe must still be reported')
      assert.notEqual(theirs?.state, 'pass', "pricing's database is gone and /readyz must say so")

      // And the OTHER FOUR are still fine, so this is not "everything broke" — it is one module
      // reported honestly, which is exactly what a merged readiness has to be able to do.
      for (const name of ['postgres-agora', 'postgres-devplatform', 'postgres-policy', 'postgres-studio']) {
        assert.equal(body.checks.find((c) => c.name === name)?.state, 'pass', `${name} must still pass`)
      }
    })

    it('and stays UNREADY, now naming TWO modules, when devplatform goes too', async () => {
      await devplatform.stop()
      stopped.add('devplatform')

      const res = await fetch(`${url}/readyz`)
      const body = (await res.json()) as { ready: boolean; checks: Array<{ name: string; state: string }> }
      assert.equal(res.status, 503)
      assert.equal(body.ready, false)
      const failing = body.checks
        .filter((c) => c.state !== 'pass' && c.name.startsWith('postgres-'))
        .map((c) => c.name)
        .sort()
      assert.deepEqual(
        failing,
        ['postgres-devplatform', 'postgres-pricing'],
        'a readiness report that collapsed to one line would tell an operator to look in one place',
      )
      assert.equal(body.checks.find((c) => c.name === 'postgres-agora')?.state, 'pass')
      assert.equal(body.checks.find((c) => c.name === 'postgres-studio')?.state, 'pass')
    })
  })
})
