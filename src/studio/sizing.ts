/**
 * Sizing, in pure TypeScript, so the pipeline runs in CI.
 *
 * `asset-forge` shells out to macOS `sips` (`resize.ts`), which means the whole
 * post-processing stage exists only on one laptop: off macOS it degrades to a warning and every
 * asset ships at whatever the model returned. design-system.md §7 item 3 names the cost —
 * "twelve game masters currently sit at 1024² against declared 512²/256² because the refit has
 * never been run".
 *
 * ## What this file does, and the decision it records
 *
 * It **measures**. It does not resample.
 *
 * Resampling a PNG in pure TypeScript means writing a zlib-aware PNG decoder, a filter
 * reconstructor, a resampler and an encoder — several thousand lines whose bugs are silent, or a
 * native dependency (`sharp`) that needs a build toolchain in the image and a prebuilt binary per
 * platform. Neither is a good trade for a service whose generation path is currently blocked on
 * an Azure deployment that does not exist.
 *
 * So this service does what the brief for it says to do when a resize is out of reach: it reads
 * the **exact** dimensions out of the returned bytes and, when they do not match the declared
 * spec, records the asset as `unsized` with both numbers on the row. That is strictly better than
 * what the estate does today, which is to ship a 1024² file against a declared 512² spec with no
 * record that they differ — the defect is invisible there and it is a database column here.
 *
 * When a resampler is added, it slots in at `fit()` in the generation pipeline and the only
 * observable change is that `sizing` starts reading `exact`. Nothing else moves.
 *
 * Reading a PNG header is thirty lines and no dependency, because the dimensions are the first
 * eight bytes of the first chunk and that chunk is mandatory and uncompressed.
 */

/** How the delivered pixels relate to the declared spec. Stored on every asset row. */
export type Sizing = 'exact' | 'unsized' | 'unknown'

export interface Dimensions {
  readonly width: number
  readonly height: number
}

/** The eight bytes every PNG starts with. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Read a PNG's pixel dimensions from its IHDR chunk.
 *
 * Layout: 8-byte signature, then a chunk of `[length:4][type:4][data:length][crc:4]`. The first
 * chunk is required by the specification to be IHDR, and its first eight data bytes are width and
 * height as big-endian unsigned 32-bit integers. So the numbers live at fixed offsets 16 and 20,
 * and no decompression is involved.
 *
 * Returns null rather than throwing on anything unexpected: a backend that returned something
 * that is not a PNG is a fact to record on the asset (`sizing = 'unknown'`), not an exception
 * that loses a generation already paid for.
 */
export function pngDimensions(bytes: Buffer): Dimensions | null {
  if (bytes.length < 24) return null
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) return null
  // Bytes 12..16 are the chunk type. Anything other than IHDR here means the file is malformed or
  // is not a PNG despite the signature, and guessing past it would read two random integers.
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  // Zero is illegal in IHDR and would otherwise be recorded as a real measurement.
  if (width === 0 || height === 0) return null
  return { width, height }
}

/** `width="1024"` / `height="384"`, or the viewBox when the attributes are missing. */
const SVG_WIDTH = /<svg\b[^>]*?\bwidth\s*=\s*["']?\s*(\d+(?:\.\d+)?)/i
const SVG_HEIGHT = /<svg\b[^>]*?\bheight\s*=\s*["']?\s*(\d+(?:\.\d+)?)/i
const SVG_VIEWBOX = /<svg\b[^>]*?\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i

/**
 * Read an SVG's declared dimensions.
 *
 * An SVG has no intrinsic pixels, so this reports what the document declares. That is exactly the
 * right thing for this service's purposes: the placeholder backend authors the document at the
 * spec's size, so measuring the declaration proves it did.
 */
export function svgDimensions(bytes: Buffer): Dimensions | null {
  // Capped: this only ever needs the opening tag, and slicing keeps a large document from being
  // walked by three regular expressions.
  const head = bytes.subarray(0, 2048).toString('utf8')
  const width = SVG_WIDTH.exec(head)?.[1]
  const height = SVG_HEIGHT.exec(head)?.[1]
  if (width && height) {
    return { width: Math.round(Number(width)), height: Math.round(Number(height)) }
  }
  const box = SVG_VIEWBOX.exec(head)
  if (box?.[1] && box[2]) {
    return { width: Math.round(Number(box[1])), height: Math.round(Number(box[2])) }
  }
  return null
}

/** Dispatch on the format the spec asked for, not on sniffing: the format is a declared fact. */
export function measure(bytes: Buffer, format: 'png' | 'svg'): Dimensions | null {
  return format === 'png' ? pngDimensions(bytes) : svgDimensions(bytes)
}

export interface SizingReport {
  readonly sizing: Sizing
  /** Null when the bytes could not be measured at all. Never guessed from the spec. */
  readonly actual: Dimensions | null
  /** Human-readable, for the job log and the run report. Never a secret. */
  readonly note: string
}

/**
 * Compare what was delivered against what was declared.
 *
 * The three outcomes are deliberately distinct:
 *
 *   * `exact`   — measured, and it matches. The only state in which the declared size on the
 *                 asset row is a fact rather than an aspiration.
 *   * `unsized` — measured, and it does not match. Both numbers are kept. This is the state
 *                 twelve assets in the estate are in without anybody being able to tell.
 *   * `unknown` — could not be measured. Distinct from `unsized` because "we looked and it was
 *                 wrong" and "we could not look" call for different repairs.
 */
export function reportSizing(
  bytes: Buffer,
  declared: Dimensions,
  format: 'png' | 'svg',
): SizingReport {
  const actual = measure(bytes, format)
  if (!actual) {
    return {
      sizing: 'unknown',
      actual: null,
      note: `could not read ${format} dimensions from ${bytes.length} bytes`,
    }
  }
  if (actual.width === declared.width && actual.height === declared.height) {
    return { sizing: 'exact', actual, note: `${actual.width}x${actual.height} exact` }
  }
  return {
    sizing: 'unsized',
    actual,
    note:
      `delivered ${actual.width}x${actual.height} against a declared ` +
      `${declared.width}x${declared.height}; recorded unsized rather than relabelled`,
  }
}
