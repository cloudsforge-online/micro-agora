/**
 * The house seed — docs/ecosystem/21 §5, phase 1.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE HOUSE IS A BETTOR WITH A PUBLISHED ADDRESS. THIS SERVICE NEVER TOUCHES THE MONEY.**
 *
 * That is not a shortcut; it is the only design the estate admits, and it is the better one:
 *
 *   1. **Custody cannot sign a stake.** `stake(uint8)` is a value-bearing contract CALL, and
 *      custody's three EVM shapes are creation (value must be zero —
 *      `custody/src/signing.ts` `assertCreation`), plain value transfer (data must be
 *      empty — `assertTransfer`), and sweep. `foresight/src/custodyclient.ts`
 *      already records that no purpose's shape is "call a contract" — it is why the oracle acts
 *      through a constructor (`ForesightResolver`). A resolver-style seeder contract would make
 *      the CONTRACT the staker, and its winnings would strand at a keyless address. So the seed
 *      is staked by the platform's own wallet, from `FORESIGHT_HOUSE_ADDRESS` — a published,
 *      disclosed address, funded like the miners' coinbases are (21 §3) — through the very same
 *      `stake(uint8)` every bettor uses.
 *
 *   2. **Settlement composes because nothing forks.** The house address is an ordinary staker:
 *      its position is mirrored by `mirror.ts` like anyone's, the contract's `payoutOf` counts it
 *      like anyone's, and after resolution its winnings come back through `claim()`/`claimFor()`
 *      (`src/contracts/ForesightMarket.sol`) — `claimFor` exists precisely so a batching
 *      job can push a payout to a staker. From the house address the EMBER returns to the
 *      engagement account the way 21 §3 says everything does: through the front door — deposit,
 *      indexer confirmation, conversion — "like any bettor's", literally.
 *
 *   3. **What this table adds is the COMMITMENT.** The chain cannot say "this stake was the
 *      disclosed, opinion-free seed and not the platform trading". This table can, and its
 *      constraints make the claim checkable: symmetric by CHECK, plannable only before open,
 *      recorded staked only in the opening transaction with the market's exact open timestamp,
 *      immutable afterwards. Opening a seeded market is REFUSED until the mirror shows the exact
 *      symmetric position the plan promises — so 'open with a seed' means 'the house money is
 *      already in the pool', never 'we intend it to be'.
 *
 * **The caps** (21 §7.3) bind twice: the hard ceilings are CHECK/trigger facts in migration 8
 * (the same numbers admin-api CHECKs on the policy — `admin-api/src/migrations.ts` version 8),
 * and the operator-tunable caps below them bind at approval time against admin-api's live policy
 * (`src/adminapiclient.ts`), fail-closed. All seed numbers are PER OUTCOME SIDE; the symmetric
 * total is twice the number.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Db, Tx } from './outbox.ts'

/** Mirrors `house_seeds_within_market_ceiling` — 1,000 EMBER per outcome side per market. */
export const SEED_PER_MARKET_CEILING_WEI = 1_000_000_000_000_000_000_000n
/** Mirrors `house_seeds_daily_ceiling` — 10,000 EMBER per outcome side per UTC day. */
export const SEED_PER_DAY_CEILING_WEI = 10_000_000_000_000_000_000_000n

export class HouseSeedError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'HouseSeedError'
    this.code = code
    this.status = status
  }
}

export interface HouseSeed {
  readonly marketId: string
  readonly houseAddress: string
  readonly amountYesWei: bigint
  readonly amountNoWei: bigint
  readonly state: 'planned' | 'staked'
  readonly stakedAt: Date | null
  readonly txHashYes: string | null
  readonly txHashNo: string | null
  readonly createdAt: Date
}

interface SeedRow {
  readonly market_id: string
  readonly house_address: string
  readonly amount_yes_wei: string
  readonly amount_no_wei: string
  readonly state: 'planned' | 'staked'
  readonly staked_at: Date | null
  readonly tx_hash_yes: string | null
  readonly tx_hash_no: string | null
  readonly created_at: Date
}

const COLUMNS = `market_id, house_address, amount_yes_wei::text, amount_no_wei::text, state,
                 staked_at, tx_hash_yes, tx_hash_no, created_at`

function toSeed(row: SeedRow): HouseSeed {
  return {
    marketId: row.market_id,
    houseAddress: row.house_address,
    amountYesWei: BigInt(row.amount_yes_wei),
    amountNoWei: BigInt(row.amount_no_wei),
    state: row.state,
    stakedAt: row.staked_at,
    txHashYes: row.tx_hash_yes,
    txHashNo: row.tx_hash_no,
    createdAt: row.created_at,
  }
}

export async function findHouseSeed(sql: Db | Tx, marketId: string): Promise<HouseSeed | null> {
  const rows = await sql<SeedRow[]>`
    select ${sql.unsafe(COLUMNS)} from house_seeds where market_id = ${marketId}
  `
  const row = rows[0]
  return row ? toSeed(row) : null
}

/**
 * Plan a seed, in the transaction that approves the market — the trigger insists on 'approved',
 * so calling this anywhere else raises. One amount drives both sides: symmetry is not this
 * function's care, it is the schema's.
 */
