/**
 * The Kiln: content addressing, the two facings, and the object cap at commit.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type postgres from 'postgres'
import {
  ALICE_SUBJECT,
  BOB_SUBJECT,
  asDb,
  enabled,
  migrateTestDb,
  openDb,
  resetTessera,
  seedAccounts,
  seedObject,
  seedWard,
  skip,
  stripComments,
} from './testsupport.ts'
import {
  CATEGORIES,
  FACINGS,
  FOOTPRINTS,
  OBJECT_CANVAS,
  completeFiring,
  findObject,
  firingLeaseKey,
  listPlacements,
  placeObjects,
  recordAnchor,
  removePlacement,
  requestFiring,
} from './kiln.ts'
import { WorldError } from './world.ts'
import { REQUIRED_PROMPT_CLAUSES, briefClausesMissingFrom, kitNameFor } from './studioclient.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})
after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})
beforeEach(async () => {
  if (!enabled) return
  await resetTessera(sql)
})

/* ---------------------------------------------------------------------------- pure */

test('twelve categories, two footprints, two facings — §6.3, as the closed sets they are', () => {
  assert.equal(CATEGORIES.length, 12)
  assert.deepEqual([...FOOTPRINTS], ['1x1', '2x2'])
  // TWO facings, because micro-studio has no seed column and a pipeline that cannot fix a seed
  // cannot render the same chair four times. §2.1. The day studio stores a seed this becomes
  // four, and this assertion is where the change is noticed.
  assert.deepEqual([...FACINGS], ['canonical', 'mirrored'])
  // §6.3's combinatorics, checkable: 4 builds x 8^5 overlays = 131,072 avatars from 48 assets.
  assert.equal(4 * 8 ** 5, 131_072)
})

