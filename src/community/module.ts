/**
 * The community module: governance, membership, delegation and the treasury execution path,
 * constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M5a (micro-deploy `docs/service-merge-plan.md`) folds community into agora's process. All
 * databases are KEPT — no schema merge — and every merged schema owns `inbox` and `jobs`, with
 * `outbox`, `event_subscriptions` and `outbox_deliveries` beside them in this one.
 *
 * A handler handed the wrong handle does not fail. `select … from jobs` SUCCEEDS against another
 * module's queue; `insert into outbox …` SUCCEEDS into another module's relay, where a job kind
 * this module never registered will try to deliver it. The four layers that make that unspellable
 * are the ones `./pricing/module.ts` documents: `./env.ts` imported here and nowhere above, every
 * route stamped with `RouteSpec.sql`, handlers closed over this module's deps, and no interface
 * with a parameter a foreign handle could arrive through.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHICH PROBES ARE HARD, AND WHY ─────────────────────────────────────────────────────────────
 *
 * Postgres is the only HARD probe. Nothing this module does works without it, and a merged
 * `/readyz` that probed only agora's database would answer 200 while every vote, tally and
 * administered spend on this schema was failing.
 *
 * The upstream service probes stay SOFT — identity, ledger, policy and the indexer — because every
 * read on governance (a tally, a member list, a proposal, a delegation) is served entirely from
 * this module's own tables. A ledger or policy outage stalls treasury EXECUTIONS, and that is
 * handled where it happens: the execute job fails and retries and `community_proposals_timelocked`
 * climbs. Making any of them hard would take governance — and, in the merged process, every OTHER
 * module — out of the balancer for a dependency only one code path has.
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
import {
  mountableRoutes,
  registerServiceMetrics,
  scrapeRefresh,
  type PrincipalVerifier,
} from './server.ts'
import {
  registerHandlers,
  rescheduleRecurring,
  sampleGovernance,
  sampleQueue,
  seedRecurring,
  type JobDeps,
} from './jobs.ts'
import { buildUpstreams } from './upstreams.ts'
import type { Db } from './outbox.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS MODULE COLLIDES WITH SEVERAL OTHERS ON `outbox.relay`.** agora, devplatform, pricing,
 * studio and this module all register a kind spelled exactly `outbox.relay`, so
 * `jobs_failed_total{kind="outbox.relay"}` would be the sum of unrelated relays without a `module`
 * label to keep them apart. `proposal.execute`, `proposal.transition` and `membership.recheck`
 * collide with nothing, and that matters: they are what an operator reads when a community's vote
 * has not been honoured, and they must not be summed with anything.
 *
 * `jobs_pending` and `jobs_overdue` are worse still, because they carry no `kind` at all: each
 * module's sample would OVERWRITE the others' on every scrape, so a wedged execute queue is ABSENT
 * from the graph rather than high. Both go through this labelled view with a `{ network }` label.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'community'

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
export interface CommunityModule {
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module. Postgres is hard; the upstream service probes are soft —
   * see the file header for the split and its reasoning.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the community half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take every other one down for a governance fault at a point where the
 * host has a logger and a `fatal` line to write.
 */
