// An ordered team of up to six Kin with a currently-active member. Ported from
// src/Kindred.Core/Party.cs.

import type { Kin } from './kin.ts';

export const MAX_PARTY_SIZE = 6;

export class Party {
  private readonly membersList: Kin[] = [];
  activeIndex = 0;

  get members(): readonly Kin[] {
    return this.membersList;
  }
  get active(): Kin {
    const k = this.membersList[this.activeIndex];
    if (!k) throw new Error('Party has no active member.');
    return k;
  }
  get count(): number {
    return this.membersList.length;
  }
  get isEmpty(): boolean {
    return this.membersList.length === 0;
  }

  add(kin: Kin): boolean {
    if (this.membersList.length >= MAX_PARTY_SIZE) return false;
    this.membersList.push(kin);
    return true;
  }

  get hasFightableKin(): boolean {
    return this.membersList.some((k) => !k.isFainted);
  }

  switchTo(index: number): boolean {
    if (index < 0 || index >= this.membersList.length || this.membersList[index]!.isFainted || index === this.activeIndex) {
      return false;
    }
    this.activeIndex = index;
    return true;
  }

  /** Index of the first non-fainted member, or -1. */
  firstHealthyIndex(): number {
    for (let i = 0; i < this.membersList.length; i++) if (!this.membersList[i]!.isFainted) return i;
    return -1;
  }

  clear(): void {
    this.membersList.length = 0;
    this.activeIndex = 0;
  }

  healAll(): void {
    for (const k of this.membersList) k.fullRestore();
  }

  resetBattleState(): void {
    for (const k of this.membersList) k.resetBattleState();
  }
}
