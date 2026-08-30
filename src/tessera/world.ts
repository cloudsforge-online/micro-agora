/**
 * Wards, parcels, claims, banking, contests and transfers.
 *
 * The authoritative world is rows in this database and nothing else (§4). The client is a viewer:
 * it renders what it is told and decides nothing. Nothing runs on a player's machine but a canvas,
 * no per-user simulation process exists, and there is no per-ward tick.
 *
 * Every function here writes through `withOutbox`, so the domain row and the event that announces
 * it succeed or fail together. None of them re-implements an invariant the schema already holds —
 * where a handler check would duplicate a constraint, this file catches the constraint's error and
 * turns it into a status code, which is the only division of labour that cannot drift: the
 * database is the guarantee, and this is the error message.
 */

import type { Db, Emit, Tx } from './outbox.ts'
import { withOutbox } from './outbox.ts'
import { PARCEL_CLAIMED, PARCEL_FALLOWED, PARCEL_TRANSFERRED, WARD_OPENED } from './topics.ts'
import { BANKED_DAYS, fallowStateOf, type FallowState } from './fallow.ts'

/** The eight ward archetypes of §2.4. The database holds the same list in a CHECK. */
export const ARCHETYPES = Object.freeze([
  'ashfield',
  'terrace',
  'wharf',
  'undercroft',
  'glasshouse',
  'kilnyard',
  'grove',
  'saltflat',
] as const)

export type Archetype = (typeof ARCHETYPES)[number]

/** §6.2's four tiers, and the side length each one is. The database holds the same agreement. */
export const TIER_SIZE = Object.freeze({
  homestead: 16,
  plot: 32,
  court: 64,
  quarter: 128,
} as const)

export type Tier = keyof typeof TIER_SIZE

export function isTier(value: string): value is Tier {
  return Object.hasOwn(TIER_SIZE, value)
}

/**
 * A ward's grid, and the share of it that may ever be held. §4, §6.1.
 *
 * `CLAIMABLE_TILES` is three quarters of the grid and the remaining quarter is Ways, verges and
 * the ward Commons. §4 gives the reason and it is not an aesthetic one: "a ward where every
 * frontage is private becomes a corridor of walls, and the one thing a social world cannot recover
 * from is having nowhere to stand."
 */
export const WARD_GRID = 256
export const WARD_TILES = WARD_GRID * WARD_GRID
export const CLAIMABLE_TILES = (WARD_TILES / 4) * 3

/** §4: "When a ward crosses 70% occupancy, the next ward mints automatically." */
export const NEW_WARD_OCCUPANCY = 0.7

/** §6.1: "Ward instance capacity — 60 avatars." */
export const INSTANCE_CAPACITY = 60

export class WorldError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'WorldError'
    this.code = code
    this.status = status
  }
}

export interface Ward {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly archetype: Archetype
  readonly ordinal: number
  readonly claimableTiles: number
  readonly claimedTiles: number
  readonly occupancy: number
  readonly communityId: string | null
  readonly instances: number
  readonly openedAt: string
}

export interface Parcel {
  readonly id: string
  readonly wardId: string
  readonly ownerSubject: string
  readonly tier: Tier
  readonly originX: number
  readonly originY: number
  readonly size: number
  readonly tiles: number
  /** GENERATED in the database. There is no statement that can raise it. §6.2. */
  readonly objectCap: number
  readonly status: 'held' | 'released'
  /**
   * **A Venue is a parcel that has posted a rate**, and the rate itself is deliberately not on
   * this type. What an hour costs is money, and §12's test 4 asserts as an ABSENCE that this
   * module can neither name nor reach money — it may not so much as import `sparks.ts`. So the
   * flag lives here and its terms live in `economy.ts` (`venueOf`), which is the division the
   * guard was always asking for and which a rate column here would have quietly ended.
   */
  readonly isVenue: boolean
  readonly isWorkshop: boolean
  readonly gateOpen: boolean
  readonly commissioned: boolean
  readonly claimedAt: string
  readonly lastActiveAt: string
  readonly bankedUntil: string | null
  /** Computed on read, never stored. See `fallow.ts`. */
  readonly fallowState: FallowState
}

interface WardRow {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly archetype: string
  readonly ordinal: number
  readonly claimable_tiles: number
  readonly claimed_tiles: number
  readonly community_id: string | null
  readonly instances: number
  readonly opened_at: Date
}

