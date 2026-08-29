/**
 * The deploy, and the one property everything else in it exists for.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A LOST BROADCAST RESPONSE MUST PRODUCE EXACTLY ONE CONTRACT.**
 *
 * Two market contracts for one question is unrecoverable: two pools, stakers split between them,
 * and no way to combine the payouts. It is worse than `micro-mint`'s equivalent failure, which
 * costs a duplicate token and some gas.
 *
 * The property comes from three things, and each is tested here separately so that removing any one
 * of them turns a test red rather than leaving a plausible-looking suite:
 *
 *   1. `evmTxHash` derives the id BEFORE the send, so the hash can be written with the bytes.
 *   2. `markSigned` commits the bytes, the hash and the derived contract address in one UPDATE that
 *      is conditional on the lease. A crash after it resumes at BROADCAST.
 *   3. `claimDeploy` REFUSES a row that already has `raw_tx`, so nothing can ever re-sign one.
 *      `markets_deploy_in_flight_uniq` is the database saying the same thing when a lease has
 *      already failed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  ChainUnavailableError,
  broadcast,
  claimDeploy,
  driveDeploy,
  listOutstandingDeploys,
  type DeployDeps,
} from './deploy.ts'
import { createAddress, evmTxHash } from './evm.ts'
import { findMarket } from './markets.ts'
import {
  DEPLOYER,
  ORACLE,
  TREASURY,
  approveDirect,
  db,
  enabled,
  fakeCustody,
  fakeRpc,
  migrateTestDb,
  openDb,
  quietLogger,
  resetForesight,
  seedDraft,
  skip,
  testMetrics,
  type FakeCustody,
  type FakeRpc,
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

/** A node with enough answers to get a deploy all the way through. */
function nodeAt(options: { balance?: bigint; receipt?: unknown } = {}): FakeRpc {
  const rpc = fakeRpc({
    eth_gasPrice: '0x3b9aca00',
    eth_getBalance: `0x${(options.balance ?? 10n ** 20n).toString(16)}`,
    eth_getTransactionCount: '0x0',
    eth_sendRawTransaction: '0x',
    eth_getTransactionReceipt: options.receipt ?? null,
  })
  return rpc
}

function depsFor(custody: FakeCustody, rpc: FakeRpc, owner = 'worker-1'): DeployDeps {
  return {
    sql: db(sql),
    producer: 'foresight',
    owner,
    network: 'testnet',
    custody,
    rpc: () => rpc.rpc,
    bounds: { minGasPriceWei: 1n, maxGasPriceWei: 500_000_000_000n },
    gasLimit: 3_000_000n,
    treasuryAddress: TREASURY,
    oracleAddress: ORACLE,
    leaseMs: 60_000,
    stuckMs: 30 * 60_000,
    enabled: true,
    logger: quietLogger(),
    metrics: testMetrics(),
  }
}

async function approvedMarket(): Promise<string> {
  const market = await seedDraft(sql)
  await approveDirect(sql, market.id)
  return market.id
}

/* ------------------------------------------------------------------ the happy path */

test('a deploy signs once, commits before broadcasting, and confirms at the derived address', { skip }, async () => {
  const id = await approvedMarket()
  const custody = fakeCustody(DEPLOYER)
  const rpc = nodeAt()

  const first = await driveDeploy(depsFor(custody, rpc), id)
  assert.equal(first, 'broadcast', 'the first pass should broadcast and wait for a receipt')

  const afterBroadcast = await findMarket(db(sql), id)
  assert.ok(afterBroadcast)
  assert.equal(afterBroadcast.deployState, 'broadcast')
  // The bytes, the hash and the address are all on the row, together. There is no instant at which
  // a transaction is on the wire and its id is nowhere.
  assert.ok(afterBroadcast.rawTx)
  assert.equal(afterBroadcast.deployTxHash, evmTxHash(afterBroadcast.rawTx))
  assert.equal(afterBroadcast.contractAddress, createAddress(DEPLOYER, 0n))
  assert.ok(afterBroadcast.broadcastAt)

  // The receipt arrives on a later tick, at the address the service already published.
  rpc.set('eth_getTransactionReceipt', {
    status: '0x1',
    contractAddress: createAddress(DEPLOYER, 0n),
    blockNumber: '0x10',
  })
  assert.equal(await driveDeploy(depsFor(custody, rpc), id), 'deployed')
  const deployed = await findMarket(db(sql), id)
  assert.equal(deployed?.deployState, 'deployed')
  assert.equal(custody.signed.length, 1, 'custody was asked for more than one signature')
})

