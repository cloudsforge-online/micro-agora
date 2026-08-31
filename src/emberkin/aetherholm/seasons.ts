/**
 * Seasons and their archipelagos.
 *
 * A season is 120 days of one seeded public archipelago; at most one season is open, and that is
 * a property of the schema (`seasons_one_open`, src/migrations.ts version 4), not of this module.
 * Two replicas racing `ensureOpenSeason` both try the insert; one commits, the other conflicts
 * and reads the winner. Season CLOSE — sealing, the chronicle, heraldry — is phase 2 and nothing
 * here anticipates it beyond the `status` CHECK's 'sealed' value.
 */

import {
  PUBLIC_ISLAND_COUNT,
  generateIslands,
  newSeed,
  type GeneratedIsland,
} from './world.ts';
import type { Db, Emit, Tx } from './outbox.ts';
import { withOutbox } from './outbox.ts';
import { ensureLattice } from './lattice.ts';

export const SEASON_OPENED_TOPIC = 'aetherholm.season.opened';

export const SEASON_DAYS = 120;

export interface SeasonRecord {
  readonly id: string;
  readonly name: string;
  readonly seed: bigint;
  readonly status: 'open' | 'sealed';
  readonly openedAt: Date;
  readonly endsAt: Date;
  readonly archipelagoId: string;
}

interface SeasonRow {
  readonly id: string;
  readonly name: string;
  readonly seed: string;
  readonly status: string;
  readonly opened_at: Date;
  readonly ends_at: Date;
  readonly archipelago_id: string;
}

function toSeason(row: SeasonRow): SeasonRecord {
  return {
    id: row.id,
    name: row.name,
    seed: BigInt(row.seed),
    status: row.status as SeasonRecord['status'],
    openedAt: row.opened_at,
    endsAt: row.ends_at,
    archipelagoId: row.archipelago_id,
  };
}

export async function openSeason(sql: Db | Tx): Promise<SeasonRecord | null> {
  const rows = await sql<SeasonRow[]>`
    select s.id, s.name, s.seed::text, s.status, s.opened_at, s.ends_at, a.id as archipelago_id
      from seasons s
      join archipelagos a on a.season_id = s.id and a.kind = 'public'
     where s.status = 'open'
  `;
  const row = rows[0];
  return row ? toSeason(row) : null;
}

/** Bulk-insert generated islands for an archipelago. Shared by seasons and skerry provisioning. */
export async function insertIslands(
  tx: Tx,
  archipelagoId: string,
  islands: readonly GeneratedIsland[],
): Promise<void> {
  const rows = islands.map((island) => ({
    archipelago_id: archipelagoId,
    idx: island.idx,
    band: island.band,
    plots: island.plots,
  }));
  await tx`insert into islands ${tx(rows)}`;
}

/**
 * Ensure an open season exists, creating one (season, public archipelago, ~200 islands) if not.
 *
 * Convergent under any number of racing callers: the partial unique index refuses the second
 * open season, the loser re-reads, and both return the same id. Run by the recurring
 * `season.ensure` leased job — never by a timer.
 */
