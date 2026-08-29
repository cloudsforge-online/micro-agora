/**
 * Fixed-point rate arithmetic. **There is not a floating-point operation in this file, and there
 * is a test that greps the whole source tree to keep it that way.**
 *
 * Everything here is pure: no I/O, no environment, no clock.
 *
 * ---------------------------------------------------------------------------------------------
 * The defect being fixed.
 *
 * `repos/forge-pay/services/pay/src/pricing.ts` converts every source quote with
 *
 *     BigInt(Math.floor(usd * Number(RATE_SCALE)))
 *
 * which is a float multiply by 1e6 followed by a floor. That is two roundings on the money path:
 * the exchange's decimal string was already rounded into a double by `Number()`, and multiplying
 * a double by 1e6 can move the result a whole unit at the sixth decimal place. The estate then
 * takes a median of those values and settles conversions against it.
 *
 * `parseScaled` below replaces it. It reads the decimal digits directly — no `Number`, no
 * `parseFloat`, no multiplication by 1e6 — so a source that quotes `"0.512345"` produces exactly
 * `512345n` and a source that quotes `"64231.5"` produces exactly `64231500000n`.
 *
 * The same file also renders rates back to the client with `Number(scaled) / Number(RATE_SCALE)`
 * (`pricing.ts`), which round-trips the rate through a double on the way out. `formatScaled`
 * replaces that: decimal values are strings end to end.
 * ---------------------------------------------------------------------------------------------
 */

import {
  type AssetCode,
  ON_CHAIN_ASSETS,
  RATE_SCALE,
  SHARDS_PER_USD,
} from '@cloudsforge/contracts-chain'

/**
 * Decimal places implied by `RATE_SCALE`.
 *
 * Derived from the constant rather than written as `6`, so that a coordinated change to
 * `RATE_SCALE` — which is exact-pinned and never redefined here — cannot leave this file behind.
 */
export const RATE_DECIMALS: number = RATE_SCALE.toString().length - 1

/**
 * Assets priced by a market, and assets priced by an operator.
 *
 * Both are *derived* from `ON_CHAIN_ASSETS` rather than listed again. A second list is a list that
 * drifts, and the shape of the drift here would be an asset that is quotable by one code path and
 * unknown to the other.
 *
 * EMBER is administered because Hearth has no exchange listing. Letting an administered number
 * override an asset that does have a market would turn a fail-closed oracle into a
 * fail-to-whatever-was-typed oracle, so the two sets are disjoint by construction.
 */
export const ADMINISTERED_ASSETS: readonly AssetCode[] = Object.freeze(['EMBER'])

export const MARKET_ASSETS: readonly AssetCode[] = Object.freeze(
  ON_CHAIN_ASSETS.filter((asset) => !ADMINISTERED_ASSETS.includes(asset)),
)

/** Every asset this service quotes, in a stable order. */
export const QUOTED_ASSETS: readonly AssetCode[] = Object.freeze([
  ...MARKET_ASSETS,
  ...ADMINISTERED_ASSETS,
])

export function isQuotedAsset(value: string): value is AssetCode {
  return (QUOTED_ASSETS as readonly string[]).includes(value)
}

export function isAdministeredAsset(value: string): boolean {
  return (ADMINISTERED_ASSETS as readonly string[]).includes(value)
}

/** Where a quote came from. Carried to the client, because the two mean different things. */
export type QuoteSource = 'market' | 'administered'

