/**
 * Notifications, and the email preferences that decide whether any of them leave the building.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **NO EMAIL WITHOUT A PER-KIND OPT-IN THAT DEFAULTS OFF.**
 *
 * Doc 41 §4's third load-bearing rule, and the one that is easiest to erode later. `email_prefs`
 * has five boolean columns and every one is `not null default false`. A voice with NO ROW gets no
 * mail at all — `prefsFor` returns all-false for the absence rather than inserting a row with a
 * guess in it, because the moment this service writes a default it has taken a decision to mail
 * somebody who never asked, and that decision is not recoverable after the send.
 *
 * The pressure to change this is real and it always arrives in the same shape: "engagement is low,
 * people do not come back, let us mail them when somebody replies". The answer is that a square
 * people return to because they want to is smaller and better than one that people return to
 * because it interrupts them, and that a product which mails you by default is a product you
 * eventually mark as spam.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## AND WHY THERE IS NO NOTIFY CLIENT IN THIS SERVICE
 *
 * The obvious build is an `HttpClient` pointed at micro-notify. This service does not have one.
 * Opted-in mail is delivered by EMITTING an outbox event (`agora.notification.mail_requested`)
 * that notify consumes off the bus — the estate's actual pattern for exactly this. Three consequences,
 * all good: this service has one upstream instead of two; a notify outage delays mail rather than
 * failing a reply; and the delivery record lives in notify, where the operator already looks.
 */

import { withOutbox, type Db, type Tx } from './outbox.ts'
import { decodeCursor, encodeCursor, ensureVoice } from './voices.ts'

export interface NotificationDeps {
  readonly sql: Db
  readonly producer: string
  readonly notificationTtlDays: number
  /**
   * The browser-facing origin of this surface, or `''` when the deployment has not been told.
   *
   * Read by `sweepEmail` and nowhere else. See `Env.publicUrl` for why the producer is the party
   * that has to say it, and for what an empty value deliberately does.
   */
  readonly publicUrl: string
}

export type NotificationKind =
  | 'reply'
  | 'quote'
  | 'echo'
  | 'spark'
  | 'mention'
  | 'follow'
  | 'follow_request'
  | 'follow_accepted'
  | 'whisper'
  | 'circle_invite'
  | 'circle_request'
  | 'circle_accepted'
  | 'moderation'

export interface Notification {
  readonly id: string
  readonly kind: NotificationKind
  readonly actor: {
    readonly voiceId: string
    readonly handle: string
    readonly displayName: string
    readonly avatarAssetId: string | null
  } | null
  readonly postId: string | null
  readonly circleId: string | null
  readonly threadId: string | null
  readonly detail: string
  readonly readAt: Date | null
  readonly createdAt: Date
}

export interface EmailPrefs {
  readonly onReply: boolean
  readonly onMention: boolean
  readonly onFollow: boolean
  readonly onWhisper: boolean
  readonly onModeration: boolean
}

/** Every field false. The answer for a voice with no row, and the shape a new voice starts in. */
export const NO_EMAIL: EmailPrefs = Object.freeze({
  onReply: false,
  onMention: false,
  onFollow: false,
  onWhisper: false,
  onModeration: false,
})

/* ------------------------------------------------------------------ reading */

