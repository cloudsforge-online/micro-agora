/**
 * The eight upstreams, as this service actually calls them.
 *
 * Every type below was read off the peer's `src/server.ts`, not off a shared client library and
 * not off an expectation. Where a route this dashboard obviously wants does not exist, that is
 * recorded here in a comment rather than papered over with a derived value, because the fix is a
 * route on the owning service and a comment is how the next person finds that out.
 *
 * ── Why a client per upstream, and a credential per upstream ───────────────────────────────────
 *
 * One `HttpClient` per peer, because `@cloudsforge/http` scopes its circuit breaker to the client
 * instance. A shared client would give the estate one breaker: pricing having a bad minute would
 * open the circuit on the ledger, and the dashboard would lose every tile over one sick peer —
 * the precise cascade the per-tile design exists to prevent.
 *
 * One token per peer, because AD-05 says so and because this service is the highest-fan-out
 * surface in the estate. `HUB_WALLET_TOKEN` carries `wallet:read` and nothing else, so an attacker
 * who reaches this process's environment gets seven read credentials rather than one credential that
 * can move money.
 *
 * ── Identity is the exception, and it is not a shortcut ────────────────────────────────────────
 *
 * `GET /auth/me` and `GET /mfa/factors` are guarded by identity's `authenticateUser`, which
 * explicitly refuses a service token: "a service token accepted where a user token was expected
 * makes `sub` — a service name — look like a user id". No credential this service could hold would
 * reach them. So identity is called with the *caller's own* bearer, forwarded verbatim, which is
 * safe in the narrow sense that matters: identity issued that token, it is being returned to its
 * issuer, and it authorises exactly the user whose dashboard is being drawn — never more.
 *
 * What would remove the exception: a service-readable `GET /internal/users/:id/security` on
 * identity, returning MFA state and session count for a service token holding `identity:read`.
 * Until it exists, an operator loading another user's dashboard cannot see that user's security
 * tile, and the tile degrades rather than lying. That is a listed gap, not a design.
 *
 * ── The TTL table ──────────────────────────────────────────────────────────────────────────────
 *
 * Each value is stated with the reason for it, because an unexplained TTL is a number nobody dares
 * change. The rule behind all of them: the TTL is shorter than the interval at which the
 * underlying fact can change *and matter*. The stale window — how long a value may be served after
 * the upstream stops answering, always labelled `degraded` — is uniformly longer, because a stale
 * labelled number beats a hole, and it is bounded so a long outage ends in a hole rather than in
 * an ancient number.
 */

import { HttpClient } from '@cloudsforge/http'
import {
  ServiceTokenProvider,
  ServiceTokenUnavailableError,
  type ProviderEvent,
} from '@cloudsforge/auth'
import type { AssetCode, Network } from '@cloudsforge/contracts-chain'
import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { Metrics } from '@cloudsforge/telemetry'
import type { LiveScope } from '@cloudsforge/contracts-auth'
import type { Env } from './env.ts'

/* ------------------------------------------------------------------ cache policy */

export interface CachePolicy {
  readonly ttlMs: number
  readonly staleMs: number
}

/**
 * How long each upstream's answer stays good, and how long it may be served after that upstream
 * stops answering.
 *
 * The spread across these is deliberate and is the argument for caching at all: the surface
 * registry changes daily and the balances change per transaction, so one global TTL would either
 * make wallets needlessly expensive or make money needlessly wrong.
 */
