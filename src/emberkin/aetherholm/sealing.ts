/**
 * Season close: at day 120 the archipelago seals into history (20-aetherholm.md §2, §9.5).
 *
 * Sealing is a LEASED JOB (`season.close`, keyed `season:<id>`), never a timer: the job is
 * enqueued for `ends_at` when the season opens, and the recurring `season.ensure` re-enqueues it
 * (`onConflict: 'keep'`) so a season opened before this code existed still gets its closing day.
 *
 * What sealing does, in one transaction:
 *   1. Decides the Aether Spires — the flagged islands of the seed — and who holds each one:
 *      the alliance (or unaligned player) with the most surviving cities on the island; a tie
 *      holds for nobody.
 *   2. Writes the chronicle row: the final state, every battle digest, the victors — with its
 *      own sha256 digest over the canonicalised summary, so "this is what happened" is checkable
 *      by anyone holding the bytes.
 *   3. Flips the season to 'sealed'. From the next statement on, the trigger
 *      `seasons_sealed_immutable` refuses UPDATE and DELETE at the database, even to a caller
 *      holding a connection.
 *   4. Emits `aetherholm.spire.captured` per held spire and `aetherholm.season.sealed` once —
 *      heraldry becomes WORLDS entitlements via the outbox; this service never writes to worlds.
 */

import { createHash } from 'node:crypto';
import { canonicalise } from './battles.ts';
import { ensureLattice } from './lattice.ts';
import { withOutbox, type Db, type Tx } from './outbox.ts';

export const SEASON_SEALED_TOPIC = 'aetherholm.season.sealed';
export const SPIRE_CAPTURED_TOPIC = 'aetherholm.spire.captured';

export interface SpireHolder {
  readonly kind: 'alliance' | 'user';
  /** Set for an alliance holder; the game-side id AND the community it is bound to. */
  readonly allianceId?: string;
  readonly communityId?: string;
  readonly allianceName?: string;
  /** Set for an unaligned holder. */
  readonly userId?: string;
  /** Every player the heraldry reaches — the alliance's members, or the one solo holder. */
  readonly memberUserIds: readonly string[];
  readonly cities: number;
}

export interface SpireStanding {
  readonly islandId: string;
  readonly islandIdx: number;
  readonly holder: SpireHolder | null;
}

/**
 * Who holds one spire island: group its surviving cities by the owner's alliance (unaligned
 * players stand alone), and the strictly-largest group holds. A tie holds for nobody — a
 * contested spire at the bell is a contested spire forever.
 */