interface ParcelRow {
  readonly id: string
  readonly ward_id: string
  readonly owner_subject: string
  readonly tier: string
  readonly origin_x: number
  readonly origin_y: number
  readonly size: number
  readonly tiles: number
  readonly object_cap: number
  readonly status: string
  readonly is_venue: boolean
  readonly is_workshop: boolean
  readonly gate_open: boolean
  readonly commissioned: boolean
  readonly claimed_at: Date
  readonly last_active_at: Date
  readonly banked_until: Date | null
}

export function toWard(row: WardRow): Ward {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    archetype: row.archetype as Archetype,
    ordinal: row.ordinal,
    claimableTiles: row.claimable_tiles,
    claimedTiles: row.claimed_tiles,
    occupancy: row.claimed_tiles / row.claimable_tiles,
    communityId: row.community_id,
    instances: row.instances,
    openedAt: row.opened_at.toISOString(),
  }
}

export function toParcel(row: ParcelRow, now: Date): Parcel {
  return {
    id: row.id,
    wardId: row.ward_id,
    ownerSubject: row.owner_subject,
    tier: row.tier as Tier,
    originX: row.origin_x,
    originY: row.origin_y,
    size: row.size,
    tiles: row.tiles,
    objectCap: row.object_cap,
    status: row.status as Parcel['status'],
    isVenue: row.is_venue,
    isWorkshop: row.is_workshop,
    gateOpen: row.gate_open,
    commissioned: row.commissioned,
    claimedAt: row.claimed_at.toISOString(),
    lastActiveAt: row.last_active_at.toISOString(),
    bankedUntil: row.banked_until?.toISOString() ?? null,
    fallowState: fallowStateOf(
      {
        tier: row.tier,
        status: row.status,
        lastActiveAt: row.last_active_at,
        bankedUntil: row.banked_until,
      },
      now,
    ),
  }
}

const PARCEL_COLUMNS = `id, ward_id, owner_subject, tier, origin_x, origin_y, size, tiles,
  object_cap, status, is_venue, is_workshop, gate_open, commissioned, claimed_at,
  last_active_at, banked_until`

/* ------------------------------------------------------------------------------ accounts */

/**
 * This service's row for a player, created on first sight.
 *
 * It holds the Deed Slot entitlement and nothing else — not a copy of identity's user, which would
 * be a second place a person exists. Two Deed Slots at creation is §7.3's floor; the CHECK
 * `tessera_deed_slots_capped` is its ceiling.
 */
export async function ensureAccount(tx: Tx, subject: string): Promise<void> {
  if (!subject.startsWith('user:')) {
    throw new WorldError('bad_subject', 'a Tessera account belongs to a user', 400)
  }
  await tx`insert into accounts (subject) values (${subject}) on conflict (subject) do nothing`
}

export async function deedSlotsOf(sql: Db, subject: string): Promise<number> {
  const rows = await sql<{ deed_slots: number }[]>`
    select deed_slots from accounts where subject = ${subject}
  `
  return rows[0]?.deed_slots ?? 2
}

/* --------------------------------------------------------------------------------- wards */

export async function listWards(sql: Db): Promise<Ward[]> {
  const rows = await sql<WardRow[]>`
    select id, slug, name, archetype, ordinal, claimable_tiles, claimed_tiles, community_id,
           instances, opened_at
      from wards order by ordinal
  `
  return rows.map(toWard)
}

export async function findWard(sql: Db, idOrSlug: string): Promise<Ward | null> {
  const rows = await sql<WardRow[]>`
    select id, slug, name, archetype, ordinal, claimable_tiles, claimed_tiles, community_id,
           instances, opened_at
      from wards where slug = ${idOrSlug} or id::text = ${idOrSlug} limit 1
  `
  const row = rows[0]
  return row ? toWard(row) : null
}

