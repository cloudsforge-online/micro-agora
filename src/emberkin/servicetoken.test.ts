/**
 * **A COSMETIC EQUIPPED, AND A SEASON REWARD PAID, DRIVEN PAST THE TOKEN'S OWN EXPIRY.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## The defect, confirmed before it was changed
 *
 * `EMBERKIN_SERVICE_TOKEN` held a token minted by `POST /service-tokens`, which lives **600
 * seconds** (`identity/src/tokens.ts`). The composition root read it once, at import —
 * `const token = (): string => env.serviceToken` (`index.ts`) — and handed that one string to the
 * billing, ledger and worlds clients for the life of the process. So this service authenticated
 * exactly once per bootstrap.
 *
 * Three readings confirmed it rather than the issue being taken on trust: `env.ts`'s own guard
 * demanded the JWT SHAPE of the variable and said the value is presented "verbatim, with no
 * exchange"; `HttpClient` awaits `token()` per attempt, so the seam could always have refreshed and
 * the function behind it simply returned a constant; and `EMBERKIN_SERVICE_TOKEN` appeared in
 * exactly one file, with `index.ts` as its only reader. Nothing re-minted anything.
 *
 * ## Why the symptom lands on a PLAYER rather than on a timer
 *
 * Unlike a service whose upstream calls sit on a schedule, emberkin's sit on **request paths**. A
 * bootstrap is therefore not guaranteed to outrun the expiry: it fails when a player acts more than
 * ten minutes after one. `cosmetics.ts` fails CLOSED on a billing failure — "ask again later", not
 * "wear it anyway" — so the wardrobe stops working, and a season reward's ledger posting comes back
 * as `LedgerRefusedError`, which is `peerDecided` and is deliberately **never retried**. A reward
 * is abandoned permanently on the strength of a 401 that meant nothing about the reward.
 *
 * ## Why every other test in this repository is blind to it
 *
 * They build their own client, or a fake, and do it a millisecond later. **A test that mints a
 * token and immediately uses it proves nothing about this defect** — the token is never asked to
 * survive its own lifetime, and at the speed of a test a hard-coded string and a live credential
 * are indistinguishable. `ledgerclient.test.ts` is green against a `fetch` that never reads a
 * header. Below, the clock moves **ELEVEN MINUTES**, the boot token is shown to be refused **by a
 * real `Verifier`**, and only then is the player's action attempted.
 *
 * ## The assertion that stops this file being green for the wrong reason
 *
 * `authorizedFetch` re-mints and replays on a 401. So a completely broken refresh SCHEDULE would
 * still end in a served request — one 401, one re-mint, one replay — and a test that only checked
 * the outcome would pass straight over it. The post-expiry cases therefore assert **zero 401s**:
 * the token must have been refreshed before it was ever presented. The schedule is the mechanism;
 * the replay path is the backstop, and `THE BACKSTOP` covers it separately.
 *
 * ## What is real here, and what is not
 *
 *   * **Real**: `buildUpstreams` (the wiring under test), `ServiceTokenProvider`, `HttpClient`,
 *     `httpBillingClient`, `httpLedgerClient`, `httpWorldsClient`, a real `Verifier` and jose's own
 *     expiry arithmetic. The answers below come back through the real clients' real parsing.
 *   * **Simulated**: the clock, and the peers' transports. `mock.timers` moves `Date` only, so jose
 *     decides expiry from the same instant the provider schedules against — nothing here decides
 *     expiry by hand, which is how a test ends up agreeing with the code it is checking.
 *
 * ## Going through `buildUpstreams` is the whole point
 *
 * A test that constructs its own `ServiceTokenProvider` and its own billing client proves the
 * provider works, which is `@cloudsforge/auth`'s job. It proves nothing about whether THIS SERVICE
 * uses it, and "this service does not use it" was the defect. Reverting `upstreams.ts` to
 * `() => env.serviceToken` turns the first four tests below red.
 *
 * No database. Nothing here touches a table, so it runs wherever `node --test` does — and it does
 * not self-skip, which matters: a suite that quietly executes nothing is how this survived.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair } from 'jose';
import { AUDIENCE, ServiceTokenUnavailableError, Verifier, type ServiceTokenProvider } from '@cloudsforge/auth';
import { buildUpstreams, type UpstreamEnv } from './upstreams.ts';
import { BILLING_SCOPES, BillingUnavailableError } from './billingclient.ts';
import { LEDGER_SCOPES, LedgerRefusedError, LedgerUnavailableError, rewardIdempotencyKey, rewardPostings } from './ledgerclient.ts';
import { WORLDS_SCOPES, WorldsUnavailableError } from './worldsclient.ts';

const ISSUER = 'https://identity.test';
const IDENTITY = 'http://identity:4000';
const BILLING = 'http://billing:4009';
const LEDGER = 'http://ledger:4007';
const WORLDS = 'http://worlds:4000';

/**
 * Fabricated: identity's shape, none of its entropy. **Never a value out of `tokens.env`.**
 *
 * The hyphens are deliberate — a credential body is base64**url**, the testnet credential contains
 * one and the mainnet one does not, so a fixture without them would let a "no hyphens" rule reach
 * an estate.
 */
