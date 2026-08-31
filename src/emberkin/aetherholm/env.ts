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
 *   2. A secret that is not SHAPED like a generated one is refused outright — a placeholder that
 *      boots is a placeholder that reaches production. The rule is `@cloudsforge/secrets`, shared
 *      with the whole estate, and it replaced a per-service deny-list that could not fail: see
 *      `requiredSigningSecret` below and micro-org #142.
 *
 * There is deliberately no upstream URL and no service token here. Phase 1 of this title makes no
 * outbound HTTP call: the title contract is INBOUND (worlds calls `POST /v1/provision` with its own
 * scoped credential), entitlement consumption arrives on that call, and every background timer is a
 * leased job against this service's own database. A variable nothing reads is a secret nothing
 * needed handed to a container anyway.
 */

import { hostname } from 'node:os';
import { assertGeneratedSecret, assertGeneratedSecretList, SecretError } from '@cloudsforge/secrets';

/** This service's own name. A constant — a property of the repository, not the deployment. */
export const SERVICE = 'aetherholm';

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
 * So the shape failures are re-wrapped rather than rethrown, and the message is carried across
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
 * The `requiredSecret` this replaced could not fail. It refused a fixed list of exact strings and
 * anything under 24 characters, and the value that sat on 54 lines of a PUBLIC compose file —
 * `estate-only-outbox-secret-00000000000000` — was on no list and was 40 characters, so it passed
 * every service in the estate (micro-org #142). A check that cannot fail is worse than no check,
 * because the absence of an alarm gets read as the absence of a problem.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. It has no NODE_ENV exemption and no escape
 * hatch, so CI generates a real value per run rather than being let through.
 *
 * `required` rather than a length check first, deliberately: the weaker checks are a strict subset
 * of the stronger ones, and running them first would answer a 40-character placeholder with "must
 * be at least 24 characters" — true, useless, and pointing the operator at the wrong property.
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

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

/**
 * A comma-separated secret list, newest first, with EVERY entry held to the bar a scalar is.
 *
 * A list is not a place where the rule relaxes. In a rotation's overlap window the OUTGOING key is
 * the one an attacker already holds if it leaked, and "just for the drain" is exactly how a
 * placeholder survives the rotation that was supposed to remove it — so an accept list is the
 * likeliest place for a filler to get in, not the safest.
 *
 * The fallback is the signing secret, which has already cleared the same gate: a deploy that has
 * never rotated behaves exactly as one that cannot.
 */
function signingSecretList(source: Source, name: string, fallback: string): readonly string[] {
  const raw = optional(source, name, fallback);
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  try {
    // Empty throws here too, and must: this list is what `POST /v1/events` verifies against, and a
    // list of nothing is a webhook nothing can authenticate.
    assertGeneratedSecretList(name, values);
  } catch (err) {
    asEnvError(err);
  }
  return Object.freeze(values);
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

export interface Env {
  readonly port: number;
  readonly env: string;
  readonly version: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Rule 1: one database, named by this service's own variable. */
  readonly databaseUrl: string
  /**
   * The TESTNET database, when this deployment serves both networks. Empty means single-network —
   * `networkSql` then holds one handle and REFUSES a testnet request rather than answering it out
   * of mainnet rows (micro-deploy `docs/network-consolidation.md` §2.2).
   */
  readonly databaseUrlTestnet: string
  /**
   * The network to assume when a request carries no `CF-Network`, or empty to refuse. Set for
   * `pnpm dev`, which has no gateway. Never in production, where guessing makes a routing fault a
   * silent cross-network write.
   */
  readonly singleNetwork: string
  readonly databasePoolMax: number;
  readonly identityJwksUrl: string;
  readonly identityIssuer: string;
  /** HMAC key for outbound event signatures. */
  readonly outboxSigningSecret: string;
  /**
   * The secrets `POST /v1/events` will ACCEPT, newest first.
   *
   * Defaults to `[outboxSigningSecret]` when `OUTBOX_ACCEPT_SECRETS` is unset, so a deploy that
   * never sets it behaves exactly as one that cannot rotate. That default is what lets the shared
   * signing secret be rotated one service at a time instead of on a flag day.
   */
  readonly acceptSecrets: readonly string[];
  readonly instanceId: string;
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info');
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`);
  }
  const outboxSigningSecret = requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET');

  return {
    // 4120, and `.env.example` must agree — CI compares the two, because two repos in this estate
    // shipped the disagreement and put three services on one port.
    port: integer(source, 'PORT', 4120, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'AETHERHOLM_DATABASE_URL'),
    databaseUrlTestnet: source['AETHERHOLM_DATABASE_URL_TESTNET'] ?? '',
    singleNetwork: source['CF_NETWORK_SINGLE'] ?? '',
    databasePoolMax: integer(source, 'AETHERHOLM_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret,
    acceptSecrets: signingSecretList(source, 'OUTBOX_ACCEPT_SECRETS', outboxSigningSecret),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
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
