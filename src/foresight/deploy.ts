/**
 * Deploying a market contract, as background work.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE DEPLOY IS NOT IN THE REQUEST.** `POST /markets/:id/deploy` answers 202 with a status URL;
 * everything below runs under a lease, in a job, on whichever replica claims it. That is
 * `micro-mint`'s pattern and it is inherited wholesale, because the failure it prevents is the same
 * one and is worse here: mint's bad landing costs a duplicate token and some gas, and this one
 * would leave two market contracts for one question with stakers split between the pools.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The sequence, and why each step must precede the next
 *
 *     claim → provision deployer → check funding → PREPARE (sign) → COMMIT bytes → broadcast →
 *     record broadcast → poll outcome
 *
 * A crash before the commit has broadcast nothing: the signature is discarded unbroadcast, no gas
 * was spent, and the next tick rebuilds from a fresh nonce read. A crash after the commit and
 * before the send leaves bytes with no `broadcast_at`, and the next tick RESUMES AT BROADCAST with
 * the identical bytes — a re-send of one transaction, never a second one. A crash after the send is
 * covered because the hash was written WITH the bytes, so the row can be polled to a terminal state
 * without anything being sent again.
 *
 * **That is the whole answer to "a lost broadcast response must not produce two contracts."** The
 * hash is derivable before the send (`evm.ts`'s `evmTxHash`), so there is no window in which a
 * transaction exists and its id does not. `markets_deploy_in_flight_uniq` and
 * `markets_deploy_tx_hash_uniq` are the database saying the same thing for the case where the lease
 * has already failed — `micro-settlement`'s discipline, applied to the resource that is genuinely
 * contended here.
 *
 * ## Why the market's address is known before it exists
 *
 * `createAddress(deployer, nonce)` is a total function of two values this service holds, so the
 * contract address is committed with the bytes and checked against the receipt when one arrives. A
 * derived address that disagrees with the mined one means the nonce moved under us, and that is the
 * one condition under which a deploy must be FAILED rather than confirmed — the contract at the
 * address we published is not ours.
 */

import type { Logger, Metrics } from '@cloudsforge/telemetry'
import type { Network } from '@cloudsforge/contracts-chain'
import { FORESIGHTMARKET_BYTECODE } from './contracts/generated.ts'
import {
  ChainError,
  createAddress,
  creationData,
  evmTxHash,
  gasPriceBid,
  quantity,
  toChecksumAddress,
  type FeeBounds,
  type JsonRpc,
} from './evm.ts'
import { chainIdOf, custodyChainOf, familyOf, type ChainId } from './chains.ts'
import { CustodySignRefusedError, CustodyUnavailableError, type CustodyClient } from './custodyclient.ts'
import { findMarket, toMarket, type Market } from './markets.ts'
import type { Db } from './outbox.ts'

/** The chain would not accept this, and would not accept it on a second try either. */
export class ChainRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChainRefusedError'
  }
}

/** We could not reach the chain, or it answered nonsense. We do not know what happened. */
export class ChainUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChainUnavailableError'
  }
}

export interface DeployDeps {
  readonly sql: Db
  readonly producer: string
  readonly owner: string
  readonly network: Network
  readonly custody: CustodyClient
  readonly rpc: (chain: ChainId) => JsonRpc
  readonly bounds: FeeBounds
  readonly gasLimit: bigint
  readonly treasuryAddress: string
  readonly oracleAddress: string
  readonly leaseMs: number
  readonly stuckMs: number
  readonly enabled: boolean
  readonly logger: Logger
  readonly metrics: Metrics
  readonly now?: () => number
}

export type DriveResult =
  | 'skipped'
  | 'not_claimed'
  | 'awaiting_funds'
  | 'broadcast'
  | 'pending'
  | 'deployed'
  | 'failed'

const COLUMNS = `id, status, idea_id, idea_status, question, resolution_criteria, category,
  category_version, resolution_source_kind, resolution_source_ref, question_hash, close_time,
  dispute_window_seconds, fee_bps, chain, network, approved_by, approved_at, deploy_state,
  deployer_address, contract_address, deploy_nonce, raw_tx, deploy_tx_hash, custody_audit_id,
  broadcast_at, deploy_attempts, deploy_error, opened_at, closed_at, resolved_at, settled_at,
  voided_at, void_reason, outcome, created_at, updated_at`

/* ------------------------------------------------------------------ store */

