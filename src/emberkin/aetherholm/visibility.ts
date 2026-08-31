/**
 * Who may read an archipelago.
 *
 * `archipelagos` holds two kinds and they want opposite answers. `kind = 'public'` is the season
 * world — everyone plays there, and gating it would be gating the game. `kind = 'skerry'` is a
 * PURCHASE: a private world somebody paid for, addressed by a uuid that, since micro-org#332, is
 * handed to the buyer's browser and from there goes into a URL, a screenshot, a support ticket and
 * a referrer header. Until that route existed the id was obtainable nowhere, so "private by
 * unguessable id" survived by accident; the fix that made the feature usable is what made this
 * reachable (micro-org#341, 2026-08-10).
 *
 * ## Why this is a predicate and not an owner check
 *
 * `erasure.ts` records the reason a skerry's owner is ANONYMISED rather than nulled: *"a skerry is
 * a PAID private world that may hold other players' cities … plus the rights of the guests."* A
 * guest's city stands on one of these islands, their fleets fly these lanes, and a plain owner-only
 * gate would leave them holding a city on a world they cannot see the shape of. So standing is
 * DERIVED from where a subject actually is, and the tests assert the derivation rather than a list
 * of ids.
 *
 * An abandoned city still counts. Abandonment is phase 2 — nothing in the surface can set
 * `abandoned_at` today except an erasure, which rewrites `user_id` to the placeholder and so falls
 * out of this query anyway. Excluding it would add a branch no test could reach honestly, and a
 * guest who left still has battles and a chronicle entry on that world.
 *
 * ## Absent and refused are the same answer
 *
 * Callers turn `false` into the SAME 404 they return for an id that does not exist. A 403 would
 * confirm that a stranger's uuid names a real world, which is the one bit an unguessable id is
 * supposed to withhold.
 */

import { isAdmin, type Principal } from '@cloudsforge/auth';
import type { Db, Tx } from './outbox.ts';

/**
 * May this principal read this archipelago?
 *
 * False for an id that does not exist, so a caller needs one query and not two.
 *
 * **A service passes on scope alone, and that is deliberate.** Every other `:id` read in this
 * service does the same — `GET /v1/cities/:id` and `GET /v1/battles/:id` let a service holding
 * `aetherholm:read` read any row, because a service token is the estate rendering on somebody's
 * behalf and it has no user to be. The scope check itself stays at the route, which is where a
 * refusal can name the scope it wanted.
 */
export async function archipelagoVisibleTo(
  sql: Db | Tx,
  archipelagoId: string,
  principal: Principal,
): Promise<boolean> {
  const rows = await sql<{ kind: string; owner_subject: string | null }[]>`
    select kind, owner_subject from archipelagos where id = ${archipelagoId}
  `;
  const archipelago = rows[0];
  if (!archipelago) return false;

  // The season world. `archipelagos_ownership_coherent` guarantees it has no owner at all, so
  // there is nothing here to scope: this is the branch that keeps the game a game.
  if (archipelago.kind !== 'skerry') return true;

  if (principal.kind === 'service') return true;
  if (isAdmin(principal)) return true;

  // The LEDGER spelling, `user:<uuid>` — the predicate `erasure.ts` anonymises by and
  // `listArchipelagosOwnedBy` lists by, so all three agree about what ownership is. After an
  // erasure the column reads `erased:<uuid>` and stops matching anybody, which is correct: the
  // world survives for its guests and its former owner is no longer a subject of it.
  if (archipelago.owner_subject === `user:${principal.userId}`) return true;

  const guest = await sql<{ standing: number }[]>`
    select 1 as standing
      from cities c
      join islands i on i.id = c.island_id
     where i.archipelago_id = ${archipelagoId}
       and c.user_id = ${principal.userId}
     limit 1
  `;
  return guest.length > 0;
}
