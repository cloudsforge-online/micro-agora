/**
 * Configuration. `loadEnv` is pure over its source, so every failure path is testable without
 * mutating the process.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * THIS FIXTURE CONTAINS HYPHENS ON PURPOSE, AND THAT IS THE MOST IMPORTANT THING ABOUT IT.
 *
 * A credential body is base64**url**, so `-` and `_` are in its alphabet. Measured on the running
 * estates: the mainnet credential is alphanumeric and the testnet one CONTAINS A HYPHEN. So a
 * "secrets have no hyphens" rule — correct for a generated HMAC key, and what every placeholder
 * this estate wrote would have failed — passes mainnet and kills testnet at boot. One environment
 * healthy, one dead, from a rule that reads as obviously right in review.
 *
 * Keeping a hyphenated credential here means that mistake fails CI instead of failing one estate in
 * production. Do not "tidy" the hyphens out of this value.
 *
 * The literal it replaces was `cfsc_a-long-lived-credential-that-does-not-expire`: the right prefix
 * and the right length, and 3.5 bits per character of entropy — English prose, i.e. a value the
 * guard is specifically there to refuse. A fixture that could not survive the check it is meant to
 * demonstrate documents the absence of one.
 */
const CREDENTIAL = 'cfsc_TToR-eOeVTDnqhX1-nu6-u7DoCr4MCfa86g4g6kd404'

/**
 * The shape the six retired `HUB_*_TOKEN` variables held: a 600-second JWT read once at boot.
 * Fabricated; only the first two segments matter, because the guard refuses on SHAPE and never
 * decodes. micro-org #222.
 */
const JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJodWItYXBpIiwiZXhwIjoxfQ.notasignature'

/**
 * A valid environment, applied to the process before `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. The
 * failure cases below go through `loadEnv`, which is pure over its source and therefore testable
 * without a child process.
 */
const BASE: Record<string, string> = {
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  LEDGER_URL: 'http://127.0.0.1:4002',
  WALLET_URL: 'http://127.0.0.1:4003',
  IDENTITY_URL: 'http://127.0.0.1:4001',
  BILLING_URL: 'http://127.0.0.1:4004',
  ACTIVITY_URL: 'http://127.0.0.1:4005',
  PRICING_URL: 'http://127.0.0.1:4006',
  POLICY_URL: 'http://127.0.0.1:4007',
  NOTIFY_URL: 'http://127.0.0.1:4008',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

const { EnvError, SERVICE, env, loadEnv } = await import('./env.ts')
const { HUB_UPSTREAM_SCOPES } = await import('./upstreams.ts')

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(SERVICE, 'hub-api')
  assert.equal(env.upstreams.ledger, BASE['LEDGER_URL'])
  assert.equal(env.identityCredential, null, 'not in BASE — it is optional by design')
})

test('the defaults are the documented ones', () => {
  const env = loadEnv(BASE, 'host-1')
  assert.equal(env.port, 4000)
  assert.equal(env.dashboardDeadlineMs, 2_500)
  assert.equal(env.upstreamDeadlineMs, 1_500)
  assert.equal(env.circuitThreshold, 5)
  assert.equal(env.instanceId, 'host-1')
  assert.equal(env.poolApi, 'present')
})

test('pool presence is a deploy fact whose only absent value is the word absent', () => {
  // Deliberately not validated against an allowlist. An estate that has never heard of this
  // variable must keep behaving exactly as it did, and a deploy that misspells the value must
  // degrade to the answer that costs a reader nothing rather than refuse to boot a whole BFF.
  assert.equal(loadEnv({ ...BASE, POOL_API_PRESENCE: 'absent' }).poolApi, 'absent')
  // Surrounding whitespace is the reader's, not the operator's: a compose file that quotes the
  // value with a stray space still means what it says.
  assert.equal(loadEnv({ ...BASE, POOL_API_PRESENCE: ' absent ' }).poolApi, 'absent')
  assert.equal(loadEnv({ ...BASE, POOL_API_PRESENCE: 'present' }).poolApi, 'present')
  for (const fumbled of ['', 'ABSENT', 'no', 'false']) {
    assert.equal(loadEnv({ ...BASE, POOL_API_PRESENCE: fumbled }).poolApi, 'present', fumbled)
  }
})

