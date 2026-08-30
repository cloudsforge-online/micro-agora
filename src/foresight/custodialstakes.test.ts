/**
 * The custodial stake, against a real database and a real socket.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FOUR THAT MATTER MOST, and each is proved by mutation rather than by reading:
 *
 *   * **A REFUND RETURNS WHAT WAS TAKEN.** Not today's rate, not a rate re-inverted. The exact
 *     integer on the row, in the asset it arrived in.
 *   * **A RETRY REPLAYS, IT DOES NOT TAKE A SECOND STAKE.** The failure that charges a stranger
 *     twice is a retry after a lost response, and nobody reproduces it by hand.
 *   * **AN UNREADABLE RATE REFUSES.** No row, no ledger entry, no position — a stake priced at a
 *     guess is a guess at how much of somebody's money to take.
 *   * **A LEDGER REFUSAL LEAVES NOTHING BEHIND.** The ledger looked and said no, so the stake did
 *     not happen and its idempotency key must not stay claimed — otherwise the retry replays a
 *     position nobody holds.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { singleNetworkSql } from './server.test.ts'
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Lifecycle } from '@cloudsforge/lifecycle'
import type { Principal, Verifier } from '@cloudsforge/auth'
import { createServer, type ServerDeps } from './server.ts'
import {
  aggregateShares,
  custodialPoolOf,
  custodialPositionOf,
  escrowPostings,
  refundPostings,
  settlementPostings,
  splitPayouts,
  unresolvedStakes,
  type CustodialStake,
} from './custodialstakes.ts'
import { custodialSettleHandler, type JobDeps } from './jobs.ts'
import {
  BTC_USD_SCALED,
  CUSTODIAL,
  EMBER_USD_SCALED,
  db,
  enabled,
  fakeLedger,
  fakePolicy,
  fakePricing,
  fakeSourceProbe,
  migrateTestDb,
  openDb,
  openDirect,
  quietLogger,
  resetForesight,
  seedDraft,
  skip,
  testMetrics,
  type FakeLedger,
  type FakePolicy,
  type FakePricing,
} from './testsupport.ts'

let sql: postgres.Sql
let server: Server
let baseUrl: string
let pricing: FakePricing
let ledger: FakeLedger
let policy: FakePolicy

/** One registry row as the migrations leave it. See `before`. */
interface SeededAsset {
  readonly asset_code: string
  readonly enabled: boolean
  readonly blocked_reason: string | null
}
let seededRegistry: readonly SeededAsset[] = []

const PLAYER_ID = '00000000-0000-4000-8000-000000000002'
const PLAYER: Principal = { kind: 'user', userId: PLAYER_ID, roles: ['player'] } as unknown as Principal
const SUBJECT = `user:${PLAYER_ID}`

const ONE_HUNDREDTH_BTC = '1000000'
const TWO_THOUSAND_FOUR_HUNDRED_EMBER = '2400000000000000000000'

/**
 * The asset that is still OFF, and the one the "disabled" tests are pointed at.
 *
 * Named once because it moved: these tests used LTC, whose blocker is gone (migration 10). USDT
 * on Ethereum is the row whose recorded reason is STILL TRUE — `pricing/src/rates.ts` derives
 * its quoted set from `ON_CHAIN_ASSETS`, which holds `AssetCode`s only, and the live service
 * answers 404 for this urn. A real seeded row rather than a fixture invented for the test, so
 * these assertions exercise the registry the deploy actually creates; and if USDT is ever priced
 * and turned on, this going red is correct — it asks whoever did it to point these at whatever
 * is off then, which is the check LTC never got.
 */
const DISABLED_ASSET = 'TOKEN:eth:mainnet:0xdac17f958d2ee523a2206206994597c13d831ec7'

/** One litecoin, in litoshis. `chainSpec('LTC').decimals` is 8 — not EMBER's 18. */
const ONE_LTC = '100000000'

