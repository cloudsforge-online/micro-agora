/**
 * Deterministic world generation.
 *
 * An archipelago is generated from a seed and NOTHING else — the Worlds rule that determinism is
 * proven, not claimed (20-aetherholm.md §6). Two calls with one seed must produce byte-identical
 * islands, in order, because the chronicle of a sealed season will one day replay from stored
 * inputs and a generator with hidden state would make that a lie. `world.test.ts` asserts it by
 * comparing serialised output.
 *
 * The PRNG is splitmix64 over `bigint`. Not a *good* generator — an utterly stable one, chosen
 * because its whole state is one u64 and its reference implementation fits in ten lines that will
 * never need a dependency bump. The wind lattice re-rolls from the same seed in phase 2 and must
 * agree with these islands forever.
 */

import { createHash, randomBytes } from 'node:crypto';

const MASK64 = (1n << 64n) - 1n;

/** splitmix64. Returns the next state and a value; pure so a caller can fork deterministically. */
export function splitmix64(state: bigint): { readonly next: bigint; readonly value: bigint } {
  const next = (state + 0x9e3779b97f4a7c15n) & MASK64;
  let z = next;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  z = z ^ (z >> 31n);
  return { next, value: z };
}

export const BANDS = ['shallows', 'midreach', 'highwind'] as const;
export type Band = (typeof BANDS)[number];

/** ~200 islands for the public season archipelago (20-aetherholm.md §2). */
export const PUBLIC_ISLAND_COUNT = 200;
/** A Private Skerry is a small private archipelago instance: a dozen isles for a group. */
export const SKERRY_ISLAND_COUNT = 12;
/** 12 city plots + 1 communal Aether well per island, fixed by the design's table in §1. */
export const PLOTS_PER_ISLAND = 12;

export interface GeneratedIsland {
  readonly idx: number;
  readonly band: Band;
  readonly plots: number;
}

/**
 * Generate `count` islands from `seed`.
 *
 * Band distribution is weighted toward the Shallows (roughly 3:2:1) so the rich Highwind isles
 * are scarce — scarcity is the design's engine — but every band is guaranteed present for any
 * count >= 3, because a skerry with no Highwind would be a private world with a system missing.
 */
export function generateIslands(seed: bigint, count: number): readonly GeneratedIsland[] {
  if (!Number.isInteger(count) || count < 3) {
    throw new RangeError(`an archipelago needs at least 3 islands (got ${count})`);
  }
  let state = seed & MASK64;
  const islands: GeneratedIsland[] = [];
  for (let idx = 0; idx < count; idx += 1) {
    const { next, value } = splitmix64(state);
    state = next;
    const roll = Number(value % 6n);
    const band: Band = roll < 3 ? 'shallows' : roll < 5 ? 'midreach' : 'highwind';
    islands.push({ idx, band, plots: PLOTS_PER_ISLAND });
  }
  // Guarantee all three bands exist by pinning the first three indices' bands deterministically
  // when a band came out empty. Deterministic: depends only on what the roll produced.
  const present = new Set(islands.map((island) => island.band));
  let pin = 0;
  for (const band of BANDS) {
    if (!present.has(band)) {
      islands[pin] = { ...islands[pin]!, band };
      pin += 1;
    }
  }
  return islands;
}

/* ------------------------------------------------------------------ the wind lattice */

/**
 * The lattice is generated from ITS OWN stream, derived from the season seed by hashing a domain
 * tag — never by continuing the island stream. Continuing it would mean adding one island changes
 * every lane, and worse: phase-1 archipelagos already exist in databases, so the lattice must be
 * derivable TODAY from a seed whose island rolls were consumed long ago. The tag makes each
 * stream independently reproducible from the stored seed alone.
 */
function taggedSeed(tag: string, seed: bigint): bigint {
  const digest = createHash('sha256').update(`${tag}:${seed.toString()}`, 'utf8').digest();
  let folded = 0n;
  for (let index = 0; index < 8; index += 1) folded = (folded << 8n) | BigInt(digest[index]!);
  return folded & MASK64;
}

/** A lane's base traversal at multiplier 10000 and ship factor 10000: two hours. */
export const BASE_LANE_SECONDS = 7200;
/** Directed chords rolled per island, on top of the connectivity ring. */
export const CHORDS_PER_ISLAND = 2;
/** The direction multiplier's domain, in basis points: half-time riding the wind to double against it. */
export const LANE_MULTIPLIER_MIN_BP = 5000;
export const LANE_MULTIPLIER_MAX_BP = 20000;

