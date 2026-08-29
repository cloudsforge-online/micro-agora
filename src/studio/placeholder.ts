/**
 * The deterministic placeholder, as `asset-forge` does offline.
 *
 * **This is what runs today.** The provided Azure resource authenticates and has zero model
 * deployments, so no real image can be generated at all; a service that answered 503 to every
 * generation request until somebody created a deployment would be a service nobody could build
 * the rest of Forge Create against. A labelled placeholder is honest — it says `placeholder` on
 * its face, the asset row records `backend='placeholder'`, and `GET /v1/backend` says why no
 * model was reachable.
 *
 * Two properties matter and both are tested:
 *
 *   1. **Deterministic.** The same spec and the same kit produce byte-identical output. A
 *      placeholder that changed on every run would make every asset checksum meaningless and
 *      every diff noise.
 *   2. **Exactly the declared size.** The SVG is authored at the spec's pixels, so a placeholder
 *      is always `sizing = 'exact'`. It is the one path in this service that cannot produce an
 *      `unsized` asset, which makes it a useful control when reading a sizing report.
 *
 * It draws in the kit's own accent on the design system's ash ground, so an offline run previews
 * what the paid run will produce rather than a grey box that tells you nothing.
 */

import { BRAND_GROUND } from './prompt.ts'
import type { AssetKind, AssetSpec } from './specs.ts'

/** Bone. The one foreground colour, from the design system's neutral ramp. */
const INK = '#e7e2d3'

export interface PlaceholderInput {
  readonly kitName: string
  readonly accent: string
  readonly spec: AssetSpec
}

/** Small, stable string hash (djb2). Stable across processes and versions of Node, unlike any
 *  hash derived from object iteration order. */
function hash(input: string): number {
  let h = 5381
  for (let i = 0; i < input.length; i += 1) h = (h * 33) ^ input.charCodeAt(i)
  return h >>> 0
}

