/**
 * The custodial stake: a bettor who brought BTC, and the ledger entry that is their position.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A CUSTODIAL STAKE IS A LEDGER ENTRY, NOT A SIGNING CAPABILITY.**
 *
 * `custody/src/gates.ts` lists the purposes custody will sign for — `deployer`, `treasury`,
 * `deposit` — and `user` is deliberately not among them. Nothing here asks for that to change. The
 * platform stakes the converted EMBER on chain from its OWN published address, exactly as the
 * house seed already does (`houseseed.ts`, and the argument at its head), and the user's share of
 * that aggregate position lives in `custodial_stakes` plus two ledger entries.
 *
 * **What that costs the user, said plainly rather than buried.** A self-custody stake survives
 * this platform being switched off: the EMBER is theirs in the contract and `claim()` reads
 * nothing but the contract's storage. A custodial stake does not — the aggregate in the contract
 * belongs to the platform address, and the user's share exists only in the ledger. That is what
 * "custodial" already means everywhere else in the estate, it is the only shape in which a BTC
 * holder can bet at all, and `stakeDisclosure` puts it on the screen where the user chooses.
 *
 * ── THE FOUR STATES, AND WHERE THE MONEY IS IN EACH ───────────────────────────────────────────
 *
 *   accepted   The user's stake asset has moved from `available` to `escrow`. It is still THEIRS.
 *              Nothing is on chain yet. A market that closes now refunds them, whole, in the asset
 *              they staked, in the amount they staked.
 *   staked     The platform has put `pool_amount` EMBER into the contract and the mirror shows it.
 *   settled    The market resolved. The escrowed asset became the platform's — it paid for the
 *              EMBER — and a winner's EMBER payout has been credited to them.
 *   refunded   The stake was never put on chain and the escrow was returned intact.
 *
 * ── WHAT THE PLATFORM IS AND IS NOT EXPOSED TO ────────────────────────────────────────────────
 *
 * On a stake the platform gives `pool_amount` EMBER and takes `stake_amount` BTC; whatever the
 * market does afterwards, both of those numbers are fixed. So the platform carries the FX from the
 * instant of the stake and carries NO exposure to the outcome — the outcome is settled entirely
 * inside the contract, between stakers. That is the position it can honestly disclose, and it is
 * the reason a payout is not converted back automatically: doing that at settlement time would
 * hand the platform the reverse leg on every winner at once, in the same direction, which is an
 * unhedged book against its own users.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Db, Tx } from './outbox.ts'
import type { Posting } from './ledgerclient.ts'
import {
  POOL_ASSET,
  POOL_DECIMALS,
  StakeAssetError,
  disclosureFor,
  formatUnits,
  isTokenStakeAsset,
  poolAmountFor,
  stakeAssetDecimals,
  type Denomination,
  type StakeAsset,
  type StakeAssetCode,
  type StakeRates,
} from './stakeassets.ts'

/**
 * `paid` is the terminal state of a stake the chain never saw — see migration 12.
 *
 * `settled` and `paid` both mean "this market is over and this position was resolved", and they
 * are two states rather than one because only the first is a claim about a transaction. A
 * reconciler comparing the ledger against the contract must be able to tell them apart without
 * reading a nullable column and guessing what its emptiness meant.
 */
export type CustodialStakeState = 'accepted' | 'staked' | 'settled' | 'refunded' | 'paid'

export interface CustodialStake {
  readonly id: string
  readonly marketId: string
  readonly subject: string
  readonly outcome: number
  readonly stakeAssetCode: StakeAssetCode
  readonly stakeAmount: bigint
  readonly poolAmount: bigint
  readonly rates: StakeRates
  /**
   * The address the platform would have staked this from, or null when nothing ever will.
   *
   * Null is the ordinary case and not a gap: a stake resolved through `paid` is settled in the
   * ledger and never reaches the chain, so there is no address it came from. Migration 13 ties a
   * non-null value to the two states that assert the chain saw the stake.
   */
  readonly platformAddress: string | null
  readonly state: CustodialStakeState
  readonly escrowEntryId: string | null
  readonly settleEntryId: string | null
  readonly txHash: string | null
  readonly idempotencyKey: string
  readonly createdAt: Date
  readonly stakedAt: Date | null
  readonly resolvedAt: Date | null
}

interface StakeRow {
  readonly id: string
  readonly market_id: string
  readonly subject: string
  readonly outcome: number
  readonly stake_asset_code: string
  readonly stake_amount: string
  readonly pool_amount: string
  readonly stake_rate_usd_scaled: string
  readonly pool_rate_usd_scaled: string
  readonly platform_address: string | null
  readonly state: string
  readonly escrow_entry_id: string | null
  readonly settle_entry_id: string | null
  readonly tx_hash: string | null
  readonly idempotency_key: string
  readonly created_at: Date
  readonly staked_at: Date | null
  readonly resolved_at: Date | null
}

