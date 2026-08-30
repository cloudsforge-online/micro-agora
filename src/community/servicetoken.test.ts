/**
 * **A TREASURY SPEND, DRIVEN PAST THE TOKEN'S OWN EXPIRY.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## The defect, as measured rather than as reasoned about
 *
 * `COMMUNITY_SERVICE_CREDENTIAL` held a token that lives **600 seconds**
 * (`identity/src/tokens.ts`). The composition root read it once, at import —
 * `const token = () => env.serviceCredential` (`index.ts`) — and handed that to the ledger, to
 * policy and to the indexer oracle. On the live estate (2026-08-05) the value in that variable had
 * been **expired for 26 hours** on a container reporting healthy, because `/livez` needs no upstream
 * and therefore never presents the credential to anybody.
 *
 * ## Why the symptom is a DENIAL rather than an absence
 *
 * A 401 is a 4xx, so `HttpError.peerDecided` is true, so `policyclient.ts` reads it as
 * **policy deciding** and answers `{decision: 'deny', reasons: ['policy_401']}`. `executions.ts`
 * turns any non-`allow` into `SpendRefusedError`, and `jobs.ts` **swallows** a refusal —
 * deliberately, because a refusal is an answer and retrying it would turn one decision into eight.
 *
 * So a community that voted, waited out its timelock and passed a spend is told the platform refused
 * it, by a gate that was never asked, and the job completes. That is what `BASELINE` below
 * reproduces: `deny`/`policy_401` at minute eleven from the exact seam this replaces.
 *
 * ## Why every other test in this repository is blind to it
 *
 * They build their own client, or a fake, and do it a millisecond later. **A test that mints a token
 * and immediately uses it proves nothing about this defect** — the token is never asked to survive
 * its own lifetime, and at the speed of a test a hard-coded string and a live credential are
 * indistinguishable. `clients.test.ts` is green against a `fetch` that never reads a header. Below,
 * the clock moves **ELEVEN MINUTES**, the boot token is shown to be refused **by a real `Verifier`**,
 * and only then is the spend attempted.
 *
 * ## The assertion that stops this file being green for the wrong reason
 *
 * `authorizedFetch` re-mints and replays on a 401. So a completely broken refresh SCHEDULE would
 * still end in a real verdict — one 401, one re-mint, one replay — and a test that only checked the
 * verdict would pass straight over it. The post-expiry case therefore asserts **zero 401s**: the
 * token must have been refreshed before it was ever presented. The schedule is the mechanism; the
 * replay path is the backstop, and `THE BACKSTOP` below covers it separately.
 *
 * The gate's answer here is **`allow`**, on purpose. It is the one verdict this client can never
 * invent for itself: a 4xx becomes `deny`, an unreadable 201 throws `PolicyUnavailableError`, and no
 * failure path produces an allow. So reading `allow` back is proof the gate was consulted rather
 * than defaulted.
 *
 * ## What is real here, and what is not
 *
 *   * **Real**: `buildUpstreams` (the wiring under test), `ServiceTokenProvider`, `HttpClient`,
 *     `httpPolicyClient`, `httpLedgerClient`, `indexerOracle`, a real `Verifier` and jose's own
 *     expiry arithmetic. The verdicts below come back through the real client's real parsing.
 *   * **Simulated**: the clock, and the peers' transports. `mock.timers` moves `Date` only, so jose
 *     decides expiry from the same instant the provider schedules against — nothing here decides
 *     expiry by hand, which is how a test ends up agreeing with the code it is checking.
 *
 * ## Going through `buildUpstreams` is the whole point
 *
 * A test that constructs its own `ServiceTokenProvider` and its own `httpPolicyClient` proves the
 * provider works, which is `@cloudsforge/auth`'s job. It proves nothing about whether THIS SERVICE
 * uses it, and "this service does not use it" was the defect. Reverting `upstreams.ts` to
 * `token: () => env.serviceCredential` turns the first two tests below red.
 *
 * No database. Nothing here touches a table, so it runs wherever `node --test` does.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SignJWT, generateKeyPair } from 'jose'
import { AUDIENCE, Verifier } from '@cloudsforge/auth'
import { buildUpstreams, type UpstreamEnv } from './upstreams.ts'
import { LEDGER_SCOPES, LedgerRefusedError, idempotencyKeys, spendPostings } from './ledgerclient.ts'
import { POLICY_SCOPES, PolicyUnavailableError, type SpendPolicyInput } from './policyclient.ts'
import { INDEXER_SCOPES } from './gating.ts'

const ISSUER = 'https://identity.test'
const IDENTITY = 'http://identity:4000'
const POLICY = 'http://policy:4000'
const LEDGER = 'http://ledger:4000'
const INDEXER = 'http://indexer:4000'

/**
 * Fabricated: identity's shape, none of its entropy. **Never a value out of `tokens.env`.**
 *
 * The hyphens are deliberate — a credential body is base64**url**, the testnet credential contains
 * one and the mainnet one does not, so a fixture without them would let a "no hyphens" rule reach an
 * estate. Same reasoning as `env.test.ts`.
 */
