/**
 * A FIRING, AGAINST A RUNNING MICRO-STUDIO.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DELIBERATELY DOES NOT ASSERT, AND WHY THAT IS THE POINT.
 *
 * **It does not assert the 202.** The Kiln's defect was that this client posted
 * `POST /v1/generations`, which micro-studio has never served — and the reason a suite could stay
 * green over that for the whole life of the service is that every cheap thing you can check about
 * a firing is true of a firing that never happens. A 202 in particular is worthless here: studio
 * answers 202 the instant it has written a row, before any model is contacted
 * (`studio/src/server.ts`, "THE GENERATION LEAVES THE REQUEST HERE"), so **a 202 is
 * indistinguishable from a working Kiln.** So is an accepted `statusUrl`. So is a job that reaches
 * `running`.
 *
 * The only observation that separates them is a TERMINAL one, so that is the only thing graded:
 * the object row reaching `fired`, with a content address studio computed off bytes it actually
 * produced, and a prompt studio actually built. Everything before that is stepped through and
 * nothing before that is asserted on.
 *
 * **It does not assert against this repository's own client shape either.** The prompt clauses are
 * checked against `provenance.prompt` — the string studio stored on the job — and the kit's owner
 * is read back from studio's own `GET /v1/brand-kits/:id`, not from what `createKit` returned.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── HOW TO RUN IT ────────────────────────────────────────────────────────────────────────────
 *
 *   TESSERA_TEST_DATABASE_URL=postgres://…/tessera_test   (as every database test here)
 *   TESSERA_TEST_STUDIO_URL=http://127.0.0.1:4111         a running micro-studio
 *   TESSERA_TEST_STUDIO_TOKEN=<jwt>                       service:tessera, studio:read+studio:write
 *
 * The token is minted the way the estate mints it — `POST /service-tokens` on identity, as an
 * admin, exactly what `deploy/scripts/estate-bootstrap.sh` does — and it lasts ten minutes.
 *
 * `skip`, never `return`: an unconfigured upstream shows as SKIPPED in the runner's summary. Six
 * tests in this estate `return`ed when their preconditions were absent and therefore PASSED,
 * reporting green for work that never ran, and a live test is the single worst place to repeat it.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type postgres from 'postgres'
import {
  ALICE_SUBJECT,
  asDb,
  enabled,
  migrateTestDb,
  openDb,
  quietLogger,
  resetTessera,
  seedAccounts,
} from './testsupport.ts'
import { KILN_FIRE_KIND, registerHandlers } from './jobs.ts'
import { STUDIO_ASSET_KIND, findObject, firingLeaseKey, requestFiring } from './kiln.ts'
import { briefClausesMissingFrom, createStudioClient, kitNameFor } from './studioclient.ts'

const studioUrl = process.env['TESSERA_TEST_STUDIO_URL']
const studioToken = process.env['TESSERA_TEST_STUDIO_TOKEN']

const live = enabled && Boolean(studioUrl) && Boolean(studioToken)

/**
 * The skip names WHAT IS ACTUALLY MISSING, which is not the same list every time.
 *
 * This used to say `set TESSERA_TEST_DATABASE_URL, TESSERA_TEST_STUDIO_URL and
 * TESSERA_TEST_STUDIO_TOKEN` however it was run, and in CI the first of those three is SET — the
 * shared workflow provisions this service's Postgres and exports it, and the other 146 tests here
 * run against it. What is absent in a per-service job is a LIVE micro-studio on a port and a
 * service token for it, and no per-service job has either.
 *
 * Saying otherwise cost something concrete: `micro-org`'s test step fails a run whose output
 * contains `set <SERVICE>_TEST_DATABASE_URL`, because a database suite that skips silently is how
 * fifteen services once reported green without running a database assertion. That guard is correct
 * and it stays — this file simply must not claim a missing database it can see is present.
 *
 * The DSN clause is still emitted VERBATIM — the words `set TESSERA_TEST_DATABASE_URL`, which is
 * the string the guard matches — whenever the DSN really is the thing that is missing. Rewording
 * that case so the guard stopped matching would be turning the guard off, which is the defect this
 * estate keeps finding rather than a fix for it.
 */
