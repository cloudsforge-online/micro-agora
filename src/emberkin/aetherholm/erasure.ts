/**
 * Right to erasure — `identity.user.deleted`, handled.
 *
 * Rule 6 of docs/ecosystem/03 §2: every service storing a `user_id` subscribes to this event and
 * erases. This service stores one in nine places and stored NONE of them on request until now: a
 * deletion reported success and left every city, fleet, battle and alliance membership standing.
 *
 * ## The shape of the problem, which is what shapes the answer
 *
 * `battles → fleets → cities` is a chain of `not null` foreign keys with no cascade. A battle pins
 * its fleet; the fleet pins its origin city. And a battle is TWO-SIDED: the other commander is a
 * living person who fought that fight and has their own right to a coherent record of it. So
 * "delete everything" is not available — it would either fail on a foreign key or destroy somebody
 * else's history — and "keep everything, blank the names" is not compliance. Each table gets a
 * decision, and the decision is written down here rather than in a document that can drift away
 * from the code.
 *
 * ## The placeholder
 *
 * ONE random uuid per erasure, from `randomUUID()`, never derived from the real id. A hash of a
 * uuid is not an anonymisation: the candidate space is whatever list of users an attacker already
 * has, and checking it is one hash each. Nothing anywhere stores the mapping, so the placeholder
 * is a dead end by construction.
 *
 * It is REUSED across every row this erasure retains, and that is a deliberate, declared tradeoff.
 * The retained rows stay linked to one another — an observer can still see "these three battles
 * were fought by the same, unknown person". That is unavoidable the moment anything is retained at
 * all, and it is also required: `cities_one_per_player_per_island` and
 * `alliance_members_one_per_world` are unique on `(…, user_id)`, so a fresh placeholder per row
 * would be an anonymisation that quietly changes which worlds are representable. The alternative —
 * a distinct placeholder per row — buys unlinkability the retained rows cannot honestly claim
 * anyway, because their island, their timestamps and their orders of battle link them regardless.
 *
 * `archipelagos.owner_subject` and `provisions` carry the ledger spelling, so they take
 * `erased:<the same uuid>`; every bare-`uuid` column takes the uuid itself. The conversion happens
 * once, at the top of `eraseUser`, and each statement below says which spelling it is writing.
 *
 * ## The decisions
 *
 * | table                       | action    | reasoning, and the lawful basis where a row is kept |
 * | --------------------------- | --------- | --------------------------------------------------- |
 * | `research`                  | DELETE    | Pure personal progress: which nodes this person unlocked. Nothing references it, nothing else is diminished by its going, and no basis to keep it survives the request. Deleted. |
 * | `alliance_members`          | DELETE    | The judgement call. An alliance is a group and continues without a departed member; the membership ROW is a fact about an individual — "this person flew that banner" — and is not needed by the alliance to exist, by anyone else to read their own history, or by any legal obligation. There is no Art. 17(3) exemption for "the group would like to remember you", so it goes. The alliance's own rows are untouched. |
 * | `alliances.founded_by`      | ANONYMISE | The alliance survives its founder. Deleting the row would destroy a live group — its claims, its members, its name — for everyone still in it. Basis: Art. 17(3)(e)/rights and freedoms of others. Only the founder's id goes. |
 * | `alliance_claims.claimed_by`| ANONYMISE | A claim is the ALLIANCE's stake in the lattice; the individual who planted the banner is incidental to it, and dropping the claim would hand an island back for reasons no other member can see. Same basis, same narrow redaction. |
 * | `battles` (both ids)        | ANONYMISE | Retained: the opposing commander has a right to a coherent record of a battle they fought, and `battles_fleet_uniq`/the digest make it a load-bearing piece of the season's history. Basis: Art. 17(3)(e). Only `attacker_user_id`/`defender_user_id` are personal data — `attacker_oob`, `defender_oob` and `result` are ship counts, volley damages and outcomes with no id and no player-chosen name in them (src/battles.ts `OrderOfBattle`/`BattleResult`), and `digest` is taken over the seed, the two orders of battle and the result — NEVER over a user id (src/battles.ts `battleDigest`). So the digest survives the redaction intact, and migration 14's trigger enforces exactly that. |
 * | `fleets` (battled)          | ANONYMISE | Retained because a battle references it `not null`; deleting it would delete the other commander's battle with it. Basis: Art. 17(3)(e), inherited from the battle it belongs to. |
 * | `fleets` (unbattled)        | DELETE    | Nothing depends on it, and one still in flight belongs to a player who no longer exists and would otherwise arrive and attack somebody. `fleet_ships` goes with it by cascade. |
 * | `cities` (fleet-pinned)     | ANONYMISE | Retained only because a retained fleet — this person's, or another player's inbound one — references it `not null`. `user_id` to the placeholder; `name` to a neutral constant, because the player CHOSE that string and a chosen string carries whatever the player put in it; and `abandoned_at` set, so the plot frees and the world does not keep a phantom active settlement flying nobody's flag. |
 * | `cities` (unpinned)         | DELETE    | The ordinary case. `buildings`, `queue_items` and `city_ships` go with it by cascade. |
 * | `archipelagos.owner_subject`| ANONYMISE | A skerry is a PAID private world that may hold other players' cities, and `archipelagos_ownership_coherent` forbids nulling the owner of one — the row cannot be emptied, only rewritten. `name` goes back to the schema's own default too, because it is free text the buyer wrote. Basis: Art. 17(3)(b), the purchase record, plus the rights of the guests. |
 * | `provisions`                | ANONYMISE | The entitlement idempotency record: worlds' conformance check 5 is "provisioning twice returns the SAME urn", and losing this row turns one purchase into two worlds. `subject` and `user_id` to the erased spelling and `metadata` swept for the id; the urn, the sku and the entitlement stay. Basis: Art. 17(3)(b). |
 * | `chronicles`                | REDACT    | A sealed season's `summary` embeds real user ids (src/sealing.ts: the spire holder and every member the heraldry reached) and the table is frozen by trigger, so the schema made the removal impossible. Resolved in migration 14 rather than waived: the trigger now admits one narrow, flagged, auditable rewrite; the ids inside `summary` become the placeholder while the alliance names, spire counts and rankings — not personal data about this person — stay; `digest` is recomputed so the row is self-consistent, and `digest_at_sealing`/`erasures_applied` preserve what it used to hash to so the redaction is VISIBLE rather than silent. |
 * | `outbox`                    | REDACT    | The outbound delivery journal. Published rows have discharged their purpose but are retained as an audit trail, and unpublished ones must still be delivered — so the id is swept out of `key`, `actor` and `payload` in place rather than the rows being dropped, which would lose an undelivered event. Every subscriber is erasing the same person on the same signal. |
 * | `inbox`, `jobs`             | —         | Neither holds a user id: the inbox is `(topic, event_id)` and every job payload keys on a city, fleet, island or season. Asserted, not assumed — `erasure.test.ts` sweeps every table in the schema for the raw uuid, which is the check that catches the column this table forgot. |
 * | `seasons`                   | —         | No user id, and `seasons_sealed_immutable` is deliberately NOT weakened. A season is geography and a clock. |
 *
 * ## The transaction-local flag
 *
 * `battles` and `chronicles` are unlocked by `set_config('aetherholm.erasure', 'on', true)` — the
 * third argument is `is_local`, so the permission dies with the transaction and cannot leak into
 * the next statement on a pooled connection. It is set in exactly one place, three lines below,
 * which makes "who is allowed to rewrite history" a grep rather than a review. Both triggers still
 * check WHAT changed, so the flag is a key to a narrow door and not to the building.
 */

