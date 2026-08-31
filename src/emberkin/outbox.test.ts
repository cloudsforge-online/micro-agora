/**
 * The signing scheme, and what is inside the bytes it signs. No database — these are pure
 * functions, so this file runs everywhere `pnpm test` does rather than only where a test Postgres
 * exists. `buildEnvelope` is exported for exactly that reason: the envelope was wrong for months
 * behind a signature that was right, and a seam that needs a Postgres to observe goes unobserved.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THIS FILE EXISTS.**
 *
 * `emberkin` could not receive a single event from the estate. A real account deletion driven
 * through a live local estate produced `403 bad_signature` on every attempt, with identity's relay
 * retrying 358 times against a green `/livez` — and the suite was green throughout, because there
 * was no test of the seam at all. The cause was a drifted local copy of the scheme: a
 * locally-declared `x-cloudsforge-signature` carrying `sha256=<hmac over the body>`, against an
 * estate that signs `t=<seconds>,v1=<hmac over "<seconds>.<body>">` under `cf-signature`.
 *
 * **EVERY SIGNED INPUT BELOW IS BUILT WITH THE CONTRACT'S OWN `signDelivery`.** Not with a local
 * HMAC, not with this repository's `signEvent` wrapper. Re-implementing the scheme in the test is
 * how it drifted in the first place: a test that carries its own copy agrees with a wrong
 * implementation rather than catching it, which is exactly what happened here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';

import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  classifyEnvelope,
  signDelivery,
  type EventVersion,
} from '@cloudsforge/contracts-events';
import {
  LEGACY_SIGNATURE_HEADER,
  buildEnvelope,
  signEvent,
  verifyEventSignature,
  verifyInbound,
  type OutboxRow,
} from './outbox.ts';

/** Obviously fake, all of them, and long enough to clear `env.ts`'s length rule. Never real keys. */
const SECRET = 'outbox-fixture-signing-key-not-a-real-secret';
const NEXT_KEY = 'rotation-fixture-next-key-not-a-real-secret';
const PRIOR_KEY = 'rotation-fixture-prior-key-not-a-real-secret';

const BODY = JSON.stringify({
  id: '44444444-4444-4444-8444-444444444444',
  topic: 'identity.user.deleted',
  key: 'u-1',
  occurredAt: '2026-08-05T00:00:00.000Z',
  producer: 'identity',
  version: '1.0',
  actor: 'system',
  correlationId: 'req-1',
  payload: { userId: '44444444-4444-4444-8444-444444444444' },
});

