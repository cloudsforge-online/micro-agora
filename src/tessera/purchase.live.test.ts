/**
 * A PURCHASE, DRIVEN OVER A REAL SOCKET AGAINST A REAL POSTGRES.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS SEPARATELY FROM `titlecontract.test.ts`.
 *
 * `titlecontract.test.ts` calls `provision()` and catches what it throws. That is the wrong
 * altitude for the defect this file is about, because the defect was never in what `provision`
 * threw — it was in what the CUSTOMER GOT. A `PostgresError` escaping `provision` matches none of
 * `server.ts`'s error branches and is answered:
 *
 *     500 {"error":{"code":"internal","message":"the request could not be completed"}}
 *
 * to somebody in the middle of buying a Private Ward. A test that asserts `rejects` is green for
 * a 409 and green for a 500, which is exactly the distinction that mattered. So this file speaks
 * HTTP, reads the status line, and would have been red.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE ENTITLEMENT IDS ARE THE ESTATE'S OWN, NOT SYNTHETIC ─────────────────────────────────
 *
 * `worlds/src/conformance.ts`:
 *
 *     const entitlementId = options.entitlementId ?? `conformance-${crypto.randomUUID()}`
 *
 * The slug rule this file replaced was `entitlementId.replace(/[^a-z0-9]/g, '').slice(0, 12)`.
 * Applied to that id: the hyphen is stripped, `conformance` is ELEVEN characters, and the twelfth
 * is the first hex digit of the UUID. **Sixteen slugs, for every conformance run this estate will
 * ever do.** The second run had a fifteen-in-sixteen chance of colliding with the first, and
 * `worlds`' own conformance check would therefore have started 500ing against this title almost
 * immediately — on a route whose whole purpose is to prove the title works.
 *
 * The two ids below are generated the way worlds generates them and then selected for a shared
 * first hex digit, which is not a contrivance: it is the one-in-sixteen that was going to happen.
 */

import { singleNetworkSql } from './testsupport.ts'
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import type { Principal } from '@cloudsforge/auth'
import { Lifecycle } from '@cloudsforge/lifecycle'
import {
  ALICE,
  ALICE_SUBJECT,
  asDb,
  enabled,
  migrateTestDb,
  openDb,
  quietLogger,
  resetTessera,
  skip,
  TEST_EVENT_SECRET,
  testMetrics,
} from './testsupport.ts'
import { createServer } from './server.ts'
import { TESSERA_PROVISION_SCOPE } from './scopes.ts'
import { wardSlugFrom } from './titlecontract.ts'

let sql: postgres.Sql
let server: Server
let origin: string
let lifecycle: Lifecycle

/** `micro-worlds`' own principal: a service token holding exactly `tessera:provision`. */
const WORLDS: Principal = { kind: 'service', service: 'worlds', scopes: [TESSERA_PROVISION_SCOPE] }

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
  lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 })
  server = createServer({
    lifecycle,
    logger: quietLogger(),
    metrics: testMetrics(),
    // The token is stubbed and NOTHING ELSE IS. The database, the routing, the body parsing, the
    // error mapping and the status line are all the real ones — and the error mapping is the
    // thing on trial, so it is the one part that could not have been faked.
    verifier: { principal: async () => WORLDS },
    sql: singleNetworkSql(asDb(sql)),
    singleNetwork: 'mainnet' as const,
    eventAcceptSecrets: [TEST_EVENT_SECRET],
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  origin = `http://127.0.0.1:${address.port}`
  lifecycle.markReady()
})

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetTessera(sql)
})

interface Answer {
  readonly status: number
  readonly body: Record<string, unknown>
}

