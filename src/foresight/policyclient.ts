/**
 * The policy service, as this service uses it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **FAIL CLOSED. STAKING IS NOT LISTING.**
 *
 * `micro-market` fails OPEN on this gate and is right to: a policy outage that stopped every seller
 * listing would shut the marketplace by somebody else's incident, and an unmoderated listing can be
 * taken down afterwards. Neither half of that argument survives here.
 *
 * A stake is a transfer of EMBER into a contract with no undo. Once the wallet has broadcast it,
 * there is no take-down, no reversal and no moderation queue — the money is in the pool and the
 * pool pays out by arithmetic. So the shape of this gate is `wallet.withdrawal`'s, not
 * `market.listing.create`'s: if policy cannot be reached, this service refuses to hand out a stake
 * intent, and the person is told to try again shortly. The cost of that is a few minutes of
 * inconvenience; the cost of the other choice is a frozen account's owner staking their way past a
 * freeze while the service that would have stopped them is down.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## What "refuses" actually stops, stated honestly
 *
 * **It stops this service issuing the intent, not the chain accepting the stake.** Anybody holding
 * EMBER and the market's address can call `stake()` directly with a wallet, and nothing here — or
 * anywhere — can prevent that. That is a property of building on a public chain and it should be
 * said out loud rather than papered over: this gate governs the platform's own front door, which is
 * the route essentially every user takes, and it makes the freeze meaningful for them. A user
 * determined to route around their own freeze by hand-crafting a transaction was never going to be
 * stopped by an HTTP call.
 *
 * ## Routes, verified
 *
 * `POST /decisions` — `micro-policy/src/server.ts`. Note it is UNPREFIXED. Policy serves
 * `/decisions`, `/decisions/:id`, `/subjects/:subject/decisions`, `/rules`, `/freezes` and the
 * three health endpoints, and nothing under `/v1` at all.
 *
 * The scope is `policy:decide` (`policy/src/server.ts`), and a user token can never reach the
 * route — `requireScope` is false for anything that is not a service, deliberately, because
 * deciding on your own behalf is not a thing policy offers.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry to call this peer.
 *
 * ── THIS IS AN OUTBOUND DEMAND, AND THAT DIRECTION WAS UNCHECKED ─────────────────────────────
 *
 * `readonly LiveScope[]`, not `readonly string[]`. `micro-org`'s `service-ci.yml` proves that
 * every scope a repository's route GATES demand is registered — the INBOUND direction. This
 * constant is the other one: what this service PRESENTS to a peer. Nothing had ever checked it,
 * which is how `micro-market` came to declare `policy:evaluate` and `micro-wallet`
 * `custody:address` — neither of which has ever been a registry key — for the life of both
 * services.
 *
 * The consequence is not a 403 on one call. `micro-deploy`'s `derive-grants.mjs` reads this
 * constant into `IDENTITY_SERVICE_TOKEN_GRANTS`, and identity validates that list against the
 * registry at import and REFUSES TO START on a name it does not know
 * (`identity/src/env.ts`). An unregistered demand here is a dead identity container, and
 * therefore no tokens for anybody.
 *
 * ── AND `LiveScope` RATHER THAN `Scope` ───────────────────────────────────────────────────────
 *
 * `Scope` is `keyof typeof SCOPES` — every registered key, DEPRECATED ones included. It would
 * catch `policy:evaluate`, which is not a key, and wave through `wallet:provision`, which is.
 * Identity will not mint a deprecated scope either, so that is the same failure by a quieter
 * route: satisfies the compiler, dies at runtime.
 *
 * `LiveScope = Exclude<Scope, DeprecatedScope>`, and `DeprecatedScope` is computed FROM `SCOPES`
 * by a conditional type over the `deprecated` field rather than hand-listed
 * (`contracts/packages/auth/src/index.ts`), so it cannot drift from the registry — a
 * hand-written companion list is the failure that package keeps catching.
 *
 * `Scope` deliberately keeps its wide meaning and this does not narrow it: a token arriving from
 * anywhere may carry a scope that has since died, so reading is wide and demanding is narrow.
 * This is the demanding direction.
 */
