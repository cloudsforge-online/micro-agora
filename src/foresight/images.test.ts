/**
 * The header image: the schema that refuses half a reference, and the routes that set and clear it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE THREE THAT MATTER MOST, AND THEY ARE ALL NEGATIVE.
 *
 *   * **HALF A REFERENCE DOES NOT COMMIT.** An asset id with no checksum, and a checksum with no
 *     asset id, are both refused BY THE DATABASE — not by a handler that a future write path can
 *     go around. `markets_image_is_whole` is tessera's `objects_anchor_is_whole` applied to an
 *     image, for the same reason: half a reference is a claim nothing backs, it renders as a
 *     broken picture in one client and as nothing in the next, and the missing half was never
 *     written down anywhere so it cannot be recovered.
 *
 *   * **A MALFORMED CHECKSUM DOES NOT COMMIT.** Uppercase hex, a bare hex with no prefix, the
 *     wrong length — all 23514. The estate has ONE spelling for a content address
 *     (`studio/src/assets.ts`, tessera's `objects_checksum_shape`), and a second dialect born here
 *     would compare unequal to the first everywhere it travelled.
 *
 *   * **A NON-ADMIN CANNOT TOUCH ANOTHER'S IMAGE.** 403, on set and on clear, from the same
 *     `requireAdmin` every other mutating route in this service uses.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## What is deliberately NOT asserted anywhere in this file
 *
 * That the checksum is correct. foresight never fetches the bytes and never recomputes the digest
 * — it stores what studio told the uploader. A test asserting otherwise would be asserting a
 * property this service does not have, which is the failure mode `images.ts`'s header exists to
 * prevent. What IS asserted is that the shape holds and that no response calls the image verified,
 * attested, on-chain or anchored.
 */

import { singleNetworkSql } from './server.test.ts'
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Lifecycle } from '@cloudsforge/lifecycle'
import type { Principal, Verifier } from '@cloudsforge/auth'
import { createServer, type ServerDeps } from './server.ts'
import { IMAGE_CHECKSUM, ImageError, bytesPath, imageView, parseImageReference } from './images.ts'
import { findMarket } from './markets.ts'
import { findIdea } from './ideas.ts'
import { IDEA_IMAGED, MARKET_IMAGED } from './outbox.ts'
import {
  db,
  enabled,
  fakeLedger,
  fakePolicy,
  fakePricing,
  fakeSourceProbe,
  migrateTestDb,
  openDb,
  openDirect,
  quietLogger,
  resetForesight,
  seedDraft,
  seedIdea,
  skip,
  testMetrics,
} from './testsupport.ts'

/**
 * A public studio origin IS configured in this file, unlike every other suite.
 *
 * That is the point of the file: `bytesUrl` composition is a thing that can be wrong — a trailing
 * slash, a path segment, a relative answer — and a suite that left it undefined would prove only
 * that null is null. The `undefined` branch is covered by a unit case below.
 */
const STUDIO = 'https://studio.example.invalid'

/** A well-formed checksum in studio's spelling. Lowercase, 64 hex, `sha256:` prefixed. */
const CHECKSUM = `sha256:${'ab'.repeat(32)}`
const ASSET_ID = '11111111-1111-4111-8111-111111111111'

let sql: postgres.Sql
let server: Server
let baseUrl: string

const ADMIN: Principal = {
  kind: 'user',
  userId: '00000000-0000-4000-8000-000000000001',
  roles: ['admin'],
} as unknown as Principal
/** A signed-in user who is not an operator. The 403 in every negative case below is theirs. */
const PLAYER: Principal = {
  kind: 'user',
  userId: '00000000-0000-4000-8000-000000000002',
  roles: ['player'],
} as unknown as Principal

