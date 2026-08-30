/**
 * The ledger, policy and indexer clients — asserted on the REQUEST, never on the response.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE GAP 18-build-status.md §3.3 NAMES, AND IT HAS COST THE ESTATE THREE DEFECTS.**
 *
 * "Every existing test stubbed fetch and asserted behaviour given a reply" — so `micro-wallet`
 * calling `GET /v1/quotes` at a pricing service serving `GET /rates`, and `micro-market` calling
 * `POST /v1/decisions/market.listing` at a policy service with no `/v1` routes at all, were both
 * green in their own suites and broken in production. The second closed the entire marketplace:
 * every listing returned 403, because a 404 landed on the `deny` branch.
 *
 * So every test below asserts what goes OUT — the path, the action name, the subject grammar, the
 * body shape, the amount crossing as a decimal string. The upstream's real route table and real
 * closed sets are copied in as literals with a `path:line` citation, because rule 2 forbids
 * importing another service's source and a check that imported it would not be a contract test
 * anyway.
 *
 * **The literals below were read from the sibling repositories, not remembered.** Where one
 * contradicted a claim in the docs, the finding is recorded in the test that proves it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LedgerRefusedError,
  LedgerUnavailableError,
  httpLedgerClient,
  idempotencyKeys,
  spendPostings,
  LEDGER_SCOPES,
} from './ledgerclient.ts'
import {
  POLICY_SCOPES,
  PolicyUnavailableError,
  SPEND_ACTION,
  SPEND_SUBJECT,
  httpPolicyClient,
  spendResourceUrn,
} from './policyclient.ts'
import {
  HTTP_HOLDINGS_ROUTE,
  INDEXER_SCOPES,
  chainAddressOf,
  indexerChainFor,
  indexerOracle,
  unavailableOracle,
} from './gating.ts'

/* ------------------------------------------------------------------ the recorder */

interface Captured {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

function recorder(reply: { status: number; body: unknown }): {
  fetch: typeof globalThis.fetch
  calls: Captured[]
} {
  const calls: Captured[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : '{}'
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(raw) as Record<string, unknown>,
    })
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { fetch: fetchImpl, calls }
}

/* ------------------------------------------------------------------ the ledger */

/**
 * `micro-ledger`'s real route table, read from `ledger/src/server.ts`.
 *
 * There is no `/v1` prefix anywhere in it. `micro-wallet`'s `GET /v1/quotes` against a pricing
 * service serving `GET /rates` is the recorded cost of assuming otherwise.
 */
const LEDGER_ROUTES: readonly string[] = Object.freeze([
  'GET /livez',
  'GET /readyz',
  'GET /metrics',
  'POST /entries',
  'GET /entries',
  'GET /entries/:id',
  'POST /entries/:id/reverse',
  'POST /reservations',
  'POST /reservations/:id/release',
  'GET /accounts/:subject/balances',
  'GET /trial-balance',
  'GET /reconciliation',
])

test('the ledger client posts to a route the ledger actually serves', async () => {
  const { fetch, calls } = recorder({
    status: 201,
    body: { entry: { id: 'e1', kind: 'treasury_spend', recordedAt: '2026-08-01T00:00:00Z' }, replayed: false },
  })
  const client = httpLedgerClient({
    baseUrl: 'http://ledger:4000',
    token: () => 'tok',
    deadlineMs: 5_000,
    originatingService: 'community',
    fetch,
  })
  await client.postEntry({
    kind: 'treasury_spend',
    actor: 'service:community',
    correlationId: 'c1',
    idempotencyKey: 'community:execute:p1',
    postings: spendPostings({
      treasurySubject: 'community:c1',
      recipientSubject: 'user:u1',
      assetCode: 'EMBER',
      amount: 42n,
    }),
  })

  const call = calls[0]!
  const path = new URL(call.url).pathname
  assert.equal(`${call.method} ${path}`, 'POST /entries')
  assert.ok(
    LEDGER_ROUTES.includes(`${call.method} ${path}`),
    `${call.method} ${path} is not a route micro-ledger serves (ledger/src/server.ts:324-528)`,
  )
  // Not /v1. Asserted separately so the failure names the specific mistake.
  assert.ok(!path.startsWith('/v1'), 'micro-ledger serves no /v1 prefix')
})

