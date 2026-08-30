/**
 * The five peers this service calls, and the credential it presents to all of them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THE LEASED JOB AND THE TEN-MINUTE TOKEN
 *
 * `FORESIGHT_SERVICE_TOKEN` held a token that lives **600 seconds** (`identity/src/tokens.ts`).
 * The composition root read it once, at import:
 *
 *     const token = () => env.serviceToken        // index.ts, for the life of the process
 *
 * and handed that one function to custody, the indexer, the ledger,
 * policy and admin-api. There was no `ServiceTokenProvider`, no
 * `POST /service-tokens/exchange` and no `cfsc_` anywhere in `src/` — checked by grep, not inferred.
 * So every outbound call this service makes authenticated **once per bootstrap** and never again.
 *
 * **This is the shape that froze EMBER for hours through `micro-ledger`**, and it is worse here for
 * one specific reason: ledger's victim was a fifteen-minute sweep, and tessera's and emberkin's
 * upstream calls sit on request paths that a bootstrap usually outruns. This service's custody calls
 * come from **leased background jobs** — `market.deploy` provisioning a deployer address and signing
 * a creation, `resolution.post` signing the resolver — driven by a queue that, once the defect above
 * it was fixed, runs every fifteen seconds for ever. A market approved eleven minutes after a
 * bootstrap would be refused by custody with a 401 on every single attempt.
 *
 * And the failure would be **unreadable**. `driveDeploy` maps a custody 401 to
 * `CustodySignRefusedError` or `CustodyUnavailableError` depending on the shape, and both of those
 * mean "custody said no" or "custody is down" to whoever reads the log. Neither says "this
 * container's own credential died nine minutes after it started", which is what happened. That
 * misattribution — sending an operator to the wrong service — is what `micro-ledger`'s `REMEDIES`
 * table was written to end, and it is the real cost of the defect.
 *
 * ## WHY THIS IS A MODULE AND NOT TWENTY LINES OF `index.ts`
 *
 * Because the defect is a **wiring** defect, and wiring that lives in the composition root is wiring
 * no test can reach: `index.ts` opens a pool, asserts a schema, starts a job runner and calls
 * `listen()`, so importing it from a test starts a server. `ledger/src/upstreams.ts` and
 * `wallet/src/upstreams.ts` learned this the same way. This service had 175 green tests over a
 * composition root that authenticated once and died — because every one of them builds its own
 * client, and a suite full of tests that build their own clients cannot see a composition root that
 * builds a different one.
 *
 * `servicetoken.test.ts` beside this file goes through `buildUpstreams`, and reverting the body
 * below to `() => env.serviceToken` turns it red.
 *
 * ## BOTH HOOKS, AND THE SECOND IS NOT DECORATION
 *
 * `token` keeps the credential fresh on a schedule computed from this process's clock. `fetch`
 * catches a 401 from a peer, re-mints and replays once. Without the second, correctness would rest
 * on this process and custody agreeing about what time it is — and on a fifteen-second job that is
 * one skewed clock away from being back where it started.
 *
 * ## THE READINESS PROBE: THE SAME ANSWER AS ledger, FOR A DIFFERENT REASON
 *
 * `ledger/src/upstreams.ts` argues a deliberate divergence from wallet — no hard readiness probe on
 * the credential — because every inbound route ledger serves needs no outbound call, and failing
 * `/readyz` over a variable that only affects a periodic sweep would pull a service that otherwise
 * serves fine.
 *
 * **Foresight's situation is the same in its conclusion and different in its shape, and the
 * difference is worth stating rather than inheriting.** Ledger's outbound need is confined to one
 * background job. This service has three distinct dependents on the credential:
 *
 *   1. **Background jobs** — deploy and resolution. Ledger's case exactly: a failure here is loud in
 *      the row and the metric, and pulling the replica would not fix it.
 *   2. **A write request path** — `POST /markets/:id/stake-intent` calls policy, which already
 *      **fails CLOSED at the point of use** (`policyclient.ts`: an unreachable policy is a `deny`).
 *      That is a stronger statement than a readiness probe: the stake is refused whether or not this
 *      replica is in rotation, and a probe would only decide which replica does the refusing.
 *   3. **Every public read** — `GET /v1/markets`, `/v1/categories`, the pool on a market page. These
 *      are the routes the gateway sends the public API to (`deploy/gateway/dynamic/public-api.yml`),
 *      and **they make no outbound call at all.** They are served out of this service's own tables.
 *
 * So a hard probe would take the public prediction-market pages out of the balancer over a variable
 * that cannot affect them, in exchange for nothing — the deploy would still not sign and the stake
 * would still be refused. That is the trade ledger declines, and this service has more to lose by
 * making it, not less. **Soft, therefore, and loud instead**: `index.ts` logs `fatal` at boot naming
 * what will break, and `foresight_service_token_usable` answers "can this process authenticate right
 * now" on every scrape — the question that had no answer anywhere while the token quietly died.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { ServiceTokenProvider, ServiceTokenUnavailableError, type ProviderEvent } from '@cloudsforge/auth'
import { httpAdminApiClient, type EngagementPolicyClient } from './adminapiclient.ts'
import { httpCustodyClient, type CustodyClient } from './custodyclient.ts'
import { httpIndexerClient, type IndexerClient } from './indexerclient.ts'
import { httpLedgerClient, type LedgerClient } from './ledgerclient.ts'
import { httpPolicyClient, type PolicyClient } from './policyclient.ts'
import { httpPricingClient, unconfiguredPricingClient, type PricingClient } from './pricingclient.ts'
// TYPE-ONLY, and that matters. `./env.ts` validates the process environment at import and calls
// `process.exit(1)` when it is incomplete, so a value import here would make this module — and
// therefore every test of the wiring in it — impossible to load without a full environment. That is
// the same "untestable therefore unchecked" property that let the cliff survive.
import type { Env } from './env.ts'

/** The subset of `Env` this needs. Named so a test does not have to build a whole environment. */
export type UpstreamEnv = Pick<
  Env,
  | 'identityUrl'
  | 'identityCredential'
  | 'serviceToken'
  | 'custodyUrl'
  | 'indexerUrl'
  | 'ledgerUrl'
  | 'pricingUrl'
  | 'policyUrl'
  | 'adminApiUrl'
  | 'upstreamDeadlineMs'
  | 'policyDeadlineMs'
  | 'policyAction'
