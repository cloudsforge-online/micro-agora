/**
 * Resolution: checking the named source, and posting the answer on chain.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A MARKET WHOSE NAMED SOURCE IS GONE AT RESOLUTION IS VOID.**
 *
 * 19-new-products.md §2.3.5, and it is the rule that costs something, which is how you know it is
 * doing work. The tempting alternative is always available and always available in good faith: the
 * exchange this market named has shut down, but here is another exchange with the same figure, and
 * everyone can see what the answer obviously is. Taking it once makes the criteria advisory, and
 * criteria that are advisory are criteria the operator chooses after the fact — which is precisely
 * the thing a stranger staking money has no way to check.
 *
 * So: source unreachable at resolution → `void`, refund, whole, no fee. The market cost the
 * platform its fee and cost the bettors nothing, and that asymmetry is the point. It gives the
 * operator a standing incentive to name sources that will still be there.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## How the oracle posts, and why it looks strange
 *
 * The oracle key is held by `micro-custody`, whose EVM policy for a `deployer`-purpose address
 * permits exactly one shape: a zero-value contract CREATION (`custody/src/signing.ts`).
 * There is no purpose in custody today that signs a contract call — `transfer` requires empty
 * calldata and says in terms that widening it would turn the key into a signing oracle
 * (`custody/src/signing.ts`), `SIGNABLE_PURPOSES` is three names (`custody/src/gates.ts`),
 * and `custody_keys_purpose_ck` will not store a fourth (`custody/src/migrations.ts`).
 *
 * So the resolution IS a contract creation: a `ForesightResolver` whose constructor calls
 * `oracleAct` and which then deploys with no runtime code at all. The market checks
 * `msg.sender == createAddress(oracle, nonce)` for a nonce the resolver supplies, which is exactly
 * as strong as `msg.sender == oracle` — only the oracle account can ever produce a contract at that
 * address. Nothing about custody changed, no new signing path exists, and the key still cannot move
 * a wei.
 *
 * ## The chain-keyed lease, and why it is coarse here
 *
 * Every market on a chain resolves through ONE oracle address, so the contended resource genuinely
 * is that address's nonce. This is `micro-settlement`'s case exactly, and the key is
 * `oracle:<chain>:<network>` with `resolutions_in_flight_uniq` behind it. Two workers past a skewed
 * lease would read one nonce, obtain two signatures, and one of the two resolutions would be lost
 * with a market's winners waiting on it.
 */

import type { Logger, Metrics } from '@cloudsforge/telemetry'
import type { Network } from '@cloudsforge/contracts-chain'
import { FORESIGHTRESOLVER_BYTECODE } from './contracts/generated.ts'
import { createAddress, creationData, evmTxHash, gasPriceBid, quantity, type FeeBounds, type JsonRpc } from './evm.ts'
import { chainIdOf, chainKey, custodyChainOf, familyOf, type ChainId } from './chains.ts'
import { CustodySignRefusedError, CustodyUnavailableError, type CustodyClient } from './custodyclient.ts'
import { broadcast, ChainRefusedError, ChainUnavailableError, receiptFor } from './deploy.ts'
import { findMarket } from './markets.ts'
import type { Db } from './outbox.ts'

/** What the oracle is being asked to say. The contract's own `ACTION_` constants. */
export const ACTION_RESOLVE_YES = 0
export const ACTION_RESOLVE_NO = 1
export const ACTION_VOID = 2

export type ResolutionState = 'planned' | 'building' | 'signed' | 'broadcast' | 'confirmed' | 'failed'

export interface Resolution {
  readonly id: string
  readonly marketId: string
  readonly chain: string
  readonly network: string
  readonly action: number
  readonly rationale: string
  readonly state: ResolutionState
  readonly oracleAddress: string | null
  readonly oracleNonce: bigint | null
  readonly resolverAddress: string | null
  readonly rawTx: string | null
  readonly txHash: string | null
  readonly custodyAuditId: string | null
  readonly broadcastAt: Date | null
  readonly confirmedAt: Date | null
  readonly attempts: number
  readonly lastError: string | null
}

