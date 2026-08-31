/**
 * The HTTP surface.
 *
 * Plain `node:http`, following the template. The parts that matter — request ids, RED metrics, the
 * child logger, the error shape, the auth-fault mapping — are framework-independent, and the four
 * health handlers are what CI checks for (rule 4 of docs/ecosystem/03 §2).
 *
 * The one decision that is easy to get backwards is the auth-fault mapping. A bad token is 401. A
 * verifier that could not reach the JWKS is **503**, never 401 — answering 401 there signs every
 * user in the estate out because the identity service is having a bad minute.
 *
 * ── This service refuses a service token ───────────────────────────────────────────────────────
 *
 * Every route below requires a *user* principal. A BFF is a view for a human being holding a
 * session; there is no such thing as a service's dashboard, and accepting a service token here
 * would create a route by which any credential in the estate could read any user's portfolio,
 * wallets, security state and activity in one call. That is a much larger authority than any of
 * the eight upstreams grants individually, and it would exist only because this service composes
 * them. An operator with the `admin` role may name `?userId=`, which is the one supported way to
 * look at somebody else's dashboard — and even then the security tile degrades rather than
 * forwarding the operator's own identity as if it were the subject's.
 *
 * ── Why nothing here returns 500 for an upstream fault ─────────────────────────────────────────
 *
 * `composeDashboard` resolves whatever happens. A route that caught its result and turned a
 * degraded page into a 503 would undo the entire design.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  statusFor,
  type Principal,
} from '@cloudsforge/auth'
import { HttpError, NetworkUnknownError, requestNetwork, type Network } from '@cloudsforge/http'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import type { RequestContext as KernelContext, RouteSpec } from '../kernel.ts'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import type { TtlCache } from './cache.ts'
import { composeDashboard, type DashboardDeps } from './dashboard.ts'
import { buildNextActions, type FactorSummary, type NextActions } from './nextactions.ts'
import { composePortfolioTile } from './dashboard.ts'
import { search } from './search.ts'
import { loadTile, NotComposableError, type Tile, type TileDeps } from './tiles.ts'
import {
  CACHE,
  PAGE,
  type ActivityPage,
  type ActivityRecord,
  type ConversionIntent,
  type ConversionPage,
  type DepositCredit,
  type LedgerBalance,
  type PolicyFreeze,
  type PricingRate,
  type TransferPage,
  type Upstreams,
  type UpstreamsFor,
  type WithdrawalRecord,
} from './upstreams.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  /**
   * The peers, as a per-network SELECTOR. `forRequest` narrows it to this request's estate before
   * any route sees it, so every outbound call carries the right `CF-Network`.
   *
   * hub-api holds no database, so this — and the cache key — is the whole of its isolation. Get it
   * wrong and it asks the right service the WRONG QUESTION, then renders the answer.
   */
  readonly upstreamsFor: UpstreamsFor
  /** `CF_NETWORK_SINGLE`, for `pnpm dev`, which has no gateway to stamp the header. */
  readonly singleNetwork?: Network
  /** Narrowed per request by `forRequest`; the boot-time value answers for the default network. */
  readonly upstreams: Upstreams
  readonly cache: TtlCache
  readonly dashboardDeadlineMs: number
  /**
   * What `GET /v1/deployment` answers about this estate. Passed in rather than read from `env`
   * here for the reason every other value in this interface is: a test drives both answers without
   * touching the process environment.
   */
  readonly poolApi: 'present' | 'absent'
  /** Injected clock, so cache ages and elapsed times are deterministic under test. */
  readonly now?: () => number
  readonly beforeScrape?: () => Promise<void>
}

/**
 * Domain metrics, declared rather than inferred from a log line — AD-20.
 *
 * `hub_tile_status_total` is the one to alert on, and its shape is the reason: `{tile, status}`
 * distinguishes "the wallet tile has been unavailable for ten minutes" from "the page is down",
 * which a single request-level error rate cannot. A dashboard serving 200s with one dead tile
 * looks perfectly healthy in `http_requests_total`, and that is by design — so the signal has to
 * live here.
 */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'hub_dashboard_ms',
      help: 'Wall-clock time to compose a dashboard, including every upstream call',
      kind: 'histogram',
      // Bucketed around the deadline rather than around the happy path: what an operator needs to
      // see is the shoulder forming at the budget, not the shape of the fast case.
      buckets: [25, 50, 100, 250, 500, 1_000, 2_000, 3_000, 5_000],
    })
    .register({
      name: 'hub_tile_status_total',
      help: 'Tiles composed, by tile and outcome',
      kind: 'counter',
      labels: ['tile', 'status'],
    })
    .register({
      name: 'hub_upstream_ms',
      help: 'Time spent in one upstream call attempt that reached the peer',
      kind: 'histogram',
      labels: ['service'],
      buckets: [5, 10, 25, 50, 100, 250, 500, 1_000, 2_000, 5_000],
    })
    /**
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **THE ONE SERIES THAT CAN TELL A DEAD CREDENTIAL FROM A DEAD PEER.**
     *
     * Until this existed, everything hub-api recorded about an outbound call was a duration
     * labelled by service. A duration cannot say whether a call failed, let alone how — so a
     * revoked service credential, a peer refusing us, and a peer that is genuinely down were all
     * the same three-millisecond observation on `hub_upstream_ms`, and the credential case looked
     * BETTER than healthy because a call that never left the process is fast.
     *
     * `outcome` is `ResultEvent`'s union from `@cloudsforge/http`, and `token_unavailable` is the
     * member that matters here: it is the one value describing a call that did not happen, raised
     * when this process could not mint a service token. On the testnet estate on 2026-08-10 that
     * exact fault was reported to operators for hours as the indexer being unreachable, and the
     * remedy printed beside it sent them to a healthy service (micro-org#351). A reason code only
     * ends that if an operator can select on it, and selecting means a label.
     *
     * `circuit_open` is here for the same reason and is worth its own alert: it means this process
     * refused its own call, so it will not appear in the peer's logs at all.
     *
     * **The label list is not decoration.** `@cloudsforge/telemetry` drops any label a spec does
     * not declare — silently until 1.0.1, which is how ledger's identical counter has been writing
     * `outcome` into nothing since it was written. Adding a member to that union without adding it
     * here loses it.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    .register({
      name: 'hub_upstream_calls_total',
      help: 'Upstream call attempts, by service and by how the attempt ended',
      kind: 'counter',
      labels: ['service', 'outcome'],
    })
    .register({
      name: 'hub_cache_hits_total',
      help: 'Tiles served from cache, fresh or stale, by upstream',
      kind: 'counter',
      labels: ['upstream'],
    })
}

/**
 * An inbound request id is trusted only if it is safe to put in a log line and echo in a header.
 * Anything else is replaced rather than rejected — an unvalidated value here is a header-injection
 * and a log-forgery primitive at once.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Long enough for an address or a transaction hash, short enough not to be a payload. */
