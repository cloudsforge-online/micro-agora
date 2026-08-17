/**
 * Circles: the square's groups.
 *
 * A circle is a named place with members, a steward or two, and posts that belong to it. Three
 * visibilities, and they mean different things to a stranger:
 *
 *   `open`     anybody may join without asking, and the posts are public — a public room.
 *   `request`  anybody may ask, a steward decides, and the posts are members-only.
 *   `closed`   invitation only, and the posts are members-only.
 *
 * ## THE STEWARD RULE, AND WHY THERE IS NO OWNER
 *
 * A circle has stewards, not an owner. The creator is made one; any steward may make another, and
 * `leaveCircle` refuses to remove the LAST steward of a circle that still has members. An owner
 * who stops logging in is a room nobody can moderate and nobody can rename, and the only fix is an
 * operator reaching into the database — which is to say, a support ticket standing in for a
 * product decision that should have been made here.
 *
 * The refusal is a real refusal: the last steward is told to appoint somebody or archive the
 * circle. That is a slightly annoying moment for one person, and it is much better than the
 * alternative, which is an abandoned room that fills with spam nobody can delete.
 *
 * ## AND THE POSTS ARE NOT DELETED WHEN A CIRCLE IS ARCHIVED
 *
 * Archiving closes a circle to new posts and takes it off the directory. The posts stay, readable
 * by the members who were there. A circle's archive is somebody's conversation, and deleting it
 * because the room closed would destroy a record they did not agree to lose. `posts_circle_fk` is
 * `on delete cascade` for the case where a circle is genuinely DELETED by moderation, which is a
 * different act with a different audit row.
 */

import { withOutbox, type Db, type Tx } from './outbox.ts'
import { ensureVoice, notify, VoiceError, VoiceStateError } from './voices.ts'

export class CircleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CircleError'
  }
}

export class CircleNotFoundError extends Error {
  constructor(message = 'no such circle') {
    super(message)
    this.name = 'CircleNotFoundError'
  }
}

/** A refusal the state produced rather than the request. Maps to 409. */
export class CircleStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CircleStateError'
  }
}

export type CircleVisibility = 'open' | 'request' | 'closed'
export type MemberRole = 'member' | 'steward'
export type MemberState = 'active' | 'pending' | 'banned'

export interface Circle {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly purpose: string
  readonly visibility: CircleVisibility
  readonly avatarAssetId: string | null
  readonly createdBy: string | null
  readonly createdAt: Date
  readonly archivedAt: Date | null
  readonly members: number
  /** The viewer's own standing. Absent for a logged-out reader. */
  readonly viewer?: { readonly role: MemberRole | null; readonly state: MemberState | null }
}

interface CircleRow {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly purpose: string
  readonly visibility: string
  readonly avatar_asset_id: string | null
  readonly created_by: string | null
  readonly created_at: Date
  readonly archived_at: Date | null
  readonly members: string
  readonly viewer_role: string | null
  readonly viewer_state: string | null
}

function toCircle(row: CircleRow, viewer: boolean): Circle {
  const circle: Circle = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    purpose: row.purpose,
    visibility: row.visibility as CircleVisibility,
    avatarAssetId: row.avatar_asset_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    // A MEMBER count is public where a follower count is not, and the difference is deliberate. A
    // follower count is a score attached to a person; a member count is the size of a room, which
    // is information somebody needs to decide whether to walk into it.
    members: Number(row.members),
  }
  if (!viewer) return circle
  return {
    ...circle,
    viewer: {
      role: (row.viewer_role as MemberRole | null) ?? null,
      state: (row.viewer_state as MemberState | null) ?? null,
    },
  }
}

export interface CircleDeps {
  readonly sql: Db
  readonly producer: string
}

