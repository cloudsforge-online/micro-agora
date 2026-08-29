/**
 * The policy module: the decision engine, constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M5a (micro-deploy `docs/service-merge-plan.md`) folds policy into agora's process as the
 * first step of `platform`. All five databases are KEPT — `AGORA_DATABASE_URL`,
 * `DEVPLATFORM_DATABASE_URL`, `POLICY_DATABASE_URL`, `PRICING_DATABASE_URL`,
 * `STUDIO_DATABASE_URL`, no schema merge — and the five schemas own **`inbox` and `jobs` in all
 * five of them**, with `outbox`, `event_subscriptions` and `outbox_deliveries` in four.
 *
 * That is what makes this boundary different from an ordinary module seam. A handler handed the
 * wrong handle does not fail. `insert into inbox …` SUCCEEDS against another module's inbox and
 * dedupes an event this database has never seen — no exception, no log line, no metric. The only
 * way to know is a reconciliation nobody runs.
 *
 * So the boundary is made out of SCOPE and out of TYPE, in four layers, each of which fails on its
 * own:
 *
 *   1. **`./env.ts` is imported HERE and nowhere above.** `POLICY_DATABASE_URL` enters the process
 *      in this file's import graph and in no other. `src/index.ts` — the merged composition root —
 *      never sees a DSN of this module's, so it cannot hand one anywhere.
 *   2. **Every route this module exports carries `RouteSpec.sql`**, stamped once by
 *      `mountableRoutes` in `./server.ts`, over the whole table. The kernel resolves `ctx.sql`
 *      from the selector the route named, so a policy handler is handed policy's database by
 *      construction rather than by care.
 *   3. **Each module's handlers close over their OWN deps.** `handle` takes only `ctx`, so no
 *      handler has a `deps` parameter through which the host's queue, verifier or stores could
 *      arrive.
 *   4. **The event webhook is this module's own path.** `POST /v1/events/policy`, verified with
 *      the secrets THIS module read. See `MOUNTED_EVENTS_PATH` in `./server.ts` for why the three
 *      modules that serve a webhook cannot share one, and `../merged.test.ts` for the proof that
 *      each writes its own database.
 *
 * `../merged.test.ts` fails in several places if layer 2 is removed, and it checks THIS module's
 * database directly rather than trusting a 202.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT THIS MODULE IS, AND WHAT IT COSTS THE PROCESS ─────────────────────────────────────────
 *
 * policy is the estate's cleanest merge candidate and the plan said so before the owner overruled
 * the refusal: **pure-local, no outbound HTTP call at all.** It produces no events — there is no
 * `outbox.ts` in it and no `policy.*` topic in `@cloudsforge/contracts-events` — so it registers
 * no `outbox.relay` and collides with nothing on a job kind. Its two kinds,
 * `policy.decisions.retention` and `policy.counters.prune`, are its alone.
 *
 * What it DOES cost is stated rather than glossed:
 *
 *   * **agora is policy's caller.** `POLICY_URL` on the same pod is now a loopback, and the
 *     `depends_on: policy` edge in compose disappears with the container. That does not change
 *     the semantics `agora/src/policyclient.ts` documents — a policy call that fails is still a
 *     `degraded` verdict and an automatic report, never an approval — and it must not: the whole
 *     point of the soft gate is that it survives the gate being absent, and "absent" now includes
 *     "in this process and broken".
 *   * **`prometheus/tiers.yaml` puts policy at tier 1 and agora at tier 2.** One process cannot
 *     have two availability budgets. That is a deploy decision and it is reported in the pull
 *     request rather than decided here.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type { Network } from '@cloudsforge/http'
import type { Probe } from '@cloudsforge/lifecycle'
import { postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, type Metrics } from '@cloudsforge/telemetry'
import type { RouteSpec } from '../kernel.ts'
import type { Target } from '../migratortargets.ts'
import { SERVICE, env } from './env.ts'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { mountableRoutes, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { postgresSnapshotReader, type Db } from './store.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS MODULE COLLIDES WITH NOTHING ON A KIND, AND IT STILL NEEDS THIS LABEL.**
 *
 * `policy.decisions.retention` and `policy.counters.prune` are policy's alone — measured in
 * `../jobcomposition.test.ts` rather than assumed — so `jobs_failed_total{kind=…}` already
 * separates them from every other module's.
 *
 * `jobs_pending` and `jobs_overdue` do not. They carry no `kind` at all, so without a `module`
 * label each module's sample OVERWRITES the others' on every scrape. A wedged queue is then not
 * "high" on the graph — it is ABSENT from it, and nobody alerts on absent, while
 * `deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue` is `expr: jobs_overdue > 0`.
 *
 * So the label is not about the collisions this module happens to avoid; it is about the two
 * gauges every module writes under the same name.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'policy'

/** What the host process supplies. Deliberately nothing this module could hide a handle inside. */
export interface HostRuntime {
  /**
   * The process-wide registry — the object the host's `/metrics` renders, not a view of it.
   *
   * This module registers its `policy_*` specs on it directly (those names collide with nothing)
   * and writes its JOB metrics through `metrics.withLabels({ module })`, which is the family that
   * does collide. A view shares the registry's spec and series maps by reference, so one endpoint
   * carries every module either way.
   */
  readonly metrics: Metrics
  /**
   * The host's identity verifier. ONE JWKS client for the process; every module reads it.
   *
   * Safe because `IDENTITY_JWKS_URL` and `IDENTITY_ISSUER` are estate-wide variables with one value
   * — this module's `env.ts` reads the same two names — so a second `Verifier` would be a second
   * cache of the same keys, refreshed on its own schedule, failing on its own. What a module still
   * decides for itself is what a verified principal is ALLOWED to do: `policy:decide` is checked in
   * `./server.ts` against the `Principal` this returns, and no host can widen it.
   */
  readonly verifier: PrincipalVerifier
  /**
   * The host `Lifecycle`'s `claimingJobs`, as a function.
   *
   * A function and not the `Lifecycle` itself, deliberately. This module has no business marking
   * the process ready or draining it — those are the host's. What it DOES need is the one bit: a
   * replica that has begun draining must stop claiming jobs before it stops serving, in EVERY
   * module, or the drain window is spent running work the pod is about to abandon.
   */
  claimingJobs(): boolean
  /**
   * The host `Lifecycle`'s `track`, as a function.
   *
   * Same argument. This module's routes do not currently hold the drain open, and passing it
   * anyway is what keeps that a fact about the routes rather than a hole waiting for the first one
   * that does.
   */
  track(): () => void
}