/* ------------------------------------------------------------------ the lost broadcast */

/**
 * The scenario, exactly: the transaction reaches the node, and the response is lost — the process
 * dies, the socket resets, whatever. The row has bytes and a hash and NO `broadcast_at`.
 *
 * A second worker then picks it up. It must RE-SEND the identical bytes, never re-sign.
 */
test('a lost broadcast response produces exactly ONE contract', { skip }, async () => {
  const id = await approvedMarket()
  const custody = fakeCustody(DEPLOYER)
  const rpc = nodeAt()

  // The send succeeds on the node and the response never comes back to us.
  rpc.failNext('eth_sendRawTransaction', new Error('socket hang up'))
  const first = await driveDeploy(depsFor(custody, rpc, 'worker-1'), id)
  assert.equal(first, 'pending', 'an unknown broadcast outcome must not fail the market')

  const mid = await findMarket(db(sql), id)
  assert.ok(mid?.rawTx, 'the bytes must be committed even though the broadcast is in doubt')
  assert.equal(mid.broadcastAt, null, 'nothing recorded a broadcast that we cannot confirm')
  assert.equal(mid.deployState, 'signed')
  const committedHash = mid.deployTxHash
  const committedAddress = mid.contractAddress

  // A SECOND WORKER, with no memory of the first, and a lease that has not expired.
  const second = await driveDeploy(depsFor(custody, rpc, 'worker-2'), id)
  assert.equal(second, 'broadcast')

  const after = await findMarket(db(sql), id)
  // The SAME bytes, the SAME hash, the SAME address. Not a second signature.
  assert.equal(after?.rawTx, mid.rawTx)
  assert.equal(after?.deployTxHash, committedHash)
  assert.equal(after?.contractAddress, committedAddress)
  assert.equal(custody.signed.length, 1, 'a second signature was requested — that is a second contract')

  // And the node saw the identical payload both times.
  const sends = rpc.calls.filter((call) => call.method === 'eth_sendRawTransaction')
  assert.equal(sends.length, 2, 'the bytes should have been re-sent, once')
  assert.deepEqual(sends[0]?.params, sends[1]?.params, 'the second send was not the same transaction')

  // Confirming leaves exactly one contract address in the registry.
  rpc.set('eth_getTransactionReceipt', {
    status: '0x1',
    contractAddress: committedAddress,
    blockNumber: '0x20',
  })
  assert.equal(await driveDeploy(depsFor(custody, rpc, 'worker-3'), id), 'deployed')
  const contracts = await sql<{ n: number }[]>`
    select count(distinct contract_address)::int as n from markets where id = ${id}
  `
  assert.equal(contracts[0]?.n, 1)
})

test('a node that answers "already known" is a success, not a failure', { skip }, async () => {
  const rpc = fakeRpc({ eth_sendRawTransaction: '0x' })
  // Every wording a real node uses. Reading one of these as a failure would fail a market whose
  // contract is being mined at that moment.
  for (const wording of [
    'already known',
    'ALREADY KNOWN',
    'transaction already imported',
    'known transaction: 0xabc',
    'nonce too low',
  ]) {
    rpc.failNext('eth_sendRawTransaction', new Error(wording))
    await broadcast('0xdeadbeef', rpc.rpc)
  }
  // And a genuine refusal is still a refusal.
  rpc.failNext('eth_sendRawTransaction', new Error('insufficient funds for gas * price + value'))
  await assert.rejects(broadcast('0xdeadbeef', rpc.rpc), /insufficient funds/)
})

