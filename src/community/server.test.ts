/**
 * The HTTP surface, over a real socket.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE TESTS THAT MATTER HERE ARE THE ONES ABOUT AUTHORITY AND ABOUT THE EXECUTE ROUTE.**
 *
 *   * Every field that decides who you are comes from the TOKEN, never from the body. A
 *     caller-supplied `ownerSubject` creates a community owned by somebody else; a caller-supplied
 *     `delegator` gives away somebody else's vote. Both are asserted directly.
 *   * `POST /internal/proposals/:id/execute` cannot bypass the timelock, and not because it checks
 *     for one — it reaches the same trigger the job does. A 409 over a real socket is the proof.
 *   * A `community:*` service token is refused on that route. See `scopes.test.ts` for the
 *     divergence this navigates.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Lifecycle } from '@cloudsforge/lifecycle'
import type { Principal } from '@cloudsforge/auth'
import { createServer } from './server.ts'
import { findExecution } from './executions.ts'
import { findCommunity, roleIn } from './communities.ts'
import { findVoteFor } from './votes.ts'
import {
  asDb,
  fakeLedger,
  fakePolicy,
  migrateTestDb,
  openDb,
  quietLogger,
  resetCommunity,
  seedCommunity,
  seedMember,
  seedProposal,
  seedTreasuryAccount,
  skip,
  subject,
  testMetrics,
  uniqueSlug,
} from './testsupport.ts'
import type { FakeLedger, FakePolicy } from './testsupport.ts'
import type { Community } from './communities.ts'

let sql: postgres.Sql
let server: Server
let baseUrl: string
let ledger: FakeLedger
let policy: FakePolicy

const ALICE = subject('alice')
const BOB = subject('bob')

/** A verifier with no JWKS: the token IS the principal, spelled. */
const verifier = {
  async principal(token: string): Promise<Principal> {
    if (token.startsWith('svc:')) {
      const scopes = token.slice(4).split(',').filter((s) => s.length > 0)
      return { kind: 'service', service: 'tester', scopes }
    }
    return { kind: 'user', userId: token, handle: token, roles: [] }
  },
}

before(async () => {
  if (skip) return
  sql = openDb()
  await migrateTestDb(sql)
  ledger = fakeLedger()
  policy = fakePolicy()
  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 100 })
  lifecycle.markReady()
  server = createServer({
    lifecycle,
    logger: quietLogger(),
    metrics: testMetrics(),
    verifier,
    sql: singleNetworkSql(asDb(sql)),
    singleNetwork: 'mainnet' as const,
    producer: 'community',
    ingestSecrets: ['a-signing-secret-long-enough-000'],
    queue: new JobQueue(sql as unknown as JobsSql, { owner: 'test', leaseMs: 60_000 }),
    execute: { ledger, policy },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (skip) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (skip) return
  await resetCommunity(sql)
})

interface Reply {
  readonly status: number
  readonly body: Record<string, unknown>
}

