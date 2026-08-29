/**
 * The market registry and its lifecycle.
 *
 *     draft → approved → open → closed → resolved → settled
 *                ↘         ↘        ↘         ↘
 *                          void  ←────────────┘
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE STATE MACHINE IS THE FIRST OF TWO ENFORCEMENTS, NOT THE ONLY ONE.
 *
 * `markets_unapproved_never_opens` in `migrations.ts` version 5 says the same thing in the
 * database. That is not belt and braces for its own sake — it is the beacon discipline
 * (`micro-beacon`, `gate_decisions_indeterminate_never_promotes`), and the division of labour is
 * exact:
 *
 *   * The state machine here is what gives a caller a 409 with a sentence they can act on.
 *   * The constraint is what holds when a future refactor adds a second write path, when a
 *     migration is run by hand, and when an operator fixes something with `psql` at 3am.
 *
 * A rule that exists in only one of those two places is a rule that will be broken by the other.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Why `void` is reachable from everywhere
 *
 * Because the reasons to void are not confined to one phase. A named source that has disappeared
 * is discovered at resolution; a category mistake is discovered while the market is open; a
 * question that turns out to be ambiguous is discovered by the first person who reads it properly.
 * In every case the honest action is the same and it is available: refund, whole, no fee. What is
 * NOT available is voiding a market that has already been settled — the money has gone, and a
 * status change afterwards would be a lie about a payment that happened.
 */

import { questionHash, type QuestionDocument } from './questiondoc.ts'
import { CATEGORY_VERSION, isCategory, isSourceKindFor } from './categories.ts'
import { requireOperator } from './ideas.ts'
import { imageView, type ImageReference } from './images.ts'
import type { Db, Emit, Tx } from './outbox.ts'
import {
  MARKET_CLOSED,
  MARKET_IMAGED,
  MARKET_OPENED,
  MARKET_RESOLVED,
  MARKET_SETTLED,
  MARKET_VOIDED,
} from './outbox.ts'

export type MarketStatus = 'draft' | 'approved' | 'open' | 'closed' | 'resolved' | 'settled' | 'void'
export type DeployState = 'pending' | 'building' | 'signed' | 'broadcast' | 'deployed' | 'failed'

/**
 * The permitted transitions, as data.
 *
 * Written out rather than computed, so that reading this table IS reading the lifecycle. A
 * transition absent from here is not a missing feature; it is a transition somebody has to argue
 * for, in a diff, with this comment above it.
 */
export const TRANSITIONS: Readonly<Record<MarketStatus, readonly MarketStatus[]>> = Object.freeze({
  draft: Object.freeze(['approved', 'void'] as MarketStatus[]),
  // `open` requires a deployed contract as well as an approval — see `markets_open_has_contract`.
  approved: Object.freeze(['open', 'void'] as MarketStatus[]),
  open: Object.freeze(['closed', 'void'] as MarketStatus[]),
  closed: Object.freeze(['resolved', 'void'] as MarketStatus[]),
  // Void after resolution is the dispute window doing its job: the outcome is posted, somebody
  // shows it is wrong, and the money has not moved yet.
  resolved: Object.freeze(['settled', 'void'] as MarketStatus[]),
  // Terminal. The fee has been paid and winners are claiming; there is nothing left to change.
  settled: Object.freeze([] as MarketStatus[]),
  void: Object.freeze([] as MarketStatus[]),
})

export function canTransition(from: MarketStatus, to: MarketStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

export class MarketError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'MarketError'
    this.code = code
    this.status = status
  }
}

