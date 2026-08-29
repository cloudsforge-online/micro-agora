/**
 * Hostile-input handling for user-uploaded images: sniff, bound, and strip.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY FUNCTION HERE TREATS ITS INPUT AS AN ATTACK.** This is the one module in `studio` that
 * accepts bytes chosen by a stranger. The service custodies real money elsewhere in the estate, so
 * an upload path that is merely "probably fine" is the wrong shape.
 *
 * Four decisions, each of which exists because the obvious alternative is exploitable:
 *
 *   1. **The format is read from the BYTES, never from `Content-Type`.** A header is a claim by the
 *      uploader. `sniff()` matches magic numbers and nothing else, so a `.png` named file declaring
 *      `image/png` and containing something else is refused on its contents.
 *
 *   2. **SVG IS REFUSED, LOUDLY AND BY NAME.** An SVG is a script host — `<script>`, `onload=`,
 *      `<foreignObject>`, external entity references — and serving one from an origin that holds a
 *      session is stored XSS, not a picture. It is called out with its own reason code rather than
 *      falling through to "unrecognised" so the refusal is legible in a log and assertable in a
 *      test. Note that `placeholder.ts` still PRODUCES svg: that is our own deterministic output on
 *      a trusted path, and it is never something a user handed us.
 *
 *   3. **Dimensions are read from the header and bounded BEFORE anything decodes.** A 32-bit width
 *      times a 32-bit height is a decompression bomb: a few kilobytes of highly-compressed pixels
 *      that expand to gigabytes in whatever finally rasterises them. Checking after decoding is
 *      checking after the damage. Nothing in this module decodes pixels at all, and the bound is
 *      enforced on the declared numbers so the bomb never reaches a consumer that would.
 *
 *   4. **Metadata is dropped by ALLOWLIST, not by blocklist.** A phone photograph carries EXIF GPS
 *      to six decimal places. Publishing that on a crypto platform deanonymises the person who
 *      uploaded it — it is a privacy breach with a physical address attached, not an untidiness. A
 *      blocklist of "the tags we know about" fails open on the next container anyone invents; an
 *      allowlist of the chunks needed to RENDER the image fails closed.
 *
 * The checksum the rest of the service stores is taken over the output of `normalise()` — the
 * stripped bytes — and never over the bytes as uploaded. That ordering is load-bearing: it means
 * the content address identifies what we actually serve, two uploads of the same picture carrying
 * different GPS traces deduplicate to one asset, and no stored digest is ever a digest of somebody's
 * coordinates.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** The formats a user may upload. `svg` is deliberately absent — see the header. */
export type UploadFormat = 'png' | 'jpeg' | 'webp'

/** The media type each format is served as. Fixed strings; never echoed from the request. */
export const MEDIA_TYPES: Readonly<Record<UploadFormat, string>> = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
})

/**
 * Why an upload was refused. A closed set, so the HTTP layer maps a reason rather than a message,
 * and a test can assert the specific refusal instead of "it 400'd for some reason".
 */
export type RejectionReason =
  | 'empty'
  | 'too_large'
  | 'svg_refused'
  | 'unrecognised_format'
  | 'dimensions_unreadable'
  | 'dimensions_out_of_range'
  | 'pixel_budget_exceeded'
  | 'truncated'

export class UploadRejected extends Error {
  readonly reason: RejectionReason

  constructor(reason: RejectionReason, message: string) {
    super(message)
    this.name = 'UploadRejected'
    this.reason = reason
  }
}

/**
 * Byte ceiling for one upload. Enforced by the HTTP layer WHILE reading, not after — a limit
 * checked after buffering is a memory-exhaustion primitive with a polite error message.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

/** Smallest and largest edge accepted, in pixels. */
export const MIN_UPLOAD_DIMENSION = 8
export const MAX_UPLOAD_DIMENSION = 8192

