/**
 * The HTTP surface.
 *
 * Plain `node:http`, as the template and aetherholm both are. Rule 4 of docs/ecosystem/03 §2:
 * `/livez`, `/readyz` and `/metrics` on every service, or it does not pass CI.
 *
 * The one decision here that is easy to get backwards is the auth-fault mapping. A bad token is
 * 401. A verifier that could not reach the JWKS is **503**, never 401 — answering 401 there signs
 * every user in the estate out because the identity service is having a bad minute. `statusFor`
 * from `@cloudsforge/auth` is the one place that decides it, so five services cannot disagree.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY GATE IN THIS FILE DEMANDS A SCOPE THE ESTATE'S DERIVATION CAN READ.
 *
 * `requireScope(principal, LITERAL_CONSTANT)` — the shape `service-ci.yml`'s scope audit resolves
 * (`addGate('requireScope', 1)`, and `resolveExpr` follows a sibling constant to its literal). A
 * gate it cannot resolve is FATAL to the build, deliberately: a demand it cannot read is a demand
 * it cannot prove is registered, and identity fail-fasts at import on a grant naming an unknown
 * scope (`identity/src/env.ts`).
 *
 * Verified by running the estate's own extracted audit against this repository, not by reading the
 * workflow: it reports `tessera:provision`, `tessera:read` and `tessera:write`, each naming the
 * line below that demands it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
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
import {
  PROVISION_PATH,
  TITLE_DESCRIPTOR_PATH,
  parseProvisionRequest,
  serialiseProvisionResult,
  serialiseTitleDescriptor,
} from '@cloudsforge/contracts-worlds'
import { EVENT_ID_HEADER, SIGNATURE_HEADER } from '@cloudsforge/contracts-events'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { NetworkUnknownError, requestNetwork, type Network } from '@cloudsforge/http'
import type { NetworkSql } from '@cloudsforge/db'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { TESSERA_PROVISION_SCOPE, TESSERA_READ_SCOPE, TESSERA_WRITE_SCOPE } from './scopes.ts'
import { handleDelivery } from './inbound.ts'
import type { Db } from './outbox.ts'
import type { RequestContext as KernelContext, RouteSpec } from '../kernel.ts'
import {
  bankParcel,
  claimParcel,
  findParcel,
  findWard,
  isTier,
  listFallow,
  listParcelsIn,
  listParcelsOf,
  listWards,
  openContest,
  setParcelFlags,
  WorldError,
  type Ward,
} from './world.ts'
import {
  FACINGS,
  findObject,
  isCategory,
  listObjectsOf,
  listPlacements,
  placeObjects,
  removePlacement,
  requestFiring,
  type Facing,
  type Footprint,
} from './kiln.ts'
import {
  bookVenue,
  cancelBooking,
  draftListing,
  findBooking,
  findListing,
  listBookingsOf,
  listListingsOf,
  openVenue,
  platformTerms,
  settleBooking,
  venueOf,
  type ActivateListingInput,
  type Booking,
  type BookingLedger,
  type Listing,
  type Venue,
} from './economy.ts'
import { lightBeacon, rankParcels, recordVisit } from './discovery.ts'
import { arrive, depart, whoIsIn, type PresenceHub } from './presence.ts'
import { TITLE_DESCRIPTOR, provision } from './titlecontract.ts'
import { ASSET, parsePriceWei, toSparks } from './sparks.ts'
import type { LedgerClient, Wallet } from './ledgerclient.ts'

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
  readonly presence?: PresenceHub
  /** True when a Kiln upstream is configured. Absent is a supported mode — see `env.ts`. */
  readonly kilnConfigured?: boolean
  readonly enqueueFiring?: (objectId: string, subject: string) => Promise<void>
  /**
   * The market seam. Absent when `MARKET_URL` is unset, which is a supported mode: without it
   * `POST /v1/listings/:id/activate` answers 503 and everything else — including drafting a
   * listing — still works. A world you cannot sell in is still a world you can build in.
   */
  readonly market?: {
    activate(input: ActivateListingInput): Promise<Listing>
  }
  /**
   * Reads a player's ledger balances. Absent when `LEDGER_URL` is unset, and the route then
   * answers 503 rather than zeroes — see `GET /v1/me/balances`.
   */
  readonly wallet?: (subject: string) => Promise<Wallet>
  /**
   * The escrow seam behind a Venue's calendar: reserve, release, and the fee that pays the owner.
   *
   * Absent when `LEDGER_URL` or the service credential is unset, and the three booking routes then
   * answer 503 — the same optionality the market seam has, for a stronger reason. A booking is an
   * escrowed hold (§5); a world that cannot escrow must not take one, because a booking written
   * without a reservation is the free hold on somebody else's calendar that migration 14 makes
   * unrepresentable. Refusing the route is the honest form of the same refusal.
   */
  readonly escrow?: BookingLedger & Pick<LedgerClient, 'reserve'>
  /**
   * The ward-governance seam. Absent when `COMMUNITY_URL` is unset, same optionality: a ward with
   * no community is the state every ward is minted in, so an unconfigured upstream removes a
   * route rather than the world.
   */
  readonly governance?: {
    found(input: {
      readonly ward: Ward
      readonly founderToken: string
      readonly correlationId: string
    }): Promise<Ward>
  }
  /**
   * Refresh sampled gauges immediately before `/metrics` renders. Queue depth is a value that
   * must be read, not counted, and reading it on a timer would be the one `setInterval` in this
   * repository — the shape rule 8 exists to keep out. A scrape is already periodic.
   */
  readonly beforeScrape?: () => Promise<void>
  /**
   * Every secret that may have signed an inbound delivery to `POST /v1/events`, newest first.
   *
   * `env.inboundSigningSecrets` — the SAME list the relay's receiver end reads, not a second
   * variable, because a second variable is a second thing to rotate and the estate has one
   * outbox secret shared by 24 services. See `env.ts` on why this is a list rather than a value:
   * swapping a single key partitions deliveries for the length of a rolling deploy, and the
   * failure reads as a secret mismatch rather than as a deploy ordering problem.
   *
   * **Not optional, unlike every other seam above.** The Kiln, the market, the wallet and ward
   * governance are all absent-is-a-supported-mode, because a world you cannot sell in is still a
   * world you can walk around in. The inbox is not like that: an unconfigured inbox would mean
   * `identity.user.deleted` had no route to arrive on, and a right-to-erasure request would go on
   * reporting success while changing nothing — which is the exact defect this route was added to
   * end. There is no degraded mode of GDPR compliance.
   */
  readonly eventAcceptSecrets: readonly string[]
}

