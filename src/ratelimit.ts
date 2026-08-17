/**
 * The floor rate, claimed in the same transaction as the write it limits.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **IN-MEMORY WOULD HAVE BEEN SHORTER AND IT WOULD HAVE BEEN WRONG.**
 *
 * A counter in a `Map` is a limit per PROCESS. The estate runs this service as one container
 * today; the day somebody sets `replicas: 2` the limit silently doubles, and nothing anywhere
 * says so — the metric still reads sixty an hour, per replica, and the square gets a hundred and
 * twenty. Worse, a restart resets it, so the cheapest way to defeat an in-memory limit is to make
 * the service fall over, which an attacker who is already flooding it is well placed to do.
 *
 * The row is claimed with `insert … on conflict do update` inside the caller's transaction, so two
 * replicas racing on the sixty-first post of an hour serialise on the primary key. One of them
 * gets 60 and commits; the other gets 61, raises, and its post rolls back with it. There is no
 * window in which the count and the post disagree, which is the property a limit needs and a
 * separate `check-then-write` cannot have.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## A fixed hour bucket, not a sliding window
 *
 * A sliding window needs a row per event and a `count(*) where created_at > now() - interval`,
 * which is a scan that grows with the flood it is meant to stop. This keeps one row per voice per
 * action per hour. The cost is the boundary: a voice can spend its whole allowance at 10:59 and
 * its whole next allowance at 11:00, so the true instantaneous ceiling is twice the configured
 * one. That is stated rather than hidden, and it is acceptable because the number this is
 * defending is "a script cannot post all night", not "a burst is impossible".
 */

import type { Db, Tx } from './outbox.ts'

export type RateAction = 'post' | 'whisper' | 'follow' | 'report'

/**
 * Raised when a voice has used its hour.
 *
 * `retryAfterSeconds` is on the error rather than computed at the route, so the header and the
 * message cannot disagree about when to come back.
 */
export class RateLimitError extends Error {
  readonly action: RateAction
  readonly limit: number
  readonly retryAfterSeconds: number

  constructor(action: RateAction, limit: number, retryAfterSeconds: number) {
    super(
      `too many ${action} requests: ${limit} per hour is the limit here — try again in ` +
        `${retryAfterSeconds} seconds`,
    )
    this.name = 'RateLimitError'
    this.action = action
    this.limit = limit
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * Claim one unit of a voice's hourly allowance, or raise.
 *
 * MUST be called inside the transaction that performs the write. Calling it outside would leave
 * the count incremented for a post that then failed its own validation — the flood control
 * punishing the one person whose request was rejected for an unrelated reason.
 *
 * The `returning` clause hands back the count AFTER the increment, which is what makes the check
 * atomic: there is no read to race against, because the read is the write.
 */
export async function claim(
  tx: Tx,
  voiceId: string,
  action: RateAction,
  limitPerHour: number,
  now: Date = new Date(),
): Promise<number> {
  const windowStart = hourOf(now)
  const rows = await tx<{ count: number }[]>`
    insert into rate_buckets (voice_id, action, window_start, count)
    values (${voiceId}, ${action}, ${windowStart}, 1)
    on conflict (voice_id, action, window_start)
      do update set count = rate_buckets.count + 1
    returning count
  `
  const count = rows[0]?.count ?? 1
  if (count > limitPerHour) {
    // The seconds left in this bucket, rounded up, and at least one — a `retry-after: 0` is an
    // invitation to retry immediately, which is the opposite of what has just been decided.
    const nextWindow = new Date(windowStart.getTime() + 3_600_000)
    const retryAfterSeconds = Math.max(1, Math.ceil((nextWindow.getTime() - now.getTime()) / 1000))
    throw new RateLimitError(action, limitPerHour, retryAfterSeconds)
  }
  return count
}

/** The top of the hour containing `now`, in UTC. The bucket key. */
export function hourOf(now: Date): Date {
  const copy = new Date(now.getTime())
  copy.setUTCMinutes(0, 0, 0)
  return copy
}

/**
 * Delete buckets whose hour has passed.
 *
 * Two hours of slack rather than one: a bucket for the hour that has just ended is still the one
 * a request arriving at 11:00:00.4 with a clock 400ms slow would claim against, and deleting it
 * out from under that request hands the caller a fresh allowance. Two is enough for any skew this
 * estate has ever measured and cheap enough not to matter.
 */
export async function sweepBuckets(sql: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(hourOf(now).getTime() - 2 * 3_600_000)
  const rows = await sql<{ id: string }[]>`
    delete from rate_buckets where window_start < ${cutoff} returning voice_id as id
  `
  return rows.length
}
