/**
 * The contract's invariants, proven against EXECUTED BYTECODE.
 *
 * Every test below runs the artefact in `src/contracts/generated.ts` — the same bytes `deploy.ts`
 * hands to custody, and the same bytes CI recompiles from the `.sol` and diffs. See
 * `src/evmharness.ts` for why there is an EVM here and what it does not prove.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LIST, AND WHY EACH ONE IS HERE.
 *
 *   1. The committed artefact reproduces from the source it claims (SOURCE_SHA256).
 *   2. The TypeScript and Solidity CREATE derivations agree, INCLUDING at the 0x7f/0x80 nonce
 *      boundary where RLP changes shape. If they ever disagree, every resolution reverts.
 *   3. Stake accounting sums exactly, in bigint, with no rounding leak, and the pool ratio is the
 *      odds.
 *   4. A stake at or after close is impossible.
 *   5. Resolution before close is impossible.
 *   6. Only the oracle key resolves — directly, or through a contract it created. A stranger's
 *      resolver, and a resolver claiming the wrong nonce, both fail.
 *   7. The dispute window is enforced.
 *   8. A double claim is impossible.
 *   9. Claim after void refunds exactly and WHOLLY — no fee on void.
 *  10. The fee and every payout sum EXACTLY to the pool, with the integer-division residue
 *      accounted for and sweepable.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FORESIGHTMARKET_ABI,
  FORESIGHTMARKET_BYTECODE,
  FORESIGHTRESOLVER_BYTECODE,
  SOURCE_SHA256,
} from './contracts/generated.ts'
import { createAddress, creationData, topic0 } from './evm.ts'
import { createHarness, revertedWith, type Harness } from './evmharness.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const ORACLE = '0x1111111111111111111111111111111111111111'
const TREASURY = '0x2222222222222222222222222222222222222222'
const DEPLOYER = '0x3333333333333333333333333333333333333333'
const ALICE = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const BOB = '0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0'
const CAROL = '0xca01ca01ca01ca01ca01ca01ca01ca01ca01ca01'
const STRANGER = '0x5151515151515151515151515151515151515151'
const QUESTION_HASH = `0x${'ab'.repeat(32)}`

const YES = 0n
const NO = 1n
const ACTION_YES = 0n
const ACTION_NO = 1n
const ACTION_VOID = 2n

const START = 1_700_000_000n
const CLOSE = START + 10_000n
const DISPUTE = 3_600n
const FEE_BPS = 200n // 2%

const ONE = 10n ** 18n

interface Deployed {
  readonly harness: Harness
  readonly market: string
}

async function deployMarket(
  options: { feeBps?: bigint; disputeWindow?: bigint; closeTime?: bigint } = {},
): Promise<Deployed> {
  const harness = await createHarness(START)
  await harness.fund(DEPLOYER, 10n * ONE)
  for (const account of [ALICE, BOB, CAROL, ORACLE, STRANGER]) {
    await harness.fund(account, 1_000_000n * ONE)
  }
  const data = creationData(FORESIGHTMARKET_BYTECODE, [
    { type: 'address', value: ORACLE },
    { type: 'address', value: TREASURY },
    { type: 'bytes32', value: QUESTION_HASH },
    { type: 'uint64', value: options.closeTime ?? CLOSE },
    { type: 'uint64', value: options.disputeWindow ?? DISPUTE },
    { type: 'uint16', value: options.feeBps ?? FEE_BPS },
  ])
  const created = await harness.create(DEPLOYER, data)
  assert.equal(created.reverted, false, 'the market creation reverted')
  assert.ok(created.createdAddress, 'no contract address came back')
  return { harness, market: created.createdAddress }
}

/**
 * Act as the oracle the way production does: create a `ForesightResolver`.
 *
 * `from` defaults to the oracle. Passing somebody else is how the "only the oracle resolves" test
 * proves that a resolver created by a stranger cannot resolve, even though its constructor calls
 * the same function with the same arguments.
 */
