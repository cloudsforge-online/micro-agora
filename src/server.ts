/**
 * The HTTP surface.
 *
 * One file, one route table, and every route a line in it. The shape is market's, deliberately:
 * `compile()` turns `/v1/posts/:id` into a matcher whose parameter cannot swallow a `/`, the path
 * string is used verbatim as the metric label so cardinality is bounded by the number of routes,
 * and `handle()` owns the whole error→status map so no handler invents a status of its own.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE SUBJECT NEVER GOES ON THE WIRE.**
 *
 * A `Voice` row carries `subject` — the identity subject, `user:<uuid>` — because that is what
 * joins a voice to an account. `voiceWire()` does not copy it, and no other function in this file
 * puts it in a response body. This is not a hypothetical: a public square whose profile endpoint
 * returns the account id behind each handle hands anybody who scrapes it a join key against every
 * other service in the estate, and re-pseudonymising afterwards is impossible because the scrape
 * already happened. The handle is the identity here. Everything else about the account belongs to
 * identity, and this service is not a second copy of it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Who may read what
 *
 * Three lanes, and the difference between them is the whole access model:
 *
 *   * **Open.** `/v1/timeline/latest`, a tag page, a public profile, a thread. No token at all —
 *     a public square that requires an account to read is not public, and a crawler that cannot
 *     read it is a square nobody finds. `optionalViewerId` returns `null` for these callers and
 *     `posts.ts`'s visibility predicate does the rest: a logged-out reader sees public posts by
 *     unsuspended voices, and nothing else.
 *   * **Authenticated.** Anything that writes, and the reads that are about *you* — home timeline,
 *     bookmarks, notifications, whispers. `subjectOf` refuses a service token outright, because
 *     there is no service in this estate that should be posting as a person.
 *   * **Operator.** The moderation queue and the actions taken from it. `isAdmin` only: there is
 *     deliberately no service lane and therefore no `agora:*` scope, because every moderation
 *     action here is a human judgement with a human's name recorded beside it, and a scope that
 *     let a service take one would be a scope that let a compromised service empty the square.
 *
 * ## Why so many routes answer 404 for "not yours"
 *
 * `PostNotFoundError`, `CircleNotFoundError` and `WhisperNotFoundError` are all raised for both
 * "there is no such thing" and "there is, and it is not yours". A distinct 403 for the second is
 * an existence oracle: it lets somebody walk a range of ids and learn which followers-only posts
 * exist, which closed circles have members, and which pairs of people are talking. The one place
 * that is honest instead is `sendWhisper` — see its header; the recipient is a public profile the
 * sender is already looking at, so pretending they vanished at the moment of sending is a broken
 * product rather than a private one.
 */

import { timingSafeEqual } from 'node:crypto'
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
  subjectUserId,
  type Principal,
} from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { NetworkUnknownError, requestNetwork, type Network } from '@cloudsforge/http'
import type { NetworkSql } from '@cloudsforge/db'
import type { JobQueue } from '@cloudsforge/jobs'
import { SIGNATURE_HEADER, signEvent, withInbox, withOutbox, type Db } from './outbox.ts'
import { RateLimitError } from './ratelimit.ts'
import {
  HandleTakenError,
  VoiceError,
  VoiceStateError,
  bar,
  countsFor,
  ensureVoice,
  eraseSubject,
  findVoice,
  findVoiceByHandle,
  findVoiceBySubject,
  follow,
  hush,
  hushTag,
  listVoices,
  relationship,
  unbar,
  unfollow,
  unhush,
  unhushTag,
  updateVoice,
  acceptFollow,
  rejectFollow,
  type UpdateVoiceInput,
  type Voice,
  type WhispersFrom,
} from './voices.ts'
import {
  PostError,
  PostNotFoundError,
  PostRefusedError,
  activeTags,
  bookmarks,
  byCircle,
  byTag,
  byVoice,
  createPost,
  deletePost,
  editPost,
  home,
  latest,
  readPost,
  search,
  setEngagement,
  thread,
  type MediaInput,
  type Page,
  type Post,
  type PostDeps,
  type Visibility,
} from './posts.ts'
import {
  CircleError,
  CircleNotFoundError,
  CircleStateError,
  canRead,
  createCircle,
  decideMembership,
  findCircle,
  inviteToCircle,
  joinCircle,
  leaveCircle,
  listCircles,
  listMembers,
  myCircles,
  removeMember,
  setRole,
  updateCircle,
  type Circle,
  type CircleDeps,
  type CircleVisibility,
  type Member,
  type MemberRole,
  type MemberState,
} from './circles.ts'
import {
  WhisperError,
  WhisperNotFoundError,
  WhisperRefusedError,
  deleteWhisper,
  leaveThread,
  listThreads,
  markRead as markThreadRead,
  readThread,
  sendWhisper,
  unreadCount as unreadWhispers,
  type Thread,
  type Whisper,
  type WhisperDeps,
} from './whispers.ts'
import {
  listNotifications,
  markRead as markNotificationsRead,
  prefsFor,
  setPrefs,
  unreadCount as unreadNotifications,
  type EmailPrefs,
  type Notification,
  type NotificationDeps,
} from './notifications.ts'
import {
  ModerationError,
  ModerationNotFoundError,
  act,
  fileReport,
  historyFor,
  listReports,
  type ModerationActionKind,
  type ModerationDeps,
  type Report,
  type ReportReason,
  type ReportState,
  type SubjectKind,
} from './moderation.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

/**
 * The one topic this service consumes.
 *
 * An account deleted at identity has its voice, posts, whispers and graph HARD deleted here —
 * `eraseSubject`, not a soft delete. Everything else in this file soft-deletes so a thread keeps
 * its shape; erasure is the one case where that is the wrong answer, because a person exercising
 * a deletion right did not ask for a tombstone with their handle on it.
 */
export const USER_DELETED_TOPIC = 'identity.user.deleted'

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  /**
   * The per-network selector, NOT a handle.
   *
   * Deliberately not a `Db`: a route reaching for `deps.sql` would read whichever network this
   * process happened to open. `NetworkSql` has no query methods, so that mistake does not compile.
   * Routes use `ctx.sql`; the five domain dep objects are rebuilt per request by `forRequest`.
   */
  readonly sql: NetworkSql
  /**
   * The network to assume when no `CF-Network` arrives, or `undefined` to refuse.
   *
   * `CF_NETWORK_SINGLE`, for `pnpm dev`, which has no gateway in front of it. Unset in production,
   * where an unstamped request is a routing fault and guessing turns it into a silent
   * cross-network write.
   */
  readonly singleNetwork?: Network
  readonly producer: string
  readonly posts: PostDeps
  readonly circles: CircleDeps
  readonly whispers: WhisperDeps
  readonly notifications: NotificationDeps
  readonly moderation: ModerationDeps
  readonly followsPerHour: number
  /**
   * Where a **BROWSER** reaches micro-studio. Empty means this deployment has not been told, and
   * every `bytesUrl` is then `null` — which a client can render a sentence about, whereas a
   * guessed hostname is a broken avatar with no diagnosis. See `env.ts`.
   */
  readonly studioPublicUrl: string
  readonly queue: Pick<JobQueue, 'enqueue'>
  /** Verifies inbound event signatures, and signs outbound ones. */
  readonly eventSigningSecret: string
  readonly pageSizeMax: number
  readonly beforeScrape?: () => Promise<void>
}

