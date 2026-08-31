// Catch resolution, ported from src/Kindred.Core/Catching.cs. Chance rises as the
// target's HP drops, when it is afflicted, and with better Resonators.

import { Rng } from './rng.ts';
import { Items } from './items.ts';
import type { Kin } from './kin.ts';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function catchChance(target: Kin, resonatorId: string): number {
  const ball = Items.resonatorPower(resonatorId);
  if (ball >= 255) return 1.0;

  const max = target.maxHp;
  const cur = Math.max(0, target.currentHp);
  const hpFactor = (3.0 * max - 2.0 * cur) / (3.0 * max); // 1/3 (full) .. 1 (1 HP)
  let statusFactor: number;
  switch (target.status) {
    case 'None':
      statusFactor = 1.0;
      break;
    case 'Chill':
    case 'Shock':
      statusFactor = 1.6;
      break;
    default:
      statusFactor = 1.3;
  }

  const a = target.species.catchRate * ball * hpFactor * statusFactor;
  return clamp(a / 255.0, 0.03, 1.0);
}

export interface CatchResult {
  readonly caught: boolean;
  readonly shakes: number;
}

export function tryCatch(target: Kin, resonatorId: string, rng: Rng): CatchResult {
  const p = catchChance(target, resonatorId);
  const caught = rng.nextDouble() < p;
  const shakes = caught ? 3 : rng.range(0, 2);
  return { caught, shakes };
}
