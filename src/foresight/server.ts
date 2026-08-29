/**
 * The HTTP surface.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THERE IS NO ROUTE HERE THAT MOVES MONEY, HOLDS MONEY, OR COULD.**
 *
 * A stake goes wallet → contract. What this service offers is `POST /markets/:id/stake-intent`,
 * which answers with the contract address, the calldata and the policy verdict — everything a
 * wallet needs to build a transaction it will sign itself. The EMBER never comes near this process,
 * and there is no code path by which it could: nothing here has a key.
 *
 * `POST /markets/:id/deploy` and `/resolve` answer **202** with a status URL and reach no chain.
 * `micro-mint`'s rule, for its reason: a rolling deploy kills a request mid-flight, and the bad
 * landing is between a broadcast and the write that records it. A 202 is not a nicety — it is the
 * only shape in which the work can survive the process that started it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The one decision that is easy to get backwards is the auth-fault mapping. A bad token is 401. A
 * verifier that could not reach the JWKS is **503**, never 401 — answering 401 there signs every
 * user in the estate out because identity is having a bad minute.
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
  requireAdmin,
  statusFor,
  type Principal,
  type Verifier,
} from '@cloudsforge/auth'
import type { Network } from '@cloudsforge/contracts-chain'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { NetworkUnknownError, requestNetwork } from '@cloudsforge/http'
import type { NetworkSql } from '@cloudsforge/db'
import type { JobQueue } from '@cloudsforge/jobs'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { CATEGORIES, CATEGORY_VERSION, REFUSALS } from './categories.ts'
import type { ChainId } from './chains.ts'
import { callData } from './evm.ts'
import {
  IdeaError,
  approveIdea,
  discardIdea,
  editIdea,
  findIdea,
  ideaView,
  insertIdea,
  listIdeas,
  setIdeaImage,
} from './ideas.ts'
import { ImageError, parseImageReference } from './images.ts'
import {
  IdempotencyInFlightError,
  IdempotencyKeyReuseError,
  requestFingerprint,
  withIdempotency,
} from './idempotency.ts'
import { MARKET_DEPLOY, RESOLUTION_POST } from './jobs.ts'
import {
  MarketError,
  approveMarket,
  createDraft,
  documentFor,
  findMarket,
  listMarkets,
  openMarket,
  publicView,
  setMarketImage,
  voidMarket,
  type MarketStatus,
} from './markets.ts'
import { poolOf, positionOf } from './mirror.ts'
import {
  CustodialStakeError,
  acceptStake,
  custodialPoolOf,
  custodialPoolView,
  custodialPositionOf,
  escrowPostings,
  findStakeAsset,
  findStakeByKey,
  listStakeAssets,
  quoteStake,
  quoteView,
  recordEscrowEntry,
  stakeDisclosure,
  stakeIdempotencyKey,
} from './custodialstakes.ts'
import { POOL_ASSET, StakeAssetError, parseStakeAssetCode } from './stakeassets.ts'
import { RateUnavailableError, type PricingClient } from './pricingclient.ts'
import { LedgerRefusedError, LedgerUnavailableError, type LedgerClient } from './ledgerclient.ts'
import { canonicalDocument } from './questiondoc.ts'
import { withOutbox, type Db } from './outbox.ts'
import type { PolicyClient } from './policyclient.ts'
import { SeedPolicyUnavailableError, type EngagementPolicyClient } from './adminapiclient.ts'
import {
  HouseSeedError,
  SEED_PER_DAY_CEILING_WEI,
  SEED_PER_MARKET_CEILING_WEI,
  findHouseSeed,
  houseSeedView,
  planHouseSeed,
  recordHouseStake,
  seedsPlannedTodayWei,
} from './houseseed.ts'
import {
  ResolutionError,
  findResolutionByMarket,
  planResolution,
  resolutionLeaseKey,
  resolutionView,
  type SourceProbe,
} from './resolve.ts'
import type { RequestContext as KernelContext, RouteSpec } from '../kernel.ts'

export interface ServerDeps {
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
  /** Boot-time value; `forRequest` replaces it. An enqueue is a WRITE, so the queue is per-network. */
  readonly queue: JobQueue
  readonly queueFor: (network: Network) => JobQueue
  readonly verifier: Verifier
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly policy: PolicyClient
  readonly sourceProbe: SourceProbe
  readonly producer: string
  readonly chain: ChainId
  /**
   * The boot-time default, from `FORESIGHT_NETWORK`. `forRequest` replaces it with the network the
   * gateway stamped.
   *
   * Not a label: it selects the CHAIN a market is proposed and resolved on, and it is half of the
   * lease key that stops two replicas posting the same resolution. A pod serving both estates has
   * no process-wide answer to "which chain am I on".
   */
  readonly network: Network
  readonly defaultFeeBps: number
  readonly defaultDisputeWindowSeconds: number
  /**
   * The published platform address the house seed is staked from — 21 §5. Undefined is a
   * supported mode: this deployment runs no engagement programme and approving with a seed
   * refuses, plainly.
   */
  readonly houseAddress: string | undefined
  /**
   * admin-api's engagement policy, read at approval time to validate a requested seed against
   * the operator caps. Null when `ADMIN_API_URL` is unset — the same supported mode. See
   * `adminapiclient.ts` for the recorded decision and the fail-closed rule.
   */
  readonly engagementPolicies: EngagementPolicyClient | null
  /**
   * The rate source for a stake denominated in something other than EMBER. Fail-closed: an
   * unreadable rate refuses the stake rather than guessing one — `pricingclient.ts`.
   */
  readonly pricing: PricingClient
  /**
   * Where a custodial stake's money actually moves. This service holds no balances; the ledger
   * does, and a custodial stake is an entry there.
   */
  readonly ledger: LedgerClient
  /**
   * The published platform address a custodial market position is staked from on chain — the
   * house seed's arrangement, for the house seed's reason (`houseseed.ts`, and
   * `custody/src/gates.ts`, which does not sign for a user and must not learn to).
   *
   * Undefined is the ORDINARY case, and no longer switches custodial staking off.
   *
   * It used to. `custodialStakingAvailable` was `custodialAddress !== undefined`, the variable was
   * unset on both networks, and the consequence was the report that started this work: the only
   * way to take a side on Forge Foresight was to install a browser wallet. The variable was unset
   * deliberately — until migration 12 there was no route out of custodial escrow, so setting it
   * would have taken a stranger's coins with no way to give them back.
   *
   * There is one now, and it never touches the chain: a custodial stake is settled in the ledger
   * against the outcome the market resolved to on chain (`custodialstakes.ts`, state `paid`). So
   * this address is not what makes custodial staking possible and never was — the ledger is. When
   * it is set the accepted stake records it, and the on-chain aggregate, if it is ever built, has
   * its evidence. When it is unset the column is null, which migration 13 permits.
   */
  readonly custodialAddress: string | undefined
  /**
   * The browser-reachable origin of micro-studio, for composing an image's `bytesUrl`. Undefined
   * is a supported mode and `image.bytesUrl` is then null — `env.ts` carries the argument for why
   * this is a separate variable from tessera's server-to-server `STUDIO_URL`.
   */
  readonly studioPublicUrl: string | undefined
  readonly beforeScrape?: () => Promise<void>
  readonly now?: () => Date
}

