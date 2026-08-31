/**
 * Unified search: the ⌘K bar in the top bar of the Forge Hub layout.
 *
 * **This is a composition, not an index, and the difference is deliberate.** Nothing here is
 * stored. Each group is a bounded page fetched from the service that owns it and filtered in this
 * process, which means the results are exactly as fresh as that service and there is no index to
 * fall behind, no reindex job, and no second copy of an address to disagree with the first.
 *
 * It also means the recall is honestly bounded, and the response says so. A user searching for a
 * transaction from last year will not find it, because the page this searched did not reach that
 * far back — so every group carries `truncated`, and the client shows "showing matches from your
 * recent history" rather than "no results", which is a different and false claim.
 *
 * **What would make this a real search**, and what is therefore on the gap list: none of the four
 * upstreams accepts a query parameter. `GET /feed` filters by category and product but not by
 * text; `GET /v1/wallets` filters by origin but not by address; there is no transaction search at
 * all. A `q=` on each of those, pushing the match down to the index that can actually do it, turns
 * this file into a fan-out and a merge and deletes every `includes()` below. Until then the
 * bounded-page behaviour is the honest implementation, and it is not one that can quietly become
 * wrong: it either finds a thing in the recent window or reports that it looked in a window.
 */

import type { TileDeps } from './tiles.ts'
import { loadTile, type Tile } from './tiles.ts'
import {
  CACHE,
  PAGE,
  type ActivityRecord,
  type DepositCredit,
  type Upstreams,
  type WalletRecord,
  type WithdrawalRecord,
} from './upstreams.ts'

/** Matches per group. A ⌘K palette that needs a scrollbar has already failed. */
export const GROUP_LIMIT = 8

export type SearchKind = 'wallet' | 'transaction' | 'token' | 'activity'

export interface SearchResult {
  readonly kind: SearchKind
  readonly id: string
  readonly title: string
  readonly subtitle: string
  /** Deep link into Forge Hub. Relative: the SPA owns its own origin. */
  readonly href: string
  readonly source: string
}

export interface SearchGroup {
  readonly results: readonly SearchResult[]
  /** True when the window searched was full, so an older match could exist and was not seen. */
  readonly truncated: boolean
}

export interface SearchResponse {
  readonly query: string
  readonly groups: {
    readonly wallets: Tile<SearchGroup>
    readonly transactions: Tile<SearchGroup>
    readonly tokens: Tile<SearchGroup>
    readonly activity: Tile<SearchGroup>
  }
  readonly total: number
  readonly degraded: readonly string[]
}

export interface SearchDeps extends TileDeps {
  readonly upstreams: Upstreams
}

export interface SearchRequest {
  readonly userId: string
  readonly query: string
  readonly requestId: string
}

const EMPTY_GROUP: SearchGroup = Object.freeze({ results: Object.freeze([]), truncated: false })

/** The window each group searches. Larger than a dashboard page: this is history, not a preview. */
const WINDOW = Object.freeze({ wallets: PAGE.wallets, transactions: 100, activity: 100 })

/**
 * Search. Degrades per group for the same reason the dashboard degrades per tile: a search bar
 * that returns an error because one of four sources is unwell is a search bar nobody trusts again.
 */
