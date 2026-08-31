/**
 * The HTTP surface: health, authorisation, and the four routes beside the dashboard.
 *
 * The authorisation cases here are the ones that would be worst to get wrong. This service can
 * read a user's portfolio, wallets, security state, entitlements and activity in one call — an
 * authority larger than any of the seven upstreams grants on its own, assembled here and nowhere
 * else. So the tests below are about who is refused rather than who is served.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { Lifecycle, type Probe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics } from '@cloudsforge/telemetry'
import { Verifier } from '@cloudsforge/auth'
import { TtlCache } from './cache.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import {
  ISSUER,
  OTHER_USER_ID,
  USER_ID,
  get,
  signService,
  signUser,
  startEstate,
  estateEnv,
  testVerifier,
  withHub,
} from './testsupport.ts'
import { httpUpstreams } from './upstreams.ts'

/* ------------------------------------------------------------------ health */

const failingProbe = (name: string, kind: 'hard' | 'soft'): Probe => ({
  name,
  kind,
  check: async () => ({ state: 'fail', detail: 'connection refused' }),
})

test('livez is static and stays 200 while the service is unready', async () => {
  // Liveness answers "should this process be restarted". For a service whose whole job is calling
  // seven peers, a liveness probe that consulted one would be a restart loop driven by somebody
  // else's deploy.
  const estate = await startEstate()
  const env = estateEnv(estate)
  const lifecycle = new Lifecycle({ cacheMs: 0 })
  lifecycle.addProbe(failingProbe('ledger', 'soft'))
  const metrics = registerServiceMetrics(registerHttpMetrics(new Metrics()))
  const upstreams = httpUpstreams({ env, metrics })
  const server = createServer({
    lifecycle,
    logger: new Logger({ service: 'test', sink: () => {} }),
    metrics,
    verifier: testVerifier(),
    upstreamsFor: upstreams,
    upstreams: upstreams.for('mainnet'),
    singleNetwork: 'mainnet' as const,
    cache: new TtlCache(),
    dashboardDeadlineMs: env.dashboardDeadlineMs,
    poolApi: env.poolApi,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`

  try {
    const live = await fetch(`${base}/livez`)
    assert.equal(live.status, 200)
    assert.equal(((await live.json()) as { state: string }).state, 'starting')

    // A soft probe failing leaves the service ready but degraded: taking a whole product out of
    // rotation over an upstream it is designed to serve without would be a cascade, not a safety
    // measure. `starting` is why this is 503 — not the probe.
    const notReady = await fetch(`${base}/readyz`)
    assert.equal(notReady.status, 503)

    lifecycle.markReady()
    const ready = await fetch(`${base}/readyz`)
    assert.equal(ready.status, 200, 'a soft upstream failure must not remove this replica')
    const report = (await ready.json()) as { state: string; circuits: Record<string, string> }
    assert.equal(report.state, 'degraded')
    assert.equal(report.circuits['ledger'], 'closed', 'readyz reports breaker state for operators')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await estate.close()
  }
})

test('metrics render in Prometheus text', async () => {
  await withHub({}, async (h) => {
    const res = await fetch(`${h.url}/metrics`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/)
    const body = await res.text()
    assert.match(body, /# TYPE hub_tile_status_total counter/)
    assert.match(body, /# TYPE hub_dashboard_ms histogram/)
    assert.match(body, /# TYPE hub_upstream_ms histogram/)
    assert.match(body, /# TYPE hub_cache_hits_total counter/)
  })
})

test('an unknown path is 404 and carries the request id', async () => {
  await withHub({}, async (h) => {
    const res = await fetch(`${h.url}/v1/nope`, { headers: { 'x-request-id': 'abc-123' } })
    assert.equal(res.status, 404)
    assert.equal(res.headers.get('x-request-id'), 'abc-123')
    const body = (await res.json()) as { error: { requestId: string } }
    assert.equal(body.error.requestId, 'abc-123')
  })
})

test('a request id outside the safe charset is replaced rather than echoed', async () => {
  // An unvalidated value here is a log-forgery primitive and, echoed into a response header, an
  // injection one. Replaced rather than refused: the caller does not need a 400 over this.
  await withHub({}, async (h) => {
    for (const hostile of ['a b: 1', '<script>', 'x'.repeat(200)]) {
      const res = await fetch(`${h.url}/livez`, { headers: { 'x-request-id': hostile } })
      const echoed = res.headers.get('x-request-id') ?? ''
      assert.notEqual(echoed, hostile)
      assert.match(echoed, /^[A-Za-z0-9_-]{1,64}$/)
    }
  })
})

/* ------------------------------------------------------------------ deployment facts */

test('deployment reports the pool as present by default and needs no token', async () => {
  // Unauthenticated on purpose: the mining bar renders for a signed-out reader, so a reader who
  // cannot answer this question is a reader shown a control that leads nowhere.
  await withHub({}, async (h) => {
    const res = await fetch(`${h.url}/v1/deployment`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { poolApi: 'present' })
  })
})

test('an estate that runs no pool says so, and only that estate does', async () => {
  // This is the whole point of serving the fact from the API rather than from the web container:
  // under the combined view a reader on mainnet asks TESTNET's hub-api what testnet deploys, and
  // must be told `absent` even though the document they loaded came from an estate that has one.
  await withHub({ env: { poolApi: 'absent' } }, async (h) => {
    const res = await fetch(`${h.url}/v1/deployment`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { poolApi: 'absent' })
  })
})

/* ------------------------------------------------------------------ authorisation */

test('no token is 401', async () => {
  await withHub({}, async (h) => {
    const res = await fetch(`${h.url}/v1/dashboard`)
    assert.equal(res.status, 401)
  })
})

test('a service token is refused: there is no such thing as a service dashboard', async () => {
  await withHub({}, async (h) => {
    const res = await get(h, '/v1/dashboard', await signService())
    assert.equal(res.status, 403)
    const body = (await res.json()) as { error: { message: string } }
    assert.match(body.error.message, /user session/)
  })
})

test('a verifier that cannot reach its JWKS is 503, never 401', async () => {
  // Answering 401 here signs every user in the estate out because identity is having a bad minute.
  const estate = await startEstate()
  const env = estateEnv(estate)
  const metrics = registerServiceMetrics(registerHttpMetrics(new Metrics()))
  const lifecycle = new Lifecycle({ cacheMs: 0 })
  const upstreams = httpUpstreams({ env, metrics })
  const server = createServer({
    lifecycle,
    logger: new Logger({ service: 'test', sink: () => {} }),
    metrics,
    verifier: new Verifier({
      jwksUrl: 'http://down',
      issuer: ISSUER,
      keySet: (async () => {
        throw new Error('getaddrinfo EAI_AGAIN identity')
      }) as never,
    }),
    upstreamsFor: upstreams,
    upstreams: upstreams.for('mainnet'),
    singleNetwork: 'mainnet' as const,
    cache: new TtlCache(),
    dashboardDeadlineMs: env.dashboardDeadlineMs,
    poolApi: env.poolApi,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  lifecycle.markReady()
  const { port } = server.address() as AddressInfo

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/dashboard`, {
      headers: { authorization: `Bearer ${await signUser()}` },
    })
    assert.equal(res.status, 503)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await estate.close()
  }
})