const COLUMNS = `id, market_id, subject, outcome, stake_asset_code, stake_amount::text,
  pool_amount::text, stake_rate_usd_scaled::text, pool_rate_usd_scaled::text, platform_address,
  state, escrow_entry_id, settle_entry_id, tx_hash, idempotency_key, created_at, staked_at,
  resolved_at`

function toStake(row: StakeRow): CustodialStake {
  return {
    id: row.id,
    marketId: row.market_id,
    subject: row.subject,
    outcome: row.outcome,
    stakeAssetCode: row.stake_asset_code as StakeAssetCode,
    // Every one of these is a bigint from a `numeric(78,0)` rendered as text. Never `Number()`:
    // one EMBER is 1e18 wei and a double loses the bottom of it.
    stakeAmount: BigInt(row.stake_amount),
    poolAmount: BigInt(row.pool_amount),
    rates: {
      stakeUsdScaled: BigInt(row.stake_rate_usd_scaled),
      poolUsdScaled: BigInt(row.pool_rate_usd_scaled),
    },
    platformAddress: row.platform_address,
    state: row.state as CustodialStakeState,
    escrowEntryId: row.escrow_entry_id,
    settleEntryId: row.settle_entry_id,
    txHash: row.tx_hash,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    stakedAt: row.staked_at,
    resolvedAt: row.resolved_at,
  }
}

/* ------------------------------------------------------------------ the registry */

interface AssetRow {
  readonly asset_code: string
  readonly decimals: number
  readonly display_name: string
  readonly enabled: boolean
  readonly blocked_reason: string | null
}

function toAsset(row: AssetRow): StakeAsset {
  return {
    assetCode: row.asset_code as StakeAssetCode,
    decimals: row.decimals,
    displayName: row.display_name,
    enabled: row.enabled,
    blockedReason: row.blocked_reason,
  }
}

/** Everything the platform can name, enabled or not. A disabled asset is shown with its reason. */
export async function listStakeAssets(sql: Db | Tx): Promise<readonly StakeAsset[]> {
  const rows = await sql<AssetRow[]>`
    select asset_code, decimals, display_name, enabled, blocked_reason
      from stake_assets order by enabled desc, asset_code
  `
  return rows.map(toAsset)
}

export async function findStakeAsset(
  sql: Db | Tx,
  assetCode: StakeAssetCode,
): Promise<StakeAsset | null> {
  const rows = await sql<AssetRow[]>`
    select asset_code, decimals, display_name, enabled, blocked_reason
      from stake_assets where asset_code = ${assetCode}
  `
  const row = rows[0]
  return row ? toAsset(row) : null
}

/**
 * The registry's decimals are checked against the pinned package, never merely trusted.
 *
 * For a chain asset `contracts-chain` is the authority and a registry row that disagrees is a
 * misconfiguration that would size every stake in that asset wrongly by a power of ten. For a
 * `TOKEN:` urn there is no authority in this estate — decimals are chosen at the token's deploy
 * time — so the registry IS the source, which is exactly why the row has to be put there by an
 * operator and why 29 §4.4 asks for it to be verified against the contract before it is.
 */
export function assertRegistryDecimals(asset: StakeAsset): number {
  if (isTokenStakeAsset(asset.assetCode)) {
    return stakeAssetDecimals(asset.assetCode, asset.decimals)
  }
  const authoritative = stakeAssetDecimals(asset.assetCode)
  if (authoritative !== asset.decimals) {
    throw new StakeAssetError(
      'decimals_disagree',
      `the registry says ${asset.assetCode} has ${asset.decimals} decimals and contracts-chain says ` +
        `${authoritative} — refusing to price a stake against a disputed scale`,
      500,
    )
  }
  return authoritative
}

/* ------------------------------------------------------------------ quoting */

export interface StakeQuote {
  readonly asset: StakeAsset
  readonly denomination: Denomination
  readonly disclosure: string
}

/**
 * Price one stake, without taking it.
 *
 * Pure given the registry row and the rates, so the stake screen and the stake itself compute the
 * same number from the same inputs. A quote is deliberately NOT durable: a parimutuel stake is
 * priced at the moment it is taken, and a held quote would let a user sit on a stale rate and
 * choose the moment it favours them, which is a free option written by the platform.
 */
export function quoteStake(input: {
  readonly asset: StakeAsset
  readonly stakeAmount: bigint
  readonly rates: StakeRates
}): StakeQuote {
  const { asset, stakeAmount, rates } = input
  if (!asset.enabled) {
    throw new StakeAssetError(
      'asset_disabled',
      asset.blockedReason ?? `${asset.assetCode} is not currently accepted`,
      409,
    )
  }
  const decimals = assertRegistryDecimals(asset)
  const poolAmount =
    asset.assetCode === POOL_ASSET
      ? stakeAmount
      : poolAmountFor({ stakeAmount, stakeDecimals: decimals, rates })
  // The pool asset staked against itself is the identity, and the schema says so too
  // (`custodial_stakes_pool_asset_is_identity`). Applying a rate here would be a spread nobody
  // named, and it would be invisible because both sides carry the same unit.
  const effectiveRates: StakeRates =
    asset.assetCode === POOL_ASSET
      ? { stakeUsdScaled: rates.poolUsdScaled, poolUsdScaled: rates.poolUsdScaled }
      : rates
  const denomination: Denomination = {
    stakeAssetCode: asset.assetCode,
    stakeAmount,
    poolAmount,
    rates: effectiveRates,
  }
  return { asset, denomination, disclosure: disclosureFor(denomination, asset) }
}

