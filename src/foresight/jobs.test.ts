/**
 * The leased jobs.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **TWO WORKERS, ONE DUE JOB → ONE RUN.**
 *
 * This is the property rule 8 of docs/ecosystem/03 §2 exists for, and it is the reason there is no
 * `setInterval` anywhere in this repository. A timer is a variable in one process and is by
 * construction invisible to a second: two replicas both fire, both do the work, and for the idea
 * pipeline that means a doubled operator queue and a doubled model bill.
 *
 * The test below runs two REAL `JobRunner`s against one REAL Postgres and counts. `FOR UPDATE SKIP
 * LOCKED` in `@cloudsforge/jobs` is what makes the second one see nothing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import {
  CUSTODIAL_SETTLE,
  DEPLOY_SWEEP,
  FEE_REPORT,
  IDEA_PROPOSE,
  JOB_KINDS,
  MARKET_CLOSE,
  MARKET_DEPLOY,
  MIRROR_SWEEP,
  MIRROR_SYNC,
  OUTBOX_RELAY,
  PROPOSAL_TOPICS,
  RESOLUTION_POST,
  applyConfirmedResolution,
  custodialSettleHandler,
  deploySweepHandler,
  feeReportHandler,
  ideaProposeHandler,
  marketCloseHandler,
  mirrorSweepHandler,
  recurringJobs,
  registerHandlers,
  rescheduleRecurring,
  seedRecurring,
  type JobDeps,
  type ScheduleDeps,
} from './jobs.ts'
import { createRelay } from './outbox.ts'
import { CATEGORY_VERSION } from './categories.ts'
import { findMarket } from './markets.ts'
import { ACTION_VOID } from './resolve.ts'
import { feeIdempotencyKey, type EntryRequest, type LedgerClient } from './ledgerclient.ts'
import {
  db,
  enabled,
  fakeIndexer,
  fakeProposer,
  migrateTestDb,
  openDb,
  openDirect,
  quietLogger,
  resetForesight,
  seedDraft,
  skip,
  testMetrics,
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

function ledgerRecording(posted: EntryRequest[]): LedgerClient {
  return {
    async postEntry(request) {
      posted.push(request)
      return { id: `entry-${posted.length}`, kind: request.kind, recordedAt: new Date().toISOString(), replayed: false }
    },
    // No job reads a balance; the panel does. A fake that invented one would be lying quietly.
    async balances() {
      return []
    },
  }
}

function depsFor(queue: JobQueue, overrides: Partial<JobDeps> = {}): JobDeps {
  return {
    sql: db(sql),
    queue,
    producer: 'foresight',
    network: 'testnet',
    chain: 'ember',
    logger: quietLogger(),
    metrics: testMetrics(),
    proposer: fakeProposer({ proposals: [], reason: 'not_configured', searchQuery: null, modelId: null }, false),
    proposalBatchSize: 3,
    proposeEveryMinutes: 360,
    deploy: {} as JobDeps['deploy'],
    resolve: {} as JobDeps['resolve'],
    mirror: { sql: db(sql), indexer: fakeIndexer(), pageSize: 10, logger: quietLogger(), metrics: testMetrics() },
    ledger: ledgerRecording([]),
    ...overrides,
  }
}

/* ------------------------------------------------------------------ the lease */