const MAX_QUERY_LENGTH = 128

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
}

/**
 * Routes that answer without belonging to a network.
 *
 * Kubelet probes the first two and Prometheus scrapes the third; none arrives through the gateway,
 * so none carries `CF-Network`. Refusing them turns a data-isolation rule into a CrashLoopBackOff —
 * which is exactly what agora's first build did: 500 on every probe, container never ready.
 */
const OPERATIONAL_ROUTES: ReadonlySet<string> = new Set(['/livez', '/readyz', '/metrics'])

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  /** Segments captured by a `:name` in the matched route's path. Empty for a literal route. */
  readonly params: Readonly<Record<string, string>>
  /**
   * The estate THIS REQUEST belongs to, from the `CF-Network` header the gateway stamped.
   *
   * hub-api holds no database, so this value is the whole of its isolation: it selects the peers
   * every tile is fetched from AND prefixes every cache key. Not a property of the process — one
   * pod serves both estates, so "which network am I" has no answer.
   */
  readonly network: Network
}

interface Route {
  readonly method: string
  /** A literal path, or one with `:name` segments — see `matchPath`. */
  readonly path: string
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

/**
 * Match one route pattern against a path, capturing `:name` segments.
 *
 * Every route in this service was a literal string until `GET /v1/conversions/:id` arrived, and the
 * router was `r.path === url.pathname`. This is the smallest thing that serves that route without
 * becoming a framework: segment count must agree, a `:name` segment captures, and everything else
 * must be equal. There is no wildcard, no optional segment and no regular expression, because none
 * of those has a caller.
 *
 * **The captured value is decoded here and nowhere else.** `url.pathname` is still percent-encoded,
 * and an id that reached an upstream still encoded would be a different id than the one asked for —
 * silently, and only for the ids that happen to contain an encodable character.
 */
function matchPath(pattern: string, pathname: string): Readonly<Record<string, string>> | null {
  if (!pattern.includes(':')) return pattern === pathname ? EMPTY_PARAMS : null
  const want = pattern.split('/')
  const got = pathname.split('/')
  if (want.length !== got.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const segment = want[i] as string
    const value = got[i] as string
    if (segment.startsWith(':')) {
      // An empty segment is not a match. `/v1/conversions/` would otherwise capture '' and be
      // proxied as a request for the conversion whose id is the empty string.
      if (value.length === 0) return null
      try {
        params[segment.slice(1)] = decodeURIComponent(value)
      } catch {
        // A malformed escape is not a route match; it is a path this service does not serve, and
        // answering 404 is truer than answering 400 about a segment nothing would have accepted.
        return null
      }
      continue
    }
    if (segment !== value) return null
  }
  return params
}

const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze({})

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'
    let route: Route | undefined
    let params: Readonly<Record<string, string>> = EMPTY_PARAMS
    for (const candidate of routes) {
      if (candidate.method !== method) continue
      const matched = matchPath(candidate.path, url.pathname)
      if (matched === null) continue
      route = candidate
      params = matched
      break
    }
    // Unmatched paths collapse to one label. Using the raw path would let any caller mint
    // unbounded time series and take the scrape target down with cardinality — and that is why the
    // label is the PATTERN rather than the matched path: `/v1/conversions/:id` is one series, while
    // the ids that reach it are unbounded and attacker-chosen.
    const routeLabel = route ? route.path : 'unmatched'

    const log = deps.logger.child({ requestId, method: req.method ?? 'GET', route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number, metricNetwork: string) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method: req.method ?? 'GET',
        route: routeLabel,
        status: String(status),
        // One target now serves both estates, so the network has to be on the SERIES. Labelled
        // per target it would say nothing — micro-org#398 in a form nothing could recover.
        network: metricNetwork,
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method: req.method ?? 'GET',
        route: routeLabel,
        network: metricNetwork,
      })
    }

    // ── THE NETWORK, BEFORE ANY ROUTE RUNS ────────────────────────────────────────────────────
    //
    // `requestNetwork` REFUSES an unstamped request rather than assuming mainnet: a 500 is a
    // routing fault made loud, where a default is a dashboard rendered from the other estate with
    // nothing to say so.
    const networkless = route !== undefined && OPERATIONAL_ROUTES.has(route.path)
    let network: Network
    try {
      network = networkless
        ? (deps.singleNetwork ?? 'mainnet')
        : requestNetwork(req.headers, deps.singleNetwork ? { fallback: deps.singleNetwork } : {})
    } catch (err) {
      log.error('request carries no usable network', {
        err: err instanceof NetworkUnknownError ? err.message : err,
      })
      send(
        res,
        errorReply(500, 'network_unknown', 'this request could not be attributed to a network', requestId),
        requestId,
      )
      finish(500, 'unknown')
      return
    }

    void handle(route, { req, url, requestId, log, params, network }, forRequest(deps, network))
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status, network)
      })
      .catch((err: unknown) => {
        // Reaching here means the error mapping itself failed. Answer, then say so loudly.
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500, network)
      })
  })
}

/**
 * The deps a REQUEST sees: the peers narrowed to this request's estate.
 *
 * hub-api holds no database. Its entire isolation is this line plus the cache key — narrow the
 * peers to the wrong estate and it asks the right services the wrong question, then renders the
 * answer as a dashboard with no indication that anything is amiss.
 */
function forRequest(deps: ServerDeps, network: Network): ServerDeps {
  return { ...deps, upstreams: deps.upstreamsFor.for(network) }
}

