// The KINDRED damage formula (docs/GAME_DESIGN.md §5), ported from
// src/Kindred.Core/Battle/DamageCalculator.cs.
//
// RNG ORDER IS PART OF THE CONTRACT: crit (rng.next(16)) is drawn before the
// damage-range roll (rng.range(85,100)). Both integer floors match the C#.

import { Rng } from './rng.ts';
import { parseCategory, parseElement } from './enums.ts';
import { TypeChart } from './typechart.ts';
import type { Kin } from './kin.ts';
import type { MoveData } from '../content/models.ts';

export const STAB = 1.2;
export const CRIT_MULTIPLIER = 1.5;
export const CRIT_CHANCE_DENOMINATOR = 16;

export interface DamageResult {
  readonly damage: number;
  readonly typeMultiplier: number;
  readonly crit: boolean;
  readonly missed: boolean;
}

export function rollHit(move: MoveData, rng: Rng): boolean {
  return move.accuracy <= 0 || rng.chance(move.accuracy);
}

export function computeDamage(attacker: Kin, defender: Kin, move: MoveData, chart: TypeChart, rng: Rng): DamageResult {
  if (parseCategory(move.category) === 'status' || move.power <= 0) {
    return { damage: 0, typeMultiplier: 1.0, crit: false, missed: false };
  }

  const moveType = parseElement(move.type);
  const typeMult = chart.multiplier(moveType, defender.types);
  if (typeMult === 0.0) return { damage: 0, typeMultiplier: 0.0, crit: false, missed: false };

  const physical = parseCategory(move.category) === 'physical';
  const atk = attacker.effectiveStat(physical ? 'attack' : 'spatk');
  const def = Math.max(1, defender.effectiveStat(physical ? 'defense' : 'spdef'));

  const baseDmg = Math.floor(((2.0 * attacker.level) / 5.0 + 2.0) * move.power * atk / def / 50.0) + 2.0;

  const stab = attacker.types.includes(moveType) ? STAB : 1.0;
  const resoBonus = 1.0 + attacker.resonance / 500.0;
  const crit = rng.next(CRIT_CHANCE_DENOMINATOR) === 0;
  const critMult = crit ? CRIT_MULTIPLIER : 1.0;
  const rand = rng.range(85, 100) / 100.0;

  const dmg = Math.floor(baseDmg * stab * typeMult * resoBonus * critMult * rand);
  return { damage: Math.max(1, dmg), typeMultiplier: typeMult, crit, missed: false };
}
