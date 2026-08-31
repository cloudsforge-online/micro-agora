/**
 * Seasons and their rewards.
 *
 * A season is content riding existing machinery (03/19 §1.5.3). Rollover — keeping exactly one
 * season active — is a LEASED recurring job, never a `setInterval`. A season reward is a ledger
 * posting whose amount is charged against the season's budget in the SAME transaction, so a game
 * exploit that mints rewards is bounded by the database, not by application-level care.
 */

import type { LedgerClient } from './ledgerclient.ts';
import { rewardIdempotencyKey, rewardPostings } from './ledgerclient.ts';
import type { Db, Emit, Tx } from './outbox.ts';

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class SeasonNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeasonNotFoundError';
  }
}

const SEASON_DAYS = 30;

/** Days since the epoch, so a season slug is stable within a period and two rollovers agree. */
function periodSlug(now: Date): string {
  const epochDays = Math.floor(now.getTime() / 86_400_000 / SEASON_DAYS);
  return `season-${epochDays}`;
}

/**
 * Ensure exactly one active season exists. Idempotent and safe under two workers: the `stream`
 * lease keeps one rollover job at a time, and `seasons_slug_uniq` is the backstop if two ever race.
 * Returns the active season id.
 */
export async function ensureActiveSeason(
  sql: Db,
  producer: string,
  budgetWei: bigint,
  now: Date,
  withOutbox: <T>(sql: Db, producer: string, fn: (tx: Tx, emit: Emit) => Promise<T>) => Promise<T>,
): Promise<string> {
  const active = await sql<{ id: string }[]>`select id from seasons where status = 'active' limit 1`;
  if (active[0]) return active[0].id;

  const slug = periodSlug(now);
  const ends = new Date(now.getTime() + SEASON_DAYS * 86_400_000);
  return withOutbox(sql, producer, async (tx, emit) => {
    const rows = await tx<{ id: string }[]>`
      insert into seasons (slug, name, starts_at, ends_at, status, reward_budget_wei)
      values (${slug}, ${'Emberkin ' + slug}, ${now.toISOString()}, ${ends.toISOString()}, 'active', ${budgetWei.toString()})
      on conflict (slug) do nothing
      returning id
    `;
    const row = rows[0];
    if (!row) {
      // Another worker created it in the same window; adopt theirs.
      const existing = await tx<{ id: string }[]>`select id from seasons where slug = ${slug} limit 1`;
      return existing[0]!.id;
    }
    emit({ topic: 'emberkin.season.started', key: row.id, payload: { seasonId: row.id, slug } });
    return row.id;
  });
}

export interface GrantRewardInput {
  readonly seasonId: string;
  readonly userId: string;
  readonly reason: string;
  readonly amount: bigint;
  readonly correlationId: string;
}

export interface GrantRewardResult {
  readonly journalEntryId: string;
  readonly amount: bigint;
  readonly replayed: boolean;
}

/**
 * Grant a season reward: charge the budget, post to the ledger, record the grant — all in one
 * transaction, in that order. A crash anywhere rolls back; a retry replays the ledger entry under
 * the same derived key and the local unique refuses the second grant row.
 */
export async function grantSeasonReward(
  sql: Db,
  producer: string,
  ledger: LedgerClient,
  input: GrantRewardInput,
  withOutbox: <T>(sql: Db, producer: string, fn: (tx: Tx, emit: Emit) => Promise<T>) => Promise<T>,
): Promise<GrantRewardResult> {
  if (input.amount <= 0n) throw new BudgetExceededError('a reward amount must be positive');
  const key = rewardIdempotencyKey(input.seasonId, input.userId, input.reason);

  return withOutbox(sql, producer, async (tx, emit) => {
    const prior = await tx<{ journal_entry_id: string; amount_wei: string }[]>`
      select journal_entry_id, amount_wei::text as amount_wei from reward_grants where idempotency_key = ${key}
    `;
    if (prior[0]) {
      return { journalEntryId: prior[0].journal_entry_id, amount: BigInt(prior[0].amount_wei), replayed: true };
    }

    // Charge the budget FIRST, conditionally. No row => over budget, and the ledger is never touched.
    const charged = await tx<{ id: string }[]>`
      update seasons
         set rewards_granted_wei = rewards_granted_wei + ${input.amount.toString()}, updated_at = now()
       where id = ${input.seasonId}
         and rewards_granted_wei + ${input.amount.toString()} <= reward_budget_wei
      returning id
    `;
    if (!charged[0]) {
      const exists = await tx<{ id: string }[]>`select id from seasons where id = ${input.seasonId}`;
      if (!exists[0]) throw new SeasonNotFoundError(`no season ${input.seasonId}`);
      throw new BudgetExceededError(`season ${input.seasonId} reward budget would be exceeded`);
    }

    const entry = await ledger.postEntry({
      kind: 'reward_granted',
      actor: `service:${producer}`,
      correlationId: input.correlationId,
      idempotencyKey: key,
      description: `emberkin season reward: ${input.reason}`,
      postings: rewardPostings({ subject: `user:${input.userId}`, amount: input.amount }),
    });

    await tx`
      insert into reward_grants (season_id, user_id, reason, amount_wei, journal_entry_id, idempotency_key)
      values (${input.seasonId}, ${input.userId}, ${input.reason}, ${input.amount.toString()}, ${entry.id}, ${key})
    `;

    emit({
      topic: 'emberkin.reward.granted',
      key,
      payload: { seasonId: input.seasonId, userId: input.userId, reason: input.reason, amount: input.amount.toString(), journalEntryId: entry.id },
      actor: `user:${input.userId}`,
      correlationId: input.correlationId,
    });

    return { journalEntryId: entry.id, amount: input.amount, replayed: false };
  });
}
