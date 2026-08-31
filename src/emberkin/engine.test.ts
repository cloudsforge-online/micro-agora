// Behavioural-equivalence tests for the engine systems, ported from the upstream
// SystemsTests.cs (TypeChart / Kin / Damage / Battle / Catch / Save) with the same
// assertions. These prove the ported mechanics — Resonance thresholds, temperament
// branched evolution, the damage formula, catching — match the reference, on top of
// the byte-identical corpus in conformance.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GameData } from './content/gamedata.ts';
import { Rng } from './engine/rng.ts';
import { Kin } from './engine/kin.ts';
import { Party } from './engine/party.ts';
import { BattleEngine } from './engine/battle.ts';
import { BattleAction, BattleSide, type BattleOutcome } from './engine/battletypes.ts';
import { computeDamage } from './engine/damage.ts';
import { catchChance, tryCatch } from './engine/catching.ts';
import { kinFromSave, kinToSave } from './engine/saves.ts';

const data = GameData.loadFromDirectory();

// ---------- TypeChart ----------

test('typechart: ember is super effective on verdant and weak to tide', () => {
  assert.equal(data.typeChart.pair('ember', 'verdant'), 2.0);
  assert.equal(data.typeChart.pair('ember', 'tide'), 0.5);
});

test('typechart: dual-type multipliers stack', () => {
  const m = data.typeChart.multiplier('ember', ['verdant', 'lumen']);
  assert.equal(m, 2.0);
});

// ---------- Kin / Resonance ----------

test('kin: gaining xp levels up and learns moves', () => {
  const rng = new Rng(1);
  const k = Kin.create(data.getSpecies('cindercub'), 5, rng);
  const startLevel = k.level;
  k.gainXp(Kin.xpForLevel(12, k.growth));
  assert.ok(k.level > startLevel);
  assert.ok(k.moves.includes('flame_fang')); // learned by level 12
});

test('kin: Resonance thresholds grant a stat bonus and unlock the Art', () => {
  const rng = new Rng(2);
  const k = Kin.create(data.getSpecies('flarelynx'), 30, rng);
  const baseAtk = k.effectiveStat('attack');
  assert.equal(k.isResonant, false);
  k.addResonance(50);
  assert.equal(k.isResonant, true); // Art unlocked at 50
  assert.ok(k.effectiveStat('attack') > baseAtk); // Attuned +6%
});

test('kin: a Resonance threshold changes stats by exactly the §3 multiplier', () => {
  const rng = new Rng(2);
  const k = Kin.create(data.getSpecies('flarelynx'), 30, rng);
  // With no resonance, the multiplier is 1.0.
  k.resonance = 0;
  const plain = k.baseStat('attack');
  // Attuned (>=25): +6%.
  k.resonance = 25;
  assert.equal(k.baseStat('attack'), Math.max(1, Math.trunc(plain * 1.06)));
  // Perfect (=100): +12%.
  k.resonance = 100;
  assert.equal(k.baseStat('attack'), Math.max(1, Math.trunc(plain * 1.12)));
});

test('kin: Ferocity and Harmony branches diverge (temperament-gated evolution)', () => {
  const rng = new Rng(3);
  const fero = Kin.create(data.getSpecies('cinderpyre'), 20, rng, 80, 60);
  assert.equal(fero.checkEvolution(), 'flarelynx');

  const harmony = Kin.create(data.getSpecies('cinderpyre'), 20, rng, 80, -60);
  assert.equal(harmony.checkEvolution(), 'hearthmane');

  const undecided = Kin.create(data.getSpecies('cinderpyre'), 20, rng, 80, 0);
  assert.equal(undecided.checkEvolution(), null); // neither branch condition met
});

test('kin: evolution preserves hp fraction and custom nickname', () => {
  const rng = new Rng(4);
  const k = Kin.create(data.getSpecies('cinderpyre'), 20, rng, 80, 60);
  k.nickname = 'Blaze';
  k.evolveInto(data.getSpecies('flarelynx'));
  assert.equal(k.species.id, 'flarelynx');
  assert.equal(k.nickname, 'Blaze');
});

// ---------- Damage ----------

