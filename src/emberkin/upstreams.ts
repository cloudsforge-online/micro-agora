/**
 * The three peers this title calls, and the one credential it presents to all of them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THE TEN-MINUTE CLIFF, ARRIVING HERE (micro-org #228)
 *
 * `EMBERKIN_SERVICE_TOKEN` held a token minted by `POST /service-tokens`, which lives **600
 * seconds** (`identity/src/tokens.ts`, `SERVICE_TTL_SECONDS`). The composition root read it once,
 * at import, and handed the same string to all three clients for the life of the process:
 *
 *     const token = (): string => env.serviceToken      // `index.ts`, before this change
 *
 * So this service authenticated to billing, to the ledger and to worlds **exactly once per
 * bootstrap**, and every call after minute ten presented a corpse.
 *
 * **CONFIRMED BEFORE IT WAS CHANGED, rather than inferred from the issue.** Three readings, all on
 * 2026-08-09:
 *
 *   1. `env.ts`'s `requiredMintedToken` demands the JWT SHAPE of `EMBERKIN_SERVICE_TOKEN` and
 *      says in its own comment that the value is "PRESENTED as a bearer, verbatim, with no
 *      exchange". So the slot holds a *minted token*, not a credential — the guard added by
 *      micro-org #212 is itself the evidence.
 *   2. `HttpClient` awaits `token()` **per attempt** (`@cloudsforge/http`, and its own test "the
 *      auth token is fetched per attempt so a short-TTL service token can refresh"). The seam was
 *      therefore always capable of refreshing; the function behind it simply returned a constant,
 *      so re-reading it per attempt re-read the same dead string.
 *   3. Nothing in this repository re-minted anything. `EMBERKIN_SERVICE_TOKEN` appeared in exactly
 *      one place — `env.ts` — and `index.ts` was its only reader.
 *
 * ## WHY `/livez` REPORTED HEALTHY THROUGHOUT
 *
 * The liveness probe makes no outbound call, so it never presents the token to anybody. The three
 * upstream probes read each peer's own `/livez`, which is unauthenticated. There was no check
 * anywhere that could have gone red, which is why the defect is measured in issues rather than in
 * alerts.
 *
 * Worse here than in a service with a timer: emberkin's upstream calls sit on **request paths**, so
 * a bootstrap is not guaranteed to outrun the expiry. It fails when a player acts more than ten
 * minutes after one, and the symptom is a 401 on a cosmetic purchase or an achievement post.
 *
 * ## WHY A LONGER EXPIRY IS NOT THE FIX
 *
 * Because rotation IS expiry. A 24-hour service token is the same defect arriving a day later and
 * hurting more, and it makes a leaked token useful for a day. `micro-identity` fixed the server
 * half: a container holds a long-lived, revocable **credential** (`cfsc_…`) and exchanges it at
 * `POST /service-tokens/exchange` for an ordinary 600-second token. The exchange consumes nothing,
 * so N replicas boot from one credential and a restart days later still works. This file is the
 * other half.
 *
 * ## THE REFRESH POINT IS THE ISSUER'S NUMBER, NOT OURS
 *
 * `ServiceTokenProvider` schedules from the `expiresIn` **the exchange answered with**, and
 * `readExchange` refuses a response that omits it rather than defaulting one. Nothing in this
 * repository names 600. A copy of that constant here would be a second source of truth for a number
 * identity owns, and the failure mode of the drift is silent: guess longer than the truth and every
 * token expires in service, which is the original defect wearing the fix's clothes. The one place
 * `600` is written down in this repository is `servicetoken.test.ts`, where it is the *simulated
 * identity's* answer and is asserted against rather than relied upon.
 *
 * ## REFRESH EARLY — AT A JITTERED 80%, NOT AT EXPIRY
 *
 * Refreshing when the token has expired is the bug above, one race narrower: the token can die
 * between the check and the peer's own reading of `exp`. The provider refreshes at 80% of each
 * token's life — for a ten-minute token, at minute eight — which leaves **two minutes of slack** in
 * which a failed exchange can be retried repeatedly without one request ever presenting something
 * expired. The refresh happens *behind* the request: the caller is handed the still-valid token it
 * already has and pays nothing for the exchange.
 *
 * 80% and not 95%: the margin has to be worth more than one attempt, because a single blip at
 * identity during a two-second window is not a rare event across an estate of replicas. 80% and not
 * 50%: doubling the exchange rate against the one service everything else depends on buys nothing.
 * The fraction is jittered per token across [75%, 85%] so replicas that boot together in a rolling
 * deploy do not all reach the refresh point in the same instant.
 *
 * And the schedule is still only the optimisation. `authorizedFetch` is the guarantee: a 401 from a
 * peer discards exactly the token that was refused, re-mints, and replays **once**. Without it,
 * correctness would rest on this process and worlds agreeing about what time it is, and on no
 * credential ever being revoked mid-flight.
 *
 * ## A FAILED REFRESH IS NEVER PRESENTED AS SUCCESS
 *
 * Three outcomes, deliberately distinguishable:
 *
 *   * **A held token that is still valid** stays in use while the exchange retries in the
 *     background. An identity outage does not retract a token it already signed, and failing early
 *     would take this title down for a fault it is designed to ride out.
 *   * **A held token that has expired, or none at all** raises `ServiceTokenUnavailableError`. The
 *     request is **not sent** — not unauthenticated, and not with a stale bearer. Each client wraps
 *     it in its own `…UnavailableError`, which `server.ts` answers **503** (`ledger_unavailable`,
 *     `entitlements_unavailable`) and `achievements.ts` treats as retryable. Never a 401: a 401
 *     says "your credential is bad" when the truth is "identity is down", and that misattribution
 *     is what sends an operator to the wrong service at three in the morning. It is the same
 *     reasoning `Verifier` uses inbound, pointed the other way.
 *   * **Nothing configured at all** rejects before a byte is sent, rather than resolving `''` and
 *     letting the peer answer 401 to a header carrying nothing.
 *
 * `index.ts` also samples `emberkin_service_token_usable` on every scrape, so "this container has
 * not held a live token for four minutes" is a number rather than a guess.
 *
 * ## NEITHER THE CREDENTIAL NOR ANY TOKEN IS EVER LOGGED
 *
 * Both are live credentials. Nothing in this file, in `index.ts`'s provider events or in
 * `snapshot()` returns either: the events carry a service name, an `expiresIn` and a refresh
 * interval, and the snapshot carries a boolean, a count of seconds and a failure *message*. The
 * credential goes in an `Authorization` header and never in a query parameter, so a proxy access
 * log in front of identity cannot capture it either.
 *
 * ## WHY THIS IS A MODULE AND NOT TWENTY LINES OF `index.ts`
 *
 * Because the defect is a **wiring** defect, and wiring in the composition root is wiring no test
 * can reach: `index.ts` opens a pool, asserts a schema, loads content, starts a job runner and
 * calls `listen()`, so importing it from a test starts a server. This repository had a green suite
 * over a composition root that authenticated once and then died, because every test builds its own
 * client and a suite full of tests that build their own clients cannot see a composition root that
 * builds a different one. `servicetoken.test.ts` beside this file goes through `buildUpstreams`,
 * and reverting the body below to `() => env.serviceToken` turns it red.
 *
 * ## ONE PROVIDER, THREE PEERS
 *
 * Billing, the ledger and worlds all take the same principal — `service:emberkin` — and identity
 * issues one token carrying the whole of this service's allowlist. A provider each would triple the
 * exchange traffic against the one service the estate can least afford to amplify a fault in, and
 * would let the two halves of a single act (check the entitlement, post the reward) drift onto
 * different tokens with different expiries for no benefit whatever.
 *
 * SD-05 is unaffected: it forbids *sharing a token between services*, not sharing one service's own
 * token between that service's own call sites, which is what a single principal means.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { ServiceTokenProvider, ServiceTokenUnavailableError, type ProviderEvent } from '@cloudsforge/auth';
import { NO_SCOPES_REQUIRED } from '@cloudsforge/contracts-auth';
import { httpBillingClient, type EntitlementReader } from './billingclient.ts';
import { httpLedgerClient, type LedgerClient } from './ledgerclient.ts';
import { httpWorldsClient, type WorldsClient } from './worldsclient.ts';
// TYPE-ONLY, and that matters. `./env.ts` validates the process environment at import and calls
// `process.exit(1)` when it is incomplete, so a value import here would make this module — and
// therefore every test of the wiring in it — impossible to load without a full environment. That
// is the same "untestable therefore unchecked" property that let the cliff survive here.
import type { Env } from './env.ts';

/**
 * **Nothing beyond what the three clients below already declare**, and that is a statement about
 * where a demand belongs rather than a claim that this process needs no authority.
 *
 * This module is the composition root for emberkin's outbound calls: it mints the service token, it
 * refreshes it, and it hands the bearer to every peer client. So `derive-grants.mjs` sees it
 * present a credential and asks it what scopes it needs — a question this file cannot answer,
 * because it makes no call of its own. Each demand belongs to the module that has the call site and
 * can be checked against the route it dials: `BILLING_SCOPES` in `./billingclient.ts`,
 * `LEDGER_SCOPES` in `./ledgerclient.ts`, `WORLDS_SCOPES` in `./worldsclient.ts`.
 *
 * Answering here instead would put emberkin's whole grant on one file that dials nothing, which is
 * the shape of the hand-maintained map the derivation exists to have retired.
 */