// Declared as a literal rather than as `Record<string, CachePolicy>`: under
// `noUncheckedIndexedAccess` an index signature makes every lookup `CachePolicy | undefined`, so a
// spread of `...CACHE.ledgerBalances` would silently become optional and a missing TTL would type-
// check. `satisfies` keeps the shape checked and the keys exact.
export const CACHE = Object.freeze({
  /**
   * Balances. 3 seconds — effectively "collapse a burst", not "cache".
   *
   * A balance is the number a user watches change after they press a button. Anything longer and
   * the dashboard shows the state before their own action, which reads as the action having
   * failed. Three seconds still absorbs the double-load a page refresh produces and the parallel
   * hit from `/v1/dashboard` and `/v1/portfolio` when both are open.
   */
  ledgerBalances: Object.freeze({ ttlMs: 3_000, staleMs: 60_000 }),

  /**
   * Deposits in flight. 5 seconds — the confirmation counter is the thing the user is watching
   * tick, and a stalled counter is indistinguishable from a stalled deposit. The stale window is
   * short for the same reason: a confirmation count from two minutes ago is actively misleading
   * about how much longer there is to wait.
   */
  walletDeposits: Object.freeze({ ttlMs: 5_000, staleMs: 60_000 }),

  /** Withdrawals in flight. 5 seconds, and for the same reason as deposits. */
  walletWithdrawals: Object.freeze({ ttlMs: 5_000, staleMs: 60_000 }),

  /**
   * Conversions and transfers. 3 seconds — the balances number, not the withdrawals one.
   *
   * A conversion is INSTANT: the entry is written inside the same transaction that moves both
   * balances, so unlike a withdrawal there is no "settling" state for a user to wait through. The
   * moment after they press Convert they are looking for their own conversion in this list, and a
   * five-second cache would put a hole where it should be — read by that user as the conversion
   * not having happened, on the one screen where that reading is most expensive. Matched to
   * `ledgerBalances` deliberately: those two are rendered side by side and a user who sees the new
   * balance but not the record it came from has been shown two versions of one fact.
   */
  walletConversions: Object.freeze({ ttlMs: 3_000, staleMs: 60_000 }),

  /**
   * The wallet registry. 60 seconds.
   *
   * Every field in it — label, primary flag, lifecycle state, origin — changes only by an
   * explicit user action, and one that happens on a different page. A minute of staleness costs a
   * user nothing; the alternative costs the wallet service a query per dashboard load per user.
   */
  walletRegistry: Object.freeze({ ttlMs: 60_000, staleMs: 15 * 60_000 }),

  /**
   * Prices. 15 seconds.
   *
   * Bounded *below* by honesty rather than by cost: the response carries pricing's own `quotedAt`,
   * so a cached rate does not misreport when the market was observed. Bounded above by the
   * oracle's own round time — caching a quote for longer than pricing takes to replace it means
   * the timestamp we print is systematically older than the one available for the asking.
   */
  pricingRates: Object.freeze({ ttlMs: 15_000, staleMs: 5 * 60_000 }),

  /**
   * Activity. 10 seconds. The feed is a preview of the last four entries (design-system §6 rule 4)
   * and the full feed is its own page, so ten seconds of lag on a preview is invisible — while the
   * feed is the single most-read query in the estate and worth collapsing.
   */
  activityFeed: Object.freeze({ ttlMs: 10_000, staleMs: 5 * 60_000 }),

  /**
   * MFA and account state. 30 seconds.
   *
   * Short despite changing rarely, because of what it drives: the "2FA is not enabled" card. A
   * user who has just enabled MFA and still sees the card believes the enrolment failed, and the
   * support cost of that is far above the cost of the call.
   */
  identitySecurity: Object.freeze({ ttlMs: 30_000, staleMs: 10 * 60_000 }),

  /**
   * Entitlements and subscriptions. 5 minutes.
   *
   * The longest TTL here, and the safest: billing already serves `active` and `confersAccess`
   * computed at an explicit instant, so this cache holds a decision rather than a number, and a
   * subscription's period boundary is a date rather than a moment. Nothing a user does on this
   * dashboard changes it.
   */
  billingEntitlements: Object.freeze({ ttlMs: 5 * 60_000, staleMs: 30 * 60_000 }),

  /**
   * Notifications. 10 seconds.
   *
   * The same number as the activity feed and for the first half of the same reason — the tile is a
   * preview of the newest few, and ten seconds of lag on a preview is invisible. The second half is
   * different and is what stops it being longer: this tile carries an UNREAD COUNT, and a badge is
   * the one thing on the page a user expects to react to their own action. `POST
   * /notifications/:id/read` lands on notify, not here, so this cache is the only thing between
   * marking one read and the badge agreeing — and a count that keeps insisting on the old number
   * reads as the action having failed, which is the same argument that keeps balances at three
   * seconds.
   */
  notifications: Object.freeze({ ttlMs: 10_000, staleMs: 5 * 60_000 }),

  /**
   * Freezes. 30 seconds.
   *
   * A freeze is a safety signal, and the direction of error is asymmetric: showing a freeze that
   * has just been cleared is a moment of confusion, while failing to show one that has just been
   * applied is a user who does not understand why their withdrawal was refused. Short, therefore,
   * and with a stale window that keeps it visible through a policy outage.
   */
  policyFreezes: Object.freeze({ ttlMs: 30_000, staleMs: 10 * 60_000 }),
}) satisfies Readonly<Record<string, CachePolicy>>

/* ------------------------------------------------------------------ wire types */

/** `ledger` — `GET /accounts/:subject/balances`. Mirrors `BalanceView` in ledger/src/accounts.ts. */
export interface LedgerBalance {
  readonly accountId: string
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly purpose: string
  readonly type: string
  readonly status: string
  /** Smallest units, as a decimal string. Never a JSON number: it is a 78-bit quantity. */
  readonly amount: string
  readonly asOfEntryId: string | null
  readonly updatedAt: string | null
}

/** `wallet` — `GET /v1/wallets`. Mirrors `WalletRecord` in wallet/src/wallets.ts. */
export interface WalletRecord {
  readonly id: string
  readonly userId: string
  readonly origin: 'managed' | 'external' | 'watch'
  readonly chain: AssetCode
  readonly network: Network
  readonly address: string
  readonly label: string | null
  readonly isPrimary: boolean
  readonly status: 'provisioning' | 'active' | 'frozen' | 'exported' | 'retiring' | 'retired'
  readonly custodyKeyUrn: string | null
  readonly createdAt: string
  readonly verifiedAt: string | null
  readonly exportedAt: string | null
  readonly retiredAt: string | null
}

/** `wallet` — `GET /v1/deposits/credits`. Mirrors `DepositCreditView` in wallet/src/deposits.ts. */
export interface DepositCredit {
  readonly id: string
  readonly assetCode: string
  readonly amount: string
  readonly amountFormatted: string
  readonly chain: string
  readonly network: string
  readonly txHash: string
  readonly txUrn: string
  readonly explorerUrl: string | null
  readonly confirmations: number
  readonly credited: boolean
}

