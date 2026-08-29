/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repository declares the variables it needs; the deploy
 * provides exactly those" — is a property of this file. Every variable this service reads is named
 * here and nowhere else, and `env.test.ts` asserts that this file and `.env.example` agree in BOTH
 * directions.
 *
 * Two behaviours are copied from the siblings, deliberately:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** `.env.example` ships `CHANGE_ME`, and
 *      `CHANGE_ME` does not boot.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHAT THIS SERVICE DELIBERATELY HAS NO VARIABLE FOR.**
 *
 * There is no `COMMUNITY_ADMIN_TOKEN`, no break-glass credential and no "skip the timelock"
 * switch. The second is the one worth naming: a variable that could shorten or bypass a timelock
 * would be a variable that spends a community's treasury on somebody's say-so, and the whole of
 * AD-15 is that no single party can do that. The timelock is a column on the proposal and a
 * trigger in the database; there is nothing in the environment that can move it. `env.test.ts`
 * asserts their absence by name.
 *
 * There is no `COMMUNITY_MIN_TIMELOCK_MINUTES` either, and that is the same decision: the floor
 * lives in `proposals.ts` as a constant, because a governance guarantee that a deploy can lower is
 * not a guarantee.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module via `NODE_OPTIONS`,
 * which reads `OTEL_EXPORTER_OTLP_ENDPOINT` from the environment itself. That is why no `OTEL_*`
 * variable appears here.
 */

import { hostname } from 'node:os'
import {
  assertGeneratedSecret,
  assertGeneratedSecretList,
  assertServiceCredential,
} from '@cloudsforge/secrets'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a
 * migration advisory lock.
 */
