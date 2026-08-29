/**
 * Configuration.
 *
 * `loadEnv` is pure over its source, so every failure path is testable without mutating the
 * process. The eager export in `env.ts` is what makes the service fail fast; these tests are what
 * make the failures specific.
 *
 * The subject here is `INBOUND_SIGNING_SECRET`, which is a LIST rather than a value. See the field
 * comment in `env.ts` for why: rotating one estate-wide key by swapping it partitions delivery for
 * the length of the rolling deploy, and the only way to avoid that is an overlap window in which
 * the receiver accepts both.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { SignJWT, generateKeyPair } from 'jose'

/**
 * A service credential, and THIS FIXTURE CONTAINS HYPHENS ON PURPOSE — that is the most important
 * thing about it.
 *
 * A credential body is base64**url**, so `-` and `_` are in its alphabet. Measured on the running
 * estates: the mainnet credential is alphanumeric and the testnet one CONTAINS A HYPHEN. So a
 * "secrets have no hyphens" rule — which is correct for the two signing keys below, and which every
 * placeholder this estate wrote would have failed — passes mainnet and kills testnet at boot. That
 * is why `env.ts` guards a credential with `assertServiceCredential` and never `assertGeneratedSecret`.
 *
 * Keeping a hyphenated credential here means that mistake fails CI instead of failing one estate in
 * production. Do not "tidy" the hyphens out of this value. It is fabricated — identity's shape and
 * none of its entropy — and is never a value out of `deploy/compose/estate/tokens.env`.
 */
const CREDENTIAL = 'cfsc_Zq3W-Hn8Kd-Rb61Vy-Ls9Mx4Tf7Pg-Cj2Ue5Ao0Dw6Xr'

/**
 * A valid environment, applied to the process BEFORE `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all.
 *
 * The two signing values are GENERATED rather than written. Both used to be memorable strings that
 * cleared a 24-character floor — which is precisely the shape of the value that sat on 54 lines of
 * a PUBLIC compose file and passed every guard in the estate (micro-org #142). A fixture exempt
 * from the rule it exercises is how that survived every test in the estate.
 */