/**
 * The operator-visible half of a resolution.
 *
 * TWO DEFECTS IN ONE LINE OF CODE. `GET /markets/:id/resolution` used to return the `Resolution`
 * row verbatim, and:
 *
 *   1. **It 500'd from the moment the oracle signed.** `oracleNonce` is a `bigint`, `send()`
 *      serialises with `JSON.stringify` (`server.ts`), and JSON.stringify THROWS on a bigint
 *      rather than coercing it. So the route worked for exactly as long as the resolution had not
 *      been signed — which is to say, it failed on every call an operator would actually make,
 *      while its tests (which never covered the route) stayed green.
 *   2. **It exposed the signing path.** `rawTx`, `oracleAddress`, `resolverAddress` and
 *      `custodyAuditId` are how the resolution gets signed and broadcast; an operator console
 *      needs to know a resolution's STATE, never its transaction bytes.
 *
 * Narrowing fixes both at once, which is why it is one function rather than a serialiser patch: a
 * bigint replacer bolted onto `send()` would have fixed the 500 and left the exposure, and would
 * have quietly permitted bigints on every other route, where this estate's convention is that an
 * amount crosses as a decimal string chosen deliberately, not coerced by a global.
 *
 * Found by micro-foresight-admin-web, the first client to call the route.
 */
export interface ResolutionView {
  readonly id: string
  readonly marketId: string
  readonly chain: string
  readonly network: string
  readonly action: number
  readonly rationale: string
  readonly state: ResolutionState
  /** A decimal string. Never a bigint: see above. */
  readonly oracleNonce: string | null
  readonly txHash: string | null
  readonly broadcastAt: string | null
  readonly confirmedAt: string | null
  readonly attempts: number
  readonly lastError: string | null
}

export function resolutionView(r: Resolution): ResolutionView {
  return {
    id: r.id,
    marketId: r.marketId,
    chain: r.chain,
    network: r.network,
    action: r.action,
    rationale: r.rationale,
    state: r.state,
    oracleNonce: r.oracleNonce === null ? null : r.oracleNonce.toString(),
    txHash: r.txHash,
    broadcastAt: r.broadcastAt === null ? null : r.broadcastAt.toISOString(),
    confirmedAt: r.confirmedAt === null ? null : r.confirmedAt.toISOString(),
    attempts: r.attempts,
    lastError: r.lastError,
  }
}

interface ResolutionRow {
  readonly id: string
  readonly market_id: string
  readonly chain: string
  readonly network: string
  readonly action: number
  readonly rationale: string
  readonly state: string
  readonly oracle_address: string | null
  readonly oracle_nonce: string | null
  readonly resolver_address: string | null
  readonly raw_tx: string | null
  readonly tx_hash: string | null
  readonly custody_audit_id: string | null
  readonly broadcast_at: Date | null
  readonly confirmed_at: Date | null
  readonly attempts: number
  readonly last_error: string | null
}

const COLUMNS = `id, market_id, chain, network, action, rationale, state, oracle_address,
  oracle_nonce, resolver_address, raw_tx, tx_hash, custody_audit_id, broadcast_at, confirmed_at,
  attempts, last_error`

function toResolution(row: ResolutionRow): Resolution {
  return {
    id: row.id,
    marketId: row.market_id,
    chain: row.chain,
    network: row.network,
    action: row.action,
    rationale: row.rationale,
    state: row.state as ResolutionState,
    oracleAddress: row.oracle_address,
    oracleNonce: row.oracle_nonce === null ? null : BigInt(row.oracle_nonce),
    resolverAddress: row.resolver_address,
    rawTx: row.raw_tx,
    txHash: row.tx_hash,
    custodyAuditId: row.custody_audit_id,
    broadcastAt: row.broadcast_at,
    confirmedAt: row.confirmed_at,
    attempts: row.attempts,
    lastError: row.last_error,
  }
}

/* ------------------------------------------------------------------ the named source */

/**
 * Is the source this market named at open still there?
 *
 * An interface rather than a `fetch` call, because the answer must be substitutable in a test — the
 * whole rule is about what happens when a source is GONE, and no test can arrange for the internet
 * to lose a domain on cue.
 */
