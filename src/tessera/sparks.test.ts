/**
 * Money: the Spark floor, the `BigInt('')` hazard, and the partition property.
 *
 * §12's test 7 asks for `fee + royalty + proceeds === price` "across randomised prices,
 * fee/royalty rates and recipient splits — property-tested". Three examples would pass against an
 * implementation that rounds the wrong way on the fourth.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  ASSET,
  BPS_SCALE,
  EMBER_DECIMALS,
  MoneyError,
  SPARK_DECIMALS,
  WEI_PER_SPARK,
  allocate,
  assertPartition,
  bpsOf,
  fromSparks,
  parsePriceWei,
  parseWei,
  splitSale,
  toSparks,
} from './sparks.ts'
import { WEI_PER_SPARK_SQL } from './migrations.ts'
import { stripComments } from './testsupport.ts'

test('a Spark is exactly 10^12 wei, and TypeScript and the database agree about it', () => {
  assert.equal(WEI_PER_SPARK, 1_000_000_000_000n)
  assert.equal(EMBER_DECIMALS - SPARK_DECIMALS, 12)
  // The CHECK constraints are built from a SQL literal and this is a computed bigint. A rate
  // written twice is the estate's oldest failure shape, so the two are asserted equal here rather
  // than trusted to stay in step.
  assert.equal(WEI_PER_SPARK.toString(), WEI_PER_SPARK_SQL)
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * SPARKS IS A DENOMINATION. IT IS NOT AN ASSET CODE, AND IT MUST NEVER BECOME ONE.
 *
 * §8.1: if Sparks were its own asset code the ledger's per-asset balancing trigger would let it
 * and EMBER drift apart, and reconciling them would need a RATE — which is the mechanism of
 * `convertCoinToEmber`, "a liability minted against nothing, with no counter-account and therefore
 * nothing that could ever notice".
 *
 * The absence is asserted with force across the whole repository, not in one file: an asset code
 * is a string that reaches a ledger posting, and it could be introduced anywhere.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('there is no SPARK asset code anywhere in this service — one asset, one trial balance', () => {
  assert.equal(ASSET, 'EMBER')

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // THE NEEDLE IS BUILT, NOT WRITTEN — because the first version of this test FAILED ON ITSELF.
  //
  // It listed the forbidden strings as literals and then scanned every `.ts` file in `src`,
  // including its own. The second guard in this repository to fire on its own text; the first
  // was `world.test.ts` matching an error message that quoted the rule.
  //
  // The tempting fixes are both wrong. Excluding `*.test.ts` from the scan puts the one file
  // class that is easiest to introduce a stray asset code from outside the check. Loosening the
  // needle makes it match less than it should. Building the literal from halves keeps the scan
  // over EVERY source file including this one, and the assertion below proves the needle is what
  // it is supposed to be, so the construction cannot silently produce a needle that matches
  // nothing — which is how a guard stops guarding without ever going red.
  // ═════════════════════════════════════════════════════════════════════════════════════════
  const needle = `SP${'ARK'}`
  assert.equal(needle, String.fromCharCode(83, 80, 65, 82, 75), 'the needle is not what it claims')

  const dir = new URL('.', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
  assert.ok(files.length > 10, 'no sources were scanned; this check is grading nothing')
  let scanned = 0
  for (const file of files) {
    const source = stripComments(readFileSync(new URL(file, dir), 'utf8'))
    scanned += 1
    for (const forbidden of [`'${needle}'`, `"${needle}"`, `assetCode: '${needle}`, `${needle}:`]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${file} contains ${forbidden} — Sparks is a display denomination of EMBER (23-tessera.md §8.1)`,
      )
    }
  }
  assert.equal(scanned, files.length)
  // And the scan reaches this file, which is the half that stopped being true the moment somebody
  // reached for an exclusion.
  assert.ok(files.includes('sparks.test.ts'))
})

/**
 * §11.5's hazard, closed rather than handled.
 *
 * A test that only checked `''` would pass against `BigInt(value ?? '0')`, which is the wrong fix
 * wearing the right shape. Ten inputs, each of which `BigInt` either accepts silently or coerces.
 */
test("BigInt('') === 0n is UNREACHABLE through parseWei, not merely handled", () => {
  // The hazard is real, and stated here so the test is about something rather than about a regex.
  assert.equal(BigInt(''), 0n)
  assert.equal(BigInt(' '), 0n)
  assert.equal(BigInt('\n'), 0n)

  for (const bad of ['', ' ', '\n', '1e3', '0x10', '-1', '1.0', '+1', '1_000', '9'.repeat(79)]) {
    assert.throws(
      () => parseWei(bad),
      MoneyError,
      `parseWei accepted ${JSON.stringify(bad)} — a missing amount becoming 0n is a free purchase`,
    )
  }
  for (const bad of [null, undefined, 400, 400n, {}, [], true]) {
    assert.throws(() => parseWei(bad), MoneyError, `parseWei accepted ${String(bad)}`)
  }
  // And the shapes that ARE money.
  assert.equal(parseWei('0'), 0n)
  assert.equal(parseWei('400000000000000'), 400_000_000_000_000n)
  assert.equal(parseWei('9'.repeat(78)), BigInt('9'.repeat(78)))
})

test('a price finer than one Spark is refused before it reaches the database', () => {
  assert.throws(() => parsePriceWei('1'), MoneyError)
  assert.throws(() => parsePriceWei('999999999999'), MoneyError)
  assert.throws(() => parsePriceWei('1000000000001'), MoneyError)
  assert.equal(parsePriceWei('1000000000000'), WEI_PER_SPARK)
  assert.equal(parsePriceWei('0'), 0n)
})

