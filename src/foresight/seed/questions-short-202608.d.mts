/**
 * Types for `questions-short-202608.mjs`.
 *
 * The reasoning is `questions-2026h2.d.mts`'s and is not repeated in full: the data file is plain
 * ESM so the `micro-deploy` seeder can `import()` it under bare `node` with no loader and no build
 * step, `tsconfig.json` covers `src/**\/*` only and does not set `allowJs`, and this declaration is
 * what lets `src/seedquestions.test.ts` import the array under `tsc --noEmit`.
 *
 * The one thing worth saying that is specific to this file: `SeedQuestion` is RE-EXPORTED from
 * `questions-2026h2.d.mts` rather than restated. Two structurally identical interfaces would
 * compile perfectly and would drift the moment either batch grew a field, and the failure would be
 * invisible — `seedquestions.test.ts` iterates both batches through one code path, so a divergence
 * would show up as a type error in the test rather than as anything a reader could interpret. One
 * interface, imported twice, cannot diverge.
 */

export type { SeedQuestion } from './questions-2026h2.d.mts'

import type { SeedQuestion } from './questions-2026h2.d.mts'

/**
 * Twelve short-horizon questions researched on 2026-08-14, closing between 2026-08-25 and
 * 2026-09-15.
 *
 * Disjoint from the estate's opening nine and from `FORESIGHT_QUESTIONS_2026H2`; the data file's
 * header names the six finished candidates that were dropped for overlapping one of them.
 *
 * Named for the batch rather than for the concept, like its two predecessors, so that all three
 * arrays can be in scope together and spread into one list.
 */
export const FORESIGHT_QUESTIONS_SHORT_202608: readonly SeedQuestion[]
