/**
 * The dashboard composition. One authenticated call, eleven tiles, eight upstreams.
 *
 * ── The property this file exists to have ──────────────────────────────────────────────────────
 *
 * A 200 with holes, never a 500. Rule 5 of design-system.md §6 states it as an exit criterion:
 * "every tile degrades alone — one slow upstream must cost one tile, not the page". The arithmetic
 * behind the rule is what makes it non-negotiable: seven upstreams at 99.9% availability composed
 * with `Promise.all` and a shared failure mode give a page at 99.3%, which is three hours of
 * downtime a month on the estate's most visible surface, caused entirely by the way it was
 * assembled. Composed independently, the page never goes down at all — it thins.
 *
 * ── The budget is the slowest tile, not the sum ────────────────────────────────────────────────
 *
 * The fan-out is concurrent, so seven 400ms upstreams cost 400ms. Two deadlines enforce that:
 * each `HttpClient` carries its own (`HUB_UPSTREAM_DEADLINE_MS`), and the whole composition is
 * raced against `HUB_DASHBOARD_DEADLINE_MS`. The second is not redundant. A peer that accepts a
 * connection and then writes one byte a second defeats a per-request timeout in some stacks, and
 * a tile whose loader is wedged for any reason at all must still not hold the page: when the
 * dashboard deadline fires, whatever has not arrived becomes an `unavailable` tile with a reason,
 * and the response goes out.
 *
 * ── Which tile depends on which upstream ───────────────────────────────────────────────────────
 *
 * Written down, in `TILE_SOURCES`, as data rather than as prose — the degradation tests read it,
 * so a tile that quietly acquires a second dependency fails the build instead of silently
 * widening the blast radius of one peer.
 *
 * ── THE TILE THAT WAS ALWAYS UNAVAILABLE, AND WHY THAT WAS A DEFECT RATHER THAN A GAP ──────────
 *
 * `notifications` used to have no upstream here at all: the tile was a constant, hard-coded
 * `unavailable` with a reason saying so. The comment that stood in this place called it "the
 * honest hole" and argued that a stated absence beats a silent one — which is true, and which
 * missed what the constant was actually doing to the page.
 *
 * `degraded` is computed from the tiles, and hub-web turns it into a banner. One permanently
 * unavailable tile therefore put **"notifications is not showing current data. Everything else on
 * this page is."** on every signed-in Overview in the estate, for ever, in the voice of an
 * incident. Measured on 2026-08-11 against both live networks:
 * `hub_tile_status_total{tile="notifications",status="unavailable"}` was 32 against
 * `hub_dashboard_ms_count` of 32 on mainnet and 29 against 29 on testnet — a hundred percent of
 * compositions since boot — while `notify`'s own tables held 172 notifications for 85 users and 77
 * for 37. The data existed the whole time; nothing here asked for it. A hole a user is shown an
 * alarm about is not an honest hole, it is a false alarm, and a false alarm that never clears
 * teaches people to ignore the banner that will one day be real.
 *
 * So it is wired. `notify` is the eighth upstream, read at `GET /notifications?userId=&limit=` with
 * a `notify:read` token, exactly as the old comment said it should be.
 *
 * What has NOT changed is the rule underneath it: the tile is still not synthesised from activity
 * records. Activity is a narrative; a notification is an addressed message with a read state that
 * `notify` owns. Deriving one from the other would put a read state in this service, and a field
 * that exists only here is a bug. `unread` is counted by notify across the whole inbox and passed
 * through untouched.
 */

import type { Logger, Metrics } from '@cloudsforge/telemetry'
import type { TtlCache } from './cache.ts'
import { EMPTY_PORTFOLIO, composePortfolio, type PortfolioView } from './portfolio.ts'
import { buildNextActions, type NextActions } from './nextactions.ts'
import {
  NotComposableError,
  loadTile,
  mapTile,
  unavailableTile,
  worstStatus,
  type Tile,
  type TileDeps,
} from './tiles.ts'
import {
  CACHE,
  PAGE,
  type ActivityRecord,
  type BillingEntitlement,
  type BillingSubscription,
  type DepositCredit,
  type IdentityMe,
  type NotificationRecord,
  type PolicyFreeze,
  type PricingRate,
  type Upstreams,
  type WalletRecord,
  type WithdrawalRecord,
} from './upstreams.ts'

