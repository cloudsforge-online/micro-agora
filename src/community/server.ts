/**
 * The HTTP surface.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE PATHS ARE `/v1/…`, AND THE RESOURCE NAMES DO NOT COLLIDE WITH ANOTHER SERVICE'S.**
 *
 * `deploy/gateway/dynamic/public-api.yml` mounts `api.<apex>/v1/<resource>` uniformly and routes by
 * RESOURCE rather than by service, which works only because no method+path pair collides across
 * the estate. Serving `/v1` natively puts this service in the forwarded-unchanged half, which is
 * the half to be in: a strip rule is a second place the public path is decided, and it drifts.
 *
 * `communities`, `proposals` and `delegations` are this service's. Note what is NOT used:
 * `/v1/votes` is deliberately absent as a top-level resource — a vote has no identity outside its
 * proposal and `POST /v1/proposals/:id/votes` says so.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AUTHORITY IS A MEMBERSHIP ROW, READ FROM THE DATABASE, NEVER FROM THE REQUEST.**
 *
 * Every route that acts within a community resolves the caller's role with `roleIn`, which returns
 * null for anything that is not an `active` membership. There is no header, body field or query
 * parameter anywhere in this file that names a role, and a community id is only ever taken from
 * the path or from the row being acted on.
 *
 * **A 404 rather than a 403 for a community the caller cannot see.** A 403 confirms the id exists,
 * which makes private communities enumerable.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE EXECUTE ROUTE IS `/internal`, AND ITS SCOPE MATCH IS EXACT.**
 *
 * `POST /internal/proposals/:id/execute` is the manual counterpart of the execute job — the thing
 * an operator runs when the job has dead-lettered. It requires a SERVICE token carrying
 * `community:execute` matched with `includes`, not `hasScope`: `runtime/packages/auth`'s matcher
 * honours one wildcard level, so a token carrying `community:*` would be admitted, and this route
 * spends a treasury. See `scopes.ts` for the estate's two matchers and why neither was changed.
 *
 * It cannot bypass the timelock. Nothing can — the timelock is a BEFORE INSERT trigger on
 * `executions`, and this route reaches it through exactly the same `executeProposal` the job does.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`POST /v1/events` IS SIGNATURE-CHECKED OVER THE RAW BYTES, BEFORE IT IS PARSED.**
 *
 * It consumes `identity.user.deleted`, which pseudonymises a member's governance record. Unsigned,
 * it is an erase-anybody's-membership endpoint reachable by anything that can open a socket to the
 * app network.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { ForbiddenError, TokenError, bearerFrom, statusFor, type Principal } from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { NetworkUnknownError, requestNetwork, type Network } from '@cloudsforge/http'
import type { NetworkSql } from '@cloudsforge/db'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import type { JobQueue } from '@cloudsforge/jobs'
import type { RequestContext as KernelContext, RouteSpec } from '../kernel.ts'
import { eraseEveryPlane } from '../erasureplanes.ts'
import {
  SIGNATURE_HEADER,
  verifyEventSignature,
  withInbox,
  type Db,
  type Emit,
  type Tx,
} from './outbox.ts'
import {
  IdempotencyInFlightError,
  IdempotencyKeyReuseError,
  requestFingerprint,
  withIdempotency,
} from './idempotency.ts'
import {
  ADMIN_ROLES,
  ConflictError,
  ForbiddenInCommunityError,
  MODERATOR_ROLES,
  NotFoundError,
  TREASURY_ROLES,
  VOTING_ROLES,
  ValidationError,
  countVotingMembers,
  createCommunity,
  createCommunityRole,
  declareTreasuryAccount,
  findCommunity,
  isCommunityKind,
  isGovernanceModel,
  isJoinPolicy,
  isRole,
  joinCommunity,
  listCommunities,
  listCommunityRoles,
  listMembers,
  listTreasuryAccounts,
  permits,
  roleIn,
  setRole,
  type Community,
  type Role,
} from './communities.ts'
import {
  addDiscussionPost,
  cancelProposal,
  createProposal,
  findProposal,
  isProposalKind,
  listDiscussion,
  listProposals,
  openForDiscussion,
  redactPost,
  type Proposal,
} from './proposals.ts'
import {
  DelegationCycleError,
  activeDelegation,
  delegate,
  delegatorsFor,
  revokeDelegation,
} from './delegations.ts'
import {
  AlreadyVotedError,
  VotingClosedError,
  castVote,
  listVotes,
  oneMemberOneVote,
  resolveBallot,
  weightsFor,
  withdrawVote,
  type WeightResolver,
} from './votes.ts'
import { isChoice, rejectionReason, tally } from './tally.ts'
import {
  SpendRefusedError,
  TimelockError,
  executeProposal,
  findExecution,
  type ExecuteDeps,
} from './executions.ts'
import { PolicyUnavailableError } from './policyclient.ts'
import {
  COMMUNITY_WRITE_SCOPE,
  COMMUNITY_EXECUTE_SCOPE,
  SCOPES,
  SCOPE_NAMES,
  grantsScope,
  type Scope,
} from './scopes.ts'
import { EXECUTE_KIND, executeKey } from './jobs.ts'
import { USER_DELETED_TOPIC } from './events.ts'

const IDEMPOTENCY_HEADER = 'idempotency-key'
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_BYTES = 256 * 1024
const DEFAULT_PAGE = 50
const MAX_PAGE = 200

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
  readonly producer: string
  readonly ingestSecrets: readonly string[]
  readonly queue: JobQueue
  readonly execute: Pick<ExecuteDeps, 'ledger' | 'policy'>
  /**
   * How a vote's weight is decided. `oneMemberOneVote` by default; the token-weighted resolver is
   * supplied by the composition root, which is the only place that holds an indexer client.
   */
  readonly weights?: WeightResolver
  readonly beforeScrape?: () => Promise<void>
}

