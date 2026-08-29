/**
 * The four price sources.
 *
 * Carried forward from `repos/forge-pay/services/pay/src/pricing.ts` — the endpoints, the
 * Kraken legacy-asset-name mapping and the note about Binance quoting in USDT are all its work and
 * all correct. Three things change:
 *
 *   1. **A source yields decimal STRINGS, never numbers.** The old file returned
 *      `Partial<Record<MarketCoin, number>>` and converted with `Math.floor(usd * 1e6)`, so every
 *      quote had been through a double twice before the median saw it. See `rates.ts`.
 *   2. **Fetching is injected.** `marketSources` takes its transport, so the whole oracle can be
 *      driven from a fake in tests — no test in this repository touches a live exchange, which is
 *      what makes the divergence and staleness rules testable at all rather than aspirational.
 *   3. **A source's failure is its own.** `Promise.allSettled` in `oracle.ts` means one exchange
 *      being down costs one source, not the round.
 */

import type { AssetCode } from '@cloudsforge/contracts-chain'
import { MARKET_ASSETS } from './rates.ts'

/** Decimal strings, keyed by asset. Absent means this source did not quote that asset. */
export type SourceQuotes = Partial<Record<AssetCode, string>>

export interface PriceSource {
  readonly name: string
  fetch(): Promise<SourceQuotes>
}

/** The transport, injected. Returns parsed JSON or throws. */
export type FetchJson = (url: string) => Promise<unknown>

/**
 * A decimal string from a JSON field.
 *
 * A string field is used verbatim and is therefore exact. A JSON *number* has already been parsed
 * into a double by `JSON.parse` before this function can see it, so the loss — if any — happened
 * before us; `String()` renders the shortest decimal that round-trips that double, and `parseScaled`
 * then reads its digits exactly. What this avoids is the second, larger rounding the old oracle
 * added on top by multiplying that double by 1e6.
 *
 * Of the four sources only CoinGecko quotes as a number. That is a reason to prefer the other
 * three, not a reason to drop it: it is one of four inputs to a median.
 */
export function decimalFrom(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return String(value)
  return undefined
}

/** Assign only the assets a source actually quoted, so an absent asset stays absent. */
function collect(entries: ReadonlyArray<readonly [AssetCode, string | undefined]>): SourceQuotes {
  const out: SourceQuotes = {}
  for (const [asset, value] of entries) {
    if (value !== undefined) out[asset] = value
  }
  return out
}

/**
 * The real transport. An absolute per-request deadline, because a hung exchange must not hold the
 * refresh lease open — the lease would expire mid-round and a second replica would start another.
 */
