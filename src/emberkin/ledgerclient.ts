/**
 * The ledger, as this service uses it.
 *
 * **This service holds no balance, and a reward is not a column.** A season reward is a ledger
 * posting, because a game exploit that mints rewards is then a MONEY INCIDENT reconciled against
 * the ledger rather than a number that appeared in a save row. The idempotency key is derived from
 * `(season, user, reason)`, so a retried grant posts once: the ledger replays its stored answer and
 * the local `reward_grants.idempotency_key UNIQUE` refuses the second row.
 */

import { HttpClient, HttpError } from '@cloudsforge/http';
import { engagementAccount } from '@cloudsforge/contracts-money';
import type { Actor, EntryKind, LedgerAssetCode } from '@cloudsforge/contracts-money';
import type { IssuableAssetCode } from '@cloudsforge/contracts-chain';
import type { LiveScope } from '@cloudsforge/contracts-auth';

/**
 * The asset a season reward is denominated in, spelled once.
 *
 * `IssuableAssetCode` — `Exclude<AssetCode, 'SHARD'>` in contracts-chain — and not `string` or
 * `LedgerAssetCode`, which both still admit `'SHARD'` because the ledger goes on SUPERVISING the
 * retired asset it may no longer issue. That is the type `micro-mint` and `micro-admin-api` reached
 * for when they moved their own halves of this programme, and the reason is the same: a build that
 * tried to route a reward back through a retired asset would NOT COMPILE, which is a different and
 * stronger thing than a comment asking it not to.
 */
export const ENGAGEMENT_ASSET: IssuableAssetCode = 'EMBER';

/**
 * The scopes this service's token must carry to call this peer.
 *
 * `readonly LiveScope[]` rather than `readonly string[]`: see the header of `worldsclient.ts`.
 * This is an outbound demand, `derive-grants.mjs` reads it into the estate's grant list, and
 * identity
 * refuses to boot on a name the registry does not have — or has deprecated, which `Scope` alone
 * would not have caught.
 */
export const LEDGER_SCOPES: readonly LiveScope[] = Object.freeze(['ledger:post']);

/** The ledger refused on the state of the world (e.g. insufficient balance). Never retried as-is. */
export class LedgerRefusedError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'LedgerRefusedError';
    this.code = code;
    this.status = status;
  }
}

/** The ledger could not be reached, or answered 5xx. Retry with the same idempotency key. */
export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerUnavailableError';
  }
}

export interface AccountRef {
  readonly subject: string;
  readonly assetCode: LedgerAssetCode;
  readonly purpose: 'available' | 'reserved' | 'escrow' | 'treasury' | 'fees' | 'payout_due' | 'suspense';
  readonly type: 'liability' | 'asset' | 'revenue' | 'expense' | 'equity' | 'clearing';
}

export interface PostingRequest {
  readonly direction: 'debit' | 'credit';
  readonly amount: bigint;
  readonly assetCode: LedgerAssetCode;
  readonly sequence: number;
  readonly account: AccountRef;
}

export interface PostEntryRequest {
  readonly kind: EntryKind;
  readonly actor: Actor;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly description?: string;
  readonly postings: readonly PostingRequest[];
}

export interface PostedEntry {
  readonly id: string;
  readonly kind: string;
  readonly recordedAt: string;
  readonly replayed: boolean;
}

export interface LedgerClient {
  postEntry(request: PostEntryRequest): Promise<PostedEntry>;
}

