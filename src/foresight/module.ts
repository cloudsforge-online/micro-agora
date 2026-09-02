/**
 * The foresight module: the prediction-market oracle, constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M5b (micro-deploy `docs/service-merge-plan.md`) folds foresight into agora's process as part
 * of the `platform` seed. Its database is KEPT — no schema merge — and the schema owns `inbox`,
 * `jobs`, `outbox`, `event_subscriptions` and `outbox_deliveries`, tables four other modules in this
 * process also own.
 *
 * A handler handed the wrong handle does not fail. `select … from jobs` SUCCEEDS against another
 * module's queue; `insert into outbox …` SUCCEEDS into another module's relay, where a job kind this
 * module never registered will try to deliver it. The four layers that make that unspellable are the
 * ones `./pricing/module.ts` documents: `./env.ts` imported here and nowhere above, every route
 * stamped with `RouteSpec.sql`, handlers closed over this module's deps, and no interface with a
 * parameter a foreign handle could arrive through.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THIS IS THE MOST WIRED-UP MODULE IN THE PROCESS ────────────────────────────────────────────
 *
 * foresight dials custody, the indexer, the ledger, policy, admin-api and pricing, signs and posts
 * contracts to a chain from LEASED JOBS, mirrors an on-chain pool, and settles custodial stakes in
 * the ledger. Every one of those clients is reproduced here from `./env.ts` + `./upstreams.ts`,
 * because EACH MODULE KEEPS ITS OWN — a shared client would be a shared credential (SD-05), and a
 * shared credential is a fault that spans modules. The upstream is built ONCE (its service-token
 * provider holds one live token for the process); the two job PLANES are built per network, because
 * `resolution.post`'s lease key is half `(chain, network)` and one shared queue would let a mainnet
 * resolution suppress a testnet one as a duplicate.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type { Verifier } from '@cloudsforge/auth'
import type { Lifecycle, Probe } from '@cloudsforge/lifecycle'
import { postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, type Metrics } from '@cloudsforge/telemetry'
import type { Network } from '@cloudsforge/http'
import type { RouteSpec } from '../kernel.ts'
import type { InboundOutcome, InboundSink } from '../inboundsink.ts'
import { eraseEveryPlane, planeTotals } from '../erasureplanes.ts'
import { USER_DELETED_TOPIC, eraseSubject } from './erasure.ts'
import { withInbox } from './outbox.ts'

/** The uuid `identity` sends in `payload.userId`. Anchored, so a longer string is not a match. */
const ERASURE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
import type { Target } from '../migratortargets.ts'
import { SERVICE, env } from './env.ts'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { CATEGORY_VERSION } from './categories.ts'
import { mountableRoutes, registerServiceMetrics, type ServerDeps } from './server.ts'
import { recurringJobs, registerHandlers, rescheduleRecurring, seedRecurring, type JobDeps } from './jobs.ts'
import { createRelay } from './outbox.ts'
import { buildUpstreams } from './upstreams.ts'
import { createProposer } from './proposer.ts'
import { rpcRouter, type DeployDeps } from './deploy.ts'
import { httpSourceProbe, type ResolveDeps } from './resolve.ts'
import type { MirrorDeps } from './mirror.ts'
import type { ChainId } from './chains.ts'
import type { Db } from './outbox.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS MODULE COLLIDES WITH THREE OTHERS ON `outbox.relay`.** agora, devplatform, pricing, studio
 * and this module all register a kind spelled exactly `outbox.relay`, so
 * `jobs_failed_total{kind="outbox.relay"}` would be the sum of several unrelated relays without a
 * `module` label. `jobs_pending` and `jobs_overdue` are worse still, because they carry no `kind` at
 * all: each module's sample would OVERWRITE the others' on every scrape, so a wedged queue is ABSENT
 * from the graph rather than high — and `deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue`
 * alerts on exactly that gauge. So every job series this module writes goes through the labelled
 * view below, and per NETWORK, because this deployment holds a queue per estate.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'foresight'

/** The chain foresight proposes, deploys and resolves markets on. */
const CHAIN: ChainId = 'ember'