/** Domain metrics, declared rather than inferred from a log line — AD-20. */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'community_up',
      help: 'Always 1. The series that proves the scrape reached community at all.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'community_votes_total',
      help: 'Votes recorded, by choice. Counts BALLOTS, not subjects: one delegate voting for three delegators is one.',
      kind: 'counter',
      labels: ['choice'],
    })
    .register({
      name: 'community_vote_refusals_total',
      help: 'Votes refused, by reason. A climbing `already_voted` means members are being counted once when they expected otherwise — usually a delegation they had forgotten.',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      name: 'community_proposals_closed_total',
      help: 'Proposals counted and closed, by outcome.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'community_executions_total',
      help: 'Execution attempts by outcome. `gate_unavailable` above zero means treasury spends are stalled on policy — the fail-closed branch working, and an incident.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'community_gate_checks_total',
      help: 'Token-gate re-checks by outcome. A climbing `unknown` means the gate is not actually running: the indexer has no balance route (see gating.ts), and an unknown holding never demotes.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'community_delegation_refusals_total',
      help: 'Delegations refused, by reason. `cycle` above zero is the database trigger doing its job.',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      name: 'community_proposals_voting',
      help: 'Proposals currently open for voting.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'community_proposals_timelocked',
      help: 'Proposals passed and waiting out their timelock. A climbing value means executions have stopped — the one number worth an alert.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'community_jobs_pending',
      help: 'Jobs queued and not dead.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'community_jobs_dead',
      help: 'Jobs past their attempt ceiling. A dead `proposal.execute` is a community whose vote has not been honoured.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      // ────────────────────────────────────────────────────────────────────────────────────────
      // micro-org #222. The question that had no answer anywhere while this service's token sat
      // expired for 26 hours on a container reporting healthy: `/livez` needs no upstream, so no
      // probe in the estate ever presented the credential to anybody.
      //
      // Deliberately NOT "a token is present". The provider keeps an expired token after it dies
      // because `expiresInSeconds` going steadily negative is the most useful thing an operator can
      // be shown — but a gauge that read presence would report 1 across exactly the outage this
      // exists to see, which is a check that cannot fail.
      // ────────────────────────────────────────────────────────────────────────────────────────
      name: 'community_service_token_usable',
      help: 'Whether this process can authenticate to the ledger, policy and the indexer right now. 0 means every treasury spend is about to be recorded as REFUSED by a gate that was never asked (micro-org #222).',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'community_service_token_static',
      help: '1 when this container was given a pre-minted token instead of a credential. It reads 1 for the ten minutes before the token dies, so it is the gauge that predicts the cliff rather than the one that reports it.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'community_service_token_events_total',
      help: 'Credential exchange lifecycle, by kind. `exchange_failed` climbing while `minted` does not means identity is refusing this credential — check it has not been revoked.',
      kind: 'counter',
      labels: ['kind'],
    })
    .register({
      name: 'community_events_rejected_total',
      help: 'Inbound events refused, by reason. `bad_signature` above zero means something is posting unsigned events at the inbox.',
      kind: 'counter',
      labels: ['reason'],
    })
}

/* ------------------------------------------------------------------ plumbing */

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
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

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
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid credential is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof IdempotencyKeyReuseError) {
      return errorReply(409, 'idempotency_key_reuse', err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyInFlightError) {
      return errorReply(409, 'idempotency_in_flight', err.message, ctx.requestId)
    }
    if (err instanceof AlreadyVotedError) {
      deps.metrics.increment('community_vote_refusals_total', { reason: 'already_voted' })
      return errorReply(409, 'already_voted', err.message, ctx.requestId)
    }
    if (err instanceof VotingClosedError) {
      deps.metrics.increment('community_vote_refusals_total', { reason: 'closed' })
      return errorReply(409, 'voting_closed', err.message, ctx.requestId)
    }
    if (err instanceof DelegationCycleError) {
      deps.metrics.increment('community_delegation_refusals_total', { reason: 'cycle' })
      return errorReply(409, 'delegation_cycle', err.message, ctx.requestId)
    }
    if (err instanceof TimelockError) {
      // 409 rather than 403: the request is legitimate and will succeed later. A 403 would read as
      // "you may not do this", which is exactly wrong about a timelock.
      return errorReply(409, 'timelocked', err.message, ctx.requestId)
    }
    if (err instanceof SpendRefusedError) {
      return errorReply(403, 'spend_refused', err.message, ctx.requestId)
    }
    if (err instanceof PolicyUnavailableError) {
      // 503, never 403. We do not KNOW whether the spend is allowed, and answering 403 would
      // record a refusal against the community for somebody else's outage.
      ctx.log.error('the treasury spend gate is unavailable', { err })
      return errorReply(503, 'gate_unavailable', err.message, ctx.requestId)
    }
    if (err instanceof ForbiddenInCommunityError) {
      return errorReply(403, 'forbidden', err.message, ctx.requestId)
    }
    if (err instanceof NotFoundError) return errorReply(404, 'not_found', err.message, ctx.requestId)
    if (err instanceof ConflictError) return errorReply(409, 'conflict', err.message, ctx.requestId)
    if (err instanceof ValidationError) return errorReply(400, 'invalid', err.message, ctx.requestId)
    if (err instanceof BadRequestError) return errorReply(400, 'bad_request', err.message, ctx.requestId)
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

/* ------------------------------------------------------------------ principals */

interface UserPrincipal {
  readonly kind: 'user'
  readonly userId: string
  readonly subject: string
}

async function authenticateUser(ctx: RequestContext, deps: ServerDeps): Promise<UserPrincipal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  if (!token) throw new TokenError('no credential presented', 'missing')
  const principal = await deps.verifier.principal(token)
  if (principal.kind !== 'user') {
    // A service token is not "close enough" on the governance surface. It names no user, so there
    // is no membership to check — and accepting one would make every service in the estate a
    // voting member of every community.
    throw new ForbiddenError('this route requires a user token')
  }
  return { kind: 'user', userId: principal.userId, subject: `user:${principal.userId}` }
}

/**
 * A service token carrying the named scope, matched EXACTLY.
 *
 * `principal.scopes.includes(required)`, deliberately not `hasScope` — see the file header and
 * `scopes.ts`. `scopes.test.ts` proves `community:*` is refused here.
 */
async function authenticateService(
  ctx: RequestContext,
  deps: ServerDeps,
  required: Scope,
): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  if (!token) throw new TokenError('no credential presented', 'missing')
  const principal = await deps.verifier.principal(token)
  if (principal.kind !== 'service') throw new ForbiddenError('this route requires a service token')
  if (!grantsScope(principal.scopes, required)) throw new ForbiddenError(required)
  return principal
}

/**
 * The community, and the caller's role in it.
 *
 * A community the caller has no role in answers 404 rather than 403 — see the file header. A
 * `public` community is readable by anyone, which is what `public` means; every other kind
 * requires a membership even to read.
 */
async function authoriseCommunity(
  ctx: RequestContext,
  deps: ServerDeps,
  communityId: string,
  allowed: readonly Role[] | 'read',
): Promise<{ caller: UserPrincipal; community: Community; role: Role | null }> {
  const caller = await authenticateUser(ctx, deps)
  const community = await findCommunity(ctx.sql, communityId)
  if (!community) throw new NotFoundError('no such community')
  const role = await roleIn(ctx.sql, community.id, caller.subject)

  if (allowed === 'read') {
    if (community.kind === 'public' || community.kind === 'project' || community.kind === 'creator') {
      return { caller, community, role }
    }
    if (role === null) throw new NotFoundError('no such community')
    return { caller, community, role }
  }

  if (!permits(role, allowed)) {
    // 404 rather than 403 for a caller who is not a member at all; 403 for a member whose role is
    // insufficient. The distinction is safe: a member already knows the community exists.
    if (role === null) throw new NotFoundError('no such community')
    throw new ForbiddenInCommunityError(
      `this action requires one of: ${allowed.join(', ')} — you are ${role}`,
    )
  }
  return { caller, community, role }
}

