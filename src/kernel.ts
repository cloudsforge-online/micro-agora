/**
 * The HTTP kernel: matching, the request lifecycle, and the shapes a route answers in.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **NO ROUTE LIVES HERE, AND NOTHING HERE KNOWS WHAT THIS SERVICE IS.** This file imports the
 * runtime packages and `node:http` and nothing else from `src/` — no store, no decoder, no domain
 * error. That is the whole point of it: `mountRoutes` can be handed the square's routes, or the
 * square's routes concatenated with four other modules', and it cannot tell the difference.
 *
 * The seam exists so that further modules can be mounted in this process without re-implementing
 * the request lifecycle — the network attribution, the per-request handle, the in-flight gauge and
 * the duration histogram — which is exactly the code that is dangerous to write twice.
 *
 * It is `micro-emberkin/src/kernel.ts` (waves M3/M4a), which is lantern's (wave M1b), reproduced
 * here for wave M5a of micro-deploy `docs/service-merge-plan.md` — the wave that makes this
 * process the seed of `platform`. Every line is the same design for the same reasons, and the two
 * that matter most are below.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT A FIVE-MODULE PROCESS NEEDS THAT A ONE-MODULE SERVER DID NOT ──────────────────────────
 *
 *   1. **`TSql` is a type parameter.** The kernel names the minimal `Sql` from `@cloudsforge/db`;
 *      every module's routes read `postgres`'s own handle, because their queries use tagged
 *      templates the minimal interface does not publish. A parameter rather than a winner picked
 *      and cast at every read.
 *   2. **A route may name the SELECTOR its `ctx.sql` is resolved from** (`RouteSpec.sql`). This is
 *      the one thing this merge genuinely could not do without, and it is worse here than it was
 *      in M3: `outbox`, `event_subscriptions`, `outbox_deliveries` and `inbox` exist in FOUR of
 *      this process's five schemas with the same columns, `inbox` and `jobs` exist in all five,
 *      and a handler handed another module's handle does not fail. `insert into inbox …` SUCCEEDS
 *      and dedupes an event that database has never seen; `select … from jobs` SUCCEEDS and
 *      returns another module's queue. Which database a route reads is therefore a property of
 *      the route declaration, resolved once at the edge of the request exactly where the network
 *      is. `merged.test.ts` goes red in several places if the stamp is removed, and
 *      `migratortargets.test.ts` measures the overlap rather than asserting it.
 *
 * ── AND WHAT THIS FILE DELIBERATELY DOES NOT DO ────────────────────────────────────────────────
 *
 * It does not thread a dependency bag. `RouteSpec.handle` takes only `ctx`, so a module's routes
 * close over that module's own deps at construction time and there is no parameter through which
 * another module's queue, credential or store could arrive. `agora/src/server.ts` still rebuilds
 * its five domain dep objects per request — `forRequest` — but it now does so INSIDE the handler,
 * where a throw is a rejected promise this file's `.catch` is already attached to. See the note
 * on `answer` below, and `ownnetwork.test.ts`, which reads both files.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { NetworkUnknownError, requestNetwork, type Network } from '@cloudsforge/http'
import type { NetworkSql, Sql } from '@cloudsforge/db'
import { newRequestId, type Logger, type Metrics } from '@cloudsforge/telemetry'

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
  readonly headers?: Record<string, string>
}

export interface RequestContext<TSql = Sql> {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
  /**
   * The network THIS REQUEST belongs to, from the `CF-Network` header the gateway stamped.
   *
   * Not a property of the process: one pod serves both estates since the network consolidation
   * (micro-deploy `docs/network-consolidation.md`), so "which network am I" has no answer and
   * "which network is this request" has exactly one.
   */
  readonly network: Network
  /**
   * The database handle for `network`, resolved ONCE, at the edge of the request.
   *
   * Every route uses this rather than reaching for the process-wide handle, because a wrong handle
   * is not an error — it is a query that SUCCEEDS against the other estate's rows and says nothing.
   * `deps.sql` is a `NetworkSql` with no query methods, so the mistake does not compile.
   *
   * Resolved from the selector the route named (`RouteSpec.sql`), or the kernel's own when it
   * named none. In this process that means agora's routes get agora's database and each mounted
   * module's routes get its own, with the same "a wrong handle is silent" argument now applying
   * across modules as well as across networks — and with five schemas sharing an `inbox` and a
   * `jobs` table to make it silent in practice rather than in theory.
   */
  readonly sql: TSql
}

