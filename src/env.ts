/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * ## The rate limits are the product, not a tuning knob
 *
 * A public square with no floor rate is a spam channel within a day of being indexed, and every
 * social network that ever shipped without one learned it the same way. `AGORA_POSTS_PER_HOUR`,
 * `AGORA_WHISPERS_PER_HOUR` and `AGORA_FOLLOWS_PER_HOUR` are therefore validated here rather than
 * being read defensively at the call site: a deployment that sets one of them to zero has disabled
 * the square, and it should find that out at boot instead of at the first post.
 *
 * `ratelimit.ts` enforces them in the same transaction as the write, which is the only way a limit
 * survives two replicas.
 *
 * ## `AGORA_POST_MAX_CHARS` is a schema fact as much as a config one
 *
 * Migration 2 puts a CHECK on `posts.body` at the widest value this variable is allowed to take.
 * The variable narrows it per deployment; it can never widen it past what the column will accept,
 * because a config that could would produce a 23514 from the database on an ordinary post — a 500
 * for something the author did nothing wrong to cause.
 *
 * That ceiling — `MAX_POST_CHARS`, with `MAX_ALT_CHARS` beside it — lives in `text.ts`, NOT here,
 * and the direction of the import is deliberate: this module validates at import and calls
 * `process.exit(1)` when it fails, so anything that imports it inherits a hard requirement for the
 * full production environment. `migrations.ts` needs both constants to write the CHECKs, and a
 * schema that could not be built without a `AGORA_DATABASE_URL` in scope is a schema no test can
 * reach. `text.ts` imports nothing and asserts nothing, which is what makes it a safe home.
 */

import { hostname } from 'node:os'
import {
  SecretError,
  assertGeneratedSecret,
  assertServiceCredential,
} from '@cloudsforge/secrets'
import { MAX_POST_CHARS } from './text.ts'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a migration
 * advisory lock.
 */
export const SERVICE = 'agora'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

/**
 * Re-wrap the shared guard's `SecretError` as this service's `EnvError`.
 *
 * `loadEnv` documents a single error class for every configuration failure, and the boot path
 * catches that one class. The message is preserved verbatim — it already names the variable and
 * the command that fixes it, and it never contains the value.
 */
function asEnvError<T>(run: () => T): T {
  try {
    return run()
  } catch (err) {
    if (err instanceof SecretError) throw new EnvError(err.message)
    throw err
  }
}

/**
 * The estate's shared event-bus HMAC key — and on THIS service it is also the inbound verifier.
 *
 * Agora consumes `identity.user.deleted`, and consuming it means erasing a person's voice, their
 * posts and their whispers. An unsigned inbound event route here is therefore a free account-
 * deletion endpoint for anybody who can reach the port.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet, 32
 * decoded BYTES rather than 24 keystrokes, and a measured Shannon entropy floor. micro-org #142's
 * `estate-only-outbox-secret-00000000000000` is 40 characters and passed every length check the
 * estate had; it does not pass this one.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name)
  asEnvError(() => assertGeneratedSecret(name, value))
  return value
}

/**
 * A SERVICE CREDENTIAL that may be absent, but must be real if present.
 *
 * `null` rather than `undefined`, and rather than `''`: compose interpolates
 * `${AGORA_IDENTITY_CREDENTIAL:-}` and an unset credential arrives as the EMPTY STRING. That is the
 * supported mode — `migrator.ts` shares this environment and dials nobody — so the empty check
 * stays ahead of the assertion. What is not supported is a value that is present and rubbish: a
 * placeholder is a deployment that believes it HAS a credential and discovers otherwise on its
 * first call to policy, which `policyclient.ts` correctly records as a DEGRADED verdict rather than
 * a moderation decision. That is a square with no gate and nothing saying so.
 */