export interface SourceProbe {
  /** True when the named source answers. False when it is gone, timed out, or 4xx/5xx. */
  reachable(sourceRef: string): Promise<boolean>
}

/**
 * The real probe: a GET, following redirects, with a deadline.
 *
 * GET rather than HEAD. A great many endpoints answer 405 to HEAD while serving GET perfectly, and
 * a probe that voided a market over that would be worse than no probe at all — it would refund
 * markets whose sources were fine and cost the platform its fee for a request method.
 *
 * **This checks reachability, not agreement.** Whether the source SAYS yes or no is a judgement an
 * operator makes and types in; automating it would mean this service scraping a figure out of a
 * page and settling money on the result, which is a far larger thing to get wrong than anything
 * else in this repository.
 */
export function httpSourceProbe(
  deadlineMs: number,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): SourceProbe {
  return {
    async reachable(sourceRef) {
      let url: URL
      try {
        url = new URL(sourceRef)
      } catch {
        // A source that is not a URL — a named index, an in-person publication — cannot be probed,
        // and refusing to resolve it would void every market in the `price_index` category. The
        // operator's own check is the resolution for those, which is what the rationale records.
        return true
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(deadlineMs),
        })
        return response.ok
      } catch {
        return false
      }
    },
  }
}

/* ------------------------------------------------------------------ planning */

export class ResolutionError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'ResolutionError'
    this.code = code
    this.status = status
  }
}

/**
 * Decide what the oracle will post, and write it down. Does not touch the chain.
 *
 * The source check happens HERE rather than at broadcast time, deliberately: the decision to void
 * for a missing source is a decision, and it belongs in the row with its rationale where an
 * operator can see it before a wei of gas is spent.
 */
