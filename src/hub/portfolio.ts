/**
 * Valuation: ledger balances multiplied by pricing quotes.
 *
 * Rule 1 of the Forge Hub layout: "portfolio first, and it carries its pricing timestamp. A
 * balance without one is a number the oracle may have stopped updating fifteen minutes ago."
 * Everything below exists to make that timestamp truthful.
 *
 * **`pricedAt` is the oldest contributing observation, not the newest and not now.** A portfolio
 * valued from a BTC quote taken two seconds ago and an XRP quote taken four minutes ago is, as a
 * single number, four minutes old — reporting the newest would overstate the confidence of the
 * total, which is the one number a user reads. `perAsset` still carries each quote's own instant,
 * so nothing is hidden by the summary.
 *
 * **All arithmetic is BigInt.** Rates arrive scaled by `RATE_SCALE` (10^6 USD per whole coin) and
 * balances arrive in smallest units — 18 decimals for EMBER and ETH. Neither fits an IEEE 754
 * double, and `contracts-chain` says why in one line: "a float rate applied to an 18-decimal
 * amount loses precision in the least significant digits, which is exactly where a reconciliation
 * drift shows up". Values leave here as decimal strings, never as JSON numbers.
 *
 * **A priced holding carries HOW it was priced.** `priceSource` is pricing's own `source` passed
 * through untouched, `'market'` or `'administered'`. Pricing's schema says why it must travel:
 * "the distinction is carried all the way to the client, because a conversion settled against an
 * administered price was priced by a person, not by a market". This service used to drop it here,
 * which is how a wallet came to render a five-figure EMBER total with nothing on screen to say
 * that no exchange has ever quoted EMBER at all.
 *
 * **An unpriced holding is shown, not hidden.** Pricing lists an unusable asset rather than
 * omitting it, for the same reason: "omitting it makes a client that iterates the board silently
 * forget the asset exists". A holding with no price appears with a null value and a stated reason,
 * and it is excluded from the total — which is then flagged incomplete, because a total that
 * silently drops an asset is a wrong total that looks right.
 */

import {
  RATE_SCALE,
  SHARDS_PER_USD,
  chainSpec,
  formatAmount,
  isRetiredAsset,
} from '@cloudsforge/contracts-chain'
import {
  USD_DECIMALS,
  isChainAsset,
  isTokenAsset,
  type LedgerAssetCode,
} from '@cloudsforge/contracts-money'
import type { LedgerBalance, PricingRate } from './upstreams.ts'

/** Past this many assets the allocation chart folds the tail into "Other". §6 rule 6. */
export const ALLOCATION_ROWS = 8

/**
 * How many coins get a headline tile of their own, beside "Total held" and "Assets".
 *
 * Three, so the tile row is five across and still fits the grid at a phone width. Everything past
 * it is one scroll away in the holdings table, which is exhaustive; this row is a glance, and a
 * glance with nine numbers in it is a table with worse alignment.
 */
export const HEADLINE_COINS = 3

export interface Holding {
  readonly assetCode: LedgerAssetCode
  /** Smallest units, summed across every account purpose. Decimal string. */
  readonly amount: string
  /** Human form. Null for a `TOKEN:` asset, whose decimals nothing in this fan-out knows. */
  readonly amountFormatted: string | null
  /** The part that is spendable now. */
  readonly available: string
  /** Held against a withdrawal or an order. Visible because "why can I not spend it" is the question. */
  readonly reserved: string
  readonly usdScaled: string | null
  readonly usd: string | null
  /** Share of the priced total, in basis points. Null when the holding could not be priced. */
  readonly allocationBps: number | null
  /** When the quote behind `usd` was observed. Null for an unpriced holding and for fixed rates. */
  readonly quotedAt: string | null
  /** Present exactly when `usd` is null. Pricing's own words where it gave them. */
  readonly priceReason: string | null
  /**
   * How the price behind `usd` was arrived at — pricing's own `source`, verbatim.
   *
   * `'market'` is a median of four independent venues. `'administered'` means an operator typed the
   * number because the asset has no exchange listing, which today is EMBER and only EMBER
   * (`pricing/src/rates.ts`, `ADMINISTERED_ASSETS`). Pricing's schema calls the distinction out in
   * its own words — "the distinction is carried all the way to the client, because a conversion
   * settled against an administered price was priced by a person, not by a market" — and this field
   * is the leg of that carriage that was missing: pricing sent `source` on every rate, and this
   * service discarded it here, so no screen in the estate could tell a reader which of their
   * figures a market had ever agreed to.
   *
   * Null where no quote was involved at all: SHARD and USD are fixed by contract, a `TOKEN:` asset
   * has no oracle, and an unpriced holding has no figure to qualify. Null therefore means "this
   * needs no such note", never "we did not check".
   */
  readonly priceSource: string | null
}

