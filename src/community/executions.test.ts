/**
 * Execution: the timelock, and exactly once.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE THREE TESTS THIS FILE EXISTS FOR.**
 *
 *   1. `execution before the timelock expires is refused by the database, handler bypassed`
 *      A raw INSERT into `executions`. No `executeProposal`, no policy client, no ledger. If this
 *      passes, the timelock is a property of the schema and survives any rewrite of the service —
 *      which is the only version of the claim worth making. The same discipline as `foresight`'s
 *      "resolution before close is impossible" and `ledger`'s deferred constraint.
 *
 *   2. `two concurrent executors produce exactly one execution and one ledger entry`
 *      Two connections calling `executeProposal` at the same moment. `for update` on the proposal
 *      row serialises them; the loser reads the committed row and answers `already` without
 *      calling the ledger at all. `fakeLedger.keys.size` is the count of ACTUAL postings — the
 *      fake replays a repeated idempotency key exactly as the real ledger does, so a design that
 *      called the ledger twice would still show one key and would be caught by `calls.length`.
 *
 *   3. `a treasury spend cannot commit without naming its ledger entry`
 *      The DEFERRED constraint trigger, proven by inserting an execution and committing without
 *      writing the entry id. It fails at COMMIT, not at INSERT, which is what makes the real
 *      ordering (row first, ledger second) legal in the first place.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  SpendRefusedError,
  countExecutions,
  executeProposal,
  findExecution,
} from './executions.ts'
import { PolicyUnavailableError } from './policyclient.ts'
import { LedgerUnavailableError, idempotencyKeys } from './ledgerclient.ts'
import { findProposal } from './proposals.ts'
import { emitOn } from './jobs.ts'
import {
  asDb,
  asTx,
  fakeLedger,
  fakePolicy,
  migrateTestDb,
  openDb,
  resetCommunity,
  seedCommunity,
  seedProposal,
  seedTreasuryAccount,
  skip,
  subject,
} from './testsupport.ts'
import type { FakeLedger, FakePolicy } from './testsupport.ts'
import type { Community } from './communities.ts'
import type { Proposal } from './proposals.ts'

let sql: postgres.Sql
let community: Community
let ledger: FakeLedger
let policy: FakePolicy

const OWNER = subject('owner')
const PAYEE = subject('payee')
const SPEND = 1_000_000n

before(async () => {
  if (!skip) {
    sql = openDb()
    await migrateTestDb(sql)
  }
})

after(async () => {
  if (!skip) await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (skip) return
  await resetCommunity(sql)
  community = await seedCommunity(sql, { ownerSubject: OWNER })
  await seedTreasuryAccount(sql, community, 'EMBER')
  ledger = fakeLedger()
  policy = fakePolicy()
})

/** A treasury spend proposal, already timelocked, whose timelock has (or has not) expired. */
async function spendProposal(options: { expired: boolean }): Promise<Proposal> {
  const now = Date.now()
  const closesAt = new Date(now - 7_200_000)
  const timelockUntil = options.expired
    ? new Date(now - 60_000)
    : new Date(now + 3_600_000)
  return seedProposal(sql, community, {
    kind: 'treasury_spend',
    opensAt: new Date(now - 10_800_000),
    closesAt,
    timelockUntil,
    spend: { assetCode: 'EMBER', amount: SPEND, recipient: PAYEE },
    status: 'timelocked',
  })
}

function deps(): { sql: ReturnType<typeof asDb>; ledger: FakeLedger; policy: FakePolicy; producer: string } {
  return { sql: asDb(sql), ledger, policy, producer: 'community' }
}

const emit = (tx: ReturnType<typeof asTx>, event: Parameters<typeof emitOn>[2]) =>
  emitOn(tx, 'community', event)

/* ------------------------------------------------------------------ 1. the timelock */

