/**
 * The Kiln: an object out of a prompt, and the placements that put it in the world.
 *
 * §9.1: "Tessera inverts the wall because the estate has already built the pipeline. Firing an
 * object is: describe it, pick a footprint, wait about a minute."
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A FIRING IS A LEASED JOB, NOT A REQUEST HANDLER — ON BOTH SIDES.
 *
 * `micro-studio` returns **202 with a `statusUrl`** (`studio/src/server.ts`);
 * `requestGeneration` opens no socket (`studio/src/generation.ts`) and `runGeneration`
 * executes inside a lease claimed `for update skip locked`. Its lease key is `owner:<subject>`
 * (`studio/src/generation.ts`).
 *
 * Tessera uses **the same key shape**, deliberately (§11.4): one player's firings serialise
 * consistently on both sides, so a player who fires ten objects at once cannot stampede the
 * provider from either end. A different key here would mean Tessera happily dispatching ten
 * requests that studio then serialises anyway, with nine of them holding a lease slot for nothing.
 *
 * The service token this calls with holds `studio:write`. §9.1: "A **service** principal skips
 * ownership narrowing entirely — `assertOwned` returns early at `studio/src/server.ts` — and
 * names the acting user via `body.userId` (`subjectOf`, `studio/src/server.ts`). So a
 * title can generate on a player's behalf without impersonating them."
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Db, Tx } from './outbox.ts'
import { withOutbox } from './outbox.ts'
import { OBJECT_ANCHORED, OBJECT_FIRED } from './topics.ts'
import { ensureAccount, WorldError } from './world.ts'

/** §2.6's twelve categories. The database holds the same list in a CHECK. */
export const CATEGORIES = Object.freeze([
  'seating',
  'surfaces',
  'storage',
  'lighting',
  'structure',
  'flooring',
  'foliage',
  'signage',
  'machines',
  'instruments',
  'vehicles',
  'ornament',
] as const)

export type Category = (typeof CATEGORIES)[number]

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value)
}

/**
 * §6.3: "Object footprints — **2** — `1x1` and `2x2`."
 */
export const FOOTPRINTS = Object.freeze(['1x1', '2x2'] as const)
export type Footprint = (typeof FOOTPRINTS)[number]

/**
 * §6.3: "Facings per object — **2** — one canonical render plus its mirror."
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO, AND THE REASON IS A MISSING COLUMN IN SOMEBODY ELSE'S DATABASE.
 *
 * §2.1: "This is not laziness, it is forced: `micro-studio` has **no `seed` column** — the
 * generation schema at `studio/src/migrations.ts` records `prompt`, `backend_choice`,
 * `backend`, `model`, `requested_size`, `attempts`, `cost_estimate`, `provider_cost_units`,
 * `credit_state` and `checksum`, and nothing else. **A pipeline that cannot fix a seed cannot
 * render the same chair four times.**"
 *
 * So the second facing is a horizontal mirror applied at render time, not a second asset. The day
 * studio stores a seed, this is a migration that widens one CHECK and a constant — not a hunt for
 * every place four facings were assumed, which is what it would be if the number lived in the
 * renderer.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const FACINGS = Object.freeze(['canonical', 'mirrored'] as const)
export type Facing = (typeof FACINGS)[number]

/** The asset kind Tessera asks studio for. §9.1's "one studio change ... and it is small". */
export const STUDIO_ASSET_KIND = 'world_object'

/** §2.6: objects are authored on a 512×512 canvas, and every dimension is a multiple of 16. */
export const OBJECT_CANVAS = 512

export interface WorldObject {
  readonly id: string
  readonly authorSubject: string
  readonly prompt: string
  readonly category: Category
  readonly footprint: Footprint
  readonly status: 'firing' | 'fired' | 'failed'
  readonly checksum: string | null
  readonly c2pa: boolean | null
  readonly anchorTx: string | null
  readonly anchorBlock: string | null
  readonly anchoredAt: string | null
  readonly createdAt: string
}