/** `wallet` — `GET /v1/withdrawals`. Mirrors `WithdrawalRecord` in wallet/src/withdrawals.ts. */
export interface WithdrawalRecord {
  readonly id: string
  readonly userId: string
  readonly chain: string
  readonly network: string
  readonly assetCode: string
  readonly destination: string
  readonly amount: string
  readonly amountFormatted: string
  readonly fee: string
  readonly net: string
  readonly netFormatted: string
  readonly state:
    | 'requested'
    | 'reserved'
    | 'queued'
    | 'settling'
    | 'settled'
    | 'stuck'
    | 'failed'
    | 'refunded'
    | 'cancelled'
  readonly txHash: string | null
  readonly failureReason: string | null
  readonly requestedAt: string
  readonly updatedAt: string
}

/* ---------------------------------------------------------- the exchange desk (micro-org#495) */

/**
 * `wallet` — one conversion, out of `GET /v1/conversions`. Mirrors `ConversionView`, money.ts.
 *
 * `id` is the id of the JOURNAL ENTRY that is the conversion. wallet keeps no conversions table —
 * "the entry IS the conversion, and a wallet-side copy would be a second record of one fact" — so
 * this id is what `GET /v1/conversions/:id` takes and what an activity row's `subjectUrn` names.
 *
 * Every amount is smallest units as a decimal string, with the human form beside it. Never a JSON
 * number: these are 78-bit quantities and `JSON.parse` would silently round one.
 */
export interface ConversionRecord {
  readonly id: string
  readonly occurredAt: string
  readonly recordedAt: string
  readonly fromAssetCode: string
  readonly fromAmount: string
  readonly fromAmountFormatted: string
  readonly toAssetCode: string
  readonly toAmount: string
  readonly toAmountFormatted: string
  readonly rateScale: string
  /** When the price behind the conversion was observed. Null for an entry booked before #495. */
  readonly quotedAt: string | null
}

export interface ConversionPage {
  readonly conversions: readonly ConversionRecord[]
  readonly nextCursor: string | null
}

/**
 * `wallet` — one transfer, out of `GET /v1/transfers`. Mirrors `TransferView`, money.ts.
 *
 * Both directions are in one list because the ledger's subject filter returns an entry that touches
 * this user's account whichever side of it they were on. `counterpartyUserId` is null when the other
 * leg is not a user account.
 */
export interface TransferRecord {
  readonly id: string
  readonly occurredAt: string
  readonly recordedAt: string
  readonly direction: 'out' | 'in'
  readonly assetCode: string
  readonly amount: string
  readonly amountFormatted: string
  readonly counterpartyUserId: string | null
}

export interface TransferPage {
  readonly transfers: readonly TransferRecord[]
  readonly nextCursor: string | null
}

/**
 * `wallet` — `POST /v1/conversions/quote`. Mirrors `ConversionQuote`, money.ts.
 *
 * **`hold` and `holdNotice` are forwarded, never dropped and never summarised.** They are fields
 * rather than a paragraph in wallet's API docs for one reason, stated there: nothing is reserved by
 * asking, the rate and the desk's inventory can both move before the conversion, and "a surface that
 * renders a quote as though it were a hold is making a promise this service has not made". A BFF
 * that ate the sentence on the way past would put that promise back.
 */
export interface ConversionQuote {
  readonly fromAssetCode: string
  readonly fromAmount: string
  readonly fromAmountFormatted: string
  readonly toAssetCode: string
  readonly toAmount: string
  readonly toAmountFormatted: string
  readonly rateScale: string
  readonly quotedAt: string
  readonly hold: false
  readonly holdNotice: string
}

/** `wallet` — what a booked conversion answers with. Mirrors `MoneyResult`, money.ts. */
export interface ConversionReceipt {
  readonly entryId: string
  /** True when this key had already been used: the same conversion, not a second one. */
  readonly replayed: boolean
  readonly summary: {
    readonly fromAssetCode: string
    readonly fromAmount: string
    readonly fromAmountFormatted: string
    readonly toAssetCode: string
    readonly toAmount: string
    readonly toAmountFormatted: string
    readonly quotedAt: string
  }
}

/** What a caller asks the desk for. The same body both money routes take. */
export interface ConversionIntent {
  readonly fromAssetCode: string
  readonly toAssetCode: string
  /** Smallest units, decimal string. */
  readonly amount: string
}

/** `identity` — `GET /auth/me`. */
export interface IdentityMe {
  readonly user: {
    readonly id: string
    readonly email: string
    readonly emailVerifiedAt: string | null
    readonly handle: string
    readonly status: string
    readonly roles: readonly string[]
    readonly createdAt: string
    readonly lastSeenAt: string | null
  }
  readonly session: { readonly id: string; readonly amr: readonly string[] }
  readonly organisations: readonly { readonly id: string; readonly name: string }[]
}

/** `identity` — `GET /mfa/factors`. */
export interface IdentityFactors {
  readonly factors: readonly {
    readonly id: string
    readonly kind: string
    readonly label: string
    readonly status: string
    readonly lastUsedAt: string | null
    readonly createdAt: string
  }[]
  readonly recoveryCodesRemaining: number
}

/** `billing` — `GET /internal/entitlements/:userId`. */
export interface BillingEntitlement {
  readonly id: string
  readonly sku: string
  readonly scope: string
  readonly source: string
  readonly grantedAt: string
  readonly expiresAt: string | null
  readonly active: boolean
}

/** `billing` — `GET /subscriptions`. */
export interface BillingSubscription {
  readonly id: string
  readonly productId: string
  readonly status: string
  readonly currentPeriodEnd: string | null
  readonly cancelAt: string | null
  readonly scope: string
  readonly confersAccess: boolean
}

