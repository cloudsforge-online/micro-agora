/**
 * Posts, and the predicate that decides who can read one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE VISIBILITY CASES ARE THE POINT OF THIS FILE.**
 *
 * `posts.ts` has nine timeline queries and one `visibilityPredicate` they all interpolate. The
 * reason it is a function is written there: the tag page is always the one somebody forgets, and a
 * followers-only post that leaks onto a tag timeline is not a bug a user reports — they never see
 * it happen. It is a bug the person whose post it was finds out about from a stranger.
 *
 * So `every timeline` below is a LOOP over the timelines rather than a case per timeline. A new
 * timeline added to `posts.ts` without a row in that table is a timeline nobody proved private,
 * and the loop is what makes adding one without noticing hard.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { strict as assert } from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import {
  byCircle,
  byTag,
  byVoice,
  createPost,
  deletePost,
  editPost,
  home,
  latest,
  readPost,
  search,
  setEngagement,
  thread,
  type Page,
  type PostDeps,
} from './posts.ts'
import { PostError, PostNotFoundError, PostRefusedError } from './posts.ts'
import { bar, follow, hush } from './voices.ts'
import { createCircle } from './circles.ts'
import {
  fakePolicy,
  migrateTestDb,
  openDb,
  resetAgora,
  seedNamed,
  seedVoice,
  skip,
  subject,
  testDeps,
} from './testsupport.ts'

describe('posts', { skip }, () => {
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

  describe('writing', () => {
    it('stores the tags and the mentions it parsed, once, at write time', async () => {
      await seedNamed(sql, 'mentioned')
      const author = await seedVoice(sql, 'author')
      const { post } = await createPost(deps.posts, subject('author'), {
        body: 'thoughts on #Bitcoin and #ember, cc @mentioned',
      })

      assert.deepEqual([...post.tags].sort(), ['bitcoin', 'ember'])
      assert.equal(post.voiceId, author.id)
      const mentions = await sql<{ n: string }[]>`
        select count(*) as n from post_mentions where post_id = ${post.id}
      `
      assert.equal(Number(mentions[0]!.n), 1)
    })

    it('notifies the person mentioned, and nobody else', async () => {
      const mentioned = await seedNamed(sql, 'notified')
      await seedNamed(sql, 'bystander')
      await createPost(deps.posts, subject('author'), { body: 'hello @notified' })

      const rows = await sql<{ voice_id: string; kind: string }[]>`
        select voice_id, kind from notifications
      `
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.voice_id, mentioned.id)
      assert.equal(rows[0]!.kind, 'mention')
    })

    it('drops a mention of a handle nobody has, rather than refusing the post', async () => {
      // `@somebody` in a sentence is ordinary writing. Refusing the post would be the service
      // enforcing a grammar.
      const { post } = await createPost(deps.posts, subject('author'), {
        body: 'ask @nobody_at_all about it',
      })
      assert.ok(post.id)
      const rows = await sql<{ n: string }[]>`select count(*) as n from post_mentions`
      assert.equal(Number(rows[0]!.n), 0)
    })

    it('refuses an attachment with no description, in words a person can act on', async () => {
      await assert.rejects(
        () =>
          createPost(deps.posts, subject('author'), {
            body: 'look at this',
            media: [{ assetId: 'asset-1', alt: '  ' }],
          }),
        (err: Error) => {
          assert.ok(err instanceof PostError)
          assert.match(err.message, /screen reader/)
          return true
        },
      )
    })

    it('is idempotent on a key, and spends no second policy decision', async () => {
      const policy = fakePolicy()
      const own = testDeps(sql, { policy })
      const first = await createPost(own.posts, subject('author'), {
        body: 'once',
        idempotencyKey: 'k1',
      })
      const second = await createPost(own.posts, subject('author'), {
        body: 'once',
        idempotencyKey: 'k1',
      })

      assert.equal(first.created, true)
      assert.equal(second.created, false)
      assert.equal(second.post.id, first.post.id)
      // The short-circuit is BEFORE the policy call: a retry must not be deniable when the first
      // attempt was allowed.
      assert.equal(policy.calls.length, 1)
      assert.deepEqual(second.policy.reasons, ['idempotent_replay'])
    })

    it('refuses to publish when policy denies, and writes nothing', async () => {
      const policy = fakePolicy()
      policy.answer({ decision: 'deny', reasons: ['spam'], degraded: false })
      const own = testDeps(sql, { policy })
      await assert.rejects(
        () => createPost(own.posts, subject('author'), { body: 'buy my coin' }),
        PostRefusedError,
      )
      const rows = await sql<{ n: string }[]>`select count(*) as n from posts`
      assert.equal(Number(rows[0]!.n), 0)
    })

    it('opens a system report when the post went up with the gate unreachable', async () => {
      // The evidence trail from `policyclient.ts`: a post published while policy was down is not
      // rejected, it is flagged, and the queue can be filtered by "the gate was not there".
      const policy = fakePolicy()
      policy.answer({ decision: 'allow', reasons: ['policy_unreachable'], degraded: true })
      const own = testDeps(sql, { policy })
      const { post } = await createPost(own.posts, subject('author'), { body: 'while down' })

      const rows = await sql<{ subject_id: string; reporter_id: string | null; detail: string }[]>`
        select subject_id, reporter_id, detail from reports
      `
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.subject_id, post.id)
      assert.equal(rows[0]!.reporter_id, null, 'a system report has no reporter')
      assert.match(rows[0]!.detail, /unreachable/)
    })

    it('refuses a reply more public than the post it answers', async () => {
      await seedVoice(sql, 'quiet')
      const parent = await createPost(deps.posts, subject('quiet'), {
        body: 'just for followers',
        visibility: 'followers',
      })
      await follow(deps.voices, subject('reader'), parent.post.voiceId)

      await assert.rejects(
        () =>
          createPost(deps.posts, subject('reader'), {
            body: 'agreed',
            inReplyToId: parent.post.id,
            visibility: 'public',
          }),
        /cannot be more public/,
      )
    })

    it('refuses to quote anything that is not public', async () => {
      // Quoting is republishing: a followers-only post quoted into a public one is that post made
      // public by somebody who was trusted with it.
      await seedVoice(sql, 'quiet')
      const parent = await createPost(deps.posts, subject('quiet'), {
        body: 'just for followers',
        visibility: 'followers',
      })
      await assert.rejects(
        () =>
          createPost(deps.posts, subject('other'), {
            body: 'look at this',
            quoteOfId: parent.post.id,
          }),
        /only a public post can be quoted/,
      )
    })

    it('refuses to post at all when the square is frozen', async () => {
      const frozen = testDeps(sql, { postingEnabled: false })
      await assert.rejects(
        () => createPost(frozen.posts, subject('author'), { body: 'hello' }),
        (err: Error) => {
          assert.ok(err instanceof PostRefusedError)
          return true
        },
      )
    })

    it('stops a voice at its hourly limit', async () => {
      const tight = testDeps(sql, { postsPerHour: 2 })
      await createPost(tight.posts, subject('chatty'), { body: 'one' })
      await createPost(tight.posts, subject('chatty'), { body: 'two' })
      await assert.rejects(
        () => createPost(tight.posts, subject('chatty'), { body: 'three' }),
        /2 per hour/,
      )
      // And the limit is per voice, not global.
      await createPost(tight.posts, subject('somebody_else'), { body: 'mine' })
    })
  })

  describe('editing and deleting', () => {
    it('re-files the post under its new tags in the same transaction', async () => {
      const { post } = await createPost(deps.posts, subject('author'), { body: 'about #ember' })
      const edited = await editPost(deps.posts, subject('author'), post.id, {
        body: 'actually about #bitcoin',
      })
      assert.deepEqual([...edited.tags], ['bitcoin'])

      const stored = await sql<{ tag: string }[]>`
        select tag from post_tags where post_id = ${post.id}
      `
      assert.deepEqual(stored.map((r) => r.tag), ['bitcoin'])
      assert.ok(edited.editedAt, 'an edit is visible as an edit')
    })

    it('notifies somebody newly mentioned by an edit, and nobody twice', async () => {
      const late = await seedNamed(sql, 'late')
      const { post } = await createPost(deps.posts, subject('author'), { body: 'a thought' })
      await editPost(deps.posts, subject('author'), post.id, { body: 'a thought, cc @late' })
      await editPost(deps.posts, subject('author'), post.id, { body: 'a thought, cc @late again' })

      const rows = await sql<{ n: string }[]>`
        select count(*) as n from notifications where voice_id = ${late.id} and kind = 'mention'
      `
      // Once. Re-notifying on every edit would make a typo fix a way to ping somebody repeatedly.
      assert.equal(Number(rows[0]!.n), 1)
    })

    it('answers 404, not 403, when the post belongs to somebody else', async () => {
      // A 403 confirms the post exists and is not yours, which tells a stranger which of two
      // guessed ids is real.
      const { post } = await createPost(deps.posts, subject('author'), { body: 'mine' })
      await assert.rejects(
        () => editPost(deps.posts, subject('stranger'), post.id, { body: 'not yours' }),
        PostNotFoundError,
      )
      assert.equal(await deletePost(deps.posts, subject('stranger'), post.id), false)
    })

    it('refuses an edit that would empty the post', async () => {
      const { post } = await createPost(deps.posts, subject('author'), { body: 'something' })
      await assert.rejects(
        () => editPost(deps.posts, subject('author'), post.id, { body: '   ' }),
        /delete it instead/,
      )
    })

    it('keeps the row and loses the words, so the thread around it survives', async () => {
      const { post } = await createPost(deps.posts, subject('author'), {
        body: 'the original #tagged',
        media: [{ assetId: 'a1', alt: 'a chart' }],
      })
      const reply = await createPost(deps.posts, subject('other'), {
        body: 'answering',
        inReplyToId: post.id,
      })

      assert.equal(await deletePost(deps.posts, subject('author'), post.id), true)

      const still = await readPost(sql as never, post.id, null)
      assert.ok(still, 'the row survives so the reply is not orphaned')
      assert.equal(still.deleted, true)
      assert.equal(still.body, '')
      assert.deepEqual([...still.media], [])
      assert.deepEqual([...still.tags], [])

      const conversation = await thread(deps.posts, post.id, null)
      assert.equal(conversation.length, 2)
      assert.ok(conversation.some((p) => p.id === reply.post.id))
    })

    it('gives the reply count back when a reply is deleted', async () => {
      const { post } = await createPost(deps.posts, subject('author'), { body: 'root' })
      const reply = await createPost(deps.posts, subject('other'), {
        body: 'a reply',
        inReplyToId: post.id,
      })
      assert.equal((await readPost(sql as never, post.id, null))!.replyCount, 1)
      await deletePost(deps.posts, subject('other'), reply.post.id)
      assert.equal((await readPost(sql as never, post.id, null))!.replyCount, 0)
    })
  })

  describe('engagement', () => {
    it('counts a double-tap once', async () => {
      const { post } = await createPost(deps.posts, subject('author'), { body: 'sparkable' })
      const first = await setEngagement(deps.posts, subject('fan'), post.id, 'sparks', true)
      const second = await setEngagement(deps.posts, subject('fan'), post.id, 'sparks', true)

      assert.deepEqual(first, { changed: true, count: 1 })
      assert.deepEqual(second, { changed: false, count: 1 })

      const notes = await sql<{ n: string }[]>`
        select count(*) as n from notifications where kind = 'spark'
      `
      assert.equal(Number(notes[0]!.n), 1, 'and notifies once')
    })

    it('takes the notification away with the spark', async () => {
      // Otherwise a badge outlives the thing it is about, and the recipient opens it to find
      // nothing there.
      const { post } = await createPost(deps.posts, subject('author'), { body: 'sparkable' })
      await setEngagement(deps.posts, subject('fan'), post.id, 'sparks', true)
      const off = await setEngagement(deps.posts, subject('fan'), post.id, 'sparks', false)

      assert.deepEqual(off, { changed: true, count: 0 })
      const notes = await sql<{ n: string }[]>`
        select count(*) as n from notifications where kind = 'spark'
      `
      assert.equal(Number(notes[0]!.n), 0)
    })

    it('refuses to echo anything that is not public', async () => {
      await seedVoice(sql, 'quiet')
      const { post } = await createPost(deps.posts, subject('quiet'), {
        body: 'followers only',
        visibility: 'followers',
      })
      const reader = await seedVoice(sql, 'reader')
      await follow(deps.voices, subject('reader'), post.voiceId)
      // Readable — the follow is active — but echoing it would republish it.
      assert.ok(await readPost(sql as never, post.id, reader.id))
      await assert.rejects(
        () => setEngagement(deps.posts, subject('reader'), post.id, 'echoes', true),
        /only a public post can be echoed/,
      )
    })

    it('answers 404 for sparking a post the viewer cannot see', async () => {
      // Otherwise a spark is an existence oracle for a followers-only post.
      await seedVoice(sql, 'quiet')
      const { post } = await createPost(deps.posts, subject('quiet'), {
        body: 'followers only',
        visibility: 'followers',
      })
      await assert.rejects(
        () => setEngagement(deps.posts, subject('stranger'), post.id, 'sparks', true),
        PostNotFoundError,
      )
    })

    it('keeps a bookmark private and uncounted', async () => {
      const { post } = await createPost(deps.posts, subject('author'), { body: 'save this' })
      const result = await setEngagement(deps.posts, subject('saver'), post.id, 'bookmarks', true)
      assert.equal(result.changed, true)
      assert.equal(result.count, 0, 'there is no bookmark count anywhere')
      const notes = await sql<{ n: string }[]>`select count(*) as n from notifications`
      assert.equal(Number(notes[0]!.n), 0, 'and the author is not told')
    })
  })

  describe('the visibility predicate', () => {
    it('shows a public post to a logged-out reader', async () => {
      const { post } = await createPost(deps.posts, subject('author'), { body: 'hello world' })
      assert.ok(await readPost(sql as never, post.id, null))
    })

    it('hides a followers-only post from a stranger and from a pending follower', async () => {
      const quiet = await seedVoice(sql, 'quiet')
      await sql`update voices set protected = true where id = ${quiet.id}`
      const { post } = await createPost(deps.posts, subject('quiet'), {
        body: 'for followers',
        visibility: 'followers',
      })
      const stranger = await seedVoice(sql, 'stranger')
      assert.equal(await readPost(sql as never, post.id, null), null)
      assert.equal(await readPost(sql as never, post.id, stranger.id), null)

      // A follow of a protected voice is PENDING, and pending is not a follow.
      const asked = await follow(deps.voices, subject('stranger'), quiet.id)
      assert.equal(asked.state, 'pending')
      assert.equal(await readPost(sql as never, post.id, stranger.id), null)

      await sql`
        update follows set state = 'active'
         where follower_id = ${stranger.id} and followee_id = ${quiet.id}
      `
      assert.ok(await readPost(sql as never, post.id, stranger.id))
    })

    it('shows a voice their own post whatever its visibility', async () => {
      const author = await seedVoice(sql, 'author')
      const { post } = await createPost(deps.posts, subject('author'), {
        body: 'for followers',
        visibility: 'followers',
      })
      assert.ok(await readPost(sql as never, post.id, author.id))
    })

    it('hides a suspended voice from everybody but themselves', async () => {
      const author = await seedVoice(sql, 'suspendee')
      const { post } = await createPost(deps.posts, subject('suspendee'), { body: 'public' })
      await sql`update voices set suspended_at = now() where id = ${author.id}`

      assert.equal(await readPost(sql as never, post.id, null), null)
      assert.ok(await readPost(sql as never, post.id, author.id), 'they can still read their own')
    })

    it('is symmetric across a bar: neither reads the other, whoever set it', async () => {
      const a = await seedVoice(sql, 'barrer')
      const b = await seedVoice(sql, 'barred')
      const mine = await createPost(deps.posts, subject('barrer'), { body: 'from a' })
      const theirs = await createPost(deps.posts, subject('barred'), { body: 'from b' })

      await bar(deps.voices, subject('barrer'), b.id)

      assert.equal(await readPost(sql as never, theirs.post.id, a.id), null)
      // The half everybody forgets. The person who set the bar believes they are unreachable; if
      // only their own reads were filtered, the other side would still be reading them.
      assert.equal(await readPost(sql as never, mine.post.id, b.id), null)
      // And a stranger still sees both.
      assert.ok(await readPost(sql as never, mine.post.id, null))
      assert.ok(await readPost(sql as never, theirs.post.id, null))
    })

    it('holds on every timeline, not just the one somebody remembered', async () => {
      // The loop the file header is about. A timeline added to `posts.ts` with no row here is a
      // timeline nobody proved private.
      const quiet = await seedVoice(sql, 'quiet')
      const reader = await seedVoice(sql, 'reader')
      const circle = await createCircle(deps.circles, subject('quiet'), {
        slug: 'private-room',
        name: 'Private room',
        visibility: 'closed',
      })

      const secret = await createPost(deps.posts, subject('quiet'), {
        body: 'a secret about #ember, mentioning nothing',
        visibility: 'followers',
      })
      const inCircle = await createPost(deps.posts, subject('quiet'), {
        body: 'a circle secret about #ember',
        circleId: circle.id,
      })
      // A public post by the same voice, so a timeline returning nothing at all cannot pass by
      // being broken.
      const open = await createPost(deps.posts, subject('quiet'), { body: 'public #ember post' })

      const page = (p: Page) => p.posts.map((post) => post.id)
      const timelines: Array<[string, () => Promise<readonly string[]>]> = [
        ['latest', async () => page(await latest(deps.posts, { viewerId: reader.id, limit: 50 }))],
        ['home', async () => page(await home(deps.posts, { viewerId: reader.id, limit: 50 }))],
        [
          'byVoice',
          async () => page(await byVoice(deps.posts, quiet.id, { viewerId: reader.id, limit: 50 })),
        ],
        [
          'byTag',
          async () => page(await byTag(deps.posts, 'ember', { viewerId: reader.id, limit: 50 })),
        ],
        [
          'byCircle',
          async () =>
            page(await byCircle(deps.posts, circle.id, { viewerId: reader.id, limit: 50 })),
        ],
        [
          'search',
          async () => page(await search(deps.posts, 'secret', { viewerId: reader.id, limit: 50 })),
        ],
        ['thread', async () => (await thread(deps.posts, secret.post.id, reader.id)).map((p) => p.id)],
      ]

      for (const [name, run] of timelines) {
        const ids = await run()
        assert.ok(!ids.includes(secret.post.id), `${name} leaked a followers-only post`)
        assert.ok(!ids.includes(inCircle.post.id), `${name} leaked a circle post`)
      }

      // And the same reader sees the public one where a public one belongs.
      const publicIds = await latest(deps.posts, { viewerId: reader.id, limit: 50 })
      assert.ok(page(publicIds).includes(open.post.id))
    })
  })

  describe('timelines', () => {
    it('puts an echo at the top with the echo’s timestamp, not the post’s', async () => {
      // A two-year-old post somebody just echoed belongs at the top. `order by p.created_at` gets
      // this wrong and it is the one thing a home timeline must not get wrong.
      const reader = await seedVoice(sql, 'reader')
      const old = await createPost(deps.posts, subject('old_hand'), { body: 'from long ago' })
      await sql`update posts set created_at = now() - interval '2 years' where id = ${old.post.id}`
      const friend = await seedVoice(sql, 'friend')
      await follow(deps.voices, subject('reader'), friend.id)
      await createPost(deps.posts, subject('friend'), { body: 'said today' })
      await setEngagement(deps.posts, subject('friend'), old.post.id, 'echoes', true)

      const page = await home(deps.posts, { viewerId: reader.id, limit: 50 })
      assert.equal(page.posts[0]?.id, old.post.id)
    })

    it('quiets a hushed voice without telling them and without touching a thread', async () => {
      const reader = await seedVoice(sql, 'reader')
      const noisy = await seedVoice(sql, 'noisy')
      const { post } = await createPost(deps.posts, subject('noisy'), { body: 'loud #ember take' })

      await hush(deps.voices, subject('reader'), noisy.id, null)

      const timeline = await latest(deps.posts, { viewerId: reader.id, limit: 50 })
      assert.ok(!timeline.posts.some((p) => p.id === post.id))
      // A hush is about a timeline. The post is still readable when the reader goes to it, which
      // is the difference between a hush and a bar.
      assert.ok(await readPost(sql as never, post.id, reader.id))
    })

    it('honours the page size ceiling rather than what the client asked for', async () => {
      const small = testDeps(sql, { pageSizeMax: 2 })
      for (let i = 0; i < 4; i += 1) {
        await createPost(small.posts, subject('author'), { body: `post ${i}` })
      }
      const page = await latest(small.posts, { viewerId: null, limit: 100 })
      assert.equal(page.posts.length, 2)
      assert.ok(page.nextCursor, 'and hands back a cursor rather than the rest')

      const next = await latest(small.posts, { viewerId: null, limit: 100, cursor: page.nextCursor })
      assert.equal(next.posts.length, 2)
      const seen = new Set([...page.posts, ...next.posts].map((p) => p.id))
      assert.equal(seen.size, 4, 'and the two pages do not overlap')
    })

    it('tells a reader what they already did with a post', async () => {
      const reader = await seedVoice(sql, 'reader')
      const { post } = await createPost(deps.posts, subject('author'), { body: 'a post' })
      await setEngagement(deps.posts, subject('reader'), post.id, 'sparks', true)
      await setEngagement(deps.posts, subject('reader'), post.id, 'bookmarks', true)

      const read = await readPost(sql as never, post.id, reader.id)
      assert.deepEqual(read!.viewer, {
        sparked: true,
        echoed: false,
        bookmarked: true,
        mine: false,
      })
      const anon = await readPost(sql as never, post.id, null)
      assert.equal(anon!.viewer, undefined, 'and says nothing to somebody logged out')
    })
  })

  describe('the outbox', () => {
    it('writes the fact of a post without its words', async () => {
      const { post } = await createPost(deps.posts, subject('author'), {
        body: 'the words that must not travel',
        visibility: 'followers',
      })
      const rows = await sql<{ topic: string; payload: Record<string, unknown> }[]>`
        select topic, payload from outbox order by id
      `
      const created = rows.find((r) => r.topic === 'agora.post.created')
      assert.ok(created, 'agora.post.created was not emitted')
      assert.equal(created.payload.postId, post.id)
      assert.equal(created.payload.visibility, 'followers')
      // An event is delivered to every subscriber and stored in their inbox. A followers-only
      // post's words on the bus is that post published to services with no idea who may read it.
      assert.ok(!('body' in created.payload), 'the body must never be in the payload')
      assert.equal(JSON.stringify(created.payload).includes('must not travel'), false)
    })
  })
})
