/**
 * Quorum and threshold, in integers.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE TESTS THAT MATTER ARE THE BOUNDARIES AND THE BIG NUMBERS.**
 *
 * A tally that is right for 3-for-1-against is right for almost any implementation, including a
 * floating-point one. The two things that separate a correct implementation from a plausible one:
 *
 *   1. **Exactly at the boundary.** `for / decided == threshold` must PASS (it met the threshold)
 *      and one unit less must FAIL. A float implementation gets this wrong for thirds and sixths —
 *      `2/3 >= 0.6667` is false — and the failure is a proposal that had the votes and did not
 *      pass, which is unarguable and unexplainable.
 *
 *   2. **Above 2^53.** A token-weighted vote is a uint256. `Number` stops being exact at
 *      9,007,199,254,740,992 and does not throw; it rounds. Two voters with different holdings
 *      would be counted as equal, and no test using small numbers would ever show it.
 *
 * There is also a source-level check at the end: no `Number(`, no `parseFloat`, no `/` in
 * `tally.ts`. An omission has no behaviour to test, and "somebody added a division" is an omission
 * of exactly that kind.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BPS, CHOICES, isChoice, rejectionReason, tally } from './tally.ts'

const weights = (f: bigint, a: bigint, ab = 0n, n = 0) => ({
  forWeight: f,
  againstWeight: a,
  abstainWeight: ab,
  voterCount: n,
})

/* ------------------------------------------------------------------ quorum */

test('quorum is met at exactly the quorum, and not one below', { skip: false }, () => {
  assert.equal(tally(weights(5n, 0n), { quorum: 5n, thresholdBps: 5_000 }).quorumMet, true)
  assert.equal(tally(weights(4n, 0n), { quorum: 5n, thresholdBps: 5_000 }).quorumMet, false)
})

test('abstentions count toward quorum', () => {
  // The question quorum answers is "was the community engaged enough for this to be legitimate",
  // and somebody who turned up to abstain turned up.
  const result = tally(weights(2n, 0n, 3n), { quorum: 5n, thresholdBps: 5_000 })
  assert.equal(result.totalWeight, 5n)
  assert.equal(result.quorumMet, true)
})

test('a proposal that clears the threshold but not the quorum is rejected', () => {
  const result = tally(weights(3n, 0n), { quorum: 100n, thresholdBps: 5_000 })
  assert.equal(result.thresholdMet, true)
  assert.equal(result.outcome, 'rejected')
  assert.equal(rejectionReason(result), 'quorum_not_met')
})

/* ------------------------------------------------------------------ threshold */

test('the threshold is met AT the threshold, not merely above it', () => {
  // 50% of 10 decided is 5. Exactly 5 passes.
  assert.equal(tally(weights(5n, 5n), { quorum: 1n, thresholdBps: 5_000 }).thresholdMet, true)
  assert.equal(tally(weights(4n, 6n), { quorum: 1n, thresholdBps: 5_000 }).thresholdMet, false)
})

test('two thirds is exact, which a float implementation is not', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // 6667 bps is the honest spelling of "two thirds" in basis points, and 2/3 in floating point is
  // 0.6666666666666666 — strictly LESS than 0.6667. So `2 for, 1 against` at a two-thirds
  // threshold FAILS under a float implementation and passes under this one only if the community
  // wrote 6666. The cross-multiplication makes the arithmetic exact and the answer explicable:
  // 2 * 10000 = 20000, 3 * 6667 = 20001, so 6667 bps genuinely is not met by 2 of 3, and 6666 is.
  //
  // This is the test that says the comparison is `for * 10000 >= decided * bps` and nothing else.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  assert.equal(tally(weights(2n, 1n), { quorum: 1n, thresholdBps: 6_667 }).thresholdMet, false)
  assert.equal(tally(weights(2n, 1n), { quorum: 1n, thresholdBps: 6_666 }).thresholdMet, true)
  // And at scale the same ratio answers identically, which a float would not guarantee.
  assert.equal(tally(weights(2_000_000n, 1_000_000n), { quorum: 1n, thresholdBps: 6_666 }).thresholdMet, true)
  assert.equal(tally(weights(2_000_000n, 1_000_000n), { quorum: 1n, thresholdBps: 6_667 }).thresholdMet, false)
})

test('abstentions are NOT in the threshold denominator', () => {
  // 1 for, 0 against, 98 abstain. The decided vote is unanimous, so a 100% threshold is met.
  // Counting abstentions in the denominator would make turnout an argument for rejection.
  const result = tally(weights(1n, 0n, 98n), { quorum: 1n, thresholdBps: BPS })
  assert.equal(result.decidedWeight, 1n)
  assert.equal(result.thresholdMet, true)
  assert.equal(result.outcome, 'passed')
})

test('an all-abstain vote decides nothing, whatever its turnout', () => {
  // `0 >= 0` is true for any threshold, which would pass a proposal nobody supported. Excluded
  // explicitly in `tally`, and this is the line that stops it coming back.
  const result = tally(weights(0n, 0n, 1_000n), { quorum: 1n, thresholdBps: 1 })
  assert.equal(result.quorumMet, true)
  assert.equal(result.thresholdMet, false)
  assert.equal(result.outcome, 'rejected')
  assert.equal(rejectionReason(result), 'no_decided_votes')
})

