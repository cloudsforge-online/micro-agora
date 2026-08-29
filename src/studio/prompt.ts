/**
 * The prompt, derived from the brand kit rather than hand-written per asset.
 *
 * assets/design-system.md §7 states the brand style that generated art must match:
 *
 *   > flat geometric vector, warm ash ground `#12100f`, single accent from the registry, no
 *   > gradients, no photographic texture, no text in the mark.
 *
 * and names the defect this file exists to prevent: `asset-forge` bakes `#ff4d00` into
 * `BRAND_STYLE`, so every surface's mark is drawn in the site's accent rather than its own, and
 * Hearth's mark is generated in the *game* art style, which is why it does not visually match its
 * siblings. The fix stated there is "make the track derive from the registry rather than from a
 * hand-written spec" — here, the registry is the `brand_kit` row, and the accent is a column.
 *
 * ## The prompt is stored, not recomputed
 *
 * `buildPrompt` runs once, when the job is created, and the exact string is written to
 * `generation_jobs.prompt`. Recomputing it at read time would mean that editing this file changes
 * what a delivered asset claims to have been generated from — which is precisely the
 * irreproducibility 04-domain-model §5.1 calls out.
 */

import type { AssetKind, AssetSpec } from './specs.ts'

/** The one ground colour the whole system sits on. design-system.md §7, verbatim. */
export const BRAND_GROUND = '#12100f'

/** Lettering is allowed on exactly two kinds. Everywhere else it is a defect. */
const LETTERED: ReadonlySet<AssetKind> = new Set<AssetKind>(['wordmark', 'og', 'social', 'banner'])

const NO_TEXT = 'No text, no lettering, no numerals, no currency symbols, no watermark.'

function lettering(name: string): string {
  return (
    `Any lettering must read exactly "${name}" — that spelling, that capitalisation, nothing ` +
    'else. One clean geometric sans, medium weight, wide tracking. No tagline, no second line, ' +
    'no misspellings, no invented words.'
  )
}

/**
 * The shared art direction. The accent is the **only** thing that varies between kits; everything
 * else in this paragraph is what makes a set of marks read as one family rather than as six logos.
 */
export function brandStyle(accent: string): string {
  return (
    'Brand mark for a software company, drawn as one member of an existing family of marks. ' +
    'Flat geometric vector: every shape constructed from circles, squares and 45-degree chamfers ' +
    'on a single grid, one uniform stroke weight throughout, sharp corners left sharp, generous ' +
    `negative space, optically centred. High contrast against a warm ash ground (${BRAND_GROUND}) ` +
    `with exactly one accent colour — ${accent} — and no second hue anywhere. Flat fills only: ` +
    'no gradients, no photographic texture, no bevels, no drop shadows, no glow, no 3D, no ' +
    'photo-realism, no weathering, no illustration. Confident and minimal, and legible at 16 ' +
    'pixels. No stock-logo cliches, no swooshes.'
  )
}