export function sourceKindFor(asset: string): QuoteSource {
  return isAdministeredAsset(asset) ? 'administered' : 'market'
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/

/**
 * Parse a decimal price string into a `RATE_SCALE` fixed-point integer, exactly.
 *
 * Returns `null` rather than throwing: this runs over data a third-party exchange sent us, and one
 * malformed field must drop that source from the round rather than abort it.
 *
 * **Precision beyond `RATE_DECIMALS` is truncated, not rounded and not refused.** A source quoting
 * seven decimal places is quoting below the scale the whole estate settles at, so the digits
 * cannot be represented; refusing would discard an otherwise good source over a sub-micro-dollar
 * tail. Truncation is toward zero, which is the same direction `shardsForCoinAmount` rounds, so
 * the bias never compounds against the platform.
 */
export function parseScaled(text: string): bigint | null {
  const match = DECIMAL.exec(text.trim())
  if (!match) return null
  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').slice(0, RATE_DECIMALS).padEnd(RATE_DECIMALS, '0')
  const value = BigInt(whole) * RATE_SCALE + BigInt(fraction === '' ? '0' : fraction)
  return value > 0n ? value : null
}

/**
 * Parse an operator-typed price. Unlike `parseScaled`, extra precision is **refused**.
 *
 * An operator who types more decimal places than the scale can hold has a different number in mind
 * from the one that would be stored, and silently truncating it is how an administered price ends
 * up an order of magnitude away from what somebody believes they set.
 */
export function parseAdministeredScaled(text: string): bigint | null {
  const match = DECIMAL.exec(text.trim())
  if (!match) return null
  if ((match[2] ?? '').length > RATE_DECIMALS) return null
  return parseScaled(text)
}

/**
 * Exact decimal rendering of a fixed-point integer. No float round-trip, in either direction.
 *
 * Carried forward verbatim in behaviour from `pricing.ts`, which is the one part of the old
 * oracle's formatting that was already right.
 */
export function formatScaled(scaled: bigint): string {
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const whole = abs / RATE_SCALE
  const fraction = (abs % RATE_SCALE).toString().padStart(RATE_DECIMALS, '0').replace(/0+$/, '')
  const sign = negative ? '-' : ''
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`
}

/** Ascending, by value. `Array.prototype.sort` compares as strings without this. */
export function sortScaled(values: readonly bigint[]): bigint[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * The median of a sorted set.
 *
 * A median rather than a mean, because a mean is moved by a single bad print and a median is not:
 * with four sources, one exchange showing a flash crash shifts a mean by a quarter of the error
 * and shifts the median by nothing.
 *
 * **An even count averages the two middle values and rounds down**, in BigInt. The alternative —
 * picking the lower or the upper middle — makes the rate depend on which of two equally valid
 * sources happened to answer, and rounding down keeps the same direction as every other rounding
 * decision in the estate (`shardsForCoinAmount` in contracts-chain).
 */
export function medianScaled(sorted: readonly bigint[]): bigint {
  if (sorted.length === 0) throw new RangeError('median of an empty set')
  const middle = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[middle]!
  return (sorted[middle - 1]! + sorted[middle]!) / 2n
}

/**
 * The spread across a sorted set, in basis points of the lowest quote.
 *
 * Measured against the low rather than the median so that the number answers the question an
 * operator actually asks — "how far apart are these" — without depending on the statistic the
 * round is about to compute from them.
 */
export function divergenceBps(sorted: readonly bigint[]): bigint {
  if (sorted.length < 2) return 0n
  const low = sorted[0]!
  const high = sorted[sorted.length - 1]!
  if (low <= 0n) throw new RangeError('a quote must be positive')
  return ((high - low) * 10_000n) / low
}

/**
 * Deduct the spread — the leg where the user is selling into the platform.
 *
 * Both legs are built from one constant so the spread cancels on a round trip only if it is
 * applied in opposite directions, which is exactly the point: what runs against the user, in both
 * directions and on purpose, is the spread itself.
 */
export function applySpreadSell(usdScaled: bigint, spreadBps: number): bigint {
  return (usdScaled * BigInt(10_000 - spreadBps)) / 10_000n
}

/**
 * Mark the price up — the leg where the user is buying from the platform.
 *
 * Higher than the sell price, necessarily. Quoting a purchase at the sell rate would let anyone
 * convert coin out and straight back in at a profit, and repeat it until the treasury is empty.
 */
export function applySpreadBuy(usdScaled: bigint, spreadBps: number): bigint {
  return (usdScaled * 10_000n) / BigInt(10_000 - spreadBps)
}

/**
 * Shards per one whole coin, at `RATE_SCALE`.
 *
 * `SHARDS_PER_USD` is imported from contracts-chain and never restated: a second declaration of
 * the Shard rate is precisely the skew that package is exact-pinned to prevent. A Shard is one US
 * cent, so this is a multiplication and nothing else.
 */
export function shardsPerCoinScaled(usdScaled: bigint): bigint {
  return usdScaled * SHARDS_PER_USD
}

/** What a round did. `rejected_divergence` is a distinct outcome because it is not a fetch fault. */
export type RoundOutcome = 'accepted' | 'too_few_sources' | 'rejected_divergence'

export interface RoundInput {
  readonly quotes: ReadonlyArray<{ readonly source: string; readonly usdScaled: bigint }>
  readonly minSources: number
  readonly maxDivergenceBps: number
}

export type RoundResult =
  | {
      readonly outcome: 'accepted'
      readonly usdScaled: bigint
      readonly sourceCount: number
      readonly divergenceBps: bigint
    }
  | {
      readonly outcome: 'too_few_sources' | 'rejected_divergence'
      readonly sourceCount: number
      readonly divergenceBps: bigint
      readonly reason: string
    }

/**
 * Decide one asset's round from the source quotes that answered.
 *
 * Pure, and separated from the fetching for that reason: every branch below is reachable in a test
 * without a network, a clock or a database, which is what makes the divergence rule something the
 * suite can actually pin down.
 *
 * **Divergence rejects the whole round.** If two sources disagree by more than the threshold, one
 * of them is wrong and there is no way to tell which — so none of them is usable. Taking the
 * median anyway would launder a bad print into a rate that money then settles against, and a
 * median of four is not robust to two wrong sources.
 */
export function decideRound(input: RoundInput): RoundResult {
  const sorted = sortScaled(input.quotes.map((q) => q.usdScaled))
  const sourceCount = sorted.length

  if (sourceCount < input.minSources) {
    return {
      outcome: 'too_few_sources',
      sourceCount,
      divergenceBps: 0n,
      reason: `only ${sourceCount} of ${input.minSources} required sources answered`,
    }
  }

  const spread = divergenceBps(sorted)
  if (spread > BigInt(input.maxDivergenceBps)) {
    return {
      outcome: 'rejected_divergence',
      sourceCount,
      divergenceBps: spread,
      reason: `sources diverged by ${spread} bps (limit ${input.maxDivergenceBps})`,
    }
  }

  return {
    outcome: 'accepted',
    usdScaled: medianScaled(sorted),
    sourceCount,
    divergenceBps: spread,
  }
}
