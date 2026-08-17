/**
 * The bus: outbox, relay, inbox.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE EVENT AND THE CHANGE COMMIT TOGETHER OR NOT AT ALL.**
 *
 * Rule 5, and the only thing here worth a test that could not be written any other way. `commits
 * the event with the change` and `writes neither when the handler throws` are the pair: either one
 * alone passes against an implementation that publishes after the commit, and that implementation
 * is silently lossy exactly when the process dies between the two writes.
 *
 * The inbox half is the same shape inverted. `withInbox` inserts and handles in ONE transaction so
 * a failing handler leaves no row — the case `a handler that throws leaves no inbox row` proves,
 * and the case that separates this from the naive "record then handle" dedupe, which drops an
 * event permanently the first time its handler has a bad day.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { strict as assert } from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import { validateEnvelope } from '@cloudsforge/contracts-events'
import {
  buildEnvelope,
  createRelay,
  emitOn,
  signEvent,
  verifyEventSignature,
  withInbox,
  withOutbox,
  type Tx,
} from './outbox.ts'
import {
  SERVICE,
  asDb,
  asTx,
  migrateTestDb,
  openDb,
  quietLogger,
  resetAgora,
  skip,
} from './testsupport.ts'

const SECRET = 'a-signing-secret-for-tests-only-not-a-credential'

// `inbox.event_id` is a uuid, because an event id in this estate is one. A test that passed a
// readable string here would be testing a column the service does not have.
const EVENT_ONE = '11111111-1111-4111-8111-111111111111'
const EVENT_TWO = '22222222-2222-4222-8222-222222222222'
const EVENT_THREE = '33333333-3333-4333-8333-333333333333'

describe('the outbox', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })

  after(async () => {
    await sql.end()
  })

  beforeEach(async () => {
    await resetAgora(sql)
  })

  describe('writing', () => {
    it('commits the event with the change', async () => {
      const id = await withOutbox(asDb(sql), SERVICE, async (tx, emit) => {
        const rows = await tx<{ id: string }[]>`
          insert into voices (subject, handle) values ('user:together', 'together') returning id
        `
        emit({ topic: 'agora.voice.renamed', key: rows[0]!.id, payload: { voiceId: rows[0]!.id } })
        return rows[0]!.id
      })

      const events = await sql<{ topic: string; key: string }[]>`select topic, key from outbox`
      assert.equal(events.length, 1)
      assert.equal(events[0]!.key, id)
    })

    it('writes neither when the handler throws', async () => {
      // The half that makes the guarantee real. An implementation that publishes after the commit
      // passes the case above and fails this one, and the difference between them is every event
      // emitted for a change that was rolled back.
      await assert.rejects(
        () =>
          withOutbox(asDb(sql), SERVICE, async (tx, emit) => {
            await tx`insert into voices (subject, handle) values ('user:doomed', 'doomed')`
            emit({ topic: 'agora.voice.renamed', key: 'doomed', payload: {} })
            throw new Error('the domain refused')
          }),
        /the domain refused/,
      )

      const voices = await sql<{ n: string }[]>`
        select count(*) as n from voices where subject = 'user:doomed'
      `
      const events = await sql<{ n: string }[]>`select count(*) as n from outbox`
      assert.equal(Number(voices[0]!.n), 0)
      assert.equal(Number(events[0]!.n), 0)
    })

    it('collects rather than writing, so nothing is published before the handler succeeds', async () => {
      // Observed from INSIDE the transaction: at the moment `emit` is called the row must not be
      // there yet. This is what makes `emit` safe to call early in a long handler.
      await withOutbox(asDb(sql), SERVICE, async (tx, emit) => {
        emit({ topic: 'agora.post.created', key: 'k', payload: {} })
        const seen = await tx<{ n: string }[]>`select count(*) as n from outbox`
        assert.equal(Number(seen[0]!.n), 0, 'emit wrote immediately')
      })
      const after_ = await sql<{ n: string }[]>`select count(*) as n from outbox`
      assert.equal(Number(after_[0]!.n), 1)
    })

    it('takes an emit on a transaction the caller already holds', async () => {
      await sql.begin(async (tx) => {
        await emitOn(asTx(tx), SERVICE, {
          topic: 'agora.spark.created',
          key: 'post-1',
          payload: { postId: 'post-1' },
          actor: 'user:sparker',
          correlationId: 'req-9',
        })
        return { done: true }
      })
      const rows = await sql<{ actor: string; correlation_id: string; version: number }[]>`
        select actor, correlation_id, version from outbox
      `
      assert.equal(rows[0]!.actor, 'user:sparker')
      assert.equal(rows[0]!.correlation_id, 'req-9')
      assert.equal(rows[0]!.version, 1, 'the stored version is the major, as an integer')
    })
  })

  describe('the envelope', () => {
    it('is the shape the contract validates, without either default having to fire', async () => {
      await withOutbox(asDb(sql), SERVICE, async (_tx, emit) => {
        emit({
          topic: 'agora.post.created',
          key: 'post-1',
          payload: { postId: 'post-1', visibility: 'public' },
          actor: 'user:author',
          correlationId: 'req-1',
        })
      })
      const envelope = buildEnvelope(await onlyRow(sql))
      // Against the CONTRACT's validator, not a local copy of what it is believed to check. Every
      // service's suite was green while every event it emitted was refused, because both sides
      // tested against imagined counterparts.
      const verdict = validateEnvelope(envelope)
      assert.equal(verdict.ok, true, JSON.stringify(verdict))
    })

    it('sends a version the contract can read, from a column that stores an integer', async () => {
      await withOutbox(asDb(sql), SERVICE, async (_tx, emit) => {
        emit({ topic: 'agora.voice.renamed', key: 'v', payload: {}, actor: 'user:a' })
      })
      // `1` end to end was refused as "version: missing" — the integer wearing a third hat.
      assert.equal(buildEnvelope(await onlyRow(sql)).version, '1.0')
    })

    it('gives a service-emitted event an actor and a correlation root', async () => {
      // The mail sweep emits with neither, because a leased job has no requester. Nulls are storage
      // facts and the wire has no such freedom: `validateEnvelope` refuses both, so an event from a
      // job would be lost rather than traced.
      await withOutbox(asDb(sql), SERVICE, async (_tx, emit) => {
        emit({ topic: 'agora.notification.mail_requested', key: 'n', payload: {} })
      })
      const envelope = buildEnvelope(await onlyRow(sql))
      assert.equal(envelope.actor, 'service:agora')
      assert.equal(envelope.correlationId, envelope.id, 'its own correlation root')
      assert.equal(validateEnvelope(envelope).ok, true)
    })
  })

  describe('signing', () => {
    it('round-trips, in the contract’s format', () => {
      const body = JSON.stringify({ id: 'e1', topic: 'agora.post.created' })
      const signature = signEvent(body, SECRET)
      // `t=<seconds>,v1=<hmac>`. The old local format was `sha256=<hmac>` under a different header
      // name, and it meant every delivery from every producer was refused.
      assert.match(signature, /^t=\d+,v1=[0-9a-f]{64}$/)
      assert.equal(verifyEventSignature(body, SECRET, signature), true)
    })

    it('refuses a tampered body, a wrong secret and a malformed header', () => {
      const body = JSON.stringify({ amount: 1 })
      const signature = signEvent(body, SECRET)
      assert.equal(verifyEventSignature(JSON.stringify({ amount: 1000 }), SECRET, signature), false)
      assert.equal(verifyEventSignature(body, 'a-different-secret', signature), false)
      assert.equal(verifyEventSignature(body, SECRET, 'sha256=deadbeef'), false)
      assert.equal(verifyEventSignature(body, SECRET, ''), false)
    })
  })

  describe('the relay', () => {
    it('delivers to every active subscription and marks the row published', async () => {
      const posted: Array<{ path: string; body: unknown; headers: Record<string, string> }> = []
      await seedEvent(sql, 'agora.post.created')
      await seedSubscription(sql, 'agora.post.created', 'http://activity:4000/v1/events')
      await seedSubscription(sql, 'agora.post.created', 'http://notify:4000/v1/events')

      await runRelay(sql, (_url) => ({
        async request(path: string, options: Record<string, unknown>) {
          posted.push({
            path,
            body: options.body,
            headers: options.headers as Record<string, string>,
          })
          return undefined as never
        },
      }))

      assert.equal(posted.length, 2)
      assert.equal(posted[0]!.path, '/v1/events')
      // Signed over the exact bytes the client will send, so the MAC the subscriber recomputes
      // over the received body matches rather than nearly matching.
      const signature = posted[0]!.headers['cf-signature']!
      assert.equal(verifyEventSignature(JSON.stringify(posted[0]!.body), SECRET, signature), true)

      const rows = await sql<{ published_at: Date | null }[]>`select published_at from outbox`
      assert.ok(rows[0]!.published_at)
      const deliveries = await sql<{ delivered_at: Date | null }[]>`
        select delivered_at from outbox_deliveries
      `
      assert.equal(deliveries.length, 2)
      assert.ok(deliveries.every((d) => d.delivered_at))
    })

    it('publishes an event nobody is listening for', async () => {
      // The behaviour is right and the old comment's promise was wrong: a row held back because no
      // subscriber exists is a backlog that grows for ever. What is NOT true — and was claimed by
      // eighteen repositories — is that a subscriber registered later still receives it.
      await seedEvent(sql, 'agora.echo.created')
      await runRelay(sql, () => ({
        async request() {
          throw new Error('nothing should have been delivered')
        },
      }))
      const rows = await sql<{ published_at: Date | null }[]>`select published_at from outbox`
      assert.ok(rows[0]!.published_at)
    })

    it('records the failure, leaves the row unpublished, and does not stop the batch', async () => {
      await seedEvent(sql, 'agora.post.created', 'first')
      await seedEvent(sql, 'agora.post.created', 'second')
      await seedSubscription(sql, 'agora.post.created', 'http://dead:4000/v1/events')

      let calls = 0
      await runRelay(sql, () => ({
        async request() {
          calls += 1
          throw new Error('ECONNREFUSED')
        },
      }))

      assert.equal(calls, 2, 'one unreachable subscriber must not stop the rest of the batch')
      const rows = await sql<{ published_at: Date | null }[]>`
        select published_at from outbox order by key
      `
      assert.ok(rows.every((r) => r.published_at === null), 'nothing may be marked delivered')
      const deliveries = await sql<{ last_error: string | null; attempts: number }[]>`
        select last_error, attempts from outbox_deliveries
      `
      assert.equal(deliveries.length, 2)
      assert.ok(deliveries.every((d) => d.last_error?.includes('ECONNREFUSED')))
    })

    it('does not re-POST something already delivered, and counts the retry', async () => {
      await seedEvent(sql, 'agora.post.created')
      const subscriptionId = await seedSubscription(
        sql,
        'agora.post.created',
        'http://activity:4000/v1/events',
      )
      const event = await onlyRow(sql)
      await sql`
        insert into outbox_deliveries (event_id, subscription_id, attempts, delivered_at)
        values (${event.id}, ${subscriptionId}, 1, now())
      `

      let calls = 0
      await runRelay(sql, () => ({
        async request() {
          calls += 1
          return undefined as never
        },
      }))
      assert.equal(calls, 0, 'a delivered row is claimed and skipped, not sent twice')
      const rows = await sql<{ attempts: number }[]>`select attempts from outbox_deliveries`
      assert.equal(rows[0]!.attempts, 2, 'the attempt is still counted')
    })

    it('stops when the lease is aborted rather than finishing the batch', async () => {
      await seedEvent(sql, 'agora.post.created', 'a')
      await seedEvent(sql, 'agora.post.created', 'b')
      const controller = new AbortController()
      controller.abort()
      const relay = createRelay({ sql: asDb(sql), logger: quietLogger(), signingSecret: SECRET })
      await relay({} as never, { heartbeat: async () => true, signal: controller.signal })
      const rows = await sql<{ published_at: Date | null }[]>`select published_at from outbox`
      assert.ok(rows.every((r) => r.published_at === null))
    })
  })

  describe('the inbox', () => {
    it('runs a handler once and calls the redelivery a duplicate', async () => {
      let runs = 0
      const first = await withInbox(asDb(sql), 'ledger.entry.posted', EVENT_ONE, async () => {
        runs += 1
        return 'handled'
      })
      const second = await withInbox(asDb(sql), 'ledger.entry.posted', EVENT_ONE, async () => {
        runs += 1
        return 'handled'
      })
      assert.deepEqual(first, { status: 'processed', value: 'handled' })
      assert.deepEqual(second, { status: 'duplicate' })
      assert.equal(runs, 1)
    })

    it('tells one event id from the same id on another topic', async () => {
      await withInbox(asDb(sql), 'ledger.entry.posted', EVENT_ONE, async () => 1)
      const other = await withInbox(asDb(sql), 'identity.account.created', EVENT_ONE, async () => 2)
      // The dedupe key is `(topic, event_id)` — AD-10. Two producers may mint the same id.
      assert.deepEqual(other, { status: 'processed', value: 2 })
    })

    it('a handler that throws leaves no inbox row, so the redelivery is processed', async () => {
      await assert.rejects(
        () =>
          withInbox(asDb(sql), 'ledger.entry.posted', EVENT_TWO, async () => {
            throw new Error('the handler could not')
          }),
        /the handler could not/,
      )
      const rows = await sql<{ n: string }[]>`select count(*) as n from inbox`
      assert.equal(Number(rows[0]!.n), 0, 'a recorded-then-failed event is an event lost for good')

      const retry = await withInbox(asDb(sql), 'ledger.entry.posted', EVENT_TWO, async () => 'ok')
      assert.deepEqual(retry, { status: 'processed', value: 'ok' })
    })

    it('rolls the handler’s own writes back with it', async () => {
      await assert.rejects(() =>
        withInbox(asDb(sql), 'ledger.entry.posted', EVENT_THREE, async (tx: Tx) => {
          await tx`insert into voices (subject, handle) values ('user:inbox', 'inboxvoice')`
          throw new Error('after the write')
        }),
      )
      const rows = await sql<{ n: string }[]>`
        select count(*) as n from voices where subject = 'user:inbox'
      `
      assert.equal(Number(rows[0]!.n), 0)
    })
  })
})

/* ------------------------------------------------------------------ helpers */