/**
 * One headline coin tile, decided here rather than by whatever renders it.
 *
 * ── Why the SERVICE picks these and not the client ─────────────────────────────────────────────
 *
 * Which asset codes are real coins, which are minted tokens with no known decimals, and which are
 * retired and may not be put in front of anybody as a holding — all three are questions
 * `contracts-chain` and `contracts-money` already answer, and this service already depends on
 * both. A browser bundle asking them would need its own copy of that vocabulary, shipped on its
 * own release cadence, and the first asset added or wound down would be right here and wrong
 * there with nothing failing in between. `lib/portfolio.ts` in hub-web makes the same argument
 * about `priceSource` and settles it the same way: "pricing already answers the question on every
 * rate; this asks it."
 */
export interface CoinTile {
  readonly assetCode: LedgerAssetCode
  /** Smallest units. Decimal string, for the same BigInt reasons as everything else here. */
  readonly amount: string
  /** Human form at the asset's own decimals. Never null: a `TOKEN:` asset never becomes a tile. */
  readonly amountFormatted: string
}

/** One bar of the allocation chart. Sorted, direct-labelled, never a pie — §6 rule 6. */
export interface AllocationRow {
  readonly label: string
  readonly usdScaled: string
  readonly usd: string
  readonly bps: number
}

export interface PortfolioView {
  readonly totalUsdScaled: string
  readonly totalUsd: string
  /**
   * The oldest observation contributing to the total, or null if nothing observable did. This is
   * the "priced 14:22" in the layout, and it must never be the time the response was assembled.
   */
  readonly pricedAt: string | null
  /** False when a holding was dropped from the total for want of a price. */
  readonly pricingComplete: boolean
  /** Every holding, largest first. Zero balances are dropped: an empty account is not a holding. */
  readonly holdings: readonly Holding[]
  readonly allocation: readonly AllocationRow[]
  /**
   * The coins to give a tile of their own, in the order to show them. See `headlineCoins`.
   *
   * This replaced two fixed fields, `shards` and `ember`. `shards` was a headline tile for a
   * RETIRED asset (`RETIRED_ASSETS`, `contracts-chain`) on the estate's most-read screen, and it
   * was reported by the owner twice — once as copy and once as "we should have the real coins
   * there". The label was never dishonest: it summed the ledger's own SHARD balances and said so.
   * It was answering a question nobody asked, in a currency nothing new may be denominated in,
   * in the space where somebody's Bitcoin should have been.
   */
  readonly coins: readonly CoinTile[]
}

export const EMPTY_PORTFOLIO: PortfolioView = Object.freeze({
  totalUsdScaled: '0',
  totalUsd: '0',
  pricedAt: null,
  pricingComplete: false,
  holdings: Object.freeze([]),
  allocation: Object.freeze([]),
  // EMBER only, at zero: the empty portfolio still says what this account's home coin is, and a
  // degraded tile that renders no coin row at all reflows the whole panel on recovery.
  coins: Object.freeze([emberTile(0n)]),
})

interface Summed {
  total: bigint
  available: bigint
  reserved: bigint
}

/**
 * Compose the portfolio.
 *
 * `rates` may be empty — that is the pricing-is-down path, and it produces a portfolio of holdings
 * with null values, a zero total and `pricingComplete: false`, which is exactly what a `degraded`
 * portfolio tile should contain. It never throws for want of a price.
 */
