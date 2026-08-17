/**
 * Whispers: direct messages between two voices.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A WHISPER IS NOT END-TO-END ENCRYPTED, AND EVERY SURFACE THAT COMPOSES ONE SAYS SO.**
 *
 * The bodies are stored as text in this service's database. An operator with database access can
 * read them. Backups contain them. That is stated in doc 41 §5, it is stated in the compose box —
 * permanently, not as a dismissible notice — and it is stated here so that nobody implementing
 * against this module has to infer it from the absence of a key exchange.
 *
 * This is a deliberate trade and it is worth naming the alternative. Real end-to-end encryption
 * needs per-device keys, a key-verification flow people actually complete, and an answer for
 * "I lost my phone" that is not "you lost your conversations". Shipping a half of that and calling
 * it private is how a product ends up with users who believe they are protected and are not — and
 * on a square where people discuss money, that belief is the thing that gets somebody hurt.
 *
 * So: build the feature everybody expects, and tell the truth about it. If E2E arrives later it
 * arrives as a new message kind with its own storage, not as a claim retrofitted onto these rows.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## ONE THREAD PER PAIR, FOR EVER
 *
 * `pair_key` is the two voice ids sorted and joined, and it is UNIQUE. Sorted is what makes it the
 * same key from both sides; unique is what stops a double-click on "message" opening a second
 * thread that the reply lands in while the recipient answers into the first. That failure is
 * invisible to both people — each sees a conversation that the other appears to be ignoring.
 *
 * ## AND WHO MAY START ONE
 *
 * `voices.whispers_from` is `everyone`, `follows` or `nobody`, and a bar in either direction beats
 * all three. The default is `everyone`, because a square where a stranger cannot be answered is
 * not a square; the rate limit and the bar are what make that safe, rather than a closed door.
 */

import { withOutbox, type Db, type Tx } from './outbox.ts'
import { normaliseBody } from './text.ts'
import { claim } from './ratelimit.ts'
import {
  barredEitherWay,
  ensureVoice,
  followsActive,
  notify,
  decodeCursor,
  encodeCursor,
} from './voices.ts'

export class WhisperError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WhisperError'
  }
}

/** The recipient does not accept whispers from this voice. Maps to 403 — see the note below. */
export class WhisperRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WhisperRefusedError'
  }
}

export class WhisperNotFoundError extends Error {
  constructor(message = 'no such conversation') {
    super(message)
    this.name = 'WhisperNotFoundError'
  }
}

export interface WhisperDeps {
  readonly sql: Db
  readonly producer: string
  readonly whispersPerHour: number
  readonly postMaxChars: number
}

export interface Whisper {
  readonly id: string
  readonly threadId: string
  readonly voiceId: string
  readonly handle: string
  readonly displayName: string
  readonly avatarAssetId: string | null
  readonly body: string
  readonly createdAt: Date
  readonly deleted: boolean
}

export interface Thread {
  readonly id: string
  readonly createdAt: Date
  readonly lastPostAt: Date
  readonly other: {
    readonly voiceId: string
    readonly handle: string
    readonly displayName: string
    readonly avatarAssetId: string | null
  }
  readonly unread: number
  readonly lastBody: string
}

/** The two ids, sorted and joined. The same key from either side. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join(':')
}

/* ------------------------------------------------------------------ sending */

/**
 * Send a whisper, opening the thread if there is not one.
 *
 * ── WHY THIS IS A 403 AND NOT A 404 ───────────────────────────────────────────────────────────
 *
 * Everywhere else in this service, "you may not" is answered with "there is nothing here", because
 * a permission error confirms that a hidden thing exists. Here the recipient is a PUBLIC profile
 * the sender is already looking at — its existence is not a secret, and pretending the person
 * vanished when you press send is a broken product rather than a private one. So the refusal is
 * honest: this voice does not take messages from you.
 *
 * The one case that stays a 404 is a bar. Telling somebody they have been barred is telling them
 * to make another account.
 */
