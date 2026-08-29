/**
 * Communities, membership, roles and treasury account references.
 *
 * The property this file is really about: **a treasury account names a ledger account and holds
 * no money, and the subject it names cannot be chosen by anybody.** Everything else here is the
 * ordinary membership machinery, with two invariants that are less ordinary than they look — the
 * last owner cannot be demoted, and a non-`active` membership has no role at all.
 */

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  ADMIN_ROLES,
  ConflictError,
  MODERATOR_ROLES,
  TREASURY_ROLES,
  VOTING_ROLES,
  ValidationError,
  countVotingMembers,
  createCommunity,
  createCommunityRole,
  declareTreasuryAccount,
  findCommunityBySlug,
  findMembership,
  findTreasuryAccount,
  isCommunityKind,
  isGovernanceModel,
  isJoinPolicy,
  joinCommunity,
  listCommunityRoles,
  listTreasuryAccounts,
  permits,
  roleIn,
  setMembershipStatus,
  setRole,
} from './communities.ts'
import { TOPICS } from './events.ts'
import {
  asTx,
  collector,
  migrateTestDb,
  openDb,
  resetCommunity,
  seedCommunity,
  seedMember,
  skip,
  subject,
  uniqueSlug,
} from './testsupport.ts'
import type { Community } from './communities.ts'

let sql: postgres.Sql
let community: Community

const OWNER = subject('owner')
const MEMBER = subject('member')

before(async () => {
  if (!skip) {
    sql = openDb()
    await migrateTestDb(sql)
  }
})

after(async () => {
  if (!skip) await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (skip) return
  await resetCommunity(sql)
  community = await seedCommunity(sql, { ownerSubject: OWNER })
})

/* ------------------------------------------------------------------ the treasury subject */

test('a community derives its own treasury subject and nobody can choose it', { skip }, async () => {
  assert.equal(community.treasurySubject, `community:${community.id}`)
})

test('a treasury account names the community it belongs to, never a supplied subject', { skip }, async () => {
  const account = await sql.begin(async (tx) => ({
    value: await declareTreasuryAccount(asTx(tx), community, 'EMBER'),
  }))
  assert.equal(account.value.ledgerSubject, community.treasurySubject)
  assert.equal(account.value.purpose, 'treasury')
  // `declareTreasuryAccount` takes no subject parameter at all — the type system says so, and the
  // trigger says so for anything that bypasses it (proven in migrations.test.ts).
})

test('a community may declare one account per asset', { skip }, async () => {
  await sql.begin(async (tx) => {
    await declareTreasuryAccount(asTx(tx), community, 'EMBER')
    await declareTreasuryAccount(asTx(tx), community, 'SHARD')
    return { done: true }
  })
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await declareTreasuryAccount(asTx(tx), community, 'EMBER')
        return { done: true }
      }),
    ConflictError,
  )
  const accounts = await listTreasuryAccounts(sql, community.id)
  assert.deepEqual(accounts.map((a) => a.assetCode), ['EMBER', 'SHARD'])
  assert.equal((await findTreasuryAccount(sql, community.id, 'EMBER'))?.assetCode, 'EMBER')
  assert.equal(await findTreasuryAccount(sql, community.id, 'USD'), null)
})

test('a treasury account object carries no amount', { skip }, async () => {
  const account = await sql.begin(async (tx) => ({
    value: await declareTreasuryAccount(asTx(tx), community, 'EMBER'),
  }))
  // Enumerated rather than eyeballed: this is the shape a consumer sees, and a `balance` appearing
  // on it would be this service claiming to know something only the ledger knows.
  assert.deepEqual(Object.keys(account.value).sort(), [
    'assetCode',
    'communityId',
    'id',
    'ledgerSubject',
    'purpose',
  ])
})

/* ------------------------------------------------------------------ creation */

test('creating a community makes its owner a member in the same transaction', { skip }, async () => {
  const membership = await findMembership(sql, community.id, OWNER)
  assert.equal(membership?.role, 'owner')
  assert.equal(membership?.status, 'active')
})

test('the creation event names the treasury subject', { skip }, async () => {
  const { emit, events } = collector()
  const created = await sql.begin(async (tx) => ({
    value: await createCommunity(asTx(tx), emit, {
      slug: uniqueSlug(),
      name: 'Another',
      kind: 'guild',
      ownerSubject: OWNER,
      joinPolicy: 'open',
      governanceModel: 'one_member_one_vote',
    }),
  }))
  assert.equal(events.length, 1)
  assert.equal(events[0]?.topic, TOPICS.communityCreated)
  assert.equal(events[0]?.payload['treasurySubject'], created.value.treasurySubject)
})