const SELECT_CIRCLE = (sql: Db | Tx, viewerId: string | null) => sql`
  select c.id, c.slug, c.name, c.purpose, c.visibility, c.avatar_asset_id, c.created_by,
         c.created_at, c.archived_at,
         (select count(*) from circle_members m
           where m.circle_id = c.id and m.state = 'active') as members,
         ${
           viewerId
             ? sql`(select role from circle_members m
                     where m.circle_id = c.id and m.voice_id = ${viewerId})`
             : sql`null`
         } as viewer_role,
         ${
           viewerId
             ? sql`(select state from circle_members m
                     where m.circle_id = c.id and m.voice_id = ${viewerId})`
             : sql`null`
         } as viewer_state
    from circles c
`

/* ------------------------------------------------------------------ reading */

export async function findCircle(
  sql: Db,
  idOrSlug: string,
  viewerId: string | null,
): Promise<Circle | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug)
  const rows = await sql<CircleRow[]>`
    ${SELECT_CIRCLE(sql, viewerId)}
    where ${isUuid ? sql`c.id = ${idOrSlug}` : sql`c.slug = ${idOrSlug.toLowerCase()}`}
  `
  return rows[0] ? toCircle(rows[0], viewerId !== null) : null
}

/**
 * The circle directory.
 *
 * Archived circles are excluded, and closed ones are NOT: a closed circle is invitation-only, not
 * secret, and hiding it would mean somebody could be invited to a room they cannot verify exists.
 * What is hidden is its posts, which is what "closed" is about.
 */
export async function listCircles(
  sql: Db,
  options: { readonly query?: string; readonly viewerId: string | null; readonly limit: number },
): Promise<readonly Circle[]> {
  const query = (options.query ?? '').trim().toLowerCase()
  const limit = Math.min(Math.max(options.limit, 1), 100)
  const rows = await sql<CircleRow[]>`
    ${SELECT_CIRCLE(sql, options.viewerId)}
    where c.archived_at is null
      ${query ? sql`and (c.slug like ${`%${query}%`} or lower(c.name) like ${`%${query}%`})` : sql``}
    order by (select count(*) from circle_members m
               where m.circle_id = c.id and m.state = 'active') desc,
             c.created_at desc
    limit ${limit}
  `
  return rows.map((row) => toCircle(row, options.viewerId !== null))
}

/** The circles this voice belongs to. Their own list, on their own page. */
export async function myCircles(sql: Db, viewerId: string): Promise<readonly Circle[]> {
  const rows = await sql<CircleRow[]>`
    ${SELECT_CIRCLE(sql, viewerId)}
    where exists(select 1 from circle_members m
                  where m.circle_id = c.id and m.voice_id = ${viewerId} and m.state = 'active')
    order by c.name asc
  `
  return rows.map((row) => toCircle(row, true))
}

export interface Member {
  readonly voiceId: string
  readonly handle: string
  readonly displayName: string
  readonly avatarAssetId: string | null
  readonly role: MemberRole
  readonly state: MemberState
  readonly joinedAt: Date
}

/**
 * A circle's members.
 *
 * Readable by members of a members-only circle, and by anybody for an open one. A stranger asking
 * for the roster of a closed circle gets a 404, not a 403 — the same rule as everywhere else here,
 * because a 403 confirms the circle exists and has members worth hiding.
 */
export async function listMembers(
  sql: Db,
  circleId: string,
  viewerId: string | null,
  state: MemberState = 'active',
): Promise<readonly Member[]> {
  const rows = await sql<
    {
      voice_id: string
      handle: string
      display_name: string
      avatar_asset_id: string | null
      role: string
      state: string
      joined_at: Date
    }[]
  >`
    select m.voice_id, v.handle, v.display_name, v.avatar_asset_id, m.role, m.state, m.joined_at
      from circle_members m
      join voices v on v.id = m.voice_id
     where m.circle_id = ${circleId} and m.state = ${state}
       ${
         viewerId
           ? sql`and not exists(
                   select 1 from bars b
                    where (b.voice_id = ${viewerId} and b.barred_id = m.voice_id)
                       or (b.voice_id = m.voice_id and b.barred_id = ${viewerId}))`
           : sql``
       }
     order by m.role desc, m.joined_at asc
     limit 500
  `
  return rows.map((r) => ({
    voiceId: r.voice_id,
    handle: r.handle,
    displayName: r.display_name,
    avatarAssetId: r.avatar_asset_id,
    role: r.role as MemberRole,
    state: r.state as MemberState,
    joinedAt: r.joined_at,
  }))
}

