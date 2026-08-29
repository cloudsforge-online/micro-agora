/**
 * The worlds module: the game platform and the entitlement bridge, constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M5b (micro-deploy `docs/service-merge-plan.md`) folds worlds into agora's process. All
 * databases are KEPT — no schema merge — and this schema owns `inbox`, `jobs`, `outbox`,
 * `event_subscriptions` and `outbox_deliveries`, every one of which exists under the same name in
 * the other merged modules' schemas.
 *
 * A handler handed the wrong handle does not fail. `select … from jobs` SUCCEEDS against another
 * module's queue; `insert into outbox …` SUCCEEDS into another module's relay, where a job kind
 * this module never registered will try to deliver it; `insert into inbox …` dedupes an
 * entitlement grant this database has never seen. The four layers that make that unspellable are
 * the ones `../pricing/module.ts` documents: `./env.ts` imported here and nowhere above, every
 * route stamped with `RouteSpec.sql` by `mountableRoutes`, handlers closed over this module's deps,
 * and no interface with a parameter a foreign handle could arrive through.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE THING THIS MODULE BRINGS THAT MOST OTHERS DO NOT: IT POSTS TO THE LEDGER ───────────────
 *
 * A reward is a ledger posting (`ledgerclient.ts`, `rewards.ts`), so a game exploit that mints
 * rewards is a MONEY incident. The cap that makes that survivable — the season budget checked in
 * the same transaction as the posting — is unchanged by this merge; it is a database CHECK plus the
 * `WORLDS_SEASON_REWARD_BUDGET_WEI` default, and this file only carries the pool it runs against.
 *
 * This module keeps its OWN upstream clients — `ledgerclient.ts`, `billingclient.ts`,
 * `titleclient.ts` — and its OWN credential (`WORLDS_IDENTITY_CREDENTIAL`), because each merged
 * module authenticates as itself and each peer checks the scope it cares about. The clients are
 * built once, from `./env.ts` and `./upstreams.ts`, and shared across both network planes: they
 * carry no per-network state, only a bearer and a deadline.
 *
 * ── THE JOB PLANES, ONE PER NETWORK, NEVER SHARED ──────────────────────────────────────────────
 *
 * `outbox.relay` collides by name with the other merged modules', so a shared runner is impossible
 * (`@cloudsforge/jobs`' `register()` throws on the second `outbox.relay`) and, worse, would be
 * silent if it did not: N runners counting `kind="outbox.relay"` into an unlabelled registry sum
 * into one series. Every job metric here therefore goes through `jobMetrics` — a `module`-labelled
 * VIEW — and the two unlabelled gauges `jobs_pending` / `jobs_overdue` additionally carry
 * `network`, or each plane's sample would OVERWRITE the other's and a wedged queue would read as
 * ABSENT rather than high (`deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue`).
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
import { buildUpstreams } from './upstreams.ts'
import type { ProvisionDeps } from './provisioning.ts'
import type { RewardDeps } from './rewards.ts'
import type { Db } from './outbox.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS MODULE COLLIDES WITH THE OTHER MERGED MODULES ON `outbox.relay`.** `jobs_failed_total{
 * kind="outbox.relay"}` would be the sum of several unrelated relays without a `module` label — a
 * number that still moves and that an alert still fires on. `jobs_pending` and `jobs_overdue` are
 * worse still, carrying no `kind` at all, so each module's sample OVERWRITES the others' on every
 * scrape unless it is stamped. `provision.deliver`, `provision.sweep` and this module's domain
 * gauges (`worlds_*`) collide with nothing, but the job counters share the estate-wide names.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'worlds'

/** What the host process supplies. Deliberately nothing this module could hide a handle inside. */
export interface HostRuntime {
  /** The process-wide registry — the object the host's `/metrics` renders, not a view of it. */
  readonly metrics: Metrics
  /** The host's identity verifier. ONE JWKS client for the process; every module reads it. */
  readonly verifier: PrincipalVerifier
  /** The host `Lifecycle`'s `claimingJobs`. A drain must stop claiming in EVERY module at once. */
  claimingJobs(): boolean
  /** The host `Lifecycle`'s `track`. An in-flight provisioning write holds the drain of the process. */
  track(): () => void
}

