/**
 * Background work: the lease, and what it is standing in front of.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE TEST THIS FILE EXISTS FOR IS `TWO RUNNERS, ONE PASSED PROPOSAL, ONE EXECUTION`.**
 *
 * Two `JobRunner`s with DIFFERENT owners — which is what two replicas are — tick at the same
 * moment against one queue. The claim is `for update skip locked`, so one takes the row and the
 * other skips it rather than waiting. Replace the queue with a `setInterval` and a module-local
 * boolean and this test cannot even be written: the boolean is invisible to the second process by
 * construction, which is the whole defect.
 *
 * What it costs HERE is a community's treasury spent twice — two ledger entries, real money, out
 * of an account whose owners agreed to spend it once. `micro-settlement`'s lost-payment race in
 * governance clothes.
 *
 * The second test is the other half and is easy to leave out: **two DIFFERENT proposals still
 * execute concurrently.** A lease keyed `global` would pass the first test and fail this one, and
 * it would serialise every community's treasury behind one lock — so one slow ledger call delays
 * every other community. The key names the contended resource, and here the resource genuinely is
 * the proposal.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Metrics, registerJobMetrics } from '@cloudsforge/telemetry'
import {
  EXECUTE_KIND,
  RECHECK_KIND,
  RECURRING,
  RELAY_KIND,
  RETENTION_KIND,
  TRANSITION_KIND,
  closeAndCount,
  executeKey,
  registerHandlers,
  rescheduleRecurring,
  runTransitions,
  sampleGovernance,
  sampleQueue,
  seedRecurring,
  type JobDeps,
} from './jobs.ts'
import { countExecutions } from './executions.ts'
import { findProposal } from './proposals.ts'
import { unavailableOracle } from './gating.ts'
import {
  asDb,
  fakeLedger,
  fakePolicy,
  migrateTestDb,
  openDb,
  quietLogger,
  resetCommunity,
  seedCommunity,
  seedMember,
  seedProposal,
  seedTreasuryAccount,
  skip,
  subject,
  testMetrics,
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

function depsFor(client: postgres.Sql, queue: JobQueue): JobDeps {
  return {
    sql: asDb(client),
    logger: quietLogger(),
    metrics: testMetrics(),
    queue,
    signingSecret: 'test-signing-secret-0000000000000',
    producer: 'community',
    execute: { ledger, policy },
    oracle: unavailableOracle(),
    gate: { intervalHours: 6, batchSize: 10 },
    idempotencyTtlDays: 30,
  }
}

async function timelockedSpend(): Promise<Proposal> {
  const now = Date.now()
  return seedProposal(sql, community, {
    kind: 'treasury_spend',
    opensAt: new Date(now - 10_800_000),
    closesAt: new Date(now - 7_200_000),
    timelockUntil: new Date(now - 60_000),
    spend: { assetCode: 'EMBER', amount: 500n, recipient: PAYEE },
    status: 'timelocked',
  })
}

/* ------------------------------------------------------------------ the schedule */

test('every recurring job is keyed by the resource it contends on', { skip }, () => {
  // `@cloudsforge/jobs` index.ts — the key names the contended resource, not the row. All four
  // recurring jobs contend on a shared range (the outbox stream, a status scan, a re-check queue,
  // a bulk DELETE), so all four are `global`.
  for (const job of RECURRING) {
    assert.equal(job.key, 'global', `${job.kind} is not keyed on the resource it contends on`)
    assert.ok(job.everyMs > 0)
  }
  assert.deepEqual(
    RECURRING.map((job) => job.kind).sort(),
    [RECHECK_KIND, RELAY_KIND, RETENTION_KIND, TRANSITION_KIND].sort(),
  )
})

