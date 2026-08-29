/**
 * `asset` — storage reference, checksum, licence, dimensions, and the job that made it.
 *
 * 04-domain-model.md §5.1 states the invariant this file exists to hold:
 *
 *   > Every generated asset records the model, prompt, spec and cost that produced it, so a brand
 *   > kit is reproducible and a spend is attributable. Today `asset-forge` writes PNGs into
 *   > sibling working trees with no record of any of this.
 *
 * The record lives on `generation_jobs`; the asset points at it with `on delete restrict`, so the
 * evidence cannot be deleted out from under the artefact.
 *
 * ## Where the bytes go
 *
 * `AssetBlobStore` is a two-method port. The filesystem implementation below writes under
 * `STUDIO_ASSET_ROOT` and returns a URL. It is a directory rather than an object store because
 * the estate has no object-store service yet; when one exists, one implementation of this
 * interface replaces it and nothing else in the service changes.
 *
 * The path is derived from the **checksum**, not from the asset id or the kit name. Content
 * addressing means writing is idempotent — a retried job that regenerates identical bytes writes
 * the same path rather than a second file — and it means the stored path is itself a claim that
 * can be checked. `asset-forge` writes `${id}.png` into six sibling working trees, so the same
 * name means different bytes in different repositories and nothing detects it.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Probe, ProbeResult } from '@cloudsforge/lifecycle'
import type { Db, Tx } from './outbox.ts'
import type { AssetFormat, AssetKind } from './specs.ts'
import type { UploadFormat } from './imagebytes.ts'
import type { Sizing } from './sizing.ts'

/**
 * Every format the blob store can hold: what this service GENERATES, plus what a user may UPLOAD.
 *
 * One union rather than two, because the store keys on it for the file extension and a second
 * spelling of "the formats on disk" is a second thing to keep in step with the directory.
 */
export type BlobFormat = AssetFormat | UploadFormat

/** How an asset came to exist. Mirrors the `assets_origin_known` constraint. */
export type AssetOrigin = 'generated' | 'upload'

/**
 * Whether the bytes may be fetched without a token. **`private` is the default.**
 *
 * See migration 10 for why this exists at all: a browser sends no Authorization header on an
 * `<img>` tag, so a listing photograph that only its owner may fetch is a broken image to every
 * buyer. Publication is therefore an explicit act, never a side effect.
 */
export type AssetVisibility = 'private' | 'public'

/**
 * The licence recorded on every generated asset.
 *
 * A constant rather than a free-text field: an asset whose licence is whatever the caller typed
 * is an asset nobody can clear for use. FLUX output on Azure Foundry is licensed to the customer
 * for commercial use, and it carries C2PA provenance and an invisible watermark, so the string
 * names the generator as well as the grant.
 */
export const GENERATED_LICENCE = 'cloudsforge-generated: commercial use permitted; AI-generated, C2PA provenance retained'

/**
 * The licence recorded on an uploaded asset.
 *
 * Distinct from `GENERATED_LICENCE` and deliberately makes no grant: we did not make these bytes
 * and cannot license them on the uploader's behalf. Recording "the uploader asserts they may
 * publish this" is the true statement; recording a commercial-use grant would be this service
 * inventing a right it does not hold over somebody else's photograph.
 */
export const UPLOADED_LICENCE =
  'cloudsforge-uploaded: supplied by the uploader, who asserts the right to publish it; no ' +
  'grant is made by CloudsForge'

