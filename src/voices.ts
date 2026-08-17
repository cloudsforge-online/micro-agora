/**
 * Voices, and the graph between them.
 *
 * A voice is an ecosystem account's presence on the square. It is created lazily, on the account's
 * first write, from the subject in its bearer token — there is no registration step here and there
 * must not be one. Somebody who has already made an account, verified an email and set a password
 * has done enough; asking them to do it again to say something is how a product acquires a sign-up
 * funnel it did not need and a second identity it then has to keep in step.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A BAR IS SYMMETRIC AND TOTAL, AND THAT IS ENFORCED HERE RATHER THAN AT THE ROUTES.**
 *
 * Doc 41 §4 makes it one of the four load-bearing rules. What it means in practice:
 *
 *   * neither voice's posts appear on the other's timelines, in either direction;
 *   * neither can reply to, quote, echo or spark the other;
 *   * neither can open or continue a whisper thread with the other;
 *   * **both follows are deleted**, in the same transaction as the bar.
 *
 * The last one is the one that is easy to get wrong, and getting it wrong is worse than not
 * shipping the feature. A bar that leaves the follow in place is a bar whose subject still appears
 * in the barring account's follower count, still receives their posts through some path nobody
 * enumerated, and can restore visibility by unbarring at a moment of their choosing. The person
 * who set it believes they are unreachable. They are not, and nothing tells them.
 *
 * `barsBetween` is the read side, and every timeline query in `posts.ts` and `whispers.ts` goes
 * through it. It reads the table in BOTH directions — `bars_reverse_idx` exists for exactly that
 * — because a one-directional read is half a bar with the same false confidence.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from 'node:crypto'
import { withOutbox, type Db, type Emit, type Tx } from './outbox.ts'
import { RESERVED_HANDLES, isHandle, normaliseHandle } from './text.ts'
import { claim } from './ratelimit.ts'

export class VoiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VoiceError'
  }
}

/** The state refuses this, but the request was well formed. Maps to 409. */
export class VoiceStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VoiceStateError'
  }
}

/** A handle somebody else already holds, or one nobody may hold. Maps to 409. */
export class HandleTakenError extends Error {
  constructor(handle: string) {
    super(`the handle @${handle} is not available`)
    this.name = 'HandleTakenError'
  }
}

export type WhispersFrom = 'everyone' | 'follows' | 'nobody'

