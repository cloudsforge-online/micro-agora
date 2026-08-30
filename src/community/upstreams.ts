/**
 * The three peers this service calls, and the credential it presents to all of them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THE TREASURY SPEND THAT WAS REFUSED BY A GATE NOBODY ASKED
 *
 * `COMMUNITY_SERVICE_CREDENTIAL` held a **token**, and a token identity mints lives **600 seconds**
 * (`identity/src/tokens.ts`). The composition root read it once, at import:
 *
 *     const token = () => env.serviceCredential     // index.ts, for the life of the process
 *
 * and handed that one function to the ledger, to policy and to the indexer oracle
 *. There was no `ServiceTokenProvider`, no `POST /service-tokens/exchange` and no `cfsc_`
 * anywhere in `src/` — checked by grep, not inferred. So every outbound call this service makes
 * authenticated **once per bootstrap** and never again, while the container ran for days.
 *
 * **Measured on the live estate rather than reasoned about.** `COMMUNITY_SERVICE_CREDENTIAL` on the
 * running estate held a JWT that had been expired for **26 hours** (2026-08-05) on a container
 * reporting healthy — `/livez` needs no upstream, so it never exercises the credential and the
 * probe cannot fail for this reason. This is the ten-minute cliff (micro-org #197), and #222 is
 * this service's instance of it.
 *
 * ## WHY THE SYMPTOM IS WORSE HERE THAN ANYWHERE ELSE IT HAS BEEN FIXED
 *
 * In market, a dead credential left the moderation gate *absent* and every listing went up
 * unjudged. Here the failure has a direction, and it points at the member:
 *
 *   1. Policy answers **401**. That is a 4xx, so `HttpError.peerDecided` is true.
 *   2. `policyclient.ts` reads a decided 4xx as **policy deciding** and returns
 *      `{decision: 'deny', reasons: ['policy_401']}` — correctly, given what it can see; a 401 is
 *      indistinguishable at that layer from policy refusing the request as malformed.
 *   3. `executions.ts` turns any non-`allow` into `SpendRefusedError`.
 *   4. `jobs.ts` **swallows** a refusal — deliberately, because "a refusal is an answer, and
 *      retrying it until the job dead-letters would turn one decision into eight".
 *
 * So the job completes, `community_executions_total{outcome="refused"}` climbs, and the log line
 * reads `treasury spend refused by policy`. **A community that voted, waited out its timelock and
 * passed a spend is told the platform refused it — by a gate that was never asked.** Nothing
 * anywhere names this container's own credential as the cause. There is no fail-open here to make
 * it silent and no `degraded` flag to make it visible: it is silent AND it is a denial.
 *
 * The ledger is the same shape: a 401 is `peerDecided`, so `ledgerclient.ts` raises
 * `LedgerRefusedError`, which is the "permanent, never retry with this request" class. And the
 * indexer oracle answers `unknown` for every failure, so token gating stops running altogether
 * while `community_gate_checks_total{outcome="unknown"}` is the only trace.
 *
 * ## WHY THIS IS A MODULE AND NOT TWENTY LINES OF `index.ts`
 *
 * Because the defect is a **wiring** defect, and wiring that lives in the composition root is wiring
 * no test can reach: `index.ts` opens a pool, asserts a schema, seeds a job queue and calls
 * `listen()`, so importing it from a test starts a server. This repository had a full green suite
 * over a composition root that authenticated once and died — because every test builds its own
 * client, and a suite full of tests that build their own clients cannot see a composition root that
 * builds a different one. `market/src/upstreams.ts`, `ledger/src/upstreams.ts` and
 * `foresight/src/upstreams.ts` each learned this the same way.
 *
 * `servicetoken.test.ts` beside this file goes through `buildUpstreams`, and reverting the body
 * below to `() => env.serviceCredential` turns it red.
 *
 * ## BOTH HOOKS, AND THE SECOND IS NOT DECORATION
 *
 * `token` keeps the bearer fresh on a schedule computed from `expiresIn` and THIS process's clock.
 * `fetch` catches a 401 from a peer, re-mints and replays once. Without the second, correctness
 * would rest on this process and policy agreeing about what time it is — and on no credential ever
 * being revoked mid-flight. `POST /decisions` carries no idempotency key, so `HttpClient` attempts
 * it exactly once and would not retry its way out of a skew.
 *
 * ## ONE PROVIDER, THREE PEERS
 *
 * A single service identity for a single service, which is what SD-05's scoped service tokens are.
 * The provider asks for the service's whole allowlist rather than narrowing per peer: at boot this
 * process cannot know whether the next outbound call is a ledger posting, a policy decision or a
 * holdings read, and a narrowing that drifted from the deploy's derived grant map would 403 with
 * nothing in either log naming the cause. The scopes themselves stay declared where they are
 * demanded — `LEDGER_SCOPES`, `POLICY_SCOPES`, `INDEXER_SCOPES` — because `derive-grants.mjs` reads
 * those constants, and identity refuses to boot on a name its registry does not have.
 *
 * ## NO INDEXER IS STILL A SUPPORTED MODE
 *
 * `indexerBaseUrl === null` yields `unavailableOracle()` exactly as before, and that is unchanged by
 * this fix on purpose: an oracle that knows nothing answers `unknown`, and **an unknown holding
 * never demotes a member**. An oracle that returned zero would evict every token-gated member on
 * the first pass. See `gating.ts`.
 *
 * ## THE READINESS PROBE: DELIBERATELY NOT ONE, AND LOUD INSTEAD
 *
 * `serviceTokenProbe` exists in `@cloudsforge/auth` and is deliberately not wired here. `index.ts`'s
 * own header already settles the hard/soft question for this service — **Postgres is the only hard
 * probe, because it is the only dependency whose absence makes every route wrong rather than one
 * path slow** — and a credential probe would contradict it on all three counts:
 *
 *   1. **Almost nothing this service does is an outbound call.** Voting, delegating, discussion,
 *      membership, tallies and every read are served from this database. A hard probe on the
 *      credential would take governance out of the balancer over a variable those routes never
 *      touch.
 *   2. **The one path that needs it already fails safely.** The execute job is fail-closed: an
 *      unreachable gate leaves the proposal `timelocked` and retried, and
 *      `community_proposals_timelocked` is the number that alerts.
 *   3. **Pulling the replica would fix nothing.** Every replica reads the same environment, so a
 *      probe would only decide which container refuses, not whether one does.
 *
 * So: a GAUGE, not a probe. `index.ts` samples `community_service_token_usable` at scrape time and
 * logs `fatal` at boot naming what will break — which together answer the question that had no
 * answer anywhere while the token sat dead for 26 hours: can this process authenticate right now,
 * and is it even able to renew?
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { ServiceTokenProvider, ServiceTokenUnavailableError, type ProviderEvent } from '@cloudsforge/auth'
import { httpLedgerClient, type LedgerClient } from './ledgerclient.ts'
import { httpPolicyClient, type PolicyClient } from './policyclient.ts'
import { indexerOracle, unavailableOracle, type HoldingsOracle } from './gating.ts'
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
  | 'serviceCredential'
  | 'ledgerBaseUrl'
  | 'ledgerDeadlineMs'
  | 'policyBaseUrl'
  | 'policyDeadlineMs'
  | 'indexerBaseUrl'
  | 'indexerNetwork'
  | 'indexerDeadlineMs'
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
 * `exchanged` is correct. `static` is the defect, still running wherever a deployment has not yet
 * been given the credential its bootstrap already mints. `none` cannot authenticate at all. Three
 * states, because "the token is not working" and "there is no token" send an operator to different
 * places — which is the whole lesson of the 26 silent hours this fixes.
 */