/** Domain metrics, declared rather than inferred from a log line — AD-20. */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'agora_posts_total',
      help: 'Posts published, by kind and visibility. `kind=reply` far above `kind=post` is a square having conversations; the reverse is a square of announcements.',
      kind: 'counter',
      labels: ['kind', 'visibility'],
    })
    .register({
      name: 'agora_engagement_total',
      help: 'Sparks, echoes and bookmarks, by kind and whether they were switched on or off.',
      kind: 'counter',
      labels: ['kind', 'state'],
    })
    .register({
      name: 'agora_follows_total',
      help: 'Follows made, by resulting state. `pending` is protected voices, not a fault.',
      kind: 'counter',
      labels: ['state'],
    })
    .register({
      name: 'agora_whispers_total',
      help: 'Private messages sent. A count only — no route, no log line and no event carries a body.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'agora_rate_limited_total',
      help: 'Requests refused by the hourly limit, by action. A steady climb on `post` is a spam wave; a climb on `follow` is somebody mapping the graph.',
      kind: 'counter',
      labels: ['action'],
    })
    .register({
      name: 'agora_reports_total',
      help: 'Reports filed by people, by reason. Excludes the automatic ones the policy gate files.',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      name: 'agora_reports_open',
      help: 'Reports still open. Sampled hourly by the reaper jobs. A number that only grows is a queue nobody is reading.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'agora_moderation_actions_total',
      help: 'Moderation actions taken, by kind. `report_dismissed` is an action and is counted like any other — a queue that only ever actions is a queue with no floor.',
      kind: 'counter',
      labels: ['action'],
    })
    .register({
      name: 'agora_policy_degraded_total',
      help: 'Posts published while the policy gate was unreachable. Each filed an automatic report; a spike means the gate was absent, not merely slow.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'agora_notification_emails_total',
      help: 'Opted-in notification emails emitted onto the bus. Never mail anybody has not asked for per kind — see notifications.ts.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'agora_notifications_reaped_total',
      help: 'Notifications deleted by the retention sweep.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'agora_email_sweep_considered',
      help: 'Rows the last mail sweep looked at. Far above agora_notification_emails_total is the normal, correct state: almost nobody has opted in.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'agora_events_rejected_total',
      help: 'Inbound events refused, by reason. A climbing `bad_signature` is somebody probing the erasure endpoint.',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      name: 'agora_service_token_usable',
      help: 'Whether this process could authenticate to policy right now. 0 for longer than a scrape means every post is publishing through a degraded gate.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'agora_service_token_events_total',
      help: 'Service credential exchanges, by kind. `exchange_failed` is identity; `reminted_after_401` above zero is clock skew or a revoked credential.',
      kind: 'counter',
      labels: ['kind'],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9_:.-]{8,200}$/
const MAX_BODY_BYTES = 256 * 1024
const IDEMPOTENCY_HEADER = 'idempotency-key'
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const VISIBILITIES = new Set<Visibility>(['public', 'followers', 'circle'])
const WHISPERS_FROM = new Set<WhispersFrom>(['everyone', 'follows', 'nobody'])
const CIRCLE_VISIBILITIES = new Set<CircleVisibility>(['open', 'request', 'closed'])
const MEMBER_ROLES = new Set<MemberRole>(['member', 'steward'])
const MEMBER_STATES = new Set<MemberState>(['active', 'pending', 'banned'])
const SUBJECT_KINDS = new Set<SubjectKind>(['post', 'voice', 'circle', 'whisper'])
const REPORT_REASONS = new Set<ReportReason>([
  'spam',
  'abuse',
  'impersonation',
  'self_harm',
  'illegal',
  'misinformation',
  'other',
])
const REPORT_STATES = new Set<ReportState>(['open', 'actioned', 'dismissed'])
const ACTION_KINDS = new Set<ModerationActionKind>([
  'post_removed',
  'post_restored',
  'voice_suspended',
  'voice_restored',
  'circle_archived',
  'report_dismissed',
  'sensitive_applied',
])

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
   * Not a property of the process. One agora serves both estates since the network consolidation
   * (micro-deploy `docs/network-consolidation.md`), so "which network am I" has no answer and
   * "which network is this request" has exactly one.
   */
  readonly network: Network
  /**
   * The database handle for `network`, resolved ONCE, at the edge of the request.
   *
   * There are twenty-five direct uses and five domain dep objects downstream, and a boundary
   * enforced at thirty places has thirty chances to be wrong — each one a route reading mainnet
   * rows while serving a testnet reader, a query that SUCCEEDS and says nothing. Resolving once
   * and handing the result down makes the wrong thing unspellable: `deps.sql` is a `NetworkSql`
   * and has no query methods at all.
   */
  readonly sql: Db
}