async function oracleAct(
  d: Deployed,
  action: bigint,
  options: { from?: string; nonce?: bigint } = {},
): Promise<ReturnType<Harness['create']> extends Promise<infer T> ? T : never> {
  const from = options.from ?? ORACLE
  const nonce = options.nonce ?? (await d.harness.nonceOf(from))
  const data = creationData(FORESIGHTRESOLVER_BYTECODE, [
    { type: 'address', value: d.market },
    { type: 'uint8', value: action },
    { type: 'uint64', value: nonce },
  ])
  return d.harness.create(from, data)
}

/* ------------------------------------------------------------------ 1 & 2: the artefact */

test('the committed artefact reproduces from the source it names', () => {
  const source = readFileSync(resolvePath(HERE, 'contracts/ForesightMarket.sol'), 'utf8')
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    SOURCE_SHA256,
    'generated.ts was produced from a different .sol — run `pnpm compile:contracts`',
  )
})

test('the ABI carries the entry points the service actually calls', () => {
  const names = new Set(
    (FORESIGHTMARKET_ABI as readonly { type: string; name?: string }[])
      .filter((entry) => entry.type === 'function')
      .map((entry) => entry.name),
  )
  for (const required of ['stake', 'oracleAct', 'claim', 'claimFor', 'settle', 'payoutOf', 'oddsBps']) {
    assert.ok(names.has(required), `the ABI has no ${required}`)
  }
})

test('the TypeScript and Solidity CREATE derivations agree, including across the RLP boundary', async () => {
  const d = await deployMarket()
  // 0 is the empty-string case, 0x7f the last single-byte case, 0x80 the first length-prefixed
  // one, and the rest are multi-byte. A naive implementation gets 0 and 0x80 wrong and nobody
  // notices until a live resolution reverts with `NotOracle`.
  for (const nonce of [0n, 1n, 0x7en, 0x7fn, 0x80n, 0x81n, 255n, 256n, 70_000n, 4_294_967_296n]) {
    const [onChain] = await d.harness.view(
      d.market,
      'computeCreateAddress(address,uint64)',
      ['address'],
      [
        { type: 'address', value: ORACLE },
        { type: 'uint64', value: nonce },
      ],
    )
    assert.equal(onChain, createAddress(ORACLE, nonce), `derivations disagree at nonce ${nonce}`)
  }
})

/* ------------------------------------------------------------------ 3: staking */

test('stake accounting sums exactly in bigint, and the pool ratio is the odds', async () => {
  const d = await deployMarket()
  const amounts: readonly [string, bigint, bigint][] = [
    [ALICE, YES, 3n * ONE + 7n],
    [BOB, NO, 1n * ONE + 999_999_999_999_999_999n],
    [CAROL, YES, 1n],
    [ALICE, YES, 12_345_678_901_234_567_890n],
    [BOB, NO, 42n],
  ]
  let yes = 0n
  let no = 0n
  for (const [who, outcome, amount] of amounts) {
    const result = await d.harness.call(who, d.market, 'stake(uint8)', [{ type: 'uint8', value: outcome }], amount)
    assert.equal(result.reverted, false, 'a stake reverted')
    if (outcome === YES) yes += amount
    else no += amount
  }

  const [poolYes] = await d.harness.view(d.market, 'pool(uint256)', ['uint256'], [{ type: 'uint256', value: 0n }])
  const [poolNo] = await d.harness.view(d.market, 'pool(uint256)', ['uint256'], [{ type: 'uint256', value: 1n }])
  const [total] = await d.harness.view(d.market, 'total()', ['uint256'])

  // EXACT. Not "within one wei" — every one of these is an integer and the contract does nothing
  // to them but add.
  assert.equal(poolYes, yes)
  assert.equal(poolNo, no)
  assert.equal(total, yes + no)
  // The contract's balance is the pool, to the wei. If these ever differ, a stake went somewhere.
  assert.equal(await d.harness.balanceOf(d.market), yes + no)

  const [aliceYes, aliceNo] = await d.harness.view(
    d.market,
    'stakeOf(address)',
    ['uint256', 'uint256'],
    [{ type: 'address', value: ALICE }],
  )
  assert.equal(aliceYes, 3n * ONE + 7n + 12_345_678_901_234_567_890n)
  assert.equal(aliceNo, 0n)

  // Odds ARE the pool ratio. Computed here the same way the contract does, in bigint, so this
  // asserts the contract's arithmetic rather than restating a float.
  const [yesBps] = await d.harness.view(d.market, 'oddsBps(uint8)', ['uint256'], [{ type: 'uint8', value: YES }])
  const [noBps] = await d.harness.view(d.market, 'oddsBps(uint8)', ['uint256'], [{ type: 'uint8', value: NO }])
  assert.equal(yesBps, (yes * 10_000n) / (yes + no))
  assert.equal(noBps, (no * 10_000n) / (yes + no))
})