const missing: readonly string[] = [
  ...(enabled ? [] : ['set TESSERA_TEST_DATABASE_URL (the name must contain "test")']),
  ...(studioUrl ? [] : ['set TESSERA_TEST_STUDIO_URL — a running micro-studio']),
  ...(studioToken ? [] : ['set TESSERA_TEST_STUDIO_TOKEN — service:tessera, studio:read+studio:write']),
]
const skip = live ? false : `this live test cannot run: ${missing.join('; ')}`

let sql: postgres.Sql

before(async () => {
  if (!live) return
  sql = openDb()
  await migrateTestDb(sql)
})
after(async () => {
  if (!live) return
  await sql.end({ timeout: 5 })
})
beforeEach(async () => {
  if (!live) return
  await resetTessera(sql)
})

async function studioGet(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${studioUrl}${path}`, {
    headers: { authorization: `Bearer ${studioToken}` },
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/**
 * Run the REAL `kiln.fire` handler, under a REAL lease, until the object leaves `firing`.
 *
 * Not a direct call to the client: `registerHandlers` is what production wires, the runner is what
 * claims `for update skip locked`, and the resume logic added with migration 13 lives in the
 * handler rather than in the client. Calling the client directly would grade the half of this that
 * was never in doubt.
 */
async function fireAndWait(objectId: string, subject: string, ms = 90_000): Promise<void> {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'kiln-live-test' })
  const runner = new JobRunner({ queue, concurrency: 1, pollMs: 200 })
  registerHandlers(runner, {
    sql: asDb(sql),
    logger: quietLogger(),
    signingSecret: 'kiln-live-test-signing-secret-000000',
    studio: createStudioClient({
      baseUrl: studioUrl!,
      token: async () => studioToken!,
      // Short, because the placeholder backend finishes in milliseconds and a real FLUX call is
      // still bounded by `ms` below. The interval is what this polls at, not what studio takes.
      pollIntervalMs: 250,
      maxWaitMs: ms,
    }),
  })
  await queue.enqueue({ kind: KILN_FIRE_KIND, key: firingLeaseKey(subject), payload: { objectId, subject } })
  runner.start()
  try {
    const deadline = Date.now() + ms
    for (;;) {
      const object = await findObject(asDb(sql), objectId)
      if (object && object.status !== 'firing') return
      if (Date.now() > deadline) throw new Error(`the firing never left 'firing' within ${ms}ms`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  } finally {
    await runner.stop(10_000)
  }
}

/* ══════════════════════════════════════════════════ the route that was never there ══ */

/**
 * The defect, pinned. This is an assertion about somebody else's service and it is deliberate:
 * `POST /v1/generations` is what this client used to send, and if micro-studio ever grows that
 * route the right response is to reconsider this whole client, not to quietly keep two paths.
 */
test('POST /v1/generations — the route this client used to call — does not exist', { skip }, async () => {
  const response = await fetch(`${studioUrl}/v1/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${studioToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: STUDIO_ASSET_KIND, prompt: 'a stool', width: 512, height: 512 }),
  })
  assert.equal(
    response.status,
    404,
    'micro-studio now serves POST /v1/generations — this client generates through brand kits and should be reconsidered',
  )
})

/* ═══════════════════════════════════════════════════════ a firing, end to end ══ */