interface OutboxRow {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurred_at: Date
  readonly producer: string
  readonly version: number
  readonly actor: string | null
  readonly correlation_id: string | null
  readonly payload: Record<string, unknown>
}

async function onlyRow(sql: postgres.Sql): Promise<OutboxRow> {
  const rows = await sql<OutboxRow[]>`
    select id, topic, key, occurred_at, producer, version, actor, correlation_id, payload
      from outbox order by occurred_at limit 1
  `
  return rows[0]!
}

async function seedEvent(sql: postgres.Sql, topic: string, key = 'k'): Promise<void> {
  await sql`
    insert into outbox (topic, key, producer, version, actor, correlation_id, payload)
    values (${topic}, ${key}, ${SERVICE}, 1, 'user:someone', 'req-1', ${sql.json({ a: 1 })})
  `
}

async function seedSubscription(sql: postgres.Sql, topic: string, url: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into event_subscriptions (topic, url, active) values (${topic}, ${url}, true)
    returning id
  `
  return rows[0]!.id
}

/** One relay tick with the `clientFor` seam wired to a fake, and a lease that never lapses. */
async function runRelay(
  sql: postgres.Sql,
  clientFor: (url: string) => { request: (path: string, options: Record<string, unknown>) => Promise<never> },
): Promise<void> {
  const relay = createRelay({
    sql: asDb(sql),
    logger: quietLogger(),
    signingSecret: SECRET,
    clientFor: clientFor as never,
  })
  await relay({} as never, { heartbeat: async () => true, signal: new AbortController().signal })
}
