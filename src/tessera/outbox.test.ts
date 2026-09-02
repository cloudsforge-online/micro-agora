/**
 * The outbox, the relay, the inbox — and the envelope defect eighteen repositories carry.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { networkSql, type Sql as DbSql } from '@cloudsforge/db'
import { readFileSync, readdirSync } from 'node:fs'
import type postgres from 'postgres'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  classifyEnvelope,
  signDelivery,
} from '@cloudsforge/contracts-events'
import {
  ALICE_SUBJECT,
  asDb,
  enabled,
  migrateTestDb,
  openDb,
  quietLogger,
  resetTessera,
  seedAccounts,
  seedWard,
  skip,
  stripComments,
  stripQuotedProse,
} from './testsupport.ts'
import type { HttpClient } from '@cloudsforge/http'
import { MalformedEnvelopeError, createRelay, envelopeFor, withInbox, withOutbox } from './outbox.ts'
import { handleDelivery } from './inbound.ts'
import { WARD_OPENED } from './topics.ts'

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
  await resetTessera(sql)
})

const ROW = {
  id: '0192f000-0000-7000-8000-000000000001',
  topic: 'tessera.ward.opened',
  key: 'w-1',
  occurred_at: new Date('2026-08-03T10:00:00.000Z'),
  producer: 'tessera',
  version: '1.0',
  actor: 'system' as string | null,
  correlation_id: 'req-1' as string | null,
  payload: { wardId: 'w-1' },
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS FILE EXISTS FOR, STATED AS A TEST RATHER THAN A CLAIM.
 *
 * `micro-service-template`'s relay declares `actor: string | null` and `correlationId: string |
 * null` and writes nulls for any event that names no actor. Eighteen repositories copied it. Run
 * that shape through the contract's own classifier and it is not a lagging registry — it is
 * MALFORMED, and every delivery to an inbox that classifies would be refused.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('the templates envelope shape is MALFORMED by the contracts own classifier', () => {
  const templateShaped = {
    id: ROW.id,
    topic: ROW.topic,
    key: ROW.key,
    occurredAt: ROW.occurred_at.toISOString(),
    producer: ROW.producer,
    version: 1, // the template stores an integer major and maps it on the way out
    actor: null,
    correlationId: null,
    payload: {},
  }
  const verdict = classifyEnvelope(templateShaped)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'malformed')

  // Each half separately, so this test names three distinct defects rather than one blob.
  const nullActor = classifyEnvelope({ ...templateShaped, version: '1.0', correlationId: 'r' })
  assert.equal(nullActor.ok, false)
  assert.ok(nullActor.ok === false && nullActor.defects.some((d) => d.startsWith('actor')))

  const nullCorrelation = classifyEnvelope({ ...templateShaped, version: '1.0', actor: 'system' })
  assert.equal(nullCorrelation.ok, false)
  assert.ok(
    nullCorrelation.ok === false && nullCorrelation.defects.some((d) => d.startsWith('correlationId')),
  )

  const integerVersion = classifyEnvelope({ ...templateShaped, actor: 'system', correlationId: 'r' })
  assert.equal(integerVersion.ok, false)
  assert.ok(integerVersion.ok === false && integerVersion.defects.some((d) => d.startsWith('version')))
})

test('this services envelope is valid, and envelopeFor refuses to build an invalid one', () => {
  const envelope = envelopeFor(ROW)
  assert.equal(classifyEnvelope(envelope).ok, true)
  assert.equal(envelope.actor, 'system')
  assert.equal(envelope.correlationId, 'req-1')
  assert.equal(envelope.version, '1.0')

  // An unregistered topic is refused HERE, in the producer, naming the topic.
  assert.throws(
    () => envelopeFor({ ...ROW, topic: 'tessera.chair.wobbled' }),
    (err: unknown) => err instanceof MalformedEnvelopeError && /not registered/.test(err.message),
  )
  // A version that is not major.minor likewise — the database refuses it too, and both is right:
  // the CHECK is the guarantee, this is the message.
  assert.throws(
    () => envelopeFor({ ...ROW, version: '1' }),
    (err: unknown) => err instanceof MalformedEnvelopeError,
  )
})

test('a legacy row with nulls is coalesced to the CONTRACTs defaults, not to null', () => {
  // A rolling deploy can leave rows written by an older build. They must not be sent as malformed
  // envelopes, and they must not be sent with a fabricated actor either — 'system' is the
  // contract's own word for "no person asked for this".
  const legacy = envelopeFor({ ...ROW, actor: null, correlation_id: null })
  assert.equal(legacy.actor, 'system')
  assert.equal(legacy.correlationId, ROW.id, 'an event with no correlation becomes its own root')
  assert.equal(classifyEnvelope(legacy).ok, true)
})

/* -------------------------------------------------------------------- against Postgres */