/**
 * Routes that answer without belonging to a network.
 *
 * Kubelet probes the first two and Prometheus scrapes the third; none arrives through the gateway,
 * so none carries `CF-Network`. Three literal paths rather than a prefix or an opt-in flag: this is
 * an exemption from a data-isolation boundary, and it should take a deliberate edit here to widen
 * it. None of the three queries the database.
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
 * Compile `/v1/posts/:id` into a matcher. The segment pattern excludes `/` so a parameter cannot
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

    // ── THE NETWORK, THEN THE HANDLE, BEFORE ANY ROUTE RUNS ──────────────────────────────────
    //
    // `requestNetwork` REFUSES an unstamped request rather than assuming mainnet. A 500 here is a
    // routing fault made loud; the alternative is a misrouted testnet write landing in mainnet as
    // an ordinary-looking row that nothing will ever flag.
    //
    // ── EXCEPT FOR THE OPERATIONAL ENDPOINTS, AND THAT IS NOT A LOOPHOLE ──────────────────────
    //
    // `/livez`, `/readyz` and `/metrics` are probed by KUBELET and scraped by PROMETHEUS. Neither
    // goes through the gateway, so neither carries `CF-Network` and neither ever will. Refusing
    // them makes every health probe a 500, the pod never becomes ready, and the deployment
    // CrashLoopBackOffs — which is exactly what CI caught on the first build of this change.
    //
    // They are safe to exempt because none of them touches the database: they answer from the
    // Lifecycle and the metrics registry. `ctx.sql` is still populated for them, from a network
    // they did not name, so the exemption is narrow by construction — a route added to this set
    // that DID query would be reading an arbitrary network, which is why the set is three literal
    // paths rather than a prefix or a flag anyone can set.
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
      scoped = forRequest(deps, sql)
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
 *   * **403** — policy refused this post, or a whisper preference did. Both are honest refusals
 *     about a thing the caller can already see, so neither is disguised as a 404.
 *   * **404** — something named does not exist, or is not visible to this reader. The same answer
 *     on purpose; see the file header.
 *   * **409** — well formed, but the state refuses it: a handle already taken, a circle that would
 *     be left with no steward, an action against a voice that is already suspended.
 *   * **429** — the hourly limit. The only status here that carries a `retry-after`, and it comes
 *     off the error rather than being recomputed, so the header and the message cannot disagree.
 *   * **503** — posting is paused, or the verifier is unreachable. Temporary, and about us.
 */
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
    if (err instanceof RateLimitError) {
      deps.metrics.increment('agora_rate_limited_total', { action: err.action })
      return {
        status: 429,
        headers: { 'retry-after': String(err.retryAfterSeconds) },
        body: {
          error: {
            code: 'rate_limited',
            message: err.message,
            retryAfterSeconds: err.retryAfterSeconds,
            requestId: ctx.requestId,
          },
        },
      }
    }
    if (err instanceof PostRefusedError) {
      // The break-glass switch is a 503, not a 403. It is temporary and it is about us: telling
      // somebody their post was refused when the square is simply paused is a lie they would
      // reasonably take personally.
      if (err.reasons.includes('posting_disabled')) {
        return {
          status: 503,
          headers: { 'retry-after': '300' },
          body: {
            error: {
              code: 'posting_paused',
              message: 'posting is paused here at the moment; nothing already written is affected',
              requestId: ctx.requestId,
            },
          },
        }
      }
      return {
        status: 403,
        body: {
          error: {
            code: 'refused',
            message: err.message,
            // The reasons, so a client can say WHICH rule and a person can argue with it. A
            // refusal with no reason is a refusal nobody can appeal.
            reasons: err.reasons,
            requestId: ctx.requestId,
          },
        },
      }
    }
    if (err instanceof WhisperRefusedError) {
      return errorReply(403, 'whispers_closed', err.message, ctx.requestId)
    }
    if (
      err instanceof HandleTakenError ||
      err instanceof VoiceStateError ||
      err instanceof CircleStateError ||
      err instanceof ModerationError
    ) {
      return errorReply(409, 'state_conflict', err.message, ctx.requestId)
    }
    if (
      err instanceof PostNotFoundError ||
      err instanceof CircleNotFoundError ||
      err instanceof WhisperNotFoundError ||
      err instanceof ModerationNotFoundError ||
      err instanceof NotFoundError
    ) {
      return errorReply(404, 'not_found', err.message, ctx.requestId)
    }
    if (
      err instanceof BadRequestError ||
      err instanceof PostError ||
      err instanceof VoiceError ||
      err instanceof CircleError ||
      err instanceof WhisperError ||
      err instanceof RangeError
    ) {
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

    /* ------------------------------------------------------------------ inbound events */

    define('POST', '/v1/events', async (ctx, deps) => {
      const raw = await readRaw(ctx.req)
      const presented = headerOf(ctx.req, SIGNATURE_HEADER)
      if (!presented || !verifySignature(raw, deps.eventSigningSecret, presented)) {
        deps.metrics.increment('agora_events_rejected_total', { reason: 'bad_signature' })
        ctx.log.warn('an inbound event failed its signature check')
        return errorReply(401, 'bad_signature', 'the event signature did not verify', ctx.requestId)
      }

      let envelope: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new BadRequestError('an event envelope must be a JSON object')
        }
        envelope = parsed as Record<string, unknown>
      } catch {
        deps.metrics.increment('agora_events_rejected_total', { reason: 'malformed' })
        throw new BadRequestError('the event body is not valid JSON')
      }

      const topic = typeof envelope['topic'] === 'string' ? envelope['topic'] : ''
      const eventId = typeof envelope['id'] === 'string' ? envelope['id'] : ''
      if (!UUID.test(eventId)) {
        deps.metrics.increment('agora_events_rejected_total', { reason: 'malformed' })
        throw new BadRequestError('an event envelope must carry a uuid id')
      }
      if (topic !== USER_DELETED_TOPIC) {
        // Accepted and ignored, with a 202. A 4xx would make the producer's relay retry an event
        // it is correct to send and we are correct not to act on, for ever.
        deps.metrics.increment('agora_events_rejected_total', { reason: 'not_subscribed' })
        return { status: 202, body: { status: 'ignored', topic } }
      }

      const payload =
        typeof envelope['payload'] === 'object' && envelope['payload'] !== null
          ? (envelope['payload'] as Record<string, unknown>)
          : {}
      const subject =
        typeof payload['subject'] === 'string'
          ? payload['subject']
          : typeof payload['userId'] === 'string'
            ? `user:${payload['userId']}`
            : null
      if (!subject) throw new BadRequestError('the event payload must name a subject')

      const done = deps.lifecycle.track()
      try {
        const outcome = await withInbox(ctx.sql, topic, eventId, async (tx) =>
          eraseSubject(tx, subject),
        )
        if (outcome.status === 'duplicate') return { status: 200, body: { status: 'duplicate' } }
        return {
          status: 200,
          body: { status: 'processed', erased: outcome.value !== null },
        }
      } finally {
        done()
      }
    }),

    /* ------------------------------------------------------------------ the reader's own account */

    define('GET', '/v1/me', async (ctx, deps) => {
      const me = await requireVoice(ctx, deps)
      const [counts, prefs, notifications, whispers] = await Promise.all([
        countsFor(ctx.sql, me.id),
        prefsFor(ctx.sql, me.id),
        unreadNotifications(ctx.sql, me.id),
        unreadWhispers(ctx.sql, me.id),
      ])
      return {
        status: 200,
        body: {
          voice: voiceWire(me, deps.studioPublicUrl),
          // The three counts, and this is the ONLY route that returns them. Doc 41 §4's second
          // rule: they are yours to see and nobody else's to compare against.
          counts,
          emailPrefs: prefs,
          unread: { notifications, whispers },
        },
      }
    }),

    define('PATCH', '/v1/me', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const body = await readJson(ctx.req)
      const voice = await updateVoice(voiceDeps(ctx.sql, deps), subject, readVoiceInput(body), ctx.requestId)
      return { status: 200, body: { voice: voiceWire(voice, deps.studioPublicUrl) } }
    }),

    define('PUT', '/v1/me/email-prefs', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const body = await readJson(ctx.req)
      const prefs = await setPrefs(deps.notifications, subject, {
        ...(body['onReply'] !== undefined ? { onReply: readBool(body['onReply'], 'onReply') } : {}),
        ...(body['onMention'] !== undefined
          ? { onMention: readBool(body['onMention'], 'onMention') }
          : {}),
        ...(body['onFollow'] !== undefined ? { onFollow: readBool(body['onFollow'], 'onFollow') } : {}),
        ...(body['onWhisper'] !== undefined
          ? { onWhisper: readBool(body['onWhisper'], 'onWhisper') }
          : {}),
        ...(body['onModeration'] !== undefined
          ? { onModeration: readBool(body['onModeration'], 'onModeration') }
          : {}),
      })
      return { status: 200, body: { emailPrefs: prefs } }
    }),

    define('GET', '/v1/me/circles', async (ctx, deps) => {
      const me = await requireVoice(ctx, deps)
      const circles = await myCircles(ctx.sql, me.id)
      return { status: 200, body: { circles: circles.map((c) => circleWire(c, deps.studioPublicUrl)) } }
    }),

    /* ------------------------------------------------------------------ timelines */

    define('GET', '/v1/timeline/latest', async (ctx, deps) => {
      const viewerId = await optionalViewerId(ctx, deps)
      const page = await latest(deps.posts, {
        viewerId,
        limit: readLimit(ctx, deps),
        cursor: ctx.url.searchParams.get('cursor'),
      })
      return { status: 200, body: pageWire(page, deps.studioPublicUrl) }
    }),

    define('GET', '/v1/timeline/home', async (ctx, deps) => {
      const me = await requireVoice(ctx, deps)
      const page = await home(deps.posts, {
        viewerId: me.id,
        limit: readLimit(ctx, deps),
        cursor: ctx.url.searchParams.get('cursor'),
      })
      return { status: 200, body: pageWire(page, deps.studioPublicUrl) }
    }),

    define('GET', '/v1/timeline/tag/:tag', async (ctx, deps) => {
      const viewerId = await optionalViewerId(ctx, deps)
      const page = await byTag(deps.posts, ctx.params['tag'] ?? '', {
        viewerId,
        limit: readLimit(ctx, deps),
        cursor: ctx.url.searchParams.get('cursor'),
      })
      return { status: 200, body: pageWire(page, deps.studioPublicUrl) }
    }),

    define('GET', '/v1/search', async (ctx, deps) => {
      const viewerId = await optionalViewerId(ctx, deps)
      const page = await search(deps.posts, ctx.url.searchParams.get('q') ?? '', {
        viewerId,
        limit: readLimit(ctx, deps),
        cursor: ctx.url.searchParams.get('cursor'),
      })
      return { status: 200, body: pageWire(page, deps.studioPublicUrl) }
    }),

    define('GET', '/v1/tags/active', async (ctx, _deps) => {
      const tags = await activeTags(ctx.sql, 12)
      return { status: 200, body: { tags } }
    }),

    define('GET', '/v1/bookmarks', async (ctx, deps) => {
      const me = await requireVoice(ctx, deps)
      const page = await bookmarks(deps.posts, {
        viewerId: me.id,
        limit: readLimit(ctx, deps),
        cursor: ctx.url.searchParams.get('cursor'),
      })
      return { status: 200, body: pageWire(page, deps.studioPublicUrl) }
    }),

    /* ------------------------------------------------------------------ posts */

    define('POST', '/v1/posts', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const body = await readJson(ctx.req)
      const idempotencyKey = readIdempotencyKey(ctx)

      const result = await createPost(
        deps.posts,
        subject,
        {
          body: requireString(body, 'body'),
          ...(body['lang'] !== undefined ? { lang: String(body['lang']).slice(0, 12) } : {}),
          ...(body['inReplyToId'] !== undefined
            ? { inReplyToId: readOptionalUuid(body['inReplyToId'], 'inReplyToId') }
            : {}),
          ...(body['quoteOfId'] !== undefined
            ? { quoteOfId: readOptionalUuid(body['quoteOfId'], 'quoteOfId') }
            : {}),
          ...(body['circleId'] !== undefined
            ? { circleId: readOptionalUuid(body['circleId'], 'circleId') }
            : {}),
          ...(body['visibility'] !== undefined
            ? { visibility: requireEnum(body, 'visibility', VISIBILITIES) }
            : {}),
          ...(body['sensitive'] !== undefined
            ? { sensitive: readBool(body['sensitive'], 'sensitive') }
            : {}),
          ...(body['contentWarning'] !== undefined
            ? { contentWarning: String(body['contentWarning']).slice(0, 300) }
            : {}),
          media: readMedia(body['media']),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
        ctx.requestId,
      )

      if (result.created) {
        const kind = result.post.inReplyToId ? 'reply' : result.post.quoteOfId ? 'quote' : 'post'
        deps.metrics.increment('agora_posts_total', { kind, visibility: result.post.visibility })
        if (result.policy.degraded) deps.metrics.increment('agora_policy_degraded_total')
      }

      return {
        // 200 rather than 201 when the idempotency key matched: nothing was created, and a client
        // that retried a timed-out request should be able to tell that from the status alone.
        status: result.created ? 201 : 200,
        body: {
          post: postWire(result.post, deps.studioPublicUrl),
          // The verdict, always, including `allow`. A client that only sees it on a refusal has no
          // way to tell "published" from "published and queued for a human to look at".
          policy: { decision: result.policy.decision, degraded: result.policy.degraded },
        },
      }
    }),

    define('GET', '/v1/posts/:id', async (ctx, deps) => {
      const viewerId = await optionalViewerId(ctx, deps)
      const post = await readPost(ctx.sql, uuidParam(ctx, 'id'), viewerId)
      if (!post) throw new PostNotFoundError()
      return { status: 200, body: { post: postWire(post, deps.studioPublicUrl) } }
    }),

    define('GET', '/v1/posts/:id/thread', async (ctx, deps) => {
      const viewerId = await optionalViewerId(ctx, deps)
      const id = uuidParam(ctx, 'id')
      const root = await readPost(ctx.sql, id, viewerId)
      if (!root) throw new PostNotFoundError()
      // The thread hangs off the ROOT, so asking for a reply in the middle returns the whole
      // conversation rather than the tail of it. A reader who followed a link to a reply needs
      // what came before it more than they need what came after.
      const posts = await thread(deps.posts, root.rootId ?? root.id, viewerId)
      return {
        status: 200,
        body: {
          rootId: root.rootId ?? root.id,
          posts: posts.map((post) => postWire(post, deps.studioPublicUrl)),
        },
      }
    }),

    define('PATCH', '/v1/posts/:id', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const body = await readJson(ctx.req)
      const post = await editPost(
        deps.posts,
        subject,
        uuidParam(ctx, 'id'),
        {
          body: requireString(body, 'body'),
          ...(body['contentWarning'] !== undefined
            ? { contentWarning: String(body['contentWarning']).slice(0, 300) }
            : {}),
          ...(body['sensitive'] !== undefined
            ? { sensitive: readBool(body['sensitive'], 'sensitive') }
            : {}),
        },
        ctx.requestId,
      )
      return { status: 200, body: { post: postWire(post, deps.studioPublicUrl) } }
    }),

    define('DELETE', '/v1/posts/:id', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const deleted = await deletePost(deps.posts, subject, uuidParam(ctx, 'id'), ctx.requestId)
      if (!deleted) throw new PostNotFoundError()
      return { status: 204 }
    }),

    /* ------------------------------------------------------------------ engagement */

    define('PUT', '/v1/posts/:id/spark', engagementRoute('sparks', true)),
    define('DELETE', '/v1/posts/:id/spark', engagementRoute('sparks', false)),
    define('PUT', '/v1/posts/:id/echo', engagementRoute('echoes', true)),
    define('DELETE', '/v1/posts/:id/echo', engagementRoute('echoes', false)),
    define('PUT', '/v1/posts/:id/bookmark', engagementRoute('bookmarks', true)),
    define('DELETE', '/v1/posts/:id/bookmark', engagementRoute('bookmarks', false)),

    /* ------------------------------------------------------------------ voices */

    define('GET', '/v1/voices', async (ctx, deps) => {
      const page = await listVoices(ctx.sql, {
        ...(ctx.url.searchParams.get('q') ? { query: ctx.url.searchParams.get('q') as string } : {}),
        limit: readLimit(ctx, deps),
        cursor: ctx.url.searchParams.get('cursor'),
      })
      return {
        status: 200,
        body: {
          voices: page.voices.map((voice) => voiceWire(voice, deps.studioPublicUrl)),
          nextCursor: page.nextCursor,
        },
      }
    }),

    define('GET', '/v1/voices/:ref', async (ctx, deps) => {
      const viewerId = await optionalViewerId(ctx, deps)
      const voice = await resolveVoice(ctx.sql, ctx.params['ref'] ?? '')
      const wire: Record<string, unknown> = { voice: voiceWire(voice, deps.studioPublicUrl) }
      if (viewerId && viewerId !== voice.id) {
        wire['relationship'] = await relationship(ctx.sql, viewerId, voice.id)
      }
      if (viewerId === voice.id) wire['counts'] = await countsFor(ctx.sql, voice.id)
      return { status: 200, body: wire }
    }),

    define('GET', '/v1/voices/:ref/posts', async (ctx, deps) => {
      const viewerId = await optionalViewerId(ctx, deps)
      const voice = await resolveVoice(ctx.sql, ctx.params['ref'] ?? '')
      const page = await byVoice(deps.posts, voice.id, {
        viewerId,
        limit: readLimit(ctx, deps),
        cursor: ctx.url.searchParams.get('cursor'),
        includeReplies: ctx.url.searchParams.get('replies') === 'true',
      })
      return { status: 200, body: pageWire(page, deps.studioPublicUrl) }
    }),

    define('PUT', '/v1/voices/:ref/follow', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const target = await resolveVoice(ctx.sql, ctx.params['ref'] ?? '')
      const result = await follow(voiceDeps(ctx.sql, deps), subject, target.id, ctx.requestId)
      if (result.created) deps.metrics.increment('agora_follows_total', { state: result.state })
      return { status: 200, body: { state: result.state, created: result.created } }
    }),

    define('DELETE', '/v1/voices/:ref/follow', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const target = await resolveVoice(ctx.sql, ctx.params['ref'] ?? '')
      await unfollow(voiceDeps(ctx.sql, deps), subject, target.id)
      return { status: 204 }
    }),

    /**
     * Accept or refuse a follow request.
     *
     * `admit: false` deletes the row and tells the requester nothing, which is the point of a
     * request: somebody who learns their request was refused learns something about the other
     * person's opinion of them, and a protected account did not sign up to have that conversation.
     */
    define('PUT', '/v1/follow-requests/:ref', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const requester = await resolveVoice(ctx.sql, ctx.params['ref'] ?? '')
      const body = await readJson(ctx.req)
      const admit = readBool(body['admit'], 'admit')
      const changed = admit
        ? await acceptFollow(voiceDeps(ctx.sql, deps), subject, requester.id)
        : await rejectFollow(voiceDeps(ctx.sql, deps), subject, requester.id)
      return { status: 200, body: { changed } }
    }),

    define('PUT', '/v1/voices/:ref/bar', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const target = await resolveVoice(ctx.sql, ctx.params['ref'] ?? '')
      const created = await bar(voiceDeps(ctx.sql, deps), subject, target.id, ctx.requestId)
      return { status: 200, body: { barred: true, created } }
    }),

    define('DELETE', '/v1/voices/:ref/bar', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const target = await resolveVoice(ctx.sql, ctx.params['ref'] ?? '')
      await unbar(voiceDeps(ctx.sql, deps), subject, target.id)
      return { status: 204 }
    }),

    define('PUT', '/v1/voices/:ref/hush', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const target = await resolveVoice(ctx.sql, ctx.params['ref'] ?? '')
      const body = await readJson(ctx.req)
      await hush(voiceDeps(ctx.sql, deps), subject, target.id, readDate(body['expiresAt']))
      return { status: 200, body: { hushed: true } }
    }),

    define('DELETE', '/v1/voices/:ref/hush', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const target = await resolveVoice(ctx.sql, ctx.params['ref'] ?? '')
      await unhush(voiceDeps(ctx.sql, deps), subject, target.id)
      return { status: 204 }
    }),

    define('PUT', '/v1/tags/:tag/hush', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const body = await readJson(ctx.req)
      await hushTag(voiceDeps(ctx.sql, deps), subject, ctx.params['tag'] ?? '', readDate(body['expiresAt']))
      return { status: 200, body: { hushed: true } }
    }),

    define('DELETE', '/v1/tags/:tag/hush', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      await unhushTag(voiceDeps(ctx.sql, deps), subject, ctx.params['tag'] ?? '')
      return { status: 204 }
    }),

    /* ------------------------------------------------------------------ circles */

    define('GET', '/v1/circles', async (ctx, deps) => {
      const viewerId = await optionalViewerId(ctx, deps)
      const circles = await listCircles(ctx.sql, {
        ...(ctx.url.searchParams.get('q') ? { query: ctx.url.searchParams.get('q') as string } : {}),
        viewerId,
        limit: readLimit(ctx, deps),
      })
      return { status: 200, body: { circles: circles.map((c) => circleWire(c, deps.studioPublicUrl)) } }
    }),

    define('POST', '/v1/circles', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const body = await readJson(ctx.req)
      const circle = await createCircle(
        deps.circles,
        subject,
        {
          slug: requireString(body, 'slug'),
          name: requireString(body, 'name'),
          ...(body['purpose'] !== undefined ? { purpose: String(body['purpose']) } : {}),
          ...(body['visibility'] !== undefined
            ? { visibility: requireEnum(body, 'visibility', CIRCLE_VISIBILITIES) }
            : {}),
          ...(body['avatarAssetId'] !== undefined
            ? { avatarAssetId: readOptionalUuid(body['avatarAssetId'], 'avatarAssetId') }
            : {}),
        },
        ctx.requestId,
      )
      return { status: 201, body: { circle: circleWire(circle, deps.studioPublicUrl) } }
    }),

    define('GET', '/v1/circles/:ref', async (ctx, deps) => {
      const viewerId = await optionalViewerId(ctx, deps)
      const circle = await findCircle(ctx.sql, ctx.params['ref'] ?? '', viewerId)
      if (!circle) throw new CircleNotFoundError()
      return { status: 200, body: { circle: circleWire(circle, deps.studioPublicUrl) } }
    }),

    define('PATCH', '/v1/circles/:ref', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const circle = await requireCircle(ctx.sql, ctx.params['ref'] ?? '', null)
      const body = await readJson(ctx.req)
      const updated = await updateCircle(deps.circles, subject, circle.id, {
        ...(body['name'] !== undefined ? { name: String(body['name']) } : {}),
        ...(body['purpose'] !== undefined ? { purpose: String(body['purpose']) } : {}),
        ...(body['visibility'] !== undefined
          ? { visibility: requireEnum(body, 'visibility', CIRCLE_VISIBILITIES) }
          : {}),
        ...(body['avatarAssetId'] !== undefined
          ? { avatarAssetId: readOptionalUuid(body['avatarAssetId'], 'avatarAssetId') }
          : {}),
        ...(body['archived'] !== undefined ? { archived: readBool(body['archived'], 'archived') } : {}),
      })
      return { status: 200, body: { circle: circleWire(updated, deps.studioPublicUrl) } }
    }),

    define('GET', '/v1/circles/:ref/members', async (ctx, deps) => {
      const viewerId = await optionalViewerId(ctx, deps)
      const circle = await requireCircle(ctx.sql, ctx.params['ref'] ?? '', viewerId)
      // A stranger asking for the roster of a members-only circle gets the 404 a nonexistent
      // circle gets. See the file header: a 403 here confirms there are members worth hiding.
      if (!(await canRead(ctx.sql, circle, viewerId))) throw new CircleNotFoundError()
      const state = ctx.url.searchParams.get('state')
      const members = await listMembers(
        ctx.sql,
        circle.id,
        viewerId,
        state && MEMBER_STATES.has(state as MemberState) ? (state as MemberState) : 'active',
      )
      return { status: 200, body: { members: members.map((m) => memberWire(m, deps.studioPublicUrl)) } }
    }),

    define('GET', '/v1/circles/:ref/posts', async (ctx, deps) => {
      const viewerId = await optionalViewerId(ctx, deps)
      const circle = await requireCircle(ctx.sql, ctx.params['ref'] ?? '', viewerId)
      if (!(await canRead(ctx.sql, circle, viewerId))) throw new CircleNotFoundError()
      const page = await byCircle(deps.posts, circle.id, {
        viewerId,
        limit: readLimit(ctx, deps),
        cursor: ctx.url.searchParams.get('cursor'),
      })
      return { status: 200, body: pageWire(page, deps.studioPublicUrl) }
    }),

    define('PUT', '/v1/circles/:ref/membership', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const circle = await requireCircle(ctx.sql, ctx.params['ref'] ?? '', null)
      const result = await joinCircle(deps.circles, subject, circle.id)
      return { status: 200, body: { state: result.state, created: result.created } }
    }),

    define('DELETE', '/v1/circles/:ref/membership', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const circle = await requireCircle(ctx.sql, ctx.params['ref'] ?? '', null)
      const left = await leaveCircle(deps.circles, subject, circle.id)
      return { status: left ? 204 : 404, ...(left ? {} : { body: { error: { code: 'not_found' } } }) }
    }),

    /**
     * One route for the four things a steward does to one member.
     *
     * `admit`, `invite` and `role` are all "put this person into this state in this circle", and
     * three near-identical routes is three places for the steward check to drift apart.
     */
    define('PUT', '/v1/circles/:ref/members/:voice', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const circle = await requireCircle(ctx.sql, ctx.params['ref'] ?? '', null)
      const target = await resolveVoice(ctx.sql, ctx.params['voice'] ?? '')
      const body = await readJson(ctx.req)
      const action = requireString(body, 'action')

      switch (action) {
        case 'admit':
          return { status: 200, body: { changed: await decideMembership(deps.circles, subject, circle.id, target.id, true) } }
        case 'refuse':
          return { status: 200, body: { changed: await decideMembership(deps.circles, subject, circle.id, target.id, false) } }
        case 'invite':
          return { status: 200, body: { changed: await inviteToCircle(deps.circles, subject, circle.id, target.id) } }
        case 'role': {
          const role = requireEnum(body, 'role', MEMBER_ROLES)
          return { status: 200, body: { changed: await setRole(deps.circles, subject, circle.id, target.id, role) } }
        }
        default:
          throw new BadRequestError('action must be one of admit, refuse, invite, role')
      }
    }),

    define('DELETE', '/v1/circles/:ref/members/:voice', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const circle = await requireCircle(ctx.sql, ctx.params['ref'] ?? '', null)
      const target = await resolveVoice(ctx.sql, ctx.params['voice'] ?? '')
      const ban = ctx.url.searchParams.get('ban') === 'true'
      const changed = await removeMember(deps.circles, subject, circle.id, target.id, ban)
      return { status: 200, body: { changed, banned: ban && changed } }
    }),

    /* ------------------------------------------------------------------ whispers */

    define('GET', '/v1/whispers', async (ctx, deps) => {
      const me = await requireVoice(ctx, deps)
      const threads = await listThreads(deps.whispers, me.id, readLimit(ctx, deps))
      return { status: 200, body: { threads: threads.map((t) => threadWire(t, deps.studioPublicUrl)) } }
    }),

    define('POST', '/v1/whispers', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const body = await readJson(ctx.req)
      const target = await resolveVoice(ctx.sql, requireString(body, 'to'))
      const whisper = await sendWhisper(
        deps.whispers,
        subject,
        target.id,
        requireString(body, 'body'),
        ctx.requestId,
      )
      deps.metrics.increment('agora_whispers_total')
      return { status: 201, body: { whisper: whisperWire(whisper, deps.studioPublicUrl) } }
    }),

    define('GET', '/v1/whispers/:id', async (ctx, deps) => {
      const me = await requireVoice(ctx, deps)
      const page = await readThread(deps.whispers, me.id, uuidParam(ctx, 'id'), {
        limit: readLimit(ctx, deps),
        cursor: ctx.url.searchParams.get('cursor'),
      })
      return {
        status: 200,
        body: {
          whispers: page.whispers.map((w) => whisperWire(w, deps.studioPublicUrl)),
          nextCursor: page.nextCursor,
        },
      }
    }),

    define('PUT', '/v1/whispers/:id/read', async (ctx, deps) => {
      const me = await requireVoice(ctx, deps)
      await markThreadRead(deps.whispers, me.id, uuidParam(ctx, 'id'))
      return { status: 204 }
    }),

    define('DELETE', '/v1/whispers/:id', async (ctx, deps) => {
      const me = await requireVoice(ctx, deps)
      await leaveThread(deps.whispers, me.id, uuidParam(ctx, 'id'))
      return { status: 204 }
    }),

    define('DELETE', '/v1/whispers/messages/:id', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const deleted = await deleteWhisper(deps.whispers, subject, uuidParam(ctx, 'id'))
      if (!deleted) throw new WhisperNotFoundError()
      return { status: 204 }
    }),

    /* ------------------------------------------------------------------ notifications */

    define('GET', '/v1/notifications', async (ctx, deps) => {
      const me = await requireVoice(ctx, deps)
      const page = await listNotifications(deps.notifications, me.id, {
        limit: readLimit(ctx, deps),
        cursor: ctx.url.searchParams.get('cursor'),
        unreadOnly: ctx.url.searchParams.get('unread') === 'true',
      })
      return {
        status: 200,
        body: {
          notifications: page.notifications.map((n) => notificationWire(n, deps.studioPublicUrl)),
          nextCursor: page.nextCursor,
        },
      }
    }),

    define('PUT', '/v1/notifications/read', async (ctx, deps) => {
      const me = await requireVoice(ctx, deps)
      const body = await readJson(ctx.req)
      const id = body['id'] === undefined ? null : readOptionalUuid(body['id'], 'id')
      const marked = await markNotificationsRead(deps.notifications, me.id, id)
      return { status: 200, body: { marked } }
    }),

    /* ------------------------------------------------------------------ reporting */

    define('POST', '/v1/reports', async (ctx, deps) => {
      const subject = await requireSubject(ctx, deps)
      const body = await readJson(ctx.req)
      const reason = requireEnum(body, 'reason', REPORT_REASONS)
      const result = await fileReport(
        deps.moderation,
        subject,
        {
          subjectKind: requireEnum(body, 'subjectKind', SUBJECT_KINDS),
          subjectId: readUuid(body['subjectId'], 'subjectId'),
          reason,
          ...(body['detail'] !== undefined ? { detail: String(body['detail']) } : {}),
        },
        ctx.requestId,
      )
      if (result.created) deps.metrics.increment('agora_reports_total', { reason })
      // 202 whether it was new or a duplicate, with no id. See `fileReport`'s header: telling
      // somebody "you already reported this" invites an argument about whether the first one was
      // seen, and returning an id gives them something to poll that they have no right to read.
      return { status: 202, body: { status: 'received' } }
    }),

    /* ------------------------------------------------------------------ moderation */

    define('GET', '/v1/moderation/reports', async (ctx, deps) => {
      await requireOperator(ctx, deps)
      const state = ctx.url.searchParams.get('state')
      const reports = await listReports(ctx.sql, {
        ...(state && REPORT_STATES.has(state as ReportState) ? { state: state as ReportState } : {}),
        limit: readLimit(ctx, deps),
      })
      return { status: 200, body: { reports: reports.map(reportWire) } }
    }),

    define('POST', '/v1/moderation/actions', async (ctx, deps) => {
      const operator = await requireOperator(ctx, deps)
      const body = await readJson(ctx.req)
      const action = requireEnum(body, 'action', ACTION_KINDS)
      await act(
        deps.moderation,
        operator,
        {
          action,
          subjectKind: requireEnum(body, 'subjectKind', SUBJECT_KINDS),
          subjectId: readUuid(body['subjectId'], 'subjectId'),
          ...(body['reportId'] !== undefined
            ? { reportId: readOptionalUuid(body['reportId'], 'reportId') }
            : {}),
          ...(body['reason'] !== undefined ? { reason: String(body['reason']) } : {}),
        },
        ctx.requestId,
      )
      deps.metrics.increment('agora_moderation_actions_total', { action })
      return { status: 200, body: { status: 'acted' } }
    }),

    define('GET', '/v1/moderation/history/:kind/:id', async (ctx, deps) => {
      await requireOperator(ctx, deps)
      const kind = ctx.params['kind'] ?? ''
      if (!SUBJECT_KINDS.has(kind as SubjectKind)) throw new BadRequestError('unknown subject kind')
      const history = await historyFor(ctx.sql, kind as SubjectKind, uuidParam(ctx, 'id'))
      return {
        status: 200,
        body: {
          history: history.map((entry) => ({
            action: entry.action,
            operator: entry.operator,
            reason: entry.reason,
            createdAt: entry.createdAt.toISOString(),
          })),
        },
      }
    }),
  ]
}

