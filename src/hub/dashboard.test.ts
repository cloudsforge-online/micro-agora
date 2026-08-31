/**
 * The degradation suite. This is the exit criterion, not a nicety.
 *
 * Eight tests, one per upstream, each killing exactly one peer and asserting three things:
 *
 *   1. the response is **200**, never a 500 and never a 503;
 *   2. every tile fed by the dead peer says so, with a reason;
 *   3. **every other tile is still `ok`** — which is the half that catches regressions, because
 *      it fails the moment somebody adds a convenient extra upstream call inside a loader.
 *
 * The upstreams are real HTTP listeners that get closed, so what is being exercised is a refused
 * connection through the real `HttpClient`, not a stubbed rejection. Nothing here needs a service
 * running or a database.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { TILE_SOURCES } from './dashboard.ts'
import { UPSTREAM_NAMES, get, withHub, type UpstreamName } from './testsupport.ts'

interface WireTile {
  readonly status: 'ok' | 'degraded' | 'unavailable'
  readonly upstream: string
  readonly reason: string | null
  readonly cached: boolean
  readonly ageMs: number | null
  readonly data: unknown
}

interface WireDashboard {
  readonly userId: string
  readonly generatedAt: string
  readonly elapsedMs: number
  readonly tiles: Record<string, WireTile>
  readonly nextActions: {
    readonly actions: readonly { readonly kind: string; readonly verb: string; readonly href: string }[]
    readonly missing: readonly { readonly source: string; readonly reason: string }[]
  }
  readonly degraded: readonly string[]
}

const tilesFedBy = (upstream: UpstreamName): string[] =>
  Object.entries(TILE_SOURCES)
    .filter(([, sources]) => (sources as readonly string[]).includes(upstream))
    .map(([tile]) => tile)

test('with every upstream healthy the dashboard is complete', async () => {
  await withHub({}, async (h) => {
    const res = await get(h, '/v1/dashboard')
    assert.equal(res.status, 200)
    const body = (await res.json()) as WireDashboard

    for (const [name, tile] of Object.entries(body.tiles)) {
      assert.equal(tile.status, 'ok', `${name} should be ok but was ${tile.status}: ${tile.reason}`)
      assert.equal(tile.reason, null, `${name} carried a reason while ok`)
    }
    // EMPTY, and this is the assertion the owner's bug report was actually about. `degraded` is
    // what hub-web turns into "<tiles> not showing current data. Everything else on this page is."
    // — so a permanently degraded tile is a permanent incident banner on every signed-in Overview.
    // This used to read `['notifications']` and was called a known hole; it was a false alarm
    // shipped to every user in the estate. See the header of `dashboard.ts`.
    assert.deepEqual(body.degraded, [])
  })
})

test('the portfolio carries its pricing timestamp, and it is the oldest observation', async () => {
  await withHub({}, async (h) => {
    const res = await get(h, '/v1/dashboard')
    const body = (await res.json()) as WireDashboard
    const portfolio = body.tiles['portfolio']?.data as {
      pricedAt: string
      totalUsd: string
      pricingComplete: boolean
      holdings: { assetCode: string; usd: string | null; allocationBps: number | null }[]
      allocation: { label: string }[]
    }

    // BTC was quoted at 14:20 and EMBER at 14:22. The total is as old as its oldest input, and
    // reporting 14:22 would overstate the confidence of the one number a user actually reads.
    assert.equal(portfolio.pricedAt, '2026-07-30T14:20:00.000Z')
    assert.equal(portfolio.pricingComplete, true)

    // 0.5 BTC at 60,000 + 4 EMBER at 2 + 124,800 Shards at 100 per USD = 30,000 + 8 + 1,248.
    assert.equal(portfolio.totalUsd, '31256')
    assert.equal(portfolio.holdings[0]?.assetCode, 'BTC', 'holdings must be sorted by value')
    assert.equal(portfolio.holdings.at(-1)?.assetCode, 'EMBER')
  })
})

test('wallet lifecycle state reaches the client', async () => {
  // §6 rule 3: `exported` and `external·verified` are facts a user must see at a glance, so they
  // must survive the composition rather than being flattened to "active".
  await withHub({}, async (h) => {
    const body = (await (await get(h, '/v1/dashboard')).json()) as WireDashboard
    const wallets = body.tiles['wallets']?.data as { id: string; status: string; origin: string }[]
    assert.equal(wallets.find((w) => w.id === 'w3')?.status, 'exported')
    assert.equal(wallets.find((w) => w.id === 'w2')?.origin, 'external')
  })
})

test('needs-you cards carry a verb and a deep link, one per source', async () => {
  await withHub({}, async (h) => {
    const body = (await (await get(h, '/v1/dashboard')).json()) as WireDashboard
    const kinds = body.nextActions.actions.map((a) => a.kind)

    assert.ok(kinds.includes('deposit_confirming'), 'a deposit at 41 confirmations must raise a card')
    assert.ok(kinds.includes('mfa_disabled'), 'no active factor must raise the 2FA card')
    assert.ok(kinds.includes('account_frozen'), 'an uncleared freeze must raise a card')
    assert.ok(kinds.includes('subscription_past_due'), 'a past-due subscription must raise a card')
    assert.ok(kinds.includes('withdrawal_stuck'), 'a stuck withdrawal must raise a card')

    for (const action of body.nextActions.actions) {
      assert.ok(action.verb.length > 0, `${action.kind} has no verb`)
      assert.ok(action.href.startsWith('/'), `${action.kind} has no deep link`)
    }
    // Critical first, so the frozen account and the stuck withdrawal lead.
    assert.equal(body.nextActions.missing.length, 0)
  })
})

test('a confirming deposit carries its progress against the contract depth', async () => {
  await withHub({}, async (h) => {
    const body = (await (await get(h, '/v1/dashboard')).json()) as WireDashboard
    const card = body.nextActions.actions.find((a) => a.kind === 'deposit_confirming') as unknown as {
      detail: string
      progress: { done: number; total: number; etaMinutes: number }
    }
    // 60 comes from `contracts-chain`, which is the same constant wallet, indexer and settlement
    // credit against. Re-deriving it here would be this service inventing a fact.
    assert.equal(card.detail, '41/60 confirmations')
    assert.equal(card.progress.total, 60)
    assert.equal(card.progress.done, 41)
  })
})

/* ------------------------------------------------------- notifications */