/**
 * The art direction for a world object, which is NOT the brand brief.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `brandStyle()` above says "Brand mark for a software company … flat geometric vector … legible
 * at 16 pixels". Run a stool through it and a stool is not what comes back: a LOGO of a stool
 * comes back, and it comes back looking deliberate, so nothing downstream can tell. There is no
 * assertion anywhere in this service that reads a prompt for meaning, so this would have been
 * wrong quietly and for ever — the same shape as the copybot guard that stayed green when its
 * index was dropped.
 *
 * So `world_object` takes its own paragraph, and every clause in it is doing work
 * (23-tessera.md §1.1, §2.1, §2.6):
 *
 *   * **painterly gouache, no outlines, no bevels, no gloss** — §1.1's measured argument. A
 *     hand-painted world is SUPPOSED to vary from tile to tile; a flat-vector world is not, and
 *     two vector chairs disagreeing by three pixels read as a bug rather than as a brushstroke.
 *   * **three-quarter isometric from above-left, 2:1 dimetric** — the projection is the world's,
 *     not the maker's. It is what makes one player's chair sit in the same room as another's.
 *   * **standing alone on a flat #12100f ground** — diffusion emits no alpha, so transparency is a
 *     derive step keyed against a KNOWN colour (`brand/normalise_ground.py`). A generation on
 *     any other ground cannot be cut out.
 *   * **one canonical facing** — the second is a horizontal mirror at render time, because this
 *     service has no `seed` column and a pipeline that cannot fix a seed cannot render the same
 *     chair four times (§2.1). Asking for four facings would produce four different chairs.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const WORLD_OBJECT_STYLE =
  'A single object in a persistent isometric world, painted rather than modelled. Painterly ' +
  'gouache with visible brush economy, warm ash-and-ember key light from the upper left against ' +
  'cool shadow. Three-quarter isometric view from above-left, 2:1 dimetric projection, one ' +
  'canonical facing. The object stands alone on a flat ' +
  `${BRAND_GROUND} ground with nothing else in frame: no background, no scene, no second object, ` +
  'no cast shadow leaving the frame. No outline, no bevel, no gloss, no 3D render, no ' +
  'photo-realism, no user-interface framing.'

/**
 * The art direction for a content cover, which is neither the brand brief nor the world brief.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A cover sits at the top of a page about ONE SUBJECT — a prediction market's question, a listing,
 * an article. It must read as an illustration OF that subject, and it must not read as a logo,
 * because a logo at the top of a market page looks like the market's brand and there is no such
 * brand. So `brandStyle()` is deliberately not used.
 *
 * Every clause below is doing work:
 *
 *   * **editorial illustration, flat vector, limited palette** — it has to sit beside the estate's
 *     brand marks without competing with them. Same flat-vector language, different job.
 *   * **the accent used sparingly against the ash ground** — one hue, so nine covers generated for
 *     nine unrelated questions still read as one product's pages rather than nine stock images.
 *   * **wide, with the subject off-centre and quiet space** — the product overlays the question
 *     text on this, so the composition has to leave somewhere for it to go. A centred subject
 *     would put the type on top of the picture.
 *   * **no charts, no arrows, no graphs** — the failure mode a prediction market invites. A
 *     generated line going up is a claim about an outcome nobody has decided, next to real money.
 *   * **no faces, no logos, no flags, no team crests** — several seeded questions name political
 *     parties, football clubs and Formula One teams. A generated likeness or a hallucinated crest
 *     is a trademark and publicity-rights problem, not a stylistic one.
 *
 * `NO_TEXT` is applied on top of this by `buildPrompt`, because `cover` is deliberately absent
 * from `LETTERED`. See the note on `cover` in specs.ts: a generated numeral beside a real market
 * is a figure a user could act on that nobody wrote.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function coverStyle(accent: string): string {
  return (
    'Editorial illustration for the header of a single article, in the flat geometric vector ' +
    'language of a modern product: clean shapes on one grid, uniform stroke weight, generous ' +
    `negative space. A warm ash ground (${BRAND_GROUND}) with ${accent} used sparingly as the ` +
    'single accent and no second hue. Flat fills only: no gradients, no photographic texture, no ' +
    'bevels, no drop shadows, no glow, no 3D, no photo-realism. A wide composition with the ' +
    'subject held to one side and the rest deliberately quiet, so overlaid text has somewhere to ' +
    'sit. It is an illustration, not a logo and not a poster: no emblem, no badge, no roundel, no ' +
    'centred symmetrical mark. No charts, no graphs, no arrows, no trend lines, no dashboards. No ' +
    'faces, no people, no portraits, no logos, no brand marks, no flags, no crests, no insignia. ' +
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // THE SUBJECT IS A BRIEF, NOT A CAPTION — AND SAYING SO COSTS NINE IMAGES TO LEARN.
    //
    // The first batch of Foresight covers was generated with the market's QUESTION as the subject.
    // FLUX rendered the question INTO the picture as type, and rendered it badly: "Will Arsenal
    // win tho27 English Premier League tible?" and, on the US House market, "od at te ot least 218
    // of te of the voting seats in 435 votiing seats in the 2026 general." Garbled prose is merely
    // embarrassing; the NUMERALS are the actual defect, because a fabricated "218" or "2026" sits
    // beside a real market on a platform that custodies money and reads as a figure somebody could
    // act on.
    //
    // The generic `NO_TEXT` line was already in the prompt and lost, because a subject phrased as
    // a sentence — especially an interrogative one — is a strong instruction to typeset it. So the
    // refusal is repeated HERE, in the cover's own paragraph, in terms that name the mistake:
    // the description is what to draw, never what to write.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    'The subject description below is a brief describing what to DRAW; it is never a caption and ' +
    'must never be rendered as writing. The finished image contains no words, no sentences, no ' +
    'letters, no numerals, no dates and no prices anywhere in the frame.'
  )
}

/** What each kind is, in one sentence, so the composition differs even though the style does not. */
const COMPOSITION: Readonly<Record<AssetKind, string>> = Object.freeze({
  mark: 'The brand mark. One idea, executed cleanly, centred and symmetrical in a square field with even margins on all four sides.',
  wordmark:
    'A horizontal wordmark lockup: the brand mark on the left, then a clear gap of one mark-width, then the name set as text, its baseline optically aligned to the centre of the mark. Wide empty field, the lockup occupying the middle third.',
  favicon:
    'A favicon source. Drawn heavier and simpler than the full mark — thicker strokes, fewer parts, larger counters — so it survives being resampled to 32 and 16 pixels. Fills the square edge to edge with only a hairline margin.',
  og: 'An Open Graph card. Wide composition: the brand mark in the left third at roughly a third of the card height, the right two thirds left deliberately empty apart from the name. Nothing near the outer edges; social platforms crop them.',
  social:
    'A repository social preview banner. The brand mark on the left, the name beside it, generous empty space to the right. A banner, not a poster: no scene, no illustration, no background pattern. The platform rounds the corners and darkens the edges, so keep everything well inboard.',
  banner:
    'A wide page banner. The mark held small in one third of the frame and the rest deliberately empty, so overlaid text has somewhere to sit.',
  icon: 'A single interface icon on a flat field, centred, drawn at one weight with no detail that dies below 32 pixels.',
  tile: 'A seamless square tile: the motif repeated on a regular grid so opposite edges meet without a seam.',
  cover:
    'A wide header illustration for one piece of content. One clear idea drawn as a small number of simple objects or shapes standing for the subject, placed in one third of the frame with the remaining two thirds calm and largely empty.',
  world_object:
    'One object, whole and unoccluded, occupying the middle of the square with clear ground all round it so the cutout step has an edge to key against. Its footprint sits on one ground tile; the space above it is headroom, so a tall object may use it and a low object may leave it empty.',
})

