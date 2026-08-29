/**
 * The studio module: brand kits, image generation and the asset store, behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FILE IS THE DATABASE BOUNDARY, AND THAT IS THE WHOLE JOB.**
 *
 * Wave M5a (micro-deploy `docs/service-merge-plan.md`) folds studio into agora's process as part of
 * the `platform` seed. All five databases are KEPT — no schema merge — and the five schemas own
 * `inbox` and `jobs` in ALL FIVE, with `outbox`, `event_subscriptions` and `outbox_deliveries` in
 * four including this one.
 *
 * A handler handed the wrong handle does not fail: `insert into outbox …` SUCCEEDS into another
 * module's relay, `select … from jobs` SUCCEEDS against another module's queue. The four layers
 * that make that unspellable are the ones `./policy/module.ts` documents.
 *
 * **This module carries one extra twist and it is worth naming.** studio never held a bare `sql` in
 * its route deps: its handle lives INSIDE `postgresBrandKitStore`, so the thing that has to become
 * per-network is the STORE, not a pool reference. `forRequest` in `./server.ts` therefore takes a
 * NETWORK rather than a handle and calls `deps.kitsFor(deps.sql.for(network))`. That shape is
 * preserved exactly; what the merge adds is `RouteSpec.sql`, which is what makes `deps.sql` here
 * this module's selector rather than the host's.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE PVC, WHICH IS THE OBJECTION THIS WAVE OVERRULES ────────────────────────────────────────
 *
 * studio owns `studio-assets`, a `ReadWriteOnce` PersistentVolumeClaim mounted at
 * `/var/lib/studio/assets` and named by `STUDIO_ASSET_ROOT`. The plan refused this merge on the
 * ground that it makes the absorber stateful and node-affine — a property no API service in the
 * estate has.
 *
 * On a SINGLE-NODE cluster the node-affinity cost is exactly zero: there is one node, every pod is
 * already scheduled to it, and a `ReadWriteOnce` claim can only ever be bound there. What the merge
 * does cost is real and is not the affinity:
 *
 *   * The merged Deployment becomes the only one in the estate that cannot roll with
 *     `maxSurge > 0` against a `ReadWriteOnce` volume, because two pods cannot hold it at once.
 *     That is a deploy-side property and is reported in the pull request rather than decided here.
 *   * An asset root that goes read-only, full or unmounted now takes the WHOLE merged `/readyz`
 *     to 503, not just studio's. That is deliberate and it is `assetRootProbe`'s existing contract
 *     preserved rather than quietly downgraded: every generation of every kind ends at
 *     `blobs.put()`, so a replica that cannot write is a replica that must take no work. Making it
 *     soft to protect the other four modules would be the failure nobody notices, which is the
 *     trade this estate has already decided the other way twice.
 *
 * The BOOT check is preserved too, in the same position it had: `checkAssetRoot` runs before the
 * routes are built and throws, so the host writes one `fatal` line and exits. `STUDIO_ASSET_ROOT`
 * unset once resolved to a root-owned `/app/out` under `USER node`, and every generation failed
 * EACCES while the container reported healthy — which is exactly the thing a merged process must
 * not be able to do on behalf of four other modules.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type { Probe } from '@cloudsforge/lifecycle'
import { postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, type Metrics } from '@cloudsforge/telemetry'
import type { RouteSpec } from '../kernel.ts'
import type { Target } from '../migratortargets.ts'
import { SERVICE, env, redactedEndpoint } from './env.ts'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION } from './migrations.ts'
import { mountableRoutes, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring, GENERATE_KIND } from './jobs.ts'
import {
  assetRootProbe,
  checkAssetRoot,
  describeAssetRootFailure,
  filesystemBlobStore,
  findAsset,
  listAssetsForKit,
} from './assets.ts'
import { postgresBrandKitStore } from './brandkits.ts'
import { findJob, requestGeneration } from './generation.ts'
import { fluxBackend, placeholderBackend, type BackendSet } from './backend.ts'
import { Preflight, imageBackendProbe } from './preflight.ts'
import { DEFAULT_UPLOAD_QUOTA, changeVisibility, storeUpload } from './uploads.ts'
import type { Db } from './outbox.ts'

/**
 * The label every JOB metric this module writes carries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS MODULE COLLIDES WITH THREE OTHERS ON `outbox.relay`.** Measured in
 * `../jobcomposition.test.ts`: agora, devplatform, pricing and studio all register a kind spelled
 * exactly `outbox.relay`, so `jobs_failed_total{kind="outbox.relay"}` would be the sum of four
 * unrelated relays.
 *
 * `asset.generate` collides with nothing, and it is the sharpest series in this module: it is a
 * paid call to a third-party image model, so a climb in `jobs_dead_total{kind="asset.generate"}` is
 * money that was spent and produced nothing. It must not be summed with anything and it must not be
 * erased by anything.
 *
 * `jobs_pending` and `jobs_overdue` carry no `kind` at all, so without a `module` label each
 * module's sample OVERWRITES the others' every scrape and a wedged generation queue is ABSENT from
 * the graph rather than high.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MODULE_LABEL = 'studio'

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
   * Live, and used three times in this module's routes: a generation request, an upload and a
   * visibility change each hold the drain open. In the merged process that has to be the HOST's
   * drain, or a shutdown would cut an upload the module thought it had protected — and an upload
   * cut between the blob write and the row is an orphaned file on the PVC.
   */
  track(): () => void
}

