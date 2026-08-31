/**
 * The hub module: the account dashboard's backend-for-frontend, constructed behind one function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE FIRST MODULE OF THIS PROCESS THAT OWNS NO DATABASE, AND THAT IS THE WHOLE SHAPE.**
 *
 * Wave M5d (micro-deploy `docs/service-merge-plan.md`) folds hub-api into agora's process. Every
 * other module in this file's neighbourhood exists to hold a boundary around a POOL: `./env.ts`
 * imported here and nowhere above, every route stamped with `RouteSpec.sql`, a `JobRunner` bound
 * to one queue bound to one handle. None of that applies here, because there is no handle.
 *
 * What replaces it is a boundary of a different kind, and it is not weaker. hub composes seven
 * peers on behalf of a signed-in person, and its entire isolation is TWO lines: `forRequest`
 * narrowing the peer set to the estate the gateway stamped, and the cache key carrying the same
 * network. Get either wrong and it asks the right service the wrong estate's question and renders
 * the answer as a dashboard with nothing on it to say so — a failure with no error, no log line
 * and no metric, which is why `./network.test.ts` came across with the module.
 *
 * The one thing this module must NOT gain is a database. `mountableRoutes` omits `RouteSpec.sql`
 * on every spec, so an unstamped spec would resolve to the KERNEL's handle — agora's — and a hub
 * handler that learned to query would silently read the square's tables. Two things stop that,
 * and neither is a convention: this file constructs no pool and imports no `postgres`, and
 * `./server.ts`'s own `RequestContext` declares no `sql` field, so there is no expression a
 * handler could write to reach one. `./server.ts` rebuilds the kernel's context field by field
 * rather than spreading it for exactly this reason.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT THE MERGE CHANGES ABOUT FAILURE, AND WHAT IT DELIBERATELY DOES NOT ───────────────────
 *
 * hub is designed to serve through a peer being down: a dead upstream is a tile that says so, not
 * a page that fails. That is why every upstream probe it contributes is SOFT. A hard probe here
 * would now be far worse than it was standalone — it would remove the whole merged replica, and
 * with it the square, the market, the mint, the developer portal and thirteen other modules,
 * because the notification service had a bad minute.
 *
 * The ONE hard probe survives the merge unchanged: `serviceTokenProbe` fails only when no
 * credential is configured at all. That is a deployment in which every tile is unavailable and
 * which will not fix itself, and it is a fact about this pod rather than about a peer — so it is
 * as true a reason to hold the replica out of the balancer inside the merged process as it was
 * outside it. An identity OUTAGE still returns `warn` from that probe, not a failure, which is
 * what stops one bad minute in identity from emptying every balancer in the estate.
 *
 * ── THE CACHE ────────────────────────────────────────────────────────────────────────────────
 *
 * In-process and per-replica, as before, and now shared with fifteen other modules' heap. Its
 * occupancy is still sampled at scrape time rather than on a timer — there is no `setInterval` in
 * this module and CI greps for one (rule 8) — and `beforeScrape` below is where the host collects
 * it. Losing the cache costs a slow request and nothing else, which is the property that lets this
 * module be dropped into a process that restarts for somebody else's reasons.
 */

