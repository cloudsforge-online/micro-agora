// Drives a 1v1 battle with switching. Deterministic given its Rng. Logic only —
// no I/O — a faithful port of src/Kindred.Core/Battle/BattleEngine.cs.
//
// Every log string, every branch, and above all every rng consumption is in the
// same order as the C#. The conformance corpus (src/conformance.test.ts) replays
// battles recorded from the C# and asserts the log is byte-identical, so a drift
// of a single roll fails the build.

import { Rng } from './rng.ts';
import { Party } from './party.ts';
import { Kin } from './kin.ts';
import { TypeChart } from './typechart.ts';
import { computeDamage, rollHit, STAB } from './damage.ts';
import { tryCatch } from './catching.ts';
import { Items } from './items.ts';
import { parseCategory, parseElement, parseStat, parseStatus, type Status } from './enums.ts';
import { BattleAction, BattleSide, type BattleOutcome } from './battletypes.ts';
import type { GameData } from '../content/gamedata.ts';
import type { MoveData } from '../content/models.ts';

type LogFn = (line: string) => void;

interface Actor {
  side: BattleSide;
  act: BattleAction;
}

export class BattleEngine {
  private readonly data: GameData;
  private readonly rng: Rng;
  private readonly log: LogFn;

  readonly player: BattleSide;
  readonly enemy: BattleSide;
  outcome: BattleOutcome = 'Ongoing';
  turnNumber = 0;

  constructor(data: GameData, rng: Rng, player: BattleSide, enemy: BattleSide, log?: LogFn) {
    this.data = data;
    this.rng = rng;
    this.player = player;
    this.enemy = enemy;
    this.log = log ?? ((): void => {});
  }

  start(): void {
    this.player.party.resetBattleState();
    this.enemy.party.resetBattleState();
    this.log(
      this.enemy.isWild
        ? `A wild ${this.enemy.active.nickname} appears!`
        : `${this.enemy.name} sends out ${this.enemy.active.nickname}!`,
    );
    this.log(`Go, ${this.player.active.nickname}!`);
  }

  /** All moves the active Kin may pick, including its Resonance Art if unlocked. */
  availableMoves(kin: Kin): MoveData[] {
    const moves = kin.moves.map((id) => this.data.move(id));
    const art = kin.species.resonanceArt;
    if (kin.isResonant && art) {
      const artMove = this.data.moves.get(art);
      if (artMove) moves.push(artMove);
    }
    return moves;
  }

  // ---------- Enemy AI ----------

  private chooseEnemyAction(): BattleAction {
    const self = this.enemy.active;
    const foe = this.player.active;
    let best: MoveData | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const m of this.availableMoves(self)) {
      const score = this.scoreMove(self, foe, m);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    best ??= this.data.move(self.moves[0]!);
    return BattleAction.move(best.id);
  }

  private scoreMove(self: Kin, foe: Kin, m: MoveData): number {
    if (m.isResonanceArt && !self.canUseArt(m)) return Number.NEGATIVE_INFINITY;

    if (parseCategory(m.category) === 'status') {
      if (m.effect.healPercent > 0) return self.hpFraction < 0.5 ? 130 : 15;
      if (m.effect.status && m.effect.status.length > 0) return 55;
      if (m.effect.selfStat !== null) return this.turnNumber <= 1 ? 40 : 20;
      if (m.effect.targetStat !== null) return 35;
      return 12;
    }

    const type = parseElement(m.type);
    const eff = this.data.typeChart.multiplier(type, foe.types);
    const stab = self.types.includes(type) ? STAB : 1.0;
    let score = m.power * stab * eff;
    if (m.isResonanceArt) score += 60; // favour the ult when it lands
    return score;
  }

