/**
 * Listings, venue bookings, and engagement grants.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE WORLD CANNOT PAY OUT EMBER IT DOES NOT HOLD, AND THAT IS A TRIGGER IN SOMEBODY ELSE'S
 * DATABASE.
 *
 * §8.3: "Every grant Tessera makes debits `engagement:tessera`, which is an **`equity`** account,
 * so the ledger's no-overdraft trigger refuses an unfunded grant at the database. `micro-market`
 * proves the pattern already works: `market/src/engagement.ts` names `engagementAccount`
 * from `contracts-money` with `equity` type precisely 'so the ledger's no-overdraft rule refuses
 * an unfunded grant'. This is what 'chain-backed by construction' actually reduces to in code:
 * **not a promise that reserves exist, but a constraint that makes spending non-existent reserves
 * unrepresentable.**"
 *
 * `ledger_assert_no_overdraft` exempts `clearing` and `suspense`; it does not exempt `equity`
 * (`ledger/src/migrations.ts`). So the refusal is not something this file implements —
 * it is something this file is careful not to route around. The account key comes from
 * `engagementAccount` in `@cloudsforge/contracts-money` rather than being spelled here, because
 * an account is `(subject, asset_code, purpose)` and a second spelling would silently split the
 * programme's ledger in half: `ledger/src/accounts.ts` throws on a type mismatch, and whichever
 * service posts second has EVERY entry refused.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **Every grant names its ledger entry and cannot be written before it.** `ledger_entry_id` is NOT
 * NULL (migration 6), the rule doc 21 §7.4 states and `micro-market` already follows. So the order
 * is always: post to the ledger on a key derived from the grant, then record. A crash between them
 * leaves an entry with no row — the safe direction, visible in the ledger, adopted by the retry —
 * never a recorded payment that never happened.
 */

import {
  ENGAGEMENT_GRANT_KIND,
  engagementAccount,
  type AccountIdentity,
  type Actor,
  type TokenAssetCode,
} from '@cloudsforge/contracts-money'
import type { LedgerClient } from './ledgerclient.ts'
import type { Db } from './outbox.ts'
import { withOutbox } from './outbox.ts'
import { VENUE_BOOKED } from './topics.ts'
import { ASSET, parsePriceWei, splitSale, type SaleSplit } from './sparks.ts'
import { ensureAccount, WorldError } from './world.ts'
import { SERVICE } from './service.ts'
import { objectAssetCode, objectUrn } from './itemasset.ts'
import type { MarketClient } from './marketclient.ts'

/**
 * The account every grant debits. **`engagement:tessera`, `EMBER`, and an `equity` type.**
 *
 * Spelled by the contract, not here. The `equity` type is the whole safety property — see the file
 * header.
 */
export const ENGAGEMENT_ACCOUNT: AccountIdentity = engagementAccount(SERVICE, ASSET)

/** The entry kind an engagement grant posts under. `treasury_spend`, from the contract. */
export const GRANT_ENTRY_KIND = ENGAGEMENT_GRANT_KIND

/**
 * The purpose a creator's proceeds land in before they clear.
 *
 * §8.2: "Sale proceeds sit in `user:<id> / EMBER / payout_due` for the listing's dispute window,
 * then release to `available`." It is **visible** — a real balance in a real account — and
 * **structurally unspendable**, because nothing in Tessera ever debits `payout_due` except the
 * release, and a spend attempt against it would be an overdraft the ledger's
 * `ledger_assert_no_overdraft` trigger refuses.
 */
export const PAYOUT_DUE = 'payout_due' as const
export const AVAILABLE = 'available' as const

export interface Listing {
  readonly id: string
  readonly objectId: string
  readonly sellerSubject: string
  readonly priceWei: bigint
  readonly royaltyBps: number
  readonly platformFeeBps: number
  readonly settlementMode: 'custodial'
  readonly marketListingId: string | null
  readonly status: 'draft' | 'active' | 'sold' | 'withdrawn'
  readonly createdAt: string
  /** What the seller will actually receive, computed the way market computes it. `sparks.ts`. */
  readonly split: SaleSplit
  /**
   * What `micro-market` answered, and therefore the terms this listing will actually be SOLD
   * under. Null while the listing is a draft; after that, CHECKed equal to the three fields above
   * by migration 11. See `activateListing`.
   */
  readonly marketTerms: MarketTerms | null
}

/** Market's own snapshot, brought back so it can be compared rather than assumed. */
export interface MarketTerms {
  readonly sellerSubject: string
  readonly platformFeeBps: number
  readonly royaltyBps: number
}

interface ListingRow {
  readonly id: string
  readonly object_id: string
  readonly seller_subject: string
  readonly price_wei: string
  readonly royalty_bps: number
  readonly platform_fee_bps: number
  readonly settlement_mode: string
  readonly market_listing_id: string | null
  readonly status: string
  readonly created_at: Date
  readonly market_seller_subject: string | null
  readonly market_platform_fee_bps: number | null
  readonly market_royalty_bps: number | null
}

const LISTING_COLUMNS = `id, object_id, seller_subject, price_wei::text as price_wei, royalty_bps,
  platform_fee_bps, settlement_mode, market_listing_id, status, created_at,
  market_seller_subject, market_platform_fee_bps, market_royalty_bps`

