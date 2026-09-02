/**
 * The aetherholm module: this half of the merged process, constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M3 (micro-deploy `docs/service-merge-plan.md`) folds this title into emberkin's process.
 * Both databases are KEPT — `EMBERKIN_DATABASE_URL` and `AETHERHOLM_DATABASE_URL`, no schema
 * merge — and the two schemas own **six tables of the same name**: `outbox`,
 * `event_subscriptions`, `outbox_deliveries`, `inbox`, `seasons` and `battles`.
 *
 * That is what makes this boundary different from an ordinary module seam. A handler handed the
 * wrong handle does not fail. `select … from seasons` SUCCEEDS, reads the other title's season,
 * and reports nothing — no exception, no log line, no metric. The only way to know is a
 * reconciliation nobody runs.
 *
 * So the boundary is made out of SCOPE and out of TYPE, in four layers, each of which fails on its
 * own:
 *
 *   1. **`./env.ts` is imported HERE and nowhere above.** `AETHERHOLM_DATABASE_URL` enters the
 *      process in this file's import graph and in no other. `src/index.ts` — the merged
 *      composition root — never sees a DSN of this module's, so it cannot hand one anywhere.
 *   2. **Every route this module exports carries `RouteSpec.sql`**, stamped once by
 *      `mountableRoutes` below, over the whole table. The kernel resolves `ctx.sql` from the
 *      selector the route named, so an aetherholm handler is handed aetherholm's database by
 *      construction rather than by care.
 *   3. **Each module's handlers close over their OWN deps.** `handle` takes only `ctx`, so no
 *      handler has a `deps` parameter through which the host's queue, producer or pools could
 *      arrive. `deps.queue` is a handle on ONE database's `jobs` table; sharing a bag would put
 *      this title's `city.queue` rows in emberkin's database, where nothing claims them.
 *   4. **`inbound.deliver` takes a NETWORK, never a handle.** The one route this module does not
 *      mount — `POST /v1/events`, emberkin's — reaches it through an interface with no parameter
 *      a database handle could arrive through. It resolves its own.
 *
 * `merged.test.ts` fails in two places if layer 2 is removed, and it checks THIS module's database
 * directly rather than trusting a 202.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Everything below is `aetherholm/src/index.ts` as it stood, in the same order and for the same
 * stated reasons. What changed is only what a module in somebody else's process cannot own: the
 * listener, the `Lifecycle`, the `Verifier` and the `Metrics` registry are the HOST's and are
 * passed in; the database pools, the job queue and the job runner are this module's and are built
 * here.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot — AD-17 and rule 7. It asserts the schema version and refuses to serve below
 * it, because below `SCHEMA_VERSION` the outbox/inbox tables, the city stock CHECKs and the
 * provision uniqueness may not exist.
 *
 * There are still no upstream clients: this title makes no outbound HTTP call, so its only hard
 * probe is Postgres and it contributes exactly that to the host's readiness.
 */

