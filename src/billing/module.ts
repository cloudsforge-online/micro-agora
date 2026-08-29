/**
 * The billing module: the shop, the entitlements ledger and the erasure subscriber, constructed
 * behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M5a (micro-deploy `docs/service-merge-plan.md`) folds billing into agora's process as part
 * of the `platform` seed. All the databases are KEPT — no schema merge — and every schema owns
 * `inbox` and `jobs`, with `outbox`, `event_subscriptions` and `outbox_deliveries` in this one too.
 *
 * A handler handed the wrong handle does not fail. `select … from entitlements` SUCCEEDS against a
 * schema that also has that table; `insert into outbox …` SUCCEEDS into another module's relay,
 * where a job kind this module never registered will try to deliver it. The four layers that make
 * that unspellable are the ones `./policy/module.ts` documents: `./env.ts` imported here and
 * nowhere above, every route stamped with `RouteSpec.sql`, handlers closed over this module's deps,
 * and no interface with a parameter a foreign handle could arrive through.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT BILLING BRINGS THAT MOST MODULES DO NOT: A LEDGER-POSTING CREDENTIAL ──────────────────
 *
 * This module holds `ledger.postEntry`. Every purchase, refund and subscription renewal moves
 * somebody's money through the ledger, presented under this module's OWN identity credential
 * (`BILLING_IDENTITY_CREDENTIAL`, exchanged for short-lived tokens in `./upstreams.ts`). It keeps
 * its OWN ledger, admin-api and pricing clients — each module keeps its own — and the credential's
 * probe is contributed SOFT so a billing-only credential incident cannot empty every module's
 * balancer at once. See the `probes` array below.
 *
 * ── AND IT INGESTS EVENTS ──────────────────────────────────────────────────────────────────────
 *
 * `POST /v1/events` is billing's erasure subscriber, verified over the RAW body against
 * `OUTBOX_ACCEPT_SECRETS` (falling back to `[OUTBOX_SIGNING_SECRET]`). In the merged process it is
 * re-pathed to `/v1/events/billing` — see `MOUNTED_EVENTS_PATH` in `./server.ts` for why several
 * modules cannot share one verifier.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { serviceTokenProbe } from '@cloudsforge/auth'
import type { Probe } from '@cloudsforge/lifecycle'
import { httpProbe, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, type Metrics } from '@cloudsforge/telemetry'
import type { RouteSpec } from '../kernel.ts'
import type { Target } from '../migratortargets.ts'
import { SERVICE, env } from './env.ts'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { mountableRoutes, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring, type JobDeps } from './jobs.ts'
import { buildUpstreams } from './upstreams.ts'
import { httpPricingClient } from './pricingclient.ts'
import type { PurchaseDeps } from './purchases.ts'
import type { Db } from './outbox.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS MODULE COLLIDES WITH THREE OTHERS ON `outbox.relay`.** Measured in
 * `../jobcomposition.test.ts` rather than asserted from memory: agora, devplatform, pricing and
 * studio all register a kind spelled exactly `outbox.relay`, and billing registers it too — so
 * `jobs_failed_total{kind="outbox.relay"}` would be the sum of unrelated relays unless the
 * `module` label separated them.
 *
 * `jobs_pending` and `jobs_overdue` are worse still, because they carry no `kind` at all: each
 * module's sample would OVERWRITE the others' on every scrape, so a wedged renewal queue is ABSENT
 * from the graph rather than high — and `deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue`
 * alerts on exactly that gauge. The domain counters this module writes (`billing_*`) carry names
 * that collide with nothing and stay on the registry.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'billing'

/** What the host process supplies. Deliberately nothing this module could hide a handle inside. */
export interface HostRuntime {
  /** The process-wide registry — the object the host's `/metrics` renders, not a view of it. */
  readonly metrics: Metrics
  /** The host's identity verifier. ONE JWKS client for the process; every module reads it. */
  readonly verifier: PrincipalVerifier
  /** The host `Lifecycle`'s `claimingJobs`. A drain must stop claiming in EVERY module at once. */
  claimingJobs(): boolean
  /** The host `Lifecycle`'s `track`. A purchase in flight holds the drain of the process that owns it. */
  track(): () => void
}