test('a user cannot name another user', async () => {
  await withHub({}, async (h) => {
    const res = await get(h, `/v1/dashboard?userId=${OTHER_USER_ID}`)
    assert.equal(res.status, 403)
  })
})

test('an operator may name another user, and the security tile refuses to guess', async () => {
  // The operator's own token authenticates the operator. Forwarding it to `/auth/me` would return
  // the operator's MFA state and present it as the subject's — a wrong answer, confidently.
  await withHub({}, async (h) => {
    const admin = await signUser(USER_ID, ['player', 'admin'])
    const res = await get(h, `/v1/dashboard?userId=${OTHER_USER_ID}`, admin)
    assert.equal(res.status, 200)

    const body = (await res.json()) as {
      userId: string
      tiles: Record<string, { status: string; reason: string | null }>
    }
    assert.equal(body.userId, OTHER_USER_ID)
    assert.equal(body.tiles['security']?.status, 'unavailable')
    assert.match(body.tiles['security']?.reason ?? '', /no service-readable route/)
    // Everything reachable with a scoped service credential is still served.
    assert.equal(body.tiles['wallets']?.status, 'ok')
    assert.equal(body.tiles['portfolio']?.status, 'ok')
  })
})

/* ------------------------------------------------------------------ /v1/portfolio */

