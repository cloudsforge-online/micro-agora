/**
 * The header image on a market and on an idea: one reference into `micro-studio`, and the words
 * this service is allowed to use about it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS SERVICE STORES A REFERENCE. IT DOES NOT STORE, SERVE, OR CHECK BYTES.**
 *
 * studio is the estate's single media service. It validates magic bytes, REFUSES SVG, bounds
 * dimensions, strips EXIF and GPS, and serves the bytes itself with `nosniff` and a restrictive
 * CSP (`studio/src/assets.ts`). None of that is reimplemented here and none of it should be: one
 * place that serves images is one place to secure, back up and cache, and a second copy is the
 * copy that gets the next hardening fix six months late.
 *
 * What foresight adds is the two things studio cannot know: WHICH market or idea an asset belongs
 * to, and WHO is allowed to change it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE CHECKSUM IS RECORDED. IT IS NOT VERIFIED, AND NOTHING HERE MAY SAY OTHERWISE.**
 *
 * The value stored is the one studio computed and handed back to whoever uploaded the bytes, then
 * relayed to this service by that same client. foresight does not fetch the asset, does not
 * recompute the digest, and holds no signature over it. `markets_image_checksum_shape` checks the
 * SHAPE — 64 lowercase hex after a `sha256:` prefix — and a shape check is not an integrity check.
 *
 * So the vocabulary is fixed, in this file, once, and every caller inherits it:
 *
 *   * "hash recorded" — true, and the strongest claim available.
 *   * "verified", "attested", "on-chain", "anchored" — FORBIDDEN, in an API field name, an error
 *     message, or a rendered string.
 *
 * The temptation is unusually strong in this repository, because foresight genuinely does talk to
 * a chain: `src/evm.ts` builds transactions, `src/deploy.ts` deploys a real contract, and a
 * market's `question_hash` really is written into it. An image is next to all of that on the same
 * page and shares none of it. Worse, the claim would be one nobody could ever see fail — there is
 * no Registry of Authorship on Hearth to check against. `tessera/src/kiln.ts` records that
 * the Solidity for it has never been written, `mint`'s catalogue deploys three ERC-20 variants and
 * nothing else, and studio's own `anchor.state` is `'unanchored'` on every asset it has ever
 * produced. A badge reading "verified on chain" beside a picture would therefore be a check that
 * always passes, on a platform that custodies real money — which is worse than showing nothing,
 * because a check that cannot fail teaches a reader that the ones that can are decoration too.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The estate's single spelling for a content address: `sha256:` and 64 LOWERCASE hex.
 *
 * Exactly studio's (`studio/src/assets.ts`) and exactly tessera's `objects_checksum_shape`
 * (`tessera/src/migrations.ts` region), and duplicated into the schema as
 * `markets_image_checksum_shape` / `ideas_image_checksum_shape` so it holds against a write path
 * that never reaches this file.
 *
 * Uppercase hex is REFUSED rather than lowered, and a bare hex with no prefix is refused rather
 * than prefixed. `tessera/src/itemasset.ts` makes the same refusal for the same reason: a
 * function that normalised would be the one place two spellings of one image could be born, and
 * the two would then compare unequal everywhere else in the estate.
 */
export const IMAGE_CHECKSUM = /^sha256:[0-9a-f]{64}$/

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * A whole reference, or none.
 *
 * There is no shape here for half of one, deliberately — `markets_image_is_whole` refuses half a
 * reference in the database and this type refuses to describe one in the program. See the
 * migration's comment for why an id with no checksum is a claim nothing backs.
 */
export interface ImageReference {
  /** studio's asset id. No foreign key: different service, different database. */
  readonly assetId: string
  /** `sha256:<64 lowercase hex>`, as studio spelled it. Recorded, not verified. */
  readonly checksum: string
}

export class ImageError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ImageError'
    this.code = code
    this.status = status
  }
}

/**
 * Read a reference off a request body, refusing anything that is not a whole one.
 *
 * Both fields or a 400. A body carrying only `assetId` is the most likely mistake a client makes —
 * the id is the part a developer thinks of as "the image" — and it is exactly the half-reference
 * the schema refuses, so it is refused here first with a sentence that says which half is missing.
 */
export function parseImageReference(body: Record<string, unknown>): ImageReference {
  const assetId = body['assetId']
  const checksum = body['checksum']
  if (typeof assetId !== 'string' || !UUID.test(assetId)) {
    throw new ImageError('bad_asset_id', 'assetId must be the uuid micro-studio returned for the upload')
  }
  if (typeof checksum !== 'string' || !IMAGE_CHECKSUM.test(checksum)) {
    throw new ImageError(
      'bad_checksum',
      'checksum must be studio’s own spelling, sha256: followed by 64 lowercase hex characters — ' +
        'it is stored exactly as given and never reformatted',
    )
  }
  return { assetId, checksum }
}

/**
 * The path studio serves an asset's bytes at, spelled exactly as studio spells it
 * (`studio/src/server.ts`).
 *
 * **That route needs no Authorization header when the asset is public**, which is the whole reason
 * an image can be rendered at all: a browser sends no bearer token on an `<img src>`, so an
 * authenticated bytes route would produce a broken picture on every page in the estate. Uploads
 * from this product's clients therefore go up as `?visibility=public`.
 */
export function bytesPath(assetId: string): string {
  return `/v1/assets/${assetId}/bytes`
}

/** What a reference looks like in a response. `bytesUrl` is absolute, or null. */
export interface ImageView {
  readonly assetId: string
  readonly checksum: string
  /**
   * Absolute, so a browser can put it straight in `<img src>` — or `null` when this deployment has
   * no `STUDIO_PUBLIC_URL`.
   *
   * Null rather than a relative path, and that distinction is the point. A relative
   * `/v1/assets/…/bytes` returned by THIS service would resolve against foresight's own origin in
   * a browser and 404 — the estate has made this exact mistake before and written it down:
   * `deploy/compose/docker-compose.estate.yml` leaves `STUDIO_ASSET_BASE_URL` unset because a base
   * URL there "would mint storageUrls that look fetchable and 404 — a zero wearing a status code".
   * A null says "this deployment cannot tell you where the bytes are", which a client can act on.
   */
  readonly bytesUrl: string | null
}

/**
 * Render a stored reference for a response.
 *
 * `null` in, `null` out: content with no image is not content with an empty image, and a client
 * that receives `image: null` renders nothing rather than a frame around a missing picture.
 *
 * Half a reference reaching here means the schema constraint was dropped, so it throws rather than
 * guessing which half to believe. The check costs nothing and is the only thing between a dropped
 * constraint and a response that quietly invents an image.
 */
export function imageView(
  assetId: string | null,
  checksum: string | null,
  studioPublicUrl: string | undefined,
): ImageView | null {
  if (assetId === null && checksum === null) return null
  if (assetId === null || checksum === null) {
    throw new ImageError(
      'half_a_reference',
      'a stored image reference is missing half of itself — markets_image_is_whole should have ' +
        'made this impossible, so the constraint is gone',
      500,
    )
  }
  return {
    assetId,
    checksum,
    bytesUrl: studioPublicUrl === undefined ? null : `${studioPublicUrl}${bytesPath(assetId)}`,
  }
}
