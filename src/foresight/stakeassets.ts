/**
 * What a bettor may bring, and the arithmetic that turns it into a share of one pool.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE POOLING DECISION, AND THE ARGUMENT FOR IT. Read this before changing anything below.
 *
 * The owner's instruction was "if foresight is a problem because it works with ember make it work
 * with all others also". The honest options were a pool per asset, or one pool in a single unit
 * with conversion at stake time. **This service takes the second, and the contract does not change
 * at all.** Three reasons, in the order they actually decide it:
 *
 *   1. **For three of the four assets asked for, "a pool per asset" is not a pool.** The pool is
 *      the contract's own balance on Hearth — `uint256[2] public pool` at
 *      `src/contracts/ForesightMarket.sol`, fed by `msg.value`. Bitcoin and
 *      Litecoin have no contracts at all; USDT lives on Ethereum, where no `ForesightMarket` is
 *      deployed and to which no bridge exists or should. So a BTC pool could only ever be a number
 *      the PLATFORM holds and promises to divide — and that spends the single strongest property
 *      this product has: `claim()` reads nothing but the contract's own storage, so "if every
 *      server this platform owns is switched off, a winner with a wallet and a block explorer can
 *      still be paid" (`ForesightMarket.sol`). Liquidity fragmentation is the cheap
 *      objection to a pool per asset. **Losing the trustless payout is the expensive one**, and it
 *      is the one 29-native-assets.md §6.1 did not price when it listed the option.
 *
 *   2. **A mixed pool is not expressible, and would not be a parimutuel if it were.** One
 *      `uint256` of wei has nowhere to put an asset code. And pro-rata across assets whose
 *      relative prices moved between stake and settlement pays whoever staked the asset that
 *      appreciated out of whoever staked the one that did not, for reasons unrelated to the event.
 *
 *   3. **The contract therefore costs nothing to keep and something real to replace.** Every
 *      market is its own deployed contract (`markets_contract_uniq`, migration 5). A variant
 *      taking an asset code would be a second audited contract, and every already-deployed market
 *      would either run to term on the old one — two contracts to mirror, resolve and settle for
 *      as long as the longest close time — or be voided and refunded whole. Neither is free, and
 *      neither buys anything §1 does not already refuse.
 *
 * ── WHAT IS NEW IS THE DOOR, NOT THE POOL ─────────────────────────────────────────────────────
 *
 * Today a BTC holder cannot reach this product at all, for two independent and verified reasons:
 * the stake is `wallet → contract` and needs an EMBER-holding key the user controls
 * (`src/server.ts`, "not one wei passes through here"), and custody will not sign for a
 * user — `SIGNABLE_PURPOSES` is `{deployer, treasury, deposit}` at `custody/src/gates.ts` and
 * must stay that way. So a custodial stake is a LEDGER ENTRY, not a signing capability: the
 * platform stakes the converted EMBER on chain from its own published address, exactly as the
 * house seed already does (`src/houseseed.ts`), and the per-user share lives in
 * `custodial_stakes`. No new custody shape. No key the platform signs on a user's behalf.
 *
 * ── WHAT A WINNER IS PAID IN, STATED ONCE ─────────────────────────────────────────────────────
 *
 * **EMBER, and only EMBER, from the moment the stake is accepted.** The stake screen shows both
 * units and the rate and says so in words (`disclosureFor` below). Everything after it — the
 * position, the odds, the projected payout, the settled payout — is EMBER. Converting a payout
 * back to BTC is a second, separately quoted action the user takes if they want it. Showing a
 * BTC-denominated payout on an EMBER position would sell an FX guarantee the platform does not
 * hold, and it would sell it in the same direction to every winner at the same time.
 *
 * **And in the other direction: a refund returns the asset that was taken, in the amount that was
 * taken.** 0.01000000 BTC, not "0.01 BTC's worth at today's rate". `refundOf` in
 * `custodialstakes.ts` reads the recorded `stake_amount` and never re-derives it — see the note
 * on `stakeAmountForPool` below, which exists to be checked against, not to be paid from.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  CHAINS,
  RATE_SCALE,
  chainSpec,
  isRetiredAsset,
  type AssetCode,
  type IssuableAssetCode,
} from '@cloudsforge/contracts-chain'

/**
 * A ledger asset code a stake may be denominated in.
 *
 * `IssuableAssetCode` for the chain assets — `Exclude<AssetCode, 'SHARD'>`, so routing a stake
 * through a retired asset is a COMPILE error rather than a runtime one — and the `TOKEN:` urn
 * shape for tokens, which 29 §4 argues must never become an `AssetCode` because USDT has three
 * different decimals on three different chains. The urn names chain, network and contract, so two
 * deployments of one brand are two stake assets, permanently.
 */
