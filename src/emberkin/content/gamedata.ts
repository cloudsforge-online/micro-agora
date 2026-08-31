// Loads and validates all game content. Ported from
// src/Kindred.Core/Content/GameData.cs. Constructed either from a directory of
// JSON files or from raw JSON strings; normalizes the raw records to the shapes
// in models.ts (filling the defaults the C# records carry), then exposes the
// dictionaries the engine reads plus a referential-integrity `validate()`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { TypeChart } from '../engine/typechart.ts';
import { isStat, isStatus } from '../engine/enums.ts';
import type {
  CampaignData,
  EvolutionData,
  MoveData,
  MoveEffect,
  RegionData,
  SealWardenData,
  SpeciesData,
  StatBlock,
  StatChange,
  StoryBeat,
  TeamEntry,
  TypeChartData,
  WildEntry,
} from './models.ts';

// ---------- normalization helpers (defaults mirror the C# record initializers) ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: any, d = 0): number => (typeof v === 'number' ? v : d);
const str = (v: any, d = ''): string => (typeof v === 'string' ? v : d);
const bool = (v: any, d = false): boolean => (typeof v === 'boolean' ? v : d);
const orNull = (v: any): number | null => (typeof v === 'number' ? v : null);
const strOrNull = (v: any): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function statBlock(v: any): StatBlock {
  return {
    hp: num(v?.hp),
    attack: num(v?.attack),
    defense: num(v?.defense),
    spatk: num(v?.spatk),
    spdef: num(v?.spdef),
    speed: num(v?.speed),
  };
}

function statChange(v: any): StatChange | null {
  if (v == null || typeof v !== 'object') return null;
  return { stat: str(v.stat), stages: num(v.stages) };
}

function moveEffect(v: any): MoveEffect {
  const e = v ?? {};
  return {
    status: strOrNull(e.status),
    statusChance: num(e.statusChance),
    selfStat: statChange(e.selfStat),
    targetStat: statChange(e.targetStat),
    healPercent: num(e.healPercent),
    recoilPercent: num(e.recoilPercent),
    drainPercent: num(e.drainPercent),
  };
}

function moveData(v: any): MoveData {
  return {
    id: str(v.id),
    name: str(v.name),
    type: str(v.type),
    category: str(v.category, 'physical'),
    power: num(v.power),
    accuracy: num(v.accuracy),
    priority: num(v.priority),
    syncCost: num(v.syncCost),
    isResonanceArt: bool(v.isResonanceArt),
    effect: moveEffect(v.effect),
    description: str(v.description),
  };
}

function speciesData(v: any): SpeciesData {
  return {
    id: str(v.id),
    dexNumber: num(v.dexNumber),
    name: str(v.name),
    types: Array.isArray(v.types) ? v.types.map((t: any) => str(t)) : [],
    category: str(v.category),
    baseStats: statBlock(v.baseStats),
    catchRate: num(v.catchRate, 100),
    growthRate: str(v.growthRate, 'medium'),
    temperamentBias: num(v.temperamentBias),
    learnset: Array.isArray(v.learnset)
      ? v.learnset.map((l: any) => ({ level: num(l.level), move: str(l.move) }))
      : [],
    resonanceArt: strOrNull(v.resonanceArt),
    evolutions: Array.isArray(v.evolutions) ? v.evolutions.map(evolutionData) : [],
    lore: str(v.lore),
  };
}

function evolutionData(v: any): EvolutionData {
  const r = v.requires ?? {};
  return {
    into: str(v.into),
    note: str(v.note),
    requires: {
      resonance: num(r.resonance),
      level: num(r.level),
      temperamentMin: orNull(r.temperamentMin),
      temperamentMax: orNull(r.temperamentMax),
      heldItem: strOrNull(r.heldItem),
      region: strOrNull(r.region),
      timeOfDay: strOrNull(r.timeOfDay),
    },
  };
}

