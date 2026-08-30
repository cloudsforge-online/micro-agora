/**
 * Discovery: two signals, and §12's test 12.
 *
 * "Ranking admits exactly two inputs. A test on the ranking function's signature, so that adding a
 * third — paid or otherwise — cannot happen quietly."
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import {
  ALICE_SUBJECT,
  BOB_SUBJECT,
  CAROL_SUBJECT,
  asDb,
  enabled,
  migrateTestDb,
  openDb,
  resetTessera,
  seedAccounts,
  seedWard,
  skip,
  stripComments,
  stripQuotedProse,
} from './testsupport.ts'
import { lightBeacon, rank, rankParcels, recordVisit, type RankingInputs } from './discovery.ts'

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

async function seedParcel(ward: string, owner: string, x: number): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, gate_open)
    values (${ward}, ${owner}, 'plot', ${x}, 0, 32, true) returning id
  `
  return rows[0]!.id
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SIGNATURE TEST. §12's test 12, and §7.1's first refusal.
 *
 * "If Tessera ever needs money badly enough to sell discovery, it needs to be shut down instead."
 *
 * `RankingInputs` is a closed interface with exactly three fields. TypeScript erases at runtime,
 * so this cannot read the type — it reads the OBJECT the ranking path builds, which is the thing
 * a fourth input would actually have to appear in. Adding `promotedBps` means this test changes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('the ranking function admits exactly three inputs, and two of them are the signals', () => {
  const inputs: RankingInputs = { footfall: 10, medianDwellSeconds: 60, ageDays: 1 }
  assert.deepEqual(Object.keys(inputs).sort(), ['ageDays', 'footfall', 'medianDwellSeconds'])

  // `rank` takes ONE argument — the inputs object — so there is nowhere for a second source of
  // ordering to be passed either.
  assert.equal(rank.length, 1)

  // And the two that are SIGNALS. Recency is a property of the row; nobody can buy more of it.
  const source = stripQuotedProse(stripComments(readFileSync(new URL('./discovery.ts', import.meta.url), 'utf8')))
  for (const forbidden of ['promoted', 'sponsored', 'boost', 'featured', 'paid', 'bid', 'entitlement']) {
    assert.equal(
      source.toLowerCase().includes(forbidden),
      false,
      `discovery.ts mentions "${forbidden}" in code — the feed is footfall, dwell and recency, and nothing else, forever (23-tessera.md §7.1)`,
    )
  }
  // The stripping is doing something, so this cannot pass vacuously.
  assert.ok(readFileSync(new URL('./discovery.ts', import.meta.url), 'utf8').includes('sponsored'))
})

test('dwell punishes a doorway that tricks people in, and one long session cannot buy a rank', () => {
  const trap = rank({ footfall: 100, medianDwellSeconds: 2, ageDays: 0 })
  const place = rank({ footfall: 100, medianDwellSeconds: 600, ageDays: 0 })
  assert.ok(place > trap, 'dwell is not punishing a doorway that tricks people in')

  // The log is what stops ONE enormous session dominating: 100x the dwell is not 100x the score.
  const long = rank({ footfall: 10, medianDwellSeconds: 60_000, ageDays: 0 })
  const busy = rank({ footfall: 100, medianDwellSeconds: 600, ageDays: 0 })
  assert.ok(busy > long, 'a single long session outranks a busy place')

  // Nobody stays: no engagement, whatever the footfall.
  assert.equal(rank({ footfall: 1_000, medianDwellSeconds: 0, ageDays: 0 }), 0)
  assert.equal(rank({ footfall: 0, medianDwellSeconds: 1_000, ageDays: 0 }), 0)
})

test('recency decays but never reaches zero, so an old, still-visited place stays findable', () => {
  const fresh = rank({ footfall: 10, medianDwellSeconds: 60, ageDays: 0 })
  const month = rank({ footfall: 10, medianDwellSeconds: 60, ageDays: 30 })
  const year = rank({ footfall: 10, medianDwellSeconds: 60, ageDays: 365 })
  assert.ok(fresh > month && month > year)
  assert.ok(year > 0, 'an old place fell off the feed entirely — the reference had dead continents')
  assert.equal(month, fresh / 2, 'the 30-day half-life is not what the code says')
})

/* -------------------------------------------------------------------- against Postgres */

