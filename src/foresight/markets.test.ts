/**
 * The lifecycle, and the two enforcements of the rule that matters most.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN UNAPPROVED IDEA CAN NEVER REACH `open`** — 19-new-products.md §2.4 requires a state-machine
 * test *and* a DB constraint, the beacon discipline. Both are here, and they are tested SEPARATELY
 * and DELIBERATELY:
 *
 *   * the state-machine tests go through `approveMarket`/`openMarket` and assert the error;
 *   * the constraint tests go round them, with raw SQL, exactly as a future second write path or a
 *     3am `psql` session would — and assert the database refuses.
 *
 * Testing only the first would leave the constraint unproven, which is the same as not having it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { approveIdea, discardIdea, editIdea, findIdea } from './ideas.ts'
import {
  MarketError,
  TRANSITIONS,
  approveMarket,
  canTransition,
  closeMarket,
  createDraft,
  findMarket,
  markResolved,
  markSettled,
  openMarket,
  voidMarket,
} from './markets.ts'
import { withOutbox } from './outbox.ts'
import {
  OPERATOR,
  approveDirect,
  db,
  enabled,
  migrateTestDb,
  openDb,
  resetForesight,
  seedDraft,
  seedIdea,
  skip,
  FUTURE,
} from './testsupport.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetForesight(sql)
})

const CONTRACT = '0x4444444444444444444444444444444444444444'

/* ------------------------------------------------------------------ the transition table */

test('the transition table is the lifecycle, and settled and void are terminal', () => {
  assert.deepEqual([...TRANSITIONS.settled], [])
  assert.deepEqual([...TRANSITIONS.void], [])
  assert.equal(canTransition('draft', 'approved'), true)
  assert.equal(canTransition('approved', 'open'), true)
  assert.equal(canTransition('open', 'closed'), true)
  assert.equal(canTransition('closed', 'resolved'), true)
  assert.equal(canTransition('resolved', 'settled'), true)
  // Void from everywhere that is not terminal — a missing source is discovered whenever it is.
  for (const from of ['draft', 'approved', 'open', 'closed', 'resolved'] as const) {
    assert.equal(canTransition(from, 'void'), true, `${from} cannot void`)
  }
  // And the ones that must not exist.
  assert.equal(canTransition('draft', 'open'), false, 'a draft can reach open without approval')
  assert.equal(canTransition('open', 'resolved'), false, 'an open market can resolve without closing')
  assert.equal(canTransition('settled', 'void'), false, 'a settled market can be voided after payment')
  assert.equal(canTransition('void', 'open'), false)
})

/* ------------------------------------------------------------------ the state machine */

test('a market built from an unapproved proposal cannot be approved', { skip }, async () => {
  const idea = await seedIdea(sql)
  assert.equal(idea.status, 'proposed')
  const market = await seedDraft(sql, { ideaId: idea.id })

  await assert.rejects(
    withOutbox(db(sql), 'test', async (tx) => approveMarket(tx, market.id, OPERATOR, new Date(), null)),
    (err: unknown) => err instanceof MarketError && err.code === 'idea_not_approved',
    'a market from an unapproved proposal was approved',
  )
  assert.equal((await findMarket(db(sql), market.id))?.status, 'draft')
})

test('a service subject cannot approve — only an operator', { skip }, async () => {
  const market = await seedDraft(sql)
  for (const notAnOperator of ['service:foresight', 'user:abc', 'system', 'operator', '']) {
    await assert.rejects(
      withOutbox(db(sql), 'test', async (tx) =>
        approveMarket(tx, market.id, notAnOperator, new Date(), null),
      ),
      /operator/,
      `${notAnOperator} was allowed to approve`,
    )
  }
})

