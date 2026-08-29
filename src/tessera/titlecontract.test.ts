/**
 * The title contract, checked against `micro-worlds`' own client and conformance rules.
 *
 * §12's test 11: "`GET /v1/title` and `POST /v1/provision` satisfy `worlds`' client against the
 * real service, and provision replays idempotently on `entitlementId` — same `urn`,
 * `replayed: true` on the second ask, the way `worlds/src/conformance.ts` checks it."
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  PROVISION_PATH,
  TITLE_DESCRIPTOR_PATH,
  isCapability,
  parseProvisionRequest,
  parseProvisionResult,
  parseTitleDescriptor,
  parseTitleUrn,
  provisionIdempotencyKey,
  provisionScopeFor,
  serialiseProvisionRequest,
  serialiseProvisionResult,
  serialiseTitleDescriptor,
  type ProvisionRequest,
} from '@cloudsforge/contracts-worlds'
import {
  ALICE,
  ALICE_SUBJECT,
  asDb,
  enabled,
  migrateTestDb,
  openDb,
  resetTessera,
  skip,
} from './testsupport.ts'
import {
  CAPABILITIES,
  TITLE_DESCRIPTOR,
  TITLE_SLUG,
  provision,
  servesSku,
  wardNameFrom,
  wardSlugFrom,
} from './titlecontract.ts'
import { TESSERA_PROVISION_SCOPE } from './scopes.ts'
import { WorldError } from './world.ts'

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

const request = (over: Partial<ProvisionRequest> = {}): ProvisionRequest => ({
  entitlementId: 'ent-0001',
  subject: ALICE_SUBJECT,
  userId: ALICE,
  sku: 'world.private.small',
  scope: 'title:tessera',
  metadata: {},
  correlationId: 'req-1',
  ...over,
})

test('the descriptor round-trips through the contract parser worlds actually uses', () => {
  const body = serialiseTitleDescriptor(TITLE_DESCRIPTOR)
  const parsed = parseTitleDescriptor(body)
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('; '))
  if (!parsed.ok) return
  assert.equal(parsed.value.slug, TITLE_SLUG)
  assert.deepEqual([...parsed.value.capabilities], ['private_world', 'cosmetics', 'inventory'])
})

test('every declared capability is in the contracts closed set — a typo is a compile error here', () => {
  for (const capability of CAPABILITIES) {
    assert.ok(isCapability(capability), `${capability} is not a capability worlds knows`)
  }
  // `private_world` is the one that matters: worlds' provisioning bridge calls a title ONLY when
  // that capability holds (worlds/src/provisioning.ts), so without it the existing,
  // currently-unserved world.private.small SKU still has no code path.
  assert.ok(CAPABILITIES.includes('private_world'))
  // And the two this title deliberately does NOT claim. Declaring a capability it cannot deliver
  // is a purchase taken for something it cannot make — worlds' conformance check 4 exists for it.
  assert.equal(CAPABILITIES.includes('achievements'), false)
  assert.equal(CAPABILITIES.includes('seasons'), false)
})

test('the paths and the provision scope are the contracts, not this services', () => {
  assert.equal(TITLE_DESCRIPTOR_PATH, '/v1/title')
  assert.equal(PROVISION_PATH, '/v1/provision')
  // The literal the estate's scope audit reads must equal what the contract computes. aetherholm
  // keeps the same agreement in its own titlecontract.test.ts, for the same reason: the constant
  // has to stay a literal for the audit, so a test is what keeps it honest.
  assert.equal(TESSERA_PROVISION_SCOPE, provisionScopeFor(TITLE_SLUG))
})

test('the idempotency key is the entitlement id, and nothing else', () => {
  // "A title that derives its key from anything else raises a second world for one purchase."
  assert.equal(provisionIdempotencyKey(request()), 'ent-0001')
})

test('the request the bridge sends parses — and correlationId is NOT a body field', () => {
  const wire = serialiseProvisionRequest(request())
  assert.equal('correlationId' in wire, false, 'a receiver requiring it in the body would 400 every real request')
  const parsed = parseProvisionRequest(wire, 'req-from-header')
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('; '))
  if (parsed.ok) assert.equal(parsed.value.correlationId, 'req-from-header')
})

test('a sku this title cannot deliver is a closed set, not a guess', () => {
  assert.equal(servesSku('world.private.small'), true)
  assert.equal(servesSku('world.private.large'), false)
  assert.equal(servesSku('tessera.boost.featured'), false)
})

test('the ward slug is derived from the entitlement id, so two users cannot collide', () => {
  // A slug derived from a user-supplied NAME is a slug two users can collide on, and the collision
  // lands as a unique violation on somebody's paid provision.
  const a = wardSlugFrom(request({ entitlementId: 'ent-aaaa' }))
  const b = wardSlugFrom(request({ entitlementId: 'ent-bbbb', metadata: { name: 'Same Name' } }))
  const c = wardSlugFrom(request({ entitlementId: 'ent-cccc', metadata: { name: 'Same Name' } }))
  assert.notEqual(b, c)
  assert.match(a, /^private-/)
  // Deterministic: the same entitlement derives the same slug on every replica and every replay.
  assert.equal(a, wardSlugFrom(request({ entitlementId: 'ent-aaaa', metadata: { name: 'Other' } })))
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DERIVATION IS INJECTIVE, AND THE CASE BELOW IS THE ONE THAT WAS BROKEN IN PRODUCTION.
 *
 * `worlds/src/conformance.ts` mints `conformance-${crypto.randomUUID()}`. Under the previous
 * rule — strip non-alphanumerics, take twelve characters — `conformance` is ELEVEN characters, so
 * every conformance run in the estate's history maps to one of SIXTEEN slugs. The second run had
 * a fifteen-in-sixteen chance of colliding with the first.
 *
 * The 500 that produced is asserted over HTTP in `purchase.live.test.ts`. This is the derivation
 * on its own: the collision does not happen at all, which is the half that belongs here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('the sixteen slugs worlds conformance used to produce are sixteen different slugs', () => {
  const slugs = new Set(
    Array.from({ length: 64 }, (_, i) =>
      wardSlugFrom(request({ entitlementId: `conformance-${String(i).padStart(2, '0')}00000-0000-4000-8000-000000000000` })),
    ),
  )
  assert.equal(slugs.size, 64, 'two conformance entitlements derived one slug')

  // And the two shapes that are not injective before any truncation at all: separators are not
  // stripped, so `ent-1` and `ent1` are different wards.
  assert.notEqual(wardSlugFrom(request({ entitlementId: 'ent-1' })), wardSlugFrom(request({ entitlementId: 'ent1' })))

  // Bounded, because `wardCommunitySlug` prefixes `ward-` and truncates at 64 — a longer slug
  // would move this exact defect into micro-community's database. `wards_slug_shape` (migration
  // 12) holds the same 59 in the schema.
  for (const id of ['x', 'x'.repeat(4_000), 'conformance-00000000-0000-4000-8000-000000000000']) {
    const slug = wardSlugFrom(request({ entitlementId: id }))
    assert.ok(slug.length <= 59, `${slug} is ${slug.length} characters`)
    assert.match(slug, /^[a-z0-9]([a-z0-9-]{0,57}[a-z0-9])?$/, `${slug} fails wards_slug_shape`)
  }
})

test('a hostile or absent metadata name is replaced, never 400d — the money is already taken', () => {
  assert.equal(wardNameFrom(request({ metadata: { name: '  Willowbank  ' } })), 'Willowbank')
  for (const name of [undefined, null, '', '   ', 42, {}, 'x'.repeat(400)]) {
    const derived = wardNameFrom(request({ metadata: { name } }))
    assert.ok(derived.length > 0 && derived.length <= 80, `a name of ${String(name)} produced ${derived}`)
  }
})

/* ------------------------------------------------------------------- against Postgres */

