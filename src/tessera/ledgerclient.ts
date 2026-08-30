/**
 * `micro-ledger`, over HTTP. The only place this service moves money.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ACCOUNT KEY IS THE CONTRACT'S, AND THE WIRE SHAPE IS THE ONE OTHER SERVICES ALREADY SEND.
 *
 * A ledger account is `(subject, asset_code, purpose)` and nothing else
 * (`ledger/src/accounts.ts`). `ledger/src/accounts.ts` THROWS on a `type` mismatch against an
 * account that already exists, and whichever service posts second has **every** entry refused. So
 * a second spelling of `engagement:tessera`, or the same subject with `type: 'expense'` instead of
 * `'equity'`, is not a cosmetic difference; it is this service's entire economy failing at a
 * moment nobody chose. `contracts/packages/money/src/index.ts` records that `micro-foresight`
 * "shipped exactly that defect with `foresight.settlement_fee` and posted nothing for months".
 *
 * So: every identity comes from `@cloudsforge/contracts-money` — `engagementAccount`,
 * `userSubject`, the `AccountPurpose` and `AccountType` unions — and the wire body is
 * field-for-field what `market/src/ledgerclient.ts` sends, including
 * `originatingService`, `actor`, `correlationId`, the inline `account` block, and amounts as
 * decimal STRINGS. Nothing here spells an account by hand.
 *
 * **AND `equity` IS THE SAFETY PROPERTY.** `ledger_assert_no_overdraft` exempts `clearing` and
 * `suspense` and does not exempt `equity` (`ledger/src/migrations.ts`), so a grant
 * against an unfunded `engagement:tessera` is refused BY THE DATABASE. §8.3: "not a promise that
 * reserves exist, but a constraint that makes spending non-existent reserves unrepresentable."
 * This file's job is to not route around that: there is no `overdraftAllowed` path, no `suspense`
 * fallback, and no branch that posts a one-sided entry.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient } from '@cloudsforge/http'
import {
  accountKey,
  assertBalanced,
  engagementSubject,
  userSubject,
  type AccountPurpose,
  type AccountSubject,
  type AccountType,
  type Actor,
  type EntryKind,
  type LedgerAssetCode,
  type Posting,
  type TokenAssetCode,
} from '@cloudsforge/contracts-money'
import type { LiveScope } from '@cloudsforge/contracts-auth'
import { ASSET } from './sparks.ts'
import { GRANT_ENTRY_KIND, AVAILABLE, PAYOUT_DUE } from './economy.ts'
import { SERVICE } from './service.ts'

/**
 * The scopes this module's credential must carry, declared here so the deploy can mint exactly
 * these — the convention `community/src/index.ts` states and twenty repositories follow, and
 * the one `deploy/scripts/derive-grants.mjs` actually reads.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `ledger:reserve` IS NEW HERE, AND IT IS THE THIRD OF THE THREE THINGS THAT WERE MISSING.
 *
 * `deploy/compose/estate/grant-gaps.json` granted this file `ledger:post` alone and said why:
 * "Derived by reading the single call site: POST /entries. **It reaches no other ledger route.**"
 * That was true, and it stopped being true the moment `reserve` and `release` below were written —
 * both are gated on `RESERVE_SCOPE = 'ledger:reserve'` (`ledger/src/server.ts`, demanded at
 * and). The grant was never external and never anyone else's to open: it is
 * computed from this repository's own source, and this constant is that source.
 *
 * That same gaps entry ends "This entry deletes itself the day micro-tessera exports
 * LEDGER_SCOPES". This is that day — `derive-grants.mjs` fails a gaps entry whose module has since
 * grown a declaration, deliberately, "so the file shrinks as the repositories that own those
 * modules fix them". Deleting it is `micro-deploy`'s edit to make, not this repository's.
 *
 * `LiveScope` rather than `string`: identity validates every granted name against
 * `@cloudsforge/contracts-auth` at import and refuses to boot on one it does not have, so a typo
 * here is not one failed call, it is no token minting for the whole estate.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const LEDGER_SCOPES: readonly LiveScope[] = Object.freeze([
  // `POST /entries` — engagement grants, and the booking fee that pays a Venue's owner.
  'ledger:post',
  // `POST /reservations` and `POST /reservations/:id/release` — the escrowed hold behind a
  // booking, and the release without which a terminal booking would strand it.
  'ledger:reserve',
])

/**
 * The wire form of an account. Four fields, all of which the ledger keys or checks on.
 *
 * `subject` is the CONTRACT's `AccountSubject` union rather than `string`, and that is what lets
 * the account literals below be written as literals safely: `'clearing'` is checked against the
 * union at compile time, so a typo is a build error rather than a second account. It also means
 * every subject reaching the ledger came from `userSubject`/`engagementSubject` or is one of the
 * contract's named singletons — there is no longer a path for an arbitrary string to become an
 * account key.
 */