export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'tessera_parcels_claimed_total',
      help: 'Parcels claimed',
      kind: 'counter',
      labels: ['tier'],
    })
    .register({
      name: 'tessera_firings_total',
      help: 'Kiln firings requested',
      kind: 'counter',
      labels: ['footprint'],
    })
    .register({
      name: 'tessera_provisions_total',
      help: 'Title provisions',
      kind: 'counter',
      labels: ['outcome'],
    })
    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * THE THREE SERIES THAT WOULD HAVE ANSWERED micro-org #222 ON THE DAY IT STARTED.
     *
     * `TESSERA_SERVICE_CREDENTIAL` held a JWT that had been expired for twenty-six hours on a
     * container reporting healthy. Nothing anywhere could answer "can this process authenticate
     * right now", because `/livez` presents the credential to nobody and every other signal — the
     * probe, the job runner, the request metrics — is about work that never leaves this service.
     *
     * `usable` is read out of the provider's own memory at scrape time; there is no timer and no
     * outbound call, so a scrape cannot itself become load on identity. `static` counts as usable
     * because it IS — for about ten minutes — which is exactly why it needs the second gauge beside
     * it rather than a kinder reading of the first. Together they answer both halves: can this
     * process authenticate, and is it even ABLE to renew.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    .register({
      name: 'tessera_service_token_usable',
      help: 'Whether an outbound call right now would be authenticated without waiting',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'tessera_service_token_static',
      help: 'Whether this process holds an un-renewable pre-minted token (micro-org #222)',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'tessera_service_token_events_total',
      help: 'Service credential exchanges, refusals and 401 replays',
      kind: 'counter',
      labels: ['kind'],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 256 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
  readonly stream?: (res: ServerResponse) => void
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
 * so none carries `CF-Network`. Refusing them turns a data-isolation rule into a CrashLoopBackOff —
 * which is exactly what agora's first build did: 500 on every probe, container never ready.
 *
 * A literal SET rather than a prefix, because this is an exemption from a data boundary and
 * widening it should be a deliberate edit. Every member must answer without touching the database.
 */
const OPERATIONAL_ROUTES: ReadonlySet<string> = new Set(['/livez', '/readyz', '/metrics'])

interface Route {
  readonly method: string
  readonly path: string
  readonly pattern: RegExp
  readonly names: readonly string[]
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

function compile(path: string): { pattern: RegExp; names: string[] } {
  const names: string[] = []
  const source = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      names.push(segment.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { pattern: new RegExp(`^${source}$`), names }
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
    let matched: Route | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== (req.method ?? 'GET')) continue
      const m = route.pattern.exec(url.pathname)
      if (!m) continue
      matched = route
      params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(m[i + 1] ?? '')]))
      break
    }
    // Unmatched paths collapse to one label. Using the raw path would let any caller mint
    // unbounded time series and take the scrape target down with cardinality.
    const routeLabel = matched ? matched.path : 'unmatched'
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
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method: req.method ?? 'GET',
        route: routeLabel,
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
        if (reply.stream) {
          finish(reply.status, network)
          reply.stream(res)
          return
        }
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