>

export interface UpstreamOptions {
  /** Test seam. Production uses the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly onEvent?: ((event: ProviderEvent) => void) | undefined
  /** The service name stamped on ledger postings. `SERVICE`, passed in to keep `env.ts` out. */
  readonly originatingService: string
}

/**
 * How this process obtains a bearer, named rather than inferred from whether a string is set.
 *
 * `exchanged` is correct. `static` is the defect, still running because the deploy has not yet been
 * given the credential it already mints. `none` cannot authenticate at all. Three states, because
 * "the token is not working" and "there is no token" send an operator to different places — which
 * is the whole lesson of the freeze this fixes.
 */
export type CredentialMode = 'exchanged' | 'static' | 'none'

export interface Upstreams {
  readonly mode: CredentialMode
  /** `null` unless `mode` is `exchanged`. The thing `index.ts` samples for the readiness gauge. */
  readonly identityTokens: ServiceTokenProvider | null
  readonly custody: CustodyClient
  readonly indexer: IndexerClient
  readonly ledger: LedgerClient
  /**
   * The rate board. **Built with the plain `fetch`, not the authorised one**: `/rates/:asset` is
   * unauthenticated by design (`pricing/src/server.ts`), and presenting a service token to a
   * public endpoint would make this call fail whenever the credential was unavailable — coupling
   * a stake's price to an authentication path it does not need.
   */
  readonly pricing: PricingClient
  readonly policy: PolicyClient
  /** `null` when `ADMIN_API_URL` is unset, which is a supported mode — see `index.ts`. */
  readonly engagementPolicies: EngagementPolicyClient | null
}

