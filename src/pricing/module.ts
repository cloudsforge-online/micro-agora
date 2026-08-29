/**
 * The pricing module: the rate oracle, constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M5a (micro-deploy `docs/service-merge-plan.md`) folds pricing into agora's process as part
 * of the `platform` seed. All five databases are KEPT — no schema merge — and the five schemas own
 * `inbox` and `jobs` in ALL FIVE of them, with `outbox`, `event_subscriptions` and
 * `outbox_deliveries` in four including this one.
 *
 * A handler handed the wrong handle does not fail. `select … from jobs` SUCCEEDS against another
 * module's queue; `insert into outbox …` SUCCEEDS into another module's relay, where a job kind
 * this module never registered will try to deliver it. The four layers that make that unspellable
 * are the ones `./policy/module.ts` documents: `./env.ts` imported here and nowhere above, every
 * route stamped with `RouteSpec.sql`, handlers closed over this module's deps, and no interface
 * with a parameter a foreign handle could arrive through.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE FEED POLLING, WHICH IS THIS WAVE'S ONE GENUINELY DIFFERENT RISK ────────────────────────
 *
 * pricing is the only module in this process that dials a third party. Four venues —
 * api.coingecko.com, api.coinbase.com, api.kraken.com, api.binance.com — with somebody else's
 * rate limits and somebody else's outages. The plan refused this merge on that ground before the
 * owner overruled it, and the refusal named the real hazard: a wedged feed must not stall anything
 * else in the process.
 *
 * **It cannot, and the reason is structural rather than careful.** The polling was ALREADY a
 * leased job before this wave — `price.refresh`, seeded at boot and re-armed off the runner's
 * `completed` event by `rescheduleRecurring`, with no `setInterval` anywhere in the module (CI
 * greps for one; rule 8). This module keeps its OWN `JobRunner`, because a runner binds to one
 * queue, which binds to one handle, which is one database. So a refresh round that hangs occupies
 * one of THIS runner's slots and no other module's:
 *
 *   * The timeout is unchanged and byte-identical — `AbortSignal.timeout(env.sourceTimeoutMs)` in
 *     `httpFetchJson`, from `PRICING_SOURCE_TIMEOUT_MS`, the file's only fetch call.
 *   * The retry behaviour is unchanged, and that is a real statement rather than an absence:
 *     there is NO per-source retry and no backoff. `refreshRound` fans out with
 *     `Promise.allSettled` and lets `PRICING_MIN_SOURCES` and `PRICING_MAX_DIVERGENCE_BPS` decide
 *     whether the round counts. A source that is down costs one vote out of four. Adding a retry
 *     here would be a change to how the oracle fails, and this wave changes nothing about that.
 *   * The re-arm interval is unchanged — `PRICING_REFRESH_SECONDS`, applied by the same
 *     `rescheduleRecurring` off the same event.
 *
 * The exchanges are still deliberately NOT a readiness probe. A source being down is the condition
 * this module is designed to tolerate; removing the whole merged replica from the balancer over it
 * would take the square, the developer portal, the asset studio and the decision engine offline
 * because a third party had a bad minute.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type { Probe } from '@cloudsforge/lifecycle'
import { postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, type Metrics } from '@cloudsforge/telemetry'
import type { RouteSpec } from '../kernel.ts'
import type { Target } from '../migratortargets.ts'
import { SERVICE, env } from './env.ts'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { mountableRoutes, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring, type JobDeps } from './jobs.ts'
import { httpFetchJson, marketSources } from './sources.ts'
import { rateView, readQuotes } from './quotes.ts'
import type { Db } from './outbox.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS MODULE COLLIDES WITH THREE OTHERS ON `outbox.relay`.** Measured in
 * `../jobcomposition.test.ts` rather than asserted from memory: agora, devplatform, pricing and
 * studio all register a kind spelled exactly `outbox.relay`, so
 * `jobs_failed_total{kind="outbox.relay"}` would be the sum of FOUR unrelated relays — a number
 * that still moves, that an alert still fires on, and that names a service which is now five.
 *
 * `price.refresh` collides with nothing, and that matters more than it looks: it is the series an
 * operator reads when the rate board goes stale, and it must not be summed with anything.
 *
 * `jobs_pending` and `jobs_overdue` are worse still, because they carry no `kind` at all: each
 * module's sample would OVERWRITE the others' on every scrape, so a wedged refresh queue is ABSENT
 * from the graph rather than high — and `deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue`
 * alerts on exactly that gauge.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'pricing'

/** What the host process supplies. Deliberately nothing this module could hide a handle inside. */
export interface HostRuntime {
  /** The process-wide registry — the object the host's `/metrics` renders, not a view of it. */
  readonly metrics: Metrics
  /** The host's identity verifier. ONE JWKS client for the process; every module reads it. */
  readonly verifier: PrincipalVerifier
  /** The host `Lifecycle`'s `claimingJobs`. A drain must stop claiming in EVERY module at once. */
  claimingJobs(): boolean
  /** The host `Lifecycle`'s `track`. An in-flight write holds the drain of the process that owns it. */
  track(): () => void
}

