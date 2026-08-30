/**
 * The market seam and ward governance — and the two refusals they exist to make provable.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY SCHEMA TEST HERE HITS THE CONSTRAINT DIRECTLY, WITH RAW SQL.**
 *
 * That is the finding this repository already paid for once. Its first pass ran 23 mutations one
 * at a time, and the one that did NOT go red was `tessera_objects_are_their_bytes`: dropping the
 * unique index left the copybot test green, because the test graded an `if` inside `completeFiring`
 * rather than asking the index. A test that exercises a handler proves the handler; only a raw
 * INSERT or UPDATE proves the schema.
 *
 * So each constraint below is tested twice on purpose: once through `activateListing`, which is
 * how a user meets it, and once with a raw statement that bypasses every line of TypeScript in
 * this repository, which is how a bug, a migration, a backfill or an operator with a psql
 * connection meets it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import type postgres from 'postgres'
import {
  ALICE_SUBJECT,
  BOB_SUBJECT,
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
  GRANT_ENTRY_KIND,
  activateListing,
  assertTermsAreIdentical,
  draftListing,
  type ActivateDeps,
} from './economy.ts'
import { checksumOfObjectUrn, objectAssetCode, objectUrn } from './itemasset.ts'
import {
  MARKET_ASSET_KIND,
  MARKET_PRICING_MODE,
  MARKET_SETTLEMENT_MODE,
  createMarketClient,
  type MarketClient,
  type MarketListing,
} from './marketclient.ts'
import {
  WARD_GOVERNANCE_MODEL,
  WARD_JOIN_POLICY,
  WARD_COMMUNITY_KIND,
  createCommunityClient,
  wardCommunitySlug,
} from './communityclient.ts'
import { CLEARING, ENTRY_KINDS, isEntryKind } from '@cloudsforge/contracts-money'
import {
  issuePostings,
  balanceCheck,
  ONE_OBJECT,
  ISSUE_ENTRY_KIND,
  BOOKING_FEE_ENTRY_KIND,
} from './ledgerclient.ts'
import { bindWardCommunity, WorldError } from './world.ts'
import { fromSparks } from './sparks.ts'

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

const PRICE = fromSparks(1_000n)
const COMMUNITY = '99999999-9999-4999-8999-999999999999'

/** A market that behaves. Records what it was asked, so the request itself can be asserted. */
function marketStub(overrides: Partial<MarketListing> = {}) {
  const calls: { path: string; body?: Record<string, unknown> }[] = []
  const answer = (seller: string): MarketListing => ({
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    sellerSubject: seller,
    platformFeeBps: 250,
    royaltyBps: 500,
    status: 'active',
    escrowed: true,
    ...overrides,
  })
  const client: MarketClient = {
    async createListing(input) {
      calls.push({ path: '/v1/listings', body: { sellerToken: input.sellerToken } })
      return { ...answer(ALICE_SUBJECT), status: 'draft' }
    },
    async activate(input) {
      calls.push({ path: 'activate', body: { sellerToken: input.sellerToken } })
      return answer(ALICE_SUBJECT)
    },
    async find() {
      return answer(ALICE_SUBJECT)
    },
  }
  return { calls, client }
}

function depsWith(market: ActivateDeps['market'], issued: string[] = []): ActivateDeps {
  return {
    market,
    issueObject: async (input) => {
      issued.push(input.assetCode)
      return { id: 'entry-1', replayed: false }
    },
  }
}

async function seedDraft(royaltyBps = 500, nth = 1): Promise<{ id: string; objectId: string }> {
  await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const objectId = await seedObject(sql, ALICE_SUBJECT, nth)
  const listing = await draftListing(asDb(sql), {
    objectId,
    sellerSubject: ALICE_SUBJECT,
    priceWei: PRICE,
    royaltyBps,
    correlationId: 'req-1',
  })
  return { id: listing.id, objectId }
}

/* ────────────────────────────────────────────────────── the object's name is its bytes ── */