test('footfall is DISTINCT accounts per day — a second visit extends dwell, not the count', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT, CAROL_SUBJECT)
  const parcel = await seedParcel(ward, ALICE_SUBJECT, 0)

  await recordVisit(asDb(sql), { parcelId: parcel, visitorSubject: BOB_SUBJECT, dwellSeconds: 30 })
  await recordVisit(asDb(sql), { parcelId: parcel, visitorSubject: BOB_SUBJECT, dwellSeconds: 45 })
  await recordVisit(asDb(sql), { parcelId: parcel, visitorSubject: CAROL_SUBJECT, dwellSeconds: 10 })

  const rows = await sql<{ visitor_subject: string; dwell_seconds: number }[]>`
    select visitor_subject, dwell_seconds from visits where parcel_id = ${parcel} order by visitor_subject
  `
  assert.equal(rows.length, 2, 'one person visiting twice counted as two bodies')
  assert.equal(rows.find((r) => r.visitor_subject === BOB_SUBJECT)?.dwell_seconds, 75)

  const ranked = await rankParcels(asDb(sql), ward)
  assert.equal(ranked[0]?.inputs.footfall, 2)
})

test('synthetic footfall is unrepresentable — the platform cannot rig its own discovery', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  const parcel = await seedParcel(ward, ALICE_SUBJECT, 0)
  for (const impostor of [
    'engagement:tessera',
    'platform',
    'platform:engagement-treasury',
    'service:tessera',
    'community:abc',
  ]) {
    await assert.rejects(
      () => sql`insert into visits (parcel_id, day, visitor_subject) values (${parcel}, current_date, ${impostor})`,
      (err: unknown) => String(err).includes('tessera_footfall_is_never_synthetic'),
      `a visit by ${impostor} was written — footfall is half the ranking function (23-tessera.md §8.6)`,
    )
  }
})

test('a visit resets the fallow clock, because a visitor IS activity', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, claimed_at)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32, now() - interval '100 days') returning id
  `
  const parcel = rows[0]!.id
  const fallowBefore = await sql<{ n: number }[]>`
    select count(*)::int as n from parcels
     where status = 'held' and tier <> 'homestead'
       and now() >= tessera_fallow_at(last_active_at, banked_until)
  `
  assert.equal(fallowBefore[0]?.n, 1)

  await recordVisit(asDb(sql), { parcelId: parcel, visitorSubject: BOB_SUBJECT, dwellSeconds: 5 })

  const fallowAfter = await sql<{ n: number }[]>`
    select count(*)::int as n from parcels
     where status = 'held' and tier <> 'homestead'
       and now() >= tessera_fallow_at(last_active_at, banked_until)
  `
  assert.equal(fallowAfter[0]?.n, 0, 'somebody walked in and the parcel is still fallow')
})

test('the feed orders by footfall and dwell, and a closed gate is not in it at all', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT, CAROL_SUBJECT)
  const busy = await seedParcel(ward, ALICE_SUBJECT, 0)
  const quiet = await seedParcel(ward, BOB_SUBJECT, 32)
  const shut = await seedParcel(ward, CAROL_SUBJECT, 64)
  await sql`update parcels set gate_open = false where id = ${shut}`

  await recordVisit(asDb(sql), { parcelId: busy, visitorSubject: BOB_SUBJECT, dwellSeconds: 300 })
  await recordVisit(asDb(sql), { parcelId: busy, visitorSubject: CAROL_SUBJECT, dwellSeconds: 400 })
  await recordVisit(asDb(sql), { parcelId: quiet, visitorSubject: BOB_SUBJECT, dwellSeconds: 3 })

  const ranked = await rankParcels(asDb(sql), ward)
  assert.equal(ranked.length, 2, 'a parcel with a shut gate appeared in the feed')
  assert.equal(ranked[0]?.parcelId, busy)
  assert.equal(ranked[1]?.parcelId, quiet)
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0))
  assert.equal(ranked.some((r) => r.parcelId === shut), false)
})

test('a beacon is free, rate-limited to three a week, and no entitlement can raise it', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  const parcel = await seedParcel(ward, ALICE_SUBJECT, 0)
  for (const headline of ['one', 'two', 'three']) {
    await lightBeacon(asDb(sql), parcel, ALICE_SUBJECT, headline)
  }
  await assert.rejects(
    () => lightBeacon(asDb(sql), parcel, ALICE_SUBJECT, 'four'),
    (err: unknown) => String(err).includes('the limit is 3'),
  )
  // Granting every entitlement this title has changes nothing, because the trigger reads none.
  for (const kind of ['kiln_capacity', 'deed_slots', 'appearance', 'private_ward', 'venue_calendar']) {
    await sql`insert into entitlements (subject, kind, sku, entitlement_id)
              values (${ALICE_SUBJECT}, ${kind}, 'x', ${`e-${kind}`})`
  }
  await assert.rejects(
    () => lightBeacon(asDb(sql), parcel, ALICE_SUBJECT, 'four, but paid'),
    (err: unknown) => String(err).includes('the limit is 3'),
    'an entitlement raised the beacon limit — §6.5 says it cannot be raised by paying',
  )
  // A week later it is three again, not four for ever.
  await sql`update beacons set lit_at = now() - interval '8 days' where parcel_id = ${parcel}`
  await lightBeacon(asDb(sql), parcel, ALICE_SUBJECT, 'a new week')
})