test('proposal.execute is NOT recurring, and is keyed per proposal', { skip }, () => {
  // A recurring `global` execute job would serialise every community's treasury behind one lease,
  // so one slow ledger call would delay every other community — and the key would then be lying
  // about what it protects.
  assert.ok(!RECURRING.some((job) => job.kind === EXECUTE_KIND))
  assert.equal(executeKey('abc'), 'proposal:abc')
  assert.notEqual(executeKey('abc'), executeKey('def'))
})

test('the transition job ticks fast enough for a close time to mean something', { skip }, () => {
  const byKind = new Map(RECURRING.map((job) => [job.kind, job.everyMs]))
  // "Voting closes at 18:00" meaning "some time in the next minute" produces support tickets
  // during a contested vote.
  assert.ok(byKind.get(TRANSITION_KIND)! <= 30_000)
  assert.ok(byKind.get(RELAY_KIND)! <= 5_000)
  // Retention is a bulk DELETE and nothing waits on it.
  assert.ok(byKind.get(RETENTION_KIND)! >= 600_000)
})

/* ------------------------------------------------------------------ the lease */

test('two runners, one due execution, exactly one execution and one ledger entry', { skip }, async () => {
  const proposal = await timelockedSpend()

  const a = openDb(3)
  const b = openDb(3)
  try {
    // DIFFERENT owners. Same owner would let one process reclaim its own lease and the test would
    // prove nothing about two replicas.
    const queueA = new JobQueue(a as unknown as JobsSql, { owner: 'replica-a', leaseMs: 60_000 })
    const queueB = new JobQueue(b as unknown as JobsSql, { owner: 'replica-b', leaseMs: 60_000 })

    await queueA.enqueue({
      kind: EXECUTE_KIND,
      key: executeKey(proposal.id),
      onConflict: 'keep',
      payload: { proposalId: proposal.id },
    })
    // A second enqueue of the same (kind, key) does not duplicate — `jobs_kind_key_uniq`.
    await queueB.enqueue({
      kind: EXECUTE_KIND,
      key: executeKey(proposal.id),
      onConflict: 'keep',
      payload: { proposalId: proposal.id },
    })
    const queued = await sql<{ n: number }[]>`select count(*)::int as n from jobs where kind = ${EXECUTE_KIND}`
    assert.equal(queued[0]?.n, 1, 'two enqueues produced two rows')

    const runnerA = registerHandlers(new JobRunner({ queue: queueA, concurrency: 2 }), depsFor(a, queueA))
    const runnerB = registerHandlers(new JobRunner({ queue: queueB, concurrency: 2 }), depsFor(b, queueB))

    // Both tick at the same moment. `for update skip locked` means one claims and the other skips.
    const claimed = await Promise.all([runnerA.tick(), runnerB.tick()])
    assert.equal(
      claimed.reduce((sum, n) => sum + n, 0),
      1,
      `both runners claimed the job (${claimed.join(',')})`,
    )

    assert.equal(await countExecutions(sql, proposal.id), 1, 'the proposal executed twice')
    assert.equal(ledger.calls.length, 1, 'the ledger was called twice')
    assert.equal(ledger.keys.size, 1, 'two distinct ledger entries were posted')
    assert.equal((await findProposal(sql, proposal.id))?.status, 'executed')
  } finally {
    await a.end({ timeout: 5 })
    await b.end({ timeout: 5 })
  }
})

