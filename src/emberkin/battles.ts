/**
 * Server-side battle resolution.
 *
 * The client is not authoritative: it submits an enemy and a script of actions, and the server
 * resolves the battle from the SAVE's party plus a seed, using the same deterministic engine the
 * conformance corpus pins to the C# reference. The full turn-by-turn log and the resolved party
 * state are recorded.
 *
 * A submission carries an Idempotency-Key. The recorded battle is keyed on `(user, key)` with the
 * key fingerprinting the request body but EXCLUDING per-attempt fields (correlationId), so a retry
 * REPLAYS the recorded battle rather than resolving — and double-applying — a second one.
 */

import { Rng } from './engine/rng.ts';
import { Kin } from './engine/kin.ts';
import { Party } from './engine/party.ts';
import { BattleEngine } from './engine/battle.ts';
import { BattleAction, BattleSide, type BattleOutcome } from './engine/battletypes.ts';
import { kinFromSave, kinToSave, type KinSave } from './engine/saves.ts';
import type { KinSpec, ScriptAction } from './engine/replay.ts';
import type { GameData } from './content/gamedata.ts';
import { getSave } from './savegame.ts';
import { ValidationError } from './savegame.ts';
import type { Db, Emit, Tx } from './outbox.ts';

export interface EnemySpec {
  readonly name: string;
  readonly isWild: boolean;
  readonly party: readonly KinSpec[];
}

export interface ResolveBattleInput {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly enemy: EnemySpec;
  readonly script?: readonly ScriptAction[];
  readonly maxTurns?: number;
  readonly seed?: bigint;
  readonly correlationId?: string;
}

export interface UnlockedAchievement {
  readonly code: string;
  readonly name: string;
  readonly points: number;
}

export interface BattleResult {
  readonly id: string;
  readonly outcome: BattleOutcome;
  readonly turns: number;
  readonly log: string[];
  readonly replayed: boolean;
  readonly unlocked: UnlockedAchievement[];
}

const RESONANCE_ACHIEVEMENTS: readonly UnlockedAchievement[] = [
  { code: 'resonance_attuned', name: 'Attuned', points: 10 },
  { code: 'resonance_resonant', name: 'Resonant', points: 25 },
  { code: 'resonance_perfect', name: 'Perfect Resonance', points: 50 },
];
const RESONANCE_THRESHOLDS: Record<string, number> = {
  resonance_attuned: 25,
  resonance_resonant: 50,
  resonance_perfect: 100,
};
const DEX_COMPLETE: UnlockedAchievement = { code: 'dex_complete', name: 'Dex Complete', points: 100 };