/** What the stake screen serves. Both units, both rates, and the sentence. */
export function quoteView(quote: StakeQuote): Record<string, unknown> {
  return {
    stakeAsset: quote.asset.assetCode,
    stakeAssetName: quote.asset.displayName,
    stakeDecimals: quote.asset.decimals,
    stakeAmount: quote.denomination.stakeAmount.toString(),
    stakeAmountFormatted: formatUnits(quote.denomination.stakeAmount, quote.asset.decimals),
    poolAsset: POOL_ASSET,
    poolDecimals: POOL_DECIMALS,
    poolAmount: quote.denomination.poolAmount.toString(),
    poolAmountFormatted: formatUnits(quote.denomination.poolAmount, POOL_DECIMALS),
    // Both legs, always, because the cross rate is their quotient and an auditor needs to check
    // each one against pricing's published history rather than only the division.
    stakeRateUsdScaled: quote.denomination.rates.stakeUsdScaled.toString(),
    poolRateUsdScaled: quote.denomination.rates.poolUsdScaled.toString(),
    disclosure: quote.disclosure,
  }
}

/* ------------------------------------------------------------------ taking a stake */

export class CustodialStakeError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'CustodialStakeError'
    this.code = code
    this.status = status
  }
}

export interface AcceptInput {
  readonly marketId: string
  readonly subject: string
  readonly outcome: number
  readonly quote: StakeQuote
  /** Optional, and normally absent — see `CustodialStake.platformAddress`. */
  readonly platformAddress: string | null
  readonly idempotencyKey: string
}

/**
 * Record the stake.
 *
 * The row is written before any ledger entry is posted and before anything is broadcast, and the
 * order is not arbitrary: a crash between "the user's money moved" and "we wrote down why" is
 * unrecoverable, whereas a crash the other way leaves an `accepted` row with a null
 * `escrow_entry_id` — a state the reconciler can see and finish. `micro-mint`'s deploy path takes
 * the same order for the same reason.
 *
 * Every refusal that matters is the schema's rather than this function's: the market must be open
 * and before its close time, the asset must be enabled, the amounts and the rates must be
 * positive, and the key must be unused. See migration 9.
 */
export async function acceptStake(tx: Tx, input: AcceptInput): Promise<CustodialStake> {
  if (input.outcome !== 0 && input.outcome !== 1) {
    throw new CustodialStakeError('bad_outcome', 'outcome must be 0 (yes) or 1 (no)', 400)
  }
  const { denomination } = input.quote
  const rows = await tx<StakeRow[]>`
    insert into custodial_stakes (
      market_id, subject, outcome, stake_asset_code, stake_amount, pool_amount,
      stake_rate_usd_scaled, pool_rate_usd_scaled, platform_address, idempotency_key
    ) values (
      ${input.marketId}, ${input.subject}, ${input.outcome},
      ${denomination.stakeAssetCode}, ${denomination.stakeAmount.toString()},
      ${denomination.poolAmount.toString()},
      ${denomination.rates.stakeUsdScaled.toString()},
      ${denomination.rates.poolUsdScaled.toString()},
      ${input.platformAddress?.toLowerCase() ?? null}, ${input.idempotencyKey}
    )
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new CustodialStakeError('insert_failed', 'the stake was not recorded', 500)
  return toStake(row)
}

export async function findStakeByKey(
  sql: Db | Tx,
  idempotencyKey: string,
): Promise<CustodialStake | null> {
  const rows = await sql<StakeRow[]>`
    select ${sql.unsafe(COLUMNS)} from custodial_stakes where idempotency_key = ${idempotencyKey}
  `
  const row = rows[0]
  return row ? toStake(row) : null
}

export async function findStake(sql: Db | Tx, id: string): Promise<CustodialStake | null> {
  const rows = await sql<StakeRow[]>`
    select ${sql.unsafe(COLUMNS)} from custodial_stakes where id = ${id}
  `
  const row = rows[0]
  return row ? toStake(row) : null
}

/* ------------------------------------------------------------------ transitions */

/** The escrow entry posted. Recorded separately from the insert — see `acceptStake`'s ordering. */
export async function recordEscrowEntry(
  sql: Db | Tx,
  id: string,
  entryId: string,
): Promise<CustodialStake> {
  const rows = await sql<StakeRow[]>`
    update custodial_stakes set escrow_entry_id = ${entryId}, updated_at = now()
     where id = ${id} and state = 'accepted' and escrow_entry_id is null
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new CustodialStakeError('conflict', 'the stake moved while its entry was recorded')
  return toStake(row)
}

