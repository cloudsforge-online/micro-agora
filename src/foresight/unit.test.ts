/**
 * The pure parts: the category allowlist, the canonical document, the EVM codec, the idempotency
 * fingerprint, and the proposer's parsing of untrusted model output.
 *
 * No database and no chain. Everything here is a total function, and the tests are the kind that
 * catch a refactor rather than a design mistake — except the two that are not: the allowlist
 * version guard, and the fingerprint's exclusion of `correlationId`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  CATEGORIES,
  CATEGORY_IDS,
  CATEGORY_VERSION,
  REFUSALS,
  isCategory,
  isRefusal,
  isSourceKindFor,
} from './categories.ts'
import { canonicalDocument, questionHash, type QuestionDocument } from './questiondoc.ts'
import {
  canonicaliseEvm,
  createAddress,
  decodeAbi,
  encodeAbi,
  evmTxHash,
  gasPriceBid,
  selector,
  toChecksumAddress,
} from './evm.ts'
import { requestFingerprint, namespacedKey } from './idempotency.ts'
import { PROMPT_TEMPLATE, renderPrompt, toProposal, UNCONFIGURED_PROPOSER } from './proposer.ts'
import { decodeFeePaid, decodeStaked, FEE_PAID_TOPIC, STAKED_TOPIC } from './mirror.ts'
import { chainIdOf, requiredConfirmations } from './chains.ts'
import { ENTRY_KINDS, isEntryKind } from '@cloudsforge/contracts-money'
import { FEE_ENTRY_KIND } from './ledgerclient.ts'

/* ------------------------------------------------------------------ the entry kind */

test('the fee kind is one the LEDGER will actually accept', () => {
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // micro-org#424, and THIS service is why the ticket exists. `foresight.settlement_fee` was
  // posted from `jobs.ts` for months. It is not in the ledger's closed vocabulary, so
  // `validateEntryRequest` answered 400 before opening a transaction and not one settlement fee
  // was ever recorded — a defect whose only symptom is nothing happening. Tessera then made the
  // identical mistake with `item_issue` (micro-org#407 §3).
  //
  // Two things stop the third one. `EntryRequest.kind` is `EntryKind`, so a call site cannot
  // compile an invented kind; and this, which checks MEMBERSHIP rather than spelling. Spelling is
  // what the old `jobs.test.ts` assertion checked, and it agreed with the broken code.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  assert.ok(isEntryKind(FEE_ENTRY_KIND), `${FEE_ENTRY_KIND} is not in the ledger's closed set`)
  assert.ok(ENTRY_KINDS.includes(FEE_ENTRY_KIND))
  // The value itself is pinned too: the ledger's revenue reporting counts `fee_charged`, so
  // swapping it for another member of the set would still post and would still be wrong.
  assert.equal(FEE_ENTRY_KIND, 'fee_charged')
})

/* ------------------------------------------------------------------ the allowlist */

/**
 * **THE VERSION GUARD.** The digest of the frozen tables, one entry per allowlist version.
 *
 * A change to a category or a refusal moves the digest; if the new digest has no entry here, the
 * build fails and the author has to bump `CATEGORY_VERSION` and record it. That is the whole
 * mechanism, and it exists because a market stores the version it was approved under: "which rules
 * were in force" only has an answer if the version moves when the rules do.
 */
const ALLOWLIST_DIGESTS: Readonly<Record<number, string>> = Object.freeze({
  1: 'ed8b6aa37a872daab4fbd558114834d7ee37d3f9bd6875f4ae4b50cc1c25a0ac',
})

test('the category allowlist cannot change without its version changing', () => {
  const digest = createHash('sha256')
    .update(JSON.stringify({ categories: CATEGORIES, refusals: REFUSALS }))
    .digest('hex')
  assert.equal(
    ALLOWLIST_DIGESTS[CATEGORY_VERSION],
    digest,
    `the allowlist content changed under version ${CATEGORY_VERSION} — bump CATEGORY_VERSION and ` +
      `record the new digest ${digest} in ALLOWLIST_DIGESTS`,
  )
})

test('the allowlist is an allowlist: three categories, and nothing else is a category', () => {
  assert.deepEqual([...CATEGORY_IDS], ['protocol_network', 'market_prices', 'scheduled_public_events'])
  assert.equal(isCategory('protocol_network'), true)
  // The shapes a model or a careless operator would actually produce.
  for (const not of ['politics', 'sports', 'celebrity', '', 'PROTOCOL_NETWORK', 'protocol_network ']) {
    assert.equal(isCategory(not), false, `${not} was accepted as a category`)
  }
})

