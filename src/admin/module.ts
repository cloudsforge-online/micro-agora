/**
 * The admin module: the operator console's backend, the estate's audit chain, and the backup and
 * restore control plane — constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND IN THIS MODULE THAT IS A STATEMENT ABOUT THE AUDIT.**
 *
 * Wave M5d (micro-deploy `docs/service-merge-plan.md`) folds admin-api into agora's process. Every
 * database is KEPT — no schema merge — and `inbox` and `jobs` exist in nearly all of them with the
 * same columns.
 *
 * A handler handed the wrong handle does not fail. Here the table at risk is `audit`, a
 * hash-chained log whose entire value is that every privileged action in the estate lands in it
 * and nowhere else. An audit row written through another module's handle joins no chain, verifies
 * against no checkpoint, and is invisible to `audit.verify` — an action that happened with nothing
 * anywhere saying so, which is precisely what SD-15 exists to prevent.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE ESTATE-IDENTITY BOOT REFUSAL, CARRIED ACROSS UNCHANGED ────────────────────────────────
 *
 * `estate_identity` holds one immutable row saying which estate this database belongs to. It is
 * written on first boot and COMPARED on every boot after; a disagreement between the configured
 * environment and the claimed one refuses to serve. That turns two different mistakes into the
 * same loud failure at the same early moment — a container pointed at the wrong database, and a
 * compose file labelled with the wrong environment — and on 2026-08-05 the second happened twice.
 * A backup is stamped with this value and a restore is refused on it by
 * `restore_runs_environment_matches()`, so a wrong value poisons every artefact taken afterwards.
 *
 * It THROWS here rather than calling `process.exit`, which is the only change: the host owns the
 * exit code and unwinds every module built before this one. The refusal itself is unchanged, and
 * it must stay a refusal — a merged process that booted past it would put nineteen other modules'
 * uptime behind a fact this one is the estate's record of.
 *
 * ── AND THE JWKS PROBE, WHICH IS THE ONE THING THAT HAD TO CHANGE ─────────────────────────────
 *
 * Standalone, `identity-jwks` was HARD: every route here requires a verified operator token and
 * this service holds no fallback credential, so a replica that cannot reach the JWKS serves
 * nothing but 503s and should leave the balancer. In the merged process that argument inverts —
 * a hard probe would take NINETEEN modules out of rotation over one identity blip, including
 * every public read that needs no token at all. It is soft here, and the honest per-request
 * answer is unchanged: `@cloudsforge/auth` still answers 503 rather than 401 when the JWKS is
 * unreachable, so a caller is told the truth at the point of use rather than by a routing change.
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
import { buildUpstreams, probeReadiness } from './upstreams.ts'
import { claimEstateIdentity } from './backups.ts'
import type { Db } from './outbox.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * `outbox.relay` is the estate's most-collided job kind and this module makes it one more.
 * `idempotency.reap` is worse: market, trade and wallet register it too, so without the label
 * `jobs_failed_total{kind="idempotency.reap"}` sums four unrelated reapers over four unrelated
 * databases. `audit.verify`, `approvals.expire` and `backup.schedule` collide with nothing, and
 * `audit.verify` in particular must not be summed with anything — it is the series that says
 * whether the estate's tamper-evidence is still being checked.
 */
export const MODULE_LABEL = 'admin'

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
   * It matters more here than anywhere else in this process: a drain must not cut an operator
   * execution between the upstream call and `recordExecution`. That gap is the one place an action
   * can run with nothing in this module saying so, and this module is what says so for the whole
   * estate.
   */
  track(): () => void
}