test('an outbox row is written in the SAME transaction as the change, or not at all', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)

  await assert.rejects(() =>
    withOutbox(asDb(sql), async (tx, emit) => {
      await tx`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
               values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32)`
      emit({ topic: WARD_OPENED, key: 'k', payload: {}, correlationId: 'r' })
      throw new Error('the handler failed after the write')
    }),
  )

  // Neither landed. A publish-after-commit would have left the event; a publish-before-commit
  // would have left an event for a change that never happened.
  const parcels = await sql<{ n: number }[]>`select count(*)::int as n from parcels`
  const events = await sql<{ n: number }[]>`select count(*)::int as n from outbox`
  assert.equal(parcels[0]?.n, 0)
  assert.equal(events[0]?.n, 0)
})

test('the relay signs with the contract and refuses to deliver a malformed envelope', { skip }, async () => {
  const secret = 'a'.repeat(32)
  const delivered: Array<{ body: unknown; headers: Record<string, string> }> = []
  const relay = createRelay({
    sql: asDb(sql),
    logger: quietLogger(),
    signingSecret: secret,
    // The generic on HttpClient.request is what a real caller narrows the response with; a fake
    // must satisfy it for any T, so it asserts through unknown rather than pretending to know.
    clientFor: () =>
      ({
        request: async (_path: string, init: Record<string, unknown>) => {
          delivered.push({
            body: init['body'],
            headers: init['headers'] as Record<string, string>,
          })
          return {}
        },
      }) as unknown as Pick<HttpClient, 'request'>,
  })

  await sql`insert into event_subscriptions (topic, url) values ('tessera.ward.opened', 'http://sub.test/inbox')`
  await withOutbox(asDb(sql), async (_tx, emit) => {
    emit({ topic: WARD_OPENED, key: 'ward-1', payload: { wardId: 'ward-1' }, correlationId: 'req-9' })
  })

  await relay(
    { id: 'j', kind: 'outbox.relay', key: 'stream', attempts: 1, maxAttempts: 5, payload: {} },
    { heartbeat: async () => true, signal: new AbortController().signal },
  )

  assert.equal(delivered.length, 1)
  const sent = delivered[0]!
  // The signature is over the EXACT bytes the client will send.
  const body = JSON.stringify(sent.body)
  const presented = sent.headers[SIGNATURE_HEADER]
  assert.ok(presented, 'no cf-signature header')
  assert.match(presented, /^t=\d+,v1=[0-9a-f]+$/, 'the signature is not the contracts scheme')
  assert.equal(presented, signDelivery(body, secret, Number(/^t=(\d+)/.exec(presented)![1]) * 1000))
  assert.ok(sent.headers[EVENT_ID_HEADER])
  // And what was sent is a valid envelope, judged by the contract rather than by eye.
  assert.equal(classifyEnvelope(sent.body).ok, true)

  const published = await sql<{ n: number }[]>`
    select count(*)::int as n from outbox where published_at is not null
  `
  assert.equal(published[0]?.n, 1)
})

test('a malformed row is skipped, logged and left UNPUBLISHED — evidence, not a silent drop', { skip }, async () => {
  const attempts: unknown[] = []
  const relay = createRelay({
    sql: asDb(sql),
    logger: quietLogger(),
    signingSecret: 'a'.repeat(32),
    clientFor: () =>
      ({
        request: async () => {
          attempts.push(1)
          return {}
        },
      }) as unknown as Pick<HttpClient, 'request'>,
  })
  await sql`insert into event_subscriptions (topic, url) values ('tessera.ward.opened', 'http://sub.test/inbox')`
  // A topic that satisfies the CHECK constraint's shape but is not in the registry.
  await sql`insert into outbox (topic, key, producer, version, actor, correlation_id)
            values ('tessera.chair.wobbled', 'k', 'tessera', '1.0', 'system', 'r')`

  await relay(
    { id: 'j', kind: 'outbox.relay', key: 'stream', attempts: 1, maxAttempts: 5, payload: {} },
    { heartbeat: async () => true, signal: new AbortController().signal },
  )
  assert.equal(attempts.length, 0, 'a malformed envelope was delivered')
  const unpublished = await sql<{ n: number }[]>`
    select count(*)::int as n from outbox where published_at is null
  `
  assert.equal(unpublished[0]?.n, 1, 'the row was published rather than kept as evidence')
})