test('claimDeploy refuses a row whose bytes are already committed', { skip }, async () => {
  const id = await approvedMarket()
  const custody = fakeCustody(DEPLOYER)
  const rpc = nodeAt()
  rpc.failNext('eth_sendRawTransaction', new Error('socket hang up'))
  await driveDeploy(depsFor(custody, rpc), id)

  // The lease is free — the previous attempt released it — and the row is still `signed`. A claim
  // that succeeded here would re-sign, which is the mistake the whole design is arranged around.
  await sql`update markets set lease_owner = null, lease_until = null where id = ${id}`
  const claimed = await claimDeploy(db(sql), { id, owner: 'worker-9', leaseMs: 60_000 })
  assert.equal(claimed, null, 'a row with committed bytes was claimed for re-signing')
})

/**
 * The database's own version of the rule, for when a lease has already failed — a clock skew past
 * `lease_until`, a handler that outran its lease, an operator running a script beside the workers.
 * `micro-settlement`'s `outbound_in_flight_uniq`, refined to the resource genuinely contended here.
 */
test('THE CONSTRAINT: two in-flight deploys cannot share one deployer address', { skip }, async () => {
  const a = await approvedMarket()
  const b = await approvedMarket()
  await sql`update markets set deploy_state = 'building', deployer_address = ${DEPLOYER} where id = ${a}`
  await assert.rejects(
    sql`update markets set deploy_state = 'building', deployer_address = ${DEPLOYER} where id = ${b}`,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'markets_deploy_in_flight_uniq',
    'two deploys were in flight against one nonce sequence',
  )
  // A finished deploy leaves the index, so the next market on that address may proceed. (In
  // production each market has its own custody-minted deployer, so this is belt and braces.)
  await sql`update markets set deploy_state = 'failed', deploy_error = 'x' where id = ${a}`
  await sql`update markets set deploy_state = 'building', deployer_address = ${DEPLOYER} where id = ${b}`
})

test('THE CONSTRAINT: one transaction hash belongs to at most one market', { skip }, async () => {
  const a = await approvedMarket()
  const b = await approvedMarket()
  const hash = `0x${'77'.repeat(32)}`
  await sql`
    update markets set deploy_state = 'signed', raw_tx = '0xaa', deploy_tx_hash = ${hash},
      contract_address = ${createAddress(DEPLOYER, 1n)}, deployer_address = ${DEPLOYER} where id = ${a}
  `
  await assert.rejects(
    sql`
      update markets set deploy_state = 'signed', raw_tx = '0xbb', deploy_tx_hash = ${hash},
        contract_address = ${createAddress(DEPLOYER, 2n)}, deployer_address = ${'0x' + '88'.repeat(20)}
       where id = ${b}
    `,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'markets_deploy_tx_hash_uniq',
  )
})

test('THE CONSTRAINT: a broadcast row must carry the hash it broadcast', { skip }, async () => {
  const id = await approvedMarket()
  await assert.rejects(
    sql`update markets set broadcast_at = now() where id = ${id}`,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'markets_broadcast_has_hash',
    'a broadcast was recorded with no transaction to point at',
  )
})

/* ------------------------------------------------------------------ the other outcomes */

test('an underfunded deployer waits rather than failing', { skip }, async () => {
  const id = await approvedMarket()
  const custody = fakeCustody(DEPLOYER)
  // One wei, which is what a `balance > 0` gate would let through. The deploy would then die at the
  // node with the lease already claimed.
  const rpc = nodeAt({ balance: 1n })
  assert.equal(await driveDeploy(depsFor(custody, rpc), id), 'awaiting_funds')
  const market = await findMarket(db(sql), id)
  assert.equal(market?.deployState, 'pending')
  const lease = await sql<{ lease_owner: string | null }[]>`select lease_owner from markets where id = ${id}`
  assert.equal(lease[0]?.lease_owner, null, 'the lease was not released for a market awaiting funds')
  assert.equal(custody.signed.length, 0, 'a signature was requested for a deploy that cannot pay')
  // And it is on the sweep's queue, so a closed tab is not the difference between a deployed
  // market and a stuck one.
  const outstanding = await listOutstandingDeploys(db(sql), 10)
  assert.equal(outstanding.length, 1)
})

