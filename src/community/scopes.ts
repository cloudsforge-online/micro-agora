/**
 * Scopes, and the estate's two scope matchers.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS REPOSITORY USES THE EXACT MATCHER. `community:*` GRANTS NOTHING HERE.**
 *
 * 18-build-status.md §3.3h records a divergence that is a decision rather than a defect:
 *
 *   | Package                    | Line               | Semantics                                |
 *   | `contracts/packages/auth`  | `src/index.ts` | `granted.includes(required)` — exact only |
 *   | `runtime/packages/auth`    | `src/index.ts` | honours one wildcard level: `foo:*` → `foo:bar` |
 *
 * Both are shipped, both are CI-green, and §3.3h leaves both as they are deliberately — changing
 * an authorisation matcher is the highest-blast-radius edit available in this estate. **Neither
 * package is changed by this repository.**
 *
 * The choice made here is the **exact** one, matching `micro-devplatform` and `micro-admin-api`,
 * and the reason is specific to what this service does rather than a preference for strictness:
 *
 *   **A passed proposal spends money.** `POST /internal/proposals/:id/execute` and the internal
 *   routes beside it are the machine surface of a treasury. A service token carrying
 *   `community:*` — which is what a broadly-scoped integration token looks like, and what a
 *   compromised one looks like — must not be the credential that executes a spend. The estate has
 *   not decided what a wildcard means; a service that moves money is not the place for it to find
 *   out.
 *
 * So this file's `grantsScope` is `granted.includes(required)`, `hasScope` from
 * `@cloudsforge/auth` is deliberately NOT used on any route that writes, and `scopes.test.ts`
 * proves `community:*` is refused — in both directions, so that the day somebody swaps the
 * matcher the test fails rather than the treasury opening.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Principal } from '@cloudsforge/auth'

/** Every scope this service issues meaning for. Frozen; the only place one is spelled. */
export const SCOPES = Object.freeze({
  'community:read': 'Read communities, members, proposals, votes and tallies.',
  'community:write': 'Create and manage communities, membership, proposals and votes.',
  /**
   * Execute a passed, timelocked proposal. Separate from `community:write` on purpose: writing a
   * proposal is a member's ordinary act, and executing one moves money. A credential that can do
   * the first should not automatically do the second.
   */
  'community:execute': 'Execute a passed proposal whose timelock has expired.',
} as const)

export type Scope = keyof typeof SCOPES

export const SCOPE_NAMES: readonly Scope[] = Object.freeze(Object.keys(SCOPES) as Scope[])

export const COMMUNITY_READ_SCOPE: Scope = 'community:read'
export const COMMUNITY_WRITE_SCOPE: Scope = 'community:write'
export const COMMUNITY_EXECUTE_SCOPE: Scope = 'community:execute'

export class UnknownScopeError extends Error {
  constructor(name: string) {
    super(`${name} is not a scope this service issues`)
    this.name = 'UnknownScopeError'
  }
}

export function isScope(value: string): value is Scope {
  return Object.prototype.hasOwnProperty.call(SCOPES, value)
}

/**
 * Does this grant satisfy this requirement?
 *
 * **Exact match, and nothing else.** No wildcard, no prefix, no hierarchy. See the file header
 * for the decision and for why neither shipped matcher was changed to reach it.
 */
export function grantsScope(granted: readonly string[], required: Scope): boolean {
  return granted.includes(required)
}

/**
 * The same question about a verified principal.
 *
 * Deliberately not `hasScope` from `@cloudsforge/auth`, which honours one wildcard level
 * (`runtime/packages/auth/src/index.ts`). A test asserts the difference is real rather than
 * theoretical, so this comment cannot rot into a claim nobody checks.
 */
export function principalGrants(principal: Principal, required: Scope): boolean {
  return principal.kind === 'service' && grantsScope(principal.scopes, required)
}
