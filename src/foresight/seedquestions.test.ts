/**
 * THE SEED BATCH, CHECKED AGAINST THE RULES THIS SERVICE ENFORCES ON THE WIRE.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `seed/questions-2026h2.mjs` and `seed/questions-short-202608.mjs` are research, and research is
 * prose until something checks it. Both are checked here, by the same predicates, from one
 * `BATCHES` list — see its definition for why that is a list and not two copies of this file. Every
 * field in one of those entries is validated by `createDraft` and by `server.ts`'s body parsing —
 * a bad category is a 400 `bad_category`, a source kind the category does not permit is a 400
 * `bad_source_kind`, a close time in the past is a 400 `bad_close_time`, a fee above 1,000bps is a
 * 400 `bad_fee`, a dispute window above 30 days is a `BadRequestError`. Without this file every one
 * of those is discovered by an operator, mid-run, against a live estate, with some markets already
 * created and some not — which is the worst possible place to find a typo, because the seeder is
 * check-then-create and a partial batch has to be reasoned about by hand.
 *
 * So the assertions below are not a restatement of the data. They are the SAME predicates the
 * service applies, run against the data at build time: `isCategory` and `isSourceKindFor` are
 * imported from `categories.ts` rather than re-listed, and the numeric bounds are written as the
 * literals `server.ts` uses with a comment naming the line. When the allowlist changes, this file
 * fails for the questions the change invalidates.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## What is deliberately NOT checked here
 *
 * **Whether a question is one the platform should run.** `categories.ts` argues at length that the
 * refusals must not be implemented as a text filter — "a regular expression that looks for the word
 * 'die' would pass 'will X still be with us in June' and would fail a market about a protocol being
 * deprecated" — and that the enforcement is the three-category allowlist plus a person approving.
 * A scan here for the shape of a personal name would be exactly the filter that file refuses, and
 * it would be worse than useless: it would read as a check, so the approver would trust it.
 *
 * **Whether a threshold is well chosen.** `observed` records the reading that justified it, and
 * this file checks that the reading is THERE and dated. Whether 8,000 was the right number for the
 * S&P 500 is a judgement, and a judgement is what the approval queue is for.
 *
 * **Whether the batch duplicates the estate's opening nine.** Those live in `micro-deploy` and this
 * repository does not depend on it. Copying the nine question texts here to diff against would
 * create a second copy that drifts, and a stale copy that reports "no duplicates" is worse than no
 * check. That comparison was done by hand when the batch was written and the three candidates it
 * eliminated are named in the data file's header, which is where a reviewer will look.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATEGORY_VERSION, isCategory, isSourceKindFor } from './categories.ts'
import { questionHash, type QuestionDocument } from './questiondoc.ts'
import {
  FORESIGHT_QUESTIONS_2026H2,
  type SeedQuestion,
} from './seed/questions-2026h2.mjs'
import { FORESIGHT_QUESTIONS_SHORT_202608 } from './seed/questions-short-202608.mjs'

/** `server.ts`: `requireInteger(body, 'disputeWindowSeconds', 0, 30 * 86_400)`. */
const MAX_DISPUTE_WINDOW_SECONDS = 30 * 86_400
/** `markets.ts` `createDraft`: `feeBps < 0 || feeBps > 1_000` → 400 `bad_fee`. */
const MAX_FEE_BPS = 1_000

/**
 * One researched batch, and everything that is true of it rather than of seed data in general.
 *
 * The file used to check a single import against a single `RESEARCHED_ON` constant. It is a LIST
 * now because there is a second batch, and the obvious alternative — copy the file, change the
 * import — is how two suites end up disagreeing about what a seed question has to satisfy. Every
 * assertion below runs once per entry in this array, and adding a third batch is one more element
 * and no new test code.
 *
 * `researchedOn` is per batch because it is a fact about when somebody sat down and took the
 * readings, not a property of the repository. It is asserted rather than merely recorded so that an
 * entry copied forward from an older batch — carrying a close time that has since gone by — cannot
 * ride into a new file unnoticed.
 */