/** Domain metrics, declared rather than inferred from a log line — AD-20. */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'foresight_deploys_total',
      help: 'Market deploys reaching a terminal state, by outcome.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'foresight_deploys_broadcast_total',
      help: 'Creations that reached a node. Counted at the broadcast, not at the confirmation.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_deploys_stuck_total',
      help: 'Deploys broadcast and unconfirmed past the stuck threshold. An operator queue, not an error.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_resolutions_total',
      help: 'Oracle posts reaching a terminal state, by outcome.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'foresight_resolutions_broadcast_total',
      help: 'Resolver creations that reached a node.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_custodial_stakes_total',
      help: 'Custodial stakes by outcome. `policy_degraded` means policy was unreachable and staking refused.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'foresight_custodial_settlements_total',
      help:
        'Markets whose custodial pool was settled, by what happened: `paid` divided the losers ' +
        'among the winners, `void_refund` gave everything back, `no_winner_refund` did too ' +
        'because nobody backed the winning outcome. Never registering it is not free — the ' +
        'telemetry client DROPS a write to an unregistered name, so the only exit from escrow ' +
        'would have been invisible.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'foresight_markets_closed_total',
      help: 'Markets closed by the close job. Bookkeeping: the contract closes itself.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_markets_resolved_total',
      help: 'Markets recorded as resolved after the chain accepted the outcome.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_markets_voided_total',
      help: 'Markets voided. A missing named source shows up here, and refunds are whole.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_idea_runs_total',
      help: 'Idea pipeline runs by outcome. `not_configured` is a supported mode, not a fault.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'foresight_proposals_stored_total',
      help: 'Model proposals stored for an operator to judge. None of them can open a market.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_proposals_dropped_total',
      help: 'Model proposals refused at the gate, by reason. A rising `bad_category` means the prompt drifted.',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      name: 'foresight_mirror_syncs_total',
      help: 'Mirror passes completed.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_mirror_errors_total',
      help: 'Mirror passes that could not reach the indexer. The pool then reads `as of` an older block.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_stake_intents_total',
      help: 'Stake intents by policy verdict. `degraded` means policy was unreachable and staking refused.',
      kind: 'counter',
      labels: ['verdict'],
    })
    // ────────────────────────────────────────────────────────────────────────────────────────────
    // **THE TWO SERIES THAT WOULD HAVE CAUGHT THE SCHEDULE DYING.**
    //
    // Every recurring handler used to re-enqueue its own `(kind, key)`, which `JobRunner.complete`
    // then deleted — so this service's `jobs` table was empty minutes after every boot and every
    // background job had silently stopped. `jobs_pending: 0` could not report it: an empty queue is
    // also what a healthy idle service looks like. These two can, because they are a comparison
    // rather than a level. `present < expected` means a recurring job that must exist does not.
    // Sampled in `index.ts`'s `beforeScrape` against the same `recurringJobs` table the seed uses.
    // ────────────────────────────────────────────────────────────────────────────────────────────
    .register({
      name: 'foresight_jobs_recurring_present',
      help: 'Recurring jobs currently in the table. Below `expected` means the schedule has stopped.',
      kind: 'gauge',
      // `network`, added by wave M5b. This deployment holds a `jobs` table per estate, and sampled
      // without the label the second plane's `set` REPLACES the first's — so a testnet schedule that
      // has stopped would be invisible behind mainnet's healthy count.
      labels: ['network'],
    })
    .register({
      name: 'foresight_jobs_recurring_expected',
      help: 'How many recurring jobs this build defines. The denominator for the gauge above.',
      kind: 'gauge',
      labels: ['network'],
    })
    // ────────────────────────────────────────────────────────────────────────────────────────────
    // **WHETHER THIS PROCESS CAN AUTHENTICATE TO ITS PEERS RIGHT NOW.**
    //
    // The question that had no answer anywhere in the estate while a ten-minute token was quietly
    // dying inside a fifteen-second leased job. Sampled from what the provider already holds rather
    // than by dialling identity: a probe that dialled would multiply readiness traffic by the
    // replica count into the one service it can least afford to amplify a fault in.
    //
    // 0 when there is no credential at all, so the series exists in that deployment too — an absent
    // metric is indistinguishable from a scrape that failed, and this is the one condition that must
    // not be silent.
    // ────────────────────────────────────────────────────────────────────────────────────────────
    .register({
      name: 'foresight_service_token_usable',
      help: 'Can this process present a live service token? 0 means every upstream call will 401.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'foresight_service_token_static',
      help: '1 when the credential is a pre-minted 600s token nothing can renew — the ten-minute cliff.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'foresight_service_token_events_total',
      help: 'Service-token provider events by kind: minted, exchange_failed, reminted_after_401, replay_skipped.',
      kind: 'counter',
      labels: ['kind'],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 64 * 1024
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
/** The stake amount, as a positive decimal string of whole EMBER. Never a JSON number. */
const DECIMAL = /^(?!0+(\.0+)?$)\d{1,20}(\.\d{1,18})?$/

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
  readonly headers?: Record<string, string>
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
  /** Used verbatim as the metric label, so cardinality is bounded by the number of routes. */
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

/**
 * Compile `/markets/:id/deploy` into a matcher. The segment pattern excludes `/` so a parameter
 * cannot swallow the rest of the path and make one route answer for another.
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
    // `forRequest` is resolved HERE, not on the dispatch line, and that placement is the whole
    // point. It rebuilds this request's domain objects, and in the services that bulkhead their
    // job queues it reaches a per-network plane that throws just as hard as the handle does.
    // One line lower it was OUTSIDE this try and still synchronous — so the throw was an
    // unhandled exception in a request listener, and node exits on those. The pod died on the
    // first request naming a network it did not hold, and its replacement died on the next one.
    let sql: Db
    let scoped: ReturnType<typeof forRequest>
    try {
      sql = deps.sql.for(network) as unknown as Db
      scoped = forRequest(deps, network)
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
    void handle(matched, { req, url, requestId, log, params, network, sql }, scoped)
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
 * Map every failure onto a status, grouped by what the caller should do about it.
 *
 *   * **400** — the request could not be legal. Fix it; retrying will not help.
 *   * **403** — a scope, a role, or a policy verdict.
 *   * **404** — something named does not exist.
 *   * **409** — well formed, but the state refuses it: a market already open, a proposal already
 *     decided, an idempotency key reused with a different body.
 *   * **503** — an upstream is unreachable, INCLUDING policy. Retrying IS the right response, which
 *     is what 503 tells a client and 500 does not.
 */
/**
 * The deps a REQUEST sees.
 *
 * Two things move: the queue, because an enqueue is a write, and the NETWORK, because it selects
 * the chain a resolution is posted to AND forms half of `resolutionLeaseKey`. Sharing one key
 * across estates would let a mainnet resolution job suppress a testnet one as a duplicate.
 */
function forRequest(deps: ServerDeps, network: Network): ServerDeps {
  return { ...deps, network, queue: deps.queueFor(network) }
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
    if (err instanceof MarketError) {
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof HouseSeedError) {
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof SeedPolicyUnavailableError) {
      // FAIL CLOSED, with a retry hint — the stake-intent shape: the caps could not be read, so
      // no seed is planned, and the operator is told to try again rather than handed a default.
      ctx.log.warn('seed refused: admin-api engagement policy was unreachable', { err: err.message })
      return errorReply(
        503,
        'seed_policy_unavailable',
        'the engagement caps could not be read from admin-api; approving with a seed is refused until they can — retry shortly, or approve without a seed',
        ctx.requestId,
      )
    }
    if (err instanceof ResolutionError) {
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof StakeAssetError || err instanceof CustodialStakeError) {
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof RateUnavailableError) {
      // FAIL CLOSED. An unread rate is not a default one, and the alternative to refusing is
      // guessing at how much of somebody's money to take — `pricingclient.ts`.
      ctx.log.warn('stake refused: a rate was unreadable', { asset: err.assetCode, err: err.message })
      return errorReply(
        503,
        'rate_unavailable',
        `${err.message} — a stake cannot be priced in an asset the platform cannot quote; retry shortly`,
        ctx.requestId,
      )
    }
    if (err instanceof LedgerRefusedError) {
      // The ledger LOOKED at it and said no — an insufficient balance is this, and it is the
      // user's answer rather than an incident. Its own status is carried through rather than
      // flattened, so 'you do not have that much BTC' does not present as a platform fault.
      return errorReply(err.status, `ledger_${err.code}`, err.message, ctx.requestId)
    }
    if (err instanceof LedgerUnavailableError) {
      // We do not know whether the entry posted. The stake row exists in `accepted` with a null
      // escrow entry, which is the state the reconciler finishes — so this is a retry, not a loss.
      ctx.log.error('the ledger did not answer a stake', { err: err.message })
      return errorReply(
        503,
        'ledger_unavailable',
        'the stake was recorded but the ledger did not confirm it; retry with the same Idempotency-Key',
        ctx.requestId,
      )
    }
    if (err instanceof ImageError) {
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof IdeaError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'not_proposed' ? 409 : 400
      return errorReply(status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyKeyReuseError) {
      return errorReply(409, 'idempotency_key_reuse', err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyInFlightError) {
      return errorReply(409, 'idempotency_in_flight', err.message, ctx.requestId)
    }
    if (err instanceof BadRequestError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    if (err instanceof Error && err.name === 'ChainError') {
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
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      // 503 is what removes this replica from the balancer. A soft probe failure leaves the report
      // `degraded` but still ready: the indexer being down means the mirror is stale, and a stale
      // mirror is a page that says "as of" — not a reason to stop serving.
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        // A gauge that could not be sampled is a stale gauge. Failing the scrape instead would lose
        // every other metric too, and blind the dashboard at the moment it is needed.
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    /**
     * What this platform will run a market on, and what it refuses. **Public and unauthenticated.**
     *
     * A refusal list behind a token is a refusal list nobody can hold the platform to.
     */
    define('GET', '/categories', async () => ({
      status: 200,
      body: {
        version: CATEGORY_VERSION,
        categories: CATEGORIES,
        refusals: REFUSALS,
      },
    })),

    /**
     * Where a client uploads a header image, and what it may send. **Public and unauthenticated.**
     *
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **THIS EXISTS SO NO CLIENT EVER GUESSES micro-studio's ADDRESS.**
     *
     * `foresight-web/src/lib/foresight.ts` opens with the two defects this estate has actually
     * shipped, both of one kind — a client written against a surface somebody imagined rather than
     * the one the service registers. `micro-wallet` called `POST /v1/quotes` at a service that
     * serves `/rates`; `micro-market` called a `/v1` path at a service with no `/v1` routes at all,
     * and every listing 403'd. A browser that derived `https://studio.<apex>` from its own hostname
     * would be the third: `studio` has no row in the `@cloudsforge/ui` surfaces registry, so there
     * is no registry answer to derive FROM, and the guess would be a hostname nobody has published.
     *
     * The deployment knows its own studio address because it was configured with it. So it says so,
     * once, here, and the client reads it. `studioUrl` is null when `STUDIO_PUBLIC_URL` is unset —
     * which is a real answer ("this deployment cannot serve images from here") that a client can
     * render as a sentence, rather than a broken upload control.
     *
     * Unauthenticated because everything in it is public by construction: a hostname meant to be
     * typed into a browser, a path published in studio's own API, and a list of media types.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    define('GET', '/image-config', async (_ctx, deps) => ({
      status: 200,
      body: {
        studioUrl: deps.studioPublicUrl ?? null,
        // studio's own spelling (`studio/src/server.ts`), not a path composed here.
        uploadPath: '/v1/uploads',
        // ── `public`, and it is not a default worth changing ─────────────────────────────────
        // studio's `GET /v1/assets/:id/bytes` requires NO Authorization header when the asset is
        // public, and requires one when it is private. A browser sends no bearer token on an
        // `<img src>`, so a private asset is a broken picture on every page in the estate. A
        // market's header image is shown on a public page to anonymous readers by definition.
        visibility: 'public',
        // ── A CONVENIENCE FOR THE FILE PICKER, NOT A SECURITY CONTROL ────────────────────────
        // This list belongs in the `accept` attribute so a user is not offered files that will be
        // refused. It decides nothing: studio reads the MAGIC BYTES and is the only thing that
        // decides what an upload is. A caller can send any bytes under any name, and does.
        accept: ['image/png', 'image/jpeg', 'image/webp'],
      },
    })),

    /* ---------------------------------------------------------------- public reads */

    define('GET', '/markets', async (ctx, deps) => {
      const requested = ctx.url.searchParams.get('status')
      const status = requested === null ? null : parseStatus(requested)
      const limit = parseLimit(ctx.url.searchParams.get('limit'))
      const markets = await listMarkets(ctx.sql, status, limit)
      // The image reference is composed per response rather than stored composed, so a deployment
      // that gains a public studio address starts serving usable `bytesUrl`s without a backfill.
      return {
        status: 200,
        body: { markets: markets.map((market) => publicView(market, deps.studioPublicUrl)) },
      }
    }),

    /**
     * One market, with everything a bettor needs to judge it.
     *
     * The cited sources are here, and so is the canonical document and its hash — so a reader can
     * recompute `questionHash` themselves and check it against the contract, rather than taking the
     * platform's word that the criteria have not been edited since it opened.
     */
    define('GET', '/markets/:id', async (ctx, deps) => {
      const id = uuidParam(ctx, 'id')
      const market = await findMarket(ctx.sql, id)
      if (!market) return errorReply(404, 'not_found', 'no market with that id', ctx.requestId)
      const pool = await poolOf(ctx.sql, id, market.chain as ChainId)
      // The OTHER book on the same question — see `custodialPoolView`. Served beside `pool` and
      // never folded into it: a reader staking from their CloudsForge balance is paid out of this
      // one, and until it was on the wire the page showed them a market they had staked on
      // reading `0` on both sides.
      const custodialPool = custodialPoolView(await custodialPoolOf(ctx.sql, id))
      const idea = market.ideaId ? await findIdea(ctx.sql, market.ideaId) : null
      // The house seed DISCLOSURE — 21 §5's sentence, served whenever a house stake exists
      // (21 §7.6), with the composed sentence, the amounts, the address and the evidence hashes.
      // Serving it is phase 1; foresight-web rendering it "with force" is the recorded later
      // client pass.
      const houseSeed = await findHouseSeed(ctx.sql, id)
      return {
        status: 200,
        body: {
          market: publicView(market, deps.studioPublicUrl),
          pool,
          custodialPool,
          houseSeed: houseSeed ? houseSeedView(houseSeed) : null,
          document: {
            canonical: canonicalDocument(documentFor(market)),
            hash: market.questionHash,
          },
          // The provenance, shown. §2.3.3: "sources are carried through to the public market page,
          // so a bettor can see *why* the market exists."
          provenance: idea
            ? {
                origin: idea.origin,
                searchQuery: idea.searchQuery,
                sources: idea.sources,
                modelId: idea.modelId,
                promptSha256: idea.promptSha256,
                proposedAt: idea.proposedAt.toISOString(),
              }
            : null,
        },
      }
    }),

    define('GET', '/markets/:id/positions/:address', async (ctx, deps) => {
      const id = uuidParam(ctx, 'id')
      const address = ctx.params['address'] ?? ''
      if (!EVM_ADDRESS.test(address)) throw new BadRequestError('address must be a 20-byte hex address')
      const market = await findMarket(ctx.sql, id)
      if (!market) return errorReply(404, 'not_found', 'no market with that id', ctx.requestId)
      const position = await positionOf(ctx.sql, id, address)
      const pool = await poolOf(ctx.sql, id, market.chain as ChainId)
      return {
        status: 200,
        body: {
          marketId: id,
          address,
          position,
          // Repeated here deliberately. A portfolio page that shows a number without saying when it
          // was true is the page that makes somebody think the mirror is the ledger.
          asOf: pool.asOf,
          stale: pool.stale,
          contractAddress: market.contractAddress,
        },
      }
    }),

    /* ---------------------------------------------------------------- staking */

    /**
     * Everything a wallet needs to stake, and **not one wei passes through here.**
     *
     * The answer is the contract address, the calldata, and the policy verdict. The user's wallet
     * builds, signs and sends the transaction. This service could be switched off between this
     * response and the send, and the stake would still work.
     *
     * The policy gate is FAIL CLOSED — see `policyclient.ts`. If policy cannot be reached, this
     * answers 503 and no intent is issued.
     */
    define('POST', '/markets/:id/stake-intent', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const amount = requireDecimal(body, 'amount')
      const outcome = requireInteger(body, 'outcome', 0, 1)

      const market = await findMarket(ctx.sql, id)
      if (!market) return errorReply(404, 'not_found', 'no market with that id', ctx.requestId)
      if (market.status !== 'open' || !market.contractAddress) {
        return errorReply(409, 'not_open', `this market is ${market.status}`, ctx.requestId)
      }
      const now = (deps.now ?? (() => new Date()))()
      if (market.closeTime.getTime() <= now.getTime()) {
        // The contract would refuse it anyway. Saying so here saves the user a failed transaction
        // and the gas that goes with it.
        return errorReply(409, 'closed', 'this market has reached its close time', ctx.requestId)
      }

      const verdict = await deps.policy.evaluateStake({
        subject: subjectOf(principal),
        marketId: id,
        amount,
        correlationId: ctx.requestId,
      })
      deps.metrics.increment('foresight_stake_intents_total', {
        verdict: verdict.degraded ? 'degraded' : verdict.decision,
      })
      if (verdict.degraded) {
        ctx.log.warn('stake refused: policy was unreachable', { marketId: id })
        return errorReply(
          503,
          'policy_unavailable',
          'staking is temporarily unavailable because the policy service could not be reached; retry shortly',
          ctx.requestId,
        )
      }
      if (verdict.decision === 'deny') {
        return errorReply(403, 'policy_denied', verdict.reasons.join(', ') || 'refused by policy', ctx.requestId)
      }

      return {
        status: 200,
        body: {
          marketId: id,
          chain: market.chain,
          network: market.network,
          to: market.contractAddress,
          // `stake(uint8)`, payable. The wallet sets `value` to the amount in wei; the service
          // deliberately does not compute that, because the wallet is what knows the user's
          // balance and what will actually be sent.
          data: callData('stake(uint8)', [{ type: 'uint8', value: BigInt(outcome) }]),
          outcome,
          amount,
          asset: 'EMBER',
          policy: { decision: verdict.decision, reasons: verdict.reasons, decisionId: verdict.decisionId },
          closeTime: market.closeTime.toISOString(),
        },
      }
    }),

    /* ------------------------------------------------- staking with something other than EMBER */

    /**
     * What a bettor may bring, and what each one costs them to bring.
     *
     * Public, and it lists the DISABLED assets too, with the reason. A user who arrived holding
     * Litecoin is owed the sentence "not yet, and here is what is missing" rather than a list that
     * silently omits it — that omission is what makes somebody think the platform has never heard
     * of their coin.
     */
    define('GET', '/stake-assets', async (ctx, deps) => {
      const assets = await listStakeAssets(ctx.sql)
      return {
        status: 200,
        body: {
          // Said once, at the top, because it is the fact everything below depends on: the pool is
          // one unit and it is this one. See `stakeassets.ts` for why the alternative was refused.
          poolAsset: POOL_ASSET,
          // TRUE, because the ledger is what settles a custodial stake — see `custodialAddress`
          // on Deps for the whole of why this used to read the address and was wrong to.
          custodialStakingAvailable: true,
          disclosure: stakeDisclosure(),
          assets: assets.map((asset) => ({
            assetCode: asset.assetCode,
            displayName: asset.displayName,
            decimals: asset.decimals,
            enabled: asset.enabled,
            blockedReason: asset.blockedReason,
          })),
        },
      }
    }),

    /**
     * Price a stake without taking it — what the stake screen shows before the user commits.
     *
     * **Not durable, deliberately.** A quote a client could hold and present later would be a free
     * option written by the platform: the user waits for the rate to move their way and then
     * spends it. The rate that binds is the one read at the moment the stake is taken, and it is
     * the one written on the row.
     */
    define('POST', '/markets/:id/stake-quote', async (ctx, deps) => {
      await authenticate(ctx, deps)
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const assetCode = parseStakeAssetCode(body['asset'])
      const amount = requireWei(body, 'amount')

      const market = await findMarket(ctx.sql, id)
      if (!market) return errorReply(404, 'not_found', 'no market with that id', ctx.requestId)
      if (market.status !== 'open') {
        return errorReply(409, 'not_open', `this market is ${market.status}`, ctx.requestId)
      }
      const asset = await findStakeAsset(ctx.sql, assetCode)
      if (!asset) {
        return errorReply(404, 'unknown_asset', `${assetCode} is not a stake asset`, ctx.requestId)
      }
      // BEFORE the rate is read, not after. `quoteStake` refuses a disabled asset too — but by
      // then a call has been spent on pricing, and pricing does not quote the assets that are
      // disabled *because* it does not quote them. The user would get 'the rate board is having a
      // bad minute' instead of 'this platform does not accept Litecoin yet, and here is why'.
      if (!asset.enabled) {
        return errorReply(
          409,
          'asset_disabled',
          asset.blockedReason ?? `${assetCode} is not currently accepted`,
          ctx.requestId,
        )
      }
      const rates = await deps.pricing.stakeRates(assetCode)
      const quote = quoteStake({ asset, stakeAmount: amount, rates })
      return { status: 200, body: { marketId: id, ...quoteView(quote) } }
    }),

    /**
     * Take a custodial stake.
     *
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **THIS IS THE ONE ROUTE IN THIS SERVICE THAT MOVES MONEY, AND IT MOVES IT IN THE LEDGER.**
     *
     * The file header used to say there was no such route, and for the self-custody path there
     * still is not — `stake-intent` hands a wallet some calldata and nothing else. But a BTC
     * holder has no EMBER key and custody will not sign for them
     * (`custody/src/gates.ts`, and widening it is refused), so their stake has to be an entry
     * in the ledger. No key is created here. Nothing here signs. The platform's aggregate position
     * reaches the chain from its own published address, afterwards, exactly as the house seed does.
     *
     * The order is: read the rate → write the row → post the entry. A crash after the row and
     * before the entry leaves an `accepted` stake with a null `escrow_entry_id`, which is a state
     * the operator can see and finish. The reverse order loses the reason for a movement of a
     * user's money, and there is no recovering that.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    define('POST', '/markets/:id/stakes', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind !== 'user') {
        return errorReply(
          403,
          'not_a_user',
          'a custodial stake belongs to a user; a service has no balance to stake',
          ctx.requestId,
        )
      }
      // No refusal here any more. There is nothing to be unconfigured: the stake is escrowed in
      // the ledger and settled from it, and `platformAddress` is recorded when the estate happens
      // to have one. A 503 on an unset variable was refusing a working path.
      const custodialAddress = deps.custodialAddress ?? null
      const id = uuidParam(ctx, 'id')
      const clientKey = idempotencyKeyOf(ctx)
      const body = await readJson(ctx.req)
      const assetCode = parseStakeAssetCode(body['asset'])
      const amount = requireWei(body, 'amount')
      const outcome = requireInteger(body, 'outcome', 0, 1)
      const subject = subjectOf(principal)

      // Namespaced by subject as well as by the client's key. Two users may legitimately send the
      // same key, and a key that did not carry the subject would answer the second one with the
      // first one's stake — somebody else's position, in somebody else's name.
      const key = `${subject}:${clientKey}`
      const existing = await findStakeByKey(ctx.sql, key)
      if (existing) {
        // A retry replays. It does NOT re-price: answering a retry at a moved rate is how one user
        // action becomes two trades — `wallet/src/money.ts`'s conversion makes the same argument
        // about the same failure.
        return {
          status: 200,
          body: { stake: stakeSummary(existing), replayed: true, disclosure: stakeDisclosure() },
        }
      }

      const market = await findMarket(ctx.sql, id)
      if (!market) return errorReply(404, 'not_found', 'no market with that id', ctx.requestId)
      const now = (deps.now ?? (() => new Date()))()
      if (market.status !== 'open') {
        return errorReply(409, 'not_open', `this market is ${market.status}`, ctx.requestId)
      }
      if (market.closeTime.getTime() <= now.getTime()) {
        return errorReply(409, 'closed', 'this market has reached its close time', ctx.requestId)
      }
      const asset = await findStakeAsset(ctx.sql, assetCode)
      if (!asset) {
        return errorReply(404, 'unknown_asset', `${assetCode} is not a stake asset`, ctx.requestId)
      }
      // Refused before policy and before pricing — see the same check on the quote route.
      if (!asset.enabled) {
        return errorReply(
          409,
          'asset_disabled',
          asset.blockedReason ?? `${assetCode} is not currently accepted`,
          ctx.requestId,
        )
      }

      // The same fail-closed policy gate the wallet path runs, in the same order, for the same
      // reason. A custodial stake is not a smaller act than a wallet stake.
      const verdict = await deps.policy.evaluateStake({
        subject,
        marketId: id,
        amount: amount.toString(),
        correlationId: ctx.requestId,
      })
      deps.metrics.increment('foresight_custodial_stakes_total', {
        outcome: verdict.degraded ? 'policy_degraded' : verdict.decision === 'deny' ? 'denied' : 'taken',
      })
      if (verdict.degraded) {
        return errorReply(
          503,
          'policy_unavailable',
          'staking is temporarily unavailable because the policy service could not be reached; retry shortly',
          ctx.requestId,
        )
      }
      if (verdict.decision === 'deny') {
        return errorReply(403, 'policy_denied', verdict.reasons.join(', ') || 'refused by policy', ctx.requestId)
      }

      const rates = await deps.pricing.stakeRates(assetCode)
      const quote = quoteStake({ asset, stakeAmount: amount, rates })

      const stake = await withOutbox(ctx.sql, deps.producer, async (tx) =>
        acceptStake(tx, {
          marketId: id,
          subject,
          outcome,
          quote,
          platformAddress: custodialAddress,
          idempotencyKey: key,
        }),
      )

      // The ledger is what refuses a stake larger than the balance — its overdraft trigger, on the
      // account that actually holds the number. A balance check here would be a second opinion
      // read a moment earlier, and the window between the two is the overdraft.
      let entry
      try {
        entry = await deps.ledger.postEntry({
          kind: 'market_escrow',
          actor: subject,
          correlationId: ctx.requestId,
          idempotencyKey: stakeIdempotencyKey(stake.id, 'escrow'),
          description: `Foresight stake on market ${id}`.slice(0, 200),
          postings: escrowPostings(stake),
        })
      } catch (err) {
        // ────────────────────────────────────────────────────────────────────────────────────
        // **A REFUSAL AND A SILENCE ARE OPPOSITE FACTS AND MUST NOT SHARE A PATH.**
        //
        // `LedgerRefusedError` is a 4xx: the ledger LOOKED at the entry and declined it, so no
        // money moved and this stake never happened. The row must go, because leaving it would
        // leave the idempotency key claimed — and a retry would then REPLAY a stake that does not
        // exist, telling the user they hold a position nobody ever took.
        //
        // `LedgerUnavailableError` is everything else, and there the row must STAY: we do not know
        // whether the entry posted, and the only safe answer is a retry on the same key. Deleting
        // here would free the key and let a second entry post against the same money.
        // ────────────────────────────────────────────────────────────────────────────────────
        if (err instanceof LedgerRefusedError) {
          await ctx.sql`delete from custodial_stakes where id = ${stake.id} and state = 'accepted'`
        }
        throw err
      }
      const recorded = await recordEscrowEntry(ctx.sql, stake.id, entry.id)

      return {
        status: 201,
        body: {
          stake: stakeSummary(recorded),
          quote: quoteView(quote),
          disclosure: stakeDisclosure(),
        },
      }
    }),

    /**
     * WHAT THE READER CAN ACTUALLY BET WITH — their own balances, per accepted stake asset.
     *
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * The stake panel used to offer a list of currencies and no numbers, so the only way to learn
     * you had none of something was to type an amount and be refused by the ledger. That is a
     * refusal arriving after the decision, which is the shape of every bad money screen.
     *
     * **It is a READ and it is never the thing that refuses a stake.** The ledger's own overdraft
     * trigger is, on the account that actually holds the number — see `POST /markets/:id/stakes`,
     * which deliberately does not check a balance first. A figure read here is a figure from a
     * moment ago; treating it as authority would put the window between the two reads inside the
     * overdraft it was supposed to prevent.
     *
     * A ledger that cannot be reached answers `degraded: true` and null amounts rather than 503.
     * The panel must still render: staking works without knowing the balance, and hiding the form
     * because a display figure is missing would turn a cosmetic outage into a functional one.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    define('GET', '/me/stake-balances', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind !== 'user') {
        return errorReply(
          403,
          'not_a_user',
          'a balance belongs to a user; a service holds none here',
          ctx.requestId,
        )
      }
      const subject = subjectOf(principal)
      const assets = await listStakeAssets(ctx.sql)
      let held: readonly { assetCode: string; purpose: string; amount: string; status: string }[] = []
      let degraded = false
      try {
        held = await deps.ledger.balances(subject)
      } catch (err) {
        if (!(err instanceof LedgerUnavailableError)) throw err
        degraded = true
        ctx.log.warn('stake balances unread: the ledger was unavailable', { err: err.message })
      }
      // `available` only. `escrow` is money already committed to a market and offering it as
      // spendable would invite somebody to stake the same coins twice.
      const spendable = new Map(
        held.filter((row) => row.purpose === 'available').map((row) => [row.assetCode, row.amount]),
      )
      return {
        status: 200,
        body: {
          poolAsset: POOL_ASSET,
          custodialStakingAvailable: true,
          degraded,
          assets: assets.map((asset) => ({
            assetCode: asset.assetCode,
            displayName: asset.displayName,
            decimals: asset.decimals,
            enabled: asset.enabled,
            blockedReason: asset.blockedReason,
            available: degraded ? null : (spendable.get(asset.assetCode) ?? '0'),
          })),
        },
      }
    }),

    /** One user's custodial position in a market. In the pool's unit, which is what they are paid in. */
    define('GET', '/markets/:id/custodial-position', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      const id = uuidParam(ctx, 'id')
      const position = await custodialPositionOf(ctx.sql, id, subjectOf(principal))
      return {
        status: 200,
        body: {
          marketId: id,
          // EMBER, on both sides, whatever was brought to buy it. This is the number that decides
          // a payout and it is the number the user is shown — see `stakeassets.ts` on why a
          // BTC-denominated position would be an FX guarantee nobody wrote.
          asset: POOL_ASSET,
          yes: position.yes.toString(),
          no: position.no.toString(),
          disclosure: stakeDisclosure(),
        },
      }
    }),

    /* ---------------------------------------------------------------- the idea queue */

    define('GET', '/ideas', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const status = ctx.url.searchParams.get('status') ?? 'proposed'
      if (status !== 'proposed' && status !== 'approved' && status !== 'discarded') {
        throw new BadRequestError('status must be proposed, approved or discarded')
      }
      const ideas = await listIdeas(ctx.sql, status, parseLimit(ctx.url.searchParams.get('limit')))
      return { status: 200, body: { ideas: ideas.map((idea) => ideaView(idea, deps.studioPublicUrl)) } }
    }),

    /** An operator writes a question themselves. The same validation the pipeline's output gets. */
    define('POST', '/ideas', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const body = await readJson(ctx.req)
      const now = (deps.now ?? (() => new Date()))()
      const idea = await insertIdea(
        ctx.sql,
        {
          question: requireString(body, 'question'),
          resolutionCriteria: requireString(body, 'resolutionCriteria'),
          category: requireString(body, 'category'),
          categoryVersion: CATEGORY_VERSION,
          resolutionSourceKind: requireString(body, 'resolutionSourceKind'),
          resolutionSourceRef: requireString(body, 'resolutionSourceRef'),
          suggestedCloseTime: requireDate(body, 'suggestedCloseTime'),
          origin: 'operator',
        },
        now,
      )
      return { status: 201, body: { idea: ideaView(idea, deps.studioPublicUrl) } }
    }),

    define('PATCH', '/ideas/:id', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const now = (deps.now ?? (() => new Date()))()
      const idea = await editIdea(
        ctx.sql,
        id,
        {
          question: requireString(body, 'question'),
          resolutionCriteria: requireString(body, 'resolutionCriteria'),
          category: requireString(body, 'category'),
          categoryVersion: CATEGORY_VERSION,
          resolutionSourceKind: requireString(body, 'resolutionSourceKind'),
          resolutionSourceRef: requireString(body, 'resolutionSourceRef'),
          suggestedCloseTime: requireDate(body, 'suggestedCloseTime'),
        },
        now,
      )
      return { status: 200, body: { idea: ideaView(idea, deps.studioPublicUrl) } }
    }),

    define('POST', '/ideas/:id/approve', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const now = (deps.now ?? (() => new Date()))()
      const idea = await approveIdea(ctx.sql, id, operatorOf(principal), optionalString(body, 'note') ?? null, now)
      return { status: 200, body: { idea: ideaView(idea, deps.studioPublicUrl) } }
    }),

    define('POST', '/ideas/:id/discard', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const now = (deps.now ?? (() => new Date()))()
      const idea = await discardIdea(
        ctx.sql,
        id,
        operatorOf(principal),
        requireString(body, 'refusalId'),
        optionalString(body, 'note') ?? null,
        now,
      )
      return { status: 200, body: { idea: ideaView(idea, deps.studioPublicUrl) } }
    }),

    /* ---------------------------------------------------------------- the market lifecycle */

    define('POST', '/markets', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const body = await readJson(ctx.req)
      const now = (deps.now ?? (() => new Date()))()
      const ideaId = optionalString(body, 'ideaId')
      if (ideaId !== undefined && !UUID.test(ideaId)) throw new BadRequestError('ideaId must be a uuid')
      const market = await createDraft(
        ctx.sql,
        {
          ...(ideaId !== undefined ? { ideaId } : {}),
          question: requireString(body, 'question'),
          resolutionCriteria: requireString(body, 'resolutionCriteria'),
          category: requireString(body, 'category'),
          resolutionSourceKind: requireString(body, 'resolutionSourceKind'),
          resolutionSourceRef: requireString(body, 'resolutionSourceRef'),
          closeTime: requireDate(body, 'closeTime'),
          disputeWindowSeconds:
            body['disputeWindowSeconds'] === undefined
              ? deps.defaultDisputeWindowSeconds
              : requireInteger(body, 'disputeWindowSeconds', 0, 30 * 86_400),
          feeBps:
            body['feeBps'] === undefined ? deps.defaultFeeBps : requireInteger(body, 'feeBps', 0, 1_000),
          network: deps.network,
          chain: deps.chain,
        },
        now,
      )
      return { status: 201, body: { market: publicView(market, deps.studioPublicUrl) } }
    }),

    /**
     * **A person approves.** The one act the state machine and the schema both insist on.
     *
     * The approval may carry `houseSeedPerOutcomeWei` — 21 §5's house seed, sized by the
     * approving operator and validated HERE against admin-api's engagement policy (the caps,
     * which 21 §8 says must exist before anything moves), fail closed, before the seed plan is
     * written in the same transaction as the approval. The schema's own ceilings hold whatever
     * this handler thinks (`house_seeds_within_market_ceiling`, `house_seeds_daily_ceiling`).
     */
    define('POST', '/markets/:id/approve', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const now = (deps.now ?? (() => new Date()))()

      let seedPerOutcomeWei: bigint | null = null
      if (body['houseSeedPerOutcomeWei'] !== undefined) {
        seedPerOutcomeWei = requireWei(body, 'houseSeedPerOutcomeWei')
        if (seedPerOutcomeWei <= 0n || seedPerOutcomeWei > SEED_PER_MARKET_CEILING_WEI) {
          return errorReply(
            400,
            'seed_out_of_range',
            `houseSeedPerOutcomeWei must be between 1 and ${SEED_PER_MARKET_CEILING_WEI} wei — the schema ceiling refuses more`,
            ctx.requestId,
          )
        }
        if (!deps.houseAddress) {
          return errorReply(
            409,
            'house_address_unconfigured',
            'this deployment has no FORESIGHT_HOUSE_ADDRESS, so it runs no house seeds; approve without one',
            ctx.requestId,
          )
        }
        if (!deps.engagementPolicies) {
          return errorReply(
            409,
            'seed_policy_unconfigured',
            'this deployment has no ADMIN_API_URL, so the engagement caps cannot be read and no seed may be planned (21 §8: nothing moves before the caps exist)',
            ctx.requestId,
          )
        }
        // FAIL CLOSED, the stake-intent discipline: an unreadable cap is not a permissive one.
        const policy = await deps.engagementPolicies.foresightSeedPolicy(ctx.requestId)
        if (policy === null) {
          return errorReply(
            409,
            'no_seed_policy',
            'admin-api holds no seed sizes for foresight — raise them through engagement.policy.set first (21 §6)',
            ctx.requestId,
          )
        }
        if (seedPerOutcomeWei > policy.perMarketWei) {
          return errorReply(
            409,
            'seed_above_policy',
            `a seed of ${seedPerOutcomeWei} wei per side exceeds the policy's per-market size of ${policy.perMarketWei}`,
            ctx.requestId,
          )
        }
        const plannedToday = await seedsPlannedTodayWei(ctx.sql)
        if (plannedToday + seedPerOutcomeWei > policy.perDayWei) {
          return errorReply(
            409,
            'seed_daily_cap',
            `today's seeds already total ${plannedToday} wei per side; adding ${seedPerOutcomeWei} would exceed the policy's per-day size of ${policy.perDayWei}`,
            ctx.requestId,
          )
        }
      }

      const houseAddress = deps.houseAddress
      const result = await withOutbox(ctx.sql, deps.producer, async (tx) => {
        const market = await approveMarket(tx, id, operatorOf(principal), now, ctx.requestId)
        const seed =
          seedPerOutcomeWei !== null && houseAddress
            ? await planHouseSeed(tx, { marketId: id, houseAddress, perOutcomeWei: seedPerOutcomeWei })
            : null
        return { market, seed }
      })
      return {
        status: 200,
        body: {
          market: publicView(result.market, deps.studioPublicUrl),
          houseSeed: result.seed ? houseSeedView(result.seed) : null,
        },
      }
    }),

    /**
     * Deploy the contract. **202, and it reaches no chain.**
     *
     * Idempotent on the client's key, and the key is what stops a retried request producing a
     * second contract. See `idempotency.ts` — the loss from a double-apply here is not a double
     * payment, it is two pools for one question.
     */
    define('POST', '/markets/:id/deploy', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const id = uuidParam(ctx, 'id')
      const key = idempotencyKeyOf(ctx)
      const market = await findMarket(ctx.sql, id)
      if (!market) return errorReply(404, 'not_found', 'no market with that id', ctx.requestId)
      if (market.status !== 'approved') {
        return errorReply(409, 'not_approved', `a market is deployed once approved; this one is ${market.status}`, ctx.requestId)
      }

      const outcome = await withIdempotency<Record<string, unknown>>(ctx.sql, {
        originatingService: deps.producer,
        route: 'POST /markets/:id/deploy',
        clientKey: key,
        requestHash: requestFingerprint({ marketId: id, correlationId: ctx.requestId }),
        run: async () => {
          await deps.queue.enqueue({
            kind: MARKET_DEPLOY,
            key: id,
            payload: { marketId: id },
            onConflict: 'earliest',
          })
          return { marketId: id, accepted: true }
        },
      })
      return {
        status: 202,
        body: { ...outcome.result, replayed: outcome.replayed },
        headers: { location: `/markets/${id}` },
      }
    }),

    /**
     * Open for stakes — and for a seeded market, ONLY once the house money is already in the
     * pool. `recordHouseStake` refuses unless the mirror shows exactly the planned symmetric
     * position from the house address, then records the stake with the market's open timestamp
     * in the same transaction; the `house_seeds` triggers hold both rules against any other
     * writer. So "open with a seed" is a fact about the pool, never an intention.
     */
    define('POST', '/markets/:id/open', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const now = (deps.now ?? (() => new Date()))()
      const result = await withOutbox(ctx.sql, deps.producer, async (tx, emit) => {
        const market = await openMarket(tx, emit, id, operatorOf(principal), now, ctx.requestId)
        const planned = await findHouseSeed(tx, id)
        const seed =
          planned && planned.state === 'planned'
            ? await recordHouseStake(tx, id, market.openedAt ?? now)
            : planned
        return { market, seed }
      })
      return {
        status: 200,
        body: {
          market: publicView(result.market, deps.studioPublicUrl),
          houseSeed: result.seed ? houseSeedView(result.seed) : null,
        },
      }
    }),

    /**
     * Resolve. **202** — the plan is written and the chain work is a leased job.
     *
     * The source check happens inside `planResolution`, and it can turn a `resolve` into a `void`.
     * That is not the caller being overruled; it is the rule the market was opened under.
     */
    define('POST', '/markets/:id/resolve', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const outcome = requireInteger(body, 'outcome', 0, 1)
      const resolution = await planResolution(ctx.sql, deps.sourceProbe, {
        marketId: id,
        outcome: outcome as 0 | 1,
        rationale: requireString(body, 'rationale'),
      })
      await deps.queue.enqueue({
        kind: RESOLUTION_POST,
        key: resolutionLeaseKey(deps.chain, deps.network),
        onConflict: 'earliest',
      })
      return {
        status: 202,
        body: {
          resolution: {
            id: resolution.id,
            marketId: resolution.marketId,
            action: resolution.action,
            rationale: resolution.rationale,
            state: resolution.state,
          },
        },
        headers: { location: `/markets/${id}/resolution` },
      }
    }),

    define('GET', '/markets/:id/resolution', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const id = uuidParam(ctx, 'id')
      const resolution = await findResolutionByMarket(ctx.sql, id)
      if (!resolution) return errorReply(404, 'not_found', 'no resolution has been planned', ctx.requestId)
      // Narrowed, never the row: the row carries a bigint nonce that JSON.stringify throws on, and
      // the raw transaction. See `resolutionView` for both defects.
      return { status: 200, body: { resolution: resolutionView(resolution) } }
    }),

    /**
     * Void off-chain, for a market that has no contract yet.
     *
     * A DEPLOYED market is voided on chain — `POST /markets/:id/resolve` produces a `void` action
     * when the source is gone, and an operator who wants to void a live market does it through the
     * same oracle path. This route exists for the case where there is nothing on chain to void, and
     * it refuses anything else rather than letting the database and the contract disagree.
     */
    define('POST', '/markets/:id/void', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const market = await findMarket(ctx.sql, id)
      if (!market) return errorReply(404, 'not_found', 'no market with that id', ctx.requestId)
      if (market.contractAddress) {
        return errorReply(
          409,
          'on_chain',
          'this market has a contract; void it through the oracle so the chain and the registry agree',
          ctx.requestId,
        )
      }
      const now = (deps.now ?? (() => new Date()))()
      const voided = await withOutbox(ctx.sql, deps.producer, async (tx, emit) =>
        voidMarket(tx, emit, id, requireString(body, 'reason'), operatorOf(principal), now, ctx.requestId),
      )
      return { status: 200, body: { market: publicView(voided, deps.studioPublicUrl) } }
    }),

    /* ---------------------------------------------------------------- the header image */

    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **NOTHING BELOW MAY DESCRIBE AN IMAGE AS VERIFIED, ATTESTED, ON-CHAIN OR ANCHORED.**
     *
     * These four routes sit in the same file as `stake-intent`, `deploy` and `resolve`, which
     * genuinely do reach a chain, and they answer with a `checksum` that looks exactly like the
     * `questionHash` two fields away. It is not the same kind of thing. `questionHash` is written
     * into a deployed contract and a bettor can recompute it; an image checksum is a value studio
     * measured and a client relayed here, which this service never re-measures. `images.ts` sets
     * out the full argument, including why the false version of this claim would be undetectable:
     * Hearth has no Registry of Authorship to check against (`tessera/src/kiln.ts` records
     * that the Solidity was never written) and studio's `anchor.state` is `'unanchored'` on every
     * asset it has produced.
     *
     * The strongest honest phrase is "hash recorded". The safest is to say nothing at all.
     *
     * ── AUTHORITY IS `requireAdmin`, AND THAT IS NOT A SHORTCUT ────────────────────────────────
     *
     * A market in this service has no user owner and cannot have one: `POST /markets` is
     * `requireAdmin`, `POST /markets/:id/approve` records an `operator:<id>` subject, and
     * `markets_unapproved_never_opens` refuses to let anything that is not one reach `open`. Ideas
     * are the same — the whole queue is behind `requireAdmin`. So "the owner may set the image"
     * resolves, here, to "an operator may", and every one of these routes uses the SAME
     * `requireAdmin` + `operatorOf` pair every other mutating route uses. Inventing a per-market
     * owner column so that this feature could have its own notion of ownership would be a second
     * authority model in a service that has one, and a second model is one that will disagree with
     * the first.
     *
     * A user with a token but no admin role therefore gets 403 from `requireAdmin`, which is the
     * "a non-owner cannot change somebody else's image" property in the shape this service can
     * actually state it.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */

    /**
     * Set a market's header image to an asset already uploaded to micro-studio.
     *
     * The bytes never pass through here. A client uploads to studio's
     * `POST /v1/uploads?visibility=public` — which is where every check lives: magic bytes, the SVG
     * refusal, the dimension bounds, the EXIF strip — and sends this route the id and checksum
     * studio answered with. `visibility=public` is not a detail: studio's bytes route needs no
     * Authorization header for a public asset, and a browser sends none on an `<img src>`.
     */
    define('PUT', '/markets/:id/image', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const image = parseImageReference(await readJson(ctx.req))
      const now = (deps.now ?? (() => new Date()))()
      const market = await withOutbox(ctx.sql, deps.producer, async (tx, emit) =>
        setMarketImage(tx, emit, id, image, operatorOf(principal), now, ctx.requestId),
      )
      return { status: 200, body: { market: publicView(market, deps.studioPublicUrl) } }
    }),

    /**
     * Remove a market's header image. Both columns go to null together — `markets_image_is_whole`.
     *
     * Deliberately available in EVERY status, `settled` and `void` included. See `setMarketImage`
     * for the reasoning; the short version is that a settled market's page is permanent, and a rule
     * forbidding removal there would fire only in the case where removal is most necessary.
     */
    define('DELETE', '/markets/:id/image', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const now = (deps.now ?? (() => new Date()))()
      const market = await withOutbox(ctx.sql, deps.producer, async (tx, emit) =>
        setMarketImage(tx, emit, id, null, operatorOf(principal), now, ctx.requestId),
      )
      return { status: 200, body: { market: publicView(market, deps.studioPublicUrl) } }
    }),

    define('PUT', '/ideas/:id/image', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const image = parseImageReference(await readJson(ctx.req))
      const now = (deps.now ?? (() => new Date()))()
      const idea = await withOutbox(ctx.sql, deps.producer, async (tx, emit) =>
        setIdeaImage(tx, emit, id, image, operatorOf(principal), now, ctx.requestId),
      )
      return { status: 200, body: { idea: ideaView(idea, deps.studioPublicUrl) } }
    }),

    define('DELETE', '/ideas/:id/image', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const now = (deps.now ?? (() => new Date()))()
      const idea = await withOutbox(ctx.sql, deps.producer, async (tx, emit) =>
        setIdeaImage(tx, emit, id, null, operatorOf(principal), now, ctx.requestId),
      )
      return { status: 200, body: { idea: ideaView(idea, deps.studioPublicUrl) } }
    }),
  ]
}