/**
 * What the host process gets back. **No field here names a database handle, and that is the
 * point** — see the file header, layer 2.
 */
export interface PolicyModule {
  /**
   * The routes to mount beside agora's, each already closed over this module's deps AND stamped
   * with this module's database selector. Three paths are NOT among them and one is renamed; see
   * `UNMOUNTED` and `MOUNTED_EVENTS_PATH` in `./server.ts`.
   */
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module, for the host's one `Lifecycle`.
   *
   * ONE, and hard. A merged `/readyz` that probed only agora's database would answer 200 while
   * every decision, freeze and clearance was failing, and the balancer would keep sending traffic
   * to it. A LIST rather than one probe so a module that later contributes a second does not have
   * to touch the composition root.
   *
   * This module deliberately does NOT contribute an `identity-jwks` probe: the host already probes
   * that URL, softly, under that name, from the same estate-wide variable. A second copy would be
   * two identical rows in one readiness report and one more thing to keep in step.
   */
  readonly probes: readonly Probe[]
  /** Sample this module's gauges. Called from the host's `/metrics`, never on a timer — rule 8. */
  beforeScrape(): Promise<void>
  /** Start claiming jobs. Called after the schema is asserted and before the socket accepts. */
  start(): Promise<void>
  /** Stop claiming, drain, and close the pools. Registered on the host's shutdown hooks. */
  stop(): Promise<void>
  /** For the host's boot line. The version `assertSchemaAtLeast` was satisfied at. */
  readonly schemaVersion: number
}

/**
 * Build the policy half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take four other modules down for a policy fault at a point where the
 * host has a logger and a `fatal` line to write. Every failure below was an `exit(1)` in the
 * standalone service and still stops the boot — it just stops it one frame further out.
 */
