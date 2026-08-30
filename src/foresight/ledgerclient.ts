/**
 * The ledger: fee reporting, and the one read the staking panel needs.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **BOOKKEEPING MIRRORS THE CHAIN, NEVER THE REVERSE** — 19-new-products.md §2.3.1.
 *
 * The fee is taken by the CONTRACT, on settlement, to the treasury address. Nothing in this
 * service authorises it, sizes it or moves it, and no entry posted here can change it by a wei.
 * What this client does is record, for reporting, a transfer that has already happened on a public
 * chain and can be verified by anybody.
 *
 * So the order is always: the `FeePaid` log is indexed → a `fee_reports` row exists → an entry is
 * posted. Never the other way round. An entry posted first would be a claim about money that had
 * not moved, and the reconciliation that caught it would be the ledger's, weeks later.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Route verified against `micro-ledger/src/server.ts`: `POST /entries`, unprefixed.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { LiveScope } from '@cloudsforge/contracts-auth'
import type { EntryKind } from '@cloudsforge/contracts-money'

/**
 * The scopes this service's token must carry to call this peer.
 *
 * `readonly LiveScope[]` rather than `readonly string[]`: see the header of `policyclient.ts`.
 * This is an outbound demand, `derive-grants.mjs` reads it into the estate's grant list, and
 * identity
 * refuses to boot on a name the registry does not have — or has deprecated, which `Scope` alone
 * would not have caught.
 *
 * ── BOTH SCOPES, BECAUSE THIS CLIENT DOES BOTH THINGS ────────────────────────────────────────
 *
 * `balances()` below calls `GET /accounts/:subject/balances`, which micro-ledger gates on
 * `READ_SCOPE` — `ledger:read`, server.ts:81. This list named only `ledger:post` from the day the
 * file was written for fee reporting, and was not widened when the staking panel's balance read
 * was added. The compose grant carried `ledger:read` anyway, so the call worked in production and
 * nothing user-facing was wrong; what it broke was the derivation. `derive-grants.mjs --check`
 * reported `foresight: compose grants ledger:read, which no module in that service asks for` and
 * has failed estate-ci since 2026-08-12 — and the obvious reading of that sentence, that compose
 * over-grants, is backwards. Taking the grant away would have 403'd the panel.
 *
 * So: when this file gains a call, widen this list in the same commit. The declaration is the
 * thing the estate mints from, and a stale one is an outage waiting for somebody to trust it.
 */
export const LEDGER_SCOPES: readonly LiveScope[] = Object.freeze(['ledger:post', 'ledger:read'])

export class LedgerRefusedError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LedgerRefusedError'
    this.code = code
    this.status = status
  }
}

export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerUnavailableError'
  }
}

export interface Posting {
  readonly direction: 'debit' | 'credit'
  readonly amount: bigint
  readonly assetCode: string
  readonly sequence: number
  readonly account: {
    readonly subject: string
    readonly assetCode: string
    readonly purpose: string
    readonly type: string
  }
}

/**
 * The one kind this service posts.
 *
 * A named constant rather than a literal at the call site so that the membership assertion in
 * `unit.test.ts` and the posting in `jobs.ts` are the SAME value. A test that re-spells the literal
 * it is checking asserts nothing — that is precisely how `foresight.settlement_fee` survived: the
 * test agreed with the code, and both were wrong about the ledger.
 */
export const FEE_ENTRY_KIND: EntryKind = 'fee_charged'

export interface EntryRequest {
  /**
   * One of the ledger's closed vocabulary, and typed as such — micro-org#424.
   *
   * This was `string`, and THIS SERVICE is the reason the ticket exists. `foresight.settlement_fee`
   * was posted here for months; it is not a kind, so `validateEntryRequest` answered 400 before it
   * opened a transaction and not one fee was ever recorded. micro-tessera then made the identical
   * mistake with `item_issue` (micro-org#407 §3) and no object ever entered the ledger either.
   *
   * A `string` here cannot catch either one. `EntryKind` catches both at compile time, which is the
   * only place a defect whose symptom is *nothing happening* can be caught cheaply.
   */
  readonly kind: EntryKind
  readonly actor: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly postings: readonly Posting[]
}

export interface PostedEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
  readonly replayed: boolean
}

/** One account's balance, as `GET /accounts/:subject/balances` reports it. */
export interface LedgerBalance {
  readonly assetCode: string
  /** `available`, `escrow`, `reserved`… The purpose is what makes the number mean something. */
  readonly purpose: string
  /** Smallest units, as a decimal STRING. Never a number — one EMBER is 1e18 wei. */
  readonly amount: string
  readonly status: string
}

export interface LedgerClient {
  postEntry(request: EntryRequest): Promise<PostedEntry>
  /**
   * What one subject holds.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════
   * **READ-ONLY, AND IT IS NEVER THE THING THAT REFUSES A STAKE.**
   *
   * This exists so the staking panel can show a user what they have to stake with, which is the
   * difference between a form that works and a form you fill in twice. It must not become a
   * balance CHECK. The ledger's overdraft trigger, on the account that actually holds the number,
   * is what refuses a stake larger than the balance — a check here would be a second opinion read
   * a moment earlier, and the window between the two is the overdraft. The stake route says so
   * already and this method does not change it.
   *
   * A failure is a `LedgerUnavailableError` like any other, and the panel renders WITHOUT the
   * figure rather than refusing to render: not knowing what somebody holds is not a reason to
   * stop them staking.
   * ══════════════════════════════════════════════════════════════════════════════════════════
   */
  balances(subject: string): Promise<readonly LedgerBalance[]>
}

