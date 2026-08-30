/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from custody:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic, and a placeholder that boots is a placeholder that reaches production.
 *
 * ## The two fail-closed defaults
 *
 * `FORESIGHT_MAINNET_ENABLED` is false, so a misconfigured deployment cannot put a market holding
 * real EMBER on a mainnet nobody authorised. And `FORESIGHT_PROPOSER_*` is unset by default, which
 * is a SUPPORTED MODE rather than an error: the idea pipeline records "no proposals" and the
 * operator queue stays empty. Same discipline as `micro-notify`'s unconfigured SMTP — an external
 * dependency nobody has wired yet must degrade, not crash.
 */

import { hostname } from 'node:os'
import type { Network } from '@cloudsforge/contracts-chain'
import {
  SecretError,
  assertGeneratedSecret,
  assertOpaqueSecret,
  assertServiceCredential,
} from '@cloudsforge/secrets'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a migration
 * advisory lock.
 */
export const SERVICE = 'foresight'

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
 * It held nine exact strings and was paired with a 24-character floor. Neither could fail for the
 * value that actually reached 44 containers on both networks: micro-org #142's
 * `estate-only-outbox-secret-00000000000000` is 40 characters and was on nobody's list. The
 * docblock that used to sit on `optionalSecret` below said as much in its own words — the estate
 * defaults several of these to `estate-placeholder-token-0000000000000000`, "long enough to pass a
 * length check" — and then kept the length check anyway. A check that cannot fail is worse than no
 * check, because the absence of an alarm gets read as the absence of a problem.
 *
 * A deny-list of exact strings is structurally unable to work: the next placeholder somebody
 * writes is, by definition, not on it. `@cloudsforge/secrets` asserts the SHAPE of a generated
 * value instead, which is the property a placeholder cannot have. It is imported rather than
 * copied so that this service cannot drift from the other sixteen.
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
 * The estate's shared event-bus HMAC key — one key behind every service-to-service POST.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. The old `minLength` parameter is gone rather
 * than kept in front: it is a strict subset of the shape check, and running it first answers a
 * 40-character placeholder with "must be at least 24 characters" — true, useless, and about the
 * wrong property.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name)
  asEnvError(() => assertGeneratedSecret(name, value))
  return value
}

/**
 * A SERVICE CREDENTIAL that may be absent, but must be real if present.
 *
 * ── ABSENCE IS A SUPPORTED MODE, AND IT STAYS ONE ──────────────────────────────────────────────
 *
 * `null` rather than `undefined`, so "this deployment has none" is a value a caller must handle
 * rather than a property it can forget to read. The empty check stays AHEAD of the assertion,
 * because compose interpolates `${FORESIGHT_IDENTITY_CREDENTIAL:-}` and an unset credential arrives
 * as the EMPTY STRING — that is the supported mode, not a malformed one. `migrator.ts` shares this
 * environment and dials nobody, so turning the gap into `exit(1)` would fail the migration every
 * deploy starts with.
 *
 * What is not supported is a value that is present and rubbish: a 20-character placeholder is a
 * deployment that believes it HAS a credential, and its LEASED BACKGROUND JOBS then fail on a 401
 * indistinguishable from custody being down — a market approved after the bootstrap sits in
 * `awaiting_funds` forever with nothing in any log naming the cause.
 *
 * ── WHY NOT `assertGeneratedSecret` ────────────────────────────────────────────────────────────
 *
 * Because it would refuse every credential this estate has ever minted, and foresight would exit 1
 * at boot on BOTH networks. A credential is `cfsc_` + base64url, which is neither wholly base64 nor
 * wholly hex — the underscore in its own prefix disqualifies it. Measured live: the testnet
 * credential also CONTAINS A HYPHEN while the mainnet one does not, so the "no hyphens" instinct
 * that is correct for the signing key above would have booted mainnet and killed testnet.
 */
function optionalCredential(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  asEnvError(() => assertServiceCredential(name, value))
  return value
}