const CREDENTIAL = 'cfsc_TToR-eOeVTDnqhX1-nu6-u7DoCr4MCfa86g4g6kd404'

/** identity/src/tokens.ts. Unchanged by this fix, and it must stay unchanged — rotation IS expiry. */
const SERVICE_TTL_SECONDS = 600

/** What this service actually demands of its own token, read from the files that declare it. */
const SCOPES = [...POLICY_SCOPES, ...LEDGER_SCOPES, ...INDEXER_SCOPES] as readonly string[]

/** Well in the past, and fixed, so nothing here depends on the day it is run. */
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0)

/** Move the whole world — the provider's schedule and jose's expiry check — to `T0 + ms`. */
function clockAt(ms: number): void {
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: new Date(T0 + ms) })
}

afterEach(() => mock.timers.reset())

const PROPOSAL = '11111111-1111-4111-8111-111111111111'
const COMMUNITY = '22222222-2222-4222-8222-222222222222'

const SPEND: SpendPolicyInput = {
  communityId: COMMUNITY,
  proposalId: PROPOSAL,
  amount: '250000',
  assetCode: 'EMBER',
  recipientSubject: 'user:33333333-3333-4333-8333-333333333333',
  correlationId: `execute:${PROPOSAL}`,
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * A REAL IDENTITY, A REAL POLICY AND A REAL LEDGER, in the sense that matters.
 *
 * Identity signs RS256 tokens with a 600-second expiry against the simulated clock. The peers hand
 * whatever they are given to a real `Verifier`, check the scope they require off the verified
 * principal, and answer 401 when jose says the token is bad — which is what the live estate's policy
 * did. Nothing decides expiry by hand.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

type Peer = 'policy' | 'ledger' | 'indexer'

interface Call {
  readonly peer: Peer
  readonly token: string | null
  readonly status: number
}

interface World {
  readonly fetch: typeof globalThis.fetch
  exchanges: number
  calls: Call[]
  consecutive401: number
  /** A pre-minted token valid at `T0` that cannot be renewed. The defect's input. */
  readonly staticToken: string
  /**
   * Refuse the next bearer once, whatever it is, then behave normally.
   *
   * The case the SCHEDULE cannot cover and `authorizedFetch` exists for: a token this process
   * believes is fresh which policy rejects anyway — clock skew between the two, a credential revoked
   * mid-flight, a process paused between reading the token and sending it.
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
  const mint = (issuedAtMs: number): Promise<string> =>
    new SignJWT({ typ: 'service', scopes: SCOPES, jti: `t-${++jti}` })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuedAt(Math.floor(issuedAtMs / 1000))
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('service:community')
      .setExpirationTime(Math.floor(issuedAtMs / 1000) + SERVICE_TTL_SECONDS)
      .sign(privateKey)

  const staticToken = await mint(T0)

  const self: World = {
    exchanges: 0,
    calls: [],
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
        return new Response(
          JSON.stringify({
            token: await mint(Date.now()),
            service: 'community',
            scopes: SCOPES,
            expiresIn: SERVICE_TTL_SECONDS,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }

      const peer: Peer = url.startsWith(POLICY) ? 'policy' : url.startsWith(LEDGER) ? 'ledger' : 'indexer'
      const need =
        peer === 'policy' ? 'policy:decide' : peer === 'ledger' ? 'ledger:post' : 'indexer:read'

      // The loop guard counts CONSECUTIVE refusals rather than total calls, because
      // `authorizedFetch` re-mints and replays exactly once on a 401 — a fault would show as an
      // unbroken run of them, while a cap on the total would be a cap on how many spends a test may
      // drive, which is the wrong quantity entirely.
      if (self.consecutive401 > 4) throw new Error('the 401 replay is looping')

      const presented = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? null
      const refuse = (status: number): Response => {
        self.consecutive401 += 1
        self.calls.push({ peer, token: presented, status })
        return new Response(
          '{"error":{"code":"unauthenticated","message":"a valid bearer token is required"}}',
          { status },
        )
      }

      if (presented === null) return refuse(401)
      if (self.refuseNextBearer) {
        self.refuseNextBearer = false
        return refuse(401)
      }
      try {
        const principal = await verifier.principal(presented)
        if (principal.kind !== 'service' || !principal.scopes.includes(need)) return refuse(403)
      } catch {
        // jose refused it: expired, or not signed by this key. THE CLIFF, seen from policy's side.
        return refuse(401)
      }

      self.consecutive401 = 0
      self.calls.push({ peer, token: presented, status: 201 })
      // `allow` on purpose: see the header. It is the one verdict no failure path in
      // `policyclient.ts` can produce, so reading it back is proof the gate was really consulted.
      return new Response(
        peer === 'policy'
          ? JSON.stringify({ decision: { decision: 'allow', reasons: ['within_treasury_limit'] } })
          : peer === 'ledger'
            ? JSON.stringify({
                entry: { id: 'entry-1', kind: 'treasury_spend', recordedAt: '2024-01-01T00:00:00Z' },
                replayed: false,
              })
            : JSON.stringify({ balance: '5000' }),
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
function upstreamsFor(
  w: World,
  credential: string | null,
  staticToken: string | null,
  indexerBaseUrl: string | null = INDEXER,
) {
  const env: UpstreamEnv = {
    identityUrl: IDENTITY,
    identityCredential: credential,
    serviceCredential: staticToken,
    ledgerBaseUrl: LEDGER,
    ledgerDeadlineMs: 5_000,
    policyBaseUrl: POLICY,
    policyDeadlineMs: 3_000,
    indexerBaseUrl,
    indexerNetwork: 'mainnet',
    indexerDeadlineMs: 5_000,
  }
  return buildUpstreams(env, { fetch: w.fetch, originatingService: 'community' })
}

/** The two legs of a real spend, built by the real function the execute job uses. */
function spendEntry() {
  return {
    kind: 'treasury_spend' as const,
    actor: 'service:community' as const,
    correlationId: `execute:${PROPOSAL}`,
    idempotencyKey: idempotencyKeys.execute(PROPOSAL),
    postings: spendPostings({
      treasurySubject: `community:${COMMUNITY}`,
      recipientSubject: 'user:33333333-3333-4333-8333-333333333333',
      assetCode: 'EMBER',
      amount: 250_000n,
    }),
  }
}

const callsTo = (w: World, peer: Peer): Call[] => w.calls.filter((call) => call.peer === peer)
const count401 = (w: World): number => w.calls.filter((call) => call.status === 401).length

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CASES
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('the credential is EXCHANGED, and the spend gate really answers at minute zero', async () => {
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)

  assert.equal(upstreams.mode, 'exchanged', 'buildUpstreams did not choose the credential')
  assert.equal(w.exchanges, 0, 'the provider exchanged before anything needed a token')

  const verdict = await upstreams.policy.evaluateSpend(SPEND)

  assert.equal(verdict.decision, 'allow', 'the gate was not consulted')
  assert.deepEqual(verdict.reasons, ['within_treasury_limit'])
  assert.equal(w.exchanges, 1, 'the credential was not exchanged for a token')
  assert.deepEqual(callsTo(w, 'policy').map((call) => call.status), [201])

  // ── THE CREDENTIAL IS NEVER A BEARER ────────────────────────────────────────────────────────
  // It is long-lived and revocable. Presenting it to a peer would put a credential that outlives
  // every token in three services' access logs, and any of them could then mint tokens as us.
  assert.notEqual(callsTo(w, 'policy')[0]?.token, CREDENTIAL, 'the CREDENTIAL was presented as a bearer')
  assert.ok(callsTo(w, 'policy')[0]?.token?.startsWith('ey'), 'what was presented is not a JWT')
  assert.ok(
    !w.calls.some((call) => call.token === CREDENTIAL),
    'the raw credential reached a peer',
  )
})

test('THE PROPERTY: eleven minutes on, the treasury still spends — and it costs no 401', async () => {
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)

  await upstreams.policy.evaluateSpend(SPEND)
  const bootToken = callsTo(w, 'policy')[0]?.token
  assert.ok(bootToken)
  assert.equal(w.exchanges, 1)

  // ── ELEVEN MINUTES. The token this process minted at boot is now dead. ───────────────────────
  clockAt(11 * 60 * 1_000)

  // Proved against a REAL `Verifier` and jose's own arithmetic rather than asserted. If this line
  // ever stops throwing, the rest of this test is meaningless and it should fail here.
  await assert.rejects(
    (async () => {
      const response = await w.fetch(`${POLICY}/decisions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bootToken}` },
      })
      if (!response.ok) throw new Error(`policy refused the boot token: ${response.status}`)
    })(),
    /policy refused the boot token: 401/,
    'the boot token outlived 600 seconds; the cliff is not being modelled',
  )

  const before401s = count401(w)
  const beforeCalls = w.calls.length

  // The proposal a community executes eleven minutes after a deploy. Under the old seam this is
  // where the spend starts coming back "refused by policy" for ever, with the refusal recorded
  // against the community and the job completing.
  const verdict = await upstreams.policy.evaluateSpend(SPEND)
  const entry = await upstreams.ledger.postEntry(spendEntry())

  const after = w.calls.slice(beforeCalls)
  assert.deepEqual(after.map((call) => call.status), [201, 201], 'the post-expiry spend was refused')
  assert.ok(
    after.every((call) => call.token !== bootToken),
    'the DEAD boot token was presented again',
  )
  assert.equal(verdict.decision, 'allow', 'the gate refused a spend it was never asked about')
  assert.equal(entry.id, 'entry-1', 'the ledger did not post the spend')
  assert.equal(w.exchanges, 2, 'the provider did not re-mint on schedule')

  // ── THE ASSERTION THAT STOPS THIS BEING GREEN FOR THE WRONG REASON ──────────────────────────
  // `authorizedFetch` would have rescued a totally broken schedule with one 401 + re-mint + replay,
  // and the verdict would still have come back. Zero 401s means the token was refreshed BEFORE it
  // was presented, which is the guarantee. The replay path is the backstop, not the mechanism.
  assert.equal(
    count401(w),
    before401s,
    'the post-expiry call cost a 401 — the refresh SCHEDULE is broken and the replay path hid it',
  )
})

