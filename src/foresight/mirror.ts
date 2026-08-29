/**
 * The position mirror.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY ROW THIS FILE WRITES IS A COPY. NOTHING HERE IS AUTHORITATIVE.**
 *
 * The pool is what the contract's storage says it is. `positions` exists so a public page can show
 * a market without every visitor making an RPC call, and so a notification can be sent to the
 * people in a market that resolves. Delete the whole table and: every stake is still in the
 * contract, every winner can still call `claim()`, and every payout is unchanged. That is the
 * property 19-new-products.md §2.3.1 asks for, and it is worth restating because it is the thing a
 * future feature will be tempted to spend — the moment anything downstream *decides* from this
 * table rather than *displays* from it, the mirror has become a second ledger.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Reorg safety, and where it actually comes from
 *
 * Not from this file being clever. It comes from two places, in order:
 *
 *   1. `micro-indexer` already decides what is canonical. It has the checkpoint, the block-atomic
 *      write and the `included`/`orphaned` distinction, and this file carries that verdict forward
 *      rather than forming its own.
 *   2. `positions_source_uniq` on `(market_id, tx_hash, log_index)` means a replayed log is an
 *      `ON CONFLICT` and not a second row. **This is what makes "the mirror replays a reorg without
 *      double-counting a stake" true even if the sync logic below is wrong**, which is the whole
 *      argument for putting it in the schema.
 *
 * An orphaned row is MARKED, never deleted. The row is the only evidence that this service once
 * believed a stake existed, and an operator looking at a disputed pool needs to see it.
 *
 * ## `asOf` is part of the answer
 *
 * `mirror_cursors.synced_at` and `tip_block` are written on every pass and read by the API, so a
 * stale mirror presents as "as of 14 minutes ago" rather than as a smaller pool. `micro-wallet`'s
 * discipline; the failure it prevents is a bettor reading a pool ratio that has moved and staking
 * against odds that no longer exist.
 */

import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { decodeAbi, topic0 } from './evm.ts'
import { requiredConfirmations, type ChainId } from './chains.ts'
import { indexerChainOf } from './chains.ts'
import type { IndexerClient } from './indexerclient.ts'
import { findMarket } from './markets.ts'
import type { Db } from './outbox.ts'

/** The market contract's events, by their canonical signatures. See `ForesightMarket.sol`. */
export const STAKED_TOPIC = topic0('Staked(address,uint8,uint256,uint256,uint256)')
export const FEE_PAID_TOPIC = topic0('FeePaid(address,uint256)')
export const RESOLVED_TOPIC = topic0('Resolved(uint8,uint64)')
export const VOIDED_TOPIC = topic0('Voided(uint64)')

export interface MirrorDeps {
  readonly sql: Db
  readonly indexer: IndexerClient
  readonly pageSize: number
  readonly logger: Logger
  readonly metrics: Metrics
}

export interface SyncResult {
  readonly scanned: number
  readonly recorded: number
  readonly orphaned: number
  readonly tipHeight: number | null
}

/**
 * One decoded stake, as the mirror stores it.
 *
 * `amount` is a bigint and stays one all the way to the `numeric(78,0)` column. There is no float
 * on this path, deliberately: one EMBER is 1e18 wei and a double loses the bottom of that, which is
 * exactly where a pool that does not add up shows itself.
 */
export interface DecodedStake {
  readonly staker: string
  readonly outcome: number
  readonly amount: bigint
  readonly txHash: string
  readonly logIndex: number
  readonly blockHeight: number
  readonly blockHash: string
  readonly orphaned: boolean
}

/**
 * Decode a `Staked` log, or null if it is not one.
 *
 * The address filter is not a nicety. A market contract's address is watched, but a transaction
 * that touched it may carry logs from other contracts, and a `Staked`-shaped event from somewhere
 * else would otherwise be credited to this market's pool.
 */
export function decodeStaked(
  log: { readonly logIndex: number; readonly address: string; readonly topics: readonly string[]; readonly data: string },
  contractAddress: string,
): { staker: string; outcome: number; amount: bigint } | null {
  if (log.address.toLowerCase() !== contractAddress.toLowerCase()) return null
  if ((log.topics[0] ?? '').toLowerCase() !== STAKED_TOPIC.toLowerCase()) return null
  const stakerTopic = log.topics[1]
  const outcomeTopic = log.topics[2]
  if (!stakerTopic || !outcomeTopic) return null
  const [staker] = decodeAbi(['address'], stakerTopic)
  const [outcome] = decodeAbi(['uint8'], outcomeTopic)
  const [amount] = decodeAbi(['uint256'], log.data)
  if (typeof staker !== 'string' || typeof outcome !== 'bigint' || typeof amount !== 'bigint') {
    return null
  }
  if (outcome !== 0n && outcome !== 1n) return null
  if (amount <= 0n) return null
  return { staker: staker.toLowerCase(), outcome: Number(outcome), amount }
}

