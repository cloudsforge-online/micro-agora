/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable the service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it.
 *
 * Two things are worth reading twice.
 *
 * **There is no database URL, and there must never be one.** This service composes; it does not
 * remember. A connection string here would be the first step towards a table holding a stale copy
 * of a balance the ledger owns.
 *
 * **There are seven upstream tokens, not one.** AD-05 gives the reason a BFF exists at all, and one
 * of them is that "separating them lets Hub's BFF hold a *scoped* service credential per upstream
 * rather than being trusted with everything". One shared credential is the `PAY_SERVICE_TOKEN`
 * shape the estate is trying to be rid of: it makes a compromise of the most exposed surface in
 * the estate — this one, the fan-out — a compromise of all eight peers at once. Seven tokens are
 * seven rotations, and that cost is the point. (Seven, not six, since `notify` became the eighth
 * upstream — see `UpstreamUrls.notify` for the measurement that made it one.)
 *
 * Identity has no token here, deliberately. `GET /auth/me` and `GET /mfa/factors` are guarded by
 * `authenticateUser`, which refuses a service token outright, so there is no credential this
 * service could hold that would reach them. Identity is called with the caller's own bearer,
 * forwarded. See `upstreams.ts` for why that is safe and what route would replace it.
 */

import { hostname } from 'node:os'
import { SecretError, assertServiceCredential } from '@cloudsforge/secrets'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment.
 */
export const SERVICE = 'hub-api'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

/**
 * THE `PLACEHOLDERS` SET THAT USED TO BE HERE IS GONE, AND ITS ABSENCE IS THE FIX.
 *
 * It held eight exact strings and was paired with a 24-character floor. Neither could fail for the
 * value that actually reached 44 containers on both networks: micro-org #142's
 * `estate-only-outbox-secret-00000000000000` is 40 characters and was on nobody's list. A check
 * that cannot fail is worse than no check, because the absence of an alarm gets read as the
 * absence of a problem — and this service is the estate's highest fan-out surface, so the
 * credential it holds is the one whose compromise reaches six peers at once.
 *
 * A deny-list of exact strings is structurally unable to work: the next placeholder somebody
 * writes is, by definition, not on it. `@cloudsforge/secrets` asserts the SHAPE of a generated
 * value instead, which is the property a placeholder cannot have. It is imported rather than
 * copied so that this service cannot drift from the other sixteen.
 *
 * `requiredSecret` went with it and is not replaced: this service reads no `OUTBOX_SIGNING_SECRET`
 * and no other mandatory secret. It owns no database and publishes no events, so it is on neither
 * side of the estate's event bus — see the `_noDatabase` note in `package.json`. The one secret it
 * holds is the credential below, and that one is optional.
 */

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
 * A SERVICE CREDENTIAL that may be absent, but must be real if present.
 *
 * ── ABSENCE IS A SUPPORTED MODE, AND IT STAYS ONE ──────────────────────────────────────────────
 *
 * Absent is a deployment that has not been given one yet; it returns `null` and `/readyz` reports
 * it as a HARD failure, so the replica never takes traffic. The empty check therefore stays AHEAD
 * of the assertion, because compose interpolates `${HUB_API_IDENTITY_CREDENTIAL:-}` and an unset
 * credential arrives as the EMPTY STRING — that is the supported mode, not a malformed one, and it
 * is the mode CI's `/livez` smoke test boots the image in. Turning it into `exit(1)` would fail
 * that job rather than this service.
 *
 * What is not supported is a value that is present and rubbish: a short placeholder is a deployment
 * that believes it HAS a credential, and it fails on its first call to a peer with a 401 that reads
 * as "the peer rejected hub-api" rather than "nobody set this variable".
 *
 * ── WHY NOT `assertGeneratedSecret` ────────────────────────────────────────────────────────────
 *
 * Because it would refuse every credential this estate has ever minted, and hub-api would exit 1 at
 * boot on BOTH networks. A credential is `cfsc_` + base64url, which is neither wholly base64 nor
 * wholly hex — the underscore in its own prefix disqualifies it. Measured live: the testnet
 * credential also CONTAINS A HYPHEN while the mainnet one does not, so the "no hyphens" instinct
 * that is correct for a generated HMAC key would have booted mainnet and killed testnet.
 *
 * It also refuses a JWT BY NAME, which is the mistake this variable exists to end: the six
 * `HUB_*_TOKEN` variables it replaced each held a 600-second token read once at boot, and pasting
 * one of them in here would be the ten-minute cliff wearing the fix's clothes (micro-org #222).
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