/** Rule 4 of §6: activity on the dashboard is a preview of the last four, with one link out. */
export const ACTIVITY_PREVIEW = 4

/**
 * Which upstreams each tile is built from.
 *
 * The contract the degradation suite asserts against: with upstream X unreachable, every tile
 * whose sources include X must be `degraded` or `unavailable` **and** every tile whose sources do
 * not must still be `ok`. The second half is the one that catches a regression — it is what fails
 * when someone adds a convenient extra call inside a loader.
 */
export const TILE_SOURCES = Object.freeze({
  portfolio: Object.freeze(['ledger', 'pricing']),
  prices: Object.freeze(['pricing']),
  wallets: Object.freeze(['wallet']),
  deposits: Object.freeze(['wallet']),
  withdrawals: Object.freeze(['wallet']),
  activity: Object.freeze(['activity']),
  security: Object.freeze(['identity']),
  restrictions: Object.freeze(['policy']),
  entitlements: Object.freeze(['billing']),
  alerts: Object.freeze(['identity', 'policy']),
  notifications: Object.freeze(['notify']),
}) satisfies Readonly<Record<string, readonly string[]>>

/** Withdrawal states that are over. Everything else is still the user's business. */
const TERMINAL_WITHDRAWAL_STATES: ReadonlySet<string> = new Set([
  'settled',
  'failed',
  'refunded',
  'cancelled',
])

export interface SecurityView {
  readonly email: string
  readonly handle: string
  readonly emailVerified: boolean
  readonly roles: readonly string[]
  readonly sessionId: string
  /** How the current session authenticated. `pwd`, `otp`, and so on. */
  readonly amr: readonly string[]
  readonly mfaEnabled: boolean
  readonly factors: readonly {
    readonly id: string
    readonly kind: string
    readonly label: string
    readonly status: string
    readonly lastUsedAt: string | null
  }[]
  readonly recoveryCodesRemaining: number
  readonly organisations: IdentityMe['organisations']
}

export type AlertKind = 'mfa_disabled' | 'email_unverified' | 'account_frozen'

export interface SecurityAlert {
  readonly kind: AlertKind
  readonly severity: 'warning' | 'critical'
  readonly message: string
  readonly source: string
}

export interface DashboardTiles {
  readonly portfolio: Tile<PortfolioView>
  readonly prices: Tile<readonly PricingRate[]>
  readonly wallets: Tile<readonly WalletRecord[]>
  /** Deposits that have not yet been credited. Confirmation progress lives on the next-action card. */
  readonly deposits: Tile<readonly DepositCredit[]>
  /** Withdrawals that are not in a terminal state. */
  readonly withdrawals: Tile<readonly WithdrawalRecord[]>
  readonly activity: Tile<readonly ActivityRecord[]>
  readonly security: Tile<SecurityView | null>
  readonly restrictions: Tile<readonly PolicyFreeze[]>
  readonly entitlements: Tile<Entitlements>
  readonly alerts: Tile<readonly SecurityAlert[]>
  readonly notifications: Tile<Notifications>
}

export interface Entitlements {
  readonly entitlements: readonly BillingEntitlement[]
  readonly subscriptions: readonly BillingSubscription[]
}

export interface Notifications {
  /**
   * Unread across the whole inbox, not within `items`. notify counts it in its own query, so a
   * badge reading "12" above a list of five rows is right rather than inconsistent — see
   * `PAGE.notifications`.
   */
  readonly unread: number
  /** The newest few, whatever their read state. A preview, with a link out, like activity. */
  readonly items: readonly NotificationRecord[]
}

export interface Dashboard {
  readonly userId: string
  /** When this response was assembled. Distinct from `portfolio.pricedAt`, which is older. */
  readonly generatedAt: string
  readonly budgetMs: number
  readonly elapsedMs: number
  readonly tiles: DashboardTiles
  readonly nextActions: NextActions
  /** Tile names whose status is not `ok`. A summary for the client's own banner, and for alerting. */
  readonly degraded: readonly string[]
}

export interface DashboardDeps extends TileDeps {
  readonly upstreams: Upstreams
  readonly cache: TtlCache
  readonly metrics: Metrics
  readonly logger: Logger
  readonly dashboardDeadlineMs: number
}

