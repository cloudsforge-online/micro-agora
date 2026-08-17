/**
 * Posts, threads, and the timelines that read them.
 *
 * This is the module the square is for. A post is created in ONE transaction that also claims the
 * rate bucket, parses and stores tags and mentions, writes the notification rows, bumps the parent's
 * counters and emits the outbox event. Any one of those failing rolls back all of them, which is
 * the property that keeps `reply_count` honest and a mention from being notified twice.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## REVERSE-CHRONOLOGICAL ONLY. THERE IS NO RANKING FUNCTION IN THIS FILE AND THERE MUST NOT BE.
 *
 * Doc 41 §4's first load-bearing rule. Every timeline here ends in
 * `order by created_at desc, id desc` and takes a keyset cursor. Nothing scores a post; nothing
 * boosts one; `spark_count` is stored because a post shows its own count, and it is never in an
 * `order by`.
 *
 * The rule is not aesthetic. A ranked feed needs an objective, the only objective a small team can
 * actually measure is engagement, and optimising a crypto discussion square for engagement selects
 * for exactly the posts this estate should not amplify: the confident prediction, the outrage, the
 * screenshot of a portfolio. Reverse-chronological has no objective, so it cannot be optimised, so
 * there is nothing to game. The cost — a quiet timeline stays quiet — is the intended behaviour.
 *
 * If a future change adds ranking, it changes this rule, and it must change doc 41 first.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## AND ONE READ PATH DECIDES VISIBILITY FOR ALL OF THEM
 *
 * `visibilityPredicate` is the single fragment every timeline query composes, and every query in
 * this file uses it. Writing the audience test once and reusing it is the difference between a
 * followers-only post being private and being private on the four timelines somebody remembered.
 * The one that gets forgotten is always the tag page.
 */

import { withOutbox, type Db, type Emit, type Tx } from './outbox.ts'
import { MAX_MENTIONS_PER_POST, mentionsIn, normaliseBody, tagsIn } from './text.ts'
import { claim } from './ratelimit.ts'
import {
  decodeCursor,
  encodeCursor,
  ensureVoice,
  findVoice,
  notify,
  VoiceError,
  VoiceStateError,
} from './voices.ts'
import { fileSystemReport } from './moderation.ts'
import type { PolicyClient, PolicyVerdict } from './policyclient.ts'

export class PostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PostError'
  }
}

/** The post exists but this viewer may not see it — or it does not exist. Deliberately one error. */
export class PostNotFoundError extends Error {
  constructor(message = 'no such post') {
    super(message)
    this.name = 'PostNotFoundError'
  }
}

/** Policy said deny. Maps to 403, and it is the only thing in this file that does. */
export class PostRefusedError extends Error {
  readonly reasons: readonly string[]
  constructor(reasons: readonly string[]) {
    super('this post was refused')
    this.name = 'PostRefusedError'
    this.reasons = reasons
  }
}

export type Visibility = 'public' | 'followers' | 'circle'

export interface MediaInput {
  readonly assetId: string
  readonly alt: string
  readonly kind?: 'image' | 'video' | 'audio'
}

export interface Media {
  readonly id: string
  readonly assetId: string
  readonly alt: string
  readonly kind: string
  readonly ordinal: number
}

export interface Post {
  readonly id: string
  readonly voiceId: string
  readonly handle: string
  readonly displayName: string
  readonly avatarAssetId: string | null
  readonly body: string
  readonly lang: string
  readonly inReplyToId: string | null
  readonly rootId: string | null
  readonly quoteOfId: string | null
  readonly circleId: string | null
  readonly visibility: Visibility
  readonly sensitive: boolean
  readonly contentWarning: string
  readonly replyCount: number
  readonly echoCount: number
  readonly sparkCount: number
  readonly quoteCount: number
  readonly editedAt: Date | null
  readonly createdAt: Date
  readonly deleted: boolean
  readonly media: readonly Media[]
  readonly tags: readonly string[]
  /** Present only when the reader is authenticated. Their own relationship to this post. */
  readonly viewer?: {
    readonly sparked: boolean
    readonly echoed: boolean
    readonly bookmarked: boolean
    readonly mine: boolean
  }
}

interface PostRow {
  readonly id: string
  readonly voice_id: string
  readonly handle: string
  readonly display_name: string
  readonly avatar_asset_id: string | null
  readonly body: string
  readonly lang: string
  readonly in_reply_to_id: string | null
  readonly root_id: string | null
  readonly quote_of_id: string | null
  readonly circle_id: string | null
  readonly visibility: string
  readonly sensitive: boolean
  readonly content_warning: string
  readonly reply_count: number
  readonly echo_count: number
  readonly spark_count: number
  readonly quote_count: number
  readonly edited_at: Date | null
  readonly created_at: Date
  readonly deleted_at: Date | null
}

/**
 * The columns every timeline selects, joined to the author.
 *
 * Written once and interpolated with `sql.unsafe` because postgres.js has no fragment type for a
 * bare column list. It is a CONSTANT — no caller-supplied string ever reaches it — so there is no
 * injection surface here, and the alternative (repeating twenty column names in nine queries) is
 * how a timeline ends up returning a column the others do not.
 */
const POST_COLUMNS = `
  p.id, p.voice_id, v.handle, v.display_name, v.avatar_asset_id,
  p.body, p.lang, p.in_reply_to_id, p.root_id, p.quote_of_id, p.circle_id,
  p.visibility, p.sensitive, p.content_warning,
  p.reply_count, p.echo_count, p.spark_count, p.quote_count,
  p.edited_at, p.created_at, p.deleted_at
`