export interface Voice {
  readonly id: string
  readonly subject: string
  readonly handle: string
  readonly displayName: string
  readonly bio: string
  readonly avatarAssetId: string | null
  readonly bannerAssetId: string | null
  readonly location: string
  readonly website: string
  readonly whispersFrom: WhispersFrom
  readonly protected: boolean
  readonly discoverable: boolean
  readonly suspendedAt: Date | null
  readonly suspendedReason: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface VoiceRow {
  readonly id: string
  readonly subject: string
  readonly handle: string
  readonly display_name: string
  readonly bio: string
  readonly avatar_asset_id: string | null
  readonly banner_asset_id: string | null
  readonly location: string
  readonly website: string
  readonly whispers_from: string
  readonly protected: boolean
  readonly discoverable: boolean
  readonly suspended_at: Date | null
  readonly suspended_reason: string | null
  readonly created_at: Date
  readonly updated_at: Date
}

function toVoice(row: VoiceRow): Voice {
  return {
    id: row.id,
    subject: row.subject,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    avatarAssetId: row.avatar_asset_id,
    bannerAssetId: row.banner_asset_id,
    location: row.location,
    website: row.website,
    whispersFrom: row.whispers_from as WhispersFrom,
    protected: row.protected,
    discoverable: row.discoverable,
    suspendedAt: row.suspended_at,
    suspendedReason: row.suspended_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const COLUMNS =
  'id, subject, handle, display_name, bio, avatar_asset_id, banner_asset_id, location, website, ' +
  'whispers_from, protected, discoverable, suspended_at, suspended_reason, created_at, updated_at'

export interface VoiceDeps {
  readonly sql: Db
  readonly producer: string
  readonly followsPerHour: number
}

/* ------------------------------------------------------------------ reading */

export async function findVoiceBySubject(sql: Db | Tx, subject: string): Promise<Voice | null> {
  const rows = await sql<VoiceRow[]>`
    select ${sql.unsafe(COLUMNS)} from voices where subject = ${subject}
  `
  return rows[0] ? toVoice(rows[0]) : null
}

export async function findVoiceByHandle(sql: Db | Tx, handle: string): Promise<Voice | null> {
  const rows = await sql<VoiceRow[]>`
    select ${sql.unsafe(COLUMNS)} from voices where handle = ${normaliseHandle(handle)}
  `
  return rows[0] ? toVoice(rows[0]) : null
}

export async function findVoice(sql: Db | Tx, id: string): Promise<Voice | null> {
  const rows = await sql<VoiceRow[]>`
    select ${sql.unsafe(COLUMNS)} from voices where id = ${id}
  `
  return rows[0] ? toVoice(rows[0]) : null
}

/* ------------------------------------------------------------------ creating */

/**
 * A handle nobody has, derived from the subject.
 *
 * The estate's subject is `user:<uuid>`, so the first attempt is `u` + the uuid's first eight hex
 * characters — short enough to type, long enough that a collision is a coincidence rather than a
 * pattern. If it is taken, the suffix grows. It is deliberately NOT derived from an email address
 * or a display name: both are personal information the person did not choose to publish, and a
 * default handle that leaks either is a privacy failure committed on somebody's behalf at the
 * moment they first post.
 */
function seedHandle(subject: string, attempt: number): string {
  const hex = subject.replace(/[^0-9a-f]/gi, '').toLowerCase()
  const base = `u${(hex || '0').slice(0, 8).padEnd(8, '0')}`
  return attempt === 0 ? base : `${base}${attempt}`
}

/**
 * The voice for a subject, created if it does not exist.
 *
 * Every write route calls this first. The retry loop is on the unique constraint rather than on a
 * `select … if not exists` because two requests from the same account arriving together — a
 * double-clicked "post" — would both see no row and both insert. The constraint decides; this
 * catches the loser and reads what the winner wrote.
 */
export async function ensureVoice(tx: Tx, subject: string): Promise<Voice> {
  const existing = await findVoiceBySubject(tx, subject)
  if (existing) return existing

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const handle = seedHandle(subject, attempt)
    const rows = await tx<VoiceRow[]>`
      insert into voices (subject, handle)
      values (${subject}, ${handle})
      on conflict do nothing
      returning ${tx.unsafe(COLUMNS)}
    `
    if (rows[0]) return toVoice(rows[0])
    // Either the subject raced (somebody else's insert won) or the handle collided. Both are
    // answered by looking: if the subject is now present the race is over, otherwise try the next
    // handle.
    const now = await findVoiceBySubject(tx, subject)
    if (now) return now
  }
  throw new VoiceError('could not allocate a handle for this account; please choose one')
}

/* ------------------------------------------------------------------ updating */

export interface UpdateVoiceInput {
  readonly handle?: string
  readonly displayName?: string
  readonly bio?: string
  readonly avatarAssetId?: string | null
  readonly bannerAssetId?: string | null
  readonly location?: string
  readonly website?: string
  readonly whispersFrom?: WhispersFrom
  readonly protected?: boolean
  readonly discoverable?: boolean
}

const MAX_DISPLAY_NAME = 60
const MAX_BIO = 600
const MAX_LOCATION = 60
const MAX_WEBSITE = 300

export async function updateVoice(
  deps: VoiceDeps,
  subject: string,
  input: UpdateVoiceInput,
  correlationId?: string,
): Promise<Voice> {
  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const voice = await ensureVoice(tx, subject)

    let handle = voice.handle
    if (input.handle !== undefined) {
      handle = normaliseHandle(input.handle)
      if (!isHandle(handle)) {
        throw new VoiceError(
          'a handle is 2 to 24 characters of lowercase letters, digits and underscores',
        )
      }
      if (RESERVED_HANDLES.has(handle)) throw new HandleTakenError(handle)
    }

    const displayName = clamp(input.displayName ?? voice.displayName, MAX_DISPLAY_NAME, 'displayName')
    const bio = clamp(input.bio ?? voice.bio, MAX_BIO, 'bio')
    const location = clamp(input.location ?? voice.location, MAX_LOCATION, 'location')
    const website = clamp(input.website ?? voice.website, MAX_WEBSITE, 'website')
    if (website && !/^https?:\/\//i.test(website)) {
      // Refused rather than silently prefixed. A guessed scheme is a link that goes somewhere the
      // author did not name, and `javascript:` is why this check exists at all.
      throw new VoiceError('a website must start with http:// or https://')
    }

    const rows = await tx<VoiceRow[]>`
      update voices set
        handle          = ${handle},
        display_name    = ${displayName},
        bio             = ${bio},
        avatar_asset_id = ${input.avatarAssetId !== undefined ? input.avatarAssetId : voice.avatarAssetId},
        banner_asset_id = ${input.bannerAssetId !== undefined ? input.bannerAssetId : voice.bannerAssetId},
        location        = ${location},
        website         = ${website},
        whispers_from   = ${input.whispersFrom ?? voice.whispersFrom},
        protected       = ${input.protected ?? voice.protected},
        discoverable    = ${input.discoverable ?? voice.discoverable},
        updated_at      = now()
      where id = ${voice.id}
      returning ${tx.unsafe(COLUMNS)}
    `.catch((err: unknown) => {
      // 23505 on `voices_handle_uniq`. Caught by code rather than by a pre-flight SELECT, because
      // a pre-flight SELECT is a check-then-write with a window in it, and the window is exactly
      // long enough for two people to claim one handle.
      if (isUniqueViolation(err)) throw new HandleTakenError(handle)
      throw err
    })

    const updated = toVoice(rows[0]!)
    if (updated.handle !== voice.handle) {
      // Emitted because a handle is how the rest of the estate addresses this voice — a link in a
      // notification, an @ in an activity record. A rename that nobody is told about is a set of
      // dead links nobody can explain.
      emit({
        topic: 'agora.voice.renamed',
        key: updated.id,
        payload: { voiceId: updated.id, subject, from: voice.handle, to: updated.handle },
        actor: subject,
        ...(correlationId ? { correlationId } : {}),
      })
    }
    return updated
  })
}

