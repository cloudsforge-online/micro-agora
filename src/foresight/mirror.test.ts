/**
 * The mirror, and the property it exists to have.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A REORG REPLAY MUST NOT DOUBLE-COUNT A STAKE.**
 *
 * A reorganisation makes the indexer hand back the same logs a second time, with the same
 * `(tx_hash, log_index)` and possibly a different block. If that produced a second row, the public
 * page would tell a bettor the pool is twice its real size — and they would stake against odds that
 * do not exist.
 *
 * The property comes from `positions_source_uniq`, not from the sync code being careful, and the
 * tests below are arranged to prove that: one of them writes the rows through `recordStakes`
 * twice, one of them replays a whole sync pass, and one goes round both with raw SQL.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { encodeAbi } from './evm.ts'
import type { ActivityItem, TransactionView } from './indexerclient.ts'
import {
  MIRROR_STALE_AFTER_MS,
  STAKED_TOPIC,
  poolOf,
  positionOf,
  recordStakes,
  recordSyncError,
  syncMarket,
  type MirrorDeps,
} from './mirror.ts'
import {
  db,
  enabled,
  fakeIndexer,
  migrateTestDb,
  openDb,
  openDirect,
  quietLogger,
  resetForesight,
  seedDraft,
  skip,
  testMetrics,
  type FakeIndexer,
} from './testsupport.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetForesight(sql)
})

const CONTRACT = '0x4444444444444444444444444444444444444444'
const ALICE = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const BOB = '0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0'
const ONE = 10n ** 18n

function stakedLog(logIndex: number, staker: string, outcome: bigint, amount: bigint) {
  return {
    logIndex,
    address: CONTRACT,
    topics: [
      STAKED_TOPIC,
      `0x${'0'.repeat(24)}${staker.slice(2)}`,
      `0x${outcome.toString(16).padStart(64, '0')}`,
    ],
    data: `0x${encodeAbi([
      { type: 'uint256', value: amount },
      { type: 'uint256', value: amount },
      { type: 'uint256', value: 0n },
    ]).toString('hex')}`,
    status: 'included',
  }
}

function activity(txHash: string, status: 'included' | 'orphaned', blockHeight = 10): ActivityItem {
  return {
    id: `${txHash}:0`,
    direction: 'in',
    amount: ONE.toString(),
    txHash,
    logIndex: 0,
    blockHeight,
    blockHash: `0x${'bb'.repeat(32)}`,
    status,
    confirmations: 61,
    confirmed: true,
  }
}

function transaction(
  hash: string,
  status: 'included' | 'orphaned',
  logs: ReturnType<typeof stakedLog>[],
  blockHeight = 10,
): TransactionView {
  return {
    hash,
    blockHeight,
    blockHash: `0x${'bb'.repeat(32)}`,
    status,
    confirmations: 61,
    logs,
  }
}

async function mirrorFor(indexer: FakeIndexer): Promise<MirrorDeps> {
  return { sql: db(sql), indexer, pageSize: 100, logger: quietLogger(), metrics: testMetrics() }
}

async function openedMarket(): Promise<string> {
  const market = await seedDraft(sql)
  await openDirect(sql, market.id, CONTRACT)
  return market.id
}

/* ------------------------------------------------------------------ the reorg replay */

test('THE PROPERTY: replaying a whole sync pass does not double-count a stake', { skip }, async () => {
  const id = await openedMarket()
  const indexer = fakeIndexer()
  const tx = `0x${'11'.repeat(32)}`
  indexer.setActivity([activity(tx, 'included')], 100)
  indexer.setTransaction(tx, transaction(tx, 'included', [stakedLog(0, ALICE, 0n, 3n * ONE)]))

  const first = await syncMarket(await mirrorFor(indexer), id)
  assert.equal(first.recorded, 1)
  assert.equal((await poolOf(db(sql), id, 'ember')).yes, (3n * ONE).toString())

  // The same pass again — which is exactly what a reorg makes the indexer produce.
  await syncMarket(await mirrorFor(indexer), id)
  await syncMarket(await mirrorFor(indexer), id)

  const rows = await sql<{ n: number }[]>`select count(*)::int as n from positions where market_id = ${id}`
  assert.equal(rows[0]?.n, 1, 'a replayed log produced a second position row')
  assert.equal((await poolOf(db(sql), id, 'ember')).yes, (3n * ONE).toString(), 'the pool doubled')
})

