/**
 * `micro-market`, over HTTP. The moment a creator's object becomes something another player can buy.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY ROUTE AND FIELD HERE WAS READ OUT OF `market/src/server.ts`. NONE WAS IMAGINED.**
 *
 * The estate has been bitten by the opposite repeatedly, and the sharpest case is worth keeping
 * next to the code: `@cloudsforge/ui` posted the SSO callback to `/auth/exchange`, a route identity
 * has never served, and the test pinning it compared the URL against a copy of itself so it could
 * never fail. So the two routes below are cited, and `marketclient.test.ts` asserts the request
 * this file builds against a stub that refuses anything market's own handler would refuse.
 *
 *   * `POST /v1/listings`            — `market/src/server.ts`. Answers the created listing.
 *   * `POST /v1/listings/:id/activate` — `market/src/server.ts`. Reserves the item, goes live.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * **THE CREATOR'S OWN TOKEN IS FORWARDED, AND A SERVICE TOKEN WOULD BE A SILENT THEFT.**
 *
 * This is the decision in this file, and it is forced by market's source rather than preferred:
 *
 *     const seller = subjectOf(principal)            market/src/server.ts
 *     function subjectOf(principal: Principal) {     market/src/server.ts
 *       return principal.kind === 'user'
 *         ? `user:${subjectUserId(principal, undefined)}`
 *         : `service:${principal.service}`
 *     }
 *
 * There is no `x-user-id` lane on this route — the estate-wide on-behalf-of convention that
 * `aetherholm`, `emberkin`, `nda`, `wallet` and this service's own `requireUser` implement is
 * simply absent from market. So a listing created with Tessera's service credential is a listing
 * whose `sellerSubject` is the literal string `service:tessera`, and `market/src/orders.ts`
 * credits sale proceeds to `subject: listing.sellerSubject`. **The money would land in Tessera's
 * own ledger account and the creator would be paid nothing** — silently, with every test passing,
 * because the listing is valid, the sale settles and the trial balance is correct.
 *
 * Forwarding the player's bearer token is safe here for a reason rather than by assumption: the
 * estate has ONE audience (`AUDIENCE = 'cloudsforge'`, `runtime/packages/auth/src/index.ts`,
 * and `index.test.ts` — "a wrong audience is refused — one audience for the whole estate"), so
 * the token the player presented to Tessera is already a token market accepts. Relaying it grants
 * market nothing the player's own browser could not do by calling market directly. It is a relay,
 * not an escalation.
 *
 * The consequence is stated where it is enforced rather than only here: activation needs the
 * seller's own credential, so a SERVICE caller cannot activate on a user's behalf, and
 * `server.ts` refuses that rather than quietly listing under the wrong subject. And because a
 * relay is still a thing that can be got wrong, migration 11 records market's answer for
 * `seller_subject` and CHECKs it against Tessera's — so the failure above is refused by the
 * database even if this comment is one day ignored.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { LedgerAssetCode, TokenAssetCode } from '@cloudsforge/contracts-money'
import { ASSET } from './sparks.ts'

/**
 * `game_item`, which market already has.
 *
 * §10's "two repositories that need nothing": `asset_kind` already includes `game_item`
 * (`market/src/migrations.ts`) and `item_urn` has no format constraint at all
 * (`market/src/migrations.ts`). So the work is entirely on this side, and this constant is the
 * whole of what Tessera had to agree with.
 */
export const MARKET_ASSET_KIND = 'game_item'

/**
 * `fixed`, and `custodial` — neither is a parameter.
 *
 * §8.5, and `tessera_listings_are_custodial` already refuses the alternative one layer down: "the
 * royalty is enforced ONLY on the custodial settlement path ... For an `onchain` listing the
 * royalty is recorded on the order row and NEVER POSTED." An onchain Tessera listing is a listing
 * whose royalty is a number in a database and nothing else.
 */
export const MARKET_PRICING_MODE = 'fixed'
export const MARKET_SETTLEMENT_MODE = 'custodial'

export class MarketError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 502) {
    super(message)
    this.name = 'MarketError'
    this.code = code
    this.status = status
  }
}

/**
 * What market answered. Exactly the fields `listingWire` puts on the wire
 * (`market/src/server.ts`) that Tessera then has something to check.
 */