function fakeVerifier(): Verifier {
  return {
    async principal(token: string) {
      if (token === 'admin') return ADMIN
      if (token === 'player') return PLAYER
      const { TokenError } = await import('@cloudsforge/auth')
      throw new TokenError('bad token', 'invalid')
    },
  } as unknown as Verifier
}

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
  const testQueue = new JobQueue(sql as unknown as JobsSql, { owner: 'test', leaseMs: 60_000 })
  const deps: ServerDeps = {
    sql: singleNetworkSql(db(sql)),
    singleNetwork: 'mainnet' as const,
    queue: testQueue,
    // One queue, presented as the per-network selector: the suites run against a single
    // database, so both networks resolve to it. What is under test is that a route ASKS.
    queueFor: () => testQueue,
    verifier: fakeVerifier(),
    lifecycle: new Lifecycle({}),
    logger: quietLogger(),
    metrics: testMetrics(),
    policy: fakePolicy(),
    sourceProbe: fakeSourceProbe(true),
    producer: 'foresight',
    chain: 'ember',
    network: 'testnet',
    defaultFeeBps: 200,
    defaultDisputeWindowSeconds: 86_400,
    houseAddress: undefined,
    engagementPolicies: null,
    pricing: fakePricing(),
    ledger: fakeLedger(),
    custodialAddress: undefined,
    studioPublicUrl: STUDIO,
  }
  server = createServer(deps)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetForesight(sql)
})

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/* ------------------------------------------------------------------ the vocabulary, offline */

test('the checksum shape is studio’s, and nothing is normalised into it', () => {
  assert.ok(IMAGE_CHECKSUM.test(CHECKSUM))
  // Uppercase is REFUSED rather than lowered. A normaliser here would be the one place two
  // spellings of one image could be born — tessera/src/itemasset.ts refuses for the same reason.
  assert.ok(!IMAGE_CHECKSUM.test(`sha256:${'AB'.repeat(32)}`))
  // A bare hex is refused rather than prefixed.
  assert.ok(!IMAGE_CHECKSUM.test('ab'.repeat(32)))
  assert.ok(!IMAGE_CHECKSUM.test(`sha256:${'ab'.repeat(31)}`), '63 bytes is not a sha256')
  assert.ok(!IMAGE_CHECKSUM.test(`sha512:${'ab'.repeat(32)}`))
})

test('a body carrying only half a reference is refused before it reaches the database', () => {
  // The likeliest client mistake: the id is the part a developer thinks of as "the image".
  assert.throws(
    () => parseImageReference({ assetId: ASSET_ID }),
    (err: unknown) => err instanceof ImageError && err.code === 'bad_checksum',
  )
  assert.throws(
    () => parseImageReference({ checksum: CHECKSUM }),
    (err: unknown) => err instanceof ImageError && err.code === 'bad_asset_id',
  )
  assert.deepEqual(parseImageReference({ assetId: ASSET_ID, checksum: CHECKSUM }), {
    assetId: ASSET_ID,
    checksum: CHECKSUM,
  })
})

test('bytesUrl is absolute or null — never a relative path this service’s origin would swallow', () => {
  const view = imageView(ASSET_ID, CHECKSUM, STUDIO)
  assert.equal(view?.bytesUrl, `${STUDIO}/v1/assets/${ASSET_ID}/bytes`)
  assert.equal(bytesPath(ASSET_ID), `/v1/assets/${ASSET_ID}/bytes`, 'studio’s own spelling')

  // Unconfigured is a supported mode and says so with a null. A relative path here would resolve
  // against foresight's origin in a browser and 404 — "a zero wearing a status code".
  assert.equal(imageView(ASSET_ID, CHECKSUM, undefined)?.bytesUrl, null)

  // No image is not an empty image.
  assert.equal(imageView(null, null, STUDIO), null)

  // And if the constraint were ever dropped, the view refuses rather than inventing a reference.
  assert.throws(
    () => imageView(ASSET_ID, null, STUDIO),
    (err: unknown) => err instanceof ImageError && err.code === 'half_a_reference',
  )
})

/* ------------------------------------------------------------------ the schema, firing */

test('the schema refuses HALF a reference on markets — an id with no checksum', { skip }, async () => {
  const market = await seedDraft(sql)
  await assert.rejects(
    sql`update markets set image_asset_id = ${ASSET_ID}::uuid where id = ${market.id}`,
    /markets_image_is_whole/,
  )
})

test('the schema refuses HALF a reference on markets — a checksum with no id', { skip }, async () => {
  const market = await seedDraft(sql)
  await assert.rejects(
    sql`update markets set image_checksum = ${CHECKSUM} where id = ${market.id}`,
    /markets_image_is_whole/,
  )
})