/** `activity` — `GET /feed`. Mirrors `toWire` in activity/src/server.ts. */
export interface ActivityRecord {
  readonly id: string
  readonly userId: string | null
  readonly occurredAt: string
  readonly category: string
  readonly type: string
  readonly subjectUrn: string
  readonly summary: string
  readonly amount: string | null
  readonly assetCode: string | null
  readonly product: string
  readonly visibility: string
}

export interface ActivityPage {
  readonly records: readonly ActivityRecord[]
  readonly nextCursor: string | null
}

/** `pricing` — `GET /rates`. Mirrors `RateView` in pricing/src/quotes.ts. */
export interface PricingRate {
  readonly asset: AssetCode
  readonly source: string
  readonly usable: boolean
  readonly reason?: string
  /** When the market observation was made. The field the whole dashboard hangs off — §6 rule 1. */
  readonly quotedAt: string | null
  readonly ageSeconds: number | null
  /** USD per whole coin at `RATE_SCALE`, as a decimal string. Null when there is no usable quote. */
  readonly usdScaled: string | null
  readonly usd: string | null
}

/**
 * `notify` — `GET /notifications`. Mirrors `ReadableNotification` in notify/src/server.ts.
 *
 * `title` and `href` are DERIVED BY NOTIFY, not stored by it and not composed here. That direction
 * is the point: `notify/src/templates.ts` is "the only place a user-visible sentence is written",
 * and a subject rewritten there has to change the words on every row that references it. Building
 * a sentence in this service, or in the SPA, would be a second copy of the estate's words free to
 * drift from the first — the same class of defect as a tile deriving a notification from an
 * activity record, which the header of `dashboard.ts` refused for the same reason.
 *
 * `params` is present and is ALREADY REDACTED by the time it is on the wire: notify blanks every
 * parameter a template declares as a single-use credential at the one point a row becomes a
 * response. Nothing in this service may put it in a log line regardless — it is arbitrary domain
 * data, an address or an amount or a device.
 */
export interface NotificationRecord {
  readonly id: string
  readonly userId: string
  readonly category: string
  readonly priority: string
  readonly templateId: string
  /** The template's subject, substituted. The sentence a client renders verbatim. */
  readonly title: string
  /** A RELATIVE deep link, or null when there is nowhere honest to point. See notify's own note. */
  readonly href: string | null
  readonly params: Record<string, unknown>
  readonly locale: string
  readonly subjectUrn: string | null
  readonly createdAt: string
  readonly readAt: string | null
}

/** `notify` — the page shape of `GET /notifications`. Mirrors `NotificationPage` in store.ts. */
export interface NotificationPage {
  readonly notifications: readonly NotificationRecord[]
  readonly nextCursor: string | null
  /** Unread across the WHOLE inbox, not within this page. Counted by notify in its own query. */
  readonly unread: number
}

/** `policy` — `GET /subjects/:subject/freezes`. Mirrors `Freeze` in policy/src/freezes.ts. */
export interface PolicyFreeze {
  readonly id: string
  readonly subject: string
  readonly scope: string
  readonly reason: string
  readonly createdAt: string
  readonly clearedAt: string | null
  readonly clearancesRequired: number
}

/* ------------------------------------------------------------------ the port */

/**
 * The upstreams as the composition layer sees them.
 *
 * An interface, so `dashboard.ts` can be tested with in-memory fakes that fail on demand, and so
 * nothing above this line knows an HTTP client exists. Every method may reject; nothing above
 * catches selectively, because `loadTile` catches everything and turns it into a status.
 */