export function httpFetchJson(timeoutMs: number): FetchJson {
  return async (url: string) => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`)
    return response.json()
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHICH SYMBOL EACH VENUE KNOWS AN ASSET BY — four maps, and NOT four hardcoded URLs.
 *
 * These used to be three literal query strings with the assets spelled into them, next to two
 * lookup maps. That arrangement had a failure mode that is worth naming, because it very nearly
 * happened here and it takes the whole oracle down rather than one asset:
 *
 *   `MARKET_ASSETS` is DERIVED — `rates.ts` filters `ON_CHAIN_ASSETS` — so adding an asset to
 *   the chain contract in another repository silently widened the loops below WITHOUT widening the
 *   URLs. CoinGecko, Kraken and Binance would then have quoted every asset but the new one, and
 *   that one would simply be absent, which is survivable. **Coinbase would not.** It builds one URL
 *   per member from the asset code itself, `Promise.all` rejects on the first rejection, and
 *   `httpFetchJson` throws on any non-200 — so a single unlisted symbol turns a 404 into a source
 *   that answered nothing, and `oracle.ts` then counts coinbase out for EVERY OTHER MARKET ASSET
 *   too. One new asset, the whole venue's quotes gone, on a live estate.
 *
 * So no venue is ever asked for a symbol it has not been told this venue publishes. An asset with
 * no entry here is simply not requested, and is therefore absent from that source's answer — the
 * outcome `collect` and `decideRound` were already built to handle, per asset, failing closed.
 * `sources.test.ts` asserts every `MARKET_ASSETS` member appears in all four maps, so wiring an
 * asset into the chain contract without a price source is a red test rather than an outage.
 *
 * Reject-on-first-failure inside a source is UNCHANGED and still correct: a partial answer from one
 * venue is still one opinion, and the round's minimum-source rule decides whether losing it
 * matters. What changed is that a missing symbol can no longer manufacture that failure.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/* ── DOGE AND ETC WERE WIRED HERE BEFORE THEY EXISTED AS ASSET CODES, AND THAT IS THE ORDERING ──
 *
 * `contracts/packages/chain/src/index.ts`, above `ON_CHAIN_ASSETS`, states the rule this file is
 * the other half of: "wire the follower, the addresses and the sweep; add the price source and
 * prove it against the live venues; THEN add the member". LTC is the worked example, and DOGE and
 * ETC followed it: the five maps below carried both symbols for a release while `AssetCode` had
 * neither, inert because `quoted()` intersects with `MARKET_ASSETS`, so a symbol for an asset the
 * estate could not yet name was never requested.
 *
 * **That half is now DONE and the entries below are ordinary.** Read on 2026-08-09, `AssetCode` in
 * `@cloudsforge/contracts-chain` names both, so `MARKET_ASSETS` carries them and every map here is
 * checked against the union the ordinary way. No count is written down, here or anywhere else in
 * this file: the set is derived in another repository and a number in this prose would be stale the
 * day it widens. The state described above is history, kept because the next asset goes through it:
 * symbols first, membership second.
 *
 * What that history cost while it lasted is worth one line, because it reads as a puzzle otherwise.
 * `COINGECKO_IDS['DOGE']` did not compile against a union without `DOGE`, while writing `DOGE:`
 * inside the literal was accepted — the literal is passed to `Object.freeze` and loses its
 * freshness, and with it the excess-property check. So the keys typechecked and the lookups did
 * not, and `sources.test.ts` had to cast around the lookup half for exactly one release. Those
 * casts are gone, and a misspelt asset code in that file is a compile error again.
 *
 * **A PRICE IS NOT A CHAIN. Nothing in this service reaches a chain node — no RPC URL, no
 * `bitcoind`, no `geth`, nothing that could tell you whether an asset is followable.** A quote here
 * is four exchanges' opinion of a ticker, and it is exactly as available for an asset whose node is
 * switched off as for one at the chain tip. That is worth stating because the estate does not
 * currently follow both of these: on 2026-08-09 the Dogecoin node is still in initial block
 * download and no Ethereum Classic node runs at all, so DOGE and ETC being quotable is a statement
 * about CoinGecko, Coinbase, Kraken and Binance and about nothing else. Deposits, confirmations
 * and sweeps are settlement's and custody's question, answered from their own configuration.
 *
 * MEASURED AGAINST THE LIVE VENUES ON 2026-08-08, verbatim, because the Kraken half was a trap:
 *
 *   $ curl -s 'https://api.coingecko.com/api/v3/simple/price?ids=dogecoin,ethereum-classic&vs_currencies=usd'
 *   {"dogecoin":{"usd":0.070958},"ethereum-classic":{"usd":6.53}}
 *
 *   $ curl -s 'https://api.coinbase.com/v2/prices/DOGE-USD/spot'
 *   {"data":{"amount":"0.07096","base":"DOGE","currency":"USD"}}
 *   $ curl -s 'https://api.coinbase.com/v2/prices/ETC-USD/spot'
 *   {"data":{"amount":"6.53","base":"ETC","currency":"USD"}}
 *
 *   $ curl -s 'https://api.binance.com/api/v3/ticker/price?symbol=DOGEUSDT'
 *   {"symbol":"DOGEUSDT","price":"0.07101000"}
 *   $ curl -s 'https://api.binance.com/api/v3/ticker/price?symbol=ETCUSDT'
 *   {"symbol":"ETCUSDT","price":"6.53000000"}
 *
 * All four venues list both assets, so nothing here has to handle a partial listing. The Kraken
 * measurements are on `KRAKEN_KEYS` below, where the surprise is.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * CoinGecko's own coin ids. Verified against `/api/v3/simple/price` on 2026-08-05, and again for
 * `dogecoin` and `ethereum-classic` on 2026-08-08.
 *
 * `ethereum-classic` and not `etc`: CoinGecko ids are slugs, not tickers, and `etc` is a different
 * coin entirely. This is the same class of mistake as building a Coinbase URL out of an asset code.
 */
export const COINGECKO_IDS: Readonly<Partial<Record<AssetCode, string>>> = Object.freeze({
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'ripple',
  LTC: 'litecoin',
  DOGE: 'dogecoin',
  ETC: 'ethereum-classic',
})

/** Coinbase spot products, `<base>-USD`. The base is not always the asset code, so it is stated. */
export const COINBASE_PRODUCTS: Readonly<Partial<Record<AssetCode, string>>> = Object.freeze({
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
  XRP: 'XRP-USD',
  LTC: 'LTC-USD',
  DOGE: 'DOGE-USD',
  ETC: 'ETC-USD',
})

/**
 * The pair Kraken is ASKED for. Distinct from `KRAKEN_KEYS` below, which is what it answers under —
 * Bitcoin is the standing proof that the two differ (`XBTUSD` in, `XXBTZUSD` out).
 *
 * **DOGE IS `XDGUSD` AND NOT `DOGEUSD`.** Kraken's name for Dogecoin is `XDG`, and that is not a
 * legacy X-prefix the way `XXBT` is — it is the ticker. `DOGEUSD` is accepted as a request alias
 * and answers under `XDGUSD` anyway (measured below), so asking by the alias would work and would
 * also leave the response key looking like something that could be derived from the asset code.
 * Asking by the name Kraken actually uses keeps the request and the answer legible together.
 */
export const KRAKEN_PAIRS: Readonly<Partial<Record<AssetCode, string>>> = Object.freeze({
  BTC: 'XBTUSD',
  ETH: 'ETHUSD',
  SOL: 'SOLUSD',
  XRP: 'XRPUSD',
  LTC: 'LTCUSD',
  DOGE: 'XDGUSD',
  ETC: 'ETCUSD',
})

/**
 * Kraken answers under its own legacy asset names rather than the pair that was asked for.
 * Preserved from the old oracle, which discovered this the hard way.
 *
 * LTC is one of the legacy four-letter assets, so it comes back as `XLTCZUSD` and not as the
 * `LTCUSD` it was asked for — confirmed against the live endpoint on 2026-08-05, not assumed from
 * the pattern. `LTCUSD` is kept as a fallback for the same reason the others carry one: Kraken has
 * been migrating off the X/Z prefixes for years and the day it finishes must not be an outage.
 *
 * ── DOGE AND ETC, MEASURED ON 2026-08-08, AND THEY FALL ON OPPOSITE SIDES OF THE PATTERN ───────
 *
 * ETC is the boring one and behaves exactly like LTC — asked as `ETCUSD`, answers as `XETCZUSD`:
 *
 *   $ curl -s 'https://api.kraken.com/0/public/Ticker?pair=ETCUSD'
 *   {"error":[],"result":{"XETCZUSD":{"a":["6.52800000","2","2.000"],…,"c":["6.52800000","5.96443300"],…}}}
 *
 * DOGE IS NOT, AND GUESSING IT FROM ETC'S SHAPE WOULD HAVE PRODUCED A KEY THAT DOES NOT EXIST.
 * Kraken answers under `XDGUSD` — one X, no `Z`, and NOT `XXDGZUSD`, which is a hard error:
 *
 *   $ curl -s 'https://api.kraken.com/0/public/Ticker?pair=XDGUSD'
 *   {"error":[],"result":{"XDGUSD":{"a":["0.070960700",…],…,"c":["0.070960600","14148.69660064"],…}}}
 *   $ curl -s 'https://api.kraken.com/0/public/Ticker?pair=DOGEUSD'
 *   {"error":[],"result":{"XDGUSD":{…}}}                    ← the alias answers under XDGUSD too
 *   $ curl -s 'https://api.kraken.com/0/public/Ticker?pair=XXDGZUSD'
 *   {"error":["EQuery:Unknown asset pair"]}
 *
 * `/0/public/AssetPairs?pair=XDGUSD,ETCUSD` explains the asymmetry and is why the two entries below
 * do not rhyme: DOGE's pair record is `{"altname":"XDGUSD","base":"XXDG","quote":"ZUSD"}` while
 * ETC's is `{"altname":"ETCUSD","base":"XETC","quote":"ZUSD"}`. Both bases carry the legacy `X`,
 * but the CANONICAL PAIR NAME — which is what the ticker keys its result by — kept the prefixed
 * form only for ETC. The response key is a fact about each pair, never a rule about the venue.
 *
 * `DOGEUSD` is DOGE's fallback rather than a second legacy spelling: it is the name Kraken would
 * land on if it ever finishes the migration, and it already resolves as a request today.
 */
export const KRAKEN_KEYS: Readonly<Partial<Record<AssetCode, readonly string[]>>> = Object.freeze({
  BTC: ['XXBTZUSD', 'XBTUSD'],
  ETH: ['XETHZUSD', 'ETHUSD'],
  SOL: ['SOLUSD'],
  XRP: ['XXRPZUSD', 'XRPUSD'],
  LTC: ['XLTCZUSD', 'LTCUSD'],
  DOGE: ['XDGUSD', 'DOGEUSD'],
  ETC: ['XETCZUSD', 'ETCUSD'],
})

/** Binance symbols. Quoted in USDT, not USD — see the note on the source itself. */
export const BINANCE_SYMBOLS: Readonly<Partial<Record<AssetCode, string>>> = Object.freeze({
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  XRP: 'XRPUSDT',
  LTC: 'LTCUSDT',
  DOGE: 'DOGEUSDT',
  ETC: 'ETCUSDT',
})

/**
 * The assets a venue both quotes and we care about, in `MARKET_ASSETS` order.
 *
 * The intersection is the whole point: `MARKET_ASSETS` alone would ask for symbols that may not
 * exist, and the map alone would fetch prices for assets the estate does not hold.
 */
function quoted<T>(
  assets: readonly AssetCode[],
  symbols: Readonly<Partial<Record<AssetCode, T>>>,
): ReadonlyArray<readonly [AssetCode, T]> {
  const out: Array<readonly [AssetCode, T]> = []
  for (const asset of assets) {
    const symbol = symbols[asset]
    if (symbol !== undefined) out.push([asset, symbol] as const)
  }
  return out
}

/* ── the URLs, built from the maps above rather than typed out beside them ─────────────────── */
/* Exported so `sources.test.ts` can drive them over an explicit asset list, which is what lets the
 * Litecoin wiring be proved BEFORE `MARKET_ASSETS` widens — the ordering this release turns on. */

export function coingeckoUrl(assets: readonly AssetCode[]): string {
  const ids = quoted(assets, COINGECKO_IDS).map(([, id]) => id)
  return `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`
}

/**
 * Coinbase is one request per asset, so its "URL" is a LIST of them — and that list is the single
 * most important thing in this file to keep derived rather than interpolated.
 *
 * Returned as pairs, and exported, for one reason: `COINBASE_PRODUCTS['BTC'] === 'BTC-USD'` and the
 * same holds for every asset listed today, so replacing this map with `${asset}-USD` would be
 * INVISIBLE to any test that only drives `MARKET_ASSETS`. The difference appears exactly once — on
 * an asset the venue does not list — which is the case that takes the oracle down. So the selection
 * is testable over an arbitrary asset list, and `sources.test.ts` drives it with one.
 */
export function coinbaseRequests(
  assets: readonly AssetCode[],
): ReadonlyArray<readonly [AssetCode, string]> {
  return quoted(assets, COINBASE_PRODUCTS).map(
    ([asset, product]) => [asset, `https://api.coinbase.com/v2/prices/${product}/spot`] as const,
  )
}