test('an object is named by its bytes, and the URN round-trips through the contract', () => {
  const checksum = `sha256:${'ab'.repeat(32)}`
  const urn = objectUrn(checksum)
  assert.equal(urn, `cf:tessera:object:${'ab'.repeat(32)}`)
  // Four colon-separated segments, which is what `parseTitleUrn` demands. The `sha256:` prefix
  // CANNOT be carried into the id — it would make five and fail to parse — and this is the
  // assertion that pins that, because the obvious implementation carries it.
  assert.equal(urn.split(':').length, 4)
  assert.equal(checksumOfObjectUrn(urn), checksum)
  assert.equal(objectAssetCode(checksum), `TOKEN:${urn}`)
})

test('a checksum of any other shape is refused rather than normalised', () => {
  // The checksum IS the object's identity. A client that accepted a bare hex, or an uppercase
  // one, would be the one place two spellings of one object could be born — and market's
  // `item_urn` has no format constraint at all to catch it downstream.
  for (const bad of ['', 'ab'.repeat(32), `sha256:${'AB'.repeat(32)}`, 'sha256:short', 'md5:x']) {
    assert.throws(() => objectUrn(bad), WorldError, `expected ${bad} to be refused`)
  }
})

/* ──────────────────────────────────────────────── the fee is not a field this service sends ── */

test('the market request has no fee field, and the key set is pinned against a literal', () => {
  // §7.2's fifth refusal, at the only place a per-account fee could be REQUESTED. Market reads
  // its fee from its own environment (`market/src/server.ts`) and there is no body field it
  // would read one from — so this asserts Tessera cannot even ask.
  //
  // Read out of the source rather than out of a call, because a stub records what the client
  // chose to tell it and this must catch a field added to the literal itself.
  const source = stripComments(readFileSync(new URL('./marketclient.ts', import.meta.url), 'utf8'))
  const opened = source.indexOf('body: {', source.indexOf(`'/v1/listings'`))
  assert.notEqual(opened, -1, 'the create-listing request body could not be found')
  const body = source.slice(opened, source.indexOf('\n        },', opened))
  const sent = [...body.matchAll(/^ {10}([a-zA-Z]+):/gm)].map((m) => m[1])
  assert.deepEqual(sent.sort(), [
    'assetCode',
    'assetKind',
    'itemAssetCode',
    'itemUrn',
    'price',
    'pricingMode',
    'quantity',
    'royaltyBps',
    'settlementMode',
  ])
  assert.ok(!sent.includes('platformFeeBps'), 'Tessera must never send micro-market a platform fee')
  assert.ok(!sent.includes('sellerSubject'), 'the seller comes from the token, never from the body')
})

test('the listing modes are constants, not parameters — custodial is the only mode royalties exist in', () => {
  assert.equal(MARKET_ASSET_KIND, 'game_item')
  assert.equal(MARKET_PRICING_MODE, 'fixed')
  // §8.5: for an `onchain` listing "the royalty is recorded on the order row and NEVER POSTED".
  assert.equal(MARKET_SETTLEMENT_MODE, 'custodial')
})

/* ─────────────────────────────────────────────────────────── the seam, against a real database ── */

test('activating issues the object, lists at market, and records what market agreed to', { skip }, async () => {
  const draft = await seedDraft()
  const issued: string[] = []
  const market = marketStub()
  const listing = await activateListing(asDb(sql), depsWith(market.client, issued), {
    listingId: draft.id,
    sellerSubject: ALICE_SUBJECT,
    sellerToken: 'the-sellers-own-token',
    correlationId: 'req-1',
  })

  assert.equal(listing.status, 'active')
  assert.equal(listing.marketListingId, 'aaaaaaaa-0000-4000-8000-000000000001')
  // The terms micro-market will actually sell under, stored so they can be checked rather than
  // trusted. This is the whole point of the column.
  assert.deepEqual(listing.marketTerms, {
    sellerSubject: ALICE_SUBJECT,
    platformFeeBps: 250,
    royaltyBps: 500,
  })

  // The object was issued BEFORE market was asked to reserve it — §8.5's "a Tessera object must be
  // ledger-reservable under an item_asset_code before it can go live".
  assert.deepEqual(issued, [`TOKEN:cf:tessera:object:${'01'.repeat(32)}`])

  // Both market calls carried the SELLER's token, not a service credential. If this ever reads a
  // service credential, market records `service:tessera` as the seller and pays Tessera instead
  // of the creator.
  assert.deepEqual(
    market.calls.map((c) => c.body?.['sellerToken']),
    ['the-sellers-own-token', 'the-sellers-own-token'],
  )
})