export type TokenStakeAssetCode = `TOKEN:${string}`
export type StakeAssetCode = IssuableAssetCode | TokenStakeAssetCode

/** The unit the pool is denominated in, everywhere, for ever. Named once so it cannot drift. */
export const POOL_ASSET: IssuableAssetCode = 'EMBER'

export const POOL_DECIMALS: number = chainSpec(POOL_ASSET).decimals

export class StakeAssetError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'StakeAssetError'
    this.code = code
    this.status = status
  }
}

/**
 * One row of the registry, as the schema holds it and as the API serves it.
 *
 * `enabled` is an operator switch and it defaults to false for everything that is not proved. 29
 * §7 asks for exactly this and the reason is not caution for its own sake: an asset the platform
 * accepts is an asset the platform must be able to price, sweep, reconcile and pay back, and
 * three of those live in repositories this service does not own.
 */
export interface StakeAsset {
  readonly assetCode: StakeAssetCode
  /** Smallest-unit exponent. EMBER 18, BTC 8, ETH 18, LTC 8, USDT-on-Ethereum 6. */
  readonly decimals: number
  /** What a person sees. Never a code — 29 §4.2, "USDT is a display grouping, never a code". */
  readonly displayName: string
  readonly enabled: boolean
  /** Why it is off, when it is off. Served, so the answer is a sentence and not a silence. */
  readonly blockedReason: string | null
}

