/**
 * `asset_spec` — kind, exact pixel size, format.
 *
 * A spec is a **value**, not an entity. It has no lifecycle, nothing holds a reference to one, and
 * a `asset_specs` table would buy a join plus the risk that editing a spec row retroactively
 * changes what a delivered asset claims to be. So it is three columns on the job and on the asset,
 * and this file holds the catalogue of defaults per kind.
 *
 * ## Where the sizes come from, and why two of them are not negotiable
 *
 * From assets/design-system.md §7: mark 1024², wordmark 1024x384, favicon 512, OG 1200x630,
 * social 1280x640, apple-touch-icon. Two of these are platform requirements rather than taste:
 *
 *   * **OG must be 1200x630.** A scraper rejects anything else, so the card does not render.
 *   * **The GitHub social preview must be 1280x640.** Likewise.
 *
 * FLUX honours `width`/`height` — verified — so most of these come back exactly. But it **floors
 * each dimension to a multiple of 16**, also verified: asking for `1200x630` delivers `1200x624`,
 * and asking for `1200x632` also delivers `1200x624`. `1280x640` is exact because 640 divides by
 * 16; `630` does not, and it is the one size a platform will reject for being wrong.
 *
 * That is what `requestSizeFor` is for, and it rounds **up**. See the note on it.
 */

export const ASSET_KINDS = [
  'mark',
  'wordmark',
  'favicon',
  'og',
  'social',
  'banner',
  'icon',
  'tile',
  /**
   * A single object in a user-made world, fired from a player's description.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **THE ONE KIND IN THIS CATALOGUE THAT IS NOT A BRAND ARTEFACT**, and the distinction is
   * load-bearing rather than taxonomic. Every kind above it is a mark, a lockup or a tile for one
   * brand kit, so its prompt is built from that kit — the accent, the name, the one idea. A world
   * object belongs to a *place*, not to a brand: `micro-tessera`'s Kiln (23-tessera.md §2.6, §9.1)
   * turns "a stool" into an object that has to sit in the same world as ninety-five others made by
   * other people on other days.
   *
   * That is why `prompt.ts` gives it its OWN style paragraph rather than `brandStyle()`. A world
   * object rendered to the brand brief — "Brand mark for a software company, flat geometric
   * vector… legible at 16 pixels" — comes back a logo of a stool, and it would come back a logo of
   * a stool while every test in this repository stayed green, because nothing here reads a prompt
   * for meaning. The kind is what the prompt is built from, which is the reason `specFor` refuses
   * an invented kind instead of defaulting one.
   *
   * 512×512, from 23-tessera.md §2.1: a 1×1 object occupies one 256×128 ground tile and is
   * authored with three tiles of headroom so a lamp-post fits. Already on the 16-pixel grid FLUX
   * floors to, so `requestSizeFor` rounds nothing.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  'world_object',
  /**
   * A wide header image for a piece of CONTENT — a prediction market, an article, a listing.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **THE SECOND KIND THAT IS NOT A BRAND ARTEFACT, AND IT EXISTS BECAUSE THE OBVIOUS ALTERNATIVE
   * PRODUCES CONFIDENT NONSENSE.**
   *
   * The first attempt at Foresight's market covers used `banner`. That is a brand kind: its style
   * paragraph is `brandStyle()` — "Brand mark for a software company … legible at 16 pixels" — and
   * `banner` is in `LETTERED`, so `prompt.ts` also instructs the model to set the KIT NAME as type.
   * Run "Will the Coinbase BTC-USD spot price be at or above 70,000 USD" through that and what
   * comes back is a corporate logo with `seed:foresight-8f3a1c` lettered across it. It comes back
   * looking deliberate, and nothing in this service reads a prompt for meaning, so it would have
   * been wrong quietly — the same failure `world_object` records one entry above.
   *
   * So `cover` takes its own style paragraph and is deliberately NOT in `LETTERED`. That second
   * part is load-bearing rather than tidy: `NO_TEXT` forbids numerals and currency symbols, and
   * these covers sit beside markets about prices and dates. A generated banner reading "$70,000"
   * next to a real market on a platform that custodies money is a number a user could act on that
   * nobody wrote and no contract backs.
   *
   * 1536x512 — three to one, already on the 16-pixel grid FLUX floors to, so `requestSizeFor`
   * rounds nothing and the delivery is `exact`.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  'cover',
] as const

export type AssetKind = (typeof ASSET_KINDS)[number]

export type AssetFormat = 'png' | 'svg'

export interface AssetSpec {
  readonly kind: AssetKind
  readonly width: number
  readonly height: number
  readonly format: AssetFormat
}

export function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value)
}

export function isAssetFormat(value: string): value is AssetFormat {
  return value === 'png' || value === 'svg'
}

/**
 * The declared size for each kind, from design-system.md §7.
 *
 * A caller may override width and height per request — a favicon source at 192 is a legitimate
 * ask — but it may not invent a kind, because the kind is what the prompt is built from.
 */
export const DEFAULT_SIZES: Readonly<Record<AssetKind, { width: number; height: number }>> =
  Object.freeze({
    mark: { width: 1024, height: 1024 },
    wordmark: { width: 1024, height: 384 },
    favicon: { width: 512, height: 512 },
    /** Open Graph / Twitter card. Scrapers reject anything that is not exactly this. */
    og: { width: 1200, height: 630 },
    /** GitHub repository social preview. Rejected unless exactly this. */
    social: { width: 1280, height: 640 },
    banner: { width: 1536, height: 512 },
    icon: { width: 256, height: 256 },
    tile: { width: 512, height: 512 },
    /** 23-tessera.md §2.1. One tile of floor, three tiles of headroom. */
    world_object: { width: 512, height: 512 },
    /** 3:1, and both edges divide by 16, so the delivery is exact rather than floored. */
    cover: { width: 1536, height: 512 },
  })

/** Bounds on a caller-supplied size. Generous, but a spec is interpolated into a raster buffer. */
export const MIN_DIMENSION = 16
export const MAX_DIMENSION = 4096

export class SpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecError'
  }
}