test('the ledger request carries the shape ledger/src/server.ts:646 parses', async () => {
  const { fetch, calls } = recorder({
    status: 201,
    body: { entry: { id: 'e1', kind: 'treasury_spend', recordedAt: '2026-08-01T00:00:00Z' }, replayed: false },
  })
  const client = httpLedgerClient({
    baseUrl: 'http://ledger:4000',
    token: () => 'tok',
    deadlineMs: 5_000,
    originatingService: 'community',
    fetch,
  })
  const huge = 2n ** 90n
  await client.postEntry({
    kind: 'treasury_spend',
    actor: 'service:community',
    correlationId: 'c1',
    idempotencyKey: 'community:execute:p1',
    description: 'a spend',
    postings: spendPostings({
      treasurySubject: 'community:c1',
      recipientSubject: 'user:u1',
      assetCode: 'EMBER',
      amount: huge,
    }),
  })

  const body = calls[0]!.body
  // `parsePostEntry` requires these by name.
  assert.equal(body['kind'], 'treasury_spend')
  assert.equal(body['originatingService'], 'community')
  assert.equal(body['actor'], 'service:community')
  assert.equal(body['idempotencyKey'], 'community:execute:p1')
  assert.equal(body['correlationId'], 'c1')

  const postings = body['postings'] as Array<Record<string, unknown>>
  assert.equal(postings.length, 2)
  for (const posting of postings) {
    // ══════════════════════════════════════════════════════════════════════════════════════
    // A DECIMAL STRING, both directions. A JSON number is an IEEE 754 double, and 2^90 does not
    // survive one — it does not fail either, it comes back subtly wrong. This assertion is the
    // reason the amount is `.toString()`ed rather than passed through.
    // ══════════════════════════════════════════════════════════════════════════════════════
    assert.equal(typeof posting['amount'], 'string', 'an amount crossed as a JSON number')
    assert.ok(['debit', 'credit'].includes(posting['direction'] as string))
    assert.equal(typeof posting['sequence'], 'number')
    const account = posting['account'] as Record<string, unknown>
    for (const field of ['subject', 'assetCode', 'purpose', 'type']) {
      assert.ok(field in account, `the account is missing ${field}`)
    }
  }
  assert.equal(postings[0]!['amount'], huge.toString())
  assert.equal(BigInt(postings[0]!['amount'] as string), huge, 'the amount did not survive the wire')
})

test('the idempotency key is on the request as well as in the body', async () => {
  const { fetch, calls } = recorder({
    status: 201,
    body: { entry: { id: 'e1', kind: 'treasury_spend', recordedAt: 'now' }, replayed: false },
  })
  const client = httpLedgerClient({
    baseUrl: 'http://ledger:4000',
    token: () => 'tok',
    deadlineMs: 5_000,
    originatingService: 'community',
    fetch,
  })
  await client.postEntry({
    kind: 'treasury_spend',
    actor: 'service:community',
    correlationId: 'c1',
    idempotencyKey: 'community:execute:p1',
    postings: spendPostings({
      treasurySubject: 'community:c1',
      recipientSubject: 'user:u1',
      assetCode: 'EMBER',
      amount: 1n,
    }),
  })
  // In the body it is what the ledger dedupes on; on the request it is what makes `HttpClient`
  // willing to retry a POST at all.
  const headers = calls[0]!.headers
  assert.equal(headers['idempotency-key'], 'community:execute:p1')
})