function optionalCredential(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  asEnvError(() => assertServiceCredential(name, value))
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

function boolean(source: Source, name: string, fallback: boolean): boolean {
  const raw = source[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new EnvError(`${name} must be true or false (got ${raw})`)
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  /**
   * The TESTNET database, when this deployment serves both networks.
   *
   * Empty means single-network, which is every deployment until the consolidation reaches this
   * service (micro-deploy `docs/network-consolidation.md`). `networkSql` then holds one handle and
   * REFUSES a testnet request rather than answering it out of mainnet rows.
   */
  readonly databaseUrlTestnet: string
  /**
   * The network to assume when a request carries no `CF-Network`, or empty to refuse.
   *
   * Set for `pnpm dev`, which has no gateway to stamp the header. Never set in production, where
   * an unstamped request is a routing fault and guessing makes it a silent cross-network write.
   */
  readonly singleNetwork: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /** HMAC key for outbound event signatures — and for VERIFYING the inbound ones. */
  readonly outboxSigningSecret: string
  readonly instanceId: string

  /** Where a service token is minted. `IDENTITY_ISSUER` unless overridden. */
  readonly identityUrl: string
  /** The long-lived `cfsc_…` credential this service exchanges for a service token. */
  readonly identityCredential: string | null
  readonly upstreamDeadlineMs: number

  /**
   * The moderation gate. **Soft, fail-open-and-flag** — see `policyclient.ts`.
   *
   * Empty is a supported state and means this deployment has no gate wired. Every post then
   * records `moderation_degraded`, which a report queue can be filtered on, rather than a silence
   * that reads as approval.
   */
  readonly policyUrl: string

  /**
   * Where a **BROWSER** reaches micro-studio. Not where this service reaches it.
   *
   * This service makes no call to studio at all: an avatar or an attachment is a reference this
   * service records and studio serves. So the only thing this variable does is compose the
   * `bytesUrl` a read hands to a client, and the upload address that client is told to POST to.
   * It is therefore NOT `STUDIO_URL`, which is a container name on a private network and produces
   * a broken image in every browser on earth.
   *
   * Empty means "this deployment has not been told", and every `bytesUrl` is then `null` — which a
   * client can render a sentence about, whereas a guessed hostname is a broken image with no
   * diagnosis.
   */
  readonly studioPublicUrl: string

  /**
   * Where a **BROWSER** reaches this surface — the origin `agora-web` is served from.
   *
   * One consumer, and it is the whole reason the variable exists: the notification sweep puts a
   * `url` on `agora.notification.mail_requested` so that the mail micro-notify sends has somewhere
   * to go. notify renders its links against `NOTIFY_PUBLIC_URL`, which is the hub, and the hub has
   * no route into the square; a relative path would therefore produce a mail whose one button
   * lands on a page that does not exist. The producer is the only party that knows its own origin,
   * so it is the party that says it.
   *
   * Empty is supported and means this deployment has not been told. The payload then carries no
   * `url` at all, notify falls back to the reader's notification centre on the hub — a real page,
   * one hop from the right one — rather than to a guessed hostname, which is a 404 with no
   * diagnosis. Same rule as `studioPublicUrl` above.
   */
  readonly publicUrl: string

  /** The widest a post may be here. Never above `MAX_POST_CHARS`, which the column enforces. */
  readonly postMaxChars: number
  /** Posts, replies and quotes one voice may create per rolling hour. */
  readonly postsPerHour: number
  /** Whispers one voice may send per rolling hour. The tightest of the three, deliberately. */
  readonly whispersPerHour: number
  /** Follows one voice may make per rolling hour. A follow storm is how a scraper maps a graph. */
  readonly followsPerHour: number
  /** The largest page any timeline will return. There is no infinite scroll; see doc 41 §4. */
  readonly pageSizeMax: number
  /** Posting can be paused without pausing the service. Nothing already written is lost. */
  readonly postingEnabled: boolean
  /**
   * How long a notification lives before the sweep deletes it. Read ones go early, unread ones at
   * the full term: a notification nobody has read is the only record that something happened.
   */
  readonly notificationTtlDays: number
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  // The ceiling is `MAX_POST_CHARS`, not an arbitrary large number, because the CHECK constraint in
  // migration 2 is written at that value. A deployment allowed to set 8,000 here would produce a
  // 23514 from Postgres on a perfectly ordinary post, which reaches the client as a 500 — the
  // service blaming itself for a limit it was configured to exceed.
  const postMaxChars = integer(source, 'AGORA_POST_MAX_CHARS', MAX_POST_CHARS, 1, MAX_POST_CHARS)

  return {
    port: integer(source, 'PORT', 4150, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'AGORA_DATABASE_URL'),
    databaseUrlTestnet: source['AGORA_DATABASE_URL_TESTNET'] ?? '',
    singleNetwork: source['CF_NETWORK_SINGLE'] ?? '',
    databasePoolMax: integer(source, 'AGORA_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    identityCredential: optionalCredential(source, 'AGORA_IDENTITY_CREDENTIAL'),
    upstreamDeadlineMs: integer(source, 'AGORA_UPSTREAM_DEADLINE_MS', 5_000, 100, 60_000),

    // Trailing slashes are stripped so `${base}/decisions` cannot become `//decisions`, which some
    // proxies treat as a protocol-relative URL and others as a path.
    policyUrl: optional(source, 'POLICY_URL', '').replace(/\/+$/, ''),
    studioPublicUrl: optional(source, 'STUDIO_PUBLIC_URL', '').replace(/\/+$/, ''),
    publicUrl: optional(source, 'AGORA_PUBLIC_URL', '').replace(/\/+$/, ''),

    postMaxChars,
    // Sixty an hour is one a minute sustained, which no human does and every script does. It is a
    // floor on abuse, not a budget somebody is meant to spend.
    postsPerHour: integer(source, 'AGORA_POSTS_PER_HOUR', 60, 1, 10_000),
    // Tighter than posts on purpose: an unsolicited message is the one thing on a social network
    // that arrives whether or not the recipient asked, so the rate at which strangers can produce
    // one is the rate at which the product can be used against somebody.
    whispersPerHour: integer(source, 'AGORA_WHISPERS_PER_HOUR', 30, 1, 10_000),
    followsPerHour: integer(source, 'AGORA_FOLLOWS_PER_HOUR', 100, 1, 10_000),
    // Fifty. Big enough that "load more" is not a chore, small enough that a scraper pays for the
    // graph a page at a time.
    pageSizeMax: integer(source, 'AGORA_PAGE_SIZE_MAX', 50, 1, 200),
    postingEnabled: boolean(source, 'AGORA_POSTING_ENABLED', true),
    notificationTtlDays: integer(source, 'AGORA_NOTIFICATION_TTL_DAYS', 90, 1, 3_650),
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed through
 * the telemetry package: nothing that can itself fail may sit between a configuration error and
 * the report of it.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