async function handle(
  route: Route | undefined,
  ctx: RequestContext,
  deps: ServerDeps,
): Promise<Reply> {
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
    if (err instanceof WorldError) {
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof BadRequestError) {
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
  ): Route => {
    const { pattern, names } = compile(path)
    return { method, path, pattern, names, handle: handler }
  }

  return [
    /* ------------------------------------------------------------------------- operational */

    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    /* --------------------------------------------------------------- the title contract */

    // ── WAVE M5b: WHY `/v1/title` AND `/v1/provision` ARE MOUNTED BARE, NOT SUFFIXED ────────────
    //
    // These two are FROZEN CONTRACT PATHS from `@cloudsforge/contracts-worlds`, and aetherholm ALSO
    // mounts exactly `/v1/title` and `/v1/provision`. That is a collision only WITHIN ONE PROCESS,
    // and there is none here: aetherholm arrives in wave M5d inside the separate `emberkin` pod — a
    // different process with its own listener — so nothing in agora's process serves these paths
    // besides tessera. They are therefore left AS-IS in `mountableRoutes` below (unlike the event
    // path, which three modules in THIS process do share and which is why it gets a suffix/split).
    // If a future wave ever placed tessera and aetherholm in the SAME process, these frozen paths
    // would need the same treatment the event paths get — a suffixed `MOUNTED_*_PATH` and a split —
    // because first-wins matching would otherwise silently shadow one title's contract with the
    // other's.
    //
    // Public and unauthenticated: a descriptor is a capability statement, and worlds reads it
    // before it holds any credential for this title. Both paths come from the contract, so this
    // service cannot serve a route worlds does not call.
    define('GET', TITLE_DESCRIPTOR_PATH, async () => ({
      status: 200,
      body: serialiseTitleDescriptor(TITLE_DESCRIPTOR),
    })),

    define('POST', PROVISION_PATH, async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind !== 'service') {
        // Provisioning is the platform's act, driven by a paid entitlement. A user token here is
        // somebody trying to raise a ward without buying one.
        throw new ForbiddenError(TESSERA_PROVISION_SCOPE)
      }
      requireScope(principal, TESSERA_PROVISION_SCOPE)

      // Parsed by the CONTRACT's parser, not by six hand-written `requireString` calls. The
      // correlation id is passed in rather than read from the body because it travels as the
      // request id header and is deliberately not a wire field — a receiver that made it a
      // required body field would 400 every real request from the bridge and pass every test
      // written from the interface.
      const parsed = parseProvisionRequest(await readJson(ctx.req), ctx.requestId)
      if (!parsed.ok) throw new BadRequestError(parsed.errors.join('; '))

      const done = deps.lifecycle.track()
      try {
        const outcome = await provision(ctx.sql, parsed.value)
        deps.metrics.increment('tessera_provisions_total', {
          outcome: outcome.replayed ? 'replayed' : 'provisioned',
        })
        ctx.log.info('provisioned', {
          entitlementId: parsed.value.entitlementId,
          urn: outcome.urn,
          replayed: outcome.replayed,
        })
        return { status: outcome.replayed ? 200 : 201, body: serialiseProvisionResult(outcome) }
      } finally {
        done()
      }
    }),

    /* -------------------------------------------------------------------- the world, read */

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // **THE MOSAIC IS PUBLIC. A STRANGER MUST BE ABLE TO SEE THE MAP.**
    //
    // These two routes authenticated every read until now, and a signed-out visitor arriving at
    // Tessera's front door got a 401 — the last failing check in `beacon smoke`. It is fixed here
    // rather than allowed for, because the 401 was wrong, and three separate things say so.
    //
    // **1. The design forbids exactly this.** 23-tessera.md §5 opens the loop with
    //
    //        arrive at the Commons    a browser tab; no download, no plugin, NO ACCOUNT WALL
    //
    //    and §4 builds the whole economy on it: land is free and abundant, the platform never sells
    //    it, supply is elastic and only LOCATION is scarce. A world whose map you must register to
    //    look at has an account wall on the first arrow of its own loop.
    //
    // **2. The estate has already settled this, in these words.** `worlds/src/server.ts` serves
    //    the title registry unauthenticated under the note "a launcher listing games cannot require
    //    a token to do it". The Mosaic is that same object one level down: the list of places a
    //    launcher, a search engine or a stranger following a link needs in order to decide to come.
    //
    // **3. It was never a security boundary, only a registration wall.** The projection is
    //    `id, slug, name, archetype, ordinal, claimable_tiles, claimed_tiles, community_id,
    //    instances, opened_at` (`world.ts`) — geography and occupancy, not one user-scoped or
    //    money field. And ANY account could already read it, while an account is free and
    //    self-serve. So the 401 excluded nobody it meant to; it only made a public map cost a
    //    signup. That is the test for whether removing a gate weakens authentication, and this one
    //    fails it: no principal could see anything here that anonymous cannot.
    //
    // **`…/:id/parcels` goes with them, and that was decided AFTER the first fix, not with it.**
    // Opening `/v1/wards` alone moved `beacon smoke` from a 401 on the ward list to a 401 on the
    // ward's parcels, one request later — the first had been masking the second. The temptation is
    // then to keep opening routes until a check goes green, which is how a gate gets removed for a
    // reason that is not a reason. So it was decided the same way as the first, from the design:
    //
    //   * §5's loop is "arrive at the Commons … place it; open your gate — a parcel with an open
    //     gate is a place people can enter … someone walks in". The person walking in has, by §5's
    //     own first line, no account. A world you must register to see the buildings of has an
    //     account wall two steps into its loop instead of one.
    //   * `tessera-web` had already written the conclusion down, in the client that renders this
    //     list: *"A shut gate is still openable as a screen — the parcel EXISTS and **the world is
    //     public**. … a world with invisible buildings is a world that feels empty when it is not"*
    //     (`tessera-web/src/pages/world.tsx`). Its empty state is "Nothing has been claimed in
    //     this ward yet — **All of it is free.**"
    //   * And it BOUNDS the change rather than starting a slide: the arrivals screen makes exactly
    //     two calls, `listWards` and `listWardParcels`. It does not ask for presence. The next route
    //     out is not needed by any anonymous screen, so this is the end of the opening, not a step
    //     in one.
    //
    // **`ownerSubject` is exposed by this, knowingly.** It is the one field here that refers to a
    // person, and the decision is recorded rather than glossed: it is an opaque uuid with no
    // resolver an anonymous caller can reach; this estate publishes ownership by design already
    // (on chain, and §9.2's Author of record is *derived and public* precisely so it cannot be
    // forged); the screen that renders this list does not display it; and a free, self-serve account
    // could always read it, so the gate was a signup wall and not a boundary. If that trade is ever
    // reconsidered, the answer is to drop the field from THIS route's projection — `GET
    // /v1/parcels/:id` answers "who owns it" and stays gated — not to close the world again.
    //
    // **What stays gated, and why the line is drawn exactly here.** `…/:id/presence` returns a
    // subject with live `x, y` — where a named person is standing, right now. That is not a fact
    // about the world, it is a fact about a body in it, and it is the one thing on this page that
    // could put somebody somewhere. The map and the buildings are public; the room is not.
    //
    // No `authenticate` call at all, matching `worlds`: the response does not vary by principal, so
    // reading a token would be decoration, and a visitor whose access token has merely expired must
    // still see the world rather than an error. `tessera-web`'s `SignedOut` branch on this page
    // (`tessera-web/src/pages/world.tsx`) becomes unreachable — it was a workaround for this
    // defect, written by somebody who had already worked out that the page is public.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    define('GET', '/v1/wards', async (ctx, deps) => ({
      status: 200,
      body: { wards: await listWards(ctx.sql) },
    })),

    define('GET', '/v1/wards/:id', async (ctx, deps) => {
      const ward = await findWard(ctx.sql, ctx.params['id'] ?? '')
      if (!ward) return errorReply(404, 'not_found', 'no such ward', ctx.requestId)
      return { status: 200, body: { ward } }
    }),

    define('GET', '/v1/wards/:id/parcels', async (ctx, deps) => {
      const ward = await findWard(ctx.sql, ctx.params['id'] ?? '')
      if (!ward) return errorReply(404, 'not_found', 'no such ward', ctx.requestId)
      return { status: 200, body: { parcels: await listParcelsIn(ctx.sql, ward.id) } }
    }),

    define('GET', '/v1/wards/:id/presence', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TESSERA_READ_SCOPE)
      const ward = await findWard(ctx.sql, ctx.params['id'] ?? '')
      if (!ward) return errorReply(404, 'not_found', 'no such ward', ctx.requestId)
      return { status: 200, body: { avatars: await whoIsIn(ctx.sql, ward.id) } }
    }),

    define('GET', '/v1/parcels/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TESSERA_READ_SCOPE)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const parcel = await findParcel(ctx.sql, id)
      if (!parcel) return errorReply(404, 'not_found', 'no such parcel', ctx.requestId)
      return {
        status: 200,
        body: { parcel, placements: await listPlacements(ctx.sql, parcel.id) },
      }
    }),

    // The lazy fallow read. §4, §11.4: no sweep produced this list — it is a range scan against
    // the database's own clock, made when somebody asks.
    define('GET', '/v1/parcels/fallow', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TESSERA_READ_SCOPE)
      return { status: 200, body: { parcels: await listFallow(ctx.sql) } }
    }),

    /* ------------------------------------------------------------------ discovery, read */

    // Two inputs, never three. `rankParcels` touches `visits` and `parcels` and nothing else;
    // there is no `promoted` column to join to and no query parameter that could order this
    // differently. §6.5, §7.1's first refusal.
    define('GET', '/v1/discover', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TESSERA_READ_SCOPE)
      const wardParam = ctx.url.searchParams.get('wardId')
      const wardId = wardParam && UUID.test(wardParam) ? wardParam : null
      return { status: 200, body: { parcels: await rankParcels(ctx.sql, wardId) } }
    }),

    // The one set of terms, for everybody. There is no `subject` parameter and there must not be.
    define('GET', '/v1/terms', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TESSERA_READ_SCOPE)
      const terms = await platformTerms(ctx.sql)
      return {
        status: 200,
        body: {
          ...terms,
          // Stated on the wire, because §7.2's fifth refusal is a promise to users and a promise
          // nobody can check is a marketing claim.
          identicalForEveryAccount: true,
        },
      }
    }),

    /* ------------------------------------------------------------------- the world, write */

    define('POST', '/v1/parcels', async (ctx, deps) => {
      const { principal, subject } = await requireUser(ctx, deps)
      const body = await readJson(ctx.req)
      const wardId = requireString(body, 'wardId')
      const tier = requireString(body, 'tier')
      if (!isTier(tier)) throw new BadRequestError('tier must be homestead, plot, court or quarter')
      const originX = requireInteger(body, 'originX', 0, 255)
      const originY = requireInteger(body, 'originY', 0, 255)

      // THERE IS NO PRICE HERE, AND THERE IS NO PAYMENT CALL. §4: land is claimed free and the
      // platform never sells it. `world.test.ts` asserts the absence of both from this file.
      const done = deps.lifecycle.track()
      try {
        const parcel = await claimParcel(ctx.sql, {
          wardId,
          ownerSubject: subject,
          tier,
          originX,
          originY,
          correlationId: ctx.requestId,
        })
        deps.metrics.increment('tessera_parcels_claimed_total', { tier: parcel.tier })
        ctx.log.info('parcel claimed', { parcelId: parcel.id, tier: parcel.tier, principal: principal.kind })
        return { status: 201, body: { parcel } }
      } finally {
        done()
      }
    }),

    define('POST', '/v1/parcels/:id/bank', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const parcel = await bankParcel(ctx.sql, {
        parcelId: id,
        ownerSubject: subject,
        correlationId: ctx.requestId,
      })
      return { status: 200, body: { parcel } }
    }),

    define('POST', '/v1/parcels/:id/contest', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      // The thirty days are checked by the DATABASE, on its own clock, inside the insert. This
      // route does not check them: a second answer to the same question is a second thing that
      // can be wrong, and only one of the two runs inside the transaction.
      const outcome = await openContest(ctx.sql, {
        parcelId: id,
        challengerSubject: subject,
        correlationId: ctx.requestId,
      })
      return { status: 201, body: outcome }
    }),

    define('PATCH', '/v1/parcels/:id', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const body = await readJson(ctx.req)
      const flags: { isVenue?: boolean; isWorkshop?: boolean; gateOpen?: boolean } = {}
      // `isVenue: true` is answered 400 here and not served: a Venue posts what an hour costs, and
      // opening one is `PUT /v1/parcels/:id/venue` below. `false` still closes one, terms and all.
      if (typeof body['isVenue'] === 'boolean') flags.isVenue = body['isVenue']
      if (typeof body['isWorkshop'] === 'boolean') flags.isWorkshop = body['isWorkshop']
      if (typeof body['gateOpen'] === 'boolean') flags.gateOpen = body['gateOpen']
      const parcel = await setParcelFlags(ctx.sql, id, subject, flags)
      return { status: 200, body: { parcel } }
    }),

    /* ------------------------------------------------------------------ a Venue's calendar */

    /**
     * Open a Venue, or re-price one. **`PUT`, because posting a rate is idempotent** — the same
     * body twice leaves the same Venue at the same rate, and there is no second Venue to create.
     *
     * The rate arrives as a decimal STRING through `parsePriceWei`, which demands `/^\d{1,78}$/`
     * before `BigInt`: `BigInt('')` is `0n`, and a missing rate silently becoming a free calendar
     * is the precise defect this whole feature exists to close. The database refuses zero as well.
     * This is the door; `tessera_venue_rate_is_positive` is the wall.
     */
    define('PUT', '/v1/parcels/:id/venue', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const body = await readJson(ctx.req)
      const rateWei = parsePriceWei(body['rateWei'], 'rateWei')
      const venue = await openVenue(ctx.sql, id, subject, rateWei)
      return { status: 200, body: { venue: serialiseVenue(venue) } }
    }),

    define('GET', '/v1/parcels/:id/venue', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TESSERA_READ_SCOPE)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const venue = await venueOf(ctx.sql, id)
      if (!venue) return errorReply(404, 'not_a_venue', 'that parcel is not a Venue', ctx.requestId)
      return { status: 200, body: { venue: serialiseVenue(venue) } }
    }),

    /**
     * Take an hour — or twelve — of a Venue's calendar, against an escrowed hold.
     *
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * **THE PRICE IS NOT IN THE BODY, AND THAT IS THE FEATURE.**
     *
     * `priceWei` used to be an argument to `bookVenue` with `price_wei >= 0` behind it, which
     * made a zero-price hold on somebody else's calendar legal. It is now read from the parcel —
     * `venueOf` — multiplied by the hours asked for, escrowed at that figure, and checked against
     * the owner's rate a third time by the database as the row lands. A body that sends a price
     * is ignored rather than refused, because there is no price to send.
     *
     * ── THE ORDER, AND THE ROLLBACK ─────────────────────────────────────────────────────────
     *
     * Reserve first, then write the booking: `bookings_open_holds_money` refuses an open booking
     * that names no hold, so the hold has to exist before there is anything to name it. That
     * leaves exactly one window — a reservation taken for a booking that then fails — and the
     * `catch` below is what closes it. **A hold that outlives its failed booking is the same
     * stranded EMBER this whole change exists to end**, arrived at from the other direction, and
     * a route that reserved and walked away on a 409 would have reintroduced it on the busiest
     * path in the feature (two people booking one slot).
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    define('POST', '/v1/parcels/:id/bookings', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const escrow = deps.escrow
      if (!escrow) return escrowUnconfigured(ctx)
      const body = await readJson(ctx.req)
      const slot = parseSlot(body['slot'])
      const hours = body['hours'] === undefined ? 1 : requireInteger(body, 'hours', 1, 12)

      const venue = await venueOf(ctx.sql, id)
      if (!venue) {
        return errorReply(404, 'not_a_venue', 'no such Venue, or it posts no rate', ctx.requestId)
      }
      const priceWei = venue.rateWei * BigInt(hours)

      // Keyed on the request rather than on the booking's natural key. A transport-level retry of
      // THIS request replays the same hold; a fresh attempt after a failure takes a fresh one,
      // which is what the rollback below needs — a key derived from (parcel, slot, booker) would
      // replay a hold this route had already released and attach a dead reservation to a booking.
      const hold = await escrow.reserve({
        subject,
        amountWei: priceWei,
        actor: `user:${subject.slice('user:'.length)}`,
        correlationId: ctx.requestId,
        idempotencyKey: `tessera:booking-hold:${ctx.requestId}`,
        description: `Hold ${priceWei} wei for ${hours}h on parcel ${id}`,
      })

      try {
        const { bookingId } = await bookVenue(ctx.sql, {
          parcelId: id,
          slot,
          hours,
          bookedBy: subject,
          escrowedWei: priceWei,
          reservationId: hold.reservationId,
          correlationId: ctx.requestId,
        })
        const booking = await findBooking(ctx.sql, bookingId)
        return { status: 201, body: { booking: booking ? serialiseBooking(booking) : { id: bookingId } } }
      } catch (err) {
        // Best effort, and the failure is LOGGED rather than swallowed or rethrown: the caller's
        // real error is the booking's, and an operator needs to know if a hold was left standing.
        try {
          await escrow.release(hold.reservationId, {
            actor: `user:${subject.slice('user:'.length)}`,
            correlationId: ctx.requestId,
            idempotencyKey: `tessera:booking-hold:${ctx.requestId}:rollback`,
            description: 'The booking this hold was taken for did not land',
          })
        } catch (releaseErr) {
          ctx.log.error('A BOOKING HOLD WAS LEFT STANDING — money is reserved for no booking', {
            reservationId: hold.reservationId,
            subject,
            parcelId: id,
            err: releaseErr,
          })
        }
        throw err
      }
    }),

    define('GET', '/v1/parcels/:id/bookings', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TESSERA_READ_SCOPE)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const bookings = await listBookingsOf(ctx.sql, id)
      return { status: 200, body: { bookings: bookings.map(serialiseBooking) } }
    }),

    /**
     * The hour was hosted: release the hold and pay the owner.
     *
     * **The owner settles, because the owner is the one who knows.** Only they can say the room
     * was opened, and only they are paid by it — a booker who could settle their own booking
     * could pay a Venue for an hour it never gave them, and a platform job that settled on a
     * timer would pay for every no-show the owner never turned up to.
     */
    define('POST', '/v1/bookings/:id/settle', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const escrow = deps.escrow
      if (!escrow) return escrowUnconfigured(ctx)
      const booking = await bookingFor(ctx, deps)
      if (booking.ownerSubject !== subject) {
        throw new ForbiddenError("a booking is settled by the Venue's owner")
      }
      const settled = await settleBooking(ctx.sql, escrow, {
        bookingId: booking.id,
        actor: `user:${subject.slice('user:'.length)}`,
        correlationId: ctx.requestId,
      })
      return { status: 200, body: { booking: serialiseBooking(settled) } }
    }),

    /**
     * The hour will not happen: release the hold and pay nobody.
     *
     * **Either party**, and deliberately without a deadline. A cancellation fee is a policy this
     * repository has not decided and must not invent in a route — §7's refusals are the shape
     * that decision would have to take — and until it is decided the honest behaviour is that the
     * money goes back. What is NOT optional is that it goes back: `bookings_terminal_frees_the_money`
     * means a cancelled booking that did not release has no representation.
     */
    define('POST', '/v1/bookings/:id/cancel', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const escrow = deps.escrow
      if (!escrow) return escrowUnconfigured(ctx)
      const booking = await bookingFor(ctx, deps)
      if (booking.ownerSubject !== subject && booking.bookedBy !== subject) {
        throw new ForbiddenError('a booking is cancelled by its booker or the Venue owner')
      }
      const cancelled = await cancelBooking(ctx.sql, escrow, {
        bookingId: booking.id,
        actor: `user:${subject.slice('user:'.length)}`,
        correlationId: ctx.requestId,
      })
      return { status: 200, body: { booking: serialiseBooking(cancelled) } }
    }),

    /* --------------------------------------------------------------------------- the Kiln */

    define('POST', '/v1/kiln/firings', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      if (deps.kilnConfigured === false) {
        // An unconfigured upstream is a SUPPORTED mode, and it answers 503 rather than 500: the
        // rest of the world still works, and a world you can walk around in with a cold Kiln is
        // better than a title that refuses to boot over one dependency.
        return errorReply(503, 'kiln_unconfigured', 'the Kiln is not configured here', ctx.requestId)
      }
      const body = await readJson(ctx.req)
      const prompt = requireString(body, 'prompt')
      const category = requireString(body, 'category')
      if (!isCategory(category)) throw new BadRequestError('category is not one of the twelve')
      const footprint = requireString(body, 'footprint')
      if (footprint !== '1x1' && footprint !== '2x2') {
        throw new BadRequestError('footprint is 1x1 or 2x2 — there are two, and §6.3 says why')
      }
      const object = await requestFiring(ctx.sql, {
        authorSubject: subject,
        prompt,
        category,
        footprint: footprint as Footprint,
        correlationId: ctx.requestId,
      })
      await deps.enqueueFiring?.(object.id, subject)
      deps.metrics.increment('tessera_firings_total', { footprint: object.footprint })
      // 202, like studio's own answer: the work is a leased job, not this request handler.
      return { status: 202, body: { object, statusUrl: `/v1/objects/${object.id}` } }
    }),

    define('GET', '/v1/objects/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TESSERA_READ_SCOPE)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('an object id is a uuid')
      const object = await findObject(ctx.sql, id)
      if (!object) return errorReply(404, 'not_found', 'no such object', ctx.requestId)
      return { status: 200, body: { object } }
    }),

    define('GET', '/v1/objects', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TESSERA_READ_SCOPE)
      const requested = ctx.url.searchParams.get('userId') ?? undefined
      const userId = isAdmin(principal) && requested ? requested : subjectUserId(principal, requested)
      return { status: 200, body: { objects: await listObjectsOf(ctx.sql, `user:${userId}`) } }
    }),

    define('POST', '/v1/parcels/:id/placements', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const parcelId = ctx.params['id'] ?? ''
      if (!UUID.test(parcelId)) throw new BadRequestError('a parcel id is a uuid')
      const parcel = await findParcel(ctx.sql, parcelId)
      if (!parcel) return errorReply(404, 'not_found', 'no such parcel', ctx.requestId)
      if (parcel.ownerSubject !== subject) throw new ForbiddenError('this parcel is not yours')

      const body = await readJson(ctx.req)
      const raw = body['placements']
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new BadRequestError('placements must be a non-empty array')
      }
      // THE WHOLE BATCH IS ONE TRANSACTION, which is what makes the deferred object-cap trigger
      // check once rather than once per object — and what makes a paste that is legal only as a
      // whole legal at all. §11.6.
      const placements = raw.map((entry) => {
        if (typeof entry !== 'object' || entry === null) {
          throw new BadRequestError('each placement is an object')
        }
        const p = entry as Record<string, unknown>
        const objectId = requireString(p, 'objectId')
        const facing = typeof p['facing'] === 'string' ? p['facing'] : 'canonical'
        if (!(FACINGS as readonly string[]).includes(facing)) {
          throw new BadRequestError('facing is canonical or mirrored — there are two, and §2.1 says why')
        }
        return {
          parcelId,
          objectId,
          x: requireInteger(p, 'x', 0, 127),
          y: requireInteger(p, 'y', 0, 127),
          facing: facing as Facing,
          placedBy: subject,
        }
      })
      const outcome = await placeObjects(ctx.sql, placements)
      return { status: 201, body: outcome }
    }),

    define('DELETE', '/v1/placements/:id', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a placement id is a uuid')
      await removePlacement(ctx.sql, id, subject)
      return { status: 204 }
    }),

    /* ------------------------------------------------------------------------- the economy */

    define('POST', '/v1/listings', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const body = await readJson(ctx.req)
      const objectId = requireString(body, 'objectId')
      // A decimal STRING, never a JSON number: Number.MAX_SAFE_INTEGER is about 9e15 and a single
      // EMBER is 1e18 wei. `parsePriceWei` requires /^\d{1,78}$/ before BigInt, so the
      // BigInt('') === 0n hazard — a missing amount becoming a free purchase — is unreachable
      // through this door rather than handled behind it.
      const priceWei = parsePriceWei(body['priceWei'])
      const royaltyBps = requireInteger(body, 'royaltyBps', 0, 10_000)

      // NOTE what is NOT read from the body: `platformFeeBps` and `settlementMode`. The fee is
      // read from `platform_terms` and the mode is always custodial. A parameter that exists only
      // to be refused is a parameter somebody will one day wire to an entitlement. §7.2, §8.5.
      const listing = await draftListing(ctx.sql, {
        objectId,
        sellerSubject: subject,
        priceWei,
        royaltyBps,
        correlationId: ctx.requestId,
      })
      return { status: 201, body: { listing: serialiseListing(listing) } }
    }),

    /**
     * Draft → live. The moment a creator's object becomes something another player can buy.
     *
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * **THE SELLER'S OWN TOKEN IS REQUIRED, AND A SERVICE PRINCIPAL IS REFUSED HERE RATHER THAN
     * QUIETLY SUBSTITUTED.**
     *
     * Every other write route in this service accepts a service token that names its user in
     * `x-user-id` (`requireUser`). This one cannot, and the reason is `micro-market`'s source:
     * `POST /v1/listings` takes the seller from the token (`market/src/server.ts`,
     * `subjectOf`) and market has no on-behalf-of lane. A service credential would
     * therefore create a listing whose seller is `service:tessera`, and market credits sale
     * proceeds to its own `sellerSubject` (`market/src/orders.ts`) — so the creator would be
     * paid nothing while every test passed.
     *
     * The honest answer is a 403 that says so. Silently listing under the wrong subject is the
     * failure; refusing to is not a limitation to apologise for.
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    define('POST', '/v1/listings/:id/activate', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind !== 'user') {
        throw new ForbiddenError(
          'the seller\'s own user token — micro-market takes the seller from the token and pays it',
        )
      }
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a listing id is a uuid')
      if (!deps.market) {
        // Absent is a supported mode, as it is for the Kiln. A world whose market is unconfigured
        // is one you can still walk around, build in and fire objects in; every other route works.
        return errorReply(503, 'market_unconfigured', 'listing to micro-market is not configured', ctx.requestId)
      }
      // The exact bytes the seller presented. Relayed, never re-minted — this service holds no
      // key that could mint a user token and must not behave as though it did.
      const sellerToken = bearerFrom(headerOf(ctx.req, 'authorization'))
      if (!sellerToken) throw new TokenError('no bearer token presented', 'missing')

      const listing = await deps.market.activate({
        listingId: id,
        sellerSubject: `user:${subjectUserId(principal)}`,
        sellerToken,
        correlationId: ctx.requestId,
      })
      return { status: 200, body: { listing: serialiseListing(listing) } }
    }),

    define('GET', '/v1/listings/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TESSERA_READ_SCOPE)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a listing id is a uuid')
      const listing = await findListing(ctx.sql, id)
      if (!listing) return errorReply(404, 'not_found', 'no such listing', ctx.requestId)
      return { status: 200, body: { listing: serialiseListing(listing) } }
    }),

    define('GET', '/v1/listings', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TESSERA_READ_SCOPE)
      const requested = ctx.url.searchParams.get('userId') ?? undefined
      const userId = isAdmin(principal) && requested ? requested : subjectUserId(principal, requested)
      const listings = await listListingsOf(ctx.sql, `user:${userId}`)
      return { status: 200, body: { listings: listings.map(serialiseListing) } }
    }),

    /* ------------------------------------------------------------ presence and discovery */

    /**
     * Found the `micro-community` community that governs this ward.
     *
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * **A USER TOKEN, AND AN ADMIN'S — BOTH HALVES ARE FORCED BY SOMEBODY ELSE'S SOURCE.**
     *
     * `micro-community` refuses a service token on its governance surface, in terms worth
     * quoting because they are right: "A service token is not 'close enough' on the governance
     * surface. It names no user, so there is no membership to check — and accepting one would
     * make every service in the estate a voting member of every community"
     * (`community/src/server.ts`, `authenticateUser`). And `POST /v1/communities` takes the owner
     * from the token, never from the body.
     *
     * So Tessera cannot found a ward's community with `TESSERA_SERVICE_CREDENTIAL`, and the
     * founder becomes the community's owner and first admin. A ward is platform-minted, so
     * founding its government is a platform act — which makes `isAdmin` the gate, and makes the
     * relayed token an operator's rather than any player's.
     *
     * What this route deliberately does NOT do is the point of it: no proposal, no vote, no
     * officer, no timelock, no treasury. Those exist in `micro-community` and Tessera consumes
     * their outcome as `community.proposal.executed` (`inbound.ts`). §10 — "keeps the change
     * count in `micro-community` at zero and puts the game logic in the game."
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    define('POST', '/v1/wards/:id/community', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind !== 'user') {
        throw new ForbiddenError(
          'a user token — micro-community refuses a service token on its governance surface',
        )
      }
      if (!isAdmin(principal)) throw new ForbiddenError('role:admin')
      const ward = await findWard(ctx.sql, ctx.params['id'] ?? '')
      if (!ward) return errorReply(404, 'not_found', 'no such ward', ctx.requestId)
      if (!deps.governance) {
        return errorReply(503, 'community_unconfigured', 'ward governance is not configured', ctx.requestId)
      }
      if (ward.communityId) {
        // Answered before the upstream is called. Creating a community and then discovering the
        // ward is taken would leave an orphan community owned by the operator who tried.
        return errorReply(
          409,
          'already_governed',
          `that ward is already governed by community ${ward.communityId}`,
          ctx.requestId,
        )
      }
      const founderToken = bearerFrom(headerOf(ctx.req, 'authorization'))
      if (!founderToken) throw new TokenError('no bearer token presented', 'missing')

      const bound = await deps.governance.found({ ward, founderToken, correlationId: ctx.requestId })
      return { status: 201, body: { ward: bound } }
    }),

    define('POST', '/v1/wards/:id/presence', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const ward = await findWard(ctx.sql, ctx.params['id'] ?? '')
      if (!ward) return errorReply(404, 'not_found', 'no such ward', ctx.requestId)
      const body = await readJson(ctx.req)
      const avatar = await arrive(ctx.sql, {
        wardId: ward.id,
        subject,
        x: requireInteger(body, 'x', 0, 255),
        y: requireInteger(body, 'y', 0, 255),
      })
      return { status: 200, body: { avatar } }
    }),

    define('DELETE', '/v1/wards/:id/presence', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const ward = await findWard(ctx.sql, ctx.params['id'] ?? '')
      if (!ward) return errorReply(404, 'not_found', 'no such ward', ctx.requestId)
      await depart(ctx.sql, ward.id, subject)
      return { status: 204 }
    }),

    define('POST', '/v1/parcels/:id/visits', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const body = await readJson(ctx.req)
      // The visitor is the AUTHENTICATED subject and is never read from the body. A body-supplied
      // visitor is synthetic footfall with extra steps, and footfall is half the ranking function.
      // The database refuses a non-`user:` subject as well (§8.6), so this is the first of two.
      await recordVisit(ctx.sql, {
        parcelId: id,
        visitorSubject: subject,
        dwellSeconds: requireInteger(body, 'dwellSeconds', 0, 86_400),
      })
      return { status: 204 }
    }),

    define('POST', '/v1/parcels/:id/beacons', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const body = await readJson(ctx.req)
      try {
        const beacon = await lightBeacon(ctx.sql, id, subject, requireString(body, 'headline'))
        return { status: 201, body: { beacon } }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('the limit is 3')) {
          throw new WorldError('beacon_rate_limited', message, 429)
        }
        throw err
      }
    }),

    /* ------------------------------------------------------------------------------- me */

    define('GET', '/v1/me/parcels', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      return { status: 200, body: { parcels: await listParcelsOf(ctx.sql, subject) } }
    }),

    /**
     * §8.2's three figures: what a player can spend, what is committed, and what is owed.
     *
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * **READ FROM THE LEDGER, NEVER FROM A COLUMN HERE, AND 503 RATHER THAN A ZERO.**
     *
     * There is no balance column anywhere in this service and there must not be one —
     * 04-domain-model §11, and `market/src/escrow.ts`'s warning about becoming a second ledger.
     * This route asks `micro-ledger` and reports what it says.
     *
     * `micro-tessera-web` refuses to print a digit it cannot obtain, on the grounds that "a zero
     * is `BigInt('')`". It is right, and this route is built to keep that refusal meaningful: an
     * unreachable or unconfigured ledger answers **503 with no figures**, never `0`. A player
     * looking at their own earnings must never be shown a confident zero that means "we did not
     * ask". The client can then say "unavailable" instead of "you have nothing", which are very
     * different sentences to read after selling something.
     *
     * Every amount is a decimal STRING on the wire, beside the Sparks the client prints — the
     * same shape `serialiseListing` uses, for the same reason: a JSON number is an IEEE 754
     * double and one EMBER is 10^18 wei.
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    define('GET', '/v1/me/balances', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      if (!deps.wallet) {
        return errorReply(
          503,
          'ledger_unconfigured',
          'balances are unavailable — this is not a balance of zero',
          ctx.requestId,
        )
      }
      let wallet: Wallet
      try {
        wallet = await deps.wallet(subject)
      } catch (err) {
        // Logged with the reason, answered without one. An upstream that is down is a 503, and
        // emphatically not a 200 carrying zeroes.
        ctx.log.error('the ledger could not be read; balances are unavailable', { err })
        return errorReply(
          503,
          'ledger_unavailable',
          'balances are unavailable — this is not a balance of zero',
          ctx.requestId,
        )
      }
      return {
        status: 200,
        body: {
          assetCode: ASSET,
          balances: {
            availableWei: wallet.availableWei.toString(),
            availableSparks: toSparks(wallet.availableWei).toString(),
            reservedWei: wallet.reservedWei.toString(),
            reservedSparks: toSparks(wallet.reservedWei).toString(),
            payoutDueWei: wallet.payoutDueWei.toString(),
            payoutDueSparks: toSparks(wallet.payoutDueWei).toString(),
          },
        },
      }
    }),

    /* ----------------------------------------------------------------------------- the inbox */

    /**
     * The inbound event webhook — the address every producer's relay delivers to.
     *
     * ══════════════════════════════════════════════════════════════════════════════════════
     * **THIS ROUTE DOES NOT CHECK THE SIGNATURE, AND THAT IS THE SECURITY PROPERTY.**
     *
     * `handleDelivery` does, over the RAW BYTES, before `JSON.parse` is reached — see the header
     * of `inbound.ts`. A second implementation here would be a second thing to keep correct,
     * and the way it would go wrong is known in advance: this handler would parse the body to
     * inspect it, re-serialise, and verify the MAC over bytes that are not the bytes that were
     * signed. `JSON.parse` then `JSON.stringify` is not the identity function, so every honest
     * delivery would be refused and the failure would look like a secret mismatch.
     *
     * So the ONLY thing this route does with the body is read it as raw bytes and hand it over
     * unparsed. `readRaw` returns a string rather than an object for exactly that reason, and
     * `handleDelivery`'s signature takes a string so that passing a re-serialised body is
     * unrepresentable rather than merely discouraged.
     *
     * **`inbound.ts` EXISTED, COMPLETE AND CORRECT, AND WAS WIRED TO NOTHING.** Until this
     * route it was referenced only by `outbox.test.ts` — a fully tested inbox that no producer
     * could reach, so `identity.user.deleted` had nowhere to arrive and a right-to-erasure
     * request changed nothing. A tested module is not a served route.
     * ══════════════════════════════════════════════════════════════════════════════════════
     */
    define('POST', '/v1/events', async (ctx, deps) => {
      const raw = await readRaw(ctx.req)
      const verdict = await handleDelivery(
        { sql: ctx.sql, logger: ctx.log, secrets: deps.eventAcceptSecrets },
        raw,
        {
          [SIGNATURE_HEADER]: headerOf(ctx.req, SIGNATURE_HEADER),
          [EVENT_ID_HEADER]: headerOf(ctx.req, EVENT_ID_HEADER),
        },
      )

      if (verdict.status === 403) {
        // The MAC is the credential, so a caller without it is refused rather than challenged —
        // `inbound.ts` has the argument. The message is the same whether the signature was
        // absent, expired or forged: telling an attacker which half failed tells them which half
        // to fix.
        return errorReply(403, 'bad_signature', 'the event signature did not verify', ctx.requestId)
      }
      if (verdict.status === 400) {
        return errorReply(400, 'malformed_envelope', verdict.detail, ctx.requestId)
      }
      // 200 processed/duplicate and 202 unregistered/ignored, passed through as the inbox judged
      // them. The 202s are NOT errors and must never become 4xx: an unsubscribed or unregistered
      // topic is a configuration fact the producer cannot fix by retrying, and a 4xx would make
      // its relay retry the same event for ever.
      return { status: verdict.status, body: { status: verdict.outcome } }
    }),
  ]
}