interface SeedBatch {
  /** The path, so a failure message names the file to open rather than the variable. */
  readonly path: string
  /** The day the readings were taken. Every close time must be after it. */
  readonly researchedOn: number
  readonly questions: readonly SeedQuestion[]
  /**
   * The promise the batch makes about its own horizon, in days, or `null` for a batch that makes
   * none.
   *
   * Only the short-horizon batch sets this. It exists because "these resolve in days to a few
   * weeks" is the entire reason that file was written, and a claim like that decays silently: the
   * natural way to add a thirteenth question is to copy the twelfth and change the subject, and the
   * natural close time to reach for is a comfortable one months out. That would leave a file whose
   * header says one thing and whose data says another, and nothing would notice.
   */
  readonly maxHorizonDays: number | null
}

const BATCHES: readonly SeedBatch[] = [
  {
    path: 'seed/questions-2026h2.mjs',
    researchedOn: Date.UTC(2026, 7, 11),
    questions: FORESIGHT_QUESTIONS_2026H2,
    maxHorizonDays: null,
  },
  {
    path: 'seed/questions-short-202608.mjs',
    researchedOn: Date.UTC(2026, 7, 14),
    questions: FORESIGHT_QUESTIONS_SHORT_202608,
    maxHorizonDays: 45,
  },
]

