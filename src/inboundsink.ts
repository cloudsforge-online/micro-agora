import type { Network } from '@cloudsforge/http'

/**
 * What one MOUNTED module needs from the process's single event webhook.
 *
 * MOVED HERE FROM `emberkin/routes.ts` on 2026-09-02, unchanged apart from this paragraph and the
 * semicolons. It was written for the titles — emberkin, aetherholm, nda — and the condition it
 * describes turns out to hold one level up: `agora`, `studio`, `foresight` and `wallet` all verify
 * an inbound delivery with the estate-wide `OUTBOX_SIGNING_SECRET`, and all four subscribe to
 * `identity.user.deleted`. `agora/src/server.ts`'s `MOUNTED_EVENT_PATHS` already names ONE KEY,
 * NOT THREE as the condition that makes a fan-out legitimate rather than a shortcut, and these
 * four meet it for the same reason the titles do (micro-org#534).
 *
 * It lives at the process root rather than inside a module because the HOST route now reads it,
 * and a host importing a type from one of its modules is the layering inverted.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`identity.user.deleted` IS SUBSCRIBED BY EVERY TITLE IN THIS PROCESS, AND THAT IS WHY THIS
 * EXISTS.**
 *
 * Before the merge, identity's relay held one subscription row per service and delivered the same
 * erasure once per subscriber — to emberkin, to aetherholm, to nda — and each erased its own
 * `user_id` columns. After the merge there is ONE endpoint. Route the event to one module and the
 * others never erase: the deletion answers 202, the producer marks it delivered, and every city
 * that person founded and every homestead they built is still standing. There is no retry, because
 * nothing failed.
 *
 * Registering TWO subscription rows both pointing at the merged URL does not fix it either — it is
 * worse. The same event id would arrive twice at one endpoint and `withInbox` would dedupe the
 * second delivery away, which is the same silence with a second row to make it look handled.
 *
 * So the route verifies ONCE and fans out to every module that subscribes, each against its own
 * database, its own `inbox` table and its own erasure. `merged.test.ts` fails if the fan-out is
 * removed, and it checks each mounted module's database directly rather than trusting the 202.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `deliver` takes the NETWORK and never a handle. The sink resolves its own module's handle from
 * its own selector, so this interface cannot be used to hand one module the other's database —
 * there is no parameter it would arrive through.
 */
export interface InboundSink {
  /** For the log line and the reply. `studio`, `foresight`, `aetherholm`, `nda`. */
  readonly module: string
  readonly topics: ReadonlySet<string>
  deliver(
    network: Network,
    topic: string,
    eventId: string,
    payload: Record<string, unknown>,
  ): Promise<InboundOutcome>
}

/**
 * What a sink answers.
 *
 * A RESULT rather than a thrown domain error, deliberately: each module has its own error
 * vocabulary and its own mapping to a status, and a mounted module's `BadRequestError` reaching
 * this module's `catch` would be mapped by a chain that has never heard of it — a 500 for what is
 * a 400. The sink maps its own; this route only has to combine.
 */
export type InboundOutcome =
  | { readonly status: 'processed'; readonly detail?: Record<string, unknown> }
  | { readonly status: 'duplicate' }
  | { readonly status: 'rejected'; readonly reason: string }