/* ------------------------------------------------- what can actually be staked, written down */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE REGISTRY AS THIS SERVICE SHIPS IT — the one place outside a running database where the
 * question "which assets can be staked?" has an answer.
 *
 * ── THE DEFECT THIS EXISTS FOR (micro-org#291) ────────────────────────────────────────────────
 *
 * micro-site's Foresight copy read "You can stake in any of the 8 chains the platform supports —
 * EMBER, Bitcoin, Ethereum, Ethereum Classic, Litecoin, Dogecoin, Solana, XRP Ledger". Both halves
 * were correctly DERIVED — from `contracts-chain`'s `ON_CHAIN_ASSETS`, which answers "which chains
 * does the estate model" and not "which assets will Foresight take". Those were nearly the same
 * set when the sentence was written. Measured 2026-08-09 against the live estate's own
 * `stake_assets` table, they are off by four:
 *
 *     enabled   EMBER, BTC, ETH, LTC
 *     disabled  TOKEN:eth:mainnet:0xdac1…  (Tether USD, with its reason)
 *     absent    ETC, DOGE, SOL, XRP
 *
 * ETC, DOGE, SOL and XRP are not disabled rows carrying a reason. They are not rows at all, so a
 * bettor who arrives with one is answered `404 unknown_asset` — "SOL is not a stake asset" — by a
 * page that had just invited them by name. Being NAMEABLE by the estate and being ACCEPTED at the
 * door are different facts, and only the second one belongs in a promise.
 *
 * The derivation is what makes it degrade: every chain `contracts` adds silently enlarges a promise
 * this service has not made, with a green test suite each time.
 *
 * ── WHY THIS IS A DECLARATION AND NOT A SECOND HAND-TYPED LIST ────────────────────────────────
 *
 * `stake_assets` is the source and stays the source: `GET /stake-assets` serves it, and everything
 * inside this service reads the table rather than this array. But a table lives in a database, and
 * nothing outside this estate's network can read one — a bundle's build, a sibling repository's
 * claims check, a person opening this repository. So the answer had to exist as a FILE as well, and
 * a file that merely restates a table is the rot this issue is about.
 *
 * So it is checked, exhaustively and in both directions, against the table the real migrations
 * produce on an empty database (`migrations.test.ts`, "the declared registry IS the seeded one").
 * Add a row to a migration and not to this array, or the reverse, and that test goes red naming the
 * asset. `stakeassets.test.ts` checks the shape a second way, against the two constraints migration
 * 9 puts on the table, so this file cannot state something the schema would refuse.
 *
 * **WHAT IT DOES NOT CLAIM.** `enabled` is an operator switch — migration 9 says so in as many
 * words: "turning either on is an UPDATE to this row once its blocker is gone, not a code change",
 * and migration 10 is exactly that UPDATE for Litecoin. An operator may therefore flip a row in a
 * live database without touching this repository, and no test here would know. So this declares
 * what this service SHIPS as stakeable, which is the strongest statement a file in a repository can
 * make and is the statement a reader outside the estate actually needs. A consumer that must know
 * what one deployment is doing right now reads `GET /stake-assets` from that deployment.
 *
 * ── DECIMALS ARE NOT TYPED HERE ───────────────────────────────────────────────────────────────
 *
 * For a chain asset they come from the pinned package, the same way `CHAIN_DECIMALS` above takes
 * them, because a registry that disagrees with `contracts-chain` sizes every stake in that asset
 * wrongly by a power of ten — which is what `assertRegistryDecimals` refuses at runtime. Only the
 * `TOKEN:` urn carries a number, because for a token there IS no authority in this estate: 29 §4.4
 * asks for an operator to verify it against the contract, and USDT-on-Ethereum is 6.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface StakeAssetDeclaration {
  readonly assetCode: StakeAssetCode
  readonly decimals: number
  readonly displayName: string
  readonly enabled: boolean
  readonly blockedReason: string | null
}

/** An enabled chain asset. Decimals from the package; a reason is forbidden on an enabled row. */
function stakeable(assetCode: IssuableAssetCode, displayName: string): StakeAssetDeclaration {
  return Object.freeze({
    assetCode,
    decimals: chainSpec(assetCode).decimals,
    displayName,
    enabled: true,
    blockedReason: null,
  })
}

/**
 * Everything the platform can name at the stake door, enabled or not, in the seed's own order.
 *
 * The display names and the refusal are the migrations' own words, because they are what is SERVED
 * to a user and they were written by the people who knew what was missing. Litecoin's seeded reason
 * is deliberately not reproduced: migration 10 removed it when the blocker went, and the constraint
 * forced it to NULL in the same statement.
 */
export const STAKE_ASSET_REGISTRY: readonly StakeAssetDeclaration[] = Object.freeze([
  stakeable('EMBER', 'EMBER'),
  stakeable('BTC', 'Bitcoin'),
  stakeable('ETH', 'Ethereum'),
  stakeable('LTC', 'Litecoin'),
  Object.freeze({
    assetCode: 'TOKEN:eth:mainnet:0xdac17f958d2ee523a2206206994597c13d831ec7' as TokenStakeAssetCode,
    decimals: 6,
    displayName: 'Tether USD (Ethereum)',
    enabled: false,
    // Byte-for-byte what migration 9 seeds, and `migrations.test.ts` compares it to the row rather
    // than to a regexp: this string is SERVED to a user, and a reason that has drifted from the one
    // the platform actually gives is a second answer to "why not?" with nobody's name on it.
    blockedReason:
      "micro-pricing quotes AssetCodes only and has no route for a TOKEN: urn. The peg is not " +
      "assumed to be one dollar — an assumed peg is an administered rate with nobody's name " +
      "on it.",
  }),
])

/**
 * The subset a stake will actually be taken in — what a sentence promising "you can stake in…" is
 * allowed to count and to name.
 */
export const STAKEABLE_ASSETS: readonly StakeAssetDeclaration[] = Object.freeze(
  STAKE_ASSET_REGISTRY.filter((asset) => asset.enabled),
)

/**
 * The stakeable assets as a person reads them, in registry order.
 *
 * Display names and not codes: 29 §4.2's rule, and the reason a sentence wants them. Deliberately
 * NOT joined into prose — whether a name takes an article ("the XRP Ledger") is an English fact
 * that is not in the data, so the caller sets the list off rather than this guessing.
 */
export function stakeableAssetNames(): readonly string[] {
  return STAKEABLE_ASSETS.map((asset) => asset.displayName)
}

/** Does this service ship prepared to take a stake in `code`? Nameable is not the same question. */
export function isDeclaredStakeable(code: string): boolean {
  return STAKEABLE_ASSETS.some((asset) => asset.assetCode === code)
}

/**
 * Is this asset a chain asset rather than a token? Tokens have no `ChainSpec` and therefore no
 * decimals of their own — `assetDecimals` in contracts-money refuses to guess and so does this.
 */
export function isTokenStakeAsset(code: string): code is TokenStakeAssetCode {
  return code.startsWith('TOKEN:')
}

/**
 * Narrow an arbitrary string to a stake asset code, or throw.
 *
 * Deliberately refuses `SHARD` by name as well as by type. The type stops a caller in THIS
 * repository; the check stops a string that arrived over HTTP, and `ledger`'s migration 13 trigger
 * stops it a third time at the only place it would do damage.
 */
export function parseStakeAssetCode(value: unknown): StakeAssetCode {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StakeAssetError('bad_asset', 'asset must be a non-empty string')
  }
  if (isTokenStakeAsset(value)) {
    // `TOKEN:` and nothing after it names no token. Two segments minimum, because the urn's whole
    // job is to distinguish one deployment from another.
    if (!/^TOKEN:[a-z0-9]+:[a-z0-9]+:0x[0-9a-f]{40}$/.test(value)) {
      throw new StakeAssetError(
        'bad_asset',
        'a token stake asset is TOKEN:<chain>:<network>:<lowercase contract address> — ' +
          'two deployments of one brand are two assets, permanently (29 §4.1)',
      )
    }
    return value as TokenStakeAssetCode
  }
  const upper = value.toUpperCase()
  if (!Object.hasOwn(CHAIN_DECIMALS, upper)) {
    throw new StakeAssetError('bad_asset', `${value} is not an asset this platform can name`)
  }
  if (isRetiredAsset(upper as AssetCode)) {
    throw new StakeAssetError(
      'retired_asset',
      `${upper} is retired and may not denominate a new stake`,
    )
  }
  return upper as IssuableAssetCode
}

