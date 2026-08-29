/**
 * The house seed — docs/ecosystem/21 §5 — proven the way §7 demands: at the SCHEMA first, with
 * raw SQL and a bare connection, and then through the routes.
 *
 *   §7.1  A house stake after market open is unrepresentable — trigger, fire-tested.
 *   §7.2  A lopsided seed refuses at the schema.
 *   §7.3  Per-market and per-day seed ceilings are CHECK/trigger facts; the operator caps below
 *         them bind at approval time against admin-api's policy, fail closed.
 *   §7.6  The market page serves the house-seed disclosure whenever a house stake exists —
 *         asserted with force, sentence and all.
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
import { SEED_PER_DAY_CEILING_WEI, SEED_PER_MARKET_CEILING_WEI, houseSeedView } from './houseseed.ts'
import {
  HOUSE,
  approveDirect,
  db,
  enabled,
  fakePolicy,
  fakeSeedPolicy,
  fakeSourceProbe,
  migrateTestDb,
  mirrorHouseStake,
  openDb,
  openDirect,
  quietLogger,
  resetForesight,
  seedDraft,
  skip,
  testMetrics,
  type FakeSeedPolicyClient,
  fakeLedger,
  fakePricing,
} from './testsupport.ts'

let sql: postgres.Sql
let server: Server
let bare: Server
let baseUrl: string
let bareUrl: string
let seedPolicy: FakeSeedPolicyClient

const ADMIN: Principal = {
  kind: 'user',
  userId: '00000000-0000-4000-8000-000000000001',
  roles: ['admin'],
} as unknown as Principal

function fakeVerifier(): Verifier {
  return {
    async principal(token: string) {
      if (token === 'admin') return ADMIN
      const { TokenError } = await import('@cloudsforge/auth')
      throw new TokenError('bad token', 'invalid')
    },
  } as unknown as Verifier
}

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
  seedPolicy = fakeSeedPolicy()
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
    policy: fakePolicy(),
    sourceProbe: fakeSourceProbe(true),
    producer: 'foresight',
    chain: 'ember',
    network: 'testnet',
    defaultFeeBps: 200,
    defaultDisputeWindowSeconds: 86_400,
    houseAddress: HOUSE,
    pricing: fakePricing(),
    ledger: fakeLedger(),
    custodialAddress: undefined,
    engagementPolicies: seedPolicy,
    // No public studio address here: this file proves nothing about images, and `undefined` is
    // the supported mode that makes every `image.bytesUrl` null.
    studioPublicUrl: undefined,
  }
  server = createServer(deps)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // The UNCONFIGURED deployment — no house address, no admin-api. Its whole suite is one fact:
  // approving with a seed refuses plainly, and nothing else changes.
  bare = createServer({ ...deps, houseAddress: undefined, engagementPolicies: null })
  await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', () => resolve()))
  bareUrl = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`
})

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => bare.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetForesight(sql)
  seedPolicy.setDown(false)
  seedPolicy.setPolicy({ perMarketWei: 2_000_000_000_000_000_000n, perDayWei: 3_000_000_000_000_000_000n })
})

async function call(
  url: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.token) headers['authorization'] = `Bearer ${options.token}`
  const response = await fetch(`${url}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  return { status: response.status, body: (await response.json()) as any }
}

const ONE_EMBER = 1_000_000_000_000_000_000n

/* ══════════════════════════════════════════════════════ §7.1 — after open, unrepresentable */

test('FIRE TEST: a house seed against an OPEN market is unrepresentable, connection in hand', { skip }, async () => {
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  await assert.rejects(
    sql`
      insert into house_seeds (market_id, house_address, amount_yes_wei, amount_no_wei)
      values (${market.id}, ${HOUSE.toLowerCase()}, 1, 1)
    `,
    /unrepresentable/,
  )
})

test('FIRE TEST: a seed can only be planned against an APPROVED market — a draft refuses too', { skip }, async () => {
  const market = await seedDraft(sql)
  await assert.rejects(
    sql`
      insert into house_seeds (market_id, house_address, amount_yes_wei, amount_no_wei)
      values (${market.id}, ${HOUSE.toLowerCase()}, 1, 1)
    `,
    /approval/,
  )
  await approveDirect(sql, market.id)
  await sql`
    insert into house_seeds (market_id, house_address, amount_yes_wei, amount_no_wei)
    values (${market.id}, ${HOUSE.toLowerCase()}, 1, 1)
  `
})