/* ------------------------------------------------------------------ routes */

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handler })

  return [
    /* ---------------------------------------------------------------- health */

    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
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

    /* ---------------------------------------------------------------- vocabulary */

    define('GET', '/v1/scopes', async () => ({
      status: 200,
      body: {
        scopes: SCOPE_NAMES.map((name) => ({ name, description: SCOPES[name] })),
        // Said on the wire because it is a promise this service makes to every caller: a wildcard
        // grants nothing here, whatever another service in the estate does with one.
        wildcards: false,
      },
    })),

    /* ---------------------------------------------------------------- communities */

    define('POST', '/v1/communities', async (ctx, deps) => {
      const caller = await authenticateUser(ctx, deps)
      const body = await readJson(ctx.req)
      const kind = requireEnum(body, 'kind', isCommunityKind)
      const joinPolicy = requireEnum(body, 'joinPolicy', isJoinPolicy)
      const governanceModel = requireEnum(body, 'governanceModel', isGovernanceModel)

      return withIdempotentRoute(ctx, deps, '/v1/communities', caller.subject, body, async (tx, emit) => {
        const community = await createCommunity(tx, emit, {
          slug: requireString(body, 'slug'),
          name: requireString(body, 'name'),
          kind,
          // From the TOKEN, never from the body. A caller-supplied owner is a caller who can
          // create a community owned by somebody else and then be its only admin.
          ownerSubject: caller.subject,
          joinPolicy,
          governanceModel,
          ...(body['gate'] ? { gate: parseGate(body['gate']) } : {}),
          ...(body['gateGraceHours'] !== undefined
            ? { gateGraceHours: requireInt(body, 'gateGraceHours', 1, 8_760) }
            : {}),
        })
        return { response: { community: wireCommunity(community) }, artefactId: community.id }
      })
    }),

    define('GET', '/v1/communities', async (ctx, deps) => ({
      status: 200,
      body: {
        communities: (await listCommunities(ctx.sql, pageSize(ctx))).map(wireCommunity),
      },
    })),

    define('GET', '/v1/communities/:id', async (ctx, deps) => {
      const { community, role } = await authoriseCommunity(ctx, deps, idParam(ctx), 'read')
      return { status: 200, body: { community: wireCommunity(community), yourRole: role } }
    }),

    define('GET', '/v1/communities/:id/members', async (ctx, deps) => {
      const { community } = await authoriseCommunity(ctx, deps, idParam(ctx), 'read')
      const members = await listMembers(ctx.sql, community.id, pageSize(ctx))
      return {
        status: 200,
        body: {
          members: members.map((member) => ({
            subject: member.subject,
            role: member.role,
            status: member.status,
            joinedAt: member.joinedAt.toISOString(),
            graceUntil: member.graceUntil?.toISOString() ?? null,
          })),
        },
      }
    }),

    define('POST', '/v1/communities/:id/members', async (ctx, deps) => {
      const caller = await authenticateUser(ctx, deps)
      const community = await findCommunity(ctx.sql, idParam(ctx))
      if (!community) throw new NotFoundError('no such community')
      const body = await readJson(ctx.req)

      return withIdempotentRoute(
        ctx,
        deps,
        '/v1/communities/:id/members',
        caller.subject,
        { ...body, communityId: community.id },
        async (tx, emit) => {
          const membership = await joinCommunity(tx, emit, community, {
            communityId: community.id,
            // The caller joins themselves. Inviting somebody else is a different operation with a
            // different authority, and it is not this one.
            subject: caller.subject,
          })
          return {
            response: { membership: { subject: membership.subject, role: membership.role, status: membership.status } },
            artefactId: membership.id,
          }
        },
      )
    }),

    define('PUT', '/v1/communities/:id/members/:subject/role', async (ctx, deps) => {
      const { caller, community } = await authoriseCommunity(ctx, deps, idParam(ctx), ADMIN_ROLES)
      const body = await readJson(ctx.req)
      const role = requireEnum(body, 'role', isRole)
      const target = decodeURIComponent(ctx.params['subject'] ?? '')

      const outcome = await ctx.sql.begin(async (tx) => {
        const pending: Parameters<Emit>[0][] = []
        const membership = await setRole(tx as Tx, (event) => pending.push(event), {
          communityId: community.id,
          subject: target,
          role,
          ...(body['customRoleId'] !== undefined
            ? { customRoleId: requireString(body, 'customRoleId') }
            : {}),
          actor: caller.subject,
        })
        for (const event of pending) await emitInTx(tx as Tx, deps.producer, event)
        return { value: membership }
      })
      return {
        status: 200,
        body: { membership: { subject: outcome.value.subject, role: outcome.value.role } },
      }
    }),

    define('POST', '/v1/communities/:id/roles', async (ctx, deps) => {
      const { caller, community } = await authoriseCommunity(ctx, deps, idParam(ctx), ADMIN_ROLES)
      const body = await readJson(ctx.req)
      const name = requireString(body, 'name')
      const capabilities = optionalStringArray(body, 'capabilities')

      return withIdempotentRoute(
        ctx,
        deps,
        '/v1/communities/:id/roles',
        caller.subject,
        { ...body, communityId: community.id },
        async (tx) => {
          const created = await createCommunityRole(tx, community.id, name, capabilities)
          return { response: { role: created }, artefactId: created.id }
        },
      )
    }),

    define('GET', '/v1/communities/:id/roles', async (ctx, deps) => {
      const { community } = await authoriseCommunity(ctx, deps, idParam(ctx), 'read')
      return { status: 200, body: { roles: await listCommunityRoles(ctx.sql, community.id) } }
    }),

    /* ---------------------------------------------------------------- treasury */

    define('POST', '/v1/communities/:id/treasury-accounts', async (ctx, deps) => {
      const { caller, community } = await authoriseCommunity(ctx, deps, idParam(ctx), ADMIN_ROLES)
      const body = await readJson(ctx.req)
      const assetCode = requireString(body, 'assetCode')

      return withIdempotentRoute(
        ctx,
        deps,
        '/v1/communities/:id/treasury-accounts',
        caller.subject,
        { ...body, communityId: community.id },
        async (tx) => {
          const account = await declareTreasuryAccount(tx, community, assetCode)
          return { response: { treasuryAccount: account }, artefactId: account.id }
        },
      )
    }),

    define('GET', '/v1/communities/:id/treasury-accounts', async (ctx, deps) => {
      const { community } = await authoriseCommunity(ctx, deps, idParam(ctx), 'read')
      const accounts = await listTreasuryAccounts(ctx.sql, community.id)
      return {
        status: 200,
        body: {
          // ══════════════════════════════════════════════════════════════════════════════════
          // NO BALANCES. This service does not hold them and does not proxy them either: the
          // balance of `ledgerSubject` is `GET /accounts/:subject/balances` on micro-ledger, and
          // a caller reads it there. Proxying would create a second place a treasury balance is
          // reported from, and the two would disagree the first time one was cached.
          // ══════════════════════════════════════════════════════════════════════════════════
          treasuryAccounts: accounts,
          balancesAt: { service: 'ledger', route: '/accounts/:subject/balances' },
        },
      }
    }),

    /* ---------------------------------------------------------------- proposals */

    define('POST', '/v1/communities/:id/proposals', async (ctx, deps) => {
      const body = await readJson(ctx.req)
      const kind = requireEnum(body, 'kind', isProposalKind)
      // A treasury spend may only be PROPOSED by somebody the community trusts with its money.
      // Voting on one is every member's right; putting one on the agenda is not.
      const allowed = kind === 'treasury_spend' ? TREASURY_ROLES : VOTING_ROLES
      const { caller, community } = await authoriseCommunity(ctx, deps, idParam(ctx), allowed)

      const opensAt = requireDate(body, 'opensAt')
      const closesAt = requireDate(body, 'closesAt')
      const timelockUntil = requireDate(body, 'timelockUntil')

      return withIdempotentRoute(
        ctx,
        deps,
        '/v1/communities/:id/proposals',
        caller.subject,
        { ...body, communityId: community.id },
        async (tx, emit) => {
          const proposal = await createProposal(tx, emit, community, {
            author: caller.subject,
            kind,
            title: requireString(body, 'title'),
            ...(typeof body['body'] === 'string' ? { body: body['body'] } : {}),
            quorum: requireBigint(body, 'quorum'),
            thresholdBps: requireInt(body, 'thresholdBps', 1, 10_000),
            opensAt,
            closesAt,
            timelockUntil,
            ...(body['snapshotBlock'] !== undefined
              ? { snapshotBlock: requireBigint(body, 'snapshotBlock') }
              : {}),
            ...(kind === 'treasury_spend' ? { spend: parseSpend(body['spend']) } : {}),
            ...(typeof body['targetSubject'] === 'string' ? { targetSubject: body['targetSubject'] } : {}),
            ...(typeof body['targetRole'] === 'string' ? { targetRole: body['targetRole'] } : {}),
          })
          return { response: { proposal: wireProposal(proposal) }, artefactId: proposal.id }
        },
      )
    }),

    define('GET', '/v1/communities/:id/proposals', async (ctx, deps) => {
      const { community } = await authoriseCommunity(ctx, deps, idParam(ctx), 'read')
      const proposals = await listProposals(ctx.sql, community.id, pageSize(ctx))
      return { status: 200, body: { proposals: proposals.map(wireProposal) } }
    }),

    define('GET', '/v1/proposals/:id', async (ctx, deps) => {
      const proposal = await requireProposal(ctx, deps, 'read')
      const execution = await findExecution(ctx.sql, proposal.id)
      return {
        status: 200,
        body: {
          proposal: wireProposal(proposal),
          execution: execution ? wireExecution(execution) : null,
        },
      }
    }),

    define('POST', '/v1/proposals/:id/open', async (ctx, deps) => {
      const proposal = await requireProposal(ctx, deps, ADMIN_ROLES, { orAuthor: true })
      const outcome = await ctx.sql.begin(async (tx) => ({
        value: await openForDiscussion(tx as Tx, proposal.id),
      }))
      if (outcome.value.status === 'missing') throw new NotFoundError('no such proposal')
      return {
        status: 200,
        body: { proposal: wireProposal(outcome.value.proposal), moved: outcome.value.status === 'moved' },
      }
    }),

    define('POST', '/v1/proposals/:id/cancel', async (ctx, deps) => {
      const proposal = await requireProposal(ctx, deps, ADMIN_ROLES, { orAuthor: true })
      const outcome = await ctx.sql.begin(async (tx) => ({
        value: await cancelProposal(tx as Tx, proposal.id),
      }))
      if (outcome.value.status === 'missing') throw new NotFoundError('no such proposal')
      return {
        status: 200,
        body: { proposal: wireProposal(outcome.value.proposal), moved: outcome.value.status === 'moved' },
      }
    }),

    /* ---------------------------------------------------------------- discussion */

    define('POST', '/v1/proposals/:id/posts', async (ctx, deps) => {
      const proposal = await requireProposal(ctx, deps, VOTING_ROLES)
      const caller = await authenticateUser(ctx, deps)
      const body = await readJson(ctx.req)

      return withIdempotentRoute(
        ctx,
        deps,
        '/v1/proposals/:id/posts',
        caller.subject,
        { ...body, proposalId: proposal.id },
        async (tx) => {
          const post = await addDiscussionPost(tx, proposal.id, caller.subject, requireString(body, 'body'))
          return {
            response: { post: { id: post.id, author: post.author, createdAt: post.createdAt.toISOString() } },
            artefactId: post.id,
          }
        },
      )
    }),

    define('GET', '/v1/proposals/:id/posts', async (ctx, deps) => {
      const proposal = await requireProposal(ctx, deps, 'read')
      const posts = await listDiscussion(ctx.sql, proposal.id, pageSize(ctx))
      return {
        status: 200,
        body: {
          posts: posts.map((post) => ({
            id: post.id,
            author: post.author,
            body: post.body,
            createdAt: post.createdAt.toISOString(),
            redacted: post.redactedAt !== null,
          })),
        },
      }
    }),

    define('DELETE', '/v1/posts/:id', async (ctx, deps) => {
      // A moderator redacts. The row survives — see `listDiscussion` for why a hole in a thread is
      // worse than a marker.
      const caller = await authenticateUser(ctx, deps)
      const rows = await ctx.sql<{ community_id: string }[]>`
        select p.community_id from discussion_posts d
          join proposals p on p.id = d.proposal_id
         where d.id = ${idParam(ctx)}
      `
      const communityId = rows[0]?.community_id
      if (!communityId) throw new NotFoundError('no such post')
      const role = await roleIn(ctx.sql, communityId, caller.subject)
      if (!permits(role, MODERATOR_ROLES)) throw new ForbiddenInCommunityError('this action requires a moderator')

      const outcome = await ctx.sql.begin(async (tx) => ({
        value: await redactPost(tx as Tx, idParam(ctx)),
      }))
      return { status: 200, body: { redacted: outcome.value } }
    }),

    /* ---------------------------------------------------------------- votes */

    define('POST', '/v1/proposals/:id/votes', async (ctx, deps) => {
      const proposal = await requireProposal(ctx, deps, VOTING_ROLES)
      const caller = await authenticateUser(ctx, deps)
      const body = await readJson(ctx.req)
      const choice = requireEnum(body, 'choice', isChoice)

      // Resolved BEFORE the transaction opens: the token-weighted resolver reaches the indexer, and
      // a network call under an open transaction holds a connection for as long as the slowest
      // upstream. See `resolveBallot`.
      const ballot = await resolveBallot(
        ctx.sql,
        deps.weights ?? oneMemberOneVote,
        proposal,
        caller.subject,
      )

      const reply = await withIdempotentRoute(
        ctx,
        deps,
        '/v1/proposals/:id/votes',
        caller.subject,
        { ...body, proposalId: proposal.id },
        async (tx, emit) => {
          const result = await castVote(tx, emit, {
            proposal,
            voter: caller.subject,
            choice,
            ownWeight: ballot.ownWeight,
            delegatedWeights: ballot.delegatedWeights,
          })
          return {
            response: {
              vote: {
                choice: result.own.choice,
                weight: result.own.weight.toString(),
                subjectsCounted: 1 + result.delegated.length,
                // Said on the wire, because a delegate who expected to carry three delegators and
                // carried two needs to know which one voted for themselves. Silence here is how a
                // delegate believes they cast power they did not.
                overriddenBy: [...result.overriddenBy],
              },
            },
            artefactId: result.own.id,
          }
        },
      )
      deps.metrics.increment('community_votes_total', { choice })
      return reply
    }),

    define('DELETE', '/v1/proposals/:id/votes', async (ctx, deps) => {
      const proposal = await requireProposal(ctx, deps, VOTING_ROLES)
      const caller = await authenticateUser(ctx, deps)
      const target = ctx.url.searchParams.get('subject') ?? caller.subject
      const outcome = await ctx.sql.begin(async (tx) => ({
        value: await withdrawVote(tx as Tx, proposal.id, target, caller.subject),
      }))
      return { status: 200, body: { withdrawn: outcome.value } }
    }),

    define('GET', '/v1/proposals/:id/votes', async (ctx, deps) => {
      const proposal = await requireProposal(ctx, deps, 'read')
      const votes = await listVotes(ctx.sql, proposal.id, pageSize(ctx))
      return {
        status: 200,
        body: {
          votes: votes.map((vote) => ({
            subject: vote.subject,
            castBy: vote.castBy,
            choice: vote.choice,
            // A decimal string. A JSON number is an IEEE 754 double and a token weight is a uint256.
            weight: vote.weight.toString(),
            castAt: vote.castAt.toISOString(),
          })),
        },
      }
    }),

    define('GET', '/v1/proposals/:id/tally', async (ctx, deps) => {
      const proposal = await requireProposal(ctx, deps, 'read')
      const weights = await weightsFor(ctx.sql, proposal.id)
      const result = tally(weights, { quorum: proposal.quorum, thresholdBps: proposal.thresholdBps })
      return {
        status: 200,
        body: {
          tally: {
            forWeight: result.forWeight.toString(),
            againstWeight: result.againstWeight.toString(),
            abstainWeight: result.abstainWeight.toString(),
            totalWeight: result.totalWeight.toString(),
            decidedWeight: result.decidedWeight.toString(),
            voterCount: result.voterCount,
            quorum: proposal.quorum.toString(),
            thresholdBps: proposal.thresholdBps,
            quorumMet: result.quorumMet,
            thresholdMet: result.thresholdMet,
            // The outcome a close WOULD produce. Not the proposal's status — a proposal still
            // voting has no outcome, and saying otherwise invites reading a live count as a result.
            provisionalOutcome: result.outcome,
            reason: rejectionReason(result),
            eligibleMembers: await countVotingMembers(ctx.sql, proposal.communityId),
          },
        },
      }
    }),

    /* ---------------------------------------------------------------- delegations */

    define('POST', '/v1/communities/:id/delegations', async (ctx, deps) => {
      const { caller, community } = await authoriseCommunity(ctx, deps, idParam(ctx), VOTING_ROLES)
      const body = await readJson(ctx.req)
      const delegateSubject = requireString(body, 'delegate')

      // The delegate must be a voting member too. Delegating to somebody with no power is a
      // silently discarded vote, which is the worst possible outcome for the delegator.
      const delegateRole = await roleIn(ctx.sql, community.id, delegateSubject)
      if (!permits(delegateRole, VOTING_ROLES)) {
        throw new ValidationError('the delegate must be a voting member of this community')
      }

      return withIdempotentRoute(
        ctx,
        deps,
        '/v1/communities/:id/delegations',
        caller.subject,
        { ...body, communityId: community.id },
        async (tx, emit) => {
          const created = await delegate(tx, emit, {
            communityId: community.id,
            // From the TOKEN. A caller-supplied delegator is a caller who can give away somebody
            // else's vote.
            delegatorSubject: caller.subject,
            delegateSubject,
          })
          return {
            response: { delegation: { id: created.id, delegate: created.delegateSubject } },
            artefactId: created.id,
          }
        },
      )
    }),

    define('DELETE', '/v1/communities/:id/delegations', async (ctx, deps) => {
      const { caller, community } = await authoriseCommunity(ctx, deps, idParam(ctx), VOTING_ROLES)
      const outcome = await ctx.sql.begin(async (tx) => {
        const pending: Parameters<Emit>[0][] = []
        const revoked = await revokeDelegation(
          tx as Tx,
          (event) => pending.push(event),
          community.id,
          caller.subject,
        )
        for (const event of pending) await emitInTx(tx as Tx, deps.producer, event)
        return { value: revoked }
      })
      return { status: 200, body: { revoked: { id: outcome.value.id } } }
    }),

    define('GET', '/v1/communities/:id/delegations', async (ctx, deps) => {
      const { caller, community } = await authoriseCommunity(ctx, deps, idParam(ctx), 'read')
      const [mine, delegators] = await Promise.all([
        activeDelegation(ctx.sql, community.id, caller.subject),
        delegatorsFor(ctx.sql, community.id, caller.subject),
      ])
      return {
        status: 200,
        body: {
          // Deliberately scoped to the caller. The full delegation graph of a community is a map of
          // who trusts whom, and publishing it makes vote-buying a lookup rather than an
          // investigation.
          delegatedTo: mine?.delegateSubject ?? null,
          delegatedFrom: delegators,
        },
      }
    }),

    /* ---------------------------------------------------------------- internal */

    define('POST', '/internal/proposals/:id/execute', async (ctx, deps) => {
      // A SERVICE token carrying `community:execute`, matched EXACTLY. See the file header.
      await authenticateService(ctx, deps, COMMUNITY_EXECUTE_SCOPE)
      const proposalId = idParam(ctx)

      // ══════════════════════════════════════════════════════════════════════════════════════
      // THIS ROUTE CANNOT BYPASS THE TIMELOCK, AND NOT BECAUSE IT CHECKS FOR IT.
      //
      // It calls the same `executeProposal` the job calls, which inserts an `executions` row, which
      // fires `community_assert_execution_timelock` BEFORE INSERT. There is no argument to this
      // route, no header and no scope that changes that. An early call answers 409 `timelocked`.
      // ══════════════════════════════════════════════════════════════════════════════════════
      const outcome = await executeProposal(
        { sql: ctx.sql, ledger: deps.execute.ledger, policy: deps.execute.policy, producer: deps.producer },
        (tx, event) => emitInTx(tx, deps.producer, event),
        { proposalId, executedBy: 'operator:manual', correlationId: ctx.requestId },
      )
      if (outcome.status === 'missing') throw new NotFoundError('no such proposal')
      deps.metrics.increment('community_executions_total', { outcome: outcome.status })
      return {
        status: outcome.status === 'executed' ? 201 : 200,
        body: { status: outcome.status, execution: wireExecution(outcome.execution) },
      }
    }),

    define('POST', '/internal/proposals/:id/enqueue-execution', async (ctx, deps) => {
      // The re-arm an operator reaches for when an execute job has dead-lettered. It schedules;
      // it does not execute, so it needs no treasury authority and carries `community:write`.
      await authenticateService(ctx, deps, COMMUNITY_WRITE_SCOPE)
      const proposalId = idParam(ctx)
      const proposal = await findProposal(ctx.sql, proposalId)
      if (!proposal) throw new NotFoundError('no such proposal')
      await deps.queue.enqueue({
        kind: EXECUTE_KIND,
        key: executeKey(proposalId),
        onConflict: 'earliest',
        payload: { proposalId },
      })
      return { status: 202, body: { enqueued: true, proposalId } }
    }),

    define('POST', '/v1/events', async (ctx, deps) => {
      const raw = await readRaw(ctx.req)
      const presented = headerOf(ctx.req, SIGNATURE_HEADER)
      const body = raw.toString('utf8')
      const verified =
        presented !== undefined &&
        deps.ingestSecrets.some((secret) => verifyEventSignature(body, secret, presented))
      if (!verified) {
        deps.metrics.increment('community_events_rejected_total', { reason: 'bad_signature' })
        ctx.log.warn('an inbound event failed its signature check')
        return errorReply(401, 'bad_signature', 'the event signature did not verify', ctx.requestId)
      }

      let envelope: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(body)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new BadRequestError('an event envelope must be a JSON object')
        }
        envelope = parsed as Record<string, unknown>
      } catch {
        deps.metrics.increment('community_events_rejected_total', { reason: 'malformed' })
        throw new BadRequestError('the event body is not valid JSON')
      }

      const topic = typeof envelope['topic'] === 'string' ? envelope['topic'] : ''
      const eventId = typeof envelope['id'] === 'string' ? envelope['id'] : ''
      if (!UUID.test(eventId)) {
        deps.metrics.increment('community_events_rejected_total', { reason: 'malformed' })
        throw new BadRequestError('an event envelope must carry a uuid id')
      }
      if (topic !== USER_DELETED_TOPIC) {
        // Accepted and ignored, with a 202. A 4xx would make the producer's relay retry an event it
        // is correct to send and we are correct not to act on, for ever.
        deps.metrics.increment('community_events_rejected_total', { reason: 'not_subscribed' })
        return { status: 202, body: { status: 'ignored', topic } }
      }

      const payload =
        typeof envelope['payload'] === 'object' && envelope['payload'] !== null
          ? (envelope['payload'] as Record<string, unknown>)
          : {}
      const userId = typeof payload['userId'] === 'string' ? payload['userId'] : null
      if (!userId) throw new BadRequestError('the event payload must name a userId')

      const done = deps.lifecycle.track()
      try {
        // EVERY plane, from the SELECTOR. See `../erasureplanes.ts`.
        const sweep = await eraseEveryPlane(deps.sql, (handle: Db) =>
          withInbox(handle, topic, eventId, async (tx) => eraseSubject(tx, `user:${userId}`)),
        )
        return {
          status: 202,
          body: {
            status: sweep.processed > 0 ? 'processed' : 'duplicate',
            planes: sweep.planes.map((plane) => ({
              network: plane.network,
              status: plane.status,
              ...(plane.value ?? {}),
            })),
          },
        }
      } finally {
        done()
      }
    }),
  ]
}