import { serviceTokenProbe } from '@cloudsforge/auth'
import { httpProbe, type Lifecycle, type Probe } from '@cloudsforge/lifecycle'
import { Logger, type Metrics } from '@cloudsforge/telemetry'
import type { RouteSpec } from '../kernel.ts'
import { TtlCache } from './cache.ts'
import { SERVICE, env } from './env.ts'
import { mountableRoutes, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { httpUpstreams } from './upstreams.ts'

/**
 * The label this module's metrics carry — and the one thing it does NOT need it for.
 *
 * Every other module in this process takes `metrics.withLabels({ module })` because it registers
 * a JOB kind that collides with another module's: four of them spell `outbox.relay`, and
 * `jobs_pending` carries no `kind` at all, so one module's sample overwrites another's. hub runs
 * NO jobs and has no queue, so it registers no `jobs_*` series and needs no labelled view. Its own
 * names — `hub_tile_status_total`, `hub_cache_entries` — are already prefixed and collide with
 * nothing; `../suitecomposition.test.ts` is what keeps that true.
 */
export const MODULE_LABEL = 'hub'

/** What the host process supplies. Deliberately nothing this module could hide a handle inside. */
export interface HostRuntime {
  /** The process-wide registry — the object the host's `/metrics` renders, not a view of it. */
  readonly metrics: Metrics
  /** The host's identity verifier. ONE JWKS client for the process; every module reads it. */
  readonly verifier: PrincipalVerifier
  /** The host `Lifecycle`'s `claimingJobs`. Unused here — hub claims no jobs — and taken anyway
   *  so every module in this process is built through one shape. */
  claimingJobs(): boolean
  /** The host `Lifecycle`'s `track`. An in-flight request holds the drain of the process that owns it. */
  track(): () => void
}

/** What the host process gets back. **No field here names a database handle, because none exists.** */
export interface HubModule {
  /**
   * `RouteSpec<unknown>`, where every other module's is `RouteSpec<Db>`.
   *
   * The parameter is contravariant — it reaches only `handle`'s context — so this is the WIDEST
   * of those types, not a weaker one: hub's handlers accept a context carrying any handle because
   * they never read it. `./server.ts`'s `mountableRoutes` says the same thing at more length.
   */
  readonly routes: readonly RouteSpec<unknown>[]
  /**
   * The readiness probes for THIS module: seven soft, one hard.
   *
   * Soft — identity's JWKS and the six peers' `/livez` — because this module is DESIGNED to serve
   * with any of them down, and a hard probe would take sixteen modules out of the balancer to
   * avoid showing one degraded tile. Hard — `serviceTokenProbe` — because no credential at all is
   * a deployment fault, not a peer's bad minute. See the file header.
   */
  readonly probes: readonly Probe[]
  beforeScrape(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  /**
   * `null`, and it is the honest answer rather than a placeholder.
   *
   * The host logs this on every `module ready` line. A `0` would read as "schema at version zero",
   * which is a database in an unmigrated state — the exact condition `assertSchemaAtLeast` exists
   * to refuse. `null` says there is no schema to be at a version OF.
   */
  readonly schemaVersion: number | null
}

/**
 * Build the hub half of this process.
 *
 * Throws rather than calling `process.exit`: the host owns the exit code, because a module that
 * killed the process would take fifteen others down for a hub fault at a point where the host has
 * a logger and a `fatal` line to write.
 *
 * `async` with nothing to await, deliberately. There is no pool to open and no schema to assert,
 * so this returns on the first tick — and it keeps the signature every other module's factory has,
 * which is what lets `../index.ts` build all of them through one `build()` helper rather than
 * special-casing the one that happens not to need the await.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function createHubModule(host: HostRuntime): Promise<HubModule> {
  const metrics = host.metrics
  const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env })
  registerServiceMetrics(metrics)
  logger.info('starting', {
    version: env.version,
    dashboardDeadlineMs: env.dashboardDeadlineMs,
    upstreamDeadlineMs: env.upstreamDeadlineMs,
  })

  // The upstream clients. ONE client per peer, because `@cloudsforge/http` scopes its circuit
  // breaker to the client: sharing one would let a sick pricing service open the circuit on the
  // ledger. Built here rather than taken from the host for the same reason every other module
  // builds its own — the host has no name for hub's peers, and could not hand it the wrong ones.
  const upstreams = httpUpstreams({
    env,
    metrics,
    onTokenEvent: (event) => {
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

  if (!upstreams.tokenProviders.ledger) {
    // Not a throw: the merged image must be able to boot without hub's credential, because
    // refusing would take fifteen working modules down over one module's missing secret — the
    // inverse of the reason the standalone service logged rather than exited. `/readyz` is where
    // the absence is enforced, by the hard `identity-credential` probe below.
    logger.error('HUB_API_IDENTITY_CREDENTIAL is not set; every tile will be unavailable', {
      hint: 'deploy/scripts/estate-bootstrap.sh writes it to compose/estate/tokens.env',
    })
  }
  if (env.legacyServiceTokenPresent) {
    logger.error('one or more HUB_*_TOKEN variables are set and are IGNORED', {
      hint: 'all six were 600-second tokens read once at boot; HUB_API_IDENTITY_CREDENTIAL replaces them',
    })
  }

  // In-process and per-replica, on purpose — see the file header.
  const cache = new TtlCache()

  // ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
  //
  // The boot-time view only. `forRequest` replaces it per request from the header the gateway
  // stamped, which is what makes one pod able to answer for both estates. `./ownnetwork.test.ts`
  // would be the guard if this module keyed anything by the literal `mainnet`; it does not.
  const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

  const routes = mountableRoutes({
    lifecycle: hostLifecycle(host),
    logger,
    metrics,
    verifier: host.verifier,
    upstreamsFor: upstreams,
    upstreams: upstreams.for(ownNetwork),
    ...(env.singleNetwork ? { singleNetwork: env.singleNetwork as 'mainnet' | 'testnet' } : {}),
    cache,
    dashboardDeadlineMs: env.dashboardDeadlineMs,
    poolApi: env.poolApi,
  })

  metrics.register({
    name: 'hub_cache_entries',
    help: 'Entries currently held in the in-process tile cache',
    kind: 'gauge',
  })

  return {
    routes,
    probes: [
      httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }),
      // HARD, unlike every upstream probe below. It does not report a peer having a bad minute —
      // it fails only when no credential is configured at all. Any one provider answers for all
      // seven: they are built together from the same credential, so either all are present or
      // none is.
      serviceTokenProbe(upstreams.tokenProviders.ledger),
      // Named with the module prefix, unlike the standalone service's. `/readyz` now reports
      // sixteen modules' probes in one document, and `ledger` would be ambiguous the moment
      // another module probes the same peer — which several of them do.
      ...(['ledger', 'wallet', 'pricing', 'activity', 'notify'] as const).map((peer) =>
        httpProbe(`${MODULE_LABEL}-${peer}`, `${env.upstreams[peer].replace(/\/+$/, '')}/livez`, {
          kind: 'soft',
        }),
      ),
    ],
    beforeScrape: async () => {
      // Sampled at scrape time rather than on a timer — see the file header.
      metrics.set('hub_cache_entries', cache.size)
    },
    start: async () => {
      // Nothing to start. hub runs no job runner, seeds no recurring work and opens no pool: it is
      // ready the moment its routes are mounted. Present so the host builds every module through
      // one shape.
    },
    stop: async () => {
      // Nothing to stop either. The HttpClients hold no sockets the process's own `server.close()`
      // does not already drain, and the cache is memory. Emptying it here would be a lie about
      // what shutdown does — the heap goes with the process.
      logger.info('hub module stopped')
    },
    schemaVersion: null,
  }
}

/**
 * The `Lifecycle` shape `mountableRoutes` demands, with the two dead handlers refusing.
 *
 * `/livez` and `/readyz` are filtered out of the mounted table; `track()` is live and must be the
 * HOST's, so an in-flight dashboard composition holds the drain of the process that is actually
 * shutting down. The two probe methods throw rather than answering plausibly, so if the filter is
 * ever removed the shadowed route fails loudly instead of reporting a readiness it did not compute.
 */
function hostLifecycle(host: HostRuntime): Lifecycle {
  return {
    livez: () => {
      throw new Error('hub does not serve /livez in the merged process — agora does')
    },
    readyz: () => {
      throw new Error('hub does not serve /readyz in the merged process — agora does')
    },
    track: () => host.track(),
  } as unknown as Lifecycle
}