test('the full happy path: proposal → approval → draft → approved → open → closed → resolved → settled', { skip }, async () => {
  const idea = await approveIdea(db(sql), (await seedIdea(sql)).id, OPERATOR, 'reads well', new Date())
  assert.equal(idea.status, 'approved')

  const market = await seedDraft(sql, { ideaId: idea.id })
  assert.equal(market.status, 'draft')
  assert.equal(market.ideaStatus, 'approved')

  const approved = await withOutbox(db(sql), 'test', async (tx) =>
    approveMarket(tx, market.id, OPERATOR, new Date(), null),
  )
  assert.equal(approved.status, 'approved')
  assert.equal(approved.approvedBy, OPERATOR)

  // Not openable without a contract, however approved it is.
  await assert.rejects(
    withOutbox(db(sql), 'test', async (tx, emit) =>
      openMarket(tx, emit, market.id, OPERATOR, new Date(), null),
    ),
    (err: unknown) => err instanceof MarketError && err.code === 'not_deployed',
  )

  await sql`
    update markets set deploy_state = 'deployed', contract_address = ${CONTRACT},
      raw_tx = '0xaa', deploy_tx_hash = ${'0x' + '11'.repeat(32)} where id = ${market.id}
  `
  const opened = await withOutbox(db(sql), 'test', async (tx, emit) =>
    openMarket(tx, emit, market.id, OPERATOR, new Date(), null),
  )
  assert.equal(opened.status, 'open')

  // Closing before the close time is refused: the contract has not closed itself yet either.
  await assert.rejects(
    withOutbox(db(sql), 'test', async (tx, emit) =>
      closeMarket(tx, emit, market.id, 'service:test', new Date(), null),
    ),
    (err: unknown) => err instanceof MarketError && err.code === 'not_due',
  )

  const past = new Date(market.closeTime.getTime() + 1_000)
  const closed = await withOutbox(db(sql), 'test', async (tx, emit) =>
    closeMarket(tx, emit, market.id, 'service:test', past, null),
  )
  assert.equal(closed.status, 'closed')

  const resolved = await withOutbox(db(sql), 'test', async (tx, emit) =>
    markResolved(tx, emit, market.id, 0, 'service:test', past, null),
  )
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.outcome, 0)

  const settled = await withOutbox(db(sql), 'test', async (tx, emit) =>
    markSettled(tx, emit, market.id, 'service:test', past, null),
  )
  assert.equal(settled.status, 'settled')

  // Terminal. A status change after the money has moved would be a lie about a payment.
  await assert.rejects(
    withOutbox(db(sql), 'test', async (tx, emit) =>
      voidMarket(tx, emit, market.id, 'changed my mind', OPERATOR, past, null),
    ),
    (err: unknown) => err instanceof MarketError && err.code === 'bad_transition',
  )

  // Every transition is on the audit trail, in order.
  const trail = await sql<{ from_status: string; to_status: string; actor: string }[]>`
    select from_status, to_status, actor from market_transitions where market_id = ${market.id} order by id
  `
  assert.deepEqual(
    trail.map((row) => `${row.from_status}->${row.to_status}`),
    ['draft->approved', 'approved->open', 'open->closed', 'closed->resolved', 'resolved->settled'],
  )
})

test('every lifecycle transition emits exactly one outbox event on the public topics', { skip }, async () => {
  const market = await seedDraft(sql)
  await approveDirect(sql, market.id)
  await sql`
    update markets set deploy_state = 'deployed', contract_address = ${CONTRACT},
      raw_tx = '0xaa', deploy_tx_hash = ${'0x' + '22'.repeat(32)} where id = ${market.id}
  `
  await withOutbox(db(sql), 'test', async (tx, emit) =>
    openMarket(tx, emit, market.id, OPERATOR, new Date(), null),
  )
  const events = await sql<{ topic: string; payload: Record<string, unknown> }[]>`
    select topic, payload from outbox order by occurred_at
  `
  assert.equal(events.length, 1)
  assert.equal(events[0]?.topic, 'foresight.market.opened')
  // The payload is the PUBLIC view. An event goes towards a user, and every internal field that
  // rides along is a field that ends up in a bundle somebody can read.
  const payload = events[0]?.payload ?? {}
  assert.ok('question' in payload && 'contractAddress' in payload)
  for (const internal of ['approvedBy', 'rawTx', 'custodyAuditId', 'leaseOwner', 'deployerAddress']) {
    assert.equal(internal in payload, false, `${internal} leaked into an event payload`)
  }
})

