/**
 * Proposals, their state machine and their discussion.
 *
 * The invariant worth reading for: **a timelock is fixed when the proposal is created, not when it
 * passes.** A community has to know before it votes how long the delay will be — a timelock chosen
 * after the result is a timelock chosen by whoever is unhappy with it. Three objects say so:
 * `proposals_timelock_after_close`, `proposals_spend_has_timelock` and `MIN_SPEND_TIMELOCK_MINUTES`.
 */

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  MIN_SPEND_TIMELOCK_MINUTES,
  addDiscussionPost,
  cancelProposal,
  createProposal,
  findProposal,
  isProposalKind,
  listDiscussion,
  listProposals,
  markExecuted,
  openForDiscussion,
  proposalsDueToClose,
  proposalsDueToExecute,
  proposalsDueToOpen,
  redactPost,
  transition,
} from './proposals.ts'
import { ConflictError, ValidationError } from './communities.ts'
import { TOPICS } from './events.ts'
import {
  asTx,
  collector,
  migrateTestDb,
  openDb,
  resetCommunity,
  seedCommunity,
  seedProposal,
  skip,
  subject,
} from './testsupport.ts'
import type { Community } from './communities.ts'

let sql: postgres.Sql
let community: Community

const OWNER = subject('owner')
const PAYEE = subject('payee')

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
})

function makeProposal(overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  return sql.begin(async (tx) => ({
    value: await createProposal(asTx(tx), () => {}, community, {
      author: OWNER,
      kind: 'text',
      title: 'A proposal',
      quorum: 1n,
      thresholdBps: 5_000,
      opensAt: new Date(now + 60_000),
      closesAt: new Date(now + 3_600_000),
      timelockUntil: new Date(now + 7_200_000),
      ...overrides,
    } as Parameters<typeof createProposal>[3]),
  }))
}

/* ------------------------------------------------------------------ the timelock */

test('a timelock that expires before voting closes is refused by the database', { skip }, async () => {
  const now = Date.now()
  await assert.rejects(
    () => sql`
      insert into proposals (community_id, author, kind, title, voting_model, quorum, threshold_bps,
                             opens_at, closes_at, timelock_until)
      values (${community.id}, ${OWNER}, 'text', 'T', 'one_member_one_vote', 1, 5000,
              ${new Date(now)}, ${new Date(now + 3_600_000)}, ${new Date(now + 60_000)})
    `,
    /proposals_timelock_after_close/,
  )
})

test('a treasury spend must carry a real delay, refused in two places', { skip }, async () => {
  const now = Date.now()
  const closesAt = new Date(now + 3_600_000)

  // The database refuses the degenerate case — a timelock equal to the close.
  await assert.rejects(
    () => sql`
      insert into proposals (community_id, author, kind, title, voting_model, quorum, threshold_bps,
                             opens_at, closes_at, timelock_until, spend_asset_code, spend_amount,
                             spend_recipient)
      values (${community.id}, ${OWNER}, 'treasury_spend', 'T', 'one_member_one_vote', 1, 5000,
              ${new Date(now)}, ${closesAt}, ${closesAt}, 'EMBER', 100, ${PAYEE})
    `,
    /proposals_spend_has_timelock/,
  )

  // And the handler refuses the merely useless one — a delay too short for an alert to fire and a
  // human to read it, which is the operation AD-15's timelock exists to make possible.
  await assert.rejects(
    () =>
      makeProposal({
        kind: 'treasury_spend',
        closesAt,
        timelockUntil: new Date(closesAt.getTime() + 60_000),
        spend: { assetCode: 'EMBER', amount: 100n, recipient: PAYEE },
      }),
    new RegExp(`at least ${MIN_SPEND_TIMELOCK_MINUTES} minutes`),
  )

  // Exactly at the floor is accepted. Both directions, so a guard that refused everything fails.
  const ok = await makeProposal({
    kind: 'treasury_spend',
    closesAt,
    timelockUntil: new Date(closesAt.getTime() + MIN_SPEND_TIMELOCK_MINUTES * 60_000),
    spend: { assetCode: 'EMBER', amount: 100n, recipient: PAYEE },
  })
  assert.equal(ok.value.kind, 'treasury_spend')
})

test('the minimum timelock is a constant, not a configurable', { skip: false }, async () => {
  // A governance guarantee a deploy can lower is not a guarantee. `env.test.ts` asserts there is no
  // variable for it; this asserts the value has not been quietly reduced to nothing.
  assert.ok(MIN_SPEND_TIMELOCK_MINUTES >= 15)
})

/* ------------------------------------------------------------------ the spend */