export interface Upstreams {
  ledgerBalances(userId: string, requestId: string): Promise<readonly LedgerBalance[]>
  walletRegistry(userId: string, requestId: string): Promise<readonly WalletRecord[]>
  walletDeposits(userId: string, requestId: string): Promise<readonly DepositCredit[]>
  walletWithdrawals(userId: string, requestId: string): Promise<readonly WithdrawalRecord[]>
  walletConversions(
    userId: string,
    limit: number,
    cursor: string | null,
    requestId: string,
  ): Promise<ConversionPage>
  /** One conversion. Rejects with wallet's own 404 when it is not this user's. */
  walletConversion(userId: string, entryId: string, requestId: string): Promise<ConversionRecord>
  walletTransfers(
    userId: string,
    limit: number,
    cursor: string | null,
    requestId: string,
  ): Promise<TransferPage>
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * THE TWO DESK ROUTES TAKE THE CALLER'S BEARER, AND THAT IS NOT THE IDENTITY EXCEPTION AGAIN.
   *
   * Identity above is called this way because it REFUSES a service token. wallet does not: it would
   * accept one happily, and `authenticate` there applies `requireScope` only to a service principal.
   * The reason these two forward the user's own token is the credential this process holds.
   *
   * `HUB_UPSTREAM_SCOPES.wallet` is `['wallet:read']`, and the paragraph above it is explicit about why:
   * "an attacker who reaches this process's memory should find six narrow read tokens, not one that
   * can move money". Quoting and converting need `wallet:money`. Widening the entry would hand every
   * route in this file — and anything that later reaches this process — the authority to convert any
   * user's balances, in order to serve one page, and `derive-grants.mjs` would propagate that
   * widening into `IDENTITY_SERVICE_TOKEN_GRANTS` estate-wide.
   *
   * Forwarding the caller's bearer costs nothing and keeps the authority exactly where it already
   * was: wallet issued nothing, identity did, the token authorises one user, and wallet checks it
   * itself. This service gains no ability to move money that the browser did not already have.
   *
   * The consequence, which the routes enforce rather than paper over: an operator viewing somebody
   * else's dashboard with `?userId=` has no forwardable bearer, so they cannot convert on that
   * person's behalf. That is the correct answer — see `resolveSubject` — and it is a refusal with a
   * sentence, not a 500.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  quoteConversion(
    bearer: string,
    intent: ConversionIntent,
    requestId: string,
  ): Promise<ConversionQuote>
  convert(
    bearer: string,
    intent: ConversionIntent,
    idempotencyKey: string,
    requestId: string,
  ): Promise<ConversionReceipt>
  /** Takes the caller's bearer, not a service token. See the file header. */
  identityMe(bearer: string, requestId: string): Promise<IdentityMe>
  identityFactors(bearer: string, requestId: string): Promise<IdentityFactors>
  billingEntitlements(userId: string, requestId: string): Promise<readonly BillingEntitlement[]>
  billingSubscriptions(userId: string, requestId: string): Promise<readonly BillingSubscription[]>
  activityFeed(
    userId: string,
    limit: number,
    cursor: string | null,
    requestId: string,
  ): Promise<ActivityPage>
  pricingRates(requestId: string): Promise<readonly PricingRate[]>
  policyFreezes(userId: string, requestId: string): Promise<readonly PolicyFreeze[]>
  notifications(userId: string, limit: number, requestId: string): Promise<NotificationPage>
  /** Breaker state per upstream, for `/readyz` and for the operator who asks "is it us". */
  /**
   * The six token providers, so `/readyz` can report the credential.
   *
   * Every entry is `null` when no credential is configured, which is the state
   * `serviceTokenProbe` fails on. They are exposed rather than hidden because a dashboard whose
   * tiles are all `unavailable` should say WHY on the readiness endpoint, not only in a log.
   */
}

/** How many rows each list read asks for. See `dashboard.ts` for why the dashboard asks for few. */
export const PAGE = Object.freeze({
  wallets: 50,
  deposits: 25,
  withdrawals: 25,
  activity: 25,
  /**
   * Conversions and transfers. 25, matching the activity feed rather than the wallet lists.
   *
   * These are cursor-paged reads a client walks, not a fixed preview: wallet defaults to 50 and caps
   * at 200, and asking for its default would make the first page of the Convert history twice as
   * large as the page after it for no reason a reader can see.
   */
  conversions: 25,
  entitlements: 50,
  subscriptions: 20,
  /**
   * Notifications. Deliberately the smallest page here, and smaller than the tile's preview needs
   * to be sound: the unread COUNT does not come out of this list. notify counts unread across the
   * whole inbox in its own query, so asking for four rows and reporting "12 unread" is not an
   * inconsistency — it is the difference between a preview and a total, and the alternative
   * (deriving the count from the page) would silently cap every badge in the estate at this number.
   */
  notifications: 5,
})

export interface HttpUpstreamOptions {
  readonly env: Env
  readonly metrics: Metrics
  /** Test seam. Production uses the global. */
  readonly fetch?: typeof globalThis.fetch
  readonly onTokenEvent?: (event: ProviderEvent) => void
}

/**
 * The exact scope each peer is asked for, and nothing wider.
 *
 * These are the six scope sets the six retired `HUB_*_TOKEN` variables carried, read off the
 * tokens the estate bootstrap actually minted rather than inferred. They stay separate because
 * this is the highest fan-out surface in the estate: an attacker who reaches this process's memory
 * should find six narrow read tokens, not one that can move money. That is AD-05, and dropping to
 * a single whole-allowlist token would quietly trade it away.
 *
 * Identity is absent by construction: `GET /auth/me` and `GET /mfa/factors` refuse a service token
 * outright, so those calls carry the caller's own bearer. See the file header.
 *
 * ── `satisfies`, NOT AN ANNOTATION, AND THAT IS LOAD-BEARING TWICE ───────────────────────────
 *
 * These are OUTBOUND demands — what hub-api presents to each peer — and that direction had never
 * been checked by anything. `service-ci.yml`'s scope audit reads a repository's INBOUND route
 * gates, which is how `micro-market` came to declare `policy:evaluate` and `micro-wallet`
 * `custody:address`, neither of which has ever been a registry key, for the life of both
 * services. `micro-deploy`'s `derive-grants.mjs` reads this object into
 * `IDENTITY_SERVICE_TOKEN_GRANTS`, and identity validates that list against the registry at
 * import and REFUSES TO START on a name it does not know: a dead identity container, so no tokens
 * for anybody rather than one broken tile.
 *
 * `LiveScope` rather than `Scope` because `Scope` is `keyof typeof SCOPES` — every registered key,
 * DEPRECATED ones included — and identity will not mint a deprecated scope either.
 * `LiveScope = Exclude<Scope, DeprecatedScope>`, with `DeprecatedScope` computed FROM `SCOPES` by
 * a conditional type over the `deprecated` field rather than hand-listed
 * (`contracts/packages/auth/src/index.ts`), so it cannot drift from the registry.
 *
 * It has to be `satisfies` rather than a type annotation, because this object's KEYS are also a
 * type: `UpstreamProviders` below is `Record<keyof typeof HUB_UPSTREAM_SCOPES, …>`. Annotating this
 * `Record<string, readonly LiveScope[]>` would widen that key set to `string`, and every peer
 * lookup in this file would stop being checked — trading a narrow win on the values for a much
 * larger loss on the keys. `satisfies` checks the values and keeps the literal keys.
 *
 * ── AND WHY EACH INNER ARRAY CARRIES `as const` ──────────────────────────────────────────────
 *
 * **The clause that stood here before checked nothing.** It read
 * `satisfies Record<string, readonly string[]>`, and `Object.freeze(['ledger:read'])` is typed
 * `readonly string[]` — the array literal is widened, because `Object.freeze` gives it no const
 * context. So the clause asserted `readonly string[]` against `readonly string[]`: true for every
 * possible value, including `'poilcy:decide'`. Six outbound demands at the estate's highest
 * fan-out surface looked type-checked and were not, which is exactly the shape that let
 * `policy:evaluate` and `custody:address` ship in two sibling services.
 *
 * `as const` is what makes the elements literal types, and therefore what makes the `satisfies`
 * above capable of failing at all. Without it, swapping any scope here for a name that does not
 * exist still compiles. Verified by doing precisely that, in both directions — an unregistered
 * scope and a registered-but-deprecated one — before and after.
 */