/** Decode a `FeePaid` log, or null. Used for the fee report the ledger receives. */
export function decodeFeePaid(
  log: { readonly address: string; readonly topics: readonly string[]; readonly data: string },
  contractAddress: string,
): { treasury: string; amount: bigint } | null {
  if (log.address.toLowerCase() !== contractAddress.toLowerCase()) return null
  if ((log.topics[0] ?? '').toLowerCase() !== FEE_PAID_TOPIC.toLowerCase()) return null
  const treasuryTopic = log.topics[1]
  if (!treasuryTopic) return null
  const [treasury] = decodeAbi(['address'], treasuryTopic)
  const [amount] = decodeAbi(['uint256'], log.data)
  if (typeof treasury !== 'string' || typeof amount !== 'bigint') return null
  return { treasury: treasury.toLowerCase(), amount }
}

/**
 * Write one pass's worth of decoded stakes.
 *
 * **The upsert IS the reorg handling.** `positions_source_uniq` makes `(market, tx, log)` the
 * identity of a stake, so replaying a block writes the same row again rather than a second one, and
 * a log that has become orphaned flips the flag on the row that already exists.
 *
 * `amount` is deliberately NOT updated on conflict. A log's amount cannot change — a different
 * amount at the same `(tx_hash, log_index)` would mean the chain rewrote history in a way no reorg
 * can, and silently taking the new value would erase the evidence. The block fields ARE updated,
 * because a reorg genuinely does move a transaction to a different block.
 */
export async function recordStakes(sql: Db, marketId: string, stakes: readonly DecodedStake[]): Promise<number> {
  let written = 0
  for (const stake of stakes) {
    const rows = await sql`
      insert into positions (
        market_id, staker, outcome, amount, tx_hash, log_index, block_height, block_hash,
        orphaned, orphaned_at
      ) values (
        ${marketId}, ${stake.staker}, ${stake.outcome}, ${stake.amount.toString()},
        ${stake.txHash}, ${stake.logIndex}, ${stake.blockHeight}, ${stake.blockHash},
        ${stake.orphaned}, ${stake.orphaned ? new Date() : null}
      )
      on conflict (market_id, tx_hash, log_index) do update
        set block_height = excluded.block_height,
            block_hash   = excluded.block_hash,
            orphaned     = excluded.orphaned,
            orphaned_at  = case when excluded.orphaned then coalesce(positions.orphaned_at, now()) else null end
      returning id
    `
    if (rows.length > 0) written += 1
  }
  return written
}

/**
 * Bring one market's mirror up to the indexer's view.
 *
 * Two calls per transaction and that is not an accident — see `indexerclient.ts`. `activity`
 * enumerates the value transfers into the contract and carries the canonical/orphaned verdict;
 * the transaction read carries the `Staked` logs that say WHICH outcome was backed. There is no
 * log-query endpoint on the indexer, and adding one is a change to a repository this task may not
 * make.
 */
