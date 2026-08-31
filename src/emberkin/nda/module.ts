/**
 * The nda module: the third title in this process, constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M4a (micro-deploy `docs/service-merge-plan.md`, which pre-authorised it in so many words:
 * "`nda` can join later as a third module once the pattern is proven") folds Ninety Days After
 * into emberkin's process. All three databases are KEPT — `EMBERKIN_DATABASE_URL`,
 * `AETHERHOLM_DATABASE_URL`, `NDA_DATABASE_URL`, no schema merge — and the three schemas own
 * **four tables of the same name in all three of them**: `outbox`, `event_subscriptions`,
 * `outbox_deliveries` and `inbox`.
 *
 * That is what makes this boundary different from an ordinary module seam. A handler handed the
 * wrong handle does not fail. `insert into inbox …` SUCCEEDS against another title's inbox and
 * dedupes an event this database has never seen — no exception, no log line, no metric. The only
 * way to know is a reconciliation nobody runs.
 *
 * So the boundary is made out of SCOPE and out of TYPE, in four layers, each of which fails on its
 * own — the same four `aetherholm/module.ts` documents, for the same reasons:
 *
 *   1. **`./env.ts` is imported HERE and nowhere above.** `NDA_DATABASE_URL` and
 *      `NDA_IDENTITY_CREDENTIAL` enter the process in this file's import graph and in no other.
 *      `src/index.ts` — the merged composition root — never sees a DSN or a credential of this
 *      module's, so it cannot hand one anywhere.
 *   2. **Every route this module exports carries `RouteSpec.sql`**, stamped once by
 *      `mountableRoutes` in `./server.ts`, over the whole table. The kernel resolves `ctx.sql`
 *      from the selector the route named, so an nda handler is handed nda's database by
 *      construction rather than by care.
 *   3. **Each module's handlers close over their OWN deps.** `handle` takes only `ctx`, so no
 *      handler has a `deps` parameter through which the host's queue, billing client or pools
 *      could arrive. `deps.queueFor` reaches ONE database's `jobs` table; sharing a bag would put
 *      this title's `world.tick` rows in emberkin's database, where nothing claims them.
 *   4. **`inbound.deliver` takes a NETWORK, never a handle.** The one route this module does not
 *      mount — `POST /v1/events`, emberkin's — reaches it through an interface with no parameter
 *      a database handle could arrive through. It resolves its own.
 *
 * `../merged.test.ts` fails in two places if layer 2 is removed, and it checks THIS module's
 * database directly rather than trusting a 202.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT THIS MODULE ADDS THAT AETHERHOLM'S DID NOT ────────────────────────────────────────────
 *
 * aetherholm calls nothing at all. This one calls billing and worlds, and holds
 * `NDA_IDENTITY_CREDENTIAL` to do it. Three consequences, all deliberate:
 *
 *   * **Its upstream set is a strict SUBSET of the host's.** emberkin already reaches ledger,
 *     billing, worlds and identity; this module reaches billing, worlds and identity. So the
 *     merged process's reach does not widen by a single peer — which is the whole argument for
 *     this wave, and it is checked rather than asserted in `../mergedupstreams.test.ts`.
 *   * **It brings a HARD readiness probe of its own**, `nda-identity-credential`. That is nda's
 *     standalone behaviour preserved exactly: a replica with no credential can make no
 *     authenticated call and must take no traffic. It is also the one place where this merge
 *     genuinely widens what can make the pod unready, and `../merged.test.ts` says so.
 *   * **It does NOT re-probe billing, worlds or the JWKS.** The host already probes those three
 *     URLs, softly, under those three names, read from the same estate-wide variables. A second
 *     copy would be two identical checks in one `/readyz` report and one more thing to keep in
 *     step.
 *
 * Everything else below is `nda/src/index.ts` as it stood, in the same order and for the same
 * stated reasons. What changed is only what a module in somebody else's process cannot own: the
 * listener, the `Lifecycle` and the `Metrics` registry are the HOST's and are passed in; the
 * database pools, the job planes and the job runners are this module's and are built here.
 *
 * What this file deliberately does **not** do: run migrations. That is `../migrator.ts`, a
 * separate one-shot. It asserts the schema version and refuses to serve below it, because below
 * `SCHEMA_VERSION` the jobs, outbox and idempotency tables may not exist, and the
 * `players_world_user_uniq` index that keeps one account to one survivor may not exist either.
 */

