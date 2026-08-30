/**
 * The outbox: the event and the change commit together, or neither does.
 *
 * Rule 5 of docs/ecosystem/03 §2. A publish after commit is a publish that is skipped when the
 * process dies in between; a publish before commit is a publish of something that never happened.
 * Both failure modes are silent and both are unrecoverable after the fact.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { classifyEnvelope, type EventVersion } from '@cloudsforge/contracts-events'
import {
  MARKET_OPENED,
  TOPICS,
  buildEnvelope,
  signEvent,
  verifyEventSignature,
  withInbox,
  withOutbox,
  type OutboxRow,
} from './outbox.ts'
import { db, enabled, migrateTestDb, openDb, resetForesight, seedDraft, skip } from './testsupport.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetForesight(sql)
})

/**
 * The registry's shape rule: `<service>.<aggregate>.<past-tense-verb>`, three lowercase segments.
 *
 * None of these is in `@cloudsforge/contracts-events` `TOPICS` yet — that registry is exact-pinned
 * and adding to it is a coordinated release. Satisfying the shape now means registering them later
 * is an ADDITION and never a rename, which is what stops a subscriber breaking.
 */
test('every topic satisfies the registry’s shape rule', () => {
  // Seven since the header image landed: `foresight.market.imaged` and `foresight.idea.imaged`.
  // The verb is `imaged` rather than `image_set` because the regex below admits no underscore, and
  // a name that could not be registered later would have to be renamed — which is the one change
  // that breaks a subscriber.
  assert.equal(TOPICS.length, 7)
  for (const topic of TOPICS) {
    assert.match(topic, /^[a-z]+\.[a-z]+\.[a-z]+$/, `${topic} is not <service>.<aggregate>.<verb>`)
    assert.ok(topic.startsWith('foresight.'), `${topic} does not name this service`)
  }
  assert.equal(new Set(TOPICS).size, TOPICS.length)
})

test('a rolled-back change publishes nothing', { skip }, async () => {
  const market = await seedDraft(sql)
  await assert.rejects(
    withOutbox(db(sql), 'foresight', async (tx, emit) => {
      await tx`update markets set question = 'changed' where id = ${market.id}`
      emit({ topic: MARKET_OPENED, key: market.id, payload: { id: market.id } })
      // The change and the event are in one transaction; this rolls both back.
      throw new Error('something went wrong after the emit')
    }),
    /something went wrong/,
  )
  assert.equal((await sql`select 1 from outbox`).length, 0, 'an event was published for a change that never happened')
  const rows = await sql<{ question: string }[]>`select question from markets where id = ${market.id}`
  assert.notEqual(rows[0]?.question, 'changed')
})

test('a committed change always has its event, in the same transaction', { skip }, async () => {
  const market = await seedDraft(sql)
  await withOutbox(db(sql), 'foresight', async (tx, emit) => {
    await tx`update markets set question = 'a new question' where id = ${market.id}`
    emit({
      topic: MARKET_OPENED,
      key: market.id,
      payload: { id: market.id },
      actor: 'operator:x',
      correlationId: 'req-1',
    })
  })
  const events = await sql<{ topic: string; key: string; actor: string; correlation_id: string; producer: string }[]>`
    select topic, key, actor, correlation_id, producer from outbox
  `
  assert.equal(events.length, 1)
  assert.equal(events[0]?.topic, MARKET_OPENED)
  assert.equal(events[0]?.key, market.id)
  assert.equal(events[0]?.actor, 'operator:x')
  assert.equal(events[0]?.producer, 'foresight')
})

test('the signature is over the exact bytes, and verification is timing-safe', () => {
  const body = JSON.stringify({ id: 'e1', topic: MARKET_OPENED })
  const signature = signEvent(body, 'a-secret')
  assert.match(signature, /^sha256=[0-9a-f]{64}$/)
  assert.equal(verifyEventSignature(body, 'a-secret', signature), true)
  assert.equal(verifyEventSignature(body, 'another-secret', signature), false)
  assert.equal(verifyEventSignature(`${body} `, 'a-secret', signature), false)
  // A length mismatch must not throw out of `timingSafeEqual` — a subscriber sending a truncated
  // header would otherwise take the relay down rather than being rejected.
  assert.equal(verifyEventSignature(body, 'a-secret', 'sha256=short'), false)
  assert.equal(verifyEventSignature(body, 'a-secret', ''), false)
})

test('the inbox runs a handler once and swallows the redelivery', { skip }, async () => {
  let runs = 0
  const handler = async () => {
    runs += 1
    return 'done'
  }
  const first = await withInbox(db(sql), 'some.topic', '00000000-0000-4000-8000-000000000010', handler)
  assert.equal(first.status, 'processed')
  const second = await withInbox(db(sql), 'some.topic', '00000000-0000-4000-8000-000000000010', handler)
  assert.equal(second.status, 'duplicate')
  assert.equal(runs, 1)
})

test('a handler that fails leaves no inbox row, so the redelivery is processed', { skip }, async () => {
  // The mistake that makes a naive "record then handle" dedupe LOSE events: the insert and the
  // handler share one transaction, so a failure rolls the claim back too.
  await assert.rejects(
    withInbox(db(sql), 'some.topic', '00000000-0000-4000-8000-000000000011', async () => {
      throw new Error('handler blew up')
    }),
    /handler blew up/,
  )
  assert.equal((await sql`select 1 from inbox`).length, 0)

  let runs = 0
  const outcome = await withInbox(db(sql), 'some.topic', '00000000-0000-4000-8000-000000000011', async () => {
    runs += 1
    return 'ok'
  })
  assert.equal(outcome.status, 'processed')
  assert.equal(runs, 1)
})

