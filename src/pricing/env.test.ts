import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

/**
 * A valid environment, applied to the process before `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. The
 * failure cases below go through `loadEnv`, which is pure over its source and therefore testable
 * without a child process.
 */
const VALID: Record<string, string> = {
  PRICING_DATABASE_URL: 'postgres://pricing:pw@127.0.0.1:5432/pricing',
  IDENTITY_JWKS_URL: 'http://identity.test/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://identity.test',
  // GENERATED, not written. `assertGeneratedSecret` refuses a typed value, and a fixture exempt
  // from the rule it is meant to exercise is how the placeholder in micro-org #142 survived every
  // test in the estate. The literal that used to sit here was 32 characters but only 24 BYTES.
  OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
}
for (const [key, value] of Object.entries(VALID)) process.env[key] = value

const { EnvError, SERVICE, env, loadEnv } = await import('./env.ts')

const BASE = VALID

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(env.databaseUrl, VALID['PRICING_DATABASE_URL'])
  assert.equal(SERVICE, 'pricing')
})

test('a missing variable names itself', () => {
  assert.throws(
    () => loadEnv({ ...BASE, PRICING_DATABASE_URL: undefined }),
    (err: unknown) => err instanceof EnvError && /PRICING_DATABASE_URL is required/.test(err.message),
  )
  assert.throws(() => loadEnv({ ...BASE, IDENTITY_ISSUER: undefined }), /IDENTITY_ISSUER is required/)
})

test('a placeholder secret is refused outright', () => {
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'changeme' }), /known placeholder/)
  // Measured in DECODED BYTES, not keystrokes: 32 characters of prose is not 32 bytes of key.
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'short' }), /3 bytes of key material/)
})

test('an unset signing secret is a refusal to boot, never a service that signs with nothing', () => {
  // `policy` was found running with this variable UNSET — measured at zero characters — while its
  // /livez stayed green. An empty string must reach `required`, not the shape guard, so the
  // message names the variable rather than describing an alphabet.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: undefined }),
    /OUTBOX_SIGNING_SECRET is required/,
  )
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: '   ' }), /OUTBOX_SIGNING_SECRET is required/)
})

test('THE VALUE THAT SAT IN A PUBLIC REPOSITORY IS REFUSED, and every near miss with it', () => {
  // micro-org #142. Each of these cleared the old guard — a deny-list of exact strings plus a
  // 24-character floor — and each is a real string that was deployed or set in CI, not an invented
  // one. The first was live on 44 containers across both networks. If a future edit weakens the
  // floor, it fails against evidence rather than against taste.
  for (const value of [
    'estate-only-outbox-secret-00000000000000', // 54 lines of a PUBLIC compose file, 40 chars
    'ci-only-not-a-real-secret-000000000000', // this workflow's own former smoke-env value
    'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4', // this file's own former fixture: 32 chars, 24 bytes
    '0'.repeat(64), // right alphabet, right length, no entropy
  ]) {
    assert.throws(
      () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: value }),
      (err: unknown) => {
        // The refusal must not echo the value: the reason this guard exists is that the value was
        // readable, and a message carrying it moves the secret to the log collector.
        const message = (err as Error).message
        assert.ok(!message.includes(value), 'the refusal echoed the value')
        assert.match(message, /OUTBOX_SIGNING_SECRET/)
        assert.match(message, /openssl rand -base64 48/)
        return true
      },
    )
  }
})

test('a generated secret is accepted, in either alphabet', () => {
  assert.doesNotThrow(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64') }))
  assert.doesNotThrow(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(32).toString('hex') }))
})

test('the oracle defaults are the safe ones', () => {
  const loaded = loadEnv(BASE)
  assert.equal(loaded.minSources, 2, 'one source is one exchange\'s opinion, not a median')
  assert.equal(loaded.maxDivergenceBps, 200)
  assert.equal(loaded.maxAgeSeconds, 300)
  assert.equal(loaded.conversionSpreadBps, 100)
  assert.equal(loaded.refreshSeconds, 60)
})

test('the spread can never reach 10000 bps, which would divide by zero on the buy leg', () => {
  // `applySpreadBuy` divides by (10000 - bps). The bound is set far below that anyway.
  assert.throws(() => loadEnv({ ...BASE, PRICING_CONVERSION_SPREAD_BPS: '10000' }), /between 0 and 2000/)
  assert.throws(() => loadEnv({ ...BASE, PRICING_CONVERSION_SPREAD_BPS: '-1' }), /between 0 and 2000/)
  assert.equal(loadEnv({ ...BASE, PRICING_CONVERSION_SPREAD_BPS: '0' }).conversionSpreadBps, 0)
})

test('the source minimum cannot exceed the number of sources that exist', () => {
  assert.throws(() => loadEnv({ ...BASE, PRICING_MIN_SOURCES: '5' }), /between 1 and 4/)
  assert.equal(loadEnv({ ...BASE, PRICING_MIN_SOURCES: '4' }).minSources, 4)
})

test('a maximum age of zero is refused: it would make every rate unusable the instant it landed', () => {
  assert.throws(() => loadEnv({ ...BASE, PRICING_MAX_AGE_SECONDS: '0' }), /between 5 and 86400/)
})

test('a non-integer setting is refused rather than coerced', () => {
  assert.throws(() => loadEnv({ ...BASE, PRICING_MAX_DIVERGENCE_BPS: '2.5' }), EnvError)
  assert.throws(() => loadEnv({ ...BASE, PORT: 'four thousand' }), EnvError)
})

test('LOG_LEVEL is a closed set', () => {
  assert.throws(() => loadEnv({ ...BASE, LOG_LEVEL: 'verbose' }), /LOG_LEVEL must be one of/)
})