export async function sendWhisper(
  deps: WhisperDeps,
  subject: string,
  toVoiceId: string,
  body: string,
  correlationId?: string,
): Promise<Whisper> {
  const text = normaliseBody(body)
  if (!text) throw new WhisperError('a whisper needs something in it')
  if (text.length > deps.postMaxChars) {
    throw new WhisperError(`a whisper is at most ${deps.postMaxChars} characters`)
  }

  const id = await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const me = await ensureVoice(tx, subject)
    if (me.id === toVoiceId) throw new WhisperError('a voice cannot whisper to itself')
    if (me.suspendedAt) throw new WhisperRefusedError('a suspended voice cannot send whispers')

    const rows = await tx<{ id: string; whispers_from: string; suspended_at: Date | null }[]>`
      select id, whispers_from, suspended_at from voices where id = ${toVoiceId}
    `
    const other = rows[0]
    if (!other) throw new WhisperNotFoundError('no such voice')
    // The bar is checked before the preference, and answers as if the voice were not there.
    if (await barredEitherWay(tx, me.id, other.id)) throw new WhisperNotFoundError('no such voice')

    if (other.whispers_from === 'nobody') {
      throw new WhisperRefusedError('this voice does not accept whispers')
    }
    if (other.whispers_from === 'follows' && !(await followsActive(tx, other.id, me.id))) {
      throw new WhisperRefusedError('this voice accepts whispers only from voices it follows')
    }

    await claim(tx, me.id, 'whisper', deps.whispersPerHour)

    const key = pairKey(me.id, other.id)
    // `on conflict do update` rather than `do nothing`, because `do nothing` returns no row and
    // would need a second SELECT. The update is a no-op touch of `last_post_at`, which the insert
    // below sets again anyway — the point is that this statement always returns the thread id.
    const threadRows = await tx<{ id: string }[]>`
      insert into whisper_threads (pair_key) values (${key})
      on conflict (pair_key) do update set pair_key = excluded.pair_key
      returning id
    `
    const threadId = threadRows[0]!.id

    for (const voiceId of [me.id, other.id]) {
      await tx`
        insert into whisper_members (thread_id, voice_id) values (${threadId}, ${voiceId})
        on conflict (thread_id, voice_id) do update set left_at = null
      `
    }

    const inserted = await tx<{ id: string }[]>`
      insert into whispers (thread_id, voice_id, body) values (${threadId}, ${me.id}, ${text})
      returning id
    `
    await tx`update whisper_threads set last_post_at = now() where id = ${threadId}`
    // The sender has read their own message by definition. Without this, sending sets your own
    // unread count to one.
    await tx`
      update whisper_members set last_read_at = now()
       where thread_id = ${threadId} and voice_id = ${me.id}
    `

    await notify(tx, { voiceId: other.id, kind: 'whisper', actorId: me.id, threadId })

    emit({
      topic: 'agora.whisper.sent',
      key: threadId,
      payload: {
        threadId,
        fromVoiceId: me.id,
        toVoiceId: other.id,
        // The BODY IS NOT IN THE PAYLOAD, and this is the sharpest instance of that rule in the
        // service. An event goes to every subscriber and lands in their inbox table; putting a
        // private message on the bus would copy it into services that have no idea it was private.
        // What crosses is that a message happened, which is all a notifier needs.
        length: text.length,
        // NO SUBJECT EITHER, and that is a departure from every other topic here. The rest name the
        // actor on the payload so a subscriber never has to read the envelope actor; this one does
        // not, because "who messaged, and when" is the metadata of a private conversation and a
        // subscriber that filed it would build a social graph out of events whose whole design is
        // that they carry nothing. `micro-activity` classifies this one as owned by nobody for the
        // same reason.
      },
      actor: subject,
      ...(correlationId ? { correlationId } : {}),
    })

    return inserted[0]!.id
  })

  const whisper = await readWhisper(deps.sql, id)
  if (!whisper) throw new WhisperError('the whisper was sent but could not be read back')
  return whisper
}

async function readWhisper(sql: Db, id: string): Promise<Whisper | null> {
  const rows = await sql<
    {
      id: string
      thread_id: string
      voice_id: string
      handle: string
      display_name: string
      avatar_asset_id: string | null
      body: string
      created_at: Date
      deleted_at: Date | null
    }[]
  >`
    select w.id, w.thread_id, w.voice_id, v.handle, v.display_name, v.avatar_asset_id,
           w.body, w.created_at, w.deleted_at
      from whispers w join voices v on v.id = w.voice_id
     where w.id = ${id}
  `
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    threadId: row.thread_id,
    voiceId: row.voice_id,
    handle: row.handle,
    displayName: row.display_name,
    avatarAssetId: row.avatar_asset_id,
    body: row.deleted_at ? '' : row.body,
    createdAt: row.created_at,
    deleted: row.deleted_at !== null,
  }
}

/* ------------------------------------------------------------------ reading */