test('the schema refuses HALF a reference on ideas, both ways round', { skip }, async () => {
  const idea = await seedIdea(sql)
  await assert.rejects(
    sql`update ideas set image_asset_id = ${ASSET_ID}::uuid where id = ${idea.id}`,
    /ideas_image_is_whole/,
  )
  await assert.rejects(
    sql`update ideas set image_checksum = ${CHECKSUM} where id = ${idea.id}`,
    /ideas_image_is_whole/,
  )
})

test('the schema refuses a malformed checksum even when the id is present', { skip }, async () => {
  const market = await seedDraft(sql)
  for (const bad of [
    // Uppercase hex. Valid to a case-insensitive reader, a different string to every join.
    `sha256:${'AB'.repeat(32)}`,
    // No prefix. This is what a client that read studio's `checksum` field as raw hex would send.
    'ab'.repeat(32),
    `sha256:${'ab'.repeat(31)}`,
    'sha256:',
  ]) {
    await assert.rejects(
      sql`
        update markets set image_asset_id = ${ASSET_ID}::uuid, image_checksum = ${bad}
         where id = ${market.id}
      `,
      /markets_image_checksum_shape/,
      `${bad.slice(0, 24)}… was accepted`,
    )
  }
  const idea = await seedIdea(sql)
  await assert.rejects(
    sql`
      update ideas set image_asset_id = ${ASSET_ID}::uuid, image_checksum = ${'ab'.repeat(32)}
       where id = ${idea.id}
    `,
    /ideas_image_checksum_shape/,
  )
})

test('a whole, well-formed reference commits', { skip }, async () => {
  const market = await seedDraft(sql)
  await sql`
    update markets set image_asset_id = ${ASSET_ID}::uuid, image_checksum = ${CHECKSUM}
     where id = ${market.id}
  `
  const stored = await findMarket(db(sql), market.id)
  assert.equal(stored?.imageAssetId, ASSET_ID)
  assert.equal(stored?.imageChecksum, CHECKSUM)
})

/* ------------------------------------------------------------------ authority */

test('a signed-in non-operator cannot set another’s market image', { skip }, async () => {
  const market = await seedDraft(sql)
  const set = await call('PUT', `/markets/${market.id}/image`, 'player', {
    assetId: ASSET_ID,
    checksum: CHECKSUM,
  })
  assert.equal(set.status, 403)
  // Unchanged, and that is the assertion that matters — a 403 that had already written would be
  // the worst of both.
  assert.equal((await findMarket(db(sql), market.id))?.imageAssetId, null)
})

test('a signed-in non-operator cannot CLEAR another’s market image', { skip }, async () => {
  const market = await seedDraft(sql)
  await call('PUT', `/markets/${market.id}/image`, 'admin', { assetId: ASSET_ID, checksum: CHECKSUM })

  const cleared = await call('DELETE', `/markets/${market.id}/image`, 'player', undefined)
  assert.equal(cleared.status, 403)
  const still = await findMarket(db(sql), market.id)
  assert.equal(still?.imageAssetId, ASSET_ID, 'a non-operator removed somebody else’s image')
  assert.equal(still?.imageChecksum, CHECKSUM)
})

test('an unauthenticated caller cannot set or clear an image', { skip }, async () => {
  const market = await seedDraft(sql)
  assert.equal(
    (await call('PUT', `/markets/${market.id}/image`, null, { assetId: ASSET_ID, checksum: CHECKSUM }))
      .status,
    401,
  )
  assert.equal((await call('DELETE', `/markets/${market.id}/image`, null, undefined)).status, 401)
})

test('a non-operator cannot set or clear an idea’s image either', { skip }, async () => {
  const idea = await seedIdea(sql)
  assert.equal(
    (await call('PUT', `/ideas/${idea.id}/image`, 'player', { assetId: ASSET_ID, checksum: CHECKSUM }))
      .status,
    403,
  )
  assert.equal((await call('DELETE', `/ideas/${idea.id}/image`, 'player', undefined)).status, 403)
})

/* ------------------------------------------------------------------ the routes */