test('voiding requires a reason, and the reason is on the row and the event', { skip }, async () => {
  const market = await seedDraft(sql)
  await assert.rejects(
    withOutbox(db(sql), 'test', async (tx, emit) =>
      voidMarket(tx, emit, market.id, '   ', OPERATOR, new Date(), null),
    ),
    (err: unknown) => err instanceof MarketError && err.code === 'no_reason',
  )
  const voided = await withOutbox(db(sql), 'test', async (tx, emit) =>
    voidMarket(tx, emit, market.id, 'the named source no longer exists', OPERATOR, new Date(), null),
  )
  assert.equal(voided.status, 'void')
  assert.equal(voided.voidReason, 'the named source no longer exists')
  assert.ok(voided.voidedAt)
})

/* ------------------------------------------------------------------ the DB constraint */

/**
 * The SECOND enforcement, tested by going round the first.
 *
 * These UPDATEs are exactly what a future code path, a data fix, or a migration written in a hurry
 * would do. Every one of them must fail in the database.
 */
test('THE CONSTRAINT: raw SQL cannot open a market from an unapproved proposal', { skip }, async () => {
  const idea = await seedIdea(sql)
  const market = await seedDraft(sql, { ideaId: idea.id })

  await assert.rejects(
    sql`
      update markets set status = 'open', approved_by = ${OPERATOR}, approved_at = now(),
        deploy_state = 'deployed', contract_address = ${CONTRACT},
        raw_tx = '0xaa', deploy_tx_hash = ${'0x' + '33'.repeat(32)}
       where id = ${market.id}
    `,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'markets_unapproved_never_opens',
    'the database allowed an unapproved proposal to reach open',
  )
})

test('THE CONSTRAINT: raw SQL cannot open a market nobody approved at all', { skip }, async () => {
  const market = await seedDraft(sql)
  await assert.rejects(
    sql`
      update markets set status = 'approved' where id = ${market.id}
    `,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'markets_unapproved_never_opens',
    'the database allowed a market with no approver to leave draft',
  )
})

test('THE CONSTRAINT: a service cannot be the approver, even in raw SQL', { skip }, async () => {
  const market = await seedDraft(sql)
  // The exact row a bug that wrote `service:foresight` into `approved_by` would produce. The
  // `like 'operator:%'` clause is what makes this impossible rather than merely discouraged.
  await assert.rejects(
    sql`
      update markets set status = 'approved', approved_by = 'service:foresight', approved_at = now()
       where id = ${market.id}
    `,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'markets_unapproved_never_opens',
    'a service approved a market in the database',
  )
})

/**
 * The direction nobody remembers to test.
 *
 * `on update cascade` keeps `markets.idea_status` honest, so discarding an idea whose market is
 * already open would cascade `idea_status = 'discarded'` onto the market row — and the CHECK then
 * refuses the whole UPDATE. The idea cannot be un-approved while a live market rests on it.
 */
test('THE CONSTRAINT: an approved idea cannot be discarded under an open market', { skip }, async () => {
  const idea = await approveIdea(db(sql), (await seedIdea(sql)).id, OPERATOR, null, new Date())
  const market = await seedDraft(sql, { ideaId: idea.id })
  await approveDirect(sql, market.id)
  await sql`
    update markets set deploy_state = 'deployed', contract_address = ${CONTRACT},
      raw_tx = '0xaa', deploy_tx_hash = ${'0x' + '44'.repeat(32)}, status = 'open', opened_at = now()
     where id = ${market.id}
  `

  await assert.rejects(
    sql`update ideas set status = 'discarded', refusal_id = 'unverifiable_resolution' where id = ${idea.id}`,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'markets_unapproved_never_opens',
    'an idea under an open market was un-approved',
  )
  assert.equal((await findIdea(db(sql), idea.id))?.status, 'approved')
})

/**
 * BOTH DIRECTIONS of the precision fix, pinned.
 *
 * The constraint originally read `status = 'draft' or (approved…)`, and it fired on CORRECT code:
 * voiding an unapproved draft — which is the safest thing anybody can do to a market — was
 * impossible, so a proposal nobody wanted could only be disposed of by first approving it. The fix
 * exempted `void` alongside `draft`. This test is the pair that keeps the fix honest: the correct
 * case must pass, and the planted violation must still be caught.
 */