function toPost(row: PostRow, media: readonly Media[], tags: readonly string[]): Post {
  const deleted = row.deleted_at !== null
  return {
    id: row.id,
    voiceId: row.voice_id,
    handle: row.handle,
    displayName: row.display_name,
    avatarAssetId: row.avatar_asset_id,
    // A deleted post keeps its row so the thread around it survives, but it must not keep its
    // words. The delete blanks the column; this is the second belt, for a row written before that
    // was true.
    body: deleted ? '' : row.body,
    lang: row.lang,
    inReplyToId: row.in_reply_to_id,
    rootId: row.root_id,
    quoteOfId: row.quote_of_id,
    circleId: row.circle_id,
    visibility: row.visibility as Visibility,
    sensitive: row.sensitive,
    contentWarning: deleted ? '' : row.content_warning,
    replyCount: row.reply_count,
    echoCount: row.echo_count,
    sparkCount: row.spark_count,
    quoteCount: row.quote_count,
    editedAt: row.edited_at,
    createdAt: row.created_at,
    deleted,
    media: deleted ? [] : media,
    tags: deleted ? [] : tags,
  }
}

export interface PostDeps {
  readonly sql: Db
  readonly producer: string
  readonly policy: PolicyClient
  readonly postsPerHour: number
  readonly postMaxChars: number
  readonly pageSizeMax: number
  readonly postingEnabled: boolean
}

/* ------------------------------------------------------------------ visibility */

/**
 * The audience test, as one SQL fragment.
 *
 * `viewerId` is the reading voice, or null for a logged-out reader. The four clauses, in the order
 * a reader meets them:
 *
 *   1. A public post is public.
 *   2. Your own posts are yours, whatever their visibility.
 *   3. A followers-only post needs an ACTIVE follow — pending is not a follow.
 *   4. A circle post needs active membership of that circle.
 *
 * And then, outside all four, the bar: a post by anybody who has barred the viewer, or whom the
 * viewer has barred, is not returned at all. Symmetric, because doc 41 §4 says so and because a
 * one-directional read is half a bar with all of the false confidence.
 *
 * ── WHY THIS IS A FUNCTION AND NOT FOUR LINES IN EACH QUERY ───────────────────────────────────
 *
 * Because there are nine timeline queries in this file and the tag page is always the one somebody
 * forgets. A followers-only post that leaks onto a tag timeline is not a bug a user reports — they
 * never see it happen — it is a bug the person whose post it was finds out about from a stranger.
 */
function visibilityPredicate(sql: Db | Tx, viewerId: string | null) {
  if (!viewerId) {
    return sql`p.visibility = 'public' and vo.suspended_at is null`
  }
  return sql`
    (
      p.visibility = 'public'
      or p.voice_id = ${viewerId}
      or (p.visibility = 'followers' and exists(
            select 1 from follows f
             where f.follower_id = ${viewerId} and f.followee_id = p.voice_id
               and f.state = 'active'))
      or (p.visibility = 'circle' and exists(
            select 1 from circle_members cm
             where cm.circle_id = p.circle_id and cm.voice_id = ${viewerId}
               and cm.state = 'active'))
    )
    and (vo.suspended_at is null or p.voice_id = ${viewerId})
    and not exists(
      select 1 from bars b
       where (b.voice_id = ${viewerId} and b.barred_id = p.voice_id)
          or (b.voice_id = p.voice_id and b.barred_id = ${viewerId})
    )
  `
}

/** Hushes, which are the viewer's own quiet and never apply to their own posts or to a thread. */
function hushPredicate(sql: Db | Tx, viewerId: string | null) {
  if (!viewerId) return sql``
  return sql`
    and not exists(
      select 1 from hushes h
       where h.voice_id = ${viewerId} and h.hushed_id = p.voice_id
         and (h.expires_at is null or h.expires_at > now()))
    and not exists(
      select 1 from tag_hushes th
        join post_tags pt on pt.tag = th.tag
       where th.voice_id = ${viewerId} and pt.post_id = p.id
         and (th.expires_at is null or th.expires_at > now()))
  `
}

/* ------------------------------------------------------------------ creating */

export interface CreatePostInput {
  readonly body: string
  readonly lang?: string
  readonly inReplyToId?: string | null
  readonly quoteOfId?: string | null
  readonly circleId?: string | null
  readonly visibility?: Visibility
  readonly sensitive?: boolean
  readonly contentWarning?: string
  readonly media?: readonly MediaInput[]
  readonly idempotencyKey?: string | null
}

export interface CreatePostResult {
  readonly post: Post
  readonly policy: PolicyVerdict
  /** False when the idempotency key matched an existing post and nothing was written. */
  readonly created: boolean
}

/**
 * Publish a post, a reply or a quote.
 *
 * The policy call happens BEFORE the transaction opens, on purpose. An HTTP call inside a database
 * transaction holds a connection open for the peer's whole deadline — five seconds by default —
 * and under any load at all that is how a service exhausts its pool and stops answering reads it
 * could have served. The cost of deciding first is that a denied post consumes no rate bucket,
 * which is the right way round anyway: the limit is there to stop a flood of published posts.
 */