test('the spend is two balanced liability legs and nothing else', () => {
  const postings = spendPostings({
    treasurySubject: 'community:c1',
    recipientSubject: 'user:u1',
    assetCode: 'EMBER',
    amount: 1_000n,
  })
  assert.equal(postings.length, 2, 'a treasury spend grew a third leg — a fee needs its own entry')
  const debit = postings.find((p) => p.direction === 'debit')!
  const credit = postings.find((p) => p.direction === 'credit')!
  assert.equal(debit.account.subject, 'community:c1')
  assert.equal(debit.account.purpose, 'treasury')
  assert.equal(credit.account.subject, 'user:u1')
  assert.equal(credit.account.purpose, 'available')
  // Both liabilities: before the entry the platform owes the community, after it owes the
  // recipient. Nothing is created and nothing destroyed, so the entry balances by construction.
  assert.equal(debit.account.type, 'liability')
  assert.equal(credit.account.type, 'liability')
  assert.equal(debit.amount, credit.amount)
})

test('a zero or negative spend never becomes postings', () => {
  for (const amount of [0n, -1n]) {
    assert.throws(
      () =>
        spendPostings({
          treasurySubject: 'community:c1',
          recipientSubject: 'user:u1',
          assetCode: 'EMBER',
          amount,
        }),
      RangeError,
    )
  }
})

test('the idempotency key is derived from the proposal, not from the execution', () => {
  // The proposal id exists long before the money moves. A key derived from the execution row the
  // transaction is about to create would be regenerated by a retry and pay a second time.
  assert.equal(idempotencyKeys.execute('p1'), 'community:execute:p1')
  assert.notEqual(idempotencyKeys.execute('p1'), idempotencyKeys.execute('p2'))
})

test('a 4xx from the ledger is a decision; anything else is unknown', async () => {
  const refused = recorder({ status: 402, body: { error: { code: 'insufficient_balance', message: 'no' } } })
  const client = httpLedgerClient({
    baseUrl: 'http://ledger:4000',
    token: () => 'tok',
    deadlineMs: 5_000,
    originatingService: 'community',
    fetch: refused.fetch,
  })
  const request = {
    kind: 'treasury_spend' as const,
    actor: 'service:community' as const,
    correlationId: 'c',
    idempotencyKey: 'k',
    postings: spendPostings({
      treasurySubject: 'community:c1',
      recipientSubject: 'user:u1',
      assetCode: 'EMBER',
      amount: 1n,
    }),
  }
  await assert.rejects(() => client.postEntry(request), (err: unknown) => {
    assert.ok(err instanceof LedgerRefusedError)
    assert.equal(err.status, 402)
    assert.equal(err.code, 'insufficient_balance')
    return true
  })

  const broken = recorder({ status: 503, body: {} })
  const other = httpLedgerClient({
    baseUrl: 'http://ledger:4000',
    token: () => 'tok',
    deadlineMs: 5_000,
    originatingService: 'community',
    fetch: broken.fetch,
  })
  // We do not know whether the entry posted. The only safe answer is retry with the same key.
  await assert.rejects(() => other.postEntry(request), LedgerUnavailableError)
})

test('the ledger scope asked for is exact and minimal', () => {
  assert.deepEqual([...LEDGER_SCOPES], ['ledger:post'])
  // Not `ledger:*`. See scopes.ts.
  assert.ok(!LEDGER_SCOPES.some((scope) => scope.includes('*')))
})

/* ------------------------------------------------------------------ policy */

/**
 * `micro-policy`'s real closed sets, read from source rather than from the dependency map.
 *
 * ACTION registry: `policy/src/actions.ts`. `parseRequestAction`
 * (`policy/src/server.ts`) answers **400** for anything not in it.
 *
 * SUBJECT grammar: `policy/src/server.ts`.
 */
