/**
 * The two rates a custodial stake is priced by — and this module owns neither.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **FAIL CLOSED, WITHOUT EXCEPTION.**
 *
 * `micro-billing`'s `pricingclient.ts` states the rule and the reason: "you cannot charge somebody
 * in a currency you cannot price, and the alternative to refusing is guessing at how much of their
 * money to take." A stake is the same act with a longer tail — the guess would not merely take the
 * wrong amount, it would size a position in a market that then sits for weeks.
 *
 * Three specific traps, each one a defect this estate has actually shipped somewhere:
 *
 *   1. **`usable: false` is served as a 200** (`pricing/src/server.ts` — "a 404 would be a
 *      lie about the asset existing and a 503 would suggest retrying will help"). So a status
 *      check alone reads an unusable rate as a usable one. **The flag is what is checked.**
 *   2. **`BigInt('') === 0n`.** A missing or empty `usdScaled` would become a rate of zero, and a
 *      rate of zero divides. The digits are required by pattern BEFORE `BigInt` is called.
 *   3. **The scale is checked, not assumed.** Pricing publishes `rateScale` precisely so a
 *      consumer never has to assume it. Assuming it is how a stake is sized a million times out.
 *
 * ── WHY BOTH LEGS ARE READ IN ONE CALL SITE ───────────────────────────────────────────────────
 *
 * A stake needs USD-per-staked-asset and USD-per-EMBER. Reading them at different moments would
 * mean the cross rate belonged to no instant, and the row would record two numbers that were never
 * simultaneously true. `stakeRates` reads both together and refuses if either is unreadable.
 *
 * ── MID-MARKET, NOT THE SPREAD ────────────────────────────────────────────────────────────────
 *
 * `usdScaled`, not `usdSellScaled`/`usdBuyScaled`. The conversion spread is R7 in
 * 15-monetisation-model.md §3 and it is charged on an explicit coin↔coin conversion the user asks
 * for. Applying it silently inside a stake would be a fee the stake screen did not name. If the
 * platform later wants a staking spread it must be a stated line item.
 *
 * ── THE ADMINISTERED LEG, SAID OUT LOUD ───────────────────────────────────────────────────────
 *
 * EMBER's rate is administered — `pricing/src/rates.ts`, `ADMINISTERED_ASSETS = ['EMBER']` —
 * because Hearth has no exchange listing. So one leg of every non-EMBER stake is a figure an
 * operator typed. This client cannot fix that and does not pretend to; what it does is make the
 * figure that was used a recorded fact on the stake row, so that editing it later restates nothing
 * that already happened. That is the whole of the mitigation available in code. The rest is
 * governance, and 29 §6.4 is right that it goes to the owner.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Route verified against the other side: `GET /rates/:asset` (`pricing/src/server.ts`),
 * unauthenticated by design (`pricing/src/server.ts`), body `{ rate: RateView }`.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import { NO_SCOPES_REQUIRED } from '@cloudsforge/contracts-auth'
import { RATE_SCALE } from '@cloudsforge/contracts-chain'
import { POOL_ASSET, type StakeAssetCode, type StakeRates } from './stakeassets.ts'

/**
 * Nothing, and this module is not being modest about it: **it presents no credential at all.**
 *
 * `httpPricingClient` builds its `HttpClient` with a base url, a name and a deadline and no `token`
 * option (:104), because the one route it calls — `GET /rates/:asset` — is ungated by design
 * (`pricing/src/server.ts`; the rate board is public). There is no bearer to scope.
 *
 * It is declared anyway because `micro-deploy`'s `derive-grants.mjs` reads this file as one that
 * presents a credential. Its discriminator is `new HttpClient(` **and** a bearer word anywhere in
 * the file (`NAMES_A_BEARER`, derive-grants.mjs:280), and this file says "token" twice in prose
 * about the `TOKEN:` asset urn — "a token stake asset cannot be priced until it does". The
 * whole-file test is deliberately loose and should stay that way: narrowing it to the constructor
 * call once missed `admin-api/src/upstreams.ts`, which attaches its bearer sixteen lines later, and
 * a false negative there produced no grant at all rather than a wrong one.
 *
 * So the module that knows the answer states it, which is the arrangement everywhere else in this
 * estate. `NO_SCOPES_REQUIRED` rather than a bare `Object.freeze([])`: both are the same value and
 * only one of them reads as a decision.
 */
export const PRICING_SCOPES = NO_SCOPES_REQUIRED

/** A rate could not be obtained, or could not be trusted. Always refuses; never falls back. */
export class RateUnavailableError extends Error {
  readonly assetCode: string
  constructor(assetCode: string, message: string) {
    super(message)
    this.name = 'RateUnavailableError'
    this.assetCode = assetCode
  }
}

/** Digits and nothing else. See trap 2 in the header. */
const SCALED_PATTERN = /^\d{1,78}$/

function parseScaled(assetCode: string, value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !SCALED_PATTERN.test(value)) {
    throw new RateUnavailableError(
      assetCode,
      `pricing returned a ${field} for ${assetCode} that is not a decimal string of up to 78 digits`,
    )
  }
  return BigInt(value)
}