export async function listNotifications(
  deps: NotificationDeps,
  viewerId: string,
  options: { readonly limit: number; readonly cursor?: string | null; readonly unreadOnly?: boolean },
): Promise<{ notifications: readonly Notification[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit, 1), 100)
  const cursor = decodeCursor(options.cursor ?? null)
  const { sql } = deps

  const rows = await sql<
    {
      id: string
      kind: string
      actor_id: string | null
      handle: string | null
      display_name: string | null
      avatar_asset_id: string | null
      post_id: string | null
      circle_id: string | null
      thread_id: string | null
      detail: string
      read_at: Date | null
      created_at: Date
    }[]
  >`
    select n.id, n.kind, n.actor_id, v.handle, v.display_name, v.avatar_asset_id,
           n.post_id, n.circle_id, n.thread_id, n.detail, n.read_at, n.created_at
      from notifications n
      left join voices v on v.id = n.actor_id
     where n.voice_id = ${viewerId}
       ${options.unreadOnly ? sql`and n.read_at is null` : sql``}
       -- A bar hides the notifications the barred voice caused, in both directions, without
       -- deleting them: unbarring restores the history rather than losing it. A hush does NOT —
       -- a hush is about a timeline, and somebody you have quietly muted replying to you directly
       -- is still something you asked to be told about.
       and (n.actor_id is null or not exists(
             select 1 from bars b
              where (b.voice_id = ${viewerId} and b.barred_id = n.actor_id)
                 or (b.voice_id = n.actor_id and b.barred_id = ${viewerId})))
       ${cursor ? sql`and (n.created_at, n.id) < (${cursor.at}, ${cursor.id})` : sql``}
     order by n.created_at desc, n.id desc
     limit ${limit + 1}
  `

  const slice = rows.slice(0, limit)
  const last = slice[slice.length - 1]
  return {
    notifications: slice.map((row) => ({
      id: row.id,
      kind: row.kind as NotificationKind,
      actor: row.actor_id
        ? {
            voiceId: row.actor_id,
            handle: row.handle ?? '',
            displayName: row.display_name ?? '',
            avatarAssetId: row.avatar_asset_id,
          }
        : null,
      postId: row.post_id,
      circleId: row.circle_id,
      threadId: row.thread_id,
      detail: row.detail,
      readAt: row.read_at,
      createdAt: row.created_at,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  }
}

/** How many unread. What the header badge reads, and the only count in this service that is hot. */
export async function unreadCount(sql: Db | Tx, viewerId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*) as count from notifications
     where voice_id = ${viewerId} and read_at is null
  `
  return Number(rows[0]?.count ?? 0)
}

/** Mark one, or all, as read. */
export async function markRead(
  deps: NotificationDeps,
  viewerId: string,
  notificationId: string | null,
): Promise<number> {
  const rows = notificationId
    ? await deps.sql<{ id: string }[]>`
        update notifications set read_at = now()
         where voice_id = ${viewerId} and id = ${notificationId} and read_at is null
        returning id
      `
    : await deps.sql<{ id: string }[]>`
        update notifications set read_at = now()
         where voice_id = ${viewerId} and read_at is null
        returning id
      `
  return rows.length
}

/* ------------------------------------------------------------------ email preferences */

/**
 * This voice's preferences.
 *
 * The absence of a row is all-false, and is NOT written back. See the header: a service that
 * materialises a default has taken a decision on somebody's behalf about being mailed, and the
 * only safe default to take on somebody's behalf is none.
 */
export async function prefsFor(sql: Db | Tx, voiceId: string): Promise<EmailPrefs> {
  const rows = await sql<
    {
      on_reply: boolean
      on_mention: boolean
      on_follow: boolean
      on_whisper: boolean
      on_moderation: boolean
    }[]
  >`
    select on_reply, on_mention, on_follow, on_whisper, on_moderation
      from email_prefs where voice_id = ${voiceId}
  `
  const row = rows[0]
  if (!row) return NO_EMAIL
  return {
    onReply: row.on_reply,
    onMention: row.on_mention,
    onFollow: row.on_follow,
    onWhisper: row.on_whisper,
    onModeration: row.on_moderation,
  }
}

export async function setPrefs(
  deps: NotificationDeps,
  subject: string,
  input: Partial<EmailPrefs>,
): Promise<EmailPrefs> {
  return withOutbox(deps.sql, deps.producer, async (tx) => {
    const me = await ensureVoice(tx, subject)
    const current = await prefsFor(tx, me.id)
    const next: EmailPrefs = {
      onReply: input.onReply ?? current.onReply,
      onMention: input.onMention ?? current.onMention,
      onFollow: input.onFollow ?? current.onFollow,
      onWhisper: input.onWhisper ?? current.onWhisper,
      onModeration: input.onModeration ?? current.onModeration,
    }
    await tx`
      insert into email_prefs (voice_id, on_reply, on_mention, on_follow, on_whisper, on_moderation)
      values (${me.id}, ${next.onReply}, ${next.onMention}, ${next.onFollow}, ${next.onWhisper},
              ${next.onModeration})
      on conflict (voice_id) do update set
        on_reply = excluded.on_reply,
        on_mention = excluded.on_mention,
        on_follow = excluded.on_follow,
        on_whisper = excluded.on_whisper,
        on_moderation = excluded.on_moderation,
        updated_at = now()
    `
    return next
  })
}

/** Which preference column a notification kind reads. `null` means this kind is never mailed. */
function prefFor(kind: NotificationKind): keyof EmailPrefs | null {
  switch (kind) {
    case 'reply':
    case 'quote':
      return 'onReply'
    case 'mention':
      return 'onMention'
    case 'follow':
    case 'follow_request':
    case 'follow_accepted':
      return 'onFollow'
    case 'whisper':
      return 'onWhisper'
    case 'moderation':
      return 'onModeration'
    // A spark or an echo is never mailed, and there is no preference to turn it on. A like is the
    // lowest-value notification a network has and mailing it is what trains somebody to filter
    // every message from a product into a folder they never open.
    default:
      return null
  }
}

/* ------------------------------------------------------------------ the mail sweep */

export interface EmailSweepResult {
  readonly considered: number
  readonly emitted: number
}

/**
 * Emit one `agora.notification.mail_requested` event per opted-in, still-unread notification.
 *
 * Run on a schedule rather than at the moment the notification is written, and the delay is the
 * feature: somebody who replies four times in a minute produces one mail, and somebody who reads
 * the notification in the app before the sweep runs produces none. Mailing at write time would
 * make a thread of six replies six emails, which is how a product teaches people to mute it.
 *
 * `notified_at` is not a column — the sweep is bounded by the window instead, and the outbox
 * relay's own dedupe (one row per event id, consumed effectively-once through the inbox) is what
 * stops a redelivery becoming a second send. A voice who has read the notification is skipped, so
 * the steady state after a sweep is that only genuinely unseen things were mailed.
 */
export async function sweepEmail(
  deps: NotificationDeps,
  windowMinutes = 15,
): Promise<EmailSweepResult> {
  const since = new Date(Date.now() - windowMinutes * 60_000)
  const until = new Date(Date.now() - 60_000)

  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const rows = await tx<
      {
        id: string
        voice_id: string
        subject: string
        kind: string
        detail: string
        post_id: string | null
        actor_handle: string | null
        on_reply: boolean
        on_mention: boolean
        on_follow: boolean
        on_whisper: boolean
        on_moderation: boolean
      }[]
    >`
      select n.id, n.voice_id, v.subject, n.kind, n.detail, n.post_id,
             a.handle as actor_handle,
             p.on_reply, p.on_mention, p.on_follow, p.on_whisper, p.on_moderation
        from notifications n
        join voices v on v.id = n.voice_id
        -- An INNER join on email_prefs, deliberately. A voice with no preferences row is a voice
        -- that has never opted in to anything, and the join removing it is the schema enforcing
        -- the rule rather than a filter somebody could drop.
        join email_prefs p on p.voice_id = n.voice_id
        left join voices a on a.id = n.actor_id
       where n.read_at is null
         and n.created_at >= ${since} and n.created_at < ${until}
       order by n.created_at asc
       limit 500
    `

    let emitted = 0
    for (const row of rows) {
      const kind = row.kind as NotificationKind
      const pref = prefFor(kind)
      if (!pref) continue
      const prefs: EmailPrefs = {
        onReply: row.on_reply,
        onMention: row.on_mention,
        onFollow: row.on_follow,
        onWhisper: row.on_whisper,
        onModeration: row.on_moderation,
      }
      if (!prefs[pref]) continue

      emit({
        topic: 'agora.notification.mail_requested',
        key: row.id,
        payload: {
          notificationId: row.id,
          // The SUBJECT, not an email address. This service has never held one and must not start:
          // identity is the system of record for how to reach somebody, and a copy here would be a
          // copy that goes stale the day they change it.
          subject: row.subject,
          kind,
          actorHandle: row.actor_handle ?? '',
          postId: row.post_id,
          // No body, no post text. What crosses is enough to build a link and a subject line;
          // notify fetches nothing back, so a followers-only post's words never reach a mail
          // server.
          detail: row.detail.slice(0, 200),
          // An ABSOLUTE url, or the key is absent entirely.
          //
          // notify builds every link against its own base — the hub — and the hub has no route
          // into the square, so a relative path would produce a mail whose one button 404s. Only
          // this service knows its own origin, so only this service can answer it. When the
          // deployment has not been told, the key is omitted rather than sent empty: notify then
          // falls back to the reader's notification centre, which is a page that exists, and a
          // missing key is a state a consumer can branch on where `''` is one it has to guess at.
          //
          // It points at the POST when there is one and at the notification list otherwise — a
          // follow and a suspension have nothing to open.
          ...(deps.publicUrl
            ? { url: row.post_id ? `${deps.publicUrl}/p/${row.post_id}` : `${deps.publicUrl}/notifications` }
            : {}),
        },
        actor: row.subject,
      })
      emitted += 1
    }

    return { considered: rows.length, emitted }
  })
}

/**
 * Delete notifications older than the retention window.
 *
 * A notification is a pointer to something that happened, and the thing it points at is still
 * there. Keeping the pointer for ever costs a table that only grows and gives an operator a
 * behavioural record of who interacted with whom, indefinitely, for no product reason.
 */
export async function sweepOld(deps: NotificationDeps): Promise<number> {
  const cutoff = new Date(Date.now() - deps.notificationTtlDays * 86_400_000)
  const rows = await deps.sql<{ id: string }[]>`
    delete from notifications where created_at < ${cutoff} returning id
  `
  return rows.length
}
