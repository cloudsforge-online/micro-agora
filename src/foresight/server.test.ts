/**
 * The HTTP surface, against a real socket and a real database.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO THAT MATTER MOST.
 *
 *   * **POLICY FAILS CLOSED.** If policy cannot be reached, `POST /markets/:id/stake-intent`
 *     refuses with 503 and hands out nothing. `micro-market` fails OPEN on its equivalent gate and
 *     is right to — a listing can be taken down afterwards. A stake cannot: it is EMBER in a
 *     contract with no undo.
 *
 *   * **AN IDEMPOTENT RETRY REPLAYS, IT DOES NOT 409.** The retry a caller actually makes carries a
 *     fresh trace id, and a fingerprint that included it would answer 409 to a caller doing exactly
 *     the right thing. `micro-ledger` pinned this and `micro-wallet` found it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Lifecycle } from '@cloudsforge/lifecycle'
import type { Principal, Verifier } from '@cloudsforge/auth'
import { CATEGORY_VERSION } from './categories.ts'
import { createServer, type ServerDeps } from './server.ts'
import { selector } from './evm.ts'
import { findMarket } from './markets.ts'
import { MARKET_DEPLOY } from './jobs.ts'
import {
  OPERATOR,
  db,
  enabled,
  fakePolicy,
  fakeSourceProbe,
  migrateTestDb,
  openDb,
  openDirect,
  quietLogger,
  resetForesight,
  seedDraft,
  seedIdea,
  skip,
  testMetrics,
  FUTURE,
  type FakePolicy,
  fakeLedger,
  fakePricing,
} from './testsupport.ts'
import { approveIdea } from './ideas.ts'

let sql: postgres.Sql
let server: Server
let baseUrl: string
let policy: FakePolicy

const ADMIN: Principal = {
  kind: 'user',
  userId: '00000000-0000-4000-8000-000000000001',
  roles: ['admin'],
} as unknown as Principal
const PLAYER: Principal = {
  kind: 'user',
  userId: '00000000-0000-4000-8000-000000000002',
  roles: ['player'],
} as unknown as Principal

/** The token IS the principal here. The verifier is the seam; identity is tested in its own repo. */
function fakeVerifier(): Verifier {
  return {
    async principal(token: string) {
      if (token === 'admin') return ADMIN
      if (token === 'player') return PLAYER
      const { TokenError } = await import('@cloudsforge/auth')
      throw new TokenError('bad token', 'invalid')
    },
  } as unknown as Verifier
}

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
  policy = fakePolicy()
  const testQueue = new JobQueue(sql as unknown as JobsSql, { owner: 'test', leaseMs: 60_000 })
  const deps: ServerDeps = {
    sql: singleNetworkSql(db(sql)),
    singleNetwork: 'mainnet' as const,
    queue: testQueue,
    // One queue, presented as the per-network selector: the suites run against a single
    // database, so both networks resolve to it. What is under test is that a route ASKS.
    queueFor: () => testQueue,
    verifier: fakeVerifier(),
    lifecycle: new Lifecycle({}),
    logger: quietLogger(),
    metrics: testMetrics(),
    policy,
    sourceProbe: fakeSourceProbe(true),
    producer: 'foresight',
    chain: 'ember',
    network: 'testnet',
    defaultFeeBps: 200,
    defaultDisputeWindowSeconds: 86_400,
    // The engagement programme is deliberately ABSENT here — houseseed.test.ts wires it. What
    // this file's suite proves about it is only that its absence changes nothing.
    houseAddress: undefined,
    // Custodial staking is deliberately UNCONFIGURED in this file: what it proves about the
    // feature is only that its absence changes nothing for a wallet stake. custodialstakes.test.ts
    // wires it.
    pricing: fakePricing(),
    ledger: fakeLedger(),
    custodialAddress: undefined,
    engagementPolicies: null,
    // No public studio address here: this file proves nothing about images, and `undefined` is
    // the supported mode that makes every `image.bytesUrl` null.
    studioPublicUrl: undefined,
  }
  server = createServer(deps)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetForesight(sql)
  policy.setDown(false)
  policy.setVerdict({ decision: 'allow', reasons: [], degraded: false, decisionId: 'd1' })
})

interface Response {
  readonly status: number
  readonly body: Record<string, never>
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; key?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.token) headers['authorization'] = `Bearer ${options.token}`
  if (options.key) headers['idempotency-key'] = options.key
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, never> }
}

