/**
 * Communities, membership, roles and treasury account references.
 *
 * 04-domain-model §9.1 and §9.2. Three things in this file are load-bearing and worth reading
 * before changing anything:
 *
 *   1. **A treasury subject is derived, never supplied.** `communities.treasury_subject` is pinned
 *      by a CHECK to `'community:' || id`, and `treasury_accounts.ledger_subject` is pinned to the
 *      community's by a trigger. A subject a caller could choose is a subject a caller could point
 *      at somebody else's treasury — and the ledger would honour it, because to the ledger a
 *      subject is just a string.
 *
 *   2. **A treasury account holds no amount.** It names a `(subject, asset, purpose=treasury)`
 *      triple in `micro-ledger` and nothing else. See `ledgerclient.ts`.
 *
 *   3. **Token-gated membership is RE-EVALUATED.** 04-domain-model §9.2: "a scheduled job
 *      re-checks holdings via the indexer and demotes on failure, with a grace period. Membership
 *      that is never re-checked is not token-gating." `gating.ts` is that job, and the columns it
 *      writes — `holdings_checked_at`, `grace_until` — are here.
 */

import type { Db, Emit, Tx } from './outbox.ts'
import { TOPICS } from './events.ts'

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

export class ForbiddenInCommunityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForbiddenInCommunityError'
  }
}

/* ------------------------------------------------------------------ vocabulary */

export const COMMUNITY_KINDS = Object.freeze([
  'public',
  'private',
  'token_gated',
  'guild',
  'project',
  'creator',
] as const)
export type CommunityKind = (typeof COMMUNITY_KINDS)[number]

/** The closed set from 04-domain-model §9.1. */
export const JOIN_POLICIES = Object.freeze([
  'open',
  'invite',
  'token_holding',
  'marketplace_purchase',
  'achievement',
  'approval',
] as const)
export type JoinPolicy = (typeof JOIN_POLICIES)[number]

export const GOVERNANCE_MODELS = Object.freeze([
  'one_member_one_vote',
  'token_weighted',
  'reputation_weighted',
  'multisig_threshold',
] as const)
export type GovernanceModel = (typeof GOVERNANCE_MODELS)[number]

/**
 * The built-in roles, most privileged first. Order is meaningful: `permits` reads it.
 *
 * `custom` is last and grants nothing by rank — a custom role's authority is its capability set,
 * and a capability set that could be compared against a built-in rank would be a second, silent
 * privilege ladder.
 */
export const ROLES = Object.freeze([
  'owner',
  'admin',
  'moderator',
  'treasurer',
  'member',
  'guest',
  'custom',
] as const)
export type Role = (typeof ROLES)[number]

/** Who may change the community itself, its roles and its treasury account declarations. */
export const ADMIN_ROLES: readonly Role[] = Object.freeze(['owner', 'admin'])
/** Who may put a treasury spend to the community. */
export const TREASURY_ROLES: readonly Role[] = Object.freeze(['owner', 'admin', 'treasurer'])
/** Who may moderate discussion. */
export const MODERATOR_ROLES: readonly Role[] = Object.freeze(['owner', 'admin', 'moderator'])
/**
 * Who may vote and propose.
 *
 * `guest` is deliberately absent, and `custom` is deliberately present: a community that defines
 * a custom role has said that role is a member of it. What a `guest` is FOR is reading without
 * governing.
 */
export const VOTING_ROLES: readonly Role[] = Object.freeze([
  'owner',
  'admin',
  'moderator',
  'treasurer',
  'member',
  'custom',
])

export function isCommunityKind(value: string): value is CommunityKind {
  return (COMMUNITY_KINDS as readonly string[]).includes(value)
}
export function isJoinPolicy(value: string): value is JoinPolicy {
  return (JOIN_POLICIES as readonly string[]).includes(value)
}
export function isGovernanceModel(value: string): value is GovernanceModel {
  return (GOVERNANCE_MODELS as readonly string[]).includes(value)
}
export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}

export type MembershipStatus = 'active' | 'pending' | 'demoted' | 'banned'

