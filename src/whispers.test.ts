/**
 * Whispers — the private half of the square.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE BODY NEVER LEAVES THIS SERVICE.**
 *
 * `agora.whisper.sent` carries a LENGTH. An event goes to every subscriber and lands in their
 * inbox table, so a body on the bus is a private message copied into services that have no idea it
 * was private and no policy for deleting it. `the outbox carries a length and never the words` is
 * the case, and it asserts on the serialised payload rather than on named fields, because a field
 * added later is exactly how this leaks.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The refusals differ on purpose, and the difference is the test
 *
 * A voice that takes no whispers is answered honestly — "this voice does not accept whispers" —
 * because the recipient is a public profile the sender is already looking at, and pretending they
 * vanished when you press send is a broken product rather than a private one.
 *
 * A BAR is answered as "no such voice". Telling somebody they have been barred is telling them to
 * make another account. `a bar is answered as if the voice were not there` and `a closed inbox is
 * answered honestly` are the pair, and swapping either message is a real defect that no other test
 * in this repository would notice.
 */

import { strict as assert } from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import {
  WhisperError,
  WhisperNotFoundError,
  WhisperRefusedError,
  deleteWhisper,
  leaveThread,
  listThreads,
  markRead,
  pairKey,
  readThread,
  sendWhisper,
  unreadCount,
} from './whispers.ts'
import { bar, follow, updateVoice } from './voices.ts'
import {
  asDb,
  migrateTestDb,
  openDb,
  resetAgora,
  seedVoice,
  skip,
  subject,
  testDeps,
} from './testsupport.ts'