export interface DashboardRequest {
  readonly userId: string
  /**
   * The caller's own bearer, forwarded to identity only. See `upstreams.ts` for why identity is
   * the one upstream not reached with a scoped service credential.
   *
   * `null` when the caller is an operator drawing somebody else's dashboard: their token
   * authenticates *them*, so forwarding it would return the operator's own MFA state and label it
   * as the subject's — a wrong answer presented confidently, which is worse than no answer. The
   * security tile reports itself unavailable with that reason instead.
   */
  readonly bearer: string | null
  readonly requestId: string
}

/**
 * Compose the dashboard.
 *
 * Resolves. It does not reject, and a caller that wraps it in a try/catch to produce a 500 has
 * misunderstood the design.
 */
export async function composeDashboard(
  deps: DashboardDeps,
  request: DashboardRequest,
): Promise<Dashboard> {
  const now = deps.now ?? (() => Date.now())
  const startedAt = now()
  const { userId, bearer, requestId } = request

  // The page-level ceiling. `AbortSignal.timeout` rather than a timer this file owns: rule 8 bans
  // a background timer that is not a leased job, and a per-request abort signal is neither
  // background nor something a leased job could express.
  const deadline = AbortSignal.timeout(deps.dashboardDeadlineMs)

  /**
   * Race one tile against the page deadline.
   *
   * The WORK is abandoned rather than cancelled when the deadline wins. `loadTile` never rejects,
   * so an abandoned promise cannot become an unhandled rejection; it settles later, writes its
   * result into the cache, and thereby makes the *next* request fast. Cancelling it would throw
   * that away.
   *
   * The DEADLINE, by contrast, is given up on the moment the work arrives, and that asymmetry was
   * a bug for as long as this function has existed. `AbortSignal.timeout` fires whether or not
   * anybody is still listening, so the losing branch used to run its body a full
   * `HUB_DASHBOARD_DEADLINE_MS` after the response had already gone out: ten `tile missed the
   * dashboard deadline` warnings and ten `hub_tile_status_total{status="unavailable"}` increments
   * per request, for tiles that had answered in milliseconds. It was invisible because the tile
   * value itself was discarded by the settled race — only the side effects escaped.
   *
   * They escaped into the one place that hurt. Measured live on 2026-08-11, EVERY guarded tile on
   * both networks reported `unavailable` exactly as many times as the dashboard had been composed
   * (mainnet 32 of 32, testnet 29 of 29) while every one of them was in fact serving `ok` — which
   * made the counter useless for answering "is this tile really broken", the question it exists to
   * answer, and which nearly buried the real defect this file was opened for. A metric that is
   * always at 100% is not a metric.
   */
  const guard = <T>(tile: string, upstream: string, empty: T, work: Promise<Tile<T>>) => {
    const expiry = whenAborted(deadline)
    return Promise.race([
      work.then((value) => {
        expiry.giveUp()
        return value
      }),
      expiry.promise.then(() => {
        deps.logger.warn('tile missed the dashboard deadline', {
          tile,
          upstream,
          budgetMs: deps.dashboardDeadlineMs,
        })
        deps.metrics.increment('hub_tile_status_total', { tile, status: 'unavailable' })
        return unavailableTile(
          upstream,
          empty,
          `${upstream} was still answering when the ${deps.dashboardDeadlineMs}ms dashboard deadline expired`,
        )
      }),
    ])
  }

  const tileDeps: TileDeps = deps.now
    ? {
        cache: deps.cache,
        metrics: deps.metrics,
        logger: deps.logger,
        network: deps.network,
        now: deps.now,
      }
    : { cache: deps.cache, metrics: deps.metrics, logger: deps.logger, network: deps.network }

  // Every read is started before the first is awaited. This line and the `Promise.all` below are
  // the whole of "the budget is the slowest tile, not the sum".
  const balancesPromise = guard(
    'portfolio',
    'ledger',
    [],
    loadTile(tileDeps, {
      tile: 'portfolio',
      upstream: 'ledger',
      key: `ledger:balances:${userId}`,
      ...CACHE.ledgerBalances,
      empty: [],
      load: () => deps.upstreams.ledgerBalances(userId, requestId),
    }),
  )

  const pricesPromise = guard(
    'prices',
    'pricing',
    [] as readonly PricingRate[],
    loadTile<readonly PricingRate[]>(tileDeps, {
      tile: 'prices',
      upstream: 'pricing',
      // Not keyed by user: the rate board is the same for everyone, which is exactly why it is
      // worth caching at all. Keying it per user would multiply the pricing load by the user count
      // for no gain.
      key: 'pricing:rates',
      ...CACHE.pricingRates,
      empty: [],
      load: () => deps.upstreams.pricingRates(requestId),
    }),
  )

  const walletsPromise = guard(
    'wallets',
    'wallet',
    [] as readonly WalletRecord[],
    loadTile<readonly WalletRecord[]>(tileDeps, {
      tile: 'wallets',
      upstream: 'wallet',
      key: `wallet:registry:${userId}`,
      ...CACHE.walletRegistry,
      empty: [],
      load: () => deps.upstreams.walletRegistry(userId, requestId),
    }),
  )

  const depositsPromise = guard(
    'deposits',
    'wallet',
    [] as readonly DepositCredit[],
    loadTile<readonly DepositCredit[]>(tileDeps, {
      tile: 'deposits',
      upstream: 'wallet',
      key: `wallet:deposits:pending:${userId}`,
      ...CACHE.walletDeposits,
      empty: [],
      // Filtered before the cache write, not after the read: the only two consumers — this tile
      // and the deposit card — both want deposits still in flight, and caching the filtered list
      // keeps one shape rather than two derivations of it.
      load: async () =>
        (await deps.upstreams.walletDeposits(userId, requestId)).filter((c) => !c.credited),
    }),
  )

  const withdrawalsPromise = guard(
    'withdrawals',
    'wallet',
    [] as readonly WithdrawalRecord[],
    loadTile<readonly WithdrawalRecord[]>(tileDeps, {
      tile: 'withdrawals',
      upstream: 'wallet',
      key: `wallet:withdrawals:active:${userId}`,
      ...CACHE.walletWithdrawals,
      empty: [],
      load: async () =>
        (await deps.upstreams.walletWithdrawals(userId, requestId)).filter(
          (w) => !TERMINAL_WITHDRAWAL_STATES.has(w.state),
        ),
    }),
  )

  const activityPromise = guard(
    'activity',
    'activity',
    [] as readonly ActivityRecord[],
    loadTile<readonly ActivityRecord[]>(tileDeps, {
      tile: 'activity',
      upstream: 'activity',
      key: `activity:preview:${userId}`,
      ...CACHE.activityFeed,
      empty: [],
      load: async () =>
        (await deps.upstreams.activityFeed(userId, ACTIVITY_PREVIEW, null, requestId)).records,
    }),
  )

  const securityPromise = guard(
    'security',
    'identity',
    null as SecurityView | null,
    loadTile<SecurityView | null>(tileDeps, {
      tile: 'security',
      upstream: 'identity',
      key: `identity:security:${userId}`,
      ...CACHE.identitySecurity,
      empty: null,
      load: async () => {
        if (bearer === null) {
          throw new NotComposableError(
            'identity exposes no service-readable route for the security state of another user; ' +
              'a service token is refused by /auth/me and /mfa/factors',
          )
        }
        // Two identity reads, concurrently, because they are one fact from the user's point of
        // view: "who am I and how well is this account protected". Failing either fails the tile,
        // which is correct — a security panel showing half of itself invites the wrong conclusion.
        const [me, mfa] = await Promise.all([
          deps.upstreams.identityMe(bearer, requestId),
          deps.upstreams.identityFactors(bearer, requestId),
        ])
        return {
          email: me.user.email,
          handle: me.user.handle,
          emailVerified: me.user.emailVerifiedAt !== null,
          roles: me.user.roles,
          sessionId: me.session.id,
          amr: me.session.amr,
          mfaEnabled: mfa.factors.some((factor) => factor.status === 'active'),
          factors: mfa.factors.map((factor) => ({
            id: factor.id,
            kind: factor.kind,
            label: factor.label,
            status: factor.status,
            lastUsedAt: factor.lastUsedAt,
          })),
          recoveryCodesRemaining: mfa.recoveryCodesRemaining,
          organisations: me.organisations,
        }
      },
    }),
  )

  const restrictionsPromise = guard(
    'restrictions',
    'policy',
    [] as readonly PolicyFreeze[],
    loadTile<readonly PolicyFreeze[]>(tileDeps, {
      tile: 'restrictions',
      upstream: 'policy',
      key: `policy:freezes:${userId}`,
      ...CACHE.policyFreezes,
      empty: [],
      load: () => deps.upstreams.policyFreezes(userId, requestId),
    }),
  )

  const entitlementsPromise = guard(
    'entitlements',
    'billing',
    { entitlements: [], subscriptions: [] } as Entitlements,
    loadTile<Entitlements>(tileDeps, {
      tile: 'entitlements',
      upstream: 'billing',
      key: `billing:access:${userId}`,
      ...CACHE.billingEntitlements,
      empty: { entitlements: [], subscriptions: [] },
      load: async () => {
        const [entitlements, subscriptions] = await Promise.all([
          deps.upstreams.billingEntitlements(userId, requestId),
          deps.upstreams.billingSubscriptions(userId, requestId),
        ])
        return { entitlements, subscriptions }
      },
    }),
  )

  const notificationsPromise = guard(
    'notifications',
    'notify',
    { unread: 0, items: [] } as Notifications,
    loadTile<Notifications>(tileDeps, {
      tile: 'notifications',
      upstream: 'notify',
      key: `notify:inbox:${userId}`,
      ...CACHE.notifications,
      empty: { unread: 0, items: [] },
      // Mapped inside the loader so the cache holds the tile's shape rather than the wire's:
      // `nextCursor` is a paging handle for a list this tile does not page, and caching it would
      // invite a later reader to follow a cursor into a page nobody asked for.
      load: async () => {
        const page = await deps.upstreams.notifications(userId, PAGE.notifications, requestId)
        return { unread: page.unread, items: page.notifications }
      },
    }),
  )

  const [
    balances,
    prices,
    wallets,
    deposits,
    withdrawals,
    activity,
    security,
    restrictions,
    entitlements,
    notifications,
  ] = await Promise.all([
    balancesPromise,
    pricesPromise,
    walletsPromise,
    depositsPromise,
    withdrawalsPromise,
    activityPromise,
    securityPromise,
    restrictionsPromise,
    entitlementsPromise,
    notificationsPromise,
  ])

  const portfolio = composePortfolioTile(balances, prices)
  const alerts = composeAlerts(security, restrictions)

  const tiles: DashboardTiles = {
    portfolio,
    prices,
    wallets,
    deposits,
    withdrawals,
    activity,
    security,
    restrictions,
    entitlements,
    alerts,
    notifications,
  }

  const nextActions = buildNextActions({
    deposits,
    withdrawals,
    factors: mapTile(security, (view) =>
      view === null
        ? null
        : { factors: view.factors, recoveryCodesRemaining: view.recoveryCodesRemaining },
    ),
    freezes: restrictions,
    subscriptions: mapTile(entitlements, (value) => value.subscriptions),
  })

  const elapsedMs = now() - startedAt
  deps.metrics.observe('hub_dashboard_ms', elapsedMs)

  return {
    userId,
    generatedAt: new Date(now()).toISOString(),
    budgetMs: deps.dashboardDeadlineMs,
    elapsedMs,
    tiles,
    nextActions,
    degraded: Object.entries(tiles)
      .filter(([, tile]) => (tile as Tile<unknown>).status !== 'ok')
      .map(([name]) => name),
  }
}

