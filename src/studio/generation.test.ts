/**
 * The pipeline, against a real database and a real (fake) HTTP endpoint.
 *
 * Two things are proved here that cannot be proved anywhere else:
 *
 *   1. **The credit cap refuses before any HTTP request is made.** Asserted by the fake server's
 *      `requests` array still being empty, not by inspecting a call order.
 *   2. **Provenance is complete on every asset.** Asserted field by field, because "we record
 *      provenance" is exactly the kind of claim that decays into recording four of nine columns.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { Logger } from '@cloudsforge/telemetry'
import { enabled, fluxConfigFor, migrateTestDb, openDb, resetStudio, skip } from './testsupport.ts'
import { startFakeFlux, type FakeFlux } from './fakeflux.ts'
import { fluxBackend, placeholderBackend, type BackendSet, type ImageBackend } from './backend.ts'
import { Preflight } from './preflight.ts'
import { postgresBrandKitStore, type BrandKit } from './brandkits.ts'
import { findAsset, type AssetBlobStore } from './assets.ts'
import { account, setCap, usd } from './credits.ts'
import { specFor } from './specs.ts'
import {
  findJob,
  provenanceOf,
  requestGeneration,
  runGeneration,
  type RequestDeps,
  type RunDeps,
} from './generation.ts'

const PRICE = 60_000n // $0.06
const CAP = 1_000_000n // $1.00

const logger = new Logger({ service: 'test', sink: () => {} })
const never = AbortSignal.timeout(30_000)

/** An in-memory blob store, so a test does not scatter files across the working tree. */
function memoryBlobs(): AssetBlobStore & { written: Buffer[] } {
  const written: Buffer[] = []
  const byPath = new Map<string, Buffer>()
  return {
    written,
    async put(bytes, format) {
      written.push(bytes)
      const { createHash } = await import('node:crypto')
      const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      byPath.set(`${checksum}.${format}`, bytes)
      return { storageUrl: `memory://${checksum}.${format}`, checksum, byteSize: bytes.length }
    },
    async get(checksum, format) {
      return byPath.get(`${checksum}.${format}`) ?? null
    },
  }
}

interface Harness {
  readonly sql: postgres.Sql
  readonly kit: BrandKit
  readonly fake: FakeFlux
  readonly blobs: AssetBlobStore & { written: Buffer[] }
  readonly enqueued: Array<{ kind: string; key: string; payload: Record<string, unknown> }>
  readonly requestDeps: RequestDeps
  readonly runDeps: RunDeps
  readonly backends: BackendSet
}

let pool: postgres.Sql | null = null

async function withHarness(
  fn: (h: Harness) => Promise<void>,
  options: { flux?: ImageBackend | null } = {},
): Promise<void> {
  const sql = (pool ??= openDb())
  await migrateTestDb(sql)
  await resetStudio(sql)

  const fake = await startFakeFlux()
  try {
    const kits = postgresBrandKitStore(sql, 'studio')
    const kit = await kits.create({
      ownerSubject: 'user:11111111-1111-4111-8111-111111111111',
      name: 'CloudsForge',
      accent: '#ff4d00',
      palette: ['#12100f'],
      typography: { display: 'Geometric Sans' },
      stylePrompt: 'an anvil whose top face becomes the underside of a cloud arc',
      actor: 'user:test',
      correlationId: 'req-1',
    })
    await setCap(sql, kit.ownerSubject, CAP)

    const blobs = memoryBlobs()
    const backends: BackendSet = {
      flux: options.flux === undefined ? fluxBackend(fluxConfigFor(fake.url)) : options.flux,
      placeholder: placeholderBackend(),
    }
    const enqueued: Harness['enqueued'] = []

    await fn({
      sql,
      kit,
      fake,
      blobs,
      enqueued,
      backends,
      requestDeps: {
        sql,
        producer: 'studio',
        defaultCreditCapUsdMicros: CAP,
        priceUsdMicros: PRICE,
        enqueue: async (job) => {
          enqueued.push(job)
        },
      },
      runDeps: {
        sql,
        producer: 'studio',
        backends,
        blobs,
        preflight: new Preflight(fluxConfigFor(fake.url)),
        logger,
      },
    })
  } finally {
    await fake.close()
  }
}

test.after(async () => {
  await pool?.end({ timeout: 5 })
})

/* --------------------------------------------------------------- the credit cap */