export interface AccountRef {
  readonly subject: AccountSubject
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

export class LedgerError extends Error {
  readonly status: number
  readonly code: string
  constructor(code: string, message: string, status = 502) {
    super(message)
    this.name = 'LedgerError'
    this.code = code
    this.status = status
  }
}

/**
 * Raised when the ledger refuses a posting because the account would go negative.
 *
 * A distinct class, because it is the ONE failure this service must never retry into existence.
 * §8.6's "what it must never spend it on, and cannot" is the same rule from the other side: a
 * retry loop against an unfunded treasury asks the database one question a thousand times and gets
 * the right answer every time.
 */
export class ReserveEmptyError extends LedgerError {
  constructor(message: string) {
    super('engagement_reserve_empty', message, 409)
    this.name = 'ReserveEmptyError'
  }
}

export interface PostEntryRequest {
  /**
   * The contract's closed vocabulary, NOT `string`.
   *
   * This was `string`, and it is the whole reason micro-org#407 §3 existed: `issueObjectToAuthor`
   * posted `'item_issue'` — a kind nobody had ever added to `ENTRY_KINDS` or to micro-ledger's
   * `journal_entries_kind_chk` — and the compiler had nothing to say about it. The ledger answered
   * every issuance `400 invalid_entry`, so no micro-tessera object was ever brought into the books.
   * The kind is real now; the type is what stops the next invented one from reaching a deployment.
   */
  readonly kind: EntryKind
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly postings: readonly PostingRequest[]
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>
}

/** Raised when the ledger says this reservation has already been reversed. 409, never retried. */
export class AlreadyReleasedError extends LedgerError {
  constructor(message: string) {
    super('hold_already_released', message, 409)
    this.name = 'AlreadyReleasedError'
  }
}

export interface ReserveRequest {
  /** Whose money. `user:<uuid>` — both legs are this subject's own liability accounts. */
  readonly subject: string
  readonly amountWei: bigint
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
}

export interface ReleaseRequest {
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
}

export interface BookingFeeRequest {
  readonly bookerSubject: string
  readonly ownerSubject: string
  readonly amountWei: bigint
  readonly bookingId: string
  readonly parcelId: string
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
}

/**
 * The entry kind a settled booking posts under.
 *
 * `transfer`, from the ledger's own closed set: this is one player's money becoming another
 * player's money and nothing else. Not `treasury_spend` — that is `GRANT_ENTRY_KIND`, and it means
 * the world paid, which would make every settled booking look like an engagement grant in the
 * reports 21-engagement-treasury.md is built on.
 */
export const BOOKING_FEE_ENTRY_KIND: EntryKind = 'transfer'

/**
 * The entry kind an object issuance posts under.
 *
 * `item_issue`, and it is annotated `EntryKind` for the reason micro-org#407 §3 records: the
 * literal used to sit inline in `issueObjectToAuthor` against a `kind: string` field, which made
 * it a kind micro-tessera had invented and no ledger would take. Every activation was refused.
 * With the annotation, the day someone renames or removes it from `ENTRY_KINDS` this line fails to
 * compile instead of the estate failing to issue.
 *
 * Not `reward_granted` (the world paying a player for something they did), not `purchase` (nobody
 * bought this), not `adjustment` (a correction). Issuance is its own event: a unit of a `TOKEN:`
 * asset coming into existence, credited to its author against clearing. It is worth its own word
 * because "how many of this object exist, and when did each appear" is a question the journal
 * should answer without a join.
 */
export const ISSUE_ENTRY_KIND: EntryKind = 'item_issue'

export interface LedgerClient {
  postEntry(request: PostEntryRequest): Promise<{ id: string; replayed: boolean }>
  /**
   * Move a booker's fee from `available` to `reserved` and hand back the hold's id.
   *
   * **The reservation IS the entry** (`ledger/src/server.ts`): there is no separate
   * reservations table to fall out of step with the journal, so the id stored in
   * `bookings.reservation_id` is a journal entry id and "does this hold exist" is answered by the
   * rows that prove the money moved.
   */
  reserve(request: ReserveRequest): Promise<{ reservationId: string; replayed: boolean }>
  /**
   * Return a hold to `available`. **Full release only** — the ledger declines to model a partial
   * one (`ledger/src/entries.ts`) and a booking never needs one, because a booking's price is
   * a single number the schema pins to the owner's posted rate.
   */
  release(reservationId: string, request: ReleaseRequest): Promise<{ id: string; replayed: boolean }>
  /**
   * Pay a settled booking's fee from the booker to the Venue's owner.
   *
   * A method rather than postings the caller assembles, so `economy.ts` can name the ledger it
   * needs with a `type`-only import and the two files stay out of a runtime cycle. See
   * `bookingFeePostings` at the foot of this file for what it is and what it deliberately is not.
   */
  payBookingFee(request: BookingFeeRequest): Promise<{ id: string; replayed: boolean }>
  balances(subject: string): Promise<ReadonlyArray<{ purpose: string; amount: bigint }>>
}

export interface LedgerClientOptions {
  readonly baseUrl: string
  /** A live service token holding `LEDGER_SCOPES`. A function, because a token expires. */
  readonly token: () => Promise<string>
  /** Test seam. */
  readonly client?: Pick<HttpClient, 'request'>
}

/**
 * Balance the entry HERE, before the socket opens.
 *
 * `assertBalanced` is the contract's own check and it takes the RESOLVED `Posting` shape
 * (`accountId`-keyed), while the wire sends the inline `account` block — the two forms
 * `contracts/packages/money/src/index.ts` explains exist for different jobs. `accountKey`
 * builds the resolved id from the identity, so this checks exactly the accounts the wire names.
 *
 * The ledger has a deferred trigger that enforces the same invariant per `asset_code`
 * (`ledger/src/migrations.ts`), so this is a second check. Deliberately: an unbalanced
 * entry that fails at the ledger is a round trip and a log line in somebody else's service, while
 * one that fails here names the caller that built it.
 */
export function balanceCheck(postings: readonly PostingRequest[]): void {
  const resolved: Posting[] = postings.map((p) => ({
    accountId: accountKey({
      subject: p.account.subject as never,
      assetCode: p.account.assetCode,
      purpose: p.account.purpose,
    }),
    direction: p.direction,
    amount: p.amount,
    assetCode: p.assetCode,
    sequence: p.sequence,
  }))
  assertBalanced(resolved)
}

export function createLedgerClient(options: LedgerClientOptions): LedgerClient {
  const http = options.client ?? new HttpClient({ baseUrl: options.baseUrl, name: 'ledger' })

  const client: LedgerClient = {
    async postEntry(request) {
      balanceCheck(request.postings)
      try {
        const body = await http.request<{ entry?: { id?: string }; id?: string; replayed?: boolean }>(
          '/entries',
          {
            method: 'POST',
            deadlineMs: 10_000,
            // The key is in the body AND on the request, and both matter. In the body it is what
            // the ledger stores and dedupes on; on the request it is what makes the POST retriable
            // at all, because `HttpClient` attempts a non-idempotent method exactly once without
            // one. `market/src/ledgerclient.ts` says the same, and the two must agree.
            idempotencyKey: request.idempotencyKey,
            requestId: request.correlationId,
            headers: { authorization: `Bearer ${await options.token()}` },
            body: {
              kind: request.kind,
              originatingService: SERVICE,
              actor: request.actor,
              correlationId: request.correlationId,
              idempotencyKey: request.idempotencyKey,
              ...(request.metadata ? { metadata: request.metadata } : {}),
              postings: request.postings.map((posting) => ({
                direction: posting.direction,
                // Smallest units as a decimal STRING, in both directions. A JSON number is an IEEE
                // 754 double, and 10^18 wei does not survive one — it does not fail either, it
                // comes back subtly wrong.
                amount: posting.amount.toString(),
                assetCode: posting.assetCode,
                sequence: posting.sequence,
                account: posting.account,
              })),
            },
          },
        )
        const id = body.entry?.id ?? body.id
        if (!id) throw new LedgerError('bad_response', 'the ledger returned no entry id')
        return { id, replayed: body.replayed ?? false }
      } catch (err) {
        throw translate(err)
      }
    },

    async reserve(request) {
      try {
        const body = await http.request<{
          reservationId?: string
          entry?: { id?: string }
          replayed?: boolean
        }>('/reservations', {
          method: 'POST',
          deadlineMs: 10_000,
          idempotencyKey: request.idempotencyKey,
          requestId: request.correlationId,
          headers: { authorization: `Bearer ${await options.token()}` },
          body: {
            subject: request.subject,
            assetCode: ASSET,
            // A decimal STRING for the same reason every other amount on this wire is one.
            amount: request.amountWei.toString(),
            originatingService: SERVICE,
            actor: request.actor,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
            ...(request.description !== undefined ? { description: request.description } : {}),
          },
        })
        const reservationId = body.reservationId ?? body.entry?.id
        if (!reservationId) throw new LedgerError('bad_response', 'the ledger returned no reservation id')
        return { reservationId, replayed: body.replayed ?? false }
      } catch (err) {
        throw translate(err)
      }
    },

    async release(reservationId, request) {
      try {
        const body = await http.request<{ entry?: { id?: string }; id?: string; replayed?: boolean }>(
          `/reservations/${encodeURIComponent(reservationId)}/release`,
          {
            method: 'POST',
            deadlineMs: 10_000,
            idempotencyKey: request.idempotencyKey,
            requestId: request.correlationId,
            headers: { authorization: `Bearer ${await options.token()}` },
            body: {
              originatingService: SERVICE,
              actor: request.actor,
              correlationId: request.correlationId,
              idempotencyKey: request.idempotencyKey,
              ...(request.description !== undefined ? { description: request.description } : {}),
            },
          },
        )
        const id = body.entry?.id ?? body.id
        if (!id) throw new LedgerError('bad_response', 'the ledger returned no release entry id')
        return { id, replayed: body.replayed ?? false }
      } catch (err) {
        throw translate(err)
      }
    },

    // `client.postEntry`, not `this.postEntry`: a caller that destructures the client — which
    // `BookingLedger`'s `Pick` invites — would otherwise get an unbound method and a TypeError at
    // the one moment money is meant to move.
    async payBookingFee(request) {
      return client.postEntry({
        kind: BOOKING_FEE_ENTRY_KIND,
        actor: request.actor,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
        postings: bookingFeePostings(request.bookerSubject, request.ownerSubject, request.amountWei),
        metadata: {
          programme: SERVICE,
          bookingId: request.bookingId,
          parcelId: request.parcelId,
        },
      })
    },

    async balances(subject) {
      try {
        const response = await http.request<{ balances?: unknown }>(
          `/accounts/${encodeURIComponent(subject)}/balances`,
          {
            method: 'GET',
            deadlineMs: 10_000,
            headers: { authorization: `Bearer ${await options.token()}` },
          },
        )
        const raw = response.balances
        if (!Array.isArray(raw)) return []
        return raw.flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null) return []
          const e = entry as Record<string, unknown>
          if (e['assetCode'] !== ASSET) return []
          const purpose = typeof e['purpose'] === 'string' ? e['purpose'] : null
          const amount = typeof e['amount'] === 'string' ? e['amount'] : null
          // The same `/^\d{1,78}$/`-before-BigInt discipline as `sparks.ts`, with a sign allowed:
          // a balance CAN legitimately be negative on a clearing account, and `BigInt('')` is
          // still `0n`, which here would report an empty treasury as a funded one.
          if (!purpose || !amount || !/^-?\d{1,78}$/.test(amount)) return []
          return [{ purpose, amount: BigInt(amount) }]
        })
      } catch (err) {
        throw translate(err)
      }
    },
  }

  return client
}