function escapeXml(value: string): string {
  return value.replace(
    /[<>&'"]/g,
    (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c,
  )
}

/** Two decimals, and never `-0`. `toFixed` on a negative zero emits `-0.00`, which would make two
 *  runs of the same input differ in bytes depending on how a coordinate rounded. */
function n(value: number): string {
  const fixed = value.toFixed(2)
  return fixed === '-0.00' ? '0.00' : fixed
}

/** One motif per kind, varied by the seed. Deliberately simple: this is a stand-in, not art. */
function glyph(kind: AssetKind, cx: number, cy: number, r: number, seed: number, accent: string): string {
  const sw = Math.max(2, r * 0.06)
  switch (kind) {
    case 'tile': {
      const rings = 2 + (seed % 3)
      return Array.from({ length: rings }, (_, i) => {
        const rr = r * (1 - i / (rings + 0.5))
        return (
          `<rect x="${n(cx - rr)}" y="${n(cy - rr)}" width="${n(rr * 2)}" height="${n(rr * 2)}" ` +
          `transform="rotate(45 ${n(cx)} ${n(cy)})" fill="none" stroke="${accent}" ` +
          `stroke-width="${n(sw)}" opacity="${n(0.9 - i * 0.2)}"/>`
        )
      }).join('')
    }
    // A world object stand-in: the 2:1 dimetric footprint the real asset sits on, with a body
    // above it. Drawn as the projection rather than as a shape, because the one thing a
    // placeholder here has to communicate is which way the world is facing.
    case 'world_object': {
      const w = r * 0.9
      const h = w / 2
      const lift = r * (0.35 + (seed % 3) * 0.12)
      const dia = (x: number, y: number): string =>
        `${n(x)},${n(y - h)} ${n(x + w)},${n(y)} ${n(x)},${n(y + h)} ${n(x - w)},${n(y)}`
      return (
        `<polygon points="${dia(cx, cy + r * 0.45)}" fill="none" stroke="${accent}" ` +
        `stroke-width="${n(sw)}" opacity="0.55"/>` +
        `<polygon points="${dia(cx, cy + r * 0.45 - lift)}" fill="${accent}" opacity="0.25"/>` +
        `<polygon points="${dia(cx, cy + r * 0.45 - lift)}" fill="none" stroke="${accent}" ` +
        `stroke-width="${n(sw)}"/>` +
        `<line x1="${n(cx - w)}" y1="${n(cy + r * 0.45)}" x2="${n(cx - w)}" ` +
        `y2="${n(cy + r * 0.45 - lift)}" stroke="${accent}" stroke-width="${n(sw)}"/>` +
        `<line x1="${n(cx + w)}" y1="${n(cy + r * 0.45)}" x2="${n(cx + w)}" ` +
        `y2="${n(cy + r * 0.45 - lift)}" stroke="${accent}" stroke-width="${n(sw)}"/>`
      )
    }
    case 'icon':
    case 'favicon': {
      const points = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 6
        return `${n(cx + r * Math.cos(a))},${n(cy + r * Math.sin(a))}`
      }).join(' ')
      return (
        `<polygon points="${points}" fill="none" stroke="${accent}" stroke-width="${n(sw)}"/>` +
        `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.32)}" fill="${accent}" opacity="0.85"/>`
      )
    }
    case 'og':
    case 'social':
    case 'banner':
    case 'wordmark': {
      // A lockup stand-in: the mark, then a rule where the lettering would sit.
      const bar = r * 0.18
      return (
        `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.55)}" fill="none" stroke="${accent}" ` +
        `stroke-width="${n(sw)}"/>` +
        `<rect x="${n(cx + r * 0.9)}" y="${n(cy - bar / 2)}" width="${n(r * 1.6)}" ` +
        `height="${n(bar)}" fill="${accent}" opacity="0.8"/>`
      )
    }
    case 'mark':
    default: {
      const rays = 10
      const spokes = Array.from({ length: rays }, (_, i) => {
        const a = (2 * Math.PI * i) / rays
        return (
          `<line x1="${n(cx + r * 0.55 * Math.cos(a))}" y1="${n(cy + r * 0.55 * Math.sin(a))}" ` +
          `x2="${n(cx + r * 0.85 * Math.cos(a))}" y2="${n(cy + r * 0.85 * Math.sin(a))}" ` +
          `stroke="${accent}" stroke-width="${n(sw)}"/>`
        )
      }).join('')
      return (
        `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.4)}" fill="none" stroke="${accent}" ` +
        `stroke-width="${n(sw)}"/>${spokes}`
      )
    }
  }
}

/**
 * Build the placeholder SVG. Pure: same input, same bytes, for ever.
 *
 * The label on the face is not decoration. An unlabelled placeholder that reaches a marketing page
 * looks like a design decision; one that says `placeholder` on it is found the first time somebody
 * looks at the page.
 */
export function placeholderSvg(input: PlaceholderInput): string {
  const { width: w, height: h } = input.spec
  const seed = hash(`${input.kitName}|${input.spec.kind}|${w}x${h}|${input.accent}`)
  const accent = input.accent
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) * 0.26

  const pad = Math.max(8, Math.min(w, h) * 0.03)
  const fontLabel = Math.max(14, Math.min(w, h) * 0.06)
  const fontMeta = Math.max(10, Math.min(w, h) * 0.032)
  const label = `${input.kitName} ${input.spec.kind}`

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeXml(label)} placeholder">
  <rect width="${w}" height="${h}" fill="${BRAND_GROUND}"/>
  <rect x="${n(pad)}" y="${n(pad)}" width="${n(w - pad * 2)}" height="${n(h - pad * 2)}" fill="none" stroke="${accent}" stroke-width="${n(Math.max(2, pad * 0.25))}" opacity="0.6"/>
  <g>${glyph(input.spec.kind, cx, cy - fontLabel, r, seed, accent)}</g>
  <text x="${n(cx)}" y="${n(h - pad - fontMeta * 1.4)}" font-family="monospace" font-size="${n(fontLabel)}" font-weight="bold" fill="${INK}" text-anchor="middle">${escapeXml(label)}</text>
  <text x="${n(cx)}" y="${n(h - pad - fontMeta * 0.2)}" font-family="monospace" font-size="${n(fontMeta)}" fill="${INK}" text-anchor="middle" opacity="0.7">placeholder · ${w}x${h}</text>
</svg>
`
}