/**
 * Routes that answer without belonging to a network.
 *
 * Kubelet probes the first two and Prometheus scrapes the third; none arrives through the gateway,
 * so none carries `CF-Network`. Refusing them turns a data-isolation rule into a CrashLoopBackOff —
 * which is exactly what agora's first build of the network consolidation did. A literal set rather
 * than a prefix, because this is an exemption from a data boundary and widening it should be a
 * deliberate edit. Every member must answer without touching the database.
 */
export const OPERATIONAL_ROUTES: ReadonlySet<string> = new Set(['/livez', '/readyz', '/metrics'])

/**
 * One route, as the module that owns it declares it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`handle` TAKES ONLY `ctx`.** It used to take `(ctx, deps)`, which made every route a function
 * of the ONE dependency bag the process happened to have. Five modules in one process do not share
 * one bag — different databases, different job queues, different signing arrangements, different
 * blob stores — so a `deps` parameter threaded by the kernel would have to become a union, and
 * every rule about which module may reach what would be a convention instead of a scope. Closing
 * over deps at construction time makes it a scope.
 *
 * That is not decoration here. A module's deps bag reaches ONE database's `jobs` table: a studio
 * route enqueuing through agora's bag writes an `asset.generate` row into agora's database, where
 * no handler will ever claim it and no query will ever find it — and `jobs` exists in all five
 * schemas, so the insert succeeds.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface RouteSpec<TSql = Sql> {
  readonly method: string
  /** `/v1/posts/:id`. Used verbatim as the metric label, so cardinality is bounded. */
  readonly path: string
  readonly handle: (ctx: RequestContext<TSql>) => Promise<Reply>
  /**
   * The per-network SELECTOR this route's `ctx.sql` is resolved from.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **OMITTED MEANS "THE KERNEL'S OWN", WHICH IS EVERY ROUTE IN A ONE-MODULE PROCESS.** It is set
   * by a module whose routes are mounted BESIDE another module's, and it is the difference between
   * a merge that works and a merge that is a silent data fault.
   *
   * `mountRoutes` resolves one handle per request, from one selector. Merge five services into one
   * process without this and every mounted module's handlers are handed the FIRST module's
   * database: `insert into inbox …` then writes agora's inbox instead of devplatform's, SUCCEEDS,
   * dedupes an event that database has never seen, and reports nothing. It is the same class of
   * failure as answering a testnet request out of mainnet — a query that succeeds and says nothing
   * — which is why the answer is the same one: name the selector, resolve it at the edge, and
   * refuse loudly when the deployment holds no handle.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly sql?: NetworkSql
}

/** A `RouteSpec` with its path compiled. Built by `mountRoutes`, never by a route module. */
export interface Route<TSql = Sql> {
  readonly method: string
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext<TSql>) => Promise<Reply>
  readonly sql?: NetworkSql
}

/**
 * Compile `/v1/posts/:id` into a matcher. The segment pattern excludes `/` so a parameter cannot
 * swallow the rest of the path and make one route answer for another.
 */
