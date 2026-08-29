/**
 * The HTTP surface.
 *
 * Plain `node:http`, following the service template. The parts that matter — request ids, RED
 * metrics, the child logger, the error shape, the auth-fault mapping — are framework-independent.
 *
 * Three decisions here are load-bearing:
 *
 *   1. **The rate board is public.** It is public in the estate today (`GET /coins/rates`) and it
 *      is public market data; putting a token in front of it would break the sign-in page that
 *      shows what a deposit is worth without making anything safer. `/history` and the admin
 *      route are not public, because those are operator surfaces.
 *   2. **Every decimal value is a string.** A JSON number is an IEEE 754 double, and the whole
 *      point of this service is that a rate never passes through one. The scaled integers are
 *      strings too, so a consumer does BigInt arithmetic on exactly the value we computed.
 *   3. **A bad token is 401; a verifier that could not reach the JWKS is 503.** Answering 401
 *      there would sign every user in the estate out because identity is having a bad minute.
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
  hasScope,
  isAdmin,
  statusFor,
  type Principal,
} from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { NetworkUnknownError, requestNetwork, type Network } from '@cloudsforge/http'
import type { NetworkSql } from '@cloudsforge/db'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import type { AssetCode } from '@cloudsforge/contracts-chain'
import {
  QUOTED_ASSETS,
  formatScaled,
  isAdministeredAsset,
  isQuotedAsset,
  parseAdministeredScaled,
} from './rates.ts'
import {
  rateView,
  readAdministered,
  readHistory,
  readQuote,
  readQuotes,
  setAdministeredPrice,
  type RateOptions,
  type RateView,
} from './quotes.ts'
import type { Db } from './outbox.ts'
import type { RequestContext as KernelContext, RouteSpec } from '../kernel.ts'

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
   * The per-network SELECTOR, not a handle. Routes use `ctx.sql`; `NetworkSql` has no query
   * methods, so reaching for the process-wide handle does not compile.
   */
  readonly sql: NetworkSql
  /**
   * The network to assume when no `CF-Network` arrives, or `undefined` to refuse. `CF_NETWORK_SINGLE`,
   * for `pnpm dev`, which has no gateway in front of it. Never set in production.
   */
  readonly singleNetwork?: Network
  readonly rateOptions: RateOptions
  /** Refresh sampled gauges immediately before `/metrics` renders. */
  readonly beforeScrape?: () => Promise<void>
}

/**
 * The two scopes. Separate rather than one `pricing:write`, because reading operational history
 * and deciding what an asset with no market is worth are different authorities: a reporting job
 * needs the first and must never have the second.
 */
export const READ_SCOPE = 'pricing:read'
export const ADMIN_SCOPE = 'pricing:admin'

const DEFAULT_HISTORY_LIMIT = 100
const MAX_HISTORY_LIMIT = 1_000

