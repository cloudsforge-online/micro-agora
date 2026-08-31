// env.ts validation — a missing required variable and a placeholder secret both refuse to boot,
// naming themselves. No database needed.
//
// A valid environment is applied to the process BEFORE `./env.ts` is imported: env.ts validates
// eagerly and calls process.exit(1) on a bad configuration, so the dynamic import below is itself
// a test that these values suffice. loadEnv is otherwise pure over its source.

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY SECRET FIXTURE IN THIS FILE USED TO BE A PLACEHOLDER THAT THE GUARD NOW REFUSES.
 *
 * `OUTBOX_SIGNING_SECRET` was `'a-real-secret-of-sufficient-length-000'`. Strip its punctuation and
 * it reads `arealsecretofsufficientlength000` — it contains `sufficientlength`, which is on
 * `@cloudsforge/secrets`' marker list precisely because somebody wrote it here. It is 37 typed
 * characters with hyphens in it, so it is not base64, not hex, and not a key. The test suite was
 * asserting that a placeholder was a valid signing key, which is why ninety-odd green tests sat
 * over the defect in micro-org #142 without one of them going red.
 *
 * A FIXTURE EXEMPT FROM THE RULE IT EXERCISES IS NOT A FIXTURE, IT IS A HOLE. So the key material
 * below is GENERATED per run, exactly as the runbook tells an operator to generate it.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
const generatedKey = (): string => randomBytes(48).toString('base64');

/**
 * A JWT-SHAPED token fixture. Not signed and not verifiable — `env.ts` matches the shape and
 * deliberately does not decode or check `exp`; see `requiredMintedToken` for why an expiry check at
 * boot would crash-loop this service and its migrator on every restart.
 */
const MINTED_TOKEN =
  'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlbWJlcmtpbiIsImV4cCI6MH0.c2lnbmF0dXJl';

/**
 * A LONG-LIVED SERVICE CREDENTIAL, AND THIS FIXTURE CONTAINS HYPHENS ON PURPOSE.
 *
 * A credential body is base64**url**, so `-` and `_` are in its alphabet. Measured on the running
 * estates on 2026-08-07: the mainnet credential is alphanumeric and the testnet one CONTAINS A
 * HYPHEN. An alphanumeric fixture therefore passes a guard that would refuse testnet at boot, which
 * is why `env.ts` reaches for `assertServiceCredential` and never `assertGeneratedSecret` — the
 * latter's base64 alphabet rejects the hyphen. Keeping the hyphens here means that mistake fails CI
 * rather than one estate. `tessera`, `community` and `market` carry the same shaped fixture for the
 * same reason.
 */
const CREDENTIAL = 'cfsc_TToR-eOeVTDnqhX1-nu6-u7DoCr4MCfa86g4g6kd404';

/**
 * THE CREDENTIAL, NOT THE TOKEN, IS WHAT A CORRECT DEPLOYMENT SETS — so it is what the base
 * environment carries, and `EMBERKIN_SERVICE_TOKEN` is absent from it entirely.
 *
 * That absence is an assertion in itself. Every test in this file loads from `BASE`, and before
 * micro-org #228 none of them could have: the token was REQUIRED, so a base environment without one
 * threw at import. This file booting without it is the first proof that the ten-minute token is no
 * longer how this service authenticates.
 */
const BASE: Record<string, string> = {
  EMBERKIN_DATABASE_URL: 'postgres://emberkin:emberkin@127.0.0.1:5432/emberkin',
  IDENTITY_JWKS_URL: 'http://id/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://id',
  OUTBOX_SIGNING_SECRET: generatedKey(),
  LEDGER_URL: 'http://ledger',
  BILLING_URL: 'http://billing',
  WORLDS_URL: 'http://worlds',
  EMBERKIN_IDENTITY_CREDENTIAL: CREDENTIAL,
};
for (const [key, value] of Object.entries(BASE)) process.env[key] = value;

const { EnvError, loadEnv } = await import('./env.ts');

test('env: a valid environment loads', () => {
  const env = loadEnv(BASE, 'host-1');
  assert.equal(env.port, 4100);
  assert.equal(env.databaseUrl, BASE.EMBERKIN_DATABASE_URL);
  assert.equal(env.seasonRewardBudgetWei, 4_000_000_000_000_000_000_000n);
  assert.equal(env.instanceId, 'host-1');
});

test('env: a missing required variable names itself', () => {
  const missing = { ...BASE } as Record<string, string | undefined>;
  delete missing.EMBERKIN_DATABASE_URL;
  assert.throws(() => loadEnv(missing), (err) => err instanceof EnvError && /EMBERKIN_DATABASE_URL/.test(err.message));
});