test('an operator sets a market image and the read returns the reference and the bytes URL', { skip }, async () => {
  const market = await seedDraft(sql)
  const set = await call('PUT', `/markets/${market.id}/image`, 'admin', {
    assetId: ASSET_ID,
    checksum: CHECKSUM,
  })
  assert.equal(set.status, 200)

  const read = await call('GET', `/markets/${market.id}`, null)
  assert.equal(read.status, 200)
  const body = read.body['market'] as Record<string, unknown>
  assert.deepEqual(body['image'], {
    assetId: ASSET_ID,
    checksum: CHECKSUM,
    bytesUrl: `${STUDIO}/v1/assets/${ASSET_ID}/bytes`,
  })

  // The list carries it too, so a card can render without a second request per market.
  const list = await call('GET', '/markets', null)
  const listed = (list.body['markets'] as Record<string, unknown>[])[0]
  assert.deepEqual(listed?.['image'], body['image'])
})

test('setting an image leaves questionHash untouched', { skip }, async () => {
  // The question a reader will reasonably ask, answered by a test rather than only by a comment.
  // `questiondoc.ts` hashes ten fields and the image is in none of them, so a bettor recomputing
  // the hash from the public page still gets the value the deployed contract holds. If this ever
  // fails, an image change has become a criteria change to every checker in the estate.
  const market = await seedDraft(sql)
  const before = (await call('GET', `/markets/${market.id}`, null)).body
  await call('PUT', `/markets/${market.id}/image`, 'admin', { assetId: ASSET_ID, checksum: CHECKSUM })
  const after = (await call('GET', `/markets/${market.id}`, null)).body

  const hashOf = (body: Record<string, unknown>): unknown =>
    (body['market'] as Record<string, unknown>)['questionHash']
  assert.equal(hashOf(after), hashOf(before))
  assert.equal(
    (after['document'] as Record<string, unknown>)['canonical'],
    (before['document'] as Record<string, unknown>)['canonical'],
    'the canonical document changed, so the image has leaked into the hashed text',
  )
})

test('clearing an image sets BOTH columns null together', { skip }, async () => {
  const market = await seedDraft(sql)
  await call('PUT', `/markets/${market.id}/image`, 'admin', { assetId: ASSET_ID, checksum: CHECKSUM })

  const cleared = await call('DELETE', `/markets/${market.id}/image`, 'admin', undefined)
  assert.equal(cleared.status, 200)
  assert.equal((cleared.body['market'] as Record<string, unknown>)['image'], null)

  // Read from the COLUMNS, not from the response: the response could be null because the view
  // returned null, while one column still held a value. This is the pair the constraint protects.
  const row = (await sql<{ image_asset_id: string | null; image_checksum: string | null }[]>`
    select image_asset_id, image_checksum from markets where id = ${market.id}
  `)[0]
  assert.equal(row?.image_asset_id, null)
  assert.equal(row?.image_checksum, null)
})

test('a market with no image reads as image: null, not as an empty frame', { skip }, async () => {
  const market = await seedDraft(sql)
  const read = await call('GET', `/markets/${market.id}`, null)
  assert.equal((read.body['market'] as Record<string, unknown>)['image'], null)
})

test('an idea carries its own image, and it is NOT copied into a market', { skip }, async () => {
  const idea = await seedIdea(sql)
  const set = await call('PUT', `/ideas/${idea.id}/image`, 'admin', {
    assetId: ASSET_ID,
    checksum: CHECKSUM,
  })
  assert.equal(set.status, 200)
  assert.deepEqual((set.body['idea'] as Record<string, unknown>)['image'], {
    assetId: ASSET_ID,
    checksum: CHECKSUM,
    bytesUrl: `${STUDIO}/v1/assets/${ASSET_ID}/bytes`,
  })

  const listed = await call('GET', '/ideas?status=proposed', 'admin')
  const first = (listed.body['ideas'] as Record<string, unknown>[])[0]
  assert.deepEqual(first?.['image'], (set.body['idea'] as Record<string, unknown>)['image'])
  // The raw columns are not also present: one shape to read, and no way to reassemble a half.
  assert.equal(first?.['imageAssetId'], undefined)
  assert.equal(first?.['imageChecksum'], undefined)

  // A market built from the proposal starts with no image. A picture chosen while a question was
  // being judged is not part of the question, and copying it would publish an operator's working
  // sketch on a page that takes money.
  const created = await call('POST', '/markets', 'admin', {
    ideaId: idea.id,
    question: idea.question,
    resolutionCriteria: idea.resolutionCriteria,
    category: idea.category,
    resolutionSourceKind: idea.resolutionSourceKind,
    resolutionSourceRef: idea.resolutionSourceRef,
    closeTime: idea.suggestedCloseTime.toISOString(),
  })
  assert.equal(created.status, 201)
  assert.equal((created.body['market'] as Record<string, unknown>)['image'], null)
})

