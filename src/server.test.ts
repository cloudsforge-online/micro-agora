/**
 * The HTTP surface, over a real socket.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THREE THINGS ARE PROVEN HERE AND NOWHERE ELSE.**
 *
 *   1. **Who you are comes from the TOKEN, never from the body.** A caller-supplied `voiceId`,
 *      `subject` or `reporterId` would let one person post as another, report as another, or read
 *      another account's private counts. Each is sent deliberately and asserted to have done
 *      nothing.
 *   2. **A post you cannot see is a 404, not a 403.** `server.ts` says the two are the same answer
 *      on purpose: a 403 on a followers-only post confirms the post exists, which is an oracle
 *      somebody uses to map a private account one guessed id at a time.
 *   3. **`POST /v1/events` is an account-erasure endpoint.** Unsigned, it is a free "delete anybody"
 *      route on the public internet. The signature check is tested with a wrong secret, a missing
 *      header, and a body altered after signing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The moderation gate gets its own section for a reason worth writing down: there is NO service
 * lane on it. A `agora:moderate` scope would be a credential whose leak empties the square, so the
 * test sends a service token with every scope spelled out and asserts a 403 — a service that
 * "should" be able to moderate is a decision somebody has to make in the open, not one that arrives
 * because a scope happened to match.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { TokenError, VerifierUnavailableError, type Principal } from '@cloudsforge/auth'
import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { createServer, USER_DELETED_TOPIC } from './server.ts'
import { signEvent, SIGNATURE_HEADER } from './outbox.ts'
import { findVoiceBySubject } from './voices.ts'

/**
 * One handle, presented as the per-network selector the server now takes.
 *
 * The fixtures run against a single test database, so mainnet is the only network configured —
 * which also means these tests exercise the REFUSAL path for free: anything that reached for
 * testnet here would throw rather than quietly reuse this handle.
 */
const singleNetworkSql = (db: unknown) => networkSql({ mainnet: db as RuntimeSql })
import {
  asDb,
  migrateTestDb,
  openDb,
  quietLogger,
  resetAgora,
  seedNamed,
  skip,
  subject,
  testDeps,
  testMetrics,
} from './testsupport.ts'

const SECRET = 'an-event-signing-secret-32-chars'

let sql: postgres.Sql
let server: Server
let baseUrl: string

/**
 * A verifier with no JWKS: the token IS the principal, spelled.
 *
 * `svc:` prefixes a service token and the rest is its scopes; `admin:` prefixes an operator; every
 * other token is an ordinary account whose id is the token itself. That last one is what makes
 * `as: 'alice'` line up with `subject('alice')` in a fixture.
 */
const verifier = {
  async principal(token: string): Promise<Principal> {
    // The real errors, not stand-ins: `statusFor` maps them BY TYPE, so a fake that threw a plain
    // Error would produce a 500 here and the test would be proving nothing about the mapping.
    if (token === 'unreachable') throw new VerifierUnavailableError('the jwks endpoint is down')
    if (token === 'bad') throw new TokenError('signature verification failed', 'invalid_signature')
    if (token.startsWith('svc:')) {
      return {
        kind: 'service',
        service: 'tester',
        scopes: token.slice(4).split(',').filter((s) => s.length > 0),
      }
    }
    if (token.startsWith('admin:')) {
      const id = token.slice(6)
      return { kind: 'user', userId: id, handle: id, roles: ['admin'] }
    }
    return { kind: 'user', userId: token, handle: token, roles: [] }
  },
}

before(async () => {
  if (skip) return
  sql = openDb()
  await migrateTestDb(sql)
  const deps = testDeps(sql)
  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 100 })
  lifecycle.markReady()
  server = createServer({
    lifecycle,
    logger: quietLogger(),
    metrics: testMetrics(),
    verifier,
    sql: singleNetworkSql(asDb(sql)),
    singleNetwork: 'mainnet' as const,
    producer: 'agora',
    posts: deps.posts,
    circles: deps.circles,
    whispers: deps.whispers,
    notifications: deps.notifications,
    moderation: deps.moderation,
    followsPerHour: 1_000,
    // Empty on purpose, and asserted: an unconfigured studio must produce a null url rather than a
    // guessed hostname that renders as a broken avatar with no diagnosis.
    studioPublicUrl: '',
    queue: new JobQueue(sql as unknown as JobsSql, { owner: 'agora-test', leaseMs: 60_000 }),
    eventSigningSecret: SECRET,
    pageSizeMax: 50,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (skip) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (skip) return
  await resetAgora(sql)
})