export type CredentialMode = 'exchanged' | 'static' | 'none'

export interface Upstreams {
  readonly mode: CredentialMode
  /** `null` unless `mode` is `exchanged`. The thing `index.ts` samples for the gauge. */
  readonly identityTokens: ServiceTokenProvider | null
  readonly ledger: LedgerClient
  readonly policy: PolicyClient
  /** `unavailableOracle()` when no indexer is configured — a supported mode, unchanged by #222. */
  readonly oracle: HoldingsOracle
}

export function buildUpstreams(env: UpstreamEnv, options: UpstreamOptions): Upstreams {
  const identityTokens = env.identityCredential
    ? new ServiceTokenProvider({
        identityUrl: env.identityUrl,
        credential: env.identityCredential,
        // Not narrowed — see the header: at boot this process cannot know which of its call sites
        // is reached first, and a narrowing that drifted from the derived grant map would 403.
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      })
    : null

  const mode: CredentialMode = identityTokens ? 'exchanged' : env.serviceCredential ? 'static' : 'none'

  /**
   * What every client asks for the `Authorization` header.
   *
   * **Rejects rather than resolving `undefined` when there is nothing to present.** `HttpClient`
   * omits the header entirely for `undefined`, so the request would go out unauthenticated, come
   * back 401 — and `policyclient.ts` would read that 401 as policy DECIDING and record a
   * `deny` against a community whose vote was never actually put to the gate. Policy is not down and
   * the spend was not refused; nobody gave this service a credential. Those are three different
   * mornings, and keeping them apart is the point.
   *
   * Rejecting keeps the failure on the right side of that line. `ServiceTokenUnavailableError` is
   * not an `HttpError`, so `policyclient.ts` cannot read it as a decision: it becomes
   * `PolicyUnavailableError`, `jobs.ts` RE-THROWS that, the job is retried with backoff and the
   * treasury is not touched while we cannot ask. Resolving `undefined` instead would convert the
   * same fault into a permanent, swallowed refusal. It is the same reasoning as `Verifier` answering
   * 503 on an unreachable JWKS: a fault in the thing that decides authentication is not evidence
   * that the caller is unauthenticated. `servicetoken.test.ts` asserts both halves — the class, and
   * that nothing was sent.
   */
  const token = (): Promise<string> => {
    if (identityTokens) return identityTokens.token()
    if (env.serviceCredential) return Promise.resolve(env.serviceCredential)
    return Promise.reject(
      new ServiceTokenUnavailableError(
        'no credential is configured; set COMMUNITY_IDENTITY_CREDENTIAL (long-lived, cfsc_…, from POST /service-credentials)',
      ),
    )
  }

  // The provider's own `fetch` is the transport it exchanges over. `authorizedFetch` is what the
  // three clients get, and it is the layer where a 401 is visible and where the header was set.
  const fetch = identityTokens?.authorizedFetch ?? options.fetch

  return {
    mode,
    identityTokens,
    ledger: httpLedgerClient({
      baseUrl: env.ledgerBaseUrl,
      token,
      deadlineMs: env.ledgerDeadlineMs,
      originatingService: options.originatingService,
      ...(fetch ? { fetch } : {}),
    }),
    policy: httpPolicyClient({
      baseUrl: env.policyBaseUrl,
      token,
      deadlineMs: env.policyDeadlineMs,
      ...(fetch ? { fetch } : {}),
    }),
    // No indexer URL is a SUPPORTED mode, and the oracle that results knows nothing rather than
    // reporting zero. A zero would demote every token-gated member on the first pass. See gating.ts.
    oracle:
      env.indexerBaseUrl === null
        ? unavailableOracle()
        : indexerOracle({
            baseUrl: env.indexerBaseUrl,
            token,
            deadlineMs: env.indexerDeadlineMs,
            network: env.indexerNetwork,
            ...(fetch ? { fetch } : {}),
          }),
  }
}
