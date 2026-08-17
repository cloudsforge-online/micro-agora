/**
 * The constraints, proven by trying to break them.
 *
 * `migrations.ts` names four rules this service exists to add and says each is a CHECK or a unique
 * index rather than a line in a route handler, "because a rule in a route handler is a rule the
 * next route forgets". This file is the other half of that claim: it goes around every route and
 * writes directly to the tables, so what passes here is what the DATABASE guarantees to a client
 * that got in some other way — a migration, a backfill script, a future service.
 *
 * Nothing here calls a domain function on purpose. `posts.ts` also refuses an attachment with no
 * description, and if this file went through `createPost` it would be proving that check and
 * calling it the constraint.
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import type postgres from 'postgres'
import { migrateTestDb, openDb, resetAgora, seedVoice, skip, uniqueHandle } from './testsupport.ts'
import { SCHEMA_VERSION } from './migrations.ts'

describe('the schema', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })

  after(async () => {
    await sql.end()
  })

  it('is at the version the service asserts', async () => {
    const rows = await sql<{ version: number }[]>`
      select max(version)::int as version from schema_migrations
    `
    assert.equal(rows[0]?.version, SCHEMA_VERSION)
  })

  describe('post_media_alt_required', () => {
    before(async () => {
      await resetAgora(sql)
    })

    it('refuses an attachment with an empty description', async () => {
      const voice = await seedVoice(sql, 'alt-empty')
      const post = await insertPost(sql, voice.id, 'a picture')
      // NOT NULL would have accepted this. An empty string is precisely what a client sends when
      // it has an alt field nobody filled in, which is the case the rule is about.
      await assert.rejects(
        () => sql`
          insert into post_media (post_id, ordinal, kind, asset_id, alt)
          values (${post}, 0, 'image', 'asset-1', '')
        `,
        /post_media_alt_required/,
      )
    })

    it('refuses a single space, because a space is not a description', async () => {
      const voice = await seedVoice(sql, 'alt-space')
      const post = await insertPost(sql, voice.id, 'a picture')
      await assert.rejects(
        () => sql`
          insert into post_media (post_id, ordinal, kind, asset_id, alt)
          values (${post}, 0, 'image', 'asset-2', '   ')
        `,
        /post_media_alt_required/,
      )
    })

    it('accepts a real description', async () => {
      const voice = await seedVoice(sql, 'alt-real')
      const post = await insertPost(sql, voice.id, 'a picture')
      await sql`
        insert into post_media (post_id, ordinal, kind, asset_id, alt)
        values (${post}, 0, 'image', 'asset-3', 'a candlestick chart, mostly red')
      `
      const rows = await sql<{ n: string }[]>`
        select count(*) as n from post_media where post_id = ${post}
      `
      assert.equal(Number(rows[0]!.n), 1)
    })
  })

  describe('whispers_body_len', () => {
    before(async () => {
      await resetAgora(sql)
    })

    it('refuses an empty whisper while the row is live, and permits one once it is deleted', async () => {
      // This constraint shipped as `between 1 and N` and made `deleteWhisper` impossible: the soft
      // delete blanks the body, so every attempt raised 23514 and the route answered 500 with the
      // message still there. The floor is conditional on `deleted_at` for that reason, and this is
      // the case that keeps it that way.
      const a = await seedVoice(sql, 'whisper-a')
      const b = await seedVoice(sql, 'whisper-b')
      const thread = await sql<{ id: string }[]>`
        insert into whisper_threads (pair_key) values (${[a.id, b.id].sort().join(':')})
        returning id
      `
      const threadId = thread[0]!.id
      await assert.rejects(
        () => sql`
          insert into whispers (thread_id, voice_id, body) values (${threadId}, ${a.id}, '')
        `,
        /whispers_body_len/,
      )
      const sent = await sql<{ id: string }[]>`
        insert into whispers (thread_id, voice_id, body) values (${threadId}, ${a.id}, 'said it')
        returning id
      `
      await sql`
        update whispers set body = '', deleted_at = now() where id = ${sent[0]!.id}
      `
    })
  })

  describe('whisper_threads_pair_uniq', () => {
    before(async () => {
      await resetAgora(sql)
    })

    it('admits one thread per pair, whichever side asks', async () => {
      const a = await seedVoice(sql, 'pair-a')
      const b = await seedVoice(sql, 'pair-b')
      const key = [a.id, b.id].sort().join(':')
      await sql`insert into whisper_threads (pair_key) values (${key})`
      // The second insert is the double-click. Without the unique index it opens a second thread,
      // the reply lands in one of them, and the recipient answers into the other.
      await assert.rejects(
        () => sql`insert into whisper_threads (pair_key) values (${key})`,
        /whisper_threads_pair_uniq/,
      )
    })
  })

  describe('voices', () => {
    before(async () => {
      await resetAgora(sql)
    })

    it('refuses a handle the parser would not produce', async () => {
      await assert.rejects(
        () => sql`insert into voices (subject, handle) values ('user:shape', 'Has-Caps')`,
        /voices_handle_shape/,
      )
    })

    it('refuses a second voice for one account', async () => {
      await sql`insert into voices (subject, handle) values ('user:one', ${uniqueHandle()})`
      // One voice per account, deliberately: an ecosystem account is the unit of trust everywhere
      // else in the estate, and an alt here would make the moderation record meaningless.
      await assert.rejects(
        () => sql`insert into voices (subject, handle) values ('user:one', ${uniqueHandle()})`,
        /voices_subject_uniq/,
      )
    })

    it('refuses two voices with the same handle', async () => {
      const handle = uniqueHandle('taken')
      await sql`insert into voices (subject, handle) values ('user:h1', ${handle})`
      await assert.rejects(
        () => sql`insert into voices (subject, handle) values ('user:h2', ${handle})`,
        /voices_handle_uniq/,
      )
    })
  })

  describe('bars', () => {
    before(async () => {
      await resetAgora(sql)
    })

    it('refuses a voice barring itself', async () => {
      const a = await seedVoice(sql, 'bar-self')
      await assert.rejects(
        () => sql`insert into bars (voice_id, barred_id) values (${a.id}, ${a.id})`,
        /bars_not_self/,
      )
    })

    it('is readable from the barred side without a scan', async () => {
      // `bars_reverse_idx` is what makes "is anybody who barred me in this page" cheap, and every
      // timeline asks it on every read. Proving the index EXISTS is the honest test — proving the
      // planner uses it on a table of four rows would prove nothing.
      const rows = await sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes where indexname = 'bars_reverse_idx'
      `
      assert.equal(rows.length, 1, 'bars_reverse_idx is missing')
      assert.match(rows[0]!.indexdef, /\(barred_id, voice_id\)/)
    })
  })

  describe('follows', () => {
    before(async () => {
      await resetAgora(sql)
    })

    it('refuses a self-follow and an invented state', async () => {
      const a = await seedVoice(sql, 'follow-self')
      await assert.rejects(
        () => sql`insert into follows (follower_id, followee_id) values (${a.id}, ${a.id})`,
        /follows_not_self/,
      )
      const b = await seedVoice(sql, 'follow-other')
      await assert.rejects(
        () => sql`
          insert into follows (follower_id, followee_id, state)
          values (${a.id}, ${b.id}, 'blocked')
        `,
        /follows_state/,
      )
    })
  })

  describe('posts', () => {
    before(async () => {
      await resetAgora(sql)
    })

    it('refuses a circle post with no circle, and a public post with one', async () => {
      const a = await seedVoice(sql, 'circle-shape')
      await assert.rejects(
        () => sql`
          insert into posts (voice_id, body, visibility) values (${a.id}, 'hello', 'circle')
        `,
        /posts_circle_shape/,
      )
    })

    it('refuses a post that replies to itself', async () => {
      const a = await seedVoice(sql, 'self-reply')
      const post = await insertPost(sql, a.id, 'hello')
      await assert.rejects(
        () => sql`update posts set in_reply_to_id = ${post} where id = ${post}`,
        /posts_no_self_reply/,
      )
    })

    it('refuses a body wider than the column', async () => {
      const a = await seedVoice(sql, 'too-long')
      await assert.rejects(
        () => sql`insert into posts (voice_id, body) values (${a.id}, ${'x'.repeat(4_001)})`,
        /posts_body_len/,
      )
    })

    it('makes one idempotency key one post, per voice', async () => {
      const a = await seedVoice(sql, 'idem-a')
      const b = await seedVoice(sql, 'idem-b')
      await sql`
        insert into posts (voice_id, body, idempotency_key) values (${a.id}, 'one', 'k')
      `
      await assert.rejects(
        () => sql`
          insert into posts (voice_id, body, idempotency_key) values (${a.id}, 'two', 'k')
        `,
        /posts_idempotency_uniq/,
      )
      // Per voice, not global: two people whose clients generated the same key are two posts.
      await sql`insert into posts (voice_id, body, idempotency_key) values (${b.id}, 'three', 'k')`
    })
  })

  describe('reports', () => {
    before(async () => {
      await resetAgora(sql)
    })

    it('records one report per reporter per subject', async () => {
      const a = await seedVoice(sql, 'reporter')
      const b = await seedVoice(sql, 'reported')
      await sql`
        insert into reports (reporter_id, subject_kind, subject_id, reason)
        values (${a.id}, 'voice', ${b.id}, 'spam')
      `
      // The second filing is a no-op rather than an error to the person: `moderation.ts` answers
      // the same either way, because "you already reported this" invites an argument about whether
      // the first one was seen.
      await assert.rejects(
        () => sql`
          insert into reports (reporter_id, subject_kind, subject_id, reason)
          values (${a.id}, 'voice', ${b.id}, 'abuse')
        `,
        /reports_reporter_subject_uniq/,
      )
    })
  })
})

/** A post written straight to the table, with no route and no domain function between. */
async function insertPost(sql: postgres.Sql, voiceId: string, body: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into posts (voice_id, body) values (${voiceId}, ${body}) returning id
  `
  return rows[0]!.id
}
