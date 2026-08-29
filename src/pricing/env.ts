/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable the service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from the estate's custody service, which is the only
 * place that gets this right today:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic.
 */

import { hostname } from 'node:os'
import { assertGeneratedSecret } from '@cloudsforge/secrets'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a
 * migration advisory lock.
 */
export const SERVICE = 'pricing'

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
 * The estate's shared event-bus HMAC key, held to a shape rather than to a deny-list.
 *
 * THE LOCAL `requiredSecret` AND `PLACEHOLDERS` ARE GONE RATHER THAN KEPT IN FRONT — they were
 * DEAD CODE, called by nothing, sitting in the file looking like a control. They refused a fixed
 * list of exact strings and anything under 24 characters, and the value that sat on 54 lines of a
 * PUBLIC compose
 * file — `estate-only-outbox-secret-00000000000000` — was on no list and was 40 characters, so it
 * passed every service in the estate (micro-org #142). A check that could not fail read as the
 * absence of a problem, and it was live on 44 containers across both networks.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. It has no NODE_ENV exemption and no escape
 * hatch, so CI generates a real value per run rather than being let through.
 *
 * `required` in front of it and nothing else, deliberately: the deleted checks were a strict subset of
 * the stronger ones, and running them first would answer a 40-character placeholder with "must be
 * at least 24 characters" — a message that is true, useless, and points the operator at the wrong
 * property.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name)
  assertGeneratedSecret(name, value)
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
    throw new EnvError(`${name} must be an integer between ${min} and ${max} (got ${raw})`)
  }
  return value
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
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /** HMAC key for outbound event signatures, so a subscriber can prove an event came from us. */
  readonly outboxSigningSecret: string
  readonly instanceId: string
  /**
   * How many of the four sources must answer for a round to be accepted.
   *
   * Two is the floor the estate already runs at, and it is the smallest number at which the median
   * is not simply one exchange's opinion. Setting it to 1 is permitted by the range only so that a
   * single-source development environment is possible; it is not a production value, and the
   * divergence check below is inert at that setting because there is nothing to diverge from.
   */
  readonly minSources: number
  /**
   * The spread across the accepted sources, in basis points, past which the WHOLE ROUND is
   * rejected. One of the quotes is wrong and there is no way to tell which, so none of them is
   * usable — taking the median of a set that contains a bad print would launder it into a rate.
   */
  readonly maxDivergenceBps: number
  /**
   * Fail-closed staleness. Past this age a market rate is unusable and says why.
   *
   * A stale quote is not a discount, it is an unknown price, and settling a conversion against one
   * is the money leak this oracle exists to close.
   */
  readonly maxAgeSeconds: number
  /** Per-source HTTP deadline. A slow exchange must not hold the whole round open. */
  readonly sourceTimeoutMs: number
  /** How often the leased refresh job runs. One refresh for the estate, not one per replica. */
  readonly refreshSeconds: number
  /**
   * The platform's conversion spread, applied symmetrically in both directions.
   *
   * It has to run AGAINST the user both ways or a round trip is free money: quoting a purchase at
   * the sell rate lets anyone convert out and straight back in at a profit, repeatedly.
   */
  readonly conversionSpreadBps: number
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/**
 * Pure over its source so the failure paths are testable without mutating the process. The eager
 * export below is what makes the service fail fast.
 */
export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const minSources = integer(source, 'PRICING_MIN_SOURCES', 2, 1, 4)
  // A spread of 10_000 bps would divide by zero on the buy leg — see `applySpreadBuy`. The bound
  // is set far below that anyway: 2_000 bps is a 20% spread, which no honest platform charges.
  const conversionSpreadBps = integer(source, 'PRICING_CONVERSION_SPREAD_BPS', 100, 0, 2_000)

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'PRICING_DATABASE_URL'),
    databaseUrlTestnet: optional(source, 'PRICING_DATABASE_URL_TESTNET', ''),
    singleNetwork: optional(source, 'CF_NETWORK_SINGLE', ''),
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'PRICING_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
    minSources,
    maxDivergenceBps: integer(source, 'PRICING_MAX_DIVERGENCE_BPS', 200, 1, 10_000),
    maxAgeSeconds: integer(source, 'PRICING_MAX_AGE_SECONDS', 300, 5, 86_400),
    sourceTimeoutMs: integer(source, 'PRICING_SOURCE_TIMEOUT_MS', 4_000, 100, 60_000),
    refreshSeconds: integer(source, 'PRICING_REFRESH_SECONDS', 60, 5, 3_600),
    conversionSpreadBps,
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed through
 * the telemetry package: nothing that can itself fail may sit between a configuration error and
 * the report of it. The message is the one `loadEnv` produced, which by construction never
 * contains a value.
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