/* ------------------------------------------------------------------ health and the allowlist */

test('the three health endpoints are served', { skip }, async () => {
  assert.equal((await call('GET', '/livez')).status, 200)
  const ready = await call('GET', '/readyz')
  assert.ok(ready.status === 200 || ready.status === 503)
  const metrics = await fetch(`${baseUrl}/metrics`)
  assert.equal(metrics.status, 200)
  assert.match(metrics.headers.get('content-type') ?? '', /text\/plain/)
})

test('the category allowlist and the refusals are public and unauthenticated', { skip }, async () => {
  // A refusal list behind a token is a refusal list nobody can hold the platform to.
  const response = await call('GET', '/categories')
  assert.equal(response.status, 200)
  const body = response.body as unknown as { version: number; categories: unknown[]; refusals: unknown[] }
  assert.equal(body.version, CATEGORY_VERSION)
  assert.equal(body.categories.length, 3)
  assert.equal(body.refusals.length, 3)
})

/* ------------------------------------------------------------------ policy fails closed */

test('THE PROPERTY: if policy is unreachable, staking refuses', { skip }, async () => {
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)

  policy.setDown(true)
  const response = await call('POST', `/markets/${market.id}/stake-intent`, {
    token: 'player',
    body: { amount: '10', outcome: 0 },
  })

  // 503, not 200 and not 403. The caller should retry; it has not been refused on its merits.
  assert.equal(response.status, 503, 'a stake intent was issued while policy was unreachable')
  const error = (response.body as unknown as { error: { code: string } }).error
  assert.equal(error.code, 'policy_unavailable')
  // And nothing that a wallet could act on came back.
  assert.equal('to' in response.body, false)
  assert.equal('data' in response.body, false)
})

test('a policy deny is 403 and says so; a policy allow hands back calldata and nothing else', { skip }, async () => {
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)

  policy.setVerdict({ decision: 'deny', reasons: ['subject_frozen'], degraded: false, decisionId: 'd9' })
  const denied = await call('POST', `/markets/${market.id}/stake-intent`, {
    token: 'player',
    body: { amount: '10', outcome: 0 },
  })
  assert.equal(denied.status, 403)
  assert.match(JSON.stringify(denied.body), /subject_frozen/)

  policy.setVerdict({ decision: 'allow', reasons: [], degraded: false, decisionId: 'd1' })
  const allowed = await call('POST', `/markets/${market.id}/stake-intent`, {
    token: 'player',
    body: { amount: '10', outcome: 1 },
  })
  assert.equal(allowed.status, 200)
  const intent = allowed.body as unknown as { to: string; data: string; outcome: number; asset: string }
  const fresh = await findMarket(db(sql), market.id)
  // The contract address and the calldata. **The wallet signs; this service never touches the
  // EMBER and has no key with which it could.**
  assert.equal(intent.to, fresh?.contractAddress)
  assert.ok(intent.data.startsWith(selector('stake(uint8)')))
  assert.equal(intent.outcome, 1)
  assert.equal(intent.asset, 'EMBER')

  // Policy saw the subject, the market and the amount — as a decimal string.
  assert.equal(policy.calls.at(-1)?.subject, `user:${PLAYER.kind === 'user' ? PLAYER.userId : ''}`)
  assert.equal(policy.calls.at(-1)?.amount, '10')
})

test('an amount that arrived as a JSON number is refused, never coerced', { skip }, async () => {
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  // One EMBER is 1e18 wei. A number has already been through a double by the time this code sees
  // it, and policy refuses one for the same reason.
  const response = await call('POST', `/markets/${market.id}/stake-intent`, {
    token: 'player',
    body: { amount: 10, outcome: 0 },
  })
  assert.equal(response.status, 400)
  assert.match(JSON.stringify(response.body), /decimal string, not a number/)
})

test('a market that is not open, or past its close time, refuses a stake intent before the chain does', { skip }, async () => {
  const draft = await seedDraft(sql)
  assert.equal(
    (await call('POST', `/markets/${draft.id}/stake-intent`, { token: 'player', body: { amount: '1', outcome: 0 } }))
      .status,
    409,
  )

  const closing = await seedDraft(sql, { closeTime: new Date(Date.now() + 60_000) })
  await openDirect(sql, closing.id)
  await sql`update markets set close_time = now() - interval '1 minute' where id = ${closing.id}`
  const response = await call('POST', `/markets/${closing.id}/stake-intent`, {
    token: 'player',
    body: { amount: '1', outcome: 0 },
  })
  // The contract would refuse it anyway. Saying so here saves the user a failed transaction and
  // the gas that goes with it.
  assert.equal(response.status, 409)
  assert.match(JSON.stringify(response.body), /close time/)
})

