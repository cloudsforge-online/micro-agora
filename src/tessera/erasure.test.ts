/**
 * The right to erasure, proved against a real database rather than against a checklist.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE CENTRAL TEST DOES NOT ENUMERATE THE TABLES IT EXPECTS — IT ASKS THE DATABASE.**
 *
 * Two catalogue queries do the work a hand-written list would do badly:
 *
 *   1. `referencingColumnsOfAccounts()` reads `pg_constraint` for every foreign key pointing at
 *      `accounts (subject)`. The seed asserts it covered ALL of them. So a migration that adds a
 *      tenth referencing column fails this test ON THE DAY IT LANDS, naming the column, rather
 *      than on the day somebody asks why an erased user still owns something.
 *   2. `occurrencesOf()` sweeps EVERY text and jsonb column in the schema for the erased
 *      subject. Not the columns this file thought of — every one that exists. That is how
 *      `outbox.actor` and `outbox.payload` were found: they are not foreign keys, no design
 *      document listed them, and the outbox is never purged, so they would have kept a complete
 *      re-identification key long after every other trace was gone.
 *
 * And underneath both, the property `erasure.ts` is actually built on: because all nine
 * referencing columns are `on delete restrict`, the final `delete from accounts` RAISES 23503 if
 * the handler missed a table. The seed below puts a row in every referencing table precisely so
 * that the database, not the reader, is the thing checking for completeness.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { singleNetworkSql } from './testsupport.ts'
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { Lifecycle } from '@cloudsforge/lifecycle'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  signDelivery,
} from '@cloudsforge/contracts-events'
import {
  ALICE,
  ALICE_SUBJECT,
  BOB,
  BOB_SUBJECT,
  asDb,
  enabled,
  migrateTestDb,
  openDb,
  quietLogger,
  resetTessera,
  seedAccounts,
  seedObject,
  seedWard,
  skip,
  TEST_EVENT_SECRET,
  testMetrics,
} from './testsupport.ts'
import { handleDelivery } from './inbound.ts'
import { createServer } from './server.ts'
import { fromSparks } from './sparks.ts'

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
    // No token verifier is needed and none is usable: `POST /v1/events` authenticates with the
    // MAC and never reads a bearer. A verifier that throws proves the route does not consult one.
    verifier: {
      principal: async () => {
        throw new Error('the event route must not authenticate with a token')
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

const ERASED = /^erased:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function deletionEvent(userId: string, id: string): string {
  return JSON.stringify({
    id,
    topic: 'identity.user.deleted',
    // `keyedBy: 'user_id'` — identity puts the user id in the key. The handler reads the PAYLOAD,
    // and the two carrying the same value here is what lets the payload-only test below mean
    // something: an implementation that read the key would pass this fixture and fail that one.
    key: userId,
    occurredAt: new Date().toISOString(),
    producer: 'identity',
    version: '1.0',
    actor: 'system',
    correlationId: 'req-erasure',
    payload: { userId, tombstoneAt: new Date().toISOString(), reason: 'user_requested' },
  })
}

function signed(raw: string, id: string): Record<string, string> {
  return {
    [SIGNATURE_HEADER]: signDelivery(raw, TEST_EVENT_SECRET),
    [EVENT_ID_HEADER]: id,
  }
}

function deps() {
  return { sql: asDb(sql), logger: quietLogger(), secrets: [TEST_EVENT_SECRET] }
}

/** Every column in the schema with a foreign key onto `accounts`, asked of the catalogue. */
async function referencingColumnsOfAccounts(): Promise<Set<string>> {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    select cl.relname as table_name, att.attname as column_name
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join unnest(con.conkey) as k(attnum) on true
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
     where con.contype = 'f'
       and con.confrelid = 'accounts'::regclass
  `
  return new Set(rows.map((r) => `${r.table_name}.${r.column_name}`))
}

/**
 * Every place in the whole schema where `value` appears, as `table.column` strings.
 *
 * Text AND jsonb, because the outbox stores subjects inside a payload document and a sweep that
 * only looked at text columns would have reported this erasure complete while it was not.
 */
async function occurrencesOf(value: string): Promise<string[]> {
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and t.table_type = 'BASE TABLE'
       and c.data_type in ('text', 'character varying', 'jsonb')
     order by c.table_name, c.column_name
  `
  const hits: string[] = []
  for (const column of columns) {
    const rows = (await sql.unsafe(
      `select count(*)::int as n from "${column.table_name}" where strpos("${column.column_name}"::text, $1) > 0`,
      [value],
    )) as unknown as { n: number }[]
    const n = rows[0]?.n ?? 0
    if (n > 0) hits.push(`${column.table_name}.${column.column_name}`)
  }
  return hits
}