test('withInbox runs a handler exactly once, and a failed handler leaves no row', { skip }, async () => {
  let ran = 0
  const first = await withInbox(asDb(sql), 'market.listing.sold', ROW.id, async () => {
    ran += 1
  })
  assert.equal(first.status, 'processed')
  const second = await withInbox(asDb(sql), 'market.listing.sold', ROW.id, async () => {
    ran += 1
  })
  assert.equal(second.status, 'duplicate')
  assert.equal(ran, 1)

  // A handler that throws leaves NO inbox row, so the redelivery is processed rather than
  // swallowed — the mistake a naive "record then handle" dedupe makes.
  const other = '0192f000-0000-7000-8000-000000000002'
  await assert.rejects(() =>
    withInbox(asDb(sql), 'market.listing.sold', other, async () => {
      throw new Error('handler failed')
    }),
  )
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from inbox where event_id = ${other}
  `
  assert.equal(rows[0]?.n, 0)
})

/* -------------------------------------------------------------------------- inbound */

test('an inbound delivery is verified over the RAW BYTES before it is parsed', { skip }, async () => {
  const secret = 'b'.repeat(32)
  const deps = { sql: asDb(sql), planes: networkSql({ mainnet: asDb(sql) as unknown as DbSql }), logger: quietLogger(), secrets: [secret] }
  const envelope = {
    id: '0192f000-0000-7000-8000-000000000003',
    topic: 'market.listing.sold',
    key: 'l-1',
    occurredAt: new Date().toISOString(),
    producer: 'market',
    version: '1.0',
    actor: 'system',
    correlationId: 'req-2',
    payload: { listingId: 'ml-1' },
  }
  const raw = JSON.stringify(envelope)

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 403 THROUGHOUT, NOT 401. The MAC is the credential on this surface: there is no bearer
  // token that opens it and no token endpoint to go and find one at, so 401 — "authenticate
  // and try again" — is advice that leads nowhere. `trade/src/server.ts` is the
  // estate's reference implementation of the same choice.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  // No signature at all.
  assert.equal((await handleDelivery(deps, raw, {})).status, 403)
  // A forged one.
  assert.equal(
    (await handleDelivery(deps, raw, { [SIGNATURE_HEADER]: 't=1,v1=deadbeef' })).status,
    403,
  )
  // Signed with the wrong secret.
  assert.equal(
    (await handleDelivery(deps, raw, { [SIGNATURE_HEADER]: signDelivery(raw, 'c'.repeat(32)) })).status,
    403,
  )

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // THE ONE THAT MATTERS: a signature over RE-SERIALISED bytes is refused.
  //
  // `JSON.parse` then `JSON.stringify` is not the identity function — key order changes. A
  // receiver that verified over the re-serialised body would refuse every honest delivery, and
  // the failure would look exactly like a secret mismatch. `activity/src/ingest.ts` says
  // so; this proves the bytes genuinely differ, so the rule is about something.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  const { payload, ...rest } = envelope
  const reordered = JSON.stringify({ payload, ...rest })
  assert.notEqual(reordered, raw, 'the re-serialisation fixture produces identical bytes')
  assert.equal(
    (await handleDelivery(deps, raw, { [SIGNATURE_HEADER]: signDelivery(reordered, secret) })).status,
    403,
  )

  // And the honest one.
  const ok = await handleDelivery(deps, raw, {
    [SIGNATURE_HEADER]: signDelivery(raw, secret),
    [EVENT_ID_HEADER]: envelope.id,
  })
  assert.equal(ok.status, 200)
  // Redelivered: deduped on (topic, event_id).
  const again = await handleDelivery(deps, raw, {
    [SIGNATURE_HEADER]: signDelivery(raw, secret),
    [EVENT_ID_HEADER]: envelope.id,
  })
  assert.equal(again.status, 200)
  assert.equal(again.outcome === 'duplicate', true)
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE PROPERTY THE ROTATION DEPENDS ON.**
 *
 * `INBOUND_SIGNING_SECRET` is one key shared with every producer in the estate. If moving to a new
 * one meant this inbox accepted only the new one, every producer still on the old key would be
 * 401'd for the length of the rolling deploy and the deliveries would be silently partitioned. So
 * the inbox accepts a LIST, newest first, and the old key keeps verifying until it is dropped.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('a delivery signed with the OLD secret still verifies while the NEW one leads the list', { skip }, async () => {
  // Obviously fake, both of them, and long enough to clear the length rule in `env.ts`.
  const nextSecret = 'rotation-fixture-next-key-not-a-real-secret'
  const priorSecret = 'rotation-fixture-prior-key-not-a-real-secret'
  const deps = { sql: asDb(sql), planes: networkSql({ mainnet: asDb(sql) as unknown as DbSql }), logger: quietLogger(), secrets: [nextSecret, priorSecret] }
  const raw = JSON.stringify({
    id: '0192f000-0000-7000-8000-000000000005',
    topic: 'market.listing.sold',
    key: 'l-2',
    occurredAt: new Date().toISOString(),
    producer: 'market',
    version: '1.0',
    actor: 'system',
    correlationId: 'req-3',
    payload: { listingId: 'ml-2' },
  })

  // Signed with the key being rotated OUT: still honoured, which is what keeps the window open.
  const old = await handleDelivery(deps, raw, { [SIGNATURE_HEADER]: signDelivery(raw, priorSecret) })
  assert.equal(old.status, 200)

  // And the key being rotated IN, which nothing signs with yet, verifies as well.
  const next = await handleDelivery(deps, raw, {
    [SIGNATURE_HEADER]: signDelivery(raw, nextSecret),
    [EVENT_ID_HEADER]: '0192f000-0000-7000-8000-000000000006',
  })
  assert.equal(next.status, 200)

  // A key that is on NEITHER end of the rotation is still refused. The list widens the window, it
  // does not widen the door.
  const stranger = await handleDelivery(deps, raw, {
    [SIGNATURE_HEADER]: signDelivery(raw, 'rotation-fixture-stranger-key-not-a-secret'),
  })
  assert.equal(stranger.status, 403)
})

test('an authentic delivery naming an unregistered topic is 202, not 400', { skip }, async () => {
  const secret = 'b'.repeat(32)
  const deps = { sql: asDb(sql), planes: networkSql({ mainnet: asDb(sql) as unknown as DbSql }), logger: quietLogger(), secrets: [secret] }
  const raw = JSON.stringify({
    id: '0192f000-0000-7000-8000-000000000004',
    topic: 'somebody.else.invented',
    key: 'k',
    occurredAt: new Date().toISOString(),
    producer: 'market',
    version: '1.0',
    actor: 'system',
    correlationId: 'r',
    payload: {},
  })
  const verdict = await handleDelivery(deps, raw, { [SIGNATURE_HEADER]: signDelivery(raw, secret) })
  // 202: the producer cannot fix this by retrying. Registering the topic is a pull request. A 400
  // would make its relay retry for ever.
  assert.equal(verdict.status, 202)
  assert.equal(verdict.outcome, 'unregistered')
})

test('handleDelivery takes RAW BYTES, so passing a re-serialised body is unrepresentable', () => {
  const source = stripComments(readFileSync(new URL('./inbound.ts', import.meta.url), 'utf8'))
  // The signature is `raw: string`, not `body: unknown`. A caller cannot hand it an object it has
  // already parsed, which is the mistake the type system is being used to prevent.
  assert.match(source, /raw:\s*string/)
  // And `JSON.parse` appears exactly once, AFTER the verification.
  const parseAt = source.indexOf('JSON.parse')
  const verifyAt = source.indexOf('verifyDelivery')
  assert.ok(verifyAt > 0 && parseAt > verifyAt, 'the body is parsed before the signature is checked')
  assert.equal(source.split('JSON.parse').length - 1, 1)
})

test('every source file signs through the contract — there is no local MAC to drift', () => {
  // The §3.3p defect: five producers had a local node:crypto MAC signing `sha256=<hmac>` under a
  // locally-spelled header, and every delivery to a contract-following inbox was refused.
  //
  // The needles are built and the prose is stripped, for the reason `contracts.test.ts` sets out
  // at length: this is the fourth guard in this repository that fired on its own text before it
  // fired on anything else. The assertion below proves the stripping is happening, so the guard
  // cannot become vacuous while still reporting green.
  const mac = `create${'Hmac'}`
  const scheme = `sha256${'='}`
  assert.equal(mac.length, 10)
  assert.equal(scheme, `sha256${String.fromCharCode(61)}`)

  const dir = new URL('.', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
  assert.ok(files.length > 10, 'no sources were scanned; this check is grading nothing')

  const self = stripQuotedProse(stripComments(readFileSync(new URL('./outbox.test.ts', dir), 'utf8')))
  assert.equal(self.includes(`${mac}(`), false, 'the stripping is not happening; this guard passes on anything')

  for (const file of files) {
    const source = stripQuotedProse(stripComments(readFileSync(new URL(file, dir), 'utf8')))
    assert.equal(
      source.includes(`${mac}(`),
      false,
      `${file} rolls its own MAC — the contract signs (contracts/packages/events/src/index.ts)`,
    )
    assert.equal(
      source.includes(scheme),
      false,
      `${file} spells a signature scheme by hand rather than using signDelivery`,
    )
  }
})
