/**
 * Configuration, and the two names that are not negotiable.
 *
 * `DEVPLATFORM_TEST_DATABASE_URL` is asserted by name here because the reusable CI workflow exports
 * the Postgres DSN under exactly that spelling and then FAILS the build if the database-backed
 * suite skipped. A different spelling in `testsupport.ts` reads no DSN, skips silently, and turns
 * that guard into the false-green it exists to prevent — a build that is green because nothing ran.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { SecretError } from '@cloudsforge/secrets'

/**
 * GENERATED, not written.
 *
 * Both of these used to be memorable strings — `a-real-looking-secret-value-0000` and
 * `another-real-looking-secret-1111` — long enough to clear the old 24-character floor and on no
 * deny-list. That is exactly the shape of `estate-only-outbox-secret-00000000000000`, which sat on
 * 54 lines of a PUBLIC compose file and passed every guard in the estate (micro-org #142). A
 * fixture exempt from the rule it exercises is how that survived every test in the estate.
 */
const GOOD_SECRET = randomBytes(48).toString('base64')
const SECOND_SECRET = randomBytes(48).toString('base64')

function base(): Record<string, string> {
  return {
    DEVPLATFORM_DATABASE_URL: 'postgres://user:pw@db:5432/devplatform',
    IDENTITY_JWKS_URL: 'http://identity:4000/.well-known/jwks.json',
    IDENTITY_ISSUER: 'http://identity:4000',
    DEVPLATFORM_INGEST_SECRETS: GOOD_SECRET,
    OUTBOX_SIGNING_SECRET: GOOD_SECRET,
  }
}

// `env.ts` validates `process.env` at IMPORT and exits the process on a bad configuration — right
// for a service, fatal for a test runner. So populate a valid environment first, then import it
// dynamically. `loadEnv` itself is pure over its source, so every case below passes an explicit
// object and never touches `process.env`. The estate's pattern; `lantern/src/env.test.ts` is the
// sibling that documents it.
for (const [key, value] of Object.entries(base())) process.env[key] = value
const { EnvError, SERVICE, loadEnv, parseSecretList } = await import('./env.ts')
const { TEST_DSN_VAR } = await import('./testsupport.ts')

/* ------------------------------------------------------------------ the names */

test('the test DSN variable is spelled exactly as CI exports it', () => {
  assert.equal(TEST_DSN_VAR, 'DEVPLATFORM_TEST_DATABASE_URL')
  assert.equal(TEST_DSN_VAR, `${SERVICE.toUpperCase()}_TEST_DATABASE_URL`)
})

test('the service reads exactly one connection string, and it is its own', () => {
  // Rule 1: one database per service. CI greps source for any other `*_DATABASE_URL` token, so this
  // is the local copy of that check — it fails here, in seconds, rather than in the build.
  const source = readFileSync(fileURLToPath(new URL('./env.ts', import.meta.url)), 'utf8')
  const found = [...source.matchAll(/([A-Z][A-Z0-9_]*_DATABASE_URL)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(found)], ['DEVPLATFORM_DATABASE_URL'])
})

