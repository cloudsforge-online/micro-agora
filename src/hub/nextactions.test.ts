/**
 * The "needs you" cards, as pure functions over tiles.
 *
 * The dashboard suite proves they degrade over real sockets. This one proves the rules: a verb on
 * every card, a stable id, an ordering that does not shuffle, and — the one that matters — an
 * absent card rather than a broken one when its source is down (§6 rule 2).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAINS, RETIRED_ASSETS } from '@cloudsforge/contracts-chain'
import { buildNextActions, type NextActionInputs } from './nextactions.ts'
import { okTile, unavailableTile, type Tile } from './tiles.ts'
import type {
  BillingSubscription,
  DepositCredit,
  PolicyFreeze,
  WithdrawalRecord,
} from './upstreams.ts'

const deposit = (over: Partial<DepositCredit> = {}): DepositCredit => ({
  id: 'd1',
  assetCode: 'EMBER',
  amount: '500000000000000000',
  amountFormatted: '0.5',
  chain: 'EMBER',
  network: 'mainnet',
  txHash: '0xabc',
  txUrn: 'cf:chain:ember:mainnet:0xabc',
  explorerUrl: null,
  confirmations: 41,
  credited: false,
  ...over,
})

const withdrawal = (over: Partial<WithdrawalRecord> = {}): WithdrawalRecord => ({
  id: 'x1',
  userId: 'u1',
  chain: 'BTC',
  network: 'mainnet',
  assetCode: 'BTC',
  destination: 'bc1q',
  amount: '20000000',
  amountFormatted: '0.2',
  fee: '0',
  net: '20000000',
  netFormatted: '0.2',
  state: 'stuck',
  txHash: null,
  failureReason: 'broadcast accepted, no confirmation after 6 hours',
  requestedAt: '2026-07-30T06:00:00.000Z',
  updatedAt: '2026-07-30T12:00:00.000Z',
  ...over,
})

const freeze = (over: Partial<PolicyFreeze> = {}): PolicyFreeze => ({
  id: 'f1',
  subject: 'user:u1',
  scope: 'withdrawal',
  reason: 'reconciliation drift exceeded',
  createdAt: '2026-07-30T09:00:00.000Z',
  clearedAt: null,
  clearancesRequired: 2,
  ...over,
})

const subscription = (over: Partial<BillingSubscription> = {}): BillingSubscription => ({
  id: 'sub1',
  productId: 'p1',
  status: 'past_due',
  currentPeriodEnd: null,
  cancelAt: null,
  scope: 'platform',
  confersAccess: true,
  ...over,
})

function inputs(over: Partial<NextActionInputs> = {}): NextActionInputs {
  return {
    deposits: okTile('wallet', [] as readonly DepositCredit[]),
    withdrawals: okTile('wallet', [] as readonly WithdrawalRecord[]),
    // A healthy account by default — MFA on, codes in hand — so that a test asserting on one card
    // is not silently also asserting on the security card.
    factors: okTile('identity', { factors: [{ status: 'active' }], recoveryCodesRemaining: 10 }),
    freezes: okTile('policy', [] as readonly PolicyFreeze[]),
    subscriptions: okTile('billing', [] as readonly BillingSubscription[]),
    ...over,
  }
}

test('an unconfirmed deposit becomes a card with its progress against the contract depth', () => {
  const { actions } = buildNextActions(inputs({ deposits: okTile('wallet', [deposit()]) }))
  const card = actions[0]
  assert.equal(card?.kind, 'deposit_confirming')
  assert.equal(card?.verb, 'Track')
  assert.equal(card?.href, '/wallet/deposits/d1')
  // 60 is EMBER's confirmation depth in contracts-chain — the same constant wallet and settlement
  // credit against, never a number this service chose.
  assert.deepEqual(card?.progress, { done: 41, total: 60, etaMinutes: 5 })
})

test('EVERY ASSET THE ESTATE CREDITS GETS AN ETA — no asset is silently skipped', () => {
  // The defect this branch fixes, asserted over the registry rather than over the three assets that
  // happened to be missing. `BLOCK_SECONDS` here was a `Partial<Record<AssetCode, number>>` with
  // five rows — the five assets that existed when it was typed — so LTC, DOGE and ETC each arrived
  // in `AssetCode` and got no estimate, with nothing anywhere reporting it. Naming those three in a
  // test would fix this week and re-arm the trap for the next asset, exactly as the depth test at
  // the foot of this file already had to learn (micro-contracts 63a0bc4 broke it by giving DOGE a
  // depth). Driving the loop off `CHAINS` means a sixth, seventh or eighth asset is covered the day
  // it merges, without anybody remembering this file exists.
  for (const [assetCode, spec] of Object.entries(CHAINS)) {
    if (spec.confirmations === 0) continue // SHARD is retired; it cannot produce a deposit.
    const { actions } = buildNextActions(
      inputs({ deposits: okTile('wallet', [deposit({ assetCode, confirmations: 0 })]) }),
    )
    const progress = actions[0]?.progress
    assert.equal(progress?.total, spec.confirmations, `${assetCode} lost its depth`)
    assert.ok(
      typeof progress?.etaMinutes === 'number' && progress.etaMinutes > 0,
      `${assetCode} shows a confirmation count with no wait beside it`,
    )
  }
})

test('the asset with the longest wait is the one that used to show no wait at all', () => {
  // ETC credits at 7,500 confirmations — an anti-reorg depth — so a fresh ETC deposit is over a day
  // away, and it was one of the three assets absent from the table this branch deleted. The asset
  // whose estimate mattered most was the asset with no estimate. Asserted as a band rather than an
  // exact figure: `blockSeconds` for ETC is a measurement and is expected to be re-measured, while
  // "an ETC deposit takes the better part of two days" is the claim the card has to keep making.
  const { actions } = buildNextActions(
    inputs({ deposits: okTile('wallet', [deposit({ assetCode: 'ETC', confirmations: 0 })]) }),
  )
  const eta = actions[0]?.progress?.etaMinutes
  assert.ok(typeof eta === 'number')
  assert.ok(eta > 24 * 60, `an ETC deposit is a day-long wait; this card says ${eta} minutes`)
})

test('the block time comes from the chain spec, not from a table in this service', () => {
  // The point of the change, stated as arithmetic a reader can check by hand: an estimate derived
  // from a number this file no longer owns. If a future edit reintroduces a local table, this stays
  // green only for as long as the copy agrees with contracts-chain — which is the failure mode it
  // is written to catch, so the expectation is COMPUTED from the spec rather than written out.
  const spec = CHAINS.EMBER
  assert.notEqual(spec.blockSeconds, null, 'EMBER is an on-chain asset and must publish a block time')
  const { actions } = buildNextActions(
    inputs({ deposits: okTile('wallet', [deposit({ confirmations: 41 })]) }),
  )
  assert.deepEqual(actions[0]?.progress, {
    done: 41,
    total: spec.confirmations,
    etaMinutes: Math.ceil(((spec.confirmations - 41) * (spec.blockSeconds ?? 0)) / 60),
  })
})

test('a credited deposit raises nothing', () => {
  const { actions } = buildNextActions(
    inputs({ deposits: okTile('wallet', [deposit({ credited: true })]) }),
  )
  assert.deepEqual(actions, [])
})

test('only a stuck withdrawal raises a card, and it is critical', () => {
  // `stuck` is the only non-terminal failure state: the reservation is held and the payment's fate
  // is unknown, so the money is neither the user's nor gone.
  const { actions } = buildNextActions(
    inputs({
      withdrawals: okTile('wallet', [
        withdrawal(),
        withdrawal({ id: 'x2', state: 'settling' }),
        withdrawal({ id: 'x3', state: 'settled' }),
      ]),
    }),
  )
  assert.equal(actions.length, 1)
  assert.equal(actions[0]?.id, 'withdrawal_stuck:x1')
  assert.equal(actions[0]?.severity, 'critical')
})

test('no active factor raises the 2FA card', () => {
  const { actions } = buildNextActions(
    inputs({ factors: okTile('identity', { factors: [{ status: 'pending' }], recoveryCodesRemaining: 8 }) }),
  )
  assert.equal(actions[0]?.kind, 'mfa_disabled')
  assert.equal(actions[0]?.verb, 'Enable')
})

test('low recovery codes are raised only once MFA is actually on', () => {
  // Two cards competing for one action would let the wrong one win.
  const off = buildNextActions(
    inputs({ factors: okTile('identity', { factors: [], recoveryCodesRemaining: 0 }) }),
  )
  assert.deepEqual(off.actions.map((a) => a.kind), ['mfa_disabled'])

  const on = buildNextActions(
    inputs({ factors: okTile('identity', { factors: [{ status: 'active' }], recoveryCodesRemaining: 1 }) }),
  )
  assert.deepEqual(on.actions.map((a) => a.kind), ['recovery_codes_low'])
})

test('a cleared freeze raises nothing', () => {
  const { actions } = buildNextActions(
    inputs({ freezes: okTile('policy', [freeze({ clearedAt: '2026-07-30T10:00:00.000Z' })]) }),
  )
  assert.deepEqual(actions, [])
})

test('only a past-due subscription raises a card', () => {
  const { actions } = buildNextActions(
    inputs({
      subscriptions: okTile('billing', [subscription(), subscription({ id: 's2', status: 'active' })]),
    }),
  )
  assert.equal(actions.length, 1)
  assert.equal(actions[0]?.id, 'subscription_past_due:sub1')
})

test('the past-due card names no asset at all, because this service cannot know which one', () => {
  // micro-org #227. This card said "Top up Shards to keep access." for as long as SHARD had been
  // retired — `RETIRED_ASSETS` in contracts/packages/chain/src/index.ts — telling a user whose
  // renewal had just failed to acquire an asset the estate no longer issues.
  //
  // The replacement is not "say EMBER" even though EMBER is what a renewal really settles in
  // (`settlementAsset` in billing/src/env.ts, pinned by billing/src/env.test.ts). A
  // `BillingSubscription` carries no asset and no amount, so any denomination on this card is a
  // constant copied out of another service's environment — right until billing changes it, and
  // wrong silently afterwards, which is exactly how the Shards string outlived the retirement.
  //
  // Asserted against `CHAINS` rather than against the one word that was wrong: a test that only
  // forbade "Shards" would pass the day somebody typed "EMBER" here instead, and that string would
  // be a second copy of billing's configuration living in a BFF that owns no state.
  const { actions } = buildNextActions(
    inputs({ subscriptions: okTile('billing', [subscription()]) }),
  )
  const card = actions.find((a) => a.kind === 'subscription_past_due')
  assert.ok(card, 'a past-due subscription must raise a card')
  assert.equal(card.detail, 'Top up your balance to keep access.')

  const copy = `${card.title} ${card.detail} ${card.verb}`.toLowerCase()
  for (const asset of Object.keys(CHAINS)) {
    assert.equal(
      copy.includes(asset.toLowerCase()),
      false,
      `the past-due card names ${asset}; it is built from a record that carries no asset`,
    )
  }
  // And the retired one specifically, spelled out so a reader of a failure knows which defect
  // came back. `RETIRED_ASSETS` is the authority; 'Shards' is only its display spelling.
  for (const retired of RETIRED_ASSETS) {
    assert.equal(copy.includes(retired.toLowerCase()), false, `the past-due card names ${retired}`)
  }
})

test('a card whose source is down is absent, not broken, and the source is recorded', () => {
  const { actions, missing } = buildNextActions(
    inputs({
      deposits: unavailableTile('wallet', [] as readonly DepositCredit[], 'wallet could not be reached'),
      freezes: okTile('policy', [freeze()]),
    }),
  )
  assert.deepEqual(actions.map((a) => a.kind), ['account_frozen'])
  assert.deepEqual(missing, [{ source: 'wallet', reason: 'wallet could not be reached' }])
})

test('a degraded source still produces its cards', () => {
  // Stale is not absent. A freeze from thirty seconds ago is still a freeze, and hiding it would
  // be the cache making a safety decision.
  const stale: Tile<readonly PolicyFreeze[]> = {
    status: 'degraded',
    upstream: 'policy',
    reason: 'policy could not be reached; showing a cached value',
    cached: true,
    ageMs: 45_000,
    data: [freeze()],
  }
  const { actions, missing } = buildNextActions(inputs({ freezes: stale }))
  assert.equal(actions.length, 1)
  assert.deepEqual(missing, [])
})

test('cards are ordered critical, warning, info, and stably within each', () => {
  const { actions } = buildNextActions(
    inputs({
      deposits: okTile('wallet', [deposit()]),
      withdrawals: okTile('wallet', [withdrawal()]),
      factors: okTile('identity', { factors: [], recoveryCodesRemaining: 0 }),
      freezes: okTile('policy', [freeze()]),
      subscriptions: okTile('billing', [subscription()]),
    }),
  )
  assert.deepEqual(
    actions.map((a) => a.severity),
    ['critical', 'critical', 'warning', 'warning', 'info'],
  )
  // Ids are derived from the subject, never from a counter, so a dismissal survives a refresh.
  assert.deepEqual(
    actions.map((a) => a.id),
    [
      'account_frozen:f1',
      'withdrawal_stuck:x1',
      'mfa_disabled',
      'subscription_past_due:sub1',
      'deposit_confirming:d1',
    ],
  )
})

/**
 * An asset code the contract's depth registry provably does not describe — DERIVED from that
 * registry rather than named, and the derivation is the whole point.
 *
 * This test named `DOGE` until 2026-08-09, when micro-contracts 63a0bc4 ("DOGE and ETC are chain
 * assets") gave DOGE a `confirmations` of 30 and ETC one of 7500. Every consumer resolves that
 * package as `link:` at HEAD with no version to stage behind, so the depth arrived here the moment
 * it merged: the case this test constructs stopped being a case, `buildNextActions` correctly
 * emitted `3/30 confirmations`, and the suite went red on a change this repository does not
 * contain. Renaming DOGE to whichever asset is unlisted this week re-arms exactly that trap for
 * the next one — and the estate added TWO assets in a single commit, across seven services, so the
 * next one is not hypothetical. A code derived from `CHAINS` cannot collide with an asset the
 * estate adds later.
 *
 * The branch under test is not hypothetical either. `DepositCredit.assetCode` is a `string` (see
 * upstreams.ts) because wallet's payload is not typed against the union, so any deploy where
 * wallet has been taught an asset ahead of this build's contracts-chain puts a code with no depth
 * policy through this path in production.
 */
const ASSET_WITH_NO_DEPTH_POLICY = ((): string => {
  let code = 'NO_DEPTH_POLICY'
  while (Object.hasOwn(CHAINS, code)) code += 'X'
  return code
})()

test('a deposit in an asset with no known depth policy still appears, without a fraction', () => {
  const { actions } = buildNextActions(
    inputs({
      deposits: okTile('wallet', [
        deposit({ assetCode: ASSET_WITH_NO_DEPTH_POLICY, confirmations: 3 }),
      ]),
    }),
  )
  assert.equal(actions[0]?.detail, '3 confirmations so far')
  assert.equal(actions[0]?.progress, null, '"3/0" is worse than no fraction')
})