test('execution before the timelock expires is refused by the database, handler bypassed', { skip }, async () => {
  const proposal = await spendProposal({ expired: false })

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // A RAW INSERT. `executeProposal` is not called; neither is the policy client nor the ledger.
  // The only thing standing between this statement and a committed execution is
  // `community_assert_execution_timelock`.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  await assert.rejects(
    () => sql`
      insert into executions (proposal_id, kind, executed_by, idempotency_key, correlation_id,
                              ledger_entry_id)
      values (${proposal.id}, 'treasury_spend', 'operator:rogue',
              ${idempotencyKeys.execute(proposal.id)}, 'c1', 'entry-forged')
    `,
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23514')
      assert.match(String((err as Error).message), /is under timelock until/)
      return true
    },
  )

  assert.equal(await countExecutions(sql, proposal.id), 0)
})

test('the same insert succeeds once the timelock has expired — the guard is the CLOCK, not the row', { skip }, async () => {
  // Both directions. A guard that refused everything would pass the test above and be useless.
  const proposal = await spendProposal({ expired: true })
  await sql`
    insert into executions (proposal_id, kind, executed_by, idempotency_key, correlation_id,
                            ledger_entry_id)
    values (${proposal.id}, 'treasury_spend', 'operator:ops',
            ${idempotencyKeys.execute(proposal.id)}, 'c1', 'entry-1')
  `
  assert.equal(await countExecutions(sql, proposal.id), 1)
})

test('a proposal that is not `timelocked` may not execute, whatever the clock says', { skip }, async () => {
  // The timestamp check alone would let a `draft` execute the moment its defaulted timelock passed.
  for (const status of ['draft', 'discussion', 'voting', 'passed', 'rejected', 'cancelled']) {
    const proposal = await seedProposal(sql, community, {
      kind: 'text',
      closesAt: new Date(Date.now() - 7_200_000),
      timelockUntil: new Date(Date.now() - 3_600_000),
      opensAt: new Date(Date.now() - 10_800_000),
      status,
    })
    await assert.rejects(
      () => sql`
        insert into executions (proposal_id, kind, executed_by, idempotency_key, correlation_id)
        values (${proposal.id}, 'text', 'operator:ops', ${`k-${proposal.id}`}, 'c1')
      `,
      (err: unknown) => {
        assert.match(
          String((err as Error).message),
          new RegExp(`is ${status} — only a timelocked proposal may execute`),
        )
        return true
      },
      `a ${status} proposal was allowed to execute`,
    )
  }
})

test('the executor answers 409-shaped TimelockError rather than posting', { skip }, async () => {
  const proposal = await spendProposal({ expired: false })
  await assert.rejects(
    () => executeProposal(deps(), emit, { proposalId: proposal.id, executedBy: 'op', correlationId: 'c' }),
    /is under timelock until/,
  )
  // The important half: the money did not move first and then get refused.
  assert.equal(ledger.calls.length, 0, 'the ledger was called before the timelock was checked')
})

test('an execution may not name a kind its proposal does not have', { skip }, async () => {
  const proposal = await spendProposal({ expired: true })
  await assert.rejects(
    () => sql`
      insert into executions (proposal_id, kind, executed_by, idempotency_key, correlation_id)
      values (${proposal.id}, 'text', 'operator:ops', ${`k-${proposal.id}`}, 'c1')
    `,
    /does not match proposal kind/,
  )
})

/* ------------------------------------------------------------------ 2. exactly once */

