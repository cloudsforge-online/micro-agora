/**
 * The quote store and the rate a caller may settle against.
 *
 * The staleness cases carry the most weight here. A stale quote is not a discount, it is an
 * unknown price, and the estate's oracle is one `if` away from serving one — the same rule exists
 * at `repos/forge-pay/services/pay/src/pricing.ts`, and it is right, but it protects a value
 * that only one replica has. Here the rule protects a value the whole estate shares.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { RATE_SCALE } from '@cloudsforge/contracts-chain'
import {
  rateView,
  readAdministered,
  readHistory,
  readQuote,
  readQuotes,
  recordAccepted,
  recordFailure,
  setAdministeredPrice,
  type RateOptions,
} from './quotes.ts'
import { parseScaled } from './rates.ts'
import { enabled, migrateTestDb, openDb, resetPricing, skip } from './testsupport.ts'
import type { Db } from './outbox.ts'

let sql: postgres.Sql
let db: Db

before(async () => {
  if (!enabled) return
  sql = openDb(4)
  db = sql as unknown as Db
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetPricing(sql)
})

const OPTIONS: RateOptions = { maxAgeSeconds: 300, conversionSpreadBps: 100 }

const NOW = Date.parse('2026-07-30T12:00:00.000Z')
const secondsAgo = (seconds: number) => new Date(NOW - seconds * 1000)

test('a fresh quote is usable, and every decimal crosses as a STRING', { skip }, async () => {
  await recordAccepted(db, {
    asset: 'BTC',
    usdScaled: parseScaled('64000')!,
    sourceCount: 4,
    divergenceBps: 12n,
    observedAt: secondsAgo(30),
  })

  const view = rateView('BTC', await readQuote(db, 'BTC'), { ...OPTIONS, now: NOW })
  assert.equal(view.usable, true)
  assert.equal(view.ageSeconds, 30)
  assert.equal(view.sourceCount, 4)
  // Strings, all of them. A JSON number is an IEEE 754 double, so a rate that crossed the wire as
  // one would have lost precision before the consumer parsed it.
  assert.equal(typeof view.usdScaled, 'string')
  assert.equal(view.usd, '64000')
  assert.equal(view.usdSell, '63360')
  assert.equal(view.usdBuy, '64646.464646')
  assert.equal(view.rateScale, RATE_SCALE.toString())
  assert.equal(view.reason, undefined)
})

test('FAIL-CLOSED: past the maximum age the rate is unusable and SAYS WHY', { skip }, async () => {
  await recordAccepted(db, {
    asset: 'BTC',
    usdScaled: parseScaled('64000')!,
    sourceCount: 4,
    divergenceBps: 0n,
    observedAt: secondsAgo(301),
  })

  const view = rateView('BTC', await readQuote(db, 'BTC'), { ...OPTIONS, now: NOW })
  assert.equal(view.usable, false)
  assert.equal(view.usdScaled, null, 'a stale rate must not be served as a number at all')
  assert.equal(view.usdSell, null)
  assert.match(view.reason ?? '', /301s old, past the 300s maximum/)
  // The age is still reported. "We are not quoting BTC, the last round was five minutes ago" is a
  // different operational fact from "we have never quoted BTC", and a client needs both.
  assert.equal(view.ageSeconds, 301)
})

test('the boundary is inclusive: exactly at the maximum age is still usable', { skip }, async () => {
  await recordAccepted(db, {
    asset: 'ETH',
    usdScaled: parseScaled('3000')!,
    sourceCount: 3,
    divergenceBps: 0n,
    observedAt: secondsAgo(300),
  })
  const view = rateView('ETH', await readQuote(db, 'ETH'), { ...OPTIONS, now: NOW })
  assert.equal(view.usable, true)
})

test('an asset that has never been quoted is unusable, and not a zero', { skip }, async () => {
  const view = rateView('SOL', await readQuote(db, 'SOL'), { ...OPTIONS, now: NOW })
  assert.equal(view.usable, false)
  assert.equal(view.usdScaled, null)
  assert.equal(view.reason, 'no quote yet')
})

test('a failed round records the reason and KEEPS the last good quote', { skip }, async () => {
  await recordAccepted(db, {
    asset: 'XRP',
    usdScaled: parseScaled('0.52')!,
    sourceCount: 3,
    divergenceBps: 4n,
    observedAt: secondsAgo(10),
  })
  await recordFailure(db, 'XRP', 'sources diverged by 900 bps')

  const view = rateView('XRP', await readQuote(db, 'XRP'), { ...OPTIONS, now: NOW })
  // Still usable: one rejected round is not a reason to stop converting, and deleting the quote
  // would turn a transient exchange fault into an immediate refusal. Age is what decides, and the
  // failure is surfaced alongside so an operator sees the refresh is unhealthy.
  assert.equal(view.usable, true)
  assert.equal(view.usd, '0.52')
  assert.equal(view.lastFailure, 'sources diverged by 900 bps')
  assert.ok(view.lastFailureAt)
})

test('a failure for an asset with no quote at all is the reason the board shows', { skip }, async () => {
  await recordFailure(db, 'SOL', 'only 1 of 2 required sources answered')
  const view = rateView('SOL', await readQuote(db, 'SOL'), { ...OPTIONS, now: NOW })
  assert.equal(view.usable, false)
  assert.equal(view.reason, 'only 1 of 2 required sources answered')
})

/* ------------------------------------------------------------------ administered prices */

