/**
 * Sparks, EMBER, and the arithmetic of a sale.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **SPARKS IS A DISPLAY DENOMINATION OF EMBER. IT IS NOT A SECOND `assetCode`, AND IT MUST NEVER
 * BECOME ONE.** — 23-tessera.md §8.1, which calls that the most important sentence in the section.
 *
 * The reason is the estate's oldest defect. The ledger's balancing invariant is enforced PER
 * `asset_code` by trigger (`ledger/src/migrations.ts`), so if Sparks were its own asset
 * code the trigger would happily let Sparks and EMBER drift apart, and reconciling them would
 * require a rate — and a rate between an internal unit and a chain asset is precisely the
 * mechanism of `convertCoinToEmber`, which "credit[s] custodial EMBER with no on-chain movement
 * behind it" (`ledger/src/migrations.ts`), described at `wallet/src/money.ts` as "a
 * liability minted against nothing, with no counter-account and therefore nothing that could ever
 * notice".
 *
 * One asset, one trial balance, one number to reconcile against the chain. Sparks is what the
 * client prints. There is no `SPARK` string anywhere in this service and `sparks.test.ts` greps
 * the source to keep it that way.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { LedgerAssetCode } from '@cloudsforge/contracts-money'

/**
 * The one asset. `contracts-chain` owns the code and its 18 decimals; this names it, once.
 *
 * Typed as `LedgerAssetCode` deliberately: a typo becomes a compile error rather than a posting
 * against an asset the ledger has never heard of. `ledger/src/accounts.ts` throws on a type
 * mismatch and whichever service posts second has every entry refused, so the spelling is not a
 * detail.
 */
export const ASSET: LedgerAssetCode = 'EMBER'

/** EMBER's decimals, from `contracts-chain` via the chain spec. 18. */
export const EMBER_DECIMALS = 18

/** Sparks' decimals. §8.1: "A Spark is 10⁻⁶ EMBER — one micro-EMBER". */
export const SPARK_DECIMALS = 6

/**
 * One Spark, in wei. `10 ** (18 - 6)` = 10¹².
 *
 * Computed from the two exponents rather than typed as a literal, because a literal with twelve
 * zeros in it is a literal somebody eventually types with eleven. `sparks.test.ts` asserts this
 * equals the SQL literal the CHECK constraints are built from (`WEI_PER_SPARK_SQL`), so the
 * TypeScript and the database cannot come to disagree about what a Spark is.
 */
export const WEI_PER_SPARK = 10n ** BigInt(EMBER_DECIMALS - SPARK_DECIMALS)

export class MoneyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyError'
  }
}

/**
 * The one shape a wei amount may arrive in. **This regex is the whole safety property.**
 *
 * §11.5: "`BigInt('')` is `0n`, which turns a missing amount into a free purchase. `micro-market`
 * makes it **unreachable rather than handled**: `parseAmount` requires `/^\d{1,78}$/` **before**
 * calling `BigInt` (`market/src/money.ts`). Tessera imports that helper rather than
 * writing a second one."
 *
 * **It could not be imported, and that is worth recording rather than quietly working around.**
 * The design's instruction assumed the helper was reachable. It is not: `micro-market` is a
 * separate repository with a separate database and nothing but `@cloudsforge/*` is shared, and
 * `@cloudsforge/contracts-money` does not export a `parseAmount` of this shape — it imports
 * `contracts-chain`'s, which is a different function with a different signature
 * (`parseAmount(text, decimals)`, a decimal-string-to-smallest-units converter that accepts a
 * decimal point) and does not re-export it. Promoting market's strict parser into
 * `contracts-money` is a change to a package twenty-two consumers depend on and is not this
 * commit's business.
 *
 * So the guard is copied verbatim, cited, and `sparks.test.ts` asserts the hazard is unreachable
 * through this door directly — `''`, `' '`, `'1e3'`, `'0x10'`, `'-1'`, `'1.0'`, `null`, `undefined`,
 * a number, and a 79-digit string all raise rather than returning `0n`. A test that only checked
 * `''` would pass against `BigInt(value ?? '0')`, which is the wrong fix wearing the right shape.
 */
const WEI_PATTERN = /^\d{1,78}$/

/**
 * A decimal string of wei, parsed strictly. Strings on the wire and in the database, `bigint` in
 * memory, never a `number` in between: `Number.MAX_SAFE_INTEGER` is about 9×10¹⁵ and a single
 * EMBER is 10¹⁸ wei, so a JSON number is wrong before it is large.
 */
export function parseWei(value: unknown, field = 'priceWei'): bigint {
  if (typeof value !== 'string' || !WEI_PATTERN.test(value)) {
    throw new MoneyError(`${field} must be a decimal string of up to 78 digits`)
  }
  return BigInt(value)
}

/**
 * A price, parsed and held to the Spark floor.
 *
 * The database refuses a sub-Spark price too (`tessera_price_whole_sparks`). Both, deliberately:
 * the CHECK is the guarantee and this is the error message, because "violates check constraint
 * tessera_price_whole_sparks" is not something to show a person who typed a number.
 */
export function parsePriceWei(value: unknown, field = 'priceWei'): bigint {
  const wei = parseWei(value, field)
  if (wei % WEI_PER_SPARK !== 0n) {
    throw new MoneyError(
      `${field} must be a whole number of Sparks — one Spark is ${WEI_PER_SPARK} wei (23-tessera.md §8.1)`,
    )
  }
  return wei
}

/** Wei to Sparks, for display. Exact by construction: the caller has already been held to the floor. */
export function toSparks(wei: bigint): bigint {
  if (wei % WEI_PER_SPARK !== 0n) {
    throw new MoneyError(`${wei} wei is not a whole number of Sparks`)
  }
  return wei / WEI_PER_SPARK
}

