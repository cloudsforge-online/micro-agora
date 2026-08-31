/**
 * Cosmetics.
 *
 * Monetisation is cosmetics and season passes sold as billing entitlements — never stat advantage
 * (03/19 §1.2). Equipping a cosmetic is gated by `billing.owns`, and everything it writes lands in
 * `saves.equipped_cosmetics`. There is no code path from here to a stat: the engine reads Kin stats
 * from species base stats, per-instance Attunement and Resonance, none of which a cosmetic can set.
 * That is the anti-pay-to-win rule expressed as an absence.
 */

import type { EntitlementReader } from './billingclient.ts';
import type { GameData } from './content/gamedata.ts';
import type { Db, Emit, Tx } from './outbox.ts';
import { NotFoundError, ValidationError } from './savegame.ts';

/** The title scope Emberkin's cosmetics are entitled under. */
export const TITLE_SCOPE = 'emberkin';

export class CosmeticNotOwnedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CosmeticNotOwnedError';
  }
}

export interface EquipCosmeticInput {
  readonly userId: string;
  readonly slot: string;
  /** The cosmetic item urn to equip, or null to clear the slot. */
  readonly itemUrn: string | null;
  readonly correlationId?: string;
}

const KNOWN_SLOTS = new Set(['frame', 'trail', 'title_card', 'hud', 'battle_intro']);

export async function equipCosmetic(
  sql: Db,
  producer: string,
  billing: EntitlementReader,
  _data: GameData,
  input: EquipCosmeticInput,
  withOutbox: <T>(sql: Db, producer: string, fn: (tx: Tx, emit: Emit) => Promise<T>) => Promise<T>,
): Promise<Record<string, string>> {
  if (!KNOWN_SLOTS.has(input.slot)) {
    throw new ValidationError(`unknown cosmetic slot '${input.slot}' (one of ${[...KNOWN_SLOTS].join(', ')})`);
  }

  // Setting a cosmetic requires owning it; clearing a slot never does. Failure to REACH billing
  // throws BillingUnavailableError here, which the server maps to 503 — the write fails closed.
  if (input.itemUrn) {
    const owns = await billing.owns(input.userId, input.itemUrn, TITLE_SCOPE);
    if (!owns) throw new CosmeticNotOwnedError(`account does not own cosmetic '${input.itemUrn}'`);
  }

  return withOutbox(sql, producer, async (tx, emit) => {
    const rows = await tx<{ equipped_cosmetics: Record<string, string> }[]>`
      select equipped_cosmetics from saves where user_id = ${input.userId} for update
    `;
    if (!rows[0]) throw new NotFoundError(`no save for user ${input.userId}`);
    const equipped = { ...rows[0].equipped_cosmetics };
    if (input.itemUrn) equipped[input.slot] = input.itemUrn;
    else delete equipped[input.slot];

    await tx`
      update saves set equipped_cosmetics = ${tx.json(equipped as unknown as Record<string, never>)}, updated_at = now()
       where user_id = ${input.userId}
    `;
    emit({
      topic: 'emberkin.cosmetic.equipped',
      key: input.userId,
      payload: { userId: input.userId, slot: input.slot, itemUrn: input.itemUrn },
      actor: `user:${input.userId}`,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
    return equipped;
  });
}
