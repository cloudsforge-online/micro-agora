/**
 * What a Tessera object is called outside Tessera: its URN, and the ledger asset it is held as.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE OBJECT'S NAME IS ITS BYTES, AND IT IS SPELLED IN EXACTLY ONE PLACE.**
 *
 * §9.2: "the copybot copies bytes, and bytes are the identity". `tessera_objects_are_their_bytes`
 * is a unique index on `checksum`, so one sha256 is one object for ever. Naming the object by its
 * checksum rather than by its row id makes that property survive the trip to `micro-market`: two
 * listings of the same bytes name the same `item_urn`, in anybody's database, without Tessera
 * having to be asked.
 *
 * There are three names for one object and each derives from the previous one, so they cannot
 * drift:
 *
 *     checksum      sha256:<64 hex>                          — studio's spelling, stored as-is
 *     itemUrn       cf:tessera:object:<64 hex>               — what micro-market lists
 *     itemAssetCode TOKEN:cf:tessera:object:<64 hex>         — what micro-ledger reserves
 *
 * **The `sha256:` prefix is dropped from the URN and that is forced rather than chosen.**
 * `parseTitleUrn` splits on `:` and refuses anything that is not exactly four parts
 * (`contracts/packages/worlds/src/index.ts`), so an id of `sha256:<hex>` would make five and fail
 * to parse. The URN is built by the contract's `titleUrn` and then parsed BACK by the contract's
 * `parseTitleUrn` before it is returned — the same discipline `titlecontract.ts` applies to the
 * provision URN, and for the reason recorded at `contracts/packages/worlds/src/index.ts`:
 * aetherholm builds its URN by template literal and never checks it, so its first malformed URN
 * will be discovered by a consumer.
 *
 * **`TOKEN:<urn>` is the contract's spelling, not one invented here.**
 * `contracts/packages/money/src/index.ts` defines `TokenAssetCode = \`TOKEN:${string}\`` and
 * describes it as "a user-minted token held custodially", which is exactly what a fired object is:
 * the platform holds the bytes, the creator holds the title to them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { TokenAssetCode } from '@cloudsforge/contracts-money'
import { parseTitleUrn, titleUrn } from '@cloudsforge/contracts-worlds'
import { TITLE_SLUG } from './titlecontract.ts'
import { WorldError } from './world.ts'

/** The `kind` segment of an object's URN. `cf:tessera:object:<hex>`. */
export const OBJECT_URN_KIND = 'object'

/** The shape studio returns and `objects_checksum_shape` stores. */
const CHECKSUM = /^sha256:([0-9a-f]{64})$/

/**
 * The URN for a fired object, from its checksum.
 *
 * Refuses a checksum of any other shape rather than normalising one. The checksum IS the object's
 * identity (`studioclient.ts` refuses a reformat for the same reason): a function here that
 * accepted a bare hex, or an uppercase one, would be the one place two spellings of one object
 * could be born, and `market.listings.item_urn` has no format constraint at all
 * (`market/src/migrations.ts`) to catch it on the way out.
 */
export function objectUrn(checksum: string): string {
  const matched = CHECKSUM.exec(checksum)
  const hex = matched?.[1]
  if (!hex) {
    throw new WorldError(
      'bad_checksum',
      `an object URN is built from a sha256:<64 hex> checksum, not from ${checksum}`,
      500,
    )
  }
  const urn = titleUrn({ title: TITLE_SLUG, kind: OBJECT_URN_KIND, id: hex })
  // Built by the contract, then parsed BACK by the contract. `titleUrn` is a template literal and
  // will happily build an unparseable URN out of an id containing a colon; this is the line that
  // notices. It has caught exactly that: `sha256:<hex>` as the id makes five segments, not four.
  const parsed = parseTitleUrn(urn)
  if (!parsed.ok) {
    throw new WorldError('bad_urn', `built an object URN that does not parse: ${parsed.errors.join('; ')}`, 500)
  }
  return urn
}

/**
 * The ledger asset a fired object is held as.
 *
 * Derived from `objectUrn`, never assembled separately — so the thing `micro-market` lists and the
 * thing `micro-ledger` reserves cannot come apart. `market/src/listings.ts` reserves
 * `listing.itemAssetCode` at activation under the comment "The ITEM's asset code, not the price's.
 * Reserving the wrong one produces an entry that balances perfectly and reserves something the
 * seller is not selling" — which is precisely the failure two spellings would produce.
 */
export function objectAssetCode(checksum: string): TokenAssetCode {
  return `TOKEN:${objectUrn(checksum)}`
}

/** The checksum an object URN names, or `null`. The inverse of `objectUrn`, for a consumer. */
export function checksumOfObjectUrn(urn: string): string | null {
  const parsed = parseTitleUrn(urn)
  if (!parsed.ok) return null
  const { title, kind, id } = parsed.value
  if (title !== TITLE_SLUG || kind !== OBJECT_URN_KIND) return null
  return /^[0-9a-f]{64}$/.test(id) ? `sha256:${id}` : null
}