test('env: a CHANGE_ME placeholder secret is refused', () => {
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'CHANGE_ME' }),
    (err) => err instanceof EnvError && /placeholder/.test(err.message),
  );
});

test('env: the service token, WHEN PRESENT, must still be a MINTED token, not a typed string', () => {
  // In `static` mode this value is still presented verbatim as a Bearer, so a non-JWT here 401s all
  // three upstreams with nothing in either log naming the cause. Making the slot OPTIONAL for
  // micro-org #228 must not weaken the shape check on a value that IS set — absence is a mode and
  // rubbish is not. The old assertion was `'short'`, which a 24-character floor caught by accident;
  // the value that mattered is the compose DEFAULT, 40 characters, on no deny-list, and it booted.
  assert.throws(() => loadEnv({ ...BASE, EMBERKIN_SERVICE_TOKEN: 'short' }), EnvError);
  assert.throws(
    () => loadEnv({ ...BASE, EMBERKIN_SERVICE_TOKEN: 'estate-placeholder-token-0000000000000000' }),
    (err: unknown) => err instanceof EnvError && /not a minted service token/.test(err.message),
  );
  // A `cfsc_` credential is the OTHER wrong answer, and the tempting one: the estate mints
  // `EMBERKIN_IDENTITY_CREDENTIAL` and it sits in tokens.env looking like it belongs here.
  assert.throws(
    () => loadEnv({ ...BASE, EMBERKIN_SERVICE_TOKEN: CREDENTIAL }),
    (err: unknown) => err instanceof EnvError && /not a minted service token/.test(err.message),
  );
  assert.equal(loadEnv({ ...BASE, EMBERKIN_SERVICE_TOKEN: MINTED_TOKEN }).serviceToken, MINTED_TOKEN);
});

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * micro-org #228 — the credential this service exchanges, and the token it used to hold forever.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('#228: the base environment carries a CREDENTIAL and no token, and it boots', () => {
  // The shape of the fix, stated as configuration. Before this change `EMBERKIN_SERVICE_TOKEN` was
  // required, so this exact environment refused to start; now it is the RECOMMENDED one and the
  // token is what is absent. `upstreams.ts` reads these two fields to pick its mode.
  const env = loadEnv(BASE);
  assert.equal(env.identityCredential, CREDENTIAL);
  assert.equal(env.serviceToken, null);
  // The fixture must keep its hyphens, or it stops exercising the base64url alphabet at all.
  assert.ok(CREDENTIAL.slice('cfsc_'.length).includes('-'), 'the credential fixture lost its hyphens');
});

test('#228: a TOKEN in the credential slot is refused, by name, at the door', () => {
  // The mirror image of the test above it, and the whole defect read backwards. A container handed
  // a ten-minute JWT here would exchange nothing, work for ten minutes and fail exactly as before —
  // so the two slots refuse each other's value rather than quietly accepting it. The refusal must
  // not quote the value: a boot log is shipped to a collector.
  assert.throws(
    () => loadEnv({ ...BASE, EMBERKIN_IDENTITY_CREDENTIAL: MINTED_TOKEN }),
    (err: unknown) =>
      err instanceof Error &&
      /EMBERKIN_IDENTITY_CREDENTIAL/.test(err.message) &&
      /TOKEN, not a credential/.test(err.message) &&
      !err.message.includes(MINTED_TOKEN),
  );
});

test('#228: the credential faces the shape rules, and BYTES is the unit', () => {
  assert.throws(() => loadEnv({ ...BASE, EMBERKIN_IDENTITY_CREDENTIAL: 'changeme' }), Error);
  // The prefix alone is not a credential. Markers are checked on the BODY, after `cfsc_` is
  // stripped, or `cfsc_` would launder every placeholder somebody prefixes with it.
  assert.throws(() => loadEnv({ ...BASE, EMBERKIN_IDENTITY_CREDENTIAL: 'cfsc_ci-only-not-a-real-credential' }), Error);
  // `cfsc_` plus 32 keystrokes is 24 bytes of base64url, under the floor. Keystrokes were never
  // the unit — the same lesson micro-org #212 taught about the signing key.
  assert.throws(
    () => loadEnv({ ...BASE, EMBERKIN_IDENTITY_CREDENTIAL: `cfsc_${'a'.repeat(32)}` }),
    (err: unknown) => err instanceof Error && !err.message.includes('a'.repeat(32)),
  );
});

