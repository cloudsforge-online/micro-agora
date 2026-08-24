/**
 * The composition root.
 *
 * Everything this service is made of is built here, once, in an order that is not arbitrary. Each
 * step carries the reason it must come before the next; the ordering is the substance of the file.
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
import { createServer, registerServiceMetrics } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { buildUpstreams } from './upstreams.ts'
import type { Db } from './outbox.ts'
import type { PostDeps } from './posts.ts'
import type { NotificationDeps } from './notifications.ts'

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
    postgresProbe('postgres', (signal) =>
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
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
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
  pageSizeMax: env.pageSizeMax,
  // Queue depth is sampled at scrape time rather than on a timer. There is no `setInterval` in
  // this repository, and CI greps for one — rule 8.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)
    // Read out of the provider's own memory, so it answers "can this process authenticate RIGHT
    // NOW" rather than "was a credential configured at boot". Those diverge exactly when it
    // matters, which is the whole reason this gauge exists.
    metrics.set(
      'agora_service_token_usable',
      upstreams.identityTokens?.snapshot().hasUsableToken ? 1 : 0,
    )
  },
})

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
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
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
  metrics,
  signingSecret: env.outboxSigningSecret,
  notifications,
  queue,
})
await seedRecurring(queue)
runner.start()

// 10. Listen. Last of the construction steps, because a socket that accepts before its
//     dependencies exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

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
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
