/**
 * Configuration, and the things it must refuse.
 *
 * `loadEnv` is pure over its source, so every failure path is testable without mutating the
 * process. The eager export in `env.ts` is what makes the service fail fast; these tests are what
 * make the failures specific.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { BASE_ENV } from './testsupport.ts'

/**
 * A valid environment, applied to the process BEFORE `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all.
 */
for (const [key, value] of Object.entries(BASE_ENV)) process.env[key] = value

const { EnvError, SERVICE, env, loadEnv, redactedEndpoint } = await import('./env.ts')

const withEnv = (extra: Record<string, string> = {}) => ({ ...BASE_ENV, ...extra })

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(SERVICE, 'studio')
  assert.equal(env.databaseUrl, BASE_ENV['STUDIO_DATABASE_URL'])
  assert.equal(env.port, 4015)
  // Deliberately NOT asserted here: anything derived from `env.flux`.
  //
  // The eager `env` reads the real `process.env`, so a developer who has sourced `.env.local` to
  // run the live tests has a real resource configured — and `assert.equal(env.flux, null)` would
  // then fail by PRINTING THE WHOLE CONFIG OBJECT, key included, into the test output and into
  // CI logs. An assertion is a disclosure channel whenever the value it prints holds a secret.
  // The backend cases below all go through `loadEnv`, which is pure over a source this file
  // controls, so they are true regardless of the ambient environment and cannot print a real key.
  assert.equal(typeof env.imagePriceUsdMicros, 'bigint')
})

test('a missing required variable names itself', () => {
  const { STUDIO_DATABASE_URL: _omitted, ...rest } = BASE_ENV
  assert.throws(
    () => loadEnv(rest),
    (err: unknown) => err instanceof EnvError && /STUDIO_DATABASE_URL/.test(err.message),
  )
})

test('a placeholder signing secret is refused outright', () => {
  // A default secret in source is not convenient, it is catastrophic: everything derived from it
  // is forgeable by anyone who can read the repository.
  //
  // NOT `instanceof EnvError` any more, and that is the change rather than an accident. The
  // refusal now comes from `@cloudsforge/secrets` as a `SecretError`, and it is deliberately NOT
  // re-wrapped: nothing in this service branches on the class (`fatalConfig` reads `.message` off
  // `unknown`), so wrapping would buy nothing and would cost the caller the ability to tell a
  // secret's shape apart from every other configuration fault. What must hold is the message.
  assert.throws(
    () => loadEnv(withEnv({ OUTBOX_SIGNING_SECRET: 'changeme' })),
    (err: unknown) => err instanceof Error && /known placeholder/.test(err.message),
  )
})

test('an unset signing secret is a refusal to boot, never a service that signs with nothing', () => {
  // `policy` was found running with this variable UNSET — measured at zero characters — while its
  // /livez stayed green. An empty value must reach `required`, not the shape guard, so the message
  // names the variable rather than describing an alphabet.
  assert.throws(
    () => loadEnv(withEnv({ OUTBOX_SIGNING_SECRET: '' })),
    (err: unknown) => err instanceof EnvError && /OUTBOX_SIGNING_SECRET is required/.test(err.message),
  )
  assert.throws(() => loadEnv(withEnv({ OUTBOX_SIGNING_SECRET: '   ' })), /OUTBOX_SIGNING_SECRET is required/)
})