/* ------------------------------------------------------------------ erasure */

/**
 * The `identity.user.deleted` handler.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **ERASURE HERE IS PSEUDONYMISATION, AND THAT IS A DECISION RATHER THAN A SHORTCUT.**
 *
 * A recorded vote is part of a governance record that other people relied on when they decided how
 * to vote, and — for a `treasury_spend` — that a ledger entry was posted against. Deleting the vote
 * rows would silently change a historical tally and could retroactively un-pass a proposal whose
 * money has already moved, leaving an execution with no mandate behind it and no way to reconstruct
 * one.
 *
 * So vote rows keep their weight and their choice while the subject becomes an opaque token derived
 * from nothing. The arithmetic is unchanged; the person is no longer identifiable from it.
 *
 * **THE TOMBSTONE IS IRREVERSIBLE, AND THAT IS THE PROPERTY THE WHOLE DESIGN RESTS ON.**
 * `user:erased-<uuid>` is `crypto.randomUUID()` — CSPRNG output, generated per erasure, written to
 * the row and never stored anywhere alongside the subject it replaced. There is no mapping table,
 * no reverse index and nothing to compromise: this is destruction of the link, not a lookup that
 * somebody with enough access could run backwards. It is deliberately NOT a hash of the user id,
 * because a hash of a known-format identifier is reversible by anybody who can enumerate user ids —
 * and a uuid namespace is entirely enumerable given the pepper-free construction a hash would have.
 * One fresh token per erasure, not one per row, so a person's rows still join to each other; that
 * is what keeps a historical tally reconstructible without naming anyone.
 *
 * ── PER-TABLE DECISION ────────────────────────────────────────────────────────────────────────
 *
 * | table                     | action     | reasoning, and lawful basis where retained          |
 * |---------------------------|------------|-----------------------------------------------------|
 * | memberships               | delete     | The live authority record. It grants a capability   |
 * |                           |            | and there is no reason to keep one for an account   |
 * |                           |            | that no longer exists. Deleted outright.            |
 * | votes.subject             | anonymise  | The tally must survive; the voter need not. See     |
 * | votes.cast_by             |            | above, and `community_refuse_vote_update` in        |
 * |                           |            | migrations, which permits exactly these two columns |
 * |                           |            | to be rewritten and refuses choice/weight/proposal. |
 * | proposals.author          | anonymise  | A proposal's text is the community's record; who    |
 * |                           |            | tabled it is not needed to read it.                 |
 * | proposals.target_subject  | anonymise  | A `role_change` proposal names the member it is     |
 * |                           |            | about. That is the erased person, in a column no    |
 * |                           |            | shape CHECK covers, and it was being left behind.   |
 * | discussion_posts.author   | anonymise  | Same as proposals.author.                           |
 * | discussion_posts.body     | anonymise  | **The body was being kept.** `redacted_at` only     |
 * |                           |            | masks it on READ (`proposals.ts`); the text the |
 * |                           |            | person wrote — which is free-form and routinely     |
 * |                           |            | contains their own personal data — stayed in the    |
 * |                           |            | table. Redaction-on-read is a display rule, not     |
 * |                           |            | erasure. The body is now overwritten.               |
 * | delegations.*_subject     | anonymise  | **Both subject columns were being kept.** The       |
 * |                           |            | handler set `revoked_at` and nothing else, so every |
 * |                           |            | delegation the person made or received still named  |
 * |                           |            | them in the clear. Revoking an edge is not erasing  |
 * |                           |            | the person on it.                                   |
 * | communities.owner_subject | anonymise  | **Was being kept.** A community founder's           |
 * |                           |            | `user:<uuid>` survived erasure entirely. The        |
 * |                           |            | community itself is other members' and stays.       |
 * | executions.executed_by    | anonymise  | **Was being kept.** What the row exists to prove is |
 * |                           |            | "this proposal executed exactly once, and here is   |
 * |                           |            | the ledger entry" — the uniqueness constraint, the  |
 * |                           |            | idempotency key and `ledger_entry_id` all survive   |
 * |                           |            | untouched. None of that needs the person, and the   |
 * |                           |            | durable accountability record is admin-api's        |
 * |                           |            | hash-chained audit, not this column.                |
 * | proposals.spend_recipient | RETAIN     | A community voted to pay this person and a ledger   |
 * |                           |            | entry was posted against it. Art. 17(3)(b) — the    |
 * |                           |            | accounting record — and 17(3)(e), establishment and |
 * |                           |            | defence of legal claims: it is the mandate for a    |
 * |                           |            | movement of money and rewriting it would leave a    |
 * |                           |            | posted entry with no authority behind it. Erasing   |
 * |                           |            | it here would also achieve nothing, because         |
 * |                           |            | `micro-ledger` holds the authoritative copy of the  |
 * |                           |            | same subject and is the service that must decide    |
 * |                           |            | its retention. Reported, not silently kept.         |
 * | treasury_accounts         | retain     | `ledger_subject` is `community:<id>`, derived by a  |
 * |                           |            | generated column. It names no person.               |
 * | community_roles           | retain     | Capability sets, no subject column.                 |
 * | inbox / outbox            | retain     | The inbox row IS the acknowledgement, and Art. 5(2) |
 * |                           |            | requires us to be able to demonstrate compliance.   |
 * |                           |            | It names an event, not a user. No event is emitted  |
 * |                           |            | for the erasure itself — announcing it would write  |
 * |                           |            | a fresh row about the person to every subscriber.   |
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `communities_erased_owner_is_final` (migration 9) makes the tombstone structural: a row carrying
 * an `erased-` owner may not be rewritten to name a real account again.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function eraseSubject(tx: Tx, subject: string): Promise<Record<string, number>> {
  const tombstone = `user:erased-${crypto.randomUUID()}`

  const votes = await tx`
    update votes set subject = ${tombstone} where subject = ${subject} returning id
  `
  await tx`update votes set cast_by = ${tombstone} where cast_by = ${subject}`

  // The BODY, not just the flag. `redacted_at` masks the text on read; it does not remove it, and
  // a post is free-form text the person wrote about themselves.
  const posts = await tx`
    update discussion_posts
       set author      = ${tombstone},
           body        = '[erased]',
           redacted_at = coalesce(redacted_at, now())
     where author = ${subject} returning id
  `

  // Revoked AND anonymised. `delegations_not_self` is safe here because it already refuses a row
  // whose two subjects are equal, so this person is on at most one side of any given row and the
  // two CASE arms can never both fire. `community_refuse_delegation_cycle` returns early on a row
  // with `revoked_at` set, so rewriting the subjects cannot trip the cycle walk.
  const delegations = await tx`
    update delegations
       set revoked_at        = coalesce(revoked_at, now()),
           delegator_subject = case when delegator_subject = ${subject} then ${tombstone} else delegator_subject end,
           delegate_subject  = case when delegate_subject  = ${subject} then ${tombstone} else delegate_subject  end
     where delegator_subject = ${subject} or delegate_subject = ${subject}
    returning id
  `

  const memberships = await tx`delete from memberships where subject = ${subject} returning id`

  await tx`update proposals set author = ${tombstone} where author = ${subject}`
  const targeted = await tx`
    update proposals set target_subject = ${tombstone} where target_subject = ${subject} returning id
  `
  const owned = await tx`
    update communities set owner_subject = ${tombstone} where owner_subject = ${subject} returning id
  `
  const executions = await tx`
    update executions set executed_by = ${tombstone} where executed_by = ${subject} returning id
  `

  return {
    votesPseudonymised: votes.length,
    postsRedacted: posts.length,
    delegationsRevoked: delegations.length,
    membershipsRemoved: memberships.length,
    proposalsRetargeted: targeted.length,
    communitiesReowned: owned.length,
    executionsAnonymised: executions.length,
  }
}

/* ------------------------------------------------------------------ helpers */