test('a missing variable names itself', () => {
  const { WALLET_URL: _omitted, ...without } = BASE
  assert.throws(() => loadEnv(without), (err: unknown) => {
    assert.ok(err instanceof EnvError)
    assert.match(err.message, /WALLET_URL/)
    return true
  })
})

test('there is one scope set per service-read upstream, and identity is not one of them', () => {
  // This used to assert six token VARIABLES, and then six scope sets. There is now one credential
  // and seven scope sets, which is the same separation held one layer down: identity reads the
  // service off the credential row, so the scope set is a request parameter rather than a second
  // secret. `notify` is the seventh, added when the notifications tile stopped being a constant.
  //
  // Identity is still absent by construction, because `/auth/me` and `/mfa/factors` refuse a
  // service token outright. A scope set for it would be one that cannot be used, and a credential
  // nobody can use is one nobody rotates.
  assert.deepEqual(Object.keys(HUB_UPSTREAM_SCOPES).sort(), [
    'activity',
    'billing',
    'ledger',
    'notify',
    'policy',
    'pricing',
    'wallet',
  ])
  // Each is exactly one scope, and none of them is a wildcard: this is the highest fan-out surface
  // in the estate, so a token here reads one thing or it is too wide.
  for (const [peer, scopes] of Object.entries(HUB_UPSTREAM_SCOPES)) {
    assert.equal(scopes.length, 1, `${peer} asks for more than one scope`)
    assert.doesNotMatch(scopes[0] ?? '', /\*/, `${peer} asks for a wildcard scope`)
  }
})

test('a placeholder credential is refused outright', () => {
  // A default secret in source is not convenient, it is catastrophic: a placeholder that boots is
  // a placeholder that reaches production.
  //
  // THIS ASSERTION USED TO PIN THE STRING "is set to a known placeholder", and that wording was a
  // defence of the deny-list this work replaces. A deny-list of exact strings cannot work — the
  // next placeholder somebody writes is by definition not on it — so a test that demanded the
  // deny-list's own sentence would fail on any fix that stopped using one, including this one.
  //
  // What it asserts now is the property: each of these is refused, the variable is named, and the
  // value is never quoted back into a message a log collector ships. The estate's real defect
  // (`estate-placeholder-token-…`, on 44 containers as micro-org #142) is in the list precisely
  // because no deny-list ever contained it.
  for (const bad of [
    'changeme',
    'estate-placeholder-token-0000000000000000',
    'estate-only-outbox-secret-00000000000000',
  ]) {
    assert.throws(
      () => loadEnv({ ...BASE, HUB_API_IDENTITY_CREDENTIAL: bad }),
      (err: unknown) =>
        err instanceof EnvError &&
        err.message.includes('HUB_API_IDENTITY_CREDENTIAL') &&
        !err.message.includes(bad),
      `${bad} was accepted as a credential`,
    )
  }
})

test('a short credential is refused, and the unit is BYTES rather than keystrokes', () => {
  // HUB_POLICY_TOKEN was the subject here; it is retired, and the credential that replaced all six
  // takes the shared floor for the same reason.
  //
  // THIS ASSERTION USED TO READ `/at least 24 characters/`, AND THAT WORDING WAS THE DEFECT. It
  // pinned a floor counted in KEYSTROKES — the same floor micro-org #142's 40-character placeholder
  // cleared on 44 containers — so any fix that started counting bytes would have failed CI however
  // much better the new rule was. `cfsc_` plus 32 keystrokes of base64url is 24 BYTES, under the
  // floor and past the old check.
  assert.throws(
    () => loadEnv({ ...BASE, HUB_API_IDENTITY_CREDENTIAL: 'cfsc_short' }),
    (err: unknown) =>
      err instanceof EnvError &&
      /HUB_API_IDENTITY_CREDENTIAL/.test(err.message) &&
      /bytes of key material/.test(err.message) &&
      /at least 32/.test(err.message) &&
      !err.message.includes('cfsc_short'),
  )
  // Without the prefix it is not a credential at all, however long it is.
  assert.throws(
    () => loadEnv({ ...BASE, HUB_API_IDENTITY_CREDENTIAL: 'short' }),
    (err: unknown) => err instanceof EnvError && /cfsc_/.test(err.message),
  )
})

