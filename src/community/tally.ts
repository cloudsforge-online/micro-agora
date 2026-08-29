/**
 * Counting the vote.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY NUMBER IN THIS FILE IS A `bigint`. THERE IS NO FLOAT ANYWHERE NEAR A VOTE COUNT.**
 *
 * Not tidiness. Two concrete failures this rules out:
 *
 *   1. **A token-weighted vote is a uint256.** A community holding 10^24 smallest units of a
 *      token is ordinary, and a IEEE 754 double stops being exact at 2^53 ≈ 9·10^15. It does not
 *      throw at that point, it silently rounds — so two voters with different holdings can be
 *      counted as having the same weight, and the resulting tally is wrong in a way no test that
 *      uses small numbers will ever show.
 *
 *   2. **A threshold is a ratio, and a ratio computed in floating point is not deterministic
 *      across the places it is computed.** `forWeight / total >= 0.6667` can answer differently
 *      from the same comparison done at another precision, which means a proposal could pass in
 *      the tally job and fail in the API's read of it. So the comparison is cross-multiplied:
 *
 *          for * 10000 >= (for + against) * thresholdBps
 *
 *      Both sides are exact integers of unbounded size. There is no division in this file.
 *
 * **`threshold_bps` IS BASIS POINTS OF THE DECIDED VOTE.** The denominator is `for + against`;
 * abstentions are deliberately not in it. An abstention is a member saying "I turned up and I do
 * not wish to decide this" — counting it as opposition would make abstaining a vote against, and
 * counting it in the denominator makes turnout itself an argument for rejection. It DOES count
 * toward quorum, which is the question it actually answers: was the community engaged enough for
 * this to be legitimate.
 *
 * **QUORUM IS A FLOOR ON PARTICIPATION, CHECKED FIRST.** A proposal that clears its threshold on
 * two votes out of a thousand members has not passed; it has been decided by two people. Quorum
 * is stored as an absolute weight rather than a percentage for the same reason the threshold is
 * cross-multiplied: a percentage of a membership that changes between proposal and close is a
 * moving target, and nobody voting can tell what they are aiming at.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export type Choice = 'for' | 'against' | 'abstain'

export const CHOICES: readonly Choice[] = Object.freeze(['for', 'against', 'abstain'])

export function isChoice(value: string): value is Choice {
  return (CHOICES as readonly string[]).includes(value)
}

/** Basis points. 10000 = 100%. An integer, always. */
export const BPS = 10_000

export interface Weights {
  readonly forWeight: bigint
  readonly againstWeight: bigint
  readonly abstainWeight: bigint
  /** How many `votes` rows exist. A head count, distinct from weight in every model but one. */
  readonly voterCount: number
}

export interface TallyRules {
  /** Minimum total weight that must have voted, abstentions included. */
  readonly quorum: bigint
  /** Basis points of `for + against` that `for` must reach. 1..10000. */
  readonly thresholdBps: number
}

export type TallyOutcome = 'passed' | 'rejected'

export interface Tally extends Weights {
  /** `for + against + abstain`. What quorum is measured against. */
  readonly totalWeight: bigint
  /** `for + against`. The denominator of the threshold. */
  readonly decidedWeight: bigint
  readonly quorumMet: boolean
  readonly thresholdMet: boolean
  readonly outcome: TallyOutcome
}

/**
 * Decide a proposal from its weights and its rules.
 *
 * Pure, total, and deterministic — a proposal's outcome must be recomputable from the recorded
 * votes for as long as the record exists. Nothing here reads a clock, a database or a config.
 */
export function tally(weights: Weights, rules: TallyRules): Tally {
  if (!Number.isInteger(rules.thresholdBps) || rules.thresholdBps < 1 || rules.thresholdBps > BPS) {
    // Refused rather than clamped. A threshold outside 1..10000 bps is not a fraction of anything,
    // and silently clamping it would decide a proposal under a rule nobody chose.
    throw new RangeError(`thresholdBps must be an integer between 1 and ${BPS}`)
  }
  if (rules.quorum <= 0n) throw new RangeError('quorum must be positive')
  for (const value of [weights.forWeight, weights.againstWeight, weights.abstainWeight]) {
    if (value < 0n) throw new RangeError('a vote weight may not be negative')
  }

  const totalWeight = weights.forWeight + weights.againstWeight + weights.abstainWeight
  const decidedWeight = weights.forWeight + weights.againstWeight

  const quorumMet = totalWeight >= rules.quorum

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE CROSS-MULTIPLICATION. `for / decided >= bps / 10000` without ever dividing.
  //
  // `decidedWeight === 0n` is the case worth naming: every vote was an abstention. `0 >= 0` is
  // true for any threshold, which would pass a proposal nobody supported. So it is excluded
  // explicitly — an all-abstain vote decides nothing, whatever its turnout.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const thresholdMet =
    decidedWeight > 0n &&
    weights.forWeight * BigInt(BPS) >= decidedWeight * BigInt(rules.thresholdBps)

  return {
    ...weights,
    totalWeight,
    decidedWeight,
    quorumMet,
    thresholdMet,
    outcome: quorumMet && thresholdMet ? 'passed' : 'rejected',
  }
}

/**
 * Why a proposal was rejected, as a closed set of reason codes.
 *
 * A member whose proposal failed is owed the reason. "Rejected" alone is the answer that makes
 * governance feel arbitrary, and 04-domain-model §10.4's "why was I blocked" applies here as much
 * as it does to a policy decision.
 */
export type RejectionReason = 'quorum_not_met' | 'threshold_not_met' | 'no_decided_votes'

export function rejectionReason(result: Tally): RejectionReason | null {
  if (result.outcome === 'passed') return null
  if (!result.quorumMet) return 'quorum_not_met'
  if (result.decidedWeight === 0n) return 'no_decided_votes'
  return 'threshold_not_met'
}