/** Write an outbox row on a transaction the caller already holds. */
function emitInTx(tx: Tx, producer: string, event: Parameters<Emit>[0]): Promise<void> {
  return tx`
    insert into outbox (topic, key, producer, version, actor, correlation_id, payload)
    values (${event.topic}, ${event.key}, ${producer}, ${event.version ?? 1},
            ${event.actor ?? null}, ${event.correlationId ?? null},
            ${tx.json(event.payload as Record<string, never>)})
  `.then(() => undefined)
}

/**
 * The idempotency wrapper. Every mutating route either uses it or is named in
 * `routeidempotency.test.ts` with the reason it is safe without one.
 *
 * The work runs inside `withIdempotency`'s transaction AND inside an outbox collection, so the
 * artefact, its idempotency claim and its event are one commit. Three separate transactions here
 * would give three ways to end up with two of the three.
 */
async function withIdempotentRoute(
  ctx: RequestContext,
  deps: ServerDeps,
  route: string,
  principal: string,
  fingerprintSubject: Record<string, unknown>,
  run: (tx: Tx, emit: Emit) => Promise<{ response: Record<string, unknown>; artefactId: string | null }>,
): Promise<Reply> {
  const key = headerOf(ctx.req, IDEMPOTENCY_HEADER)
  if (!key || !SAFE_IDEMPOTENCY_KEY.test(key)) {
    throw new BadRequestError(
      'an Idempotency-Key header of 8 to 200 characters is required on every mutating request',
    )
  }
  const outcome = await withIdempotency<Record<string, unknown>>(ctx.sql, {
    principal,
    route,
    clientKey: key,
    requestHash: requestFingerprint(fingerprintSubject),
    run: async (tx) => {
      const pending: Parameters<Emit>[0][] = []
      const result = await run(tx, (event) => {
        pending.push(event)
      })
      for (const event of pending) await emitInTx(tx, deps.producer, event)
      return result
    },
  })
  return {
    status: outcome.replayed ? 200 : 201,
    // Said on the wire, so a client can tell "I created this" from "this already existed". A client
    // that cannot tell writes its own duplicate detection, badly.
    body: { ...outcome.result, replayed: outcome.replayed },
  }
}