/** What the host process gets back. **No field here names a database handle.** */
export interface PricingModule {
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module.
   *
   * ONE, and hard: a merged `/readyz` that probed only agora's database would answer 200 while
   * every rate read and every administered price was failing. The exchanges are NOT here — see the
   * file header.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the pricing half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take four others down for a pricing fault at a point where the host has
 * a logger and a `fatal` line to write.
 */
export async function createPricingModule(host: HostRuntime): Promise<PricingModule> {
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

  const pricingSql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  )

  const rateOptions = {
    maxAgeSeconds: env.maxAgeSeconds,
    conversionSpreadBps: env.conversionSpreadBps,
  }

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      sql: pricingSql,
      singleNetwork: ownNetwork,
      rateOptions,
    },
    pricingSql,
  )

  // ── THE FEED CLIENT, BUILT ONCE, WITH THE TIMEOUT IT ALWAYS HAD ────────────────────────────
  //
  // `httpFetchJson(env.sourceTimeoutMs)` is the module's only `fetch` call and the only place a
  // deadline is set. Constructed here rather than per plane so both estates' refresh rounds go
  // through one client with one timeout — which is what "byte-identical behaviour" means when a
  // module gains a second job plane.
  const sources = marketSources(httpFetchJson(env.sourceTimeoutMs))

  let started = false
  const runners = planes.map((plane) => {
    const jobDeps: JobDeps = {
      sql: plane.db,
      logger,
      // The labelled VIEW, not the registry: the relay handler writes job counters under a kind
      // three other modules also register.
      metrics: jobMetrics,
      signingSecret: env.outboxSigningSecret,
      sources,
      minSources: env.minSources,
      maxDivergenceBps: env.maxDivergenceBps,
      refreshSeconds: env.refreshSeconds,
    }
    const reschedule = rescheduleRecurring(plane.queue, logger, jobDeps)
    const runner = new JobRunner({
      queue: plane.queue,
      concurrency: 4,
      pollMs: 1_000,
      shouldClaim: () => started && host.claimingJobs(),
      onEvent: (event) => {
        if (event.kind) {
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
    return { runner, jobDeps }
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
    ],
    beforeScrape: async () => {
      for (const plane of planes) {
        const stats = await plane.queue.stats()
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network })
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network })

        // Rate age is a value that must be read, not counted, and it is the gauge an alert fires
        // on: past `PRICING_MAX_AGE_SECONDS` every conversion in the estate stops, so it must be
        // visible before it gets there rather than at the moment it does.
        //
        // On the REGISTRY, not the view — `pricing_rate_age_seconds` collides with no other
        // module's name — but per NETWORK, because the two planes hold two quote tables and one
        // would otherwise overwrite the other's ages under the same `asset`.
        for (const record of await readQuotes(plane.db)) {
          const view = rateView(record.asset, record, rateOptions)
          if (view.ageSeconds !== null) {
            metrics.set('pricing_rate_age_seconds', view.ageSeconds, {
              asset: record.asset,
              network: plane.network,
            })
          }
        }
      }
    },
    start: async () => {
      started = true
      // Seeded into EVERY queue, and `seedRecurring` takes the refresh interval because the
      // re-arm cadence is configuration rather than a constant.
      for (const [i, plane] of planes.entries()) await seedRecurring(plane.queue, runners[i]!.jobDeps)
      for (const { runner } of runners) runner.start()
    },
    stop: async () => {
      started = false
      const clean = (await Promise.all(runners.map(({ runner }) => runner.stop(20_000)))).every(Boolean)
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
 * module's `env` and cannot come into possession of a DSN it has no other reason to hold.
 */
export function pricingMigrationTargets(): readonly Target[] {
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
 * HOST's, so an in-flight administered-price write holds the drain of the process that is actually
 * shutting down. The two probe methods throw rather than answering plausibly, so if the filter is
 * ever removed the shadowed route fails loudly instead of reporting a readiness it did not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('pricing does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('pricing does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