test('THE PROPERTY: two workers, one due idea job, exactly one run', { skip }, async () => {
  const jobs = sql as unknown as JobsSql
  const queueA = new JobQueue(jobs, { owner: 'worker-a', leaseMs: 60_000 })
  const queueB = new JobQueue(jobs, { owner: 'worker-b', leaseMs: 60_000 })

  let runs = 0
  const proposer = fakeProposer({
    proposals: [
      {
        question: 'Will Hearth mainnet reach block height 5,000,000 before 2027-01-01T00:00:00Z?',
        resolutionCriteria: 'YES if the named explorer shows that block before the instant given.',
        category: 'protocol_network',
        categoryVersion: CATEGORY_VERSION,
        resolutionSourceKind: 'block_explorer',
        resolutionSourceRef: 'https://explorer.cloudsforge.online/#/block/5000000',
        suggestedCloseTime: FUTURE(),
        origin: 'model',
        searchQuery: 'q',
        sources: [{ url: 'https://example.invalid/a', title: 'A', retrievedAt: new Date().toISOString() }],
        modelId: 'm',
        promptSha256: 'a'.repeat(64),
      },
    ],
    reason: 'ok',
    searchQuery: 'q',
    modelId: 'm',
  })

  const handler = ideaProposeHandler(depsFor(queueA, { proposer }))
  const counting = async (...args: Parameters<typeof handler>) => {
    runs += 1
    await handler(...args)
  }

  const runnerA = new JobRunner({ queue: queueA, concurrency: 2, pollMs: 10 })
  const runnerB = new JobRunner({ queue: queueB, concurrency: 2, pollMs: 10 })
  runnerA.register(IDEA_PROPOSE, counting)
  runnerB.register(IDEA_PROPOSE, counting)

  await queueA.enqueue({ kind: IDEA_PROPOSE, key: 'global' })

  // Both workers tick at the same time against one row. `FOR UPDATE SKIP LOCKED` means the loser
  // sees nothing rather than waiting for it, so the two never serialise and never share the row.
  const [claimedA, claimedB] = await Promise.all([runnerA.tick(), runnerB.tick()])
  assert.equal(claimedA + claimedB, 1, `both workers claimed the job (${claimedA} + ${claimedB})`)
  assert.equal(runs, 1, 'the handler ran more than once for one due job')

  // And the pipeline stored exactly ONE RUN's worth — one proposal per searched topic. A second
  // run would double this, which is the damage the lease exists to prevent.
  const ideas = await sql<{ n: number }[]>`select count(*)::int as n from ideas`
  assert.equal(ideas[0]?.n, PROPOSAL_TOPICS.length, 'the pipeline ran more than once')
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RECURRENCE, AND THE ONLY WAY TO TEST IT THAT IS NOT ITSELF THE DEFECT.
 *
 * The test that used to stand here was:
 *
 *     await handler(job, ctx)                                  // call the handler directly
 *     assert.equal(rowsFor(IDEA_PROPOSE).length, 1)            // it enqueued a follow-up
 *
 * and it was **green against code whose schedule was completely dead.** Every handler really did
 * enqueue its own `(kind, key)`; the enqueue was not the broken part. `JobRunner` then called
 * `queue.complete(job.id)` — `delete from jobs where id = $1` — and because `enqueue` is
 * `on conflict (kind, key) do nothing`, the row the handler "created" was the very row it was
 * running as. Delete one, lose both. The old test never ran a runner, so `complete()` never fired
 * and the row it looked at was one the real system removes a millisecond later.
 *
 * Live consequence, before this change: foresight's `jobs` table held **0 rows 47 minutes after
 * start** while nine sibling services held live ones, and its `outbox` proved the mechanism — every
 * event's `published_at` was the timestamp of the NEXT container boot, because `outbox.relay` only
 * ever ran once, at start.
 *
 * So the two tests below drive a **real `JobRunner` through a whole claim → run → complete cycle**
 * and then look for the row. `BASELINE` models the old seam against the same fixtures, in the same
 * file, and shows it losing the row — which is what makes the first test a check on this fix rather
 * than a restatement of it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

const SCHEDULE: ScheduleDeps = { chain: 'ember', network: 'testnet', proposeEveryMinutes: 360 }

/** The composition root's wiring, minus the socket: handlers registered, re-arm on `completed`. */
function wiredRunner(queue: JobQueue, deps: JobDeps): JobRunner {
  const reschedule = rescheduleRecurring(queue, quietLogger(), SCHEDULE)
  const runner = new JobRunner({ queue, concurrency: 4, pollMs: 10, onEvent: reschedule })
  registerHandlers(
    deps,
    createRelay({ sql: db(sql), logger: quietLogger(), signingSecret: 'test-signing-secret' }),
    (kind, handler) => runner.register(kind, handler),
  )
  return runner
}

test('THE PROPERTY: a recurring row SURVIVES its own completion', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const runner = wiredRunner(queue, depsFor(queue))

  await seedRecurring(queue, SCHEDULE)
  const expected = recurringJobs(SCHEDULE)
  assert.equal(
    (await sql<{ n: number }[]>`select count(*)::int as n from jobs`)[0]?.n,
    expected.length,
    'the boot seed did not produce one row per recurring job',
  )

  // Run every seeded job to completion. Concurrency is 4 and there are more kinds than that, so
  // this ticks until nothing is due rather than assuming one tick drains the set.
  let claimed = 0
  for (let i = 0; i < 10; i += 1) claimed += await runner.tick()
  assert.ok(claimed >= expected.length, `only ${claimed} of ${expected.length} recurring jobs ran`)

  // ── THE ASSERTION THE OLD TEST COULD NOT MAKE ────────────────────────────────────────────────
  // Not "an enqueue happened" — it happened before too. The row is STILL HERE, after the runner
  // deleted the one it ran, and it is scheduled for the future. Revert `index.ts`/`jobs.ts` to the
  // self-enqueue seam and every one of these rows is gone.
  const rows = await sql<{ kind: string; key: string; run_at: Date }[]>`
    select kind, key, run_at from jobs order by kind
  `
  assert.deepEqual(
    rows.map((row) => `${row.kind}|${row.key}`).sort(),
    expected.map((job) => `${job.kind}|${job.key}`).sort(),
    'a recurring job did not survive its own completion',
  )
  for (const row of rows) {
    const job = expected.find((candidate) => candidate.kind === row.kind && candidate.key === row.key)
    assert.ok(job, `${row.kind} is not a recurring job`)
    assert.ok(
      row.run_at.getTime() > Date.now(),
      `${row.kind} was re-armed in the past (${row.run_at.toISOString()}) — it would spin, not wait`,
    )
    // Armed at its OWN interval, not at somebody else's. A single shared cadence would put the
    // relay on six minutes or the idea pipeline on one second, and both are wrong.
    assert.ok(
      row.run_at.getTime() <= Date.now() + job.everyMs + 5_000,
      `${row.kind} was re-armed far past its ${job.everyMs}ms interval`,
    )
  }

  // And a SECOND cycle, because "survives once" is not "recurs". The old code survived zero.
  await sql`update jobs set run_at = now()`
  let second = 0
  for (let i = 0; i < 10; i += 1) second += await runner.tick()
  assert.ok(second >= expected.length, 'the schedule did not survive a second pass')
  assert.equal(
    (await sql<{ n: number }[]>`select count(*)::int as n from jobs`)[0]?.n,
    expected.length,
    'the recurring set did not survive a second completion',
  )
})

test('BASELINE: the seam this replaced loses the row, driven the same way', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })

  // The old shape, exactly: the handler enqueues its own (kind, key) and nothing listens to
  // `completed`. This is `ideaProposeHandler`'s old `finally` block, reduced to the one line that
  // mattered.
  const runner = new JobRunner({ queue, concurrency: 1, pollMs: 10 })
  runner.register(IDEA_PROPOSE, async () => {
    await queue.enqueue({
      kind: IDEA_PROPOSE,
      key: 'global',
      runAt: new Date(Date.now() + 360 * 60_000),
      onConflict: 'keep',
    })
  })

  await queue.enqueue({ kind: IDEA_PROPOSE, key: 'global' })
  assert.equal(await runner.tick(), 1, 'the baseline job did not run')

  // The re-enqueue DID happen — that is why a handler-only test was green — and the row is gone
  // anyway, because `complete()` deleted the row the enqueue had conflicted onto.
  assert.equal(
    (await sql`select 1 from jobs where kind = ${IDEA_PROPOSE}`).length,
    0,
    'the baseline kept its row; the defect this file exists for is not being modelled',
  )
})

