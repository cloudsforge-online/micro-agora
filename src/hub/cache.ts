/**
 * The read-through cache, and the rule it exists to obey.
 *
 * **A cache that hides an outage is worse than no cache.** A dashboard that shows a portfolio from
 * four minutes ago, indistinguishable from one shown a second ago, is a dashboard that lies at
 * precisely the moment a user needs the truth — during an incident. So every entry carries the
 * instant it was stored, every hit is reported as a hit, and a hit served *after* the upstream
 * failed is a different outcome from a hit served because the value was still fresh:
 *
 *   - within TTL  → `fresh`. The tile is `ok`, and it says `cached: true` with its age.
 *   - past TTL, upstream answered → not a hit at all; the new value replaces this one.
 *   - past TTL, upstream failed → `stale`. The tile is `degraded`, never `ok`, and it carries
 *     both the age and the reason the upstream could not be reached.
 *   - past the stale window → nothing. The tile is `unavailable`.
 *
 * The stale window is the interesting number. It is what turns "pricing has been down for ninety
 * seconds" from a hole in the page into a value with a visible age, and what stops "pricing has
 * been down for an hour" from being an hour-old number rendered as if it were current.
 *
 * There is no timer anywhere in this file. Expiry is evaluated on read, and eviction happens on
 * write — rule 8 of docs/ecosystem/03 §2 bans a background timer that is not a leased job, and a
 * cache reaper is exactly the shape it bans. It also makes the cache trivially deterministic under
 * an injected clock, which is what the tests use.
 */

/** Where a value came from, as far as the caller is concerned. */
export type CacheOutcome = 'miss' | 'fresh' | 'stale'

export interface CacheHit<T> {
  readonly outcome: CacheOutcome
  readonly value: T | undefined
  /** How long ago the value was stored. `null` on a miss. */
  readonly ageMs: number | null
}

interface Entry<T> {
  readonly value: T
  readonly storedAt: number
}

export interface CacheOptions {
  /** Injected so tests do not sleep and so age is measured against one clock. */
  readonly now?: () => number
  /**
   * Ceiling on distinct keys held. Keys are `<upstream>:<userId>`-shaped, so the bound is a bound
   * on concurrent users times upstreams — an unbounded map here is a memory leak that any caller
   * can drive by rotating a query parameter.
   */
  readonly maxEntries?: number
}

/**
 * A TTL cache with a stale window, keyed by string.
 *
 * Not an LRU. Eviction is oldest-first by insertion, because the access pattern here is
 * "one user's tiles, once per dashboard load" — recency of *use* carries no signal that recency of
 * *storage* does not already carry, and an LRU's bookkeeping would buy nothing.
 */
export class TtlCache {
  readonly #entries = new Map<string, Entry<unknown>>()
  readonly #now: () => number
  readonly #maxEntries: number

  constructor(options: CacheOptions = {}) {
    this.#now = options.now ?? (() => Date.now())
    this.#maxEntries = options.maxEntries ?? 10_000
  }

  get size(): number {
    return this.#entries.size
  }

  /**
   * Read, classifying the result against this key's own TTL and stale window.
   *
   * TTL and stale window are arguments rather than construction-time state because they differ per
   * upstream and the reasons differ with them — see `upstreams.ts`, where each is stated with its
   * justification.
   */
  read<T>(key: string, ttlMs: number, staleMs: number): CacheHit<T> {
    const entry = this.#entries.get(key)
    if (!entry) return { outcome: 'miss', value: undefined, ageMs: null }

    const ageMs = this.#now() - entry.storedAt
    if (ageMs > staleMs) {
      // Dropped rather than returned. Past the stale window the value is not evidence of anything,
      // and keeping it would let a long outage end with an ancient number appearing as if fresh.
      this.#entries.delete(key)
      return { outcome: 'miss', value: undefined, ageMs: null }
    }
    return { outcome: ageMs <= ttlMs ? 'fresh' : 'stale', value: entry.value as T, ageMs }
  }

  write<T>(key: string, value: T): void {
    // Re-inserted rather than mutated so the key moves to the end of the Map's insertion order,
    // which is what makes the eviction below oldest-first.
    this.#entries.delete(key)
    this.#entries.set(key, { value, storedAt: this.#now() })

    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.#entries.delete(oldest.value)
    }
  }

  /** Test and operational seam. Never called on a request path. */
  clear(): void {
    this.#entries.clear()
  }
}