for (const batch of BATCHES) {
  const BATCH = batch.questions

  test(`${batch.path} — is a non-empty list of distinct questions`, () => {
    assert.ok(BATCH.length > 0, 'the batch is empty — the import resolved to the wrong module')
    const questions = new Set(BATCH.map((q) => q.question))
    assert.equal(questions.size, BATCH.length, 'two entries carry the same question text')
  })

  test(`${batch.path} — every category and source kind is one the allowlist permits`, () => {
    for (const q of BATCH) {
      assert.ok(isCategory(q.category), `${q.question} — ${q.category} is not an allowed category`)
      assert.ok(
        isSourceKindFor(q.category, q.resolutionSourceKind),
        `${q.question} — \`${q.resolutionSourceKind}\` is not a source kind \`${q.category}\` may be ` +
          `settled from. \`createDraft\` returns 400 bad_source_kind for this, so the seeding run ` +
          `would fail on this entry and succeed on the ones before it.`,
      )
    }
  })

  test(`${batch.path} — every close time is a canonical UTC instant, after the day it was researched`, () => {
    for (const q of BATCH) {
      const at = new Date(q.closeTime)
      assert.ok(!Number.isNaN(at.getTime()), `${q.question} — closeTime is not a date`)
      assert.equal(
        at.toISOString(),
        q.closeTime,
        `${q.question} — closeTime must be written exactly as \`toISOString()\` produces it, so that ` +
          `what a reviewer reads and what is hashed into questionHash are the same string`,
      )
      assert.ok(
        at.getTime() > batch.researchedOn,
        `${q.question} — closeTime is on or before the day the batch was researched`,
      )
    }
  })

  /**
   * A batch that promises a short horizon keeps it.
   *
   * Measured from `researchedOn` rather than from `Date.now()`, deliberately. The horizon is a fact
   * about the batch that was fixed the day it was written and does not change as the calendar
   * moves; measuring from today would make this assertion pass by less and less until it started
   * failing for every entry at once, which is a clock, not a test.
   */
  if (batch.maxHorizonDays !== null) {
    const limit = batch.maxHorizonDays
    test(`${batch.path} — every close is within ${limit} days of the research date`, () => {
      for (const q of BATCH) {
        const days = (new Date(q.closeTime).getTime() - batch.researchedOn) / 86_400_000
        assert.ok(
          days <= limit,
          `${q.question} — closes ${Math.round(days)} days after the batch was researched, and this ` +
            `batch exists to be short-horizon. Put a longer question in a batch that does not make ` +
            `that promise rather than relaxing the promise.`,
        )
      }
    })
  }

  /**
   * **THE STALENESS TRIPWIRE, AND IT IS MEANT TO GO OFF.**
   *
   * `createDraft` refuses a close time in the past. A question whose close has gone by cannot be
   * seeded at all, so an expired batch is not merely untidy — it is a file that will fail the moment
   * anybody tries to use it, silently, per entry. This asserts that the batch as a WHOLE still has
   * something in it, rather than that every entry does: individual questions expiring is the normal
   * course of a market, and failing the build for that would train everybody to ignore this file.
   *
   * When the last one goes, the build goes red and the message says what to do about it. That is the
   * correct time to find out that the seed data is dead, rather than during a bootstrap.
   *
   * It fires PER BATCH, which matters more now than it did with one file. The short-horizon batch
   * is by construction the one that will expire first — every entry closes within weeks — so a
   * whole-repository check would stay green on the strength of the long-dated batch and say nothing
   * while the short one died. Each file answers for itself.
   */
  test(`${batch.path} — has not expired in its entirety`, () => {
    const now = Date.now()
    const live = BATCH.filter((q) => new Date(q.closeTime).getTime() > now)
    assert.ok(
      live.length > 0,
      `every question in ${batch.path} has closed. \`createDraft\` returns 400 bad_close_time for ` +
        `all of them, so this file can no longer seed anything. Research a new batch or delete it ` +
        `— do not relax this test.`,
    )
  })

  test(`${batch.path} — every numeric field is inside the bounds the routes enforce`, () => {
    for (const q of BATCH) {
      assert.ok(
        Number.isInteger(q.disputeWindowSeconds) &&
          q.disputeWindowSeconds >= 0 &&
          q.disputeWindowSeconds <= MAX_DISPUTE_WINDOW_SECONDS,
        `${q.question} — disputeWindowSeconds must be a whole number in 0…${MAX_DISPUTE_WINDOW_SECONDS}`,
      )
      assert.ok(
        Number.isInteger(q.feeBps) && q.feeBps >= 0 && q.feeBps <= MAX_FEE_BPS,
        `${q.question} — feeBps must be a whole number in 0…${MAX_FEE_BPS}`,
      )
    }
  })

  test(`${batch.path} — every question states what NO means and names a source a reader can open`, () => {
    for (const q of BATCH) {
      assert.ok(q.question.trim().endsWith('?'), `${q.question} — is not phrased as a question`)
      assert.match(
        q.resolutionCriteria,
        /\bYES\b/,
        `${q.question} — the criteria never say what makes it YES`,
      )
      assert.match(
        q.resolutionCriteria,
        /\bNO\b/,
        `${q.question} — the criteria never say what makes it NO. An unstated NO is the ambiguity ` +
          `that gets discovered by the first person who loses money on it.`,
      )
      assert.match(
        q.resolutionSourceRef,
        /https:\/\/\S/,
        `${q.question} — resolutionSourceRef must name something a bettor can open before staking; ` +
          `it is hashed into questionHash and cannot be changed after the market is deployed`,
      )
      assert.ok(q.cover.trim().length > 0, `${q.question} — has no cover prompt`)
    }
  })

  test(`${batch.path} — every question carries a dated reading that justifies its threshold`, () => {
    for (const q of BATCH) {
      assert.match(
        q.observed,
        // No trailing `\b`: a reading timestamped `2026-08-11T14:15Z` is a date, and `T` is a word
        // character, so a closing boundary would reject the most precise entries in the file.
        /\b20\d\d-\d\d-\d\d/,
        `${q.question} — \`observed\` must record WHEN the reading was taken. "Above 8,000" means ` +
          `nothing without "7,760 on the day", and an approver cannot tell a market that was ` +
          `uncertain at open from one that was already decided.`,
      )
    }
  })

  /**
   * A spread, checked loosely.
   *
   * Not an aesthetic preference: a batch that is eleven price questions gives a browse page eleven
   * rows of the same idea, and the first thing a stranger learns about the product is that it is for
   * people who already trade. The assertion is only that no category is empty and that none of them
   * takes the whole batch — the point at which "a spread" stops being true.
   */
  test(`${batch.path} — spans every category without being dominated by one`, () => {
    const counts = new Map<string, number>()
    for (const q of BATCH) counts.set(q.category, (counts.get(q.category) ?? 0) + 1)
    for (const category of ['protocol_network', 'market_prices', 'scheduled_public_events']) {
      const n = counts.get(category) ?? 0
      assert.ok(n > 0, `no question in the batch is a ${category} question`)
      assert.ok(
        n < BATCH.length,
        `every question in the batch is a ${category} question — that is one idea, not a market page`,
      )
    }
  })
}