/**
 * Bind a ward to the `micro-community` community that governs it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE WHOLE OF TESSERA'S GOVERNANCE CODE, AND IT MUST STAY THAT WAY.**
 *
 * §10: "a design that expected community to *enact* a world change would have needed a new
 * execution kind and a new handler in somebody else's repo. Putting the effect in Tessera keeps
 * the change count in `micro-community` at zero and puts the game logic in the game."
 *
 * So Tessera stores one id. It has no proposals table, no votes table, no tally, no quorum, no
 * timelock and no treasury, because `micro-community` has all seven and a second implementation of
 * any of them would be a second answer to "who decided this". The decisions arrive as
 * `community.proposal.executed` and `inbound.ts` applies them.
 *
 * **A conditional UPDATE rather than a read-then-write.** `where community_id is null` makes the
 * binding a compare-and-set: two founders racing produce one binding and one 409, decided by the
 * row lock rather than by whichever request read first. `tessera_one_ward_per_community` (migration
 * 11) then makes the other direction singular too — one community governs at most one ward, which
 * is what makes `inbound.ts`'s unqualified `update wards ... where community_id = $1` affect
 * exactly one row rather than every ward that happened to share a community.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function bindWardCommunity(
  sql: Db,
  wardId: string,
  communityId: string,
): Promise<Ward> {
  let rows: WardRow[]
  try {
    rows = await sql<WardRow[]>`
      update wards set community_id = ${communityId}
       where id = ${wardId} and community_id is null
      returning id, slug, name, archetype, ordinal, claimable_tiles, claimed_tiles, community_id,
                instances, opened_at
    `
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('tessera_one_ward_per_community')) {
      throw new WorldError(
        'community_governs_another_ward',
        'that community already governs a ward — one community, one ward, or a single proposal ' +
          'would decide for both',
        409,
      )
    }
    if (message.includes('wards_community_id_is_a_uuid')) {
      throw new WorldError('bad_community_id', 'a community id is a uuid', 400)
    }
    throw err
  }
  const row = rows[0]
  if (!row) {
    // Either the ward does not exist or it is already governed. Distinguished, because "you
    // cannot found a second government for this ward" and "no such ward" are different answers
    // and a founder needs to know which they are reading.
    const existing = await sql<{ community_id: string | null }[]>`
      select community_id from wards where id = ${wardId}
    `
    if (!existing[0]) throw new WorldError('not_found', 'no such ward', 404)
    throw new WorldError(
      'already_governed',
      `that ward is already governed by community ${existing[0].community_id}`,
      409,
    )
  }
  return toWard(row)
}

export interface OpenWardInput {
  readonly slug: string
  readonly name: string
  readonly archetype: Archetype
  readonly correlationId: string
  readonly actor?: `service:${string}` | `operator:${string}` | 'system'
}

/**
 * Mint a ward.
 *
 * `ordinal` is derived inside the transaction rather than supplied, so two replicas minting
 * concurrently cannot both take the same number — the unique constraint on `ordinal` decides, and
 * the loser retries under its lease. §4's elastic supply is this function plus the `ward:<id>`
 * leased job that calls it when occupancy crosses 70%.
 */
export async function openWard(sql: Db, input: OpenWardInput): Promise<Ward> {
  return withOutbox(sql, async (tx, emit) => {
    const rows = await tx<WardRow[]>`
      insert into wards (slug, name, archetype, ordinal, claimable_tiles)
      select ${input.slug}, ${input.name}, ${input.archetype},
             coalesce(max(ordinal) + 1, 0), ${CLAIMABLE_TILES}
        from wards
      returning id, slug, name, archetype, ordinal, claimable_tiles, claimed_tiles, community_id,
                instances, opened_at
    `
    const row = rows[0]
    if (!row) throw new WorldError('ward_not_opened', 'the ward could not be minted')
    const ward = toWard(row)
    emit({
      topic: WARD_OPENED,
      // `keyedBy: 'ward_id'`, and this is the ward's id. topics.test.ts asserts the agreement.
      key: ward.id,
      payload: {
        wardId: ward.id,
        slug: ward.slug,
        name: ward.name,
        archetype: ward.archetype,
        ordinal: ward.ordinal,
        claimableTiles: ward.claimableTiles,
      },
      actor: input.actor ?? 'system',
      correlationId: input.correlationId,
    })
    return ward
  })
}

/**
 * Which wards are full enough to need a neighbour. §4's 70%.
 *
 * A query, run by the `ward:<id>` leased job, rather than a flag maintained by every claim. The
 * job is what turns the answer into a new ward; this only asks.
 */