  executeTurn(playerAction: BattleAction): void {
    if (this.outcome !== 'Ongoing') return;
    this.turnNumber++;
    const enemyAction = this.chooseEnemyAction();

    // --- Priority phase: flee / catch / item / switch resolve before moves. ---
    if (playerAction.kind === 'Flee') {
      if (this.tryFlee()) {
        this.outcome = 'Fled';
        return;
      }
    }
    if (playerAction.kind === 'Catch') {
      this.resolveCatch(playerAction.itemId ?? 'resonator');
      if (this.outcome !== 'Ongoing') return;
    }
    this.resolveNonMove(this.player, playerAction);
    this.resolveNonMove(this.enemy, enemyAction);

    // --- Move phase, ordered by priority then effective speed. ---
    const actors: Actor[] = [];
    if (playerAction.kind === 'Move') actors.push({ side: this.player, act: playerAction });
    if (enemyAction.kind === 'Move') actors.push({ side: this.enemy, act: enemyAction });
    this.orderActors(actors);

    for (const { side, act } of actors) {
      if (this.outcome !== 'Ongoing') break;
      if (side.active.isFainted) continue;
      this.performMove(side, this.other(side), act.moveId!);
      this.resolveFaints();
    }

    if (this.outcome !== 'Ongoing') return;

    // --- End of turn: residual status damage & duration ticks. ---
    this.endOfTurn(this.player.active);
    this.endOfTurn(this.enemy.active);
    this.resolveFaints();
  }

  // Reproduces `actors.Sort((a,b) => CompareOrder(b,a))` exactly. .NET's List.Sort
  // uses InsertionSort for a 2-element list, which calls the comparer ONCE as
  // comparer(keys[1], keys[0]) and swaps when it is < 0. Substituting the inverted
  // comparer, that is: swap when CompareOrder(actors[0], actors[1]) < 0. Doing it
  // by hand keeps the single rng.next(2) tie-break draw in the same place.
  private orderActors(actors: Actor[]): void {
    if (actors.length !== 2) return;
    if (this.compareOrder(actors[0]!, actors[1]!) < 0) {
      const t = actors[0]!;
      actors[0] = actors[1]!;
      actors[1] = t;
    }
  }

  private compareOrder(a: Actor, b: Actor): number {
    const pa = this.data.move(a.act.moveId!).priority;
    const pb = this.data.move(b.act.moveId!).priority;
    if (pa !== pb) return pa < pb ? -1 : 1;
    const sa = a.side.active.effectiveStat('speed');
    const sb = b.side.active.effectiveStat('speed');
    if (sa !== sb) return sa < sb ? -1 : 1;
    return this.rng.next(2) === 0 ? 1 : -1;
  }

  private other(s: BattleSide): BattleSide {
    return s === this.player ? this.enemy : this.player;
  }

  // ---------- Non-move actions ----------

  private resolveNonMove(side: BattleSide, act: BattleAction): void {
    switch (act.kind) {
      case 'Switch': {
        if (side.active.status === 'Root') {
          this.log(`${side.active.nickname} is rooted and can't switch out!`);
          break;
        }
        const name = side.active.nickname;
        if (side.party.switchTo(act.switchIndex)) {
          this.log(`${side.name} withdrew ${name} and sent out ${side.active.nickname}!`);
        }
        break;
      }
      case 'Item':
        this.useItem(side, act.itemId ?? '');
        break;
      default:
        break;
    }
  }

  private useItem(side: BattleSide, itemId: string): void {
    const kin = side.active;
    const heal = Items.healAmount(itemId);
    if (heal > 0) {
      const done = kin.heal(heal);
      this.log(`${side.name} used ${Items.displayName(itemId)}. ${kin.nickname} recovered ${done} HP.`);
      if (side.isPlayer) kin.addResonance(1); // care builds the bond
    } else if (Items.curesStatus(itemId) && kin.status !== 'None') {
      this.log(`${side.name} used ${Items.displayName(itemId)}. ${kin.nickname}'s ${kin.status} was cured.`);
      kin.clearStatus();
      if (side.isPlayer) kin.addResonance(1);
    }
  }

  private tryFlee(): boolean {
    if (!this.enemy.isWild) {
      this.log("You can't flee from a Warden battle!");
      return false;
    }
    const playerSpeed = this.player.active.effectiveStat('speed');
    const enemySpeed = Math.max(1, this.enemy.active.effectiveStat('speed'));
    const chance = playerSpeed >= enemySpeed ? 90 : 50 + Math.trunc((playerSpeed * 40) / enemySpeed);
    if (this.rng.chance(chance)) {
      this.log('Got away safely!');
      return true;
    }
    this.log("Couldn't get away!");
    return false;
  }