test('BASELINE: the seam this replaced turns a PASSED vote into a REFUSED one at minute ten', async () => {
  clockAt(0)
  const w = await world()
  // `identityCredential: null`, `serviceCredential: <a real 600s JWT>` — i.e. exactly what
  // `const token = () => env.serviceCredential` did, and exactly what the estate runs today.
  const upstreams = upstreamsFor(w, null, w.staticToken)
  assert.equal(upstreams.mode, 'static', 'the baseline is not modelling the pre-minted token')

  const atBoot = await upstreams.policy.evaluateSpend(SPEND)
  assert.equal(atBoot.decision, 'allow', 'the baseline failed at minute zero')

  clockAt(11 * 60 * 1_000)
  const after = await upstreams.policy.evaluateSpend(SPEND)

  // ── **THE 26 HOURS, REPRODUCED.** ───────────────────────────────────────────────────────────
  // Not an error, not a degraded flag: a `deny`. `executions.ts` turns this into
  // `SpendRefusedError` and `jobs.ts` SWALLOWS it as an answer, so the job completes,
  // `community_executions_total{outcome="refused"}` climbs, and the members of a community that
  // voted and waited out a timelock are told the platform refused their spend — by a gate that was
  // never asked. Nothing anywhere names this container's own credential.
  assert.equal(after.decision, 'deny')
  assert.deepEqual(after.reasons, ['policy_401'])
  assert.deepEqual(w.calls.slice(1).map((call) => call.status), [401])
  assert.equal(w.exchanges, 0, 'the baseline exchanged something; it is not the old seam')

  // And the ledger side of the same minute: a 401 is `peerDecided`, so it becomes the PERMANENT
  // class — the one the execute path must never retry with the same request.
  await assert.rejects(() => upstreams.ledger.postEntry(spendEntry()), LedgerRefusedError)
})