test('a listing another player drafted cannot be activated by relaying your own token', { skip }, async () => {
  const draft = await seedDraft()
  await assert.rejects(
    activateListing(asDb(sql), depsWith(marketStub().client), {
      listingId: draft.id,
      sellerSubject: BOB_SUBJECT,
      sellerToken: 'bobs-token',
      correlationId: 'req-1',
    }),
    (err: WorldError) => err.code === 'not_found',
  )
})

test('a draft is not activated twice', { skip }, async () => {
  const draft = await seedDraft()
  const deps = depsWith(marketStub().client)
  const input = {
    listingId: draft.id,
    sellerSubject: ALICE_SUBJECT,
    sellerToken: 'tok',
    correlationId: 'req-1',
  }
  await activateListing(asDb(sql), deps, input)
  await assert.rejects(activateListing(asDb(sql), deps, input), (err: WorldError) => err.code === 'not_a_draft')
})

/* ─────────────────────────────────── identical terms, proved rather than asserted ── */

test('a market that would take a different fee does not get to sell the object', { skip }, async () => {
  // The refusal §7.2 is about, at the only place it can actually be observed: the terms the sale
  // will happen under, in micro-market's database, compared with this one's.
  const draft = await seedDraft()
  const market = marketStub({ platformFeeBps: 100 })
  await assert.rejects(
    activateListing(asDb(sql), depsWith(market.client), {
      listingId: draft.id,
      sellerSubject: ALICE_SUBJECT,
      sellerToken: 'tok',
      correlationId: 'req-1',
    }),
    (err: WorldError) => err.code === 'market_rate_mismatch',
  )
  // And the listing is still a draft, so the refusal cost the seller nothing. Market's own listing
  // is also still a draft — it "holds nothing and is visible to nobody but their seller" — which
  // is why the check happens between create and activate rather than after.
  const [row] = await sql<{ status: string; market_listing_id: string | null }[]>`
    select status, market_listing_id from listings where id = ${draft.id}
  `
  assert.equal(row?.status, 'draft')
  assert.equal(row?.market_listing_id, null)
})

test('a market that names a different seller does not get to sell the object', { skip }, async () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // THIS IS THE BUG THE WHOLE SEAM IS SHAPED AROUND, REPRODUCED.
  //
  // Calling market with TESSERA_SERVICE_CREDENTIAL rather than the seller's own token makes
  // `subjectOf(principal)` answer `service:tessera` (`market/src/server.ts`), and
  // `market/src/orders.ts` credits sale proceeds to market's own `sellerSubject`. The creator
  // is paid nothing. Nothing throws, nothing logs, the trial balance is correct.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const draft = await seedDraft()
  const market = marketStub({ sellerSubject: 'service:tessera' })
  await assert.rejects(
    activateListing(asDb(sql), depsWith(market.client), {
      listingId: draft.id,
      sellerSubject: ALICE_SUBJECT,
      sellerToken: 'tok',
      correlationId: 'req-1',
    }),
    (err: WorldError) => err.code === 'market_seller_mismatch',
  )
})