export async function syncMarket(deps: MirrorDeps, marketId: string): Promise<SyncResult> {
  const market = await findMarket(deps.sql, marketId)
  if (!market) throw new Error(`no market ${marketId}`)
  const contract = market.contractAddress
  if (!contract) return { scanned: 0, recorded: 0, orphaned: 0, tipHeight: null }

  const chain = indexerChainOf(market.chain as ChainId)
  const page = await deps.indexer.activity(chain, market.network, contract.toLowerCase(), deps.pageSize, null)

  // One transaction may carry several stakes, and `activity` reports one item per value transfer.
  // De-duplicating first means one `transaction` read per hash rather than one per transfer.
  const byHash = new Map<string, { orphaned: boolean }>()
  for (const item of page.items) {
    if (item.direction !== 'in') continue
    const existing = byHash.get(item.txHash)
    // Any 'orphaned' sighting wins. A transaction the indexer has marked orphaned in one row and
    // not in another is a transaction mid-reorg, and the conservative reading is the safe one for a
    // number the public page shows.
    byHash.set(item.txHash, { orphaned: (existing?.orphaned ?? false) || item.status === 'orphaned' })
  }

  const stakes: DecodedStake[] = []
  let orphanedCount = 0
  for (const [txHash, { orphaned }] of byHash) {
    const transaction = await deps.indexer.transaction(chain, market.network, txHash)
    // A transaction the indexer has not finished writing is not an error: nothing is recorded for
    // it this pass and the next pass looks again.
    if (!transaction) continue
    const isOrphaned = orphaned || transaction.status === 'orphaned'
    if (isOrphaned) orphanedCount += 1
    for (const log of transaction.logs) {
      const decoded = decodeStaked(log, contract)
      if (!decoded) continue
      stakes.push({
        ...decoded,
        txHash,
        logIndex: log.logIndex,
        blockHeight: transaction.blockHeight ?? 0,
        blockHash: transaction.blockHash ?? '',
        orphaned: isOrphaned,
      })
    }
  }

  const recorded = await recordStakes(deps.sql, marketId, stakes)

  /*
   * ── `last_block` IS HOW FAR THIS MIRROR HAS READ, NOT WHERE THE LAST STAKE WAS ────────────────
   *
   * It used to be `maxBlock(stakes)`, which is ZERO for every market nobody has staked on yet. So
   * `poolOf` computed `behind = tip - 0` and every empty market carried the alarm meant for a
   * mirror that had genuinely fallen over: "▲ 32,423 blocks behind the tip. Our copy has fallen
   * behind the chain, so treat these numbers as having moved." Nothing had moved. The pass had
   * read the contract's entire activity as of the tip and found nothing, which is the ordinary
   * state of a new market and the exact opposite of what the reader was told.
   *
   * Coverage can only be claimed when the page was not truncated. `nextCursor === null` means the
   * indexer had nothing further for this address, so the mirror's copy is current to `tipHeight`.
   * With more pages outstanding the honest answer is unchanged: the highest block a stake has been
   * recorded from, which is all this pass can vouch for.
   */
  const covered = page.nextCursor === null ? (page.tipHeight ?? maxBlock(stakes)) : maxBlock(stakes)

  await deps.sql`
    insert into mirror_cursors (market_id, last_block, tip_block, synced_at, last_error)
    values (${marketId}, ${covered}, ${page.tipHeight}, now(), null)
    on conflict (market_id) do update
      set last_block = greatest(mirror_cursors.last_block, excluded.last_block),
          tip_block  = excluded.tip_block,
          synced_at  = now(),
          last_error = null
  `

  deps.metrics.increment('foresight_mirror_syncs_total')
  return { scanned: byHash.size, recorded, orphaned: orphanedCount, tipHeight: page.tipHeight }
}

function maxBlock(stakes: readonly DecodedStake[]): number {
  let max = 0
  for (const stake of stakes) if (stake.blockHeight > max) max = stake.blockHeight
  return max
}

/** Record that a sync failed, so `/readyz` and the public page can say the mirror is behind. */
/**
 * Every market the mirror still has a reason to follow.
 *
 * A contract address, because `syncMarket` reads nothing without one, and a status that has not
 * finished — `settled` and `void` are terminal and nothing further is ever staked against them, so
 * following them for ever would be an indexer call per market per 30 seconds for a number that can
 * no longer change. `resolved` IS followed: the settlement fee is paid on chain after resolution and
 * `fee.report` needs the `FeePaid` log the mirror indexes.
 *
 * This is `mirror.sweep`'s queue. Before it existed, a market was mirrored exactly once — when its
 * deploy reached `deployed` — and then relied on a self-enqueue that `JobRunner.complete` deleted.
 */
