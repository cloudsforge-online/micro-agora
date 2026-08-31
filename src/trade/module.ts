/**
 * The trade module: the trading engine and the order book, constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M5d (micro-deploy `docs/service-merge-plan.md`) folds trade into agora's process. Every
 * database is KEPT — no schema merge — and `inbox` and `jobs` exist in nearly all of them with the
 * same columns, while `outbox`, `event_subscriptions` and `outbox_deliveries` exist in most.
 *
 * A handler handed the wrong handle does not fail. `select … from jobs` SUCCEEDS against another
 * module's queue; `insert into outbox …` SUCCEEDS into another module's relay, where a job kind
 * this module never registered will try to deliver it. The four layers that make that unspellable
 * are the ones `../policy/module.ts` documents: `./env.ts` imported here and nowhere above, every
 * route stamped with `RouteSpec.sql`, handlers closed over this module's deps, and no interface
 * with a parameter a foreign handle could arrive through.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT IS DIFFERENT ABOUT THIS ONE ──────────────────────────────────────────────────────────
 *
 * **It holds `ledger.postEntry` authority, and it is the module whose jobs move money on a timer.**
 * `bot.tick` places live orders; `bot.settle` books performance fees; `exchange.maintain` expires
 * GTD orders and `exchange.transfer` completes withdrawals that have already DEBITED a customer.
 * The owner overruled the ledger-isolation rule for the platform tier (§M5) and the mitigations
 * are mandatory rather than advisory — this module keeps its OWN `LedgerClient` built from its OWN
 * `TRADE_SERVICE_TOKEN`, its own JobRunner per network, `{ module }` on every job metric, and its
 * own suffixed event path against its own inbox.
 *
 * **The exchange flag gates ROUTES, not JOBS, and that survives the merge unchanged.**
 * `TRADE_EXCHANGE_ENABLED` false means `/v1/exchange/*` refuses; the maintenance and transfer jobs
 * still run, because work already accepted must be finished. A withdrawal that debited a customer
 * and was then stranded by a flag is money taken and not delivered. `./jobs.ts` argues this at
 * length and nothing here changes it.
 *
 * ── AND ITS OWN JOB RUNNERS, ONE PER NETWORK ──────────────────────────────────────────────────
 *
 * A runner binds to one queue, which binds to one handle, which is one database. Sharing the
 * host's runner would hand every trade handler agora's handle — a `bot.tick` clearing against the
 * square's tables, succeeding, and recording that it went exactly as intended.
 * `../jobcomposition.test.ts` refuses a shared runner at boot rather than trusting this paragraph.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type { Probe } from '@cloudsforge/lifecycle'
import { httpProbe, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, type Metrics } from '@cloudsforge/telemetry'
import type { RouteSpec } from '../kernel.ts'
import type { Target } from '../migratortargets.ts'
import { SERVICE, env } from './env.ts'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { mountableRoutes, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { httpLedgerClient } from './ledgerclient.ts'
import { httpPricingClient } from './pricingclient.ts'
import { systemClock } from './rng.ts'
import type { Db } from './outbox.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * `outbox.relay` is the estate's most-collided job kind and this module makes it one more —
 * `../jobcomposition.test.ts` counts them rather than guessing. `bot.tick`, `bot.settle`,
 * `backtest.run`, `exchange.maintain` and `exchange.transfer` collide with nothing, and that
 * matters more than it looks: they are the series an operator reads when a bot stops trading or a
 * withdrawal stops completing, and they must not be summed with anything.
 *
 * `jobs_pending` and `jobs_overdue` are worse still, because they carry no `kind` at all: each
 * module's sample would OVERWRITE the others' on every scrape, so a wedged transfer queue is
 * ABSENT from the graph rather than high — and `deploy/prometheus/rules/alerts.yaml`'s
 * `JobQueueOverdue` alerts on exactly that gauge.
 */
export const MODULE_LABEL = 'trade'