test('a market that recorded a different royalty does not get to sell the object', { skip }, async () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // THIS TEST EXISTS BECAUSE ITS ABSENCE WAS CAUGHT BY A MUTATION THAT DID NOT GO RED.
  //
  // Deleting the royalty branch of `assertTermsAreIdentical` left the suite green: the raw-SQL
  // test above proved `listings_market_agrees_on_the_royalty` catches a bad row, and the fee and
  // seller branches each had a handler test, but the royalty branch had none — so the guard was
  // graded only by the schema behind it.
  //
  // That is the same shape as this repository's `tessera_objects_are_their_bytes` finding, in
  // reverse: there, a schema test was really grading a handler; here, a handler branch was really
  // being graded by a constraint. Both are the same mistake — the thing you think you are testing
  // is not the thing being asked.
  //
  // It matters on its own terms too. Without this branch the refusal happens at the UPDATE, AFTER
  // market has already activated a live listing — so the seller ends up with a listing on sale
  // that Tessera disowns, rather than a dead draft that cost them nothing.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const draft = await seedDraft()
  const market = marketStub({ royaltyBps: 900 })
  await assert.rejects(
    activateListing(asDb(sql), depsWith(market.client), {
      listingId: draft.id,
      sellerSubject: ALICE_SUBJECT,
      sellerToken: 'tok',
      correlationId: 'req-1',
    }),
    (err: WorldError) => err.code === 'market_royalty_mismatch',
  )
  const [row] = await sql<{ status: string }[]>`select status from listings where id = ${draft.id}`
  assert.equal(row?.status, 'draft', 'the refusal must leave the seller a dead draft, not a live listing')
})

test('assertTermsAreIdentical takes no subject, so there is nowhere to vary a rate per account', () => {
  // The same shape `platformTerms` uses: a per-account rate would need a parameter here before it
  // needed a column anywhere, so the absence of the parameter is where the refusal is visible.
  assert.equal(assertTermsAreIdentical.length, 2)
  const ours = { platformFeeBps: 250, royaltyBps: 500, sellerSubject: ALICE_SUBJECT }
  assert.doesNotThrow(() =>
    assertTermsAreIdentical(ours, { sellerSubject: ALICE_SUBJECT, platformFeeBps: 250, royaltyBps: 500 }),
  )
})

/* ─────────────────────────── the same three rules, asked of the schema rather than the handler ── */

test('the schema refuses a listing whose market fee differs — raw, past every line of TypeScript', { skip }, async () => {
  const draft = await seedDraft()
  await assert.rejects(
    sql`
      update listings set status = 'active', market_listing_id = 'm-1',
                          market_seller_subject = ${ALICE_SUBJECT},
                          market_platform_fee_bps = 100, market_royalty_bps = 500
       where id = ${draft.id}
    `,
    (err: Error) => err.message.includes('listings_market_agrees_on_the_rate'),
  )
})

test('the schema refuses a listing whose market seller differs — raw', { skip }, async () => {
  const draft = await seedDraft()
  await assert.rejects(
    sql`
      update listings set status = 'active', market_listing_id = 'm-1',
                          market_seller_subject = 'service:tessera',
                          market_platform_fee_bps = 250, market_royalty_bps = 500
       where id = ${draft.id}
    `,
    (err: Error) => err.message.includes('listings_market_agrees_on_the_seller'),
  )
})

test('the schema refuses a listing whose market royalty differs — raw', { skip }, async () => {
  const draft = await seedDraft()
  await assert.rejects(
    sql`
      update listings set status = 'active', market_listing_id = 'm-1',
                          market_seller_subject = ${ALICE_SUBJECT},
                          market_platform_fee_bps = 250, market_royalty_bps = 9
       where id = ${draft.id}
    `,
    (err: Error) => err.message.includes('listings_market_agrees_on_the_royalty'),
  )
})

test('a listing cannot leave draft without bringing market terms back — raw', { skip }, async () => {
  // Without this, the three CHECKs above are vacuous: a row that never recorded market's answer
  // satisfies all of them by holding nulls.
  const draft = await seedDraft()
  await assert.rejects(
    sql`update listings set status = 'active', market_listing_id = 'm-1' where id = ${draft.id}`,
    (err: Error) => err.message.includes('listings_past_draft_records_market_terms'),
  )
})