import { createHash, randomUUID } from 'node:crypto';
import { canonicalise } from './battles.ts';
import type { Tx } from './outbox.ts';

/** The estate-wide erasure signal. Registered in `contracts/packages/events`. */
export const USER_DELETED_TOPIC = 'identity.user.deleted';

/**
 * The name an erased city takes.
 *
 * Neutral and constant: a player-chosen name is free text, so it can carry a real name, a handle
 * or an insult, and none of those may outlive the person who asked to be forgotten.
 */
export const ERASED_CITY_NAME = 'Abandoned Holdfast';

/** What an unnamed skerry is called anyway — so an erased one is not a special kind of world. */
export const ERASED_SKERRY_NAME = 'Private Skerry';

/** Counts only. Every field is a number: this record is logged, and personal data is not. */
export interface ErasureOutcome {
  readonly researchDeleted: number;
  readonly membershipsDeleted: number;
  readonly alliancesAnonymised: number;
  readonly claimsAnonymised: number;
  readonly battlesAnonymised: number;
  readonly fleetsDeleted: number;
  readonly fleetsAnonymised: number;
  readonly citiesDeleted: number;
  readonly citiesAnonymised: number;
  readonly archipelagosAnonymised: number;
  readonly provisionsAnonymised: number;
  readonly chroniclesRedacted: number;
  readonly outboxRedacted: number;
}