export async function wardsNeedingANeighbour(sql: Db): Promise<Ward[]> {
  const rows = await sql<WardRow[]>`
    select id, slug, name, archetype, ordinal, claimable_tiles, claimed_tiles, community_id,
           instances, opened_at
      from wards
     where claimed_tiles::numeric / claimable_tiles::numeric >= ${NEW_WARD_OCCUPANCY}
     order by ordinal
  `
  return rows.map(toWard)
}

/* ------------------------------------------------------------------------------- parcels */

export interface ClaimInput {
  readonly wardId: string
  readonly ownerSubject: string
  readonly tier: Tier
  readonly originX: number
  readonly originY: number
  readonly correlationId: string
  readonly commissioned?: boolean
}

/**
 * Claim ground. **Free, always, and the platform never sells it.**
 *
 * §4: "Land is claimed, not bought, and the platform never sells it ... it never mints supply for
 * money, because a platform that sells land has a permanent incentive to keep land scarce, and
 * that incentive is precisely what strangled the reference."
 *
 * There is no price argument on this function and no payment call in it. That is the design's
 * fourth refusal expressed as an absence in a signature, and `world.test.ts` asserts the absence
 * with force rather than trusting this paragraph.
 *
 * Four things can refuse a claim and three of them are the database:
 *   * the ground is taken            — `tessera_parcels_do_not_overlap` (23P01)
 *   * you already have a Homestead   — `tessera_one_homestead` (23505)
 *   * you are out of Deed Slots      — `parcels_within_deed_slots`, at COMMIT
 *   * the rectangle leaves the ward  — `tessera_parcel_within_ward`
 */
export async function claimParcel(sql: Db, input: ClaimInput): Promise<Parcel> {
  const size = TIER_SIZE[input.tier]
  try {
    return await withOutbox(sql, async (tx, emit) => {
      await ensureAccount(tx, input.ownerSubject)
      const rows = await tx<ParcelRow[]>`
        insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, commissioned)
        values (${input.wardId}, ${input.ownerSubject}, ${input.tier}, ${input.originX},
                ${input.originY}, ${size}, ${input.commissioned ?? false})
        returning ${tx.unsafe(PARCEL_COLUMNS)}
      `
      const row = rows[0]
      if (!row) throw new WorldError('not_claimed', 'the claim did not land')

      // The ward's occupancy is maintained here, inside the same transaction, rather than counted
      // on read: a count over every parcel in a ward is a scan, and this is the number the
      // new-ward job compares against 70%. `wards_claimed_within_claimable` refuses the update
      // that would take a ward past its claimable share, so the last claim in a full ward is
      // refused by the database rather than by whoever remembers to check.
      await tx`
        update wards set claimed_tiles = claimed_tiles + ${size * size} where id = ${input.wardId}
      `

      const parcel = toParcel(row, new Date())
      emit({
        topic: PARCEL_CLAIMED,
        key: parcel.id,
        payload: {
          parcelId: parcel.id,
          wardId: parcel.wardId,
          ownerSubject: parcel.ownerSubject,
          tier: parcel.tier,
          originX: parcel.originX,
          originY: parcel.originY,
          tiles: parcel.tiles,
          objectCap: parcel.objectCap,
          commissioned: parcel.commissioned,
        },
        actor: `user:${input.ownerSubject.slice('user:'.length)}`,
        correlationId: input.correlationId,
      })
      return parcel
    })
  } catch (err) {
    throw translateClaimError(err)
  }
}

/**
 * Turn a Postgres constraint violation into something a person can act on.
 *
 * The constraint is the guarantee; this is the sentence. Matching on the constraint NAME rather
 * than on the message text, because the message is prose and prose gets reworded — and a handler
 * that matched on prose would silently start returning 500 the day somebody improved a comment.
 */