async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    // `statusFor` is the whole point: it is the one place that decides what an auth failure means,
    // so five services cannot disagree about it again.
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof UpstreamRefusalError) {
      // At info, not error. An upstream refusing a request it understood is a normal outcome of a
      // form — a desk that is out of EMBER is the feature working — and logging it as a fault would
      // put the one page whose refusals are expected at the top of the error rate.
      ctx.log.info('upstream refused the request', { status: err.status, code: err.code })
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof BadRequestError) {
      return errorReply(400, err.code, err.message, ctx.requestId)
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/livez',
      /**
       * Static, deliberately. Liveness answers one question — should this process be killed and
       * restarted — and a liveness probe that consults a dependency restarts a healthy process
       * every time an upstream blinks. For a service whose entire job is calling eight upstreams,
       * that would be a restart loop driven by somebody else's deploy.
       */
      handle: async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() }),
    },
    {
      method: 'GET',
      path: '/readyz',
      handle: async (_ctx, deps) => {
        const report = await deps.lifecycle.readyz()
        // 503 is what removes this replica from the balancer. Every upstream probe here is soft:
        // this service is *designed* to serve with an upstream down, so a hard probe on one would
        // take the whole dashboard out of rotation to avoid showing one degraded tile.
        return {
          status: report.ready ? 200 : 503,
          body: { ...report, circuits: deps.upstreamsFor.circuitStates() },
        }
      },
    },
    {
      method: 'GET',
      path: '/metrics',
      handle: async (ctx, deps) => {
        try {
          await deps.beforeScrape?.()
        } catch (err) {
          // A gauge that could not be sampled is a stale gauge. Failing the scrape instead would
          // lose every other metric too, and blind the dashboard at the moment it is needed.
          ctx.log.warn('gauge refresh failed; serving the previous values', { err })
        }
        return {
          status: 200,
          text: deps.metrics.render(),
          contentType: 'text/plain; version=0.0.4; charset=utf-8',
        }
      },
    },

    {
      method: 'GET',
      path: '/v1/deployment',
      /**
       * ONE DEPLOY FACT, UNAUTHENTICATED, SO THE OTHER ESTATE'S PAGE CAN ASK IT.
       *
       * `{ "poolApi": "present" | "absent" }` — the same field name and the same vocabulary as the
       * `/deployment.json` hub-web's nginx renders, so ONE parser in that bundle reads both. See
       * `env.poolApi` for why a BFF answers a question about a container's nginx at all: under the
       * combined view the page and the estate it is reading are not the same deployment, and a WEB
       * path cannot be asked across estates because the `-testnet` web hostnames redirect.
       *
       * NO BEARER, deliberately. This says whether a service exists, which is already visible to
       * anyone who resolves the hostname, and it is read by a page that has not signed in yet —
       * the mining bar renders for signed-out readers. Gating it would make the pool panel's
       * explanation of its own absence depend on a session, which is the shape of bug this route
       * exists to remove. It touches no upstream, no database and no user, so there is nothing
       * here to rate-limit that the gateway does not already.
       *
       * It reports the estate this PROCESS belongs to. That is the whole contract: a caller asks
       * the estate it means to ask, on that estate's `/v1`, and gets that estate's answer.
       */
      handle: async (_ctx, deps) => ({
        status: 200,
        body: { poolApi: deps.poolApi },
      }),
    },
    {
      method: 'GET',
      path: '/v1/dashboard',
      handle: async (ctx, deps) => {
        const subject = await resolveSubject(ctx, deps)
        const done = deps.lifecycle.track()
        try {
          const dashboard = await composeDashboard(dashboardDeps(deps, ctx.network), {
            userId: subject.userId,
            bearer: subject.forwardableBearer,
            requestId: ctx.requestId,
          })
          // Logged at info with the degraded list rather than at warn: a degraded dashboard is a
          // normal, expected, successful response, and logging it as a problem would drown the
          // one case that is a problem.
          ctx.log.info('dashboard composed', {
            userId: subject.userId,
            elapsedMs: dashboard.elapsedMs,
            degraded: dashboard.degraded,
          })
          return { status: 200, body: dashboard }
        } finally {
          done()
        }
      },
    },

    {
      method: 'GET',
      path: '/v1/portfolio',
      handle: async (ctx, deps) => {
        const subject = await resolveSubject(ctx, deps)
        const tileDeps = tileDepsOf(deps, ctx.network)
        const done = deps.lifecycle.track()
        try {
          const [balances, prices] = await Promise.all([
            loadTile<readonly LedgerBalance[]>(tileDeps, {
              tile: 'portfolio',
              upstream: 'ledger',
              key: `ledger:balances:${subject.userId}`,
              ...CACHE.ledgerBalances,
              empty: [],
              load: () => deps.upstreams.ledgerBalances(subject.userId, ctx.requestId),
            }),
            loadTile<readonly PricingRate[]>(tileDeps, {
              tile: 'prices',
              upstream: 'pricing',
              key: 'pricing:rates',
              ...CACHE.pricingRates,
              empty: [],
              load: () => deps.upstreams.pricingRates(ctx.requestId),
            }),
          ])
          // Never a bare number. The tile carries the status, the reason, whether it was cached
          // and how old it is; the payload carries `pricedAt` and `pricingComplete`.
          return { status: 200, body: { portfolio: composePortfolioTile(balances, prices) } }
        } finally {
          done()
        }
      },
    },

    {
      method: 'GET',
      path: '/v1/activity',
      /**
       * A pass-through, with the cursor preserved exactly as activity issued it.
       *
       * The cursor is opaque and stays opaque: it is activity's keyset position, this service does
       * not parse it, and re-encoding it would create a second cursor format that has to be kept
       * in step with the first for ever.
       *
       * Only the first page is cached. A cursored page is fetched once by one client walking a
       * feed, so caching it would fill the map with entries nobody reads again — and a cached
       * *middle* page is the one that goes subtly wrong when new records arrive at the head.
       */
      handle: async (ctx, deps) => {
        const subject = await resolveSubject(ctx, deps)
        const limit = readLimit(ctx, PAGE.activity)
        const cursor = ctx.url.searchParams.get('cursor')
        const done = deps.lifecycle.track()
        try {
          const tile = await loadTile<ActivityPage>(tileDepsOf(deps, ctx.network), {
            tile: 'activity',
            upstream: 'activity',
            key:
              cursor === null
                ? `activity:page:${subject.userId}:${limit}`
                : `activity:uncached:${subject.userId}:${cursor}:${limit}`,
            ttlMs: cursor === null ? CACHE.activityFeed.ttlMs : 0,
            staleMs: cursor === null ? CACHE.activityFeed.staleMs : 0,
            empty: { records: [], nextCursor: null },
            load: () => deps.upstreams.activityFeed(subject.userId, limit, cursor, ctx.requestId),
          })
          return {
            status: 200,
            body: {
              records: tile.data.records,
              nextCursor: tile.data.nextCursor,
              status: tile.status,
              reason: tile.reason,
              cached: tile.cached,
              ageMs: tile.ageMs,
            },
          }
        } finally {
          done()
        }
      },
    },

    /* ------------------------------------------------------- the exchange desk (micro-org#496) */

    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * THE FIRST FIVE ROUTES ON THIS SERVICE THAT ARE NOT COMPOSITIONS, AND THE FIRST TWO THAT
     * MOVE MONEY.
     *
     * Everything above this line fans out to several upstreams and returns tiles: a failure is a
     * status on one tile and the page still draws. These five are PROXIES of one route each on
     * micro-wallet, and they behave differently on purpose.
     *
     *   - The two reads are still tiles, because they are lists on a page that has other lists on
     *     it, and a wallet outage should cost that page one panel rather than the whole screen.
     *   - The DETAIL read is not a tile. A tile's `empty` for a single record would be a conversion
     *     that does not exist, rendered as though it did.
     *   - The two writes are not tiles either, and their refusals are forwarded verbatim — see
     *     `UpstreamRefusalError`. A 409 `desk_inventory_short` that arrived at the browser as a 500
     *     would turn "we are out of EMBER, try a smaller amount" into "something went wrong", which
     *     is the difference between a user who knows what to do next and a support ticket.
     *
     * WHY hub-web CALLS THESE AT ALL, when it calls micro-wallet directly for withdrawals: because
     * this is the seam micro-org#496 asked for, and because the two reads need `?userId=` for the
     * operator view that `resolveSubject` already owns. The write routes forward the reader's own
     * bearer and gain this service no authority it did not have — `Upstreams.quoteConversion` has
     * the argument, and it is about `HUB_UPSTREAM_SCOPES.wallet` being a read credential.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */

    {
      method: 'POST',
      path: '/v1/conversions/quote',
      /**
       * What a conversion would come to, without making one.
       *
       * A POST rather than a GET because wallet made it one, and for wallet's reason: this is the
       * front half of the conversion — the same validation, the same pricing upstream, the same
       * refusals — with the booking left off. Nothing is cached: a quote is a price at an instant,
       * and a cached price is a price somebody trades at after it stopped being true.
       *
       * No idempotency key, because nothing is claimed. `hold: false` and `holdNotice` come back in
       * the body and are forwarded untouched, which is what lets the confirm step say the quote is
       * not a hold without this estate writing the sentence twice.
       */
      handle: async (ctx, deps) => {
        const bearer = await convertingBearer(ctx, deps)
        const intent = await readConversionIntent(ctx)
        const done = deps.lifecycle.track()
        try {
          const quote = await forwardingRefusals(() =>
            deps.upstreams.quoteConversion(bearer, intent, ctx.requestId),
          )
          return { status: 200, body: { quote } }
        } finally {
          done()
        }
      },
    },

    {
      method: 'POST',
      path: '/v1/conversions',
      /**
       * Make the conversion.
       *
       * 201 for a new one and 200 for a replay, both forwarded from wallet rather than decided here:
       * that distinction is a fact about whether an entry was written, and only the service that
       * writes entries knows it.
       *
       * The `Idempotency-Key` is REQUIRED and is the caller's own, forwarded verbatim. A key minted
       * in this process would be a new key on every hop, so the retry that idempotency exists for —
       * the browser sending the same press twice because the first response was lost — would book a
       * second conversion. Refused here rather than at wallet only so the refusal names the header
       * the caller has to add; the code is wallet's own, so a client handles one code either way.
       */
      handle: async (ctx, deps) => {
        const bearer = await convertingBearer(ctx, deps)
        const key = headerOf(ctx.req, 'idempotency-key')
        if (!key || key.trim().length === 0) {
          throw new BadRequestError(
            'an Idempotency-Key header is required to make a conversion',
            'idempotency_key_required',
          )
        }
        const intent = await readConversionIntent(ctx)
        const done = deps.lifecycle.track()
        try {
          const receipt = await forwardingRefusals(() =>
            deps.upstreams.convert(bearer, intent, key, ctx.requestId),
          )
          ctx.log.info('conversion booked', {
            entryId: receipt.entryId,
            replayed: receipt.replayed,
            fromAssetCode: intent.fromAssetCode,
            toAssetCode: intent.toAssetCode,
          })
          return { status: receipt.replayed ? 200 : 201, body: receipt }
        } finally {
          done()
        }
      },
    },

    {
      method: 'GET',
      path: '/v1/conversions',
      /**
       * This reader's conversions, newest first, cursor-paged.
       *
       * Flat like `/v1/activity` rather than nested in a tile: `records`, `nextCursor`, `status`,
       * `reason`, `cached` and `ageMs` at the top level. Two paged lists in one bundle reading two
       * different shapes is how a client ends up with two pagers.
       *
       * The cursor is wallet's keyset position and is passed back byte-for-byte, for the reason
       * `/v1/activity` states: re-encoding it would create a second cursor format to keep in step
       * with the first for ever. Only the first page is cached, same rule and same reason.
       */
      handle: async (ctx, deps) => {
        const subject = await resolveSubject(ctx, deps)
        const limit = readLimit(ctx, PAGE.conversions)
        const cursor = ctx.url.searchParams.get('cursor')
        const done = deps.lifecycle.track()
        try {
          const tile = await loadTile<ConversionPage>(tileDepsOf(deps, ctx.network), {
            tile: 'conversions',
            upstream: 'wallet',
            key:
              cursor === null
                ? `wallet:conversions:${subject.userId}:${limit}`
                : `wallet:conversions:uncached:${subject.userId}:${cursor}:${limit}`,
            ttlMs: cursor === null ? CACHE.walletConversions.ttlMs : 0,
            staleMs: cursor === null ? CACHE.walletConversions.staleMs : 0,
            empty: { conversions: [], nextCursor: null },
            load: () =>
              deps.upstreams.walletConversions(subject.userId, limit, cursor, ctx.requestId),
          })
          return {
            status: 200,
            body: {
              conversions: tile.data.conversions,
              nextCursor: tile.data.nextCursor,
              status: tile.status,
              reason: tile.reason,
              cached: tile.cached,
              ageMs: tile.ageMs,
            },
          }
        } finally {
          done()
        }
      },
    },

    {
      method: 'GET',
      path: '/v1/transfers',
      /**
       * This reader's transfers, sent and received, newest first.
       *
       * Composed here even though nothing in this estate can yet SEND one: `POST /v1/transfers`
       * takes an internal `toUserId` and no surface can resolve a handle to one, so the send form is
       * still absent. The list is not, and that is the point — `pages/wallet.tsx` carried a
       * paragraph saying transfers had nowhere to show a result, and the paragraph outlived the hole
       * it described the moment wallet grew this route.
       */
      handle: async (ctx, deps) => {
        const subject = await resolveSubject(ctx, deps)
        const limit = readLimit(ctx, PAGE.conversions)
        const cursor = ctx.url.searchParams.get('cursor')
        const done = deps.lifecycle.track()
        try {
          const tile = await loadTile<TransferPage>(tileDepsOf(deps, ctx.network), {
            tile: 'transfers',
            upstream: 'wallet',
            key:
              cursor === null
                ? `wallet:transfers:${subject.userId}:${limit}`
                : `wallet:transfers:uncached:${subject.userId}:${cursor}:${limit}`,
            ttlMs: cursor === null ? CACHE.walletConversions.ttlMs : 0,
            staleMs: cursor === null ? CACHE.walletConversions.staleMs : 0,
            empty: { transfers: [], nextCursor: null },
            load: () => deps.upstreams.walletTransfers(subject.userId, limit, cursor, ctx.requestId),
          })
          return {
            status: 200,
            body: {
              transfers: tile.data.transfers,
              nextCursor: tile.data.nextCursor,
              status: tile.status,
              reason: tile.reason,
              cached: tile.cached,
              ageMs: tile.ageMs,
            },
          }
        } finally {
          done()
        }
      },
    },

    {
      method: 'GET',
      path: '/v1/conversions/:id',
      /**
       * One conversion, by the id of the journal entry that is it.
       *
       * **Deliberately not a tile.** Every other list read here degrades to `empty` and says so, and
       * `empty` for a single record would be a conversion with no id, no assets and no amounts,
       * rendered by a detail page as though the record existed and were blank. A read of one thing
       * either produces that thing or fails.
       *
       * wallet answers 404 for a missing id, for an entry that is not a conversion and for somebody
       * else's alike, and that 404 is forwarded rather than translated: the three are indistinguishable
       * there on purpose, because a 403 on an id that exists and a 404 on one that does not is an
       * oracle for enumerating other people's entry ids. Translating it here would rebuild the oracle
       * one layer up.
       */
      handle: async (ctx, deps) => {
        const subject = await resolveSubject(ctx, deps)
        const id = ctx.params['id'] ?? ''
        const done = deps.lifecycle.track()
        try {
          const conversion = await forwardingRefusals(() =>
            deps.upstreams.walletConversion(subject.userId, id, ctx.requestId),
          )
          return { status: 200, body: { conversion } }
        } finally {
          done()
        }
      },
    },

    {
      method: 'GET',
      path: '/v1/search',
      handle: async (ctx, deps) => {
        const subject = await resolveSubject(ctx, deps)
        const query = ctx.url.searchParams.get('q') ?? ''
        if (query.trim().length === 0) {
          throw new BadRequestError('q is required and must not be empty')
        }
        if (query.length > MAX_QUERY_LENGTH) {
          throw new BadRequestError(`q must be at most ${MAX_QUERY_LENGTH} characters`)
        }
        const done = deps.lifecycle.track()
        try {
          const results = await search(
            { ...tileDepsOf(deps, ctx.network), upstreams: deps.upstreams },
            { userId: subject.userId, query, requestId: ctx.requestId },
          )
          return { status: 200, body: results }
        } finally {
          done()
        }
      },
    },

    {
      method: 'GET',
      path: '/v1/next-actions',
      /**
       * The "needs you" cards on their own, for a client that polls them more often than it
       * reloads the whole dashboard. Same loaders, same cache keys, same degradation: a card whose
       * source is down is absent, and `missing[]` says which source and why.
       */
      handle: async (ctx, deps) => {
        const subject = await resolveSubject(ctx, deps)
        const tileDeps = tileDepsOf(deps, ctx.network)
        const done = deps.lifecycle.track()
        try {
          const [deposits, withdrawals, security, freezes, subscriptions] = await Promise.all([
            loadTile<readonly DepositCredit[]>(tileDeps, {
              tile: 'deposits',
              upstream: 'wallet',
              key: `wallet:deposits:pending:${subject.userId}`,
              ...CACHE.walletDeposits,
              empty: [],
              load: async () =>
                (await deps.upstreams.walletDeposits(subject.userId, ctx.requestId)).filter(
                  (credit) => !credit.credited,
                ),
            }),
            loadTile<readonly WithdrawalRecord[]>(tileDeps, {
              tile: 'withdrawals',
              upstream: 'wallet',
              key: `wallet:withdrawals:active:${subject.userId}`,
              ...CACHE.walletWithdrawals,
              empty: [],
              load: async () =>
                (await deps.upstreams.walletWithdrawals(subject.userId, ctx.requestId)).filter(
                  (withdrawal) =>
                    withdrawal.state !== 'settled' &&
                    withdrawal.state !== 'failed' &&
                    withdrawal.state !== 'refunded' &&
                    withdrawal.state !== 'cancelled',
                ),
            }),
            loadTile<FactorSummary | null>(tileDeps, {
              tile: 'security',
              upstream: 'identity',
              key: `identity:factors:${subject.userId}`,
              ...CACHE.identitySecurity,
              empty: null,
              load: async () => {
                if (subject.forwardableBearer === null) {
                  throw new NotComposableError(
                    'identity exposes no service-readable route for the security state of ' +
                      'another user; a service token is refused by /mfa/factors',
                  )
                }
                return deps.upstreams.identityFactors(subject.forwardableBearer, ctx.requestId)
              },
            }),
            loadTile<readonly PolicyFreeze[]>(tileDeps, {
              tile: 'restrictions',
              upstream: 'policy',
              key: `policy:freezes:${subject.userId}`,
              ...CACHE.policyFreezes,
              empty: [],
              load: () => deps.upstreams.policyFreezes(subject.userId, ctx.requestId),
            }),
            loadTile<readonly import('./upstreams.ts').BillingSubscription[]>(tileDeps, {
              tile: 'entitlements',
              upstream: 'billing',
              key: `billing:subscriptions:${subject.userId}`,
              ...CACHE.billingEntitlements,
              empty: [],
              load: () => deps.upstreams.billingSubscriptions(subject.userId, ctx.requestId),
            }),
          ])

          const actions: NextActions = buildNextActions({
            deposits,
            withdrawals,
            factors: security,
            freezes,
            subscriptions,
          })
          return { status: 200, body: actions }
        } finally {
          done()
        }
      },
    },
  ]
}