/** Sparks to wei. The direction a client's "400 Sparks" comes in on. */
export function fromSparks(sparks: bigint): bigint {
  return sparks * WEI_PER_SPARK
}

/* ---------------------------------------------------------------------------- the split */

export const BPS_SCALE = 10_000n

/**
 * `bps` of `amount`, **rounded down**.
 *
 * Down, deliberately, and in the platform's disfavour — `market/src/money.ts`. The seller's
 * proceeds are the REMAINDER, so every wei that rounding does not assign to the fee or a royalty
 * goes to the seller. Rounding the other way would leak value out of the partition by one wei per
 * sale, in the platform's favour, invisibly.
 *
 * This is a second implementation of a function that exists in `micro-market`, and that is worth
 * being honest about rather than quiet about. §11.5 says to import market's helper; a cross-repo
 * TypeScript import is not something this estate has (rule 1 is a database per service and the
 * only shared code is `@cloudsforge/*`), and promoting the three sale helpers into
 * `contracts-money` is a change to a package twenty-two consumers depend on, which is not this
 * commit's business. So the copy is byte-identical to market's, cited, and `sparks.test.ts`
 * property-tests the three properties that matter — round-down, exact partition, and no dust to a
 * zero-weight recipient — against randomised inputs rather than trusting the copy.
 */
export function bpsOf(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new MoneyError(`bps must be a whole number between 0 and 10000 (got ${bps})`)
  }
  if (amount < 0n) throw new MoneyError('amount must not be negative')
  return (amount * BigInt(bps)) / BPS_SCALE
}

export interface SaleTerms {
  readonly priceWei: bigint
  readonly platformFeeBps: number
  readonly royaltyBps: number
}

export interface SaleSplit {
  readonly priceWei: bigint
  readonly feeWei: bigint
  readonly royaltyWei: bigint
  readonly proceedsWei: bigint
}

/**
 * What the seller actually receives, computed the way micro-market will compute it at settlement.
 *
 * Tessera does not settle — §8.5's settlement is one balanced ledger entry built by
 * `market/src/orders.ts`. This exists so the seller can be SHOWN the number before they
 * list, and it must agree with market to the wei or the shown number is a lie. Hence the property
 * test rather than three examples.
 *
 * `proceeds = price − fee − royalty`, the remainder, so `fee + royalty + proceeds === price` holds
 * by construction rather than by arithmetic luck (`market/src/money.ts`).
 */
export function splitSale(terms: SaleTerms): SaleSplit {
  if (terms.priceWei < 0n) throw new MoneyError('priceWei must not be negative')
  if (terms.platformFeeBps + terms.royaltyBps >= 10_000) {
    throw new MoneyError('the fee and royalty must leave the seller something')
  }
  const feeWei = bpsOf(terms.priceWei, terms.platformFeeBps)
  const royaltyWei = bpsOf(terms.priceWei, terms.royaltyBps)
  const proceedsWei = terms.priceWei - feeWei - royaltyWei
  const split = { priceWei: terms.priceWei, feeWei, royaltyWei, proceedsWei }
  assertPartition(split)
  return split
}

/**
 * The partition, asserted on every call.
 *
 * `market/src/money.ts` does the same, and Postgres asserts it a third time on the order
 * row (`orders_partition`, `market/src/migrations.ts`). Three assertions of one identity is
 * not redundancy: each is reachable by a caller the other two are not.
 */
export function assertPartition(split: SaleSplit): void {
  const sum = split.feeWei + split.royaltyWei + split.proceedsWei
  if (sum !== split.priceWei) {
    throw new MoneyError(
      `the split does not partition the price: ${split.feeWei} + ${split.royaltyWei} + ${split.proceedsWei} = ${sum}, not ${split.priceWei}`,
    )
  }
  if (split.proceedsWei < 0n) {
    throw new MoneyError('the seller would receive a negative amount')
  }
}

/**
 * Split one amount across weighted recipients by largest remainder, with an index tie-break.
 *
 * `market/src/money.ts`, and the tie-break is why it is copied rather than approximated:
 * two replicas computing one royalty split must agree exactly, and "largest remainder" alone is
 * ambiguous when two remainders are equal. §8.5 names the case this matters for here — "a
 * derivative object splits its royalty between the original author and the remixer, so a remix
 * culture is expressible without either party trusting the other".
 *
 * A zero-weight recipient receives nothing, ever, including dust (`market/src/money.ts`).
 */
export function allocate(total: bigint, weights: readonly number[]): bigint[] {
  if (total < 0n) throw new MoneyError('total must not be negative')
  for (const w of weights) {
    if (!Number.isInteger(w) || w < 0) throw new MoneyError(`weights must be whole and non-negative (got ${w})`)
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  if (totalWeight === 0) return weights.map(() => 0n)

  const shares = weights.map((w) => (total * BigInt(w)) / BigInt(totalWeight))
  let assigned = shares.reduce((a, b) => a + b, 0n)
  let remainder = total - assigned

  // Order by descending remainder, then by ascending index. The index tie-break is what makes two
  // replicas produce the same array rather than the same multiset.
  const order = weights
    .map((w, i) => ({
      i,
      // The fractional part, scaled to an integer so it can be compared without floats.
      rem: (total * BigInt(w)) % BigInt(totalWeight),
      weight: w,
    }))
    .filter((e) => e.weight > 0)
    .sort((a, b) => (b.rem === a.rem ? a.i - b.i : b.rem > a.rem ? 1 : -1))

  for (const entry of order) {
    if (remainder <= 0n) break
    shares[entry.i] = (shares[entry.i] ?? 0n) + 1n
    remainder -= 1n
    assigned += 1n
  }
  return shares
}
