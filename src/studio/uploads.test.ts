/**
 * The upload pipeline against a real database and the real migrations.
 *
 * These cases exist to prove the things a unit test with a fake store cannot: that the CHECK
 * constraints added in migration 9 actually refuse the rows they claim to, that the partial unique
 * index deduplicates per owner without colliding across owners, and that the quota is counted off
 * rows rather than off a variable.
 *
 * `testsupport.ts` runs the REAL `MIGRATIONS`, deliberately, so a constraint cannot drift away from
 * the test that is supposed to prove it holds.
 */

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type postgres from 'postgres'
import { filesystemBlobStore, findAsset, type Asset } from './assets.ts'
import { UploadRejected } from './imagebytes.ts'
import {
  DEFAULT_UPLOAD_QUOTA,
  UploadQuotaError,
  changeVisibility,
  storeUpload,
  type UploadDeps,
} from './uploads.ts'
import { enabled, migrateTestDb, openDb, resetStudio, skip } from './testsupport.ts'

const OWNER = 'user:11111111-1111-4111-8111-111111111111'
const OTHER = 'user:22222222-2222-4222-8222-222222222222'

let sql: postgres.Sql
let root: string

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
  root = await mkdtemp(join(tmpdir(), 'studio-uploads-'))
})

beforeEach(async () => {
  if (!enabled) return
  await resetStudio(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
  await rm(root, { recursive: true, force: true })
})

function deps(overrides: Partial<UploadDeps> = {}): UploadDeps {
  return {
    sql,
    producer: 'studio-test',
    blobs: filesystemBlobStore(root, ''),
    quota: DEFAULT_UPLOAD_QUOTA,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ fixtures */

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

/** A valid PNG, optionally carrying a text chunk that the strip must remove. */
function png(width = 64, height = 48, secret?: string): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(secret ? [pngChunk('tEXt', Buffer.from(`Comment\x00${secret}`, 'latin1'))] : []),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const input = (
  bytes: Buffer,
  ownerSubject = OWNER,
  visibility: 'private' | 'public' = 'private',
) => ({
  bytes,
  ownerSubject,
  visibility,
  actor: `service:studio-test`,
  correlationId: 'corr-1',
})

/* ------------------------------------------------------------------ tests */

test('an upload is stored, addressed by its bytes, and readable back', { skip }, async () => {
  const outcome = await storeUpload(deps(), input(png()))

  assert.equal(outcome.asset.origin, 'upload')
  assert.equal(outcome.asset.ownerSubject, OWNER)
  assert.equal(outcome.asset.format, 'png')
  assert.equal(outcome.asset.mediaType, 'image/png')
  assert.equal(outcome.asset.actualWidth, 64)
  assert.equal(outcome.asset.actualHeight, 48)
  // An upload has no spec to miss, so the declared size IS the measured size.
  assert.equal(outcome.asset.sizing, 'exact')
  // Not FLUX output, so there is no C2PA manifest. Measured, not defaulted.
  assert.equal(outcome.asset.c2pa, false)
  assert.equal(outcome.asset.brandKitId, null)
  assert.equal(outcome.asset.generationJobId, null)

  // The bytes are where the content address says they are.
  const stored = await filesystemBlobStore(root, '').get(outcome.asset.checksum, 'png')
  assert.ok(stored, 'the blob was not written')
  assert.equal(`sha256:${createHash('sha256').update(stored).digest('hex')}`, outcome.asset.checksum)
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CHECKSUM IS OVER THE STRIPPED BYTES. This is the ordering the whole privacy story rests on:
 * hash the upload as it arrived and the stored digest is a digest of somebody's EXIF, and the
 * content address does not address the content that is actually served.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('the stored checksum is of the stripped bytes, not the uploaded ones', { skip }, async () => {
  const withMetadata = png(64, 48, 'taken at 51.5074,-0.1278')
  const uploadedDigest = `sha256:${createHash('sha256').update(withMetadata).digest('hex')}`

  const outcome = await storeUpload(deps(), input(withMetadata))
  assert.notEqual(outcome.asset.checksum, uploadedDigest, 'the digest is of the unstripped bytes')
  assert.ok(outcome.strippedBytes > 0)

  const stored = await filesystemBlobStore(root, '').get(outcome.asset.checksum, 'png')
  assert.ok(stored)
  assert.ok(
    !stored.includes(Buffer.from('51.5074', 'latin1')),
    'the location survived into the stored blob',
  )
})

test('two uploads of the same picture with different metadata converge on one asset', { skip }, async () => {
  // The pictures are identical; only the metadata differs. After stripping they are the same bytes,
  // so they are the same asset — which is the deduplication that content addressing buys.
  const first = await storeUpload(deps(), input(png(64, 48, 'phone A, home')))
  const second = await storeUpload(deps(), input(png(64, 48, 'phone B, office')))

  assert.equal(first.asset.checksum, second.asset.checksum)
  assert.equal(second.asset.id, first.asset.id)
  assert.equal(second.deduplicated, true, 'the second upload should have been recognised')

  const rows = await sql<{ count: string }[]>`select count(*)::text as count from assets`
  assert.equal(rows[0]?.count, '1', 'a duplicate row was written')
})

test('a retried upload is idempotent rather than a second asset', { skip }, async () => {
  const bytes = png()
  const first = await storeUpload(deps(), input(bytes))
  const retry = await storeUpload(deps(), input(bytes))

  assert.equal(retry.asset.id, first.asset.id)
  assert.equal(first.deduplicated, false)
  assert.equal(retry.deduplicated, true)
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CROSS-TENANT CASE, and the reason the unique index is on `(owner_subject, checksum)` rather
 * than on `checksum` alone. A globally unique index would hand the second uploader a row owned by
 * the first — disclosing that they uploaded it, and giving away a reference to their asset.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('two different owners uploading identical bytes get separate assets', { skip }, async () => {
  const bytes = png()
  const mine = await storeUpload(deps(), input(bytes, OWNER))
  const theirs = await storeUpload(deps(), input(bytes, OTHER))

  assert.notEqual(theirs.asset.id, mine.asset.id, 'one owner received another owner\'s asset')
  assert.equal(theirs.asset.ownerSubject, OTHER)
  // Same content address, because they are the same bytes — so the blob is stored exactly once
  // even though there are two rows.
  assert.equal(theirs.asset.checksum, mine.asset.checksum)
  assert.equal(theirs.deduplicated, false)
})

test('a refused upload writes nothing and consumes no quota', { skip }, async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>', 'utf8')
  await assert.rejects(
    () => storeUpload(deps(), input(svg)),
    (err: unknown) => err instanceof UploadRejected && err.reason === 'svg_refused',
  )

  const rows = await sql<{ count: string }[]>`select count(*)::text as count from assets`
  assert.equal(rows[0]?.count, '0', 'a refused upload left a row behind')
})

test('the daily upload count is enforced off the rows', { skip }, async () => {
  // The images must genuinely DIFFER, and varying only the metadata would not do it: the strip
  // removes the metadata, the bytes converge and all three deduplicate to one row — which is the
  // system behaving correctly and would make this assert nothing. So the pixels differ.
  const quota = { dailyCount: 2, dailyBytes: 1_000_000, windowHours: 24 }
  await storeUpload(deps({ quota }), input(png(64, 48)))
  await storeUpload(deps({ quota }), input(png(64, 49)))

  await assert.rejects(
    () => storeUpload(deps({ quota }), input(png(64, 50))),
    (err: unknown) => err instanceof UploadQuotaError && err.limit === 2,
  )

  // And it is per owner: a second account is unaffected by the first one's usage.
  const other = await storeUpload(deps({ quota }), input(png(64, 51), OTHER))
  assert.equal(other.asset.ownerSubject, OTHER)
})

test('the daily byte budget is enforced separately from the count', { skip }, async () => {
  // A count of 1000 is nowhere near reached; only the byte budget can refuse this.
  const quota = { dailyCount: 1_000, dailyBytes: 50, windowHours: 24 }
  await assert.rejects(
    () => storeUpload(deps({ quota }), input(png())),
    (err: unknown) => err instanceof UploadQuotaError && err.limit === 50,
  )
})

test('an upload emits exactly one outbox event, and not on the retry', { skip }, async () => {
  const bytes = png()
  await storeUpload(deps(), input(bytes))
  await storeUpload(deps(), input(bytes))

  const rows = await sql<{ topic: string; payload: Record<string, unknown> }[]>`
    select topic, payload from outbox order by occurred_at
  `
  assert.equal(rows.length, 1, 'the deduplicated retry re-announced an asset consumers already had')
  assert.equal(rows[0]?.topic, 'studio.asset.uploaded')
  // The event states the anchor state rather than leaving a consumer to infer it.
  assert.equal(rows[0]?.payload['anchorState'], 'unanchored')
})

/* ------------------------------------------------------------------ the schema itself */

test('the schema refuses an upload row that carries a generation job', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into assets (origin, owner_subject, brand_kit_id, generation_job_id, kind, format,
                          media_type, declared_width, declared_height, sizing, storage_url,
                          checksum, byte_size, licence)
      values ('upload', ${OWNER}, gen_random_uuid(), gen_random_uuid(), 'upload', 'png',
              'image/png', 8, 8, 'unknown', 'file:///x',
              ${'sha256:' + 'a'.repeat(64)}, 1, 'l')
    `,
    /assets_origin_consistent|violates foreign key/,
  )
})

test('the schema refuses a generated asset with no generation job', { skip }, async () => {
  // The provenance invariant, still absolute for the origin where it means anything.
  await assert.rejects(
    () => sql`
      insert into assets (origin, kind, format, declared_width, declared_height, sizing,
                          storage_url, checksum, byte_size, licence)
      values ('generated', 'mark', 'png', 8, 8, 'unknown', 'file:///x',
              ${'sha256:' + 'b'.repeat(64)}, 1, 'l')
    `,
    /assets_origin_consistent/,
  )
})

test('the schema refuses a checksum that is not studio\'s spelling', { skip }, async () => {
  for (const bad of ['abc', 'sha256:XYZ', 'a'.repeat(64), `sha256:${'A'.repeat(64)}`]) {
    await assert.rejects(
      () => sql`
        insert into assets (origin, owner_subject, kind, format, media_type, declared_width,
                            declared_height, sizing, storage_url, checksum, byte_size, licence)
        values ('upload', ${OWNER}, 'upload', 'png', 'image/png', 8, 8, 'unknown', 'file:///x',
                ${bad}, 1, 'l')
      `,
      /assets_checksum_shape/,
      `${bad} was accepted as a checksum`,
    )
  }
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * HALF AN ANCHOR IS REFUSED BY THE DATABASE. This is the constraint that makes "anchored" a claim
 * the chain can back rather than a column somebody filled in. Copied from tessera's
 * `objects_anchor_is_whole`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('the schema refuses half an anchor', { skip }, async () => {
  const outcome = await storeUpload(deps(), input(png()))
  for (const half of [
    sql`update assets set anchor_tx = '0xabc' where id = ${outcome.asset.id}`,
    sql`update assets set anchor_block = 12 where id = ${outcome.asset.id}`,
    sql`update assets set anchored_at = now() where id = ${outcome.asset.id}`,
    sql`update assets set anchor_tx = '0xabc', anchor_block = 12 where id = ${outcome.asset.id}`,
  ]) {
    await assert.rejects(() => half, /assets_anchor_is_whole/)
  }
})

/* ------------------------------------------------------------------ visibility */

test('an upload is private unless it was explicitly published', { skip }, async () => {
  const quiet = await storeUpload(deps(), input(png(), OWNER, 'private'))
  assert.equal(quiet.asset.visibility, 'private')
  assert.equal(quiet.asset.publishedAt, null)

  const loud = await storeUpload(deps(), input(png(64, 49), OWNER, 'public'))
  assert.equal(loud.asset.visibility, 'public')
  assert.ok(loud.asset.publishedAt, 'a public asset must record when it became public')
})

test('publishing is idempotent and does not move the original publication time', { skip }, async () => {
  const stored = await storeUpload(deps(), input(png()))
  const published = await changeVisibility(deps(), {
    assetId: stored.asset.id,
    visibility: 'public',
    actor: 'user:someone',
    correlationId: 'c',
  })
  assert.equal(published?.visibility, 'public')
  const firstPublishedAt = published?.publishedAt
  assert.ok(firstPublishedAt)

  const again = await changeVisibility(deps(), {
    assetId: stored.asset.id,
    visibility: 'public',
    actor: 'user:someone',
    correlationId: 'c',
  })
  // "Since when have these bytes been fetchable without a token" does not change on a re-publish.
  assert.equal(again?.publishedAt, firstPublishedAt)
})

test('unpublishing clears the publication record, as the constraint requires', { skip }, async () => {
  const stored = await storeUpload(deps(), input(png(), OWNER, 'public'))
  const hidden = await changeVisibility(deps(), {
    assetId: stored.asset.id,
    visibility: 'private',
    actor: 'user:someone',
    correlationId: 'c',
  })
  assert.equal(hidden?.visibility, 'private')
  assert.equal(hidden?.publishedAt, null)
})

test('the schema refuses a public asset with no record of who published it', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into assets (origin, owner_subject, kind, format, media_type, declared_width,
                          declared_height, sizing, storage_url, checksum, byte_size, licence,
                          visibility)
      values ('upload', ${OWNER}, 'upload', 'png', 'image/png', 8, 8, 'unknown', 'file:///x',
              ${'sha256:' + 'c'.repeat(64)}, 1, 'l', 'public')
    `,
    /assets_publication_is_recorded/,
  )
})

test('a stored upload reports itself unanchored, because nothing can anchor it yet', { skip }, async () => {
  const outcome = await storeUpload(deps(), input(png()))
  const read = (await findAsset(sql, outcome.asset.id)) as Asset
  assert.equal(read.anchor.state, 'unanchored')
  assert.equal(read.anchor.transactionHash, null)
  assert.equal(read.anchor.blockNumber, null)
  assert.equal(read.anchor.anchoredAt, null)
})