export async function createPost(
  deps: PostDeps,
  subject: string,
  input: CreatePostInput,
  correlationId?: string,
): Promise<CreatePostResult> {
  if (!deps.postingEnabled) {
    // The break-glass switch. Set when the square has to be frozen — a spam wave, a migration —
    // and it is a 503 rather than a 403 because it is temporary and about us, not about them.
    throw new PostRefusedError(['posting_disabled'])
  }

  const body = normaliseBody(input.body)
  const media = input.media ?? []
  if (!body && media.length === 0) {
    throw new PostError('a post needs words, a picture, or both')
  }
  if (body.length > deps.postMaxChars) {
    throw new PostError(`a post is at most ${deps.postMaxChars} characters`)
  }
  if (media.length > 4) throw new PostError('at most four attachments')
  for (const item of media) {
    // Checked here as well as by `post_media_alt_required`, because the constraint would answer a
    // 23514 that the route would have to translate, and the message somebody deserves for this is
    // the specific one. The CHECK stays: it is what makes the rule true for every future writer.
    if (!item.alt || !item.alt.trim()) {
      throw new PostError(
        'every attachment needs a description — somebody using a screen reader is reading this too',
      )
    }
    if (!item.assetId.trim()) throw new PostError('an attachment needs an asset')
  }

  const visibility: Visibility = input.visibility ?? (input.circleId ? 'circle' : 'public')
  if (visibility === 'circle' && !input.circleId) {
    throw new PostError('a circle post needs a circle')
  }
  if (visibility !== 'circle' && input.circleId) {
    throw new PostError('only a circle post may name a circle')
  }
  if (input.contentWarning && input.contentWarning.length > 200) {
    throw new PostError('a content warning is at most 200 characters')
  }
  if (input.inReplyToId && input.quoteOfId) {
    throw new PostError('a post is a reply or a quote, not both')
  }

  const kind = input.inReplyToId ? 'reply' : input.quoteOfId ? 'quote' : 'post'

  // The voice is created (or found) in its own short transaction, so the policy call below has a
  // subject and an age to send and the long transaction that follows opens already knowing them.
  const author = await withOutbox(deps.sql, deps.producer, async (tx) => ensureVoice(tx, subject))
  if (author.suspendedAt) {
    throw new PostRefusedError(['voice_suspended'])
  }

  // The idempotency short-circuit, before policy: a retry of a post that already exists must not
  // spend a second policy decision, and must not be able to be denied when the first was allowed.
  if (input.idempotencyKey) {
    const existing = await deps.sql<{ id: string }[]>`
      select id from posts
       where voice_id = ${author.id} and idempotency_key = ${input.idempotencyKey}
    `
    if (existing[0]) {
      const post = await readPost(deps.sql, existing[0].id, author.id)
      if (post) {
        return { post, policy: { decision: 'allow', reasons: ['idempotent_replay'], degraded: false }, created: false }
      }
    }
  }

  const dayOld = Date.now() - author.createdAt.getTime() < 86_400_000
  const verdict = await deps.policy.evaluatePost({
    authorSubject: subject,
    // A URN with a placeholder id: the post does not exist yet, and inventing one here would put a
    // uuid in policy's decision record that never appears in this database.
    postUrn: `urn:cloudsforge:agora:post:pending:${author.id}`,
    kind,
    visibility,
    bodyLength: body.length,
    mediaCount: media.length,
    tags: tagsIn(body),
    newAccount: dayOld,
  })
  if (verdict.decision === 'deny') throw new PostRefusedError(verdict.reasons)

  const result = await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    await claim(tx, author.id, 'post', deps.postsPerHour)

    let rootId: string | null = null
    let parentVoiceId: string | null = null
    if (input.inReplyToId) {
      const parent = await tx<{ id: string; voice_id: string; root_id: string | null; visibility: string; circle_id: string | null }[]>`
        select id, voice_id, root_id, visibility, circle_id from posts
         where id = ${input.inReplyToId} and deleted_at is null
         for update
      `
      const row = parent[0]
      if (!row) throw new PostNotFoundError('the post you are replying to is not there')
      if (await barred(tx, author.id, row.voice_id)) throw new PostNotFoundError()
      // A reply inherits the thread's root, and its audience: replying to a followers-only post
      // with a public reply would publish the fact of the conversation to people who cannot read
      // half of it, and quoting the parent back into the reply is how the content leaks next.
      rootId = row.root_id ?? row.id
      parentVoiceId = row.voice_id
      if (row.visibility !== 'public' && visibility === 'public') {
        throw new PostError('a reply cannot be more public than the post it answers')
      }
    }

    let quotedVoiceId: string | null = null
    if (input.quoteOfId) {
      const quoted = await tx<{ id: string; voice_id: string; visibility: string }[]>`
        select id, voice_id, visibility from posts
         where id = ${input.quoteOfId} and deleted_at is null
         for update
      `
      const row = quoted[0]
      if (!row) throw new PostNotFoundError('the post you are quoting is not there')
      if (row.visibility !== 'public') {
        // Quoting is republishing. A followers-only post quoted into a public one is that post
        // made public by somebody who was trusted with it, and no consent anywhere was asked.
        throw new PostError('only a public post can be quoted')
      }
      if (await barred(tx, author.id, row.voice_id)) throw new PostNotFoundError()
      quotedVoiceId = row.voice_id
    }

    if (visibility === 'circle' && input.circleId) {
      const member = await tx<{ one: number }[]>`
        select 1 as one from circle_members
         where circle_id = ${input.circleId} and voice_id = ${author.id} and state = 'active'
      `
      if (!member[0]) throw new PostNotFoundError('no such circle')
    }

    const inserted = await tx<{ id: string; created_at: Date }[]>`
      insert into posts (
        voice_id, body, lang, in_reply_to_id, root_id, quote_of_id, circle_id,
        visibility, sensitive, content_warning, moderation_degraded, idempotency_key
      ) values (
        ${author.id}, ${body}, ${(input.lang ?? '').slice(0, 20)}, ${input.inReplyToId ?? null},
        ${rootId}, ${input.quoteOfId ?? null}, ${input.circleId ?? null},
        ${visibility}, ${input.sensitive ?? false}, ${(input.contentWarning ?? '').slice(0, 200)},
        ${verdict.degraded}, ${input.idempotencyKey ?? null}
      )
      returning id, created_at
    `
    const postId = inserted[0]!.id

    for (const [ordinal, item] of media.entries()) {
      await tx`
        insert into post_media (post_id, asset_id, alt, kind, ordinal)
        values (${postId}, ${item.assetId}, ${item.alt.trim()}, ${item.kind ?? 'image'}, ${ordinal})
      `
    }

    const tags = tagsIn(body)
    for (const tag of tags) {
      await tx`insert into post_tags (post_id, tag) values (${postId}, ${tag}) on conflict do nothing`
    }

    const mentioned = await resolveMentions(tx, body, author.id)
    for (const voiceId of mentioned) {
      await tx`
        insert into post_mentions (post_id, voice_id) values (${postId}, ${voiceId})
        on conflict do nothing
      `
      await notify(tx, { voiceId, kind: 'mention', actorId: author.id, postId })
    }

    if (input.inReplyToId && parentVoiceId) {
      await tx`update posts set reply_count = reply_count + 1 where id = ${input.inReplyToId}`
      await notify(tx, { voiceId: parentVoiceId, kind: 'reply', actorId: author.id, postId })
    }
    if (input.quoteOfId && quotedVoiceId) {
      await tx`update posts set quote_count = quote_count + 1 where id = ${input.quoteOfId}`
      await notify(tx, { voiceId: quotedVoiceId, kind: 'quote', actorId: author.id, postId })
    }

    // The policy gate's evidence. A post that went up while policy was unreachable opens a report
    // with no reporter, so the queue can be filtered by "the gate was not there" — the whole point
    // of `policyclient.ts`'s header. `review` from a REACHABLE policy opens one too.
    if (verdict.degraded || verdict.decision === 'review') {
      await fileSystemReport(
        tx,
        'post',
        postId,
        'other',
        verdict.degraded
          ? 'published while the policy gate was unreachable'
          : `policy: ${verdict.reasons.join(', ')}`,
      )
    }

    emit({
      topic: 'agora.post.created',
      key: postId,
      payload: {
        postId,
        voiceId: author.id,
        handle: author.handle,
        subject,
        kind,
        visibility,
        tags: [...tags],
        mentions: mentioned.length,
        hasMedia: media.length > 0,
        // The body is NOT in the payload. An event is delivered to every subscriber and stored in
        // their inbox; putting a followers-only post's words on the bus would publish it to
        // services with no concept of who was allowed to read it.
      },
      actor: subject,
      ...(correlationId ? { correlationId } : {}),
    })

    return postId
  })

  const post = await readPost(deps.sql, result, author.id)
  if (!post) throw new PostError('the post was written but could not be read back')
  return { post, policy: verdict, created: true }
}