/**
 * Spark, unspark, echo, unecho, bookmark, unbookmark — six routes, one handler.
 *
 * They are the same request with two flags, and six copies of it would be six places for the
 * visibility check to be forgotten in one of them.
 */
function engagementRoute(
  table: 'sparks' | 'echoes' | 'bookmarks',
  on: boolean,
): (ctx: RequestContext, deps: ServerDeps) => Promise<Reply> {
  return async (ctx, deps) => {
    const subject = await requireSubject(ctx, deps)
    const result = await setEngagement(
      deps.posts,
      subject,
      uuidParam(ctx, 'id'),
      table,
      on,
      ctx.requestId,
    )
    if (result.changed) {
      deps.metrics.increment('agora_engagement_total', { kind: table, state: on ? 'on' : 'off' })
    }
    return { status: 200, body: { changed: result.changed, count: result.count } }
  }
}

/* ------------------------------------------------------------------ wire shapes */

/**
 * A voice, as JSON.
 *
 * `subject` is NOT here and must never be. See the file header — it is the account id behind the
 * handle, and a public directory that leaks it hands a scraper a join key against the estate.
 */
function voiceWire(voice: Voice, base: string): Record<string, unknown> {
  return {
    id: voice.id,
    handle: voice.handle,
    displayName: voice.displayName,
    bio: voice.bio,
    avatarUrl: assetUrl(base, voice.avatarAssetId),
    bannerUrl: assetUrl(base, voice.bannerAssetId),
    location: voice.location,
    website: voice.website,
    whispersFrom: voice.whispersFrom,
    protected: voice.protected,
    discoverable: voice.discoverable,
    suspended: voice.suspendedAt !== null,
    createdAt: voice.createdAt.toISOString(),
  }
}