/* ──────────────────────────────────────────────────────────────────── ward governance ── */

test('a ward is bound to one community, and binding is a compare-and-set', { skip }, async () => {
  const wardId = await seedWard(sql)
  const bound = await bindWardCommunity(asDb(sql), wardId, COMMUNITY)
  assert.equal(bound.communityId, COMMUNITY)
  await assert.rejects(
    bindWardCommunity(asDb(sql), wardId, '88888888-8888-4888-8888-888888888888'),
    (err: WorldError) => err.code === 'already_governed',
  )
})

test('one community governs one ward — raw, because inbound.ts UPDATEs every ward that shares one', { skip }, async () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // `inbound.ts` applies an executed ward proposal with
  //     update wards set name = ... where community_id = <payload.communityId>
  // and there is no LIMIT on it. Two wards sharing a community means one `parameter_change`
  // renames BOTH — a community voting on somebody else's ward without either side noticing.
  // A partial unique index is what makes "the ward this community governs" a singular phrase.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const first = await seedWard(sql, 'commons')
  const second = await seedWard(sql, 'wharfside', 'wharf')
  await bindWardCommunity(asDb(sql), first, COMMUNITY)
  await assert.rejects(
    sql`update wards set community_id = ${COMMUNITY} where id = ${second}`,
    (err: Error) => err.message.includes('tessera_one_ward_per_community'),
  )
})

test('a ward\'s government cannot be re-pointed — raw', { skip }, async () => {
  // Re-pointing transfers who governs a ward, to everybody already holding a parcel in it,
  // without a vote in either community. It is the one edit to this column that is never a fix.
  const wardId = await seedWard(sql)
  await bindWardCommunity(asDb(sql), wardId, COMMUNITY)
  await assert.rejects(
    sql`update wards set community_id = '88888888-8888-4888-8888-888888888888' where id = ${wardId}`,
    (err: Error) => err.message.includes('re-pointing it at'),
  )
  // Unbinding is allowed: a community that is archived must be able to leave, and null is the
  // state every ward is minted in.
  await sql`update wards set community_id = null where id = ${wardId}`
})

test('a community id that is not a uuid is refused, because inbound.ts joins on it — raw', { skip }, async () => {
  const wardId = await seedWard(sql)
  await assert.rejects(
    sql`update wards set community_id = 'ward-commons' where id = ${wardId}`,
    (err: Error) => err.message.includes('wards_community_id_is_a_uuid'),
  )
})

test('a ward asks micro-community for one member one vote, and for no gate', () => {
  // §7.1's second refusal, by name. `WeightResolver` is a typed seam in community with exactly one
  // implementation returning 1n, and Tessera must never wire a token-weighted one.
  assert.equal(WARD_GOVERNANCE_MODEL, 'one_member_one_vote')
  assert.equal(WARD_COMMUNITY_KIND, 'public')
  assert.equal(WARD_JOIN_POLICY, 'open')
  const source = stripComments(readFileSync(new URL('./communityclient.ts', import.meta.url), 'utf8'))
  // A `gate` on the community is a ward you buy your way into. It is absent from the request, and
  // community only reaches `parseGate` when the field is present.
  assert.ok(!/\bgate:/.test(source), 'a ward must not be created with a token gate')
  assert.ok(!/token_weighted|reputation_weighted|multisig_threshold/.test(source))
})

test('a ward community slug satisfies community\'s own CHECK', () => {
  const CHECK = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/
  for (const ward of ['commons', 'wharfside', 'a', 'the-glasshouse', 'x'.repeat(80)]) {
    assert.match(wardCommunitySlug(ward), CHECK, `${ward} produced an unusable slug`)
  }
})

/* ───────────────────────────────────────── tessera grows no second voting system ── */

