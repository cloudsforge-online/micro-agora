/**
 * The refresh round, against the real table.
 *
 * **Every source in this file is a fake.** A suite that reached CoinGecko could not reproduce a
 * divergence on demand, could not test the fail-closed staleness rule at all, and would fail on a
 * rate limit rather than on a defect. The harness is `sourcesQuoting` and `failingSource` in
 * `testsupport.ts`, and the oracle takes its sources as a dependency for exactly this reason.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { refreshRound, type OracleDeps } from './oracle.ts'
import { readHistory, readQuote, setAdministeredPrice } from './quotes.ts'
import { parseScaled } from './rates.ts'
import {
  enabled,
  failingSource,
  fixedSource,
  migrateTestDb,
  openDb,
  resetPricing,
  skip,
  sourcesQuoting,
} from './testsupport.ts'
import type { Db } from './outbox.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb(4)
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

/** Silenced: these tests deliberately provoke error-level lines about diverging sources. */
const logger = new Logger({ service: 'pricing-test', level: 'fatal', sink: () => {} })

function deps(overrides: Partial<OracleDeps> = {}): OracleDeps {
  return {
    sql: sql as unknown as Db,
    logger,
    metrics: new Metrics(),
    sources: [],
    minSources: 2,
    maxDivergenceBps: 200,
    ...overrides,
  }
}

test('an accepted round writes the median to the TABLE, where every replica reads it', { skip }, async () => {
  // The whole point of the service. The estate's oracle writes to a per-process Map, so a second
  // replica never sees this value at all.
  await refreshRound(deps({ sources: sourcesQuoting('BTC', ['64000', '64100', '64200', '64300']) }))

  const quote = await readQuote(sql as unknown as Db, 'BTC')
  assert.ok(quote)
  assert.equal(quote.usdScaled, 64_150_000_000n, 'the even-count median is the average of the middles')
  assert.equal(quote.source, 'market')
  assert.equal(quote.sourceCount, 4)
  assert.equal(quote.lastFailure, null)
})

test('the quote is readable by a SECOND connection, which a Map never was', { skip }, async () => {
  await refreshRound(deps({ sources: sourcesQuoting('ETH', ['3000', '3010', '3020']) }))

  // A separate pool stands in for a separate replica. This assertion is the one that would have
  // been impossible before: the old oracle's quote lived in the process that fetched it.
  const other = openDb(1)
  try {
    const quote = await readQuote(other as unknown as Db, 'ETH')
    assert.equal(quote?.usdScaled, parseScaled('3010'))
  } finally {
    await other.end({ timeout: 5 })
  }
})

test('every accepted round appends to the history, so a rate can be explained later', { skip }, async () => {
  await refreshRound(deps({ sources: sourcesQuoting('SOL', ['150', '151', '152']) }))
  await refreshRound(deps({ sources: sourcesQuoting('SOL', ['160', '161', '162']) }))

  const history = await readHistory(sql as unknown as Db, 'SOL', 10)
  assert.equal(history.length, 2)
  assert.equal(history[0]?.usdScaled, parseScaled('161'), 'most recent first')
  assert.equal(history[1]?.usdScaled, parseScaled('151'))
  assert.equal(history[0]?.sourceCount, 3)
})

test('A DIVERGENT ROUND IS REJECTED WHOLE, and the previous quote is left alone', { skip }, async () => {
  await refreshRound(deps({ sources: sourcesQuoting('BTC', ['64000', '64100', '64200']) }))
  const before = await readQuote(sql as unknown as Db, 'BTC')

  // One venue printing half price. There is no way to tell which of these is wrong, so none of
  // them is usable — and laundering them through a median would settle money against the result.
  await refreshRound(deps({ sources: sourcesQuoting('BTC', ['64000', '64100', '31000']) }))

  const after = await readQuote(sql as unknown as Db, 'BTC')
  assert.equal(after?.usdScaled, before?.usdScaled, 'the rejected round overwrote the good quote')
  assert.match(after?.lastFailure ?? '', /diverged by \d+ bps/)
  assert.ok(after?.lastFailureAt, 'the failure was not timestamped')

  const history = await readHistory(sql as unknown as Db, 'BTC', 10)
  assert.equal(history.length, 1, 'a rejected round must not appear in the history as a price')
})

test('too few sources records why, and does not invent a rate from the one that answered', { skip }, async () => {
  await refreshRound(
    deps({
      sources: [fixedSource('only-one', { XRP: '0.52' }), failingSource('down'), failingSource('also-down')],
    }),
  )
  const quote = await readQuote(sql as unknown as Db, 'XRP')
  assert.equal(quote?.usdScaled, null)
  assert.match(quote?.lastFailure ?? '', /only 1 of 2 required sources answered/)
})