function postWire(post: Post, base: string): Record<string, unknown> {
  return {
    id: post.id,
    voiceId: post.voiceId,
    handle: post.handle,
    displayName: post.displayName,
    avatarUrl: assetUrl(base, post.avatarAssetId),
    body: post.body,
    lang: post.lang,
    inReplyToId: post.inReplyToId,
    rootId: post.rootId,
    quoteOfId: post.quoteOfId,
    circleId: post.circleId,
    visibility: post.visibility,
    sensitive: post.sensitive,
    contentWarning: post.contentWarning,
    // Reply, echo, spark and quote counts are counts of ACTIONS ON A POST, which is a different
    // thing from a follower count and is why doc 41 §4's second rule does not reach them: they
    // describe a conversation, not a person.
    replyCount: post.replyCount,
    echoCount: post.echoCount,
    sparkCount: post.sparkCount,
    quoteCount: post.quoteCount,
    editedAt: post.editedAt ? post.editedAt.toISOString() : null,
    createdAt: post.createdAt.toISOString(),
    deleted: post.deleted,
    media: post.media.map((item) => ({
      id: item.id,
      kind: item.kind,
      // Required by a CHECK constraint, not by a validator — doc 41 §5. An attachment without a
      // description is an attachment half the readers cannot read.
      alt: item.alt,
      bytesUrl: assetUrl(base, item.assetId),
    })),
    tags: post.tags,
    ...(post.viewer ? { viewer: post.viewer } : {}),
  }
}