test('a treasury spend reaches the ledger as one balanced entry', { skip }, async () => {
  const proposal = await spendProposal({ expired: true })
  const outcome = await executeProposal(deps(), emit, {
    proposalId: proposal.id,
    executedBy: 'service:community',
    correlationId: 'corr-1',
  })

  assert.equal(outcome.status, 'executed')
  assert.equal(ledger.calls.length, 1)
  const call = ledger.calls[0]!
  assert.equal(call.kind, 'treasury_spend')
  assert.equal(call.actor, 'service:community')
  // DERIVED from the proposal, so a retry presents the same key. See ledgerclient.ts.
  assert.equal(call.idempotencyKey, `community:execute:${proposal.id}`)

  assert.equal(call.postings.length, 2)
  const debit = call.postings.find((p) => p.direction === 'debit')!
  const credit = call.postings.find((p) => p.direction === 'credit')!
  assert.equal(debit.account.subject, community.treasurySubject)
  assert.equal(debit.account.purpose, 'treasury')
  assert.equal(debit.account.type, 'liability')
  assert.equal(credit.account.subject, PAYEE)
  assert.equal(credit.account.purpose, 'available')
  assert.equal(credit.account.type, 'liability')
  // Balanced by construction, and both sides bigint.
  assert.equal(debit.amount, SPEND)
  assert.equal(credit.amount, SPEND)

  const execution = await findExecution(sql, proposal.id)
  assert.equal(execution?.ledgerEntryId, 'entry-1')
  const after = await findProposal(sql, proposal.id)
  assert.equal(after?.status, 'executed')
  assert.equal(after?.executionId, execution?.id)
})

test('two concurrent executors produce exactly one execution and one ledger entry', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // TWO CONNECTIONS. `for update` on the proposal row serialises them: the loser waits, reads the
  // committed row, sees `executed`, and answers `already` WITHOUT reaching the ledger.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const proposal = await spendProposal({ expired: true })
  const one = openDb(2)
  const two = openDb(2)
  try {
    const run = (client: postgres.Sql) =>
      executeProposal(
        { sql: asDb(client), ledger, policy, producer: 'community' },
        emit,
        { proposalId: proposal.id, executedBy: 'service:community', correlationId: 'corr-race' },
      )

    const results = await Promise.all([run(one), run(two)])
    const statuses = results.map((r) => r.status).sort()
    assert.deepEqual(statuses, ['already', 'executed'], `got ${statuses.join(',')}`)

    assert.equal(await countExecutions(sql, proposal.id), 1, 'two execution rows')
    assert.equal(ledger.calls.length, 1, 'the ledger was called twice')
    assert.equal(ledger.keys.size, 1, 'two distinct ledger entries were posted')
  } finally {
    await one.end({ timeout: 5 })
    await two.end({ timeout: 5 })
  }
})

test('a second execution attempt after the fact is `already`, and posts nothing', { skip }, async () => {
  const proposal = await spendProposal({ expired: true })
  const first = await executeProposal(deps(), emit, {
    proposalId: proposal.id,
    executedBy: 'a',
    correlationId: 'c1',
  })
  assert.equal(first.status, 'executed')

  const second = await executeProposal(deps(), emit, {
    proposalId: proposal.id,
    executedBy: 'b',
    correlationId: 'c2',
  })
  assert.equal(second.status, 'already')
  assert.equal(ledger.calls.length, 1)
  // And no second policy decision was even asked for — the `executed` short-circuit runs first.
  assert.equal(policy.calls.length, 1)
})

test('the unique constraint refuses a second execution with the handler bypassed', { skip }, async () => {
  const proposal = await spendProposal({ expired: true })
  await sql`
    insert into executions (proposal_id, kind, executed_by, idempotency_key, correlation_id,
                            ledger_entry_id)
    values (${proposal.id}, 'treasury_spend', 'op', ${idempotencyKeys.execute(proposal.id)}, 'c1', 'e1')
  `
  // The proposal is still `timelocked` here, so the timelock trigger allows the insert and the
  // UNIQUE is the only thing left to refuse it. That ordering matters: it proves the two guards
  // are independent rather than one masking the other.
  await assert.rejects(
    () => sql`
      insert into executions (proposal_id, kind, executed_by, idempotency_key, correlation_id,
                              ledger_entry_id)
      values (${proposal.id}, 'treasury_spend', 'op2', ${`${idempotencyKeys.execute(proposal.id)}-b`}, 'c2', 'e2')
    `,
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23505')
      assert.match(String((err as { constraint_name?: string }).constraint_name ?? ''), /executions_proposal_uniq/)
      return true
    },
  )
})

