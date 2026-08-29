/**
 * The fixed-point arithmetic, and the round decision.
 *
 * Everything here is pure, so every case is exact: no database, no clock, no network, and no
 * tolerance in any assertion. A rate test that has to allow for rounding error is a test of the
 * defect this service exists to remove.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ON_CHAIN_ASSETS, RATE_SCALE, SHARDS_PER_USD } from '@cloudsforge/contracts-chain'
import {
  ADMINISTERED_ASSETS,
  MARKET_ASSETS,
  QUOTED_ASSETS,
  RATE_DECIMALS,
  applySpreadBuy,
  applySpreadSell,
  decideRound,
  divergenceBps,
  formatScaled,
  medianScaled,
  parseAdministeredScaled,
  parseScaled,
  shardsPerCoinScaled,
  sortScaled,
} from './rates.ts'

const quote = (source: string, usdScaled: bigint) => ({ source, usdScaled })

/* ------------------------------------------------------------------ parsing and rendering */

test('a decimal string becomes an exact scaled integer, with no float on the path', () => {
  assert.equal(parseScaled('1'), 1_000_000n)
  assert.equal(parseScaled('0.25'), 250_000n)
  assert.equal(parseScaled('64231.5'), 64_231_500_000n)
  assert.equal(parseScaled('0.000001'), 1n)

  // The case the old oracle gets wrong. `Math.floor(1.005 * 1e6)` is 1004999, because 1.005 is
  // not representable as a double: the estate's oracle loses a unit at the sixth decimal place on
  // a value it was handed exactly. Over a conversion of any size that unit is real money, and it
  // is invisible because both the input and the expected output look right.
  assert.equal(parseScaled('1.005'), 1_005_000n)
  assert.equal(Math.floor(1.005 * Number(RATE_SCALE)), 1_004_999)
})

test('precision below the scale is truncated toward zero, never rounded up', () => {
  // Rounding up would mint value: `shardsForCoinAmount` in contracts-chain rounds down for exactly
  // this reason, and a rate that rounds the other way would undo it one layer earlier.
  assert.equal(parseScaled('0.1234567'), 123_456n)
  assert.equal(parseScaled('0.9999999'), 999_999n)
})

test('a malformed or non-positive quote drops the source rather than aborting the round', () => {
  assert.equal(parseScaled('not a price'), null)
  assert.equal(parseScaled(''), null)
  assert.equal(parseScaled('0'), null)
  assert.equal(parseScaled('-1'), null)
  assert.equal(parseScaled('1e6'), null, 'exponent notation is not a decimal we will guess at')
})

test('an operator typing more precision than the scale holds is refused, not truncated', () => {
  // Different from a market quote on purpose. An operator has a specific number in mind and
  // silently storing a different one is how an administered price ends up wrong by an order of
  // magnitude with nobody able to say when.
  assert.equal(parseAdministeredScaled('0.1234567'), null)
  assert.equal(parseAdministeredScaled('0.123456'), 123_456n)
  assert.equal(parseAdministeredScaled('0.25'), 250_000n)
})

test('rendering is exact in both directions', () => {
  assert.equal(formatScaled(250_000n), '0.25')
  assert.equal(formatScaled(64_231_500_000n), '64231.5')
  assert.equal(formatScaled(1n), '0.000001')
  assert.equal(formatScaled(1_000_000n), '1')
  for (const text of ['0.25', '64231.5', '0.000001', '19.874321']) {
    assert.equal(formatScaled(parseScaled(text)!), text, `${text} did not round-trip`)
  }
})

test('RATE_DECIMALS is derived from RATE_SCALE rather than restated', () => {
  assert.equal(RATE_DECIMALS, 6)
  assert.equal(10n ** BigInt(RATE_DECIMALS), RATE_SCALE)
})

/* ------------------------------------------------------------------ the median */

test('the median of an ODD number of sources is the middle one', () => {
  const sorted = sortScaled([300n, 100n, 200n])
  assert.deepEqual(sorted, [100n, 200n, 300n])
  assert.equal(medianScaled(sorted), 200n)
})

test('the median of an EVEN number of sources averages the two middles, in BigInt', () => {
  assert.equal(medianScaled(sortScaled([100n, 200n, 300n, 400n])), 250n)
  // Four real quotes: the outer two are ignored entirely, which is the property that makes one bad
  // print harmless.
  const quotes = ['64000', '64100.5', '64101.5', '99999'].map((t) => parseScaled(t)!)
  assert.equal(medianScaled(sortScaled(quotes)), 64_101_000_000n)
})