/**
 * Turn a ledger failure into something this service can act on.
 *
 * The overdraft trigger raises `check_violation` with a message naming the account and the amount
 * it would go to (`ledger/src/migrations.ts`). Matching on the SENTENCE rather than on a
 * status code, because a 409 from the ledger could be a dozen things and only this one means "the
 * world cannot pay what it does not hold" — which is the one this service must surface differently
 * and must never retry.
 */
function translate(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (
    message.includes('may not go negative') ||
    message.includes('would go to -') ||
    message.includes('overdraft')
  ) {
    return new ReserveEmptyError(
      `the ledger refused this posting: ${message}. engagement:tessera is an equity account, so ` +
        'an unfunded grant is refused at the database rather than by a handler that forgot to ' +
        'look (23-tessera.md §8.3).',
    )
  }
  // The ledger's own sentence, `ledger/src/entries.ts`. Matched rather than inferred from the
  // 409, because "already released" is the ONE release failure that is not a reason to retry: the
  // money has already left `reserved`, and a caller told to try again would loop on a fact.
  if (message.includes('was already released by entry')) {
    return new AlreadyReleasedError(
      `the ledger has already reversed this hold: ${message}. The money is not stranded — it is ` +
        'back in the booker\'s `available` — but this service did not do it and cannot record ' +
        'which entry did, so the booking stays open for a person to look at.',
    )
  }
  // `invalid_entry` is the ledger saying THIS REQUEST is wrong — an unknown kind, a missing field,
  // postings that do not balance (`ledger/src/entries.ts` `validateEntryRequest`, surfaced as a
  // 400 by its `server.ts`). Named here because without this branch it fell through to
  // `ledger_unavailable` below, and micro-org#407 §3 is what that costs: every object activation
  // failed with "the ledger is unavailable" while the ledger was up and answering correctly. An
  // operator reading that goes and looks at the wrong service. A bad request is also the one
  // failure retrying cannot fix, so it is a 500 on this service rather than a 502 about another.
  if (message.includes('invalid_entry') || message.includes('unknown entry kind')) {
    return new LedgerError(
      'ledger_rejected_entry',
      `the ledger refused this entry as malformed: ${message}. This is a defect in THIS service — ` +
        'the ledger is answering. Retrying will not help.',
      500,
    )
  }
  if (err instanceof LedgerError) return err
  return new LedgerError('ledger_unavailable', message)
}

