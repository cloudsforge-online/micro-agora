/**
 * The right to erasure (GDPR Art. 17), for a title whose foreign keys forbid the obvious answer.
 *
 * Rule 6 of docs/ecosystem/03 §2: every service storing a `user_id` subscribes to
 * `identity.user.deleted` and erases. Tessera did not, and a deletion request therefore reported
 * success while leaving every parcel, object, listing, booking and visit exactly where it was.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT `delete from accounts` — AND WHY IT IS NOT A CASCADE EITHER.
 *
 * NINE columns carry `references accounts (subject) on delete restrict`. So the account row
 * cannot be deleted while any of them still points at it: the database refuses, with 23503.
 *
 * The lazy repair is to flip those nine to `on delete cascade`, and it is catastrophic. A cascade
 * from `objects` reaches `placements.object_id`, which is ITSELF `on delete restrict` — deleting
 * an author would delete their objects, and deleting their objects would take the chairs out of
 * the parcels of every OTHER player who ever placed one. One person's erasure would silently
 * demolish strangers' homes. Art. 17(3)(e) and the "rights and freedoms of others" limb of
 * Art. 17(1) exist for precisely this collision, and they resolve it against the cascade.
 *
 * So: **REPOINT, THEN DELETE.** One random placeholder account is minted per erasure, every
 * retained row is moved onto it, and the person's row is then deleted for real.
 *
 * THE PLACEHOLDER IS RANDOM, NEVER DERIVED. `erased:${randomUUID()}` — not a hash of the user id,
 * because the candidate set of user ids is enumerable and a hash over an enumerable set is a
 * lookup table, not an anonymisation. Nothing in this service, and nothing anywhere else in the
 * estate, stores the mapping from placeholder back to person. There is no query that undoes this.
 *
 * ONE PLACEHOLDER FOR ALL OF ONE USER'S RETAINED ROWS, DELIBERATELY. It means the rows a user
 * left behind remain linked TO EACH OTHER: an observer can still see that the same someone owned
 * this parcel and fired that object. That is unavoidable the moment the rows are retained at all
 * — a per-row placeholder would break `parcels`/`placements` coherence and would still be
 * defeated by joining on parcel geometry and timestamps. What the single placeholder guarantees
 * is the property that actually matters: those rows link to NO PERSON. The linkage is
 * pseudonymous and terminal, and migration 15's one-way triggers are what make "terminal" true
 * rather than aspirational.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY TABLE IN THIS SERVICE THAT HOLDS A SUBJECT, AND WHAT HAPPENS TO IT.
 *
 * | table                       | action              | reasoning + lawful basis if retained      |
 * |-----------------------------|---------------------|-------------------------------------------|
 * | `entitlements`              | DELETE              | Grants to a person who no longer exists,   |
 * |                             |                     | and micro-billing holds the authoritative  |
 * |                             |                     | purchase record. NOTHING references        |
 * |                             |                     | `entitlements`, so deleting costs nothing  |
 * |                             |                     | and retaining would be hoarding. When the  |
 * |                             |                     | honest answer is delete, delete.           |
 * | `listings` (status `draft`) | DELETE              | Unpublished, never offered, no             |
 * |                             |                     | counterparty, no settlement, no royalty.   |
 * |                             |                     | There is no basis to keep a private draft. |
 * | `listings` (any other)      | anonymise + RETAIN  | Art. 17(3)(b), legal obligation. A         |
 * |                             |                     | published or sold listing is joined to     |
 * |                             |                     | settlement records held in micro-ledger    |
 * |                             |                     | and micro-market; deleting this half       |
 * |                             |                     | orphans a financial record without         |
 * |                             |                     | erasing it. BOTH `seller_subject` and      |
 * |                             |                     | `market_seller_subject` move — the row     |
 * |                             |                     | holds the subject twice and a CHECK ties   |
 * |                             |                     | the two together. See the statement below. |
 * | `presence`                  | DELETE              | An ephemeral live position in a ward. No   |
 * |                             |                     | invariant depends on it, no other player   |
 * |                             |                     | is owed it, nobody is standing there any   |
 * |                             |                     | more. No basis to keep it, so it goes.     |
 * | `visits`                    | anonymise, NOT      | Footfall is half the discovery ranking     |
 * |                             | delete              | function (§6.5) and one leg of the fallow  |
 * |                             |                     | clock (§4). DELETING these rows would      |
 * |                             |                     | retroactively lower a parcel's footfall    |
 * |                             |                     | and move OTHER people's search ranking     |
 * |                             |                     | and reclaim dates, years after the fact.   |
 * |                             |                     | The count survives; the identity does not. |
 * | `provisions`                | anonymise BOTH      | Art. 17(3)(b). This is the idempotency     |
 * |                             | `subject` AND       | record that stops a second Private Ward    |
 * |                             | `user_id`, RETAIN   | being raised for one payment (§11.8), and  |
 * |                             |                     | it is a purchase record. It holds the      |
 * |                             |                     | user id as a `uuid` column as well as the  |
 * |                             |                     | ledger spelling, so BOTH must be cleared   |
 * |                             |                     | — clearing one would leave the person      |
 * |                             |                     | named in the other.                        |
 * | `accounts`                  | anonymise           | The row survives only as the placeholder   |
 * |                             |                     | the nine restrict FKs demand exist. It     |
 * |                             |                     | carries no personal data beyond the        |
 * |                             |                     | subject itself once minted fresh (see      |
 * |                             |                     | `insert into accounts` below — the erased  |
 * |                             |                     | person's `deed_slots` and `created_at` are |
 * |                             |                     | NOT copied across).                        |
 * | `parcels.owner_subject`     | anonymise           | A land registry must not forget who holds  |
 * |                             |                     | a parcel — an ownerless held parcel is a   |
 * |                             |                     | tile nobody can claim and nobody can use.  |
 * |                             |                     | The fallow mechanic (§4) reclaims it       |
 * |                             |                     | naturally instead: no footfall and no      |
 * |                             |                     | edits, so the clock runs out and the land  |
 * |                             |                     | returns to the commons on its own.         |
 * | `contests.challenger_`      | anonymise           | Two-sided. The contest is also a record    |
 * | `subject`                   |                     | ABOUT the parcel owner who was challenged, |
 * |                             |                     | and they retain a right to the record of a |
 * |                             |                     | challenge made against their title.        |
 * | `objects.author_subject`    | anonymise, NEVER    | `placements.object_id references objects   |
 * |                             | delete              | on delete restrict`: deleting the object   |
 * |                             |                     | would destroy other users' parcels.        |
 * |                             |                     | Art. 17(3)(e) / the rights and freedoms of |
 * |                             |                     | others in Art. 17(1) — buyers and placers  |
 * |                             |                     | built on this. Authorship is final         |
 * |                             |                     | (`objects_authorship_is_final`), so the    |
 * |                             |                     | column is repointed, not blanked.          |
 * | `placements.placed_by`      | anonymise           | A parcel owner's world composition must    |
 * |                             |                     | not silently change because a visitor who  |
 * |                             |                     | once placed something asked to be erased.  |
 * | `bookings.booked_by`        | anonymise, RETAIN   | Art. 17(3)(b) plus others' rights. An open |
 * |                             |                     | booking holds an ESCROWED LEDGER           |
 * |                             |                     | RESERVATION (`reservation_id`); deleting   |
 * |                             |                     | the row strands real money in `reserved`   |
 * |                             |                     | with nothing left to release it, and the   |
 * |                             |                     | venue owner is owed the record of who has  |
 * |                             |                     | their calendar.                            |
 * | `engagement_grants.`        | anonymise, RETAIN   | Art. 17(3)(b). An accounting record of     |
 * | `beneficiary`               |                     | value transferred out of the platform      |
 * |                             |                     | treasury (§8.3). `idempotency_key` names a |
 * |                             |                     | PAYMENT, not a person, so it needs no      |
 * |                             |                     | treatment; `ledger_entry_id` points at the |
 * |                             |                     | posting that must still balance.           |
 * | `outbox.actor` +            | anonymise, RETAIN   | NOT IN THE ORIGINAL DESIGN FOR THIS WORK,  |
 * | `outbox.payload`            | the row             | and it is the hole that would have made    |
 * |                             |                     | the rest of this file cosmetic. The outbox |
 * |                             |                     | is NEVER PURGED — `relay` sets             |
 * |                             |                     | `published_at` and the row stays for ever  |
 * |                             |                     | (`outbox.ts`) — and it stores          |
 * |                             |                     | `actor = 'user:<uuid>'` plus the subject   |
 * |                             |                     | again inside `payload`                     |
 * |                             |                     | (`world.ts`,           |
 * |                             |                     | `economy.ts`, `kiln.ts`).          |
 * |                             |                     | So after erasing everything else,          |
 * |                             |                     | `select actor, payload from outbox` would  |
 * |                             |                     | still hand an observer the person's        |
 * |                             |                     | subject NEXT TO the parcel and object ids  |
 * |                             |                     | now owned by the placeholder — a complete  |
 * |                             |                     | re-identification join, in this database,  |
 * |                             |                     | undoing the erasure in one query. The row  |
 * |                             |                     | itself is retained rather than deleted: an |
 * |                             |                     | unpublished row is an event a subscriber   |
 * |                             |                     | is owed, and a published one is the record |
 * |                             |                     | `outbox_deliveries` cascades from. The     |
 * |                             |                     | event still describes the parcel and the   |
 * |                             |                     | ward; it no longer names the person.       |
 * | `beacons.lit_by`            | anonymise           | The 3-per-parcel-per-7-days limit (§6.5)   |
 * |                             |                     | counts by `parcel_id` and `lit_at`, so     |
 * |                             |                     | DELETING these rows would hand the         |
 * |                             |                     | parcel's current holder extra Beacons —    |
 * |                             |                     | an erasure request would become a way to   |
 * |                             |                     | buy rate limit. `headline` is content      |
 * |                             |                     | ABOUT A PARCEL ("the forge is open"), not  |
 * |                             |                     | about its author, so it is retained as     |
 * |                             |                     | written; if a headline ever became         |
 * |                             |                     | free-form personal prose this decision     |
 * |                             |                     | would have to be revisited.                |
 *
 * `wards`, `parcels` (beyond the owner), `objects` (beyond the author), `inbox`,
 * `outbox_deliveries`, `event_subscriptions` and `jobs` hold no subject and are untouched —
 * `inbox` is `(topic, event_id, received_at)` and the other three carry only ids, urls and
 * counters. That was checked column by column rather than assumed, which is how `outbox` above
 * was found.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from 'node:crypto'
import type { Tx } from './outbox.ts'

/**
 * The uuid identity actually emits. Deliberately the same shape `server.ts` accepts, and checked
 * before anything is written: `user:<not a uuid>` would match no row, and an erasure that
 * silently matched nothing is the exact failure this whole file exists to end.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Repoint the person's visits onto the placeholder.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS RUNS AFTER THE ACCOUNT WORK, NOT BEFORE IT, AND THE ORDER IS NOT COSMETIC.**
 *
 * `visits` has no foreign key at all, so the obvious place for it is up with the other FK-free
 * tables — and putting it there makes every erasure of a parcel-owning user fail at COMMIT with
 * `no tessera account for user:<uuid>`. The path is three triggers deep and worth writing down,
 * because nothing about the statement below suggests it touches `accounts`:
 *
 *   1. `visits_touch_parcel` is an AFTER INSERT OR UPDATE trigger on `visits` (migration 7). It
 *      fires on this UPDATE and runs `update parcels set last_footfall_at = ...`.
 *   2. That write to `parcels` queues `parcels_within_deed_slots` (migration 4), which is
 *      `deferrable initially deferred` — so it does not run now, it runs at COMMIT, holding the
 *      row as it was when queued. At that moment the parcel is still owned by the PERSON.
 *   3. By COMMIT, `delete from accounts where subject = <person>` has run. The deferred check
 *      looks up the person's `deed_slots`, finds no row, and raises.
 *
 * Running last means step 2 queues the check against the PLACEHOLDER, which exists and holds the
 * copied `deed_slots`. The erasure is one transaction either way; only the order differs.
 *
 * The `visits_touch_parcel` write is a no-op in VALUE — `last_seen_at` does not change, so
 * `greatest(last_footfall_at, new.last_seen_at)` returns what was already there. Footfall does
 * not move, which is the whole reason these rows are anonymised instead of deleted. It is a no-op
 * that still queues a constraint check, which is exactly why this was not obvious.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function anonymiseVisits(
  tx: Tx,
  subject: string,
  placeholder: string,
): Promise<readonly unknown[]> {
  return await tx`
    update visits set visitor_subject = ${placeholder}
     where visitor_subject = ${subject}
     returning parcel_id
  `
}

/**
 * What was erased, as COUNTS AND NOTHING ELSE.
 *
 * No subject, no user id, no placeholder. A log line naming the person whose data was just erased
 * — or naming the placeholder they were mapped to, which is worse, because it is the mapping —
 * would put the erased identity into the log pipeline, where it is retained on a schedule this
 * service does not control and cannot honour a second erasure against.
 */
