/**
 * Deterministic battle resolution.
 *
 * The whole engine is a pure function of `(battleId, seed, both orders of battle, windBp)` — the
 * determinism claim of 20-aetherholm.md §4, written as a signature. No clock, no Math.random, no
 * database: two resolutions of one battle from stored inputs MUST produce byte-identical reports,
 * because the chronicle of a sealed season replays battles from exactly these inputs and a report
 * that changes on re-reading is not history.
 *
 * The report carries a sha256 digest over the canonicalised result — the `trade` backtest pattern
 * (trade/src/backtest.ts `digestOf`): bigints as decimal strings, keys sorted, so the hash cannot
 * change because a refactor reordered a field. `battles.test.ts` mutation-checks it: changing any
 * input changes the digest, and resolving twice does not.
 *
 * ## Mechanics, deliberately simple and entirely integer
 *
 * Round-based, at most MAX_ROUNDS. Each round, every surviving class-group acts in initiative
 * order (ties: attacker first, then class name). A group's volley is
 * `count * attack * windBp/10000 (attacker only) * roll(80..120)/100`, floor arithmetic, from a
 * splitmix64 stream seeded by hashing `(battleId, seed)`. Damage lands on the opposing side's
 * classes in ASCENDING initiative order — screens die first — against a hull pool; the defender's
 * pool is raised by the bulwark bonus. The winner is the side with the greater surviving hull
 * fraction; the tie goes to the defender, because the attacker chose the fight.
 */

import type { Db } from './outbox.ts'
import { createHash } from 'node:crypto';
import {
  AIRSHIPS,
  AIRSHIP_CLASSES,
  BULWARK_HULL_BONUS_BP_PER_LEVEL,
  type AirshipClass,
} from './content.ts';
import { splitmix64 } from './world.ts';

const MASK64 = (1n << 64n) - 1n;
export const MAX_ROUNDS = 6;

/** One side of a battle, as stored: class → count, plus the works protecting the defender. */
export interface OrderOfBattle {
  readonly ships: Readonly<Partial<Record<AirshipClass, number>>>;
  /** Defender only; 0 for a fleet in the open sky. */
  readonly bulwarkLevel: number;
}

export interface VolleyReport {
  readonly round: number;
  readonly side: 'attacker' | 'defender';
  readonly class: AirshipClass;
  readonly damage: string;
}

export interface BattleResult {
  readonly winner: 'attacker' | 'defender';
  readonly rounds: number;
  readonly volleys: readonly VolleyReport[];
  readonly attackerRemaining: Readonly<Partial<Record<AirshipClass, number>>>;
  readonly defenderRemaining: Readonly<Partial<Record<AirshipClass, number>>>;
  readonly attackerLosses: Readonly<Partial<Record<AirshipClass, number>>>;
  readonly defenderLosses: Readonly<Partial<Record<AirshipClass, number>>>;
}

export interface BattleInput {
  readonly battleId: string;
  /** The archipelago's seed — the season's, for the public world. */
  readonly seed: bigint;
  readonly attacker: OrderOfBattle;
  readonly defender: OrderOfBattle;
  /** Wind-advantage modifier from the lane of approach, basis points; 10000 is still air. */
  readonly windBp: number;
}

/** The PRNG stream for one battle: sha256(battleId, seed) folded to a u64, then splitmix64. */
export function battleSeed(battleId: string, seed: bigint): bigint {
  const digest = createHash('sha256')
    .update(`battle:${battleId}:${seed.toString()}`, 'utf8')
    .digest();
  let folded = 0n;
  for (let index = 0; index < 8; index += 1) folded = (folded << 8n) | BigInt(digest[index]!);
  return folded & MASK64;
}

interface Group {
  count: number;
  /** Remaining hull across the group, bulwark-inflated for the defender. */
  pool: bigint;
  /** Hull per ship in THIS pool's scale, so count = ceil(pool / per). */
  readonly per: bigint;
}

type SideState = Map<AirshipClass, Group>;