/**
 * The regression test for micro-org #415.
 *
 * For as long as this service has existed the `notifications` tile was a constant `unavailable`,
 * and because `degraded` is derived from the tiles, every signed-in Overview in the estate carried
 * "notifications is not showing current data. Everything else on this page is." Live on
 * 2026-08-11, `hub_tile_status_total{tile="notifications",status="unavailable"}` matched
 * `hub_dashboard_ms_count` exactly on both networks — 100% of compositions — while notify held 172
 * real notifications for 85 users on mainnet.
 *
 * Four assertions, and each of them fails on a different way of half-fixing it:
 *
 *   1. the tile is `ok` — the whole report;
 *   2. it carries the rows notify served, with the WORDS notify wrote, so a client never has to
 *      know what a template id is;
 *   3. `unread` is the inbox-wide count and not `items.filter(unread).length` — the fixture makes
 *      those two differ (12 against 2) precisely so a derived count cannot pass;
 *   4. a row whose deep link is a single-use credential arrives with `href: null` rather than
 *      being dropped or, far worse, linked to `/[redacted]`.
 */
test('the notifications tile is composed from notify, in notify’s own words', async () => {
  await withHub({}, async (h) => {
    const body = (await (await get(h, '/v1/dashboard')).json()) as WireDashboard
    const tile = body.tiles['notifications']

    assert.equal(tile?.status, 'ok', `notifications was ${tile?.status}: ${tile?.reason}`)
    assert.equal(tile?.upstream, 'notify')
    assert.ok(!body.degraded.includes('notifications'), 'a composed tile must not raise the banner')

    const data = tile?.data as {
      unread: number
      items: { id: string; title: string; href: string | null; templateId: string }[]
    }
    assert.equal(data.unread, 12, 'the badge is the whole inbox, not this page')
    assert.equal(data.items.length, 3)
    assert.equal(data.items[0]?.title, 'A new device signed in')
    assert.equal(data.items[0]?.href, '/settings/security/sessions')
    for (const item of data.items) {
      assert.ok(item.title.length > 0, `${item.id} reached the client without a sentence`)
      assert.ok(!item.title.includes('{{'), `${item.id} carried an unsubstituted placeholder`)
    }

    // The verification notification, whose path IS the credential notify redacts.
    const verify = data.items.find((i) => i.templateId === 'account.verify_email')
    assert.ok(verify, 'a row with no honest link must still be shown')
    assert.equal(verify.href, null)
    assert.ok(!JSON.stringify(data).includes('redacted]/'), 'a redacted value became a link')
  })
})

