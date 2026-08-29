/**
 * The HTTP surface.
 *
 * Plain `node:http`, as the template is, and for the reason the template gives: the parts that
 * matter here — request ids, RED metrics, the child logger, the error shape, the auth-fault
 * mapping — are framework-independent.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`POST /v1/brand-kits/:id/generate` ANSWERS 202. IT REACHES NO MODEL.**
 *
 * The handler resolves the kit, builds the spec and the prompt, reserves the credit, writes one
 * row and enqueues. A FLUX call takes 20 to 40 seconds, which is longer than a rolling deploy
 * waits and longer than several proxies will hold a connection; doing it inside the request would
 * mean the money leaves and the record of what it bought does not arrive. `mint` records the same
 * decision for the same reason, in stronger terms, at the top of its own server.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The one decision that is easy to get backwards is the auth-fault mapping. A bad token is 401. A
 * verifier that could not reach the JWKS is **503**, never 401 — answering 401 there signs every
 * user in the estate out because identity is having a bad minute.
 *
 * The second is `402`. An account over its credit cap is not a 500 and not a 403: the cap decided,
 * the answer is correct, and the client's remedy is to raise the cap or wait. A 403 would send a
 * user to check their permissions and a 500 would send an engineer to check the logs.
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
  requireScope,
  statusFor,
  subjectUserId,
  type Principal,
} from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { ACCENT_PATTERN, BrandKitConflictError, type BrandKit, type BrandKitStore } from './brandkits.ts'
import { NetworkUnknownError, requestNetwork, type Network } from '@cloudsforge/http'
import type { NetworkSql } from '@cloudsforge/db'
import { CreditCapError, usd } from './credits.ts'
import { SpecError, specFor } from './specs.ts'
import { isBackendChoice, type BackendChoice } from './backend.ts'
import { provenanceOf, type GenerationJob, type RequestGenerationInput } from './generation.ts'
import { MAX_UPLOAD_BYTES, UploadRejected } from './imagebytes.ts'
import {
  UploadQuotaError,
  type SetVisibilityInput,
  type UploadInput,
  type UploadOutcome,
} from './uploads.ts'
import type { Preflight } from './preflight.ts'
import type { Asset } from './assets.ts'
import type { Db } from './outbox.ts'
import type { RequestContext as KernelContext, RouteSpec } from '../kernel.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

/** Reads this service performs. Injected as functions so a route can be tested without a pool. */
export interface ReadModel {
  findJob(id: string): Promise<GenerationJob | null>
  findAsset(id: string): Promise<Asset | null>
  /** Stored bytes by content address. `null` when this replica does not have them. */
  readBlob(checksum: string, format: string): Promise<Buffer | null>
  listAssetsForKit(brandKitId: string, limit: number): Promise<readonly Asset[]>
}

/** Accepting an upload, as this file needs it. A port, for the same reason `GenerationRequester` is. */
export interface UploadReceiver {
  store(input: UploadInput): Promise<UploadOutcome>
  setVisibility(input: SetVisibilityInput): Promise<Asset | null>
}

/**
 * Accepting a generation, as this file needs it.
 *
 * A port rather than the pipeline's own `RequestDeps`, for the same reason the widget store in the
 * template is an interface: **a route may not reach the pool.** It also means the 402 mapping can
 * be tested by injecting a refusal, rather than by arranging a real over-cap account and hoping
 * the mapping is reached.
 */
export interface GenerationRequester {
  request(input: RequestGenerationInput): Promise<GenerationJob>
}

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  /**
   * The store for THIS REQUEST's network, rebuilt per request by `forRequest`.
   *
   * The boot-time value is a placeholder. studio never held a bare `sql`: its handle lives inside
   * `postgresBrandKitStore(sql, …)`, so the thing that has to become per-network is the STORE, not
   * a pool reference. Same shape as policy's snapshot reader.
   */
  readonly kits: BrandKitStore
  /**
   * The per-network selector, and the factory that turns one into a store. A service whose data
   * access is behind a store still has to choose the network before it builds one.
   */
  readonly sql: NetworkSql
  readonly kitsFor: (sql: unknown) => BrandKitStore
  /** `CF_NETWORK_SINGLE`, for `pnpm dev`, which has no gateway to stamp the header. */
  readonly singleNetwork?: Network
  readonly reads: ReadModel
  readonly generation: GenerationRequester
  readonly uploads: UploadReceiver
  readonly preflight: Preflight
  readonly beforeScrape?: () => Promise<void>
}

export const READ_SCOPE = 'studio:read'
export const WRITE_SCOPE = 'studio:write'