export async function planResolution(
  sql: Db,
  probe: SourceProbe,
  input: {
    readonly marketId: string
    /** What the operator says the outcome is. Ignored when the source turns out to be gone. */
    readonly outcome: 0 | 1
    readonly rationale: string
  },
): Promise<Resolution> {
  const market = await findMarket(sql, input.marketId)
  if (!market) throw new ResolutionError('not_found', 'no market with that id', 404)
  if (market.status !== 'closed') {
    throw new ResolutionError(
      'not_closed',
      `a market is resolved after it closes; this one is ${market.status}`,
    )
  }
  if (input.rationale.trim().length === 0) {
    throw new ResolutionError('no_rationale', 'a resolution must say what it was based on', 400)
  }

  const reachable = await probe.reachable(market.resolutionSourceRef)
  const action = reachable ? (input.outcome === 0 ? ACTION_RESOLVE_YES : ACTION_RESOLVE_NO) : ACTION_VOID
  const rationale = reachable
    ? input.rationale.trim()
    : `the named resolution source is unreachable at resolution: ${market.resolutionSourceRef} — ` +
      'voided rather than resolved from a source this market did not name'

  const rows = await sql<ResolutionRow[]>`
    insert into resolutions (market_id, chain, network, action, rationale)
    values (${market.id}, ${market.chain}, ${market.network}, ${action}, ${rationale})
    on conflict (market_id) do nothing
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) {
    // `resolutions_market_uniq` refused: a resolution for this market already exists. Returning it
    // rather than erroring makes the route idempotent in the way a caller actually needs — a retry
    // after a lost response gets the plan that was made, not a 409 it has to interpret.
    const existing = await findResolutionByMarket(sql, market.id)
    if (!existing) throw new ResolutionError('conflict', 'the resolution could not be planned')
    return existing
  }
  return toResolution(row)
}

export async function findResolution(sql: Db, id: string): Promise<Resolution | null> {
  const rows = await sql<ResolutionRow[]>`select ${sql.unsafe(COLUMNS)} from resolutions where id = ${id}`
  const row = rows[0]
  return row ? toResolution(row) : null
}

export async function findResolutionByMarket(sql: Db, marketId: string): Promise<Resolution | null> {
  const rows = await sql<ResolutionRow[]>`
    select ${sql.unsafe(COLUMNS)} from resolutions where market_id = ${marketId}
  `
  const row = rows[0]
  return row ? toResolution(row) : null
}

export async function listOutstandingResolutions(sql: Db, limit: number): Promise<readonly Resolution[]> {
  const rows = await sql<ResolutionRow[]>`
    select ${sql.unsafe(COLUMNS)} from resolutions
     where state in ('planned','building','signed','broadcast')
       and (lease_until is null or lease_until < now())
     order by created_at limit ${limit}
  `
  return rows.map(toResolution)
}

/* ------------------------------------------------------------------ the chain-keyed claim */

/**
 * A unique-violation on the in-flight index, told apart from every other database error.
 *
 * 23505 on `resolutions_in_flight_uniq` means another resolution on this chain reached `building`
 * first. It is the last line of the defence, it fires only when the lease has already failed, and
 * it must be caught rather than propagated — the correct response is "not my turn", not an alarm.
 * `micro-settlement/src/outbound.ts`, verbatim in intent.
 */
export function isInFlightConflict(err: unknown): boolean {
  const e = err as { code?: unknown; constraint_name?: unknown }
  return e?.code === '23505' && e?.constraint_name === 'resolutions_in_flight_uniq'
}

/**
 * Take a `planned` row to `building`: the claim on this chain's oracle nonce.
 *
 * False means somebody else has it. Two ways that happens and both are ordinary:
 *
 *   1. The conditional UPDATE matched no row, because the state has already moved.
 *   2. The partial unique index refused, because another resolution on this chain is in flight.
 *      **This is the moment the design turns on.** With the lease working it cannot happen; without
 *      the index it would not be caught at all, and the second worker would go on to read the same
 *      nonce and ask custody for a second signature against it.
 */
export async function claimForBuilding(
  sql: Db,
  id: string,
  owner: string,
  leaseMs: number,
): Promise<boolean> {
  try {
    const rows = await sql`
      update resolutions
         set state = 'building', attempts = attempts + 1, lease_owner = ${owner},
             lease_until = now() + (${String(leaseMs)} || ' milliseconds')::interval,
             updated_at = now()
       where id = ${id} and state = 'planned' and raw_tx is null
      returning id
    `
    return rows.length > 0
  } catch (err) {
    if (isInFlightConflict(err)) return false
    throw err
  }
}

export async function releaseResolutionLease(sql: Db, id: string, owner: string): Promise<void> {
  await sql`
    update resolutions set lease_owner = null, lease_until = null, updated_at = now()
     where id = ${id} and lease_owner = ${owner}
  `
}

/** Commit bytes, hash and derived resolver address BEFORE anything is broadcast. Mint's rule. */
export async function markResolutionSigned(
  sql: Db,
  input: {
    readonly id: string
    readonly owner: string
    readonly oracleAddress: string
    readonly oracleNonce: bigint
    readonly resolverAddress: string
    readonly rawTx: string
    readonly txHash: string
    readonly custodyAuditId: string
  },
): Promise<boolean> {
  const rows = await sql`
    update resolutions
       set state = 'signed', oracle_address = ${input.oracleAddress},
           oracle_nonce = ${input.oracleNonce.toString()},
           resolver_address = ${input.resolverAddress}, raw_tx = ${input.rawTx},
           tx_hash = ${input.txHash}, custody_audit_id = ${input.custodyAuditId}, updated_at = now()
     where id = ${input.id} and lease_owner = ${input.owner} and raw_tx is null
    returning id
  `
  return rows.length > 0
}

export async function markResolutionBroadcast(sql: Db, id: string, at: Date): Promise<void> {
  await sql`
    update resolutions set state = 'broadcast', broadcast_at = ${at}, updated_at = now()
     where id = ${id} and broadcast_at is null and raw_tx is not null
  `
}

export async function markResolutionConfirmed(sql: Db, id: string, at: Date): Promise<void> {
  await sql`
    update resolutions
       set state = 'confirmed', confirmed_at = ${at}, lease_owner = null, lease_until = null,
           updated_at = now()
     where id = ${id} and state = 'broadcast'
  `
}

export async function markResolutionFailed(sql: Db, id: string, reason: string): Promise<void> {
  await sql`
    update resolutions
       set state = 'failed', last_error = ${reason.slice(0, 2_000)}, lease_owner = null,
           lease_until = null, updated_at = now()
     where id = ${id}
  `
}

/* ------------------------------------------------------------------ the drive */

export interface ResolveDeps {
  readonly sql: Db
  readonly owner: string
  readonly custody: CustodyClient
  readonly rpc: (chain: ChainId) => JsonRpc
  readonly bounds: FeeBounds
  readonly gasLimit: bigint
  readonly oracleAddress: string
  readonly oracleUserId: string
  readonly oracleOrderId: string
  readonly leaseMs: number
  readonly enabled: boolean
  readonly logger: Logger
  readonly metrics: Metrics
  readonly now?: () => number
}

export type ResolveResult = 'skipped' | 'not_claimed' | 'broadcast' | 'confirmed' | 'failed' | 'pending'

/** The lease key. The oracle's nonce is the contended resource, so the key names the chain. */
export function resolutionLeaseKey(chain: ChainId, network: Network): string {
  return `oracle:${chainKey(chain, network)}`
}

/**
 * Build, sign, broadcast and confirm one resolution.
 *
 * The same commit-before-broadcast shape as `deploy.ts`, for the same reason: a crash between the
 * send and the write that records it would otherwise leave a resolver on the wire with no id to
 * poll, and the retry would create a SECOND resolver at a second nonce. The market would reject
 * the second one (it is no longer `Open`), so no money would move wrongly — but the row would be
 * stuck and the gas would be spent, and the operator would be looking at a market that says
 * "resolving" while the chain says "resolved".
 */
export async function driveResolution(deps: ResolveDeps, resolutionId: string): Promise<ResolveResult> {
  if (!deps.enabled) return 'skipped'

  const existing = await findResolution(deps.sql, resolutionId)
  if (!existing) return 'not_claimed'
  if (existing.state === 'confirmed' || existing.state === 'failed') return 'not_claimed'

  // Bytes already committed: re-SEND them, never re-sign. Safe concurrently — two replicas sending
  // identical bytes produce one transaction, and both writes below are conditional.
  if (existing.rawTx && existing.txHash) return sendResolution(deps, existing)

  const claimed = await claimForBuilding(deps.sql, resolutionId, deps.owner, deps.leaseMs)
  if (!claimed) return 'not_claimed'

  const resolution = await findResolution(deps.sql, resolutionId)
  if (!resolution) return 'not_claimed'

  try {
    return await buildAndSend(deps, resolution)
  } catch (err) {
    if (err instanceof CustodySignRefusedError || err instanceof ChainRefusedError) {
      await markResolutionFailed(deps.sql, resolutionId, err.message)
      deps.metrics.increment('foresight_resolutions_total', { outcome: 'failed' })
      deps.logger.error('resolution failed', { resolutionId, reason: err.message })
      return 'failed'
    }
    // Custody being unreachable is the same situation as the chain being unreachable: we do not
    // know whether it signed. See the matching branch in `deploy.ts`.
    if (err instanceof ChainUnavailableError || err instanceof CustodyUnavailableError) {
      deps.logger.warn('resolution paused: an upstream was unavailable', {
        resolutionId,
        err: err.message,
      })
      await releaseResolutionLease(deps.sql, resolutionId, deps.owner)
      return 'pending'
    }
    await releaseResolutionLease(deps.sql, resolutionId, deps.owner)
    throw err
  }
}

async function buildAndSend(deps: ResolveDeps, resolution: Resolution): Promise<ResolveResult> {
  const chain = resolution.chain as ChainId
  const network = resolution.network as Network
  const rpc = deps.rpc(chain)

  const market = await findMarket(deps.sql, resolution.marketId)
  if (!market?.contractAddress) {
    throw new ChainRefusedError('the market has no contract to resolve')
  }

  const quoted = quantity(await rpc('eth_gasPrice', []), 'eth_gasPrice')
  const gasPrice = gasPriceBid(quoted, deps.bounds)
  // `pending`, so a resolver already in a mempool is counted. Two resolutions signed against one
  // nonce is the exact failure the chain-keyed lease exists to prevent, and reading `latest` here
  // would reintroduce it inside a single worker.
  const nonce = quantity(
    await rpc('eth_getTransactionCount', [deps.oracleAddress, 'pending']),
    'eth_getTransactionCount',
  )

  // The resolver's own address, derived before it exists. The market recomputes exactly this and
  // compares it to `msg.sender` — see `ForesightMarket.computeCreateAddress`.
  const resolverAddress = createAddress(deps.oracleAddress, nonce)

  const data = creationData(FORESIGHTRESOLVER_BYTECODE, [
    { type: 'address', value: market.contractAddress },
    { type: 'uint8', value: BigInt(resolution.action) },
    { type: 'uint64', value: nonce },
  ])

  const signed = await deps.custody.sign({
    address: deps.oracleAddress,
    chain: custodyChainOf(chain),
    network,
    family: familyOf(chain),
    // The SAME purpose mint uses, and the only one custody signs a creation for. There is no new
    // signing path here: this is the shape custody already permits, used for what it permits.
    purpose: 'deployer',
    userId: deps.oracleUserId,
    orderId: deps.oracleOrderId,
    payload: {
      type: 0,
      to: null,
      value: '0',
      data,
      nonce: Number(nonce),
      gasLimit: deps.gasLimit.toString(),
      gasPrice: gasPrice.toString(),
      chainId: chainIdOf(chain, network),
    },
    correlationId: resolution.id,
  })

  const txHash = evmTxHash(signed.signedTx)
  if (!txHash) throw new ChainUnavailableError('custody returned bytes that are not a transaction')

  const committed = await markResolutionSigned(deps.sql, {
    id: resolution.id,
    owner: deps.owner,
    oracleAddress: deps.oracleAddress,
    oracleNonce: nonce,
    resolverAddress,
    rawTx: signed.signedTx,
    txHash,
    custodyAuditId: signed.auditId,
  })
  if (!committed) {
    // The lease was taken over while the signature was in the air. DISCARD IT UNBROADCAST: nothing
    // was sent, so no gas was spent and no resolver exists.
    deps.logger.warn('a resolution signature was discarded unbroadcast', { resolutionId: resolution.id })
    return 'not_claimed'
  }

  const refreshed = await findResolution(deps.sql, resolution.id)
  if (!refreshed) return 'not_claimed'
  return sendResolution(deps, refreshed)
}

async function sendResolution(deps: ResolveDeps, resolution: Resolution): Promise<ResolveResult> {
  const chain = resolution.chain as ChainId
  const rpc = deps.rpc(chain)
  const rawTx = resolution.rawTx
  const txHash = resolution.txHash
  if (!rawTx || !txHash) throw new Error('sendResolution called for a row with no committed bytes')

  if (!resolution.broadcastAt) {
    await broadcast(rawTx, rpc)
    await markResolutionBroadcast(deps.sql, resolution.id, new Date((deps.now ?? Date.now)()))
    deps.metrics.increment('foresight_resolutions_broadcast_total')
    deps.logger.info('resolution broadcast', {
      resolutionId: resolution.id,
      marketId: resolution.marketId,
      txHash,
    })
  }

  const receipt = await receiptFor(rpc, txHash)
  if (!receipt) {
    await releaseResolutionLease(deps.sql, resolution.id, deps.owner)
    return 'broadcast'
  }
  if (receipt.status !== 1n) {
    // The resolver's constructor reverted, which means the MARKET refused the call. Every reason it
    // can is a real fact about the market — not yet closed, already resolved, wrong caller — and
    // none is fixed by trying again with the same inputs.
    const reason = 'the resolver creation reverted: the market refused the oracle action'
    await markResolutionFailed(deps.sql, resolution.id, reason)
    deps.metrics.increment('foresight_resolutions_total', { outcome: 'failed' })
    deps.logger.error('resolution rejected by the market contract', {
      resolutionId: resolution.id,
      marketId: resolution.marketId,
      txHash,
    })
    return 'failed'
  }

  await markResolutionConfirmed(deps.sql, resolution.id, new Date((deps.now ?? Date.now)()))
  deps.metrics.increment('foresight_resolutions_total', { outcome: 'confirmed' })
  deps.logger.info('resolution confirmed on chain', {
    resolutionId: resolution.id,
    marketId: resolution.marketId,
    action: resolution.action,
    txHash,
  })
  return 'confirmed'
}