/**
 * Whether an asset's bytes are anchored to Hearth.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`unanchored` IS THE ONLY VALUE THIS SERVICE CAN PRODUCE TODAY, AND SAYING SO IS THE POINT.**
 *
 * There is no Registry of Authorship contract on Hearth — `tessera/src/kiln.ts` records
 * that the Solidity has never been written and that `mint` can only deploy a closed set of three
 * ERC-20 variants, so there is no path to deploy one. An asset therefore has a content address
 * that is recorded and NOT a chain anchor that is verified, and those are different claims.
 *
 * Telling a user their image is "verified" or "on-chain" while `anchor_tx` is null would be a
 * false statement about a cryptographic property, made by a platform that custodies real money.
 * It is strictly worse than saying nothing, because it is a check that always passes. So the wire
 * shape carries this word, every consumer renders it, and the honest state is the one on screen.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export type AnchorState = 'unanchored' | 'anchored'

export interface AssetAnchor {
  readonly state: AnchorState
  readonly transactionHash: string | null
  readonly blockNumber: string | null
  readonly anchoredAt: string | null
}

export interface Asset {
  readonly id: string
  readonly origin: AssetOrigin
  /** Null for an upload: an uploaded picture belongs to a person, not to a brand kit. */
  readonly brandKitId: string | null
  /** Null for an upload. Never null for a generated asset — `assets_origin_consistent`. */
  readonly generationJobId: string | null
  readonly ownerSubject: string | null
  readonly kind: AssetKind | 'upload'
  readonly format: BlobFormat
  /** The media type the bytes are served as. Null on older generated rows; derived on read. */
  readonly mediaType: string | null
  readonly declaredWidth: number
  readonly declaredHeight: number
  readonly actualWidth: number | null
  readonly actualHeight: number | null
  readonly sizing: Sizing
  readonly storageUrl: string
  readonly checksum: string
  readonly byteSize: number
  readonly licence: string
  readonly c2pa: boolean
  readonly visibility: AssetVisibility
  readonly publishedAt: string | null
  readonly anchor: AssetAnchor
  readonly createdAt: string
}

/* ------------------------------------------------------------------------ blob store */

export interface StoredBlob {
  readonly storageUrl: string
  readonly checksum: string
  readonly byteSize: number
}

export interface AssetBlobStore {
  put(bytes: Buffer, format: BlobFormat): Promise<StoredBlob>
  /**
   * Read stored bytes back by content address. `null` when they are not there.
   *
   * Takes the CHECKSUM rather than a path, and that is the security property rather than a
   * convenience: the only thing a caller can name is a 64-character hex digest, which is validated
   * against `CHECKSUM_SHAPE` before it is used to build a path. There is no input to this function
   * that can contain a `/` or a `..`, so path traversal is not defended against here — it is
   * unrepresentable. A store keyed on a user-supplied filename would need that defence and would
   * eventually be missing it.
   */
  get(checksum: string, format: BlobFormat): Promise<Buffer | null>
}

/** `sha256:` + 64 lowercase hex. studio's spelling, tessera's spelling, and the column's CHECK. */
export const CHECKSUM_SHAPE = /^sha256:([0-9a-f]{64})$/