function pageWire(page: Page, base: string): Record<string, unknown> {
  return {
    posts: page.posts.map((post) => postWire(post, base)),
    nextCursor: page.nextCursor,
  }
}

function circleWire(circle: Circle, base: string): Record<string, unknown> {
  return {
    id: circle.id,
    slug: circle.slug,
    name: circle.name,
    purpose: circle.purpose,
    visibility: circle.visibility,
    avatarUrl: assetUrl(base, circle.avatarAssetId),
    members: circle.members,
    archived: circle.archivedAt !== null,
    createdAt: circle.createdAt.toISOString(),
    ...(circle.viewer ? { viewer: circle.viewer } : {}),
  }
}

function memberWire(member: Member, base: string): Record<string, unknown> {
  return {
    voiceId: member.voiceId,
    handle: member.handle,
    displayName: member.displayName,
    avatarUrl: assetUrl(base, member.avatarAssetId),
    role: member.role,
    state: member.state,
    joinedAt: member.joinedAt.toISOString(),
  }
}

function threadWire(thread: Thread, base: string): Record<string, unknown> {
  return {
    id: thread.id,
    createdAt: thread.createdAt.toISOString(),
    lastPostAt: thread.lastPostAt.toISOString(),
    other: {
      voiceId: thread.other.voiceId,
      handle: thread.other.handle,
      displayName: thread.other.displayName,
      avatarUrl: assetUrl(base, thread.other.avatarAssetId),
    },
    unread: thread.unread,
    preview: thread.lastBody,
  }
}

