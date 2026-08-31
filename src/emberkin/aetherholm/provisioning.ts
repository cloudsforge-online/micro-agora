/**
 * The Private Skerry: the title contract's write half, and the owner's read of what it made.
 *
 * The read was missing for as long as the write existed. Measured on 2026-08-10 (micro-org#332):
 * `POST /v1/provision` had raised skerries since this module landed, every route that can show an
 * archipelago wants an id in its path, and the only place a client was ever handed one was
 * `GET /v1/seasons/current` — the PUBLIC season world. So a buyer had a row here, twelve seeded
 * islands and a wind lattice, and no way to name any of it. `listArchipelagosOwnedBy` at the foot
 * of this file is that missing half, and it lives here rather than in seasons.ts because the thing
 * being listed is what provisioning created: a skerry has no season.
 *
 * This is the first implementation in the estate of the contract `worlds` actually calls —
 * `worlds/src/titleclient.ts` POSTs `/v1/provision` with the entitlement id as both the
 * `Idempotency-Key` header and a body field, and `worlds/src/conformance.ts` is the executable
 * statement of what this module must satisfy. The three answers it can give, in worlds' own
 * vocabulary:
 *
 *   - 2xx with a urn        — provisioned (`replayed: true` when the entitlement was seen before;
 *                             the SAME urn both times, conformance check 5, THE ONE THAT MATTERS).
 *   - 422 `unsupported`     — an ANSWER, not a fault: a SKU this title does not sell. Terminal at
 *                             the bridge, never retried (titleclient.ts).
 *   - anything else         — worlds treats it as "we do not know whether it provisioned" and
 *                             retries with the same entitlement id, which the unique absorbs.
 *
 * **The aegis is deliberately unreachable from here.** Nothing in this module touches
 * `aegis_until`, and `titlecontract.test.ts` asserts the absence over comment-stripped source —
 * a shield you can buy is pay-for-power on the defensive axis (20-aetherholm.md §4).
 */

import {
  titleUrn,
  type ProvisionRequest,
  type ProvisionResult,
} from '@cloudsforge/contracts-worlds';
import { SKERRY_ISLAND_COUNT, generateIslands, skerrySeed } from './world.ts';
import { insertIslands, isUniqueViolation } from './seasons.ts';
import { ensureLattice } from './lattice.ts';
import { withOutbox, type Db } from './outbox.ts';

export const SKERRY_PROVISIONED_TOPIC = 'aetherholm.skerry.provisioned';

/** What this title sells through the bridge. One SKU in phase 1: the Private Skerry. */
export const PROVISIONABLE_SKUS: ReadonlySet<string> = new Set(['private_skerry']);

export class UnsupportedSkuError extends Error {
  constructor(sku: string) {
    super(`${sku} is not sold by aetherholm`);
    this.name = 'UnsupportedSkuError';
  }
}

/**
 * The bridge's request and answer, from `@cloudsforge/contracts-worlds`.
 *
 * These were `ProvisionInput` and `ProvisionOutcome`, declared here — and `ProvisionRequest` and
 * `ProvisionResult`, declared field-for-field identically at `worlds/src/titleclient.ts`. Two
 * repositories held one shape under two names, agreeing only because one author wrote both within a
 * week. The aliases are kept so the rest of this service reads unchanged, but the shape now has one
 * definition, in the package both halves import.
 */
export type ProvisionInput = ProvisionRequest;
export type ProvisionOutcome = ProvisionResult;

/**
 * `cf:aetherholm:skerry:<id>`, built by the contract rather than by a template literal here.
 *
 * The literal was correct and unchecked. `titleUrn` is the same four segments with a parser beside
 * it (`parseTitleUrn`), so an ill-formed urn is caught at the boundary rather than stored and
 * pointed at for ever — a 2xx carrying a bad urn is the failure worlds cannot detect.
 */
function urnOf(archipelagoId: string): string {
  return titleUrn({ title: 'aetherholm', kind: 'skerry', id: archipelagoId });
}

/**
 * Provision, idempotently on the entitlement id.
 *
 * The replay path is a read; the create path is one transaction holding the archipelago, its
 * islands, the provisions row and the outbox event. A race between two replicas resolves at
 * `provisions_entitlement_uniq` (or `archipelagos_entitlement_uniq`, whichever is reached
 * first): the loser rolls everything back and reads the winner's row.
 */
