/**
 * Right to erasure — `identity.user.deleted`, handled at last.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS SERVICE WAS REGISTERED FOR ERASURE AND HAD NO HANDLER.**
 *
 * `deploy/erasure/register.psv` lists worlds as `mixed`,
 * `deploy/scripts/check-erasure-register.py` reported it `ok`, and micro-org#491 was closed as
 * fixed. Measured on mainnet 2026-09-02, after the subscription was repaired and 101 historical
 * erasures were replayed:
 *
 *     http://agora:4000/v1/events/worlds     101 delivered, 0 failed
 *     worlds.inbox                             0 rows
 *     worlds_testnet.inbox                     0 rows
 *
 * Every delivery succeeded and every one took the `202 {status: 'ignored'}` branch, because
 * `server.ts` knew two topics and this was not one of them. A register row is not a handler, and
 * nothing in the estate compared the two (micro-org#543).
 *
 * ## The shape of the problem
 *
 * Two things make this more than a `delete from … where user_id = $1`.
 *
 * **`reward_grants` is money that has already moved.** Each row names a `journal_entry_id` — a
 * posting in the ledger — and `seasons.rewards_granted_shards` is the running total of them, held
 * under `seasons_within_budget`. Deleting a grant would leave a ledger entry no longer reconciled
 * by anything and a season total that no longer matches its rows. So the row is retained and the
 * subject anonymised, Art. 17(3)(b), and the same argument `aetherholm/erasure.ts` makes for a
 * battle the other commander fought.
 *
 * **`provisions` is an idempotency record.** Worlds' own conformance check 5 is "provisioning
 * twice returns the SAME urn". Losing the row turns one purchase into two provisionings.
 *
 * ## The placeholder
 *
 * ONE random uuid per erasure, from `randomUUID()`, never derived from the real id — a hash of a
 * uuid is not an anonymisation when the candidate space is a list of users an attacker already
 * has. Nothing anywhere stores the mapping.
 *
 * Reused across every row this erasure retains, deliberately: `player_achievements` is keyed
 * `(user_id, achievement_id)` and `reward_grants_key_uniq` is on `idempotency_key`, so a fresh
 * placeholder per row would change which shapes are representable while buying an unlinkability
 * the retained rows cannot honestly claim anyway — their season, their timestamps and their
 * amounts link them regardless.
 *
 * `provisions.subject` carries the ledger spelling, so it takes `erased:<the same uuid>`; every
 * bare-`uuid` column takes the uuid itself. Each statement below says which spelling it writes.
 *
 * ## The decisions
 *
 * | table                  | action    | reasoning, and the lawful basis where a row is kept |
 * | ---------------------- | --------- | --------------------------------------------------- |
 * | `player_profiles`      | DELETE    | The account-scoped profile: a display name the player chose, an avatar, a reputation, equipped cosmetics, an age bracket and parental-control settings. All of it is personal data about one person, nothing else references it — no foreign key in this schema points at it — and no Art. 17(3) exemption covers "the game would like to remember you". Deleted outright, `sanctions` included: a sanction is a record about a person, and the person is gone. |
 * | `player_achievements`  | DELETE    | What one player unlocked. Pure personal progress; the `achievements` catalogue rows are untouched and nothing is diminished by these going. |
 * | `inventory_items`      | DELETE    | What they owned. Two cases and both go: an unlisted item belongs to nobody now, and a LISTED one must not stay on the market under a departed owner — a stranger buying from an account that no longer exists is a worse outcome than a withdrawn listing. `listing_urn` is a reference held by market, which expires its own listings on the same event (its register row is `NOT ERASING — expires listings only`). |
 * | `reward_grants`        | ANONYMISE | Retained. `journal_entry_id` names a ledger posting that HAPPENED, and `seasons.rewards_granted_shards` is the sum of these rows under a CHECK — deleting one would unreconcile a ledger entry and falsify a season's budget. Only `user_id` is personal data: `reason`, `amount_shards` and the two ids are facts about a payment. Basis: Art. 17(3)(b). |
 * | `provisions`           | ANONYMISE | The entitlement idempotency record, unique on `entitlement_id`. Losing it turns one purchase into two provisionings — conformance check 5. `subject` takes the erased spelling and `metadata` is swept textually because it is free-form by contract, so the id can be anywhere in it or nowhere. `sku`, `scope` and `provisioned_urn` stay. Basis: Art. 17(3)(b). |
 * | `outbox`               | REDACT    | The outbound delivery journal. `worlds.profile.updated` is keyed `player:<uuid>` and carries `userId` in its payload. Published rows are an audit trail and unpublished ones must still be delivered, so the id is swept out of `key`, `actor` and `payload` IN PLACE rather than the rows being dropped — dropping an unpublished row loses an event, and every subscriber is erasing the same person on the same signal anyway. |
 * | `seasons`, `titles`, `achievements` | — | No user id. A season is a clock and a budget; a title and an achievement are catalogue. |
 * | `inbox`, `outbox_deliveries`, `event_subscriptions` | — | No user id. `erasure.test.ts` sweeps every table in `TABLES` for the raw uuid, which is the check that catches the column this comment forgot. |
 *
 * ## Both planes
 *
 * The caller sweeps every configured plane through `eraseEveryPlane` (`../erasureplanes.ts`). This
 * service is being given its handler on the day the estate learned that a one-plane erasure is
 * half an erasure, so it gets the two-plane version from its first line rather than becoming the
 * next service to be repaired.
 */