const POLICY_ACTIONS: readonly string[] = Object.freeze([
  'custody.key.export',
  'wallet.withdrawal',
  'ledger.treasury_spend',
  'identity.session.new_device',
  'wallet.deposit_address.assign',
  'wallet.trusted_address.add',
  'market.listing.create',
  'trade.order.place',
  'mint.deploy.request',
  'identity.password.reset',
  'api.request',
])
const POLICY_SUBJECT_PATTERN = /^(?:system|(?:user|service|operator):[A-Za-z0-9._:-]{1,128})$/
const POLICY_DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/

test('there is no community.* action in policy, which is why the action is ledger.treasury_spend', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // A RECORDED FINDING, and the reason this client is shaped as it is.
  //
  // 07-dependency-map.md makes policy a hard, fail-closed dependency of this service for
  // "Treasury spend approval". Policy's action registry contains no `community.*` entry, and an
  // unregistered action is a deliberate 400. A client sending the obvious `community.treasury.spend`
  // would 400 on every spend — and with a fail-closed gate, NO COMMUNITY COULD EVER SPEND ITS
  // TREASURY, presenting as a passed vote that silently never executes.
  //
  // `ledger.treasury_spend` — "A spend from a platform treasury account rather than a user
  // account", failMode closed, policy/src/actions.ts — is the registered action for this
  // decision, and it is what this client sends.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  assert.ok(
    !POLICY_ACTIONS.some((action) => action.startsWith('community.')),
    'policy has grown a community.* action — this client should now use it, and the README updated',
  )
  assert.ok(
    POLICY_ACTIONS.includes(SPEND_ACTION),
    `${SPEND_ACTION} is not in policy's registry — every treasury spend would 400`,
  )
})

test('the subject sent to policy satisfies policy\'s own grammar', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE SECOND HALF OF THE SAME FINDING. `SUBJECT_PATTERN` at policy/src/server.ts has no
  // `community:` arm, so the subject a community treasury spend is actually ABOUT cannot be
  // expressed. `service:community` is what policy accepts, and the community travels in the
  // resource URN — which policy stores verbatim, so a decision row read months later says which
  // community and which proposal without a lookup table.
  //
  // What is lost is stated in the README and in policyclient.ts: per-subject velocity counters
  // count every community as one subject, so a per-community spend cap is not expressible until
  // policy grows the arm. micro-policy is not this repository's to change.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  assert.match(SPEND_SUBJECT, POLICY_SUBJECT_PATTERN)
  assert.ok(
    !POLICY_SUBJECT_PATTERN.test('community:0198f0a1-0000-7000-8000-000000000000'),
    'policy has grown a community: subject arm — this client should now use it',
  )
})

test('the policy request goes to POST /decisions with the amount as a decimal string', async () => {
  const { fetch, calls } = recorder({
    status: 201,
    body: { decision: { decision: 'allow', reasons: [] } },
  })
  const client = httpPolicyClient({
    baseUrl: 'http://policy:4000',
    token: () => 'tok',
    deadlineMs: 3_000,
    fetch,
  })
  await client.evaluateSpend({
    communityId: 'c1',
    proposalId: 'p1',
    amount: '1000000',
    assetCode: 'EMBER',
    recipientSubject: 'user:u1',
    correlationId: 'corr',
  })

  const call = calls[0]!
  const path = new URL(call.url).pathname
  // NOT `/v1/decisions/<action>`. Policy has no /v1 routes at all; the action is in the BODY.
  // micro-market's version of this line closed the entire marketplace.
  assert.equal(`${call.method} ${path}`, 'POST /decisions')

  assert.equal(call.body['action'], SPEND_ACTION)
  assert.equal(call.body['subject'], SPEND_SUBJECT)
  assert.equal(call.body['resource'], spendResourceUrn('c1', 'p1'))
  const context = call.body['context'] as Record<string, unknown>
  // Policy rejects a JSON number outright rather than coercing it — a threshold comparison on a
  // float is the bug that service exists not to have.
  assert.equal(typeof context['amount'], 'string')
  assert.match(context['amount'] as string, POLICY_DECIMAL_PATTERN)
  assert.equal(context['asset'], 'EMBER')
})

