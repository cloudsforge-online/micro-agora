/**
 * The devplatform module: the developer portal's API, constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M5a (micro-deploy `docs/service-merge-plan.md`) folds devplatform into agora's process as
 * part of the `platform` seed. All five databases are KEPT — no schema merge — and the five
 * schemas own `inbox` and `jobs` in ALL FIVE, with `outbox`, `event_subscriptions` and
 * `outbox_deliveries` in four including this one.
 *
 * A handler handed the wrong handle does not fail. `insert into inbox …` SUCCEEDS against another
 * module's inbox and dedupes an event this database has never seen; `insert into outbox …`
 * SUCCEEDS into another module's relay. The four layers that make that unspellable are the ones
 * `./policy/module.ts` documents, and layer 2 — `RouteSpec.sql` stamped over the whole table by
 * `mountableRoutes` — is the one `../merged.test.ts` goes red on.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE THING THIS MODULE BRINGS THAT NO OTHER MODULE DOES: ITS OWN INBOUND SECRET ─────────────
 *
 * `DEVPLATFORM_INGEST_SECRETS` is a variable of this module's own. It is REQUIRED at boot, it is a
 * LIST so a rotation has an overlap, and it is NOT `OUTBOX_SIGNING_SECRET` — which this module also
 * reads, for the opposite direction, to SIGN what its relay delivers to customers' endpoints.
 *
 * That single fact is why the merged process cannot do what emberkin's does. There, one route
 * verifies once and fans out to every module that subscribes, and it is honest only because every
 * module reads the same estate-wide key. Here, agora, policy and this module each mount
 * `POST /v1/events` with a DIFFERENT verifier, so one route would mean one key silently deciding
 * for three. `MOUNTED_EVENTS_PATH` in `./server.ts` carries the split and the reasoning; the bare
 * path answers 410 in the merged process so a subscription row nobody re-pointed fails LOUDLY in
 * the producer's `outbox_deliveries.last_error` rather than erasing one database out of three.
 *
 * ── AND ONE IT DOES NOT BRING: A CREDENTIAL ───────────────────────────────────────────────────
 *
 * This module holds no service token and no `cfsc_` credential. Its only peer is identity, dialled
 * through `identityMembership` at the ISSUER's origin, forwarding the CALLER's own bearer — there
 * is deliberately no break-glass token in its `env.ts` and this merge does not add one. So the
 * merged process's reach does not widen by a single peer on this module's account.
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
import {
  mountableRoutes,
  registerServiceMetrics,
  scrapeRefresh,
  type PrincipalVerifier,
} from './server.ts'
import {
  registerHandlers,
  rescheduleRecurring,
  sampleDeliveries,
  sampleQueue,
  seedRecurring,
} from './jobs.ts'
import { identityMembership } from './membership.ts'
import type { Db } from './outbox.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS MODULE COLLIDES WITH THREE OTHERS ON `outbox.relay`.** Measured in
 * `../jobcomposition.test.ts` rather than asserted from memory: agora, devplatform, pricing and
 * studio all register a kind spelled exactly `outbox.relay`.
 *
 * And it brings the wave's one NEAR miss, which is worth writing down where somebody will read it:
 * this module registers a kind called plainly `retention`, while policy registers
 * `policy.decisions.retention`. Four distinct strings today, so `jobs_failed_total{kind=…}`
 * separates them and nothing sums them. What WOULD sum them is a rule matching `kind=~".*retention"`
 * — a natural thing to write — which would quietly add a usage-event prune to a decision prune.
 * `../jobcomposition.test.ts` exists so the next person to write one finds the `module` label first.
 *
 * `jobs_pending` and `jobs_overdue` are the sharper case regardless of kinds: they carry none at
 * all, so each module's sample OVERWRITES the others' on every scrape and a wedged queue is ABSENT
 * from the graph rather than high. `deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue` is
 * `expr: jobs_overdue > 0`, and nobody alerts on absent.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'devplatform'

/** What the host process supplies. Deliberately nothing this module could hide a handle inside. */
export interface HostRuntime {
  /** The process-wide registry — the object the host's `/metrics` renders, not a view of it. */
  readonly metrics: Metrics
  /**
   * The host's identity verifier. ONE JWKS client for the process; every module reads it.
   *
   * Safe because `IDENTITY_JWKS_URL` and `IDENTITY_ISSUER` are estate-wide variables with one
   * value. What this module still decides for itself is what a verified principal may DO — every
   * `devplatform:*` scope check is in `./server.ts` and no host can widen it.
   */
  readonly verifier: PrincipalVerifier
  /** The host `Lifecycle`'s `claimingJobs`. A drain must stop claiming in EVERY module at once. */
  claimingJobs(): boolean
  /**
   * The host `Lifecycle`'s `track`.
   *
   * Live, and used: `POST /v1/events` holds the drain open while an erasure is in flight, and in
   * the merged process that has to be the HOST's drain or a shutdown would cut a deletion the
   * module thought it had protected.
   */
  track(): () => void
}

