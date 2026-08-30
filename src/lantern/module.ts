/**
 * The lantern module: the estate's telemetry plane, constructed behind one function — and it brings
 * a module of its own.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND IT IS ALSO A PRIVACY BOUNDARY.**
 *
 * Wave M5c (micro-deploy `docs/service-merge-plan.md`) folds lantern into agora's process. lantern
 * was ALREADY a merged process — wave M1b absorbed micro-analytics into it — and that structure is
 * PRESERVED rather than flattened, which matters more here than anywhere else in the consolidation:
 *
 *   `ANALYTICS_PSEUDONYM_KEY` is the one secret in this estate whose disclosure is not "an attacker
 *   can act as us" but "the pseudonymisation was never real". With it and a candidate user id
 *   anyone can compute a lookup key and learn whether that person is in the store, and while their
 *   salt exists, recover their behavioural history. It CANNOT be rotated without orphaning every
 *   subject key derived under it, so there is no remediation for a leak — only prevention.
 *
 * A process boundary enforced that for free. A module boundary does not: one heap, one import
 * graph, and one careless `deps` spread away from a foreign handler closing over a `PepperRing`.
 * `./privacyboundary.test.ts` is what keeps it real, and wave M5c widened it from "no lantern-side
 * file" to "no file in this repository outside `./analytics/`" — because the boundary now has
 * fourteen more modules on the other side of it.
 *
 * So this file plays both parts: to agora it is one more `createXModule`, reading its own `./env.ts`
 * (imported here and nowhere above), opening its own pools, running its own `JobRunner`, labelling
 * its job metrics `{ module: 'lantern' }` and stamping `RouteSpec.sql` over its whole table; to
 * analytics it is the host, calling `createAnalyticsModule` and receiving four things, NONE of
 * which names a pepper, a delivery secret or a cohort floor.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THE JOB METRICS MUST BE LABELLED, MEASURED RATHER THAN ASSUMED ─────────────────────────
 *
 * lantern and analytics BOTH register a job `kind="rollup"` and a `kind="retention"`, character for
 * character, so `jobs_failed_total{kind="rollup"}` would be the sum of two unrelated queues — a
 * number that still moves and that nobody can act on. `jobs_pending` and `jobs_overdue` are worse,
 * because they carry no `kind` at all. `../jobcomposition.test.ts` measures both collisions.
 */