test('an idea image clears both columns too', { skip }, async () => {
  const idea = await seedIdea(sql)
  await call('PUT', `/ideas/${idea.id}/image`, 'admin', { assetId: ASSET_ID, checksum: CHECKSUM })
  const cleared = await call('DELETE', `/ideas/${idea.id}/image`, 'admin', undefined)
  assert.equal(cleared.status, 200)
  const stored = await findIdea(db(sql), idea.id)
  assert.equal(stored?.imageAssetId, null)
  assert.equal(stored?.imageChecksum, null)
})

test('a malformed reference is refused by the route with a 400 that says which half', { skip }, async () => {
  const market = await seedDraft(sql)
  const noChecksum = await call('PUT', `/markets/${market.id}/image`, 'admin', { assetId: ASSET_ID })
  assert.equal(noChecksum.status, 400)
  assert.equal((noChecksum.body['error'] as Record<string, unknown>)['code'], 'bad_checksum')

  const upper = await call('PUT', `/markets/${market.id}/image`, 'admin', {
    assetId: ASSET_ID,
    checksum: `sha256:${'AB'.repeat(32)}`,
  })
  assert.equal(upper.status, 400)
  assert.equal((upper.body['error'] as Record<string, unknown>)['code'], 'bad_checksum')

  const notAnId = await call('PUT', `/markets/${market.id}/image`, 'admin', {
    assetId: 'not-a-uuid',
    checksum: CHECKSUM,
  })
  assert.equal(notAnId.status, 400)
  assert.equal((notAnId.body['error'] as Record<string, unknown>)['code'], 'bad_asset_id')

  assert.equal((await findMarket(db(sql), market.id))?.imageChecksum, null)
})

test('setting an image on a market that does not exist is a 404', { skip }, async () => {
  const missing = await call('PUT', `/markets/${ASSET_ID}/image`, 'admin', {
    assetId: ASSET_ID,
    checksum: CHECKSUM,
  })
  assert.equal(missing.status, 404)
})

/* ------------------------------------------------------------------ the outbox */

test('setting and clearing each write an outbox row, in the same transaction', { skip }, async () => {
  const market = await seedDraft(sql)
  await call('PUT', `/markets/${market.id}/image`, 'admin', { assetId: ASSET_ID, checksum: CHECKSUM })
  await call('DELETE', `/markets/${market.id}/image`, 'admin', undefined)

  const events = await sql<{ topic: string; actor: string | null; payload: Record<string, unknown> }[]>`
    select topic, actor, payload from outbox where topic = ${MARKET_IMAGED} order by occurred_at
  `
  assert.equal(events.length, 2, 'a clear is a change a consumer needs as much as a set')
  assert.equal(events[0]?.payload['imageAssetId'], ASSET_ID)
  assert.equal(events[0]?.payload['cleared'], false)
  assert.equal(events[1]?.payload['imageAssetId'], null)
  assert.equal(events[1]?.payload['cleared'], true)
  // The actor on the row IS the audit trail — which is why there is no `image_set_by` column.
  assert.match(String(events[0]?.actor), /^operator:/)

  // No URL in a durable event. `bytesUrl` is built from this deployment's STUDIO_PUBLIC_URL, and a
  // consumer replaying this a year from now would follow an address that may belong to nobody.
  assert.equal(events[0]?.payload['bytesUrl'], undefined)
  assert.ok(!JSON.stringify(events[0]?.payload).includes(STUDIO))
})

test('an idea image change writes its own topic', { skip }, async () => {
  const idea = await seedIdea(sql)
  await call('PUT', `/ideas/${idea.id}/image`, 'admin', { assetId: ASSET_ID, checksum: CHECKSUM })
  const events = await sql<{ topic: string }[]>`
    select topic from outbox where topic = ${IDEA_IMAGED}
  `
  assert.equal(events.length, 1)
})