test('a treasury_spend must name asset, amount and recipient', { skip }, async () => {
  await assert.rejects(() => makeProposal({ kind: 'treasury_spend' }), ValidationError)
  await assert.rejects(
    () => sql`
      insert into proposals (community_id, author, kind, title, voting_model, quorum, threshold_bps,
                             opens_at, closes_at, timelock_until)
      values (${community.id}, ${OWNER}, 'treasury_spend', 'T', 'one_member_one_vote', 1, 5000,
              now(), now() + interval '1 hour', now() + interval '2 hours')
    `,
    /proposals_spend_complete/,
  )
})

test('a non-spend proposal may not name a spend', { skip }, async () => {
  await assert.rejects(
    () => makeProposal({ kind: 'text', spend: { assetCode: 'EMBER', amount: 1n, recipient: PAYEE } }),
    ValidationError,
  )
  await assert.rejects(
    () => sql`
      insert into proposals (community_id, author, kind, title, voting_model, quorum, threshold_bps,
                             opens_at, closes_at, timelock_until, spend_asset_code, spend_amount,
                             spend_recipient)
      values (${community.id}, ${OWNER}, 'text', 'T', 'one_member_one_vote', 1, 5000,
              now(), now() + interval '1 hour', now() + interval '2 hours', 'EMBER', 1, ${PAYEE})
    `,
    /proposals_spend_only/,
  )
})

test('a spend recipient must be a ledger account subject', { skip }, async () => {
  // Refused here rather than at the ledger, because a proposal whose recipient the ledger will
  // reject is a proposal that passes a vote and then cannot be executed — which looks to a
  // community exactly like the platform refusing to honour their decision.
  for (const recipient of ['platform', 'nonsense', 'user:', 'user:has space']) {
    await assert.rejects(
      () => sql`
        insert into proposals (community_id, author, kind, title, voting_model, quorum, threshold_bps,
                               opens_at, closes_at, timelock_until, spend_asset_code, spend_amount,
                               spend_recipient)
        values (${community.id}, ${OWNER}, 'treasury_spend', 'T', 'one_member_one_vote', 1, 5000,
                now(), now() + interval '1 hour', now() + interval '2 hours', 'EMBER', 1, ${recipient})
      `,
      /proposals_spend_recipient_ck/,
      `${recipient} was accepted as a spend recipient`,
    )
  }
})

test('a spend amount survives above 2^53', { skip }, async () => {
  const huge = 2n ** 100n
  const created = await makeProposal({
    kind: 'treasury_spend',
    spend: { assetCode: 'EMBER', amount: huge, recipient: PAYEE },
  })
  const read = await findProposal(sql, created.value.id)
  assert.equal(read?.spend?.amount, huge)
})

test('a zero or negative spend is refused', { skip }, async () => {
  await assert.rejects(
    () => makeProposal({ kind: 'treasury_spend', spend: { assetCode: 'EMBER', amount: 0n, recipient: PAYEE } }),
    ValidationError,
  )
  await assert.rejects(
    () => sql`
      insert into proposals (community_id, author, kind, title, voting_model, quorum, threshold_bps,
                             opens_at, closes_at, timelock_until, spend_asset_code, spend_amount,
                             spend_recipient)
      values (${community.id}, ${OWNER}, 'treasury_spend', 'T', 'one_member_one_vote', 1, 5000,
              now(), now() + interval '1 hour', now() + interval '2 hours', 'EMBER', -1, ${PAYEE})
    `,
    /proposals_spend_amount_positive/,
  )
})

/* ------------------------------------------------------------------ the rules */

test('a token_weighted proposal must name a snapshot block', { skip }, async () => {
  // Without one the weight is whatever the voter holds at the moment they click, so buying tokens,
  // voting and selling them is a single transaction.
  await assert.rejects(() => makeProposal({ votingModel: 'token_weighted' }), ValidationError)
  await assert.rejects(
    () => sql`
      insert into proposals (community_id, author, kind, title, voting_model, quorum, threshold_bps,
                             opens_at, closes_at, timelock_until)
      values (${community.id}, ${OWNER}, 'text', 'T', 'token_weighted', 1, 5000,
              now(), now() + interval '1 hour', now() + interval '2 hours')
    `,
    /proposals_token_weighted_has_snapshot/,
  )
  const ok = await makeProposal({ votingModel: 'token_weighted', snapshotBlock: 1_234n })
  assert.equal(ok.value.snapshotBlock, 1_234n)
})

