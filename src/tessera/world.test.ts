/**
 * The world, against a real Postgres.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY INVARIANT HERE IS TESTED WITH A RAW `INSERT` OR `UPDATE`, HANDLER OUT OF THE PICTURE.
 *
 * That is the only version of these tests that says anything. A test that calls `claimParcel`
 * twice and asserts the second throws proves that `claimParcel` has an `if`; it proves nothing
 * about what a bug, a migration, a second replica or an operator with a psql prompt can do. The
 * claim this file makes is that the DATABASE refuses, so the database is what is asked.
 *
 * Where a handler IS exercised it is to check the sentence a person sees, which is the other half
 * of the division of labour: the constraint is the guarantee, the handler is the error message.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
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
import {
  CLAIMABLE_TILES,
  TIER_SIZE,
  WARD_TILES,
  bankParcel,
  claimParcel,
  findParcel,
  listFallow,
  listParcelsOf,
  openContest,
  resolveContest,
  transferParcel,
  WorldError,
} from './world.ts'
import { BANKED_DAYS, CONTEST_DAYS, FALLOW_DAYS, contestableAt, fallowAt, fallowStateOf } from './fallow.ts'

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

/* ------------------------------------------------------------------ pure, no database needed */

test('three quarters of a ward is claimable, and the quarter that is not is the point', () => {
  assert.equal(WARD_TILES, 65_536)
  assert.equal(CLAIMABLE_TILES, 49_152)
  assert.equal(WARD_TILES - CLAIMABLE_TILES, 16_384)
  // §4's arithmetic, checkable: 49,152 tiles is 48 Plot-equivalents, or 192 Homesteads, or 12
  // Courts, or 3 Quarters.
  assert.equal(CLAIMABLE_TILES / (TIER_SIZE.plot ** 2), 48)
  assert.equal(CLAIMABLE_TILES / (TIER_SIZE.homestead ** 2), 192)
  assert.equal(CLAIMABLE_TILES / (TIER_SIZE.court ** 2), 12)
  assert.equal(CLAIMABLE_TILES / (TIER_SIZE.quarter ** 2), 3)
})

test('the object cap is five per eight tiles at every tier — §6.2\'s table, as arithmetic', () => {
  const capOf = (side: number) => Math.floor((side * side) / 8) * 5
  assert.equal(capOf(TIER_SIZE.homestead), 160)
  assert.equal(capOf(TIER_SIZE.plot), 640)
  assert.equal(capOf(TIER_SIZE.court), 2_560)
  assert.equal(capOf(TIER_SIZE.quarter), 10_240)
})

test('a Homestead is never fallow and never contestable, whatever the clock says', () => {
  const longAgo = new Date('2020-01-01T00:00:00Z')
  const now = new Date('2030-01-01T00:00:00Z')
  assert.equal(
    fallowStateOf({ tier: 'homestead', status: 'held', lastActiveAt: longAgo, bankedUntil: null }, now),
    'held',
  )
  assert.equal(
    fallowStateOf({ tier: 'plot', status: 'held', lastActiveAt: longAgo, bankedUntil: null }, now),
    'contestable',
  )
})

test('the fallow clock is 90 days, then 30 more, and banking extends it to 270', () => {
  const active = new Date('2026-01-01T00:00:00Z')
  const day = 24 * 60 * 60 * 1000
  assert.equal(fallowAt({ lastActiveAt: active, bankedUntil: null }).getTime(), active.getTime() + FALLOW_DAYS * day)
  assert.equal(
    contestableAt({ lastActiveAt: active, bankedUntil: null }).getTime(),
    active.getTime() + (FALLOW_DAYS + CONTEST_DAYS) * day,
  )
  // Banking only ever pushes the deadline LATER. A bank that landed before the parcel's last
  // activity has no effect at all rather than pulling the deadline backwards.
  const banked = new Date(active.getTime() + BANKED_DAYS * day)
  assert.equal(fallowAt({ lastActiveAt: active, bankedUntil: banked }).getTime(), banked.getTime())
  const stale = new Date(active.getTime() + 1 * day)
  assert.equal(
    fallowAt({ lastActiveAt: active, bankedUntil: stale }).getTime(),
    active.getTime() + FALLOW_DAYS * day,
  )
})