export const UPSTREAM_SCOPES = NO_SCOPES_REQUIRED;

/** The subset of `Env` this needs. Named so a test does not have to build a whole environment. */
export type UpstreamEnv = Pick<
  Env,
  | 'identityUrl'
  | 'identityCredential'
  | 'serviceToken'
  | 'ledgerUrl'
  | 'billingUrl'
  | 'worldsUrl'
  | 'upstreamDeadlineMs'
>;

export interface UpstreamOptions {
  /** Test seam. Production uses the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly onEvent?: ((event: ProviderEvent) => void) | undefined;
  /** Overridable only for tests; a title knows its own slug. */
  readonly titleSlug?: string | undefined;
}

/**
 * How this process obtains a bearer, NAMED rather than inferred from whether a string is set.
 *
 * `exchanged` is correct. `static` is the defect, still running wherever a deployment has not yet
 * been given the credential the bootstrap already minted for it. `none` cannot authenticate at all.
 * Three states, because "the token is not working" and "there is no token" send an operator to
 * different places.
 *
 * `none` is unreachable through `loadEnv`, which refuses to boot without one of the two — see
 * `requireOneCredentialSource` in `env.ts`. It is modelled anyway because `UpstreamEnv` is a
 * structural type a caller can build by hand, and because the alternative to naming the state is
 * resolving the empty string into an `Authorization: Bearer ` that every peer answers 401 to.
 */