export async function search(deps: SearchDeps, request: SearchRequest): Promise<SearchResponse> {
  const { userId, query, requestId } = request
  const needle = query.trim().toLowerCase()

  const walletsTile = loadTile<readonly WalletRecord[]>(deps, {
    tile: 'search_wallets',
    upstream: 'wallet',
    // The same key the dashboard uses. Sharing it is the point: opening the palette after loading
    // the dashboard costs nothing, and the two views cannot disagree about a wallet's state.
    key: `wallet:registry:${userId}`,
    ...CACHE.walletRegistry,
    empty: [],
    load: () => deps.upstreams.walletRegistry(userId, requestId),
  })

  const depositsTile = loadTile<readonly DepositCredit[]>(deps, {
    tile: 'search_deposits',
    upstream: 'wallet',
    // A different key from the dashboard's, and deliberately: the dashboard caches the deposits
    // still in flight, and search needs the settled ones too. One key holding two different
    // filters of one query is how a cache starts answering the wrong question.
    key: `wallet:deposits:all:${userId}`,
    ...CACHE.walletDeposits,
    empty: [],
    load: () => deps.upstreams.walletDeposits(userId, requestId),
  })

  const withdrawalsTile = loadTile<readonly WithdrawalRecord[]>(deps, {
    tile: 'search_withdrawals',
    upstream: 'wallet',
    key: `wallet:withdrawals:all:${userId}`,
    ...CACHE.walletWithdrawals,
    empty: [],
    load: () => deps.upstreams.walletWithdrawals(userId, requestId),
  })

  const activityTile = loadTile<readonly ActivityRecord[]>(deps, {
    tile: 'search_activity',
    upstream: 'activity',
    key: `activity:window:${userId}`,
    ...CACHE.activityFeed,
    empty: [],
    load: async () =>
      (await deps.upstreams.activityFeed(userId, WINDOW.activity, null, requestId)).records,
  })

  const balancesTile = loadTile<readonly import('./upstreams.ts').LedgerBalance[]>(deps, {
    tile: 'search_tokens',
    upstream: 'ledger',
    key: `ledger:balances:${userId}`,
    ...CACHE.ledgerBalances,
    empty: [],
    load: () => deps.upstreams.ledgerBalances(userId, requestId),
  })

  const [wallets, deposits, withdrawals, activityRecords, balances] = await Promise.all([
    walletsTile,
    depositsTile,
    withdrawalsTile,
    activityTile,
    balancesTile,
  ])

  const groups = {
    wallets: shape(wallets, (records) => matchWallets(records, needle)),
    // One group from two fetches, so a wallet outage costs the whole transactions group rather
    // than half of it silently. Half a result set with no marker is the worst of both.
    transactions: mergeTransactions(deposits, withdrawals, needle),
    tokens: shape(balances, (records) => matchTokens(records, needle)),
    activity: shape(activityRecords, (records) => matchActivity(records, needle)),
  }

  const total = Object.values(groups).reduce((sum, group) => sum + group.data.results.length, 0)
  return {
    query,
    groups,
    total,
    degraded: Object.entries(groups)
      .filter(([, tile]) => tile.status !== 'ok')
      .map(([name]) => name),
  }
}

/** Re-shape a fetched tile into a result group, preserving its status verbatim. */
function shape<T>(tile: Tile<T>, project: (value: T) => SearchGroup): Tile<SearchGroup> {
  if (tile.status === 'unavailable') return { ...tile, data: EMPTY_GROUP }
  return { ...tile, data: project(tile.data) }
}

function mergeTransactions(
  deposits: Tile<readonly DepositCredit[]>,
  withdrawals: Tile<readonly WithdrawalRecord[]>,
  needle: string,
): Tile<SearchGroup> {
  if (deposits.status === 'unavailable' || withdrawals.status === 'unavailable') {
    const reason = deposits.reason ?? withdrawals.reason ?? 'wallet is unavailable'
    return {
      status: 'unavailable',
      upstream: 'wallet',
      reason,
      cached: false,
      ageMs: null,
      data: EMPTY_GROUP,
    }
  }

  const results = [...matchDeposits(deposits.data, needle), ...matchWithdrawals(withdrawals.data, needle)]
  const status = deposits.status === 'ok' && withdrawals.status === 'ok' ? 'ok' : 'degraded'
  return {
    status,
    upstream: 'wallet',
    reason: status === 'ok' ? null : (deposits.reason ?? withdrawals.reason),
    cached: deposits.cached || withdrawals.cached,
    ageMs: deposits.ageMs,
    data: {
      results: results.slice(0, GROUP_LIMIT),
      truncated:
        results.length > GROUP_LIMIT ||
        deposits.data.length >= WINDOW.transactions ||
        withdrawals.data.length >= WINDOW.transactions,
    },
  }
}

/**
 * Substring, case-insensitive, over the fields a user would actually type.
 *
 * Not a fuzzy match. A palette that returns a plausible wrong wallet for a mistyped address is
 * worse than one that returns nothing, because the next thing the user does is paste it into a
 * withdrawal form.
 */