/**
 * The platform's on-chain stake landed and the mirror shows it.
 *
 * The transaction hash and the timestamp go on together, because `custodial_stakes_staked_has_
 * evidence` refuses `staked` without both — a state that claims the chain holds the money with no
 * transaction to point at is exactly the state a reconciler would believe.
 */
export async function markStaked(
  sql: Db | Tx,
  id: string,
  txHash: string,
  at: Date,
): Promise<CustodialStake> {
  const rows = await sql<StakeRow[]>`
    update custodial_stakes
       set state = 'staked', tx_hash = ${txHash}, staked_at = ${at}, updated_at = now()
     where id = ${id} and state = 'accepted'
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new CustodialStakeError('conflict', 'this stake is not accepted and pending')
  return toStake(row)
}

/**
 * The stake was never put on chain; the escrow goes back untouched.
 *
 * Only from `accepted`, and the schema says so twice — `custodial_stakes_refund_never_staked`
 * refuses a refunded row that carries a transaction hash. Once the EMBER is in the contract the
 * money is the contract's and the only way out of it is the contract's own void, which refunds the
 * whole pool and reaches this user through `markSettled` with the pool share as the payout.
 */
export async function markRefunded(
  sql: Db | Tx,
  id: string,
  entryId: string,
  at: Date,
): Promise<CustodialStake> {
  const rows = await sql<StakeRow[]>`
    update custodial_stakes
       set state = 'refunded', settle_entry_id = ${entryId}, resolved_at = ${at}, updated_at = now()
     where id = ${id} and state = 'accepted'
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new CustodialStakeError('conflict', 'only an accepted stake can be refunded')
  return toStake(row)
}

export async function markSettled(
  sql: Db | Tx,
  id: string,
  entryId: string,
  at: Date,
): Promise<CustodialStake> {
  const rows = await sql<StakeRow[]>`
    update custodial_stakes
       set state = 'settled', settle_entry_id = ${entryId}, resolved_at = ${at}, updated_at = now()
     where id = ${id} and state = 'staked'
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new CustodialStakeError('conflict', 'only a staked position can be settled')
  return toStake(row)
}

/**
 * The platform's own pool paid this position out. The chain was never involved.
 *
 * From `accepted` only, and it is the counterpart of `markRefunded` rather than of `markSettled`:
 * both leave `tx_hash` null for ever, and the schema enforces it
 * (`custodial_stakes_paid_never_staked`). The difference between them is what the market did — a
 * void gives back exactly what was taken, a resolution divides the losing side among the winning
 * one.
 */
export async function markPaid(
  sql: Db | Tx,
  id: string,
  entryId: string,
  at: Date,
): Promise<CustodialStake> {
  const rows = await sql<StakeRow[]>`
    update custodial_stakes
       set state = 'paid', settle_entry_id = ${entryId}, resolved_at = ${at}, updated_at = now()
     where id = ${id} and state = 'accepted'
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new CustodialStakeError('conflict', 'only an accepted stake can be paid from the platform pool')
  return toStake(row)
}

/* ------------------------------------------------------------------ the ledger side */

/**
 * The accounts this service names, matching `micro-wallet`'s exactly.
 *
 * `(subject, asset_code, purpose)` is the ledger's unique account key
 * (`ledger/src/migrations.ts`); `available` and `escrow` are two of the seven purposes its
 * CHECK admits, and `clearing` is `wallet/src/money.ts` verbatim — subject
 * `clearing`, purpose `available`, type `clearing`. Inventing a shape here would not create a
 * second account, it would fail the CHECK, which is the right way for this mistake to end.
 */
function userAccount(subject: string, assetCode: string, purpose: 'available' | 'escrow') {
  return { subject, assetCode, purpose, type: 'liability' }
}

/**
 * The pivot every cross-asset entry turns on.
 *
 * The two assets have no arithmetic relationship, so an entry moving one into the other cannot
 * balance as a single pair — the ledger's balancing trigger is **per `asset_code`**
 * (`ledger/src/migrations.ts`). Clearing is what makes two balanced pairs out of one
 * conversion, and its type is exempt from the overdraft trigger (`ledger/src/migrations.ts`)
 * precisely so it may sit either side of zero while a conversion is in flight.
 *
 * It is also where this design's honesty lives. Across one market, `clearing:EMBER` nets to
 * (everything staked − everything paid out), which is exactly the platform's result on its
 * aggregate on-chain position — a number that must equal what the contract actually did, and a
 * number a reconciler can therefore check.
 */
function clearing(assetCode: string) {
  return { subject: 'clearing', assetCode, purpose: 'available', type: 'clearing' }
}