/**
 * One user with a row in EVERY table that can hold a subject, so the erasure has to be total.
 *
 * The assertion at the end is the point: it fails if a future migration adds a referencing column
 * this fixture does not seed, which is what stops the coverage claim decaying into a comment.
 */
async function seedAUserWithEverything(): Promise<{ readonly wardId: string }> {
  const wardId = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)

  const rate = fromSparks(4_000n)

  const [alicePlot] = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${wardId}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32)
    returning id
  `
  const [bobVenue] = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, is_venue, venue_rate_wei)
    values (${wardId}, ${BOB_SUBJECT}, 'plot', 64, 0, 32, true, ${rate.toString()}::numeric)
    returning id
  `
  // Claimed long enough ago to be past 90 days fallow plus 30 more, so a contest is legal —
  // `tessera_assert_contest_window` reads the DATABASE clock and would refuse a fresh parcel.
  const [staleParcel] = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, claimed_at)
    values (${wardId}, ${BOB_SUBJECT}, 'plot', 128, 0, 32, now() - interval '200 days')
    returning id
  `
  const parcelId = alicePlot!.id

  // ALICE contests BOB's long-quiet parcel. Two-sided data: also a record about BOB.
  await sql`
    insert into contests (parcel_id, challenger_subject) values (${staleParcel!.id}, ${ALICE_SUBJECT})
  `

  const objectId = await seedObject(sql, ALICE_SUBJECT, 1)
  const secondObjectId = await seedObject(sql, ALICE_SUBJECT, 2)

  await sql`
    insert into placements (parcel_id, object_id, x, y, facing, placed_by)
    values (${parcelId}, ${objectId}, 1, 1, 'canonical', ${ALICE_SUBJECT})
  `

  // A DRAFT — deleted by the erasure, because nobody was ever offered it.
  await sql`
    insert into listings (object_id, seller_subject, price_wei, royalty_bps, platform_fee_bps)
    values (${objectId}, ${ALICE_SUBJECT}, ${fromSparks(400n).toString()}::numeric, 500, 250)
  `
  // A PUBLISHED one — retained and anonymised, because it is joined to a settlement record.
  //
  // The three `market_*` columns are what micro-market ANSWERED and are mandatory past draft
  // (`listings_past_draft_records_market_terms`). `market_seller_subject` names her a SECOND time
  // on the same row, tied to the first by `listings_market_agrees_on_the_seller` — which is why
  // an erasure that repointed only `seller_subject` would fail with 23514 rather than leak.
  await sql`
    insert into listings (object_id, seller_subject, price_wei, royalty_bps, platform_fee_bps,
                          status, market_listing_id,
                          market_seller_subject, market_platform_fee_bps, market_royalty_bps)
    values (${secondObjectId}, ${ALICE_SUBJECT}, ${fromSparks(800n).toString()}::numeric, 500, 250,
            'active', 'ml-erasure-1', ${ALICE_SUBJECT}, 250, 500)
  `

  await sql`
    insert into bookings (parcel_id, slot, booked_by, price_wei, reservation_id)
    values (${bobVenue!.id}, '2027-05-01T09:00:00.000Z', ${ALICE_SUBJECT},
            ${rate.toString()}::numeric, 'res-erasure-1')
  `

  await sql`
    insert into engagement_grants (kind, beneficiary, amount_wei, ledger_entry_id, idempotency_key)
    values ('firing_allowance', ${ALICE_SUBJECT}, ${fromSparks(50n).toString()}::numeric,
            'le-erasure-1', 'idem-erasure-1')
  `

  await sql`
    insert into beacons (parcel_id, lit_by, headline)
    values (${parcelId}, ${ALICE_SUBJECT}, 'the forge is open')
  `

  await sql`
    insert into entitlements (subject, kind, sku, entitlement_id)
    values (${ALICE_SUBJECT}, 'deed_slots', 'tessera.deed.one', 'ent-erasure-1')
  `

  /* --- and the three that carry a subject with NO foreign key, plus the outbox --- */

  await sql`
    insert into visits (parcel_id, day, visitor_subject) values (${parcelId}, current_date, ${ALICE_SUBJECT})
  `
  await sql`
    insert into presence (ward_id, subject, instance, x, y) values (${wardId}, ${ALICE_SUBJECT}, 1, 5, 5)
  `
  await sql`
    insert into provisions (entitlement_id, subject, user_id, sku, scope, urn)
    values ('ent-erasure-2', ${ALICE_SUBJECT}, ${ALICE}::uuid, 'world.private.small', 'ward',
            'cf:tessera:ward:0192fa00-0000-7000-8000-0000000000ff')
  `
  // An emitted event naming her, of the shape `world.ts` writes: the subject in `actor`
  // AND again inside the payload, beside the parcel id that will outlive her.
  await sql`
    insert into outbox (topic, key, producer, version, actor, correlation_id, payload)
    values ('tessera.parcel.claimed', ${parcelId}, 'tessera', '1.0', ${ALICE_SUBJECT}, 'req-1',
            ${sql.json({ parcelId, ownerSubject: ALICE_SUBJECT, tier: 'plot' })})
  `

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // THE FIXTURE AUDITS ITSELF AGAINST THE CATALOGUE.
  //
  // Without this, "a row in every referencing table" is a claim about what the author remembered
  // in August 2026. With it, it is a claim the database re-checks on every run.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const referencing = await referencingColumnsOfAccounts()
  assert.ok(referencing.size >= 9, `expected at least nine FKs onto accounts, found ${referencing.size}`)
  for (const column of referencing) {
    const [table, name] = column.split('.')
    const rows = (await sql.unsafe(
      `select count(*)::int as n from "${table}" where "${name}" = $1`,
      [ALICE_SUBJECT],
    )) as unknown as { n: number }[]
    assert.ok(
      (rows[0]?.n ?? 0) > 0,
      `${column} references accounts but this fixture seeds no row for it — seed one, and check ` +
        `that erasure.ts handles it, or the erasure will fail with 23503`,
    )
  }

  return { wardId }
}

/* ------------------------------------------------------------------------------ the main event */

test(
  'erasing a user leaves no row anywhere naming them, and the FKs prove the coverage is total',
  { skip },
  async () => {
    const { wardId } = await seedAUserWithEverything()

    // Sanity: the sweep can actually see her before the erasure. A test whose "after" assertion
    // is zero is worthless unless its "before" is not.
    const before = await occurrencesOf(ALICE_SUBJECT)
    assert.ok(before.length >= 12, `expected the fixture to name her widely, saw ${before.join(', ')}`)
    assert.ok(before.includes('outbox.actor'), 'the fixture should have written her to the outbox')

    const eventId = '0192fa00-0000-7000-8000-000000000001'
    const raw = deletionEvent(ALICE, eventId)
    const verdict = await handleDelivery(deps(), raw, signed(raw, eventId))
    assert.equal(verdict.status, 200)
    assert.equal(verdict.outcome, 'processed')

    // ═════════════════════════════════════════════════════════════════════════════════════════
    // NOT ONE OCCURRENCE LEFT, IN ANY TEXT OR JSONB COLUMN OF ANY TABLE.
    // ═════════════════════════════════════════════════════════════════════════════════════════
    const after = await occurrencesOf(ALICE_SUBJECT)
    assert.deepEqual(after, [], `the erased subject survives in: ${after.join(', ')}`)
    // The bare uuid too — `provisions.user_id` is a `uuid` column, so the text sweep above cannot
    // see it and clearing only the ledger spelling would have left her named there.
    const provisions = await sql<{ n: number }[]>`
      select count(*)::int as n from provisions where user_id = ${ALICE}::uuid
    `
    assert.equal(provisions[0]?.n, 0)

    /* --- what was DELETED --- */
    const gone = await sql<{ entitlements: number; presence: number; drafts: number }[]>`
      select (select count(*)::int from entitlements) as entitlements,
             (select count(*)::int from presence)     as presence,
             (select count(*)::int from listings where status = 'draft') as drafts
    `
    assert.equal(gone[0]?.entitlements, 0, 'entitlements are deleted outright')
    assert.equal(gone[0]?.presence, 0, 'presence is ephemeral and is deleted')
    assert.equal(gone[0]?.drafts, 0, 'an unpublished draft has no counterparty and is deleted')

    /* --- what SURVIVED, moved onto one placeholder --- */
    const accounts = await sql<{ subject: string }[]>`
      select subject from accounts where subject <> ${BOB_SUBJECT}
    `
    assert.equal(accounts.length, 1, 'exactly one placeholder account replaces her')
    const placeholder = accounts[0]!.subject
    assert.match(placeholder, ERASED, 'the placeholder is `erased:` plus a uuid, and pinned by CHECK')

    // ═════════════════════════════════════════════════════════════════════════════════════════
    // ONE PLACEHOLDER FOR EVERY RETAINED ROW — the deliberate choice `erasure.ts` argues for.
    // Her rows stay linked to each other; they link to no person.
    // ═════════════════════════════════════════════════════════════════════════════════════════
    const retained = await sql<{ label: string; subject: string }[]>`
      select 'parcels' as label, owner_subject as subject from parcels where owner_subject = ${placeholder}
      union all select 'contests', challenger_subject from contests where challenger_subject = ${placeholder}
      union all select 'objects', author_subject from objects where author_subject = ${placeholder}
      union all select 'placements', placed_by from placements where placed_by = ${placeholder}
      union all select 'listings', seller_subject from listings where seller_subject = ${placeholder}
      union all select 'bookings', booked_by from bookings where booked_by = ${placeholder}
      union all select 'engagement_grants', beneficiary from engagement_grants where beneficiary = ${placeholder}
      union all select 'beacons', lit_by from beacons where lit_by = ${placeholder}
      union all select 'visits', visitor_subject from visits where visitor_subject = ${placeholder}
      union all select 'provisions', subject from provisions where subject = ${placeholder}
      union all select 'outbox', actor from outbox where actor = ${placeholder}
    `
    const labels = new Set(retained.map((r) => r.label))
    for (const expected of [
      'parcels',
      'contests',
      'objects',
      'placements',
      'listings',
      'bookings',
      'engagement_grants',
      'beacons',
      'visits',
      'provisions',
      'outbox',
    ]) {
      assert.ok(labels.has(expected), `${expected} should have been repointed at the placeholder`)
    }

    // The outbox payload was rewritten too, not just the `actor` column beside it.
    const payloads = await sql<{ owner: string }[]>`
      select payload->>'ownerSubject' as owner from outbox
    `
    assert.equal(payloads[0]?.owner, placeholder)

    // ═════════════════════════════════════════════════════════════════════════════════════════
    // FOOTFALL IS UNCHANGED. §8.6 — deleting the visit would have retroactively lowered this
    // parcel's ranking signal and moved its fallow clock, which is the harm anonymising avoids.
    // ═════════════════════════════════════════════════════════════════════════════════════════
    const footfall = await sql<{ n: number }[]>`select count(*)::int as n from visits`
    assert.equal(footfall[0]?.n, 1, 'the visit survives; only the visitor is gone')

    // And the placeholder carries none of her purchased state — see the data-minimisation note in
    // `erasure.ts`. `deed_slots` is the column default, not the 12 an erased buyer might have had.
    const minted = await sql<{ deed_slots: number }[]>`
      select deed_slots from accounts where subject = ${placeholder}
    `
    assert.equal(minted[0]?.deed_slots, 2)

    // The ward is untouched: it holds no subject and belongs to everybody.
    const wards = await sql<{ n: number }[]>`select count(*)::int as n from wards where id = ${wardId}`
    assert.equal(wards[0]?.n, 1)
  },
)

/* ------------------------------------------------------------------------------- irreversible */

test('an erased subject can never be turned back into a person', { skip }, async () => {
  await seedAUserWithEverything()
  const eventId = '0192fa00-0000-7000-8000-000000000002'
  const raw = deletionEvent(ALICE, eventId)
  assert.equal((await handleDelivery(deps(), raw, signed(raw, eventId))).status, 200)

  const rows = await sql<{ subject: string }[]>`
    select subject from accounts where subject <> ${BOB_SUBJECT}
  `
  const placeholder = rows[0]!.subject

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // WITHOUT THE MIGRATION 15 TRIGGERS, "ANONYMISED" WOULD ONLY MEAN "RENAMED".
  //
  // Every one of these statements satisfies the widened CHECKs. The trigger is the only thing
  // between them and a re-identified account, and it is a DATABASE trigger rather than a handler
  // guard for the usual reason: this is exactly the operation an operator with a psql prompt
  // would perform, and no handler is in the picture when they do.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  for (const target of [ALICE_SUBJECT, 'user:someone-else', 'erased:00000000-0000-4000-8000-000000000000']) {
    await assert.rejects(
      () => sql`update accounts set subject = ${target} where subject = ${placeholder}`,
      (err: unknown) => String(err).includes('never be re-attributed'),
      `accounts.subject should refuse being rewritten to ${target}`,
    )
    await assert.rejects(
      () => sql`update visits set visitor_subject = ${target} where visitor_subject = ${placeholder}`,
      (err: unknown) => String(err).includes('never be re-attributed'),
      `visits.visitor_subject should refuse being rewritten to ${target}`,
    )
  }

  // A live person's subject is still freely updatable — the trigger fires on the ERASED side
  // only, so it has not quietly frozen the whole table.
  await sql`update accounts set deed_slots = 3 where subject = ${BOB_SUBJECT}`

  // And the CHECK still refuses a hand-written placeholder that is not a real uuid, so nobody can
  // mint an `erased:` row that reads like a name.
  await assert.rejects(
    () => sql`insert into accounts (subject) values ('erased:alice')`,
    (err: unknown) => String(err).includes('accounts_subject_is_a_user'),
  )
  // ...while the loose `user:%` branch is untouched, because fixtures and existing rows use it.
  await sql`insert into accounts (subject) values ('user:alice')`
})

/* ------------------------------------------------------------------------------- idempotence */

test('a redelivered deletion is a duplicate, not a second erasure', { skip }, async () => {
  await seedAUserWithEverything()
  const eventId = '0192fa00-0000-7000-8000-000000000003'
  const raw = deletionEvent(ALICE, eventId)

  const first = await handleDelivery(deps(), raw, signed(raw, eventId))
  assert.equal(first.outcome, 'processed')

  const placeholderAfterFirst = (
    await sql<{ subject: string }[]>`select subject from accounts where subject <> ${BOB_SUBJECT}`
  )[0]!.subject

  const second = await handleDelivery(deps(), raw, signed(raw, eventId))
  assert.equal(second.status, 200)
  assert.equal(second.outcome, 'duplicate')

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // THE PLACEHOLDER DID NOT MOVE, AND A SECOND ONE WAS NOT MINTED.
  //
  // `randomUUID()` is called per erasure, so a second run that actually executed would produce a
  // DIFFERENT placeholder — and the retained rows would then be split across two of them, which
  // is both a wrong answer and a silent one. The inbox dedupe is what stops it; this asserts the
  // consequence rather than the mechanism.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const accounts = await sql<{ subject: string }[]>`
    select subject from accounts where subject <> ${BOB_SUBJECT}
  `
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0]?.subject, placeholderAfterFirst)
})

test(
  'a user holding more parcels than the default allowance can still be erased',
  { skip },
  async () => {
    // ═════════════════════════════════════════════════════════════════════════════════════════
    // THE FIXTURE ABOVE HOLDS ONE PARCEL AND WOULD PASS WHATEVER THE PLACEHOLDER'S `deed_slots`
    // WERE. THIS ONE HOLDS FOUR, AND ONLY PASSES IF THE ALLOWANCE IS CARRIED ACROSS.
    //
    // `parcels_within_deed_slots` is `deferrable initially deferred`, so it runs at COMMIT and
    // counts the parcels now owned by the placeholder. Mint the placeholder with the default of
    // 2 and this raises 23514 — meaning the players with the most in the world would be the ones
    // whose erasure requests could not be honoured.
    // ═════════════════════════════════════════════════════════════════════════════════════════
    const wardId = await seedWard(sql)
    await seedAccounts(sql, ALICE_SUBJECT)
    await sql`update accounts set deed_slots = 8 where subject = ${ALICE_SUBJECT}`
    for (let i = 0; i < 4; i += 1) {
      await sql`
        insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
        values (${wardId}, ${ALICE_SUBJECT}, 'plot', ${i * 32}, 0, 32)
      `
    }
    // A visit too, so the deferred-check-via-trigger path this ordering exists for is exercised
    // rather than assumed.
    const [parcel] = await sql<{ id: string }[]>`select id from parcels limit 1`
    await sql`
      insert into visits (parcel_id, day, visitor_subject)
      values (${parcel!.id}, current_date, ${ALICE_SUBJECT})
    `

    const eventId = '0192fa00-0000-7000-8000-000000000007'
    const raw = deletionEvent(ALICE, eventId)
    const verdict = await handleDelivery(deps(), raw, signed(raw, eventId))
    assert.equal(verdict.status, 200)

    const left = await occurrencesOf(ALICE_SUBJECT)
    assert.deepEqual(left, [], `the erased subject survives in: ${left.join(', ')}`)

    const rows = await sql<{ subject: string; deed_slots: number; n: number }[]>`
      select a.subject, a.deed_slots, (select count(*)::int from parcels) as n from accounts a
    `
    assert.equal(rows.length, 1)
    assert.match(rows[0]!.subject, ERASED)
    assert.equal(rows[0]!.deed_slots, 8, 'the allowance is carried so the deferred check passes')
    assert.equal(rows[0]!.n, 4, 'all four parcels survive, owned by nobody')
  },
)

test(
  'a user holding a HOMESTEAD can be erased, and the Homestead is still not tradeable after',
  { skip },
  async () => {
    // ═════════════════════════════════════════════════════════════════════════════════════════
    // THE ONE THE FIXTURES ABOVE NEVER HAD, AND IT COST A FORTNIGHT OF FAILED ERASURES.
    //
    // Every parcel in every other case here is a `plot`. A HOMESTEAD is the free starter parcel —
    // so in production the fixtures were testing the uncommon case and missing the universal one.
    //
    // `tessera_guard_homestead` refuses ANY change of `owner_subject` on a Homestead, and the
    // erasure repoints exactly that column. Measured on mainnet 2026-09-02: eight
    // `identity.user.deleted` events retrying continuously, 2,962 of the last 4,000 log lines,
    // and the entire 5xx rate that fired twenty-four SLO alerts — for a person who had asked to
    // be erased and was not being.
    //
    // The author of this file anticipated the OTHER trigger on this same UPDATE — the deferred
    // `parcels_within_deed_slots` — and carried `deed_slots` across specifically to defeat it,
    // writing that failing it would mean "the erasure of exactly the most invested players would
    // abort". The Homestead guard is on the same statement and was missed. That is the whole
    // lesson: a fixture that never holds the common row proves nothing about the common case.
    // ═════════════════════════════════════════════════════════════════════════════════════════
    const wardId = await seedWard(sql)
    await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
    const [homestead] = await sql<{ id: string }[]>`
      insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
      values (${wardId}, ${ALICE_SUBJECT}, 'homestead', 0, 0, 16)
      returning id
    `

    const eventId = '0192fa00-0000-7000-8000-000000000009'
    const raw = deletionEvent(ALICE, eventId)
    const verdict = await handleDelivery(deps(), raw, signed(raw, eventId))
    assert.equal(verdict.status, 200, 'the erasure completes rather than raising a check_violation')

    const left = await occurrencesOf(ALICE_SUBJECT)
    assert.deepEqual(left, [], `the erased subject survives in: ${left.join(', ')}`)

    const [owned] = await sql<{ owner_subject: string; tier: string }[]>`
      select owner_subject, tier from parcels where id = ${homestead!.id}
    `
    assert.equal(owned!.tier, 'homestead', 'the tier is untouched — this is not a downgrade')
    assert.match(owned!.owner_subject, ERASED, 'the Homestead is held by nobody')

    // ── AND THE RULE THE GUARD EXISTS FOR IS STILL ENFORCED ──────────────────────────────────
    //
    // The transition is ONE-WAY. A Homestead may become nobody's; it may never become somebody
    // else's, and that includes moving off the placeholder it has just been moved onto.
    await assert.rejects(
      sql`update parcels set owner_subject = ${BOB_SUBJECT} where id = ${homestead!.id}`,
      /is a Homestead — it is not tradeable/,
      'an erased Homestead is frozen where it stands',
    )
  },
)

test('a Homestead still cannot be sold to a person', { skip }, async () => {
  // The widened guard admits an anchored `erased:<uuid>` and nothing else. A hand-written
  // placeholder-shaped string is the escape somebody would reach for first, and migration 15 pins
  // the same pattern for the same reason.
  const wardId = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const [homestead] = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${wardId}, ${ALICE_SUBJECT}, 'homestead', 0, 0, 16)
    returning id
  `
  await assert.rejects(
    sql`update parcels set owner_subject = ${BOB_SUBJECT} where id = ${homestead!.id}`,
    /is a Homestead — it is not tradeable/,
  )
  await assert.rejects(
    sql`update parcels set owner_subject = 'erased:someone' where id = ${homestead!.id}`,
    /is a Homestead — it is not tradeable/,
    'a placeholder-SHAPED string is not a placeholder',
  )
})