test('an unreachable policy service throws rather than returning a verdict', async () => {
  // There is no fail-open branch here for a degraded verdict to feed, and the type system should
  // not offer the caller one. See policyclient.ts.
  const { fetch } = recorder({ status: 503, body: {} })
  const client = httpPolicyClient({ baseUrl: 'http://policy:4000', token: () => 't', deadlineMs: 100, fetch })
  await assert.rejects(
    () =>
      client.evaluateSpend({
        communityId: 'c1',
        proposalId: 'p1',
        amount: '1',
        assetCode: 'EMBER',
        recipientSubject: 'user:u1',
        correlationId: 'c',
      }),
    PolicyUnavailableError,
  )
})

test('a 404 is our misconfiguration, not a decision — and is still fatal', async () => {
  // 18-build-status.md §3.3: a route that does not exist says nothing about this spend. It must not
  // become a `deny` recorded against the community, which would read to its members as the platform
  // refusing their vote — but fail-closed means an unanswered question still stops the spend.
  const { fetch } = recorder({ status: 404, body: {} })
  const client = httpPolicyClient({ baseUrl: 'http://policy:4000', token: () => 't', deadlineMs: 100, fetch })
  await assert.rejects(
    () =>
      client.evaluateSpend({
        communityId: 'c1',
        proposalId: 'p1',
        amount: '1',
        assetCode: 'EMBER',
        recipientSubject: 'user:u1',
        correlationId: 'c',
      }),
    PolicyUnavailableError,
  )
})

test('a 400 from policy is a refusal that names the status', async () => {
  const { fetch } = recorder({ status: 400, body: { error: { code: 'bad', message: 'no' } } })
  const client = httpPolicyClient({ baseUrl: 'http://policy:4000', token: () => 't', deadlineMs: 100, fetch })
  const verdict = await client.evaluateSpend({
    communityId: 'c1',
    proposalId: 'p1',
    amount: '1',
    assetCode: 'EMBER',
    recipientSubject: 'user:u1',
    correlationId: 'c',
  })
  // A refusal rather than an exception, and the reason preserved so an operator can tell a rejected
  // spend from a rejected request.
  assert.equal(verdict.decision, 'deny')
  assert.deepEqual([...verdict.reasons], ['policy_400'])
})

test('an unreadable 201 is not an allow', async () => {
  // Treating an unparseable success as permission would make a response-shape change silently open
  // the only fail-closed control this service has.
  const { fetch } = recorder({ status: 201, body: { decision: { decision: 'maybe' } } })
  const client = httpPolicyClient({ baseUrl: 'http://policy:4000', token: () => 't', deadlineMs: 100, fetch })
  await assert.rejects(
    () =>
      client.evaluateSpend({
        communityId: 'c1',
        proposalId: 'p1',
        amount: '1',
        assetCode: 'EMBER',
        recipientSubject: 'user:u1',
        correlationId: 'c',
      }),
    PolicyUnavailableError,
  )
})

test('the policy scope matches what policy requires', () => {
  // `policy/src/server.ts` — `DECIDE_SCOPE = 'policy:decide'`. `micro-market`'s client declared
  // `policy:evaluate`, which is not a scope policy knows.
  assert.deepEqual([...POLICY_SCOPES], ['policy:decide'])
})


/* ------------------------------------------------------------------ the indexer */

/**
 * `micro-indexer`'s real route table, read from `indexer/src/server.ts` and mounted under both
 * `/v1` and bare by `PREFIXES`.
 *
 * **The balance route is on this list now.** It was not when this file was written, and the test
 * below has been turned round: it used to assert the absence and carry a note saying what to do
 * when it appeared. It appeared (18-build-status.md §3.3j), so the note is spent and the assertion
 * is the opposite one — that the route this service calls is one the indexer really serves.
 */