  private resolveCatch(resonatorId: string): void {
    if (!this.enemy.isWild) {
      this.log("You can't catch another Warden's Kin!");
      return;
    }
    const target = this.enemy.active;
    const { caught, shakes } = tryCatch(target, resonatorId, this.rng);
    this.log(`You hurl a ${Items.displayName(resonatorId)}...`);
    this.log('.'.repeat(Math.max(1, shakes)) + (caught ? ' click!' : ' it broke free!'));
    if (caught) {
      this.log(`Gotcha! ${target.nickname} resonates with you now.`);
      target.addResonance(10);
      this.outcome = 'Caught';
    }
  }

  // ---------- Move execution ----------

  private performMove(side: BattleSide, foe: BattleSide, moveId: string): void {
    const user = side.active;
    if (!this.canAct(user)) return;

    const move = this.data.move(moveId);
    const isArt = user.species.resonanceArt === moveId && move.isResonanceArt;
    if (isArt) {
      if (!user.canUseArt(move)) {
        this.log(`${user.nickname} isn't in Sync enough for ${move.name}!`);
        return;
      }
      if (user.hasPerfectResonance && !user.artUsedFreeThisBattle && user.sync < move.syncCost) {
        user.artUsedFreeThisBattle = true; // free once at Perfect Resonance
      } else {
        user.spendSync(move.syncCost);
      }
      this.log(`✦ ${user.nickname} channels its Resonance Art — ${move.name}!`);
    } else {
      this.log(`${user.nickname} used ${move.name}!`);
    }

    // Accuracy
    if (!rollHit(move, this.rng)) {
      this.log(`${user.nickname}'s attack missed!`);
      user.addSync(3);
      BattleEngine.shiftTemperamentByMove(user, move);
      return;
    }

    const target = foe.active;
    const category = parseCategory(move.category);

    if (category !== 'status' && move.power > 0) {
      const result = computeDamage(user, target, move, this.data.typeChart, this.rng);
      if (result.typeMultiplier === 0.0) {
        this.log(`It doesn't affect ${target.nickname}...`);
        return;
      }
      const dealt = target.takeDamage(result.damage);
      if (result.crit) this.log('A critical hit!');
      const eff = TypeChart.describe(result.typeMultiplier);
      if (eff.length > 0) this.log(eff);
      this.log(`${target.nickname} took ${dealt} damage. (${target.currentHp}/${target.maxHp} HP)`);

      BattleEngine.gainSyncForHit(user, result.typeMultiplier);

      // drain / recoil
      if (move.effect.drainPercent > 0) {
        const drained = user.heal(Math.trunc((dealt * move.effect.drainPercent) / 100));
        if (drained > 0) this.log(`${user.nickname} drained ${drained} HP.`);
      }
      if (move.effect.recoilPercent > 0 && !user.isFainted) {
        const recoil = Math.max(1, Math.trunc((dealt * move.effect.recoilPercent) / 100));
        user.takeDamage(recoil);
        this.log(`${user.nickname} is hit with ${recoil} recoil.`);
      }
    } else {
      user.addSync(10);
    }

    this.applyMoveEffects(side, foe, move);
    BattleEngine.shiftTemperamentByMove(user, move);
  }

