/**
 * **THE KILN, THE TREASURY AND THE TEN-MINUTE TOKEN, DRIVEN PAST THE EXPIRY.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## The defect, as measured rather than as reasoned about (micro-org #222)
 *
 * `TESSERA_SERVICE_CREDENTIAL` held a token that lives **600 seconds**
 * (`identity/src/tokens.ts`). The composition root read it once, at import —
 * `token: async () => env.serviceCredential ?? ''` — and handed that one function to the studio
 * client (`index.ts`) and the ledger client. On the live estate the JWT in that
 * variable had been expired for **twenty-six hours** while the container reported healthy, because
 * `/livez` verifies nothing and presents the credential to nobody.
 *
 * ## Why every other test in this repository is blind to it
 *
 * They build their own client, against their own stub, and do it a millisecond later. **A test that
 * mints a token and immediately uses it proves nothing about this defect** — the token is never
 * asked to survive its own lifetime, and at the speed of a test a hard-coded string and a live
 * credential are indistinguishable. `kiln.test.ts` and `marketseam.test.ts` beside this file are
 * green against fakes that never read an `Authorization` header at all.
 *
 * That is the property this file removes: below, the clock moves **ELEVEN MINUTES** past a token the
 * process already holds, that token is shown to be refused **by a real `Verifier`**, and only then
 * is the firing or the grant attempted again.
 *
 * ## The assertion that stops this file being green for the wrong reason
 *
 * `authorizedFetch` re-mints and replays on a 401. So a completely broken refresh SCHEDULE would
 * still end in a successful grant — one 401, one re-mint, one replay — and a test that only checked
 * the grant would pass straight over it. The post-expiry case therefore asserts **zero 401s**: the
 * token must have been refreshed BEFORE it was ever presented. The replay path is the backstop, not
 * the mechanism, and it has a case of its own further down.
 *
 * ## Going through `buildUpstreams` is the whole point
 *
 * A test that constructs its own `ServiceTokenProvider` and its own `createLedgerClient` proves the
 * provider works, which is `@cloudsforge/auth`'s job. It proves nothing about whether THIS SERVICE
 * uses it, and "this service does not use it" was the defect. Reverting `upstreams.ts` to
 * `async () => env.serviceCredential ?? ''` turns the first two tests below red — and `BASELINE`
 * models that exact old seam, against the same fixtures, so this file also demonstrates the failure
 * it fixes.
 *
 * ## What is real here, and what is not
 *
 *   * **Real**: `buildUpstreams` (the wiring under test), `ServiceTokenProvider`, `HttpClient`,
 *     `createStudioClient`, `createLedgerClient`, `createMarketClient`, `grantFromEngagement`, a
 *     real `Verifier` and jose's own expiry arithmetic. Every answer below comes back through the
 *     real client's real parsing.
 *   * **Simulated**: the clock, and the peers' transports. `mock.timers` moves `Date` only, so jose
 *     decides expiry from the same instant the provider schedules against — nothing here decides
 *     expiry by hand, which is how a test ends up agreeing with the code it is checking.
 *
 * No database. Nothing here touches a table, so it runs wherever `node --test` does.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SignJWT, generateKeyPair } from 'jose'
import { AUDIENCE, Verifier } from '@cloudsforge/auth'
import { buildUpstreams, type UpstreamEnv } from './upstreams.ts'
import { LEDGER_SCOPES, grantFromEngagement } from './ledgerclient.ts'
import { objectAssetCode, objectUrn } from './itemasset.ts'

const ISSUER = 'https://identity.test'
const IDENTITY = 'http://identity:4000'
const STUDIO = 'http://studio:4000'
const LEDGER = 'http://ledger:4000'
const MARKET = 'http://market:4000'
const COMMUNITY = 'http://community:4000'

/**
 * Fabricated: identity's SHAPE, none of its entropy, and never a value out of
 * `deploy/compose/estate/tokens.env`. The hyphen is deliberate — a credential body is base64**url**,
 * the testnet credential contains one and the mainnet credential does not, so a fixture without one
 * would let a "no hyphens" rule pass CI and kill testnet at boot. See `env.test.ts`.
 */