/** What the host process supplies. Deliberately nothing this module could hide a handle inside. */
export interface HostRuntime {
  /** The process-wide registry — the object the host's `/metrics` renders, not a view of it. */
  readonly metrics: Metrics
  /** The host's identity verifier. ONE JWKS client for the process; every module reads it. */
  readonly verifier: Verifier
  /** The host `Lifecycle`'s `claimingJobs`. A drain must stop claiming in EVERY module at once. */
  claimingJobs(): boolean
  /** The host `Lifecycle`'s `track`. An in-flight write holds the drain of the process that owns it. */
  track(): () => void
}

/** What the host process gets back. **No field here names a database handle.** */
export interface ForesightModule {
  readonly routes: readonly RouteSpec<Db>[]
  /** This module's half of the host's one event webhook. See the value for why it is not a route. */
  readonly inbound: InboundSink
  /**
   * The readiness probes for THIS module.
   *
   * ONE, and hard: a merged `/readyz` that probed only agora's database would answer 200 while every
   * market read, stake intent and administered resolution was failing. The upstreams (custody, the
   * indexer, the ledger, policy, pricing) are NOT here — they were SOFT in the standalone and are
   * dropped in the merged process, because policy already fails closed per request and the others
   * being down is a state this module is designed to keep serving through; a soft http probe per
   * upstream × twelve modules would also multiply this pod's readiness traffic into the very
   * services it can least afford to amplify a fault in.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the foresight half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take eleven others down for a foresight fault at a point where the host
 * has a logger and a `fatal` line to write.
 */
export async function createForesightModule(host: HostRuntime): Promise<ForesightModule> {
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)

  // The proposer, unconfigured-is-a-supported-mode. Built before the boot line so it can be reported.
  const proposer = createProposer({
    searchUrl: env.searchUrl,
    searchToken: env.searchToken,
    proposerUrl: env.proposerUrl,
    proposerToken: env.proposerToken,
    modelId: env.proposerModelId,
    deadlineMs: env.proposerDeadlineMs,
  })

  logger.info('starting', {
    version: env.version,
    schemaVersion: SCHEMA_VERSION,
    categoryVersion: CATEGORY_VERSION,
    network: env.network,
    rpcConfigured: Boolean(env.rpcUrls[CHAIN]),
    proposerConfigured: proposer.configured,
  })

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
  // database and its own queue under the other estate's name, and then refuses — or DIES — on every
  // request the gateway correctly stamped. foresight was the first service to crash on this, three
  // times. `./ownnetwork.test.ts` reads THIS file.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

  // ── ONE QUEUE PER NETWORK ────────────────────────────────────────────────────────────────────
  //
  // An enqueue is a WRITE, and a resolution job is the most consequential one this module makes: it
  // posts an outcome to a chain. `resolutionLeaseKey(chain, network)` is half the key that stops two
  // replicas posting the same resolution, so one shared queue would let a mainnet job suppress a
  // testnet one as a duplicate. `leaseMs` is longer than the default because a deploy job holds its
  // lease across a node round trip, a custody round trip and a broadcast.
  const queueFor = (handle: typeof sql): JobQueue =>
    new JobQueue(handle as unknown as JobsSql, { owner: env.instanceId, leaseMs: 120_000 })

  /** One plane per network: pool, handle, queue. Nothing crosses between two. */
  const planes = [
    { network: ownNetwork, pool: sql, db: sql as unknown as Db, queue: queueFor(sql) },
    ...(sqlTestnet && ownNetwork !== 'testnet'
      ? [
          {
            network: 'testnet' as const,
            pool: sqlTestnet,
            db: sqlTestnet as unknown as Db,
            queue: queueFor(sqlTestnet),
          },
        ]
      : []),
  ]
  const planeFor = (network: 'mainnet' | 'testnet') => {
    const plane = planes.find((p) => p.network === network)
    if (!plane) throw new Error(`no plane for network ${network}`)
    return plane
  }

  try {
    for (const plane of planes) {
      await assertSchemaAtLeast(plane.pool as unknown as DbSql, SCHEMA_VERSION)
    }
  } catch (err) {
    await close()
    throw err
  }