/* ------------------------------------------------------------------ what goes on the wire */

/**
 * A real stored row, read from the mainnet estate on 2026-08-11 — micro-org#366.
 *
 * `foresight.market.closed` is written by the close sweep, which has no request behind it and so
 * writes a NULL correlation id. That null is why this row is the fixture rather than a market
 * opened by an operator: it is the reason a version-only patch does not reach this service.
 */
const STORED_ROW: OutboxRow = {
  id: '729f1833-5898-464e-b9da-f4bb42719b97',
  topic: 'foresight.market.closed',
  key: 'f99f8280-02de-434c-8aa8-040d81234cb7',
  occurred_at: new Date('2026-08-06T00:00:56.794Z'),
  producer: 'foresight',
  version: 1,
  actor: 'service:foresight',
  correlation_id: null,
  payload: { id: 'f99f8280-02de-434c-8aa8-040d81234cb7', status: 'closed', network: 'mainnet' },
}

/**
 * **THE SIGNATURE WAS RIGHT AND THE ENVELOPE WAS NOT.**
 *
 * `@cloudsforge/contracts-events` types the wire version as "major.minor" — a STRING — and this
 * relay stamped the stored INTEGER. A delivery that verified was still discarded at the envelope
 * before any consumer read a payload. Eight relays did this at once and every suite in the estate
 * stayed green, because each one declared its OWN `EventEnvelope` and no compiler ever compared
 * the two.
 *
 * Measured with the contract's own `classifyEnvelope` against `STORED_ROW` on 2026-08-11:
 *
 *      as shipped -> malformed: version: missing, correlationId: missing
 *     fixed      -> well-formed; only the registration is outstanding
 *
 * The verdict is taken from the CONTRACT'S OWN classifier, never from a shape restated here. A
 * local copy of the rule agrees with a wrong implementation instead of catching it, which is the
 * mistake that produced the defect in the first place.
 *
 * MUTATIONS THIS KILLS — each one applied to `buildEnvelope` and each one confirmed red:
 *   - `version: row.version`, the stored integer, which is what shipped: `classifyEnvelope`
 *     answers `version: missing` and the defect assertion fails.
 *   - `version: String(row.version)` — a string, but "1" rather than "1.0": the shape assertion
 *     fails, so widening the fix to "any string" does not survive either.
 *   - `actor: row.actor` / `correlationId: row.correlation_id`, the nullable columns passed
 *     straight through, which is the other half of what the estate measured above.
 */
test('the envelope this relay puts on the wire is one the contract accepts', () => {
  const envelope = buildEnvelope(STORED_ROW)

  assert.equal(typeof envelope.version, 'string', 'an integer version is refused as "version: missing"')
  assert.match(envelope.version, /^\d+\.\d+$/, 'the contract types the wire version as "major.minor"')
  assert.equal(envelope.version, '1.0', 'major 1 as stored, minor 0 — storage records the major')
  // The nullable columns never reach the wire. `system` is the contract's own value for "no
  // principal did this"; the correlation id falls back to the event id so it is never absent.
  // This row has correlationId null in storage, which is two of the defects measured above.
  assert.equal(envelope.actor, 'service:foresight')
  assert.equal(envelope.correlationId, STORED_ROW.id)

  // ── AND FROM A ROW WITH THE NULLABLE COLUMNS EMPTY. The row above already has a null correlation id; a null ACTOR is the sweep one emit site
  // away, and `withOutbox` writes one whenever a caller omits it.
  const fromNulls = buildEnvelope({ ...STORED_ROW, actor: null, correlation_id: null })
  assert.equal(fromNulls.actor, 'system', 'the contract has no null actor; `system` is its word for one')
  assert.equal(fromNulls.correlationId, STORED_ROW.id, 'never absent — an absent one ends an investigation')
  assert.deepEqual(
    classifyEnvelope(fromNulls).defects,
    [],
    'a null column must not become a defect on the wire',
  )

  // The topic is not in the contract's registry yet, so the honest verdict is `unregistered_topic`
  // and NOT `valid` — a different fact with a different remedy. What matters here is `defects`:
  // once the registration lands, an EMPTY defect list is the difference between this event being
  // read and being discarded, and `version: missing` is what used to be in it.
  const verdict = classifyEnvelope(envelope)
  assert.equal(verdict.reason, 'unregistered_topic', `got: ${JSON.stringify(verdict)}`)
  assert.deepEqual(verdict.defects, [], 'well-formed: the ONLY thing outstanding is the registration')
})

/**
 * The teeth of the test above. Without this, every assertion there would still pass against a
 * classifier that accepted anything at all, and "the contract accepts it" would be a claim about
 * this file rather than about the estate.
 */
test('the shape this relay used to send is REFUSED by the same classifier', () => {
  const asShipped = { ...buildEnvelope(STORED_ROW), version: STORED_ROW.version as unknown as EventVersion }

  const verdict = classifyEnvelope(asShipped)
  assert.equal(verdict.ok, false, 'an integer version must be refused at the envelope')
  assert.equal(verdict.reason, 'malformed', 'refused as malformed, not merely shelved as unregistered')
  assert.ok(
    verdict.defects.some((d) => d.startsWith('version')),
    `refused FOR THE VERSION, not incidentally: ${JSON.stringify(verdict)}`,
  )
})
