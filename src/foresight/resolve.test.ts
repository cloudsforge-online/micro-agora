/**
 * Resolution: the missing-source rule, and the chain-keyed lease.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A MARKET WHOSE NAMED SOURCE IS GONE AT RESOLUTION IS VOID — REFUND, NOT IMPROVISATION.**
 *
 * The tests below make the operator ask for a definite outcome and then take the source away. The
 * operator's answer is overruled and the market voids. That is the rule costing something, which is
 * how you know it is doing work: the platform loses its fee, and the bettors lose nothing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { createAddress } from './evm.ts'
import { findMarket } from './markets.ts'
import {
  ACTION_RESOLVE_NO,
  ACTION_RESOLVE_YES,
  ACTION_VOID,
  ResolutionError,
  claimForBuilding,
  driveResolution,
  findResolutionByMarket,
  httpSourceProbe,
  isInFlightConflict,
  listOutstandingResolutions,
  planResolution,
  resolutionLeaseKey,
  resolutionView,
  type Resolution,
  type ResolveDeps,
} from './resolve.ts'
import {
  ORACLE,
  db,
  enabled,
  fakeCustody,
  fakeRpc,
  fakeSourceProbe,
  fakeTarget,
  migrateTestDb,
  openDb,
  openDirect,
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

/**
 * A market that has closed. The contract address is left to `openDirect` to derive from the market
 * id — several tests here open TWO markets, and `markets_contract_uniq` refuses a shared one, which
 * is the constraint doing its job.
 */
async function closedMarket(): Promise<string> {
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  await sql`update markets set status = 'closed', closed_at = now() where id = ${market.id}`
  return market.id
}

function node(): FakeRpc {
  return fakeRpc({
    eth_gasPrice: '0x3b9aca00',
    eth_getTransactionCount: '0x0',
    eth_sendRawTransaction: '0x',
    eth_getTransactionReceipt: null,
  })
}

function depsFor(custody: FakeCustody, rpc: FakeRpc, owner = 'worker-1'): ResolveDeps {
  return {
    sql: db(sql),
    owner,
    custody,
    rpc: () => rpc.rpc,
    bounds: { minGasPriceWei: 1n, maxGasPriceWei: 500_000_000_000n },
    gasLimit: 300_000n,
    oracleAddress: ORACLE,
    oracleUserId: 'foresight',
    oracleOrderId: 'oracle-ember-testnet',
    leaseMs: 60_000,
    enabled: true,
    logger: quietLogger(),
    metrics: testMetrics(),
  }
}

/* ------------------------------------------------------------------ the missing source */

test('THE RULE: a market whose named source is gone is voided, not resolved', { skip }, async () => {
  const id = await closedMarket()
  const probe = fakeSourceProbe(false)

  // The operator is sure the answer is YES. The source is gone, so it does not matter.
  const resolution = await planResolution(db(sql), probe, {
    marketId: id,
    outcome: 0,
    rationale: 'the explorer showed block 5,000,000 at 2026-11-02T04:00:00Z',
  })

  assert.equal(resolution.action, ACTION_VOID, 'the resolution did not become a void')
  assert.match(resolution.rationale, /unreachable at resolution/)
  // The rationale names the source, so the reason survives on the row without a lookup.
  assert.match(resolution.rationale, /explorer\.cloudsforge\.online/)
})

test('a reachable source resolves to the outcome the operator states', { skip }, async () => {
  const id = await closedMarket()
  const probe = fakeSourceProbe(true)
  const yes = await planResolution(db(sql), probe, { marketId: id, outcome: 0, rationale: 'because' })
  assert.equal(yes.action, ACTION_RESOLVE_YES)

  const other = await closedMarket()
  const no = await planResolution(db(sql), probe, { marketId: other, outcome: 1, rationale: 'because' })
  assert.equal(no.action, ACTION_RESOLVE_NO)
})

test('the source probe treats a real 404 as gone and a real 200 as present', { skip }, async () => {
  const target = await fakeTarget()
  try {
    const probe = httpSourceProbe(2_000)
    assert.equal(await probe.reachable(`${target.baseUrl}/block/5000000`), true)
    target.setStatus(404)
    assert.equal(await probe.reachable(`${target.baseUrl}/block/5000000`), false)
    // A refused connection is a gone source too, and it is a genuinely different failure from a
    // 404 — a test that only ever simulated one would miss the other.
    assert.equal(await probe.reachable('http://127.0.0.1:1/gone'), false)
  } finally {
    await target.close()
  }
})

