/**
 * The one peer this service calls, and the credential it presents.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THERE IS NO `AGORA_SERVICE_TOKEN`, AND THAT ABSENCE IS THE DESIGN
 *
 * Market shipped with `MARKET_SERVICE_TOKEN`: a bearer read ONCE at import and handed to every
 * client for the life of the process. Identity's service tokens live 600 seconds. The container
 * ran for days. Measured on the live estate, the token inside `cloudsforge-estate-market-1` had
 * been expired for **63,056 seconds** — seventeen and a half hours — and every policy call in that
 * window returned 401, was read as "policy unavailable", and published unmoderated with a flag
 * nobody could act on because it fired on every single listing.
 *
 * This service is new, so it never has to carry that variable's compatibility. It exchanges a
 * long-lived `cfsc_` credential for short-lived bearers through `ServiceTokenProvider`, or it has
 * no credential at all. Two modes, not three, and `mode: 'static'` is not representable.
 *
 * ## BOTH PROVIDER HOOKS, AND THE SECOND IS NOT DECORATION
 *
 * `token()` keeps the credential fresh on a schedule computed from this process's clock.
 * `authorizedFetch` catches a 401 from the peer, re-mints and replays once. Without the second,
 * correctness would rest on this process and identity agreeing about what time it is.
 *
 * ## THE READINESS PROBE IS SOFT, DELIBERATELY, AND LOUD INSTEAD
 *
 * `serviceTokenProbe` exists in `@cloudsforge/auth` and is deliberately not wired here:
 *
 *   1. **Every read on the square is served from this service's own tables.** A timeline, a post,
 *      a profile, a tag page — none of them makes an outbound call. A hard probe on the credential
 *      would take the whole square out of the balancer over a variable those routes cannot touch.
 *   2. **The one path that needs it already fails safely.** Policy fails open and opens a report
 *      (`policyclient.ts`), so a dead credential degrades moderation rather than posting.
 *   3. **Pulling the replica would fix nothing.** Every replica reads the same environment.
 *
 * So: soft, and loud instead. `index.ts` logs at boot naming what will break, and
 * `agora_service_token_usable` answers "can this process authenticate right now" on every scrape —
 * the question that had no answer anywhere while market's token quietly died.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  ServiceTokenProvider,
  ServiceTokenUnavailableError,
  type ProviderEvent,
} from '@cloudsforge/auth'
import { httpPolicyClient, nullPolicyClient, type PolicyClient } from './policyclient.ts'
// TYPE-ONLY, and that matters. `./env.ts` validates the process environment at import and calls
// `process.exit(1)` when it is incomplete, so a value import here would make this module — and
// therefore every test of the wiring in it — impossible to load without a full environment. That
// is the same "untestable therefore unchecked" property that let market's cliff survive.
import type { Env } from './env.ts'

/** The subset of `Env` this needs. Named so a test does not have to build a whole environment. */
export type UpstreamEnv = Pick<
  Env,
  'identityUrl' | 'identityCredential' | 'policyUrl' | 'upstreamDeadlineMs'
>

export interface UpstreamOptions {
  /** Test seam. Production uses the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly onEvent?: ((event: ProviderEvent) => void) | undefined
}

/**
 * How this process obtains a bearer.
 *
 * Two states. `exchanged` is correct; `none` cannot authenticate at all and means the square runs
 * with its moderation gate absent. Naming it rather than inferring it from whether a string is set
 * is what lets `index.ts` say so at boot instead of leaving it to be discovered.
 */
export type CredentialMode = 'exchanged' | 'none'

export interface Upstreams {
  readonly mode: CredentialMode
  /** `null` unless `mode` is `exchanged`. What `index.ts` samples for the readiness gauge. */
  readonly identityTokens: ServiceTokenProvider | null
  readonly policy: PolicyClient
  /** False when `POLICY_URL` is unset — the gate is absent, not degraded. */
  readonly policyConfigured: boolean
}

export function buildUpstreams(env: UpstreamEnv, options: UpstreamOptions = {}): Upstreams {
  const identityTokens = env.identityCredential
    ? new ServiceTokenProvider({
        identityUrl: env.identityUrl,
        credential: env.identityCredential,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      })
    : null

  const mode: CredentialMode = identityTokens ? 'exchanged' : 'none'

  /**
   * What the policy client asks for the `Authorization` header.
   *
   * **Rejects rather than resolving `undefined` when there is nothing to present.** `HttpClient`
   * omits the header entirely for `undefined`, so the request would go out unauthenticated, come
   * back 401, and — through `policyclient.ts`'s deliberate 401 branch — be recorded as a degraded
   * policy call, indistinguishable from policy being down. It is not down; nobody gave this
   * service a credential. Those are different mornings, and keeping them different is the point.
   * `ServiceTokenUnavailableError` maps to 503, never 401, for the same reason `Verifier` answers
   * 503 on an unreachable JWKS: a fault in the thing that decides authentication is not evidence
   * that the caller is unauthenticated.
   */
  const token = (): Promise<string> => {
    if (identityTokens) return identityTokens.token()
    return Promise.reject(
      new ServiceTokenUnavailableError(
        'no credential is configured; set AGORA_IDENTITY_CREDENTIAL (long-lived, from POST /service-credentials)',
      ),
    )
  }

  // The provider's own `fetch` is the transport it exchanges over. `authorizedFetch` is what the
  // client gets, and it is the layer where a 401 is visible and where the header was set.
  const fetch = identityTokens?.authorizedFetch ?? options.fetch

  const policyConfigured = Boolean(env.policyUrl)
  const policy = policyConfigured
    ? httpPolicyClient({
        baseUrl: env.policyUrl,
        token,
        deadlineMs: env.upstreamDeadlineMs,
        ...(fetch ? { fetch } : {}),
      })
    : nullPolicyClient()

  return { mode, identityTokens, policy, policyConfigured }
}
