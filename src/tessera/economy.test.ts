/**
 * The economy, and §12's test 4 — six refusals, each asserted as an ABSENCE with force.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * "No SKU grants discovery ranking, a vote, safety, land, object-cap headroom, or a fee or royalty
 * discount. Six absences, each a test. And the converse: every SKU in §7.3 resolves to a
 * deliverable entitlement or billing product, or the suite fails."
 *
 * An absence is the hardest kind of test to write honestly, because the null implementation passes
 * it. So each one below is written the way `admin-web` asserts its missing og card: it names the
 * mechanism through which the thing WOULD be granted, and asserts that mechanism cannot express
 * it — rather than asserting that a string does not appear somewhere.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
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
  seedObject,
  seedWard,
  skip,
  stripComments,
} from './testsupport.ts'
import {
  ENGAGEMENT_ACCOUNT,
  GRANT_ENTRY_KIND,
  bookVenue,
  cancelBooking,
  draftListing,
  findBooking,
  platformTerms,
  settleBooking,
  venueOf,
} from './economy.ts'
import {
  ENGAGEMENT_REF,
  ENGAGEMENT_SUBJECT,
  grantPostings,
  holder,
  objectHolder,
  reservePostings,
  balanceCheck,
} from './ledgerclient.ts'
import { entitlementKindFor } from './inbound.ts'
import { fromSparks } from './sparks.ts'
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

/* --------------------------------------------------- the six refusals, as absences */

/**
 * Refusal 1 — DISCOVERY. §7.1: "no promoted placement, no paid ranking, no sponsored beacons, no
 * boost. The feed is ordered by footfall, dwell and recency, and by nothing else, forever."
 *
 * The mechanism through which a SKU becomes a capability in this service is
 * `entitlements.kind`, a CHECK-constrained closed set, reached only via `entitlementKindFor`. So
 * the absence is checked at BOTH ends: no SKU name maps to it, and the database cannot store it.
 */
test('refusal 1: no SKU grants discovery ranking, and the column could not hold it', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  for (const sku of [
    'tessera.boost.featured',
    'tessera.discovery.promoted',
    'tessera.ranking.boost',
    'tessera.beacon.sponsored',
    'tessera.feed.pinned',
  ]) {
    assert.equal(entitlementKindFor(sku), null, `${sku} maps to an entitlement kind`)
  }
  for (const kind of ['discovery', 'ranking', 'boost', 'promotion', 'featured']) {
    await assert.rejects(
      () => sql`insert into entitlements (subject, kind, sku, entitlement_id)
                values (${ALICE_SUBJECT}, ${kind}, 'x', ${`e-${kind}`})`,
      (err: unknown) => String(err).includes('entitlements_kind_known'),
      `the entitlements table accepted kind='${kind}' — discovery is not for sale, ever`,
    )
  }
})

/** Refusal 2 — VOTES. Governance is `micro-community`, one member one vote, and Tessera must never
 *  wire a token-weighted resolver. There is no weight anywhere in this service to wire one to. */
