/**
 * Right to erasure — `identity.user.deleted`, handled.
 *
 * Rule 6 of docs/ecosystem/03 §2: every service storing a reference to a person subscribes to this
 * event and erases. Studio stores one in four places and stored NONE of them on request until now
 * (micro-org#534). It was one of six services `check-erasure-register.py` had been failing on
 * continuously — the check was right the whole time and nobody acted on it.
 *
 * ## Why studio was the one to do first
 *
 * micro-org#534's own reading, and it holds up: of the six, five are financial or custodial and
 * for those RETENTION is very likely the right answer, which is a decision to write down rather
 * than code to write quickly. Studio is the one with no financial basis to weigh — what it holds
 * is a person's brand kits, the images generated from them, and a spending cap.
 *
 * ## The one thing here that is genuinely money-adjacent
 *
 * `credit_accounts` is a SPENDING CAP, not a balance. `cap_usd_micros` is what an operator allowed
 * this subject to spend on image generation, `spent_usd_micros` is what they used, and neither is
 * a claim on anything — nobody is owed the unspent remainder and no ledger entry references the
 * row. It is deleted with everything else, and that is the difference between this service and
 * `billing`, where the equivalent row IS a claim.
 *
 * ## The placeholder, and why there is only one use for it
 *
 * ONE random uuid per erasure, from `randomUUID()`, never derived from the real subject: a hash of
 * a subject is not an anonymisation when the candidate space is a list of users an attacker
 * already has. Only `outbox` uses it — everything else is deleted outright, so studio has no
 * retained row for the placeholder to identify. That is the honest shape of a service that holds
 * nothing anybody is obliged to keep.
 *
 * ## The decisions
 *
 * | table              | action  | reasoning, and the lawful basis where a row is kept |
 * | ------------------ | ------- | --------------------------------------------------- |
 * | `brand_kits`       | DELETE  | A palette, a typography choice, an accent colour and a `style_prompt` this person wrote. `brand_kits_owner_name_uniq` is on `(owner_subject, name)`, so deleting frees the name for anybody else — which is what should happen. `generation_jobs` and `assets` cascade from it where they were generated. |
 * | `generation_jobs`  | DELETE  | Every job carries the `prompt` the person typed. A prompt is free text about a person's intentions and there is no basis to keep one; `cost_actual_usd_micros` is an operating cost the estate has already paid and is not a record it is obliged to hold against the individual. Deleted by cascade where a brand kit owned it, and explicitly where `owner_subject` stands alone. |
 * | `assets`           | DELETE  | The generated images and the uploads. `owner_subject` is nullable — migration 12 back-filled it from the job — so the delete is `owner_subject = $1` and NOT a cascade alone, or an upload with no job would survive. `storage_url` and `checksum` name a file under `STUDIO_ASSET_ROOT`; the row goes here and the blob is swept by the same job that reaps orphans, because a handler that deletes files inside a database transaction cannot roll back. |
 * | `credit_accounts`  | DELETE  | The spending cap. Not a balance, not a claim, not referenced by any ledger entry — see above. |
 * | `outbox`           | REDACT  | The outbound delivery journal. Published rows are an audit trail and unpublished ones must still be delivered, so the subject is swept out of `key`, `actor` and `payload` IN PLACE rather than the rows being dropped — dropping an unpublished row loses an event, and every subscriber is erasing the same person on the same signal. |
 * | `outbox_deliveries`, `event_subscriptions` | — | A delivery row is `(event_id, subscription_id)` and a subscription is a URL. No subject in either. |
 * | `inbox`, `jobs`    | —       | The inbox is `(topic, event_id)`. Job payloads key on a generation job or an asset, never on a subject. Asserted rather than assumed — `erasure.test.ts` sweeps every base table in the schema for the raw subject, which is the check that catches the column a future migration adds. |
 *
 * ## Both planes
 *
 * The caller sweeps every configured plane through `../erasureplanes.ts`. `identity`'s relay sends
 * no `CF-Network`, so a handler run on the request's handle reaches one of the two databases this
 * module holds — which is what left every testnet erasure undone between 2026-08-19 and
 * 2026-09-02 (micro-org#474). Studio gets the two-plane version from its first line.
 */

import { randomUUID } from 'node:crypto'
import type { Tx } from './outbox.ts'

/** The estate-wide erasure signal. Registered in `contracts/packages/events`. */
export const USER_DELETED_TOPIC = 'identity.user.deleted'

/** Counts only. Every field is a number: this record is logged, and personal data is not. */
export interface ErasureOutcome {
  readonly brandKits: number
  readonly jobs: number
  readonly assets: number
  readonly creditAccounts: number
  readonly outbox: number
}

/**
 * Erase one subject, inside the caller's transaction.
 *
 * `subject` and not a bare uuid: every column here is `owner_subject`, which carries the ledger
 * spelling `user:<uuid>`. Passing the bare form would match nothing and answer a cheerful zero,
 * which is the failure `nda` made and recorded — a deletion that erases nobody and reports success.
 *
 * Idempotent beyond the inbox: every statement selects on the REAL subject, which no longer appears
 * anywhere once the first pass has committed, so a second pass is a sequence of no-ops. That is
 * what makes replaying an old event id safe, and replaying old event ids is how a plane that was
 * never erased gets repaired (micro-org#474).
 */
export async function eraseSubject(tx: Tx, subject: string): Promise<ErasureOutcome> {
  const placeholder = randomUUID()
  // The raw uuid, for the text and jsonb sweeps below. `subject` is `user:<uuid>` and an outbox
  // payload may carry either spelling, so the sweep matches the uuid itself and catches both.
  const bare = subject.startsWith('user:') ? subject.slice('user:'.length) : subject
  const anywhere = `%${bare}%`

  /* ---------------------------------------------------------------- deleted outright */

  // ORDER IS NOT LOAD-BEARING between these four — `assets` and `generation_jobs` cascade from
  // `brand_kits`, and a row already gone is a delete that returns nothing rather than an error.
  // The explicit `owner_subject` predicates are what catch the rows a cascade does not reach: an
  // UPLOAD has no `generation_job_id` and no `brand_kit_id` (migration 12 made both nullable), so
  // it is reachable only by its own owner column.
  const brandKits = await tx`delete from brand_kits where owner_subject = ${subject} returning 1`
  const jobs = await tx`delete from generation_jobs where owner_subject = ${subject} returning 1`
  const assets = await tx`delete from assets where owner_subject = ${subject} returning 1`
  const creditAccounts = await tx`
    delete from credit_accounts where owner_subject = ${subject} returning 1
  `

  /* ---------------------------------------------------------------- redacted in place */

  const outbox = await tx`
    update outbox
       set key     = replace(key, ${bare}, ${placeholder}),
           actor   = case when actor is null then null else replace(actor, ${bare}, ${placeholder}) end,
           payload = replace(payload::text, ${bare}, ${placeholder})::jsonb
     where key like ${anywhere} or actor like ${anywhere} or payload::text like ${anywhere}
    returning 1
  `

  return {
    brandKits: brandKits.length,
    jobs: jobs.length,
    assets: assets.length,
    creditAccounts: creditAccounts.length,
    outbox: outbox.length,
  }
}
