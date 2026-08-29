/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable the service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from custody, which is the only place in the frozen
 * estate that gets this right:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic, and a placeholder that boots is a placeholder that reaches production.
 *
 * ## The image backend is OPTIONAL, and that is the whole point
 *
 * `AZURE_FOUNDRY_*` is optional. A service that refused to boot without a reachable image model
 * would be a service that cannot create a brand kit, read one, or serve its own health while the
 * owner is still deciding which model to deploy. Absent configuration is reported as `degraded`
 * through a SOFT readiness probe and through `GET /v1/backend`. It is never a boot failure and
 * never a 500.
 *
 * ## The Foundry key is a spend credential
 *
 * It is read here, held in one field, and passed to exactly one module. It is never logged, never
 * put in a probe `detail`, never echoed by `GET /v1/backend`, and never written to a committed
 * file. `redactedEndpoint` below exists so an operator can be told WHICH resource is configured
 * without being shown anything they could spend.
 */

import { hostname } from 'node:os'
import { assertGeneratedSecret, assertOpaqueSecret } from '@cloudsforge/secrets'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a
 * migration advisory lock.
 */
export const SERVICE = 'studio'

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
 * THE LOCAL `requiredSecret` AND `PLACEHOLDERS` ARE GONE RATHER THAN KEPT IN FRONT. They refused a
 * fixed list of exact strings and anything under 24 characters, and the value that sat on 54 lines
 * of a PUBLIC compose file — `estate-only-outbox-secret-00000000000000` — was on no list and was 40
 * characters, so it passed every service in the estate (micro-org #142). A check that could not
 * fail read as the absence of a problem, and it was live on 44 containers across both networks.
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
 *
 * THE FOUNDRY KEY IS NOT HELD TO THIS RULE, and that is a decision rather than an oversight: it is
 * a VENDOR-issued credential, so its alphabet and length are Azure's to choose, and demanding
 * base64 of it would refuse a perfectly valid key the day that format changes. It is held to
 * `assertOpaqueSecret` instead — the markers, a 16-character floor and a 2.0-bit floor, all of
 * which are alphabet-independent — rather than to the deny-list it used to have. Two classes,
 * because the estate is the issuer of one of these values and not of the other. See below.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name)
  assertGeneratedSecret(name, value)
  return value
}

/**
 * A THIRD-PARTY secret that may be absent, but must not be a placeholder when it is present.
 *
 * ── WHY THIS IS `assertOpaqueSecret` AND NOT THE SIGNING-KEY RULE ABOVE ───────────────────────
 *
 * Because the alphabet belongs to Azure. `assertGeneratedSecret` demands base64 or hex and nothing
 * else, which the estate can insist on for a key it GENERATES itself with `openssl rand`; it has
 * no standing to demand it of a value a vendor issued. A guard that refuses a working vendor
 * credential is a guard an operator deletes at 3am, and then the estate has no guard at all.
 *
 * Measured on the live estate, both networks, 2026-08-06 — the same key on each:
 *
 *     AZURE_FOUNDRY_API_KEY   84 characters, 5.164 bits per character
 *
 * It happens to be base64 today. That is Azure's choice this year and not a rule this file may
 * rely on, which is exactly why the class is opaque rather than generated.
 *
 * ── WHAT IS STILL ASSERTABLE, AND IT IS THE PART THAT CATCHES REAL DEFECTS ────────────────────
 *
 * The placeholder markers, which are alphabet-independent, plus a floor of 16 characters and a
 * Shannon floor of 2.0 that rejects `0000…`. The deny-list this replaces held eight exact strings
 * and no floor at all, so `estate-placeholder-token-0000000000000000` — 40 characters, live in
 * this estate's compose file under other names — passed it. The marker list refuses that, and
 * `estate-only-…`, and `ci-only-not-a-real-secret-…`, without knowing anything about Azure's
 * format. A JWT is refused too: a minted token in a slot read once at boot is dead on the next
 * restart at the latest (micro-org #222).
 *
 * Still no vendor-specific length or prefix rule: inventing one would refuse a perfectly valid
 * credential the day Azure changes its format.
 */