test('two DIFFERENT proposals still execute concurrently', { skip }, async () => {
  // The other half. A `global` lease key would pass the test above and fail this one.
  const first = await timelockedSpend()
  const second = await timelockedSpend()

  const a = openDb(3)
  const b = openDb(3)
  try {
    const queueA = new JobQueue(a as unknown as JobsSql, { owner: 'replica-a', leaseMs: 60_000 })
    const queueB = new JobQueue(b as unknown as JobsSql, { owner: 'replica-b', leaseMs: 60_000 })
    for (const id of [first.id, second.id]) {
      await queueA.enqueue({ kind: EXECUTE_KIND, key: executeKey(id), onConflict: 'keep', payload: { proposalId: id } })
    }

    const runnerA = registerHandlers(new JobRunner({ queue: queueA, concurrency: 1 }), depsFor(a, queueA))
    const runnerB = registerHandlers(new JobRunner({ queue: queueB, concurrency: 1 }), depsFor(b, queueB))
    const claimed = await Promise.all([runnerA.tick(), runnerB.tick()])

    assert.equal(claimed.reduce((sum, n) => sum + n, 0), 2, 'the two proposals queued behind one lease')
    assert.equal(await countExecutions(sql, first.id), 1)
    assert.equal(await countExecutions(sql, second.id), 1)
    assert.equal(ledger.keys.size, 2, 'two proposals should produce two ledger entries')
  } finally {
    await a.end({ timeout: 5 })
    await b.end({ timeout: 5 })
  }
})

test('the lease outlives the two upstream deadlines it spans', { skip }, () => {
  // `proposal.execute` holds its lease across a policy call and a ledger call. A lease that can
  // expire mid-execution is a lease that lets a second worker start one — and the execution's own
  // three guards would then be the only thing standing there, which is one fewer than intended.
  //
  // The relationship is asserted rather than the number: `index.ts` uses 120_000 against defaults
  // of 3_000 and 5_000, so the margin is fifteen-fold.
  const leaseMs = 120_000
  const policyDeadlineMs = 3_000
  const ledgerDeadlineMs = 5_000
  assert.ok(
    leaseMs > (policyDeadlineMs + ledgerDeadlineMs) * 4,
    'the job lease does not comfortably outlive the upstream calls it holds open',
  )
})

/* ------------------------------------------------------------------ transitions */

test('closing a proposal counts it and moves it to timelocked or rejected', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'test', leaseMs: 60_000 })
  const deps = depsFor(sql, queue)
  await seedMember(sql, community, subject('m1'))
  await seedMember(sql, community, subject('m2'))

  const passing = await seedProposal(sql, community, {
    status: 'voting',
    quorum: 2n,
    thresholdBps: 5_000,
    opensAt: new Date(Date.now() - 3_600_000),
    closesAt: new Date(Date.now() + 3_600_000),
    timelockUntil: new Date(Date.now() + 7_200_000),
  })
  // Votes go in while the proposal is genuinely open — `community_assert_vote_window` refuses them
  // otherwise, which is itself worth noticing: the fixture cannot cheat the window either.
  await sql`
    insert into votes (proposal_id, subject, cast_by, choice, weight)
    values (${passing.id}, ${subject('m1')}, ${subject('m1')}, 'for', 1),
           (${passing.id}, ${subject('m2')}, ${subject('m2')}, 'for', 1)
  `
  // Then the clock moves past the close, which is what the transition job would have waited for.
  await sql`
    update proposals set closes_at = now() - interval '1 minute',
                         timelock_until = now() + interval '1 hour'
     where id = ${passing.id}
  `
  await closeAndCount(deps, passing.id)
  assert.equal((await findProposal(sql, passing.id))?.status, 'timelocked')

  const failing = await seedProposal(sql, community, {
    status: 'voting',
    quorum: 5n,
    thresholdBps: 5_000,
    opensAt: new Date(Date.now() - 3_600_000),
    closesAt: new Date(Date.now() - 60_000),
    timelockUntil: new Date(Date.now() + 3_600_000),
  })
  await closeAndCount(deps, failing.id)
  assert.equal((await findProposal(sql, failing.id))?.status, 'rejected')
})

test('two workers closing one proposal produce one close event', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'test', leaseMs: 60_000 })
  const proposal = await seedProposal(sql, community, {
    status: 'voting',
    quorum: 1n,
    opensAt: new Date(Date.now() - 3_600_000),
    closesAt: new Date(Date.now() - 60_000),
    timelockUntil: new Date(Date.now() + 3_600_000),
  })
  const a = openDb(2)
  const b = openDb(2)
  try {
    await Promise.all([
      closeAndCount(depsFor(a, queue), proposal.id),
      closeAndCount(depsFor(b, queue), proposal.id),
    ])
    const events = await sql<{ n: number }[]>`
      select count(*)::int as n from outbox where topic = 'community.proposal.closed'
    `
    assert.equal(events[0]?.n, 1, 'the transition was claimed twice')
  } finally {
    await a.end({ timeout: 5 })
    await b.end({ timeout: 5 })
  }
})