/** Where every upstream lives. Named by service so a log line naming one is unambiguous. */
export interface UpstreamUrls {
  readonly ledger: string
  readonly wallet: string
  readonly identity: string
  readonly billing: string
  readonly activity: string
  readonly pricing: string
  readonly policy: string
  /**
   * `notify`, the eighth, and REQUIRED like the other seven rather than optional.
   *
   * It was absent for the life of this service, and the cost of that absence was not a missing
   * feature — it was a WRONG PAGE. `dashboard.ts` composed a `notifications` tile that was
   * hard-coded `unavailable`, so `degraded` contained `notifications` on every response, and
   * hub-web turns that list into a banner reading "notifications is not showing current data".
   * Every signed-in Overview in the estate carried it, permanently, on both networks: measured
   * live on 2026-08-11, `hub_tile_status_total{tile="notifications",status="unavailable"}` was 32
   * of 32 dashboard compositions on mainnet and 29 of 29 on testnet — 100%, since boot, while
   * `notify` held 172 and 77 real notifications for 85 and 37 users respectively.
   *
   * Required, therefore. Optional would make "nobody configured this" and "notify is having a bad
   * minute" the same observation, which is exactly the state that lasted this long unnoticed: a
   * hole nothing could report is a hole nobody fixes. A deployment that has not been given the URL
   * now fails to start and says which variable is missing, which is a fault an operator can act on
   * in a minute.
   */
  readonly notify: string
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  readonly upstreams: UpstreamUrls
  /**
   * **The one long-lived credential this service exchanges for six short-lived tokens.**
   *
   * It replaces `HUB_LEDGER_TOKEN`, `HUB_WALLET_TOKEN`, `HUB_BILLING_TOKEN`,
   * `HUB_ACTIVITY_TOKEN`, `HUB_PRICING_TOKEN` and `HUB_POLICY_TOKEN` — six 600-second tokens
   * (identity/src/tokens.ts) read once at boot. Ten minutes into any deployment all six expired
   * and every tile on the dashboard went `unavailable`; nothing could re-mint them, because
   * minting requires the `admin` role.
   *
   * ONE SECRET, STILL SIX NARROW TOKENS. The six variables existed because they carry different
   * scopes — this is the highest fan-out surface in the estate, and `wallet:read` and nothing else
   * is the whole point of AD-05. That separation is kept: identity reads the service off the
   * credential ROW and never off the request, so one credential mints everything hub-api is
   * allowed, and the scope set is a request parameter rather than a second secret. Seven providers,
   * seven caches, seven narrow tokens, one revocable secret.
   *
   * Identity is still absent by construction — see the file header. Its two routes refuse a
   * service token, so those calls carry the caller's own bearer.
   *
   * OPTIONAL, so the image can BOOT for CI's `/livez` smoke test, whose environment is fixed in a
   * workflow file. The absence is not silent: `/readyz` reports `identity-credential` as a HARD
   * failure and every upstream call fails closed with 503.
   */
  readonly identityCredential: string | null
  /** Whether any of the six retired `HUB_*_TOKEN` variables is still set. Reported at boot. */
  readonly legacyServiceTokenPresent: boolean
  /**
   * The ceiling on a whole dashboard request.
   *
   * The dashboard's budget is the slowest tile, not the sum: the fan-out is concurrent, so seven
   * upstreams at 400ms each cost 400ms, and this number is what a single pathological upstream is
   * allowed to cost. Past it the tile is `unavailable` and the page is still served.
   */
  /**
   * `CF_NETWORK_SINGLE`: the estate to assume when no `CF-Network` header arrives. For `pnpm dev`,
   * which has no gateway in front of it. NEVER set in production — hub-api holds no database, so
   * the header is the whole of its isolation, and a default would render one estate's dashboard
   * out of the other estate's numbers. See micro-deploy `docs/network-consolidation.md`.
   */
  readonly singleNetwork: string
  readonly dashboardDeadlineMs: number
  /**
   * The default ceiling on one upstream call, retries included. Necessarily below the dashboard
   * deadline: an upstream allowed to spend the whole budget could make the deadline unreachable
   * for every other tile if the fan-out ever became sequential.
   */
  readonly upstreamDeadlineMs: number
  /** Consecutive transport or 5xx faults before an upstream's breaker opens. */
  readonly circuitThreshold: number
  /** How long a breaker stays open before letting one probe through. */
  readonly circuitResetMs: number
  /**
   * Names this replica in logs. Defaults to the hostname, which is the container id under compose
   * and the pod name under Kubernetes — in both cases the thing an operator would search for.
   */
  readonly instanceId: string
  /**
   * **Whether the estate this process belongs to runs a mining pool.** Served by
   * `GET /v1/deployment`, and the only deploy fact this service reports about itself.
   *
   * ── WHY A BFF ANSWERS A QUESTION ABOUT NGINX ──────────────────────────────────────────────
   *
   * hub-web has always answered it from `/deployment.json`, a document its own nginx renders from
   * this same variable. That is the right answer to "does the estate SERVING this page run a
   * pool" and it stopped being the question. Under the combined view one set of frontends is
   * served from the mainnet hostnames and re-points its reads at whichever estate the reader is
   * viewing, so a mainnet-served page viewing testnet asked `pool-testnet` for `/v1/pool` — and
   * testnet runs no micro-pool, deliberately and permanently, so it got the 502 the presence
   * mechanism exists to stop rendering. "The pool could not be read", over a working EMBER miner.
   *
   * The document cannot answer it across estates: every `-testnet` WEB hostname 302s to its
   * mainnet sibling, so a cross-estate read of `/deployment.json` reads the reader's own estate
   * back. `/v1` is the half of those hostnames that still answers from the other estate. So the
   * fact is served here, by the one service that already shares a hostname with that page.
   *
   * ── `present` IS THE ANSWER TO EVERY AMBIGUITY ────────────────────────────────────────────
   *
   * Only the exact string `absent` means "no pool here"; unset, empty, misspelt and mixed-case all
   * mean `present`. That asymmetry is the safety of the whole mechanism and it is hub-web's rule,
   * kept identical here on purpose: silence must never become a page telling somebody with
   * hardware pointed at a working pool that the pool does not exist.
   */
  readonly poolApi: 'present' | 'absent'
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/**
 * Pure over its source so the failure paths are testable without mutating the process. The eager
 * export below is what makes the service fail fast.
 */
export function loadEnv(source: Source = process.env, hostname = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const dashboardDeadlineMs = integer(source, 'HUB_DASHBOARD_DEADLINE_MS', 2_500, 100, 30_000)
  const upstreamDeadlineMs = integer(source, 'HUB_UPSTREAM_DEADLINE_MS', 1_500, 50, 30_000)
  if (upstreamDeadlineMs > dashboardDeadlineMs) {
    // Caught here rather than at the call site because the failure it produces is subtle: the
    // dashboard would appear to work and would simply never degrade, because no tile could ever
    // reach its own deadline before the page had already given up on it.
    throw new EnvError(
      `HUB_UPSTREAM_DEADLINE_MS (${upstreamDeadlineMs}) must not exceed ` +
        `HUB_DASHBOARD_DEADLINE_MS (${dashboardDeadlineMs})`,
    )
  }

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    upstreams: {
      ledger: required(source, 'LEDGER_URL'),
      wallet: required(source, 'WALLET_URL'),
      identity: required(source, 'IDENTITY_URL'),
      billing: required(source, 'BILLING_URL'),
      activity: required(source, 'ACTIVITY_URL'),
      pricing: required(source, 'PRICING_URL'),
      policy: required(source, 'POLICY_URL'),
      notify: required(source, 'NOTIFY_URL'),
    },
    // Optional by design: see the field comment. The absence is caught by `/readyz`, which is a
    // check that can fail, rather than by a boot CI cannot perform.
    identityCredential: optionalCredential(source, 'HUB_API_IDENTITY_CREDENTIAL'),
    legacyServiceTokenPresent: [
      'HUB_LEDGER_TOKEN',
      'HUB_WALLET_TOKEN',
      'HUB_BILLING_TOKEN',
      'HUB_ACTIVITY_TOKEN',
      'HUB_PRICING_TOKEN',
      'HUB_POLICY_TOKEN',
    ].some((name) => (source[name]?.trim() ?? '').length > 0),
    singleNetwork: optional(source, 'CF_NETWORK_SINGLE', ''),
    dashboardDeadlineMs,
    upstreamDeadlineMs,
    circuitThreshold: integer(source, 'HUB_CIRCUIT_THRESHOLD', 5, 1, 100),
    circuitResetMs: integer(source, 'HUB_CIRCUIT_RESET_MS', 10_000, 100, 300_000),
    instanceId: optional(source, 'INSTANCE_ID', hostname || 'unknown'),
    // Not `required`, and not validated against a pair of allowed strings: an estate that has
    // never heard of this variable must keep behaving exactly as it did, and a deploy that
    // misspells it must degrade to the answer that costs nothing rather than refuse to boot.
    poolApi: optional(source, 'POOL_API_PRESENCE', 'present') === 'absent' ? 'absent' : 'present',
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