test('a source kind must belong to its own category', () => {
  assert.equal(isSourceKindFor('protocol_network', 'block_explorer'), true)
  // A perfectly real source kind, for the wrong category. This is the check that stops a
  // scheduled-event market being settled from a price feed.
  assert.equal(isSourceKindFor('protocol_network', 'exchange_api'), false)
  assert.equal(isSourceKindFor('market_prices', 'exchange_api'), true)
  assert.equal(isSourceKindFor('not_a_category', 'exchange_api'), false)
})

test('the three refusals are recorded, countable, and closed', () => {
  assert.deepEqual(
    REFUSALS.map((r) => r.id),
    ['named_private_individual', 'death_or_violence', 'unverifiable_resolution'],
  )
  assert.equal(isRefusal('named_private_individual'), true)
  assert.equal(isRefusal('i_didnt_like_it'), false)
})

/* ------------------------------------------------------------------ the canonical document */

const DOC: QuestionDocument = {
  question: 'Will X happen?',
  resolutionCriteria: 'YES if the named source says so before the close time.',
  category: 'protocol_network',
  categoryVersion: 1,
  resolutionSourceKind: 'block_explorer',
  resolutionSourceRef: 'https://example.invalid/x',
  closeTime: 1_800_000_000,
  disputeWindowSeconds: 86_400,
  feeBps: 200,
}

test('the question hash changes when any part of the document changes', () => {
  const base = questionHash(DOC)
  const variants: readonly Partial<QuestionDocument>[] = [
    { question: 'Will X happen ?' },
    { resolutionCriteria: `${DOC.resolutionCriteria} ` },
    { category: 'market_prices' },
    { categoryVersion: 2 },
    { resolutionSourceKind: 'price_index' },
    // The one that matters most: swapping the named source must produce a different hash, or
    // "the source is named at open" is not enforced by anything.
    { resolutionSourceRef: 'https://example.invalid/y' },
    { closeTime: DOC.closeTime + 1 },
    { disputeWindowSeconds: 0 },
    { feeBps: 0 },
  ]
  for (const patch of variants) {
    assert.notEqual(questionHash({ ...DOC, ...patch }), base, `${JSON.stringify(patch)} did not move the hash`)
  }
})

/**
 * The classic concatenation ambiguity, and why every field is length-prefixed.
 *
 * Without the prefix, a question ending in a character and criteria beginning without it produce
 * the same bytes as the pair shifted by one — two different markets with one hash.
 */
test('two documents that differ only in where a field boundary falls hash differently', () => {
  const a = questionHash({ ...DOC, question: 'ab', resolutionCriteria: 'c'.repeat(20) })
  const b = questionHash({ ...DOC, question: 'a', resolutionCriteria: `b${'c'.repeat(20)}` })
  assert.notEqual(a, b)
})

test('the canonical document is stable and shows its own version', () => {
  const canonical = canonicalDocument(DOC)
  assert.ok(canonical.includes('cloudsforge.foresight.market/1'))
  assert.equal(canonicalDocument(DOC), canonical)
  assert.equal(questionHash(DOC).length, 66)
})

/* ------------------------------------------------------------------ the EVM codec */

test('EIP-55 is enforced when an address claims it, and not when it does not', () => {
  const lower = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'
  const checksummed = toChecksumAddress(lower)
  assert.equal(checksummed, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
  assert.equal(canonicaliseEvm(lower), checksummed)
  assert.equal(canonicaliseEvm(checksummed), checksummed)
  // A mixed-case address is CLAIMING a checksum and is held to it. This is what stands between a
  // typed treasury address and a fee stream nobody can collect.
  assert.throws(() => canonicaliseEvm('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'), /checksum/)
  assert.throws(() => canonicaliseEvm(`0x${'0'.repeat(40)}`), /zero address/)
  assert.throws(() => canonicaliseEvm('0xnothex'), /40 hex/)
})

test('the CREATE derivation matches the published vectors', () => {
  // EIP-161's own example: the first contract from a fresh account.
  assert.equal(
    createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 0n).toLowerCase(),
    '0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d',
  )
  assert.equal(
    createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 1n).toLowerCase(),
    '0x343c43a37d37dff08ae8c4a11544c718abb4fcf8',
  )
})

test('the transaction hash is derivable before anything is sent', () => {
  // The property the whole "record the broadcast before confirming" rule rests on.
  const raw = `0x${'ab'.repeat(100)}`
  assert.equal(evmTxHash(raw)?.length, 66)
  assert.equal(evmTxHash(raw), evmTxHash(raw))
  assert.equal(evmTxHash('nothex'), null)
})