function escrowUnconfigured(ctx: RequestContext): Reply {
  return errorReply(
    503,
    'escrow_unconfigured',
    'a booking is an escrowed hold and no ledger is configured to take or release one',
    ctx.requestId,
  )
}

/** The booking named in `:id`, or a 404 — shared by settle and cancel so they cannot disagree. */
async function bookingFor(ctx: RequestContext, deps: ServerDeps): Promise<Booking> {
  const id = ctx.params['id'] ?? ''
  if (!UUID.test(id)) throw new BadRequestError('a booking id is a uuid')
  const booking = await findBooking(ctx.sql, id)
  if (!booking) throw new WorldError('not_found', 'no such booking', 404)
  return booking
}

/**
 * The start of a slot, as an instant.
 *
 * Only the SHAPE is checked here — that it is a string and a real date. That it is on the hour is
 * `bookings_slot_is_on_the_hour`'s job and is left to it: a second copy of that rule in this file
 * is a second thing to keep in step with the calendar, and the database's version is the one that
 * also holds for a backfill, a job and a psql prompt.
 */
function parseSlot(value: unknown): Date {
  if (typeof value !== 'string') throw new BadRequestError('slot must be an ISO-8601 string')
  const slot = new Date(value)
  if (Number.isNaN(slot.getTime())) throw new BadRequestError('slot must be an ISO-8601 instant')
  return slot
}

