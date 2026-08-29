/**
 * `micro-community`, over HTTP. A ward's governance, in the service that already has governance.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **TESSERA MUST NEVER GROW A SECOND VOTING SYSTEM, AND THIS FILE IS THE WHOLE OF WHAT IT GROWS
 * INSTEAD.**
 *
 * §10's second "repository that needs nothing": "A ward is a community of `kind: 'public'` with
 * `governance_model: 'one_member_one_vote'` (`community/src/migrations.ts`).
 * Ward decisions ride `parameter_change` proposals — one of the four kinds in the closed catalogue
 * (`community/src/proposals.ts`) — and Tessera subscribes to `community.proposal.executed`
 * and applies the parameter itself."
 *
 * So this client creates a community and stores its id. It does **not** create proposals, cast
 * votes, tally them, appoint officers, run timelocks or hold a treasury, because
 * `micro-community` already does all six and a second implementation of any of them would be a
 * second answer to "who decided this". The effects arrive as events, in `inbound.ts`.
 *
 * **`one_member_one_vote` is not a default here, it is §7.1's second refusal.** "Buying votes is
 * buying power over people, and here the code already agrees": `WeightResolver` is a typed seam
 * (`community/src/votes.ts`), the sole implementation is `oneMemberOneVote` returning `1n`
 *, and community's server falls back to it because `deps.weights` is optional and
 * unwired (`community/src/server.ts`). Tessera asks for the model by name so that a
 * ward whose governance was token-weighted would have to be created by editing the constant below,
 * and `communityclient.test.ts` asserts that constant against a literal.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * **A USER TOKEN, BECAUSE COMMUNITY REFUSES A SERVICE ONE — AND IT IS RIGHT TO.**
 *
 *     if (principal.kind !== 'user') {
 *       // A service token is not "close enough" on the governance surface. It names no user, so
 *       // there is no membership to check — and accepting one would make every service in the
 *       // estate a voting member of every community.
 *       throw new ForbiddenError('this route requires a user token')
 *     }                                        community/src/server.ts, `authenticateUser`
 *
 * `POST /v1/communities` then takes the owner FROM THE TOKEN, never from the body
 * (`community/src/server.ts`: "A caller-supplied owner is a caller who can create a community
 * owned by somebody else and then be its only admin"). So Tessera cannot found a ward's community
 * with `TESSERA_SERVICE_CREDENTIAL`; it relays the founding admin's own token, exactly as the
 * market seam relays the seller's. `server.ts` requires `isAdmin` on the route for that reason —
 * a ward is platform-minted, so founding its community is a platform act, and community insists a
 * human owns it.
 *
 * Note also that this route demands **no scope**, which is load-bearing: §11's caution records
 * that community's own `community:read` is **absent** from the contracts registry, and identity
 * fail-fasts at import on a grant naming an unknown scope (`identity/src/env.ts`). A client
 * that demanded a scope here could not be granted one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient, HttpError } from '@cloudsforge/http'

/** §10: a ward is a `public` community. Not `guild` — a ward's membership is the world's. */
export const WARD_COMMUNITY_KIND = 'public'
/** `open`, because §7.1's third refusal is that safety and participation are never purchasable. */
export const WARD_JOIN_POLICY = 'open'
/** §7.1's second refusal, by name. See the file header. */
export const WARD_GOVERNANCE_MODEL = 'one_member_one_vote'

export class CommunityError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 502) {
    super(message)
    this.name = 'CommunityError'
    this.code = code
    this.status = status
  }
}

export interface CreateCommunityInput {
  /** `community/src/migrations.ts` — `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`. Built by `wardSlug`. */
  readonly slug: string
  readonly name: string
  /** The founding admin's own bearer token, relayed. Community refuses a service one. */
  readonly founderToken: string
  readonly idempotencyKey: string
  readonly correlationId: string
}

export interface CommunityRef {
  readonly id: string
  readonly slug: string
  readonly governanceModel: string
  readonly ownerSubject: string
}

export interface CommunityClient {
  createCommunity(input: CreateCommunityInput): Promise<CommunityRef>
}

export interface CommunityClientOptions {
  readonly baseUrl: string
  /** Test seam. */
  readonly client?: Pick<HttpClient, 'request'>
}

/**
 * A ward's community slug, in community's shape.
 *
 * `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$` — at least three characters, no leading or trailing hyphen.
 * A ward slug is already `[a-z0-9-]`, so the prefix is what guarantees the length and the leading
 * character. Built here rather than at the call site so the one place it can be malformed is the
 * one place it is tested.
 */
export function wardCommunitySlug(wardSlug: string): string {
  const cleaned = wardSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
  const slug = `ward-${cleaned}`.slice(0, 64)
  // Trailing hyphen after the truncation would fail community's CHECK. Refused rather than
  // trimmed-and-hoped, because a slug is unique and a silently different one is a second community.
  return slug.replace(/-+$/, '')
}

export function createCommunityClient(options: CommunityClientOptions): CommunityClient {
  const http = options.client ?? new HttpClient({ baseUrl: options.baseUrl, name: 'community' })

  return {
    async createCommunity(input) {
      let body: unknown
      try {
        body = await http.request<unknown>('/v1/communities', {
          method: 'POST',
          deadlineMs: 15_000,
          // The ward id. Community's `withIdempotentRoute` dedupes on it, so a retried founding
          // creates one community rather than a second one under a slug that is already taken.
          idempotencyKey: input.idempotencyKey,
          requestId: input.correlationId,
          headers: { authorization: `Bearer ${input.founderToken}` },
          body: {
            slug: input.slug,
            name: input.name,
            kind: WARD_COMMUNITY_KIND,
            joinPolicy: WARD_JOIN_POLICY,
            governanceModel: WARD_GOVERNANCE_MODEL,
            // No `gate`. A token-gated ward is a ward you buy your way into, which is §7.1's
            // fourth refusal — and `parseGate` is only reached when the field is present
            // (`community/src/server.ts`), so its absence is the refusal.
          },
        })
      } catch (err) {
        if (err instanceof HttpError) {
          throw new CommunityError(
            err.status >= 500 ? 'community_unavailable' : 'community_refused',
            `community answered ${err.status} for /v1/communities: ${err.body.slice(0, 300)}`,
            err.status >= 500 ? 502 : err.status,
          )
        }
        throw new CommunityError('community_unavailable', err instanceof Error ? err.message : String(err))
      }

      const community = (body as { community?: unknown } | null)?.community
      if (typeof community !== 'object' || community === null) {
        throw new CommunityError('bad_response', 'community did not answer with a community')
      }
      const c = community as Record<string, unknown>
      const id = c['id']
      const slug = c['slug']
      const governanceModel = c['governanceModel']
      const ownerSubject = c['ownerSubject']
      if (typeof id !== 'string' || id.length === 0) {
        throw new CommunityError('bad_response', 'community returned no id')
      }
      if (typeof governanceModel !== 'string') {
        throw new CommunityError(
          'bad_response',
          'community returned no governance model — one member one vote cannot be checked',
        )
      }
      return {
        id,
        slug: typeof slug === 'string' ? slug : input.slug,
        governanceModel,
        ownerSubject: typeof ownerSubject === 'string' ? ownerSubject : '',
      }
    },
  }
}
