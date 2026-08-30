/**
 * Run a mutating operation at most once per key.
 *
 * **The shape is `micro-ledger`'s `src/idempotency.ts`**, which took it in turn from
 * `repos/forge-pay/services/pay/src/store.ts`. It is inherited rather than reinvented, and what
 * it gets right is preserved in full:
 *
 *   1. **The claim INSERT and the work share ONE transaction.** The stored response can therefore
 *      never disagree with what actually committed. A design that claims the key in its own
 *      transaction and then does the work has a window in which the key exists and the change does
 *      not — and a retry arriving in that window is answered "already done" for work that never
 *      happened.
 *   2. **A concurrent duplicate blocks rather than races.** The second INSERT waits on the first
 *      transaction's uncommitted row; when that commits, the duplicate reads the stored response
 *      and replays it.
 *   3. **A reused key with a different body is refused, not replayed.** Returning the first
 *      request's answer to a second, different request is worse than an error: the caller believes
 *      the thing it asked for happened.
 *   4. **A claim with no response yet is "in flight", not "done".** If the original transaction
 *      rolled back between the insert and this read, nothing committed, so the honest answer is
 *      "retry" rather than a guess.
 *
 * What matters most here is what a retry protects. This service moves no money, so the loss from a
 * double-apply is not a double payment — it is a SECOND MARKET CONTRACT. A retried
 * `POST /markets/:id/open` that deployed twice would leave two contracts for one question, two
 * pools, and stakers split between them with no way to combine the payouts. That is unrecoverable,
 * and it is the reason this file exists in a service that never holds a balance.
 */

import { createHash } from 'node:crypto'
import type { Db, Tx } from './outbox.ts'

/** The claim exists but its transaction has not committed a response yet. The caller retries. */
export class IdempotencyInFlightError extends Error {
  constructor() {
    super('a request with this idempotency key is still in flight; retry shortly')
    this.name = 'IdempotencyInFlightError'
  }
}

/** The same key was presented with a different body. 409, always. */
export class IdempotencyKeyReuseError extends Error {
  constructor() {
    super('this idempotency key was already used with a different request body')
    this.name = 'IdempotencyKeyReuseError'
  }
}

/**
 * Fields that legitimately differ between attempts at the *same* operation, and are therefore
 * excluded from the fingerprint.
 *
 * `correlationId` is the sharp one. It is a trace identifier and it is *supposed* to change on
 * every attempt — that is what makes a retry distinguishable from the original in a trace. But
 * including it in the fingerprint means a caller doing exactly the right thing, retrying with a
 * fresh request id, is told its idempotency key was reused with a different payload. The retry then
 * fails with 409 and the caller cannot tell a genuine key collision from its own tracing.
 *
 * Found by `micro-wallet` and pinned by `micro-ledger`'s `idempotency.test.ts`. This service
 * inherits the fix rather than rediscovering the bug.
 */
const PER_ATTEMPT_FIELDS = new Set(['correlationId', 'requestId', 'idempotencyKey'])

/**
 * A stable fingerprint of a request body, so a reused key with a changed payload is caught.
 *
 * Keys are sorted at every depth before hashing. `JSON.stringify` preserves insertion order, so two
 * semantically identical bodies that serialised their fields in a different order would fingerprint
 * differently and a legitimate retry would be rejected as reuse. Sorting removes a class of false
 * 409 that would be maddening to diagnose from the caller's side.
 */
export function requestFingerprint(value: unknown): string {
  const subject =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            ([key]) => !PER_ATTEMPT_FIELDS.has(key),
          ),
        )
      : value
  return createHash('sha256').update(canonicalise(subject)).digest('hex')
}

function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'bigint') return `"${value.toString()}"`
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`
}

/**
 * The stored key, namespaced by the calling service.
 *
 * Keys are chosen by callers, and two callers independently choosing `open-1` must not collide —
 * under one flat namespace the second caller's entry would be silently swallowed as a replay of
 * the first's.
 */
export function namespacedKey(originatingService: string, route: string, clientKey: string): string {
  return `${originatingService}:${route}:${clientKey}`
}

export interface IdempotentOutcome<T> {
  readonly result: T
  readonly replayed: boolean
}

export interface IdempotencyInput<T> {
  readonly originatingService: string
  readonly route: string
  readonly clientKey: string
  readonly requestHash: string
  readonly run: (tx: Tx, storedKey: string) => Promise<T>
}

export async function withIdempotency<T>(
  sql: Db,
  input: IdempotencyInput<T>,
): Promise<IdempotentOutcome<T>> {
  const key = namespacedKey(input.originatingService, input.route, input.clientKey)

  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ key: string }[]>`
      insert into idempotency_keys (key, route, request_hash)
      values (${key}, ${input.route}, ${input.requestHash})
      on conflict (key) do nothing
      returning key
    `

    if (claimed.length === 0) {
      // Someone else holds the key. By the time this read runs, their transaction has either
      // committed (so the response is here) or rolled back (so the row is gone).
      const rows = await tx<{ request_hash: string; response: unknown }[]>`
        select request_hash, response from idempotency_keys where key = ${key}
      `
      const existing = rows[0]
      if (!existing) throw new IdempotencyInFlightError()
      if (existing.request_hash !== input.requestHash) throw new IdempotencyKeyReuseError()
      if (existing.response === null || existing.response === undefined) {
        throw new IdempotencyInFlightError()
      }
      return { value: { result: existing.response as T, replayed: true } }
    }

    const response = await input.run(tx, key)

    await tx`
      update idempotency_keys
         set response = ${tx.json(response as Record<string, never>)}
       where key = ${key}
    `

    return { value: { result: response, replayed: false } }
  })

  // Wrapped in an object above so postgres.js does not treat an array-shaped result as a list of
  // promises to unwrap, which would rewrite the caller's return type.
  return outcome.value
}

/**
 * How many keys one DELETE claims.
 *
 * An unbounded DELETE over a table that has never been pruned is a single long transaction holding
 * a row lock on everything it removes, producing one enormous batch of dead tuples. Short
 * statements let autovacuum keep up.
 */
const REAP_BATCH = 5_000

/**
 * Delete idempotency keys past their TTL. Returns how many rows went.
 *
 * The cutoff is the entire safety argument: expiring a key EARLY means the next replay of it does
 * the work a second time, so the TTL has to outlive every caller's retry horizon rather than be as
 * short as the table would like.
 */
export async function reapIdempotencyKeys(sql: Db, ttlDays: number): Promise<number> {
  // An ISO string with an explicit cast, not a Date: postgres.js resolves a prepared statement's
  // parameter types from the server's ParameterDescription, and inside a subquery it does not come
  // back with the timestamptz serialiser — a raw Date is then handed to the text encoder and
  // throws. The cast removes the question. The string is UTC, which is what the column stores.
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString()
  let total = 0
  for (;;) {
    const result = await sql`
      delete from idempotency_keys
       where key in (
         select key from idempotency_keys
          where created_at < ${cutoff}::timestamptz
          limit ${REAP_BATCH}
       )
    `
    total += result.count
    if (result.count < REAP_BATCH) return total
  }
}
