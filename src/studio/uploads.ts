/**
 * User uploads: the pipeline from hostile bytes to a stored, addressable asset.
 *
 * `imagebytes.ts` decides whether bytes are acceptable. This file decides whether this PRINCIPAL
 * may store them, puts them somewhere, and records the row. The split is deliberate: the validator
 * is pure and exhaustively testable without a database, and everything that needs a transaction
 * lives here.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN UPLOAD DOES NOT METER AGAINST THE CREDIT CAP, AND THAT IS A DECISION RATHER THAN AN
 * OMISSION.**
 *
 * `credits.ts` caps SPEND. Every micro-dollar it holds back corresponds to money leaving for a
 * FLUX call. An upload costs no provider anything — there is no model, no request and no invoice —
 * so charging it against that cap would mean a user who uploads twenty photographs of a listing can
 * no longer generate the artwork they are paying for. That is a cap doing the opposite of its job:
 * a spend control that throttles a free operation, while the paid operation it exists to bound goes
 * unprotected because the budget was consumed by something that cost nothing.
 *
 * Uploads still need a bound, because the resource they consume is DISK and an unbounded upload
 * endpoint is a way to fill a volume. So the bound is a quota in the resource actually at risk —
 * a count and a byte total per owner per day — and it is entirely separate from the money.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  insertUpload,
  setAssetVisibility,
  type Asset,
  type AssetBlobStore,
  type AssetVisibility,
} from './assets.ts'
import { MEDIA_TYPES, normalise } from './imagebytes.ts'
import { withOutbox, type Db, type Emit } from './outbox.ts'

/**
 * Raised when an owner has uploaded too much today. Mapped to **429**, not 402 and not 403.
 *
 * 402 would be a lie — nothing here is for sale. 403 would send the user to check permissions they
 * have. 429 is the one status whose remedy ("wait, then retry") is the true one, and it is the one
 * a client library will already back off on.
 */
export class UploadQuotaError extends Error {
  readonly limit: number
  readonly used: number
  readonly windowHours: number

  constructor(what: string, used: number, limit: number, windowHours: number) {
    super(
      `this account has used ${used} of its ${limit} ${what} in the last ${windowHours} hours — ` +
        'uploads are limited per account per day; retry later',
    )
    this.name = 'UploadQuotaError'
    this.limit = limit
    this.used = used
    this.windowHours = windowHours
  }
}

export interface UploadQuota {
  /** Uploads per owner per window. */
  readonly dailyCount: number
  /** Total stored bytes per owner per window. */
  readonly dailyBytes: number
  readonly windowHours: number
}

export const DEFAULT_UPLOAD_QUOTA: UploadQuota = Object.freeze({
  dailyCount: 200,
  dailyBytes: 256 * 1024 * 1024,
  windowHours: 24,
})

export interface UploadDeps {
  readonly sql: Db
  readonly producer: string
  readonly blobs: AssetBlobStore
  readonly quota: UploadQuota
}

export interface UploadInput {
  readonly bytes: Buffer
  readonly ownerSubject: string
  /**
   * Defaults to `private` at every layer that can default it — here, in the route, and in the
   * schema. An image that is public because nobody said otherwise is the failure this feature is
   * one mistake away from, so "otherwise" has to be said three times.
   */
  readonly visibility: AssetVisibility
  readonly actor: string
  readonly correlationId: string
}

export interface UploadOutcome {
  readonly asset: Asset
  /** True when these exact bytes were already stored by this owner. See `insertUpload`. */
  readonly deduplicated: boolean
  readonly strippedBytes: number
}

/**
 * Validate, store, record.
 *
 * The order matters in one specific way: **the blob is written before the row, never after.** A
 * crash between them leaves an orphaned blob, which is garbage on a disk and costs a cleanup job.
 * The other order leaves a row pointing at bytes that do not exist, which is a broken image served
 * to a user with no way to tell it apart from a real one. Orphaned bytes are recoverable; a
 * dangling reference is a lie.
 *
 * Both the checksum and the byte size come from the STRIPPED buffer, because that is what is
 * written and what will be served. Hashing the uploaded bytes instead would mean the content
 * address did not address the content — and, worse here, that the digest of somebody's EXIF GPS
 * trace was the thing recorded in the database.
 */
