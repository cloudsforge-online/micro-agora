/**
 * The four price sources — which, until this file existed, had no test at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS THE FILE THAT MAKES WIDENING THE ASSET SET SAFE, AND IT IS WORTH SAYING WHY.
 *
 * `MARKET_ASSETS` is not a list in this repository. `rates.ts` derives it from `ON_CHAIN_ASSETS`
 * in `@cloudsforge/contracts-chain`, which lives in another repository and is compiled into 27+
 * services. So an edit over there widens the loops in `sources.ts` here, in a deploy that need not
 * mention pricing at all.
 *
 * Before this file, that edit would have taken the oracle down for every asset. `sources.ts` asked
 * Coinbase for `https://api.coinbase.com/v2/prices/<CODE>-USD/spot` built from the asset code
 * itself; `httpFetchJson` throws on any non-200; `Promise.all` rejects on the first rejection. A
 * single unlisted symbol therefore turned into "coinbase answered nothing", and `oracle.ts`
 * counts a source's whole promise, so every OTHER market asset lost a vote too. With
 * `PRICING_MIN_SOURCES` at its default that is not a degradation, it is a rejected round.
 *
 * Two things now stand between that edit and an outage, and the first is the one that matters:
 *
 *   1. **No venue is ever asked for a symbol it has not been told the venue publishes.** An
 *      unmapped asset is skipped, so the worst case is one asset absent from one source — which is
 *      what `collect` and `decideRound` were always built for.
 *   2. **`every market asset is quotable by every source` below goes red** the moment the chain
 *      contract widens without the maps widening with it. Red on a branch, not amber at 3am.
 *
 * No test here touches a live exchange; the transport is injected. Each symbol was checked against
 * the live endpoints once, by hand — the first five on 2026-08-05, DOGE and ETC on 2026-08-08 —
 * and those checks are recorded verbatim in the comments on the maps rather than run in CI: a
 * suite that hits four exchanges is a suite that fails for reasons that have nothing to do with the
 * code. THE COUNT IS DELIBERATELY NOT WRITTEN DOWN HERE. `MARKET_ASSETS` is derived in another
 * repository, so a number in this prose is stale the day it widens, and the guard immediately
 * below is what actually holds the maps to it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AssetCode } from '@cloudsforge/contracts-chain'
import { MARKET_ASSETS } from './rates.ts'
import {
  BINANCE_SYMBOLS,
  COINBASE_PRODUCTS,
  COINGECKO_IDS,
  KRAKEN_KEYS,
  KRAKEN_PAIRS,
  binanceUrl,
  coinbaseRequests,
  coingeckoUrl,
  decimalFrom,
  httpFetchJson,
  krakenUrl,
  marketSources,
  type FetchJson,
} from './sources.ts'

/* ───────────────────────────────── the drift guard ───────────────────────────────── */

test('THE ORDERING GUARD: every market asset has a symbol at every one of the four venues', () => {
  // If this fails, an asset was added to `ON_CHAIN_ASSETS` in micro-contracts without a price
  // source. DO NOT fix it by deleting the asset from the assertion. Either wire the symbol into
  // the map named in the failure, or take the asset back out of `ON_CHAIN_ASSETS` until it can be
  // priced — those are the only two honest answers, and `contracts/packages/chain/src/index.ts`
  // says so above `ON_CHAIN_ASSETS` itself.
  for (const asset of MARKET_ASSETS) {
    assert.ok(COINGECKO_IDS[asset], `${asset} has no CoinGecko id`)
    assert.ok(COINBASE_PRODUCTS[asset], `${asset} has no Coinbase product`)
    assert.ok(KRAKEN_PAIRS[asset], `${asset} has no Kraken pair to ask for`)
    assert.ok(KRAKEN_KEYS[asset]?.length, `${asset} has no Kraken response key`)
    assert.ok(BINANCE_SYMBOLS[asset], `${asset} has no Binance symbol`)
  }
  assert.ok(MARKET_ASSETS.length > 0, 'a vacuous guard is not a guard')
})