test('FIRE TEST: the staked transition demands the market open and the EXACT open timestamp', { skip }, async () => {
  const market = await seedDraft(sql)
  await approveDirect(sql, market.id)
  await sql`
    insert into house_seeds (market_id, house_address, amount_yes_wei, amount_no_wei)
    values (${market.id}, ${HOUSE.toLowerCase()}, 5, 5)
  `
  // Not open yet: the transition refuses whatever timestamp it claims.
  await assert.rejects(
    sql`
      update house_seeds
         set state = 'staked', staked_at = now(), tx_hash_yes = '0xaa', tx_hash_no = '0xbb'
       where market_id = ${market.id}
    `,
    /opens the market/,
  )
  await openDirect(sql, market.id)
  // Open, but carrying a FORGED timestamp: refused. "Carries the market's open timestamp" is
  // equality, not proximity (21 §5).
  await assert.rejects(
    sql`
      update house_seeds
         set state = 'staked', staked_at = now() + interval '1 minute',
             tx_hash_yes = '0xaa', tx_hash_no = '0xbb'
       where market_id = ${market.id}
    `,
    /open timestamp/,
  )
  // The exact opened_at: accepted — and from here the row is immutable.
  await sql`
    update house_seeds
       set state = 'staked',
           staked_at = (select opened_at from markets where id = ${market.id}),
           tx_hash_yes = '0xaa', tx_hash_no = '0xbb'
     where market_id = ${market.id}
  `
  await assert.rejects(
    sql`update house_seeds set amount_yes_wei = 6, amount_no_wei = 6 where market_id = ${market.id}`,
    /immutable/,
  )
})

/* ══════════════════════════════════════════════════════ §7.2 — symmetric by the schema */

test('FIRE TEST: a lopsided seed refuses at the schema — the house expresses no opinion', { skip }, async () => {
  const market = await seedDraft(sql)
  await approveDirect(sql, market.id)
  await assert.rejects(
    sql`
      insert into house_seeds (market_id, house_address, amount_yes_wei, amount_no_wei)
      values (${market.id}, ${HOUSE.toLowerCase()}, 2, 1)
    `,
    /house_seeds_symmetric/,
  )
})

test('FIRE TEST: a half-recorded stake cannot exist — hashes, timestamp and state move together', { skip }, async () => {
  const market = await seedDraft(sql)
  await approveDirect(sql, market.id)
  await sql`
    insert into house_seeds (market_id, house_address, amount_yes_wei, amount_no_wei)
    values (${market.id}, ${HOUSE.toLowerCase()}, 5, 5)
  `
  await assert.rejects(
    sql`update house_seeds set tx_hash_yes = '0xaa' where market_id = ${market.id}`,
    /house_seeds_staked_is_complete/,
  )
})

/* ══════════════════════════════════════════════════════ §7.3 — the ceilings */

test('FIRE TEST: the per-market ceiling refuses ceiling-plus-one wei', { skip }, async () => {
  const market = await seedDraft(sql)
  await approveDirect(sql, market.id)
  const over = (SEED_PER_MARKET_CEILING_WEI + 1n).toString()
  await assert.rejects(
    sql`
      insert into house_seeds (market_id, house_address, amount_yes_wei, amount_no_wei)
      values (${market.id}, ${HOUSE.toLowerCase()}, ${over}, ${over})
    `,
    /house_seeds_within_market_ceiling/,
  )
})

test('FIRE TEST: the per-day ceiling refuses the seed that would breach it', { skip }, async () => {
  // Ten markets at the per-market ceiling exactly fill the day's per-side ceiling; the eleventh
  // seed — of one wei — must refuse. The numbers are the constraint's own: 10 × 10^21 = 10^22.
  assert.equal(SEED_PER_MARKET_CEILING_WEI * 10n, SEED_PER_DAY_CEILING_WEI)
  const cap = SEED_PER_MARKET_CEILING_WEI.toString()
  for (let i = 0; i < 10; i += 1) {
    const market = await seedDraft(sql)
    await approveDirect(sql, market.id)
    await sql`
      insert into house_seeds (market_id, house_address, amount_yes_wei, amount_no_wei)
      values (${market.id}, ${HOUSE.toLowerCase()}, ${cap}, ${cap})
    `
  }
  const eleventh = await seedDraft(sql)
  await approveDirect(sql, eleventh.id)
  await assert.rejects(
    sql`
      insert into house_seeds (market_id, house_address, amount_yes_wei, amount_no_wei)
      values (${eleventh.id}, ${HOUSE.toLowerCase()}, 1, 1)
    `,
    /per-side ceiling/,
  )
})

/* ══════════════════════════════════════════════════════ approval: the operator caps, fail closed */