test('the canvas is 512 and is a multiple of 16, which is what FLUX floors to', () => {
  assert.equal(OBJECT_CANVAS, 512)
  assert.equal(OBJECT_CANVAS % 16, 0)
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS TEST USED TO CHECK THIS REPOSITORY'S OWN COPY OF THE BRIEF, AND THAT IS WHY IT WAS GREEN
 * WHILE THE KILN COULD NOT FIRE AT ALL.
 *
 * `promptFor()` built the projection, the light and the ground here, and this test read them back
 * — a function agreeing with itself. Studio takes NO prompt on its generate route
 * (`studio/src/server.ts`): it builds one from the kind's own paragraph and the brand
 * kit's `stylePrompt` (`studio/src/prompt.ts`). So the string this test was grading was
 * never sent anywhere, and could not have been.
 *
 * What is left here is the list and its own shape. Whether the BRIEF actually survives is a claim
 * about studio's output, and it is asserted in `kiln.live.test.ts` against a real firing's
 * `provenance.prompt` — which is the only place it can be true or false.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('the brief this title requires of studio is a list, not a second copy of the paragraph', () => {
  // §1.1's and §2.1's load-bearing clauses. The projection is what makes one player's chair sit
  // in the same world as another player's chair; #12100f is what the cutout keys against.
  for (const clause of ['painterly gouache', '2:1 dimetric', '#12100f', 'no outline', 'no bevel', 'no gloss']) {
    assert.ok(REQUIRED_PROMPT_CLAUSES.includes(clause), `${clause} is not required of studio`)
  }
  // And this repository holds no second copy of the paragraph to drift from studio's.
  const source = readFileSync(new URL('./studioclient.ts', import.meta.url), 'utf8')
  assert.equal(
    /three-quarter isometric view from above-left/.test(stripComments(source)),
    false,
    'the world-object style paragraph is written here as well as in studio — two briefs, one world',
  )
})

test('a firings brand kit is named for the object, so a retry finds the one it already made', () => {
  // `brand_kits_owner_name_uniq` (studio/src/migrations.ts) makes a repeat a 409, and studio
  // serves no route that finds a kit by name — so the name must be derivable and stable.
  assert.equal(kitNameFor('abc'), 'tessera-object-abc')
  assert.equal(kitNameFor('abc'), kitNameFor('abc'))
  assert.notEqual(kitNameFor('abc'), kitNameFor('abd'))
  assert.ok(kitNameFor('0'.repeat(36)).length <= 200, 'studio caps a kit name at 200 characters')
})

test('the firing lease key is the shape studio uses, so one players firings serialise on both sides', () => {
  // studio/src/generation.ts — `owner:<subject>`. §11.4 says the match is deliberate.
  assert.equal(firingLeaseKey(ALICE_SUBJECT), `owner:${ALICE_SUBJECT}`)
  assert.match(firingLeaseKey(ALICE_SUBJECT), /^owner:/)
})

/* ------------------------------------------------------------------- against Postgres */

test('the same bytes fired twice resolve to the ORIGINAL author — copybot, answered', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const alices = await requestFiring(asDb(sql), {
    authorSubject: ALICE_SUBJECT,
    prompt: 'a stool',
    category: 'seating',
    footprint: '1x1',
    correlationId: 'r1',
  })
  const checksum = `sha256:${'ab'.repeat(32)}`
  await completeFiring(asDb(sql), {
    objectId: alices.id,
    checksum,
    c2pa: true,
    correlationId: 'r1',
  })

  // Bob fires and — impossibly but instructively — gets identical bytes back.
  const bobs = await requestFiring(asDb(sql), {
    authorSubject: BOB_SUBJECT,
    prompt: 'a stool',
    category: 'seating',
    footprint: '1x1',
    correlationId: 'r2',
  })
  const resolved = await completeFiring(asDb(sql), {
    objectId: bobs.id,
    checksum,
    c2pa: true,
    correlationId: 'r2',
  })

  // It resolves to Alice's object and Alice's authorship. It does NOT raise — an honest
  // coincidence is not an error — and it does NOT create a second owner, which is the whole point.
  assert.equal(resolved.id, alices.id)
  assert.equal(resolved.authorSubject, ALICE_SUBJECT)

  // Bob's firing is recorded as failed, with a reason that names the object and its author.
  const bobsRow = await findObject(asDb(sql), bobs.id)
  assert.equal(bobsRow?.status, 'failed')
  const reason = await sql<{ failure_reason: string }[]>`
    select failure_reason from objects where id = ${bobs.id}
  `
  assert.match(String(reason[0]?.failure_reason), /already object/)
  assert.match(String(reason[0]?.failure_reason), new RegExp(ALICE_SUBJECT))

  // And there is exactly one object with those bytes, whatever any handler did.
  const count = await sql<{ n: number }[]>`
    select count(*)::int as n from objects where checksum = ${checksum}
  `
  assert.equal(count[0]?.n, 1)

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // THE ASSERTIONS ABOVE GRADE THE HANDLER. THESE GRADE THE DATABASE, AND THEY WERE ADDED
  // BECAUSE A MUTATION SWEEP SHOWED THE DIFFERENCE.
  //
  // Dropping `tessera_objects_are_their_bytes` and re-running this file left it GREEN. Everything
  // above still passed, because `completeFiring` does a SELECT and branches — so with the index
  // gone it still returns the original object and still writes one row. The test was measuring an
  // `if`, which is precisely the estate's "four tests passing while grading the wrong function".
  //
  // The `if` is the sentence a user reads. The INDEX is the guarantee, and it is the only half
  // that survives a concurrent firing, a backfill or a psql prompt — a SELECT-then-INSERT is a
  // race, and without a unique index two firings that resolve the same bytes at the same instant
  // both pass the check and both insert. So the index is asked directly.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  await assert.rejects(
    () => sql`insert into objects (author_subject, prompt, category, footprint, status, checksum)
              values (${BOB_SUBJECT}, 'a stool', 'seating', '1x1', 'fired', ${checksum})`,
    (err: unknown) => String(err).includes('tessera_objects_are_their_bytes'),
    'a raw INSERT created a second object at one content address — ownership is not derived after all',
  )

  // And genuinely concurrently, on two connections, which is the shape the handler cannot defend
  // against on its own.
  const a = openDb(2)
  const b = openDb(2)
  const racing = `sha256:${'99'.repeat(32)}`
  try {
    const results = await Promise.allSettled([
      a`insert into objects (author_subject, prompt, category, footprint, status, checksum)
        values (${ALICE_SUBJECT}, 'x', 'seating', '1x1', 'fired', ${racing})`,
      b`insert into objects (author_subject, prompt, category, footprint, status, checksum)
        values (${BOB_SUBJECT}, 'x', 'seating', '1x1', 'fired', ${racing})`,
    ])
    assert.equal(
      results.filter((r) => r.status === 'fulfilled').length,
      1,
      'two authors landed at one content address',
    )
  } finally {
    await a.end({ timeout: 5 })
    await b.end({ timeout: 5 })
  }
})

