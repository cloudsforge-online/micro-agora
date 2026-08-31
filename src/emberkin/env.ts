/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out has
 * nothing to justify it.
 *
 * Two behaviours are deliberate estate house style:
 *   1. A missing variable names itself (rather than surfacing as an unreadable driver error later).
 *   2. A known placeholder is refused outright — a default secret that boots is a default secret
 *      that reaches production.
 *
 * `EMBERKIN_SEASON_REWARD_BUDGET_WEI` is a MONEY CONTROL, not a tuning knob: season rewards are
 * ledger postings, so a game exploit that mints rewards is a money incident, and the cap is checked
 * in the same transaction as the posting. It was `..._SHARDS` until micro-org#226 moved the
 * programme off the retired asset; the old name is REFUSED below rather than ignored.
 */

import { hostname } from 'node:os';
import {
  SecretError,
  assertGeneratedSecret,
  assertServiceCredential,
  parseSecretList as parseGeneratedSecretList,
} from '@cloudsforge/secrets';

/** This service's own name. A constant — a property of the repository, not the deployment. */
export const SERVICE = 'emberkin';

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

type Source = Readonly<Record<string, string | undefined>>;

function required(source: Source, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`);
  return value;
}

/**
 * `@cloudsforge/secrets` raises `SecretError`; this file's contract is that `loadEnv` raises
 * `EnvError`, and every test and caller in this repository is written to that.
 *
 * So a shape failure is re-wrapped rather than rethrown, and the message is carried across
 * VERBATIM: it already names the variable and the command that fixes it, and by construction it
 * contains no part of the value. Only the class changes, so there is one thing to catch here and
 * nothing to re-derive by matching on text.
 */
function asEnvError(err: unknown): never {
  throw err instanceof SecretError ? new EnvError(err.message) : err;
}

/**
 * The estate's shared event-bus HMAC key, held to a SHAPE rather than to a deny-list.
 *
 * THE LOCAL `requiredSecret` AND ITS `PLACEHOLDERS` SET ARE GONE RATHER THAN KEPT IN FRONT, and
 * this is micro-org #212. They asked two questions — is the value one of nine exact strings, and
 * is it at least 24 characters — and `estate-only-outbox-secret-00000000000000` answered both
 * correctly: it was on nobody's list and it was 40 characters. That value sat on 54 lines of a
 * PUBLIC compose file and was live on 44 containers across both networks. A MEMBERSHIP TEST CAN
 * ONLY CATCH PLACEHOLDERS SOMEBODY ALREADY IMAGINED, so it fails in exactly the case that matters.
 *
 * `assertGeneratedSecret` measures instead: the base64 or hex alphabet and nothing else, at least
 * 32 decoded BYTES rather than 24 keystrokes, and a MEASURED Shannon entropy floor per alphabet.
 * `'x'.repeat(24)` is 24 characters and near-zero entropy, and is refused. There is no NODE_ENV
 * exemption and no escape hatch, so CI generates a real value per run rather than being let
 * through.
 *
 * It matters here specifically: this service VERIFIES inbound deliveries on `POST /v1/events` with
 * this key, and one of the topics that arrive there is `identity.user.deleted`. A forgeable key is
 * an anonymous erasure endpoint, and a missed delivery is an erasure obligation quietly not met.
 *
 * Measured live on 2026-08-06, both networks: 64 characters, base64, 48 bytes, 5.27 bits per
 * character — `openssl rand -base64 48`, exactly what the runbook says to run. So this refuses
 * nothing that is currently deployed.
 *
 * `required` in front of it and nothing else: the deleted checks were a strict subset of the
 * stronger ones, and running them first would answer a 40-character placeholder with "must be at
 * least 24 characters" — true, useless, and pointing the operator at the wrong property.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name);
  try {
    assertGeneratedSecret(name, value);
  } catch (err) {
    asEnvError(err);
  }
  return value;
}

/**
 * A JWT's first two segments. Matched on SHAPE, not decoded — this is a refusal, not a parse.
 */
const JWT_SHAPE = /^ey[A-Za-z0-9_-]*\./;

/**
 * A MINTED TOKEN, which is a fourth thing and not one of `@cloudsforge/secrets`' three classes.
 *
 * ── NOW OPTIONAL, AND THAT IS THE POINT OF micro-org #228 ─────────────────────────────────────
 *
 * This slot used to be REQUIRED, because `index.ts` was `const token = (): string =>
 * env.serviceToken` — the value was PRESENTED as a bearer, verbatim, with no exchange. So it had
 * to be a ten-minute JWT from `POST /service-tokens`, and the guard demanded that shape.
 *
 * A ten-minute bearer read once at boot is micro-org #197/#222: the process authenticates for the
 * first ten minutes of its life and presents a corpse afterwards, with `/livez` green throughout
 * because it verifies nothing. That is now fixed in `src/upstreams.ts`, which exchanges
 * `EMBERKIN_IDENTITY_CREDENTIAL` at `POST /service-tokens/exchange` and re-mints before expiry.
 *
 * ── WHY THE VARIABLE SURVIVES AT ALL: THE ROLLING DEPLOY ──────────────────────────────────────
 *
 * A deploy cannot change the image and the compose block in the same instant. A container carrying
 * the OLD variable and no new one must keep booting through the rollout rather than exiting 1
 * mid-flight, so `static` stays a supported mode — with `upstreams.ts` reporting it and `index.ts`
 * logging `fatal` naming exactly what will break ten minutes later. **DELETE THIS FIELD, and
 * `EMBERKIN_SERVICE_TOKEN` with it, once no estate sets it.**
 *
 * ── THE SHAPE GUARD IS UNCHANGED WHEN THE VALUE IS PRESENT ────────────────────────────────────
 *
 * micro-org #212 is not weakened by making the slot optional. The compose default when the
 * bootstrap has not run is `${EMBERKIN_SERVICE_TOKEN:-estate-placeholder-token-0000000000000000}`
 * — 40 characters, on nobody's deny-list. A service booting on that 401s all three upstreams
 * silently. In `static` mode the value is still presented verbatim, so it must still be a JWT;
 * absence is a mode and rubbish is not.
 *
 * ABSENT AND EMPTY ARE THE SAME THING here: compose interpolates `${EMBERKIN_SERVICE_TOKEN:-…}`
 * and a `:-` default that is itself empty arrives as the EMPTY STRING. `null` is the absence, said
 * once, so `upstreams.ts` cannot pick a mode by truthiness and silently agree with an operator who
 * set the variable to nothing.
 *
 * NO EXPIRY CHECK, and that is deliberate rather than forgotten. `exp` is in the past on every
 * restart more than ten minutes after a bootstrap, so enforcing it would crash-loop this service
 * and `emberkin-migrate` with it. A boot check cannot fix a lifetime problem; exchange-and-refresh
 * can, and that is what `upstreams.ts` now does.
 */
function optionalMintedToken(source: Source, name: string): string | null {
  const value = source[name]?.trim();
  if (!value) return null;
  if (!JWT_SHAPE.test(value)) {
    throw new EnvError(
      `${name} is not a minted service token — identity issues these as a JWT and this service ` +
        `presents the value verbatim as a Bearer, so a typed placeholder here 401s every upstream ` +
        `silently. Prefer EMBERKIN_IDENTITY_CREDENTIAL, which does not expire in ten minutes. ` +
        `Mint either with: deploy/scripts/estate-bootstrap.sh`,
    );
  }
  return value;
}

/**
 * The LONG-LIVED SERVICE CREDENTIAL — `cfsc_…` — that this service exchanges for short tokens.
 *
 * ── WHY NOT `assertGeneratedSecret`, WHICH GUARDS THE SIGNING KEYS ABOVE ──────────────────────
 *
 * Because it would refuse every credential this estate has ever minted and emberkin would exit 1
 * at boot on BOTH networks. A credential is `cfsc_` + base64url, which is neither wholly base64
 * nor wholly hex — the underscore in its own prefix disqualifies it. `assertServiceCredential`
 * asserts what those rules cannot: the prefix, placeholder markers checked on the BODY after the
 * prefix is stripped, 32 decoded BYTES rather than keystrokes, an entropy floor — and, first of
 * all, that the value is **not a JWT**.
 *
 * That last refusal is the mirror image of `optionalMintedToken`'s and it is the whole of #228 read
 * backwards: a container handed a ten-minute TOKEN in the credential slot would exchange nothing,
 * work for ten minutes, and fail exactly as before. Both slots now refuse the other's value BY
 * NAME, so the two cannot be swapped by a deploy in a hurry.
 *
 * `SecretError` is deliberately NOT re-wrapped into `EnvError` here, unlike the signing keys:
 * `fatalConfig` reads `err.message` off `unknown`, so the boot line is identical either way, and
 * re-wrapping would put this file's text between the operator and the guard's own — which names
 * the variable, the defect and the command that mints a real one.
 */
function optionalCredential(source: Source, name: string): string | null {
  const value = source[name]?.trim();
  if (!value) return null;
  assertServiceCredential(name, value);
  return value;
}

/**
 * An absolute origin, or nothing. A PATH IS REFUSED HERE rather than producing a
 * `POST /v1//service-tokens/exchange` that 404s with nothing naming the cause.
 */
function optionalOrigin(source: Source, name: string): string | undefined {
  const raw = source[name]?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EnvError(`${name} must be an absolute URL (got ${raw})`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EnvError(`${name} must be http or https (got ${url.protocol})`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new EnvError(`${name} must be an origin with no path, query or fragment (got ${raw})`);
  }
  return url.origin;
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

/**
 * A comma-separated list of secrets, newest first.
 *
 * A LIST, not a value, because rotating `OUTBOX_SIGNING_SECRET` without an overlap window would
 * require every producer in the estate to change secret in the same instant this service does, and
 * that instant does not exist during a rolling deploy. A producer that moved first would simply be
 * refused — and one of the two topics this service consumes is `identity.user.deleted`, so a silent
 * partition is an erasure obligation quietly not met.
 *
 * Every entry is held to exactly the bar a single secret is held to, and since micro-org #212 that
 * bar is `assertGeneratedSecret` rather than a deny-list plus a 24-character floor. A LIST IS NOT A
 * PLACE WHERE THE RULE RELAXES: the OUTGOING key is the one an attacker already has if it leaked,
 * and "just for the drain" is exactly how a placeholder survives a rotation meant to remove it.
 *
 * THE BODY OF THIS FUNCTION IS GONE, not reimplemented. It was the eleventh copy of the same
 * parser in the estate — `trade/src/env.ts` and `settlement/src/env.ts` carried the others
 * — and eleven copies of a check are eleven chances for one of them to drift. `parseSecretList` in
 * `@cloudsforge/secrets` is the one copy, and it keeps the duplicate check this copy had.
 *
 * The signature is preserved because callers and tests in this repository are written to it; only
 * the argument order differs from the shared function, which takes the NAME first.
 */
export function parseSecretList(raw: string, name: string): readonly string[] {
  try {
    return parseGeneratedSecretList(name, raw);
  } catch (err) {
    asEnvError(err);
  }
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`);
  }
  return value;
}

/**
 * A quantity of EMBER wei as a decimal string, never a number.
 *
 * A budget is money. Reading it through `Number()` would make a large one approximate, and an
 * approximate cap is either slightly too generous or refuses a legitimate grant — both discovered
 * by a player rather than by a test. At 18 decimals this stopped being a precaution against an
 * unusually large figure and became the only reading that works at all: the default below is
 * 4e21, which is past `Number.MAX_SAFE_INTEGER` by three orders of magnitude.
 */
function wei(source: Source, name: string, fallback: bigint): bigint {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new EnvError(`${name} must be a whole number of wei (got ${raw})`);
  return BigInt(raw);
}

export interface Env {
  readonly port: number;
  readonly env: string;
  readonly version: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Rule 1: one database, named by this service's own variable. */
  readonly databaseUrl: string;
  /**
   * The testnet database, when this pod serves both estates. EMPTY is the single-network case, and
   * then `networkSql` REFUSES a testnet request rather than answering it out of mainnet rows.
   * See micro-deploy `docs/network-consolidation.md`.
   */
  readonly databaseUrlTestnet: string;
  /**
   * `CF_NETWORK_SINGLE`: the network to assume when no `CF-Network` header arrives. For `pnpm dev`,
   * which has no gateway in front of it. Never set in production.
   */
  readonly singleNetwork: string;
  readonly databasePoolMax: number;
  readonly identityJwksUrl: string;
  readonly identityIssuer: string;
  /**
   * Identity's ORIGIN, which is what `POST /service-tokens/exchange` is posted to.
   *
   * **REQUIRED, AND IT DEFAULTS TO `IDENTITY_ISSUER` RATHER THAN BEING OPTIONAL.** The three
   * identity variables are spellings of one host and only the JWKS URL carries a path. Making this
   * optional would leave `upstreams.ts` deciding what to do with a credential it has been given and
   * an identity it cannot find, and the only honest answer to that is "refuse to start" — which is
   * what this says in one line instead of three at the call site.
   *
   * Defaulting to the issuer rather than demanding a new variable is not laziness: this service
   * already refuses to boot without the issuer, the issuer IS identity's origin on both estates,
   * and every deployment therefore gains the exchange with no manifest change. `IDENTITY_URL` is
   * the override for the day the issuer becomes a public URL and the in-cluster address stops
   * matching it. `tessera/src/env.ts` and `market/src/env.ts` read the same two variables the same
   * way, and two services disagreeing about where identity lives is its own defect.
   */
  readonly identityUrl: string;
  /**
   * HMAC key for outbound event signatures, so a subscriber can prove an event came from us.
   * Exactly one, always: a producer signing under two keys at once has not rotated, it has forked,
   * and it doubles every subscriber's verification work for no gain.
   */
  readonly outboxSigningSecret: string;
  /**
   * The secrets `POST /v1/events` will ACCEPT, newest first, under BOTH inbound schemes.
   *
   * Defaults to `[outboxSigningSecret]` when `OUTBOX_ACCEPT_SECRETS` is unset, so a deploy that
   * does not set it behaves exactly as it does today, byte for byte. That is deliberate: it makes
   * shipping this a no-op, which is what lets the estate's shared key be rotated one service at a
   * time afterwards rather than on a flag day. See `outbox.ts`'s `verifyInbound` for why a single
   * value cannot be rotated at all.
   */
  readonly acceptSecrets: readonly string[];
  readonly instanceId: string;

  readonly ledgerUrl: string;
  readonly billingUrl: string;
  /** Worlds owns the shared profile + achievements; this service posts to it via the bridge. */
  readonly worldsUrl: string;
  /**
   * The LONG-LIVED, REVOCABLE service credential — `cfsc_…`, never a JWT.
   *
   * This is the fix for micro-org #228. `upstreams.ts` exchanges it at
   * `POST /service-tokens/exchange` for an ordinary ten-minute token and re-mints at a jittered 80%
   * of whatever `expiresIn` that exchange answered with. The exchange consumes nothing, so N
   * replicas boot from one credential and a restart days later still works. The 600 seconds is
   * deliberately unchanged — rotation IS expiry, and lengthening the TTL would leave the same
   * defect arriving later and hurting more.
   *
   * `null` is the absence. See `requireOneCredentialSource`: it is optional only so that a
   * container still carrying the old `EMBERKIN_SERVICE_TOKEN` boots through a rolling deploy, and
   * one of the two must always be present.
   */
  readonly identityCredential: string | null;
  /**
   * The scoped service TOKEN — a ten-minute JWT, not a credential. **A MIGRATION AID WITH A STATED
   * END.**
   *
   * This variable IS micro-org #228: `index.ts` read it once at boot and presented it verbatim as a
   * Bearer to all three upstreams for the life of the process, so the service authenticated for the
   * first ten minutes of its life. It survives only so a container carrying the old variable and no
   * new one keeps booting through the rollout. Not shared: SD-05. Carries billing:read,
   * ledger:post, worlds:write.
   *
   * `upstreams.ts` reports `mode: 'static'` while it is in use and `index.ts` logs `fatal` naming
   * the consequence, which is how an operator knows the day has come to delete it. See
   * `optionalMintedToken` for the shape guard, which is unchanged when the value is present.
   */
  readonly serviceToken: string | null;
  readonly upstreamDeadlineMs: number;

  /**
   * The default reward budget a new Emberkin season is opened with, in EMBER wei.
   *
   * A season may be given its own on creation; this is what one gets when nobody says. It is
   * deliberately small — a budget nobody chose should bind long before it costs anything.
   */
  readonly seasonRewardBudgetWei: bigint;
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/**
 * ONE OF THE TWO, ALWAYS. This service cannot call billing, the ledger or worlds without a bearer,
 * and all three URLs are required, so a container with neither variable is a deployment that will
 * answer 503 at every route that touches a peer.
 *
 * Both slots are individually optional and that is what makes this check necessary rather than
 * incidental: `EMBERKIN_SERVICE_TOKEN` was REQUIRED before micro-org #228, so dropping it to
 * optional without this would have quietly turned "refuses to boot" into "boots and cannot
 * authenticate". The contract is preserved: you still cannot start emberkin with no way to
 * authenticate. What changed is which variable satisfies it.
 *
 * It also pins the deploy ORDERING. Removing `EMBERKIN_SERVICE_TOKEN` from the compose block before
 * adding `EMBERKIN_IDENTITY_CREDENTIAL` fails loudly at the door, in the boot log, naming both
 * variables — rather than ten minutes later as a 401 on a player's cosmetic purchase, which is the
 * failure this whole change exists to remove.
 */
function requireOneCredentialSource(credential: string | null, token: string | null): void {
  if (credential || token) return;
  throw new EnvError(
    'EMBERKIN_IDENTITY_CREDENTIAL is required — this service presents a bearer to billing, the ' +
      'ledger and worlds, and without it every one of those calls answers 503. Set the long-lived ' +
      'credential (cfsc_…) that deploy/scripts/estate-bootstrap.sh already mints. ' +
      'EMBERKIN_SERVICE_TOKEN is accepted in its place only for the length of a rolling deploy: it ' +
      'is a ten-minute token read once at boot, which is micro-org #228.',
  );
}

export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info');
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`);
  }
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // EMBERKIN_SEASON_REWARD_BUDGET_SHARDS IS REFUSED, NOT ACCEPTED-AND-IGNORED. micro-org#226.
  //
  // The same shape micro-worlds and micro-mint used when they retired their own Shard-denominated
  // knobs, and for the same reason: a deployment still setting the old name is asserting a budget
  // in a unit this build no longer has. Accepting it silently would fall back to the default below
  // — a budget NOBODY CHOSE, presented as one somebody did — and the number would be wrong by
  // eighteen orders of magnitude in the direction of generosity. It is refused where it is named.
  //
  // This costs nothing to ship. Neither name is set anywhere, measured two ways on 2026-08-10:
  // `docker inspect cloudsforge-estate-emberkin-1` lists neither in the RUNNING container's
  // environment, and neither appears anywhere under deploy/compose. Mainnet has always run on the
  // default, so this refusal cannot fire there. (The .env.example comment used to justify keeping
  // the old name by saying it "is set on the estate" — it is not, and that is now measured.)
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  if ((source['EMBERKIN_SEASON_REWARD_BUDGET_SHARDS'] ?? '').trim().length > 0) {
    throw new EnvError(
      'EMBERKIN_SEASON_REWARD_BUDGET_SHARDS is retired with the asset it names. Set ' +
        'EMBERKIN_SEASON_REWARD_BUDGET_WEI instead — it is EMBER wei, so the same money is a ' +
        'different number (21 §2, micro-org#226)',
    );
  }
  // 4,000 EMBER: the 100,000 Shards this defaulted to before #226, CONVERTED at the two recorded
  // rates rather than relabelled. 100 Shards to the USD (SHARDS_PER_USD) makes it USD 1,000, and
  // EMBER's administered price of 0.25 USD (pricing.administered_prices, usd_scaled 250000,
  // unchanged since 2026-08-04 and read again on 2026-08-10) makes that 4,000 EMBER. It is the
  // same figure migration 9 converts the one live season row to, which is deliberate: a season
  // opened before the migration and a season opened after it get the same budget. The literal is
  // grouped so a reader can count the eighteen zeroes without trusting an exponent.
  const budget = wei(source, 'EMBERKIN_SEASON_REWARD_BUDGET_WEI', 4_000_000_000_000_000_000_000n);
  // Zero would be a season that can pay nothing, which is a configuration mistake presenting as
  // "every reward is refused". Refused here, where the variable is named.
  if (budget <= 0n) throw new EnvError('EMBERKIN_SEASON_REWARD_BUDGET_WEI must be positive');
  // Read before the object literal because the accept list falls back to it.
  const outboxSigningSecret = requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET');
  // Read before the object literal because neither is valid alone-and-absent: the pair is what is
  // checked, and a shape failure in either must still name its own variable first.
  const identityCredential = optionalCredential(source, 'EMBERKIN_IDENTITY_CREDENTIAL');
  const serviceToken = optionalMintedToken(source, 'EMBERKIN_SERVICE_TOKEN');
  requireOneCredentialSource(identityCredential, serviceToken);

  return {
    port: integer(source, 'PORT', 4100, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'EMBERKIN_DATABASE_URL'),
    databaseUrlTestnet: optional(source, 'EMBERKIN_DATABASE_URL_TESTNET', ''),
    singleNetwork: optional(source, 'CF_NETWORK_SINGLE', ''),
    databasePoolMax: integer(source, 'EMBERKIN_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    // `optionalOrigin` when set — so a value with a path is refused here rather than producing a
    // `POST /v1//service-tokens/exchange` that 404s — and the issuer when it is not. See the field
    // comment for why this defaults instead of being a fourth required identity variable.
    identityUrl: optionalOrigin(source, 'IDENTITY_URL') ?? required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret,
    acceptSecrets: parseSecretList(
      optional(source, 'OUTBOX_ACCEPT_SECRETS', outboxSigningSecret),
      'OUTBOX_ACCEPT_SECRETS',
    ),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    ledgerUrl: required(source, 'LEDGER_URL'),
    billingUrl: required(source, 'BILLING_URL'),
    worldsUrl: required(source, 'WORLDS_URL'),
    identityCredential,
    serviceToken,
    upstreamDeadlineMs: integer(source, 'EMBERKIN_UPSTREAM_DEADLINE_MS', 5_000, 100, 60_000),

    seasonRewardBudgetWei: budget,
  };
}

function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  );
  process.exit(1);
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname());
  } catch (err) {
    fatalConfig(err);
  }
})();