export async function createCommunityModule(host: HostRuntime): Promise<CommunityModule> {
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', {
    version: env.version,
    schemaVersion: SCHEMA_VERSION,
    // Said at boot, because a rotation that is half-finished looks exactly like a rotation that is
    // finished until somebody counts the secrets.
    ingestSecrets: env.ingestSecrets.length,
    // Said at boot, because "token gating is not actually running" is otherwise invisible until
    // somebody reads a metric. See gating.ts.
    tokenGating: env.indexerBaseUrl === null ? 'no indexer configured — holdings are unknown' : 'configured',
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

  // `leaseMs` is 120s rather than the package default of 60: `proposal.execute` holds its lease
  // across a policy call and a ledger call, and a lease that can expire mid-execution is a lease
  // that lets a second worker start one. `jobs.test.ts` asserts that relationship rather than the
  // number.
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

  const communitySql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  )

  // ── THE UPSTREAM CLIENTS, BUILT ONCE, EACH MODULE KEEPS ITS OWN ────────────────────────────
  //
  // One credential, presented to the ledger, to policy and to the indexer oracle — a single
  // service identity for this module, which is what SD-05's scoped service tokens are. Built once
  // and shared across planes because these clients hold NO database handle; the module boundary is
  // `RouteSpec.sql`, not this object. The wiring lives in `upstreams.ts` rather than here so a test
  // can drive `buildUpstreams` past the expiry that once let `const token = () => credential`
  // survive a green suite while the token it read had been dead for 26 hours (micro-org #222).
  const upstreams = buildUpstreams(env, {
    originatingService: SERVICE,
    onEvent: (event) => {
      metrics.increment('community_service_token_events_total', { kind: event.kind })
      if (event.kind === 'minted') {
        // The token itself is never a field here, and must never become one. `service`, `expiresIn`
        // and the refresh interval are what an operator needs; the bearer is what an attacker needs.
        logger.info('minted a service token from the credential', {
          service: event.service,
          expiresIn: event.expiresIn,
          refreshInMs: event.refreshInMs,
        })
      } else if (event.kind === 'exchange_failed') {
        // `warn`, not `fatal`, because of `hadUsableToken`: a failed exchange while a live token is
        // still held is the outage the provider is built to ride out, and paging on it would page
        // on every identity blip.
        logger.warn('service credential exchange failed', { ...event })
      }
    },
  })
  const { ledger, policy, oracle } = upstreams

  // Said at boot, at the level its consequence deserves: a governance module that looks healthy
  // while every treasury spend comes back "refused by policy" from a gate that was never asked.
  // There is NO readiness probe on this — Postgres stays the only hard probe (see the header) — so
  // the credential is said loudly here and sampled continuously as `community_service_token_usable`.
  if (upstreams.mode === 'none') {
    logger.fatal('NO CREDENTIAL AT ALL — every ledger, policy and indexer call will fail', {
      whatWillHappen:
        'no bearer is presented, so no treasury spend can post to the ledger and no spend can be ' +
        'approved. The execute job fails rather than recording a refusal, so nothing is spent while ' +
        'we cannot ask — but community_proposals_timelocked climbs for ever and no vote is honoured.',
      remedy: 'set COMMUNITY_IDENTITY_CREDENTIAL (long-lived, cfsc_…, from POST /service-credentials)',
    })
  } else if (upstreams.mode === 'static') {
    logger.fatal('EXPIRING TOKEN, NOT A CREDENTIAL — every upstream call will 401 about ten minutes from now', {
      whatWillHappen:
        'COMMUNITY_SERVICE_CREDENTIAL holds a token that lives 600s and nothing can renew it. From ' +
        'minute ten policy answers 401, policyclient.ts reads a 4xx as policy DECIDING and returns ' +
        'deny/policy_401, executions.ts raises SpendRefusedError and jobs.ts SWALLOWS it — so every ' +
        'treasury spend is permanently REFUSED, recorded against the community, and never retried.',
      remedy:
        'set COMMUNITY_IDENTITY_CREDENTIAL in the deploy; estate-bootstrap.sh already mints it into tokens.env',
    })
  } else {
    logger.info('service credential mode', { mode: upstreams.mode, identityUrl: env.identityUrl })
  }

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      sql: communitySql,
      singleNetwork: ownNetwork,
      producer: SERVICE,
      // THIS MODULE'S OWN INBOUND SECRETS, from this module's own variable, reaching this module's
      // own suffixed `/v1/events/community` path. See server.ts for why they cannot be the host's.
      ingestSecrets: env.ingestSecrets,
      // The PRIMARY plane's queue. `ServerDeps` demands one, and `POST /internal/proposals/:id/
      // enqueue-execution` is the only route that enqueues — built over the primary plane so a
      // mistake is a wrong ESTATE rather than a wrong MODULE, exactly as studio's boot-time ports
      // are. Every deployment today is single-network (COMMUNITY_DATABASE_URL_TESTNET unset), so
      // `planes[0]` is the only plane; the two-plane case would want a per-request queue selector.
      queue: planes[0]!.queue,
      execute: { ledger, policy },
    },
    communitySql,
  )

  const refresh = scrapeRefresh({ sql, metrics })

  let started = false
  const runners = planes.map((plane) => {
    const jobDeps: JobDeps = {
      sql: plane.db,
      logger,
      // The REGISTRY, not the labelled view: the handlers write DOMAIN counters
      // (`community_executions_total`, `community_gate_checks_total`) whose names are module-unique
      // and which the dashboards and alerts already name unlabelled. The relay handler writes no
      // metrics of its own, so nothing here needs the `{ module }` view — the job counters that DO
      // are written by the runner's `onEvent` below, through `jobMetrics`.
      metrics,
      queue: plane.queue,
      signingSecret: env.outboxSigningSecret,
      producer: SERVICE,
      execute: { ledger, policy },
      oracle,
      gate: {
        intervalHours: env.gateRecheckIntervalHours,
        batchSize: env.gateRecheckBatchSize,
      },
      idempotencyTtlDays: env.idempotencyTtlDays,
    }
    const reschedule = rescheduleRecurring(plane.queue, logger)
    const runner = new JobRunner({
      queue: plane.queue,
      concurrency: 2,
      pollMs: 1_000,
      shouldClaim: () => started && host.claimingJobs(),
      onEvent: (event) => {
        if (event.kind) {
          // EVERY line through the labelled view. `network` distinguishes this runner from the
          // other PLANE, never from the other MODULE — several modules register `outbox.relay` too.
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
      // HARD. Nothing in this module works without it.
      postgresProbe(`postgres-${MODULE_LABEL}`, (signal) =>
        Promise.race([
          sql`select 1`,
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
          }),
        ]),
      ),
      // SOFT. Its JWKS is cached by the verifier, so a brief outage does not stop authentication.
      httpProbe('identity', env.identityJwksUrl, { kind: 'soft' }),
      // SOFT. A ledger outage stalls treasury executions and nothing else; making it hard would
      // take every module in this process offline for one module's upstream incident.
      httpProbe('ledger', `${env.ledgerBaseUrl}/livez`, { kind: 'soft' }),
      // SOFT. Policy is on the execution path only — same reasoning, more strongly.
      httpProbe('policy', `${env.policyBaseUrl}/livez`, { kind: 'soft' }),
      // SOFT, and only when configured. An unknown holding never demotes anybody (gating.ts), so an
      // indexer outage degrades token gating to "not re-checked" rather than "everybody evicted".
      ...(env.indexerBaseUrl !== null
        ? [httpProbe('indexer', `${env.indexerBaseUrl}/livez`, { kind: 'soft' })]
        : []),
    ],
    beforeScrape: async () => {
      await refresh()
      for (const plane of planes) {
        // The VIEW, not the registry. `jobs_pending` and `jobs_overdue` carry no `kind`, so this is
        // where the modules would otherwise erase each other every scrape. Per network as well,
        // because summed across both planes the gauge reads healthy while one estate's backlog grows.
        const stats = await plane.queue.stats()
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network })
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network })

        // The module-unique domain gauges, on the REGISTRY, as `jobs.test.ts` reads them unlabelled.
        // In the single-network deployment this is one plane; a two-plane deployment would want a
        // `{ network }` label here, which `sampleQueue`/`sampleGovernance` do not yet take.
        await sampleQueue(plane.db, metrics)
        await sampleGovernance(plane.db, metrics)
      }

      // Read out of the provider's own memory — no request is made, so a scrape cannot become load
      // on identity. `static` counts as usable because it IS, for about ten minutes, which is why it
      // needs the second gauge beside it. Together they answer what nothing could while the token was
      // dead for 26 hours: can this process authenticate right now, and is it even able to renew?
      metrics.set(
        'community_service_token_usable',
        upstreams.mode === 'exchanged'
          ? (upstreams.identityTokens?.snapshot().hasUsableToken ?? false)
            ? 1
            : 0
          : upstreams.mode === 'static'
            ? 1
            : 0,
      )
      metrics.set('community_service_token_static', upstreams.mode === 'static' ? 1 : 0)
    },
    start: async () => {
      started = true
      // Seeded into EVERY queue: an estate with no recurring sweep is half-running, not dormant.
      for (const plane of planes) await seedRecurring(plane.queue)
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
export function communityMigrationTargets(): readonly Target[] {
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
 * HOST's, so an in-flight erasure or execution holds the drain of the process that is actually
 * shutting down. The two probe methods throw rather than answering plausibly, so if the filter is
 * ever removed the shadowed route fails loudly instead of reporting a readiness it did not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('community does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('community does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