const BASE: Record<string, string> = {
  TESSERA_DATABASE_URL: 'postgres://tessera:tessera@127.0.0.1:5432/tessera',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
  INBOUND_SIGNING_SECRET: randomBytes(48).toString('base64'),
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

/** Generated per run, never committed, and never a real key. */
const NEXT_KEY = randomBytes(48).toString('base64')
const PRIOR_KEY = randomBytes(48).toString('base64')

const { EnvError, loadEnv } = await import('./env.ts')

test('a complete environment loads, and importing the module did not exit', () => {
  const env = loadEnv(BASE, 'host')
  assert.equal(env.databaseUrl, BASE['TESSERA_DATABASE_URL'])
})

test('a missing variable names itself', () => {
  const { IDENTITY_ISSUER: _omitted, ...rest } = BASE
  assert.throws(() => loadEnv(rest, 'host'), (err: unknown) => {
    assert.ok(err instanceof EnvError)
    assert.match(err.message, /IDENTITY_ISSUER/)
    return true
  })
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * INBOUND_SIGNING_SECRET — the rotation window.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('a single INBOUND_SIGNING_SECRET is a list of one, so nothing about today changes', () => {
  assert.deepEqual(
    [...loadEnv(BASE, 'host').inboundSigningSecrets],
    [BASE['INBOUND_SIGNING_SECRET']],
  )
})

test('INBOUND_SIGNING_SECRET is a comma-separated list, newest first, and signing stays single', () => {
  const env = loadEnv({ ...BASE, INBOUND_SIGNING_SECRET: ` ${NEXT_KEY} , ${PRIOR_KEY} ` }, 'host')
  assert.deepEqual([...env.inboundSigningSecrets], [NEXT_KEY, PRIOR_KEY])
  // Signing is NOT a list. Two outbound signatures would double every subscriber's verification
  // work and leave nobody able to say which key an event was signed with.
  assert.equal(env.outboxSigningSecret, BASE['OUTBOX_SIGNING_SECRET'])
})

test('every INBOUND_SIGNING_SECRET entry is held to the same bar as a single one was', () => {
  assert.throws(
    () => loadEnv({ ...BASE, INBOUND_SIGNING_SECRET: `${NEXT_KEY},changeme` }, 'host'),
    /placeholder/,
  )
  // The unit is BYTES of key material, not keystrokes. `short` is five characters of the base64
  // alphabet and three bytes, and the message says so rather than counting characters.
  assert.throws(
    () => loadEnv({ ...BASE, INBOUND_SIGNING_SECRET: `${NEXT_KEY},short` }, 'host'),
    /bytes of key material/,
  )
  // A list of separators is an empty list, which would accept nothing and 401 every producer.
  assert.throws(() => loadEnv({ ...BASE, INBOUND_SIGNING_SECRET: ' , , ' }, 'host'), /at least one/)
  // And absent is still absent, rather than an empty list that boots.
  const { INBOUND_SIGNING_SECRET: _omitted, ...rest } = BASE
  assert.throws(() => loadEnv(rest, 'host'), /INBOUND_SIGNING_SECRET/)
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * micro-org #142. The shape check, against the strings that were actually deployed.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Real strings, not invented ones: each was deployed or set in CI, and each cleared the old guard —
 * a deny-list of exact strings plus a 24-character floor — because it was on no list and was long
 * enough. If a future edit weakens the floor it fails against evidence rather than against taste.
 */
const DEPLOYED_PLACEHOLDERS = [
  'estate-only-outbox-secret-00000000000000', // 54 lines of a PUBLIC compose file, 40 chars
  'ci-only-not-a-real-secret-000000000000', // this repository's own former CI value
  'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4', // 32 chars of base64 alphabet, and only 24 bytes
  '0'.repeat(64), // right alphabet, right length, no entropy at all
] as const

test('THE VALUES THAT SAT IN A PUBLIC REPOSITORY ARE REFUSED, as a scalar', () => {
  for (const value of DEPLOYED_PLACEHOLDERS) {
    assert.throws(
      () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: value }, 'host'),
      (err: unknown) => {
        const message = (err as Error).message
        // The refusal must not echo the value. The reason this guard exists is that the value was
        // readable, and a message carrying it moves the secret to the log collector.
        assert.ok(!message.includes(value), 'the refusal echoed the value')
        assert.match(message, /OUTBOX_SIGNING_SECRET/)
        assert.match(message, /openssl rand -base64 48/)
        return true
      },
      `${value.slice(0, 6)}… was accepted as OUTBOX_SIGNING_SECRET`,
    )
  }
})

test('THE SAME BAR ON A LIST ENTRY — a rotation window is not a place the rule relaxes', () => {
  // The OUTGOING key is the one an attacker already holds if it leaked, so "just for the drain"
  // is exactly how a placeholder survives the rotation that was supposed to remove it. Second
  // position on purpose: the first entry being genuine must not vouch for the rest.
  for (const value of DEPLOYED_PLACEHOLDERS) {
    assert.throws(
      () => loadEnv({ ...BASE, INBOUND_SIGNING_SECRET: `${NEXT_KEY},${value}` }, 'host'),
      (err: unknown) => {
        const message = (err as Error).message
        assert.ok(!message.includes(value), 'the refusal echoed the value')
        assert.ok(!message.includes(NEXT_KEY), 'the refusal echoed the good key beside it')
        assert.match(message, /INBOUND_SIGNING_SECRET/)
        assert.match(message, /openssl rand -base64 48/)
        return true
      },
      `${value.slice(0, 6)}… was accepted as an INBOUND_SIGNING_SECRET entry`,
    )
  }
})

test('a generated secret is accepted, in either alphabet, scalar or list', () => {
  // The floors are measured rather than guessed, so a guard that occasionally refused correct
  // input — which is a guard somebody removes — would show up here.
  assert.doesNotThrow(() =>
    loadEnv(
      {
        ...BASE,
        OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
        INBOUND_SIGNING_SECRET: `${randomBytes(48).toString('base64')},${randomBytes(32).toString('hex')}`,
      },
      'host',
    ),
  )
})

test('INBOUND_SIGNING_SECRET listing the same secret twice is refused', () => {
  // A duplicate makes "which key verified this" ambiguous, and that answer is how an operator
  // knows the rotation has finished and the old key can be dropped.
  assert.throws(
    () => loadEnv({ ...BASE, INBOUND_SIGNING_SECRET: `${NEXT_KEY},${NEXT_KEY}` }, 'host'),
    /twice/,
  )
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * micro-org #222. THE VARIABLE THAT HELD A TOKEN WHERE A CREDENTIAL BELONGS.
 *
 * `TESSERA_SERVICE_CREDENTIAL` was guarded by `requiredSecret` — a deny-list of nine exact strings
 * plus a 24-character floor — and on the live estate it held a JWT that had been expired for
 * TWENTY-SIX HOURS on a container reporting healthy. That guard passed it: a service token is well
 * over 24 characters and is on no list. A check that could not fail read as the absence of a
 * problem, which is micro-org #142's lesson arriving at a second variable.
 *
 * `assertServiceCredential` refuses a JWT BY NAME and first of all, before any length or entropy
 * rule, precisely because the message an operator needs is "this is a token, and a token cannot
 * renew itself" rather than "this is too short".
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * A genuine RS256 service token, minted here rather than hand-shaped.
 *
 * A literal `ey…` string would prove the regex matches a string somebody typed. This proves the
 * guard refuses **the thing that was actually in the variable**: identity's own token shape, its own
 * claims, and the ten-minute expiry that is the whole of the defect.
 */
const { privateKey } = await generateKeyPair('RS256', { extractable: true })
const EXPIRED_TOKEN = await new SignJWT({ typ: 'service', scopes: ['tessera:read'] })
  .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
  .setIssuedAt()
  .setIssuer('https://identity.test')
  .setAudience('cloudsforge')
  .setSubject('service:tessera')
  // 600 seconds — identity/src/tokens.ts, and the reason this variable is a defect rather than
  // a style preference.
  .setExpirationTime('600s')
  .sign(privateKey)

test('a well-formed JWT in TESSERA_SERVICE_CREDENTIAL is refused BY NAME', () => {
  assert.throws(
    () => loadEnv({ ...BASE, TESSERA_SERVICE_CREDENTIAL: EXPIRED_TOKEN }, 'host'),
    (err: unknown) => {
      const message = (err as Error).message
      assert.ok(!message.includes(EXPIRED_TOKEN), 'the refusal echoed the token')
      assert.match(message, /TESSERA_SERVICE_CREDENTIAL/)
      // Not "too short", not "a placeholder" — the message must say what it actually is, because
      // the remedy is a different variable rather than a better value.
      assert.match(message, /TOKEN, not a credential/)
      assert.match(message, /ten-minute/)
      return true
    },
    'the JWT that was live on the estate for 26 hours still boots this service',
  )
})

test('the same JWT is refused in TESSERA_IDENTITY_CREDENTIAL, which is where it will be pasted', () => {
  // The migration's likeliest mistake: an operator adding the new variable and filling it from the
  // old one. Refused at the door rather than ten minutes into the deploy, and the `cfsc_` prefix is
  // named so the message is also the instruction.
  assert.throws(
    () => loadEnv({ ...BASE, TESSERA_IDENTITY_CREDENTIAL: EXPIRED_TOKEN }, 'host'),
    /TESSERA_IDENTITY_CREDENTIAL.*TOKEN, not a credential/s,
  )
  assert.throws(
    () => loadEnv({ ...BASE, TESSERA_IDENTITY_CREDENTIAL: 'cfsc_changeme' }, 'host'),
    /TESSERA_IDENTITY_CREDENTIAL/,
  )
})

test('A HYPHENATED CREDENTIAL IS ACCEPTED — the testnet/mainnet asymmetry, pinned', () => {
  // If this ever goes red because somebody reached for `assertGeneratedSecret`, the estate that
  // breaks is testnet and mainnet stays green, which is the worst possible way to find out.
  const env = loadEnv({ ...BASE, TESSERA_IDENTITY_CREDENTIAL: CREDENTIAL }, 'host')
  assert.equal(env.identityCredential, CREDENTIAL)
  assert.ok(CREDENTIAL.slice('cfsc_'.length).includes('-'), 'the fixture lost its hyphens')
})

test('ABSENT AND EMPTY ARE BOTH THE SUPPORTED MODE, and both read as null', () => {
  // Compose interpolates `${TESSERA_IDENTITY_CREDENTIAL:-}`, so an unset credential arrives as the
  // EMPTY STRING rather than as `undefined`. If that were not the absence, `upstreams.ts` would
  // choose a mode by `env.x ? … : …` and agree with an operator who set the variable to nothing.
  for (const source of [BASE, { ...BASE, TESSERA_IDENTITY_CREDENTIAL: '', TESSERA_SERVICE_CREDENTIAL: '   ' }]) {
    const env = loadEnv(source, 'host')
    assert.equal(env.identityCredential, null)
    assert.equal(env.serviceCredential, null)
  }
})

test('IDENTITY_URL defaults to the issuer, and is refused if it carries a path', () => {
  // Required, but satisfiable from a variable every deployment already sets — so the exchange
  // arrives with no manifest change and CI's smoke-env needs no new line. See the field comment.
  assert.equal(loadEnv(BASE, 'host').identityUrl, BASE['IDENTITY_ISSUER'])
  assert.equal(
    loadEnv({ ...BASE, IDENTITY_URL: 'http://identity:4000' }, 'host').identityUrl,
    'http://identity:4000',
  )
  // A path here would produce `POST /v1//service-tokens/exchange`, which 404s with nothing in
  // either log naming the cause.
  assert.throws(
    () => loadEnv({ ...BASE, IDENTITY_URL: 'http://identity:4000/v1' }, 'host'),
    /IDENTITY_URL must be an origin/,
  )
})