test('an unconfigured proposer completes the run rather than throwing', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  // Not a throw, not a dead letter, and not an error line every six hours for a thing nobody has
  // set up. `micro-notify`'s SMTP discipline. The NEXT run is armed by the runner's `completed`
  // event, not by this handler — see THE PROPERTY above.
  const handler = ideaProposeHandler(depsFor(queue))
  await handler({ id: 'x', kind: IDEA_PROPOSE, key: 'global', attempts: 1, maxAttempts: 5, payload: {} }, {
    heartbeat: async () => true,
    signal: new AbortController().signal,
  })
  assert.equal((await sql`select 1 from ideas`).length, 0)
  // And it wrote NOTHING to the queue. A handler that still self-enqueued would leave a row here,
  // and that row is the one `complete()` eats.
  assert.equal((await sql`select 1 from jobs`).length, 0, 'the handler enqueued its own next run')
})

test('a proposal that fails validation is dropped and counted, never repaired', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const metrics = testMetrics()
  const proposer = fakeProposer({
    proposals: [
      {
        // A category outside the allowlist — the shape a model that drifted would produce.
        question: 'Will a named person do a thing?',
        resolutionCriteria: 'YES if it is reported somewhere plausible.',
        category: 'celebrity_gossip',
        categoryVersion: CATEGORY_VERSION,
        resolutionSourceKind: 'block_explorer',
        resolutionSourceRef: 'https://example.invalid/x',
        suggestedCloseTime: FUTURE(),
        origin: 'model',
        searchQuery: 'q',
        sources: [{ url: 'https://example.invalid/a', title: 'A', retrievedAt: new Date().toISOString() }],
        modelId: 'm',
        promptSha256: 'a'.repeat(64),
      },
    ],
    reason: 'ok',
    searchQuery: 'q',
    modelId: 'm',
  })
  const handler = ideaProposeHandler(depsFor(queue, { proposer, metrics }))
  await handler({ id: 'x', kind: IDEA_PROPOSE, key: 'global', attempts: 1, maxAttempts: 5, payload: {} }, {
    heartbeat: async () => true,
    signal: new AbortController().signal,
  })
  assert.equal((await sql`select 1 from ideas`).length, 0, 'a proposal outside the allowlist was stored')
  assert.match(metrics.render(), /foresight_proposals_dropped_total\{reason="bad_category"\} 3/)
})