describe('whispers', { skip }, () => {
  let sql: postgres.Sql
  let deps: ReturnType<typeof testDeps>

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })

  after(async () => {
    await sql.end()
  })

  beforeEach(async () => {
    await resetAgora(sql)
    deps = testDeps(sql)
  })

  describe('pairKey', () => {
    it('is the same from either side', () => {
      // Sorted, so the unique index on `pair_key` gives one thread per pair whoever sends first.
      // Concatenating in argument order would open a second thread on the reply.
      assert.equal(pairKey('b', 'a'), pairKey('a', 'b'))
    })
  })

  describe('sending', () => {
    it('opens a thread, enrols both, and does not make the sender unread', async () => {
      const you = await seedVoice(sql, 'you')
      const whisper = await sendWhisper(deps.whispers, subject('me'), you.id, 'are you around?')
      assert.equal(whisper.body, 'are you around?')

      const members = await sql<{ n: string }[]>`
        select count(*) as n from whisper_members where thread_id = ${whisper.threadId}
      `
      assert.equal(Number(members[0]!.n), 2)
      // Without the sender's own read mark, sending sets your own badge to one.
      assert.equal(await unreadCount(asDb(sql), whisper.voiceId), 0)
      assert.equal(await unreadCount(asDb(sql), you.id), 1)
    })

    it('reuses the thread when the other side answers', async () => {
      const you = await seedVoice(sql, 'you')
      const me = await seedVoice(sql, 'me')
      await sendWhisper(deps.whispers, subject('me'), you.id, 'first')
      await sendWhisper(deps.whispers, subject('you'), me.id, 'second')
      const threads = await sql<{ n: string }[]>`select count(*) as n from whisper_threads`
      assert.equal(Number(threads[0]!.n), 1, 'the reply opened a second thread')
    })

    it('notifies the recipient once and only the recipient', async () => {
      const you = await seedVoice(sql, 'you')
      await sendWhisper(deps.whispers, subject('me'), you.id, 'hello')
      const rows = await sql<{ voice_id: string; kind: string }[]>`
        select voice_id, kind from notifications
      `
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.voice_id, you.id)
      assert.equal(rows[0]!.kind, 'whisper')
    })

    it('refuses an empty whisper and one wider than a post', async () => {
      const you = await seedVoice(sql, 'you')
      await assert.rejects(
        () => sendWhisper(deps.whispers, subject('me'), you.id, '   '),
        WhisperError,
      )
      const tooLong = 'x'.repeat(2_001)
      await assert.rejects(
        () => sendWhisper(deps.whispers, subject('me'), you.id, tooLong),
        WhisperError,
      )
    })

    it('refuses a whisper to yourself', async () => {
      const me = await seedVoice(sql, 'me')
      await assert.rejects(
        () => sendWhisper(deps.whispers, subject('me'), me.id, 'note to self'),
        WhisperError,
      )
    })

    it('throttles per voice', async () => {
      const you = await seedVoice(sql, 'you')
      const limited = testDeps(sql, { whispersPerHour: 2 })
      await sendWhisper(limited.whispers, subject('me'), you.id, 'one')
      await sendWhisper(limited.whispers, subject('me'), you.id, 'two')
      await assert.rejects(
        () => sendWhisper(limited.whispers, subject('me'), you.id, 'three'),
        /too many whisper requests/,
      )
    })
  })

  describe('who may whisper to whom', () => {
    it('a closed inbox is answered honestly', async () => {
      const you = await updateVoice(deps.voices, subject('you'), { whispersFrom: 'nobody' })
      await assert.rejects(
        () => sendWhisper(deps.whispers, subject('me'), you.id, 'hello'),
        (err: Error) => {
          assert.ok(err instanceof WhisperRefusedError, `got ${err.name}`)
          assert.match(err.message, /does not accept whispers/)
          return true
        },
      )
    })

    it('“only voices I follow” means the recipient follows the sender', async () => {
      const you = await updateVoice(deps.voices, subject('you'), { whispersFrom: 'follows' })
      const me = await seedVoice(sql, 'me')
      await assert.rejects(
        () => sendWhisper(deps.whispers, subject('me'), you.id, 'hello'),
        WhisperRefusedError,
      )
      // The direction that matters: me following THEM buys nothing, which is the whole point of the
      // setting. Anyone can follow anyone; being followed back is a decision.
      await follow(deps.voices, subject('me'), you.id)
      await assert.rejects(
        () => sendWhisper(deps.whispers, subject('me'), you.id, 'hello'),
        WhisperRefusedError,
      )

      await follow(deps.voices, subject('you'), me.id)
      const sent = await sendWhisper(deps.whispers, subject('me'), you.id, 'hello')
      assert.equal(sent.body, 'hello')
    })

    it('a bar is answered as if the voice were not there', async () => {
      const you = await seedVoice(sql, 'you')
      await bar(deps.voices, subject('you'), (await seedVoice(sql, 'me')).id)
      await assert.rejects(
        () => sendWhisper(deps.whispers, subject('me'), you.id, 'hello'),
        (err: Error) => {
          assert.ok(err instanceof WhisperNotFoundError, `got ${err.name}`)
          assert.match(err.message, /no such voice/)
          return true
        },
      )
    })

    it('checks the bar before the preference, so an open inbox does not leak it', async () => {
      // Order matters. With the preference first, a barred sender of a `whispersFrom: 'nobody'`
      // recipient gets "does not accept whispers" and a barred sender of an open one gets "no such
      // voice" — and the difference tells them which they are.
      const you = await updateVoice(deps.voices, subject('you'), { whispersFrom: 'nobody' })
      await bar(deps.voices, subject('you'), (await seedVoice(sql, 'me')).id)
      await assert.rejects(
        () => sendWhisper(deps.whispers, subject('me'), you.id, 'hello'),
        WhisperNotFoundError,
      )
    })

    it('a suspended voice cannot send', async () => {
      const you = await seedVoice(sql, 'you')
      const me = await seedVoice(sql, 'me')
      await sql`update voices set suspended_at = now() where id = ${me.id}`
      await assert.rejects(
        () => sendWhisper(deps.whispers, subject('me'), you.id, 'hello'),
        WhisperRefusedError,
      )
    })
  })

  describe('reading', () => {
    it('refuses a stranger the thread, as a 404', async () => {
      const you = await seedVoice(sql, 'you')
      const stranger = await seedVoice(sql, 'stranger')
      const whisper = await sendWhisper(deps.whispers, subject('me'), you.id, 'private')
      await assert.rejects(
        () => readThread(deps.whispers, stranger.id, whisper.threadId, { limit: 20 }),
        WhisperNotFoundError,
      )
    })

    it('pages newest first, and the cursor does not overlap', async () => {
      const you = await seedVoice(sql, 'you')
      for (const body of ['one', 'two', 'three']) {
        await sendWhisper(deps.whispers, subject('me'), you.id, body)
      }
      const first = await readThread(deps.whispers, you.id, await onlyThread(sql), { limit: 2 })
      assert.deepEqual(first.whispers.map((w) => w.body), ['three', 'two'])
      assert.ok(first.nextCursor)
      const second = await readThread(deps.whispers, you.id, await onlyThread(sql), {
        limit: 2,
        cursor: first.nextCursor,
      })
      assert.deepEqual(second.whispers.map((w) => w.body), ['one'])
    })

    it('lists conversations with an unread count and a preview, not a whole message', async () => {
      const you = await seedVoice(sql, 'you')
      await sendWhisper(deps.whispers, subject('me'), you.id, 'x'.repeat(400))
      const threads = await listThreads(deps.whispers, you.id)
      assert.equal(threads.length, 1)
      assert.equal(threads[0]!.unread, 1)
      // A thousand-character message rendered into a conversation list is a list with one item.
      assert.equal(threads[0]!.lastBody.length, 140)
      assert.ok(threads[0]!.other.handle)
    })

    it('marks read, and reading does not un-read', async () => {
      const you = await seedVoice(sql, 'you')
      const whisper = await sendWhisper(deps.whispers, subject('me'), you.id, 'hello')
      await markRead(deps.whispers, you.id, whisper.threadId)
      assert.equal(await unreadCount(asDb(sql), you.id), 0)
      await markRead(deps.whispers, you.id, whisper.threadId)
      assert.equal(await unreadCount(asDb(sql), you.id), 0, 'a second mark moved it backwards')
    })
  })

  describe('leaving and deleting', () => {
    it('leaving is per-member and does not take the other side’s copy', async () => {
      const you = await seedVoice(sql, 'you')
      const whisper = await sendWhisper(deps.whispers, subject('me'), you.id, 'hello')
      assert.equal(await leaveThread(deps.whispers, you.id, whisper.threadId), true)
      assert.equal(await leaveThread(deps.whispers, you.id, whisper.threadId), false)

      // Deleting the thread would be one person erasing another's record of what was said.
      const still = await readThread(deps.whispers, whisper.voiceId, whisper.threadId, { limit: 10 })
      assert.equal(still.whispers.length, 1)
    })

    it('a deleted whisper leaves a marked row rather than vanishing', async () => {
      const you = await seedVoice(sql, 'you')
      const whisper = await sendWhisper(deps.whispers, subject('me'), you.id, 'said too much')
      assert.equal(await deleteWhisper(deps.whispers, subject('me'), whisper.id), true)

      const seen = await readThread(deps.whispers, you.id, whisper.threadId, { limit: 10 })
      assert.equal(seen.whispers.length, 1, 'a message that vanishes is a gaslighting primitive')
      assert.equal(seen.whispers[0]!.deleted, true)
      assert.equal(seen.whispers[0]!.body, '')
      assert.equal(await unreadCount(asDb(sql), you.id), 0, 'a deleted message is not unread')
    })

    it('will not delete somebody else’s whisper', async () => {
      const you = await seedVoice(sql, 'you')
      const whisper = await sendWhisper(deps.whispers, subject('me'), you.id, 'mine')
      assert.equal(await deleteWhisper(deps.whispers, subject('you'), whisper.id), false)
    })
  })

  describe('the outbox', () => {
    it('carries a length and never the words', async () => {
      const you = await seedVoice(sql, 'you')
      const secret = 'the seed phrase is written on the back of the photograph'
      await sendWhisper(deps.whispers, subject('me'), you.id, secret)

      const rows = await sql<{ topic: string; payload: Record<string, unknown> }[]>`
        select topic, payload from outbox
      `
      assert.equal(rows[0]!.topic, 'agora.whisper.sent')
      assert.equal(rows[0]!.payload.length, secret.length)
      // On the serialised payload, not on named fields: a field added later is how this leaks.
      assert.equal(JSON.stringify(rows[0]!.payload).includes('seed phrase'), false)
      assert.equal(JSON.stringify(rows[0]!.payload).includes('photograph'), false)
    })
  })
})

async function onlyThread(sql: postgres.Sql): Promise<string> {
  const rows = await sql<{ id: string }[]>`select id from whisper_threads limit 1`
  return rows[0]!.id
}