/* ------------------------------------------------------------------ auth */

interface Subject {
  readonly userId: string
  /** The caller's own token, but only when the caller *is* the subject. See `resolveSubject`. */
  readonly forwardableBearer: string | null
}

/**
 * Who this request is for, and whether their own token may be forwarded to identity.
 *
 * A user acts for themselves and their token is forwardable. An operator with the `admin` role may
 * name any user, and their token is *not* forwardable, because it authenticates the operator: sent
 * to `/auth/me` it would return the operator's account and the tile would present it as the
 * subject's. A service token is refused outright — see the file header for why a BFF must not
 * accept one.
 */
async function resolveSubject(ctx: RequestContext, deps: ServerDeps): Promise<Subject> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than being
  // a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')

  const principal = await deps.verifier.principal(token)
  if (principal.kind !== 'user') {
    throw new ForbiddenError('a user session (this surface does not accept a service token)')
  }

  const requested = ctx.url.searchParams.get('userId')
  if (requested === null || requested === principal.userId) {
    return { userId: principal.userId, forwardableBearer: token }
  }
  if (!isAdmin(principal)) throw new ForbiddenError('acting for another user')
  return { userId: requested, forwardableBearer: null }
}

/**
 * The bearer the desk routes forward, or a refusal.
 *
 * An operator may READ another user's conversions with `?userId=` — that is what the admin branch of
 * `resolveSubject` is for, and it is how support answers "where did my EMBER go". They may not MAKE
 * one. `forwardableBearer` is null exactly then, and rather than fall back to a service token this
 * refuses with a sentence.
 *
 * The alternative is worse than it looks. Converting with hub-api's own credential would book a
 * trade against somebody's balance with nothing in the ledger naming the person who decided to, and
 * the entry's actor would read as this service. If an operator ever needs to convert on a user's
 * behalf, it wants to be a route on wallet that says so and records who — `POST
 * /v1/admin/exchange-desk/funding` is the shape, and it takes an admin's own bearer.
 */
