/**
 * The wallet module: custody-facing balances, deposits, withdrawals and the conversion desk,
 * constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND IN THIS MODULE THAT IS A STATEMENT ABOUT MONEY.**
 *
 * Wave M5d (micro-deploy `docs/service-merge-plan.md`) folds wallet into agora's process. Every
 * database is KEPT — no schema merge — and `inbox` and `jobs` exist in nearly all of them with the
 * same columns.
 *
 * A handler handed the wrong handle does not fail. Here it credits a testnet deposit to a mainnet
 * balance, and the wallet is where a user looks to find out what they own. The layers that make
 * that unspellable are the ones `../policy/module.ts` documents: `./env.ts` imported here and
 * nowhere above, every route stamped with `RouteSpec.sql`, handlers closed over this module's
 * deps, and no interface with a parameter a foreign handle could arrive through — plus one that is
 * this module's own, `forRequest` rebuilding ALL FOUR domain bundles together, because rebuilding
 * one and not the others would leave a deposit credited in one estate and a balance read from the
 * other.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT IS DIFFERENT ABOUT THIS ONE ──────────────────────────────────────────────────────────
 *
 * **It is the module whose paths cannot move.** `public-api.yml` routes seven `api.<apex>` prefixes
 * straight at it and `estate-web.yml` gives it the whole `pay.<suffix>` host, so wallet is the
 * PUBLIC owner of every path it collides on and `./server.ts`'s `mountableRoutes` remounts nothing.
 * hub is the module that moved. See `mountableRoutes` for the whole argument.
 *
 * **Its webhook is `/events`, unversioned, and the process's entire third event family.** No
 * suffix, no entry in `../server.ts`'s `SPLIT_EVENT_PATHS`. See `EVENTS_PATH` in `./server.ts`.
 *
 * **One job runner, on the primary plane only** — unlike trade and pricing, which run one per
 * network. That is this service's own arrangement carried across unchanged rather than a
 * simplification made here: `deposit.watch`, `deposit.post`, `withdrawal.reserve` and
 * `withdrawal.sweep` reconcile against chain state through custody and the indexer, which are
 * per-estate deployments of their own. Changing the job topology in a merge wave would be changing
 * how money settles while claiming to move a file.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { serviceTokenProbe } from '@cloudsforge/auth'
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
import { staticFeeQuoter } from './settlement.ts'
import {
  chainAvailability,
  indexerObservability,
  payableChainsOnly,
  payableFromFeeQuotes,
} from './observability.ts'
import {
  pendingCreditCount,
  sampleDepositAddressMetrics,
  tokenSightingCount,
  type DepositDeps,
} from './deposits.ts'
import { sampleDeskInventory, type MoneyDeps } from './money.ts'
import type { PortfolioDeps } from './portfolio.ts'
import type { WithdrawalDeps } from './withdrawals.ts'
import type { Db } from './outbox.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * `outbox.relay` is the estate's most-collided job kind and this module makes it one more.
 * `idempotency.reap` is worse: market and trade register it too, so without the label
 * `jobs_failed_total{kind="idempotency.reap"}` sums three unrelated reapers over three unrelated
 * databases. `deposit.watch`, `deposit.post`, `withdrawal.reserve` and `withdrawal.sweep` collide
 * with nothing, and that matters most of all — they are the series an operator reads when a
 * deposit stops crediting or a withdrawal stops paying out. `../jobcomposition.test.ts` counts all
 * of it rather than trusting this paragraph.
 */
