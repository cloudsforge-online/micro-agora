/**
 * Credits — a per-account spend cap, enforced **before** the call.
 *
 * ## What this replaces
 *
 * `asset-forge`'s control is `SPEND_LIMIT_USD` (default `$2`) plus a TTY prompt
 * (`generate.ts, 186-194, 280-293`). Three things are wrong with it as a service control:
 *
 *   1. It is **per run**, not per account. Ten runs of $1.90 spend $19 and never prompt.
 *   2. It is enforced by a **terminal**. `confirm()` returns false off a TTY, so the only
 *      non-interactive mode is `--yes`, which is "approve whatever this turns out to cost".
 *   3. It is a **process-local number**. Two concurrent runs cannot see each other's spend.
 *
 * Here the cap is a row, the reservation is a conditional UPDATE, and both are in the same
 * transaction as the job that will spend the money.
 *
 * ## Reserve, then settle. Never "charge afterwards"
 *
 * The estimate is reserved when the job row is written — inside the HTTP request, before anything
 * is enqueued and long before any socket is opened to a model. That ordering is the requirement:
 * an over-cap account is refused with `402` having made **no** call at all, so the refusal costs
 * nothing and cannot itself be the thing that goes over.
 *
 * When the job finishes the hold is settled (spent) or released (refunded). A job that dies with
 * the process leaves its hold in place; that is the safe direction, and `releaseStaleHolds` is how
 * an operator recovers it, deliberately as an explicit action rather than as a timer that could
 * release a hold for a generation still running on another replica.
 *
 * ## Usage goes to billing through the outbox, not through a direct POST
 *
 * `emitUsage` writes an event in the SAME transaction as the settle. billing subscribes to it.
 * A direct HTTP call would have to happen after the commit, where it is lost if the process dies,
 * or before it, where it charges for work that then rolls back — the exact failure mode
 * docs/ecosystem/03 rule 5 exists to remove. The event is at-least-once and carries the job id as
 * its key, and billing's `recordUsage` dedupes on an idempotency key, so a redelivery is a no-op
 * rather than a second charge.
 */

import type { Emit } from './outbox.ts'
import type { Db, Tx } from './outbox.ts'

/** A dollar amount, always as integer micro-dollars. Money is never a float in this service. */
export type UsdMicros = bigint

export interface CreditAccount {
  readonly ownerSubject: string
  readonly capUsdMicros: UsdMicros
  readonly spentUsdMicros: UsdMicros
  readonly reservedUsdMicros: UsdMicros
}

/** Raised when a reservation would exceed the cap. Mapped to **402**, not 500 or 403. */
export class CreditCapError extends Error {
  readonly ownerSubject: string
  readonly requestedUsdMicros: UsdMicros
  readonly remainingUsdMicros: UsdMicros
  readonly capUsdMicros: UsdMicros

  constructor(account: CreditAccount, requested: UsdMicros) {
    const remaining = account.capUsdMicros - account.spentUsdMicros - account.reservedUsdMicros
    super(
      `this generation is estimated at ${usd(requested)} and only ${usd(remaining)} of the ` +
        `${usd(account.capUsdMicros)} cap is left — no image call was made`,
    )
    this.name = 'CreditCapError'
    this.ownerSubject = account.ownerSubject
    this.requestedUsdMicros = requested
    this.remainingUsdMicros = remaining < 0n ? 0n : remaining
    this.capUsdMicros = account.capUsdMicros
  }
}

/** `$0.167`. Three decimals because the cheapest image this service buys is a tenth of a cent. */
export function usd(micros: UsdMicros): string {
  const negative = micros < 0n
  const absolute = negative ? -micros : micros
  const whole = absolute / 1_000_000n
  const fraction = (absolute % 1_000_000n) / 1_000n
  return `${negative ? '-' : ''}$${whole}.${String(fraction).padStart(3, '0')}`
}

interface AccountRow {
  readonly owner_subject: string
  readonly cap_usd_micros: string
  readonly spent_usd_micros: string
  readonly reserved_usd_micros: string
}

// postgres.js returns bigint columns as strings by default, which is right: a bigint that fits in
// a JS number today is a bigint that silently loses precision the day the cap is raised.
const toAccount = (row: AccountRow): CreditAccount => ({
  ownerSubject: row.owner_subject,
  capUsdMicros: BigInt(row.cap_usd_micros),
  spentUsdMicros: BigInt(row.spent_usd_micros),
  reservedUsdMicros: BigInt(row.reserved_usd_micros),
})

const COLUMNS = 'owner_subject, cap_usd_micros, spent_usd_micros, reserved_usd_micros'

/**
 * Create the account at its default cap if it does not exist.
 *
 * `do nothing` rather than `do update`: an operator who has raised an account's cap must not have
 * it reset to the default by the next generation request.
 */
export async function ensureAccount(
  sql: Db | Tx,
  ownerSubject: string,
  defaultCapUsdMicros: UsdMicros,
): Promise<CreditAccount> {
  await sql`
    insert into credit_accounts (owner_subject, cap_usd_micros)
    values (${ownerSubject}, ${defaultCapUsdMicros.toString()}::bigint)
    on conflict (owner_subject) do nothing
  `
  const rows = await sql<AccountRow[]>`
    select ${sql.unsafe(COLUMNS)} from credit_accounts where owner_subject = ${ownerSubject}
  `
  const row = rows[0]
  if (!row) throw new Error('credit account insert conflicted but no row was found')
  return toAccount(row)
}