/* ------------------------------------------------------------------ closing */

test('the close job closes only what is due', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const due = await seedDraft(sql, { closeTime: new Date(Date.now() + 60_000) })
  const notDue = await seedDraft(sql, { closeTime: new Date(Date.now() + 10 * 60_000) })
  await openDirect(sql, due.id)
  await openDirect(sql, notDue.id)

  const now = new Date(Date.now() + 2 * 60_000)
  const handler = marketCloseHandler(depsFor(queue, { now: () => now }))
  await handler({ id: 'x', kind: MARKET_CLOSE, key: 'global', attempts: 1, maxAttempts: 5, payload: {} }, {
    heartbeat: async () => true,
    signal: new AbortController().signal,
  })

  assert.equal((await findMarket(db(sql), due.id))?.status, 'closed')
  assert.equal((await findMarket(db(sql), notDue.id))?.status, 'open')
  // One event, on the public topic.
  const events = await sql<{ topic: string }[]>`select topic from outbox`
  assert.deepEqual(events.map((row) => row.topic), ['foresight.market.closed'])
  // No self-enqueue: the next scan is armed off the runner's `completed` event, because a row this
  // handler wrote would be the row `complete()` deletes.
  assert.equal((await sql`select 1 from jobs`).length, 0)
})

/* ------------------------------------------------------------------ the sweep */

test('the sweep re-enqueues every outstanding deploy, so a closed tab strands nothing', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const a = await seedDraft(sql)
  const b = await seedDraft(sql)
  await sql`update markets set status = 'approved', approved_by = ${'operator:x'}, approved_at = now() where id in (${a.id}, ${b.id})`

  const handler = deploySweepHandler(depsFor(queue))
  await handler({ id: 'x', kind: MARKET_DEPLOY, key: 'sweep', attempts: 1, maxAttempts: 5, payload: {} }, {
    heartbeat: async () => true,
    signal: new AbortController().signal,
  })
  const queued = await sql<{ key: string }[]>`select key from jobs where kind = ${MARKET_DEPLOY} order by key`
  assert.deepEqual(queued.map((row) => row.key).sort(), [a.id, b.id].sort())
})