export function composePortfolio(
  balances: readonly LedgerBalance[],
  rates: readonly PricingRate[],
): PortfolioView {
  const byAsset = new Map<LedgerAssetCode, Summed>()
  for (const balance of balances) {
    // A closed account with a zero balance is noise; a closed account with a non-zero balance is
    // a fact worth showing, so the filter is on the amount rather than on the status.
    const amount = safeBigInt(balance.amount)
    if (amount === null) continue
    const entry = byAsset.get(balance.assetCode) ?? { total: 0n, available: 0n, reserved: 0n }
    entry.total += amount
    if (balance.purpose === 'available') entry.available += amount
    if (balance.purpose === 'reserved') entry.reserved += amount
    byAsset.set(balance.assetCode, entry)
  }

  const quotes = new Map(rates.map((rate) => [rate.asset as string, rate]))

  const holdings: Holding[] = []
  let totalScaled = 0n
  let oldestQuotedAt: string | null = null
  let complete = true

  for (const [assetCode, sums] of byAsset) {
    if (sums.total === 0n) continue
    const decimals = decimalsFor(assetCode)
    const valued = value(assetCode, sums.total, quotes.get(assetCode))

    if (valued.usdScaled === null) {
      // Dropped from the total rather than counted as zero. A holding counted at zero is a
      // portfolio that quietly shrinks when the oracle blinks, and the user reads that as a loss.
      complete = false
    } else {
      totalScaled += valued.usdScaled
      if (valued.quotedAt !== null && (oldestQuotedAt === null || valued.quotedAt < oldestQuotedAt)) {
        oldestQuotedAt = valued.quotedAt
      }
    }

    holdings.push({
      assetCode,
      amount: sums.total.toString(),
      amountFormatted: decimals === null ? null : formatAmount(sums.total, decimals),
      available: sums.available.toString(),
      reserved: sums.reserved.toString(),
      usdScaled: valued.usdScaled === null ? null : valued.usdScaled.toString(),
      usd: valued.usdScaled === null ? null : formatAmount(valued.usdScaled, RATE_DECIMALS),
      allocationBps: null,
      quotedAt: valued.quotedAt,
      priceReason: valued.reason,
      priceSource: valued.source,
    })
  }

  // Sorted by value, largest first, with unpriced holdings last and ties broken by asset code so
  // the order is stable across requests. An unstable order makes a dashboard flicker on refresh.
  holdings.sort((a, b) => {
    const av = a.usdScaled === null ? -1n : BigInt(a.usdScaled)
    const bv = b.usdScaled === null ? -1n : BigInt(b.usdScaled)
    if (av !== bv) return bv > av ? 1 : -1
    return a.assetCode < b.assetCode ? -1 : a.assetCode > b.assetCode ? 1 : 0
  })

  const withAllocation = holdings.map((holding) => ({
    ...holding,
    allocationBps:
      holding.usdScaled === null || totalScaled === 0n
        ? null
        : Number((BigInt(holding.usdScaled) * 10_000n) / totalScaled),
  }))

  return {
    totalUsdScaled: totalScaled.toString(),
    totalUsd: formatAmount(totalScaled, RATE_DECIMALS),
    pricedAt: oldestQuotedAt,
    pricingComplete: complete,
    holdings: withAllocation,
    allocation: foldAllocation(withAllocation, totalScaled),
    coins: headlineCoins(withAllocation, byAsset),
  }
}

/**
 * The coins that get a tile of their own.
 *
 * EMBER first and always, even at zero. It is this platform's own chain, every account has one
 * whether or not anything has landed in it yet, and a tile row whose contents change shape between
 * a new account and a funded one is a layout that reflows under the reader.
 *
 * After it, the holdings the reader actually has, in `holdings` order — which is by USD value,
 * largest first, already sorted above. Three rules decide what may follow:
 *
 *   - **Chain assets only.** A `TOKEN:` asset has no published decimals in this fan-out
 *     (`decimalsFor` returns null for it), so there is no honest way to place the decimal point in
 *     a headline figure. Those holdings still appear in the table, which has a column for saying
 *     so; a tile has nowhere to put the caveat.
 *   - **USD is not a coin.** It is the unit "Total held" is already denominated in, so a tile for
 *     it would be the same number twice.
 *   - **Nothing retired.** `isRetiredAsset` is asked rather than `assetCode !== 'SHARD'` written,
 *     for the reason `contracts-chain` gives about every one of these lists: the next asset wound
 *     down is caught here with no edit. The balance itself is NOT hidden — a retired holding is
 *     still a real ledger row and still appears in the holdings table with its amount and its
 *     value. What it loses is the promotion.
 */
function headlineCoins(
  holdings: readonly Holding[],
  byAsset: ReadonlyMap<LedgerAssetCode, Summed>,
): CoinTile[] {
  const tiles = [emberTile(byAsset.get('EMBER')?.total ?? 0n)]
  for (const holding of holdings) {
    if (tiles.length >= HEADLINE_COINS) break
    const code = holding.assetCode
    if (code === 'EMBER') continue
    if (!isChainAsset(code) || isRetiredAsset(code)) continue
    tiles.push({
      assetCode: code,
      amount: holding.amount,
      // Non-null by construction: `decimalsFor` answers for every chain asset, so `formatAmount`
      // above already produced a string for one. The coalesce is the type system's toll, not a
      // real branch.
      amountFormatted: holding.amountFormatted ?? formatAmount(BigInt(holding.amount), chainSpec(code).decimals),
    })
  }
  return tiles
}

/** EMBER's tile, at whatever amount — the one coin that is always present. */
function emberTile(amount: bigint): CoinTile {
  return {
    assetCode: 'EMBER',
    amount: amount.toString(),
    amountFormatted: formatAmount(amount, chainSpec('EMBER').decimals),
  }
}

/** `RATE_SCALE` is 10^6, so a scaled USD figure has six decimal places. */
const RATE_DECIMALS = 6