interface Reply {
  readonly status: number
  readonly body: Record<string, any>
  readonly headers: Headers
}

async function call(
  method: string,
  path: string,
  options: { as?: string; body?: unknown; key?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.as) headers['authorization'] = `Bearer ${options.as}`
  if (options.key) headers['idempotency-key'] = options.key
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: response.headers,
  }
}

/** Post a body and return what came back, so a test can read the created post's id. */
async function post(as: string, body: string, extra: Record<string, unknown> = {}) {
  return call('POST', '/v1/posts', { as, body: { body, ...extra } })
}

/**
 * How many rows anywhere in this database still contain `needle`.
 *
 * The same statement `deploy/scripts/erasure-drill.sh` runs against the live estate, kept
 * character-for-character in shape so the two cannot drift into asking different questions.
 * `query_to_xml` is how a count is taken over a table named by a ROW rather than by the query
 * text: plain SQL cannot interpolate an identifier, and this stays one statement needing no
 * function and no privilege the test does not already have.
 *
 * Deliberately blunt and deliberately over-broad. A curated table list is a list written by
 * whoever wrote the handler, which is exactly the person who already missed a table.
 */
async function residual(needle: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select coalesce(sum(n), 0)::int as n from (
      select (xpath('/row/c/text()', query_to_xml(
        format('select count(*) as c from %I.%I where %I::text like %L',
               table_schema, table_name, column_name, ${`%${needle}%`}::text),
        false, true, '')))[1]::text::int as n
      from information_schema.columns
      where table_schema = 'public'
        and data_type in ('text', 'uuid', 'character varying', 'jsonb')
    ) t
  `
  return rows[0]!.n
}

describe('the http surface', { skip }, () => {
  /* ---------------------------------------------------------------- the shape of every reply */

  describe('every reply', () => {
    it('answers the three health endpoints', async () => {
      assert.equal((await call('GET', '/livez')).status, 200)
      assert.equal((await call('GET', '/readyz')).status, 200)
      const metrics = await fetch(`${baseUrl}/metrics`)
      assert.equal(metrics.status, 200)
      assert.match(metrics.headers.get('content-type') ?? '', /text\/plain/)
      assert.match(await metrics.text(), /agora_posts_total/)
    })

    it('carries a request id and refuses to be cached', async () => {
      const reply = await call('GET', '/livez')
      assert.ok(reply.headers.get('x-request-id'))
      assert.equal(reply.headers.get('cache-control'), 'no-store')
    })

    it('echoes a safe request id and invents one for anything else', async () => {
      const mine = await fetch(`${baseUrl}/livez`, { headers: { 'x-request-id': 'req-abc-123' } })
      assert.equal(mine.headers.get('x-request-id'), 'req-abc-123')
      // A header is attacker-controlled and it lands in every log line. Anything outside
      // `[A-Za-z0-9_-]{1,64}` is REPLACED rather than sanitised, so there is no escaping rule to
      // get wrong and nothing to smuggle into a log.
      const smuggled = 'evil id: log-injection=yes'
      const theirs = await fetch(`${baseUrl}/livez`, { headers: { 'x-request-id': smuggled } })
      assert.notEqual(theirs.headers.get('x-request-id'), smuggled)
      assert.match(theirs.headers.get('x-request-id') ?? '', /^[A-Za-z0-9_-]{1,64}$/)
    })

    it('names the route it could not find, and does not invent one', async () => {
      const reply = await call('GET', '/v1/nope')
      assert.equal(reply.status, 404)
      assert.equal(reply.body.error.code, 'not_found')
    })

    it('answers 401 without saying which half of the token was wrong', async () => {
      const reply = await call('GET', '/v1/me', { as: 'bad' })
      assert.equal(reply.status, 401)
      assert.equal(reply.body.error.message, 'a valid bearer token is required')
      // "expired" versus "signature failed" tells somebody forging one which half to fix.
      assert.ok(!JSON.stringify(reply.body).includes('verify'))
    })

    it('answers 503 when the verifier is the thing that is down', async () => {
      // Not a 401. A 401 tells a person their session is broken and sends them to log in again,
      // which will also fail; a 503 says the fault is ours and retrying is the right move.
      const reply = await call('GET', '/v1/me', { as: 'unreachable' })
      assert.equal(reply.status, 503)
      assert.equal(reply.body.error.code, 'verifier_unavailable')
    })
  })

  /* ---------------------------------------------------------------- identity comes from the token */

  describe('authority', () => {
    it('takes the author from the token and ignores a voiceId in the body', async () => {
      const victim = await seedNamed(sql, 'victim', 'victim')
      const reply = await post('alice', 'hello', {
        voiceId: victim.id,
        voice_id: victim.id,
        subject: subject('victim'),
      })
      assert.equal(reply.status, 201)

      const alice = await findVoiceBySubject(asDb(sql), subject('alice'))
      assert.equal(reply.body.post.voiceId, alice?.id)
      assert.notEqual(reply.body.post.voiceId, victim.id)
    })

    it('reports as the token, never as a reporterId in the body', async () => {
      const alice = await seedNamed(sql, 'alice-r', 'alicer')
      const target = await seedNamed(sql, 'target-r', 'targetr')
      const reply = await call('POST', '/v1/reports', {
        as: 'mallory',
        body: {
          subjectKind: 'voice',
          subjectId: target.id,
          reason: 'spam',
          reporterId: alice.id,
        },
      })
      assert.equal(reply.status, 202)

      const rows = await sql<{ reporter_id: string }[]>`select reporter_id from reports`
      const mallory = await findVoiceBySubject(asDb(sql), subject('mallory'))
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.reporter_id, mallory?.id, 'a filed report names the caller')
      assert.notEqual(rows[0]!.reporter_id, alice.id)
    })

    it('refuses a whisper sent as somebody else', async () => {
      const alice = await seedNamed(sql, 'w-alice', 'walice')
      const bob = await seedNamed(sql, 'w-bob', 'wbob')
      const reply = await call('POST', '/v1/whispers', {
        as: 'w-mallory',
        body: { to: 'wbob', body: 'from me', from: alice.id, voiceId: alice.id },
      })
      assert.equal(reply.status, 201)

      const rows = await sql<{ voice_id: string }[]>`select voice_id from whispers`
      assert.equal(rows.length, 1)
      assert.notEqual(rows[0]!.voice_id, alice.id, 'the sender is the token, not the body')
      assert.notEqual(rows[0]!.voice_id, bob.id)
    })

    it('creates a voice on first contact rather than 404ing an account that has never posted', async () => {
      // A read that writes, deliberately. The alternative is that somebody who has an account and
      // has never written anything cannot render an empty timeline without POSTing first.
      const reply = await call('GET', '/v1/me', { as: 'newcomer' })
      assert.equal(reply.status, 200)
      assert.ok(reply.body.voice.handle, 'a handle was derived')
      assert.equal(reply.body.counts.posts, 0)
      // Derived from the subject hash, never from an email or a display name — publishing either
      // would publish something the person did not choose to publish.
      assert.ok(!String(reply.body.voice.handle).includes('newcomer'))
    })

    it('keeps the three private counts on /v1/me and nowhere else', async () => {
      // Doc 41 §4's second rule. Follower counts are yours to see and nobody else's to compare
      // against, which is the whole reason this square does not render them on a profile.
      await seedNamed(sql, 'counted', 'counted')
      const mine = await call('GET', '/v1/me', { as: 'counted' })
      assert.ok(mine.body.counts, '/v1/me carries them')

      const theirs = await call('GET', '/v1/voices/counted', { as: 'nosy' })
      assert.equal(theirs.status, 200)
      const serialised = JSON.stringify(theirs.body)
      assert.ok(!('counts' in theirs.body.voice), 'a profile carries no counts')
      assert.ok(!/followers/i.test(serialised), 'and no follower number by any other name')
    })

    it('leaves every image url null when studio is unconfigured', async () => {
      const reply = await call('GET', '/v1/me', { as: 'no-studio' })
      assert.equal(reply.body.voice.avatarUrl, null)
      assert.equal(reply.body.voice.bannerUrl, null)
    })
  })

  /* ---------------------------------------------------------------- 404 rather than 403 */

  describe('what a reader cannot see', () => {
    it('answers 404 for a followers-only post, not 403', async () => {
      // The oracle this closes: a 403 confirms the post exists, and somebody mapping a private
      // account walks the id space until the status changes.
      const created = await post('private-author', 'only for followers', {
        visibility: 'followers',
      })
      assert.equal(created.status, 201)
      const id = created.body.post.id

      const stranger = await call('GET', `/v1/posts/${id}`, { as: 'stranger' })
      assert.equal(stranger.status, 404)
      assert.equal(stranger.body.error.code, 'not_found')

      const loggedOut = await call('GET', `/v1/posts/${id}`)
      assert.equal(loggedOut.status, 404)

      const author = await call('GET', `/v1/posts/${id}`, { as: 'private-author' })
      assert.equal(author.status, 200, 'the author can still read their own')
    })

    it('answers the same 404 for a post that never existed', async () => {
      // The pair. If a real-but-hidden post and an invented id answered differently, the 404 above
      // would be decoration.
      const missing = await call('GET', '/v1/posts/00000000-0000-4000-8000-000000000000', {
        as: 'stranger',
      })
      assert.equal(missing.status, 404)
    })

    it('answers the same 404 for an id that is not a uuid at all', async () => {
      // `uuidParam` throws NOT FOUND rather than bad request, and that is the right call on this
      // service: a 400 on a malformed id and a 404 on a hidden one is a two-state signal, and
      // somebody probing the id space reads the difference. Three inputs, one answer.
      const reply = await call('GET', '/v1/posts/not-a-uuid', { as: 'stranger' })
      assert.equal(reply.status, 404)
    })

    it('serves a logged-out reader the public square without a token', async () => {
      await post('open-author', 'hello everybody')
      const reply = await call('GET', '/v1/timeline/latest')
      assert.equal(reply.status, 200)
      assert.equal(reply.body.posts.length, 1)
    })

    it('refuses a stale token on an open route rather than silently logging somebody out', async () => {
      // The failure this prevents reads as "my posts disappeared": a client with an expired token
      // served the logged-out view of its own timeline, with no way to tell.
      const reply = await call('GET', '/v1/timeline/latest', { as: 'bad' })
      assert.equal(reply.status, 401)
    })

    it('demands a token for the home timeline, which is nobody else’s to read', async () => {
      assert.equal((await call('GET', '/v1/timeline/home')).status, 401)
      assert.equal((await call('GET', '/v1/notifications')).status, 401)
      assert.equal((await call('GET', '/v1/whispers')).status, 401)
      assert.equal((await call('GET', '/v1/bookmarks')).status, 401)
    })
  })

  /* ---------------------------------------------------------------- posting */

  describe('posting', () => {
    it('answers 201 once and 200 for the retry of the same key', async () => {
      // A client that timed out and retried must be able to tell "created" from "already created"
      // from the status alone, without diffing the body.
      const first = await call('POST', '/v1/posts', {
        as: 'idem',
        key: 'retry-key-one',
        body: { body: 'said once' },
      })
      assert.equal(first.status, 201)
      const second = await call('POST', '/v1/posts', {
        as: 'idem',
        key: 'retry-key-one',
        body: { body: 'said once' },
      })
      assert.equal(second.status, 200)
      assert.equal(second.body.post.id, first.body.post.id)

      const rows = await sql<{ n: string }[]>`select count(*) as n from posts`
      assert.equal(Number(rows[0]!.n), 1)
    })

    it('returns the policy verdict even when it allowed the post', async () => {
      // A client that only sees the verdict on a refusal cannot tell "published" from "published
      // and queued for a human to look at".
      const reply = await post('verdict', 'ordinary words')
      assert.equal(reply.body.policy.decision, 'allow')
      assert.equal(reply.body.policy.degraded, false)
    })

    it('refuses a post with neither words nor a picture', async () => {
      const reply = await post('empty', '   ')
      assert.equal(reply.status, 400)
    })

    it('refuses an attachment with no description', async () => {
      const reply = await call('POST', '/v1/posts', {
        as: 'noalt',
        body: { body: 'a picture', media: [{ kind: 'image', assetId: 'asset-1', alt: '' }] },
      })
      assert.equal(reply.status, 400)
    })

    it('lets the author edit and delete, and nobody else', async () => {
      const created = await post('owner', 'first draft')
      const id = created.body.post.id

      const theirEdit = await call('PATCH', `/v1/posts/${id}`, {
        as: 'interloper',
        body: { body: 'rewritten' },
      })
      assert.equal(theirEdit.status, 404, 'not 403 — see the header')

      const theirDelete = await call('DELETE', `/v1/posts/${id}`, { as: 'interloper' })
      assert.equal(theirDelete.status, 404)

      const mine = await call('PATCH', `/v1/posts/${id}`, {
        as: 'owner',
        body: { body: 'second draft' },
      })
      assert.equal(mine.status, 200)
      assert.equal(mine.body.post.body, 'second draft')
      assert.equal((await call('DELETE', `/v1/posts/${id}`, { as: 'owner' })).status, 204)
    })

    it('sparks and unsparks the same post without counting twice', async () => {
      const created = await post('sparked', 'worth a spark')
      const id = created.body.post.id

      assert.equal((await call('PUT', `/v1/posts/${id}/spark`, { as: 'fan' })).status, 200)
      assert.equal((await call('PUT', `/v1/posts/${id}/spark`, { as: 'fan' })).status, 200)
      const after = await call('GET', `/v1/posts/${id}`, { as: 'fan' })
      assert.equal(after.body.post.sparkCount, 1, 'a double tap is one spark')

      assert.equal((await call('DELETE', `/v1/posts/${id}/spark`, { as: 'fan' })).status, 200)
      const cleared = await call('GET', `/v1/posts/${id}`, { as: 'fan' })
      assert.equal(cleared.body.post.sparkCount, 0)
    })
  })

  /* ---------------------------------------------------------------- the moderation gate */

  describe('the moderation queue', () => {
    it('is closed to an ordinary account', async () => {
      assert.equal((await call('GET', '/v1/moderation/reports', { as: 'nobody' })).status, 403)
    })

    it('is closed to a service token however its scopes are spelled', async () => {
      // There is deliberately no `agora:moderate` scope in the contracts registry. Every action
      // taken from this queue is a human judgement with a human's name beside it, and a scope that
      // let a service suspend a voice would be a credential whose leak empties the square.
      for (const scopes of ['agora:*', 'agora:moderate', 'agora:admin,agora:moderate']) {
        const reply = await call('GET', '/v1/moderation/reports', { as: `svc:${scopes}` })
        assert.equal(reply.status, 403, `a service token with ${scopes} got in`)
        assert.match(String(reply.body.error.message), /role:admin/)
      }
    })

    it('is closed with no token at all', async () => {
      assert.equal((await call('GET', '/v1/moderation/reports')).status, 401)
      assert.equal((await call('POST', '/v1/moderation/actions', { body: {} })).status, 401)
    })

    it('opens to an administrator, and records the operator by name', async () => {
      const author = await seedNamed(sql, 'mod-author', 'modauthor')
      const created = await post('mod-author', 'the reported post')
      const postId = created.body.post.id

      await call('POST', '/v1/reports', {
        as: 'mod-reporter',
        body: { subjectKind: 'post', subjectId: postId, reason: 'abuse' },
      })

      const queue = await call('GET', '/v1/moderation/reports', { as: 'admin:ada' })
      assert.equal(queue.status, 200)
      assert.equal(queue.body.reports.length, 1)

      const acted = await call('POST', '/v1/moderation/actions', {
        as: 'admin:ada',
        body: {
          action: 'post_removed',
          subjectKind: 'post',
          subjectId: postId,
          reason: 'targeted harassment',
        },
      })
      assert.equal(acted.status, 200)

      const history = await call('GET', `/v1/moderation/history/post/${postId}`, { as: 'admin:ada' })
      assert.equal(history.body.history[0].action, 'post_removed')
      assert.equal(history.body.history[0].operator, 'user:ada', 'a name, not a service')
      assert.ok(author.id)
    })

    it('answers a report with a receipt and no id to poll', async () => {
      const target = await seedNamed(sql, 'report-target', 'reporttarget')
      const reply = await call('POST', '/v1/reports', {
        as: 'reporter',
        body: { subjectKind: 'voice', subjectId: target.id, reason: 'spam' },
      })
      assert.equal(reply.status, 202)
      assert.deepEqual(reply.body, { status: 'received' })

      // The duplicate answers identically. "You already reported this" invites an argument about
      // whether the first one was ever seen.
      const again = await call('POST', '/v1/reports', {
        as: 'reporter',
        body: { subjectKind: 'voice', subjectId: target.id, reason: 'abuse' },
      })
      assert.equal(again.status, 202)
      assert.deepEqual(again.body, { status: 'received' })
    })

    it('refuses a reason it does not recognise rather than filing it as something else', async () => {
      const target = await seedNamed(sql, 'reason-target', 'reasontarget')
      const reply = await call('POST', '/v1/reports', {
        as: 'reporter2',
        body: { subjectKind: 'voice', subjectId: target.id, reason: 'i-dislike-them' },
      })
      assert.equal(reply.status, 400)
    })
  })

  /* ---------------------------------------------------------------- the erasure endpoint */

  describe('the inbound event route', () => {
    const envelope = (subjectValue: string) => ({
      id: '11111111-1111-4111-8111-111111111111',
      topic: USER_DELETED_TOPIC,
      payload: { subject: subjectValue },
    })

    async function sendEvent(
      body: unknown,
      options: { signature?: string; secret?: string } = {},
    ): Promise<Reply> {
      const raw = JSON.stringify(body)
      const signature = options.signature ?? signEvent(raw, options.secret ?? SECRET)
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature },
        body: raw,
      })
      const text = await response.text()
      return {
        status: response.status,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
        headers: response.headers,
      }
    }

    it('refuses an unsigned event', async () => {
      // Without this check the route is a free "delete any account" endpoint on the public
      // internet. It is the single most dangerous route in the service.
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope(subject('unsigned'))),
      })
      assert.equal(response.status, 401)
    })

    it('refuses one signed with the wrong secret', async () => {
      const reply = await sendEvent(envelope(subject('wrongsecret')), {
        secret: 'a-different-secret-of-good-length',
      })
      assert.equal(reply.status, 401)
      assert.equal(reply.body.error.code, 'bad_signature')
    })

    it('refuses a body altered after it was signed', async () => {
      const honest = envelope(subject('honest'))
      const signature = signEvent(JSON.stringify(honest), SECRET)
      const reply = await sendEvent(envelope(subject('somebody-else')), { signature })
      assert.equal(reply.status, 401)
    })

    it('erases the account it names, and everything they wrote', async () => {
      await post('doomed', 'something they wrote')
      const before = await findVoiceBySubject(asDb(sql), subject('doomed'))
      assert.ok(before, 'the voice existed')

      const reply = await sendEvent(envelope(subject('doomed')))
      assert.equal(reply.status, 200)
      assert.equal(reply.body.status, 'processed')
      assert.equal(reply.body.erased, true)

      assert.equal(await findVoiceBySubject(asDb(sql), subject('doomed')), null)
      const rows = await sql<{ n: string }[]>`select count(*) as n from posts`
      // Hard deleted, not tombstoned. Everything else on this service soft-deletes so a thread
      // keeps its shape; a person exercising a deletion right did not ask for a tombstone with
      // their handle on it.
      assert.equal(Number(rows[0]!.n), 0)
    })

    it('leaves the subject in no column of any table, including the ones nothing cascades to', async () => {
      // THE SAME QUESTION THE ESTATE'S ERASURE DRILL ASKS, ASKED HERE FIRST.
      //
      // `deploy/scripts/erasure-drill.sh` does not read a handler. It deletes a real user, then
      // scans every text, uuid, varchar and jsonb column of every table in `public` for the id.
      // That scan is what found the defect this test pins: `delete from voices` cascades through
      // fourteen tables and reaches NEITHER the outbox — where every topic writes the actor's
      // `user:<uuid>` and seven repeat it in the payload — nor `moderation_actions.operator`,
      // which is text precisely so an operator need not have a voice here.
      //
      // A hand-written list of tables would have been written by the same person who wrote the
      // handler, and would have missed the same two. So this asks the database.
      const gone = subject('scanned')

      await post('scanned', 'a thing they said')
      // The moderator case: this person CLOSED a report rather than being the one reported. Direct
      // SQL, because how the row arrived is upstream of what is under test, and the admin route
      // that writes it is covered by `moderation.test.ts`.
      const reported = await seedNamed(sql, 'scan-target', 'scantarget')
      await sql`
        insert into moderation_actions (operator, action, subject_kind, subject_id, reason)
        values (${gone}, 'voice_suspended', 'voice', ${reported.id}, 'spam')
      `
      await sql`
        insert into reports (subject_kind, subject_id, reason, state, resolution, resolved_by, resolved_at)
        values ('voice', ${reported.id}, 'spam', 'actioned', 'suspended', ${gone}, now())
      `

      // The before-check is not ceremony. An assertion over an empty table passes for the wrong
      // reason, and that is this estate's most-repeated defect.
      assert.ok(await residual(gone), 'the fixture wrote nothing naming the subject')

      assert.equal((await sendEvent(envelope(gone))).body.status, 'processed')

      assert.equal(await residual(gone), 0, 'a column still names the erased subject')
      // Redacted, not deleted: the emission and the moderation action survive under a placeholder,
      // because an unpublished outbox row is a delivery another service is still owed and a
      // vanished `voice_suspended` un-explains a suspension that is still in force.
      const kept = await sql<{ n: string }[]>`
        select (select count(*) from outbox where actor like 'erased:%')
             + (select count(*) from moderation_actions where operator like 'erased:%')
             + (select count(*) from reports where resolved_by like 'erased:%') as n
      `
      assert.ok(Number(kept[0]!.n) >= 3, 'the redacted rows were deleted rather than redacted')
    })

    it('answers a redelivery as a duplicate instead of erasing twice', async () => {
      await post('twice', 'words')
      assert.equal((await sendEvent(envelope(subject('twice')))).body.status, 'processed')
      const again = await sendEvent(envelope(subject('twice')))
      assert.equal(again.status, 200)
      assert.equal(again.body.status, 'duplicate')
    })

    it('accepts a topic it does not consume with a 202 rather than a refusal', async () => {
      // A 4xx would make the producer's relay retry, for ever, an event it is correct to send and
      // we are correct not to act on.
      const reply = await sendEvent({
        id: '22222222-2222-4222-8222-222222222222',
        topic: 'identity.user.registered',
        payload: {},
      })
      assert.equal(reply.status, 202)
      assert.equal(reply.body.status, 'ignored')
    })

    it('refuses an envelope with no uuid id', async () => {
      const reply = await sendEvent({ id: 'not-a-uuid', topic: USER_DELETED_TOPIC, payload: {} })
      assert.equal(reply.status, 400)
    })
  })

  /* ---------------------------------------------------------------- private mail */

  describe('whispers', () => {
    it('will not let a third party read a thread they are not in', async () => {
      await seedNamed(sql, 'whisper-b', 'whisperb')
      const sent = await call('POST', '/v1/whispers', {
        as: 'whisper-a',
        body: { to: 'whisperb', body: 'between us' },
      })
      assert.equal(sent.status, 201)
      const threadId = sent.body.whisper.threadId

      const nosy = await call('GET', `/v1/whispers/${threadId}`, { as: 'whisper-c' })
      assert.equal(nosy.status, 404)

      const recipient = await call('GET', `/v1/whispers/${threadId}`, { as: 'whisper-b' })
      assert.equal(recipient.status, 200)
      assert.equal(recipient.body.whispers.length, 1)
      assert.equal(recipient.body.whispers[0].body, 'between us')
    })

    it('leaves a tombstone when a message is deleted rather than making it vanish', async () => {
      // A message that disappears without trace is a gaslighting primitive: the recipient read it
      // and now has no evidence it was ever sent.
      await seedNamed(sql, 'del-b', 'delb')
      const sent = await call('POST', '/v1/whispers', {
        as: 'del-a',
        body: { to: 'delb', body: 'said in haste' },
      })
      const messageId = sent.body.whisper.id
      const threadId = sent.body.whisper.threadId

      assert.equal(
        (await call('DELETE', `/v1/whispers/messages/${messageId}`, { as: 'del-a' })).status,
        204,
      )

      const seen = await call('GET', `/v1/whispers/${threadId}`, { as: 'del-b' })
      assert.equal(seen.body.whispers.length, 1)
      assert.equal(seen.body.whispers[0].deleted, true)
      assert.equal(seen.body.whispers[0].body, '')
    })

    it('will not let the recipient delete the sender’s words', async () => {
      await seedNamed(sql, 'nodel-b', 'nodelb')
      const sent = await call('POST', '/v1/whispers', {
        as: 'nodel-a',
        body: { to: 'nodelb', body: 'mine to withdraw' },
      })
      const reply = await call('DELETE', `/v1/whispers/messages/${sent.body.whisper.id}`, {
        as: 'nodel-b',
      })
      assert.equal(reply.status, 404)
    })
  })

  /* ---------------------------------------------------------------- circles */

  describe('circles', () => {
    it('makes the creator a steward and refuses to hand that over in the body', async () => {
      const other = await seedNamed(sql, 'circle-other', 'circleother')
      const created = await call('POST', '/v1/circles', {
        as: 'circle-founder',
        body: {
          slug: 'ecology',
          name: 'Ecology',
          purpose: 'talking about the weather',
          stewardId: other.id,
        },
      })
      assert.equal(created.status, 201)

      const founder = await findVoiceBySubject(asDb(sql), subject('circle-founder'))
      const rows = await sql<{ voice_id: string; role: string }[]>`
        select voice_id, role from circle_members where role = 'steward'
      `
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.voice_id, founder?.id)
    })

    it('answers 404 for a closed circle’s posts, to a stranger', async () => {
      await call('POST', '/v1/circles', {
        as: 'closed-steward',
        body: { slug: 'private-room', name: 'Private Room', visibility: 'closed' },
      })
      // The circle is LISTED — that is deliberate, a closed room somebody can ask to join has to
      // be findable — but its conversation is not readable.
      const listed = await call('GET', '/v1/circles')
      assert.equal(listed.status, 200)
      assert.equal(listed.body.circles.length, 1)

      const posts = await call('GET', '/v1/circles/private-room/posts', { as: 'outsider' })
      assert.equal(posts.status, 404)
    })

    it('refuses to demote the last steward through the members route', async () => {
      await call('POST', '/v1/circles', {
        as: 'last-steward',
        body: { slug: 'lonely', name: 'Lonely' },
      })
      const me = await findVoiceBySubject(asDb(sql), subject('last-steward'))
      const reply = await call('PUT', `/v1/circles/lonely/members/${me!.id}`, {
        as: 'last-steward',
        body: { action: 'role', role: 'member' },
      })
      assert.equal(reply.status, 409, 'a state conflict, not a validation error')
      assert.match(String(reply.body.error.message), /steward/)
    })
  })

  /* ---------------------------------------------------------------- limits */

  describe('limits', () => {
    it('caps a page size rather than letting a client ask for the whole square', async () => {
      for (let i = 0; i < 3; i += 1) await post('pager', `post ${i}`)
      const reply = await call('GET', '/v1/timeline/latest?limit=100000')
      assert.equal(reply.status, 200)
      assert.ok(reply.body.posts.length <= 50)
    })

    it('answers 429 with a retry-after that matches the message', async () => {
      // The header and the body come off the same error, so a client honouring the header and a
      // person reading the message cannot be told two different things.
      const limited = createLimitedServer(sql)
      await limited.start()
      try {
        assert.equal((await limited.post('rl', 'one')).status, 201)
        const refused = await limited.post('rl', 'two')
        assert.equal(refused.status, 429)
        assert.equal(refused.body.error.code, 'rate_limited')
        const header = Number(refused.headers.get('retry-after'))
        assert.ok(header > 0)
        assert.equal(header, refused.body.error.retryAfterSeconds)
      } finally {
        await limited.stop()
      }
    })

    it('pauses posting with a 503 rather than telling somebody their post was refused', async () => {
      // The break-glass switch is about US. A 403 here is a lie somebody would reasonably take
      // personally, and they would spend an evening rewriting a post that was never the problem.
      const paused = createPausedServer(sql)
      await paused.start()
      try {
        const reply = await paused.post('paused', 'anything at all')
        assert.equal(reply.status, 503)
        assert.equal(reply.body.error.code, 'posting_paused')
        assert.equal(reply.headers.get('retry-after'), '300')
        assert.match(String(reply.body.error.message), /nothing already written is affected/)
      } finally {
        await paused.stop()
      }
    })
  })
})

/* ------------------------------------------------------------------ second servers */

/**
 * A second server on the same database, with one dependency changed.
 *
 * The rate limit and the posting switch are process-wide settings, and testing them by mutating the
 * shared `deps` would leak into every test that ran afterwards in a file that is deliberately
 * serial. A second socket is cheap and cannot leak.
 */
function createAltServer(database: postgres.Sql, options: Parameters<typeof testDeps>[1]) {
  let alt: Server
  let url = ''
  return {
    async start() {
      const deps = testDeps(database, options)
      const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 100 })
      lifecycle.markReady()
      alt = createServer({
        lifecycle,
        logger: quietLogger(),
        metrics: testMetrics(),
        verifier,
        sql: singleNetworkSql(asDb(database)),
        singleNetwork: 'mainnet' as const,
        producer: 'agora',
        posts: deps.posts,
        circles: deps.circles,
        whispers: deps.whispers,
        notifications: deps.notifications,
        moderation: deps.moderation,
        followsPerHour: 1_000,
        studioPublicUrl: '',
        queue: new JobQueue(database as unknown as JobsSql, {
          owner: 'agora-alt',
          leaseMs: 60_000,
        }),
        eventSigningSecret: SECRET,
        pageSizeMax: 50,
      })
      await new Promise<void>((resolve) => alt.listen(0, '127.0.0.1', () => resolve()))
      url = `http://127.0.0.1:${(alt.address() as AddressInfo).port}`
    },
    async stop() {
      await new Promise<void>((resolve) => alt.close(() => resolve()))
    },
    async post(as: string, body: string): Promise<Reply> {
      const response = await fetch(`${url}/v1/posts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${as}` },
        body: JSON.stringify({ body }),
      })
      const text = await response.text()
      return {
        status: response.status,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
        headers: response.headers,
      }
    },
  }
}

const createLimitedServer = (database: postgres.Sql) =>
  createAltServer(database, { postsPerHour: 1 })

const createPausedServer = (database: postgres.Sql) =>
  createAltServer(database, { postingEnabled: false })