test('portfolio is never a bare number', async () => {
  await withHub({}, async (h) => {
    const res = await get(h, '/v1/portfolio')
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      portfolio: {
        status: string
        cached: boolean
        data: {
          totalUsd: string
          pricedAt: string
          pricingComplete: boolean
          allocation: { label: string; bps: number }[]
          holdings: { assetCode: string; allocationBps: number | null; reserved: string }[]
        }
      }
    }

    assert.equal(body.portfolio.status, 'ok')
    assert.equal(body.portfolio.data.pricedAt, '2026-07-30T14:20:00.000Z')
    assert.equal(body.portfolio.data.pricingComplete, true)

    // Sorted, direct-labelled bars — never a pie. §6 rule 6.
    assert.deepEqual(
      body.portfolio.data.allocation.map((row) => row.label),
      ['BTC', 'SHARD', 'EMBER'],
    )
    assert.ok(body.portfolio.data.allocation[0]!.bps > 9_000, 'BTC dominates this fixture')

    // Reserved is visible, because "why can I not spend it" is the question it answers.
    const ember = body.portfolio.data.holdings.find((holding) => holding.assetCode === 'EMBER')
    assert.equal(ember?.reserved, '1000000000000000000')
  })
})

test('with pricing down the portfolio still lists holdings, degraded and unpriced', async () => {
  await withHub({}, async (h) => {
    await h.estate.services.pricing.kill()
    const res = await get(h, '/v1/portfolio')
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      portfolio: {
        status: string
        reason: string
        data: { holdings: { assetCode: string; usd: string | null; priceReason: string | null }[] }
      }
    }
    assert.equal(body.portfolio.status, 'degraded')
    const btc = body.portfolio.data.holdings.find((holding) => holding.assetCode === 'BTC')
    assert.equal(btc?.usd, null)
    assert.equal(btc?.priceReason, 'no quote available')
    // Shards are fixed by contract at 100 per USD, so they keep their value through a price outage.
    const shard = body.portfolio.data.holdings.find((holding) => holding.assetCode === 'SHARD')
    assert.equal(shard?.usd, '1248')
  })
})

test('with the ledger down the portfolio is a hole, not an empty portfolio', async () => {
  // An empty portfolio is indistinguishable from a user who owns nothing, which is a far worse
  // lie than a missing number.
  await withHub({}, async (h) => {
    await h.estate.services.ledger.kill()
    const body = (await (await get(h, '/v1/portfolio')).json()) as {
      portfolio: { status: string; reason: string; data: { holdings: unknown[] } }
    }
    assert.equal(body.portfolio.status, 'unavailable')
    assert.ok(body.portfolio.reason.length > 0)
    assert.deepEqual(body.portfolio.data.holdings, [])
  })
})

/* ------------------------------------------------------------------ /v1/activity */

test('activity is a pass-through and the cursor survives it', async () => {
  await withHub({}, async (h) => {
    const first = (await (await get(h, '/v1/activity?limit=1')).json()) as {
      records: { id: string }[]
      nextCursor: string | null
      status: string
    }
    assert.equal(first.status, 'ok')
    assert.equal(first.records.length, 1)
    assert.equal(first.records[0]?.id, 'r1')
    assert.equal(first.nextCursor, 'r1', 'the cursor is activity own, forwarded verbatim')

    const second = (await (
      await get(h, `/v1/activity?limit=1&cursor=${first.nextCursor}`)
    ).json()) as { records: { id: string }[]; nextCursor: string | null }
    assert.equal(second.records[0]?.id, 'r2')
    // Activity omits the key on the last page; this service normalises it to null so a client
    // does not have to handle two spellings of "no more".
    assert.equal(second.nextCursor, null)
  })
})

test('a bad limit is 400 rather than an unbounded upstream query', async () => {
  await withHub({}, async (h) => {
    assert.equal((await get(h, '/v1/activity?limit=0')).status, 400)
    assert.equal((await get(h, '/v1/activity?limit=5000')).status, 400)
  })
})