test('a token_gated community must declare a gate', { skip }, async () => {
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await createCommunity(asTx(tx), () => {}, {
          slug: uniqueSlug(),
          name: 'Gated',
          kind: 'token_gated',
          ownerSubject: OWNER,
          joinPolicy: 'token_holding',
          governanceModel: 'token_weighted',
        })
        return { done: true }
      }),
    ValidationError,
  )
  // And the database refuses it too, with the handler out of the way.
  await assert.rejects(
    () => sql`
      insert into communities (slug, name, kind, owner_subject, join_policy, governance_model)
      values (${uniqueSlug()}, 'Gated', 'token_gated', ${OWNER}, 'token_holding', 'token_weighted')
    `,
    /communities_gate_complete/,
  )
})

test('a gated community round-trips its minimum holding as a bigint', { skip }, async () => {
  const huge = 2n ** 90n
  const gated = await seedCommunity(sql, {
    kind: 'token_gated',
    ownerSubject: OWNER,
    gate: { chainId: 7411, contract: '0xabc', minHolding: huge },
  })
  const read = await findCommunityBySlug(sql, gated.slug)
  assert.equal(read?.gate?.minHolding, huge, 'the minimum holding did not survive the round trip')
})

test('a malformed slug is refused by the database', { skip }, async () => {
  for (const slug of ['A', 'has space', '-leading', 'trailing-', 'x']) {
    await assert.rejects(
      () => sql`
        insert into communities (slug, name, kind, owner_subject, join_policy, governance_model)
        values (${slug}, 'X', 'guild', ${OWNER}, 'open', 'one_member_one_vote')
      `,
      /communities_slug_shape/,
      `${slug} was accepted`,
    )
  }
})

/* ------------------------------------------------------------------ membership */

test('an approval community lands joins as pending', { skip }, async () => {
  const gated = await sql.begin(async (tx) => ({
    value: await createCommunity(asTx(tx), () => {}, {
      slug: uniqueSlug(),
      name: 'Vetted',
      kind: 'private',
      ownerSubject: OWNER,
      joinPolicy: 'approval',
      governanceModel: 'one_member_one_vote',
    }),
  }))
  const membership = await sql.begin(async (tx) => ({
    value: await joinCommunity(asTx(tx), () => {}, gated.value, {
      communityId: gated.value.id,
      subject: MEMBER,
    }),
  }))
  assert.equal(membership.value.status, 'pending')
  // And a pending member has no role at all, so every authority check answers the same way.
  assert.equal(await roleIn(sql, gated.value.id, MEMBER), null)
})

test('a subject may hold only one membership per community', { skip }, async () => {
  await seedMember(sql, community, MEMBER)
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await joinCommunity(asTx(tx), () => {}, community, {
          communityId: community.id,
          subject: MEMBER,
        })
        return { done: true }
      }),
    ConflictError,
  )
})

test('a demoted or banned member has no role', { skip }, async () => {
  await seedMember(sql, community, MEMBER)
  assert.equal(await roleIn(sql, community.id, MEMBER), 'member')
  for (const status of ['demoted', 'banned', 'pending'] as const) {
    await sql.begin(async (tx) => {
      await setMembershipStatus(asTx(tx), community.id, MEMBER, status)
      return { done: true }
    })
    assert.equal(await roleIn(sql, community.id, MEMBER), null, `a ${status} member kept their role`)
  }
})

test('the last owner may not be demoted', { skip }, async () => {
  // A community with no owner cannot approve a role change, declare a treasury account or cancel a
  // proposal, and no route in this service could restore one.
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await setRole(asTx(tx), () => {}, {
          communityId: community.id,
          subject: OWNER,
          role: 'member',
          actor: OWNER,
        })
        return { done: true }
      }),
    ConflictError,
  )
  assert.equal(await roleIn(sql, community.id, OWNER), 'owner')
})