test('THE PRECEDENCE: with BOTH set, the credential wins and the dead token is never presented', async () => {
  // **This is the state the estate will actually be in**: `COMMUNITY_SERVICE_CREDENTIAL` is set
  // today and stays set while the credential is added. If the static token won, the deploy would
  // look correct, the boot log would say `exchanged`, and the cliff would still be there. No other
  // case in this file can see that, because each sets exactly one of the two.
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, w.staticToken)
  assert.equal(upstreams.mode, 'exchanged', 'the pre-minted token beat the credential')

  await upstreams.policy.evaluateSpend(SPEND)
  assert.equal(w.exchanges, 1, 'the credential was not exchanged; the static token was used instead')
  assert.notEqual(w.calls[0]?.token, w.staticToken, 'the un-renewable token was presented')

  // Eleven minutes on, the static token is dead. If it had won at minute zero this would deny.
  clockAt(11 * 60 * 1_000)
  const verdict = await upstreams.policy.evaluateSpend(SPEND)
  assert.equal(verdict.decision, 'allow')
  assert.equal(w.exchanges, 2)
  assert.ok(
    !w.calls.some((call) => call.token === w.staticToken),
    'the dead pre-minted token was presented to a peer',
  )
})

test('THE BACKSTOP: a bearer this process believes is fresh, refused anyway, is re-minted and replayed once', async () => {
  // The case the SCHEDULE cannot cover: the refresh point is computed from this process's clock and
  // `expiresIn`, policy decides from `exp` and ITS clock, and nothing makes those agree. A
  // credential revoked mid-flight looks identical. Without `authorizedFetch` in the wiring the spend
  // would come back `deny`/`policy_401` — and `POST /decisions` carries no idempotency key, so
  // `HttpClient` attempts it exactly once and would not retry its way out.
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)

  w.refuseNextBearer = true
  const verdict = await upstreams.policy.evaluateSpend(SPEND)

  assert.deepEqual(
    w.calls.map((call) => call.status),
    [401, 201],
    'the 401 was not replayed — `authorizedFetch` is not wired into the clients',
  )
  assert.notEqual(w.calls[1]?.token, w.calls[0]?.token, 'the REJECTED token was replayed unchanged')
  assert.equal(w.exchanges, 2, 'the rejected token was not discarded and re-minted')
  // And the gate still decided, which is the point: a skewed clock is survivable, not a denial.
  assert.equal(verdict.decision, 'allow')
})

