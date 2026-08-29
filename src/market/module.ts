/**
 * The market module: listings, auctions, orders, escrow and moderation, behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M5b (micro-deploy `docs/service-merge-plan.md`) folds market into agora's process as another
 * module of the platform monolith. Every module's database is KEPT — no schema merge — and the
 * schemas own `inbox` and `jobs` in ALL of them, with `outbox`, `event_subscriptions` and
 * `outbox_deliveries` in most including this one.
 *
 * A handler handed the wrong handle does not fail. `select … from jobs` SUCCEEDS against another
 * module's queue; `insert into outbox …` SUCCEEDS into another module's relay, where a job kind
 * this module never registered will try to deliver it. The four layers that make that unspellable
 * are the ones `./policy/module.ts` documents: `./env.ts` imported here and nowhere above, every
 * route stamped with `RouteSpec.sql`, handlers closed over this module's deps, and no interface with
 * a parameter a foreign handle could arrive through.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE CREDENTIAL, WHICH IS THIS MODULE'S ONE GENUINELY DIFFERENT RISK ─────────────────────────
 *
 * market is the module in this process that settles money. Every listing that reserves, every bid
 * that escrows, every sale that settles and every escrow that releases is a call to the ledger, and
 * every listing is gated by a policy decision. Those calls carry a SERVICE credential exchanged for
 * a short-lived token, not a token read once at import — `./upstreams.ts` carries the whole
 * argument, including why the credential is deliberately NOT a hard readiness probe and why
 * `market_service_token_usable` stands in its place.
 *
 * The upstream clients are built ONCE, here, and shared across both job planes: they are addressed
 * by URL and a process-wide credential, and the network a posting belongs to travels per request,
 * not per client. The per-network things are the pools, the queues and the domain bundles below.
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
import type { OrderDeps } from './orders.ts'
import type { BidDeps } from './bids.ts'
import type { Db } from './outbox.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS MODULE COLLIDES WITH OTHERS ON `outbox.relay`.** Measured in `../jobcomposition.test.ts`
 * rather than asserted from memory: several modules register a kind spelled exactly `outbox.relay`,
 * so `jobs_failed_total{kind="outbox.relay"}` would be the sum of unrelated relays — a number that
 * still moves and that an alert still fires on.
 *
 * `auction.close`, `payout.release` and `market.expire` collide with nothing, and that matters more
 * than it looks: they are the series an operator reads when a sale fails to settle, and they must
 * not be summed with anything.
 *
 * `jobs_pending` and `jobs_overdue` are worse still, because they carry no `kind` at all: without a
 * `module` label each module's sample OVERWRITES the others' on every scrape, so a wedged settlement
 * queue is ABSENT from the graph rather than high — and `deploy/prometheus/rules/alerts.yaml`'s
 * `JobQueueOverdue` alerts on exactly that gauge.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'market'

/** What the host process supplies. Deliberately nothing this module could hide a handle inside. */
export interface HostRuntime {
  /** The process-wide registry — the object the host's `/metrics` renders, not a view of it. */
  readonly metrics: Metrics
  /** The host's identity verifier. ONE JWKS client for the process; every module reads it. */
  readonly verifier: PrincipalVerifier
  /** The host `Lifecycle`'s `claimingJobs`. A drain must stop claiming in EVERY module at once. */
  claimingJobs(): boolean
  /**
   * The host `Lifecycle`'s `track`.
   *
   * Live, and it must be the HOST's: a purchase holds the drain open between the ledger entry and
   * the order row, and a shutdown that cut that gap is the one place money could move with nothing
   * in this service saying so.
   */
  track(): () => void
}