export function toListing(row: ListingRow): Listing {
  // `::text` then `BigInt`, never a JSON number — `market/src/escrow.ts` reads amounts the
  // same way, for the same reason: postgres.js hands back numeric as a string, and turning it into
  // a Number on the way through would round at 2^53 while a single EMBER is 10^18 wei.
  const priceWei = parsePriceWei(row.price_wei, 'price_wei')
  return {
    id: row.id,
    objectId: row.object_id,
    sellerSubject: row.seller_subject,
    priceWei,
    royaltyBps: row.royalty_bps,
    platformFeeBps: row.platform_fee_bps,
    settlementMode: 'custodial',
    marketListingId: row.market_listing_id,
    status: row.status as Listing['status'],
    createdAt: row.created_at.toISOString(),
    split: splitSale({
      priceWei,
      platformFeeBps: row.platform_fee_bps,
      royaltyBps: row.royalty_bps,
    }),
    marketTerms:
      row.market_seller_subject !== null &&
      row.market_platform_fee_bps !== null &&
      row.market_royalty_bps !== null
        ? {
            sellerSubject: row.market_seller_subject,
            platformFeeBps: row.market_platform_fee_bps,
            royaltyBps: row.market_royalty_bps,
          }
        : null,
  }
}

export interface PlatformTerms {
  readonly platformFeeBps: number
  readonly maxRoyaltyBps: number
}

/**
 * The one set of terms, for everybody.
 *
 * There is no `subject` argument on this function and there must not be one. §7.2's fifth
 * refusal: "The platform fee and the royalty cap are **identical for every account**, and **no
 * SKU, tier or subscription reduces either**." A per-account rate would need a parameter here
 * before it needed a column anywhere, so the absence of the parameter is the first place the
 * refusal is visible — and `economy.test.ts` asserts the signature takes no subject, the way
 * `admin-web` asserts its missing og card.
 */
export async function platformTerms(sql: Db): Promise<PlatformTerms> {
  const rows = await sql<{ platform_fee_bps: number; max_royalty_bps: number }[]>`
    select platform_fee_bps, max_royalty_bps from platform_terms where singleton
  `
  const row = rows[0]
  if (!row) throw new WorldError('terms_unset', 'the platform terms are unset', 503)
  return { platformFeeBps: row.platform_fee_bps, maxRoyaltyBps: row.max_royalty_bps }
}

export interface DraftListingInput {
  readonly objectId: string
  readonly sellerSubject: string
  readonly priceWei: bigint
  readonly royaltyBps: number
  readonly correlationId: string
}

/**
 * Draft a listing for an object.
 *
 * The platform fee is READ from `platform_terms` and never accepted from the caller. A caller that
 * could pass a fee could pass a lower one; the trigger `listings_one_rate_for_everybody` would
 * refuse it, but a parameter that exists only to be refused is a parameter somebody will one day
 * wire to an entitlement.
 *
 * `settlement_mode` is not a parameter either. §8.5: for an `onchain` listing "the royalty is
 * recorded on the order row and **never posted**. Therefore: **every Tessera listing is
 * `custodial`, without exception.** That is not a preference; it is the only mode in which the
 * royalty exists."
 */