interface Valued {
  readonly usdScaled: bigint | null
  readonly quotedAt: string | null
  readonly reason: string | null
  /** Pricing's `source`, and only where a pricing quote actually produced the figure. */
  readonly source: string | null
}

/**
 * One holding's USD value.
 *
 * Three cases, and the first two are not quotes at all:
 *
 *   - **SHARD** is fixed by contract at `SHARDS_PER_USD`. It is the platform's unit of account,
 *     not a traded asset, and asking pricing for it would invite an answer that could disagree
 *     with the constant every purchase is denominated against.
 *   - **USD** is itself, held as cents.
 *   - **Everything else** needs a usable quote, and has no value without one.
 */
function value(
  assetCode: LedgerAssetCode,
  amount: bigint,
  rate: PricingRate | undefined,
): Valued {
  if (assetCode === 'SHARD') {
    return {
      usdScaled: (amount * RATE_SCALE) / SHARDS_PER_USD,
      quotedAt: null,
      reason: null,
      source: null,
    }
  }
  if (assetCode === 'USD') {
    return {
      usdScaled: (amount * RATE_SCALE) / 10n ** BigInt(USD_DECIMALS),
      quotedAt: null,
      reason: null,
      source: null,
    }
  }
  if (isTokenAsset(assetCode)) {
    // A user-minted token has no oracle and no known decimals in this fan-out. Neither the amount
    // nor the value can be rendered honestly, so both say so. See the gap list in the README.
    return {
      usdScaled: null,
      quotedAt: null,
      reason: 'no price source for a minted token',
      source: null,
    }
  }
  if (!rate || !rate.usable || rate.usdScaled === null) {
    return {
      usdScaled: null,
      quotedAt: rate?.quotedAt ?? null,
      reason: rate?.reason ?? 'no quote available',
      source: null,
    }
  }
  const perCoin = safeBigInt(rate.usdScaled)
  if (perCoin === null) {
    return { usdScaled: null, quotedAt: rate.quotedAt, reason: 'malformed quote', source: null }
  }

  const decimals = decimalsFor(assetCode)
  if (decimals === null) {
    return { usdScaled: null, quotedAt: rate.quotedAt, reason: 'unknown decimals', source: null }
  }

  // amount is in smallest units; perCoin is USD per *whole* coin at RATE_SCALE. Dividing by the
  // asset's own scale last keeps every significant digit until the final truncation.
  return {
    usdScaled: (amount * perCoin) / 10n ** BigInt(decimals),
    quotedAt: rate.quotedAt,
    reason: null,
    // Pricing's own word, passed through rather than re-derived. A second list of which assets are
    // administered, kept here, is a second list to forget when one is added.
    source: rate.source,
  }
}

/** Null where nothing in this process can know the answer — a `TOKEN:` asset's decimals. */
function decimalsFor(assetCode: LedgerAssetCode): number | null {
  if (assetCode === 'USD') return USD_DECIMALS
  if (isChainAsset(assetCode)) return chainSpec(assetCode).decimals
  return null
}

/**
 * The allocation bars.
 *
 * Folds past eight rows into "Other" — §6 rule 6 — because a bar chart with twenty rows is a table
 * with a decorative background, and because the tail of a portfolio is noise at the size a
 * dashboard renders. Unpriced holdings are absent: a bar with no length is not informative, and
 * the holdings list already shows them with their reason.
 */
function foldAllocation(holdings: readonly Holding[], totalScaled: bigint): AllocationRow[] {
  if (totalScaled === 0n) return []
  const priced = holdings.filter((h) => h.usdScaled !== null)
  const head = priced.slice(0, ALLOCATION_ROWS)
  const tail = priced.slice(ALLOCATION_ROWS)

  const rows: AllocationRow[] = head.map((h) => {
    const scaled = BigInt(h.usdScaled ?? '0')
    return {
      label: h.assetCode,
      usdScaled: scaled.toString(),
      usd: formatAmount(scaled, RATE_DECIMALS),
      bps: Number((scaled * 10_000n) / totalScaled),
    }
  })

  if (tail.length > 0) {
    const rest = tail.reduce((sum, h) => sum + BigInt(h.usdScaled ?? '0'), 0n)
    rows.push({
      label: 'Other',
      usdScaled: rest.toString(),
      usd: formatAmount(rest, RATE_DECIMALS),
      bps: Number((rest * 10_000n) / totalScaled),
    })
  }
  return rows
}

/**
 * Parse an amount that arrived over the wire.
 *
 * A malformed value is skipped rather than thrown on: one bad row from an upstream must not cost
 * the whole portfolio tile, which is the same reasoning as the tile model one level up.
 */
function safeBigInt(text: string): bigint | null {
  try {
    return BigInt(text)
  } catch {
    return null
  }
}