function toAction(active: Kin, a: ScriptAction): BattleAction {
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

interface BattleRow {
  readonly id: string;
  readonly outcome: BattleOutcome;
  readonly turns: number;
  readonly log: string[];
}

/**
 * Resolve a battle and apply its outcome to the save, or replay the recorded one on a retry.
 */
export async function resolveBattle(
  sql: Db,
  producer: string,
  data: GameData,
  input: ResolveBattleInput,
  withOutbox: <T>(sql: Db, producer: string, fn: (tx: Tx, emit: Emit) => Promise<T>) => Promise<T>,
): Promise<BattleResult> {
  // Short-circuit a known retry before doing any work.
  const prior = await sql<BattleRow[]>`
    select id, outcome, turns, log from battles
     where user_id = ${input.userId} and idempotency_key = ${input.idempotencyKey}
  `;
  if (prior[0]) {
    return { ...prior[0], log: prior[0].log, replayed: true, unlocked: [] };
  }

  const save = await getSave(sql, input.userId);
  if (save.party.length === 0) throw new ValidationError('the save has no party to battle with');
  if (input.enemy.party.length === 0) throw new ValidationError('an enemy party is required');

  const seed = input.seed ?? save.seed;
  const rng = new Rng(seed);

  // Player party is RESTORED from the authoritative save (no rng); the enemy is generated from the
  // seed, the way a wild encounter is rolled.
  const playerParty = new Party();
  for (const k of save.party) playerParty.add(kinFromSave(k, data));
  const enemyParty = new Party();
  for (const e of input.enemy.party) {
    enemyParty.add(Kin.create(data.getSpecies(e.species), e.level, rng, e.resonance, e.temperament));
  }

  const player = new BattleSide(playerParty, save.wardenName, true, false);
  const enemy = new BattleSide(enemyParty, input.enemy.name, false, input.enemy.isWild);

  const log: string[] = [];
  const engine = new BattleEngine(data, rng, player, enemy, (line) => log.push(line));
  engine.start();
  const script = input.script ?? [];
  const maxTurns = input.maxTurns ?? 100;
  let i = 0;
  while (engine.outcome === 'Ongoing' && i < maxTurns) {
    const a: ScriptAction = i < script.length ? script[i]! : { kind: 'move', slot: 0 };
    engine.executeTurn(toAction(player.active, a));
    i++;
  }

  // Compute the post-battle save mutation.
  const newParty: KinSave[] = playerParty.members.map(kinToSave);
  const newBox: KinSave[] = [...save.box];
  const dexSeen = new Set(save.dexSeen);
  if (engine.outcome === 'Caught') {
    const caught = enemy.active;
    newBox.push(kinToSave(caught));
    dexSeen.add(caught.species.id);
  }

  // Candidate achievements: any party Kin over a Resonance threshold, and dex completion.
  const candidates: UnlockedAchievement[] = [];
  const maxResonance = Math.max(0, ...playerParty.members.map((k) => k.resonance));
  for (const a of RESONANCE_ACHIEVEMENTS) {
    if (maxResonance >= RESONANCE_THRESHOLDS[a.code]!) candidates.push(a);
  }
  if (dexSeen.size >= data.dex.length) candidates.push(DEX_COMPLETE);

  const spec = { seed: seed.toString(), enemy: input.enemy, script, maxTurns };

  const applied = await withOutbox(sql, producer, async (tx, emit) => {
    const inserted = await tx<{ id: string }[]>`
      insert into battles (user_id, seed, spec, outcome, turns, log, idempotency_key)
      values (
        ${input.userId}, ${seed.toString()}, ${tx.json(spec as unknown as Record<string, never>)},
        ${engine.outcome}, ${engine.turnNumber},
        ${tx.json(log as unknown as Record<string, never>)}, ${input.idempotencyKey}
      )
      on conflict (user_id, idempotency_key) do nothing
      returning id
    `;
    const row = inserted[0];
    if (!row) return null; // lost a race with a concurrent identical submission

    await tx`
      update saves
         set party = ${tx.json(newParty as unknown as Record<string, never>)},
             box = ${tx.json(newBox as unknown as Record<string, never>)},
             dex_seen = ${tx.json([...dexSeen] as unknown as Record<string, never>)},
             updated_at = now()
       where user_id = ${input.userId}
    `;

    const unlocked: UnlockedAchievement[] = [];
    for (const a of candidates) {
      const got = await tx<{ code: string }[]>`
        insert into player_achievements (user_id, code, name, points)
        values (${input.userId}, ${a.code}, ${a.name}, ${a.points})
        on conflict (user_id, code) do nothing
        returning code
      `;
      if (got[0]) {
        unlocked.push(a);
        emit({
          topic: 'emberkin.achievement.unlocked',
          key: `${input.userId}:${a.code}`,
          payload: { userId: input.userId, code: a.code, name: a.name, points: a.points },
          actor: `user:${input.userId}`,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        });
      }
    }

    emit({
      topic: 'emberkin.battle.resolved',
      key: row.id,
      payload: { userId: input.userId, battleId: row.id, outcome: engine.outcome, turns: engine.turnNumber },
      actor: `user:${input.userId}`,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });

    return { id: row.id, unlocked };
  });

  if (!applied) {
    // A concurrent identical submission won; replay its recorded row.
    const again = await sql<BattleRow[]>`
      select id, outcome, turns, log from battles
       where user_id = ${input.userId} and idempotency_key = ${input.idempotencyKey}
    `;
    const row = again[0]!;
    return { ...row, replayed: true, unlocked: [] };
  }

  return {
    id: applied.id,
    outcome: engine.outcome,
    turns: engine.turnNumber,
    log,
    replayed: false,
    unlocked: applied.unlocked,
  };
}