export interface ErasureCounts {
  readonly entitlements: number
  readonly draftListings: number
  readonly presence: number
  readonly visits: number
  readonly provisions: number
  readonly outboxEvents: number
  readonly parcels: number
  readonly contests: number
  readonly objects: number
  readonly placements: number
  readonly listings: number
  readonly bookings: number
  readonly engagementGrants: number
  readonly beacons: number
  /** 1 when this service held an account for the user, 0 when it never saw them. */
  readonly accounts: number
}

/**
 * Erase one user. Runs INSIDE the caller's inbox transaction, so a partial erasure is impossible:
 * either every table below moved or none did, and a failure leaves no inbox row and is therefore
 * redelivered rather than swallowed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE FINAL `delete from accounts` IS THE COMPLETENESS CHECK, AND IT IS NOT A COMMENT.**
 *
 * Because all nine referencing columns are `on delete restrict`, that last statement RAISES 23503
 * if this function missed a single table. A checklist in a header rots the moment somebody adds a
 * tenth `references accounts` column; the delete does not. `erasure.test.ts` seeds a user with a
 * row in EVERY referencing table and then erases, so the DATABASE proves total coverage — and a
 * future migration that adds a tenth referencing column will fail that test on the day it lands
 * rather than on the day a regulator asks.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function eraseUser(tx: Tx, userId: string): Promise<ErasureCounts> {
  if (!UUID.test(userId)) {
    // Loud, not silent. This throws out of `withInbox`, so no inbox row is written and the
    // producer redelivers. A dropped erasure request is a compliance breach nobody would notice;
    // a retrying relay is a page. The value is not in the message — it may be a real user id.
    throw new Error('identity.user.deleted carried a userId that is not a uuid')
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // THE LEDGER SPELLING. Identity's payload carries a BARE UUID; every subject column in this
  // service holds `user:<uuid>` — `accounts_subject_is_a_user`, `presence_is_a_person` and
  // `tessera_footfall_is_never_synthetic` all say so in DDL. The conversion is explicit and on
  // one line rather than interpolated at nine call sites, because the estate already has the scar
  // for getting this wrong in the other direction: custody registered its ceremony topics
  // `keyedBy: 'user_id'` while the emit sites passed the ADDRESS, so every export event was filed
  // against a user that does not exist (`topics.ts`). An erasure that ran against a bare
  // uuid would match nothing, touch nothing, and report success.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const subject = `user:${userId}`

  // Random, minted here, never stored anywhere but in the rows it lands on. See the header.
  const placeholder = `erased:${randomUUID()}`

  /* ------------------------------------------------------- delete what has no basis to survive */

  const entitlements = await tx`delete from entitlements where subject = ${subject} returning id`

  // The split the header argues for: a draft was never offered to anybody, so there is no
  // counterparty and no settlement record for it to be joined to.
  const draftListings = await tx`
    delete from listings where seller_subject = ${subject} and status = 'draft' returning id
  `

  const presence = await tx`delete from presence where subject = ${subject} returning subject`

  /* ------------------------------------------------ anonymise the tables that carry no FK ... */

  // BOTH identifying columns, in one statement. `provisions.user_id` is a `uuid` column holding
  // the bare id while `subject` holds the ledger spelling, so clearing either one alone would
  // leave the person named in the other — and `gen_random_uuid()` rather than a derived value for
  // the same reason the placeholder is random. Matched on EITHER column: a row written with only
  // one of the two spellings still belongs to this person and must still be cleared.
  const provisions = await tx`
    update provisions
       set subject = ${placeholder}, user_id = gen_random_uuid()
     where subject = ${subject} or user_id = ${userId}::uuid
     returning entitlement_id
  `

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // THE OUTBOX, WHICH IS NEVER PURGED AND WOULD OTHERWISE UNDO EVERYTHING ABOVE.
  //
  // A textual replace over the SERIALISED jsonb, rather than a per-topic list of payload keys.
  // The keys differ by topic — `ownerSubject`, `authorSubject`, `sellerSubject`,
  // `challengerSubject`, `bookedBy` — and a hand-written list of them is a list that goes stale
  // the first time a topic gains a field, silently, in the one table where a miss is a
  // re-identification key rather than a cosmetic defect.
  //
  // The replace is exact and cannot corrupt the JSON. Both `user:<uuid>` and `erased:<uuid>` are
  // ASCII letters, digits, `:` and `-` — characters that JSON serialises verbatim, so neither
  // string can span an escape sequence or a quote, and neither can appear as a key. And because
  // every subject is a fixed-length uuid, `user:<uuid>` can never be a proper prefix of a
  // different subject, so there is no over-match either.
  //
  // `strpos` rather than `like`: a LIKE pattern would give `_` and `%` wildcard meaning, and
  // although no uuid contains either today, a matcher whose correctness depends on that is a
  // matcher waiting for the id format to change.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const outboxEvents = await tx`
    update outbox
       set actor = case when actor = ${subject} then ${placeholder} else actor end,
           payload = replace(payload::text, ${subject}, ${placeholder})::jsonb
     where actor = ${subject} or strpos(payload::text, ${subject}) > 0
     returning id
  `

  /* ------------------------------------------------------- ... then repoint, and only then drop */

  const held = await tx<{ subject: string; deed_slots: number }[]>`
    select subject, deed_slots from accounts where subject = ${subject} for update
  `
  const account = held[0]
  if (!account) {
    // No account here. The user may have visited without ever claiming ground, or this service
    // may simply never have seen them — an erasure for an unknown user is a SUCCESS, not a 404.
    return {
      entitlements: entitlements.length,
      draftListings: draftListings.length,
      presence: presence.length,
      visits: (await anonymiseVisits(tx, subject, placeholder)).length,
      provisions: provisions.length,
      outboxEvents: outboxEvents.length,
      parcels: 0,
      contests: 0,
      objects: 0,
      placements: 0,
      listings: 0,
      bookings: 0,
      engagementGrants: 0,
      beacons: 0,
      accounts: 0,
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // THE PLACEHOLDER CARRIES `deed_slots` AND NOT `created_at`, AND THE TWO ARE DIFFERENT CASES.
  //
  // `created_at` IS NOT COPIED. It is the moment a specific human being joined this world, to the
  // microsecond — a textbook quasi-identifier, and a join key back to any other system that knows
  // when that person signed up. Nothing in this service reads it. Data minimisation, Art. 5(1)(c):
  // the row exists to be a valid target for nine foreign keys and should carry nothing more.
  //
  // `deed_slots` IS COPIED, AND NOT AS A CONVENIENCE — THE ERASURE FAILS WITHOUT IT.
  // `parcels_within_deed_slots` (migration 4) is a DEFERRED constraint trigger: at COMMIT it
  // counts the non-Homestead parcels each owner holds and raises if the count exceeds that
  // owner's `deed_slots`. Repointing the parcels moves that count onto the placeholder, so a
  // placeholder minted with the default of 2 would fail the check for anyone holding three or
  // more — the erasure of exactly the most invested players would abort with 23514, which is the
  // worst possible group to be unable to erase. `erasure.test.ts` pins this with a user holding
  // four parcels, because a single-parcel fixture passes either way and proves nothing.
  //
  // It leaks close to nothing on its own: the retained parcels already reveal how many the person
  // held, and the allowance is a bounded 2..12 integer that names no one.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  await tx`
    insert into accounts (subject, deed_slots) values (${placeholder}, ${account.deed_slots})
  `

  // Every column that `references accounts (subject)`. `entitlements.subject` is absent because
  // its rows were deleted outright above — and if that were ever wrong, the delete at the bottom
  // of this function would raise 23503 and say so.
  const parcels = await tx`
    update parcels set owner_subject = ${placeholder} where owner_subject = ${subject} returning id
  `
  const contests = await tx`
    update contests set challenger_subject = ${placeholder}
     where challenger_subject = ${subject} returning id
  `
  const objects = await tx`
    update objects set author_subject = ${placeholder} where author_subject = ${subject} returning id
  `
  const placements = await tx`
    update placements set placed_by = ${placeholder} where placed_by = ${subject} returning id
  `
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // `listings` CARRIES THE SUBJECT TWICE, AND MISSING THE SECOND COPY IS NOT A LEAK — IT IS A
  // CRASH. Migration 11 added `market_seller_subject`: what micro-market ANSWERED when the
  // listing was published, held beside what this database believes, so that §7.2's "the take is
  // the same for everybody" is provable across the two services rather than merely asserted.
  //
  // `listings_market_agrees_on_the_seller` is `market_seller_subject is null or
  // market_seller_subject = seller_subject`. So repointing `seller_subject` alone makes the two
  // disagree and the CHECK refuses the UPDATE outright — the erasure would fail with 23514
  // rather than silently leave the person named. Both move, in one statement.
  //
  // The `case` preserves NULL-ness rather than writing the placeholder unconditionally, because
  // NULL here means "this listing never went to market" and is what
  // `listings_past_draft_records_market_terms` reads to tell a draft from a published row.
  // Filling it in would forge a market answer that was never given.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const listings = await tx`
    update listings
       set seller_subject = ${placeholder},
           market_seller_subject = case
             when market_seller_subject is null then null else ${placeholder} end
     where seller_subject = ${subject}
     returning id
  `
  const bookings = await tx`
    update bookings set booked_by = ${placeholder} where booked_by = ${subject} returning id
  `
  const engagementGrants = await tx`
    update engagement_grants set beneficiary = ${placeholder}
     where beneficiary = ${subject} returning id
  `
  const beacons = await tx`
    update beacons set lit_by = ${placeholder} where lit_by = ${subject} returning id
  `

  // The person's row, gone for real. This is the statement that raises 23503 if anything above
  // was missed — see the header of this function. It is not a formality and it is not defensive
  // programming; it is the only check in this file that cannot go stale.
  const accounts = await tx`delete from accounts where subject = ${subject} returning subject`

  // LAST, AND THE POSITION IS LOAD-BEARING — see `anonymiseVisits`.
  const visits = await anonymiseVisits(tx, subject, placeholder)

  return {
    entitlements: entitlements.length,
    draftListings: draftListings.length,
    presence: presence.length,
    visits: visits.length,
    provisions: provisions.length,
    outboxEvents: outboxEvents.length,
    parcels: parcels.length,
    contests: contests.length,
    objects: objects.length,
    placements: placements.length,
    listings: listings.length,
    bookings: bookings.length,
    engagementGrants: engagementGrants.length,
    beacons: beacons.length,
    accounts: accounts.length,
  }
}
