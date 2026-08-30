/**
 * Token-gated membership, re-evaluated.
 *
 * 04-domain-model §9.2 is unusually direct about this: "Token-gated membership is **re-evaluated**,
 * not granted once: a scheduled job re-checks holdings via the indexer and demotes on failure, with
 * a grace period. **Membership that is never re-checked is not token-gating.**"
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE BALANCE ROUTE EXISTS NOW, AND THIS CLIENT CALLS IT.**
 *
 * `07-dependency-map.md` makes the indexer a **hard** dependency of this job "at a snapshot
 * block", and until 18-build-status.md §3.3j that dependency could not be satisfied: the indexer
 * had no balance route and no balances table. It now serves
 * `GET /addresses/:chain/:network/:address/token-balances?contract=&block=`, which is the exact
 * shape this file had already named — so the workaround is deleted rather than adapted.
 *
 * **What the indexer will and will not answer, and why that is the right shape for a gate.** It
 * derives the balance by summing an address's recorded token movements, so it will only give one
 * when the canonical chain it holds runs unbroken from the genesis block to the asked height. When
 * it does not — and its follower cold-starts near the tip, so an un-backfilled indexer never does
 * — the `balance` field is **absent** rather than zero. That lands in this client as an unparseable
 * answer, which lands in the job as `unknown`, which is exactly right:
 *
 *   **AN UNKNOWN HOLDING NEVER DEMOTES.** Not "demote after a while", not "assume zero". A
 *   token-gating check that cannot run must not evict a community's entire membership. The
 *   `unknown` outcome climbs a metric and that is how an operator learns the gate is not running —
 *   and, now, how they learn the indexer needs a backfill to zero before it can run.
 *
 * **What is still missing, plainly: this service does not know any member's chain address.** A
 * membership's `subject` is `user:<userId>` (`migrations.ts`), there is no address column, and the
 * mapping from a platform subject to a wallet address is a fact `micro-wallet` holds. 07's
 * dependency table gives this service no edge to `wallet`, so inventing one here would be inventing
 * a design. Until that edge exists, `holdingAt` refuses to send a user id to the indexer as if it
 * were an address — see `chainAddressOf` — and answers `unknown`. The gate is therefore correct
 * and not yet running, which is a different and much better state than the gate demoting people on
 * a number nobody derived.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { chainSpec, ON_CHAIN_ASSETS, type Network } from '@cloudsforge/contracts-chain'
import { HttpClient, HttpError } from '@cloudsforge/http'
import type { Db, Emit, Tx } from './outbox.ts'
import { TOPICS } from './events.ts'
import type { Community } from './communities.ts'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The route this job calls, in the indexer's own conventions: `:chain/:network/:address`, matching
 * `/addresses/:chain/:network/:address/activity`. `clients.test.ts` asserts it is one the indexer
 * really serves rather than one spelled hopefully here.
 */
export const HTTP_HOLDINGS_ROUTE = '/addresses/:chain/:network/:address/token-balances'

/**
 * The indexer's URL slug for a numeric chain id, or null when this estate does not index it.
 *
 * A gate stores `gate_chain_id`, a number, because that is what a wallet and a signature agree on.
 * The indexer's path segment is a slug — `ember`, `eth` — and the two are joined by
 * `@cloudsforge/contracts-chain`, which is the ONLY place that mapping is allowed to live: it is
 * exact-pinned precisely so that `wallet`, `settlement`, `custody` and `indexer` cannot disagree
 * about which chain a number names. Restating it here as a local table is how a community gated on
 * Hearth mainnet gets re-checked against Hearth testnet.
 *
 * Null rather than a guess when nothing matches. A gate configured for a chain the estate does not
 * index yields `unknown`, and `unknown` never demotes.
 */
export function indexerChainFor(chainId: number, network: string): string | null {
  if (network !== 'mainnet' && network !== 'testnet') return null
  const wanted: Network = network
  for (const asset of ON_CHAIN_ASSETS) {
    if (chainSpec(asset).chainId?.[wanted] === chainId) return asset.toLowerCase()
  }
  return null
}

/** Every EVM chain in `CHAINS` addresses accounts this way, and the indexer stores them lowercased. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * The chain address behind a membership subject, or null when there is not one.
 *
 * See the file header: this service holds no address for a member, so in practice this returns
 * null for every real subject and the gate answers `unknown`. It is written as a function rather
 * than as an inline `slice` so that the day a wallet lookup arrives there is one place to put it,
 * and so the refusal is a stated decision instead of a user id quietly posted to a chain indexer
 * as an address — which would spend one 400 per member per cycle, for ever, and log nothing that
 * named the real problem.
 */
export function chainAddressOf(subject: string): string | null {
  const candidate = subject.startsWith('user:') ? subject.slice('user:'.length) : subject
  return EVM_ADDRESS.test(candidate) ? candidate.toLowerCase() : null
}

