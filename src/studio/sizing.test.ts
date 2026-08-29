import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measure, pngDimensions, reportSizing, svgDimensions } from './sizing.ts'
import { DEFAULT_SIZES, isOnGrid, requestSizeFor, specFor, SpecError } from './specs.ts'
import { placeholderSvg } from './placeholder.ts'
import { pngOfSize, TINY_PNG_BASE64 } from './fakeflux.ts'

/* --------------------------------------------------------------- measuring */

test('PNG dimensions are read from the IHDR chunk with no decoder and no dependency', () => {
  assert.deepEqual(pngDimensions(pngOfSize(1024, 384)), { width: 1024, height: 384 })
  assert.deepEqual(pngDimensions(pngOfSize(1200, 624)), { width: 1200, height: 624 })
  // A real PNG, not one this repository synthesised.
  assert.deepEqual(pngDimensions(Buffer.from(TINY_PNG_BASE64, 'base64')), { width: 1, height: 1 })
})

test('anything that is not a PNG measures as null rather than throwing', () => {
  // A backend that returned something unexpected is a fact to record on the asset, not an
  // exception that loses a generation already paid for.
  assert.equal(pngDimensions(Buffer.from('not a png at all')), null)
  assert.equal(pngDimensions(Buffer.alloc(0)), null)
  // Right signature, wrong first chunk: guessing past it would read two random integers.
  const wrongChunk = pngOfSize(64, 64)
  wrongChunk.write('IDAT', 12, 'ascii')
  assert.equal(pngDimensions(wrongChunk), null)
  // Zero is illegal in IHDR and must not be recorded as a measurement.
  assert.equal(pngDimensions(pngOfSize(0, 64)), null)
})

test('SVG dimensions are read from the declared attributes', () => {
  const svg = placeholderSvg({
    kitName: 'CloudsForge',
    accent: '#ff4d00',
    spec: { kind: 'wordmark', width: 1024, height: 384, format: 'png' },
  })
  assert.deepEqual(svgDimensions(Buffer.from(svg, 'utf8')), { width: 1024, height: 384 })
})

test('an SVG with only a viewBox still measures', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150"></svg>'
  assert.deepEqual(svgDimensions(Buffer.from(svg, 'utf8')), { width: 300, height: 150 })
})

test('measure dispatches on the declared format rather than sniffing', () => {
  assert.deepEqual(measure(pngOfSize(32, 32), 'png'), { width: 32, height: 32 })
  assert.equal(measure(pngOfSize(32, 32), 'svg'), null)
})

/* --------------------------------------------------------------- reporting */

test('a delivery that matches the spec is exact', () => {
  const report = reportSizing(pngOfSize(1024, 1024), { width: 1024, height: 1024 }, 'png')
  assert.equal(report.sizing, 'exact')
  assert.deepEqual(report.actual, { width: 1024, height: 1024 })
})

test('THE POINT: a mismatch is recorded as unsized with BOTH numbers, never relabelled', () => {
  // Twelve game masters in the estate sit at 1024 square against a declared 512 and 256, and
  // nothing detects it because only one of the two numbers was ever recorded.
  const report = reportSizing(pngOfSize(1024, 1024), { width: 512, height: 512 }, 'png')
  assert.equal(report.sizing, 'unsized')
  assert.deepEqual(report.actual, { width: 1024, height: 1024 })
  assert.match(report.note, /delivered 1024x1024 against a declared 512x512/)
})

test('the real FLUX snapping case: an OG card declared 1200x630 is delivered 1200x640', () => {
  // Measured against the live endpoint: FLUX floors each dimension to a multiple of 16, so a
  // request for 630 delivers 624. `requestSizeFor` rounds UP to 640 instead, because an image
  // larger than the spec can be cropped and one smaller can only be upscaled.
  const spec = specFor('og')
  assert.deepEqual(spec, { kind: 'og', width: 1200, height: 630, format: 'png' })

  const requested = requestSizeFor(spec)
  assert.deepEqual(requested, { width: 1200, height: 640 })

  const delivered = pngOfSize(requested.width, requested.height)
  const report = reportSizing(delivered, { width: spec.width, height: spec.height }, 'png')
  assert.equal(report.sizing, 'unsized', 'the row must say so rather than claim 630')
  assert.deepEqual(report.actual, { width: 1200, height: 640 })
})

test('unmeasurable bytes are `unknown`, which is a different repair from `unsized`', () => {
  // "we looked and it was wrong" and "we could not look" call for different actions.
  const report = reportSizing(Buffer.from('gateway timeout'), { width: 512, height: 512 }, 'png')
  assert.equal(report.sizing, 'unknown')
  assert.equal(report.actual, null)
})

/* --------------------------------------------------------------- the grid */

test('requestSizeFor rounds each dimension UP to the multiple of 16 FLUX delivers on', () => {
  assert.deepEqual(requestSizeFor({ width: 1024, height: 1024 }), { width: 1024, height: 1024 })
  assert.deepEqual(requestSizeFor({ width: 1024, height: 384 }), { width: 1024, height: 384 })
  assert.deepEqual(requestSizeFor({ width: 1280, height: 640 }), { width: 1280, height: 640 })
  assert.deepEqual(requestSizeFor({ width: 1200, height: 630 }), { width: 1200, height: 640 })
  assert.deepEqual(requestSizeFor({ width: 17, height: 17 }), { width: 32, height: 32 })
})

test('every declared size except the OG card is already on the grid', () => {
  // So every other kind can be delivered exactly, and only the one size a platform mandates is
  // the awkward one. Worth pinning: if a default size changes to something off-grid, this fails.
  const offGrid = Object.entries(DEFAULT_SIZES).filter(([, size]) => !isOnGrid(size))
  assert.deepEqual(offGrid.map(([kind]) => kind), ['og'])
})

/* --------------------------------------------------------------- specs */

test('a spec defaults to the design system size for its kind', () => {
  assert.deepEqual(specFor('mark'), { kind: 'mark', width: 1024, height: 1024, format: 'png' })
  assert.deepEqual(specFor('social'), { kind: 'social', width: 1280, height: 640, format: 'png' })
})

test('an unknown kind is refused, because the prompt is built from the kind', () => {
  assert.throws(() => specFor('sticker'), SpecError)
})

test('an out-of-range or fractional size is refused', () => {
  assert.throws(() => specFor('mark', { width: 8 }), SpecError)
  assert.throws(() => specFor('mark', { width: 99_999 }), SpecError)
  assert.throws(() => specFor('mark', { height: 512.5 }), SpecError)
  assert.throws(() => specFor('mark', { format: 'webp' }), SpecError)
})