/* ------------------------------------------------------------------ helpers */

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than being
  // a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

/**
 * The `operator:<id>` subject an approval is recorded under.
 *
 * **A service principal cannot produce one.** `requireAdmin` has already run, so this is a user
 * token with the admin role; a service token would have been refused before it got here. That is
 * the transport half of "the AI proposes; a person opens" — `ideas.ts` and the schema are the other
 * two halves, and all three have to fail for a machine's proposal to reach `open`.
 */
function operatorOf(principal: Principal): string {
  if (principal.kind !== 'user' || !isAdmin(principal)) {
    throw new ForbiddenError('operator')
  }
  return `operator:${principal.userId}`
}

/**
 * What a stake looks like from outside.
 *
 * Both amounts and BOTH rates, always together. A response that carried the pool share without the
 * stake amount and the two rates would be a number the user could not check, and the whole point
 * of recording three values on the row is that the arithmetic is theirs to re-run.
 */
function stakeSummary(stake: {
  readonly id: string
  readonly marketId: string
  readonly outcome: number
  readonly stakeAssetCode: string
  readonly stakeAmount: bigint
  readonly poolAmount: bigint
  readonly rates: { readonly stakeUsdScaled: bigint; readonly poolUsdScaled: bigint }
  readonly state: string
  readonly createdAt: Date
}): Record<string, unknown> {
  return {
    id: stake.id,
    marketId: stake.marketId,
    outcome: stake.outcome,
    stakeAsset: stake.stakeAssetCode,
    stakeAmount: stake.stakeAmount.toString(),
    poolAsset: POOL_ASSET,
    poolAmount: stake.poolAmount.toString(),
    stakeRateUsdScaled: stake.rates.stakeUsdScaled.toString(),
    poolRateUsdScaled: stake.rates.poolUsdScaled.toString(),
    state: stake.state,
    createdAt: stake.createdAt.toISOString(),
  }
}