/**
 * §12's test 4, and §7's fourth refusal, asserted as an ABSENCE with force.
 *
 * "Land is claimed, not bought, and the platform never sells it." A test that only checked
 * `claimParcel` has no `price` parameter would pass against a file that charged through a helper.
 * This scans the whole module for the vocabulary of a sale, with comments stripped so the rule
 * does not fire on the prose that documents the rule.
 */
test('claiming ground touches no money: no price, no charge, no payment, no ledger', () => {
  const raw = readFileSync(new URL('./world.ts', import.meta.url), 'utf8')
  const source = stripQuotedProse(stripComments(raw))

  // The guard is checked against itself first. Its previous version fired on an ERROR MESSAGE
  // quoting §7.3 — "capped at 12, at any price" — which is the same family as the estate's
  // reachability guard that counted an `import` as a reference, and whose obvious fix (drop
  // `price` from the list) would have let a `price` parameter through. So: prose is stripped, and
  // this asserts the stripping is actually happening rather than that the list happens to pass.
  assert.ok(raw.includes('at any price'), 'the fixture sentence this guard once fired on is gone')
  assert.equal(source.includes('at any price'), false, 'stripQuotedProse is not stripping')

  for (const forbidden of ['price', 'charge', 'payment', 'invoice', 'ledger', 'wei', 'amount']) {
    assert.equal(
      source.toLowerCase().includes(forbidden),
      false,
      `world.ts uses "${forbidden}" in CODE — land is claimed free and the platform never sells it (23-tessera.md §4)`,
    )
  }

  // And the strongest form of the same claim, which no vocabulary list can be wrong about: this
  // module imports nothing that can move money.
  // Read off the COMMENT-stripped source rather than the prose-stripped one: `stripQuotedProse`
  // empties every single-quoted string, and an import specifier is one. A version of this check
  // that read `source` would find zero imports and pass for ever — the shape of the estate's four
  // tests that graded the wrong function.
  const imports = [...stripComments(raw).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '')
  assert.ok(imports.length > 0, 'no imports were found; this check is grading nothing')
  for (const specifier of imports) {
    assert.equal(
      /ledgerclient|sparks|economy|contracts-money/.test(specifier),
      false,
      `world.ts imports ${specifier} — claiming ground must not be able to reach money`,
    )
  }
})

/* -------------------------------------------------------------------------- against Postgres */

test('a second Homestead is refused BY THE DATABASE, for a caller holding a connection', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  await sql`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${ALICE_SUBJECT}, 'homestead', 0, 0, 16)
  `
  await assert.rejects(
    () => sql`
      insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
      values (${ward}, ${ALICE_SUBJECT}, 'homestead', 64, 64, 16)
    `,
    (err: unknown) => String(err).includes('tessera_one_homestead'),
    'a raw INSERT created a second Homestead — the partial unique index is not doing its job',
  )
  // And a second person's Homestead is fine, which is what makes the index PARTIAL rather than a
  // unique on the tier.
  await seedAccounts(sql, BOB_SUBJECT)
  await sql`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${BOB_SUBJECT}, 'homestead', 64, 64, 16)
  `
})