test('no credential and no token sends NOTHING, rather than an unauthenticated request', async () => {
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, null, null)
  assert.equal(upstreams.mode, 'none')

  // **Nothing was sent.** `HttpClient` omits the header for `undefined`, so a resolve-to-undefined
  // would have gone out unauthenticated, come back 401, and — through `policyclient.ts`'s decided-4xx
  // branch — been recorded as a `deny` against the community. It is not a denial and policy is not
  // down: nobody gave this service a credential. `PolicyUnavailableError` is the fail-closed class,
  // so `jobs.ts` re-throws, the job retries, and the treasury is not touched while we cannot ask.
  await assert.rejects(() => upstreams.policy.evaluateSpend(SPEND), PolicyUnavailableError)
  assert.deepEqual(w.calls, [], 'an unauthenticated request was sent to policy')
})

test('the LEDGER and the INDEXER are on the same credential — the wiring is not policy-only', async () => {
  // `upstreams.ts` hands one `token` and one `fetch` to all three clients, and this is the assertion
  // that says so about the other two. The ledger is the hard dependency: without it no treasury
  // spend posts at all. The indexer is the one whose failure is SILENT — every failure answers
  // `unknown`, and `unknown` never demotes, so a dead credential there stops token gating running
  // with nothing but `community_gate_checks_total{outcome="unknown"}` to say so.
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)

  clockAt(11 * 60 * 1_000)
  const entry = await upstreams.ledger.postEntry(spendEntry())
  // 7411 is Hearth mainnet in `@cloudsforge/contracts-chain`, and the subject must carry a real EVM
  // address or `chainAddressOf` refuses to ask — see `gating.ts`.
  const holding = await upstreams.oracle.holdingAt(
    7411,
    '0x1111111111111111111111111111111111111111',
    'user:0x2222222222222222222222222222222222222222',
    null,
  )

  assert.equal(entry.id, 'entry-1')
  assert.equal(holding?.balance, 5_000n, 'the indexer call was not authenticated')
  assert.deepEqual(w.calls.map((call) => [call.peer, call.status]), [
    ['ledger', 201],
    ['indexer', 201],
  ])
  assert.equal(w.exchanges, 1)
})

test('no indexer configured is still a supported mode, and it asks nobody', async () => {
  // Unchanged by #222 and deliberately so: an oracle that knows nothing answers `unknown`, and an
  // unknown holding never demotes a member. An oracle that returned zero would evict every
  // token-gated member on the first pass.
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null, null)

  const holding = await upstreams.oracle.holdingAt(7411, '0x11', 'user:0x22', null)

  assert.equal(holding, null, 'the absent indexer answered something other than unknown')
  assert.deepEqual(w.calls, [], 'a request was sent with no indexer configured')
  assert.equal(w.exchanges, 0)
})