import { randomUUID } from 'node:crypto'
import type { Tx } from './outbox.ts'

/** The estate-wide erasure signal. Registered in `contracts/packages/events`. */
export const USER_DELETED_TOPIC = 'identity.user.deleted'

/** Counts only. Every field is a number: this record is logged, and personal data is not. */
export interface ErasureOutcome {
  readonly profilesDeleted: number
  readonly achievementsDeleted: number
  readonly inventoryDeleted: number
  readonly grantsAnonymised: number
  readonly provisionsAnonymised: number
  readonly outboxRedacted: number
}

/**
 * Erase one user, inside the caller's transaction.
 *
 * A `Tx` and not a `Db`: the whole erasure is one atomic act and the inbox row that makes it
 * exactly-once is written in the same transaction by `withInbox`.
 *
 * Idempotent beyond the inbox as well. Every statement selects on the REAL id, which no longer
 * appears anywhere once the first pass has committed, so a second pass over the same user is a
 * sequence of no-ops rather than a second, differently-placeheld erasure. That property is what
 * makes replaying an old event id safe, and replaying old event ids is how the planes that were
 * never erased get repaired (micro-org#474).
 */
export async function eraseUser(tx: Tx, userId: string): Promise<ErasureOutcome> {
  // One random placeholder for the whole erasure, in both spellings this schema uses. Random and
  // not derived: see the header. `subject` is the ledger spelling — `user:<uuid>` becomes
  // `erased:<uuid>`, the same convention aetherholm and tessera pin with a CHECK.
  const placeholder = randomUUID()
  const erasedSubject = `erased:${placeholder}`
  const anywhere = `%${userId}%`

  /* ---------------------------------------------------------------- what is purely theirs */

  const profiles = await tx`delete from player_profiles where user_id = ${userId} returning user_id`
  const achievements = await tx`
    delete from player_achievements where user_id = ${userId} returning achievement_id
  `
  // Listed items go with the rest. A listing left standing under a departed owner is a stranger
  // buying from an account that does not exist; market withdraws its own side on the same event.
  const inventory = await tx`delete from inventory_items where user_id = ${userId} returning id`

  /* ---------------------------------------------------------------- what the ledger reconciles */

  // NOT deleted. `journal_entry_id` names a posting that happened and `seasons_within_budget`
  // holds the sum of these rows; removing one would unreconcile the ledger and falsify a budget.
  const grants = await tx`
    update reward_grants set user_id = ${placeholder}
     where user_id = ${userId}
    returning id
  `

  /* ---------------------------------------------------------------- what was bought */

  // `metadata` is caller-supplied and swept textually — free-form by contract, so the id can be
  // anywhere in it or nowhere. A uuid is 36 characters of hex and hyphens, so a substring match
  // on one cannot be a false positive.
  const provisions = await tx`
    update provisions
       set subject = ${erasedSubject},
           metadata = replace(metadata::text, ${userId}, ${placeholder})::jsonb,
           updated_at = now()
     where subject = ${'user:' + userId} or subject = ${userId}
    returning id
  `

  /* ---------------------------------------------------------------- the delivery journal */

  // Swept, not dropped: an unpublished row still has to be delivered, and dropping it would lose
  // an event. `replace` over the whole jsonb rather than a path-by-path rewrite, because payload
  // shapes differ per topic and the id travels in arrays as well as scalars.
  const outbox = await tx`
    update outbox
       set key = replace(key, ${userId}, ${placeholder}),
           actor = replace(actor, ${userId}, ${placeholder}),
           payload = replace(payload::text, ${userId}, ${placeholder})::jsonb
     where key like ${anywhere} or actor like ${anywhere} or payload::text like ${anywhere}
    returning id
  `

  return {
    profilesDeleted: profiles.length,
    achievementsDeleted: achievements.length,
    inventoryDeleted: inventory.length,
    grantsAnonymised: grants.length,
    provisionsAnonymised: provisions.length,
    outboxRedacted: outbox.length,
  }
}