test('there is no owner column on objects, and authorship cannot be re-pointed', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const id = await seedObject(sql, ALICE_SUBJECT)

  // The forgeable field the reference had simply does not exist.
  const columns = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns where table_name = 'objects'
  `
  const names = columns.map((c) => c.column_name)
  assert.equal(names.includes('owner_subject'), false, 'objects has an owner column — §9.2 says ownership is derived')
  assert.ok(names.includes('author_subject'))

  await assert.rejects(
    () => sql`update objects set author_subject = ${BOB_SUBJECT} where id = ${id}`,
    (err: unknown) => String(err).includes('authorship is a fact about the file'),
  )
  await assert.rejects(
    () => sql`update objects set checksum = ${`sha256:${'cd'.repeat(32)}`} where id = ${id}`,
    (err: unknown) => String(err).includes('addressed by its bytes'),
  )
})

test('a fired object without bytes, and a checksum of the wrong shape, are both refused', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  await assert.rejects(
    () => sql`insert into objects (author_subject, prompt, category, footprint, status)
              values (${ALICE_SUBJECT}, 'x', 'seating', '1x1', 'fired')`,
    (err: unknown) => String(err).includes('objects_fired_have_bytes'),
  )
  await assert.rejects(
    () => sql`insert into objects (author_subject, prompt, category, footprint, status, checksum)
              values (${ALICE_SUBJECT}, 'x', 'seating', '1x1', 'fired', 'deadbeef')`,
    (err: unknown) => String(err).includes('objects_checksum_shape'),
  )
  // Uppercase hex is a second spelling of one address, so it is refused rather than normalised.
  await assert.rejects(
    () => sql`insert into objects (author_subject, prompt, category, footprint, status, checksum)
              values (${ALICE_SUBJECT}, 'x', 'seating', '1x1', 'fired', ${`sha256:${'AB'.repeat(32)}`})`,
    (err: unknown) => String(err).includes('objects_checksum_shape'),
  )
})

test('half an anchor is unrepresentable — a claim the chain does not back cannot be written', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  const id = await seedObject(sql, ALICE_SUBJECT)
  await assert.rejects(
    () => sql`update objects set anchor_tx = '0xabc' where id = ${id}`,
    (err: unknown) => String(err).includes('objects_anchor_is_whole'),
  )
  await assert.rejects(
    () => sql`update objects set anchor_block = 1, anchored_at = now() where id = ${id}`,
    (err: unknown) => String(err).includes('objects_anchor_is_whole'),
  )
  await sql`update objects set anchor_tx = '0xabc', anchor_block = 1, anchored_at = now() where id = ${id}`
})

test('a third facing is refused — two, and the reason is a missing column in studio', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await seedObject(sql, ALICE_SUBJECT)
  const parcel = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${ALICE_SUBJECT}, 'homestead', 0, 0, 16) returning id
  `
  await assert.rejects(
    () => sql`insert into placements (parcel_id, object_id, x, y, facing, placed_by)
              values (${parcel[0]!.id}, ${object}, 0, 0, 'north', ${ALICE_SUBJECT})`,
    (err: unknown) => String(err).includes('placements_facing_is_one_of_two'),
  )
})

/**
 * §12's test 6, exactly as written: "including via a bulk paste that is individually under the cap
 * and collectively over it."
 */