import postgres from 'postgres';
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db';
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs';
import { serviceTokenProbe } from '@cloudsforge/auth';
import type { Network } from '@cloudsforge/http';
import type { Probe } from '@cloudsforge/lifecycle';
import { postgresProbe } from '@cloudsforge/lifecycle';
import { Logger, type Metrics } from '@cloudsforge/telemetry';
import type { RouteSpec } from '../../kernel.ts';
import type { InboundOutcome, InboundSink } from '../routes.ts';
import type { Target } from '../../migratortargets.ts';
import { SERVICE, env } from './env.ts';
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';
import {
  SUBSCRIBED_TOPICS,
  applyInboundEvent,
  mountableRoutes,
  registerServiceMetrics,
  type PrincipalVerifier,
} from './server.ts';
import { onRunnerEvent, registerHandlers, seedRecurring } from './jobs.ts';
import { buildUpstreams } from './upstreams.ts';
import type { Db } from './outbox.ts';

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS MODULE COLLIDES WITH THE HOST ON THREE JOB KINDS, NOT ONE.** Measured, in
 * `../jobcomposition.test.ts`, rather than asserted from memory:
 *
 *   * `outbox.relay`       — registered by all three modules in this process.
 *   * `achievement.sweep`  — registered by emberkin AND by this module.
 *   * `achievement.deliver`— registered by emberkin AND by this module.
 *
 * Wave M3 had one such collision. Without a `module` label,
 * `jobs_failed_total{kind="achievement.deliver"}` is the sum of two unrelated bridges into two
 * different `worlds` profiles, and no query can take them apart — an alert fires and names a
 * service that is now three titles.
 *
 * `jobs_pending` and `jobs_overdue` are worse, and they are what
 * `deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue` alerts on: they carry no `kind` at
 * all, so without this label each module's sample OVERWRITES the others' on every scrape. A wedged
 * queue is then not "high" on the graph — it is ABSENT from it, and nobody alerts on absent. This
 * module wrote them with a `network` label only, which distinguishes its two planes from each
 * other and never from emberkin's two.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'nda';

/** What the host process supplies. Deliberately nothing this module could hide a handle inside. */
export interface HostRuntime {
  /**
   * The process-wide registry — the object the host's `/metrics` renders, not a view of it.
   *
   * This module registers its `nda_*` specs on it directly (those names collide with nothing) and
   * writes its JOB metrics through `metrics.withLabels({ module })`, which is the family that does
   * collide — see `MODULE_LABEL`. A view shares the registry's spec and series maps by reference,
   * so one endpoint carries every module either way.
   */
  readonly metrics: Metrics;
  /**
   * The host's identity verifier. ONE JWKS client for the process; every module reads it.
   *
   * Safe because `IDENTITY_JWKS_URL` and `IDENTITY_ISSUER` are estate-wide variables with one value
   * — this module's `env.ts` reads the same two names — so a second `Verifier` would be a second
   * cache of the same keys, refreshed on its own schedule, failing on its own. What a module still
   * decides for itself is what a verified principal is ALLOWED to do: `nda:write` is checked in
   * `./server.ts` against the `Principal` this returns, and no host can widen it.
   */
  readonly verifier: PrincipalVerifier;
  /**
   * The host `Lifecycle`'s `claimingJobs`, as a function.
   *
   * A function and not the `Lifecycle` itself, deliberately. This module has no business marking
   * the process ready or draining it — those are the host's, and one of the two ways a merged
   * process goes wrong is a module deciding a lifetime it does not own. What it DOES need is the
   * one bit: a replica that has begun draining must stop claiming jobs before it stops serving, in
   * EVERY module, or the drain window is spent running work the pod is about to abandon.
   */
  claimingJobs(): boolean;
  /**
   * The host `Lifecycle`'s `track`, as a function.
   *
   * Same argument. A day resolution holds the drain open for the work it started; in the merged
   * process that has to be the HOST's drain, or a shutdown would cut an in-flight resolution that
   * the module thought it had protected.
   */
  track(): () => void;
}

/**
 * What the host process gets back. **No field here names a database handle, and that is the
 * point** — see the file header, layers 2 and 4.
 */