export function translateClaimError(err: unknown): unknown {
  const constraint =
    typeof err === 'object' && err !== null && 'constraint_name' in err
      ? String((err as { constraint_name?: unknown }).constraint_name ?? '')
      : ''
  const message = err instanceof Error ? err.message : String(err)

  if (constraint === 'tessera_parcels_do_not_overlap') {
    return new WorldError('ground_taken', 'somebody already holds ground here', 409)
  }
  if (constraint === 'tessera_one_homestead') {
    return new WorldError(
      'homestead_already_held',
      'every account may hold exactly one Homestead, free, for ever (23-tessera.md §4)',
      409,
    )
  }
  if (constraint === 'wards_claimed_within_claimable') {
    return new WorldError('ward_full', 'this ward has no claimable ground left', 409)
  }
  if (constraint === 'tessera_parcel_within_ward') {
    return new WorldError('outside_the_ward', 'that rectangle leaves the ward', 400)
  }
  // The deferred triggers raise at COMMIT with no constraint name attached, so they are matched by
  // the sentence they raise — which is why those sentences are written once, in the migration, and
  // name their own rule.
  if (message.includes('Deed Slots')) {
    return new WorldError(
      'out_of_deed_slots',
      'you hold as many parcels as your Deed Slots allow — Deed Slots are capped at 12, at any price (23-tessera.md §7.3)',
      409,
    )
  }
  return err
}

export async function findParcel(sql: Db, id: string): Promise<Parcel | null> {
  const rows = await sql<ParcelRow[]>`
    select ${sql.unsafe(PARCEL_COLUMNS)} from parcels where id = ${id}
  `
  const row = rows[0]
  return row ? toParcel(row, new Date()) : null
}

export async function listParcelsOf(sql: Db, ownerSubject: string): Promise<Parcel[]> {
  const rows = await sql<ParcelRow[]>`
    select ${sql.unsafe(PARCEL_COLUMNS)} from parcels
     where owner_subject = ${ownerSubject} and status = 'held'
     order by claimed_at
  `
  const now = new Date()
  return rows.map((row) => toParcel(row, now))
}

export async function listParcelsIn(sql: Db, wardId: string, limit = 200): Promise<Parcel[]> {
  const rows = await sql<ParcelRow[]>`
    select ${sql.unsafe(PARCEL_COLUMNS)} from parcels
     where ward_id = ${wardId} and status = 'held'
     order by claimed_at limit ${limit}
  `
  const now = new Date()
  return rows.map((row) => toParcel(row, now))
}

/**
 * The fallow set, read lazily.
 *
 * The comparison is made by Postgres against Postgres's own clock, using the same STABLE function
 * the contest trigger uses, so what this lists and what a contest is permitted against cannot
 * disagree. Doing the comparison in TypeScript would introduce a second clock and a second
 * expression, either of which could drift.
 */
export async function listFallow(sql: Db, limit = 100): Promise<Parcel[]> {
  const rows = await sql<ParcelRow[]>`
    select ${sql.unsafe(PARCEL_COLUMNS)} from parcels
     where status = 'held'
       and tier <> 'homestead'
       and now() >= tessera_fallow_at(last_active_at, banked_until)
     order by last_active_at
     limit ${limit}
  `
  const now = new Date()
  return rows.map((row) => toParcel(row, now))
}

export interface BankInput {
  readonly parcelId: string
  readonly ownerSubject: string
  readonly correlationId: string
}

/**
 * Bank a parcel: extend the fallow clock to 270 days from its last activity, free, once a year.
 *
 * `banked_until` is computed here and checked by `parcels_banking_guard` against the database's
 * own arithmetic, which is not belt-and-braces: the trigger is what makes the rule true for a
 * `psql` prompt, and this is what makes the error message a sentence.
 */
