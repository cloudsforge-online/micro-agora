// Battle value types, ported from src/Kindred.Core/Battle/BattleTypes.cs.

import type { Party } from './party.ts';
import type { Kin } from './kin.ts';

export type BattleOutcome = 'Ongoing' | 'PlayerWin' | 'EnemyWin' | 'Caught' | 'Fled';
export type ActionKind = 'Move' | 'Switch' | 'Item' | 'Flee' | 'Catch';

/** A command issued by one side for a turn. */
export interface BattleAction {
  readonly kind: ActionKind;
  readonly moveId: string | null;
  readonly switchIndex: number;
  readonly itemId: string | null;
}

export const BattleAction = {
  move(moveId: string): BattleAction {
    return { kind: 'Move', moveId, switchIndex: -1, itemId: null };
  },
  switch(index: number): BattleAction {
    return { kind: 'Switch', moveId: null, switchIndex: index, itemId: null };
  },
  useItem(itemId: string): BattleAction {
    return { kind: 'Item', moveId: null, switchIndex: -1, itemId };
  },
  flee(): BattleAction {
    return { kind: 'Flee', moveId: null, switchIndex: -1, itemId: null };
  },
  catch(resonatorId: string): BattleAction {
    return { kind: 'Catch', moveId: null, switchIndex: -1, itemId: resonatorId };
  },
} as const;

/** One participant: a party plus battle metadata. */
export class BattleSide {
  readonly party: Party;
  readonly name: string;
  readonly isWild: boolean;
  readonly isPlayer: boolean;

  constructor(party: Party, name: string, isPlayer: boolean, isWild = false) {
    this.party = party;
    this.name = name;
    this.isPlayer = isPlayer;
    this.isWild = isWild;
  }

  get active(): Kin {
    return this.party.active;
  }
}