  private applyMoveEffects(side: BattleSide, foe: BattleSide, move: MoveData): void {
    const user = side.active;
    const target = foe.active;
    const fx = move.effect;

    if (fx.healPercent > 0) {
      const healed = user.heal(Math.trunc((user.maxHp * fx.healPercent) / 100));
      if (healed > 0) this.log(`${user.nickname} restored ${healed} HP.`);
    }

    if (fx.selfStat !== null && fx.selfStat.stages !== 0) {
      const applied = user.changeStage(parseStat(fx.selfStat.stat), fx.selfStat.stages);
      if (applied !== 0) this.log(`${user.nickname}'s ${fx.selfStat.stat} ${applied > 0 ? 'rose' : 'fell'}!`);
    }

    if (fx.targetStat !== null && fx.targetStat.stages !== 0 && !target.isFainted) {
      const applied = target.changeStage(parseStat(fx.targetStat.stat), fx.targetStat.stages);
      if (applied !== 0) this.log(`${target.nickname}'s ${fx.targetStat.stat} ${applied > 0 ? 'rose' : 'fell'}!`);
    }

    if (fx.status && fx.status.length > 0 && fx.statusChance > 0 && !target.isFainted) {
      const status: Status = parseStatus(fx.status);
      if (status !== 'None' && this.rng.chance(fx.statusChance) && target.setStatus(status)) {
        if (status === 'Dazed') target.setStatusCounter(this.rng.range(2, 4));
        this.log(`${target.nickname} is now ${status}!`);
      }
    }
  }

  private static gainSyncForHit(user: Kin, typeMult: number): void {
    const gain = typeMult > 1.0 ? 25 : typeMult < 1.0 ? 8 : 15;
    user.addSync(gain);
  }

  /** Attacking sculpts toward Ferocity; support/defense toward Harmony. */
  private static shiftTemperamentByMove(user: Kin, move: MoveData): void {
    const cat = parseCategory(move.category);
    if (cat === 'status' || move.effect.healPercent > 0) user.shiftTemperament(-2);
    else user.shiftTemperament(+2);
  }

  private canAct(kin: Kin): boolean {
    if (kin.status === 'Shock') {
      if (this.rng.chance(25)) {
        this.log(`${kin.nickname} is shocked and can't move!`);
        return false;
      }
    } else if (kin.status === 'Chill') {
      if (this.rng.chance(20)) {
        this.log(`${kin.nickname} is too chilled to move!`);
        return false;
      }
    } else if (kin.status === 'Dazed') {
      if (kin.statusCounter <= 0) {
        kin.clearStatus();
      } else {
        kin.decrementStatusCounter();
        if (this.rng.chance(33)) {
          const self = Math.max(1, Math.trunc(kin.maxHp / 12));
          kin.takeDamage(self);
          this.log(`${kin.nickname} is dazed and hurt itself (${self})!`);
          return false;
        }
      }
    }
    return true;
  }

  private endOfTurn(kin: Kin): void {
    if (kin.isFainted) return;
    if (kin.status === 'Burn') {
      const burn = Math.max(1, Math.trunc(kin.maxHp / 16));
      kin.takeDamage(burn);
      this.log(`${kin.nickname} is hurt by its burn (${burn}).`);
    } else if (kin.status === 'Root') {
      const root = Math.max(1, Math.trunc(kin.maxHp / 8));
      kin.takeDamage(root);
      this.log(`${kin.nickname} is sapped by roots (${root}).`);
    } else if (kin.status === 'Chill') {
      if (this.rng.chance(20)) {
        kin.clearStatus();
        this.log(`${kin.nickname} thawed out!`);
      }
    }
  }

  // ---------- Faint & outcome ----------

  private resolveFaints(): void {
    this.handleFaint(this.enemy, this.player);
    this.handleFaint(this.player, this.enemy);
  }

  private handleFaint(fainter: BattleSide, _winner: BattleSide): void {
    if (!fainter.active.isFainted || this.outcome !== 'Ongoing') return;
    this.log(`${fainter.active.nickname} fainted!`);

    if (!fainter.party.hasFightableKin) {
      this.outcome = fainter.isPlayer ? 'EnemyWin' : 'PlayerWin';
      if (this.outcome === 'PlayerWin') this.awardVictory();
      return;
    }
    const next = fainter.party.firstHealthyIndex();
    fainter.party.switchTo(next);
    this.log(`${fainter.name} sends out ${fainter.active.nickname}!`);
  }

  private awardVictory(): void {
    for (const k of this.player.party.members) {
      if (!k.isFainted) k.addResonance(k === this.player.active ? 3 : 1);
    }
  }
}