export async function draftListing(sql: Db, input: DraftListingInput): Promise<Listing> {
  const terms = await platformTerms(sql)
  if (input.royaltyBps < 0 || input.royaltyBps > terms.maxRoyaltyBps) {
    throw new WorldError(
      'royalty_out_of_range',
      `a royalty must be between 0 and ${terms.maxRoyaltyBps} bps — the cap is identical for every account (23-tessera.md §7.2)`,
      400,
    )
  }
  try {
    return await withOutbox(sql, async (tx) => {
      await ensureAccount(tx, input.sellerSubject)
      const owns = await tx<{ author_subject: string; status: string }[]>`
        select author_subject, status from objects where id = ${input.objectId}
      `
      const object = owns[0]
      if (!object) throw new WorldError('not_found', 'no such object', 404)
      if (object.status !== 'fired') {
        throw new WorldError('not_fired', 'an object must finish firing before it can be listed', 409)
      }
      const rows = await tx<ListingRow[]>`
        insert into listings (object_id, seller_subject, price_wei, royalty_bps, platform_fee_bps)
        values (${input.objectId}, ${input.sellerSubject}, ${input.priceWei.toString()}::numeric,
                ${input.royaltyBps}, ${terms.platformFeeBps})
        returning ${tx.unsafe(LISTING_COLUMNS)}
      `
      const row = rows[0]
      if (!row) throw new WorldError('not_listed', 'the listing did not land')
      return toListing(row)
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('tessera_price_whole_sparks')) {
      throw new WorldError(
        'price_not_whole_sparks',
        'a price must be a whole number of Sparks (23-tessera.md §8.1)',
        400,
      )
    }
    if (message.includes('the rate is identical for every account')) {
      throw new WorldError('rate_is_not_negotiable', message, 409)
    }
    throw err
  }
}

/* ------------------------------------------------------------------------------- activation */

export interface ActivateDeps {
  readonly market: MarketClient
  /**
   * Issues one of the object to its author in the ledger. `ledgerclient.ts:issueObjectToAuthor`.
   *
   * **Injected rather than imported, and that is a real hazard rather than a style preference.**
   * `ledgerclient.ts` already imports THIS module for `ENGAGEMENT_ACCOUNT`, `AVAILABLE` and
   * `PAYOUT_DUE`, and it reads `ENGAGEMENT_ACCOUNT` at module-evaluation time to build
   * `ENGAGEMENT_REF`. A runtime import back from here would close that cycle, and whichever of the
   * two modules loaded first would evaluate the other's body against bindings still in their
   * temporal dead zone — a `ReferenceError` on the import graph, at boot, in the composition root,
   * for a service that typechecks perfectly. So the dependency travels as a function.
   */
  readonly issueObject: (input: {
    readonly author: string
    readonly assetCode: TokenAssetCode
    readonly correlationId: string
  }) => Promise<unknown>
}

export interface ActivateListingInput {
  readonly listingId: string
  /** The authenticated seller. Never read from a body — it decides who gets paid. */
  readonly sellerSubject: string
  /**
   * The seller's OWN bearer token, relayed to market.
   *
   * Not a service credential, and the reason is the whole of `marketclient.ts`'s header: market
   * takes the seller from the token and has no on-behalf-of lane, so a service credential would
   * create a listing selling the creator's object into Tessera's own ledger account.
   */
  readonly sellerToken: string
  readonly correlationId: string
}

/**
 * Prove that market's terms are the platform's one set of terms.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS WHERE "IDENTICAL FOR EVERY ACCOUNT" STOPS BEING AN ASSERTION.**
 *
 * §7.2's fifth refusal is the sharpest thing in the design's monetisation section, because the
 * argument is economic rather than aesthetic: a fee discount is not a cosmetic perk, it converts
 * money into a compounding earning advantage, so it is pay-to-win with an accountant. The refusal
 * therefore has to be true of the terms a sale ACTUALLY happens under, and those live in
 * micro-market's database, not this one.
 *
 * Three separate things now have to agree, and each is checked by something that cannot be talked
 * out of it:
 *
 *   1. **Tessera's row matches Tessera's singleton.** `listings_one_rate_for_everybody`, a trigger
 *      reading `platform_terms` — which has no subject column and a
 *      `platform_terms_is_a_singleton` CHECK, so there is exactly one rate to match.
 *   2. **Tessera never asks market for a rate.** `marketclient.ts` sends no `platformFeeBps`
 *      field, and market reads its own from `deps.platformFeeBps` (`market/src/server.ts`).
 *      The absence is asserted against a literal key list in `marketclient.test.ts`.
 *   3. **Market's answer matches Tessera's row.** This function, on every activation, for every
 *      account — and then `listings_market_agrees_on_the_rate` in migration 11, so a row that
 *      disagreed could not be stored even if this function were deleted.
 *
 * (1) and (2) are properties of this repository. (3) is the only one that is a property of the
 * SALE, and it is the one that was missing.
 *
 * The refusal is deliberately BEFORE activation. A market listing left as a draft holds nothing
 * and is "visible to nobody but their seller" (`market/src/listings.ts`), so refusing here leaves
 * a dead draft; refusing after would leave a live listing Tessera disowns.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function assertTermsAreIdentical(
  ours: { readonly platformFeeBps: number; readonly royaltyBps: number; readonly sellerSubject: string },
  theirs: MarketTerms,
): void {
  if (theirs.sellerSubject !== ours.sellerSubject) {
    throw new WorldError(
      'market_seller_mismatch',
      `micro-market recorded the seller as ${theirs.sellerSubject} but this listing belongs to ` +
        `${ours.sellerSubject}. Sale proceeds are credited to market's seller, so activating this ` +
        'would pay somebody else for this creator\'s object.',
      409,
    )
  }
  if (theirs.platformFeeBps !== ours.platformFeeBps) {
    throw new WorldError(
      'market_rate_mismatch',
      `micro-market would take ${theirs.platformFeeBps}bps on this sale but the platform take is ` +
        `${ours.platformFeeBps}bps. The rate is identical for every account and no SKU reduces it, ` +
        'so a listing that would sell under a different rate is not activated.',
      409,
    )
  }
  if (theirs.royaltyBps !== ours.royaltyBps) {
    throw new WorldError(
      'market_royalty_mismatch',
      `micro-market recorded a ${theirs.royaltyBps}bps royalty but this listing sets ` +
        `${ours.royaltyBps}bps. The royalty is snapshotted so it cannot be re-cut mid-sale.`,
      409,
    )
  }
}

/**
 * Turn a draft into a listing another player can actually buy.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ORDER OF THE FOUR STEPS IS THE SUBSTANCE OF THIS FUNCTION.**
 *
 *     issue → create → CHECK THE TERMS → activate → record
 *
 * * **Issue first.** §8.5's last line: "an active listing must hold an escrow, so a Tessera object
 *   must be ledger-reservable under an `item_asset_code` before it can go live". Market's
 *   activation reserves the item (`market/src/listings.ts`, `holdEscrow` with
 *   `kind: 'listing_item'`), and a creator who holds none has the reservation refused by the
 *   ledger's no-overdraft trigger. Issuing is idempotent on the object's own asset code, so a
 *   creator who lists, withdraws and relists holds exactly one of their object.
 *
 * * **Check the terms between create and activate**, for the reason in
 *   `assertTermsAreIdentical`: a market draft holds nothing, a market active listing does.
 *
 * * **Record last.** Every external fact is established before this database claims it, which is
 *   the same ordering rule `recordGrant` follows and doc 21 §7.4 states. A crash before the write
 *   leaves a live market listing and a Tessera draft — visible, converging on retry (market's POST
 *   is deduped on this listing's id and `activate` treats "already active" as success), and the
 *   safe direction. The unsafe direction — a Tessera row claiming to be live against a listing
 *   market never activated — is additionally unrepresentable, because
 *   `listings_active_names_its_market_row` refuses it.
 *
 * There is no transaction spanning the HTTP calls, deliberately. Holding a Postgres transaction
 * open across three upstream round trips is a lock held for as long as the slowest of them, and
 * the ordering above is what makes it unnecessary: every step is idempotent and the recovery
 * direction is the safe one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function activateListing(
  sql: Db,
  deps: ActivateDeps,
  input: ActivateListingInput,
): Promise<Listing> {
  const rows = await sql<(ListingRow & { checksum: string | null; author_subject: string })[]>`
    select ${sql.unsafe(LISTING_COLUMNS.split(',').map((c) => `l.${c.trim()}`).join(', '))},
           o.checksum, o.author_subject
      from listings l join objects o on o.id = l.object_id
     where l.id = ${input.listingId}
  `
  const row = rows[0]
  if (!row) throw new WorldError('not_found', 'no such listing', 404)
  // The seller is checked HERE as well as at market. Market would refuse it too
  // (`market/src/listings.ts` compares `listing.sellerSubject`), but a service that let somebody
  // activate another player's draft would be relaying a token to do it.
  if (row.seller_subject !== input.sellerSubject) throw new WorldError('not_found', 'no such listing', 404)
  if (row.status !== 'draft') {
    throw new WorldError('not_a_draft', `a ${row.status} listing cannot be activated`, 409)
  }
  if (!row.checksum) {
    // Unreachable through `draftListing`, which refuses an object that is not `fired`, and
    // `objects_fired_have_bytes` refuses a fired object with no checksum. Stated rather than
    // assumed because the object's name IS its checksum and a null here would build `TOKEN:null`.
    throw new WorldError('not_fired', 'an object must finish firing before it can be listed', 409)
  }

  const assetCode = objectAssetCode(row.checksum)
  const itemUrn = objectUrn(row.checksum)

  // 1. The creator holds their own object, so market has something to reserve.
  await deps.issueObject({
    // The AUTHOR, not the seller. They are the same today because only an author can draft a
    // listing for their object; naming the author is what keeps that true if resale is ever added,
    // since the object is issued once, to whoever made it.
    author: row.author_subject,
    assetCode,
    correlationId: input.correlationId,
  })

  // 2. The market listing. Created as a draft — market's own `status` starts at `draft` and
  //    `activateListing` is the only path to `active` (`market/src/listings.ts`).
  const created = await deps.market.createListing({
    itemUrn,
    itemAssetCode: assetCode,
    priceWei: parsePriceWei(row.price_wei, 'price_wei'),
    royaltyBps: row.royalty_bps,
    sellerToken: input.sellerToken,
    idempotencyKey: row.id,
    correlationId: input.correlationId,
  })

  // 3. The proof. Before anything goes live.
  assertTermsAreIdentical(
    {
      platformFeeBps: row.platform_fee_bps,
      royaltyBps: row.royalty_bps,
      sellerSubject: row.seller_subject,
    },
    created,
  )

  // 4. Live.
  const active = await deps.market.activate({
    marketListingId: created.id,
    sellerToken: input.sellerToken,
    correlationId: input.correlationId,
  })
  // Re-checked against the ACTIVATED listing, not only the created one. Market re-reads the row
  // under `for update` when it activates, so this is the answer describing the listing that is
  // actually on sale.
  assertTermsAreIdentical(
    {
      platformFeeBps: row.platform_fee_bps,
      royaltyBps: row.royalty_bps,
      sellerSubject: row.seller_subject,
    },
    active,
  )

  const updated = await sql<ListingRow[]>`
    update listings
       set status = 'active',
           market_listing_id = ${active.id},
           market_seller_subject = ${active.sellerSubject},
           market_platform_fee_bps = ${active.platformFeeBps},
           market_royalty_bps = ${active.royaltyBps}
     where id = ${input.listingId} and status = 'draft'
    returning ${sql.unsafe(LISTING_COLUMNS)}
  `
  const after = updated[0]
  if (!after) throw new WorldError('not_a_draft', 'the listing changed state under this activation', 409)
  return toListing(after)
}

/** Consume `market.listing.sold`. The money moved in market's ledger entry; this records the fact. */
export async function markSold(sql: Db, marketListingId: string): Promise<void> {
  await sql`
    update listings set status = 'sold' where market_listing_id = ${marketListingId}
  `
}

export async function findListing(sql: Db, id: string): Promise<Listing | null> {
  const rows = await sql<ListingRow[]>`
    select ${sql.unsafe(LISTING_COLUMNS)} from listings where id = ${id}
  `
  const row = rows[0]
  return row ? toListing(row) : null
}

export async function listListingsOf(sql: Db, subject: string): Promise<Listing[]> {
  const rows = await sql<ListingRow[]>`
    select ${sql.unsafe(LISTING_COLUMNS)} from listings
     where seller_subject = ${subject} order by created_at desc limit 100
  `
  return rows.map(toListing)
}

/* -------------------------------------------------------------------------------- bookings */

export interface Booking {
  readonly id: string
  readonly parcelId: string
  readonly wardId: string
  readonly ownerSubject: string
  readonly bookedBy: string
  readonly slot: string
  readonly hours: number
  readonly endsAt: string
  readonly priceWei: bigint
  readonly status: BookingStatus
  readonly reservationId: string | null
  readonly releasedEntryId: string | null
  readonly settledEntryId: string | null
  readonly createdAt: string
  readonly closedAt: string | null
}

export type BookingStatus = 'open' | 'settled' | 'cancelled'

interface BookingRow {
  readonly id: string
  readonly parcel_id: string
  readonly ward_id: string
  readonly owner_subject: string
  readonly booked_by: string
  readonly slot: Date
  readonly hours: number
  readonly price_wei: string
  readonly status: string
  readonly reservation_id: string | null
  readonly released_entry_id: string | null
  readonly settled_entry_id: string | null
  readonly created_at: Date
  readonly closed_at: Date | null
}

/** Every column of a booking plus the two the parcel owns. Bookings are always read with their venue. */
const BOOKING_COLUMNS = `b.id, b.parcel_id, b.slot, b.hours, b.booked_by, b.price_wei, b.status,
  b.reservation_id, b.released_entry_id, b.settled_entry_id, b.created_at, b.closed_at,
  p.ward_id, p.owner_subject`

function toBooking(row: BookingRow): Booking {
  const ends = new Date(row.slot.getTime() + row.hours * 3_600_000)
  return {
    id: row.id,
    parcelId: row.parcel_id,
    wardId: row.ward_id,
    ownerSubject: row.owner_subject,
    bookedBy: row.booked_by,
    slot: row.slot.toISOString(),
    hours: row.hours,
    endsAt: ends.toISOString(),
    // `parseWei`, not `BigInt`, for the reason this file repeats: `BigInt('')` is `0n`, and a
    // price that silently became zero is the exact defect the schema now refuses.
    priceWei: parsePriceWei(row.price_wei, 'price_wei'),
    status: row.status as BookingStatus,
    reservationId: row.reservation_id,
    releasedEntryId: row.released_entry_id,
    settledEntryId: row.settled_entry_id,
    createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
  }
}

export interface Venue {
  readonly parcelId: string
  readonly wardId: string
  readonly ownerSubject: string
  /** Per hour, in wei. Never null — a parcel with no posted rate is not a Venue. */
  readonly rateWei: bigint
}

/**
 * A parcel's Venue terms, or `null` if it has none.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PRICE OF AN HOUR IS READ FROM THE OWNER'S PARCEL, WHICH IS THE WHOLE ANSWER TO "WHO PRICES
 * A SLOT".
 *
 * Migration 14 argues the decision; this is the read side of it. A route asks what an hour costs
 * BEFORE it escrows anything, because the amount it reserves has to be the amount the booking
 * will be written for — and `bookings_price_is_the_owners_rate` (the venue trigger) refuses the
 * insert if it is not.
 *
 * `rateWei` is non-nullable in the returned shape and that is not a convenience: the parcel-level
 * `tessera_a_venue_posts_a_rate` CHECK makes `is_venue and venue_rate_wei is null` unrepresentable,
 * so the null branch here is the "not a Venue" branch and nothing else.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function venueOf(sql: Db, parcelId: string): Promise<Venue | null> {
  const rows = await sql<
    { ward_id: string; owner_subject: string; venue_rate_wei: string | null; status: string }[]
  >`
    select ward_id, owner_subject, venue_rate_wei, status
      from parcels where id = ${parcelId} and is_venue = true and status = 'held'
  `
  const row = rows[0]
  if (!row || row.venue_rate_wei === null) return null
  return {
    parcelId,
    wardId: row.ward_id,
    ownerSubject: row.owner_subject,
    rateWei: parsePriceWei(row.venue_rate_wei, 'venueRateWei'),
  }
}

/**
 * Open a Venue, or re-price one. **The owner's act, and the only way a Venue comes into being.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A FLAG ON `setParcelFlags`.
 *
 * Two reasons, and either alone would be enough.
 *
 *   1. **A Venue without terms is unrepresentable** (`tessera_a_venue_posts_a_rate`), so raising
 *      the flag and posting the rate are one statement or they are a constraint violation. Two
 *      calls would mean a window in which the parcel is a Venue at no price, which is the exact
 *      thing this feature exists to make impossible.
 *   2. **`world.ts` may not touch money.** §12's test 4 scans that module for the vocabulary of a
 *      sale and asserts it imports nothing that can move value — not `sparks.ts`, not this file.
 *      A rate column on `Parcel` would have ended that guarantee quietly, and the guarantee is
 *      §7's fourth refusal: land is claimed, never bought.
 *
 * Re-pricing an open Venue is allowed and affects NOTHING already booked: every booking snapshots
 * `price_wei` at insert and `bookings_terms_are_written_once` refuses to let it move afterwards,
 * which is `listings`' rule (§7.2, "snapshotted onto each listing at creation") applied to an hour
 * instead of an object.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function openVenue(
  sql: Db,
  parcelId: string,
  ownerSubject: string,
  rateWei: bigint,
): Promise<Venue> {
  try {
    const rows = await sql<{ ward_id: string }[]>`
      update parcels
         set is_venue = true, venue_rate_wei = ${rateWei.toString()}::numeric, last_edit_at = now()
       where id = ${parcelId} and owner_subject = ${ownerSubject} and status = 'held'
      returning ward_id
    `
    const row = rows[0]
    if (!row) throw new WorldError('not_found', 'no such parcel, or it is not yours', 404)
    return { parcelId, wardId: row.ward_id, ownerSubject, rateWei }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('tessera_venue_rate_is_positive')) {
      throw new WorldError('free_venue', 'an hour of a Venue costs more than nothing', 400)
    }
    if (message.includes('tessera_venue_rate_whole_sparks')) {
      throw new WorldError('rate_not_whole_sparks', 'a venue rate is a whole number of Sparks', 400)
    }
    throw err
  }
}

export async function findBooking(sql: Db, id: string): Promise<Booking | null> {
  const rows = await sql<BookingRow[]>`
    select ${sql.unsafe(BOOKING_COLUMNS)}
      from bookings b join parcels p on p.id = b.parcel_id
     where b.id = ${id}
  `
  const row = rows[0]
  return row ? toBooking(row) : null
}

/** A Venue's calendar from now forward. The open holds are the ones that block a slot. */
export async function listBookingsOf(sql: Db, parcelId: string): Promise<Booking[]> {
  const rows = await sql<BookingRow[]>`
    select ${sql.unsafe(BOOKING_COLUMNS)}
      from bookings b join parcels p on p.id = b.parcel_id
     where b.parcel_id = ${parcelId} order by b.slot asc limit 200
  `
  return rows.map(toBooking)
}

export interface BookInput {
  readonly parcelId: string
  readonly slot: Date
  /** Whole hours, 1–12. A booking is a SPAN; `tessera_no_overlapping_bookings` is what enforces it. */
  readonly hours: number
  readonly bookedBy: string
  /**
   * What the caller actually escrowed with the ledger, in wei.
   *
   * **Not a price.** The price is the owner's, read from the parcel below under the same lock, and
   * this number is checked against it — a booker who escrows less than the posted rate is refused
   * rather than accommodated. Named `escrowedWei` and not `priceWei` so the difference cannot be
   * lost in a rename: the old field WAS the price, taken from whoever called, and `price_wei >= 0`
   * meant a stranger could hold an hour of somebody else's calendar for nothing.
   */
  readonly escrowedWei: bigint
  /** The ledger reservation that holds the money. An open booking without one is refused. */
  readonly reservationId: string
  readonly correlationId: string
}

/**
 * Book a span of a Venue's calendar, against an escrowed ledger hold.
 *
 * §8.2's shape, not a new one: "Reserving funds is a posting from `available` to `reserved`, which
 * makes a reservation auditable, reversible and impossible to lose track of"
 * (`ledger/src/accounts.ts`). The reservation is taken by the route before this is called, and
 * `bookings_open_holds_money` refuses an open booking that names none — so a free hold on somebody
 * else's calendar is unrepresentable rather than discouraged.
 *
 * **The price is not an argument.** It is `venue_rate_wei * hours`, computed here from the parcel
 * row this function already locks, and checked again by the database in the same statement.
 */
export async function bookVenue(sql: Db, input: BookInput): Promise<{ bookingId: string }> {
  try {
    return await withOutbox(sql, async (tx, emit) => {
      await ensureAccount(tx, input.bookedBy)
      // ═══════════════════════════════════════════════════════════════════════════════════════
      // THE PARTY BEING PAID, READ `for update` BEFORE THE BOOKING IS WRITTEN.
      //
      // `notify/src/topics.ts` records this topic as `blockedBy: 'no-subject'` and it was
      // right: the payload named the BOOKER, and the person who needs telling that their venue
      // has been booked — and whose money is on the other end of `reservation_id` — is the
      // parcel's OWNER, who appeared nowhere in it. A rule written on the old payload would have
      // answered `no_recipient` for ever, or told the booker about their own booking.
      //
      // Read from the authoritative row, not derived from the actor, and `for update` so a
      // transfer committing alongside cannot make this name the former owner — which on a topic
      // that carries a price and a reservation would be telling the wrong person they are owed
      // money. Locked in the same order `moveParcel` locks, so the two serialise.
      // ═══════════════════════════════════════════════════════════════════════════════════════
      const owners = await tx<
        { owner_subject: string; ward_id: string; venue_rate_wei: string | null }[]
      >`
        select owner_subject, ward_id, venue_rate_wei
          from parcels where id = ${input.parcelId} for update
      `
      const parcel = owners[0]
      if (!parcel) throw new WorldError('not_found', 'no such parcel', 404)

      // ═══════════════════════════════════════════════════════════════════════════════════════
      // THE PRICE IS THE OWNER'S, RE-READ UNDER THE LOCK, AND THE ESCROW HAS TO MATCH IT.
      //
      // The route read the rate a moment ago to know what to reserve. Between that read and this
      // lock the owner may have re-priced their Venue, and the two failure modes are not
      // symmetric: escrowing MORE than the price would silently overcharge a booker, and escrowing
      // LESS would open a booking the hold does not cover — a partly-free slot, which is the same
      // defect as a free one with a smaller number in it.
      //
      // So neither is accommodated. `rate_moved` is a 409 the client retries into the new price,
      // and the route releases the hold it took. The alternative — trusting `escrowedWei` as the
      // price — is exactly the unsourced input this whole change exists to remove.
      // ═══════════════════════════════════════════════════════════════════════════════════════
      if (parcel.venue_rate_wei === null) {
        throw new WorldError('not_a_venue', 'that parcel posts no venue rate', 409)
      }
      const priceWei = parsePriceWei(parcel.venue_rate_wei, 'venueRateWei') * BigInt(input.hours)
      if (input.escrowedWei !== priceWei) {
        throw new WorldError(
          'rate_moved',
          `the owner's rate now prices this booking at ${priceWei} wei, not the ${input.escrowedWei} held`,
          409,
        )
      }

      const rows = await tx<{ id: string; parcel_id: string; slot: Date; hours: number }[]>`
        insert into bookings (parcel_id, slot, hours, booked_by, price_wei, reservation_id)
        values (${input.parcelId}, ${input.slot}, ${input.hours}, ${input.bookedBy},
                ${priceWei.toString()}::numeric, ${input.reservationId})
        returning id, parcel_id, slot, hours
      `
      const row = rows[0]
      if (!row) throw new WorldError('not_booked', 'the booking did not land')
      emit({
        topic: VENUE_BOOKED,
        // ═══════════════════════════════════════════════════════════════════════════════════
        // `keyedBy: 'parcel_id'` — THE PARCEL, NOT THE BOOKING.
        //
        // §11.2 argues this one at length because `booking_id` is the obvious answer and the
        // wrong one: "The contended resource is the parcel's calendar; keying by booking would
        // let two bookings for one slot be processed in either order, which is precisely the
        // failure `keyedBy` exists to prevent."
        //
        // The database already refuses the double-book. Consumers have no such index, and a
        // calendar rendered from these events in booking-id order can show the loser of a race
        // as the winner.
        // ═══════════════════════════════════════════════════════════════════════════════════
        key: row.parcel_id,
        payload: {
          bookingId: row.id,
          parcelId: row.parcel_id,
          wardId: parcel.ward_id,
          slot: row.slot.toISOString(),
          // A booking is a SPAN, so a consumer rendering a calendar needs its end. Additive to a
          // `1.0` payload and read by nobody yet — notify's rule takes `ownerSubject` and the
          // parcel — but a diary entry with no end time is not a diary entry.
          hours: row.hours,
          endsAt: new Date(row.slot.getTime() + row.hours * 3_600_000).toISOString(),
          // The party this event is ABOUT, and the one being paid. First of the pair on purpose.
          ownerSubject: parcel.owner_subject,
          bookedBy: input.bookedBy,
          // The OWNER's number, not the caller's. `input.escrowedWei` is only ever checked against
          // this; publishing it instead would put an unverified figure on the bus.
          priceWei: priceWei.toString(),
          reservationId: input.reservationId,
        },
        actor: `user:${input.bookedBy.slice('user:'.length)}`,
        correlationId: input.correlationId,
      })
      return { bookingId: row.id }
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message.includes('tessera_one_open_booking') ||
      message.includes('tessera_no_overlapping_bookings')
    ) {
      // Both names mean one thing to a caller: somebody already holds that time. The exclusion
      // constraint is the general rule and the unique index its equal-slot case (migration 14), so
      // which one fires is an implementation detail and neither is a different answer.
      throw new WorldError('slot_taken', 'that span of the calendar is already booked', 409)
    }
    if (message.includes('is not a Venue')) {
      throw new WorldError('not_a_venue', message, 409)
    }
    if (message.includes('bookings_price_is_the_owners_rate')) {
      throw new WorldError('rate_moved', message, 409)
    }
    if (message.includes('bookings_are_not_your_own_venue')) {
      throw new WorldError('own_venue', 'a Venue is not booked by the person who owns it', 409)
    }
    if (message.includes('bookings_slot_is_on_the_hour')) {
      throw new WorldError('slot_not_on_the_hour', 'a booking slot is on the hour', 400)
    }
    if (message.includes('bookings_hours_are_a_working_day')) {
      throw new WorldError('bad_span', 'a booking runs between 1 and 12 whole hours', 400)
    }
    if (message.includes('bookings_open_holds_money')) {
      throw new WorldError('no_hold', 'an open booking must hold an escrowed reservation', 400)
    }
    if (message.includes('tessera_booking_price_is_positive')) {
      throw new WorldError('free_hold', 'a booking is never free — 23-tessera.md §6.4', 400)
    }
    throw err
  }
}

/**
 * The ledger, as much of it as closing a booking needs.
 *
 * `Pick` of the real interface rather than a hand-written shape, so a double that satisfies this
 * satisfies the client — and imported `type`-only, which is what keeps `economy.ts` and
 * `ledgerclient.ts` from becoming a runtime import cycle. `ledgerclient.ts` reads
 * `GRANT_ENTRY_KIND`, `AVAILABLE` and `PAYOUT_DUE` from this file; a value import back the other
 * way would close the loop, and that is why the fee's two postings are built over there, next to
 * `holder` and the account literals `micro-conformance` reads, rather than here.
 */
export type BookingLedger = Pick<LedgerClient, 'payBookingFee' | 'release'>

export interface CloseInput {
  readonly bookingId: string
  /** Who asked. Checked against the booking's own two parties by the caller, not here. */
  readonly actor: Actor
  readonly correlationId: string
}

/**
 * Settle a booking: the hour was hosted, so the hold is released and the fee is paid to the owner.
 *
 * §8.4 lists venue bookings under **Earned**, and Tessera is the only service in the estate that
 * holds a calendar — there is no market order behind this and nobody else to double the payment.
 */
export async function settleBooking(
  sql: Db,
  ledger: BookingLedger,
  input: CloseInput,
): Promise<Booking> {
  return closeBooking(sql, ledger, input, 'settled')
}

/**
 * Cancel a booking: the hour will not happen, so the hold is released and nothing is paid.
 *
 * The mirror of `settleBooking` and deliberately the same code path — see `closeBooking`.
 */
export async function cancelBooking(
  sql: Db,
  ledger: BookingLedger,
  input: CloseInput,
): Promise<Booking> {
  return closeBooking(sql, ledger, input, 'cancelled')
}

/**
 * The only way a booking leaves `open`, and the reason there is only one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RELEASE IS UNCONDITIONAL AND COMES FIRST, WHICHEVER TERMINAL STATE THIS IS.
 *
 * `settled` and `cancelled` differ in exactly one step — whether the fee then moves to the owner —
 * and they are one function because the step they SHARE is the one that must never be forgotten.
 * Two functions would be two places to leave the release out of, and leaving it out is precisely
 * the defect this repairs: EMBER posted to `reserved` by `reservePostings` with no path back, on a
 * table whose `status` column has admitted `settled` and `cancelled` since migration 6 while no
 * statement in this service ever wrote either.
 *
 * The database is the belt to this brace. `bookings_terminal_frees_the_money` (migration 14) is
 * `check (status = 'open' or released_entry_id is not null)`, so a terminal booking that did not
 * release has no representation — a future function that forgot this one exists cannot write the
 * row at all.
 *
 * ── WHY THE LEDGER CALLS ARE INSIDE THE TRANSACTION, HOLDING A ROW LOCK ──────────────────────
 *
 * Normally they would not be: `grantEngagement` posts first and records after, and the header of
 * this file explains why that ordering is right for a grant. A close is the case where it is
 * wrong, and the difference is that a close has TWO outcomes.
 *
 * With the ledger calls outside, a settle and a cancel racing on one booking both release (fine,
 * idempotent, same entry), then the settle posts the fee and the cancel wins the row — leaving a
 * booking marked `cancelled` whose booker has paid. There is no idempotency key that prevents
 * that, because the two requests are genuinely different requests.
 *
 * `select … for update` on the booking makes the second closer wait, see a status that is no
 * longer `open`, and answer `already_closed`. The lock is held across two HTTP calls to one
 * service, and the only thing that can contend for it is another close of the SAME booking, which
 * is exactly what must wait. A crash mid-way rolls the row back and leaves ledger entries that
 * were posted under keys derived from the booking id, so the retry replays them and converges —
 * the safe direction, and the same one the grant path takes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function closeBooking(
  sql: Db,
  ledger: BookingLedger,
  input: CloseInput,
  outcome: Exclude<BookingStatus, 'open'>,
): Promise<Booking> {
  return sql.begin(async (tx) => {
    const rows = await tx<BookingRow[]>`
      select ${tx.unsafe(BOOKING_COLUMNS)}
        from bookings b join parcels p on p.id = b.parcel_id
       where b.id = ${input.bookingId} for update of b
    `
    const row = rows[0]
    if (!row) throw new WorldError('not_found', 'no such booking', 404)
    const booking = toBooking(row)
    if (booking.status !== 'open') {
      throw new WorldError('already_closed', `that booking is already ${booking.status}`, 409)
    }
    if (!booking.reservationId) {
      // Unreachable through `bookVenue`, and `bookings_open_holds_money` says so at the database.
      // Named rather than assumed, because the alternative to a named refusal here is a `null`
      // reaching the ledger's url builder and a 404 that says nothing about money.
      throw new WorldError('no_hold', 'an open booking without a hold cannot be closed', 409)
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // KEYS DERIVED FROM THE BOOKING, NOT FROM THE REQUEST.
    //
    // A retry — this service's, a client's, a job's — must replay rather than repeat. The ledger
    // stores the key per route (`withIdempotency`, `ledger/src/entries.ts`), and a replay
    // returns the SAME entry id, which is what lets `released_entry_id` be recorded truthfully by
    // whichever attempt finally commits. A per-request key would release once and then 409
    // `already_released` for ever, stranding the booking open with no way to record who freed it.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    const released = await ledger.release(booking.reservationId, {
      actor: input.actor,
      correlationId: input.correlationId,
      idempotencyKey: `tessera:booking:${booking.id}:release`,
      description: `Release the hold on booking ${booking.id}`,
    })

    const settled =
      outcome === 'settled'
        ? await ledger.payBookingFee({
            bookerSubject: booking.bookedBy,
            ownerSubject: booking.ownerSubject,
            amountWei: booking.priceWei,
            bookingId: booking.id,
            parcelId: booking.parcelId,
            actor: input.actor,
            correlationId: input.correlationId,
            idempotencyKey: `tessera:booking:${booking.id}:fee`,
          })
        : null

    const closed = await tx<BookingRow[]>`
      update bookings b
         set status            = ${outcome},
             released_entry_id = ${released.id},
             settled_entry_id  = ${settled?.id ?? null},
             closed_at         = now()
        from parcels p
       where b.id = ${booking.id} and p.id = b.parcel_id and b.status = 'open'
      returning ${tx.unsafe(BOOKING_COLUMNS)}
    `
    const after = closed[0]
    // The `for update` above means nothing can have moved it, so this is the database disagreeing
    // with itself rather than a race. Loud, and never a silent success.
    if (!after) throw new WorldError('not_closed', 'the booking did not close', 500)
    return toBooking(after)
  }) as Promise<Booking>
}

/* ------------------------------------------------------------------------ engagement grants */

export type GrantKind =
  | 'firing_allowance'
  | 'commission'
  | 'listing_fee_subsidy'
  | 'first_listing_bounty'

export interface GrantInput {
  readonly kind: GrantKind
  readonly beneficiary: string
  readonly amountWei: bigint
  /** The ledger entry that ALREADY happened. This row cannot be written before it. */
  readonly ledgerEntryId: string
  readonly idempotencyKey: string
}

/**
 * Record a grant that the ledger has already posted.
 *
 * The signature is the ordering rule: `ledgerEntryId` is required, so there is no way to call this
 * before posting. If the ledger refused — because `engagement:tessera` is empty and `equity` does
 * not get an overdraft — the caller never reaches this function at all, which is the point. See
 * `ledgerclient.ts:grantFromEngagement` for the posting, and `economy.test.ts` for the test that
 * empties the account and watches the refusal come back from a real ledger.
 */
export async function recordGrant(sql: Db, input: GrantInput): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    insert into engagement_grants (kind, beneficiary, amount_wei, ledger_entry_id, idempotency_key)
    values (${input.kind}, ${input.beneficiary}, ${input.amountWei.toString()}::numeric,
            ${input.ledgerEntryId}, ${input.idempotencyKey})
    on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
    returning id
  `
  const row = rows[0]
  if (!row) throw new WorldError('not_recorded', 'the grant did not record')
  return { id: row.id }
}