function buildSide(oob: OrderOfBattle, defender: boolean): SideState {
  const bonusBp = defender ? 10000 + oob.bulwarkLevel * BULWARK_HULL_BONUS_BP_PER_LEVEL : 10000;
  const side: SideState = new Map();
  for (const cls of AIRSHIP_CLASSES) {
    const raw = oob.ships[cls];
    if (raw === undefined || raw <= 0) continue;
    const count = Math.floor(raw);
    const per = (AIRSHIPS[cls].hull * BigInt(bonusBp)) / 10000n;
    side.set(cls, { count, pool: per * BigInt(count), per });
  }
  return side;
}

function totalPool(side: SideState): bigint {
  let total = 0n;
  for (const group of side.values()) total += group.pool;
  return total;
}

function countsOf(side: SideState): Partial<Record<AirshipClass, number>> {
  const out: Partial<Record<AirshipClass, number>> = {};
  for (const [cls, group] of side) if (group.count > 0) out[cls] = group.count;
  return out;
}

function lossesOf(
  before: OrderOfBattle,
  after: Partial<Record<AirshipClass, number>>,
): Partial<Record<AirshipClass, number>> {
  const out: Partial<Record<AirshipClass, number>> = {};
  for (const cls of AIRSHIP_CLASSES) {
    const had = Math.floor(before.ships[cls] ?? 0);
    if (had <= 0) continue;
    const lost = had - (after[cls] ?? 0);
    if (lost > 0) out[cls] = lost;
  }
  return out;
}

/** Damage lands ascending by initiative — the screens die before the capital ships. */
function applyDamage(target: SideState, damage: bigint): void {
  const order = [...target.keys()].sort(
    (a, b) => AIRSHIPS[a].initiative - AIRSHIPS[b].initiative || (a < b ? -1 : 1),
  );
  let remaining = damage;
  for (const cls of order) {
    if (remaining <= 0n) return;
    const group = target.get(cls)!;
    if (group.pool <= 0n) continue;
    const absorbed = remaining > group.pool ? group.pool : remaining;
    group.pool -= absorbed;
    remaining -= absorbed;
    group.count = group.pool <= 0n ? 0 : Number((group.pool + group.per - 1n) / group.per);
    if (group.count === 0) target.delete(cls);
  }
}

/**
 * Resolve a battle. Pure; call it twice, get the same bytes twice.
 */
export function resolveBattle(input: BattleInput): BattleResult {
  if (!Number.isInteger(input.windBp) || input.windBp <= 0) {
    throw new RangeError(`windBp must be a positive integer (got ${input.windBp})`);
  }
  let state = battleSeed(input.battleId, input.seed);
  const roll = (): bigint => {
    const next = splitmix64(state);
    state = next.next;
    // 80..120, the volley's fortune. Small on purpose: composition should beat luck.
    return 80n + (next.value % 41n);
  };

  const attacker = buildSide(input.attacker, false);
  const defender = buildSide(input.defender, true);
  const volleys: VolleyReport[] = [];
  let rounds = 0;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    if (attacker.size === 0 || defender.size === 0) break;
    rounds = round;
    // The round's actors, frozen at round start: a class wiped mid-round still acted if its
    // initiative came first, and does not if it did not.
    const actors: Array<{ side: 'attacker' | 'defender'; cls: AirshipClass }> = [];
    for (const cls of attacker.keys()) actors.push({ side: 'attacker', cls });
    for (const cls of defender.keys()) actors.push({ side: 'defender', cls });
    actors.sort((a, b) => {
      const initiative = AIRSHIPS[b.cls].initiative - AIRSHIPS[a.cls].initiative;
      if (initiative !== 0) return initiative;
      if (a.side !== b.side) return a.side === 'attacker' ? -1 : 1;
      return a.cls < b.cls ? -1 : 1;
    });

    for (const actor of actors) {
      const own = actor.side === 'attacker' ? attacker : defender;
      const other = actor.side === 'attacker' ? defender : attacker;
      const group = own.get(actor.cls);
      if (!group || group.count === 0 || other.size === 0) continue;
      const fortune = roll();
      let damage = (BigInt(group.count) * AIRSHIPS[actor.cls].attack * fortune) / 100n;
      if (actor.side === 'attacker') damage = (damage * BigInt(input.windBp)) / 10000n;
      if (damage <= 0n) continue;
      volleys.push({ round, side: actor.side, class: actor.cls, damage: damage.toString() });
      applyDamage(other, damage);
    }
  }

  const attackerRemaining = countsOf(attacker);
  const defenderRemaining = countsOf(defender);
  // The winner holds the sky: greater surviving hull. The tie — including mutual annihilation —
  // goes to the defender, who did not choose this fight.
  const winner: BattleResult['winner'] =
    totalPool(attacker) > totalPool(defender) ? 'attacker' : 'defender';

  return {
    winner,
    rounds,
    volleys,
    attackerRemaining,
    defenderRemaining,
    attackerLosses: lossesOf(input.attacker, attackerRemaining),
    defenderLosses: lossesOf(input.defender, defenderRemaining),
  };
}