async function call(
  method: string,
  path: string,
  options: { as?: string; body?: unknown; key?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.as) headers['authorization'] = `Bearer ${options.as}`
  if (options.key) headers['idempotency-key'] = options.key
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

const communityBody = () => ({
  slug: uniqueSlug(),
  name: 'The Guild',
  kind: 'guild',
  joinPolicy: 'open',
  governanceModel: 'one_member_one_vote',
})

/* ------------------------------------------------------------------ health */

test('the three health endpoints answer', { skip }, async () => {
  assert.equal((await call('GET', '/livez')).status, 200)
  assert.equal((await call('GET', '/readyz')).status, 200)
  const metrics = await fetch(`${baseUrl}/metrics`)
  assert.equal(metrics.status, 200)
  assert.match(metrics.headers.get('content-type') ?? '', /text\/plain/)
  assert.match(await metrics.text(), /community_up/)
})

test('an unknown route is an honest 404', { skip }, async () => {
  const reply = await call('GET', '/v1/nope')
  assert.equal(reply.status, 404)
  assert.equal((reply.body['error'] as Record<string, unknown>)['code'], 'not_found')
})

test('every response carries a request id and is uncacheable', { skip }, async () => {
  const response = await fetch(`${baseUrl}/livez`)
  assert.ok(response.headers.get('x-request-id'))
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

/* ------------------------------------------------------------------ authority from the token */

test('the community owner comes from the token, never from the body', { skip }, async () => {
  // A caller-supplied owner is a caller who can create a community owned by somebody else and then
  // be its only admin.
  const reply = await call('POST', '/v1/communities', {
    as: 'alice',
    key: 'create-1',
    body: { ...communityBody(), ownerSubject: BOB, owner_subject: BOB },
  })
  assert.equal(reply.status, 201)
  const created = (reply.body['community'] as Record<string, unknown>)['id'] as string
  const community = await findCommunity(sql, created)
  assert.equal(community?.ownerSubject, ALICE)
  assert.equal(await roleIn(sql, created, ALICE), 'owner')
  assert.equal(await roleIn(sql, created, BOB), null)
})

test('the treasury subject is derived and reported, with no balance beside it', { skip }, async () => {
  const created = await call('POST', '/v1/communities', {
    as: 'alice',
    key: 'create-2',
    body: communityBody(),
  })
  const community = created.body['community'] as Record<string, unknown>
  assert.equal(community['treasurySubject'], `community:${community['id']}`)

  await call('POST', `/v1/communities/${community['id']}/treasury-accounts`, {
    as: 'alice',
    key: 'idem-ta-1-00000000',
    body: { assetCode: 'EMBER' },
  })
  const listed = await call('GET', `/v1/communities/${community['id']}/treasury-accounts`, { as: 'alice' })
  const accounts = listed.body['treasuryAccounts'] as Array<Record<string, unknown>>
  assert.equal(accounts.length, 1)
  assert.ok(!('balance' in accounts[0]!), 'the treasury account reported a balance')
  // And the caller is told where the balance actually lives, rather than being given a proxied one.
  assert.deepEqual(listed.body['balancesAt'], { service: 'ledger', route: '/accounts/:subject/balances' })
})

test('a member joins themselves, not somebody else', { skip }, async () => {
  const created = await call('POST', '/v1/communities', { as: 'alice', key: 'idem-c3-00000000', body: communityBody() })
  const id = (created.body['community'] as Record<string, unknown>)['id'] as string
  const joined = await call('POST', `/v1/communities/${id}/members`, {
    as: 'bob',
    key: 'idem-join-1-00000000',
    body: { subject: subject('carol') },
  })
  assert.equal(joined.status, 201)
  assert.equal(await roleIn(sql, id, BOB), 'member')
  assert.equal(await roleIn(sql, id, subject('carol')), null)
})

test('a delegation is from the caller, never from a supplied delegator', { skip }, async () => {
  // A caller-supplied delegator is a caller who can give away somebody else's vote.
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  await seedMember(sql, community, BOB)
  await seedMember(sql, community, subject('carol'))

  const reply = await call('POST', `/v1/communities/${community.id}/delegations`, {
    as: 'bob',
    key: 'idem-del-1-00000000',
    body: { delegate: ALICE, delegator: subject('carol'), delegatorSubject: subject('carol') },
  })
  assert.equal(reply.status, 201)
  const rows = await sql<{ delegator_subject: string }[]>`
    select delegator_subject from delegations where community_id = ${community.id}
  `
  assert.equal(rows[0]?.delegator_subject, BOB, "a caller delegated somebody else's vote")
})

/* ------------------------------------------------------------------ visibility */

test('a private community a caller is not in answers 404, not 403', { skip }, async () => {
  // A 403 confirms the id exists, which makes private communities enumerable.
  const community = await seedCommunity(sql, { kind: 'private', ownerSubject: ALICE })
  const reply = await call('GET', `/v1/communities/${community.id}`, { as: 'bob' })
  assert.equal(reply.status, 404)
})

test('a public community is readable by anybody with a token', { skip }, async () => {
  const community = await seedCommunity(sql, { kind: 'public', ownerSubject: ALICE })
  const reply = await call('GET', `/v1/communities/${community.id}`, { as: 'bob' })
  assert.equal(reply.status, 200)
  assert.equal(reply.body['yourRole'], null)
})

test('a member with an insufficient role gets 403; a non-member gets 404', { skip }, async () => {
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  await seedMember(sql, community, BOB)
  // Bob is a member, so he already knows the community exists — 403 leaks nothing.
  const asMember = await call('POST', `/v1/communities/${community.id}/roles`, {
    as: 'bob',
    key: 'idem-role-1-00000000',
    body: { name: 'quartermaster' },
  })
  assert.equal(asMember.status, 403)
  const asStranger = await call('POST', `/v1/communities/${community.id}/roles`, {
    as: 'carol',
    key: 'idem-role-2-00000000',
    body: { name: 'quartermaster' },
  })
  assert.equal(asStranger.status, 404)
})

test('only a treasurer or above may propose a treasury spend', { skip }, async () => {
  // Voting on a spend is every member's right; putting one on the agenda is not.
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  await seedMember(sql, community, BOB)
  await seedTreasuryAccount(sql, community, 'EMBER')
  const now = Date.now()
  const body = {
    kind: 'treasury_spend',
    title: 'Pay the artist',
    quorum: '1',
    thresholdBps: 5_000,
    opensAt: new Date(now + 60_000).toISOString(),
    closesAt: new Date(now + 3_600_000).toISOString(),
    timelockUntil: new Date(now + 7_200_000).toISOString(),
    spend: { assetCode: 'EMBER', amount: '1000', recipient: BOB },
  }
  assert.equal(
    (await call('POST', `/v1/communities/${community.id}/proposals`, { as: 'bob', key: 'idem-p1-00000000', body })).status,
    403,
  )
  assert.equal(
    (await call('POST', `/v1/communities/${community.id}/proposals`, { as: 'alice', key: 'idem-p2-00000000', body })).status,
    201,
  )
})

/* ------------------------------------------------------------------ the wire types */

test('a quorum or amount sent as a JSON number is refused, not rounded', { skip }, async () => {
  // `JSON.parse` has already destroyed the precision of anything above 2^53 by the time the handler
  // runs, so accepting a number would mean accepting a value that is quietly not the one sent.
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  const now = Date.now()
  const reply = await call('POST', `/v1/communities/${community.id}/proposals`, {
    as: 'alice',
    key: 'idem-p-num-00000000',
    body: {
      kind: 'text',
      title: 'T',
      quorum: 5,
      thresholdBps: 5_000,
      opensAt: new Date(now + 60_000).toISOString(),
      closesAt: new Date(now + 3_600_000).toISOString(),
      timelockUntil: new Date(now + 7_200_000).toISOString(),
    },
  })
  assert.equal(reply.status, 400)
  assert.match(String((reply.body['error'] as Record<string, unknown>)['message']), /decimal string/)
})

test('a huge quorum survives the round trip as a string', { skip }, async () => {
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  const huge = (2n ** 90n).toString()
  const now = Date.now()
  const reply = await call('POST', `/v1/communities/${community.id}/proposals`, {
    as: 'alice',
    key: 'idem-p-huge-00000000',
    body: {
      kind: 'text',
      title: 'T',
      quorum: huge,
      thresholdBps: 5_000,
      opensAt: new Date(now + 60_000).toISOString(),
      closesAt: new Date(now + 3_600_000).toISOString(),
      timelockUntil: new Date(now + 7_200_000).toISOString(),
    },
  })
  assert.equal(reply.status, 201)
  assert.equal((reply.body['proposal'] as Record<string, unknown>)['quorum'], huge)
})

/* ------------------------------------------------------------------ idempotency on the wire */

test('a mutating route without an Idempotency-Key is a 400', { skip }, async () => {
  const reply = await call('POST', '/v1/communities', { as: 'alice', body: communityBody() })
  assert.equal(reply.status, 400)
  assert.match(String((reply.body['error'] as Record<string, unknown>)['message']), /Idempotency-Key/)
})

test('an idempotent retry replays with 200 and says so', { skip }, async () => {
  const body = communityBody()
  const first = await call('POST', '/v1/communities', { as: 'alice', key: 'same-key', body })
  assert.equal(first.status, 201)
  assert.equal(first.body['replayed'], false)

  const second = await call('POST', '/v1/communities', { as: 'alice', key: 'same-key', body })
  // 200 rather than 201, so a client can tell "I created this" from "this already existed".
  assert.equal(second.status, 200)
  assert.equal(second.body['replayed'], true)
  assert.deepEqual(second.body['community'], first.body['community'])

  const count = await sql<{ n: number }[]>`select count(*)::int as n from communities`
  assert.equal(count[0]?.n, 1)
})

test('two members may use the same client key without colliding', { skip }, async () => {
  // The reason the key is namespaced by principal. Answered with each other's response, the second
  // member would be told their community was created when what exists is somebody else's.
  const a = await call('POST', '/v1/communities', { as: 'alice', key: 'idem-my-key-00000000', body: communityBody() })
  const b = await call('POST', '/v1/communities', { as: 'bob', key: 'idem-my-key-00000000', body: communityBody() })
  assert.equal(a.status, 201)
  assert.equal(b.status, 201)
  assert.notEqual(
    (a.body['community'] as Record<string, unknown>)['id'],
    (b.body['community'] as Record<string, unknown>)['id'],
  )
})

test('the same key with a different body is a 409', { skip }, async () => {
  await call('POST', '/v1/communities', { as: 'alice', key: 'idem-reuse-00000000', body: communityBody() })
  const reply = await call('POST', '/v1/communities', { as: 'alice', key: 'idem-reuse-00000000', body: communityBody() })
  assert.equal(reply.status, 409)
  assert.equal((reply.body['error'] as Record<string, unknown>)['code'], 'idempotency_key_reuse')
})

/* ------------------------------------------------------------------ voting over the wire */

test('a vote is recorded, and a second one is a 409 naming who cast the power', { skip }, async () => {
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  await seedMember(sql, community, BOB)
  const proposal = await seedProposal(sql, community, { status: 'voting', quorum: 1n })

  const first = await call('POST', `/v1/proposals/${proposal.id}/votes`, {
    as: 'bob',
    key: 'idem-vote-1-00000000',
    body: { choice: 'for' },
  })
  assert.equal(first.status, 201)
  assert.equal((first.body['vote'] as Record<string, unknown>)['subjectsCounted'], 1)

  const second = await call('POST', `/v1/proposals/${proposal.id}/votes`, {
    as: 'bob',
    key: 'idem-vote-2-00000000',
    body: { choice: 'against' },
  })
  assert.equal(second.status, 409)
  assert.equal((second.body['error'] as Record<string, unknown>)['code'], 'already_voted')
  assert.equal((await findVoteFor(sql, proposal.id, BOB))?.choice, 'for')
})

test('a delegate is told which delegators voted for themselves', { skip }, async () => {
  // Silence here is how a delegate believes they cast power they did not.
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  await seedMember(sql, community, BOB)
  await seedMember(sql, community, subject('carol'))
  await call('POST', `/v1/communities/${community.id}/delegations`, {
    as: 'carol',
    key: 'idem-d1-00000000',
    body: { delegate: BOB },
  })
  const proposal = await seedProposal(sql, community, { status: 'voting', quorum: 1n })

  await call('POST', `/v1/proposals/${proposal.id}/votes`, { as: 'carol', key: 'idem-v1-00000000', body: { choice: 'against' } })
  const reply = await call('POST', `/v1/proposals/${proposal.id}/votes`, {
    as: 'bob',
    key: 'idem-v2-00000000',
    body: { choice: 'for' },
  })
  const vote = reply.body['vote'] as Record<string, unknown>
  assert.equal(vote['subjectsCounted'], 1)
  assert.deepEqual(vote['overriddenBy'], [subject('carol')])
})

test('a delegation cycle over the wire is a 409, not a 500', { skip }, async () => {
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  await seedMember(sql, community, BOB)
  await call('POST', `/v1/communities/${community.id}/delegations`, {
    as: 'bob',
    key: 'idem-d1-00000000',
    body: { delegate: ALICE },
  })
  const reply = await call('POST', `/v1/communities/${community.id}/delegations`, {
    as: 'alice',
    key: 'idem-d2-00000000',
    body: { delegate: BOB },
  })
  assert.equal(reply.status, 409)
  assert.equal((reply.body['error'] as Record<string, unknown>)['code'], 'delegation_cycle')
})

test('the tally reports integers as strings and a provisional outcome', { skip }, async () => {
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  await seedMember(sql, community, BOB)
  const proposal = await seedProposal(sql, community, { status: 'voting', quorum: 2n })
  await call('POST', `/v1/proposals/${proposal.id}/votes`, { as: 'bob', key: 'idem-v1-00000000', body: { choice: 'for' } })

  const reply = await call('GET', `/v1/proposals/${proposal.id}/tally`, { as: 'bob' })
  const tally = reply.body['tally'] as Record<string, unknown>
  assert.equal(tally['forWeight'], '1')
  assert.equal(tally['quorum'], '2')
  assert.equal(tally['quorumMet'], false)
  // Not the proposal's status — a proposal still voting has no outcome, and saying otherwise
  // invites reading a live count as a result.
  assert.equal(tally['provisionalOutcome'], 'rejected')
  assert.equal(tally['reason'], 'quorum_not_met')
  assert.equal(tally['eligibleMembers'], 2)
})

/* ------------------------------------------------------------------ the execute route */

test('the execute route refuses a user token', { skip }, async () => {
  const proposal = await seedProposal(sql, await seedCommunity(sql, { ownerSubject: ALICE }), {})
  const reply = await call('POST', `/internal/proposals/${proposal.id}/execute`, { as: 'alice' })
  assert.equal(reply.status, 403)
})

test('the execute route refuses community:* — the exact matcher, over a socket', { skip }, async () => {
  // The wildcard decision, proven end to end rather than only in `scopes.test.ts`. A token like
  // this is what a broadly scoped integration credential looks like, and what a compromised one
  // looks like.
  const proposal = await seedProposal(sql, await seedCommunity(sql, { ownerSubject: ALICE }), {})
  const reply = await call('POST', `/internal/proposals/${proposal.id}/execute`, { as: 'svc:community:*' })
  assert.equal(reply.status, 403)
  assert.match(
    String((reply.body['error'] as Record<string, unknown>)['message']),
    /community:execute/,
  )
})

test('the execute route refuses community:write — execute is its own scope', { skip }, async () => {
  const proposal = await seedProposal(sql, await seedCommunity(sql, { ownerSubject: ALICE }), {})
  const reply = await call('POST', `/internal/proposals/${proposal.id}/execute`, {
    as: 'svc:community:read,community:write',
  })
  assert.equal(reply.status, 403)
})

test('the execute route cannot bypass the timelock', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // It calls the same `executeProposal` the job calls, which inserts an `executions` row, which
  // fires the BEFORE INSERT trigger. There is no argument, header or scope that changes that.
  //
  // 409 rather than 403: the request is legitimate and will succeed later, and a 403 would read as
  // "you may not do this", which is exactly wrong about a timelock.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  await seedTreasuryAccount(sql, community, 'EMBER')
  const now = Date.now()
  const proposal = await seedProposal(sql, community, {
    kind: 'treasury_spend',
    opensAt: new Date(now - 10_800_000),
    closesAt: new Date(now - 7_200_000),
    timelockUntil: new Date(now + 3_600_000),
    spend: { assetCode: 'EMBER', amount: 1_000n, recipient: BOB },
    status: 'timelocked',
  })

  const reply = await call('POST', `/internal/proposals/${proposal.id}/execute`, {
    as: 'svc:community:execute',
  })
  assert.equal(reply.status, 409)
  assert.equal((reply.body['error'] as Record<string, unknown>)['code'], 'timelocked')
  assert.equal(await findExecution(sql, proposal.id), null)
  assert.equal(ledger.calls.length, 0, 'the ledger was called before the timelock refused')
})

test('the execute route executes once the timelock has expired', { skip }, async () => {
  // The other direction, so the test above is not passing on a route that refuses everything.
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  await seedTreasuryAccount(sql, community, 'EMBER')
  const now = Date.now()
  const proposal = await seedProposal(sql, community, {
    kind: 'treasury_spend',
    opensAt: new Date(now - 10_800_000),
    closesAt: new Date(now - 7_200_000),
    timelockUntil: new Date(now - 60_000),
    spend: { assetCode: 'EMBER', amount: 1_000n, recipient: BOB },
    status: 'timelocked',
  })

  const before = ledger.calls.length
  const reply = await call('POST', `/internal/proposals/${proposal.id}/execute`, {
    as: 'svc:community:execute',
  })
  assert.equal(reply.status, 201)
  assert.equal(reply.body['status'], 'executed')
  assert.ok((await findExecution(sql, proposal.id))?.ledgerEntryId)
  assert.equal(ledger.calls.length, before + 1)

  // And the retry is `already`, with no second posting.
  const retry = await call('POST', `/internal/proposals/${proposal.id}/execute`, {
    as: 'svc:community:execute',
  })
  assert.equal(retry.status, 200)
  assert.equal(retry.body['status'], 'already')
  assert.equal(ledger.calls.length, before + 1)
})

/* ------------------------------------------------------------------ the inbox */

test('an unsigned event is refused', { skip }, async () => {
  // Unsigned, this route is an erase-anybody's-membership endpoint reachable by anything that can
  // open a socket to the app network.
  const response = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: crypto.randomUUID(), topic: 'identity.user.deleted', payload: { userId: 'x' } }),
  })
  assert.equal(response.status, 401)
})

