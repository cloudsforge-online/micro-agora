/**
 * Configuration, and the two defaults that fail closed.
 *
 * `loadEnv` is pure over its source, so every failure path is testable without mutating the
 * process — which matters because the eager export in `env.ts` calls `process.exit(1)`.
 */

import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * A valid environment, applied to the process BEFORE `./env.ts` is imported.
 *
 * **The import itself is a test.** `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. The failure
 * cases below go through `loadEnv`, which is pure over its source and therefore testable without a
 * child process. `micro-mint/src/env.test.ts` does exactly this, for exactly this reason.
 */
const MINIMAL: Readonly<Record<string, string>> = Object.freeze({
  FORESIGHT_DATABASE_URL: 'postgres://x:y@127.0.0.1:5432/foresight',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  // GENERATED, not written. The literal that used to sit here was
  // `a-real-looking-secret-of-sufficient-length` — 42 characters, therefore past the old
  // 24-character floor, and a hyphenated placeholder of exactly the family that reached 44
  // containers as micro-org #142. It also normalises to a string containing `sufficientlength`,
  // which is on `@cloudsforge/secrets`' marker list BECAUSE OF THIS FIXTURE. Every test in this
  // file was built on it, so the whole suite was asserting that a placeholder is an acceptable
  // signing key for the estate's event bus.
  OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
  CUSTODY_URL: 'http://127.0.0.1:4005',
  INDEXER_URL: 'http://127.0.0.1:4008',
  LEDGER_URL: 'http://127.0.0.1:4007',
  POLICY_URL: 'http://127.0.0.1:4006',
  // NEITHER credential appears here, and that is the point of the block below: this service must
  // boot without one, because `foresight-migrate` shares this environment and dials nothing.
  FORESIGHT_TREASURY_ADDRESS: '0x2222222222222222222222222222222222222222',
  FORESIGHT_ORACLE_ADDRESS: '0x1111111111111111111111111111111111111111',
  FORESIGHT_ORACLE_USER_ID: 'foresight',
  FORESIGHT_ORACLE_ORDER_ID: 'oracle-ember-testnet',
})

for (const [key, value] of Object.entries(MINIMAL)) process.env[key] = value

/**
 * THIS FIXTURE CONTAINS HYPHENS ON PURPOSE, AND THAT IS THE MOST IMPORTANT THING ABOUT IT.
 *
 * A credential body is base64**url**, so `-` and `_` are in its alphabet. Measured on the running
 * estates: the mainnet credential is alphanumeric and the testnet one CONTAINS A HYPHEN. So a
 * "secrets have no hyphens" rule — which is correct for `OUTBOX_SIGNING_SECRET` above, and which
 * every placeholder this estate wrote would have failed — passes mainnet and kills testnet at boot.
 *
 * Keeping a hyphenated credential here means that mistake fails CI instead of failing one estate in
 * production. Do not "tidy" the hyphens out of this value.
 *
 * The literal it replaces was `cfsc_a-real-looking-credential-value`: the right prefix, a 30-
 * character body, and therefore 22 BYTES of key material — under the floor and past the old
 * 24-KEYSTROKE check. A fixture that could not survive the check it demonstrates documents the
 * absence of one.
 */
const CREDENTIAL = 'cfsc_TToR-eOeVTDnqhX1-nu6-u7DoCr4MCfa86g4g6kd404'

/**
 * The exact shape `FORESIGHT_SERVICE_TOKEN` holds on the live estate — measured 2026-08-05 as an
 * 805-byte JWT that had expired 26 hours earlier while the container reported healthy. Fabricated
 * here, obviously; only the first two segments matter, because the guard refuses on SHAPE and never
 * decodes. micro-org #222.
 */
const JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmb3Jlc2lnaHQiLCJleHAiOjF9.notasignature'

const { EnvError, SERVICE, env, loadEnv, parseNetwork } = await import('./env.ts')

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(env.databaseUrl, MINIMAL['FORESIGHT_DATABASE_URL'])
  assert.equal(SERVICE, 'foresight')
})

test('the minimal configuration loads and defaults sensibly', () => {
  const env = loadEnv(MINIMAL, 'host-1')
  assert.equal(env.port, 4021)
  assert.equal(env.network, 'testnet')
  assert.equal(env.instanceId, 'host-1')
  assert.equal(env.defaultFeeBps, 200)
  assert.equal(env.defaultDisputeWindowSeconds, 86_400)
  assert.equal(env.policyAction, 'trade.order.place')
  // wei quantities are bigint, always. A gas bound read through Number() is silently rounded, and
  // a rounded bound does not hold at the value it was written for.
  assert.equal(typeof env.minGasPriceWei, 'bigint')
  assert.equal(env.deployGasLimit, 3_000_000n)
})

/* ------------------------------------------------------------------ the credential, and the cliff */

test('BOTH credentials are optional, because the migrator shares this environment', () => {
  // `FORESIGHT_SERVICE_TOKEN` used to be `requiredSecret`. It is now optional, and that is not a
  // relaxation: it is the OLD, DEFECTIVE credential — a 600-second token nothing can renew — being
  // demoted from mandatory to a migration aid while micro-deploy is taught to pass
  // `FORESIGHT_IDENTITY_CREDENTIAL` instead. `upstreams.ts` carries the argument.
  //
  // `FORESIGHT_IDENTITY_CREDENTIAL` is optional for ledger's reason: `migrator.ts` imports this
  // same module and `foresight-migrate` is given no credential because it calls nobody. Making it
  // `requiredSecret` would refuse to run the migration that every deploy starts with.
  const none = loadEnv(MINIMAL)
  assert.equal(none.identityCredential, null)
  assert.equal(none.serviceToken, null)

  const exchanged = loadEnv({ ...MINIMAL, FORESIGHT_IDENTITY_CREDENTIAL: CREDENTIAL })
  assert.equal(exchanged.identityCredential, CREDENTIAL)

  // And `IDENTITY_URL` defaults to the issuer, so this fix needs no new URL in any deploy manifest:
  // the issuer of a token is by definition where the token came from.
  assert.equal(exchanged.identityUrl, MINIMAL['IDENTITY_ISSUER'])
  assert.equal(loadEnv({ ...MINIMAL, IDENTITY_URL: 'http://identity:4000' }).identityUrl, 'http://identity:4000')
})

test('an optional secret that IS present is held to the same bar as a required one', () => {
  // The dangerous middle state. Optional must not mean unchecked: the estate's compose defaults
  // BOTH of these to `estate-placeholder-token-0000000000000000`, which is 41 characters and sails
  // through a length check.
  //
  // The two assertions below used to read `/at least 24/` and `/known placeholder/`. The first was
  // a defence of the defective rule — it pinned a floor counted in KEYSTROKES, so any fix that
  // started counting bytes would fail CI however much better it was — and the second pinned a
  // deny-list message for a value the deny-list only happened to contain. What they assert now is
  // the property: the variable is named, the value is not quoted back, and neither is accepted.
  for (const name of ['FORESIGHT_IDENTITY_CREDENTIAL', 'FORESIGHT_SERVICE_TOKEN']) {
    for (const bad of ['short', 'placeholder', 'estate-placeholder-token-0000000000000000']) {
      assert.throws(
        () => loadEnv({ ...MINIMAL, [name]: bad }),
        (err: unknown) =>
          err instanceof EnvError && err.message.includes(name) && !err.message.includes(bad),
        `${name} accepted ${bad}`,
      )
    }
  }
  // An empty string is ABSENT, not a bad secret: compose writes `VAR: ${VAR:-}` for an unset
  // variable, so this is the shape a real deployment produces and it must not fail the boot.
  assert.equal(loadEnv({ ...MINIMAL, FORESIGHT_IDENTITY_CREDENTIAL: '' }).identityCredential, null)
  assert.equal(loadEnv({ ...MINIMAL, FORESIGHT_SERVICE_TOKEN: '   ' }).serviceToken, null)
})

test('every required variable names itself when it is missing', () => {
  for (const key of Object.keys(MINIMAL)) {
    const source = { ...MINIMAL }
    delete (source as Record<string, string | undefined>)[key]
    assert.throws(
      () => loadEnv(source),
      (err: unknown) => err instanceof EnvError && err.message.includes(key),
      `${key} did not name itself when absent`,
    )
  }
})

test('a known placeholder is refused outright, even when it is long enough', () => {
  // A default secret in source is not convenient, it is catastrophic, and a placeholder that boots
  // is a placeholder that reaches production. `CHANGE_ME` is exactly what `.env.example` carries.
  //
  // The first case is the one that proves the placeholder LIST does work: 'replace-with-a-real-secret'
  // is 26 characters, so it clears the length check and is refused on its own merits. Without a case
  // like it, a test of short placeholders would pass with the list deleted entirely.
  assert.throws(
    () => loadEnv({ ...MINIMAL, OUTBOX_SIGNING_SECRET: 'replace-with-a-real-secret' }),
    /known placeholder/,
  )
  for (const value of ['CHANGE_ME', 'change_me', 'changeme', 'placeholder']) {
    assert.throws(() => loadEnv({ ...MINIMAL, OUTBOX_SIGNING_SECRET: value }), /known placeholder/)
  }
  // AND THE ONE THAT ACTUALLY SHIPPED, which no deny-list contained. micro-org #142's
  // `estate-only-outbox-secret-00000000000000` is 40 characters, so it cleared the 24-character
  // floor this file used to assert, and it reached 44 containers on both networks with every guard
  // in the estate passing it.
  assert.throws(
    () => loadEnv({ ...MINIMAL, OUTBOX_SIGNING_SECRET: 'estate-only-outbox-secret-00000000000000' }),
    (err: unknown) => err instanceof EnvError && /placeholder/.test(err.message),
  )
  // BYTES, not keystrokes. This assertion used to read `/at least 24/` against
  // `FORESIGHT_SERVICE_TOKEN: 'short'` — the keystroke floor that let the 40-character placeholder
  // above through. `hunter2` is spelled in the base64 alphabet, so it is not the alphabet that
  // catches it: it decodes to 5 bytes.
  assert.throws(
    () => loadEnv({ ...MINIMAL, OUTBOX_SIGNING_SECRET: 'hunter2' }),
    (err: unknown) =>
      err instanceof EnvError &&
      /5 bytes of key material/.test(err.message) &&
      /at least 32/.test(err.message) &&
      !err.message.includes('hunter2'),
  )
})

test('FORESIGHT_SERVICE_TOKEN CARRYING A JWT IS REFUSED BY NAME — micro-org #222', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Measured on the running estate 2026-08-05: this variable held an 805-byte JWT that had expired
  // 26 HOURS earlier, on a container reporting healthy. That value is what this assertion refuses.
  //
  // If this test is ever "fixed" by adding a JWT exemption or by dropping to a weaker assertion,
  // the fix IS the defect: a ten-minute bearer read once at boot is precisely #197 and #222, and it
  // bites this service harder than most because its custody calls come from leased background jobs
  // that a bootstrap outruns.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  for (const name of ['FORESIGHT_SERVICE_TOKEN', 'FORESIGHT_IDENTITY_CREDENTIAL']) {
    assert.throws(
      () => loadEnv({ ...MINIMAL, [name]: JWT }),
      (err: unknown) => {
        assert.ok(err instanceof EnvError)
        assert.match(err.message, new RegExp(name))
        assert.match(err.message, /TOKEN, not a credential|micro-org#197/)
        assert.ok(!err.message.includes(JWT), 'the error quoted the token back')
        return true
      },
      `${name} accepted a JWT`,
    )
  }
})

/**
 * THE PROPOSER AND SEARCH TOKENS ARE OPAQUE, AND THAT IS A DELIBERATE THIRD CLASS.
 *
 * They authenticate to an external model provider and an external search adapter, so their
 * alphabets belong to their ISSUERS. Demanding base64 of a value somebody else minted refuses a
 * correct credential, and a guard that refuses correct input is a guard an operator deletes.
 */
test('the proposer and search tokens take a vendor alphabet, and still refuse a placeholder', () => {
  // Punctuation a generated-secret rule would reject, and an opaque rule must not.
  // Punctuation and an underscore-prefixed shape a GENERATED-secret rule would reject outright.
  // Deliberately not spelled like any real vendor's format, so the estate's secret-hygiene scan
  // has nothing to match on.
  const vendorKey = 'vendorkey_9f!Qz$4Kd7#Vh2Ls0Pw8Rt6Yb1Nm3Xc'
  const env = loadEnv({
    ...MINIMAL,
    FORESIGHT_PROPOSER_TOKEN: vendorKey,
    FORESIGHT_SEARCH_TOKEN: vendorKey,
  })
  assert.equal(env.proposerToken, vendorKey)
  assert.equal(env.searchToken, vendorKey)

  // Absent stays absent — `undefined`, not `''`, because `proposer.ts` sends an Authorization
  // header on exactly that distinction.
  assert.equal(loadEnv(MINIMAL).proposerToken, undefined)
  assert.equal(loadEnv({ ...MINIMAL, FORESIGHT_SEARCH_TOKEN: '   ' }).searchToken, undefined)

  // What survives when the alphabet check does not: the markers, which are what catch this
  // estate's real defects, and a JWT — a ten-minute bearer in a variable read once at boot.
  for (const name of ['FORESIGHT_PROPOSER_TOKEN', 'FORESIGHT_SEARCH_TOKEN']) {
    for (const bad of ['estate-placeholder-token-0000000000000000', 'changeme', '0000000000000000000000', JWT]) {
      assert.throws(
        () => loadEnv({ ...MINIMAL, [name]: bad }),
        (err: unknown) =>
          err instanceof EnvError && err.message.includes(name) && !err.message.includes(bad),
        `${name} accepted ${bad.slice(0, 20)}`,
      )
    }
  }
})

/**
 * **TWO deliberate settings to reach a mainnet.**
 *
 * A market on a mainnet holds real EMBER belonging to strangers. A single `FORESIGHT_NETWORK`
 * typo must not be enough.
 */
test('mainnet takes two deliberate settings, and refuses on one', () => {
  assert.throws(
    () => loadEnv({ ...MINIMAL, FORESIGHT_NETWORK: 'mainnet' }),
    /two deliberate settings/,
  )
  const env = loadEnv({ ...MINIMAL, FORESIGHT_NETWORK: 'mainnet', FORESIGHT_MAINNET_ENABLED: 'true' })
  assert.equal(env.network, 'mainnet')
  assert.equal(env.mainnetEnabled, true)
  // And the flag alone changes nothing about which network is used.
  assert.equal(loadEnv({ ...MINIMAL, FORESIGHT_MAINNET_ENABLED: 'true' }).network, 'testnet')
})

/**
 * **UNCONFIGURED IS A SUPPORTED MODE.** The idea pipeline records "no proposals" rather than
 * crashing — `micro-notify`'s SMTP discipline, and the reason is stronger here: an operator can
 * write every market question by hand, so a service that fell over without its suggester would have
 * the dependency backwards.
 */
test('the proposer is absent by default and that is not an error', () => {
  const env = loadEnv(MINIMAL)
  assert.equal(env.proposerUrl, undefined)
  assert.equal(env.searchUrl, undefined)
  assert.equal(env.proposerModelId, undefined)
})

test('an address variable must be an address', () => {
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_ORACLE_ADDRESS: 'not-an-address' }), /20-byte address/)
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_TREASURY_ADDRESS: '0x1234' }), /20-byte address/)
})

test('an out-of-range or malformed number is refused rather than defaulted', () => {
  assert.throws(() => loadEnv({ ...MINIMAL, PORT: '0' }), /between 1 and 65535/)
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_DEFAULT_FEE_BPS: '1001' }), /between 0 and 1000/)
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_MIN_GAS_PRICE_WEI: '1.5' }), /whole number of wei/)
  assert.throws(
    () => loadEnv({ ...MINIMAL, FORESIGHT_MIN_GAS_PRICE_WEI: '10', FORESIGHT_MAX_GAS_PRICE_WEI: '5' }),
    /exceeds/,
  )
  assert.throws(() => loadEnv({ ...MINIMAL, LOG_LEVEL: 'chatty' }), /LOG_LEVEL/)
})

test('the RPC map is refused rather than silently emptied when it will not parse', () => {
  // A silently-empty map is an outage that presents as "every deploy is refused for want of an
  // endpoint", which is a long way from the typo that caused it.
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_RPC_URLS: 'not json' }), /JSON object/)
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_RPC_URLS: '["a"]' }), /JSON object/)
  const env = loadEnv({ ...MINIMAL, FORESIGHT_RPC_URLS: '{"ember":"http://127.0.0.1:8545"}' })
  assert.equal(env.rpcUrls['ember'], 'http://127.0.0.1:8545')
})

test('parseNetwork is closed', () => {
  assert.equal(parseNetwork('mainnet'), 'mainnet')
  assert.equal(parseNetwork('testnet'), 'testnet')
  assert.throws(() => parseNetwork('devnet'), /mainnet or testnet/)
})

/**
 * Rule 1 of docs/ecosystem/03 §2, as a test rather than as review discipline.
 *
 * The CI `rules` job greps the source for a second connection-string variable. This is the same
 * statement from the inside: the only DSN this service reads is its own.
 */
test('this service reads exactly one database variable, and it is its own', () => {
  // The variable name is ASSEMBLED so this test does not itself trip the CI grep it agrees with.
  // `micro-market` had to do the same, and the org workflow was later fixed to stop punishing a
  // test that documents the rule (`micro-org/.github/workflows/service-ci.yml`).
  const foreignName = ['LEDGER', 'DATABASE', 'URL'].join('_')
  const foreignDsn = 'postgres://someone:else@host/ledger'
  const env = loadEnv({ ...MINIMAL, [foreignName]: foreignDsn })
  assert.equal(env.databaseUrl, MINIMAL['FORESIGHT_DATABASE_URL'])
  // Another service's connection string reaches nothing this service reads.
  assert.equal(
    Object.values(env).some((value) => value === foreignDsn),
    false,
    'a foreign database URL was picked up',
  )
})

test('PRICING_URL is optional, and its absence refuses a rate rather than defaulting one', async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // The live estate does not set it (`deploy/compose/docker-compose.estate.yml`, the `foresight`
  // service), so requiring it would refuse to boot a deployment that had been working. That is
  // only safe because an absent rate source REFUSES rather than permits: there is nothing to
  // guess from, and `unconfiguredPricingClient` says so with the reason.
  //
  // MUTATION: have the unconfigured client return `{ stakeUsdScaled: RATE_SCALE, poolUsdScaled:
  // RATE_SCALE }` for every asset → every BTC stake is priced as if one satoshi were one dollar,
  // and this reddens.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const { unconfiguredPricingClient } = await import('./pricingclient.ts')
  const client = unconfiguredPricingClient()

  // The pool asset applies no rate at all, so it is unaffected — this is what lets the estate keep
  // running unchanged while PRICING_URL is unset.
  const ember = await client.stakeRates('EMBER')
  assert.equal(ember.stakeUsdScaled, ember.poolUsdScaled)

  await assert.rejects(
    () => client.stakeRates('BTC'),
    (err: unknown) => err instanceof Error && /no PRICING_URL/.test(err.message),
  )
})