test('an approval carrying a seed plans it inside the policy caps', { skip }, async () => {
  const market = await seedDraft(sql)
  const res = await call(baseUrl, 'POST', `/markets/${market.id}/approve`, {
    token: 'admin',
    body: { houseSeedPerOutcomeWei: ONE_EMBER.toString() },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.houseSeed.state, 'planned')
  assert.equal(res.body.houseSeed.amountPerOutcomeWei, ONE_EMBER.toString())
  assert.equal(res.body.houseSeed.houseAddress, HOUSE.toLowerCase())
  assert.equal(seedPolicy.reads, 1)
})

test('a seed above the policy per-market size refuses at approval; the day cap counts the day', { skip }, async () => {
  const first = await seedDraft(sql)
  const over = await call(baseUrl, 'POST', `/markets/${first.id}/approve`, {
    token: 'admin',
    body: { houseSeedPerOutcomeWei: (2_000_000_000_000_000_001n).toString() },
  })
  assert.equal(over.status, 409)
  assert.equal(over.body.error.code, 'seed_above_policy')

  // Two 2-EMBER seeds against a 3-EMBER day: the first plans, the second refuses.
  const ok = await call(baseUrl, 'POST', `/markets/${first.id}/approve`, {
    token: 'admin',
    body: { houseSeedPerOutcomeWei: (2n * ONE_EMBER).toString() },
  })
  assert.equal(ok.status, 200)
  const second = await seedDraft(sql)
  const daily = await call(baseUrl, 'POST', `/markets/${second.id}/approve`, {
    token: 'admin',
    body: { houseSeedPerOutcomeWei: (2n * ONE_EMBER).toString() },
  })
  assert.equal(daily.status, 409)
  assert.equal(daily.body.error.code, 'seed_daily_cap')
})

test('FAIL CLOSED: an unreachable admin-api refuses the seed and leaves plain approval alone', { skip }, async () => {
  seedPolicy.setDown(true)
  const seeded = await seedDraft(sql)
  const refused = await call(baseUrl, 'POST', `/markets/${seeded.id}/approve`, {
    token: 'admin',
    body: { houseSeedPerOutcomeWei: ONE_EMBER.toString() },
  })
  assert.equal(refused.status, 503)
  assert.equal(refused.body.error.code, 'seed_policy_unavailable')

  // The refusal rolled everything back: the market is still a draft and can be approved plainly,
  // admin-api down or not — an unreachable operator surface must not stop ordinary markets.
  const plain = await call(baseUrl, 'POST', `/markets/${seeded.id}/approve`, { token: 'admin', body: {} })
  assert.equal(plain.status, 200)
  assert.equal(plain.body.houseSeed, null)
})

test('no seed sizes raised in admin-api means no seed — 21 §8, the caps exist first', { skip }, async () => {
  seedPolicy.setPolicy(null)
  const market = await seedDraft(sql)
  const res = await call(baseUrl, 'POST', `/markets/${market.id}/approve`, {
    token: 'admin',
    body: { houseSeedPerOutcomeWei: ONE_EMBER.toString() },
  })
  assert.equal(res.status, 409)
  assert.equal(res.body.error.code, 'no_seed_policy')
})

test('an unconfigured deployment refuses a seed plainly and approves everything else', { skip }, async () => {
  const market = await seedDraft(sql)
  const refused = await call(bareUrl, 'POST', `/markets/${market.id}/approve`, {
    token: 'admin',
    body: { houseSeedPerOutcomeWei: ONE_EMBER.toString() },
  })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'house_address_unconfigured')
  const plain = await call(bareUrl, 'POST', `/markets/${market.id}/approve`, { token: 'admin', body: {} })
  assert.equal(plain.status, 200)
})

/* ══════════════════════════════════════════════════════ open: the money first, then the status */

/** Deploy columns without opening, so the open ROUTE is what is under test. */
async function deployDirect(marketId: string): Promise<void> {
  const seed = marketId.replace(/-/g, '')
  await sql`
    update markets
       set deploy_state = 'deployed', deployer_address = ${'0x' + (seed.slice(8) + seed.slice(0, 8)).padEnd(40, 'f')},
           contract_address = ${'0x' + seed.padEnd(40, '0')}, deploy_nonce = 0,
           raw_tx = '0xdead', deploy_tx_hash = ${'0x' + seed.repeat(2).slice(0, 64)}
     where id = ${marketId}
  `
}