export async function planHouseSeed(
  tx: Tx,
  input: { readonly marketId: string; readonly houseAddress: string; readonly perOutcomeWei: bigint },
): Promise<HouseSeed> {
  const rows = await tx<SeedRow[]>`
    insert into house_seeds (market_id, house_address, amount_yes_wei, amount_no_wei)
    values (
      ${input.marketId}, ${input.houseAddress.toLowerCase()},
      ${input.perOutcomeWei.toString()}, ${input.perOutcomeWei.toString()}
    )
    returning ${tx.unsafe(COLUMNS)}
  `
  return toSeed(rows[0]!)
}

/** The per-side wei already planned today (UTC) — what the operator per-day cap compares against. */
export async function seedsPlannedTodayWei(sql: Db | Tx): Promise<bigint> {
  const rows = await sql<{ total: string }[]>`
    select coalesce(sum(amount_yes_wei), 0)::text as total
      from house_seeds
     where date_trunc('day', created_at at time zone 'utc')
         = date_trunc('day', now() at time zone 'utc')
  `
  return BigInt(rows[0]?.total ?? '0')
}

/**
 * What the mirror says the house holds in this market's pool, with the evidence hashes.
 *
 * Exact sums over non-orphaned positions, in the database, in integer arithmetic — the same
 * discipline as `poolOf`. The earliest transaction per outcome is the one recorded, because the
 * disclosure names the stake that opened the market, not any later noise.
 */
export async function housePositionOf(
  sql: Db | Tx,
  marketId: string,
  houseAddress: string,
): Promise<{ yesWei: bigint; noWei: bigint; txHashYes: string | null; txHashNo: string | null }> {
  const staker = houseAddress.toLowerCase()
  const sums = await sql<{ yes: string | null; no: string | null }[]>`
    select
      sum(amount) filter (where outcome = 0)::text as yes,
      sum(amount) filter (where outcome = 1)::text as no
      from positions
     where market_id = ${marketId} and staker = ${staker} and orphaned = false
  `
  const hashes = await sql<{ outcome: number; tx_hash: string }[]>`
    select distinct on (outcome) outcome, tx_hash
      from positions
     where market_id = ${marketId} and staker = ${staker} and orphaned = false
     order by outcome, block_height, log_index
  `
  const byOutcome = new Map(hashes.map((h) => [h.outcome, h.tx_hash]))
  return {
    yesWei: BigInt(sums[0]?.yes ?? '0'),
    noWei: BigInt(sums[0]?.no ?? '0'),
    txHashYes: byOutcome.get(0) ?? null,
    txHashNo: byOutcome.get(1) ?? null,
  }
}

/**
 * The gate `POST /markets/:id/open` runs for a seeded market, and the recording it performs.
 *
 * Refuses unless the mirror shows EXACTLY the planned symmetric position — not at-least: an
 * overshoot would make the disclosure understate the house, which is the direction dishonesty
 * lives in. On success the row transitions to 'staked' carrying the market's open timestamp;
 * the trigger checks both facts again against the market row itself.
 */
export async function recordHouseStake(
  tx: Tx,
  marketId: string,
  openedAt: Date,
): Promise<HouseSeed> {
  const seed = await findHouseSeed(tx, marketId)
  if (!seed) throw new HouseSeedError('no_seed', 'this market has no house seed to record', 500)
  const observed = await housePositionOf(tx, marketId, seed.houseAddress)
  if (observed.yesWei !== seed.amountYesWei || observed.noWei !== seed.amountNoWei) {
    throw new HouseSeedError(
      'house_seed_not_staked',
      `the mirror does not show the planned house seed: planned ${seed.amountYesWei}/${seed.amountNoWei} ` +
        `wei per side from ${seed.houseAddress}, observed ${observed.yesWei}/${observed.noWei} — ` +
        'the house money must be in the pool before a seeded market opens (21 §5)',
    )
  }
  const rows = await tx<SeedRow[]>`
    update house_seeds
       set state = 'staked', staked_at = ${openedAt},
           tx_hash_yes = ${observed.txHashYes}, tx_hash_no = ${observed.txHashNo},
           updated_at = now()
     where market_id = ${marketId} and state = 'planned'
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new HouseSeedError('conflict', 'the house seed moved while it was being recorded')
  return toSeed(row)
}

/** EMBER has 18 decimals; render whole units for the sentence a person reads. */
function formatEmber(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n
  const fraction = wei % 1_000_000_000_000_000_000n
  if (fraction === 0n) return whole.toString()
  return `${whole}.${fraction.toString().padStart(18, '0').replace(/0+$/, '')}`
}

/**
 * What the market page serves — 21 §7.6. The sentence is composed HERE, once, so `foresight-web`
 * renders a disclosure the platform wrote rather than one each client improvises. (21 §5 words
 * the sentence in Shards; the pool this seed sits in is EMBER wei on chain, and a conversion
 * through an administered price would make the disclosure a moving number. The honest unit is
 * the pool's own, so the sentence says EMBER — recorded as a deliberate divergence from the
 * doc's wording.)
 */
export function houseSeedView(seed: HouseSeed): Record<string, unknown> {
  const totalWei = seed.amountYesWei + seed.amountNoWei
  return {
    state: seed.state,
    houseAddress: seed.houseAddress,
    amountPerOutcomeWei: seed.amountYesWei.toString(),
    totalWei: totalWei.toString(),
    asset: 'EMBER',
    stakedAt: seed.stakedAt?.toISOString() ?? null,
    txHashYes: seed.txHashYes,
    txHashNo: seed.txHashNo,
    disclosure: `CloudsForge seeded this pool with ${formatEmber(totalWei)} EMBER so early odds exist.`,
  }
}
