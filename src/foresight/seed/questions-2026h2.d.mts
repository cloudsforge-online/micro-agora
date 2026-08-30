/**
 * Types for `questions-2026h2.mjs`.
 *
 * The data file is plain ESM and not TypeScript, deliberately: the estate seeder in `micro-deploy`
 * is a `.mjs` script run by bare `node`, with no loader and no build step, and a question list it
 * cannot `import()` is a question list that has to be copied by hand — which is how a resolution
 * source ends up differing between the file a reviewer read and the market that was created.
 *
 * `tsconfig.json` includes `src/**\/*` only and does not set `allowJs`, so the array itself is not
 * type-checked. This declaration is what lets `src/seedquestions.test.ts` import it under `tsc
 * --noEmit`, and it is where the shape is stated once. The declaration cannot check the file it
 * describes — a `.d.mts` is an assertion about a module, not a proof — so `seedquestions.test.ts`
 * re-checks every field at RUNTIME against `src/categories.ts` and against the same bounds
 * `src/server.ts` enforces on the wire. The declaration is for the consumer; the test is for the
 * data.
 */

/**
 * One question, in the shape `POST /markets` takes — plus the two fields that are about seeding
 * rather than about the market.
 *
 * `cover` and `observed` are NOT sent to the service and are not part of `questionHash`. `cover` is
 * the style prompt the estate seeder hands to studio when a question has no committed cover art;
 * `observed` is the reading that justified the threshold, kept beside the question so a reviewer
 * can tell a market that was uncertain when it opened from one that was already decided.
 */
export interface SeedQuestion {
  /** The question, phrased so YES and NO are exhaustive and mutually exclusive. */
  readonly question: string
  /** Style prompt for the cover image. Never a person, never a logo, never text in the picture. */
  readonly cover: string
  /** What YES means, what NO means, and what happens when the source cannot be read. */
  readonly resolutionCriteria: string
  /** One of `CATEGORY_IDS` — checked by `createDraft`, 400 `bad_category`. */
  readonly category: 'protocol_network' | 'market_prices' | 'scheduled_public_events'
  /** Must appear in this category's `sourceKinds` — 400 `bad_source_kind`. */
  readonly resolutionSourceKind: string
  /** The named source of truth. Hashed into `question_hash`, so it cannot change after open. */
  readonly resolutionSourceRef: string
  /** ISO 8601, UTC, and in the future at create time — 400 `bad_close_time`. */
  readonly closeTime: string
  /** 0 … 2_592_000 — `requireInteger(body, 'disputeWindowSeconds', 0, 30 * 86_400)`. */
  readonly disputeWindowSeconds: number
  /** 0 … 1_000 basis points, taken from the losing pool — 400 `bad_fee`. */
  readonly feeBps: number
  /** The reading, its date and its endpoint. Prose, for a human approver. */
  readonly observed: string
}

/**
 * Eleven questions researched on 2026-08-11, disjoint from the estate's opening nine.
 *
 * Named for the batch rather than for the concept so that this array and `micro-deploy`'s
 * `FORESIGHT_QUESTIONS` can be in scope together and spread into one list.
 */
export const FORESIGHT_QUESTIONS_2026H2: readonly SeedQuestion[]