function whisperWire(whisper: Whisper, base: string): Record<string, unknown> {
  return {
    id: whisper.id,
    threadId: whisper.threadId,
    voiceId: whisper.voiceId,
    handle: whisper.handle,
    displayName: whisper.displayName,
    avatarUrl: assetUrl(base, whisper.avatarAssetId),
    body: whisper.body,
    createdAt: whisper.createdAt.toISOString(),
    deleted: whisper.deleted,
  }
}

function notificationWire(notification: Notification, base: string): Record<string, unknown> {
  return {
    id: notification.id,
    kind: notification.kind,
    actor: notification.actor
      ? {
          voiceId: notification.actor.voiceId,
          handle: notification.actor.handle,
          displayName: notification.actor.displayName,
          avatarUrl: assetUrl(base, notification.actor.avatarAssetId),
        }
      : null,
    postId: notification.postId,
    circleId: notification.circleId,
    threadId: notification.threadId,
    detail: notification.detail,
    readAt: notification.readAt ? notification.readAt.toISOString() : null,
    createdAt: notification.createdAt.toISOString(),
  }
}

/**
 * A report, for the moderation queue.
 *
 * The reporter's handle IS returned here and only here, to an operator, because a queue in which
 * the same person files forty reports a day is a queue with a different problem from one with
 * forty reporters. It is never returned to the subject of the report, and there is no route that
 * would.
 */
function reportWire(report: Report): Record<string, unknown> {
  return {
    id: report.id,
    reporterHandle: report.reporterHandle,
    automatic: report.reporterId === null,
    subjectKind: report.subjectKind,
    subjectId: report.subjectId,
    reason: report.reason,
    detail: report.detail,
    state: report.state,
    resolution: report.resolution,
    resolvedBy: report.resolvedBy,
    resolvedAt: report.resolvedAt ? report.resolvedAt.toISOString() : null,
    createdAt: report.createdAt.toISOString(),
  }
}

/**
 * Where a browser fetches an asset, or `null` when this deployment has not been told.
 *
 * A guessed hostname is a broken avatar with no explanation. An explicit `null` is something a
 * client can render initials for. See `env.ts` on `STUDIO_PUBLIC_URL`.
 */
function assetUrl(base: string, assetId: string | null): string | null {
  if (!assetId || base === '') return null
  return `${base}/v1/assets/${assetId}/bytes`
}

/**
 * The deps a REQUEST sees: the process's deps, with every database handle replaced by the one
 * belonging to this request's network.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS SIX LINES RATHER THAN A REWRITE ────────────────────────────
 *
 * The five domain dep objects — `posts`, `circles`, `whispers`, `notifications`, `moderation` —
 * are built once at boot and each closes over a database handle. Thirty-two route sites read
 * them. Under one-pod-serves-both (micro-deploy `docs/network-consolidation.md`) a handle chosen
 * at startup is the wrong handle for half the traffic, and the failure is silent: the query
 * succeeds against the other network's rows and returns something plausible.
 *
 * They are PLAIN IMMUTABLE RECORDS, though, so the fix is to rebuild them rather than to
 * restructure how the service composes. One spread per object, once per request, and every one of
 * those thirty-two sites is correct without being touched — the same argument the apex
 * consolidation made for composing at the accessor instead of at every call site.
 *
 * Cheap on purpose: five shallow copies of small records, on a path that is about to do IO.
 */
function forRequest(deps: ServerDeps, sql: Db): ServerDeps {
  return {
    ...deps,
    posts: { ...deps.posts, sql },
    circles: { ...deps.circles, sql },
    whispers: { ...deps.whispers, sql },
    notifications: { ...deps.notifications, sql },
    moderation: { ...deps.moderation, sql },
  }
}

/* ------------------------------------------------------------------ helpers */

function voiceDeps(sql: Db, deps: ServerDeps): {
  sql: Db
  producer: string
  followsPerHour: number
} {
  // `sql` FIRST and separate from `deps`, so it reads as a property of the request rather than of
  // the process. See `RequestContext.sql`.
  return { sql, producer: deps.producer, followsPerHour: deps.followsPerHour }
}

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than
  // being a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