test('two claims on one rectangle produce exactly one claim — the constraint, not the lease', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)

  // Genuinely concurrent: two connections, two transactions, both in flight. The exclusion
  // constraint takes a predicate lock on the range, so the loser gets 23P01 rather than a second
  // overlapping claim. §12's test 5 says "lease, not luck"; this proves it is not luck EVEN
  // WITHOUT the lease, which is the stronger statement.
  const a = openDb(2)
  const b = openDb(2)
  try {
    const results = await Promise.allSettled([
      a`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
        values (${ward}, ${ALICE_SUBJECT}, 'plot', 32, 32, 32)`,
      b`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
        values (${ward}, ${BOB_SUBJECT}, 'plot', 48, 48, 32)`,
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    assert.equal(fulfilled.length, 1, 'both overlapping claims landed')
    const rejected = results.find((r) => r.status === 'rejected')

    // ═════════════════════════════════════════════════════════════════════════════════════════
    // THE LOSER IS REFUSED BY POSTGRES, AND THERE ARE TWO SQLSTATES THAT MEANS.
    //
    // This asserted `String(reason).includes('tessera_parcels_do_not_overlap')` and failed in CI
    // — one fulfilled, one rejected, the invariant intact, and the message not the expected one.
    // Measured rather than guessed: 60 runs of this exact race (open two pools, insert
    // immediately, connections NOT warm) returned 23P01 fifty-five times and 40P01 — `deadlock
    // detected` — five times.
    //
    // Both are the DATABASE refusing, which is the whole claim of this test: "the constraint, not
    // the lease". An exclusion constraint is enforced by SPECULATIVE INSERTION — write the index
    // entry, then scan for conflicts, then wait on any conflicting uncommitted xid. When the two
    // inserts genuinely interleave, each writes its entry before seeing the other's, so each ends
    // up waiting for the other and the deadlock detector kills one. When they do not, the second
    // simply finds the first's entry and gets the exclusion violation. Which one happens is a
    // function of how the two sockets are scheduled, so it is timing, and a CI runner is slower
    // and more contended than this machine — 1047ms there against 97ms here.
    //
    // So the SQLSTATE is asserted rather than a substring of a message, and it is asserted against
    // exactly two values. That is STRICTER than what it replaces, not looser: a connection error, a
    // timeout, or a rejection carrying no `code` at all used to read as `expected: true, actual:
    // false` with nothing to go on, and now fails naming what actually came back. Where Postgres
    // told us which constraint it was, that is still pinned.
    // ═════════════════════════════════════════════════════════════════════════════════════════
    const reason: unknown = rejected && rejected.reason
    const code = (reason as { code?: unknown } | null)?.code
    assert.ok(
      code === '23P01' || code === '40P01',
      `the losing claim was not refused by the database: SQLSTATE ${String(code)} — ${String(reason)}`,
    )
    if (code === '23P01') {
      assert.ok(
        String(reason).includes('tessera_parcels_do_not_overlap'),
        `an exclusion violation from another constraint: ${String(reason)}`,
      )
    }
  } finally {
    await a.end({ timeout: 5 })
    await b.end({ timeout: 5 })
  }

  const held = await sql<{ n: number }[]>`select count(*)::int as n from parcels where status = 'held'`
  assert.equal(held[0]?.n, 1)
})

test('adjacent is not overlapping — the ranges are half-open, so ground is not wasted', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  await sql`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
            values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32)`
  await sql`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
            values (${ward}, ${BOB_SUBJECT}, 'plot', 32, 0, 32)`
  const held = await sql<{ n: number }[]>`select count(*)::int as n from parcels`
  assert.equal(held[0]?.n, 2)
})

test('a thirteenth Deed Slot is refused through ANY path, because the CHECK has no path', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  // Twelve is fine.
  await sql`update accounts set deed_slots = 12 where subject = ${ALICE_SUBJECT}`
  // Thirteen is not — by UPDATE, by INSERT, or by arithmetic that lands there.
  await assert.rejects(
    () => sql`update accounts set deed_slots = 13 where subject = ${ALICE_SUBJECT}`,
    (err: unknown) => String(err).includes('tessera_deed_slots_capped'),
  )
  await assert.rejects(
    () => sql`update accounts set deed_slots = deed_slots + 1 where subject = ${ALICE_SUBJECT}`,
    (err: unknown) => String(err).includes('tessera_deed_slots_capped'),
  )
  await assert.rejects(
    () => sql`insert into accounts (subject, deed_slots) values (${CAROL_SUBJECT}, 13)`,
    (err: unknown) => String(err).includes('tessera_deed_slots_capped'),
  )
  // And below the floor, which matters for the opposite reason: an account nobody can claim with.
  await assert.rejects(
    () => sql`update accounts set deed_slots = 1 where subject = ${ALICE_SUBJECT}`,
    (err: unknown) => String(err).includes('tessera_deed_slots_capped'),
  )
})