/**
 * Domain metrics, declared rather than inferred from a log line — AD-20.
 *
 * `pricing_round_total` carries `asset` alongside the `outcome` the specification names. An
 * outcome without the asset cannot answer the only question worth asking of it — *which* asset
 * stopped being quotable — and a four-value label is not a cardinality risk.
 */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'pricing_round_total',
      help: 'Refresh rounds, by asset and outcome (accepted, too_few_sources, rejected_divergence)',
      kind: 'counter',
      labels: ['asset', 'outcome'],
    })
    .register({
      name: 'pricing_sources_ok',
      help: 'Sources that produced a usable quote in the last round, per asset',
      kind: 'gauge',
      labels: ['asset'],
    })
    .register({
      name: 'pricing_rate_age_seconds',
      help: 'Age of the stored quote per asset and estate. Past PRICING_MAX_AGE_SECONDS the rate is unusable.',
      kind: 'gauge',
      // `network`, added by wave M5a. This deployment holds a pool per estate, and sampled without
      // the label the second plane's `set` REPLACES the first's for the same `asset` — so a stale
      // mainnet quote reads as testnet's fresh one and the alert that exists to fire before every
      // conversion stops does not fire at all. An undeclared label is filtered by the registry and
      // reported as a dropped write, so the spec had to be widened rather than the label passed.
      labels: ['asset', 'network'],
    })
    .register({
      name: 'pricing_divergence_bps',
      help: 'Spread between the highest and lowest source in the last round, per asset',
      kind: 'gauge',
      labels: ['asset'],
    })
    .register({
      name: 'pricing_administered_updates_total',
      help: 'Administered price changes, by asset. Every one of them is an act somebody took.',
      kind: 'counter',
      labels: ['asset'],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 16 * 1024

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
  /**
   * The network THIS REQUEST belongs to, from the `CF-Network` header the gateway stamped.
   *
   * Not a property of the process: one pod serves both estates since the network consolidation
   * (micro-deploy `docs/network-consolidation.md`), so "which network am I" has no answer.
   */
  readonly network: Network
  /**
   * The database handle for `network`, resolved ONCE, at the edge of the request.
   *
   * Every route uses this rather than reaching for the process-wide handle, because a wrong handle
   * is not an error — it is a query that SUCCEEDS against the other estate's rows and says nothing.
   * `deps.sql` is a `NetworkSql` with no query methods, so the mistake does not compile.
   */
  readonly sql: Db
}

/**
 * Routes that answer without belonging to a network.
 *
 * Kubelet probes the first two and Prometheus scrapes the third; none arrives through the gateway,
 * so none carries `CF-Network`. Refusing them makes every health probe a 500 and the pod never
 * becomes ready. Three literal paths rather than a prefix, because this is an exemption from a data
 * boundary; none of them queries the database.
 */
const OPERATIONAL_ROUTES: ReadonlySet<string> = new Set(['/livez', '/readyz', '/metrics'])

interface Route {
  readonly method: string
  /** `/rates/:asset`. Used verbatim as the metric label, so cardinality is bounded. */
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

/**
 * Compile `/rates/:asset` into a matcher. The segment pattern excludes `/` so a parameter cannot
 * swallow the rest of the path and make one route answer for another.
 */
function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `(?<${segment.slice(1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${source}$`)
}

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

    let matched: Route | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url.pathname)
      if (match) {
        matched = route
        params = { ...match.groups }
        break
      }
    }

    // Unmatched paths collapse to one label. Using the raw path would let any caller mint unbounded
    // time series and take the scrape target down with cardinality.
    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number, metricNetwork: string) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method,
        route: routeLabel,
        status: String(status),
        // One target now serves both estates, so the network has to be on the SERIES. Labelled
        // per target it would say nothing — micro-org#398 in a form nothing could recover.
        network: metricNetwork,
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method,
        route: routeLabel,
        network: metricNetwork,
      })
    }

    // ── THE NETWORK, THEN THE HANDLE, BEFORE ANY ROUTE RUNS ──────────────────────────────────
    //
    // `requestNetwork` REFUSES an unstamped request rather than assuming mainnet: a 500 is a
    // routing fault made loud, where a default is a cross-network write nothing would ever flag.
    //
    // The operational endpoints are exempt because kubelet and Prometheus do not come through the
    // gateway and never send the header. Refusing them makes the pod never become ready.
    const networkless = matched !== undefined && OPERATIONAL_ROUTES.has(matched.path)
    let network: Network
    try {
      network = networkless
        ? (deps.singleNetwork ?? deps.sql.networks[0] ?? 'mainnet')
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

    // ── RESOLVED INSIDE A TRY, AND THAT IS NOT DEFENSIVE PADDING ───────────────────────────────
    //
    // `deps.sql.for()` THROWS when this deployment holds no handle for that network, and that
    // refusal is the safety property the consolidation rests on — better a loud 500 than a query
    // answered out of the other estate's rows.
    //
    // It runs BEFORE `handle` returns a promise, so an uncaught throw escapes the `void` expression
    // past a `.catch` that is not attached yet, and the listener returns having sent NOTHING. The
    // connection then hangs until the client gives up: the one path the design most depends on
    // being loud was the one path that was silent.
    let sql: Db
    try {
      sql = deps.sql.for(network) as unknown as Db
    } catch (err) {
      log.error('no usable database handle for this request', { err, network })
      send(
        res,
        errorReply(500, 'network_unavailable', 'this deployment cannot serve that network', requestId),
        requestId,
      )
      finish(500, network)
      return
    }
    void handle(matched, { req, url, requestId, log, params, network, sql }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status, network)
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500, network)
      })
  })
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
    if (err instanceof BadRequestError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    if (err instanceof NotFoundError) {
      return errorReply(404, 'not_found', err.message, ctx.requestId)
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handler })

  return [
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      // 503 is what removes this replica from the balancer. A soft probe failure leaves the report
      // `degraded` but still ready, because taking a whole product out of rotation over a
      // non-essential upstream is worse than serving without it.
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
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
    }),

    /**
     * The rate board: every asset, usable or not, with the reason when it is not.
     *
     * An unusable asset is listed rather than omitted. Omitting it makes a client that iterates
     * the board silently forget the asset exists, which is how a deposit page loses a coin.
     */
    define('GET', '/rates', async (ctx, deps) => {
      const records = await readQuotes(ctx.sql)
      const byAsset = new Map(records.map((record) => [record.asset, record]))
      const rates = QUOTED_ASSETS.map((asset) =>
        rateView(asset, byAsset.get(asset) ?? null, deps.rateOptions),
      )
      return { status: 200, body: { rates, spreadBps: deps.rateOptions.conversionSpreadBps } }
    }),

    define('GET', '/rates/:asset', async (ctx, deps) => {
      const asset = requireAsset(ctx)
      const record = await readQuote(ctx.sql, asset)
      const rate = rateView(asset, record, deps.rateOptions)
      // 200 even when the rate is unusable. The caller asked what this asset's rate is and this is
      // the answer, complete with the reason; a 404 would be a lie about the asset existing and a
      // 503 would suggest retrying will help when a stale quote needs a refresh, not a retry.
      return { status: 200, body: { rate } }
    }),

    /**
     * Set an administered price.
     *
     * Administered prices exist for assets with no market — EMBER only, because Hearth has no
     * exchange listing. An administered value may never override an asset that does have one:
     * that would turn a fail-closed oracle into a fail-to-whatever-was-typed oracle.
     */
    define('PUT', '/admin/prices/:asset', async (ctx, deps) => {
      const principal = await requireAdminAuthority(ctx, deps)
      const asset = requireAsset(ctx)
      if (!isAdministeredAsset(asset)) {
        throw new BadRequestError(
          `${asset} is priced by the market; an administered price may not override a quoted asset`,
        )
      }

      const body = await readJson(ctx.req)
      const usd = body['usd']
      if (typeof usd !== 'string') {
        // Deliberately refuses a JSON number. `{"usd": 0.1}` is already not 0.1 by the time this
        // code sees it, and accepting it would put a float on the one path this service exists to
        // keep floats off.
        throw new BadRequestError('usd must be a decimal string, for example "0.25"')
      }
      const usdScaled = parseAdministeredScaled(usd)
      if (usdScaled === null) {
        throw new BadRequestError(
          `usd must be a positive decimal with at most 6 decimal places (got ${usd})`,
        )
      }

      const done = deps.lifecycle.track()
      try {
        const price = await setAdministeredPrice(ctx.sql, {
          asset,
          usdScaled,
          setBy: actorOf(principal),
          setByHandle: handleOf(principal),
        })
        deps.metrics.increment('pricing_administered_updates_total', { asset })
        // Logged at info with the actor, because "who decided this" is the question asked of an
        // administered price months later, when a conversion is disputed.
        ctx.log.info('administered price set', {
          asset,
          usdScaled: price.usdScaled.toString(),
          setBy: price.setBy,
        })
        const rate = rateView(asset, await readQuote(ctx.sql, asset), deps.rateOptions)
        return {
          status: 200,
          body: {
            price: {
              asset: price.asset,
              usdScaled: price.usdScaled.toString(),
              setBy: price.setBy,
              setByHandle: price.setByHandle,
              updatedAt: price.updatedAt,
            },
            rate,
          },
        }
      } finally {
        done()
      }
    }),

    define('GET', '/admin/prices', async (ctx, deps) => {
      await requireAdminAuthority(ctx, deps)
      const prices = await readAdministered(ctx.sql)
      return {
        status: 200,
        body: {
          prices: prices.map((price) => ({
            asset: price.asset,
            usdScaled: price.usdScaled.toString(),
            setBy: price.setBy,
            setByHandle: price.setByHandle,
            updatedAt: price.updatedAt,
          })),
        },
      }
    }),

    /**
     * What this asset has been quoted at, most recent first.
     *
     * Not public: it carries `setBy` for administered changes, which names an operator, and it is
     * the record an operator reads when a conversion is questioned. A service token with
     * `pricing:read` or an admin user reaches it.
     */
    define('GET', '/history/:asset', async (ctx, deps) => {
      await requireReadAuthority(ctx, deps)
      const asset = requireAsset(ctx)
      const limit = parseLimit(ctx.url.searchParams.get('limit'))
      const entries = await readHistory(ctx.sql, asset, limit)
      return {
        status: 200,
        body: {
          asset,
          history: entries.map((entry) => ({
            asset: entry.asset,
            usdScaled: entry.usdScaled.toString(),
            usd: formatScaled(entry.usdScaled),
            source: entry.source,
            sourceCount: entry.sourceCount,
            divergenceBps: entry.divergenceBps?.toString() ?? null,
            setBy: entry.setBy,
            observedAt: entry.observedAt,
          })),
        },
      }
    }),
  ]
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_HISTORY_LIMIT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_HISTORY_LIMIT) {
    throw new BadRequestError(`limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`)
  }
  return value
}

