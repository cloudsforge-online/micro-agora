// Deterministic world generation: same seed, byte-identical islands. This is the determinism
// claim of 20-aetherholm.md §6 asserted the way emberkin asserts its RNG — by comparing the
// serialised output, so a drift of one draw or one band fails loudly.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BANDS,
  PUBLIC_ISLAND_COUNT,
  SKERRY_ISLAND_COUNT,
  generateIslands,
  newSeed,
  skerrySeed,
  splitmix64,
} from './world.ts';

test('world: splitmix64 matches the reference vectors', () => {
  // Reference: the first three outputs of splitmix64 seeded with 1234567, as published in the
  // xoshiro/splitmix64 reference implementation's test output.
  let state = 1234567n;
  const expected = [6457827717110365317n, 3203168211198807973n, 9817491932198370423n];
  for (const want of expected) {
    const { next, value } = splitmix64(state);
    state = next;
    assert.equal(value, want);
  }
});

test('world: one seed yields byte-identical archipelagos, every time', () => {
  const seed = 987654321n;
  const first = JSON.stringify(generateIslands(seed, PUBLIC_ISLAND_COUNT));
  const second = JSON.stringify(generateIslands(seed, PUBLIC_ISLAND_COUNT));
  assert.equal(first, second);
});

test('world: different seeds yield different geographies', () => {
  const a = JSON.stringify(generateIslands(1n, PUBLIC_ISLAND_COUNT));
  const b = JSON.stringify(generateIslands(2n, PUBLIC_ISLAND_COUNT));
  assert.notEqual(a, b);
});

test('world: the public archipelago is ~200 islands, all three bands, 12 plots each', () => {
  assert.equal(PUBLIC_ISLAND_COUNT, 200);
  const islands = generateIslands(42n, PUBLIC_ISLAND_COUNT);
  assert.equal(islands.length, 200);
  const bands = new Set(islands.map((island) => island.band));
  for (const band of BANDS) assert.ok(bands.has(band), `no ${band} island`);
  for (const island of islands) assert.equal(island.plots, 12);
  // The idx sequence is the identity the schema pins with islands_idx_uniq.
  islands.forEach((island, position) => assert.equal(island.idx, position));
});

test('world: a skerry is small, and still carries all three bands', () => {
  assert.equal(SKERRY_ISLAND_COUNT, 12);
  // Sweep many seeds: the all-bands guarantee must hold for every seed, not the lucky ones.
  for (let raw = 0; raw < 200; raw += 1) {
    const islands = generateIslands(skerrySeed(`ent-${raw}`), SKERRY_ISLAND_COUNT);
    const bands = new Set(islands.map((island) => island.band));
    for (const band of BANDS) assert.ok(bands.has(band), `seed ent-${raw}: no ${band}`);
  }
});

test('world: the skerry seed is a pure function of the entitlement id', () => {
  assert.equal(skerrySeed('ent-1'), skerrySeed('ent-1'));
  assert.notEqual(skerrySeed('ent-1'), skerrySeed('ent-2'));
  const seed = skerrySeed('ent-1');
  assert.ok(seed >= 0n && seed < 1n << 64n);
});

test('world: a fresh seed fits numeric(20,0) and the u64 domain', () => {
  for (let i = 0; i < 100; i += 1) {
    const seed = newSeed();
    assert.ok(seed >= 0n && seed < 1n << 64n);
  }
});

test('world: a degenerate island count is refused', () => {
  assert.throws(() => generateIslands(1n, 2), RangeError);
  assert.throws(() => generateIslands(1n, 2.5), RangeError);
});