/**
 * Take the deploy lease, or refuse.
 *
 * **Deliberately refuses a row that already has `raw_tx`.** Re-SIGNING a committed row is the
 * mistake; re-SENDING it is the recovery, and that path is `resumeIfSigned` below. Splitting them
 * is what makes "two workers, one lost broadcast" produce one contract rather than two.
 */
export async function claimDeploy(
  sql: Db,
  input: { readonly id: string; readonly owner: string; readonly leaseMs: number },
): Promise<Market | null> {
  const rows = await sql`
    update markets
       set deploy_state = 'building',
           deploy_attempts = deploy_attempts + 1,
           lease_owner = ${input.owner},
           lease_until = now() + (${String(input.leaseMs)} || ' milliseconds')::interval,
           updated_at = now()
     where id = ${input.id}
       and status = 'approved'
       and deploy_state in ('pending','building')
       and raw_tx is null
       and (lease_until is null or lease_until < now())
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toMarket(row as never) : null
}

export async function renewLease(
  sql: Db,
  input: { readonly id: string; readonly owner: string; readonly leaseMs: number },
): Promise<boolean> {
  const rows = await sql`
    update markets
       set lease_until = now() + (${String(input.leaseMs)} || ' milliseconds')::interval,
           updated_at = now()
     where id = ${input.id} and lease_owner = ${input.owner}
    returning id
  `
  return rows.length > 0
}

export async function releaseLease(sql: Db, id: string, owner: string): Promise<void> {
  await sql`
    update markets set lease_owner = null, lease_until = null, updated_at = now()
     where id = ${id} and lease_owner = ${owner}
  `
}

export async function markProvisioned(
  sql: Db,
  input: { readonly id: string; readonly owner: string; readonly deployerAddress: string },
): Promise<Market | null> {
  const rows = await sql`
    update markets set deployer_address = ${input.deployerAddress}, updated_at = now()
     where id = ${input.id} and lease_owner = ${input.owner}
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toMarket(row as never) : null
}

/**
 * **COMMIT THE BYTES, THE HASH AND THE ADDRESS — BEFORE ANYTHING IS BROADCAST.**
 *
 * Conditional on still holding the lease. If it does not match — the lease was taken over while the
 * signature was in the air — the signature is DISCARDED UNBROADCAST. Nothing was sent, so no gas
 * was spent and no contract exists.
 */
export async function markSigned(
  sql: Db,
  input: {
    readonly id: string
    readonly owner: string
    readonly rawTx: string
    readonly txHash: string
    readonly nonce: bigint
    readonly contractAddress: string
    readonly custodyAuditId: string
  },
): Promise<Market | null> {
  const rows = await sql`
    update markets
       set deploy_state = 'signed',
           raw_tx = ${input.rawTx},
           deploy_tx_hash = ${input.txHash},
           deploy_nonce = ${input.nonce.toString()},
           contract_address = ${input.contractAddress},
           custody_audit_id = ${input.custodyAuditId},
           updated_at = now()
     where id = ${input.id} and lease_owner = ${input.owner} and raw_tx is null
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toMarket(row as never) : null
}

export async function markBroadcast(
  sql: Db,
  input: { readonly id: string; readonly at: Date },
): Promise<Market | null> {
  const rows = await sql`
    update markets
       set deploy_state = 'broadcast', broadcast_at = ${input.at}, updated_at = now()
     where id = ${input.id} and broadcast_at is null and raw_tx is not null
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toMarket(row as never) : null
}

