/**
 * `generation_job` — the pipeline, and the provenance it records.
 *
 * Two halves, and the split between them is the design:
 *
 *   * **`requestGeneration`** runs inside the HTTP request. It resolves the kit, builds the spec
 *     and the prompt, **reserves the credit**, writes the job row and enqueues a leased job. It
 *     opens no socket to a model, so it is a few milliseconds and it cannot be cut in half by a
 *     rolling deploy.
 *   * **`runGeneration`** runs inside a leased job. It is the part that takes 20 to 40 seconds,
 *     and being leased is what makes it survive a restart: the lease is held in a table a second
 *     process can see, not in a module-local boolean, so exactly one replica generates.
 *
 * `mint` records the same lesson at the top of its server: a long third-party call inside the
 * request is cut by a rolling deploy, by Cloudflare's 100-second origin timeout and by any client
 * that gives up — and the worst landing is between spending the money and recording what it
 * bought. Here that landing orphans a paid image with no asset row.
 *
 * ## The credit cap fires before any HTTP request is made
 *
 * `reserve` is called in the same transaction that writes the job row, in the request, before the
 * enqueue. An over-cap account gets `402` having made no image call at all. That ordering is
 * asserted by a test that fails if the fake backend is invoked even once.
 *
 * ## Provenance is written on the same row, in the same transaction as the asset
 *
 * Backend, model, requested size, every attempt including the failed ones, the prompt as it was
 * actually sent, the cost estimate, the provider's own cost units, the checksum and the delivered
 * dimensions. All of it, or the job is not `succeeded`.
 */

import { withOutbox, type Db, type Emit, type Tx } from './outbox.ts'
import { emitUsage, release, reserve, settle, type UsdMicros } from './credits.ts'
import { insertAsset, type Asset, type AssetBlobStore } from './assets.ts'
import { buildPrompt } from './prompt.ts'
import { reportSizing } from './sizing.ts'
import { requestSizeFor, type AssetSpec } from './specs.ts'
import {
  ImageBackendError,
  generateThrough,
  resolveChain,
  type Attempt,
  type BackendChoice,
  type BackendSet,
  type ImageRequest,
} from './backend.ts'
import type { BrandKit } from './brandkits.ts'
import type { Preflight } from './preflight.ts'
import type { Logger } from '@cloudsforge/telemetry'

export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type CreditState = 'reserved' | 'settled' | 'released'