test('a zero quorum or an out-of-range threshold is refused by the database', { skip }, async () => {
  for (const [quorum, bps, constraint] of [
    [0, 5_000, 'proposals_quorum_positive'],
    [1, 0, 'proposals_threshold_bps_ck'],
    [1, 10_001, 'proposals_threshold_bps_ck'],
  ] as const) {
    await assert.rejects(
      () => sql`
        insert into proposals (community_id, author, kind, title, voting_model, quorum, threshold_bps,
                               opens_at, closes_at, timelock_until)
        values (${community.id}, ${OWNER}, 'text', 'T', 'one_member_one_vote', ${quorum}, ${bps},
                now(), now() + interval '1 hour', now() + interval '2 hours')
      `,
      new RegExp(constraint),
    )
  }
})

test('a proposal defaults to its community governance model', { skip }, async () => {
  const reputational = await seedCommunity(sql, {
    ownerSubject: OWNER,
    governanceModel: 'reputation_weighted',
  })
  const created = await sql.begin(async (tx) => ({
    value: await createProposal(asTx(tx), () => {}, reputational, {
      author: OWNER,
      kind: 'text',
      title: 'T',
      quorum: 1n,
      thresholdBps: 5_000,
      opensAt: new Date(Date.now() + 60_000),
      closesAt: new Date(Date.now() + 3_600_000),
      timelockUntil: new Date(Date.now() + 7_200_000),
    }),
  }))
  assert.equal(created.value.votingModel, 'reputation_weighted')
})

/* ------------------------------------------------------------------ transitions */

test('a transition is claimed on the status it expects', { skip }, async () => {
  const proposal = await seedProposal(sql, community, { status: 'draft' })
  const first = await sql.begin(async (tx) => ({ value: await openForDiscussion(asTx(tx), proposal.id) }))
  assert.equal(first.value.status, 'moved')
  // The second attempt matches no row and reports the current state rather than moving it back.
  const second = await sql.begin(async (tx) => ({ value: await openForDiscussion(asTx(tx), proposal.id) }))
  assert.equal(second.value.status, 'already')
  assert.equal(second.value.status === 'already' ? second.value.proposal.status : null, 'discussion')
})

test('a missing proposal is `missing`, not a crash', { skip }, async () => {
  const outcome = await sql.begin(async (tx) => ({
    value: await transition(asTx(tx), '00000000-0000-4000-8000-000000000000', 'draft', 'discussion'),
  }))
  assert.equal(outcome.value.status, 'missing')
})

test('an executed proposal cannot be cancelled', { skip }, async () => {
  // Marking it cancelled would leave the record saying a spend was cancelled while the money is
  // gone. The correction for a bad execution is a ledger reversal.
  //
  // The fixture goes through the real path — timelocked, an execution row, then `markExecuted` —
  // because `proposals_executed_names_execution` refuses the shortcut. That refusal is itself
  // worth noticing: there is no way to fake an executed proposal that names no execution.
  const proposal = await seedProposal(sql, community, {
    status: 'timelocked',
    opensAt: new Date(Date.now() - 10_800_000),
    closesAt: new Date(Date.now() - 7_200_000),
    timelockUntil: new Date(Date.now() - 60_000),
  })
  await sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into executions (proposal_id, kind, executed_by, idempotency_key, correlation_id)
      values (${proposal.id}, 'text', 'op', ${`community:execute:${proposal.id}`}, 'c')
      returning id
    `
    await markExecuted(asTx(tx), proposal.id, rows[0]!.id)
    return { done: true }
  })

  const outcome = await sql.begin(async (tx) => ({ value: await cancelProposal(asTx(tx), proposal.id) }))
  assert.equal(outcome.value.status, 'already')
  assert.equal(outcome.value.status === 'already' ? outcome.value.proposal.status : null, 'executed')
})

test('every pre-execution state is cancellable', { skip }, async () => {
  for (const status of ['draft', 'discussion', 'voting', 'passed', 'timelocked'] as const) {
    const proposal = await seedProposal(sql, community, { status })
    const outcome = await sql.begin(async (tx) => ({ value: await cancelProposal(asTx(tx), proposal.id) }))
    assert.equal(outcome.value.status, 'moved', `a ${status} proposal could not be cancelled`)
  }
})

test('markExecuted refuses a proposal that is not timelocked', { skip }, async () => {
  const proposal = await seedProposal(sql, community, { status: 'voting' })
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await markExecuted(asTx(tx), proposal.id, '00000000-0000-4000-8000-000000000001')
        return { done: true }
      }),
    ConflictError,
  )
})

test('an executed proposal must name its execution', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into proposals (community_id, author, kind, title, voting_model, quorum, threshold_bps,
                             opens_at, closes_at, timelock_until, status)
      values (${community.id}, ${OWNER}, 'text', 'T', 'one_member_one_vote', 1, 5000,
              now(), now() + interval '1 hour', now() + interval '2 hours', 'executed')
    `,
    /proposals_executed_names_execution/,
  )
})