test('A TOKEN PASTED INTO THE CREDENTIAL IS REFUSED BY NAME — micro-org #222', () => {
  // The single most likely mistake while this rolls out, and the one the six retired variables
  // make easy: `HUB_LEDGER_TOKEN` and friends held 600-second JWTs, and one of them pasted here
  // would authenticate for ten minutes and then reproduce the exact defect the credential removed.
  //
  // If this ever fails and the fix on offer is a JWT exemption or a weaker assertion, the fix IS
  // the defect. The error names the variable and never quotes the value.
  assert.throws(
    () => loadEnv({ ...BASE, HUB_API_IDENTITY_CREDENTIAL: JWT }),
    (err: unknown) => {
      assert.ok(err instanceof EnvError)
      assert.match(err.message, /HUB_API_IDENTITY_CREDENTIAL/)
      assert.match(err.message, /TOKEN, not a credential|micro-org#197/)
      assert.ok(!err.message.includes(JWT), 'the error quoted the token back')
      return true
    },
  )
})

test('an empty string is an ABSENT credential, not a present one', () => {
  // `HUB_API_IDENTITY_CREDENTIAL: ${HUB_API_IDENTITY_CREDENTIAL:-}` in the estate compose expands
  // to empty when the variable is unset, so this is the literal value a real deployment passes.
  // Reading it as present would construct a provider around nothing; refusing it would turn the
  // erasure gap into an outage on the estate's highest fan-out surface.
  assert.equal(loadEnv({ ...BASE, HUB_API_IDENTITY_CREDENTIAL: '' }).identityCredential, null)
  assert.equal(loadEnv({ ...BASE, HUB_API_IDENTITY_CREDENTIAL: '   ' }).identityCredential, null)
})

test('an upstream deadline above the page budget is refused at boot', () => {
  // Caught here because the failure it produces is silent: the dashboard would appear to work and
  // would simply never degrade, because no tile could reach its own deadline first.
  assert.throws(
    () => loadEnv({ ...BASE, HUB_UPSTREAM_DEADLINE_MS: '5000', HUB_DASHBOARD_DEADLINE_MS: '1000' }),
    /must not exceed/,
  )
})

test('a non-integer deadline is refused rather than coerced', () => {
  assert.throws(() => loadEnv({ ...BASE, HUB_DASHBOARD_DEADLINE_MS: '2.5' }), /whole number/)
  assert.throws(() => loadEnv({ ...BASE, PORT: '70000' }), /between 1 and 65535/)
})

test('no database url is read, and none may be added', () => {
  // The constraint this service is built around, asserted rather than assumed: a connection string
  // here would be the first step towards a table holding a stale copy of somebody else truth.
  const env = loadEnv(BASE)
  assert.ok(!('databaseUrl' in env), 'hub-api owns no state and must read no connection string')
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The one credential that replaced six tokens.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('the identity credential is read, and its absence is a null rather than a throw', () => {
  assert.equal(
    loadEnv({ ...BASE, HUB_API_IDENTITY_CREDENTIAL: CREDENTIAL }).identityCredential,
    CREDENTIAL,
  )
  // Absent must LOAD — the image has to boot without one so the CI smoke test can read /livez —
  // and is caught by the hard `identity-credential` readiness probe instead.
  assert.equal(loadEnv(BASE).identityCredential, null)
})

test('any of the six retired tokens being set is reported rather than obeyed', () => {
  assert.equal(loadEnv(BASE).legacyServiceTokenPresent, false)
  for (const name of [
    'HUB_LEDGER_TOKEN',
    'HUB_WALLET_TOKEN',
    'HUB_BILLING_TOKEN',
    'HUB_ACTIVITY_TOKEN',
    'HUB_PRICING_TOKEN',
    'HUB_POLICY_TOKEN',
  ]) {
    // Deliberately a JWT: it is what these six actually held, and the point of the assertion is
    // that a RETIRED variable confers nothing — not even when its value is well-formed. Nothing
    // asserts it, because nothing reads it beyond `.length > 0`.
    const env = loadEnv({ ...BASE, [name]: JWT })
    assert.equal(env.legacyServiceTokenPresent, true, `${name} was not noticed`)
    // And it confers nothing: setting it must not make the service look configured.
    assert.equal(env.identityCredential, null)
  }
})
