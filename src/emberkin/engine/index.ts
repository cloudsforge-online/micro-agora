// The deterministic Emberkin battle engine — a TypeScript port of the
// kindred-resonance C# core (src/Kindred.Core). Pure logic, no I/O; the service
// layer resolves battles server-side from a seed on top of this.

export { Rng } from './rng.ts';
export * from './enums.ts';
export { TypeChart } from './typechart.ts';
export { Items, RESONATORS } from './items.ts';
export { Kin, MAX_MOVES } from './kin.ts';
export { Party, MAX_PARTY_SIZE } from './party.ts';
export {
  computeDamage,
  rollHit,
  STAB,
  CRIT_MULTIPLIER,
  CRIT_CHANCE_DENOMINATOR,
  type DamageResult,
} from './damage.ts';
export { catchChance, tryCatch, type CatchResult } from './catching.ts';
export { BattleEngine } from './battle.ts';
export {
  BattleAction,
  BattleSide,
  type BattleOutcome,
  type ActionKind,
} from './battletypes.ts';
export { kinToSave, kinFromSave, type KinSave } from './saves.ts';