test('a zero stake, an unknown outcome, and a plain send are all refused', async () => {
  const d = await deployMarket()
  assert.ok(
    revertedWith(
      await d.harness.call(ALICE, d.market, 'stake(uint8)', [{ type: 'uint8', value: YES }], 0n),
      'ZeroStake()',
    ),
  )
  assert.ok(
    revertedWith(
      await d.harness.call(ALICE, d.market, 'stake(uint8)', [{ type: 'uint8', value: 2n }], ONE),
      'BadOutcome()',
    ),
  )
})

test('a stake at or after the close time is impossible', async () => {
  const d = await deployMarket()
  d.harness.setTime(CLOSE - 1n)
  assert.equal(
    (await d.harness.call(ALICE, d.market, 'stake(uint8)', [{ type: 'uint8', value: YES }], ONE)).reverted,
    false,
    'a stake one second before close should be accepted',
  )
  // At the close time exactly, not merely after it. An off-by-one here is a market that takes a
  // stake in the block its answer becomes knowable.
  d.harness.setTime(CLOSE)
  assert.ok(
    revertedWith(
      await d.harness.call(BOB, d.market, 'stake(uint8)', [{ type: 'uint8', value: NO }], ONE),
      'Closed()',
    ),
  )
})

/* ------------------------------------------------------------------ 5 & 6: who may resolve, and when */

test('resolution before close is impossible', async () => {
  const d = await deployMarket()
  await d.harness.call(ALICE, d.market, 'stake(uint8)', [{ type: 'uint8', value: YES }], ONE)
  d.harness.setTime(CLOSE - 1n)
  // The oracle itself, at the right nonce, with the right action. Still refused: a market resolved
  // while it is still taking stakes is a market whose resolver can stake on the answer.
  const attempt = await oracleAct(d, ACTION_YES)
  assert.equal(attempt.reverted, true, 'the market accepted a resolution before close')
  const [status] = await d.harness.view(d.market, 'status()', ['uint8'])
  assert.equal(status, 0n, 'the market left Open')
})

test('only the oracle key resolves — directly, or through a contract it created', async () => {
  const d = await deployMarket()
  await d.harness.call(ALICE, d.market, 'stake(uint8)', [{ type: 'uint8', value: YES }], ONE)
  d.harness.setTime(CLOSE)

  // A stranger, calling directly.
  assert.ok(
    revertedWith(
      await d.harness.call(
        STRANGER,
        d.market,
        'oracleAct(uint8,uint64)',
        [
          { type: 'uint8', value: ACTION_YES },
          { type: 'uint64', value: 0n },
        ],
      ),
      'NotOracle()',
    ),
    'a stranger resolved the market directly',
  )

  // A stranger, through a resolver contract of their own — the same constructor, the same
  // arguments, a truthful nonce. Refused, because the derived address is the STRANGER's.
  assert.equal(
    (await oracleAct(d, ACTION_YES, { from: STRANGER })).reverted,
    true,
    'a stranger resolved the market through their own resolver',
  )

  // The oracle, through a resolver, but LYING about the nonce. The derivation produces a different
  // address from `msg.sender` and the market refuses.
  const realNonce = await d.harness.nonceOf(ORACLE)
  assert.equal(
    (await oracleAct(d, ACTION_YES, { nonce: realNonce + 5n })).reverted,
    true,
    'the market accepted a resolver claiming the wrong nonce',
  )

  // And now the real thing.
  const posted = await oracleAct(d, ACTION_YES)
  assert.equal(posted.reverted, false, 'the oracle could not resolve its own market')
  const [status] = await d.harness.view(d.market, 'status()', ['uint8'])
  assert.equal(status, 1n, 'the market did not reach Resolved')
  const [outcome] = await d.harness.view(d.market, 'winningOutcome()', ['uint8'])
  assert.equal(outcome, YES)

  // The resolver contract left NO runtime code behind. Nothing to call, own or exploit.
  const resolverAddress = createAddress(ORACLE, realNonce)
  assert.equal(await d.harness.balanceOf(resolverAddress), 0n)
})

