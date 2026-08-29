/**
 * The quote store, and the rate a caller may settle against.
 *
 * **This file is the fix.** The estate's oracle keeps its quotes in a module-level
 * `Map<DepositCoin, Quote>` (`repos/forge-pay/services/pay/src/pricing.ts`) and its
 * administered prices in a second one. Both are per-process, so two replicas quote two
 * different rates, an admin price update lands on exactly one of them, and a restart empties both.
 * A table makes the quote set one thing that the whole estate reads, and makes an administered
 * change atomic and estate-wide.
 *
 * Two behaviours here are load-bearing and easy to get backwards:
 *
 *   1. **A failed round does not erase the last good quote**, it records why it failed. Deleting
 *      the quote would turn a transient exchange outage into an immediate refusal to convert;
 *      keeping it lets the staleness rule decide, which is a decision about age rather than about
 *      one unlucky fetch.
 *   2. **An administered quote never goes stale.** It is configuration, not an observation, so
 *      there is nothing about it that decays. Applying the market max-age to it would make EMBER
 *      unconvertible five minutes after an operator set its price, which is not what fail-closed
 *      means.
 */

import { RATE_SCALE } from '@cloudsforge/contracts-chain'
import type { AssetCode } from '@cloudsforge/contracts-chain'
import {
  applySpreadBuy,
  applySpreadSell,
  formatScaled,
  isAdministeredAsset,
  shardsPerCoinScaled,
  sourceKindFor,
  type QuoteSource,
} from './rates.ts'
import type { Db } from './outbox.ts'

/** One asset's row: the last good quote and the last failure, together. */
export interface QuoteRecord {
  readonly asset: AssetCode
  /** Null when no round has ever been accepted for this asset. */
  readonly usdScaled: bigint | null
  readonly source: QuoteSource
  readonly sourceCount: number
  readonly divergenceBps: bigint | null
  readonly quotedAt: string | null
  readonly updatedAt: string
  readonly lastFailure: string | null
  readonly lastFailureAt: string | null
}

export interface AdministeredPrice {
  readonly asset: AssetCode
  readonly usdScaled: bigint
  /** Null while it is still the seeded default — nobody has taken responsibility for it yet. */
  readonly setBy: string | null
  readonly setByHandle: string | null
  readonly updatedAt: string
}

export interface HistoryEntry {
  readonly asset: AssetCode
  readonly usdScaled: bigint
  readonly source: QuoteSource
  readonly sourceCount: number
  readonly divergenceBps: bigint | null
  readonly setBy: string | null
  readonly observedAt: string
}

interface QuoteRow {
  readonly asset: string
  readonly usd_scaled: string | null
  readonly source: string
  readonly source_count: number
  readonly divergence_bps: number | null
  readonly quoted_at: Date | null
  readonly updated_at: Date
  readonly last_failure: string | null
  readonly last_failure_at: Date | null
}

interface AdministeredRow {
  readonly asset: string
  readonly usd_scaled: string
  readonly set_by: string | null
  readonly set_by_handle: string | null
  readonly updated_at: Date
}

interface HistoryRow {
  readonly asset: string
  readonly usd_scaled: string
  readonly source: string
  readonly source_count: number
  readonly divergence_bps: number | null
  readonly set_by: string | null
  readonly observed_at: Date
}

const toQuote = (row: QuoteRow): QuoteRecord => ({
  asset: row.asset as AssetCode,
  // `numeric` comes back from postgres.js as a string, deliberately: it is wider than a JS number
  // and the driver refuses to lose the difference. BigInt reads it exactly.
  usdScaled: row.usd_scaled === null ? null : BigInt(row.usd_scaled),
  source: row.source as QuoteSource,
  sourceCount: row.source_count,
  divergenceBps: row.divergence_bps === null ? null : BigInt(row.divergence_bps),
  quotedAt: row.quoted_at?.toISOString() ?? null,
  updatedAt: row.updated_at.toISOString(),
  lastFailure: row.last_failure,
  lastFailureAt: row.last_failure_at?.toISOString() ?? null,
})

const toAdministered = (row: AdministeredRow): AdministeredPrice => ({
  asset: row.asset as AssetCode,
  usdScaled: BigInt(row.usd_scaled),
  setBy: row.set_by,
  setByHandle: row.set_by_handle,
  updatedAt: row.updated_at.toISOString(),
})

// The column list is written out at every call site rather than shared through a fragment.
// postgres.js interpolates a value, not an identifier list, so a shared constant would have to go
// through `sql.unsafe` — and an unsafe fragment inside an otherwise parameterised query is a habit
// that survives long enough to be reached for with something a caller supplied.
export async function readQuotes(sql: Db): Promise<QuoteRecord[]> {
  const rows = await sql<QuoteRow[]>`
    select asset, usd_scaled, source, source_count, divergence_bps, quoted_at, updated_at,
           last_failure, last_failure_at
      from price_quotes
     order by asset
  `
  return rows.map(toQuote)
}