const CREDENTIAL = 'cfsc_0000000000000000000000-0000000000000test'

/** identity/src/tokens.ts. Unchanged by this fix, and it must stay unchanged — rotation IS expiry. */
const SERVICE_TTL_SECONDS = 600

/** What this service actually demands of its own token, read from the files that declare it. */
const SCOPES: readonly string[] = [...LEDGER_SCOPES, 'studio:write']

/** The creator. A real uuid, because `subjectOf` turns it into the seller market pays. */
const AUTHOR_ID = '11111111-1111-4111-8111-111111111111'
const AUTHOR = `user:${AUTHOR_ID}`

/** Well in the past, and fixed, so nothing here depends on the day it is run. */
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0)

/** Move the whole world — the provider's schedule and jose's expiry check — to `T0 + ms`. */
function clockAt(ms: number): void {
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: new Date(T0 + ms) })
}

afterEach(() => mock.timers.reset())

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * A REAL IDENTITY, A REAL STUDIO, A REAL LEDGER AND A REAL MARKET, in the sense that matters.
 *
 * Identity signs RS256 tokens with a 600-second expiry against the simulated clock. Each peer hands
 * whatever it is given to a real `Verifier`, checks the scope its own route gates on, and answers
 * 401 when jose says the token is bad — which is what the live estate's studio did. Nothing decides
 * expiry by hand.
 *
 * Market is the exception and the asymmetry is the substance of that feature: it reads the SELLER
 * off the presented principal exactly as `market/src/server.ts` does through `subjectOf`
 *, and answers with that subject. So a service token leaking onto that seam does not fail
 * — it comes back as a listing whose seller is `service:tessera`, which is the silent theft
 * `marketclient.ts`'s header is about, and which the case at the foot of this file asserts against.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