/**
 * The two postings that pay a Venue's owner when a booking settles.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT THE `releasePayout` THE FILE BELOW REFUSES TO HAVE, AND THE DIFFERENCE IS WHOSE
 * MONEY IT IS.
 *
 * That function moved a creator's `payout_due` → `available` for a MARKET SALE, which
 * `market/src/orders.ts` already does — two services releasing one payout. A venue booking
 * never reaches micro-market: no listing, no order, no settlement, nobody else to double it. §8.4
 * lists it in its own right — "Earned: object sales, royalties on every resale, **venue
 * bookings**, and commissions" — and Tessera is the only service that holds a calendar.
 *
 * `available` → `available`, not into `payout_due`: the dispute window `payout_due` exists for is
 * a property of a SALE with a return path. An hour of a room, already sat through by the time this
 * runs, has none — and money parked in `payout_due` with nothing in this service that ever debits
 * it would be money the owner can see and never spend, which is the stranding this whole change
 * exists to end, moved one account along.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function bookingFeePostings(
  bookerSubject: string,
  ownerSubject: string,
  amountWei: bigint,
): readonly PostingRequest[] {
  return [
    { account: holder(bookerSubject, 'available'), direction: 'debit', amount: amountWei, assetCode: ASSET, sequence: 0 },
    { account: holder(ownerSubject, 'available'), direction: 'credit', amount: amountWei, assetCode: ASSET, sequence: 1 },
  ]
}

/* -------------------------------------------------------------------------- account shapes */

