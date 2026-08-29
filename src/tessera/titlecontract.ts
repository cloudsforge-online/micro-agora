/**
 * The title contract: the two routes `micro-worlds` actually calls.
 *
 * §11.8: "`worlds` calls exactly two routes, despite its own client header saying four
 * (`worlds/src/titleclient.ts`): `GET /v1/title` returning `{slug, name, capabilities[]}`, and
 * `POST /v1/provision` taking `{entitlementId, subject, userId, sku, scope, metadata}` and
 * returning `{urn, replayed}`, with the `entitlementId` sent as **both** the `Idempotency-Key`
 * header and a body field."
 *
 * Both paths, both shapes and the URN builder come from `@cloudsforge/contracts-worlds`, so this
 * service cannot serve a route worlds does not call, nor a body it does not send. That is the
 * exact failure the achievement bridge suffered in the other direction: two title clients POSTed
 * `/internal/achievements` for months and worlds never served it.
 */

import { createHash } from 'node:crypto'
import {
  parseTitleUrn,
  titleUrn,
  type Capability,
  type ProvisionRequest,
  type ProvisionResult,
  type TitleDescriptor,
} from '@cloudsforge/contracts-worlds'
import type { Db, Tx } from './outbox.ts'
import { withOutbox } from './outbox.ts'
import { ARCHETYPES, ensureAccount, openWard, WorldError, type Archetype } from './world.ts'

/** This title's slug in worlds' registry — the one place it is spelled. */
export const TITLE_SLUG = 'tessera'

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CAPABILITIES, TYPED, AND ONE OF THEM IS THE POINT.
 *
 * §11.8: "Tessera declares **`['private_world', 'cosmetics', 'inventory']`**. `private_world` is
 * the one that matters: the provisioning bridge calls a title only when that capability holds
 * (`worlds/src/provisioning.ts`), and provisioning a **Private Ward** is how the existing,
 * currently-unserved `world.private.small` SKU (`billing/src/migrations.ts`) finally gets a
 * code path."
 *
 * Typed `readonly Capability[]` and not `string[]`, which is a correction to what aetherholm does:
 * `contracts/packages/worlds/src/index.ts` records that `aetherholm/src/server.ts`
 * "builds its descriptor from a bare string literal ... with nothing to check it against", and
 * that a typo there "turns a typo in a registration into a purchase that is accepted and never
 * provisioned". A misspelled capability here is a compile error.
 *
 * `achievements` and `seasons` are deliberately absent. Declaring a capability this title does not
 * deliver is a purchase taken for something it cannot make — worlds' conformance check 4 exists
 * because that has happened.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const CAPABILITIES: readonly Capability[] = Object.freeze([
  'private_world',
  'cosmetics',
  'inventory',
])

export const TITLE_DESCRIPTOR: TitleDescriptor = Object.freeze({
  slug: TITLE_SLUG,
  name: 'Tessera',
  capabilities: CAPABILITIES,
})

/**
 * The SKUs this title can actually deliver, and what each provisions.
 *
 * A closed map, so an unknown SKU is a 422 `unsupported` — the contract's own status for "this
 * title cannot deliver that" — rather than a silent success that bills somebody for nothing.
 *
 * `world.private.small` is the row §7.3 and §11.8 both point at: it already exists in
 * `billing/src/migrations.ts` (750, 30-day, title-scoped) and **no title serves it today**.
 * This is the code path.
 */
export const SERVED_SKUS: Readonly<Record<string, { kind: string; archetype: Archetype }>> =
  Object.freeze({
    'world.private.small': Object.freeze({ kind: 'ward', archetype: 'ashfield' as Archetype }),
  })

export function servesSku(sku: string): boolean {
  return Object.hasOwn(SERVED_SKUS, sku)
}