function clamp(value: string, max: number, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length > max) throw new VoiceError(`${field} must be at most ${max} characters`)
  return trimmed
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

/* ------------------------------------------------------------------ the graph */

export type FollowState = 'active' | 'pending'

export interface FollowResult {
  readonly state: FollowState
  /** False when the follow already existed. Lets a route tell "followed" from "already". */
  readonly created: boolean
}

/**
 * Follow a voice.
 *
 * A follow of a protected voice is `pending` and produces a `follow_request` notification; a
 * follow of anybody else is `active` immediately. A follow across a bar — in EITHER direction —
 * is refused, which is the read half of the symmetric rule this file's header describes.
 */
export async function follow(
  deps: VoiceDeps,
  subject: string,
  targetId: string,
  correlationId?: string,
): Promise<FollowResult> {
  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const me = await ensureVoice(tx, subject)
    if (me.id === targetId) throw new VoiceError('a voice cannot follow itself')

    const target = await findVoice(tx, targetId)
    if (!target) throw new VoiceStateError('no such voice')
    if (await barredEitherWay(tx, me.id, target.id)) {
      // The same message a stranger gets for a voice that does not exist. Telling somebody they
      // have been barred is telling them to make another account, and the person who set the bar
      // did not ask for that conversation.
      throw new VoiceStateError('no such voice')
    }

    await claim(tx, me.id, 'follow', deps.followsPerHour)

    const state: FollowState = target.protected ? 'pending' : 'active'
    const rows = await tx<{ state: string }[]>`
      insert into follows (follower_id, followee_id, state)
      values (${me.id}, ${target.id}, ${state})
      on conflict (follower_id, followee_id) do nothing
      returning state
    `
    if (!rows[0]) {
      const current = await tx<{ state: string }[]>`
        select state from follows where follower_id = ${me.id} and followee_id = ${target.id}
      `
      return { state: (current[0]?.state ?? 'active') as FollowState, created: false }
    }

    await notify(tx, {
      voiceId: target.id,
      kind: state === 'pending' ? 'follow_request' : 'follow',
      actorId: me.id,
    })
    emit({
      topic: 'agora.follow.created',
      key: `${me.id}:${target.id}`,
      // `subject` is the FOLLOWER's, which is whose act this is. The followee is named by voice id
      // only: telling every subscriber the estate-wide identity of somebody who has just been
      // followed is a second party's identifier travelling for no reason. See `agora.spark.created`
      // for why the payload names the actor rather than leaving it to the envelope.
      payload: { followerId: me.id, followeeId: target.id, state, subject },
      actor: subject,
      ...(correlationId ? { correlationId } : {}),
    })
    return { state, created: true }
  })
}