test('an execution may not be re-pointed at another ledger entry', { skip }, async () => {
  const proposal = await spendProposal({ expired: true })
  await executeProposal(deps(), emit, { proposalId: proposal.id, executedBy: 'a', correlationId: 'c' })
  await assert.rejects(
    () => sql`update executions set ledger_entry_id = 'entry-forged' where proposal_id = ${proposal.id}`,
    /already names ledger entry/,
  )
})

/* ------------------------------------------------------------------ 3. the deferred constraint */

test('a treasury spend cannot commit without naming its ledger entry', { skip }, async () => {
  const proposal = await spendProposal({ expired: true })
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        // The INSERT succeeds — that is the whole point of deferring. The failure is at COMMIT.
        await tx`
          insert into executions (proposal_id, kind, executed_by, idempotency_key, correlation_id)
          values (${proposal.id}, 'treasury_spend', 'op', ${idempotencyKeys.execute(proposal.id)}, 'c1')
        `
        return { done: true }
      }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, '23514')
      assert.match(String((err as Error).message), /names no ledger entry/)
      return true
    },
  )
  assert.equal(await countExecutions(sql, proposal.id), 0, 'the failed COMMIT left a row behind')
})

test('the constraint is DEFERRED — the row may exist un-named mid-transaction', { skip }, async () => {
  // The other direction, and the reason the constraint cannot be immediate: the real path inserts
  // the row (so the timelock fires before any money moves) and writes the entry id a moment later.
  const proposal = await spendProposal({ expired: true })
  await sql.begin(async (tx) => {
    await tx`
      insert into executions (proposal_id, kind, executed_by, idempotency_key, correlation_id)
      values (${proposal.id}, 'treasury_spend', 'op', ${idempotencyKeys.execute(proposal.id)}, 'c1')
    `
    await tx`update executions set ledger_entry_id = 'entry-late' where proposal_id = ${proposal.id}`
    return { done: true }
  })
  const execution = await findExecution(sql, proposal.id)
  assert.equal(execution?.ledgerEntryId, 'entry-late')
})

test('a non-spend execution needs no ledger entry', { skip }, async () => {
  const proposal = await seedProposal(sql, community, {
    kind: 'text',
    opensAt: new Date(Date.now() - 10_800_000),
    closesAt: new Date(Date.now() - 7_200_000),
    timelockUntil: new Date(Date.now() - 60_000),
    status: 'timelocked',
  })
  const outcome = await executeProposal(deps(), emit, {
    proposalId: proposal.id,
    executedBy: 'op',
    correlationId: 'c',
  })
  assert.equal(outcome.status, 'executed')
  // A `text` proposal executing moves nothing, and says so.
  assert.equal(ledger.calls.length, 0)
  assert.equal(policy.calls.length, 0, 'policy was asked about a proposal that spends nothing')
  assert.equal((await findExecution(sql, proposal.id))?.ledgerEntryId, null)
})

/* ------------------------------------------------------------------ the gate */

test('policy is fail-closed: an unreachable gate does not spend', { skip }, async () => {
  const proposal = await spendProposal({ expired: true })
  policy.failWith(new PolicyUnavailableError('connection refused'))

  await assert.rejects(
    () => executeProposal(deps(), emit, { proposalId: proposal.id, executedBy: 'op', correlationId: 'c' }),
    PolicyUnavailableError,
  )
  assert.equal(ledger.calls.length, 0)
  assert.equal(await countExecutions(sql, proposal.id), 0)
  // Left `timelocked`, which is the state the next attempt (and an operator) can act on.
  assert.equal((await findProposal(sql, proposal.id))?.status, 'timelocked')
})

test('a deny is a refusal, and a review is treated as one', { skip }, async () => {
  for (const decision of ['deny', 'review'] as const) {
    const proposal = await spendProposal({ expired: true })
    policy.answer({ decision, reasons: ['velocity'] })
    await assert.rejects(
      () => executeProposal(deps(), emit, { proposalId: proposal.id, executedBy: 'op', correlationId: 'c' }),
      SpendRefusedError,
    )
    assert.equal(await countExecutions(sql, proposal.id), 0)
  }
  assert.equal(ledger.calls.length, 0)
})

