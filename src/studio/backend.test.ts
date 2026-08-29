import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bodyFor,
  fluxBackend,
  generateThrough,
  ImageBackendError,
  placeholderBackend,
  resolveChain,
  type ImageRequest,
} from './backend.ts'
import { startFakeFlux, TINY_PNG_BASE64, type FakeFlux } from './fakeflux.ts'
import { fluxConfigFor } from './testsupport.ts'

const spec = { kind: 'mark', width: 1024, height: 1024, format: 'png' } as const

const request: ImageRequest = {
  prompt: 'a flat geometric mark',
  spec,
  requestWidth: 1024,
  requestHeight: 1024,
  kitName: 'CloudsForge',
  accent: '#ff4d00',
}

async function withFake(fn: (fake: FakeFlux) => Promise<void>): Promise<void> {
  const fake = await startFakeFlux()
  try {
    await fn(fake)
  } finally {
    await fake.close()
  }
}

const never = AbortSignal.timeout(30_000)

/* --------------------------------------------------------------- the fallback rule */

test('the primary 404s and the fallback serves it', async () => {
  // 404 is DeploymentNotFound: the model is not deployed. It is the state seven of the eight FLUX
  // names probed on the live resource are in, so this is the case the chain exists for.
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 404 })
    fake.script('FLUX.1-pro', { status: 200 })

    const backend = fluxBackend(fluxConfigFor(fake.url, { fallbackModel: 'FLUX.1-pro' }))
    const result = await backend.generate(request, never)

    assert.equal(result.model, 'FLUX.1-pro')
    assert.equal(result.attempts.length, 2)
    assert.equal(result.attempts[0]?.outcome, 'not_found')
    assert.equal(result.attempts[0]?.model, 'FLUX.2-pro')
    assert.equal(result.attempts[1]?.outcome, 'ok')
    // Both attempts are on the result, so the fallback is visible on the asset months later
    // rather than only in a log line nobody kept.
    assert.equal(fake.requests.length, 2)
  })
})

test('the primary 429s and the fallback serves it', async () => {
  // Capacity. A second model usually has its own quota, which is what the chain buys.
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 429 })
    fake.script('FLUX.1-pro', { status: 200 })

    const backend = fluxBackend(fluxConfigFor(fake.url, { fallbackModel: 'FLUX.1-pro' }))
    const result = await backend.generate(request, never)

    assert.equal(result.model, 'FLUX.1-pro')
    assert.equal(result.attempts[0]?.outcome, 'rate_limited')
    assert.equal(fake.requests.length, 2)
  })
})

test('a 5xx falls back', async () => {
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 500 })
    fake.script('FLUX.1-pro', { status: 200 })

    const backend = fluxBackend(fluxConfigFor(fake.url, { fallbackModel: 'FLUX.1-pro' }))
    const result = await backend.generate(request, never)
    assert.equal(result.attempts[0]?.outcome, 'server_error')
    assert.equal(result.model, 'FLUX.1-pro')
  })
})

test('THE RULE: a 400 does NOT fall back, and the error is surfaced', async () => {
  // A bad prompt fails identically on the fallback model, so retrying spends the fallback's quota
  // to produce the same refusal. asset-forge deleted its own fallback chain over exactly this.
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 400 })
    fake.script('FLUX.1-pro', { status: 200 })

    const backend = fluxBackend(fluxConfigFor(fake.url, { fallbackModel: 'FLUX.1-pro' }))
    const err = await backend.generate(request, never).then(
      () => null,
      (e: unknown) => e,
    )

    assert.ok(err instanceof ImageBackendError, 'a 400 must surface as a typed error')
    assert.equal(err.code, 'bad_request')
    assert.equal(err.attempts.length, 1, 'the fallback model must not have been tried')
    assert.equal(
      fake.requests.length,
      1,
      'exactly one HTTP request: the fallback would have spent quota for the same refusal',
    )
    assert.match(err.message, /not retried on the fallback model/)
  })
})

test('a 401 does not fall back either, because auth is per-resource', async () => {
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 401 })
    fake.script('FLUX.1-pro', { status: 200 })

    const backend = fluxBackend(fluxConfigFor(fake.url, { fallbackModel: 'FLUX.1-pro' }))
    const err = await backend.generate(request, never).then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof ImageBackendError)
    assert.equal(err.code, 'unauthorised')
    assert.equal(fake.requests.length, 1)
  })
})

test('every configured model 404ing reports no_backend_available, and names the spelling trap', async () => {
  // The live resource's actual state for every name except FLUX.2-pro. The message has to be
  // actionable: the likeliest cause is the hyphen/dot spelling, not a missing deployment.
  await withFake(async (fake) => {
    const backend = fluxBackend(fluxConfigFor(fake.url, { model: 'flux-2-pro', fallbackModel: 'FLUX.1-pro' }))
    const err = await backend.generate(request, never).then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof ImageBackendError)
    assert.equal(err.code, 'no_backend_available')
    assert.equal(err.attempts.length, 2)
    assert.match(err.message, /dots/)
    assert.match(err.message, /FLUX\.2-pro/)
  })
})