/**
 * Take the stake: the user's asset leaves, and an EMBER-denominated position arrives in escrow.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * FOUR POSTINGS, TWO BALANCED PAIRS, ONE ENTRY — `wallet/src/money.ts`'s conversion shape, which
 * is the solved version of this exact problem. The input asset goes out of the user and into
 * clearing; the pool asset comes out of clearing and into the user's ESCROW rather than their
 * available balance, because it is committed to a market from the instant it exists.
 *
 * **This is the moment the user's FX exposure ends**, and it is why the disclosure says so. After
 * this entry the user holds an EMBER position; the platform holds their BTC and carries the rate
 * it struck. Nothing later in the market's life re-opens that.
 *
 * **Kind `market_escrow`.** In the ledger's closed vocabulary
 * (`ledger/src/migrations.ts`), and NOT one of the three acquisition kinds migration 13's
 * trigger refuses for a retired asset — those are `purchase`, `subscription_charge` and
 * `deposit_credited` (`ledger/src/migrations.ts`). So a stake does not trip that guard. It
 * could not carry a retired asset anyway: `IssuableAssetCode` refuses `SHARD` at compile time and
 * `stake_assets_not_retired` refuses the registry row.
 *
 * A stake in the pool asset itself is ONE balanced pair, not two: `available → escrow` in EMBER,
 * with no clearing leg at all, because there is no conversion to pivot.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function escrowPostings(stake: CustodialStake): readonly Posting[] {
  if (stake.stakeAssetCode === POOL_ASSET) {
    return [
      {
        account: userAccount(stake.subject, POOL_ASSET, 'available'),
        direction: 'debit',
        amount: stake.poolAmount,
        assetCode: POOL_ASSET,
        sequence: 0,
      },
      {
        account: userAccount(stake.subject, POOL_ASSET, 'escrow'),
        direction: 'credit',
        amount: stake.poolAmount,
        assetCode: POOL_ASSET,
        sequence: 1,
      },
    ]
  }
  return [
    {
      account: userAccount(stake.subject, stake.stakeAssetCode, 'available'),
      direction: 'debit',
      amount: stake.stakeAmount,
      assetCode: stake.stakeAssetCode,
      sequence: 0,
    },
    {
      account: clearing(stake.stakeAssetCode),
      direction: 'credit',
      amount: stake.stakeAmount,
      assetCode: stake.stakeAssetCode,
      sequence: 1,
    },
    {
      account: clearing(POOL_ASSET),
      direction: 'debit',
      amount: stake.poolAmount,
      assetCode: POOL_ASSET,
      sequence: 2,
    },
    {
      account: userAccount(stake.subject, POOL_ASSET, 'escrow'),
      direction: 'credit',
      amount: stake.poolAmount,
      assetCode: POOL_ASSET,
      sequence: 3,
    },
  ]
}

/**
 * Give it back, whole, in the asset it arrived in — the exact reversal of `escrowPostings`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **BOTH AMOUNTS ARE READ FROM THE ROW. NEITHER IS RE-DERIVED FROM A RATE.**
 *
 * Not today's rate, which would make a refund a bet on the interval — the platform would eat the
 * difference on every void at once, in the same direction. Not the recorded rate either: the
 * forward conversion floors, so inverting it floors a second time and returns strictly less than
 * was taken, by up to one smallest unit, silently, in the platform's favour. Both are wrong and
 * the second is worse because it looks principled. `stake_amount` is a stored column for this one
 * reason, and `custodial_stakes_money_is_immutable` is what keeps it worth reading.
 *
 * Because the reversal is exact on both legs, a void leaves clearing at zero and the platform
 * exactly flat — which is the property that makes "refunds are whole" (19 §2.5) true in an asset
 * the contract has never heard of.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function refundPostings(stake: CustodialStake): readonly Posting[] {
  return escrowPostings(stake).map((posting, index, all) => ({
    ...posting,
    // The same accounts and the same amounts, every direction flipped. Written as a transform of
    // the forward postings rather than as a second hand-built list, so the two cannot drift: a
    // refund that reversed a different set of accounts from the one that took the money is the
    // defect this shape makes unrepresentable.
    direction: posting.direction === 'debit' ? ('credit' as const) : ('debit' as const),
    sequence: all.length - 1 - index,
  }))
}

/**
 * The market resolved: the escrowed position is spent, and a winner is credited what the contract
 * paid.
 *
 * The escrowed EMBER leaves the user and goes to clearing — it went into the pool and the pool
 * decided what became of it. The payout, if there is one, comes back out of clearing to the user's
 * available balance. Both legs are EMBER, so this is one asset and one balanced set; there is no
 * BTC leg here at all, because the BTC stopped being the user's at `escrowPostings`.
 *
 * **`payoutWei` is what the CONTRACT paid**, read from the chain, never computed here. The pool is
 * the contract's storage and `payoutOf` is its arithmetic (`ForesightMarket.sol`); a
 * number this service worked out for itself would be a second opinion about somebody else's money,
 * and 19 §2.3.1 is explicit that bookkeeping mirrors the chain and never the reverse.
 *
 * **A winner is paid in EMBER and sees EMBER.** Converting back to the asset they arrived with is
 * a separate action they take, separately quoted, at the conversion spread that already exists as
 * R7 — not something this entry does on their behalf.
 */