/** A Venue's terms on the wire. A decimal string, never a JSON number — §8.1. */
function serialiseVenue(venue: Venue): Record<string, unknown> {
  return {
    parcelId: venue.parcelId,
    wardId: venue.wardId,
    ownerSubject: venue.ownerSubject,
    rateWei: venue.rateWei.toString(),
    rateSparks: toSparks(venue.rateWei).toString(),
  }
}

/**
 * A booking on the wire.
 *
 * `releasedEntryId` and `settledEntryId` are published rather than kept internal, and that is the
 * point of them: they are the receipt. A booker looking at a cancelled booking can take
 * `releasedEntryId` to `GET /entries/:id` on the ledger and see their own money come back, which
 * is the difference between being told the hold was freed and being able to check.
 */
function serialiseBooking(booking: Booking): Record<string, unknown> {
  return {
    ...booking,
    priceWei: booking.priceWei.toString(),
    priceSparks: toSparks(booking.priceWei).toString(),
  }
}

/** A listing on the wire: every amount a decimal string, plus the Sparks the client prints. */
function serialiseListing(listing: {
  id: string
  objectId: string
  sellerSubject: string
  priceWei: bigint
  royaltyBps: number
  platformFeeBps: number
  settlementMode: string
  status: string
  split: { feeWei: bigint; royaltyWei: bigint; proceedsWei: bigint }
}): Record<string, unknown> {
  return {
    id: listing.id,
    objectId: listing.objectId,
    sellerSubject: listing.sellerSubject,
    priceWei: listing.priceWei.toString(),
    // Sparks is what the client PRINTS. It is not an asset code and it never appears in a ledger
    // posting — §8.1's rule, visible here as a display field beside the authoritative wei.
    priceSparks: toSparks(listing.priceWei).toString(),
    royaltyBps: listing.royaltyBps,
    platformFeeBps: listing.platformFeeBps,
    settlementMode: listing.settlementMode,
    status: listing.status,
    split: {
      feeWei: listing.split.feeWei.toString(),
      royaltyWei: listing.split.royaltyWei.toString(),
      proceedsWei: listing.split.proceedsWei.toString(),
      proceedsSparks: toSparks(
        listing.split.proceedsWei - (listing.split.proceedsWei % 1_000_000_000_000n),
      ).toString(),
    },
  }
}

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than
  // being a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