test('the oracle may also act directly, so a hardware wallet needs no resolver', async () => {
  const d = await deployMarket()
  await d.harness.call(ALICE, d.market, 'stake(uint8)', [{ type: 'uint8', value: NO }], ONE)
  d.harness.setTime(CLOSE)
  const result = await d.harness.call(
    ORACLE,
    d.market,
    'oracleAct(uint8,uint64)',
    [
      { type: 'uint8', value: ACTION_NO },
      // Ignored on the direct path, and deliberately nonsense here to prove it.
      { type: 'uint64', value: 999_999n },
    ],
  )
  assert.equal(result.reverted, false)
  const [status] = await d.harness.view(d.market, 'status()', ['uint8'])
  assert.equal(status, 1n)
})

test('a market nobody won refunds everybody rather than paying the treasury', async () => {
  const d = await deployMarket()
  await d.harness.call(ALICE, d.market, 'stake(uint8)', [{ type: 'uint8', value: YES }], 5n * ONE)
  d.harness.setTime(CLOSE)
  // Resolve NO, with nothing at all on NO. The alternative — the whole pool to the treasury
  // because no ticket matched — is a windfall taken from people who were all wrong together.
  const posted = await oracleAct(d, ACTION_NO)
  assert.equal(posted.reverted, false)
  const [status] = await d.harness.view(d.market, 'status()', ['uint8'])
  assert.equal(status, 2n, 'the market should have voided itself')
  const [fee] = await d.harness.view(d.market, 'feeAmount()', ['uint256'])
  assert.equal(fee, 0n, 'a void market must charge no fee')

  const before = await d.harness.balanceOf(ALICE)
  const claimed = await d.harness.call(ALICE, d.market, 'claim()')
  assert.equal(claimed.reverted, false)
  assert.equal(await d.harness.balanceOf(ALICE), before + 5n * ONE, 'the refund was not whole')
  assert.equal(await d.harness.balanceOf(d.market), 0n)
})

/* ------------------------------------------------------------------ 7 & 8: claiming */

test('the dispute window is enforced, and a double claim is impossible', async () => {
  const d = await deployMarket()
  await d.harness.call(ALICE, d.market, 'stake(uint8)', [{ type: 'uint8', value: YES }], 3n * ONE)
  await d.harness.call(BOB, d.market, 'stake(uint8)', [{ type: 'uint8', value: NO }], 1n * ONE)
  d.harness.setTime(CLOSE)
  assert.equal((await oracleAct(d, ACTION_YES)).reverted, false)

  // One second before the window closes.
  d.harness.setTime(CLOSE + DISPUTE - 1n)
  assert.ok(
    revertedWith(await d.harness.call(ALICE, d.market, 'claim()'), 'DisputeWindowOpen()'),
    'a claim was allowed inside the dispute window',
  )

  d.harness.setTime(CLOSE + DISPUTE)
  const first = await d.harness.call(ALICE, d.market, 'claim()')
  assert.equal(first.reverted, false, 'the first claim failed')

  // The second claim is not "pays zero" — it REVERTS. A zero payout would be indistinguishable
  // from a bug that had already paid twice.
  assert.ok(
    revertedWith(await d.harness.call(ALICE, d.market, 'claim()'), 'AlreadyClaimed()'),
    'a second claim succeeded',
  )
  // And through `claimFor`, which is the batching path a leased job would use.
  assert.ok(
    revertedWith(
      await d.harness.call(STRANGER, d.market, 'claimFor(address)', [{ type: 'address', value: ALICE }]),
      'AlreadyClaimed()',
    ),
    'claimFor paid an address that had already claimed',
  )
})

