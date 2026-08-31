/**
 * "Needs you" — the cards that replace a notification bell.
 *
 * Rule 2 of the Forge Hub layout: "'Needs you' replaces a notification bell as the primary call to
 * action. Each card is a suggested next action with a verb, sourced from a different service, and
 * each degrades independently — a card that cannot load is absent, not broken."
 *
 * Three properties follow from that sentence and all three are enforced here:
 *
 *   1. **Every card carries a verb and a destination.** "2FA is not enabled" is an observation;
 *      "Enable →" is an action. A card a user cannot act on from the dashboard is a worry with no
 *      outlet, which is worse than not showing it.
 *   2. **Every card names one source.** The card is derived from exactly one upstream's data, so
 *      when that upstream is down the card is simply not built — no placeholder, no error state,
 *      no spinner that never resolves. `missing[]` records which sources went quiet, for the
 *      operator rather than for the user.
 *   3. **Every card has a stable id.** Derived from the kind and the subject, never from a counter
 *      or a timestamp, so a client can dismiss one and have the dismissal survive a refresh.
 *
 * Cards are ordered by severity and then by source, so the ordering does not shuffle between two
 * loads that contain the same set.
 *
 * ── Two cards from the reference layout are not built here ─────────────────────────────────────
 *
 * The layout shows "Bot paused · risk limit" (trade) and "Offer on your listing" (market). Neither
 * service exists in this estate yet, so neither card is emitted — inventing them from something
 * else would be this service manufacturing a fact, which is the one thing a BFF must never do.
 * Both are in the gap list in the README. What replaces them for now comes from services that do
 * exist: a past-due subscription (billing), an account freeze (policy) and a stuck withdrawal
 * (wallet), each of which is a genuine "needs you" and none of which had a home before.
 */

import { chainSpec, type AssetCode, type ChainSpec } from '@cloudsforge/contracts-chain'
import type {
  BillingSubscription,
  DepositCredit,
  PolicyFreeze,
  WithdrawalRecord,
} from './upstreams.ts'
import type { Tile } from './tiles.ts'

/**
 * The narrowest view of identity's MFA answer that these cards need.
 *
 * Narrow on purpose: `/v1/dashboard` and `/v1/next-actions` fetch different shapes from identity —
 * one needs the whole security panel, the other only the two fields below — and a wide type here
 * would force the lighter route to fabricate fields it never read.
 */
export interface FactorSummary {
  readonly factors: readonly { readonly status: string }[]
  readonly recoveryCodesRemaining: number
}

export type NextActionKind =
  | 'deposit_confirming'
  | 'mfa_disabled'
  | 'recovery_codes_low'
  | 'account_frozen'
  | 'subscription_past_due'
  | 'withdrawal_stuck'

export type Severity = 'info' | 'warning' | 'critical'

/** Progress towards a threshold. Present only where there is a real denominator. */
export interface ActionProgress {
  readonly done: number
  readonly total: number
  /** Whole minutes, best-effort, from the chain's own block time. Null where it is not knowable. */
  readonly etaMinutes: number | null
}

export interface NextAction {
  /** Stable across refreshes for the same underlying subject. */
  readonly id: string
  readonly kind: NextActionKind
  readonly severity: Severity
  /** The service the card came from. One card, one source — always. */
  readonly source: string
  readonly title: string
  readonly detail: string
  /** The imperative on the button. "Enable", "Review", "Track". */
  readonly verb: string
  /** Deep link into Forge Hub. Relative: the SPA owns its own origin. */
  readonly href: string
  readonly progress: ActionProgress | null
}

/** A source that could not be consulted. For operators; a user sees one fewer card. */
export interface MissingSource {
  readonly source: string
  readonly reason: string
}

export interface NextActions {
  readonly actions: readonly NextAction[]
  readonly missing: readonly MissingSource[]
}