/* ------------------------------------------------------------------ the fee report */

test('a fee is reported to the ledger from an indexed event, once', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  await sql`
    update markets set status = 'resolved', outcome = 0, closed_at = now(), resolved_at = now()
     where id = ${market.id}
  `
  await sql`
    insert into fee_reports (market_id, amount_wei, treasury, tx_hash, log_index, block_height)
    values (${market.id}, ${(12_345_678_901_234_567_890n).toString()}, ${'0x' + '22'.repeat(20)},
            ${'0x' + '33'.repeat(32)}, 2, 99)
  `

  const posted: EntryRequest[] = []
  const handler = feeReportHandler(depsFor(queue, { ledger: ledgerRecording(posted) }))
  const job = { id: 'x', kind: FEE_REPORT, key: 'global', attempts: 1, maxAttempts: 5, payload: {} }
  const ctx = { heartbeat: async () => true, signal: new AbortController().signal }
  await handler(job, ctx)

  assert.equal(posted.length, 1)
  const entry = posted[0]
  // 'fee_charged' — the ledger's closed journal_entries_kind_chk vocabulary
  // (ledger/src/migrations.ts). The previous expectation pinned a kind the ledger refuses,
  // which is a test asserting the defect; corrected with the posting fix in ledgerclient.ts.
  assert.equal(entry?.kind, 'fee_charged')
  // The key is derived from the market id, so a retry replays rather than posting twice.
  assert.equal(entry?.idempotencyKey, feeIdempotencyKey(market.id))
  // A bigint all the way to the wire, and a decimal STRING on it. A JSON number would not survive.
  assert.equal(entry?.postings[0]?.amount, 12_345_678_901_234_567_890n)
  assert.equal(entry?.postings[0]?.direction, 'debit')
  assert.equal(entry?.postings[1]?.direction, 'credit')
  assert.equal(
    entry?.postings.reduce((sum, p) => sum + (p.direction === 'debit' ? p.amount : -p.amount), 0n),
    0n,
    'the entry does not balance',
  )

  // The market is settled, and the report is marked so the next pass does not repost it.
  assert.equal((await findMarket(db(sql), market.id))?.status, 'settled')
  await handler(job, ctx)
  assert.equal(posted.length, 1, 'the fee was reported twice')
})

test('THE CONSTRAINT: one indexed fee event cannot become two reports', { skip }, async () => {
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  const insert = () => sql`
    insert into fee_reports (market_id, amount_wei, treasury, tx_hash, log_index, block_height)
    values (${market.id}, 1, ${'0x' + '22'.repeat(20)}, ${'0x' + '44'.repeat(32)}, 0, 1)
  `
  await insert()
  await assert.rejects(
    insert(),
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'fee_reports_source_uniq',
  )
})

/* ------------------------------------------------------------------ applying a confirmed resolution */

test('a confirmed void becomes a voided market with the rationale as the reason', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  await sql`update markets set status = 'closed', closed_at = now() where id = ${market.id}`

  await applyConfirmedResolution(
    depsFor(queue),
    market.id,
    ACTION_VOID,
    'the named resolution source is unreachable at resolution',
  )
  const voided = await findMarket(db(sql), market.id)
  assert.equal(voided?.status, 'void')
  assert.match(voided?.voidReason ?? '', /unreachable at resolution/)
  const events = await sql<{ topic: string }[]>`select topic from outbox`
  assert.deepEqual(events.map((row) => row.topic), ['foresight.market.voided'])
})

/* ------------------------------------------------------------------ the registry */