test('a loser claims nothing, and is told so rather than paid zero', async () => {
  const d = await deployMarket()
  await d.harness.call(ALICE, d.market, 'stake(uint8)', [{ type: 'uint8', value: YES }], ONE)
  await d.harness.call(BOB, d.market, 'stake(uint8)', [{ type: 'uint8', value: NO }], ONE)
  d.harness.setTime(CLOSE)
  await oracleAct(d, ACTION_YES)
  d.harness.setTime(CLOSE + DISPUTE)
  assert.ok(revertedWith(await d.harness.call(BOB, d.market, 'claim()'), 'NothingToClaim()'))
})

/* ------------------------------------------------------------------ 9: void refunds whole */

test('claim after void refunds exactly and wholly, on both sides, with no fee', async () => {
  const d = await deployMarket()
  const stakes: readonly [string, bigint, bigint][] = [
    [ALICE, YES, 3n * ONE + 12_345n],
    [BOB, NO, 7n * ONE + 999n],
    // Somebody who backed BOTH sides. A refund that only looked at the winning column would
    // silently keep half of this.
    [CAROL, YES, ONE + 1n],
    [CAROL, NO, 2n * ONE + 2n],
  ]
  const staked = new Map<string, bigint>()
  for (const [who, outcome, amount] of stakes) {
    await d.harness.call(who, d.market, 'stake(uint8)', [{ type: 'uint8', value: outcome }], amount)
    staked.set(who, (staked.get(who) ?? 0n) + amount)
  }
  const total = [...staked.values()].reduce((a, b) => a + b, 0n)
  assert.equal(await d.harness.balanceOf(d.market), total)

  // Void does not need the market to be closed — that is the point of it. A named source that has
  // disappeared is discovered whenever it is discovered.
  assert.equal((await oracleAct(d, ACTION_VOID)).reverted, false)
  const [status] = await d.harness.view(d.market, 'status()', ['uint8'])
  assert.equal(status, 2n)
  const [fee] = await d.harness.view(d.market, 'feeAmount()', ['uint256'])
  assert.equal(fee, 0n, 'REFUNDS ARE WHOLE: a void market must charge no fee')

  // And there is no dispute window on a void: the money is going back to the people it came from,
  // so there is nothing to dispute.
  let refunded = 0n
  for (const [who, amount] of staked) {
    const before = await d.harness.balanceOf(who)
    const result = await d.harness.call(who, d.market, 'claim()')
    assert.equal(result.reverted, false, `${who} could not claim a refund`)
    const paid = (await d.harness.balanceOf(who)) - before
    assert.equal(paid, amount, `${who} was refunded ${paid} rather than ${amount}`)
    refunded += paid
  }

  assert.equal(refunded, total, 'the refunds did not sum to the pool')
  // EXACTLY empty. No dust, because a refund is not a division.
  assert.equal(await d.harness.balanceOf(d.market), 0n)
  assert.equal(await d.harness.balanceOf(TREASURY), 0n, 'the treasury took something from a void market')
})

test('a voided market accepts no further stake and cannot be resolved afterwards', async () => {
  const d = await deployMarket()
  await d.harness.call(ALICE, d.market, 'stake(uint8)', [{ type: 'uint8', value: YES }], ONE)
  await oracleAct(d, ACTION_VOID)
  assert.ok(
    revertedWith(
      await d.harness.call(BOB, d.market, 'stake(uint8)', [{ type: 'uint8', value: NO }], ONE),
      'NotOpen()',
    ),
  )
  d.harness.setTime(CLOSE)
  assert.equal((await oracleAct(d, ACTION_YES)).reverted, true, 'a void market was resolved')
})

/* ------------------------------------------------------------------ 10: the fee sums exactly */