  const foresightSql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  )

  // ── THE UPSTREAMS, BUILT ONCE ──────────────────────────────────────────────────────────────
  //
  // The credential is EXCHANGED, not read once: this module's custody, indexer, ledger, policy and
  // admin-api calls come from leased jobs that run for ever, so a static 600s token would present a
  // dead credential from minute ten and the 401 would name the wrong service. Built once so both
  // estates' jobs go through one provider holding one live token — see `upstreams.ts`.
  const upstreams = buildUpstreams(env, {
    originatingService: SERVICE,
    onEvent: (event) => {
      metrics.increment('foresight_service_token_events_total', { kind: event.kind })
      if (event.kind === 'minted') {
        logger.info('minted a service token from the credential', {
          service: event.service,
          expiresIn: event.expiresIn,
          refreshInMs: event.refreshInMs,
        })
      } else if (event.kind === 'exchange_failed') {
        logger.warn('service credential exchange failed', { ...event })
      }
    },
  })
  const { custody, indexer, ledger, policy, pricing } = upstreams

  if (upstreams.mode === 'none') {
    logger.fatal('NO CREDENTIAL AT ALL — every deploy, resolution, fee report and stake intent will fail', {
      remedy: 'set FORESIGHT_IDENTITY_CREDENTIAL (long-lived, cfsc_…, from POST /service-credentials)',
    })
  } else if (upstreams.mode === 'static') {
    logger.fatal('EXPIRING TOKEN, NOT A CREDENTIAL — every upstream call will 401 about ten minutes from now', {
      whatWillHappen:
        'FORESIGHT_SERVICE_TOKEN lives 600s and nothing can renew it. market.deploy and resolution.post ' +
        'run every 15s from a leased job, so from minute ten custody refuses every signature and the log ' +
        'will say custody refused or custody was unavailable, which is NOT the cause.',
      remedy: 'set FORESIGHT_IDENTITY_CREDENTIAL in the deploy; estate-bootstrap.sh section 5b already mints it',
    })
  }

  const rpc = rpcRouter(env.rpcUrls, env.rpcDeadlineMs)
  const bounds = { minGasPriceWei: env.minGasPriceWei, maxGasPriceWei: env.maxGasPriceWei }
  const sourceProbe = httpSourceProbe(env.upstreamDeadlineMs)

  // The deploy/resolve/mirror worker deps, per network. `network` selects the CHAIN a market
  // contract is deployed to and the custody key that signs it — one worker per network, each closed
  // over its own handle and its own network, is the only shape where a testnet market cannot deploy
  // against mainnet.
  const deployFor = (handle: Db, network: 'mainnet' | 'testnet'): DeployDeps => ({
    sql: handle,
    producer: SERVICE,
    owner: env.instanceId,
    network,
    custody,
    rpc,
    bounds,
    gasLimit: env.deployGasLimit,
    treasuryAddress: env.treasuryAddress,
    oracleAddress: env.oracleAddress,
    leaseMs: 120_000,
    stuckMs: env.stuckMinutes * 60_000,
    enabled: env.deploysEnabled,
    logger: logger.child({ component: 'deploy', network }),
    metrics,
  })

  const resolveFor = (handle: Db): ResolveDeps => ({
    sql: handle,
    owner: env.instanceId,
    custody,
    rpc,
    bounds,
    gasLimit: env.resolveGasLimit,
    oracleAddress: env.oracleAddress,
    oracleUserId: env.oracleUserId,
    oracleOrderId: env.oracleOrderId,
    leaseMs: 120_000,
    enabled: env.deploysEnabled,
    logger: logger.child({ component: 'resolve' }),
    metrics,
  })

  const mirrorFor = (handle: Db): MirrorDeps => ({
    sql: handle,
    indexer,
    pageSize: 100,
    logger: logger.child({ component: 'mirror' }),
    metrics,
  })

  // ── ROUTES ─────────────────────────────────────────────────────────────────────────────────
  //
  // `foresightSql` is the SELECTOR, not a handle — routes use `ctx.sql`, resolved once per request.
  // The boot-time `queue`/`network` are replaced per request by `forRequest` inside `server.ts`.
  const deps: ServerDeps = {
    sql: foresightSql,
    singleNetwork: ownNetwork,
    queue: planeFor(ownNetwork).queue,
    queueFor: (network) => planeFor(network).queue,
    verifier: host.verifier,
    lifecycle: hostLifecycle(host),
    logger,
    metrics,
    policy,
    sourceProbe,
    producer: SERVICE,
    chain: CHAIN,
    network: env.network,
    defaultFeeBps: env.defaultFeeBps,
    defaultDisputeWindowSeconds: env.defaultDisputeWindowSeconds,
    houseAddress: env.houseAddress,
    engagementPolicies: upstreams.engagementPolicies,
    pricing,
    ledger,
    custodialAddress: env.custodialAddress,
    studioPublicUrl: env.studioPublicUrl,
  }
  const routes = mountableRoutes(deps, foresightSql)

  // ── ONE RUNNER PER NETWORK ──────────────────────────────────────────────────────────────────
  //
  // Bulkheaded, and here that is not tidiness: `deploy.network` and `jobDeps.network` select the
  // CHAIN a market contract is deployed to and an outcome posted to. One runner over one queue would
  // have every testnet market resolving against mainnet. The re-arm is off the runner's `completed`
  // event, never a self-enqueue from inside a handler — `jobs.ts` names that trap and this is its
  // fix. There is no `setInterval` in this module; CI greps for one.
  let started = false
  const runners = planes.map((plane) => {
    const scheduleFor = { chain: CHAIN, network: plane.network, proposeEveryMinutes: env.proposeEveryMinutes }
    const jobDeps: JobDeps = {
      sql: plane.db,
      queue: plane.queue,
      producer: SERVICE,
      network: plane.network,
      chain: CHAIN,
      logger,
      metrics,
      proposer,
      proposalBatchSize: env.proposerBatchSize,
      proposeEveryMinutes: env.proposeEveryMinutes,
      deploy: deployFor(plane.db, plane.network),
      resolve: resolveFor(plane.db),
      mirror: mirrorFor(plane.db),
      ledger,
    }
    const reschedule = rescheduleRecurring(plane.queue, logger, scheduleFor)
    const runner = new JobRunner({
      queue: plane.queue,
      concurrency: 4,
      pollMs: env.jobPollMs,
      shouldClaim: () => started && host.claimingJobs(),
      onEvent: (event) => {
        if (event.kind) {
          const labels = { kind: event.kind, network: plane.network }
          // The labelled VIEW, not the registry: several modules register `outbox.relay`, and the
          // level gauges carry no `kind` at all — sampled on the registry each module would overwrite
          // the others'.
          if (event.type === 'claimed') jobMetrics.increment('jobs_claimed_total', labels)
          if (event.type === 'completed') jobMetrics.increment('jobs_completed_total', labels)
          if (event.type === 'failed') jobMetrics.increment('jobs_failed_total', labels)
          if (event.type === 'dead') jobMetrics.increment('jobs_dead_total', labels)
          if (event.durationMs !== undefined) jobMetrics.observe('jobs_duration_ms', event.durationMs, labels)
        }
        if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
          logger.error('job failure', { ...event, network: plane.network })
        }
        reschedule(event)
      },
    })
    registerHandlers(
      jobDeps,
      createRelay({
        sql: plane.db,
        logger: logger.child({ component: 'relay', network: plane.network }),
        signingSecret: env.outboxSigningSecret,
      }),
      (kind, handler) => runner.register(kind, handler),
    )
    return { runner, queue: plane.queue, schedule: scheduleFor }
  })

  return {
    routes,
    /**
     * This module's half of the process's ONE event webhook.
     *
     * Same argument as studio's: foresight has no `POST /v1/events`, verifies with the estate-wide
     * `OUTBOX_SIGNING_SECRET` the square's route already checked, and subscribes to the same topic
     * — so `MOUNTED_EVENT_PATHS`'s condition (ONE KEY, NOT THREE) is met and the fan-out is the
     * honest shape rather than a shortcut (micro-org#534).
     */
    inbound: {
      module: MODULE_LABEL,
      topics: new Set([USER_DELETED_TOPIC]),
      deliver: async (
        _network: Network,
        topic: string,
        eventId: string,
        payload: Record<string, unknown>,
      ): Promise<InboundOutcome> => {
        if (topic !== USER_DELETED_TOPIC) return { status: 'processed' }
        const named = typeof payload['userId'] === 'string' ? payload['userId'] : ''
        const bare = named.startsWith('user:') ? named.slice('user:'.length) : named
        if (!ERASURE_UUID.test(bare)) {
          return { status: 'rejected', reason: `${USER_DELETED_TOPIC} requires a uuid userId` }
        }
        // EVERY plane, from THIS MODULE'S selector; `_network` is deliberately unused on this
        // topic (micro-org#474, `../erasureplanes.ts`).
        const sweep = await eraseEveryPlane(foresightSql, (handle: Db) =>
          withInbox(handle, topic, eventId, (tx) => eraseSubject(tx, `user:${bare}`)),
        )
        if (sweep.processed === 0) return { status: 'duplicate' }
        // Counts only. The subject is never logged — it is what we were asked to forget.
        return { status: 'processed', detail: planeTotals(sweep) }
      },
    },
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

        // How many of the recurring jobs actually exist right now. The series exists because this
        // module's schedule once died silently — every handler re-enqueued its own `(kind, key)` and
        // the runner deleted it, so `jobs` was empty ten minutes after boot and `jobs_pending: 0`
        // could not report it. `present < expected` can, because it is a comparison. Per NETWORK,
        // because the two planes hold two `jobs` tables and one would otherwise overwrite the other.
        const expected = recurringJobs({
          chain: CHAIN,
          network: plane.network,
          proposeEveryMinutes: env.proposeEveryMinutes,
        })
        const present = await plane.pool<{ n: number }[]>`
          select count(*)::int as n
            from jobs j
            join unnest(${expected.map((job) => job.kind)}::text[], ${expected.map((job) => job.key)}::text[])
              as wanted(kind, key)
              on wanted.kind = j.kind and wanted.key = j.key
        `
        metrics.set('foresight_jobs_recurring_present', present[0]?.n ?? 0, { network: plane.network })
        metrics.set('foresight_jobs_recurring_expected', expected.length, { network: plane.network })
      }

      // Process-wide, not per plane: one credential provider serves the whole module, so these are
      // sampled once and carry no `network`. `static` counts as usable because it is — for about ten
      // minutes — which is exactly why it needs the second gauge beside it.
      metrics.set(
        'foresight_service_token_usable',
        upstreams.mode === 'exchanged'
          ? (upstreams.identityTokens?.snapshot().hasUsableToken ?? false)
            ? 1
            : 0
          : upstreams.mode === 'static'
            ? 1
            : 0,
      )
      metrics.set('foresight_service_token_static', upstreams.mode === 'static' ? 1 : 0)
    },
    start: async () => {
      started = true
      // Seeded into EVERY queue before any runner claims, so N replicas booting together produce one
      // pending run of each recurring job rather than N.
      for (const r of runners) await seedRecurring(r.queue, r.schedule)
      for (const r of runners) r.runner.start()
    },
    stop: async () => {
      started = false
      const clean = (await Promise.all(runners.map((r) => r.runner.stop(20_000)))).every(Boolean)
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
export function foresightMigrationTargets(): readonly Target[] {
  const common = { module: SERVICE, migrations: MIGRATIONS, baselineVersion: BASELINE_VERSION } as const
  return [
    { ...common, network: 'primary', url: env.databaseUrl },
    ...(env.databaseUrlTestnet ? [{ ...common, network: 'testnet', url: env.databaseUrlTestnet }] : []),
  ]
}

/**
 * The `Lifecycle` shape `server.ts` demands, with the two dead probe handlers refusing.
 *
 * `/livez` and `/readyz` are filtered out of the mounted table; nothing else in this module's routes
 * touches `lifecycle`. The two probe methods throw rather than answering plausibly, so if the filter
 * is ever removed the shadowed route fails loudly instead of reporting a readiness it did not
 * compute. `track` is the HOST's, so an in-flight write holds the drain of the process shutting down.
 */
function hostLifecycle(host: HostRuntime): Lifecycle {
  return {
    livez: () => {
      throw new Error('foresight does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('foresight does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as Lifecycle
}
