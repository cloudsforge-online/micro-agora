/**
 * The activity module: the estate's bus tail, constructed behind one function — and it brings a
 * module of its own.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND IT IS ALSO A NESTED HOST.**
 *
 * Wave M5c (micro-deploy `docs/service-merge-plan.md`) folds activity into agora's process. What
 * makes this wave different from M5a and M5b is that activity was ALREADY a merged process: wave M2
 * absorbed micro-notify into it, and that structure is PRESERVED rather than flattened. So this
 * file plays both parts at once:
 *
 *   * to agora, it is one more `createXModule` — it reads its own `./env.ts` (imported here and
 *     nowhere above), opens its own pools, runs its own `JobRunner`, labels its job metrics
 *     `{ module: 'activity' }` and stamps `RouteSpec.sql` over its whole table;
 *   * to notify, it is the host — it calls `createNotifyModule` with the runtime agora handed it,
 *     concatenates that module's routes after its own, carries its probe up, samples its gauges in
 *     `beforeScrape`, and drains it before its own pools close.
 *
 * Flattening notify into activity would have been fewer files and one fewer seam. It would also
 * have deleted the boundary `moduleboundary.test.ts` guards: `NOTIFY_INGEST_SIGNING_SECRET`,
 * `SMTP_PASS` and `NOTIFY_GATEWAY_TOKEN` are reachable from exactly one directory today, and the
 * whole value of that is that it is checkable. Nesting keeps it checkable.
 *
 * A handler handed the wrong handle does not fail. `insert into inbox …` SUCCEEDS against another
 * module's inbox and dedupes an event that database has never seen — `inbox` exists in thirteen of
 * this process's sixteen schemas with the same three columns, and `jobs` in all sixteen. The four
 * layers that make that unspellable are the ones `../pricing/module.ts` documents: `./env.ts`
 * imported here and nowhere above, every route stamped with `RouteSpec.sql` by `mountableRoutes`,
 * handlers closed over this module's deps, and no interface with a parameter a foreign handle could
 * arrive through.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE TWO INGEST SECRETS THIS PAIR KEEPS APART ───────────────────────────────────────────────
 *
 * `ACTIVITY_INGEST_SECRETS` verifies deliveries arriving at `POST /ingest/activity`;
 * `NOTIFY_INGEST_SIGNING_SECRET` verifies `POST /ingest/notify`. They are two accept-lists that
 * rotate independently, and one of them can write the canonical record of a user's money while the
 * other can mint a security email. `./routes.ts`'s `INGEST_PATHS` carries the four-part argument
 * for why one mount trying both would be a downgrade rather than compatibility. THIS FILE NEVER
 * HOLDS NOTIFY'S: it does not import `./notify/env.ts`, and the factory hands back six things none
 * of which names a credential.
 *
 * ── TWO JOB RUNNERS, TWO CONCURRENCY BUDGETS, AND THAT IS NOT AN ACCIDENT ──────────────────────
 *
 * notify's SMTP dispatcher drains in a loop, sends serially and has no socket timeout, so a wedged
 * mail host holding a SHARED budget would starve `activity.inbox.prune` indefinitely. That is what
 * `./starvation.test.ts` measures. It is also forced twice over here: a runner binds to one queue,
 * which binds to one handle, which is one database — and activity and notify have two.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type NetworkSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type { Probe } from '@cloudsforge/lifecycle'
import { postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, type Metrics } from '@cloudsforge/telemetry'
import type { RouteSpec } from '../kernel.ts'
import type { Target } from '../migratortargets.ts'
import { SERVICE, env } from './env.ts'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { mountableRoutes, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { retentionSummary, type Db } from './records.ts'
import { createNotifyModule, notifyMigrationTargets, type NotifyModule } from './notify/module.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * `jobs_pending` and `jobs_overdue` carry no `kind` at all, so sixteen modules' samples are the
 * IDENTICAL series and whichever scrapes last erases the other fifteen — a wedged queue then reads
 * as ABSENT from the graph rather than high, and `deploy/prometheus/rules/alerts.yaml`'s
 * `JobQueueOverdue` is `expr: jobs_overdue > 0`. Nobody alerts on absent.
 */