/** What the host process gets back. **No field here names a database handle or a blob store.** */
export interface StudioModule {
  readonly routes: readonly RouteSpec<Db>[]
  /**
   * The readiness probes for THIS module.
   *
   * THREE, and the mix is the point:
   *
   *   * `postgres-studio` — HARD. A merged `/readyz` that probed only agora's database would answer
   *     200 while every brand kit, job and asset read was failing.
   *   * `image-backend` — SOFT. With no usable model this module still creates brand kits, reads
   *     them and generates placeholders; only real art is unavailable. It performs no I/O, so it
   *     can never spend money or hang the probe. Hard would turn a missing model into an outage of
   *     five modules.
   *   * `asset-root` — HARD, and the contrast with the one above it is why it exists. An unwritable
   *     root has no remainder: every generation of every kind fails, through every backend
   *     including the placeholder, because they all end at `blobs.put()`. Reporting that while
   *     still answering 200 leaves the replica in the balancer taking work it cannot finish.
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
 * Build the studio half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code. Both of this module's
 * boot refusals — the schema assertion and the asset-root write check — were `exit(1)` in the
 * standalone service and still stop the boot; they just stop it one frame further out, where the
 * host has a logger and a `fatal` line.
 */
export async function createStudioModule(host: HostRuntime): Promise<StudioModule> {
  const metrics = host.metrics
  const jobMetrics = metrics.withLabels({ module: MODULE_LABEL })
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', {
    version: env.version,
    schemaVersion: SCHEMA_VERSION,
    // The ENDPOINT redacted, never the key. `redactedEndpoint` is what makes this line safe to say.
    imageEndpoint: redactedEndpoint(env.flux),
    assetRoot: env.assetRoot,
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
  // `./ownnetwork.test.ts` reads THIS file.
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

  // ── THE ASSET ROOT, ASSERTED WRITABLE BEFORE THE ROUTES EXIST ──────────────────────────────
  //
  // In the same position it had in the standalone service and for the same reason: a precondition
  // every request depends on, checked once, before the socket exists. It WRITES rather than asking
  // — `fs.access` would not have caught the failure this exists for, which was a root-owned
  // `/app/out` under `USER node`, silently EACCES on every generation while `/readyz` answered 200.
  //
  // It runs BEFORE `filesystemBlobStore` is constructed below, because constructing that store
  // proves nothing: it only calls `resolve()`.
  //
  // The throw carries the operator sentence and NOT a stack, and it goes to the host rather than
  // to `process.exit` — so the merged process reports "studio could not start" once, with the
  // remedy, instead of four other modules disappearing without explanation.
  try {
    await checkAssetRoot(env.assetRoot)
  } catch (err) {
    await close()
    throw new Error(
      `asset root is not writable: ${describeAssetRootFailure(env.assetRoot, err)} ` +
        '(STUDIO_ASSET_ROOT; the merged Deployment mounts the studio-assets PVC there)',
    )
  }

  const studioSql = networkSql(
    Object.fromEntries(planes.map((plane) => [plane.network, plane.pool as unknown as RuntimeSql])),
  )

  // The image backends. Constructed whether or not a model is reachable: the placeholder always
  // exists, so `backends.placeholder` is never null and this module is never without a way to
  // answer a generation request that asked for one.
  const preflight = new Preflight(env.flux, { deadlineMs: env.imageDeadlineMs })
  const backends: BackendSet = {
    flux: env.flux
      ? fluxBackend(env.flux, {
          deadlineMs: env.imageDeadlineMs,
          priceUsdMicros: env.imagePriceUsdMicros,
        })
      : null,
    placeholder: placeholderBackend(),
  }

  // ONE blob store for the process, because there is ONE PVC. The asset root is not per-network:
  // both estates' assets are content-addressed by checksum under the same tree, exactly as the
  // standalone service stored them, and the row that authorises a read lives in the per-network
  // database. Splitting the tree by network would be a migration of every existing path.
  const blobs = filesystemBlobStore(env.assetRoot, env.assetBaseUrl)

  // The factory, not just the store: `forRequest` in `./server.ts` calls it again per request with
  // the handle for that request's network. studio keeps its handle inside the store, so the STORE
  // is the per-network thing.
  const kitsFor = (handle: unknown) => postgresBrandKitStore(handle as typeof sql, SERVICE)

  /**
   * The plane a HANDLE belongs to.
   *
   * By identity, not by name, and that is what makes it safe: the handle arrives from the kernel,
   * which resolved it from THIS module's selector, which is built from exactly these pools. A
   * handle that is not one of them is a handle from another module's selector — the failure
   * `RouteSpec.sql` exists to prevent — and it throws rather than falling back to the primary,
   * because a silent fallback would answer a testnet request out of mainnet rows.
   */
  const planeForHandle = (handle: unknown): (typeof planes)[number] => {
    const plane = planes.find((p) => (p.pool as unknown) === handle)
    if (!plane) throw new Error('this handle does not belong to the studio module')
    return plane
  }

  // The three ports, as factories over one plane. Each closes over a handle and nothing else, so
  // there is no path by which one plane's queue could reach another plane's pool.
  const readsOver = (pool: (typeof planes)[number]['pool']) => ({
    findJob: (id: string) => findJob(pool, id),
    findAsset: (id: string) => findAsset(pool, id),
    // The blob store, not the filesystem. The route hands it a checksum from a row it has already
    // authorised, and the store is the only thing that knows how a checksum becomes a path. NOT
    // per-network: see the note on `blobs` above — there is one PVC and assets are
    // content-addressed under it.
    readBlob: (checksum: string, format: string) =>
      blobs.get(checksum, format as Parameters<typeof blobs.get>[1]),
    listAssetsForKit: (brandKitId: string, limit: number) => listAssetsForKit(pool, brandKitId, limit),
  })

  const generationOver = (plane: (typeof planes)[number]) => ({
    request: (input: Parameters<typeof requestGeneration>[1]) =>
      requestGeneration(
        {
          sql: plane.pool,
          producer: SERVICE,
          defaultCreditCapUsdMicros: env.defaultCreditCapUsdMicros,
          priceUsdMicros: env.imagePriceUsdMicros,
          enqueue: async (job: { kind: string; key: string; payload: Record<string, unknown> }) => {
            // `keep` collapses a double-click into one run. The key is the owner's spend. THIS
            // plane's queue: an enqueue is a write, and a job claimed by a runner holding the other
            // estate's handle applies to the other estate's rows.
            await plane.queue.enqueue({ ...job, onConflict: 'keep' })
          },
        },
        input,
      ),
  })

  const uploadsOver = (pool: (typeof planes)[number]['pool']) => ({
    store: (input: Parameters<typeof storeUpload>[1]) =>
      storeUpload({ sql: pool, producer: SERVICE, blobs, quota: DEFAULT_UPLOAD_QUOTA }, input),
    setVisibility: (input: Parameters<typeof changeVisibility>[1]) =>
      changeVisibility({ sql: pool, producer: SERVICE }, input),
  })

  const routes = mountableRoutes(
    {
      lifecycle: hostLifecycle(host),
      logger,
      metrics,
      verifier: host.verifier,
      // The boot-time placeholder, replaced per request by `forRequest`. Named here because
      // `ServerDeps` demands it, and built over the primary plane so a mistake is a wrong ESTATE
      // rather than a wrong module — the module boundary is `RouteSpec.sql`, one line down.
      kits: kitsFor(planes[0]!.pool),
      kitsFor,
      sql: studioSql,
      singleNetwork: ownNetwork,
      // ── THE BOOT-TIME PORTS, AND THE FACTORIES THAT REPLACE THEM PER REQUEST ────────────
      //
      // `ServerDeps` demands all three, so all three are built over the PRIMARY plane here — and
      // every one of them is replaced by `forRequest` before any handler runs, from the handle the
      // kernel resolved out of THIS module's selector. The boot-time objects exist so the type is
      // satisfied and so a mistake is a wrong ESTATE rather than a wrong module; `RouteSpec.sql` is
      // what makes the module half impossible.
      //
      // The factories are what wave M5a added, and they fix a real defect. Built once over one
      // pool — as the standalone service correctly did, holding one — a testnet request would be
      // answered a mainnet job id, a mainnet asset and a mainnet upload quota. A query that
      // SUCCEEDS and says nothing.
      reads: readsOver(planes[0]!.pool),
      readsFor: (sql) => readsOver(planeForHandle(sql).pool),
      generation: generationOver(planes[0]!),
      generationFor: (sql) => generationOver(planeForHandle(sql)),
      uploads: uploadsOver(planes[0]!.pool),
      uploadsFor: (sql) => uploadsOver(planeForHandle(sql).pool),
      preflight,
    },
    studioSql,
  )

  let started = false
  const runners = planes.map((plane) => {
    const reschedule = rescheduleRecurring(plane.queue, logger)
    const runner = new JobRunner({
      queue: plane.queue,
      // Deliberately modest, and unchanged. Each slot can hold a 40-second image call, and a wide
      // runner would let one replica hold more of the model's quota than the fallback rules can do
      // anything about. It is this module's own runner, so a wedged image call occupies two slots
      // here and none of any other module's.
      concurrency: 2,
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
          logger.error('job failure', { ...event })
        }
        reschedule(event)
      },
    })
    registerHandlers(runner, {
      sql: plane.db,
      logger,
      signingSecret: env.outboxSigningSecret,
      generation: {
        sql: plane.pool,
        producer: SERVICE,
        backends,
        blobs,
        preflight,
        logger: logger.child({ job: GENERATE_KIND }),
        // The REGISTRY for the pipeline's own `studio_*` names, which collide with nothing.
        metrics,
      },
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
      // Soft. No I/O, so it can never spend money or hang the probe.
      imageBackendProbe(preflight),
      // HARD. The boot check above refused an unwritable root; this is the root that goes
      // read-only, full or unmounted AFTERWARDS, which no boot check can see.
      assetRootProbe(env.assetRoot),
    ],
    beforeScrape: async () => {
      for (const plane of planes) {
        const stats = await plane.queue.stats()
        jobMetrics.set('jobs_pending', stats.pending, { network: plane.network })
        jobMetrics.set('jobs_overdue', stats.overdue, { network: plane.network })
      }
    },
    start: async () => {
      started = true
      for (const plane of planes) await seedRecurring(plane.queue)
      for (const runner of runners) runner.start()
    },
    stop: async () => {
      started = false
      // 40 seconds, not 20: a slot can hold an image call that has already been paid for, and
      // cutting it loses the money and produces nothing. The runners stop FIRST so an upload or a
      // generation in flight commits rather than being cut off with its pool closed under it.
      const clean = (await Promise.all(runners.map((r) => r.stop(40_000)))).every(Boolean)
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
 * module's `env` and cannot come into possession of a DSN or the image-model key.
 */
export function studioMigrationTargets(): readonly Target[] {
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
 * HOST's — this module holds the drain open in three routes, and an upload cut between the blob
 * write and the row is an orphaned file on a PVC nothing will ever clean up.
 */
function hostLifecycle(host: HostRuntime): ServerLifecycle {
  return {
    livez: () => {
      throw new Error('studio does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('studio does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as ServerLifecycle
}

type ServerLifecycle = Parameters<typeof mountableRoutes>[0]['lifecycle']