test('a source that throws costs one vote, not the round', { skip }, async () => {
  // The condition this design exists to tolerate. `Promise.allSettled` is what makes a dead
  // exchange a reduced source count rather than an exception that aborts every asset.
  const report = await refreshRound(
    deps({
      sources: [
        fixedSource('a', { BTC: '64000' }),
        failingSource('b', 'ECONNREFUSED'),
        fixedSource('c', { BTC: '64100' }),
      ],
    }),
  )
  assert.equal(report.sourcesAnswered, 2)
  assert.deepEqual(
    report.sourceFailures.map((f) => f.source),
    ['b'],
  )
  const quote = await readQuote(sql as unknown as Db, 'BTC')
  assert.equal(quote?.usdScaled, parseScaled('64050'))
})

test('a source that answers with rubbish loses its vote on that asset only', { skip }, async () => {
  await refreshRound(
    deps({
      sources: [
        fixedSource('a', { BTC: '64000', ETH: '3000' }),
        fixedSource('b', { BTC: 'unavailable', ETH: '3010' }),
        fixedSource('c', { BTC: '64200', ETH: '3020' }),
      ],
    }),
  )
  const btc = await readQuote(sql as unknown as Db, 'BTC')
  const eth = await readQuote(sql as unknown as Db, 'ETH')
  assert.equal(btc?.sourceCount, 2)
  assert.equal(eth?.sourceCount, 3)
  assert.equal(eth?.usdScaled, parseScaled('3010'))
})

test('one asset failing does not stop the others being quoted', { skip }, async () => {
  const report = await refreshRound(
    deps({
      sources: [
        fixedSource('a', { BTC: '64000', ETH: '3000' }),
        fixedSource('b', { BTC: '31000', ETH: '3010' }),
      ],
    }),
  )
  const outcomes = new Map(report.assets.map((a) => [a.asset, a.outcome]))
  assert.equal(outcomes.get('BTC'), 'rejected_divergence')
  assert.equal(outcomes.get('ETH'), 'accepted')
})

test('the metrics say which asset, with which outcome, and how far apart the sources were', { skip }, async () => {
  const metrics = new Metrics()
  metrics
    .register({ name: 'pricing_round_total', help: '', kind: 'counter', labels: ['asset', 'outcome'] })
    .register({ name: 'pricing_sources_ok', help: '', kind: 'gauge', labels: ['asset'] })
    .register({ name: 'pricing_divergence_bps', help: '', kind: 'gauge', labels: ['asset'] })

  await refreshRound(deps({ metrics, sources: sourcesQuoting('BTC', ['64000', '31000']) }))
  const rendered = metrics.render()
  assert.match(rendered, /pricing_round_total\{asset="BTC",outcome="rejected_divergence"\} 1/)
  assert.match(rendered, /pricing_sources_ok\{asset="BTC"\} 2/)
  assert.match(rendered, /pricing_divergence_bps\{asset="BTC"\} \d+/)
})

test('an administered price is carried into the quote table by the round', { skip }, async () => {
  // The repair path: a price inserted by a migration, a restore or an operator in psql still
  // reaches the quote a rate lookup reads.
  await sql`update administered_prices set usd_scaled = 400000, updated_at = now() where asset = 'EMBER'`
  const report = await refreshRound(deps({ sources: sourcesQuoting('BTC', ['64000', '64100']) }))
  assert.equal(report.administeredSynced, 1)

  const quote = await readQuote(sql as unknown as Db, 'EMBER')
  assert.equal(quote?.usdScaled, parseScaled('0.4'))
  assert.equal(quote?.source, 'administered')
})

test('a market round never overwrites an administered asset', { skip }, async () => {
  // EMBER is administered because Hearth has no market. A source claiming to quote it must be
  // ignored, or the fail-closed oracle becomes a fail-to-whatever-a-stranger-said oracle.
  await setAdministeredPrice(sql as unknown as Db, {
    asset: 'EMBER',
    usdScaled: parseScaled('0.25')!,
    setBy: 'user:ops',
    setByHandle: 'ops',
  })
  await refreshRound(
    deps({
      sources: [
        fixedSource('a', { EMBER: '99', BTC: '64000' }),
        fixedSource('b', { EMBER: '99', BTC: '64100' }),
      ],
    }),
  )
  const quote = await readQuote(sql as unknown as Db, 'EMBER')
  assert.equal(quote?.usdScaled, parseScaled('0.25'))
  assert.equal(quote?.source, 'administered')
})
