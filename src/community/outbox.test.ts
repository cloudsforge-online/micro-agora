/**
 * Outbox, relay and inbox.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE CORRECTED GUARANTEE. DO NOT LET THE OLD ONE BACK IN.**
 *
 * The comment in this file's implementation used to say "a subscriber added after the event was
 * written still receives it". It was carried verbatim by eighteen repositories and it is FALSE:
 * `published_at` is set as soon as nothing is outstanding, and with no active subscription for the
 * topic — the ordinary case for a new event type — the outstanding count is zero on the first pass,
 * the row is published immediately, and it is never reconsidered.
 *
 * The behaviour is right; the promise was wrong. An outbox row that stays unpublished because
 * nobody is listening is a backlog that grows for ever. A false guarantee is worse than none,
 * because an integrator plans around it: "register the subscription whenever, the outbox will catch
 * up" is a reasonable thing to believe from the old wording and will silently lose every event
 * published before the subscription existed.
 *
 * `an event published with nothing subscribed is NOT redelivered` below is the test that pins the
 * corrected reading, in both directions — the true half (a subscriber added mid-flight receives the
 * remainder) is pinned too.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import type { HttpClient } from '@cloudsforge/http'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  createRelay,
  signEvent,
  verifyEventSignature,
  withInbox,
  withOutbox,
  type EventEnvelope,
  type Tx,
} from './outbox.ts'
import { TOPICS, TOPIC_NAMES, CONSUMED_TOPICS, USER_DELETED_TOPIC } from './events.ts'
import { asDb, migrateTestDb, openDb, quietLogger, resetCommunity, skip } from './testsupport.ts'

let sql: postgres.Sql

const SECRET = 'a-signing-secret-long-enough-000'

before(async () => {
  if (!skip) {
    sql = openDb()
    await migrateTestDb(sql)
  }
})

after(async () => {
  if (!skip) await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (skip) return
  await resetCommunity(sql)
})

function acceptingClient(onRequest?: (envelope: EventEnvelope, headers: Record<string, string>) => void) {
  return {
    async request<T>(_path: string, options?: { body?: unknown; headers?: Record<string, string> }): Promise<T> {
      onRequest?.(options?.body as EventEnvelope, options?.headers ?? {})
      return undefined as T
    },
  } as Pick<HttpClient, 'request'>
}

const relayDeps = (clientFor: (url: string) => Pick<HttpClient, 'request'>) => ({
  sql: asDb(sql),
  logger: quietLogger(),
  signingSecret: SECRET,
  clientFor,
})

async function tick(clientFor: (url: string) => Pick<HttpClient, 'request'>): Promise<void> {
  const relay = createRelay(relayDeps(clientFor))
  await relay(
    { id: 'j', kind: 'outbox.relay', key: 'global', attempts: 0, maxAttempts: 5, payload: {} },
    { heartbeat: async () => true, signal: new AbortController().signal },
  )
}

/* ------------------------------------------------------------------ the transaction */

test('an event is written in the same transaction as the change', { skip }, async () => {
  await assert.rejects(
    () =>
      withOutbox(asDb(sql), 'community', async (tx, emit) => {
        await tx`insert into inbox (topic, event_id) values ('x', gen_random_uuid())`
        emit({ topic: TOPICS.proposalExecuted, key: 'p1', payload: { proposalId: 'p1' } })
        throw new Error('the change failed')
      }),
    /the change failed/,
  )
  // Neither the change nor the event. A publish before commit is a publish of something that never
  // happened, and for `community.proposal.executed` that means every consumer believes a treasury
  // was spent when it was not.
  const events = await sql<{ n: number }[]>`select count(*)::int as n from outbox`
  const changes = await sql<{ n: number }[]>`select count(*)::int as n from inbox`
  assert.equal(events[0]?.n, 0)
  assert.equal(changes[0]?.n, 0)
})

test('emit collects and only writes once the handler has succeeded', { skip }, async () => {
  const result = await withOutbox(asDb(sql), 'community', async (_tx, emit) => {
    emit({ topic: TOPICS.proposalExecuted, key: 'p1', payload: { proposalId: 'p1' } })
    emit({ topic: TOPICS.voteCast, key: 'p1', payload: { proposalId: 'p1' } })
    return 'done'
  })
  assert.equal(result, 'done')
  const rows = await sql<{ topic: string; producer: string }[]>`select topic, producer from outbox order by topic`
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.producer, 'community')
})

/* ------------------------------------------------------------------ the corrected guarantee */

