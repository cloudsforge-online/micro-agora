// Kin (de)serialization, ported from the KinSave record in
// src/Kindred.Core/Save/SaveGame.cs. This is the shape a Kin takes at rest in the
// authoritative Postgres save (party/box are arrays of KinSave stored as JSONB).

import { Kin } from './kin.ts';
import { parseStatus, type Status } from './enums.ts';
import type { GameData } from '../content/gamedata.ts';
import type { StatBlock } from '../content/models.ts';

export interface KinSave {
  readonly speciesId: string;
  readonly nickname: string | null; // null = follows species name
  readonly level: number;
  readonly xp: number;
  readonly resonance: number;
  readonly temperament: number;
  readonly attunement: StatBlock;
  readonly moves: readonly string[];
  readonly heldItem: string | null;
  readonly currentHp: number;
  readonly status: Status;
}

export function kinToSave(k: Kin): KinSave {
  return {
    speciesId: k.species.id,
    nickname: k.hasCustomNickname ? k.nickname : null,
    level: k.level,
    xp: k.xp,
    resonance: k.resonance,
    temperament: k.temperament,
    attunement: k.attunement,
    moves: [...k.moves],
    heldItem: k.heldItem,
    currentHp: k.currentHp,
    status: k.status,
  };
}

export function kinFromSave(s: KinSave, data: GameData): Kin {
  return Kin.restore(
    data.getSpecies(s.speciesId),
    s.nickname,
    s.level,
    s.xp,
    s.resonance,
    s.temperament,
    s.attunement,
    s.moves,
    s.heldItem,
    s.currentHp,
    parseStatus(s.status),
  );
}