export const HUB_UPSTREAM_SCOPES = Object.freeze({
  ledger: Object.freeze(['ledger:read'] as const),
  wallet: Object.freeze(['wallet:read'] as const),
  billing: Object.freeze(['billing:read'] as const),
  activity: Object.freeze(['notify:read'] as const),
  pricing: Object.freeze(['pricing:read'] as const),
  policy: Object.freeze(['policy:decide'] as const),
  // The same scope the `activity` entry above already demands, so hub-api's derived grant set —
  // `IDENTITY_SERVICE_TOKEN_GRANTS`, built from this object by micro-deploy's `derive-grants.mjs`
  // — is unchanged by the arrival of an eighth upstream. What changes is that the credential is now
  // exchanged for a token that is actually presented to the service that ENFORCES the scope:
  // notify's `GET /notifications` is gated on `notify:read` (its `READ_SCOPE`).
  notify: Object.freeze(['notify:read'] as const),
}) satisfies Record<string, readonly LiveScope[]>

/** The providers, exposed so `/readyz` can report the credential and a test can drive them. */
export type UpstreamProviders = Readonly<
  Record<keyof typeof HUB_UPSTREAM_SCOPES, ServiceTokenProvider | null>
>

/**
 * Build the eight clients.
 *
 * `defaultRetries: 1` rather than the package default of 2. A retry costs the tile part of its
 * budget, and the dashboard would rather have six tiles now than seven tiles late — one retry
 * covers the single dropped connection, which is what retries are actually for, and the breaker
 * covers the case where retrying is pointless.
 */
/**
 * A per-network view of the same peers.
 *
 * The HttpClients are built ONCE and shared across networks on purpose: a circuit breaker tracks
 * whether the wallet SERVICE is answering, and a wallet that is down is down for both estates.
 * Two breakers over one process would each need half the evidence to trip and would trip late.
 *
 * What is per-network is the `CF-Network` header on every outbound call, so the consolidated peer
 * answers from the estate this request belongs to. Without it hub-api would ask the right service
 * the wrong question and render the answer without a word of complaint.
 */
export interface UpstreamsFor {
  /** The peers as seen from ONE estate. Every outbound call carries that estate's `CF-Network`. */
  for(network: Network): Upstreams
  /** Process-wide, because it describes the PEER: a wallet that is down is down for both estates. */
  circuitStates(): Readonly<Record<string, string>>
  /** Process-wide: one credential set, narrowed per peer, serves both estates. */
  readonly tokenProviders: UpstreamProviders
}

