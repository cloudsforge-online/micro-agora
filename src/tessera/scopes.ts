/**
 * The three scopes this service gates on, and the one place each is spelled.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THESE ARE STRING LITERALS AND THEY MUST STAY LITERALS.**
 *
 * The obvious tidy-up is `scopeFor(SERVICE, 'read')`. micro-aetherholm started there and had to
 * undo it: the estate's scope audit rejects a computed demand — "'TESSERA_PROVISION_SCOPE' resolves to no
 * string constant in this repository — fail, do not guess" (`aetherholm/src/server.ts`). It is
 * right to. That audit proves every scope a gate demands exists in `contracts-auth`, so identity
 * can actually mint it — identity fail-fasts at import on a grant naming an unknown scope
 * (`identity/src/env.ts`), which means a scope missing from the registry is a
 * service-to-service surface no identity-issued token can ever reach, while every suite stays
 * green off its own fake principals.
 *
 * The derivation reads inline literals, sibling constants, wrapper arguments and computed families
 * closed over an enumerated set (`org/.github/workflows/service-ci.yml`), and treats
 * anything it cannot resolve as FATAL. Making it blind here to make the code prettier would trade
 * a real guarantee for a cosmetic one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `service:noun`, first segment equal to the service — `contracts/packages/auth/src/index.ts`.
 */

/** Read the world: wards, parcels, objects, placements, rankings, the title descriptor. */
export const TESSERA_READ_SCOPE = 'tessera:read'

/** Act on a named user's world: claim, place, fire, list, book. Paired with an `x-user-id` header. */
export const TESSERA_WRITE_SCOPE = 'tessera:write'

/**
 * Provision a Private Ward for a worlds entitlement. Held by `micro-worlds` alone.
 *
 * Aetherholm's precedent (`aetherholm/src/server.ts`, registered as `aetherholm:provision`),
 * and separate from `tessera:write` for the reason custody separates its signing scopes by
 * purpose: provisioning is the platform's act, driven by a paid entitlement, and a credential that
 * can place a chair should not automatically be able to raise a ward.
 */
export const TESSERA_PROVISION_SCOPE = 'tessera:provision'

/**
 * Every scope this service demands. `scopes.test.ts` asserts this equals what `contracts-auth`
 * registers for `tessera`, in BOTH directions — a scope here that is unregistered fails identity's
 * boot, and a scope registered that no gate here demands is a credential that opens nothing, which
 * `org/tools/estate-scopes.mjs` reports red across the whole estate.
 */
export const DEMANDED: readonly string[] = Object.freeze([TESSERA_READ_SCOPE, TESSERA_WRITE_SCOPE, TESSERA_PROVISION_SCOPE])
