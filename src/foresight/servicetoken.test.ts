/**
 * **THE FIFTEEN-SECOND JOB AND THE TEN-MINUTE TOKEN, DRIVEN PAST THE EXPIRY.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## The defect
 *
 * `FORESIGHT_SERVICE_TOKEN` held a token that lives **600 seconds** (`identity/src/tokens.ts`).
 * The composition root read it once, at import — `const token = () => env.serviceToken` — and handed
 * that to all five upstream clients. This service's custody calls come from **leased background
 * jobs**: `market.deploy` provisions a per-market deployer address and signs a contract creation,
 * and `recurringJobs` re-arms its sweep every **15 seconds**, for ever. So it authenticated once per
 * bootstrap and every job from minute ten onwards presented a dead token.
 *
 * **And the log would have named the wrong service.** `driveDeploy` maps a custody 401 to
 * `CustodySignRefusedError` or `CustodyUnavailableError`, which read as "custody said no" and
 * "custody is down". Neither is true; the container's own credential had expired. That
 * misattribution is the same one that sent operators after the indexer while `micro-ledger` froze
 * EMBER, and it is the real cost here.
 *
 * ## Why every other test in this repository is blind to it
 *
 * They build their own client and use it a millisecond later. **A test that mints a token and
 * immediately uses it proves nothing about this defect** — the token is never asked to survive its
 * own lifetime, and at the speed of a test a hard-coded string and a live credential are
 * indistinguishable. `deploy.test.ts` beside this file drives the whole deploy loop and is green
 * with a `fakeCustody` that never looks at a header. That is the property this file removes: below,
 * the clock moves **ELEVEN MINUTES** past a token the process already holds, that token is shown to
 * be refused **by a real `Verifier`**, and only then is the leased job run again.
 *
 * ## The assertion that stops this file being green for the wrong reason
 *
 * `authorizedFetch` re-mints and replays on a 401. So a completely broken refresh SCHEDULE would
 * still end in a successful deploy — one 401, one re-mint, one replay — and a test that only checked
 * the outcome would pass over it. The post-expiry case therefore asserts **zero 401s**: the token
 * must have been refreshed on schedule, before it was ever presented. `EIGHT HOURS` then runs the
 * job thirty-two times across a whole shift and holds the same bar.
 *
 * ## What is real here, and what is not
 *
 *   * **Real**: `buildUpstreams` (the wiring under test), `ServiceTokenProvider`, `HttpClient`,
 *     `httpCustodyClient`, `Verifier` and jose's own expiry arithmetic, `JobQueue` claiming a real
 *     row `for update skip locked`, `JobRunner`, `jobs.ts`'s real `market.deploy` handler,
 *     `driveDeploy`, and a real Postgres with this service's migrations live. The markets below are
 *     read back out of the database, not out of a return value.
 *   * **Simulated**: the clock, and the two peers' transports. `mock.timers` moves `Date` only, so
 *     jose decides expiry from the same instant the provider schedules against — nothing here
 *     decides expiry by hand, which is how a test ends up agreeing with the code it is checking.
 *
 * `T0` is deliberately in the past. The clock is mocked and Postgres's is not, and `JobQueue`
 * computes `run_at` in JS while the claim query compares it against the database's `now()`. A `T0`
 * at "today" would put every enqueue eleven minutes into the database's future at exactly the moment
 * the test cares about, and the runner would claim nothing — a green suite proving nothing ran.
 *
 * ## Going through `buildUpstreams` is the whole point
 *
 * A test that constructs its own `ServiceTokenProvider` and its own `httpCustodyClient` proves the
 * provider works, which is `@cloudsforge/auth`'s job. It proves nothing about whether THIS SERVICE
 * uses it, and "this service does not use it" was the defect. Reverting `upstreams.ts` to
 * `token: () => env.serviceToken` turns the first two tests below red — and `BASELINE` models that
 * exact old seam, against the same fixtures, so this file also demonstrates the failure it fixes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { SignJWT, generateKeyPair } from 'jose'
import { AUDIENCE, Verifier } from '@cloudsforge/auth'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { buildUpstreams, type UpstreamEnv } from './upstreams.ts'
import { MARKET_DEPLOY, registerHandlers, type JobDeps } from './jobs.ts'
import { findMarket } from './markets.ts'
import type { DeployDeps } from './deploy.ts'
import type { ResolveDeps } from './resolve.ts'
import {
  approveDirect,
  db,
  enabled,
  fakeIndexer,
  fakeProposer,
  fakeRpc,
  migrateTestDb,
  openDb,
  quietLogger,
  resetForesight,
  seedDraft,
  skip,
  testMetrics,
  ORACLE,
  TREASURY,
} from './testsupport.ts'

const ISSUER = 'https://identity.test'
const IDENTITY = 'http://identity:4000'
const CUSTODY = 'http://custody:4000'
const CREDENTIAL = 'cfsc_5ntCPqB0ZQ3xk1r-8LHYyU2eWvJfA6oMdT4siGXn9Kc'
/** What `FORESIGHT_SERVICE_TOKEN` is today: a bearer this process cannot renew. */
const STATIC_TOKEN_SCOPES = ['custody:address:create', 'custody:sign:deployer']

