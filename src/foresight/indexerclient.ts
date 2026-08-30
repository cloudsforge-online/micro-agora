/**
 * The indexer, as the position mirror uses it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS THE ONLY WAY THIS SERVICE LEARNS WHAT IS IN A POOL, AND IT IS DELIBERATELY INDIRECT.
 *
 * foresight could read the chain itself. It does not, for the reason `micro-wallet` does not
 * either: reorg handling is genuinely hard, `micro-indexer` has already solved it once with a
 * checkpoint, a canonical/orphaned distinction and a block-atomic write, and a second
 * implementation of that is a second set of the same bugs. What the indexer publishes is what this
 * service believes.
 *
 * The consequence is stated on every page that shows a pool: the mirror is **as of** a block, and
 * it can be behind. `mirror_cursors.synced_at` is what the page shows, and a stale mirror is a
 * degraded read, never a wrong one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Routes, verified against `micro-indexer/src/server.ts`
 *
 *   `POST /v1/watch/:chain/:network/:address`               line 321 — 202, idempotent
 *   `GET  /v1/addresses/:chain/:network/:address/activity`  line 318 — the paged value-transfer view
 *   `GET  /v1/transactions/:chain/:network/:hash`           line 319 — carries `logs`
 *   `GET  /v1/chains/:chain/:network/status`                line 317 — the tip, for `asOf`
 *
 * Both the `/v1` and unprefixed forms are served (`indexer/src/server.ts`), and `/v1` is the
 * estate convention and the one used here.
 *
 * ## Why the mirror needs two calls per transaction
 *
 * `activity` reports value transfers in and out of a watched address, which is exactly the shape of
 * a stake — wallet → market contract — and carries the reorg status this whole design turns on. It
 * does not carry the OUTCOME the staker backed, because that lives in the `Staked` log's data. So
 * the mirror pages activity to find candidate transactions and reads each one's logs to decode
 * them. The alternative — a log-query endpoint on the indexer — does not exist, and adding one is a
 * change to a repository this task may not touch.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry to call this peer.
 *
 * `readonly LiveScope[]` rather than `readonly string[]`: see the header of `policyclient.ts`.
 * This is an outbound demand, `derive-grants.mjs` reads it into the estate's grant list, and
 * identity
 * refuses to boot on a name the registry does not have — or has deprecated, which `Scope` alone
 * would not have caught.
 */
export const INDEXER_SCOPES: readonly LiveScope[] = Object.freeze(['indexer:read', 'indexer:write'])

export class IndexerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IndexerUnavailableError'
  }
}

/** One value transfer, as the indexer sees it. Field names are the indexer's own. */
export interface ActivityItem {
  readonly id: string
  readonly direction: 'in' | 'out'
  readonly amount: string
  readonly txHash: string
  readonly logIndex: number | null
  readonly blockHeight: number
  readonly blockHash: string
  /**
   * `included` or `orphaned`. **The whole reorg story is this one field**, and the mirror's job is
   * to carry it forward faithfully rather than to decide anything about it.
   */
  readonly status: 'included' | 'orphaned'
  readonly confirmations: number | null
  readonly confirmed: boolean
}

export interface ActivityPage {
  readonly tipHeight: number | null
  readonly requiredConfirmations: number
  readonly items: readonly ActivityItem[]
  readonly nextCursor: string | null
}

export interface TransactionLog {
  readonly logIndex: number
  readonly address: string
  readonly topics: readonly string[]
  readonly data: string
  readonly status: string
}

export interface TransactionView {
  readonly hash: string
  readonly blockHeight: number | null
  readonly blockHash: string | null
  readonly status: string
  readonly confirmations: number | null
  readonly logs: readonly TransactionLog[]
}

export interface ChainStatusView {
  readonly tipHeight: number | null
}

export interface IndexerClient {
  /** Ask the indexer to follow a market contract. Idempotent; 202 and nothing else. */
  watch(chain: string, network: string, address: string, label: string): Promise<void>
  activity(
    chain: string,
    network: string,
    address: string,
    limit: number,
    cursor: string | null,
  ): Promise<ActivityPage>
  transaction(chain: string, network: string, hash: string): Promise<TransactionView | null>
  status(chain: string, network: string): Promise<ChainStatusView>
}

export interface IndexerClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

export function httpIndexerClient(options: IndexerClientOptions): IndexerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'indexer',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async watch(chain, network, address, label) {
      try {
        await client.request(`/v1/watch/${chain}/${network}/${address}`, {
          method: 'POST',
          body: { label },
          // Watching is naturally idempotent on the indexer's side, but without a key `HttpClient`
          // attempts the POST exactly once — and a lost response would leave a market whose stakes
          // nobody is following.
          idempotencyKey: `foresight:watch:${chain}:${network}:${address}`,
        })
      } catch (err) {
        throw translate(err)
      }
    },

    async activity(chain, network, address, limit, cursor) {
      const query = new URLSearchParams({ limit: String(limit) })
      if (cursor) query.set('cursor', cursor)
      try {
        const body = await client.request<{
          tipHeight?: number | null
          requiredConfirmations?: number
          items?: unknown
          nextCursor?: string | null
        }>(`/v1/addresses/${chain}/${network}/${address}/activity?${query.toString()}`, {
          method: 'GET',
        })
        return {
          tipHeight: body.tipHeight ?? null,
          requiredConfirmations: body.requiredConfirmations ?? 0,
          items: Array.isArray(body.items) ? (body.items as ActivityItem[]) : [],
          nextCursor: body.nextCursor ?? null,
        }
      } catch (err) {
        throw translate(err)
      }
    },

    async transaction(chain, network, hash) {
      try {
        const body = await client.request<TransactionView>(
          `/v1/transactions/${chain}/${network}/${hash}`,
          { method: 'GET' },
        )
        return body
      } catch (err) {
        // A transaction the indexer has not seen is a legitimate answer, not a failure: the mirror
        // simply has nothing to record for it yet and will look again.
        if (err instanceof HttpError && err.status === 404) return null
        throw translate(err)
      }
    },

    async status(chain, network) {
      try {
        const body = await client.request<{ tipHeight?: number | null }>(
          `/v1/chains/${chain}/${network}/status`,
          { method: 'GET' },
        )
        return { tipHeight: body.tipHeight ?? null }
      } catch (err) {
        throw translate(err)
      }
    },
  }
}

/**
 * Everything is unavailability here, including a 4xx, and that is deliberate.
 *
 * There is no request this service can make of the indexer that the indexer could legitimately
 * REFUSE on its merits — it reads a public chain. A 4xx therefore means this client and that
 * service disagree about a route or a parameter, which is a deployment fault and must present as
 * "the mirror is not syncing" rather than as "this market has no stakes".
 */
function translate(err: unknown): Error {
  if (err instanceof IndexerUnavailableError) return err
  return new IndexerUnavailableError(err instanceof Error ? err.message : String(err))
}