/* ------------------------------------------------------------------ the digest */

/**
 * Canonical serialisation: bigints as decimal strings, keys sorted, undefined dropped — the
 * trade/src/backtest.ts rule, reproduced rather than imported because trade is a service, not a
 * package, and a cross-service source import is the thing CI greps against.
 */
export function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

/**
 * The report's digest: sha256 over the canonicalised INPUTS AND RESULT together. Inputs too,
 * deliberately — a digest over the result alone would stay valid for a report whose stored
 * orders of battle had been quietly rewritten, and the chronicle's replay check is exactly
 * "re-resolve from the stored inputs and compare".
 */
export function battleDigest(input: BattleInput, result: BattleResult): string {
  return createHash('sha256')
    .update(
      canonicalise({
        battleId: input.battleId,
        seed: input.seed,
        windBp: input.windBp,
        attacker: input.attacker,
        defender: input.defender,
        result,
      }),
    )
    .digest('hex');
}

/**
 * The wind-advantage modifier for an approach lane (20-aetherholm.md §4): riding a fast lane in
 * (a low multiplier) sharpens the attack, beating upwind blunts it. Bounded so the wind flavours
 * a battle rather than deciding it: ±25% at the lattice's extremes.
 */
export function windAdvantageBp(laneMultiplierBp: number): number {
  const raw = 10000 + Math.floor((10000 - laneMultiplierBp) / 4);
  return Math.min(12500, Math.max(7500, raw));
}
/** One line of a player's battle history. The full report stays at GET /v1/battles/:id. */
export interface BattleSummary {
  readonly id: string;
  readonly mission: string;
  readonly islandId: string | null;
  readonly attackerUserId: string;
  readonly defenderUserId: string;
  readonly outcome: string;
  readonly digest: string;
  readonly occurredAt: Date;
}

/**
 * The battles a user fought, either side, newest first.
 *
 * micro-aetherholm-web found the gap: only the by-id read existed, so a report could be opened
 * from a pasted id or the sealed chronicle and from nowhere else — a player could not see their
 * own history. The outcome is read from the stored result the same way the report renders it:
 * stored truth, never recomputed.
 */
export async function listBattlesFor(sql: Db, userId: string, limit: number): Promise<BattleSummary[]> {
  const rows = await sql<
    {
      id: string;
      mission: string;
      island_id: string | null;
      attacker_user_id: string;
      defender_user_id: string;
      result: { outcome?: string };
      digest: string;
      occurred_at: Date;
    }[]
  >`
    select id, mission, island_id, attacker_user_id, defender_user_id, result, digest, occurred_at
      from battles
     where attacker_user_id = ${userId} or defender_user_id = ${userId}
     order by occurred_at desc
     limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    mission: r.mission,
    islandId: r.island_id,
    attackerUserId: r.attacker_user_id,
    defenderUserId: r.defender_user_id,
    outcome: typeof r.result?.outcome === 'string' ? r.result.outcome : 'unknown',
    digest: r.digest,
    occurredAt: r.occurred_at,
  }));
}

