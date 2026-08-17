/**
 * Notifications, and the opt-in that stands between the database and somebody's inbox.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **NO MAIL LEAVES THIS SERVICE FOR A VOICE THAT DID NOT ASK FOR IT.**
 *
 * `notifications.ts` states the rule and names the pressure that erodes it — "engagement is low,
 * let us mail them when somebody replies". A rule stated in a header is a rule somebody deletes in
 * a hurry, so the four cases that make it real are here: a voice with NO preferences row is mailed
 * nothing, `prefsFor` does not WRITE the row it failed to find, a kind with no preference column is
 * never mailed however the row is set, and turning one column on mails that kind and no other.
 *
 * The third of those is the one worth spelling out. `prefFor('spark')` returns null, so a spark is
 * unmailable — not "off by default", unmailable. If somebody later adds `onSpark`, this test still
 * passes, which is correct: the test is about the KINDS THAT HAVE NO SWITCH being silent, and the
 * day one grows a switch is the day somebody decided that on purpose.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The other half of the file is the read path, where the load-bearing case is that **a bar hides
 * the notifications in BOTH directions and deletes none of them**. Deleting would be simpler and it
 * is wrong: unbarring somebody would then silently destroy the record of what passed between you,
 * and the person doing the unbarring is not told that is the trade. `restores them when the bar is
 * lifted` is the pair that keeps the implementation honest.
 */

import { strict as assert } from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import {
  listNotifications,
  markRead,
  prefsFor,
  setPrefs,
  sweepEmail,
  sweepOld,
  unreadCount,
  NO_EMAIL,
} from './notifications.ts'
import { bar, notify, unbar } from './voices.ts'
import {
  asTx,
  migrateTestDb,
  openDb,
  resetAgora,
  seedVoice,
  skip,
  subject,
  testDeps,
} from './testsupport.ts'