/**
 * The decompression-bomb bound, and the one that actually bites.
 *
 * Two edges can each be under `MAX_UPLOAD_DIMENSION` and still multiply out to 67 megapixels,
 * which is roughly 268 MB once something expands it to RGBA. The area is therefore bounded
 * separately from the edges. 40 megapixels is comfortably above any phone or camera an ordinary
 * user will upload from and far below the point at which a decoder becomes a denial of service.
 */
export const MAX_UPLOAD_PIXELS = 40_000_000

export interface Dimensions {
  readonly width: number
  readonly height: number
}

export interface NormalisedUpload {
  readonly format: UploadFormat
  readonly bytes: Buffer
  readonly width: number
  readonly height: number
  /** Bytes removed by stripping. Reported so a log can show the strip did something. */
  readonly strippedBytes: number
}

/* ------------------------------------------------------------------------ sniffing */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

/**
 * Does this look like SVG or XML?
 *
 * Checked BEFORE the format sniff and answered with its own reason, because an SVG is the one
 * refusal a caller is most likely to make by accident and most dangerous to let through. Leading
 * whitespace and a BOM are skipped, and a UTF-16 encoded document is caught too: `<` as UTF-16LE
 * is `3C 00`, which would otherwise slip past a naive ASCII comparison and still be parsed as
 * markup by a browser told it was XML.
 */
export function looksLikeMarkup(bytes: Buffer): boolean {
  let start = 0
  // UTF-8 BOM.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3
  // UTF-16 BOMs. Anything text-shaped in a 16-bit encoding is markup for our purposes.
  if (bytes.length >= 2) {
    const b0 = bytes[0]
    const b1 = bytes[1]
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) return true
  }
  const head = bytes.subarray(start, start + 1024).toString('latin1')
  // Strip leading whitespace only; anything else before a '<' means this is not a markup document.
  // The NUL in the class is spelled `\u0000` rather than written as the byte: a source file holding
  // a raw NUL is not the text it appears to be — `grep` skips it in silence and micro-conformance's
  // body scan refuses it, taking the estate-wide route scan with it (micro-org#262). Same class,
  // either way; only one spelling survives being read.
  const trimmed = head.replace(/^[\s\u0000]+/, '')
  if (!trimmed.startsWith('<')) return false
  return /<\s*(\?xml|svg|!doctype\s+svg|!--)/i.test(trimmed)
}

/**
 * The format these bytes actually are, or `null`.
 *
 * WebP is a RIFF container: `RIFF` at 0, the four-character type `WEBP` at 8. Both are required —
 * matching only `RIFF` would accept a WAV file as an image.
 */
export function sniff(bytes: Buffer): UploadFormat | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'png'
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_MAGIC)) return 'jpeg'
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

/* ------------------------------------------------------------------------ dimensions */

/** PNG: IHDR is mandatory, first, and uncompressed. Width and height sit at fixed offsets. */
export function pngSize(bytes: Buffer): Dimensions | null {
  if (bytes.length < 24) return null
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * JPEG: walk the segment chain to a Start Of Frame marker.
 *
 * There is no fixed offset — the frame header sits after an arbitrary run of application and
 * quantisation segments — so the chain is walked. `SOF0` through `SOF15` all carry the size in the
 * same place, EXCEPT `DHT` (0xC4), `JPG` (0xC8) and `DAC` (0xCC), which share the numeric range and
 * are not frame headers at all. Missing that exclusion reads two bytes of a Huffman table as a
 * picture size.
 */
export function jpegSize(bytes: Buffer): Dimensions | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === undefined) return null
    // Padding and standalone markers carry no length.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2) return null
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      if (offset + 9 >= bytes.length) return null
      const height = bytes.readUInt16BE(offset + 5)
      const width = bytes.readUInt16BE(offset + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    // Start of scan: the entropy-coded data begins and there is no frame header after it.
    if (marker === 0xda) return null
    offset += 2 + length
  }
  return null
}