test('LITECOIN WAS QUOTABLE BEFORE IT WAS LISTED, which is the ordering every asset follows', () => {
  // Wired ahead of `ON_CHAIN_ASSETS`, deliberately: a missing quote is recoverable and a rejected
  // source is an outage, so the source comes first and the listing second. These four assertions
  // are what "first" means, and they were red until the maps in `sources.ts` were widened.
  assert.equal(COINGECKO_IDS['LTC'], 'litecoin')
  assert.equal(COINBASE_PRODUCTS['LTC'], 'LTC-USD')
  assert.equal(KRAKEN_PAIRS['LTC'], 'LTCUSD')
  assert.equal(BINANCE_SYMBOLS['LTC'], 'LTCUSDT')
  // Kraken answers under its legacy name, which is NOT the pair it was asked for. Checked against
  // the live endpoint rather than inferred from BTC's shape.
  assert.deepEqual([...(KRAKEN_KEYS['LTC'] ?? [])], ['XLTCZUSD', 'LTCUSD'])
})

test('DOGE AND ETC WERE QUOTABLE BEFORE THEY WERE NAMEABLE — the same ordering, one asset set later', () => {
  // `contracts/packages/chain/src/index.ts` above `ON_CHAIN_ASSETS`: "add the price source and
  // prove it against the live venues; then add the member here". These assertions are what "prove"
  // means. They were written while `AssetCode` named neither code and were inert against the
  // running estate, because `quoted()` intersects with `MARKET_ASSETS`.
  //
  // THE CASTS THIS TEST USED TO GO THROUGH ARE GONE, which is the point of the edit that removed
  // them. A `byName()` helper widened each map to `Record<string, unknown>` so the lookups would
  // compile against a union that did not yet contain `DOGE`; its own doc block said to delete it
  // the moment micro-contracts widened. Read on 2026-08-09, `AssetCode` names both, so the lookups
  // below are ordinary indexing again — and a typo in an asset code here is now a COMPILE ERROR
  // rather than an assertion quietly comparing `undefined` against `undefined` and passing.
  // Checked, not assumed: misspelling one code as `DOGEE` on 2026-08-09 fails `pnpm typecheck` with
  // TS2551, "Property 'DOGEE' does not exist on type Readonly<Partial<Record<AssetCode, string>>>".
  // Under the cast it compiled and the test still passed, which is the failure mode being removed.
  //
  // Every symbol below was measured against the live endpoint on 2026-08-08, with the verbatim
  // responses recorded on the maps in `sources.ts`. None of them was inferred from another asset's
  // shape, because that is the mistake the Kraken entries exist to demonstrate.
  for (const [asset, expected] of [
    ['DOGE', { gecko: 'dogecoin', coinbase: 'DOGE-USD', pair: 'XDGUSD', binance: 'DOGEUSDT' }],
    ['ETC', { gecko: 'ethereum-classic', coinbase: 'ETC-USD', pair: 'ETCUSD', binance: 'ETCUSDT' }],
  ] as const) {
    assert.equal(COINGECKO_IDS[asset], expected.gecko, `${asset} CoinGecko id`)
    assert.equal(COINBASE_PRODUCTS[asset], expected.coinbase, `${asset} Coinbase product`)
    assert.equal(KRAKEN_PAIRS[asset], expected.pair, `${asset} Kraken pair`)
    assert.equal(BINANCE_SYMBOLS[asset], expected.binance, `${asset} Binance symbol`)
  }

  // And they are no longer inert: both are members of the set the oracle actually requests. If this
  // fails, `ON_CHAIN_ASSETS` lost an asset the estate settles on — see `rates.test.ts` for the
  // partition that owns that question.
  assert.ok(MARKET_ASSETS.includes('DOGE'), 'DOGE is wired but not requested')
  assert.ok(MARKET_ASSETS.includes('ETC'), 'ETC is wired but not requested')

  // KRAKEN IS THE ONE THAT HAD TO BE MEASURED TWICE, and these two lines are why the measurement
  // is not optional. ETC follows LTC's legacy pattern — asked `ETCUSD`, answers `XETCZUSD`. DOGE
  // does not follow it at all: Kraken's ticker for Dogecoin is `XDG`, the canonical pair is
  // `XDGUSD`, and `XXDGZUSD` — the key a reader who had just written ETC's entry would type — is
  // `EQuery:Unknown asset pair`. A guessed key here is not a compile error and not a 404; it is a
  // source that silently answers nothing for one asset, for ever.
  assert.deepEqual([...(KRAKEN_KEYS['DOGE'] ?? [])], ['XDGUSD', 'DOGEUSD'])
  assert.deepEqual([...(KRAKEN_KEYS['ETC'] ?? [])], ['XETCZUSD', 'ETCUSD'])
  assert.notDeepEqual([...(KRAKEN_KEYS['DOGE'] ?? [])], ['XXDGZUSD', 'DOGEUSD'])
})