export async function unfollow(deps: VoiceDeps, subject: string, targetId: string): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    const rows = await tx<{ follower_id: string }[]>`
      delete from follows
       where follower_id = ${me.id} and followee_id = ${targetId}
      returning follower_id
    `
    return rows.length > 0
  })
}

/** Accept a pending follow. Only the followee may. */
export async function acceptFollow(
  deps: VoiceDeps,
  subject: string,
  followerId: string,
): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    const rows = await tx<{ follower_id: string }[]>`
      update follows set state = 'active'
       where follower_id = ${followerId} and followee_id = ${me.id} and state = 'pending'
      returning follower_id
    `
    if (!rows[0]) return false
    await notify(tx, { voiceId: followerId, kind: 'follow_accepted', actorId: me.id })
    return true
  })
}

/** Refuse a pending follow. The requester is not told, which is the point of a request. */
export async function rejectFollow(
  deps: VoiceDeps,
  subject: string,
  followerId: string,
): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    const rows = await tx<{ follower_id: string }[]>`
      delete from follows
       where follower_id = ${followerId} and followee_id = ${me.id} and state = 'pending'
      returning follower_id
    `
    return rows.length > 0
  })
}

/**
 * Bar a voice. Symmetric, total, and it deletes both follows in the same transaction.
 *
 * The deletion is the whole reason this is a function rather than an insert at a route. See the
 * file header: a bar that leaves a follow in place is a bar that does not work, and the person who
 * set it has no way to discover that.
 */
export async function bar(
  deps: VoiceDeps,
  subject: string,
  targetId: string,
  correlationId?: string,
): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const me = await ensureVoice(tx, subject)
    if (me.id === targetId) throw new VoiceError('a voice cannot bar itself')
    const target = await findVoice(tx, targetId)
    if (!target) throw new VoiceStateError('no such voice')

    const rows = await tx<{ voice_id: string }[]>`
      insert into bars (voice_id, barred_id) values (${me.id}, ${targetId})
      on conflict do nothing
      returning voice_id
    `

    // BOTH directions, unconditionally, even when the bar row already existed. Running it on the
    // idempotent path too is deliberate: a follow created between two bars of the same person is
    // exactly the state this cleans up, and skipping the work because the insert conflicted would
    // leave it there.
    await tx`
      delete from follows
       where (follower_id = ${me.id} and followee_id = ${targetId})
          or (follower_id = ${targetId} and followee_id = ${me.id})
    `
    // And the whisper thread is left in place but closed to both: `whispers.ts` reads the bar on
    // every send. Deleting the thread would delete the recipient's copy of a conversation they may
    // need as evidence for the report they are about to file.

    if (rows[0]) {
      emit({
        topic: 'agora.bar.created',
        key: `${me.id}:${targetId}`,
        // The BARRED party is a voice id and stays one. `subject` is the barrer's — whose act it is
        // and whose timeline it belongs in.
        payload: { voiceId: me.id, barredId: targetId, subject },
        actor: subject,
        ...(correlationId ? { correlationId } : {}),
      })
    }
    return rows.length > 0
  })
}