function fakeVerifier(): Verifier {
  return {
    async principal(token: string) {
      if (token === 'player') return PLAYER
      const { TokenError } = await import('@cloudsforge/auth')
      throw new TokenError('bad token', 'invalid')
    },
  } as unknown as Verifier
}

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE REGISTRY AS THE MIGRATIONS LEAVE IT, READ ONCE, SO `beforeEach` RESTORES RATHER THAN
  // DECIDES.
  //
  // This used to be a typed list — `where asset_code in ('EMBER','BTC','ETH')` — and the moment
  // migration 10 enabled LTC that list would have had to be edited by hand to match. Worse, if
  // it HAD been edited, the registry test below would have been asserting what `beforeEach` just
  // wrote rather than what the migration seeds, and would pass with no migration at all. It did,
  // while this change was being made, which is how the snapshot got written.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  seededRegistry = await sql<SeededAsset[]>`
    select asset_code, enabled, blocked_reason from stake_assets order by asset_code
  `
  assert.ok(seededRegistry.length > 0, 'the migrations seeded no stake assets')
  pricing = fakePricing()
  ledger = fakeLedger()
  policy = fakePolicy()
  const testQueue = new JobQueue(sql as unknown as JobsSql, { owner: 'test', leaseMs: 60_000 })
  const deps: ServerDeps = {
    sql: singleNetworkSql(db(sql)),
    singleNetwork: 'mainnet' as const,
    queue: testQueue,
    // One queue, presented as the per-network selector: the suites run against a single
    // database, so both networks resolve to it. What is under test is that a route ASKS.
    queueFor: () => testQueue,
    verifier: fakeVerifier(),
    lifecycle: new Lifecycle({}),
    logger: quietLogger(),
    metrics: testMetrics(),
    policy,
    sourceProbe: fakeSourceProbe(true),
    producer: 'foresight',
    chain: 'ember',
    network: 'testnet',
    defaultFeeBps: 200,
    defaultDisputeWindowSeconds: 86_400,
    houseAddress: undefined,
    engagementPolicies: null,
    pricing,
    ledger,
    custodialAddress: CUSTODIAL,
    // No public studio address here: this file proves nothing about images, and `undefined` is
    // the supported mode that makes every `image.bytesUrl` null.
    studioPublicUrl: undefined,
  }
  server = createServer(deps)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (!enabled) return
  // `close()` alone waits for every keep-alive socket `fetch` left open, and a run in which some
  // cases did not execute leaves one hanging for ever — the file then dies on "Promise resolution
  // is still pending", which is indistinguishable from a deadlock and was one for twenty minutes
  // while this suite's mutations were being checked. Hanging up first makes the close deterministic.
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetForesight(sql)
  // The registry is REFERENCE DATA seeded by the migrations and is deliberately not truncated. It
  // is restored to the SEEDED state — not to a state typed here — so one test switching an asset
  // off cannot change what the next one is testing, and so nothing in this file can accidentally
  // stand in for the migration it is meant to be checking.
  for (const row of seededRegistry) {
    await sql`update stake_assets
                 set enabled = ${row.enabled}, blocked_reason = ${row.blocked_reason}
               where asset_code = ${row.asset_code}`
  }
  pricing.setUnavailable('BTC', false)
  pricing.setUnavailable('EMBER', false)
  ledger.reset()
  policy.setDown(false)
})

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; key?: string } = {},
): Promise<{ status: number; body: Record<string, never> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.token) headers['authorization'] = `Bearer ${options.token}`
  if (options.key) headers['idempotency-key'] = options.key
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, never> }
}

async function openMarket(): Promise<string> {
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  return market.id
}

/* ------------------------------------------------------------------ the registry */

test('the registry names every asset, and a disabled one says why', { skip }, async () => {
  const response = await call('GET', '/stake-assets')
  assert.equal(response.status, 200)
  assert.equal(response.body['poolAsset'], 'EMBER')
  const assets = response.body['assets'] as unknown as {
    assetCode: string
    decimals: number
    enabled: boolean
    blockedReason: string | null
  }[]
  const byCode = new Map(assets.map((asset) => [asset.assetCode, asset]))

  // The four the owner named, plus the pool asset. USDT is PRESENT and disabled rather than
  // absent: a user holding it is owed "not yet, and here is what is missing".
  for (const code of ['EMBER', 'BTC', 'ETH', 'LTC']) {
    assert.ok(byCode.has(code), `${code} should be nameable`)
  }
  assert.ok([...byCode.keys()].some((code) => code.startsWith('TOKEN:')), 'USDT should be nameable')

  // Decimals are the package's, not a guess. BTC 8, EMBER 18, USDT 6.
  assert.equal(byCode.get('BTC')?.decimals, 8)
  assert.equal(byCode.get('EMBER')?.decimals, 18)
  assert.equal(byCode.get('LTC')?.decimals, 8)
  assert.equal([...byCode.values()].find((a) => a.assetCode.startsWith('TOKEN:'))?.decimals, 6)

  // ── LITECOIN IS ON, AND THIS ASSERTS THE NEW STATE RATHER THAN LEAVING IT UNASSERTED.
  //
  // This used to read `enabled, false` with a reason matching /pricing/. It was correct when it
  // was written and it stopped being correct the moment contracts listed LTC in ON_CHAIN_ASSETS
  // — at which point a green suite was actively DEFENDING a stale refusal. Inverted rather than
  // deleted, because the failure worth catching is not "LTC got turned off again", it is "nobody
  // is watching either way".
  //
  // `blockedReason` must be NULL and not merely falsy: `stake_assets_enabled_has_no_reason`
  // (migration 9) exists so an asset cannot be simultaneously on and carrying an excuse, and a
  // row enabled by hand with its old reason left behind is exactly what that constraint refuses.
  // MUTATION: have migration 10 set `enabled = true` without nulling `blocked_reason` → the
  // migration itself raises 23514 and every database test in this file reddens.
  assert.equal(byCode.get('LTC')?.enabled, true)
  assert.equal(byCode.get('LTC')?.blockedReason, null)

  // A disabled asset still carries its reason, and USDT-on-Ethereum is the row that proves it:
  // pricing quotes AssetCodes and has no route for a TOKEN: urn, verified against the live
  // service — `GET /rates/TOKEN:eth:mainnet:0xdac1…` answers 404 `not_quoted`. That reason is
  // still true, so the row stays off. MUTATION: drop `stake_assets_disabled_has_reason` and seed
  // it with a null reason → this reddens.
  const usdt = [...byCode.values()].find((a) => a.assetCode.startsWith('TOKEN:'))
  assert.equal(usdt?.enabled, false)
  assert.match(usdt?.blockedReason ?? '', /pricing/i)
})

test('a retired asset cannot enter the registry at all', { skip }, async () => {
  // Three enforcements and this is the one that holds against a row inserted by hand.
  // MUTATION: delete `stake_assets_not_retired` → the insert succeeds and this reddens.
  await assert.rejects(
    sql`insert into stake_assets (asset_code, decimals, display_name, enabled)
        values ('SHARD', 0, 'Shards', true)`,
    /stake_assets_not_retired/,
  )
})

/* ------------------------------------------------------------------ the quote */

test('a quote states both amounts, both rates and the sentence', { skip }, async () => {
  const marketId = await openMarket()
  const response = await call('POST', `/markets/${marketId}/stake-quote`, {
    token: 'player',
    body: { asset: 'BTC', amount: ONE_HUNDREDTH_BTC },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body['stakeAsset'], 'BTC')
  assert.equal(response.body['stakeAmount'], ONE_HUNDREDTH_BTC)
  assert.equal(response.body['stakeAmountFormatted'], '0.01')
  assert.equal(response.body['poolAsset'], 'EMBER')
  assert.equal(response.body['poolAmount'], TWO_THOUSAND_FOUR_HUNDRED_EMBER)
  assert.equal(response.body['poolAmountFormatted'], '2400')

  // ── BOTH LEGS, ALWAYS. The cross rate is their quotient, and a response carrying only the
  //    quotient would let an auditor check the division and neither input.
  //    MUTATION: drop `poolRateUsdScaled` from `quoteView` → this reddens.
  assert.equal(response.body['stakeRateUsdScaled'], BTC_USD_SCALED.toString())
  assert.equal(response.body['poolRateUsdScaled'], EMBER_USD_SCALED.toString())
  assert.match(response.body['disclosure'] as unknown as string, /no longer exposed to Bitcoin/)
})

test('a quote in a disabled asset is refused with the reason, not silently priced', { skip }, async () => {
  const marketId = await openMarket()
  // `reads` accumulates across the file, so the claim is "this call added none" and not "none have
  // ever happened" — the second would be vacuous by the time this case runs.
  const readsBefore = pricing.reads.length
  const response = await call('POST', `/markets/${marketId}/stake-quote`, {
    token: 'player',
    body: { asset: DISABLED_ASSET, amount: '1000000' },
  })
  assert.equal(response.status, 409)
  assert.equal(response.body['error']?.['code'], 'asset_disabled')
  // The registry is consulted BEFORE pricing (`server.ts`), so the reader gets the
  // platform's own sentence rather than "the rate board is having a bad minute".
  // MUTATION: move the `!asset.enabled` check below the `stakeRates` call → the read happens and
  // this reddens, even though the status code and the error code are unchanged.
  assert.match(response.body['error']?.['message'] ?? '', /pricing/i)
  assert.equal(pricing.reads.length, readsBefore, 'pricing was called for a refused asset')
})

test('a Litecoin quote prices at eight decimals, not at EMBER’s eighteen', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE POSITIVE HALF OF MIGRATION 10. Enabling an asset is only half of it — the other half is
  // that the amount is read at the asset's OWN scale. LTC is 8 places like BTC and the pool is
  // EMBER's 18, so a quote that reached for the pool's decimals would size this stake by a
  // factor of 10¹⁰ and it would do it silently.
  //
  // 1 LTC at $45 against EMBER at $0.25 is 180 EMBER. MUTATION: make `quoteStake` read
  // `POOL_DECIMALS` instead of the registry row's `decimals` → the answer becomes 0 and this
  // reddens, which is the failure `assertRegistryDecimals` exists for.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  pricing.setRate('LTC', 45_000_000n)
  const marketId = await openMarket()
  const response = await call('POST', `/markets/${marketId}/stake-quote`, {
    token: 'player',
    body: { asset: 'LTC', amount: ONE_LTC },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body['stakeAsset'], 'LTC')
  assert.equal(response.body['stakeDecimals'], 8)
  assert.equal(response.body['stakeAmountFormatted'], '1')
  assert.equal(response.body['poolAmount'], (180n * 10n ** 18n).toString())
  assert.equal(response.body['stakeRateUsdScaled'], '45000000')
  assert.equal(response.body['poolRateUsdScaled'], EMBER_USD_SCALED.toString())
})

/* ------------------------------------------------------------------ taking the stake */

test('a BTC stake records three numbers and escrows an EMBER position', { skip }, async () => {
  const marketId = await openMarket()
  const response = await call('POST', `/markets/${marketId}/stakes`, {
    token: 'player',
    key: 'stake-key-0001',
    body: { asset: 'BTC', amount: ONE_HUNDREDTH_BTC, outcome: 0 },
  })
  assert.equal(response.status, 201)
  const stake = response.body['stake'] as unknown as Record<string, string>
  assert.equal(stake['stakeAsset'], 'BTC')
  assert.equal(stake['stakeAmount'], ONE_HUNDREDTH_BTC)
  assert.equal(stake['poolAmount'], TWO_THOUSAND_FOUR_HUNDRED_EMBER)
  assert.equal(stake['stakeRateUsdScaled'], BTC_USD_SCALED.toString())
  assert.equal(stake['poolRateUsdScaled'], EMBER_USD_SCALED.toString())
  assert.equal(stake['state'], 'accepted')

  // ── THE ROW IS WHAT MAKES IT AUDITABLE. Read it back from the database rather than from the
  //    response, because the response is what the code chose to say and the row is what survives.
  const rows = await sql<{ stake_amount: string; pool_amount: string; s: string; p: string }[]>`
    select stake_amount::text, pool_amount::text,
           stake_rate_usd_scaled::text as s, pool_rate_usd_scaled::text as p
      from custodial_stakes where market_id = ${marketId}
  `
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.stake_amount, ONE_HUNDREDTH_BTC)
  assert.equal(rows[0]?.pool_amount, TWO_THOUSAND_FOUR_HUNDRED_EMBER)
  assert.equal(rows[0]?.s, BTC_USD_SCALED.toString())
  assert.equal(rows[0]?.p, EMBER_USD_SCALED.toString())

  // ── AND THE MONEY MOVED, ONCE, IN THE LEDGER. Four postings, two balanced pairs.
  assert.equal(ledger.entries.length, 1)
  const entry = ledger.entries[0]!
  assert.equal(entry.kind, 'market_escrow')
  const byAsset = new Map<string, bigint>()
  for (const posting of entry.postings) {
    const signed = posting.direction === 'debit' ? posting.amount : -posting.amount
    byAsset.set(posting.assetCode, (byAsset.get(posting.assetCode) ?? 0n) + signed)
  }
  // MUTATION: change one posting's direction → a leg no longer nets to zero and this reddens.
  // The ledger's own balancing trigger is per asset_code, so an entry that balanced only in
  // aggregate would be refused there — this asserts the shape before it ever gets that far.
  assert.equal(byAsset.get('BTC'), 0n)
  assert.equal(byAsset.get('EMBER'), 0n)
})

test('the position is EMBER on both sides, whatever was brought to buy it', { skip }, async () => {
  const marketId = await openMarket()
  await call('POST', `/markets/${marketId}/stakes`, {
    token: 'player',
    key: 'stake-key-0002',
    body: { asset: 'BTC', amount: ONE_HUNDREDTH_BTC, outcome: 0 },
  })
  const response = await call('GET', `/markets/${marketId}/custodial-position`, { token: 'player' })
  assert.equal(response.status, 200)
  // MUTATION: serve `stakeAsset` here instead of the pool asset → this reddens, and the product
  // would be quoting a BTC-denominated position against an EMBER pool, which is an FX guarantee
  // the platform does not hold.
  assert.equal(response.body['asset'], 'EMBER')
  assert.equal(response.body['yes'], TWO_THOUSAND_FOUR_HUNDRED_EMBER)
  assert.equal(response.body['no'], '0')
})

test('a retry with the same key replays and does not take a second stake', { skip }, async () => {
  const marketId = await openMarket()
  const body = { asset: 'BTC', amount: ONE_HUNDREDTH_BTC, outcome: 1 }
  const first = await call('POST', `/markets/${marketId}/stakes`, { token: 'player', key: 'retry-me-0001', body })
  const second = await call('POST', `/markets/${marketId}/stakes`, { token: 'player', key: 'retry-me-0001', body })
  assert.equal(first.status, 201)
  assert.equal(second.status, 200)
  assert.equal(second.body['replayed'], true)

  // One row and ONE ledger entry. MUTATION: drop the `findStakeByKey` short-circuit → the unique
  // index still refuses the second insert, but the caller gets a 500 instead of their stake, and
  // this reddens on the status. Drop the unique index as well and the money moves twice.
  const rows = await sql`select id from custodial_stakes where market_id = ${marketId}`
  assert.equal(rows.length, 1)
  assert.equal(ledger.entries.length, 1)
})

test('two users may send the same idempotency key without seeing each other’s stake', { skip }, async () => {
  // The key is namespaced by subject. MUTATION: drop the `${subject}:` prefix → the second user's
  // request replays the first user's stake and this reddens with a foreign position.
  const marketId = await openMarket()
  await call('POST', `/markets/${marketId}/stakes`, {
    token: 'player',
    key: 'shared-key-0001',
    body: { asset: 'BTC', amount: ONE_HUNDREDTH_BTC, outcome: 0 },
  })
  const rows = await sql<{ idempotency_key: string }[]>`
    select idempotency_key from custodial_stakes where market_id = ${marketId}
  `
  assert.equal(rows[0]?.idempotency_key, `${SUBJECT}:shared-key-0001`)
})

/* ------------------------------------------------------------------ the refusals */

test('an unreadable rate refuses the stake and leaves nothing behind', { skip }, async () => {
  const marketId = await openMarket()
  pricing.setUnavailable('BTC', true)
  const response = await call('POST', `/markets/${marketId}/stakes`, {
    token: 'player',
    key: 'norate-key-0001',
    body: { asset: 'BTC', amount: ONE_HUNDREDTH_BTC, outcome: 0 },
  })
  // MUTATION: catch RateUnavailableError and fall back to a cached or default rate → this reddens.
  // There is no correct default: the alternative to refusing is guessing at how much to take.
  assert.equal(response.status, 503)
  assert.equal(response.body['error']?.['code'], 'rate_unavailable')
  const rows = await sql`select id from custodial_stakes where market_id = ${marketId}`
  assert.equal(rows.length, 0)
  assert.equal(ledger.entries.length, 0)
})

test('the EMBER leg being unreadable refuses too, not just the staked leg', { skip }, async () => {
  // The leg nobody remembers. MUTATION: read only the staked asset's rate and default the pool
  // leg to RATE_SCALE → every BTC stake is priced as if EMBER were a dollar, and this reddens.
  const marketId = await openMarket()
  pricing.setUnavailable('EMBER', true)
  const response = await call('POST', `/markets/${marketId}/stakes`, {
    token: 'player',
    key: 'noember-key-001',
    body: { asset: 'BTC', amount: ONE_HUNDREDTH_BTC, outcome: 0 },
  })
  assert.equal(response.status, 503)
  assert.equal(ledger.entries.length, 0)
})

test('a ledger REFUSAL leaves no row, so the retry is a fresh stake and not a replay', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // An overdraft is this path. The ledger LOOKED and said no, so the stake did not happen — and
  // if the row stayed, its idempotency key would stay claimed and the user's retry would REPLAY
  // a position nobody ever took, in a market they are not in.
  //
  // MUTATION: remove the `delete` in the LedgerRefusedError branch → the row survives, the retry
  // answers 200 with a stake that never happened, and this reddens on both assertions.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const marketId = await openMarket()
  ledger.setRefusal({ status: 422, code: 'insufficient_funds', message: 'not enough BTC' })
  const refused = await call('POST', `/markets/${marketId}/stakes`, {
    token: 'player',
    key: 'poor-key-000001',
    body: { asset: 'BTC', amount: ONE_HUNDREDTH_BTC, outcome: 0 },
  })
  assert.equal(refused.status, 422)
  assert.equal(refused.body['error']?.['code'], 'ledger_insufficient_funds')
  assert.equal((await sql`select id from custodial_stakes where market_id = ${marketId}`).length, 0)

  ledger.setRefusal(null)
  const retry = await call('POST', `/markets/${marketId}/stakes`, {
    token: 'player',
    key: 'poor-key-000001',
    body: { asset: 'BTC', amount: ONE_HUNDREDTH_BTC, outcome: 0 },
  })
  assert.equal(retry.status, 201, 'the retry is a fresh stake, not a replay of one that never was')
})

test('a ledger SILENCE keeps the row, because we do not know whether it posted', { skip }, async () => {
  // The opposite fact from the one above, and it must not share a path. MUTATION: delete on any
  // ledger error rather than only on a refusal → the key is freed while an entry may already have
  // posted, and the retry posts a second one against the same money.
  const marketId = await openMarket()
  ledger.setDown(true)
  const response = await call('POST', `/markets/${marketId}/stakes`, {
    token: 'player',
    key: 'silent-key-0001',
    body: { asset: 'BTC', amount: ONE_HUNDREDTH_BTC, outcome: 0 },
  })
  assert.equal(response.status, 503)
  const rows = await sql<{ state: string; escrow_entry_id: string | null }[]>`
    select state, escrow_entry_id from custodial_stakes where market_id = ${marketId}
  `
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.state, 'accepted')
  assert.equal(rows[0]?.escrow_entry_id, null, 'the state the reconciler can see and finish')
})

test('policy fails closed on a custodial stake exactly as on a wallet stake', { skip }, async () => {
  const marketId = await openMarket()
  policy.setDown(true)
  const response = await call('POST', `/markets/${marketId}/stakes`, {
    token: 'player',
    key: 'policy-key-0001',
    body: { asset: 'BTC', amount: ONE_HUNDREDTH_BTC, outcome: 0 },
  })
  assert.equal(response.status, 503)
  assert.equal(response.body['error']?.['code'], 'policy_unavailable')
  assert.equal(ledger.entries.length, 0)
})

/* ------------------------------------------------------------------ the schema's refusals */

async function insertRaw(
  marketId: string,
  overrides: Record<string, string> = {},
): Promise<void> {
  const row = {
    market_id: `'${marketId}'`,
    subject: `'${SUBJECT}'`,
    outcome: '0',
    stake_asset_code: `'BTC'`,
    stake_amount: `'${ONE_HUNDREDTH_BTC}'`,
    pool_amount: `'${TWO_THOUSAND_FOUR_HUNDRED_EMBER}'`,
    stake_rate_usd_scaled: `'${BTC_USD_SCALED}'`,
    pool_rate_usd_scaled: `'${EMBER_USD_SCALED}'`,
    platform_address: `'${CUSTODIAL}'`,
    idempotency_key: `'raw-${Math.random()}'`,
    ...overrides,
  }
  await sql.unsafe(
    `insert into custodial_stakes (${Object.keys(row).join(', ')}) values (${Object.values(row).join(', ')})`,
  )
}

test('a stake after the close time is unrepresentable, whoever holds the connection', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // The contract refuses a late WALLET stake by itself. A custodial stake never touches the
  // contract at the moment it is taken, so nothing on chain stands between a late request and a
  // user's money — this trigger is that missing refusal, in the place it cannot be edited out.
  //
  // MUTATION: delete the close-time branch of `custodial_stakes_only_while_open` → the insert
  // succeeds and this reddens.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const marketId = await openMarket()
  await sql`update markets set close_time = now() - interval '1 minute' where id = ${marketId}`
  await assert.rejects(insertRaw(marketId), /close time/)
})

test('a stake against a market that is not open is unrepresentable', { skip }, async () => {
  const marketId = await openMarket()
  await sql`update markets set status = 'closed', closed_at = now() where id = ${marketId}`
  await assert.rejects(insertRaw(marketId), /only taken while the market is open/)
})

test('a stake in a disabled asset is refused by the database, not only by the route', { skip }, async () => {
  // The route checks it and gives a readable 409. This is what holds when a future write path
  // forgets to. MUTATION: delete the `asset_enabled` branch of the trigger → this reddens.
  const marketId = await openMarket()
  await assert.rejects(
    insertRaw(marketId, { stake_asset_code: `'${DISABLED_ASSET}'` }),
    /does not currently accept|not an asset/,
  )
})

test('an asset the operator switches off is refused again, without a migration', { skip }, async () => {
  // Migration 10 turned LTC on. The registry is an OPERATOR SWITCH and not a code constant, which
  // is the property that made enabling it an UPDATE rather than a rewrite — so it has to hold in
  // the other direction too, or "turn it off while pricing is broken" would need a release.
  // MUTATION: hard-code `enabled` true for chain assets in `findStakeAsset` → this reddens.
  const marketId = await openMarket()
  await sql`update stake_assets
               set enabled = false, blocked_reason = 'switched off by an operator for this test'
             where asset_code = 'LTC'`
  const response = await call('POST', `/markets/${marketId}/stake-quote`, {
    token: 'player',
    body: { asset: 'LTC', amount: ONE_LTC },
  })
  assert.equal(response.status, 409)
  assert.equal(response.body['error']?.['code'], 'asset_disabled')
  await assert.rejects(
    insertRaw(marketId, { stake_asset_code: `'LTC'` }),
    /does not currently accept|not an asset/,
  )
})

test('zero amounts and zero rates are unrepresentable', { skip }, async () => {
  const marketId = await openMarket()
  await assert.rejects(insertRaw(marketId, { stake_amount: `'0'` }), /custodial_stakes_amounts_positive/)
  await assert.rejects(insertRaw(marketId, { pool_amount: `'0'` }), /custodial_stakes_amounts_positive/)
  await assert.rejects(
    insertRaw(marketId, { stake_rate_usd_scaled: `'0'` }),
    /custodial_stakes_rates_positive/,
  )
  await assert.rejects(
    insertRaw(marketId, { pool_rate_usd_scaled: `'0'` }),
    /custodial_stakes_rates_positive/,
  )
})

test('staking EMBER against a different pool amount is unrepresentable', { skip }, async () => {
  // A spread taken without saying so, made impossible rather than refused by a handler.
  // MUTATION: delete `custodial_stakes_pool_asset_is_identity` → the insert succeeds, and the
  // platform can quietly take a cut on an asset staked against itself.
  const marketId = await openMarket()
  await assert.rejects(
    insertRaw(marketId, {
      stake_asset_code: `'EMBER'`,
      stake_amount: `'${TWO_THOUSAND_FOUR_HUNDRED_EMBER}'`,
      pool_amount: `'1'`,
    }),
    /custodial_stakes_pool_asset_is_identity/,
  )
})

test('a recorded stake is immutable — it is what a refund is paid from', { skip }, async () => {
  const marketId = await openMarket()
  await call('POST', `/markets/${marketId}/stakes`, {
    token: 'player',
    key: 'immutable-00001',
    body: { asset: 'BTC', amount: ONE_HUNDREDTH_BTC, outcome: 0 },
  })
  // MUTATION: delete `custodial_stakes_money_is_immutable` → each of these succeeds, and a path
  // that could edit the amount could restate what a user staked after they staked it.
  await assert.rejects(
    sql`update custodial_stakes set stake_amount = 1 where market_id = ${marketId}`,
    /immutable/,
  )
  await assert.rejects(
    sql`update custodial_stakes set stake_rate_usd_scaled = 1 where market_id = ${marketId}`,
    /immutable/,
  )
  await assert.rejects(
    sql`update custodial_stakes set subject = 'user:00000000-0000-4000-8000-000000000009'
         where market_id = ${marketId}`,
    /immutable/,
  )
})

test('a staked row must name the transaction that put the money in the pool', { skip }, async () => {
  // MUTATION: delete `custodial_stakes_staked_has_evidence` → a row can claim the chain holds the
  // money with nothing to point at, and the reconciler believes it.
  const marketId = await openMarket()
  await insertRaw(marketId)
  await assert.rejects(
    sql`update custodial_stakes set state = 'staked' where market_id = ${marketId}`,
    /custodial_stakes_staked_has_evidence/,
  )
})

/* ------------------------------------------------------------------ the postings themselves */

function stakeFixture(overrides: Partial<CustodialStake> = {}): CustodialStake {
  return {
    id: 'f0000000-0000-4000-8000-000000000001',
    marketId: 'f0000000-0000-4000-8000-000000000002',
    subject: SUBJECT,
    outcome: 0,
    stakeAssetCode: 'BTC',
    stakeAmount: 1_000_000n,
    poolAmount: 2_400_000_000_000_000_000_000n,
    rates: { stakeUsdScaled: BTC_USD_SCALED, poolUsdScaled: EMBER_USD_SCALED },
    platformAddress: CUSTODIAL,
    state: 'accepted',
    escrowEntryId: null,
    settleEntryId: null,
    txHash: null,
    idempotencyKey: 'k',
    createdAt: new Date(),
    stakedAt: null,
    resolvedAt: null,
    ...overrides,
  }
}

test('a refund is the exact reversal of the escrow — same accounts, same integers', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE PROMISE: a void returns 0.01000000 BTC, not "0.01 BTC's worth at today's rate", and not
  // the rate re-inverted (which floors a second time and returns less).
  //
  // MUTATION 1: build the refund from `stakeAmountForPool(...)` instead of the row → the BTC leg
  //             comes back one satoshi short on any amount that did not divide evenly.
  // MUTATION 2: forget to flip a direction → the two lists stop being mirror images and this
  //             reddens on the amount-by-account comparison below.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const stake = stakeFixture()
  const forward = escrowPostings(stake)
  const back = refundPostings(stake)
  assert.equal(back.length, forward.length)

  const key = (p: (typeof forward)[number]): string =>
    `${p.account.subject}|${p.account.assetCode}|${p.account.purpose}`
  const forwardByAccount = new Map(forward.map((p) => [key(p), p]))
  for (const posting of back) {
    const counterpart = forwardByAccount.get(key(posting))
    assert.ok(counterpart, `the refund touches ${key(posting)}, which the escrow did not`)
    assert.equal(posting.amount, counterpart.amount, 'the same integer, both ways')
    assert.notEqual(posting.direction, counterpart.direction, 'and the opposite direction')
  }
  // The user gets back exactly what the row says they staked.
  const btcBack = back.find((p) => p.assetCode === 'BTC' && p.direction === 'credit')
  assert.equal(btcBack?.amount, stake.stakeAmount)
  assert.equal(btcBack?.account.purpose, 'available')
})

test('the pool share lands in ESCROW, never in a balance the user could spend', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // FOUND BY MUTATION, NOT BY READING. Crediting the pool share to `available` instead of
  // `escrow` passed every other test in this file, and it is the defect that lets a user
  // withdraw or re-stake EMBER that is already committed to an open market — the platform would
  // then owe the pool and the user the same money.
  //
  // The two halves have to agree, so both are asserted here: escrow is where the stake goes, and
  // escrow is where settlement takes it from.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const stake = stakeFixture()
  const ember = escrowPostings(stake).filter((p) => p.assetCode === 'EMBER')
  const toUser = ember.find((p) => p.account.subject === SUBJECT)
  assert.equal(toUser?.direction, 'credit')
  assert.equal(toUser?.account.purpose, 'escrow')
  assert.ok(
    !ember.some((p) => p.account.subject === SUBJECT && p.account.purpose === 'available'),
    'nothing about an open stake may touch the spendable balance',
  )

  const spent = settlementPostings(stake, 0n).find((p) => p.account.subject === SUBJECT)
  assert.equal(spent?.direction, 'debit')
  assert.equal(spent?.account.purpose, 'escrow', 'settlement spends the escrow the stake created')

  // And the same for a stake in the pool asset, where there is no clearing leg to hide behind.
  const native = escrowPostings(
    stakeFixture({ stakeAssetCode: 'EMBER', stakeAmount: 5n, poolAmount: 5n }),
  )
  assert.deepEqual(
    native.map((p) => `${p.direction}:${p.account.purpose}`),
    ['debit:available', 'credit:escrow'],
  )
})

test('staking EMBER needs no clearing leg, because there is no conversion to pivot', () => {
  const postings = escrowPostings(
    stakeFixture({ stakeAssetCode: 'EMBER', stakeAmount: 5n, poolAmount: 5n }),
  )
  assert.equal(postings.length, 2)
  assert.ok(postings.every((p) => p.account.subject === SUBJECT))
  assert.ok(postings.every((p) => p.assetCode === 'EMBER'))
})

test('settlement is EMBER on every leg — the staked asset stopped being the user’s at escrow', () => {
  // MUTATION: add a BTC leg back into settlement → the entry no longer balances per asset_code
  // (the ledger's trigger is per asset), and this reddens on the asset set.
  const stake = stakeFixture({ state: 'staked' })
  const payout = 5_000_000_000_000_000_000_000n
  const postings = settlementPostings(stake, payout)
  assert.deepEqual(new Set(postings.map((p) => p.assetCode)), new Set(['EMBER']))
  let net = 0n
  for (const posting of postings) {
    net += posting.direction === 'debit' ? posting.amount : -posting.amount
  }
  assert.equal(net, 0n, 'the EMBER leg nets to zero')
  const credited = postings.find((p) => p.account.subject === SUBJECT && p.direction === 'credit')
  assert.equal(credited?.amount, payout)
  assert.equal(credited?.account.purpose, 'available')
})

test('a loser’s settlement has no payout leg and still balances', () => {
  const postings = settlementPostings(stakeFixture({ state: 'staked' }), 0n)
  assert.equal(postings.length, 2)
  let net = 0n
  for (const posting of postings) {
    net += posting.direction === 'debit' ? posting.amount : -posting.amount
  }
  assert.equal(net, 0n)
})

/* ------------------------------------------------------------------ reconciliation */

test('the aggregate counts only what reached the chain', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // This number is compared against the mirror's view of the platform address's position, and
  // they must be EQUAL. `accepted` is money that has not reached the chain yet and `refunded` is
  // money that never will — counting either makes the reconciliation disagree by design, which is
  // worse than not reconciling at all because it trains an operator to ignore the alarm.
  //
  // MUTATION: widen the `state in (...)` filter to include 'accepted' → this reddens.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const marketId = await openMarket()
  await insertRaw(marketId, { idempotency_key: `'agg-1'` })
  await insertRaw(marketId, { idempotency_key: `'agg-2'` })
  await sql`update custodial_stakes
               set state = 'staked', tx_hash = '0xabc', staked_at = now()
             where idempotency_key = 'agg-1'`

  const shares = await aggregateShares(db(sql), marketId, CUSTODIAL)
  assert.equal(shares.length, 1)
  assert.equal(shares[0]?.outcome, 0)
  assert.equal(shares[0]?.poolAmount, BigInt(TWO_THOUSAND_FOUR_HUNDRED_EMBER))
  assert.equal(shares[0]?.stakeCount, 1)

  // The user's own view counts the accepted one too: their money has left their available balance
  // and they are owed the position, whether or not the broadcast has landed.
  const position = await custodialPositionOf(db(sql), marketId, SUBJECT)
  assert.equal(position.yes, BigInt(TWO_THOUSAND_FOUR_HUNDRED_EMBER) * 2n)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   THE EXIT

   Everything above proves money can get INTO escrow correctly. These prove it can get out, which
   until this change it could not: `markSettled` takes only a `staked` row, `staked` needs a
   transaction hash, and custody refuses to sign the call that would produce one. A user who staked
   was short the money with no path back.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** A stake row, as `splitPayouts` reads one. Only the three fields it touches are real. */
function fakeStake(id: string, outcome: number, poolAmount: bigint): CustodialStake {
  return { id, outcome, poolAmount } as unknown as CustodialStake
}

test('the split pays winners their stake back plus the losers’ money, pro rata', () => {
  // 100 and 300 on YES, 400 on NO. YES wins, so the 400 is divided 1:3.
  const payouts = splitPayouts(
    [fakeStake('a', 0, 100n), fakeStake('b', 0, 300n), fakeStake('c', 1, 400n)],
    0,
  )
  assert.deepEqual(
    payouts.map((p) => [p.stakeId, p.payout.toString()]),
    [
      ['a', '200'], // 100 back + 100 of the 400
      ['b', '600'], // 300 back + 300 of the 400
    ],
  )
  // MUTATION: drop `stake.poolAmount +` from the share → winners get only their winnings and lose
  // their own stake, which is a parimutuel that eats the pool.
  assert.equal(
    payouts.reduce((sum, p) => sum + p.payout, 0n),
    800n,
    'a parimutuel pays out exactly what was staked into it, never more and never less',
  )
})

test('nobody on the winning side means no payouts at all — the caller refunds instead', () => {
  // Not "pay everyone zero". An empty list is how this function says the division is undefined,
  // and `custodialSettleHandler` turns that into a refund in the asset each stake arrived in.
  assert.deepEqual(splitPayouts([fakeStake('a', 1, 100n), fakeStake('b', 1, 50n)], 0), [])
  assert.deepEqual(splitPayouts([], 0), [])
})

test('nobody on the losing side means every winner takes back exactly what they staked', () => {
  const payouts = splitPayouts([fakeStake('a', 0, 100n), fakeStake('b', 0, 50n)], 0)
  assert.deepEqual(
    payouts.map((p) => p.payout.toString()),
    ['100', '50'],
  )
})

test('THE DUST IS PAID OUT, deterministically, and never kept', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 1 + 1 + 1 winning against 2. Each share is 2*1/3 = 0 after flooring, so the floors leave the
  // WHOLE 2 undistributed. A split that stopped at the floor would quietly bank it.
  //
  // The remainder goes out one unit at a time, largest stake first, ties by id — so with three
  // equal stakes it is 'a' then 'b'. MUTATION: delete the remainder loop → this reddens with 3
  // paid against 5 staked, and the missing 2 is in nobody's account.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const stakes = [fakeStake('a', 0, 1n), fakeStake('b', 0, 1n), fakeStake('c', 0, 1n), fakeStake('d', 1, 2n)]
  const payouts = splitPayouts(stakes, 0)
  assert.deepEqual(
    payouts.map((p) => [p.stakeId, p.payout.toString()]),
    [['a', '2'], ['b', '2'], ['c', '1']],
  )
  assert.equal(payouts.reduce((sum, p) => sum + p.payout, 0n), 5n)
})

test('the split does not depend on the order the rows were read in', () => {
  // Two callers reading the same market with different `order by` must pay the same people the
  // same amounts, or the answer depends on the query plan.
  const stakes = [fakeStake('a', 0, 5n), fakeStake('b', 0, 3n), fakeStake('c', 0, 1n), fakeStake('d', 1, 4n)]
  const forward = splitPayouts(stakes, 0)
  const backward = splitPayouts([...stakes].reverse(), 0)
  const asMap = (rows: readonly { stakeId: string; payout: bigint }[]) =>
    Object.fromEntries(rows.map((r) => [r.stakeId, r.payout.toString()]))
  assert.deepEqual(asMap(forward), asMap(backward))
})

/* ------------------------------------------------------------------ the job, end to end */

/** Only the fields `custodialSettleHandler` reads are real; the rest would be a world to build. */
function settleDeps(): JobDeps {
  return {
    sql: db(sql),
    producer: 'foresight',
    logger: quietLogger(),
    metrics: testMetrics(),
    ledger,
    now: () => new Date(),
  } as unknown as JobDeps
}

const RUN = { heartbeat: async () => {} } as unknown as Parameters<ReturnType<typeof custodialSettleHandler>>[1]

async function stake(marketId: string, outcome: number, key: string, amount = ONE_HUNDREDTH_BTC) {
  const response = await call('POST', `/markets/${marketId}/stakes`, {
    token: 'player',
    key,
    body: { asset: 'BTC', amount, outcome },
  })
  assert.equal(response.status, 201, JSON.stringify(response.body))
}

test('a resolved market pays the custodial pool out, and escrow is empty afterwards', { skip }, async () => {
  const marketId = await openMarket()
  await stake(marketId, 0, 'settle-0001')
  await stake(marketId, 1, 'settle-0002')
  await sql`update markets set status = 'resolved', outcome = 0, resolved_at = now() where id = ${marketId}`

  ledger.reset()
  await custodialSettleHandler(settleDeps())({ key: 'global', payload: {} } as never, RUN)

  const rows = await sql<{ outcome: number; state: string }[]>`
    select outcome, state from custodial_stakes where market_id = ${marketId} order by outcome
  `
  // Both rows terminate. The LOSER'S row matters as much as the winner's: its escrowed EMBER has
  // to leave, or the pool it was paid out of never balances and the loser is short for ever.
  assert.deepEqual(rows.map((r) => r.state), ['paid', 'paid'])

  // Two entries, both `market_settled` — a kind from the ledger's closed vocabulary. MUTATION:
  // invent `market_settlement` → the real ledger 400s and every payout stops, which is the defect
  // that silently killed `item_issue` for a month.
  assert.equal(ledger.entries.length, 2)
  for (const entry of ledger.entries) assert.equal(entry.kind, 'market_settled')

  // The winner was paid both stakes' worth; the loser was paid nothing but still spent escrow.
  const net = new Map<string, bigint>()
  for (const entry of ledger.entries) {
    for (const posting of entry.postings) {
      const signed = posting.direction === 'credit' ? posting.amount : -posting.amount
      const account = posting.account as unknown as { purpose?: string }
      const name = account.purpose ?? 'clearing'
      net.set(name, (net.get(name) ?? 0n) + signed)
    }
  }
  const staked = 2n * BigInt(TWO_THOUSAND_FOUR_HUNDRED_EMBER)
  assert.equal(net.get('escrow'), -staked, 'every last unit of escrow must be spent')
  assert.equal(net.get('available'), staked, 'and every last unit of it paid out')

  assert.deepEqual(await unresolvedStakes(db(sql), marketId), [])
})

test('a void market refunds every custodial stake in the asset it arrived in', { skip }, async () => {
  const marketId = await openMarket()
  await stake(marketId, 0, 'void-0001')
  await sql`update markets set status = 'void', void_reason = 'the source went dark', voided_at = now()
             where id = ${marketId}`

  ledger.reset()
  await custodialSettleHandler(settleDeps())({ key: 'global', payload: {} } as never, RUN)

  const rows = await sql<{ state: string; tx_hash: string | null }[]>`
    select state, tx_hash from custodial_stakes where market_id = ${marketId}
  `
  assert.equal(rows[0]?.state, 'refunded')
  assert.equal(rows[0]?.tx_hash, null)
  // BTC BACK, NOT EMBER. The user brought bitcoin and a void is not a moment to hand them an
  // EMBER position they never asked for — `refundPostings` reverses both legs of the conversion.
  const entry = ledger.entries[0]!
  assert.ok(entry.postings.some((p) => p.assetCode === 'BTC' && p.direction === 'credit'))
})

test('a resolution nobody won refunds rather than paying zero to everybody', { skip }, async () => {
  const marketId = await openMarket()
  await stake(marketId, 0, 'nowin-0001')
  await sql`update markets set status = 'resolved', outcome = 1, resolved_at = now() where id = ${marketId}`

  ledger.reset()
  await custodialSettleHandler(settleDeps())({ key: 'global', payload: {} } as never, RUN)

  // The only staker backed YES and NO won — but there was nobody on NO to divide their money
  // between. Paying zero would keep it; the platform is not a counterparty here and never wins.
  const rows = await sql<{ state: string }[]>`select state from custodial_stakes where market_id = ${marketId}`
  assert.equal(rows[0]?.state, 'refunded')
  assert.ok(ledger.entries[0]!.postings.some((p) => p.assetCode === 'BTC' && p.direction === 'credit'))
})

test('THE CONSTRAINT: a second pass pays nobody twice', { skip }, async () => {
  const marketId = await openMarket()
  await stake(marketId, 0, 'twice-0001')
  await stake(marketId, 1, 'twice-0002')
  await sql`update markets set status = 'resolved', outcome = 0, resolved_at = now() where id = ${marketId}`

  ledger.reset()
  const handler = custodialSettleHandler(settleDeps())
  await handler({ key: 'global', payload: {} } as never, RUN)
  const afterFirst = ledger.entries.length
  await handler({ key: 'global', payload: {} } as never, RUN)

  // The second pass finds nothing: `marketsAwaitingCustodialSettlement` reads `accepted` only, and
  // both rows are `paid`. MUTATION: widen that query to every state → this reddens with four
  // entries, and the winner has been paid the pool twice out of money that does not exist.
  assert.equal(ledger.entries.length, afterFirst)
})

test('an unfinished market is left alone, however much is escrowed against it', { skip }, async () => {
  const marketId = await openMarket()
  await stake(marketId, 0, 'open-0001')

  ledger.reset()
  await custodialSettleHandler(settleDeps())({ key: 'global', payload: {} } as never, RUN)
  assert.equal(ledger.entries.length, 0)
  const rows = await sql<{ state: string }[]>`select state from custodial_stakes where market_id = ${marketId}`
  assert.equal(rows[0]?.state, 'accepted')
})

test('a ledger that is down defers the whole market rather than half-settling it', { skip }, async () => {
  const marketId = await openMarket()
  await stake(marketId, 0, 'down-0001')
  await stake(marketId, 1, 'down-0002')
  await sql`update markets set status = 'resolved', outcome = 0, resolved_at = now() where id = ${marketId}`

  ledger.reset()
  ledger.setDown(true)
  // It does NOT throw. Throwing would spend this job's attempt budget on an outage and dead-letter
  // the only thing that can release escrow — see the handler's header.
  await custodialSettleHandler(settleDeps())({ key: 'global', payload: {} } as never, RUN)
  const stuck = await sql<{ state: string }[]>`select state from custodial_stakes where market_id = ${marketId}`
  assert.deepEqual(stuck.map((r) => r.state), ['accepted', 'accepted'])

  ledger.setDown(false)
  await custodialSettleHandler(settleDeps())({ key: 'global', payload: {} } as never, RUN)
  const done = await sql<{ state: string }[]>`select state from custodial_stakes where market_id = ${marketId}`
  assert.deepEqual(done.map((r) => r.state), ['paid', 'paid'])
})

test('the platform pool is reported separately from the contract’s, and counts paid stakes', { skip }, async () => {
  const marketId = await openMarket()
  await stake(marketId, 0, 'pool-0001')
  await stake(marketId, 1, 'pool-0002')

  const before = await custodialPoolOf(db(sql), marketId)
  assert.equal(before.yes.toString(), TWO_THOUSAND_FOUR_HUNDRED_EMBER)
  assert.equal(before.no.toString(), TWO_THOUSAND_FOUR_HUNDRED_EMBER)
  assert.equal(before.stakers, 1)

  await sql`update markets set status = 'resolved', outcome = 0, resolved_at = now() where id = ${marketId}`
  await custodialSettleHandler(settleDeps())({ key: 'global', payload: {} } as never, RUN)

  // Still readable after settlement. `paid` counts and `refunded` does not: one is money that took
  // a side, the other is money that was handed back — and the odds a page quotes are about the first.
  const after = await custodialPoolOf(db(sql), marketId)
  assert.equal(after.yes.toString(), TWO_THOUSAND_FOUR_HUNDRED_EMBER)
  assert.equal(after.no.toString(), TWO_THOUSAND_FOUR_HUNDRED_EMBER)
})