type Peer = 'studio' | 'ledger' | 'market' | 'community'

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
  /** The creator's own bearer, which is what market must be shown and this service must not replace. */
  readonly sellerToken: string
  /**
   * Refuse the next bearer once, whatever it is, then behave normally.
   *
   * The case the SCHEDULE cannot cover and `authorizedFetch` exists for: a token this process
   * believes is fresh which studio rejects anyway — clock skew between the two, a credential revoked
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
  const mintService = (issuedAtMs: number): Promise<string> =>
    new SignJWT({ typ: 'service', scopes: SCOPES, jti: `t-${++jti}` })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuedAt(Math.floor(issuedAtMs / 1000))
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('service:tessera')
      .setExpirationTime(Math.floor(issuedAtMs / 1000) + SERVICE_TTL_SECONDS)
      .sign(privateKey)

  const staticToken = await mintService(T0)
  // The creator's token. A USER principal, and long-lived here only so that the market case is
  // about which bearer was relayed rather than about when it expired.
  const sellerToken = await new SignJWT({ handle: 'kilnwright', roles: ['player'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt(Math.floor(T0 / 1000))
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(AUTHOR_ID)
    .setExpirationTime(Math.floor(T0 / 1000) + 24 * 60 * 60)
    .sign(privateKey)

  const self: World = {
    exchanges: 0,
    calls: [],
    consecutive401: 0,
    staticToken,
    sellerToken,
    refuseNextBearer: false,

    fetch: (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url.startsWith(IDENTITY)) {
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${CREDENTIAL}`) {
          return new Response('{"error":"unauthenticated"}', { status: 401 })
        }
        self.exchanges += 1
        return json(201, {
          token: await mintService(Date.now()),
          service: 'tessera',
          scopes: SCOPES,
          expiresIn: SERVICE_TTL_SECONDS,
        })
      }

      const peer: Peer = url.startsWith(STUDIO)
        ? 'studio'
        : url.startsWith(LEDGER)
          ? 'ledger'
          : url.startsWith(MARKET)
            ? 'market'
            : 'community'

      // The loop guard counts CONSECUTIVE refusals rather than total calls, because
      // `authorizedFetch` re-mints and replays exactly once on a 401 — a fault would show as an
      // unbroken run of them, while a cap on the total would be a cap on how many firings a test may
      // drive, which is the wrong quantity entirely.
      if (self.consecutive401 > 4) throw new Error('the 401 replay is looping')

      const presented = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? null
      const refuse = (status: number): Response => {
        self.consecutive401 += 1
        self.calls.push({ peer, token: presented, status })
        return new Response(
          '{"error":{"code":"unauthenticated","message":"a valid bearer token is required"}}',
          { status, headers: { 'content-type': 'application/json' } },
        )
      }

      if (presented === null) return refuse(401)
      if (self.refuseNextBearer) {
        self.refuseNextBearer = false
        return refuse(401)
      }

      let seller: string
      try {
        const principal = await verifier.principal(presented)
        // `subjectOf`, market/src/server.ts — the whole reason a service token must not reach
        // market. Computed for every peer so it is one code path rather than a special case.
        seller = principal.kind === 'user' ? `user:${principal.userId}` : `service:${principal.service}`
        const need = peer === 'studio' ? 'studio:write' : peer === 'ledger' ? 'ledger:post' : null
        if (need !== null) {
          if (principal.kind !== 'service' || !principal.scopes.includes(need)) return refuse(403)
        }
      } catch {
        // jose refused it: expired, or not signed by this key. THE CLIFF, seen from the peer's side.
        return refuse(401)
      }

      self.consecutive401 = 0
      self.calls.push({ peer, token: presented, status: 201 })

      if (peer === 'studio') {
        // The owner is read back and checked by the client — a kit owned by `service:tessera`
        // instead of by the player is the failure `studioclient.ts` refuses. So the fake answers
        // with the author the request named, and lets that check be real.
        const body = JSON.parse(String(init?.body ?? '{}')) as { userId?: string }
        return json(201, { brandKit: { id: 'kit-1', ownerSubject: `user:${body.userId ?? ''}` } })
      }
      if (peer === 'ledger') {
        return json(201, { entry: { id: 'entry-1' }, replayed: false })
      }
      return json(201, {
        listing: {
          id: 'listing-1',
          // **Market's own answer, derived from the bearer it was shown.** Not a constant.
          sellerSubject: seller,
          platformFeeBps: 250,
          royaltyBps: 500,
          status: 'draft',
          escrowed: false,
        },
      })
    }) as typeof globalThis.fetch,
  }
  return self
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * **`buildUpstreams`, not a hand-rolled client.** See the header: this is what makes the file a test
 * of THIS SERVICE'S wiring rather than of `@cloudsforge/auth`.
 */
function upstreamsFor(w: World, credential: string | null, staticToken: string | null) {
  const env: UpstreamEnv = {
    identityUrl: IDENTITY,
    identityCredential: credential,
    serviceCredential: staticToken,
    studioUrl: STUDIO,
    ledgerUrl: LEDGER,
    marketUrl: MARKET,
    communityUrl: COMMUNITY,
  }
  return buildUpstreams(env, { fetch: w.fetch })
}

const callsTo = (w: World, peer: Peer): Call[] => w.calls.filter((call) => call.peer === peer)
const count401 = (w: World): number => w.calls.filter((call) => call.status === 401).length

/** A Kiln firing's first and authenticating step. */
const fire = (upstreams: ReturnType<typeof upstreamsFor>, objectId: string) => {
  assert.ok(upstreams.studio, 'the Kiln upstream was not built')
  return upstreams.studio.createKit({
    objectId,
    authorSubject: AUTHOR,
    description: 'a lantern of hammered brass',
  })
}