test('Tessera has no governance machinery of its own — asserted as an absence, with force', () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §10: putting the effect in Tessera "keeps the change count in micro-community at zero and
  // puts the game logic in the game". The converse obligation is this one: Tessera stores a
  // community id and applies executed decisions, and implements NONE of the deciding.
  //
  // Written as a scan for the TABLES and the ROUTES, not for the words. A test that forbade the
  // string "vote" would fire on the paragraph explaining why there are no votes — which is the
  // shape three guards in this repository already had, and were fixed for.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const migrations = stripComments(readFileSync(new URL('./migrations.ts', import.meta.url), 'utf8'))
  for (const table of ['proposals', 'votes', 'ballots', 'delegations', 'officers', 'timelocks', 'tallies']) {
    assert.ok(
      !new RegExp(`create table if not exists ${table}\\b`).test(migrations),
      `micro-community already has ${table}; a second one is a second answer to "who decided this"`,
    )
  }
  const server = stripComments(readFileSync(new URL('./server.ts', import.meta.url), 'utf8'))
  for (const route of ['/proposals', '/votes', '/tally', '/delegations']) {
    assert.ok(!server.includes(route), `${route} belongs to micro-community`)
  }
})

/* ─────────────────────────────────────────────────────── issuing the object into the ledger ── */

test('an object is issued liability-to-its-author against a clearing counterparty', () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // The counterparty type is the whole safety argument and it is the OPPOSITE of the engagement
  // account's. `engagement:tessera` is `equity` precisely so the ledger refuses an unfunded grant
  // (§8.3). An issuance account must be ALLOWED to go negative — the negative is the count of the
  // object in circulation — and `clearing` is the only type `ledger_assert_no_overdraft` returns
  // early for. Using `equity` here would make it impossible to sell anything; using `liability`
  // on both sides would make it impossible to issue anything.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const assetCode = objectAssetCode(`sha256:${'01'.repeat(32)}`)
  const postings = issuePostings(ALICE_SUBJECT, assetCode)
  assert.equal(postings.length, 2)
  const [debit, credit] = postings
  assert.equal(debit?.direction, 'debit')
  assert.equal(debit?.account.subject, 'clearing')
  assert.equal(debit?.account.type, 'clearing')
  // Pinned to the CONTRACT's singleton, because `objectIssuer` writes the literal rather than
  // importing `CLEARING` — micro-conformance's sweep cannot follow an imported constant into an
  // account literal, and an account it cannot read is one it cannot reconcile against the estate.
  // This assertion is what makes the literal safe: the contract is still the authority.
  assert.equal(debit?.account.subject, CLEARING)
  // `suspense`, NOT `treasury`. `treasury` is equity/asset/liability everywhere in this estate and
  // never `clearing`; micro-conformance's chart rejected the old spelling as implausible. This
  // matches `trade/src/ledgerclient.ts`, which posts clearing/suspense/clearing already.
  // `ledger_assert_no_overdraft` exempts both `type = 'clearing'` and `purpose = 'suspense'`
  // (ledger/src/migrations.ts, :467), so the negative this account must reach is still legal.
  assert.equal(debit?.account.purpose, 'suspense')
  assert.equal(credit?.direction, 'credit')
  assert.equal(credit?.account.subject, ALICE_SUBJECT)
  assert.equal(credit?.account.type, 'liability')
  assert.equal(credit?.account.purpose, 'available')
  // One object is one indivisible unit. Not wei — a TOKEN: item has no decimals, and issuing
  // 10^18 of a chair would let it be sold 10^18 times.
  assert.equal(credit?.amount, ONE_OBJECT)
  assert.equal(ONE_OBJECT, 1n)
  // Balanced before the socket opens, by the contract's own check.
  assert.doesNotThrow(() => balanceCheck(postings))
})