/** What the host process gets back. **No field here names a database handle.** */
export interface BillingModule {
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module.
   *
   * Postgres is hard: a merged `/readyz` that probed only agora's database would answer 200 while
   * every entitlement read and every purchase was failing. The ledger and the identity credential
   * are SOFT — a hard probe on either would take every module in the process out of the balancer
   * for one module's upstream incident. The `identity-jwks` probe is deliberately NOT here: the
   * host already probes that URL, softly, under that name.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the billing half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take every other module down for a billing fault at a point where the
 * host has a logger and a `fatal` line to write.
 */
export async function createBillingModule(host: HostRuntime): Promise<BillingModule> {
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION })

  const poolOptions = { max: env.databasePoolMax, onnotice: () => {} }
  const sql = postgres(env.databaseUrl, poolOptions)
  const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined

  const close = async (): Promise<void> => {
    await sql.end({ timeout: 5 }).catch(() => {})
    await sqlTestnet?.end({ timeout: 5 }).catch(() => {})
  }

  // ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
  //
  // Every per-network map below keys its primary entry by THIS, never by the literal `mainnet`.
  // Same image, same code, different env: a testnet pod that hardcodes the key holds its own
  // database and its own queue under the other estate's name, and then refuses every request the
  // gateway correctly stamped. `./ownnetwork.test.ts` reads THIS file.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

  const queueOver = (handle: typeof sql): JobQueue =>
    new JobQueue(handle as unknown as JobsSql, { owner: env.instanceId })

  const planes = [
    { network: ownNetwork, pool: sql, db: sql as unknown as Db, queue: queueOver(sql) },
    ...(sqlTestnet && ownNetwork !== 'testnet'
      ? [
          {
            network: 'testnet' as const,
            pool: sqlTestnet,
            db: sqlTestnet as unknown as Db,
            queue: queueOver(sqlTestnet),
          },
        ]
      : []),
  ]

  try {
    for (const plane of planes) {
      await assertSchemaAtLeast(plane.pool as unknown as DbSql, SCHEMA_VERSION)
    }
  } catch (err) {
    await close()
    throw err
  }

  const billingSql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  )

  // ── THE PEERS, BUILT ONCE, WITH THE CREDENTIAL THIS MODULE PRESENTS ─────────────────────────
  //
  // One set of upstream clients for the whole module: they dial a service by URL and carry no
  // per-network state, and the credential is billing's own. Reproduced from the standalone
  // `index.ts` verbatim, including its boot-time diagnostics.
  const { identityTokens, ledger, adminApi } = buildUpstreams(env, {
    originatingService: SERVICE,
    onEvent: (event) => {
      if (event.kind === 'exchange_failed') {
        // `warn`, not `error`, while a usable token is still held: the slack after the refresh
        // point exists precisely so a few of these are survivable and uninteresting.
        const level = event.hadUsableToken ? 'warn' : 'error'
        logger[level]('service token exchange failed', {
          err: event.err,
          hadUsableToken: event.hadUsableToken,
        })
      } else if (event.kind === 'minted') {
        logger.info('service token minted', {
          service: event.service,
          expiresIn: event.expiresIn,
          refreshInMs: event.refreshInMs,
        })
      } else {
        logger.warn('service token', { event: event.kind, url: event.url })
      }
    },
  })

  if (!identityTokens) {
    logger.error('BILLING_IDENTITY_CREDENTIAL is not set; every call to a peer will fail 503', {
      hint: 'deploy/scripts/estate-bootstrap.sh writes it to compose/estate/tokens.env',
    })
  }
  if (env.legacyServiceTokenPresent) {
    logger.error('BILLING_LEDGER_TOKEN / BILLING_ADMIN_API_TOKEN are set and are IGNORED', {
      hint: 'both were 600-second tokens read once at boot; BILLING_IDENTITY_CREDENTIAL replaces them',
    })
  }
  if (adminApi === undefined) {
    logger.info('no ADMIN_API_URL — the engagement fee recycle is off in this deployment')
  }

  // Unauthenticated, so it is built here rather than in `upstreams.ts` — the rate board is public
  // by design (`pricing/src/server.ts`).
  const pricing = httpPricingClient({ baseUrl: env.pricingBaseUrl, deadlineMs: env.pricingDeadlineMs })

  // A boot-time value: `forRequest` in `mountableRoutes` rebuilds it against this request's handle
  // before any route sees it, so a purchase written through the wrong handle cannot also post to
  // the other estate's ledger.
  const purchases: PurchaseDeps = {
    sql: sql as unknown as Db,
    ledger,
    producer: SERVICE,
    priceAsset: env.priceAsset,
    settlementAsset: env.settlementAsset,
    pricing,
  }

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      sql: billingSql,
      // The fallback for a request with no `CF-Network` header — every service-to-service call,
      // which goes container to container and never reaches the gateway that stamps one.
      singleNetwork: ownNetwork,
      purchases,
      // Billing's OWN accept list, reaching billing's OWN `/v1/events/billing` path.
      eventAcceptSecrets: env.acceptSecrets,
    },
    billingSql,
  )

  let started = false
  const runners = planes.map((plane) => {
    const jobDeps: JobDeps = {
      sql: plane.db,
      logger,
      // The REGISTRY, not the labelled view: every counter this module's handlers write is a
      // `billing_*` name that collides with nothing. The job LIFECYCLE counters (`jobs_*`) go
      // through `jobMetrics` in `onEvent` below, where the collision with three other relays is.
      metrics,
      ledger,
      producer: SERVICE,
      // The SETTLEMENT asset. The fee recycle moves platform revenue out of `(platform, X, fees)`,
      // which is the account `purchasePostings` credits.
      assetCode: env.settlementAsset,
      signingSecret: env.outboxSigningSecret,
      idempotencyTtlDays: env.idempotencyTtlDays,
      ...(adminApi ? { adminApi } : {}),
    }
    const reschedule = rescheduleRecurring(plane.queue, logger)
    const runner = new JobRunner({
      queue: plane.queue,
      concurrency: 4,
      pollMs: 1_000,
      shouldClaim: () => started && host.claimingJobs(),
      onEvent: (event) => {
        if (event.kind) {
          // EVERY line through the labelled view. `network` distinguishes this runner from the
          // other PLANE, never from the other MODULE — several other modules register
          // `kind="outbox.relay"` too.
          const labels = { kind: event.kind, network: plane.network }
          if (event.type === 'claimed') jobMetrics.increment('jobs_claimed_total', labels)
          if (event.type === 'completed') jobMetrics.increment('jobs_completed_total', labels)
          if (event.type === 'failed') jobMetrics.increment('jobs_failed_total', labels)
          if (event.type === 'dead') jobMetrics.increment('jobs_dead_total', labels)
          if (event.durationMs !== undefined) jobMetrics.observe('jobs_duration_ms', event.durationMs, labels)
        }
        if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
          logger.error('job failure', { ...event })
        }
        reschedule(event)
      },
    })
    registerHandlers(runner, jobDeps)
    return runner
  })

  return {
    routes,
    probes: [
      postgresProbe(`postgres-${MODULE_LABEL}`, (signal) =>
        Promise.race([
          sql`select 1`,
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
          }),
        ]),
      ),
      // SOFT in the merged process. Standalone billing marked this HARD; a hard probe here would
      // take every module in the process out of the balancer the moment billing's identity
      // credential was missing or its exchange was failing — one module's upstream incident
      // becoming an estate outage (this mirrors agora's own decision to keep `policy` soft — see
      // `agora/src/index.ts`). `serviceTokenProbe` hardcodes `kind: 'hard'`, so the kind is
      // overridden here; the absence is still visible, as a `warn` in this module's `/readyz` row.
      { ...serviceTokenProbe(identityTokens), kind: 'soft' as const },
      // SOFT, and it always was: billing still serves the catalogue and every already-issued
      // entitlement check when the ledger is down — only new purchases fail. Making it hard would
      // turn a purchase outage into an "everyone loses access to what they already bought" outage,
      // now multiplied across every module in the process.
      httpProbe('ledger', `${env.ledgerBaseUrl.replace(/\/+$/, '')}/livez`, { kind: 'soft' }),
    ],
    beforeScrape: async () => {
      for (const plane of planes) {
        // The VIEW for the two unlabelled gauges — see `MODULE_LABEL` — and the network for the two
        // planes, because summed across both a wedged queue reads healthy while one estate's
        // backlog grows for ever.
        const stats = await plane.queue.stats()
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network })
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network })
      }
    },
    start: async () => {
      started = true
      // Seeded into EVERY queue: an estate whose renewals and expiry sweep are not running is half
      // billing, not dormant.
      for (const plane of planes) await seedRecurring(plane.queue)
      for (const runner of runners) runner.start()
    },
    stop: async () => {
      started = false
      // The runners stop FIRST, so a renewal in flight is allowed to finish and commit rather than
      // being cut off mid-transaction with its pool closed under it — and a purchase holds a ledger
      // call inside its transaction, which is exactly what must not be severed.
      const clean = (await Promise.all(runners.map((runner) => runner.stop(20_000)))).every(Boolean)
      logger.info('job runners stopped', { clean, runners: runners.length })
      await close()
      logger.info('database pools closed', { networks: planes.length })
    },
    schemaVersion: SCHEMA_VERSION,
  }
}

/**
 * The databases this module owns, for the merged migrator.
 *
 * Four scalars and an array of DDL per database, so `../migrator.ts` never has to reach for this
 * module's `env` and cannot come into possession of a DSN or a signing secret it has no other
 * reason to hold.
 */
export function billingMigrationTargets(): readonly Target[] {
  const common = { module: SERVICE, migrations: MIGRATIONS, baselineVersion: BASELINE_VERSION } as const
  return [
    { ...common, network: 'primary', url: env.databaseUrl },
    ...(env.databaseUrlTestnet ? [{ ...common, network: 'testnet', url: env.databaseUrlTestnet }] : []),
  ]
}

/**
 * The `Lifecycle` shape `mountableRoutes` demands, with the two dead handlers refusing.
 *
 * `/livez` and `/readyz` are filtered out of the mounted table; `track()` is live and must be the
 * HOST's, so a purchase or an erasure that holds the drain open holds the drain of the process that
 * is actually shutting down. The two probe methods throw rather than answering plausibly, so if the
 * filter is ever removed the shadowed route fails loudly instead of reporting a readiness it did
 * not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('billing does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('billing does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