test('an owner may be demoted once a second owner exists', { skip }, async () => {
  await seedMember(sql, community, MEMBER, 'owner')
  await sql.begin(async (tx) => {
    await setRole(asTx(tx), () => {}, {
      communityId: community.id,
      subject: OWNER,
      role: 'member',
      actor: MEMBER,
    })
    return { done: true }
  })
  assert.equal(await roleIn(sql, community.id, OWNER), 'member')
})

test('a role change emits an event naming both roles', { skip }, async () => {
  await seedMember(sql, community, MEMBER)
  const { emit, events } = collector()
  await sql.begin(async (tx) => {
    await setRole(asTx(tx), emit, {
      communityId: community.id,
      subject: MEMBER,
      role: 'treasurer',
      actor: OWNER,
    })
    return { done: true }
  })
  assert.equal(events[0]?.topic, TOPICS.memberRoleChanged)
  assert.equal(events[0]?.payload['role'], 'treasurer')
  assert.equal(events[0]?.payload['previousRole'], 'member')
})

test('only active voting members count toward a head-count quorum', { skip }, async () => {
  await seedMember(sql, community, subject('a'))
  await seedMember(sql, community, subject('b'), 'guest')
  await seedMember(sql, community, subject('c'), 'treasurer')
  await sql.begin(async (tx) => {
    await setMembershipStatus(asTx(tx), community.id, subject('c'), 'demoted')
    return { done: true }
  })
  // owner + a. `b` is a guest and `c` is demoted.
  assert.equal(await countVotingMembers(sql, community.id), 2)
})

/* ------------------------------------------------------------------ custom roles */

test('a custom role may not shadow a built-in', { skip }, async () => {
  for (const name of ['owner', 'admin', 'treasurer', 'member']) {
    await assert.rejects(
      () =>
        sql.begin(async (tx) => {
          await createCommunityRole(asTx(tx), community.id, name, [])
          return { done: true }
        }),
      /community_roles_not_builtin/,
      `${name} was accepted as a custom role`,
    )
  }
})

test('a custom role is unique within its community and free across communities', { skip }, async () => {
  await sql.begin(async (tx) => {
    await createCommunityRole(asTx(tx), community.id, 'quartermaster', ['treasury:read'])
    return { done: true }
  })
  await assert.rejects(
    () =>
      sql.begin(async (tx) => {
        await createCommunityRole(asTx(tx), community.id, 'quartermaster', [])
        return { done: true }
      }),
    ConflictError,
  )
  const other = await seedCommunity(sql, { ownerSubject: OWNER })
  await sql.begin(async (tx) => {
    await createCommunityRole(asTx(tx), other.id, 'quartermaster', [])
    return { done: true }
  })
  assert.equal((await listCommunityRoles(sql, community.id))[0]?.capabilities[0], 'treasury:read')
})

test('a membership marked custom must name a custom role, and vice versa', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into memberships (community_id, subject, role) values (${community.id}, ${MEMBER}, 'custom')
    `,
    /memberships_custom_has_role/,
  )
})

/* ------------------------------------------------------------------ the vocabulary */

test('the role sets are set membership, never a rank comparison', { skip: false }, () => {
  // A rank ladder is how a custom role ends up implicitly outranking a moderator.
  assert.equal(permits('owner', ADMIN_ROLES), true)
  assert.equal(permits('treasurer', ADMIN_ROLES), false)
  assert.equal(permits('treasurer', TREASURY_ROLES), true)
  assert.equal(permits('moderator', TREASURY_ROLES), false)
  assert.equal(permits('moderator', MODERATOR_ROLES), true)
  assert.equal(permits(null, VOTING_ROLES), false)
  // A guest reads and does not govern.
  assert.equal(permits('guest', VOTING_ROLES), false)
  assert.equal(permits('custom', VOTING_ROLES), true)
})

test('the closed sets match 04-domain-model §9.1', () => {
  assert.equal(isCommunityKind('token_gated'), true)
  assert.equal(isCommunityKind('dao'), false)
  for (const policy of [
    'open',
    'invite',
    'token_holding',
    'marketplace_purchase',
    'achievement',
    'approval',
  ]) {
    assert.equal(isJoinPolicy(policy), true, `${policy} is in the doc's closed set and not in ours`)
  }
  assert.equal(isJoinPolicy('anyone'), false)
  for (const model of [
    'one_member_one_vote',
    'token_weighted',
    'reputation_weighted',
    'multisig_threshold',
  ]) {
    assert.equal(isGovernanceModel(model), true)
  }
})