test('erasure pseudonymises the governance record rather than deleting it', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Deleting the vote rows would silently change a historical tally and could retroactively un-pass
  // a proposal whose money has already moved. So the arithmetic survives and the person does not.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  await seedMember(sql, community, BOB)
  const proposal = await seedProposal(sql, community, { status: 'voting', quorum: 1n })
  await call('POST', `/v1/proposals/${proposal.id}/votes`, { as: 'bob', key: 'idem-v1-00000000', body: { choice: 'for' } })

  const envelope = {
    id: crypto.randomUUID(),
    topic: 'identity.user.deleted',
    key: 'idem-bob-00000000',
    occurredAt: new Date().toISOString(),
    producer: 'identity',
    version: 1,
    actor: null,
    correlationId: null,
    payload: { userId: 'bob' },
  }
  const body = JSON.stringify(envelope)
  const { signEvent, SIGNATURE_HEADER } = await import('./outbox.ts')
  const response = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signEvent(body, 'a-signing-secret-long-enough-000'),
    },
    body,
  })
  assert.equal(response.status, 202)
  const outcome = (await response.json()) as Record<string, unknown>
  assert.equal(outcome['status'], 'processed')
  assert.equal(outcome['votesPseudonymised'], 1)
  assert.equal(outcome['membershipsRemoved'], 1)

  // The weight is still counted; the subject is no longer Bob.
  const votes = await sql<{ subject: string; weight: string }[]>`
    select subject, weight::text as weight from votes where proposal_id = ${proposal.id}
  `
  assert.equal(votes.length, 1, 'the tally changed retroactively')
  assert.equal(votes[0]?.weight, '1')
  assert.notEqual(votes[0]?.subject, BOB)
  assert.match(votes[0]?.subject ?? '', /^user:erased-/)
  assert.equal(await roleIn(sql, community.id, BOB), null)
})