/**
 * The user id inside a `user:` subject, or a refusal.
 *
 * **Every subject this service can hold is a user subject, and the DATABASE is what says so**:
 * `accounts.subject` carries `constraint accounts_subject_is_a_user check (subject like 'user:%')`
 * (`migrations.ts`), and every subject-bearing column — `author_subject`, `owner_subject`,
 * `beneficiary`, `seller_subject`, `booked_by` — is a foreign key into it. So a subject that is
 * not a user's cannot have reached this file from any table Tessera owns.
 *
 * This used to be a ternary that PASSED THROUGH anything without the prefix, which meant
 * `holder('alice', …)` quietly produced an account keyed on the subject `alice` — not a user
 * account, not any kind the contract names, and unreconcilable with every other service's. The
 * refusal is the honest form of what the constraint already guarantees, and it also lets the
 * subject be spelled through `userSubject`, which is the contract's own way of saying "user".
 */
function userIdOf(subject: string): string {
  if (!subject.startsWith('user:')) {
    throw new LedgerError(
      'invalid_subject',
      `${subject} is not a user subject — Tessera's accounts table admits none other ` +
        '(migrations.ts, accounts_subject_is_a_user)',
      500,
    )
  }
  return subject.slice('user:'.length)
}

/**
 * The two purposes Tessera ever posts a person's money to.
 *
 * **Not `AccountPurpose`, and the narrowing is a guard rather than tidiness.** `economy.test.ts`
 * asserts over the whole repository that Tessera never debits `payout_due` — releasing a
 * creator's proceeds is micro-market's job and a second service doing it pays twice. That test
 * scans source for the spelling; this type makes the spelling not compile. `PAYOUT_DUE` stays
 * imported for READING a balance, which is not moving one.
 */
export type HolderPurpose = 'available' | 'reserved'

/**
 * A person's own money. Always a `liability`: the platform owes it to them.
 *
 * **The two branches are one account shape written twice on purpose.** `micro-conformance`'s
 * `ledger-accounts` sweep reconciles the type every service claims per account key by reading
 * object literals out of source, and it can only compare a key it can read: a `purpose` held in a
 * variable is a wildcard that takes part in no comparison at all. Written out, both of Tessera's
 * user accounts are checked against every other service's `user`/`available` and `user`/`reserved`
 * claims — which is the check that would have caught the `platform`/`fees` defect that worlds,
 * emberkin and settlement each shipped independently. Collapsing these back into one literal with
 * `purpose` as a variable would be tidier and would switch that comparison off.
 */
export function holder(subject: string, purpose: HolderPurpose): AccountRef {
  const canonical = userSubject(userIdOf(subject))
  return purpose === 'reserved'
    ? { subject: canonical, assetCode: ASSET, purpose: 'reserved', type: 'liability' }
    : { subject: canonical, assetCode: ASSET, purpose: 'available', type: 'liability' }
}

/**
 * The subject the reserve lives under, for a test or an operator to look up.
 *
 * Declared BEFORE `ENGAGEMENT_REF`, which reads it at module-evaluation time. The other order is
 * a temporal-dead-zone `ReferenceError` on import, not a lint nit.
 */
export const ENGAGEMENT_SUBJECT = engagementSubject(SERVICE)