test('refusal 2: no SKU grants a vote, and this service holds no vote weight at all', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  for (const sku of ['tessera.vote.weighted', 'tessera.governance.seat']) {
    assert.equal(entitlementKindFor(sku), null)
  }
  for (const kind of ['vote_weight', 'vote', 'governance']) {
    await assert.rejects(
      () => sql`insert into entitlements (subject, kind, sku, entitlement_id)
                values (${ALICE_SUBJECT}, ${kind}, 'x', ${`e-${kind}`})`,
      (err: unknown) => String(err).includes('entitlements_kind_known'),
    )
  }
  // And no column in this schema stores a weight, so there is nothing for a resolver to read.
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
     where table_schema = 'public' and (column_name like '%weight%' or column_name like '%vote%')
  `
  // `.length`, not `deepEqual([], …)`: postgres.js returns an array-like carrying `count` and
  // `command`, so a deep-equal against a bare array fails even when there are no rows — which
  // would have made this test red for a reason that has nothing to do with vote weights, and
  // would have been "fixed" by weakening it.
  assert.equal(
    columns.length,
    0,
    `a vote weight column exists — §7.1 refusal 2: ${columns.map((c) => `${c.table_name}.${c.column_name}`).join(', ')}`,
  )
})

/** Refusal 3 — SAFETY. "A safety feature behind a paywall is a protection racket with a price list." */
test('refusal 3: no SKU grants safety, privacy or moderation', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  for (const sku of ['tessera.safety.premium', 'tessera.privacy.enhanced', 'tessera.moderation.priority']) {
    assert.equal(entitlementKindFor(sku), null)
  }
  for (const kind of ['safety', 'privacy', 'moderation', 'ban_immunity']) {
    await assert.rejects(
      () => sql`insert into entitlements (subject, kind, sku, entitlement_id)
                values (${ALICE_SUBJECT}, ${kind}, 'x', ${`e-${kind}`})`,
      (err: unknown) => String(err).includes('entitlements_kind_known'),
    )
  }
})

/** Refusal 4 — LAND. The platform never sells it. There is no `land` entitlement, and `claimParcel`
 *  cannot reach money at all — asserted separately in `world.test.ts`. */
test('refusal 4: no SKU grants land, at any tier, ever', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  for (const sku of ['tessera.land.plot', 'tessera.parcel.premium', 'tessera.ward.quarter']) {
    assert.equal(entitlementKindFor(sku), null)
  }
  for (const kind of ['land', 'parcel', 'ground']) {
    await assert.rejects(
      () => sql`insert into entitlements (subject, kind, sku, entitlement_id)
                values (${ALICE_SUBJECT}, ${kind}, 'x', ${`e-${kind}`})`,
      (err: unknown) => String(err).includes('entitlements_kind_known'),
    )
  }
})

/**
 * Refusal 5 — OBJECT-CAP HEADROOM. §6.2: "it is a rendering budget, it is stated as one, and it is
 * not purchasable at any price."
 *
 * The strongest possible form: `object_cap` is a GENERATED column, so there is no UPDATE that can
 * raise it. Not "no route does"; no STATEMENT does. `world.test.ts` proves the write is refused;
 * this proves no SKU could ask for it either.
 */
test('refusal 5: no SKU grants object-cap headroom, and the column is not writable', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  for (const sku of ['tessera.objects.more', 'tessera.cap.raise', 'tessera.prims.extra']) {
    assert.equal(entitlementKindFor(sku), null)
  }
  const generated = await sql<{ is_generated: string }[]>`
    select is_generated from information_schema.columns
     where table_name = 'parcels' and column_name = 'object_cap'
  `
  assert.equal(generated[0]?.is_generated, 'ALWAYS', 'object_cap stopped being generated')
})

/**
 * Refusal 6 — A FEE OR ROYALTY DISCOUNT. §7.2's fifth refusal, which is the condition the whole
 * no-pay-to-win argument rests on: "A subscription that cut your marketplace fee would convert
 * money directly into structural earning advantage over every creator who did not buy it."
 *
 * Three ways it is impossible: no SKU maps to it; `platformTerms` takes no subject, so there is no
 * per-account rate to return; and the trigger refuses a listing whose fee differs from the one row.
 */
test('refusal 6: no fee or royalty discount, and the rate is the same for every account', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  for (const sku of ['tessera.fee.discount', 'tessera.pro.subscription', 'tessera.royalty.reduced']) {
    assert.equal(entitlementKindFor(sku), null)
  }

  // `platformTerms(sql)` — ONE argument. A per-account rate would need a parameter here before it
  // needed a column anywhere, so the arity IS the refusal.
  assert.equal(platformTerms.length, 1, 'platformTerms takes a second argument — a per-account rate')

  const terms = await platformTerms(asDb(sql))
  assert.equal(terms.platformFeeBps, 250)
  assert.equal(terms.maxRoyaltyBps, 1_000)

  const object = await seedObject(sql, ALICE_SUBJECT)
  // A listing that took a cheaper fee is refused by the trigger, whatever wrote it.
  await assert.rejects(
    () => sql`insert into listings (object_id, seller_subject, price_wei, royalty_bps, platform_fee_bps)
              values (${object}, ${ALICE_SUBJECT}, ${fromSparks(400n).toString()}::numeric, 500, 100)`,
    (err: unknown) => String(err).includes('the rate is identical for every account'),
  )
  // And a royalty above the cap.
  await assert.rejects(
    () => sql`insert into listings (object_id, seller_subject, price_wei, royalty_bps, platform_fee_bps)
              values (${object}, ${ALICE_SUBJECT}, ${fromSparks(400n).toString()}::numeric, 1001, 250)`,
    (err: unknown) => String(err).includes('the cap is identical for every account'),
  )
  // Two sellers, two listings, one rate.
  const listingA = await draftListing(asDb(sql), {
    objectId: object,
    sellerSubject: ALICE_SUBJECT,
    priceWei: fromSparks(400n),
    royaltyBps: 500,
    correlationId: 'r',
  })
  const objectB = await seedObject(sql, BOB_SUBJECT, 2)
  const listingB = await draftListing(asDb(sql), {
    objectId: objectB,
    sellerSubject: BOB_SUBJECT,
    priceWei: fromSparks(400n),
    royaltyBps: 500,
    correlationId: 'r',
  })
  assert.equal(listingA.platformFeeBps, listingB.platformFeeBps)
})

/**
 * The CONVERSE §12 asks for: "every SKU in §7.3 resolves to a deliverable entitlement or billing
 * product, or the suite fails."
 *
 * Principle 3 of `01-product-vision.md`. A SKU that is sold and cannot be delivered is worse than
 * one that does not exist.
 */
test('every SKU in §7.3 resolves to a deliverable entitlement kind', () => {
  const skus: ReadonlyArray<readonly [string, string]> = [
    ['tessera.kiln.pack10', 'kiln_capacity'],
    ['tessera.deed.slot', 'deed_slots'],
    ['tessera.appearance.gouache', 'appearance'],
    ['tessera.name.reserve', 'name_reservation'],
    // Already exists in billing/src/migrations.ts and no title serves it today.
    ['world.private.small', 'private_ward'],
    ['tessera.venue.calendar', 'venue_calendar'],
  ]
  assert.equal(skus.length, 6, '§7.3 lists six SKUs')
  for (const [sku, kind] of skus) {
    assert.equal(entitlementKindFor(sku), kind, `${sku} does not resolve to a deliverable kind`)
  }
})

/* ------------------------------------------------------- the ledger, and the empty reserve */

test('the engagement account is engagement:tessera / EMBER / treasury, typed equity', () => {
  // The spelling comes from the contract, and the TYPE is the safety property:
  // `ledger_assert_no_overdraft` exempts clearing and suspense, not equity. A second spelling
  // silently splits the programme's ledger in half — the defect foresight shipped.
  assert.equal(ENGAGEMENT_ACCOUNT.subject, 'engagement:tessera')
  assert.equal(ENGAGEMENT_ACCOUNT.assetCode, 'EMBER')
  assert.equal(ENGAGEMENT_ACCOUNT.purpose, 'treasury')
  assert.equal(ENGAGEMENT_REF.type, 'equity')
  assert.equal(GRANT_ENTRY_KIND, 'treasury_spend')

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // AND `ENGAGEMENT_REF` IS STILL FIELD-FOR-FIELD THE CONTRACT'S ACCOUNT.
  //
  // It used to be three property reads off `ENGAGEMENT_ACCOUNT`, which made drift impossible by
  // construction and made the account unreadable to micro-conformance's `ledger-accounts` sweep —
  // the check that reconciles the type every service claims per key, and the only thing in the
  // estate that would catch a second service typing `engagement:tessera` differently. It is now
  // written out so the sweep can compare it. THIS is what replaces the derivation: if anyone
  // changes the contract's `engagementAccount`, or retypes this literal, these four fail.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  assert.equal(ENGAGEMENT_REF.subject, ENGAGEMENT_ACCOUNT.subject)
  assert.equal(ENGAGEMENT_REF.assetCode, ENGAGEMENT_ACCOUNT.assetCode)
  assert.equal(ENGAGEMENT_REF.purpose, ENGAGEMENT_ACCOUNT.purpose)
  assert.equal(ENGAGEMENT_SUBJECT, ENGAGEMENT_ACCOUNT.subject)
})

/**
 * The refusal that replaced a silent pass-through.
 *
 * `holder` used to canonicalise a `user:` subject and return anything else UNCHANGED, so
 * `holder('alice', …)` produced an account keyed on the subject `alice` — not a user account, not
 * any kind `AccountSubject` names, and reconcilable with nothing. Tessera's `accounts` table
 * admits no such subject (`accounts_subject_is_a_user`, migrations.ts) and every subject
 * column is a foreign key into it, so this path was already unreachable from the database; the
 * throw is that guarantee said out loud rather than assumed.
 */
test('an account subject that is not a user is refused, not passed through', () => {
  assert.throws(() => holder('alice', 'available'), /not a user subject/)
  assert.throws(() => holder('platform', 'available'), /not a user subject/)
  assert.throws(() => objectHolder('community:x', 'TOKEN:cf:tessera:object:ff'), /not a user subject/)
  // The legitimate one still works, and still comes out spelled by the contract.
  assert.equal(holder(ALICE_SUBJECT, 'available').subject, ALICE_SUBJECT)
  assert.equal(holder(ALICE_SUBJECT, 'reserved').purpose, 'reserved')
})

test('a grant debits the engagement account and balances, and the postings are the wire shape', () => {
  const postings = grantPostings(ALICE_SUBJECT, fromSparks(400n))
  assert.equal(postings.length, 2)
  const debit = postings.find((p) => p.direction === 'debit')
  assert.equal(debit?.account.subject, 'engagement:tessera')
  // equity, so an unfunded grant is refused at the DATABASE rather than by a handler that forgot
  // to look. This is the whole of "chain-backed by construction", in one field.
  assert.equal(debit?.account.type, 'equity')
  const credit = postings.find((p) => p.direction === 'credit')
  assert.equal(credit?.account.subject, ALICE_SUBJECT)
  assert.equal(credit?.account.purpose, 'available')
  assert.equal(credit?.account.type, 'liability')
  // Balanced before the socket opens — this throws if it is not.
  balanceCheck(postings)
})

/**
 * §8.2, asserted about the WHOLE REPOSITORY rather than about one call site.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS TEST USED TO REQUIRE EXACTLY ONE `payout_due` DEBIT. IT NOW REQUIRES NONE, AND THAT IS A
 * CORRECTION RATHER THAN A RELAXATION.**
 *
 * The one debit it allowed was `releasePostings`, which had zero callers. Reading micro-market's
 * source rather than the design prose showed why it should never gain one:
 *
 *   * market credits the SELLER's `payout_due` at settlement (`market/src/orders.ts`),
 *     and
 *   * market RELEASES it to `available` when the dispute window has run — `releaseProceeds`
 *     (`orders.ts`) driven by a leased job (`market/src/jobs.ts`, `PAYOUT_KIND`).
 *
 * So a Tessera release would be a second service moving one payout. The ledger would refuse it —
 * a user's `payout_due` is `liability`, which `ledger_assert_no_overdraft` does not exempt — but
 * "the database catches it" is not a reason to keep code whose only correct number of calls is
 * zero. Tessera's money is engagement grants and booking reservations; sale proceeds are market's.
 *
 * Written as a scan over every source file because "Tessera never releases a payout" is a claim
 * about the repository, and no single call site can make it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('Tessera never debits payout_due — releasing a creator\'s proceeds is micro-market\'s job', () => {
  const dir = new URL('.', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  assert.ok(files.length > 8, 'no sources were scanned; this check is grading nothing')
  const sites: string[] = []
  for (const file of files) {
    const source = stripComments(readFileSync(new URL(file, dir), 'utf8'))
    // A debit against payout_due looks like `holder(x, PAYOUT_DUE), direction: 'debit'`.
    const pattern = /PAYOUT_DUE\s*\)\s*,\s*direction:\s*'debit'/g
    for (const _ of source.matchAll(pattern)) sites.push(file)
  }
  assert.deepEqual(sites, [], 'Tessera debits payout_due somewhere — that is micro-market paying twice')

  // And the function itself is gone, not merely uncalled. An exported `releasePayout` with no
  // callers is an invitation; the absence is the guard.
  const ledgerSource = stripComments(
    readFileSync(new URL('./ledgerclient.ts', import.meta.url), 'utf8'),
  )
  assert.ok(!/export\s+(async\s+)?function\s+releasePayout\b/.test(ledgerSource))
  assert.ok(!/export\s+function\s+releasePostings\b/.test(ledgerSource))
})

test('a reservation is a posting from available to reserved — two accounts, not two columns', () => {
  const postings = reservePostings(ALICE_SUBJECT, 500n)
  assert.equal(postings[0]?.account.purpose, 'available')
  assert.equal(postings[0]?.direction, 'debit')
  assert.equal(postings[1]?.account.purpose, 'reserved')
  assert.equal(postings[1]?.direction, 'credit')
  balanceCheck(postings)
})

/* ------------------------------------------------------------------ listings and bookings */

test('a Tessera listing is always custodial, because that is the only mode with a royalty', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await seedObject(sql, ALICE_SUBJECT)
  await assert.rejects(
    () => sql`insert into listings (object_id, seller_subject, price_wei, royalty_bps, platform_fee_bps, settlement_mode)
              values (${object}, ${ALICE_SUBJECT}, ${fromSparks(400n).toString()}::numeric, 500, 250, 'onchain')`,
    (err: unknown) => String(err).includes('tessera_listings_are_custodial'),
  )
  const listing = await draftListing(asDb(sql), {
    objectId: object,
    sellerSubject: ALICE_SUBJECT,
    priceWei: fromSparks(400n),
    royaltyBps: 500,
    correlationId: 'r',
  })
  assert.equal(listing.settlementMode, 'custodial')
  // And the split the seller is shown partitions the price exactly.
  assert.equal(
    listing.split.feeWei + listing.split.royaltyWei + listing.split.proceedsWei,
    listing.priceWei,
  )
})

test('a price finer than one Spark is refused by the CHECK and by the handler', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await seedObject(sql, ALICE_SUBJECT)
  await assert.rejects(
    () => sql`insert into listings (object_id, seller_subject, price_wei, royalty_bps, platform_fee_bps)
              values (${object}, ${ALICE_SUBJECT}, 400000000001, 500, 250)`,
    (err: unknown) => String(err).includes('tessera_price_whole_sparks'),
  )
  await assert.rejects(
    () =>
      draftListing(asDb(sql), {
        objectId: object,
        sellerSubject: ALICE_SUBJECT,
        priceWei: 400_000_000_001n,
        royaltyBps: 500,
        correlationId: 'r',
      }),
    (err: unknown) => err instanceof WorldError && err.code === 'price_not_whole_sparks',
  )
})

test('a venue booking needs a venue, a posted rate, an escrow hold, and a free span', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT, CAROL_SUBJECT)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32) returning id
  `
  const parcelId = rows[0]!.id
  const slot = new Date('2027-01-01T18:00:00.000Z')
  const rate = fromSparks(5_000n)

  await assert.rejects(
    () =>
      bookVenue(asDb(sql), {
        parcelId,
        slot,
        hours: 1,
        bookedBy: BOB_SUBJECT,
        escrowedWei: rate,
        reservationId: 'res-1',
        correlationId: 'r',
      }),
    (err: unknown) => err instanceof WorldError && err.code === 'not_a_venue',
  )

  await sql`update parcels set is_venue = true, venue_rate_wei = ${rate.toString()}::numeric
             where id = ${parcelId}`
  const booked = await bookVenue(asDb(sql), {
    parcelId,
    slot,
    hours: 1,
    bookedBy: BOB_SUBJECT,
    escrowedWei: rate,
    reservationId: 'res-1',
    correlationId: 'r',
  })
  assert.ok(booked.bookingId)

  // The same slot again is refused.
  await assert.rejects(
    () =>
      bookVenue(asDb(sql), {
        parcelId,
        slot,
        hours: 1,
        bookedBy: CAROL_SUBJECT,
        escrowedWei: rate,
        reservationId: 'res-2',
        correlationId: 'r',
      }),
    (err: unknown) => err instanceof WorldError && err.code === 'slot_taken',
  )

  // A free hold is unrepresentable, so nobody can squat a calendar for nothing. The price is
  // POSITIVE here and the row is still refused: this asserts the hold, not the price — the two
  // used to be one test because a zero price satisfied `price_wei >= 0`, and now cannot be.
  await assert.rejects(
    () => sql`insert into bookings (parcel_id, slot, booked_by, price_wei)
              values (${parcelId}, ${new Date('2027-01-02T18:00:00.000Z')}, ${BOB_SUBJECT},
                      ${rate.toString()}::numeric)`,
    (err: unknown) => String(err).includes('bookings_open_holds_money'),
  )

  // And the event is keyed by the PARCEL, not the booking. §11.2.
  const events = await sql<{ key: string; payload: Record<string, unknown> }[]>`
    select key, payload from outbox where topic = 'tessera.venue.booked'
  `
  assert.equal(events.length, 1)
  assert.equal(events[0]?.key, parcelId)
  assert.notEqual(events[0]?.key, booked.bookingId)

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // THE PAYLOAD NAMES THE OWNER, AND THAT IS THE ONLY REASON A NOTIFY RULE CAN EXIST.
  //
  // `notify/src/topics.ts` records this topic `blockedBy: 'no-subject'`. The payload named
  // the BOOKER, so the party whose venue was taken and whose money is on the other end of
  // `reservationId` was absent — a rule on it answers `no_recipient` for ever, or tells Bob about
  // Bob's own booking.
  //
  // Asserted as a DIFFERENCE, not just presence: Alice owns, Bob books, and a payload that
  // derived the owner from the actor would pass a `typeof === 'string'` check and be wrong.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  assert.equal(events[0]?.payload['ownerSubject'], ALICE_SUBJECT)
  assert.equal(events[0]?.payload['bookedBy'], BOB_SUBJECT)
  assert.notEqual(
    events[0]?.payload['ownerSubject'],
    events[0]?.payload['bookedBy'],
    'the owner was derived from the actor rather than read from the parcel',
  )
  assert.equal(events[0]?.payload['wardId'], ward)
  // The OWNER's number reached the bus, not the caller's — `escrowedWei` is only ever checked.
  assert.equal(events[0]?.payload['priceWei'], rate.toString())
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE VENUE BOOKING LIFECYCLE, AND THE ONE THING IT HAS TO PROVE.
 *
 * `bookings.status` has admitted `open | settled | cancelled` since migration 6 and only the
 * `open` insert existed, so a booking could be opened and never closed — **the booker's EMBER
 * sitting in `reserved` for ever, with no statement in this service able to move it.** That is
 * what held the emitter back and it is what these tests are about.
 *
 * The assertion that matters is not "a row exists". It is **reserved goes up, and then comes back
 * to zero, on EVERY path out of `open`** — asserted at both ends, because a test that only checked
 * the zero at the end would pass against a ledger that never reserved anything, which is this
 * estate's recurring defect: a check that cannot fail.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A double-entry ledger, small enough to read in one sitting and strict enough to fail.
 *
 * NOT a stub that returns ids. Every rule below is one micro-ledger actually enforces, cited, and
 * every one of them can refuse this service:
 *
 *   * **Two accounts, not two columns.** A reservation is a posting pair `available → reserved`
 *     (`ledger/src/entries.ts`, `contracts-money`'s `reservePostings`), so "how much is
 *     reserved" is a balance here exactly as it is there — nothing in this double tracks holds in
 *     a set on the side, which is the shape that would make the zero at the end meaningless.
 *   * **No overdraft.** A user's accounts are `liability` and `ledger_assert_no_overdraft` does
 *     not exempt those (`ledger/src/migrations.ts`), so a balance that would go
 *     negative throws rather than going negative.
 *   * **Release is full, once, and reversing.** `ledger/src/entries.ts` — the second release
 *     of one reservation is `AlreadyReleasedError`, which is what makes a double-release a red
 *     test rather than free money.
 *   * **Idempotency is by key, and a replay returns the SAME entry.** `withIdempotency`
 *     (`ledger/src/entries.ts`). `closeBooking` derives its keys from the booking id
 *     precisely so a retry replays, and this is where that is checked.
 */
function ledgerDouble() {
  const balances = new Map<string, bigint>()
  const replies = new Map<string, { id: string; replayed: boolean }>()
  const reservations = new Map<string, { subject: string; amountWei: bigint }>()
  const released = new Set<string>()
  const posted: Array<{ id: string; kind: string; legs: string }> = []
  let seq = 0

  const key = (subject: string, purpose: string) => `${subject}/${purpose}`
  const read = (subject: string, purpose: string) => balances.get(key(subject, purpose)) ?? 0n
  const move = (subject: string, purpose: string, delta: bigint) => {
    const next = read(subject, purpose) + delta
    if (next < 0n) {
      throw new Error(
        `${key(subject, purpose)} would go to -${-next}: a liability account may not go negative`,
      )
    }
    balances.set(key(subject, purpose), next)
  }

  return {
    /** The only way money enters this world, so every figure below came from somewhere. */
    fund(subject: string, amountWei: bigint) {
      move(subject, 'available', amountWei)
    },
    available: (subject: string) => read(subject, 'available'),
    reserved: (subject: string) => read(subject, 'reserved'),
    entries: () => posted,

    async reserve(request: {
      subject: string
      amountWei: bigint
      idempotencyKey: string
    }): Promise<{ reservationId: string; replayed: boolean }> {
      const seen = replies.get(request.idempotencyKey)
      if (seen) return { reservationId: seen.id, replayed: true }
      if (request.amountWei <= 0n) throw new Error('reservation amount must be positive')
      move(request.subject, 'available', -request.amountWei)
      move(request.subject, 'reserved', request.amountWei)
      const id = `res-${(seq += 1)}`
      reservations.set(id, { subject: request.subject, amountWei: request.amountWei })
      replies.set(request.idempotencyKey, { id, replayed: false })
      posted.push({ id, kind: 'reserve', legs: `${request.subject}: available→reserved` })
      return { reservationId: id, replayed: false }
    },

    async release(
      reservationId: string,
      request: { idempotencyKey: string },
    ): Promise<{ id: string; replayed: boolean }> {
      const seen = replies.get(request.idempotencyKey)
      if (seen) return { id: seen.id, replayed: true }
      const held = reservations.get(reservationId)
      if (!held) throw new Error(`no reservation ${reservationId}`)
      if (released.has(reservationId)) {
        throw new Error(`reservation ${reservationId} was already released by entry rel-${reservationId}`)
      }
      released.add(reservationId)
      move(held.subject, 'reserved', -held.amountWei)
      move(held.subject, 'available', held.amountWei)
      const id = `rel-${(seq += 1)}`
      replies.set(request.idempotencyKey, { id, replayed: false })
      posted.push({ id, kind: 'release', legs: `${held.subject}: reserved→available` })
      return { id, replayed: false }
    },

    async payBookingFee(request: {
      bookerSubject: string
      ownerSubject: string
      amountWei: bigint
      idempotencyKey: string
    }): Promise<{ id: string; replayed: boolean }> {
      const seen = replies.get(request.idempotencyKey)
      if (seen) return { id: seen.id, replayed: true }
      move(request.bookerSubject, 'available', -request.amountWei)
      move(request.ownerSubject, 'available', request.amountWei)
      const id = `fee-${(seq += 1)}`
      replies.set(request.idempotencyKey, { id, replayed: false })
      posted.push({
        id,
        kind: 'fee',
        legs: `${request.bookerSubject}→${request.ownerSubject}: available`,
      })
      return { id, replayed: false }
    },
  }
}

const HOUR = 3_600_000

/** Alice owns a Venue at `rate` per hour; Bob is funded and books it. Returns the ids. */
async function seedVenue(
  ledger: ReturnType<typeof ledgerDouble>,
  rate: bigint,
  hours = 1,
  slot = new Date('2027-03-01T18:00:00.000Z'),
): Promise<{ parcelId: string; bookingId: string; priceWei: bigint }> {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, is_venue, venue_rate_wei)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32, true, ${rate.toString()}::numeric)
    returning id
  `
  const parcelId = rows[0]!.id

  // The route's own order: read the owner's rate, escrow THAT, then write the booking.
  const venue = await venueOf(asDb(sql), parcelId)
  assert.ok(venue, 'the parcel posts a rate, so it is a Venue')
  const priceWei = venue.rateWei * BigInt(hours)
  ledger.fund(BOB_SUBJECT, priceWei)

  const hold = await ledger.reserve({
    subject: BOB_SUBJECT,
    amountWei: priceWei,
    idempotencyKey: `hold-${parcelId}-${slot.toISOString()}`,
  })
  const { bookingId } = await bookVenue(asDb(sql), {
    parcelId,
    slot,
    hours,
    bookedBy: BOB_SUBJECT,
    escrowedWei: priceWei,
    reservationId: hold.reservationId,
    correlationId: 'r',
  })
  return { parcelId, bookingId, priceWei }
}

test('settling a booking returns reserved to zero and pays the Venue owner', { skip }, async () => {
  const ledger = ledgerDouble()
  const rate = fromSparks(4_000n)
  const { bookingId, priceWei } = await seedVenue(ledger, rate, 3)

  // ── THE HOLD IS REAL BEFORE IT IS RELEASED ────────────────────────────────────────────────
  // Asserted first and deliberately: a suite that only checked the zero at the end would be green
  // against a ledger that never reserved anything, and green is exactly what this defect looked
  // like for as long as it existed.
  assert.equal(ledger.reserved(BOB_SUBJECT), priceWei)
  assert.equal(ledger.available(BOB_SUBJECT), 0n)
  assert.equal(priceWei, rate * 3n, 'three hours at the posted rate')

  const settled = await settleBooking(asDb(sql), ledger, {
    bookingId,
    actor: `user:${ALICE_SUBJECT.slice('user:'.length)}`,
    correlationId: 'r',
  })

  assert.equal(settled.status, 'settled')
  assert.equal(ledger.reserved(BOB_SUBJECT), 0n, 'THE MONEY LEFT `reserved`')
  assert.equal(ledger.available(BOB_SUBJECT), 0n, 'and it did not come back to the booker')
  assert.equal(ledger.available(ALICE_SUBJECT), priceWei, 'the owner earned the fee — §8.4')

  // Both ids are on the row, which is what `bookings_terminal_frees_the_money` and
  // `bookings_settled_pays_the_owner` make non-optional.
  assert.ok(settled.releasedEntryId)
  assert.ok(settled.settledEntryId)
  assert.ok(settled.closedAt)
  assert.deepEqual(
    ledger.entries().map((e) => e.kind),
    ['reserve', 'release', 'fee'],
  )
})

test('cancelling a booking returns reserved to zero and pays nobody', { skip }, async () => {
  const ledger = ledgerDouble()
  const rate = fromSparks(4_000n)
  const { bookingId, priceWei } = await seedVenue(ledger, rate)

  assert.equal(ledger.reserved(BOB_SUBJECT), priceWei)

  const cancelled = await cancelBooking(asDb(sql), ledger, {
    bookingId,
    actor: `user:${BOB_SUBJECT.slice('user:'.length)}`,
    correlationId: 'r',
  })

  assert.equal(cancelled.status, 'cancelled')
  assert.equal(ledger.reserved(BOB_SUBJECT), 0n, 'THE MONEY LEFT `reserved`')
  assert.equal(ledger.available(BOB_SUBJECT), priceWei, 'and the booker has it back, in full')
  assert.equal(ledger.available(ALICE_SUBJECT), 0n, 'a cancelled hour is not a paid hour')
  assert.ok(cancelled.releasedEntryId)
  assert.equal(cancelled.settledEntryId, null, 'nothing was paid, so nothing is named')
  assert.deepEqual(
    ledger.entries().map((e) => e.kind),
    ['reserve', 'release'],
  )
})

test('a terminal booking that did not free the money has no representation', { skip }, async () => {
  const ledger = ledgerDouble()
  const { bookingId } = await seedVenue(ledger, fromSparks(4_000n))

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // THE STRANDING PATH, DRIVEN AT THE DATABASE WITH NO HANDLER IN THE PICTURE.
  //
  // `closeBooking` is careful. This asserts the guarantee does not DEPEND on it being careful: a
  // raw UPDATE — a backfill, a second replica, an operator at a psql prompt, the next function
  // somebody writes — cannot move a booking out of `open` without naming the entry that released
  // the hold. "Refused" and "unrepresentable" are different guarantees and only the second one
  // survives a bug, which is the argument `tessera_one_homestead` already makes in migration 4.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  await assert.rejects(
    () => sql`update bookings set status = 'cancelled', closed_at = now() where id = ${bookingId}`,
    (err: unknown) => String(err).includes('bookings_terminal_frees_the_money'),
  )
  // `settled` without a release trips the same rule. Asserted as EITHER name, because two CHECKs
  // apply to this row and Postgres does not promise which one it evaluates first — pinning the
  // name here would be a test of the planner rather than of the schema.
  await assert.rejects(
    () => sql`update bookings set status = 'settled', closed_at = now() where id = ${bookingId}`,
    (err: unknown) =>
      String(err).includes('bookings_terminal_frees_the_money') ||
      String(err).includes('bookings_settled_pays_the_owner'),
  )

  // Released but unpaid is refused too — a settled hour the owner hosted for nothing.
  await assert.rejects(
    () => sql`update bookings set status = 'settled', closed_at = now(),
                     released_entry_id = 'rel-x' where id = ${bookingId}`,
    (err: unknown) => String(err).includes('bookings_settled_pays_the_owner'),
  )

  // And a closed booking is dated, in both directions.
  await assert.rejects(
    () => sql`update bookings set status = 'cancelled', released_entry_id = 'rel-x'
               where id = ${bookingId}`,
    (err: unknown) => String(err).includes('bookings_terminal_is_dated'),
  )

  // The booking is untouched by all four, and the money is still held.
  const still = await findBooking(asDb(sql), bookingId)
  assert.equal(still?.status, 'open')
  assert.equal(ledger.reserved(BOB_SUBJECT), fromSparks(4_000n))
})

test('a booking closes once, and the second attempt moves no money', { skip }, async () => {
  const ledger = ledgerDouble()
  const { bookingId, priceWei } = await seedVenue(ledger, fromSparks(4_000n))
  const actor = `user:${ALICE_SUBJECT.slice('user:'.length)}` as const

  await settleBooking(asDb(sql), ledger, { bookingId, actor, correlationId: 'r' })
  const after = ledger.entries().length

  // A second settle, and a cancel of the same booking, are both refused BEFORE the ledger is
  // touched — `already_closed`, off the `for update` read. Without this the release would be a
  // second release (the double's `AlreadyReleasedError`, micro-ledger's own rule) and the fee a
  // second payment.
  for (const close of [settleBooking, cancelBooking]) {
    await assert.rejects(
      () => close(asDb(sql), ledger, { bookingId, actor, correlationId: 'r' }),
      (err: unknown) => err instanceof WorldError && err.code === 'already_closed',
    )
  }
  assert.equal(ledger.entries().length, after, 'no ledger entry was written by a refused close')
  assert.equal(ledger.reserved(BOB_SUBJECT), 0n)
  assert.equal(ledger.available(ALICE_SUBJECT), priceWei, 'the owner was paid once, not twice')

  // And the database refuses the same thing from underneath: a closed booking does not reopen.
  await assert.rejects(
    () => sql`update bookings set status = 'open', closed_at = null where id = ${bookingId}`,
    (err: unknown) => String(err).includes('bookings_terms_are_written_once'),
  )
})

test('a zero-price hold on somebody elses calendar is unrepresentable', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const rate = fromSparks(4_000n)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, is_venue, venue_rate_wei)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32, true, ${rate.toString()}::numeric)
    returning id
  `
  const parcelId = rows[0]!.id
  const slot = new Date('2027-04-01T09:00:00.000Z')

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // FOUR STATEMENTS, FOUR REFUSALS, NO HANDLER. The old rule was
  // `tessera_booking_price_not_negative check (price_wei >= 0)` and every one of these was legal
  // under it.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  // 1. A free booking, priced zero outright. The TRIGGER names it, because a BEFORE ROW trigger
  //    runs ahead of a table's CHECK constraints — and it names the number that should have been
  //    there, which a bare `> 0` could not.
  await assert.rejects(
    () => sql`insert into bookings (parcel_id, slot, booked_by, price_wei, reservation_id)
              values (${parcelId}, ${slot}, ${BOB_SUBJECT}, 0, 'res-x')`,
    (err: unknown) => String(err).includes('bookings_price_is_the_owners_rate'),
  )

  // 1b. AND THE SAME ROW IS REFUSED WITH THE TRIGGER SWITCHED OFF.
  //
  //     This is the whole difference between "refused" and "unrepresentable", and it is why
  //     `tessera_booking_price_is_positive` exists beside a trigger that is strictly stronger:
  //     triggers can be disabled, by exactly the operator-with-a-psql-prompt the parcel
  //     constraints in migration 4 are written against. A CHECK cannot. Rolled back, so nothing
  //     that follows runs against a table with its triggers off.
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await tx`alter table bookings disable trigger user`
        // `during` is spelled out because the trigger that derives it is one of the ones just
        // switched off, and its NOT NULL would otherwise be what refused this row — a different
        // rule answering a question about price.
        await tx`insert into bookings (parcel_id, slot, during, booked_by, price_wei, reservation_id)
                 values (${parcelId}, ${slot},
                         tstzrange(${slot}, ${slot} + interval '1 hour', '[)'),
                         ${BOB_SUBJECT}, 0, 'res-x')`
      }),
    (err: unknown) => String(err).includes('tessera_booking_price_is_positive'),
  )

  // 2. A booking priced at anything other than the owner's posted rate — including a single Spark,
  //    which is the version of this defect a `> 0` check on its own would have let through.
  await assert.rejects(
    () => sql`insert into bookings (parcel_id, slot, booked_by, price_wei, reservation_id)
              values (${parcelId}, ${slot}, ${BOB_SUBJECT},
                      ${fromSparks(1n).toString()}::numeric, 'res-x')`,
    (err: unknown) => String(err).includes('bookings_price_is_the_owners_rate'),
  )

  // 3. The rate itself cannot be zero, so there is no arithmetic that reaches a free hold.
  await assert.rejects(
    () => sql`update parcels set venue_rate_wei = 0 where id = ${parcelId}`,
    (err: unknown) => String(err).includes('tessera_venue_rate_is_positive'),
  )

  // 4. And a Venue cannot exist without one. This is the constraint that closes the loop: before
  //    it, `is_venue` was a boolean with no rate beside it anywhere in the schema.
  await assert.rejects(
    () => sql`update parcels set venue_rate_wei = null where id = ${parcelId}`,
    (err: unknown) => String(err).includes('tessera_a_venue_posts_a_rate'),
  )

  // The legal booking, for contrast — so this test fails if the rules refuse everything.
  await sql`insert into bookings (parcel_id, slot, booked_by, price_wei, reservation_id)
            values (${parcelId}, ${slot}, ${BOB_SUBJECT}, ${rate.toString()}::numeric, 'res-ok')`

  // And it cannot be repriced afterwards, which is what makes the insert-time check a guarantee
  // rather than a formality — the price trigger is INSERT-only on purpose, so without this an
  // UPDATE would have rewritten an agreed price to any other number.
  for (const price of ['0', fromSparks(1n).toString()]) {
    await assert.rejects(
      () => sql`update bookings set price_wei = ${price}::numeric where parcel_id = ${parcelId}`,
      (err: unknown) => String(err).includes('bookings_terms_are_written_once'),
    )
  }
})