test('the ABI codec round-trips the static types the service uses', () => {
  const encoded = encodeAbi([
    { type: 'address', value: '0x1111111111111111111111111111111111111111' },
    { type: 'uint256', value: 12_345_678_901_234_567_890n },
    { type: 'bool', value: true },
    { type: 'bytes32', value: `0x${'cd'.repeat(32)}` },
  ])
  const decoded = decodeAbi(['address', 'uint256', 'bool', 'bytes32'], `0x${encoded.toString('hex')}`)
  assert.equal((decoded[0] as string).toLowerCase(), '0x1111111111111111111111111111111111111111')
  assert.equal(decoded[1], 12_345_678_901_234_567_890n)
  assert.equal(decoded[2], true)
  assert.equal(decoded[3], `0x${'cd'.repeat(32)}`)
})

test('an out-of-range integer is refused rather than truncated', () => {
  // A supply silently reduced mod 2^8 is a number nobody asked for on a path that moves money.
  assert.throws(() => encodeAbi([{ type: 'uint8', value: 256n }]), /out of range/)
  assert.throws(() => encodeAbi([{ type: 'uint16', value: 65_536n }]), /out of range/)
  assert.throws(() => encodeAbi([{ type: 'uint64', value: 1n << 64n }]), /out of range/)
  assert.throws(() => encodeAbi([{ type: 'uint256', value: -1n }]), /negative/)
})

test('the selector matches the one the contract answers to', () => {
  // `stake(uint8)` is the calldata `stake-intent` hands a wallet. A wrong selector here is a
  // transaction that reverts in the user's wallet after they have paid the gas.
  assert.equal(selector('stake(uint8)').length, 10)
  assert.equal(selector('claim()'), selector('claim()'))
  assert.notEqual(selector('stake(uint8)'), selector('claim()'))
})

test('the gas bid is bounded before it is doubled', () => {
  const bounds = { minGasPriceWei: 1_000n, maxGasPriceWei: 10_000n }
  assert.equal(gasPriceBid(500n, bounds), 2_000n, 'the floor should apply, then the doubling')
  assert.equal(gasPriceBid(3_000n, bounds), 6_000n)
  // Clamped at the ceiling rather than refused, because the doubling is a safety margin.
  assert.equal(gasPriceBid(9_000n, bounds), 10_000n)
  // But a quote ABOVE the ceiling is refused. Checking after the doubling would make every
  // broadcast fail once the real price passed half the ceiling — a bound biting at a number
  // nobody configured.
  assert.throws(() => gasPriceBid(10_001n, bounds), /ceiling/)
})

/* ------------------------------------------------------------------ log decoding */

test('a Staked log from another contract is not this market’s stake', () => {
  const market = '0x4444444444444444444444444444444444444444'
  const log = {
    logIndex: 3,
    address: market,
    topics: [
      STAKED_TOPIC,
      `0x${'0'.repeat(24)}${'a1'.repeat(20)}`,
      `0x${'0'.repeat(63)}1`,
    ],
    data: `0x${encodeAbi([
      { type: 'uint256', value: 5n },
      { type: 'uint256', value: 1n },
      { type: 'uint256', value: 5n },
    ]).toString('hex')}`,
  }
  const decoded = decodeStaked(log, market)
  assert.deepEqual(decoded, { staker: `0x${'a1'.repeat(20)}`, outcome: 1, amount: 5n })

  // The address filter. A transaction that touched this market may carry logs from elsewhere, and
  // a Staked-shaped event from another contract would otherwise be credited to this pool.
  assert.equal(decodeStaked({ ...log, address: `0x${'99'.repeat(20)}` }, market), null)
  assert.equal(decodeStaked({ ...log, topics: [FEE_PAID_TOPIC, ...log.topics.slice(1)] }, market), null)
  // A zero-amount stake is not one, and the contract cannot emit it — but a decoder that accepted
  // it would put a row in the mirror that violates `positions_amount_ck`.
  assert.equal(
    decodeStaked(
      {
        ...log,
        data: `0x${encodeAbi([
          { type: 'uint256', value: 0n },
          { type: 'uint256', value: 0n },
          { type: 'uint256', value: 0n },
        ]).toString('hex')}`,
      },
      market,
    ),
    null,
  )
})

test('a FeePaid log decodes to the treasury and the amount', () => {
  const market = '0x4444444444444444444444444444444444444444'
  const decoded = decodeFeePaid(
    {
      address: market,
      topics: [FEE_PAID_TOPIC, `0x${'0'.repeat(24)}${'22'.repeat(20)}`],
      data: `0x${encodeAbi([{ type: 'uint256', value: 777n }]).toString('hex')}`,
    },
    market,
  )
  assert.deepEqual(decoded, { treasury: `0x${'22'.repeat(20)}`, amount: 777n })
})

/* ------------------------------------------------------------------ idempotency */