test('THE CONSTRAINT: void is exempt, and that exemption does not open a way to `open`', { skip }, async () => {
  // Direction 1 — CORRECT CODE PASSES. An unapproved draft can be voided, in raw SQL, by anybody.
  const disposable = await seedDraft(sql)
  await sql`
    update markets set status = 'void', void_reason = 'nobody wanted it', voided_at = now()
     where id = ${disposable.id}
  `
  assert.equal((await findMarket(db(sql), disposable.id))?.status, 'void')

  // Direction 2 — THE PLANTED VIOLATION IS STILL CAUGHT. Going void-first and then to `open`
  // buys nothing: `open` needs the approval clause and always did.
  const smuggled = await seedDraft(sql)
  await sql`
    update markets set status = 'void', void_reason = 'x', voided_at = now(),
      deploy_state = 'deployed', contract_address = ${CONTRACT},
      raw_tx = '0xaa', deploy_tx_hash = ${'0x' + '66'.repeat(32)}
     where id = ${smuggled.id}
  `
  await assert.rejects(
    sql`update markets set status = 'open', opened_at = now() where id = ${smuggled.id}`,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'markets_unapproved_never_opens',
    'a market reached open with no approver by way of void',
  )
})

test('THE CONSTRAINT: a market cannot be open without a contract to stake into', { skip }, async () => {
  const market = await seedDraft(sql)
  await approveDirect(sql, market.id)
  await assert.rejects(
    sql`update markets set status = 'open', opened_at = now() where id = ${market.id}`,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'markets_open_has_contract',
    'a market went open with no contract address',
  )
})

test('THE CONSTRAINT: a resolved market must say what it resolved to, and a void one why', { skip }, async () => {
  const market = await seedDraft(sql)
  await approveDirect(sql, market.id)
  await sql`
    update markets set deploy_state = 'deployed', contract_address = ${CONTRACT},
      raw_tx = '0xaa', deploy_tx_hash = ${'0x' + '55'.repeat(32)}, status = 'closed', closed_at = now()
     where id = ${market.id}
  `
  await assert.rejects(
    sql`update markets set status = 'resolved', resolved_at = now() where id = ${market.id}`,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'markets_resolved_has_outcome',
  )
  await assert.rejects(
    sql`update markets set status = 'void', voided_at = now() where id = ${market.id}`,
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'markets_void_has_reason',
  )
})

/**
 * The market DOES NOT need an idea. An operator may write the question themselves — §2.3.3 says
 * "approves, edits, or discards", and a question typed by an accountable person is the case the
 * whole pipeline is a convenience for.
 */
test('a market an operator wrote from scratch needs no proposal', { skip }, async () => {
  const market = await seedDraft(sql)
  assert.equal(market.ideaId, null)
  const approved = await withOutbox(db(sql), 'test', async (tx) =>
    approveMarket(tx, market.id, OPERATOR, new Date(), null),
  )
  assert.equal(approved.status, 'approved')
})

/* ------------------------------------------------------------------ the idea queue */

test('a decided proposal cannot be decided twice, or edited', { skip }, async () => {
  const idea = await seedIdea(sql)
  await approveIdea(db(sql), idea.id, OPERATOR, null, new Date())
  await assert.rejects(approveIdea(db(sql), idea.id, OPERATOR, null, new Date()), /awaiting a decision/)
  await assert.rejects(
    discardIdea(db(sql), idea.id, OPERATOR, 'death_or_violence', null, new Date()),
    /awaiting a decision/,
  )
  // Editing after approval would change the text a market's `questionHash` was computed over,
  // which is the exact dishonesty questiondoc.ts exists to prevent.
  await assert.rejects(
    editIdea(
      db(sql),
      idea.id,
      {
        question: 'Something else entirely?',
        resolutionCriteria: 'x'.repeat(30),
        category: 'protocol_network',
        categoryVersion: 1,
        resolutionSourceKind: 'block_explorer',
        resolutionSourceRef: 'https://example.invalid/z',
        suggestedCloseTime: FUTURE(),
      },
      new Date(),
    ),
    /cannot be edited/,
  )
})