async function barred(tx: Tx, a: string, b: string): Promise<boolean> {
  if (a === b) return false
  const rows = await tx<{ one: number }[]>`
    select 1 as one from bars
     where (voice_id = ${a} and barred_id = ${b}) or (voice_id = ${b} and barred_id = ${a})
     limit 1
  `
  return rows.length > 0
}

/**
 * Handles in a body, turned into voice ids.
 *
 * A handle that matches nobody is dropped silently rather than raising: `@somebody` in a sentence
 * is ordinary writing, and refusing the post because a word began with an at sign would be the
 * service enforcing a grammar. Somebody who has barred the author is dropped too — a mention is a
 * notification, and a bar is a promise that none arrive.
 */
async function resolveMentions(tx: Tx, body: string, authorId: string): Promise<readonly string[]> {
  const handles = mentionsIn(body)
  if (handles.length === 0) return []
  const rows = await tx<{ id: string }[]>`
    select v.id from voices v
     where v.handle in ${tx(handles as string[])}
       and v.id <> ${authorId}
       and not exists(
         select 1 from bars b
          where (b.voice_id = v.id and b.barred_id = ${authorId})
             or (b.voice_id = ${authorId} and b.barred_id = v.id))
     limit ${MAX_MENTIONS_PER_POST}
  `
  return rows.map((r) => r.id)
}

/* ------------------------------------------------------------------ editing and deleting */

export async function editPost(
  deps: PostDeps,
  subject: string,
  postId: string,
  input: { body: string; contentWarning?: string; sensitive?: boolean },
  correlationId?: string,
): Promise<Post> {
  const body = normaliseBody(input.body)
  if (!body) throw new PostError('an edit cannot empty a post; delete it instead')
  if (body.length > deps.postMaxChars) {
    throw new PostError(`a post is at most ${deps.postMaxChars} characters`)
  }

  const id = await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const author = await ensureVoice(tx, subject)
    const rows = await tx<{ id: string }[]>`
      update posts set
        body = ${body},
        content_warning = ${(input.contentWarning ?? '').slice(0, 200)},
        sensitive = ${input.sensitive ?? false},
        edited_at = now()
      where id = ${postId} and voice_id = ${author.id} and deleted_at is null
      returning id
    `
    // 404 rather than 403 for a post somebody else wrote. A 403 confirms the post exists and is
    // not yours, which is an oracle: it tells a stranger which of two ids is real.
    if (!rows[0]) throw new PostNotFoundError()

    // The re-parse, in the same transaction as the edit. This is why `text.ts` stores rather than
    // derives: an edit either moves the post between tag timelines and notifies the newly
    // mentioned, or it does neither, and there is no state where it half-did.
    await tx`delete from post_tags where post_id = ${postId}`
    for (const tag of tagsIn(body)) {
      await tx`insert into post_tags (post_id, tag) values (${postId}, ${tag}) on conflict do nothing`
    }

    // Mentions are ADDED but never removed, and nothing is re-notified. Removing one would silently
    // revoke a notification somebody has already read, and re-notifying on every edit would make a
    // typo fix a way to ping somebody repeatedly.
    for (const voiceId of await resolveMentions(tx, body, author.id)) {
      const inserted = await tx<{ post_id: string }[]>`
        insert into post_mentions (post_id, voice_id) values (${postId}, ${voiceId})
        on conflict do nothing
        returning post_id
      `
      if (inserted[0]) {
        await notify(tx, { voiceId, kind: 'mention', actorId: author.id, postId })
      }
    }

    emit({
      topic: 'agora.post.edited',
      key: postId,
      payload: { postId, voiceId: author.id, subject },
      actor: subject,
      ...(correlationId ? { correlationId } : {}),
    })
    return postId
  })

  const post = await readPost(deps.sql, id, null)
  if (!post) throw new PostNotFoundError()
  return post
}

