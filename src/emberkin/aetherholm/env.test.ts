// env.ts validation — a missing required variable and a placeholder secret both refuse to boot,
// naming themselves. No database needed.
//
// A valid environment is applied to the process BEFORE `./env.ts` is imported: env.ts validates
// eagerly and calls process.exit(1) on a bad configuration, so the dynamic import below is itself
// a test that these values suffice. loadEnv is otherwise pure over its source.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

const BASE: Record<string, string> = {
  AETHERHOLM_DATABASE_URL: 'postgres://aetherholm:aetherholm@127.0.0.1:5432/aetherholm',
  IDENTITY_JWKS_URL: 'http://id/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://id',
  // GENERATED, never written. The boot guard refuses a typed value, and the former fixture here —
  // `a-real-secret-of-sufficient-length-000` — is precisely the kind of string that claimed to be
  // a secret and was not. A fixture exempt from the rule it exercises is how the placeholder in
  // micro-org #142 survived every test in the estate.
  OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
};
for (const [key, value] of Object.entries(BASE)) process.env[key] = value;

const { EnvError, loadEnv } = await import('./env.ts');

test('env: a valid environment loads, and the port defaults to 4120', () => {
  const env = loadEnv(BASE, 'host-1');
  // 4120 is the port the registry row and .env.example both state; this is the coded default the
  // estate CI compares .env.example against.
  assert.equal(env.port, 4120);
  assert.equal(env.databaseUrl, BASE['AETHERHOLM_DATABASE_URL']);
  assert.equal(env.instanceId, 'host-1');
});

test('env: a missing required variable names itself', () => {
  const missing = { ...BASE } as Record<string, string | undefined>;
  delete missing['AETHERHOLM_DATABASE_URL'];
  assert.throws(
    () => loadEnv(missing),
    (err) => err instanceof EnvError && /AETHERHOLM_DATABASE_URL/.test(err.message),
  );
});

test('env: a CHANGE_ME placeholder secret is refused', () => {
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'CHANGE_ME' }),
    (err) => err instanceof EnvError && /placeholder/.test(err.message),
  );
});

test('env: a short secret is refused — and the unit is DECODED BYTES, not keystrokes', () => {
  // 'short' is five characters, and the old guard would have said "at least 24 characters". The
  // guard now counts what an HMAC key is measured in: 32 characters of prose is not 32 bytes.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'short' }),
    (err) => err instanceof EnvError && /bytes of key material/.test(err.message),
  );
});

test('THE VALUE THAT SAT IN A PUBLIC REPOSITORY IS REFUSED, and every near miss with it', () => {
  // micro-org #142. Each of these cleared the old guard — a deny-list of exact strings plus a
  // 24-character floor — and each is a real string that was deployed or set in CI, not an invented
  // one. If a future edit weakens the floor, it fails against evidence rather than against taste.
  for (const value of [
    'estate-only-outbox-secret-00000000000000', // 54 lines of a PUBLIC compose file, 40 chars
    'ci-only-not-a-real-secret-000000000000', // this repository's own CI, in two places
    'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4', // 32 chars, 24 bytes: right alphabet, too little key
    '0'.repeat(64), // right alphabet, right length, no entropy
  ]) {
    // Both call sites: the scalar, and every entry of the rotation list.
    for (const source of [
      { ...BASE, OUTBOX_SIGNING_SECRET: value },
      { ...BASE, OUTBOX_ACCEPT_SECRETS: `${BASE['OUTBOX_SIGNING_SECRET']},${value}` },
    ]) {
      assert.throws(
        () => loadEnv(source),
        (err: unknown) => {
          // The refusal must not echo the value: the reason this guard exists is that the value
          // was readable, and a message carrying it moves the secret to the log collector.
          const message = (err as Error).message;
          assert.ok(!message.includes(value), 'the refusal echoed the value');
          assert.match(message, /OUTBOX_(SIGNING_SECRET|ACCEPT_SECRETS)/);
          assert.match(message, /openssl rand -base64 48/);
          // Re-wrapped into this file's own class, so `loadEnv` still raises exactly one thing.
          return err instanceof EnvError;
        },
      );
    }
  }
});

test('env: the event accept list defaults to the signing secret, and takes a rotation pair', () => {
  // Unset means "accept what we sign with", so shipping the inbound webhook is a no-op for a
  // deploy that has never rotated — which is what makes rotating it later service-by-service.
  assert.deepEqual(loadEnv(BASE).acceptSecrets, [BASE['OUTBOX_SIGNING_SECRET']]);

  const incoming = randomBytes(48).toString('base64');
  const rotating = loadEnv({
    ...BASE,
    OUTBOX_ACCEPT_SECRETS: `${incoming}, ${BASE['OUTBOX_SIGNING_SECRET']}`,
  });
  assert.deepEqual(rotating.acceptSecrets, [incoming, BASE['OUTBOX_SIGNING_SECRET']]);
});

test('env: one weak secret in the accept list is still a weak secret', () => {
  // An overlap window is where a filler gets in: the OUTGOING key is the one an attacker already
  // holds if it leaked, so "just for the drain" is not a reason to relax the bar for an entry.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${BASE['OUTBOX_SIGNING_SECRET']},changeme` }),
    (err) => err instanceof EnvError && /placeholder/.test(err.message),
  );
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${BASE['OUTBOX_SIGNING_SECRET']},short` }),
    EnvError,
  );
  // A list that lists nothing is a webhook nothing can authenticate.
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: ' , ' }), /at least one secret/);
});

test('env: what the estate actually runs is accepted, in either alphabet', () => {
  assert.doesNotThrow(() =>
    loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64') }),
  );
  assert.doesNotThrow(() =>
    loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(32).toString('hex') }),
  );
});

test('env: a nonsense port is refused rather than truncated', () => {
  assert.throws(() => loadEnv({ ...BASE, PORT: '99999999' }), EnvError);
  assert.throws(() => loadEnv({ ...BASE, PORT: 'not-a-port' }), EnvError);
});

test('env: an unknown log level is refused', () => {
  assert.throws(() => loadEnv({ ...BASE, LOG_LEVEL: 'loud' }), EnvError);
});