/**
 * Domain metrics, declared rather than inferred from a log line.
 *
 * The alternative — grepping logs for a message — makes a metric that breaks when someone rewords
 * the message, and it cannot be a Prometheus counter with labels. AD-20.
 */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'studio_brand_kits_created_total',
      help: 'Brand kits created',
      kind: 'counter',
      labels: ['actor_kind'],
    })
    .register({
      name: 'studio_generations_requested_total',
      help: 'Generation jobs accepted',
      kind: 'counter',
      labels: ['kind', 'backend_choice'],
    })
    .register({
      name: 'studio_generations_refused_total',
      help: 'Generation requests refused before any image call',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      /**
       * A generation the caller did not ask to be a placeholder that WAS one.
       *
       * The counter that would have caught the placeholder era: 40 assets, empty model column,
       * every test green. See the warning in `generation.ts`'s `runGeneration`.
       */
      name: 'studio_generations_fell_back_total',
      help: 'Generations served by a backend the caller did not request',
      kind: 'counter',
      labels: ['requested', 'served'],
    })
    .register({
      name: 'studio_uploads_accepted_total',
      help: 'User image uploads stored',
      kind: 'counter',
      labels: ['format', 'deduplicated'],
    })
    .register({
      /**
       * Refusals, by reason. Labelled rather than logged, because the shape of what is being
       * refused is the signal: a sudden run of `svg_refused` from one account is somebody probing
       * for stored XSS, and that is a question a counter can answer and a log line cannot.
       */
      name: 'studio_uploads_refused_total',
      help: 'User image uploads refused, by reason',
      kind: 'counter',
      labels: ['reason'],
    })
}

/**
 * An inbound request id is trusted only if it is safe to put in a log line and echo in a header.
 * Anything else is replaced rather than rejected — the caller does not need a 400 over this, and
 * an unvalidated value here is a header-injection and a log-forgery primitive at once.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

const MAX_BODY_BYTES = 64 * 1024
const MAX_STYLE_PROMPT = 2_000
const MAX_PALETTE = 12

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  /** Raw bytes, for serving a stored image. Wins over `text` and `body`. */
  readonly bytes?: Buffer
  readonly contentType?: string
  readonly headers?: Record<string, string>
}

/**
 * Routes that answer without belonging to a network — kubelet probes the first two and Prometheus
 * scrapes the third, and none comes through the gateway, so none carries `CF-Network`.
 */
const OPERATIONAL_ROUTES: ReadonlySet<string> = new Set(['/livez', '/readyz', '/metrics'])

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Record<string, string>
  /** The network this REQUEST belongs to, from the header the gateway stamped. */
  readonly network: Network
}