export const MODULE_LABEL = 'wallet'

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
export interface WalletModule {
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module: two hard, three soft.
   *
   * Postgres is hard because without it no wallet route works. `serviceTokenProbe` is hard for a
   * reason of its own and it survives the merge unchanged: it fails only when NO credential is
   * configured, which is a deployment that cannot serve a single money route and will not fix
   * itself. An identity OUTAGE returns warn from that probe, not a failure.
   *
   * The three peer probes are soft. With the ledger down this module can still list wallets,
   * verify a link and register a deposit address; with pricing down a portfolio renders without
   * valuations. A hard probe on a peer would now remove EIGHTEEN modules from the balancer over
   * one peer's bad minute, where the money routes already refuse individually with a 503 that
   * names which upstream did not answer.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the wallet half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take seventeen others down for a wallet fault at a point where the host
 * has a logger and a `fatal` line to write.
 */
export async function createWalletModule(host: HostRuntime): Promise<WalletModule> {
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION, network: env.network })

  const poolOptions = {
    max: env.databasePoolMax,
    // postgres.js writes notices to stderr as unstructured text by default, which is how a
    // connection string ends up in a log the collector cannot parse.
    onnotice: () => {},
  }
  const sql = postgres(env.databaseUrl, poolOptions)
  // `WALLET_DATABASE_URL_TESTNET` unset is the single-network case: `networkSql` then holds one
  // handle and REFUSES a testnet request rather than answering it from mainnet balances. In this
  // module that refusal is the difference between a 500 somebody fixes and a user being shown
  // another estate's money.
  const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined

  const close = async (): Promise<void> => {
    await sql.end({ timeout: 5 }).catch(() => {})
    await sqlTestnet?.end({ timeout: 5 }).catch(() => {})
  }

  // Below `SCHEMA_VERSION` the `deposit_credits.credit_key` unique constraint may not exist — and
  // that constraint is one of the two things stopping a redelivered deposit crediting twice.
  // Closed then rethrown rather than exited: the host unwinds every module built before this one.
  try {
    await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
    if (sqlTestnet) await assertSchemaAtLeast(sqlTestnet as unknown as DbSql, SCHEMA_VERSION)
  } catch (err) {
    await close()
    throw err
  }

  // The upstreams, and the credential that authenticates every call to them. Built before the
  // probes because they close over it. The wiring lives in `./upstreams.ts` and is covered by
  // `./servicetoken.test.ts` — it was untestable in a composition root, and what was untestable
  // there was wrong for months.
  const { identityTokens, ledger, custody, indexer, pricing } = buildUpstreams(env, {
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
    // Not a throw: the merged image must be able to boot without wallet's credential, because
    // refusing would take seventeen working modules down over one module's missing secret.
    // `/readyz` is where the absence is enforced, by the hard `identity-credential` probe below.
    logger.error('WALLET_IDENTITY_CREDENTIAL is not set; every call to a peer will fail 503', {
      hint: 'deploy/scripts/estate-bootstrap.sh writes it to compose/estate/tokens.env',
    })
  }
  if (env.legacyServiceTokenPresent) {
    logger.error('WALLET_SERVICE_TOKEN is set and is IGNORED', {
      hint: 'it was a 600-second token read once at boot; WALLET_IDENTITY_CREDENTIAL replaces it',
    })
  }

  const db = sql as unknown as Db

  /*
   * Which chains this deployment will take a deposit on at all, before the indexer is asked.
   *
   * Logged once rather than left to be discovered: the gate refuses with a 503 that names the
   * asset and not the reason (`deposits.ts` explains why the person is not told), so without this
   * line the only way to learn that `WALLET_FEE_QUOTES` is what shut the deposit route is to read
   * the source. WARN and not INFO when it is empty, because a wallet that takes no deposits at all
   * is almost always a variable somebody forgot rather than an intention.
   */
  const payableOut = payableFromFeeQuotes(env.feeQuotes)
  logger[payableOut.chains.length === 0 ? 'warn' : 'info']('deposit gate', {
    payableChains: payableOut.chains,
    note:
      'deposits are refused for every chain absent from this list, whatever the indexer follows, ' +
      'because a withdrawal of its native asset could not be priced — WALLET_FEE_QUOTES',
  })

  /**
   * One indexer-backed observation port, shared by the deposit gate and the deposit catalogue.
   *
   * Shared rather than constructed twice because the 60-second cache lives inside it: two
   * instances would hold two independently-ageing answers to one question, and `POST /v1/deposits`
   * refusing an asset that `GET /v1/deposits/assets` had just offered — for no reason either could
   * name — is the exact class of disagreement this arrangement exists to avoid.
   */
  const chainObservability = indexerObservability({ indexer })

  const deposits: DepositDeps = {
    sql: db,
    producer: SERVICE,
    network: env.network,
    custody,
    indexer,
    ledger,
    // TWO gates, and they answer different questions. Can this estate SEE the chain — measured
    // from the indexer per request (cached 60s), never asserted from a list here, because a second
    // hardcoded list of supported chains is how the estate came to offer a real Bitcoin address
    // that nothing was watching. And can it pay the chain's own coin back OUT — read from the
    // withdrawal fee table (micro-org#373 §6.1). The payability gate is OUTERMOST on purpose.
    observability: payableChainsOnly({
      observability: chainObservability,
      payable: payableOut.payable,
    }),
    // The same two questions for the CATALOGUE, which describes rather than gates — micro-org#481.
    availability: chainAvailability({
      observability: chainObservability,
      payable: payableOut.payable,
    }),
  }

  const withdrawals: WithdrawalDeps = {
    sql: db,
    producer: SERVICE,
    network: env.network,
    ledger,
    // Fees come from configuration until `micro-settlement` quotes them live. An asset absent from
    // the table is refused with 503 rather than priced by guessing — see `./settlement.ts`.
    fees: staticFeeQuoter(env.feeQuotes),
    withdrawalsEnabled: env.withdrawalsEnabled,
    minFeeMultiple: env.withdrawalMinFeeMultiple,
    stuckMinutes: env.withdrawalStuckMinutes,
  }

  const money: MoneyDeps = { sql: db, producer: SERVICE, ledger, pricing }
  const portfolio: PortfolioDeps = { sql: db, network: env.network, ledger, indexer, pricing }

  // ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
  //
  // The `networkSql` key below used to be the literal `mainnet`. Same image, same code, different
  // env — so the TESTNET pod registered its testnet DSN under the name `mainnet` and then refused
  // every request the gateway stamped `CF-Network: testnet`, because it genuinely held no handle
  // by that name. Five services crash-looped on it within ten minutes of the first deploy: the
  // refusal was right, the registration was wrong. `./ownnetwork.test.ts` reads THIS file.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

  const walletSql = networkSql({
    [ownNetwork]: sql as unknown as RuntimeSql,
    ...(sqlTestnet && ownNetwork !== 'testnet' ? { testnet: sqlTestnet as unknown as RuntimeSql } : {}),
  })

  const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      network: env.network,
      // The SELECTOR, not a handle — routes use `ctx.sql`, resolved once per request, and
      // `forRequest` rebuilds all four domain bundles against it.
      sql: walletSql,
      singleNetwork: ownNetwork,
      deposits,
      withdrawals,
      money,
      portfolio,
      // The ACCEPT list, not the signing key: verification widens for the rotation window, signing
      // does not. Absent `OUTBOX_ACCEPT_SECRETS` this is `[env.outboxSigningSecret]`, unchanged.
      eventSigningSecret: env.outboxAcceptSecrets,
      challengeDomain: env.challengeDomain,
      challengeUri: env.challengeUri,
      challengeTtlSeconds: env.challengeTtlSeconds,
    },
    walletSql,
  )

  const jobDeps: JobDeps = {
    sql: db,
    logger,
    // The labelled VIEW, not the registry: this module's relay and reaper write counters under
    // kinds that two and three other modules also register.
    metrics: jobMetrics,
    signingSecret: env.outboxSigningSecret,
    idempotencyTtlDays: env.idempotencyTtlDays,
    deposits,
    withdrawals,
  }

  let started = false
  const reschedule = rescheduleRecurring(queue, logger)
  const runner = new JobRunner({
    queue,
    concurrency: 4,
    pollMs: 1_000,
    shouldClaim: () => started && host.claimingJobs(),
    onEvent: (event) => {
      if (event.kind) {
        const labels = { kind: event.kind }
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

  return {
    routes,
    probes: [
      postgresProbe(`postgres-${MODULE_LABEL}`, (signal) =>
        // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignored
        // the signal would hang `/readyz` for ever. Racing the signal here is what turns "the
        // database is not answering" into a fail rather than a hung readiness endpoint.
        Promise.race([
          sql`select 1`,
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
          }),
        ]),
      ),
      httpProbe(`${MODULE_LABEL}-identity-jwks`, env.identityJwksUrl, { kind: 'soft' }),
      // HARD, and the only hard probe here besides the database. Unlike the two below it does not
      // report a peer having a bad minute — it fails only when no credential is configured at all,
      // which is a deployment that cannot serve a single money route and will not fix itself.
      serviceTokenProbe(identityTokens),
      httpProbe(`${MODULE_LABEL}-ledger`, `${env.ledgerUrl}/livez`, { kind: 'soft' }),
      httpProbe(`${MODULE_LABEL}-indexer`, `${env.indexerUrl}/livez`, { kind: 'soft' }),
    ],
    beforeScrape: async () => {
      const stats = await queue.stats()
      jobMetrics.set('jobs_pending', stats.pending)
      jobMetrics.set('jobs_overdue', stats.overdue)
      // Both of these must read zero in a healthy module, and both are invisible without a gauge:
      // a credit claimed but never posted is money the user cannot see, and an unwatched deposit
      // address is money nobody will ever be told about. On the REGISTRY, not the view — the
      // `wallet_*` names collide with nothing.
      metrics.set('wallet_deposit_credits_pending', await pendingCreditCount(db))
      // Customer money at a deposit address that no ledger entry accounts for — micro-org#200.
      metrics.set('wallet_deposit_token_sightings', await tokenSightingCount(db))
      // Per chain, from one query, on every replica — and the only writer of these three series.
      await sampleDepositAddressMetrics(deposits, metrics)
      // What the conversion desk is holding — micro-org#501. LAST, and that is a decision: this is
      // the only line in this hook that dials another service, and `/metrics` catches a throw here
      // and serves the previous values. Ordering it last means a ledger outage cannot also cost
      // the four gauges above their refresh.
      //
      // In the merged process the host's `/metrics` awaits every module's `beforeScrape` in order,
      // so this is now also the reason wallet's hook must not be made to throw: the modules after
      // it would lose their refresh too. It does not — `sampleDeskInventory` swallows its own.
      await sampleDeskInventory(money, metrics)
    },
    start: async () => {
      started = true
      await seedRecurring(queue)
      runner.start()
    },
    stop: async () => {
      started = false
      const clean = await runner.stop(20_000)
      logger.info('job runner stopped', { clean })
      await close()
      logger.info('database pools closed', { networks: sqlTestnet ? 2 : 1 })
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
export function walletMigrationTargets(): readonly Target[] {
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
 * HOST's, so an in-flight withdrawal holds the drain of the process that is actually shutting
 * down. The two probe methods throw rather than answering plausibly, so if the filter is ever
 * removed the shadowed route fails loudly instead of reporting a readiness it did not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('wallet does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('wallet does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
