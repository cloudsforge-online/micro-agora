// Deterministic, seedable PRNG — a faithful TypeScript port of the C# `Rng` in
// kindred-resonance (src/Kindred.Core/Rng.cs). It is xorshift128+ seeded through
// SplitMix64, computed over 64-bit UNSIGNED integers.
//
// This file is the linchpin of the whole port. The C# engine is the reference
// implementation, and the only way a recorded battle replays byte-identically is
// if the exact same rolls come out of the exact same seed. JavaScript numbers
// cannot hold 64-bit unsigned integers, so the state and every arithmetic step
// are done in BigInt masked to 64 bits — `(x + y) & MASK64`, `(x * y) & MASK64`,
// and logical (not arithmetic) right shifts, which coincide for non-negative
// BigInts. NextDouble()'s output is a 53-bit mantissa fed into an IEEE double, so
// it is bit-identical to the C# `(NextRaw() >> 11) * (1.0 / 2^53)`.
//
// Do not "optimise" this to Number math. The determinism is the feature.

const MASK64 = (1n << 64n) - 1n;
const TWO_POW_53 = 9007199254740992; // 2^53, the C# literal 9007199254740992.0

/** SplitMix64 step. Mirrors the C# `SplitMix(ref ulong x)`: it mutates the
 *  running seed (passed by reference there) and returns the mixed output. */
function splitMix(state: { x: bigint }): bigint {
  state.x = (state.x + 0x9e3779b97f4a7c15n) & MASK64;
  let z = state.x;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}

export class Rng {
  private s0: bigint;
  private s1: bigint;
  /** The original seed, unchanged (the C# `Seed` property). */
  readonly seed: bigint;

  constructor(seed: bigint | number) {
    const s = BigInt(seed) & MASK64;
    this.seed = s;
    // SplitMix64 to seed the state so even small seeds diverge well. The C#
    // passes `seed` by ref into SplitMix twice, so the second call sees the
    // value the first call advanced it to.
    const state = { x: s };
    this.s0 = splitMix(state);
    this.s1 = splitMix(state);
    if (this.s0 === 0n && this.s1 === 0n) this.s1 = 0x9e3779b97f4a7c15n;
  }

  private nextRaw(): bigint {
    let s1 = this.s0;
    const s0 = this.s1;
    this.s0 = s0;
    s1 ^= (s1 << 23n) & MASK64;
    this.s1 = (s1 ^ s0 ^ (s1 >> 18n) ^ (s0 >> 5n)) & MASK64;
    return (this.s1 + s0) & MASK64;
  }

  /** Uniform double in [0, 1). Bit-identical to the C#. */
  nextDouble(): number {
    // (NextRaw() >> 11) is at most 53 bits, so Number() is exact.
    return Number(this.nextRaw() >> 11n) * (1.0 / TWO_POW_53);
  }

  /** Uniform int in [0, maxExclusive). C# casts (int)(double) — truncates toward
   *  zero; the product is non-negative so Math.trunc === Math.floor here. */
  next(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.trunc(this.nextDouble() * maxExclusive);
  }

  /** Uniform int in [min, max] inclusive. */
  range(minInclusive: number, maxInclusive: number): number {
    if (maxInclusive <= minInclusive) return minInclusive;
    return minInclusive + this.next(maxInclusive - minInclusive + 1);
  }

  /** True with the given percent chance (0–100). */
  chance(percent: number): boolean {
    if (percent <= 0) return false;
    if (percent >= 100) return true;
    return this.nextDouble() * 100.0 < percent;
  }

  /** Pick a weighted item; weights need not sum to any total. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    let total = 0;
    for (const it of items) total += weight(it);
    if (total <= 0) {
      const pick = items[this.next(items.length)];
      if (pick === undefined) throw new Error('weighted: empty list');
      return pick;
    }
    let roll = this.next(total);
    for (const item of items) {
      roll -= weight(item);
      if (roll < 0) return item;
    }
    const last = items[items.length - 1];
    if (last === undefined) throw new Error('weighted: empty list');
    return last;
  }
}
