/**
 * The four peers this world calls, and the credential it presents to exactly two of them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THE KILN THAT WAS COLD AND SAID IT WAS WARM (micro-org #222)
 *
 * `TESSERA_SERVICE_CREDENTIAL` held a token that lives **600 seconds**
 * (`identity/src/tokens.ts`, `SERVICE_TTL_SECONDS = 10 * 60`). The composition root read it once,
 * at import, and handed the same string to both credentialed clients:
 *
 *     token: async () => env.serviceCredential ?? ''      index.ts (studio) and :172 (ledger)
 *
 * The file even said so out loud — "until this service is granted a credential in the deploy, the
 * credential IS the token" — which is an accurate description of a container that authenticates
 * once, at boot, and never again while it runs for days.
 *
 * **Measured on the live estate rather than reasoned about.** The JWT inside
 * `TESSERA_SERVICE_CREDENTIAL` had been expired for twenty-six hours (2026-08-05) on a container
 * whose `/livez` was answering 200 the whole time. It answers 200 because `/livez` verifies nothing
 * and presents the credential to nobody: the one probe that would have caught this is the one that
 * makes an outbound call, and there was none.
 *
 * This is micro-org #197, the ten-minute cliff, arriving in this repository. It is the same shape
 * `market/src/upstreams.ts` documents after finding its own token seventeen hours dead.
 *
 * ## WHY A LONGER EXPIRY IS NOT THE FIX
 *
 * Because rotation IS expiry. A 24-hour service token is the same defect arriving a day later and
 * hurting more, and it makes a leaked token useful for a day. `micro-identity` fixed the server
 * half: a container holds a long-lived, revocable **credential** (`cfsc_…`) and exchanges it at
 * `POST /service-tokens/exchange` (`identity/src/server.ts`) for an ordinary 600-second token.
 * The exchange consumes nothing, so N replicas boot from one credential and a restart days later
 * still works. This file is the other half.
 *
 * ## WHY THIS IS A MODULE AND NOT TWENTY LINES OF `index.ts`
 *
 * Because the defect is a **wiring** defect, and wiring in the composition root is wiring no test
 * can reach: `index.ts` opens a pool, asserts a schema, opens a `LISTEN` connection, starts a job
 * runner and calls `listen()`, so importing it from a test starts a server. This repository had a
 * green suite of ninety-odd tests over a composition root that authenticated once and died —
 * because every test builds its own client, and a suite full of tests that build their own clients
 * cannot see a composition root that builds a different one.
 *
 * `servicetoken.test.ts` beside this file goes through `buildUpstreams`, and reverting the body
 * below to `async () => env.serviceCredential ?? ''` turns it red.
 *
 * ## ONE PROVIDER, TWO CREDENTIALED PEERS
 *
 * Studio and the ledger take the same principal — `service:tessera` — and identity issues one token
 * carrying the whole of this service's allowlist. A provider each would double the exchange traffic
 * against the one service the estate can least afford to amplify a fault in, and would let the two
 * halves of a single firing (generate the asset, grant the EMBER) drift onto different tokens with
 * different expiries for no benefit whatever.
 *
 * ## BOTH HOOKS, AND THE SECOND IS NOT DECORATION
 *
 * `token` keeps the bearer fresh on a schedule computed from this process's clock and `expiresIn`.
 * `authorizedFetch` catches a 401 from a peer, discards exactly the token that was refused, re-mints
 * and replays once. Without the second, correctness would rest on this process and studio agreeing
 * about what time it is — and on no credential ever being revoked mid-flight. The schedule is the
 * optimisation; the 401 path is the guarantee.
 *
 * Tessera's clients take `client?: Pick<HttpClient, 'request'>` rather than a `fetch`, so the second
 * hook is wired by constructing the `HttpClient` here and handing it in. That is the whole reason
 * `httpFor` exists; a client built from `baseUrl` alone would get the global `fetch` and the 401
 * backstop would silently not be there.
 *
 * ## THE TWO PEERS THAT HOLD NO CREDENTIAL, AND MUST NOT BE "FIXED"
 *
 *   * **market** takes the seller from the bearer (`market/src/server.ts`, `subjectOf` at
 *) and has no on-behalf-of lane. A listing created with this service's token would have
 *     `service:tessera` as its seller, and market credits sale proceeds to its own `sellerSubject`
 *     (`market/src/orders.ts`) — **the creator would be paid nothing, silently, with every test
 *     passing**. So both market calls relay the SELLER's own bearer, per request. See
 *     `marketclient.ts`'s header, and migration 11, which CHECKs market's answer against Tessera's
 *     so the mistake cannot even be stored.
 *   * **community** refuses a service token on `POST /v1/communities` outright — accepting one
 *     would make every service in the estate a voting member of every community — and takes the
 *     owner from the founding operator's own token.
 *
 * Neither gets `authorizedFetch` either, and that is the same decision rather than a second one. A
 * 401 on those two seams is a USER's token being refused; re-minting a service token would not help,
 * and `ServiceTokenProvider` would correctly decline to replay (the presented bearer is not the held
 * one) — but wiring it in would say, in code, that this service believes its own credential is
 * relevant there. It is not, and the asymmetry is the substance of both features.
 *
 * ## BOTH, OR NEITHER — the market seam's rule, preserved verbatim
 *
 * Activating a listing does two things that must both be possible: it issues the object into the
 * creator's ledger balance, and it lists at market. Market's activation reserves the item
 * (`market/src/listings.ts`, `holdEscrow` with `kind: 'listing_item'`), so a market configured
 * without a ledger cannot activate anything — it would create a market draft, fail at the reserve,
 * and leave a dead draft behind on every attempt. So the market client is built only when the ledger
 * client was, and the route answers 503 otherwise. A half-configured seam that fails at step three
 * is worse than an absent one, because the absent one says so in the answer.
 *
 * ## ABSENCE IS STILL A SUPPORTED MODE
 *
 * `env.ts` says so and `.env.example` promises it: without `STUDIO_URL` and a credential,
 * `POST /v1/kiln/firings` answers 503 `kiln_unconfigured` and every other route in the service
 * works. A world whose Kiln is cold is a world you can still walk around in. That is why `mode:
 * 'none'` is a value and not an exception, and why CI's `smoke-env` deliberately sets no credential
 * at all: it tests the configuration this service promises to survive.
 *
 * ## THE READINESS PROBE: DELIBERATELY NOT WIRED, AND LOUD INSTEAD
 *
 * `serviceTokenProbe` exists in `@cloudsforge/auth` and is not used here, for the reason
 * `market/src/upstreams.ts` gives and which is stronger in a world server than in a marketplace:
 *
 *   1. **Almost every route is served from this service's own tables.** Walking a ward, reading a
 *      parcel, placing an object, the fallow clock, presence — none of them makes an outbound call.
 *      A hard probe on the credential would take the whole title out of the balancer over a variable
 *      those routes cannot touch.
 *   2. **The routes that do need it already answer honestly.** A firing with no studio is 503
 *      `kiln_unconfigured`; a `ServiceTokenUnavailableError` maps to 503 through `statusFor`
 *      (`@cloudsforge/auth:244`), never 401.
 *   3. **Pulling the replica would fix nothing.** Every replica reads the same environment.
 *
 * So: not a probe, but `tessera_service_token_usable` on every scrape and a `fatal` at boot naming
 * what will break — which is the question that had no answer anywhere while the token was dead for
 * twenty-six hours behind a green `/livez`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient } from '@cloudsforge/http'
import { ServiceTokenProvider, ServiceTokenUnavailableError, type ProviderEvent } from '@cloudsforge/auth'
import { NO_SCOPES_REQUIRED } from '@cloudsforge/contracts-auth'
import type { Logger } from '@cloudsforge/telemetry'
import { createStudioClient, type StudioClient } from './studioclient.ts'
import { createLedgerClient, type LedgerClient } from './ledgerclient.ts'
import { createMarketClient, type MarketClient } from './marketclient.ts'
import { createCommunityClient, type CommunityClient } from './communityclient.ts'
// TYPE-ONLY, and that matters. `./env.ts` validates the process environment at import and calls
// `process.exit(1)` when it is incomplete, so a value import here would make this module — and
// therefore every test of the wiring in it — impossible to load without a full environment. That is
// the same "untestable therefore unchecked" property that let the cliff survive, and `service.ts`
// exists in this repository because four modules learned it the hard way.
import type { Env } from './env.ts'

/**
 * **Nothing beyond what the four clients below already declare**, and that is a statement about
 * where a demand belongs rather than a claim that this process needs no authority.
 *
 * This module is the composition root for tessera's outbound calls: it mints the service token, it
 * refreshes it, and it hands the bearer to every peer client. So `derive-grants.mjs` sees it build
 * an `HttpClient` and name a bearer, and asks it what scopes it needs — a question this file cannot
 * answer, because it makes no call of its own. Each demand belongs to the module that has the call
 * site and can be checked against the route it dials:
 *
 *   * `./studioclient.ts`    — `studio:write` for `POST /v1/generations`, `studio:read` for the
 *                              poll that follows it, deliberately not collapsed into the wider one
 *                              because a generation is a real charge against studio's credits.
 *   * `./ledgerclient.ts`    — `LEDGER_SCOPES`, exported there.
 *   * `./marketclient.ts`    — nothing: every write relays **the player's own bearer**.
 *   * `./communityclient.ts` — nothing, and community refuses a service token on the founding route
 *                              outright.
 *
 * Answering here instead would put tessera's whole grant on one file that dials nothing, which is
 * the shape of the hand-maintained compose map the derivation exists to have retired: a service
 * entry no route can be read off. So: `NO_SCOPES_REQUIRED`, from the module that presents the
 * credential, with the demands stated by the modules that spend it.
 */
