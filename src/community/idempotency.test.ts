/**
 * At most once per key — and the regression that gave the estate its shape.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A FRESH CORRELATION ID MUST REPLAY, AND A GENUINELY DIFFERENT BODY MUST 409.**
 *
 * The ledger fingerprinted the whole request body, `correlationId` included — and a
 * `correlationId` is SUPPOSED to change on every attempt, because that is what makes a retry
 * distinguishable from the original in a trace. So a caller doing exactly the right thing was told
 * its idempotency key had been reused with a different payload, and could not tell that apart from
 * a genuine collision. `micro-wallet` had to carry a correlation id that was stable per operation
 * rather than per attempt in order to work around it.
 *
 * Pinned here in both directions. One without the other is worthless: a fingerprint of nothing
 * replays every request, and a fingerprint of everything 409s every honest retry.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  IdempotencyInFlightError,
  IdempotencyKeyReuseError,
  namespacedKey,
  reapIdempotencyKeys,
  requestFingerprint,
  withIdempotency,
} from './idempotency.ts'
import { asDb, migrateTestDb, openDb, resetCommunity, skip } from './testsupport.ts'

let sql: postgres.Sql

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

/* ------------------------------------------------------------------ the fingerprint */

test('a fresh correlation id replays rather than 409ing', () => {
  const first = requestFingerprint({ choice: 'for', correlationId: 'attempt-1' })
  const second = requestFingerprint({ choice: 'for', correlationId: 'attempt-2' })
  assert.equal(first, second, 'an honest retry with a fresh trace id would have been refused')
})

test('a genuinely different body still 409s', () => {
  // The other direction, and the one that makes the test above safe. A fingerprint that ignored
  // everything would pass the first test and let a caller replay a different vote entirely.
  assert.notEqual(
    requestFingerprint({ choice: 'for' }),
    requestFingerprint({ choice: 'against' }),
  )
  assert.notEqual(
    requestFingerprint({ spend: { amount: '100' } }),
    requestFingerprint({ spend: { amount: '1000' } }),
  )
})

test('field order does not change the fingerprint', () => {
  // `JSON.stringify` preserves insertion order, so two semantically identical bodies that
  // serialised their fields differently would fingerprint differently and a legitimate retry would
  // be rejected as reuse — a false 409 that is maddening to diagnose from the caller's side.
  assert.equal(
    requestFingerprint({ a: 1, b: { c: 2, d: 3 } }),
    requestFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
  )
})

test('a bigint and its decimal string fingerprint identically', () => {
  // An amount must never reach `JSON.stringify` as a number: at 2^53 it stops being exact and comes
  // back subtly wrong rather than failing. A caller sending "1000" and one sending the parsed
  // amount are making the same request.
  assert.equal(requestFingerprint({ amount: 1000n }), requestFingerprint({ amount: '1000' }))
  const huge = 2n ** 90n
  assert.equal(requestFingerprint({ amount: huge }), requestFingerprint({ amount: huge.toString() }))
})

test('every per-attempt field is excluded, and nothing else is', () => {
  const baseline = requestFingerprint({ choice: 'for' })
  for (const field of ['correlationId', 'idempotencyKey', 'requestId']) {
    assert.equal(requestFingerprint({ choice: 'for', [field]: 'x' }), baseline, `${field} is fingerprinted`)
  }
  // A field that is not per-attempt must still count.
  assert.notEqual(requestFingerprint({ choice: 'for', proposalId: 'p1' }), baseline)
})

/* ------------------------------------------------------------------ the namespace */

test('the key is namespaced by the principal, not by the service', () => {
  // Two members of one community independently choosing `vote-1` must not collide. Namespaced by
  // service alone, the second would be answered with the first's response — which on the vote route
  // means being told your vote was recorded when what was recorded was somebody else's.
  assert.notEqual(
    namespacedKey('user:alice', '/v1/proposals/:id/votes', 'vote-1'),
    namespacedKey('user:bob', '/v1/proposals/:id/votes', 'vote-1'),
  )
  // And the route is in it, because the same client key on two routes describes two operations.
  assert.notEqual(
    namespacedKey('user:alice', '/v1/communities', 'k'),
    namespacedKey('user:alice', '/v1/proposals/:id/votes', 'k'),
  )
})

/* ------------------------------------------------------------------ against Postgres */

async function run(key: string, body: Record<string, unknown>, work: () => Promise<string>) {
  return withIdempotency<{ id: string }>(asDb(sql), {
    principal: 'user:alice',
    route: '/v1/proposals/:id/votes',
    clientKey: key,
    requestHash: requestFingerprint(body),
    run: async () => {
      const id = await work()
      return { response: { id }, artefactId: id }
    },
  })
}