test('the notifications tile asks for a preview, not the whole inbox', async () => {
  // Five rows, matching `PAGE.notifications`. The dashboard is a summary with a link out; pulling
  // a full inbox through it would put notify's paging cost on every page load in the estate.
  await withHub({}, async (h) => {
    await get(h, '/v1/dashboard')
    assert.equal(h.estate.services.notify.lastQuery?.get('limit'), '5')
    assert.ok(h.estate.services.notify.lastQuery?.get('userId'), 'notify was asked for nobody')
  })
})

/* ------------------------------------------------------- the eight degradation tests */

for (const dead of UPSTREAM_NAMES) {
  test(`${dead} down costs its own tiles and nothing else`, async () => {
    await withHub({}, async (h) => {
      // MINT FIRST, THEN KILL — and only the token, not the tiles.
      //
      // Every peer client now obtains its bearer by exchanging a credential at identity, so a
      // replica that has never minted and then finds identity dead cannot call ANY peer. That is
      // inherent: you cannot authenticate to anyone while the thing that authenticates you is
      // down, and it is the same for every service in the estate.
      //
      // The property this test is about is the one that still holds and is the one that matters in
      // production: a token identity has ALREADY signed does not stop being valid because identity
      // went down, so a warm replica loses identity's own tiles and nothing else. Warming through
      // the providers rather than through a dashboard request is deliberate — a warm-up request
      // would populate the tile caches and the assertions below would pass on stale data instead
      // of on live degradation.
      await Promise.all(
        Object.values(h.upstreams.tokenProviders).map((provider) => provider?.token()),
      )

      await h.estate.services[dead].kill()

      const res = await get(h, '/v1/dashboard')
      assert.equal(res.status, 200, `a dead ${dead} must not fail the page`)
      const body = (await res.json()) as WireDashboard

      const affected = tilesFedBy(dead)
      assert.ok(affected.length > 0, `${dead} feeds no tile — the source map is wrong`)

      let sawUnavailable = false
      for (const [name, tile] of Object.entries(body.tiles)) {
        if (affected.includes(name)) {
          assert.notEqual(tile.status, 'ok', `${name} is fed by ${dead} and cannot be ok`)
          assert.ok(tile.reason, `${name} degraded without saying why`)
          if (tile.status === 'unavailable') sawUnavailable = true
        } else {
          assert.equal(
            tile.status,
            'ok',
            `${name} is not fed by ${dead} but was ${tile.status}: ${tile.reason}`,
          )
        }
      }
      assert.ok(sawUnavailable, `nothing was marked unavailable when ${dead} was down`)

      // The tile that is still ok must still have its data, not merely its status.
      const activityOk = !affected.includes('activity')
      if (activityOk) {
        assert.ok(
          (body.tiles['activity']?.data as unknown[]).length > 0,
          'a surviving tile must still be populated',
        )
      }
    })
  })
}

test('a dead source removes its cards and records why, without breaking the rest', async () => {
  // §6 rule 2: "a card that cannot load is absent, not broken".
  await withHub({}, async (h) => {
    await h.estate.services.policy.kill()
    const body = (await (await get(h, '/v1/dashboard')).json()) as WireDashboard

    const kinds = body.nextActions.actions.map((a) => a.kind)
    assert.ok(!kinds.includes('account_frozen'), 'the freeze card must be absent, not broken')
    assert.ok(kinds.includes('mfa_disabled'), 'cards from live sources must survive')
    assert.deepEqual(
      body.nextActions.missing.map((m) => m.source),
      ['policy'],
    )
  })
})