export function krakenUrl(assets: readonly AssetCode[]): string {
  const pairs = quoted(assets, KRAKEN_PAIRS).map(([, pair]) => pair)
  return `https://api.kraken.com/0/public/Ticker?pair=${pairs.join(',')}`
}

export function binanceUrl(assets: readonly AssetCode[]): string {
  const symbols = quoted(assets, BINANCE_SYMBOLS).map(([, symbol]) => symbol)
  // Binance wants a JSON array in the query string. `encodeURIComponent` rather than a hand-written
  // `%5B%22…%22%5D`, which is the same class of hand-encoded literal this block replaced.
  return `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(
    JSON.stringify(symbols),
  )}`
}

export function marketSources(fetchJson: FetchJson): PriceSource[] {
  return [
    {
      name: 'coingecko',
      fetch: async () => {
        const data = (await fetchJson(coingeckoUrl(MARKET_ASSETS))) as Record<
          string,
          { usd?: unknown } | undefined
        >
        return collect(
          quoted(MARKET_ASSETS, COINGECKO_IDS).map(
            ([asset, id]) => [asset, decimalFrom(data[id]?.usd)] as const,
          ),
        )
      },
    },

    {
      name: 'coinbase',
      fetch: async () => {
        // One request per asset, in parallel. A single asset's request failing rejects this
        // source's whole promise, which is correct: a partial answer from one venue is still one
        // opinion, and the round's minimum-source rule is what decides whether losing it matters.
        // What that must never be is a symbol we invented — see the block above `COINGECKO_IDS`.
        const results = await Promise.all(
          coinbaseRequests(MARKET_ASSETS).map(async ([asset, url]) => {
            const data = (await fetchJson(url)) as { data?: { amount?: unknown } }
            return [asset, decimalFrom(data.data?.amount)] as const
          }),
        )
        return collect(results)
      },
    },

    {
      name: 'kraken',
      fetch: async () => {
        const data = (await fetchJson(krakenUrl(MARKET_ASSETS))) as {
          result?: Record<string, { c?: unknown[] } | undefined>
        }
        const result = data.result ?? {}
        return collect(
          quoted(MARKET_ASSETS, KRAKEN_KEYS).map(([asset, keys]) => {
            const hit = keys.map((key) => result[key]).find(Boolean)
            return [asset, decimalFrom(hit?.c?.[0])] as const
          }),
        )
      },
    },

    {
      name: 'binance',
      fetch: async () => {
        // Quoted in USDT, not USD. A depeg shows up as divergence against the other three and
        // takes the whole round out rather than skewing the median — which is the behaviour we
        // want, and the reason the divergence check is a rejection rather than an outlier trim.
        const data = (await fetchJson(binanceUrl(MARKET_ASSETS))) as Array<{
          symbol?: string
          price?: unknown
        }>
        const rows = Array.isArray(data) ? data : []
        return collect(
          quoted(MARKET_ASSETS, BINANCE_SYMBOLS).map(([asset, symbol]) => {
            const row = rows.find((r) => r.symbol === symbol)
            return [asset, decimalFrom(row?.price)] as const
          }),
        )
      },
    },
  ]
}