async function buy(entitlementId: string, over: Record<string, unknown> = {}): Promise<Answer> {
  const response = await fetch(`${origin}/v1/provision`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer worlds-service-token',
      'content-type': 'application/json',
      // The entitlement id travels as the Idempotency-Key header AND as a body field, the way
      // worlds sends it (`worlds/src/titleclient.ts`). Sent both ways here for the same reason.
      'idempotency-key': entitlementId,
    },
    body: JSON.stringify({
      entitlementId,
      subject: ALICE_SUBJECT,
      userId: ALICE,
      sku: 'world.private.small',
      scope: 'title:tessera',
      metadata: {},
      ...over,
    }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** Two ids exactly as `worlds/src/conformance.ts` mints them, sharing a first hex digit. */
function twoConformanceIds(): readonly [string, string] {
  const first = randomUUID()
  let second = randomUUID()
  while (second[0] !== first[0]) second = randomUUID()
  return [`conformance-${first}`, `conformance-${second}`]
}

/* ═══════════════════════════════════════════════════════ the 500 on a purchase, closed ══ */

test('two conformance entitlements both buy a ward — neither customer sees a 500', { skip }, async () => {
  const [a, b] = twoConformanceIds()

  // The rule this replaced mapped BOTH of these to `private-conformance` + one hex digit, i.e. to
  // the same slug. Asserted here so the fixture is provably the colliding pair rather than
  // hopefully one.
  assert.equal(
    a.replace(/[^a-z0-9]/g, '').slice(0, 12),
    b.replace(/[^a-z0-9]/g, '').slice(0, 12),
    'the fixture is not the colliding pair the old rule produced',
  )
  // NOTE: the derivation is deliberately NOT asserted here, and that is a calibration finding
  // rather than an omission. The first version of this test asserted
  // `wardSlugFrom(a) !== wardSlugFrom(b)` before buying anything — and when the old truncation was
  // put back to check the test could go red, THAT is the line that failed, so the run never
  // reached a purchase and never observed a status code. A test that reddens one assertion early
  // proves the input is colliding and says nothing about what the customer gets. The claim about
  // the derivation belongs in `titlecontract.test.ts`, where it is; the claim this file exists for
  // is the status line, so nothing is allowed to fail before one is read.

  const first = await buy(a)
  assert.equal(first.status, 201, JSON.stringify(first.body))

  const second = await buy(b)
  // THE ASSERTION THAT WAS RED. Named, so a future failure says what it was rather than "expected
  // 201, got 500".
  assert.notEqual(
    second.status,
    500,
    `a paying customer got a 500 buying a Private Ward: ${JSON.stringify(second.body)}`,
  )
  assert.equal(second.status, 201, JSON.stringify(second.body))

  // Two purchases, two wards, two urns. A "fix" that answered 200-replayed to the second customer
  // would pass the status assertions above and hand two people one world.
  assert.notEqual(second.body['urn'], first.body['urn'])
  const wards = await sql<{ n: number }[]>`select count(*)::int as n from wards`
  assert.equal(wards[0]?.n, 2)
})

test('a replayed purchase is 200 with the SAME urn, over HTTP and not just in the function', { skip }, async () => {
  const id = `conformance-${randomUUID()}`
  const first = await buy(id)
  assert.equal(first.status, 201)
  const again = await buy(id)
  assert.equal(again.status, 200)
  assert.equal(again.body['urn'], first.body['urn'])
  assert.equal(again.body['replayed'], true)
  const wards = await sql<{ n: number }[]>`select count(*)::int as n from wards`
  assert.equal(wards[0]?.n, 1, 'a replay raised a second ward')
})

/* ══════════════════════════════════════ the constraint kept, and answered honestly ══ */

test('a ward standing on the slug under ANOTHER entitlement is 409 — never adopted, never 500', { skip }, async () => {
  const mine = `conformance-${randomUUID()}`
  const theirs = `conformance-${randomUUID()}`

  // Somebody else's ward, on MY slug, with a provision row proving it is theirs. Constructed by
  // hand because a digest collision cannot be produced any other way — and the point is precisely
  // what happens if one ever is.
  const slug = wardSlugFrom({ entitlementId: mine } as never)
  const ward = await sql<{ id: string }[]>`
    insert into wards (slug, name, archetype, ordinal, claimable_tiles)
    values (${slug}, 'Theirs', 'ashfield', 0, 49152) returning id
  `
  await sql`insert into accounts (subject) values (${ALICE_SUBJECT}) on conflict do nothing`
  await sql`
    insert into provisions (entitlement_id, subject, user_id, sku, scope, urn, ward_id)
    values (${theirs}, ${ALICE_SUBJECT}, ${ALICE}, 'world.private.small', 'title:tessera',
            ${`cf:tessera:ward:${ward[0]!.id}`}, ${ward[0]!.id})
  `

  const answer = await buy(mine)
  assert.notEqual(answer.status, 500, `a unique violation escaped as a 500: ${JSON.stringify(answer.body)}`)
  assert.equal(answer.status, 409)
  assert.equal((answer.body['error'] as Record<string, unknown>)['code'], 'ward_slug_taken')

  // And it did NOT hand the caller the other entitlement's ward, which is the failure a naive
  // "a collision means a replay, return the existing one" fix would have shipped silently.
  assert.equal(answer.body['urn'], undefined)
  const provisions = await sql<{ n: number }[]>`
    select count(*)::int as n from provisions where entitlement_id = ${mine}
  `
  assert.equal(provisions[0]?.n, 0, 'the caller was provisioned onto somebody else s ward')

  // The constraint is still there. It is what surfaced this, and widening it was never the fix.
  await assert.rejects(
    () => sql`insert into wards (slug, name, archetype, ordinal, claimable_tiles)
              values (${slug}, 'x', 'ashfield', 99, 49152)`,
    (err: unknown) => String(err).includes('wards_slug_key'),
    'wards_slug_key was widened or dropped — the thing that reported this defect is gone',
  )
})

test('a ward on the slug with NO provision is adopted, so a half-done attempt is not wedged', { skip }, async () => {
  // The state a crash between the two inserts leaves. `on conflict (slug) do nothing` is what
  // makes it recoverable; a plain insert made it permanent.
  const id = `conformance-${randomUUID()}`
  await sql`
    insert into wards (slug, name, archetype, ordinal, claimable_tiles)
    values (${wardSlugFrom({ entitlementId: id } as never)}, 'Half', 'ashfield', 0, 49152)
  `
  const answer = await buy(id)
  assert.equal(answer.status, 201, JSON.stringify(answer.body))
  const wards = await sql<{ n: number }[]>`select count(*)::int as n from wards`
  assert.equal(wards[0]?.n, 1, 'the abandoned ward was left behind and a second one minted')
})

/* ═══════════════════════════════════════════════ the OTHER unique violation on this path ══ */

/**
 * `ordinal` is `coalesce(max(ordinal) + 1, 0)`: a read, not an allocation.
 *
 * Two customers buying at the same instant both read N. `wards_ordinal_key` refuses the second,
 * and before this change that was the second way a purchase produced a 500 — reachable without
 * any slug collision at all, and MORE reachable than the slug one now is.
 */
test('two different entitlements bought concurrently: two wards, and no 500 from the ordinal', { skip }, async () => {
  const ids = Array.from({ length: 6 }, () => `conformance-${randomUUID()}`)
  const answers = await Promise.all(ids.map((id) => buy(id)))

  for (const answer of answers) {
    assert.notEqual(
      answer.status,
      500,
      `a concurrent purchase answered 500: ${JSON.stringify(answer.body)}`,
    )
    assert.equal(answer.status, 201, JSON.stringify(answer.body))
  }
  const urns = new Set(answers.map((a) => a.body['urn']))
  assert.equal(urns.size, ids.length, 'two purchases shared a urn')

  // Mint order is still a total order — the retry re-reads the counter, it does not skip it.
  const ordinals = await sql<{ ordinal: number }[]>`select ordinal from wards order by ordinal`
  assert.deepEqual(ordinals.map((o) => o.ordinal), [0, 1, 2, 3, 4, 5])
})

/* ══════════════════════════════════════════════════════ the slug shape, in the schema ══ */

test('the schema refuses a slug too long to survive becoming a community slug', { skip }, async () => {
  // 60 characters: one past what `ward-` + slug can carry through community's 64-character CHECK,
  // so two such slugs would be ONE community slug. Refused here rather than discovered there.
  await assert.rejects(
    () => sql`insert into wards (slug, name, archetype, ordinal, claimable_tiles)
              values (${'a'.repeat(60)}, 'x', 'ashfield', 0, 49152)`,
    (err: unknown) => String(err).includes('wards_slug_shape'),
  )
  // 59 is fine, and so is every slug this service actually writes.
  await sql`insert into wards (slug, name, archetype, ordinal, claimable_tiles)
            values (${'a'.repeat(59)}, 'x', 'ashfield', 0, 49152)`
  const derived = wardSlugFrom({ entitlementId: `conformance-${randomUUID()}` } as never)
  assert.ok(derived.length <= 59, `${derived} is ${derived.length} characters`)
  await sql`insert into wards (slug, name, archetype, ordinal, claimable_tiles)
            values (${derived}, 'x', 'ashfield', 1, 49152)`

  // Uppercase and a trailing hyphen are both refused: one is a second spelling of one slug, the
  // other fails community's CHECK after the prefix.
  for (const bad of ['Commons', 'commons-', '-commons']) {
    await assert.rejects(
      () => sql`insert into wards (slug, name, archetype, ordinal, claimable_tiles)
                values (${bad}, 'x', 'ashfield', 50, 49152)`,
      (err: unknown) => String(err).includes('wards_slug_shape'),
      `${bad} was accepted as a ward slug`,
    )
  }
})