/**
 * Balances × prices.
 *
 * The asymmetry between the two inputs is the point, and it matches wallet's own portfolio read:
 * balances are load-bearing and prices are not. Without balances there is no portfolio — an empty
 * one is indistinguishable from a user who owns nothing, which is a far worse lie than a missing
 * number. Without prices there is still a portfolio: every holding, every amount, no valuation,
 * and a reason saying so.
 */
export function composePortfolioTile(
  balances: Tile<readonly import('./upstreams.ts').LedgerBalance[]>,
  prices: Tile<readonly PricingRate[]>,
): Tile<PortfolioView> {
  if (balances.status === 'unavailable') {
    return {
      status: 'unavailable',
      upstream: 'ledger',
      reason: balances.reason ?? 'balances are unavailable',
      cached: balances.cached,
      ageMs: balances.ageMs,
      data: EMPTY_PORTFOLIO,
    }
  }

  const view = composePortfolio(balances.data, prices.status === 'unavailable' ? [] : prices.data)

  // Note what this is *not*: `worstStatus`. A missing price board must not make the portfolio
  // unavailable, because every holding, every amount and every reserved figure is still exactly
  // right — only the valuation is missing, and it is missing visibly. Propagating pricing's
  // `unavailable` here would empty a tile that has most of its content.
  const status: Tile<unknown>['status'] =
    prices.status !== 'ok' || balances.status !== 'ok' || !view.pricingComplete ? 'degraded' : 'ok'

  const reasons: string[] = []
  if (balances.status !== 'ok' && balances.reason) reasons.push(balances.reason)
  if (prices.status !== 'ok' && prices.reason) reasons.push(prices.reason)
  // Stated even when both upstreams answered: a total that quietly excludes an asset is a wrong
  // total that looks right, and `pricingComplete` is the field a client turns into a footnote.
  if (!view.pricingComplete && reasons.length === 0) {
    reasons.push('some holdings have no usable price and are excluded from the total')
  }

  return {
    status,
    upstream: 'ledger',
    reason: reasons.length > 0 ? reasons.join('; ') : null,
    cached: balances.cached || prices.cached,
    ageMs: balances.ageMs,
    data: view,
  }
}