export interface Market {
  readonly id: string
  readonly status: MarketStatus
  readonly ideaId: string | null
  readonly ideaStatus: string | null
  readonly question: string
  readonly resolutionCriteria: string
  readonly category: string
  readonly categoryVersion: number
  readonly resolutionSourceKind: string
  readonly resolutionSourceRef: string
  readonly questionHash: string
  readonly closeTime: Date
  readonly disputeWindowSeconds: number
  readonly feeBps: number
  readonly chain: string
  readonly network: string
  readonly approvedBy: string | null
  readonly approvedAt: Date | null
  readonly deployState: DeployState
  readonly deployerAddress: string | null
  readonly contractAddress: string | null
  readonly deployNonce: bigint | null
  readonly rawTx: string | null
  readonly deployTxHash: string | null
  readonly custodyAuditId: string | null
  readonly broadcastAt: Date | null
  readonly deployAttempts: number
  readonly deployError: string | null
  readonly openedAt: Date | null
  readonly closedAt: Date | null
  readonly resolvedAt: Date | null
  readonly settledAt: Date | null
  readonly voidedAt: Date | null
  readonly voidReason: string | null
  readonly outcome: number | null
  /**
   * studio's asset id for this market's header image, and the checksum studio reported for it.
   *
   * Both or neither — `markets_image_is_whole`. See `images.ts` for the vocabulary rule: the
   * checksum is RECORDED, and no field, message or rendered string may call it verified.
   */
  readonly imageAssetId: string | null
  readonly imageChecksum: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface MarketRow {
  readonly id: string
  readonly status: string
  readonly idea_id: string | null
  readonly idea_status: string | null
  readonly question: string
  readonly resolution_criteria: string
  readonly category: string
  readonly category_version: number
  readonly resolution_source_kind: string
  readonly resolution_source_ref: string
  readonly question_hash: string
  readonly close_time: Date
  readonly dispute_window_seconds: number
  readonly fee_bps: number
  readonly chain: string
  readonly network: string
  readonly approved_by: string | null
  readonly approved_at: Date | null
  readonly deploy_state: string
  readonly deployer_address: string | null
  readonly contract_address: string | null
  readonly deploy_nonce: string | null
  readonly raw_tx: string | null
  readonly deploy_tx_hash: string | null
  readonly custody_audit_id: string | null
  readonly broadcast_at: Date | null
  readonly deploy_attempts: number
  readonly deploy_error: string | null
  readonly opened_at: Date | null
  readonly closed_at: Date | null
  readonly resolved_at: Date | null
  readonly settled_at: Date | null
  readonly voided_at: Date | null
  readonly void_reason: string | null
  readonly outcome: number | null
  readonly image_asset_id: string | null
  readonly image_checksum: string | null
  readonly created_at: Date
  readonly updated_at: Date
}

const COLUMNS = `id, status, idea_id, idea_status, question, resolution_criteria, category,
  category_version, resolution_source_kind, resolution_source_ref, question_hash, close_time,
  dispute_window_seconds, fee_bps, chain, network, approved_by, approved_at, deploy_state,
  deployer_address, contract_address, deploy_nonce, raw_tx, deploy_tx_hash, custody_audit_id,
  broadcast_at, deploy_attempts, deploy_error, opened_at, closed_at, resolved_at, settled_at,
  voided_at, void_reason, outcome, image_asset_id, image_checksum, created_at, updated_at`

export function toMarket(row: MarketRow): Market {
  return {
    id: row.id,
    status: row.status as MarketStatus,
    ideaId: row.idea_id,
    ideaStatus: row.idea_status,
    question: row.question,
    resolutionCriteria: row.resolution_criteria,
    category: row.category,
    categoryVersion: row.category_version,
    resolutionSourceKind: row.resolution_source_kind,
    resolutionSourceRef: row.resolution_source_ref,
    questionHash: row.question_hash,
    closeTime: row.close_time,
    disputeWindowSeconds: row.dispute_window_seconds,
    feeBps: row.fee_bps,
    chain: row.chain,
    network: row.network,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    deployState: row.deploy_state as DeployState,
    deployerAddress: row.deployer_address,
    contractAddress: row.contract_address,
    // bigint, never Number. A nonce past 2^53 is not plausible, but the column is `bigint` and
    // postgres.js hands it back as a string; reading it through `Number()` anywhere near money is
    // the habit this estate does not have.
    deployNonce: row.deploy_nonce === null ? null : BigInt(row.deploy_nonce),
    rawTx: row.raw_tx,
    deployTxHash: row.deploy_tx_hash,
    custodyAuditId: row.custody_audit_id,
    broadcastAt: row.broadcast_at,
    deployAttempts: row.deploy_attempts,
    deployError: row.deploy_error,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    resolvedAt: row.resolved_at,
    settledAt: row.settled_at,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    outcome: row.outcome,
    imageAssetId: row.image_asset_id,
    imageChecksum: row.image_checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/* ------------------------------------------------------------------ creating a draft */

export interface DraftInput {
  readonly ideaId?: string | undefined
  readonly question: string
  readonly resolutionCriteria: string
  readonly category: string
  readonly resolutionSourceKind: string
  readonly resolutionSourceRef: string
  readonly closeTime: Date
  readonly disputeWindowSeconds: number
  readonly feeBps: number
  readonly network: string
  readonly chain?: string | undefined
}

/**
 * Build the canonical document a market's `questionHash` is computed over.
 *
 * Exported because the public page needs to show it and a bettor needs to be able to recompute the
 * hash themselves. See `questiondoc.ts` for why that matters.
 */
export function documentFor(market: Market): QuestionDocument {
  return {
    question: market.question,
    resolutionCriteria: market.resolutionCriteria,
    category: market.category,
    categoryVersion: market.categoryVersion,
    resolutionSourceKind: market.resolutionSourceKind,
    resolutionSourceRef: market.resolutionSourceRef,
    closeTime: Math.floor(market.closeTime.getTime() / 1000),
    disputeWindowSeconds: market.disputeWindowSeconds,
    feeBps: market.feeBps,
  }
}

export async function createDraft(sql: Db | Tx, input: DraftInput, now: Date): Promise<Market> {
  if (!isCategory(input.category)) {
    throw new MarketError('bad_category', `${input.category} is not an allowed market category`, 400)
  }
  if (!isSourceKindFor(input.category, input.resolutionSourceKind)) {
    throw new MarketError(
      'bad_source_kind',
      `${input.resolutionSourceKind} is not a resolution source this category can be settled from`,
      400,
    )
  }
  if (input.closeTime.getTime() <= now.getTime()) {
    throw new MarketError('bad_close_time', 'close time is already past', 400)
  }
  if (input.feeBps < 0 || input.feeBps > 1_000) {
    throw new MarketError('bad_fee', 'fee must be between 0 and 1000 basis points', 400)
  }

  const doc: QuestionDocument = {
    question: input.question.trim(),
    resolutionCriteria: input.resolutionCriteria.trim(),
    category: input.category,
    categoryVersion: CATEGORY_VERSION,
    resolutionSourceKind: input.resolutionSourceKind,
    resolutionSourceRef: input.resolutionSourceRef.trim(),
    closeTime: Math.floor(input.closeTime.getTime() / 1000),
    disputeWindowSeconds: input.disputeWindowSeconds,
    feeBps: input.feeBps,
  }

  // `idea_status` is read from the idea rather than supplied. A caller that could state it could
  // state 'approved' for a proposal nobody approved, and the composite foreign key would then be
  // satisfied by a lie — the constraint checks that the PAIR exists in `ideas`, so the only way to
  // pass it with a false status is if such a row exists, which it does not. Reading it here means
  // the insert simply fails rather than depending on that argument.
  const rows = await sql<MarketRow[]>`
    insert into markets (
      idea_id, idea_status, question, resolution_criteria, category, category_version,
      resolution_source_kind, resolution_source_ref, question_hash, close_time,
      dispute_window_seconds, fee_bps, chain, network
    )
    select
      ${input.ideaId ?? null}::uuid,
      (select status from ideas where id = ${input.ideaId ?? null}::uuid),
      ${doc.question}, ${doc.resolutionCriteria}, ${doc.category}, ${doc.categoryVersion},
      ${doc.resolutionSourceKind}, ${doc.resolutionSourceRef}, ${questionHash(doc)},
      ${input.closeTime}, ${doc.disputeWindowSeconds}, ${doc.feeBps},
      ${input.chain ?? 'ember'}, ${input.network}
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new MarketError('insert_failed', 'the draft was not stored', 500)
  return toMarket(row)
}

/* ------------------------------------------------------------------ reads */

export async function findMarket(sql: Db | Tx, id: string): Promise<Market | null> {
  const rows = await sql<MarketRow[]>`select ${sql.unsafe(COLUMNS)} from markets where id = ${id}`
  const row = rows[0]
  return row ? toMarket(row) : null
}

export async function listMarkets(
  sql: Db,
  status: MarketStatus | null,
  limit: number,
): Promise<readonly Market[]> {
  const rows = status
    ? await sql<MarketRow[]>`
        select ${sql.unsafe(COLUMNS)} from markets where status = ${status}
        order by created_at desc limit ${limit}`
    : await sql<MarketRow[]>`
        select ${sql.unsafe(COLUMNS)} from markets
        order by created_at desc limit ${limit}`
  return rows.map(toMarket)
}

/** Markets whose close time has passed but which are still taking stakes. The close job's queue. */
export async function listDueToClose(sql: Db, now: Date, limit: number): Promise<readonly Market[]> {
  const rows = await sql<MarketRow[]>`
    select ${sql.unsafe(COLUMNS)} from markets
     where status = 'open' and close_time <= ${now}
     order by close_time limit ${limit}
  `
  return rows.map(toMarket)
}

/* ------------------------------------------------------------------ transitions */

async function recordTransition(
  tx: Tx,
  marketId: string,
  from: MarketStatus,
  to: MarketStatus,
  actor: string,
  reason: string | null,
  correlationId: string | null,
): Promise<void> {
  await tx`
    insert into market_transitions (market_id, from_status, to_status, actor, reason, correlation_id)
    values (${marketId}, ${from}, ${to}, ${actor}, ${reason}, ${correlationId})
  `
}

/**
 * **A person approves.**
 *
 * The `operator:` check is here, and again in `markets_unapproved_never_opens`. Two enforcements
 * because they fail differently: this one is readable, that one is unavoidable.
 */
export async function approveMarket(
  tx: Tx,
  id: string,
  operator: string,
  now: Date,
  correlationId: string | null,
): Promise<Market> {
  requireOperator(operator)
  const current = await findMarket(tx, id)
  if (!current) throw new MarketError('not_found', 'no market with that id', 404)
  requireTransition(current, 'approved')

  if (current.ideaId !== null && current.ideaStatus !== 'approved') {
    throw new MarketError(
      'idea_not_approved',
      'this market was built from a proposal nobody has approved — approve the proposal first',
    )
  }
  if (current.closeTime.getTime() <= now.getTime()) {
    throw new MarketError('bad_close_time', 'this market’s close time has already passed')
  }

  const rows = await tx<MarketRow[]>`
    update markets
       set status = 'approved', approved_by = ${operator}, approved_at = ${now}, updated_at = now()
     where id = ${id} and status = 'draft'
    returning ${sql_(tx)}
  `
  const row = rows[0]
  if (!row) throw new MarketError('conflict', 'the market moved while it was being approved')
  await recordTransition(tx, id, current.status, 'approved', operator, null, correlationId)
  return toMarket(row)
}

/**
 * The market has a contract; open it for stakes.
 *
 * Deliberately NOT reachable while `deploy_state` is anything but `deployed`. A market that says
 * `open` with no contract address is an invitation to send money to an address that does not exist,
 * and `markets_open_has_contract` refuses the write independently.
 */
export async function openMarket(
  tx: Tx,
  emit: Emit,
  id: string,
  actor: string,
  now: Date,
  correlationId: string | null,
): Promise<Market> {
  const current = await findMarket(tx, id)
  if (!current) throw new MarketError('not_found', 'no market with that id', 404)
  requireTransition(current, 'open')
  if (current.deployState !== 'deployed' || !current.contractAddress) {
    throw new MarketError('not_deployed', 'the market contract is not deployed yet')
  }
  if (current.closeTime.getTime() <= now.getTime()) {
    throw new MarketError('bad_close_time', 'this market’s close time has already passed')
  }

  const rows = await tx<MarketRow[]>`
    update markets set status = 'open', opened_at = ${now}, updated_at = now()
     where id = ${id} and status = 'approved' and deploy_state = 'deployed'
    returning ${sql_(tx)}
  `
  const row = rows[0]
  if (!row) throw new MarketError('conflict', 'the market moved while it was being opened')
  const market = toMarket(row)
  await recordTransition(tx, id, current.status, 'open', actor, null, correlationId)
  emit({
    topic: MARKET_OPENED,
    key: id,
    payload: publicView(market),
    actor,
    ...(correlationId ? { correlationId } : {}),
  })
  return market
}

/**
 * Close a market whose time is up.
 *
 * Off-chain only, and that is the honest description: the CONTRACT stops taking stakes at
 * `closeTime` by itself, with no help from this service (`ForesightMarket.stake` reverts on
 * `block.timestamp >= closeTime`). This transition is bookkeeping so the operator queue and the
 * public page agree with the chain. If this job never ran, not one extra wei could be staked.
 */
export async function closeMarket(
  tx: Tx,
  emit: Emit,
  id: string,
  actor: string,
  now: Date,
  correlationId: string | null,
): Promise<Market> {
  const current = await findMarket(tx, id)
  if (!current) throw new MarketError('not_found', 'no market with that id', 404)
  requireTransition(current, 'closed')
  if (current.closeTime.getTime() > now.getTime()) {
    throw new MarketError('not_due', 'this market has not reached its close time')
  }
  const rows = await tx<MarketRow[]>`
    update markets set status = 'closed', closed_at = ${now}, updated_at = now()
     where id = ${id} and status = 'open'
    returning ${sql_(tx)}
  `
  const row = rows[0]
  if (!row) throw new MarketError('conflict', 'the market moved while it was being closed')
  const market = toMarket(row)
  await recordTransition(tx, id, current.status, 'closed', actor, null, correlationId)
  emit({
    topic: MARKET_CLOSED,
    key: id,
    payload: publicView(market),
    actor,
    ...(correlationId ? { correlationId } : {}),
  })
  return market
}

/**
 * Record that the chain has accepted a resolution. **This does not decide anything.**
 *
 * The outcome was posted on chain by the oracle before this row is written — `resolve.ts` calls
 * this only after the resolver transaction confirmed. Writing it the other way round would make the
 * database the source of truth for an outcome the contract will pay against, which is precisely the
 * inversion §2.3.1 forbids.
 */
export async function markResolved(
  tx: Tx,
  emit: Emit,
  id: string,
  outcome: number,
  actor: string,
  at: Date,
  correlationId: string | null,
): Promise<Market> {
  if (outcome !== 0 && outcome !== 1) {
    throw new MarketError('bad_outcome', 'outcome must be 0 (yes) or 1 (no)', 400)
  }
  const current = await findMarket(tx, id)
  if (!current) throw new MarketError('not_found', 'no market with that id', 404)
  requireTransition(current, 'resolved')

  const rows = await tx<MarketRow[]>`
    update markets set status = 'resolved', outcome = ${outcome}, resolved_at = ${at}, updated_at = now()
     where id = ${id} and status = 'closed'
    returning ${sql_(tx)}
  `
  const row = rows[0]
  if (!row) throw new MarketError('conflict', 'the market moved while the resolution was recorded')
  const market = toMarket(row)
  await recordTransition(tx, id, current.status, 'resolved', actor, `outcome=${outcome}`, correlationId)
  emit({
    topic: MARKET_RESOLVED,
    key: id,
    payload: { ...publicView(market), outcome },
    actor,
    ...(correlationId ? { correlationId } : {}),
  })
  return market
}

export async function markSettled(
  tx: Tx,
  emit: Emit,
  id: string,
  actor: string,
  at: Date,
  correlationId: string | null,
): Promise<Market> {
  const current = await findMarket(tx, id)
  if (!current) throw new MarketError('not_found', 'no market with that id', 404)
  requireTransition(current, 'settled')
  const rows = await tx<MarketRow[]>`
    update markets set status = 'settled', settled_at = ${at}, updated_at = now()
     where id = ${id} and status = 'resolved'
    returning ${sql_(tx)}
  `
  const row = rows[0]
  if (!row) throw new MarketError('conflict', 'the market moved while it was being settled')
  const market = toMarket(row)
  await recordTransition(tx, id, current.status, 'settled', actor, null, correlationId)
  emit({
    topic: MARKET_SETTLED,
    key: id,
    payload: publicView(market),
    actor,
    ...(correlationId ? { correlationId } : {}),
  })
  return market
}

/**
 * Void: refund, whole, no fee.
 *
 * The reason is required, and it is required by the schema too. "Void" with no explanation is the
 * shape of an operator improvisation, and §2.3.5 names improvisation as the thing void exists to
 * replace: a market whose named source is gone is void, not re-sourced.
 */
export async function voidMarket(
  tx: Tx,
  emit: Emit,
  id: string,
  reason: string,
  actor: string,
  at: Date,
  correlationId: string | null,
): Promise<Market> {
  if (reason.trim().length === 0) {
    throw new MarketError('no_reason', 'voiding a market requires a reason', 400)
  }
  const current = await findMarket(tx, id)
  if (!current) throw new MarketError('not_found', 'no market with that id', 404)
  requireTransition(current, 'void')

  const rows = await tx<MarketRow[]>`
    update markets
       set status = 'void', void_reason = ${reason.trim()}, voided_at = ${at}, updated_at = now()
     where id = ${id} and status = ${current.status}
    returning ${sql_(tx)}
  `
  const row = rows[0]
  if (!row) throw new MarketError('conflict', 'the market moved while it was being voided')
  const market = toMarket(row)
  await recordTransition(tx, id, current.status, 'void', actor, reason.trim(), correlationId)
  emit({
    topic: MARKET_VOIDED,
    key: id,
    payload: { ...publicView(market), reason: reason.trim() },
    actor,
    ...(correlationId ? { correlationId } : {}),
  })
  return market
}

/* ------------------------------------------------------------------ the header image */

/**
 * Set or clear a market's header image. `null` clears.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **BOTH COLUMNS MOVE IN ONE UPDATE, ALWAYS.**
 *
 * There is deliberately no `setImage`/`clearImage` pair. Two functions would be two places the
 * pair could come apart, and a clear that forgot `image_checksum` would leave a checksum naming
 * bytes nothing points at — the half-reference `markets_image_is_whole` exists to refuse. One
 * function writing both columns from one nullable argument makes the whole/none property
 * structural rather than remembered, and the constraint is what holds when a future writer
 * forgets this file exists at all.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## When may the image change? In any status, including `settled` and `void`.
 *
 * The question that has to be answered first is whether it touches `question_hash`. **It does
 * not.** `documentFor` above builds the hashed document from ten fields and the image is in none
 * of them, so this UPDATE leaves `question_hash` byte-for-byte identical and a bettor recomputing
 * it from the public page still gets the value the deployed contract holds. `questiondoc.ts`
 * exists so that the CRITERIA cannot be edited under a live market; a picture is not a criterion,
 * settles nothing, and no clause of any resolution reads it.
 *
 * Given that, freezing the image at `settled` would buy nothing and cost something real. A settled
 * market's page is permanent and public. If an image on it turns out to be unlawful, abusive, or
 * somebody else's copyright, the only remedy under a freeze would be to delete the market — which
 * this lifecycle does not permit and should not, because the record of a market that took money is
 * the one thing that must survive. So the terminal states are precisely where clearing an image
 * matters MOST, and refusing it there would be a rule that fires only when it does harm.
 *
 * What the change is not is undocumented. Every call writes an outbox row in the same transaction
 * carrying the actor and the time (`MARKET_IMAGED`), which is why there is no `image_set_by`
 * column: the event log already answers "who changed this picture, and when", and a column would
 * be a second copy of that answer that can disagree with the first.
 */
export async function setMarketImage(
  tx: Tx,
  emit: Emit,
  id: string,
  image: ImageReference | null,
  actor: string,
  now: Date,
  correlationId: string | null,
): Promise<Market> {
  const current = await findMarket(tx, id)
  if (!current) throw new MarketError('not_found', 'no market with that id', 404)

  const rows = await tx<MarketRow[]>`
    update markets
       set image_asset_id = ${image?.assetId ?? null}::uuid,
           image_checksum = ${image?.checksum ?? null},
           updated_at     = ${now}
     where id = ${id}
    returning ${sql_(tx)}
  `
  const row = rows[0]
  if (!row) throw new MarketError('conflict', 'the market went away while its image was being set')
  const market = toMarket(row)
  emit({
    topic: MARKET_IMAGED,
    key: id,
    // The REFERENCE, never a URL. An event is durable and a URL is not: `bytesUrl` is built from
    // this deployment's `STUDIO_PUBLIC_URL`, and a consumer replaying this event a year from now
    // would follow an address that may belong to nobody. The asset id and the checksum still name
    // exactly which bytes were meant, which is what a consumer can actually act on.
    payload: {
      id: market.id,
      status: market.status,
      imageAssetId: market.imageAssetId,
      // Recorded, not verified — `images.ts`. Named plainly so no consumer reads it as a proof.
      imageChecksum: market.imageChecksum,
      cleared: image === null,
    },
    actor,
    ...(correlationId ? { correlationId } : {}),
  })
  return market
}

function requireTransition(market: Market, to: MarketStatus): void {
  if (!canTransition(market.status, to)) {
    throw new MarketError(
      'bad_transition',
      `a market cannot go from ${market.status} to ${to}`,
    )
  }
}

/** `returning` needs the column list, and `tx.unsafe` is how postgres.js splices one in. */
function sql_(tx: Tx): ReturnType<Tx['unsafe']> {
  return tx.unsafe(COLUMNS)
}

/**
 * What leaves this service in an event or a public response.
 *
 * Deliberately narrow. There is no lease owner here, no raw transaction, no custody audit id and
 * no operator subject: an event goes to `micro-notify` and `micro-activity` and from there towards
 * a user, and every internal field that rides along is a field that ends up in a bundle somebody
 * can read.
 *
 * `studioPublicUrl` is optional and defaults to absent, which is what the event emitters above
 * pass. That is not laziness: a durable event must carry the REFERENCE and not a URL built from
 * one deployment's configuration — see the note in `setMarketImage`. The HTTP reads pass it, so a
 * browser gets an `<img src>` it can use.
 *
 * **`image` sits in the same object as `questionHash`, `contractAddress` and `outcome`, and it is
 * the one field here the chain knows nothing about.** `images.ts` carries the argument; the short
 * version is that a client must not present the picture as though the contract vouched for it. The
 * field is named `image`, its digest is named `checksum`, and neither this response nor any UI
 * built on it may use the words verified, attested, on-chain or anchored.
 */
export function publicView(market: Market, studioPublicUrl?: string): Record<string, unknown> {
  return {
    id: market.id,
    status: market.status,
    question: market.question,
    resolutionCriteria: market.resolutionCriteria,
    category: market.category,
    categoryVersion: market.categoryVersion,
    resolutionSourceKind: market.resolutionSourceKind,
    resolutionSourceRef: market.resolutionSourceRef,
    questionHash: market.questionHash,
    closeTime: market.closeTime.toISOString(),
    disputeWindowSeconds: market.disputeWindowSeconds,
    feeBps: market.feeBps,
    chain: market.chain,
    network: market.network,
    contractAddress: market.contractAddress,
    outcome: market.outcome,
    voidReason: market.voidReason,
    // Presentational, and the only field in this object the contract knows nothing about. Never
    // rendered as a property OF the market's on-chain state — see the note above.
    image: imageView(market.imageAssetId, market.imageChecksum, studioPublicUrl),
    openedAt: market.openedAt?.toISOString() ?? null,
    closedAt: market.closedAt?.toISOString() ?? null,
    resolvedAt: market.resolvedAt?.toISOString() ?? null,
    settledAt: market.settledAt?.toISOString() ?? null,
    voidedAt: market.voidedAt?.toISOString() ?? null,
  }
}
