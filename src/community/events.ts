/**
 * The topics this service produces.
 *
 * **THREE OF THE ELEVEN ARE NOW REGISTERED.** The sentence that stood here — "`community.*` is not
 * registered in `@cloudsforge/contracts-events`" — was true when it was written and is false now:
 * contracts 9b19dd1 adopted `community.proposal.opened` and `community.vote.cast` alongside the
 * `community.proposal.executed` it already had, all three keyed by `proposal_id`. `activity`
 * classifies each and `notify` has a rule for each.
 *
 * The other eight are still named only here, and `topics.ts` is where that is now recorded — as a
 * SELF-EMPTYING quarantine carrying the exact `TopicSpec` micro-contracts should paste, rather than
 * as a paragraph that goes stale the moment somebody acts on it. This one did: it kept claiming the
 * registry held no `community.*` topic for as long as it took a reader to check.
 *
 * Naming follows the estate's rule: `<service>.<aggregate>.<past-tense-verb>`, keyed by the
 * aggregate id so that ordering per `(topic, key)` means what a consumer expects.
 */

export const TOPICS = Object.freeze({
  communityCreated: 'community.community.created',
  memberJoined: 'community.membership.joined',
  memberRoleChanged: 'community.membership.role_changed',
  memberDemoted: 'community.membership.demoted',
  proposalCreated: 'community.proposal.created',
  proposalOpened: 'community.proposal.opened',
  proposalClosed: 'community.proposal.closed',
  /**
   * The one 07-dependency-map.md names. Keyed by `proposal_id`, consumed by ledger, activity
   * and notify.
   *
   * It carries `ledgerEntryId` because that is the only thing a consumer can reconcile against:
   * "a spend happened" without naming the entry leaves activity and notify unable to tell a
   * replayed event from a second spend.
   */
  proposalExecuted: 'community.proposal.executed',
  delegationCreated: 'community.delegation.created',
  delegationRevoked: 'community.delegation.revoked',
  voteCast: 'community.vote.cast',
} as const)

export type Topic = (typeof TOPICS)[keyof typeof TOPICS]

export const TOPIC_NAMES: readonly Topic[] = Object.freeze(Object.values(TOPICS))

/* ------------------------------------------------------------------ consumed */

/**
 * `identity.user.deleted` — the GDPR erasure path, and not optional for any service storing a
 * `user_id` (17-definition-of-done.md §2).
 *
 * **What erasure means HERE is not "delete the rows", and that is a decision rather than a
 * shortcut.** A recorded vote is part of a governance record that other people relied on when
 * they decided how to vote; deleting it silently changes a historical tally and can retroactively
 * un-pass a proposal that has already spent money. So the subject is *pseudonymised*: memberships
 * and delegations for the subject are revoked, discussion posts are redacted, and vote rows keep
 * their weight and choice while the subject becomes an opaque erasure token. The tally is
 * unchanged and the person is no longer identifiable from it.
 */
export const USER_DELETED_TOPIC = 'identity.user.deleted'

/**
 * `billing.entitlement.granted` / `.revoked` — 07-dependency-map.md names community as a
 * consumer of both. A community plan buys capacity, never governance (15-monetisation §3.10:
 * "a community that cannot vote until it pays is not a community"), so acting on these must never
 * touch a proposal, a vote or a treasury.
 */
export const ENTITLEMENT_GRANTED_TOPIC = 'billing.entitlement.granted'
export const ENTITLEMENT_REVOKED_TOPIC = 'billing.entitlement.revoked'

export const CONSUMED_TOPICS: readonly string[] = Object.freeze([
  USER_DELETED_TOPIC,
  ENTITLEMENT_GRANTED_TOPIC,
  ENTITLEMENT_REVOKED_TOPIC,
])