/**
 * Security alerts, derived from two tiles that have already been fetched.
 *
 * Derived rather than fetched: an alert is a reading of state somebody else owns, and a separate
 * call for it would be a second source of truth for the same fact. The status is the worse of the
 * two contributing tiles, so a panel missing its freezes never claims to be complete.
 */
export function composeAlerts(
  security: Tile<SecurityView | null>,
  restrictions: Tile<readonly PolicyFreeze[]>,
): Tile<readonly SecurityAlert[]> {
  const alerts: SecurityAlert[] = []

  if (security.status !== 'unavailable' && security.data) {
    if (!security.data.mfaEnabled) {
      alerts.push({
        kind: 'mfa_disabled',
        severity: 'warning',
        message: 'Two-factor authentication is not enabled on this account.',
        source: 'identity',
      })
    }
    if (!security.data.emailVerified) {
      alerts.push({
        kind: 'email_unverified',
        severity: 'warning',
        message: 'This email address has not been verified.',
        source: 'identity',
      })
    }
  }

  if (restrictions.status !== 'unavailable') {
    for (const freeze of restrictions.data) {
      if (freeze.clearedAt !== null) continue
      alerts.push({
        kind: 'account_frozen',
        severity: 'critical',
        message: `${freeze.scope} is frozen: ${freeze.reason}`,
        source: 'policy',
      })
    }
  }

  const status = worstStatus([security.status, restrictions.status])
  const reasons = [security.reason, restrictions.reason].filter((r): r is string => r !== null)
  return {
    status,
    upstream: 'identity+policy',
    reason: status === 'ok' ? null : reasons.join('; ') || 'a contributing upstream is unwell',
    cached: security.cached || restrictions.cached,
    ageMs: null,
    data: alerts,
  }
}

