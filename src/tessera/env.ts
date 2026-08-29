/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable the service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from custody, which is the only service in the old
 * estate that gets this right:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic: everything derived from it is forgeable by anyone who can read the
 *      repository, and a placeholder that boots is a placeholder that reaches production.
 */

import { hostname } from 'node:os'
import {
  assertGeneratedSecret,
  assertGeneratedSecretList,
  assertServiceCredential,
} from '@cloudsforge/secrets'

/**
 * The service's own name, from `service.ts` and NOT re-exported from here.
 *
 * This module exits the process when a variable is missing, at import, on purpose. So anything
 * that wants only the service's name must not have to import this file to get it — four modules
 * did, and it took eleven test files down with them. `service.ts` has the whole account.
 */
import { SERVICE } from './service.ts'

/**
 * The port this service binds, stated once.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **4022, AND THE NUMBER IS ARGUED RATHER THAN PICKED.** 23-tessera.md §10.1 separates three
 * port spaces this estate keeps confusing:
 *
 *   1. the port a service BINDS in its container — this value;
 *   2. the HOST port in the estate compose file, which is DERIVED (`4100 + index in
 *      deployableRepos()`, `org/tools/cfctl.ts`) and therefore never chosen;
 *   3. the `devPort` in micro-ui's surface registry, documented as "not an allocation; it is a
 *      fact about a service" (`ui/packages/ui/src/surfaces.ts`).
 *
 * Spaces (1) and (2) already collide three times: emberkin binds 4100, which is identity's
 * compose host port; aetherholm binds 4120, which is admin-api's; nda binds 4110, which is
 * notify's. Each of those is a service whose own bind address is a number the estate hands to
 * somebody else.
 *
 * 4022 is BELOW the derived 4100+ block, so no number of repositories appended to
 * `deployableRepos()` can ever grow into it. That is the whole reason for the choice: not that
 * 4022 is free today — 4100 was free the day emberkin took it — but that it is in a region the
 * derivation cannot reach.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const DEFAULT_PORT = 4022

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `PLACEHOLDERS` AND `requiredSecret` USED TO LIVE HERE, AND THEY ARE GONE RATHER THAN KEPT.
 *
 * They were a deny-list of nine exact strings plus a 24-character floor, and the only variable
 * still reaching them was `TESSERA_SERVICE_CREDENTIAL` (micro-org #222). That guard PASSED a JWT:
 * a service token is well over 24 characters and is on no list, so the estate booted a container
 * holding a token that `identity/src/tokens.ts` gives 600 seconds to live, and which was
 * measured on the live estate expired for **26 hours** while `/livez` answered 200 — because
 * `/livez` verifies nothing and never presents the credential to anybody.
 *
 * A weak check that cannot fail reads as the absence of a problem, which is the same lesson
 * `OUTBOX_SIGNING_SECRET` learned in micro-org #142. So the guard was not softened or lengthened,
 * it was replaced by `optionalCredential` below, which refuses a JWT BY NAME.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

/**
 * A SERVICE CREDENTIAL that may be absent, but must be real if present.
 *
 * ── ABSENCE IS A SUPPORTED MODE, AND IT STAYS ONE ──────────────────────────────────────────────
 *
 * `null` rather than `undefined`, and rather than `''`: compose interpolates
 * `${TESSERA_IDENTITY_CREDENTIAL:-}`, so an unset credential arrives as the EMPTY STRING. An empty
 * string is falsy where a caller tests for it and truthy in `Object.keys`, so a mode chosen by
 * `env.x ? … : …` would silently agree with an operator who set the variable to nothing. `null` is
 * the absence, said once. The empty check therefore stays AHEAD of the assertion — this service
 * promises that a Kiln with no upstream answers 503 `kiln_unconfigured` and the world still serves,
 * and `migrator.ts` shares this environment while dialling nobody.
 *
 * What is not supported is a value that is present and rubbish. A 20-character placeholder is a
 * deployment that believes it HAS a credential, and it fails on its first firing with a 401 that
 * nothing in this repository distinguishes from studio being down.
 *
 * ── WHY NOT `assertGeneratedSecret` ────────────────────────────────────────────────────────────
 *
 * Because it would refuse every credential this estate has ever minted, and tessera would exit 1 at
 * boot on BOTH networks. A credential is `cfsc_` + base64url, which is neither wholly base64 nor
 * wholly hex — the underscore in its own prefix disqualifies it. Measured live: the **testnet**
 * credential CONTAINS A HYPHEN while the mainnet one does not, so the "no hyphens" instinct that is
 * correct for the signing keys above would have booted mainnet and killed testnet. `env.test.ts`
 * pins a hyphenated fixture on purpose so that asymmetry fails CI rather than one estate.
 *
 * `assertServiceCredential` asserts what those rules cannot: the `cfsc_` prefix, placeholder
 * markers checked on the BODY after the prefix is stripped, 32 decoded BYTES rather than keystrokes,
 * an entropy floor — and, first of all, that the value is **not a JWT**. That last refusal is the
 * whole of micro-org #222 for `TESSERA_SERVICE_CREDENTIAL`.
 */