export function buildUpstreams(env: UpstreamEnv, options: UpstreamOptions): Upstreams {
  const identityTokens = env.identityCredential
    ? new ServiceTokenProvider({
        identityUrl: env.identityUrl,
        credential: env.identityCredential,
        // Not narrowed. Identity issues the service's whole allowlist, which for `foresight` is
        // seven scopes across five peers (`admin:read`, `custody:address:create`,
        // `custody:sign:deployer`, `indexer:read`, `indexer:write`, `ledger:post`, `policy:decide`).
        // At boot this process cannot know which of its call sites will be reached first, and a
        // narrowing that drifted from the deploy's derived grant map would 403 with nothing in
        // either log naming the cause.
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      })
    : null

  const mode: CredentialMode = identityTokens ? 'exchanged' : env.serviceToken ? 'static' : 'none'

  /**
   * What every client asks for the `Authorization` header.
   *
   * **Rejects rather than resolving `undefined` when there is nothing to present.** `HttpClient`
   * omits the header entirely for `undefined`, so the request would go out unauthenticated, come
   * back 401, and be recorded as custody refusing this service's token — when the truth is that
   * nobody gave this service a credential. Those are different mornings, and keeping them different
   * is the point. `ServiceTokenUnavailableError` maps to 503, never 401, for the same reason
   * `Verifier` answers 503 on an unreachable JWKS: a fault in the thing that decides authentication
   * is not evidence that the caller is unauthenticated.
   */
  const token = (): Promise<string> => {
    if (identityTokens) return identityTokens.token()
    if (env.serviceToken) return Promise.resolve(env.serviceToken)
    return Promise.reject(
      new ServiceTokenUnavailableError(
        'no credential is configured; set FORESIGHT_IDENTITY_CREDENTIAL (long-lived, from POST /service-credentials)',
      ),
    )
  }

  // The provider's own `fetch` is the transport it exchanges over. `authorizedFetch` is what the
  // five clients get, and it is the layer where a 401 is visible and where the header was set.
  const fetch = identityTokens?.authorizedFetch ?? options.fetch
  const common = { token, ...(fetch ? { fetch } : {}) }

  return {
    mode,
    identityTokens,
    custody: httpCustodyClient({ baseUrl: env.custodyUrl, deadlineMs: env.upstreamDeadlineMs, ...common }),
    indexer: httpIndexerClient({ baseUrl: env.indexerUrl, deadlineMs: env.upstreamDeadlineMs, ...common }),
    ledger: httpLedgerClient({
      baseUrl: env.ledgerUrl,
      deadlineMs: env.upstreamDeadlineMs,
      originatingService: options.originatingService,
      ...common,
    }),
    // Unset is a supported mode and the refusing client is what makes it safe rather than merely
    // tolerated: it answers every rate read with the reason, so a non-EMBER stake is refused with a
    // sentence instead of priced at a default. See `env.ts` on `pricingUrl`.
    pricing: env.pricingUrl === undefined
      ? unconfiguredPricingClient()
      : httpPricingClient({
      baseUrl: env.pricingUrl,
      deadlineMs: env.upstreamDeadlineMs,
      // Deliberately NOT `...common` — no token. See the field's comment: the rate board is public,
      // and making a stake's price depend on a credential it does not need would refuse stakes
      // whenever identity was having a bad minute.
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    policy: httpPolicyClient({
      baseUrl: env.policyUrl,
      deadlineMs: env.policyDeadlineMs,
      action: env.policyAction,
      ...common,
    }),
    // Optional, and it stays optional: `admin:read` on the engagement caps is unreachable while
    // there is no house address. See `index.ts` for why the URL is set anyway.
    engagementPolicies: env.adminApiUrl
      ? httpAdminApiClient({ baseUrl: env.adminApiUrl, deadlineMs: env.upstreamDeadlineMs, ...common })
      : null,
  }
}