test('the issuance kind is one the LEDGER will actually accept', () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // micro-org#407 §3. `item_issue` was written into this client and into nothing else: it was in
  // neither `ENTRY_KINDS` nor micro-ledger's `journal_entries_kind_chk`, so `validateEntryRequest`
  // answered every issuance `400 invalid_entry` before it opened a transaction and no object was
  // ever brought into the books. The test the estate already had for exactly this — "the grant
  // kind is one the LEDGER will actually accept", in contracts-money, written after
  // `foresight.settlement_fee` posted nothing for months — was never given a Tessera counterpart.
  // This is it. Spelling is not the assertion; MEMBERSHIP is.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  assert.equal(ISSUE_ENTRY_KIND, 'item_issue')
  assert.ok(isEntryKind(ISSUE_ENTRY_KIND), 'the issuance kind must be in the closed vocabulary')
  assert.ok(ENTRY_KINDS.includes(ISSUE_ENTRY_KIND))
  // Every kind this client posts, on the same footing. A future call site that invents one is now
  // a compile error (`PostEntryRequest.kind` is `EntryKind`), and this is the belt to that brace.
  for (const kind of [ISSUE_ENTRY_KIND, BOOKING_FEE_ENTRY_KIND, GRANT_ENTRY_KIND]) {
    assert.ok(isEntryKind(kind), `${kind} is not in the ledger's closed set`)
  }
})

test('the estate had no other TOKEN: spelling to match, so this one is pinned', () => {
  // Verified rather than assumed when this was written: no service in the estate credited a
  // `TOKEN:` balance before Tessera. `ledger/src/accounts.ts` throws on a type mismatch against
  // an existing account and whichever service posts SECOND has every entry refused — so this is
  // the spelling the next service has to match, and it is pinned here rather than discovered.
  assert.equal(objectAssetCode(`sha256:${'0a'.repeat(32)}`), `TOKEN:cf:tessera:object:${'0a'.repeat(32)}`)
})

/* ──────────────────────────────────────────────────────── the client talks to real routes ── */

/**
 * The half of the pin that lives in THIS repository, and therefore always runs.
 *
 * Split out from the cross-checkout half below because the two have different preconditions and
 * only one of them can go unmeasured. If this file only ever asserted the sibling side, a CI job
 * without the siblings would check nothing at all about the paths this client requests.
 */
test('this client requests the paths this repository claims it requests', () => {
  const client = stripComments(readFileSync(new URL('./marketclient.ts', import.meta.url), 'utf8'))
  assert.ok(client.includes(`'/v1/listings'`))
  assert.ok(client.includes('/activate'))
})