/**
 * A source that is not a URL cannot be probed, and refusing to resolve it would void every market
 * in the `price_index` category. The operator's own check is the resolution for those, which is
 * what the rationale records.
 */
test('a source that is not a URL is not treated as missing', { skip }, async () => {
  const probe = httpSourceProbe(2_000)
  assert.equal(await probe.reachable('LBMA Gold Price PM auction'), true)
  assert.equal(await probe.reachable('ftp://example.invalid/x'), true)
})

test('a resolution can only be planned for a closed market, and needs a rationale', { skip }, async () => {
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  await assert.rejects(
    planResolution(db(sql), fakeSourceProbe(), { marketId: market.id, outcome: 0, rationale: 'x' }),
    (err: unknown) => err instanceof ResolutionError && err.code === 'not_closed',
  )
  const closed = await closedMarket()
  await assert.rejects(
    planResolution(db(sql), fakeSourceProbe(), { marketId: closed, outcome: 0, rationale: '   ' }),
    (err: unknown) => err instanceof ResolutionError && err.code === 'no_rationale',
  )
})

test('planning twice returns the plan that exists rather than a second one', { skip }, async () => {
  const id = await closedMarket()
  const first = await planResolution(db(sql), fakeSourceProbe(), { marketId: id, outcome: 0, rationale: 'a' })
  // A retry after a lost response. It gets the plan that was made — not a 409 it has to interpret,
  // and not a second resolution that would be a second answer to an answered question.
  const second = await planResolution(db(sql), fakeSourceProbe(), { marketId: id, outcome: 1, rationale: 'b' })
  assert.equal(second.id, first.id)
  assert.equal(second.action, first.action)
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from resolutions where market_id = ${id}`
  assert.equal(rows[0]?.n, 1)
})

/* ------------------------------------------------------------------ the chain-keyed lease */

test('the lease key names the chain, because the oracle nonce is what is contended', { skip }, () => {
  assert.equal(resolutionLeaseKey('ember', 'testnet'), 'oracle:ember:testnet')
  assert.equal(resolutionLeaseKey('ember', 'mainnet'), 'oracle:ember:mainnet')
})

/**
 * `micro-settlement`'s invariant, in this repository's shape.
 *
 * With the lease working this cannot happen. Without the index it would not be caught at all, and
 * the second worker would go on to read the same nonce and ask custody for a second signature
 * against it — one resolution lost permanently, with a market's winners waiting on it.
 */
test('THE CONSTRAINT: two resolutions cannot be in flight on one chain', { skip }, async () => {
  const a = await closedMarket()
  const b = await closedMarket()
  const first = await planResolution(db(sql), fakeSourceProbe(), { marketId: a, outcome: 0, rationale: 'a' })
  const second = await planResolution(db(sql), fakeSourceProbe(), { marketId: b, outcome: 0, rationale: 'b' })

  assert.equal(await claimForBuilding(db(sql), first.id, 'worker-1', 60_000), true)
  // The lease has failed — a clock skew, a script beside the workers. The database is what is left.
  assert.equal(
    await claimForBuilding(db(sql), second.id, 'worker-2', 60_000),
    false,
    'two resolutions reached building on one chain',
  )

  // And the conflict is recognised as "not my turn" rather than propagated as an alarm.
  await assert.rejects(
    sql`update resolutions set state = 'building' where id = ${second.id}`,
    (err: unknown) => isInFlightConflict(err),
  )

  // Once the first finishes, the second may proceed.
  await sql`update resolutions set state = 'confirmed', raw_tx = '0xaa', tx_hash = ${'0x' + '11'.repeat(32)}, broadcast_at = now(), confirmed_at = now() where id = ${first.id}`
  assert.equal(await claimForBuilding(db(sql), second.id, 'worker-2', 60_000), true)
})

test('one market has at most one resolution, for ever', { skip }, async () => {
  const id = await closedMarket()
  await planResolution(db(sql), fakeSourceProbe(), { marketId: id, outcome: 0, rationale: 'a' })
  await assert.rejects(
    sql`insert into resolutions (market_id, chain, network, action, rationale) values (${id}, 'ember', 'testnet', 1, 'b')`,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'resolutions_market_uniq',
  )
})

/* ------------------------------------------------------------------ the oracle post */

test('the oracle posts by creating a resolver at the address the market will derive', { skip }, async () => {
  const id = await closedMarket()
  const plan = await planResolution(db(sql), fakeSourceProbe(), { marketId: id, outcome: 0, rationale: 'yes' })
  const custody = fakeCustody(ORACLE)
  const rpc = node()

  assert.equal(await driveResolution(depsFor(custody, rpc), plan.id), 'broadcast')

  const row = await findResolutionByMarket(db(sql), id)
  assert.ok(row)
  assert.equal(row.state, 'broadcast')
  // The resolver's address is derived before it exists, and it is the address the MARKET
  // recomputes from `(oracle, nonce)` — proven equal to the Solidity derivation in contracts.test.
  assert.equal(row.resolverAddress, createAddress(ORACLE, 0n))
  assert.equal(row.oracleNonce, 0n)
  assert.ok(row.txHash)
  assert.ok(row.rawTx)

  // **NO NEW SIGNING PATH.** The signature is a `deployer`-purpose zero-value creation, which is
  // the one shape custody already signs (`custody/src/signing.ts`).
  assert.equal(custody.signed.length, 1)
  const request = custody.signed[0]
  assert.equal(request?.purpose, 'deployer')
  assert.equal(request?.payload['to'], null)
  assert.equal(request?.payload['value'], '0')
  assert.equal(request?.payload['type'], 0, 'Hearth has no EIP-1559 decoder; the payload must be legacy')
  assert.ok(String(request?.payload['data']).startsWith('0x'))

  // The receipt lands on a later tick.
  rpc.set('eth_getTransactionReceipt', { status: '0x1', contractAddress: createAddress(ORACLE, 0n), blockNumber: '0x1' })
  assert.equal(await driveResolution(depsFor(custody, rpc), plan.id), 'confirmed')
  assert.equal((await findResolutionByMarket(db(sql), id))?.state, 'confirmed')
  assert.equal(custody.signed.length, 1, 'a second signature was requested for one resolution')
})

test('a lost broadcast re-sends the same resolver, never a second one', { skip }, async () => {
  const id = await closedMarket()
  const plan = await planResolution(db(sql), fakeSourceProbe(), { marketId: id, outcome: 0, rationale: 'yes' })
  const custody = fakeCustody(ORACLE)
  const rpc = node()
  rpc.failNext('eth_sendRawTransaction', new Error('socket hang up'))
  assert.equal(await driveResolution(depsFor(custody, rpc, 'worker-1'), plan.id), 'pending')

  const mid = await findResolutionByMarket(db(sql), id)
  assert.ok(mid?.rawTx)
  assert.equal(mid.broadcastAt, null)

  assert.equal(await driveResolution(depsFor(custody, rpc, 'worker-2'), plan.id), 'broadcast')
  const after = await findResolutionByMarket(db(sql), id)
  assert.equal(after?.rawTx, mid.rawTx)
  assert.equal(after?.txHash, mid.txHash)
  assert.equal(custody.signed.length, 1, 'a second resolver was signed')
  const sends = rpc.calls.filter((call) => call.method === 'eth_sendRawTransaction')
  assert.deepEqual(sends[0]?.params, sends[1]?.params)
})

test('a resolver whose creation reverted is failed, because the market refused it', { skip }, async () => {
  const id = await closedMarket()
  const plan = await planResolution(db(sql), fakeSourceProbe(), { marketId: id, outcome: 0, rationale: 'yes' })
  const custody = fakeCustody(ORACLE)
  const rpc = node()
  await driveResolution(depsFor(custody, rpc), plan.id)
  rpc.set('eth_getTransactionReceipt', { status: '0x0', contractAddress: createAddress(ORACLE, 0n), blockNumber: '0x1' })
  assert.equal(await driveResolution(depsFor(custody, rpc), plan.id), 'failed')
  const row = await findResolutionByMarket(db(sql), id)
  assert.equal(row?.state, 'failed')
  // Every reason the market can refuse is a real fact about it — not yet closed, already resolved,
  // wrong caller — and none is fixed by trying again with the same inputs.
  assert.match(row?.lastError ?? '', /market refused/)
})

test('resolutions outstanding are the job’s queue, and a finished one leaves it', { skip }, async () => {
  const id = await closedMarket()
  const plan = await planResolution(db(sql), fakeSourceProbe(), { marketId: id, outcome: 0, rationale: 'yes' })
  assert.equal((await listOutstandingResolutions(db(sql), 10)).length, 1)
  await sql`update resolutions set state = 'confirmed', raw_tx='0xaa', tx_hash=${'0x' + '22'.repeat(32)}, broadcast_at=now(), confirmed_at=now() where id = ${plan.id}`
  assert.equal((await listOutstandingResolutions(db(sql), 10)).length, 0)
})

test('THE CONSTRAINT: a broadcast resolution must carry the hash it broadcast', { skip }, async () => {
  const id = await closedMarket()
  const plan = await planResolution(db(sql), fakeSourceProbe(), { marketId: id, outcome: 0, rationale: 'y' })
  await assert.rejects(
    sql`update resolutions set broadcast_at = now() where id = ${plan.id}`,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'resolutions_broadcast_has_hash',
  )
})

test('the market is only marked resolved AFTER the chain has accepted it', { skip }, async () => {
  const id = await closedMarket()
  const plan = await planResolution(db(sql), fakeSourceProbe(), { marketId: id, outcome: 0, rationale: 'yes' })
  const custody = fakeCustody(ORACLE)
  const rpc = node()
  await driveResolution(depsFor(custody, rpc), plan.id)
  // Broadcast, not confirmed. The registry must NOT say resolved yet: writing it first would make
  // the database the source of truth for an outcome the contract pays against.
  assert.equal((await findMarket(db(sql), id))?.status, 'closed')
  assert.equal((await findMarket(db(sql), id))?.outcome, null)
})

test('a signed resolution can actually be serialised — the route used to 500 here', () => {
  // The regression in full. `oracleNonce` is a bigint and `send()` uses JSON.stringify, which
  // THROWS on a bigint rather than coercing it. So the route answered correctly only while the
  // resolution was unsigned, and failed on every call an operator would make. No test covered the
  // route, so nothing caught it; micro-foresight-admin-web did, by calling it.
  const signed: Resolution = {
    id: '11111111-1111-4111-8111-111111111111',
    marketId: '22222222-2222-4222-8222-222222222222',
    chain: 'hearth',
    network: 'testnet',
    action: 0,
    rationale: 'the named source published the outcome',
    state: 'signed',
    oracleAddress: '0x1111111111111111111111111111111111111111',
    oracleNonce: 42n,
    resolverAddress: '0x2222222222222222222222222222222222222222',
    rawTx: '0xdeadbeef',
    txHash: null,
    custodyAuditId: 'audit-1',
    broadcastAt: null,
    confirmedAt: null,
    attempts: 0,
    lastError: null,
  }

  // The raw row is the thing that cannot be sent.
  assert.throws(() => JSON.stringify(signed), TypeError)

  // The view can.
  const wire = JSON.parse(JSON.stringify(resolutionView(signed))) as Record<string, unknown>
  assert.equal(wire['oracleNonce'], '42', 'the nonce crosses as a decimal string')
})

test('the resolution view exposes no part of the signing path', () => {
  // An operator console needs a resolution's STATE, never its transaction bytes or the addresses
  // that produced them.
  const view = resolutionView({
    id: 'a', marketId: 'b', chain: 'hearth', network: 'testnet', action: 1,
    rationale: 'r', state: 'planned', oracleAddress: '0xaaa', oracleNonce: null,
    resolverAddress: '0xbbb', rawTx: '0xdeadbeef', txHash: null, custodyAuditId: 'audit',
    broadcastAt: null, confirmedAt: null, attempts: 0, lastError: null,
  } as Resolution)
  for (const leaked of ['rawTx', 'oracleAddress', 'resolverAddress', 'custodyAuditId']) {
    assert.equal(leaked in view, false, `${leaked} must not reach an operator's browser`)
  }
  assert.equal(JSON.stringify(view).includes('0xdeadbeef'), false)
})