test('an idempotent retry replays the stored response and does no work', { skip }, async () => {
  let ran = 0
  const first = await run('k1', { choice: 'for' }, async () => {
    ran += 1
    return 'artefact-1'
  })
  assert.equal(first.replayed, false)
  assert.equal(first.result.id, 'artefact-1')

  const second = await run('k1', { choice: 'for', correlationId: 'a-fresh-trace-id' }, async () => {
    ran += 1
    return 'artefact-2'
  })
  assert.equal(second.replayed, true)
  assert.equal(second.result.id, 'artefact-1', 'the retry did the work again')
  assert.equal(ran, 1)
})

test('the same key with a different body is refused, never replayed', { skip }, async () => {
  await run('k2', { choice: 'for' }, async () => 'a1')
  // Returning the first request's answer to a second, different request is worse than an error: the
  // caller believes the thing it asked for happened.
  await assert.rejects(
    () => run('k2', { choice: 'against' }, async () => 'a2'),
    IdempotencyKeyReuseError,
  )
})

test('a concurrent duplicate blocks and then replays, rather than racing', { skip }, async () => {
  // TWO CONNECTIONS. The second INSERT waits on the first transaction's uncommitted row; when that
  // commits, the duplicate reads the stored response and replays it. A double-clicked button can
  // therefore never produce two artefacts.
  const a = openDb(2)
  const b = openDb(2)
  try {
    let ran = 0
    const attempt = (client: postgres.Sql) =>
      withIdempotency<{ id: string }>(asDb(client), {
        principal: 'user:alice',
        route: '/v1/communities/:id/proposals',
        clientKey: 'concurrent',
        requestHash: requestFingerprint({ title: 'T' }),
        run: async () => {
          ran += 1
          await new Promise((resolve) => setTimeout(resolve, 100))
          return { response: { id: `artefact-${ran}` }, artefactId: `artefact-${ran}` }
        },
      })

    const results = await Promise.allSettled([attempt(a), attempt(b)])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    // Either both succeed (one fresh, one replayed) or the loser reports in-flight and retries.
    // Both are correct; what must never happen is two runs of the work.
    assert.equal(ran, 1, `the work ran ${ran} times`)
    for (const result of results) {
      if (result.status === 'rejected') {
        assert.ok(result.reason instanceof IdempotencyInFlightError, String(result.reason))
      }
    }
    assert.ok(fulfilled.length >= 1)

    const rows = await sql<{ n: number }[]>`select count(*)::int as n from idempotency_keys`
    assert.equal(rows[0]?.n, 1)
  } finally {
    await a.end({ timeout: 5 })
    await b.end({ timeout: 5 })
  }
})

test('a rolled-back claim leaves no key, so the retry does the work', { skip }, async () => {
  // The property a "claim then work" design loses: if the original transaction rolled back between
  // the insert and the read, nothing committed, so the honest answer is "retry" rather than a guess.
  await assert.rejects(
    () =>
      run('k3', { choice: 'for' }, async () => {
        throw new Error('the work failed')
      }),
    /the work failed/,
  )
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from idempotency_keys where key like '%k3'`
  assert.equal(rows[0]?.n, 0)

  // And the retry runs.
  const retry = await run('k3', { choice: 'for' }, async () => 'a1')
  assert.equal(retry.replayed, false)
})

test('the claim row points at the artefact it produced', { skip }, async () => {
  await run('k4', { choice: 'for' }, async () => 'artefact-99')
  const rows = await sql<{ artefact_id: string | null; route: string }[]>`
    select artefact_id, route from idempotency_keys where key like '%k4'
  `
  // The only link between a caller's key and what it made, and losing it turns "did my retry spend
  // the treasury twice" into an unanswerable question.
  assert.equal(rows[0]?.artefact_id, 'artefact-99')
  assert.equal(rows[0]?.route, '/v1/proposals/:id/votes')
})

/* ------------------------------------------------------------------ the reaper */

test('the reaper keeps any key that produced an artefact, whatever its age', { skip }, async () => {
  await run('old-with-artefact', { choice: 'for' }, async () => 'a1')
  await sql`
    insert into idempotency_keys (key, route, request_hash, response, created_at)
    values ('old-no-artefact', '/v1/x', 'h', '{}'::jsonb, now() - interval '400 days')
  `
  await sql`update idempotency_keys set created_at = now() - interval '400 days'`

  const reaped = await reapIdempotencyKeys(asDb(sql), 30)
  assert.equal(reaped, 1, 'the reaper took the wrong number of rows')

  const rows = await sql<{ key: string }[]>`select key from idempotency_keys`
  assert.equal(rows.length, 1)
  assert.match(rows[0]?.key ?? '', /old-with-artefact/)
})

test('the reaper leaves keys inside the TTL alone', { skip }, async () => {
  await sql`
    insert into idempotency_keys (key, route, request_hash, response)
    values ('recent', '/v1/x', 'h', '{}'::jsonb)
  `
  assert.equal(await reapIdempotencyKeys(asDb(sql), 30), 0)
})