export async function createPolicyModule(host: HostRuntime): Promise<PolicyModule> {
  // 1. Environment — validated on import of ./env.ts, which exits with a structured line naming
  //    the variable and never its value.

  // 2. Telemetry.
  //
  //    `metrics` is the HOST's registry — the object `/metrics` renders. Specs registered on it are
  //    on that page, and this module's domain names are all `policy_`-prefixed, so nothing there
  //    collides with anything.
  //
  //    `jobMetrics` is this module's labelled VIEW, for the two gauges that DO collide. See
  //    `MODULE_LABEL`. A view writes into the same series maps, so every module is still on one
  //    page.
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION })

  // 3. The database pool. Opened before the schema assertion (which is a query) and before the
  //    probe (which closes over it).
  const poolOptions = { max: env.databasePoolMax, onnotice: () => {} }
  const sql = postgres(env.databaseUrl, poolOptions)

  // ── ONE HANDLE PER NETWORK THIS DEPLOYMENT SERVES ────────────────────────────────────────────
  //
  // `POLICY_DATABASE_URL_TESTNET` unset is the single-network case. `networkSql` then holds one
  // handle and REFUSES a testnet request rather than answering it out of mainnet rows —
  // substituting would be a query that SUCCEEDS against the other estate and says nothing.
  const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined

  const close = async (): Promise<void> => {
    await sql.end({ timeout: 5 }).catch(() => {})
    await sqlTestnet?.end({ timeout: 5 }).catch(() => {})
  }

  // ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
  //
  // Every per-network map below keys its primary entry by THIS, never by the literal `mainnet`.
  // Same image, same code, different env: a testnet pod that hardcodes the key holds its own
  // database and its own queue under the other estate's name, and then refuses — or, when the
  // throw escapes a request listener, DIES — on every request the gateway correctly stamped.
  //
  // It happened twice. The handle, then the job plane. `./ownnetwork.test.ts` reads THIS file.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

  // ── ONE PLANE PER NETWORK ───────────────────────────────────────────────────────────────────
  //
  // Pool, handle and queue together. The QUEUE is per-network as much as the pool is: an enqueue is
  // a WRITE, and a job claimed by a runner holding the other estate's handle applies to the other
  // estate's rows and leaves a completed row behind saying it went exactly as intended.
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

  // 4. Assert the schema on EVERY network, not only the first. A testnet database behind on
  //    migrations would otherwise be discovered by the first testnet request rather than at boot.
  try {
    for (const plane of planes) {
      await assertSchemaAtLeast(plane.pool as unknown as DbSql, SCHEMA_VERSION)
    }
  } catch (err) {
    await close()
    throw err
  }

  // 5. THIS MODULE'S SELECTOR, AND WHY EVERY ROUTE BELOW CARRIES IT.
  //
  // The kernel resolves ONE handle per request, from one selector. In a merged process the host's
  // selector is agora's, so a route mounted without this would read agora's database: an
  // `insert into inbox` that SUCCEEDS against a table of the same name belonging to another module
  // and reports nothing. `RouteSpec.sql` is where that is answered, and stamping it in
  // `mountableRoutes` — once, over the whole table — is why no handler had to change.
  const policySql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  )

  // 6. The routes, over THIS module's deps.
  //
  // `lifecycle` is the refusing stub below: `/livez` and `/readyz` are filtered out of the mounted
  // table, and `track()` — which is live — must be the HOST's, so any future route that holds the
  // drain open holds the drain of the process that is actually shutting down.
  //
  // `decide` keeps its boot-time handle as a placeholder exactly as the standalone service did;
  // `forRequest` in `./server.ts` replaces it AND its snapshot reader with the request's network
  // before any route runs. Rebuilding the object while leaving the reader pointed elsewhere is the
  // half that is easy to miss, and it would make every DECISION read one estate while the writes
  // went to the other.
  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      sql: policySql,
      // The fallback for a request with no `CF-Network` header — which is EVERY service-to-service
      // call, because those go container to container and never reach the gateway that stamps one.
      // Unused on the mounted path, because the kernel resolves the network before this module is
      // reached; supplied from the same variable so the two paths cannot disagree.
      singleNetwork: ownNetwork,
      decide: {
        sql: planes[0]!.db,
        reader: postgresSnapshotReader(planes[0]!.db),
        metrics,
        logger,
      },
      eventAcceptSecrets: env.eventAcceptSecrets,
    },
    policySql,
  )

  // 7. The job runners — ONE PER NETWORK, and one per MODULE.
  //
  // A `JobRunner` is bound to ONE `JobQueue`, which is bound to ONE `sql` handle, which is one
  // database. Five databases therefore cannot share a runner even where the kinds do not collide —
  // and four of the five register `outbox.relay`, so `runner.register` would throw
  // `handler already registered for outbox.relay` at boot for those. This module is not one of
  // them, and `../jobcomposition.test.ts` says so as a MEASUREMENT rather than a habit: if
  // `policy.counters.prune` ever stopped being policy's alone it should show up there, not in
  // production.
  let started = false
  const runners = planes.map((plane) => {
    const reschedule = rescheduleRecurring(plane.queue, logger)
    const runner = new JobRunner({
      queue: plane.queue,
      concurrency: 2,
      pollMs: 1_000,
      // Both halves of the answer. `started` is this module's own gate — nothing may be claimed
      // before the host has finished booting — and `host.claimingJobs()` is the drain, which is the
      // host's to decide and must apply to every module at once.
      shouldClaim: () => started && host.claimingJobs(),
      onEvent: (event) => {
        if (event.kind) {
          // EVERY line here goes through the labelled view. `network` distinguishes this runner
          // from the other PLANE, never from the other MODULE.
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
      decisionRetentionDays: env.decisionRetentionDays,
      counterRetentionHours: env.counterRetentionHours,
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
      // The VIEW, not the registry. `jobs_pending` and `jobs_overdue` carry no `kind`, so this is
      // where five modules would otherwise erase each other every scrape. Per network as well,
      // because summed across both planes the gauge reads healthy while one estate's backlog grows
      // for ever.
      for (const plane of planes) {
        const stats = await plane.queue.stats()
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network })
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network })
      }
      // The REGISTRY for the domain gauge — `policy_freezes_active` collides with nothing, and
      // stamping it with a module would make it a different series from the one the alerts and
      // dashboards already name.
      for (const plane of planes) {
        const frozen = await plane.pool<{ n: number }[]>`
          select count(*)::int as n from freezes where cleared_at is null
        `
        metrics.set('policy_freezes_active', frozen[0]?.n ?? 0, { network: plane.network })
      }
    },
    start: async () => {
      started = true
      // Seeded into EVERY queue: an estate with no retention sweep is half-running, not dormant.
      for (const plane of planes) await seedRecurring(plane.queue)
      for (const runner of runners) runner.start()
    },
    stop: async () => {
      started = false
      // The runners stop FIRST, so a prune in flight is allowed to finish and commit rather than
      // being cut off mid-transaction with its pool closed under it.
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
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE MIGRATOR MUST NOT IMPORT `./env.ts` EITHER, AND THIS IS WHY IT DOES NOT HAVE TO.**
 *
 * `../migrator.ts` needs two facts about this module — where its databases are and what to apply
 * to them. Reaching for this module's `env` wholesale would put a second entry point in possession
 * of a DSN it has no other reason to hold, in a process nobody thinks of as serving anything. This
 * function returns four scalars and an array of DDL per database, so nothing else can leak with
 * them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function policyMigrationTargets(): readonly Target[] {
  const common = { module: SERVICE, migrations: MIGRATIONS, baselineVersion: BASELINE_VERSION } as const
  return [
    { ...common, network: 'primary', url: env.databaseUrl },
    // One entry until this module's testnet database is adopted into this cluster
    // (`docs/network-consolidation.md` §6), two afterwards. Migrating only the first is the failure
    // that would not show up: the migrator exits 0, the deploy goes green, and the NEXT release's
    // boot-time schema assertion finds the second database behind and refuses to serve testnet.
    ...(env.databaseUrlTestnet ? [{ ...common, network: 'testnet', url: env.databaseUrlTestnet }] : []),
  ]
}

/**
 * The `Lifecycle` shape `mountableRoutes` demands, with the two dead handlers refusing.
 *
 * `ServerDeps.lifecycle` is read in three places: `/livez` and `/readyz`, both filtered out of the
 * mounted table, and `track()`, which is live and must be the HOST's.
 *
 * The two probe methods throw rather than returning a plausible answer, so if the filter is ever
 * removed the shadowed route fails loudly on its first request instead of reporting a readiness it
 * did not compute. Passing the host's real `Lifecycle` wholesale would be worse than useless: it
 * would make those two handlers look alive when they are dead.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('policy does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('policy does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']

/** Named so the host's log line can say which network this module holds without reading `env`. */
export type { Network }