/**
 * Decimals per chain asset, read from the pinned package rather than restated.
 *
 * Built as a record so `parseStakeAssetCode` can answer "is this an asset the estate can name"
 * without a second list. `Object.hasOwn` on it is the membership test; the values are what stop
 * an 8-decimal amount being treated as an 18-decimal one, which is a factor of 10¹⁰.
 *
 * ── THE KEYS ARE DERIVED TOO, AND THEY DID NOT USED TO BE ─────────────────────────────────────
 *
 * This was `['EMBER', 'BTC', 'ETH', 'SOL', 'XRP', 'LTC', 'SHARD']` — the `AssetCode` union typed
 * out by hand, with only the VALUES read from the package. That half-derivation looks safe and is
 * not: a seventh asset added upstream would be absent here, `Object.hasOwn` would say no, and
 * `parseStakeAssetCode` would refuse it as "not an asset this platform can name" — a stake refused
 * for a reason that is not true, which is the exact defect migration 10 exists to repair one
 * table over. Nothing would go red, because a list can only be checked against another list and
 * there was no other list.
 *
 * `CHAINS` is `Readonly<Record<AssetCode, ChainSpec>>`, so its keys ARE the union. Widening it
 * upstream now widens this, and a member removed upstream stops compiling here rather than
 * lingering as a key nothing answers for. Retirement is still a separate question and is still
 * asked separately, by `isRetiredAsset` in `parseStakeAssetCode`: SHARD is nameable and
 * un-stakeable, and collapsing those two into one list is what put a retired asset in a decimals
 * table in the first place.
 */
const CHAIN_DECIMALS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(CHAINS) as AssetCode[]).map((asset) => [asset, chainSpec(asset).decimals]),
  ),
)

/** Decimals for any stake asset. A token must be told; guessing 18 is a factor of 10¹² on USDT. */
export function stakeAssetDecimals(code: StakeAssetCode, tokenDecimals?: number): number {
  if (isTokenStakeAsset(code)) {
    if (tokenDecimals === undefined) {
      throw new StakeAssetError('unknown_decimals', `decimals must be supplied for ${code}`)
    }
    if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
      throw new StakeAssetError('unknown_decimals', `implausible token decimals: ${tokenDecimals}`)
    }
    return tokenDecimals
  }
  const decimals = CHAIN_DECIMALS[code]
  if (decimals === undefined) throw new StakeAssetError('bad_asset', `unknown asset ${code}`)
  return decimals
}