function typeChartData(v: any): TypeChartData {
  const chart: Record<string, Record<string, number>> = {};
  for (const [atk, row] of Object.entries(v?.chart ?? {})) {
    const r: Record<string, number> = {};
    for (const [def, m] of Object.entries(row as any)) r[def] = num(m);
    chart[atk] = r;
  }
  return { elements: Array.isArray(v?.elements) ? v.elements.map((e: any) => str(e)) : [], chart };
}

function campaignData(v: any): CampaignData {
  const wild = (w: any): WildEntry => ({
    species: str(w.species),
    levels: Array.isArray(w.levels) ? w.levels.map((n: any) => num(n)) : [],
    weight: num(w.weight, 1),
  });
  const team = (t: any): TeamEntry => ({ species: str(t.species), level: num(t.level, 5) });
  const region = (r: any): RegionData => ({
    id: str(r.id),
    name: str(r.name),
    act: num(r.act),
    wildKin: Array.isArray(r.wildKin) ? r.wildKin.map(wild) : [],
    nodes: Array.isArray(r.nodes) ? r.nodes.map((n: any) => str(n)) : [],
  });
  const warden = (w: any): SealWardenData => ({
    id: str(w.id),
    name: str(w.name),
    type: str(w.type),
    team: Array.isArray(w.team) ? w.team.map(team) : [],
    reward: str(w.reward),
  });
  const beat = (b: any): StoryBeat => ({
    id: str(b.id),
    region: str(b.region),
    speaker: str(b.speaker),
    text: str(b.text),
    grantsStarter: bool(b.grantsStarter),
    battle: strOrNull(b.battle),
    rival: bool(b.rival),
  });
  return {
    title: str(v.title),
    startRegion: str(v.startRegion),
    starters: Array.isArray(v.starters) ? v.starters.map((s: any) => str(s)) : [],
    regions: Array.isArray(v.regions) ? v.regions.map(region) : [],
    sealWardens: Array.isArray(v.sealWardens) ? v.sealWardens.map(warden) : [],
    story: Array.isArray(v.story) ? v.story.map(beat) : [],
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class GameData {
  readonly moves: ReadonlyMap<string, MoveData>;
  readonly species: ReadonlyMap<string, SpeciesData>;
  readonly dex: readonly SpeciesData[];
  readonly types: TypeChartData;
  readonly campaign: CampaignData;
  readonly typeChart: TypeChart;

  private constructor(
    types: TypeChartData,
    moves: MoveData[],
    species: SpeciesData[],
    campaign: CampaignData,
  ) {
    this.types = types;
    this.moves = new Map(moves.map((m) => [m.id, m]));
    this.species = new Map(species.map((s) => [s.id, s]));
    this.dex = [...species].sort((a, b) => a.dexNumber - b.dexNumber);
    this.campaign = campaign;
    this.typeChart = new TypeChart(types);
  }

  move(id: string): MoveData {
    const m = this.moves.get(id);
    if (!m) throw new Error(`Unknown move id '${id}'.`);
    return m;
  }

  getSpecies(id: string): SpeciesData {
    const s = this.species.get(id);
    if (!s) throw new Error(`Unknown species id '${id}'.`);
    return s;
  }

  static loadFromJson(typesJson: string, movesJson: string, speciesJson: string, campaignJson: string): GameData {
    const types = typeChartData(JSON.parse(typesJson));
    const moves = (JSON.parse(movesJson) as unknown[]).map(moveData);
    const species = (JSON.parse(speciesJson) as unknown[]).map(speciesData);
    const campaign = campaignData(JSON.parse(campaignJson));
    return new GameData(types, moves, species, campaign);
  }

  static loadFromDirectory(contentDir?: string): GameData {
    const dir = contentDir ?? locateContentDir();
    const read = (f: string): string => readFileSync(join(dir, f), 'utf8');
    return GameData.loadFromJson(read('types.json'), read('moves.json'), read('species.json'), read('campaign.json'));
  }

  /** Returns every referential-integrity problem in the content. Empty = valid. */
  validate(): string[] {
    const errors: string[] = [];
    const validElements = new Set(this.types.elements.map((e) => e.toLowerCase()));
    const hasElement = (e: string): boolean => validElements.has(e.toLowerCase());

    for (const [atk, row] of Object.entries(this.types.chart)) {
      if (!hasElement(atk)) errors.push(`Type chart attacker '${atk}' is not a declared element.`);
      for (const def of Object.keys(row)) {
        if (!hasElement(def)) errors.push(`Type chart '${atk}'→'${def}' references unknown element.`);
      }
    }

    for (const m of this.moves.values()) {
      if (!hasElement(m.type)) errors.push(`Move '${m.id}' has unknown type '${m.type}'.`);
      if (m.effect.status && m.effect.status.length > 0 && !isStatus(m.effect.status)) {
        errors.push(`Move '${m.id}' has unknown status '${m.effect.status}'.`);
      }
      if (m.effect.selfStat && !isStat(m.effect.selfStat.stat)) errors.push(`Move '${m.id}' selfStat unknown '${m.effect.selfStat.stat}'.`);
      if (m.effect.targetStat && !isStat(m.effect.targetStat.stat)) errors.push(`Move '${m.id}' targetStat unknown '${m.effect.targetStat.stat}'.`);
    }

    const dexSeen = new Set<number>();
    for (const s of this.species.values()) {
      if (s.types.length === 0 || s.types.length > 2) errors.push(`Species '${s.id}' must have 1–2 types (has ${s.types.length}).`);
      for (const t of s.types) if (!hasElement(t)) errors.push(`Species '${s.id}' has unknown type '${t}'.`);
      if (dexSeen.has(s.dexNumber)) errors.push(`Duplicate dexNumber ${s.dexNumber} (at '${s.id}').`);
      dexSeen.add(s.dexNumber);

      for (const le of s.learnset) if (!this.moves.has(le.move)) errors.push(`Species '${s.id}' learns unknown move '${le.move}'.`);

      if (s.resonanceArt && s.resonanceArt.length > 0) {
        const art = this.moves.get(s.resonanceArt);
        if (!art) errors.push(`Species '${s.id}' resonanceArt '${s.resonanceArt}' does not exist.`);
        else if (!art.isResonanceArt) errors.push(`Species '${s.id}' resonanceArt '${s.resonanceArt}' is not flagged isResonanceArt.`);
      }

      for (const ev of s.evolutions) if (!this.species.has(ev.into)) errors.push(`Species '${s.id}' evolves into unknown '${ev.into}'.`);
    }

    const checkSpecies = (id: string, ctx: string): void => {
      if (!this.species.has(id)) errors.push(`Campaign ${ctx} references unknown species '${id}'.`);
    };
    for (const st of this.campaign.starters) checkSpecies(st, 'starters');
    const regionIds = new Set(this.campaign.regions.map((r) => r.id));
    for (const r of this.campaign.regions) for (const w of r.wildKin) checkSpecies(w.species, `region '${r.id}' wildKin`);
    for (const w of this.campaign.sealWardens) {
      if (!hasElement(w.type)) errors.push(`Seal warden '${w.id}' unknown type '${w.type}'.`);
      for (const t of w.team) checkSpecies(t.species, `warden '${w.id}' team`);
    }
    for (const b of this.campaign.story) {
      if (b.region.length > 0 && !regionIds.has(b.region)) errors.push(`Story beat '${b.id}' references unknown region '${b.region}'.`);
    }

    return errors;
  }

  validateOrThrow(): void {
    const errs = this.validate();
    if (errs.length > 0) throw new Error('Content validation failed:\n - ' + errs.join('\n - '));
  }
}

/** Walks up from this module to find the repo's content/ dir. */
export function locateContentDir(): string {
  let dir: string = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'content');
    if (existsSync(join(candidate, 'types.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate a content/ directory containing types.json.');
}