export interface MarketListing {
  readonly id: string
  /** Market's own seller. CHECKed against Tessera's in the schema — see the file header. */
  readonly sellerSubject: string
  /** Market's own snapshotted fee. The proof that the rate is the one rate — see `economy.ts`. */
  readonly platformFeeBps: number
  readonly royaltyBps: number
  readonly status: string
  readonly escrowed: boolean
}

export interface CreateListingInput {
  readonly itemUrn: string
  readonly itemAssetCode: TokenAssetCode
  readonly priceWei: bigint
  readonly royaltyBps: number
  /** The SELLER's bearer token, relayed. Never a service credential — see the file header. */
  readonly sellerToken: string
  /** Tessera's listing id. Market dedupes the POST on it, so a retry lists once. */
  readonly idempotencyKey: string
  readonly correlationId: string
}

export interface ActivateInput {
  readonly marketListingId: string
  readonly sellerToken: string
  readonly correlationId: string
}

export interface MarketClient {
  createListing(input: CreateListingInput): Promise<MarketListing>
  activate(input: ActivateInput): Promise<MarketListing>
  find(marketListingId: string): Promise<MarketListing | null>
}

export interface MarketClientOptions {
  readonly baseUrl: string
  /** Test seam. */
  readonly client?: Pick<HttpClient, 'request'>
}

export function createMarketClient(options: MarketClientOptions): MarketClient {
  const http = options.client ?? new HttpClient({ baseUrl: options.baseUrl, name: 'market' })

  return {
    async createListing(input) {
      const body = await call(http, '/v1/listings', {
        method: 'POST',
        deadlineMs: 15_000,
        // In the body it is what market's `withIdempotentRoute` dedupes on; on the request it is
        // what makes a POST retriable at all, because `HttpClient` attempts a non-idempotent
        // method exactly once without one. `ledgerclient.ts` says the same, and the two
        // must agree.
        idempotencyKey: input.idempotencyKey,
        requestId: input.correlationId,
        headers: { authorization: `Bearer ${input.sellerToken}` },
        body: {
          assetKind: MARKET_ASSET_KIND,
          itemUrn: input.itemUrn,
          // The ITEM's asset code. `micro-ledger` reserves THIS at activation, not the price's.
          itemAssetCode: input.itemAssetCode,
          // One object is one thing. A decimal string, like every other amount on this wire.
          quantity: '1',
          pricingMode: MARKET_PRICING_MODE,
          settlementMode: MARKET_SETTLEMENT_MODE,
          // The PRICE's asset code — EMBER. `parseAmount` reads it as a decimal string
          // (`market/src/money.ts`); a JSON number is an IEEE 754 double and 10^18 wei does
          // not survive one.
          price: input.priceWei.toString(),
          assetCode: ASSET satisfies LedgerAssetCode,
          royaltyBps: input.royaltyBps,
          // ═══════════════════════════════════════════════════════════════════════════════════
          // WHAT IS NOT SENT, AND THIS ABSENCE IS THE POINT: `platformFeeBps`.
          //
          // §7.2's fifth refusal — "the platform fee and the royalty cap are identical for every
          // account, and no SKU, tier or subscription reduces either". Market reads its fee from
          // `deps.platformFeeBps`, its own environment (`market/src/server.ts`), and there is
          // no body field it would read one from. So Tessera cannot express a per-account fee to
          // market even by accident, and `marketclient.test.ts` asserts the exact key set of this
          // object against a literal list so that adding one cannot happen quietly.
          //
          // `collectionId` and `sellerWalletId` are absent for a duller reason: a Tessera object
          // belongs to no market collection and settles custodially, so both would be null.
          // ═══════════════════════════════════════════════════════════════════════════════════
        },
      })
      return readListing(body, 'market did not answer with a listing')
    },

    async activate(input) {
      try {
        const body = await call(http, `/v1/listings/${encodeURIComponent(input.marketListingId)}/activate`, {
          method: 'POST',
          deadlineMs: 15_000,
          requestId: input.correlationId,
          headers: { authorization: `Bearer ${input.sellerToken}` },
          // `onchainEscrowTx` is required ONLY for an `onchain` listing
          // (`market/src/server.ts`) and every Tessera listing is custodial, so the body is
          // deliberately empty rather than carrying a null that would look like an unfinished
          // branch.
          body: {},
        })
        return readListing(body, 'market did not answer with an activated listing')
      } catch (err) {
        // ═══════════════════════════════════════════════════════════════════════════════════
        // ALREADY ACTIVE IS A SUCCESS, AND THIS BRANCH IS THE CRASH-RECOVERY PATH.
        //
        // Tessera activates at market and THEN records the result. A crash between the two
        // leaves a live market listing and a Tessera row still marked draft — the safe
        // direction, because the alternative is a Tessera row claiming to be live against a
        // listing market has never activated. The retry then has to converge, and without this
        // branch it never would: market answers `a active listing cannot be activated` with a
        // 409 (`ListingStateError`, `market/src/listings.ts`), for ever.
        //
        // So a refusal is re-read rather than trusted. `GET /v1/listings/:id`
        // (`market/src/server.ts`) is the authority on what actually happened, and only a
        // listing market itself reports as `active` is accepted. A 409 for any OTHER reason —
        // frozen by a moderation case, sold, cancelled — still surfaces, because the re-read
        // says so.
        // ═══════════════════════════════════════════════════════════════════════════════════
        if (!(err instanceof MarketError) || err.status !== 409) throw err
        const existing = await this.find(input.marketListingId)
        if (existing?.status === 'active') return existing
        throw err
      }
    },

    async find(marketListingId) {
      try {
        const body = await call(http, `/v1/listings/${encodeURIComponent(marketListingId)}`, {
          method: 'GET',
          deadlineMs: 10_000,
        })
        return readListing(body, 'market did not answer with a listing')
      } catch (err) {
        if (err instanceof MarketError && err.status === 404) return null
        throw err
      }
    },
  }
}