test(
  'THE CAP REFUSES BEFORE ANY HTTP REQUEST IS MADE',
  { skip },
  async () => {
    if (!enabled) return
    await withHarness(async (h) => {
      // Spend the account down to less than one image.
      await setCap(h.sql, h.kit.ownerSubject, PRICE / 2n)

      const err = await requestGeneration(h.requestDeps, {
        kit: h.kit,
        spec: specFor('mark'),
        choice: 'auto',
        actor: 'user:test',
        correlationId: 'req-2',
      }).then(
        () => null,
        (e: unknown) => e,
      )

      assert.ok(err instanceof Error)
      assert.equal(err.name, 'CreditCapError')

      // THE ASSERTION. Not "the backend was called last" — the backend was never called at all.
      assert.equal(h.fake.requests.length, 0, 'no image call may be made when the cap refuses')
      assert.equal(h.blobs.written.length, 0)
      assert.equal(h.enqueued.length, 0, 'nothing may be enqueued either')

      // And the transaction rolled back: no job row, and no reservation left behind.
      const jobs = await h.sql`select count(*)::int as n from generation_jobs`
      assert.equal(jobs[0]?.['n'], 0)
      const acct = await account(h.sql, h.kit.ownerSubject)
      assert.equal(acct?.reservedUsdMicros, 0n, 'a refused reservation must not linger')
    })
  },
)

/**
 * The 500 the route now refuses, observed at the layer that produced it.
 *
 * `server.test.ts` proves the route answers 400 and that the pipeline is never entered. This is the
 * other half: what happens when it IS entered with an undescribed `world_object`, against a real
 * database. It matters because `prompt.ts`'s throw is the second, structural refusal — the one
 * standing in front of every future caller of `requestGeneration` that is not this route — and a
 * structural refusal that left a reserved credit or a half-written job behind would be worse than
 * the 500 it produces.
 */
test('an undescribed world_object is refused by the pipeline and leaves no trace', { skip }, async () => {
  if (!enabled) return
  await withHarness(async (h) => {
    // The harness kit HAS a description, so the empty one is made here rather than assumed.
    const undescribed = await postgresBrandKitStore(h.sql, 'studio').create({
      ownerSubject: h.kit.ownerSubject,
      name: 'Undescribed',
      accent: '#ff4d00',
      palette: [],
      typography: {},
      stylePrompt: '',
      actor: 'user:test',
      correlationId: 'req-world-object',
    })

    await assert.rejects(
      () =>
        requestGeneration(h.requestDeps, {
          kit: undescribed,
          spec: specFor('world_object'),
          choice: 'auto',
          actor: 'user:test',
          correlationId: 'req-world-object',
        }),
      /no description to build a prompt from/,
    )

    // `buildPrompt` runs BEFORE the transaction opens, which is why there is nothing to roll back:
    // no job row, no reservation, nothing enqueued, and no image call.
    const jobs = await h.sql`select count(*)::int as n from generation_jobs`
    assert.equal(jobs[0]?.['n'], 0)
    assert.equal((await account(h.sql, h.kit.ownerSubject))?.reservedUsdMicros, 0n)
    assert.deepEqual(h.enqueued, [])
    assert.equal(h.fake.requests.length, 0)
  })
})

test('a described world_object generates, and its prompt is NOT the brand brief', { skip }, async () => {
  if (!enabled) return
  // The kind that exists because running a stool through `brandStyle()` returns a logo of a stool.
  // Nothing in this service reads a prompt for meaning, so the paragraph it was built from is the
  // only thing that can be asserted — and it is stored on the row, so it can be.
  await withHarness(async (h) => {
    const kits = postgresBrandKitStore(h.sql, 'studio')
    const kiln = await kits.create({
      ownerSubject: h.kit.ownerSubject,
      name: 'Kiln',
      accent: '#ff4d00',
      palette: [],
      typography: {},
      stylePrompt: 'a three-legged oak stool with a worn seat',
      actor: 'user:test',
      correlationId: 'req-stool',
    })

    const job = await requestGeneration(h.requestDeps, {
      kit: kiln,
      spec: specFor('world_object'),
      choice: 'placeholder',
      actor: 'user:test',
      correlationId: 'req-stool',
    })
    assert.match(job.prompt, /painterly gouache/i)
    assert.match(job.prompt, /The object is: a three-legged oak stool with a worn seat/)
    assert.equal(/Brand mark for a software company/.test(job.prompt), false, 'not the brand brief')
    // The accent is deliberately absent: a world object wears no product colour.
    assert.equal(job.prompt.includes('#ff4d00'), false)
  })
})

