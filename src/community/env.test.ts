/**
 * Configuration, and the variables that deliberately do not exist.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`.env.example` AND `env.ts` ARE ASSERTED TO AGREE IN BOTH DIRECTIONS.**
 *
 * Rule 9 of docs/ecosystem/03 §2: a repository declares the variables it needs and the deploy
 * provides exactly those. A variable in `.env.example` that nothing reads fails this suite just as
 * loudly as one that is read and not declared — the first is a value an operator will set and be
 * puzzled by, the second is a service that will not boot with a correct-looking file.
 *
 * **AND THE ABSENCES ARE ASSERTED BY NAME.** There is no break-glass credential and — the one that
 * matters here — no variable that can shorten or bypass a timelock. A deploy that could lower a
 * governance guarantee is a deploy that can spend a community's treasury on somebody's say-so, and
 * the whole of AD-15 is that no single party can do that.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { SecretError } from '@cloudsforge/secrets'

const ENV_SOURCE = readFileSync(fileURLToPath(new URL('./env.ts', import.meta.url)), 'utf8')
// Wave M5b: community's `.env.example` travels WITH the module into `src/community/.env.example`,
// so this suite keeps checking community's own file in both directions — its defaults, its secret
// slots, its vocabulary. The merged repository's ROOT `.env.example` (the file the deploy manifest
// is written from, declaring all twelve modules' variables) is checked separately, and against all
// twelve `env.ts` sources, by `src/devplatform/env.test.ts`.
const EXAMPLE = readFileSync(fileURLToPath(new URL('./.env.example', import.meta.url)), 'utf8')

/** Generated per call, never committed. See the note on `base()` below. */
function generated(): string {
  return randomBytes(48).toString('base64')
}

/**
 * A service credential, and **THIS FIXTURE CONTAINS HYPHENS ON PURPOSE** — that is the most
 * important thing about it. Fabricated: identity's shape, none of its entropy, and never a value out
 * of `deploy/compose/estate/tokens.env`.
 *
 * A credential body is base64**url**, so `-` and `_` are in its alphabet. Measured live on both
 * estates: the mainnet credential is alphanumeric and the testnet one CONTAINS A HYPHEN. So a
 * "secrets have no hyphens" rule — which is exactly right for `OUTBOX_SIGNING_SECRET` below, and
 * which every placeholder this estate ever wrote would have failed — passes mainnet and kills
 * testnet at boot. Keeping a hyphenated credential here means that mistake fails CI instead of
 * failing one estate in production. Do not "tidy" the hyphens out of this value.
 * (`admin-api/src/env.test.ts` carries the same fixture for the same reason.)
 */
const CREDENTIAL = 'cfsc_TToR-eOeVTDnqhX1-nu6-u7DoCr4MCfa86g4g6kd404'

/**
 * A well-formed 600-second SERVICE TOKEN. Not a credential, and the difference is micro-org #222.
 *
 * Header and payload are real base64url JSON; the signature is fabricated, because nothing here
 * verifies it — `assertServiceCredential` refuses this on SHAPE, at boot, before anything could.
 * This is the family of value that `COMMUNITY_SERVICE_CREDENTIAL` actually held on the live estate,
 * where it had been expired for 26 hours on a container reporting healthy.
 */
const STATIC_TOKEN =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.' +
  'eyJzdWIiOiJzZXJ2aWNlOmNvbW11bml0eSIsInR5cCI6InNlcnZpY2UiLCJleHAiOjE3NTQ0MDAwMDB9.' +
  'c2lnbmF0dXJlLXdoaWNoLW5vdGhpbmctaGVyZS12ZXJpZmllcw'

/**
 * A configuration that boots. Every test starts from this and removes or corrupts one field.
 *
 * The two outbox-family values are GENERATED rather than written. They used to be `'a'.repeat(32)`
 * and `'b'.repeat(32)` — long enough for the old 24-character floor, on no deny-list, and carrying
 * no entropy whatsoever, which is exactly the shape of the value that sat on 54 lines of a PUBLIC
 * compose file and passed every guard in the estate (micro-org #142). A fixture exempt from the
 * rule it exercises is how that survived every test in the estate.
 *
 * **NEITHER CREDENTIAL IS IN HERE, AND THAT IS THE POINT OF THE FIX.** `base()` is the set of
 * variables without which this service refuses to start, and the credential is no longer one of
 * them: absence is a supported mode (`migrator.ts` shares this environment and dials nobody, and
 * compose interpolates an unset `${COMMUNITY_IDENTITY_CREDENTIAL:-}` to the empty string). The old
 * fixture here was `'cccccccccccccccccccccccccccccccc'` — 32 characters of one letter, past the
 * 24-character floor, on no deny-list. It was the shape of the guard it was exercising, and that
 * guard was the one letting a dead JWT into three upstream clients.
 */