export const MODULE_LABEL = 'activity'

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

/** What the host process gets back. **No field here names a database handle or a secret.** */
export interface ActivityModule {
  /** activity's table, then notify's — the nesting, flattened only at this one point. */
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * TWO, both hard: this module's database and notify's.
   *
   * Carried up rather than kept, because a merged `/readyz` that reported only agora's would answer
   * 200 while every feed read and every notification in the estate was failing, and the balancer
   * would keep sending traffic to it.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the activity half of this process, and the notify half inside it.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take fifteen working modules down for an activity fault at a point where
 * the host has a logger and a `fatal` line to write.
 */
export async function createActivityModule(host: HostRuntime): Promise<ActivityModule> {
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION })

  const poolOptions = { max: env.databasePoolMax, onnotice: () => {} }
  const sql = postgres(env.databaseUrl, poolOptions)
  // ── ONE HANDLE PER NETWORK THIS DEPLOYMENT SERVES ──────────────────────────────────────────
  //
  // `ACTIVITY_DATABASE_URL_TESTNET` unset is the single-network case. `networkSql` then holds one
  // handle and REFUSES a testnet request rather than answering it out of mainnet rows.
  //
  // This is activity's model and NOT notify's: notify keeps one database for both estates and
  // carries the network as a COLUMN. `RouteSpec.sql` is what lets the two answers coexist on one
  // listener, and neither is imposed on the other by this file.
  const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined

  const close = async (): Promise<void> => {
    await sql.end({ timeout: 5 }).catch(() => {})
    await sqlTestnet?.end({ timeout: 5 }).catch(() => {})
  }

  // ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
  //
  // Keyed by THIS, never by the literal `mainnet`: same image, same code, different env, and a
  // testnet pod that hardcodes the key holds its own database under the other estate's name and
  // then refuses every request the gateway correctly stamped. `./ownnetwork.test.ts` reads this.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

  try {
    await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
    if (sqlTestnet) await assertSchemaAtLeast(sqlTestnet as unknown as DbSql, SCHEMA_VERSION)
  } catch (err) {
    await close()
    throw err
  }

  const activitySql: NetworkSql = networkSql({
    [ownNetwork]: sql as unknown as DbSql,
    ...(sqlTestnet && ownNetwork !== 'testnet' ? { testnet: sqlTestnet as unknown as DbSql } : {}),
  })

  const db = sql as unknown as Db

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // THE NOTIFY MODULE, BUILT BEFORE THIS MODULE'S ROUTES.
  //
  // Before, because its routes are mounted after activity's on one listener and its probe has to
  // reach the host's Lifecycle. It THROWS rather than exiting, and this function does not swallow
  // it: activity's own pools are closed and the throw goes up to agora's `build`, which unwinds
  // every module started so far and writes the one `fatal` line.
  //
  // **Six things come back and none of them is a secret.** There is no `SmtpConfig` in this scope,
  // no `NOTIFY_INGEST_SIGNING_SECRET`, and no notify `env` import above — which is why no activity
  // handler can close over notify's ingest key even by mistake, nor notify's over activity's.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  let notify: NotifyModule
  try {
    notify = await createNotifyModule({
      metrics,
      verifier: host.verifier,
      // The host's, not this module's: one process has ONE drain, and a module that decided its own
      // would keep claiming after the pod stopped serving.
      claimingJobs: () => host.claimingJobs(),
      track: () => host.track(),
    })
  } catch (err) {
    await close()
    throw err
  }

  const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })

  const routes = [
    ...mountableRoutes(
      {
        lifecycle: hostLifecycle(host),
        logger,
        metrics,
        verifier: host.verifier,
        // The SELECTOR, not a handle — routes read `ctx.sql`, resolved once per request.
        sql: activitySql,
        // The fallback for a request with no `CF-Network` header — every service-to-service call.
        singleNetwork: ownNetwork,
        ingest: {
          sql: db,
          logger,
          metrics,
          // activity's accept-list, reaching activity's ingest route and nothing else.
          secrets: env.ingestSecrets,
          toleranceMs: env.deliveryToleranceMs,
        },
      },
      activitySql,
    ),
    // And notify's, already filtered and already stamped with notify's own selector by that
    // module. This file never sees the handle they were stamped with.
    ...notify.routes,
  ]

  let started = false
  const reschedule = rescheduleRecurring(queue, logger)
  const runner = new JobRunner({
    queue,
    // TWO, as the standalone had it. See the header: notify's four are its own budget.
    concurrency: 2,
    pollMs: 1_000,
    shouldClaim: () => started && host.claimingJobs(),
    onEvent: (event) => {
      // EVERY line through the labelled view, including the ones carrying a `kind` that does not
      // collide today. A counter whose module is knowable only by reading the kind string is a
      // counter that stops being attributable the moment somebody adds a seventeenth module.
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
    inboxRetentionDays: env.inboxRetentionDays,
    retentionDays: env.retentionDays,
  })

  return {
    routes,
    probes: [
      postgresProbe(`postgres-${MODULE_LABEL}`, (signal) =>
        // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignores
        // the signal would hang `/readyz` for ever. Racing it is what turns "the database is not
        // answering" into a fail rather than a hung readiness endpoint.
        Promise.race([
          sql`select 1`,
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
          }),
        ]),
      ),
      notify.probe,
    ],
    beforeScrape: async () => {
      const stats = await queue.stats()
      // The VIEW and per NETWORK — the two unlabelled gauges the alert reads, kept from being
      // summed across modules and from overwriting each other across estates.
      jobMetrics.set('jobs_pending', stats.pending, { network: ownNetwork })
      jobMetrics.set('jobs_overdue', stats.overdue, { network: ownNetwork })
      const quarantined = await sql<{ n: number }[]>`
        select count(*)::int as n from activity_records where category = 'unclassified'
      `
      // On the REGISTRY: these names are module-unique and process-wide.
      metrics.set('activity_unclassified_total', quarantined[0]?.n ?? 0)
      // Read from the schema's own view, not from anything this process remembers. If the prune job
      // has been dead for a month this is the number that says so.
      for (const row of await retentionSummary(db)) {
        metrics.set('activity_retention_overdue_total', row.overdue, { class: row.retentionClass })
      }
      await notify.beforeScrape()
    },
    start: async () => {
      started = true
      await seedRecurring(queue)
      runner.start()
      notify.start()
    },
    stop: async () => {
      started = false
      // notify first: its dispatcher is the one that can be mid-send, and its pools must close
      // before this function returns or the host would report activity drained while a mail
      // delivery was still in flight.
      await notify.stop()
      const clean = await runner.stop(20_000)
      logger.info('job runner stopped', { clean })
      await close()
      logger.info('database pools closed')
    },
    schemaVersion: SCHEMA_VERSION,
  }
}