/* ------------------------------------------------------------------ idempotency */

test('THE PROPERTY: an idempotent retry replays rather than 409s', { skip }, async () => {
  const market = await seedDraft(sql)
  await sql`update markets set status = 'approved', approved_by = ${OPERATOR}, approved_at = now() where id = ${market.id}`

  const first = await call('POST', `/markets/${market.id}/deploy`, { token: 'admin', key: 'deploy-key-0001' })
  assert.equal(first.status, 202)
  assert.equal((first.body as unknown as { replayed: boolean }).replayed, false)

  // The SAME key again. In production the retry carries a fresh `x-request-id`, which is exactly
  // the field the fingerprint excludes — including it would answer 409 to a caller doing the right
  // thing, and it could not tell that from a genuine key collision.
  const second = await call('POST', `/markets/${market.id}/deploy`, { token: 'admin', key: 'deploy-key-0001' })
  assert.equal(second.status, 202, 'a legitimate retry was refused')
  assert.equal((second.body as unknown as { replayed: boolean }).replayed, true)

  // One job, not two. Two deploy jobs for one market is the road to two contracts.
  const jobs = await sql<{ n: number }[]>`select count(*)::int as n from jobs where kind = ${MARKET_DEPLOY}`
  assert.equal(jobs[0]?.n, 1)
})

test('the same key with a different body is a 409, not a replay', { skip }, async () => {
  const a = await seedDraft(sql)
  const b = await seedDraft(sql)
  for (const id of [a.id, b.id]) {
    await sql`update markets set status = 'approved', approved_by = ${OPERATOR}, approved_at = now() where id = ${id}`
  }
  assert.equal((await call('POST', `/markets/${a.id}/deploy`, { token: 'admin', key: 'shared-key-0001' })).status, 202)
  // Returning the first request's answer to a second, different request is worse than an error:
  // the caller believes the thing it asked for happened.
  const clash = await call('POST', `/markets/${b.id}/deploy`, { token: 'admin', key: 'shared-key-0001' })
  assert.equal(clash.status, 409)
  assert.match(JSON.stringify(clash.body), /idempotency_key_reuse/)
})

test('a deploy without an idempotency key is refused', { skip }, async () => {
  const market = await seedDraft(sql)
  await sql`update markets set status = 'approved', approved_by = ${OPERATOR}, approved_at = now() where id = ${market.id}`
  const response = await call('POST', `/markets/${market.id}/deploy`, { token: 'admin' })
  assert.equal(response.status, 400)
  assert.match(JSON.stringify(response.body), /Idempotency-Key/)
})

/* ------------------------------------------------------------------ operator authority */

test('a player cannot reach any operator route', { skip }, async () => {
  const market = await seedDraft(sql)
  const idea = await seedIdea(sql)
  for (const [method, path, body] of [
    ['GET', '/ideas', undefined],
    ['POST', '/ideas', { question: 'x' }],
    ['POST', `/ideas/${idea.id}/approve`, {}],
    ['POST', '/markets', { question: 'x' }],
    ['POST', `/markets/${market.id}/approve`, {}],
    ['POST', `/markets/${market.id}/open`, {}],
    ['POST', `/markets/${market.id}/resolve`, { outcome: 0, rationale: 'x' }],
  ] as const) {
    const response = await call(method, path, { token: 'player', body, key: 'k-00000001' })
    assert.equal(response.status, 403, `${method} ${path} was reachable by a player`)
  }
})

test('an unauthenticated request is 401 and says nothing about why', { skip }, async () => {
  const response = await call('GET', '/ideas')
  assert.equal(response.status, 401)
  // "signature verification failed" versus "expired" tells an attacker which half of a forged
  // token to fix.
  assert.match(JSON.stringify(response.body), /a valid bearer token is required/)
})

/* ------------------------------------------------------------------ the operator flow */