function base(): Record<string, string> {
  return {
    COMMUNITY_DATABASE_URL: 'postgres://community:pw@postgres:5432/community',
    IDENTITY_JWKS_URL: 'http://identity:4000/.well-known/jwks.json',
    IDENTITY_ISSUER: 'http://identity:4000',
    COMMUNITY_INGEST_SECRETS: generated(),
    OUTBOX_SIGNING_SECRET: generated(),
    LEDGER_BASE_URL: 'http://ledger:4000',
    POLICY_BASE_URL: 'http://policy:4000',
  }
}

// `env.ts` validates `process.env` at IMPORT and exits the process on a bad configuration — right
// for a service, fatal for a test runner. So populate a valid environment first, then import it
// dynamically. `loadEnv` itself is pure over its source, so every case below passes an explicit
// object and never touches `process.env`. The estate's pattern; `lantern/src/env.test.ts` and
// `devplatform/src/env.test.ts` are the siblings that document it.
for (const [key, value] of Object.entries(base())) process.env[key] = value
const { EnvError, SERVICE, loadEnv, parseSecretList } = await import('./env.ts')
const { TEST_DSN_VAR } = await import('./testsupport.ts')

/* ------------------------------------------------------------------ both directions */

/** Every `NAME=` on a non-comment line of `.env.example`. */
function declaredInExample(): Set<string> {
  const names = new Set<string>()
  for (const line of EXAMPLE.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(trimmed)
    if (match?.[1]) names.add(match[1])
  }
  return names
}

/** Every `source['NAME']` and `required(source, 'NAME')` in `env.ts`. */
function readInSource(): Set<string> {
  const names = new Set<string>()
  for (const match of ENV_SOURCE.matchAll(/(?:source, |source\[)'([A-Z][A-Z0-9_]*)'/g)) {
    if (match[1]) names.add(match[1])
  }
  return names
}

test('every variable env.ts reads is declared in .env.example', () => {
  const missing = [...readInSource()].filter((name) => !declaredInExample().has(name))
  assert.deepEqual(missing, [], `read by env.ts and absent from .env.example: ${missing.join(', ')}`)
})

test('every variable .env.example declares is read by env.ts', () => {
  const unread = [...declaredInExample()].filter((name) => !readInSource().has(name))
  assert.deepEqual(unread, [], `declared in .env.example and read by nothing: ${unread.join(', ')}`)
})

test('the checker sees the variables at all', () => {
  // An empty set passes both tests above vacuously. This is the line that stops that.
  assert.ok(declaredInExample().size >= 15, `only ${declaredInExample().size} variables found in .env.example`)
  assert.ok(readInSource().size >= 15)
})

/* ------------------------------------------------------------------ what does not exist */

test('there is no variable that can shorten or bypass a timelock', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // The absence that matters most in this repository. A deploy that could lower a governance
  // guarantee is a deploy that can spend a community's treasury on somebody's say-so.
  //
  // The floor lives in `proposals.ts` as `MIN_SPEND_TIMELOCK_MINUTES`; the timelock itself is a
  // column on the proposal and a BEFORE INSERT trigger on `executions`. Nothing in the environment
  // touches either.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const forbidden = [/TIMELOCK/i, /SKIP_/i, /BYPASS/i, /OVERRIDE/i, /DISABLE/i, /FORCE/i]
  for (const name of [...declaredInExample(), ...readInSource()]) {
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(name),
        `${name} matches ${pattern} — a governance guarantee a deploy can lower is not a guarantee`,
      )
    }
  }
})

test('there is no break-glass credential', () => {
  // The equivalent here would be a static string that can execute a spend, which is the shape of
  // the omnipotent service tokens SD-05 exists to retire.
  for (const name of ['COMMUNITY_ADMIN_TOKEN', 'COMMUNITY_ADMIN_SECRET', 'ADMIN_TOKEN']) {
    assert.ok(!declaredInExample().has(name), `${name} is declared in .env.example`)
    assert.ok(!readInSource().has(name), `${name} is read by env.ts`)
  }
})