/** `sha256:<hex>`. Prefixed so the algorithm travels with the digest and can be changed later. */
export function checksumOf(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * Write under a root directory, content-addressed.
 *
 * `ab/cdef…png` — the first byte of the digest as a directory, so a kit with ten thousand assets
 * does not put ten thousand entries in one directory, which several filesystems handle badly.
 */
export function filesystemBlobStore(root: string, baseUrl: string): AssetBlobStore {
  const absoluteRoot = resolve(root)

  /**
   * The one place the on-disk layout is spelled, so `put` and `get` cannot disagree about where a
   * blob lives. Returns null for a checksum of the wrong shape rather than building a path out of
   * it — this is the choke point that makes traversal unrepresentable.
   */
  const pathFor = (checksum: string, format: BlobFormat): string | null => {
    const hex = CHECKSUM_SHAPE.exec(checksum)?.[1]
    if (!hex) return null
    // The extension is from a closed union, never from a filename. Both components are therefore
    // drawn from alphabets that cannot express a separator.
    return join(absoluteRoot, hex.slice(0, 2), `${hex}.${format}`)
  }

  return {
    async put(bytes, format) {
      const checksum = checksumOf(bytes)
      const hex = checksum.slice('sha256:'.length)
      const relative = join(hex.slice(0, 2), `${hex}.${format}`)
      const path = join(absoluteRoot, relative)
      await mkdir(dirname(path), { recursive: true })
      // Unconditional write. Content-addressed, so rewriting is writing the same bytes; checking
      // first would be a race with no benefit.
      await writeFile(path, bytes)
      return {
        // A configured base URL wins, so pointing a CDN at the same directory is configuration
        // rather than a migration of every stored row.
        storageUrl: baseUrl
          ? `${baseUrl}/${relative.split('\\').join('/')}`
          : pathToFileURL(path).href,
        checksum,
        byteSize: bytes.length,
      }
    },

    async get(checksum, format) {
      const path = pathFor(checksum, format)
      if (!path) return null
      try {
        return await readFile(path)
      } catch (err) {
        // A blob that is not on this replica's disk is a 404 to the caller, not a 500. With a
        // shared volume that means it was never written; with a per-replica volume it means it was
        // written by a different one, and either way the answer to "give me these bytes" is that
        // we do not have them.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw err
      }
    },
  }
}

/* --------------------------------------------------------------- is the root writable? */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ROOT IS PROVEN BY WRITING TO IT. IT IS NEVER ASKED.**
 *
 * This exists because of a live incident, not a hypothesis. `STUDIO_ASSET_ROOT` was unset in the
 * deploy, so `env.ts` fell back to `./out`, which resolved to a root-owned `/app/out` inside an
 * image whose last instruction is `USER node` (uid 1000). Every generation of every kind died with
 * `EACCES` in `put()` above — and the container reported `healthy`, `/readyz` answered **200**, and
 * the balancer kept feeding it, because nothing between the mount and the write had an opinion.
 *
 * **`fs.access(root, W_OK)` IS NOT THE CHECK, AND THIS IS MEASURED, NOT ASSERTED.** Substituting
 * `access` for the body below and running the suite fails three cases, for two distinct reasons:
 *
 *   * A root that is a regular FILE passes `access(W_OK)` — the file is writable — and the service
 *     boots and listens. The store then needs a DIRECTORY there and cannot have one.
 *   * A root that does not exist yet fails `access` with ENOENT, so a correct deploy with a fresh
 *     empty volume is refused. `mkdir --recursive` creates it, which is what `put()` does too.
 *
 * `access` also cannot see a full disk, and it reports a permission rather than the filesystem's
 * willingness to honour it — the class this estate has already been burned by, where an earlier
 * fix for this same defect passed on Docker Desktop and would have failed on Linux, because
 * virtiofs maps ownership and a fresh named volume's mount point is created `root:root`. The only
 * question whose answer cannot be stale is "did the write succeed".
 *
 * So: `mkdir`, `writeFile`, `unlink`, `rmdir` — the two calls `filesystemBlobStore.put()` makes on
 * the hot path, in that order, and then the two that undo them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * A dot-directory created and removed on EVERY check, mirroring the `ab/` shard `put()` creates.
 *
 * **It is torn down rather than kept, and that is not tidiness.** A first draft of this created the
 * directory once and wrote into it thereafter, and a test caught what that misses: removing write
 * permission from the ROOT does not stop a write into a subdirectory that already exists and is
 * still writable. The store does not have that luxury — a checksum starting `cd` needs a `cd/`
 * that has never existed, so `put()` creates a directory directly under the root on the hot path.
 * Creating and removing one here is what makes this check need the same permission the store does,
 * every time it runs, rather than only the first time.
 *
 * Named for the process, so two replicas sharing one root cannot remove each other's directory and
 * read the resulting ENOENT as a failure of the root. A process that dies mid-check leaves one
 * empty dot-directory, which its own next check reuses and removes.
 */
const WRITE_CHECK_DIR = `.studio-write-check-${process.pid}`

const WRITE_CHECK_FILE = 'writable'

/** Bytes, not an empty file: a zero-length write is not a write on every filesystem. */
const WRITE_CHECK_BYTES = Buffer.from('studio asset root write check\n')

/**
 * Write to the asset root and remove what was written. Throws whatever the filesystem threw.
 *
 * `mkdir` the shard and `writeFile` into it — `put()`'s two calls, in `put()`'s order — then undo
 * both. Nothing that could fail is skipped.
 *
 * Used twice, deliberately: once at boot, so an unwritable root is a container that refuses to
 * start rather than one that serves 500s, and once per readiness scrape, for a root that is fine
 * at boot and goes read-only, full or unmounted at 03:00.
 */
export async function checkAssetRoot(root: string): Promise<void> {
  const directory = join(resolve(root), WRITE_CHECK_DIR)
  const path = join(directory, WRITE_CHECK_FILE)
  // `recursive` creates the root itself when the deploy has not, which is the ordinary case for a
  // fresh volume — and fails here, loudly, when the root's own parent refuses it.
  await mkdir(directory, { recursive: true })
  await writeFile(path, WRITE_CHECK_BYTES)
  await unlink(path)
  await rmdir(directory)
}

/**
 * One sentence an operator can act on, from an errno most people read as "something went wrong".
 *
 * The EACCES wording names the cause that actually produced the incident, because the errno alone
 * sends people to `chmod` on a path that is correct and owned by somebody else.
 */
export function describeAssetRootFailure(root: string, err: unknown): string {
  const absolute = resolve(root)
  const code = typeof (err as NodeJS.ErrnoException)?.code === 'string' ? (err as NodeJS.ErrnoException).code : ''
  const who = typeof process.getuid === 'function' ? `uid ${process.getuid()}` : 'this process'
  if (code === 'EACCES' || code === 'EPERM') {
    return (
      `${absolute} is not writable by ${who}, so EVERY generation of every kind would fail with ` +
      `${code} — set STUDIO_ASSET_ROOT to a directory the deploy has made writable, and chown the ` +
      `mount point: a fresh named volume is created root:root and this image runs as node (uid 1000)`
    )
  }
  if (code === 'ENOSPC') {
    return `${absolute} has no space left, so every generation would fail with ENOSPC`
  }
  if (code === 'EROFS') {
    return `${absolute} is on a read-only filesystem, so every generation would fail with EROFS`
  }
  if (code === 'ENOTDIR') {
    return `${absolute} is not a directory — STUDIO_ASSET_ROOT names a file or a path through one`
  }
  return `${absolute} could not be written: ${err instanceof Error ? err.message : String(err)}`
}

/**
 * The readiness probe. **`hard`**, and the choice is the entire value of this file.
 *
 * `soft` would have been the shape of the fix rather than the fix: a soft failure appears in the
 * `/readyz` BODY, sets `state: "degraded"` — and still answers **200**, so the replica stays in the
 * balancer and keeps accepting generations it cannot complete. That is the same bug wearing a
 * fix's clothes, and it is why this probe does not match `imageBackendProbe`, which sits beside it
 * and is soft for a reason that does not apply here. A missing FLUX model degrades honestly: brand
 * kits, reads and placeholder generation all still work. An unwritable root fails every generation
 * of every kind, through every backend, including the placeholder — there is nothing left to
 * degrade to.
 *
 * A filesystem call that hangs — a wedged NFS mount — is not special-cased here. `Lifecycle`
 * already races every probe against `probeTimeoutMs` and reports the timeout as `fail`, and this
 * probe is hard, so a hang lands on 503 the same as a refusal does.
 */
export function assetRootProbe(root: string): Probe {
  return {
    name: 'asset-root',
    kind: 'hard',
    async check(): Promise<ProbeResult> {
      try {
        await checkAssetRoot(root)
        return { state: 'pass', detail: `${resolve(root)} is writable` }
      } catch (err) {
        return { state: 'fail', detail: describeAssetRootFailure(root, err) }
      }
    },
  }
}

/* ------------------------------------------------------------------------ store */

interface AssetRow {
  readonly id: string
  readonly origin: string
  readonly brand_kit_id: string | null
  readonly generation_job_id: string | null
  readonly owner_subject: string | null
  readonly kind: string
  readonly format: string
  readonly media_type: string | null
  readonly declared_width: number
  readonly declared_height: number
  readonly actual_width: number | null
  readonly actual_height: number | null
  readonly sizing: string
  readonly storage_url: string
  readonly checksum: string
  readonly byte_size: string
  readonly licence: string
  readonly c2pa: boolean
  readonly visibility: string
  readonly published_at: Date | null
  readonly anchor_tx: string | null
  readonly anchor_block: string | null
  readonly anchored_at: Date | null
  readonly created_at: Date
}

/**
 * The anchor, read off the row.
 *
 * `anchored` requires the transaction hash to be present. It is never inferred from the presence of
 * a checksum, which is the mistake that would turn "we hashed it" into "the chain attests it" — two
 * claims separated by an entire trust model. `assets_anchor_is_whole` guarantees the three columns
 * agree, so testing one is sufficient and testing one is honest.
 */
const toAnchor = (row: AssetRow): AssetAnchor => ({
  state: row.anchor_tx === null ? 'unanchored' : 'anchored',
  transactionHash: row.anchor_tx,
  // bigint as a decimal string: a block number is a bigint column and a JS number would be a
  // silent precision loss the day the chain is busy enough to need one.
  blockNumber: row.anchor_block,
  anchoredAt: row.anchored_at?.toISOString() ?? null,
})

const toAsset = (row: AssetRow): Asset => ({
  id: row.id,
  origin: row.origin as AssetOrigin,
  brandKitId: row.brand_kit_id,
  generationJobId: row.generation_job_id,
  ownerSubject: row.owner_subject,
  kind: row.kind as AssetKind | 'upload',
  format: row.format as BlobFormat,
  mediaType: row.media_type,
  declaredWidth: row.declared_width,
  declaredHeight: row.declared_height,
  actualWidth: row.actual_width,
  actualHeight: row.actual_height,
  sizing: row.sizing as Sizing,
  storageUrl: row.storage_url,
  checksum: row.checksum,
  byteSize: Number(row.byte_size),
  licence: row.licence,
  c2pa: row.c2pa,
  visibility: row.visibility as AssetVisibility,
  publishedAt: row.published_at?.toISOString() ?? null,
  anchor: toAnchor(row),
  createdAt: row.created_at.toISOString(),
})

const COLUMNS = `id, origin, brand_kit_id, generation_job_id, owner_subject, kind, format,
                 media_type, declared_width, declared_height,
                 actual_width, actual_height, sizing, storage_url, checksum, byte_size, licence,
                 c2pa, visibility, published_at, anchor_tx, anchor_block, anchored_at, created_at`

export interface InsertAsset {
  readonly brandKitId: string
  readonly generationJobId: string
  /** The job's owner, denormalised so an asset's ownership is one read rather than a join. */
  readonly ownerSubject: string
  readonly kind: AssetKind
  readonly format: AssetFormat
  readonly declaredWidth: number
  readonly declaredHeight: number
  readonly actualWidth: number | null
  readonly actualHeight: number | null
  readonly sizing: Sizing
  readonly storageUrl: string
  readonly checksum: string
  readonly byteSize: number
  readonly c2pa: boolean
}

/** The media type a generated format is served as. `svg` is ours, and is never user-supplied. */
const GENERATED_MEDIA_TYPES: Readonly<Record<AssetFormat, string>> = Object.freeze({
  png: 'image/png',
  svg: 'image/svg+xml',
})

export async function insertAsset(sql: Db | Tx, input: InsertAsset): Promise<Asset> {
  const rows = await sql<AssetRow[]>`
    insert into assets (
      origin, brand_kit_id, generation_job_id, owner_subject, kind, format, media_type,
      declared_width, declared_height,
      actual_width, actual_height, sizing, storage_url, checksum, byte_size, licence, c2pa
    ) values (
      'generated',
      ${input.brandKitId}, ${input.generationJobId}, ${input.ownerSubject}, ${input.kind},
      ${input.format}, ${GENERATED_MEDIA_TYPES[input.format]},
      ${input.declaredWidth}, ${input.declaredHeight},
      ${input.actualWidth}, ${input.actualHeight}, ${input.sizing},
      ${input.storageUrl}, ${input.checksum}, ${input.byteSize.toString()}::bigint,
      ${GENERATED_LICENCE}, ${input.c2pa}
    )
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new Error('asset insert returned no row')
  return toAsset(row)
}

export interface InsertUpload {
  readonly ownerSubject: string
  readonly format: UploadFormat
  readonly mediaType: string
  readonly width: number
  readonly height: number
  readonly storageUrl: string
  readonly checksum: string
  readonly byteSize: number
  /** `private` unless the uploader explicitly asked otherwise. See migration 10. */
  readonly visibility: AssetVisibility
  /** Who published it. Required when `visibility` is `public`. */
  readonly publishedBy: string | null
}

/**
 * Record an uploaded asset, idempotently for the same owner and the same bytes.
 *
 * `on conflict do nothing` against `assets_upload_is_its_bytes`, then read the winner back. A
 * retried upload — a flaky connection, a double-tapped button — is one row and one answer rather
 * than a duplicate the user then has to choose between. The blob is written before this and is
 * content-addressed, so the retry rewrites identical bytes to the identical path and the two halves
 * stay consistent whichever one is repeated.
 *
 * `sizing` is `'exact'` because for an upload the declared size IS the measured size: there was no
 * spec to miss. `assets_exact_means_measured` holds us to that — the declared and actual columns
 * carry the same numbers, and they came off the file's own header.
 *
 * `c2pa` is `false` and is a measurement, not a default: these bytes did not come from FLUX, so
 * there is no provenance manifest in them.
 */
export async function insertUpload(sql: Db | Tx, input: InsertUpload): Promise<Asset> {
  const publishedBy = input.visibility === 'public' ? input.publishedBy : null
  if (input.visibility === 'public' && !publishedBy) {
    // `assets_publication_is_recorded` would refuse this anyway; failing here names the caller's
    // mistake rather than surfacing it as a constraint violation four layers down.
    throw new Error('a public asset must record who published it')
  }

  const inserted = await sql<AssetRow[]>`
    insert into assets (
      origin, owner_subject, kind, format, media_type,
      declared_width, declared_height, actual_width, actual_height, sizing,
      storage_url, checksum, byte_size, licence, c2pa,
      visibility, published_at, published_by
    ) values (
      'upload', ${input.ownerSubject}, 'upload', ${input.format}, ${input.mediaType},
      ${input.width}, ${input.height}, ${input.width}, ${input.height}, 'exact',
      ${input.storageUrl}, ${input.checksum}, ${input.byteSize.toString()}::bigint,
      ${UPLOADED_LICENCE}, false,
      ${input.visibility},
      ${input.visibility === 'public' ? sql`now()` : null},
      ${publishedBy}
    )
    on conflict (owner_subject, checksum) where origin = 'upload' do nothing
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = inserted[0]
  if (row) return toAsset(row)

  const existing = await sql<AssetRow[]>`
    select ${sql.unsafe(COLUMNS)}
      from assets
     where origin = 'upload'
       and owner_subject = ${input.ownerSubject}
       and checksum = ${input.checksum}
  `
  const found = existing[0]
  if (!found) throw new Error('the upload conflicted but no existing row was found')
  return toAsset(found)
}

/**
 * Publish or unpublish an asset's bytes.
 *
 * Idempotent: publishing an already-public asset keeps the ORIGINAL `published_at` rather than
 * refreshing it, because the question that column answers is "since when have these bytes been
 * fetchable without a token", and a re-publish does not change that answer.
 *
 * Unpublishing clears both columns, which `assets_publication_is_recorded` requires. It is worth
 * being plain about what unpublishing does and does not achieve: it stops this service serving the
 * bytes, and it does nothing whatever about copies already taken. Anything that has been public on
 * the internet should be assumed to have been copied.
 */
export async function setAssetVisibility(
  sql: Db | Tx,
  id: string,
  visibility: AssetVisibility,
  publishedBy: string,
): Promise<Asset | null> {
  const rows = await sql<AssetRow[]>`
    update assets
       set visibility   = ${visibility},
           published_at = ${visibility === 'public' ? sql`coalesce(published_at, now())` : null},
           published_by = ${visibility === 'public' ? publishedBy : null}
     where id = ${id}
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toAsset(row) : null
}

export async function findAsset(sql: Db, id: string): Promise<Asset | null> {
  const rows = await sql<AssetRow[]>`select ${sql.unsafe(COLUMNS)} from assets where id = ${id}`
  const row = rows[0]
  return row ? toAsset(row) : null
}

export async function listAssetsForKit(sql: Db, brandKitId: string, limit: number): Promise<Asset[]> {
  const rows = await sql<AssetRow[]>`
    select ${sql.unsafe(COLUMNS)}
      from assets
     where brand_kit_id = ${brandKitId}
     order by created_at desc
     limit ${limit}
  `
  return rows.map(toAsset)
}