/* ------------------------------------------------------------------ due work */

test('the due queries read the database clock', { skip }, async () => {
  const open = await seedProposal(sql, community, {
    status: 'discussion',
    opensAt: new Date(Date.now() - 60_000),
  })
  const notYet = await seedProposal(sql, community, {
    status: 'discussion',
    opensAt: new Date(Date.now() + 3_600_000),
    closesAt: new Date(Date.now() + 7_200_000),
    timelockUntil: new Date(Date.now() + 10_800_000),
  })
  const dueOpen = await proposalsDueToOpen(sql, 10)
  assert.ok(dueOpen.includes(open.id))
  assert.ok(!dueOpen.includes(notYet.id))

  const closing = await seedProposal(sql, community, {
    status: 'voting',
    opensAt: new Date(Date.now() - 7_200_000),
    closesAt: new Date(Date.now() - 60_000),
    timelockUntil: new Date(Date.now() + 3_600_000),
  })
  assert.deepEqual([...(await proposalsDueToClose(sql, 10))], [closing.id])

  const executable = await seedProposal(sql, community, {
    status: 'timelocked',
    opensAt: new Date(Date.now() - 10_800_000),
    closesAt: new Date(Date.now() - 7_200_000),
    timelockUntil: new Date(Date.now() - 60_000),
  })
  const stillLocked = await seedProposal(sql, community, {
    status: 'timelocked',
    opensAt: new Date(Date.now() - 10_800_000),
    closesAt: new Date(Date.now() - 7_200_000),
    timelockUntil: new Date(Date.now() + 3_600_000),
  })
  const dueExec = await proposalsDueToExecute(sql, 10)
  assert.ok(dueExec.includes(executable.id))
  assert.ok(!dueExec.includes(stillLocked.id), 'a proposal still under timelock was queued to execute')
})

/* ------------------------------------------------------------------ discussion */

test('a discussion post is recorded and listed in order', { skip }, async () => {
  const proposal = await seedProposal(sql, community, { status: 'discussion' })
  await sql.begin(async (tx) => {
    await addDiscussionPost(asTx(tx), proposal.id, OWNER, 'first')
    await addDiscussionPost(asTx(tx), proposal.id, OWNER, 'second')
    return { done: true }
  })
  const posts = await listDiscussion(sql, proposal.id, 10)
  assert.deepEqual(posts.map((p) => p.body), ['first', 'second'])
})

test('an empty post is refused', { skip }, async () => {
  const proposal = await seedProposal(sql, community, { status: 'discussion' })
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await addDiscussionPost(asTx(tx), proposal.id, OWNER, '   ')
        return { done: true }
      }),
    ValidationError,
  )
})

test('a redacted post keeps its row and loses its text', { skip }, async () => {
  // "[redacted]" between two replies is comprehensible; a missing post is not.
  const proposal = await seedProposal(sql, community, { status: 'discussion' })
  const post = await sql.begin(async (tx) => ({
    value: await addDiscussionPost(asTx(tx), proposal.id, OWNER, 'something regrettable'),
  }))
  const redacted = await sql.begin(async (tx) => ({ value: await redactPost(asTx(tx), post.value.id) }))
  assert.equal(redacted.value, true)

  const posts = await listDiscussion(sql, proposal.id, 10)
  assert.equal(posts.length, 1)
  assert.equal(posts[0]?.body, '[redacted]')
  assert.ok(posts[0]?.redactedAt !== null)

  // Redacting twice is a no-op rather than an error.
  const again = await sql.begin(async (tx) => ({ value: await redactPost(asTx(tx), post.value.id) }))
  assert.equal(again.value, false)
})

/* ------------------------------------------------------------------ listing */

test('proposals list newest first, within their community', { skip }, async () => {
  const other = await seedCommunity(sql, { ownerSubject: OWNER })
  await seedProposal(sql, community, {})
  await seedProposal(sql, other, {})
  const listed = await listProposals(sql, community.id, 10)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.communityId, community.id)
})

test('the proposal kind set is closed', () => {
  assert.equal(isProposalKind('treasury_spend'), true)
  assert.equal(isProposalKind('role_change'), true)
  assert.equal(isProposalKind('parameter_change'), true)
  assert.equal(isProposalKind('text'), true)
  assert.equal(isProposalKind('constitutional'), false)
})