/**
 * The write lane: a person, or a service acting for a named person.
 *
 * A service token must carry `tessera:write` AND name the user in `x-user-id`. That pairing is
 * aetherholm's and emberkin's (`aetherholm/src/server.ts`, `emberkin/src/server.ts`),
 * and it is what lets a title act on a player's behalf without impersonating them — the same
 * shape studio offers Tessera in the other direction.
 */
async function requireUser(
  ctx: RequestContext,
  deps: ServerDeps,
): Promise<{ principal: Principal; subject: string }> {
  const principal = await authenticate(ctx, deps)
  if (principal.kind === 'service') {
    requireScope(principal, TESSERA_WRITE_SCOPE)
    const named = headerOf(ctx.req, 'x-user-id')
    if (!named || !UUID.test(named)) {
      throw new ForbiddenError('a service acting for a user must name them in x-user-id')
    }
    return { principal, subject: `user:${named}` }
  }
  return { principal, subject: `user:${subjectUserId(principal)}` }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function requireInteger(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestError(`${field} must be a whole number between ${min} and ${max}`)
  }
  return value
}

/**
 * The body as THE EXACT BYTES THE SOCKET CARRIED, decoded once as utf-8 and not parsed.
 *
 * For the inbox, and for nothing else. The MAC is computed over these bytes, so anything that
 * normalises them — parsing, re-serialising, trimming — destroys the only thing that can verify
 * the delivery. `readJson` below is the wrong tool for that surface no matter how convenient it
 * looks, which is why this is a separate function rather than a flag on that one.
 *
 * The same `MAX_BODY_BYTES` cap, applied before buffering rather than after, for the same reason
 * `readJson` applies it: an unbounded body is a memory exhaustion primitive, and this route is
 * reachable by anyone who can open a socket — the signature check happens after the read, because
 * there is nothing to check until the bytes are here.
 */