export async function markDeployed(sql: Db, id: string): Promise<Market | null> {
  const rows = await sql`
    update markets
       set deploy_state = 'deployed', lease_owner = null, lease_until = null, updated_at = now()
     where id = ${id} and deploy_state = 'broadcast'
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toMarket(row as never) : null
}

export async function markDeployFailed(sql: Db, id: string, reason: string): Promise<void> {
  await sql`
    update markets
       set deploy_state = 'failed', deploy_error = ${reason.slice(0, 2_000)},
           lease_owner = null, lease_until = null, updated_at = now()
     where id = ${id}
  `
}

export async function recordAttempt(
  sql: Db,
  input: {
    readonly marketId: string
    readonly attempt: number
    readonly outcome: string
    readonly txHash?: string | undefined
    readonly detail?: string | undefined
  },
): Promise<void> {
  await sql`
    insert into market_deploy_attempts (market_id, attempt, outcome, tx_hash, detail)
    values (${input.marketId}, ${input.attempt}, ${input.outcome}, ${input.txHash ?? null},
            ${input.detail?.slice(0, 2_000) ?? null})
  `
}

/** Markets whose deploy is not finished. The sweep's queue — a closed tab must not strand one. */
export async function listOutstandingDeploys(sql: Db, limit: number): Promise<readonly Market[]> {
  const rows = await sql`
    select ${sql.unsafe(COLUMNS)} from markets
     where status = 'approved' and deploy_state in ('pending','building','signed','broadcast')
       and (lease_until is null or lease_until < now())
     order by updated_at limit ${limit}
  `
  return rows.map((row) => toMarket(row as never))
}

/* ------------------------------------------------------------------ the drive */

/**
 * Advance one market's deploy by as much as it can be advanced in one lease.
 *
 * Returns rather than throws for every outcome the domain has a name for. A throw here is a fault:
 * the runner burns an attempt, backs off and retries, which is what should happen to a bug and
 * emphatically not to "the deployer has not been funded yet".
 */
export async function driveDeploy(deps: DeployDeps, marketId: string): Promise<DriveResult> {
  if (!deps.enabled) return 'skipped'

  const claimed = await claimDeploy(deps.sql, {
    id: marketId,
    owner: deps.owner,
    leaseMs: deps.leaseMs,
  })
  if (!claimed) {
    // Somebody else holds it, or the row is terminal, or bytes are already committed and this path
    // is not the one that resumes them. All ordinary; none an error.
    return resumeIfSigned(deps, marketId)
  }

  try {
    return await advance(deps, claimed)
  } catch (err) {
    if (err instanceof CustodySignRefusedError || err instanceof ChainRefusedError || err instanceof ChainError) {
      // A peer looked at this request and said no. Permanent for these inputs, so retrying is a
      // guaranteed second refusal and a second burnt attempt.
      await recordAttempt(deps.sql, {
        marketId,
        attempt: claimed.deployAttempts,
        outcome: 'refused',
        detail: err.message,
      })
      await markDeployFailed(deps.sql, marketId, err.message)
      deps.metrics.increment('foresight_deploys_total', { outcome: 'failed' })
      deps.logger.error('market deploy failed', { marketId, reason: err.message })
      return 'failed'
    }
    // **A CUSTODY OUTAGE IS UNAVAILABILITY, NOT A REFUSAL, AND THE DIFFERENCE IS THE WHOLE POINT
    // OF `CustodyUnavailableError` EXISTING.** A refusal that was really a timeout would fail a
    // market whose signature may exist, and a signature that exists is a transaction that may yet
    // reach a chain. This branch was missing until `deploy.test.ts` threw the error at it.
    if (err instanceof ChainUnavailableError || err instanceof CustodyUnavailableError) {
      // We do not know what happened. The row keeps everything it has, the lease is released so
      // another replica may take it immediately, and nothing is failed — a node having a bad minute
      // must not cost an approved market its deploy.
      await recordAttempt(deps.sql, {
        marketId,
        attempt: claimed.deployAttempts,
        outcome: 'unavailable',
        detail: err.message,
      })
      deps.logger.warn('deploy paused: an upstream was unavailable', { marketId, err: err.message })
      await releaseLease(deps.sql, marketId, deps.owner)
      return 'pending'
    }
    await releaseLease(deps.sql, marketId, deps.owner)
    throw err
  }
}

async function advance(deps: DeployDeps, claimed: Market): Promise<DriveResult> {
  const chain = claimed.chain as ChainId
  const rpc = deps.rpc(chain)

  // 1. The deployer address. Idempotent on custody's side, so a re-claim after a lost response
  //    finds the address that already exists rather than minting a second nonce sequence.
  let market = claimed
  if (!market.deployerAddress) {
    const deployer = await deps.custody.provisionDeployer({
      chain: custodyChainOf(chain),
      network: market.network as Network,
      // The market id IS the order id, which is what makes the call idempotent per market.
      userId: 'foresight',
      orderId: market.id,
      correlationId: market.id,
    })
    const provisioned = await markProvisioned(deps.sql, {
      id: market.id,
      owner: deps.owner,
      deployerAddress: toChecksumAddress(deployer.address),
    })
    if (!provisioned) return 'not_claimed'
    market = provisioned
  }
  await heartbeat(deps, market.id)

  const deployerAddress = market.deployerAddress
  if (!deployerAddress) throw new ChainUnavailableError('the deployer address vanished mid-deploy')

  // 2. Fee bid and funding, in that order. A real number rather than `balance > 0`: a gate that
  //    lets one wei of dust through is a gate whose deploy then dies at the node with the lease
  //    already claimed.
  const quoted = quantity(await rpc('eth_gasPrice', []), 'eth_gasPrice')
  const gasPrice = gasPriceBid(quoted, deps.bounds)
  const required = gasPrice * deps.gasLimit
  const balance = quantity(
    await rpc('eth_getBalance', [deployerAddress, 'latest']),
    'eth_getBalance',
  )
  if (balance < required) {
    deps.logger.info('deploy is awaiting funds', {
      marketId: market.id,
      required: required.toString(),
      balance: balance.toString(),
    })
    await awaitFunds(deps, market.id)
    return 'awaiting_funds'
  }
  await heartbeat(deps, market.id)

  // 3. Sign. `pending` rather than `latest`, so a transaction this address already has in a
  //    mempool is counted — otherwise two deploys in a row reuse one nonce and the second is
  //    silently replaced.
  const nonce = quantity(
    await rpc('eth_getTransactionCount', [deployerAddress, 'pending']),
    'eth_getTransactionCount',
  )
  const data = creationData(FORESIGHTMARKET_BYTECODE, [
    { type: 'address', value: deps.oracleAddress },
    { type: 'address', value: deps.treasuryAddress },
    { type: 'bytes32', value: market.questionHash },
    { type: 'uint64', value: BigInt(Math.floor(market.closeTime.getTime() / 1000)) },
    { type: 'uint64', value: BigInt(market.disputeWindowSeconds) },
    { type: 'uint16', value: BigInt(market.feeBps) },
  ])

  const signed = await deps.custody.sign({
    address: deployerAddress,
    chain: custodyChainOf(chain),
    network: market.network as Network,
    family: familyOf(chain),
    purpose: 'deployer',
    userId: 'foresight',
    orderId: market.id,
    payload: {
      // Legacy (type 0) only. Hearth's node has no EIP-1559 decoder, and custody refuses a 1559
      // payload for an `ember`-family key outright (`custody/src/signing.ts`) — a type-2
      // transaction signed for that chain is not rejected by the network, it is bytes nothing on
      // it can parse.
      type: 0,
      to: null,
      value: '0',
      data,
      nonce: Number(nonce),
      gasLimit: deps.gasLimit.toString(),
      gasPrice: gasPrice.toString(),
      chainId: chainIdOf(chain, market.network as Network),
    },
    correlationId: market.id,
  })

  const txHash = evmTxHash(signed.signedTx)
  if (!txHash) throw new ChainUnavailableError('custody returned bytes that are not a transaction')
  const contractAddress = createAddress(deployerAddress, nonce)

  const committed = await markSigned(deps.sql, {
    id: market.id,
    owner: deps.owner,
    rawTx: signed.signedTx,
    txHash,
    nonce,
    contractAddress,
    custodyAuditId: signed.auditId,
  })
  if (!committed) {
    deps.logger.warn('a signature was discarded unbroadcast: the row was signed elsewhere', {
      marketId: market.id,
    })
    return 'not_claimed'
  }
  await recordAttempt(deps.sql, {
    marketId: market.id,
    attempt: committed.deployAttempts,
    outcome: 'signed',
    txHash,
  })

  return send(deps, committed)
}

/**
 * Send committed bytes and poll them.
 *
 * Reachable twice: straight after `markSigned`, and on a later tick for a row whose bytes were
 * committed and whose process died before the send. Both re-send the IDENTICAL bytes, which a node
 * answers with "already known" once it holds them — a success, not a failure.
 */
async function send(deps: DeployDeps, market: Market): Promise<DriveResult> {
  const chain = market.chain as ChainId
  const rpc = deps.rpc(chain)
  const rawTx = market.rawTx
  const txHash = market.deployTxHash
  const contractAddress = market.contractAddress
  if (!rawTx || !txHash || !contractAddress) {
    throw new Error('send called for a row with no committed bytes')
  }

  let current = market
  if (!current.broadcastAt) {
    await broadcast(rawTx, rpc)
    // The hash is ALREADY on the row — it was written with the bytes — so this write only stamps
    // the time. There is no window here in which a broadcast exists and its id does not.
    const marked = await markBroadcast(deps.sql, {
      id: current.id,
      // The SERVICE's clock, not the database's: `broadcast_at` is the one timestamp on the row
      // later compared against a clock, and mixing the two domains makes a fresh broadcast read as
      // negatively old.
      at: new Date((deps.now ?? Date.now)()),
    })
    await recordAttempt(deps.sql, {
      marketId: current.id,
      attempt: current.deployAttempts,
      outcome: 'broadcast',
      txHash,
    })
    deps.metrics.increment('foresight_deploys_broadcast_total')
    deps.logger.info('market deploy broadcast', {
      marketId: current.id,
      txHash,
      contractAddress,
    })
    if (marked) current = marked
  }

  const receipt = await receiptFor(rpc, txHash)
  if (!receipt) {
    const age = (deps.now ?? Date.now)() - (current.broadcastAt?.getTime() ?? 0)
    if (age > deps.stuckMs) {
      // Not failed. A transaction with a known hash may still be mined, and declaring it dead here
      // is how a market ends up deployed at an address nothing records. The operator is told; the
      // row keeps its bytes; nothing re-signs.
      deps.logger.error('a market deploy is stuck', {
        marketId: current.id,
        txHash,
        ageMs: age,
      })
      deps.metrics.increment('foresight_deploys_stuck_total')
    }
    // Still in flight. The lease is released so any replica may poll it next tick; the row keeps
    // its bytes and its hash, so nothing will ever re-sign it.
    await releaseLease(deps.sql, current.id, deps.owner)
    return 'broadcast'
  }

  if (receipt.status !== 1n) {
    await recordAttempt(deps.sql, {
      marketId: current.id,
      attempt: current.deployAttempts,
      outcome: 'reverted',
      txHash,
      detail: 'the creation reverted on chain',
    })
    await markDeployFailed(deps.sql, current.id, 'the creation reverted on chain')
    deps.metrics.increment('foresight_deploys_total', { outcome: 'failed' })
    return 'failed'
  }

  // THE ADDRESS CHECK. A mined address that disagrees with the derived one means the nonce moved
  // under us, and the contract at the address this service published is not this market's.
  if (receipt.contractAddress.toLowerCase() !== contractAddress.toLowerCase()) {
    const detail =
      `the mined contract address ${receipt.contractAddress} is not the derived ${contractAddress}` +
      ' — the deployer nonce moved under this deploy'
    await recordAttempt(deps.sql, {
      marketId: current.id,
      attempt: current.deployAttempts,
      outcome: 'address_mismatch',
      txHash,
      detail,
    })
    await markDeployFailed(deps.sql, current.id, detail)
    deps.metrics.increment('foresight_deploys_total', { outcome: 'failed' })
    deps.logger.error('market deploy landed at an unexpected address', { marketId: current.id, detail })
    return 'failed'
  }

  await markDeployed(deps.sql, current.id)
  await recordAttempt(deps.sql, {
    marketId: current.id,
    attempt: current.deployAttempts,
    outcome: 'confirmed',
    txHash,
  })
  deps.metrics.increment('foresight_deploys_total', { outcome: 'deployed' })
  deps.logger.info('market deploy confirmed', { marketId: current.id, contractAddress })
  return 'deployed'
}

/**
 * Resume a row whose bytes were committed by a previous, dead attempt.
 *
 * `claimDeploy` deliberately refuses a row with `raw_tx`, because re-SIGNING one is the mistake.
 * Re-SENDING one is the recovery. So this path takes the row without claiming it fresh, and it is
 * safe to run concurrently: two replicas re-sending identical bytes produce ONE transaction, and
 * `markBroadcast` and `markDeployed` are both conditional so only one of them records it.
 */
async function resumeIfSigned(deps: DeployDeps, marketId: string): Promise<DriveResult> {
  const market = await findMarket(deps.sql, marketId)
  if (!market || !market.rawTx) return 'not_claimed'
  if (market.deployState !== 'signed' && market.deployState !== 'broadcast') return 'not_claimed'
  try {
    return await send(deps, market)
  } catch (err) {
    if (err instanceof ChainUnavailableError) {
      deps.logger.warn('resume paused: an upstream was unavailable', { marketId, err: err.message })
      return 'pending'
    }
    throw err
  }
}

async function awaitFunds(deps: DeployDeps, marketId: string): Promise<void> {
  await deps.sql`
    update markets
       set deploy_state = 'pending', lease_owner = null, lease_until = null, updated_at = now()
     where id = ${marketId} and lease_owner = ${deps.owner} and raw_tx is null
  `
}

/**
 * Renew the lease between steps.
 *
 * A lease sized against a guess is the mistake `micro-mint` names: a budget computed against one
 * step does not cover the three RPC round trips and the signing call that precede it, so one slow
 * node expires a lease before any bytes exist and a second caller claims. Renewing turns the budget
 * into a bound on ONE STEP rather than on the whole job.
 */
async function heartbeat(deps: DeployDeps, marketId: string): Promise<void> {
  const held = await renewLease(deps.sql, { id: marketId, owner: deps.owner, leaseMs: deps.leaseMs })
  if (!held) throw new ChainUnavailableError('this replica no longer holds the deploy lease')
}

/* ------------------------------------------------------------------ the node */

/**
 * Send raw bytes, treating "already known" as success.
 *
 * A node answers a re-broadcast of a transaction it already holds with an ERROR, and that error is
 * the single most important thing to get right in this file: reading it as a failure would fail a
 * market whose contract is being mined at that moment.
 */
export async function broadcast(rawTx: string, rpc: JsonRpc): Promise<void> {
  try {
    await rpc('eth_sendRawTransaction', [rawTx])
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase()
    if (
      message.includes('already known') ||
      message.includes('already imported') ||
      message.includes('duplicate transaction') ||
      message.includes('known transaction') ||
      // A nonce the chain has already consumed with THESE bytes is the same situation seen from
      // the other side: our transaction is mined. The poll below settles which it was.
      message.includes('nonce too low')
    ) {
      return
    }
    if (message.includes('insufficient funds') || message.includes('intrinsic gas')) {
      throw new ChainRefusedError(err instanceof Error ? err.message : String(err))
    }
    throw new ChainUnavailableError(err instanceof Error ? err.message : String(err))
  }
}

export interface Receipt {
  readonly status: bigint
  readonly contractAddress: string
  readonly blockNumber: bigint
}

export async function receiptFor(rpc: JsonRpc, txHash: string): Promise<Receipt | null> {
  let raw: unknown
  try {
    raw = await rpc('eth_getTransactionReceipt', [txHash])
  } catch (err) {
    throw new ChainUnavailableError(err instanceof Error ? err.message : String(err))
  }
  if (raw === null || raw === undefined) return null
  const record = raw as Record<string, unknown>
  const contractAddress = record['contractAddress']
  if (typeof contractAddress !== 'string') {
    // A receipt for a creation always carries one. Without it we cannot check the address, and
    // "confirmed but unverified" is not a state this service has.
    throw new ChainUnavailableError('the receipt carries no contract address')
  }
  return {
    status: quantity(record['status'], 'receipt.status'),
    contractAddress,
    blockNumber: quantity(record['blockNumber'], 'receipt.blockNumber'),
  }
}

/** The JSON-RPC adapter. One shape, one place, so a node's error text is translated once. */
export function jsonRpcOver(
  url: string,
  deadlineMs: number,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): JsonRpc {
  let id = 0
  return async (method, params) => {
    id += 1
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(deadlineMs),
      })
    } catch (err) {
      throw new ChainUnavailableError(`${method}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!response.ok) {
      throw new ChainUnavailableError(`${method}: the node answered ${response.status}`)
    }
    const body = (await response.json()) as { result?: unknown; error?: { message?: unknown } }
    if (body.error) {
      // Thrown as a plain Error so `broadcast` can classify the message. Classifying here would
      // put node-specific strings in the transport, where the next chain's wording would break it.
      throw new Error(typeof body.error.message === 'string' ? body.error.message : 'rpc error')
    }
    return body.result
  }
}

/** Convenience for the config: a map of chain → url, refusing a chain nobody configured. */
export function rpcRouter(
  urls: Readonly<Record<string, string>>,
  deadlineMs: number,
  fetchImpl?: typeof globalThis.fetch,
): (chain: ChainId) => JsonRpc {
  const cache = new Map<string, JsonRpc>()
  return (chain) => {
    const existing = cache.get(chain)
    if (existing) return existing
    const url = urls[chain]
    if (!url) {
      // Refused rather than defaulted to a public node. A market deployed through an endpoint
      // nobody chose is a market whose chain nobody chose.
      throw new ChainRefusedError(`no JSON-RPC endpoint is configured for ${chain}`)
    }
    const rpc = jsonRpcOver(url, deadlineMs, fetchImpl)
    cache.set(chain, rpc)
    return rpc
  }
}

/** Exported for the sweep and for the fee bounds a deployment configures. */
export type { FeeBounds }
