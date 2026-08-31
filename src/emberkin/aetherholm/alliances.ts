/**
 * Alliances: the game half of a `micro-community` community (20-aetherholm.md §6).
 *
 * **An alliance IS a community.** Proposals, votes, officers, timelocks and the treasury already
 * exist in `community` (community/src/server.ts serves the whole governance surface) and are
 * governance, not game logic. This module therefore REFUSES to create communities: founding an
 * alliance requires a `communityId` the caller already has, stored as a reference by id across
 * the service boundary — never a foreign key, never a second voting system, and there is no
 * outbound call to community here at all. Verifying the reference is community's job the moment
 * governance is exercised through it; a fabricated id buys an alliance whose treasury and votes
 * simply do not exist.
 *
 * What IS game logic lives here: membership per archipelago (one banner per player per world,
 * unrepresentable via `alliance_members_one_per_world`), island claims (one per island, first
 * banner planted wins — the primary key is the race), beacons (the islands where a member city
 * flies a Guild Beacon), and shared lanes (lanes between two claimed islands, which members fly
 * 10% faster — src/fleets.ts applies it at launch).
 */

import { NotFoundError, ValidationError } from './cities.ts';
import { isUniqueViolation } from './seasons.ts';
import { withOutbox, type Db } from './outbox.ts';

export class AlreadyAlignedError extends Error {
  constructor() {
    super('this player already flies a banner on this archipelago');
    this.name = 'AlreadyAlignedError';
  }
}
export class ClaimTakenError extends Error {
  constructor() {
    super('this island is already claimed');
    this.name = 'ClaimTakenError';
  }
}
export class NotMemberError extends Error {
  constructor() {
    super('not a member of this alliance');
    this.name = 'NotMemberError';
  }
}

export interface FoundAllianceInput {
  readonly archipelagoId: string;
  /** The micro-community community this alliance IS. Required; never created here. */
  readonly communityId: string;
  readonly name: string;
  readonly userId: string;
  readonly correlationId: string;
}

export interface AllianceView {
  readonly id: string;
  readonly archipelagoId: string;
  readonly communityId: string;
  readonly name: string;
  readonly foundedBy: string;
  readonly createdAt: Date;
  readonly members: readonly { userId: string; joinedAt: Date }[];
  readonly claims: readonly { islandId: string; claimedBy: string; claimedAt: Date }[];
  /** Islands where a member city flies a Guild Beacon: the alliance's visible presence. */
  readonly beacons: readonly string[];
  /** Lanes between two claimed islands — the ones members fly at the shared-lane discount. */
  readonly sharedLanes: readonly { laneId: string; fromIslandId: string; toIslandId: string }[];
}

export async function foundAlliance(
  sql: Db,
  producer: string,
  input: FoundAllianceInput,
  outbox: typeof withOutbox = withOutbox,
): Promise<AllianceView> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) {
    throw new ValidationError('an alliance name must be 1 to 60 characters');
  }
  try {
    const allianceId = await outbox(sql, producer, async (tx) => {
      const worlds = await tx<{ id: string }[]>`
        select id from archipelagos where id = ${input.archipelagoId}
      `;
      if (!worlds[0]) throw new NotFoundError('no such archipelago');
      const inserted = await tx<{ id: string }[]>`
        insert into alliances (archipelago_id, community_id, name, founded_by)
        values (${input.archipelagoId}, ${input.communityId}, ${name}, ${input.userId})
        returning id
      `;
      const allianceId = inserted[0]!.id;
      await tx`
        insert into alliance_members (alliance_id, archipelago_id, user_id)
        values (${allianceId}, ${input.archipelagoId}, ${input.userId})
      `;
      return allianceId;
    });
    const view = await getAlliance(sql, allianceId);
    return view!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('alliance_members_one_per_world')) throw new AlreadyAlignedError();
      if (message.includes('alliances_community_uniq')) {
        throw new ValidationError('that community already backs an alliance on this archipelago');
      }
    }
    throw err;
  }
}

/** One row of the alliance directory: enough to choose one, not the full view. */
export interface AllianceSummary {
  readonly id: string;
  readonly name: string;
  readonly memberCount: number;
  readonly mine: boolean;
}

/**
 * The alliance directory for one archipelago, with the caller's own membership marked.
 *
 * micro-aetherholm-web found the gap: only `GET /v1/alliances/:id` existed, so a client could
 * neither browse alliances nor answer "which am I in" — a player had to be handed an id out of
 * band. `mine` is computed here rather than by a second request, because "which am I in" is the
 * question the screen opens with.
 */