/**
 * Erase one user, inside the caller's transaction.
 *
 * A `Tx` and not a `Db`, deliberately: the whole erasure is one atomic act, the inbox row that
 * makes it exactly-once is written in the same transaction (`withInbox`), and the flag that
 * unlocks `battles` and `chronicles` is transaction-local and therefore meaningless outside one.
 *
 * Idempotent beyond the inbox as well: every statement selects on the REAL id, which no longer
 * appears anywhere once the first pass has committed, so a second pass over the same user is a
 * sequence of no-ops rather than a second, differently-placeheld erasure.
 */
export async function eraseUser(tx: Tx, userId: string, now = new Date()): Promise<ErasureOutcome> {
  // The one place history is unlocked. Transaction-local, so it cannot outlive this handler.
  await tx`select set_config('aetherholm.erasure', 'on', true)`;

  // One random placeholder for the whole erasure, in both spellings this schema uses. Random and
  // not derived: see the header. `subject` is the ledger spelling — `user:<uuid>` becomes
  // `erased:<uuid>`, which migration 14's CHECK pins exactly so the two are never confusable.
  const placeholder = randomUUID();
  const erasedSubject = `erased:${placeholder}`;
  const anywhere = `%${userId}%`;

  /* ---------------------------------------------------------------- personal progress */

  const research = await tx`delete from research where user_id = ${userId} returning node`;
  const memberships = await tx`
    delete from alliance_members where user_id = ${userId} returning alliance_id
  `;

  /* ---------------------------------------------------------------- the group's own rows */

  const alliances = await tx`
    update alliances
       set founded_by = ${placeholder}, founder_erased_at = ${now}
     where founded_by = ${userId} and founder_erased_at is null
    returning id
  `;
  const claims = await tx`
    update alliance_claims
       set claimed_by = ${placeholder}, claimer_erased_at = ${now}
     where claimed_by = ${userId} and claimer_erased_at is null
    returning island_id
  `;

  /* ---------------------------------------------------------------- history */

  // Two statements, not one: a battle between two people who are both erased is redacted twice,
  // and the per-side markers are what let the second redaction happen without looking like a
  // re-attribution of the first.
  const attacked = await tx<{ id: string }[]>`
    update battles
       set attacker_user_id = ${placeholder}, attacker_erased_at = ${now}
     where attacker_user_id = ${userId} and attacker_erased_at is null
    returning id
  `;
  const defended = await tx<{ id: string }[]>`
    update battles
       set defender_user_id = ${placeholder}, defender_erased_at = ${now}
     where defender_user_id = ${userId} and defender_erased_at is null
    returning id
  `;
  // A person can be on both sides of the same war but not of the same battle; the set is here
  // because the count must not report one redacted battle as two.
  const battleIds = new Set([...attacked, ...defended].map((row) => row.id));

  /* ---------------------------------------------------------------- fleets, then cities */

  // Order matters, and it is the foreign keys that order it: an unbattled fleet must go before
  // the city it originates from can be considered for deletion, because `fleets.origin_city_id`
  // is `not null` with no cascade and would otherwise refuse.
  const fleetsGone = await tx`
    delete from fleets
     where user_id = ${userId}
       and not exists (select 1 from battles b where b.fleet_id = fleets.id)
    returning id
  `;
  const fleetsKept = await tx`
    update fleets
       set user_id = ${placeholder}, user_erased_at = ${now}
     where user_id = ${userId} and user_erased_at is null
    returning id
  `;

  // A city is kept only while something `not null` still points at it: one of this person's
  // retained fleets originates there, or — the case the referential chain hides — ANOTHER
  // player's fleet is inbound to it and `fleets.target_city_id` would refuse the delete.
  const citiesGone = await tx`
    delete from cities
     where user_id = ${userId}
       and not exists (select 1 from fleets f where f.origin_city_id = cities.id)
       and not exists (select 1 from fleets f where f.target_city_id = cities.id)
    returning id
  `;
  // `abandoned_at` is coalesced rather than overwritten: a city razed in a siege was abandoned
  // then, and erasure does not get to restate when. Setting it also drops the row out of
  // `cities_one_per_player_per_island` and `cities_one_per_plot`, both of which are partial on
  // `abandoned_at is null` — so this write frees the plot and can collide with nothing.
  const citiesKept = await tx`
    update cities
       set user_id = ${placeholder},
           name = ${ERASED_CITY_NAME},
           abandoned_at = coalesce(abandoned_at, ${now}),
           user_erased_at = ${now}
     where user_id = ${userId} and user_erased_at is null
    returning id
  `;

  /* ---------------------------------------------------------------- what was bought */

  // The ledger spelling, and the only place the two spellings meet. `name` goes back to the
  // schema's default because the buyer chose it; the seed, the islands and the entitlement stay,
  // because the guests' worlds are built on them.
  const archipelagos = await tx`
    update archipelagos
       set owner_subject = ${erasedSubject}, name = ${ERASED_SKERRY_NAME}
     where owner_subject = ${'user:' + userId}
    returning id
  `;
  // `provisions.user_id` is declared `text`, not `uuid`, and holds a bare uuid; `subject` holds
  // `user:<uuid>`. Both take the erased spelling, so the row stays legible as a purchase record
  // whose buyer has been forgotten. `metadata` is caller-supplied and swept textually — it is
  // free-form by contract, so the id can be anywhere in it or nowhere.
  const provisions = await tx`
    update provisions
       set subject = ${erasedSubject},
           user_id = ${erasedSubject},
           metadata = replace(metadata::text, ${userId}, ${placeholder})::jsonb
     where user_id = ${userId} or subject = ${'user:' + userId} or subject = ${userId}
    returning id
  `;

  /* ---------------------------------------------------------------- sealed history */

  const chroniclesRedacted = await redactChronicles(tx, userId, placeholder);

  /* ---------------------------------------------------------------- the delivery journal */

  // Swept, not dropped: an unpublished row still has to be delivered, and dropping it would lose
  // an event. `replace` over the whole jsonb rather than a path-by-path rewrite, because the
  // payload shapes differ per topic and the id travels in arrays as well as scalars — a uuid is
  // 36 characters of hex and hyphens, so a substring match on one cannot be a false positive.
  const outboxRedacted = await tx`
    update outbox
       set key = replace(key, ${userId}, ${placeholder}),
           actor = replace(actor, ${userId}, ${placeholder}),
           payload = replace(payload::text, ${userId}, ${placeholder})::jsonb
     where key like ${anywhere} or actor like ${anywhere} or payload::text like ${anywhere}
    returning id
  `;

  return {
    researchDeleted: research.length,
    membershipsDeleted: memberships.length,
    alliancesAnonymised: alliances.length,
    claimsAnonymised: claims.length,
    battlesAnonymised: battleIds.size,
    fleetsDeleted: fleetsGone.length,
    fleetsAnonymised: fleetsKept.length,
    citiesDeleted: citiesGone.length,
    citiesAnonymised: citiesKept.length,
    archipelagosAnonymised: archipelagos.length,
    provisionsAnonymised: provisions.length,
    chroniclesRedacted,
    outboxRedacted: outboxRedacted.length,
  };
}