function subjectOf(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.userId}` : `service:${principal.service}`
}

/**
 * The client's idempotency key, required on the routes that can create a contract.
 *
 * Required rather than defaulted to the request id: a default derived per-attempt makes every retry
 * a fresh operation, which is the opposite of what the header is for.
 */
function idempotencyKeyOf(ctx: RequestContext): string {
  const key = headerOf(ctx.req, 'idempotency-key')
  if (!key || key.length < 8 || key.length > 200) {
    throw new BadRequestError('an Idempotency-Key header of 8 to 200 characters is required')
  }
  return key
}

function uuidParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name] ?? ''
  if (!UUID.test(value)) throw new BadRequestError(`${name} must be a uuid`)
  return value
}

function parseStatus(value: string): MarketStatus {
  const statuses = ['draft', 'approved', 'open', 'closed', 'resolved', 'settled', 'void']
  if (!statuses.includes(value)) throw new BadRequestError(`status must be one of ${statuses.join(', ')}`)
  return value as MarketStatus
}

function parseLimit(raw: string | null): number {
  if (raw === null) return 50
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new BadRequestError('limit must be a whole number between 1 and 200')
  }
  return value
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = optionalString(body, field)
  if (!value) throw new BadRequestError(`${field} is required`)
  return value
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
 * An amount, as a decimal STRING.
 *
 * A JSON number is refused rather than coerced. One EMBER is 1e18 wei, and `policy` refuses a
 * numeric amount for the same reason — a threshold comparison that has been through a double is a
 * comparison against a number nobody wrote.
 */
function requireDecimal(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new BadRequestError(`${field} must be a positive decimal string, not a number`)
  }
  return value
}

/**
 * A wei amount: a whole-number decimal string, up to numeric(78,0)'s reach. Distinct from
 * `requireDecimal`, whose 20-digit, fraction-tolerant shape fits whole-EMBER amounts headed for
 * policy — a wei ceiling is 22 digits, and a fraction of a wei is not a thing.
 */
function requireWei(body: Record<string, unknown>, field: string): bigint {
  const value = body[field]
  if (typeof value !== 'string' || !/^[0-9]{1,78}$/.test(value)) {
    throw new BadRequestError(`${field} must be a decimal string of wei, not a number`)
  }
  return BigInt(value)
}

function requireDate(body: Record<string, unknown>, field: string): Date {
  const value = body[field]
  if (typeof value !== 'string') throw new BadRequestError(`${field} must be an ISO-8601 string`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new BadRequestError(`${field} is not a valid instant`)
  return parsed
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive any
    // unauthenticated caller can reach.
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
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    ...(reply.headers ?? {}),
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // A pool and a health check are point-in-time facts. A cached 200 from a replica that has since
    // gone unready — or a cached pool from before a hundred EMBER arrived — is exactly the lie this
    // arrangement exists to stop telling.
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
 * micro-deploy `docs/service-merge-plan.md`. Everything above this line is the STANDALONE listener,
 * unchanged — `server.test.ts` drives it and that suite passing unchanged is the evidence that the
 * merge did not alter this module's own surface. Everything below is how the same route table is
 * mounted beside eleven others.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The paths this module must NOT serve in the merged process.
 *
 * `/livez`, `/readyz` and `/metrics` exist on every module. Matching is FIRST-WINS, so a second copy
 * of each would be unreachable — a dead health endpoint that looks exactly like a live one. agora's
 * win, because it is the host and because Prometheus scrapes this target under agora's job. `/readyz`
 * still reports this module: it contributes the `postgres-foresight` probe to the host's one
 * `Lifecycle`, which is what makes one endpoint honest for a dozen databases.
 */
export const UNMOUNTED: ReadonlySet<string> = new Set(OPERATIONAL_ROUTES)

/**
 * This module's routes, ready to mount beside agora's.
 *
 * Three things happen here and nowhere else, which is what makes them impossible to forget per
 * handler:
 *
 *   1. **Every spec is stamped with THIS module's selector.** The kernel resolves one handle per
 *      request from one selector, and the host's is agora's. Unstamped, every read below would run
 *      against agora's database — where `inbox` and `jobs` exist with the same columns, so the write
 *      SUCCEEDS and reports nothing. Stamped once, over the whole table, so no handler had to change.
 *   2. **The handler closes over THIS module's deps.** `RouteSpec.handle` takes only `ctx`, so there
 *      is no parameter through which the host's queue, verifier or stores could arrive.
 *   3. **`forRequest` still runs, per request, from `ctx.network`.** It is what swaps the boot-time
 *      queue for the per-network one — a stake or a deploy is an enqueue, and enqueuing onto the
 *      wrong estate's queue would be a write that succeeds and says nothing, exactly the failure the
 *      selector guards against for reads. In the standalone this happened on the dispatch line; here
 *      it happens on the promise side of the boundary, which is where a throw is already caught.
 */
export function mountableRoutes(deps: ServerDeps, sql: NetworkSql): readonly RouteSpec<Db>[] {
  return buildRoutes()
    .filter((route) => !UNMOUNTED.has(route.path))
    .map((route) => ({
      method: route.method,
      path: route.path,
      sql,
      // `async` rather than a bare call, so a handler that throws SYNCHRONOUSLY is a rejected promise
      // the kernel's dispatch already catches rather than an exception escaping into it.
      handle: async (ctx: KernelContext<Db>): Promise<Reply> =>
        await handle(route, ctx, forRequest(deps, ctx.network)),
    }))
}
