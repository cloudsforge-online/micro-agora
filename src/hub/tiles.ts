/**
 * The tile: this service's central idea, and the thing every route is built out of.
 *
 * Rule 5 of the Forge Hub layout (docs/ecosystem/assets/design-system.md §6) is an exit criterion
 * rather than a preference: "every tile degrades alone — the dashboard fans out to ten services;
 * one slow upstream must cost one tile, not the page". A composed endpoint that throws when its
 * seventh upstream is unwell has moved the estate's least reliable component into the critical
 * path of its most visible one, and turned seven independent 99.9%s into a 99.3%.
 *
 * So the response is a 200 with holes, never a 500, and each hole names itself. Three statuses,
 * and the boundary between the first two is the one that matters:
 *
 *   - `ok`          — a fresh answer. Possibly from cache and inside its TTL, in which case the
 *                     tile still says `cached: true` and carries its age.
 *   - `degraded`    — data, but not current data. Either a stale cache entry served because the
 *                     upstream failed, or a tile whose secondary input was missing (a portfolio
 *                     with balances but no prices). Always with a reason.
 *   - `unavailable` — nothing. `data` holds the tile's empty value so a client renders an empty
 *                     state rather than branching on null, and `reason` says what happened.
 *
 * **`data` is never null and never absent.** An optional field is a field every consumer forgets
 * to check; an empty array is a field that renders correctly by accident. The tile's own `status`
 * is the single place a client asks whether to draw a warning.
 *
 * The reason string is built from the error's *class*, never from an upstream response body. A
 * body can contain anything the peer chose to put in it, and this response is rendered in a
 * browser.
 */

import { CircuitOpenError, HttpError, TimeoutError } from '@cloudsforge/http'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import type { TtlCache } from './cache.ts'

export type TileStatus = 'ok' | 'degraded' | 'unavailable'

/**
 * A tile that cannot be built for a structural reason rather than a transient one — no route
 * exists, or the credential this service holds cannot reach the data for this subject.
 *
 * Distinct from a network fault because the operator response is different: retrying will not
 * help, and the message is the whole point. `describeFault` therefore passes it through verbatim,
 * which is safe precisely because it is written here rather than received from a peer.
 */
export class NotComposableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotComposableError'
  }
}

export interface Tile<T> {
  readonly status: TileStatus
  /** Which service this tile came from. Named so an operator reading a degraded page knows where to look. */
  readonly upstream: string
  /** Present exactly when the status is not `ok`. Never contains an upstream body or a URL. */
  readonly reason: string | null
  /** True whenever the value came out of the cache rather than off the wire, fresh or stale. */
  readonly cached: boolean
  /** How old the cached value is. Null when it was fetched for this request. */
  readonly ageMs: number | null
  readonly data: T
}

export function okTile<T>(upstream: string, data: T): Tile<T> {
  return { status: 'ok', upstream, reason: null, cached: false, ageMs: null, data }
}

/**
 * A tile that has data but not confidence in it. Used where the loader itself succeeded but part
 * of what it needed did not — the portfolio with no usable price is the case this exists for.
 */
export function degradedTile<T>(upstream: string, data: T, reason: string): Tile<T> {
  return { status: 'degraded', upstream, reason, cached: false, ageMs: null, data }
}

export function unavailableTile<T>(upstream: string, empty: T, reason: string): Tile<T> {
  return { status: 'unavailable', upstream, reason, cached: false, ageMs: null, data: empty }
}

/**
 * Re-shape a tile's payload without touching its status.
 *
 * Used where two consumers need different views of one fetch — the security tile feeds both the
 * dashboard's account panel and the MFA card in "needs you". Deriving a second tile would mean a
 * second call to the same upstream and, worse, two statuses that could disagree about whether
 * identity is up.
 */
export function mapTile<A, B>(tile: Tile<A>, project: (value: A) => B): Tile<B> {
  return { ...tile, data: project(tile.data) }
}

/**
 * The worst of several statuses, for a tile derived from more than one upstream.
 *
 * Pessimistic on purpose: a panel built from identity and policy where policy is unavailable is
 * not `ok`, because half its content is silently missing and the user has no way to tell.
 */
export function worstStatus(statuses: readonly TileStatus[]): TileStatus {
  if (statuses.includes('unavailable')) return 'unavailable'
  if (statuses.includes('degraded')) return 'degraded'
  return 'ok'
}

export interface TileDeps {
  readonly cache: TtlCache
  /**
   * The estate this request belongs to, PREFIXED ONTO EVERY CACHE KEY below.
   *
   * Here rather than in each `LoadTile.key` literal, and that placement is the point: there are a
   * dozen of those and a thirteenth gets added every few weeks. One that forgot the prefix would
   * serve a mainnet portfolio to a testnet viewer — a correct-looking dashboard with somebody
   * else's estate's numbers in it, and no error anywhere. Prefixing at the single read site means
   * a new tile cannot forget.
   */
  readonly network: string
  readonly metrics: Metrics
  readonly logger: Logger
  readonly now?: () => number
}

