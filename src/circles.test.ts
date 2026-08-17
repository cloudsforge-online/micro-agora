/**
 * Circles, and the two rules that keep a room usable after the person who made it stops caring.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE LAST STEWARD CANNOT WALK OUT OF A ROOM THAT STILL HAS PEOPLE IN IT.**
 *
 * `the last steward is refused, and told what to do instead` is the case, and `the last steward may
 * leave once the room is empty` is its pair — without the second one the rule reads as "a steward
 * can never leave", which is a different and much worse rule that somebody would eventually relax
 * by deleting the check rather than by adding the exception.
 *
 * The failure this prevents is not an error message. It is a circle with members, a spam post at
 * the top, and nobody with the standing to remove it — recoverable only by an operator running an
 * UPDATE against production, which is a support ticket standing in for a product decision.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The second rule: archiving is not deleting
 *
 * `archiving takes the room off the directory and leaves the conversation` writes a post into a
 * circle, archives it, and reads the post back. A circle's archive is somebody's conversation, and
 * the tempting implementation — cascade the posts away with the room — destroys a record they did
 * not agree to lose. `posts_circle_fk` IS `on delete cascade`, which is why this test matters: the
 * mechanism for losing the posts is already in the schema, one `delete from circles` away, and the
 * only thing keeping it from firing is that archiving sets a timestamp instead.
 *
 * ## What is a 404 here
 *
 * A banned member who asks to join again is answered `CircleNotFoundError`, the same as somebody
 * asking about a circle that does not exist. Anything else — "you are banned" — is an invitation to
 * argue that the ban has served its time, aimed at a steward who did not ask to have that
 * conversation. The same reasoning makes `assertSteward` raise not-found rather than forbidden.
 */

import { strict as assert } from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import {
  CircleError,
  CircleNotFoundError,
  CircleStateError,
  canRead,
  createCircle,
  decideMembership,
  findCircle,
  inviteToCircle,
  joinCircle,
  leaveCircle,
  listCircles,
  listMembers,
  myCircles,
  removeMember,
  setRole,
  updateCircle,
} from './circles.ts'
import { createPost, byCircle } from './posts.ts'
import { bar } from './voices.ts'
import { listNotifications } from './notifications.ts'
import {
  migrateTestDb,
  openDb,
  resetAgora,
  seedVoice,
  skip,
  subject,
  testDeps,
  uniqueHandle,
} from './testsupport.ts'