interface Route {
  readonly method: string
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

/**
 * Compile `/v1/brand-kits/:id/generate` into a matcher. The segment pattern excludes `/` so a
 * parameter cannot swallow the rest of the path and make one route answer for another.
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

    // Unmatched paths collapse to one label. Using the raw path would let any caller mint
    // unbounded time series and take the scrape target down with cardinality.
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
        network: metricNetwork,
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method,
        route: routeLabel,
        network: metricNetwork,
      })
    }

    // The network first, then the STORE for it. `requestNetwork` refuses an unstamped request
    // rather than assuming mainnet; the operational endpoints are exempt because kubelet and
    // Prometheus never come through the gateway.
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
      send(res, errorReply(500, 'network_unknown', 'this request could not be attributed to a network', requestId), requestId)
      finish(500, 'unknown')
      return
    }

    // studio holds no per-network database handle, so there is no `deps.sql.for()` here to
    // refuse. `forRequest` can still throw — and an uncaught throw on this line is not a 500,
    // it is an unhandled exception in a request listener, which exits the process. The try is
    // what makes the failure answerable instead of fatal.
    let scoped: ReturnType<typeof forRequest>
    try {
      scoped = forRequest(deps, network)
    } catch (err) {
      log.error('no usable dependencies for this request', { err, network })
      send(
        res,
        errorReply(500, 'network_unavailable', 'this deployment cannot serve that network', requestId),
        requestId,
      )
      finish(500, network)
      return
    }

    void handle(matched, { req, url, requestId, log, params, network }, scoped)
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
 * Map every failure onto a status, grouped by what the caller should do about it.
 *
 *   * **400** — the request could not be a legal generation. Fix it; retrying will not help.
 *   * **402** — the account is over its credit cap. The cap decided, and this is an answer, not
 *     an error. **No image call was made.**
 *   * **403** — a scope or a role.
 *   * **404** — something named does not exist, or belongs to somebody else. The two are the same
 *     answer on purpose: a distinct 403 for "exists but is not yours" is an enumeration oracle.
 *   * **409** — well formed, but a kit of that name already exists for this owner.
 *   * **503** — the token verifier could not be reached.
 */
/**
 * The deps a REQUEST sees: the store rebuilt against this request's network.
 *
 * studio keeps its handle inside the store, so the store is the thing to rebuild — `kitsFor` is the
 * same factory `index.ts` uses at boot, called again with the right handle. Cheap: the store is a
 * closure over a pool, not a connection.
 */
function forRequest(deps: ServerDeps, network: Network): ServerDeps {
  return { ...deps, kits: deps.kitsFor(deps.sql.for(network)) }
}

async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
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
    if (err instanceof CreditCapError) {
      deps.metrics.increment('studio_generations_refused_total', { reason: 'credit_cap' })
      ctx.log.info('generation refused by the credit cap before any image call', {
        remaining: usd(err.remainingUsdMicros),
      })
      return {
        status: 402,
        body: {
          error: {
            code: 'credit_cap_exceeded',
            message: err.message,
            requestId: ctx.requestId,
            capUsd: usd(err.capUsdMicros),
            remainingUsd: usd(err.remainingUsdMicros),
            requestedUsd: usd(err.requestedUsdMicros),
            // Stated in the response because it is the fact a caller most needs and cannot
            // otherwise know: being refused did not cost them anything.
            imageCallMade: false,
          },
        },
      }
    }
    /**
     * A refused upload is **400 with the reason named**, and the reason is deliberately specific.
     *
     * Vagueness here would be security theatre rather than security: the uploader already knows
     * what they sent, so "SVG is refused because it is a script document" tells an attacker nothing
     * they did not know and tells the ninety-nine honest users what to do instead. The counter is
     * incremented on the same label, so the refusal is visible in a dashboard rather than only in
     * somebody's browser.
     */
    if (err instanceof UploadRejected) {
      deps.metrics.increment('studio_uploads_refused_total', { reason: err.reason })
      ctx.log.info('upload refused', { reason: err.reason })
      return {
        status: 400,
        body: {
          error: {
            code: `upload_${err.reason}`,
            message: err.message,
            requestId: ctx.requestId,
            reason: err.reason,
          },
        },
      }
    }
    if (err instanceof UploadQuotaError) {
      deps.metrics.increment('studio_uploads_refused_total', { reason: 'quota' })
      ctx.log.info('upload refused by the daily quota', { used: err.used, limit: err.limit })
      return {
        status: 429,
        // Hours, because the window is a rolling day and a second-precision retry-after would be
        // a number this handler cannot honestly compute without reading the oldest row.
        headers: { 'retry-after': String(err.windowHours * 3600) },
        body: {
          error: {
            code: 'upload_quota_exceeded',
            message: err.message,
            requestId: ctx.requestId,
            limit: err.limit,
            used: err.used,
          },
        },
      }
    }
    if (err instanceof BrandKitConflictError) {
      return errorReply(409, 'brand_kit_exists', err.message, ctx.requestId)
    }
    if (err instanceof NotFoundError) {
      return errorReply(404, 'not_found', err.message, ctx.requestId)
    }
    if (err instanceof SpecError || err instanceof BadRequestError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
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
    /**
     * Static, deliberately. Liveness answers one question — should this process be killed and
     * restarted — and a liveness probe that consults a dependency restarts a healthy process
     * every time a dependency blinks. Readiness is where dependencies belong.
     */
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      // 503 is what removes this replica from the balancer. The image backend is a SOFT probe, so
      // a resource with no deployed model leaves the report `degraded` and still ready: brand
      // kits, reads and placeholder generation all still work, and removing the whole service
      // from rotation over the one thing that does not would be an outage of choice.
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
     * What this service can generate with, and whether it can generate at all.
     *
     * Unauthenticated, like `mint`'s catalogue: it names no customer, carries no key, and a
     * capability a caller cannot discover without a token is a capability they will discover by
     * having a job fail instead.
     *
     * `?probe=1` makes a real, minimal image and therefore a real charge, so it requires a token
     * and the write scope. Everything else is read from state a real call already produced.
     */
    define('GET', '/v1/backend', async (ctx, deps) => {
      if (ctx.url.searchParams.get('probe') === '1') {
        const principal = await authenticate(ctx, deps)
        if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
        ctx.log.info('backend probe requested; this makes a real image call')
        return { status: 200, body: await deps.preflight.probe() }
      }
      return { status: 200, body: deps.preflight.report() }
    }),

    define('POST', '/v1/brand-kits', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const ownerSubject = subjectOf(principal, body)

      const name = requireString(body, 'name', 200)
      const accent = requireString(body, 'accent', 7)
      if (!ACCENT_PATTERN.test(accent)) {
        throw new BadRequestError('accent must be a hex colour such as #ff4d00')
      }

      const done = deps.lifecycle.track()
      try {
        const kit = await deps.kits.create({
          ownerSubject,
          name,
          accent,
          palette: readPalette(body['palette']),
          typography: readTypography(body['typography']),
          stylePrompt: optionalString(body['stylePrompt'], MAX_STYLE_PROMPT) ?? '',
          actor: actorOf(principal),
          correlationId: ctx.requestId,
        })
        deps.metrics.increment('studio_brand_kits_created_total', { actor_kind: principal.kind })
        ctx.log.info('brand kit created', { brandKitId: kit.id })
        return { status: 201, body: { brandKit: kit } }
      } finally {
        done()
      }
    }),