/** An EMBER grant out of `engagement:tessera`. The platform's own act, on its own credential. */
const grant = (upstreams: ReturnType<typeof upstreamsFor>, key: string) => {
  assert.ok(upstreams.ledger, 'the ledger upstream was not built')
  return grantFromEngagement(upstreams.ledger, {
    beneficiary: AUTHOR,
    amountWei: 1_000n,
    kind: 'first_object',
    idempotencyKey: `tessera:grant:${key}`,
    correlationId: '22222222-2222-4222-8222-222222222222',
  })
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CASES
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('the credential is EXCHANGED, and the raw cfsc_ credential never reaches studio or the ledger', async () => {
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)

  assert.equal(upstreams.mode, 'exchanged', 'buildUpstreams did not choose the credential')
  assert.equal(w.exchanges, 0, 'the provider exchanged before anything needed a token')

  const kit = await fire(upstreams, 'object-1')
  const entry = await grant(upstreams, 'object-1')

  assert.equal(kit.brandKitId, 'kit-1')
  assert.equal(entry.id, 'entry-1')
  // ONE exchange for TWO peers: one provider serves both, which is the whole reason `upstreams.ts`
  // builds a single one rather than one per client.
  assert.equal(w.exchanges, 1, 'the credential was exchanged once per client')
  assert.deepEqual(w.calls.map((call) => [call.peer, call.status]), [
    ['studio', 201],
    ['ledger', 201],
  ])

  // ── THE CREDENTIAL IS NOT A BEARER ──────────────────────────────────────────────────────────
  // `assertServiceCredential` refuses a JWT in the credential variable; this is the same rule from
  // the other side. A `cfsc_` string presented to studio would 401 for ever, and — worse — would put
  // a long-lived, revocable secret into every access log between here and there.
  for (const call of w.calls) {
    assert.notEqual(call.token, CREDENTIAL, `the CREDENTIAL was presented as a bearer to ${call.peer}`)
    assert.ok(call.token?.startsWith('ey'), `what was presented to ${call.peer} is not a JWT`)
  }
  // Both peers saw the SAME token, which is what "one provider" means on the wire.
  assert.equal(w.calls[0]?.token, w.calls[1]?.token)
})