export const POLICY_SCOPES: readonly LiveScope[] = Object.freeze(['policy:decide'])

export type PolicyDecision = 'allow' | 'review' | 'deny'

export interface PolicyVerdict {
  readonly decision: PolicyDecision
  readonly reasons: readonly string[]
  /** True when policy could not be reached. Always accompanied by `decision: 'deny'` here. */
  readonly degraded: boolean
  /** Policy's own decision id, so a refused user can be told what to quote to support. */
  readonly decisionId: string | null
}

export interface StakePolicyInput {
  /** `user:<id>` — policy's own subject spelling (`policy/src/server.ts`). */
  readonly subject: string
  readonly marketId: string
  /** The intended stake, as a decimal string in whole EMBER. Never a number: see below. */
  readonly amount: string
  readonly correlationId: string
}

export interface PolicyClient {
  evaluateStake(input: StakePolicyInput): Promise<PolicyVerdict>
}

export interface PolicyClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  /**
   * The registered action name to decide under.
   *
   * Policy's registry is CLOSED — an unregistered action is a 400, never a guess
   * (`policy/src/actions.ts`). There is no `foresight.stake` in it today and this task may
   * not modify that repository, so the deployment names an action that IS registered. See
   * `env.ts`'s `policyAction` for the default and why it was chosen.
   */
  readonly action: string
  readonly fetch?: typeof globalThis.fetch
}

/**
 * The verdict an unreachable policy service produces. Exported so a test can assert on it.
 *
 * `deny`, not `review`. See the header.
 */
export const UNAVAILABLE_VERDICT: PolicyVerdict = Object.freeze({
  decision: 'deny' as const,
  reasons: Object.freeze(['policy_unavailable']),
  degraded: true,
  decisionId: null,
})

interface DecisionBody {
  readonly decision?: {
    readonly id?: unknown
    readonly decision?: unknown
    readonly reasons?: unknown
  }
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
    async evaluateStake(input) {
      try {
        const body = await client.request<DecisionBody>('/decisions', {
          method: 'POST',
          body: {
            subject: input.subject,
            action: options.action,
            // A URN rather than a bare id, so a decision row read months later says what it was
            // about without a lookup table. Policy stores this verbatim.
            resource: `urn:cloudsforge:foresight:market:${input.marketId}`,
            context: {
              // A DECIMAL STRING, and policy refuses anything else — it rejects a JSON number
              // outright rather than coercing, because a threshold comparison on a float is the
              // bug that service exists to not have (`policy/src/server.ts`).
              amount: input.amount,
              asset: 'EMBER',
            },
            correlationId: input.correlationId,
          },
          requestId: input.correlationId,
        })
        const decision = body.decision
        const verdict = typeof decision?.decision === 'string' ? decision.decision : null
        if (verdict !== 'allow' && verdict !== 'review' && verdict !== 'deny') {
          // A 201 whose body we cannot read is not an allow. Treating an unparseable success as
          // permission is how a gate becomes decorative after a peer's response shape changes.
          return UNAVAILABLE_VERDICT
        }
        return {
          decision: verdict,
          reasons: Array.isArray(decision?.reasons) ? (decision.reasons as string[]) : [],
          degraded: false,
          decisionId: typeof decision?.id === 'string' ? decision.id : null,
        }
      } catch (err) {
        // A 4xx is policy DECIDING, not policy failing, and it is a deny either way here — but the
        // two are reported differently so a spike in `degraded` is visible as an outage rather
        // than as a wave of refusals.
        if (err instanceof HttpError && err.peerDecided && err.status !== 429) {
          return {
            decision: 'deny',
            reasons: ['policy_rejected_the_request'],
            degraded: false,
            decisionId: null,
          }
        }
        return UNAVAILABLE_VERDICT
      }
    },
  }
}