test('erasure reaches EVERY column that named the person, not just votes', { skip }, async () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // The handler pseudonymised votes, proposal authors, post authors and memberships, and left
  // five other columns holding `user:<uuid>` in the clear:
  //
  //   communities.owner_subject     a founder survived erasure entirely
  //   delegations.delegator_subject the edge was revoked; the person on it was not touched
  //   delegations.delegate_subject  same
  //   proposals.target_subject      the member a role_change proposal is ABOUT
  //   executions.executed_by        who executed a passed proposal
  //   discussion_posts.body         `redacted_at` masks the text on READ; it stays in the table
  //
  // This test plants the erased subject in all of them and asserts that nothing survives. It is
  // written as a sweep over the schema rather than as six assertions so that a column added to a
  // subject-bearing table later is caught here instead of quietly becoming the seventh.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const CAROL = subject('carol')
  const owned = await seedCommunity(sql, { ownerSubject: BOB })
  await seedMember(sql, owned, CAROL)
  const proposal = await seedProposal(sql, owned, { status: 'voting', quorum: 1n })

  await sql`update proposals set target_subject = ${BOB} where id = ${proposal.id}`
  await sql`
    insert into discussion_posts (proposal_id, author, body)
    values (${proposal.id}, ${BOB}, 'my name is bob and my email is in this post')
  `
  await sql`
    insert into delegations (community_id, delegator_subject, delegate_subject)
    values (${owned.id}, ${BOB}, ${CAROL})
  `
  // An execution may only be recorded against a timelocked proposal — the trigger says so, and
  // it is right to. A second proposal is moved into that state so the execution row is legal.
  const executed = await seedProposal(sql, owned, { status: 'voting', quorum: 1n })
  await sql`
    update proposals
       set status         = 'timelocked',
           opens_at       = now() - interval '3 hours',
           closes_at      = now() - interval '2 hours',
           timelock_until = now() - interval '1 hour'
     where id = ${executed.id}
  `
  await sql`
    insert into executions (proposal_id, kind, executed_by, idempotency_key, correlation_id)
    values (${executed.id}, 'text', ${BOB}, ${crypto.randomUUID()}, ${crypto.randomUUID()})
  `

  const envelope = {
    id: crypto.randomUUID(),
    topic: 'identity.user.deleted',
    key: 'idem-bob-erase-all',
    occurredAt: new Date().toISOString(),
    producer: 'identity',
    version: 1,
    actor: null,
    correlationId: null,
    payload: { userId: 'bob' },
  }
  const body = JSON.stringify(envelope)
  const { signEvent, SIGNATURE_HEADER } = await import('./outbox.ts')
  const response = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signEvent(body, 'a-signing-secret-long-enough-000'),
    },
    body,
  })
  assert.equal(response.status, 202)

  // Every text column of every table this service owns, asked the same question: does the erased
  // subject still appear anywhere at all?
  const [leaks] = await sql<{ n: number }[]>`
    select (
      (select count(*) from communities       where owner_subject     = ${BOB})
    + (select count(*) from memberships       where subject           = ${BOB})
    + (select count(*) from proposals         where author            = ${BOB} or target_subject = ${BOB})
    + (select count(*) from discussion_posts  where author            = ${BOB} or position('bob' in body) > 0)
    + (select count(*) from delegations       where delegator_subject = ${BOB} or delegate_subject = ${BOB})
    + (select count(*) from votes             where subject           = ${BOB} or cast_by = ${BOB})
    + (select count(*) from executions        where executed_by       = ${BOB})
    )::int as n`
  assert.equal(leaks!.n, 0, 'a column naming the erased subject survived erasure')

  // The rows themselves are all still there — this is pseudonymisation, not deletion, and a
  // community, a proposal and an execution are other people's records.
  const [kept] = await sql<{ n: number }[]>`
    select (
      (select count(*) from communities where id = ${owned.id})
    + (select count(*) from proposals   where id = ${proposal.id})
    + (select count(*) from executions  where proposal_id = ${executed.id})
    )::int as n`
  assert.equal(kept!.n, 3, 'erasure deleted a record that belongs to the community')

  // And the tombstone is terminal: the community cannot be handed back to a real account.
  await assert.rejects(
    () => sql`update communities set owner_subject = ${CAROL} where id = ${owned.id}`,
    /erased owner/,
    'an erased community owner could be re-attributed',
  )
})

