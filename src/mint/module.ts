/**
 * The mint module: the token deployer, constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M5b (micro-deploy `docs/service-merge-plan.md`) folds mint into agora's process. Its
 * database is KEPT — no schema merge — and this schema owns `inbox`, `jobs`, `outbox`,
 * `event_subscriptions` and `outbox_deliveries`, every one of which exists under the SAME name in
 * the other modules' schemas that share this process.
 *
 * A handler handed the wrong handle does not fail. `select … from jobs` SUCCEEDS against another
 * module's queue; `insert into outbox …` SUCCEEDS into another module's relay, where a job kind
 * this module never registered will try to deliver it. The four layers that make that unspellable
 * are the ones `./pricing/module.ts` documents: `./env.ts` imported here and nowhere above, every
 * route stamped with `RouteSpec.sql`, handlers closed over this module's deps, and no interface
 * with a parameter a foreign handle could arrive through.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT MAKES MINT DIFFERENT FROM THE OTHER FOUR ─────────────────────────────────────────────
 *
 * mint is the only module in this process that signs a transaction and puts bytes on a public
 * chain. So its per-plane bulkheading is not tidiness: `token.deploy`'s lease key is `chain:network`
 * and its worker closes over the network that selects the CHAIN, the custody key that signs, and the
 * gas that pays. One runner over one shared queue would have a testnet order deploying against
 * mainnet, spending real gas, and recording success. Each plane keeps its OWN queue and its OWN
 * runner, exactly as the standalone did.
 *
 * The per-chain JSON-RPC clients are built ONCE and shared across planes: they dial public chain
 * nodes outside this estate, network-agnostic, and a fresh client per call has a permanently closed
 * circuit that hammers a dead node. They are deliberately NOT given the service token — see
 * `./upstreams.ts`.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { serviceTokenProbe } from '@cloudsforge/auth'
import { HttpClient } from '@cloudsforge/http'
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
import { CHAIN_IDS, type ChainId } from './chains.ts'
import { isImplemented } from './families.ts'
import type { JsonRpc } from './evm.ts'
import type { Db } from './outbox.ts'
import type { DeployDeps } from './deploy.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS MODULE COLLIDES WITH THREE OTHERS ON `outbox.relay`.** Measured in
 * `../jobcomposition.test.ts` rather than asserted from memory: agora, devplatform, pricing and
 * studio all register a kind spelled exactly `outbox.relay`, so `jobs_failed_total{kind="outbox.relay"}`
 * would be the sum of FOUR unrelated relays — a number that still moves, that an alert still fires
 * on, and that names a service which is now more than one.
 *
 * `token.deploy` and `token.sweep` collide with nothing, and that matters: they are the series an
 * operator reads when a deploy wedges, and they must not be summed with anything.
 *
 * `jobs_pending` and `jobs_overdue` are worse still, because they carry no `kind` at all: each
 * module's sample would OVERWRITE the others' on every scrape, so a wedged deploy queue is ABSENT
 * from the graph rather than high — and `deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue`
 * alerts on exactly that gauge.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'mint'

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
export interface MintModule {
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module.
   *
   * `postgres-mint` is hard: a merged `/readyz` that probed only agora's database would answer 200
   * while every order and every deploy was failing. `identity-credential` is hard too — but it is a
   * LOCAL check, not a peer's health: it fails only when no credential is configured at all, and an
   * identity OUTAGE returns warn, so one bad minute in identity does not empty every balancer.
   * custody, indexer, ledger and pricing are SOFT — see below. `identity-jwks` is NOT here; the
   * host already probes it softly, and two identical rows in one report is noise, not safety.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the mint half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take the other modules down for a mint fault at a point where the host
 * has a logger and a `fatal` line to write.
 */