export interface NdaModule {
  /**
   * The routes to mount beside emberkin's and aetherholm's, each already closed over this module's
   * deps AND stamped with this module's database selector. Four paths are NOT among them; see
   * `UNMOUNTED` in `./server.ts`.
   */
  readonly routes: readonly RouteSpec<Db>[];
  /**
   * This module's half of the process's one event webhook. See `InboundSink` in `../routes.ts`
   * for why a fan-out is the only correct shape when all three titles subscribe to
   * `identity.user.deleted`.
   */
  readonly inbound: InboundSink;
  /**
   * The readiness probes for THIS module, for the host's one `Lifecycle`.
   *
   * TWO, and both hard, and that is not padding:
   *
   *   * `postgres-nda` — a merged `/readyz` that probed only emberkin's database would answer 200
   *     while every world, homestead and day resolution was failing, and the balancer would keep
   *     sending traffic to it.
   *   * `nda-identity-credential` — this module holds its own credential and its own peer clients.
   *     Without one, every call to billing and worlds answers 503 and the equip button and the
   *     achievement bridge are both dead. nda's standalone `/readyz` reported that as a hard
   *     failure and this one must too.
   *
   * `aetherholm-web` reads `/readyz` through `cf-api-aetherholm-readyz` to decide whether to tell a
   * player the game is up (`deploy/gateway/dynamic/estate-web.yml:1880`), and emberkin has no
   * `/readyz` router of its own — so those are the only public readiness in this process, and a
   * degraded module now shows as THAT game being down. `../merged.test.ts` takes this module's
   * database away and asserts the endpoint says so while the other two probes still pass.
   */
  readonly probes: readonly Probe[];
  /** Sample this module's gauges. Called from the host's `/metrics`, never on a timer — rule 8. */
  beforeScrape(): Promise<void>;
  /** Start claiming jobs. Called after the schema is asserted and before the socket accepts. */
  start(): Promise<void>;
  /** Stop claiming, drain, and close the pools. Registered on the host's shutdown hooks. */
  stop(): Promise<void>;
  /** For the host's boot line. The version `assertSchemaAtLeast` was satisfied at. */
  readonly schemaVersion: number;
}

/**
 * Build the nda half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take two other titles down for an nda fault at a point where the host
 * has a logger and a `fatal` line to write. Every failure below was an `exit(1)` in the standalone
 * service and still stops the boot — it just stops it one frame further out.
 */