test('an operator can walk a proposal to an open market through the API', { skip }, async () => {
  const idea = await seedIdea(sql)
  const approved = await call('POST', `/ideas/${idea.id}/approve`, { token: 'admin', body: { note: 'reads well' } })
  assert.equal(approved.status, 200)
  // The approval is recorded against the OPERATOR, which is what the schema constraint checks.
  assert.match(JSON.stringify(approved.body), /operator:/)

  const created = await call('POST', '/markets', {
    token: 'admin',
    body: {
      ideaId: idea.id,
      question: idea.question,
      resolutionCriteria: idea.resolutionCriteria,
      category: idea.category,
      resolutionSourceKind: idea.resolutionSourceKind,
      resolutionSourceRef: idea.resolutionSourceRef,
      closeTime: FUTURE().toISOString(),
    },
  })
  assert.equal(created.status, 201)
  const marketId = (created.body as unknown as { market: { id: string; feeBps: number } }).market.id

  assert.equal((await call('POST', `/markets/${marketId}/approve`, { token: 'admin' })).status, 200)
  // Not openable without a contract.
  assert.equal((await call('POST', `/markets/${marketId}/open`, { token: 'admin' })).status, 409)
})

test('a market outside the allowlist cannot be drafted at all', { skip }, async () => {
  const response = await call('POST', '/markets', {
    token: 'admin',
    body: {
      question: 'Will a named private individual do something?',
      resolutionCriteria: 'YES if somebody says so.',
      category: 'celebrity',
      resolutionSourceKind: 'block_explorer',
      resolutionSourceRef: 'https://example.invalid/x',
      closeTime: FUTURE().toISOString(),
    },
  })
  assert.equal(response.status, 400)
  assert.match(JSON.stringify(response.body), /not an allowed market category/)
})

/* ------------------------------------------------------------------ the public page */

test('the market page carries the cited sources, the document and its hash', { skip }, async () => {
  const idea = await seedIdea(sql)
  await approveIdea(db(sql), idea.id, OPERATOR, null, new Date())
  const market = await seedDraft(sql, { ideaId: idea.id })
  await openDirect(sql, market.id)

  const response = await call('GET', `/markets/${market.id}`)
  assert.equal(response.status, 200)
  const body = response.body as unknown as {
    market: { questionHash: string }
    pool: { asOf: string | null; stale: boolean; yes: string }
    document: { canonical: string; hash: string }
    provenance: { sources: { url: string }[]; modelId: string; searchQuery: string }
  }
  // A bettor can recompute the hash from the document and check it against the contract, rather
  // than taking the platform's word that the criteria have not been edited since it opened.
  assert.equal(body.document.hash, body.market.questionHash)
  assert.ok(body.document.canonical.includes('cloudsforge.foresight.market/1'))
  // §2.3.3: the sources are carried through so a bettor can see WHY the market exists.
  assert.equal(body.provenance.sources[0]?.url, 'https://example.invalid/a')
  assert.equal(body.provenance.modelId, 'test-model-1')
  // And the pool says AS OF WHEN — a mirror that has never run is stale, not empty.
  assert.equal(body.pool.yes, '0')
  assert.equal(body.pool.asOf, null)
  assert.equal(body.pool.stale, true)
})

test('a market an operator wrote has no provenance rather than a fabricated one', { skip }, async () => {
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  const response = await call('GET', `/markets/${market.id}`)
  assert.equal((response.body as unknown as { provenance: unknown }).provenance, null)
})

test('an unknown market and an unknown route are both 404, with the request id', { skip }, async () => {
  const missing = await call('GET', '/markets/00000000-0000-4000-8000-0000000000ff')
  assert.equal(missing.status, 404)
  assert.match(JSON.stringify(missing.body), /requestId/)
  assert.equal((await call('GET', '/nope')).status, 404)
  // A malformed id is a 400, not a 500 out of the driver.
  assert.equal((await call('GET', '/markets/not-a-uuid')).status, 400)
})

test('every response carries the request id it will be quoted by', { skip }, async () => {
  const response = await fetch(`${baseUrl}/livez`, { headers: { 'x-request-id': 'my-own-id' } })
  assert.equal(response.headers.get('x-request-id'), 'my-own-id')
  // Health and a pool are point-in-time facts; a cached one is the lie this stops telling.
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

/**
 * One handle, presented as the per-network selector the server now takes. The fixture runs against
 * a single test database, so mainnet is the only configured network — which exercises the REFUSAL
 * path for free: anything reaching for testnet throws rather than reusing this handle.
 */
export function singleNetworkSql(db: unknown) {
  return networkSql({ mainnet: db as RuntimeSql })
}