test('an even median with an odd sum rounds DOWN, like every other rounding in the estate', () => {
  assert.equal(medianScaled([1n, 2n]), 1n)
  assert.equal(medianScaled([100_000_001n, 100_000_002n]), 100_000_001n)
})

test('the median never depends on the order the sources answered in', () => {
  const values = [17n, 4n, 99n, 4n]
  const shuffled = [4n, 99n, 17n, 4n]
  assert.equal(medianScaled(sortScaled(values)), medianScaled(sortScaled(shuffled)))
})

test('sorting is numeric, not lexicographic', () => {
  // `[10n, 9n].sort()` compares as strings and answers [10, 9]. On a rate that would put the
  // median between the wrong pair.
  assert.deepEqual(sortScaled([10n, 9n, 100n]), [9n, 10n, 100n])
})

/* ------------------------------------------------------------------ divergence */

test('divergence is measured in bps of the lowest quote', () => {
  assert.equal(divergenceBps([100n, 101n]), 100n)
  assert.equal(divergenceBps([100n, 100n, 100n]), 0n)
  assert.equal(divergenceBps([1_000n]), 0n, 'one source cannot diverge from anything')
})

test('A ROUND IS REJECTED WHOLE when the sources diverge past the threshold', () => {
  // The decision that matters most in this file. One of these venues is wrong and there is no way
  // to tell which, so none of them is usable — taking the median anyway would launder a bad print
  // into a rate that money then settles against.
  const decision = decideRound({
    quotes: [
      quote('a', parseScaled('64000')!),
      quote('b', parseScaled('64010')!),
      quote('c', parseScaled('64020')!),
      quote('d', parseScaled('31000')!),
    ],
    minSources: 2,
    maxDivergenceBps: 200,
  })
  assert.notEqual(decision.outcome, 'accepted')
  if (decision.outcome === 'accepted') return
  assert.equal(decision.outcome, 'rejected_divergence')
  assert.equal(decision.sourceCount, 4)
  assert.match(decision.reason, /diverged by \d+ bps/)
})

test('a round within the threshold is accepted, and the median is the rate', () => {
  const decision = decideRound({
    quotes: [
      quote('a', parseScaled('64000')!),
      quote('b', parseScaled('64100')!),
      quote('c', parseScaled('64200')!),
    ],
    minSources: 2,
    maxDivergenceBps: 200,
  })
  assert.equal(decision.outcome, 'accepted')
  if (decision.outcome !== 'accepted') return
  assert.equal(decision.usdScaled, 64_100_000_000n)
  assert.equal(decision.divergenceBps, 31n)
})

test('the threshold is inclusive: exactly at the limit is still usable', () => {
  const decision = decideRound({
    quotes: [quote('a', 10_000n), quote('b', 10_200n)],
    minSources: 2,
    maxDivergenceBps: 200,
  })
  assert.equal(decision.outcome, 'accepted')
  assert.equal(decision.divergenceBps, 200n)
})

test('too few sources is a distinct outcome from divergence', () => {
  // Distinct because the operator response is different: one is "an exchange is down", the other
  // is "an exchange is lying". Collapsing them into one failure would hide the second.
  const decision = decideRound({
    quotes: [quote('a', 10_000n)],
    minSources: 2,
    maxDivergenceBps: 200,
  })
  assert.equal(decision.outcome, 'too_few_sources')
  assert.equal(decision.sourceCount, 1)
  assert.match(
    decision.outcome === 'too_few_sources' ? decision.reason : '',
    /only 1 of 2 required/,
  )
})

test('a round with no sources at all fails closed rather than throwing', () => {
  const decision = decideRound({ quotes: [], minSources: 2, maxDivergenceBps: 200 })
  assert.equal(decision.outcome, 'too_few_sources')
})

/* ------------------------------------------------------------------ the spread */

test('the spread runs against the user in BOTH directions', () => {
  const mid = parseScaled('100')!
  const sell = applySpreadSell(mid, 100)
  const buy = applySpreadBuy(mid, 100)
  assert.ok(sell < mid, 'selling into the platform must pay less than mid')
  assert.ok(buy > mid, 'buying from the platform must cost more than mid')
  assert.equal(formatScaled(sell), '99')
  assert.equal(formatScaled(buy), '101.010101')
})