async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
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

function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? (reply.status === 204 ? '' : `${JSON.stringify(reply.body ?? {})}\n`)
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // Health and metrics answers are a point-in-time fact. A cached 200 from a replica that has
    // since gone unready is exactly the lie the lifecycle package exists to stop telling.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}


/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WAVE M5b: WHAT THIS MODULE MOUNTS INSIDE THE MERGED PROCESS
 *
 * micro-deploy `docs/service-merge-plan.md`. Everything above this line is the STANDALONE
 * listener, unchanged — the suites that drive `createServer` pass unchanged, which is the evidence
 * that the merge did not alter this module's own surface. Everything below is how the same route
 * table is mounted beside agora's and its sibling modules'.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The paths this module must NOT serve in the merged process.
 *
 * `/livez`, `/readyz` and `/metrics` exist on every module. Matching is FIRST-WINS, so a second
 * copy of each would be unreachable — a dead health endpoint that looks exactly like a live one.
 * agora's win, because it is the host and because Prometheus scrapes this target under agora's job.
 * `/readyz` still reports this module: it contributes probes to the host's one `Lifecycle`, which
 * is what makes one endpoint honest for every module's database.
 */
export const UNMOUNTED: ReadonlySet<string> = new Set(OPERATIONAL_ROUTES)