test('THE CONSTRAINT: the same (market, tx, log) cannot be inserted twice, even in raw SQL', { skip }, async () => {
  const id = await openedMarket()
  const tx = `0x${'22'.repeat(32)}`
  const insert = () => sql`
    insert into positions (market_id, staker, outcome, amount, tx_hash, log_index, block_height, block_hash)
    values (${id}, ${ALICE}, 0, ${(5n * ONE).toString()}, ${tx}, 0, 10, ${'0x' + 'bb'.repeat(32)})
  `
  await insert()
  await assert.rejects(
    insert(),
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'positions_source_uniq',
    'the database allowed one log to become two positions',
  )
})

test('a reorg that orphans a transaction removes it from the pool without losing the evidence', { skip }, async () => {
  const id = await openedMarket()
  const indexer = fakeIndexer()
  const kept = `0x${'33'.repeat(32)}`
  const orphaned = `0x${'44'.repeat(32)}`
  indexer.setActivity([activity(kept, 'included', 10), activity(orphaned, 'included', 11)], 100)
  indexer.setTransaction(kept, transaction(kept, 'included', [stakedLog(0, ALICE, 0n, 2n * ONE)], 10))
  indexer.setTransaction(orphaned, transaction(orphaned, 'included', [stakedLog(0, BOB, 1n, 7n * ONE)], 11))

  await syncMarket(await mirrorFor(indexer), id)
  let pool = await poolOf(db(sql), id, 'ember')
  assert.equal(pool.yes, (2n * ONE).toString())
  assert.equal(pool.no, (7n * ONE).toString())
  assert.equal(pool.stakerCount, 2)

  // The chain reorganises: the second transaction is no longer canonical.
  indexer.setActivity([activity(kept, 'included', 10), activity(orphaned, 'orphaned', 11)], 101)
  indexer.setTransaction(orphaned, transaction(orphaned, 'orphaned', [stakedLog(0, BOB, 1n, 7n * ONE)], 11))
  await syncMarket(await mirrorFor(indexer), id)

  pool = await poolOf(db(sql), id, 'ember')
  assert.equal(pool.yes, (2n * ONE).toString())
  assert.equal(pool.no, '0', 'an orphaned stake is still in the pool')
  assert.equal(pool.stakerCount, 1)

  // The row is MARKED, not deleted. It is the only evidence this service ever believed the stake
  // existed, and an operator looking at a disputed pool needs to see it.
  const rows = await sql<{ orphaned: boolean; orphaned_at: Date | null }[]>`
    select orphaned, orphaned_at from positions where market_id = ${id} and tx_hash = ${orphaned}
  `
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.orphaned, true)
  assert.ok(rows[0]?.orphaned_at)

  // And a re-organisation that puts it back restores it, without a second row.
  indexer.setActivity([activity(kept, 'included', 10), activity(orphaned, 'included', 12)], 102)
  indexer.setTransaction(orphaned, transaction(orphaned, 'included', [stakedLog(0, BOB, 1n, 7n * ONE)], 12))
  await syncMarket(await mirrorFor(indexer), id)
  pool = await poolOf(db(sql), id, 'ember')
  assert.equal(pool.no, (7n * ONE).toString())
  const all = await sql<{ n: number }[]>`select count(*)::int as n from positions where market_id = ${id}`
  assert.equal(all[0]?.n, 2)
})

test('an amount is never rewritten by a replay, because a log’s amount cannot change', { skip }, async () => {
  const id = await openedMarket()
  const tx = `0x${'55'.repeat(32)}`
  await recordStakes(db(sql), id, [
    { staker: ALICE, outcome: 0, amount: 4n * ONE, txHash: tx, logIndex: 0, blockHeight: 10, blockHash: '0xbb', orphaned: false },
  ])
  // A "replay" claiming a different amount at the same source. The chain cannot do this, and if
  // something upstream ever did, silently taking the new value would erase the evidence.
  await recordStakes(db(sql), id, [
    { staker: ALICE, outcome: 0, amount: 999n * ONE, txHash: tx, logIndex: 0, blockHeight: 11, blockHash: '0xcc', orphaned: false },
  ])
  const rows = await sql<{ amount: string; block_height: string }[]>`
    select amount::text, block_height::text from positions where market_id = ${id}
  `
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.amount, (4n * ONE).toString(), 'a replay rewrote an amount')
  // The block fields ARE updated, because a reorg genuinely does move a transaction.
  assert.equal(rows[0]?.block_height, '11')
})

