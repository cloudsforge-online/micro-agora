/**
 * The emberkin module: three titles behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE ONE MODULE OF THE PLATFORM MONOLITH THAT IS ITSELF A MERGED PROCESS.**
 *
 * Wave M3 put aetherholm inside emberkin; wave M4a put nda inside it too. Wave M5d
 * (micro-deploy `docs/service-merge-plan.md`) puts the result inside agora — and PRESERVES the
 * nesting rather than flattening it, exactly as activity/notify and lantern/analytics are
 * preserved. agora calls this factory; this factory calls `createAetherholmModule` and
 * `createNdaModule`. Three modules, one call from the host.
 *
 * The nesting is not sentiment about file layout. It is what makes two guarantees CHECKABLE
 * rather than conventional, and both are checked by suites that came across with the code:
 *
 *   * `./mergedupstreams.test.ts` reads the three titles' `env.ts` files and asserts no nested
 *     title declares an inbound secret of its own. That is what makes the single-webhook fan-out
 *     below honest — one signature check for three sinks is only legitimate because all three read
 *     the same estate-wide `OUTBOX_SIGNING_SECRET`.
 *   * `./mergedroutes.test.ts` asserts the three route tables overlap on EXACTLY the four paths
 *     each nested module filters out, so a fifth collision is a red test rather than a route that
 *     silently stops being reachable.
 *
 * Flattening would have deleted both seams and left the guarantees as conventions.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE DATABASE BOUNDARY, WHICH IS NOW THREE DEEP ────────────────────────────────────────────
 *
 * Three databases here, never merged, and none reachable from another's handlers. This file
 * builds emberkin's pools and stamps emberkin's selector; the two nested factories build and stamp
 * their own, and neither names a handle in its interface. What agora hands down is a metrics
 * registry, a verifier and two lifecycle bits — there is no parameter through which a database
 * could travel in either direction.
 *
 * `./aetherholm/env.ts` and `./nda/env.ts` are NOT imported here, so `AETHERHOLM_DATABASE_URL`,
 * `NDA_DATABASE_URL` and `NDA_IDENTITY_CREDENTIAL` never enter this file's scope — and agora's
 * `../index.ts` does not import `./env.ts` either, so `EMBERKIN_IDENTITY_CREDENTIAL` never enters
 * that one's.
 *
 * ── AND THE UPSTREAM ARGUMENT, WHICH SURVIVES THE SECOND MERGE UNCHANGED ──────────────────────
 *
 * emberkin absorbed the other two on the upstream argument rather than on size: aetherholm calls
 * nothing at all, and nda calls billing, worlds and identity — a strict SUBSET of emberkin's
 * ledger, billing, worlds and identity. So this module reaches exactly the peers emberkin alone
 * reached, and not one more. That is still true inside agora, and it is why the three probes below
 * are emberkin's rather than three titles' worth of duplicates.
 */

import postgres from 'postgres';
import { assertSchemaAtLeast, networkSql, type Network, type Sql as DbSql } from '@cloudsforge/db';
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs';
import type { Probe } from '@cloudsforge/lifecycle';
import { httpProbe, postgresProbe } from '@cloudsforge/lifecycle';
import { Logger, type Metrics } from '@cloudsforge/telemetry';
import type { RouteSpec } from '../kernel.ts';
import type { Target } from '../migratortargets.ts';
import { SERVICE, env } from './env.ts';
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';
import { GameData } from './content/gamedata.ts';
import { mountableRoutes, registerServiceMetrics } from './server.ts';
import type { PrincipalVerifier } from './routes.ts';
import { onRunnerEvent, registerHandlers, seedRecurring } from './jobs.ts';
import { buildUpstreams } from './upstreams.ts';
import { MODULE_LABEL as AETHERHOLM_MODULE, aetherholmMigrationTargets, createAetherholmModule } from './aetherholm/module.ts';
import { MODULE_LABEL as NDA_MODULE, createNdaModule, ndaMigrationTargets } from './nda/module.ts';
import type { Db } from './outbox.ts';

