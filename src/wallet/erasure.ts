/**
 * Right to erasure — `identity.user.deleted`, handled.
 *
 * Rule 6 of docs/ecosystem/03 §2: every service storing a `user_id` subscribes to this event and
 * erases. This module stores one in EIGHT tables and had no subscription, because micro-org#534
 * held the four money-holding services open on a question the register could not answer for
 * itself. The owner settled it on 2026-09-02: **everything is anonymised.**
 * `deploy/erasure/register.psv` carries the decision in full.
 *
 * ── WHY A WALLET CANNOT DELETE ──────────────────────────────────────────────────────────────────
 *
 * The same argument as `custody/src/erasure.ts`, one level up. A `wallets` row for a MANAGED
 * wallet is half of a key that controls money on a public chain, and the other half is the chain,
 * which nobody can edit. `deposit_address_assignments` is what makes an incoming payment
 * attributable at all; `deposit_credits` and `withdrawals` are the two sides of every movement this
 * service has ever booked, each carrying a `ledger_entry_id` that points at a posting the ledger is
 * obliged to keep. Delete any of them and the ledger holds entries whose cause no longer exists —
 * an audit trail with holes cut in it, which is worse than one that names nobody.
 *
 * So the identifiers go and the accounting stays. Afterwards nothing here says WHOSE any of it is.
 *
 * ── THE PLACEHOLDER IS A BARE UUID, BECAUSE EVERY COLUMN IS `uuid` ──────────────────────────────
 *
 * `erased:<uuid>` is the estate's spelling wherever a subject is text. Every `user_id` in this
 * schema is typed `uuid`, so the placeholder is the uuid itself and the prefix appears only where
 * the id is embedded in text. That is not a weaker anonymisation: the value is from
 * `randomUUID()`, never derived from the real id, and nothing anywhere stores the mapping. A HASH
 * of the id would have been weaker — the candidate space is whatever list of users an attacker
 * already has, and checking it is one hash each.
 *
 * ONE placeholder for the whole person, reused across all eight tables. Three would turn one
 * departed account into three while hiding nothing further: a deposit credit, its assignment and
 * its wallet are joined by `wallet_id` and `assignment_id` regardless of what the `user_id` column
 * says, so separating them would only produce an audit trail that no longer reconciles.
 *
 * ── THE DECISIONS ───────────────────────────────────────────────────────────────────────────────
 *
 * | table                            | action    | reasoning |
 * | -------------------------------- | --------- | --------- |
 * | `wallets`                        | ANONYMISE | The addresses. Managed ones are custody keys — see above. `label` is NULLED rather than rewritten: it is free text the person typed to name their own wallet, it has no accounting role, and neutralising it is what the register's rule asks for. `wallets_address_uniq (user_id, chain, network, address_key)` still holds under a unique placeholder. |
 * | `deposit_address_assignments`    | ANONYMISE | What makes an inbound payment attributable. `deposit_address_assignments_active_uniq` is partial on `(user_id, asset_code, network) where status = 'active'`, which a unique placeholder does not disturb. |
 * | `deposit_credits`                | ANONYMISE | One half of the money record, each row pointing at a ledger entry. Basis: Art. 17(3)(b). `credit_key` is chain-derived (`chain:network:txHash:logIndex`) and names nobody. |
 * | `withdrawals`                    | ANONYMISE | The other half. `destination_address` and `destination_key` are the person's own on-chain address; they stay, because they are also the only record of where the estate sent money, and the chain has published them anyway. `idempotency_key` is swept — see below. |
 * | `deposit_token_sightings`        | ANONYMISE | Unclaimed token arrivals at a person's deposit address. `sighting_key` is chain-derived. |
 * | `external_wallet_links`          | ANONYMISE | The person's self-custody address, linked by a signed statement. `signature` is NULLED: it is a proof produced by their own private key binding them to a message, which is an identifying artefact in a way the row's other columns are not. The link itself stays because `external_wallet_authorisations` cascades from it and a withdrawal may name it. |
 * | `link_challenges`                | ANONYMISE | `message` is NULLED for the same reason — a SIWE statement names the address, the domain and the person's intent verbatim. The nonce and the timestamps stay: they are the anti-replay record. |
 * | `idempotency_keys`               | ANONYMISE | **AND THE PRIMARY KEY, WHICH IS THE PART A READING WOULD MISS.** `namespacedKey` builds `<userId>:<route>:<clientKey>`, so the id is embedded verbatim in a text primary key, and `response` is a stored response body that may name the person anywhere inside it. |
 * | `outbox`                         | REDACT    | The outbound delivery journal. Rows are not dropped — an unpublished one still has to be delivered, and dropping it would lose the event rather than anonymise it. |
 * | `inbox`, `event_subscriptions`, `outbox_deliveries`, `platform_addresses`, `external_wallet_authorisations` | — | No user id. Asserted rather than assumed: `erasure.test.ts` sweeps every text and jsonb column in the schema for the raw uuid afterwards. |
 *
 * ── WHAT IS NOT DONE, AND IS RECORDED RATHER THAN PAPERED OVER ─────────────────────────────────
 *
 * Nothing settles a departing person's balance before the identifier goes, so a managed wallet may
 * still hold coins that are now attributable to nobody. That gap is `custody`'s and `pool`'s too.
 * A handler that refused the erasure until the balance was zero would be an erasure that never
 * completes, which is the failure this subscription exists to end.
 *
 * Wallet statuses are deliberately untouched, for the reason `custody/src/erasure.ts` gives at
 * length: retiring a deposit address does not stop deposits — the chain has never heard of this
 * database — it stops the estate MOVING what arrives. Anonymising strands the identity; retiring
 * would strand the money.
 */