describe('circles', { skip }, () => {
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

  /* ---------------------------------------------------------------- making one */

  describe('making one', () => {
    it('makes the creator a steward rather than an owner', async () => {
      const circle = await createCircle(deps.circles, subject('founder'), {
        slug: uniqueHandle('room'),
        name: 'The Room',
        purpose: 'somewhere to talk',
      })
      const me = await seedVoice(sql, 'founder')
      const members = await listMembers(deps.sql, circle.id, null)
      assert.equal(members.length, 1)
      assert.equal(members[0]!.voiceId, me.id)
      // The word matters: `role` is what `setRole` transfers. An `owner_id` column on `circles`
      // would be a value only a migration could move.
      assert.equal(members[0]!.role, 'steward')
      const columns = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_name = 'circles'
      `
      assert.ok(
        !columns.some((c) => c.column_name === 'owner_id'),
        'circles grew an owner_id, and stewardship stopped being transferable',
      )
    })

    it('refuses an address the URL could not carry, and one already taken', async () => {
      const slug = uniqueHandle('taken')
      await createCircle(deps.circles, subject('first'), { slug, name: 'First' })
      await assert.rejects(
        () => createCircle(deps.circles, subject('second'), { slug, name: 'Second' }),
        (err: Error) => {
          assert.ok(err instanceof CircleStateError)
          assert.match(err.message, /is taken/)
          return true
        },
      )
      await assert.rejects(
        () => createCircle(deps.circles, subject('third'), { slug: 'Has Caps', name: 'No' }),
        CircleError,
      )
      await assert.rejects(
        () => createCircle(deps.circles, subject('third'), { slug: 'x', name: 'Too short' }),
        CircleError,
      )
    })

    it('is found by its address as well as its id, and the address is not case sensitive', async () => {
      const slug = uniqueHandle('byslug')
      const made = await createCircle(deps.circles, subject('finder'), { slug, name: 'By Slug' })
      const bySlug = await findCircle(deps.sql, slug.toUpperCase(), null)
      assert.equal(bySlug?.id, made.id)
      const byId = await findCircle(deps.sql, made.id, null)
      assert.equal(byId?.slug, slug)
    })

    it('will not let a suspended voice open a room', async () => {
      const voice = await seedVoice(sql, 'suspended-founder')
      await sql`update voices set suspended_at = now() where id = ${voice.id}`
      await assert.rejects(
        () =>
          createCircle(deps.circles, subject('suspended-founder'), {
            slug: uniqueHandle('nope'),
            name: 'Nope',
          }),
        CircleStateError,
      )
    })

    it('announces the circle on the outbox', async () => {
      const slug = uniqueHandle('announced')
      const circle = await createCircle(deps.circles, subject('crier'), { slug, name: 'Announced' })
      const rows = await sql<{ topic: string; key: string }[]>`select topic, key from outbox`
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.topic, 'agora.circle.created')
      assert.equal(rows[0]!.key, circle.id)
    })
  })

  /* ---------------------------------------------------------------- getting in */

  describe('getting in', () => {
    it('admits at once to an open circle and holds a request for a stewards decision', async () => {
      const open = await createCircle(deps.circles, subject('s1'), {
        slug: uniqueHandle('open'),
        name: 'Open',
        visibility: 'open',
      })
      const ask = await createCircle(deps.circles, subject('s2'), {
        slug: uniqueHandle('ask'),
        name: 'Ask',
        visibility: 'request',
      })

      assert.deepEqual(await joinCircle(deps.circles, subject('walker'), open.id), {
        state: 'active',
        created: true,
      })
      assert.deepEqual(await joinCircle(deps.circles, subject('walker'), ask.id), {
        state: 'pending',
        created: true,
      })

      // The steward hears about the request. Without this the pending row is a decision nobody
      // knows they were asked to make, and the person waiting reads it as a rejection.
      const steward = await seedVoice(sql, 's2')
      const { notifications } = await listNotifications(deps.notifications, steward.id, { limit: 10 })
      assert.equal(notifications.length, 1)
      assert.equal(notifications[0]!.kind, 'circle_request')
      assert.equal(notifications[0]!.circleId, ask.id)
    })

    it('refuses a closed circle to somebody who was not invited', async () => {
      const closed = await createCircle(deps.circles, subject('s3'), {
        slug: uniqueHandle('closed'),
        name: 'Closed',
        visibility: 'closed',
      })
      await assert.rejects(
        () => joinCircle(deps.circles, subject('outsider'), closed.id),
        (err: Error) => {
          assert.ok(err instanceof CircleStateError)
          assert.match(err.message, /invitation only/)
          return true
        },
      )
      // …and an invitation is the way in, which is the half that makes the refusal fair.
      const invited = await seedVoice(sql, 'outsider')
      assert.equal(
        await inviteToCircle(deps.circles, subject('s3'), closed.id, invited.id),
        true,
      )
      assert.deepEqual(await joinCircle(deps.circles, subject('outsider'), closed.id), {
        state: 'active',
        created: false,
      })
    })

    it('answers a banned member as if the circle were not there', async () => {
      const circle = await createCircle(deps.circles, subject('s4'), {
        slug: uniqueHandle('banned'),
        name: 'Banned',
      })
      const pest = await seedVoice(sql, 'pest')
      await joinCircle(deps.circles, subject('pest'), circle.id)
      assert.equal(await removeMember(deps.circles, subject('s4'), circle.id, pest.id, true), true)

      // Not `CircleStateError('you are banned')`. See the header: that sentence is the start of an
      // argument with a steward who already decided.
      await assert.rejects(
        () => joinCircle(deps.circles, subject('pest'), circle.id),
        CircleNotFoundError,
      )
      const active = await listMembers(deps.sql, circle.id, null)
      assert.equal(active.length, 1, 'the ban left them counted as a member')
    })

    it('is idempotent: joining twice is joining once', async () => {
      const circle = await createCircle(deps.circles, subject('s5'), {
        slug: uniqueHandle('twice'),
        name: 'Twice',
      })
      await joinCircle(deps.circles, subject('eager'), circle.id)
      const again = await joinCircle(deps.circles, subject('eager'), circle.id)
      assert.deepEqual(again, { state: 'active', created: false })
      assert.equal((await listMembers(deps.sql, circle.id, null)).length, 2)
    })

    it('refuses to join an archived circle', async () => {
      const circle = await createCircle(deps.circles, subject('s6'), {
        slug: uniqueHandle('shut'),
        name: 'Shut',
      })
      await updateCircle(deps.circles, subject('s6'), circle.id, { archived: true })
      await assert.rejects(
        () => joinCircle(deps.circles, subject('latecomer'), circle.id),
        CircleStateError,
      )
    })

    it('admits a pending member, tells them, and deletes a refused request', async () => {
      const circle = await createCircle(deps.circles, subject('s7'), {
        slug: uniqueHandle('decide'),
        name: 'Decide',
        visibility: 'request',
      })
      const yes = await seedVoice(sql, 'yes')
      const no = await seedVoice(sql, 'no')
      await joinCircle(deps.circles, subject('yes'), circle.id)
      await joinCircle(deps.circles, subject('no'), circle.id)

      assert.equal(await decideMembership(deps.circles, subject('s7'), circle.id, yes.id, true), true)
      const told = await listNotifications(deps.notifications, yes.id, { limit: 10 })
      assert.equal(told.notifications[0]?.kind, 'circle_accepted')

      assert.equal(await decideMembership(deps.circles, subject('s7'), circle.id, no.id, false), true)
      // Refused means the row is GONE, not left pending. A pending row nobody will look at again is
      // a person waiting for ever, and it also blocks them ever asking a second time.
      const rows = await sql<{ n: string }[]>`
        select count(*) as n from circle_members
         where circle_id = ${circle.id} and voice_id = ${no.id}
      `
      assert.equal(Number(rows[0]!.n), 0)
      const refused = await listNotifications(deps.notifications, no.id, { limit: 10 })
      assert.equal(refused.notifications.length, 0, 'a refusal was announced')
    })

    it('answers a member who is not a steward with not-found, never with forbidden', async () => {
      const circle = await createCircle(deps.circles, subject('s8'), {
        slug: uniqueHandle('plain'),
        name: 'Plain',
      })
      const other = await seedVoice(sql, 'plain-member')
      await joinCircle(deps.circles, subject('plain-member'), circle.id)
      const third = await seedVoice(sql, 'third')
      await assert.rejects(
        () => inviteToCircle(deps.circles, subject('plain-member'), circle.id, third.id),
        CircleNotFoundError,
      )
      await assert.rejects(
        () => setRole(deps.circles, subject('plain-member'), circle.id, other.id, 'steward'),
        CircleNotFoundError,
      )
    })
  })

  /* ---------------------------------------------------------------- the steward rule */

  describe('stewardship', () => {
    it('the last steward is refused, and told what to do instead', async () => {
      const circle = await createCircle(deps.circles, subject('lonely'), {
        slug: uniqueHandle('lonely'),
        name: 'Lonely',
      })
      await joinCircle(deps.circles, subject('resident'), circle.id)

      await assert.rejects(
        () => leaveCircle(deps.circles, subject('lonely'), circle.id),
        (err: Error) => {
          assert.ok(err instanceof CircleStateError)
          // The message names both exits. A refusal that does not is a dead end, and the person who
          // hits it writes to support instead of appointing somebody.
          assert.match(err.message, /appoint another steward/)
          assert.match(err.message, /archive the circle/)
          return true
        },
      )
      const still = await sql<{ n: string }[]>`
        select count(*) as n from circle_members where circle_id = ${circle.id}
      `
      assert.equal(Number(still[0]!.n), 2)
    })

    it('the last steward may leave once the room is empty', async () => {
      // The other half. Without this the rule is "a steward may never leave", which is what somebody
      // would eventually fix by deleting the check rather than by adding this case.
      const circle = await createCircle(deps.circles, subject('solo'), {
        slug: uniqueHandle('solo'),
        name: 'Solo',
      })
      assert.equal(await leaveCircle(deps.circles, subject('solo'), circle.id), true)
      assert.equal((await listMembers(deps.sql, circle.id, null)).length, 0)
    })

    it('lets a steward hand the room over and then leave', async () => {
      const circle = await createCircle(deps.circles, subject('handover'), {
        slug: uniqueHandle('handover'),
        name: 'Handover',
      })
      const heir = await seedVoice(sql, 'heir')
      await joinCircle(deps.circles, subject('heir'), circle.id)
      assert.equal(await setRole(deps.circles, subject('handover'), circle.id, heir.id, 'steward'), true)
      assert.equal(await leaveCircle(deps.circles, subject('handover'), circle.id), true)

      const left = await listMembers(deps.sql, circle.id, null)
      assert.equal(left.length, 1)
      assert.equal(left[0]!.role, 'steward')
    })

    it('will not let the last steward demote themselves either', async () => {
      // The same rule by another door. Leaving is guarded and demoting is not, in an implementation
      // that only remembered the first one — and the room is exactly as unmoderatable afterwards.
      const circle = await createCircle(deps.circles, subject('demoter'), {
        slug: uniqueHandle('demote'),
        name: 'Demote',
      })
      const me = await seedVoice(sql, 'demoter')
      await joinCircle(deps.circles, subject('bystander'), circle.id)
      await assert.rejects(
        () => setRole(deps.circles, subject('demoter'), circle.id, me.id, 'member'),
        (err: Error) => {
          assert.ok(err instanceof CircleStateError)
          assert.match(err.message, /no steward/)
          return true
        },
      )
    })

    it('tells a steward to leave rather than removing themselves', async () => {
      const circle = await createCircle(deps.circles, subject('selfremove'), {
        slug: uniqueHandle('selfremove'),
        name: 'Self',
      })
      const me = await seedVoice(sql, 'selfremove')
      await assert.rejects(
        () => removeMember(deps.circles, subject('selfremove'), circle.id, me.id, false),
        (err: Error) => {
          assert.ok(err instanceof CircleError)
          assert.match(err.message, /leave the circle instead/)
          return true
        },
      )
    })

    it('leaving a circle somebody is not in changes nothing', async () => {
      const circle = await createCircle(deps.circles, subject('s9'), {
        slug: uniqueHandle('absent'),
        name: 'Absent',
      })
      assert.equal(await leaveCircle(deps.circles, subject('stranger'), circle.id), false)
    })
  })

  /* ---------------------------------------------------------------- archiving */

  describe('archiving', () => {
    it('takes the room off the directory and leaves the conversation', async () => {
      const circle = await createCircle(deps.circles, subject('archivist'), {
        slug: uniqueHandle('archive'),
        name: 'Archive',
        visibility: 'closed',
      })
      const written = await createPost(deps.posts, subject('archivist'), {
        body: 'something said in a room that later closed',
        visibility: 'circle',
        circleId: circle.id,
      })

      await updateCircle(deps.circles, subject('archivist'), circle.id, { archived: true })

      const directory = await listCircles(deps.sql, { viewerId: null, limit: 50 })
      assert.ok(!directory.some((c) => c.id === circle.id), 'an archived circle is still listed')

      // The posts are the point. `posts_circle_fk` is `on delete cascade`, so the way to lose them
      // is already in the schema — archiving must not be the thing that reaches it.
      const me = await seedVoice(sql, 'archivist')
      const page = await byCircle(deps.posts, circle.id, { viewerId: me.id, limit: 50 })
      assert.equal(page.posts.length, 1)
      assert.equal(page.posts[0]!.id, written.post.id)
      assert.match(page.posts[0]!.body, /a room that later closed/)
    })

    it('can be unarchived, and the members were never removed', async () => {
      const circle = await createCircle(deps.circles, subject('reopener'), {
        slug: uniqueHandle('reopen'),
        name: 'Reopen',
      })
      await joinCircle(deps.circles, subject('regular'), circle.id)
      await updateCircle(deps.circles, subject('reopener'), circle.id, { archived: true })
      const reopened = await updateCircle(deps.circles, subject('reopener'), circle.id, {
        archived: false,
      })
      assert.equal(reopened.archivedAt, null)
      assert.equal((await listMembers(deps.sql, circle.id, null)).length, 2)
    })
  })

  /* ---------------------------------------------------------------- reading */

  describe('reading', () => {
    it('lists a closed circle in the directory and keeps its posts out of reach', async () => {
      // Listed on purpose: a closed circle is invitation-only, not secret. Hiding it would mean
      // somebody could be invited to a room they cannot verify exists before accepting.
      const circle = await createCircle(deps.circles, subject('s10'), {
        slug: uniqueHandle('visible'),
        name: 'Visible But Shut',
        visibility: 'closed',
      })
      const directory = await listCircles(deps.sql, { viewerId: null, limit: 50 })
      assert.ok(directory.some((c) => c.id === circle.id))

      const stranger = await seedVoice(sql, 'stranger')
      const found = await findCircle(deps.sql, circle.id, stranger.id)
      assert.equal(await canRead(deps.sql, found!, stranger.id), false)
      assert.equal(await canRead(deps.sql, found!, null), false)

      const member = await seedVoice(sql, 'insider')
      await inviteToCircle(deps.circles, subject('s10'), circle.id, member.id)
      assert.equal(await canRead(deps.sql, found!, member.id), true)
    })

    it('lets anybody read an open circle, logged in or not', async () => {
      const circle = await createCircle(deps.circles, subject('s11'), {
        slug: uniqueHandle('anyone'),
        name: 'Anyone',
        visibility: 'open',
      })
      const found = await findCircle(deps.sql, circle.id, null)
      assert.equal(await canRead(deps.sql, found!, null), true)
    })

    it('does not let a pending member read a members-only circle', async () => {
      // `state = 'active'`, not "has a row". A pending request is somebody standing at the door.
      const circle = await createCircle(deps.circles, subject('s12'), {
        slug: uniqueHandle('pending'),
        name: 'Pending',
        visibility: 'request',
      })
      const waiting = await seedVoice(sql, 'waiting')
      await joinCircle(deps.circles, subject('waiting'), circle.id)
      const found = await findCircle(deps.sql, circle.id, waiting.id)
      assert.equal(found?.viewer?.state, 'pending')
      assert.equal(await canRead(deps.sql, found!, waiting.id), false)
    })

    it('counts members and says nothing about followers', async () => {
      // A member count is the size of a room, which somebody needs to decide whether to walk into
      // it. A follower count is a score attached to a person, and this service does not keep one.
      const circle = await createCircle(deps.circles, subject('s13'), {
        slug: uniqueHandle('counted'),
        name: 'Counted',
      })
      await joinCircle(deps.circles, subject('m1'), circle.id)
      await joinCircle(deps.circles, subject('m2'), circle.id)
      const found = await findCircle(deps.sql, circle.id, null)
      assert.equal(found?.members, 3)
      assert.equal(found?.viewer, undefined, 'a logged-out reader was given a viewer standing')
    })

    it('counts only active members, so a pending request does not inflate the room', async () => {
      const circle = await createCircle(deps.circles, subject('s14'), {
        slug: uniqueHandle('honest'),
        name: 'Honest',
        visibility: 'request',
      })
      await joinCircle(deps.circles, subject('hopeful'), circle.id)
      const found = await findCircle(deps.sql, circle.id, null)
      assert.equal(found?.members, 1)
    })

    it('searches the directory by address and by name', async () => {
      const slug = uniqueHandle('searchable')
      await createCircle(deps.circles, subject('s15'), { slug, name: 'Mining Rigs' })
      await createCircle(deps.circles, subject('s16'), {
        slug: uniqueHandle('other'),
        name: 'Something Else',
      })
      const byName = await listCircles(deps.sql, { query: 'MINING', viewerId: null, limit: 50 })
      assert.equal(byName.length, 1)
      assert.equal(byName[0]!.name, 'Mining Rigs')
      const bySlug = await listCircles(deps.sql, { query: slug, viewerId: null, limit: 50 })
      assert.equal(bySlug.length, 1)
    })

    it('keeps a bar out of the roster, whichever side set it', async () => {
      const circle = await createCircle(deps.circles, subject('s17'), {
        slug: uniqueHandle('mixed'),
        name: 'Mixed',
      })
      const viewer = await seedVoice(sql, 'roster-viewer')
      const barred = await seedVoice(sql, 'roster-barred')
      await joinCircle(deps.circles, subject('roster-viewer'), circle.id)
      await joinCircle(deps.circles, subject('roster-barred'), circle.id)
      await bar(deps.voices, subject('roster-barred'), viewer.id)

      const seen = await listMembers(deps.sql, circle.id, viewer.id)
      assert.ok(!seen.some((m) => m.voiceId === barred.id), 'a barred voice appeared in the roster')
      // The circle is still shared. A bar removes two people from each other's view; it does not
      // remove either of them from the room.
      const everybody = await listMembers(deps.sql, circle.id, null)
      assert.equal(everybody.length, 3)
    })

    it('gives a voice their own circles, and not the ones they only asked to join', async () => {
      const joined = await createCircle(deps.circles, subject('s18'), {
        slug: uniqueHandle('mine'),
        name: 'Mine',
      })
      const asked = await createCircle(deps.circles, subject('s19'), {
        slug: uniqueHandle('asked'),
        name: 'Asked',
        visibility: 'request',
      })
      const me = await seedVoice(sql, 'joiner')
      await joinCircle(deps.circles, subject('joiner'), joined.id)
      await joinCircle(deps.circles, subject('joiner'), asked.id)

      const mine = await myCircles(deps.sql, me.id)
      assert.deepEqual(
        mine.map((c) => c.id),
        [joined.id],
      )
    })
  })

  /* ---------------------------------------------------------------- editing */

  describe('editing', () => {
    it('changes what a steward may change and refuses what nobody may', async () => {
      const slug = uniqueHandle('renamed')
      const circle = await createCircle(deps.circles, subject('editor'), {
        slug,
        name: 'Before',
        purpose: 'the old purpose',
      })
      const after = await updateCircle(deps.circles, subject('editor'), circle.id, {
        name: 'After',
        purpose: 'the new purpose',
        visibility: 'request',
      })
      assert.equal(after.name, 'After')
      assert.equal(after.purpose, 'the new purpose')
      assert.equal(after.visibility, 'request')
      // The address is not in `UpdateCircleInput` at all: a circle's slug is in every link anybody
      // has already shared, and renaming it breaks all of them silently.
      assert.equal(after.slug, slug)

      await assert.rejects(
        () => updateCircle(deps.circles, subject('editor'), circle.id, { name: '   ' }),
        CircleError,
      )
      await assert.rejects(
        () => updateCircle(deps.circles, subject('editor'), circle.id, { purpose: 'x'.repeat(601) }),
        CircleError,
      )
    })

    it('refuses an edit from somebody who is not a steward', async () => {
      const circle = await createCircle(deps.circles, subject('s20'), {
        slug: uniqueHandle('guarded'),
        name: 'Guarded',
      })
      await joinCircle(deps.circles, subject('meddler'), circle.id)
      await assert.rejects(
        () => updateCircle(deps.circles, subject('meddler'), circle.id, { name: 'Mine now' }),
        CircleNotFoundError,
      )
    })
  })
})