/**
 * The label every JOB metric this module writes carries.
 *
 * Three families collide and would be unreadable without it. All three titles register a job kind
 * spelled exactly `outbox.relay` — which fourteen of agora's twenty modules now do — and emberkin
 * and nda BOTH register `achievement.sweep` and `achievement.deliver`, two unrelated achievement
 * bridges into two different `worlds` profiles. `jobs_pending` and `jobs_overdue` carry no `kind`
 * at all, so whichever module sampled last would be the only one on the graph and a wedged queue
 * would read as ABSENT rather than high — which is exactly the gauge
 * `deploy/prometheus/rules/alerts.yaml`'s `JobQueueOverdue` fires on.
 */
export const MODULE_LABEL = SERVICE;

/** What the host process supplies. Deliberately nothing this module could hide a handle inside. */
export interface HostRuntime {
  /** The process-wide registry — the object the host's `/metrics` renders, not a view of it. */
  readonly metrics: Metrics;
  /** The host's identity verifier. ONE JWKS client for the process; all three titles read it. */
  readonly verifier: PrincipalVerifier;
  /** The host `Lifecycle`'s `claimingJobs`. A drain must stop claiming in EVERY module at once. */
  claimingJobs(): boolean;
  /** The host `Lifecycle`'s `track`. A city founding must hold the drain of the process that owns it. */
  track(): () => void;
}