/* ------------------------------------------------------------------ the arithmetic */

/**
 * The two rates one stake is priced by, and the amounts they produced.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **TWO RATES, NOT ONE, AND THAT IS A DELIBERATE IMPROVEMENT ON THE PRECEDENT.**
 *
 * `micro-billing` records one `rate_usd_scaled` beside its two amounts
 * (`billing/src/migrations.ts`) and that is right for billing, whose pair is (US cents,
 * EMBER) with USD as the numeraire — one rate closes the arithmetic.
 *
 * Here the pair is (BTC, EMBER) and `micro-pricing` publishes no BTC/EMBER rate: it publishes USD
 * per whole coin, per asset (`pricing/src/server.ts`). The cross rate is therefore a QUOTIENT
 * of two published numbers, and storing only the quotient would lose which leg moved — an auditor
 * could confirm the division and could not confirm either input against pricing's own history.
 * So both legs are stored, and `poolAmountFor` is a pure function of exactly what is on the row.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface StakeRates {
  /** Mid-market USD per one whole unit of the staked asset, at `RATE_SCALE`. */
  readonly stakeUsdScaled: bigint
  /** Mid-market USD per one whole EMBER, at `RATE_SCALE`. Administered — `pricing/src/rates.ts`. */
  readonly poolUsdScaled: bigint
}

export interface Denomination {
  readonly stakeAssetCode: StakeAssetCode
  readonly stakeAmount: bigint
  readonly poolAmount: bigint
  readonly rates: StakeRates
}

/**
 * Smallest units of the staked asset → wei of pool.
 *
 *     pool = stake × 10^poolDecimals × stakeUsd
 *            ────────────────────────────────────
 *            10^stakeDecimals × poolUsd
 *
 * `RATE_SCALE` appears on both sides of the quotient and cancels, so it is not written — but it is
 * asserted below, because a caller that passed an unscaled rate would land here with a number a
 * million times too small and the arithmetic would happily produce an answer.
 *
 * **Rounds down, always**, matching `coinAmountForUsdCents` and `wallet/src/money.ts`: dust falls
 * where reconciliation can see it. **Refuses to round to zero** — taking a positive stake and
 * crediting no pool share is not a rounding error, it is a confiscation, and `BigInt('') === 0n`
 * means zero arrives here more easily than anyone expects.
 *
 * All bigint. There is no float on this path: one EMBER is 1e18 wei, one satoshi is 1e-8 BTC, and
 * a double carries neither end of that range.
 */
export function poolAmountFor(input: {
  readonly stakeAmount: bigint
  readonly stakeDecimals: number
  readonly rates: StakeRates
}): bigint {
  const { stakeAmount, stakeDecimals, rates } = input
  if (stakeAmount <= 0n) {
    throw new StakeAssetError('bad_amount', 'a stake amount must be positive')
  }
  if (!Number.isInteger(stakeDecimals) || stakeDecimals < 0 || stakeDecimals > 36) {
    throw new StakeAssetError('unknown_decimals', `implausible decimals: ${stakeDecimals}`)
  }
  assertRate(rates.stakeUsdScaled, 'the staked asset')
  assertRate(rates.poolUsdScaled, POOL_ASSET)

  const numerator = stakeAmount * 10n ** BigInt(POOL_DECIMALS) * rates.stakeUsdScaled
  const denominator = 10n ** BigInt(stakeDecimals) * rates.poolUsdScaled
  const pool = numerator / denominator
  if (pool === 0n) {
    throw new StakeAssetError(
      'amount_too_small',
      `that amount converts to less than one wei of ${POOL_ASSET} — refusing to take a stake and ` +
        'credit nothing',
      422,
    )
  }
  return pool
}

/**
 * The inverse, for CHECKING ONLY. **Never pay a refund from this.**
 *
 * `poolAmountFor` floors, so composing the two is not the identity: re-deriving a refund would
 * floor a second time and return the user strictly less than they staked, up to one smallest unit
 * per refund, silently, in the platform's favour. That is exactly the leak the estate's rounding
 * rule exists to prevent, and it is why `custodial_stakes.stake_amount` is a stored column rather
 * than a derived one. A refund reads the row.
 *
 * What this IS for: an operator or a test asking "is the recorded pool share consistent with the
 * recorded stake and the recorded rates", where the expected answer is "within one smallest unit".
 */
