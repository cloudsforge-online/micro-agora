/**
 * The HTTP surface.
 *
 * The auth tests carry the weight: the rate board is public on purpose, and the two operator
 * surfaces are not. Getting that boundary backwards would either break the sign-in page that
 * shows what a deposit is worth, or let anyone read which operator set the EMBER price.
 */

import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { TokenError, VerifierUnavailableError, type Principal } from '@cloudsforge/auth'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { createServer, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { recordAccepted, recordFailure } from './quotes.ts'
import { QUOTED_ASSETS, isQuotedAsset, parseScaled } from './rates.ts'
import { enabled, migrateTestDb, openDb, resetPricing, skip } from './testsupport.ts'
import type { Db } from './outbox.ts'

/**
 * A verifier keyed on the token text, so a test names the authority it wants.
 *
 * An interface rather than a real `Verifier`, so these tests need no JWKS endpoint and no signing
 * key — the mapping from auth fault to status is what is under test, not jose.
 */
const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    switch (token) {
      case 'svc-admin':
        return { kind: 'service', service: 'ops-runbook', scopes: ['pricing:admin'] }
      case 'svc-read':
        return { kind: 'service', service: 'reporting', scopes: ['pricing:read'] }
      case 'svc-none':
        return { kind: 'service', service: 'nosy', scopes: ['other:read'] }
      case 'admin':
        return { kind: 'user', userId: 'u-1', handle: 'ops-jane', roles: ['admin'] }
      case 'player':
        return { kind: 'user', userId: 'u-2', handle: 'bob', roles: ['player'] }
      case 'down':
        throw new VerifierUnavailableError('jwks unreachable')
      default:
        throw new TokenError('bad signature', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED')
    }
  },
}

let sql: postgres.Sql
let db: Db
let server: Server
let baseUrl: string

before(async () => {
  if (!enabled) return
  sql = openDb(8)
  db = sql as unknown as Db
  await migrateTestDb(sql)

  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 })
  const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
  server = createServer({
    lifecycle,
    logger: new Logger({ service: 'pricing-test', level: 'fatal', sink: () => {} }),
    metrics,
    verifier,
    sql: singleNetworkSql(db),
    singleNetwork: 'mainnet' as const,
    rateOptions: { maxAgeSeconds: 300, conversionSpreadBps: 100 },
  })
  await new Promise<void>((resolve) => server.listen(0, () => resolve()))
  lifecycle.markReady()
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetPricing(sql)
})

interface Response {
  readonly status: number
  readonly body: Record<string, never>
  readonly text: string
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  const text = await response.text()
  let body: Record<string, never> = {} as Record<string, never>
  try {
    body = JSON.parse(text) as Record<string, never>
  } catch {
    /* /metrics is Prometheus text, not JSON */
  }
  return { status: response.status, body, text }
}

async function quoteBtc(usd = '64000', ageSeconds = 5): Promise<void> {
  await recordAccepted(db, {
    asset: 'BTC',
    usdScaled: parseScaled(usd)!,
    sourceCount: 4,
    divergenceBps: 11n,
    observedAt: new Date(Date.now() - ageSeconds * 1000),
  })
}

/* ------------------------------------------------------------------ health */

test('the three required endpoints answer', { skip }, async () => {
  assert.equal((await call('GET', '/livez')).status, 200)
  assert.equal((await call('GET', '/readyz')).status, 200)
  const metrics = await call('GET', '/metrics')
  assert.equal(metrics.status, 200)
  assert.match(metrics.text, /pricing_round_total/)
  assert.match(metrics.text, /pricing_rate_age_seconds/)
  assert.match(metrics.text, /pricing_divergence_bps/)
  assert.match(metrics.text, /pricing_sources_ok/)
})

/* ------------------------------------------------------------------ the rate board */