test('a discard names one of the recorded refusals, never free text', { skip }, async () => {
  const idea = await seedIdea(sql)
  await assert.rejects(
    discardIdea(db(sql), idea.id, OPERATOR, 'i just did not like it', null, new Date()),
    /recorded refusal reasons/,
  )
  const discarded = await discardIdea(
    db(sql),
    idea.id,
    OPERATOR,
    'unverifiable_resolution',
    'no public source states this',
    new Date(),
  )
  assert.equal(discarded.status, 'discarded')
  assert.equal(discarded.refusalId, 'unverifiable_resolution')
})

test('a model-authored proposal without provenance is not storable', { skip }, async () => {
  await assert.rejects(seedIdea(sql, { modelId: undefined }), /model id, prompt hash and search query/)
  await assert.rejects(seedIdea(sql, { searchQuery: undefined }), /model id, prompt hash and search query/)
  await assert.rejects(seedIdea(sql, { sources: [] }), /at least one source/)
})

test('a proposal outside the allowlist is refused at the gate', { skip }, async () => {
  await assert.rejects(seedIdea(sql, { category: 'politics' }), /not an allowed market category/)
  await assert.rejects(
    seedIdea(sql, { category: 'protocol_network', resolutionSourceKind: 'exchange_api' }),
    /not a resolution source this category/,
  )
  await assert.rejects(seedIdea(sql, { suggestedCloseTime: new Date(Date.now() - 1_000) }), /already past/)
})

test('an edited proposal is still recorded as having been written by a machine', { skip }, async () => {
  const idea = await seedIdea(sql)
  const edited = await editIdea(
    db(sql),
    idea.id,
    {
      question: 'Will Hearth mainnet reach block height 6,000,000 before 2028-01-01T00:00:00Z?',
      resolutionCriteria: 'YES if the block at height 6,000,000 has a timestamp before that instant.',
      category: 'protocol_network',
      categoryVersion: 1,
      resolutionSourceKind: 'block_explorer',
      resolutionSourceRef: 'https://explorer.cloudsforge.online/#/block/6000000',
      suggestedCloseTime: FUTURE(),
    },
    new Date(),
  )
  assert.ok(edited.question.includes('6,000,000'))
  // An edit does not launder a model's draft into an operator's own work. The public page shows
  // that a machine wrote the first version.
  assert.equal(edited.origin, 'model')
  assert.equal(edited.modelId, 'test-model-1')
})

/* ------------------------------------------------------------------ the question hash */

test('the market’s stored hash is the hash of the document it will publish', { skip }, async () => {
  const market = await createDraft(
    db(sql),
    {
      question: 'Will Hearth mainnet reach block height 5,000,000 before 2027-01-01T00:00:00Z?',
      resolutionCriteria: 'YES if the named explorer shows that block before the instant given.',
      category: 'protocol_network',
      resolutionSourceKind: 'block_explorer',
      resolutionSourceRef: 'https://explorer.cloudsforge.online/#/block/5000000',
      closeTime: FUTURE(),
      disputeWindowSeconds: 86_400,
      feeBps: 200,
      network: 'testnet',
    },
    new Date(),
  )
  assert.match(market.questionHash, /^0x[0-9a-f]{64}$/)

  // Two markets differing only in their named source have different hashes, which is what makes
  // "the source is named at open" a fact about the chain rather than a promise.
  const other = await createDraft(
    db(sql),
    {
      question: 'Will Hearth mainnet reach block height 5,000,000 before 2027-01-01T00:00:00Z?',
      resolutionCriteria: 'YES if the named explorer shows that block before the instant given.',
      category: 'protocol_network',
      resolutionSourceKind: 'block_explorer',
      resolutionSourceRef: 'https://a-different-explorer.invalid/block/5000000',
      closeTime: market.closeTime,
      disputeWindowSeconds: 86_400,
      feeBps: 200,
      network: 'testnet',
    },
    new Date(),
  )
  assert.notEqual(other.questionHash, market.questionHash)
})