/**
 * The engagement reserve. `equity`, which is the whole point.
 *
 * **Spelled so that a static reader can see it, and pinned to the contract by a test.** This was
 * three property reads off `ENGAGEMENT_ACCOUNT`, which is `engagementAccount(SERVICE, ASSET)` and
 * therefore already constant — but `micro-conformance`'s sweep resolves a subject through the
 * contract's factory or a local `const`, not through a property access on an imported one, so the
 * estate's single most-cited account read as unresolvable. Nothing about the account changed; only
 * the spelling did. `economy.test.ts` asserts field-for-field that this still equals
 * `ENGAGEMENT_ACCOUNT`, so the contract remains the authority and the literal cannot drift.
 */
export const ENGAGEMENT_REF: AccountRef = {
  subject: ENGAGEMENT_SUBJECT,
  assetCode: ASSET,
  purpose: 'treasury',
  type: 'equity',
}

/**
 * The two postings of an engagement grant.
 *
 * Debit `engagement:tessera` (equity), credit the beneficiary's `available`. Exported separately
 * from the call so `economy.test.ts` can assert the SHAPE — that the debit side is the engagement
 * account and that its type is the one the ledger refuses an overdraft on — without a ledger
 * being up.
 */
export function grantPostings(beneficiary: string, amountWei: bigint): readonly PostingRequest[] {
  return [
    { account: ENGAGEMENT_REF, direction: 'debit', amount: amountWei, assetCode: ASSET, sequence: 0 },
    {
      account: holder(beneficiary, AVAILABLE),
      direction: 'credit',
      amount: amountWei,
      assetCode: ASSET,
      sequence: 1,
    },
  ]
}

/**
 * Grant EMBER from the engagement reserve.
 *
 * **The refusal path is the interesting one, and it is not implemented here.** If
 * `engagement:tessera` holds nothing, the ledger's `ledger_assert_no_overdraft` trigger raises and
 * this throws `ReserveEmptyError` — from the database, not from a balance check this file could
 * have forgotten to write. There is deliberately no "check the balance first": a check-then-post
 * is a race, and the post is already the check.
 */
export async function grantFromEngagement(
  ledger: LedgerClient,
  input: {
    beneficiary: string
    amountWei: bigint
    kind: string
    idempotencyKey: string
    correlationId: string
  },
): Promise<{ id: string; replayed: boolean }> {
  return ledger.postEntry({
    kind: GRANT_ENTRY_KIND,
    actor: 'system',
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    postings: grantPostings(input.beneficiary, input.amountWei),
    metadata: { programme: SERVICE, grantKind: input.kind },
  })
}

/**
 * The two postings that move a booking's money into escrow.
 *
 * §8.2: "The available/reserved split is two accounts, not two columns. Reserving funds is a
 * posting from `available` to `reserved`, which makes a reservation auditable, reversible and
 * impossible to lose track of" (`ledger/src/accounts.ts`).
 */
