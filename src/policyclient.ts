/**
 * The policy service, as the square uses it.
 *
 * Policy is this service's only upstream, and it is **soft** — fail open, and leave evidence.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A POLICY OUTAGE MUST NOT SILENCE THE SQUARE.**
 *
 * Failing CLOSED here would mean that while policy is down nobody can post at all. To the person
 * holding the phone that is indistinguishable from being banned, and they will conclude they were
 * — quietly, without an appeal, for something they cannot name. That is a far worse outcome than a
 * few hours of unscreened posts.
 *
 * Failing open SILENTLY is worse than either, and for the reason market's client already records:
 * during an outage the gate is not degraded, it is ABSENT, and nothing anywhere records which
 * posts went up unchecked. Somebody who can make policy unreachable gets an unmoderated square and
 * no trace of the window.
 *
 * So an unreachable policy service produces `review` with `degraded: true`, the post is published,
 * and `posts.ts` opens a report against it automatically with reporter `system`. The post goes up,
 * and a human is told. That is what "soft" has to mean to be worth writing down.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## And why `POLICY_URL` is allowed to be empty
 *
 * Unset means "there is no policy service here", which is the state a local checkout and the first
 * boot of a new environment are both in. `nullPolicyClient` answers `allow` with `degraded: false`
 * in that case — not `review`, because a review queue that fills with every post in development is
 * a queue nobody reads by the time it matters. Production sets the variable; `index.ts` logs at
 * warn level when it does not, so the absent gate is visible in the boot line rather than being
 * something you find out about later.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry to call policy.
 *
 * `readonly LiveScope[]`, not `readonly string[]`, and that annotation is the entire safety net:
 * a scope the registry does not have is a compile error HERE, at the moment it is written.
 * Nothing downstream checks — `service-ci.yml`'s scope audit reads a repository's INBOUND route
 * gates, and this is an outbound demand — and the failure mode of getting it wrong is not a 403.
 * identity validates `IDENTITY_SERVICE_TOKEN_GRANTS` against the registry at import and refuses to
 * start on an unknown name, so a deploy that took a misspelling at face value would kill the
 * IDENTITY container: not agora degraded, the estate's token minting gone.
 *
 * `LiveScope` rather than `Scope` because `Scope` is every registered key including deprecated
 * ones, and a deprecated scope is one identity refuses to mint — the same dead container by a
 * different route. Market's client carries the long version of this argument.
 */
export const POLICY_SCOPES: readonly LiveScope[] = Object.freeze(['policy:decide'])

export type PolicyDecision = 'allow' | 'review' | 'deny'

export interface PolicyVerdict {
  readonly decision: PolicyDecision
  readonly reasons: readonly string[]
  /** True when policy could not be reached and this verdict is the fail-open default. */
  readonly degraded: boolean
}

export interface PostPolicyInput {
  readonly authorSubject: string
  readonly postUrn: string
  readonly kind: 'post' | 'reply' | 'quote'
  readonly visibility: string
  readonly bodyLength: number
  readonly mediaCount: number
  readonly tags: readonly string[]
  /** Whether the author's voice was created within the last day. New accounts get more scrutiny. */
  readonly newAccount: boolean
}

export interface PolicyClient {
  evaluatePost(input: PostPolicyInput): Promise<PolicyVerdict>
}

export interface PolicyClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

/** The verdict an unreachable policy service produces. Exported so a test can assert on it. */
export const DEGRADED_VERDICT: PolicyVerdict = Object.freeze({
  decision: 'review' as const,
  reasons: Object.freeze(['policy_unavailable']),
  degraded: true,
})

/** The verdict when no policy service is configured at all. See the file header. */
export const UNCONFIGURED_VERDICT: PolicyVerdict = Object.freeze({
  decision: 'allow' as const,
  reasons: Object.freeze(['policy_not_configured']),
  degraded: false,
})

export function nullPolicyClient(): PolicyClient {
  return { async evaluatePost() { return UNCONFIGURED_VERDICT } }
}

export function httpPolicyClient(options: PolicyClientOptions): PolicyClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'policy',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async evaluatePost(input) {
      try {
        // `POST /decisions`. Policy has NO `/v1` routes at all and takes the action in the body
        // rather than the path — market's client was written against `/v1/decisions/...` and every
        // call it made 404'd into the fail-open branch for the life of that service. Written the
        // right way round here from the first line, and `policyclient.test.ts` pins the path.
        //
        // The action is `agora.post.create`, spelled as policy's CLOSED registry spells it. It had
        // to be appended to `policy/src/actions.ts` before this line could work: an unregistered
        // action is a deliberate 400 there, not a default-allow.
        const body = await client.request<{
          decision?: { decision?: string; reasons?: readonly string[] }
        }>('/decisions', {
          method: 'POST',
          body: {
            subject: input.authorSubject,
            action: 'agora.post.create',
            // A URN rather than a bare id, so a decision row read months later says what it was
            // about without a lookup table.
            resource: input.postUrn,
            context: {
              kind: input.kind,
              visibility: input.visibility,
              // Integers, not strings: unlike market's amount there is no decimal here, and policy
              // only refuses a JSON number where a float comparison would be the bug.
              bodyLength: input.bodyLength,
              mediaCount: input.mediaCount,
              tags: [...input.tags],
              newAccount: input.newAccount,
            },
          },
        })

        // Policy answers 201 with `{decision: {...}}`. A success whose body cannot be read is not
        // an allow: treating an unparseable 201 as permission would make a response-shape change
        // silently open the gate.
        const verdict = body.decision?.decision
        if (verdict !== 'allow' && verdict !== 'review' && verdict !== 'deny') {
          return DEGRADED_VERDICT
        }
        return { decision: verdict, reasons: [...(body.decision?.reasons ?? [])], degraded: false }
      } catch (err) {
        // A 4xx is generally policy DECIDING, and a decision is never overridden by a fail-open
        // default — that would turn "deny" into "allow" for anyone who could provoke a 400.
        //
        // 401, 403, 404 and 405 are the exceptions, and they are exceptions because none of them
        // is a sentence about this POST. A 401 says this caller is not authenticated; a 403 says
        // this caller may not ask; 404 and 405 say the route is not there. Reading any of them as
        // `deny` makes our own misconfiguration indistinguishable from a moderator's judgement —
        // which is exactly how the marketplace was found shut twice, once by a wrong path and once
        // by a placeholder token. On a square the same mistake reads as a shadowban of everybody.
        //
        // 400 deliberately still denies: a malformed request is one a caller can provoke, so
        // failing open on it would hand an override to anyone who could send bad JSON.
        if (
          err instanceof HttpError
          && (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 405)
        ) {
          return DEGRADED_VERDICT
        }
        if (err instanceof HttpError && err.peerDecided && err.status !== 429) {
          return { decision: 'deny', reasons: ['policy_rejected_the_request'], degraded: false }
        }
        return DEGRADED_VERDICT
      }
    },
  }
}