/**
 * One place that turns market's failures into this service's.
 *
 * A 4xx from market is market's decision and must not be retried into existence; a 5xx or a
 * timeout is an outage. `HttpClient` already throws `HttpError` carrying the status, so this
 * classifies rather than re-implements.
 */
async function call(
  http: Pick<HttpClient, 'request'>,
  path: string,
  options: Parameters<HttpClient['request']>[1],
): Promise<unknown> {
  try {
    return await http.request<unknown>(path, options)
  } catch (err) {
    if (err instanceof HttpError) {
      // 403 `policy_denied` and 503 `listing_paused` are both real answers a seller must be able
      // to read (`market/src/server.ts`), so the status is carried rather than
      // flattened to 502. A listing refused by policy is not a Tessera outage.
      throw new MarketError(
        err.status >= 500 ? 'market_unavailable' : 'market_refused',
        `market answered ${err.status} for ${path}: ${err.body.slice(0, 300)}`,
        err.status >= 500 ? 502 : err.status,
      )
    }
    throw new MarketError('market_unavailable', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Read market's answer, refusing a shape rather than defaulting one.
 *
 * Every field below is one Tessera then CHECKs against its own row, so a missing one must fail
 * here and not arrive as a `0` or an empty string. `platformFeeBps: 0` defaulted from an absent
 * field would silently satisfy a comparison against a zero-fee estate and pass the reconciliation
 * this whole seam exists to perform.
 */
function readListing(body: unknown, whenMissing: string): MarketListing {
  const listing = (body as { listing?: unknown } | null)?.listing
  if (typeof listing !== 'object' || listing === null) throw new MarketError('bad_response', whenMissing)
  const l = listing as Record<string, unknown>
  const id = l['id']
  const sellerSubject = l['sellerSubject']
  const platformFeeBps = l['platformFeeBps']
  const royaltyBps = l['royaltyBps']
  const status = l['status']
  if (typeof id !== 'string' || id.length === 0) throw new MarketError('bad_response', 'market returned no listing id')
  if (typeof sellerSubject !== 'string' || sellerSubject.length === 0) {
    throw new MarketError('bad_response', 'market returned a listing with no seller')
  }
  if (!Number.isInteger(platformFeeBps)) {
    throw new MarketError('bad_response', 'market returned a listing with no platform fee — the rate cannot be checked')
  }
  if (!Number.isInteger(royaltyBps)) {
    throw new MarketError('bad_response', 'market returned a listing with no royalty — the terms cannot be checked')
  }
  if (typeof status !== 'string' || status.length === 0) {
    throw new MarketError('bad_response', 'market returned a listing with no status')
  }
  return {
    id,
    sellerSubject,
    platformFeeBps: platformFeeBps as number,
    royaltyBps: royaltyBps as number,
    status,
    escrowed: l['escrowed'] === true,
  }
}