export interface PricingClient {
  /**
   * Both legs, together, for one stake.
   *
   * Returns the pair the row records. Throws `RateUnavailableError` if either leg is missing,
   * unusable, published at another scale, or non-positive — there is no partial success here,
   * because half a cross rate prices nothing.
   */
  stakeRates(stakeAsset: StakeAssetCode): Promise<StakeRates>
}

export interface PricingClientOptions {
  readonly baseUrl: string
  readonly deadlineMs: number
  /** Injected in tests. Absent in production, where the global is used. */
  readonly fetch?: typeof globalThis.fetch
}

interface RateBody {
  readonly rate?: {
    readonly usable?: unknown
    readonly reason?: unknown
    readonly usdScaled?: unknown
    readonly rateScale?: unknown
  }
}

export function httpPricingClient(options: PricingClientOptions): PricingClient {
  const http = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'pricing',
    defaultDeadlineMs: options.deadlineMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  async function leg(assetCode: StakeAssetCode): Promise<bigint> {
    // Pricing quotes a closed set of AssetCodes. A TOKEN: urn is not one of them and asking would
    // produce a 404 that this client would then have to interpret — so it is refused HERE, with
    // the reason, rather than turned into a generic transport failure the operator has to guess at.
    if (assetCode.startsWith('TOKEN:')) {
      throw new RateUnavailableError(
        assetCode,
        `micro-pricing quotes chain asset codes only and has no route for ${assetCode}; ` +
          'a token stake asset cannot be priced until it does',
      )
    }

    let body: RateBody
    try {
      body = await http.get<RateBody>(`/rates/${assetCode}`)
    } catch (err) {
      // Including a 4xx. A rate we were refused is not a rate we may improvise.
      const detail = err instanceof HttpError ? `HTTP ${err.status}` : String(err)
      throw new RateUnavailableError(
        assetCode,
        `could not read the ${assetCode} rate from pricing (${detail})`,
      )
    }

    const rate = body.rate
    if (!rate || typeof rate !== 'object') {
      throw new RateUnavailableError(assetCode, `pricing returned no rate object for ${assetCode}`)
    }
    // The flag, not the status code. See trap 1.
    if (rate.usable !== true) {
      const reason = typeof rate.reason === 'string' ? rate.reason : 'no reason given'
      throw new RateUnavailableError(assetCode, `the ${assetCode} rate is not usable: ${reason}`)
    }
    const publishedScale = parseScaled(assetCode, rate.rateScale, 'rateScale')
    if (publishedScale !== RATE_SCALE) {
      throw new RateUnavailableError(
        assetCode,
        `pricing publishes rates at a scale of ${publishedScale}, but this service computes at ${RATE_SCALE}`,
      )
    }
    const usdScaled = parseScaled(assetCode, rate.usdScaled, 'usdScaled')
    if (usdScaled <= 0n) {
      throw new RateUnavailableError(
        assetCode,
        `the ${assetCode} rate is ${usdScaled}, which cannot price anything`,
      )
    }
    return usdScaled
  }

  return {
    async stakeRates(stakeAsset) {
      // Staking the pool asset is the identity — no rate is applied, so no rate is read. Reading
      // one anyway would make an EMBER stake fail when the EMBER rate was briefly unreadable, for
      // an arithmetic that never uses it.
      if (stakeAsset === POOL_ASSET) {
        return { stakeUsdScaled: RATE_SCALE, poolUsdScaled: RATE_SCALE }
      }
      // Sequential rather than concurrent, deliberately: if the staked asset's leg is unreadable
      // there is no stake to price, and firing a second request for the EMBER leg only to discard
      // it puts load on pricing at exactly the moment it is already struggling.
      const stakeUsdScaled = await leg(stakeAsset)
      const poolUsdScaled = await leg(POOL_ASSET)
      return { stakeUsdScaled, poolUsdScaled }
    },
  }
}

/**
 * The client for a deployment with no `PRICING_URL`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN ABSENT RATE SOURCE IS NOT A PERMISSIVE ONE.** This refuses every rate read, with the reason,
 * so a stake in an asset the platform cannot price is refused rather than priced at a default. It
 * is the same shape as `micro-foresight`'s other optional peers — an unconfigured engagement
 * programme refuses a seed rather than planning one of zero.
 *
 * The one thing it does NOT refuse is a stake in the pool asset, because that applies no rate at
 * all. A deployment that never turned on a second asset therefore behaves exactly as it did before
 * this existed, which is the property that lets `PRICING_URL` be absent in the live compose without
 * the service refusing to boot.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function unconfiguredPricingClient(): PricingClient {
  return {
    async stakeRates(stakeAsset) {
      if (stakeAsset === POOL_ASSET) {
        return { stakeUsdScaled: RATE_SCALE, poolUsdScaled: RATE_SCALE }
      }
      throw new RateUnavailableError(
        stakeAsset,
        'this deployment has no PRICING_URL, so no rate can be read and a stake in ' +
          `${stakeAsset} cannot be priced`,
      )
    },
  }
}