export function reservePostings(subject: string, amountWei: bigint): readonly PostingRequest[] {
  return [
    { account: holder(subject, 'available'), direction: 'debit', amount: amountWei, assetCode: ASSET, sequence: 0 },
    { account: holder(subject, 'reserved'), direction: 'credit', amount: amountWei, assetCode: ASSET, sequence: 1 },
  ]
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THERE IS NO PAYOUT FUNCTION HERE, AND ITS ABSENCE IS A CORRECTION RATHER THAN AN OMISSION.
 *
 * This file used to export `releasePostings` and `releasePayout`, moving a creator's cleared
 * proceeds from `payout_due` to `available`. They had ZERO CALLERS, which read like unfinished
 * work and was in fact a hazard: **micro-market already does both halves, and Tessera doing them
 * too would be a second service releasing one payout.**
 *
 * Read out of market's source rather than assumed:
 *
 *   * **The credit.** Settlement is one balanced entry whose proceeds leg lands in the SELLER's
 *     `payout_due` — `market/src/orders.ts` (`proceedsPurpose: holdProceeds ? 'payout_due' :
 *     'available'`) on `subject: listing.sellerSubject`.
 *   * **The release.** `releaseProceeds` (`market/src/orders.ts`) moves `payout_due` →
 *     `available` once `payout_due_at` has passed, driven by a LEASED JOB — `PAYOUT_KIND`,
 *     `market/src/jobs.ts`, fed by `duePayouts` (`orders.ts`).
 *
 * So a creator IS paid, end to end, by the service that holds the sale. What was actually missing
 * was never a payout: it was that **no Tessera listing had ever reached micro-market**, so no sale
 * could settle and there was nothing to release. `activateListing` is that fix, and it is why this
 * function is not.
 *
 * A Tessera release would debit `user:<creator> / EMBER / payout_due` for money market had already
 * moved. The ledger would REFUSE it — a user's `payout_due` is `liability`, which
 * `ledger_assert_no_overdraft` does not exempt — so it would fail loudly rather than silently
 * double-pay. That is the ledger being right, not a reason to keep the code: `market/src/escrow.ts`
 * calls the same shape "market has become a second ledger and the trial balance has stopped
 * meaning anything", and this is that from the other side.
 *
 * **What Tessera's money genuinely is: engagement grants out of `engagement:tessera`, and booking
 * reservations.** Sale proceeds are market's. `economy.test.ts` asserts this over the whole
 * repository as ZERO `payout_due` debit sites, because "Tessera never releases a payout" is a
 * claim about the repository that no single call site can make.
 *
 * `PAYOUT_DUE` is still imported, and only for READING: `GET /v1/me/balances` shows a creator what
 * they are owed and what has cleared. Showing a balance is not moving one.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** §8.2's three figures, and no fourth. Every one a `bigint`; the wire carries decimal strings. */
export interface Wallet {
  /** Spendable now. */
  readonly availableWei: bigint
  /** Held against an open venue booking. Theirs, but committed. */
  readonly reservedWei: bigint
  /** Sold, not yet cleared. Market releases it when the dispute window runs — see above. */
  readonly payoutDueWei: bigint
}

/**
 * What a player has, read from the ledger.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN ABSENT BALANCE IS ZERO HERE, AND THAT IS SAFE ONLY BECAUSE OF WHERE IT IS DECIDED.**
 *
 * `micro-tessera-web` refuses to print a digit it cannot obtain, on the grounds that a zero is
 * `BigInt('')` — the estate's oldest money hazard, an empty string silently becoming zero on a
 * screen showing somebody their own earnings. That instinct is right and this function does not
 * undermine it: the zero below is not parsed from an empty string, it is the ledger's own answer.
 * An account with no postings HAS no balance row, and `0n` is the true reading of that.
 *
 * The distinction the client needs is preserved by the ROUTE rather than by this value: if the
 * ledger cannot be reached, `GET /v1/me/balances` answers 503 and no number at all. "We have none"
 * and "we could not fetch them" must never look the same to a client — the same rule
 * `market/src/server.ts` states for its risk indicators.
 *
 * `LedgerClient.balances` already refuses an amount that is not `/^-?\d{1,78}$/` before calling
 * `BigInt`, so a malformed figure is dropped rather than becoming `0n` through the back door.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function walletOf(ledger: LedgerClient, subject: string): Promise<Wallet> {
  const balances = await ledger.balances(subject)
  const of = (purpose: string): bigint =>
    balances.find((b) => b.purpose === purpose)?.amount ?? 0n
  return {
    availableWei: of(AVAILABLE),
    reservedWei: of('reserved'),
    payoutDueWei: of(PAYOUT_DUE),
  }
}

/* ------------------------------------------------------------------------- issuing an object */

/**
 * The creator's title to their own object.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN OBJECT MUST BE LEDGER-RESERVABLE BEFORE IT CAN BE SOLD, AND THAT IS SOMEBODY ELSE'S
 * CONSTRAINT.**
 *
 * §8.5's last line: "The one constraint that binds is `listings_active_is_escrowed`
 * (`market/src/migrations.ts`): an active listing must hold an escrow, so a Tessera object
 * must be ledger-reservable under an `item_asset_code` before it can go live."
 *
 * Market's activation does exactly that — `market/src/listings.ts` `activateListing` calls
 * `holdEscrow` with `kind: 'listing_item'`, `subject: listing.sellerSubject`, `assetCode:
 * listing.itemAssetCode`, `amount: listing.quantity`, moving the item from the seller's
 * `available` to `reserved`. If the creator holds none, the ledger's no-overdraft trigger refuses
 * and the listing cannot activate. So Tessera issues the object to its author FIRST.
 *
 * **`liability`, because the platform owes the creator their object.** The same type and the same
 * `available` purpose `holder()` uses for their EMBER, for the same reason — it is theirs, held
 * custodially.
 *
 * **The counterparty is `clearing`, and it is the only type that may go negative.**
 * `ledger_assert_no_overdraft` returns early for `acct.type = 'clearing'` under the comment "A
 * clearing account nets to zero over a settled period and may legitimately sit either side of zero
 * within one" (`ledger/src/migrations.ts`, the `balances_no_overdraft` trigger). `equity` is NOT
 * exempt, which is the whole of §8.3's safety property for EMBER grants and is exactly why the
 * engagement account cannot be reused here: an issuance account MUST go negative, because the
 * negative is the count of that object in circulation.
 *
 * `clearing` is a SINGLETON subject named by the contract (`AccountSubject`,
 * `contracts/packages/money/src/index.ts`), not a new one invented here. The account key is
 * `(subject, assetCode, purpose)` and the asset code is unique per object, so `clearing /
 * TOKEN:cf:tessera:object:<hex> / suspense` is a distinct account per object that sits at exactly
 * `-1` once the object is issued. An operator reading `-1` is reading "one of this object exists".
 *
 * **No service in the estate had written a `TOKEN:` balance before this one**, which was verified
 * rather than assumed, and is why every field is cited: there is no prior spelling of the ASSET to
 * match, so this is the one that the next service will have to match. The `(subject, purpose,
 * type)` triple, by contrast, is NOT novel and must not be — `trade/src/ledgerclient.ts`
 * writes `clearing`/`suspense`/`clearing` already, and this matches it deliberately.
 * `ledger/src/accounts.ts` throws on a `type` mismatch against an existing account and whichever
 * service posts second has EVERY entry refused.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** One object is one indivisible unit. Not wei — a `TOKEN:` item has no decimals. */
export const ONE_OBJECT = 1n

/** The creator's holding of their own object. `liability`: the platform owes it to them. */
export function objectHolder(subject: string, assetCode: TokenAssetCode): AccountRef {
  const canonical = userSubject(userIdOf(subject))
  // `'available'` as a literal, not `AVAILABLE`. It is the same value — economy.ts declares
  // `AVAILABLE = 'available' as const` — but micro-conformance reads purposes as literals only,
  // so the constant made this account's key unreadable to the one check that compares it against
  // the rest of the estate. Same account, spelled where a reader can see it.
  return { subject: canonical, assetCode, purpose: 'available', type: 'liability' }
}

/**
 * The issuance counterparty. `clearing`, which is the only type permitted to go negative.
 *
 * **The purpose is `suspense`, and it was `treasury` until micro-conformance's chart said
 * otherwise.** `treasury` is `equity` for the platform and the engagement programme, `asset` for
 * custody and `liability` for a community — it is never `clearing`, in any service in the estate.
 * `clearing`/`suspense` is: `contracts` calls it "value in transit, owed onwards", and
 * `trade/src/ledgerclient.ts` already posts exactly this shape, so this now MATCHES a
 * spelling that exists rather than inventing a third.
 *
 * The safety property is unchanged and is now doubly held: `ledger_assert_no_overdraft` returns
 * early for `acct.type = 'clearing'` AND for `acct.purpose = 'suspense'`
 * (`ledger/src/migrations.ts`), and the negative balance here is the count of the
 * object in circulation.
 */
export function objectIssuer(assetCode: TokenAssetCode): AccountRef {
  // The literal, not the contract's `CLEARING` constant, for the reason given on `objectHolder`
  // — and it is the estate's prevailing spelling (billing, foresight, market, mint, settlement,
  // trade and wallet all write the singleton out). `AccountRef.subject` is the contract's
  // `AccountSubject` union, so the compiler checks this against the contract; `marketseam.test.ts`
  // additionally pins it to `CLEARING` itself.
  return { subject: 'clearing', assetCode, purpose: 'suspense', type: 'clearing' }
}

/**
 * The two postings that bring an object into the ledger.
 *
 * Exported separately from the call so `economy.test.ts` can assert the SHAPE — that the credit
 * side is the AUTHOR and that the debit side is a `clearing` account rather than the `equity` one
 * — without a ledger being up.
 */
export function issuePostings(author: string, assetCode: TokenAssetCode): readonly PostingRequest[] {
  return [
    { account: objectIssuer(assetCode), direction: 'debit', amount: ONE_OBJECT, assetCode, sequence: 0 },
    { account: objectHolder(author, assetCode), direction: 'credit', amount: ONE_OBJECT, assetCode, sequence: 1 },
  ]
}

/**
 * Issue one object to its author.
 *
 * **Idempotent on the object itself**, which is what makes this safe to call on every activation
 * attempt rather than once: the key is derived from the asset code, so a creator who lists,
 * withdraws and relists holds exactly one of their object rather than one per attempt. The ledger
 * answers the second call from its stored response and posts nothing (`market/src/ledgerclient.ts`
 * uses derived keys for the same reason, and `escrow.ts` calls it the second of three
 * independent defences).
 *
 * There is deliberately no "check the balance first". A check-then-post is a race, and the post is
 * already the check.
 */
export async function issueObjectToAuthor(
  ledger: LedgerClient,
  input: { author: string; assetCode: TokenAssetCode; correlationId: string },
): Promise<{ id: string; replayed: boolean }> {
  return ledger.postEntry({
    kind: ISSUE_ENTRY_KIND,
    actor: 'system',
    correlationId: input.correlationId,
    idempotencyKey: `tessera:issue:${input.assetCode}`,
    postings: issuePostings(input.author, input.assetCode),
    metadata: { programme: SERVICE, itemAssetCode: input.assetCode },
  })
}