export async function unbar(deps: VoiceDeps, subject: string, targetId: string): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    const rows = await tx<{ voice_id: string }[]>`
      delete from bars where voice_id = ${me.id} and barred_id = ${targetId} returning voice_id
    `
    return rows.length > 0
  })
}

/** Hush a voice: they stay followed, stay unaware, and stop appearing. */
export async function hush(
  deps: VoiceDeps,
  subject: string,
  targetId: string,
  expiresAt: Date | null,
): Promise<void> {
  await withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    if (me.id === targetId) throw new VoiceError('a voice cannot hush itself')
    await tx`
      insert into hushes (voice_id, hushed_id, expires_at)
      values (${me.id}, ${targetId}, ${expiresAt})
      on conflict (voice_id, hushed_id) do update set expires_at = ${expiresAt}
    `
  })
}

export async function unhush(deps: VoiceDeps, subject: string, targetId: string): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    const rows = await tx<{ voice_id: string }[]>`
      delete from hushes where voice_id = ${me.id} and hushed_id = ${targetId} returning voice_id
    `
    return rows.length > 0
  })
}

export async function hushTag(
  deps: VoiceDeps,
  subject: string,
  tag: string,
  expiresAt: Date | null,
): Promise<void> {
  await withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    const normalised = tag.trim().toLowerCase().replace(/^#/, '')
    if (!/^[a-z0-9_]{1,64}$/.test(normalised)) throw new VoiceError('that is not a tag')
    await tx`
      insert into tag_hushes (voice_id, tag, expires_at)
      values (${me.id}, ${normalised}, ${expiresAt})
      on conflict (voice_id, tag) do update set expires_at = ${expiresAt}
    `
  })
}

export async function unhushTag(deps: VoiceDeps, subject: string, tag: string): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    const rows = await tx<{ voice_id: string }[]>`
      delete from tag_hushes
       where voice_id = ${me.id} and tag = ${tag.trim().toLowerCase().replace(/^#/, '')}
      returning voice_id
    `
    return rows.length > 0
  })
}

/* ------------------------------------------------------------------ graph reads */

/** True when either has barred the other. The read half of the symmetric rule. */
export async function barredEitherWay(sql: Db | Tx, a: string, b: string): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    select 1 as one from bars
     where (voice_id = ${a} and barred_id = ${b})
        or (voice_id = ${b} and barred_id = ${a})
     limit 1
  `
  return rows.length > 0
}

/** True when `follower` follows `followee` and the follow has been accepted. */
export async function followsActive(sql: Db | Tx, follower: string, followee: string): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    select 1 as one from follows
     where follower_id = ${follower} and followee_id = ${followee} and state = 'active'
     limit 1
  `
  return rows.length > 0
}

export interface Relationship {
  readonly following: FollowState | null
  readonly followedBy: boolean
  readonly barred: boolean
  readonly barredBy: boolean
  readonly hushed: boolean
}

/**
 * How two voices stand to each other, in one round trip.
 *
 * `barredBy` is returned separately from `barred` for the viewer's own record, and neither is ever
 * shown to the other party: a route that told somebody they had been barred would be a route that
 * told them to make a second account.
 */