test('two bookings may not overlap, which the unique index alone would not have caught', { skip }, async () => {
  const ledger = ledgerDouble()
  const rate = fromSparks(4_000n)
  const at14 = new Date('2027-05-01T14:00:00.000Z')
  const { parcelId } = await seedVenue(ledger, rate, 3, at14)

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 14:00–17:00 IS TAKEN. 15:00–16:00 IS A DIFFERENT `slot` AND THE SAME ROOM.
  //
  // `tessera_one_open_booking` is `unique (parcel_id, slot) where status = 'open'`, and these two
  // rows have DIFFERENT slots — it lets this through. The GiST exclusion constraint is what
  // refuses it, the same instrument `tessera_parcels_do_not_overlap` uses for ground.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const at15 = new Date('2027-05-01T15:00:00.000Z')
  ledger.fund(CAROL_SUBJECT, rate)
  await seedAccounts(sql, CAROL_SUBJECT)
  await assert.rejects(
    () =>
      bookVenue(asDb(sql), {
        parcelId,
        slot: at15,
        hours: 1,
        bookedBy: CAROL_SUBJECT,
        escrowedWei: rate,
        reservationId: 'res-carol',
        correlationId: 'r',
      }),
    (err: unknown) => err instanceof WorldError && err.code === 'slot_taken',
  )

  // Proof the unique index could not have been what refused it: the two keys differ.
  assert.notEqual(at14.toISOString(), at15.toISOString())

  // Back to back is not overlapping — `[)`, the same half-open bound the parcel ranges use. A
  // calendar that refused 17:00 after a booking ending at 17:00 would waste half of every day.
  const at17 = new Date(at14.getTime() + 3 * HOUR)
  ledger.fund(CAROL_SUBJECT, rate)
  const adjacent = await bookVenue(asDb(sql), {
    parcelId,
    slot: at17,
    hours: 1,
    bookedBy: CAROL_SUBJECT,
    escrowedWei: rate,
    reservationId: 'res-carol-2',
    correlationId: 'r',
  })
  assert.ok(adjacent.bookingId)

  // And the constraint is PARTIAL, so cancelling gives the span back rather than blocking it for
  // ever — the same reason §11.6 made the unique index partial.
  const open = await sql<{ id: string }[]>`
    select id from bookings where parcel_id = ${parcelId} and slot = ${at14}
  `
  await cancelBooking(asDb(sql), ledger, {
    bookingId: open[0]!.id,
    actor: `user:${BOB_SUBJECT.slice('user:'.length)}`,
    correlationId: 'r',
  })
  ledger.fund(CAROL_SUBJECT, rate)
  const reused = await bookVenue(asDb(sql), {
    parcelId,
    slot: at15,
    hours: 1,
    bookedBy: CAROL_SUBJECT,
    escrowedWei: rate,
    reservationId: 'res-carol-3',
    correlationId: 'r',
  })
  assert.ok(reused.bookingId, 'a cancelled booking does not hold the calendar')
})