/**
 * Provision, idempotently on `entitlementId`.
 *
 * §12's test 11: "provision replays idempotently on `entitlementId` — same `urn`, `replayed: true`
 * on the second ask, the way `worlds/src/conformance.ts` checks it."
 *
 * The idempotency is the PRIMARY KEY on `provisions.entitlement_id`, not a check-then-insert: two
 * bridge replicas redelivering one entitlement both run this, and exactly one insert wins. A
 * check-then-insert would let both pass the check and both raise a ward.
 *
 * The URN is built by `titleUrn` from the contract and then parsed back by `parseTitleUrn` before
 * it is stored. Parsing your own output looks redundant and is not: `contracts-worlds` records
 * that aetherholm builds its URN by template literal and never checks it, so a URN of the wrong
 * shape "is recorded and pointed at for ever". This is one line that makes that impossible, and
 * `provisions_urn_is_a_title_urn` is the same statement in the database.
 */
export async function provision(
  sql: Db,
  request: ProvisionRequest,
): Promise<ProvisionResult> {
  const existing = await sql<{ urn: string }[]>`
    select urn from provisions where entitlement_id = ${request.entitlementId}
  `
  const already = existing[0]
  if (already) return { urn: already.urn, replayed: true }

  const served = SERVED_SKUS[request.sku]
  if (!served) {
    throw new WorldError(
      'unsupported',
      `${TITLE_SLUG} does not serve the sku ${request.sku}`,
      // 422 `unsupported` is the contract's own answer (UNSUPPORTED_STATUS / UNSUPPORTED_CODE),
      // and it is distinct from 400: the request was well-formed, this title just cannot deliver
      // it, which is a fact about the title and not a mistake by the caller.
      422,
    )
  }

  const name = wardNameFrom(request)
  const slug = wardSlugFrom(request)

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await mintTheWard(sql, request, served, name, slug)
    } catch (err) {
      const constraint = uniqueViolation(err)
      if (constraint === null) throw err

      // ═══════════════════════════════════════════════════════════════════════════════════════
      // ORDINAL IS A COUNTER READ AND WRITTEN IN THE SAME STATEMENT, SO TWO PURCHASES RACE.
      //
      // `coalesce(max(ordinal) + 1, 0)` is not an allocation, it is a read; two provisions
      // committing in the same instant both read N and both write N+1, and `wards_ordinal_key`
      // refuses the second. That is the constraint being right — mint order is meant to be a
      // total order — and it has nothing to do with either caller, so retrying is the honest
      // answer: the next read sees the winner's row and takes the next number.
      //
      // Bounded, and the exhausted case is 503 rather than 500. 503 says "ask again", which is
      // true of a contended counter and false of a fault, and worlds' bridge redelivers.
      // ═══════════════════════════════════════════════════════════════════════════════════════
      if (constraint === 'wards_ordinal_key') {
        if (attempt < ORDINAL_ATTEMPTS) continue
        throw new WorldError(
          'ward_allocation_contended',
          `the ward ordinal was contended by ${ORDINAL_ATTEMPTS} concurrent provisions; retry`,
          503,
        )
      }

      // ═══════════════════════════════════════════════════════════════════════════════════════
      // ANY OTHER UNIQUE VIOLATION IS A REFUSAL, AND A REFUSAL IS NOT A 500.
      //
      // This is the second half of the defect the slug caused, and it outlives the slug: a
      // `PostgresError` that escapes this function reaches `server.ts`'s handler, matches none of
      // its branches, and is answered `500 internal` — to a customer in the middle of a purchase.
      // The constraint did its job; the handler failed to translate it. 409 is what a caller can
      // act on, and the constraint is named so an operator does not have to guess which one it
      // was. `provisions_pkey` cannot reach here (the insert below is `on conflict do nothing`),
      // so in practice this is the ward's own uniqueness and nothing else.
      // ═══════════════════════════════════════════════════════════════════════════════════════
      throw new WorldError(
        'ward_not_minted',
        `the ward could not be minted: ${constraint || 'a uniqueness constraint'} refused it`,
        409,
      )
    }
  }
}

/** How many times a contended mint ordinal is re-read before the caller is asked to retry. */
export const ORDINAL_ATTEMPTS = 5