/**
 * **The fingerprint EXCLUDES `correlationId`.**
 *
 * `micro-ledger` pinned this and `micro-wallet` found it: a caller doing exactly the right thing —
 * retrying with a fresh trace id — would otherwise be told its idempotency key was reused with a
 * different payload, and could not tell a genuine collision from its own tracing.
 */
test('the request fingerprint ignores the fields that change per attempt', () => {
  const first = requestFingerprint({ marketId: 'm1', correlationId: 'req-1' })
  const second = requestFingerprint({ marketId: 'm1', correlationId: 'req-2' })
  assert.equal(first, second, 'a retry with a fresh correlation id must fingerprint the same')

  // And a genuinely different body still differs, or the exclusion has gone too far.
  assert.notEqual(first, requestFingerprint({ marketId: 'm2', correlationId: 'req-1' }))
})

test('the fingerprint is stable under key order and exact under value change', () => {
  assert.equal(
    requestFingerprint({ a: 1, b: { c: 2, d: 3 } }),
    requestFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
  )
  assert.notEqual(requestFingerprint({ a: 1 }), requestFingerprint({ a: '1' }))
  // bigint, because every amount in this estate is one.
  assert.equal(requestFingerprint({ a: 10n ** 30n }), requestFingerprint({ a: 10n ** 30n }))
})

test('keys are namespaced by the calling service', () => {
  assert.equal(namespacedKey('foresight', 'POST /x', 'k1'), 'foresight:POST /x:k1')
  assert.notEqual(namespacedKey('a', 'r', 'k'), namespacedKey('b', 'r', 'k'))
})

/* ------------------------------------------------------------------ the proposer */

test('an unconfigured proposer is a supported mode, not an error', async () => {
  const run = await UNCONFIGURED_PROPOSER.propose({ topic: 't', count: 3, now: new Date() })
  assert.equal(UNCONFIGURED_PROPOSER.configured, false)
  assert.equal(run.reason, 'not_configured')
  assert.deepEqual([...run.proposals], [])
})

test('the prompt states the allowlist, and its hash moves with its wording', () => {
  for (const category of CATEGORY_IDS) {
    assert.ok(PROMPT_TEMPLATE.includes(category), `the prompt does not name ${category}`)
  }
  assert.ok(PROMPT_TEMPLATE.includes('named a private individual') || PROMPT_TEMPLATE.includes('names a private individual'))
  const a = renderPrompt('topic one', 3)
  const b = renderPrompt('topic two', 3)
  assert.notEqual(a, b)
  assert.ok(a.includes('topic one'))
  assert.ok(a.includes('at most 3'))
})

test('an untrusted candidate is dropped rather than repaired', () => {
  const provenance = {
    searchQuery: 'q',
    sources: [{ url: 'https://example.invalid/a', title: 'A', retrievedAt: '2026-01-01T00:00:00.000Z' }],
    modelId: 'm',
    promptSha256: 'a'.repeat(64),
  }
  const good = toProposal(
    {
      question: 'Will X happen?',
      resolutionCriteria: 'Criteria.',
      category: 'protocol_network',
      resolutionSourceKind: 'block_explorer',
      resolutionSourceRef: 'https://example.invalid/x',
      closeTimeIso: '2027-01-01T00:00:00.000Z',
    },
    provenance,
  )
  assert.ok(good)
  // **The version is this repository's, never the model's.**
  assert.equal(good.categoryVersion, CATEGORY_VERSION)
  assert.equal(good.origin, 'model')

  for (const bad of [
    { question: 123 },
    { resolutionSourceRef: undefined },
    { closeTimeIso: 'not a date' },
    { category: null },
  ]) {
    assert.equal(
      toProposal(
        {
          question: 'Will X happen?',
          resolutionCriteria: 'Criteria.',
          category: 'protocol_network',
          resolutionSourceKind: 'block_explorer',
          resolutionSourceRef: 'https://example.invalid/x',
          closeTimeIso: '2027-01-01T00:00:00.000Z',
          ...bad,
        },
        provenance,
      ),
      null,
      `${JSON.stringify(bad)} was accepted`,
    )
  }
})

/* ------------------------------------------------------------------ chain constants */

/**
 * **Nothing here redefines a chain constant.**
 *
 * These come from `@cloudsforge/contracts-chain`, which is exact-pinned so this service and custody
 * cannot disagree about a chain id. A skew there is a market contract bound to the wrong network.
 */
test('the chain constants come from the pinned package, not from this repository', () => {
  assert.equal(chainIdOf('ember', 'mainnet'), 7411)
  assert.equal(chainIdOf('ember', 'testnet'), 7412)
  assert.equal(requiredConfirmations('ember'), 60)
})