    /**
     * The caller's own kits.
     *
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **THIS EXISTS SO A REPEATED BOOTSTRAP CAN FIND WHAT THE LAST ONE MADE.**
     *
     * `deploy/scripts/estate-seed.mjs` states the property it has to have: idempotent, because
     * bootstrap is re-run several times an hour, and "where a service offers an idempotency key
     * this uses it; where it does not, this lists and matches first". Studio offered neither — a
     * kit could be created and fetched by id, and an id is exactly what a fresh seeding run does
     * not have. Without this route the only way to be idempotent was to remember an id in a file
     * outside the service, which is a second source of truth about what exists.
     *
     * The store method has been here since the beginning; only the route was missing.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    define('GET', '/v1/brand-kits', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const owner = subjectOf(principal, { userId: ctx.url.searchParams.get('userId') ?? undefined })
      const kits = await deps.kits.listForOwner(owner, readLimit(ctx))
      return { status: 200, body: { brandKits: kits } }
    }),

    define('GET', '/v1/brand-kits/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      return { status: 200, body: { brandKit: await ownedKit(ctx, deps, principal) } }
    }),

    /**
     * The assets generated for one kit.
     *
     * The other half of the idempotent bootstrap, and it carries a constraint that is not merely
     * about tidiness: **FLUX assets already in the tree are permanent and are never regenerated.**
     * A seeding run that could not see an existing asset would make a second one on every pass —
     * spending real money each time, and producing a different image for the same content on every
     * bootstrap. Listing first is what makes "generate only if there is nothing here" expressible.
     */
    define('GET', '/v1/brand-kits/:id/assets', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      // Ownership is decided by the KIT, through the same helper every other kit route uses, so a
      // caller cannot read another owner's assets by naming their kit.
      const kit = await ownedKit(ctx, deps, principal)
      const assets = await deps.reads.listAssetsForKit(kit.id, readLimit(ctx))
      return {
        status: 200,
        body: {
          assets: assets.map((asset) => ({ ...asset, bytesUrl: `/v1/assets/${asset.id}/bytes` })),
        },
      }
    }),

    /**
     * **202. THE GENERATION LEAVES THE REQUEST HERE.** See the file header.
     *
     * Everything expensive about this handler is the credit reservation, which is one conditional
     * UPDATE. No model is contacted, so a refusal — for a bad spec or an exhausted cap — costs
     * nothing and cannot itself be the thing that goes over the cap.
     */
    define('POST', '/v1/brand-kits/:id/generate', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const kit = await ownedKit(ctx, deps, principal)
      const body = await readJson(ctx.req)

      const kind = typeof body['kind'] === 'string' ? body['kind'] : ''
      // `specFor` throws SpecError, mapped to 400, and it is the only place a size is validated.
      const spec = specFor(kind, {
        width: optionalInteger(body['width']),
        height: optionalInteger(body['height']),
        format: typeof body['format'] === 'string' ? body['format'] : undefined,
      })

      // A world object IS its description, and the description lives on the kit. Every other kind
      // falls back to the kit's name — a mark built around "Tessera" is a legitimate mark — but
      // `world_object` has nothing to fall back to: "a Tessera" is not an object anybody asked
      // for, so `buildPrompt` refuses it. That refusal is an `Error`, which maps to **500**, and
      // this route is where the caller's mistake becomes the caller's answer.
      //
      // This check is the one `prompt.ts` has always claimed was here and, until now, was not. It
      // was invisible because Tessera's Kiln always sets `stylePrompt`, so the only caller that
      // exists could not reach it — a defect waiting for the second caller.
      if (spec.kind === 'world_object' && kit.stylePrompt.trim().length === 0) {
        throw new BadRequestError(
          'a world_object needs a description of the object to make: set stylePrompt on the brand kit',
        )
      }
      // Same requirement, same reason: a cover is an illustration OF a subject, and with none it
      // would fall back to drawing the kit's name. `buildPrompt` refuses it structurally, which
      // maps to 500; this is where the caller's mistake becomes the caller's answer.
      if (spec.kind === 'cover' && kit.stylePrompt.trim().length === 0) {
        throw new BadRequestError(
          'a cover needs a subject to illustrate: set stylePrompt on the brand kit',
        )
      }

      const requested = typeof body['backend'] === 'string' ? body['backend'] : 'auto'
      if (!isBackendChoice(requested)) {
        throw new BadRequestError('backend must be auto, flux or placeholder')
      }
      const choice: BackendChoice = requested

      const done = deps.lifecycle.track()
      try {
        const job = await deps.generation.request({
          kit,
          spec,
          choice,
          actor: actorOf(principal),
          correlationId: ctx.requestId,
        })
        deps.metrics.increment('studio_generations_requested_total', {
          kind: spec.kind,
          backend_choice: choice,
        })
        ctx.log.info('generation accepted', { generationJobId: job.id, kind: spec.kind })

        const statusUrl = `/v1/jobs/${job.id}`
        return {
          status: 202,
          headers: { location: statusUrl },
          body: {
            accepted: true,
            job: wireJob(job),
            // Named in the body as well as the header, because a browser client reading JSON
            // should not have to know that `Location` on a 202 means something different from
            // what it means on a 201.
            statusUrl,
          },
        }
      } finally {
        done()
      }
    }),

    /** The status URL a 202 points at. Cheap, pollable, and it reaches no model. */
    define('GET', '/v1/jobs/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const job = await deps.reads.findJob(idOf(ctx))
      if (!job) throw new NotFoundError('no such generation job')
      assertOwned(principal, job.ownerSubject)
      return { status: 200, body: { job: wireJob(job), provenance: provenanceOf(job) } }
    }),

    define('GET', '/v1/assets/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const { asset, job } = await readableAsset(ctx, deps, principal)
      return {
        status: 200,
        body: {
          asset,
          // An upload has no generation to describe, so the field is absent rather than an object
          // full of nulls that reads like a generation which failed to record anything.
          provenance: job ? provenanceOf(job) : null,
          bytesUrl: `/v1/assets/${asset.id}/bytes`,
        },
      }
    }),

    /**
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **THE BYTES. THIS IS THE ROUTE THAT SERVES ATTACKER-SUPPLIED CONTENT, AND EVERY HEADER ON
     * IT IS LOAD-BEARING.**
     *
     *   * `X-Content-Type-Options: nosniff` — without it a browser may disregard the declared type
     *     and sniff the body, which is how a file that we labelled `image/png` gets executed as
     *     something else entirely.
     *   * `Content-Security-Policy: default-src 'none'; sandbox` — the response can load nothing,
     *     run nothing and navigate nowhere. Belt and braces against the SVG case, which is already
     *     refused at upload: if a stored SVG ever did reach this route, the CSP is what stops it
     *     being a session-stealing document.
     *   * `Content-Disposition: inline` with no filename — a filename here would be attacker-
     *     controlled text in a header, and there is nothing it would buy.
     *   * `Cross-Origin-Resource-Policy: cross-origin` — deliberately permissive, and it has to be:
     *     these images are embedded by `market-web` and `foresight-web`, which are different
     *     origins. Without it a browser enforcing COEP refuses to render them.
     *
     * The media type is read from the ROW, which was written from the sniffed format, and never
     * from anything the caller sends. That is the whole chain: bytes decide the type at upload,
     * the row remembers it, and the response repeats it.
     *
     * Immutable caching is safe here and nowhere else in this service, because the URL identifies
     * an asset whose bytes are content-addressed and therefore cannot change.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    define('GET', '/v1/assets/:id/bytes', async (ctx, deps) => {
      /**
       * ════════════════════════════════════════════════════════════════════════════════════════
       * **A PUBLISHED ASSET IS SERVED WITHOUT A TOKEN. EVERYTHING ELSE STILL NEEDS ONE.**
       *
       * The asset is fetched FIRST and the auth decision is made from its visibility, rather than
       * authenticating first and consulting visibility afterwards. That ordering is what lets an
       * `<img src>` work at all — see migration 10 — and it is safe precisely because publication
       * is an explicit, owner-authorised state that defaults to private in the schema.
       *
       * A private asset takes exactly the path it took before: authenticate, then check ownership,
       * then 404 for anything that is not the caller's.
       * ════════════════════════════════════════════════════════════════════════════════════════
       */
      const candidate = await deps.reads.findAsset(idOf(ctx))

      /**
       * ════════════════════════════════════════════════════════════════════════════════════════
       * **ONLY A PUBLIC ASSET SHORT-CIRCUITS. EVERYTHING ELSE FALLS THROUGH TO THE AUTHENTICATED
       * PATH — INCLUDING AN ID THAT DOES NOT EXIST.**
       *
       * The obvious shape is `if (!candidate) 404` before the visibility test, and it is wrong. It
       * answers **404** for an unknown id and **401** for a private one, to a caller holding no
       * token — so an anonymous stranger can tell the two apart, and that difference is an
       * existence oracle over every asset in the estate. It is the same defect `assertOwned` avoids
       * by answering 404 rather than 403, reintroduced one layer earlier.
       *
       * Falling through means an unknown id and a private id are **both 401** without a token, and
       * both **404** with one. A caller learns nothing they were not already entitled to know.
       *
       * The ids are `gen_random_uuid()` and enumerating 122 bits is not a threat anybody has. That
       * is not the reason this is written correctly: an oracle guarded only by the width of an
       * identifier is an oracle that becomes real the day something starts issuing shorter ones.
       * ════════════════════════════════════════════════════════════════════════════════════════
       */
      let asset: Asset
      if (candidate?.visibility === 'public') {
        asset = candidate
      } else {
        const principal = await authenticate(ctx, deps)
        if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
        asset = (await readableAsset(ctx, deps, principal)).asset
      }

      const bytes = await deps.reads.readBlob(asset.checksum, asset.format)
      if (!bytes) {
        // The row exists and the blob does not. A 404 rather than a 500: from the caller's side
        // "we do not have those bytes" is the whole truth, and it is logged at error for us.
        ctx.log.error('asset row has no blob on this replica', {
          assetId: asset.id,
          checksum: asset.checksum,
        })
        throw new NotFoundError('the bytes for this asset are not available')
      }

      return {
        status: 200,
        bytes,
        contentType: asset.mediaType ?? 'application/octet-stream',
        headers: {
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox; " +
            "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'content-disposition': 'inline',
          'cross-origin-resource-policy': 'cross-origin',
          'referrer-policy': 'no-referrer',
          // `private` on an owner-only asset keeps it out of shared caches, where a CDN would
          // otherwise be able to hand one user's image to the next request for the same URL.
          'cache-control':
            asset.visibility === 'public'
              ? 'public, max-age=31536000, immutable'
              : 'private, max-age=31536000, immutable',
          // The content address, so a client can verify the bytes it received are the bytes the
          // row claims. Quoted per RFC 7232.
          etag: `"${asset.checksum}"`,
        },
      }
    }),

    /**
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **THE UPLOAD. AUTHENTICATED, BOUNDED WHILE READING, AND VALIDATED ON CONTENT.**
     *
     * The body is raw image bytes rather than `multipart/form-data`. Multipart would mean writing
     * a parser for a format whose edge cases — nested boundaries, header injection in a part name,
     * a filename of `../../etc` — are a well-known source of exactly the bugs this endpoint must
     * not have. A single binary body has no such surface: there is no filename, no part header and
     * no boundary, so none of them can be malformed. The filename is not lost, because it was never
     * wanted: the stored name is the content address.
     *
     * `Content-Type` is READ but never trusted; it is not consulted at all. `imagebytes.normalise`
     * decides the format from magic bytes.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    define('POST', '/v1/uploads', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      // An upload is stored against the authenticated user. A service token may act for a named
      // subject, which is how `market` attributes a listing photo to its seller.
      const ownerSubject = subjectOf(principal, {
        userId: ctx.url.searchParams.get('userId') ?? undefined,
      })
      // Private unless the caller SAYS public. An unrecognised value is refused rather than
      // treated as private, because silently downgrading a caller who meant to publish produces a
      // broken image they cannot explain.
      const visibility = visibilityFrom(ctx.url.searchParams.get('visibility'))

      const bytes = await readBinary(ctx.req)

      const done = deps.lifecycle.track()
      try {
        const outcome = await deps.uploads.store({
          bytes,
          ownerSubject,
          visibility,
          actor: actorOf(principal),
          correlationId: ctx.requestId,
        })
        deps.metrics.increment('studio_uploads_accepted_total', {
          format: outcome.asset.format,
          deduplicated: String(outcome.deduplicated),
        })
        ctx.log.info('upload stored', {
          assetId: outcome.asset.id,
          format: outcome.asset.format,
          deduplicated: outcome.deduplicated,
          strippedBytes: outcome.strippedBytes,
        })
        return {
          // 200 on a deduplicated retry, 201 on a new asset: the difference is the truth, and a
          // client that retried after a timeout can tell which of the two happened.
          status: outcome.deduplicated ? 200 : 201,
          body: {
            asset: outcome.asset,
            bytesUrl: `/v1/assets/${outcome.asset.id}/bytes`,
            deduplicated: outcome.deduplicated,
            // Reported so the privacy work is visible rather than merely done. A user uploading a
            // phone photograph can see that something was removed.
            metadataStrippedBytes: outcome.strippedBytes,
          },
        }
      } finally {
        done()
      }
    }),

    /**
     * Publish or unpublish an asset's bytes. The owner's decision, and only the owner's.
     *
     * A separate route rather than a field on a general update, because this is the one operation
     * on an asset that changes who in the world can read it. Making it its own verb means it can be
     * audited, rate-limited and reasoned about on its own, and it cannot be performed by accident
     * as part of editing something else.
     */
    define('POST', '/v1/assets/:id/visibility', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      // Ownership is checked through the same helper the read path uses, so the two cannot drift.
      const { asset } = await readableAsset(ctx, deps, principal)

      const body = await readJson(ctx.req)
      const requested = visibilityFrom(typeof body['visibility'] === 'string' ? body['visibility'] : null)

      const updated = await deps.uploads.setVisibility({
        assetId: asset.id,
        visibility: requested,
        actor: actorOf(principal),
        correlationId: ctx.requestId,
      })
      if (!updated) throw new NotFoundError('no such asset')

      ctx.log.info('asset visibility changed', { assetId: asset.id, visibility: requested })
      return { status: 200, body: { asset: updated } }
    }),
  ]
}