export async function relationship(sql: Db | Tx, viewer: string, other: string): Promise<Relationship> {
  const rows = await sql<
    {
      following: string | null
      followed_by: boolean
      barred: boolean
      barred_by: boolean
      hushed: boolean
    }[]
  >`
    select
      (select state from follows where follower_id = ${viewer} and followee_id = ${other}) as following,
      exists(select 1 from follows where follower_id = ${other} and followee_id = ${viewer}
             and state = 'active') as followed_by,
      exists(select 1 from bars where voice_id = ${viewer} and barred_id = ${other}) as barred,
      exists(select 1 from bars where voice_id = ${other} and barred_id = ${viewer}) as barred_by,
      exists(select 1 from hushes where voice_id = ${viewer} and hushed_id = ${other}
             and (expires_at is null or expires_at > now())) as hushed
  `
  const row = rows[0]!
  return {
    following: (row.following as FollowState | null) ?? null,
    followedBy: row.followed_by,
    barred: row.barred,
    barredBy: row.barred_by,
    hushed: row.hushed,
  }
}

export interface VoiceCounts {
  readonly followers: number
  readonly following: number
  readonly posts: number
}

/**
 * The three counts, for the account's OWN eyes.
 *
 * `server.ts` returns this on `GET /v1/me` and on nobody else's profile — doc 41 §4's second rule.
 * The numbers exist; they are simply not a scoreboard. Counting on read rather than storing a
 * column is what keeps it that way: there is no cached follower count for a future route to
 * accidentally return, because there is no column to return.
 */
export async function countsFor(sql: Db | Tx, voiceId: string): Promise<VoiceCounts> {
  const rows = await sql<{ followers: string; following: string; posts: string }[]>`
    select
      (select count(*) from follows where followee_id = ${voiceId} and state = 'active') as followers,
      (select count(*) from follows where follower_id = ${voiceId} and state = 'active') as following,
      (select count(*) from posts where voice_id = ${voiceId} and deleted_at is null) as posts
  `
  const row = rows[0]!
  return {
    followers: Number(row.followers),
    following: Number(row.following),
    posts: Number(row.posts),
  }
}

export interface VoicePage {
  readonly voices: readonly Voice[]
  readonly nextCursor: string | null
}

/**
 * The public directory, and search over it.
 *
 * `discoverable = false` and a suspension both take a voice out of it. Neither hides the profile
 * from somebody who has the link — that is what `protected` is for — and conflating the two is how
 * a product ends up with a "private" setting that does one of the three things people expect.
 */
export async function listVoices(
  sql: Db,
  options: { readonly query?: string; readonly limit: number; readonly cursor?: string | null },
): Promise<VoicePage> {
  const limit = Math.max(1, options.limit)
  const query = (options.query ?? '').trim().toLowerCase().replace(/^@/, '')
  const cursor = decodeCursor(options.cursor ?? null)

  const rows = await sql<VoiceRow[]>`
    select ${sql.unsafe(COLUMNS)} from voices
     where discoverable and suspended_at is null
       ${
         query
           ? sql`and (handle like ${`%${query}%`} or lower(display_name) like ${`%${query}%`})`
           : sql``
       }
       ${cursor ? sql`and (created_at, id) < (${cursor.at}, ${cursor.id})` : sql``}
     order by created_at desc, id desc
     limit ${limit + 1}
  `

  const page = rows.slice(0, limit).map(toVoice)
  const last = page[page.length - 1]
  return {
    voices: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
  }
}

/* ------------------------------------------------------------------ cursors */

/**
 * A keyset cursor: the timestamp and the id of the last row on the page.
 *
 * An offset would have been one line shorter and wrong in a way nobody notices in testing. A
 * timeline moves while somebody reads it, so `offset 50` after four new posts skips four posts the
 * reader never saw — silently, with no gap in the page to hint at it. A keyset cursor names the
 * exact row to continue from, so new arrivals appear at the top where they belong and the page
 * boundary holds.
 *
 * The id breaks the tie because two posts can share a millisecond and `(created_at) <` alone would
 * either repeat or skip one of them.
 */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url')
}