/**
 * Delete a post.
 *
 * Soft, and the body is blanked. The row survives so that replies to it do not become orphans in
 * the middle of a thread — a conversation with a hole in it is worse for the people still in it
 * than a "this post was deleted" placeholder. What survives holds nothing: no body, no media, no
 * tags, no content warning. The distinction is the one that matters for erasure. A subject that is
 * DELETED at identity gets `eraseSubject`, which is a hard delete of everything they wrote.
 */
export async function deletePost(
  deps: PostDeps,
  subject: string,
  postId: string,
  correlationId?: string,
): Promise<boolean> {
  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const author = await ensureVoice(tx, subject)
    const rows = await tx<{ id: string; in_reply_to_id: string | null; quote_of_id: string | null }[]>`
      update posts set body = '', content_warning = '', deleted_at = now()
       where id = ${postId} and voice_id = ${author.id} and deleted_at is null
      returning id, in_reply_to_id, quote_of_id
    `
    const row = rows[0]
    if (!row) return false

    await tx`delete from post_media where post_id = ${postId}`
    await tx`delete from post_tags where post_id = ${postId}`
    // The mention rows go too: a deleted post must not keep appearing in anybody's mentions.
    await tx`delete from post_mentions where post_id = ${postId}`
    await tx`delete from notifications where post_id = ${postId}`

    if (row.in_reply_to_id) {
      await tx`
        update posts set reply_count = greatest(reply_count - 1, 0) where id = ${row.in_reply_to_id}
      `
    }
    if (row.quote_of_id) {
      await tx`
        update posts set quote_count = greatest(quote_count - 1, 0) where id = ${row.quote_of_id}
      `
    }

    emit({
      topic: 'agora.post.deleted',
      key: postId,
      payload: { postId, voiceId: author.id, subject },
      actor: subject,
      ...(correlationId ? { correlationId } : {}),
    })
    return true
  })
}

/* ------------------------------------------------------------------ engagement */

export interface EngagementResult {
  readonly changed: boolean
  readonly count: number
}

/**
 * Spark, unspark, echo, unecho — one function, because they are one shape.
 *
 * The count is maintained in the same transaction as the row, and the `changed` flag comes from
 * whether the insert or delete actually did anything. That is what makes a double-tap idempotent:
 * the second one conflicts, `changed` is false, the counter is not bumped, and no second
 * notification is written.
 */
export async function setEngagement(
  deps: PostDeps,
  subject: string,
  postId: string,
  table: 'sparks' | 'echoes' | 'bookmarks',
  on: boolean,
  correlationId?: string,
): Promise<EngagementResult> {
  const column = table === 'sparks' ? 'spark_count' : table === 'echoes' ? 'echo_count' : null

  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const me = await ensureVoice(tx, subject)

    // Read through the visibility predicate: sparking a post you cannot see would be a way to
    // confirm that a followers-only post exists, and echoing one would republish it.
    const visible = await tx<{ id: string; voice_id: string; visibility: string }[]>`
      select p.id, p.voice_id, p.visibility
        from posts p
        join voices vo on vo.id = p.voice_id
       where p.id = ${postId} and p.deleted_at is null
         and ${visibilityPredicate(tx, me.id)}
    `
    const post = visible[0]
    if (!post) throw new PostNotFoundError()
    if (table === 'echoes' && post.visibility !== 'public' && post.voice_id !== me.id) {
      throw new PostError('only a public post can be echoed')
    }

    let changed: boolean
    if (on) {
      const rows = await tx<{ voice_id: string }[]>`
        insert into ${tx(table)} (voice_id, post_id) values (${me.id}, ${postId})
        on conflict do nothing
        returning voice_id
      `
      changed = rows.length > 0
    } else {
      const rows = await tx<{ voice_id: string }[]>`
        delete from ${tx(table)} where voice_id = ${me.id} and post_id = ${postId}
        returning voice_id
      `
      changed = rows.length > 0
    }

    let count = 0
    if (column && changed) {
      const rows = await tx<{ count: number }[]>`
        update posts set ${tx.unsafe(column)} = greatest(${tx.unsafe(column)} + ${on ? 1 : -1}, 0)
         where id = ${postId}
        returning ${tx.unsafe(column)} as count
      `
      count = rows[0]?.count ?? 0
    } else if (column) {
      const rows = await tx<{ count: number }[]>`
        select ${tx.unsafe(column)} as count from posts where id = ${postId}
      `
      count = rows[0]?.count ?? 0
    }

    if (changed && on && table !== 'bookmarks') {
      await notify(tx, {
        voiceId: post.voice_id,
        kind: table === 'sparks' ? 'spark' : 'echo',
        actorId: me.id,
        postId,
      })
      emit({
        topic: table === 'sparks' ? 'agora.spark.created' : 'agora.echo.created',
        key: `${me.id}:${postId}`,
        // `subject` beside `voiceId`, and the pair is not redundant: a voice id is THIS service's
        // identifier for a person and means nothing to any subscriber, while the subject is the
        // estate's. A subscriber that wanted to file this in the sparker's own timeline would
        // otherwise have to read the envelope actor — the reader every consumer quarantines,
        // because an actor is who acted and not necessarily whose news it is. Naming the person on
        // the payload costs a string and removes the argument.
        payload: { voiceId: me.id, postId, authorId: post.voice_id, subject },
        actor: subject,
        ...(correlationId ? { correlationId } : {}),
      })
    }
    if (changed && !on && table !== 'bookmarks') {
      // The notification is removed with the spark. Otherwise a badge outlives the thing it is
      // about, and the recipient opens it to find nothing there.
      await tx`
        delete from notifications
         where voice_id = ${post.voice_id} and actor_id = ${me.id} and post_id = ${postId}
           and kind = ${table === 'sparks' ? 'spark' : 'echo'}
      `
    }

    return { changed, count }
  })
}

