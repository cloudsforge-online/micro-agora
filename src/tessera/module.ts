/**
 * The tessera module: the title's world server, constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M5b (micro-deploy `docs/service-merge-plan.md`) folds tessera into agora's process as part
 * of the `platform` seed. Every module's database is KEPT — no schema merge — and each schema owns
 * `inbox` and `jobs`, with `outbox`, `event_subscriptions` and `outbox_deliveries` in this one too.
 *
 * A handler handed the wrong handle does not fail. `insert into inbox …` SUCCEEDS against another
 * module's inbox and dedupes an event this database has never seen; `insert into outbox …`
 * SUCCEEDS into another module's relay, where a job kind this module never registered will try to
 * deliver it. The four layers that make that unspellable are the ones `./pricing/module.ts`
 * documents: `./env.ts` imported here and nowhere above, every route stamped with `RouteSpec.sql`
 * by `mountableRoutes`, handlers closed over this module's deps, and no interface with a parameter a
 * foreign handle could arrive through.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE TWO SECRETS THIS MODULE KEEPS APART, AND WHY THE MERGE MUST NOT COLLAPSE THEM ───────────
 *
 * `INBOUND_SIGNING_SECRET` (`env.inboundSigningSecrets`) verifies deliveries ARRIVING at
 * `POST /v1/events` — it reaches the event route as `eventAcceptSecrets`. `OUTBOX_SIGNING_SECRET`
 * (`env.outboxSigningSecret`) signs what this module's own relay EMITS — it reaches the job runner
 * as `JobDeps.signingSecret`. They are two different variables by design (see `./env.ts`), and this
 * factory wires each to exactly one direction: the inbound list to the route, the outbox secret to
 * the relay, never crossed. `./server.ts`'s `MOUNTED_EVENTS_PATH` carries why three modules that
 * all mount `POST /v1/events` cannot share one verifier and so cannot share one route.
 *
 * ── THE OUTBOUND CLIENTS, KEPT, AND WHY NONE OF THEM IS A READINESS PROBE ───────────────────────
 *
 * tessera dials studio (the Kiln), the ledger (grants, booking escrow, the wallet strip), the
 * market (listings) and community (ward governance) — each an estate-wide service, each its OWN
 * client built from `./upstreams.ts`, each with the same "absence is a supported mode" contract
 * `./upstreams.ts` argues at length. That file also argues why NONE of them is wired as a readiness
 * probe: almost every route is served from this module's own tables, the routes that do need an
 * upstream already answer 503 honestly, and pulling the replica would fix nothing because every
 * replica reads the same environment. This factory keeps that decision — the only probe below is
 * postgres, HARD.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type { Probe } from '@cloudsforge/lifecycle'
import { postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, type Metrics } from '@cloudsforge/telemetry'
import type { RouteSpec } from '../kernel.ts'
import type { Target } from '../migratortargets.ts'
import { SERVICE } from './service.ts'
import { env } from './env.ts'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { mountableRoutes, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { KILN_FIRE_KIND, registerHandlers, rescheduleRecurring, seedRecurring, type JobDeps } from './jobs.ts'
import { createPresenceHub } from './presence.ts'
import { buildUpstreams } from './upstreams.ts'
import { wardCommunitySlug } from './communityclient.ts'
import { issueObjectToAuthor, walletOf } from './ledgerclient.ts'
import { activateListing } from './economy.ts'
import { bindWardCommunity } from './world.ts'
import { firingLeaseKey } from './kiln.ts'
import type { Db } from './outbox.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS MODULE COLLIDES WITH OTHERS ON `outbox.relay`.** Measured in `../jobcomposition.test.ts`
 * rather than asserted from memory: agora, devplatform, pricing, studio and this module all
 * register a kind spelled exactly `outbox.relay`, so `jobs_failed_total{kind="outbox.relay"}` would
 * be the sum of several unrelated relays without a `module` label to separate them.
 *
 * `jobs_pending` and `jobs_overdue` are worse still, because they carry no `kind` at all: each
 * module's sample would OVERWRITE the others' on every scrape, so a wedged queue is ABSENT from the
 * graph rather than high — and `deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue` alerts on
 * exactly that gauge. The `module` label from `jobMetrics` is what keeps every one of them separate.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'tessera'

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
export interface TesseraModule {
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module.
   *
   * ONE, and hard: a merged `/readyz` that probed only agora's database would answer 200 while
   * every ward read, every claim, every firing and every provision was failing. The outbound
   * clients are NOT here — `./upstreams.ts` argues why a title whose Kiln is cold is still a title
   * you can walk around in, and a hard probe on an optional upstream would remove the whole merged
   * replica from the balancer over a dependency most routes never touch.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  readonly schemaVersion: number
}

/**
 * Build the tessera half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take every other module down for a tessera fault at a point where the
 * host has a logger and a `fatal` line to write.
 */
