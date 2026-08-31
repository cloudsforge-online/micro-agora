/**
 * The authoritative game save.
 *
 * Campaign progress, party, inventory, catches and the per-Kin Resonance/Temperament/Sync state
 * live here in Postgres, not on the client. A new game is seeded once; every battle then resolves
 * server-side from that seed and the submitted actions (see battles.ts), which is also what makes
 * the async-PvP extension possible later.
 */

import { Rng } from './engine/rng.ts';
import { Kin } from './engine/kin.ts';
import { kinToSave, type KinSave } from './engine/saves.ts';
import type { GameData } from './content/gamedata.ts';
import type { Db, Emit, Tx } from './outbox.ts';

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface SaveState {
  readonly userId: string;
  readonly wardenName: string;
  readonly seed: bigint;
  readonly currentRegion: string;
  readonly storyProgress: number;
  readonly playtimeSeconds: number;
  readonly party: KinSave[];
  readonly box: KinSave[];
  readonly inventory: Record<string, number>;
  readonly seals: string[];
  readonly dexSeen: string[];
  readonly equippedCosmetics: Record<string, string>;
  readonly saveVersion: number;
}

interface SaveRow {
  readonly user_id: string;
  readonly warden_name: string;
  readonly seed: string;
  readonly current_region: string;
  readonly story_progress: number;
  readonly playtime_seconds: string;
  readonly party: KinSave[];
  readonly box: KinSave[];
  readonly inventory: Record<string, number>;
  readonly seals: string[];
  readonly dex_seen: string[];
  readonly equipped_cosmetics: Record<string, string>;
  readonly save_version: number;
}

function toState(row: SaveRow): SaveState {
  return {
    userId: row.user_id,
    wardenName: row.warden_name,
    seed: BigInt(row.seed),
    currentRegion: row.current_region,
    storyProgress: row.story_progress,
    playtimeSeconds: Number(row.playtime_seconds),
    party: row.party,
    box: row.box,
    inventory: row.inventory,
    seals: row.seals,
    dexSeen: row.dex_seen,
    equippedCosmetics: row.equipped_cosmetics,
    saveVersion: row.save_version,
  };
}

const SELECT = (sql: Db | Tx, userId: string) => sql<SaveRow[]>`
  select user_id, warden_name, seed::text as seed, current_region, story_progress,
         playtime_seconds::text as playtime_seconds, party, box, inventory, seals, dex_seen,
         equipped_cosmetics, save_version
    from saves where user_id = ${userId}
`;

export async function getSave(sql: Db, userId: string): Promise<SaveState> {
  const rows = await SELECT(sql, userId);
  const row = rows[0];
  if (!row) throw new NotFoundError(`no save for user ${userId}`);
  return toState(row);
}

export async function findSave(sql: Db, userId: string): Promise<SaveState | null> {
  const rows = await SELECT(sql, userId);
  return rows[0] ? toState(rows[0]) : null;
}

export interface StartGameInput {
  readonly userId: string;
  readonly wardenName: string;
  readonly starter: string;
  readonly seed?: bigint;
  readonly correlationId?: string;
}

const STARTER_LEVEL = 5;
const STARTING_INVENTORY: Record<string, number> = { resonator: 5, potion: 3 };

function randomSeed(): bigint {
  // A ulong. Two 32-bit halves from Math.random keep it in range without a crypto dep.
  const hi = BigInt(Math.floor(Math.random() * 0x1_0000_0000));
  const lo = BigInt(Math.floor(Math.random() * 0x1_0000_0000));
  return (hi << 32n) | lo;
}

/**
 * Start a new game. Idempotent per account: a second call for a user who already has a save returns
 * the existing one rather than resetting their progress.
 */
export async function startGame(
  sql: Db,
  producer: string,
  data: GameData,
  input: StartGameInput,
  withOutbox: <T>(sql: Db, producer: string, fn: (tx: Tx, emit: Emit) => Promise<T>) => Promise<T>,
): Promise<{ save: SaveState; created: boolean }> {
  const existing = await findSave(sql, input.userId);
  if (existing) return { save: existing, created: false };

  if (!data.campaign.starters.includes(input.starter)) {
    throw new ValidationError(`'${input.starter}' is not a starter (choose one of ${data.campaign.starters.join(', ')})`);
  }
  const name = input.wardenName.trim();
  if (name.length < 1 || name.length > 40) throw new ValidationError('wardenName must be 1–40 characters');

  const seed = input.seed ?? randomSeed();
  const rng = new Rng(seed);
  const starterKin = kinToSave(Kin.create(data.getSpecies(input.starter), STARTER_LEVEL, rng));

  const save = await withOutbox(sql, producer, async (tx, emit) => {
    const rows = await tx<SaveRow[]>`
      insert into saves (user_id, warden_name, seed, current_region, party, inventory, dex_seen)
      values (
        ${input.userId}, ${name}, ${seed.toString()}, ${data.campaign.startRegion},
        ${tx.json([starterKin] as unknown as Record<string, never>)},
        ${tx.json(STARTING_INVENTORY as unknown as Record<string, never>)},
        ${tx.json([input.starter] as unknown as Record<string, never>)}
      )
      on conflict (user_id) do nothing
      returning user_id, warden_name, seed::text as seed, current_region, story_progress,
                playtime_seconds::text as playtime_seconds, party, box, inventory, seals, dex_seen,
                equipped_cosmetics, save_version
    `;
    const row = rows[0];
    if (!row) return null; // lost a race; caller re-reads
    emit({
      topic: 'emberkin.save.started',
      key: input.userId,
      payload: { userId: input.userId, starter: input.starter, region: data.campaign.startRegion },
      actor: `user:${input.userId}`,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
    return toState(row);
  });

  if (!save) return { save: await getSave(sql, input.userId), created: false };
  return { save, created: true };
}

/** Persist an updated party/box/dex after a battle. Called inside the battle transaction. */
export async function persistSaveProgress(
  tx: Tx,
  userId: string,
  update: { party: KinSave[]; box: KinSave[]; dexSeen: string[] },
): Promise<void> {
  await tx`
    update saves
       set party = ${tx.json(update.party as unknown as Record<string, never>)},
           box = ${tx.json(update.box as unknown as Record<string, never>)},
           dex_seen = ${tx.json(update.dexSeen as unknown as Record<string, never>)},
           updated_at = now()
     where user_id = ${userId}
  `;
}