/**
 * Redact the user ids out of every sealed chronicle that names them, and re-hash.
 *
 * Done in TypeScript rather than in SQL for one reason that matters: the digest must be computed
 * by the SAME `canonicalise` that `sealing.ts` used to compute it in the first place. Recomputing
 * over an untouched summary here reproduces the stored digest exactly — `erasure.test.ts` asserts
 * that — which is what makes the recomputed digest of a redacted summary meaningful rather than
 * merely well-formed.
 *
 * The replacement is textual over the serialised summary. The ids appear as a scalar
 * (`holder.userId`) and inside arrays (`memberUserIds`), at two nesting depths, in two places that
 * both duplicate each other (`spires` and `victors`) — walking that shape by hand is how a future
 * field gets missed, and a 36-character uuid cannot collide with anything else in the document.
 */
async function redactChronicles(tx: Tx, userId: string, placeholder: string): Promise<number> {
  const rows = await tx<
    {
      season_id: string;
      summary: Record<string, unknown>;
      digest: string;
      digest_at_sealing: string | null;
      erasures_applied: number;
    }[]
  >`
    select season_id, summary, digest, digest_at_sealing, erasures_applied
      from chronicles
     where summary::text like ${`%${userId}%`}
  `;

  for (const row of rows) {
    const redacted = JSON.parse(
      JSON.stringify(row.summary).replaceAll(userId, placeholder),
    ) as Record<string, unknown>;
    await tx`
      update chronicles
         set summary = ${tx.json(redacted as never)},
             digest = ${createHash('sha256').update(canonicalise(redacted)).digest('hex')},
             -- The first redaction adopts the born digest; later ones carry it forward. The
             -- trigger refuses any other value, so this is a statement of intent, not a guess.
             digest_at_sealing = ${row.digest_at_sealing ?? row.digest},
             erasures_applied = ${row.erasures_applied + 1}
       where season_id = ${row.season_id}
    `;
  }
  return rows.length;
}