export async function bankParcel(sql: Db, input: BankInput): Promise<Parcel> {
  return withOutbox(sql, async (tx) => {
    const owned = await tx<ParcelRow[]>`
      select ${tx.unsafe(PARCEL_COLUMNS)} from parcels
       where id = ${input.parcelId} and owner_subject = ${input.ownerSubject} and status = 'held'
       for update
    `
    const current = owned[0]
    if (!current) throw new WorldError('not_found', 'no such parcel, or it is not yours', 404)
    if (current.tier === 'homestead') {
      throw new WorldError(
        'homestead_needs_no_banking',
        'a Homestead is never fallow, so banking it would buy nothing (23-tessera.md §4)',
        409,
      )
    }
    try {
      // ═══════════════════════════════════════════════════════════════════════════════════════
      // THE DEADLINE IS COMPUTED BY POSTGRES, NOT HERE — AND THE FIRST DRAFT GOT THIS WRONG.
      //
      // It read `bankedUntilFor(current.last_active_at)` and sent the resulting JS `Date`. The
      // trigger `parcels_banking_guard` checks the value against `last activity + interval '270
      // days'` computed in SQL, and the two do not agree: a JS `Date` is millisecond-precision
      // while `timestamptz` is microsecond, so the round trip drops sub-millisecond digits and
      // the equality fails. Every bank was refused with "banking sets banked_until to last
      // activity + 270 days, nothing else" — a trigger correctly refusing a value its own caller
      // computed, which is exactly what "one arithmetic, in one place" exists to prevent. The
      // test caught it; it is recorded here rather than quietly fixed because the shape recurs
      // wherever a deadline is computed on both sides.
      //
      // `bankedUntilFor` is still exported and still tested — it is what a CLIENT uses to show
      // "banked until March" before the button is pressed. It is not what writes the row.
      // ═══════════════════════════════════════════════════════════════════════════════════════
      const rows = await tx<ParcelRow[]>`
        update parcels
           set banked_until = greatest(
                 claimed_at,
                 coalesce(last_footfall_at, claimed_at),
                 coalesce(last_edit_at, claimed_at)
               ) + interval '${tx.unsafe(String(BANKED_DAYS))} days',
               banked_at = now()
         where id = ${input.parcelId}
        returning ${tx.unsafe(PARCEL_COLUMNS)}
      `
      const row = rows[0]
      if (!row) throw new WorldError('not_found', 'no such parcel', 404)
      return toParcel(row, new Date())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('banking is once per year')) {
        throw new WorldError('already_banked', 'this parcel was banked within the year', 409)
      }
      throw err
    }
  })
}

export interface ContestInput {
  readonly parcelId: string
  readonly challengerSubject: string
  readonly correlationId: string
}

/**
 * Open a contest on a fallow parcel.
 *
 * The thirty days are checked by `contests_respect_the_window` on the DATABASE clock. This
 * function does not check them, deliberately: a second check in TypeScript would be a second
 * answer to the same question, and the one that matters is the one that runs inside the
 * transaction. §4's window is the trigger; this is the route to it.
 */
export async function openContest(sql: Db, input: ContestInput): Promise<{ contestId: string }> {
  return withOutbox(sql, async (tx, emit) => {
    await ensureAccount(tx, input.challengerSubject)
    try {
      // ═══════════════════════════════════════════════════════════════════════════════════════
      // THE OWNER IS READ FIRST, `for update`, AND THAT IS WHAT MAKES THIS EVENT NOTIFIABLE.
      //
      // `notify/src/topics.ts` records this topic as `blockedBy: 'no-subject'`, and it was
      // right: the payload named the CHALLENGER and nothing else, so a rule built on it would
      // answer `no_recipient` for ever, or — worse — tell the challenger that somebody's ground
      // had gone fallow. The person who needs this notification is the OWNER, who is about to
      // lose ground and has thirty days to do something about it, and the owner appeared nowhere.
      //
      // Read from the authoritative row rather than derived from the actor, and read `for update`
      // so a transfer committing alongside this cannot make the event name a former owner. That
      // is the same lock `moveParcel` takes, in the same order, so the two serialise rather than
      // deadlock. `market.offer.made` is the estate's precedent for both halves: it named the
      // offerer when the notification was for the seller, and was only fixable once the seller
      // was read from the row held `for update`.
      // ═══════════════════════════════════════════════════════════════════════════════════════
      const owners = await tx<{ owner_subject: string; ward_id: string }[]>`
        select owner_subject, ward_id from parcels where id = ${input.parcelId} for update
      `
      const parcel = owners[0]
      if (!parcel) throw new WorldError('not_found', 'no such parcel', 404)

      const rows = await tx<{ id: string; parcel_id: string }[]>`
        insert into contests (parcel_id, challenger_subject)
        values (${input.parcelId}, ${input.challengerSubject})
        returning id, parcel_id
      `
      const row = rows[0]
      if (!row) throw new WorldError('not_contested', 'the contest did not open')
      emit({
        topic: PARCEL_FALLOWED,
        // `keyedBy: 'parcel_id'` — the parcel, not the contest. Fallow and contest must order
        // against the same parcel, or a contest can overtake the fallow that permitted it.
        key: row.parcel_id,
        payload: {
          parcelId: row.parcel_id,
          wardId: parcel.ward_id,
          contestId: row.id,
          // The party this event is ABOUT: whoever is losing ground. First field of the pair on
          // purpose — a consumer reading positionally still reaches the right one.
          ownerSubject: parcel.owner_subject,
          challengerSubject: input.challengerSubject,
        },
        actor: `user:${input.challengerSubject.slice('user:'.length)}`,
        correlationId: input.correlationId,
      })
      return { contestId: row.id }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('is contestable from')) {
        throw new WorldError('not_yet_contestable', message, 409)
      }
      if (message.includes('is a Homestead')) {
        throw new WorldError('homestead_is_never_contestable', message, 409)
      }
      if (message.includes('tessera_one_open_contest')) {
        throw new WorldError('already_contested', 'this parcel already has an open contest', 409)
      }
      throw err
    }
  })
}