test('there is no admin token, no break-glass credential and no reveal switch', () => {
  const source = readFileSync(fileURLToPath(new URL('./env.ts', import.meta.url)), 'utf8')
  for (const forbidden of ['DEVPLATFORM_ADMIN_TOKEN', 'DEVPLATFORM_TOKEN', 'REVEAL', 'BREAK_GLASS']) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\b`).test(source.replace(/^\s*\*.*$/gm, '')),
      `${forbidden} appears in env.ts — a static string that can read or issue credentials is the ` +
        'shape SD-05 exists to retire',
    )
  }
})

/* ------------------------------------------------------------------ required values */

test('a valid environment loads', () => {
  const env = loadEnv(base(), 'host-1')
  assert.equal(env.databaseUrl, 'postgres://user:pw@db:5432/devplatform')
  assert.equal(env.port, 4000)
  assert.equal(env.instanceId, 'host-1')
  assert.deepEqual([...env.ingestSecrets], [GOOD_SECRET])
})

test('every required variable names itself when it is missing', () => {
  for (const name of [
    'DEVPLATFORM_DATABASE_URL',
    'IDENTITY_JWKS_URL',
    'IDENTITY_ISSUER',
    'DEVPLATFORM_INGEST_SECRETS',
    'OUTBOX_SIGNING_SECRET',
  ]) {
    const source = base()
    delete source[name]
    assert.throws(
      () => loadEnv(source),
      (err: unknown) => err instanceof EnvError && err.message.includes(name),
      `removing ${name} did not produce an error naming it`,
    )
  }
})

test('a blank value is a missing value', () => {
  assert.throws(() => loadEnv({ ...base(), DEVPLATFORM_DATABASE_URL: '   ' }), EnvError)
})

/* ------------------------------------------------------------------ placeholders */

test('a known placeholder does not boot', () => {
  // `.env.example` ships CHANGE_ME, and CHANGE_ME must not start. A default secret in source is not
  // convenient, it is catastrophic, and a placeholder that boots is a placeholder that reaches
  // production.
  //
  // `SecretError` rather than this file's `EnvError`: the class says a value failed the SHAPE check
  // rather than this file's own parsing, and `fatalConfig` reads `err.message` off `unknown`, so
  // the boot line an operator sees is identical either way.
  for (const placeholder of ['CHANGE_ME', 'change-me', 'changeme', 'secret', 'placeholder']) {
    assert.throws(
      () => loadEnv({ ...base(), OUTBOX_SIGNING_SECRET: placeholder }),
      SecretError,
      `${placeholder} was accepted as a signing secret`,
    )
  }
})

test('THE UNIT IS BYTES OF KEY MATERIAL, and 24 keystrokes is not 32 bytes', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // The last line of this test used to read:
  //
  //     assert.doesNotThrow(() => loadEnv({ ...base(), OUTBOX_SIGNING_SECRET: 'x'.repeat(24) }))
  //
  // Twenty-four identical characters, asserted to BOOT. That is the whole of micro-org #142 in one
  // line: the old floor counted keystrokes, so a value with no entropy at all was not merely
  // tolerated, it was pinned by a test as correct. `x`x24 now fails on two counts — 18 decoded
  // bytes, and zero bits of entropy per character.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  assert.throws(() => loadEnv({ ...base(), OUTBOX_SIGNING_SECRET: 'hunter2' }), SecretError)
  assert.throws(() => loadEnv({ ...base(), OUTBOX_SIGNING_SECRET: 'x'.repeat(23) }), SecretError)
  assert.throws(() => loadEnv({ ...base(), OUTBOX_SIGNING_SECRET: 'x'.repeat(24) }), SecretError)
  // Long enough in characters and in bytes, and still degenerate. Entropy is what catches it.
  assert.throws(
    () => loadEnv({ ...base(), OUTBOX_SIGNING_SECRET: 'x'.repeat(64) }),
    /entropy is 0.00 bits per character/,
  )
  // And a generated value in either alphabet is accepted, so the floors do not refuse correct
  // input — a guard that occasionally rejects the right answer is a guard somebody removes.
  assert.doesNotThrow(() =>
    loadEnv({ ...base(), OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64') }),
  )
  assert.doesNotThrow(() =>
    loadEnv({ ...base(), OUTBOX_SIGNING_SECRET: randomBytes(32).toString('hex') }),
  )
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
  'ci-only-not-a-real-secret-000000000000', // the value 23 CI workflows set, this one included
  'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4', // 32 chars of base64 alphabet, and only 24 bytes
  '0'.repeat(64), // right alphabet, right length, no entropy at all
] as const

/** Names the variable, names the fix, and carries no part of the value. */
function refusalIsSafe(err: unknown, variable: string, value: string): true {
  const message = (err as Error).message
  // The reason this guard exists is that the value was readable. A message carrying it would move
  // the secret from one public place to the log collector.
  assert.ok(!message.includes(value), 'the refusal echoed the value')
  assert.match(message, new RegExp(variable))
  assert.match(message, /openssl rand -base64 48/)
  return true
}

test('THE VALUES THAT SAT IN A PUBLIC REPOSITORY ARE REFUSED, as a scalar', () => {
  for (const value of DEPLOYED_PLACEHOLDERS) {
    assert.throws(
      () => loadEnv({ ...base(), OUTBOX_SIGNING_SECRET: value }),
      (err: unknown) => refusalIsSafe(err, 'OUTBOX_SIGNING_SECRET', value),
      `${value.slice(0, 6)}… was accepted as OUTBOX_SIGNING_SECRET`,
    )
  }
})

test('THE SAME BAR ON A LIST ENTRY — a rotation window is not a place the rule relaxes', () => {
  // The OUTGOING key is the one an attacker already holds if it leaked, so "just for the drain" is
  // exactly how a placeholder survives the rotation that was supposed to remove it. Second position
  // on purpose: the first entry being genuine must not vouch for the rest.
  for (const value of DEPLOYED_PLACEHOLDERS) {
    assert.throws(
      () => loadEnv({ ...base(), DEVPLATFORM_INGEST_SECRETS: `${GOOD_SECRET},${value}` }),
      (err: unknown) => {
        assert.ok(
          !(err as Error).message.includes(GOOD_SECRET),
          'the refusal echoed the good key beside it',
        )
        return refusalIsSafe(err, 'DEVPLATFORM_INGEST_SECRETS', value)
      },
      `${value.slice(0, 6)}… was accepted as a DEVPLATFORM_INGEST_SECRETS entry`,
    )
  }
})

/* ------------------------------------------------------------------ the secret list */

test('the ingest secret list accepts several, so rotation has an overlap window', () => {
  const env = loadEnv({ ...base(), DEVPLATFORM_INGEST_SECRETS: `${GOOD_SECRET}, ${SECOND_SECRET}` })
  assert.deepEqual([...env.ingestSecrets], [GOOD_SECRET, SECOND_SECRET])
})

test('the ingest secret list refuses a duplicate', () => {
  // A duplicated secret makes "which key verified this" ambiguous, and that answer is what tells an
  // operator whether a rotation has finished.
  assert.throws(
    () => parseSecretList(`${GOOD_SECRET},${GOOD_SECRET}`, 'X'),
    (err: unknown) => err instanceof EnvError && err.message.includes('twice'),
  )
})

test('the ingest secret list refuses an empty list, a placeholder and a short entry', () => {
  // An empty list stays this file's own refusal, so the message names the service's variable.
  assert.throws(() => parseSecretList('', 'X'), EnvError)
  assert.throws(() => parseSecretList(' , , ', 'X'), EnvError)
  // The entries themselves are the shape check's business now.
  assert.throws(() => parseSecretList(`${GOOD_SECRET},changeme`, 'X'), SecretError)
  assert.throws(() => parseSecretList(`${GOOD_SECRET},short`, 'X'), /bytes of key material/)
})

test('the ingest secret list is frozen', () => {
  const secrets = parseSecretList(GOOD_SECRET, 'X')
  assert.throws(() => {
    ;(secrets as string[]).push('another')
  })
})

/* ------------------------------------------------------------------ numbers */

test('a non-integer or out-of-range number is refused, naming the variable', () => {
  for (const [name, value] of [
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', 'four thousand'],
    ['DEVPLATFORM_DATABASE_POOL_MAX', '0'],
    ['DEVPLATFORM_DEFAULT_QUOTA_PER_MINUTE', '0'],
    ['DEVPLATFORM_WEBHOOK_DEADLINE_MS', '10'],
    ['DEVPLATFORM_WEBHOOK_MAX_ATTEMPTS', '0'],
  ] as const) {
    assert.throws(
      () => loadEnv({ ...base(), [name]: value }),
      (err: unknown) => err instanceof EnvError && err.message.includes(name),
      `${name}=${value} was accepted`,
    )
  }
})

test('a quota of zero is not expressible', () => {
  // Zero is a project that cannot make a request, which is a suspension — and a suspension is a
  // status on the organisation, not a limit on a meter.
  assert.throws(() => loadEnv({ ...base(), DEVPLATFORM_DEFAULT_QUOTA_PER_MINUTE: '0' }), EnvError)
  assert.throws(() => loadEnv({ ...base(), DEVPLATFORM_DEFAULT_QUOTA_PER_MONTH: '0' }), EnvError)
})

test('a rollup must outlive the events it summarises', () => {
  assert.throws(
    () =>
      loadEnv({
        ...base(),
        DEVPLATFORM_USAGE_EVENT_RETENTION_DAYS: '90',
        DEVPLATFORM_USAGE_ROLLUP_RETENTION_DAYS: '30',
      }),
    (err: unknown) => err instanceof EnvError && err.message.includes('outlives'),
  )
  assert.doesNotThrow(() =>
    loadEnv({
      ...base(),
      DEVPLATFORM_USAGE_EVENT_RETENTION_DAYS: '30',
      DEVPLATFORM_USAGE_ROLLUP_RETENTION_DAYS: '30',
    }),
  )
})

test('LOG_LEVEL is one of four, and says so', () => {
  for (const level of ['debug', 'info', 'warn', 'error']) {
    assert.equal(loadEnv({ ...base(), LOG_LEVEL: level }).logLevel, level)
  }
  assert.throws(
    () => loadEnv({ ...base(), LOG_LEVEL: 'verbose' }),
    (err: unknown) => err instanceof EnvError && err.message.includes('LOG_LEVEL'),
  )
})

test('the defaults are the ones the README and .env.example state', () => {
  const env = loadEnv(base())
  assert.equal(env.defaultQuotaPerMinute, 600)
  assert.equal(env.defaultQuotaPerMonth, 1_000_000)
  assert.equal(env.webhookRotationOverlapMinutes, 1_440)
  assert.equal(env.webhookMaxAttempts, 8)
  assert.equal(env.usageEventRetentionDays, 35)
  assert.equal(env.usageRollupRetentionDays, 400)
})

/* ------------------------------------------------------------------ .env.example */

/*
 * ── WAVE M5a: THE FILE THIS READS IS THE MERGED REPOSITORY'S ROOT ONE ─────────────────────────
 *
 * micro-deploy `docs/service-merge-plan.md`. `../.env.example` was this service's own; it is now
 * `../../.env.example`, at the root of the process that runs five modules, and it declares all
 * five modules' variables because the deploy manifest is written from it — rule 9 of
 * docs/ecosystem/03 §2, which is a property of the DEPLOYABLE and the deployable is now one image.
 *
 * The second direction had to change with it, and it got STRONGER rather than weaker. It used to
 * be "every declared variable is read by THIS env.ts", which in a five-module file would fail on
 * the other four modules' variables. It is now "every declared variable is read by SOME module's
 * env.ts", checked against all five sources — so a variable nobody anywhere reads is still caught,
 * and it is now caught for four services that never had this check at all.
 *
 * It stays in THIS module's suite rather than moving to the host's, because this is the module
 * that brought the check and the module whose `DEVPLATFORM_INGEST_SECRETS` is the one secret in
 * the merged file that no other module could have declared for it.
 */
const ENV_SOURCES = [
  '../env.ts',
  './env.ts',
  '../policy/env.ts',
  '../pricing/env.ts',
  '../studio/env.ts',
  // Wave M5b: the commerce/games tier. The merged `.env.example` declares every variable ALL
  // TWELVE modules read, so the reverse direction ("declared, but read by nobody") must scrape all
  // twelve or it would accuse every new module's variables of being dead.
  '../community/env.ts',
  '../market/env.ts',
  '../billing/env.ts',
  '../mint/env.ts',
  '../foresight/env.ts',
  '../worlds/env.ts',
  '../tessera/env.ts',
  // Wave M5c: the telemetry and bus-tail tier. FOUR more `env.ts` files on TWO absorbed
  // repositories, because activity and lantern each brought a nested module — and the nested two
  // are two directories deep, which is the only way this list differs in shape from the twelve
  // above. Sixteen now, and `.env.example` declares what all sixteen read.
  '../activity/env.ts',
  '../activity/notify/env.ts',
  '../lantern/env.ts',
  '../lantern/analytics/env.ts',
] as const

/**
 * Declared for the process, read by no `env.ts`, and legitimately so.
 *
 * `OTEL_*` is read by the OpenTelemetry SDK loaded ahead of the process
 * (`NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register`), never by a module.
 * It is in the file because the deploy manifest is written from the file. An explicit list rather
 * than a prefix skip, so adding a second such variable is a deliberate edit here.
 */
const NOT_READ_BY_ANY_ENV: ReadonlySet<string> = new Set(['OTEL_EXPORTER_OTLP_ENDPOINT'])

test('.env.example declares every variable this service reads, with no real secret', () => {
  const example = readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8')
  const source = readFileSync(fileURLToPath(new URL('./env.ts', import.meta.url)), 'utf8')

  // Every variable read by `loadEnv`, taken from the source rather than a list — a list drifts.
  const read = new Set(
    [...source.matchAll(/source,\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1] as string),
  )
  assert.ok(read.size >= 10, `expected many variables, found ${read.size}`)

  // The same scrape over all five modules, for the other direction. Both forms, because policy
  // reads two of its variables through `source['NAME']` rather than a helper — and a regex that
  // only understood the helper would silently under-report, which is indistinguishable from
  // passing.
  const readAnywhere = new Set<string>()
  for (const relative of ENV_SOURCES) {
    const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    for (const m of text.matchAll(/source,\s*'([A-Z][A-Z0-9_]*)'/g)) readAnywhere.add(m[1] as string)
    for (const m of text.matchAll(/source\['([A-Z][A-Z0-9_]*)'\]/g)) readAnywhere.add(m[1] as string)
    // A THIRD form, and it is a real read rather than an exemption. analytics reads its pepper
    // through named constants — `source[LEGACY_PEPPER]` and `` source[`${PEPPER_PREFIX}${n}`] ``,
    // because the variable is VERSIONED (`ANALYTICS_PSEUDONYM_KEY_V2`, …) and the version is not
    // known until the environment is scanned. A scrape that could not see that form would report
    // `ANALYTICS_PSEUDONYM_KEY` as declared-but-unread and invite somebody to delete it from
    // `.env.example` — the one variable in this estate whose absence is unrecoverable, because a
    // pepper cannot be rotated without orphaning every subject key derived under it.
    //
    // Widened rather than exempted, deliberately: an exemption would stop checking the variable,
    // and this keeps checking it.
    for (const m of text.matchAll(/^const ([A-Z][A-Z0-9_]*) = '([A-Z][A-Z0-9_]*)'/gm)) {
      // Only when the constant is used to index `source` WHOLE. `PEPPER_PREFIX` is spelled the same
      // way but is used as `` source[`${PEPPER_PREFIX}${n}`] `` — it is half a name, not a variable,
      // and adding it would have this scrape demand `ANALYTICS_PSEUDONYM_KEY_V` in `.env.example`.
      if (text.includes(`source[${m[1] as string}]`)) readAnywhere.add(m[2] as string)
    }
  }
  assert.ok(
    readAnywhere.size > read.size,
    `the five-module scrape found ${readAnywhere.size} variables, no more than this module's ${read.size} — ` +
      'a path is wrong and the second direction below would be vacuous',
  )

  const declared = new Set(
    example
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split('=')[0]?.trim() ?? ''),
  )
  for (const name of read) {
    assert.ok(declared.has(name), `.env.example does not declare ${name}`)
  }
  for (const name of declared) {
    assert.ok(
      readAnywhere.has(name) || NOT_READ_BY_ANY_ENV.has(name),
      `.env.example declares ${name}, which no module's env.ts reads`,
    )
  }
  for (const name of readAnywhere) {
    assert.ok(declared.has(name), `.env.example does not declare ${name}, which a module reads`)
  }

  // And nothing in it is a working secret. Every secret slot is a placeholder that does not boot.
  // Matched on the variable NAME ending in _SECRET/_SECRETS rather than on the line containing the
  // word: `DEVPLATFORM_WEBHOOK_ROTATION_OVERLAP_MINUTES` is a duration, and a check that demanded a
  // placeholder there would be a check somebody deletes.
  //
  // ── WAVE M5a WIDENED THIS TO ACCEPT AN EMPTY VALUE, AND THAT IS NOT A RELAXATION ────────────
  //
  // Two repositories with two conventions met here: this module's file wrote `CHANGE_ME` in every
  // secret slot, and the host's writes NOTHING in any of them, on the stated ground that a secret
  // whose whole job is to live outside the repository does not belong in a file people copy.
  //
  // An EMPTY value is the stronger of the two, not the weaker: `assertGeneratedSecret` refuses
  // both, so neither boots, but an empty slot cannot be mistaken for a value somebody meant, and
  // it cannot be copied into a deploy and left. What this case exists to catch is a WORKING secret
  // in the file, and both spellings are equally not one. The count floor below is what keeps the
  // loop honest — a regex that stopped matching would otherwise pass by checking nothing.
  let checked = 0
  for (const line of example.split('\n')) {
    if (line.trim().startsWith('#')) continue
    const name = line.split('=')[0]?.trim() ?? ''
    if (!/_SECRETS?$/.test(name)) continue
    checked += 1
    const value = line.split('=').slice(1).join('=').trim()
    assert.ok(
      value === '' || value.startsWith('CHANGE_ME'),
      `${name} carries something that is neither empty nor a CHANGE_ME placeholder`,
    )
  }
  assert.ok(checked >= 3, `expected to check at least three secret slots, checked ${checked}`)
})