/** What the host process gets back. **No field here names a database handle.** */
export interface DevplatformModule {
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module.
   *
   * ONE, and hard. A merged `/readyz` that probed only agora's database would answer 200 while
   * every key issue, quota check and webhook delivery was failing, and the balancer would keep
   * sending traffic to it.
   *
   * This module's `identity` probe is deliberately NOT here: the host already probes the same
   * `IDENTITY_JWKS_URL`, softly, under the name `identity-jwks`. Two identical rows in one
   * readiness report is one more thing to keep in step, and the standalone name differed only by
   * accident.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the devplatform half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code.
 */
export async function createDevplatformModule(host: HostRuntime): Promise<DevplatformModule> {
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
  // A testnet pod that hardcodes the key holds its own database and its own queue under the other
  // estate's name and then refuses every request the gateway correctly stamped.
  // `./ownnetwork.test.ts` reads THIS file.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

  // The 120-second lease is this module's own and is not incidental: a webhook delivery holds its
  // job for a customer-controlled deadline, so a shorter lease would let a second replica claim
  // work that is still in flight and deliver the same event twice.
  const queueOver = (handle: typeof sql): JobQueue =>
    new JobQueue(handle as unknown as JobsSql, { owner: env.instanceId, leaseMs: 120_000 })

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

  const devplatformSql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  )

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      // The membership client dials identity's ORIGIN, derived from the issuer. There is no
      // separate variable for it: two URLs that must always name the same service are two URLs that
      // will one day disagree, and the failure that produces is authorisation checked against the
      // wrong estate.
      membership: identityMembership({ baseUrl: new URL(env.identityIssuer).origin }),
      sql: devplatformSql,
      singleNetwork: ownNetwork,
      producer: SERVICE,
      // THIS MODULE'S OWN INBOUND SECRETS, read from this module's own variable, reaching this
      // module's own path. See the file header for why they cannot be the host's.
      ingestSecrets: env.ingestSecrets,
      defaultQuotaPerMinute: env.defaultQuotaPerMinute,
      defaultQuotaPerMonth: env.defaultQuotaPerMonth,
      webhookRotationOverlapMinutes: env.webhookRotationOverlapMinutes,
    },
    devplatformSql,
  )

  const refresh = planes.map((plane) =>
    scrapeRefresh({ sql: plane.db, metrics, labels: { network: plane.network } }),
  )

  let started = false
  const runners = planes.map((plane) => {
    const reschedule = rescheduleRecurring(plane.queue, logger)
    const runner = new JobRunner({
      queue: plane.queue,
      concurrency: 2,
      pollMs: 1_000,
      shouldClaim: () => started && host.claimingJobs(),
      onEvent: (event) => {
        if (event.kind) {
          // EVERY line through the labelled view. `network` distinguishes this runner from the
          // other PLANE, never from the other MODULE — three other modules register
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
    registerHandlers(runner, {
      sql: plane.db,
      logger,
      metrics: jobMetrics,
      signingSecret: env.outboxSigningSecret,
      retention: {
        usageEventDays: env.usageEventRetentionDays,
        usageRollupDays: env.usageRollupRetentionDays,
      },
      webhook: {
        deadlineMs: env.webhookDeadlineMs,
        maxAttempts: env.webhookMaxAttempts,
      },
    })
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
    ],
    beforeScrape: async () => {
      for (const [i, plane] of planes.entries()) {
        await refresh[i]!()
        // The VIEW for the two unlabelled gauges — see `MODULE_LABEL` — and the network for the
        // two planes. The REGISTRY for the webhook gauges, whose names collide with nothing, but
        // still per network, because two estates' delivery backlogs are two numbers.
        await sampleQueue(plane.queue, jobMetrics, { network: plane.network })
        await sampleDeliveries(plane.db, metrics, { network: plane.network })
      }
    },
    start: async () => {
      started = true
      for (const plane of planes) await seedRecurring(plane.queue)
      for (const runner of runners) runner.start()
    },
    stop: async () => {
      started = false
      // The runners stop FIRST, so a webhook delivery in flight is allowed to finish and record
      // its attempt rather than being cut off with its pool closed under it.
      const clean = (await Promise.all(runners.map((r) => r.stop(20_000)))).every(Boolean)
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
 * module's `env` and cannot come into possession of a DSN or an ingest secret it has no other
 * reason to hold.
 */
export function devplatformMigrationTargets(): readonly Target[] {
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
 * HOST's — an erasure that holds the drain open has to hold the drain of the process that is
 * actually shutting down. The two probe methods throw rather than answering plausibly, so if the
 * filter is ever removed the shadowed route fails loudly instead of reporting a readiness it did
 * not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('devplatform does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('devplatform does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