/** The conversations this voice is in, most recent first. */
export async function listThreads(
  deps: WhisperDeps,
  viewerId: string,
  limit = 30,
): Promise<readonly Thread[]> {
  const rows = await deps.sql<
    {
      id: string
      created_at: Date
      last_post_at: Date
      other_id: string
      handle: string
      display_name: string
      avatar_asset_id: string | null
      unread: string
      last_body: string | null
    }[]
  >`
    select t.id, t.created_at, t.last_post_at,
           o.voice_id as other_id, v.handle, v.display_name, v.avatar_asset_id,
           (select count(*) from whispers w
             where w.thread_id = t.id and w.voice_id <> ${viewerId}
               and w.created_at > m.last_read_at and w.deleted_at is null) as unread,
           (select w.body from whispers w
             where w.thread_id = t.id and w.deleted_at is null
             order by w.created_at desc limit 1) as last_body
      from whisper_members m
      join whisper_threads t on t.id = m.thread_id
      join whisper_members o on o.thread_id = t.id and o.voice_id <> ${viewerId}
      join voices v on v.id = o.voice_id
     where m.voice_id = ${viewerId} and m.left_at is null
       -- A barred voice's thread disappears from the list in both directions. The rows stay: the
       -- recipient may need the conversation as evidence for the report they are about to file,
       -- and reading one thread directly still serves it to a member who asks for it.
       and not exists(
         select 1 from bars b
          where (b.voice_id = ${viewerId} and b.barred_id = o.voice_id)
             or (b.voice_id = o.voice_id and b.barred_id = ${viewerId}))
     order by t.last_post_at desc
     limit ${Math.min(Math.max(limit, 1), 100)}
  `
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    lastPostAt: r.last_post_at,
    other: {
      voiceId: r.other_id,
      handle: r.handle,
      displayName: r.display_name,
      avatarAssetId: r.avatar_asset_id,
    },
    unread: Number(r.unread),
    // Truncated in the list. A preview is a line, and a thousand-character message rendered into a
    // conversation list is a list with one item in it.
    lastBody: (r.last_body ?? '').slice(0, 140),
  }))
}

/** One conversation. Refuses anybody who is not a member of it. */
export async function readThread(
  deps: WhisperDeps,
  viewerId: string,
  threadId: string,
  options: { readonly limit: number; readonly cursor?: string | null },
): Promise<{ whispers: readonly Whisper[]; nextCursor: string | null }> {
  const member = await deps.sql<{ one: number }[]>`
    select 1 as one from whisper_members where thread_id = ${threadId} and voice_id = ${viewerId}
  `
  if (!member[0]) throw new WhisperNotFoundError()

  const limit = Math.min(Math.max(options.limit, 1), 100)
  const cursor = decodeCursor(options.cursor ?? null)
  const rows = await deps.sql<
    {
      id: string
      thread_id: string
      voice_id: string
      handle: string
      display_name: string
      avatar_asset_id: string | null
      body: string
      created_at: Date
      deleted_at: Date | null
    }[]
  >`
    select w.id, w.thread_id, w.voice_id, v.handle, v.display_name, v.avatar_asset_id,
           w.body, w.created_at, w.deleted_at
      from whispers w join voices v on v.id = w.voice_id
     where w.thread_id = ${threadId}
       ${cursor ? deps.sql`and (w.created_at, w.id) < (${cursor.at}, ${cursor.id})` : deps.sql``}
     order by w.created_at desc, w.id desc
     limit ${limit + 1}
  `

  const slice = rows.slice(0, limit)
  const last = slice[slice.length - 1]
  return {
    whispers: slice.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      voiceId: row.voice_id,
      handle: row.handle,
      displayName: row.display_name,
      avatarAssetId: row.avatar_asset_id,
      body: row.deleted_at ? '' : row.body,
      createdAt: row.created_at,
      deleted: row.deleted_at !== null,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  }
}

/** Mark a conversation read up to now. Idempotent, and never moves the mark backwards. */
export async function markRead(deps: WhisperDeps, viewerId: string, threadId: string): Promise<void> {
  await deps.sql`
    update whisper_members set last_read_at = now()
     where thread_id = ${threadId} and voice_id = ${viewerId}
  `
}

/**
 * Leave a conversation.
 *
 * Per-member, so one side leaving does not delete the other side's copy — deleting theirs would be
 * one person erasing another's record of what was said. The thread reopens for the leaver on the
 * next message rather than being lost.
 */
export async function leaveThread(
  deps: WhisperDeps,
  viewerId: string,
  threadId: string,
): Promise<boolean> {
  const rows = await deps.sql<{ thread_id: string }[]>`
    update whisper_members set left_at = now()
     where thread_id = ${threadId} and voice_id = ${viewerId} and left_at is null
    returning thread_id
  `
  return rows.length > 0
}

/**
 * Delete one whisper you sent.
 *
 * Soft, and the body is blanked, for the same reason a post is: the row anchors the position of
 * everything around it. What it must not do is remove the message from the RECIPIENT's view
 * silently — the row remains, marked deleted, and the client renders "this message was deleted".
 * A message that vanishes without trace is a gaslighting primitive.
 */
export async function deleteWhisper(
  deps: WhisperDeps,
  subject: string,
  whisperId: string,
): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    const rows = await tx<{ id: string }[]>`
      update whispers set body = '', deleted_at = now()
       where id = ${whisperId} and voice_id = ${me.id} and deleted_at is null
      returning id
    `
    return rows.length > 0
  })
}

/** The unread count across every conversation. What the header badge reads. */
export async function unreadCount(sql: Db | Tx, viewerId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*) as count
      from whisper_members m
      join whispers w on w.thread_id = m.thread_id
     where m.voice_id = ${viewerId} and m.left_at is null
       and w.voice_id <> ${viewerId} and w.created_at > m.last_read_at
       and w.deleted_at is null
  `
  return Number(rows[0]?.count ?? 0)
}