test('the price table in §8.1 round-trips through Sparks exactly', () => {
  // A tip, a common object, a good object, a month on a prime Plot.
  for (const [sparks, ember] of [
    [5n, '0.000005'],
    [400n, '0.0004'],
    [5_000n, '0.005'],
    [40_000n, '0.04'],
  ] as const) {
    const wei = fromSparks(sparks)
    assert.equal(toSparks(wei), sparks)
    // And the EMBER figure the design's table prints, derived rather than restated.
    const asEmber = Number(wei) / 10 ** EMBER_DECIMALS
    assert.equal(asEmber, Number(ember))
  }
})

test('bpsOf rounds DOWN, deliberately in the platform disfavour', () => {
  // 2.5% of 399 wei is 9.975. Down is 9; up would be 10, and that wei would come out of the
  // seller's remainder, invisibly, once per sale.
  assert.equal(bpsOf(399n, 250), 9n)
  assert.equal(bpsOf(10_000n, 250), 250n)
  assert.equal(bpsOf(1n, 9_999), 0n)
  assert.equal(BPS_SCALE, 10_000n)
  assert.throws(() => bpsOf(100n, 10_001), MoneyError)
  assert.throws(() => bpsOf(100n, -1), MoneyError)
  assert.throws(() => bpsOf(100n, 2.5), MoneyError)
})

/**
 * §12's test 7, property-tested.
 *
 * A deterministic PRNG rather than `Math.random`, so a failure is reproducible from the seed
 * printed in the assertion message. A property test that cannot be replayed is a flake generator.
 */
test('fee + royalty + proceeds === price, over 5000 randomised prices and rates', () => {
  let seed = 0x9e3779b9
  const next = () => {
    // xorshift32 — small, deterministic, and good enough to walk a space this shape.
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0x1_0000_0000
  }
  for (let i = 0; i < 5_000; i += 1) {
    // Prices from one Spark to a hundred thousand EMBER, always a whole number of Sparks.
    const sparks = BigInt(1 + Math.floor(next() * 100_000_000_000))
    const priceWei = fromSparks(sparks)
    const platformFeeBps = Math.floor(next() * 2_500)
    const royaltyBps = Math.floor(next() * (9_999 - platformFeeBps))
    const split = splitSale({ priceWei, platformFeeBps, royaltyBps })
    assert.equal(
      split.feeWei + split.royaltyWei + split.proceedsWei,
      priceWei,
      `iteration ${i}: price ${priceWei} fee ${platformFeeBps}bps royalty ${royaltyBps}bps did not partition`,
    )
    assert.ok(split.proceedsWei >= 0n, `iteration ${i}: the seller would receive a negative amount`)
    // The seller gets the remainder, so they never lose more than the stated rates.
    assert.ok(split.feeWei <= bpsOf(priceWei, platformFeeBps))
    assert.ok(split.royaltyWei <= bpsOf(priceWei, royaltyBps))
  }
})

test('assertPartition catches a split that does not partition, so the property has teeth', () => {
  assert.throws(
    () => assertPartition({ priceWei: 100n, feeWei: 3n, royaltyWei: 3n, proceedsWei: 90n }),
    MoneyError,
  )
  assert.throws(
    () => assertPartition({ priceWei: 100n, feeWei: 60n, royaltyWei: 60n, proceedsWei: -20n }),
    MoneyError,
  )
  assert.throws(() => splitSale({ priceWei: 100n, platformFeeBps: 5_000, royaltyBps: 5_000 }), MoneyError)
})

/**
 * §8.5's multi-recipient royalty, which is what makes a remix payable.
 *
 * "Multi-recipient splits use largest-remainder allocation with an index tie-break so two replicas
 * compute the same split, and zero-weight recipients never receive dust."
 */
test('allocate distributes every wei, deterministically, and never dusts a zero weight', () => {
  // 10 wei across three equal shares: 3, 3, 3 and one left over, which goes to the FIRST by the
  // index tie-break — not to a random one, which is what makes two replicas agree.
  const three = allocate(10n, [1, 1, 1])
  assert.deepEqual(three, [4n, 3n, 3n])
  assert.equal(three.reduce((a, b) => a + b, 0n), 10n)

  // A zero weight receives nothing, including dust.
  const withZero = allocate(7n, [1, 0, 1])
  assert.equal(withZero[1], 0n)
  assert.equal(withZero.reduce((a, b) => a + b, 0n), 7n)

  // Deterministic: the same inputs give the same ARRAY, not the same multiset.
  for (let i = 0; i < 50; i += 1) {
    assert.deepEqual(allocate(1_000_003n, [7, 3, 5, 0, 11]), allocate(1_000_003n, [7, 3, 5, 0, 11]))
  }

  // Everything is allocated, for a lot of shapes.
  for (const total of [0n, 1n, 2n, 999n, 10n ** 18n, 10n ** 30n + 7n]) {
    for (const weights of [[1], [1, 1], [1, 2, 3], [0, 0, 1], [5, 5, 5, 5, 5, 5, 5]]) {
      const shares = allocate(total, weights)
      assert.equal(shares.reduce((a, b) => a + b, 0n), total, `${total} across ${weights}`)
    }
  }

  // All-zero weights allocate nothing rather than dividing by zero.
  assert.deepEqual(allocate(100n, [0, 0]), [0n, 0n])
})