test('a unanimity threshold means unanimous', () => {
  assert.equal(tally(weights(10n, 0n), { quorum: 1n, thresholdBps: BPS }).outcome, 'passed')
  assert.equal(tally(weights(10n, 1n), { quorum: 1n, thresholdBps: BPS }).outcome, 'rejected')
})

test('a 1 bps threshold passes on a single supporting unit', () => {
  // The other end of the range. 1 bps of 10000 decided is 1, so one supporter is enough — which is
  // a community's right to choose and must not be silently clamped to something more sensible.
  assert.equal(tally(weights(1n, 9_999n), { quorum: 1n, thresholdBps: 1 }).thresholdMet, true)
  assert.equal(tally(weights(1n, 10_000n), { quorum: 1n, thresholdBps: 1 }).thresholdMet, false)
})

/* ------------------------------------------------------------------ big numbers */

test('a token-weighted tally above 2^53 is exact', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Two holdings that differ by ONE smallest unit, both far above Number.MAX_SAFE_INTEGER. As
  // doubles they are the same value, so a float implementation would call this a tie and apply the
  // >= at the threshold — passing a proposal that lost by one unit, or losing one that won.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const huge = 2n ** 80n
  const result = tally(weights(huge, huge + 1n), { quorum: 1n, thresholdBps: 5_000 })
  assert.equal(result.decidedWeight, huge * 2n + 1n)
  assert.equal(result.thresholdMet, false, 'a one-unit deficit above 2^53 was rounded away')

  const other = tally(weights(huge + 1n, huge), { quorum: 1n, thresholdBps: 5_000 })
  assert.equal(other.thresholdMet, true)

  // And the proof that this is not merely a large-number test: as doubles the two are equal.
  assert.equal(Number(huge), Number(huge + 1n))
})

test('a quorum above 2^53 is compared exactly', () => {
  const quorum = 2n ** 90n
  assert.equal(tally(weights(quorum - 1n, 0n), { quorum, thresholdBps: 1 }).quorumMet, false)
  assert.equal(tally(weights(quorum, 0n), { quorum, thresholdBps: 1 }).quorumMet, true)
})

/* ------------------------------------------------------------------ refusals */

test('a threshold outside 1..10000 bps is refused rather than clamped', () => {
  // Clamping would decide a proposal under a rule nobody chose.
  for (const bps of [0, -1, 10_001, 1.5, Number.NaN]) {
    assert.throws(() => tally(weights(1n, 0n), { quorum: 1n, thresholdBps: bps }), RangeError)
  }
})

test('a zero or negative quorum is refused', () => {
  assert.throws(() => tally(weights(1n, 0n), { quorum: 0n, thresholdBps: 1 }), RangeError)
  assert.throws(() => tally(weights(1n, 0n), { quorum: -1n, thresholdBps: 1 }), RangeError)
})

test('a negative weight is refused', () => {
  assert.throws(() => tally(weights(-1n, 0n), { quorum: 1n, thresholdBps: 1 }), RangeError)
  assert.throws(() => tally(weights(1n, -1n), { quorum: 1n, thresholdBps: 1 }), RangeError)
  assert.throws(() => tally(weights(1n, 0n, -1n), { quorum: 1n, thresholdBps: 1 }), RangeError)
})

/* ------------------------------------------------------------------ the vocabulary */

test('the choice set is closed', () => {
  assert.deepEqual([...CHOICES], ['for', 'against', 'abstain'])
  assert.equal(isChoice('for'), true)
  assert.equal(isChoice('yes'), false)
  assert.equal(isChoice('FOR'), false)
})

test('a passed tally has no rejection reason', () => {
  assert.equal(rejectionReason(tally(weights(5n, 0n), { quorum: 1n, thresholdBps: 5_000 })), null)
})

/* ------------------------------------------------------------------ source-level */

test('there is no floating-point arithmetic anywhere in tally.ts', () => {
  // An omission has no behaviour to test — "somebody added a division" produces a wrong answer
  // only for the inputs nobody tried. So the SHAPE of the file is asserted, in the same spirit as
  // `routeidempotency.test.ts`.
  const source = readFileSync(fileURLToPath(new URL('./tally.ts', import.meta.url)), 'utf8')
  const code = source
    // Strip block comments and line comments, so the prose above may discuss division freely.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  for (const forbidden of ['Number(', 'parseFloat', 'parseInt', 'Math.']) {
    assert.ok(
      !code.includes(forbidden),
      `tally.ts contains ${forbidden} — a vote count and a treasury amount are integers`,
    )
  }
  // Division, excluding the `/` of a regex or a path. There is none of either in the code, so a
  // plain search is precise enough and a false positive would be a real finding.
  assert.ok(!/[^/*]\/[^/*]/.test(code), 'tally.ts contains a division — cross-multiply instead')

  // And the check is not vacuous: the comparison it is protecting is present.
  assert.ok(
    code.includes('* BigInt(BPS)') && code.includes('* BigInt(rules.thresholdBps)'),
    'the cross-multiplied threshold comparison is gone — this test is now guarding nothing',
  )
})