/** identity/src/tokens.ts. Unchanged by this fix, and it must stay unchanged — rotation IS expiry. */
const SERVICE_TTL_SECONDS = 600

/** jobs.ts:recurringJobs — `deploy.sweep`. The number that makes the one above a defect. */
const DEPLOY_SWEEP_EVERY_SECONDS = 15

/** Well in the past: the database's clock is real and this one is not. See the header. */
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0)

/** Move the whole world — the provider's schedule and jose's expiry check — to `T0 + ms`. */
function clockAt(ms: number): void {
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: new Date(T0 + ms) })
}

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  mock.timers.reset()
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  mock.timers.reset()
  await resetForesight(sql)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * A REAL IDENTITY AND A REAL CUSTODY, in the sense that matters.
 *
 * Identity signs RS256 tokens with a 600-second expiry against the simulated clock. Custody hands
 * whatever it is given to a real `Verifier`, checks `custody:address:create` off the verified
 * principal, and answers 401 when jose says the token is bad. Nothing decides expiry by hand.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

interface World {
  readonly fetch: typeof globalThis.fetch
  exchanges: number
  /** Every custody call: the bearer presented, and what custody answered. */
  custodyCalls: { token: string | null; status: number }[]
  consecutive401: number
  /** A pre-minted token that is valid at `T0` and cannot be renewed. The defect's input. */
  readonly staticToken: string
  /**
   * Refuse the next bearer once, whatever it is, then behave normally.
   *
   * The case the SCHEDULE cannot cover and `authorizedFetch` exists for: a token this process
   * believes is fresh which custody rejects anyway — clock skew between the two, a credential
   * revoked mid-flight, a process paused between reading the token and sending it. The refresh point
   * is computed from this process's clock and `expiresIn`; custody decides from `exp` and ITS clock,
   * and nothing makes those agree.
   */
  refuseNextBearer: boolean
}