test('#228: an EMPTY credential is an ABSENT one, and the pair is what is required', () => {
  // Compose interpolates `EMBERKIN_IDENTITY_CREDENTIAL: ${EMBERKIN_IDENTITY_CREDENTIAL:-}`, so an
  // unset variable arrives as the EMPTY STRING rather than as absent. If empty read as present,
  // `upstreams.ts` would pick `exchanged` and post an empty bearer to identity forever.
  for (const blank of ['', '   ']) {
    const source = { ...BASE, EMBERKIN_IDENTITY_CREDENTIAL: blank, EMBERKIN_SERVICE_TOKEN: MINTED_TOKEN };
    assert.equal(loadEnv(source).identityCredential, null);
    assert.equal(loadEnv(source).serviceToken, MINTED_TOKEN);
  }
  // NEITHER is the case that must not boot. Both slots are individually optional now, and without
  // this check dropping the token to optional would have quietly turned "refuses to start" into
  // "starts and answers 503 at every route that touches a peer". It also pins the deploy ORDERING:
  // removing the token from the compose block before adding the credential fails here, in the boot
  // log, naming both variables — not ten minutes later on a player's purchase.
  const neither = { ...BASE, EMBERKIN_IDENTITY_CREDENTIAL: '' };
  assert.throws(
    () => loadEnv(neither),
    (err: unknown) =>
      err instanceof EnvError &&
      /EMBERKIN_IDENTITY_CREDENTIAL/.test(err.message) &&
      /EMBERKIN_SERVICE_TOKEN/.test(err.message),
  );
});

test('#228: the exchange is dialled at IDENTITY_ISSUER unless IDENTITY_URL says otherwise', () => {
  // Defaulting rather than adding a fourth required identity variable is what lets every existing
  // deployment gain the exchange with no manifest change at all.
  assert.equal(loadEnv(BASE).identityUrl, BASE.IDENTITY_ISSUER);
  assert.equal(loadEnv({ ...BASE, IDENTITY_URL: 'http://identity:4000' }).identityUrl, 'http://identity:4000');
  // A PATH is refused here rather than producing a `POST /v1//service-tokens/exchange` that 404s
  // with nothing in the log naming the cause — the exact class of silent failure this issue is.
  assert.throws(
    () => loadEnv({ ...BASE, IDENTITY_URL: 'http://identity:4000/v1' }),
    (err: unknown) => err instanceof EnvError && /must be an origin/.test(err.message),
  );
  assert.throws(
    () => loadEnv({ ...BASE, IDENTITY_URL: 'ws://identity:4000' }),
    (err: unknown) => err instanceof EnvError && /http or https/.test(err.message),
  );
});

test('THE VALUE THAT SAT IN A PUBLIC REPOSITORY IS REFUSED — micro-org #142/#212', () => {
  // 40 characters, on nobody's deny-list, live on 44 containers across both networks. It cleared
  // the guard this file used to carry, which is the entire defect: a membership test can only
  // catch placeholders somebody already imagined.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'estate-only-outbox-secret-00000000000000' }),
    (err: unknown) => err instanceof EnvError && /reads as a placeholder/.test(err.message),
  );
  // Long enough for the old floor twice over, and degenerate. Characters were never the unit.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'x'.repeat(48) }),
    (err: unknown) => err instanceof EnvError && /entropy/.test(err.message),
  );
  // The fixture this file used to boot on, named so the regression is unmistakable.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'a-real-secret-of-sufficient-length-000' }),
    (err: unknown) => err instanceof EnvError && /sufficientlength/.test(err.message),
  );
  // Bytes, not keystrokes: 32 base64 characters carry only 24 bytes of key material.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(24).toString('base64') }),
    (err: unknown) => err instanceof EnvError && /24 bytes of key material/.test(err.message),
  );
});

test('env: a non-positive reward budget is refused', () => {
  assert.throws(() => loadEnv({ ...BASE, EMBERKIN_SEASON_REWARD_BUDGET_WEI: '0' }), EnvError);
});

test('env: the budget is read as a bigint, never a float', () => {
  // Past Number.MAX_SAFE_INTEGER, which at 18 decimals is where every real budget lives: the
  // DEFAULT is already 4e21. Read through Number() this would come back as ...992.
  const env = loadEnv({ ...BASE, EMBERKIN_SEASON_REWARD_BUDGET_WEI: '9007199254740993' });
  assert.equal(env.seasonRewardBudgetWei, 9007199254740993n);
});

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * **THE RETIRED VARIABLE IS REFUSED, NOT IGNORED.** micro-org#226.
 *
 * The tempting alternative is to accept EMBERKIN_SEASON_REWARD_BUDGET_SHARDS and quietly ignore
 * it. That is worse than either extreme: the service would boot on the DEFAULT budget while an
 * operator who had deliberately set a cap believed theirs was in force — a budget nobody chose,
 * presented as one somebody did, and wrong by eighteen orders of magnitude in the direction of
 * generosity. Refusing at boot turns a silent money-control failure into a failed deploy.
 *
 * Safe to ship because nothing sets it: measured 2026-08-10 against the RUNNING container
 * (`docker inspect cloudsforge-estate-emberkin-1`) and across deploy/compose. Neither name is
 * present, so mainnet has always run on the default and this cannot fire there.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
