/**
 * Erase on EVERY plane this process holds, not on the request's.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN ERASURE NAMES A PERSON, NOT AN ESTATE.**
 *
 * Every other route in this process is right to work on `ctx.sql`: a request arrives through the
 * gateway with `CF-Network`, it belongs to one estate, and answering it out of the other one is
 * the data fault the whole selector exists to prevent. `identity.user.deleted` is the exception,
 * and it is the exception by nature rather than by convention — the subject of the event is a
 * human being who has one account (micro-org#459) and rows on both planes. Erasing one plane's
 * rows is not a partial success. It is a deletion request that reported success and did not do
 * what it said.
 *
 * ── HOW THIS WAS MISSED, AND HOW IT WAS MEASURED ──────────────────────────────────────────────
 *
 * `identity`'s relay POSTs the envelope with a signature and an event id and NO `CF-Network`
 * (`identity/src/outbox.ts`). The kernel therefore falls back to `singleNetwork`, which is the
 * pod's own network — mainnet — so `ctx.sql` in an ingest route has never been anything else.
 * Nothing was red about that: the handler ran, the inbox row was written, the response was a 200.
 *
 * Measured on mainnet 2026-09-02, `inbox` rows for `identity.user.deleted`:
 *
 *     tessera             2026-08-05 .. 2026-09-01     78 events
 *     tessera_testnet     2026-08-05 .. 2026-08-19     24 events
 *     market              2026-08-05 .. 2026-09-01     78
 *     market_testnet      2026-08-05 .. 2026-08-19     24
 *
 * Zero event ids in common. The testnet side stops on the day the estate moved to Kubernetes and
 * the second estate stopped being a separate subscriber set; every deletion since then erased the
 * mainnet rows and left the testnet ones (micro-org#474).
 *
 * ── WHY A HELPER AND NOT A LINE IN EACH ROUTE ─────────────────────────────────────────────────
 *
 * Thirteen modules mount an ingest route in this process and each one had the same `withInbox(
 * ctx.sql, …)`. Thirteen copies of a two-plane loop is thirteen chances to write the one-plane
 * version again, and the failure is silent by construction — a missed plane looks exactly like a
 * plane with nothing to erase. One helper, called with the module's OWN selector, is a grep.
 *
 * ── IDEMPOTENCE IS PER PLANE, AND THAT IS CORRECT ─────────────────────────────────────────────
 *
 * `withInbox` writes its `(topic, event_id)` row inside the same transaction as the erasure, so
 * each plane records its own delivery. A redelivery of the same event is a duplicate on the planes
 * that already handled it and a first delivery on any that did not — which is exactly what is
 * needed to REPAIR the rows this defect left behind: replaying an old event id erases the testnet
 * side and leaves the already-erased mainnet side untouched.
 */

import type { Network, NetworkSql } from '@cloudsforge/db'

/** What one plane's pass did. `duplicate` means this plane had already handled this event id. */
export interface PlaneOutcome<T> {
  readonly network: Network
  readonly status: 'processed' | 'duplicate'
  readonly value: T | null
}

/** Every plane's pass, plus the counts a caller puts in a 200 body and a log line. */
export interface ErasureSweep<T> {
  readonly planes: readonly PlaneOutcome<T>[]
  /** How many planes ran the erasure on this call. Zero means every plane had seen the event. */
  readonly processed: number
  /** How many planes had already recorded this event id. */
  readonly duplicates: number
}

/**
 * What one plane's pass returns: `withInbox`'s own outcome, whatever the module's `T` is.
 *
 * The callback keeps the `withInbox` call rather than this helper taking it as a parameter. Each
 * module owns its own `withInbox` over its own `Tx` and its own tables, and threading those through
 * here would need explicit type arguments at every one of the twelve call sites — which is a
 * per-site chance to write the wrong `Tx` and have it compile. Annotating the callback's handle is
 * one word, and inference does the rest.
 */
export type InboxOutcomeLike<T> = { status: 'processed'; value: T } | { status: 'duplicate' }

export async function eraseEveryPlane<THandle, T>(
  sql: NetworkSql,
  run: (handle: THandle, network: Network) => Promise<InboxOutcomeLike<T>>,
): Promise<ErasureSweep<T>> {
  const planes: PlaneOutcome<T>[] = []
  await sql.each(async (handle, network) => {
    // `@cloudsforge/db`'s `Sql` is the NARROW contract that package publishes — enough to select a
    // handle and nothing more — while each module's `Db` is the concrete driver type its queries
    // are written against. They are the same object. `index.ts` bridges them with the same cast
    // where it builds the dependency bundles, and doing it once here keeps every call site free of
    // one.
    const outcome = await run(handle as unknown as THandle, network)
    planes.push({
      network,
      status: outcome.status,
      value: outcome.status === 'processed' ? outcome.value : null,
    })
  })
  return {
    planes,
    processed: planes.filter((p) => p.status === 'processed').length,
    duplicates: planes.filter((p) => p.status === 'duplicate').length,
  }
}