function requireAsset(ctx: RequestContext): AssetCode {
  // Upper-cased so `/rates/btc` works. Asset codes are a closed set from contracts-chain, so this
  // cannot become a lookup on caller-controlled text.
  const raw = (ctx.params['asset'] ?? '').toUpperCase()
  if (!isQuotedAsset(raw)) {
    throw new NotFoundError(`${raw || 'that asset'} is not quoted by this service`)
  }
  return raw
}

/* ------------------------------------------------------------------------ auth */

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than being
  // a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

/**
 * Two authorities, one rule, both recorded.
 *
 * An operator with the admin role sets a price from the console; a service with `pricing:admin`
 * sets one from a runbook or a migration. Either way the principal is named on the row, which is
 * the whole point of `set_by`.
 */
async function requireAdminAuthority(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const principal = await authenticate(ctx, deps)
  if (isAdmin(principal)) return principal
  if (hasScope(principal, ADMIN_SCOPE)) return principal
  throw new ForbiddenError(`${ADMIN_SCOPE} or role:admin`)
}

async function requireReadAuthority(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const principal = await authenticate(ctx, deps)
  if (isAdmin(principal)) return principal
  if (hasScope(principal, READ_SCOPE)) return principal
  throw new ForbiddenError(`${READ_SCOPE} or role:admin`)
}

