/**
 * Every mutating route either replays a retry or has a documented reason not to.
 *
 * WHY THIS IS A SOURCE-LEVEL TEST. In `micro-market`, `POST /v1/orders/:id/disputes` was a plain
 * INSERT with no natural key and no route wrapper, so a double-clicked button — or any client
 * retrying a request whose response it never saw — opened TWO disputes on one order and froze the
 * listing twice. `POST /v1/moderation/cases` had the same shape. Both sat beside four sibling
 * routes that wrap correctly, and nothing noticed, because the domain tests called the functions
 * directly and never traversed the route.
 *
 * Found by `micro-sdk`, cataloguing which public routes require an `Idempotency-Key`. The answer
 * for those two was "none", and the SDK could not have known that was a mistake rather than a
 * design.
 *
 * So this asserts the *shape of the file* rather than behaviour, deliberately: the defect is an
 * omission, and an omission has no behaviour to test. A route added tomorrow without a wrapper
 * fails here, and its author must either wrap it or write down why it does not need one.
 *
 * The stake in this repository is higher than in market's. `POST /v1/proposals/:id/votes` without a
 * wrapper would let a retried request be answered "already voted" for a vote that never landed —
 * or, worse on a route that creates rather than conflicts, record two proposals for one intent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SERVER = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8')

/**
 * Mutating routes that are safe WITHOUT the wrapper, each with the reason it is safe. A route is
 * only exempt if retrying it a second time cannot produce a second artefact.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'POST /v1/events':
    'the inbox, deduplicated on (topic, event_id) — its idempotency is the whole point of the table',
  'PUT /v1/communities/:id/members/:subject/role':
    'PUT of an absolute role. A retry sets the same value; there is no second artefact to create',
  'POST /v1/proposals/:id/open':
    "a state transition claimed with `where status = 'draft'`; the second attempt matches no row",
  'POST /v1/proposals/:id/cancel':
    'a state transition claimed on the proposal\'s current status; the second attempt matches no row',
  'DELETE /v1/proposals/:id/votes': 'DELETE is idempotent by definition',
  'DELETE /v1/communities/:id/delegations': 'DELETE is idempotent by definition',
  'DELETE /v1/posts/:id':
    'a redaction claimed with `where redacted_at is null`; the second attempt matches no row',
  'POST /internal/proposals/:id/execute':
    'executions_proposal_uniq plus the proposal row lock make a retry `already` rather than a second spend — four independent mechanisms, in executions.ts. A client key would be a fifth and would add nothing',
  'POST /internal/proposals/:id/enqueue-execution':
    'an enqueue with onConflict, against jobs_kind_key_uniq. N calls produce one row',
}

function mutatingRoutes(): Array<{ key: string; wrapped: boolean }> {
  const out: Array<{ key: string; wrapped: boolean }> = []
  const re = /define\('(POST|PUT|PATCH|DELETE)', '([^']+)'/g
  const starts: Array<{ key: string; at: number }> = []
  for (let m = re.exec(SERVER); m !== null; m = re.exec(SERVER)) {
    starts.push({ key: `${m[1]} ${m[2]}`, at: m.index })
  }
  const all = [...SERVER.matchAll(/define\('[A-Z]+', '[^']+'/g)].map((m) => m.index ?? 0)
  for (const s of starts) {
    const next = all.find((i) => i > s.at) ?? SERVER.length
    out.push({ key: s.key, wrapped: SERVER.slice(s.at, next).includes('withIdempotentRoute') })
  }
  return out
}

test('every mutating route replays a retry, or says why it need not', () => {
  const unexplained = mutatingRoutes()
    .filter((r) => !r.wrapped && !(r.key in EXEMPT))
    .map((r) => r.key)
  assert.deepEqual(
    unexplained,
    [],
    `these mutating routes neither wrap withIdempotentRoute nor appear in EXEMPT:\n  ${unexplained.join('\n  ')}\n` +
      'A retried request must not create a second artefact. Wrap it, or add it to EXEMPT with the reason it is safe.',
  )
})

test('the routes that create an artefact are all wrapped', () => {
  const byKey = new Map(mutatingRoutes().map((r) => [r.key, r.wrapped]))
  for (const route of [
    'POST /v1/communities',
    'POST /v1/communities/:id/members',
    'POST /v1/communities/:id/roles',
    'POST /v1/communities/:id/treasury-accounts',
    'POST /v1/communities/:id/proposals',
    'POST /v1/communities/:id/delegations',
    'POST /v1/proposals/:id/posts',
    'POST /v1/proposals/:id/votes',
  ]) {
    assert.equal(byKey.get(route), true, `${route} creates an artefact and does not replay a retry`)
  }
})

test('the checker sees the routes at all', () => {
  // An empty list passes the first test vacuously. This is the line that stops that.
  const routes = mutatingRoutes()
  assert.ok(routes.length >= 12, `expected the server to have many mutating routes, found ${routes.length}`)
  assert.ok(routes.some((r) => r.wrapped), 'no route was detected as wrapped — the detector is broken')
  assert.ok(routes.some((r) => !r.wrapped), 'every route is wrapped — the detector may be matching everything')
})

test('no exemption is stale', () => {
  // An exemption for a route that no longer exists is a claim nobody is checking, and it hides the
  // day that route comes back without a wrapper.
  const keys = new Set(mutatingRoutes().map((r) => r.key))
  for (const k of Object.keys(EXEMPT)) {
    assert.ok(keys.has(k), `EXEMPT names ${k}, which is not a route on this server any more`)
  }
})

test('the execute route is exempt for a stated reason, not by omission', () => {
  // The one exemption worth naming here, because it is the route that spends money. It is safe
  // without a client key because four independent mechanisms already make it exactly-once
  // (executions.ts), and `executions.test.ts` proves each of them. A client key would be a fifth.
  assert.ok('POST /internal/proposals/:id/execute' in EXEMPT)
  assert.match(EXEMPT['POST /internal/proposals/:id/execute']!, /executions_proposal_uniq/)
})

test('every idempotent route is namespaced by the principal', () => {
  // Two members of one community independently choosing `vote-1` is not hypothetical. Namespaced by
  // service alone, the second would be answered with the first's response — on the vote route, being
  // told your vote was recorded when what was recorded was somebody else's.
  const calls = [...SERVER.matchAll(/withIdempotentRoute\(\s*ctx,\s*deps,\s*'([^']+)',\s*([A-Za-z.]+)/g)]
  assert.ok(calls.length >= 8, `only ${calls.length} withIdempotentRoute calls found`)
  for (const call of calls) {
    assert.match(
      call[2] ?? '',
      /^caller\.subject$/,
      `${call[1]} namespaces its idempotency key by ${call[2]} rather than by the caller`,
    )
  }
})