export interface LoadTile<T> {
  /** The tile's name in the response and in `hub_tile_status_total`. Bounded set — it is a label. */
  readonly tile: string
  /** The service the data belongs to. Bounded set, and also a metric label. */
  readonly upstream: string
  /** Cache key. Always includes the user id: a shared key is a cross-account data leak. */
  readonly key: string
  readonly ttlMs: number
  readonly staleMs: number
  /** What the tile holds when there is nothing. Rendered as an empty state, never as an error. */
  readonly empty: T
  readonly load: () => Promise<T>
}

/**
 * Fetch one tile: cache, then upstream, then stale cache, then nothing.
 *
 * The order is the whole behaviour. A fresh cache entry short-circuits before the upstream is
 * touched, which is what makes the dashboard cheap under a refresh loop. On a miss the upstream is
 * called; if it fails, the stale window is consulted *before* giving up, because a portfolio from
 * forty seconds ago clearly labelled as such is worth more to a user than an empty tile — and
 * worth nothing at all if it is not labelled, which is why this path can only ever produce
 * `degraded`.
 *
 * This function does not throw. That is not defensive coding, it is the contract: a caller
 * composing seven of these must be able to `Promise.all` them without a single failure collapsing
 * the set.
 */
export async function loadTile<T>(deps: TileDeps, spec: LoadTile<T>): Promise<Tile<T>> {
  const now = deps.now ?? (() => Date.now())
  const key = `${deps.network}:${spec.key}`
  const cached = deps.cache.read<T>(key, spec.ttlMs, spec.staleMs)

  if (cached.outcome === 'fresh' && cached.value !== undefined) {
    deps.metrics.increment('hub_cache_hits_total', { upstream: spec.upstream })
    return record(deps, spec.tile, {
      status: 'ok',
      upstream: spec.upstream,
      reason: null,
      cached: true,
      ageMs: cached.ageMs,
      data: cached.value,
    })
  }

  const startedAt = now()
  try {
    const data = await spec.load()
    deps.metrics.observe('hub_upstream_ms', now() - startedAt, { service: spec.upstream })
    deps.cache.write(key, data)
    return record(deps, spec.tile, okTile(spec.upstream, data))
  } catch (err) {
    deps.metrics.observe('hub_upstream_ms', now() - startedAt, { service: spec.upstream })
    const reason = describeFault(spec.upstream, err)

    // Logged at warn, not error: an upstream being unwell is a thing this service is designed to
    // survive, and paging on it would page on every deploy of every peer. The tile counter is the
    // signal to alert from, because it distinguishes "one tile is unavailable" from "the page is".
    deps.logger.warn('upstream tile failed', { tile: spec.tile, upstream: spec.upstream, reason })

    // The stale window, consulted only now. Reading it before the upstream would serve old data
    // when new data was available for the asking.
    const stale = deps.cache.read<T>(key, spec.ttlMs, spec.staleMs)
    if (stale.value !== undefined) {
      deps.metrics.increment('hub_cache_hits_total', { upstream: spec.upstream })
      return record(deps, spec.tile, {
        status: 'degraded',
        upstream: spec.upstream,
        reason: `${reason}; showing a cached value`,
        cached: true,
        ageMs: stale.ageMs,
        data: stale.value,
      })
    }
    return record(deps, spec.tile, unavailableTile(spec.upstream, spec.empty, reason))
  }
}

/** Count the outcome, then hand the tile back unchanged. */
function record<T>(deps: TileDeps, tile: string, value: Tile<T>): Tile<T> {
  deps.metrics.increment('hub_tile_status_total', { tile, status: value.status })
  return value
}

/**
 * Turn a fault into a sentence an operator can act on and a user can read.
 *
 * Classified by error type rather than by message, and never by response body. `HttpError.body`
 * holds up to two kilobytes of whatever the peer decided to send; putting that in a field a
 * browser renders is a stored-XSS primitive with extra steps, and it leaks internals besides.
 *
 * The circuit-open case is called out separately on purpose. "The breaker is open" is a different
 * operational fact from "the call failed" — it says this service has *stopped* calling, which is
 * the behaviour that stops a struggling peer being hammered by every dashboard load in the estate.
 */
export function describeFault(upstream: string, err: unknown): string {
  // Written by this service, for this service. The only error whose message is echoed verbatim.
  if (err instanceof NotComposableError) return err.message
  if (err instanceof CircuitOpenError) {
    const seconds = Math.ceil(err.retryAfterMs / 1000)
    return `${upstream} circuit is open after repeated failures; not retrying for ~${seconds}s`
  }
  if (err instanceof TimeoutError) return `${upstream} did not answer within its deadline`
  if (err instanceof HttpError) return `${upstream} answered ${err.status}`
  if (err instanceof Error && err.name === 'AbortError') {
    return `${upstream} was still answering when the dashboard deadline expired`
  }
  return `${upstream} could not be reached`
}