/** What the host process gets back. **No field here names a database handle.** */
export interface MarketModule {
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module.
   *
   * TWO, and the split is the point:
   *
   *   * `postgres-market` — HARD. A merged `/readyz` that probed only agora's database would answer
   *     200 while every listing read, order and escrow in market's own database was failing.
   *   * `ledger` — SOFT here, though the standalone service marked it HARD. With the ledger down
   *     nothing market exists to do can happen, and standalone that earned a hard probe: a replica
   *     that can serve only reads should leave the balancer. In the merged process the same hard
   *     probe would take EVERY module offline for one module's upstream incident, so it is soft —
   *     mirroring agora's own decision to keep `policy` soft (see `agora/src/index.ts`). The public
   *     reads market serves come from its own tables and touch no upstream, and the credential
   *     gauges (`market_service_token_usable`) are what an operator reads instead.
   *
   * The `identity-jwks` probe is deliberately NOT here — the host already probes that URL, softly,
   * from the same estate-wide variable.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the market half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take every other module down for a market fault at a point where the
 * host has a logger and a `fatal` line to write.
 */
export async function createMarketModule(host: HostRuntime): Promise<MarketModule> {
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', {
    version: env.version,
    schemaVersion: SCHEMA_VERSION,
    // Said at boot, because a marketplace with listing switched off looks exactly like a
    // marketplace that is broken until somebody reads the environment.
    listingEnabled: env.listingEnabled,
    platformFeeBps: env.platformFeeBps,
    maxRoyaltyBps: env.maxRoyaltyBps,
    disputeWindowMs: env.disputeWindowMs,
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

  // Longer than the default 60s because an auction close holds its lease across a ledger call per
  // losing bidder; the status claim in `settleSale` is what makes two settlements impossible, and
  // this is the budget for one attempt at it. Per plane, because a runner binds to one queue, which
  // binds to one handle, which is one database.
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

  const marketSql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  )