test('env: the retired _SHARDS budget variable is refused by name', () => {
  assert.throws(
    () => loadEnv({ ...BASE, EMBERKIN_SEASON_REWARD_BUDGET_SHARDS: '100000' }),
    (err: unknown) =>
      err instanceof EnvError &&
      /EMBERKIN_SEASON_REWARD_BUDGET_SHARDS is retired/.test(err.message) &&
      // The message must name the replacement. An operator reading a failed boot needs the next
      // action, not just the verdict.
      /EMBERKIN_SEASON_REWARD_BUDGET_WEI/.test(err.message),
  );
});

test('env: the retired variable set to empty or whitespace is not treated as set', () => {
  // A compose file that renders `EMBERKIN_SEASON_REWARD_BUDGET_SHARDS=` from an unset
  // interpolation must not brick the boot. Absent and empty mean the same thing: nobody asked.
  for (const value of ['', '   ']) {
    const env = loadEnv({ ...BASE, EMBERKIN_SEASON_REWARD_BUDGET_SHARDS: value });
    assert.equal(env.seasonRewardBudgetWei, 4_000_000_000_000_000_000_000n);
  }
});

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * OUTBOX_ACCEPT_SECRETS — the overlap window that makes rotating the shared HMAC key survivable.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * GENERATED per run, both. The literals that used to sit here —
 * `'rotation-fixture-next-key-not-a-real-secret'` and its prior twin — normalise to strings
 * containing `notareal`, a marker on `@cloudsforge/secrets`' list, and are hyphenated prose rather
 * than key material. They were refused the moment the list stopped being a place where the rule
 * relaxes, which is the correct outcome and the reason they are gone.
 */
const NEXT_KEY = generatedKey();
const PRIOR_KEY = generatedKey();

test('env: absent OUTBOX_ACCEPT_SECRETS, the service accepts exactly the signing secret', () => {
  // The no-op property. Deploying this changes nothing until an operator sets the variable, which
  // is what lets the estate's shared key be rotated one service at a time rather than on a flag day.
  assert.deepEqual([...loadEnv(BASE).acceptSecrets], [BASE.OUTBOX_SIGNING_SECRET]);
});

test('env: OUTBOX_ACCEPT_SECRETS is a comma-separated list, newest first, and signing stays single', () => {
  const env = loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: ` ${NEXT_KEY} , ${PRIOR_KEY} ` });
  assert.deepEqual([...env.acceptSecrets], [NEXT_KEY, PRIOR_KEY]);
  // Signing is NOT a list: two outbound signatures would double every subscriber's verification
  // work and leave nobody able to say which key an event was signed with.
  assert.equal(env.outboxSigningSecret, BASE.OUTBOX_SIGNING_SECRET);
});

test('env: every OUTBOX_ACCEPT_SECRETS entry faces the bar a single secret faces', () => {
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEXT_KEY},changeme` }), /placeholder/);
  // The entry is named by INDEX and never quoted — an operator with the file open can count commas,
  // and a log collector must not be handed the value.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEXT_KEY},short` }),
    (err: unknown) => err instanceof EnvError && /OUTBOX_ACCEPT_SECRETS\[1\]/.test(err.message),
  );
  // The one that matters: 40 characters, refused by no deny-list, accepted by the old list guard
  // because "just for the drain" is how a placeholder survives a rotation meant to remove it.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEXT_KEY},estate-only-outbox-secret-00000000000000` }),
    (err: unknown) => err instanceof EnvError && /reads as a placeholder/.test(err.message),
  );
  // A list of separators would be an empty accept list, which refuses every producer in the estate.
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: ' , , ' }), /at least one secret/);
});

test('env: OUTBOX_ACCEPT_SECRETS listing the same secret twice is refused', () => {
  // A duplicate makes "which key verified this" ambiguous, and that answer is how an operator
  // knows the rotation has finished and the old key may be dropped.
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEXT_KEY},${NEXT_KEY}` }), /twice/);
});