test('an event published with nothing subscribed is NOT redelivered', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // The corrected reading. Publishing with no subscription marks the row published on the first
  // pass, and a subscriber registered afterwards receives nothing.
  //
  // If this test ever fails, somebody has restored the old behaviour along with the old comment —
  // and the backlog it produces grows for ever.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  await withOutbox(asDb(sql), 'community', async (_tx, emit) => {
    emit({ topic: TOPICS.proposalExecuted, key: 'p1', payload: { proposalId: 'p1' } })
  })

  const delivered: EventEnvelope[] = []
  await tick(() => acceptingClient((envelope) => delivered.push(envelope)))

  const published = await sql<{ published_at: Date | null }[]>`select published_at from outbox`
  assert.ok(published[0]?.published_at !== null, 'the row was left unpublished with nobody listening')
  assert.equal(delivered.length, 0)

  // A subscriber added now gets nothing, because the row is already published.
  await sql`
    insert into event_subscriptions (topic, url) values (${TOPICS.proposalExecuted}, 'http://late/hook')
  `
  await tick(() => acceptingClient((envelope) => delivered.push(envelope)))
  assert.equal(delivered.length, 0, 'a late subscriber received an event published before it existed')
})

test('a subscriber added mid-flight receives the remainder — the true half', { skip }, async () => {
  // Delivery rows ARE computed from the live subscription set on every pass, which is what makes
  // this work. It is the half of the old comment that was correct.
  await sql`insert into event_subscriptions (topic, url) values (${TOPICS.proposalExecuted}, 'http://a/hook')`
  await withOutbox(asDb(sql), 'community', async (_tx, emit) => {
    emit({ topic: TOPICS.proposalExecuted, key: 'p1', payload: { proposalId: 'p1' } })
  })

  // The first pass fails for subscriber A, so the row stays unpublished.
  await tick(() => ({ async request() { throw new Error('down') } }) as Pick<HttpClient, 'request'>)
  const mid = await sql<{ published_at: Date | null }[]>`select published_at from outbox`
  assert.equal(mid[0]?.published_at, null)

  // B registers while the row is still outstanding, and receives it on the next pass.
  await sql`insert into event_subscriptions (topic, url) values (${TOPICS.proposalExecuted}, 'http://b/hook')`
  const urls: string[] = []
  await tick(() => acceptingClient(() => undefined))
  const rows = await sql<{ url: string; delivered_at: Date | null }[]>`
    select s.url, d.delivered_at from outbox_deliveries d
      join event_subscriptions s on s.id = d.subscription_id
     order by s.url
  `
  for (const row of rows) urls.push(row.url)
  assert.deepEqual(urls, ['http://a/hook', 'http://b/hook'])
  assert.ok(rows.every((row) => row.delivered_at !== null))
})

/* ------------------------------------------------------------------ signing */

test('a delivery is signed over the exact bytes sent', { skip }, async () => {
  await sql`insert into event_subscriptions (topic, url) values (${TOPICS.proposalExecuted}, 'http://a/hook')`
  await withOutbox(asDb(sql), 'community', async (_tx, emit) => {
    emit({ topic: TOPICS.proposalExecuted, key: 'p1', payload: { proposalId: 'p1', amount: '1000' } })
  })

  let seen: { envelope: EventEnvelope; headers: Record<string, string> } | null = null
  await tick(() => acceptingClient((envelope, headers) => { seen = { envelope, headers } }))

  assert.ok(seen !== null)
  const { envelope, headers } = seen as { envelope: EventEnvelope; headers: Record<string, string> }
  const signature = headers[SIGNATURE_HEADER]
  assert.ok(signature)
  // A subscriber recomputes the MAC over the received body, so the two must agree byte for byte.
  assert.ok(verifyEventSignature(JSON.stringify(envelope), SECRET, signature!))
  // And a different secret does not verify — otherwise this asserts nothing.
  assert.equal(verifyEventSignature(JSON.stringify(envelope), 'another-secret-long-enough-0000', signature!), false)
  assert.equal(headers[EVENT_ID_HEADER], envelope.id)
})

test('signature verification is length-safe', { skip: false }, () => {
  const body = '{"a":1}'
  const good = signEvent(body, SECRET)
  assert.equal(verifyEventSignature(body, SECRET, good), true)
  // A shorter presented value must not throw inside `timingSafeEqual`, which requires equal lengths.
  // `sha256=<hex>` is the DRIFTED local scheme this service used to sign with; it must now be
  // refused as a malformed header rather than quietly accepted, or the migration to the contract's
  // scheme would be a scheme this service still answers to.
  assert.equal(verifyEventSignature(body, SECRET, 'sha256=abc'), false)
  assert.equal(verifyEventSignature(body, SECRET, ''), false)
  assert.equal(verifyEventSignature('{"a":2}', SECRET, good), false)
})

/* ------------------------------------------------------------------ the inbox */