test('erasing a user this service has never seen succeeds rather than 404s', { skip }, async () => {
  await seedWard(sql)
  const eventId = '0192fa00-0000-7000-8000-000000000004'
  const raw = deletionEvent(BOB, eventId)
  const verdict = await handleDelivery(deps(), raw, signed(raw, eventId))
  // An erasure for a stranger is a SUCCESS: there is nothing to erase, and answering an error
  // would make identity's relay retry a request that is already satisfied.
  assert.equal(verdict.status, 200)
  assert.equal(verdict.outcome, 'processed')
})

/* -------------------------------------------------------------------------- the route itself */

test('the deletion arrives over HTTP at POST /v1/events', { skip }, async () => {
  await seedAUserWithEverything()
  const eventId = '0192fa00-0000-7000-8000-000000000005'
  const raw = deletionEvent(ALICE, eventId)

  const res = await fetch(`${origin}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed(raw, eventId) },
    body: raw,
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: 'processed' })

  const left = await occurrencesOf(ALICE_SUBJECT)
  assert.deepEqual(left, [], `the erased subject survives in: ${left.join(', ')}`)
})

test('a bad signature is 403 and is refused BEFORE the body is parsed', { skip }, async () => {
  // Not JSON at all. If the route parsed before verifying, this would be a 400 — so the status
  // is the evidence for the ordering, which is the security property `inbound.ts` is built on.
  const garbage = '{not json at all'

  for (const headers of [
    {},
    { [SIGNATURE_HEADER]: 't=1,v1=deadbeef' },
    { [SIGNATURE_HEADER]: signDelivery(garbage, 'z'.repeat(32)) },
  ]) {
    const res = await fetch(`${origin}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: garbage,
    })
    assert.equal(res.status, 403, 'the MAC is the credential, so this is 403 and never 401')
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    assert.equal(body.error?.code, 'bad_signature')
    // ═════════════════════════════════════════════════════════════════════════════════════════
    // THE THREE FAILURES ARE INDISTINGUISHABLE. Absent, forged and wrong-key all produce the
    // same status, the same code and the same message: "expired" versus "forged" tells an
    // attacker which half to fix.
    // ═════════════════════════════════════════════════════════════════════════════════════════
    assert.equal(body.error?.message, 'the event signature did not verify')
  }
})