/** The webhook path this module serves STANDALONE. Several modules mount this exact path. */
export const EVENTS_PATH = '/v1/events'

/**
 * The webhook path this module serves INSIDE the merged process — and why it is not the bare one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **MODULES THAT MOUNT `POST /v1/events` DO NOT VERIFY WITH THE SAME KEY.**
 *
 * This module verifies an inbound delivery against `INBOUND_SIGNING_SECRET` — `env.inboundSigningSecrets`,
 * reaching `POST /v1/events` as `deps.eventAcceptSecrets`. That is a variable of its own, and it is
 * held SEPARATE from `OUTBOX_SIGNING_SECRET` (`env.outboxSigningSecret`), which this module reads
 * for the OPPOSITE direction — to SIGN what its own relay emits. The receiving key and the emitting
 * key are two different secrets by design, and this route reads only the receiving one.
 *
 * So the emberkin arrangement — verify ONCE at the shared route and fan out to every module that
 * subscribes — is not available here. It is honest in that process only because every module there
 * reads the SAME estate-wide secret. Here it would mean one module's key silently deciding for the
 * others: a delivery signed for one inbox would be refused, or worse, a delivery signed with a
 * different module's key would be accepted as this module's when this module's own listener would
 * have refused it.
 *
 * This is wave M2's finding at larger scale — "a CNAME moves a host, not a path" — and it takes
 * M2's answer. Each module serves its OWN suffixed path with its OWN key against its OWN inbox, so
 * a subscription row nobody re-pointed is a LOUD failure recorded in the producer's
 * `outbox_deliveries.last_error` rather than an erasure that quietly reaches the wrong database.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MOUNTED_EVENTS_PATH = '/v1/events/tessera'

/**
 * Routes this module must serve UNDER A NAMESPACE in the merged process, because their bare paths
 * collide with market's — which the public gateway routes to.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **MATCHING IS FIRST-WINS, SO THE PUBLIC OWNER MUST KEEP THE BARE PATH.** tessera's parcel
 * marketplace serves `/v1/listings`, `/v1/listings/:id` and `POST /v1/listings/:id/activate` — and
 * so does `market`, whose copies ARE the estate's public listings surface
 * (`deploy/gateway/dynamic/public-api.yml` routes `api.<apex>/v1/listings` → market). tessera has no
 * public router of its own, so it is the SECONDARY: its listing routes remount under
 * `/v1/tessera/…`, exactly as its event webhook remounts under `/v1/events/tessera`.
 * `mergedroutes.test.ts` proves the merged table has no shadow; tessera's own suites drive
 * `buildRoutes` and still see the bare paths, so its surface is unchanged. Re-pointing tessera's own
 * callers (tessera-web) onto the namespaced paths is the same deploy-side sweep the event split
 * needs; no in-estate service calls tessera's listings.
 *
 * ── AND THE TWO FROZEN CONTRACT PATHS, WHICH THIS FILE USED TO KEEP ──────────────────────────
 *
 * What stood here said `/v1/title` and `/v1/provision` were left as-is because no other module in
 * this process mounted them — "aetherholm arrives in the separate emberkin pod in M5d". M5d
 * arrived, aetherholm is a module of this same process, and the note was true only until it was.
 *
 * M5d moved AETHERHOLM's pair to `/aetherholm/v1/…` and left tessera's bare, on the estate's usual
 * rule: the module a caller already addresses keeps the path. That resolved the collision, and it
 * left a sharper edge than either title had alone.
 *
 * `worlds/src/titleclient.ts` composes a title's address as `new URL(base).pathname` + the frozen
 * suffix. A title registered at an ORIGIN-ONLY base URL — `http://agora:4000`, which is what every
 * row looked like before M5d and what a hand-written row will look like again — therefore asks for
 * the bare `/v1/title`. While ONE title still answers that path, such a row does not fail: it gets
 * a 200, and the descriptor of whichever title kept the path. A misconfigured registry row is
 * indistinguishable from a correct one, and the only symptom is that a player who paid for one
 * game is provisioned another.
 *
 * So tessera's pair moves too, and after this NO module in the process answers the bare paths.
 * That is the whole point of the change: the bare path becomes a 404, which is a row somebody
 * fixes in a minute, rather than a 200 nobody has any reason to look at. `mergedroutes.test.ts`
 * asserts the absence directly — the property is "nothing answers it", which no per-module case
 * can express.
 *
 * tessera has NO row in the `titles` registry today (read from the live estate on 2026-08-31:
 * aetherholm, emberkin and ninety-days-after are the three, and tessera is not among them), so
 * nothing has to be migrated in the same release the way aetherholm's row did. The day a row is
 * added it must name `http://agora:4000/tessera`.
 *
 * THE GATEWAY HALF IS NOT OPTIONAL, and it is the same rule as everywhere else: a remount inside
 * the process leaves the bytes on the wire unchanged. Both of tessera's routers carry a rewrite —
 * `deploy/scripts/check-remount-rewrites.py` derives that requirement from this very map, so it
 * fails until they do.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** The prefix this module's FROZEN title-contract paths carry inside the merged process. */
export const TITLE_MOUNT_PREFIX = '/tessera'

export const REMOUNTED_PATHS: Readonly<Record<string, string>> = Object.freeze({
  '/v1/listings': '/v1/tessera/listings',
  '/v1/listings/:id': '/v1/tessera/listings/:id',
  '/v1/listings/:id/activate': '/v1/tessera/listings/:id/activate',
  [TITLE_DESCRIPTOR_PATH]: `${TITLE_MOUNT_PREFIX}${TITLE_DESCRIPTOR_PATH}`,
  [PROVISION_PATH]: `${TITLE_MOUNT_PREFIX}${PROVISION_PATH}`,
})

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
 *
 * `POST /v1/events` becomes `MOUNTED_EVENTS_PATH`, and the three listing paths that collide with
 * market become their `REMOUNTED_PATHS` entries — merge-only rewrites, invisible to `buildRoutes`.
 */
export function mountableRoutes(deps: ServerDeps, sql: NetworkSql): readonly RouteSpec<Db>[] {
  return buildRoutes()
    .filter((route) => !UNMOUNTED.has(route.path))
    .map((route) => ({
      method: route.method,
      path:
        route.path === EVENTS_PATH
          ? MOUNTED_EVENTS_PATH
          : (REMOUNTED_PATHS[route.path] ?? route.path),
      sql,
      // `async` rather than a bare call, so a handler that throws SYNCHRONOUSLY is a rejected
      // promise the kernel's dispatch already catches rather than an exception escaping into it.
      handle: async (ctx: KernelContext<Db>): Promise<Reply> => await handle(route, ctx, deps),
    }))
}