function optionalCredential(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  // `assertServiceCredential` throws `SecretError`, not `EnvError`, and that is deliberate rather
  // than an oversight: `fatalConfig` reads `err.message` off `unknown`, so the boot line is
  // identical either way, and re-wrapping would put this file's text between the operator and the
  // guard's own — which names the variable, the defect and the command that mints a real one.
  assertServiceCredential(name, value)
  return value
}

/**
 * The estate's shared event-bus HMAC key, held to a SHAPE rather than to a deny-list.
 *
 * The deleted `requiredSecret` could not be the guard for this one. It refused a fixed list of exact
 * strings and anything under 24 characters, and the value that sat on 54 lines of a PUBLIC compose
 * file — `estate-only-outbox-secret-00000000000000` — was on no list and was 40 characters, so it
 * passed every service in the estate (micro-org #142). A check that could not fail read as the
 * absence of a problem.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. It has no NODE_ENV exemption and no escape
 * hatch, so CI generates a real value per run rather than being let through.
 *
 * `required` rather than a length-and-deny-list pre-check, deliberately: the weaker checks are a
 * strict subset of the stronger ones, and running them first would answer a 40-character
 * placeholder with "must be at least 24 characters" — a message that is true, useless, and points
 * the operator at the wrong property.
 *
 * It throws `SecretError` rather than `EnvError`, and that is not an oversight: the class is
 * distinct so a configuration failure can be told from every other kind, and `fatalConfig` below
 * reads `err.message` off `unknown`, so the boot line is identical either way. Re-wrapping would
 * buy nothing and would put this file's own text between the operator and the guard's.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name)
  assertGeneratedSecret(name, value)
  return value
}

/**
 * A comma-separated list of secrets, newest first.
 *
 * A LIST, not a value, because rotation without an overlap window means every producer must change
 * secret in the same instant this service does, and that instant does not exist during a rolling
 * deploy. The receiver publishes the new key, accepts both for a window, then drops the old one.
 *
 * **Every entry faces exactly the bar a single secret faces — `assertGeneratedSecretList` is
 * `assertGeneratedSecret` per entry, and there is no weaker rule for the outgoing key.** In a
 * rotation overlap window the outgoing key is the one an attacker already holds if it leaked, and
 * "just for the drain" is exactly how a placeholder survives the rotation meant to remove it.
 *
 * The local placeholder and length loop that used to sit here is GONE rather than kept in front:
 * it is a strict subset of the shape check, and running it first answers a 40-character placeholder
 * with "must each be at least 24 characters" — true, useless, and about the wrong property. What is
 * kept is what the shape check does not know about: the empty-list refusal, whose message names
 * this service's own variable, and the duplicate refusal below.
 */
function parseSecretList(raw: string, name: string): readonly string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (entries.length === 0) throw new EnvError(`${name} is required — at least one secret`)
  assertGeneratedSecretList(name, entries)
  if (new Set(entries).size !== entries.length) {
    // A duplicated secret makes the "which key verified this" answer ambiguous, and that answer is
    // what tells an operator whether a rotation has finished and the old key may be dropped.
    throw new EnvError(`${name} lists the same secret twice`)
  }
  return Object.freeze(entries)
}