/** What the host process gets back. **No field here names a database handle.** */
export interface EmberkinModule {
  /** All THREE titles' routes, concatenated and each stamped with its own module's selector. */
  readonly routes: readonly RouteSpec<Db>[];
  /**
   * The readiness probes for all three titles: THREE databases and four upstreams.
   *
   * A merged `/readyz` that probed one database would answer 200 while every city, fleet and
   * homestead was failing — and `aetherholm-web` reads this endpoint to decide whether to tell a
   * player the game is up, so it is not just the balancer that would be misled. `nda`'s
   * `nda-identity-credential` probe is HARD and stays hard: a replica with no credential can make
   * no authenticated call to billing or worlds, so the equip button and the achievement bridge are
   * both dead.
   */
  readonly probes: readonly Probe[];
  beforeScrape(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly schemaVersion: number;
}

/**
 * Build the three-title half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take seventeen others down at a point where the host has a logger and a
 * `fatal` line to write. The two nested factories throw for the same reason one level down, and
 * this function unwinds what it has already built before re-throwing.
 */
export async function createEmberkinModule(host: HostRuntime): Promise<EmberkinModule> {
  const metrics = host.metrics;
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL });
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env });
  registerServiceMetrics(metrics);

  // ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
  //
  // Every per-network map below keys its primary entry by THIS, never by the literal `mainnet`.
  // Same image, same code, different env: a testnet pod that hardcodes the key holds its own
  // database and its own queue under the other estate's name, and then refuses — or, when the
  // throw escapes a request listener, DIES — on every request the gateway correctly stamped. It
  // happened twice: the handle, then the job plane. `./ownnetwork.test.ts` reads THIS file.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet';

  // Content — loaded once and validated. A content error is a boot failure, not a first-request
  // one; it throws here where the standalone root exited, because the host owns the exit code.
  const data = GameData.loadFromDirectory();
  data.validateOrThrow();
  logger.info('starting', {
    version: env.version,
    schemaVersion: SCHEMA_VERSION,
    species: data.dex.length,
    seasonRewardBudgetWei: env.seasonRewardBudgetWei.toString(),
  });

  const poolOptions = { max: env.databasePoolMax, onnotice: () => {} };
  const sql = postgres(env.databaseUrl, poolOptions);
  const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined;
  const pools: ReadonlyArray<readonly [Network, typeof sql]> = [
    [ownNetwork, sql],
    ...(sqlTestnet && ownNetwork !== 'testnet' ? ([['testnet', sqlTestnet]] as const) : []),
  ];
  const closePools = async (): Promise<void> => {
    await Promise.all(pools.map(([, handle]) => handle.end({ timeout: 5 }).catch(() => {})));
  };

  // Asserted on EVERY network, not only the first: a testnet database behind on migrations would
  // otherwise be discovered by the first testnet request rather than at boot.
  try {
    for (const [, handle] of pools) {
      await assertSchemaAtLeast(handle as unknown as DbSql, SCHEMA_VERSION);
    }
  } catch (err) {
    await closePools();
    throw err;
  }

  // The upstreams. All three titles take the same scoped service credential — never a shared one
  // (SD-05). The wiring lives in `./upstreams.ts` rather than here, and that is the substance of
  // micro-org #228: what stood in the standalone root was a ten-minute JWT read once at import and
  // handed to all three clients for the life of the process, invisible to every test in the
  // repository because importing a composition root opened a pool and called `listen()`.
  const upstreams = buildUpstreams(env, {
    // Never the token and never the credential: a mint carries a service name, an `expiresIn` and
    // a refresh interval, and a failure carries a message. Both values are live credentials.
    onEvent: (event) => {
      if (event.kind === 'minted') {
        logger.info('service token minted', {
          peer: event.service,
          expiresIn: event.expiresIn,
          refreshInMs: event.refreshInMs,
        });
      } else if (event.kind === 'exchange_failed') {
        // WARN while a usable token is still held, ERROR once there is not one. Inside the 20%
        // slack this is survivable and invisible to callers; outside it, every outbound call is
        // now answering 503.
        logger[event.hadUsableToken ? 'warn' : 'error']('service credential exchange failed', {
          err: event.err,
          hadUsableToken: event.hadUsableToken,
        });
      } else {
        logger.warn('service token replay', { kind: event.kind, url: event.url });
      }
    },
  });
  const { billing, ledger, worlds } = upstreams;

  // THE MODE, SAID OUT LOUD. `static` is the defect still running: a deployment not yet given the
  // credential the bootstrap already minted for it. `fatal` because the container looks perfectly
  // healthy for ten minutes and then fails every outbound call with nothing naming the cause —
  // which is how this survived long enough to become an issue. It does NOT throw: a rolling deploy
  // has to be able to finish, and in the merged process it would take nineteen other modules with
  // it.
  if (upstreams.mode === 'static') {
    logger.fatal('authenticating with a pre-minted service token, which expires ten minutes from now', {
      remedy: 'pass EMBERKIN_IDENTITY_CREDENTIAL instead of EMBERKIN_SERVICE_TOKEN',
      issue: 'micro-org#228',
    });
  } else {
    logger.info('exchanging a long-lived service credential for short-lived tokens', {
      identityUrl: env.identityUrl,
    });
  }

  // ── THE TWO NESTED TITLES, BUILT BEFORE THE ROUTES ──────────────────────────────────────────
  //
  // Each is handed the HOST's runtime, unchanged — agora's metrics registry and verifier, and the
  // drain, and only the drain. A module does not decide the lifetime of a process it shares, and
  // nothing here can hand either of them a database.
  const aetherholm = await createAetherholmModule(host).catch(async (err: unknown) => {
    await closePools();
    throw err;
  });
  logger.info('module ready', { module: AETHERHOLM_MODULE, schemaVersion: aetherholm.schemaVersion });

  const nda = await createNdaModule(host).catch(async (err: unknown) => {
    // The rollback of aetherholm's own pools is aetherholm's, not this file's: `stop()` is the
    // only thing that holds a name for them, which is why it is called rather than reached into.
    await aetherholm.stop().catch(() => {});
    await closePools();
    throw err;
  });
  logger.info('module ready', { module: NDA_MODULE, schemaVersion: nda.schemaVersion });

  // ── ONE PLANE PER NETWORK ───────────────────────────────────────────────────────────────────
  //
  // The QUEUE is per-network as much as the pool is. A testnet request that enqueued into the
  // mainnet queue would be picked up by a handler reading mainnet rows: a cross-network write that
  // succeeds, with a job row to prove it was deliberate.
  const planes = pools.map(([network, handle]) => ({
    network,
    db: handle as unknown as Db,
    queue: new JobQueue(handle as unknown as JobsSql, { owner: env.instanceId, leaseMs: 120_000 }),
  }));
  const planeFor = (network: Network) => {
    const plane = planes.find((p) => p.network === network);
    if (!plane) throw new Error(`no plane for network ${network}`);
    return plane;
  };

  const emberkinSql = networkSql(Object.fromEntries(pools.map(([n, h]) => [n, h as unknown as DbSql])));

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      sql: emberkinSql,
      singleNetwork: ownNetwork,
      producer: SERVICE,
      data,
      billing,
      queueFor: (network: Network) => planeFor(network).queue,
      // Absent `OUTBOX_ACCEPT_SECRETS` this is `[env.outboxSigningSecret]`, i.e. unchanged. All
      // three titles read the same estate-wide variables, from one file, which is what makes one
      // signature check honest for all three.
      eventAcceptSecrets: env.acceptSecrets,
      // The single webhook fans out to every module that subscribes to the topic. ALL THREE titles
      // subscribe to `identity.user.deleted`, and routing it to one of them would answer 202 to a
      // deletion two thirds of which never happened. See `MOUNTED_EVENTS_PATH` in `./server.ts`
      // for why this fan-out is legitimate here and refused everywhere else in agora.
      inbound: [aetherholm.inbound, nda.inbound],
    },
    emberkinSql,
    [...aetherholm.routes, ...nda.routes],
  );

  let started = false;
  const runners = planes.map((plane) => {
    const runner = new JobRunner({
      queue: plane.queue,
      concurrency: 4,
      pollMs: 1_000,
      shouldClaim: () => started && host.claimingJobs(),
      onEvent: (event) => {
        if (event.kind) {
          const labels = { kind: event.kind, network: plane.network };
          // The VIEW. `network` distinguishes this runner from the other PLANE, never from the
          // other MODULE — aetherholm's relay writes `kind="outbox.relay"` too, and so do eleven
          // of agora's others.
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
      ledger,
      producer: SERVICE,
      signingSecret: env.outboxSigningSecret,
      seasonBudgetWei: env.seasonRewardBudgetWei,
      queue: plane.queue,
    });
    return runner;
  });

  return {
    routes,
    probes: [
      postgresProbe(`postgres-${MODULE_LABEL}`, (signal) =>
        Promise.race([
          sql`select 1`,
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true });
          }),
        ]),
      ),
      // The other two titles' databases, on the same `/readyz`. A merged readiness that probed one
      // would answer 200 while every city, fleet and homestead was failing.
      aetherholm.probe,
      // nda contributes a LIST rather than one probe, and the second of them is HARD — see
      // `EmberkinModule.probes`. Spread rather than named, so a module that later contributes a
      // third does not have to touch this file.
      ...nda.probes,
      // SOFT, all four: another service's outage must not pull three games from rotation, and
      // above all must not stop the achievement/reward job backlog from draining. Module-prefixed
      // NAMES, because `/readyz` now reports twenty modules' probes in one document and several of
      // them watch the same peers.
      //
      // nda's OWN billing, worlds and identity-jwks probes are deliberately absent from its list:
      // all three read the same estate-wide `BILLING_URL`, `WORLDS_URL` and `IDENTITY_JWKS_URL`
      // probed here, so a second copy would be duplicate rows in one readiness report and one more
      // thing to keep in step. That is only true because nda's upstream set is a strict subset of
      // this module's; `./mergedupstreams.test.ts` is what keeps it true.
      httpProbe(`${MODULE_LABEL}-identity-jwks`, env.identityJwksUrl, { kind: 'soft' }),
      httpProbe(`${MODULE_LABEL}-billing`, `${env.billingUrl}/livez`, { kind: 'soft' }),
      httpProbe(`${MODULE_LABEL}-ledger`, `${env.ledgerUrl}/livez`, { kind: 'soft' }),
      httpProbe(`${MODULE_LABEL}-worlds`, `${env.worldsUrl}/livez`, { kind: 'soft' }),
    ],
    beforeScrape: async () => {
      // Per network, because the two queues are separate and a summed gauge would hide a testnet
      // backlog behind a healthy mainnet one — and through the LABELLED VIEW, because
      // `jobs_pending`/`jobs_overdue` carry no `kind` and nineteen other modules write the same
      // two names. `network` alone distinguishes neither.
      for (const plane of planes) {
        const stats = await plane.queue.stats();
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network });
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network });
      }
      await aetherholm.beforeScrape();
      await nda.beforeScrape();
      // Read from what this module already holds; `snapshot()` dials nobody. A `static` deployment
      // reports usable, because the token it was handed genuinely is a bearer it can present — for
      // ten minutes. `emberkin_service_token_static` is the gauge that says it cannot be renewed.
      metrics.set(
        'emberkin_service_token_usable',
        upstreams.mode === 'exchanged'
          ? (upstreams.identityTokens?.snapshot().hasUsableToken ?? false)
            ? 1
            : 0
          : upstreams.mode === 'static'
            ? 1
            : 0,
      );
      metrics.set('emberkin_service_token_static', upstreams.mode === 'static' ? 1 : 0);
    },
    start: async () => {
      started = true;
      // Recurring work is seeded into every queue: a testnet estate with no achievement sweep is a
      // half-running game, not a dormant one.
      for (const plane of planes) await seedRecurring(plane.queue);
      for (const runner of runners) runner.start();
      aetherholm.start();
      // AWAITED, unlike aetherholm's, because nda seeds its recurring work before it starts its
      // runners and a `world.sweep` that never got seeded is a game whose days stop advancing with
      // nothing anywhere saying so.
      await nda.start();
    },
    stop: async () => {
      started = false;
      const clean = (await Promise.all(runners.map((r) => r.stop(20_000)))).every(Boolean);
      logger.info('job runners stopped', { clean, runners: runners.length });
      // Each nested module drains its own runners and closes its own pools. Awaited in sequence
      // and each guarded, so a failure in one does not skip the other's or this module's pools.
      await aetherholm.stop().catch((err: unknown) => logger.error('aetherholm stop failed', { err }));
      await nda.stop().catch((err: unknown) => logger.error('nda stop failed', { err }));
      await closePools();
      logger.info('database pools closed', { networks: pools.length });
    },
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * The databases these THREE titles own, for agora's merged migrator.
 *
 * agora's migrator names `emberkinMigrationTargets`, and THIS function is what knows aetherholm
 * and nda exist — exactly as emberkin's own `src/migrator.ts` did before this wave, and exactly as
 * `lanternMigrationTargets` knows about analytics.
 */
export function emberkinMigrationTargets(): readonly Target[] {
  const common = { module: SERVICE, migrations: MIGRATIONS, baselineVersion: BASELINE_VERSION } as const;
  return [
    { ...common, network: 'primary', url: env.databaseUrl },
    ...(env.databaseUrlTestnet ? [{ ...common, network: 'testnet', url: env.databaseUrlTestnet }] : []),
    ...aetherholmMigrationTargets(),
    ...ndaMigrationTargets(),
  ];
}

/**
 * The `Lifecycle` shape `createRoutes` demands, with the two dead handlers refusing.
 *
 * `/livez` and `/readyz` are filtered out of the mounted table; `track()` is live and must be the
 * HOST's, so a battle resolution that holds the drain open holds the drain of the process that is
 * actually shutting down. The two probe methods throw rather than answering plausibly, so if the
 * filter is ever removed the shadowed route fails loudly instead of reporting a readiness it did
 * not compute.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('emberkin does not serve /livez in the merged process — agora does');
    },
    readyz: () => {
      throw new Error('emberkin does not serve /readyz in the merged process — agora does');
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle;
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle'];