export const UPSTREAM_SCOPES = NO_SCOPES_REQUIRED

/** The subset of `Env` this needs. Named so a test does not have to build a whole environment. */
export type UpstreamEnv = Pick<
  Env,
  | 'identityUrl'
  | 'identityCredential'
  | 'serviceCredential'
  | 'studioUrl'
  | 'ledgerUrl'
  | 'marketUrl'
  | 'communityUrl'
>

export interface UpstreamOptions {
  /** Test seam. Production uses the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly onEvent?: ((event: ProviderEvent) => void) | undefined
  /**
   * Passed to the studio client only, which logs the brief it sent so a generated object is a line
   * somebody can find. Injected rather than built here so this module needs nothing from `env.ts`.
   */
  readonly studioLogger?: Logger | undefined
}

/**
 * How this process obtains a bearer, NAMED rather than inferred from whether a string is set.
 *
 * `exchanged` is correct. `static` is the defect, still running wherever a deployment has not yet
 * been given the credential the bootstrap already minted for it. `none` cannot authenticate at all,
 * and is a supported mode when no credentialed upstream is configured. Three states, because "the
 * token is not working" and "there is no token" send an operator to different places — which is the
 * whole lesson of the twenty-six silent hours this fixes.
 */
export type CredentialMode = 'exchanged' | 'static' | 'none'