export function compile(path: string): RegExp {
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

/**
 * What the request lifecycle itself needs — and deliberately nothing a route needs.
 *
 * A module's own `ServerDeps` extends this, so `mountRoutes(createRoutes(deps), deps)` typechecks
 * while the kernel's own type still cannot see the verifier, the queue or the domain stores.
 */
export interface MountDeps {
  readonly logger: Logger
  readonly metrics: Metrics
  /**
   * The per-network SELECTOR, not a handle. `NetworkSql` has no query methods, so a route that
   * reaches for the process-wide handle instead of `ctx.sql` does not compile — which is the point:
   * a wrong handle is not an error, it is a query that SUCCEEDS against the other estate's rows.
   */
  readonly sql: NetworkSql
  /**
   * The network to assume when no `CF-Network` arrives, or `undefined` to refuse. `CF_NETWORK_SINGLE`,
   * for `pnpm dev`, which has no gateway in front of it, and for the service-to-service callers that
   * never reach one.
   */
  readonly singleNetwork?: Network
}

/**
 * Mount a set of route specs on a `node:http` server.
 *
 * Everything between the socket and `handle(ctx)` is here: the request id, the URL, matching, the
 * network attribution, the per-request database handle, the in-flight gauge and the two HTTP
 * metrics. A route module supplies specs and never sees any of it.
 */
export function mountRoutes<TSql>(specs: readonly RouteSpec<TSql>[], deps: MountDeps): Server {
  const routes: Route<TSql>[] = specs.map((spec) => ({
    method: spec.method,
    path: spec.path,
    pattern: compile(spec.path),
    handle: spec.handle,
    ...(spec.sql ? { sql: spec.sql } : {}),
  }))
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    let matched: Route<TSql> | undefined
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

    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number, metricNetwork: string): void => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      // `network` on every series. Prometheus labelled it per TARGET, which distinguishes nothing
      // once one target serves both estates — micro-org#398 in a form where the information would
      // never have been recorded at all.
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

    // ── WHICH DATABASE, THEN THE NETWORK, BEFORE ANY ROUTE RUNS ──────────────────────────────
    //
    // A route mounted by another module names its own selector; everything else takes the
    // kernel's. Read here, before either resolution, so "which module" and "which estate" come
    // from one place and cannot disagree.
    const selector = matched?.sql ?? deps.sql

    // `requestNetwork` REFUSES an unstamped request rather than assuming mainnet: a 500 is a
    // routing fault made loud, where a default is a cross-network write nothing would ever flag.
    //
    // The operational endpoints are exempt because kubelet and Prometheus do not come through the
    // gateway and never send the header. Refusing them makes the pod never become ready.
    const networkless = matched !== undefined && OPERATIONAL_ROUTES.has(matched.path)
    let network: Network
    try {
      network = networkless
        ? (deps.singleNetwork ?? selector.networks[0] ?? 'mainnet')
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
    // `selector.for()` THROWS when this deployment holds no handle for that network, and that
    // refusal is the safety property the consolidation rests on — better a loud 500 than a query
    // answered out of the other estate's rows.
    //
    // It runs BEFORE `handle` returns a promise, so an uncaught throw escapes the `void` expression
    // past a `.catch` that is not attached yet, and the listener returns having sent NOTHING. Worse
    // than a hang: node exits on an uncaught exception in a request listener, so the pod died on
    // the first request naming a network it did not hold and its replacement died on the next one.
    // Which made it a remote crash reachable by anyone who can set a header, against pods that sit
    // behind a public gateway.
    //
    // Everything else a request needs — this module's domain objects and its job queue included —
    // is resolved INSIDE the handler, where a throw is already a rejected promise this `.catch` is
    // attached to.
    let sql: TSql
    try {
      // The one cast in this file. `Sql` and `postgres`'s handle are two published views of the
      // same object — `networkSql` is built over the driver's clients — so `TSql` names which view
      // the mounted module reads through, never a different value.
      sql = selector.for(network) as unknown as TSql
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
    void answer(matched, { req, url, requestId, log, params, network, sql })
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

/**
 * Run the chosen handler, or answer the bare 404 when nothing matched.
 *
 * `async` rather than a bare call so a handler that throws SYNCHRONOUSLY becomes a rejected promise
 * the `.catch` above is already attached to, rather than a throw escaping the `void` expression.
 * That is what lets a module rebuild its per-request domain objects inside its own handler: the
 * rebuild can reach a per-network plane that throws exactly as hard as `selector.for` does, and it
 * is now on the promise side of the boundary rather than the listener side.
 */
async function answer<TSql>(
  route: { readonly handle: (ctx: RequestContext<TSql>) => Promise<Reply> } | undefined,
  ctx: RequestContext<TSql>,
): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  return await route.handle(ctx)
}

export function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

export function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    ...(reply.headers ?? {}),
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