test('the object cap is checked at COMMIT, so a bulk paste is one check and not two hundred', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await seedObject(sql, ALICE_SUBJECT)
  const rows = await sql<{ id: string; object_cap: number }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${ALICE_SUBJECT}, 'homestead', 0, 0, 16) returning id, object_cap
  `
  const parcel = rows[0]!
  assert.equal(parcel.object_cap, 160)

  const paste = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      parcelId: parcel.id,
      objectId: object,
      x: i % 16,
      y: Math.floor(i / 16) % 16,
      facing: 'canonical' as const,
      placedBy: ALICE_SUBJECT,
    }))

  // Exactly at the cap is fine.
  await placeObjects(asDb(sql), paste(160))
  assert.equal((await listPlacements(asDb(sql), parcel.id)).length, 160)

  // One more, in its own transaction, is refused.
  await assert.rejects(
    () => placeObjects(asDb(sql), paste(1)),
    (err: unknown) => err instanceof WorldError && err.code === 'over_object_cap',
  )
  assert.equal((await listPlacements(asDb(sql), parcel.id)).length, 160, 'the failed paste left rows behind')

  // And the bulk shape §12 names: from empty, 161 rows each individually under the cap, refused as
  // a whole at COMMIT.
  await sql`delete from placements where parcel_id = ${parcel.id}`
  await assert.rejects(
    () => placeObjects(asDb(sql), paste(161)),
    (err: unknown) => err instanceof WorldError && err.code === 'over_object_cap',
  )
  assert.equal((await listPlacements(asDb(sql), parcel.id)).length, 0)

  // A transaction that goes OVER and comes back under commits — which an immediate per-row check
  // would have refused, and which is the reason for deferring.
  await sql.begin(async (tx) => {
    for (const p of paste(161)) {
      await tx`insert into placements (parcel_id, object_id, x, y, facing, placed_by)
               values (${p.parcelId}, ${p.objectId}, ${p.x}, ${p.y}, ${p.facing}, ${p.placedBy})`
    }
    await tx`delete from placements where parcel_id = ${parcel.id} and ctid in (
               select ctid from placements where parcel_id = ${parcel.id} limit 1)`
  })
  assert.equal((await listPlacements(asDb(sql), parcel.id)).length, 160)
})

test('placing and removing an object resets the fallow clock, whoever does it', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await seedObject(sql, ALICE_SUBJECT)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, claimed_at)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32, now() - interval '100 days') returning id
  `
  const parcelId = rows[0]!.id

  const before = await sql<{ last_edit_at: Date | null }[]>`
    select last_edit_at from parcels where id = ${parcelId}
  `
  assert.equal(before[0]?.last_edit_at, null)

  // A RAW insert, no handler — the trigger is what makes this true for every path.
  await sql`insert into placements (parcel_id, object_id, x, y, facing, placed_by)
            values (${parcelId}, ${object}, 0, 0, 'canonical', ${ALICE_SUBJECT})`
  const after = await sql<{ last_edit_at: Date | null }[]>`
    select last_edit_at from parcels where id = ${parcelId}
  `
  assert.notEqual(after[0]?.last_edit_at, null)

  // And the parcel is no longer fallow, because an edit IS activity.
  const fallow = await sql<{ n: number }[]>`
    select count(*)::int as n from parcels
     where status = 'held' and tier <> 'homestead'
       and now() >= tessera_fallow_at(last_active_at, banked_until)
  `
  assert.equal(fallow[0]?.n, 0)
})