export interface Upstreams {
  readonly mode: CredentialMode
  /** `null` unless `mode` is `exchanged`. What `index.ts` samples for the readiness gauge. */
  readonly identityTokens: ServiceTokenProvider | null
  /** The Kiln's upstream. `undefined` answers 503 `kiln_unconfigured`. */
  readonly studio: StudioClient | undefined
  /** Grants, booking escrow and the wallet strip. `undefined` answers 503 at those routes. */
  readonly ledger: LedgerClient | undefined
  /** Listings. Built only when the ledger was — see BOTH, OR NEITHER in the header. */
  readonly market: MarketClient | undefined
  /** Ward governance. Holds no credential, deliberately — see the header. */
  readonly community: CommunityClient | undefined
}

export function buildUpstreams(env: UpstreamEnv, options: UpstreamOptions = {}): Upstreams {
  const identityTokens = env.identityCredential
    ? new ServiceTokenProvider({
        identityUrl: env.identityUrl,
        credential: env.identityCredential,
        // Not narrowed. Identity issues the service's whole allowlist, and at boot this process
        // cannot know which of its call sites will be reached first — a Kiln firing needs
        // `studio:write`, an engagement grant needs `ledger:post`, a booking needs
        // `ledger:reserve`, and the scheduled fallow sweep may reach any of them hours later. A
        // narrowing that drifted from `deploy/scripts/derive-grants.mjs`'s derived map would 403
        // with nothing in either log naming the cause.
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      })
    : null

  const mode: CredentialMode = identityTokens ? 'exchanged' : env.serviceCredential ? 'static' : 'none'

  /**
   * What the two credentialed clients ask for their `Authorization` header.
   *
   * **Rejects rather than resolving `''` when there is nothing to present.** The old seam resolved
   * the empty string, which produced the header `Authorization: Bearer ` — a syntactically valid
   * header carrying nothing, which studio and the ledger answer 401 to. That 401 is
   * indistinguishable from "the peer refused our credential" when the truth is "nobody gave this
   * service one", and those are different mornings. `ServiceTokenUnavailableError` maps to **503,
   * never 401** (`statusFor`, `@cloudsforge/auth:244`), for the same reason `Verifier` answers 503
   * on an unreachable JWKS: a fault in the thing that decides authentication is not evidence that
   * the caller is unauthenticated.
   */
  const token = (): Promise<string> => {
    if (identityTokens) return identityTokens.token()
    if (env.serviceCredential) return Promise.resolve(env.serviceCredential)
    return Promise.reject(
      new ServiceTokenUnavailableError(
        'no credential is configured; set TESSERA_IDENTITY_CREDENTIAL (long-lived, cfsc_…, from POST /service-credentials)',
      ),
    )
  }

  // The provider's own `fetch` is the transport it exchanges over. `authorizedFetch` is what the
  // CREDENTIALED clients get, and it is the layer where a 401 is visible and where the header was
  // set — so hooking it needs no change at any call site and cannot be forgotten at one of them.
  const authorized = identityTokens?.authorizedFetch ?? options.fetch
  // And this is what the two RELAYING clients get: the bare test seam, never the provider. See
  // "THE TWO PEERS THAT HOLD NO CREDENTIAL" in the header.
  const relayed = options.fetch

  const httpFor = (baseUrl: string, name: string, fetch: typeof globalThis.fetch | undefined) =>
    new HttpClient({ baseUrl, name, ...(fetch ? { fetch } : {}) })

  const studio =
    env.studioUrl && mode !== 'none'
      ? createStudioClient({
          baseUrl: env.studioUrl,
          // A FUNCTION, not a value, because a token expires — and now something renews it.
          token,
          client: httpFor(env.studioUrl, 'studio', authorized),
          ...(options.studioLogger ? { logger: options.studioLogger } : {}),
        })
      : undefined

  const ledger =
    env.ledgerUrl && mode !== 'none'
      ? createLedgerClient({
          baseUrl: env.ledgerUrl,
          token,
          client: httpFor(env.ledgerUrl, 'ledger', authorized),
        })
      : undefined

  const market =
    env.marketUrl && ledger
      ? createMarketClient({
          baseUrl: env.marketUrl,
          client: httpFor(env.marketUrl, 'market', relayed),
        })
      : undefined

  const community = env.communityUrl
    ? createCommunityClient({
        baseUrl: env.communityUrl,
        client: httpFor(env.communityUrl, 'community', relayed),
      })
    : undefined

  return { mode, identityTokens, studio, ledger, market, community }
}