test('a firing reaches fired, with studios own checksum and studios own brief', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  const description = 'a three-legged stool of scorched oak'
  const object = await requestFiring(asDb(sql), {
    authorSubject: ALICE_SUBJECT,
    prompt: description,
    category: 'seating',
    footprint: '1x1',
    correlationId: 'live-firing',
  })

  await fireAndWait(object.id, ALICE_SUBJECT)

  const fired = await findObject(asDb(sql), object.id)
  // The one terminal fact. Everything above this line is true of a firing that never happened.
  assert.equal(fired?.status, 'fired', await failureReason(object.id))
  assert.match(String(fired?.checksum), /^sha256:[0-9a-f]{64}$/)

  const row = await sql<
    { studio_brand_kit_id: string | null; studio_generation_job_id: string | null; studio_status_url: string | null; studio_asset_id: string | null; c2pa: boolean | null }[]
  >`
    select studio_brand_kit_id, studio_generation_job_id, studio_status_url, studio_asset_id, c2pa
      from objects where id = ${object.id}
  `
  const kept = row[0]
  assert.ok(kept?.studio_brand_kit_id, 'the brand kit id was not kept — a retry would 409 for ever')
  assert.ok(kept?.studio_generation_job_id, 'the generation id was not kept — a retry would pay twice')
  assert.equal(kept?.studio_status_url, `/v1/jobs/${kept?.studio_generation_job_id}`)

  // ── THE OWNER, READ BACK FROM STUDIO ─────────────────────────────────────────────────────
  // Not from what `createKit` returned. A kit owned by `service:tessera` would generate, deliver
  // and look perfect while every asset a creator ever fired belonged to the platform — the exact
  // shape migration 11 records market shipping with its seller.
  const kit = await studioGet(`/v1/brand-kits/${kept!.studio_brand_kit_id!}`)
  assert.equal(kit.status, 200)
  const brandKit = kit.body['brandKit'] as Record<string, unknown>
  assert.equal(brandKit['ownerSubject'], ALICE_SUBJECT, 'the creator does not own the asset they fired')
  assert.equal(brandKit['name'], kitNameFor(object.id))
  assert.equal(brandKit['stylePrompt'], description, 'the players words did not reach studio')

  // ── THE BRIEF, READ OFF WHAT STUDIO SAYS IT GENERATED FROM ───────────────────────────────
  // This is the assertion `kiln.test.ts` could not make: it used to check this repository's own
  // copy of the paragraph, which was never sent anywhere.
  const status = await studioGet(kept!.studio_status_url!)
  assert.equal(status.status, 200)
  const job = status.body['job'] as Record<string, unknown>
  const provenance = status.body['provenance'] as Record<string, unknown>
  assert.equal(job['status'], 'succeeded')
  assert.equal(job['kind'], STUDIO_ASSET_KIND, 'studio generated something other than a world object')
  assert.equal(job['size'], '512x512')
  assert.equal(provenance['checksum'], fired?.checksum, 'the recorded address is not the one studio computed')

  const prompt = String(provenance['prompt'])
  assert.deepEqual(
    [...briefClausesMissingFrom(prompt)],
    [],
    "studio's world-object brief no longer carries every clause this title depends on",
  )
  // And the player's own words survived into it, which is the half a fixed brief cannot give.
  assert.ok(prompt.includes(description), 'the players description is not in the prompt studio used')
  // The brand brief is NOT what a world object is generated to. `brandStyle()`'s opening clause,
  // asserted absent: run a stool through it and a logo of a stool comes back, deliberately-looking
  // and undetectable downstream (`studio/src/specs.ts`).
  assert.equal(
    prompt.includes('Brand mark for a software company'),
    false,
    'the world object was generated to the BRAND brief',
  )

  // ── C2PA IS NULL, AND null IS NOT false ──────────────────────────────────────────────────
  // Studio measures it off the bytes and does not publish it on the job: neither `wireJob`
  // (`studio/src/server.ts`) nor `provenanceOf` (`generation.ts`) carries it. So
  // "nobody measured this" is the truth and `false` would be an assertion — one that would have
  // been wrong in the invisible direction on every firing this service ever does.
  assert.equal(kept?.c2pa, null, 'c2pa was asserted rather than measured')
  assert.equal(provenance['c2pa'], undefined, 'studio now publishes c2pa on the job — read it')

  // ── THE ASSET ID IS ABSENT, AND THAT IS A FACT ABOUT STUDIO ──────────────────────────────
  // Recording the generation job id here would be a lie `GET /v1/assets/:id` 404s on.
  assert.equal(kept?.studio_asset_id, null)
  assert.equal(
    (status.body['job'] as Record<string, unknown>)['assetId'] ?? provenance['assetId'],
    undefined,
    'studio now returns an asset id on the job status — record it, and the sprite path opens',
  )

  // The event the rest of the estate reads.
  const events = await sql<{ key: string; payload: Record<string, unknown> }[]>`
    select key, payload from outbox where topic = 'tessera.object.fired'
  `
  assert.equal(events.length, 1)
  assert.equal(events[0]?.key, object.id)
  assert.equal(events[0]?.payload['checksum'], fired?.checksum)
  assert.equal(events[0]?.payload['authorSubject'], ALICE_SUBJECT)
})

/* ═════════════════════════════════════════════════ a retry does not buy a second one ══ */