import postgres, { type Sql as PostgresSql } from 'postgres'
import { assertSchemaAtLeast, networkSql, type NetworkSql, type Sql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type { Probe } from '@cloudsforge/lifecycle'
import { postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, type Metrics } from '@cloudsforge/telemetry'
import type { RouteSpec } from '../kernel.ts'
import type { Target } from '../migratortargets.ts'
import { SERVICE, env } from './env.ts'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { mountableRoutes, registerServiceMetrics, scrapeRefresh, type PrincipalVerifier } from './server.ts'
import { registerHandlers, rescheduleRecurring, sampleQueue, seedRecurring } from './jobs.ts'
import { RumQuota } from './rum.ts'
import { analyticsMigrationTargets, createAnalyticsModule, type AnalyticsModule } from './analytics/module.ts'

/** The label every JOB metric this module writes carries. See the header for the two collisions. */
export const MODULE_LABEL = 'lantern'

/** What the host process supplies. Deliberately nothing this module could hide a handle inside. */
export interface HostRuntime {
  /** The process-wide registry — the object the host's `/metrics` renders, not a view of it. */
  readonly metrics: Metrics
  /** The host's identity verifier. ONE JWKS client for the process; every module reads it. */
  readonly verifier: PrincipalVerifier
  /** The host `Lifecycle`'s `claimingJobs`. A drain must stop claiming in EVERY module at once. */
  claimingJobs(): boolean
}

/** What the host process gets back. **No field here names a database handle, a pepper or a token.** */
export interface LanternModule {
  /**
   * lantern's table, then analytics'. lantern's carries the process's ONE `fallback` — the
   * CORS-readable unknown-`/ingest/*` reply — which is why this list must keep its order.
   *
   * Typed over `postgres`'s own client rather than `@cloudsforge/db`'s minimal `Sql`, because that
   * is the view the fifteen other modules' tables are typed over and one flat table has one type.
   * See the cast at the seam below: the two are two published views of the same object.
   */
  readonly routes: readonly RouteSpec<PostgresSql>[]
  /** TWO, both hard: lantern's database and analytics'. */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the lantern half of this process, and the analytics half inside it.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take fifteen working modules down for a telemetry fault at a point where
 * the host has a logger and a `fatal` line to write.
 */
export async function createLanternModule(host: HostRuntime): Promise<LanternModule> {
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', {
    version: env.version,
    schemaVersion: SCHEMA_VERSION,
    // Said at boot, because a sink that is switched off looks exactly like one that is broken until
    // somebody reads the environment.
    rumSink: env.rumOrigins.length > 0,
  })

  const poolOptions = { max: env.databasePoolMax, onnotice: () => {} }
  const sql = postgres(env.databaseUrl, poolOptions)
  const db = sql as unknown as Sql
  const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined

  const close = async (): Promise<void> => {
    await sql.end({ timeout: 5 }).catch(() => {})
    await sqlTestnet?.end({ timeout: 5 }).catch(() => {})
  }

  // ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
  //
  // Keyed by THIS, never by the literal `mainnet`. `./ownnetwork.test.ts` reads this file.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

  try {
    await assertSchemaAtLeast(db, SCHEMA_VERSION)
    if (sqlTestnet) await assertSchemaAtLeast(sqlTestnet as unknown as Sql, SCHEMA_VERSION)
  } catch (err) {
    await close()
    throw err
  }

  const lanternSql: NetworkSql = networkSql({
    [ownNetwork]: db,
    ...(sqlTestnet && ownNetwork !== 'testnet' ? { testnet: sqlTestnet as unknown as Sql } : {}),
  })

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // THE ANALYTICS MODULE, BUILT BEFORE THIS MODULE'S ROUTES.
  //
  // Before, because its routes are mounted after lantern's on one listener and its probe has to
  // reach the host's Lifecycle. It THROWS rather than exiting, and this function does not swallow
  // it: lantern's own pools are closed and the throw goes up to agora's `build`.
  //
  // **Four things come back and none of them is a secret.** There is no `PepperRing` in this scope,
  // no `ANALYTICS_PSEUDONYM_KEY`, and no analytics `env` import above — which is why no lantern
  // handler, and no handler in the other fourteen modules, can close over the pepper even by
  // mistake. `./privacyboundary.test.ts` asserts the shape of that rather than trusting it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  let analytics: AnalyticsModule
  try {
    analytics = await createAnalyticsModule({
      metrics,
      verifier: host.verifier,
      claimingJobs: () => host.claimingJobs(),
    })
  } catch (err) {
    await close()
    throw err
  }

  const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId, leaseMs: 120_000 })
  const refresh = scrapeRefresh({ sql: db, metrics })

  // ── THE ONE CAST AT THIS SEAM ────────────────────────────────────────────────────────────────
  //
  // lantern's handlers read `@cloudsforge/db`'s minimal `Sql`; analytics' read `postgres`'s own
  // client, and its `mountableRoutes` already casts one to the other so the two tables could sit
  // side by side in lantern's own process. agora's flat table is typed over `postgres`'s client —
  // fifteen modules' worth — so the pair is re-viewed here, once, in the file that owns both halves.
  //
  // It is the same cast `../kernel.ts` makes internally when it resolves `selector.for(network)`:
  // the two types are two published views of ONE object, so this names which view a handler reads
  // through and never a different value. It cannot substitute a handle — the selector each spec
  // carries was stamped above and is not touched here.
  const routes = [
    ...mountableRoutes(
      {
        lifecycle: hostLifecycle(),
        logger,
        metrics,
        verifier: host.verifier,
        // The SELECTOR, not a handle — routes read `ctx.sql`, resolved once per request.
        sql: lanternSql,
        // The fallback for a request with no `CF-Network` header — every service-to-service call.
        singleNetwork: ownNetwork,
        token: env.token,
        limits: env.limits,
        rumOrigins: env.rumOrigins,
        rumQuota: new RumQuota(env.rumQuotaPerMinute),
        traceUrlTemplate: env.traceUrlTemplate,
      },
      lanternSql,
    ),
    // And analytics', already filtered, already remounted onto `/ingest/analytics`, and already
    // stamped with analytics' own selector by that module. This file never sees the handle they
    // were stamped with.
    ...analytics.routes,
  ] as unknown as readonly RouteSpec<PostgresSql>[]

  let started = false
  const reschedule = rescheduleRecurring(queue, logger)
  const runner = new JobRunner({
    queue,
    concurrency: 2,
    pollMs: 1_000,
    shouldClaim: () => started && host.claimingJobs(),
    onEvent: (event) => {
      // EVERY line through the labelled view. `kind` alone is not enough: analytics registers the
      // same two kinds, and a counter summing two unrelated queues is worse than no counter,
      // because it still moves.
      if (event.kind) {
        const labels = { kind: event.kind, network: ownNetwork }
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
  registerHandlers(runner, {
    sql: db,
    logger,
    metrics: jobMetrics,
    retention: {
      eventDays: env.eventRetentionDays,
      issueDays: env.issueRetentionDays,
      rollupDays: env.rollupRetentionDays,
      rumDays: env.rumRetentionDays,
    },
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
      analytics.probe,
    ],
    beforeScrape: async () => {
      await refresh()
      // The VIEW: `sampleQueue` writes `jobs_pending` and `jobs_overdue`, the two gauges sixteen
      // modules would otherwise erase for each other every scrape.
      await sampleQueue(queue, jobMetrics)
      await analytics.beforeScrape()
    },
    start: async () => {
      started = true
      await seedRecurring(queue)
      runner.start()
      analytics.start()
    },
    stop: async () => {
      started = false
      await analytics.stop()
      const clean = await runner.stop(20_000)
      logger.info('job runner stopped', { clean })
      await close()
      logger.info('database pools closed')
    },
    schemaVersion: SCHEMA_VERSION,
  }
}

/**
 * The databases this module owns, for the merged migrator — lantern's AND analytics'.
 *
 * Scalars and DDL per database, so `../migrator.ts` never has to reach for either module's `env`.
 * That is the whole reason this function exists rather than a target list written out there: the
 * migrator process must never come into possession of `ANALYTICS_PSEUDONYM_KEY`, and the only way
 * to guarantee it is that no file it imports can name one. The nesting is preserved here too —
 * agora's migrator names `lanternMigrationTargets`, and THIS function is what knows analytics
 * exists, exactly as lantern's own `src/migrator.ts` did before the merge.
 */
export function lanternMigrationTargets(): readonly Target[] {
  const common = { module: SERVICE, migrations: MIGRATIONS, baselineVersion: BASELINE_VERSION } as const
  return [
    { ...common, network: 'primary', url: env.databaseUrl },
    ...(env.databaseUrlTestnet ? [{ ...common, network: 'testnet', url: env.databaseUrlTestnet }] : []),
    ...analyticsMigrationTargets(),
  ]
}

/**
 * The `Lifecycle` shape `mountableRoutes` demands, with both handlers refusing.
 *
 * `/livez` and `/readyz` are filtered out of the mounted table, so no handler that survives the
 * filter can reach this. Passing the host's real Lifecycle would be worse than useless: it would
 * suggest those two handlers are live when they are not. lantern's routes never call `track()`,
 * which is why — unlike activity's — this shim wires nothing at all.
 */
function hostLifecycle(): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('lantern does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('lantern does not serve /readyz in the merged process — agora does')
    },
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