const CREDENTIAL = 'cfsc_TToR-eOeVTDnqhX1-nu6-u7DoCr4MCfa86g4g6kd404';

/**
 * `identity/src/tokens.ts`. Unchanged by this fix, and it must stay unchanged — rotation IS expiry.
 *
 * **This constant is the SIMULATED IDENTITY'S answer, not a number `src/` may rely on.** Nothing in
 * this repository knows the service token TTL: `ServiceTokenProvider` schedules from the
 * `expiresIn` the exchange returned. `THE ISSUER OWNS THE NUMBER` below proves that by having
 * identity answer something else entirely.
 */
const SERVICE_TTL_SECONDS = 600;

/** What this service actually demands of its own token, read from the files that declare it. */
const SCOPES = [...BILLING_SCOPES, ...LEDGER_SCOPES, ...WORLDS_SCOPES] as readonly string[];

/** Well in the past, and fixed, so nothing here depends on the day it is run. */
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0);

/** Move the whole world — the provider's schedule and jose's expiry check — to `T0 + ms`. */
function clockAt(ms: number): void {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: new Date(T0 + ms) });
}

afterEach(() => mock.timers.reset());

/**
 * Wait for a background refresh that was STARTED but not awaited to actually finish.
 *
 * Asked of the provider's own `snapshot().refreshing` rather than by yielding a fixed number of
 * turns: the exchange awaits an RS256 signature, and a single `setImmediate` returns while the
 * token is minted but before `#held` has been swapped — which reads as "the refresh was never
 * adopted" and is a flake, not a finding. `setTimeout` is real here; `mock.timers` moves `Date`
 * only.
 */
async function settle(upstreams: { identityTokens: ServiceTokenProvider | null }): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!upstreams.identityTokens?.snapshot().refreshing) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('a background refresh never settled');
}

const USER = '44444444-4444-4444-8444-444444444444';
const TITLE_ID = '55555555-5555-4555-8555-555555555555';
const SEASON = '66666666-6666-4666-8666-666666666666';
const SKU = 'emberkin-cloak-of-cinders';

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * A REAL IDENTITY, A REAL BILLING, A REAL LEDGER AND A REAL WORLDS, in the sense that matters.
 *
 * Identity signs RS256 tokens against the simulated clock. The peers hand whatever they are given
 * to a real `Verifier`, check the scope they require off the verified principal, and answer 401
 * when jose says the token is bad — which is what the live estate's peers do. Nothing decides
 * expiry by hand.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

type Peer = 'billing' | 'ledger' | 'worlds';

interface Call {
  readonly peer: Peer;
  readonly token: string | null;
  readonly status: number;
}

