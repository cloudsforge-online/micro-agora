/**
 * **WHAT A STRANGER MAY SEE, AND WHAT THEY MAY NOT.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * Every read in this service authenticated, including `GET /v1/wards` — so a signed-out visitor
 * arriving at Tessera's front door got a 401 and the page showed an error state. That was the last
 * failing check in `beacon smoke`.
 *
 * `server.ts` argues at length why the Mosaic is public; the short form is that 23-tessera.md §5
 * opens its loop with "arrive at the Commons — a browser tab; no download, no plugin, **no account
 * wall**", that `worlds/src/server.ts` already serves the title registry unauthenticated under
 * "a launcher listing games cannot require a token to do it", and that the 401 was never a security
 * boundary in any case: a ward row carries no user-scoped field, and any account could already read
 * it while an account is free and self-serve. It made a public map cost a signup, and nothing else.
 *
 * **This file exists because that argument is the kind that decays.** A change that removes
 * authentication needs a test that says precisely how far it went, or the next person widens it by
 * one route at a time with the same reasoning and no one notices. So each case below is a pair:
 * the route that opened, and — in the same file, against the same server — the neighbouring routes
 * that did NOT, because they name people.
 *
 * The verifier here **throws on every token**, which is stronger than stubbing a principal: it
 * models a visitor with no account at all, and it means a route that quietly started reading a
 * token to decide something would fail rather than pass. Nothing else is faked — real routing, real
 * database, real status lines.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { singleNetworkSql } from './testsupport.ts'
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { Lifecycle } from '@cloudsforge/lifecycle'
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
  TEST_EVENT_SECRET,
  testMetrics,
} from './testsupport.ts'
import { createServer } from './server.ts'
import { claimParcel, listWards } from './world.ts'

let sql: postgres.Sql
let server: Server
let origin: string

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 })
  server = createServer({
    lifecycle,
    logger: quietLogger(),
    metrics: testMetrics(),
    // **A visitor with no account.** Every token is refused, so any route that still authenticates
    // answers 401 — which is exactly what the routes below are being sorted by.
    verifier: {
      principal: async () => {
        throw new Error('no principal: this visitor is signed out')
      },
    },
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

/** No `authorization` header at all — a stranger following a link, which is the case that broke. */
async function anonymous(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`)
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { status: response.status, body }
}

test('THE FRONT DOOR: a signed-out visitor is served the Mosaic', { skip }, async () => {
  await seedWard(sql)
  const answer = await anonymous('/v1/wards')

  assert.equal(answer.status, 200, 'the front door still refuses a stranger')
  const wards = answer.body['wards']
  assert.ok(Array.isArray(wards) && wards.length === 1, 'the Mosaic came back empty')

  // Byte-for-byte what an authenticated caller got, because the response does not vary by
  // principal — which is the reason no token is read here rather than a happy accident.
  assert.deepEqual(wards, JSON.parse(JSON.stringify(await listWards(asDb(sql)))))
})

test('a single ward is public too, because a list you may see and an item you may not is incoherent', { skip }, async () => {
  const wardId = await seedWard(sql)
  const answer = await anonymous(`/v1/wards/${wardId}`)
  assert.equal(answer.status, 200)
  assert.equal((answer.body['ward'] as Record<string, unknown>)['id'], wardId)

  // And a ward that does not exist is still a 404, not a 401. An unauthenticated route that leaked
  // existence through its error code would be a worse answer than the one it replaced.
  assert.equal((await anonymous('/v1/wards/00000000-0000-4000-8000-000000000000')).status, 404)
})

test('the buildings are public too — a world with invisible buildings feels empty when it is not', { skip }, async () => {
  const wardId = await seedWard(sql)
  const answer = await anonymous(`/v1/wards/${wardId}/parcels`)
  assert.equal(answer.status, 200, 'the arrivals screen still refuses a stranger')
  assert.ok(Array.isArray(answer.body['parcels']))

  // The whole anonymous path, and it is only two calls: `listWards` then `listWardParcels`
  // (`tessera-web/src/pages/world.tsx` and). Asserted so that "opening this bounded the
  // change rather than starting a slide" is a fact a later reader can check rather than a claim.
  assert.equal((await anonymous('/v1/wards')).status, 200)
})

test('THE LINE: what places a person is still refused, on the same server, in the same breath', { skip }, async () => {
  const wardId = await seedWard(sql)

  // `presence` returns a subject with live `x, y` — where a named person is standing, right now.
  // That is not a fact about the world, it is a fact about a body in it. `discover`, `me/parcels`,
  // the objects and the listings are the market and the register. The map and the buildings are
  // public; none of these is.
  for (const path of [
    `/v1/wards/${wardId}/presence`,
    '/v1/parcels/fallow',
    '/v1/discover',
    '/v1/me/parcels',
    '/v1/objects',
    '/v1/listings',
  ]) {
    assert.equal((await anonymous(path)).status, 401, `${path} was opened to anonymous callers`)
  }
})

test('THE EXPOSURE: `ownerSubject` reaches an anonymous caller, and that was a decision', { skip }, async () => {
  // Recorded rather than glossed. Opening `…/:id/parcels` publishes an opaque uuid per parcel that
  // refers to a person. `server.ts` gives the four reasons that was judged acceptable — no resolver
  // an anonymous caller can reach, an estate that publishes ownership by design, a screen that does
  // not display it, and a gate that was a signup wall rather than a boundary — and names the remedy
  // if the trade is ever reconsidered: drop the field from THIS projection, do not close the world.
  //
  // This case exists so that reconsidering it starts from a red test rather than from a discovery.
  const wardId = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  await claimParcel(asDb(sql), {
    wardId,
    ownerSubject: ALICE_SUBJECT,
    tier: 'homestead',
    originX: 0,
    originY: 0,
    correlationId: 'publicreads-test',
  })

  const parcels = (await anonymous(`/v1/wards/${wardId}/parcels`)).body['parcels'] as Record<
    string,
    unknown
  >[]
  assert.equal(parcels.length, 1)
  assert.equal(
    parcels[0]?.['ownerSubject'],
    ALICE_SUBJECT,
    'ownerSubject stopped reaching anonymous callers — if that was deliberate, delete this test and say why in server.ts',
  )
})

test('THE COUNT: exactly four routes are unauthenticated, and adding a fifth is a red build', { skip }, async () => {
  // The guard against widening one route at a time. `server.ts`'s route table is the subject, read
  // as source: a route with no `authenticate` call in its body is a route a stranger can reach, and
  // this is the complete list of the ones that may be.
  //
  // Counted off the source rather than by probing every path, because a probe can only find the
  // routes a test author remembered to write down — which is the failure mode this whole file is
  // about. `/livez`, `/readyz` and `/metrics` are excluded by rule 4 and are not domain routes.
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('./server.ts', import.meta.url), 'utf8'),
  )

  // Each `define(...)` call and its body, up to the next one. Crude, and deliberately so: a regex
  // that understood the file would be a second parser to keep in step with it.
  const routes = source
    .split(/\n {4}define\(/)
    .slice(1)
    .map((chunk) => {
      const signature = /^'([A-Z]+)', ([^,]+),/.exec(chunk)
      return {
        route: signature ? `${signature[1]} ${signature[2]}` : chunk.slice(0, 60),
        authenticated: /\bauthenticate\(|\brequireUser\(/.test(chunk),
      }
    })
    .filter((route) => !/'\/(livez|readyz|metrics)'/.test(route.route))

  assert.ok(routes.length > 20, `the route table did not parse (${routes.length} routes found)`)
  assert.deepEqual(
    routes.filter((route) => !route.authenticated).map((route) => route.route).sort(),
    [
      // The title descriptor: a capability statement worlds reads before it holds any credential
      // for this title.
      "GET TITLE_DESCRIPTOR_PATH",
      "GET '/v1/wards'",
      "GET '/v1/wards/:id'",
      "GET '/v1/wards/:id/parcels'",
    ].sort(),
    'the set of unauthenticated routes changed — read server.ts on the Mosaic before widening it',
  )
})