export function decodeCursor(raw: string | null): { at: Date; id: string } | null {
  if (!raw) return null
  let decoded: string
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    throw new VoiceError('that cursor is not one this service issued')
  }
  const [at, id] = decoded.split('|')
  const parsed = at ? new Date(at) : new Date(Number.NaN)
  if (!id || Number.isNaN(parsed.getTime())) {
    throw new VoiceError('that cursor is not one this service issued')
  }
  return { at: parsed, id }
}

/* ------------------------------------------------------------------ notifications */

/**
 * Write a notification, ignoring the duplicate.
 *
 * Declared here rather than imported from `notifications.ts` to keep the module graph acyclic:
 * `notifications.ts` reads voices, and a voice write that reached back into it would close the
 * loop. The insert is deliberately trivial — everything interesting about a notification happens
 * on the read side.
 *
 * `on conflict do nothing` is doing real work: `notifications_dedupe_idx` makes one (recipient,
 * kind, actor, post) unique, so unsparking and re-sparking does not produce a second badge.
 */
export async function notify(
  tx: Tx,
  input: {
    voiceId: string
    kind: string
    actorId?: string | null
    postId?: string | null
    circleId?: string | null
    threadId?: string | null
    detail?: string
  },
): Promise<void> {
  // Never notify somebody about their own action. Every network has shipped this bug at least
  // once, and it reads as the product not knowing who you are.
  if (input.actorId && input.actorId === input.voiceId) return
  await tx`
    insert into notifications (voice_id, kind, actor_id, post_id, circle_id, thread_id, detail)
    values (
      ${input.voiceId}, ${input.kind}, ${input.actorId ?? null}, ${input.postId ?? null},
      ${input.circleId ?? null}, ${input.threadId ?? null}, ${input.detail ?? ''}
    )
    on conflict do nothing
  `
}

/* ------------------------------------------------------------------ erasure */