test('the migration seeds EMBER, and the seed is marked as nobody having decided it', { skip }, async () => {
  const prices = await readAdministered(db)
  const ember = prices.find((p) => p.asset === 'EMBER')
  // 0.0001, not the 0.25 version 4 inserts: version 5 lowers the seed wherever set_by is still
  // null, because EMBER has no exchange listing and 0.25 was never a price anything traded at.
  assert.equal(ember?.usdScaled, parseScaled('0.0001'))
  assert.equal(ember?.setBy, null, 'a seeded default must not look like an operator decision')
})

test('an administered price OVERRIDES the quote, atomically, for every replica', { skip }, async () => {
  await setAdministeredPrice(db, {
    asset: 'EMBER',
    usdScaled: parseScaled('0.4')!,
    setBy: 'user:2f0c',
    setByHandle: 'ops-jane',
  })

  const view = rateView('EMBER', await readQuote(db, 'EMBER'), { ...OPTIONS, now: NOW })
  assert.equal(view.usable, true)
  assert.equal(view.source, 'administered')
  assert.equal(view.usd, '0.4')
  assert.equal(view.sourceCount, 0, 'an administered price is nobody\'s market observation')

  // The estate's version updates a row and then a per-process cache, so only the replica that
  // served the request has the new price. A second connection reading the new value is the whole
  // difference.
  const other = openDb(1)
  try {
    assert.equal((await readQuote(other as unknown as Db, 'EMBER'))?.usdScaled, parseScaled('0.4'))
  } finally {
    await other.end({ timeout: 5 })
  }
})

test('the setter is recorded, because an administered price is an act somebody took', { skip }, async () => {
  await setAdministeredPrice(db, {
    asset: 'EMBER',
    usdScaled: parseScaled('0.31')!,
    setBy: 'user:2f0c',
    setByHandle: 'ops-jane',
  })
  const price = (await readAdministered(db)).find((p) => p.asset === 'EMBER')
  assert.equal(price?.setBy, 'user:2f0c')
  assert.equal(price?.setByHandle, 'ops-jane')

  // And in the history, so "who decided this" is answerable months later when a conversion is
  // questioned rather than only until the next change overwrites the row.
  const history = await readHistory(db, 'EMBER', 10)
  assert.equal(history[0]?.setBy, 'user:2f0c')
  assert.equal(history[0]?.source, 'administered')
})

test('AN ADMINISTERED PRICE NEVER GOES STALE — it is configuration, not an observation', { skip }, async () => {
  await setAdministeredPrice(db, {
    asset: 'EMBER',
    usdScaled: parseScaled('0.25')!,
    setBy: 'user:2f0c',
    setByHandle: 'ops-jane',
  })
  const record = await readQuote(db, 'EMBER')
  assert.ok(record)

  // A year later. Applying the market max-age here would make EMBER unconvertible five minutes
  // after an operator set its price, which is not what fail-closed means: there is no refresh that
  // could make this value fresher, so refusing it would refuse it for ever.
  const view = rateView('EMBER', record, { ...OPTIONS, now: NOW + 365 * 24 * 3_600 * 1000 })
  assert.equal(view.usable, true)
  assert.equal(view.usd, '0.25')
  assert.ok((view.ageSeconds ?? 0) > 300, 'the age is still reported honestly')
})

test('the board lists every asset, usable or not', { skip }, async () => {
  await recordAccepted(db, {
    asset: 'BTC',
    usdScaled: parseScaled('64000')!,
    sourceCount: 4,
    divergenceBps: 0n,
    observedAt: secondsAgo(5),
  })
  const records = await readQuotes(db)
  const assets = records.map((r) => r.asset)
  assert.ok(assets.includes('BTC'))
  assert.ok(assets.includes('EMBER'), 'the seeded administered asset is part of the board')
})

test('a negative or zero price cannot be stored at all', { skip }, async () => {
  // The CHECK constraint, not the application, is what makes this true for a psql session too.
  await assert.rejects(
    sql`insert into price_quotes (asset, usd_scaled, source, quoted_at) values ('SOL', 0, 'market', now())`,
    /price_quotes_usd_scaled_check|violates check constraint/,
  )
})