async function mintTheWard(
  sql: Db,
  request: ProvisionRequest,
  served: { kind: string; archetype: Archetype },
  name: string,
  slug: string,
): Promise<ProvisionResult> {
  return withOutbox(sql, async (tx) => {
    await ensureAccount(tx, request.subject)
    // The ward is minted inside the same transaction as the provision row, so a crash cannot
    // leave a paid entitlement with no ward or a ward with nothing that paid for it.
    const wards = await tx<{ id: string }[]>`
      insert into wards (slug, name, archetype, ordinal, claimable_tiles)
      select ${slug}, ${name}, ${served.archetype}, coalesce(max(ordinal) + 1, 0), 49152
        from wards
      on conflict (slug) do nothing
      returning id
    `
    const wardId = wards[0]?.id ?? (await adoptTheWardOnThisSlug(tx, request, slug)).id

    const urn = titleUrn({ title: TITLE_SLUG, kind: served.kind, id: wardId })
    const parsed = parseTitleUrn(urn)
    if (!parsed.ok) {
      // Unreachable unless the contract's builder and its parser disagree, which is exactly the
      // pair worth asserting rather than assuming — and cheaper to assert here, once per
      // provision, than to discover in worlds' registry.
      throw new WorldError('bad_urn', parsed.errors.join('; '), 500)
    }

    const rows = await tx<{ urn: string }[]>`
      insert into provisions (entitlement_id, subject, user_id, sku, scope, urn, ward_id, metadata)
      values (${request.entitlementId}, ${request.subject}, ${request.userId}, ${request.sku},
              ${request.scope}, ${urn}, ${wardId}, ${tx.json(request.metadata as Record<string, never>)})
      on conflict (entitlement_id) do nothing
      returning urn
    `
    const row = rows[0]
    if (!row) {
      // The other replica won the race between the SELECT above and this INSERT. Read back what
      // it wrote and report a replay — which is the truth, and is what the bridge expects.
      const winner = await tx<{ urn: string }[]>`
        select urn from provisions where entitlement_id = ${request.entitlementId}
      `
      const won = winner[0]
      if (!won) throw new WorldError('not_provisioned', 'the provision did not land')
      return { urn: won.urn, replayed: true }
    }
    return { urn: row.urn, replayed: false }
  })
}

/**
 * A ward is already standing on this entitlement's slug. Decide whose it is.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ANSWER IS "RETURN THE EXISTING WARD" ONLY WHEN IT IS DEMONSTRABLY THIS ENTITLEMENT'S.
 *
 * A purchase is idempotent-shaped — `world.private.small` already replays 200 with the same urn —
 * so a collision that is genuinely a replay must answer with the ward, not with an error. But
 * "adopt whatever is on the slug" is the version of that idea that hands a paying customer
 * somebody else's world, and it would do it silently. So the claim is CHECKED against the
 * `provisions` row, which is the only record of who paid for which ward:
 *
 *   * the slug's ward is provisioned to THIS entitlement  →  a replay. Return its urn.
 *   * the slug's ward is provisioned to ANOTHER            →  409. Never adopted, never widened.
 *   * the slug's ward has no provision at all              →  a previous attempt at THIS
 *     provision died between the two inserts. The slug is derived from this entitlement id and
 *     from nothing else, so nothing else could have minted it. Adopt it, and do not leave a paid
 *     entitlement permanently wedged behind a ward it already owns.
 *
 * The third case is why the ward insert is `on conflict (slug) do nothing` rather than a plain
 * insert: a plain insert makes that state unrecoverable for ever.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function adoptTheWardOnThisSlug(
  tx: Tx,
  request: ProvisionRequest,
  slug: string,
): Promise<{ id: string }> {
  const standing = await tx<{ id: string; entitlement_id: string | null }[]>`
    select w.id, p.entitlement_id
      from wards w
      left join provisions p on p.ward_id = w.id
     where w.slug = ${slug}
     limit 1
  `
  const claimant = standing[0]
  if (!claimant) {
    // The row that caused the conflict is gone again. Nothing here can act on that; the caller
    // retries and the next attempt either mints or finds it.
    throw new WorldError('ward_allocation_contended', `the ward on ${slug} vanished mid-mint`, 503)
  }
  if (claimant.entitlement_id !== null && claimant.entitlement_id !== request.entitlementId) {
    throw new WorldError(
      'ward_slug_taken',
      `the ward slug ${slug} is already provisioned to another entitlement`,
      409,
    )
  }
  return { id: claimant.id }
}

/**
 * The constraint a unique violation names, or `null` if this is not one.
 *
 * Read off `code` and `constraint_name`, which postgres.js copies straight from the server's error
 * fields — not off the message. `jobs.ts` matches on the message text for the same constraint and
 * that is the fragile half of this repository: a message is a localisation and a formatting away
 * from not containing the name, whereas `23505` is in the SQL standard.
 */