test('the inbox runs a handler exactly once per (topic, event_id)', { skip }, async () => {
  const id = crypto.randomUUID()
  let ran = 0
  const first = await withInbox(asDb(sql), USER_DELETED_TOPIC, id, async () => {
    ran += 1
    return { ok: true }
  })
  assert.equal(first.status, 'processed')

  const second = await withInbox(asDb(sql), USER_DELETED_TOPIC, id, async () => {
    ran += 1
    return { ok: true }
  })
  assert.equal(second.status, 'duplicate')
  assert.equal(ran, 1)
})

test('a failed handler leaves no inbox row, so the redelivery is processed', { skip }, async () => {
  // The mistake a naive "record then handle" dedupe makes: the row is written, the handler fails,
  // and the redelivery is swallowed as a duplicate. The event is lost with no trace.
  const id = crypto.randomUUID()
  await assert.rejects(
    () => withInbox(asDb(sql), USER_DELETED_TOPIC, id, async () => { throw new Error('handler failed') }),
    /handler failed/,
  )
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from inbox where event_id = ${id}`
  assert.equal(rows[0]?.n, 0)

  const retry = await withInbox(asDb(sql), USER_DELETED_TOPIC, id, async () => ({ ok: true }))
  assert.equal(retry.status, 'processed')
})

test('the same event id on two topics is two events', { skip }, async () => {
  const id = crypto.randomUUID()
  assert.equal((await withInbox(asDb(sql), 'a.b.c', id, async () => 1)).status, 'processed')
  assert.equal((await withInbox(asDb(sql), 'd.e.f', id, async () => 1)).status, 'processed')
})

/* ------------------------------------------------------------------ delivery failure */

test('one unreachable subscriber does not stop the others', { skip }, async () => {
  await sql`
    insert into event_subscriptions (topic, url)
    values (${TOPICS.proposalExecuted}, 'http://good/hook'), (${TOPICS.proposalExecuted}, 'http://bad/hook')
  `
  await withOutbox(asDb(sql), 'community', async (_tx, emit) => {
    emit({ topic: TOPICS.proposalExecuted, key: 'p1', payload: {} })
  })

  await tick((url: string) =>
    url.includes('bad')
      ? ({ async request() { throw new Error('down') } } as Pick<HttpClient, 'request'>)
      : acceptingClient(),
  )

  const rows = await sql<{ url: string; delivered_at: Date | null; last_error: string | null }[]>`
    select s.url, d.delivered_at, d.last_error from outbox_deliveries d
      join event_subscriptions s on s.id = d.subscription_id order by s.url
  `
  const bad = rows.find((row) => row.url.includes('bad'))!
  const good = rows.find((row) => row.url.includes('good'))!
  assert.ok(good.delivered_at !== null, 'a healthy subscriber was skipped because another was down')
  assert.equal(bad.delivered_at, null)
  // The undelivered row is the durable record, and the next pass retries it.
  assert.match(bad.last_error ?? '', /down/)

  // And the event is NOT published while one delivery is outstanding.
  const published = await sql<{ published_at: Date | null }[]>`select published_at from outbox`
  assert.equal(published[0]?.published_at, null)
})

/* ------------------------------------------------------------------ the topic vocabulary */

test('every topic this service produces is named for it and past tense', { skip: false }, () => {
  for (const topic of TOPIC_NAMES) {
    const parts = topic.split('.')
    assert.equal(parts.length, 3, `${topic} is not <service>.<aggregate>.<verb>`)
    assert.equal(parts[0], 'community', `${topic} is not produced by this service`)
    // `cast` is the past participle of `to cast`. English rather than a suffix rule — a check
    // that demanded `-ed` would force `community.vote.casted`, which is not a word.
    assert.match(parts[2]!, /(ed|cast)$/, `${topic} is not past tense`)
  }
})

test('the one topic the dependency map names is present and keyed by proposal', { skip }, async () => {
  // 07-dependency-map.md — `community.proposal.executed`, keyed by `proposal_id`, consumed by
  // ledger, activity and notify.
  assert.equal(TOPICS.proposalExecuted, 'community.proposal.executed')
  await withOutbox(asDb(sql), 'community', async (_tx, emit) => {
    emit({ topic: TOPICS.proposalExecuted, key: 'the-proposal-id', payload: {} })
  })
  const rows = await sql<{ key: string }[]>`select key from outbox`
  assert.equal(rows[0]?.key, 'the-proposal-id')
})

test('the consumed set is what this service subscribes to', { skip: false }, () => {
  assert.ok(CONSUMED_TOPICS.includes(USER_DELETED_TOPIC), 'the GDPR erasure path is not subscribed')
  for (const topic of CONSUMED_TOPICS) {
    assert.ok(!topic.startsWith('community.'), `${topic} is this service's own`)
  }
})