export async function createTesseraModule(host: HostRuntime): Promise<TesseraModule> {
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
  // Same image, same code, different env: a testnet pod that hardcodes the key holds its own
  // database and its own queue under the other estate's name, and then refuses every request the
  // gateway correctly stamped. `./ownnetwork.test.ts` reads THIS file.
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

  try {
    for (const plane of planes) {
      await assertSchemaAtLeast(plane.pool as unknown as DbSql, SCHEMA_VERSION)
    }
  } catch (err) {
    await close()
    throw err
  }

  const tesseraSql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  )

  // ── PRESENCE: ONE `LISTEN` PER DATABASE, SOFT ───────────────────────────────────────────────
  //
  // Per plane, because `listen()` binds to one connection which binds to one database, and each
  // estate's live movement is its own stream. Soft, exactly as the standalone had it: without the
  // hub the map still renders, parcels still claim, objects still fire, and only the live movement
  // of other avatars is missing, so refusing to boot over it would take the whole title down for a
  // feature the player can walk around without.
  const presences = await Promise.all(
    planes.map((plane) =>
      createPresenceHub(plane.db).catch((err: unknown) => {
        logger.error('presence hub unavailable; the world serves without live movement', {
          err,
          network: plane.network,
        })
        return undefined
      }),
    ),
  )

  // ── THE UPSTREAMS, AND THE CREDENTIAL PRESENTED TO TWO OF THE FOUR ───────────────────────────
  //
  // Built ONCE — studio, the ledger, the market and community are estate-wide services, not
  // per-network databases, so a second plane does not mean a second client. The whole argument for
  // why market and community deliberately hold no credential, and why no readiness probe is wired,
  // lives in `./upstreams.ts`.
  const upstreams = buildUpstreams(env, {
    studioLogger: logger.child({ upstream: 'studio' }),
    onEvent: (event) => {
      metrics.increment('tessera_service_token_events_total', { kind: event.kind })
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
        // token is still held is exactly the outage the provider is built to ride out.
        logger.warn('service credential exchange failed', { ...event })
      }
    },
  })
  const { studio, ledger, market, community } = upstreams

  // Said at boot, at the level its consequence deserves, because the alternative is a world that
  // looks entirely healthy while its Kiln cannot fire and its treasury cannot pay. `static` is
  // FATAL and `none` is not: "no upstream is configured" is a mode this module promises to support,
  // while "an upstream is configured and the credential cannot renew" is a container that will start
  // refusing about ten minutes from now.
  const credentialedUpstream = Boolean(env.studioUrl ?? env.ledgerUrl)
  if (upstreams.mode === 'static') {
    logger.fatal(
      'EXPIRING TOKEN, NOT A CREDENTIAL — every Kiln firing and every EMBER grant will 401 about ten minutes from now',
      {
        whatWillHappen:
          'TESSERA_SERVICE_CREDENTIAL holds a token that lives 600s and nothing can renew it. From ' +
          'minute ten studio refuses every firing, so a paid Kiln job dies in the runner and retries ' +
          'into the same 401; the ledger refuses every engagement grant, every booking reservation and ' +
          'every release, so a Venue hold is taken and cannot be returned.',
        remedy:
          'set TESSERA_IDENTITY_CREDENTIAL in the deploy; deploy/compose/estate/tokens.env already holds one',
      },
    )
  } else if (upstreams.mode === 'none' && credentialedUpstream) {
    logger.fatal('AN UPSTREAM IS CONFIGURED AND NO CREDENTIAL IS — every call to it will answer 503', {
      studioUrl: Boolean(env.studioUrl),
      ledgerUrl: Boolean(env.ledgerUrl),
      remedy: 'set TESSERA_IDENTITY_CREDENTIAL (long-lived, cfsc_…, from POST /service-credentials)',
    })
  } else {
    logger.info('service credential mode', { mode: upstreams.mode, identityUrl: env.identityUrl })
  }

  // Absent is a SUPPORTED mode — `env.ts` says so and `.env.example` promises it. The Kiln answers
  // 503 `kiln_unconfigured`, market listings can be drafted but not activated, wards cannot be
  // given a government, and the world still serves.
  if (!studio) {
    logger.info('no Kiln upstream configured; firings will answer 503', {
      studioUrl: Boolean(env.studioUrl),
      credentialMode: upstreams.mode,
    })
  }
  if (!market) {
    logger.info('no market upstream configured; listings can be drafted but not activated', {
      marketUrl: Boolean(env.marketUrl),
      ledgerUrl: Boolean(env.ledgerUrl),
      credentialMode: upstreams.mode,
    })
  }
  if (!community) {
    logger.info('no community upstream configured; wards cannot be given a government', {
      communityUrl: Boolean(env.communityUrl),
    })
  }

  // ── THE SINGLETON SEAMS ─────────────────────────────────────────────────────────────────────
  //
  // `market.activate`, `governance.found` and `enqueueFiring` close over one database handle and
  // one queue, because `ServerDeps` gives them no per-request `ctx.sql` to reach for — exactly as
  // the standalone wired them over its single `sql` and `queue`. They are bound to the PRIMARY
  // plane (`ownNetwork`), which for every single-network deployment — the only shape until the
  // consolidation reaches this service — is the only plane there is. The wallet and escrow seams
  // are network-agnostic: they call the ledger client, which is an estate-wide service, and touch
  // no local table.
  const primary = planes[0]!

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      // The SELECTOR, not a handle — routes use `ctx.sql`, resolved once per request.
      sql: tesseraSql,
      // The fallback for a request with no `CF-Network` header — every service-to-service call.
      singleNetwork: ownNetwork,
      // The RECEIVING half of the estate's event signing: the inbound list, reaching the event
      // route. NOT `outboxSigningSecret`, which signs what the relay EMITS and reaches the runner.
      eventAcceptSecrets: env.inboundSigningSecrets,
      // The primary plane's live-movement stream. No route consumes `deps.presence` today, so the
      // singleton is harmless; it is the primary plane's so its `close()` is accounted for on stop.
      ...(presences[0] ? { presence: presences[0] } : {}),
      ...(market && ledger
        ? {
            market: {
              activate: (input) =>
                activateListing(
                  primary.db,
                  {
                    market,
                    // The ledger call, bound here rather than imported by `economy.ts` — see the
                    // comment on `ActivateDeps.issueObject` for the import cycle it avoids.
                    issueObject: (issue) => issueObjectToAuthor(ledger, issue),
                  },
                  input,
                ),
            },
          }
        : {}),
      // The wallet strip. Bound whenever a LEDGER is configured, independently of market.
      ...(ledger ? { wallet: (subject: string) => walletOf(ledger, subject) } : {}),
      // The Venue calendar's escrow, bound on the same condition: reserve, release and the fee are
      // three of the ledger client's methods, and without a ledger the booking routes answer 503.
      ...(ledger ? { escrow: ledger } : {}),
      ...(community
        ? {
            governance: {
              found: async ({ ward, founderToken, correlationId }) => {
                const created = await community.createCommunity({
                  slug: wardCommunitySlug(ward.slug),
                  name: ward.name,
                  founderToken,
                  // The WARD's id. Community dedupes the POST on it, so a retried founding creates
                  // one community rather than a second one under a slug already taken.
                  idempotencyKey: ward.id,
                  correlationId,
                })
                return bindWardCommunity(primary.db, ward.id, created.id)
              },
            },
          }
        : {}),
      kilnConfigured: Boolean(studio),
      enqueueFiring: async (objectId, subject) => {
        // `owner:<subject>` — the same lease key shape studio uses, so one player's firings
        // serialise consistently on both sides (§11.4).
        await primary.queue.enqueue({
          kind: KILN_FIRE_KIND,
          key: firingLeaseKey(subject),
          payload: { objectId, subject },
          onConflict: 'keep',
        })
      },
    },
    tesseraSql,
  )

  let started = false
  const runners = planes.map((plane) => {
    const jobDeps: JobDeps = {
      sql: plane.db,
      logger,
      // The relay SIGNS with the outbox secret — the opposite direction from `eventAcceptSecrets`.
      signingSecret: env.outboxSigningSecret,
      ...(studio ? { studio } : {}),
    }
    const reschedule = rescheduleRecurring(plane.queue, logger)
    const runner = new JobRunner({
      queue: plane.queue,
      concurrency: 4,
      pollMs: 1_000,
      shouldClaim: () => started && host.claimingJobs(),
      onEvent: (event) => {
        if (event.kind) {
          // EVERY line through the labelled view. `network` distinguishes this runner from the
          // other PLANE; the `module` label baked into `jobMetrics` distinguishes it from the
          // other MODULES that also register `kind="outbox.relay"`.
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
        // Through the VIEW and per NETWORK — the two unlabelled gauges the alert reads, kept from
        // overwriting each other across planes and from being summed across modules.
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network })
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network })
      }
      // Read out of the provider's own memory — no outbound call, so a scrape cannot become load on
      // identity. `static` reads as usable because it IS, for about ten minutes, which is exactly
      // why the second gauge sits beside it. On the REGISTRY: the names are module-unique and
      // process-wide, one credential for the whole module rather than one per plane.
      metrics.set(
        'tessera_service_token_usable',
        upstreams.mode === 'exchanged'
          ? (upstreams.identityTokens?.snapshot().hasUsableToken ?? false)
            ? 1
            : 0
          : upstreams.mode === 'static'
            ? 1
            : 0,
      )
      metrics.set('tessera_service_token_static', upstreams.mode === 'static' ? 1 : 0)
    },
    start: async () => {
      started = true
      for (const plane of planes) await seedRecurring(plane.queue)
      for (const { runner } of runners) runner.start()
    },
    stop: async () => {
      started = false
      const clean = (await Promise.all(runners.map(({ runner }) => runner.stop(20_000)))).every(Boolean)
      logger.info('job runners stopped', { clean, runners: runners.length })
      await Promise.all(presences.map((presence) => presence?.close().catch(() => {})))
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
export function tesseraMigrationTargets(): readonly Target[] {
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
 * HOST's, so an in-flight provision or booking write holds the drain of the process that is
 * actually shutting down. The two probe methods throw rather than answering plausibly, so if the
 * filter is ever removed the shadowed route fails loudly instead of reporting a readiness it did
 * not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('tessera does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('tessera does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