test('THE VALUE THAT SAT IN A PUBLIC REPOSITORY IS REFUSED, and every near miss with it', () => {
  // micro-org #142. Each of these cleared the old guard — a deny-list of exact strings plus a
  // 24-character floor — and each is a real string that was deployed or set in CI, not an invented
  // one. The first was live on 44 containers across both networks. If a future edit weakens the
  // floor, it fails against evidence rather than against taste.
  for (const value of [
    'estate-only-outbox-secret-00000000000000', // 54 lines of a PUBLIC compose file, 40 chars
    'ci-only-not-a-real-secret-000000000000', // this repository's own former smoke-env value
    'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4', // the estate's former test fixture: 32 chars, 24 bytes
    '0'.repeat(64), // right alphabet, right length, no entropy
  ]) {
    assert.throws(
      () => loadEnv(withEnv({ OUTBOX_SIGNING_SECRET: value })),
      (err: unknown) => {
        // The refusal must not echo the value: the reason this guard exists is that the value was
        // readable, and a message carrying it moves the secret to the log collector. This service
        // already treats an assertion as a disclosure channel — see the note about `env.flux`
        // above — and the same argument applies to an error message.
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
  assert.doesNotThrow(() =>
    loadEnv(withEnv({ OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64') })),
  )
  assert.doesNotThrow(() => loadEnv(withEnv({ OUTBOX_SIGNING_SECRET: randomBytes(32).toString('hex') })))
})

test('THE FOUNDRY KEY IS NOT HELD TO THE GENERATED SHAPE, because Azure issues it', () => {
  // The shape guard applies where the ESTATE is the issuer. A vendor credential's alphabet and
  // length are the vendor's to change, and a guard that refused a valid key the day Azure altered
  // its format would be removed rather than fixed — taking the outbox guard with it. This service
  // is verified against a real FLUX 2 Pro deployment, so this is not hypothetical.
  const vendorish = 'a-real-looking-key-0000000000000000'
  assert.doesNotThrow(() =>
    loadEnv(
      withEnv({
        AZURE_FOUNDRY_ENDPOINT: 'https://test01eastus01.services.ai.azure.com',
        AZURE_FOUNDRY_API_KEY: vendorish,
      }),
    ),
  )
})

test('the image backend is OPTIONAL, and its absence is not a boot failure', () => {
  // The whole degraded-not-broken design rests on this. A service that refused to start without a
  // model could not create a brand kit while the owner was still deploying one.
  const env = loadEnv(BASE_ENV)
  assert.equal(env.flux, null)
  assert.equal(redactedEndpoint(env.flux), null)
})

test('a half-configured Foundry resource is refused, because it fails as an unreadable 401', () => {
  assert.throws(
    () => loadEnv(withEnv({ AZURE_FOUNDRY_ENDPOINT: 'https://test01eastus01.services.ai.azure.com' })),
    (err: unknown) => err instanceof EnvError && /must be set together/.test(err.message),
  )
  assert.throws(
    () => loadEnv(withEnv({ AZURE_FOUNDRY_API_KEY: 'a-real-looking-key-0000000000000000' })),
    (err: unknown) => err instanceof EnvError && /must be set together/.test(err.message),
  )
})

test('a fully configured resource defaults to FLUX.2-pro with no fallback', () => {
  // Only FLUX.2-pro is deployed on the resource; seven other FLUX names were probed and all 404.
  const env = loadEnv(
    withEnv({
      AZURE_FOUNDRY_ENDPOINT: 'https://test01eastus01.services.ai.azure.com',
      AZURE_FOUNDRY_API_KEY: 'a-real-looking-key-0000000000000000',
    }),
  )
  assert.equal(env.flux?.model, 'FLUX.2-pro')
  assert.equal(env.flux?.fallbackModel, '')
  assert.equal(env.flux?.imagePath, '/providers/blackforestlabs/v1/flux-2-pro')
  assert.equal(redactedEndpoint(env.flux), 'test01eastus01.services.ai.azure.com')
})

test('THE TRAP: a model name with dots is accepted, because FLUX.2-pro is the real spelling', () => {
  // The path segment is `flux-2-pro` and the model name is `FLUX.2-pro`. A validator that only
  // permitted the path spelling would refuse the one configuration that works.
  const env = loadEnv(
    withEnv({
      AZURE_FOUNDRY_ENDPOINT: 'https://test01eastus01.services.ai.azure.com',
      AZURE_FOUNDRY_API_KEY: 'a-real-looking-key-0000000000000000',
      STUDIO_IMAGE_MODEL: 'FLUX.2-pro',
      STUDIO_IMAGE_FALLBACK_MODEL: 'FLUX.1-pro',
    }),
  )
  assert.equal(env.flux?.model, 'FLUX.2-pro')
  assert.equal(env.flux?.fallbackModel, 'FLUX.1-pro')
})

test('a fallback identical to the primary is refused', () => {
  // It would double every failed call for no chance of a different answer.
  assert.throws(
    () =>
      loadEnv(
        withEnv({
          AZURE_FOUNDRY_ENDPOINT: 'https://test01eastus01.services.ai.azure.com',
          AZURE_FOUNDRY_API_KEY: 'a-real-looking-key-0000000000000000',
          STUDIO_IMAGE_MODEL: 'FLUX.2-pro',
          STUDIO_IMAGE_FALLBACK_MODEL: 'FLUX.2-pro',
        }),
      ),
    (err: unknown) => err instanceof EnvError && /must differ/.test(err.message),
  )
})

test('a trailing slash on the endpoint is stripped, because it 404s like a missing model', () => {
  const env = loadEnv(
    withEnv({
      AZURE_FOUNDRY_ENDPOINT: 'https://test01eastus01.services.ai.azure.com/',
      AZURE_FOUNDRY_API_KEY: 'a-real-looking-key-0000000000000000',
    }),
  )
  assert.equal(env.flux?.endpoint, 'https://test01eastus01.services.ai.azure.com')
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO CASES THAT PRODUCED FORTY PLACEHOLDER ASSETS. Both are configuration shapes that built
 * a wrong URL, answered 404, and were read as "no model is deployed" — while every test was green.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('AN ENDPOINT THAT ALREADY CARRIES THE PROVIDER PATH IS NOT CONCATENATED TWICE', () => {
  // Azure's portal offers the deployment's full Target URI, and that is what a person pastes.
  // Doubling it produces `…/flux-2-pro/providers/blackforestlabs/v1/flux-2-pro`, a 404 that reads
  // exactly like an undeployed model. This is the live estate's own secret shape.
  const env = loadEnv(
    withEnv({
      AZURE_FOUNDRY_ENDPOINT:
        'https://test01cloud01.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-pro',
      AZURE_FOUNDRY_API_KEY: 'a-real-looking-key-0000000000000000',
    }),
  )
  assert.equal(env.flux?.endpoint, 'https://test01cloud01.services.ai.azure.com')
  assert.equal(env.flux?.imagePath, '/providers/blackforestlabs/v1/flux-2-pro')
  // The two halves compose to exactly one correct URL, whichever shape the deploy supplied.
  assert.equal(
    `${env.flux?.endpoint}${env.flux?.imagePath}`,
    'https://test01cloud01.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-pro',
  )
})

test('the origin form and the full-target-URI form produce identical configuration', () => {
  const key = 'a-real-looking-key-0000000000000000'
  const origin = loadEnv(
    withEnv({
      AZURE_FOUNDRY_ENDPOINT: 'https://test01cloud01.services.ai.azure.com',
      AZURE_FOUNDRY_API_KEY: key,
    }),
  )
  const full = loadEnv(
    withEnv({
      AZURE_FOUNDRY_ENDPOINT:
        'https://test01cloud01.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-pro',
      AZURE_FOUNDRY_API_KEY: key,
    }),
  )
  assert.deepEqual(origin.flux, full.flux, 'two spellings of one address must configure the same')
})

test('api-version is defaulted, shape-checked, and cannot smuggle a second parameter', () => {
  const base = {
    AZURE_FOUNDRY_ENDPOINT: 'https://test01cloud01.services.ai.azure.com',
    AZURE_FOUNDRY_API_KEY: 'a-real-looking-key-0000000000000000',
  }
  // Defaulted to the version a real generation was verified against, not to a documented guess.
  assert.equal(loadEnv(withEnv(base)).flux?.apiVersion, '2025-04-01-preview')
  assert.equal(
    loadEnv(withEnv({ ...base, AZURE_FOUNDRY_API_VERSION: '2024-05-01-preview' })).flux?.apiVersion,
    '2024-05-01-preview',
  )
  // An EMPTY value is not in this list on purpose: unset and empty both mean "use the default",
  // which is how every other optional variable in this file behaves. Refusing it here would make
  // a blank line in an env file a boot failure.
  assert.equal(loadEnv(withEnv({ ...base, AZURE_FOUNDRY_API_VERSION: '' })).flux?.apiVersion, '2025-04-01-preview')
  // A value carrying `&` would append a parameter nobody wrote to every image request.
  for (const bad of ['latest', '2025-04-01&x=1', 'v1', '2025-4-1']) {
    assert.throws(
      () => loadEnv(withEnv({ ...base, AZURE_FOUNDRY_API_VERSION: bad })),
      EnvError,
      `${JSON.stringify(bad)} was accepted as an api-version`,
    )
  }
})

test('an image path must be absolute and must not end in a slash', () => {
  const base = {
    AZURE_FOUNDRY_ENDPOINT: 'https://test01eastus01.services.ai.azure.com',
    AZURE_FOUNDRY_API_KEY: 'a-real-looking-key-0000000000000000',
  }
  assert.throws(() => loadEnv(withEnv({ ...base, AZURE_FOUNDRY_IMAGE_PATH: 'providers/x' })), EnvError)
  assert.throws(() => loadEnv(withEnv({ ...base, AZURE_FOUNDRY_IMAGE_PATH: '/providers/x/' })), EnvError)
})

test('dollars become integer micro-dollars, and money is never a float', () => {
  const env = loadEnv(withEnv({ STUDIO_DEFAULT_CREDIT_CAP_USD: '2.5', STUDIO_IMAGE_PRICE_USD: '0.06' }))
  assert.equal(env.defaultCreditCapUsdMicros, 2_500_000n)
  assert.equal(env.imagePriceUsdMicros, 60_000n)
})

test('a nonsensical cap is refused rather than defaulted', () => {
  assert.throws(() => loadEnv(withEnv({ STUDIO_DEFAULT_CREDIT_CAP_USD: '-1' })), EnvError)
  assert.throws(() => loadEnv(withEnv({ STUDIO_DEFAULT_CREDIT_CAP_USD: 'lots' })), EnvError)
})

test('LOG_LEVEL is checked against the set the logger actually understands', () => {
  assert.throws(() => loadEnv(withEnv({ LOG_LEVEL: 'verbose' })), EnvError)
  assert.equal(loadEnv(withEnv({ LOG_LEVEL: 'debug' })).logLevel, 'debug')
})