test('a seeded market cannot open until the mirror shows the exact symmetric house position', { skip }, async () => {
  const market = await seedDraft(sql)
  const approved = await call(baseUrl, 'POST', `/markets/${market.id}/approve`, {
    token: 'admin',
    body: { houseSeedPerOutcomeWei: ONE_EMBER.toString() },
  })
  assert.equal(approved.status, 200)
  await deployDirect(market.id)

  // Nothing staked: refused, and the refusal names what was observed.
  const unstaked = await call(baseUrl, 'POST', `/markets/${market.id}/open`, { token: 'admin', body: {} })
  assert.equal(unstaked.status, 409)
  assert.equal(unstaked.body.error.code, 'house_seed_not_staked')

  // A lopsided on-chain position — only YES staked: still refused. Symmetry is checked against
  // the pool, not assumed from the plan.
  await sql`
    insert into positions (market_id, staker, outcome, amount, tx_hash, log_index, block_height, block_hash)
    values (${market.id}, ${HOUSE.toLowerCase()}, 0, ${ONE_EMBER.toString()}, ${'0xcc' + market.id.replace(/-/g, '').repeat(2).slice(0, 60)}, 0, 9, '0xblock9')
  `
  const lopsided = await call(baseUrl, 'POST', `/markets/${market.id}/open`, { token: 'admin', body: {} })
  assert.equal(lopsided.status, 409)
  assert.equal(lopsided.body.error.code, 'house_seed_not_staked')

  // And the refused opens really rolled back: the market is still approved.
  const current = await sql`select status from markets where id = ${market.id}`
  assert.equal(current[0]?.['status'], 'approved')

  // Complete the symmetric position and open: the stake is recorded with the open timestamp.
  await sql`
    insert into positions (market_id, staker, outcome, amount, tx_hash, log_index, block_height, block_hash)
    values (${market.id}, ${HOUSE.toLowerCase()}, 1, ${ONE_EMBER.toString()}, ${'0xdd' + market.id.replace(/-/g, '').repeat(2).slice(0, 60)}, 1, 9, '0xblock9')
  `
  const opened = await call(baseUrl, 'POST', `/markets/${market.id}/open`, { token: 'admin', body: {} })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.houseSeed.state, 'staked')
  assert.equal(opened.body.houseSeed.stakedAt, opened.body.market.openedAt)
  assert.ok(opened.body.houseSeed.txHashYes)
  assert.ok(opened.body.houseSeed.txHashNo)
})

test('an unseeded market opens exactly as before — the seed machinery is invisible to it', { skip }, async () => {
  const market = await seedDraft(sql)
  await call(baseUrl, 'POST', `/markets/${market.id}/approve`, { token: 'admin', body: {} })
  await deployDirect(market.id)
  const opened = await call(baseUrl, 'POST', `/markets/${market.id}/open`, { token: 'admin', body: {} })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.houseSeed, null)
})

/* ══════════════════════════════════════════════════════ §7.6 — the disclosure, with force */

test('THE MARKET PAGE SERVES THE DISCLOSURE WHENEVER A HOUSE STAKE EXISTS — presence, with force', { skip }, async () => {
  const market = await seedDraft(sql)
  await call(baseUrl, 'POST', `/markets/${market.id}/approve`, {
    token: 'admin',
    body: { houseSeedPerOutcomeWei: ONE_EMBER.toString() },
  })
  await deployDirect(market.id)
  await mirrorHouseStake(sql, market.id, ONE_EMBER)
  const opened = await call(baseUrl, 'POST', `/markets/${market.id}/open`, { token: 'admin', body: {} })
  assert.equal(opened.status, 200)

  const page = await call(baseUrl, 'GET', `/markets/${market.id}`)
  assert.equal(page.status, 200)
  // PRESENCE WITH FORCE. Not "if present, then shaped" — present, or this test fails the build.
  const disclosure = page.body.houseSeed
  assert.ok(disclosure, 'the market page must carry the house seed whenever a house stake exists (21 §7.6)')
  assert.equal(disclosure.state, 'staked')
  assert.equal(disclosure.asset, 'EMBER')
  assert.equal(disclosure.totalWei, (2n * ONE_EMBER).toString())
  assert.equal(
    disclosure.disclosure,
    'CloudsForge seeded this pool with 2 EMBER so early odds exist.',
    'the sentence is composed by the platform, once, and served verbatim (21 §5)',
  )
  assert.equal(disclosure.houseAddress, HOUSE.toLowerCase())
  assert.ok(disclosure.txHashYes && disclosure.txHashNo, 'the disclosure carries its on-chain evidence')

  // And an unseeded market's page carries the explicit null, so a client can tell "no seed"
  // from "field missing because the deploy is old".
  const other = await seedDraft(sql)
  const otherPage = await call(baseUrl, 'GET', `/markets/${other.id}`)
  assert.equal(otherPage.body.houseSeed, null)
})

/* ══════════════════════════════════════════════════════ the sentence's arithmetic */

test('the disclosure formats wei honestly — no floats anywhere near the amount', { skip: false }, () => {
  const view = houseSeedView({
    marketId: 'm',
    houseAddress: HOUSE.toLowerCase(),
    amountYesWei: 1_750_000_000_000_000_000n,
    amountNoWei: 1_750_000_000_000_000_000n,
    state: 'staked',
    stakedAt: new Date('2026-08-02T00:00:00Z'),
    txHashYes: '0xaa',
    txHashNo: '0xbb',
    createdAt: new Date('2026-08-01T00:00:00Z'),
  })
  assert.equal(view['totalWei'], '3500000000000000000')
  assert.equal(
    view['disclosure'],
    'CloudsForge seeded this pool with 3.5 EMBER so early odds exist.',
  )
})
