/**
 * Right to erasure — the handler for `identity.user.deleted`.
 *
 * Rule 6 of docs/ecosystem/03 §2: every service storing a `user_id` subscribes to this topic and
 * erases. This service stored one in four places and honoured none of them, so a deletion request
 * answered "done" and left every save, battle, achievement and grant exactly where it was.
 *
 * Everything below runs in the ONE transaction `withInbox` opens, so the erasure and the inbox row
 * that says it happened commit together: a crash half-way leaves no inbox row and the redelivery
 * erases properly, rather than a half-erased account nobody will ever look at again.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * | table                 | action                | reasoning + lawful basis if retained          |
 * |-----------------------|-----------------------|-----------------------------------------------|
 * | `saves`               | DELETE                | A single-player campaign save — warden name,  |
 * |                       |                       | party, box, inventory, dex, playtime. Personal|
 * |                       |                       | data with no retention basis once the account |
 * |                       |                       | is gone: it is not a financial record, nobody |
 * |                       |                       | else has a right to it, and no obligation      |
 * |                       |                       | requires it. Art. 17(1)(a).                   |
 * | `battles`             | DELETE (by cascade)   | `user_id` references `saves` `on delete        |
 * |                       |                       | cascade` (migrations.ts), so the campaign |
 * |                       |                       | history goes with the save. VERIFIED, not     |
 * |                       |                       | assumed: the delete below re-runs against     |
 * |                       |                       | `battles` afterwards and reports what it      |
 * |                       |                       | found, so a future migration that drops the   |
 * |                       |                       | cascade cannot silently start retaining them. |
 * | `player_achievements` | DELETE                | Personal progress. Undelivered rows           |
 * |                       |                       | (`delivered_at is null`) simply never deliver,|
 * |                       |                       | which is the correct outcome — see the note   |
 * |                       |                       | on the sweep below. Art. 17(1)(a).            |
 * | `reward_grants`       | ANONYMISE, ROW KEPT   | **Art. 17(3)(b), legal obligation.** This is  |
 * |                       |                       | the local record of a LEDGER POSTING: real    |
 * |                       |                       | money moved, `journal_entry_id` names the     |
 * |                       |                       | entry that moved it, and the sum of these     |
 * |                       |                       | rows is what `seasons.rewards_granted_wei`    |
 * |                       |                       | must continue to reconcile against. Deleting  |
 * |                       |                       | the row would silently break that             |
 * |                       |                       | reconciliation — the season would report      |
 * |                       |                       | spend with nothing to account for it — and    |
 * |                       |                       | would destroy accounting records the estate   |
 * |                       |                       | is required to keep. So `user_id` becomes a   |
 * |                       |                       | random uuid, `idempotency_key` is rewritten   |
 * |                       |                       | (it embedded the id in plain text — see       |
 * |                       |                       | below), `user_erased_at` is stamped, and      |
 * |                       |                       | `amount_wei`, `journal_entry_id`,             |
 * |                       |                       | `season_id` and `granted_at` are untouched.   |
 * |                       |                       | `reason` is kept: it names the ENTITLEMENT    |
 * |                       |                       | that triggered the payment, which is what the |
 * |                       |                       | payment was for, and an accounting record     |
 * |                       |                       | with the amount but not the cause is not a    |
 * |                       |                       | record. It is a billing identifier, not this  |
 * |                       |                       | service's identifier for the person, and the  |
 * |                       |                       | same basis that keeps the row covers it.      |
 * | `seasons`             | UNTOUCHED             | It holds no `user_id` — a season is an        |
 * |                       |                       | aggregate. It is also THE REASON the grants   |
 * |                       |                       | are kept rather than deleted:                 |
 * |                       |                       | `rewards_granted_wei` is a running total      |
 * |                       |                       | fenced by `seasons_within_budget_wei`         |
 * |                       |                       | (migrations.ts), and deleting a grant     |
 * |                       |                       | would NOT decrement it. The total would then  |
 * |                       |                       | stand against no rows, the budget would still |
 * |                       |                       | be spent, and the discrepancy would look      |
 * |                       |                       | exactly like the reward exploit the cap       |
 * |                       |                       | exists to catch.                              |
 * | `jobs`                | DELETE (this user's)  | A queued `season.reward` job carries          |
 * |                       |                       | `payload.userId` (jobs.ts), so the     |
 * |                       |                       | queue is a fourth place this service stores a |
 * |                       |                       | user id. Erasing everything else and leaving  |
 * |                       |                       | the queue holding the id — and, worse, about  |
 * |                       |                       | to pay a reward to it — is not erasure.       |
 * | `outbox`              | DELETE (this user's)  | Emitted events carry `payload.userId` and     |
 * |                       |                       | `actor = 'user:<id>'` (battles.ts,    |
 * |                       |                       | seasons.ts) and are never pruned, so  |
 * |                       |                       | they are a durable copy of the id. Undelivered|
 * |                       |                       | ones go too: an achievement announcement for  |
 * |                       |                       | an account that has just been erased must not |
 * |                       |                       | be broadcast, and every subscriber is erasing |
 * |                       |                       | the same user from the same event anyway.     |
 * |                       |                       | `outbox_deliveries` follows by cascade.       |
 * | `inbox`               | UNTOUCHED             | `(topic, event_id)` only. No personal data,   |
 * |                       |                       | and the row for THIS event is the record that |
 * |                       |                       | the erasure was performed.                    |
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **`reward_grants.idempotency_key` CONTAINED THE USER ID IN PLAIN TEXT.** The schema comment calls
 * it "derived from (season, user, reason)", which undersells it: `rewardIdempotencyKey`
 * (ledgerclient.ts) returns `emberkin:reward:<seasonId>:<userId>:<reason>` — not a hash, the
 * uuid itself. Anonymising `user_id` and leaving that column would have moved the identifier one
 * column to the right and called it erasure. It is therefore overwritten with
 * `emberkin:reward:erased:<random uuid>`, a form the `reward_grants_erased_key_form` CHECK pins so
 * an erased key is structurally distinguishable, with a fresh random per row so
 * `reward_grants_key_uniq` still holds for a user who had grants in two seasons.
 *
 * That trades away replay protection: a `season.reward` job that runs AFTER the erasure would
 * derive the original key, fail to find it, and grant again. Two mitigations and one residual risk,
 * stated plainly rather than left to be discovered:
 *   - the queued jobs are deleted here, in the same transaction, which is the whole population of
 *     that risk except for a job already leased by a running worker;
 *   - the ledger is idempotent on the same derived key, so even in that window no second payment is
 *     made — the ledger replays the stored entry;
 *   - the residual: that replay would still charge `seasons.rewards_granted_wei` a second time
 *     and insert a second grant row. The window is one job lease, and the event arrives after
 *     identity's grace period, so in practice it is empty. It is a reconciliation risk, not a money
 *     risk, and it is the price of not leaving a uuid in a text column.
 *
 * **`battles.spec` DOES NOT NAME THE OPPONENT, so no other user's row needs redacting.** Worth
 * checking, because the schema comment advertises async PvP and a spec that embedded an opponent's
 * id would mean surviving rows belonging to OTHER users still named the erased one. It does not:
 * the spec written at battles.ts is `{ seed, enemy, script, maxTurns }`, where `enemy` is
 * `{ name, isWild, party: KinSpec[] }` and `KinSpec` is `{ species, level, resonance, temperament,
 * nickname }` (engine/replay.ts). No user id, no account reference, no warden name — the
 * player's own warden name comes from the save at resolve time and appears only in that row's own
 * `log`, which is deleted with it. Async PvP is, today, only the determinism that would make it
 * possible: the single battle route (`POST /v1/saves/me/battles`) takes the enemy from the request
 * body, so `enemy.name` is a string the submitting client typed, never a name this service copied
 * from another account. There is consequently nothing to redact in another participant's history,
 * and no Art. 17(3)(e) / rights-of-others question to answer. **If async PvP is ever built server-
 * side, this stops being true and this handler needs a targeted jsonb redaction pass** — the
 * opponent's row must survive (it is their history) with the erased user's identity removed from
 * it.
 *
 * **The achievement sweep tolerates the rows vanishing.** `ACH_SWEEP_KIND` selects ids
 * (achievements.ts) and enqueues one `achievement.deliver` per id; the delivery re-reads the
 * row and returns the terminal outcome `'gone'` when it has disappeared (achievements.ts), which
 * completes the job rather than throwing. So an erasure that lands between a sweep and its
 * deliveries drains quietly instead of spinning in a retry loop.
 *
 * Nothing here writes an outbox event. An `emberkin.user.erased` announcement would have to carry
 * the id to be useful to anyone, which would write the identifier back into the outbox seconds
 * after deleting it from there. The inbox row is the durable record that the erasure ran.
 */