export async function listMirrorable(sql: Db, limit: number): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from markets
     where contract_address is not null
       and status in ('open','closed','resolved')
     order by updated_at limit ${limit}
  `
  return rows.map((row) => row.id)
}

export async function recordSyncError(sql: Db, marketId: string, message: string): Promise<void> {
  await sql`
    insert into mirror_cursors (market_id, last_error) values (${marketId}, ${message.slice(0, 2_000)})
    on conflict (market_id) do update set last_error = excluded.last_error
  `
}

/* ------------------------------------------------------------------ reads */

export interface PoolView {
  /** Wei on YES and on NO, as strings — a JSON number cannot carry 1e18 exactly. */
  readonly yes: string
  readonly no: string
  readonly total: string
  /** The pool ratio in basis points, computed in bigint. `null` when nothing is staked. */
  readonly yesBps: number | null
  readonly noBps: number | null
  readonly stakerCount: number
  /**
   * When this was last read off the chain, and how far behind the tip it is. Shown, always. A pool
   * with no `asOf` is a pool a reader will assume is live.
   */
  readonly asOf: string | null
  readonly lastBlock: number | null
  readonly tipBlock: number | null
  readonly behindBlocks: number | null
  /** True once the mirror is at least this chain's confirmation depth behind, or has never run. */
  readonly stale: boolean
}

/**
 * The pool, summed in the database in exact integer arithmetic.
 *
 * `numeric(78,0)` and `sum()`, never a JavaScript reduce over floats. Orphaned rows are excluded by
 * the WHERE clause rather than subtracted afterwards, so a reorg cannot leave a negative residue.
 */
/**
 * How long the mirror may go unread before the pool calls itself stale.
 *
 * `mirror.sweep` enqueues a sync for every followable market every 30 seconds (`jobs.ts`), so this
 * is ten missed passes — long enough that a slow sweep on a big queue is not an alarm, short enough
 * that a mirror which has genuinely stopped is caught before anybody stakes against its numbers.
 *
 * It exists because the block comparison alone cannot see this failure. `last_block` and `tip_block`
 * are both written by the same pass, so a mirror that stopped running an hour ago goes on reporting
 * `behind = 0` — perfectly current, as of an hour ago. THAT is what "our copy has fallen behind the
 * chain" was always meant to catch.
 */
export const MIRROR_STALE_AFTER_MS = 5 * 60_000

export async function poolOf(
  sql: Db,
  marketId: string,
  chain: ChainId,
  now: Date = new Date(),
): Promise<PoolView> {
  const rows = await sql<
    { yes: string | null; no: string | null; stakers: number }[]
  >`
    select
      sum(amount) filter (where outcome = 0)::text as yes,
      sum(amount) filter (where outcome = 1)::text as no,
      count(distinct staker)::int as stakers
      from positions
     where market_id = ${marketId} and orphaned = false
  `
  const row = rows[0]
  const yes = BigInt(row?.yes ?? '0')
  const no = BigInt(row?.no ?? '0')
  const total = yes + no

  const cursors = await sql<
    { last_block: string | null; tip_block: string | null; synced_at: Date | null }[]
  >`select last_block, tip_block, synced_at from mirror_cursors where market_id = ${marketId}`
  const cursor = cursors[0]
  const lastBlock = cursor?.last_block === null || cursor?.last_block === undefined ? null : Number(cursor.last_block)
  const tipBlock = cursor?.tip_block === null || cursor?.tip_block === undefined ? null : Number(cursor.tip_block)
  const behind = lastBlock !== null && tipBlock !== null ? Math.max(0, tipBlock - lastBlock) : null

  return {
    yes: yes.toString(),
    no: no.toString(),
    total: total.toString(),
    // Basis points in bigint, then narrowed. `Number(x * 10000n / total)` is exact for any pool,
    // because the division happens before the conversion and the result is under 10,000.
    yesBps: total === 0n ? null : Number((yes * 10_000n) / total),
    noBps: total === 0n ? null : Number((no * 10_000n) / total),
    stakerCount: row?.stakers ?? 0,
    asOf: cursor?.synced_at?.toISOString() ?? null,
    lastBlock,
    tipBlock,
    behindBlocks: behind,
    // A mirror that has never run is stale, not empty. The two look identical in the numbers above
    // and they mean opposite things to somebody about to stake. A mirror that ran and then STOPPED
    // is the third case, and it used to read as current — see `MIRROR_STALE_AFTER_MS`.
    stale:
      cursor?.synced_at == null ||
      now.getTime() - cursor.synced_at.getTime() > MIRROR_STALE_AFTER_MS ||
      (behind !== null && behind > requiredConfirmations(chain)),
  }
}

/** One staker's mirrored position. For the portfolio page; the contract is what pays. */
export async function positionOf(
  sql: Db,
  marketId: string,
  staker: string,
): Promise<{ yes: string; no: string }> {
  const rows = await sql<{ yes: string | null; no: string | null }[]>`
    select
      sum(amount) filter (where outcome = 0)::text as yes,
      sum(amount) filter (where outcome = 1)::text as no
      from positions
     where market_id = ${marketId} and staker = ${staker.toLowerCase()} and orphaned = false
  `
  const row = rows[0]
  return { yes: row?.yes ?? '0', no: row?.no ?? '0' }
}