/* ------------------------------------------------------------------ reading */

async function hydrate(
  sql: Db | Tx,
  rows: readonly PostRow[],
  viewerId: string | null,
): Promise<readonly Post[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)

  // Two queries for the whole page rather than two per post. The N+1 version of this is what makes
  // a timeline take four hundred milliseconds, and it is invisible in a test with three rows.
  const [mediaRows, tagRows, viewerRows] = await Promise.all([
    sql<{ id: string; post_id: string; asset_id: string; alt: string; kind: string; ordinal: number }[]>`
      select id, post_id, asset_id, alt, kind, ordinal from post_media
       where post_id in ${sql(ids)} order by post_id, ordinal
    `,
    sql<{ post_id: string; tag: string }[]>`
      select post_id, tag from post_tags where post_id in ${sql(ids)} order by post_id, tag
    `,
    viewerId
      ? sql<{ post_id: string; sparked: boolean; echoed: boolean; bookmarked: boolean }[]>`
          select p.id as post_id,
                 exists(select 1 from sparks s where s.post_id = p.id and s.voice_id = ${viewerId}) as sparked,
                 exists(select 1 from echoes e where e.post_id = p.id and e.voice_id = ${viewerId}) as echoed,
                 exists(select 1 from bookmarks b where b.post_id = p.id and b.voice_id = ${viewerId}) as bookmarked
            from posts p where p.id in ${sql(ids)}
        `
      : Promise.resolve([]),
  ])

  const media = new Map<string, Media[]>()
  for (const row of mediaRows) {
    const list = media.get(row.post_id) ?? []
    list.push({ id: row.id, assetId: row.asset_id, alt: row.alt, kind: row.kind, ordinal: row.ordinal })
    media.set(row.post_id, list)
  }
  const tags = new Map<string, string[]>()
  for (const row of tagRows) {
    const list = tags.get(row.post_id) ?? []
    list.push(row.tag)
    tags.set(row.post_id, list)
  }
  const viewer = new Map(viewerRows.map((r) => [r.post_id, r]))

  return rows.map((row) => {
    const post = toPost(row, media.get(row.id) ?? [], tags.get(row.id) ?? [])
    const v = viewer.get(row.id)
    if (!viewerId || !v) return post
    return {
      ...post,
      viewer: {
        sparked: v.sparked,
        echoed: v.echoed,
        bookmarked: v.bookmarked,
        mine: row.voice_id === viewerId,
      },
    }
  })
}

export async function readPost(sql: Db, postId: string, viewerId: string | null): Promise<Post | null> {
  const rows = await sql<PostRow[]>`
    select ${sql.unsafe(POST_COLUMNS)}
      from posts p
      join voices v on v.id = p.voice_id
      join voices vo on vo.id = p.voice_id
     where p.id = ${postId} and ${visibilityPredicate(sql, viewerId)}
  `
  if (!rows[0]) return null
  const [post] = await hydrate(sql, rows, viewerId)
  return post ?? null
}

export interface Page {
  readonly posts: readonly Post[]
  readonly nextCursor: string | null
}

interface PageOptions {
  readonly viewerId: string | null
  readonly limit: number
  readonly cursor?: string | null
}

function pageSize(deps: PostDeps, requested: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 20
  return Math.min(Math.floor(requested), deps.pageSizeMax)
}

async function paginate(
  sql: Db,
  viewerId: string | null,
  limit: number,
  rows: readonly PostRow[],
): Promise<Page> {
  const slice = rows.slice(0, limit)
  const posts = await hydrate(sql, slice, viewerId)
  const last = slice[slice.length - 1]
  return {
    posts,
    nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
  }
}

/**
 * `/latest` — the public firehose, in the order it was written.
 *
 * The whole square, logged out. `posts_public_idx` is partial on exactly this predicate, so the
 * index is the answer rather than a filter over one.
 */
export async function latest(deps: PostDeps, options: PageOptions): Promise<Page> {
  const limit = pageSize(deps, options.limit)
  const cursor = decodeCursor(options.cursor ?? null)
  const { sql } = deps
  const rows = await sql<PostRow[]>`
    select ${sql.unsafe(POST_COLUMNS)}
      from posts p
      join voices v on v.id = p.voice_id
      join voices vo on vo.id = p.voice_id
     where p.deleted_at is null
       and ${visibilityPredicate(sql, options.viewerId)}
       ${hushPredicate(sql, options.viewerId)}
       ${cursor ? sql`and (p.created_at, p.id) < (${cursor.at}, ${cursor.id})` : sql``}
     order by p.created_at desc, p.id desc
     limit ${limit + 1}
  `
  return paginate(sql, options.viewerId, limit, rows)
}