/** Does this role satisfy this requirement? A set membership, never a rank comparison. */
export function permits(role: Role | null, allowed: readonly Role[]): boolean {
  return role !== null && allowed.includes(role)
}

/* ------------------------------------------------------------------ types */

export interface Community {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly kind: CommunityKind
  readonly ownerSubject: string
  readonly joinPolicy: JoinPolicy
  /** `community:<id>`. Derived by the database; never accepted from a caller. */
  readonly treasurySubject: string
  readonly governanceModel: GovernanceModel
  readonly status: 'active' | 'archived' | 'suspended'
  readonly gate: TokenGate | null
  readonly gateGraceHours: number
  readonly createdAt: Date
}

export interface TokenGate {
  readonly chainId: number
  readonly contract: string
  readonly minHolding: bigint
}

export interface Membership {
  readonly id: string
  readonly communityId: string
  readonly subject: string
  readonly role: Role
  readonly customRoleId: string | null
  readonly status: MembershipStatus
  readonly joinedAt: Date
  readonly holdingsCheckedAt: Date | null
  readonly graceUntil: Date | null
}

export interface CommunityRole {
  readonly id: string
  readonly communityId: string
  readonly name: string
  readonly capabilities: readonly string[]
}

export interface TreasuryAccount {
  readonly id: string
  readonly communityId: string
  readonly assetCode: string
  /** The ledger subject. This service reads its balance from the ledger and stores none. */
  readonly ledgerSubject: string
  readonly purpose: 'treasury'
}

/* ------------------------------------------------------------------ rows */

interface CommunityRow {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly kind: CommunityKind
  readonly owner_subject: string
  readonly join_policy: JoinPolicy
  readonly treasury_subject: string
  readonly governance_model: GovernanceModel
  readonly status: 'active' | 'archived' | 'suspended'
  readonly gate_chain_id: number | null
  readonly gate_contract: string | null
  readonly gate_min_holding: string | null
  readonly gate_grace_hours: number
  readonly created_at: Date
}

const COMMUNITY_COLUMNS = `id, slug, name, kind, owner_subject, join_policy, treasury_subject,
                           governance_model, status, gate_chain_id, gate_contract,
                           gate_min_holding::text as gate_min_holding, gate_grace_hours, created_at`

function toCommunity(row: CommunityRow): Community {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    ownerSubject: row.owner_subject,
    joinPolicy: row.join_policy,
    treasurySubject: row.treasury_subject,
    governanceModel: row.governance_model,
    status: row.status,
    gate:
      row.gate_chain_id !== null && row.gate_contract !== null && row.gate_min_holding !== null
        ? {
            chainId: row.gate_chain_id,
            contract: row.gate_contract,
            // `::text` then `BigInt`, never `Number`. A minimum holding is a uint256.
            minHolding: BigInt(row.gate_min_holding),
          }
        : null,
    gateGraceHours: row.gate_grace_hours,
    createdAt: row.created_at,
  }
}

interface MembershipRow {
  readonly id: string
  readonly community_id: string
  readonly subject: string
  readonly role: Role
  readonly custom_role_id: string | null
  readonly status: MembershipStatus
  readonly joined_at: Date
  readonly holdings_checked_at: Date | null
  readonly grace_until: Date | null
}

const MEMBERSHIP_COLUMNS = `id, community_id, subject, role, custom_role_id, status, joined_at,
                            holdings_checked_at, grace_until`

function toMembership(row: MembershipRow): Membership {
  return {
    id: row.id,
    communityId: row.community_id,
    subject: row.subject,
    role: row.role,
    customRoleId: row.custom_role_id,
    status: row.status,
    joinedAt: row.joined_at,
    holdingsCheckedAt: row.holdings_checked_at,
    graceUntil: row.grace_until,
  }
}

/* ------------------------------------------------------------------ create */

export interface CreateCommunityInput {
  readonly slug: string
  readonly name: string
  readonly kind: CommunityKind
  readonly ownerSubject: string
  readonly joinPolicy: JoinPolicy
  readonly governanceModel: GovernanceModel
  readonly gate?: TokenGate | null
  readonly gateGraceHours?: number
}