test('activity down is a 200 with an empty page and a reason', async () => {
  await withHub({}, async (h) => {
    await h.estate.services.activity.kill()
    const res = await get(h, '/v1/activity')
    assert.equal(res.status, 200)
    const body = (await res.json()) as { records: unknown[]; status: string; reason: string }
    assert.equal(body.status, 'unavailable')
    assert.deepEqual(body.records, [])
    assert.ok(body.reason.length > 0)
  })
})

/* ------------------------------------------------------------------ /v1/search */

test('search spans wallets, transactions, tokens and activity', async () => {
  await withHub({}, async (h) => {
    const body = (await (await get(h, '/v1/search?q=ember')).json()) as {
      total: number
      groups: Record<string, { status: string; data: { results: { kind: string; href: string }[] } }>
    }
    assert.ok(body.total > 0)
    assert.ok(body.groups['wallets']!.data.results.some((r) => r.kind === 'wallet'))
    assert.ok(body.groups['transactions']!.data.results.some((r) => r.kind === 'transaction'))
    assert.ok(body.groups['tokens']!.data.results.some((r) => r.kind === 'token'))
    assert.ok(body.groups['activity']!.data.results.some((r) => r.kind === 'activity'))
    for (const group of Object.values(body.groups)) assert.equal(group.status, 'ok')
  })
})

test('search matches an address exactly and does not guess', async () => {
  await withHub({}, async (h) => {
    const hit = (await (await get(h, '/v1/search?q=0x8a0000')).json()) as {
      groups: { wallets: { data: { results: { id: string }[] } } }
    }
    assert.equal(hit.groups.wallets.data.results[0]?.id, 'w2')

    // One character wrong is no result, not a plausible wrong wallet — the next thing a user does
    // with a search result is paste it into a withdrawal form.
    const miss = (await (await get(h, '/v1/search?q=0x8b0000')).json()) as { total: number }
    assert.equal(miss.total, 0)
  })
})

test('search degrades per group', async () => {
  await withHub({}, async (h) => {
    await h.estate.services.wallet.kill()
    const res = await get(h, '/v1/search?q=ember')
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      degraded: string[]
      groups: Record<string, { status: string }>
    }
    assert.equal(body.groups['wallets']?.status, 'unavailable')
    assert.equal(body.groups['transactions']?.status, 'unavailable')
    assert.equal(body.groups['activity']?.status, 'ok')
    assert.equal(body.groups['tokens']?.status, 'ok')
    assert.deepEqual(body.degraded.sort(), ['transactions', 'wallets'])
  })
})

test('an empty or oversized query is refused', async () => {
  await withHub({}, async (h) => {
    assert.equal((await get(h, '/v1/search?q=%20%20')).status, 400)
    assert.equal((await get(h, `/v1/search?q=${'a'.repeat(200)}`)).status, 400)
  })
})

/* ------------------------------------------------------------------ /v1/next-actions */

test('next-actions serves the same cards as the dashboard', async () => {
  await withHub({}, async (h) => {
    const body = (await (await get(h, '/v1/next-actions')).json()) as {
      actions: { kind: string; severity: string }[]
      missing: unknown[]
    }
    const kinds = body.actions.map((action) => action.kind)
    assert.deepEqual(
      kinds,
      [
        'account_frozen:f1'.split(':')[0],
        'withdrawal_stuck',
        'mfa_disabled',
        'subscription_past_due',
        'deposit_confirming',
      ],
      'critical first, then warning, then info, and stable within each',
    )
    assert.deepEqual(body.missing, [])
  })
})

test('next-actions loses only the cards whose source is down', async () => {
  await withHub({}, async (h) => {
    await h.estate.services.wallet.kill()
    const res = await get(h, '/v1/next-actions')
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      actions: { kind: string }[]
      missing: { source: string }[]
    }
    const kinds = body.actions.map((action) => action.kind)
    assert.ok(!kinds.includes('deposit_confirming'))
    assert.ok(!kinds.includes('withdrawal_stuck'))
    assert.ok(kinds.includes('mfa_disabled'))
    assert.ok(kinds.includes('account_frozen'))
    assert.deepEqual([...new Set(body.missing.map((m) => m.source))], ['wallet'])
  })
})