/** How long a claimed idempotency key is kept. Must outlive every caller's retry horizon. */
const IDEMPOTENCY_TTL_DAYS = 30

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
export interface TradeModule {
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module: one hard, four soft.
   *
   * Postgres is hard because without it no trade route works, including a read. The three upstream
   * probes and the JWKS probe are SOFT — and the ledger one is soft here where the standalone
   * service also had it soft, for the reason the standalone recorded: money paths refuse
   * individually and precisely (`unresolved` fills, `pending` settlements, both retried under the
   * same key), while the strategy catalogue and every backtest read still work. In the merged
   * process the argument is stronger still: a hard probe on a peer would remove SEVENTEEN modules
   * from the balancer for one module's upstream incident.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the trade half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take sixteen others down for a trade fault at a point where the host has
 * a logger and a `fatal` line to write.
 */
export async function createTradeModule(host: HostRuntime): Promise<TradeModule> {
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', {
    version: env.version,
    schemaVersion: SCHEMA_VERSION,
    // Said at boot, because an engine with live trading switched off looks exactly like an engine
    // that is broken until somebody reads the environment.
    liveEnabled: env.liveEnabled,
    exchangeEnabled: env.exchangeEnabled,
  })

  const poolOptions = {
    max: env.databasePoolMax,
    // postgres.js writes notices to stderr as unstructured text by default, which is how a
    // connection string ends up in a log the collector cannot parse.
    onnotice: () => {},
  }
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
  // gateway correctly stamped. It happened twice in this module's history — the handle, then the
  // job plane. `./ownnetwork.test.ts` reads THIS file.
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
  const planeFor = (network: 'mainnet' | 'testnet') => {
    const plane = planes.find((p) => p.network === network)
    if (!plane) throw new Error(`no plane for network ${network}`)
    return plane
  }

  // Below schema version 9 the `fee_settlements_bot_period_uniq` constraint does not exist, and
  // this code running against that schema would double-bill performance fees. Closed then rethrown
  // rather than exited: the host unwinds every module built before this one.
  try {
    for (const plane of planes) {
      await assertSchemaAtLeast(plane.pool as unknown as DbSql, SCHEMA_VERSION)
    }
  } catch (err) {
    await close()
    throw err
  }

  const tradeSql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  )

  // The upstream clients. ONE scoped credential, this module's own — SD-05: never shared with
  // another module, so a compromise of one is not a compromise of the estate. This is the line
  // that keeps the ledger-isolation mitigation real: trade posts to the ledger as trade.
  const serviceToken = (): string => env.serviceToken
  const ledger = httpLedgerClient({
    baseUrl: env.ledgerUrl,
    token: serviceToken,
    deadlineMs: env.moneyDeadlineMs,
    originatingService: SERVICE,
  })
  const pricing = httpPricingClient({
    baseUrl: env.pricingUrl,
    token: serviceToken,
    deadlineMs: env.upstreamDeadlineMs,
    clock: systemClock,
  })

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      sql: tradeSql,
      singleNetwork: ownNetwork,
      producer: SERVICE,
      // Boot-time value; `forRequest` replaces it with this request's network before any route
      // sees it. An enqueue is a WRITE, and a fill job claimed by the other estate's runner clears
      // against the other estate's book.
      queue: { enqueue: (options) => planeFor(ownNetwork).queue.enqueue(options) },
      queueFor: (network: 'mainnet' | 'testnet') => ({
        enqueue: (options: Parameters<JobQueue['enqueue']>[0]) => planeFor(network).queue.enqueue(options),
      }),
      ledger,
      pricing,
      clock: systemClock,
      liveEnabled: env.liveEnabled,
      // Gates the `/v1/exchange` ROUTES only. The jobs below run either way — see the file header.
      exchangeEnabled: env.exchangeEnabled,
      settlementPeriodSeconds: env.settlementPeriodSeconds,
      // Signing stays singular (the relay below); ACCEPTING is a list, so the estate's shared
      // secret can be rotated with an overlap window instead of a flag day.
      eventAcceptSecrets: env.acceptSecrets,
    },
    tradeSql,
  )

  let started = false
  const runners = planes.map((plane) => {
    const reschedule = rescheduleRecurring(plane.queue, logger)
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

    registerHandlers(runner, {
      sql: plane.db,
      queue: plane.queue,
      logger,
      signingSecret: env.outboxSigningSecret,
      producer: SERVICE,
      idempotencyTtlDays: IDEMPOTENCY_TTL_DAYS,
      tick: {
        sql: plane.db,
        ledger,
        pricing,
        clock: systemClock,
        logger: logger.child({ job: 'bot.tick' }),
        producer: SERVICE,
        liveEnabled: env.liveEnabled,
      },
      fees: {
        sql: plane.db,
        ledger,
        clock: systemClock,
        logger: logger.child({ job: 'bot.settle' }),
        periodSeconds: env.settlementPeriodSeconds,
      },
      // Not gated on `env.exchangeEnabled`, deliberately — see the file header and `./jobs.ts`.
      exchange: { clock: systemClock, ledger },
    })
    return runner
  })

  return {
    routes,
    probes: [
      postgresProbe(`postgres-${MODULE_LABEL}`, (signal) =>
        // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignores
        // the signal would hang `/readyz` for ever. Racing the signal here is what turns "the
        // database is not answering" into a fail rather than a hung readiness endpoint.
        Promise.race([
          sql`select 1`,
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
          }),
        ]),
      ),
      // Module-prefixed NAMES. `/readyz` now reports seventeen modules' probes in one document and
      // several of them watch the same peers; an unqualified `ledger` there names a check but not
      // which module's view of it failed, which is the question an operator is actually asking.
      httpProbe(`${MODULE_LABEL}-ledger`, `${env.ledgerUrl}/livez`, { kind: 'soft' }),
      httpProbe(`${MODULE_LABEL}-pricing`, `${env.pricingUrl}/livez`, { kind: 'soft' }),
      httpProbe(`${MODULE_LABEL}-billing`, `${env.billingUrl}/livez`, { kind: 'soft' }),
    ],
    beforeScrape: async () => {
      // Per network. Summed across both queues the gauge reads healthy while one estate's backlog
      // grows for ever — micro-org#398 in another form. On the labelled VIEW, because
      // `jobs_pending` and `jobs_overdue` carry no `kind` and would otherwise be overwritten by
      // whichever module sampled last.
      for (const plane of planes) {
        const stats = await plane.queue.stats()
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network })
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network })
      }
    },
    start: async () => {
      started = true
      // Seeded into EVERY queue: an estate with no recurring sweep is half-running, not dormant.
      for (const plane of planes) await seedRecurring(plane.queue)
      for (const runner of runners) runner.start()
    },
    stop: async () => {
      started = false
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
 * module's `env` and cannot come into possession of a DSN it has no other reason to hold.
 */
export function tradeMigrationTargets(): readonly Target[] {
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
 * HOST's, so an in-flight order placement holds the drain of the process that is actually shutting
 * down. The two probe methods throw rather than answering plausibly, so if the filter is ever
 * removed the shadowed route fails loudly instead of reporting a readiness it did not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('trade does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('trade does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