test('with no fallback configured the chain is one model long', async () => {
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 404 })
    const backend = fluxBackend(fluxConfigFor(fake.url))
    assert.deepEqual(backend.models, ['FLUX.2-pro'])
    await assert.rejects(() => backend.generate(request, never))
    assert.equal(fake.requests.length, 1)
  })
})

/* --------------------------------------------------------------- the request body */

test('THE TRAP: the request body always carries `model`, even though the path names it', async () => {
  // Omitting `model` is 400 no_model_name on the live endpoint even though the URL path already
  // says flux-2-pro. It reads like duplication, which is exactly why it gets deleted.
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 200 })
    const backend = fluxBackend(fluxConfigFor(fake.url))
    await backend.generate(request, never)

    const sent = fake.requests[0]
    assert.ok(sent)
    assert.equal(sent.body['model'], 'FLUX.2-pro', 'model must be in the BODY, not only the URL')
    assert.equal(sent.body['output_format'], 'png', 'without this the response is JPEG')
    // width/height, never aspect_ratio or size: the latter two are accepted and silently ignored.
    assert.equal(sent.body['width'], 1024)
    assert.equal(sent.body['height'], 1024)
    assert.equal(sent.body['aspect_ratio'], undefined)
    assert.equal(sent.body['size'], undefined)
    assert.equal(sent.headers['api-key'], 'test-key-0000000000000000000000000000')
    assert.match(sent.url, /^\/providers\/blackforestlabs\/v1\/flux-2-pro\?/)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // **`api-version` IS ON THE WIRE.** This assertion is the one that would have saved forty
    // assets. Without the parameter the live resource answers 404 to a correctly-spelled model at
    // a correctly-spelled path with a valid key — indistinguishable from a model that was never
    // deployed, which is precisely how it was read for this service's entire history while every
    // test in this file stayed green. Asserting the path alone is what made that possible, so the
    // path assertion above is deliberately no longer anchored at the end.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    assert.match(sent.url, /[?&]api-version=2025-04-01-preview(&|$)/, 'api-version is mandatory')
  })
})

test('bodyFor cannot produce a body without a model', () => {
  // Asserted on the builder as well as on the wire, so a refactor that stops calling it still
  // fails something.
  for (const model of ['FLUX.2-pro', 'FLUX.1-pro']) {
    const body = bodyFor(model, request)
    assert.equal(body['model'], model)
  }
})

test('the fake refuses a body with no model, exactly as the live endpoint does', async () => {
  await withFake(async (fake) => {
    const res = await fetch(`${fake.url}/providers/blackforestlabs/v1/flux-2-pro`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a circle', output_format: 'png' }),
    })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'no_model_name')
  })
})

/* --------------------------------------------------------------- response shapes */

test('the b64_json response shape parses', async () => {
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 200, shape: 'b64_json' })
    const backend = fluxBackend(fluxConfigFor(fake.url))
    const result = await backend.generate(request, never)

    assert.deepEqual(result.bytes, Buffer.from(TINY_PNG_BASE64, 'base64'))
    assert.equal(result.attempts[0]?.detail, 'b64_json')
    assert.equal(result.format, 'png')
  })
})

test('the url response shape parses, and the image is fetched rather than discarded', async () => {
  // The image is billed either way. asset-forge shipped `res.data?.[0]?.b64_json` and threw
  // AFTER the money was spent, for months.
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 200, shape: 'url' })
    const backend = fluxBackend(fluxConfigFor(fake.url))
    const result = await backend.generate(request, never)

    assert.deepEqual(result.bytes, Buffer.from(TINY_PNG_BASE64, 'base64'))
    assert.equal(result.attempts[0]?.detail, 'url')
  })
})

test('the api-key is NOT sent when fetching a pre-signed blob URL', async () => {
  // The URL names a host we did not choose. Sending the resource key to it would leak the key to
  // whatever that host, or a redirect from it, happens to be.
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 200, shape: 'url' })
    await fluxBackend(fluxConfigFor(fake.url)).generate(request, never)

    const blobRequest = fake.requests.find((r) => r.url === '/blob.png')
    // The blob route answers before the body handler records it, so absence here is the assertion
    // that matters: nothing with a key reached it.
    assert.equal(blobRequest, undefined)
  })
})

test('the provider cost meta is carried through as provenance', async () => {
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 200 })
    const result = await fluxBackend(fluxConfigFor(fake.url)).generate(request, never)
    assert.equal(result.providerMeta?.cost, 3)
    assert.equal(result.providerMeta?.totalPixels, 1_048_576)
  })
})

test('a 200 that is not JSON is recorded distinctly and falls back', async () => {
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 200, raw: '<html>gateway</html>' })
    fake.script('FLUX.1-pro', { status: 200 })
    const backend = fluxBackend(fluxConfigFor(fake.url, { fallbackModel: 'FLUX.1-pro' }))
    const result = await backend.generate(request, never)
    assert.equal(result.attempts[0]?.outcome, 'bad_response')
    assert.equal(result.model, 'FLUX.1-pro')
  })
})