import postgres from 'postgres';
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db';
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs';
import type { Network } from '@cloudsforge/http';
import type { Probe } from '@cloudsforge/lifecycle';
import { postgresProbe } from '@cloudsforge/lifecycle';
import { Logger, type Metrics } from '@cloudsforge/telemetry';
import type { RouteSpec, RequestContext } from '../../kernel.ts';
import { eraseEveryPlane, planeTotals } from '../../erasureplanes.ts';
import { OPERATIONAL_ROUTES } from '../../kernel.ts';
// ── WHY THESE LIVE IN `./server.ts` AND ARE IMPORTED BACK ───────────────────────────────────
//
// `../../mergedroutes.test.ts` must read `REMOUNTED_PATHS` to assert the split, and it may not
// import THIS file to get it: `./env.ts` validates at import and calls `process.exit(1)`, so a
// test that reached for a `module.ts` would kill the runner rather than fail. Every module in this
// process follows the same rule — mount-time facts live in `server.ts`, which imports no `env`.
import { UNMOUNTED, REMOUNTED_PATHS, TITLE_MOUNT_PREFIX, mountableRoutes } from './server.ts';
export { UNMOUNTED, REMOUNTED_PATHS, TITLE_MOUNT_PREFIX };
import type { InboundOutcome, InboundSink } from '../routes.ts';
import type { Target } from '../../migratortargets.ts';
import { SERVICE, env } from './env.ts';
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';
import { createRoutes, type PrincipalVerifier } from './routes.ts';
import { SUBSCRIBED_TOPICS, registerServiceMetrics } from './server.ts';
import { onRunnerEvent, registerHandlers, seedRecurring } from './jobs.ts';
import { USER_DELETED_TOPIC, eraseUser } from './erasure.ts';
import { withInbox, type Db } from './outbox.ts';

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **BOTH TITLES REGISTER A JOB KIND CALLED `outbox.relay`, EXACTLY.** Without this label,
 * `jobs_failed_total{kind="outbox.relay"}` is the SUM of two unrelated relays and no query can
 * take them apart — an alert fires and names a service that is now two.
 *
 * `jobs_pending` and `jobs_overdue` are worse, and they are what
 * `deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue` alerts on: they carry no `kind` at
 * all, so before this label each module's sample OVERWROTE the other's on every scrape. A wedged
 * queue was then not "high" on the graph — it was ABSENT from it, and nobody alerts on absent.
 * aetherholm wrote them with NO labels and emberkin with `network` only, which does not
 * distinguish it from aetherholm either.
 *
 * There is also a NEAR-MISS family worth knowing about: emberkin registers `season.rollover` and
 * `season.reward`, this module registers `season.ensure` and `season.close`. Those four are
 * distinct strings, so nothing sums them today — but a rule matching `kind=~"season\..*"` would
 * sum two titles' seasons into one number. No such rule exists as of this change
 * (`prometheus/rules/*.yaml`, zero matches for `season`); this note is here so the next person to
 * write one knows the label to add.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'aetherholm';

/** What the host process supplies. Deliberately nothing this module could hide a handle inside. */
export interface HostRuntime {
  /**
   * The process-wide registry — the object the host's `/metrics` renders, not a view of it.
   *
   * This module registers its `aetherholm_*` specs on it directly (those names collide with
   * nothing) and writes its JOB metrics through `metrics.withLabels({ module })`, which is the
   * family that does collide — see `MODULE_LABEL`. A view shares the registry's spec and series
   * maps by reference, so one endpoint carries every module either way.
   */
  readonly metrics: Metrics;
  /** The host's identity verifier. One JWKS client for the process; every module reads it. */
  readonly verifier: PrincipalVerifier;
  /**
   * The host `Lifecycle`'s `claimingJobs`, as a function.
   *
   * A function and not the `Lifecycle` itself, deliberately. This module has no business marking
   * the process ready or draining it — those are the host's, and one of the two ways a merged
   * process goes wrong is a module deciding a lifetime it does not own. What it DOES need is the
   * one bit: a replica that has begun draining must stop claiming jobs before it stops serving, in
   * BOTH modules, or the drain window is spent running work the pod is about to abandon.
   */
  claimingJobs(): boolean;
  /**
   * The host `Lifecycle`'s `track`, as a function.
   *
   * Same argument. This title's queue submissions and provisions hold the drain open for the work
   * they started; in the merged process that has to be the HOST's drain, or a shutdown would cut
   * an in-flight city founding that the module thought it had protected.
   */
  track(): () => void;
}

/**
 * What the host process gets back. **No field here names a database handle, and that is the
 * point** — see the file header, layers 2 and 4.
 */