/**
 * The two postings that pay a reward: the programme's money out, the player's balance in. Balanced
 * by construction — the same number on both sides.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * **THE DEBIT SIDE IS `engagement:emberkin`, AND MOVING IT THERE FIXED A LIVE COLLISION.**
 *
 * This function used to debit `(platform, SHARD, fees)` as type `expense`. `micro-billing`,
 * `micro-market`, `micro-mint`, `micro-trade` and `micro-wallet` all name that SAME account key as
 * type `revenue` (market/src/ledgerclient.ts, wallet/src/money.ts). The ledger's account
 * key is `(subject, asset_code, purpose)` — nothing else — and `ensureAccount` THROWS
 * `AccountConflictError` when a caller's stated type disagrees with the row that already exists
 * (ledger/src/accounts.ts). So whichever of us posted second would have had EVERY entry
 * refused, for as long as the disagreement stood. No suite caught it because each service tests
 * against its own fake ledger, so nothing in CI ever puts two real services against one real
 * ledger. `micro-worlds` carried the identical defect in the identical function and was moved off
 * the same key for the same reason (worlds@cc8f594).
 *
 * `revenue` was the correct reading and `expense` was ours to give up: a platform fee line is
 * income, and `micro-ledger` says so in its own chart — "`platform` is revenue under `fees`,
 * equity under `treasury` and expense under `payout_due`" (ledger/src/accounts.ts). But a
 * reward is not a fee at all, in either direction, so retyping to `revenue` would only have
 * swapped a collision for a lie. docs/ecosystem/21 §4 already names the right account: "every
 * grant a service pays out references its engagement account as the debit side", so an auditor
 * reconstructs the programme from the ledger alone.
 *
 * `equity` is load-bearing beyond the collision. The ledger's overdraft trigger exempts `clearing`
 * and `suspense` and NOT `equity` (ledger/src/migrations.ts, `ledger_assert_no_overdraft`), so a
 * reward that would take `engagement:emberkin` negative is refused BY THE LEDGER.
 * `seasons.reward_budget_wei` stays the CAP; the engagement balance is the FUNDING, and the two
 * are different questions. The account is funded only by operator-approved `engagement.transfer`
 * actions in `micro-admin-api`.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * **BOTH LEGS ARE EMBER, AND THEY WERE SHARD UNTIL micro-org#226.**
 *
 * §4's promise is a promise about ONE programme, and it holds only if the leg that FUNDS the
 * account and the leg that SPENDS it are the same asset. §3 funds `platform:engagement-treasury`
 * with mined EMBER arriving as an ordinary deposit, and §2 has read "bounded, disclosed, and
 * denominated in EMBER" since 2026-08-07. This function went on posting SHARD, which
 * contracts-chain retired on 2026-08-04 (`RETIRED_ASSETS`) and `assertIssuable` refuses by name.
 *
 * **The danger was not that this would fail. It was that it would SUCCEED.** The ledger's
 * retired-asset gate is scoped to `ACQUISITION_KINDS` — `purchase`, `subscription_charge`,
 * `deposit_credited` (ledger/src/entries.ts) — and deliberately so, because every kind by which
 * the 69,000 SHARD still sitting in live accounts gets OUT has to stay legal. `reward_granted` is
 * in neither group, so a SHARD reward posted straight through:
 *
 *   1. the credit leg raises a user LIABILITY in SHARD, with no custody asset behind it, because
 *      there is no SHARD chain to hold any and the treasury leg is `equity`, not custody;
 *   2. Σliabilities then exceeds Σcustody for SHARD, which IS reconciliation drift;
 *   3. `withinTolerance` fails CLOSED on an asset with no configured tolerance, and
 *      `LEDGER_RECONCILE_TOLERANCE` names no SHARD entry, so the drift is out of tolerance;
 *   4. that freezes SHARD withdrawals, and only a `clean` run lifts a freeze (ledger/reconcile.ts)
 *      — which would need the missing custody backing to be ISSUED, which `assertIssuable`
 *      refuses by name.
 *
 * So the first engagement reward ever paid to a player in SHARD would have frozen the asset for
 * all 69 accounts holding it, unliftably, and it would have done so QUIETLY — a `201 Created` on
 * the way in. That is why this had to move before the programme was ever switched on, and not
 * after somebody noticed a number looked wrong.
 *
 * Nothing has run through it yet. Measured on live mainnet 2026-08-10: 0 ledger accounts whose
 * subject matches `engagement` in any asset, and 0 journal entries of kind `reward_granted` ever.
 * The window was still open, which is the only reason this is a change rather than an incident.
 *
 * The player's side is `available`/`liability` in EMBER, a balance this estate's accounts already
 * hold and one the withdrawal path already knows how to pay out.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
export function rewardPostings(input: { readonly subject: string; readonly amount: bigint }): readonly PostingRequest[] {
  return [
    {
      // Spelled by @cloudsforge/contracts-money, never here: the account key is
      // (subject, asset_code, purpose), so a second spelling would be a second account and would
      // split this programme's ledger in half.
      account: {
        subject: engagementAccount('emberkin', ENGAGEMENT_ASSET).subject,
        assetCode: ENGAGEMENT_ASSET,
        purpose: 'treasury',
        type: 'equity',
      },
      direction: 'debit',
      amount: input.amount,
      assetCode: ENGAGEMENT_ASSET,
      sequence: 0,
    },
    {
      account: {
        subject: input.subject,
        assetCode: ENGAGEMENT_ASSET,
        purpose: 'available',
        type: 'liability',
      },
      direction: 'credit',
      amount: input.amount,
      assetCode: ENGAGEMENT_ASSET,
      sequence: 1,
    },
  ];
}

/** The key one reward is posted under, for ever — DERIVED from `(season, user, reason)`. */
export function rewardIdempotencyKey(seasonId: string, userId: string, reason: string): string {
  return `emberkin:reward:${seasonId}:${userId}:${reason}`;
}

export interface LedgerClientOptions {
  readonly baseUrl: string;
  readonly token: () => Promise<string | undefined> | string | undefined;
  readonly deadlineMs: number;
  readonly originatingService: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface RawEntry {
  readonly id: string;
  readonly kind: string;
  readonly recordedAt: string;
}

export function httpLedgerClient(options: LedgerClientOptions): LedgerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'ledger',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    async postEntry(request) {
      try {
        const body = await client.request<{ entry: RawEntry; replayed: boolean }>('/entries', {
          method: 'POST',
          body: {
            kind: request.kind,
            originatingService: options.originatingService,
            actor: request.actor,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
            ...(request.description !== undefined ? { description: request.description } : {}),
            postings: request.postings.map((posting) => ({
              direction: posting.direction,
              // Smallest units as a decimal STRING in both directions — a JSON number is an IEEE
              // 754 double and a large amount comes back subtly wrong.
              amount: posting.amount.toString(),
              assetCode: posting.assetCode,
              sequence: posting.sequence,
              account: posting.account,
            })),
          },
          idempotencyKey: request.idempotencyKey,
        });
        return { id: body.entry.id, kind: body.entry.kind, recordedAt: body.entry.recordedAt, replayed: body.replayed };
      } catch (err) {
        throw translate(err);
      }
    },
  };
}

function translate(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body);
    return new LedgerRefusedError(err.status, parsed.code, parsed.message);
  }
  if (err instanceof LedgerRefusedError || err instanceof LedgerUnavailableError) return err;
  return new LedgerUnavailableError(err instanceof Error ? err.message : String(err));
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body);
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
    return {
      code: typeof error?.code === 'string' ? error.code : 'ledger_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    };
  } catch {
    return { code: 'ledger_error', message: body.slice(0, 500) };
  }
}
