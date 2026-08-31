/**
 * The wind lattice, stored and served.
 *
 * Generation is pure (src/world.ts `generateLanes`, `spireIdxsFor`); this module is the database
 * half: write the lanes an archipelago's seed implies, flag its Aether Spires, and answer path
 * questions for fleet launches. `ensureLattice` is convergent under any number of racing callers
 * — every replica computes the SAME rows from the stored seed, and `lanes_directed_uniq` plus
 * `on conflict do nothing` make the second writer a no-op. That is also the phase-1 backfill:
 * archipelagos created before the lattice existed get theirs the first time the season job or a
 * launch looks.
 */

import { generateLanes, spireIdxsFor } from './world.ts';
import type { Db, Tx } from './outbox.ts';

export interface LaneRow {
  readonly id: string;
  readonly fromIslandId: string;
  readonly toIslandId: string;
  readonly multiplierBp: number;
  readonly travelSeconds: number;
}

interface RawLane {
  readonly id: string;
  readonly from_island_id: string;
  readonly to_island_id: string;
  readonly multiplier_bp: number;
  readonly travel_seconds: number;
}

function toLane(row: RawLane): LaneRow {
  return {
    id: row.id,
    fromIslandId: row.from_island_id,
    toIslandId: row.to_island_id,
    multiplierBp: row.multiplier_bp,
    travelSeconds: row.travel_seconds,
  };
}

/**
 * Ensure an archipelago's lanes and spire flags exist, deterministically from its stored seed.
 * Idempotent and race-safe; returns the lanes either way.
 */
export async function ensureLattice(sql: Db | Tx, archipelagoId: string): Promise<readonly LaneRow[]> {
  const existing = await listLanes(sql, archipelagoId);
  if (existing.length > 0) return existing;

  const archipelagos = await sql<{ seed: string }[]>`
    select seed::text from archipelagos where id = ${archipelagoId}
  `;
  const archipelago = archipelagos[0];
  if (!archipelago) return [];
  const islands = await sql<{ id: string; idx: number }[]>`
    select id, idx from islands where archipelago_id = ${archipelagoId} order by idx
  `;
  if (islands.length < 3) return [];

  const seed = BigInt(archipelago.seed);
  const byIdx = new Map(islands.map((island) => [island.idx, island.id]));
  const lanes = generateLanes(seed, islands.length);
  const rows = lanes
    .filter((lane) => byIdx.has(lane.fromIdx) && byIdx.has(lane.toIdx))
    .map((lane) => ({
      archipelago_id: archipelagoId,
      from_island_id: byIdx.get(lane.fromIdx)!,
      to_island_id: byIdx.get(lane.toIdx)!,
      multiplier_bp: lane.multiplierBp,
      travel_seconds: lane.travelSeconds,
    }));
  if (rows.length > 0) {
    // Racing replicas write identical rows; the unique absorbs the overlap.
    await sql`insert into lanes ${sql(rows)} on conflict (from_island_id, to_island_id) do nothing`;
  }

  const spires = new Set(spireIdxsFor(seed, islands.length));
  const spireIds = islands.filter((island) => spires.has(island.idx)).map((island) => island.id);
  if (spireIds.length > 0) {
    await sql`update islands set is_spire = true where id in ${sql(spireIds)} and is_spire = false`;
  }
  return listLanes(sql, archipelagoId);
}

export async function listLanes(sql: Db | Tx, archipelagoId: string): Promise<readonly LaneRow[]> {
  const rows = await sql<RawLane[]>`
    select l.id, l.from_island_id, l.to_island_id, l.multiplier_bp, l.travel_seconds
      from lanes l
      join islands f on f.id = l.from_island_id
     where l.archipelago_id = ${archipelagoId}
     order by f.idx, l.to_island_id
  `;
  return rows.map(toLane);
}

export interface LatticePath {
  /** The lanes flown, in order. The LAST one is the lane of approach. */
  readonly lanes: readonly LaneRow[];
  readonly seconds: number;
}

/**
 * Shortest path by travel time — Dijkstra with a deterministic tie-break (island id), so every
 * replica computes the same route and therefore the same lane of approach and the same battle.
 *
 * `laneSeconds` is a seam: the caller passes effective per-lane seconds (alliance shared lanes
 * discount theirs) without this function knowing about alliances.
 */
export function shortestPath(
  lanes: readonly LaneRow[],
  fromIslandId: string,
  toIslandId: string,
  laneSeconds: (lane: LaneRow) => number = (lane) => lane.travelSeconds,
): LatticePath | null {
  if (fromIslandId === toIslandId) return { lanes: [], seconds: 0 };
  const out = new Map<string, LaneRow[]>();
  for (const lane of lanes) {
    const list = out.get(lane.fromIslandId);
    if (list) list.push(lane);
    else out.set(lane.fromIslandId, [lane]);
  }
  const dist = new Map<string, number>([[fromIslandId, 0]]);
  const via = new Map<string, LaneRow>();
  const done = new Set<string>();

  for (;;) {
    let current: string | null = null;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (done.has(node)) continue;
      if (d < best || (d === best && current !== null && node < current)) {
        best = d;
        current = node;
      }
    }
    if (current === null) return null;
    if (current === toIslandId) break;
    done.add(current);
    for (const lane of out.get(current) ?? []) {
      const seconds = laneSeconds(lane);
      if (!Number.isInteger(seconds) || seconds <= 0) continue;
      const candidate = best + seconds;
      const known = dist.get(lane.toIslandId);
      if (known === undefined || candidate < known) {
        dist.set(lane.toIslandId, candidate);
        via.set(lane.toIslandId, lane);
      }
    }
  }

  const path: LaneRow[] = [];
  let node = toIslandId;
  while (node !== fromIslandId) {
    const lane = via.get(node);
    if (!lane) return null;
    path.unshift(lane);
    node = lane.fromIslandId;
  }
  return { lanes: path, seconds: dist.get(toIslandId)! };
}