export async function spireStanding(
  tx: Tx,
  archipelagoId: string,
  islandId: string,
  islandIdx: number,
): Promise<SpireStanding> {
  const rows = await tx<
    {
      user_id: string;
      alliance_id: string | null;
      community_id: string | null;
      alliance_name: string | null;
    }[]
  >`
    select c.user_id, a.id as alliance_id, a.community_id, a.name as alliance_name
      from cities c
      left join alliance_members m
        on m.user_id = c.user_id and m.archipelago_id = ${archipelagoId}
      left join alliances a on a.id = m.alliance_id
     where c.island_id = ${islandId} and c.abandoned_at is null
  `;
  interface Bucket {
    holder: Omit<SpireHolder, 'memberUserIds' | 'cities'>;
    members: Set<string>;
    cities: number;
  }
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const key = row.alliance_id ? `alliance:${row.alliance_id}` : `user:${row.user_id}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      const holder: Bucket['holder'] = row.alliance_id
        ? {
            kind: 'alliance',
            allianceId: row.alliance_id,
            ...(row.community_id ? { communityId: row.community_id } : {}),
            ...(row.alliance_name ? { allianceName: row.alliance_name } : {}),
          }
        : { kind: 'user', userId: row.user_id };
      bucket = { holder, members: new Set<string>(), cities: 0 };
    }
    bucket.members.add(row.user_id);
    bucket.cities += 1;
    buckets.set(key, bucket);
  }

  let best: Bucket | null = null;
  let tied = false;
  for (const bucket of buckets.values()) {
    if (!best || bucket.cities > best.cities) {
      best = bucket;
      tied = false;
    } else if (bucket.cities === best.cities) {
      tied = true;
    }
  }
  if (!best || tied) return { islandId, islandIdx, holder: null };
  return {
    islandId,
    islandIdx,
    holder: { ...best.holder, memberUserIds: [...best.members].sort(), cities: best.cities },
  };
}

export interface SealOutcome {
  readonly seasonId: string;
  readonly digest: string;
  readonly spires: readonly SpireStanding[];
}

/**
 * Seal one season if its day has come. Idempotent and race-safe: the row is locked
 * `for update`, the `status = 'open'` guard means a second runner finds nothing to do, and once
 * the winner commits, the trigger makes every later write a database error.
 */
export async function sealSeason(
  sql: Db,
  producer: string,
  seasonId: string,
  now = new Date(),
  outbox: typeof withOutbox = withOutbox,
): Promise<SealOutcome | null> {
  return outbox(sql, producer, async (tx, emit) => {
    const seasons = await tx<
      { id: string; name: string; seed: string; ends_at: Date; archipelago_id: string }[]
    >`
      select s.id, s.name, s.seed::text, s.ends_at, a.id as archipelago_id
        from seasons s
        join archipelagos a on a.season_id = s.id and a.kind = 'public'
       where s.id = ${seasonId} and s.status = 'open'
       for update of s
    `;
    const season = seasons[0];
    if (!season) return null;
    if (season.ends_at.getTime() > now.getTime()) return null;

    // A pre-lattice season may reach its 120th day never having flagged its spires.
    await ensureLattice(tx, season.archipelago_id);

    const spireIslands = await tx<{ id: string; idx: number }[]>`
      select id, idx from islands
       where archipelago_id = ${season.archipelago_id} and is_spire
       order by idx
    `;
    const spires: SpireStanding[] = [];
    for (const island of spireIslands) {
      spires.push(await spireStanding(tx, season.archipelago_id, island.id, island.idx));
    }

    const counts = await tx<{ cities: number; battles: number }[]>`
      select
        (select count(*)::int from cities c
          join islands i on i.id = c.island_id
         where i.archipelago_id = ${season.archipelago_id} and c.abandoned_at is null) as cities,
        (select count(*)::int from battles where archipelago_id = ${season.archipelago_id}) as battles
    `;
    const battleDigests = await tx<{ id: string; digest: string }[]>`
      select id, digest from battles
       where archipelago_id = ${season.archipelago_id}
       order by occurred_at, id
    `;

    // The victors: every holder, ranked by spires held. This is the list heraldry reaches.
    const victorBuckets = new Map<string, { holder: SpireHolder; spires: number }>();
    for (const spire of spires) {
      if (!spire.holder) continue;
      const key = spire.holder.allianceId ? `alliance:${spire.holder.allianceId}` : `user:${spire.holder.userId}`;
      const existing = victorBuckets.get(key);
      if (existing) victorBuckets.set(key, { holder: existing.holder, spires: existing.spires + 1 });
      else victorBuckets.set(key, { holder: spire.holder, spires: 1 });
    }
    const victors = [...victorBuckets.values()].sort(
      (a, b) => b.spires - a.spires || (a.holder.allianceId ?? a.holder.userId ?? '').localeCompare(b.holder.allianceId ?? b.holder.userId ?? ''),
    );

    const summary = {
      seasonId: season.id,
      name: season.name,
      seed: season.seed,
      sealedAt: now.toISOString(),
      archipelagoId: season.archipelago_id,
      cities: counts[0]!.cities,
      battles: counts[0]!.battles,
      battleDigests: battleDigests.map((battle) => ({ id: battle.id, digest: battle.digest })),
      spires,
      victors,
    };
    const digest = createHash('sha256').update(canonicalise(summary)).digest('hex');

    await tx`
      insert into chronicles (season_id, sealed_at, summary, digest)
      values (${season.id}, ${now}, ${tx.json(JSON.parse(JSON.stringify(summary)) as never)}, ${digest})
    `;
    // The LAST write this row will ever accept: after this statement commits, the trigger
    // refuses everything, this service included.
    await tx`
      update seasons set status = 'sealed', sealed_at = ${now} where id = ${season.id}
    `;

    for (const spire of spires) {
      if (!spire.holder) continue;
      emit({
        topic: SPIRE_CAPTURED_TOPIC,
        key: spire.islandId,
        payload: {
          seasonId: season.id,
          seasonName: season.name,
          islandId: spire.islandId,
          islandIdx: spire.islandIdx,
          holderKind: spire.holder.kind,
          allianceId: spire.holder.allianceId ?? null,
          communityId: spire.holder.communityId ?? null,
          allianceName: spire.holder.allianceName ?? null,
          holderUserId: spire.holder.userId ?? null,
          // The heraldry's reach, carried on the payload: notify holds no membership table and
          // must not guess (the community events precedent, notify/src/catalogue.ts membersOf).
          userIds: spire.holder.memberUserIds,
          cities: spire.holder.cities,
        },
        actor: `service:${producer}`,
      });
    }
    emit({
      topic: SEASON_SEALED_TOPIC,
      key: season.id,
      payload: {
        seasonId: season.id,
        name: season.name,
        seed: season.seed,
        sealedAt: now.toISOString(),
        digest,
        battles: counts[0]!.battles,
        victors: victors.map((victor) => ({
          kind: victor.holder.kind,
          allianceId: victor.holder.allianceId ?? null,
          communityId: victor.holder.communityId ?? null,
          allianceName: victor.holder.allianceName ?? null,
          userId: victor.holder.userId ?? null,
          userIds: victor.holder.memberUserIds,
          spires: victor.spires,
        })),
      },
      actor: `service:${producer}`,
    });

    return { seasonId: season.id, digest, spires };
  });
}

/* ------------------------------------------------------------------ the chronicle, read */

export interface ChronicleListing {
  readonly seasonId: string;
  readonly name: string;
  readonly seed: string;
  readonly sealedAt: Date;
  readonly digest: string;
}

/** Sealed seasons only — the anonymous surface. A live season never appears here. */
export async function listChronicles(sql: Db): Promise<ChronicleListing[]> {
  const rows = await sql<
    { season_id: string; name: string; seed: string; sealed_at: Date; digest: string }[]
  >`
    select c.season_id, s.name, s.seed::text, c.sealed_at, c.digest
      from chronicles c
      join seasons s on s.id = c.season_id
     where s.status = 'sealed'
     order by c.sealed_at desc
  `;
  return rows.map((row) => ({
    seasonId: row.season_id,
    name: row.name,
    seed: row.seed,
    sealedAt: row.sealed_at,
    digest: row.digest,
  }));
}

export async function getChronicle(
  sql: Db,
  seasonId: string,
): Promise<{ summary: Record<string, unknown>; digest: string; sealedAt: Date } | null> {
  const rows = await sql<{ summary: Record<string, unknown>; digest: string; sealed_at: Date }[]>`
    select c.summary, c.digest, c.sealed_at
      from chronicles c
      join seasons s on s.id = c.season_id
     where c.season_id = ${seasonId} and s.status = 'sealed'
  `;
  const row = rows[0];
  return row ? { summary: row.summary, digest: row.digest, sealedAt: row.sealed_at } : null;
}

/** A sealed season's battles, verbatim: the replay browser's data source (doc §10.1). */
export async function listSealedBattles(
  sql: Db,
  seasonId: string,
): Promise<readonly Record<string, unknown>[] | null> {
  const sealed = await sql<{ archipelago_id: string }[]>`
    select a.id as archipelago_id
      from seasons s
      join archipelagos a on a.season_id = s.id and a.kind = 'public'
     where s.id = ${seasonId} and s.status = 'sealed'
  `;
  const season = sealed[0];
  if (!season) return null;
  const rows = await sql<Record<string, unknown>[]>`
    select id, island_id, plot, mission, wind_bp, seed::text,
           attacker_oob, defender_oob, result, digest, occurred_at
      from battles
     where archipelago_id = ${season.archipelago_id}
     order by occurred_at, id
  `;
  return rows;
}