function optionalSecret(source: Source, name: string): string {
  const value = source[name]?.trim() ?? ''
  if (value.length === 0) return ''
  assertOpaqueSecret(name, value)
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
 * An HTTPS base URL with no path and no trailing slash.
 *
 * Checked rather than trusted because every Azure request is built by string concatenation from
 * it. A trailing slash produces `…azure.com//openai/…`, which 404s in a way that is indistinguish-
 * able from "the deployment does not exist" — and this service's whole job is to tell those apart.
 */
function baseUrl(source: Source, name: string, fallback: string): string {
  const raw = optional(source, name, fallback)
  if (raw.length === 0) return ''
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new EnvError(`${name} must be an absolute URL (got ${raw.slice(0, 60)})`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new EnvError(`${name} must be http or https`)
  }
  if (parsed.search || parsed.hash) throw new EnvError(`${name} must not carry a query or fragment`)
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

/**
 * A model name, as Black Forest Labs spells it.
 *
 * **Dots are significant and this is the trap.** The deployed model is `FLUX.2-pro`. The URL path
 * segment for the same model is `flux-2-pro`, and sending `flux-2-pro` as the `model` field
 * returns `404 DeploymentNotFound` — verified against the live resource. Path spelling and model
 * spelling are different strings, so `.` must be in the permitted set here or a correct
 * configuration would be refused at boot.
 */
function modelName(source: Source, name: string, fallback: string): string {
  const raw = optional(source, name, fallback)
  if (raw.length === 0) return ''
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(raw)) {
    throw new EnvError(
      `${name} must be 1-64 characters of letters, digits, '.', '-' or '_' (got ${raw})`,
    )
  }
  return raw
}

/**
 * The provider path under the endpoint, e.g. `/providers/blackforestlabs/v1/flux-2-pro`.
 *
 * Configurable rather than hardcoded because it names both the provider and the model route, and
 * a second model on this resource would live at a different path. Leading slash required, trailing
 * slash refused: the URL is built by concatenation and `…com//providers` 404s in a way that reads
 * exactly like a missing deployment.
 */
function providerPath(source: Source, name: string, fallback: string): string {
  const raw = optional(source, name, fallback)
  if (!raw.startsWith('/')) throw new EnvError(`${name} must begin with '/' (got ${raw})`)
  if (raw.endsWith('/')) throw new EnvError(`${name} must not end with '/' (got ${raw})`)
  if (!/^[A-Za-z0-9._~/-]{2,200}$/.test(raw)) {
    throw new EnvError(`${name} contains characters that are not valid in a URL path`)
  }
  return raw
}

/**
 * An Azure `api-version`, e.g. `2025-04-01-preview`.
 *
 * Shape-checked rather than taken as free text because it is interpolated into every image URL,
 * and because the one thing worse than a wrong version is a version containing a `&` that silently
 * appends a parameter nobody wrote.
 */
function apiVersion(source: Source, name: string, fallback: string): string {
  const raw = optional(source, name, fallback)
  if (!/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(raw)) {
    throw new EnvError(
      `${name} must look like 2025-04-01 or 2025-04-01-preview (got ${raw.slice(0, 40)})`,
    )
  }
  return raw
}

/** Dollars in, integer micro-dollars out. Money is never a float in this service. */
function usdMicros(source: Source, name: string, fallbackDollars: number): bigint {
  const raw = source[name]?.trim()
  const dollars = raw ? Number(raw) : fallbackDollars
  if (!Number.isFinite(dollars) || dollars < 0 || dollars > 1_000_000) {
    throw new EnvError(`${name} must be a number of dollars between 0 and 1000000 (got ${raw})`)
  }
  // Rounded at the micro-dollar, which is four orders of magnitude finer than the cheapest image
  // this service can buy. A cap is a ceiling, so rounding down is the safe direction.
  return BigInt(Math.floor(dollars * 1_000_000))
}

/** The Azure AI Foundry resource serving FLUX. */
export interface FluxConfig {
  readonly endpoint: string
  readonly apiKey: string
  /** `/providers/blackforestlabs/v1/flux-2-pro`. Named separately from the model — see below. */
  readonly imagePath: string
  /**
   * `2025-04-01-preview`. **Mandatory, and its absence is silent.**
   *
   * Without this query parameter the resource answers `404` to a correctly-spelled model at a
   * correctly-spelled path with a valid key — which reads exactly like a model that was never
   * deployed, and was read that way for this service's entire history. See trap 0 in
   * `backend.ts`'s header for the evidence.
   *
   * Configurable because Azure retires preview versions on a schedule: pinning it in source would
   * turn a deprecation into an outage that needs a release to fix.
   */
  readonly apiVersion: string
  /**
   * The primary model, sent in the request BODY. `FLUX.2-pro`.
   *
   * Not the same string as the path segment, and not optional: omitting it returns
   * `400 no_model_name` even though the path already names the model. Verified.
   */
  readonly model: string
  /**
   * Tried on 404, 429 and 5xx. **Empty by default**, because only `FLUX.2-pro` is deployed on
   * this resource — seven other FLUX names were probed and all seven answer 404. Configurable
   * rather than hardcoded so a second model can be adopted without a code change.
   */
  readonly fallbackModel: string
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
  /**
   * Names this replica in `jobs.locked_by`. Defaults to the hostname, which is the container id
   * under compose and the pod name under Kubernetes — in both cases the thing an operator would
   * search for after finding a stuck lease.
   */
  readonly instanceId: string

  /** `null` when the resource is not configured. Not an empty-string sentinel: a caller that
   *  forgets to check gets a type error rather than a request to `undefined/providers/…`. */
  readonly flux: FluxConfig | null
  readonly imageDeadlineMs: number
  /**
   * The estimated price of one image, in whole US dollars, used for the credit reservation.
   *
   * Configuration rather than a table in code, because the provider does not publish a per-image
   * dollar rate on this surface: the response carries `request_meta.cost` in provider units (a
   * flat 3 per image at every size probed, from 256² to 1200x630) and no exchange rate. A number
   * this service invented and hardcoded would be a number nobody could correct. The provider's
   * own `cost` figure is recorded verbatim on every job alongside this estimate.
   */
  readonly imagePriceUsdMicros: bigint

  readonly assetRoot: string
  /** Empty means `storage_url` is written as a `file://` URL of the absolute path. */
  readonly assetBaseUrl: string

  readonly defaultCreditCapUsdMicros: bigint
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

  const fluxEndpoint = baseUrl(source, 'AZURE_FOUNDRY_ENDPOINT', '')
  const fluxKey = optionalSecret(source, 'AZURE_FOUNDRY_API_KEY')
  // Both halves or neither. Half-configured is the state that produces a 401 loop nobody can read:
  // an endpoint with no key looks exactly like a key that has been revoked.
  if (Boolean(fluxEndpoint) !== Boolean(fluxKey)) {
    throw new EnvError(
      'AZURE_FOUNDRY_ENDPOINT and AZURE_FOUNDRY_API_KEY must be set together, or neither — ' +
        'a half-configured resource fails as an unreadable 401',
    )
  }
  const configuredImagePath = providerPath(
    source,
    'AZURE_FOUNDRY_IMAGE_PATH',
    '/providers/blackforestlabs/v1/flux-2-pro',
  )

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **THE ENDPOINT MAY ALREADY CARRY THE PROVIDER PATH, AND CONCATENATING IT TWICE IS A 404 THAT
   * READS AS "NO MODEL DEPLOYED".**
   *
   * Azure's portal offers a "Target URI" for a deployment that is the FULL path —
   * `https://<resource>.services.ai.azure.com/providers/blackforestlabs/v1/flux-2-pro` — and that
   * is what a person copying from the portal pastes into `AZURE_FOUNDRY_ENDPOINT`. It is the
   * obvious thing to paste and it is not wrong; it is simply a different half of the same URL.
   *
   * Concatenating it with `imagePath` produces `…/flux-2-pro/providers/blackforestlabs/v1/
   * flux-2-pro`, which the resource answers **404**. `preflight.ts` then reports "no configured
   * model is deployed", the placeholder takes over, and every asset comes out an unlabelled
   * stand-in — the exact failure mode that produced 40 placeholder assets with an empty `model`
   * column and no test anywhere going red.
   *
   * So the two shapes are reconciled here, once, rather than defended against at the call site.
   * Refusing the longer form outright was considered and rejected: both are legitimate spellings
   * of one address, exactly one final URL is correct either way, and a boot failure over a paste
   * that was reasonable would be this service being pedantic about something it can simply resolve.
   * What it must NOT do is silently build a wrong URL, which is what it did before.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const endpointOrigin =
    fluxEndpoint && fluxEndpoint.endsWith(configuredImagePath)
      ? fluxEndpoint.slice(0, -configuredImagePath.length)
      : fluxEndpoint

  const model = modelName(source, 'STUDIO_IMAGE_MODEL', fluxEndpoint ? 'FLUX.2-pro' : '')
  if (fluxEndpoint && !model) {
    throw new EnvError('STUDIO_IMAGE_MODEL is required when AZURE_FOUNDRY_ENDPOINT is set')
  }
  const fallbackModel = modelName(source, 'STUDIO_IMAGE_FALLBACK_MODEL', '')
  // A fallback identical to the primary would double every failed call for no chance of success.
  if (fallbackModel && fallbackModel === model) {
    throw new EnvError('STUDIO_IMAGE_FALLBACK_MODEL must differ from STUDIO_IMAGE_MODEL')
  }

  return {
    port: integer(source, 'PORT', 4015, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'STUDIO_DATABASE_URL'),
    databaseUrlTestnet: optional(source, 'STUDIO_DATABASE_URL_TESTNET', ''),
    singleNetwork: optional(source, 'CF_NETWORK_SINGLE', ''),
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'STUDIO_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    flux: fluxEndpoint
      ? {
          // The ORIGIN, with the provider path removed if the deploy pasted a full target URI.
          endpoint: endpointOrigin,
          apiKey: fluxKey,
          imagePath: configuredImagePath,
          // The default is the version this estate's resource was verified against by a real
          // generation, not a guess from documentation.
          apiVersion: apiVersion(source, 'AZURE_FOUNDRY_API_VERSION', '2025-04-01-preview'),
          model,
          fallbackModel,
        }
      : null,
    // Generous, because generation runs in a leased job rather than in the request. Bounded,
    // because a hung call holds a lease and a runner slot for as long as it hangs. A measured
    // FLUX.2-pro call at 1024 square takes roughly 20 to 40 seconds.
    imageDeadlineMs: integer(source, 'STUDIO_IMAGE_DEADLINE_MS', 120_000, 1_000, 600_000),
    imagePriceUsdMicros: usdMicros(source, 'STUDIO_IMAGE_PRICE_USD', 0.06),

    assetRoot: optional(source, 'STUDIO_ASSET_ROOT', './out'),
    assetBaseUrl: baseUrl(source, 'STUDIO_ASSET_BASE_URL', ''),

    defaultCreditCapUsdMicros: usdMicros(source, 'STUDIO_DEFAULT_CREDIT_CAP_USD', 5),
  }
}

/**
 * The Foundry resource host, for logs and for `GET /v1/backend`.
 *
 * The host without the key. An operator debugging "which resource is this pointed at" needs the
 * hostname and must never be handed the credential, and the two travel together everywhere else.
 */
export function redactedEndpoint(flux: FluxConfig | null): string | null {
  if (!flux) return null
  try {
    return new URL(flux.endpoint).host
  } catch {
    return null
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed
 * through the telemetry package: nothing that can itself fail may sit between a configuration
 * error and the report of it. The message is the one `loadEnv` produced, which by construction
 * never contains a value.
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