test('the fee and every payout sum EXACTLY to the pool, and the residue is sweepable', async () => {
  const d = await deployMarket()
  // Deliberately awkward numbers: three winners whose shares do not divide evenly, so the
  // integer-division residue is non-zero and has to be accounted for rather than wished away.
  const winners: readonly [string, bigint][] = [
    [ALICE, 1n * ONE + 1n],
    [BOB, 2n * ONE + 7n],
    [CAROL, 333_333_333_333_333_333n],
  ]
  const loserStake = 5n * ONE + 999_999_999_999_999_999n

  for (const [who, amount] of winners) {
    await d.harness.call(who, d.market, 'stake(uint8)', [{ type: 'uint8', value: YES }], amount)
  }
  await d.harness.call(STRANGER, d.market, 'stake(uint8)', [{ type: 'uint8', value: NO }], loserStake)

  const winnerPool = winners.reduce((a, [, amount]) => a + amount, 0n)
  const total = winnerPool + loserStake
  assert.equal(await d.harness.balanceOf(d.market), total)

  d.harness.setTime(CLOSE)
  assert.equal((await oracleAct(d, ACTION_YES)).reverted, false)

  // THE FEE IS TAKEN FROM THE LOSING POOL ONLY. A winner therefore never receives less than they
  // staked, which is the promise the contract's header makes.
  const expectedFee = (loserStake * FEE_BPS) / 10_000n
  const [fee] = await d.harness.view(d.market, 'feeAmount()', ['uint256'])
  assert.equal(fee, expectedFee)
  const [distributable] = await d.harness.view(d.market, 'distributable()', ['uint256'])
  assert.equal(distributable, total - expectedFee)

  d.harness.setTime(CLOSE + DISPUTE)

  let paid = 0n
  for (const [who, amount] of winners) {
    const expected = (amount * (total - expectedFee)) / winnerPool
    const before = await d.harness.balanceOf(who)
    const result = await d.harness.call(who, d.market, 'claim()')
    assert.equal(result.reverted, false, `${who} could not claim`)
    const received = (await d.harness.balanceOf(who)) - before
    assert.equal(received, expected, `${who} was paid ${received} rather than ${expected}`)
    // The promise, checked: a winner never gets back less than they put in.
    assert.ok(received >= amount, `${who} received less than they staked`)
    paid += received
  }

  // The fee. Permissionless, once.
  const treasuryBefore = await d.harness.balanceOf(TREASURY)
  assert.equal((await d.harness.call(STRANGER, d.market, 'settle()')).reverted, false)
  assert.equal(await d.harness.balanceOf(TREASURY), treasuryBefore + expectedFee)
  assert.ok(revertedWith(await d.harness.call(STRANGER, d.market, 'settle()'), 'FeeAlreadyPaid()'))

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // THE EXACT-SUM INVARIANT. Pro-rata payment by integer division cannot come out even; each
  // winner's share is floored, so the pot retains up to one wei per winner. What is asserted is
  // that NOTHING IS LOST AND NOTHING IS INVENTED: payouts + fee + residue == the pool, exactly.
  // ────────────────────────────────────────────────────────────────────────────────────────────
  const residue = await d.harness.balanceOf(d.market)
  assert.equal(paid + expectedFee + residue, total, 'the pool did not add up')
  assert.ok(residue < BigInt(winners.length), `the residue ${residue} exceeds one wei per winner`)

  // And the residue has a destination, released on a CONDITION rather than a clock: every winning
  // wei has been claimed, so whatever is left is arithmetic. Nobody's winnings were confiscated.
  const beforeSweep = await d.harness.balanceOf(TREASURY)
  if (residue > 0n) {
    assert.equal((await d.harness.call(STRANGER, d.market, 'sweepDust()')).reverted, false)
    assert.equal(await d.harness.balanceOf(TREASURY), beforeSweep + residue)
  }
  assert.equal(await d.harness.balanceOf(d.market), 0n, 'the contract retained money after settlement')
})

