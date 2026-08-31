// A living instance of a species — the creature a Warden raises. Ported from
// src/Kindred.Core/Kin.cs. Carries the three bond values (Resonance persistent,
// Temperament lean, Sync per-battle) that drive progression and evolution.
//
// Integer discipline: every place the C# does integer division or an `(int)` cast
// is reproduced with Math.trunc/floor on non-negative values, because the damage
// and stat math must match the reference to the unit.

import { Rng } from './rng.ts';
import {
  parseElement,
  parseGrowth,
  statIndex,
  type Element,
  type GrowthRate,
  type Stat,
  type Status,
  type TimeOfDay,
} from './enums.ts';
import { statGet, type SpeciesData, type StatBlock, type MoveData } from '../content/models.ts';

export const MAX_MOVES = 4;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class Kin {
  species: SpeciesData;

  private nick: string | null = null;
  level = 1;
  xp = 0;

  // The Resonance system.
  resonance = 0; // 0..100, persistent bond
  temperament = 0; // -100 (Harmony) .. +100 (Ferocity)
  sync = 0; // 0..100, resets each battle

  attunement: StatBlock; // per-instance identity ("IV" analogue)

  readonly moves: string[] = [];
  heldItem: string | null = null;

  // Battle-volatile state.
  currentHp = 0;
  status: Status = 'None';
  statusCounter = 0;
  private readonly stages = new Array<number>(6).fill(0); // stat stages -6..+6
  artUsedFreeThisBattle = false;

  private typesList: Element[] = [];

  private constructor(species: SpeciesData) {
    this.species = species;
    this.attunement = { hp: 0, attack: 0, defense: 0, spatk: 0, spdef: 0, speed: 0 };
    this.refreshTypes();
  }

  // ---------- Construction ----------

  static create(species: SpeciesData, level: number, rng: Rng, resonance?: number, temperament?: number): Kin {
    const k = new Kin(species);
    k.level = clamp(level, 1, 100);
    k.attunement = Kin.rollAttunement(rng);
    k.resonance = clamp(resonance ?? 0, 0, 100);
    k.temperament = clamp(temperament ?? species.temperamentBias, -100, 100);
    k.xp = Kin.xpForLevel(k.level, k.growth);
    k.autoLearnUpTo(k.level);
    k.currentHp = k.maxHp;
    return k;
  }

  static createWild(species: SpeciesData, level: number, rng: Rng): Kin {
    return Kin.create(species, level, rng, 0, species.temperamentBias);
  }

  /** Rehydrates a Kin from saved data without re-rolling anything. */
  static restore(
    species: SpeciesData,
    nickname: string | null,
    level: number,
    xp: number,
    resonance: number,
    temperament: number,
    attunement: StatBlock,
    moves: readonly string[],
    heldItem: string | null,
    currentHp: number,
    status: Status,
  ): Kin {
    const k = new Kin(species);
    k.nickname = nickname ?? ''; // setter treats blank as "follow species"
    k.level = clamp(level, 1, 100);
    k.xp = xp;
    k.resonance = clamp(resonance, 0, 100);
    k.temperament = clamp(temperament, -100, 100);
    k.attunement = attunement;
    k.heldItem = heldItem;
    k.status = status;
    for (const m of moves.slice(0, MAX_MOVES)) k.moves.push(m);
    k.currentHp = currentHp > 0 ? Math.min(currentHp, k.maxHp) : k.maxHp;
    return k;
  }

  private refreshTypes(): void {
    this.typesList = this.species.types.map(parseElement);
  }

  private static rollAttunement(rng: Rng): StatBlock {
    // Order is load-bearing: it fixes the rng-consumption sequence for the corpus.
    return {
      hp: rng.range(0, 15),
      attack: rng.range(0, 15),
      defense: rng.range(0, 15),
      spatk: rng.range(0, 15),
      spdef: rng.range(0, 15),
      speed: rng.range(0, 15),
    };
  }

  // ---------- Identity ----------

  get nickname(): string {
    return this.nick ?? this.species.name;
  }
  set nickname(value: string) {
    this.nick = value == null || value.trim().length === 0 ? null : value;
  }
  get hasCustomNickname(): boolean {
    return this.nick !== null;
  }

  get types(): readonly Element[] {
    return this.typesList;
  }

  // ---------- Derived stats ----------

  get growth(): GrowthRate {
    return parseGrowth(this.species.growthRate);
  }

  /** Stat multiplier from Resonance thresholds (Attuned +6%, Perfect +12%). */
  get resonanceStatMultiplier(): number {
    if (this.resonance >= 100) return 1.12;
    if (this.resonance >= 25) return 1.06;
    return 1.0;
  }

  get maxHp(): number {
    const b = this.species.baseStats.hp;
    const iv = this.attunement.hp;
    const raw = Math.trunc(((2 * b + iv) * this.level) / 100) + this.level + 10;
    return Math.trunc(raw * this.resonanceStatMultiplier);
  }

  /** Base value of a non-HP stat before battle stages / status. */
  baseStat(stat: Stat): number {
    if (stat === 'hp') return this.maxHp;
    const b = statGet(this.species.baseStats, stat);
    const iv = statGet(this.attunement, stat);
    const raw = Math.trunc(((2 * b + iv) * this.level) / 100) + 5;
    return Math.max(1, Math.trunc(raw * this.resonanceStatMultiplier));
  }

  /** Effective stat in battle: base × stage multiplier × status penalty. */
  effectiveStat(stat: Stat): number {
    let v = this.baseStat(stat);
    v *= Kin.stageMultiplier(this.stages[statIndex(stat)]!);
    if (stat === 'attack' && this.status === 'Burn') v *= 0.5;
    if (stat === 'speed' && this.status === 'Chill') v *= 0.5;
    return Math.max(1, Math.trunc(v));
  }

  private static stageMultiplier(stage: number): number {
    return stage >= 0 ? (2 + stage) / 2.0 : 2.0 / (2 - stage);
  }

  getStage(s: Stat): number {
    return this.stages[statIndex(s)]!;
  }

  /** Applies a stat-stage change; returns the actual delta applied. */
  changeStage(s: Stat, delta: number): number {
    const i = statIndex(s);
    const before = this.stages[i]!;
    this.stages[i] = clamp(before + delta, -6, 6);
    return this.stages[i]! - before;
  }

  // ---------- HP / status ----------

  get isFainted(): boolean {
    return this.currentHp <= 0;
  }
  get hpFraction(): number {
    return this.maxHp === 0 ? 0 : this.currentHp / this.maxHp;
  }

  takeDamage(amount: number): number {
    const dealt = clamp(amount, 0, this.currentHp);
    this.currentHp -= dealt;
    return dealt;
  }

  heal(amount: number): number {
    const healed = clamp(amount, 0, this.maxHp - this.currentHp);
    this.currentHp += healed;
    return healed;
  }

  fullRestore(): void {
    this.currentHp = this.maxHp;
    this.status = 'None';
    this.statusCounter = 0;
  }

  setStatus(status: Status): boolean {
    if (this.status !== 'None' || status === 'None') return false;
    this.status = status;
    this.statusCounter = 0;
    return true;
  }

  clearStatus(): void {
    this.status = 'None';
    this.statusCounter = 0;
  }

  setStatusCounter(n: number): void {
    this.statusCounter = Math.max(0, n);
  }
  decrementStatusCounter(): void {
    if (this.statusCounter > 0) this.statusCounter--;
  }

  /** Resets battle-volatile state at the start/end of a battle. */
  resetBattleState(): void {
    this.sync = 0;
    this.stages.fill(0);
    this.artUsedFreeThisBattle = false;
  }

  // ---------- The Resonance system ----------

  addResonance(delta: number): void {
    this.resonance = clamp(this.resonance + delta, 0, 100);
  }
  shiftTemperament(delta: number): void {
    this.temperament = clamp(this.temperament + delta, -100, 100);
  }
  addSync(delta: number): void {
    this.sync = clamp(this.sync + delta, 0, 100);
  }
  spendSync(amount: number): void {
    this.sync = clamp(this.sync - amount, 0, 100);
  }

  get isAttuned(): boolean {
    return this.resonance >= 25;
  }
  get isResonant(): boolean {
    return this.resonance >= 50; // unlocks Resonance Art
  }
  get hasPerfectResonance(): boolean {
    return this.resonance >= 100;
  }

  get temperamentIsFerocious(): boolean {
    return this.temperament >= 0;
  }
  get temperamentLabel(): string {
    const t = this.temperament;
    if (t >= 60) return 'Ferocious';
    if (t >= 20) return 'Bold';
    if (t > -20) return 'Balanced';
    if (t > -60) return 'Gentle';
    return 'Serene';
  }

  /** Can this Kin currently unleash its Resonance Art? */
  canUseArt(art: MoveData): boolean {
    return (
      this.isResonant &&
      this.species.resonanceArt === art.id &&
      (this.sync >= art.syncCost || (this.hasPerfectResonance && !this.artUsedFreeThisBattle))
    );
  }

  // ---------- XP & leveling ----------

  static xpForLevel(level: number, growth: GrowthRate): number {
    const n = level;
    const cube = n * n * n;
    if (growth === 'fast') return Math.trunc(0.8 * cube);
    if (growth === 'slow') return Math.trunc(1.25 * cube);
    return Math.trunc(cube);
  }

  get xpToNextLevel(): number {
    return this.level >= 100 ? 0 : Kin.xpForLevel(this.level + 1, this.growth) - this.xp;
  }

  /** Adds XP and returns the list of new move ids learned from leveling up. */
  gainXp(amount: number): string[] {
    const learned: string[] = [];
    if (this.level >= 100) return learned;
    this.xp += Math.max(0, amount);
    while (this.level < 100 && this.xp >= Kin.xpForLevel(this.level + 1, this.growth)) {
      this.level++;
      for (const l of this.species.learnset) {
        if (l.level === this.level && this.tryLearn(l.move)) learned.push(l.move);
      }
    }
    return learned;
  }

  private autoLearnUpTo(level: number): void {
    this.moves.length = 0;
    const eligible = this.species.learnset.filter((l) => l.level <= level).sort((a, b) => a.level - b.level);
    for (const l of eligible) {
      const mv = l.move;
      if (this.moves.includes(mv)) continue;
      if (this.moves.length < MAX_MOVES) this.moves.push(mv);
      else {
        this.moves.shift();
        this.moves.push(mv);
      }
    }
    if (this.moves.length === 0 && eligible.length > 0) this.moves.push(eligible[0]!.move);
  }

  tryLearn(moveId: string): boolean {
    if (this.moves.includes(moveId)) return false;
    if (this.moves.length < MAX_MOVES) {
      this.moves.push(moveId);
      return true;
    }
    return false; // full; caller decides on replacement
  }

  replaceMove(slot: number, moveId: string): void {
    if (slot >= 0 && slot < this.moves.length) this.moves[slot] = moveId;
  }

  // ---------- Evolution ----------

  /** Returns the species id this Kin should evolve into now, or null. */
  checkEvolution(currentRegion: string | null = null, time: TimeOfDay = 'Day'): string | null {
    const ci = (a: string | null, b: string | null): boolean =>
      (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
    for (const ev of this.species.evolutions) {
      const r = ev.requires;
      if (r.resonance > 0 && this.resonance < r.resonance) continue;
      if (r.level > 0 && this.level < r.level) continue;
      if (r.temperamentMin !== null && this.temperament < r.temperamentMin) continue;
      if (r.temperamentMax !== null && this.temperament > r.temperamentMax) continue;
      if (r.heldItem && r.heldItem.length > 0 && !ci(this.heldItem, r.heldItem)) continue;
      if (r.region && r.region.length > 0 && !ci(currentRegion, r.region)) continue;
      if (r.timeOfDay && r.timeOfDay.length > 0 && !ci(r.timeOfDay, time)) continue;
      return ev.into;
    }
    return null;
  }

  /** Evolves into the given species, preserving HP fraction and learning new moves. */
  evolveInto(newSpecies: SpeciesData): string[] {
    const hpFrac = this.hpFraction;
    this.species = newSpecies;
    this.refreshTypes();
    const learned: string[] = [];
    for (const l of newSpecies.learnset) {
      if (l.level <= this.level && this.tryLearn(l.move)) learned.push(l.move);
    }
    this.currentHp = Math.max(1, Math.trunc(this.maxHp * hpFrac));
    return learned;
  }
}