export async function account(sql: Db | Tx, ownerSubject: string): Promise<CreditAccount | null> {
  const rows = await sql<AccountRow[]>`
    select ${sql.unsafe(COLUMNS)} from credit_accounts where owner_subject = ${ownerSubject}
  `
  const row = rows[0]
  return row ? toAccount(row) : null
}

/**
 * Hold `amount` against the cap, or refuse.
 *
 * One conditional UPDATE. The `where` clause is the guard and the row count is the answer, so two
 * concurrent requests cannot both read "there is room" and both proceed — which a
 * `select then update` would allow, and which is how a cap becomes a suggestion. The CHECK
 * constraint `credit_accounts_within_cap` is the second line of the same defence.
 */
export async function reserve(
  sql: Db | Tx,
  ownerSubject: string,
  amount: UsdMicros,
  defaultCapUsdMicros: UsdMicros,
): Promise<CreditAccount> {
  if (amount < 0n) throw new Error('a reservation may not be negative')
  const existing = await ensureAccount(sql, ownerSubject, defaultCapUsdMicros)

  const rows = await sql<AccountRow[]>`
    update credit_accounts
       set reserved_usd_micros = reserved_usd_micros + ${amount.toString()}::bigint,
           updated_at = now()
     where owner_subject = ${ownerSubject}
       and spent_usd_micros + reserved_usd_micros + ${amount.toString()}::bigint <= cap_usd_micros
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new CreditCapError(existing, amount)
  return toAccount(row)
}

/**
 * Convert a hold into spend.
 *
 * The account is charged `min(actual, hold)`. That clamp is not a rounding convenience: releasing
 * the hold and adding a LARGER actual could break `credit_accounts_within_cap` and fail the
 * settlement of a generation that has already happened, which would leave a delivered asset with
 * an unsettled hold for ever. The true actual is recorded on the job either way, so a divergence
 * between the two is visible rather than absorbed. In this service they are equal by construction:
 * both come from `priceUsdMicros` for the same API size.
 */
export async function settle(
  sql: Db | Tx,
  ownerSubject: string,
  hold: UsdMicros,
  actual: UsdMicros,
): Promise<CreditAccount | null> {
  const charged = actual > hold ? hold : actual < 0n ? 0n : actual
  const rows = await sql<AccountRow[]>`
    update credit_accounts
       set reserved_usd_micros = greatest(0, reserved_usd_micros - ${hold.toString()}::bigint),
           spent_usd_micros    = spent_usd_micros + ${charged.toString()}::bigint,
           updated_at = now()
     where owner_subject = ${ownerSubject}
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toAccount(row) : null
}

/**
 * Give a hold back. Used when a generation failed, which includes every case where no image was
 * produced — a 404 from an absent deployment costs nothing and must not consume credit.
 */
export async function release(
  sql: Db | Tx,
  ownerSubject: string,
  hold: UsdMicros,
): Promise<CreditAccount | null> {
  const rows = await sql<AccountRow[]>`
    update credit_accounts
       set reserved_usd_micros = greatest(0, reserved_usd_micros - ${hold.toString()}::bigint),
           updated_at = now()
     where owner_subject = ${ownerSubject}
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toAccount(row) : null
}

/** Set an account's cap. The one operation an operator performs on this table by hand. */
export async function setCap(
  sql: Db | Tx,
  ownerSubject: string,
  capUsdMicros: UsdMicros,
): Promise<CreditAccount> {
  const rows = await sql<AccountRow[]>`
    insert into credit_accounts (owner_subject, cap_usd_micros)
    values (${ownerSubject}, ${capUsdMicros.toString()}::bigint)
    on conflict (owner_subject) do update set cap_usd_micros = excluded.cap_usd_micros, updated_at = now()
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new Error('setting a cap returned no row')
  return toAccount(row)
}

/**
 * The usage event billing consumes. Emitted in the same transaction as the settle.
 *
 * The meter is `studio.image.generation`, the quantity is one image, and the cost is carried so
 * billing does not have to hold a copy of this service's price table — a second copy of a price
 * table is a second copy that goes stale.
 */
export function emitUsage(
  emit: Emit,
  input: {
    readonly jobId: string
    readonly ownerSubject: string
    readonly costUsdMicros: UsdMicros
    readonly backend: string
    readonly deployment: string | null
    readonly actor: string
    readonly correlationId: string
  },
): void {
  emit({
    topic: 'studio.usage.recorded',
    // The job id. One job spends once, so a redelivery carries the same key and billing's
    // idempotent `recordUsage` makes the second delivery a no-op rather than a second charge.
    key: input.jobId,
    payload: {
      meter: 'studio.image.generation',
      subject: input.ownerSubject,
      quantity: '1',
      costUsdMicros: input.costUsdMicros.toString(),
      generationJobId: input.jobId,
      backend: input.backend,
      deployment: input.deployment,
      idempotencyKey: `studio:generation:${input.jobId}`,
    },
    actor: input.actor,
    correlationId: input.correlationId,
  })
}