test('no variable name would trip the estate secret-hygiene guard on a non-secret', () => {
  // 18-build-status: `secret-hygiene` reads any `*SECRET*|*TOKEN*|*KEY*` variable carrying a value
  // as a credential somebody pasted in and forgot. That check is right, so a DURATION or a URL must
  // not be named after one — `micro-devplatform` renamed a variable rather than relax the guard,
  // and `COMMUNITY_SERVICE_CREDENTIAL` is named the way it is for the same reason.
  const secretish = /SECRET|TOKEN|KEY/
  const genuineSecrets = new Set(['COMMUNITY_INGEST_SECRETS', 'OUTBOX_SIGNING_SECRET'])
  for (const name of declaredInExample()) {
    if (!secretish.test(name)) continue
    assert.ok(
      genuineSecrets.has(name),
      `${name} is named like a secret but is not one — rename it rather than weaken the guard`,
    )
  }
})

test('the test DSN variable is spelled exactly as the workflow derives it', () => {
  // `service-ci.yml` substitutes `_DATABASE_URL` → `_TEST_DATABASE_URL` on the declared variable
  // and then GREPS the output for a skip. A different spelling reads no DSN, skips silently, and
  // turns that guard into the exact false-green it exists to prevent.
  assert.equal(TEST_DSN_VAR, 'COMMUNITY_TEST_DATABASE_URL')
  assert.equal(SERVICE, 'community')
  // Derived from the declared variable, which is what the workflow input names.
  assert.equal(TEST_DSN_VAR, 'COMMUNITY_DATABASE_URL'.replace('_DATABASE_URL', '_TEST_DATABASE_URL'))
})

/* ------------------------------------------------------------------ placeholders */

test('CHANGE_ME does not boot', () => {
  // A default secret in source is not convenient, it is catastrophic, and a placeholder that boots
  // is a placeholder that reaches production.
  //
  // Every one of these now raises `SecretError` rather than this file's own `EnvError`, and the
  // class is distinct on purpose: it says a value failed the SHAPE check rather than this file's
  // parsing. `fatalConfig` reads `err.message` off `unknown`, so the boot line an operator sees is
  // identical either way.
  for (const name of ['COMMUNITY_IDENTITY_CREDENTIAL', 'COMMUNITY_SERVICE_CREDENTIAL']) {
    assert.throws(() => loadEnv({ ...base(), [name]: 'CHANGE_ME' }), SecretError)
    assert.throws(() => loadEnv({ ...base(), [name]: 'changeme' }), SecretError)
    assert.throws(() => loadEnv({ ...base(), [name]: 'short' }), SecretError)
    // And the prefix alone is not a credential: `cfsc_` on a placeholder body is refused too, which
    // is the hole a CI workflow in this estate was once written against.
    assert.throws(() => loadEnv({ ...base(), [name]: 'cfsc_ci-only-not-a-real-credential' }), SecretError)
  }

  for (const name of ['OUTBOX_SIGNING_SECRET', 'COMMUNITY_INGEST_SECRETS']) {
    assert.throws(() => loadEnv({ ...base(), [name]: 'CHANGE_ME' }), SecretError)
    assert.throws(() => loadEnv({ ...base(), [name]: 'changeme' }), SecretError)
    // And short is refused in BYTES of key material, not in keystrokes.
    assert.throws(() => loadEnv({ ...base(), [name]: 'short' }), /bytes of key material/)
  }
})