/**
 * The home timeline: the posts and echoes of everybody this voice follows, plus their own.
 *
 * A `union all` of two keyset-paginated legs rather than a join with an `or`, because Postgres
 * cannot use `posts_voice_idx` for an `or` across two different tables and plans a sequential scan
 * of the whole square instead. Measured, not assumed: the `or` form on a hundred thousand posts is
 * a scan; this form is two index reads and a merge.
 *
 * An echo carries the ECHO's timestamp, not the post's — that is what puts a two-year-old post
 * somebody just echoed at the top of your timeline, which is the only correct behaviour and the one
 * a naive `order by p.created_at` gets wrong.
 */
export async function home(deps: PostDeps, options: PageOptions & { viewerId: string }): Promise<Page> {
  const limit = pageSize(deps, options.limit)
  const cursor = decodeCursor(options.cursor ?? null)
  const { sql } = deps
  const me = options.viewerId

  const rows = await sql<(PostRow & { sort_at: Date; sort_id: string })[]>`
    with feed as (
      select p.id, p.created_at as sort_at, p.id as sort_id
        from posts p
       where p.deleted_at is null
         and (p.voice_id = ${me}
              or p.voice_id in (select followee_id from follows
                                 where follower_id = ${me} and state = 'active'))
      union all
      select e.post_id as id, e.created_at as sort_at, e.post_id as sort_id
        from echoes e
       where e.voice_id in (select followee_id from follows
                             where follower_id = ${me} and state = 'active')
    )
    select ${sql.unsafe(POST_COLUMNS)}, f.sort_at, f.sort_id
      from feed f
      join posts p on p.id = f.id
      join voices v on v.id = p.voice_id
      join voices vo on vo.id = p.voice_id
     where p.deleted_at is null
       and ${visibilityPredicate(sql, me)}
       ${hushPredicate(sql, me)}
       ${cursor ? sql`and (f.sort_at, f.sort_id) < (${cursor.at}, ${cursor.id})` : sql``}
     order by f.sort_at desc, f.sort_id desc
     limit ${limit + 1}
  `

  const slice = rows.slice(0, limit)
  const posts = await hydrate(sql, slice, me)
  const last = slice[slice.length - 1]
  return {
    posts,
    nextCursor: rows.length > limit && last ? encodeCursor(last.sort_at, last.sort_id) : null,
  }
}

/** One voice's posts. The profile page. */
export async function byVoice(
  deps: PostDeps,
  voiceId: string,
  options: PageOptions & { readonly includeReplies?: boolean },
): Promise<Page> {
  const limit = pageSize(deps, options.limit)
  const cursor = decodeCursor(options.cursor ?? null)
  const { sql } = deps
  const rows = await sql<PostRow[]>`
    select ${sql.unsafe(POST_COLUMNS)}
      from posts p
      join voices v on v.id = p.voice_id
      join voices vo on vo.id = p.voice_id
     where p.voice_id = ${voiceId} and p.deleted_at is null
       and ${visibilityPredicate(sql, options.viewerId)}
       ${options.includeReplies ? sql`` : sql`and p.in_reply_to_id is null`}
       ${cursor ? sql`and (p.created_at, p.id) < (${cursor.at}, ${cursor.id})` : sql``}
     order by p.created_at desc, p.id desc
     limit ${limit + 1}
  `
  return paginate(sql, options.viewerId, limit, rows)
}