export interface AetherholmModule {
  /**
   * The routes to mount beside emberkin's, each already closed over this module's deps AND
   * stamped with this module's database selector. Four paths are NOT among them; see
   * `mountableRoutes` below.
   */
  readonly routes: readonly RouteSpec<Db>[];
  /**
   * This module's half of the process's one event webhook. See `InboundSink` in `../routes.ts`
   * for why a fan-out is the only correct shape when every title subscribes to
   * `identity.user.deleted`.
   */
  readonly inbound: InboundSink;
  /**
   * The readiness probe for THIS module's database, for the host's one `Lifecycle`.
   *
   * Hard, and that is the whole reason it is returned rather than kept: a merged `/readyz` that
   * probed only emberkin's database would answer 200 while every city, fleet and provision was
   * failing, and the balancer would keep sending traffic to it. `aetherholm-web` reads `/readyz`
   * through `cf-api-aetherholm-readyz` to decide whether to tell a player the game is up
   * (`deploy/gateway/dynamic/estate-web.yml`), so a readiness that does not reflect both halves is
   * not merely a regression on two working services — it is a lie on a public page.
   */
  readonly probe: Probe;
  /** Sample this module's gauges. Called from the host's `/metrics`, never on a timer — rule 8. */
  beforeScrape(): Promise<void>;
  /** Start claiming jobs. Called after the schema is asserted and before the socket accepts. */
  start(): void;
  /** Stop claiming, drain, and close the pools. Registered on the host's shutdown hooks. */
  stop(): Promise<void>;
  /** For the host's boot line. The version `assertSchemaAtLeast` was satisfied at. */
  readonly schemaVersion: number;
}

/**
 * Build the aetherholm half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take emberkin down for an aetherholm fault at a point where the host
 * has a logger and a `fatal` line to write. Every failure below was an `exit(1)` in the standalone
 * service and still stops the boot — it just stops it one frame further out.
 */