test('.env.example ships CHANGE_ME placeholders and no real values', () => {
  for (const line of EXAMPLE.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (!match) continue
    const [, name = '', value = ''] = match
    if (!/SECRET|CREDENTIAL/.test(name)) continue
    // EMPTY is allowed, and only for a variable whose absence is a supported mode. The property this
    // test defends is "no real value is committed here", and an empty string cannot be one; a
    // `CHANGE_ME` on a variable an operator is meant to LEAVE UNSET would be an instruction to set
    // it, which is how a vestigial variable outlives the thing it was a bridge to.
    if (value === '') continue
    assert.match(value, /CHANGE_ME/, `${name} in .env.example does not look like a placeholder`)
  }
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * micro-org #222. THE TEN-MINUTE CLIFF, refused at boot rather than discovered at minute ten.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('A SERVICE TOKEN PASTED INTO EITHER CREDENTIAL IS REFUSED BY NAME', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // This is the whole of #222 for this file. The value that was live in
  // `COMMUNITY_SERVICE_CREDENTIAL` on 2026-08-05 was a JWT that had been expired for 26 hours, on a
  // container reporting healthy — and the guard it faced was a deny-list of nine exact strings plus
  // a 24-character floor, which a several-hundred-character `ey…` clears without effort.
  //
  // A token cannot renew itself. Ten minutes after the boot that read it, policy answers 401,
  // `policyclient.ts` reads that 4xx as policy DECIDING, and every treasury spend comes back
  // `deny`/`policy_401` — swallowed by `jobs.ts` as an answer. So the refusal must happen
  // HERE, at boot, with the variable named.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  for (const name of ['COMMUNITY_IDENTITY_CREDENTIAL', 'COMMUNITY_SERVICE_CREDENTIAL']) {
    assert.throws(
      () => loadEnv({ ...base(), [name]: STATIC_TOKEN }),
      (err: unknown) => {
        const message = (err as Error).message
        assert.ok(err instanceof SecretError)
        assert.match(message, new RegExp(name), 'the refusal does not name the variable')
        assert.match(message, /TOKEN, not a credential/, 'the refusal does not name the confusion')
        assert.match(message, /ten-minute/, 'the refusal does not name the ten-minute life')
        assert.ok(!message.includes(STATIC_TOKEN), 'the refusal echoed the value')
        return true
      },
      `${name} accepted a JWT — this is the defect, not a regression of it`,
    )
  }
})

test('a real credential is accepted, hyphens and all, in either variable', () => {
  // A guard that occasionally refuses correct input is a guard an operator deletes at 3am. The
  // hyphens in `CREDENTIAL` are the case that matters: see its docblock.
  const env = loadEnv({
    ...base(),
    COMMUNITY_IDENTITY_CREDENTIAL: CREDENTIAL,
    COMMUNITY_SERVICE_CREDENTIAL: CREDENTIAL,
  })
  assert.equal(env.identityCredential, CREDENTIAL)
  assert.equal(env.serviceCredential, CREDENTIAL)
})

test('an absent credential is null, and an EMPTY one is null too', () => {
  // `COMMUNITY_IDENTITY_CREDENTIAL: ${COMMUNITY_IDENTITY_CREDENTIAL:-}` in the estate compose
  // expands to the EMPTY STRING when the variable is unset, and `migrator.ts` loads this same
  // environment while dialling nobody at all. Treating empty as malformed would fail
  // `community-migrate`, which the rest of the estate waits on through
  // `service_completed_successfully` — so the empty check stays ahead of the shape check.
  const env = loadEnv(base())
  assert.equal(env.identityCredential, null)
  assert.equal(env.serviceCredential, null)
  assert.equal(loadEnv({ ...base(), COMMUNITY_IDENTITY_CREDENTIAL: '' }).identityCredential, null)
  assert.equal(loadEnv({ ...base(), COMMUNITY_IDENTITY_CREDENTIAL: '   ' }).identityCredential, null)
  assert.equal(loadEnv({ ...base(), COMMUNITY_SERVICE_CREDENTIAL: '' }).serviceCredential, null)
})

test('the exchange is dialled at IDENTITY_ISSUER unless IDENTITY_URL says otherwise', () => {
  // Derived rather than demanded, so this fix needs no new line in any deploy manifest: the issuer
  // of a token is by definition where that token came from. A deployment that exchanged against one
  // identity and trusted the JWKS of another would fail with a signature error nobody would read as
  // a configuration mistake.
  assert.equal(loadEnv(base()).identityUrl, 'http://identity:4000')
  assert.equal(
    loadEnv({ ...base(), IDENTITY_URL: 'http://identity.internal:4000' }).identityUrl,
    'http://identity.internal:4000',
  )
})

test('a missing required variable names itself', () => {
  for (const name of Object.keys(base())) {
    const source = { ...base() }
    delete source[name]
    assert.throws(
      () => loadEnv(source),
      (err: unknown) => {
        assert.ok(err instanceof EnvError)
        assert.match(err.message, new RegExp(name))
        return true
      },
      `${name} may be omitted`,
    )
  }
})

/* ------------------------------------------------------------------ the secret list */