async function convertingBearer(ctx: RequestContext, deps: ServerDeps): Promise<string> {
  const subject = await resolveSubject(ctx, deps)
  if (subject.forwardableBearer === null) {
    throw new ForbiddenError("your own session (an operator cannot convert on a user's behalf)")
  }
  return subject.forwardableBearer
}

/* ------------------------------------------------------------------ plumbing */

function tileDepsOf(deps: ServerDeps, network: Network): TileDeps {
  // Built conditionally because `exactOptionalPropertyTypes` distinguishes an absent `now` from a
  // present `undefined`, and the difference decides whether the default clock is used.
  return deps.now
    ? { cache: deps.cache, metrics: deps.metrics, logger: deps.logger, network, now: deps.now }
    : { cache: deps.cache, metrics: deps.metrics, logger: deps.logger, network }
}

function dashboardDeps(deps: ServerDeps, network: Network): DashboardDeps {
  return {
    ...tileDepsOf(deps, network),
    upstreams: deps.upstreams,
    dashboardDeadlineMs: deps.dashboardDeadlineMs,
  }
}

class BadRequestError extends Error {
  /**
   * The code the client reads. `bad_request` unless a caller names one, and a caller names one when
   * an upstream already has a code for the same refusal: a browser that has to branch on
   * `idempotency_key_required` should not have to also handle `bad_request` because the request was
   * caught one hop earlier than usual.
   */
  readonly code: string
  constructor(message: string, code = 'bad_request') {
    super(message)
    this.name = 'BadRequestError'
    this.code = code
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * AN UPSTREAM'S REFUSAL, CARRIED THROUGH WITH ITS STATUS, ITS CODE AND ITS SENTENCE.
 *
 * Everything else in this service turns an upstream failure into a tile status, and `describeFault`
 * in `tiles.ts` states the rule those follow: the reason is built from the error's CLASS and never
 * from a response body, because "putting that in a field a browser renders is a stored-XSS primitive
 * with extra steps". This is the one place that rule is departed from, and the departure is narrow
 * enough to state exactly:
 *
 *   - It applies only to the desk routes, which are proxies of ONE named route on ONE named peer.
 *     A tile's fault could have come from any of eight upstreams, including one that answers HTML
 *     from a captive portal; this could not.
 *   - Only a status the peer DECIDED is forwarded (`FORWARDED_STATUSES`). A 500, a timeout, a
 *     transport error and an open breaker are not decisions about this request and are still the
 *     generic 500 above.
 *   - Only a body that parses as the estate's own error envelope is forwarded, the code must look
 *     like a code, and the message is bounded. Anything else falls back to the generic path — so an
 *     upstream that starts answering something unexpected degrades to "the request could not be
 *     completed" rather than to whatever it answered.
 *
 * What it buys is the whole point of micro-org#496: `desk_inventory_short` says "the desk is out of
 * EMBER right now — try a smaller amount, or try again shortly", and a person who reads that knows
 * what to do. Re-writing it here would be a second copy of wallet's words, free to drift from the
 * first, and the estate has that failure written down in three other places.
 *
 * The `requestId` in the reply is still THIS service's. The upstream's is in the log line.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
class UpstreamRefusalError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'UpstreamRefusalError'
    this.status = status
    this.code = code
  }
}