/* ------------------------------------------------------- deadlines */

test('a slow upstream costs its tile, not the dashboard budget', async () => {
  await withHub({ env: { dashboardDeadlineMs: 600, upstreamDeadlineMs: 250 } }, async (h) => {
    // Far beyond any budget. The tile must give up; the page must not wait for it.
    h.estate.services.activity.latencyMs = 4_000

    const startedAt = Date.now()
    const res = await get(h, '/v1/dashboard')
    const elapsed = Date.now() - startedAt

    assert.equal(res.status, 200)
    assert.ok(elapsed < 2_000, `the dashboard took ${elapsed}ms against a 600ms budget`)
    const body = (await res.json()) as WireDashboard
    assert.equal(body.tiles['activity']?.status, 'unavailable')
    assert.equal(body.tiles['wallets']?.status, 'ok', 'a slow peer must not cost a fast one')
    assert.equal(body.tiles['portfolio']?.status, 'ok')
  })
})

test('the page deadline is a backstop when an upstream outlives its own', async () => {
  // The ordering below is refused by `loadEnv` on purpose, and is constructed here to isolate the
  // page-level guard: with the per-request deadline set beyond the page budget, the only thing
  // that can end the request is the dashboard-wide race.
  await withHub({ env: { dashboardDeadlineMs: 300, upstreamDeadlineMs: 10_000 } }, async (h) => {
    h.estate.services.billing.latencyMs = 5_000

    const startedAt = Date.now()
    const res = await get(h, '/v1/dashboard')
    const elapsed = Date.now() - startedAt

    assert.equal(res.status, 200)
    assert.ok(elapsed < 2_000, `the page waited ${elapsed}ms for a peer that ignored its deadline`)
    const tile = (await res.json() as WireDashboard).tiles['entitlements']
    assert.equal(tile?.status, 'unavailable')
    assert.match(tile?.reason ?? '', /dashboard deadline expired/)
  })
})

/**
 * A tile that answered on time must stay answered after the deadline fires.
 *
 * `AbortSignal.timeout` fires whether or not the race it was entered into has already been won, so
 * the losing branch of every `guard` used to run its body a full budget AFTER the response had
 * gone out — warning that a tile "missed the dashboard deadline" and counting it `unavailable`.
 * The tile value was discarded by the settled race, so only the side effects escaped, and they
 * escaped into the metric an operator uses to answer "is this tile really broken": measured live
 * on 2026-08-11, every guarded tile on both networks read `unavailable` exactly as many times as
 * the dashboard had been composed while all of them were serving `ok`.
 *
 * Hence the sleep. Asserting immediately after the response passes with the bug present.
 */
test('a tile that answered in time is not counted late once the budget elapses', async () => {
  await withHub({ env: { dashboardDeadlineMs: 200, upstreamDeadlineMs: 150 } }, async (h) => {
    const body = (await (await get(h, '/v1/dashboard')).json()) as WireDashboard
    assert.deepEqual(body.degraded, [], 'the fixture estate is healthy')

    await delay(500)

    // The offending lines rather than the whole exposition: a metrics dump is four hundred lines
    // and the one fact wanted here is which tiles were slandered.
    const late = h.metrics
      .render()
      .split('\n')
      .filter((line) => line.startsWith('hub_tile_status_total') && line.includes('unavailable'))
    assert.deepEqual(late, [], 'tiles were counted unavailable after the page had been served')
  })
})

/* ------------------------------------------------------- the circuit breaker */