test('THE PROPERTY: eleven minutes on, the Kiln still fires and the treasury still pays — and it costs no 401', async () => {
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)

  await fire(upstreams, 'object-1')
  const bootToken = w.calls[0]?.token
  assert.ok(bootToken)
  assert.equal(w.exchanges, 1)

  // ── ELEVEN MINUTES. The token this process minted at boot is now dead. ───────────────────────
  clockAt(11 * 60 * 1_000)

  // Proved against a REAL `Verifier` and jose's own arithmetic rather than asserted. If this line
  // ever stops throwing, the rest of this test is meaningless and it should fail here.
  await assert.rejects(
    (async () => {
      const response = await w.fetch(`${LEDGER}/entries`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bootToken}` },
      })
      if (!response.ok) throw new Error(`the ledger refused the boot token: ${response.status}`)
    })(),
    /the ledger refused the boot token: 401/,
    'the boot token outlived 600 seconds; the cliff is not being modelled',
  )

  const before401s = count401(w)
  const beforeCalls = w.calls.length

  // The firing a player pays for eleven minutes after a deploy, and the EMBER it earns them. Under
  // the old seam this is where the Kiln goes cold for ever with `/livez` still answering 200.
  await fire(upstreams, 'object-2')
  const entry = await grant(upstreams, 'object-2')

  const after = w.calls.slice(beforeCalls)
  assert.deepEqual(
    after.map((call) => [call.peer, call.status]),
    [
      ['studio', 201],
      ['ledger', 201],
    ],
    'the post-expiry firing or grant was refused',
  )
  assert.equal(entry.id, 'entry-1')
  assert.notEqual(after[0]?.token, bootToken, 'the DEAD boot token was presented again')
  assert.equal(w.exchanges, 2, 'the provider did not re-mint on schedule')

  // ── THE ASSERTION THAT STOPS THIS BEING GREEN FOR THE WRONG REASON ──────────────────────────
  // `authorizedFetch` would have rescued a totally broken schedule with one 401 + re-mint + replay,
  // and the firing would still have succeeded. Zero 401s means the token was refreshed BEFORE it was
  // presented, which is the guarantee. The replay path is the backstop, not the mechanism.
  assert.equal(
    count401(w),
    before401s,
    'the post-expiry call cost a 401 — the refresh SCHEDULE is broken and the replay path hid it',
  )
})

test('BASELINE: the seam this replaced leaves the Kiln cold from minute ten', async () => {
  clockAt(0)
  const w = await world()
  // `identityCredential: null`, `serviceCredential: <a real 600s JWT>` — i.e. exactly what
  // `token: async () => env.serviceCredential ?? ''` did, and exactly what the estate runs today.
  //
  // Constructed here rather than through `loadEnv`, deliberately: `optionalCredential` now refuses a
  // JWT in that variable BY NAME, which is the boot-time half of this fix. This test is about the
  // RUNTIME half, so it models the process that already booted with one.
  const upstreams = upstreamsFor(w, null, w.staticToken)
  assert.equal(upstreams.mode, 'static', 'the baseline is not modelling the pre-minted token')

  const kit = await fire(upstreams, 'object-1')
  assert.equal(kit.brandKitId, 'kit-1', 'the baseline failed at minute zero')
  assert.equal(w.calls[0]?.token, w.staticToken, 'the baseline is not presenting the static token')

  // ── ELEVEN MINUTES. **This is the twenty-six live hours, reproduced.** ───────────────────────
  clockAt(11 * 60 * 1_000)

  await assert.rejects(
    fire(upstreams, 'object-2'),
    /401/,
    'the pre-minted token survived its own lifetime; the baseline is not modelling the defect',
  )
  await assert.rejects(grant(upstreams, 'object-2'), /401|unauthenticated/)

  assert.deepEqual(w.calls.slice(1).map((call) => call.status), [401, 401])
  assert.equal(w.exchanges, 0, 'the baseline exchanged something; it is not the old seam')
})

test('THE PRECEDENCE: with BOTH set, the credential wins and the dead token is never presented', async () => {
  // **This is the state the estate will actually be in**: `TESSERA_SERVICE_CREDENTIAL` is set today
  // and stays set while `TESSERA_IDENTITY_CREDENTIAL` is added, because a rolling deploy cannot
  // change both in one instant. If the static token won, the deploy would look correct, the boot log
  // would say `exchanged`, and the cliff would still be there. No other case in this file can see
  // that, because each sets exactly one of the two.
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, w.staticToken)
  assert.equal(upstreams.mode, 'exchanged', 'the pre-minted token beat the credential')

  await fire(upstreams, 'object-1')
  assert.equal(w.exchanges, 1, 'the credential was not exchanged; the static token was used instead')
  assert.notEqual(w.calls[0]?.token, w.staticToken, 'the un-renewable token was presented')

  // Eleven minutes on, the static token is dead. If it had won at minute zero this would 401.
  clockAt(11 * 60 * 1_000)
  const entry = await grant(upstreams, 'object-1')
  assert.equal(entry.id, 'entry-1')
  assert.equal(w.exchanges, 2)
  assert.equal(count401(w), 0)
})

test('THE BACKSTOP: a bearer this process believes is fresh, refused anyway, is re-minted and replayed once', async () => {
  // The case the SCHEDULE cannot cover: the refresh point is computed from this process's clock and
  // `expiresIn`, studio decides from `exp` and ITS clock, and nothing makes those agree. A credential
  // revoked mid-flight looks identical. Without `authorizedFetch` reaching the clients — which on
  // this service means constructing the `HttpClient` in `upstreams.ts` rather than letting
  // `createStudioClient` build its own — the firing would fail outright, because `POST
  // /v1/brand-kits` carries no idempotency key and `HttpClient` attempts it exactly once.
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)

  w.refuseNextBearer = true
  const kit = await fire(upstreams, 'object-1')

  assert.deepEqual(
    w.calls.map((call) => call.status),
    [401, 201],
    'the 401 was not replayed — `authorizedFetch` is not wired into the clients',
  )
  assert.notEqual(w.calls[1]?.token, w.calls[0]?.token, 'the REJECTED token was replayed unchanged')
  assert.equal(w.exchanges, 2, 'the rejected token was not discarded and re-minted')
  assert.equal(kit.brandKitId, 'kit-1')
})

test('no credential at all sends NOTHING, rather than `Authorization: Bearer ` with an empty token', async () => {
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, null, null)

  assert.equal(upstreams.mode, 'none')
  // Absent is a SUPPORTED mode and stays one: the Kiln and the ledger are simply not built, the
  // routes answer 503 `kiln_unconfigured`, and every other route in the world serves. CI's
  // `smoke-env` runs in exactly this configuration on purpose.
  assert.equal(upstreams.studio, undefined)
  assert.equal(upstreams.ledger, undefined)
  // BOTH, OR NEITHER: a market configured without a ledger creates a dead draft on every attempt.
  assert.equal(upstreams.market, undefined, 'the market seam was built without a ledger behind it')
  // Community holds no credential, so it is built regardless — which is the asymmetry, stated.
  assert.notEqual(upstreams.community, undefined)

  assert.deepEqual(w.calls, [], 'an unauthenticated request was sent')
  assert.equal(w.exchanges, 0)
})