test('the object cap has no UPDATE path at all — it is generated, so no SKU can raise it', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  await sql`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
            values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32)`
  await assert.rejects(
    () => sql`update parcels set object_cap = 99999 where tier = 'plot'`,
    (err: unknown) => String(err).includes('can only be updated to DEFAULT'),
    'the object cap was writable — §6.2 says it is a rendering budget and not purchasable at any price',
  )
  const rows = await sql<{ object_cap: number; tiles: number }[]>`
    select object_cap, tiles from parcels where tier = 'plot'
  `
  assert.equal(rows[0]?.object_cap, 640)
  assert.equal(rows[0]?.tiles, 1024)
})

test('a Homestead cannot be sold, released, or turned into a Plot', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${ALICE_SUBJECT}, 'homestead', 0, 0, 16) returning id
  `
  const id = rows[0]?.id
  assert.ok(id)
  await assert.rejects(
    () => sql`update parcels set owner_subject = ${BOB_SUBJECT} where id = ${id}`,
    (err: unknown) => String(err).includes('not tradeable'),
  )
  await assert.rejects(
    () => sql`update parcels set status = 'released', released_at = now() where id = ${id}`,
    (err: unknown) => String(err).includes('never released'),
  )
  await assert.rejects(
    () => sql`update parcels set tier = 'plot' where id = ${id}`,
    (err: unknown) => String(err).includes('may not change tier'),
  )
  // And through the handler, so a person gets a sentence rather than a constraint name.
  await assert.rejects(
    () =>
      transferParcel(asDb(sql), {
        parcelId: id,
        toSubject: BOB_SUBJECT,
        reason: 'trade',
        correlationId: 'req-1',
        actor: 'system',
      }),
    (err: unknown) => err instanceof WorldError && err.code === 'homestead_is_not_tradeable',
  )
})

test('a contest before the window is refused on the DATABASE clock, not the callers', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32) returning id
  `
  const id = rows[0]!.id

  await assert.rejects(
    () => openContest(asDb(sql), { parcelId: id, challengerSubject: BOB_SUBJECT, correlationId: 'r' }),
    (err: unknown) => err instanceof WorldError && err.code === 'not_yet_contestable',
  )

  // Move the parcel's last activity back past 90 + 30 days. `claimed_at` is a base column of the
  // generated `last_active_at`, so this is the honest way to age a parcel — as opposed to writing
  // `last_active_at` directly, which Postgres refuses because it is generated.
  await sql`update parcels set claimed_at = now() - interval '121 days' where id = ${id}`
  const contest = await openContest(asDb(sql), {
    parcelId: id,
    challengerSubject: BOB_SUBJECT,
    correlationId: 'r',
  })
  assert.ok(contest.contestId)

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // THE FALLOW EVENT NAMES THE OWNER LOSING GROUND, NOT THE CHALLENGER TAKING IT.
  //
  // `notify/src/topics.ts` records this topic `blockedBy: 'no-subject'`, and it was right:
  // the payload carried `challengerSubject` and nothing else. The person who needs telling — and
  // who has thirty days to do something about it — is the OWNER, who was absent entirely.
  //
  // Alice owns and Bob challenges, so this is asserted as a difference: a payload that derived
  // the owner from the actor would satisfy a presence check and name exactly the wrong person.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const fallowed = await sql<{ key: string; payload: Record<string, unknown> }[]>`
    select key, payload from outbox where topic = 'tessera.parcel.fallowed'
  `
  assert.equal(fallowed.length, 1)
  assert.equal(fallowed[0]?.key, id, 'keyed by the parcel, not the contest')
  assert.equal(fallowed[0]?.payload['ownerSubject'], ALICE_SUBJECT)
  assert.equal(fallowed[0]?.payload['challengerSubject'], BOB_SUBJECT)
  assert.notEqual(
    fallowed[0]?.payload['ownerSubject'],
    fallowed[0]?.payload['challengerSubject'],
    'the owner was derived from the actor rather than read from the parcel',
  )
  assert.equal(fallowed[0]?.payload['contestId'], contest.contestId)

  // A Homestead is never contestable, however old it is.
  const home = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, claimed_at)
    values (${ward}, ${ALICE_SUBJECT}, 'homestead', 64, 64, 16, now() - interval '900 days')
    returning id
  `
  await assert.rejects(
    () =>
      openContest(asDb(sql), {
        parcelId: home[0]!.id,
        challengerSubject: BOB_SUBJECT,
        correlationId: 'r',
      }),
    (err: unknown) => err instanceof WorldError && err.code === 'homestead_is_never_contestable',
  )
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A CONTEST RESOLUTION IS A TRANSFER, AND IT USED TO BE A SECOND COPY OF ONE.
 *
 * `resolveContest` carried its own inline UPDATE, identical to `transferParcel`'s except that it
 * translated NEITHER of the two constraints `transferParcel` translates. So a resolution that
 * would push the challenger past twelve Deed Slots threw a raw `PostgresError` out of the
 * `parcel.settle` LEASED JOB — where the only symptoms are `jobs_failed_total` climbing and a
 * parcel that silently never changes hands. There is no customer on that path to notice, which is
 * why it is worth a test rather than a comment.
 *
 * Both functions now share `moveParcel`. This grades the refusal the copy did not have.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('resolving a contest for a challenger out of Deed Slots is a named refusal, not a raw error', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, claimed_at)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32, now() - interval '121 days') returning id
  `
  const id = rows[0]!.id
  const contest = await openContest(asDb(sql), {
    parcelId: id,
    challengerSubject: BOB_SUBJECT,
    correlationId: 'r',
  })

  // Bob already holds his two. Taking a third by contest is the case the cap must still bite on:
  // §7.3's ceiling is "at any price", and winning ground is not a purchase but it is an acquisition.
  await sql`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
            values (${ward}, ${BOB_SUBJECT}, 'plot', 64, 0, 32)`
  await sql`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
            values (${ward}, ${BOB_SUBJECT}, 'plot', 96, 0, 32)`

  await assert.rejects(
    () => resolveContest(asDb(sql), contest.contestId, 'r'),
    (err: unknown) => err instanceof WorldError && err.code === 'recipient_out_of_deed_slots',
    'a contest resolution past the Deed Slot cap threw a raw PostgresError out of a leased job',
  )

  // The ground did not move, and no transfer was announced.
  const still = await sql<{ owner_subject: string }[]>`
    select owner_subject from parcels where id = ${id}
  `
  assert.equal(still[0]?.owner_subject, ALICE_SUBJECT)
  const events = await sql<{ n: number }[]>`
    select count(*)::int as n from outbox where topic = 'tessera.parcel.transferred'
  `
  assert.equal(events[0]?.n, 0)
})

test('the fallow set is computed on read — no sweep wrote it, and the two clocks agree', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  await sql`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, claimed_at)
            values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32, now() - interval '100 days')`
  await sql`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
            values (${ward}, ${ALICE_SUBJECT}, 'plot', 64, 64, 32)`

  const fallow = await listFallow(asDb(sql))
  assert.equal(fallow.length, 1, 'the 100-day-old parcel is fallow and the fresh one is not')

  // NOTHING was written to make that true. There is no `fallow` value in the status column at all,
  // and both parcels are still `held` — which is what "computed lazily, settled on write" means.
  const statuses = await sql<{ status: string }[]>`select distinct status from parcels`
  assert.deepEqual(statuses.map((r) => r.status), ['held'])

  // The TypeScript clock and the Postgres clock agree, which is the thing a lazy read cannot
  // assume: `listFallow` compares in SQL, `fallowStateOf` compares in JS, and a disagreement would
  // mean a parcel this service lists as fallow that the contest trigger refuses to act on.
  const parcel = fallow[0]!
  assert.equal(parcel.fallowState === 'fallow' || parcel.fallowState === 'contestable', true)
})

test('banking is once a year, extends to 270 days from last activity, and costs nothing', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, claimed_at)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32, now() - interval '100 days') returning id
  `
  const id = rows[0]!.id

  // Fallow before, not fallow after — which is the whole point of banking.
  assert.equal((await listFallow(asDb(sql))).length, 1)
  const banked = await bankParcel(asDb(sql), {
    parcelId: id,
    ownerSubject: ALICE_SUBJECT,
    correlationId: 'r',
  })
  assert.ok(banked.bankedUntil)
  assert.equal((await listFallow(asDb(sql))).length, 0)

  // A second bank within the year is refused BY THE TRIGGER, on the database's clock.
  await assert.rejects(
    () => bankParcel(asDb(sql), { parcelId: id, ownerSubject: ALICE_SUBJECT, correlationId: 'r' }),
    (err: unknown) => err instanceof WorldError && err.code === 'already_banked',
  )

  // And a raw UPDATE cannot set an arbitrary `banked_until` either: the trigger checks the
  // arithmetic, so "extend my clock by ten years" is not a statement anyone can write.
  await assert.rejects(
    () => sql`update parcels set banked_until = now() + interval '10 years', banked_at = now() + interval '400 days' where id = ${id}`,
    (err: unknown) => String(err).includes('270 days'),
  )
})