/**
 * The statuses that mean the peer read the request and said no.
 *
 * 503 is in the list and is the one that needs an argument, because a 5xx normally means "we do not
 * know". wallet's `rate_unavailable` is a 503 and it IS a decision about this request — pricing has
 * no usable quote for this pair, so the conversion is refused rather than guessed at a made-up rate.
 * A user who sees "try again shortly" acts correctly on it; a 500 would send them to support.
 * The envelope check below is what keeps a genuine unlabelled 503 out.
 *
 * 401 and 403 are deliberately ABSENT. This service verified the reader's token before forwarding
 * it, so wallet disagreeing means the two disagree about identity — a fault in the estate, not in
 * the request. Forwarding a 401 would make the browser refresh and then sign the reader out over it.
 */
const FORWARDED_STATUSES: ReadonlySet<number> = new Set([400, 404, 409, 422, 429, 503])

/** A code looks like a code. Anything else is not an envelope this service will echo. */
const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,63}$/

/** Long enough for wallet's longest refusal sentence, short enough not to be a payload. */
const MAX_REFUSAL_MESSAGE = 400

function refusalFrom(err: unknown): UpstreamRefusalError | null {
  if (!(err instanceof HttpError)) return null
  if (!FORWARDED_STATUSES.has(err.status)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(err.body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const envelope = (parsed as { error?: unknown }).error
  if (typeof envelope !== 'object' || envelope === null) return null
  const { code, message } = envelope as { code?: unknown; message?: unknown }
  if (typeof code !== 'string' || !REFUSAL_CODE.test(code)) return null
  if (typeof message !== 'string' || message.length === 0) return null
  if (message.length > MAX_REFUSAL_MESSAGE) return null
  return new UpstreamRefusalError(err.status, code, message)
}

/** Run an upstream call, turning a refusal it decided into one this service will forward. */
async function forwardingRefusals<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    throw refusalFrom(err) ?? err
  }
}