test('a custody refusal is terminal and says why; an outage is not', { skip }, async () => {
  const refused = await approvedMarket()
  const custodyA = fakeCustody(DEPLOYER)
  const { CustodySignRefusedError } = await import('./custodyclient.ts')
  custodyA.failNextSign(new CustodySignRefusedError(403, 'shape_refused', 'that is not a creation'))
  assert.equal(await driveDeploy(depsFor(custodyA, nodeAt()), refused), 'failed')
  const failed = await findMarket(db(sql), refused)
  assert.equal(failed?.deployState, 'failed')
  assert.match(failed?.deployError ?? '', /not a creation/)

  const paused = await approvedMarket()
  const custodyB = fakeCustody(`0x${'99'.repeat(20)}`)
  const { CustodyUnavailableError } = await import('./custodyclient.ts')
  custodyB.failNextSign(new CustodyUnavailableError('custody timed out'))
  // We do not know whether it signed. Nothing is failed and nothing is committed.
  assert.equal(await driveDeploy(depsFor(custodyB, nodeAt()), paused), 'pending')
  const stillOpen = await findMarket(db(sql), paused)
  assert.equal(stillOpen?.deployState, 'building')
  assert.equal(stillOpen?.rawTx, null)
})

test('a mined address that is not the derived one fails the deploy rather than confirming it', { skip }, async () => {
  const id = await approvedMarket()
  const custody = fakeCustody(DEPLOYER)
  const rpc = nodeAt()
  await driveDeploy(depsFor(custody, rpc), id)

  // The nonce moved under us: the contract at the address this service published is not ours.
  rpc.set('eth_getTransactionReceipt', {
    status: '0x1',
    contractAddress: `0x${'ee'.repeat(20)}`,
    blockNumber: '0x30',
  })
  assert.equal(await driveDeploy(depsFor(custody, rpc), id), 'failed')
  const market = await findMarket(db(sql), id)
  assert.equal(market?.deployState, 'failed')
  assert.match(market?.deployError ?? '', /nonce moved/)
})

test('a reverted creation is failed, and the attempt trail records every step', { skip }, async () => {
  const id = await approvedMarket()
  const custody = fakeCustody(DEPLOYER)
  const rpc = nodeAt()
  await driveDeploy(depsFor(custody, rpc), id)
  rpc.set('eth_getTransactionReceipt', {
    status: '0x0',
    contractAddress: createAddress(DEPLOYER, 0n),
    blockNumber: '0x40',
  })
  assert.equal(await driveDeploy(depsFor(custody, rpc), id), 'failed')

  const attempts = await sql<{ outcome: string }[]>`
    select outcome from market_deploy_attempts where market_id = ${id} order by id
  `
  // Evidence, kept even when a deploy eventually succeeds. "It worked on the fourth try" is a
  // different operational fact from "it worked".
  assert.deepEqual(attempts.map((row) => row.outcome), ['signed', 'broadcast', 'reverted'])
})

test('deploys can be turned off without turning the service off', { skip }, async () => {
  const id = await approvedMarket()
  const custody = fakeCustody(DEPLOYER)
  const deps = { ...depsFor(custody, nodeAt()), enabled: false }
  assert.equal(await driveDeploy(deps, id), 'skipped')
  assert.equal(custody.signed.length, 0)
})

test('a chain with no configured endpoint is refused, never defaulted to a public node', { skip }, async () => {
  const { rpcRouter } = await import('./deploy.ts')
  const router = rpcRouter({}, 1_000)
  assert.throws(() => router('ember'), /no JSON-RPC endpoint is configured/)
  // A market deployed through an endpoint nobody chose is a market whose chain nobody chose.
  const configured = rpcRouter({ ember: 'http://127.0.0.1:1' }, 1_000)
  assert.equal(typeof configured('ember'), 'function')
})

test('an unreachable node is unavailability, never a refusal', { skip }, async () => {
  const { jsonRpcOver } = await import('./deploy.ts')
  const rpc = jsonRpcOver('http://127.0.0.1:1/', 200)
  await assert.rejects(rpc('eth_gasPrice', []), (err: unknown) => err instanceof ChainUnavailableError)
})