export async function listAlliances(
  sql: Db,
  archipelagoId: string,
  viewerUserId: string | null,
): Promise<AllianceSummary[]> {
  const rows = await sql<{ id: string; name: string; member_count: number; mine: boolean }[]>`
    select a.id, a.name,
           (select count(*)::int from alliance_members m where m.alliance_id = a.id) as member_count,
           exists (
             select 1 from alliance_members m
              where m.alliance_id = a.id and m.user_id = ${viewerUserId}
           ) as mine
      from alliances a
     where a.archipelago_id = ${archipelagoId}
     order by member_count desc, a.created_at asc
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, memberCount: r.member_count, mine: r.mine }));
}

export async function getAlliance(sql: Db, allianceId: string): Promise<AllianceView | null> {
  const rows = await sql<
    {
      id: string;
      archipelago_id: string;
      community_id: string;
      name: string;
      founded_by: string;
      created_at: Date;
    }[]
  >`
    select id, archipelago_id, community_id, name, founded_by, created_at
      from alliances where id = ${allianceId}
  `;
  const alliance = rows[0];
  if (!alliance) return null;

  const members = await sql<{ user_id: string; joined_at: Date }[]>`
    select user_id, joined_at from alliance_members
     where alliance_id = ${allianceId} order by joined_at
  `;
  const claims = await sql<{ island_id: string; claimed_by: string; claimed_at: Date }[]>`
    select island_id, claimed_by, claimed_at from alliance_claims
     where alliance_id = ${allianceId} order by claimed_at
  `;
  const beacons = await sql<{ island_id: string }[]>`
    select distinct c.island_id
      from cities c
      join alliance_members m
        on m.user_id = c.user_id and m.archipelago_id = ${alliance.archipelago_id}
      join buildings b on b.city_id = c.id and b.type = 'guild_beacon' and b.level >= 1
     where m.alliance_id = ${allianceId} and c.abandoned_at is null
     order by c.island_id
  `;
  const sharedLanes = await sql<{ id: string; from_island_id: string; to_island_id: string }[]>`
    select l.id, l.from_island_id, l.to_island_id
      from lanes l
      join alliance_claims cf on cf.island_id = l.from_island_id and cf.alliance_id = ${allianceId}
      join alliance_claims ct on ct.island_id = l.to_island_id and ct.alliance_id = ${allianceId}
     order by l.id
  `;
  return {
    id: alliance.id,
    archipelagoId: alliance.archipelago_id,
    communityId: alliance.community_id,
    name: alliance.name,
    foundedBy: alliance.founded_by,
    createdAt: alliance.created_at,
    members: members.map((row) => ({ userId: row.user_id, joinedAt: row.joined_at })),
    claims: claims.map((row) => ({
      islandId: row.island_id,
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at,
    })),
    beacons: beacons.map((row) => row.island_id),
    sharedLanes: sharedLanes.map((row) => ({
      laneId: row.id,
      fromIslandId: row.from_island_id,
      toIslandId: row.to_island_id,
    })),
  };
}

/** Join. One banner per player per world; the unique refuses the second, whoever raced. */
export async function joinAlliance(
  sql: Db,
  producer: string,
  allianceId: string,
  userId: string,
  outbox: typeof withOutbox = withOutbox,
): Promise<void> {
  try {
    await outbox(sql, producer, async (tx) => {
      const rows = await tx<{ archipelago_id: string }[]>`
        select archipelago_id from alliances where id = ${allianceId}
      `;
      if (!rows[0]) throw new NotFoundError('no such alliance');
      await tx`
        insert into alliance_members (alliance_id, archipelago_id, user_id)
        values (${allianceId}, ${rows[0].archipelago_id}, ${userId})
      `;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const message = err instanceof Error ? err.message : String(err);
      // Rejoining one's own alliance replays; a second banner is refused.
      if (message.includes('alliance_members_pkey')) return;
      if (message.includes('alliance_members_one_per_world')) throw new AlreadyAlignedError();
    }
    throw err;
  }
}

export async function leaveAlliance(sql: Db, producer: string, allianceId: string, userId: string,
  outbox: typeof withOutbox = withOutbox,
): Promise<void> {
  await outbox(sql, producer, async (tx) => {
    await tx`
      delete from alliance_members where alliance_id = ${allianceId} and user_id = ${userId}
    `;
  });
}

/**
 * Plant the banner on an island. Members only, and only where the alliance has a footing — a
 * member city on the island. One claim per island; the primary key decides the race.
 */
export async function claimIsland(
  sql: Db,
  producer: string,
  allianceId: string,
  islandId: string,
  userId: string,
  outbox: typeof withOutbox = withOutbox,
): Promise<void> {
  try {
    await outbox(sql, producer, async (tx) => {
      const membership = await tx<{ archipelago_id: string }[]>`
        select archipelago_id from alliance_members
         where alliance_id = ${allianceId} and user_id = ${userId}
      `;
      if (!membership[0]) throw new NotMemberError();
      const footing = await tx<{ id: string }[]>`
        select c.id
          from cities c
          join alliance_members m
            on m.user_id = c.user_id and m.alliance_id = ${allianceId}
         where c.island_id = ${islandId} and c.abandoned_at is null
         limit 1
      `;
      if (!footing[0]) {
        throw new ValidationError('a claim needs a footing: a member city on the island');
      }
      await tx`
        insert into alliance_claims (island_id, alliance_id, claimed_by)
        values (${islandId}, ${allianceId}, ${userId})
      `;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Claimed already — by us (replay, fine) or by another banner (taken).
      const existing = await sql<{ alliance_id: string }[]>`
        select alliance_id from alliance_claims where island_id = ${islandId}
      `;
      if (existing[0]?.alliance_id === allianceId) return;
      throw new ClaimTakenError();
    }
    throw err;
  }
}