export function uniqueViolation(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const candidate = err as { code?: unknown; constraint_name?: unknown }
  if (candidate.code !== '23505') return null
  return typeof candidate.constraint_name === 'string' ? candidate.constraint_name : ''
}

/**
 * A ward name from whatever billing carried on the grant.
 *
 * `metadata` is free-form by the contract's own declaration, so it is read defensively and never
 * trusted into a constraint: a `name` that is not a string, or is empty, or is 400 characters, is
 * replaced rather than 400'd. A provisioning bridge that has already taken somebody's money is the
 * wrong place to refuse over a display name.
 */
export function wardNameFrom(request: ProvisionRequest): string {
  const supplied = request.metadata['name']
  if (typeof supplied === 'string') {
    const trimmed = supplied.trim()
    if (trimmed.length > 0 && trimmed.length <= 80) return trimmed
  }
  return `Private Ward ${request.entitlementId.slice(0, 8)}`
}

/**
 * How many hex characters of the digest the slug carries. 40 is 160 bits.
 *
 * Bounded, and the bound is not aesthetic. `wardCommunitySlug` prefixes `ward-` and then
 * `.slice(0, 64)` to satisfy community's own CHECK (`communityclient.ts`), so a ward slug
 * longer than 59 characters is silently truncated on its way to becoming a community slug — which
 * would put this exact defect back one service downstream, where it would be somebody else's
 * unique violation. `private-` (8) + 40 = 48, and `ward-` + 48 = 53. `wards_slug_shape`, added in
 * migration 12, holds the 59 in the schema so this constant cannot drift past it unnoticed.
 */
export const SLUG_DIGEST_CHARS = 40

/**
 * The ward's slug. Derived from the entitlement id, not from the name.
 *
 * A slug derived from a user-supplied name is a slug two users can collide on, and the collision
 * surfaces as a unique-violation on somebody's paid provision. The entitlement id is already
 * unique and already the idempotency key.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS A DIGEST BECAUSE THE PREVIOUS VERSION TRUNCATED, AND TRUNCATION IS NOT A DERIVATION.
 *
 * This function used to be `entitlementId.replace(/[^a-z0-9]/g, '').slice(0, 12)`, under the
 * comment above — so it produced the exact outcome that comment exists to prevent, and it did it
 * on the paid path. Twelve characters is not a scale problem, it is a shape one: identity mints
 * UUIDv7, whose first twelve hex digits ARE the 48-bit millisecond timestamp, so any two
 * entitlements granted in the same millisecond map to one slug. `wards_slug_key` then refuses the
 * second, and the customer buying the ward gets a 500.
 *
 * Stripping the separators makes it worse rather than better: it is not injective even before the
 * truncation, because `ent-1` and `ent1` strip to the same string.
 *
 * A digest is the smallest thing that is BOTH bounded and injective in practice, which is what a
 * slug derived from a unique id has to be. It is opaque, and that costs nothing that matters:
 * `provisions.ward_id` is the record of which entitlement raised which ward, and `wardNameFrom`
 * still puts the first eight characters of the id in the ward's display name.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function wardSlugFrom(request: ProvisionRequest): string {
  const digest = createHash('sha256')
    .update(request.entitlementId)
    .digest('hex')
    .slice(0, SLUG_DIGEST_CHARS)
  return `private-${digest}`
}

/** Every archetype a private ward may be minted as. Re-exported so tests need one import. */
export { ARCHETYPES, openWard }