interface ObjectRow {
  readonly id: string
  readonly author_subject: string
  readonly prompt: string
  readonly category: string
  readonly footprint: string
  readonly status: string
  readonly checksum: string | null
  readonly c2pa: boolean | null
  readonly anchor_tx: string | null
  readonly anchor_block: string | null
  readonly anchored_at: Date | null
  readonly created_at: Date
}

const OBJECT_COLUMNS = `id, author_subject, prompt, category, footprint, status, checksum, c2pa,
  anchor_tx, anchor_block::text as anchor_block, anchored_at, created_at`

export function toObject(row: ObjectRow): WorldObject {
  return {
    id: row.id,
    authorSubject: row.author_subject,
    prompt: row.prompt,
    category: row.category as Category,
    footprint: row.footprint as Footprint,
    status: row.status as WorldObject['status'],
    checksum: row.checksum,
    c2pa: row.c2pa,
    anchorTx: row.anchor_tx,
    anchorBlock: row.anchor_block,
    anchoredAt: row.anchored_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }
}

/**
 * The lease key one player's firings serialise on.
 *
 * `owner:<subject>` — the same shape `studio/src/generation.ts` uses. §11.4: "deliberately the
 * same key shape studio uses, so one player's firings serialise consistently on both sides."
 */
export function firingLeaseKey(subject: string): string {
  return `owner:${subject}`
}

export interface FireInput {
  readonly authorSubject: string
  readonly prompt: string
  readonly category: Category
  readonly footprint: Footprint
  readonly correlationId: string
}

/**
 * Start a firing. Returns immediately with a `firing` row; the job does the work.
 *
 * The row is written first and the provider is called from the job, never from here. That order is
 * the point: a request handler that awaited a minute of diffusion would hold a socket, a
 * connection and a lifecycle track for the whole of it, and a client that gave up would leave the
 * generation running with nothing to record it against.
 */
export async function requestFiring(sql: Db, input: FireInput): Promise<WorldObject> {
  if (input.prompt.trim().length === 0 || input.prompt.length > 2_000) {
    throw new WorldError('bad_prompt', 'a prompt must be 1 to 2000 characters', 400)
  }
  return withOutbox(sql, async (tx) => {
    await ensureAccount(tx, input.authorSubject)
    const rows = await tx<ObjectRow[]>`
      insert into objects (author_subject, prompt, category, footprint, status)
      values (${input.authorSubject}, ${input.prompt.trim()}, ${input.category},
              ${input.footprint}, 'firing')
      returning ${tx.unsafe(OBJECT_COLUMNS)}
    `
    const row = rows[0]
    if (!row) throw new WorldError('not_fired', 'the firing did not start')
    return toObject(row)
  })
}

export interface FiringOutcome {
  readonly objectId: string
  readonly checksum: string
  /**
   * MEASURED off the bytes by studio, never asserted. §2.2, §9.1.
   *
   * `null` when studio did not publish a measurement — which today is always, because neither
   * `wireJob` nor `provenanceOf` carries `c2pa` (see `studioclient.ts`'s `GenerateOutcome`). Null
   * means "nobody measured this"; `false` would mean "somebody measured it and it was absent",
   * and the two must not be one value on a claim about provenance.
   */
  readonly c2pa: boolean | null
  readonly correlationId: string
}

/**
 * Where a firing got to with micro-studio, so a retried lease resumes instead of starting over.
 *
 * The two upstream ids are read from the row rather than carried on the job payload for the same
 * reason the object's own prompt is: `index.ts` enqueues `{ objectId, subject }` and nothing else,
 * a `RunnerEvent` carries no payload at all, and a payload is written once whereas a row is
 * written as the work progresses. See migration 12 for what a firing that cannot resume costs.
 */
export interface FiringProgress {
  readonly objectId: string
  readonly authorSubject: string
  /** The PLAYER's description. Studio composes the brief around it; see `studioclient.ts`. */
  readonly description: string
  readonly status: WorldObject['status']
  readonly brandKitId: string | null
  readonly generationJobId: string | null
  readonly statusUrl: string | null
}