test('provision raises a ward, and replays idempotently on entitlementId', { skip }, async () => {
  const first = await provision(asDb(sql), request())
  assert.equal(first.replayed, false)
  const parsed = parseTitleUrn(first.urn)
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('; '))
  if (parsed.ok) {
    assert.equal(parsed.value.title, TITLE_SLUG)
    assert.equal(parsed.value.kind, 'ward')
  }

  // The second ask: SAME urn, replayed true — worlds/src/conformance.ts.
  const second = await provision(asDb(sql), request())
  assert.equal(second.urn, first.urn)
  assert.equal(second.replayed, true)

  // And exactly ONE ward was raised, which is the thing the caller cannot see from the response.
  const wards = await sql<{ n: number }[]>`select count(*)::int as n from wards`
  assert.equal(wards[0]?.n, 1)

  // The result serialises through the contract's own parser.
  const result = parseProvisionResult(serialiseProvisionResult(second))
  assert.equal(result.ok, true)
})

test('two replicas provisioning one entitlement raise one ward', { skip }, async () => {
  const a = openDb(2)
  const b = openDb(2)
  try {
    const results = await Promise.allSettled([
      provision(asDb(a), request({ entitlementId: 'ent-race' })),
      provision(asDb(b), request({ entitlementId: 'ent-race' })),
    ])
    const urns = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.urn] : []))
    assert.ok(urns.length >= 1)
    // Whatever the interleaving, every caller that succeeded got the SAME urn.
    assert.equal(new Set(urns).size, 1, `two urns for one entitlement: ${urns.join(', ')}`)
  } finally {
    await a.end({ timeout: 5 })
    await b.end({ timeout: 5 })
  }
  const provisions = await sql<{ n: number }[]>`select count(*)::int as n from provisions`
  assert.equal(provisions[0]?.n, 1)
})

test('an unserved sku is 422 unsupported, not a silent success that bills for nothing', { skip }, async () => {
  await assert.rejects(
    () => provision(asDb(sql), request({ sku: 'world.private.enormous' })),
    (err: unknown) => err instanceof WorldError && err.status === 422 && err.code === 'unsupported',
  )
  const wards = await sql<{ n: number }[]>`select count(*)::int as n from wards`
  assert.equal(wards[0]?.n, 0, 'a ward was raised for a sku this title does not serve')
})

test('the database refuses a urn of the wrong shape — the aetherholm defect, closed', { skip }, async () => {
  await assert.rejects(
    () => sql`insert into provisions (entitlement_id, subject, user_id, sku, scope, urn)
              values ('e1', ${ALICE_SUBJECT}, ${ALICE}, 'world.private.small', 's',
                      'urn:cloudsforge:tessera:ward:1')`,
    (err: unknown) => String(err).includes('provisions_urn_is_a_title_urn'),
    'a urn the contracts parser refuses was stored — it would be pointed at for ever',
  )
  // And the shape the contract builds is accepted.
  await sql`insert into provisions (entitlement_id, subject, user_id, sku, scope, urn)
            values ('e2', ${ALICE_SUBJECT}, ${ALICE}, 'world.private.small', 's',
                    'cf:tessera:ward:0192f000-0000-7000-8000-000000000001')`
})
