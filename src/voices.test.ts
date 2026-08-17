/**
 * Voices, follows, and the two refusals: a bar and a hush.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A BAR IS SYMMETRIC AND TOTAL, AND IT DELETES BOTH FOLLOWS.**
 *
 * `migrations.ts` records that this cannot be a constraint — a trigger could not make it one
 * without recursing — so it is a transaction in `voices.ts` and a set of cases here. Half a bar is
 * worse than none, because the person who set it believes they are no longer reachable and stops
 * checking.
 *
 * The follow deletion runs even when the bar row already existed. That looks like wasted work and
 * is not: a follow created BETWEEN two bars of the same person is exactly the state it cleans up,
 * and `bars again, and cleans up a follow made in between` is the case that would go silently red
 * if somebody moved it inside the `if (rows[0])`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { strict as assert } from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import {
  HandleTakenError,
  VoiceError,
  VoiceStateError,
  acceptFollow,
  bar,
  barredEitherWay,
  countsFor,
  ensureVoice,
  findVoiceByHandle,
  follow,
  followsActive,
  hush,
  hushTag,
  listVoices,
  rejectFollow,
  relationship,
  unbar,
  unfollow,
  unhush,
  updateVoice,
} from './voices.ts'
import {
  asDb,
  asTx,
  migrateTestDb,
  openDb,
  resetAgora,
  seedNamed,
  seedVoice,
  skip,
  subject,
  testDeps,
  uniqueHandle,
} from './testsupport.ts'

describe('voices', { skip }, () => {
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

  describe('materialising a voice', () => {
    it('is idempotent for one account, and derives a handle from nothing personal', async () => {
      const first = await seedVoice(sql, 'someone')
      const second = await seedVoice(sql, 'someone')
      assert.equal(second.id, first.id)
      // `u` plus eight hex characters of the subject. NOT an email local part and not a display
      // name: a default handle that leaked either would publish something the person never chose
      // to, at the moment they first posted.
      assert.match(first.handle, /^u[0-9a-f]{8}\d*$/)
    })

    it('gives the second account a different handle when the first is taken', async () => {
      // The seed is derived from the subject's hex, so two subjects with the same hex prefix
      // collide by construction. The loop must resolve it rather than raising.
      const a = await sql.begin(async (tx) => ({
        value: await ensureVoice(asTx(tx), 'user:abcdef01-1111-1111-1111-111111111111'),
      }))
      const b = await sql.begin(async (tx) => ({
        value: await ensureVoice(asTx(tx), 'user:abcdef01-2222-2222-2222-222222222222'),
      }))
      assert.notEqual(a.value.handle, b.value.handle)
      assert.equal(b.value.handle, `${a.value.handle}1`)
    })

    it('starts nobody with an email preferences row', async () => {
      // The absence IS the opt-in. See `notifications.ts`: a materialised default is a decision
      // taken on somebody's behalf about being mailed, and it is not recoverable after the send.
      const voice = await seedVoice(sql, 'fresh')
      const rows = await sql<{ n: string }[]>`
        select count(*) as n from email_prefs where voice_id = ${voice.id}
      `
      assert.equal(Number(rows[0]!.n), 0)
    })
  })

  describe('choosing a handle', () => {
    it('takes a handle and lowercases it', async () => {
      const handle = uniqueHandle('chosen')
      const voice = await updateVoice(deps.voices, subject('picky'), { handle: handle.toUpperCase() })
      assert.equal(voice.handle, handle)
      assert.ok(await findVoiceByHandle(asDb(sql), handle))
    })

    it('refuses a handle somebody else holds', async () => {
      const handle = uniqueHandle('contested')
      await updateVoice(deps.voices, subject('first'), { handle })
      await assert.rejects(
        () => updateVoice(deps.voices, subject('second'), { handle }),
        HandleTakenError,
      )
    })

    it('refuses a handle that would collide with a route or the estate', async () => {
      // `/settings` and `/@settings` are told apart by the `@`; a link that loses it points at the
      // wrong page. And an account called `support` on a square where money is discussed is a
      // phishing kit with a profile picture.
      //
      // The same error as a handle somebody else holds, on purpose: "not available" is true of both
      // and an answer that distinguished them would be an inventory of the reserved list.
      for (const reserved of ['settings', 'support', 'cloudsforge']) {
        await assert.rejects(
          () => updateVoice(deps.voices, subject('impostor'), { handle: reserved }),
          HandleTakenError,
          `${reserved} was allowed`,
        )
      }
    })

    it('refuses a handle the column could not store', async () => {
      await assert.rejects(
        () => updateVoice(deps.voices, subject('shape'), { handle: 'has-a-dash' }),
        VoiceError,
      )
    })
  })

  describe('following', () => {
    it('is active for an open voice and pending for a protected one', async () => {
      const open = await seedVoice(sql, 'open')
      const shy = await seedVoice(sql, 'shy')
      await sql`update voices set protected = true where id = ${shy.id}`

      assert.deepEqual(await follow(deps.voices, subject('reader'), open.id), {
        state: 'active',
        created: true,
      })
      assert.deepEqual(await follow(deps.voices, subject('reader'), shy.id), {
        state: 'pending',
        created: true,
      })
    })

    it('tells a second follow from a first without changing anything', async () => {
      const target = await seedVoice(sql, 'target')
      await follow(deps.voices, subject('reader'), target.id)
      const again = await follow(deps.voices, subject('reader'), target.id)
      assert.equal(again.created, false)
      assert.equal(again.state, 'active')
    })

    it('refuses a self-follow', async () => {
      const me = await seedVoice(sql, 'narcissus')
      await assert.rejects(() => follow(deps.voices, subject('narcissus'), me.id), VoiceError)
    })

    it('lets a protected voice accept or reject a request', async () => {
      const shy = await seedVoice(sql, 'shy')
      await sql`update voices set protected = true where id = ${shy.id}`
      const asker = await seedVoice(sql, 'asker')
      const other = await seedVoice(sql, 'other')
      await follow(deps.voices, subject('asker'), shy.id)
      await follow(deps.voices, subject('other'), shy.id)

      assert.equal(await acceptFollow(deps.voices, subject('shy'), asker.id), true)
      assert.equal(await followsActive(asDb(sql), asker.id, shy.id), true)

      assert.equal(await rejectFollow(deps.voices, subject('shy'), other.id), true)
      assert.equal(await followsActive(asDb(sql), other.id, shy.id), false)
      const left = await sql<{ n: string }[]>`
        select count(*) as n from follows
         where follower_id = ${other.id} and followee_id = ${shy.id}
      `
      assert.equal(Number(left[0]!.n), 0, 'a rejected request is removed, not left pending')
    })

    it('counts followers for the account’s own eyes and nothing else', async () => {
      // There is no stored follower count and no view count anywhere in the schema, on purpose:
      // a number nobody can see cannot become the number everybody optimises for.
      const star = await seedVoice(sql, 'star')
      await follow(deps.voices, subject('fan_one'), star.id)
      await follow(deps.voices, subject('fan_two'), star.id)
      const counts = await countsFor(asDb(sql), star.id)
      assert.equal(counts.followers, 2)

      const columns = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_name = 'voices' and column_name in ('follower_count', 'view_count')
      `
      assert.equal(columns.length, 0, 'a stored count is a count somebody will start optimising')
    })

    it('unfollows', async () => {
      const target = await seedVoice(sql, 'target')
      await follow(deps.voices, subject('reader'), target.id)
      assert.equal(await unfollow(deps.voices, subject('reader'), target.id), true)
      assert.equal(await unfollow(deps.voices, subject('reader'), target.id), false)
    })
  })

  describe('a bar', () => {
    it('deletes both follows in the same transaction that sets it', async () => {
      const a = await seedVoice(sql, 'barrer')
      const b = await seedVoice(sql, 'barred')
      await follow(deps.voices, subject('barrer'), b.id)
      await follow(deps.voices, subject('barred'), a.id)

      await bar(deps.voices, subject('barrer'), b.id)

      const rows = await sql<{ n: string }[]>`select count(*) as n from follows`
      assert.equal(Number(rows[0]!.n), 0, 'a bar that leaves a follow in place does not work')
    })

    it('reads the same from either side', async () => {
      const a = await seedVoice(sql, 'barrer')
      const b = await seedVoice(sql, 'barred')
      await bar(deps.voices, subject('barrer'), b.id)
      assert.equal(await barredEitherWay(asDb(sql), a.id, b.id), true)
      assert.equal(await barredEitherWay(asDb(sql), b.id, a.id), true)
    })

    it('bars again, and cleans up a follow made in between', async () => {
      // The idempotent path still runs the deletion. Moving it inside `if (rows[0])` would leave
      // exactly this follow behind, and nothing would say so.
      const a = await seedVoice(sql, 'barrer')
      const b = await seedVoice(sql, 'barred')
      await bar(deps.voices, subject('barrer'), b.id)
      await sql`insert into follows (follower_id, followee_id) values (${b.id}, ${a.id})`

      const second = await bar(deps.voices, subject('barrer'), b.id)
      assert.equal(second, false, 'the row already existed')
      const rows = await sql<{ n: string }[]>`select count(*) as n from follows`
      assert.equal(Number(rows[0]!.n), 0, 'and the follow made in between is gone')
    })

    it('answers a follow across it as if the voice were not there', async () => {
      // Telling somebody they have been barred is telling them to make another account, and the
      // person who set the bar did not ask for that conversation.
      const a = await seedVoice(sql, 'barrer')
      const b = await seedVoice(sql, 'barred')
      await bar(deps.voices, subject('barrer'), b.id)
      await assert.rejects(
        () => follow(deps.voices, subject('barred'), a.id),
        (err: Error) => {
          assert.ok(err instanceof VoiceStateError)
          assert.equal(err.message, 'no such voice', 'the same message a stranger gets')
          return true
        },
      )
    })

    it('lifts', async () => {
      const b = await seedVoice(sql, 'barred')
      await bar(deps.voices, subject('barrer'), b.id)
      assert.equal(await unbar(deps.voices, subject('barrer'), b.id), true)
      const a = await seedVoice(sql, 'barrer')
      assert.equal(await barredEitherWay(asDb(sql), a.id, b.id), false)
    })

    it('leaves the whisper thread in place', async () => {
      // Deleting it would delete the recipient's copy of a conversation they may need as evidence
      // for the report they are about to file.
      const a = await seedVoice(sql, 'barrer')
      const b = await seedVoice(sql, 'barred')
      const key = [a.id, b.id].sort().join(':')
      const thread = await sql<{ id: string }[]>`
        insert into whisper_threads (pair_key) values (${key}) returning id
      `
      await bar(deps.voices, subject('barrer'), b.id)
      const still = await sql<{ n: string }[]>`
        select count(*) as n from whisper_threads where id = ${thread[0]!.id}
      `
      assert.equal(Number(still[0]!.n), 1)
    })
  })

  describe('a hush', () => {
    it('is one-directional, silent, and leaves the follow alone', async () => {
      const me = await seedVoice(sql, 'me')
      const noisy = await seedVoice(sql, 'noisy')
      await follow(deps.voices, subject('me'), noisy.id)
      await hush(deps.voices, subject('me'), noisy.id, null)

      assert.equal(await followsActive(asDb(sql), me.id, noisy.id), true)
      // The distinction most networks make you express by unfollowing a friend.
      const theirView = await relationship(asDb(sql), noisy.id, me.id)
      assert.equal(theirView.hushed, false, 'the hushed voice is not told')
      const myView = await relationship(asDb(sql), me.id, noisy.id)
      assert.equal(myView.hushed, true)
    })

    it('can be temporary, which is the difference between “not today” and “not ever”', async () => {
      const noisy = await seedVoice(sql, 'noisy')
      const until = new Date(Date.now() + 3_600_000)
      await hush(deps.voices, subject('me'), noisy.id, until)
      const rows = await sql<{ expires_at: Date | null }[]>`select expires_at from hushes`
      assert.ok(rows[0]!.expires_at)
    })

    it('lifts, and hushes a tag as well as a voice', async () => {
      const noisy = await seedVoice(sql, 'noisy')
      await hush(deps.voices, subject('me'), noisy.id, null)
      assert.equal(await unhush(deps.voices, subject('me'), noisy.id), true)

      await hushTag(deps.voices, subject('me'), 'Ember', null)
      const rows = await sql<{ tag: string }[]>`select tag from tag_hushes`
      assert.deepEqual(rows.map((r) => r.tag), ['ember'], 'stored the way a post stores its tags')
    })
  })

  describe('the directory', () => {
    it('leaves out anybody suspended or undiscoverable', async () => {
      const shown = await seedNamed(sql, 'shown')
      const quiet = await seedNamed(sql, 'quiet')
      const gone = await seedNamed(sql, 'gone')
      await sql`update voices set discoverable = false where id = ${quiet.id}`
      await sql`update voices set suspended_at = now() where id = ${gone.id}`

      const page = await listVoices(asDb(sql), { limit: 50 })
      const ids = page.voices.map((v) => v.id)
      assert.ok(ids.includes(shown.id))
      assert.ok(!ids.includes(quiet.id))
      assert.ok(!ids.includes(gone.id))
    })
  })

  describe('the outbox', () => {
    it('records a bar without saying anything about why', async () => {
      const b = await seedVoice(sql, 'barred')
      await bar(deps.voices, subject('barrer'), b.id)
      const rows = await sql<{ topic: string; key: string }[]>`
        select topic, key from outbox where topic = 'agora.bar.created'
      `
      assert.equal(rows.length, 1)
      // Keyed on the RELATIONSHIP, not on either end of it: the contended resource is the pair.
      assert.match(rows[0]!.key, /^[0-9a-f-]{36}:[0-9a-f-]{36}$/)
    })

    it('emits nothing for a hush', async () => {
      // A hush is private by design. Putting it on the bus would publish the fact that somebody
      // quietly muted somebody else to every subscriber in the estate.
      const noisy = await seedVoice(sql, 'noisy')
      await hush(deps.voices, subject('me'), noisy.id, null)
      const rows = await sql<{ n: string }[]>`select count(*) as n from outbox`
      assert.equal(Number(rows[0]!.n), 0)
    })
  })
})