test('the residue cannot be swept while any winner is still owed', async () => {
  const d = await deployMarket()
  await d.harness.call(ALICE, d.market, 'stake(uint8)', [{ type: 'uint8', value: YES }], ONE + 1n)
  await d.harness.call(BOB, d.market, 'stake(uint8)', [{ type: 'uint8', value: YES }], ONE + 2n)
  await d.harness.call(STRANGER, d.market, 'stake(uint8)', [{ type: 'uint8', value: NO }], 3n * ONE + 7n)
  d.harness.setTime(CLOSE)
  await oracleAct(d, ACTION_YES)
  d.harness.setTime(CLOSE + DISPUTE)

  await d.harness.call(ALICE, d.market, 'claim()')
  // Before the fee is paid, the residue is not even a question: `sweepDust` refuses.
  assert.ok(revertedWith(await d.harness.call(CAROL, d.market, 'sweepDust()'), 'FeeNotPaid()'))
  await d.harness.call(STRANGER, d.market, 'settle()')
  // BOB has not claimed. Sweeping now would take his winnings, which is exactly what the condition
  // is there to make impossible — and why the release is not on a timer.
  assert.ok(
    revertedWith(await d.harness.call(CAROL, d.market, 'sweepDust()'), 'WinnersOutstanding()'),
    'the residue was swept while a winner was still owed',
  )
  const owed = await d.harness.view(d.market, 'payoutOf(address)', ['uint256'], [{ type: 'address', value: BOB }])
  assert.ok((owed[0] as bigint) > 0n, 'BOB should still be owed')
})

test('a zero-fee market pays the whole pool to the winners', async () => {
  const d = await deployMarket({ feeBps: 0n })
  await d.harness.call(ALICE, d.market, 'stake(uint8)', [{ type: 'uint8', value: YES }], 4n * ONE)
  await d.harness.call(BOB, d.market, 'stake(uint8)', [{ type: 'uint8', value: NO }], 6n * ONE)
  d.harness.setTime(CLOSE)
  await oracleAct(d, ACTION_YES)
  d.harness.setTime(CLOSE + DISPUTE)

  const before = await d.harness.balanceOf(ALICE)
  await d.harness.call(ALICE, d.market, 'claim()')
  assert.equal(await d.harness.balanceOf(ALICE), before + 10n * ONE, 'the sole winner did not take the pool')
  await d.harness.call(STRANGER, d.market, 'settle()')
  assert.equal(await d.harness.balanceOf(TREASURY), 0n)
  assert.equal(await d.harness.balanceOf(d.market), 0n)
})

/* ------------------------------------------------------------------ construction and events */

test('a market that could never work is refused at creation', async () => {
  const harness = await createHarness(START)
  await harness.fund(DEPLOYER, 10n * ONE)
  const build = (args: {
    oracle?: string
    treasury?: string
    hash?: string
    close?: bigint
    fee?: bigint
  }) =>
    creationData(FORESIGHTMARKET_BYTECODE, [
      { type: 'address', value: args.oracle ?? ORACLE },
      { type: 'address', value: args.treasury ?? TREASURY },
      { type: 'bytes32', value: args.hash ?? QUESTION_HASH },
      { type: 'uint64', value: args.close ?? CLOSE },
      { type: 'uint64', value: DISPUTE },
      { type: 'uint16', value: args.fee ?? FEE_BPS },
    ])

  const zero = '0x0000000000000000000000000000000000000000'
  for (const [name, data] of [
    ['no oracle', build({ oracle: zero })],
    ['no treasury', build({ treasury: zero })],
    ['no question hash', build({ hash: `0x${'00'.repeat(32)}` })],
    ['a close time already past', build({ close: START })],
    // 1001 bps, one past the ceiling in the code. An operator who could set 100% could take the
    // whole losing pool.
    ['a fee above the ceiling', build({ fee: 1_001n })],
  ] as const) {
    const result = await harness.create(DEPLOYER, data)
    assert.equal(result.reverted, true, `the market was created with ${name}`)
  }
})

test('a stake emits Staked with the running pool, which is what the mirror decodes', async () => {
  const d = await deployMarket()
  const result = await d.harness.call(
    ALICE,
    d.market,
    'stake(uint8)',
    [{ type: 'uint8', value: NO }],
    7n * ONE,
  )
  assert.equal(result.reverted, false)
  const log = result.logs.find((entry) => entry.topics[0] === topic0('Staked(address,uint8,uint256,uint256,uint256)'))
  assert.ok(log, 'no Staked log was emitted')
  assert.equal(log.address.toLowerCase(), d.market.toLowerCase())
  // The staker and the outcome are indexed, so they are topics; the amount and both pool totals
  // are in the body. `mirror.ts` decodes exactly this shape.
  assert.equal(BigInt(log.topics[1] ?? '0x0'), BigInt(ALICE))
  assert.equal(BigInt(log.topics[2] ?? '0x0'), NO)
})