export async function createNdaModule(host: HostRuntime): Promise<NdaModule> {
  // 1. Environment — validated on import of ./env.ts, which exits with a structured line naming
  //    the variable and never its value.

  // 2. Telemetry.
  //
  //    `metrics` is the HOST's registry — the object `/metrics` renders. Specs registered on it are
  //    on that page, and this module's domain names are all `nda_`-prefixed, so nothing there
  //    collides with anything.
  //
  //    `jobMetrics` is this module's labelled VIEW, and it exists for the families that DO collide.
  //    See `MODULE_LABEL`. A view writes into the same series maps, so every module is still on one
  //    page — see `Metrics.withLabels` (micro-runtime#9).
  const metrics = host.metrics;
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL });
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env });
  registerServiceMetrics(metrics);
  logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION });

  // 3. The database pool. Opened before the schema assertion (which is a query) and before the
  //    probe (which closes over it).
  const poolOptions = { max: env.databasePoolMax, onnotice: () => {} };
  const sql = postgres(env.databaseUrl, poolOptions);

  // ── ONE HANDLE PER NETWORK THIS DEPLOYMENT SERVES ────────────────────────────────────────────
  //
  // `NDA_DATABASE_URL_TESTNET` unset is the single-network case. `networkSql` then holds one handle
  // and REFUSES a testnet request rather than answering it out of mainnet rows — substituting would
  // be a query that SUCCEEDS against the other estate and says nothing.
  const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined;

  const close = async (): Promise<void> => {
    await sql.end({ timeout: 5 }).catch(() => {});
    await sqlTestnet?.end({ timeout: 5 }).catch(() => {});
  };

  // ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
  //
  // Every per-network map below keys its primary entry by THIS, never by the literal `mainnet`.
  // Same image, same code, different env: a testnet pod that hardcodes the key holds its own
  // database and its own queue under the other estate's name, and then refuses — or, when the
  // throw escapes a request listener, DIES — on every request the gateway correctly stamped.
  //
  // It happened twice. The handle, then the job plane. `./ownnetwork.test.ts` reads THIS file.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet';

  // ── ONE PLANE PER NETWORK ───────────────────────────────────────────────────────────────────
  //
  // Pool, handle and queue together. The QUEUE is per-network as much as the pool is: an enqueue is
  // a WRITE, and a job claimed by a runner holding the other estate's handle applies to the other
  // estate's rows and leaves a completed row behind saying it went exactly as intended.
  const queueOver = (handle: typeof sql): JobQueue =>
    new JobQueue(handle as unknown as JobsSql, { owner: env.instanceId, leaseMs: env.tickLeaseMs });

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
  ];
  const planeFor = (network: Network): (typeof planes)[number] => {
    const plane = planes.find((p) => p.network === network);
    if (!plane) throw new Error(`no plane for network ${network}`);
    return plane;
  };

  // 4. Assert the schema on EVERY network, not only the first. A testnet database behind on
  //    migrations would otherwise be discovered by the first testnet request rather than at boot.
  try {
    for (const plane of planes) {
      await assertSchemaAtLeast(plane.pool as unknown as DbSql, SCHEMA_VERSION);
    }
  } catch (err) {
    await close();
    throw err;
  }

  // 5. THIS MODULE'S SELECTOR, AND WHY EVERY ROUTE BELOW CARRIES IT.
  //
  // The kernel resolves ONE handle per request, from one selector. In a merged process the host's
  // selector is emberkin's, so a route mounted without this would read emberkin's database: an
  // `insert into inbox` that SUCCEEDS against a table of the same name belonging to another game
  // and reports nothing. `RouteSpec.sql` is where that is answered, and stamping it in
  // `mountableRoutes` — once, over the whole table — is why no handler had to change.
  const ndaSql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  );

  // 6. The upstreams, and the credential that authenticates every call to them. There is still no
  //    ledger client, on purpose: this title moves no value at all, and nothing about running
  //    inside a process that DOES hold one changes that — `../index.ts` has no parameter through
  //    which emberkin's ledger client could arrive here.
  const upstreams = buildUpstreams(env, {
    onEvent: (event) => {
      if (event.kind === 'exchange_failed') {
        // `warn`, not `error`, while a usable token is still held: the 20% slack after the refresh
        // point exists precisely so a few of these are survivable and uninteresting.
        logger[event.hadUsableToken ? 'warn' : 'error']('service token exchange failed', {
          err: event.err,
          hadUsableToken: event.hadUsableToken,
        });
      } else if (event.kind === 'minted') {
        // Never the token and never the credential: a mint carries a service name, an `expiresIn`
        // and a refresh interval. Both values are live credentials.
        logger.info('service token minted', {
          service: event.service,
          expiresIn: event.expiresIn,
          refreshInMs: event.refreshInMs,
        });
      } else {
        logger.warn('service token', { event: event.kind, url: event.url });
      }
    },
  });
  const { identityTokens, billing, worlds } = upstreams;

  if (!identityTokens) {
    // Not `fatal` and not a throw: the image must be able to boot without this so CI's startup
    // smoke test can read /livez, and a module that refused to start would take two healthy titles
    // down with it. `/readyz` is where the absence is enforced — the probe below is HARD, so an
    // unconfigured replica takes no traffic for ANY of the three titles.
    logger.error('NDA_IDENTITY_CREDENTIAL is not set; every call to a peer will fail 503', {
      hint: 'deploy/scripts/estate-bootstrap.sh writes it to compose/estate/tokens.env',
    });
  }
  if (env.legacyServiceTokenPresent) {
    logger.error('NDA_SERVICE_TOKEN is set and is IGNORED', {
      hint: 'it was a 600-second token read once at boot; NDA_IDENTITY_CREDENTIAL replaces it',
    });
  }

  // 7. The routes, over THIS module's deps.
  //
  // `lifecycle` is the refusing stub below: `/livez` and `/readyz` are filtered out of the mounted
  // table, and `track()` — which is live — must be the HOST's, so an in-flight day resolution holds
  // the drain of the process that is actually shutting down.
  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      sql: ndaSql,
      // The fallback for a request with no `CF-Network` header — which is EVERY service-to-service
      // call, because those go container to container and never reach the gateway that stamps one.
      // `requestNetwork` still prefers the header, so this cannot mask a mis-stamped external
      // request; it only answers the internal callers that never had one.
      singleNetwork: ownNetwork,
      producer: SERVICE,
      billing,
      queueFor: (network: Network) => planeFor(network).queue,
      // The STANDALONE listener's inbound secret. Unused on this path: `POST /v1/events` is not
      // among the mounted routes, and the host verifies against its own accept list before this
      // module is reached at all. Supplied because `ServerDeps` demands it, and supplied from the
      // same variable, so the two paths cannot disagree about which key is nda's.
      eventSigningSecret: env.outboxSigningSecret,
    },
    ndaSql,
  );

  // 8. The job runners — ONE PER NETWORK.
  //
  // ── AND ITS OWN RUNNERS, WHICH IS FORCED RATHER THAN CHOSEN ──────────────────────────────────
  //
  // A `JobRunner` is bound to ONE `JobQueue`, which is bound to ONE `sql` handle, which is one
  // database. Three databases therefore cannot share a runner even if the kinds did not collide —
  // and they do, three times over: `outbox.relay` in all three modules, and `achievement.sweep` and
  // `achievement.deliver` shared with emberkin, so `runner.register` would throw `handler already
  // registered for outbox.relay` at boot.
  //
  // That throw is a GOOD failure and it is deliberately still reachable: `../jobcomposition.test.ts`
  // builds one runner, registers two modules' handlers on it, and asserts it throws. The point of
  // keeping it provable is that the SILENT shape is the one next door — this process already runs
  // one runner per network plane per module, so "add another runner" is the natural move, and N
  // runners all counting `kind="achievement.deliver"` into an unlabelled registry is a sum nothing
  // complains about. Separate runners are correct; `MODULE_LABEL` is what makes them readable.
  let started = false;
  const runners = planes.map((plane) => {
    const runner = new JobRunner({
      queue: plane.queue,
      concurrency: 4,
      pollMs: 1_000,
      // Both halves of the answer. `started` is this module's own gate — nothing may be claimed
      // before the host has finished booting — and `host.claimingJobs()` is the drain, which is the
      // host's to decide and must apply to every module at once.
      shouldClaim: () => started && host.claimingJobs(),
      onEvent: (event) => {
        if (event.kind) {
          // EVERY line here goes through the labelled view. `network` distinguishes this runner
          // from the other PLANE, never from the other MODULE — emberkin registers
          // `achievement.sweep` and `achievement.deliver` too, and all three register
          // `outbox.relay`.
          const labels = { kind: event.kind, network: plane.network };
          if (event.type === 'claimed') jobMetrics.increment('jobs_claimed_total', labels);
          if (event.type === 'completed') jobMetrics.increment('jobs_completed_total', labels);
          if (event.type === 'failed') jobMetrics.increment('jobs_failed_total', labels);
          if (event.type === 'dead') jobMetrics.increment('jobs_dead_total', labels);
          if (event.durationMs !== undefined) jobMetrics.observe('jobs_duration_ms', event.durationMs, labels);
        }
        onRunnerEvent(plane.queue, logger)(event);
      },
    });
    registerHandlers(runner, {
      sql: plane.db,
      logger,
      metrics: jobMetrics,
      worlds,
      producer: SERVICE,
      signingSecret: env.outboxSigningSecret,
      tickBatchSize: env.tickBatchSize,
      queue: plane.queue,
    });
    return runner;
  });

  return {
    routes,
    inbound: {
      module: MODULE_LABEL,
      topics: SUBSCRIBED_TOPICS,
      deliver: async (
        network: Network,
        topic: string,
        eventId: string,
        payload: Record<string, unknown>,
      ): Promise<InboundOutcome> => {
        // THIS MODULE'S HANDLE, RESOLVED FROM THIS MODULE'S SELECTOR. The host passes a network
        // and never a handle, so the erasure below cannot be aimed at emberkin's or aetherholm's
        // database — where it would find an `inbox` table of the same name and the same columns
        // and do something plausible and wrong.
        const handle = ndaSql.for(network) as unknown as Db;
        const outcome = await applyInboundEvent(handle, logger, topic, eventId, payload);
        if (outcome.status === 'duplicate') return { status: 'duplicate' };
        if (outcome.status === 'rejected') {
          // A RESULT and not a throw: the host maps this to the same 400 the standalone route
          // answered. A deletion we cannot perform must not be acknowledged as performed.
          return { status: 'rejected', reason: outcome.reason };
        }
        // Counts only. The erased id is never logged — writing it into the log would recreate, in
        // the one store nothing erases, exactly what the request was to remove.
        return { status: 'processed', detail: { erased: outcome.erased } };
      },
    },
    probes: [
      postgresProbe('postgres-nda', (signal) =>
        Promise.race([
          sql`select 1`,
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true });
          }),
        ]),
      ),
      // HARD, and named for this module rather than taking the package default of
      // `identity-credential`: the merged `/readyz` reports one flat list of check names, and two
      // modules each contributing an `identity-credential` would be two rows nobody could tell
      // apart. It does not report a peer having a bad minute — it fails only when no credential is
      // configured at all, which is a deployment that cannot make a single authenticated call and
      // will not fix itself.
      serviceTokenProbe(identityTokens, { name: 'nda-identity-credential' }),
    ],
    beforeScrape: async () => {
      // The VIEW, not the registry. `jobs_pending` and `jobs_overdue` carry no `kind`, so this is
      // where three modules would otherwise erase each other every scrape — and `JobQueueOverdue`
      // would then alert on whichever queue happened to sample last. Per network as well, because
      // summed across both planes the gauge reads healthy while one estate's backlog grows for
      // ever.
      for (const plane of planes) {
        const stats = await plane.queue.stats();
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network });
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network });
      }
    },
    start: async () => {
      started = true;
      // Seeded into EVERY queue: an estate with no recurring sweep is half-running, not dormant.
      // Awaited rather than fired and forgotten, because a world sweep that never got seeded is a
      // game whose days stop advancing and nothing anywhere says so.
      for (const plane of planes) await seedRecurring(plane.queue);
      for (const runner of runners) runner.start();
    },
    stop: async () => {
      started = false;
      // The runners stop FIRST, so a day resolution in flight is allowed to finish and commit
      // rather than being cut off mid-transaction with its pool closed under it.
      const clean = (await Promise.all(runners.map((r) => r.stop(20_000)))).every(Boolean);
      logger.info('job runners stopped', { clean, runners: runners.length });
      await close();
      logger.info('database pools closed', { networks: planes.length });
    },
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * The databases this module owns, for the merged migrator.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE MIGRATOR MUST NOT IMPORT `./env.ts` EITHER, AND THIS IS WHY IT DOES NOT HAVE TO.**
 *
 * `../migrator.ts` needs two facts about this module — where its databases are and what to apply
 * to them. Reaching for this module's `env` wholesale would put a second entry point in possession
 * of a DSN and a service credential it has no other reason to hold, in a process nobody thinks of
 * as serving anything. This function returns four scalars and an array of DDL per database, so
 * nothing else can leak with them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function ndaMigrationTargets(): readonly Target[] {
  const common = { module: SERVICE, migrations: MIGRATIONS, baselineVersion: BASELINE_VERSION } as const;
  return [
    { ...common, network: 'primary', url: env.databaseUrl },
    // One entry until this module's testnet database is adopted into this cluster
    // (`docs/network-consolidation.md` §6), two afterwards. Migrating only the first is the failure
    // that would not show up: the migrator exits 0, the deploy goes green, and the NEXT release's
    // boot-time schema assertion finds the second database behind and refuses to serve testnet.
    ...(env.databaseUrlTestnet ? [{ ...common, network: 'testnet', url: env.databaseUrlTestnet }] : []),
  ];
}

/**
 * The `Lifecycle` shape `mountableRoutes` demands, with the two dead handlers refusing.
 *
 * `ServerDeps.lifecycle` is read in three places: `/livez` and `/readyz`, both filtered out of the
 * mounted table, and `track()`, which is live and must be the HOST's — a day resolution that holds
 * the drain open has to hold the drain of the process that is actually shutting down.
 *
 * The two probe methods throw rather than returning a plausible answer, so if the filter is ever
 * removed the shadowed route fails loudly on its first request instead of reporting a readiness it
 * did not compute. Passing the host's real `Lifecycle` wholesale would be worse than useless: it
 * would make those two handlers look alive when they are dead.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('nda does not serve /livez in the merged process — emberkin does');
    },
    readyz: () => {
      throw new Error('nda does not serve /readyz in the merged process — emberkin does');
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle;
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle'];