export async function provisionSkerry(
  sql: Db,
  producer: string,
  input: ProvisionInput,
  outbox: typeof withOutbox = withOutbox,
): Promise<ProvisionOutcome> {
  if (!PROVISIONABLE_SKUS.has(input.sku)) throw new UnsupportedSkuError(input.sku);

  const replayed = await findByEntitlement(sql, input.entitlementId);
  if (replayed) return { urn: replayed, replayed: true };

  const requestedName =
    typeof input.metadata['name'] === 'string' && input.metadata['name'].trim().length > 0
      ? input.metadata['name'].trim().slice(0, 60)
      : 'Private Skerry';

  try {
    const urn = await outbox(sql, producer, async (tx, emit) => {
      // Derived from the entitlement id, so even a hypothetical double-create could not mint two
      // geographies for one purchase — see src/world.ts skerrySeed.
      const seed = skerrySeed(input.entitlementId);

      const archipelagos = await tx<{ id: string }[]>`
        insert into archipelagos (kind, season_id, owner_subject, entitlement_id, name, seed)
        values ('skerry', null, ${input.subject}, ${input.entitlementId}, ${requestedName},
                ${seed.toString()})
        returning id
      `;
      const archipelagoId = archipelagos[0]!.id;
      await insertIslands(tx, archipelagoId, generateIslands(seed, SKERRY_ISLAND_COUNT));
      // A skerry is born with its winds and its spires; the public world backfills via the
      // season job, but there is no reason for a fresh world to wait a minute for weather.
      await ensureLattice(tx, archipelagoId);

      const urn = urnOf(archipelagoId);
      await tx`
        insert into provisions (entitlement_id, subject, user_id, sku, scope, archipelago_id, urn, metadata)
        values (${input.entitlementId}, ${input.subject}, ${input.userId}, ${input.sku},
                ${input.scope}, ${archipelagoId}, ${urn}, ${tx.json(input.metadata as never)})
      `;

      emit({
        topic: SKERRY_PROVISIONED_TOPIC,
        key: input.entitlementId,
        payload: {
          archipelagoId,
          entitlementId: input.entitlementId,
          subject: input.subject,
          sku: input.sku,
          urn,
          islands: SKERRY_ISLAND_COUNT,
        },
        actor: `service:${producer}`,
        correlationId: input.correlationId,
      });
      return urn;
    });
    return { urn, replayed: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = await findByEntitlement(sql, input.entitlementId);
      if (winner) return { urn: winner, replayed: true };
    }
    throw err;
  }
}

async function findByEntitlement(sql: Db, entitlementId: string): Promise<string | null> {
  const rows = await sql<{ urn: string }[]>`
    select urn from provisions where entitlement_id = ${entitlementId}
  `;
  return rows[0]?.urn ?? null;
}

/* --------------------------------------------------------------- the buyer's own list */

/** One archipelago a person owns, as their own list serves it. */
export interface OwnedArchipelago {
  readonly id: string;
  /** `skerry` for everything this can return today: `archipelagos_ownership_coherent` forbids a
   *  public archipelago from having an owner at all. Carried anyway, because the wire should say
   *  which kind of world it handed back rather than leave the client to assume. */
  readonly kind: string;
  readonly name: string;
  /**
   * `cf:aetherholm:skerry:<id>` — the identity the rest of the estate dereferences.
   *
   * Nullable because it lives on `provisions`, one join away. Provisioning writes both rows in one
   * transaction so a real purchase always has it; a row inserted by hand (every fixture in this
   * repository does exactly that) has not. Answering null is the honest shape for "this world was
   * not minted through the bridge" — inventing a urn from the id would mint one the bridge never
   * issued, which is the failure `titleUrn`'s parser exists to make impossible.
   */
  readonly urn: string | null;
  readonly createdAt: Date;
}

/**
 * The most worlds one list will name.
 *
 * The cap of `GET /v1/battles` (50), for the same reason: an unbounded list is an unbounded
 * response. Larger than that one because a skerry is a PURCHASE — a list truncated below what
 * somebody paid for is the worse failure — and one purchase is one row, so a hundred rows is a
 * hundred entitlements. Nobody in the estate holds one yet (micro-org#332: the entitlement path
 * has only ever been driven by the bridge and by tests, measured 2026-08-10), so this bounds a
 * future rather than trims a present.
 */
export const OWNED_ARCHIPELAGO_LIMIT = 100;

/**
 * Every archipelago a person owns, newest first.
 *
 * Keyed on `archipelagos.owner_subject`, the LEDGER spelling `user:<uuid>` — the same predicate
 * `erasure.ts` anonymises by, and the one the `archipelagos_owner_subject_shape` CHECK pins. That
 * agreement is worth naming: after an erasure the column reads `erased:<uuid>`, so this list stops
 * returning the row, which is what a right-to-erasure request asked for. Reading `provisions.
 * user_id` instead would have kept serving the world to an id that had been erased from it.
 */
export async function listArchipelagosOwnedBy(sql: Db, userId: string): Promise<OwnedArchipelago[]> {
  const rows = await sql<
    { id: string; kind: string; name: string; urn: string | null; created_at: Date }[]
  >`
    select a.id, a.kind, a.name, p.urn, a.created_at
      from archipelagos a
      left join provisions p on p.archipelago_id = a.id
     where a.owner_subject = ${`user:${userId}`}
     order by a.created_at desc, a.id
     limit ${OWNED_ARCHIPELAGO_LIMIT}
  `;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    urn: row.urn,
    createdAt: row.created_at,
  }));
}
