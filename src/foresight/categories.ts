/**
 * What this platform will and will not run a market on. **Versioned, in the repository.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A PREDICTION MARKET IS A PRODUCT WHOSE FAILURE MODE IS ETHICAL, NOT TECHNICAL.
 *
 * Nothing in the contract stops it holding a pool on whether a named person will be alive next
 * month. The contract is arithmetic; it has no opinion. So the refusal has to live here, and it has
 * to be a LIST OF WHAT IS ALLOWED rather than a list of what is banned — a banned-list is a game
 * where the operator loses every round, because the space of terrible questions is larger than any
 * list and the person writing the next one has read the list.
 *
 * 19-new-products.md §2.3.4 names three permitted categories and three refusals. Both are here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Why the version number exists
 *
 * A market records the allowlist version it was opened under. When the list changes, markets
 * already open are not retro-actively illegitimate and markets already resolved do not become
 * unexplainable — you can say exactly which rules were in force when a question was approved. A
 * list with no version is a list whose history is an argument.
 *
 * Changing this file is a code review and a deploy, deliberately. It is not a database row an
 * operator can edit at three in the morning, because "which questions may we ask strangers to bet
 * on" is not an operational parameter.
 */

/**
 * Bump on ANY change to `CATEGORIES` or `REFUSALS`. `markets.category_version` stores it.
 *
 * Asserted against the content by `unit.test.ts`: the test holds a hash of the frozen tables, so a
 * change that forgets to bump the version is a red build rather than a silent rewrite of history.
 */
export const CATEGORY_VERSION = 1

export interface CategorySpec {
  readonly id: string
  readonly title: string
  /** What a question in this category looks like. Shown to the operator in the approval queue. */
  readonly description: string
  /**
   * The kinds of source that can settle a question here, in order of preference.
   *
   * Not decoration: `resolution_source_kind` on a market must be one of these, and it is checked.
   * A category whose questions cannot be settled from a source the operator would cite in public is
   * a category this platform does not run — §2.3.4.
   */
  readonly sourceKinds: readonly string[]
}

/**
 * The three categories, and nothing else is approvable.
 *
 * They share one property, which is the actual rule and the reason there are three rather than
 * thirty: **the resolution is a public fact with a public record, about a system rather than about
 * a person.** A block height, a closing price, a published schedule. Ask whether the operator could
 * settle the question by pointing at a URL and having every reasonable reader agree. If not, it is
 * not in scope, whatever list it appears to fit.
 */
export const CATEGORIES: readonly CategorySpec[] = Object.freeze([
  Object.freeze({
    id: 'protocol_network',
    title: 'Protocol and network events',
    description:
      'Facts about a public blockchain or protocol that the chain itself records: a block height ' +
      'reached by a date, a fork activating, a published upgrade shipping. Settles from chain data ' +
      'or a protocol team’s own published record.',
    sourceKinds: Object.freeze(['chain_rpc', 'block_explorer', 'protocol_publication']),
  }),
  Object.freeze({
    id: 'market_prices',
    title: 'Market prices',
    description:
      'The published price or rate of a publicly traded instrument at a stated time, from a named ' +
      'venue or index. The venue is named at open, never chosen at resolution.',
    sourceKinds: Object.freeze(['exchange_api', 'price_index', 'regulator_publication']),
  }),
  Object.freeze({
    id: 'scheduled_public_events',
    title: 'Scheduled public events',
    description:
      'Whether a publicly scheduled, publicly reported event happens by its stated date — a ' +
      'release, a launch, a published fixture. About the event, never about an individual.',
    sourceKinds: Object.freeze(['official_announcement', 'primary_source_publication']),
  }),
])

export const CATEGORY_IDS: readonly string[] = Object.freeze(CATEGORIES.map((c) => c.id))

export function isCategory(value: unknown): value is string {
  return typeof value === 'string' && CATEGORY_IDS.includes(value)
}

export function categorySpec(id: string): CategorySpec {
  const spec = CATEGORIES.find((c) => c.id === id)
  if (!spec) throw new Error(`unknown category: ${id}`)
  return spec
}

export function isSourceKindFor(category: string, sourceKind: string): boolean {
  return isCategory(category) && categorySpec(category).sourceKinds.includes(sourceKind)
}

/**
 * The three refusals, stated in the code so that a reviewer of a new category has to read them.
 *
 * They are not implemented as a text filter and must not be: a regular expression that looks for
 * the word "die" would pass "will X still be with us in June" and would fail a market about a
 * protocol being deprecated. **The enforcement is that only the three categories above are
 * approvable, and that a person approves.** These strings exist so the operator queue can show the
 * approver what they are agreeing they have checked, and so the reason a proposal was discarded can
 * be recorded as one of them rather than as free text nobody can count.
 */
export const REFUSALS: readonly { readonly id: string; readonly reason: string }[] = Object.freeze([
  Object.freeze({
    id: 'named_private_individual',
    reason:
      'A market on a named private individual. The subject has not consented, gains nothing, and ' +
      'carries all of the reputational cost of strangers pricing their life.',
  }),
  Object.freeze({
    id: 'death_or_violence',
    reason:
      'A market on a death, an injury, or an act of violence. It pays people to want one, and no ' +
      'amount of liquidity is worth building that incentive.',
  }),
  Object.freeze({
    id: 'unverifiable_resolution',
    reason:
      'A market the operator could not settle from a source it would cite in public. An ' +
      'unverifiable question resolves by opinion, and a pool settled by opinion is not a ' +
      'prediction market, it is a decision somebody makes about other people’s money.',
  }),
])

export const REFUSAL_IDS: readonly string[] = Object.freeze(REFUSALS.map((r) => r.id))

export function isRefusal(value: unknown): value is string {
  return typeof value === 'string' && REFUSAL_IDS.includes(value)
}