export async function firingProgressOf(sql: Db, objectId: string): Promise<FiringProgress | null> {
  const rows = await sql<
    {
      id: string
      author_subject: string
      prompt: string
      status: string
      studio_brand_kit_id: string | null
      studio_generation_job_id: string | null
      studio_status_url: string | null
    }[]
  >`
    select id, author_subject, prompt, status, studio_brand_kit_id, studio_generation_job_id,
           studio_status_url
      from objects where id = ${objectId}
  `
  const row = rows[0]
  if (!row) return null
  return {
    objectId: row.id,
    authorSubject: row.author_subject,
    description: row.prompt,
    status: row.status as WorldObject['status'],
    brandKitId: row.studio_brand_kit_id,
    generationJobId: row.studio_generation_job_id,
    statusUrl: row.studio_status_url,
  }
}

/** Record the brand kit studio minted for this firing, before the generation is asked for. */
export async function recordBrandKit(sql: Db, objectId: string, brandKitId: string): Promise<void> {
  await sql`
    update objects set studio_brand_kit_id = ${brandKitId}
     where id = ${objectId} and studio_brand_kit_id is null
  `
}

/** Record the generation studio accepted, the moment it answers 202 and before the first poll. */
export async function recordGeneration(
  sql: Db,
  objectId: string,
  generationJobId: string,
  statusUrl: string,
): Promise<void> {
  await sql`
    update objects
       set studio_generation_job_id = ${generationJobId}, studio_status_url = ${statusUrl}
     where id = ${objectId} and studio_generation_job_id is null
  `
}

/**
 * Record a completed firing.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE COLLISION PATH IS THE COPYBOT ANSWER, AND IT IS A `SELECT`, NOT A REFUSAL.
 *
 * §9.2: "Identity is the hash, so 'copying' resolves to the original. A Tessera object *is* its
 * bytes. Re-uploading identical bytes does not create a second object with a second owner; it
 * resolves to the existing content address and its existing Author of record."
 *
 * So when the checksum already exists this does not raise — it returns the EXISTING object, whose
 * `author_subject` is whoever fired those bytes first, and marks the duplicate firing `failed`
 * with a reason that says so. The naive implementations are both wrong: raising 409 would make an
 * honest coincidence look like an error, and inserting anyway would create the second owner the
 * whole design exists to make impossible. `tessera_objects_are_their_bytes` guarantees the second
 * insert cannot land whatever this function does; this is what the user is told about it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function completeFiring(sql: Db, outcome: FiringOutcome): Promise<WorldObject> {
  return withOutbox(sql, async (tx, emit) => {
    const existing = await tx<ObjectRow[]>`
      select ${tx.unsafe(OBJECT_COLUMNS)} from objects where checksum = ${outcome.checksum}
    `
    const already = existing[0]
    if (already && already.id !== outcome.objectId) {
      await tx`
        update objects
           set status = 'failed',
               failure_reason = ${`these bytes are already object ${already.id}, authored by ${already.author_subject} — an object is its bytes (23-tessera.md §9.2)`}
         where id = ${outcome.objectId}
      `
      return toObject(already)
    }

    // `studio_asset_id` is NOT written here, and its emptiness is a fact about studio rather than
    // an omission: `GET /v1/jobs/:id` answers `{ job, provenance }` and neither carries the
    // asset's id (`wireJob`, `studio/src/server.ts`; `provenanceOf`,
    // `studio/src/generation.ts`). It exists on `studio.asset.created`, which this
    // service does not consume. The generation job id IS known, and is written by
    // `recordGeneration` when studio hands it over rather than here at the end.
    const rows = await tx<ObjectRow[]>`
      update objects
         set status = 'fired',
             checksum = ${outcome.checksum},
             c2pa = ${outcome.c2pa}
       where id = ${outcome.objectId} and status = 'firing'
      returning ${tx.unsafe(OBJECT_COLUMNS)}
    `
    const row = rows[0]
    if (!row) throw new WorldError('not_found', 'no such firing in progress', 404)
    const object = toObject(row)
    emit({
      topic: OBJECT_FIRED,
      // `keyedBy: 'object_id'`. The author is a payload field: an actor is not a discriminator,
      // and keying by the author would give one person's ten firings one partition and no
      // ordering relationship between two firings of the same object.
      key: object.id,
      payload: {
        objectId: object.id,
        authorSubject: object.authorSubject,
        checksum: object.checksum,
        category: object.category,
        footprint: object.footprint,
        // Measured, not asserted — the distinction §2.2 says a repo that gets wrong "will be
        // wrong quietly".
        c2pa: object.c2pa,
      },
      actor: `user:${object.authorSubject.slice('user:'.length)}`,
      correlationId: outcome.correlationId,
    })
    return object
  })
}

export async function failFiring(sql: Db, objectId: string, reason: string): Promise<void> {
  await sql`
    update objects set status = 'failed', failure_reason = ${reason.slice(0, 2_000)}
     where id = ${objectId} and status = 'firing'
  `
}

export async function findObject(sql: Db, id: string): Promise<WorldObject | null> {
  const rows = await sql<ObjectRow[]>`
    select ${sql.unsafe(OBJECT_COLUMNS)} from objects where id = ${id}
  `
  const row = rows[0]
  return row ? toObject(row) : null
}

export async function listObjectsOf(sql: Db, subject: string, limit = 100): Promise<WorldObject[]> {
  const rows = await sql<ObjectRow[]>`
    select ${sql.unsafe(OBJECT_COLUMNS)} from objects
     where author_subject = ${subject} order by created_at desc limit ${limit}
  `
  return rows.map(toObject)
}

/* ------------------------------------------------------------------------------ anchoring */