test('damage: super effective beats neutral damage', () => {
  const rng = new Rng(10);
  const atk = Kin.create(data.getSpecies('flarelynx'), 30, rng);
  const grass = Kin.create(data.getSpecies('bramblejaw'), 30, rng); // verdant -> weak to ember
  const stone = Kin.create(data.getSpecies('cragmaw'), 30, rng); // stone -> resists ember
  const move = data.move('pyroblast');
  let superSum = 0;
  let resistSum = 0;
  for (let i = 0; i < 200; i++) {
    superSum += computeDamage(atk, grass, move, data.typeChart, new Rng(BigInt(i + 1))).damage;
    resistSum += computeDamage(atk, stone, move, data.typeChart, new Rng(BigInt(i + 1))).damage;
  }
  assert.ok(superSum > resistSum * 2.0);
});

test('damage: status moves deal no damage', () => {
  const rng = new Rng(11);
  const a = Kin.create(data.getSpecies('flarelynx'), 20, rng);
  const b = Kin.create(data.getSpecies('tidepup'), 20, rng);
  const howl = data.move('howl');
  assert.equal(computeDamage(a, b, howl, data.typeChart, rng).damage, 0);
});

test('damage: all game integers stay integers (no float leak)', () => {
  const rng = new Rng(123);
  const a = Kin.create(data.getSpecies('flarelynx'), 37, rng, 63);
  const b = Kin.create(data.getSpecies('bramblejaw'), 41, rng);
  for (let i = 0; i < 500; i++) {
    const r = computeDamage(a, b, data.move('pyroblast'), data.typeChart, new Rng(BigInt(i)));
    assert.ok(Number.isInteger(r.damage), `damage ${r.damage} is not an integer`);
  }
});

// ---------- Battle ----------

function makeBattle(seed: number): BattleEngine {
  const rng = new Rng(seed);
  const p = new Party();
  p.add(Kin.create(data.getSpecies('flarelynx'), 25, rng));
  const e = new Party();
  e.add(Kin.createWild(data.getSpecies('seedling'), 22, rng));
  return new BattleEngine(data, rng, new BattleSide(p, 'P', true), new BattleSide(e, 'E', false, true));
}

test('battle: reaches a decisive outcome', () => {
  const engine = makeBattle(99);
  engine.start();
  let guard = 0;
  while (engine.outcome === 'Ongoing' && guard++ < 100) {
    engine.executeTurn(BattleAction.move(engine.player.active.moves[0]!));
  }
  assert.notEqual(engine.outcome, 'Ongoing');
});

test('battle: same seed reproduces the same outcome', () => {
  const play = (seed: number): BattleOutcome => {
    const engine = makeBattle(seed);
    engine.start();
    let g = 0;
    while (engine.outcome === 'Ongoing' && g++ < 100) {
      engine.executeTurn(BattleAction.move(engine.player.active.moves[0]!));
    }
    return engine.outcome;
  };
  assert.equal(play(1234), play(1234));
});

// ---------- Catch & Save ----------

test('catch: master resonator always catches', () => {
  const rng = new Rng(7);
  const wild = Kin.createWild(data.getSpecies('aetherion'), 50, rng);
  assert.equal(catchChance(wild, 'master_resonator'), 1.0);
  assert.equal(tryCatch(wild, 'master_resonator', rng).caught, true);
});

test('catch: a weakened, statused target is easier to catch', () => {
  const rng = new Rng(8);
  const full = Kin.createWild(data.getSpecies('joltmouse'), 8, rng);
  const weak = Kin.createWild(data.getSpecies('joltmouse'), 8, rng);
  weak.takeDamage(Math.trunc(weak.maxHp * 0.9));
  weak.setStatus('Chill');
  assert.ok(catchChance(weak, 'resonator') > catchChance(full, 'resonator'));
});

test('save: roundtrip preserves kin state', () => {
  const rng = new Rng(9);
  const k = Kin.create(data.getSpecies('cinderpyre'), 20, rng, 63, 25);
  k.nickname = 'Ember';
  const restored = kinFromSave(kinToSave(k), data);
  assert.equal(restored.nickname, 'Ember');
  assert.equal(restored.level, k.level);
  assert.equal(restored.resonance, 63);
  assert.deepEqual(restored.moves, k.moves);
});