test('a placement can only be removed by the parcels owner', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const object = await seedObject(sql, ALICE_SUBJECT)
  const parcel = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32) returning id
  `
  await placeObjects(asDb(sql), [
    { parcelId: parcel[0]!.id, objectId: object, x: 0, y: 0, facing: 'canonical', placedBy: ALICE_SUBJECT },
  ])
  const placements = await listPlacements(asDb(sql), parcel[0]!.id)
  await assert.rejects(
    () => removePlacement(asDb(sql), placements[0]!.id, BOB_SUBJECT),
    (err: unknown) => err instanceof WorldError && err.status === 404,
  )
  await removePlacement(asDb(sql), placements[0]!.id, ALICE_SUBJECT)
  assert.equal((await listPlacements(asDb(sql), parcel[0]!.id)).length, 0)
})

test('a firing emits tessera.object.fired keyed by the object, carrying the MEASURED c2pa', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await requestFiring(asDb(sql), {
    authorSubject: ALICE_SUBJECT,
    prompt: 'a lantern',
    category: 'lighting',
    footprint: '1x1',
    correlationId: 'req-k',
  })
  await completeFiring(asDb(sql), {
    objectId: object.id,
    checksum: `sha256:${'ef'.repeat(32)}`,
    // Studio measured FALSE. It must arrive as false, not be defaulted to true anywhere —
    // §2.2: "a repo that asserts it is a repo that will be wrong quietly".
    c2pa: false,
    correlationId: 'req-k',
  })
  const rows = await sql<{ topic: string; key: string; payload: Record<string, unknown> }[]>`
    select topic, key, payload from outbox where topic = 'tessera.object.fired'
  `
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.key, object.id)
  assert.equal(rows[0]?.payload['c2pa'], false)
  assert.equal(rows[0]?.payload['authorSubject'], ALICE_SUBJECT)
})

/**
 * Why micro-studio's new 400 cannot reach this service.
 *
 * studio now refuses a `world_object` generation whose kit carries an empty `stylePrompt` with a
 * **400** (`studio/src/server.ts`, the `world_object` check inside the generate route) where it
 * used to 500 inside `buildPrompt`. That change is invisible here — but only because of THIS
 * guard, which was itself untested, so the claim "behaviourally unaffected" rested on nothing.
 *
 * The refusal is in two places on purpose and both are checked: the route never admits an empty
 * prompt, and `createKit` refuses again before opening a socket, so no firing can put an empty
 * `stylePrompt` on a kit even if a second caller appears.
 */
test('an empty prompt is refused here, so studios 400 is unreachable', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  for (const prompt of ['', '   ', '\n\t ']) {
    await assert.rejects(
      () =>
        requestFiring(asDb(sql), {
          authorSubject: ALICE_SUBJECT,
          prompt,
          category: 'seating',
          footprint: '1x1',
          correlationId: 'req-empty',
        }),
      (err: unknown) => err instanceof WorldError && err.status === 400,
      `a prompt of ${JSON.stringify(prompt)} was accepted`,
    )
  }
  // Nothing was written, so no job can later carry an empty description to studio.
  const rows = await sql<{ n: bigint }[]>`select count(*) as n from objects`
  assert.equal(Number(rows[0]?.n), 0)
})

/* ------------------------------------------------------------------------------ anchoring */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `recordAnchor` HAS NO CALLER, AND HAD NO TEST EITHER. THE SECOND WAS THE ACTUAL DEFECT.
 *
 * Nothing calls it because the Registry of Authorship contract does not exist — not in
 * `hearth/contracts/src/`, and not as a variant `mint` can deploy. See the function's own comment.
 * That is a fact about the chain and cannot be fixed here.
 *
 * What COULD be fixed here is that the payload was never checked against the consumer already
 * waiting on it. `micro-notify`'s rule (`notify/src/catalogue.ts`) reads exactly four
 * things off this event, and `userOfSubject` on the first of them decides whether anybody is told
 * at all — so a payload that dropped `authorSubject` would resolve nobody for ever, which is the
 * `no-subject` failure this repository just fixed on two OTHER topics. These tests grade the four
 * fields the consumer reads, by name, so the day a caller lands the event is already right.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('an anchor emits the four fields notify reads, keyed by the object', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  const id = await seedObject(sql, ALICE_SUBJECT)
  const anchored = await recordAnchor(asDb(sql), {
    objectId: id,
    transactionHash: `0x${'ab'.repeat(32)}`,
    blockNumber: 4_242n,
    correlationId: 'req-anchor',
  })
  assert.equal(anchored.anchorTx, `0x${'ab'.repeat(32)}`)

  const rows = await sql<{ key: string; actor: string; payload: Record<string, unknown> }[]>`
    select key, actor, payload from outbox where topic = 'tessera.object.anchored'
  `
  assert.equal(rows.length, 1)
  // `keyedBy: 'object_id'` — and notify falls back to `event.key` for the object id, so this is
  // load-bearing on the consumer side and not only on the ordering side.
  assert.equal(rows[0]?.key, id)
  // The actor is `system`: the platform signs this, not the author. notify's comment calls
  // `forUser` "impossible here, not merely unwise" for exactly this reason, which is why the
  // author must travel as a FIELD.
  assert.equal(rows[0]?.actor, 'system')

  const payload = rows[0]?.payload ?? {}
  // The field `userOfSubject` resolves the recipient from. Without it the rule answers
  // `no_recipient` for ever — the defect this repository closed on fallowed and booked.
  assert.equal(payload['authorSubject'], ALICE_SUBJECT)
  assert.equal(payload['objectId'], id)
  // Rendered into the template's `{{transactionHash}}` and `{{blockNumber}}`
  // (`notify/src/templates.ts`). A blank block number makes the sentence unverifiable.
  assert.equal(payload['transactionHash'], `0x${'ab'.repeat(32)}`)
  assert.equal(String(payload['blockNumber']), '4242')
})

test('an object anchors once — a second anchor is refused, not a second event', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  const id = await seedObject(sql, ALICE_SUBJECT)
  const first = { objectId: id, transactionHash: `0x${'cd'.repeat(32)}`, blockNumber: 7n }
  await recordAnchor(asDb(sql), { ...first, correlationId: 'req-1' })
  // `where ... and anchor_tx is null` is what makes this a refusal rather than an overwrite. A
  // re-anchor would otherwise replace a real transaction hash with a second one and emit a second
  // notification for one fact — and notify dedupes on the OBJECT, so the second is silent.
  await assert.rejects(
    () =>
      recordAnchor(asDb(sql), {
        objectId: id,
        transactionHash: `0x${'ef'.repeat(32)}`,
        blockNumber: 8n,
        correlationId: 'req-2',
      }),
    (err: unknown) => err instanceof WorldError && err.status === 404,
  )
  const rows = await sql<{ n: bigint }[]>`
    select count(*) as n from outbox where topic = 'tessera.object.anchored'
  `
  assert.equal(Number(rows[0]?.n), 1)
  const kept = await findObject(asDb(sql), id)
  assert.equal(kept?.anchorTx, `0x${'cd'.repeat(32)}`, 'the first anchor was overwritten')
})