export interface AnchorInput {
  readonly objectId: string
  readonly transactionHash: string
  readonly blockNumber: bigint
  readonly correlationId: string
}

/**
 * Record that authorship was written to Hearth's Registry of Authorship.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * NOTHING CALLS THIS YET, AND THE REASON IS NOT THE ONE THIS COMMENT USED TO GIVE.
 *
 * It claimed v1 anchors "through the existing `mint` deploy path". Checked, and it is false, which
 * matters because it made the gap look like wiring rather than a contract that does not exist:
 *
 *   - `mint` deploys a CLOSED catalogue of three ERC-20 token contracts — `fixed | mintable |
 *     foundry` (`mint/src/catalogue.ts`) — each with bytecode committed beside it
 *, chosen by `variantFor(features)` over `mintable | burnable |
 *     pausable`. There is no fourth variant and no route that deploys arbitrary bytecode, so there
 *     is no "existing path" a registry could travel down.
 *   - `hearth/contracts/src/` holds the HearthV2 AMM (Router, Factory, Pair, ERC20), WEMBER and
 *     Multicall3. There is NO Registry of Authorship contract; the Solidity has never been
 *     written. A grep for "authorship" across `micro-hearth` returns nothing.
 *
 * So three things must land before this function has a caller, in this order:
 *   1. A Registry of Authorship contract in `hearth/contracts/src/`, and a deployment of it — no
 *      contract has ever been deployed to a running Hearth.
 *   2. A fourth variant in `mint/src/catalogue.ts` carrying its committed bytecode, or a general
 *      deploy path. Today's catalogue cannot express a non-token contract.
 *   3. A caller here, at the seam §9.3 names: written when a creator first LISTS an object, not
 *      when they fire it, "because most objects are never sold and paying gas to anchor a chair
 *      nobody sells is waste."
 *
 * The platform key is right and is not a blocker: a player cannot sign through custody, whose
 * signable purposes are `deployer | treasury | deposit` (`custody/src/gates.ts`) with `user`
 * deliberately excluded and the reason given. §9.3 gates v2 PLAYER-SIGNED deeds on that;
 * it does not gate v1.
 *
 * ── WHY THIS IS KEPT RATHER THAN DELETED ──────────────────────────────────────────────────────
 *
 * A registered topic nothing emits is usually dead code. This one is not, and the difference is
 * checkable: `micro-notify` has a COMPLETE, unblocked rule for `tessera.object.anchored`
 * (`notify/src/catalogue.ts`) with a template (`notify/src/templates.ts`) and its own
 * tests, and `contracts` registers it as audited with `subjectKind: 'user'`
 * (`contracts/packages/events/src/audit.ts`) because "the platform acts with authority over a
 * user's property". Deleting the emitter would strand a written consumer and require editing two
 * other repositories to keep them honest.
 *
 * What WAS wrong is that this function had no caller and no test, so its payload's agreement with
 * that waiting consumer was never checked. It is exercised now — see kiln.test.ts — against the
 * fields notify actually reads. Unwired is a fact about the chain; unverified was a defect here.
 *
 * `objects_anchor_is_whole` refuses half an anchor and `objects_anchor_needs_bytes` refuses one
 * against an object with no content address, so an anchor row that exists is one the chain can be
 * asked about.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function recordAnchor(sql: Db, input: AnchorInput): Promise<WorldObject> {
  return withOutbox(sql, async (tx, emit) => {
    const rows = await tx<ObjectRow[]>`
      update objects
         set anchor_tx = ${input.transactionHash},
             anchor_block = ${input.blockNumber.toString()}::bigint,
             anchored_at = now()
       where id = ${input.objectId} and anchor_tx is null
      returning ${tx.unsafe(OBJECT_COLUMNS)}
    `
    const row = rows[0]
    if (!row) throw new WorldError('not_found', 'no such object, or it is already anchored', 404)
    const object = toObject(row)
    emit({
      topic: OBJECT_ANCHORED,
      key: object.id,
      payload: {
        objectId: object.id,
        // The audit table's `subjectKind: 'user'` reads THIS field, not the envelope key — the
        // custody defect in reverse, and stated in both places on purpose.
        authorSubject: object.authorSubject,
        checksum: object.checksum,
        transactionHash: object.anchorTx,
        blockNumber: object.anchorBlock,
      },
      actor: 'system',
      correlationId: input.correlationId,
    })
    return object
  })
}

/* ----------------------------------------------------------------------------- placements */