function requiredSecretList(source: Source, name: string): readonly string[] {
  return parseSecretList(required(source, name), name)
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function optionalOrigin(source: Source, name: string): string | undefined {
  const raw = source[name]?.trim()
  if (!raw) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new EnvError(`${name} must be an absolute URL (got ${raw})`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EnvError(`${name} must be http or https (got ${url.protocol})`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new EnvError(`${name} must be an origin with no path, query or fragment (got ${raw})`)
  }
  return url.origin
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
  /**
   * Identity's ORIGIN, which is what `POST /service-tokens/exchange` is posted to.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **REQUIRED, AND IT DEFAULTS TO `IDENTITY_ISSUER` RATHER THAN BEING OPTIONAL.**
   *
   * The three variables above and this one are four spellings of one host, and only the JWKS URL
   * carries a path. Making this optional would mean `upstreams.ts` had to decide what to do with a
   * credential it has been given and an identity it cannot find — and the only honest answer to
   * that is "refuse to start", which is what `required` says here in one line instead of three at
   * the call site.
   *
   * Defaulting to `IDENTITY_ISSUER` rather than demanding a new variable is not laziness: this
   * service already refuses to boot without the issuer, the issuer IS identity's origin on both
   * estates, and every deployment therefore gains the exchange with no manifest change and no CI
   * change. `IDENTITY_URL` exists as the override for the day the issuer becomes a public URL and
   * the in-cluster address stops matching it. `market/src/env.ts` reads the same two variables
   * the same way, and two services disagreeing about where identity lives is its own defect.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly identityUrl: string
  /** HMAC key for outbound event signatures, so a subscriber can prove an event came from us. */
  readonly outboxSigningSecret: string
  /**
   * The same secret, on the way in — and a LIST of them, newest first.
   *
   * Deliveries this service RECEIVES — `market.listing.sold`, `community.proposal.executed`,
   * `billing.entitlement.granted` — are signed by the producer with the estate outbox secret, and
   * `src/inbound.ts` verifies over the raw bytes before parsing them. It is a separate variable
   * from `OUTBOX_SIGNING_SECRET` even though the deploy sets both to the same value today, because
   * the day the estate moves to per-producer signing secrets (which `contracts-auth`'s
   * `admin:audit:write` entry argues for) the two stop being the same value and a service that
   * read one variable for both would have to be found.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **A LIST, AND STILL ONE VARIABLE.** The estate's outbox secret is a single key shared by 24
   * services. Rotating it by swapping the value means a producer that moves first has every
   * delivery refused here until this service restarts too — the deliveries do not error loudly,
   * they PARTITION, and the failure reads as a secret mismatch rather than as a deploy ordering
   * problem. So the receiver accepts every key that may have signed an inbound delivery, the
   * operator adds the new one, moves the producers, and then removes the old one.
   *
   * A second variable was not added: the existing name becoming a list is the smaller change and
   * it matches `notify`, whose `NOTIFY_INGEST_SIGNING_SECRET` is also singular-named and also
   * parses to a list. `SIGNING` stays a single value — see `outboxSigningSecret` above — because
   * signing with two keys at once would double every subscriber's verification work and leave
   * nobody able to say which key an event was signed with.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly inboundSigningSecrets: readonly string[]
  /**
   * Names this replica in `jobs.locked_by`. Defaults to the hostname, which is the container id
   * under compose and the pod name under Kubernetes — in both cases the thing an operator would
   * search for after finding a stuck lease.
   */
  readonly instanceId: string
  /**
   * `micro-studio`'s origin, for the Kiln. **Optional, and its absence is a supported mode**:
   * without it `POST /v1/kiln/firings` answers 503 `kiln_unconfigured` rather than 500, and every
   * other route in the service works. A world whose Kiln is down is a world you can still walk
   * around in, and the alternative — refusing to boot — takes the whole title out over one
   * upstream.
   */
  readonly studioUrl: string | undefined
  /** `micro-ledger`'s origin. Same optionality, same reason: reads still serve without it. */
  readonly ledgerUrl: string | undefined
  /** `micro-market`'s origin, for listings. Same optionality. */
  readonly marketUrl: string | undefined
  /**
   * `micro-community`'s origin, for ward governance. Same optionality.
   *
   * **No credential accompanies it, and that is deliberate rather than missing.** Community's
   * `POST /v1/communities` refuses a service token — "accepting one would make every service in
   * the estate a voting member of every community" — and takes the owner from the caller's own
   * token. So the only credential that works is the founding operator's, relayed per request, and
   * there is nothing for this service to hold or rotate.
   */
  readonly communityUrl: string | undefined
  /**
   * The long-lived, revocable credential this service EXCHANGES for a service token when it calls
   * studio or the ledger. `cfsc_…`, from `POST /service-credentials`.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **THIS IS THE FIX FOR micro-org #222, AND A LONGER EXPIRY WOULD NOT HAVE BEEN.**
   *
   * A service token lives 600 seconds (`identity/src/tokens.ts`) and nothing can renew it. A
   * credential is exchanged for one at `POST /service-tokens/exchange`
   * (`identity/src/server.ts`), the exchange consumes nothing, and `ServiceTokenProvider`
   * (`@cloudsforge/auth`) re-mints on traffic at a jittered 80% of each token's life. So N replicas
   * boot from one credential and a restart days later still works. The 600 seconds is deliberately
   * unchanged — rotation IS expiry, and lengthening the TTL leaves the same defect arriving later
   * and hurting more.
   *
   * Optional for exactly the reason the four URLs are: a world with a cold Kiln is a world you can
   * still walk around in. `null` is the supported absence, and `src/upstreams.ts` answers 503 at
   * the routes that needed it rather than refusing to boot.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly identityCredential: string | null
  /**
   * A pre-minted service token, read once at boot. **A MIGRATION AID WITH A STATED END.**
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * This variable IS micro-org #222. `index.ts` and handed its value straight to the
   * studio and ledger clients as their bearer — "until this service is granted a credential in the
   * deploy, the credential IS the token" — and on the live estate it held a JWT that had been
   * expired for **26 hours** on a container reporting healthy, because `/livez` never presents it
   * to anybody.
   *
   * It survives only so that a container carrying the old variable and no new one keeps booting
   * through the rolling deploy rather than exiting 1 mid-flight. It is now guarded by
   * `optionalCredential`, so the JWT that was actually in it is refused BY NAME at boot: a
   * deployment that has not migrated fails loudly at the door instead of quietly ten minutes later.
   *
   * **DELETE THIS FIELD, and `TESSERA_SERVICE_CREDENTIAL` with it, once no estate sets it.**
   * `upstreams.ts` reports `mode: 'static'` while it is in use and `index.ts` logs `fatal` naming
   * the consequence, which is how an operator knows the day has come.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly serviceCredential: string | null
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
  return {
    port: integer(source, 'PORT', DEFAULT_PORT, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'TESSERA_DATABASE_URL'),
    databaseUrlTestnet: source['TESSERA_DATABASE_URL_TESTNET'] ?? '',
    singleNetwork: source['CF_NETWORK_SINGLE'] ?? '',
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'TESSERA_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    // `optionalOrigin` when set — so a value with a path is refused here rather than producing a
    // `POST /v1//service-tokens/exchange` that 404s with nothing naming the cause — and the issuer
    // when it is not. See the field comment for why this defaults instead of being a fifth
    // required variable.
    identityUrl: optionalOrigin(source, 'IDENTITY_URL') ?? required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET'),
    inboundSigningSecrets: requiredSecretList(source, 'INBOUND_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
    studioUrl: optionalOrigin(source, 'STUDIO_URL'),
    ledgerUrl: optionalOrigin(source, 'LEDGER_URL'),
    marketUrl: optionalOrigin(source, 'MARKET_URL'),
    communityUrl: optionalOrigin(source, 'COMMUNITY_URL'),
    identityCredential: optionalCredential(source, 'TESSERA_IDENTITY_CREDENTIAL'),
    serviceCredential: optionalCredential(source, 'TESSERA_SERVICE_CREDENTIAL'),
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