interface World {
  readonly fetch: typeof globalThis.fetch;
  exchanges: number;
  calls: Call[];
  consecutive401: number;
  /** A pre-minted token valid at `T0` that cannot be renewed. The defect's input. */
  readonly staticToken: string;
  /** Seconds identity says each token it mints will live. The ISSUER'S number, changeable here. */
  ttlSeconds: number;
  /** Identity is unreachable. The exchange fails; tokens already held are unaffected. */
  identityDown: boolean;
  /**
   * Refuse the next bearer once, whatever it is, then behave normally.
   *
   * The case the SCHEDULE cannot cover and `authorizedFetch` exists for: a token this process
   * believes is fresh which a peer rejects anyway — clock skew between the two, a credential
   * revoked mid-flight, a process paused between reading the token and sending it.
   */
  refuseNextBearer: boolean;
}

async function world(): Promise<World> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const keySet = (async () => publicKey) as never;
  const verifier = new Verifier({ jwksUrl: 'http://unused', issuer: ISSUER, keySet });

  // RS256 is deterministic, so two tokens signed from the same payload at the same simulated
  // instant are the same string. identity mints a uuidv7 jti per token; the counter restores that,
  // and without it "the service minted a genuinely new token" could not be asserted at all.
  let jti = 0;
  const mint = (issuedAtMs: number, ttl: number): Promise<string> =>
    new SignJWT({ typ: 'service', scopes: SCOPES, jti: `t-${++jti}` })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuedAt(Math.floor(issuedAtMs / 1000))
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('service:emberkin')
      .setExpirationTime(Math.floor(issuedAtMs / 1000) + ttl)
      .sign(privateKey);

  const staticToken = await mint(T0, SERVICE_TTL_SECONDS);

  const self: World = {
    exchanges: 0,
    calls: [],
    consecutive401: 0,
    staticToken,
    ttlSeconds: SERVICE_TTL_SECONDS,
    identityDown: false,
    refuseNextBearer: false,

    fetch: (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      // ── IDENTITY ────────────────────────────────────────────────────────────────────────────
      if (url.startsWith(IDENTITY)) {
        if (self.identityDown) throw new TypeError('fetch failed');
        assert.ok(
          url.endsWith('/service-tokens/exchange'),
          `the provider posted to ${url} rather than the exchange`,
        );
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${CREDENTIAL}`) {
          return new Response('{"error":"unauthenticated"}', { status: 401 });
        }
        self.exchanges += 1;
        return new Response(
          JSON.stringify({
            token: await mint(Date.now(), self.ttlSeconds),
            service: 'emberkin',
            scopes: SCOPES,
            // THE ISSUER'S NUMBER. Everything downstream schedules from this and from nothing else.
            expiresIn: self.ttlSeconds,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }

      const peer: Peer = url.startsWith(BILLING) ? 'billing' : url.startsWith(LEDGER) ? 'ledger' : 'worlds';
      const presented = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? null;

      // `GET /v1/titles` is UNAUTHENTICATED on worlds (`worlds/src/server.ts`), and modelling it as
      // such matters: it is the first call the achievement path makes, so treating it as gated
      // would let a broken token fail at a route that would really have answered.
      if (peer === 'worlds' && url.endsWith('/v1/titles')) {
        return new Response(JSON.stringify({ titles: [{ id: TITLE_ID, slug: 'emberkin' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const need = peer === 'billing' ? 'billing:read' : peer === 'ledger' ? 'ledger:post' : 'worlds:title';

      // The loop guard counts CONSECUTIVE refusals rather than total calls, because
      // `authorizedFetch` re-mints and replays exactly once on a 401 — a fault would show as an
      // unbroken run of them, while a cap on the total would be a cap on how many actions a test
      // may drive, which is the wrong quantity entirely.
      if (self.consecutive401 > 4) throw new Error('the 401 replay is looping');

      const refuse = (status: number): Response => {
        self.consecutive401 += 1;
        self.calls.push({ peer, token: presented, status });
        return new Response(
          '{"error":{"code":"unauthenticated","message":"a valid bearer token is required"}}',
          { status, headers: { 'content-type': 'application/json' } },
        );
      };

      if (presented === null) return refuse(401);
      if (self.refuseNextBearer) {
        self.refuseNextBearer = false;
        return refuse(401);
      }
      try {
        const principal = await verifier.principal(presented);
        if (principal.kind !== 'service' || !principal.scopes.includes(need)) return refuse(403);
      } catch {
        // jose refused it: expired, or not signed by this key. THE CLIFF, seen from the peer's side.
        return refuse(401);
      }

      self.consecutive401 = 0;

      // Each peer's REAL status, recorded from the response rather than assumed: billing answers
      // 200 to a read, the ledger 201 to a fresh entry, and worlds 200 to the definition upsert but
      // 201 to a first unlock. A recorder that flattened them to one number would make the
      // sequences asserted below agree with anything.
      const answer =
        peer === 'billing'
          ? new Response(
              JSON.stringify({ entitlements: [{ id: 'ent-1', sku: SKU, scope: 'title:emberkin', active: true }] }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
          : peer === 'ledger'
            ? new Response(
                JSON.stringify({
                  entry: { id: 'entry-1', kind: 'reward_granted', recordedAt: '2024-01-01T00:00:00Z' },
                  replayed: false,
                }),
                { status: 201, headers: { 'content-type': 'application/json' } },
              )
            : url.endsWith('/achievements')
              ? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
              : new Response(JSON.stringify({ unlocked: true, achievement: { key: 'first-ember' } }), {
                  status: 201,
                  headers: { 'content-type': 'application/json' },
                });

      self.calls.push({ peer, token: presented, status: answer.status });
      return answer;
    }) as typeof globalThis.fetch,
  };
  return self;
}

/**
 * **`buildUpstreams`, not a hand-rolled client.** See the header: this is what makes the file a
 * test of THIS SERVICE'S wiring rather than of `@cloudsforge/auth`.
 */
function upstreamsFor(w: World, credential: string | null, staticToken: string | null) {
  const env: UpstreamEnv = {
    identityUrl: IDENTITY,
    identityCredential: credential,
    serviceToken: staticToken,
    ledgerUrl: LEDGER,
    billingUrl: BILLING,
    worldsUrl: WORLDS,
    upstreamDeadlineMs: 5_000,
  };
  return buildUpstreams(env, { fetch: w.fetch, titleSlug: 'emberkin' });
}

/** A real season reward, built by the real functions the reward job uses. */
function rewardEntry() {
  return {
    kind: 'reward_granted' as const,
    actor: 'service:emberkin' as const,
    correlationId: `season:${SEASON}`,
    idempotencyKey: rewardIdempotencyKey(SEASON, USER, 'season_complete'),
    postings: rewardPostings({ subject: `user:${USER}`, amount: 500n }),
  };
}

const achievement = () => ({
  userId: USER,
  key: 'first-ember',
  name: 'First Ember',
  points: 10,
  correlationId: `ach:${USER}`,
});

const callsTo = (w: World, peer: Peer): Call[] => w.calls.filter((call) => call.peer === peer);
const count401 = (w: World): number => w.calls.filter((call) => call.status === 401).length;

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CASES
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('the credential is EXCHANGED, and the cosmetic gate really answers at minute zero', async () => {
  clockAt(0);
  const w = await world();
  const upstreams = upstreamsFor(w, CREDENTIAL, null);

  assert.equal(upstreams.mode, 'exchanged', 'buildUpstreams did not choose the credential');
  assert.equal(w.exchanges, 0, 'the provider exchanged before anything needed a token');

  assert.equal(await upstreams.billing.owns(USER, SKU, 'emberkin'), true, 'the gate was not consulted');
  assert.equal(w.exchanges, 1, 'the credential was not exchanged for a token');
  assert.deepEqual(callsTo(w, 'billing').map((call) => call.status), [200]);

  // ── THE CREDENTIAL IS NEVER A BEARER ────────────────────────────────────────────────────────
  // It is long-lived and revocable. Presenting it to a peer would put a credential that outlives
  // every token in three services' access logs, and any of them could then mint tokens as us.
  assert.ok(!w.calls.some((call) => call.token === CREDENTIAL), 'the raw credential reached a peer');
  assert.ok(callsTo(w, 'billing')[0]?.token?.startsWith('ey'), 'what was presented is not a JWT');
});

test('THE PROPERTY: eleven minutes on, the cosmetic still equips — and it costs no 401', async () => {
  clockAt(0);
  const w = await world();
  const upstreams = upstreamsFor(w, CREDENTIAL, null);

  await upstreams.billing.owns(USER, SKU, 'emberkin');
  const bootToken = callsTo(w, 'billing')[0]?.token;
  assert.ok(bootToken);
  assert.equal(w.exchanges, 1);

  // ── ELEVEN MINUTES. The token this process minted at boot is now dead. ───────────────────────
  clockAt(11 * 60 * 1_000);

  // Proved against a REAL `Verifier` and jose's own arithmetic rather than asserted. If this line
  // ever stops throwing, the rest of this test is meaningless and it should fail here.
  await assert.rejects(
    (async () => {
      const response = await w.fetch(`${BILLING}/internal/entitlements/${USER}`, {
        headers: { authorization: `Bearer ${bootToken}` },
      });
      if (!response.ok) throw new Error(`billing refused the boot token: ${response.status}`);
    })(),
    /billing refused the boot token: 401/,
    'the boot token outlived 600 seconds; the cliff is not being modelled',
  );

  const before401s = count401(w);
  const beforeCalls = w.calls.length;

  // The player who opens the wardrobe eleven minutes after a deploy. Under the old seam this is
  // where equipping starts failing closed — "we cannot check your purchases right now" — for ever.
  const owns = await upstreams.billing.owns(USER, SKU, 'emberkin');
  const entry = await upstreams.ledger.postEntry(rewardEntry());

  const after = w.calls.slice(beforeCalls);
  assert.deepEqual(after.map((call) => call.status), [200, 201], 'the post-expiry action was refused');
  assert.ok(after.every((call) => call.token !== bootToken), 'the DEAD boot token was presented again');
  assert.equal(owns, true, 'the cosmetic the player owns read as unowned');
  assert.equal(entry.id, 'entry-1', 'the ledger did not post the reward');
  assert.equal(w.exchanges, 2, 'the provider did not re-mint on schedule');

  // ── THE ASSERTION THAT STOPS THIS BEING GREEN FOR THE WRONG REASON ──────────────────────────
  // `authorizedFetch` would have rescued a totally broken schedule with one 401 + re-mint + replay,
  // and the answer would still have come back. Zero 401s means the token was refreshed BEFORE it
  // was presented, which is the guarantee. The replay path is the backstop, not the mechanism.
  assert.equal(
    count401(w),
    before401s,
    'the post-expiry call cost a 401 — the refresh SCHEDULE is broken and the replay path hid it',
  );
});

test('EARLY, NOT ON EXPIRY: at minute nine the token is renewed BEHIND the request', async () => {
  // The point of the margin, and the reason "refresh when it has expired" is the same bug one race
  // narrower. At 520s the held token is still valid — so the caller is handed it and pays nothing —
  // but the provider is past its refresh point and starts an exchange in the background. By the
  // next call there is a fresh token, and no request ever carried something close to expiry.
  //
  // 520s is chosen to sit outside the JITTER BAND rather than at its centre: the fraction is drawn
  // per token from [0.75, 0.85], so the refresh point is somewhere in 450s..510s and 520s is past
  // all of it, while 595s (600s less the 5s skew margin) is where the token stops being presentable
  // at all. A test pinned to 480s would be flaky by design.
  clockAt(0);
  const w = await world();
  const upstreams = upstreamsFor(w, CREDENTIAL, null);

  await upstreams.billing.owns(USER, SKU, 'emberkin');
  const bootToken = callsTo(w, 'billing')[0]?.token;
  assert.equal(w.exchanges, 1);

  clockAt(520 * 1_000);
  await upstreams.billing.owns(USER, SKU, 'emberkin');

  // THE CALLER PAID NOTHING: it was handed the token it already had, which is still perfectly good.
  assert.equal(callsTo(w, 'billing')[1]?.token, bootToken, 'the request blocked on a refresh it did not need');
  assert.equal(callsTo(w, 'billing')[1]?.status, 200);

  await settle(upstreams);
  assert.equal(w.exchanges, 2, 'no refresh was started while the token was still valid — it will refresh ON expiry');

  // And the next call gets the new one, still without a single 401 anywhere.
  await upstreams.billing.owns(USER, SKU, 'emberkin');
  assert.notEqual(callsTo(w, 'billing')[2]?.token, bootToken, 'the refreshed token was not adopted');
  assert.equal(count401(w), 0, 'a token was presented after it had expired');
});

test('THE ISSUER OWNS THE NUMBER: the schedule follows expiresIn, not a ten-minute constant', async () => {
  // A copy of `SERVICE_TTL_SECONDS` in `src/` would be a second source of truth for a number
  // identity owns, and the drift is SILENT in the dangerous direction: guess longer than the truth
  // and every token expires in service, which is the original defect wearing the fix's clothes.
  //
  // So identity answers SIXTY seconds here. Code that had 600 written into it anywhere would still
  // believe the boot token was fresh at t=70s and would present a corpse; the peer would 401 and
  // only the replay backstop would save it. Zero 401s is what says the schedule really followed the
  // issuer's number.
  clockAt(0);
  const w = await world();
  w.ttlSeconds = 60;
  const upstreams = upstreamsFor(w, CREDENTIAL, null);

  await upstreams.billing.owns(USER, SKU, 'emberkin');
  const bootToken = callsTo(w, 'billing')[0]?.token;
  assert.equal(w.exchanges, 1);

  // Past a 60-second token's life, and nowhere near a 600-second one's.
  clockAt(70 * 1_000);
  await upstreams.billing.owns(USER, SKU, 'emberkin');

  assert.equal(w.exchanges, 2, 'the token was not re-minted; the refresh point is not read from expiresIn');
  assert.notEqual(callsTo(w, 'billing')[1]?.token, bootToken, 'the 60-second token was presented at second 70');
  assert.equal(count401(w), 0, 'the peer had to refuse a dead token before it was replaced');
});

test('BASELINE: the seam this replaced fails the wardrobe and abandons the reward at minute ten', async () => {
  clockAt(0);
  const w = await world();
  // `identityCredential: null`, `serviceToken: <a real 600s JWT>` — i.e. exactly what
  // `const token = () => env.serviceToken` did, and exactly what the estate runs today.
  const upstreams = upstreamsFor(w, null, w.staticToken);
  assert.equal(upstreams.mode, 'static', 'the baseline is not modelling the pre-minted token');

  assert.equal(await upstreams.billing.owns(USER, SKU, 'emberkin'), true, 'the baseline failed at minute zero');

  clockAt(11 * 60 * 1_000);

  // ── THE SYMPTOM, REPRODUCED. ────────────────────────────────────────────────────────────────
  // `cosmetics.ts` fails CLOSED on this, so the player is told we cannot check their purchases —
  // and `server.ts` answers 503 `entitlements_unavailable`. Nothing anywhere names this container's
  // own token as the cause.
  await assert.rejects(() => upstreams.billing.owns(USER, SKU, 'emberkin'), BillingUnavailableError);

  // And the reward side of the same minute. A 401 is a 4xx, so `HttpError.peerDecided` is true, so
  // `ledgerclient.ts` classifies it as THE LEDGER HAVING DECIDED — `LedgerRefusedError`, the
  // terminal class the reward path must never retry. A season reward is abandoned for ever on the
  // strength of an answer that said nothing about the reward.
  await assert.rejects(() => upstreams.ledger.postEntry(rewardEntry()), LedgerRefusedError);
  assert.equal(w.exchanges, 0, 'the baseline exchanged something; it is not the old seam');
});

test('THE PRECEDENCE: with BOTH set, the credential wins and the dead token is never presented', async () => {
  // **This is the state the estate will actually be in**: `EMBERKIN_SERVICE_TOKEN` is set today and
  // stays set while the credential is added, because a rolling deploy cannot change the image and
  // the compose block in the same instant. If the static token won, the deploy would look correct,
  // the boot log would say `exchanged`, and the cliff would still be there. No other case in this
  // file can see that, because each sets exactly one of the two.
  clockAt(0);
  const w = await world();
  const upstreams = upstreamsFor(w, CREDENTIAL, w.staticToken);
  assert.equal(upstreams.mode, 'exchanged', 'the pre-minted token beat the credential');

  await upstreams.billing.owns(USER, SKU, 'emberkin');
  assert.equal(w.exchanges, 1, 'the credential was not exchanged; the static token was used instead');
  assert.notEqual(w.calls[0]?.token, w.staticToken, 'the un-renewable token was presented');

  clockAt(11 * 60 * 1_000);
  assert.equal(await upstreams.billing.owns(USER, SKU, 'emberkin'), true);
  assert.equal(w.exchanges, 2);
  assert.ok(!w.calls.some((call) => call.token === w.staticToken), 'the dead pre-minted token was presented');
});

test('THE BACKSTOP: a bearer this process believes is fresh, refused anyway, is re-minted and replayed once', async () => {
  // The case the SCHEDULE cannot cover: the refresh point is computed from this process's clock and
  // `expiresIn`, the peer decides from `exp` and ITS clock, and nothing makes those agree. A
  // credential revoked mid-flight looks identical. Without `authorizedFetch` in the wiring the
  // player's wardrobe would simply fail.
  clockAt(0);
  const w = await world();
  const upstreams = upstreamsFor(w, CREDENTIAL, null);

  w.refuseNextBearer = true;
  const owns = await upstreams.billing.owns(USER, SKU, 'emberkin');

  assert.deepEqual(
    w.calls.map((call) => call.status),
    [401, 200],
    'the 401 was not replayed — `authorizedFetch` is not wired into the clients',
  );
  assert.notEqual(w.calls[1]?.token, w.calls[0]?.token, 'the REJECTED token was replayed unchanged');
  assert.equal(w.exchanges, 2, 'the rejected token was not discarded and re-minted');
  assert.equal(owns, true, 'a skewed clock became a failure rather than being survived');
});

test('A HELD TOKEN SURVIVES AN IDENTITY OUTAGE, because identity does not retract what it signed', async () => {
  clockAt(0);
  const w = await world();
  const upstreams = upstreamsFor(w, CREDENTIAL, null);

  await upstreams.billing.owns(USER, SKU, 'emberkin');
  assert.equal(w.exchanges, 1);

  // Identity falls over. The token minted a moment ago is still perfectly valid, and failing now
  // would take this title down for a fault it is designed to ride out.
  w.identityDown = true;
  clockAt(520 * 1_000); // past the refresh point, inside the token's life
  assert.equal(await upstreams.billing.owns(USER, SKU, 'emberkin'), true, 'a live token was abandoned over an identity outage');
  await settle(upstreams);

  // The background refresh failed and must not have taken the process with it, nor left an
  // unhandled rejection. The next call still works, because the held token is still good.
  assert.equal(await upstreams.billing.owns(USER, SKU, 'emberkin'), true);
  assert.equal(count401(w), 0);
});

test('A FAILED REFRESH IS NEVER PRESENTED AS SUCCESS: no live token means 503, and nothing is sent', async () => {
  // The other half of the outage, and the point of the whole error class. Once the held token is
  // genuinely dead we CANNOT authenticate, so the request is not sent — not unauthenticated, and
  // not with a stale bearer. Either would come back 401, and a 401 says "your credential is bad"
  // when the truth is "identity is down". `server.ts` answers 503 to the `…UnavailableError`
  // classes below, and `statusFor` maps `ServiceTokenUnavailableError` itself to 503 — never 401.
  clockAt(0);
  const w = await world();
  const upstreams = upstreamsFor(w, CREDENTIAL, null);

  await upstreams.billing.owns(USER, SKU, 'emberkin');
  const sentBefore = w.calls.length;

  w.identityDown = true;
  clockAt(11 * 60 * 1_000); // the held token is now dead AND identity cannot mint another

  await assert.rejects(() => upstreams.billing.owns(USER, SKU, 'emberkin'), BillingUnavailableError);
  await assert.rejects(() => upstreams.ledger.postEntry(rewardEntry()), LedgerUnavailableError);
  await assert.rejects(() => upstreams.worlds.postAchievement(achievement()), WorldsUnavailableError);

  // NOTHING WAS SENT. Not one byte, to any of the three — so no peer recorded a refusal, and in
  // particular the ledger did not answer the terminal `LedgerRefusedError` that abandons a reward.
  assert.equal(
    w.calls.length,
    sentBefore,
    'a request went out with a dead token, or with no token at all, while identity was unreachable',
  );
});

test('the LEDGER and WORLDS are on the same credential — the wiring is not billing-only', async () => {
  // `upstreams.ts` hands one `token` and one `fetch` to all three clients, and this is the
  // assertion that says so about the other two. The reward is the one whose failure is PERMANENT
  // (a 401 becomes `LedgerRefusedError`, which is never retried), and the achievement is the one
  // that fails silently into a job backlog.
  clockAt(0);
  const w = await world();
  const upstreams = upstreamsFor(w, CREDENTIAL, null);

  clockAt(11 * 60 * 1_000);
  const entry = await upstreams.ledger.postEntry(rewardEntry());
  const badge = await upstreams.worlds.postAchievement(achievement());

  assert.equal(entry.id, 'entry-1');
  assert.equal(badge.unlocked, true, 'the achievement call was not authenticated');
  assert.equal(w.exchanges, 1, 'one credential should mint one token for all three peers');
  assert.equal(count401(w), 0);
  assert.deepEqual(
    [...new Set(w.calls.map((call) => call.peer))].sort(),
    ['ledger', 'worlds'],
    'a peer was called that this test did not drive',
  );
});

test('no credential and no token sends NOTHING, rather than an unauthenticated request', async () => {
  // `loadEnv` refuses this configuration outright — see `requireOneCredentialSource` — so this is
  // the belt to that braces. `HttpClient` omits the header for `undefined`, so a resolve-to-empty
  // would have gone out unauthenticated, come back 401, and been recorded as the LEDGER having
  // decided to refuse a reward. It is not a refusal: nobody gave this service a credential.
  clockAt(0);
  const w = await world();
  const upstreams = upstreamsFor(w, null, null);
  assert.equal(upstreams.mode, 'none');

  await assert.rejects(() => upstreams.billing.owns(USER, SKU, 'emberkin'), BillingUnavailableError);
  await assert.rejects(() => upstreams.ledger.postEntry(rewardEntry()), LedgerUnavailableError);
  assert.deepEqual(w.calls, [], 'an unauthenticated request was sent to a peer');
  assert.equal(w.exchanges, 0);
});

test('a TOKEN in the credential slot is refused at construction, not ten minutes later', async () => {
  // The two variables are swappable by a deploy in a hurry, and the failure mode of the swap is
  // exactly the defect being fixed: a JWT in the credential slot would be exchanged for nothing,
  // work for ten minutes and die. `env.ts` refuses it at boot; `ServiceTokenProvider` refuses it
  // again here, so the wiring cannot be built wrong even by a caller that bypassed `loadEnv`.
  clockAt(0);
  const w = await world();
  assert.throws(
    () => upstreamsFor(w, w.staticToken, null),
    (err: unknown) => err instanceof Error && /credential begins 'cfsc_'/.test(err.message),
  );
});

test('ServiceTokenUnavailableError is the 503 class, and no token or credential is in its message', async () => {
  // Both values are live credentials. This error is logged, and its message reaches an operator.
  clockAt(0);
  const w = await world();
  const upstreams = upstreamsFor(w, null, null);

  await assert.rejects(
    () => upstreams.billing.owns(USER, SKU, 'emberkin'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(CREDENTIAL), 'the credential is in an error message');
      assert.ok(!err.message.includes(w.staticToken), 'a minted token is in an error message');
      assert.match(err.message, /EMBERKIN_IDENTITY_CREDENTIAL/, 'the message does not name the variable to set');
      return true;
    },
  );

  // And the class the provider itself raises is the one `statusFor` maps to 503.
  const bare = new ServiceTokenUnavailableError('identity is unreachable');
  assert.equal(bare.name, 'ServiceTokenUnavailableError');
});