/**
 * The identity subject behind this request, refusing a service token.
 *
 * `subjectUserId(principal, undefined)` throws `TokenError` for a service principal, which lands
 * on the 401 path. That is the right answer: there is no service in this estate that should be
 * posting, following or whispering as a person, and a service lane here would be a lane a
 * compromised service could speak through in somebody else's name.
 */
async function requireSubject(ctx: RequestContext, deps: ServerDeps): Promise<string> {
  const principal = await authenticate(ctx, deps)
  return `user:${subjectUserId(principal, undefined)}`
}

/**
 * This request's voice, created if this is the account's first contact with the square.
 *
 * A read that writes, deliberately: the alternative is a 404 on `GET /v1/me` for somebody who has
 * an account and has simply never posted, and a client that has to POST something before it can
 * render an empty timeline. `ensureVoice` is idempotent and its handle is derived from the subject
 * hash, never from an email or a display name.
 */
async function requireVoice(ctx: RequestContext, deps: ServerDeps): Promise<Voice> {
  const subject = await requireSubject(ctx, deps)
  return withOutbox(ctx.sql, deps.producer, async (tx) => ensureVoice(tx, subject))
}

/**
 * The reading voice, or null.
 *
 * No `Authorization` header at all means a logged-out reader, and that is a supported, ordinary
 * caller on every open route. A header that IS present is verified: a client sending a stale token
 * should be told so rather than silently served the logged-out view of its own timeline, which is
 * the failure mode that reads as "my posts disappeared".
 */
async function optionalViewerId(ctx: RequestContext, deps: ServerDeps): Promise<string | null> {
  if (!headerOf(ctx.req, 'authorization')) return null
  const subject = await requireSubject(ctx, deps)
  const voice = await findVoiceBySubject(ctx.sql, subject)
  return voice ? voice.id : null
}

/**
 * The moderation gate: an administrator, and nothing else.
 *
 * No service lane and therefore no `agora:*` scope in the contracts registry. Every action taken
 * from the queue is a human judgement recorded with a human's name beside it, and a scope that let
 * a service suspend a voice would be a scope whose leak empties the square. Returns the operator's
 * identity, which `act` writes into `moderation_actions.operator`.
 */
async function requireOperator(ctx: RequestContext, deps: ServerDeps): Promise<string> {
  const principal = await authenticate(ctx, deps)
  if (principal.kind !== 'user' || !isAdmin(principal)) throw new ForbiddenError('role:admin')
  return `user:${principal.userId}`
}

/** A voice named by handle or by id. The two are interchangeable everywhere a voice is named. */
async function resolveVoice(sql: Db, ref: string): Promise<Voice> {
  const trimmed = ref.trim()
  const voice = UUID.test(trimmed)
    ? await findVoice(sql, trimmed)
    : await findVoiceByHandle(sql, trimmed)
  if (!voice) throw new NotFoundError('no such voice')
  return voice
}

/** A circle named by slug or by id, with the viewer's standing attached. */
async function requireCircle(
  sql: Db,
  ref: string,
  viewerId: string | null,
): Promise<Circle> {
  const circle = await findCircle(sql, ref.trim(), viewerId)
  if (!circle) throw new CircleNotFoundError()
  return circle
}

/**
 * A path parameter that will be compared against a `uuid` column.
 *
 * Checked in the application rather than left to Postgres, because Postgres answers a malformed
 * uuid with error 22P02 — which reaches the error handler as an unrecognised fault and becomes a
 * 500. A caller typing a wrong id would then get "something went wrong on our side" for a request
 * that was simply about a thing that does not exist.
 */
function uuidParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name] ?? ''
  if (!UUID.test(value)) throw new NotFoundError('no such record')
  return value
}

function readUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BadRequestError(`${field} must be a uuid`)
  }
  return value
}

function readOptionalUuid(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null
  return readUuid(value, field)
}

function readBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new BadRequestError(`${field} must be true or false`)
  return value
}

function readDate(value: unknown): Date | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new BadRequestError('a timestamp must be an ISO 8601 string')
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new BadRequestError(`${value} is not a valid timestamp`)
  return parsed
}

/** The page size, clamped by the service's own ceiling. There is no infinite scroll — doc 41 §5. */
function readLimit(ctx: RequestContext, deps: ServerDeps): number {
  const raw = ctx.url.searchParams.get('limit')
  if (!raw) return 20
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) throw new BadRequestError('limit must be a positive integer')
  return Math.min(parsed, deps.pageSizeMax)
}

function readIdempotencyKey(ctx: RequestContext): string | null {
  const presented = headerOf(ctx.req, IDEMPOTENCY_HEADER)
  if (!presented) return null
  if (!SAFE_IDEMPOTENCY_KEY.test(presented)) {
    throw new BadRequestError(`${IDEMPOTENCY_HEADER} must be 8 to 200 characters of [A-Za-z0-9_:.-]`)
  }
  return presented
}

function readMedia(value: unknown): readonly MediaInput[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new BadRequestError('media must be an array')
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new BadRequestError('each attachment must be an object')
    }
    const record = entry as Record<string, unknown>
    return {
      assetId: readUuid(record['assetId'], 'assetId'),
      // Not defaulted to an empty string. The column has a CHECK and the product has a rule, and
      // a route that quietly supplies "" for a missing description is a route that turns the rule
      // into a suggestion.
      alt: requireString(record, 'alt'),
      ...(record['kind'] !== undefined
        ? { kind: requireEnum(record, 'kind', new Set(['image', 'video', 'audio'] as const)) }
        : {}),
    }
  })
}

function readVoiceInput(body: Record<string, unknown>): UpdateVoiceInput {
  return {
    ...(body['handle'] !== undefined ? { handle: String(body['handle']) } : {}),
    ...(body['displayName'] !== undefined ? { displayName: String(body['displayName']) } : {}),
    ...(body['bio'] !== undefined ? { bio: String(body['bio']) } : {}),
    ...(body['avatarAssetId'] !== undefined
      ? { avatarAssetId: readOptionalUuid(body['avatarAssetId'], 'avatarAssetId') }
      : {}),
    ...(body['bannerAssetId'] !== undefined
      ? { bannerAssetId: readOptionalUuid(body['bannerAssetId'], 'bannerAssetId') }
      : {}),
    ...(body['location'] !== undefined ? { location: String(body['location']) } : {}),
    ...(body['website'] !== undefined ? { website: String(body['website']) } : {}),
    ...(body['whispersFrom'] !== undefined
      ? { whispersFrom: requireEnum(body, 'whispersFrom', WHISPERS_FROM) }
      : {}),
    ...(body['protected'] !== undefined ? { protected: readBool(body['protected'], 'protected') } : {}),
    ...(body['discoverable'] !== undefined
      ? { discoverable: readBool(body['discoverable'], 'discoverable') }
      : {}),
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${field} is required`)
  }
  return value.trim()
}

function requireEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<T>,
): T {
  const value = requireString(body, field)
  if (!allowed.has(value as T)) {
    throw new BadRequestError(`${field} must be one of ${[...allowed].join(', ')}`)
  }
  return value as T
}

/**
 * Verify a MAC over the exact bytes received, in constant time.
 *
 * Timing-safe because a byte-at-a-time comparison of a MAC is a byte-at-a-time forgery oracle: an
 * attacker who can measure the comparison can recover a valid signature one character at a time
 * without ever knowing the key.
 */
function verifySignature(body: Buffer, secret: string, presented: string): boolean {
  const expected = Buffer.from(signEvent(body.toString('utf8'), secret))
  const actual = Buffer.from(presented)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/** The raw bytes, for the signature check. Capped before buffering. */
async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // An unbounded body is a memory exhaustion primitive that any UNAUTHENTICATED caller can
    // reach on this route, since the signature cannot be checked until the bytes are in hand.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req)
  if (raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
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
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export type { EmailPrefs, Reply }