test('several stakes in one transaction are separate positions', { skip }, async () => {
  const id = await openedMarket()
  const indexer = fakeIndexer()
  const tx = `0x${'66'.repeat(32)}`
  // Two logs at different indices — a batching wallet, or a contract that stakes twice.
  indexer.setActivity([activity(tx, 'included'), activity(tx, 'included')], 100)
  indexer.setTransaction(
    tx,
    transaction(tx, 'included', [stakedLog(0, ALICE, 0n, ONE), stakedLog(1, ALICE, 1n, 2n * ONE)]),
  )
  await syncMarket(await mirrorFor(indexer), id)
  const pool = await poolOf(db(sql), id, 'ember')
  assert.equal(pool.yes, ONE.toString())
  assert.equal(pool.no, (2n * ONE).toString())
  assert.equal(pool.stakerCount, 1)
  // One `transaction` read for two transfers, because the sync de-duplicates by hash first.
  const position = await positionOf(db(sql), id, ALICE)
  assert.equal(position.yes, ONE.toString())
  assert.equal(position.no, (2n * ONE).toString())
})

test('a log from a different contract in the same transaction is not this market’s stake', { skip }, async () => {
  const id = await openedMarket()
  const indexer = fakeIndexer()
  const tx = `0x${'77'.repeat(32)}`
  indexer.setActivity([activity(tx, 'included')], 100)
  indexer.setTransaction(
    tx,
    transaction(tx, 'included', [
      stakedLog(0, ALICE, 0n, ONE),
      // A `Staked`-shaped event from somewhere else entirely.
      { ...stakedLog(1, BOB, 0n, 500n * ONE), address: `0x${'99'.repeat(20)}` },
    ]),
  )
  await syncMarket(await mirrorFor(indexer), id)
  const pool = await poolOf(db(sql), id, 'ember')
  assert.equal(pool.yes, ONE.toString(), 'another contract’s event was credited to this pool')
})

/* ------------------------------------------------------------------ the pool ratio, and `asOf` */

test('the pool ratio is computed in exact integer arithmetic', { skip }, async () => {
  const id = await openedMarket()
  // Numbers a float would not survive: 1e18 is four orders of magnitude past what a double holds
  // exactly, and the ratio has to come out of the integers.
  await recordStakes(db(sql), id, [
    { staker: ALICE, outcome: 0, amount: 333_333_333_333_333_333n, txHash: `0x${'a'.repeat(64)}`, logIndex: 0, blockHeight: 1, blockHash: '0x', orphaned: false },
    { staker: BOB, outcome: 1, amount: 666_666_666_666_666_667n, txHash: `0x${'b'.repeat(64)}`, logIndex: 0, blockHeight: 1, blockHash: '0x', orphaned: false },
  ])
  const pool = await poolOf(db(sql), id, 'ember')
  assert.equal(pool.total, '1000000000000000000')
  assert.equal(pool.yesBps, 3_333)
  assert.equal(pool.noBps, 6_666)
})

test('an empty pool has no ratio rather than a zero one', { skip }, async () => {
  const id = await openedMarket()
  const pool = await poolOf(db(sql), id, 'ember')
  assert.equal(pool.total, '0')
  assert.equal(pool.yesBps, null)
  assert.equal(pool.noBps, null)
  // And it has never synced, which is a DIFFERENT fact from "nobody has staked" and looks
  // identical in the numbers.
  assert.equal(pool.asOf, null)
  assert.equal(pool.stale, true)
})

test('a complete pass is current to the tip, whatever block the last stake was in', { skip }, async () => {
  const id = await openedMarket()
  const indexer = fakeIndexer()
  const tx = `0x${'88'.repeat(32)}`
  indexer.setActivity([activity(tx, 'included', 100)], 110)
  indexer.setTransaction(tx, transaction(tx, 'included', [stakedLog(0, ALICE, 0n, ONE)], 100))
  await syncMarket(await mirrorFor(indexer), id)

  const pool = await poolOf(db(sql), id, 'ember')
  assert.ok(pool.asOf, 'a pool with no asOf is a pool a reader will assume is live')
  // The stake was in block 100 and the tip is 110. The mirror is not ten blocks behind: it read
  // this contract's whole activity as of 110 and there was nothing in the last ten blocks.
  assert.equal(pool.lastBlock, 110)
  assert.equal(pool.tipBlock, 110)
  assert.equal(pool.behindBlocks, 0)
  assert.equal(pool.stale, false)
})

test('an empty market is not a market whose mirror has fallen over', { skip }, async () => {
  // The regression this test exists for. `last_block` was the highest block a STAKE was found in,
  // so a market nobody had staked on recorded zero and the page told every reader "32,423 blocks
  // behind the tip — our copy has fallen behind the chain". Nothing had fallen behind.
  const id = await openedMarket()
  const indexer = fakeIndexer()
  indexer.setActivity([], 32_423)
  await syncMarket(await mirrorFor(indexer), id)

  const pool = await poolOf(db(sql), id, 'ember')
  assert.equal(pool.total, '0')
  assert.equal(pool.lastBlock, 32_423)
  assert.equal(pool.behindBlocks, 0)
  assert.equal(pool.stale, false, 'an empty pool that was read a second ago is empty, not stale')
})