function actorOf(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.userId}` : `service:${principal.service}`
}

function handleOf(principal: Principal): string {
  return principal.kind === 'user' ? principal.handle : principal.service
}

/* ------------------------------------------------------------------------ body parsing */

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive that
    // any caller can reach.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('request body is not valid JSON')
  }
}

/* ------------------------------------------------------------------------ replies */

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
    // A rate is a point-in-time fact with a maximum age. A cached 200 from thirty seconds ago
    // would defeat the staleness rule at the one layer the service cannot see.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export type { RateView }


/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WAVE M5a: WHAT THIS MODULE MOUNTS INSIDE THE MERGED PROCESS
 *
 * micro-deploy `docs/service-merge-plan.md`. Everything above this line is the STANDALONE
 * listener, unchanged — `server.test.ts` drives it and that suite passing unchanged is the
 * evidence that the merge did not alter this module's own surface. Everything below is how the
 * same route table is mounted beside four others.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The paths this module must NOT serve in the merged process.
 *
 * `/livez`, `/readyz` and `/metrics` exist on all five modules. Matching is FIRST-WINS, so a
 * second copy of each would be unreachable — a dead health endpoint that looks exactly like a live
 * one. agora's win, because it is the host and because Prometheus scrapes this target under
 * agora's job. `/readyz` still reports this module: it contributes probes to the host's one
 * `Lifecycle`, which is what makes one endpoint honest for five databases.
 */
export const UNMOUNTED: ReadonlySet<string> = new Set(OPERATIONAL_ROUTES)

/**
 * This module's routes, ready to mount beside agora's.
 *
 * Two things happen here and nowhere else, which is what makes them impossible to forget per
 * handler:
 *
 *   1. **Every spec is stamped with THIS module's selector.** The kernel resolves one handle per
 *      request from one selector, and the host's is agora's. Unstamped, every read below would run
 *      against agora's database — where `inbox` and `jobs` exist with the same columns, so the
 *      write SUCCEEDS and reports nothing. Stamped once, over the whole table, so no handler had
 *      to change.
 *   2. **The handler closes over THIS module's deps.** `RouteSpec.handle` takes only `ctx`, so
 *      there is no parameter through which the host's queue, verifier or stores could arrive.
 */
export function mountableRoutes(deps: ServerDeps, sql: NetworkSql): readonly RouteSpec<Db>[] {
  return buildRoutes()
    .filter((route) => !UNMOUNTED.has(route.path))
    .map((route) => ({
      method: route.method,
      path: route.path,
      sql,
      // `async` rather than a bare call, so a handler that throws SYNCHRONOUSLY is a rejected
      // promise the kernel's dispatch already catches rather than an exception escaping into it.
      handle: async (ctx: KernelContext<Db>): Promise<Reply> => await handle(route, ctx, deps),
    }))
}