/**
 * Migration 13's whole argument, driven: an attempt that already got a generation out of studio
 * must RESUME it, not start a second one. Studio reads no idempotency key on either call, so
 * nothing upstream would stop it — a second FLUX call, reserved and settled against the player's
 * cap in real USD, for an object that already has its bytes.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE OBVIOUS VERSION OF THIS TEST STAYED GREEN WHEN THE GUARD WAS REMOVED, AND HERE IS WHY.
 *
 * The first version fired once, waited for `fired`, then enqueued the job again — the shape a
 * redelivery actually has. Deleting the `recordGeneration` write and re-running left it PASSING.
 *
 * Because that scenario never reaches the resume at all. The handler's first check is
 * `progress.status !== 'firing'`, and after a successful firing the row is `fired`, so it returns
 * before it would have looked at anything. The test was grading the terminal-status early return
 * and reporting it as evidence about the resume — the estate's "a branch graded only by the CHECK
 * behind it", exactly.
 *
 * The state that actually needs the resume is a firing INTERRUPTED: studio has accepted the
 * generation, the row is still `firing`, and the lease comes back. That is what is set up below,
 * by putting the row back to `firing` with the recorded ids intact, and it is the version that
 * goes red — `the redelivery started a second generation` — when the write is removed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('an INTERRUPTED firing resumes its generation; it does not buy a second', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await requestFiring(asDb(sql), {
    authorSubject: ALICE_SUBJECT,
    prompt: 'a brass lantern on a hook',
    category: 'lighting',
    footprint: '1x1',
    correlationId: 'live-retry',
  })
  await fireAndWait(object.id, ALICE_SUBJECT)
  const first = await sql<{ studio_generation_job_id: string | null; studio_brand_kit_id: string | null; checksum: string | null }[]>`
    select studio_generation_job_id, studio_brand_kit_id, checksum from objects where id = ${object.id}
  `
  assert.equal((await findObject(asDb(sql), object.id))?.status, 'fired')
  assert.ok(first[0]?.studio_generation_job_id)

  // The interruption: the lease was lost after studio accepted the generation and before the
  // outcome was recorded. The upstream ids stay, because studio really did accept it — that is
  // the whole state migration 13 exists to hold.
  await sql`update objects set status = 'firing' where id = ${object.id}`

  await fireAndWait(object.id, ALICE_SUBJECT, 30_000)

  const second = await sql<{ studio_generation_job_id: string | null; studio_brand_kit_id: string | null; checksum: string | null }[]>`
    select studio_generation_job_id, studio_brand_kit_id, checksum from objects where id = ${object.id}
  `
  assert.equal((await findObject(asDb(sql), object.id))?.status, 'fired', await failureReason(object.id))
  assert.equal(
    second[0]?.studio_generation_job_id,
    first[0]?.studio_generation_job_id,
    'the resumed firing started a SECOND generation — that is a second charge for one object',
  )
  assert.equal(second[0]?.studio_brand_kit_id, first[0]?.studio_brand_kit_id)
  assert.equal(second[0]?.checksum, first[0]?.checksum)

  // Studio's own count, which is the claim about the OTHER service that a count of this
  // service's rows cannot make: one job on that kit, not two.
  const status = await studioGet(`/v1/jobs/${first[0]!.studio_generation_job_id!}`)
  assert.equal(status.status, 200)
  assert.equal((status.body['job'] as Record<string, unknown>)['status'], 'succeeded')
})

/* ══════════════════════════════════════════════════════════ studio's own refusals ══ */

test('studio refuses to mint a kit for nobody — a service token must name the user', { skip }, async () => {
  // `subjectUserId` (runtime/packages/auth/src/index.ts) throws `no_subject_user` for a
  // service principal with no `userId`. This is what stops a firing being owned by the platform,
  // and it is studio's guard rather than this client's — checked so the client's reliance on it
  // is a measured fact and not an assumption.
  const response = await fetch(`${studioUrl}/v1/brand-kits`, {
    method: 'POST',
    headers: { authorization: `Bearer ${studioToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `unowned-${Date.now()}`, accent: '#12100f', stylePrompt: 'a stool' }),
  })
  assert.equal(response.status, 401, 'studio minted a brand kit with no owner named')
})

async function failureReason(objectId: string): Promise<string> {
  const rows = await sql<{ failure_reason: string | null }[]>`
    select failure_reason from objects where id = ${objectId}
  `
  return `the firing did not reach 'fired': ${rows[0]?.failure_reason ?? 'no reason recorded'}`
}