describe('notifications', { skip }, () => {
  let sql: postgres.Sql
  let deps: ReturnType<typeof testDeps>

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
    deps = testDeps(sql)
  })

  after(async () => {
    await sql.end()
  })

  beforeEach(async () => {
    await resetAgora(sql)
  })

  /* ---------------------------------------------------------------- writing one */

  describe('writing one', () => {
    it('never tells somebody about their own action', async () => {
      // Every network has shipped this once and it reads as the product not knowing who you are:
      // you spark your own post and the badge lights up.
      const me = await seedVoice(sql, 'notify-self')
      await write(sql, { voiceId: me.id, kind: 'spark', actorId: me.id })
      assert.equal(await unreadCount(deps.sql, me.id), 0)
    })

    it('does not raise a second badge for the same thing twice', async () => {
      // Unspark, spark again. `notifications_dedupe_idx` makes that one notification, so the
      // recipient is not shown a stream of one person changing their mind.
      const me = await seedVoice(sql, 'dedupe-me')
      const them = await seedVoice(sql, 'dedupe-them')
      const post = await insertPost(sql, me.id)
      await write(sql, { voiceId: me.id, kind: 'spark', actorId: them.id, postId: post })
      await write(sql, { voiceId: me.id, kind: 'spark', actorId: them.id, postId: post })
      assert.equal(await unreadCount(deps.sql, me.id), 1)
    })

    it('keeps a system notification, which has no actor at all', async () => {
      const me = await seedVoice(sql, 'system-note')
      await write(sql, { voiceId: me.id, kind: 'moderation', detail: 'a post was removed' })
      const { notifications } = await listNotifications(deps.notifications, me.id, { limit: 10 })
      assert.equal(notifications.length, 1)
      assert.equal(notifications[0]!.actor, null, 'a moderation notice names no operator')
      assert.equal(notifications[0]!.detail, 'a post was removed')
    })
  })

  /* ---------------------------------------------------------------- reading them */

  describe('reading them', () => {
    it('answers newest first and pages without repeating or dropping one', async () => {
      const me = await seedVoice(sql, 'page-me')
      const them = await seedVoice(sql, 'page-them')
      for (let i = 0; i < 5; i += 1) {
        const post = await insertPost(sql, me.id, `post ${i}`)
        await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: post })
      }

      const first = await listNotifications(deps.notifications, me.id, { limit: 2 })
      assert.equal(first.notifications.length, 2)
      assert.ok(first.nextCursor, 'five rows and a page of two owes a cursor')

      const second = await listNotifications(deps.notifications, me.id, {
        limit: 2,
        cursor: first.nextCursor,
      })
      const third = await listNotifications(deps.notifications, me.id, {
        limit: 2,
        cursor: second.nextCursor,
      })
      assert.equal(third.notifications.length, 1)
      assert.equal(third.nextCursor, null)

      const seen = [first, second, third].flatMap((page) => page.notifications.map((n) => n.id))
      assert.equal(new Set(seen).size, 5, 'a page boundary neither repeated nor swallowed a row')
    })

    it('shows only the unread ones when asked, and the badge agrees', async () => {
      const me = await seedVoice(sql, 'unread-me')
      const them = await seedVoice(sql, 'unread-them')
      const a = await insertPost(sql, me.id, 'one')
      const b = await insertPost(sql, me.id, 'two')
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: a })
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: b })

      const all = await listNotifications(deps.notifications, me.id, { limit: 10 })
      const marked = await markRead(deps.notifications, me.id, all.notifications[0]!.id)
      assert.equal(marked, 1)

      const unread = await listNotifications(deps.notifications, me.id, {
        limit: 10,
        unreadOnly: true,
      })
      assert.equal(unread.notifications.length, 1)
      assert.equal(await unreadCount(deps.sql, me.id), 1, 'the badge and the list are one number')
    })

    it('marks one, then the rest, and marking again changes nothing', async () => {
      const me = await seedVoice(sql, 'markread-me')
      const them = await seedVoice(sql, 'markread-them')
      for (let i = 0; i < 3; i += 1) {
        const post = await insertPost(sql, me.id, `p${i}`)
        await write(sql, { voiceId: me.id, kind: 'mention', actorId: them.id, postId: post })
      }
      assert.equal(await markRead(deps.notifications, me.id, null), 3)
      // Idempotent because the UPDATE is guarded on `read_at is null`. The pull-to-refresh that
      // fires twice must not report "3 more read" the second time.
      assert.equal(await markRead(deps.notifications, me.id, null), 0)
      assert.equal(await unreadCount(deps.sql, me.id), 0)
    })

    it('will not let one voice mark another voice’s notification read', async () => {
      const me = await seedVoice(sql, 'markmine')
      const them = await seedVoice(sql, 'marktheirs')
      const post = await insertPost(sql, me.id, 'mine')
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: post })
      const mine = await listNotifications(deps.notifications, me.id, { limit: 5 })

      assert.equal(await markRead(deps.notifications, them.id, mine.notifications[0]!.id), 0)
      assert.equal(await unreadCount(deps.sql, me.id), 1, 'still unread, and still mine')
    })

    it('hides a barred voice’s notifications in both directions, and deletes none of them', async () => {
      // The whole point. `bars` is the only record of who wants nothing to do with whom, and the
      // notification is hidden by a NOT EXISTS rather than removed — see the header.
      const me = await seedVoice(sql, 'bar-reader')
      const them = await seedVoice(sql, 'bar-subject')
      const post = await insertPost(sql, me.id, 'before the bar')
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: post })
      assert.equal(await unreadCount(deps.sql, me.id), 1)

      await bar(deps.voices, subject('bar-reader'), them.id)
      const hidden = await listNotifications(deps.notifications, me.id, { limit: 10 })
      assert.equal(hidden.notifications.length, 0, 'the barred voice is not in the list')

      const rows = await sql<{ n: string }[]>`
        select count(*) as n from notifications where voice_id = ${me.id}
      `
      assert.equal(Number(rows[0]!.n), 1, 'hidden, not deleted')

      await unbar(deps.voices, subject('bar-reader'), them.id)
      const restored = await listNotifications(deps.notifications, me.id, { limit: 10 })
      assert.equal(restored.notifications.length, 1, 'lifting the bar restores the history')
    })

    it('hides it when the BARRED voice is the one reading', async () => {
      // The other direction, and the one an implementation forgets: the person who was barred also
      // stops seeing notifications the barrer caused, without being told a bar exists.
      const barrer = await seedVoice(sql, 'reverse-barrer')
      const barred = await seedVoice(sql, 'reverse-barred')
      const post = await insertPost(sql, barred.id, 'theirs')
      await write(sql, { voiceId: barred.id, kind: 'spark', actorId: barrer.id, postId: post })

      await bar(deps.voices, subject('reverse-barrer'), barred.id)
      const seen = await listNotifications(deps.notifications, barred.id, { limit: 10 })
      assert.equal(seen.notifications.length, 0)
    })

    it('leaves a hushed voice’s notifications alone', async () => {
      // A hush is about a TIMELINE. Somebody you quietly muted replying to you directly is still
      // something you asked to be told about, and silencing it here would make hush a soft bar that
      // nobody agreed to.
      const me = await seedVoice(sql, 'hush-reader')
      const them = await seedVoice(sql, 'hush-subject')
      const post = await insertPost(sql, me.id, 'mine')
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: post })
      await sql`insert into hushes (voice_id, hushed_id) values (${me.id}, ${them.id})`

      const seen = await listNotifications(deps.notifications, me.id, { limit: 10 })
      assert.equal(seen.notifications.length, 1)
    })

    it('carries the actor’s current name, not the one they had when it happened', async () => {
      const me = await seedVoice(sql, 'actor-reader')
      const them = await seedVoice(sql, 'actor-subject')
      const post = await insertPost(sql, me.id, 'mine')
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: post })
      await sql`
        update voices set display_name = 'Renamed', avatar_asset_id = 'asset-9'
         where id = ${them.id}
      `
      const { notifications } = await listNotifications(deps.notifications, me.id, { limit: 5 })
      assert.equal(notifications[0]!.actor?.displayName, 'Renamed')
      assert.equal(notifications[0]!.actor?.avatarAssetId, 'asset-9')
      assert.equal(notifications[0]!.actor?.handle, them.handle)
    })
  })

  /* ---------------------------------------------------------------- email preferences */

  describe('email preferences', () => {
    it('answers all-false for a voice that has never chosen, and writes nothing', async () => {
      // Both halves. Returning all-false while INSERTING a row would be the same answer today and a
      // different one after somebody adds a column with `default true` — the row would exist, and
      // the absence that means "never asked" would be gone.
      const me = await seedVoice(sql, 'prefs-absent')
      assert.deepEqual(await prefsFor(deps.sql, me.id), NO_EMAIL)
      const rows = await sql<{ n: string }[]>`
        select count(*) as n from email_prefs where voice_id = ${me.id}
      `
      assert.equal(Number(rows[0]!.n), 0, 'reading a preference must not create one')
    })

    it('starts every column false when the row is first written', async () => {
      await seedVoice(sql, 'prefs-first')
      const saved = await setPrefs(deps.notifications, subject('prefs-first'), { onReply: true })
      assert.deepEqual(saved, { ...NO_EMAIL, onReply: true })
    })

    it('changes one column and leaves the others where they were', async () => {
      const me = await seedVoice(sql, 'prefs-merge')
      await setPrefs(deps.notifications, subject('prefs-merge'), { onReply: true, onFollow: true })
      const after = await setPrefs(deps.notifications, subject('prefs-merge'), { onFollow: false })
      assert.deepEqual(after, { ...NO_EMAIL, onReply: true })
      assert.deepEqual(await prefsFor(deps.sql, me.id), after)
    })

    it('creates the voice if the preferences arrive before anything else does', async () => {
      // A brand-new account whose first action is to open settings. `setPrefs` goes through
      // `ensureVoice`, so this must not be a foreign-key error.
      const saved = await setPrefs(deps.notifications, subject('prefs-newcomer'), {
        onWhisper: true,
      })
      assert.equal(saved.onWhisper, true)
    })
  })

  /* ---------------------------------------------------------------- the mail sweep */

  describe('the mail sweep', () => {
    it('emits nothing for a voice with no preferences row', async () => {
      // The inner join, proven. This is the case that protects everybody who has never opened
      // settings — which, on a new service, is everybody.
      const me = await seedVoice(sql, 'sweep-silent')
      const them = await seedVoice(sql, 'sweep-actor')
      const post = await insertPost(sql, me.id, 'mine')
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: post })
      await age(sql, me.id)

      const result = await sweepEmail(deps.notifications)
      assert.equal(result.emitted, 0)
      assert.equal(await mailEvents(sql), 0)
    })

    it('emits one request for an opted-in reply, carrying a subject and no words', async () => {
      const me = await seedVoice(sql, 'sweep-optedin')
      const them = await seedVoice(sql, 'sweep-replier')
      await setPrefs(deps.notifications, subject('sweep-optedin'), { onReply: true })
      const post = await insertPost(sql, me.id, 'mine')
      await write(sql, {
        voiceId: me.id,
        kind: 'reply',
        actorId: them.id,
        postId: post,
        detail: 'replied to your post',
      })
      await age(sql, me.id)

      const result = await sweepEmail(deps.notifications)
      assert.equal(result.emitted, 1)

      const rows = await sql<{ topic: string; payload: Record<string, unknown> }[]>`
        select topic, payload from outbox where topic = 'agora.notification.mail_requested'
      `
      assert.equal(rows.length, 1)
      const payload = rows[0]!.payload
      assert.equal(payload.subject, subject('sweep-optedin'), 'a subject, never an address')
      assert.equal(payload.kind, 'reply')
      assert.equal(payload.actorHandle, them.handle)
      // No address anywhere in it: this service has never held one and a copy here is a copy that
      // goes stale the day somebody changes it.
      const serialised = JSON.stringify(payload)
      assert.ok(!serialised.includes('@'), `an address reached the bus: ${Object.keys(payload)}`)
    })

    it('mails the kind that was turned on and stays silent about the others', async () => {
      const me = await seedVoice(sql, 'sweep-onekind')
      const them = await seedVoice(sql, 'sweep-onekind-actor')
      await setPrefs(deps.notifications, subject('sweep-onekind'), { onMention: true })
      const post = await insertPost(sql, me.id, 'mine')
      await write(sql, { voiceId: me.id, kind: 'mention', actorId: them.id, postId: post })
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: post })
      await write(sql, { voiceId: me.id, kind: 'follow', actorId: them.id })
      await age(sql, me.id)

      const result = await sweepEmail(deps.notifications)
      assert.equal(result.considered, 3, 'all three were looked at')
      assert.equal(result.emitted, 1, 'and one was mailed')
      const rows = await sql<{ payload: { kind: string } }[]>`
        select payload from outbox where topic = 'agora.notification.mail_requested'
      `
      assert.deepEqual(
        rows.map((r) => r.payload.kind),
        ['mention'],
      )
    })

    it('will not mail a spark or an echo however the row is set', async () => {
      // There is no column to turn these on, deliberately. A like is the lowest-value notification
      // a network has, and mailing it is what teaches somebody to filter the product into a folder
      // they never open.
      const me = await seedVoice(sql, 'sweep-spark')
      const them = await seedVoice(sql, 'sweep-sparker')
      await setPrefs(deps.notifications, subject('sweep-spark'), {
        onReply: true,
        onMention: true,
        onFollow: true,
        onWhisper: true,
        onModeration: true,
      })
      const post = await insertPost(sql, me.id, 'mine')
      await write(sql, { voiceId: me.id, kind: 'spark', actorId: them.id, postId: post })
      await write(sql, { voiceId: me.id, kind: 'echo', actorId: them.id, postId: post })
      await age(sql, me.id)

      const result = await sweepEmail(deps.notifications)
      assert.equal(result.considered, 2)
      assert.equal(result.emitted, 0)
    })

    it('skips a notification the person has already read', async () => {
      // The reason the sweep is on a schedule at all: somebody who opened the app before it ran
      // gets no mail, and a thread of six replies is one mail rather than six.
      const me = await seedVoice(sql, 'sweep-read')
      const them = await seedVoice(sql, 'sweep-read-actor')
      await setPrefs(deps.notifications, subject('sweep-read'), { onReply: true })
      const post = await insertPost(sql, me.id, 'mine')
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: post })
      await age(sql, me.id)
      await markRead(deps.notifications, me.id, null)

      const result = await sweepEmail(deps.notifications)
      assert.equal(result.considered, 0)
      assert.equal(result.emitted, 0)
    })

    it('leaves a notification that is still too fresh for the next run', async () => {
      // The window closes a minute in the past. A notification written seconds ago belongs to the
      // NEXT sweep, which is what gives somebody a moment to read it in the app first.
      const me = await seedVoice(sql, 'sweep-fresh')
      const them = await seedVoice(sql, 'sweep-fresh-actor')
      await setPrefs(deps.notifications, subject('sweep-fresh'), { onReply: true })
      const post = await insertPost(sql, me.id, 'mine')
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: post })

      const now = await sweepEmail(deps.notifications)
      assert.equal(now.emitted, 0, 'not yet')

      await age(sql, me.id)
      const later = await sweepEmail(deps.notifications)
      assert.equal(later.emitted, 1, 'and now')
    })

    it('leaves one older than the window, rather than mailing yesterday’s news', async () => {
      const me = await seedVoice(sql, 'sweep-stale')
      const them = await seedVoice(sql, 'sweep-stale-actor')
      await setPrefs(deps.notifications, subject('sweep-stale'), { onReply: true })
      const post = await insertPost(sql, me.id, 'mine')
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: post })
      await age(sql, me.id, '3 hours')

      const result = await sweepEmail(deps.notifications)
      assert.equal(result.considered, 0)
      assert.equal(result.emitted, 0)
    })

    it('trims the detail rather than letting a post travel in a subject line', async () => {
      const me = await seedVoice(sql, 'sweep-trim')
      const them = await seedVoice(sql, 'sweep-trim-actor')
      await setPrefs(deps.notifications, subject('sweep-trim'), { onMention: true })
      const post = await insertPost(sql, me.id, 'mine')
      await write(sql, {
        voiceId: me.id,
        kind: 'mention',
        actorId: them.id,
        postId: post,
        detail: 'x'.repeat(400),
      })
      await age(sql, me.id)

      await sweepEmail(deps.notifications)
      const rows = await sql<{ payload: { detail: string } }[]>`
        select payload from outbox where topic = 'agora.notification.mail_requested'
      `
      assert.equal(rows[0]!.payload.detail.length, 200)
    })
  })

  /* ---------------------------------------------------------------- retention */

  describe('retention', () => {
    it('deletes the ones past the window and keeps the rest', async () => {
      // A notification is a pointer to something that is still there. Keeping it for ever costs a
      // table that only grows and hands an operator an indefinite record of who spoke to whom.
      const me = await seedVoice(sql, 'ttl-me')
      const them = await seedVoice(sql, 'ttl-them')
      const old = await insertPost(sql, me.id, 'old')
      const fresh = await insertPost(sql, me.id, 'fresh')
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: old })
      await sql`
        update notifications set created_at = now() - interval '60 days' where post_id = ${old}
      `
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: fresh })

      const deleted = await sweepOld(deps.notifications)
      assert.equal(deleted, 1)
      const { notifications } = await listNotifications(deps.notifications, me.id, { limit: 10 })
      assert.equal(notifications.length, 1)
      assert.equal(notifications[0]!.postId, fresh)
    })

    it('keeps a read notification that is still inside the window', async () => {
      // Read is not the same as expired: somebody who marks the badge down and comes back an hour
      // later still expects to find what they marked.
      const me = await seedVoice(sql, 'ttl-read')
      const them = await seedVoice(sql, 'ttl-read-actor')
      const post = await insertPost(sql, me.id, 'mine')
      await write(sql, { voiceId: me.id, kind: 'reply', actorId: them.id, postId: post })
      await markRead(deps.notifications, me.id, null)

      assert.equal(await sweepOld(deps.notifications), 0)
      const { notifications } = await listNotifications(deps.notifications, me.id, { limit: 10 })
      assert.equal(notifications.length, 1)
    })
  })
})

/* ------------------------------------------------------------------ fixtures */

/** `notify` takes a transaction, and every caller in the product already has one. */
async function write(
  sql: postgres.Sql,
  input: Parameters<typeof notify>[1],
): Promise<void> {
  await sql.begin(async (tx) => {
    await notify(asTx(tx), input)
  })
}

async function insertPost(sql: postgres.Sql, voiceId: string, body = 'a post'): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into posts (voice_id, body) values (${voiceId}, ${body}) returning id
  `
  return rows[0]!.id
}

/**
 * Backdate this voice's notifications into the sweep's window.
 *
 * The window is `[now - 15 minutes, now - 1 minute)`. Everything written by a test is seconds old,
 * so without this every sweep assertion would be proving the freshness guard and nothing else.
 */
async function age(sql: postgres.Sql, voiceId: string, by = '5 minutes'): Promise<void> {
  await sql.unsafe(
    `update notifications set created_at = now() - interval '${by}' where voice_id = $1`,
    [voiceId],
  )
}

async function mailEvents(sql: postgres.Sql): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    select count(*) as n from outbox where topic = 'agora.notification.mail_requested'
  `
  return Number(rows[0]!.n)
}