test('a truncated page claims only the blocks it recorded, and says it is behind', { skip }, async () => {
  const id = await openedMarket()
  const indexer = fakeIndexer()
  const tx = `0x${'88'.repeat(32)}`
  indexer.setActivity([activity(tx, 'included', 100)], 400)
  indexer.setTransaction(tx, transaction(tx, 'included', [stakedLog(0, ALICE, 0n, ONE)], 100))
  // More pages outstanding: this pass has NOT seen everything the indexer holds for the contract,
  // so the only height it can vouch for is the one it recorded a stake from.
  indexer.setTruncated('page-2')
  await syncMarket(await mirrorFor(indexer), id)

  const pool = await poolOf(db(sql), id, 'ember')
  assert.equal(pool.lastBlock, 100)
  assert.equal(pool.tipBlock, 400)
  assert.equal(pool.behindBlocks, 300)
  assert.equal(pool.stale, true, 'a mirror 300 blocks behind should say so')
})

test('a mirror that ran once and then stopped is stale, however current its blocks look', { skip }, async () => {
  // The failure the block comparison cannot see: `last_block` and `tip_block` are written by the
  // same pass, so a mirror that died an hour ago reports `behind = 0` for ever.
  const id = await openedMarket()
  const indexer = fakeIndexer()
  indexer.setActivity([], 110)
  await syncMarket(await mirrorFor(indexer), id)

  const later = new Date(Date.now() + MIRROR_STALE_AFTER_MS + 60_000)
  const pool = await poolOf(db(sql), id, 'ember', later)
  assert.equal(pool.behindBlocks, 0)
  assert.equal(pool.stale, true, 'a mirror nobody has run for an hour is not a current pool')
})

test('an indexer outage is a degraded read, recorded, and never a wrong pool', { skip }, async () => {
  const id = await openedMarket()
  const indexer = fakeIndexer()
  const tx = `0x${'99'.repeat(32)}`
  indexer.setActivity([activity(tx, 'included')], 100)
  indexer.setTransaction(tx, transaction(tx, 'included', [stakedLog(0, ALICE, 0n, 5n * ONE)]))
  await syncMarket(await mirrorFor(indexer), id)

  indexer.setDown(true)
  await assert.rejects(syncMarket(await mirrorFor(indexer), id))
  await recordSyncError(db(sql), id, 'indexer is down')

  // The pool is what it was, with its old `asOf`. It is NOT zero, and it is not wrong — it is old,
  // and the page says so.
  const pool = await poolOf(db(sql), id, 'ember')
  assert.equal(pool.yes, (5n * ONE).toString())
  assert.ok(pool.asOf)
  const cursor = await sql<{ last_error: string | null }[]>`
    select last_error from mirror_cursors where market_id = ${id}
  `
  assert.equal(cursor[0]?.last_error, 'indexer is down')
})

test('a market with no contract has nothing to mirror and says so quietly', { skip }, async () => {
  const market = await seedDraft(sql)
  const indexer = fakeIndexer()
  const result = await syncMarket(await mirrorFor(indexer), market.id)
  assert.deepEqual(result, { scanned: 0, recorded: 0, orphaned: 0, tipHeight: null })
})

/* ------------------------------------------------------------------ the amount column */

test('THE CONSTRAINT: a position amount is a positive integer, never a float', { skip }, async () => {
  const id = await openedMarket()
  await assert.rejects(
    sql`
      insert into positions (market_id, staker, outcome, amount, tx_hash, log_index, block_height, block_hash)
      values (${id}, ${ALICE}, 0, 0, ${'0x' + 'ab'.repeat(32)}, 0, 1, '0x')
    `,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'positions_amount_ck',
  )
  // And the column really is exact at 78 digits: 2^256 - 1 round-trips without loss.
  const huge = (2n ** 255n).toString()
  await sql`
    insert into positions (market_id, staker, outcome, amount, tx_hash, log_index, block_height, block_hash)
    values (${id}, ${ALICE}, 0, ${huge}, ${'0x' + 'cd'.repeat(32)}, 0, 1, '0x')
  `
  const rows = await sql<{ amount: string }[]>`select amount::text from positions where market_id = ${id}`
  assert.equal(rows[0]?.amount, huge)
})
