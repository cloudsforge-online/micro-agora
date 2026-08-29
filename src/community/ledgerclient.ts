/**
 * The ledger, as this service uses it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS SERVICE HOLDS NO MONEY. A COMMUNITY TREASURY IS A LEDGER ACCOUNT.**
 *
 * AD-15: "a community treasury is a set of ledger accounts owned by a `community` subject, with
 * spending gated by a proposal → approval-threshold → timelock → execution flow in
 * `cloudsforge-community`. Execution is a ledger posting."
 *
 * So every function in this file builds POSTINGS. There is no balance column in this repository —
 * `treasury_accounts` names an account and holds no amount, and `migrations.test.ts` asserts that
 * by enumerating the schema. The moment a number here is decremented in place, this service has
 * become a second ledger and the estate's trial balance stops meaning anything.
 *
 * The shape is `market/src/ledgerclient.ts`'s, deliberately and almost verbatim: market's escrow
 * is a reference to a ledger reservation, and a treasury account is a reference to a ledger
 * account. The two services have the same relationship to money and should not have two different
 * ways of expressing it.
 *
 * **A SPEND IS ONE ENTRY.** Debit the community's `treasury` account, credit the recipient's
 * `available`. Both liabilities: the platform owes the community its treasury, and after the
 * spend it owes the recipient instead. Nothing is created and nothing is destroyed, which is what
 * makes the entry balance by construction.
 *
 * **THE KEY IS DERIVED FROM THE PROPOSAL**, never from the execution row and never random. The
 * execution row's id does not exist until the transaction that creates it — so a retry after a
 * lost response would generate a second key and spend the treasury twice. The proposal id is
 * known long before the money moves, which is the only property that makes the key safe. It is
 * the same argument as `market:settle:<listingId>` being derived from the listing rather than the
 * order.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { AccountSubject, Actor, LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * EXACT, and it is the only scope this service asks of the ledger.
 *
 * Not `ledger:*`. See `scopes.ts` for the estate's two scope matchers and why this repository
 * chose the strict one — a governance service that can be talked into a wildcard is a governance
 * service whose treasury can be spent by anything holding a broad token.
 *
 * `readonly LiveScope[]` rather than `readonly string[]`: see the header of `policyclient.ts`.
 * This is an outbound demand, `derive-grants.mjs` reads it into the estate's grant list, and
 * identity
 * refuses to boot on a name the registry does not have — or has deprecated, which `Scope` alone
 * would not have caught.
 */
export const LEDGER_SCOPES: readonly LiveScope[] = Object.freeze(['ledger:post'])

/**
 * The ledger refused on the state of the world — most often an insufficient treasury balance,
 * which is an answer rather than a fault. Never retried with the same request.
 */
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

/** The ledger could not be reached, or answered 5xx. Retry with the same idempotency key. */
export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerUnavailableError'
  }
}

export type AccountPurpose =
  | 'available'
  | 'reserved'
  | 'escrow'
  | 'treasury'
  | 'fees'
  | 'payout_due'
  | 'suspense'

export type AccountType = 'liability' | 'asset' | 'revenue' | 'expense' | 'equity' | 'clearing'

export interface AccountRef {
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly purpose: AccountPurpose
  readonly type: AccountType
}

export interface PostingRequest {
  readonly direction: 'debit' | 'credit'
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  readonly sequence: number
  readonly account: AccountRef
}

export interface PostEntryRequest {
  readonly kind: 'treasury_spend'
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly postings: readonly PostingRequest[]
}

export interface PostedEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
  /** True when the ledger answered from a stored response rather than by posting. */
  readonly replayed: boolean
}

export interface LedgerClient {
  postEntry(request: PostEntryRequest): Promise<PostedEntry>
}

/* ------------------------------------------------------------------ the postings */

export interface SpendInput {
  /** `community:<id>` — always this community's own, derived from the row. */
  readonly treasurySubject: AccountSubject
  /** Where the money goes. A user, another community, or an organisation. */
  readonly recipientSubject: AccountSubject
  readonly assetCode: LedgerAssetCode
  /** Smallest units. `bigint`, always — a vote count and a treasury amount are integers. */
  readonly amount: bigint
}

/**
 * The two legs of a treasury spend.
 *
 * ```
 *   debit   community:<id>   purpose=treasury    amount
 *   credit  <recipient>      purpose=available   amount
 * ```
 *
 * Both `liability`, because both are money the platform owes somebody: before the entry it owes
 * the community, after it owes the recipient. There is no revenue leg and no fee — a community
 * spending its own treasury is not a transaction the platform takes a cut of, and if it ever
 * becomes one, that is a second posting with its own approval rather than a quiet third leg here.
 *
 * `purpose: 'treasury'` on the debit side is the value `contracts-money` reserves for exactly
 * this (`packages/money/src/index.ts`), which is why a community treasury does not need a
 * new account purpose invented for it.
 */
export function spendPostings(input: SpendInput): readonly PostingRequest[] {
  if (input.amount <= 0n) throw new RangeError('a treasury spend must be positive')
  return [
    {
      account: {
        subject: input.treasurySubject,
        assetCode: input.assetCode,
        purpose: 'treasury',
        type: 'liability',
      },
      direction: 'debit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 0,
    },
    {
      account: {
        subject: input.recipientSubject,
        assetCode: input.assetCode,
        purpose: 'available',
        type: 'liability',
      },
      direction: 'credit',
      amount: input.amount,
      assetCode: input.assetCode,
      sequence: 1,
    },
  ]
}

/* ------------------------------------------------------------------ derived keys */

/**
 * The key one execution is posted under, for ever.
 *
 * Derived from the PROPOSAL, which exists long before the money moves. A key derived from the
 * execution row the transaction is about to create does not survive a retry, because the retry
 * generates a different id and therefore a different key — and spends the treasury a second time.
 * The same reasoning as `market:settle:<listingId>`.
 */
export const idempotencyKeys = {
  execute: (proposalId: string): string => `community:execute:${proposalId}`,
} as const

/* ------------------------------------------------------------------ the http client */

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

/**
 * `POST /entries`, verified against `ledger/src/server.ts` rather than assumed.
 *
 * Not `/v1/entries`: the ledger serves no `/v1` prefix — its route table is `/entries`,
 * `/reservations`, `/accounts/:subject/balances`, `/trial-balance` — and `micro-wallet` calling
 * `GET /v1/quotes` at a pricing service that serves `GET /rates` is the recorded cost of guessing
 * (18-build-status.md §3.3). `ledgerclient.test.ts` asserts the REQUEST — path, kind, actor, the
 * amount crossing as a decimal string — rather than the response, because every test that stubbed
 * fetch and asserted behaviour given a reply is precisely what let those defects live.
 */
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
        // ledger stores and dedupes on; on the request it is what makes the POST retriable at
        // all, because `HttpClient` attempts a non-idempotent method exactly once without one.
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
              // 754 double, and a large amount does not survive one — it does not fail either, it
              // comes back subtly wrong.
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
  }
}

/**
 * `HttpError.peerDecided` is the discriminator: a 4xx means the ledger looked at the request and
 * said no, which is a permanent fact about it. Anything else means we do not know whether the
 * entry posted, and the only safe response is to retry with the same key.
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