export interface TransferInput {
  readonly parcelId: string
  readonly toSubject: string
  readonly reason: 'trade' | 'contest'
  readonly correlationId: string
  readonly actor: `user:${string}` | `service:${string}` | 'system'
}

/**
 * Move a parcel to a new owner.
 *
 * A Homestead cannot reach this function's effect: `parcels_homestead_guard` raises on the UPDATE,
 * whatever the caller believes. §6.2's "Tradeable? no" is that trigger, and this is the path a
 * legal transfer takes.
 */
export async function transferParcel(sql: Db, input: TransferInput): Promise<Parcel> {
  try {
    return await withOutbox(sql, async (tx, emit) => moveParcel(tx, emit, input))
  } catch (err) {
    throw translateTransferError(err)
  }
}

/**
 * The refusals a transfer can meet, as answers rather than as faults.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS APPLIED OUTSIDE `withOutbox`, AND THAT IS THE WHOLE CORRECTION.
 *
 * It used to live INSIDE the transaction callback — a `try` around the UPDATE — and its Deed Slot
 * branch had therefore **never executed once**. `tessera_deed_slots_bound_holdings` is a DEFERRED
 * constraint trigger: it raises at COMMIT, which happens when `sql.begin` resolves, which is after
 * the callback has already returned. So the branch was unreachable code that read as a refusal
 * being handled, and what actually left this function was a raw `PostgresError` — a 500 on the
 * trade path and, on the contest path, an unexplained dead-lettered job.
 *
 * Found by writing the test rather than by reading the branch, which is the point: the branch
 * looked right. `claimParcel` has always had this correct (`translateClaimError`, caught
 * outside its own `withOutbox`), and its comment says why — "the deferred triggers raise at COMMIT
 * with no constraint name attached". That comment was two functions away from the code that
 * needed it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function translateTransferError(err: unknown): unknown {
  if (err instanceof WorldError) return err
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('is not tradeable')) {
    return new WorldError('homestead_is_not_tradeable', message, 409)
  }
  if (message.includes('Deed Slots')) {
    return new WorldError('recipient_out_of_deed_slots', message, 409)
  }
  return err
}

/**
 * One transfer, one implementation.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `resolveContest` USED TO CARRY ITS OWN COPY OF THIS, AND THE COPY WAS MISSING TWO REFUSALS.
 *
 * The two functions were the same UPDATE, the same lock and the same event — except that this one
 * translates `parcels_homestead_guard` and the Deed Slot cap into named 409s and the copy did not.
 * So a contest resolution that would have pushed the challenger past twelve Deed Slots threw a raw
 * `PostgresError` out of a LEASED JOB, where the only symptom is `jobs_failed_total` climbing and
 * a parcel that quietly never changes hands: the same "a refusal answered as a fault" shape as the
 * 500 on provision, in a third place and with no customer to notice it.
 *
 * Consolidating also settles what `transferParcel` was: not a missing call site — the effect it
 * describes happens in production every time a contest resolves — but a SECOND implementation of
 * one thing, which is why nothing called it. It has a caller now, and the `reason: 'trade'` arm
 * remains reachable the day a parcel trade route exists.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function moveParcel(tx: Tx, emit: Emit, input: TransferInput): Promise<Parcel> {
  await ensureAccount(tx, input.toSubject)
  const before = await tx<{ owner_subject: string }[]>`
    select owner_subject from parcels where id = ${input.parcelId} for update
  `
  const from = before[0]?.owner_subject
  if (!from) throw new WorldError('not_found', 'no such parcel', 404)
  try {
    const rows = await tx<ParcelRow[]>`
      update parcels
         set owner_subject = ${input.toSubject}, last_edit_at = now()
       where id = ${input.parcelId} and status = 'held'
      returning ${tx.unsafe(PARCEL_COLUMNS)}
    `
    const row = rows[0]
    if (!row) throw new WorldError('not_found', 'no such parcel, or it is not held', 404)
    const parcel = toParcel(row, new Date())
    emit({
      topic: PARCEL_TRANSFERRED,
      key: parcel.id,
      payload: {
        parcelId: parcel.id,
        wardId: parcel.wardId,
        fromSubject: from,
        toSubject: input.toSubject,
        reason: input.reason,
        tier: parcel.tier,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
    return parcel
  } catch (err) {
    // The IMMEDIATE refusals only. The deferred one cannot be seen from in here at all — see
    // `translateTransferError`, which both callers apply outside their transaction.
    throw translateTransferError(err)
  }
}

/**
 * Resolve a contest in the challenger's favour: the ground changes hands.
 *
 * The whole resolution is one transaction, so the contest row and the transfer cannot disagree
 * about who holds the parcel. Called under the `parcel:<id>` lease.
 */