/**
 * Erase everything one subject wrote. The handler for `identity.user.deleted`.
 *
 * A hard delete, not a flag. The account is gone from identity; leaving its posts up under a
 * tombstone would be this service keeping personal data after the system of record deleted it,
 * which is not a product decision this service gets to make. Every foreign key in `migrations.ts`
 * is `on delete cascade` precisely so the CONTENT half is one statement rather than a list
 * somebody has to remember to extend.
 *
 * ── THE THREE TABLES THE CASCADE DOES NOT REACH ───────────────────────────────────────────────
 *
 * `delete from voices` was the whole of this function until it was checked against the estate's
 * erasure drill (`deploy/scripts/erasure-drill.sh`), which does not read a handler — it deletes a
 * real user and then scans EVERY text, uuid and jsonb column of EVERY table for the id. Three
 * places hold `user:<uuid>` and none of them hangs off `voices`:
 *
 * ┌──────────────────────────┬──────────┬─────────────────────────────────────────────────────────
 * │ outbox.actor             │ REDACT   │ THE ONE THAT IS EASY TO MISS, AND IT IS THE WORST OF
 * │ outbox.payload->>subject │          │ the three. Eight of this service's nine topics put the
 * │                          │          │ actor's `user:<uuid>` on the ENVELOPE, and seven repeat
 * │                          │          │ it in the payload on purpose (`agora.follow.created`
 * │                          │          │ argues why). NOTHING PRUNES THIS TABLE — there is no
 * │                          │          │ sweep in `jobs.ts` and no retention on the rows — so an
 * │                          │          │ erasure that emptied `voices` and left the outbox would
 * │                          │          │ keep, for ever, a dated list of everything the person
 * │                          │          │ did on the square. That is not a lesser copy of the
 * │                          │          │ posts; on a social service it is a strictly worse one,
 * │                          │          │ because it is the timing as well as the content.
 * │                          │          │
 * │                          │          │ REDACTED, not deleted: an outbox row is the durable
 * │                          │          │ record that an event was emitted, and an unpublished
 * │                          │          │ one is a delivery other services are still owed.
 * │                          │          │ Deleting it would drop an `agora.post.deleted` that
 * │                          │          │ `micro-activity` is waiting for and leave a dangling
 * │                          │          │ activity record — an erasure creating the exact
 * │                          │          │ residue it exists to remove. The redacted row relays
 * │                          │          │ naming nobody.
 * ├──────────────────────────┼──────────┼─────────────────────────────────────────────────────────
 * │ moderation_actions       │ REDACT   │ `operator` is text and holds an identity subject when a
 * │   .operator              │ the      │ human moderated (a service name otherwise), by the
 * │ reports.resolved_by      │ operator │ deliberate design recorded on the column: an operator
 * │                          │          │ is not required to have a voice on the square they
 * │                          │          │ moderate, so there is no FK to cascade through.
 * │                          │          │
 * │                          │          │ This fires when THE MODERATOR is the person erased, not
 * │                          │          │ the moderated — a case that reads as impossible until
 * │                          │          │ you notice that whoever staffs the report queue has an
 * │                          │          │ ecosystem account like everyone else and may close it.
 * │                          │          │ The ACTION is kept: it is why a post is missing and why
 * │                          │          │ a voice is suspended, and deleting it would silently
 * │                          │          │ un-explain live moderation state. Only the attribution
 * │                          │          │ goes, which is the same trade `micro-devplatform` makes
 * │                          │          │ for `api_keys.created_by`.
 * └──────────────────────────┴──────────┴─────────────────────────────────────────────────────────
 *
 * `inbox` is checked and genuinely clean: it is `(topic, event_id, received_at)` and carries no
 * payload, so the deletion event itself leaves nothing behind — which is not true of most services
 * in this estate and is worth having said out loud rather than rediscovered.
 *
 * ── THE PLACEHOLDER ───────────────────────────────────────────────────────────────────────────
 *
 * One random `erased:<uuid>` per erasure, never derived from the subject. A hash — keyed or not —
 * is brute-forceable over a candidate list, and the candidate list is exactly the set of user ids
 * this platform has. Nothing stores the mapping, so there is nothing to compel and nothing to
 * leak. One placeholder shared across that person's retained rows leaves those rows linked to each
 * other and to no person, which is the property that matters; a fresh uuid per row would buy
 * nothing and hide from an operator that four redactions were one erasure.
 *
 * Returns the voice id it erased, or null when the subject never had one — which is the common
 * case and must not be an error, because the event is delivered to every consumer regardless. The
 * redactions run either way: somebody can have moderated, or have been named on an event, without
 * ever having had a voice of their own.
 */
export async function eraseSubject(tx: Tx, subject: string): Promise<string | null> {
  const placeholder = `erased:${randomUUID()}`

  const rows = await tx<{ id: string }[]>`
    delete from voices where subject = ${subject} returning id
  `

  // The envelope actor, and the payload copy of it. Two statements rather than one `or`, because
  // they are two different claims: every topic sets `actor`, and seven of them additionally name
  // the subject in the body. A row can match either, both or neither.
  await tx`update outbox set actor = ${placeholder} where actor = ${subject}`
  await tx`
    update outbox
       set payload = jsonb_set(payload, '{subject}', to_jsonb(${placeholder}::text))
     where payload ->> 'subject' = ${subject}
  `

  // The moderation record keeps its action and loses its author.
  await tx`update moderation_actions set operator = ${placeholder} where operator = ${subject}`
  await tx`update reports set resolved_by = ${placeholder} where resolved_by = ${subject}`

  return rows[0]?.id ?? null
}

export type { Emit }