export interface PromptInput {
  readonly kitName: string
  readonly accent: string
  /** Free text from the kit — the one idea the mark is built around. May be empty. */
  readonly stylePrompt: string
  readonly spec: AssetSpec
}

/**
 * Build the full prompt for one asset.
 *
 * Order matters: style first, composition second, the kit's own idea third, prohibitions last.
 * A prohibition placed before the subject is routinely ignored by image models, which is how
 * "no text" produces a mark with a word in it.
 */
export function buildPrompt(input: PromptInput): string {
  // The style paragraph is chosen BY KIND, not by kit. Every kind but one is a brand artefact and
  // takes `brandStyle(accent)`; `world_object` is a thing in somebody's world and takes the
  // world's brief. The accent is not interpolated into it at all — a world object wears no
  // product colour, because it is not chrome. See WORLD_OBJECT_STYLE.
  // Three briefs, not two. `world_object` is a thing in somebody's world, `cover` is an
  // illustration OF a subject, and everything else is a brand artefact. Running a cover through
  // `brandStyle()` returns a logo of a question — see the note on `cover` in specs.ts.
  const style =
    input.spec.kind === 'world_object'
      ? WORLD_OBJECT_STYLE
      : input.spec.kind === 'cover'
        ? coverStyle(input.accent)
        : brandStyle(input.accent)
  // A world object's subject is the whole point of the request, so it is never allowed to fall
  // back to the kit's name the way a mark may: a firing with no description would otherwise
  // silently generate "a Tessera", which is not an object anybody asked for.
  //
  // `server.ts` refuses this with a **400** first — search it for `world_object`. That comes
  // second in the source and first in the call order, and this comment used to assert it while it
  // did not exist, which made the route 500 on any kit with an empty `stylePrompt`. This throw is
  // the second, structural refusal: it stands in front of every OTHER caller of `buildPrompt`,
  // and a caller that reaches it has already got past a guard, so 500 is the right answer there.
  if (input.spec.kind === 'world_object' && input.stylePrompt.trim().length === 0) {
    throw new Error('a world_object generation has no description to build a prompt from')
  }
  // A cover is an illustration OF something, so it has the same requirement for the same reason:
  // with nothing to draw it would fall back to the kit name and produce a picture of a slug like
  // `seed:foresight-8f3a1c`, which is not a subject anybody asked for.
  if (input.spec.kind === 'cover' && input.stylePrompt.trim().length === 0) {
    throw new Error('a cover generation has no subject to build a prompt from')
  }
  const parts = [
    style,
    COMPOSITION[input.spec.kind],
    input.stylePrompt.trim().length > 0
      ? input.spec.kind === 'world_object'
        ? `The object is: ${input.stylePrompt.trim()}`
        : input.spec.kind === 'cover'
          ? // Framed as "evokes" rather than "depicts": the subject is often a question about a
            // future event, and asking for a depiction of an undecided outcome is asking the model
            // to answer it.
            `The subject this illustration evokes, without depicting any outcome: ${input.stylePrompt.trim()}`
          : `The one idea this mark is built around: ${input.stylePrompt.trim()}`
      : `Built around the name "${input.kitName}" and nothing else.`,
    LETTERED.has(input.spec.kind) ? lettering(input.kitName) : NO_TEXT,
  ]
  return parts.join('\n\n')
}