export interface GeneratedLane {
  readonly fromIdx: number;
  readonly toIdx: number;
  /** Direction multiplier in basis points. A→B and B→A are separate lanes with separate rolls. */
  readonly multiplierBp: number;
  /** `BASE_LANE_SECONDS * multiplierBp / 10000`, floor — stored so SQL and TS cannot disagree. */
  readonly travelSeconds: number;
}

function rollMultiplierBp(value: bigint): number {
  const span = BigInt(LANE_MULTIPLIER_MAX_BP - LANE_MULTIPLIER_MIN_BP + 1);
  return LANE_MULTIPLIER_MIN_BP + Number(value % span);
}

/**
 * Generate the directed wind lattice for `count` islands from `seed`.
 *
 * Shape: a full ring (i → i+1 → … → i) in BOTH directions so the graph is strongly connected by
 * construction — no fleet can be marooned by a bad roll — plus `CHORDS_PER_ISLAND` rolled chords
 * per island, each direction rolled separately. That separateness is the design: A→B may be two
 * hours while B→A is five (20-aetherholm.md §2), so position IS strategy.
 *
 * Deterministic and order-stable: one seed yields byte-identical lanes forever, because the
 * chronicle of a sealed season replays geography from the stored seed.
 */
export function generateLanes(seed: bigint, count: number): readonly GeneratedLane[] {
  if (!Number.isInteger(count) || count < 3) {
    throw new RangeError(`a lattice needs at least 3 islands (got ${count})`);
  }
  let state = taggedSeed('lattice', seed);
  const roll = (): bigint => {
    const next = splitmix64(state);
    state = next.next;
    return next.value;
  };
  const seen = new Set<string>();
  const lanes: GeneratedLane[] = [];
  const add = (fromIdx: number, toIdx: number): void => {
    if (fromIdx === toIdx) return;
    const key = `${fromIdx}>${toIdx}`;
    if (seen.has(key)) return;
    seen.add(key);
    const multiplierBp = rollMultiplierBp(roll());
    lanes.push({
      fromIdx,
      toIdx,
      multiplierBp,
      travelSeconds: Math.floor((BASE_LANE_SECONDS * multiplierBp) / 10000),
    });
  };
  for (let idx = 0; idx < count; idx += 1) {
    add(idx, (idx + 1) % count);
    add((idx + 1) % count, idx);
  }
  for (let idx = 0; idx < count; idx += 1) {
    for (let chord = 0; chord < CHORDS_PER_ISLAND; chord += 1) {
      const target = Number(roll() % BigInt(count));
      // Both directions, rolled separately — the chord exists both ways, the WIND does not.
      add(idx, target);
      add(target, idx);
    }
  }
  return lanes;
}

/* ------------------------------------------------------------------ the aether spires */

/** One spire per ~40 islands, never fewer than three: a season with one objective is a race,
 *  three is a war. 200 public islands → 5 spires; a 12-isle skerry → 3. */
export function spireCountFor(islandCount: number): number {
  return Math.max(3, Math.floor(islandCount / 40));
}

/**
 * Which island indices carry Aether Spires, derived from the seed on its own tagged stream.
 *
 * Returned ascending. Deterministic re-derivation is the point: phase-1 rows predate the flag,
 * so the backfill recomputes from the stored seed and MUST agree with what a fresh generation
 * would have said.
 */
export function spireIdxsFor(seed: bigint, islandCount: number): readonly number[] {
  if (!Number.isInteger(islandCount) || islandCount < 3) {
    throw new RangeError(`an archipelago needs at least 3 islands (got ${islandCount})`);
  }
  let state = taggedSeed('spires', seed);
  const chosen = new Set<number>();
  const wanted = spireCountFor(islandCount);
  while (chosen.size < wanted) {
    const next = splitmix64(state);
    state = next.next;
    chosen.add(Number(next.value % BigInt(islandCount)));
  }
  return [...chosen].sort((a, b) => a - b);
}

/** A fresh 64-bit seed from the platform CSPRNG, as a decimal string for numeric(20,0). */
export function newSeed(random: () => Buffer = randomBytes8): bigint {
  const bytes = random();
  let seed = 0n;
  for (const byte of bytes) seed = (seed << 8n) | BigInt(byte);
  return seed & MASK64;
}

function randomBytes8(): Buffer {
  return randomBytes(8);
}

/**
 * The seed a Private Skerry is generated from: sha256 of the entitlement id, folded to 64 bits.
 *
 * Derived rather than random so the provision path is a pure function of its idempotency key —
 * a replay could not mint a second geography even if the uniqueness constraint were somehow lost.
 */
export function skerrySeed(entitlementId: string): bigint {
  const digest = createHash('sha256').update(entitlementId, 'utf8').digest();
  let seed = 0n;
  for (let index = 0; index < 8; index += 1) seed = (seed << 8n) | BigInt(digest[index]!);
  return seed & MASK64;
}