export async function ensureOpenSeason(
  sql: Db,
  producer: string,
  now: Date,
  outbox: typeof withOutbox = withOutbox,
): Promise<SeasonRecord> {
  const existing = await openSeason(sql);
  if (existing) return existing;

  try {
    return await outbox(sql, producer, async (tx, emit) => {
      const counted = await tx<{ n: number }[]>`select count(*)::int as n from seasons`;
      const ordinal = (counted[0]?.n ?? 0) + 1;
      const seed = newSeed();
      const endsAt = new Date(now.getTime() + SEASON_DAYS * 24 * 60 * 60 * 1000);

      const seasons = await tx<{ id: string }[]>`
        insert into seasons (name, seed, status, opened_at, ends_at)
        values (${`Season ${ordinal}`}, ${seed.toString()}, 'open', ${now}, ${endsAt})
        returning id
      `;
      const seasonId = seasons[0]!.id;

      const archipelagos = await tx<{ id: string }[]>`
        insert into archipelagos (kind, season_id, name, seed)
        values ('public', ${seasonId}, ${`The Season ${ordinal} Archipelago`}, ${seed.toString()})
        returning id
      `;
      const archipelagoId = archipelagos[0]!.id;

      const islands = generateIslands(seed, PUBLIC_ISLAND_COUNT);
      await insertIslands(tx, archipelagoId, islands);
      // The winds and the spires, in the same transaction as the geography they cross: a season
      // whose lattice arrived later would be a world briefly without weather.
      await ensureLattice(tx, archipelagoId);

      emitSeasonOpened(emit, {
        seasonId,
        archipelagoId,
        seed,
        openedAt: now,
        endsAt,
        islandCount: islands.length,
        producer,
      });

      return {
        id: seasonId,
        name: `Season ${ordinal}`,
        seed,
        status: 'open' as const,
        openedAt: now,
        endsAt,
        archipelagoId,
      };
    });
  } catch (err) {
    // The partial unique index refused a second open season: another caller won. Read theirs.
    if (isUniqueViolation(err)) {
      const winner = await openSeason(sql);
      if (winner) return winner;
    }
    throw err;
  }
}

function emitSeasonOpened(
  emit: Emit,
  input: {
    seasonId: string;
    archipelagoId: string;
    seed: bigint;
    openedAt: Date;
    endsAt: Date;
    islandCount: number;
    producer: string;
  },
): void {
  emit({
    topic: SEASON_OPENED_TOPIC,
    key: input.seasonId,
    payload: {
      seasonId: input.seasonId,
      archipelagoId: input.archipelagoId,
      // The seed is PUBLIC once the season opens: geography is derivable by anyone, which is the
      // "no permanent geography knowledge to buy or hoard" rule (20-aetherholm.md §2).
      seed: input.seed.toString(),
      openedAt: input.openedAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
      islands: input.islandCount,
    },
    actor: `service:${input.producer}`,
  });
}

export class SeasonSealedError extends Error {
  constructor() {
    super('this season is sealed; the archipelago is history now');
    this.name = 'SeasonSealedError';
  }
}

/**
 * Refuse play on an archipelago whose season has sealed (20-aetherholm.md §2: the world FREEZES).
 * Skerries have no season and never seal. Shared by founding, queueing and launching, so "final
 * state" in the chronicle means final.
 */
export async function assertNotSealed(tx: Db | Tx, archipelagoId: string): Promise<void> {
  const rows = await tx<{ status: string }[]>`
    select s.status from archipelagos a join seasons s on s.id = a.season_id
     where a.id = ${archipelagoId}
  `;
  if (rows[0]?.status === 'sealed') throw new SeasonSealedError();
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

export interface IslandSummary {
  readonly id: string;
  readonly idx: number;
  readonly band: string;
  readonly plots: number;
  readonly freePlots: number;
  /**
   * Whether this island is an Aether Spire — the victory objective the whole season contests.
   * The column has existed since the lattice migration (`migrations.ts`, maintained at
   * `lattice.ts`) and this summary never selected it, so no client could mark a spire on any
   * map: the one thing doc 20 §5 says the archipelago screen must show. Found by
   * micro-aetherholm-web building that screen.
   */
  readonly spire: boolean;
}

/** The islands of an archipelago with their free plot counts — what a founder chooses from. */
export async function listIslands(sql: Db, archipelagoId: string): Promise<IslandSummary[]> {
  const rows = await sql<
    { id: string; idx: number; band: string; plots: number; occupied: number; is_spire: boolean }[]
  >`
    select i.id, i.idx, i.band, i.plots, i.is_spire,
           (select count(*)::int from cities c where c.island_id = i.id and c.abandoned_at is null)
             as occupied
      from islands i
     where i.archipelago_id = ${archipelagoId}
     order by i.idx
  `;
  return rows.map((row) => ({
    id: row.id,
    idx: row.idx,
    band: row.band,
    plots: row.plots,
    freePlots: row.plots - row.occupied,
    spire: row.is_spire,
  }));
}