/**
 * Distinct documents, hashed the way the contract will hash them — across ALL batches at once.
 *
 * `questionHash` covers `closeTime` as well as the text, so this is a strictly weaker check than
 * the distinct-question-text one above — two markets on the same question at different closes are
 * legitimate and hash differently. It is here because it exercises the real codec against the real
 * data: a field that is a `number` where the document wants one, and a `closeTime` that converts to
 * whole unix seconds rather than to a fraction.
 *
 * It spans every batch rather than running per batch because the hash is what the CONTRACT commits
 * to, and the contract does not know which file an entry came from. Two batches that each hold
 * distinct hashes can still collide with each other, and that collision is the one that matters.
 */
test('every entry in every batch produces a distinct question hash under the current allowlist version', () => {
  const hashes = new Map<string, string>()
  for (const batch of BATCHES) {
    for (const q of batch.questions) {
      const closeTime = new Date(q.closeTime).getTime() / 1000
      assert.ok(
        Number.isInteger(closeTime),
        `${q.question} — closeTime has sub-second precision; the document stores unix SECONDS`,
      )
      const doc: QuestionDocument = {
        question: q.question,
        resolutionCriteria: q.resolutionCriteria,
        category: q.category,
        categoryVersion: CATEGORY_VERSION,
        resolutionSourceKind: q.resolutionSourceKind,
        resolutionSourceRef: q.resolutionSourceRef,
        closeTime,
        disputeWindowSeconds: q.disputeWindowSeconds,
        feeBps: q.feeBps,
      }
      const hash = questionHash(doc)
      const seen = hashes.get(hash)
      assert.ok(seen === undefined, `${batch.path} — "${q.question}" hashes to ${hash}, same as ${seen}`)
      hashes.set(hash, `"${q.question}" (${batch.path})`)
    }
  }
})

/**
 * No question text appears in two batches.
 *
 * The seeder in `micro-deploy` is idempotent BY QUESTION TEXT — it spreads every batch into one
 * array and skips a question a market already exists for. So a text duplicated across two files is
 * not a crash and not a double-created market: it is a silent precedence rule, where whichever
 * entry the spread happens to reach first decides the close time, the source and the fee, and the
 * other one is discarded without a word. A reviewer reading the losing file would be reading a
 * description of a market that does not exist.
 *
 * This does NOT check against `micro-deploy`'s own opening nine, and the file header explains why
 * that comparison stays manual: this repository does not depend on that one, and a copy of nine
 * question strings kept here to diff against would go stale and then report "no duplicates" from
 * memory. What CAN be checked mechanically is checked mechanically; what cannot is named in the
 * data file's header instead.
 */
test('no question text appears in more than one batch', () => {
  const seen = new Map<string, string>()
  for (const batch of BATCHES) {
    for (const q of batch.questions) {
      const first = seen.get(q.question)
      assert.ok(
        first === undefined,
        `"${q.question}" appears in both ${first} and ${batch.path}. The estate seeder is ` +
          `idempotent by question text, so only one of them would ever become a market and the ` +
          `other would be silently ignored.`,
      )
      seen.set(q.question, batch.path)
    }
  }
})