import { randomUUID } from 'node:crypto';
import type { Tx } from './outbox.ts';

/** What was erased. Counts only — never an id, because this is what gets logged. */
export interface ErasureCounts {
  readonly saves: number;
  readonly battles: number;
  /** Battles still present after the save was deleted. Must be 0; non-zero means the cascade broke. */
  readonly battlesNotCascaded: number;
  readonly achievements: number;
  readonly grantsAnonymised: number;
  readonly jobs: number;
  readonly events: number;
}

/** The erased form of `reward_grants.idempotency_key`, pinned by `reward_grants_erased_key_form`. */
export const ERASED_REWARD_KEY_PREFIX = 'emberkin:reward:erased:';

/**
 * Erase one user, in the caller's transaction.
 *
 * Idempotent by construction: every statement is keyed on the real `user_id`, and after the first
 * run no row carries it — a second call finds nothing and reports zeroes. The inbox dedupe in front
 * of it is the first line, not the only one.
 */
export async function eraseUser(tx: Tx, userId: string): Promise<ErasureCounts> {
  // Counted before the delete, because after it there is nothing left to count.
  const battlesBefore = await tx<{ n: number }[]>`
    select count(*)::int as n from battles where user_id = ${userId}
  `;

  const saves = await tx<{ user_id: string }[]>`
    delete from saves where user_id = ${userId} returning user_id
  `;

  // Expected to delete nothing: `battles.user_id` cascades from `saves`. Run anyway, so that if the
  // cascade is ever dropped the battles are still erased — and the count says the cascade is gone
  // instead of the rows quietly surviving.
  const orphaned = await tx<{ id: string }[]>`
    delete from battles where user_id = ${userId} returning id
  `;

  const achievements = await tx<{ id: string }[]>`
    delete from player_achievements where user_id = ${userId} returning id
  `;

  // ONE random placeholder for this erasure, shared by the user's grants, never derived from the
  // real id — nothing anywhere stores the mapping, and `reward_grants_one_way_erasure` refuses to
  // let anything put a real id back. The key gets a fresh random PER ROW so a user with grants in
  // two seasons does not collide on `reward_grants_key_uniq`.
  const placeholder = randomUUID();
  const grants = await tx<{ id: string }[]>`
    update reward_grants
       set user_id = ${placeholder},
           idempotency_key = ${ERASED_REWARD_KEY_PREFIX}::text || gen_random_uuid()::text,
           user_erased_at = now()
     where user_id = ${userId}
       and user_erased_at is null
    returning id
  `;

  // Queued work naming this user, before it can pay a reward to an account that no longer exists.
  const jobs = await tx<{ id: string }[]>`
    delete from jobs where payload->>'userId' = ${userId} returning id
  `;

  // Emitted events naming this user. `outbox_deliveries` cascades.
  const events = await tx<{ id: string }[]>`
    delete from outbox
     where payload->>'userId' = ${userId}
        or actor = ${`user:${userId}`}
    returning id
  `;

  return {
    saves: saves.length,
    battles: battlesBefore[0]?.n ?? 0,
    battlesNotCascaded: orphaned.length,
    achievements: achievements.length,
    grantsAnonymised: grants.length,
    jobs: jobs.length,
    events: events.length,
  };
}