/** What a re-check concluded about one member. */
export type GateOutcome = 'holds' | 'short' | 'unknown'

export interface Holding {
  /** Smallest units. `bigint`, never a number: a token balance is a uint256. */
  readonly balance: bigint
}

/**
 * The holdings question, as a seam.
 *
 * `null` means **unknown** — the oracle could not answer — and is distinct from a zero balance,
 * which is a real answer that demotes. Collapsing the two is the defect this interface exists to
 * make impossible to write by accident.
 */
export interface HoldingsOracle {
  holdingAt(
    chainId: number,
    contract: string,
    subject: string,
    atBlock: bigint | null,
  ): Promise<Holding | null>
}

/**
 * An oracle that knows nothing, and says so.
 *
 * What a deployment with no `INDEXER_BASE_URL` gets, which is a supported mode. Deliberately not
 * "an oracle that returns zero": zero demotes, and a service whose default configuration silently
 * evicts every token-gated member is not a service that should ship.
 */
export function unavailableOracle(): HoldingsOracle {
  return { holdingAt: async () => null }
}

export interface IndexerOracleOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  /** The indexer's network segment. `mainnet` or `testnet`. */
  readonly network: string
  readonly fetch?: typeof globalThis.fetch
}

/**
 * The scopes this service's token must carry to call this peer.
 *
 * `readonly LiveScope[]` rather than `readonly string[]`: see the header of `policyclient.ts`.
 * This is an outbound demand, `derive-grants.mjs` reads it into the estate's grant list, and
 * identity
 * refuses to boot on a name the registry does not have — or has deprecated, which `Scope` alone
 * would not have caught.
 */
export const INDEXER_SCOPES: readonly LiveScope[] = Object.freeze(['indexer:read'])

/**
 * The HTTP oracle, written against the route the indexer serves.
 *
 * Every failure answers `null` rather than throwing, because the caller's only correct response to
 * a failure is "do not demote" and an exception would have to be translated into exactly that at
 * every call site. **A 404 is included in that, and deliberately still is now that the route
 * exists**: a 404 here means the indexer has no record of the address, which is not evidence that
 * a member sold their tokens — it is far more likely to mean this deployment points at an indexer
 * that has never followed the chain the gate names. Market's escrow client splits its 404 because
 * "no such transaction" there is a fact the seller must act on; here there is nothing a member did
 * wrong and nothing to act on but the deployment, so the honest answer is `unknown`.
 *
 * A 200 whose `balance` is missing is treated identically, and that path is not hypothetical: the
 * indexer OMITS `balance` whenever its own coverage cannot support one. So the shape of this
 * parser — a string of digits, or nothing — is what carries the indexer's honesty through to the
 * gate without this file having to understand coverage at all.
 */
export function indexerOracle(options: IndexerOracleOptions): HoldingsOracle {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'indexer',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async holdingAt(chainId, contract, subject, atBlock) {
      // Both refusals are `unknown`, and neither costs a request. A chain this estate does not
      // index, or a subject with no address behind it, is a question the indexer cannot answer;
      // asking it anyway would turn one configuration mistake into a 400 per member per cycle.
      const chain = indexerChainFor(chainId, options.network)
      if (chain === null) return null
      const address = chainAddressOf(subject)
      if (address === null) return null

      const scope = `${encodeURIComponent(chain)}/${encodeURIComponent(options.network)}`
      const path = `/addresses/${scope}/${encodeURIComponent(address)}/token-balances`
      const query = new URLSearchParams({ contract })
      // The snapshot block 07-dependency-map asks for. Absent means "at the head the indexer has
      // walked", which is what a periodic re-check wants.
      if (atBlock !== null) query.set('block', atBlock.toString())
      try {
        const body = await client.request<{ balance?: unknown }>(`${path}?${query.toString()}`, {
          method: 'GET',
        })
        // A decimal string, in both directions. A JSON number would not survive a uint256, and the
        // indexer omits the field entirely rather than defaulting it — so `undefined` arrives here
        // as `unknown`, which never demotes.
        if (typeof body.balance !== 'string' || !/^\d+$/.test(body.balance)) return null
        return { balance: BigInt(body.balance) }
      } catch (err) {
        // Deliberately no branch on status. See the doc comment: every failure is `unknown`, and
        // `unknown` never demotes.
        void (err instanceof HttpError)
        return null
      }
    },
  }
}

/* ------------------------------------------------------------------ the re-check */

export interface GateCheck {
  readonly subject: string
  readonly outcome: GateOutcome
  /** Set when the outcome is a demotion, or when a grace period was started. */
  readonly graceUntil: Date | null
  readonly demoted: boolean
}