/**
 * The proposal named in the path, with the caller's authority in its community checked.
 *
 * `orAuthor` widens the allowed set to include the proposal's own author, which is how a member
 * cancels their own proposal without being an admin.
 */
async function requireProposal(
  ctx: RequestContext,
  deps: ServerDeps,
  allowed: readonly Role[] | 'read',
  options: { orAuthor?: boolean } = {},
): Promise<Proposal> {
  const proposal = await findProposal(ctx.sql, idParam(ctx))
  if (!proposal) throw new NotFoundError('no such proposal')
  if (options.orAuthor === true) {
    const caller = await authenticateUser(ctx, deps)
    if (caller.subject === proposal.author) {
      const role = await roleIn(ctx.sql, proposal.communityId, caller.subject)
      if (role !== null) return proposal
    }
  }
  await authoriseCommunity(ctx, deps, proposal.communityId, allowed)
  return proposal
}

function wireCommunity(community: Community): Record<string, unknown> {
  return {
    id: community.id,
    slug: community.slug,
    name: community.name,
    kind: community.kind,
    ownerSubject: community.ownerSubject,
    joinPolicy: community.joinPolicy,
    treasurySubject: community.treasurySubject,
    governanceModel: community.governanceModel,
    status: community.status,
    gate: community.gate
      ? {
          chainId: community.gate.chainId,
          contract: community.gate.contract,
          minHolding: community.gate.minHolding.toString(),
        }
      : null,
    createdAt: community.createdAt.toISOString(),
  }
}