export function stakeAmountForPool(input: {
  readonly poolAmount: bigint
  readonly stakeDecimals: number
  readonly rates: StakeRates
}): bigint {
  const { poolAmount, stakeDecimals, rates } = input
  if (poolAmount <= 0n) throw new StakeAssetError('bad_amount', 'a pool amount must be positive')
  assertRate(rates.stakeUsdScaled, 'the staked asset')
  assertRate(rates.poolUsdScaled, POOL_ASSET)
  const numerator = poolAmount * 10n ** BigInt(stakeDecimals) * rates.poolUsdScaled
  const denominator = 10n ** BigInt(POOL_DECIMALS) * rates.stakeUsdScaled
  return numerator / denominator
}

/**
 * A rate must be a positive integer at `RATE_SCALE`, and below a billion dollars a unit.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE UPPER BOUND IS NOT DECORATION, AND IT IS HONEST ABOUT WHAT IT CATCHES.
 *
 * The failure it exists for is a rate that has been through `RATE_SCALE` twice — a caller
 * multiplying by the scale on a number pricing had already scaled. That inflates the rate by 10⁶,
 * and applied to the staked leg it sizes a position a million times too large.
 *
 * A ceiling of $1e9 per whole unit catches that for any asset priced above about $1,000, which is
 * BTC and ETH. **It does NOT catch it for a dollar stablecoin**, where double scaling lands at
 * $1e6 — inside the bound. That is a real limit rather than one to paper over: the defence for a
 * stablecoin is the `rateScale` check in `pricingclient.ts`, which compares what pricing says it
 * published against what this service computes at, and that one does not depend on the magnitude.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const MAX_PLAUSIBLE_RATE = RATE_SCALE * 1_000_000_000n

function assertRate(value: bigint, what: string): void {
  if (value <= 0n) {
    throw new StakeAssetError('bad_rate', `the ${what} rate is ${value}, which cannot price anything`)
  }
  if (value > MAX_PLAUSIBLE_RATE) {
    throw new StakeAssetError(
      'bad_rate',
      `the ${what} rate is ${value}, which is not a price at a scale of ${RATE_SCALE} — ` +
        'a rate passed unscaled, or scaled twice, lands here',
    )
  }
}

/* ------------------------------------------------------------------ what the user is told */

/** Render smallest units as a decimal string. Exact; no float, no rounding, no exponent. */
export function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n
  const absolute = negative ? -amount : amount
  const divisor = 10n ** BigInt(decimals)
  const whole = absolute / divisor
  const fraction = absolute % divisor
  const sign = negative ? '-' : ''
  if (decimals === 0 || fraction === 0n) return `${sign}${whole}`
  const trimmed = fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${sign}${whole}.${trimmed}`
}

/**
 * The sentence a bettor reads before they stake, composed HERE so every client shows the same one.
 *
 * The house seed's disclosure is composed the same way and for the same reason
 * (`houseseed.ts`): a disclosure each client improvises is a disclosure that differs between
 * clients. 29 §6.3 asks for these words specifically, and they are the words rather than a
 * footnote because the thing being disclosed is that the user's FX exposure ENDS here.
 */
export function disclosureFor(denomination: Denomination, asset: StakeAsset): string {
  if (denomination.stakeAssetCode === POOL_ASSET) {
    return `Your stake and your winnings are both in ${POOL_ASSET}.`
  }
  const stake = formatUnits(denomination.stakeAmount, asset.decimals)
  const pool = formatUnits(denomination.poolAmount, POOL_DECIMALS)
  return (
    `Staking converts ${stake} ${asset.displayName} to ${pool} ${POOL_ASSET} at the rate shown, ` +
    `which is recorded against this stake. Your position, the odds and your winnings are all in ` +
    `${POOL_ASSET}; you are no longer exposed to ${asset.displayName} on this stake. ` +
    `If the market is voided you get your ${stake} ${asset.displayName} back, not its value today.`
  )
}