  // ── THE THREE UPSTREAMS, EXCHANGED NOT READ ONCE, AND BUILT ONCE ────────────────────────────
  //
  // `./upstreams.ts` carries the argument for why the credential is exchanged rather than read once
  // at import, and why it is deliberately NOT a hard readiness probe. Built here — one client per
  // peer for the whole module — so both estates' settlements go through one credential with one
  // refresh clock; the network a posting belongs to travels per request, not per client.
  const upstreams = buildUpstreams(env, {
    originatingService: SERVICE,
    onEvent: (event) => {
      metrics.increment('market_service_token_events_total', { kind: event.kind })
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
        // token is still held is the outage this provider is built to ride out.
        logger.warn('service credential exchange failed', { ...event })
      }
    },
  })
  const { ledger, indexer, policy } = upstreams

  // Said at boot, at the level its consequence deserves, because the alternative is what actually
  // happened once: a marketplace that looks entirely healthy while its moderation gate is absent.
  if (upstreams.mode === 'none') {
    logger.fatal('NO CREDENTIAL AT ALL — every ledger, indexer and policy call will fail', {
      remedy: 'set MARKET_IDENTITY_CREDENTIAL (long-lived, cfsc_…, from POST /service-credentials)',
    })
  } else if (upstreams.mode === 'static') {
    logger.fatal('EXPIRING TOKEN, NOT A CREDENTIAL — every upstream call will 401 about ten minutes from now', {
      whatWillHappen:
        'MARKET_SERVICE_TOKEN lives 600s and nothing can renew it. From minute ten the ledger refuses ' +
        'every reservation and escrow, and policy 401s every decision — which policyclient.ts reads as ' +
        'a degraded gate, so listings keep going up UNMODERATED with no error anywhere.',
      remedy:
        'set MARKET_IDENTITY_CREDENTIAL in the deploy; estate-bootstrap.sh already mints it into tokens.env',
    })
  } else {
    logger.info('service credential mode', { mode: upstreams.mode, identityUrl: env.identityUrl })
  }

  // ── THE DOMAIN BUNDLES, AS FACTORIES OVER ONE HANDLE ───────────────────────────────────────
  //
  // Each closes over the ledger and the producer and nothing else per network but the handle, so
  // `forRequest` in `./server.ts` rebuilds them against the handle the kernel resolved from THIS
  // module's selector. Built once over one pool — as the standalone service correctly did, holding
  // one — a testnet purchase would post to mainnet's ledger and leave matching rows on both sides.
  const ordersOf = (db: Db): OrderDeps => ({ sql: db, ledger, producer: SERVICE })
  const bidsOf = (db: Db): BidDeps => ({
    sql: db,
    ledger,
    producer: SERVICE,
    auctionExtensionMs: env.auctionExtensionMs,
  })
  const listingsOf = (db: Db) => ({ sql: db, ledger, producer: SERVICE })
  const moderationOf = (db: Db) => ({ sql: db, ledger, producer: SERVICE })

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      sql: marketSql,
      // The fallback for a request with no `CF-Network` header — which is EVERY service-to-service
      // call, because those go container to container and never reach the gateway that stamps one.
      singleNetwork: ownNetwork,
      producer: SERVICE,
      // ── THE BOOT-TIME DOMAIN BUNDLES, AND THE REBUILD THAT REPLACES THEM PER REQUEST ─────────
      //
      // `ServerDeps` demands all four, so all four are built over the PRIMARY plane here — and every
      // one is replaced by `forRequest` before any handler runs, from the handle the kernel resolved
      // out of THIS module's selector. The boot-time objects exist so the type is satisfied and so a
      // mistake is a wrong ESTATE rather than a wrong module; `RouteSpec.sql` is what makes the
      // module half impossible.
      listings: listingsOf(planes[0]!.db),
      orders: ordersOf(planes[0]!.db),
      bids: bidsOf(planes[0]!.db),
      moderation: moderationOf(planes[0]!.db),
      indexer,
      indexerNetwork: env.indexerNetwork,
      policy,
      // Where a BROWSER reaches studio, which is not where a service does. Empty means images are
      // unconfigured here and every `bytesUrl` this module emits is null rather than a guess.
      studioPublicUrl: env.studioPublicUrl,
      // Required by `ServerDeps` but reached by no route handler — the sweeps in `./jobs.ts` enqueue,
      // the HTTP routes do not — so the primary plane's queue satisfies the contract without offering
      // a route a cross-network write. The runners below each hold their OWN plane's queue.
      queue: planes[0]!.queue,
      // The same secret signs what this module emits and verifies what billing and identity send.
      // See the header of `server.ts`: an unsigned inbound event route is a free-delisting endpoint.
      eventSigningSecret: env.outboxSigningSecret,
      platformFeeBps: env.platformFeeBps,
      maxRoyaltyBps: env.maxRoyaltyBps,
      disputeWindowMs: env.disputeWindowMs,
      listingEnabled: env.listingEnabled,
    },
    marketSql,
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
          // The labelled VIEW, not the registry: the relay handler writes job counters under a kind
          // other modules also register, and `jobs_pending`/`jobs_overdue` carry no kind at all.
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
      // The REGISTRY for the handlers' own `market_*` names, which collide with nothing. They are
      // registered without a `network` label, so the registry would drop one passed here as
      // undeclared rather than separate the series — the same choice `studio/module.ts` makes.
      metrics,
      signingSecret: env.outboxSigningSecret,
      orders: ordersOf(plane.db),
      bids: bidsOf(plane.db),
      queue: plane.queue,
      sweepLimit: 100,
      // Fourteen days. It must outlive every caller's retry horizon: expiring a key EARLY means the
      // next replay of it buys the item a second time.
      idempotencyTtlDays: 14,
      actor: `service:${SERVICE}`,
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
      // SOFT, though the standalone marked it HARD: a hard ledger probe here would take EVERY module
      // out of the balancer for one module's upstream incident. Mirrors agora's policy-soft decision.
      httpProbe('ledger', `${env.ledgerUrl}/livez`, { kind: 'soft' }),
    ],
    beforeScrape: async () => {
      for (const plane of planes) {
        const stats = await plane.queue.stats()
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network })
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network })
      }

      // Read out of the provider's own memory, per process rather than per plane: the credential is
      // one for the whole module. `static` counts as usable because it is — for about ten minutes —
      // which is exactly why it needs the second gauge beside it. Together they answer the question
      // nothing could answer while the token quietly died: can this process authenticate right now,
      // and is it even able to renew?
      metrics.set(
        'market_service_token_usable',
        upstreams.mode === 'exchanged'
          ? (upstreams.identityTokens?.snapshot().hasUsableToken ?? false)
            ? 1
            : 0
          : upstreams.mode === 'static'
            ? 1
            : 0,
      )
      metrics.set('market_service_token_static', upstreams.mode === 'static' ? 1 : 0)
    },
    start: async () => {
      started = true
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
export function marketMigrationTargets(): readonly Target[] {
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
 * HOST's, so an in-flight settlement holds the drain of the process that is actually shutting down.
 * The two probe methods throw rather than answering plausibly, so if the filter is ever removed the
 * shadowed route fails loudly instead of reporting a readiness it did not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('market does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('market does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