function hit(needle: string, ...fields: readonly (string | null | undefined)[]): boolean {
  if (needle.length === 0) return false
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(needle))
}

function matchWallets(wallets: readonly WalletRecord[], needle: string): SearchGroup {
  const results: SearchResult[] = []
  const windowFull = wallets.length >= WINDOW.wallets
  for (const wallet of wallets) {
    if (!hit(needle, wallet.address, wallet.label, wallet.chain, wallet.origin)) continue
    results.push({
      kind: 'wallet',
      id: wallet.id,
      title: wallet.label ?? wallet.address,
      // Lifecycle state in the subtitle, because §6 rule 3 makes it a fact a user must see at a
      // glance — including here, not only in the wallet list.
      subtitle: `${wallet.chain} · ${wallet.origin} · ${wallet.status}`,
      href: `/wallet/${wallet.id}`,
      source: 'wallet',
    })
  }
  return {
    results: results.slice(0, GROUP_LIMIT),
    truncated: results.length > GROUP_LIMIT || windowFull,
  }
}

function matchDeposits(credits: readonly DepositCredit[], needle: string): SearchResult[] {
  const results: SearchResult[] = []
  for (const credit of credits) {
    if (!hit(needle, credit.txHash, credit.txUrn, credit.assetCode, credit.amountFormatted)) continue
    results.push({
      kind: 'transaction',
      id: credit.id,
      title: `Deposit ${credit.amountFormatted} ${credit.assetCode}`,
      subtitle: credit.credited ? 'credited' : `${credit.confirmations} confirmations`,
      href: `/wallet/deposits/${credit.id}`,
      source: 'wallet',
    })
  }
  return results
}

function matchWithdrawals(withdrawals: readonly WithdrawalRecord[], needle: string): SearchResult[] {
  const results: SearchResult[] = []
  for (const withdrawal of withdrawals) {
    if (!hit(needle, withdrawal.txHash, withdrawal.destination, withdrawal.assetCode, withdrawal.id)) {
      continue
    }
    results.push({
      kind: 'transaction',
      id: withdrawal.id,
      title: `Withdrawal ${withdrawal.amountFormatted} ${withdrawal.assetCode}`,
      subtitle: withdrawal.state,
      href: `/wallet/withdrawals/${withdrawal.id}`,
      source: 'wallet',
    })
  }
  return results
}

/**
 * Tokens the user actually holds, matched by asset code.
 *
 * Sourced from the ledger rather than from a token catalogue, because "tokens" in a personal
 * search bar means the user's own holdings — including `TOKEN:<urn>` assets minted through the
 * estate, which no price board lists. A global token directory belongs to the mint service and is
 * on the gap list.
 */
function matchTokens(
  balances: readonly import('./upstreams.ts').LedgerBalance[],
  needle: string,
): SearchGroup {
  const seen = new Set<string>()
  const results: SearchResult[] = []
  for (const balance of balances) {
    if (seen.has(balance.assetCode)) continue
    if (!hit(needle, balance.assetCode)) continue
    seen.add(balance.assetCode)
    results.push({
      kind: 'token',
      id: balance.assetCode,
      title: balance.assetCode,
      subtitle: 'held in your portfolio',
      href: `/portfolio/${encodeURIComponent(balance.assetCode)}`,
      source: 'ledger',
    })
  }
  return { results: results.slice(0, GROUP_LIMIT), truncated: results.length > GROUP_LIMIT }
}

function matchActivity(records: readonly ActivityRecord[], needle: string): SearchGroup {
  const results: SearchResult[] = []
  for (const record of records) {
    if (!hit(needle, record.summary, record.type, record.subjectUrn, record.assetCode)) continue
    results.push({
      kind: 'activity',
      id: record.id,
      title: record.summary,
      subtitle: `${record.product} · ${record.occurredAt}`,
      href: `/activity/${record.id}`,
      source: 'activity',
    })
  }
  return {
    results: results.slice(0, GROUP_LIMIT),
    truncated: results.length > GROUP_LIMIT || records.length >= WINDOW.activity,
  }
}