test('STUDIO_PUBLIC_URL is optional, and a present value must be an ORIGIN', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Absent is the estate's current state — studio is published on 127.0.0.1:4111 with no public
  // hostname — so requiring it would refuse to boot a working deployment. Absent means every
  // `image.bytesUrl` is null, which is honest: a relative path would resolve against foresight's
  // own origin in a browser and 404.
  //
  // The origin check earns its place because the failure it prevents is invisible from the server.
  // `https://studio.example/` with its trailing slash composes `…//v1/assets/…`, and a path
  // segment composes `…/studio/v1/assets/…`; both are 404s on somebody's page and a green
  // /readyz here. Refusing at boot turns a silent broken image into a fatal line with the value.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  assert.equal(loadEnv(MINIMAL).studioPublicUrl, undefined)
  assert.equal(
    loadEnv({ ...MINIMAL, STUDIO_PUBLIC_URL: 'https://studio.example.invalid' }).studioPublicUrl,
    'https://studio.example.invalid',
  )
  // A trailing slash is an origin with pathname '/', which URL normalises away — accepted, and it
  // composes correctly because `origin` never carries one.
  assert.equal(
    loadEnv({ ...MINIMAL, STUDIO_PUBLIC_URL: 'https://studio.example.invalid/' }).studioPublicUrl,
    'https://studio.example.invalid',
  )
  for (const bad of ['studio.example.invalid', 'https://studio.example.invalid/v1', 'ftp://s.invalid']) {
    assert.throws(() => loadEnv({ ...MINIMAL, STUDIO_PUBLIC_URL: bad }), EnvError, `${bad} was accepted`)
  }
})