test('every job kind has a documented lease key, and the recurring ones are seeded once', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  assert.deepEqual([...JOB_KINDS].sort(), [
    CUSTODIAL_SETTLE,
    DEPLOY_SWEEP,
    FEE_REPORT,
    IDEA_PROPOSE,
    MARKET_CLOSE,
    MIRROR_SWEEP,
    MIRROR_SYNC,
    MARKET_DEPLOY,
    OUTBOX_RELAY,
    RESOLUTION_POST,
  ].sort())

  // N replicas booting together produce ONE pending run of each, because `(kind, key)` is unique
  // and `onConflict: 'keep'` collapses the rest.
  await Promise.all([
    seedRecurring(queue, SCHEDULE),
    seedRecurring(queue, SCHEDULE),
    seedRecurring(queue, SCHEDULE),
  ])
  const rows = await sql<{ kind: string; key: string }[]>`select kind, key from jobs order by kind`
  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.key}`).sort(),
    [
      `${CUSTODIAL_SETTLE}:global`,
      `${DEPLOY_SWEEP}:global`,
      `${FEE_REPORT}:global`,
      `${IDEA_PROPOSE}:global`,
      `${MARKET_CLOSE}:global`,
      `${MIRROR_SWEEP}:global`,
      `${OUTBOX_RELAY}:global`,
      // The one that is NOT global: the oracle's nonce is contended per chain.
      `${RESOLUTION_POST}:oracle:ember:testnet`,
    ].sort(),
  )
})

test('THE GAP THAT WAS THERE: every declared kind is actually registered', { skip }, async () => {
  // `deploySweepHandler` was written, documented as the thing that "catches a row nothing
  // re-enqueued", covered by a test in this very file — and never passed to `runner.register`. So
  // the safety net beneath the annihilated self-enqueue was not in the process at all, and an
  // approved market could sit in `pending` until somebody restarted the container. Nothing could
  // have noticed: an unregistered kind is simply never claimed, because `JobRunner.tick` claims
  // `[...this.#handlers.keys()]` and an absent key is an absent filter entry, not an error.
  const registered = new Set<string>()
  registerHandlers(
    depsFor(new JobQueue(sql as unknown as JobsSql, { owner: 'w' })),
    async () => {},
    (kind) => {
      assert.ok(!registered.has(kind), `${kind} was registered twice`)
      registered.add(kind)
    },
  )
  assert.deepEqual([...registered].sort(), [...JOB_KINDS].sort(), 'a declared kind has no handler')
})

test('every recurring kind is a declared kind, armed at a positive interval', { skip }, async () => {
  // A recurring row whose kind nothing handles is a row that is claimed by nobody and sits in the
  // table for ever, dragging `jobs_overdue` up and reporting a fault that does not exist.
  for (const job of recurringJobs(SCHEDULE)) {
    assert.ok(JOB_KINDS.includes(job.kind), `${job.kind} recurs but is not a declared kind`)
    assert.ok(job.everyMs > 0, `${job.kind} recurs every ${job.everyMs}ms, which is a busy loop`)
  }
})

test('the mirror sweep follows what has a contract and a life left, and nothing else', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const open = await seedDraft(sql)
  const settled = await seedDraft(sql)
  const undeployed = await seedDraft(sql)
  await openDirect(sql, open.id)
  await openDirect(sql, settled.id)
  // `outcome` is not decoration here: `markets_resolved_has_outcome` refuses a settled market
  // without one, which is the schema saying that "settled" is a claim about a decided question.
  await sql`
    update markets set status = 'settled', outcome = 0,
           closed_at = now(), resolved_at = now(), settled_at = now()
     where id = ${settled.id}
  `

  const handler = mirrorSweepHandler(depsFor(queue))
  await handler({ id: 'x', kind: MIRROR_SWEEP, key: 'global', attempts: 1, maxAttempts: 5, payload: {} }, {
    heartbeat: async () => true,
    signal: new AbortController().signal,
  })

  const queued = await sql<{ key: string }[]>`select key from jobs where kind = ${MIRROR_SYNC}`
  // `settled` is terminal — nothing further is ever staked against it, so following it for ever is
  // an indexer call every 30 seconds for a number that can no longer change. `undeployed` has no
  // contract, and `syncMarket` reads nothing without one.
  assert.deepEqual(queued.map((row) => row.key), [open.id])
  assert.ok(!queued.some((row) => row.key === undeployed.id))
})