test('a Venue is not booked by its own owner, and a hold must match the posted rate', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const rate = fromSparks(4_000n)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, is_venue, venue_rate_wei)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32, true, ${rate.toString()}::numeric)
    returning id
  `
  const parcelId = rows[0]!.id
  const slot = new Date('2027-06-01T10:00:00.000Z')

  await assert.rejects(
    () =>
      bookVenue(asDb(sql), {
        parcelId,
        slot,
        hours: 1,
        bookedBy: ALICE_SUBJECT,
        escrowedWei: rate,
        reservationId: 'res-self',
        correlationId: 'r',
      }),
    (err: unknown) => err instanceof WorldError && err.code === 'own_venue',
  )

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // AN ESCROW THAT IS NOT THE PRICE IS REFUSED IN BOTH DIRECTIONS, AND BY THE HANDLER.
  //
  // Too little opens a partly-free slot; too much silently overcharges the booker. Neither is
  // accommodated.
  //
  // The SENTENCE is pinned, not just the code, and that is not fussiness — it names which of the
  // two layers answered. Deleting the check in `bookVenue` and passing `escrowedWei` straight
  // through as the price leaves this test GREEN on the code alone, because the trigger catches it
  // a statement later and this file maps that constraint to the same `rate_moved`. Verified by
  // doing exactly that: the mutation was green until this assertion read the message. A test that
  // cannot tell a live check from a deleted one is the defect class this estate keeps finding.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  for (const held of [rate - fromSparks(1n), rate + fromSparks(1n)]) {
    await assert.rejects(
      () =>
        bookVenue(asDb(sql), {
          parcelId,
          slot,
          hours: 1,
          bookedBy: BOB_SUBJECT,
          escrowedWei: held,
          reservationId: 'res-short',
          correlationId: 'r',
        }),
      (err: unknown) =>
        err instanceof WorldError &&
        err.code === 'rate_moved' &&
        err.message.includes('rate now prices this booking at') &&
        err.message.includes(held.toString()),
    )
  }

  // And the same refusal from the database, with the handler's copy of it out of the picture: a
  // price that is not the owner's rate cannot be inserted at all, whoever writes it.
  await assert.rejects(
    () => sql`insert into bookings (parcel_id, slot, booked_by, price_wei, reservation_id)
              values (${parcelId}, ${slot}, ${BOB_SUBJECT},
                      ${(rate + fromSparks(1n)).toString()}::numeric, 'res-raw')`,
    (err: unknown) => String(err).includes('bookings_price_is_the_owners_rate'),
  )

  // Nothing landed on the calendar through any of the four.
  const count = await sql<{ n: string }[]>`select count(*)::text as n from bookings`
  assert.equal(count[0]?.n, '0')
})

test('an engagement grant cannot be recorded without naming its ledger entry', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  await assert.rejects(
    () => sql`insert into engagement_grants (kind, beneficiary, amount_wei, idempotency_key)
              values ('commission', ${ALICE_SUBJECT}, ${fromSparks(100n).toString()}::numeric, 'k1')`,
    (err: unknown) => String(err).includes('ledger_entry_id') || String(err).includes('not-null'),
    'a grant was recorded with no ledger entry behind it — doc 21 §7.4',
  )
})
