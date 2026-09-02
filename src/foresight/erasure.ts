/**
 * Right to erasure — `identity.user.deleted`, handled.
 *
 * Second of the six services micro-org#534 names, after `studio`. Foresight stores a person in
 * exactly ONE column, and that column is under a trigger that refused to let it change — see
 * migration 14, which is the reason this file could not simply be written.
 *
 * ## What foresight actually holds about a person, and what only looks like it
 *
 * `custodial_stakes.subject` is the whole of it: `user:<uuid>`, the estate's ledger spelling, on
 * the row recording that this person staked on an outcome through the custodial path.
 *
 * `positions.staker` is NOT a person and must not be erased. It is a **chain address**, mirrored
 * from on-chain stake events — the row carries `tx_hash`, `log_index`, `block_height` and
 * `block_hash`, because it IS the chain's own record read back. Erasing it would be neither
 * possible nor this service's to attempt: the address is public on Hearth whatever this database
 * says, and blanking the mirror would only break reconciliation against the chain while changing
 * nothing about what is knowable. A pseudonymous public identifier the estate did not choose and
 * cannot unpublish is a different thing from a subject the estate assigned.
 *
 * `ideas`, `markets` and `resolutions` carry a question, criteria and an outcome. No subject.
 * `lease_owner` on two tables is a worker instance, not a person.
 *
 * ## Why the stake is RETAINED and only narrowed
 *
 * The trigger's own message says it: a recorded stake is what a refund is paid from and what makes
 * the rate auditable. Deleting the row would mean an unrefundable stake and a market whose pool
 * arithmetic no longer adds up for everybody else who staked in it. Basis: Art. 17(3)(b), and the
 * rights of the other stakers under Art. 17(3)(e) — the pool is shared.
 *
 * Every column that says HOW MUCH stays frozen and the trigger still refuses to let any of them
 * move. What changes is WHO, once, one-way.
 *
 * ## The decisions
 *
 * | table                 | action    | reasoning, and the lawful basis where a row is kept |
 * | --------------------- | --------- | --------------------------------------------------- |
 * | `custodial_stakes`    | ANONYMISE | Retained: a refund is paid from it and the pool arithmetic is shared with every other staker in that market. `subject` to `erased:<uuid>`; `stake_amount`, `pool_amount`, both rates, the asset code, the outcome and the market are untouched and the trigger still enforces that. Basis: Art. 17(3)(b) and (e). |
 * | `positions`           | —         | `staker` is a chain address read back from Hearth, not a subject this estate assigned. See above. |
 * | `outbox`              | REDACT    | The outbound journal. Published rows are an audit trail and unpublished ones must still be delivered, so the subject is swept out of `key`, `actor` and `payload` in place rather than the rows being dropped. |
 * | `ideas`, `markets`, `market_transitions`, `market_deploy_attempts`, `resolutions`, `house_seeds`, `fee_reports`, `mirror_cursors`, `idempotency_keys` | — | No subject in any of them. Asserted rather than assumed — `erasure.test.ts` sweeps every base table in the schema for the raw uuid. |
 *
 * ## Both planes
 *
 * The caller sweeps every configured plane through `../erasureplanes.ts` (micro-org#474).
 */

import { randomUUID } from 'node:crypto'
import type { Tx } from './outbox.ts'

/** The estate-wide erasure signal. Registered in `contracts/packages/events`. */
export const USER_DELETED_TOPIC = 'identity.user.deleted'

/** Counts only. Every field is a number: this record is logged, and personal data is not. */
export interface ErasureOutcome {
  readonly stakes: number
  readonly outbox: number
}

/**
 * Erase one subject, inside the caller's transaction.
 *
 * `subject` and not a bare uuid: `custodial_stakes_subject_shape` pins the `user:<uuid>` spelling,
 * so a bare uuid would match nothing and answer a cheerful zero — the failure `nda` recorded, where
 * a deletion erased nobody and reported success.
 *
 * Idempotent beyond the inbox: the UPDATE selects on the REAL subject, which no longer appears once
 * the first pass has committed, so a second pass is a no-op. That is what makes replaying an old
 * event id safe, and replaying old event ids is how a plane that was never erased gets repaired.
 */
export async function eraseSubject(tx: Tx, subject: string): Promise<ErasureOutcome> {
  const placeholder = randomUUID()
  const erased = `erased:${placeholder}`
  const bare = subject.startsWith('user:') ? subject.slice('user:'.length) : subject
  const anywhere = `%${bare}%`

  // ONE column, and migration 14 is what permits this exact write and nothing else. Every money
  // column is absent from the SET clause deliberately: the trigger would refuse the statement
  // outright if one appeared, which is the property that makes this safe to run against a table
  // whose whole point is that it cannot be restated.
  const stakes = await tx`
    update custodial_stakes set subject = ${erased} where subject = ${subject} returning 1
  `

  // Swept, not dropped: an unpublished row still has to be delivered, and dropping it would lose
  // an event rather than anonymise it. The uuid is matched rather than the `user:` spelling,
  // because a payload may carry either.
  const outbox = await tx`
    update outbox
       set key     = replace(key, ${bare}, ${placeholder}),
           actor   = case when actor is null then null else replace(actor, ${bare}, ${placeholder}) end,
           payload = replace(payload::text, ${bare}, ${placeholder})::jsonb
     where key like ${anywhere} or actor like ${anywhere} or payload::text like ${anywhere}
    returning 1
  `

  return { stakes: stakes.length, outbox: outbox.length }
}