/** What the host process gets back. **No field here names a database handle.** */
export interface WorldsModule {
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module.
   *
   * `postgres-worlds` is HARD: a merged `/readyz` that probed only agora's database would answer
   * 200 while every profile, inventory, provision and reward on this database was failing.
   *
   * `ledger` and `billing` are SOFT, deliberately. Marking either HARD would take the whole merged
   * pod — every module beside this one — out of the balancer for the duration of somebody else's
   * incident, and this module must instead keep serving what it can (profiles fail OPEN) and, above
   * all, keep DRAINING the provisioning backlog. This mirrors agora's own decision to keep `policy`
   * soft (`../index.ts`).
   *
   * The standalone's `identity-credential` probe (`serviceTokenProbe`, hard) is deliberately NOT
   * here. It fails only when `WORLDS_IDENTITY_CREDENTIAL` is unset, and a hard failure there would
   * take all twelve modules unready for ONE module's missing credential — the same cascade the soft
   * upstream probes above avoid, and the reason agora dropped its own credential probe for an
   * `agora_service_token_usable` gauge and a boot line. The absence is still named at boot below,
   * and every upstream call fails closed 503 rather than being sent unauthenticated.
   *
   * The standalone's `identity-jwks` probe is also omitted: the host already probes the same
   * `IDENTITY_JWKS_URL` softly under that exact name, and two identical rows in one readiness report
   * is one more thing to keep in step.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the worlds half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take the others down for a worlds fault at a point where the host has a
 * logger and a `fatal` line to write.
 */
export async function createWorldsModule(host: HostRuntime): Promise<WorldsModule> {
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', {
    version: env.version,
    schemaVersion: SCHEMA_VERSION,
    provisioningEnabled: env.provisioningEnabled,
    // Said at boot, because a bridge that is switched off looks exactly like a bridge that is broken
    // until somebody reads the environment.
    seasonRewardBudgetWei: env.seasonRewardBudgetWei.toString(),
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
  // database and its own queue under the other estate's name, and then refuses every request the
  // gateway correctly stamped. `./ownnetwork.test.ts` reads THIS file.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

  // The upstreams, and the credential that authenticates every call to them. Built ONCE and shared
  // across both planes — they carry no per-network state, only a bearer and a deadline. See
  // `./upstreams.ts` and `./servicetoken.test.ts` for why this wiring lives in a module a test can
  // reach rather than in a composition root a test cannot.
  const { identityTokens, ledger, billing, titles } = buildUpstreams(env, {
    originatingService: SERVICE,
    onEvent: (event) => {
      if (event.kind === 'exchange_failed') {
        // `warn`, not `error`, while a usable token is still held: the 20% slack after the refresh
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
    // Not fatal: the image must be able to boot without this so CI's startup smoke test can read
    // `/livez`. In the merged process there is no hard probe to enforce the absence (see the module
    // header), so it is enforced by every upstream call failing closed 503 rather than being sent
    // unauthenticated — and named here so an operator can find it.
    logger.error('WORLDS_IDENTITY_CREDENTIAL is not set; every call to a peer will fail 503', {
      hint: 'deploy/scripts/estate-bootstrap.sh writes it to compose/estate/tokens.env',
    })
  }
  if (env.legacyServiceTokenPresent) {
    logger.error('WORLDS_SERVICE_TOKEN is set and is IGNORED', {
      hint: 'it was a 600-second token read once at boot; WORLDS_IDENTITY_CREDENTIAL replaces it',
    })
  }

  // The QUEUE is per-network as much as the pool is. An enqueue is a WRITE, and a job claimed by a
  // runner holding the other estate's handle applies to the other estate's rows and leaves a
  // completed row behind saying it went exactly as intended. The 120-second lease is this module's
  // own: a provisioning job holds its lease across a title call that writes thousands of rows, and
  // the claim is what makes two deliveries of one entitlement impossible.
  const queueOver = (handle: typeof sql): JobQueue =>
    new JobQueue(handle as unknown as JobsSql, { owner: env.instanceId, leaseMs: 120_000 })

  const provisionFor = (db: Db): ProvisionDeps => ({
    sql: db,
    producer: SERVICE,
    owner: env.instanceId,
    titles,
    leaseMs: 120_000,
    // After this many attempts a provision stops being retried and an operator is told.
    maxAttempts: 5,
    enabled: env.provisioningEnabled,
    logger: logger.child({ component: 'provisioning' }),
    metrics,
  })

  /** The whole per-network plane: pool, handle, queue, provisioner, reward deps. Nothing crosses. */
  const planes = [
    { network: ownNetwork, pool: sql, db: sql as unknown as Db },
    ...(sqlTestnet && ownNetwork !== 'testnet'
      ? [{ network: 'testnet' as const, pool: sqlTestnet, db: sqlTestnet as unknown as Db }]
      : []),
  ].map((plane) => ({
    ...plane,
    queue: queueOver(plane.pool),
    provision: provisionFor(plane.db),
    rewards: { sql: plane.db, ledger, producer: SERVICE } as RewardDeps,
  }))

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

  const worldsSql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  )

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      // The SELECTOR, not a handle — routes read `ctx.sql`, resolved once per request.
      sql: worldsSql,
      // The fallback for a request with no `CF-Network` header — which is EVERY service-to-service
      // call, because those go container to container and never reach the gateway that stamps one.
      singleNetwork: ownNetwork,
      producer: SERVICE,
      // Boot-time values; the module's own `forRequest` in `server.ts` replaces both with this
      // request's network before any route sees them. A reward granted or a job enqueued against the
      // wrong handle is a write that succeeds against the other estate's ledger.
      rewards: planeFor(ownNetwork).rewards,
      rewardsFor: (network) => planeFor(network).rewards,
      billing,
      queue: planeFor(ownNetwork).queue,
      queueFor: (network) => planeFor(network).queue,
      // Every key billing's relay may have signed with, newest first. See the header of `server.ts`:
      // an unsigned provisioning webhook is a free-worlds endpoint.
      eventAcceptSecrets: env.outboxAcceptSecrets,
    },
    worldsSql,
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
          // EVERY line through the labelled view. `network` distinguishes this runner from the other
          // PLANE, never from the other MODULE — the other merged modules register `outbox.relay`.
          const labels = { kind: event.kind, network: plane.network }
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
    registerHandlers(runner, {
      sql: plane.db,
      logger,
      // The VIEW, per plane: the sweep sets `worlds_provisions_outstanding`, whose name collides
      // with nothing but which two planes would otherwise overwrite under one series.
      metrics: jobMetrics.withLabels({ network: plane.network }),
      signingSecret: env.outboxSigningSecret,
      provision: plane.provision,
      queue: plane.queue,
      sweepLimit: 100,
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
      // SOFT, both. A ledger or billing outage must not remove the whole merged pod from rotation:
      // this module keeps serving profiles and inventories (which fail OPEN), keeps the entitlement
      // webhook answering, and above all keeps DRAINING the provisioning backlog. Making either hard
      // would turn somebody else's incident into an outage of eleven working modules.
      httpProbe('ledger', `${env.ledgerUrl}/livez`, { kind: 'soft' }),
      httpProbe('billing', `${env.billingUrl}/livez`, { kind: 'soft' }),
    ],
    beforeScrape: async () => {
      // Per network. Summed across both queues the gauge reads healthy while one estate's backlog
      // grows for ever. The VIEW, because `jobs_pending`/`jobs_overdue` carry no `kind` and the
      // merged modules would otherwise erase each other every scrape.
      for (const plane of planes) {
        const stats = await plane.queue.stats()
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network })
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network })
      }
    },
    start: async () => {
      started = true
      // Seeded into EVERY queue: a testnet estate with no recurring sweep is a half-running
      // platform, not a dormant one.
      for (const plane of planes) await seedRecurring(plane.queue)
      for (const runner of runners) runner.start()
    },
    stop: async () => {
      started = false
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
 * module's `env` and cannot come into possession of a DSN it has no other reason to hold.
 */
export function worldsMigrationTargets(): readonly Target[] {
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
 * HOST's, so an in-flight provisioning or reward write holds the drain of the process that is
 * actually shutting down. The two probe methods throw rather than answering plausibly, so if the
 * filter is ever removed the shadowed route fails loudly instead of reporting a readiness it did
 * not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('worlds does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('worlds does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