export async function readQuote(sql: Db, asset: AssetCode): Promise<QuoteRecord | null> {
  const rows = await sql<QuoteRow[]>`
    select asset, usd_scaled, source, source_count, divergence_bps, quoted_at, updated_at,
           last_failure, last_failure_at
      from price_quotes
     where asset = ${asset}
  `
  const row = rows[0]
  return row ? toQuote(row) : null
}

export interface AcceptedRound {
  readonly asset: AssetCode
  readonly usdScaled: bigint
  readonly sourceCount: number
  readonly divergenceBps: bigint
  /** Explicit so a replayed or backfilled round records when it was observed, not when it landed. */
  readonly observedAt?: Date
}

/**
 * Record an accepted round: the quote and its history row, in one transaction.
 *
 * One transaction because the history is the evidence for the quote. A quote with no history row
 * behind it is a rate nobody can explain after the fact, which is the position the estate is in
 * today — its oracle keeps no history at all, so a disputed conversion cannot be checked against
 * what the sources actually said.
 *
 * The failure fields are cleared here: the round succeeded, so the previous reason no longer
 * describes the current state of this asset.
 */
export async function recordAccepted(sql: Db, round: AcceptedRound): Promise<QuoteRecord> {
  const observedAt = (round.observedAt ?? new Date()).toISOString()
  const usdScaled = round.usdScaled.toString()
  const divergence = Number(round.divergenceBps)

  const outcome = await sql.begin(async (tx) => {
    const rows = await tx<QuoteRow[]>`
      insert into price_quotes (
        asset, usd_scaled, source, source_count, divergence_bps, quoted_at, updated_at,
        last_failure, last_failure_at
      )
      values (
        ${round.asset}, ${usdScaled}::numeric, 'market', ${round.sourceCount}, ${divergence},
        ${observedAt}::timestamptz, now(), null, null
      )
      on conflict (asset) do update set
        usd_scaled      = excluded.usd_scaled,
        source          = excluded.source,
        source_count    = excluded.source_count,
        divergence_bps  = excluded.divergence_bps,
        quoted_at       = excluded.quoted_at,
        updated_at      = now(),
        last_failure    = null,
        last_failure_at = null
      returning asset, usd_scaled, source, source_count, divergence_bps, quoted_at, updated_at,
                last_failure, last_failure_at
    `
    await tx`
      insert into price_history (asset, usd_scaled, source, source_count, divergence_bps, observed_at)
      values (
        ${round.asset}, ${usdScaled}::numeric, 'market', ${round.sourceCount}, ${divergence},
        ${observedAt}::timestamptz
      )
    `
    const row = rows[0]
    if (!row) throw new Error('upsert returned no row')
    return { value: toQuote(row) }
  })
  // Wrapped in an object so postgres.js does not treat an array-shaped result as a list of
  // promises to unwrap, which would rewrite the caller's return type.
  return outcome.value
}

/**
 * Record why a round did not produce a quote.
 *
 * The previous quote is left in place on purpose — see the note at the top of this file. What
 * changes is that the rate board can now say "the last three rounds were rejected for divergence"
 * instead of silently serving a number whose refresh has been failing for an hour.
 */
export async function recordFailure(sql: Db, asset: AssetCode, reason: string): Promise<void> {
  await sql`
    insert into price_quotes (asset, source, source_count, updated_at, last_failure, last_failure_at)
    values (${asset}, ${sourceKindFor(asset)}, 0, now(), ${reason}, now())
    on conflict (asset) do update set
      updated_at      = now(),
      last_failure    = excluded.last_failure,
      last_failure_at = now()
  `
}

export async function readAdministered(sql: Db): Promise<AdministeredPrice[]> {
  const rows = await sql<AdministeredRow[]>`
    select asset, usd_scaled, set_by, set_by_handle, updated_at
      from administered_prices
     order by asset
  `
  return rows.map(toAdministered)
}

export interface SetAdministered {
  readonly asset: AssetCode
  readonly usdScaled: bigint
  /** Who decided this. Recorded because an administered price is an act somebody took. */
  readonly setBy: string
  readonly setByHandle: string
}

/**
 * Set an administered price, and the quote it produces, in one transaction.
 *
 * The two writes are together because they are one fact. The estate's version updates a row and
 * then a per-process cache (`pricing.ts`), which means the replica that served the request has
 * the new price and every other replica keeps serving the old one until it happens to restart.
 * Here there is no cache to fall out of step: the next `GET /rates` on any replica reads the row.
 */
