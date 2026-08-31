// Content models — the normalized, engine-facing shapes. They mirror
// src/Kindred.Core/Content/ContentModels.cs 1:1. The raw JSON is camelCase and
// matches these field names; GameData fills the defaults the C# records carry
// (a missing effect field is 0, a missing optional is null) so nothing downstream
// has to reason about `undefined`.

import type { Stat } from '../engine/enums.ts';

export interface StatBlock {
  readonly hp: number;
  readonly attack: number;
  readonly defense: number;
  readonly spatk: number;
  readonly spdef: number;
  readonly speed: number;
}

export function statGet(b: StatBlock, s: Stat): number {
  return b[s];
}

export function statTotal(b: StatBlock): number {
  return b.hp + b.attack + b.defense + b.spatk + b.spdef + b.speed;
}

export interface StatChange {
  /** The raw content spelling (e.g. "attack"). The battle log prints it verbatim. */
  readonly stat: string;
  readonly stages: number;
}

export interface MoveEffect {
  readonly status: string | null;
  readonly statusChance: number;
  readonly selfStat: StatChange | null;
  readonly targetStat: StatChange | null;
  readonly healPercent: number;
  readonly recoilPercent: number;
  readonly drainPercent: number;
}

export interface MoveData {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly category: string;
  readonly power: number;
  readonly accuracy: number;
  readonly priority: number;
  readonly syncCost: number;
  readonly isResonanceArt: boolean;
  readonly effect: MoveEffect;
  readonly description: string;
}

export interface LearnEntry {
  readonly level: number;
  readonly move: string;
}

export interface EvolutionRequirement {
  readonly resonance: number;
  readonly level: number;
  readonly temperamentMin: number | null;
  readonly temperamentMax: number | null;
  readonly heldItem: string | null;
  readonly region: string | null;
  readonly timeOfDay: string | null;
}

export interface EvolutionData {
  readonly into: string;
  readonly requires: EvolutionRequirement;
  readonly note: string;
}

export interface SpeciesData {
  readonly id: string;
  readonly dexNumber: number;
  readonly name: string;
  readonly types: readonly string[];
  readonly category: string;
  readonly baseStats: StatBlock;
  readonly catchRate: number;
  readonly growthRate: string;
  readonly temperamentBias: number;
  readonly learnset: readonly LearnEntry[];
  readonly resonanceArt: string | null;
  readonly evolutions: readonly EvolutionData[];
  readonly lore: string;
}

export interface TypeChartData {
  readonly elements: readonly string[];
  readonly chart: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

// ---- Campaign ----

export interface WildEntry {
  readonly species: string;
  readonly levels: readonly number[];
  readonly weight: number;
}

export interface TeamEntry {
  readonly species: string;
  readonly level: number;
}

export interface RegionData {
  readonly id: string;
  readonly name: string;
  readonly act: number;
  readonly wildKin: readonly WildEntry[];
  readonly nodes: readonly string[];
}

export interface SealWardenData {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly team: readonly TeamEntry[];
  readonly reward: string;
}

export interface StoryBeat {
  readonly id: string;
  readonly region: string;
  readonly speaker: string;
  readonly text: string;
  readonly grantsStarter: boolean;
  readonly battle: string | null;
  readonly rival: boolean;
}

export interface CampaignData {
  readonly title: string;
  readonly startRegion: string;
  readonly starters: readonly string[];
  readonly regions: readonly RegionData[];
  readonly sealWardens: readonly SealWardenData[];
  readonly story: readonly StoryBeat[];
}