export const SERVICE = 'community'

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
 * A SERVICE CREDENTIAL that may be absent, but must be real if present.
 *
 * ── WHAT THIS REPLACED, AND WHY THE OLD GUARD WAS DEFENDING THE DEFECT ─────────────────────────
 *
 * `COMMUNITY_SERVICE_CREDENTIAL` used to be read by a local `requiredSecret` — a deny-list of nine
 * exact strings plus a 24-character floor. Measured on the live estate on 2026-08-05, the value it
 * was letting through was a JWT that had been **expired for 26 hours** on a container reporting
 * healthy, because `/livez` never presents it to anybody. That guard was not merely weak, it was
 * defending the defect: a service token is `ey…` + several hundred characters, so it cleared the
 * floor comfortably and appeared on no list (micro-org #222, and the cliff itself #197).
 *
 * `assertServiceCredential` refuses a JWT **by name**, which is what closes #222 for this variable:
 * the value that was deployed now fails at boot with a line naming the ten-minute life, instead of
 * working for ten minutes and then refusing every treasury spend for ever.
 *
 * ── ABSENCE IS A SUPPORTED MODE, AND `null` IS HOW IT IS SAID ──────────────────────────────────
 *
 * `null` rather than `undefined`, and rather than `''`: an empty string is falsy where a caller
 * tests for it and truthy in `Object.keys`, so a mode chosen by `env.x ? … : …` would silently
 * agree with an operator who set the variable to nothing. `null` is the absence, said once.
 *
 * The empty check stays AHEAD of the assertion, because compose interpolates
 * `${COMMUNITY_IDENTITY_CREDENTIAL:-}` and an unset credential arrives as the EMPTY STRING. That is
 * a supported mode, not a malformed one — and `migrator.ts` shares this environment while dialling
 * nobody at all, so turning it into `exit(1)` would fail `community-migrate`, which the whole
 * estate waits on through `service_completed_successfully`.
 *
 * ── WHY NOT `assertGeneratedSecret`, WHICH GUARDS THE OUTBOX KEYS ABOVE ────────────────────────
 *
 * Because it would refuse every credential identity has ever minted, and community would exit 1 at
 * boot on BOTH networks. A credential is `cfsc_` + base64url, which is neither wholly base64 nor
 * wholly hex — the underscore in its own prefix disqualifies it. And measured live: **the testnet
 * credential CONTAINS A HYPHEN while the mainnet one does not**, so the "no hyphens" instinct that
 * is exactly right for `OUTBOX_SIGNING_SECRET` would have booted mainnet and killed testnet. The
 * fixture in `env.test.ts` is hyphenated on purpose so that mistake fails CI rather than one estate.
 *
 * It throws `SecretError` rather than `EnvError`, deliberately and for the same reason
 * `requiredSigningSecret` does: the class says a value failed the SHAPE check rather than this
 * file's own parsing, and `fatalConfig` reads `err.message` off `unknown` so the boot line is
 * identical either way.
 */
function optionalCredential(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  assertServiceCredential(name, value)
  return value
}

/**
 * The estate's shared event-bus HMAC key, held to a SHAPE rather than to a deny-list.
 *
 * `requiredSecret` above cannot be the guard for this one. It refuses a fixed list of exact strings
 * and anything under 24 characters, and the value that sat on 54 lines of a PUBLIC compose file —
 * `estate-only-outbox-secret-00000000000000` — was on no list and was 40 characters, so it passed
 * every service in the estate (micro-org #142). A check that could not fail read as the absence of
 * a problem.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. It has no NODE_ENV exemption and no escape
 * hatch, so CI generates a real value per run rather than being let through.
 *
 * `required` alone in front of it, deliberately: the old local `requiredSecret` was a strict subset
 * of this shape check, and running it first would answer a 40-character placeholder with "must be
 * at least 24 characters" — a message that is true, useless, and points the operator at the wrong
 * property. That helper is gone from this file entirely; the last variable holding it up,
 * `COMMUNITY_SERVICE_CREDENTIAL`, was the one whose live value it was letting through (#222).
 *
 * **It is for the outbox key family and nothing else.** The two credential variables go to
 * `optionalCredential` above: they are issued by identity in its own format, not generated with
 * `openssl`, and demanding base64 of them would refuse the correct value on both networks.
 *
 * It throws `SecretError` rather than `EnvError`, which is deliberate — the class is distinct so a
 * configuration failure can be told from every other kind, and `fatalConfig` below reads
 * `err.message` off `unknown`, so the boot line is identical either way.
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
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

/**
 * The secrets the inbound event route accepts, newest first.
 *
 * A LIST, not a value, because rotation without an overlap window means every producer must change
 * secret in the same instant this service does — and that instant does not exist during a rolling
 * deploy.
 *
 * **Every entry faces exactly the bar a single secret faces — `assertGeneratedSecretList` is
 * `assertGeneratedSecret` per entry, and there is no weaker rule for the outgoing key.** In a
 * rotation overlap window the outgoing key is the one an attacker already holds if it leaked, and
 * "just for the drain" is exactly how a placeholder survives the rotation meant to remove it.
 *
 * The local placeholder and length loop that used to sit here is GONE rather than kept in front:
 * it is a strict subset of the shape check, and running it first answers a 40-character placeholder
 * with "must each be at least 24 characters" — true, useless, and about the wrong property
 * (micro-org #142). What is kept is what the shape check does not know about: the empty-list
 * refusal, whose message names this service's own variable, and the duplicate refusal below.
 */
export function parseSecretList(raw: string, name: string): readonly string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (entries.length === 0) throw new EnvError(`${name} is required — at least one secret`)
  assertGeneratedSecretList(name, entries)
  if (new Set(entries).size !== entries.length) {
    // A duplicated secret makes "which key verified this" ambiguous, and that answer is what tells
    // an operator whether a rotation has finished.
    throw new EnvError(`${name} lists the same secret twice`)
  }
  return Object.freeze(entries)
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second here fails the build rather than review.
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
  /**
   * Where identity is, for `POST /service-tokens/exchange` — the ORIGIN, not the JWKS path.
   *
   * DERIVED from `IDENTITY_ISSUER` rather than demanded as a fourth identity variable, and the
   * reasoning is not convenience: the issuer of a token is by definition where that token came
   * from, so deriving keeps the two in step. A deployment that exchanged a credential against one
   * identity while trusting the JWKS of another would fail with a signature error nobody would ever
   * read as a configuration mistake. It also means this fix needs no new line in any deploy
   * manifest — `IDENTITY_ISSUER` is already set everywhere community runs.
   *
   * `IDENTITY_URL` overrides it for the one deployment where the two genuinely differ: an issuer
   * published under a public name and dialled internally. Same spelling and same default as
   * `ledger/src/env.ts`, `market/src/env.ts` and `foresight/src/env.ts`, because a
   * variable that means the same thing in four services must not be spelled four ways.
   */
  readonly identityUrl: string
  readonly instanceId: string

  /** Secrets accepted on `POST /v1/events`, the internal inbox. */
  readonly ingestSecrets: readonly string[]
  /** Signs this service's OWN outbox deliveries to internal subscribers. */
  readonly outboxSigningSecret: string

  /**
   * The ledger. A **hard** dependency (07-dependency-map.md, `money-write`): a treasury spend
   * is a ledger posting, and there is no version of this service that can execute one without it.
   */
  readonly ledgerBaseUrl: string
  readonly ledgerDeadlineMs: number

  /**
   * Policy. A **hard, fail-closed** dependency (07-dependency-map.md) for treasury spend
   * approval. Unreachable means the spend does not happen — see `policyclient.ts` for what this
   * service had to do about policy's action registry having no `community.*` entry.
   */
  readonly policyBaseUrl: string
  readonly policyDeadlineMs: number

  /**
   * The indexer, for token-gating re-evaluation. Optional, and its absence is a SUPPORTED mode:
   * with no URL the holdings oracle answers "unknown", and an unknown holding never demotes
   * anybody. See `gating.ts` for why that is the only safe default while the indexer has no
   * balance route.
   */
  readonly indexerBaseUrl: string | null
  readonly indexerNetwork: string
  readonly indexerDeadlineMs: number

  /**
   * **The long-lived credential this process exchanges for a live service token.**
   *
   * This is the fix for micro-org #222. `COMMUNITY_SERVICE_CREDENTIAL` below held a **token**, and a
   * token minted by identity lives 600 seconds (`identity/src/tokens.ts`). `index.ts` read it
   * once at import — `const token = () => env.serviceCredential` — and handed that one string to the
   * ledger, to policy and to the indexer oracle, so this service authenticated once per bootstrap
   * and never again while the container ran for days.
   *
   * The consequence here is worse than a failed call, and worse than in market where the same seam
   * was fixed first. A 401 from policy is a 4xx, so `policyclient.ts` reads it as policy
   * DECIDING and returns `{decision: 'deny', reasons: ['policy_401']}`; `executions.ts` turns
   * that into `SpendRefusedError`; and `jobs.ts` **swallows** a refusal, because a refusal is
   * an answer and retrying it would turn one decision into eight. So a dead credential does not
   * stall a treasury spend — it **permanently refuses every one of them**, records the refusal
   * against the community, and completes the job. A community's passed vote is answered "policy said
   * no" when policy was never asked.
   *
   * `@cloudsforge/auth`'s `ServiceTokenProvider` exchanges this at `POST /service-tokens/exchange`
   * (`identity/src/server.ts`) for a 600-second token and refreshes at a jittered 80% of its
   * life on traffic. The exchange consumes nothing, so N replicas boot from one credential and a
   * restart days later still works. **The 600 seconds is deliberately unchanged**: rotation IS
   * expiry, and a longer TTL is the same defect arriving later and hurting more.
   *
   * `null` is a supported mode — see `optionalCredential`. `index.ts` says at `fatal` what will
   * break when it is.
   */
  readonly identityCredential: string | null

  /**
   * The pre-minted service token this process used to present to the ledger, policy and the indexer.
   *
   * **VESTIGIAL, AND IT HAS A STATED END.** It exists only so a container that is redeployed with
   * the new image before its environment gains `COMMUNITY_IDENTITY_CREDENTIAL` starts in `static`
   * mode — degraded, loudly, and identically to how it behaved before — rather than refusing to
   * boot. `identityCredential` always wins when both are set (`upstreams.ts`), which is the state
   * the estate will actually be in during the rollout.
   *
   * It is removed from this file once `COMMUNITY_IDENTITY_CREDENTIAL` is set in the estate compose
   * and the release overlay, and `index.ts` logs `fatal` for exactly as long as it is being used.
   * The same variable in market and foresight carries the same note and the same end.
   *
   * Named `..._SERVICE_CREDENTIAL` rather than `..._SERVICE_TOKEN` for the reason recorded in
   * 18-build-status: the estate's `secret-hygiene` check reads any `*TOKEN*` variable carrying a
   * value as a credential somebody pasted in and forgot. That check is right — a value that does
   * not say it is fake should be treated as real. The NAME was never the problem; what it held was.
   * It now faces `assertServiceCredential`, so the JWT that was actually deployed under it is
   * refused at boot rather than accepted and used until minute ten.
   */
  readonly serviceCredential: string | null

  /** How often a token-gated membership is re-checked, and how many per pass. */
  readonly gateRecheckIntervalHours: number
  readonly gateRecheckBatchSize: number

  /**
   * How long an idempotency claim survives.
   *
   * The floor is the safety argument: expiring a key EARLY means the next replay of it runs the
   * work again, and on `POST /internal/proposals/:id/execute` that is a second treasury spend.
   */
  readonly idempotencyTtlDays: number
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const indexerBaseUrl = source['INDEXER_BASE_URL']?.trim()

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'COMMUNITY_DATABASE_URL'),
    databaseUrlTestnet: optional(source, 'COMMUNITY_DATABASE_URL_TESTNET', ''),
    singleNetwork: optional(source, 'CF_NETWORK_SINGLE', ''),
    databasePoolMax: integer(source, 'COMMUNITY_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    ingestSecrets: parseSecretList(required(source, 'COMMUNITY_INGEST_SECRETS'), 'COMMUNITY_INGEST_SECRETS'),
    outboxSigningSecret: requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET'),

    ledgerBaseUrl: required(source, 'LEDGER_BASE_URL'),
    ledgerDeadlineMs: integer(source, 'LEDGER_DEADLINE_MS', 5_000, 100, 60_000),

    policyBaseUrl: required(source, 'POLICY_BASE_URL'),
    policyDeadlineMs: integer(source, 'POLICY_DEADLINE_MS', 3_000, 100, 60_000),

    indexerBaseUrl: indexerBaseUrl && indexerBaseUrl.length > 0 ? indexerBaseUrl : null,
    indexerNetwork: optional(source, 'INDEXER_NETWORK', 'mainnet'),
    indexerDeadlineMs: integer(source, 'INDEXER_DEADLINE_MS', 5_000, 100, 60_000),

    identityCredential: optionalCredential(source, 'COMMUNITY_IDENTITY_CREDENTIAL'),
    serviceCredential: optionalCredential(source, 'COMMUNITY_SERVICE_CREDENTIAL'),

    gateRecheckIntervalHours: integer(source, 'COMMUNITY_GATE_RECHECK_INTERVAL_HOURS', 6, 1, 720),
    gateRecheckBatchSize: integer(source, 'COMMUNITY_GATE_RECHECK_BATCH_SIZE', 100, 1, 5_000),

    idempotencyTtlDays: integer(source, 'COMMUNITY_IDEMPOTENCY_TTL_DAYS', 30, 1, 400),
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand, built from a literal rather than routed through the
 * telemetry package: nothing that can itself fail may sit between a configuration error and the
 * report of it.
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