/** Build and validate one spec. Throws `SpecError`, which the HTTP layer maps to 400. */
export function specFor(
  kind: string,
  overrides: { width?: number | undefined; height?: number | undefined; format?: string | undefined } = {},
): AssetSpec {
  if (!isAssetKind(kind)) {
    throw new SpecError(`kind must be one of ${ASSET_KINDS.join(', ')} (got ${kind})`)
  }
  const defaults = DEFAULT_SIZES[kind]
  const width = overrides.width ?? defaults.width
  const height = overrides.height ?? defaults.height
  for (const [name, value] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (!Number.isInteger(value) || value < MIN_DIMENSION || value > MAX_DIMENSION) {
      throw new SpecError(
        `${name} must be a whole number between ${MIN_DIMENSION} and ${MAX_DIMENSION} (got ${value})`,
      )
    }
  }
  const format = overrides.format ?? 'png'
  if (!isAssetFormat(format)) throw new SpecError(`format must be png or svg (got ${format})`)
  return { kind, width, height, format }
}

/** `1024x1024`. The spelling every image API uses for a size, and the one stored on the job. */
export function sizeString(spec: { width: number; height: number }): string {
  return `${spec.width}x${spec.height}`
}

export function parseSize(size: string): { width: number; height: number } | null {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(size)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 1 || height < 1) return null
  return { width, height }
}

/**
 * FLUX floors each delivered dimension to a multiple of this. Measured, not documented:
 *
 *   request 1024x1024 → 1024x1024     request 1200x630 → 1200x624
 *   request 1024x384  → 1024x384      request 1200x632 → 1200x624
 *   request 1280x640  → 1280x640      request 256x256  → 256x256
 */
export const DIMENSION_GRANULARITY = 16

/**
 * The size to *ask* the model for, given the size the spec must end up at.
 *
 * Each dimension is rounded **up** to the next multiple of 16. Up rather than down, because the
 * two directions are not symmetric: an image larger than the spec can be centre-cropped to the
 * spec later without inventing a pixel, whereas one smaller than the spec can only be upscaled,
 * which is the operation that turns a crisp vector edge into a soft one.
 *
 * So an OG card declared at 1200x630 is asked for as 1200x640 and delivered at 1200x640. It is
 * recorded as `unsized` — see sizing.ts — because 640 is not 630 and this service does not
 * relabel a file to match the number somebody wanted. It is croppable, and the row says so.
 */
export function requestSizeFor(spec: { width: number; height: number }): {
  width: number
  height: number
} {
  const roundUp = (value: number): number => {
    const rounded = Math.ceil(value / DIMENSION_GRANULARITY) * DIMENSION_GRANULARITY
    // Never past the bound the spec itself is held to, or a legal spec would produce an illegal
    // request. MAX_DIMENSION is a multiple of 16, so this clamp can only bite at the very top.
    return Math.min(rounded, MAX_DIMENSION)
  }
  return { width: roundUp(spec.width), height: roundUp(spec.height) }
}

/** True when a spec's own size is already on the grid, so the delivery can be exact. */
export function isOnGrid(spec: { width: number; height: number }): boolean {
  return spec.width % DIMENSION_GRANULARITY === 0 && spec.height % DIMENSION_GRANULARITY === 0
}
