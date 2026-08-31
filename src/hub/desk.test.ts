/**
 * The exchange desk seam: quote, convert, and the two lists behind them (micro-org#496).
 *
 * These are the first routes on this service that move money and the first that read a request
 * body, so the tests below are weighted towards what happens when the answer is NO. The one that
 * matters most is `desk_inventory_short`: wallet refuses with a 409, a code and a sentence a person
 * can act on, and if any of the three is lost on the way through this service the feature reads as
 * "something went wrong" and the user's only next move is a support ticket.
 *
 * The fake desk in `testsupport.ts` decides refusals from the intent rather than from a flag, so
 * these cases exercise the same branch a real one would: notably the quote for an amount larger
 * than the desk's inventory SUCCEEDS and only the conversion fails, which is wallet's deliberate
 * design and the sequence a user actually walks through.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DESK_INVENTORY,
  DESK_RATE,
  HOLD_NOTICE,
  OTHER_USER_ID,
  USER_ID,
  get,
  post,
  signService,
  signUser,
  withHub,
} from './testsupport.ts'

/** An amount whose output is one unit past what the fixture desk holds. */
const TOO_LARGE = (DESK_INVENTORY / DESK_RATE + 1n).toString()

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string }
}

/* ------------------------------------------------------------------ POST /v1/conversions/quote */