/**
 * WebP: three different encodings of the size, one per chunk type.
 *
 *   * `VP8X` — the extended container. Canvas size as two 24-bit little-endian values, each
 *     stored minus one.
 *   * `VP8L` — lossless. A 0x2f signature byte, then 14 bits of width-1 and 14 bits of height-1
 *     packed little-endian across the next four bytes.
 *   * `VP8 ` — lossy. A three-byte frame tag, the `9d 01 2a` start code, then two 16-bit
 *     little-endian values whose low 14 bits are the dimensions.
 */
export function webpSize(bytes: Buffer): Dimensions | null {
  for (const chunk of riffChunks(bytes)) {
    if (chunk.id === 'VP8X') {
      if (chunk.data.length < 10) return null
      const width = (chunk.data.readUIntLE(4, 3) & 0xffffff) + 1
      const height = (chunk.data.readUIntLE(7, 3) & 0xffffff) + 1
      return { width, height }
    }
    if (chunk.id === 'VP8L') {
      if (chunk.data.length < 5 || chunk.data[0] !== 0x2f) return null
      const bits = chunk.data.readUInt32LE(1)
      const width = (bits & 0x3fff) + 1
      const height = ((bits >> 14) & 0x3fff) + 1
      return { width, height }
    }
    if (chunk.id === 'VP8 ') {
      if (chunk.data.length < 10) return null
      if (chunk.data[3] !== 0x9d || chunk.data[4] !== 0x01 || chunk.data[5] !== 0x2a) return null
      const width = chunk.data.readUInt16LE(6) & 0x3fff
      const height = chunk.data.readUInt16LE(8) & 0x3fff
      return width > 0 && height > 0 ? { width, height } : null
    }
  }
  return null
}

export function readSize(bytes: Buffer, format: UploadFormat): Dimensions | null {
  if (format === 'png') return pngSize(bytes)
  if (format === 'jpeg') return jpegSize(bytes)
  return webpSize(bytes)
}

/* ------------------------------------------------------------------------ stripping */

/**
 * PNG chunks kept. An ALLOWLIST — see decision 4 in the header.
 *
 * These are the chunks a renderer needs to produce the right pixels in the right colours. Notably
 * absent: `tEXt`, `zTXt` and `iTXt`, which carry arbitrary key/value text and are where XMP (with
 * its own GPS fields) lives; `eXIf`, which is EXIF by definition; and `tIME`, which is a timestamp
 * nobody asked us to publish. Anything not named here — including a chunk type invented after this
 * was written — is dropped, which is the direction that stays safe as the format grows.
 */
const PNG_KEEP = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'sBIT',
  'bKGD',
  'pHYs',
])

function stripPng(bytes: Buffer): Buffer {
  const out: Buffer[] = [bytes.subarray(0, 8)]
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    // A length that overruns the buffer means the file is truncated or lying. Stop rather than
    // read past the end; the caller re-measures the result and refuses it if it is now unreadable.
    if (length > bytes.length - offset - 12) break
    const id = bytes.toString('latin1', offset + 4, offset + 8)
    const end = offset + 12 + length
    if (PNG_KEEP.has(id)) out.push(bytes.subarray(offset, end))
    offset = end
    if (id === 'IEND') break
  }
  return Buffer.concat(out)
}

/**
 * JPEG segments dropped, by marker.
 *
 *   * `APP1`  (0xe1) — EXIF, and XMP. The GPS carrier, and the whole reason this exists.
 *   * `APP13` (0xed) — Photoshop IRB / IPTC, which has its own location fields.
 *   * `COM`   (0xfe) — free-text comment.
 *
 * `APP0` (JFIF), `APP2` (ICC colour profile) and `APP14` (Adobe colour transform) are KEPT: none
 * can carry location data, and dropping the latter two visibly changes the colours of the image
 * the user uploaded. Stripping metadata is not licence to alter the picture.
 */
const JPEG_DROP = new Set([0xe1, 0xed, 0xfe])