/**
 * The databases this module owns, for the merged migrator — activity's AND notify's.
 *
 * Scalars and DDL per database, so `../migrator.ts` never has to reach for either module's `env`
 * and cannot come into possession of a DSN, an ingest secret or an SMTP password. The nesting is
 * preserved here too: agora's migrator names `activityMigrationTargets`, and THIS function is what
 * knows notify exists — exactly as activity's own `src/migrator.ts` did before the merge.
 */
export function activityMigrationTargets(): readonly Target[] {
  const common = { module: SERVICE, migrations: MIGRATIONS, baselineVersion: BASELINE_VERSION } as const
  return [
    { ...common, network: 'primary', url: env.databaseUrl },
    ...(env.databaseUrlTestnet ? [{ ...common, network: 'testnet', url: env.databaseUrlTestnet }] : []),
    ...notifyMigrationTargets(),
  ]
}

/**
 * The `Lifecycle` shape `mountableRoutes` demands, with the two dead handlers refusing.
 *
 * `/livez` and `/readyz` are filtered out of the mounted table; `track()` is live and must be the
 * HOST's, so an in-flight ingest holds the drain of the process that is actually shutting down. The
 * two probe methods throw rather than answering plausibly, so if the filter is ever removed the
 * shadowed route fails loudly instead of reporting a readiness it did not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('activity does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('activity does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