/**
 * Re-check one member against the community's gate.
 *
 * **The grace period is a two-stage transition, and each stage is a separate run of this
 * function.** A member found short is given `grace_until = now() + gateGraceHours` and left
 * `active`; a member found short again *after* their grace has expired is demoted. That is what
 * 04-domain-model §9.2's "with a grace period" has to mean to be worth anything — demoting on the
 * first bad read would turn one indexer hiccup, or one member moving tokens between their own
 * wallets, into an eviction.
 *
 * A member found holding has their grace cleared, so a recovery is immediate and complete.
 */
export async function recheckMember(
  tx: Tx,
  emit: Emit,
  oracle: HoldingsOracle,
  community: Community,
  subject: string,
  graceUntilNow: Date | null,
): Promise<GateCheck> {
  const gate = community.gate
  if (!gate) return { subject, outcome: 'holds', graceUntil: null, demoted: false }

  const holding = await oracle.holdingAt(gate.chainId, gate.contract, subject, null)

  if (holding === null) {
    // UNKNOWN. Nothing is written — not the check timestamp either, because recording a check that
    // did not happen would push this member to the back of the `holdings_checked_at` queue and
    // hide the fact that they have not actually been verified. See the file header.
    return { subject, outcome: 'unknown', graceUntil: graceUntilNow, demoted: false }
  }

  if (holding.balance >= gate.minHolding) {
    await tx`
      update memberships
         set holdings_checked_at = now(), grace_until = null,
             status = case when status = 'demoted' then 'active' else status end,
             updated_at = now()
       where community_id = ${community.id} and subject = ${subject}
    `
    return { subject, outcome: 'holds', graceUntil: null, demoted: false }
  }

  // SHORT. Either start the grace period, or — if it has already run out — demote.
  const expired = graceUntilNow !== null && graceUntilNow.getTime() <= Date.now()
  if (!expired && graceUntilNow === null) {
    const grace = new Date(Date.now() + community.gateGraceHours * 3_600_000)
    await tx`
      update memberships
         set holdings_checked_at = now(), grace_until = ${grace}, updated_at = now()
       where community_id = ${community.id} and subject = ${subject}
    `
    return { subject, outcome: 'short', graceUntil: grace, demoted: false }
  }
  if (!expired) {
    await tx`
      update memberships set holdings_checked_at = now(), updated_at = now()
       where community_id = ${community.id} and subject = ${subject}
    `
    return { subject, outcome: 'short', graceUntil: graceUntilNow, demoted: false }
  }

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // Demotion. `status = 'demoted'`, never a DELETE: the row is the record that this subject WAS a
  // member and why they stopped being one, and a member who buys back in is restored by the branch
  // above rather than by re-joining from nothing. An owner is exempt — a community whose owner sold
  // their tokens is a governance problem for the community, and evicting the only account that can
  // administer it turns that into a problem nobody in the estate can solve.
  // ────────────────────────────────────────────────────────────────────────────────────────────
  const demoted = await tx<{ subject: string }[]>`
    update memberships
       set status = 'demoted', holdings_checked_at = now(), updated_at = now()
     where community_id = ${community.id} and subject = ${subject}
       and status = 'active' and role <> 'owner'
    returning subject
  `
  if (demoted.length === 0) {
    await tx`
      update memberships set holdings_checked_at = now(), updated_at = now()
       where community_id = ${community.id} and subject = ${subject}
    `
    return { subject, outcome: 'short', graceUntil: graceUntilNow, demoted: false }
  }

  emit({
    topic: TOPICS.memberDemoted,
    key: community.id,
    actor: 'service:community',
    payload: {
      communityId: community.id,
      subject,
      reason: 'token_holding_below_minimum',
      minHolding: gate.minHolding.toString(),
      observed: holding.balance.toString(),
    },
  })
  return { subject, outcome: 'short', graceUntil: graceUntilNow, demoted: true }
}

export interface DueMember {
  readonly communityId: string
  readonly subject: string
  readonly graceUntil: Date | null
}

/**
 * Token-gated memberships due a re-check, oldest first.
 *
 * `holdings_checked_at nulls first` so a member who has never been checked is checked before one
 * that was checked an hour ago — a member granted access and never verified is the exact state
 * 04-domain-model §9.2 says is not token-gating.
 */
export async function membersDueForRecheck(
  sql: Db | Tx,
  intervalHours: number,
  limit: number,
): Promise<readonly DueMember[]> {
  const rows = await sql<
    { community_id: string; subject: string; grace_until: Date | null }[]
  >`
    select m.community_id, m.subject, m.grace_until
      from memberships m
      join communities c on c.id = m.community_id
     where c.kind = 'token_gated'
       and c.status = 'active'
       and m.status in ('active','demoted')
       and (m.holdings_checked_at is null
            or m.holdings_checked_at < now() - make_interval(hours => ${intervalHours}))
     order by m.holdings_checked_at nulls first
     limit ${limit}
  `
  return rows.map((row) => ({
    communityId: row.community_id,
    subject: row.subject,
    graceUntil: row.grace_until,
  }))
}