function stripJpeg(bytes: Buffer): Buffer {
  const out: Buffer[] = [bytes.subarray(0, 2)]
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break
    const marker = bytes[offset + 1]
    if (marker === undefined) break
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      out.push(bytes.subarray(offset, offset + 2))
      offset += 2
      continue
    }
    /**
     * Start of scan. The entropy-coded image data begins here and is not framed, so segment
     * parsing cannot continue through it.
     *
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **IT IS COPIED UP TO THE END-OF-IMAGE MARKER, NOT TO THE END OF THE FILE.**
     *
     * Copying to the end was the first version and it left this format inconsistent with the other
     * two: `stripPng` stops at `IEND` and `stripWebp` rebuilds from parsed chunks, so both discard
     * anything appended after the image. JPEG kept it — and everything a stripper is for can be
     * appended there. Some cameras and editors write a second EXIF block or a thumbnail past
     * `EOI`, which is exactly the location data this function exists to remove; and a file with an
     * archive concatenated onto a valid image is the standard polyglot trick.
     *
     * Scanning for `FFD9` is sound rather than approximate: inside entropy-coded data every `FF`
     * is byte-stuffed as `FF00` or is a restart marker (`FFD0`–`FFD7`), so the first `FFD9` after
     * the scan is genuinely the one and only end-of-image. A progressive JPEG has several scans
     * and still exactly one `EOI`.
     *
     * A file with no `EOI` at all is truncated. The tail is kept in that case rather than
     * discarded — throwing away the only copy of somebody's image because its last two bytes are
     * missing helps nobody — and `normalise` re-measures afterwards, so a file too damaged to read
     * is still refused.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    if (marker === 0xda) {
      const end = endOfImage(bytes, offset)
      out.push(end === -1 ? bytes.subarray(offset) : bytes.subarray(offset, end))
      break
    }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > bytes.length) break
    const end = offset + 2 + length
    if (!JPEG_DROP.has(marker)) out.push(bytes.subarray(offset, end))
    offset = end
  }
  return Buffer.concat(out)
}

/**
 * The offset just past the `FFD9` end-of-image marker at or after `from`, or `-1`.
 *
 * Returns the position AFTER the marker, so a caller slicing to it keeps the `EOI` itself — a JPEG
 * without one is a JPEG some decoders complain about.
 */
function endOfImage(bytes: Buffer, from: number): number {
  for (let i = from; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return i + 2
  }
  return -1
}

interface RiffChunk {
  readonly id: string
  readonly data: Buffer
  readonly start: number
  readonly end: number
}

/** Walk a RIFF chunk list. Each chunk is `[id:4][size:4][data:size][pad to even]`. */
function* riffChunks(bytes: Buffer): Generator<RiffChunk> {
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    if (size > bytes.length - dataStart) return
    const dataEnd = dataStart + size
    // RIFF pads odd-length chunks to an even boundary.
    const end = dataEnd + (size % 2)
    yield { id, data: bytes.subarray(dataStart, dataEnd), start: offset, end }
    offset = end
  }
}

/**
 * WebP: drop the `EXIF` and `XMP ` chunks, rebuild the RIFF header, and clear the flag bits.
 *
 * Clearing the `VP8X` flags is the half that is easy to miss and breaks decoders: the extended
 * header declares which optional chunks are present, so removing the chunks while leaving the bits
 * set produces a file that announces metadata a reader will then go looking for and not find.
 */
function stripWebp(bytes: Buffer): Buffer {
  const kept: Buffer[] = []
  for (const chunk of riffChunks(bytes)) {
    if (chunk.id === 'EXIF' || chunk.id === 'XMP ') continue
    if (chunk.id === 'VP8X' && chunk.data.length >= 1) {
      const copy = Buffer.from(bytes.subarray(chunk.start, chunk.end))
      // Byte 8 of the chunk is the first data byte: the flags. Exif is 0x08, XMP is 0x04.
      copy[8] = (copy[8] ?? 0) & ~0x0c
      kept.push(copy)
      continue
    }
    kept.push(bytes.subarray(chunk.start, chunk.end))
  }
  const body = Buffer.concat(kept)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'latin1')
  // The RIFF size counts the `WEBP` four-character code plus every chunk that follows it.
  header.writeUInt32LE(body.length + 4, 4)
  header.write('WEBP', 8, 'latin1')
  return Buffer.concat([header, body])
}