const INDEXER_ROUTES: readonly string[] = Object.freeze([
  'GET /chains/:chain/:network/status',
  'GET /addresses/:chain/:network/:address/activity',
  'GET /addresses/:chain/:network/:address/token-balances',
  'GET /transactions/:chain/:network/:hash',
  'GET /transactions/:chain/:network/:hash/confirmations',
  'GET /blocks/:chain/:network/:height',
  'POST /watch/:chain/:network/:address',
  'POST /backfills/:chain/:network',
])

/** A real 20-byte address. The oracle refuses anything else before it makes a request. */
const HOLDER = `0x${'d'.repeat(40)}`

test('the holdings route this service needs is one micro-indexer serves', () => {
  assert.ok(
    INDEXER_ROUTES.includes(`GET ${HTTP_HOLDINGS_ROUTE}`),
    `micro-indexer does not serve ${HTTP_HOLDINGS_ROUTE} — the gate cannot run, and gating.ts must say so`,
  )
  // Still the indexer's conventions rather than something spelled here: `:chain/:network/:address`.
  assert.match(HTTP_HOLDINGS_ROUTE, /^\/addresses\/:chain\/:network\/:address\//)
  assert.deepEqual([...INDEXER_SCOPES], ['indexer:read'])
})

test('the unavailable oracle answers unknown, never zero', async () => {
  // Zero demotes. A service whose default configuration silently evicts every token-gated member is
  // not a service that should ship, and `INDEXER_BASE_URL` unset is a supported mode.
  const oracle = unavailableOracle()
  assert.equal(await oracle.holdingAt(7411, '0xabc', `user:${HOLDER}`, null), null)
})

test('a chain id lands on the slug the indexer puts in a path, from the pinned contract', () => {
  // The one mapping `@cloudsforge/contracts-chain` is here for. Restating it locally is how a
  // community gated on Hearth MAINNET gets re-checked against Hearth TESTNET, which is the same
  // class of defect as XRP sharing one address across both networks.
  assert.equal(indexerChainFor(7411, 'mainnet'), 'ember')
  assert.equal(indexerChainFor(7412, 'testnet'), 'ember')
  assert.equal(indexerChainFor(1, 'mainnet'), 'eth')
  // Right number, wrong network. Not a match, and emphatically not "close enough".
  assert.equal(indexerChainFor(7411, 'testnet'), null)
  assert.equal(indexerChainFor(999_999, 'mainnet'), null)
  assert.equal(indexerChainFor(7411, 'devnet'), null)
})

test('the oracle asks the indexer for the chain by slug, at the block it was given', async () => {
  const huge = 2n ** 200n
  const { fetch, calls } = recorder({ status: 200, body: { balance: huge.toString() } })
  const oracle = indexerOracle({
    baseUrl: 'http://indexer:4000',
    token: () => 't',
    deadlineMs: 100,
    network: 'testnet',
    fetch,
  })
  // 7412 is EMBER on testnet. The indexer's segment is the slug, never the number.
  const holding = await oracle.holdingAt(7412, '0xabc', `user:${HOLDER}`, 99n)
  assert.equal(holding?.balance, huge, 'a uint256 survives as a bigint, exactly')

  const url = new URL(calls[0]!.url)
  assert.equal(url.pathname, `/addresses/ember/testnet/${HOLDER}/token-balances`)
  assert.equal(url.searchParams.get('contract'), '0xabc')
  // The snapshot block 07-dependency-map.md asks for, spelled as the indexer's `block` param.
  assert.equal(url.searchParams.get('block'), '99')
})

test('a chain the estate does not index is unknown, and costs no request', async () => {
  const { fetch, calls } = recorder({ status: 200, body: { balance: '1' } })
  const oracle = indexerOracle({
    baseUrl: 'http://indexer:4000',
    token: () => 't',
    deadlineMs: 100,
    network: 'mainnet',
    fetch,
  })
  assert.equal(await oracle.holdingAt(424_242, '0xabc', `user:${HOLDER}`, null), null)
  assert.equal(calls.length, 0, 'a question the indexer cannot answer is not worth asking')
})

test('a subject with no chain address behind it is unknown, and costs no request', async () => {
  // THE GAP THAT REMAINS, PINNED. A membership subject is `user:<userId>` and this service holds no
  // address for a member — that mapping is `micro-wallet`'s and 07's dependency table gives this
  // service no edge to it. Posting a user id to a chain indexer as an address would spend one 400
  // per member per cycle and name nothing; `unknown` never demotes, and the metric says so.
  const { fetch, calls } = recorder({ status: 200, body: { balance: '1' } })
  const oracle = indexerOracle({
    baseUrl: 'http://indexer:4000',
    token: () => 't',
    deadlineMs: 100,
    network: 'mainnet',
    fetch,
  })
  assert.equal(await oracle.holdingAt(7411, '0xabc', 'user:01J0ABCDEF', null), null)
  assert.equal(calls.length, 0)
  assert.equal(chainAddressOf('user:01J0ABCDEF'), null)
  // And an EIP-55 checksummed address is normalised rather than refused — every wallet displays
  // that form, and the indexer stores addresses lowercased.
  assert.equal(chainAddressOf(`user:0x${'D'.repeat(40)}`), `0x${'d'.repeat(40)}`)
})

test('the indexer oracle answers unknown on any failure, including a 404', async () => {
  for (const status of [400, 404, 500, 503, 401]) {
    const { fetch, calls } = recorder({ status, body: {} })
    const oracle = indexerOracle({
      baseUrl: 'http://indexer:4000',
      token: () => 't',
      deadlineMs: 100,
      network: 'mainnet',
      fetch,
    })
    assert.equal(
      await oracle.holdingAt(7411, '0xabc', `user:${HOLDER}`, null),
      null,
      `a ${status} became something other than unknown`,
    )
    // At least one — the client retries some statuses. What matters is that the request WAS made,
    // so this is a test of the failure handling rather than of the two guards above it.
    assert.ok(calls.length >= 1, 'no request was made, so this assertion would be vacuous')
  }
})

test('the oracle refuses a balance that is not a decimal string', async () => {
  // A JSON number would not survive a uint256, so a number is treated as no answer rather than
  // parsed. Silently rounding a member's holding is how a gate evicts the wrong people.
  const { fetch } = recorder({ status: 200, body: { balance: 12345 } })
  const oracle = indexerOracle({
    baseUrl: 'http://indexer:4000',
    token: () => 't',
    deadlineMs: 100,
    network: 'mainnet',
    fetch,
  })
  assert.equal(await oracle.holdingAt(7411, '0xabc', `user:${HOLDER}`, null), null)
})

test('a 200 with no balance at all is unknown, which is how the indexer says it cannot vouch', async () => {
  // NOT a hypothetical shape. The indexer derives a balance by summing recorded movements, so it
  // OMITS the field whenever its canonical chain does not run unbroken from genesis to the asked
  // height — which an un-backfilled follower's never does. Absent must land as `unknown`, because
  // reading it as zero would evict every member of every token-gated community the first time a
  // fresh indexer was pointed at.
  for (const body of [{}, { balance: null }, { coverage: { complete: false } }]) {
    const { fetch } = recorder({ status: 200, body })
    const oracle = indexerOracle({
      baseUrl: 'http://indexer:4000',
      token: () => 't',
      deadlineMs: 100,
      network: 'mainnet',
      fetch,
    })
    assert.equal(
      await oracle.holdingAt(7411, '0xabc', `user:${HOLDER}`, null),
      null,
      JSON.stringify(body),
    )
  }
})