export interface GenerationJob {
  readonly id: string
  readonly brandKitId: string
  readonly ownerSubject: string
  readonly spec: AssetSpec
  readonly status: GenerationStatus
  readonly prompt: string
  /** The backend the CALLER asked for, persisted so the leased job honours it. */
  readonly backendChoice: BackendChoice
  readonly backend: string | null
  readonly model: string | null
  readonly requestedSize: string | null
  readonly attempts: readonly Attempt[]
  readonly costEstimateUsdMicros: UsdMicros
  readonly costActualUsdMicros: UsdMicros
  readonly providerCostUnits: number | null
  readonly creditState: CreditState
  readonly checksum: string | null
  readonly errorCode: string | null
  readonly errorDetail: string | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

interface JobRow {
  readonly id: string
  readonly brand_kit_id: string
  readonly owner_subject: string
  readonly kind: string
  readonly width: number
  readonly height: number
  readonly format: string
  readonly status: string
  readonly prompt: string
  readonly backend_choice: string
  readonly backend: string | null
  readonly model: string | null
  readonly requested_size: string | null
  readonly attempts: unknown
  readonly cost_estimate_usd_micros: string
  readonly cost_actual_usd_micros: string
  readonly provider_cost_units: number | null
  readonly credit_state: string
  readonly checksum: string | null
  readonly error_code: string | null
  readonly error_detail: string | null
  readonly created_at: Date
  readonly started_at: Date | null
  readonly finished_at: Date | null
}

const COLUMNS = `id, brand_kit_id, owner_subject, kind, width, height, format, status, prompt,
                 backend_choice, backend, model, requested_size, attempts,
                 cost_estimate_usd_micros, cost_actual_usd_micros, provider_cost_units,
                 credit_state, checksum, error_code, error_detail, created_at, started_at,
                 finished_at`

const toJob = (row: JobRow): GenerationJob => ({
  id: row.id,
  brandKitId: row.brand_kit_id,
  ownerSubject: row.owner_subject,
  spec: {
    kind: row.kind as AssetSpec['kind'],
    width: row.width,
    height: row.height,
    format: row.format as AssetSpec['format'],
  },
  status: row.status as GenerationStatus,
  prompt: row.prompt,
  backendChoice: row.backend_choice as BackendChoice,
  backend: row.backend,
  model: row.model,
  requestedSize: row.requested_size,
  attempts: Array.isArray(row.attempts) ? (row.attempts as Attempt[]) : [],
  costEstimateUsdMicros: BigInt(row.cost_estimate_usd_micros),
  costActualUsdMicros: BigInt(row.cost_actual_usd_micros),
  providerCostUnits: row.provider_cost_units,
  creditState: row.credit_state as CreditState,
  checksum: row.checksum,
  errorCode: row.error_code,
  errorDetail: row.error_detail,
  createdAt: row.created_at.toISOString(),
  startedAt: row.started_at?.toISOString() ?? null,
  finishedAt: row.finished_at?.toISOString() ?? null,
})

/* ------------------------------------------------------------------------ request */

export interface RequestGenerationInput {
  readonly kit: BrandKit
  readonly spec: AssetSpec
  readonly choice: BackendChoice
  readonly actor: string
  readonly correlationId: string
}

export interface RequestDeps {
  readonly sql: Db
  readonly producer: string
  readonly defaultCreditCapUsdMicros: UsdMicros
  readonly priceUsdMicros: UsdMicros
  /** Enqueue the leased job. Injected so the request path can be tested without a runner. */
  readonly enqueue: (job: { kind: string; key: string; payload: Record<string, unknown> }) => Promise<void>
}

export const GENERATE_KIND = 'asset.generate'

/**
 * Accept a generation. Answers in milliseconds; reaches no model.
 *
 * The whole of the money decision happens here, before the enqueue, in one transaction with the
 * job row. If the reservation fails the transaction rolls back and there is no job, no enqueue and
 * no call — which is what "refuses before any HTTP request is made" has to mean to be worth
 * anything.
 *
 * The placeholder backend costs nothing, so it reserves nothing. Charging a cap for a
 * deterministic SVG would make the cap the reason an offline preview could not be produced.
 */
export async function requestGeneration(
  deps: RequestDeps,
  input: RequestGenerationInput,
): Promise<GenerationJob> {
  const prompt = buildPrompt({
    kitName: input.kit.name,
    accent: input.kit.accent,
    stylePrompt: input.kit.stylePrompt,
    spec: input.spec,
  })
  const estimate = input.choice === 'placeholder' ? 0n : deps.priceUsdMicros

  const job = await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    // Throws CreditCapError, which rolls this transaction back. Nothing is enqueued and no image
    // call is ever made.
    if (estimate > 0n) {
      await reserve(tx, input.kit.ownerSubject, estimate, deps.defaultCreditCapUsdMicros)
    }

    const rows = await tx<JobRow[]>`
      insert into generation_jobs (
        brand_kit_id, owner_subject, kind, width, height, format, prompt, backend_choice,
        cost_estimate_usd_micros, credit_state
      ) values (
        ${input.kit.id}, ${input.kit.ownerSubject}, ${input.spec.kind},
        ${input.spec.width}, ${input.spec.height}, ${input.spec.format}, ${prompt},
        ${input.choice},
        ${estimate.toString()}::bigint,
        ${estimate > 0n ? 'reserved' : 'released'}
      )
      returning ${tx.unsafe(COLUMNS)}
    `
    const row = rows[0]
    if (!row) throw new Error('generation job insert returned no row')
    const created = toJob(row)

    emit({
      topic: 'studio.generation.requested',
      key: created.id,
      payload: {
        id: created.id,
        brandKitId: created.brandKitId,
        ownerSubject: created.ownerSubject,
        kind: created.spec.kind,
        size: `${created.spec.width}x${created.spec.height}`,
        estimateUsdMicros: estimate.toString(),
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
    return created
  })

  // After the commit, deliberately. An enqueue inside the transaction would be invisible to the
  // runner until commit anyway, and a failure here leaves a `queued` row that `sweepQueued` can
  // re-enqueue — whereas a failure inside would roll back a reservation the customer can see.
  await deps.enqueue({
    kind: GENERATE_KIND,
    // The contended resource is the ACCOUNT's spend, not the job row: two generations for one
    // owner must serialise so their reservations and settlements cannot interleave. Keying on the
    // job id would let an owner run their whole cap in parallel and settle out of order.
    key: `owner:${input.kit.ownerSubject}`,
    payload: { generationJobId: job.id },
  })
  return job
}

/* ------------------------------------------------------------------------ run */

export interface RunDeps {
  readonly sql: Db
  readonly producer: string
  readonly backends: BackendSet
  readonly blobs: AssetBlobStore
  readonly preflight: Preflight
  readonly logger: Logger
  /**
   * Optional so a test can drive the pipeline without a registry. See the fallback warning in
   * `runGeneration` for why the counter exists at all.
   */
  readonly metrics?: { increment(name: string, labels?: Record<string, string>): void }
}

export interface RunOutcome {
  readonly job: GenerationJob
  readonly asset: Asset | null
}

/**
 * Generate one asset. The leased half.
 *
 * Claimed with a conditional UPDATE from `queued` to `running`, so a redelivered job — which
 * at-least-once delivery guarantees will happen — does not generate a second image against a
 * reservation that has already been settled.
 */
export async function runGeneration(
  deps: RunDeps,
  generationJobId: string,
  signal: AbortSignal,
): Promise<RunOutcome> {
  const claimed = await deps.sql<JobRow[]>`
    update generation_jobs
       set status = 'running', started_at = now()
     where id = ${generationJobId}
       and status = 'queued'
    returning ${deps.sql.unsafe(COLUMNS)}
  `
  const row = claimed[0]
  if (!row) {
    // Already running, already finished, or gone. Not an error: the redelivery has nothing to do.
    const existing = await findJob(deps.sql, generationJobId)
    if (!existing) throw new Error(`generation job ${generationJobId} does not exist`)
    return { job: existing, asset: null }
  }
  const job = toJob(row)

  const kits = await deps.sql<{ name: string; accent: string }[]>`
    select name, accent from brand_kits where id = ${job.brandKitId}
  `
  const kit = kits[0]
  if (!kit) throw new Error(`brand kit ${job.brandKitId} does not exist`)

  const requested = requestSizeFor(job.spec)
  const request: ImageRequest = {
    // The stored prompt, not a recomputed one. Recomputing would mean an edit to prompt.ts
    // retroactively changed what a delivered asset claims to have been generated from.
    prompt: job.prompt,
    spec: job.spec,
    requestWidth: requested.width,
    requestHeight: requested.height,
    kitName: kit.name,
    accent: kit.accent,
  }

  // Read from the ROW, never from a parameter with a default. The request and this job are on
  // opposite sides of a lease, so a choice held anywhere but the row is a choice that is silently
  // lost — which is how a job requested as `placeholder`, and therefore reserving nothing, spent a
  // real FLUX call outside the cap.
  const chain = resolveChain(deps.backends, job.backendChoice)

  try {
    const result = await generateThrough(chain, request, signal)
    // The traffic is the probe: a real call has just told us whether the model works, so the
    // report reflects it without a second call and without a charge.
    deps.preflight.observe(result.attempts)

    const sizing = reportSizing(result.bytes, { width: job.spec.width, height: job.spec.height }, result.format)
    const stored = await deps.blobs.put(result.bytes, result.format)

    const finished = await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
      const updated = await tx<JobRow[]>`
        update generation_jobs
           set status = 'succeeded',
               backend = ${result.backend},
               model = ${result.model},
               requested_size = ${result.requestedSize},
               attempts = ${tx.json(result.attempts as unknown as Record<string, never>)},
               cost_actual_usd_micros = ${result.costUsdMicros.toString()}::bigint,
               provider_cost_units = ${result.providerMeta?.cost ?? null},
               credit_state = ${job.costEstimateUsdMicros > 0n ? 'settled' : 'released'},
               checksum = ${stored.checksum},
               finished_at = now()
         where id = ${job.id}
        returning ${tx.unsafe(COLUMNS)}
      `
      const done = updated[0]
      if (!done) throw new Error('the generation job vanished mid-run')

      const asset = await insertAsset(tx, {
        brandKitId: job.brandKitId,
        generationJobId: job.id,
        ownerSubject: job.ownerSubject,
        kind: job.spec.kind,
        format: result.format,
        declaredWidth: job.spec.width,
        declaredHeight: job.spec.height,
        actualWidth: sizing.actual?.width ?? null,
        actualHeight: sizing.actual?.height ?? null,
        sizing: sizing.sizing,
        storageUrl: stored.storageUrl,
        checksum: stored.checksum,
        byteSize: stored.byteSize,
        c2pa: result.c2pa,
      })

      if (job.costEstimateUsdMicros > 0n) {
        await settle(tx, job.ownerSubject, job.costEstimateUsdMicros, result.costUsdMicros)
        // In the SAME transaction as the settle. See credits.ts: a post-commit HTTP call to
        // billing is a charge that is lost when the process dies in the gap.
        emitUsage(emit, {
          jobId: job.id,
          ownerSubject: job.ownerSubject,
          costUsdMicros: result.costUsdMicros,
          backend: result.backend,
          deployment: result.model,
          actor: `service:studio`,
          correlationId: job.id,
        })
      }

      emitAssetCreated(emit, toJob(done), asset)
      return { job: toJob(done), asset }
    })

    deps.logger.info('asset generated', {
      generationJobId: job.id,
      backend: result.backend,
      model: result.model,
      sizing: sizing.sizing,
      note: sizing.note,
      bytes: stored.byteSize,
      c2pa: result.c2pa,
    })

    /**
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **A SILENT FALLBACK IS THE DEFECT THAT COST THIS ESTATE FORTY ASSETS.**
     *
     * Every one of the 40 assets studio had ever produced was made by the placeholder backend with
     * an EMPTY `model` column, on an estate that believed it was generating art. The information
     * was always there — `attempts` recorded the FLUX 404 on every job — but nothing ever compared
     * what was RECORDED against what was CONFIGURED, so a service degrading exactly as designed
     * looked identical to a service working.
     *
     * This is that comparison, and it fires on the success path rather than the failure path,
     * because the whole problem is that these jobs SUCCEEDED. `warn`, not `info`: a fallback is an
     * outcome somebody has to decide about, and burying it at `info` beside the ordinary
     * completion line is what made it invisible the first time.
     *
     * The counter matters more than the log. A log line is something a person has to be looking
     * for; a counter with a `from` label is something an alert can be built on, and this estate
     * runs beacon and lantern precisely so that it can be.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    if (job.backendChoice !== 'placeholder' && result.backend === 'placeholder') {
      const refused = result.attempts.filter((attempt) => attempt.backend !== 'placeholder')
      deps.metrics?.increment('studio_generations_fell_back_total', {
        requested: job.backendChoice,
        served: result.backend,
      })
      deps.logger.warn(
        'a generation the caller did not ask to be a placeholder WAS one — an image model is ' +
          'configured or was expected, and it did not serve. The asset is a labelled placeholder ' +
          'and its model column is empty.',
        {
          generationJobId: job.id,
          requestedBackend: job.backendChoice,
          servedBackend: result.backend,
          // The refusals, verbatim. This is the evidence that says WHY, and it is the thing
          // nobody read for forty assets.
          refusedAttempts: refused,
        },
      )
    }
    return finished
  } catch (err) {
    if (err instanceof ImageBackendError) deps.preflight.observe(err.attempts)
    const failed = await failJob(deps, job, err)
    return { job: failed, asset: null }
  }
}

/**
 * Record a failure and give the hold back.
 *
 * The release is the important half. A generation that produced nothing cost nothing, and leaving
 * the reservation in place would consume a customer's cap for an image that does not exist —
 * which, with a 404 from an undeployed model, would happen on every single request.
 */
async function failJob(deps: RunDeps, job: GenerationJob, err: unknown): Promise<GenerationJob> {
  const code = err instanceof ImageBackendError ? err.code : 'internal'
  const detail = err instanceof Error ? err.message : String(err)
  const attempts = err instanceof ImageBackendError ? err.attempts : []

  const updated = await deps.sql<JobRow[]>`
    update generation_jobs
       set status = 'failed',
           error_code = ${code},
           error_detail = ${detail.slice(0, 2_000)},
           attempts = ${deps.sql.json(attempts as unknown as Record<string, never>)},
           credit_state = 'released',
           finished_at = now()
     where id = ${job.id}
    returning ${deps.sql.unsafe(COLUMNS)}
  `
  if (job.costEstimateUsdMicros > 0n) {
    await release(deps.sql, job.ownerSubject, job.costEstimateUsdMicros)
  }
  deps.logger.warn('generation failed', { generationJobId: job.id, code, detail })
  const row = updated[0]
  return row ? toJob(row) : { ...job, status: 'failed', errorCode: code, errorDetail: detail }
}

function emitAssetCreated(emit: Emit, job: GenerationJob, asset: Asset): void {
  emit({
    topic: 'studio.asset.created',
    key: asset.id,
    payload: {
      id: asset.id,
      brandKitId: asset.brandKitId,
      generationJobId: asset.generationJobId,
      kind: asset.kind,
      storageUrl: asset.storageUrl,
      checksum: asset.checksum,
      sizing: asset.sizing,
      backend: job.backend,
      model: job.model,
      c2pa: asset.c2pa,
    },
    actor: 'service:studio',
    correlationId: job.id,
  })
}

/* ------------------------------------------------------------------------ reads */

export async function findJob(sql: Db | Tx, id: string): Promise<GenerationJob | null> {
  const rows = await sql<JobRow[]>`select ${sql.unsafe(COLUMNS)} from generation_jobs where id = ${id}`
  const row = rows[0]
  return row ? toJob(row) : null
}

export async function listJobsForKit(sql: Db, brandKitId: string, limit: number): Promise<GenerationJob[]> {
  const rows = await sql<JobRow[]>`
    select ${sql.unsafe(COLUMNS)}
      from generation_jobs
     where brand_kit_id = ${brandKitId}
     order by created_at desc
     limit ${limit}
  `
  return rows.map(toJob)
}

/**
 * Provenance, as one object, for `GET /v1/jobs/:id` and `GET /v1/assets/:id`.
 *
 * Assembled in one place so a route cannot ship a partial version of it. The completeness of this
 * shape is what the provenance test asserts.
 */
export function provenanceOf(job: GenerationJob): Record<string, unknown> {
  return {
    generationJobId: job.id,
    backend: job.backend,
    model: job.model,
    prompt: job.prompt,
    spec: {
      kind: job.spec.kind,
      width: job.spec.width,
      height: job.spec.height,
      format: job.spec.format,
    },
    requestedSize: job.requestedSize,
    attempts: job.attempts,
    costEstimateUsdMicros: job.costEstimateUsdMicros.toString(),
    costActualUsdMicros: job.costActualUsdMicros.toString(),
    providerCostUnits: job.providerCostUnits,
    creditState: job.creditState,
    checksum: job.checksum,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  }
}
