/**
 * The composition root — for ALL TWENTY-THREE modules this process now serves.
 *
 * Everything this service is made of is built here, once, in an order that is not arbitrary. Each
 * step carries the reason it must come before the next; the ordering is the substance of the file.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WAVES M5a + M5b + M5c + M5d: THIS PROCESS IS TWENTY-THREE MODULES.** micro-deploy
 * `docs/service-merge-plan.md`. agora absorbed devplatform, policy, pricing and studio (M5a), then
 * community, market, billing, mint, foresight, worlds and tessera (M5b, the commerce/games tier),
 * then activity and lantern (M5c) — which brought notify and analytics NESTED INSIDE THEM, because
 * both were already merged processes of their own — and then hub, trade, wallet, admin and emberkin
 * (M5d), the first of which owns no database at all and the last of which brings TWO MORE nested
 * inside it. That is the seed of what becomes `platform`: one image, one listener,
 * one `/livez`, one `/readyz`, one `/metrics`, and TWENTY-TWO databases that are never merged and
 * must never be reachable from each other's handlers.
 *
 * **TWENTY-TWO DATABASES, TWENTY-THREE MODULES**, and the module without one is hub: a
 * backend-for-frontend that composes seven peers and holds no table. Its routes carry no
 * `RouteSpec.sql` and its own `RequestContext` declares no `sql` field, so "hub queried agora's
 * tables" is not a mistake it can make. See `./hub/module.ts`.
 *
 * **NINETEEN FACTORY CALLS, TWENTY-THREE MODULES.** This file calls `createActivityModule`,
 * `createLanternModule` and `createEmberkinModule`; the first two call one nested factory each and
 * the third calls two. Put another way: this file calls `createActivityModule` and
 * `createLanternModule`; those two call `createNotifyModule` and `createAnalyticsModule`. The
 * nesting is preserved deliberately — see the M5c import block below for what it buys.
 *
 * Six of the M5b seven hold `ledger.postEntry` authority. The owner overruled the
 * ledger-isolation rule for the platform tier (§M5); the mitigations below are mandatory, not
 * advisory — per-route `RouteSpec.sql`, one JobRunner per module, `{ module }` job labels, a
 * per-module event path + inbox, and each module keeping its OWN ledger client.
 *
 * agora absorbs rather than the other way round because it is the largest surface and the only one
 * of the five that is under active build-out — the four absorbed modules are mounted, not
 * rewritten, and their own suites still pass unchanged in their own repositories, which is what
 * says the merge did not alter any of their surfaces.
 *
 * What this file may and may not see is the whole of the boundary:
 *
 *   * It builds agora's pool, queue and runner, exactly as before.
 *   * It calls `createDevplatformModule`, `createPolicyModule`, `createPricingModule` and
 *     `createStudioModule` and receives, from each, routes, readiness probes and a lifetime.
 *     **None of them names a database handle.** There is no parameter through which this file
 *     could hand a module the wrong pool, and no field through which it could take a module's.
 *   * `./devplatform/env.ts`, `./policy/env.ts`, `./pricing/env.ts` and `./studio/env.ts` are NOT
 *     imported here, so `DEVPLATFORM_DATABASE_URL`, `DEVPLATFORM_INGEST_SECRETS`,
 *     `POLICY_DATABASE_URL`, `PRICING_DATABASE_URL`, `STUDIO_DATABASE_URL`, `STUDIO_ASSET_ROOT`
 *     and `AZURE_FOUNDRY_API_KEY` never enter this file's scope at all.
 *   * The three modules that consume the event bus each serve their OWN webhook path, because
 *     they do not verify with the same key. See `MOUNTED_EVENTS_PATH` in `./server.ts`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * What this file deliberately does **not** do is run migrations. That is `src/migrator.ts`, a
 * separate one-shot process — AD-17 and rule 7. On this service that matters more than usual:
 * below `SCHEMA_VERSION` the `post_media_alt_required` CHECK may not exist, so an attachment could
 * be written with no description and the accessibility rule doc 41 §5 states would quietly become a
 * suggestion; and `bars_symmetric_idx` may not exist, so a bar could be recorded in one direction
 * only, which is a bar that half works and reads to the person who set it as though it worked.
 *
 * Traces come from the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, networkSql, type Sql as DbSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createMergedServer, registerServiceMetrics } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { buildUpstreams } from './upstreams.ts'
import type { Db } from './outbox.ts'
import type { PostDeps } from './posts.ts'
import type { NotificationDeps } from './notifications.ts'
import { MODULE_LABEL as DEVPLATFORM_MODULE, createDevplatformModule } from './devplatform/module.ts'
import { MODULE_LABEL as POLICY_MODULE, createPolicyModule } from './policy/module.ts'
import { MODULE_LABEL as PRICING_MODULE, createPricingModule } from './pricing/module.ts'
import { MODULE_LABEL as STUDIO_MODULE, createStudioModule } from './studio/module.ts'
// ── WAVE M5b: the commerce/games tier ─────────────────────────────────────────────────────────
//
// Six of these seven hold `ledger.postEntry` authority (community, market, billing, mint,
// foresight, worlds) — the owner overruled the ledger-isolation rule for the platform tier
// (micro-deploy `docs/service-merge-plan.md` §M5). The mitigations are what make that safe and they
// are NOT optional: every module reads its OWN env and builds its OWN pool below the factory call,
// stamps `RouteSpec.sql` over its whole table, runs its OWN JobRunner (nine of these register
// `outbox.relay`), labels its job metrics `{ module }`, and — for the six that ingest events —
// serves its OWN suffixed webhook path against its OWN inbox and signing secret. None of the seven
// factories names a database handle, exactly as the M5a four do not.
import { MODULE_LABEL as COMMUNITY_MODULE, createCommunityModule } from './community/module.ts'
import { MODULE_LABEL as MARKET_MODULE, createMarketModule } from './market/module.ts'
import { MODULE_LABEL as BILLING_MODULE, createBillingModule } from './billing/module.ts'
import { MODULE_LABEL as MINT_MODULE, createMintModule } from './mint/module.ts'
import { MODULE_LABEL as FORESIGHT_MODULE, createForesightModule } from './foresight/module.ts'
import { MODULE_LABEL as WORLDS_MODULE, createWorldsModule } from './worlds/module.ts'
import { MODULE_LABEL as TESSERA_MODULE, createTesseraModule } from './tessera/module.ts'
// ── WAVE M5c: THE TELEMETRY AND BUS-TAIL TIER, AND THE ONE THING THAT IS NEW ABOUT IT ─────────
//
// Two imports, FOUR modules. activity and lantern were already merged processes of their own —
// wave M2 put notify inside activity, wave M1b put analytics inside lantern — and that nesting is
// PRESERVED rather than flattened. This file calls two factories; each of them calls one more.
//
// The nesting is not sentiment about file layout. notify's `NOTIFY_INGEST_SIGNING_SECRET`,
// `SMTP_PASS` and `NOTIFY_GATEWAY_TOKEN`, and analytics' `ANALYTICS_PSEUDONYM_KEY`, are reachable
// from exactly one directory each today, and `activity/moduleboundary.test.ts` and
// `lantern/privacyboundary.test.ts` are able to CHECK that because there is a seam to check.
// Flattening would have deleted the seam and left the guarantee as a convention. The pepper is the
// sharp case: it cannot be rotated without orphaning every subject key derived under it, so a leak
// has no remediation — only prevention.
//
// Neither factory names a database handle, and neither `activity/env.ts` nor `lantern/env.ts` — let
// alone the nested modules' — is imported here, so ACTIVITY_INGEST_SECRETS, NOTIFY_*, LANTERN_TOKEN,
// ANALYTICS_PSEUDONYM_KEY and ANALYTICS_DELIVERY_SECRETS never enter this file's scope at all.
import { MODULE_LABEL as ACTIVITY_MODULE, createActivityModule } from './activity/module.ts'
import { MODULE_LABEL as LANTERN_MODULE, createLanternModule } from './lantern/module.ts'
// ── WAVE M5d: THE ACCOUNT TIER — AND THE FIRST MODULE HERE THAT OWNS NO DATABASE ─────────────
//
// hub is a backend-for-frontend: it composes seven peers on behalf of a signed-in person and
// holds no table of its own. There is no `HUB_DATABASE_URL`, no pool, no migration and no schema
// to assert, so its `schemaVersion` is `null` rather than a number — see `build()` below.
//
// It is mounted under `/v1/hub/*` rather than at the bare paths it served standalone. Seven of
// its eleven routes collide with a module already in this process: `GET /v1/search` is agora's
// own, and six `/v1/conversions…`, `/v1/portfolio`, `/v1/transfers` are wallet's. Matching is
// FIRST-WINS over one flat table, so each of those would be a dead route that looks alive. The
// gateway rewrite that keeps hub-web's relative calls arriving is part of the same release —
// `cf-api-hub` in `deploy/gateway/dynamic/estate-web.yml`; see `hub/server.ts`'s `REMOUNTED_PATHS`
// for why a remount without its rewrite is the M5b tessera regression repeated.
import { MODULE_LABEL as HUB_MODULE, createHubModule } from './hub/module.ts'
// ── WAVE M5d: THE TRADING ENGINE ─────────────────────────────────────────────────────────────
//
// trade holds `ledger.postEntry` authority and it is the module whose JOBS move money on a timer:
// `bot.tick` places live orders, `bot.settle` books performance fees, and `exchange.transfer`
// completes withdrawals that have already DEBITED a customer. The owner overruled the
// ledger-isolation rule for this tier (§M5); the mitigations are not optional, and trade's are the
// ones that matter most — its OWN `TRADE_SERVICE_TOKEN`-built ledger client, its OWN JobRunner per
// network, `{ module }` on every job metric, and its OWN suffixed webhook path against its OWN
// inbox. `./trade/env.ts` is NOT imported here, so `TRADE_DATABASE_URL` and `TRADE_SERVICE_TOKEN`
// never enter this file's scope.
//
// No path of trade's is remounted: its whole surface (`/v1/strategies`, `/v1/capabilities`,
// `/v1/series…`, `/v1/backtests…`, `/v1/bots…`, `/v1/exchange/…`) collides with nothing, which
// `./mergedroutes.test.ts` computes over every ordered pair rather than assuming.
import { MODULE_LABEL as TRADE_MODULE, createTradeModule } from './trade/module.ts'
// ── WAVE M5d: THE WALLET, AND THE ONE MODULE WHOSE PATHS CANNOT MOVE ─────────────────────────
//
// `public-api.yml` routes SEVEN `api.<apex>` prefixes straight at wallet — `/v1/wallets`,
// `/v1/deposits`, `/v1/withdrawals`, `/v1/spend`, `/v1/transfers`, `/v1/conversions`,
// `/v1/portfolio` — and `estate-web.yml` gives it the whole `pay.<suffix>` host. Those are the
// SDK's published paths, so wallet is the PUBLIC owner of every path it collides on and remounts
// nothing. hub is the module that moved, under `/v1/hub`; the asymmetry is not a preference
// between two modules but which of them a caller outside this estate already addresses.
//
// Its webhook is `POST /events`, UNVERSIONED, and it is the whole of the process's third event
// family — no suffix and deliberately absent from `./server.ts`'s `SPLIT_EVENT_PATHS`, because
// nothing else in this process declares that path and a suffix exists only to keep two keys from
// deciding for each other. `./wallet/server.ts`'s `EVENTS_PATH` carries the argument.
//
// `./wallet/env.ts` is NOT imported here, so `WALLET_DATABASE_URL`, `WALLET_IDENTITY_CREDENTIAL`
// and `WALLET_FEE_QUOTES` never enter this file's scope.
import { MODULE_LABEL as WALLET_MODULE, createWalletModule } from './wallet/module.ts'
// ── WAVE M5d: THE OPERATOR CONSOLE'S BACKEND, AND THE ESTATE'S AUDIT CHAIN ───────────────────
//
// admin holds the `audit` table — a hash-chained log whose entire value is that every privileged
// action in the estate lands in it and nowhere else — plus the backup and restore control plane
// and the `estate_identity` boot refusal that makes a cross-environment restore unreachable.
//
// TWO paths of its thirty-one move, and only two families: `POST /v1/events` gains the usual
// suffix, and its five `/v1/worlds…` operator controls remount under `/v1/operator/worlds…`
// because `GET /v1/worlds` is nda's public surface. EVERYTHING ELSE STAYS BARE, and that is
// load-bearing: billing calls this module's `/v1/engagement/policies` service-to-service by
// service name, bypassing the gateway, so a blanket remount would break it in a way no gateway
// rewrite could reach. `./admin/server.ts`'s `REMOUNTED_PATHS` carries the whole argument.
//
// `./admin/env.ts` is NOT imported here, so `ADMIN_DATABASE_URL`, `ADMIN_API_IDENTITY_CREDENTIAL`
// and `ADMIN_ESTATE_ENVIRONMENT` never enter this file's scope.
import { MODULE_LABEL as ADMIN_MODULE, createAdminModule } from './admin/module.ts'
// ── WAVE M5d: THREE TITLES BEHIND ONE FACTORY CALL ───────────────────────────────────────────
//
// ONE import, THREE modules. emberkin was already a merged process of its own — wave M3 put
// aetherholm inside it, wave M4a put nda inside it too — and that nesting is PRESERVED rather than
// flattened, exactly as activity/notify and lantern/analytics are. This file calls one factory;
// that factory calls two more.
//
// It buys two guarantees that would otherwise be conventions: `emberkin/mergedupstreams.test.ts`
// reads the three titles' `env.ts` files and asserts no nested title declares an inbound secret of
// its own, and `emberkin/mergedroutes.test.ts` asserts their three route tables overlap on exactly
// the paths each filters out. The first is what makes emberkin the ONE module of this process
// allowed to verify a webhook once and fan out to three sinks — all three read the same
// estate-wide `OUTBOX_SIGNING_SECRET`, and all three subscribe to `identity.user.deleted`, so
// routing that to one of them would answer 202 to a deletion two thirds of which never happened.
//
// aetherholm's two FROZEN contract paths move: `GET /v1/title` and `POST /v1/provision` are
// tessera's in this process, and aetherholm serves them under `/aetherholm`. That is the collision
// wave M3 refused tessera over, arriving from the other direction — see `REMOUNTED_PATHS` in
// `./emberkin/aetherholm/module.ts`, and note that the deploy half (aetherholm's base URL in the
// `worlds` title registry) is not optional.
import { MODULE_LABEL as EMBERKIN_MODULE, createEmberkinModule } from './emberkin/module.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the
//    pool's failure is a structured, searchable, redacted line rather than a bare V8 stack the
//    collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))

// ── THE LABELLED VIEW, AND WHY THE JOB PLANE NEEDS ONE ───────────────────────────────────────
//
// `/metrics` renders `metrics` — the REGISTRY — so every series any module writes is on one page.
// But two families collide and would be unreadable without a `module` label:
//
//   * FOUR of the five modules register a job kind called `outbox.relay`, EXACTLY — agora,
//     devplatform, pricing and studio. `jobs_failed_total{kind="outbox.relay"}` would be the sum
//     of four unrelated relays: a number that still moves and that nobody can act on.
//   * `jobs_pending` and `jobs_overdue` carry no `kind` at all. Whichever module samples last
//     would be the only one on the graph — so a wedged queue reads as ABSENT rather than high,
//     and `deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue` never fires for it.
//
// `withLabels` returns a VIEW that shares this registry's spec and series maps, so one `/metrics`
// still carries every module. The HTTP metrics stay unlabelled deliberately: one listener serves
// all five modules and the `route` label already says which.
const jobMetrics = metrics.withLabels({ module: SERVICE })
logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  // Said at boot, because a square with posting switched off looks exactly like a square that is
  // broken until somebody reads the environment.
  postingEnabled: env.postingEnabled,
  postMaxChars: env.postMaxChars,
  postsPerHour: env.postsPerHour,
  whispersPerHour: env.whispersPerHour,
  followsPerHour: env.followsPerHour,
})

// 3. The database pool. Opened before the schema assertion for the obvious reason that the
//    assertion is a query, and before the Lifecycle because the readiness probe closes over it.
const poolOptions = {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
}
const sql = postgres(env.databaseUrl, poolOptions)

// ── ONE HANDLE PER NETWORK THIS DEPLOYMENT SERVES ────────────────────────────────────────────
//
// `AGORA_DATABASE_URL_TESTNET` unset is the single-network case, which is every deployment until
// the consolidation reaches this service. `networkSql` then holds one handle and REFUSES a testnet
// request rather than answering it out of mainnet rows — micro-deploy
// `docs/network-consolidation.md` §2.2. The refusal is the point: substituting the other network's
// handle is a query that succeeds and returns plausible rows.
const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined
// ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
//
// The `networkSql` key below used to be the literal `mainnet`. Same image, same code,
// different env — so the TESTNET pod registered its testnet DSN under the name `mainnet` and
// then refused every request the gateway stamped `CF-Network: testnet`, because it genuinely
// held no handle by that name. Five services crash-looped on it within ten minutes of the
// first deploy: the refusal was right, the registration was wrong.
//
// `CF_NETWORK_SINGLE` is how a single-network pod says which estate it is. The render sets it
// for every deployment; `mainnet` remains the default only for a bare `pnpm dev`.
const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

const networks = networkSql({
  [ownNetwork]: sql as unknown as DbSql,
  ...(sqlTestnet && ownNetwork !== 'testnet' ? { testnet: sqlTestnet as unknown as DbSql } : {}),
})

// 4. Assert the schema. This does NOT migrate. Failing here rather than serving is the point: see
//    the file header for the two constraints a lower version would be missing.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The one upstream, and the credential it presents. Built before the Lifecycle so its probe can
//    close over the URL.
//
//    ══════════════════════════════════════════════════════════════════════════════════════════
//    **THE CREDENTIAL IS EXCHANGED, NOT READ ONCE.** There is no `AGORA_SERVICE_TOKEN` and there
//    must never be one — `upstreams.ts` carries the full argument, including the seventeen and a
//    half hours market spent presenting a dead bearer to policy while every listing published
//    unmoderated behind a `degraded` flag that fired on all of them and therefore meant nothing.
//    ══════════════════════════════════════════════════════════════════════════════════════════
const upstreams = buildUpstreams(env, {
  onEvent: (event) => {
    metrics.increment('agora_service_token_events_total', { kind: event.kind })
    if (event.kind === 'minted') {
      // The token itself is never a field here, and must never become one. `service`, `expiresIn`
      // and the refresh interval are what an operator needs; the bearer is what an attacker needs.
      logger.info('minted a service token from the credential', {
        service: event.service,
        expiresIn: event.expiresIn,
        refreshInMs: event.refreshInMs,
      })
    } else if (event.kind === 'exchange_failed') {
      // `warn`, not `fatal`, and only because of `hadUsableToken`: a failed exchange while a live
      // token is still held is the outage this provider is built to ride out, and paging on it
      // would page on every identity blip.
      logger.warn('service credential exchange failed', { ...event })
    }
  },
})

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Said at boot, at the level its consequence deserves. The failure this guards against is not an
// outage — the square keeps serving, keeps accepting posts, and looks entirely healthy while its
// moderation gate is absent. That is precisely the shape of failure nobody notices.
// ────────────────────────────────────────────────────────────────────────────────────────────────
if (!upstreams.policyConfigured) {
  logger.warn('NO MODERATION GATE — POLICY_URL is unset, so every post publishes ungated', {
    whatWillHappen:
      'each post records moderation_degraded and opens an automatic report, so the queue holds ' +
      'everything published while this is true. Nothing is lost; nothing is screened either.',
    remedy: 'set POLICY_URL to the policy service and restart',
  })
} else if (upstreams.mode === 'none') {
  logger.fatal('NO CREDENTIAL AT ALL — every policy call will fail and the gate is effectively absent', {
    remedy:
      'set AGORA_IDENTITY_CREDENTIAL (long-lived, cfsc_…, from POST /service-credentials); ' +
      'estate-bootstrap.sh already mints it into tokens.env',
  })
} else {
  logger.info('service credential mode', { mode: upstreams.mode, identityUrl: env.identityUrl })
}

// 6. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report.
const lifecycle = new Lifecycle({
  drainDelayMs: 5_000,
  // Modest, because nothing here holds a cross-service transaction open. The longest in-flight
  // unit of work is a post: one policy call already completed, then one database transaction.
  drainTimeoutMs: 15_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    // `postgres-agora`, not `postgres`. This `/readyz` now reports FIVE databases and a flat list
    // with one row called `postgres` beside four called `postgres-<module>` is a list an operator
    // has to already know the shape of. Deploy-visible: the check NAME appears in the `/readyz`
    // body, which `estate-verify` reads.
    postgresProbe('postgres-agora', (signal) =>
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  .addProbe(httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }))

// ══════════════════════════════════════════════════════════════════════════════════════════════
// **THERE IS NO HARD PROBE HERE EXCEPT POSTGRES, AND THAT IS A DECISION.**
//
// Market marks the ledger hard because with the ledger down NOTHING market exists to do can
// happen. The equivalent claim is false here: every read on the square — a timeline, a thread, a
// profile, a tag page, a search — is served entirely from this service's own tables and makes no
// outbound call at all. The only path that touches policy is publishing, and it already fails
// safely by opening a report rather than refusing the post.
//
// So marking policy hard would take the entire square out of the balancer for the duration of
// somebody else's incident, turning a degraded moderation gate into a total outage of a service
// that was working. `agora_service_token_usable` and the boot lines above are how an operator
// finds out instead — the question that had no answer anywhere while market's token quietly died.
// ══════════════════════════════════════════════════════════════════════════════════════════════
if (upstreams.policyConfigured) {
  lifecycle.addProbe(httpProbe('policy', `${env.policyUrl}/livez`, { kind: 'soft' }))
}

// ── 6b. THE FOUR MOUNTED MODULES, BUILT BEFORE THE ROUTES AND BEFORE THE RUNNER ───────────────
//
// Each throws rather than exiting, so a fault in one half is reported by THIS file — which has a
// logger and a `fatal` line — instead of killing the process from inside a module and taking four
// working modules with it silently.
//
// The rollback of an already-built module's pools is that module's, not this file's: `stop()` is
// the only thing that holds a name for them, which is why it is called rather than reached into.
// Built in a fixed order so the boot log reads the same way every time.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const host = {
  // The REGISTRY, not a view. Each module's domain names are prefixed with its own service name
  // and collide with nothing; the job metrics take a labelled view of their own inside the module.
  metrics,
  // ONE JWKS client for the process. All five modules verify against the same identity, from the
  // same two estate-wide variables. What each module still decides for itself is what a verified
  // principal may DO — every scope check stays inside the module that owns it.
  verifier,
  // The drain, and only the drain. A module does not decide the lifetime of a process it shares.
  claimingJobs: () => lifecycle.claimingJobs,
  track: () => lifecycle.track(),
}

const started: Array<{ readonly label: string; stop(): Promise<void> }> = []
// `schemaVersion: number | null` rather than `number`: hub owns no database, and `0` would read as
// "schema at version zero" — a database in an unmigrated state, the exact condition
// `assertSchemaAtLeast` exists to refuse. `null` in the `module ready` line says there is no schema
// to be at a version of.
async function build<T extends { stop(): Promise<void>; readonly schemaVersion: number | null }>(
  label: string,
  make: () => Promise<T>,
): Promise<T> {
  try {
    const built = await make()
    started.push({ label, stop: () => built.stop() })
    logger.info('module ready', { module: label, schemaVersion: built.schemaVersion })
    return built
  } catch (err) {
    logger.fatal(`the ${label} module could not start`, { err })
    // Every module built SO FAR, in reverse, then this file's own pool. A half-built process that
    // exited without this would leave four pools and four job planes open against five databases
    // for as long as the container took to die.
    for (const done of started.reverse()) await done.stop().catch(() => {})
    await sql.end({ timeout: 5 }).catch(() => {})
    process.exit(1)
  }
}

const devplatform = await build(DEVPLATFORM_MODULE, () => createDevplatformModule(host))
const policy = await build(POLICY_MODULE, () => createPolicyModule(host))
const pricing = await build(PRICING_MODULE, () => createPricingModule(host))
const studio = await build(STUDIO_MODULE, () => createStudioModule(host))
// The M5b seven, built in a fixed order so the boot log reads the same way every time. Each throws
// on its own fault and `build` unwinds every module started so far in reverse — so a bad
// TESSERA_DATABASE_URL closes eleven pools rather than leaking them while the container dies.
const community = await build(COMMUNITY_MODULE, () => createCommunityModule(host))
const market = await build(MARKET_MODULE, () => createMarketModule(host))
const billing = await build(BILLING_MODULE, () => createBillingModule(host))
const mint = await build(MINT_MODULE, () => createMintModule(host))
const foresight = await build(FORESIGHT_MODULE, () => createForesightModule(host))
const worlds = await build(WORLDS_MODULE, () => createWorldsModule(host))
const tessera = await build(TESSERA_MODULE, () => createTesseraModule(host))
// The M5c two, each of which builds a module of its own inside itself: activity builds notify,
// lantern builds analytics. `build` still sees TWO modules here and that is correct — a nested
// module's fault throws out through its host's factory, which closes its own pools on the way,
// so a bad ANALYTICS_DATABASE_URL unwinds fifteen pools rather than leaking them.
const activity = await build(ACTIVITY_MODULE, () => createActivityModule(host))
const lantern = await build(LANTERN_MODULE, () => createLanternModule(host))
const hub = await build(HUB_MODULE, () => createHubModule(host))
const trade = await build(TRADE_MODULE, () => createTradeModule(host))
const wallet = await build(WALLET_MODULE, () => createWalletModule(host))
const admin = await build(ADMIN_MODULE, () => createAdminModule(host))
const emberkin = await build(EMBERKIN_MODULE, () => createEmberkinModule(host))

// ── AND EVERY PROBE THE MOUNTED MODULES CONTRIBUTE ────────────────────────────────────────────
//
// A LIST per module, registered after the chain above so it stays one: a module that later
// contributes another probe does not have to touch this file, and nothing here has to know what
// any of them checks.
//
// SEVEN in total, and they are what makes ONE `/readyz` honest for five databases. A merged
// readiness that probed only agora's would answer 200 while every developer key, policy decision,
// rate quote and brand kit was failing, and the balancer would keep sending traffic to it.
//
// SAY THE COST OUT LOUD, because two of studio's genuinely widen what can make this pod unready:
// `asset-root` is HARD, so a PVC that goes read-only or full now takes the SQUARE offline too.
// That is `assetRootProbe`'s existing contract preserved rather than quietly downgraded — every
// generation ends at `blobs.put()`, so a replica that cannot write must take no work — and making
// it soft to protect the other four modules would be the failure nobody notices.
// `merged.test.ts` takes a module's database away and asserts the endpoint says WHICH, while the
// others still pass.
for (const probe of [
  ...devplatform.probes,
  ...policy.probes,
  ...pricing.probes,
  ...studio.probes,
  ...community.probes,
  ...market.probes,
  ...billing.probes,
  ...mint.probes,
  ...foresight.probes,
  ...worlds.probes,
  ...tessera.probes,
  // FOUR probes from these two, not two: each carries its nested module's up as well.
  ...activity.probes,
  ...lantern.probes,
  // SEVEN from hub, and not one of them is a database: identity's JWKS and five peers' `/livez`,
  // all soft, plus the one hard `identity-credential` probe. See `hub/module.ts`.
  ...hub.probes,
  // FOUR from trade: its own database (hard) and three peers' `/livez` (soft). The standalone
  // service marked none of the three hard for reasons it recorded; in this process a hard probe on
  // a peer would remove seventeen modules from the balancer over one module's upstream incident.
  ...trade.probes,
  // FIVE from wallet, TWO of them hard: its own database, and `identity-credential`, which fails
  // only when no credential is configured at all — a deployment that cannot serve one money route
  // and will not fix itself. The three peer probes are soft for the reason the standalone service
  // recorded, and more so here: a hard one would empty the balancer of eighteen modules.
  ...wallet.probes,
  // FIVE from admin, ONE of them hard: its own database, because the audit chain lives in it and
  // nothing this module exists to do may happen without an audit row (SD-15). Its JWKS probe is
  // SOFT here where the standalone marked it hard — see `admin/module.ts`.
  ...admin.probes,
  // SEVEN from emberkin, and THREE of them are databases — its own, aetherholm's and nda's — plus
  // nda's HARD `nda-identity-credential` and four soft upstreams. One factory call, three titles'
  // readiness.
  ...emberkin.probes,
]) {
  lifecycle.addProbe(probe)
}

// 7. The dependency bundles, built once and shared. Each domain module takes exactly what it needs
//    and nothing else, which is what keeps a test able to build one without building the service.
const db = sql as unknown as Db
const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })

const posts: PostDeps = {
  sql: db,
  producer: SERVICE,
  policy: upstreams.policy,
  postsPerHour: env.postsPerHour,
  postMaxChars: env.postMaxChars,
  pageSizeMax: env.pageSizeMax,
  postingEnabled: env.postingEnabled,
}
const notifications: NotificationDeps = {
  sql: db,
  producer: SERVICE,
  notificationTtlDays: env.notificationTtlDays,
  publicUrl: env.publicUrl,
}

// 8. Routes. After the Lifecycle so the health handlers report real state, and after the pool so
//    the stores are real rather than a lazily-connected surprise on the first request.
const server = createMergedServer(
  {
  lifecycle,
  logger,
  metrics,
  verifier,
  // The SELECTOR, not a handle. The five domain dep objects below keep their boot-time `db` as a
  // placeholder; `forRequest` in server.ts replaces every one of them with the handle for the
  // request's network before any route runs.
  sql: networks,
  // The fallback for a request with no `CF-Network` header — which is EVERY service-to-service
  // call, because those go container to container and never reach the gateway that stamps one.
  // `requestNetwork` still prefers the header, so this cannot mask a mis-stamped external
  // request; it only answers the internal callers that never had one.
  singleNetwork: ownNetwork,
  producer: SERVICE,
  posts,
  circles: { sql: db, producer: SERVICE },
  whispers: {
    sql: db,
    producer: SERVICE,
    whispersPerHour: env.whispersPerHour,
    postMaxChars: env.postMaxChars,
  },
  notifications,
  // Reports share the whisper rate, deliberately. A report is the other thing on this service that
  // one person can aim at another, and the limit is what stops a report queue being used as one
  // more way to harass somebody.
  moderation: { sql: db, producer: SERVICE, reportsPerHour: env.whispersPerHour },
  followsPerHour: env.followsPerHour,
  // Where a BROWSER reaches studio, which is not where a service does. `env.ts` says why the two
  // are different variables; empty means images are unconfigured here and every `bytesUrl` this
  // process emits is null rather than a guess.
  studioPublicUrl: env.studioPublicUrl,
  queue,
  // The same secret signs what this service emits and verifies what identity sends. See the header
  // of `server.ts`: an unsigned inbound event route here is a free account-erasure endpoint.
  eventSigningSecret: env.outboxSigningSecret,
  // ── THE MODULES THAT CONSUME THE BUS THROUGH THE SQUARE'S WEBHOOK ────────────────────────────
  //
  // studio has no `POST /v1/events` of its own and is not getting one. It verifies with the same
  // estate-wide `OUTBOX_SIGNING_SECRET` this route checks, and it subscribes to the same topic, so
  // `MOUNTED_EVENT_PATHS`'s condition — ONE KEY, NOT THREE — is met and a fan-out is the honest
  // shape rather than a shortcut. Routing `identity.user.deleted` to the square alone would answer
  // 200 to a deletion that left every brand kit, prompt and generated image standing
  // (micro-org#534).
  inbound: [studio.inbound],
  pageSizeMax: env.pageSizeMax,
  // Queue depth is sampled at scrape time rather than on a timer. There is no `setInterval` in
  // this repository, and CI greps for one — rule 8.
  beforeScrape: async () => {
    const stats = await queue.stats()
    // The VIEW, not the registry. `jobs_pending` and `jobs_overdue` carry no `kind`, so this is
    // where five modules would otherwise erase each other every scrape — and `JobQueueOverdue`
    // would then alert on whichever queue happened to sample last. `network` as well, because this
    // process serves both estates and a summed gauge hides one behind the other.
    jobMetrics.set('jobs_pending', stats.pending, { network: ownNetwork })
    jobMetrics.set('jobs_overdue', stats.overdue, { network: ownNetwork })
    // Read out of the provider's own memory, so it answers "can this process authenticate RIGHT
    // NOW" rather than "was a credential configured at boot". Those diverge exactly when it
    // matters, which is the whole reason this gauge exists.
    metrics.set(
      'agora_service_token_usable',
      upstreams.identityTokens?.snapshot().hasUsableToken ? 1 : 0,
    )
    // Every mounted module samples its OWN gauges, through its OWN labelled view, against its OWN
    // queues. Awaited in order so one module's slow query cannot leave another's series stale for
    // a scrape without anything saying so.
    await devplatform.beforeScrape()
    await policy.beforeScrape()
    await pricing.beforeScrape()
    await studio.beforeScrape()
    await community.beforeScrape()
    await market.beforeScrape()
    await billing.beforeScrape()
    await mint.beforeScrape()
    await foresight.beforeScrape()
    await worlds.beforeScrape()
    await tessera.beforeScrape()
    await activity.beforeScrape()
    await lantern.beforeScrape()
    await hub.beforeScrape()
    await trade.beforeScrape()
    await wallet.beforeScrape()
    await admin.beforeScrape()
    await emberkin.beforeScrape()
  },
  },
  // ONE FLAT TABLE, in a fixed order. Order among the mounted modules decides nothing —
  // `mergedroutes.test.ts` asserts every PAIR of the five route sets overlaps on nothing at all,
  // which is what makes that true rather than merely likely.
  [
    ...devplatform.routes,
    ...policy.routes,
    ...pricing.routes,
    ...studio.routes,
    ...community.routes,
    ...market.routes,
    ...billing.routes,
    ...mint.routes,
    ...foresight.routes,
    ...worlds.routes,
    ...tessera.routes,
    // hub's eleven, every one of them under `/v1/hub` and NONE of them carrying a `sql` selector —
    // it is the one module here that owns no database, so its specs resolve to nothing rather than
    // to this file's handle. See `hub/module.ts`.
    ...hub.routes,
    // trade's thirty-four, every one at the path it served standalone. See the M5d import block.
    ...trade.routes,
    // wallet's twenty-six, every one BARE — including its unversioned `POST /events`. See the M5d
    // import block for why this is the module that does not move.
    ...wallet.routes,
    // admin's thirty-one: twenty-six bare, four under `/v1/operator/worlds` and one suffixed
    // event path. See the M5d import block.
    ...admin.routes,
    // THREE titles' tables in one spread, each already stamped with its own module's selector.
    ...emberkin.routes,
    // activity's own table then notify's, lantern's own then analytics' — each pair already
    // concatenated and stamped by its host module. lantern's carries the process's ONE `fallback`,
    // which is why it is LAST: `mountRoutes` takes the first fallback and matches none of them by
    // path, so nothing after it could displace it anyway, but the order says what is intended.
    ...activity.routes,
    ...lantern.routes,
  ],
)

// 9. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving.
const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      // The VIEW. Three other modules register `kind="outbox.relay"` too, so `kind` alone does not
      // say which relay failed, and `network` distinguishes planes rather than modules.
      const labels = { kind: event.kind, network: ownNetwork }
      if (event.type === 'claimed') jobMetrics.increment('jobs_claimed_total', labels)
      if (event.type === 'completed') jobMetrics.increment('jobs_completed_total', labels)
      if (event.type === 'failed') jobMetrics.increment('jobs_failed_total', labels)
      if (event.type === 'dead') jobMetrics.increment('jobs_dead_total', labels)
      if (event.durationMs !== undefined) {
        jobMetrics.observe('jobs_duration_ms', event.durationMs, labels)
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, {
  sql: db,
  logger,
  // The VIEW: this module's relay writes job counters under a kind three other modules register.
  metrics: jobMetrics,
  signingSecret: env.outboxSigningSecret,
  notifications,
  queue,
})
await seedRecurring(queue)
runner.start()

// ── AND EVERY MOUNTED MODULE'S JOB PLANE, BEFORE `listen()` ───────────────────────────────────
//
// Each module runs its OWN `JobRunner`, which is forced rather than chosen: a runner binds to one
// queue, which binds to one handle, which is one database. They could not share one even if the
// kinds were disjoint — and four of the five register `outbox.relay`, so
// `@cloudsforge/jobs`' `register()` would throw `handler already registered for outbox.relay` on
// the second. `jobcomposition.test.ts` proves that throw is still reachable, because the SILENT
// arrangement is the one next door: N runners all counting `kind="outbox.relay"` into an
// unlabelled registry sum into one series that still moves.
//
// AWAITED, and before the socket accepts, so no request can arrive against a module whose
// recurring work has not been seeded. A `price.refresh` that never got seeded is a rate board that
// silently stops ageing, and nothing anywhere says so.
await devplatform.start()
await policy.start()
await pricing.start()
await studio.start()
await community.start()
await market.start()
await billing.start()
await mint.start()
await foresight.start()
await worlds.start()
await tessera.start()
await activity.start()
await lantern.start()
await hub.start()
await trade.start()
await wallet.start()
await admin.start()
await emberkin.start()

// 10. Listen. Last of the construction steps, because a socket that accepts before its
//     dependencies exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', {
  port: env.port,
  modules: [
    SERVICE,
    DEVPLATFORM_MODULE,
    POLICY_MODULE,
    PRICING_MODULE,
    STUDIO_MODULE,
    COMMUNITY_MODULE,
    MARKET_MODULE,
    BILLING_MODULE,
    MINT_MODULE,
    FORESIGHT_MODULE,
    WORLDS_MODULE,
    TESSERA_MODULE,
    ACTIVITY_MODULE,
    LANTERN_MODULE,
  ],
})

// 11. Ready. Only now does `/readyz` start answering 200 and the balancer send traffic.
lifecycle.markReady()

// 12. Signal handlers, last of all. Hooks run in reverse registration order, so the server closes
//     first, then the runner stops claiming and DRAINS, then the pool closes with nothing left to
//     use it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
// Each mounted module drains its own runners and closes its own pools. Registered as its own hook
// per module, so a failure in one module's shutdown does not skip another's — `Lifecycle` runs the
// hooks it holds, and one hook doing four modules' work would stop at the first that threw.
lifecycle.onShutdown(() => devplatform.stop())
lifecycle.onShutdown(() => policy.stop())
lifecycle.onShutdown(() => pricing.stop())
lifecycle.onShutdown(() => studio.stop())
lifecycle.onShutdown(() => community.stop())
lifecycle.onShutdown(() => market.stop())
lifecycle.onShutdown(() => billing.stop())
lifecycle.onShutdown(() => mint.stop())
lifecycle.onShutdown(() => foresight.stop())
lifecycle.onShutdown(() => worlds.stop())
lifecycle.onShutdown(() => tessera.stop())
lifecycle.onShutdown(() => activity.stop())
lifecycle.onShutdown(() => lantern.stop())
lifecycle.onShutdown(() => hub.stop())
lifecycle.onShutdown(() => trade.stop())
lifecycle.onShutdown(() => wallet.stop())
lifecycle.onShutdown(() => admin.stop())
lifecycle.onShutdown(() => emberkin.stop())
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