test('GET /rates is public and lists every asset, usable or not', { skip }, async () => {
  await quoteBtc()
  const response = await call('GET', '/rates')
  assert.equal(response.status, 200)

  const rates = (response.body as unknown as { rates: Array<Record<string, unknown>> }).rates
  const assets = rates.map((r) => r['asset'])
  // DERIVED. This read `['BTC', 'ETH', 'SOL', 'XRP', 'EMBER']` and was the last hand-typed asset
  // list in this repository — it survived the LTC release right up to the point a database was
  // attached, because it is gated on PRICING_TEST_DATABASE_URL and SKIPS without one. A pinned list
  // inside a test that does not run by default is the worst combination of the two: it fails only
  // in the environment that is hardest to reproduce, and it is silent everywhere else.
  //
  // Market assets first, then administered — the board's own order, which `QUOTED_ASSETS` is.
  assert.deepEqual(assets, [...QUOTED_ASSETS])

  const btc = rates.find((r) => r['asset'] === 'BTC')
  assert.equal(btc?.['usable'], true)
  assert.equal(btc?.['usd'], '64000')
  assert.equal(btc?.['sourceCount'], 4)
  // Omitting an unusable asset would make a client that iterates the board forget the asset
  // exists, which is how a deposit page silently loses a coin.
  assert.equal(rates.find((r) => r['asset'] === 'SOL')?.['usable'], false)
})

test('EVERY decimal on the wire is a string — never a JSON number', { skip }, async () => {
  await quoteBtc()
  const response = await call('GET', '/rates/BTC')
  const rate = (response.body as unknown as { rate: Record<string, unknown> }).rate
  for (const field of [
    'usd',
    'usdScaled',
    'usdSell',
    'usdSellScaled',
    'usdBuy',
    'usdBuyScaled',
    'shardsPerCoinSell',
    'shardsPerCoinBuy',
    'rateScale',
  ]) {
    assert.equal(typeof rate[field], 'string', `${field} crossed the wire as a ${typeof rate[field]}`)
  }
  // The raw JSON, so a serialiser that emitted a bare number would be caught even if JSON.parse
  // happened to produce a string-looking value.
  assert.doesNotMatch(response.text, /"usd":\s*[0-9]/)
})

test('an unusable rate answers 200 with the reason, not a 404 or a stale number', { skip }, async () => {
  await recordFailure(db, 'ETH', 'sources diverged by 900 bps')
  const response = await call('GET', '/rates/ETH')
  assert.equal(response.status, 200)
  const rate = (response.body as unknown as { rate: Record<string, unknown> }).rate
  assert.equal(rate['usable'], false)
  assert.equal(rate['usd'], null)
  assert.equal(rate['reason'], 'sources diverged by 900 bps')
})

/**
 * The last hand-typed asset code in this file, and the last one that could go stale.
 *
 * This test read `/rates/DOGE` and expected a 404. It went red on 2026-08-09 with nothing in this
 * repository changed: micro-contracts merged the second half of the DOGE/ETC release, so
 * `ON_CHAIN_ASSETS` is 8 assets rather than 6, `MARKET_ASSETS` derives from it, and `/rates/DOGE`
 * now correctly answers 200 with `usable: false, reason: "no quote yet"`. That is the behaviour
 * the test above this one pins on purpose — a 404 would be a lie about the asset existing — so
 * the service was right and the fixture was wrong.
 *
 * A live ticker is never a safe stand-in for "unknown" in a service whose asset list is designed
 * to grow. `NOTACOIN` is not a ticker at any of the four venues and is not a shape
 * `contracts-chain` would ever mint, and the guard below says so at run time rather than trusting
 * it: if the estate ever does list it, this fails with the reason instead of failing as a 404 that
 * quietly stopped testing anything.
 */
const UNQUOTED_ASSET = 'NOTACOIN'

test('a lower-case asset works; an unknown one is a 404', { skip }, async () => {
  await quoteBtc()
  assert.equal((await call('GET', '/rates/btc')).status, 200)

  assert.ok(
    !isQuotedAsset(UNQUOTED_ASSET),
    `${UNQUOTED_ASSET} is now a quoted asset — this test needs a code the estate does not list`,
  )
  assert.equal((await call('GET', `/rates/${UNQUOTED_ASSET}`)).status, 404)
})

/* ------------------------------------------------------------------ the admin route */

test('PUT /admin/prices refuses an anonymous caller, a player and a scopeless service', { skip }, async () => {
  const body = { usd: '0.4' }
  assert.equal((await call('PUT', '/admin/prices/EMBER', { body })).status, 401)
  assert.equal((await call('PUT', '/admin/prices/EMBER', { token: 'bogus', body })).status, 401)
  assert.equal((await call('PUT', '/admin/prices/EMBER', { token: 'player', body })).status, 403)
  assert.equal((await call('PUT', '/admin/prices/EMBER', { token: 'svc-none', body })).status, 403)
  assert.equal((await call('PUT', '/admin/prices/EMBER', { token: 'svc-read', body })).status, 403)
})