test('the MARKET client relays the SELLER’s bearer and never this service’s token', async () => {
  // The asymmetry is the substance of the listings feature, and a refactor that moves client
  // construction into one module is exactly where it would be lost. `market/src/server.ts` reads
  // the seller off the principal (`subjectOf`) and has no on-behalf-of lane, and
  // `market/src/orders.ts` credits sale proceeds to that same subject — so a listing created
  // with this service's token pays the platform and the creator nothing, silently, with a valid
  // listing, a settled sale and a correct trial balance.
  clockAt(0)
  const w = await world()
  const upstreams = upstreamsFor(w, CREDENTIAL, null)
  assert.ok(upstreams.market)

  // Derived from one checksum through `itemasset.ts` rather than written twice: the thing market
  // lists and the thing the ledger reserves cannot come apart, and a literal pair here would be the
  // two spellings that file exists to prevent.
  const checksum = `sha256:${'a'.repeat(64)}`
  const listing = await upstreams.market.createListing({
    itemUrn: objectUrn(checksum),
    itemAssetCode: objectAssetCode(checksum),
    priceWei: 250_000n,
    royaltyBps: 500,
    sellerToken: w.sellerToken,
    idempotencyKey: 'tessera:listing:object-1',
    correlationId: '33333333-3333-4333-8333-333333333333',
  })

  // **Market's own answer, derived from the bearer it was shown.** `service:tessera` here is the
  // silent theft; `user:<creator>` is the feature working.
  assert.equal(listing.sellerSubject, AUTHOR)
  assert.notEqual(listing.sellerSubject, 'service:tessera')

  const seen = callsTo(w, 'market')
  assert.deepEqual(seen.map((call) => call.status), [201])
  assert.equal(seen[0]?.token, w.sellerToken, 'market was shown something other than the seller’s bearer')

  // **Zero exchanges.** Not merely "the service token was not presented": this service did not mint
  // one at all for a market call, which is what says the market client holds no credential rather
  // than holding one it happened not to use.
  assert.equal(w.exchanges, 0, 'a market call minted this service a token')
})