/* ─────────────────────────────── the URLs, now derived ─────────────────────────────── */

test('a URL carries exactly the assets it was given, in order, and nothing it was not', () => {
  const two: readonly AssetCode[] = ['BTC', 'LTC']
  assert.equal(
    coingeckoUrl(two),
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,litecoin&vs_currencies=usd',
  )
  assert.equal(krakenUrl(two), 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD,LTCUSD')
  assert.equal(
    binanceUrl(two),
    'https://api.binance.com/api/v3/ticker/price?symbols=%5B%22BTCUSDT%22%2C%22LTCUSDT%22%5D',
  )
})

test('an asset with no symbol at a venue is SKIPPED, never spelled into the URL', () => {
  // EMBER is the real instance of this and not a hypothetical: it is administered — Hearth has no
  // listing — so it is absent from `MARKET_ASSETS` and from all four maps. SHARD is retired. If a
  // future edit routed either into a source, this is where it would be caught.
  const withUnlisted: readonly AssetCode[] = ['BTC', 'EMBER', 'SHARD', 'LTC']
  assert.ok(!coingeckoUrl(withUnlisted).includes('EMBER'))
  assert.ok(!coingeckoUrl(withUnlisted).includes('undefined'))
  assert.equal(coingeckoUrl(withUnlisted), coingeckoUrl(['BTC', 'LTC']))
  assert.equal(krakenUrl(withUnlisted), krakenUrl(['BTC', 'LTC']))
  assert.equal(binanceUrl(withUnlisted), binanceUrl(['BTC', 'LTC']))
})

test('COINBASE ASKS ONLY FOR PRODUCTS IT PUBLISHES — the one that would have caused the outage', () => {
  // Every asset listed today satisfies `COINBASE_PRODUCTS[a] === `${a}-USD``, so this is the ONLY
  // assertion in the suite that can tell the map apart from the string interpolation it replaced.
  // Drop it and the hazard comes back silently.
  assert.deepEqual(coinbaseRequests(['BTC', 'EMBER', 'SHARD', 'LTC']), [
    ['BTC', 'https://api.coinbase.com/v2/prices/BTC-USD/spot'],
    ['LTC', 'https://api.coinbase.com/v2/prices/LTC-USD/spot'],
  ])
  assert.deepEqual(coinbaseRequests(['EMBER']), [], 'an unlisted asset is not a request at all')
})

test("Binance's JSON-array query survives a round trip, rather than being hand-encoded", () => {
  const parsed = new URL(binanceUrl(['BTC', 'LTC'])).searchParams.get('symbols')
  assert.deepEqual(JSON.parse(parsed ?? ''), ['BTCUSDT', 'LTCUSDT'])
})

/* ─────────────────────── the sources, over an injected transport ─────────────────────── */

/**
 * Every venue's happy answer for whatever `MARKET_ASSETS` currently holds, at a known price.
 *
 * **DOGE AND ETC ARE HERE AHEAD OF `MARKET_ASSETS`, AND WITHOUT THEM THIS SUITE WOULD GO RED THE
 * MOMENT MICRO-CONTRACTS MERGES.** That is not hypothetical and it is the second half of what
 * "make the pricing change safe to merge on its own" has to mean. `every source quotes EVERY
 * market asset` below ends with `assert.deepEqual(Object.keys(quotes).sort(), MARKET_ASSETS)`, and
 * `MARKET_ASSETS` is derived from `ON_CHAIN_ASSETS` in another repository. An asset that widens
 * that list while absent from this fixture reads as `undefined` here, `decimalFrom` refuses it,
 * `collect` leaves it out, and the key comparison fails — a red suite in micro-pricing caused
 * entirely by a merge in micro-contracts, which is precisely the cross-repo surprise the maps in
 * `sources.ts` were built to stop. The fixture has to widen with them, in the same PR.
 *
 * The two new numbers are the live mid-prices measured on 2026-08-08 (recorded verbatim on the
 * maps in `sources.ts`) rather than invented ones, and both round-trip exactly through the double
 * that the CoinGecko fake puts them through.
 */
const PRICE: Readonly<Record<string, string>> = Object.freeze({
  BTC: '63969.01',
  ETH: '1865.42',
  SOL: '73.53',
  XRP: '1.071',
  LTC: '44.95',
  DOGE: '0.07096',
  ETC: '6.53',
})

function fakeVenues(overrides: { readonly reject?: (url: string) => boolean } = {}): FetchJson {
  return async (url: string) => {
    if (overrides.reject?.(url)) throw new Error(`404 from ${new URL(url).host}`)
    const host = new URL(url).host
    if (host === 'api.coingecko.com') {
      const ids = new URL(url).searchParams.get('ids')?.split(',') ?? []
      const byId = Object.fromEntries(
        Object.entries(COINGECKO_IDS).map(([asset, id]) => [id, asset]),
      )
      return Object.fromEntries(
        ids.map((id) => [id, { usd: Number(PRICE[byId[id] ?? ''] ?? '0') }]),
      )
    }
    if (host === 'api.coinbase.com') {
      const base = /\/prices\/([A-Z]+)-USD\/spot$/.exec(new URL(url).pathname)?.[1]
      assert.ok(base, `coinbase was asked for a product it does not publish: ${url}`)
      return { data: { amount: PRICE[base], base, currency: 'USD' } }
    }
    if (host === 'api.kraken.com') {
      const pairs = new URL(url).searchParams.get('pair')?.split(',') ?? []
      const byPair = Object.fromEntries(
        Object.entries(KRAKEN_PAIRS).map(([asset, pair]) => [pair, asset]),
      )
      // Answers under the LEGACY key — the first entry of `KRAKEN_KEYS` — never the pair asked
      // for. A fake that echoed the request back would pass while the real mapping was wrong.
      return {
        error: [],
        result: Object.fromEntries(
          pairs.map((pair) => {
            const asset = byPair[pair] ?? ''
            return [KRAKEN_KEYS[asset as AssetCode]?.[0] ?? pair, { c: [PRICE[asset], '1.0'] }]
          }),
        ),
      }
    }
    if (host === 'api.binance.com') {
      const symbols = JSON.parse(new URL(url).searchParams.get('symbols') ?? '[]') as string[]
      const bySymbol = Object.fromEntries(
        Object.entries(BINANCE_SYMBOLS).map(([asset, symbol]) => [symbol, asset]),
      )
      return symbols.map((symbol) => ({ symbol, price: PRICE[bySymbol[symbol] ?? ''] }))
    }
    throw new Error(`unexpected host ${host}`)
  }
}

test('every source quotes EVERY market asset, and the number it returns is the venue’s', async () => {
  const sources = marketSources(fakeVenues())
  assert.deepEqual(
    sources.map((s) => s.name),
    ['coingecko', 'coinbase', 'kraken', 'binance'],
  )
  for (const source of sources) {
    const quotes = await source.fetch()
    for (const asset of MARKET_ASSETS) {
      assert.equal(quotes[asset], PRICE[asset], `${source.name} did not quote ${asset}`)
    }
    // And nothing it was not asked about: an administered asset picking up a market quote would
    // silently replace an operator-set EMBER price with an exchange's opinion of nothing.
    assert.deepEqual(Object.keys(quotes).sort(), [...MARKET_ASSETS].sort())
  }
})

test('THE HAZARD, pinned: one failed request costs Coinbase the WHOLE source, not one asset', async () => {
  // This behaviour is deliberate and unchanged — see the note on the source. It is pinned here
  // because it is the reason the symbol maps had to exist: under it, one unlisted asset is not a
  // gap in one row, it is four assets losing a vote at once.
  const sources = marketSources(fakeVenues({ reject: (url) => url.includes('/BTC-USD/') }))
  const coinbase = sources.find((s) => s.name === 'coinbase')
  assert.ok(coinbase)
  await assert.rejects(() => coinbase.fetch(), /404 from api\.coinbase\.com/)

  // And the blast radius stops at that source: the other three still answer in full, which is what
  // `Promise.allSettled` in `oracle.ts` is for.
  for (const other of sources.filter((s) => s.name !== 'coinbase')) {
    const quotes = await other.fetch()
    for (const asset of MARKET_ASSETS) assert.equal(quotes[asset], PRICE[asset])
  }
})

test('a venue that omits an asset leaves it ABSENT rather than zero or NaN', async () => {
  const halfAnswer: FetchJson = async () => ({})
  const coingecko = marketSources(halfAnswer).find((s) => s.name === 'coingecko')
  assert.ok(coingecko)
  assert.deepEqual(await coingecko.fetch(), {})

  const binanceEmpty: FetchJson = async () => []
  const binance = marketSources(binanceEmpty).find((s) => s.name === 'binance')
  assert.ok(binance)
  assert.deepEqual(await binance.fetch(), {})
})

/* ───────────────────────────────── decimalFrom ───────────────────────────────── */

test('a decimal STRING is used verbatim, so a venue’s own precision survives', () => {
  assert.equal(decimalFrom('44.96500000'), '44.96500000')
  assert.equal(decimalFrom('  45.01  '), '45.01')
  assert.equal(decimalFrom(''), undefined)
  assert.equal(decimalFrom('   '), undefined)
})

test('a JSON number is rendered, not re-rounded — and a non-price is refused', () => {
  // CoinGecko is the only one of the four that quotes as a number, so the loss it carries happened
  // inside `JSON.parse` before this function could see it. What must NOT happen is a second
  // rounding on top, which is what the old oracle's `Math.floor(usd * 1e6)` added.
  assert.equal(decimalFrom(44.95), '44.95')
  assert.equal(decimalFrom(0), undefined, 'a zero price is not a price')
  assert.equal(decimalFrom(-1), undefined)
  assert.equal(decimalFrom(Number.NaN), undefined)
  assert.equal(decimalFrom(Number.POSITIVE_INFINITY), undefined)
  assert.equal(decimalFrom(null), undefined)
  assert.equal(decimalFrom(undefined), undefined)
  assert.equal(decimalFrom({ usd: 1 }), undefined)
})

test('the transport turns any non-200 into a throw, which is what makes a source fail closed', async () => {
  // Named here rather than only in `sources.ts` because it is half of the Coinbase hazard: without
  // it a 404 body would be parsed as a quote.
  const fetchJson = httpFetchJson(50)
  await assert.rejects(() => fetchJson('http://127.0.0.1:1/nothing'))
})
