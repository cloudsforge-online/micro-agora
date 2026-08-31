// Determinism, proven the way the doc demands (20-aetherholm.md §9.1): two resolutions of one
// battle from stored inputs produce one digest, byte-identical — and the digest test is
// MUTATION-CHECKED: change any input and the digest must change, or the determinism claim is a
// hash of nothing.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ROUNDS,
  battleDigest,
  battleSeed,
  canonicalise,
  resolveBattle,
  windAdvantageBp,
  type BattleInput,
} from './battles.ts';

const BATTLE_ID = '0198c0de-0000-7000-8000-000000000001';

function input(overrides: Partial<BattleInput> = {}): BattleInput {
  return {
    battleId: BATTLE_ID,
    seed: 1234567890123456789n,
    attacker: { ships: { cutter: 10, gunship: 4, hauler: 3 }, bulwarkLevel: 0 },
    defender: { ships: { cutter: 6, corvette: 5 }, bulwarkLevel: 2 },
    windBp: 10800,
    ...overrides,
  };
}

test('battles: byte-identical on re-resolution — same inputs, same report, same digest', () => {
  const first = resolveBattle(input());
  const second = resolveBattle(input());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(battleDigest(input(), first), battleDigest(input(), second));
  assert.match(battleDigest(input(), first), /^[0-9a-f]{64}$/);
});

test('battles: the digest is a claim about the INPUTS — change any one and it changes', () => {
  const base = battleDigest(input(), resolveBattle(input()));
  const mutations: BattleInput[] = [
    input({ battleId: '0198c0de-0000-7000-8000-000000000002' }),
    input({ seed: 1234567890123456790n }),
    input({ windBp: 10801 }),
    input({ attacker: { ships: { cutter: 10, gunship: 4, hauler: 4 }, bulwarkLevel: 0 } }),
    input({ defender: { ships: { cutter: 6, corvette: 5 }, bulwarkLevel: 3 } }),
  ];
  for (const [index, mutated] of mutations.entries()) {
    const digest = battleDigest(mutated, resolveBattle(mutated));
    assert.notEqual(digest, base, `mutation ${index} left the digest unchanged`);
  }
});

test('battles: a tampered RESULT fails the digest even with untouched inputs', () => {
  // The chronicle's replay check in miniature: re-resolve from stored inputs, compare digests.
  const honest = resolveBattle(input());
  const tampered = { ...honest, winner: honest.winner === 'attacker' ? ('defender' as const) : ('attacker' as const) };
  assert.notEqual(battleDigest(input(), tampered), battleDigest(input(), honest));
});

test('battles: the PRNG stream is its own — battleSeed differs by battle and by season', () => {
  assert.equal(battleSeed('b1', 5n), battleSeed('b1', 5n));
  assert.notEqual(battleSeed('b1', 5n), battleSeed('b2', 5n));
  assert.notEqual(battleSeed('b1', 5n), battleSeed('b1', 6n));
});

test('battles: overwhelming force wins; an empty sky defends nothing', () => {
  const rout = resolveBattle(
    input({
      attacker: { ships: { ironclad: 40, flagship: 5 }, bulwarkLevel: 0 },
      defender: { ships: { skiff: 2 }, bulwarkLevel: 0 },
    }),
  );
  assert.equal(rout.winner, 'attacker');
  assert.deepEqual(rout.defenderRemaining, {});
  const noDefence = resolveBattle(input({ defender: { ships: {}, bulwarkLevel: 5 } }));
  assert.equal(noDefence.winner, 'attacker');
  assert.equal(noDefence.rounds, 0, 'nobody to fight is nobody fought');
});

test('battles: the tie goes to the defender, who did not choose the fight', () => {
  // The exact tie that CAN be forced: no attacker at all is 0 hull against 0-or-more, and equal
  // surviving hull must never award the sky to the side that came to take it.
  const emptyHanded = resolveBattle(
    input({ attacker: { ships: {}, bulwarkLevel: 0 }, defender: { ships: {}, bulwarkLevel: 0 } }),
  );
  assert.equal(emptyHanded.winner, 'defender');
  assert.equal(emptyHanded.rounds, 0);
  // And an ordinary skirmish still ends inside the round cap.
  const mirror = resolveBattle(
    input({
      attacker: { ships: { skiff: 1 }, bulwarkLevel: 0 },
      defender: { ships: { skiff: 1 }, bulwarkLevel: 0 },
      windBp: 10000,
    }),
  );
  assert.ok(mirror.rounds <= MAX_ROUNDS);
});

test('battles: the wind is a modifier, not a verdict — bounded ±25%', () => {
  assert.equal(windAdvantageBp(10000), 10000);
  assert.ok(windAdvantageBp(5000) > 10000, 'riding the lane in sharpens the attack');
  assert.ok(windAdvantageBp(20000) < 10000, 'beating upwind blunts it');
  assert.equal(windAdvantageBp(-100000), 12500);
  assert.equal(windAdvantageBp(100000), 7500);
  // And it genuinely reaches the arithmetic: same orders, different wind, different outcome
  // digest (the volley damage differs).
  const calm = resolveBattle(input({ windBp: 10000 }));
  const gale = resolveBattle(input({ windBp: 12500 }));
  assert.notEqual(JSON.stringify(calm.volleys), JSON.stringify(gale.volleys));
});

test('battles: initiative orders the round — the Skiff (10) acts before the Ironclad (3)', () => {
  const result = resolveBattle(
    input({
      attacker: { ships: { skiff: 5 }, bulwarkLevel: 0 },
      defender: { ships: { ironclad: 1 }, bulwarkLevel: 0 },
    }),
  );
  const firstRound = result.volleys.filter((volley) => volley.round === 1);
  assert.equal(firstRound[0]!.class, 'skiff');
});

test('battles: canonicalise sorts keys and writes bigints as decimal strings', () => {
  assert.equal(canonicalise({ b: 2n, a: 1 }), '{"a":1,"b":"2"}');
  assert.equal(canonicalise([1n, null, undefined]), '["1",null,null]');
  assert.equal(canonicalise({ x: undefined, y: 'z' }), '{"y":"z"}');
});

test('battles: a degenerate wind is refused rather than resolved wrongly', () => {
  assert.throws(() => resolveBattle(input({ windBp: 0 })), RangeError);
  assert.throws(() => resolveBattle(input({ windBp: 1.5 })), RangeError);
});