async function world(): Promise<World> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const keySet = (async () => publicKey) as never
  const verifier = new Verifier({ jwksUrl: 'http://unused', issuer: ISSUER, keySet })

  // RS256 is deterministic, so two tokens signed from the same payload at the same simulated instant
  // are the same string. identity mints a uuidv7 jti per token; the counter restores that, and
  // without it "the service minted a genuinely new token" could not be asserted at all.
  let jti = 0
  const mint = (scopes: readonly string[], issuedAtMs: number): Promise<string> =>
    new SignJWT({ typ: 'service', scopes, jti: `t-${++jti}` })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuedAt(Math.floor(issuedAtMs / 1000))
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('service:foresight')
      .setExpirationTime(Math.floor(issuedAtMs / 1000) + SERVICE_TTL_SECONDS)
      .sign(privateKey)

  const staticToken = await mint(STATIC_TOKEN_SCOPES, T0)

  const self: World = {
    exchanges: 0,
    custodyCalls: [],
    consecutive401: 0,
    staticToken,
    refuseNextBearer: false,

    fetch: (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url.startsWith(IDENTITY)) {
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${CREDENTIAL}`) {
          return new Response('{"error":"unauthenticated"}', { status: 401 })
        }
        self.exchanges += 1
        const token = await mint(STATIC_TOKEN_SCOPES, Date.now())
        return new Response(
          JSON.stringify({
            token,
            service: 'foresight',
            scopes: STATIC_TOKEN_SCOPES,
            expiresIn: SERVICE_TTL_SECONDS,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }

      // Custody's `POST /v1/addresses`, guarded exactly as custody guards it: a verified service
      // principal holding `custody:address:create`.
      //
      // The loop guard counts CONSECUTIVE refusals rather than total calls, because
      // `authorizedFetch` re-mints and replays exactly once on a 401 — a fault would show as an
      // unbroken run of them, while a cap on the total would be a cap on how many job runs a test
      // may drive, which is the wrong quantity entirely.
      if (self.consecutive401 > 4) throw new Error('the 401 replay is looping')
      const presented = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? null
      if (presented === null) {
        self.consecutive401 += 1
        self.custodyCalls.push({ token: null, status: 401 })
        return new Response('{"error":"unauthenticated"}', { status: 401 })
      }
      if (self.refuseNextBearer) {
        self.refuseNextBearer = false
        self.consecutive401 += 1
        self.custodyCalls.push({ token: presented, status: 401 })
        return new Response('{"error":"unauthenticated"}', { status: 401 })
      }
      try {
        const principal = await verifier.principal(presented)
        if (principal.kind !== 'service' || !principal.scopes.includes('custody:address:create')) {
          self.consecutive401 += 1
          self.custodyCalls.push({ token: presented, status: 403 })
          return new Response('{"error":"forbidden"}', { status: 403 })
        }
      } catch {
        // jose refused it: expired, or not signed by this key. THE CLIFF, seen from custody's side.
        self.consecutive401 += 1
        self.custodyCalls.push({ token: presented, status: 401 })
        return new Response('{"error":"unauthenticated"}', { status: 401 })
      }
      self.consecutive401 = 0
      self.custodyCalls.push({ token: presented, status: 201 })
      return new Response(
        JSON.stringify({
          key: {
            address: '0x' + '5a'.repeat(20),
            chain: 'ember',
            network: 'testnet',
            family: 'ember',
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch,
  }
  return self
}

/**
 * **`buildUpstreams`, not a hand-rolled client.** See the header: this is what makes the file a test
 * of THIS SERVICE'S wiring rather than of `@cloudsforge/auth`.
 */
function upstreamsFor(w: World, credential: string | null, staticToken: string | null) {
  const env: UpstreamEnv = {
    identityUrl: IDENTITY,
    identityCredential: credential,
    serviceToken: staticToken,
    custodyUrl: CUSTODY,
    indexerUrl: 'http://indexer:4000',
    pricingUrl: 'http://pricing.invalid',
    ledgerUrl: 'http://ledger:4000',
    policyUrl: 'http://policy:4000',
    adminApiUrl: undefined,
    upstreamDeadlineMs: 4_000,
    policyDeadlineMs: 2_000,
    policyAction: 'foresight.stake',
  }
  return buildUpstreams(env, { fetch: w.fetch, originatingService: 'foresight' })
}

/* ------------------------------------------------------------------ driving the real leased job */

function jobDepsFor(queue: JobQueue, custody: ReturnType<typeof upstreamsFor>['custody']): JobDeps {
  const logger = quietLogger()
  const metrics = testMetrics()
  // Gas price × limit exceeds the balance, so `driveDeploy` stops at `awaiting_funds` — AFTER the
  // custody round trip, which is the call this file is about. Keeping it short means the test
  // exercises the authentication rather than an EVM encoder it does not care about.
  const rpc = fakeRpc({ eth_gasPrice: '0x3b9aca00', eth_getBalance: '0x0' })
  const deploy: DeployDeps = {
    sql: db(sql),
    producer: 'foresight',
    owner: 'servicetoken-test',
    network: 'testnet',
    custody,
    rpc: () => rpc.rpc,
    bounds: { minGasPriceWei: 1n, maxGasPriceWei: 10_000_000_000n },
    gasLimit: 3_000_000n,
    treasuryAddress: TREASURY,
    oracleAddress: ORACLE,
    leaseMs: 120_000,
    stuckMs: 600_000,
    enabled: true,
    logger,
    metrics,
  }
  return {
    sql: db(sql),
    queue,
    producer: 'foresight',
    network: 'testnet',
    chain: 'ember',
    logger,
    metrics,
    proposer: fakeProposer({ proposals: [], reason: 'not_configured', searchQuery: null, modelId: null }, false),
    proposalBatchSize: 3,
    proposeEveryMinutes: 360,
    deploy,
    resolve: {} as ResolveDeps,
    mirror: { sql: db(sql), indexer: fakeIndexer(), pageSize: 10, logger, metrics },
    ledger: {
      async postEntry() {
        throw new Error('not used')
      },
      async balances() {
        throw new Error('not used')
      },
    },
  }
}

/** Approve a fresh market and drive `market.deploy` for it through a REAL `JobRunner`. */
async function driveOneDeploy(queue: JobQueue, runner: JobRunner): Promise<string> {
  const market = await seedDraft(sql)
  await approveDirect(sql, market.id)
  await queue.enqueue({ kind: MARKET_DEPLOY, key: market.id, payload: { marketId: market.id } })
  const claimed = await runner.tick()
  assert.equal(claimed, 1, 'the leased job did not run')
  return market.id
}

function harness(w: World, credential: string | null, staticToken: string | null) {
  const upstreams = upstreamsFor(w, credential, staticToken)
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'servicetoken-test', leaseMs: 120_000 })
  const runner = new JobRunner({ queue, concurrency: 1, pollMs: 10 })
  registerHandlers(jobDepsFor(queue, upstreams.custody), async () => {}, (kind, handler) =>
    runner.register(kind, handler),
  )
  return { upstreams, queue, runner }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CASES
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('the credential is EXCHANGED, and a leased job authenticates at minute zero', { skip }, async () => {
  clockAt(0)
  const w = await world()
  const { queue, runner, upstreams } = harness(w, CREDENTIAL, null)

  assert.equal(upstreams.mode, 'exchanged', 'buildUpstreams did not choose the credential')
  assert.equal(w.exchanges, 0, 'the provider exchanged before anything needed a token')

  const marketId = await driveOneDeploy(queue, runner)

  assert.equal(w.exchanges, 1, 'the credential was not exchanged for a token')
  assert.deepEqual(w.custodyCalls.map((call) => call.status), [201])
  assert.notEqual(w.custodyCalls[0]?.token, CREDENTIAL, 'the CREDENTIAL was presented as a bearer')
  assert.ok(w.custodyCalls[0]?.token?.startsWith('ey'), 'what was presented is not a JWT')
  // And the domain effect landed: the address custody minted is on the market.
  assert.equal((await findMarket(db(sql), marketId))?.deployerAddress?.toLowerCase(), '0x' + '5a'.repeat(20))
})

test('THE PROPERTY: eleven minutes on, the leased job still authenticates — and costs no 401', { skip }, async () => {
  clockAt(0)
  const w = await world()
  const { queue, runner } = harness(w, CREDENTIAL, null)

  await driveOneDeploy(queue, runner)
  const bootToken = w.custodyCalls[0]?.token
  assert.ok(bootToken)
  assert.equal(w.exchanges, 1)

  // ── ELEVEN MINUTES. The token this process minted at boot is now dead. ───────────────────────
  const elevenMinutes = 11 * 60 * 1_000
  clockAt(elevenMinutes)

  // Proved against a REAL `Verifier` and jose's own arithmetic rather than asserted. If this line
  // ever stops throwing, the rest of this test is meaningless and it should fail here.
  const verifier = new Verifier({ jwksUrl: 'http://unused', issuer: ISSUER })
  await assert.rejects(
    (async () => {
      const response = await w.fetch(`${CUSTODY}/v1/addresses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bootToken}` },
      })
      if (!response.ok) throw new Error(`custody refused the boot token: ${response.status}`)
    })(),
    /custody refused the boot token: 401/,
    'the boot token outlived 600 seconds; the cliff is not being modelled',
  )
  assert.ok(verifier, 'the verifier is constructed so the refusal above is a real jose refusal')

  const before401s = w.custodyCalls.filter((call) => call.status === 401).length
  const beforeCalls = w.custodyCalls.length

  // The job that fifteen-second sweep would run. Under the old seam this is where custody starts
  // 401ing for ever and the log blames custody.
  const marketId = await driveOneDeploy(queue, runner)

  const after = w.custodyCalls.slice(beforeCalls)
  assert.deepEqual(after.map((call) => call.status), [201], 'the post-expiry job did not authenticate')
  assert.notEqual(after[0]?.token, bootToken, 'the DEAD boot token was presented again')
  assert.equal(w.exchanges, 2, 'the provider did not re-mint on schedule')

  // ── THE ASSERTION THAT STOPS THIS BEING GREEN FOR THE WRONG REASON ──────────────────────────
  // `authorizedFetch` would have rescued a totally broken schedule with one 401 + re-mint + replay,
  // and the deploy would still have succeeded. Zero 401s means the token was refreshed BEFORE it
  // was presented, which is the guarantee. The replay path is the backstop, not the mechanism.
  assert.equal(
    w.custodyCalls.filter((call) => call.status === 401).length,
    before401s,
    'the post-expiry call cost a 401 — the refresh SCHEDULE is broken and the replay path hid it',
  )
  assert.equal((await findMarket(db(sql), marketId))?.deployerAddress?.toLowerCase(), '0x' + '5a'.repeat(20))
})

test('BASELINE: the seam this replaced 401s from minute ten, driven the same way', { skip }, async () => {
  clockAt(0)
  const w = await world()
  // `identityCredential: null`, `serviceToken: <a real 600s JWT>` — i.e. exactly what
  // `const token = () => env.serviceToken` did, and exactly what micro-deploy passes today.
  const { queue, runner, upstreams } = harness(w, null, w.staticToken)
  assert.equal(upstreams.mode, 'static', 'the baseline is not modelling the pre-minted token')

  await driveOneDeploy(queue, runner)
  assert.deepEqual(w.custodyCalls.map((call) => call.status), [201], 'the baseline failed at minute zero')

  clockAt(11 * 60 * 1_000)
  const marketId = await driveOneDeploy(queue, runner)

  // Every attempt refused, and NOTHING can renew: there is no credential to exchange, and
  // `authorizedFetch` is not in play because there is no provider to supply it.
  const after = w.custodyCalls.slice(1)
  assert.ok(after.length > 0, 'the post-expiry job made no custody call at all')
  assert.ok(
    after.every((call) => call.status === 401),
    `the baseline authenticated past the cliff (${JSON.stringify(after.map((c) => c.status))}) — it is not modelling the defect`,
  )
  assert.equal(w.exchanges, 0, 'the baseline exchanged something; it is not the old seam')

  // And here is the misattribution that made this so expensive: the market is stranded with no
  // deployer address, and nothing anywhere says the cause was this container's own credential.
  assert.equal((await findMarket(db(sql), marketId))?.deployerAddress, null)
})

test('EIGHT HOURS of the fifteen-second sweep, and not one 401', { skip }, async () => {
  clockAt(0)
  const w = await world()
  const { queue, runner } = harness(w, CREDENTIAL, null)

  // Thirty-two runs spread over eight hours — a whole shift, at a cadence far slower than the real
  // sweep's, chosen so each step crosses at least one token lifetime. A run every 15 seconds would
  // never test anything the first case does not.
  const RUNS = 32
  const STEP_MS = (8 * 60 * 60 * 1_000) / RUNS
  assert.ok(
    STEP_MS > SERVICE_TTL_SECONDS * 1_000,
    'the step is shorter than a token lifetime, so this proves nothing the minute-zero case does not',
  )
  assert.ok(DEPLOY_SWEEP_EVERY_SECONDS < SERVICE_TTL_SECONDS, 'the sweep is slower than the token; check jobs.ts')

  for (let run = 0; run < RUNS; run += 1) {
    clockAt(run * STEP_MS)
    await driveOneDeploy(queue, runner)
  }

  assert.equal(w.custodyCalls.length, RUNS, 'a run made more than one custody call')
  assert.deepEqual(
    [...new Set(w.custodyCalls.map((call) => call.status))],
    [201],
    'a run in the eight hours was refused',
  )
  // One exchange per run, because each step is longer than a token's whole life. The point is that
  // it kept up, not the exact count — but a count of 1 would mean the schedule never fired.
  assert.ok(w.exchanges >= RUNS - 1, `the provider exchanged only ${w.exchanges} times across ${RUNS} runs`)
  // Distinct bearers, so "it re-minted" is a fact about the wire rather than about a counter.
  assert.ok(new Set(w.custodyCalls.map((call) => call.token)).size >= RUNS - 1, 'the same token was reused past its life')
})

test('THE PRECEDENCE: with BOTH set, the credential wins and the dead token is never presented', { skip }, async () => {
  // **This is the state micro-deploy will actually be in**, and it is the state this file did not
  // originally cover — a fact found by breaking `upstreams.ts` and watching nothing go red.
  // `FORESIGHT_SERVICE_TOKEN` is set today and stays set while the credential is added; if the
  // static token won, the deploy would look correct, the boot log would say `exchanged`, and the
  // cliff would still be there. Nothing else in this file can see that, because every other case
  // sets exactly one of the two.
  clockAt(0)
  const w = await world()
  const { queue, runner, upstreams } = harness(w, CREDENTIAL, w.staticToken)
  assert.equal(upstreams.mode, 'exchanged', 'the pre-minted token beat the credential')

  await driveOneDeploy(queue, runner)
  assert.equal(w.exchanges, 1, 'the credential was not exchanged; the static token was used instead')
  assert.notEqual(w.custodyCalls[0]?.token, w.staticToken, 'the un-renewable token was presented')

  // Eleven minutes on, the static token is dead. If it had won at minute zero this would 401.
  clockAt(11 * 60 * 1_000)
  const before = w.custodyCalls.length
  await driveOneDeploy(queue, runner)
  assert.deepEqual(w.custodyCalls.slice(before).map((call) => call.status), [201])
  assert.equal(w.exchanges, 2)
})

test('THE BACKSTOP: a bearer this process believes is fresh, refused anyway, is re-minted and replayed once', { skip }, async () => {
  // The case the SCHEDULE cannot cover: the refresh point is computed from this process's clock and
  // `expiresIn`, custody decides from `exp` and ITS clock, and nothing makes those agree. A
  // credential revoked mid-flight looks identical. Without `authorizedFetch` in the wiring,
  // correctness would rest on two machines agreeing about the time — and on a fifteen-second job
  // that is one skewed clock away from being back where it started.
  clockAt(0)
  const w = await world()
  const { queue, runner } = harness(w, CREDENTIAL, null)

  w.refuseNextBearer = true
  const marketId = await driveOneDeploy(queue, runner)

  assert.deepEqual(
    w.custodyCalls.map((call) => call.status),
    [401, 201],
    'the 401 was not replayed — `authorizedFetch` is not wired into the clients',
  )
  assert.notEqual(w.custodyCalls[1]?.token, w.custodyCalls[0]?.token, 'the REJECTED token was replayed unchanged')
  assert.equal(w.exchanges, 2, 'the rejected token was not discarded and re-minted')
  // And the job still did its work, which is the point: a skewed clock is survivable, not fatal.
  assert.equal((await findMarket(db(sql), marketId))?.deployerAddress?.toLowerCase(), '0x' + '5a'.repeat(20))
})

test('no credential and no token is a 503 named at the source, never a 401 blamed on custody', { skip }, async () => {
  clockAt(0)
  const w = await world()
  const { queue, runner, upstreams } = harness(w, null, null)
  assert.equal(upstreams.mode, 'none')

  const marketId = await driveOneDeploy(queue, runner)

  // **Nothing was sent.** `HttpClient` omits the header for `undefined`, so a resolve-to-undefined
  // would have gone out unauthenticated, come back 401, and been recorded as custody refusing this
  // service's token — when the truth is nobody gave this service one. Those are different mornings.
  assert.deepEqual(w.custodyCalls, [], 'an unauthenticated request was sent to custody')
  assert.equal((await findMarket(db(sql), marketId))?.deployerAddress, null)
})