test('a round trip through the platform LOSES the spread — it is never free money', () => {
  // The property the whole two-leg design exists for: converting out and straight back in must not
  // return more than was started with, or anyone can repeat it until the treasury is empty.
  const mid = parseScaled('64231.5')!
  const outAndBack = (applySpreadSell(mid, 100) * RATE_SCALE) / applySpreadBuy(mid, 100)
  assert.ok(outAndBack < RATE_SCALE, 'a round trip returned at least what it started with')
})

test('a zero spread is the identity, so the setting is genuinely off rather than nearly off', () => {
  const mid = parseScaled('64231.5')!
  assert.equal(applySpreadSell(mid, 0), mid)
  assert.equal(applySpreadBuy(mid, 0), mid)
})

test('shards per coin comes from SHARDS_PER_USD, not from a second constant', () => {
  assert.equal(shardsPerCoinScaled(parseScaled('1')!), RATE_SCALE * SHARDS_PER_USD)
  assert.equal(formatScaled(shardsPerCoinScaled(parseScaled('0.25')!)), '25')
})

/* ------------------------------------------------------------------ the asset sets */

test('the market and administered sets are disjoint, and derived from the chain contract', () => {
  // An administered price may never override an asset that has a market: that would turn a
  // fail-closed oracle into a fail-to-whatever-was-typed oracle.
  for (const asset of ADMINISTERED_ASSETS) {
    assert.ok(!MARKET_ASSETS.includes(asset), `${asset} is in both sets`)
  }
  assert.deepEqual([...ADMINISTERED_ASSETS], ['EMBER'])

  // DERIVED, NOT RESTATED. This line used to read `['BTC', 'ETH', 'SOL', 'XRP']`, and it went red
  // the day LTC was added to `ON_CHAIN_ASSETS` — correctly, but for the wrong reason: it was
  // reporting that a hand-typed list had gone stale, not that anything was wrong. Restating the
  // expected set here makes this test a second declaration of `ON_CHAIN_ASSETS`, which is the exact
  // drift `rates.ts` avoids by deriving `MARKET_ASSETS` in the first place.
  //
  // The property actually worth asserting is the PARTITION: every on-chain asset is either quoted
  // by a market or set by an operator, and none is both or neither. An asset that fell out of both
  // sets would have no price at all, and `quoteFor` would fail closed on it for ever without
  // anything naming why.
  //
  // BE HONEST ABOUT WHAT THE NEXT TWO LINES CAN CATCH. The first restates `rates.ts`'s own filter,
  // so it cannot fail while that filter is the implementation; it is a pin on the DEFINITION —
  // it goes red if somebody replaces the derivation with a literal that disagrees, which is exactly
  // the regression this file's history is about. The line after it is the one with independent
  // content: `QUOTED_ASSETS` is assembled by concatenation, so "the two halves put back together
  // are the whole" is a real claim about it.
  assert.deepEqual(
    [...MARKET_ASSETS].sort(),
    [...ON_CHAIN_ASSETS].filter((asset) => !ADMINISTERED_ASSETS.includes(asset)).sort(),
  )
  assert.deepEqual([...QUOTED_ASSETS].sort(), [...ON_CHAIN_ASSETS].sort())
  assert.equal(QUOTED_ASSETS.length, MARKET_ASSETS.length + ADMINISTERED_ASSETS.length)

  // Non-vacuous, and specific enough to catch a partition that has silently emptied. Named because
  // this repository's behaviour is built around them: BTC and LTC are the worked examples in
  // `sources.ts`, and DOGE and ETC are the two whose Kraken symbols had to be measured rather than
  // inferred. An asset losing its market membership is a rate this service stops serving.
  for (const asset of ['BTC', 'LTC', 'DOGE', 'ETC'] as const) {
    assert.ok(MARKET_ASSETS.includes(asset), `${asset} is no longer a market asset`)
  }

  // NO COUNT IS ASSERTED. A floor like `MARKET_ASSETS.length >= 5` was here and had gone stale at
  // seven without failing — it can only ever be too low, so it stops testing anything the day after
  // it is written, and raising it is a second hand-maintained list of how many assets exist. The
  // non-vacuity that matters is that neither half of the partition is empty, which does not stale.
  assert.ok(MARKET_ASSETS.length > 0, 'a partition with an empty market half is not a partition')
  assert.ok(ADMINISTERED_ASSETS.length > 0)
})
