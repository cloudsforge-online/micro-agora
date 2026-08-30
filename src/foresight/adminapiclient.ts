/**
 * micro-admin-api's engagement policy, as this service reads it at market approval.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THE SEED SIZES RIDE THE APPROVAL AND THE CAPS LIVE SOMEWHERE ELSE.**
 *
 * This service consumes operator configuration two ways today: environment variables (env.ts)
 * and its own operator routes. Neither can hold the engagement caps — docs/ecosystem/21 §4 puts
 * them in admin-api's `engagement_policies` because admin-api owns cross-service operator state,
 * and §8 is blunt that nothing may move before those caps exist. So the DECISION, recorded:
 *
 *   * The seed size rides `POST /markets/:id/approve`'s payload (`houseSeedPerOutcomeWei`) — the
 *     approving operator chooses it per market, inside the caps.
 *   * At approval time it is validated against admin-api's LIVE policy through this client —
 *     per-market size and the day's running total against the per-day size.
 *   * **FAIL CLOSED, like the stake-intent policy gate** (`policyclient.ts`): if admin-api
 *     cannot be reached, approval WITH a seed refuses and says retry; approval WITHOUT a seed is
 *     untouched, because an unreachable operator surface must not stop ordinary markets.
 *   * If `ADMIN_API_URL` is unset, seeding is refused outright — unconfigured is a supported
 *     mode (the notify-SMTP discipline), and its meaning here is "this deployment has no
 *     engagement programme", which is exactly true.
 *   * The HARD ceilings do not depend on any of this: they are CHECK/trigger facts in BOTH
 *     schemas (migration 8 here, migration 8 there, same numbers), so an unreachable admin-api
 *     can never be leveraged into an unbounded seed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Route, verified
 *
 * `GET /v1/engagement/policies` — `admin-api/src/server.ts`. Its guard is `requireReader`
 * (`admin-api/src/server.ts`): a SERVICE token must hold the exact scope `admin:read` —
 * admin-api matches scopes exactly, §3.3h, so `admin:*` will not do. The scope is registered in
 * `contracts/packages/auth` ('admin:read', citing the gate). The response carries `policies`
 * (per-service rows) and `ceilings`.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scope this service's token must hold to read the policy. Exact-matched by admin-api.
 *
 * `readonly LiveScope[]` rather than `readonly string[]`: see the header of `policyclient.ts`.
 * This is an outbound demand, `derive-grants.mjs` reads it into the estate's grant list, and
 * identity refuses to boot on a name the registry does not have — or has deprecated, which
 * `Scope` alone would not have caught.
 */
export const ADMIN_API_SCOPES: readonly LiveScope[] = Object.freeze(['admin:read'])

/** Foresight's seed caps as admin-api's policy states them, in wei per outcome side. */
export interface SeedPolicy {
  readonly perMarketWei: bigint
  readonly perDayWei: bigint
}

export class SeedPolicyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeedPolicyUnavailableError'
  }
}

export interface EngagementPolicyClient {
  /**
   * Foresight's seed policy, or null when no policy row carries seed sizes — which means no
   * operator has raised them, and 21 §8 reads that as "nothing may move".
   * Throws `SeedPolicyUnavailableError` when admin-api cannot be reached or cannot be parsed:
   * an unreadable policy is not a permissive one.
   */
  foresightSeedPolicy(correlationId: string): Promise<SeedPolicy | null>
}

export interface AdminApiClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

interface PoliciesBody {
  readonly policies?: ReadonlyArray<{
    readonly service?: unknown
    readonly seedPerMarketWei?: unknown
    readonly seedPerDayWei?: unknown
  }>
}

export function httpAdminApiClient(options: AdminApiClientOptions): EngagementPolicyClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'admin-api',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  return {
    async foresightSeedPolicy(correlationId) {
      let body: PoliciesBody
      try {
        body = await client.request<PoliciesBody>('/v1/engagement/policies', {
          method: 'GET',
          requestId: correlationId,
        })
      } catch (err) {
        // A 4xx here is admin-api refusing THIS SERVICE — a scope or deployment fault, not an
        // operator's answer about the caps. Either way no policy was read, and an unread policy
        // is a refusal to seed, never a default.
        const detail =
          err instanceof HttpError ? `admin-api answered ${err.status}` : 'admin-api could not be reached'
        throw new SeedPolicyUnavailableError(detail)
      }
      const row = (body.policies ?? []).find((p) => p.service === 'foresight')
      if (!row || typeof row.seedPerMarketWei !== 'string' || typeof row.seedPerDayWei !== 'string') {
        return null
      }
      if (!/^[0-9]{1,78}$/.test(row.seedPerMarketWei) || !/^[0-9]{1,78}$/.test(row.seedPerDayWei)) {
        // A policy this service cannot read exactly is a policy it must not enforce approximately.
        throw new SeedPolicyUnavailableError('admin-api answered a seed policy that is not decimal wei')
      }
      return { perMarketWei: BigInt(row.seedPerMarketWei), perDayWei: BigInt(row.seedPerDayWei) }
    },
  }
}