/** A tag page. The one every product forgets to run the visibility test on. */
export async function byTag(deps: PostDeps, tag: string, options: PageOptions): Promise<Page> {
  const limit = pageSize(deps, options.limit)
  const cursor = decodeCursor(options.cursor ?? null)
  const normalised = tag.trim().toLowerCase().replace(/^#/, '')
  if (!/^[a-z0-9_]{1,64}$/.test(normalised)) throw new PostError('that is not a tag')
  const { sql } = deps
  const rows = await sql<PostRow[]>`
    select ${sql.unsafe(POST_COLUMNS)}
      from post_tags pt
      join posts p on p.id = pt.post_id
      join voices v on v.id = p.voice_id
      join voices vo on vo.id = p.voice_id
     where pt.tag = ${normalised} and p.deleted_at is null
       and ${visibilityPredicate(sql, options.viewerId)}
       ${hushPredicate(sql, options.viewerId)}
       ${cursor ? sql`and (p.created_at, p.id) < (${cursor.at}, ${cursor.id})` : sql``}
     order by p.created_at desc, p.id desc
     limit ${limit + 1}
  `
  return paginate(sql, options.viewerId, limit, rows)
}

/**
 * One circle's posts.
 *
 * The caller has already established that this reader may see the circle at all — `canRead` in
 * `circles.ts` — but this query does NOT take that on trust. It runs the same `visibilityPredicate`
 * as every other timeline, so the membership test happens again here, in SQL, against the row.
 *
 * That looks redundant and is not. `canRead` answers a question about a CIRCLE; this answers a
 * question about each POST, and the two differ for the row that matters: a post written to a circle
 * by somebody the reader has since barred, or by a voice that has since been suspended. A route
 * that checked the circle once and then selected on `circle_id` alone would serve both.
 */
export async function byCircle(deps: PostDeps, circleId: string, options: PageOptions): Promise<Page> {
  const limit = pageSize(deps, options.limit)
  const cursor = decodeCursor(options.cursor ?? null)
  const { sql } = deps
  const rows = await sql<PostRow[]>`
    select ${sql.unsafe(POST_COLUMNS)}
      from posts p
      join voices v on v.id = p.voice_id
      join voices vo on vo.id = p.voice_id
     where p.circle_id = ${circleId} and p.deleted_at is null
       and ${visibilityPredicate(sql, options.viewerId)}
       ${hushPredicate(sql, options.viewerId)}
       ${cursor ? sql`and (p.created_at, p.id) < (${cursor.at}, ${cursor.id})` : sql``}
     order by p.created_at desc, p.id desc
     limit ${limit + 1}
  `
  return paginate(sql, options.viewerId, limit, rows)
}

/**
 * A whole thread, oldest first.
 *
 * Ascending, unlike every other read here, because a conversation is read in the order it happened
 * — and this is not a ranking decision, it is the only chronological order a thread has.
 *
 * Capped at 500. A thread longer than that is not a conversation, and an uncapped read of one is a
 * request that returns a megabyte.
 */
export async function thread(
  deps: PostDeps,
  rootId: string,
  viewerId: string | null,
): Promise<readonly Post[]> {
  const { sql } = deps
  const rows = await sql<PostRow[]>`
    select ${sql.unsafe(POST_COLUMNS)}
      from posts p
      join voices v on v.id = p.voice_id
      join voices vo on vo.id = p.voice_id
     where (p.id = ${rootId} or p.root_id = ${rootId})
       and ${visibilityPredicate(sql, viewerId)}
     order by p.created_at asc, p.id asc
     limit 500
  `
  return hydrate(sql, rows, viewerId)
}

/** This voice's bookmarks. Private, always, and there is no count anywhere. */
export async function bookmarks(
  deps: PostDeps,
  options: PageOptions & { viewerId: string },
): Promise<Page> {
  const limit = pageSize(deps, options.limit)
  const cursor = decodeCursor(options.cursor ?? null)
  const { sql } = deps
  const me = options.viewerId
  const rows = await sql<(PostRow & { sort_at: Date })[]>`
    select ${sql.unsafe(POST_COLUMNS)}, b.created_at as sort_at
      from bookmarks b
      join posts p on p.id = b.post_id
      join voices v on v.id = p.voice_id
      join voices vo on vo.id = p.voice_id
     where b.voice_id = ${me} and p.deleted_at is null
       and ${visibilityPredicate(sql, me)}
       ${cursor ? sql`and (b.created_at, p.id) < (${cursor.at}, ${cursor.id})` : sql``}
     order by b.created_at desc, p.id desc
     limit ${limit + 1}
  `
  const slice = rows.slice(0, limit)
  const posts = await hydrate(sql, slice, me)
  const last = slice[slice.length - 1]
  return {
    posts,
    nextCursor: rows.length > limit && last ? encodeCursor(last.sort_at, last.id) : null,
  }
}

/**
 * Full-text search over public posts.
 *
 * Public only, and that is not a limitation to fix later. A search that reached followers-only
 * posts would let somebody discover what a protected account said by guessing at words, and a
 * search that respected the predicate per-row would still leak through timing on a large enough
 * corpus. Search is for the part of the square that is already public.
 *
 * `plainto_tsquery` rather than `to_tsquery`: the latter takes operator syntax, so a user typing
 * `crypto & !scam` would either get a syntax error or an accidental boolean query. `plainto_`
 * treats the whole string as words, which is what somebody typing in a search box means.
 */
export async function search(deps: PostDeps, query: string, options: PageOptions): Promise<Page> {
  const limit = pageSize(deps, options.limit)
  const cursor = decodeCursor(options.cursor ?? null)
  const text = query.trim().slice(0, 200)
  if (!text) return { posts: [], nextCursor: null }
  const { sql } = deps
  const rows = await sql<PostRow[]>`
    select ${sql.unsafe(POST_COLUMNS)}
      from posts p
      join voices v on v.id = p.voice_id
      join voices vo on vo.id = p.voice_id
     where p.deleted_at is null
       and p.visibility = 'public'
       and vo.suspended_at is null
       and p.search @@ plainto_tsquery('simple', ${text})
       ${hushPredicate(sql, options.viewerId)}
       ${
         options.viewerId
           ? sql`and not exists(
                   select 1 from bars b
                    where (b.voice_id = ${options.viewerId} and b.barred_id = p.voice_id)
                       or (b.voice_id = p.voice_id and b.barred_id = ${options.viewerId}))`
           : sql``
       }
       ${cursor ? sql`and (p.created_at, p.id) < (${cursor.at}, ${cursor.id})` : sql``}
     order by p.created_at desc, p.id desc
     limit ${limit + 1}
  `
  return paginate(sql, options.viewerId, limit, rows)
}

/**
 * The tags people are actually using, over a window.
 *
 * Not "trending", and the difference is the point. There is no velocity term, no acceleration, no
 * comparison against a baseline — the three ingredients that turn a tag list into something worth
 * gaming. It is a count over the last day, ordered by count, and the window is what keeps it from
 * being a permanent leaderboard.
 */
export async function activeTags(
  sql: Db,
  limit = 10,
): Promise<readonly { tag: string; posts: number }[]> {
  const rows = await sql<{ tag: string; posts: string }[]>`
    select pt.tag, count(*) as posts
      from post_tags pt
      join posts p on p.id = pt.post_id
     where p.created_at > now() - interval '24 hours'
       and p.deleted_at is null and p.visibility = 'public'
     group by pt.tag
     having count(*) > 1
     order by count(*) desc, pt.tag asc
     limit ${Math.min(Math.max(limit, 1), 50)}
  `
  return rows.map((r) => ({ tag: r.tag, posts: Number(r.posts) }))
}

export { VoiceError, VoiceStateError, findVoice }
export type { Emit }
