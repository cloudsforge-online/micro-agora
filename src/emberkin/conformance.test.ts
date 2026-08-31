// The conformance corpus — the load-bearing proof that the TypeScript port is
// behaviourally equivalent to the C# reference.
//
// src/fixtures/corpus.json was RECORDED by running the upstream C# BattleEngine
// (via a harness that project-references kindred-resonance's Kindred.Core without
// modifying it) over 10 battles chosen to exercise crit, super/not-very-effective,
// STAB, Resonance Arts (spent and the free-at-Perfect-Resonance path), status
// infliction + end-of-turn ticks, catching (break-free then Gotcha), fleeing,
// switching, item use, multi-Kin faint chains, and every outcome (PlayerWin,
// EnemyWin, Caught, Fled). Each battle stores the input spec AND the full
// turn-by-turn log + outcome + final party state the C# produced.
//
// This test rebuilds each battle from the SAME seed and inputs and asserts the TS
// engine yields a BYTE-IDENTICAL log and identical outcome/turns/final state. A
// drift of a single rng draw, one rounding step, or one log character fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GameData } from './content/gamedata.ts';
import { replayBattle, type BattleSpec, type KinSnapshot } from './engine/replay.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface CorpusBattle extends BattleSpec {
  name: string;
  log: string[];
  outcome: string;
  turns: number;
  finalPlayer: KinSnapshot[];
  finalEnemy: KinSnapshot[];
}

const corpus = JSON.parse(readFileSync(join(here, 'fixtures', 'corpus.json'), 'utf8')) as CorpusBattle[];
const data = GameData.loadFromDirectory();

test('conformance: the corpus is non-trivial and covers every outcome', () => {
  assert.ok(corpus.length >= 10, `expected >= 10 battles, got ${corpus.length}`);
  const outcomes = new Set(corpus.map((b) => b.outcome));
  for (const o of ['PlayerWin', 'EnemyWin', 'Caught', 'Fled']) {
    assert.ok(outcomes.has(o), `corpus is missing a '${o}' battle`);
  }
  // At least one battle must be long enough to exercise many turns of rng.
  assert.ok(Math.max(...corpus.map((b) => b.turns)) >= 7, 'no multi-turn battle in the corpus');
});

for (const battle of corpus) {
  test(`conformance: '${battle.name}' replays byte-identically from seed ${String(battle.seed)}`, () => {
    const replay = replayBattle(data, battle);

    // The whole log, line by line — the strongest assertion, and the one that
    // pins every rng draw and every rounded integer.
    assert.deepEqual(replay.log, battle.log, `log mismatch in '${battle.name}'`);
    assert.equal(replay.outcome, battle.outcome, `outcome mismatch in '${battle.name}'`);
    assert.equal(replay.turns, battle.turns, `turn count mismatch in '${battle.name}'`);
    assert.deepEqual(replay.finalPlayer, battle.finalPlayer, `final player state mismatch in '${battle.name}'`);
    assert.deepEqual(replay.finalEnemy, battle.finalEnemy, `final enemy state mismatch in '${battle.name}'`);
  });
}

test('conformance: replay is itself deterministic (same seed twice => identical)', () => {
  for (const battle of corpus) {
    const a = replayBattle(data, battle);
    const b = replayBattle(data, battle);
    assert.deepEqual(a.log, b.log);
    assert.equal(a.outcome, b.outcome);
  }
});