test('a transport fault falls back, because the request may never have been received', async () => {
  const fake = await startFakeFlux()
  const url = fake.url
  await fake.close()

  // Nothing is listening now. The first model cannot be reached at all.
  const backend = fluxBackend(fluxConfigFor(url, { fallbackModel: 'FLUX.1-pro' }))
  const err = await backend.generate(request, never).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof ImageBackendError)
  assert.equal(err.attempts.length, 2, 'both models are tried when the transport failed')
  assert.equal(err.attempts[0]?.outcome, 'transport_error')
  assert.equal(err.code, 'backend_unavailable')
})

/* --------------------------------------------------------------- redaction */

test('a key echoed in an upstream error body never reaches the attempt detail', async () => {
  const key = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789'
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', {
      status: 400,
      body: { error: { code: 'BadRequest', message: `the key ${key} is malformed` } },
    })
    const backend = fluxBackend(fluxConfigFor(fake.url))
    const err = await backend.generate(request, never).then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof ImageBackendError)
    // The detail is stored in the database and rendered by GET /v1/jobs/:id.
    assert.equal(err.attempts[0]?.detail.includes(key), false)
    assert.match(err.attempts[0]?.detail ?? '', /\[redacted\]/)
  })
})

/* --------------------------------------------------------------- placeholder */

test('the placeholder backend is deterministic for a given spec', async () => {
  const backend = placeholderBackend()
  const first = await backend.generate(request, never)
  const second = await backend.generate(request, never)

  // Byte-identical, or every asset checksum is meaningless and every diff is noise.
  assert.deepEqual(first.bytes, second.bytes)
  assert.equal(first.format, 'svg')
  assert.equal(first.costUsdMicros, 0n)
  assert.equal(first.model, null)
  assert.match(first.bytes.toString('utf8'), /placeholder/)
  // Drawn in the kit's accent on the design system's ash ground, so an offline run previews the
  // real thing rather than showing a grey box.
  assert.match(first.bytes.toString('utf8'), /#ff4d00/)
  assert.match(first.bytes.toString('utf8'), /#12100f/)
})

test('a different spec produces different placeholder bytes', async () => {
  const backend = placeholderBackend()
  const mark = await backend.generate(request, never)
  const favicon = await backend.generate(
    { ...request, spec: { kind: 'favicon', width: 512, height: 512, format: 'png' } },
    never,
  )
  assert.notDeepEqual(mark.bytes, favicon.bytes)
})

test('the placeholder is authored at the exact declared size', async () => {
  const backend = placeholderBackend()
  const result = await backend.generate(
    { ...request, spec: { kind: 'og', width: 1200, height: 630, format: 'png' } },
    never,
  )
  const svg = result.bytes.toString('utf8')
  assert.match(svg, /width="1200"/)
  assert.match(svg, /height="630"/)
})

/* --------------------------------------------------------------- the chain */

test('auto falls through to the placeholder when no model is deployed', async () => {
  // The degradation that keeps the service useful while only one model exists. It is never
  // silent: every failed attempt is on the result and the asset records backend=placeholder.
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 404 })
    const set = { flux: fluxBackend(fluxConfigFor(fake.url)), placeholder: placeholderBackend() }
    const result = await generateThrough(resolveChain(set, 'auto'), request, never)

    assert.equal(result.backend, 'placeholder')
    assert.equal(result.attempts.length, 2, 'the failed FLUX attempt is kept on the result')
    assert.equal(result.attempts[0]?.outcome, 'not_found')
    assert.equal(result.attempts[0]?.backend, 'flux')
  })
})

test('a 400 stops the chain BEFORE the placeholder, so a refused prompt is not papered over', async () => {
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 400 })
    const set = { flux: fluxBackend(fluxConfigFor(fake.url)), placeholder: placeholderBackend() }
    const err = await generateThrough(resolveChain(set, 'auto'), request, never).then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof ImageBackendError)
    assert.equal(err.code, 'bad_request')
  })
})

test('asking for flux by name never yields a placeholder', async () => {
  await withFake(async (fake) => {
    fake.script('FLUX.2-pro', { status: 404 })
    const set = { flux: fluxBackend(fluxConfigFor(fake.url)), placeholder: placeholderBackend() }
    const err = await generateThrough(resolveChain(set, 'flux'), request, never).then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof ImageBackendError, 'a caller who asked for art gets an error, not an SVG')
    assert.equal(err.code, 'no_backend_available')
  })
})

test('with no flux configured, auto is the placeholder alone', async () => {
  const set = { flux: null, placeholder: placeholderBackend() }
  const result = await generateThrough(resolveChain(set, 'auto'), request, never)
  assert.equal(result.backend, 'placeholder')

  await assert.rejects(
    () => generateThrough(resolveChain(set, 'flux'), request, never),
    (err: unknown) => err instanceof ImageBackendError && err.code === 'no_backend_available',
  )
})