export function settlementPostings(stake: CustodialStake, payoutWei: bigint): readonly Posting[] {
  if (payoutWei < 0n) throw new CustodialStakeError('bad_payout', 'a payout cannot be negative', 500)
  const postings: Posting[] = [
    {
      account: userAccount(stake.subject, POOL_ASSET, 'escrow'),
      direction: 'debit',
      amount: stake.poolAmount,
      assetCode: POOL_ASSET,
      sequence: 0,
    },
    {
      account: clearing(POOL_ASSET),
      direction: 'credit',
      amount: stake.poolAmount,
      assetCode: POOL_ASSET,
      sequence: 1,
    },
  ]
  if (payoutWei > 0n) {
    postings.push(
      {
        account: clearing(POOL_ASSET),
        direction: 'debit',
        amount: payoutWei,
        assetCode: POOL_ASSET,
        sequence: 2,
      },
      {
        account: userAccount(stake.subject, POOL_ASSET, 'available'),
        direction: 'credit',
        amount: payoutWei,
        assetCode: POOL_ASSET,
        sequence: 3,
      },
    )
  }
  return postings
}

/**
 * The platform's pool paid this position out. **Same postings as a chain settlement, different
 * authority for the number**, and the distinction is the whole reason this wrapper exists rather
 * than a second call to `settlementPostings` at the call site.
 *
 * `settlementPostings` is documented as mirroring what the CONTRACT paid — read from the chain,
 * never computed here, because 19 §2.3.1 forbids this service having an opinion about money the
 * contract holds. That rule is intact. This payout is a different number about different money:
 * the platform's own escrow, divided by `splitPayouts` among people whose stake never reached the
 * chain and never could. There is no contract to mirror, so the arithmetic has to live here — and
 * naming it separately is what keeps somebody from later "simplifying" the two into one path and
 * quietly making this service the authority on the contract's pool.
 */
export function poolPayoutPostings(stake: CustodialStake, payoutWei: bigint): readonly Posting[] {
  return settlementPostings(stake, payoutWei)
}

/**
 * One key per stake per phase, for ever.
 *
 * Derived from the stake's own id rather than from a timestamp or a counter: the whole value of an
 * idempotency key is that a retry after a lost response replays instead of posting a second entry,
 * and a key that changes between attempts provides none of it. `ledgerclient.ts` makes the same
 * argument for the fee report.
 */
export function stakeIdempotencyKey(stakeId: string, phase: 'escrow' | 'refund' | 'settle' | 'payout'): string {
  return `foresight:stake:${phase}:${stakeId}`
}

/* ------------------------------------------------------------------ reconciliation */

export interface AggregateShare {
  readonly outcome: number
  readonly poolAmount: bigint
  readonly stakeCount: number
}

/**
 * What the ledger says the platform's aggregate on-chain position ought to be, per outcome.
 *
 * Summed in the database in exact integer arithmetic over `numeric(78,0)` — never a JavaScript
 * reduce over floats — for the same reason `poolOf` is. Only `staked` and `settled` count:
 * `accepted` is money that has not reached the chain yet and `refunded` is money that never will,
 * and counting either would make the reconciliation disagree with the chain by design.
 *
 * The counterpart to compare it against is `housePositionOf(sql, marketId, platformAddress)`,
 * which reads the mirror. **The two must be equal.** A difference means either a broadcast the
 * ledger does not know about, or a stake the chain never received — and the second is a user whose
 * money is escrowed against a position that does not exist.
 */
export async function aggregateShares(
  sql: Db | Tx,
  marketId: string,
  platformAddress: string,
): Promise<readonly AggregateShare[]> {
  const rows = await sql<{ outcome: number; total: string; stakes: number }[]>`
    select outcome,
           coalesce(sum(pool_amount), 0)::text as total,
           count(*)::int as stakes
      from custodial_stakes
     where market_id = ${marketId}
       and platform_address = ${platformAddress.toLowerCase()}
       and state in ('staked','settled')
     group by outcome order by outcome
  `
  return rows.map((row) => ({
    outcome: row.outcome,
    poolAmount: BigInt(row.total),
    stakeCount: row.stakes,
  }))
}

