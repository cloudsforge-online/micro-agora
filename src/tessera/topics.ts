/**
 * The seven topics this service produces, and the one place each name is spelled.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY NAME HERE IS A `TopicName` FROM `@cloudsforge/contracts-events`, NOT A STRING.
 *
 * That is the whole point of this file. §11.2 records what happens without it: `micro-market`
 * emits ten topics with one registered (`market/src/topics.ts`) and `micro-community` eleven
 * with three (`community/src/events.ts`). An unregistered topic is not an error anywhere — it
 * is quarantined as `internal` by `activity/src/classify.ts` and appears in nobody's
 * feed, which is the worst possible failure mode: the producer's tests pass, the relay's tests
 * pass, the delivery succeeds, and the event is invisible.
 *
 * Typing these as `TopicName` makes that a COMPILE error. A topic this service emits that
 * `contracts-events` does not know does not typecheck, so the registration and the emit land in
 * one commit or neither does.
 *
 * `keyedBy` is checked here too, against the registry, by `topics.test.ts`. §11.2: "`keyedBy` is
 * documented as the ordering partition and therefore part of the contract, not a producer's
 * private choice". The estate has the scar: `custody` registered both ceremony topics
 * `keyedBy: 'user_id'` while the emit sites passed the ADDRESS, and `activity` reads the envelope
 * key AS the user id — so every export event was filed against a user that does not exist.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { TOPICS, type TopicName } from '@cloudsforge/contracts-events'

export const PARCEL_CLAIMED: TopicName = 'tessera.parcel.claimed'
export const PARCEL_FALLOWED: TopicName = 'tessera.parcel.fallowed'
export const PARCEL_TRANSFERRED: TopicName = 'tessera.parcel.transferred'
export const OBJECT_FIRED: TopicName = 'tessera.object.fired'
export const OBJECT_ANCHORED: TopicName = 'tessera.object.anchored'
export const WARD_OPENED: TopicName = 'tessera.ward.opened'
export const VENUE_BOOKED: TopicName = 'tessera.venue.booked'

/** Every topic this service produces. `topics.test.ts` proves it equals what the registry says. */
export const PRODUCED: readonly TopicName[] = Object.freeze([
  PARCEL_CLAIMED,
  PARCEL_FALLOWED,
  PARCEL_TRANSFERRED,
  OBJECT_FIRED,
  OBJECT_ANCHORED,
  WARD_OPENED,
  VENUE_BOOKED,
])

/**
 * What this service's outbox stamps on the wire, read from the registry rather than written here.
 *
 * §11.1: "Versions are `"major.minor"` strings ... Tessera stores the string, so the stored value
 * and the wire value are the same value." Reading it from `TOPICS` means the stored value is also
 * the REGISTERED value — a producer that shipped a payload change without bumping the registry
 * would be stamping a version the registry disagrees with, and there would be nothing to notice.
 */
export function versionOf(topic: TopicName): string {
  return TOPICS[topic].version
}

/**
 * The ordering key this topic must be keyed by, per the registry.
 *
 * Not used to BUILD the key — the emit site knows which id it holds — but asserted against it, so
 * that a change to `keyedBy` in the contract and a change to what the producer passes cannot
 * happen separately. This is the check that would have caught custody's defect at the producer.
 */
export function keyedBy(topic: TopicName): string {
  return TOPICS[topic].keyedBy
}

/* -------------------------------------------------------------------------------- consumed */

/**
 * The topics this service SUBSCRIBES to, and what it does with each.
 *
 * `community.proposal.executed` is the one §10.2 argues for at length, and the argument is worth
 * keeping next to the constant: a ward is a `micro-community` community, ward decisions ride
 * `parameter_change` proposals, and community's execution handler "does nothing for any kind
 * except `treasury_spend`" (`community/src/executions.ts`). So a design that expected
 * community to ENACT a world change would have needed a new execution kind and a new handler in
 * somebody else's repository. Tessera subscribes and applies the parameter itself, which keeps
 * the change count in `micro-community` at zero and puts the game logic in the game.
 */
export const COMMUNITY_PROPOSAL_EXECUTED: TopicName = 'community.proposal.executed'

/** A sale settled in micro-market. The creator has been paid; Tessera marks the listing sold. */
export const MARKET_LISTING_SOLD: TopicName = 'market.listing.sold'

/** An entitlement was granted or revoked — the six SKUs of §7.3. */
export const BILLING_ENTITLEMENT_GRANTED: TopicName = 'billing.entitlement.granted'
export const BILLING_ENTITLEMENT_REVOKED: TopicName = 'billing.entitlement.revoked'

/**
 * A user exercised their right to erasure. `src/erasure.ts` does the work.
 *
 * Rule 6 of docs/ecosystem/03 §2 — "every service storing a `user_id` subscribes to
 * `identity.user.deleted` and erases" — and this service stores a subject in FOURTEEN places
 * while subscribing to nothing, so a deletion request reported success and changed nothing.
 *
 * The registry keys this topic `by 'user_id'` and identity puts the user id in the envelope key,
 * but the handler reads `payload.userId` rather than `envelope.key`: the key is the ORDERING
 * PARTITION, and reading it as data is the precise mistake custody made (see the header of this
 * file). The payload field is the contract.
 */
export const IDENTITY_USER_DELETED: TopicName = 'identity.user.deleted'

export const CONSUMED: readonly TopicName[] = Object.freeze([
  COMMUNITY_PROPOSAL_EXECUTED,
  MARKET_LISTING_SOLD,
  BILLING_ENTITLEMENT_GRANTED,
  BILLING_ENTITLEMENT_REVOKED,
  IDENTITY_USER_DELETED,
])
