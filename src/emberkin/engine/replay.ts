// Deterministic battle replay from a seed + party specs + a scripted list of
// player actions. This is both what the conformance corpus replays and what the
// service uses to resolve a battle server-side (the client is not authoritative;
// it submits actions, the server replays them from the stored seed). Same seed +
// same inputs => byte-identical log and outcome.

import { Rng } from './rng.ts';
import { Kin } from './kin.ts';
import { Party } from './party.ts';
import { BattleEngine } from './battle.ts';
import { BattleAction, BattleSide, type BattleOutcome } from './battletypes.ts';
import type { GameData } from '../content/gamedata.ts';

export interface KinSpec {
  readonly species: string;
  readonly level: number;
  readonly resonance?: number;
  readonly temperament?: number;
  readonly nickname?: string;
}

export interface SideSpec {
  readonly name: string;
  readonly isWild: boolean;
  readonly party: readonly KinSpec[];
}

export interface ScriptAction {
  readonly kind: 'move' | 'art' | 'catch' | 'flee' | 'switch' | 'item';
  readonly slot?: number;
  readonly move?: string;
  readonly item?: string;
  readonly index?: number;
}

export interface BattleSpec {
  readonly seed: string | number | bigint;
  readonly player: SideSpec;
  readonly enemy: SideSpec;
  readonly script?: readonly ScriptAction[];
  readonly maxTurns?: number;
}

export interface KinSnapshot {
  readonly species: string;
  readonly nickname: string;
  readonly level: number;
  readonly resonance: number;
  readonly temperament: number;
  readonly sync: number;
  readonly currentHp: number;
  readonly maxHp: number;
  readonly status: string;
  readonly moves: string[];
}

export interface BattleReplay {
  readonly log: string[];
  readonly outcome: BattleOutcome;
  readonly turns: number;
  readonly finalPlayer: KinSnapshot[];
  readonly finalEnemy: KinSnapshot[];
}

function makeKin(data: GameData, rng: Rng, spec: KinSpec): Kin {
  const k = Kin.create(data.getSpecies(spec.species), spec.level, rng, spec.resonance, spec.temperament);
  if (spec.nickname !== undefined) k.nickname = spec.nickname;
  return k;
}

function toAction(side: BattleSide, a: ScriptAction): BattleAction {
  const active = side.active;
  switch (a.kind) {
    case 'move': {
      if (a.move !== undefined) return BattleAction.move(a.move);
      let slot = a.slot ?? 0;
      if (slot < 0 || slot >= active.moves.length) slot = 0;
      return BattleAction.move(active.moves[slot]!);
    }
    case 'art':
      return BattleAction.move(active.species.resonanceArt ?? active.moves[0]!);
    case 'catch':
      return BattleAction.catch(a.item ?? 'resonator');
    case 'flee':
      return BattleAction.flee();
    case 'switch':
      return BattleAction.switch(a.index ?? -1);
    case 'item':
      return BattleAction.useItem(a.item ?? '');
    default:
      return BattleAction.move(active.moves[0]!);
  }
}

function snapshot(party: Party): KinSnapshot[] {
  return party.members.map((k) => ({
    species: k.species.id,
    nickname: k.nickname,
    level: k.level,
    resonance: k.resonance,
    temperament: k.temperament,
    sync: k.sync,
    currentHp: k.currentHp,
    maxHp: k.maxHp,
    status: k.status,
    moves: [...k.moves],
  }));
}

export function replayBattle(data: GameData, spec: BattleSpec): BattleReplay {
  const rng = new Rng(BigInt(spec.seed));
  const pParty = new Party();
  for (const m of spec.player.party) pParty.add(makeKin(data, rng, m));
  const eParty = new Party();
  for (const m of spec.enemy.party) eParty.add(makeKin(data, rng, m));

  const player = new BattleSide(pParty, spec.player.name, true, spec.player.isWild);
  const enemy = new BattleSide(eParty, spec.enemy.name, false, spec.enemy.isWild);

  const log: string[] = [];
  const engine = new BattleEngine(data, rng, player, enemy, (line) => log.push(line));
  engine.start();

  const script = spec.script ?? [];
  const maxTurns = spec.maxTurns ?? 100;
  let i = 0;
  while (engine.outcome === 'Ongoing' && i < maxTurns) {
    const a: ScriptAction = i < script.length ? script[i]! : { kind: 'move', slot: 0 };
    engine.executeTurn(toAction(player, a));
    i++;
  }

  return {
    log,
    outcome: engine.outcome,
    turns: engine.turnNumber,
    finalPlayer: snapshot(pParty),
    finalEnemy: snapshot(eParty),
  };
}