/** True when the viewer may read a circle's posts. */
export async function canRead(sql: Db, circle: Circle, viewerId: string | null): Promise<boolean> {
  if (circle.visibility === 'open') return true
  if (!viewerId) return false
  const rows = await sql<{ one: number }[]>`
    select 1 as one from circle_members
     where circle_id = ${circle.id} and voice_id = ${viewerId} and state = 'active'
  `
  return rows.length > 0
}

/* ------------------------------------------------------------------ writing */

export interface CreateCircleInput {
  readonly slug: string
  readonly name: string
  readonly purpose?: string
  readonly visibility?: CircleVisibility
  readonly avatarAssetId?: string | null
}

export async function createCircle(
  deps: CircleDeps,
  subject: string,
  input: CreateCircleInput,
  correlationId?: string,
): Promise<Circle> {
  const slug = input.slug.trim().toLowerCase()
  if (!/^[a-z0-9_-]{2,40}$/.test(slug)) {
    throw new CircleError('a circle address is 2 to 40 characters of lowercase letters, digits, - and _')
  }
  const name = input.name.trim()
  if (!name || name.length > 80) throw new CircleError('a circle needs a name of at most 80 characters')
  const purpose = (input.purpose ?? '').trim()
  if (purpose.length > 600) throw new CircleError('a purpose is at most 600 characters')

  const id = await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const me = await ensureVoice(tx, subject)
    if (me.suspendedAt) throw new CircleStateError('a suspended voice cannot create a circle')

    const rows = await tx<{ id: string }[]>`
      insert into circles (slug, name, purpose, visibility, avatar_asset_id, created_by)
      values (${slug}, ${name}, ${purpose}, ${input.visibility ?? 'open'},
              ${input.avatarAssetId ?? null}, ${me.id})
      on conflict (slug) do nothing
      returning id
    `
    if (!rows[0]) throw new CircleStateError(`the address ${slug} is taken`)
    const circleId = rows[0].id

    // The creator is a STEWARD, not an owner. See the header — the distinction is what makes
    // stewardship transferable and an abandoned circle recoverable.
    await tx`
      insert into circle_members (circle_id, voice_id, role, state)
      values (${circleId}, ${me.id}, 'steward', 'active')
    `

    emit({
      topic: 'agora.circle.created',
      key: circleId,
      // `createdBy` is the voice, `subject` is the person — see `agora.spark.created` for why both.
      payload: {
        circleId,
        slug,
        name,
        visibility: input.visibility ?? 'open',
        createdBy: me.id,
        subject,
      },
      actor: subject,
      ...(correlationId ? { correlationId } : {}),
    })
    return circleId
  })

  const circle = await findCircle(deps.sql, id, null)
  if (!circle) throw new CircleError('the circle was created but could not be read back')
  return circle
}

export interface JoinResult {
  readonly state: MemberState
  readonly created: boolean
}

/**
 * Join a circle, or ask to.
 *
 * `open` admits immediately. `request` creates a pending row and notifies the stewards. `closed`
 * refuses — an invitation is the only way in, and it comes from `inviteToCircle`.
 */