function wireProposal(proposal: Proposal): Record<string, unknown> {
  return {
    id: proposal.id,
    communityId: proposal.communityId,
    author: proposal.author,
    kind: proposal.kind,
    title: proposal.title,
    body: proposal.body,
    votingModel: proposal.votingModel,
    // Every integer wider than a JS number crosses as a decimal string, in both directions.
    quorum: proposal.quorum.toString(),
    thresholdBps: proposal.thresholdBps,
    snapshotBlock: proposal.snapshotBlock?.toString() ?? null,
    opensAt: proposal.opensAt.toISOString(),
    closesAt: proposal.closesAt.toISOString(),
    timelockUntil: proposal.timelockUntil.toISOString(),
    status: proposal.status,
    executionId: proposal.executionId,
    spend: proposal.spend
      ? {
          assetCode: proposal.spend.assetCode,
          amount: proposal.spend.amount.toString(),
          recipient: proposal.spend.recipient,
        }
      : null,
  }
}

function wireExecution(execution: { id: string; proposalId: string; ledgerEntryId: string | null; executedAt: Date }): Record<string, unknown> {
  return {
    id: execution.id,
    proposalId: execution.proposalId,
    ledgerEntryId: execution.ledgerEntryId,
    executedAt: execution.executedAt.toISOString(),
  }
}