/**
 * Create a community and make its owner a member, in one transaction.
 *
 * The owner membership is not a convenience. A community with no `owner` membership row is a
 * community nobody can administer — every authority check in this service reads `memberships`,
 * and `communities.owner_subject` is a record of who created it rather than a second source of
 * authority. Writing them apart would leave a window in which the first is true and the second is
 * not.
 */
export async function createCommunity(
  tx: Tx,
  emit: Emit,
  input: CreateCommunityInput,
): Promise<Community> {
  if (input.kind === 'token_gated' && !input.gate) {
    // Refused here as well as by `communities_gate_complete`, because the message a caller gets
    // from a CHECK violation names a constraint rather than the thing they got wrong.
    throw new ValidationError('a token_gated community must declare gate.chainId, gate.contract and gate.minHolding')
  }
  if (input.gate && input.gate.minHolding <= 0n) {
    throw new ValidationError('gate.minHolding must be positive')
  }

  // `treasury_subject` is absent from the column list, and its absence is the point: it is a
  // GENERATED column, so Postgres refuses any statement that tries to write it. There is no shape
  // of this insert — or of any future one — that can point a community at another's treasury.
  const rows = await tx<CommunityRow[]>`
    insert into communities (slug, name, kind, owner_subject, join_policy,
                             governance_model, gate_chain_id, gate_contract, gate_min_holding,
                             gate_grace_hours)
    values (${input.slug}, ${input.name}, ${input.kind}, ${input.ownerSubject}, ${input.joinPolicy},
            ${input.governanceModel},
            ${input.gate?.chainId ?? null}, ${input.gate?.contract ?? null},
            ${input.gate ? input.gate.minHolding.toString() : null},
            ${input.gateGraceHours ?? 72})
    returning ${tx.unsafe(COMMUNITY_COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new ValidationError('the community row was not written')

  await tx`
    insert into memberships (community_id, subject, role, status)
    values (${row.id}, ${input.ownerSubject}, 'owner', 'active')
  `

  const community = toCommunity(row)
  emit({
    topic: TOPICS.communityCreated,
    key: community.id,
    actor: input.ownerSubject,
    payload: {
      communityId: community.id,
      slug: community.slug,
      kind: community.kind,
      governanceModel: community.governanceModel,
      treasurySubject: community.treasurySubject,
    },
  })
  return community
}

export async function findCommunity(sql: Db | Tx, id: string): Promise<Community | null> {
  const rows = await sql<CommunityRow[]>`
    select ${sql.unsafe(COMMUNITY_COLUMNS)} from communities where id = ${id}
  `
  const row = rows[0]
  return row ? toCommunity(row) : null
}

export async function findCommunityBySlug(sql: Db | Tx, slug: string): Promise<Community | null> {
  const rows = await sql<CommunityRow[]>`
    select ${sql.unsafe(COMMUNITY_COLUMNS)} from communities where slug = ${slug}
  `
  const row = rows[0]
  return row ? toCommunity(row) : null
}

export async function listCommunities(sql: Db | Tx, limit: number): Promise<readonly Community[]> {
  const rows = await sql<CommunityRow[]>`
    select ${sql.unsafe(COMMUNITY_COLUMNS)} from communities
     where status = 'active'
     order by created_at desc
     limit ${limit}
  `
  return rows.map(toCommunity)
}

/* ------------------------------------------------------------------ membership */

export interface JoinInput {
  readonly communityId: string
  readonly subject: string
  readonly role?: Role
  readonly customRoleId?: string | null
  readonly status?: MembershipStatus
}

/**
 * Add a member.
 *
 * The status a join produces is decided by the community's `join_policy` rather than by the
 * caller: an `approval` community's joins land `pending`, and an `open` one's land `active`. A
 * caller-supplied status would let anybody join a private community by asking nicely.
 */
export async function joinCommunity(
  tx: Tx,
  emit: Emit,
  community: Community,
  input: JoinInput,
): Promise<Membership> {
  const status: MembershipStatus =
    input.status ?? (community.joinPolicy === 'approval' || community.joinPolicy === 'invite'
      ? 'pending'
      : 'active')

  const rows = await tx<MembershipRow[]>`
    insert into memberships (community_id, subject, role, custom_role_id, status)
    values (${input.communityId}, ${input.subject}, ${input.role ?? 'member'},
            ${input.customRoleId ?? null}, ${status})
    on conflict (community_id, subject) do nothing
    returning ${tx.unsafe(MEMBERSHIP_COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new ConflictError('this subject is already a member of this community')

  const membership = toMembership(row)
  emit({
    topic: TOPICS.memberJoined,
    key: community.id,
    actor: input.subject,
    payload: {
      communityId: community.id,
      subject: membership.subject,
      role: membership.role,
      status: membership.status,
    },
  })
  return membership
}

export async function findMembership(
  sql: Db | Tx,
  communityId: string,
  subject: string,
): Promise<Membership | null> {
  const rows = await sql<MembershipRow[]>`
    select ${sql.unsafe(MEMBERSHIP_COLUMNS)} from memberships
     where community_id = ${communityId} and subject = ${subject}
  `
  const row = rows[0]
  return row ? toMembership(row) : null
}

/**
 * The role a subject holds, or null.
 *
 * **A non-`active` membership has no role.** A `pending` applicant, a `demoted` former token
 * holder and a `banned` member all answer null, so every authority check in the service gets the
 * same answer without each one remembering to filter on status.
 */
export async function roleIn(
  sql: Db | Tx,
  communityId: string,
  subject: string,
): Promise<Role | null> {
  const membership = await findMembership(sql, communityId, subject)
  if (!membership || membership.status !== 'active') return null
  return membership.role
}

export async function listMembers(
  sql: Db | Tx,
  communityId: string,
  limit: number,
): Promise<readonly Membership[]> {
  const rows = await sql<MembershipRow[]>`
    select ${sql.unsafe(MEMBERSHIP_COLUMNS)} from memberships
     where community_id = ${communityId}
     order by joined_at
     limit ${limit}
  `
  return rows.map(toMembership)
}

/** Every subject entitled to vote. The denominator behind a one_member_one_vote quorum. */
export async function countVotingMembers(sql: Db | Tx, communityId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from memberships
     where community_id = ${communityId}
       and status = 'active'
       and role = any(${VOTING_ROLES as string[]})
  `
  return rows[0]?.n ?? 0
}

export interface SetRoleInput {
  readonly communityId: string
  readonly subject: string
  readonly role: Role
  readonly customRoleId?: string | null
  readonly actor: string
}

/**
 * Change a member's role.
 *
 * **The last owner may not be demoted.** Not a courtesy: a community with no owner cannot approve
 * a role change, cannot declare a treasury account and cannot cancel a proposal, and there is no
 * route anywhere in this service that could restore one. It would need an operator with database
 * access — which is the failure mode 18-build-status.md §3.3g records for the estate's first admin
 * and which is worth not repeating.
 */
export async function setRole(tx: Tx, emit: Emit, input: SetRoleInput): Promise<Membership> {
  const current = await findMembership(tx, input.communityId, input.subject)
  if (!current) throw new NotFoundError('no such member')

  if (current.role === 'owner' && input.role !== 'owner') {
    const remaining = await tx<{ n: number }[]>`
      select count(*)::int as n from memberships
       where community_id = ${input.communityId} and role = 'owner' and status = 'active'
         and subject <> ${input.subject}
    `
    if ((remaining[0]?.n ?? 0) === 0) {
      throw new ConflictError('a community must keep at least one active owner')
    }
  }

  const rows = await tx<MembershipRow[]>`
    update memberships
       set role = ${input.role},
           custom_role_id = ${input.role === 'custom' ? (input.customRoleId ?? null) : null},
           updated_at = now()
     where community_id = ${input.communityId} and subject = ${input.subject}
    returning ${tx.unsafe(MEMBERSHIP_COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new NotFoundError('no such member')

  const membership = toMembership(row)
  emit({
    topic: TOPICS.memberRoleChanged,
    key: input.communityId,
    actor: input.actor,
    payload: {
      communityId: input.communityId,
      subject: membership.subject,
      role: membership.role,
      previousRole: current.role,
    },
  })
  return membership
}

export async function setMembershipStatus(
  tx: Tx,
  communityId: string,
  subject: string,
  status: MembershipStatus,
): Promise<Membership | null> {
  const rows = await tx<MembershipRow[]>`
    update memberships set status = ${status}, updated_at = now()
     where community_id = ${communityId} and subject = ${subject}
    returning ${tx.unsafe(MEMBERSHIP_COLUMNS)}
  `
  const row = rows[0]
  return row ? toMembership(row) : null
}

/* ------------------------------------------------------------------ custom roles */

export async function createCommunityRole(
  tx: Tx,
  communityId: string,
  name: string,
  capabilities: readonly string[],
): Promise<CommunityRole> {
  const rows = await tx<
    { id: string; community_id: string; name: string; capabilities: string[] }[]
  >`
    insert into community_roles (community_id, name, capabilities)
    values (${communityId}, ${name}, ${capabilities as string[]})
    on conflict (community_id, name) do nothing
    returning id, community_id, name, capabilities
  `
  const row = rows[0]
  if (!row) throw new ConflictError(`this community already has a role named ${name}`)
  return {
    id: row.id,
    communityId: row.community_id,
    name: row.name,
    capabilities: Object.freeze([...row.capabilities]),
  }
}

export async function listCommunityRoles(
  sql: Db | Tx,
  communityId: string,
): Promise<readonly CommunityRole[]> {
  const rows = await sql<
    { id: string; community_id: string; name: string; capabilities: string[] }[]
  >`
    select id, community_id, name, capabilities from community_roles
     where community_id = ${communityId} order by name
  `
  return rows.map((row) => ({
    id: row.id,
    communityId: row.community_id,
    name: row.name,
    capabilities: Object.freeze([...row.capabilities]),
  }))
}

/* ------------------------------------------------------------------ treasury accounts */

/**
 * Declare a treasury account.
 *
 * `ledgerSubject` is not a parameter. It is the community's own, read from the row, and the
 * database refuses anything else — see `community_assert_treasury_subject`. There is no shape of
 * this call that can point a community's proposals at another community's money.
 *
 * Nothing is created in the ledger here. The ledger creates an account on first posting
 * (`ledger/src/accounts.ts`), so a declared account with no entries has no ledger row, which is
 * correct: an account that has never held anything is a name rather than a fact.
 */
export async function declareTreasuryAccount(
  tx: Tx,
  community: Community,
  assetCode: string,
): Promise<TreasuryAccount> {
  const rows = await tx<
    {
      id: string
      community_id: string
      asset_code: string
      ledger_subject: string
      purpose: 'treasury'
    }[]
  >`
    insert into treasury_accounts (community_id, asset_code, ledger_subject)
    values (${community.id}, ${assetCode}, ${community.treasurySubject})
    on conflict (community_id, asset_code) do nothing
    returning id, community_id, asset_code, ledger_subject, purpose
  `
  const row = rows[0]
  if (!row) throw new ConflictError(`this community already holds a ${assetCode} treasury account`)
  return {
    id: row.id,
    communityId: row.community_id,
    assetCode: row.asset_code,
    ledgerSubject: row.ledger_subject,
    purpose: row.purpose,
  }
}

export async function listTreasuryAccounts(
  sql: Db | Tx,
  communityId: string,
): Promise<readonly TreasuryAccount[]> {
  const rows = await sql<
    {
      id: string
      community_id: string
      asset_code: string
      ledger_subject: string
      purpose: 'treasury'
    }[]
  >`
    select id, community_id, asset_code, ledger_subject, purpose from treasury_accounts
     where community_id = ${communityId} order by asset_code
  `
  return rows.map((row) => ({
    id: row.id,
    communityId: row.community_id,
    assetCode: row.asset_code,
    ledgerSubject: row.ledger_subject,
    purpose: row.purpose,
  }))
}

export async function findTreasuryAccount(
  sql: Db | Tx,
  communityId: string,
  assetCode: string,
): Promise<TreasuryAccount | null> {
  const accounts = await listTreasuryAccounts(sql, communityId)
  return accounts.find((account) => account.assetCode === assetCode) ?? null
}