export function httpUpstreams(options: HttpUpstreamOptions): UpstreamsFor {
  const { env, metrics } = options
  const circuit = { threshold: env.circuitThreshold, resetMs: env.circuitResetMs }

  /**
   * One provider per peer, all from the SAME credential, each narrowed to that peer's scope.
   *
   * Seven providers rather than one is deliberate: a single whole-allowlist token would be one
   * string in this process's memory that reads wallets, ledgers, billing and policy at once. Seven
   * exchanges every ten minutes against identity is a trivial cost for keeping AD-05's separation.
   */
  const providers: UpstreamProviders = Object.freeze(
    Object.fromEntries(
      Object.entries(HUB_UPSTREAM_SCOPES).map(([peer, scopes]) => [
        peer,
        env.identityCredential
          ? new ServiceTokenProvider({
              identityUrl: env.upstreams.identity,
              credential: env.identityCredential,
              scopes,
              ...(options.fetch ? { fetch: options.fetch } : {}),
              ...(options.onTokenEvent ? { onEvent: options.onTokenEvent } : {}),
            })
          : null,
      ]),
    ),
  ) as UpstreamProviders

  /**
   * Rejects rather than resolving `undefined` when there is no credential. `HttpClient` omits the
   * header entirely for `undefined`, so the request would go out unauthenticated and come back
   * 401 — telling an operator that the peer rejected hub-api, when the truth is that nobody
   * configured hub-api. `ServiceTokenUnavailableError` is 503 under `statusFor`, which is what a
   * tile reports as `unavailable` rather than as a signed-out user.
   */
  const tokenFrom = (provider: ServiceTokenProvider | null) => (): Promise<string> =>
    provider
      ? provider.token()
      : Promise.reject(new ServiceTokenUnavailableError('no identity credential is configured'))

  const make = (name: string, baseUrl: string, provider?: ServiceTokenProvider | null): HttpClient =>
    new HttpClient({
      baseUrl,
      name,
      defaultDeadlineMs: env.upstreamDeadlineMs,
      defaultRetries: 1,
      circuit,
      ...(provider !== undefined ? { token: tokenFrom(provider) } : {}),
      // `authorizedFetch` catches a 401 from the peer, re-mints and replays once — the schedule
      // rests on this process's clock and the peer's expiry on the peer's.
      ...(provider?.authorizedFetch
        ? { fetch: provider.authorizedFetch }
        : options.fetch
          ? { fetch: options.fetch }
          : {}),
      // The per-attempt timing. Recorded here rather than around the call so a retried request
      // shows two observations, which is what makes "slow because we retried" separable from
      // "slow because the peer is slow".
      //
      // **THE COUNTER IS NOT A DUPLICATE OF THE HISTOGRAM.** A duration says how long something
      // took, never whether it worked, so until this counter existed a revoked service credential
      // and a healthy upstream were the same observation on `hub_upstream_ms` — and the credential
      // case looked FASTER, because a call that never left the process costs nothing. See
      // `hub_upstream_calls_total` in `server.ts` for the estate incident that is written from.
      //
      // And the two attempts that never reached the peer are kept OUT of the latency histogram.
      // `circuit_open` reports `durationMs: 0` for a call this process refused itself, and
      // `token_unavailable` reports what the token supplier spent, not what a peer did. Feeding
      // either into `hub_upstream_ms` moves the p99 in the direction of "healthy" at exactly the
      // moment nothing is being served, which is a check that cannot fail. Everything else stays:
      // a timeout and a transport error both spent real time against a real socket.
      onResult: (event) => {
        metrics.increment('hub_upstream_calls_total', {
          service: event.upstream,
          outcome: event.outcome,
        })
        if (event.outcome !== 'circuit_open' && event.outcome !== 'token_unavailable') {
          metrics.observe('hub_upstream_ms', event.durationMs, { service: event.upstream })
        }
      },
    })

  const ledger = make('ledger', env.upstreams.ledger, providers.ledger)
  const wallet = make('wallet', env.upstreams.wallet, providers.wallet)
  /*
   * A SECOND CLIENT AT THE SAME BASE URL, with no token provider, for the two desk routes.
   *
   * The obvious alternative is to pass `authorization` per request on `wallet` above, and
   * `HttpClient`'s header precedence would honour it — a per-request header beats the client's
   * token. What it would NOT escape is `authorizedFetch`: that wrapper catches a 401 from the peer,
   * re-mints the SERVICE token and replays the call with it. A user's bearer that wallet rejected
   * would therefore be silently retried as hub-api's own credential, which is micro-org#251 exactly
   * — settlement forwarded an operator's bearer to custody's admin mint, the client replaced it, and
   * the route could only ever return 500. Here the replacement would go the other way and succeed:
   * a service token retrying a refused user conversion.
   *
   * A separate client also gets its own breaker, which is what we want in both directions. wallet's
   * `rate_unavailable` is a 503, and 503 is retriable, so a pricing outage counts against the
   * breaker — on this client, where it costs the Convert form, and not on the read client, where it
   * would cost every wallet tile on the dashboard. Conversely a 4xx never trips either: `HttpClient`
   * calls `succeeded()` on a non-retriable peer decision, so a run of `desk_inventory_short`
   * refusals — which is the expected steady state of an under-funded desk — leaves this closed.
   */
  const walletMoney = make('wallet-money', env.upstreams.wallet)
  // No token: every call carries the caller's own, per request. See the file header.
  const identity = make('identity', env.upstreams.identity)
  const billing = make('billing', env.upstreams.billing, providers.billing)
  const activity = make('activity', env.upstreams.activity, providers.activity)
  const pricing = make('pricing', env.upstreams.pricing, providers.pricing)
  const policy = make('policy', env.upstreams.policy, providers.policy)
  const notify = make('notify', env.upstreams.notify, providers.notify)

  const forNetwork = (network: Network): Upstreams => ({
    async ledgerBalances(userId, requestId) {
      // `user:<uuid>` percent-encoded whole: the colon is a path-segment delimiter in some
      // proxies, and ledger decodes the segment before parsing it.
      const subject = encodeURIComponent(`user:${userId}`)
      const body = await ledger.get<{ balances: readonly LedgerBalance[] }>(
        `/accounts/${subject}/balances`,
        { requestId, network },
      )
      return body.balances
    },

    async walletRegistry(userId, requestId) {
      const body = await wallet.get<{ wallets: readonly WalletRecord[] }>(
        `/v1/wallets?userId=${encodeURIComponent(userId)}&limit=${PAGE.wallets}`,
        { requestId, network },
      )
      return body.wallets
    },

    async walletDeposits(userId, requestId) {
      const body = await wallet.get<{ credits: readonly DepositCredit[] }>(
        `/v1/deposits/credits?userId=${encodeURIComponent(userId)}&limit=${PAGE.deposits}`,
        { requestId, network },
      )
      return body.credits
    },

    async walletWithdrawals(userId, requestId) {
      const body = await wallet.get<{ withdrawals: readonly WithdrawalRecord[] }>(
        `/v1/withdrawals?userId=${encodeURIComponent(userId)}&limit=${PAGE.withdrawals}`,
        { requestId, network },
      )
      return body.withdrawals
    },

    async walletConversions(userId, limit, cursor, requestId) {
      const query = new URLSearchParams({ userId, limit: String(limit) })
      if (cursor) query.set('cursor', cursor)
      return wallet.get<ConversionPage>(`/v1/conversions?${query.toString()}`, { requestId, network })
    },

    async walletConversion(userId, entryId, requestId) {
      const query = new URLSearchParams({ userId })
      const body = await wallet.get<{ conversion: ConversionRecord }>(
        `/v1/conversions/${encodeURIComponent(entryId)}?${query.toString()}`,
        { requestId, network },
      )
      return body.conversion
    },

    async walletTransfers(userId, limit, cursor, requestId) {
      const query = new URLSearchParams({ userId, limit: String(limit) })
      if (cursor) query.set('cursor', cursor)
      return wallet.get<TransferPage>(`/v1/transfers?${query.toString()}`, { requestId, network })
    },

    async quoteConversion(bearer, intent, requestId) {
      const body = await walletMoney.post<{ quote: ConversionQuote }>(
        '/v1/conversions/quote',
        intent,
        { headers: { authorization: `Bearer ${bearer}` }, requestId },
      )
      return body.quote
    },

    async convert(bearer, intent, idempotencyKey, requestId) {
      // The key is the CALLER's, forwarded verbatim rather than minted here. One intent is one key
      // for its whole life — the browser mints it when the reader reviews, and a retry of the same
      // press must reach wallet carrying the same string or the replay stops being a replay. A key
      // generated in this process would be a new one per proxy hop, which is the one thing an
      // idempotency key must never be.
      return walletMoney.post<ConversionReceipt>('/v1/conversions', intent, {
        headers: { authorization: `Bearer ${bearer}` },
        idempotencyKey,
        requestId,
        network,
      })
    },

    async identityMe(bearer, requestId) {
      return identity.get<IdentityMe>('/auth/me', {
        headers: { authorization: `Bearer ${bearer}` },
        requestId,
        network,
      })
    },

    async identityFactors(bearer, requestId) {
      return identity.get<IdentityFactors>('/mfa/factors', {
        headers: { authorization: `Bearer ${bearer}` },
        requestId,
        network,
      })
    },

    async billingEntitlements(userId, requestId) {
      // The service-token route, not `GET /entitlements`. Billing refuses a user token here on
      // purpose — "a route that quietly accepted both would make the scoped-token boundary
      // decorative" — and this service holds exactly the token it names.
      const body = await billing.get<{ entitlements: readonly BillingEntitlement[] }>(
        `/internal/entitlements/${encodeURIComponent(userId)}?limit=${PAGE.entitlements}`,
        { requestId, network },
      )
      return body.entitlements
    },

    async billingSubscriptions(userId, requestId) {
      const body = await billing.get<{ subscriptions: readonly BillingSubscription[] }>(
        `/subscriptions?userId=${encodeURIComponent(userId)}&limit=${PAGE.subscriptions}`,
        { requestId, network },
      )
      return body.subscriptions
    },

    async activityFeed(userId, limit, cursor, requestId) {
      const query = new URLSearchParams({ userId, limit: String(limit) })
      if (cursor) query.set('cursor', cursor)
      const body = await activity.get<{
        records: readonly ActivityRecord[]
        nextCursor?: string
      }>(`/feed?${query.toString()}`, { requestId, network })
      // Normalised to `null` here rather than left absent. Activity omits the key on the last
      // page; a client that reads `nextCursor === undefined` and one that reads `=== null` are two
      // clients, and this is the layer whose job it is to make them one.
      return { records: body.records, nextCursor: body.nextCursor ?? null }
    },

    async pricingRates(requestId) {
      const body = await pricing.get<{ rates: readonly PricingRate[] }>('/rates', { requestId, network })
      return body.rates
    },

    async policyFreezes(userId, requestId) {
      const subject = encodeURIComponent(`user:${userId}`)
      const body = await policy.get<{ freezes: readonly PolicyFreeze[] }>(
        `/subjects/${subject}/freezes`,
        { requestId, network },
      )
      return body.freezes
    },

    async notifications(userId, limit, requestId) {
      // `?userId=` rather than a bearer: notify reads "whoever its call names" for a service
      // principal and refuses a user asking for somebody else, which is the same shape wallet,
      // billing and policy are read with here. `unread=true` is deliberately NOT set — the tile
      // shows the newest few whatever their read state, and the unread total comes back on the
      // page regardless, so filtering here would cost the preview its context and buy nothing.
      const query = new URLSearchParams({ userId, limit: String(limit) })
      return notify.get<NotificationPage>(`/notifications?${query.toString()}`, { requestId, network })
    },

  })

  return {
    for: forNetwork,
    circuitStates() {
      return {
        ledger: ledger.circuitState,
        wallet: wallet.circuitState,
        // Reported separately because it fails separately. An operator reading `/readyz` during a
        // pricing outage should see this one open and `wallet` closed, which is the whole reason
        // there are two clients.
        'wallet-money': walletMoney.circuitState,
        identity: identity.circuitState,
        billing: billing.circuitState,
        activity: activity.circuitState,
        pricing: pricing.circuitState,
        policy: policy.circuitState,
        notify: notify.circuitState,
      }
    },
    tokenProviders: providers,
  }
}