export async function setAdministeredPrice(sql: Db, input: SetAdministered): Promise<AdministeredPrice> {
  const usdScaled = input.usdScaled.toString()

  const outcome = await sql.begin(async (tx) => {
    const rows = await tx<AdministeredRow[]>`
      insert into administered_prices (asset, usd_scaled, set_by, set_by_handle, updated_at)
      values (${input.asset}, ${usdScaled}::numeric, ${input.setBy}, ${input.setByHandle}, now())
      on conflict (asset) do update set
        usd_scaled    = excluded.usd_scaled,
        set_by        = excluded.set_by,
        set_by_handle = excluded.set_by_handle,
        updated_at    = now()
      returning asset, usd_scaled, set_by, set_by_handle, updated_at
    `
    const row = rows[0]
    if (!row) throw new Error('upsert returned no row')

    await tx`
      insert into price_quotes (
        asset, usd_scaled, source, source_count, divergence_bps, quoted_at, updated_at,
        last_failure, last_failure_at
      )
      values (
        ${input.asset}, ${usdScaled}::numeric, 'administered', 0, null, ${row.updated_at}, now(),
        null, null
      )
      on conflict (asset) do update set
        usd_scaled      = excluded.usd_scaled,
        source          = 'administered',
        source_count    = 0,
        divergence_bps  = null,
        quoted_at       = excluded.quoted_at,
        updated_at      = now(),
        last_failure    = null,
        last_failure_at = null
    `

    await tx`
      insert into price_history (asset, usd_scaled, source, source_count, set_by, observed_at)
      values (${input.asset}, ${usdScaled}::numeric, 'administered', 0, ${input.setBy}, ${row.updated_at})
    `

    return { value: toAdministered(row) }
  })
  return outcome.value
}

/**
 * Copy any administered price whose quote row is behind it into `price_quotes`.
 *
 * `setAdministeredPrice` already writes both, so this is a repair path rather than the main one:
 * it covers a price inserted by a migration, by a restore, or by an operator in psql. Run from the
 * refresh job, where it costs one query per pass.
 */
export async function syncAdministeredQuotes(sql: Db): Promise<number> {
  const result = await sql`
    insert into price_quotes (
      asset, usd_scaled, source, source_count, divergence_bps, quoted_at, updated_at
    )
    select a.asset, a.usd_scaled, 'administered', 0, null, a.updated_at, now()
      from administered_prices a
    on conflict (asset) do update set
      usd_scaled = excluded.usd_scaled,
      source     = 'administered',
      quoted_at  = excluded.quoted_at,
      updated_at = now()
    where price_quotes.usd_scaled is distinct from excluded.usd_scaled
       or price_quotes.quoted_at  is distinct from excluded.quoted_at
  `
  return result.count
}

export async function readHistory(sql: Db, asset: AssetCode, limit: number): Promise<HistoryEntry[]> {
  const rows = await sql<HistoryRow[]>`
    select asset, usd_scaled, source, source_count, divergence_bps, set_by, observed_at
      from price_history
     where asset = ${asset}
     order by observed_at desc, id desc
     limit ${limit}
  `
  return rows.map((row) => ({
    asset: row.asset as AssetCode,
    usdScaled: BigInt(row.usd_scaled),
    source: row.source as QuoteSource,
    sourceCount: row.source_count,
    divergenceBps: row.divergence_bps === null ? null : BigInt(row.divergence_bps),
    setBy: row.set_by,
    observedAt: row.observed_at.toISOString(),
  }))
}

/* ------------------------------------------------------------------------ the rate view */

export interface RateOptions {
  readonly maxAgeSeconds: number
  readonly conversionSpreadBps: number
  /** Injected so a staleness test does not sleep and a replay is deterministic. */
  readonly now?: number
}

/**
 * What a caller may settle against, or why it may not.
 *
 * **Every decimal value is a string, and the scaled integers are strings too.** A JSON number is
 * an IEEE 754 double; a rate that crosses the wire as one has lost precision before the consumer
 * parses it, which is the same defect as computing it in a float. `usdScaled` is the field a
 * consuming service does arithmetic on, with BigInt, at `RATE_SCALE`.
 */
export interface RateView {
  readonly asset: AssetCode
  readonly source: QuoteSource
  readonly usable: boolean
  /** Present exactly when `usable` is false. Says what is wrong, rather than serving a number. */
  readonly reason?: string
  readonly sourceCount: number
  readonly divergenceBps: string | null
  readonly quotedAt: string | null
  readonly ageSeconds: number | null
  /** Mid-market, before the spread. Null when there is no usable quote. */
  readonly usdScaled: string | null
  readonly usd: string | null
  /** The user sells coin into the platform at this price; the spread is deducted. */
  readonly usdSellScaled: string | null
  readonly usdSell: string | null
  /** The user buys coin from the platform at this price; the spread is added. */
  readonly usdBuyScaled: string | null
  readonly usdBuy: string | null
  /** Shards per one whole coin, both legs, at RATE_SCALE. */
  readonly shardsPerCoinSellScaled: string | null
  readonly shardsPerCoinSell: string | null
  readonly shardsPerCoinBuyScaled: string | null
  readonly shardsPerCoinBuy: string | null
  /** The last refresh failure, if there is one. Served even when the stored quote is still usable. */
  readonly lastFailure: string | null
  readonly lastFailureAt: string | null
  /** `RATE_SCALE`, so a consumer never has to assume the scale it is doing BigInt maths at. */
  readonly rateScale: string
}