export async function createAetherholmModule(host: HostRuntime): Promise<AetherholmModule> {
  // 1. Environment — validated on import of ./env.ts, which exits with a structured line naming
  //    the variable and never its value.

  // 2. Telemetry.
  //
  //    `metrics` is the HOST's registry — the object `/metrics` renders. Specs registered on it are
  //    on that page, and this module's domain names are all `aetherholm_`-prefixed, so nothing
  //    there collides with anything.
  //
  //    `jobMetrics` is this module's labelled VIEW, and it exists for the families that DO collide.
  //    See `MODULE_LABEL`. A view writes into the same series maps, so every module is still on
  //    one page — see `Metrics.withLabels` (micro-runtime#9).
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
  // `AETHERHOLM_DATABASE_URL_TESTNET` unset is the single-network case, which is every deployment
  // until the consolidation reaches this module. `networkSql` then holds one handle and REFUSES a
  // testnet request rather than answering it out of mainnet rows — substituting would be a query
  // that SUCCEEDS against the other estate and says nothing.
  const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined;
  const db = sql as unknown as Db;

  const close = async (): Promise<void> => {
    await sql.end({ timeout: 5 }).catch(() => {});
    await sqlTestnet?.end({ timeout: 5 }).catch(() => {});
  };

  // 4. Assert the schema. This does NOT migrate.
  try {
    await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION);
  } catch (err) {
    await close();
    throw err;
  }

  // 5. The queue.
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId, leaseMs: 120_000 });

  // ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
  //
  // The `networkSql` key below used to be the literal `mainnet`. Same image, same code,
  // different env — so the TESTNET pod registered its testnet DSN under the name `mainnet` and
  // then refused every request the gateway stamped `CF-Network: testnet`, because it genuinely
  // held no handle by that name. Five services crash-looped on it within ten minutes of the
  // first deploy: the refusal was right, the registration was wrong.
  //
  // `CF_NETWORK_SINGLE` is how a single-network pod says which estate it is. The render sets it
  // for every deployment; `mainnet` remains the default only for a bare `pnpm dev`.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet';

  // ── THIS MODULE'S SELECTOR, AND WHY EVERY ROUTE BELOW CARRIES IT ────────────────────────────
  //
  // The kernel resolves ONE handle per request, from one selector. In a merged process the host's
  // selector is emberkin's, so a route mounted without this would read emberkin's database: a
  // query that SUCCEEDS against a `seasons` table belonging to another game and reports nothing.
  // `RouteSpec.sql` is where that is answered, and stamping it here — once, over the whole table —
  // is why no handler had to change.
  const aetherholmSql = networkSql({
    [ownNetwork]: sql as unknown as RuntimeSql,
    ...(sqlTestnet && ownNetwork !== 'testnet' ? { testnet: sqlTestnet as unknown as RuntimeSql } : {}),
  });

  // 6. The routes, over THIS module's deps.
  const routes = mountableRoutes(
    {
      // The host's, so `/livez` and `/readyz` — which this module no longer serves — see one truth,
      // and so a drain drains both halves at once. `track` IS the host's for the same reason; the
      // two dead probe handlers get the refusing stub below.
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      sql: aetherholmSql,
      // The fallback for a request with no `CF-Network` header — which is EVERY service-to-service
      // call, because those go container to container and never reach the gateway that stamps one.
      // `requestNetwork` still prefers the header, so this cannot mask a mis-stamped external
      // request; it only answers the internal callers that never had one. worlds' `POST
      // /v1/provision` is exactly such a caller.
      singleNetwork: ownNetwork,
      producer: SERVICE,
      queue,
      eventAcceptSecrets: env.acceptSecrets,
      // Unused: `/metrics` is the host's and calls `beforeScrape()` below directly. Left off rather
      // than wired to nothing, so nobody reads this as a second scrape path.
    },
    aetherholmSql,
  );

  // 7. The job runner.
  //
  // ── ITS OWN RUNNER, AND THAT IS FORCED RATHER THAN CHOSEN ────────────────────────────────────
  //
  // A `JobRunner` is bound to ONE `JobQueue`, which is bound to ONE `sql` handle, which is one
  // database. Two databases therefore cannot share a runner even if the kinds did not collide —
  // and they do: every title registers `outbox.relay`, so `runner.register` would throw
  // `handler already registered for outbox.relay` at boot.
  //
  // That throw is a GOOD failure and it is deliberately still reachable: `jobcomposition.test.ts`
  // builds one runner, registers two modules' handlers on it, and asserts it throws. The point of
  // keeping it provable is that the SILENT shape is the one next door — emberkin already runs one
  // runner per network plane, so "add another runner" is the natural move, and two runners both
  // counting `kind="outbox.relay"` into an unlabelled registry is a sum nothing complains about.
  // Separate runners are correct; `MODULE_LABEL` is what makes them readable.
  let started = false;
  const runner = new JobRunner({
    queue,
    concurrency: 4,
    pollMs: 1_000,
    // Both halves of the answer. `started` is this module's own gate — nothing may be claimed
    // before the host has finished booting — and `host.claimingJobs()` is the drain, which is the
    // host's to decide and must apply to every module at once.
    shouldClaim: () => started && host.claimingJobs(),
    onEvent: (event) => {
      // EVERY line here goes through the labelled view. `kind` alone is not enough: the other
      // module registers `outbox.relay` too, and a counter summing two unrelated relays is worse
      // than no counter, because it still moves.
      if (event.kind) {
        const labels = { kind: event.kind };
        if (event.type === 'claimed') jobMetrics.increment('jobs_claimed_total', labels);
        if (event.type === 'completed') jobMetrics.increment('jobs_completed_total', labels);
        if (event.type === 'failed') jobMetrics.increment('jobs_failed_total', labels);
        if (event.type === 'dead') jobMetrics.increment('jobs_dead_total', labels);
        if (event.durationMs !== undefined) jobMetrics.observe('jobs_duration_ms', event.durationMs, labels);
      }
      onRunnerEvent({ sql: db, queue, logger })(event);
    },
  });
  registerHandlers(runner, {
    sql: db,
    logger,
    metrics: jobMetrics,
    producer: SERVICE,
    signingSecret: env.outboxSigningSecret,
    queue,
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
        const userId = payload['userId'];
        if (topic !== USER_DELETED_TOPIC) return { status: 'processed' };
        if (typeof userId !== 'string' || !UUID.test(userId)) {
          // A RESULT and not a throw: the host maps this to the same 400 the standalone route
          // answered. A deletion we cannot perform must not be acknowledged as performed.
          return { status: 'rejected', reason: `${USER_DELETED_TOPIC} requires a uuid userId` };
        }
        // ══════════════════════════════════════════════════════════════════════════════════════
        // EVERY PLANE, AND THE `network` ARGUMENT IS DELIBERATELY UNUSED ON THIS TOPIC.
        //
        // The host passes a network and never a handle, so this module still cannot be aimed at
        // emberkin's database — the selector below is aetherholm's own, and that invariant is
        // untouched. What changes is how many of ITS OWN handles the erasure reaches: one, until
        // 2026-09-02. Measured then, `inbox` rows for this topic: `aetherholm` 101,
        // `aetherholm_testnet` 24, the second number frozen since the k8s migration
        // (micro-org#474). The event names a person, and a person is not an estate.
        //
        // `network` remains in the signature because every other topic a sink handles IS scoped to
        // one estate, and this is the exception rather than the rule.
        // ══════════════════════════════════════════════════════════════════════════════════════
        const sweep = await eraseEveryPlane(aetherholmSql, (handle: Db) =>
          withInbox(handle, topic, eventId, (tx) => eraseUser(tx, userId)),
        );
        if (sweep.processed === 0) return { status: 'duplicate' };
        // Counts only, summed across the planes. The erased id is never logged — writing it into
        // the log would recreate, in the one store nothing erases, exactly what the request was to
        // remove.
        return { status: 'processed', detail: planeTotals(sweep) };
      },
    },
    probe: postgresProbe('postgres-aetherholm', (signal) =>
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true });
        }),
      ]),
    ),
    beforeScrape: async () => {
      // The VIEW, not the registry. `jobs_pending` and `jobs_overdue` carry no `kind`, so this one
      // line is where the two modules would otherwise erase each other every scrape — and
      // `JobQueueOverdue` would then alert on whichever queue happened to sample last.
      const stats = await queue.stats();
      jobMetrics.set('jobs_pending', stats.pending);
      jobMetrics.set('jobs_overdue', stats.overdue);
    },
    start: () => {
      started = true;
      void seedRecurring(queue)
        .then(() => runner.start())
        .catch((err: unknown) => logger.error('failed to seed recurring jobs', { err }));
    },
    stop: async () => {
      started = false;
      const clean = await runner.stop(20_000);
      logger.info('job runner stopped', { clean });
      await close();
      logger.info('database pool closed');
    },
    schemaVersion: SCHEMA_VERSION,
  };
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The databases this module owns, for the merged migrator.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE MIGRATOR MUST NOT IMPORT `./env.ts` EITHER, AND THIS IS WHY IT DOES NOT HAVE TO.**
 *
 * `src/migrator.ts` needs two facts about this module — where its databases are and what to apply
 * to them. Reaching for this module's `env` wholesale would put a second entry point in possession
 * of a DSN it has no other reason to hold, in a process nobody thinks of as serving anything. This
 * function returns four scalars and an array of DDL per database, so nothing else can leak with
 * them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function aetherholmMigrationTargets(): readonly Target[] {
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
 * The `Lifecycle` shape `createRoutes` demands, with the two dead handlers refusing.
 *
 * `ServerDeps.lifecycle` is read in three places: `/livez` and `/readyz`, both filtered out above,
 * and `track()`, which is live and must be the HOST's — a city founding that holds the drain open
 * has to hold the drain of the process that is actually shutting down.
 *
 * The two probe methods throw rather than returning a plausible answer, so if the filter is ever
 * removed the shadowed route fails loudly on its first request instead of reporting a readiness it
 * did not compute. Passing the host's real `Lifecycle` wholesale would be worse than useless: it
 * would make those two handlers look alive when they are dead.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('aetherholm does not serve /livez in the merged process — emberkin does');
    },
    readyz: () => {
      throw new Error('aetherholm does not serve /readyz in the merged process — emberkin does');
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle;
}

type ServerLifecycle = Parameters<typeof createRoutes>[0]['lifecycle'];

/** Re-exported so `RequestContext` stays nameable from this module's own tests. */
export type { RequestContext };
