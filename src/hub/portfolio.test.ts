/**
 * Valuation. Every number here is checked exactly, because "roughly right" is not a property a
 * portfolio may have.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOCATION_ROWS, HEADLINE_COINS, composePortfolio } from './portfolio.ts'
import type { LedgerBalance, PricingRate } from './upstreams.ts'

const balance = (
  assetCode: string,
  amount: string,
  purpose = 'available',
): LedgerBalance => ({
  accountId: `${assetCode}-${purpose}`,
  subject: 'user:u1',
  assetCode: assetCode as LedgerBalance['assetCode'],
  purpose,
  type: 'liability',
  status: 'open',
  amount,
  asOfEntryId: null,
  updatedAt: null,
})

const rate = (asset: string, usdScaled: string | null, quotedAt: string, usable = true): PricingRate => ({
  asset: asset as PricingRate['asset'],
  source: 'market',
  usable,
  quotedAt,
  ageSeconds: 0,
  usdScaled,
  usd: null,
  ...(usable ? {} : { reason: 'quote is stale' }),
})

test('an 18-decimal amount is valued without losing a digit', () => {
  // 1.234567890123456789 ETH at $3,000.000001. A double would round this in exactly the least
  // significant digits, which is where a reconciliation drift shows up.
  const view = composePortfolio(
    [balance('ETH', '1234567890123456789')],
    [rate('ETH', '3000000001', '2026-07-30T14:00:00.000Z')],
  )
  // 1234567890123456789 × 3000000001 ÷ 10^18, truncated — every digit of the 19-digit amount and
  // the 10-digit rate participates. The same sum in a double loses the last four.
  assert.equal(view.holdings[0]?.usdScaled, '3703703671')
  assert.equal(view.totalUsd, '3703.703671')
})

test('Shards are valued from the contract, not from a quote', () => {
  // 100 Shards = 1 USD, fixed. Asking pricing would invite an answer that could disagree with the
  // constant every purchase in the estate is denominated against.
  const view = composePortfolio([balance('SHARD', '12480')], [])
  assert.equal(view.totalUsd, '124.8')
  assert.equal(view.pricingComplete, true, 'a fixed rate is not a missing rate')
  assert.equal(view.pricedAt, null, 'a contract constant has no observation time')
  // Still a holding, still counted, still in the total — a retired asset is not a hidden one.
  assert.deepEqual(
    view.holdings.map((holding) => holding.assetCode),
    ['SHARD'],
  )
  // But no tile of its own. Nothing may be newly denominated in SHARD, so promoting it to the
  // headline row would be offering the reader a currency they cannot be paid in again.
  assert.deepEqual(
    view.coins.map((coin) => coin.assetCode),
    ['EMBER'],
  )
})

test('USD is held as cents', () => {
  const view = composePortfolio([balance('USD', '1999')], [])
  assert.equal(view.totalUsd, '19.99')
})

test('the pricing timestamp is the oldest contributing observation', () => {
  const view = composePortfolio(
    [balance('BTC', '100000000'), balance('ETH', '1000000000000000000')],
    [
      rate('BTC', '60000000000', '2026-07-30T14:20:00.000Z'),
      rate('ETH', '3000000000', '2026-07-30T14:25:00.000Z'),
    ],
  )
  // Reporting 14:25 would overstate the confidence of the total, which is the one number a user
  // reads. `holdings[].quotedAt` still carries each quote's own instant.
  assert.equal(view.pricedAt, '2026-07-30T14:20:00.000Z')
})

test('an unpriced holding is shown, excluded from the total, and flagged', () => {
  const view = composePortfolio(
    [balance('BTC', '100000000'), balance('XRP', '1000000')],
    [rate('BTC', '60000000000', '2026-07-30T14:20:00.000Z'), rate('XRP', null, '2026-07-30T14:00:00.000Z', false)],
  )
  assert.equal(view.pricingComplete, false)
  assert.equal(view.totalUsd, '60000', 'an unpriced holding is dropped, never counted as zero')
  const xrp = view.holdings.find((holding) => holding.assetCode === 'XRP')
  assert.equal(xrp?.usd, null)
  assert.equal(xrp?.priceReason, 'quote is stale')
  assert.equal(xrp?.amountFormatted, '1', 'the amount is still known even when the value is not')
})

test('a minted token is shown without a value or a formatted amount', () => {
  // Decimals are chosen at deploy time and nothing in this fan-out knows them. Guessing 18 would
  // render a six-decimal token a trillion times over.
  const view = composePortfolio([balance('TOKEN:cf:mint:token:1', '5000')], [])
  const token = view.holdings[0]
  assert.equal(token?.usd, null)
  assert.equal(token?.amountFormatted, null)
  assert.equal(token?.priceReason, 'no price source for a minted token')
  assert.equal(view.pricingComplete, false)
})

test('purposes are summed, and available and reserved stay separable', () => {
  const view = composePortfolio(
    [balance('EMBER', '3000000000000000000'), balance('EMBER', '1000000000000000000', 'reserved')],
    [rate('EMBER', '2000000', '2026-07-30T14:00:00.000Z')],
  )
  const ember = view.holdings[0]
  assert.equal(ember?.amountFormatted, '4', 'the portfolio total is every purpose')
  assert.equal(ember?.available, '3000000000000000000')
  assert.equal(ember?.reserved, '1000000000000000000')
  assert.equal(view.totalUsd, '8')
})

test('HOW a holding was priced travels with it, verbatim from pricing', () => {
  // EMBER has no exchange listing, so pricing answers `administered` for it and `market` for
  // everything else (`pricing/src/rates.ts`). Both words arrive here and both must leave, because
  // the screen that prints "$12,480.00" beside EMBER has no other way to know that no venue has
  // ever quoted it. Asserted as a PAIR: a field hard-wired to either constant would satisfy one of
  // these two lines and fail the other.
  const view = composePortfolio(
    [balance('EMBER', '1000000000000000000'), balance('BTC', '100000000')],
    [
      { ...rate('EMBER', '100', '2026-07-30T14:00:00.000Z'), source: 'administered' },
      rate('BTC', '60000000000', '2026-07-30T14:00:00.000Z'),
    ],
  )
  assert.equal(view.holdings.find((h) => h.assetCode === 'EMBER')?.priceSource, 'administered')
  assert.equal(view.holdings.find((h) => h.assetCode === 'BTC')?.priceSource, 'market')
})

test('a holding no quote produced carries no source, so "no note needed" cannot be faked', () => {
  // Null must mean "nothing here needs qualifying", never "we did not look". SHARD and USD are
  // fixed by contract, a minted token has no oracle, and an unpriced holding has no figure at all —
  // if any of them reported a source, a client would qualify a number pricing never touched.
  const view = composePortfolio(
    [
      balance('SHARD', '100'),
      balance('USD', '1999'),
      balance('TOKEN:cf:mint:token:1', '5000'),
      balance('XRP', '1000000'),
    ],
    [rate('XRP', null, '2026-07-30T14:00:00.000Z', false)],
  )
  for (const asset of ['SHARD', 'USD', 'TOKEN:cf:mint:token:1', 'XRP']) {
    assert.equal(
      view.holdings.find((h) => h.assetCode === asset)?.priceSource,
      null,
      `${asset} reported a price source without a pricing quote behind it`,
    )
  }
})

test('a zero balance is not a holding', () => {
  const view = composePortfolio([balance('BTC', '0')], [])
  assert.deepEqual(view.holdings, [])
  assert.deepEqual(view.allocation, [])
})

test('holdings are sorted by value with unpriced last, and the order is stable', () => {
  const view = composePortfolio(
    [balance('SHARD', '100'), balance('BTC', '100000000'), balance('XRP', '1000000')],
    [rate('BTC', '60000000000', '2026-07-30T14:00:00.000Z')],
  )
  assert.deepEqual(
    view.holdings.map((holding) => holding.assetCode),
    ['BTC', 'SHARD', 'XRP'],
  )
})

test('allocation is sorted, direct-labelled and in basis points', () => {
  // §6 rule 6: sorted horizontal bars with direct labels, never a pie. One whole unit of each of
  // the five quoted coins at $1, so the values are equal and the ordering is by asset code — which
  // is the tie-break that keeps a dashboard from flickering between two identical loads.
  const assets = ['BTC', 'ETH', 'EMBER', 'SOL', 'XRP'] as const
  const decimals = { BTC: 8, ETH: 18, EMBER: 18, SOL: 9, XRP: 6 } as const
  const balances = assets.map((asset) => balance(asset, (10n ** BigInt(decimals[asset])).toString()))
  const rates = assets.map((asset) => rate(asset, '1000000', '2026-07-30T14:00:00.000Z'))
  const view = composePortfolio([...balances, balance('SHARD', '100')], rates)

  assert.equal(view.allocation.length, 6)
  assert.deepEqual(
    view.allocation.map((row) => row.label),
    ['BTC', 'EMBER', 'ETH', 'SHARD', 'SOL', 'XRP'],
  )
  const total = view.allocation.reduce((sum, row) => sum + row.bps, 0)
  assert.ok(total <= 10_000 && total > 9_900, `basis points should sum to ~10000, got ${total}`)

  // No "Other" bucket: the estate quotes five coins plus Shards and USD, which is fewer than the
  // eight rows the fold begins at. The constant exists for the day the mint service makes minted
  // tokens priceable, and until then this asserts the tail is simply absent.
  assert.ok(view.allocation.length <= ALLOCATION_ROWS)
  assert.ok(!view.allocation.some((row) => row.label === 'Other'))
})

test('a malformed amount costs one row, not the tile', () => {
  const rows = [balance('BTC', 'not-a-number'), balance('SHARD', '100')]
  const view = composePortfolio(rows, [])
  assert.deepEqual(
    view.holdings.map((holding) => holding.assetCode),
    ['SHARD'],
  )
  assert.equal(view.totalUsd, '1')
})

test('no prices at all still produces a full holdings list', () => {
  // The pricing-is-down path, which must never throw.
  const view = composePortfolio([balance('BTC', '100000000'), balance('EMBER', '1000000000000000000')], [])
  assert.equal(view.holdings.length, 2)
  assert.equal(view.totalUsd, '0')
  assert.equal(view.pricingComplete, false)
  assert.deepEqual(view.coins[0], {
    assetCode: 'EMBER',
    amount: '1000000000000000000',
    amountFormatted: '1',
  })
})

test('the headline coins are EMBER first, then what is actually held, largest first', () => {
  const view = composePortfolio(
    [
      balance('EMBER', '1000000000000000000'),
      balance('BTC', '100000000'),
      balance('LTC', '500000000'),
      balance('DOGE', '100000000000'),
    ],
    [
      rate('EMBER', '1000000', '2026-07-30T14:00:00.000Z'),
      rate('BTC', '60000000000', '2026-07-30T14:00:00.000Z'),
      rate('LTC', '80000000', '2026-07-30T14:00:00.000Z'),
      rate('DOGE', '200000', '2026-07-30T14:00:00.000Z'),
    ],
  )
  // BTC $600, LTC $4, DOGE $2, EMBER $1 — but EMBER leads regardless of what it is worth, because
  // it is this platform's own chain and the row must not change shape between accounts.
  assert.deepEqual(
    view.coins.map((coin) => coin.assetCode),
    ['EMBER', 'BTC', 'LTC'],
  )
  assert.equal(view.coins.length, HEADLINE_COINS)
  // Every figure is the asset's own decimals, not a shared guess: BTC has 8, LTC has 8.
  assert.equal(view.coins[1]?.amountFormatted, '1')
  assert.equal(view.coins[2]?.amountFormatted, '5')
})

test('a minted token and USD are held, and neither becomes a coin tile', () => {
  // A `TOKEN:` asset has no published decimals in this fan-out, so there is no honest way to place
  // the point in a headline figure; USD is the unit "Total held" is already in.
  const view = composePortfolio(
    [balance('TOKEN:ember:0xabc' as never, '5000'), balance('USD', '1999')],
    [],
  )
  assert.deepEqual(
    view.coins.map((coin) => coin.assetCode),
    ['EMBER'],
  )
  assert.equal(view.coins[0]?.amountFormatted, '0', 'EMBER leads even when nothing is in it')
  assert.equal(view.holdings.length, 2, 'both are still holdings')
})