export async function storeUpload(deps: UploadDeps, input: UploadInput): Promise<UploadOutcome> {
  // Throws UploadRejected, mapped to 400 by the HTTP layer. Nothing is written and no quota is
  // consumed by a refusal, so a rejected upload cannot be used to exhaust somebody's allowance.
  const image = normalise(input.bytes)

  await assertWithinQuota(deps, input.ownerSubject, image.bytes.length)

  const stored = await deps.blobs.put(image.bytes, image.format)

  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const before = await tx<{ count: string }[]>`
      select count(*)::text as count
        from assets
       where origin = 'upload'
         and owner_subject = ${input.ownerSubject}
         and checksum = ${stored.checksum}
    `
    const deduplicated = (before[0]?.count ?? '0') !== '0'

    const asset = await insertUpload(tx, {
      ownerSubject: input.ownerSubject,
      format: image.format,
      mediaType: MEDIA_TYPES[image.format],
      width: image.width,
      height: image.height,
      storageUrl: stored.storageUrl,
      checksum: stored.checksum,
      byteSize: stored.byteSize,
      visibility: input.visibility,
      publishedBy: input.visibility === 'public' ? input.actor : null,
    })

    // Only on a genuinely new asset. Re-emitting on a deduplicated retry would make every consumer
    // handle a creation event for something they were already told about.
    if (!deduplicated) emitUploaded(emit, asset, input)

    return { asset, deduplicated, strippedBytes: image.strippedBytes }
  })
}

/**
 * The per-owner bound, read as one query over the window.
 *
 * Not a CHECK constraint, and the reason is that a rate limit is not a property of a row — it is a
 * property of a set of rows over time, which a per-row CHECK cannot see. A constraint trigger could
 * express it and would serialise every upload in the estate behind one table lock, which is a worse
 * trade than a query that can occasionally let a concurrent pair through. The consequence of that
 * race is one extra image on disk, bounded by `MAX_UPLOAD_BYTES`; the consequence of the lock would
 * be an upload path that stops working under load.
 */
async function assertWithinQuota(
  deps: UploadDeps,
  ownerSubject: string,
  incomingBytes: number,
): Promise<void> {
  const rows = await deps.sql<{ count: string; bytes: string }[]>`
    select count(*)::text as count,
           coalesce(sum(byte_size), 0)::text as bytes
      from assets
     where origin = 'upload'
       and owner_subject = ${ownerSubject}
       and created_at > now() - make_interval(hours => ${deps.quota.windowHours})
  `
  const row = rows[0]
  // `BigInt('')` is 0n rather than a throw, which has bitten this estate repeatedly, so the
  // fallback is an explicit '0' string and never an empty one.
  const used = Number(row?.count && row.count.length > 0 ? row.count : '0')
  const usedBytes = Number(row?.bytes && row.bytes.length > 0 ? row.bytes : '0')

  if (used >= deps.quota.dailyCount) {
    throw new UploadQuotaError('uploads', used, deps.quota.dailyCount, deps.quota.windowHours)
  }
  if (usedBytes + incomingBytes > deps.quota.dailyBytes) {
    throw new UploadQuotaError(
      'upload bytes',
      usedBytes,
      deps.quota.dailyBytes,
      deps.quota.windowHours,
    )
  }
}

export interface SetVisibilityInput {
  readonly assetId: string
  readonly visibility: AssetVisibility
  readonly actor: string
  readonly correlationId: string
}

/**
 * Change who may fetch an asset's bytes, and announce it.
 *
 * The event is emitted in the SAME transaction as the update, like every other state change in
 * this service. A publication that is visible in the database but was never announced is a
 * consumer — a cache, a moderation queue, a CDN purge — working from a state that no longer
 * exists, and this is the one state change where that gap has a privacy consequence.
 *
 * The topic is `studio.asset.visibility_changed`, one underscore and not two dots. It was
 * `studio.asset.visibility.changed` — four segments — and `TOPIC_PATTERN` in
 * `@cloudsforge/contracts-events` admits exactly three, so the name could not be registered and no
 * envelope carrying it could validate. The announcement this docstring calls load-bearing was
 * therefore unconsumable by anything that checks its envelopes, which is every consumer in the
 * estate. Renamed with no coordination cost: `estate-topics` found no consumer anywhere, because
 * there could not be one. micro-org#263.
 */
export async function changeVisibility(
  deps: Pick<UploadDeps, 'sql' | 'producer'>,
  input: SetVisibilityInput,
): Promise<Asset | null> {
  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const asset = await setAssetVisibility(tx, input.assetId, input.visibility, input.actor)
    if (!asset) return null
    emit({
      topic: 'studio.asset.visibility_changed',
      key: asset.id,
      payload: {
        id: asset.id,
        ownerSubject: asset.ownerSubject,
        visibility: asset.visibility,
        publishedAt: asset.publishedAt,
        checksum: asset.checksum,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
    return asset
  })
}

function emitUploaded(emit: Emit, asset: Asset, input: UploadInput): void {
  emit({
    topic: 'studio.asset.uploaded',
    key: asset.id,
    payload: {
      id: asset.id,
      origin: asset.origin,
      ownerSubject: asset.ownerSubject,
      checksum: asset.checksum,
      format: asset.format,
      mediaType: asset.mediaType,
      width: asset.actualWidth,
      height: asset.actualHeight,
      byteSize: asset.byteSize,
      visibility: asset.visibility,
      // Stated on the event so a consumer never has to infer it. See `AnchorState`: an uploaded
      // asset has a recorded content address and no chain attestation, and those differ.
      anchorState: asset.anchor.state,
    },
    actor: input.actor,
    correlationId: input.correlationId,
  })
}