import { randomUUID } from 'node:crypto'
import type { Tx } from './outbox.ts'

export const USER_DELETED_TOPIC = 'identity.user.deleted'

export interface ErasureOutcome {
  readonly wallets: number
  readonly assignments: number
  readonly credits: number
  readonly withdrawals: number
  readonly sightings: number
  readonly links: number
  readonly challenges: number
  readonly idempotency: number
  readonly outbox: number
}

/**
 * Anonymise one user, in one transaction.
 *
 * Counts are returned rather than logged here, and the caller logs the counts and never the id —
 * writing the erased id into a log would recreate, in the one store nothing erases, exactly what
 * the request was to remove.
 */
export async function eraseUser(tx: Tx, userId: string): Promise<ErasureOutcome> {
  const placeholder = randomUUID()
  // For the text and jsonb sweeps. The id is a uuid, so a substring match cannot catch a shorter
  // string by accident, and matching ANYWHERE is the point: a payload may nest it at any depth.
  const anywhere = `%${userId}%`

  const wallets = await tx`
    update wallets
       set user_id = ${placeholder},
           label   = null,
           updated_at = now()
     where user_id = ${userId}
    returning 1
  `

  const assignments = await tx`
    update deposit_address_assignments set user_id = ${placeholder} where user_id = ${userId} returning 1
  `

  const credits = await tx`
    update deposit_credits set user_id = ${placeholder} where user_id = ${userId} returning 1
  `

  // `idempotency_key` as well as `user_id`: `namespacedKey` embeds the id, and the SAME string was
  // sent to the ledger as the key its posting was written under. Rewriting it keeps the guard
  // working — the placeholder is unique, so the row still occupies one slot and no second
  // withdrawal can take it — and what is given up is that a retry of THIS withdrawal would no
  // longer dedupe against it, which cannot happen because the person has gone.
  const withdrawals = await tx`
    update withdrawals
       set user_id         = ${placeholder},
           idempotency_key = replace(idempotency_key, ${userId}, ${placeholder})
     where user_id = ${userId} or idempotency_key like ${anywhere}
    returning 1
  `

  const sightings = await tx`
    update deposit_token_sightings set user_id = ${placeholder} where user_id = ${userId} returning 1
  `

  const links = await tx`
    update external_wallet_links
       set user_id   = ${placeholder},
           signature = null
     where user_id = ${userId}
    returning 1
  `

  const challenges = await tx`
    update link_challenges
       set user_id = ${placeholder},
           message = ''
     where user_id = ${userId}
    returning 1
  `

  // The primary key too. See the table above — this is the column a reading of the schema misses.
  const idempotency = await tx`
    update idempotency_keys
       set key      = replace(key, ${userId}, ${placeholder}),
           user_id  = ${placeholder},
           response = case
             when response is null then null
             else replace(response::text, ${userId}, ${placeholder})::jsonb
           end
     where user_id = ${userId} or key like ${anywhere} or response::text like ${anywhere}
    returning 1
  `

  const outbox = await tx`
    update outbox
       set key     = replace(key, ${userId}, ${placeholder}),
           actor   = case when actor is null then null else replace(actor, ${userId}, ${placeholder}) end,
           payload = replace(payload::text, ${userId}, ${placeholder})::jsonb
     where key like ${anywhere} or actor like ${anywhere} or payload::text like ${anywhere}
    returning 1
  `

  return {
    wallets: wallets.length,
    assignments: assignments.length,
    credits: credits.length,
    withdrawals: withdrawals.length,
    sightings: sightings.length,
    links: links.length,
    challenges: challenges.length,
    idempotency: idempotency.length,
    outbox: outbox.length,
  }
}