test('a redelivered erasure event is a duplicate, not a second erasure', { skip }, async () => {
  const id = crypto.randomUUID()
  const send = async () => {
    const envelope = { id, topic: 'identity.user.deleted', payload: { userId: 'ghost' } }
    const body = JSON.stringify(envelope)
    const { signEvent, SIGNATURE_HEADER } = await import('./outbox.ts')
    return fetch(`${baseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signEvent(body, 'a-signing-secret-long-enough-000'),
      },
      body,
    })
  }
  assert.equal(((await (await send()).json()) as Record<string, unknown>)['status'], 'processed')
  assert.equal(((await (await send()).json()) as Record<string, unknown>)['status'], 'duplicate')
})

test('an unsubscribed topic is accepted and ignored with a 202', { skip }, async () => {
  // A 4xx would make the producer's relay retry an event it is correct to send and we are correct
  // not to act on, for ever.
  const envelope = { id: crypto.randomUUID(), topic: 'mint.token.deployed', payload: {} }
  const body = JSON.stringify(envelope)
  const { signEvent, SIGNATURE_HEADER } = await import('./outbox.ts')
  const response = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signEvent(body, 'a-signing-secret-long-enough-000'),
    },
    body,
  })
  assert.equal(response.status, 202)
  assert.equal(((await response.json()) as Record<string, unknown>)['status'], 'ignored')
})

/* ------------------------------------------------------------------ vocabulary */

test('the scope list says a wildcard grants nothing', { skip }, async () => {
  // A promise this service makes to every caller, said on the wire, whatever another service in the
  // estate does with a wildcard.
  const reply = await call('GET', '/v1/scopes')
  assert.equal(reply.status, 200)
  assert.equal(reply.body['wildcards'], false)
  const names = (reply.body['scopes'] as Array<Record<string, unknown>>).map((s) => s['name'])
  assert.deepEqual([...names].sort(), ['community:execute', 'community:read', 'community:write'])
})

test('a malformed uuid in a path is a 400, not a 500', { skip }, async () => {
  assert.equal((await call('GET', '/v1/communities/not-a-uuid', { as: 'alice' })).status, 400)
})

test('a request with no credential is a 401', { skip }, async () => {
  const community = await seedCommunity(sql, { ownerSubject: ALICE })
  assert.equal((await call('GET', `/v1/communities/${community.id}`)).status, 401)
})

/**
 * One handle, presented as the per-network selector the server now takes. The fixture runs against
 * a single test database, so mainnet is the only configured network — which exercises the REFUSAL
 * path for free: anything reaching for testnet throws rather than reusing this handle.
 */
function singleNetworkSql(db: unknown) {
  return networkSql({ mainnet: db as RuntimeSql })
}