test('the breaker opens after repeated failures and the tile says so rather than retrying', async () => {
  await withHub({ env: { circuitThreshold: 2, circuitResetMs: 60_000 } }, async (h) => {
    // 503 rather than a closed socket: a struggling peer is the case the breaker exists for, and a
    // 5xx is the fault class that must trip it while a 404 must not.
    h.estate.services.pricing.failWith = 503

    const first = (await (await get(h, '/v1/dashboard')).json()) as WireDashboard
    assert.equal(first.tiles['prices']?.status, 'unavailable')
    assert.equal(h.upstreams.circuitStates()['pricing'], 'open', 'two 5xx must open the breaker')

    const callsBefore = h.estate.services.pricing.calls
    const second = (await (await get(h, '/v1/dashboard')).json()) as WireDashboard

    assert.equal(
      h.estate.services.pricing.calls,
      callsBefore,
      'an open breaker must stop calling the peer entirely',
    )
    assert.match(second.tiles['prices']?.reason ?? '', /circuit is open/)
    // And the rest of the page is untouched, which is the whole point of a per-upstream breaker.
    assert.equal(second.tiles['wallets']?.status, 'ok')
    assert.equal(second.tiles['activity']?.status, 'ok')
  })
})

/* ------------------------------------------------------- caching */

test('a tile served from a fresh cache says it was cached, and makes no call', async () => {
  await withHub({}, async (h) => {
    await get(h, '/v1/dashboard')
    const callsAfterFirst = h.estate.services.wallet.calls
    assert.ok(callsAfterFirst > 0)

    const body = (await (await get(h, '/v1/dashboard')).json()) as WireDashboard
    const tile = body.tiles['wallets']

    assert.equal(tile?.status, 'ok', 'a fresh cache hit is still ok')
    assert.equal(tile?.cached, true, 'a served-from-cache tile must say so')
    assert.ok((tile?.ageMs ?? -1) >= 0, 'a cached tile must carry its age')
    assert.equal(h.estate.services.wallet.calls, callsAfterFirst, 'a cache hit must make no call')
  })
})

test('a stale cache served through an outage is degraded, never ok', async () => {
  // The rule this encodes: a cache that hides an outage is worse than no cache.
  let clock = 1_700_000_000_000
  await withHub({ now: () => clock }, async (h) => {
    await get(h, '/v1/dashboard')

    // Past the wallet registry's 60s TTL, inside its 15-minute stale window.
    clock += 70_000
    await h.estate.services.wallet.kill()

    const body = (await (await get(h, '/v1/dashboard')).json()) as WireDashboard
    const tile = body.tiles['wallets']

    assert.equal(tile?.status, 'degraded', 'stale data must never be presented as current')
    assert.equal(tile?.cached, true)
    assert.equal(tile?.ageMs, 70_000)
    assert.match(tile?.reason ?? '', /showing a cached value/)
    assert.ok((tile?.data as unknown[]).length > 0, 'the stale value is still served')
  })
})

test('past the stale window the tile becomes a hole rather than an old number', async () => {
  let clock = 1_700_000_000_000
  await withHub({ now: () => clock }, async (h) => {
    await get(h, '/v1/dashboard')

    // Sixteen minutes: beyond the wallet registry's stale window entirely.
    clock += 16 * 60_000
    await h.estate.services.wallet.kill()

    const body = (await (await get(h, '/v1/dashboard')).json()) as WireDashboard
    assert.equal(body.tiles['wallets']?.status, 'unavailable')
    assert.deepEqual(body.tiles['wallets']?.data, [])
  })
})

/* ------------------------------------------------------- metrics */

test('every tile outcome is counted, by tile and status', async () => {
  await withHub({}, async (h) => {
    await h.estate.services.billing.kill()
    await get(h, '/v1/dashboard')

    const rendered = h.metrics.render()
    assert.match(rendered, /hub_tile_status_total\{tile="entitlements",status="unavailable"\} 1/)
    assert.match(rendered, /hub_tile_status_total\{tile="wallets",status="ok"\} 1/)
    assert.match(rendered, /hub_upstream_ms/)
    assert.match(rendered, /hub_dashboard_ms/)
  })
})

test('cache hits are counted per upstream', async () => {
  await withHub({}, async (h) => {
    await get(h, '/v1/dashboard')
    await get(h, '/v1/dashboard')
    assert.match(h.metrics.render(), /hub_cache_hits_total\{upstream="wallet"\}/)
  })
})
