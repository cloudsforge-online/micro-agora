/**
 * The live test. Skips unless `STUDIO_LIVE_FLUX=1` and the resource is configured.
 *
 * Every other test in this repository runs against a fake HTTP server, which is right: a fake is
 * fast, free, deterministic, and can be made to answer 429 on demand. But a fake only proves that
 * this code is consistent with **what we believe** the endpoint does. This one test is the only
 * thing that checks the belief.
 *
 * It is gated because it costs money and needs a credential. It generates one **small** image —
 * 256x256, the cheapest thing the endpoint will render — and asserts the four facts that the rest
 * of the suite assumes:
 *
 *   1. The request shape works: the model in the BODY, `output_format:"png"`, `width`/`height`.
 *   2. The response really is a PNG, by magic bytes rather than by content type.
 *   3. `width`/`height` are honoured exactly, at a size on the 16-pixel grid.
 *   4. The bytes carry C2PA provenance, which is the disclosure fact recorded on every asset.
 *
 * Run it with:
 *
 *     set -a && . ./.env.local && set +a && STUDIO_LIVE_FLUX=1 pnpm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fluxBackend, ImageBackendError, type ImageRequest } from './backend.ts'
import { Preflight } from './preflight.ts'
import { pngDimensions } from './sizing.ts'
import type { FluxConfig } from './env.ts'

const endpoint = process.env['AZURE_FOUNDRY_ENDPOINT']?.trim() ?? ''
const apiKey = process.env['AZURE_FOUNDRY_API_KEY']?.trim() ?? ''
const model = process.env['STUDIO_IMAGE_MODEL']?.trim() || 'FLUX.2-pro'
const imagePath =
  process.env['AZURE_FOUNDRY_IMAGE_PATH']?.trim() || '/providers/blackforestlabs/v1/flux-2-pro'
const apiVersion = process.env['AZURE_FOUNDRY_API_VERSION']?.trim() || '2025-04-01-preview'

const live = process.env['STUDIO_LIVE_FLUX'] === '1' && endpoint.length > 0 && apiKey.length > 0

const skip = live
  ? false
  : 'set STUDIO_LIVE_FLUX=1 with AZURE_FOUNDRY_ENDPOINT and AZURE_FOUNDRY_API_KEY to probe the real endpoint'

const config: FluxConfig = {
  endpoint: endpoint.replace(/\/+$/, ''),
  apiKey,
  imagePath,
  apiVersion,
  model,
  fallbackModel: process.env['STUDIO_IMAGE_FALLBACK_MODEL']?.trim() ?? '',
}

/** 256x256: on the 16-pixel grid, and the smallest thing worth paying for. */
const SMALL = 256

const request: ImageRequest = {
  prompt:
    'A flat geometric vector brand mark: one orange circle with a square chamfer, centred on a ' +
    'warm ash ground. Flat fills only, no gradients, no text.',
  spec: { kind: 'icon', width: SMALL, height: SMALL, format: 'png' },
  requestWidth: SMALL,
  requestHeight: SMALL,
  kitName: 'CloudsForge',
  accent: '#ff4d00',
}

test('LIVE: FLUX generates a real PNG at the exact requested size', { skip }, async () => {
  if (!live) return

  const backend = fluxBackend(config, { deadlineMs: 180_000 })
  const result = await backend.generate(request, AbortSignal.timeout(180_000))

  // 2. A real PNG, by magic bytes. A content-type header can lie; these eight bytes cannot.
  assert.equal(result.bytes.subarray(0, 4).toString('hex'), '89504e47', 'PNG magic bytes')
  assert.equal(result.bytes.toString('ascii', 12, 16), 'IHDR')

  // 3. width/height honoured exactly, at a size on the grid.
  assert.deepEqual(pngDimensions(result.bytes), { width: SMALL, height: SMALL })

  // 4. C2PA provenance, which is a licensing and disclosure fact and is recorded on the asset.
  assert.equal(result.c2pa, true, 'FLUX images carry C2PA provenance and an invisible watermark')

  // Provenance the job row will carry.
  assert.equal(result.backend, 'flux')
  assert.equal(result.model, model)
  assert.equal(result.requestedSize, `${SMALL}x${SMALL}`)
  assert.equal(result.attempts.length, 1, 'no fallback should have been needed')
  assert.equal(result.attempts[0]?.outcome, 'ok')
  assert.equal(result.attempts[0]?.detail, 'b64_json')
  // The provider's own accounting comes back and is recorded verbatim.
  assert.ok((result.providerMeta?.cost ?? 0) > 0, 'request_meta.cost is present')

  console.log(
    `    live: ${result.bytes.length} bytes, ${SMALL}x${SMALL}, model=${result.model}, ` +
      `cost=${result.providerMeta?.cost} units, c2pa=${result.c2pa}, ` +
      `${result.attempts[0]?.durationMs}ms`,
  )
})

test('LIVE: the hyphenated path spelling really is a 404 as a model name', { skip }, async () => {
  if (!live) return
  // The trap, verified against the live endpoint rather than asserted from documentation: the URL
  // path segment is `flux-2-pro` and sending that as the model is DeploymentNotFound. If this ever
  // starts passing, the warning in `preflight.ts` should be retired.
  const backend = fluxBackend({ ...config, model: 'flux-2-pro' }, { deadlineMs: 60_000 })
  const err = await backend.generate(request, AbortSignal.timeout(60_000)).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof ImageBackendError)
  assert.equal(err.code, 'no_backend_available')
  assert.equal(err.attempts[0]?.outcome, 'not_found')
  assert.equal(err.attempts[0]?.status, 404)
  assert.match(err.attempts[0]?.detail ?? '', /DeploymentNotFound/)
})

test('LIVE: the on-demand preflight probe reports the real resource as usable', { skip }, async () => {
  if (!live) return
  const preflight = new Preflight(config, { deadlineMs: 180_000 })
  const report = await preflight.probe()

  assert.equal(report.usable, true)
  assert.equal(report.evidence, 'probe')
  assert.equal(report.model, model)
  console.log(`    live: ${report.reason}`)
})