export async function createMintModule(host: HostRuntime): Promise<MintModule> {
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', {
    version: env.version,
    schemaVersion: SCHEMA_VERSION,
    // A chain with a family but no endpoint is the failure most likely to be a deploy mistake, so
    // it is said at boot rather than discovered from a refused deploy an hour later.
    chains: CHAIN_IDS.map((chain) => ({
      chain,
      implemented: isImplemented(chain),
      endpoint: Boolean(env.rpcUrls[chain]),
    })),
    // Empty is the default and empty means no mainnet deploy is possible. Logged so an operator can
    // see which it is without reading the environment.
    mainnetAllowlist: env.mainnetAllowlist.length,
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
  // database and its own queue under the other estate's name, and then refuses — or, when the throw
  // escapes a request listener, DIES — on every request the gateway correctly stamped.
  // `./ownnetwork.test.ts` reads THIS file.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

  const queueFor = (handle: typeof sql): JobQueue =>
    new JobQueue(handle as unknown as JobsSql, {
      owner: env.instanceId,
      // Longer than the default 60 seconds because a deploy job holds its lease across a node round
      // trip, a custody round trip and a broadcast. The handler renews between steps, so this is the
      // ceiling on a STEP rather than on the job.
      leaseMs: 120_000,
    })

  /**
   * One plane per network: pool, handle, queue.
   *
   * The queue is per-network because an enqueue is a WRITE and a deploy job is the most consequential
   * write this service makes — it spends gas from a custody key on a real chain.
   */
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
  const primary = planes[0]!

  try {
    for (const plane of planes) {
      await assertSchemaAtLeast(plane.pool as unknown as DbSql, SCHEMA_VERSION)
    }
  } catch (err) {
    await close()
    throw err
  }

  const mintSql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  )

  // ── THE PEERS, AND THE CREDENTIAL PRESENTED TO ALL OF THEM ─────────────────────────────────
  //
  // Reproduced from the standalone composition root. `identityTokens` is `null` when no credential
  // is configured; `serviceTokenProbe` reports that as a hard readiness failure below.
  const { identityTokens, custody, indexer, ledger, pricing } = buildUpstreams(env, {
    originatingService: SERVICE,
    onEvent: (event) => {
      if (event.kind === 'exchange_failed') {
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
    logger.error('MINT_IDENTITY_CREDENTIAL is not set; every call to a peer will fail 503', {
      hint: 'deploy/scripts/estate-bootstrap.sh writes it to compose/estate/tokens.env',
    })
  }
  if (env.legacyServiceTokenPresent) {
    logger.error('MINT_SERVICE_TOKEN is set and is IGNORED', {
      hint: 'it was a 600-second token read once at boot; MINT_IDENTITY_CREDENTIAL replaces it',
    })
  }

  /**
   * One JSON-RPC client per chain, built once so a circuit breaker accumulates state across ticks.
   * A fresh client per call has a permanently closed circuit and hammers a dead node. Shared across
   * planes: the endpoint is a property of the chain, not the estate, and these dial public nodes
   * outside this estate that are given no token — see `./upstreams.ts`.
   */
  const rpcClients = new Map<string, HttpClient>()
  const rpc = (chain: ChainId): JsonRpc => {
    const url = env.rpcUrls[chain]
    if (!url) throw new Error(`no JSON-RPC endpoint configured for ${chain}`)
    let client = rpcClients.get(chain)
    if (!client) {
      client = new HttpClient({
        baseUrl: new URL(url).origin,
        name: `rpc:${chain}`,
        defaultDeadlineMs: env.rpcDeadlineMs,
      })
      rpcClients.set(chain, client)
    }
    const path = `${new URL(url).pathname}${new URL(url).search}`
    let id = 0
    return async (method, params) => {
      id += 1
      const body = await client.request<{ result?: unknown; error?: { message?: string } }>(path, {
        method: 'POST',
        body: { jsonrpc: '2.0', id, method, params },
        idempotencyKey: `${chain}:${method}:${id}`,
      })
      if (body.error) throw new Error(body.error.message ?? 'json-rpc error')
      return body.result
    }
  }

  /**
   * The deploy worker's dependencies, per network.
   *
   * `network` is not a label here: it selects the CHAIN a deployment goes to, the custody key that
   * signs it and the gas that pays for it. One worker per network, each closed over its own handle
   * and its own network, is the only shape where a testnet order cannot deploy a mainnet contract.
   */
  const deployFor = (handle: Db, network: 'mainnet' | 'testnet'): DeployDeps => ({
    sql: handle,
    producer: SERVICE,
    owner: env.instanceId,
    network,
    custody,
    indexer,
    rpc,
    bounds: {
      minGasPriceWei: env.minGasPriceWei,
      maxGasPriceWei: env.maxGasPriceWei,
      maxFeeWei: env.maxFeeWei,
    },
    leaseMs: 120_000,
    stuckMs: env.stuckMinutes * 60_000,
    fundingMaxRequests: env.fundingMaxRequests,
    fundingCooldownMs: env.fundingCooldownMinutes * 60_000,
    enabled: env.deploysEnabled,
    logger: logger.child({ component: 'deploy', network }),
    metrics,
  })

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      // The SELECTOR, not a handle — routes use `ctx.sql`, resolved once per request.
      sql: mintSql,
      // The fallback for a request with no `CF-Network` header — every service-to-service call, which
      // goes container to container and never reaches the gateway that stamps one.
      singleNetwork: ownNetwork,
      producer: SERVICE,
      // The boot-time default. The mounted handle's `forRequest` replaces it with the network the
      // gateway stamped, because a pod serving both estates has no process-wide answer to
      // "which chain am I deploying to".
      network: env.network,
      // `pay.sql` is rebuilt per request by `forRequest`. `render` and `queue` are the primary
      // plane's, exactly as the standalone `createServer` wired them.
      pay: { sql: primary.db, ledger, pricing, settlementAsset: env.settlementAsset, producer: SERVICE },
      render: { sql: primary.db, indexer },
      queue: primary.queue,
      priceUsdCents: env.deployPriceUsdCents,
      settlementAsset: env.settlementAsset,
      mainnetAllowlist: env.mainnetAllowlist,
      // The estate signs every event with one shared key, so what this service SIGNS with is also
      // what it ACCEPTS. A list of one, because the field is a list: the day that key is rotated a
      // second entry lets this service accept both while the producers move over.
      eventAcceptSecrets: [env.outboxSigningSecret],
    },
    mintSql,
  )

  let started = false
  const runners = planes.map((plane) => {
    const jobDeps: JobDeps = {
      sql: plane.db,
      logger,
      // The REGISTRY, not the labelled view: `mint_deploys_outstanding` is the only metric a mint
      // job handler writes, and it is a module-unique gauge that must not carry a `module` label.
      // The JOB-INFRASTRUCTURE counters (jobs_*) are written by the runner's `onEvent` below,
      // through `jobMetrics`, because those DO collide across modules.
      metrics,
      signingSecret: env.outboxSigningSecret,
      deploy: deployFor(plane.db, plane.network),
      queue: plane.queue,
      sweepLimit: 100,
    }
    const reschedule = rescheduleRecurring(plane.queue, plane.network, logger)
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
          logger.error('job failure', { ...event, network: plane.network })
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
      // HARD, but a LOCAL check rather than a peer's health: it fails only when no credential is
      // configured at all — a replica that cannot sign a single deploy and will not fix itself — and
      // an identity OUTAGE returns warn, so one bad minute in identity does not empty every balancer.
      serviceTokenProbe(identityTokens),
      // SOFT, all four. Custody being down means no new signature can be made, but this module must
      // stay in rotation to keep ADVANCING deploys that are already signed. Marking any hard would
      // take all twelve modules offline for one module's upstream incident — the same reason agora
      // keeps `policy` soft.
      httpProbe('custody', `${env.custodyUrl}/livez`, { kind: 'soft' }),
      httpProbe('indexer', `${env.indexerUrl}/livez`, { kind: 'soft' }),
      httpProbe('ledger', `${env.ledgerUrl}/livez`, { kind: 'soft' }),
      httpProbe('pricing', `${env.pricingUrl}/livez`, { kind: 'soft' }),
    ],
    beforeScrape: async () => {
      // Per network. Summed across both queues the gauge reads healthy while one estate's deploy
      // backlog grows for ever.
      for (const plane of planes) {
        const stats = await plane.queue.stats()
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network })
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network })
      }
    },
    start: async () => {
      started = true
      for (const plane of planes) await seedRecurring(plane.queue, plane.network)
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
export function mintMigrationTargets(): readonly Target[] {
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
 * HOST's, so an in-flight order write holds the drain of the process that is actually shutting down.
 * The two probe methods throw rather than answering plausibly, so if the filter is ever removed the
 * shadowed route fails loudly instead of reporting a readiness it did not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('mint does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('mint does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