test('a reservation is held at request time and settled when the job succeeds', { skip }, async () => {
  if (!enabled) return
  await withHarness(async (h) => {
    h.fake.script('FLUX.2-pro', { status: 200 })

    const job = await requestGeneration(h.requestDeps, {
      kit: h.kit,
      spec: specFor('mark'),
      choice: 'auto',
      actor: 'user:test',
      correlationId: 'req-3',
    })
    assert.equal(job.status, 'queued')
    assert.equal(job.creditState, 'reserved')
    assert.equal(job.costEstimateUsdMicros, PRICE)

    // Held, not spent, and no call yet.
    const held = await account(h.sql, h.kit.ownerSubject)
    assert.equal(held?.reservedUsdMicros, PRICE)
    assert.equal(held?.spentUsdMicros, 0n)
    assert.equal(h.fake.requests.length, 0, 'the request path reaches no model')

    await runGeneration(h.runDeps, job.id, never)

    const settled = await account(h.sql, h.kit.ownerSubject)
    assert.equal(settled?.reservedUsdMicros, 0n)
    assert.equal(settled?.spentUsdMicros, PRICE)
  })
})

test('a failed generation gives the hold back, because nothing was produced', { skip }, async () => {
  if (!enabled) return
  // With an undeployed model this would otherwise consume a customer's whole cap on 404s.
  await withHarness(async (h) => {
    const job = await requestGeneration(h.requestDeps, {
      kit: h.kit,
      spec: specFor('mark'),
      // `flux` by name, so the placeholder cannot rescue it and the failure is real.
      choice: 'flux',
      actor: 'user:test',
      correlationId: 'req-4',
    })

    const outcome = await runGeneration(h.runDeps, job.id, never)
    assert.equal(outcome.job.status, 'failed')
    assert.equal(outcome.job.errorCode, 'no_backend_available')
    assert.equal(outcome.job.creditState, 'released')

    const acct = await account(h.sql, h.kit.ownerSubject)
    assert.equal(acct?.reservedUsdMicros, 0n)
    assert.equal(acct?.spentUsdMicros, 0n, 'a 404 costs nothing and must charge nothing')
  })
})

test('REGRESSION: the caller\'s backend choice survives the lease boundary', { skip }, async () => {
  if (!enabled) return
  // Found by running the real service: the choice was passed as a parameter with an `auto`
  // default, and the leased job is on the far side of a lease from the request that made it. A
  // job requested as `placeholder` — reserving nothing, because a placeholder costs nothing —
  // therefore ran on FLUX and spent real money OUTSIDE the cap. The choice is now a column.
  await withHarness(async (h) => {
    // Scripted so that, if the choice were lost, FLUX would happily succeed and the bug would be
    // invisible again.
    h.fake.script('FLUX.2-pro', { status: 200 })

    const requested = await requestGeneration(h.requestDeps, {
      kit: h.kit,
      spec: specFor('og'),
      choice: 'placeholder',
      actor: 'user:test',
      correlationId: 'req-14',
    })
    assert.equal(requested.backendChoice, 'placeholder')

    const { job, asset } = await runGeneration(h.runDeps, requested.id, never)

    assert.equal(job.backend, 'placeholder', 'the leased job must honour what the caller asked for')
    assert.equal(asset?.format, 'svg')
    assert.equal(h.fake.requests.length, 0, 'no paid call may be made for a free choice')

    const acct = await account(h.sql, h.kit.ownerSubject)
    assert.equal(acct?.spentUsdMicros, 0n)
  })
})

test('a placeholder generation reserves nothing', { skip }, async () => {
  if (!enabled) return
  // Charging a cap for a deterministic SVG would make the cap the reason an offline preview
  // could not be produced.
  await withHarness(async (h) => {
    const job = await requestGeneration(h.requestDeps, {
      kit: h.kit,
      spec: specFor('mark'),
      choice: 'placeholder',
      actor: 'user:test',
      correlationId: 'req-5',
    })
    assert.equal(job.costEstimateUsdMicros, 0n)
    const acct = await account(h.sql, h.kit.ownerSubject)
    assert.equal(acct?.reservedUsdMicros, 0n)
  })
})