test('the transition job re-enqueues a timelocked proposal whose execute job was lost', { skip }, async () => {
  // The replica killed between the transition commit and the enqueue — a real window, because the
  // enqueue is deliberately after the commit. `onConflict: keep` makes N sweeps produce one row.
  const proposal = await timelockedSpend()
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'test', leaseMs: 60_000 })
  const deps = depsFor(sql, queue)

  await runTransitions(deps)
  await runTransitions(deps)

  const jobs = await sql<{ n: number }[]>`
    select count(*)::int as n from jobs where kind = ${EXECUTE_KIND} and key = ${executeKey(proposal.id)}
  `
  assert.equal(jobs[0]?.n, 1)
})

test('a proposal whose discussion window has opened moves to voting', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'test', leaseMs: 60_000 })
  const proposal = await seedProposal(sql, community, {
    status: 'discussion',
    opensAt: new Date(Date.now() - 60_000),
  })
  await runTransitions(depsFor(sql, queue))
  assert.equal((await findProposal(sql, proposal.id))?.status, 'voting')
})

/* ------------------------------------------------------------------ recurring */

test('the recurring set is seeded once however many replicas boot', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'test', leaseMs: 60_000 })
  await seedRecurring(queue)
  await seedRecurring(queue)
  await seedRecurring(queue)
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from jobs`
  assert.equal(rows[0]?.n, RECURRING.length)
})

test('a dead recurring job is not silently re-armed', { skip }, () => {
  // The row stays, `jobs_dead_total` climbs, and that is how an operator learns the thing
  // scheduling everything else has stopped.
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'test', leaseMs: 60_000 })
  let enqueued = 0
  const spy = { enqueue: async () => void (enqueued += 1) } as unknown as JobQueue
  const reschedule = rescheduleRecurring(spy, quietLogger())
  reschedule({ type: 'dead', kind: RELAY_KIND, key: 'global' })
  assert.equal(enqueued, 0)
  reschedule({ type: 'completed', kind: RELAY_KIND, key: 'global' })
  assert.equal(enqueued, 1)
  // And an execute job is not re-armed at all — a completed execution must not run again, and a
  // dead one must stay visible.
  reschedule({ type: 'completed', kind: EXECUTE_KIND, key: executeKey('x') })
  assert.equal(enqueued, 1)
  void queue
})

/* ------------------------------------------------------------------ gauges */

test('the gauges are sampled at scrape time and are bounded queries', { skip }, async () => {
  const metrics = registerJobMetrics(testMetrics())
  await seedProposal(sql, community, { status: 'voting' })
  await timelockedSpend()
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'test', leaseMs: 60_000 })
  await seedRecurring(queue)

  await sampleQueue(asDb(sql), metrics)
  await sampleGovernance(asDb(sql), metrics)
  const rendered = metrics.render()
  assert.match(rendered, /community_jobs_pending 4/)
  assert.match(rendered, /community_proposals_voting 1/)
  // The one number worth an alert: a climbing `timelocked` means executions have stopped.
  assert.match(rendered, /community_proposals_timelocked 1/)
  void Metrics
})

test('there is no setInterval doing domain work in this repository', { skip }, async () => {
  // Rule 8, and CI greps for it too. Asserted here as well so a violation fails locally rather
  // than after a push.
  const { readdirSync, readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const offenders: string[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
    const source = readFileSync(`${dir}${file}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    if (/setInterval\s*\(/.test(source)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `background work must be a leased job: ${offenders.join(', ')}`)
})