test('an authentic delivery on an unsubscribed topic is 202, never a 4xx', { skip }, async () => {
  // `identity.user.registered` is real, registered and signed correctly — this service simply
  // does not handle it. A 4xx here would make identity's relay retry it for ever; the producer
  // cannot fix a subscription by redelivering.
  const raw = JSON.stringify({
    id: '0192fa00-0000-7000-8000-000000000006',
    topic: 'identity.user.registered',
    key: ALICE,
    occurredAt: new Date().toISOString(),
    producer: 'identity',
    version: '1.0',
    actor: 'system',
    correlationId: 'req-2',
    payload: { userId: ALICE },
  })
  const res = await fetch(`${origin}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...signed(raw, '0192fa00-0000-7000-8000-000000000006'),
    },
    body: raw,
  })
  assert.equal(res.status, 202)
  assert.deepEqual(await res.json(), { status: 'ignored' })
})

test('a deletion with no usable userId fails loudly rather than silently', { skip }, async () => {
  await seedAUserWithEverything()

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // THE ONE CASE THAT MUST NOT BE SWALLOWED.
  //
  // Every other handler in `inbound.ts` returns quietly on a payload it cannot read, and that is
  // right for a sale: somebody notices a missing sale. Nobody notices a dropped erasure — it has
  // no symptom until a regulator asks — so this one throws, leaves no inbox row, and is
  // redelivered.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  for (const payload of [{}, { userId: 42 }, { userId: 'not-a-uuid' }]) {
    const id = '0192fa00-0000-7000-8000-00000000000a'
    const raw = JSON.stringify({
      id,
      topic: 'identity.user.deleted',
      key: 'k',
      occurredAt: new Date().toISOString(),
      producer: 'identity',
      version: '1.0',
      actor: 'system',
      correlationId: 'req-3',
      payload,
    })
    await assert.rejects(() => handleDelivery(deps(), raw, signed(raw, id)))

    // No inbox row, so the redelivery is processed rather than deduped into oblivion.
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from inbox where event_id = ${id}
    `
    assert.equal(rows[0]?.n, 0)
  }

  // And nothing was half-erased by the attempt.
  const still = await occurrencesOf(ALICE_SUBJECT)
  assert.ok(still.length > 0, 'a rejected delivery must not have erased anything')
})