/**
 * The other half: the routes the siblings actually serve.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * The @cloudsforge/ui defect, refused. It posted the SSO callback to `/auth/exchange`, a route
 * identity has never served, and the test pinning it compared the URL against a copy of itself so
 * it could never fail. This reads micro-market's and micro-community's OWN server sources and
 * asserts they define every path this client calls. It cannot pass against a route that does not
 * exist, because the other side of the comparison is the other repository.
 *
 * ── A MISSING SIBLING IS A SKIP, AND NEVER A `return` ────────────────────────────────────────
 *
 * It used to be neither: `readFileSync` on a checkout that is not there threw ENOENT and FAILED
 * the run — `not ok 89 … ENOENT … /market/src/server.ts` in this repository's first honest CI run.
 * micro-org's service workflow checks out micro-runtime and micro-contracts and no other sibling,
 * so a per-service job has neither of the two repositories this test compares against.
 *
 * A red run for "the estate is not all here" is the same lie as a green one for work that never
 * happened: both say something about micro-market that this job did not measure. So it skips, and
 * `t.skip()` rather than `return` — `return` marks it GREEN, which is the failure `citations.test.ts`
 * opens by naming and the reason `citeIfPresent` exists at all. Where the siblings ARE present —
 * an estate checkout, and `deploy/scripts/estate-verify.sh` — every assertion below runs unchanged.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
test('the client calls the routes micro-market actually serves, read from its source', (t: TestContext) => {
  const marketPath = new URL('../../market/src/server.ts', import.meta.url)
  const communityPath = new URL('../../community/src/server.ts', import.meta.url)
  const absent = [marketPath, communityPath].filter((path) => !existsSync(path))
  if (absent.length > 0) {
    t.skip(
      `not checked out beside this repository: ${absent.map((path) => path.pathname).join(', ')} — ` +
        'this pin compares against the other repository, so a job with one checkout cannot resolve it',
    )
    return
  }

  const marketServer = readFileSync(marketPath, 'utf8')
  assert.ok(marketServer.includes(`define('POST', '/v1/listings'`), 'market must serve POST /v1/listings')
  assert.ok(
    marketServer.includes(`define('POST', '/v1/listings/:id/activate'`),
    'market must serve POST /v1/listings/:id/activate',
  )
  assert.ok(marketServer.includes(`define('GET', '/v1/listings/:id'`), 'market must serve GET /v1/listings/:id')

  const communityServer = readFileSync(communityPath, 'utf8')
  assert.ok(
    communityServer.includes(`define('POST', '/v1/communities'`),
    'community must serve POST /v1/communities',
  )
})

/**
 * Every source file this seam adds is REACHABLE from the composition root — walked, not assumed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * This used to read `index.ts` alone and demand that it name each client file, which was true when
 * the root constructed all three inline. micro-org #222 moved that construction into
 * `upstreams.ts`, because wiring in the composition root is wiring no test can reach: `index.ts`
 * opens a pool, asserts a schema and calls `listen()`, so a test importing it starts a server —
 * which is exactly how a service that authenticated once at boot and died ten minutes later kept a
 * green suite. See `upstreams.ts`'s header and `servicetoken.test.ts`.
 *
 * So the check now walks the edge it always MEANT: root → upstreams → client. One hop of hard-coded
 * layout became two hops of followed imports, which is a stronger claim rather than a relaxed one —
 * it fails both when a client stops being constructed AND when `upstreams.ts` stops being wired
 * into the root, and the second of those is the failure that would silently restore the defect.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('every source file this seam adds is reachable from the composition root', () => {
  const read = (mod: string): string => readFileSync(new URL(`./${mod}`, import.meta.url), 'utf8')

  // Hop one. The root must still reach the module that does the constructing, or the walk below is
  // a walk over dead code. Wave M5b: tessera's composition root is `module.ts` (the
  // `createTesseraModule` factory) now, not `index.ts` — the merged process's `../index.ts` builds
  // twelve modules. The factory still builds this module's upstreams, so the seam walk is unchanged.
  const root = read('module.ts')
  assert.ok(root.includes('./upstreams.ts'), 'the composition root no longer builds its upstreams')
  assert.ok(root.includes('buildUpstreams('), 'upstreams.ts is imported but never called')

  // Hop two. Reachable through EITHER file: `ledgerclient.ts` and `communityclient.ts` are also
  // imported by the root directly, for `issueObjectToAuthor`, `walletOf` and `wardCommunitySlug`.
  const upstreams = read('upstreams.ts')
  for (const mod of ['marketclient.ts', 'communityclient.ts', 'ledgerclient.ts', 'studioclient.ts']) {
    assert.ok(
      root.includes(`./${mod}`) || upstreams.includes(`./${mod}`),
      `${mod} is never constructed, so it is never used`,
    )
  }
  // And each client is actually CONSTRUCTED somewhere on that path, not merely imported for a type.
  for (const factory of [
    'createMarketClient(',
    'createCommunityClient(',
    'createLedgerClient(',
    'createStudioClient(',
  ]) {
    assert.ok(upstreams.includes(factory), `${factory}) is never called, so that upstream is dead`)
  }

  // itemasset.ts is reached through economy.ts rather than the root; assert that rather than
  // leaving it looking unreferenced.
  const economy = read('economy.ts')
  assert.ok(economy.includes('./itemasset.ts'))
  assert.ok(readdirSync(new URL('.', import.meta.url)).includes('itemasset.ts'))
})