test('two concurrent requests cannot both fit in room for one', { skip }, async () => {
  if (!enabled) return
  // The conditional UPDATE is the guard. A select-then-update would let both see room and both
  // proceed, which is how a cap becomes a suggestion.
  await withHarness(async (h) => {
    await setCap(h.sql, h.kit.ownerSubject, PRICE)

    const attempt = () =>
      requestGeneration(h.requestDeps, {
        kit: h.kit,
        spec: specFor('mark'),
        choice: 'auto',
        actor: 'user:test',
        correlationId: 'req-6',
      }).then(
        () => 'accepted' as const,
        () => 'refused' as const,
      )

    const results = await Promise.all([attempt(), attempt()])
    assert.deepEqual(results.slice().sort(), ['accepted', 'refused'])

    const acct = await account(h.sql, h.kit.ownerSubject)
    assert.equal(acct?.reservedUsdMicros, PRICE)
    assert.equal(h.fake.requests.length, 0)
  })
})

/* --------------------------------------------------------------- provenance */

test('PROVENANCE IS COMPLETE on every asset', { skip }, async () => {
  if (!enabled) return
  await withHarness(async (h) => {
    h.fake.script('FLUX.2-pro', { status: 200 })

    const requested = await requestGeneration(h.requestDeps, {
      kit: h.kit,
      spec: specFor('mark'),
      choice: 'auto',
      actor: 'user:test',
      correlationId: 'req-7',
    })
    const { job, asset } = await runGeneration(h.runDeps, requested.id, never)

    assert.equal(job.status, 'succeeded')
    assert.ok(asset)

    // Field by field. 04-domain-model §5.1: model, prompt, spec and cost, per asset.
    const p = provenanceOf(job)
    assert.equal(p['backend'], 'flux')
    assert.equal(p['model'], 'FLUX.2-pro')
    assert.equal(p['requestedSize'], '1024x1024')
    assert.equal(p['costEstimateUsdMicros'], PRICE.toString())
    assert.equal(p['costActualUsdMicros'], PRICE.toString())
    assert.equal(p['providerCostUnits'], 3, "the provider's own accounting, recorded verbatim")
    assert.equal(p['creditState'], 'settled')
    assert.equal(p['checksum'], asset.checksum)
    assert.deepEqual(p['spec'], { kind: 'mark', width: 1024, height: 1024, format: 'png' })
    assert.ok(typeof p['finishedAt'] === 'string')

    // The prompt is the one that was SENT, not one recomputed at read time.
    const prompt = p['prompt']
    assert.ok(typeof prompt === 'string' && prompt.length > 0)
    assert.equal(h.fake.requests[0]?.body['prompt'], prompt)
    // And it was derived from the kit: the accent, and the kit's own idea.
    assert.match(prompt, /#ff4d00/)
    assert.match(prompt, /anvil/)

    const attempts = p['attempts']
    assert.ok(Array.isArray(attempts) && attempts.length === 1)

    // The asset points back at the job that made it, and carries the licence and the checksum.
    assert.equal(asset.generationJobId, job.id)
    assert.equal(asset.brandKitId, h.kit.id)
    assert.match(asset.checksum, /^sha256:[0-9a-f]{64}$/)
    assert.match(asset.licence, /AI-generated/)
    assert.ok(asset.byteSize > 0)

    // Readable back out of the database, not just from the return value.
    const reread = await findAsset(h.sql, asset.id)
    assert.deepEqual(reread, asset)
  })
})

test('a fallback is visible on the finished job months later', { skip }, async () => {
  if (!enabled) return
  // The harness default has no fallback model — as the live resource does not — so this one is
  // wired explicitly.
  await withHarness(async (h) => {
    const backend = fluxBackend(fluxConfigFor(h.fake.url, { fallbackModel: 'FLUX.1-pro' }))
    const runDeps: RunDeps = { ...h.runDeps, backends: { ...h.backends, flux: backend } }
    h.fake.script('FLUX.2-pro', { status: 404 })
    h.fake.script('FLUX.1-pro', { status: 200 })

    const requested = await requestGeneration(h.requestDeps, {
      kit: h.kit,
      spec: specFor('mark'),
      choice: 'auto',
      actor: 'user:test',
      correlationId: 'req-9',
    })
    const { job } = await runGeneration(runDeps, requested.id, never)

    assert.equal(job.model, 'FLUX.1-pro')
    assert.equal(job.attempts.length, 2)
    assert.equal(job.attempts[0]?.outcome, 'not_found')

    const reread = await findJob(h.sql, job.id)
    assert.equal(reread?.attempts[0]?.model, 'FLUX.2-pro')
  })
})

/* --------------------------------------------------------------- sizing */

test('an OG card is delivered off-spec and the asset says `unsized`', { skip }, async () => {
  if (!enabled) return
  // The real FLUX behaviour: 630 is not a multiple of 16, so 1200x640 is asked for and delivered.
  await withHarness(async (h) => {
    const { pngOfSize } = await import('./fakeflux.ts')
    h.fake.script('FLUX.2-pro', {
      status: 200,
      body: { data: [{ b64_json: pngOfSize(1200, 640).toString('base64') }], request_meta: { cost: 3 } },
    })

    const requested = await requestGeneration(h.requestDeps, {
      kit: h.kit,
      spec: specFor('og'),
      choice: 'auto',
      actor: 'user:test',
      correlationId: 'req-10',
    })
    const { asset } = await runGeneration(h.runDeps, requested.id, never)

    assert.ok(asset)
    assert.equal(asset.declaredWidth, 1200)
    assert.equal(asset.declaredHeight, 630)
    assert.equal(asset.actualWidth, 1200)
    assert.equal(asset.actualHeight, 640)
    assert.equal(asset.sizing, 'unsized', 'never relabelled to match the number somebody wanted')
    // What was asked for is recorded too, or the delivered size explains nothing.
    assert.equal(h.fake.requests[0]?.body['height'], 640)
  })
})

test('a placeholder is always exact, because it is authored at the spec', { skip }, async () => {
  if (!enabled) return
  await withHarness(async (h) => {
    const requested = await requestGeneration(h.requestDeps, {
      kit: h.kit,
      spec: specFor('og'),
      choice: 'placeholder',
      actor: 'user:test',
      correlationId: 'req-11',
    })
    const { job, asset } = await runGeneration(h.runDeps, requested.id, never)

    assert.equal(job.backend, 'placeholder')
    assert.ok(asset)
    assert.equal(asset.sizing, 'exact')
    assert.equal(asset.actualWidth, 1200)
    assert.equal(asset.actualHeight, 630)
    assert.equal(asset.format, 'svg')
    assert.equal(asset.c2pa, false)
  })
})

/* --------------------------------------------------------------- redelivery */

test('a redelivered job does not generate a second image', { skip }, async () => {
  if (!enabled) return
  // At-least-once delivery guarantees this happens. A second generation would spend against a
  // reservation that has already been settled.
  await withHarness(async (h) => {
    h.fake.script('FLUX.2-pro', { status: 200 })

    const requested = await requestGeneration(h.requestDeps, {
      kit: h.kit,
      spec: specFor('mark'),
      choice: 'auto',
      actor: 'user:test',
      correlationId: 'req-12',
    })
    await runGeneration(h.runDeps, requested.id, never)
    const again = await runGeneration(h.runDeps, requested.id, never)

    assert.equal(again.asset, null)
    assert.equal(again.job.status, 'succeeded')
    assert.equal(h.fake.requests.length, 1, 'exactly one image call for one job')

    const acct = await account(h.sql, h.kit.ownerSubject)
    assert.equal(acct?.spentUsdMicros, PRICE, `charged once: ${usd(acct?.spentUsdMicros ?? 0n)}`)
  })
})

/* --------------------------------------------------------------- events */

test('usage and asset events are written in the same transaction as the settle', { skip }, async () => {
  if (!enabled) return
  await withHarness(async (h) => {
    h.fake.script('FLUX.2-pro', { status: 200 })
    const requested = await requestGeneration(h.requestDeps, {
      kit: h.kit,
      spec: specFor('mark'),
      choice: 'auto',
      actor: 'user:test',
      correlationId: 'req-13',
    })
    await runGeneration(h.runDeps, requested.id, never)

    const events = await h.sql<{ topic: string; payload: Record<string, unknown> }[]>`
      select topic, payload from outbox order by occurred_at
    `
    const topics = events.map((e) => e.topic)
    assert.deepEqual(topics, [
      'studio.brand_kit.created',
      'studio.generation.requested',
      'studio.usage.recorded',
      'studio.asset.created',
    ])

    const usage = events.find((e) => e.topic === 'studio.usage.recorded')
    assert.equal(usage?.payload['meter'], 'studio.image.generation')
    assert.equal(usage?.payload['costUsdMicros'], PRICE.toString())
    // The idempotency key billing dedupes on, so a redelivery is a no-op and not a second charge.
    assert.equal(usage?.payload['idempotencyKey'], `studio:generation:${requested.id}`)
  })
})