/** `private` unless the caller said `public`. An unrecognised value is a 400, never a default. */
function visibilityFrom(value: string | null): 'private' | 'public' {
  if (value === null || value === '' || value === 'private') return 'private'
  if (value === 'public') return 'public'
  throw new BadRequestError('visibility must be private or public')
}

/**
 * An asset the principal may read, and the job behind it if there is one.
 *
 * The ownership rule differs by origin and both branches are here so they cannot drift:
 *
 *   * **generated** — ownership lives on the generation job, which is where it has always lived.
 *   * **upload** — ownership is `owner_subject` on the asset itself; there is no job.
 *
 * `assets.owner_subject` is populated for both by migration 9, but a generated row written by the
 * previous release may still have it null during a rolling deploy, so the job remains the
 * authority for generated assets rather than the new column. That is the expand half of
 * expand/contract behaving exactly as intended.
 */
async function readableAsset(
  ctx: RequestContext,
  deps: ServerDeps,
  principal: Principal,
): Promise<{ asset: Asset; job: GenerationJob | null }> {
  const asset = await deps.reads.findAsset(idOf(ctx))
  if (!asset) throw new NotFoundError('no such asset')

  if (asset.generationJobId) {
    const job = await deps.reads.findJob(asset.generationJobId)
    // An asset without its job is the state this whole service exists to make impossible, so it
    // is a 500 rather than a partial answer: `on delete restrict` should have prevented it.
    if (!job) throw new Error(`asset ${asset.id} has no generation job`)
    assertOwned(principal, job.ownerSubject)
    return { asset, job }
  }

  if (!asset.ownerSubject) {
    // Unreachable while `assets_origin_consistent` holds, which is the point of asserting it: an
    // asset with neither a job nor an owner has no ownership rule, and the safe answer to "may
    // this principal read it" when there is no rule is never "yes".
    throw new Error(`asset ${asset.id} has neither a generation job nor an owner`)
  }
  assertOwned(principal, asset.ownerSubject)
  return { asset, job: null }
}