/**
 * The two postings a settlement fee produces.
 *
 * The debit side is the market's own pool, which is not an account the ledger holds a balance for —
 * it is a contract on a chain. So it is booked against a clearing account named for the chain, and
 * the credit is platform fee revenue. This is bookkeeping about somebody else's ledger (the chain's)
 * and the clearing account is what makes that honest: it says "this came from outside".
 *
 * ── FOUND DEAD ON ARRIVAL, 2026-08 (the engagement-treasury wave re-read this against the
 * ledger's source). As first shipped, every fee report was refused by the ledger THREE ways:
 *   1. subject `chain:<id>` was not in the account grammar — `parseAccountSubject`
 *      (contracts/packages/money/src/index.ts) threw inside the ledger's `ensureAccount`
 *      (ledger/src/accounts.ts). Fixed at the ROOT: the grammar now registers `chain:<id>`,
 *      because the subject was the right one.
 *   2. purpose `'clearing'` is a TYPE, not a purpose — `accounts_purpose_chk`
 *      (ledger/src/migrations.ts) refuses it. The transit purpose is `'suspense'`; the type
 *      stays `'clearing'`, which is also what lets the account sit either side of zero
 *      (ledger's overdraft trigger exempts type `clearing`).
 *   3. the entry kind `'foresight.settlement_fee'` was not in the ledger's closed
 *      `journal_entries_kind_chk` list (ledger/src/migrations.ts) — the vocabulary is closed
 *      precisely so revenue reports can count on it, and the right name in it is `'fee_charged'`.
 * No entry had ever posted (there is no public network yet), so nothing needed reconciling.
 */
export function feePostings(input: {
  readonly amountWei: bigint
  readonly chain: string
}): readonly Posting[] {
  return [
    {
      account: {
        subject: `chain:${input.chain}`,
        assetCode: 'EMBER',
        purpose: 'suspense',
        type: 'clearing',
      },
      direction: 'debit',
      amount: input.amountWei,
      assetCode: 'EMBER',
      sequence: 0,
    },
    {
      account: { subject: 'platform', assetCode: 'EMBER', purpose: 'fees', type: 'revenue' },
      direction: 'credit',
      amount: input.amountWei,
      assetCode: 'EMBER',
      sequence: 1,
    },
  ]
}

/**
 * The key one market's fee is posted under, for ever.
 *
 * Derived from the market id, not from a timestamp or a counter: the whole value of the key is that
 * a retry after a lost response replays rather than posts a second entry, and a key that changes
 * between attempts provides none of it.
 */
export function feeIdempotencyKey(marketId: string): string {
  return `foresight:fee:${marketId}`
}

export interface LedgerClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly originatingService: string
  readonly fetch?: typeof globalThis.fetch
}

interface RawEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
}

interface RawBalance {
  readonly assetCode: string
  readonly purpose: string
  readonly amount: string
  readonly status: string
}

export function httpLedgerClient(options: LedgerClientOptions): LedgerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'ledger',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async postEntry(request) {
      try {
        // The key is in the body AND on the request, and both matter. In the body it is what the
        // ledger stores and dedupes on; on the request it is what makes the POST retriable at all,
        // because `HttpClient` attempts a non-idempotent method exactly once without one.
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
              // Smallest units as a decimal STRING, in both directions. A JSON number is an IEEE
              // 754 double, and one EMBER is 1e18 wei — an amount does not survive the round trip.
              // It does not fail either; it comes back subtly wrong.
              amount: posting.amount.toString(),
              assetCode: posting.assetCode,
              sequence: posting.sequence,
              account: posting.account,
            })),
          },
          idempotencyKey: request.idempotencyKey,
        })
        return {
          id: body.entry.id,
          kind: body.entry.kind,
          recordedAt: body.entry.recordedAt,
          replayed: body.replayed,
        }
      } catch (err) {
        throw translate(err)
      }
    },

    async balances(subject) {
      try {
        // Encoded, because a subject is `user:<uuid>` and the ledger decodes the path segment —
        // its own route comment says a well-behaved client percent-encodes the colon.
        const body = await client.request<{ balances: readonly RawBalance[] }>(
          `/accounts/${encodeURIComponent(subject)}/balances`,
          { method: 'GET' },
        )
        return body.balances.map((row) => ({
          assetCode: row.assetCode,
          purpose: row.purpose,
          amount: row.amount,
          status: row.status,
        }))
      } catch (err) {
        throw translate(err)
      }
    },
  }
}

/**
 * `HttpError.peerDecided` is the discriminator: a 4xx means the ledger looked at the request and
 * said no, which is a permanent fact about it. Anything else means we do not know whether the entry
 * posted, and the only safe response is to retry with the same key.
 */
function translate(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body)
    return new LedgerRefusedError(err.status, parsed.code, parsed.message)
  }
  if (err instanceof LedgerRefusedError || err instanceof LedgerUnavailableError) return err
  return new LedgerUnavailableError(err instanceof Error ? err.message : String(err))
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
    return {
      code: typeof error?.code === 'string' ? error.code : 'ledger_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    }
  } catch {
    return { code: 'ledger_error', message: body.slice(0, 500) }
  }
}