function unusable(
  asset: AssetCode,
  source: QuoteSource,
  reason: string,
  record: QuoteRecord | null,
  ageSeconds: number | null,
): RateView {
  return {
    asset,
    source,
    usable: false,
    reason,
    sourceCount: record?.sourceCount ?? 0,
    divergenceBps: record?.divergenceBps?.toString() ?? null,
    quotedAt: record?.quotedAt ?? null,
    ageSeconds,
    usdScaled: null,
    usd: null,
    usdSellScaled: null,
    usdSell: null,
    usdBuyScaled: null,
    usdBuy: null,
    shardsPerCoinSellScaled: null,
    shardsPerCoinSell: null,
    shardsPerCoinBuyScaled: null,
    shardsPerCoinBuy: null,
    lastFailure: record?.lastFailure ?? null,
    lastFailureAt: record?.lastFailureAt ?? null,
    rateScale: RATE_SCALE.toString(),
  }
}

/**
 * Project a stored quote onto the rate a caller may use.
 *
 * **Fail-closed staleness lives here.** Past `maxAgeSeconds` a market quote is not a discount, it
 * is an unknown price, and crediting against it is the money leak the oracle exists to close. The
 * view still carries the age and the reason, so a client can tell "we are not quoting BTC right
 * now, the last round was 11 minutes ago" from "we have never quoted BTC".
 */
export function rateView(
  asset: AssetCode,
  record: QuoteRecord | null,
  options: RateOptions,
): RateView {
  const source = sourceKindFor(asset)
  if (!record || record.usdScaled === null || record.usdScaled <= 0n) {
    const reason =
      record?.lastFailure ??
      (source === 'administered' ? 'no administered price set' : 'no quote yet')
    return unusable(asset, source, reason, record, null)
  }

  const now = options.now ?? Date.now()
  const quotedAtMs = record.quotedAt ? Date.parse(record.quotedAt) : Number.NaN
  const ageSeconds = Number.isNaN(quotedAtMs) ? null : Math.floor((now - quotedAtMs) / 1000)

  // An administered price is configuration, not an observation, so nothing about it decays. Its
  // age is still reported — an operator wants to know that EMBER was last priced in March.
  if (record.source === 'market' || !isAdministeredAsset(asset)) {
    if (ageSeconds === null) {
      return unusable(asset, source, 'quote has no observation time', record, null)
    }
    if (ageSeconds > options.maxAgeSeconds) {
      return unusable(
        asset,
        source,
        `quote is ${ageSeconds}s old, past the ${options.maxAgeSeconds}s maximum`,
        record,
        ageSeconds,
      )
    }
  }

  const usdScaled = record.usdScaled
  const usdSell = applySpreadSell(usdScaled, options.conversionSpreadBps)
  const usdBuy = applySpreadBuy(usdScaled, options.conversionSpreadBps)
  if (usdSell <= 0n) {
    // Only reachable for a price so small the spread rounds it to nothing. Quoting zero would let
    // a conversion take coin and credit no Shards at all.
    return unusable(asset, source, 'price is below the smallest quotable unit', record, ageSeconds)
  }

  return {
    asset,
    source: record.source,
    usable: true,
    sourceCount: record.sourceCount,
    divergenceBps: record.divergenceBps?.toString() ?? null,
    quotedAt: record.quotedAt,
    ageSeconds,
    usdScaled: usdScaled.toString(),
    usd: formatScaled(usdScaled),
    usdSellScaled: usdSell.toString(),
    usdSell: formatScaled(usdSell),
    usdBuyScaled: usdBuy.toString(),
    usdBuy: formatScaled(usdBuy),
    shardsPerCoinSellScaled: shardsPerCoinScaled(usdSell).toString(),
    shardsPerCoinSell: formatScaled(shardsPerCoinScaled(usdSell)),
    shardsPerCoinBuyScaled: shardsPerCoinScaled(usdBuy).toString(),
    shardsPerCoinBuy: formatScaled(shardsPerCoinScaled(usdBuy)),
    lastFailure: record.lastFailure,
    lastFailureAt: record.lastFailureAt,
    rateScale: RATE_SCALE.toString(),
  }
}