test('a refused image change publishes nothing', { skip }, async () => {
  const market = await seedDraft(sql)
  await call('PUT', `/markets/${market.id}/image`, 'player', { assetId: ASSET_ID, checksum: CHECKSUM })
  assert.equal((await sql`select 1 from outbox where topic = ${MARKET_IMAGED}`).length, 0)
})

/* ------------------------------------------------------------------ the honesty constraint */

test('a settled market’s image may still be changed, and clearing one is always available', { skip }, async () => {
  // Justified in `setMarketImage`: a settled market's page is permanent and public, so an image on
  // it that turns out to be unlawful or somebody else's copyright must be removable. Under a
  // freeze the only remedy would be deleting the market, which the lifecycle rightly forbids — so
  // the rule would fire exactly where removal is most necessary. Nothing about the payout can move:
  // the image is in no hash and no clause of any resolution reads it.
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  await sql`
    update markets
       set status = 'settled', closed_at = now(), resolved_at = now(), settled_at = now(), outcome = 0
     where id = ${market.id}
  `
  const set = await call('PUT', `/markets/${market.id}/image`, 'admin', {
    assetId: ASSET_ID,
    checksum: CHECKSUM,
  })
  assert.equal(set.status, 200)
  assert.equal((await call('DELETE', `/markets/${market.id}/image`, 'admin', undefined)).status, 200)
})

test('no response describes an image as verified, attested, on-chain or anchored', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // THE CLAIM THAT MUST NEVER APPEAR, PINNED BY A TEST RATHER THAN BY A COMMENT.
  //
  // foresight really does talk to a chain, so a reader of `GET /markets/:id` is already primed to
  // read a hex digest as an on-chain fact — `questionHash` two fields away IS one. An image
  // checksum is not: studio measured it, a client relayed it, and this service never re-measures
  // it. Worse, the false claim would be undetectable — Hearth has no Registry of Authorship
  // (`tessera/src/kiln.ts` records the Solidity was never written) and studio's
  // `anchor.state` is `'unanchored'` on every asset. A badge that always passes is worse than no
  // badge, on a platform that custodies real money.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  const market = await seedDraft(sql)
  await call('PUT', `/markets/${market.id}/image`, 'admin', { assetId: ASSET_ID, checksum: CHECKSUM })
  const idea = await seedIdea(sql)
  await call('PUT', `/ideas/${idea.id}/image`, 'admin', { assetId: ASSET_ID, checksum: CHECKSUM })

  for (const body of [
    JSON.stringify((await call('GET', `/markets/${market.id}`, null)).body),
    JSON.stringify((await call('GET', '/markets', null)).body),
    JSON.stringify((await call('GET', '/ideas?status=proposed', 'admin')).body),
  ]) {
    for (const forbidden of ['verified', 'attested', 'anchor', 'onChain', 'on-chain', 'provenanceProof']) {
      assert.ok(
        !body.toLowerCase().includes(forbidden.toLowerCase()),
        `a response used the word "${forbidden}" — see images.ts`,
      )
    }
  }
})

/* ------------------------------------------------------------------ discovery */

test('GET /image-config publishes studio’s address so no client has to guess it', { skip }, async () => {
  // The estate has shipped two defects of exactly one kind — a client written against a surface
  // somebody imagined. `studio` has no row in the @cloudsforge/ui surfaces registry, so a browser
  // deriving `https://studio.<apex>` would have nothing to derive from and would guess a hostname
  // nobody published. The deployment knows its own answer, so it gives it.
  const res = await call('GET', '/image-config', null)
  assert.equal(res.status, 200)
  assert.equal(res.body['studioUrl'], STUDIO)
  assert.equal(res.body['uploadPath'], '/v1/uploads')
  // Public, because studio's bytes route needs no Authorization header for a public asset and a
  // browser sends none on an `<img src>`.
  assert.equal(res.body['visibility'], 'public')
  // A convenience for the file picker. studio reads magic bytes and is the only thing that decides.
  assert.deepEqual(res.body['accept'], ['image/png', 'image/jpeg', 'image/webp'])
})