/** What the host process gets back. **No field here names a database handle.** */
export interface AdminModule {
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module: one hard, four soft.
   *
   * Postgres is hard because the audit chain lives in it and NOTHING this module exists to do may
   * happen without an audit row (SD-15). Everything else is soft — including the JWKS probe the
   * standalone service marked hard, for the reason in the file header.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the admin half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take eighteen others down for an admin fault at a point where the host
 * has a logger and a `fatal` line to write.
 */
export async function createAdminModule(host: HostRuntime): Promise<AdminModule> {
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', {
    version: env.version,
    schemaVersion: SCHEMA_VERSION,
    estateEnvironment: env.estateEnvironment,
  })

  const poolOptions = { max: env.databasePoolMax, onnotice: () => {} }
  const sql = postgres(env.databaseUrl, poolOptions)
  const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined

  const close = async (): Promise<void> => {
    await sql.end({ timeout: 5 }).catch(() => {})
    await sqlTestnet?.end({ timeout: 5 }).catch(() => {})
  }

  try {
    await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
    if (sqlTestnet) await assertSchemaAtLeast(sqlTestnet as unknown as DbSql, SCHEMA_VERSION)
  } catch (err) {
    await close()
    throw err
  }

  // The estate-identity claim, AFTER the schema assertion because `estate_identity` arrives in
  // migration 10, and BEFORE the routes because no request may be answered by a replica that does
  // not know which estate it is. See the file header for why this refusal is worth a boot failure.
  try {
    const identity = await claimEstateIdentity(
      sql as unknown as Db,
      env.estateEnvironment,
      `service:${SERVICE}@${env.instanceId}`,
    )
    logger.info(identity.claimed ? 'estate identity claimed' : 'estate identity confirmed', {
      environment: identity.environment,
      composeProject: env.composeProject,
      claimedAt: identity.claimedAt,
    })
  } catch (err) {
    logger.fatal('estate identity check failed — refusing to start', {
      err,
      configured: env.estateEnvironment,
    })
    await close()
    throw err
  }

  // The upstreams. ONE line, and the body of it lives in `./upstreams.ts` where a test can reach
  // it. What used to be here was a dead JWT read once at import and presented verbatim for 26
  // hours, structurally invisible to every test in the repository — micro-org #222.
  const upstreams = buildUpstreams(env, {
    onEvent: (event) => {
      if (event.kind === 'minted') {
        logger.info('service token minted', {
          service: event.service,
          expiresIn: event.expiresIn,
          refreshInMs: event.refreshInMs,
        })
      } else if (event.kind === 'exchange_failed') {
        // `warn`, not `fatal`, and only because of `hadUsableToken`: a failed exchange while a live
        // token is still held is the outage the provider is built to ride out.
        logger.warn('service credential exchange failed', { ...event })
      }
    },
  })
  const { ledger, market, billing, identity, notify, nda, clientConfig } = upstreams

  // Said at boot, at the level its consequence deserves, because the alternative is what actually
  // happened: an operator console that looks entirely healthy while every privileged action it can
  // take has been answering 401 for a day. `fatal` WITHOUT an exit, here as standalone — the log
  // level is the severity of the consequence, not an instruction to the process.
  if (upstreams.mode === 'none') {
    logger.fatal('NO CREDENTIAL AT ALL — every ledger reversal and every role grant will fail', {
      remedy:
        'set ADMIN_API_IDENTITY_CREDENTIAL (long-lived, cfsc_…, from POST /service-credentials); ' +
        'estate-bootstrap.sh already mints it into tokens.env',
    })
  } else if (upstreams.mode === 'static') {
    logger.fatal('EXPIRING TOKEN, NOT A CREDENTIAL — every service call will 401 about ten minutes from now', {
      whatWillHappen:
        'ADMIN_API_SERVICE_TOKEN lives 600s and nothing in this process can renew it. From minute ten ' +
        'the ledger refuses every approved reversal and every trial-balance read, and identity refuses ' +
        'every role grant — while /livez stays green, because it makes no outbound call.',
      remedy: 'set ADMIN_API_IDENTITY_CREDENTIAL in the deploy and remove ADMIN_API_SERVICE_TOKEN',
    })
  } else {
    logger.info('service credential mode', { mode: upstreams.mode, identityUrl: env.identityUrl })
  }

  /** Every upstream the estate view reports on, with its `/readyz` probe. */
  const readiness = [
    { name: 'identity', url: env.identityUrl },
    { name: 'ledger', url: env.ledgerUrl },
    { name: 'market', url: env.marketUrl },
    { name: 'billing', url: env.billingUrl },
  ].map((entry) => ({
    name: entry.name,
    probe: () => probeReadiness(entry.name, { baseUrl: entry.url, ...clientConfig }),
  }))

  const db = sql as unknown as Db
  const queue = new JobQueue(sql as unknown as JobsSql, {
    owner: env.instanceId,
    // Longer than the default 60 seconds because a full audit-chain verification over a year of
    // rows is the slowest handler here, and a lease that expired mid-walk would hand the same
    // chain to a second replica which would then write a competing checkpoint.
    leaseMs: 300_000,
  })

  // ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
  //
  // The `networkSql` key below used to be the literal `mainnet`. Same image, same code, different
  // env — so the TESTNET pod registered its testnet DSN under the name `mainnet` and then refused
  // every request the gateway stamped `CF-Network: testnet`, because it genuinely held no handle
  // by that name. `./ownnetwork.test.ts` reads THIS file.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

  const adminSql = networkSql({
    [ownNetwork]: sql as unknown as RuntimeSql,
    ...(sqlTestnet && ownNetwork !== 'testnet' ? { testnet: sqlTestnet as unknown as RuntimeSql } : {}),
  })

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      sql: adminSql,
      singleNetwork: ownNetwork,
      producer: SERVICE,
      // The per-network selector; `forRequest` spreads one estate's set over the six fields below.
      upstreamsFor: upstreams,
      ledger,
      notify,
      market,
      billing,
      identity,
      nda,
      readiness,
      // Signing stays singular (the relay below); ACCEPTING is a list, so the estate's shared
      // secret can be rotated with an overlap window. An unsigned audit intake is a forgery
      // endpoint, and a partitioned one is an audit of record that reads as "nothing happened".
      eventAcceptSecrets: env.acceptSecrets,
      approvalTtlMinutes: env.approvalTtlMinutes,
      estateEnvironment: env.estateEnvironment,
      composeProject: env.composeProject,
    },
    adminSql,
  )

  let started = false
  const reschedule = rescheduleRecurring(queue, logger)
  const runner = new JobRunner({
    queue,
    concurrency: 2,
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

  registerHandlers(runner, {
    sql: db,
    logger,
    // The labelled VIEW, not the registry: this module's relay and reaper write counters under
    // kinds that three and four other modules also register.
    metrics: jobMetrics,
    signingSecret: env.outboxSigningSecret,
    instanceId: env.instanceId,
    auditVerifyBatch: env.auditVerifyBatch,
    idempotencyTtlDays: env.idempotencyTtlDays,
    composeProject: env.composeProject,
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
      // SOFT, though the standalone marked it HARD — see the file header. The per-request answer
      // is unchanged: `@cloudsforge/auth` still answers 503 rather than 401 on an unreachable
      // JWKS, so a caller is told the truth at the point of use.
      httpProbe(`${MODULE_LABEL}-identity-jwks`, env.identityJwksUrl, { kind: 'soft' }),
      // Soft because of the tile design: with any of them down the console still renders, one tile
      // marked, and an operator can still read the audit mirror, the approval queue and the
      // broadcasts. Hard would take the operator console out of rotation for the duration of
      // somebody else's incident — exactly the moment it is needed.
      httpProbe(`${MODULE_LABEL}-ledger`, `${env.ledgerUrl}/livez`, { kind: 'soft' }),
      httpProbe(`${MODULE_LABEL}-market`, `${env.marketUrl}/livez`, { kind: 'soft' }),
      httpProbe(`${MODULE_LABEL}-billing`, `${env.billingUrl}/livez`, { kind: 'soft' }),
    ],
    beforeScrape: async () => {
      const stats = await queue.stats()
      jobMetrics.set('jobs_pending', stats.pending)
      jobMetrics.set('jobs_overdue', stats.overdue)

      // ════════════════════════════════════════════════════════════════════════════════════════
      // **THE QUESTION THAT HAD NO ANSWER ANYWHERE WHILE THE TOKEN QUIETLY DIED FOR 26 HOURS:**
      // can this module authenticate to its peers right now?
      //
      // A GAUGE rather than a readiness probe, and that is a decision rather than an omission.
      // `serviceTokenProbe` exists in `@cloudsforge/auth` and is deliberately not wired here:
      //
      //   1. **The console's read surface is served from this module's own tables.** The audit
      //      mirror, the approval queue, the flags and the broadcasts make no outbound call. A
      //      hard probe on the credential would take the OPERATOR CONSOLE out of the balancer over
      //      a variable those routes cannot touch — during, by definition, an incident. In the
      //      merged process it would take nineteen other modules with it.
      //   2. **Pulling the replica would fix nothing.** Every replica reads the same environment.
      //   3. The write paths that need the bearer already fail honestly at the point of use: a
      //      `ServiceTokenUnavailableError` is 503 rather than 401.
      //
      // Deliberately NOT "is a token present". An expired token is retained after it dies — that
      // is the most useful thing an operator can be shown — so presence would report healthy
      // across exactly the outage this exists to make visible.
      // ════════════════════════════════════════════════════════════════════════════════════════
      const snapshot = upstreams.identityTokens?.snapshot()
      metrics.set('admin_api_service_token_usable', snapshot?.hasUsableToken === true ? 1 : 0)
      if (snapshot?.expiresInSeconds !== undefined && snapshot.expiresInSeconds !== null) {
        // Goes steadily NEGATIVE while identity is unreachable, which is what says "identity has
        // been down for four minutes" where an absent token says nothing at all.
        metrics.set('admin_api_service_token_expires_in_seconds', snapshot.expiresInSeconds)
      }
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
export function adminMigrationTargets(): readonly Target[] {
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
 * HOST's, so an in-flight operator execution holds the drain of the process that is actually
 * shutting down — see `HostRuntime.track` for why that matters more here than anywhere else. The
 * two probe methods throw rather than answering plausibly, so if the filter is ever removed the
 * shadowed route fails loudly instead of reporting a readiness it did not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('admin does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('admin does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