/* ------------------------------------------------------------------ request bodies */

/**
 * The first request body this service has ever read, and the cap is why this is a function.
 *
 * `node:http` streams a body of any size, and a route that concatenates chunks without a ceiling is
 * a memory exhaustion primitive available to anyone with a session. 8 KiB is far above the largest
 * legitimate body here — a conversion intent is three short strings — and far below anything worth
 * sending on purpose.
 */
const MAX_BODY_BYTES = 8 * 1024

async function readJsonBody(ctx: RequestContext): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of ctx.req) {
    const buffer = chunk as Buffer
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) {
      throw new BadRequestError(`the request body must be at most ${MAX_BODY_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  if (bytes === 0) throw new BadRequestError('a JSON body is required')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    // The parser's own message is not echoed: it quotes the input, which is how a body ends up in a
    // response and then in a log aggregator's search results.
    throw new BadRequestError('the request body must be JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError('the request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Asset codes are short. Anything longer is not a code and is not worth forwarding. */
const MAX_ASSET_CODE = 32

/**
 * The conversion intent, checked for SHAPE and forwarded for MEANING.
 *
 * The distinction is deliberate and it is the whole of this function's design. A missing field or a
 * number where a string belongs is this layer's business, because wallet would answer a 400 that
 * says nothing a browser could act on. What an amount MEANS — positive, non-zero, large enough to
 * convert to one unit of the target, an asset the desk deals in — is wallet's, and every one of
 * those has a code and a sentence there already. Re-deciding any of them here would be a second
 * opinion about money that ships on a different cadence than the first.
 *
 * `amount` is a STRING and stays one. These are smallest units of a 78-bit quantity, and a JSON
 * number would round the large ones silently — the estate's standing rule, and the reason wallet's
 * own views never carry a numeric amount either.
 */
async function readConversionIntent(ctx: RequestContext): Promise<ConversionIntent> {
  const body = await readJsonBody(ctx)
  return {
    fromAssetCode: requiredCode(body, 'fromAssetCode'),
    toAssetCode: requiredCode(body, 'toAssetCode'),
    amount: requiredAmount(body),
  }
}

function requiredCode(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${field} is required`)
  }
  if (value.length > MAX_ASSET_CODE) {
    throw new BadRequestError(`${field} must be at most ${MAX_ASSET_CODE} characters`)
  }
  return value.trim()
}

function requiredAmount(body: Record<string, unknown>): string {
  const value = body['amount']
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError('amount is required, in smallest units, as a string')
  }
  return value.trim()
}

function readLimit(ctx: RequestContext, fallback: number): number {
  const raw = ctx.url.searchParams.get('limit')
  if (raw === null) return fallback
  const value = Number(raw)
  // Bounded above because the limit is forwarded to an upstream: an unbounded one here is an
  // unbounded query there, reachable by anyone with a session.
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new BadRequestError('limit must be a whole number between 1 and 100')
  }
  return value
}

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line, the trace and
 * the Lantern issue.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // Every answer here is a point-in-time composition of somebody else's state, and each tile
    // already carries its own age. A shared cache holding it would add a second, invisible,
    // unlabelled staleness on top — the exact thing `cached`/`ageMs` exist to make impossible.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Re-exported so `index.ts` and the tests import one name for the tile contract. */
export type { Tile, ActivityRecord }

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WAVE M5d: WHAT THIS MODULE MOUNTS INSIDE THE MERGED PROCESS
 *
 * micro-deploy `docs/service-merge-plan.md`. Everything above this line is the STANDALONE
 * listener, unchanged — `server.test.ts` drives it and that suite passing unchanged is the
 * evidence that the merge did not alter this module's own surface. Everything below is how the
 * same route table is mounted beside the other modules of the platform monolith.
 *
 * hub is the FIRST module of this process that holds no database. It declares no `DATABASE_URL`,
 * takes no pool, runs no migration and asserts no schema version; `RouteSpec.sql` is therefore
 * OMITTED on every spec below rather than stamped, which is the opposite of what every other
 * module does and is correct for exactly one reason: an unstamped spec resolves to the kernel's
 * own handle, and no handler here can reach it. `RequestContext` in this file has no `sql` field
 * at all (see its declaration), so "hub read agora's tables by accident" is not a bug this module
 * can have — it is a shape the type system refuses.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The paths this module must NOT serve in the merged process.
 *
 * `/livez`, `/readyz` and `/metrics` exist on every module. Matching is FIRST-WINS, so a second
 * copy of each would be unreachable — a dead health endpoint that looks exactly like a live one.
 * agora's win, because it is the host and because Prometheus scrapes this target under agora's job.
 * `/readyz` still reports this module: its upstream probes and its service-token probe are
 * contributed to the host's one `Lifecycle`, which is what makes one endpoint honest for every
 * module's dependencies.
 */