/** A deadline one tile is watching, and the ability to stop watching it. */
interface Expiry {
  /** Settles when the signal aborts, and never after `giveUp`. Never rejects, so it needs no catch. */
  readonly promise: Promise<void>
  /**
   * Stop watching. The promise is left permanently pending — deliberately, because the only
   * consumer is a `Promise.race` that has already settled by the time this is called, and a
   * pending branch of a settled race is inert. Resolving it instead would run the deadline body
   * for a tile that arrived on time, which is the phantom-metric bug described on `guard`.
   */
  giveUp(): void
}

function whenAborted(signal: AbortSignal): Expiry {
  let fire: (() => void) | null = null
  const promise = new Promise<void>((resolve) => {
    fire = resolve
  })
  const onAbort = () => fire?.()
  // Deferred rather than resolved on the spot in the already-aborted case: the caller has to be
  // able to give up before this settles, and a synchronously resolved promise is already out of
  // reach. (That case needs a fresh `AbortSignal.timeout` to have expired before the first `await`
  // of the same tick, so it is defensive rather than expected.)
  if (signal.aborted) queueMicrotask(onAbort)
  else signal.addEventListener('abort', onAbort, { once: true })
  return {
    promise,
    giveUp() {
      fire = null
      // Removed as well as neutered. Ten of these are attached per composition to a signal that
      // outlives the response by the whole budget; detaching them lets the closures go with the
      // request rather than with the timer.
      signal.removeEventListener('abort', onAbort)
    },
  }
}