export interface PlaceInput {
  readonly parcelId: string
  readonly objectId: string
  readonly x: number
  readonly y: number
  readonly facing: Facing
  readonly placedBy: string
}

/**
 * Place one object, or many, on a parcel.
 *
 * A single transaction for the whole batch, which is what makes the deferred object-cap trigger
 * do what §11.6 asks: "pasting 200 objects is one check, not 200". A caller that placed them one
 * request at a time would get 200 checks and, worse, a partial paste when the 173rd crossed the
 * cap.
 */
export async function placeObjects(
  sql: Db,
  placements: readonly PlaceInput[],
): Promise<{ placed: number }> {
  if (placements.length === 0) return { placed: 0 }
  if (placements.length > 500) {
    throw new WorldError('too_many', 'place at most 500 objects at once', 400)
  }
  try {
    return await withOutbox(sql, async (tx) => {
      for (const p of placements) {
        await tx`
          insert into placements (parcel_id, object_id, x, y, facing, placed_by)
          values (${p.parcelId}, ${p.objectId}, ${p.x}, ${p.y}, ${p.facing}, ${p.placedBy})
        `
      }
      return { placed: placements.length }
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('object cap')) {
      throw new WorldError('over_object_cap', message, 409)
    }
    throw err
  }
}

export async function removePlacement(sql: Db, placementId: string, owner: string): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    delete from placements p
     using parcels pa
     where p.id = ${placementId}
       and p.parcel_id = pa.id
       and pa.owner_subject = ${owner}
    returning p.id
  `
  if (rows.length === 0) throw new WorldError('not_found', 'no such placement on a parcel of yours', 404)
}

export interface Placement {
  readonly id: string
  readonly parcelId: string
  readonly objectId: string
  readonly x: number
  readonly y: number
  readonly facing: Facing
  readonly placedAt: string
}

export async function listPlacements(sql: Db, parcelId: string): Promise<Placement[]> {
  const rows = await sql<
    {
      id: string
      parcel_id: string
      object_id: string
      x: number
      y: number
      facing: string
      placed_at: Date
    }[]
  >`
    select id, parcel_id, object_id, x, y, facing, placed_at
      from placements where parcel_id = ${parcelId} order by placed_at
  `
  return rows.map((r) => ({
    id: r.id,
    parcelId: r.parcel_id,
    objectId: r.object_id,
    x: r.x,
    y: r.y,
    facing: r.facing as Facing,
    placedAt: r.placed_at.toISOString(),
  }))
}

export type { Tx }