function idParam(ctx: RequestContext): string {
  const id = ctx.params['id'] ?? ''
  if (!UUID.test(id)) throw new BadRequestError('id must be a uuid')
  return id
}

function pageSize(ctx: RequestContext): number {
  const raw = ctx.url.searchParams.get('limit')
  const n = raw === null ? DEFAULT_PAGE : Number(raw)
  if (!Number.isInteger(n) || n < 1) return DEFAULT_PAGE
  return Math.min(n, MAX_PAGE)
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestError(`${field} is required`)
  }
  return value
}

function requireEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  guard: (value: string) => value is T,
): T {
  const value = body[field]
  if (typeof value !== 'string' || !guard(value)) {
    throw new BadRequestError(`${field} is not one of the accepted values`)
  }
  return value
}

function requireInt(body: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestError(`${field} must be a whole number between ${min} and ${max}`)
  }
  return value
}

/**
 * A large integer, accepted as a decimal STRING and never as a JSON number.
 *
 * A number is refused rather than coerced. `JSON.parse` has already destroyed the precision of
 * anything above 2^53 by the time this runs, so accepting one would mean accepting a quorum or a
 * spend amount that is quietly not the one the caller sent.
 */
function requireBigint(body: Record<string, unknown>, field: string): bigint {
  const value = body[field]
  if (typeof value === 'number') {
    throw new BadRequestError(
      `${field} must be a decimal string, not a JSON number — a number above 2^53 does not survive JSON`,
    )
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequestError(`${field} must be a decimal string of digits`)
  }
  return BigInt(value)
}

function requireDate(body: Record<string, unknown>, field: string): Date {
  const value = body[field]
  if (typeof value !== 'string') throw new BadRequestError(`${field} must be an ISO 8601 timestamp`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new BadRequestError(`${field} must be an ISO 8601 timestamp`)
  return parsed
}

function optionalStringArray(body: Record<string, unknown>, field: string): readonly string[] {
  const value = body[field]
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new BadRequestError(`${field} must be an array of strings`)
  }
  return value as string[]
}

function parseGate(raw: unknown): { chainId: number; contract: string; minHolding: bigint } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestError('gate must be an object')
  }
  const gate = raw as Record<string, unknown>
  return {
    chainId: requireInt(gate, 'chainId', 1, 2_147_483_647),
    contract: requireString(gate, 'contract'),
    minHolding: requireBigint(gate, 'minHolding'),
  }
}

function parseSpend(raw: unknown): { assetCode: string; amount: bigint; recipient: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestError('a treasury_spend proposal must carry a spend object')
  }
  const spend = raw as Record<string, unknown>
  return {
    assetCode: requireString(spend, 'assetCode'),
    amount: requireBigint(spend, 'amount'),
    recipient: requireString(spend, 'recipient'),
  }
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Refused, not truncated. A truncated body is a different body, and its signature would not
    // verify anyway — but the check is here so an oversized POST cannot buffer unboundedly first.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('the request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req)
  if (raw.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new BadRequestError('the request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError('the request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const hasBody = reply.text !== undefined || reply.body !== undefined
  const payload = reply.text ?? (hasBody ? `${JSON.stringify(reply.body ?? {})}\n` : '')
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Refresh the gauges once per scrape. Bounded queries only. */
export function scrapeRefresh(deps: { readonly sql: Db; readonly metrics: Metrics }): () => Promise<void> {
  return async () => {
    deps.metrics.set('community_up', 1)
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WAVE M5a: WHAT THIS MODULE MOUNTS INSIDE THE MERGED PROCESS
 *
 * micro-deploy `docs/service-merge-plan.md`. Everything above this line is the STANDALONE
 * listener, unchanged — `server.test.ts` drives it and that suite passing unchanged is the
 * evidence that the merge did not alter this module's own surface. Everything below is how the
 * same route table is mounted beside eleven others.
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
 * **SEVERAL MODULES MOUNT `POST /v1/events`, AND THEY DO NOT VERIFY WITH THE SAME KEY.**
 *
 * agora verifies against `OUTBOX_SIGNING_SECRET`. policy verifies against `OUTBOX_ACCEPT_SECRETS`
 * falling back to `OUTBOX_SIGNING_SECRET`. devplatform verifies against `DEVPLATFORM_INGEST_SECRETS`.
 * community verifies against `COMMUNITY_INGEST_SECRETS` — a variable of its own, required at boot,
 * against which it answers 401 `bad_signature` rather than 403 on a signature that does not verify.
 *
 * So the "verify ONCE at the shared route and fan out" arrangement is not available here. It would
 * mean one of several keys silently deciding for the others: a delivery devplatform signed would be
 * refused by community's list, or worse, a delivery signed with one module's key would be accepted
 * as another's when that module's own listener would have refused it.
 *
 * This is wave M2's finding at larger scale — "a CNAME moves a host, not a path" — and it takes
 * M2's answer. Each module serves its OWN suffixed path with its OWN key against its OWN inbox, and
 * the bare path is agora's, so a subscription row nobody re-pointed is a LOUD failure recorded in
 * the producer's `outbox_deliveries.last_error` rather than an erasure that quietly reaches one
 * database out of several.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MOUNTED_EVENTS_PATH = '/v1/events/community'

/**
 * Routes this module must serve UNDER A NAMESPACE in the merged process, because their bare paths
 * collide with a module the public gateway already routes to.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **MATCHING IS FIRST-WINS, SO THE PUBLIC OWNER MUST KEEP THE BARE PATH.** Two of community's paths
 * are also served by a PUBLIC module:
 *
 *   * `GET /v1/scopes` is devplatform's public discovery route — `developers.<apex>/v1/scopes`,
 *     routed to this pod in `deploy/gateway/dynamic/public-api.yml`.
 *   * `DELETE /v1/posts/:id` is agora's — the square's own post deletion, public at the apex.
 *
 * community has NO public router of its own (`docs/network-consolidation.md` §… — community,
 * tessera and others are internal). So in both collisions community is the SECONDARY: if it kept
 * the bare path it would either shadow the public owner (a dead public surface) or be shadowed by
 * it (its own route unreachable). It remounts under `/v1/community/…` instead, exactly as the event
 * webhook remounts under `/v1/events/community`. `mergedroutes.test.ts` proves the merged table has
 * no shadow, and community's own `server.test.ts` drives `buildRoutes` directly and still sees the
 * bare paths — so the module's surface is unchanged, and the remount is a merge-only fact.
 *
 * The one thing this does NOT do by itself is re-point community's own callers (community-web). That
 * is the same follow-up the event split needs — a producer/consumer sweep onto the namespaced path —
 * and it is a deploy step, not a code change here. No in-estate SERVICE calls either route (tessera's
 * `communityclient` calls `/v1/communities`, not `/v1/scopes`), so nothing service-to-service breaks.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const REMOUNTED_PATHS: Readonly<Record<string, string>> = Object.freeze({
  '/v1/scopes': '/v1/community/scopes',
  '/v1/posts/:id': '/v1/community/posts/:id',
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
 * The bare `POST /v1/events` becomes `MOUNTED_EVENTS_PATH`, and the two paths that collide with a
 * public module become their `REMOUNTED_PATHS` entries — both are merge-only rewrites, invisible to
 * `buildRoutes` and therefore to this module's own suite.
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