test('a quote comes back with the desk’s own words about not being a hold', async () => {
  // `hold` and `holdNotice` are forwarded rather than composed here. The confirm step has to tell a
  // user that nothing is reserved, and a second copy of that sentence in this repo would be free to
  // drift from wallet's.
  await withHub({}, async (h) => {
    const res = await post(h, '/v1/conversions/quote', {
      fromAssetCode: 'BTC',
      toAssetCode: 'EMBER',
      amount: '1000',
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      quote: {
        fromAssetCode: string
        toAmount: string
        toAmountFormatted: string
        quotedAt: string
        hold: boolean
        holdNotice: string
      }
    }
    assert.equal(body.quote.fromAssetCode, 'BTC')
    assert.equal(body.quote.toAmount, (1000n * DESK_RATE).toString())
    assert.equal(body.quote.hold, false)
    assert.equal(body.quote.holdNotice, HOLD_NOTICE)
    assert.equal(body.quote.quotedAt, '2026-07-30T14:22:00.000Z')
  })
})

test('a quote is never served from cache', async () => {
  // A cached price is a price somebody trades at after it stopped being true.
  await withHub({}, async (h) => {
    const intent = { fromAssetCode: 'BTC', toAssetCode: 'EMBER', amount: '1000' }
    await post(h, '/v1/conversions/quote', intent)
    const after = h.estate.services.wallet.calls
    await post(h, '/v1/conversions/quote', intent)
    assert.equal(h.estate.services.wallet.calls, after + 1, 'the second quote asked the desk again')
  })
})

test('the quote does not consult inventory: it prices what the conversion will refuse', async () => {
  await withHub({}, async (h) => {
    const intent = { fromAssetCode: 'BTC', toAssetCode: 'EMBER', amount: TOO_LARGE }
    assert.equal((await post(h, '/v1/conversions/quote', intent)).status, 200)

    const settle = await post(h, '/v1/conversions', intent)
    assert.equal(settle.status, 409)
    const body = (await settle.json()) as ErrorBody
    assert.equal(body.error.code, 'desk_inventory_short')
    assert.match(body.error.message, /try a smaller amount/)
  })
})

/* ------------------------------------------------------------------ POST /v1/conversions */

test('a conversion is 201 and carries the entry id and the summary', async () => {
  await withHub({}, async (h) => {
    const res = await post(h, '/v1/conversions', {
      fromAssetCode: 'BTC',
      toAssetCode: 'EMBER',
      amount: '1000',
    })
    assert.equal(res.status, 201)
    const body = (await res.json()) as {
      entryId: string
      replayed: boolean
      summary: { toAssetCode: string; toAmount: string }
    }
    assert.equal(body.entryId, 'cv-new')
    assert.equal(body.replayed, false)
    assert.equal(body.summary.toAssetCode, 'EMBER')
  })
})

test('the caller’s idempotency key reaches wallet unchanged', async () => {
  // Minting a fresh key on this hop would defeat the whole mechanism: the browser resending a press
  // whose response was lost would be a second key, and a second conversion.
  await withHub({}, async (h) => {
    await post(
      h,
      '/v1/conversions',
      { fromAssetCode: 'BTC', toAssetCode: 'EMBER', amount: '1000' },
      { idempotencyKey: 'browser-minted-9f3c' },
    )
    assert.equal(h.estate.services.wallet.lastHeaders['idempotency-key'], 'browser-minted-9f3c')
  })
})

test('a conversion without an idempotency key is refused here, before wallet', async () => {
  await withHub({}, async (h) => {
    const before = h.estate.services.wallet.calls
    const res = await post(
      h,
      '/v1/conversions',
      { fromAssetCode: 'BTC', toAssetCode: 'EMBER', amount: '1000' },
      { idempotencyKey: null },
    )
    assert.equal(res.status, 400)
    const body = (await res.json()) as ErrorBody
    // wallet's own code for the same refusal, so a client branches on one spelling either way.
    assert.equal(body.error.code, 'idempotency_key_required')
    assert.match(body.error.message, /Idempotency-Key/)
    assert.equal(h.estate.services.wallet.calls, before, 'nothing was sent to the desk')
  })
})

test('a malformed body is a 400 that does not quote the body back', async () => {
  await withHub({}, async (h) => {
    const res = await post(h, '/v1/conversions/quote', '{"fromAssetCode": ')
    assert.equal(res.status, 400)
    const body = (await res.json()) as ErrorBody
    assert.equal(body.error.message, 'the request body must be JSON')
    assert.ok(!body.error.message.includes('fromAssetCode'), 'the input is not echoed')
  })
})

test('a missing field is refused as shape, not forwarded as meaning', async () => {
  await withHub({}, async (h) => {
    const before = h.estate.services.wallet.calls
    const res = await post(h, '/v1/conversions/quote', { fromAssetCode: 'BTC', amount: '1000' })
    assert.equal(res.status, 400)
    assert.match(((await res.json()) as ErrorBody).error.message, /toAssetCode is required/)
    assert.equal(h.estate.services.wallet.calls, before)
  })
})

test('an amount sent as a JSON number is refused rather than rounded', async () => {
  // 78-bit quantities in smallest units. `1e21` as a JSON number is not the integer anyone typed.
  await withHub({}, async (h) => {
    const res = await post(h, '/v1/conversions/quote', {
      fromAssetCode: 'BTC',
      toAssetCode: 'EMBER',
      amount: 1000,
    })
    assert.equal(res.status, 400)
    assert.match(((await res.json()) as ErrorBody).error.message, /as a string/)
  })
})

/* ------------------------------------------------------------------ refusals, forwarded */

test('every refusal the desk can decide keeps its status, its code and its sentence', async () => {
  await withHub({}, async (h) => {
    const cases: { intent: Record<string, string>; status: number; code: string }[] = [
      { intent: { fromAssetCode: 'BTC', toAssetCode: 'BTC', amount: '1000' }, status: 422, code: 'same_asset' },
      { intent: { fromAssetCode: 'XRP', toAssetCode: 'EMBER', amount: '1000' }, status: 422, code: 'not_convertible' },
      { intent: { fromAssetCode: 'DOGE', toAssetCode: 'EMBER', amount: '1000' }, status: 503, code: 'rate_unavailable' },
      { intent: { fromAssetCode: 'BTC', toAssetCode: 'EMBER', amount: '0' }, status: 422, code: 'invalid_amount' },
      { intent: { fromAssetCode: 'BTC', toAssetCode: 'EMBER', amount: TOO_LARGE }, status: 409, code: 'desk_inventory_short' },
    ]
    for (const { intent, status, code } of cases) {
      const res = await post(h, '/v1/conversions', intent)
      assert.equal(res.status, status, `${code} keeps its status`)
      const body = (await res.json()) as ErrorBody
      assert.equal(body.error.code, code)
      assert.ok(body.error.message.length > 0, `${code} arrives with wallet's sentence`)
      // The request id is this service's, not the upstream's: it is the one in this service's logs
      // and the one the reader can quote back.
      assert.notEqual(body.error.requestId, 'wallet-req')
    }
  })
})

test('a refusal the quote route can reach is forwarded too', async () => {
  await withHub({}, async (h) => {
    const res = await post(h, '/v1/conversions/quote', {
      fromAssetCode: 'EMBER',
      toAssetCode: 'EMBER',
      amount: '1000',
    })
    assert.equal(res.status, 422)
    assert.equal(((await res.json()) as ErrorBody).error.code, 'same_asset')
  })
})

test('an upstream 4xx that is not the estate envelope is a generic 500, not an echo', async () => {
  // The narrow departure from `describeFault`'s never-echo-a-body rule holds only for a body that
  // parses as `{ error: { code, message } }`. Anything else — an HTML captive portal, a proxy's own
  // error page, a peer that changed its shape — must degrade rather than reach a browser.
  await withHub({}, async (h) => {
    h.estate.services.wallet.failWith = 409 // answers `{ error: { code: 'upstream_unwell' } }`, no message
    const res = await post(h, '/v1/conversions', {
      fromAssetCode: 'BTC',
      toAssetCode: 'EMBER',
      amount: '1000',
    })
    assert.equal(res.status, 500)
    const body = (await res.json()) as ErrorBody
    assert.notEqual(body.error.code, 'upstream_unwell')
    assert.ok(!body.error.message.includes('upstream_unwell'))
  })
})

test('a wallet 401 does not become a 401 here', async () => {
  // Forwarding it would make the browser treat a disagreement between two services about a token it
  // already verified as the reader's session ending, and sign them out over an estate fault.
  await withHub({}, async (h) => {
    h.estate.services.wallet.failWith = 401
    const res = await post(h, '/v1/conversions', {
      fromAssetCode: 'BTC',
      toAssetCode: 'EMBER',
      amount: '1000',
    })
    assert.equal(res.status, 500)
  })
})

/* ------------------------------------------------------------------ who may convert */

test('a service token cannot convert: there is no such thing as a service conversion', async () => {
  await withHub({}, async (h) => {
    const res = await post(
      h,
      '/v1/conversions',
      { fromAssetCode: 'BTC', toAssetCode: 'EMBER', amount: '1000' },
      { token: await signService() },
    )
    assert.equal(res.status, 403)
  })
})

test('an operator may read another user’s conversions and may not make one', async () => {
  await withHub({}, async (h) => {
    const admin = await signUser(USER_ID, ['player', 'admin'])

    const list = await get(h, `/v1/conversions?userId=${OTHER_USER_ID}`, admin)
    assert.equal(list.status, 200)
    assert.equal(h.estate.services.wallet.lastQuery?.get('userId'), OTHER_USER_ID)

    const res = await post(
      h,
      `/v1/conversions?userId=${OTHER_USER_ID}`,
      { fromAssetCode: 'BTC', toAssetCode: 'EMBER', amount: '1000' },
      { token: admin },
    )
    assert.equal(res.status, 403)
    assert.match(((await res.json()) as ErrorBody).error.message, /your own session/)
  })
})

test('a user cannot name another user on any desk route', async () => {
  await withHub({}, async (h) => {
    assert.equal((await get(h, `/v1/conversions?userId=${OTHER_USER_ID}`)).status, 403)
    assert.equal((await get(h, `/v1/transfers?userId=${OTHER_USER_ID}`)).status, 403)
    assert.equal((await get(h, `/v1/conversions/cv1?userId=${OTHER_USER_ID}`)).status, 403)
  })
})

/* ------------------------------------------------------------------ GET /v1/conversions */

test('conversions are flat like activity, with the cursor forwarded verbatim', async () => {
  await withHub({}, async (h) => {
    const first = (await (await get(h, '/v1/conversions?limit=1')).json()) as {
      conversions: { id: string; quotedAt: string | null }[]
      nextCursor: string | null
      status: string
      cached: boolean
      ageMs: number | null
    }
    assert.equal(first.status, 'ok')
    assert.equal(first.conversions.length, 1)
    assert.equal(first.conversions[0]?.id, 'cv1')
    assert.equal(first.nextCursor, 'cv1')

    const second = (await (
      await get(h, `/v1/conversions?limit=1&cursor=${first.nextCursor}`)
    ).json()) as { conversions: { id: string; quotedAt: string | null }[]; nextCursor: string | null }
    assert.equal(second.conversions[0]?.id, 'cv2')
    // An entry booked before micro-org#495 has no quote timestamp. Forwarded as null rather than
    // filled in with the booking time, which would be a price observation this estate never made.
    assert.equal(second.conversions[0]?.quotedAt, null)
    assert.equal(second.nextCursor, null)
  })
})

test('only the first page of conversions is cached', async () => {
  // A cursor page keyed by cursor would fill the cache with one entry per scroll position, and the
  // pages after the first are the ones nobody comes back to.
  await withHub({}, async (h) => {
    await get(h, '/v1/conversions')
    const afterFirst = h.estate.services.wallet.calls
    await get(h, '/v1/conversions')
    assert.equal(h.estate.services.wallet.calls, afterFirst, 'the second read was a cache hit')

    await get(h, '/v1/conversions?cursor=cv1')
    const afterCursor = h.estate.services.wallet.calls
    await get(h, '/v1/conversions?cursor=cv1')
    assert.equal(h.estate.services.wallet.calls, afterCursor + 1, 'a cursor page is not cached')
  })
})

test('wallet down leaves an empty list with a reason rather than an error page', async () => {
  await withHub({}, async (h) => {
    await h.estate.services.wallet.kill()
    for (const path of ['/v1/conversions', '/v1/transfers']) {
      const res = await get(h, path)
      assert.equal(res.status, 200, `${path} degrades`)
      const body = (await res.json()) as { status: string; reason: string }
      assert.equal(body.status, 'unavailable')
      assert.ok(body.reason.length > 0)
    }
  })
})

test('a bad limit is 400 on both lists', async () => {
  await withHub({}, async (h) => {
    assert.equal((await get(h, '/v1/conversions?limit=0')).status, 400)
    assert.equal((await get(h, '/v1/transfers?limit=5000')).status, 400)
  })
})

/* ------------------------------------------------------------------ GET /v1/transfers */

test('transfers list both directions, including one with no counterparty user', async () => {
  await withHub({}, async (h) => {
    const body = (await (await get(h, '/v1/transfers')).json()) as {
      transfers: { id: string; direction: string; counterpartyUserId: string | null }[]
      status: string
    }
    assert.equal(body.status, 'ok')
    assert.deepEqual(
      body.transfers.map((t) => t.direction),
      ['out', 'in'],
      'received transfers are listed too — a list of only sent ones is a strange thing to hand ' +
        'somebody looking for money a friend says they sent',
    )
    assert.equal(body.transfers[1]?.counterpartyUserId, null)
  })
})

/* ------------------------------------------------------------------ GET /v1/conversions/:id */

test('one conversion by id, and a missing one keeps wallet’s 404', async () => {
  await withHub({}, async (h) => {
    const found = await get(h, '/v1/conversions/cv1')
    assert.equal(found.status, 200)
    const body = (await found.json()) as { conversion: { id: string; toAssetCode: string } }
    assert.equal(body.conversion.id, 'cv1')
    assert.equal(body.conversion.toAssetCode, 'EMBER')

    // Not translated to 403 or to an empty record: wallet answers 404 for "no such entry", "not a
    // conversion" and "somebody else's" alike, and telling them apart here would rebuild the entry-id
    // oracle that wallet refuses to be one layer up.
    const missing = await get(h, '/v1/conversions/cv-nope')
    assert.equal(missing.status, 404)
    assert.equal(((await missing.json()) as ErrorBody).error.code, 'conversion_not_found')
  })
})

test('the detail pattern does not swallow the list or the quote route', async () => {
  // `/v1/conversions/:id` was the first pattern route on this service. A matcher that treated the
  // empty segment as a capture would route `/v1/conversions/` to the detail handler with an empty
  // id, and one checked before the literals would route `POST /v1/conversions/quote` there too.
  await withHub({}, async (h) => {
    assert.equal((await get(h, '/v1/conversions')).status, 200)
    assert.equal((await get(h, '/v1/conversions/')).status, 404)
    assert.equal((await get(h, '/v1/conversions/cv1/extra')).status, 404)

    const quote = await post(h, '/v1/conversions/quote', {
      fromAssetCode: 'BTC',
      toAssetCode: 'EMBER',
      amount: '1000',
    })
    assert.equal(quote.status, 200)
  })
})

test('the detail route is one metric series whatever the id', async () => {
  // Route labels carry the PATTERN. Labelling by matched path would make every conversion id its own
  // time series, which is how a metrics backend falls over.
  await withHub({}, async (h) => {
    await get(h, '/v1/conversions/cv1')
    await get(h, '/v1/conversions/cv2')
    const text = await (await fetch(`${h.url}/metrics`)).text()
    assert.ok(text.includes('/v1/conversions/:id'), 'the pattern is the label')
    assert.ok(!text.includes('/v1/conversions/cv1'), 'the id is not')
  })
})