test('a Homestead cannot be banked — an accepted no-op would spend a users one bank of the year', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${ALICE_SUBJECT}, 'homestead', 0, 0, 16) returning id
  `
  await assert.rejects(
    () =>
      bankParcel(asDb(sql), {
        parcelId: rows[0]!.id,
        ownerSubject: ALICE_SUBJECT,
        correlationId: 'r',
      }),
    (err: unknown) => err instanceof WorldError && err.code === 'homestead_needs_no_banking',
  )
  await assert.rejects(
    () => sql`update parcels set banked_until = now() + interval '270 days' where tier = 'homestead'`,
    (err: unknown) => String(err).includes('tessera_homestead_is_never_banked'),
  )
})

test('Deed Slots bound holdings at COMMIT, so swapping one parcel for another stays legal', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  // Two slots by default.
  await sql`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
            values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32)`
  await sql`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
            values (${ward}, ${ALICE_SUBJECT}, 'plot', 32, 0, 32)`
  // A third is refused.
  await assert.rejects(
    () =>
      claimParcel(asDb(sql), {
        wardId: ward,
        ownerSubject: ALICE_SUBJECT,
        tier: 'plot',
        originX: 64,
        originY: 0,
        correlationId: 'r',
      }),
    (err: unknown) => err instanceof WorldError && err.code === 'out_of_deed_slots',
  )
  // But a Homestead is NOT counted, so the floor everybody gets does not consume a slot.
  await claimParcel(asDb(sql), {
    wardId: ward,
    ownerSubject: ALICE_SUBJECT,
    tier: 'homestead',
    originX: 128,
    originY: 128,
    correlationId: 'r',
  })
  assert.equal((await listParcelsOf(asDb(sql), ALICE_SUBJECT)).length, 3)

  // And a swap inside ONE transaction is legal, which an immediate check would have refused
  // depending on which line the developer wrote first.
  await sql.begin(async (tx) => {
    await tx`update parcels set status = 'released', released_at = now()
              where owner_subject = ${ALICE_SUBJECT} and origin_x = 0 and tier = 'plot'`
    await tx`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
             values (${ward}, ${ALICE_SUBJECT}, 'plot', 64, 0, 32)`
  })
  const plots = await sql<{ n: number }[]>`
    select count(*)::int as n from parcels
     where owner_subject = ${ALICE_SUBJECT} and status = 'held' and tier <> 'homestead'
  `
  assert.equal(plots[0]?.n, 2)
})

test('claiming maintains ward occupancy, and a ward cannot be claimed past its share', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  await claimParcel(asDb(sql), {
    wardId: ward,
    ownerSubject: ALICE_SUBJECT,
    tier: 'quarter',
    originX: 0,
    originY: 0,
    correlationId: 'r',
  })
  const rows = await sql<{ claimed_tiles: number }[]>`select claimed_tiles from wards where id = ${ward}`
  assert.equal(rows[0]?.claimed_tiles, 128 * 128)

  // Past the claimable share is refused by `wards_claimed_within_claimable`, so the last claim in
  // a full ward is refused by the database rather than by whoever remembers to check.
  await assert.rejects(
    () => sql`update wards set claimed_tiles = ${CLAIMABLE_TILES + 1} where id = ${ward}`,
    (err: unknown) => String(err).includes('wards_claimed_within_claimable'),
  )
})

test('a claim emits tessera.parcel.claimed, keyed by the parcel, with a major.minor version', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  const parcel = await claimParcel(asDb(sql), {
    wardId: ward,
    ownerSubject: ALICE_SUBJECT,
    tier: 'plot',
    originX: 0,
    originY: 0,
    correlationId: 'req-abc',
  })
  const rows = await sql<
    { topic: string; key: string; version: string; actor: string; correlation_id: string }[]
  >`select topic, key, version, actor, correlation_id from outbox`
  assert.equal(rows.length, 1)
  const row = rows[0]!
  assert.equal(row.topic, 'tessera.parcel.claimed')
  // Keyed by the PARCEL. §11.2, and the registry says so too — `topics.test.ts` checks the
  // agreement from the other side.
  assert.equal(row.key, parcel.id)
  assert.match(row.version, /^\d+\.\d+$/)
  assert.equal(row.actor, ALICE_SUBJECT)
  assert.equal(row.correlation_id, 'req-abc')
})

test('the outbox refuses an integer version and a null actor at the database', { skip }, async () => {
  await assert.rejects(
    () => sql`insert into outbox (topic, key, producer, version, actor, correlation_id)
              values ('tessera.ward.opened', 'k', 'tessera', '1', 'system', 'r')`,
    (err: unknown) => String(err).includes('outbox_version_is_major_minor'),
    'an integer version was accepted — this is how several services events were never delivered',
  )
  await assert.rejects(
    () => sql`insert into outbox (topic, key, producer, version, actor, correlation_id)
              values ('tessera.ward.opened', 'k', 'tessera', '1.0', null, 'r')`,
    (err: unknown) => String(err).includes('null value') || String(err).includes('not-null'),
  )
  await assert.rejects(
    () => sql`insert into outbox (topic, key, producer, version, actor, correlation_id)
              values ('tessera.ward.opened', 'k', 'tessera', '1.0', 'system', null)`,
    (err: unknown) => String(err).includes('null value') || String(err).includes('not-null'),
  )
})

test('a released parcel frees its ground, so the commons genuinely comes back', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  await sql`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
            values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32)`
  // Bob cannot claim it while it is held.
  await assert.rejects(
    () => sql`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
              values (${ward}, ${BOB_SUBJECT}, 'plot', 0, 0, 32)`,
    (err: unknown) => String(err).includes('tessera_parcels_do_not_overlap'),
  )
  await sql`update parcels set status = 'released', released_at = now() where owner_subject = ${ALICE_SUBJECT}`
  // And can once it is released — the exclusion constraint is partial on `status = 'held'`.
  await sql`insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
            values (${ward}, ${BOB_SUBJECT}, 'plot', 0, 0, 32)`
  const parcel = await findParcel(asDb(sql), (await sql<{ id: string }[]>`
    select id from parcels where owner_subject = ${BOB_SUBJECT}
  `)[0]!.id)
  assert.equal(parcel?.ownerSubject, BOB_SUBJECT)
})