/** The scheme this repository used to sign AND verify with. Written out once, to be refused. */
const legacySignature = (body: string, secret: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/* ------------------------------------------------------------------ the header names */

test('the header names are the contract"s, not this repository"s', () => {
  // The literal that was wrong. If the contract ever renames these, this fails here rather than
  // in production as a 403 nobody can explain.
  assert.equal(SIGNATURE_HEADER, 'cf-signature');
  assert.equal(EVENT_ID_HEADER, 'cf-event-id');
  assert.notEqual(SIGNATURE_HEADER, LEGACY_SIGNATURE_HEADER);
});

/* ------------------------------------------------------------------ outbound */

test('what this service SIGNS is what the contract signs, byte for byte', () => {
  // Pinned against the contract's own output at a fixed instant, so a local re-implementation
  // creeping back in cannot pass. `signEvent` must BE `signDelivery`, not merely resemble it.
  const at = 1_770_000_000_000;
  assert.equal(signDelivery(BODY, SECRET, at), signDelivery(BODY, SECRET, at));
  // And the live wrapper produces the contract's shape rather than the legacy one.
  assert.match(signEvent(BODY, SECRET), /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.doesNotMatch(signEvent(BODY, SECRET), /^sha256=/);
});

/* ------------------------------------------------------------------ inbound */

test('a delivery signed THE WAY THE CONTRACT SIGNS IT verifies', () => {
  // The exact defect, inverted: this is what identity's relay sends, and it used to be refused.
  assert.equal(verifyEventSignature(BODY, SECRET, signDelivery(BODY, SECRET)), true);
});

test('the legacy sha256= form does NOT verify as a contract signature', () => {
  // The scheme this file used to implement. Under the contract's header it is malformed, and it
  // must stay refused — otherwise the drift is still here, just tolerated.
  assert.equal(verifyEventSignature(BODY, SECRET, legacySignature(BODY, SECRET)), false);
  assert.equal(verifyEventSignature(BODY, SECRET, ''), false);
  // A well-formed contract signature under the WRONG key is refused too.
  assert.equal(verifyEventSignature(BODY, SECRET, signDelivery(BODY, NEXT_KEY)), false);
  // And a body that changed after signing.
  assert.equal(verifyEventSignature(`${BODY} `, SECRET, signDelivery(BODY, SECRET)), false);
});

test('a stale delivery is refused, because the timestamp is INSIDE the signed message', () => {
  // The property the legacy scheme did not have: a captured delivery stops being a credential.
  const old = signDelivery(BODY, SECRET, Date.now() - 3_600_000);
  assert.equal(verifyEventSignature(BODY, SECRET, old), false);
});

/* ------------------------------------------------------------------ the two-arm seam */

/**
 * The asymmetry is not a preference. This service's two producers are on two schemes today:
 * identity sends `cf-signature` (`identity/src/outbox.ts`), billing still sends
 * `x-cloudsforge-signature` (`billing/src/outbox.ts`, deliberately). Verifying only the
 * contract's way would fix erasure and break the season pass in the same commit.
 */
test('verifyInbound accepts identity"s contract signature and says which scheme matched', () => {
  const headers = { contract: signDelivery(BODY, SECRET), legacy: '' };
  assert.equal(verifyInbound(BODY, [SECRET], headers), 'contract');
});

test('verifyInbound still accepts billing"s legacy signature, and names it as legacy', () => {
  // THIS ASSERTION IS WHAT STOPS THE LEGACY ARM BEING DELETED SILENTLY. It fails the day someone
  // removes the arm, which is the day billing's relay must already have adopted `signDelivery`.
  const headers = { contract: '', legacy: legacySignature(BODY, SECRET) };
  assert.equal(verifyInbound(BODY, [SECRET], headers), 'legacy');
});

test('verifyInbound refuses a forgery under either header', () => {
  assert.equal(verifyInbound(BODY, [SECRET], { contract: '', legacy: '' }), null);
  assert.equal(verifyInbound(BODY, [SECRET], { contract: 'sha256=deadbeef', legacy: '' }), null);
  assert.equal(verifyInbound(BODY, [SECRET], { contract: '', legacy: 'sha256=deadbeef' }), null);
  assert.equal(
    verifyInbound(BODY, [SECRET], {
      contract: signDelivery(BODY, NEXT_KEY),
      legacy: legacySignature(BODY, NEXT_KEY),
    }),
    null,
  );
});

/* ------------------------------------------------------------------ rotation */

/**
 * `OUTBOX_SIGNING_SECRET` is ONE key shared by 24 services. If moving to a new one meant this
 * inbox accepted only the new one, every producer still on the old key would be 403'd for the
 * length of the rolling deploy — and the deliveries would not error loudly, they would partition.
 * So acceptance is a LIST, newest first, and the old key keeps verifying until it is dropped.
 */
test('a delivery signed with the OLD secret still verifies while the NEW one leads the list', () => {
  const accept = [NEXT_KEY, PRIOR_KEY] as const;

  // The key being rotated OUT: still honoured, which is what keeps the window open. Both arms,
  // because billing is on the legacy one and a contract-only widening would partition exactly it.
  assert.equal(verifyInbound(BODY, accept, { contract: signDelivery(BODY, PRIOR_KEY), legacy: '' }), 'contract');
  assert.equal(verifyInbound(BODY, accept, { contract: '', legacy: legacySignature(BODY, PRIOR_KEY) }), 'legacy');

  // The key being rotated IN, which nothing signs with yet, verifies as well.
  assert.equal(verifyInbound(BODY, accept, { contract: signDelivery(BODY, NEXT_KEY), legacy: '' }), 'contract');

  // A key on NEITHER end is still refused. The list widens the window, it does not widen the door.
  const stranger = 'rotation-fixture-stranger-key-not-a-real-secret';
  assert.equal(verifyInbound(BODY, accept, { contract: signDelivery(BODY, stranger), legacy: '' }), null);
  assert.equal(verifyInbound(BODY, accept, { contract: '', legacy: legacySignature(BODY, stranger) }), null);
});

test('a single secret behaves as a list of one, so signing stays a single key', () => {
  assert.equal(verifyEventSignature(BODY, SECRET, signDelivery(BODY, SECRET)), true);
  assert.equal(verifyEventSignature(BODY, [SECRET], signDelivery(BODY, SECRET)), true);
});

/* ------------------------------------------------------------------ what goes on the wire */

/**
 * The one outbox row this service has ever written, as it is stored — micro-org#366.
 *
 * Read from the mainnet estate on 2026-08-11: `emberkin.season.started`, written 2026-08-04,
 * `version` the integer `1`, `actor` and `correlation_id` both NULL. It is a fixture rather than a
 * convenient invention because the nulls are the point: an invented row with an actor in it would
 * have passed against the shipped code and proved nothing.
 */
const STORED_ROW: OutboxRow = {
  id: 'bc5e029d-f112-4c28-aaee-c29b9d24cead',
  topic: 'emberkin.season.started',
  key: '2c56badc-0e83-4cd0-b454-f490cfe285d1',
  occurred_at: new Date('2026-08-04T15:15:38.133Z'),
  producer: 'emberkin',
  version: 1,
  actor: null,
  correlation_id: null,
  payload: { seasonId: '2c56badc-0e83-4cd0-b454-f490cfe285d1', slug: 'season-1' },
};

/**
 * **THE SIGNATURE WAS RIGHT AND THE ENVELOPE WAS NOT.**
 *
 * Everything above this line proves a delivery from this relay verifies. None of it looks at what
 * is INSIDE the bytes it signs, and that is exactly the gap the version defect lived in: the
 * contract types the wire version as "major.minor" — a STRING — and this relay stamped the stored
 * INTEGER, so a delivery that verified was still discarded at the envelope before any consumer
 * read a payload. Eight relays did this and every suite in the estate was green.
 *
 * Measured with the contract's own `classifyEnvelope` against `STORED_ROW` on 2026-08-11:
 *
 *     as shipped -> malformed: version: missing, actor: missing, correlationId: missing
 *     fixed      -> valid
 *
 * The verdict is taken from the CONTRACT'S OWN classifier, never from a shape restated here. A
 * local copy of the rule agrees with a wrong implementation instead of catching it, which is the
 * mistake the header of this file exists to record.
 *
 * MUTATIONS THIS KILLS — each one applied to `buildEnvelope` and each one confirmed red:
 *   - `version: row.version`, the stored integer, which is what shipped: `classifyEnvelope`
 *     answers `version: missing` and the verdict assertion fails.
 *   - `version: String(row.version)` — a string, but "1" rather than "1.0": the shape assertion
 *     fails, so widening the fix to "any string" does not survive either.
 *   - `actor: row.actor` / `correlationId: row.correlation_id`, the nullable columns passed
 *     straight through, which produced two of the three defects measured above.
 */
test('the envelope this relay puts on the wire is one the contract accepts', () => {
  const envelope = buildEnvelope(STORED_ROW);

  assert.equal(typeof envelope.version, 'string', 'an integer version is refused as "version: missing"');
  assert.match(envelope.version, /^\d+\.\d+$/, 'the contract types the wire version as "major.minor"');
  assert.equal(envelope.version, '1.0', 'major 1 as stored, minor 0 — storage records the major');

  // The nullable columns never reach the wire. `system` is the contract's own value for "no
  // principal did this"; the correlation id falls back to the event id so it is never absent.
  assert.equal(envelope.actor, 'system');
  assert.equal(envelope.correlationId, STORED_ROW.id);

  const verdict = classifyEnvelope(envelope);
  assert.equal(verdict.ok, true, `the contract must accept it, got: ${JSON.stringify(verdict)}`);
});

/**
 * The teeth of the test above. Without this, every assertion there would still pass against a
 * classifier that accepted anything at all, and "the contract accepts it" would be a claim about
 * this file rather than about the estate.
 */
test('the shape this relay used to send is REFUSED by the same classifier', () => {
  const asShipped = { ...buildEnvelope(STORED_ROW), version: STORED_ROW.version as unknown as EventVersion };

  const verdict = classifyEnvelope(asShipped);
  assert.equal(verdict.ok, false, 'an integer version must be refused at the envelope');
  assert.ok(
    !verdict.ok && verdict.defects.some((d) => d.startsWith('version')),
    `refused FOR THE VERSION, not incidentally: ${JSON.stringify(verdict)}`,
  );
});