export async function joinCircle(
  deps: CircleDeps,
  subject: string,
  circleId: string,
): Promise<JoinResult> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    const rows = await tx<{ visibility: string; archived_at: Date | null }[]>`
      select visibility, archived_at from circles where id = ${circleId}
    `
    const circle = rows[0]
    if (!circle) throw new CircleNotFoundError()
    if (circle.archived_at) throw new CircleStateError('this circle is archived')

    const existing = await tx<{ state: string }[]>`
      select state from circle_members where circle_id = ${circleId} and voice_id = ${me.id}
    `
    if (existing[0]) {
      // A banned member asking again is told nothing new. Re-admitting them silently would undo a
      // steward's decision; telling them they are banned invites the argument the ban ended.
      if (existing[0].state === 'banned') throw new CircleNotFoundError()
      return { state: existing[0].state as MemberState, created: false }
    }

    if (circle.visibility === 'closed') {
      throw new CircleStateError('this circle is invitation only')
    }
    const state: MemberState = circle.visibility === 'open' ? 'active' : 'pending'
    await tx`
      insert into circle_members (circle_id, voice_id, role, state)
      values (${circleId}, ${me.id}, 'member', ${state})
    `

    if (state === 'pending') {
      const stewards = await tx<{ voice_id: string }[]>`
        select voice_id from circle_members
         where circle_id = ${circleId} and role = 'steward' and state = 'active'
      `
      for (const steward of stewards) {
        await notify(tx, {
          voiceId: steward.voice_id,
          kind: 'circle_request',
          actorId: me.id,
          circleId,
        })
      }
    }
    return { state, created: true }
  })
}

/**
 * Leave a circle.
 *
 * Refuses to remove the last steward while the circle still has other members. See the header:
 * the alternative is an unmoderatable room, and the person who would create it is exactly the
 * person best placed to prevent it.
 */
export async function leaveCircle(
  deps: CircleDeps,
  subject: string,
  circleId: string,
): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    const rows = await tx<{ role: string }[]>`
      select role from circle_members
       where circle_id = ${circleId} and voice_id = ${me.id}
       for update
    `
    if (!rows[0]) return false

    if (rows[0].role === 'steward') {
      const others = await tx<{ stewards: string; members: string }[]>`
        select
          (select count(*) from circle_members
            where circle_id = ${circleId} and role = 'steward' and state = 'active'
              and voice_id <> ${me.id}) as stewards,
          (select count(*) from circle_members
            where circle_id = ${circleId} and state = 'active' and voice_id <> ${me.id}) as members
      `
      const stewards = Number(others[0]?.stewards ?? 0)
      const members = Number(others[0]?.members ?? 0)
      if (stewards === 0 && members > 0) {
        throw new CircleStateError(
          'you are the last steward of a circle that still has members — appoint another steward, or archive the circle',
        )
      }
    }

    await tx`
      delete from circle_members where circle_id = ${circleId} and voice_id = ${me.id}
    `
    return true
  })
}

/** A steward admits or refuses a pending member. */
export async function decideMembership(
  deps: CircleDeps,
  subject: string,
  circleId: string,
  voiceId: string,
  admit: boolean,
): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    await assertSteward(tx, circleId, me.id)

    if (admit) {
      const rows = await tx<{ voice_id: string }[]>`
        update circle_members set state = 'active'
         where circle_id = ${circleId} and voice_id = ${voiceId} and state = 'pending'
        returning voice_id
      `
      if (!rows[0]) return false
      await notify(tx, { voiceId, kind: 'circle_accepted', actorId: me.id, circleId })
      return true
    }
    const rows = await tx<{ voice_id: string }[]>`
      delete from circle_members
       where circle_id = ${circleId} and voice_id = ${voiceId} and state = 'pending'
      returning voice_id
    `
    return rows.length > 0
  })
}

/** Invite somebody into a circle. The only way into a closed one. */
export async function inviteToCircle(
  deps: CircleDeps,
  subject: string,
  circleId: string,
  voiceId: string,
): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    await assertSteward(tx, circleId, me.id)

    const rows = await tx<{ voice_id: string }[]>`
      insert into circle_members (circle_id, voice_id, role, state)
      values (${circleId}, ${voiceId}, 'member', 'active')
      on conflict do nothing
      returning voice_id
    `
    if (!rows[0]) return false
    await notify(tx, { voiceId, kind: 'circle_invite', actorId: me.id, circleId })
    return true
  })
}