export type CredentialMode = 'exchanged' | 'static' | 'none';

export interface Upstreams {
  readonly mode: CredentialMode;
  /** `null` unless `mode` is `exchanged`. What `index.ts` samples for the readiness gauge. */
  readonly identityTokens: ServiceTokenProvider | null;
  /** Billing: what this account owns. The cosmetic gate. */
  readonly billing: EntitlementReader;
  /** The ledger: season rewards and cosmetic purchases are postings, not columns. */
  readonly ledger: LedgerClient;
  /** Worlds: the shared profile and its achievements. */
  readonly worlds: WorldsClient;
}

export function buildUpstreams(env: UpstreamEnv, options: UpstreamOptions = {}): Upstreams {
  const identityTokens = env.identityCredential
    ? new ServiceTokenProvider({
        identityUrl: env.identityUrl,
        credential: env.identityCredential,
        // NOT narrowed to a scope list. Identity issues the service's whole allowlist, and at boot
        // this process cannot know which of its call sites will be reached first — equipping a
        // cosmetic needs `billing:read`, a season reward needs `ledger:post`, and the achievement
        // job may reach `worlds:write` hours later. A narrowing that drifted from
        // `deploy/scripts/derive-grants.mjs`'s derived map would 403 with nothing naming the cause.
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      })
    : null;

  const mode: CredentialMode = identityTokens ? 'exchanged' : env.serviceToken ? 'static' : 'none';

  /**
   * What all three clients ask for their `Authorization` header, per attempt.
   *
   * **Rejects rather than resolving `''` or `undefined` when there is nothing to present.**
   * `HttpClient` omits the header entirely for `undefined`, so resolving it would send an
   * unauthenticated request, collect a 401, and record it as the peer having decided something —
   * `LedgerRefusedError` is `peerDecided` and is deliberately never retried, so a reward would be
   * permanently abandoned over a missing variable. `ServiceTokenUnavailableError` maps to **503,
   * never 401** through `statusFor`, and each client's own `…UnavailableError` says the same at the
   * route.
   */
  const token = (): Promise<string> => {
    if (identityTokens) return identityTokens.token();
    if (env.serviceToken) return Promise.resolve(env.serviceToken);
    return Promise.reject(
      new ServiceTokenUnavailableError(
        'no credential is configured; set EMBERKIN_IDENTITY_CREDENTIAL (long-lived, cfsc_…, from POST /service-credentials)',
      ),
    );
  };

  // The provider's own `fetch` is the transport it exchanges over. `authorizedFetch` is what the
  // CLIENTS get, and it is the layer where a 401 is visible and where the header was set — so
  // hooking it needs no change at any call site and cannot be forgotten at one of them.
  const fetch = identityTokens?.authorizedFetch ?? options.fetch;
  const shared = { token, deadlineMs: env.upstreamDeadlineMs, ...(fetch ? { fetch } : {}) };

  return {
    mode,
    identityTokens,
    billing: httpBillingClient({ baseUrl: env.billingUrl, ...shared }),
    ledger: httpLedgerClient({ baseUrl: env.ledgerUrl, originatingService: 'emberkin', ...shared }),
    worlds: httpWorldsClient({
      baseUrl: env.worldsUrl,
      ...shared,
      ...(options.titleSlug ? { titleSlug: options.titleSlug } : {}),
    }),
  };
}