test('policy is asked with the amount as a decimal string', { skip }, async () => {
  const proposal = await spendProposal({ expired: true })
  await executeProposal(deps(), emit, { proposalId: proposal.id, executedBy: 'op', correlationId: 'c' })
  const call = policy.calls[0] as { amount: unknown; assetCode: unknown; communityId: unknown }
  assert.equal(typeof call.amount, 'string')
  assert.equal(call.amount, SPEND.toString())
  assert.equal(call.assetCode, 'EMBER')
  assert.equal(call.communityId, community.id)
})

/* ------------------------------------------------------------------ the ledger failing */

test('a ledger failure rolls the whole execution back', { skip }, async () => {
  const proposal = await spendProposal({ expired: true })
  ledger.failNext(new LedgerUnavailableError('timeout'))

  await assert.rejects(
    () => executeProposal(deps(), emit, { proposalId: proposal.id, executedBy: 'op', correlationId: 'c' }),
    LedgerUnavailableError,
  )
  // No execution row, no outbox event, and the proposal is still executable.
  assert.equal(await countExecutions(sql, proposal.id), 0)
  const events = await sql<{ n: number }[]>`
    select count(*)::int as n from outbox where topic = 'community.proposal.executed'
  `
  assert.equal(events[0]?.n, 0, 'an executed event was published for an execution that rolled back')
  assert.equal((await findProposal(sql, proposal.id))?.status, 'timelocked')

  // And the retry works, with the same derived key.
  const retry = await executeProposal(deps(), emit, {
    proposalId: proposal.id,
    executedBy: 'op',
    correlationId: 'c',
  })
  assert.equal(retry.status, 'executed')
  assert.equal(ledger.keys.size, 1)
})

test('a spend against an undeclared asset is refused rather than opening a new account', { skip }, async () => {
  const proposal = await seedProposal(sql, community, {
    kind: 'treasury_spend',
    opensAt: new Date(Date.now() - 10_800_000),
    closesAt: new Date(Date.now() - 7_200_000),
    timelockUntil: new Date(Date.now() - 60_000),
    // SHARD was never declared. The ledger creates accounts on first posting, so without this
    // check a community would silently acquire a treasury account it never agreed to hold.
    spend: { assetCode: 'SHARD', amount: 5n, recipient: PAYEE },
    status: 'timelocked',
  })
  await assert.rejects(
    () => executeProposal(deps(), emit, { proposalId: proposal.id, executedBy: 'op', correlationId: 'c' }),
    /holds no declared SHARD treasury account/,
  )
  assert.equal(ledger.calls.length, 0)
})

/* ------------------------------------------------------------------ the event */

test('the executed event is written in the same transaction and names the entry', { skip }, async () => {
  const proposal = await spendProposal({ expired: true })
  await executeProposal(deps(), emit, { proposalId: proposal.id, executedBy: 'op', correlationId: 'corr-9' })

  const rows = await sql<{ topic: string; key: string; correlation_id: string; payload: Record<string, unknown> }[]>`
    select topic, key, correlation_id, payload from outbox where topic = 'community.proposal.executed'
  `
  assert.equal(rows.length, 1)
  const event = rows[0]!
  // Keyed by proposal_id, as 07-dependency-map.md states.
  assert.equal(event.key, proposal.id)
  assert.equal(event.correlation_id, 'corr-9')
  // The only thing a consumer can reconcile against.
  assert.equal(event.payload['ledgerEntryId'], 'entry-1')
  // A decimal string on the wire. A JSON number is an IEEE 754 double.
  assert.equal(event.payload['amount'], SPEND.toString())
  assert.equal(event.payload['recipient'], PAYEE)
  assert.equal(event.payload['communityId'], community.id)
})

test('a missing proposal is `missing`, not an error', { skip }, async () => {
  const outcome = await executeProposal(deps(), emit, {
    proposalId: '00000000-0000-4000-8000-000000000000',
    executedBy: 'op',
    correlationId: 'c',
  })
  assert.equal(outcome.status, 'missing')
})