/** Promote a member to steward, or demote one. A steward may do either, including to themselves. */
export async function setRole(
  deps: CircleDeps,
  subject: string,
  circleId: string,
  voiceId: string,
  role: MemberRole,
): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    await assertSteward(tx, circleId, me.id)

    if (role === 'member' && voiceId === me.id) {
      const others = await tx<{ stewards: string }[]>`
        select count(*) as stewards from circle_members
         where circle_id = ${circleId} and role = 'steward' and state = 'active'
           and voice_id <> ${me.id}
      `
      if (Number(others[0]?.stewards ?? 0) === 0) {
        throw new CircleStateError('a circle cannot be left with no steward')
      }
    }

    const rows = await tx<{ voice_id: string }[]>`
      update circle_members set role = ${role}
       where circle_id = ${circleId} and voice_id = ${voiceId} and state = 'active'
      returning voice_id
    `
    return rows.length > 0
  })
}

/** Remove somebody from a circle, optionally for good. */
export async function removeMember(
  deps: CircleDeps,
  subject: string,
  circleId: string,
  voiceId: string,
  ban: boolean,
): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    await assertSteward(tx, circleId, me.id)
    if (voiceId === me.id) throw new CircleError('leave the circle instead')

    if (ban) {
      const rows = await tx<{ voice_id: string }[]>`
        insert into circle_members (circle_id, voice_id, role, state)
        values (${circleId}, ${voiceId}, 'member', 'banned')
        on conflict (circle_id, voice_id) do update set state = 'banned', role = 'member'
        returning voice_id
      `
      return rows.length > 0
    }
    const rows = await tx<{ voice_id: string }[]>`
      delete from circle_members where circle_id = ${circleId} and voice_id = ${voiceId}
      returning voice_id
    `
    return rows.length > 0
  })
}

export interface UpdateCircleInput {
  readonly name?: string
  readonly purpose?: string
  readonly visibility?: CircleVisibility
  readonly avatarAssetId?: string | null
  readonly archived?: boolean
}

export async function updateCircle(
  deps: CircleDeps,
  subject: string,
  circleId: string,
  input: UpdateCircleInput,
): Promise<Circle> {
  await withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    await assertSteward(tx, circleId, me.id)

    const current = await tx<CircleRow[]>`
      select id, slug, name, purpose, visibility, avatar_asset_id, created_by, created_at,
             archived_at, '0' as members, null as viewer_role, null as viewer_state
        from circles where id = ${circleId} for update
    `
    const row = current[0]
    if (!row) throw new CircleNotFoundError()

    const name = (input.name ?? row.name).trim()
    if (!name || name.length > 80) throw new CircleError('a circle needs a name of at most 80 characters')
    const purpose = (input.purpose ?? row.purpose).trim()
    if (purpose.length > 600) throw new CircleError('a purpose is at most 600 characters')

    await tx`
      update circles set
        name = ${name},
        purpose = ${purpose},
        visibility = ${input.visibility ?? row.visibility},
        avatar_asset_id = ${
          input.avatarAssetId !== undefined ? input.avatarAssetId : row.avatar_asset_id
        },
        archived_at = ${
          input.archived === undefined ? row.archived_at : input.archived ? new Date() : null
        }
      where id = ${circleId}
    `
  })

  const circle = await findCircle(deps.sql, circleId, null)
  if (!circle) throw new CircleNotFoundError()
  return circle
}

/**
 * Raise unless this voice is an active steward of this circle.
 *
 * A `CircleNotFoundError`, not a permission error, for the reason the rest of this service gives:
 * a 403 tells a stranger the circle is real. There is one exception in `moderation.ts`, where an
 * operator acting with `agora:moderate` is already known to exist.
 */
async function assertSteward(tx: Tx, circleId: string, voiceId: string): Promise<void> {
  const rows = await tx<{ one: number }[]>`
    select 1 as one from circle_members
     where circle_id = ${circleId} and voice_id = ${voiceId}
       and role = 'steward' and state = 'active'
  `
  if (!rows[0]) throw new CircleNotFoundError()
}

export { VoiceError, VoiceStateError }