/* ------------------------------------------------------------------------ helpers */

function wireJob(job: GenerationJob): Record<string, unknown> {
  return {
    id: job.id,
    brandKitId: job.brandKitId,
    status: job.status,
    kind: job.spec.kind,
    size: `${job.spec.width}x${job.spec.height}`,
    format: job.spec.format,
    backend: job.backend,
    model: job.model,
    // bigint is not JSON-serialisable and a Number would lose precision at scale, so money
    // crosses the wire as a decimal string. The same rule mint applies to token supply.
    costEstimateUsdMicros: job.costEstimateUsdMicros.toString(),
    costActualUsdMicros: job.costActualUsdMicros.toString(),
    creditState: job.creditState,
    errorCode: job.errorCode,
    errorDetail: job.errorDetail,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  }
}

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than
  // being a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

function actorOf(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.userId}` : `service:${principal.service}`
}

/** `user:<uuid>`. The subject spelling the rest of the estate uses. */
function subjectOf(principal: Principal, body: Record<string, unknown>): string {
  const requested = typeof body['userId'] === 'string' ? body['userId'] : undefined
  return `user:${subjectUserId(principal, requested)}`
}

/**
 * `?limit=`, bounded. Defaults low and caps hard.
 *
 * An unbounded list route is a way to ask one query to read a table, and the caller who does it is
 * usually a script that meant to ask for ten. The cap is the schema's protection, not the caller's
 * good manners.
 */
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200

function readLimit(ctx: RequestContext): number {
  const raw = ctx.url.searchParams.get('limit')
  if (raw === null || raw === '') return DEFAULT_LIST_LIMIT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new BadRequestError(`limit must be a whole number between 1 and ${MAX_LIST_LIMIT}`)
  }
  return value
}

function idOf(ctx: RequestContext): string {
  const id = ctx.params['id']
  if (!id) throw new BadRequestError('an id is required')
  return id
}

/**
 * A kit the principal may act on.
 *
 * A kit that exists but belongs to somebody else is **404**, not 403. A distinct 403 would let
 * anyone enumerate which ids exist.
 */
async function ownedKit(ctx: RequestContext, deps: ServerDeps, principal: Principal): Promise<BrandKit> {
  const kit = await deps.kits.find(idOf(ctx))
  if (!kit) throw new NotFoundError('no such brand kit')
  assertOwned(principal, kit.ownerSubject)
  return kit
}

function assertOwned(principal: Principal, ownerSubject: string): void {
  if (isAdmin(principal)) return
  // A service token with a scope acts on behalf of the estate and is not narrowed further here;
  // the scope IS its authority. A user token must match the subject.
  if (principal.kind === 'service') return
  if (ownerSubject !== `user:${principal.userId}`) throw new NotFoundError('no such resource')
}

function requireString(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new BadRequestError(`${field} must be a string of 1 to ${max} characters`)
  }
  return value.trim()
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > max) {
    throw new BadRequestError(`expected a string of at most ${max} characters`)
  }
  return value
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BadRequestError('width and height must be whole numbers')
  }
  return value
}

function readPalette(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_PALETTE) {
    throw new BadRequestError(`palette must be an array of at most ${MAX_PALETTE} hex colours`)
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || !ACCENT_PATTERN.test(entry)) {
      throw new BadRequestError('every palette entry must be a hex colour such as #12100f')
    }
    return entry
  })
}

function readTypography(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError('typography must be an object of string values')
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string' || entry.length > 200) {
      throw new BadRequestError(`typography.${key} must be a string of at most 200 characters`)
    }
    out[key] = entry
  }
  return out
}

/**
 * Read a raw binary body, refusing at the byte that crosses the cap.
 *
 * The check is inside the loop and BEFORE the chunk is retained, exactly as `readJson` does it. A
 * size check performed after buffering — `if (body.length > MAX)` on a fully-read body — is not a
 * limit, it is a report: by the time it fires the process has already allocated whatever an
 * unauthenticated caller decided to send. This endpoint is authenticated, which lowers the exposure
 * and does not change the reasoning, because a single compromised token should not be able to
 * exhaust a replica's memory.
 *
 * `UploadRejected` rather than `BadRequestError` so it lands on the same mapped 400 with a reason
 * code as every other refusal, and shows up under the same counter.
 */
async function readBinary(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_UPLOAD_BYTES) {
      throw new UploadRejected(
        'too_large',
        `an upload may be at most ${MAX_UPLOAD_BYTES} bytes, and this request exceeded that while ` +
          'still being read',
      )
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive that
    // any unauthenticated caller can reach.
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

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line and the trace.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload =
    reply.bytes ?? Buffer.from(reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`, 'utf8')
  res.writeHead(reply.status, {
    // Health, metrics and job status are a point-in-time fact. A cached 200 from a replica that
    // has since gone unready is exactly the lie this arrangement exists to stop telling.
    //
    // It is the DEFAULT rather than the last word, because stored image bytes are the one thing
    // this service serves that is genuinely immutable — the URL contains a content address, so the
    // bytes behind it cannot change. `no-store` there would re-fetch every image on every page
    // view for no correctness gain at all. A route that wants to say otherwise sets the header and
    // its value survives the spread below.
    'cache-control': 'no-store',
    ...(reply.headers ?? {}),
    // These three are authoritative and are placed after the spread so a route cannot get them
    // wrong: a mismatched content-length truncates the response, and an unechoed request id breaks
    // every support conversation.
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': payload.length,
    'x-request-id': requestId,
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}


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
      handle: async (ctx: KernelContext<Db>): Promise<Reply> => await handle(route, ctx, forRequest(deps, ctx.network)),
    }))
}