/* ------------------------------------------------------------------------ the gate */

/**
 * Sniff, bound, strip, re-measure. The single entry point; nothing else in the service touches
 * uploaded bytes.
 *
 * The order is the design. SVG is refused before anything else so it can never be mistaken for a
 * container we understand. Dimensions are read and bounded before the strip so a bomb is refused
 * without being processed. And the result is **re-measured after stripping**, which is the check
 * that makes the strip itself trustworthy: if rebuilding the file produced something whose header
 * no longer parses, that is a bug in this module, and it is refused here rather than stored and
 * served as a broken image.
 */
export function normalise(input: Buffer): NormalisedUpload {
  if (input.length === 0) throw new UploadRejected('empty', 'the uploaded file is empty')
  if (input.length > MAX_UPLOAD_BYTES) {
    throw new UploadRejected(
      'too_large',
      `an upload may be at most ${MAX_UPLOAD_BYTES} bytes (got ${input.length})`,
    )
  }

  if (looksLikeMarkup(input)) {
    throw new UploadRejected(
      'svg_refused',
      'SVG and XML uploads are refused: an SVG is a script document, and serving one from this ' +
        'origin would be stored cross-site scripting. Upload a PNG, JPEG or WebP instead',
    )
  }

  const format = sniff(input)
  if (!format) {
    throw new UploadRejected(
      'unrecognised_format',
      'the file is not a PNG, JPEG or WebP — the format is read from the file contents, not from ' +
        'the Content-Type header or the filename',
    )
  }

  const declared = readSize(input, format)
  if (!declared) {
    throw new UploadRejected(
      'dimensions_unreadable',
      `the ${format} header does not carry a readable pixel size, so the file is malformed`,
    )
  }
  assertWithinBudget(declared)

  const stripped =
    format === 'png' ? stripPng(input) : format === 'jpeg' ? stripJpeg(input) : stripWebp(input)

  // Re-measured, not assumed. See the doc comment.
  const actual = readSize(stripped, format)
  if (!actual) {
    throw new UploadRejected(
      'truncated',
      `the ${format} could not be re-read after metadata was removed, so it was malformed or ` +
        'truncated to begin with',
    )
  }
  if (actual.width !== declared.width || actual.height !== declared.height) {
    throw new UploadRejected(
      'truncated',
      `the ${format} reported ${declared.width}x${declared.height} before stripping and ` +
        `${actual.width}x${actual.height} after, so its headers disagree with each other`,
    )
  }

  return {
    format,
    bytes: stripped,
    width: actual.width,
    height: actual.height,
    strippedBytes: input.length - stripped.length,
  }
}

function assertWithinBudget(size: Dimensions): void {
  for (const [name, value] of [
    ['width', size.width],
    ['height', size.height],
  ] as const) {
    if (
      !Number.isInteger(value) ||
      value < MIN_UPLOAD_DIMENSION ||
      value > MAX_UPLOAD_DIMENSION
    ) {
      throw new UploadRejected(
        'dimensions_out_of_range',
        `${name} must be between ${MIN_UPLOAD_DIMENSION} and ${MAX_UPLOAD_DIMENSION} pixels ` +
          `(the file declares ${value})`,
      )
    }
  }
  // Checked on the DECLARED numbers, before anything expands them. See decision 3 in the header.
  const pixels = size.width * size.height
  if (pixels > MAX_UPLOAD_PIXELS) {
    throw new UploadRejected(
      'pixel_budget_exceeded',
      `${size.width}x${size.height} is ${pixels} pixels, above the ${MAX_UPLOAD_PIXELS} budget — ` +
        'refused before decoding, because an image this size is a decompression bomb regardless ' +
        'of how few bytes it arrived as',
    )
  }
}