/**
 * A secret THIS ESTATE DID NOT GENERATE, and may be absent.
 *
 * `FORESIGHT_PROPOSER_TOKEN` and `FORESIGHT_SEARCH_TOKEN` authenticate to an external model
 * provider and an external search adapter. **Their alphabets belong to their issuers**, so
 * `assertGeneratedSecret` is the wrong rule twice over: it would refuse a working vendor key that
 * happens to contain a `!` or a `-`, and a guard that refuses correct input is a guard an operator
 * deletes at 3am. `assertOpaqueSecret` keeps the checks that ARE alphabet-independent — the
 * placeholder markers, a JWT refused by name, a 16-character floor and a low entropy floor that
 * catches `0000…` — and drops the ones that would be this service grading somebody else's RNG.
 *
 * ABSENT IS A SUPPORTED MODE AND STAYS ONE: unconfigured is how every deployment currently runs,
 * the pipeline records "no proposals", and `undefined` is preserved rather than becoming `''`
 * because `proposer.ts` chooses whether to send an `Authorization` header on exactly that
 * distinction (`...(options.searchToken ? { token: … } : {})`).
 */
function optionalOpaqueSecret(source: Source, name: string): string | undefined {
  const value = source[name]?.trim()
  if (!value) return undefined
  asEnvError(() => assertOpaqueSecret(name, value))
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

/** An optional value that stays absent rather than becoming an empty string. */
function optionalOrUndefined(source: Source, name: string): string | undefined {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : undefined
}

/**
 * An optional absolute origin — scheme and host, nothing else.
 *
 * `tessera/src/env.ts`'s verbatim, because the value is used the same way: concatenated with a
 * path to form a URL. A trailing slash or a stray path segment would produce `…/v1//v1/assets/…`
 * or `…/studio/v1/assets/…`, and both fail as a broken image on a user's page rather than at boot.
 * Refusing at boot is what turns a configuration typo into a fatal log line with the value in it.
 */
function optionalOrigin(source: Source, name: string): string | undefined {
  const raw = optionalOrUndefined(source, name)
  if (raw === undefined) return undefined
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

/**
 * A wei quantity as a decimal string.
 *
 * Never a number. One EMBER is 1e18 wei, four orders of magnitude past what a double holds
 * exactly, so a gas bound read through `Number()` would be silently rounded — and a rounded bound
 * is a bound that does not hold at the value it was written for.
 */
function wei(source: Source, name: string, fallback: bigint): bigint {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new EnvError(`${name} must be a whole number of wei (got ${raw})`)
  return BigInt(raw)
}

/**
 * A JSON object of `chain → value`, refused rather than defaulted when it will not parse.
 *
 * A silently-empty map here is an outage that presents as "every deploy is refused for want of an
 * endpoint", which is a long way from the typo that caused it.
 */
function jsonMap(source: Source, name: string, fallback: string): Readonly<Record<string, string>> {
  const raw = optional(source, name, fallback)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new EnvError(`${name} must be a JSON object (got ${raw.slice(0, 60)})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EnvError(`${name} must be a JSON object of string keys to string values`)
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new EnvError(`${name}.${key} must be a non-empty string`)
    }
    out[key] = value
  }
  return Object.freeze(out)
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

function address(source: Source, name: string): string {
  const value = required(source, name)
  if (!EVM_ADDRESS.test(value)) {
    throw new EnvError(`${name} must be an 0x-prefixed 20-byte address (got ${value.slice(0, 12)}…)`)
  }
  return value
}

/** An address that may be absent — but a PRESENT value must still be a real address. */
function optionalAddress(source: Source, name: string): string | undefined {
  const value = optionalOrUndefined(source, name)
  if (value === undefined) return undefined
  if (!EVM_ADDRESS.test(value)) {
    throw new EnvError(`${name} must be an 0x-prefixed 20-byte address (got ${value.slice(0, 12)}…)`)
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
  /**
   * Names this replica in `jobs.locked_by`. Defaults to the hostname, which is the container id
   * under compose and the pod name under Kubernetes — in both cases the thing an operator would
   * search for after finding a stuck lease.
   */
  readonly instanceId: string

  /**
   * Where a service token is minted. `IDENTITY_ISSUER` unless overridden.
   *
   * Defaulted to the issuer rather than made a separate required variable, because the issuer of a
   * token is by definition where the token came from — ledger's reasoning (`ledger/src/env.ts`),
   * and it means this fix needs no new URL in any deploy manifest.
   */
  readonly identityUrl: string

  /**
   * The long-lived `cfsc_…` credential this service exchanges for a service token.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **THE TEN-MINUTE CLIFF, AND WHY IT BIT THIS SERVICE HARDER THAN MOST.**
   *
   * `FORESIGHT_SERVICE_TOKEN` holds a token that lives **600 seconds** (`identity/src/tokens.ts`)
   * and `index.ts` read it once, at import: `const token = () => env.serviceToken`, handed verbatim
   * to all five `HttpClient`s. So this service authenticated to custody, the indexer, the ledger,
   * policy and admin-api **exactly once per bootstrap** and never again.
   *
   * tessera and emberkin share the shape and mostly get away with it, because their upstream calls
   * happen on request paths that a bootstrap outruns. **This service's custody calls come from
   * LEASED BACKGROUND JOBS** — `market.deploy` and `resolution.post` — which is precisely the shape
   * that froze EMBER reconciliation for hours through `micro-ledger`: a 600-second token behind a
   * longer timer authenticates at boot and never again, and the resulting 401 is indistinguishable
   * from the dependency being down. A market approved eleven minutes after a bootstrap would sit in
   * `awaiting_funds` forever with nothing in any log naming the cause.
   *
   * The fix is `micro-ledger`'s, unchanged: `@cloudsforge/auth`'s `ServiceTokenProvider` exchanges
   * this credential at `POST /service-tokens/exchange`, caches, re-mints at ~80% of `expiresIn` with
   * per-token jitter, shares one in-flight exchange, and on a 401 discards exactly the rejected
   * token and replays once. `src/upstreams.ts` carries the argument; this field is the input.
   *
   * **NOT REQUIRED, for ledger's reason and one of our own.** `migrator.ts` shares this
   * environment and `foresight-migrate` is given no credential — it dials nothing. And the estate's
   * deploy does not set this variable yet (it sets the token), so making it mandatory would refuse
   * to boot a service that is currently running. The absence is not silent: `index.ts` says so at
   * boot at `fatal`, and `foresight_service_token_usable` is 0 on every scrape.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly identityCredential: string | null

  readonly custodyUrl: string
  readonly indexerUrl: string
  readonly ledgerUrl: string
  /**
   * micro-pricing, for the two rates a non-EMBER stake is denominated by.
   *
   * **Absent is a supported mode, and it is the mode the estate is in today** — the compose does
   * not set it (`deploy/compose/docker-compose.estate.yml`, the `foresight` service). Requiring it
   * was the first instinct and it was wrong twice over: it would refuse to boot a deployment that
   * had been working, and it would do so in the name of a safety property this service already has
   * without it. With no rate source there is nothing to guess FROM — `unconfiguredPricingClient`
   * refuses every rate read, so a non-EMBER stake answers 503 `rate_unavailable` and an EMBER
   * stake, which applies no rate, is untouched. Fail-closed either way.
   *
   * The rate board is public (`pricing/src/server.ts`), so no credential is presented.
   */
  readonly pricingUrl: string | undefined
  readonly policyUrl: string
  /**
   * A pre-minted service token, kept ONLY as the bridge while the deploy still supplies one.
   *
   * **This is the defective credential, and it is optional now rather than required.** It expires in
   * 600 seconds and nothing can renew it, so a deployment holding only this is a deployment whose
   * background jobs stop authenticating ten minutes after boot. `upstreams.ts` prefers the
   * credential whenever one is present and ignores this entirely; when it is not, this is presented
   * and the boot log says, at `fatal`, exactly what will break and when.
   *
   * It exists at all because removing it would take the running estate's foresight offline the
   * moment this ships — `micro-deploy` sets `FORESIGHT_SERVICE_TOKEN` and does not yet pass
   * `FORESIGHT_IDENTITY_CREDENTIAL`, which its bootstrap already mints. **Delete this field once
   * the deploy passes the credential**; it is a migration aid with a stated end, not a mode.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **IT IS GUARDED BY `assertServiceCredential`, WHICH REFUSES A JWT BY NAME — micro-org #222.**
   *
   * Measured live on 2026-08-05: the value in this variable on the running estate is an **805-byte
   * JWT that expired 26 hours before it was read**, on a container reporting healthy. The compose
   * default when nothing is exported is `estate-placeholder-token-0000000000000000`, which is
   * micro-org #142 wearing a different name. Both are refused, and both refusals are correct.
   *
   * **No JWT exemption is added and no weaker assertion is substituted**, because either would be
   * this file agreeing that a ten-minute bearer read once at boot is an acceptable standing
   * credential. It is not: that is the entire defect, and it is worse here than in most services
   * because this one's custody calls come from LEASED BACKGROUND JOBS that a bootstrap outruns.
   *
   * The consequence, stated so nobody discovers it during a deploy: **a deployment that still sets
   * `FORESIGHT_SERVICE_TOKEN` to a token will not boot** — neither `foresight` nor
   * `foresight-migrate`. The remedy is the one this file has been describing for a release: stop
   * passing the token, pass `FORESIGHT_IDENTITY_CREDENTIAL`, which `estate-bootstrap.sh` §5b has
   * minted all along and which is sitting in `tokens.env` today.
   *
   * The remaining sharp edge is worth naming rather than hiding: a `cfsc_…` value pasted HERE now
   * passes this guard and is then presented verbatim as a Bearer by `upstreams.ts`, which 401s all
   * five upstreams — the compose file says so in as many words. The assertion narrows the accepted
   * set to values that cannot work in this slot, which is the retirement #222 asks for done without
   * deleting the field — and the field should be deleted, with `CredentialMode`'s `static` arm, in
   * the follow-up that wallet has already made.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly serviceToken: string | null
  readonly upstreamDeadlineMs: number

  /**
   * `chain → JSON-RPC endpoint`. Empty by default, which makes a chain with no endpoint refuse
   * rather than fall back to a public node nobody chose.
   */
  readonly rpcUrls: Readonly<Record<string, string>>
  readonly rpcDeadlineMs: number

  /** The one network this deployment runs markets on. */
  readonly network: Network
  /**
   * Whether `network: mainnet` is permitted at all. FALSE by default.
   *
   * A market on a mainnet holds real EMBER belonging to strangers, and the cost of a mistake here
   * is not a support ticket. So mainnet is a deliberate act of configuration and the default
   * refuses.
   */
  readonly mainnetEnabled: boolean

  /** Where the settlement fee goes. Bound into every market at deploy time. */
  readonly treasuryAddress: string
  /**
   * The published platform address the house seed stakes from — docs/ecosystem/21 §5. **May be
   * absent, and absent is a supported mode**: this deployment runs no engagement programme and
   * `POST /markets/:id/approve` refuses a `houseSeedPerOutcomeWei`, plainly. The address holds
   * its own key OUTSIDE this estate's custody (custody has no transaction shape that can call
   * `stake(uint8)` — see `src/houseseed.ts`), stakes exactly as any bettor does, and is
   * published the way the platform miners' coinbase addresses are (21 §3).
   */
  readonly houseAddress: string | undefined
  /**
   * The published platform address a CUSTODIAL market position is staked from — the house seed's
   * arrangement, for the house seed's reason: custody has no signing shape that calls
   * `stake(uint8)` and `SIGNABLE_PURPOSES` does not include `user`
   * (`custody/src/gates.ts`), so a custodial bettor's EMBER reaches the pool through an
   * address the platform publishes and funds, exactly as the seed does.
   *
   * **Absent is a supported mode**: this deployment takes wallet stakes only, and every custodial
   * route answers 503 with that sentence rather than half-working.
   */
  readonly custodialAddress: string | undefined
  /**
   * micro-admin-api, for reading the engagement caps at market approval. Absent is the same
   * supported mode: no caps readable, no seeds planned (21 §8).
   */
  readonly adminApiUrl: string | undefined
  /**
   * The **browser-reachable** origin of micro-studio, used for one thing: composing the `bytesUrl`
   * a client puts in `<img src>` for a market's or an idea's header image.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **NOT `STUDIO_URL`, AND THE DIFFERENCE IS THE WHOLE POINT OF THE SEPARATE NAME.**
   *
   * `tessera/src/env.ts` has `STUDIO_URL` and it is a SERVER-TO-SERVER address: tessera's own
   * process dials it with a service token, and in the estate it resolves to a container name on a
   * private compose network. A browser cannot reach that, ever. Reusing the name here would produce
   * an `<img src>` pointing at an address that exists only inside the cluster — which fails as a
   * broken image on the user's page and as a green health check everywhere else.
   *
   * So the name says which side of the trust boundary it is for. foresight makes no server-to-
   * server call to studio at all (`images.ts`: this service holds a reference and authorises it,
   * and does not fetch bytes or recompute a checksum), so there is nothing here for a `STUDIO_URL`
   * to do.
   *
   * **Absent is a supported mode**, and it is the mode the estate is in today: the compose publishes
   * studio on `127.0.0.1:4111` with no public hostname, and `studio` has no row in the
   * `@cloudsforge/ui` surfaces registry. Unset, every `image.bytesUrl` is `null` — which says "this
   * deployment cannot tell you where the bytes are" — rather than a relative path that would
   * resolve against foresight's own origin and 404. The estate has written that lesson down once
   * already: `deploy/compose/docker-compose.estate.yml` leaves `STUDIO_ASSET_BASE_URL` unset
   * because a base URL there "would mint storageUrls that look fetchable and 404 — a zero wearing a
   * status code".
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly studioPublicUrl: string | undefined
  /** The custody-held address that may resolve or void a market. See `src/resolve.ts`. */
  readonly oracleAddress: string
  /** Custody's binding for the oracle key: the userId it was minted under. */
  readonly oracleUserId: string
  /** Custody's binding for the oracle key: the orderId it was minted under. */
  readonly oracleOrderId: string

  readonly defaultFeeBps: number
  readonly defaultDisputeWindowSeconds: number

  /** Deploys can be turned off without turning the service off. */
  readonly deploysEnabled: boolean
  readonly minGasPriceWei: bigint
  readonly maxGasPriceWei: bigint
  readonly deployGasLimit: bigint
  readonly resolveGasLimit: bigint
  /** How long a broadcast may sit unconfirmed before it is called stuck and an operator is told. */
  readonly stuckMinutes: number

  /**
   * The idea pipeline's external model and search adapter. **All four may be absent**, and absent
   * is a supported mode: the pipeline records "no proposals" instead of crashing.
   */
  readonly proposerUrl: string | undefined
  readonly proposerToken: string | undefined
  readonly proposerModelId: string | undefined
  readonly searchUrl: string | undefined
  readonly searchToken: string | undefined
  readonly proposerDeadlineMs: number
  /** How many candidate questions one pipeline run asks for. */
  readonly proposerBatchSize: number

  /**
   * The policy action name staking is evaluated under.
   *
   * `micro-policy`'s action registry is CLOSED — an unregistered name is a 400, not a guess
   * (`policy/src/actions.ts`). There is no `foresight.stake` in it and this task may not
   * modify that repository, so the default is the registered action whose description actually
   * fits ("Place an order. Soft per-window caps only." — `policy/src/actions.ts`). When
   * policy next gains a `foresight.stake` action, this variable is how a deployment moves to it
   * without a release here.
   */
  readonly policyAction: string
  readonly policyDeadlineMs: number

  readonly leaseMs: number
  readonly jobPollMs: number
  /** How often the idea pipeline runs, in minutes. A leased job, never a timer. */
  readonly proposeEveryMinutes: number
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const NETWORKS = new Set(['mainnet', 'testnet'])

export function parseNetwork(value: string): Network {
  if (!NETWORKS.has(value)) throw new EnvError(`network must be mainnet or testnet (got ${value})`)
  return value as Network
}

/**
 * Pure over its source so the failure paths are testable without mutating the process. The eager
 * export below is what makes the service fail fast.
 */
export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const minGasPriceWei = wei(source, 'FORESIGHT_MIN_GAS_PRICE_WEI', 1_000_000_000n)
  const maxGasPriceWei = wei(source, 'FORESIGHT_MAX_GAS_PRICE_WEI', 500_000_000_000n)
  if (minGasPriceWei > maxGasPriceWei) {
    throw new EnvError('FORESIGHT_MIN_GAS_PRICE_WEI exceeds FORESIGHT_MAX_GAS_PRICE_WEI')
  }

  const network = parseNetwork(optional(source, 'FORESIGHT_NETWORK', 'testnet'))
  const mainnetEnabled = optional(source, 'FORESIGHT_MAINNET_ENABLED', 'false') === 'true'
  if (network === 'mainnet' && !mainnetEnabled) {
    // Two variables rather than one, so that reaching mainnet takes two deliberate edits. A single
    // `FORESIGHT_NETWORK=mainnet` typo would otherwise put strangers' money on a live chain.
    throw new EnvError(
      'FORESIGHT_NETWORK is mainnet but FORESIGHT_MAINNET_ENABLED is not true — a market on a ' +
        'mainnet holds real EMBER belonging to strangers, so it takes two deliberate settings',
    )
  }

  const defaultFeeBps = integer(source, 'FORESIGHT_DEFAULT_FEE_BPS', 200, 0, 1_000)

  return {
    port: integer(source, 'PORT', 4021, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'FORESIGHT_DATABASE_URL'),
    databaseUrlTestnet: source['FORESIGHT_DATABASE_URL_TESTNET'] ?? '',
    singleNetwork: source['CF_NETWORK_SINGLE'] ?? '',
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'FORESIGHT_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    identityCredential: optionalCredential(source, 'FORESIGHT_IDENTITY_CREDENTIAL'),

    custodyUrl: required(source, 'CUSTODY_URL'),
    indexerUrl: required(source, 'INDEXER_URL'),
    ledgerUrl: required(source, 'LEDGER_URL'),
    pricingUrl: optionalOrUndefined(source, 'PRICING_URL'),
    policyUrl: required(source, 'POLICY_URL'),
    // The SAME assertion as the credential above, deliberately. See the field docblock: this
    // variable holds a JWT on the live estate and a JWT is what `assertServiceCredential` refuses
    // by name. Pointing it at a weaker check would keep #222 open in the one file that can close it.
    serviceToken: optionalCredential(source, 'FORESIGHT_SERVICE_TOKEN'),
    upstreamDeadlineMs: integer(source, 'FORESIGHT_UPSTREAM_DEADLINE_MS', 5_000, 100, 60_000),

    rpcUrls: jsonMap(source, 'FORESIGHT_RPC_URLS', '{}'),
    rpcDeadlineMs: integer(source, 'FORESIGHT_RPC_DEADLINE_MS', 5_000, 100, 60_000),
    network,
    mainnetEnabled,

    treasuryAddress: address(source, 'FORESIGHT_TREASURY_ADDRESS'),
    houseAddress: optionalAddress(source, 'FORESIGHT_HOUSE_ADDRESS'),
    custodialAddress: optionalAddress(source, 'FORESIGHT_CUSTODIAL_ADDRESS'),
    adminApiUrl: optionalOrUndefined(source, 'ADMIN_API_URL'),
    studioPublicUrl: optionalOrigin(source, 'STUDIO_PUBLIC_URL'),
    oracleAddress: address(source, 'FORESIGHT_ORACLE_ADDRESS'),
    oracleUserId: required(source, 'FORESIGHT_ORACLE_USER_ID'),
    oracleOrderId: required(source, 'FORESIGHT_ORACLE_ORDER_ID'),

    defaultFeeBps,
    // 24 hours. Long enough that a wrong resolution can be noticed by somebody who was asleep, and
    // short enough that a correct one does not feel like a withheld payment.
    defaultDisputeWindowSeconds: integer(
      source,
      'FORESIGHT_DEFAULT_DISPUTE_WINDOW_SECONDS',
      86_400,
      0,
      30 * 86_400,
    ),

    deploysEnabled: optional(source, 'FORESIGHT_DEPLOYS_ENABLED', 'true') !== 'false',
    minGasPriceWei,
    maxGasPriceWei,
    // The market's creation is around 1.2M gas at 200 optimizer runs; the ceiling is set with room
    // and well under custody's own 8,000,000 limit for a creation.
    deployGasLimit: wei(source, 'FORESIGHT_DEPLOY_GAS_LIMIT', 3_000_000n),
    resolveGasLimit: wei(source, 'FORESIGHT_RESOLVE_GAS_LIMIT', 300_000n),
    stuckMinutes: integer(source, 'FORESIGHT_STUCK_MINUTES', 30, 1, 1_440),

    proposerUrl: optionalOrUndefined(source, 'FORESIGHT_PROPOSER_URL'),
    // OPAQUE, not generated: an external model provider chose this value's alphabet. See
    // `optionalOpaqueSecret`.
    proposerToken: optionalOpaqueSecret(source, 'FORESIGHT_PROPOSER_TOKEN'),
    proposerModelId: optionalOrUndefined(source, 'FORESIGHT_PROPOSER_MODEL_ID'),
    searchUrl: optionalOrUndefined(source, 'FORESIGHT_SEARCH_URL'),
    searchToken: optionalOpaqueSecret(source, 'FORESIGHT_SEARCH_TOKEN'),
    proposerDeadlineMs: integer(source, 'FORESIGHT_PROPOSER_DEADLINE_MS', 30_000, 1_000, 120_000),
    proposerBatchSize: integer(source, 'FORESIGHT_PROPOSER_BATCH_SIZE', 5, 1, 25),

    policyAction: optional(source, 'FORESIGHT_POLICY_ACTION', 'trade.order.place'),
    policyDeadlineMs: integer(source, 'FORESIGHT_POLICY_DEADLINE_MS', 3_000, 100, 30_000),

    leaseMs: integer(source, 'FORESIGHT_LEASE_MS', 60_000, 1_000, 600_000),
    jobPollMs: integer(source, 'FORESIGHT_JOB_POLL_MS', 1_000, 100, 60_000),
    proposeEveryMinutes: integer(source, 'FORESIGHT_PROPOSE_EVERY_MINUTES', 360, 5, 10_080),
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