test('the ingest secret list is a list, and refuses duplicates', () => {
  const first = generated()
  const second = generated()
  const parsed = parseSecretList(`${first},${second}`, 'X')
  assert.equal(parsed.length, 2)
  // A duplicated secret makes "which key verified this" ambiguous, and that answer is what tells an
  // operator whether a rotation has finished.
  assert.throws(() => parseSecretList(`${first},${first}`, 'X'), /same secret twice/)
  // An empty list is still this file's own refusal, so the message names the service's variable
  // rather than a generic one.
  assert.throws(() => parseSecretList('', 'X'), EnvError)
  assert.throws(() => parseSecretList(' , , ', 'X'), /at least one secret/)
  // A short entry is now measured in bytes of key material by the shape check.
  assert.throws(() => parseSecretList('short', 'X'), SecretError)
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
  const good = generated()
  for (const value of DEPLOYED_PLACEHOLDERS) {
    assert.throws(
      () => loadEnv({ ...base(), COMMUNITY_INGEST_SECRETS: `${good},${value}` }),
      (err: unknown) => {
        assert.ok(!(err as Error).message.includes(good), 'the refusal echoed the good key beside it')
        return refusalIsSafe(err, 'COMMUNITY_INGEST_SECRETS', value)
      },
      `${value.slice(0, 6)}… was accepted as a COMMUNITY_INGEST_SECRETS entry`,
    )
  }
})

test('a generated secret is accepted, in either alphabet, scalar or list', () => {
  // The floors are measured rather than guessed, so a guard that occasionally refused correct input
  // — which is a guard somebody removes — would show up here.
  assert.doesNotThrow(() =>
    loadEnv({
      ...base(),
      OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
      COMMUNITY_INGEST_SECRETS: `${randomBytes(48).toString('base64')},${randomBytes(32).toString('hex')}`,
    }),
  )
})

/* ------------------------------------------------------------------ ranges and defaults */

test('the indexer is optional, and its absence is a supported mode', () => {
  // With no URL the holdings oracle answers "unknown", and an unknown holding never demotes.
  const env = loadEnv(base())
  assert.equal(env.indexerBaseUrl, null)
  assert.equal(loadEnv({ ...base(), INDEXER_BASE_URL: '  ' }).indexerBaseUrl, null)
  assert.equal(loadEnv({ ...base(), INDEXER_BASE_URL: 'http://indexer:4000' }).indexerBaseUrl, 'http://indexer:4000')
})

test('numeric variables are bounded and integral', () => {
  for (const [name, bad] of [
    ['PORT', '0'],
    ['PORT', '70000'],
    ['COMMUNITY_DATABASE_POOL_MAX', '0'],
    ['LEDGER_DEADLINE_MS', '10'],
    ['POLICY_DEADLINE_MS', '99999'],
    ['COMMUNITY_GATE_RECHECK_INTERVAL_HOURS', '0'],
    ['COMMUNITY_IDEMPOTENCY_TTL_DAYS', '0'],
    ['COMMUNITY_GATE_RECHECK_BATCH_SIZE', '1.5'],
  ] as const) {
    assert.throws(() => loadEnv({ ...base(), [name]: bad }), EnvError, `${name}=${bad} was accepted`)
  }
})

test('the defaults are the ones documented in .env.example', () => {
  const env = loadEnv(base())
  assert.equal(env.port, 4_000)
  assert.equal(env.ledgerDeadlineMs, 5_000)
  assert.equal(env.policyDeadlineMs, 3_000)
  assert.equal(env.gateRecheckIntervalHours, 6)
  assert.equal(env.idempotencyTtlDays, 30)
  assert.equal(env.logLevel, 'info')
  // And `.env.example` agrees, so an operator copying it gets the same service.
  for (const [name, value] of [
    ['PORT', '4000'],
    ['LEDGER_DEADLINE_MS', '5000'],
    ['POLICY_DEADLINE_MS', '3000'],
    ['COMMUNITY_GATE_RECHECK_INTERVAL_HOURS', '6'],
    ['COMMUNITY_IDEMPOTENCY_TTL_DAYS', '30'],
  ] as const) {
    assert.match(EXAMPLE, new RegExp(`^${name}=${value}$`, 'm'), `.env.example disagrees about ${name}`)
  }
})

test('an unknown log level is refused', () => {
  assert.throws(() => loadEnv({ ...base(), LOG_LEVEL: 'verbose' }), EnvError)
  assert.equal(loadEnv({ ...base(), LOG_LEVEL: 'debug' }).logLevel, 'debug')
})

test('the instance id falls back to the hostname', () => {
  // Right in a container and wrong on a laptop running two copies, which is why it is settable.
  assert.equal(loadEnv(base(), 'pod-7').instanceId, 'pod-7')
  assert.equal(loadEnv({ ...base(), INSTANCE_ID: 'named' }, 'pod-7').instanceId, 'named')
})