test('an identity outage is 503, never 401 — a 401 would sign the estate out', { skip }, async () => {
  const response = await call('PUT', '/admin/prices/EMBER', { token: 'down', body: { usd: '0.4' } })
  assert.equal(response.status, 503)
})

test('an admin user and a scoped service may both set a price, and both are recorded', { skip }, async () => {
  const byUser = await call('PUT', '/admin/prices/EMBER', { token: 'admin', body: { usd: '0.4' } })
  assert.equal(byUser.status, 200)
  const price = (byUser.body as unknown as { price: Record<string, unknown> }).price
  assert.equal(price['usdScaled'], '400000')
  assert.equal(price['setBy'], 'user:u-1')
  assert.equal(price['setByHandle'], 'ops-jane')

  const byService = await call('PUT', '/admin/prices/EMBER', { token: 'svc-admin', body: { usd: '0.45' } })
  assert.equal(byService.status, 200)
  assert.equal(
    (byService.body as unknown as { price: Record<string, unknown> }).price['setBy'],
    'service:ops-runbook',
  )
})

test('the new price is visible on the PUBLIC board immediately, on any replica', { skip }, async () => {
  // The defect in one test. The estate applies an admin price to the replica that served the
  // request and to no other, because the price lives in a per-process cache.
  await call('PUT', '/admin/prices/EMBER', { token: 'admin', body: { usd: '0.4' } })
  const rate = (
    (await call('GET', '/rates/EMBER')).body as unknown as { rate: Record<string, unknown> }
  ).rate
  assert.equal(rate['usd'], '0.4')
  assert.equal(rate['source'], 'administered')
  assert.equal(rate['usable'], true)
})

test('a JSON NUMBER price is refused — it is already not the number that was typed', { skip }, async () => {
  const response = await call('PUT', '/admin/prices/EMBER', { token: 'admin', body: { usd: 0.1 } })
  assert.equal(response.status, 400)
  assert.match(response.text, /usd must be a decimal string/)
})

test('a price with more precision than the scale holds is refused, not truncated', { skip }, async () => {
  const response = await call('PUT', '/admin/prices/EMBER', { token: 'admin', body: { usd: '0.1234567' } })
  assert.equal(response.status, 400)
  assert.match(response.text, /at most 6 decimal places/)
})

test('an administered price may NOT override an asset that has a market', { skip }, async () => {
  const response = await call('PUT', '/admin/prices/BTC', { token: 'admin', body: { usd: '1' } })
  assert.equal(response.status, 400)
  assert.match(response.text, /priced by the market/)
})

/* ------------------------------------------------------------------ history */

test('GET /history requires read authority and returns what the asset has been quoted at', { skip }, async () => {
  await quoteBtc('64000', 20)
  await quoteBtc('64500', 10)

  assert.equal((await call('GET', '/history/BTC')).status, 401)
  assert.equal((await call('GET', '/history/BTC', { token: 'svc-none' })).status, 403)

  const response = await call('GET', '/history/BTC', { token: 'svc-read' })
  assert.equal(response.status, 200)
  const history = (response.body as unknown as { history: Array<Record<string, unknown>> }).history
  assert.equal(history.length, 2)
  assert.equal(history[0]?.['usd'], '64500', 'most recent first')
  assert.equal(history[0]?.['sourceCount'], 4)
  assert.equal(typeof history[0]?.['usdScaled'], 'string')
})

test('an admin user reaches the history too, and a bad limit is a 400', { skip }, async () => {
  assert.equal((await call('GET', '/history/BTC', { token: 'admin' })).status, 200)
  assert.equal((await call('GET', '/history/BTC?limit=0', { token: 'admin' })).status, 400)
  assert.equal((await call('GET', '/history/BTC?limit=nine', { token: 'admin' })).status, 400)
})

test('an unmatched path is a 404 carrying the request id', { skip }, async () => {
  const response = await call('GET', '/nope')
  assert.equal(response.status, 404)
  assert.match(response.text, /"requestId"/)
})

/**
 * One handle, presented as the per-network selector the server now takes. The fixture runs against
 * a single test database, so mainnet is the only configured network — which exercises the REFUSAL
 * path for free.
 */
function singleNetworkSql(db: unknown) {
  return networkSql({ mainnet: db as RuntimeSql })
}