/**
 * The platform's own pool on one market, per outcome — the figure a custodial staker's return
 * actually depends on.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS NOT THE CONTRACT'S POOL AND MUST NEVER BE ADDED TO IT.**
 *
 * `positions` mirrors what the contract holds, staked by people with keys. This sums what the
 * platform holds for people without one. They are two parimutuel pools on one question, and they
 * settle independently: a custodial staker divides the custodial losers' money, and nothing else.
 * Presenting a total of the two would quote somebody odds computed from money they cannot win.
 *
 * `accepted` and `paid` both count. `accepted` is money in the pool right now; `paid` is money
 * that was in it and has been paid out of it, which is what makes this readable after settlement
 * and lets the split be recomputed and checked. `refunded` never counts — it is money the
 * platform gave back rather than money that took a side.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function custodialPoolOf(
  sql: Db | Tx,
  marketId: string,
): Promise<{ yes: bigint; no: bigint; stakers: number }> {
  const rows = await sql<{ yes: string | null; no: string | null; stakers: number }[]>`
    select
      sum(pool_amount) filter (where outcome = 0)::text as yes,
      sum(pool_amount) filter (where outcome = 1)::text as no,
      count(distinct subject)::int as stakers
      from custodial_stakes
     where market_id = ${marketId} and state in ('accepted','paid')
  `
  const row = rows[0]
  return { yes: BigInt(row?.yes ?? '0'), no: BigInt(row?.no ?? '0'), stakers: row?.stakers ?? 0 }
}

/** The custodial book as the market page renders it. Pool units — EMBER — as decimal strings. */
export interface CustodialPoolView {
  readonly yes: string
  readonly no: string
  readonly total: string
  /** The split in basis points, in bigint. `null` when nothing has been staked this way. */
  readonly yesBps: number | null
  readonly noBps: number | null
  readonly stakerCount: number
  /** The unit every figure above is in, so no client has to assume it. */
  readonly asset: string
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE BOOK A CUSTODIAL STAKER IS IN HAD NO WAY OF REACHING THEM, AND THAT WAS THE WHOLE BUG.**
 *
 * `GET /markets/:id` carried `pool` — `positions`, the contract's — and nothing else. So somebody
 * who staked 10 EMBER through their CloudsForge balance watched the market page go on saying
 * `yes 0 / no 0 / 0 stakers` afterwards, because a custodial stake is a ledger entry and never
 * appears in `positions`. Their money was in escrow, their stake was in `custodial_stakes`, and
 * the only surface that could have told them so was reading the other pool. It was reported as
 * "I completed one deposit and the total stayed 0".
 *
 * So the custodial book goes on the wire — beside the contract's, never summed with it, for the
 * reason `custodialPoolOf` gives at length directly above.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function custodialPoolView(pool: {
  readonly yes: bigint
  readonly no: bigint
  readonly stakers: number
}): CustodialPoolView {
  const total = pool.yes + pool.no
  return {
    yes: pool.yes.toString(),
    no: pool.no.toString(),
    total: total.toString(),
    // The same expression as `poolOf` and as `ForesightMarket.sol`: the division happens in
    // bigint and the result is at most 10,000, so narrowing to a JS number cannot lose a digit.
    yesBps: total === 0n ? null : Number((pool.yes * 10_000n) / total),
    noBps: total === 0n ? null : Number((pool.no * 10_000n) / total),
    stakerCount: pool.stakers,
    asset: POOL_ASSET,
  }
}

/** Every stake still waiting for the market to be over. The settlement job's queue. */
export async function unresolvedStakes(
  sql: Db | Tx,
  marketId: string,
): Promise<readonly CustodialStake[]> {
  const rows = await sql<StakeRow[]>`
    select ${sql.unsafe(COLUMNS)} from custodial_stakes
     where market_id = ${marketId} and state = 'accepted'
     order by created_at, id
  `
  return rows.map(toStake)
}

/**
 * Markets that are over and still holding somebody's custodial money.
 *
 * The join is the point. A stake in `accepted` is money in escrow, and escrow is not a resting
 * place: it is a promise that something will decide what happens to it. Until this query existed
 * nothing ever asked the question, so the promise had no keeper — a market could resolve, settle,
 * be voided, and the escrow row would sit at `accepted` for ever with the user's balance short by
 * exactly the amount they staked.
 *
 * `resolved`, `settled` and `void` are all terminal enough to pay against. `settled` is included
 * deliberately: it means the CONTRACT's own settlement completed, which says nothing about the
 * platform's pool — the two settle independently and the on-chain one usually finishes first.
 */
export async function marketsAwaitingCustodialSettlement(
  sql: Db | Tx,
  limit: number,
): Promise<readonly { marketId: string; status: string; outcome: number | null }[]> {
  const rows = await sql<{ market_id: string; status: string; outcome: number | null }[]>`
    select distinct m.id as market_id, m.status, m.outcome
      from custodial_stakes s
      join markets m on m.id = s.market_id
     where s.state = 'accepted' and m.status in ('resolved','settled','void')
     order by m.id
     limit ${limit}
  `
  return rows.map((row) => ({ marketId: row.market_id, status: row.status, outcome: row.outcome }))
}

export interface Payout {
  readonly stakeId: string
  /** What this staker receives, in pool units. Their own stake back, plus their share of the losers'. */
  readonly payout: bigint
}

/**
 * Divide a resolved market's custodial pool.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * PARIMUTUEL, AND THEREFORE SELF-FUNDED: the only money paid out is money that was staked. The
 * platform is not the counterparty to any of it and cannot owe what it does not hold. Every
 * function of this shape has three edges, and getting any of them wrong is somebody's money:
 *
 *   1. **Nobody backed the winning outcome.** There is no division to make — one side is empty
 *      and the other cannot win against nothing. Every stake comes back whole, which the caller
 *      does as a refund in the ASSET IT ARRIVED IN, not as a pool-unit payout. So this returns an
 *      empty list and says so, rather than inventing a payout equal to the stake.
 *   2. **Nobody backed the losing outcome.** Everybody who staked was right, there is nothing to
 *      divide, and each winner takes back exactly what they put in.
 *   3. **The division does not come out whole.** `share = pool_i * losers / winners` floors, so
 *      the floors leave a remainder of up to (number of winners − 1) units. It is not the
 *      platform's, and it is not left in a clearing account to be found by an accountant in a
 *      year: it is handed out one unit at a time, largest stake first, ties broken by stake id.
 *      Deterministic, exhaustive, and the total paid equals the total staked to the unit.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function splitPayouts(
  stakes: readonly CustodialStake[],
  winningOutcome: number,
): readonly Payout[] {
  const winners = stakes.filter((stake) => stake.outcome === winningOutcome)
  const losers = stakes.filter((stake) => stake.outcome !== winningOutcome)
  if (winners.length === 0) return []

  const winningPool = winners.reduce((sum, stake) => sum + stake.poolAmount, 0n)
  const losingPool = losers.reduce((sum, stake) => sum + stake.poolAmount, 0n)
  if (winningPool <= 0n) return []

  const payouts = new Map<string, bigint>()
  let distributed = 0n
  for (const stake of winners) {
    const share = (stake.poolAmount * losingPool) / winningPool
    payouts.set(stake.id, stake.poolAmount + share)
    distributed += share
  }

  // The remainder, one unit at a time. Sorted here rather than relying on the caller's order: the
  // rule has to be a property of this function, or two callers reading the same rows in different
  // orders would pay different people.
  let remainder = losingPool - distributed
  const byClaim = [...winners].sort((a, b) =>
    a.poolAmount === b.poolAmount ? (a.id < b.id ? -1 : 1) : a.poolAmount > b.poolAmount ? -1 : 1,
  )
  let index = 0
  while (remainder > 0n && byClaim.length > 0) {
    const stake = byClaim[index % byClaim.length] as CustodialStake
    payouts.set(stake.id, (payouts.get(stake.id) ?? 0n) + 1n)
    remainder -= 1n
    index += 1
  }

  return stakes
    .filter((stake) => payouts.has(stake.id))
    .map((stake) => ({ stakeId: stake.id, payout: payouts.get(stake.id) as bigint }))
}

/** One user's custodial position in a market, in the pool's unit. The unit they will be paid in. */
export async function custodialPositionOf(
  sql: Db | Tx,
  marketId: string,
  subject: string,
): Promise<{ yes: bigint; no: bigint }> {
  const rows = await sql<{ yes: string | null; no: string | null }[]>`
    select
      sum(pool_amount) filter (where outcome = 0)::text as yes,
      sum(pool_amount) filter (where outcome = 1)::text as no
      from custodial_stakes
     where market_id = ${marketId} and subject = ${subject}
       and state in ('accepted','staked','settled','paid')
  `
  const row = rows[0]
  return { yes: BigInt(row?.yes ?? '0'), no: BigInt(row?.no ?? '0') }
}

/**
 * The sentence that must appear where a user chooses between the two ways of staking.
 *
 * 25-wallet-clients.md §1 argues that the most dangerous thing this estate can do is let a user
 * confuse the custodial wallet with the self-custody one, and two products that look identical and
 * have opposite failure modes is that problem in its purest form. So the difference is stated, in
 * the platform's own words, composed once — the house seed's disclosure is composed the same way
 * and for the same reason.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS SENTENCE ONCE SAID SOMETHING THE SERVICE CANNOT DO, AND IT SAID IT TO EVERY USER.**
 *
 * Until 2026-08-16 it read "the platform places the pool share on chain from its own published
 * address". It never did, and it never can: `markSettled` accepts only a stake in state `'staked'`,
 * `'staked'` requires a transaction hash, and the hash could only come from custody signing
 * `stake(uint8)` — which `SIGNABLE_PURPOSES` in custody refuses, because it is a value-bearing call
 * with calldata. See `custodialSettleHandler` in `jobs.ts` for the full argument. On mainnet the
 * market with 10 EMBER of custodial stake held a contract pool of exactly zero, on both outcomes,
 * with a zero contract balance — which is the designed behaviour, not a fault.
 *
 * So the disclosure now describes the design as built: the platform holds the money, the custodial
 * stakes form their own parimutuel pool, and that pool settles against the outcome the CHAIN
 * resolved. Anyone rewriting this must say where the money actually sits. A disclosure that
 * overstates the on-chain guarantee is worse than none, because it is the sentence a user reads
 * *instead of* asking.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function stakeDisclosure(): string {
  return (
    'A custodial stake is held by the platform: your EMBER moves to the platform and your side is ' +
    'recorded in the ledger. It does not go into the market contract. Custodial stakes settle ' +
    'among themselves, against the outcome the chain resolves, so your return comes from the ' +
    'custodial pool shown here and not from the contract pool. A wallet stake is yours in the ' +
    'contract — it can be claimed with a wallet and a block explorer even if this platform stops ' +
    'running. A custodial stake cannot.'
  )
}