export const UNMOUNTED: ReadonlySet<string> = new Set(OPERATIONAL_ROUTES)

/** The prefix every one of this module's public paths carries inside the merged process. */
export const MOUNT_PREFIX = '/v1/hub'

/**
 * `/v1/<x>` -> `/v1/hub/<x>`, for every route this module mounts.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THE WHOLE SURFACE MOVES, RATHER THAN THE SEVEN PATHS THAT ACTUALLY COLLIDE.**
 *
 * Seven do. `GET /v1/search` is agora's own — the post/voice search behind the public square.
 * `/v1/conversions` (GET and POST), `/v1/conversions/quote`, `/v1/conversions/:id`,
 * `/v1/portfolio` and `/v1/transfers` are all WALLET's, and wallet is a module of this process
 * from this wave too. Route matching is first-wins across one flat table, so on each of those
 * seven a shadowed route is a DEAD route that looks alive: every standalone suite still passes,
 * nothing logs, and the caller gets a plausible answer computed by the wrong module. That is the
 * one hazard of this merge that is purely structural, and it is why the collision matrix was
 * computed mechanically rather than reasoned about.
 *
 * Remounting only those seven would leave four of this module's paths bare and the module split
 * across two address spaces — `/v1/dashboard` here, `/v1/hub/portfolio` there — which is a rule
 * nobody can hold and the next route added lands on the wrong side of it by default. Moving the
 * whole surface makes the rule mechanical: everything hub serves is under `/v1/hub`, derived from
 * the route table below rather than hand-listed, so a route ADDED to `buildRoutes()` is remounted
 * without anyone remembering to.
 *
 * **THIS IS ONLY HALF A FIX WITHOUT THE GATEWAY.** hub-web asks these paths RELATIVE to the page
 * it was served from, so the bytes on the wire still say `/v1/dashboard`; the router that carries
 * them (`cf-api-hub`, `deploy/gateway/dynamic/estate-web.yml`) must rewrite `^/v1/(.*)` to
 * `/v1/hub/$1` in the same release. Wave M5b remounted tessera's `/v1/listings` and did NOT do
 * this, and the measured consequence was market answering tessera's listings — 200 with an empty
 * array, unauthenticated, on every signed-in user's page. A remount and its rewrite ship together
 * or neither ships.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const REMOUNTED_PATHS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    buildRoutes()
      .filter((route) => !UNMOUNTED.has(route.path))
      .map((route) => [route.path, remountedPath(route.path)] as const),
  ),
)

/**
 * The one place the prefix is applied.
 *
 * A path that is neither operational nor `/v1/`-prefixed would pass through unchanged, and that is
 * deliberate rather than an oversight: it would be a path this module invented outside the public
 * versioned surface, and silently prefixing it would hide the fact that it exists. There is no
 * such path today; `mountedpaths.test.ts` fails if one appears.
 */
function remountedPath(path: string): string {
  return path.startsWith('/v1/') ? `${MOUNT_PREFIX}${path.slice('/v1'.length)}` : path
}

/**
 * This module's routes, ready to mount beside agora's.
 *
 * Two things happen here and nowhere else, which is what makes them impossible to forget per
 * handler:
 *
 *   1. **The handler closes over THIS module's deps, rebuilt for THIS request.** `RouteSpec.handle`
 *      takes only `ctx`, so there is no parameter through which the host's verifier, cache or
 *      clients could arrive. `forRequest(deps, ctx.network)` narrows the peers to the estate the
 *      gateway stamped — hub holds no database, so that line plus the cache key IS its whole
 *      isolation, and getting it wrong asks the right services the wrong estate's question and
 *      renders the answer as a dashboard with nothing to say so.
 *   2. **Every path is remounted under `/v1/hub`.** See `REMOUNTED_PATHS`.
 *
 * `sql` is deliberately absent from every spec — see the wave header above.
 *
 * **`RouteSpec<unknown>`, and the `unknown` is the point.** `RouteSpec`'s type parameter reaches
 * exactly one place — `handle: (ctx: RequestContext<TSql>) => …` — so it is CONTRAVARIANT: a spec
 * whose handler accepts a context carrying ANY handle is assignable wherever a spec carrying a
 * particular one is wanted. `unknown` is therefore the widest possible statement and the truest:
 * these handlers do not look at `ctx.sql`, cannot look at it (there is no such field on this
 * file's `RequestContext`), and are indifferent to which module's database the kernel resolved.
 * Writing the host's own `Db` here instead would compile and would say the opposite — that hub's
 * routes expect agora's handle.
 */
export function mountableRoutes(deps: ServerDeps): readonly RouteSpec<unknown>[] {
  return buildRoutes()
    .filter((route) => !UNMOUNTED.has(route.path))
    .map((route) => ({
      method: route.method,
      path: remountedPath(route.path),
      // `async` rather than a bare call, so a handler that throws SYNCHRONOUSLY is a rejected
      // promise the kernel's dispatch already catches rather than an exception escaping into it.
      //
      // The context is REBUILT field by field rather than spread. The kernel's own
      // `RequestContext` carries a `sql` handle; spreading it would hand every handler in this
      // file a live connection to agora's database at runtime, and the only thing standing
      // between that and a query would be a type this file could stop importing. Listing the six
      // fields hub's own `RequestContext` declares keeps the no-database property TRUE, not
      // merely unstated.
      handle: async (ctx: KernelContext<unknown>): Promise<Reply> =>
        await handle(
          route,
          {
            req: ctx.req,
            url: ctx.url,
            requestId: ctx.requestId,
            log: ctx.log,
            params: ctx.params,
            network: ctx.network,
          },
          forRequest(deps, ctx.network),
        ),
    }))
}