export async function resolveContest(
  sql: Db,
  contestId: string,
  correlationId: string,
): Promise<Parcel> {
  try {
    return await withOutbox(sql, async (tx, emit) => {
      const rows = await tx<{ parcel_id: string; challenger_subject: string }[]>`
        update contests set status = 'won', resolved_at = now()
         where id = ${contestId} and status = 'open'
        returning parcel_id, challenger_subject
      `
      const contest = rows[0]
      if (!contest) throw new WorldError('not_found', 'no such open contest', 404)
      // The one implementation, so this path gets the refusals its own copy was missing. See
      // `moveParcel` and `translateTransferError`.
      return moveParcel(tx, emit, {
        parcelId: contest.parcel_id,
        toSubject: contest.challenger_subject,
        reason: 'contest',
        correlationId,
        actor: 'system',
      })
    })
  } catch (err) {
    // Outside the transaction, because the Deed Slot cap is deferred to COMMIT. A resolution that
    // leaks a raw PostgresError here dead-letters the `parcel.settle` job with no sentence saying
    // why, and the parcel silently never changes hands.
    throw translateTransferError(err)
  }
}

/**
 * Flag a parcel a Workshop, open its gate, or STOP it being a Venue. §6.4's six kinds of space.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `isVenue: true` IS REFUSED HERE, AND THE REFUSAL IS THE FEATURE.
 *
 * A Venue is a parcel that has posted what an hour of it costs — `tessera_a_venue_posts_a_rate`
 * (migration 14) makes the flag without the terms unrepresentable — so opening one is not a flag
 * flip and cannot be done from a module that §12's test 4 forbids to reach money at all. It is
 * `PUT /v1/parcels/:id/venue`, over `economy.ts`. This function answers `no_venue_rate` rather
 * than letting the constraint escape as a 500.
 *
 * Clearing the flag still works here, and the terms go with it: a database trigger nulls them on
 * the same statement, so a rate for something nobody can book cannot be left behind by ANY writer
 * rather than only by this one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function setParcelFlags(
  sql: Db,
  parcelId: string,
  ownerSubject: string,
  flags: { isVenue?: boolean; isWorkshop?: boolean; gateOpen?: boolean },
): Promise<Parcel> {
  try {
    const rows = await sql<ParcelRow[]>`
      update parcels
         set is_venue = coalesce(${flags.isVenue ?? null}, is_venue),
             is_workshop = coalesce(${flags.isWorkshop ?? null}, is_workshop),
             gate_open = coalesce(${flags.gateOpen ?? null}, gate_open),
             last_edit_at = now()
       where id = ${parcelId} and owner_subject = ${ownerSubject} and status = 'held'
      returning ${sql.unsafe(PARCEL_COLUMNS)}
    `
    const row = rows[0]
    if (!row) throw new WorldError('not_found', 'no such parcel, or it is not yours', 404)
    return toParcel(row, new Date())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('tessera_a_venue_posts_a_rate')) {
      throw new WorldError(
        'no_venue_rate',
        'a Venue posts what an hour of it costs — open one at PUT /v1/parcels/:id/venue',
        400,
      )
    }
    throw err
  }
}

export type { Emit }