export interface NextActionInputs {
  readonly deposits: Tile<readonly DepositCredit[]>
  readonly withdrawals: Tile<readonly WithdrawalRecord[]>
  readonly factors: Tile<FactorSummary | null>
  readonly freezes: Tile<readonly PolicyFreeze[]>
  readonly subscriptions: Tile<readonly BillingSubscription[]>
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = Object.freeze({
  critical: 0,
  warning: 1,
  info: 2,
})

// ── THERE IS NO BLOCK-TIME TABLE IN THIS FILE ANY MORE, AND THE ABSENCE IS THE FIX ─────────────
//
// A `BLOCK_SECONDS` map lived here, typed `Readonly<Partial<Record<AssetCode, number>>>`, holding
// EMBER, ETH, BTC, SOL and XRP — the five assets that existed on the day it was typed. Its own
// comment defended it as "not a contract", which was true and was not the problem. The problem is
// the word `Partial`: it is a total record with the compiler switched off, so LTC, DOGE and ETC
// were added to `AssetCode` and this map said nothing at all.
//
// What a missing row did, traced on 2026-08-09 rather than assumed, because "it throws" and "it
// falls back to Ember" were both plausible and both wrong: the lookup typed `number | undefined`
// returned `undefined`, `progressFor` mapped that to `etaMinutes: null`, and hub-web's overview
// renders the "~N min" suffix only when that field is non-null. So no wrong number ever reached a
// user — the estimate simply stopped existing, silently, for the three newest assets.
//
// That made the omission worst exactly where it hurt most. ETC credits at 7,500 confirmations
// (contracts/packages/chain/src/index.ts — an anti-reorg depth, not a caution), so an ETC deposit
// takes over a day, and it was the one deposit in the estate with no wait shown against it. The
// user who most needed telling to come back tomorrow was the one told nothing.
//
// The replacement is not a sixth row and not a fourth table. `chainSpec()` now publishes
// `blockSeconds`, and `CHAINS` there is a TOTAL `Readonly<Record<AssetCode, ChainSpec>>`, so the
// next asset the estate adds cannot reach this card without a block time — it fails to compile in
// the package that owns the union instead of going quiet on a screen. Every value there cites the
// chain's own source, which is more than this file could ever claim for numbers it had typed by
// hand: the SOL row here said 1 second against an enforced 400ms slot, and XRP said 4 against a
// measured 3.88.
//
// It is still not a contract, and contracts-chain says so louder than this file did:
// `blockSecondsIsAdvisory` sits beside the field, and `isConfirmed` takes a count of blocks, so
// there is no elapsed-time argument for a crediting path to pass even by mistake.

export function buildNextActions(inputs: NextActionInputs): NextActions {
  const actions: NextAction[] = []
  const missing: MissingSource[] = []

  const consult = <T>(tile: Tile<T>, build: (data: T) => void): void => {
    if (tile.status === 'unavailable') {
      missing.push({ source: tile.upstream, reason: tile.reason ?? 'unavailable' })
      return
    }
    build(tile.data)
  }

  consult(inputs.deposits, (credits) => {
    for (const credit of credits) {
      if (credit.credited) continue
      const spec = specFor(credit.assetCode)
      const required = spec === null ? null : spec.confirmations
      // A deposit with no known depth policy is still shown — the user cares that it is in flight
      // — but without a fraction, because "41/0" is worse than "41 confirmations".
      const progress = spec === null ? null : progressFor(credit, spec)
      actions.push({
        id: `deposit_confirming:${credit.id}`,
        kind: 'deposit_confirming',
        severity: 'info',
        source: 'wallet',
        title: `${credit.amountFormatted} ${credit.assetCode} arriving`,
        detail:
          required === null
            ? `${credit.confirmations} confirmations so far`
            : `${credit.confirmations}/${required} confirmations`,
        verb: 'Track',
        href: `/wallet/deposits/${credit.id}`,
        progress,
      })
    }
  })

  consult(inputs.withdrawals, (withdrawals) => {
    for (const withdrawal of withdrawals) {
      // `stuck` is the only non-terminal failure state in wallet's machine: the reservation is
      // held and the payment's fate is unknown. It is the single most important thing this
      // dashboard can tell a user, because the money is neither theirs nor gone.
      if (withdrawal.state !== 'stuck') continue
      actions.push({
        id: `withdrawal_stuck:${withdrawal.id}`,
        kind: 'withdrawal_stuck',
        severity: 'critical',
        source: 'wallet',
        title: `Withdrawal of ${withdrawal.amountFormatted} ${withdrawal.assetCode} is stuck`,
        detail: withdrawal.failureReason ?? 'awaiting confirmation from the chain',
        verb: 'Review',
        href: `/wallet/withdrawals/${withdrawal.id}`,
        progress: null,
      })
    }
  })

  consult(inputs.factors, (factors) => {
    if (!factors) return
    const active = factors.factors.filter((factor) => factor.status === 'active')
    if (active.length === 0) {
      actions.push({
        id: 'mfa_disabled',
        kind: 'mfa_disabled',
        severity: 'warning',
        source: 'identity',
        title: '2FA is not enabled',
        detail: 'An account holding money should not be one password away from a stranger.',
        verb: 'Enable',
        href: '/account/security',
        progress: null,
      })
    } else if (factors.recoveryCodesRemaining <= 2) {
      // Only when MFA *is* on: telling a user with no second factor that their recovery codes are
      // low is two cards competing for one action, and the wrong one would win.
      actions.push({
        id: 'recovery_codes_low',
        kind: 'recovery_codes_low',
        severity: 'info',
        source: 'identity',
        title: 'Recovery codes are running out',
        detail: `${factors.recoveryCodesRemaining} left. Running out locks you out of your own account.`,
        verb: 'Regenerate',
        href: '/account/security',
        progress: null,
      })
    }
  })

  consult(inputs.freezes, (freezes) => {
    for (const freeze of freezes) {
      if (freeze.clearedAt !== null) continue
      actions.push({
        id: `account_frozen:${freeze.id}`,
        kind: 'account_frozen',
        severity: 'critical',
        source: 'policy',
        title: `${freeze.scope} is frozen`,
        detail: freeze.reason,
        // The freeze record is readable by its subject on purpose — a blocked user asking why is
        // the case policy's read route was written for — so the card links there rather than to a
        // support form.
        verb: 'See why',
        href: `/account/restrictions/${freeze.id}`,
        progress: null,
      })
    }
  })

  // ── THE PAST-DUE CARD NAMES NO ASSET, AND THE ABSENCE IS THE WHOLE FIX ───────────────────────
  //
  // It read `'Top up Shards to keep access.'` — micro-org #227. SHARD is RETIRED: `RETIRED_ASSETS`
  // in contracts/packages/chain/src/index.ts freezes it, `IssuableAssetCode` excludes it from the
  // type at compile time, and `assertIssuable` throws on it at run time. So the card shown to a
  // user whose renewal had just failed sent them to acquire an asset the estate no longer issues,
  // in the one moment they are most likely to act on what it says. That is the third retired-asset
  // string to reach a user surface (micro-org #15 and #182 were the first two).
  //
  // WHAT A RENEWAL ACTUALLY CHARGES, read off billing rather than assumed. `renewSubscription` in
  // billing/src/jobs.ts posts `purchasePostings({ assetCode: deps.assetCode, … })`, and that asset
  // is `settlementAsset` from billing/src/env.ts, which is **EMBER** and deliberately NOT
  // configurable — its own comment says the SHARD it replaced "sat outside the estate's central
  // guarantee (no balance may exist that the chain does not back)". Prices are held in USD
  // (`priceAsset`), which never reaches a posting. billing/src/env.test.ts pins both.
  //
  // AND THIS CARD STILL MAY NOT SAY "EMBER". The card is built from exactly one input, a
  // `BillingSubscription` (src/upstreams.ts), and that record carries `id`, `productId`, `status`,
  // `currentPeriodEnd`, `cancelAt`, `scope` and `confersAccess` — no asset, no amount, no price.
  // Writing "EMBER" here would be this BFF restating a constant that lives in another service's
  // environment: it would be correct today, silently wrong the day billing's settlement asset
  // moves, and nothing in either repository would fail — which is precisely how the Shards string
  // survived the SHARD retirement in the first place. package.json's `_noDatabase` note states the
  // same rule for data ("a field that exists only here is a bug"); a denomination that exists only
  // here is the same bug in copy. If the asset is needed on this card, the fix is billing
  // returning it on `GET /subscriptions`, not a literal in this file.
  //
  // SO THE COPY SAYS THE TRUE PART AND STOPS. "Top up" is right regardless of denomination:
  // `past_due` is written in exactly one place, the `InsufficientFundsError` branch of
  // `renewSubscription` calling `markPastDue` (billing/src/subscriptions.ts), so the status means
  // "the charge could not be taken", never a fault. "to keep access" is right too — `past_due`
  // confers access via `subscriptionConfersAccess` in contracts-money, and the renewal scan keeps
  // retrying it because `dueForRenewal` selects `past_due` alongside `trialing` and `active`. The
  // asset and the amount are named by the surface `href` points at, which is billing's own.
  //
  // `nextactions.test.ts` holds the absence: it asserts this card's copy contains no key of
  // `CHAINS`, so re-typing any asset code here — retired or live — fails the build.
  consult(inputs.subscriptions, (subscriptions) => {
    for (const subscription of subscriptions) {
      if (subscription.status !== 'past_due') continue
      actions.push({
        id: `subscription_past_due:${subscription.id}`,
        kind: 'subscription_past_due',
        severity: 'warning',
        source: 'billing',
        title: 'A subscription could not be renewed',
        detail: 'Top up your balance to keep access.',
        verb: 'Fix',
        href: `/billing/subscriptions/${subscription.id}`,
        progress: null,
      })
    }
  })

  actions.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (bySeverity !== 0) return bySeverity
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  return { actions, missing }
}

/**
 * The chain's own spec, or null for an asset code this build does not know.
 *
 * One lookup where there used to be two — a depth read from the contract and a block time read
 * from a local table — so the two halves of a deposit card can no longer come from different
 * generations of the asset union. `DepositCredit.assetCode` is a `string` (src/upstreams.ts)
 * because wallet's payload is not typed against the union, so an asset wallet has been taught
 * ahead of this build's contracts-chain still reaches this path in production; the `catch` is that
 * case and not a swallowed bug.
 */
function specFor(assetCode: string): ChainSpec | null {
  try {
    return chainSpec(assetCode as AssetCode)
  } catch {
    return null
  }
}

function progressFor(credit: DepositCredit, spec: ChainSpec): ActionProgress {
  const remaining = Math.max(0, spec.confirmations - credit.confirmations)
  return {
    done: credit.confirmations,
    total: spec.confirmations,
    // `blockSeconds` is null only for an asset with no chain, which cannot produce a deposit —
    // but the null is honoured rather than coerced, so that case renders no estimate at all
    // instead of the "0 min" a fallback of zero would print at the top of a card.
    etaMinutes:
      spec.blockSeconds === null ? null : Math.ceil((remaining * spec.blockSeconds) / 60),
  }
}
