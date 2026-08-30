/**
 * Short-horizon questions, researched 2026-08-14.
 *
 * ── WHAT MAKES THIS BATCH DIFFERENT FROM THE OTHER TWO ───────────────────────
 *
 * The estate's opening nine (`micro-deploy`, `scripts/seed/foresight-
 * questions.mjs`) and the eleven in `questions-2026h2.mjs` are good questions
 * that nearly all resolve a long way out. Measured against the live registry on
 * 2026-08-14: of twenty markets, the earliest close was 2026-08-21 and the
 * median was months away. A book made only of those is a book a visitor can
 * stake in and then has no reason to return to for a season, and it gives the
 * resolution machinery — the oracle, the dispute window, the settlement path —
 * almost nothing to exercise.
 *
 * All twelve entries here close between **2026-08-25 and 2026-09-15** — eleven
 * to thirty-two days from the day they were researched. That is the only thing
 * this batch does differently. The bar is unchanged, and it is worth restating
 * because a short horizon makes two of its four points HARDER rather than
 * easier.
 *
 * ── HOW A DEADLINE QUESTION CLOSES HERE ──────────────────────────────────────
 *
 * Four entries ask whether something happens BY a date — a launch, a release.
 * The existing batches close that shape AT the deadline, and their header notes
 * the consequence: the event can land early and the pool is one-sided for the
 * rest of the market's life.
 *
 * These close EARLIER — before the first scheduled opportunity, with the
 * deadline roughly a week later. MTG-I2 targets 27 August and the question runs
 * to 3 September, but the market closes 27 August at 14:00Z. That has two
 * effects and both are wanted. Nobody can stake on a launch they have already
 * watched, and an ordinary scrub-and-recycle — the single most likely way a
 * launch date moves — still resolves YES, so the question is about whether the
 * programme is really ready rather than about the weather on one afternoon.
 * The cost is that resolution comes days after close, which is what the dispute
 * window is for.
 *
 * ── THE BAR, WHICH IS THE ONE THE FIRST NINE SET ─────────────────────────────
 *
 *   1. **A close genuinely in the future and genuinely before the answer is
 *      public.** At this horizon that is a matter of minutes rather than
 *      months. The BLS publishes at 08:30 America/New_York and two entries
 *      below close at 12:29:00Z, one minute before; the ECB publishes at 14:15
 *      Europe/Frankfurt and that entry closes at 12:14:00Z. Those offsets are
 *      not decoration. A market still open when its answer is public is not a
 *      market, and at a four-week horizon there is no slack to absorb a
 *      mistake.
 *
 *   2. **A question nobody can argue about afterwards.** No "significant", no
 *      "major". Every threshold is a number and every subject is a named body.
 *      `resolutionCriteria` always says what NO means rather than leaving it to
 *      be inferred, and always says what happens when the source cannot be
 *      read.
 *
 *   3. **A named source of truth, recorded before the market opens.** foresight
 *      hashes `resolutionSourceRef` into `question_hash` and commits that to
 *      the contract (`../src/markets.ts`, `../src/questiondoc.ts`), so it
 *      cannot be changed afterwards even by an operator with a database
 *      connection.
 *
 *   4. **A reading, written down.** Every `observed` below carries a value, its
 *      date and the endpoint it came from. At this horizon the reading does
 *      more work than usual: a threshold 4% away over four weeks is a real
 *      question, and the same threshold over six months is not, so `observed`
 *      is what lets a reviewer tell one from the other. Several entries also
 *      state the DISTANCE to the threshold in the units the source publishes,
 *      because that is the number an approver actually needs.
 *
 * All readings were taken on **2026-08-14** from the endpoints named in each
 * entry, and every endpoint in this file was fetched on that date — including
 * the two that answer 404 today by design, which is the point of asking.
 *
 * ── THE ROUNDING TRAP, AND WHY ONE QUESTION IS PHRASED IN INDEX POINTS ───────
 *
 * The CPI entry asks whether an index level reaches 334.667 rather than whether
 * "inflation is 3.3 percent or higher", and the awkward phrasing is deliberate.
 * BLS publishes the twelve-month change rounded to one decimal, so a print of
 * "3.3%" is consistent with an unrounded 3.25% and with an unrounded 3.34%. A
 * market settled on the rounded figure is a market with an argument built into
 * it. The index is published to three decimals, the arithmetic from the
 * August 2025 base is fixed, and 334.667 IS a 3.3% twelve-month increase — so
 * the question is the same question, asked in units that cannot be disputed.
 * `REFUSALS[2]` — a question the operator could not settle from a source it
 * would cite in public — is what the rounded phrasing would have risked.
 *
 * ── DUPLICATES, CHECKED AGAINST BOTH EXISTING BATCHES ────────────────────────
 *
 * Six candidates were researched to a finished state and dropped:
 *
 *   * **A Nancy Grace Roman Space Telescope launch question** ("by
 *     2026-09-06"). The estate ALREADY runs "on or before 2026-09-30", and the
 *     shorter deadline strictly implies the longer one. Two nested questions on
 *     one launch is a page that looks padded. This was the strongest single
 *     candidate researched — NASA has pulled the launch nine months ahead of
 *     its committed date, leaving no schedule margin at all — and it was still
 *     dropped, because "already asked" beats "well-formed".
 *   * **A Bitcoin block-height question** ("≥ 965,500 by 2026-09-05"). The
 *     estate already runs "> 969,200 at 2026-09-30". Different numbers, same
 *     idea, and the batch already contains a difficulty question driven by the
 *     same hashrate. Dropped as a row rather than an idea.
 *   * **A second Bitcoin difficulty question** on the direction of the
 *     following retarget at height 965,664. Well-formed and close to even, but
 *     two difficulty markets in a twelve-question batch is the "ten variations
 *     of one theme" failure.
 *   * **A Bank of Japan rate question** for the 17-18 September meeting. The
 *     BoJ publishes its decision as a PDF with no stable machine-readable rate
 *     field, so settlement would rest on reading prose out of a document. The
 *     ECB entry below asks a comparable question against a page that states the
 *     rate in a table, and one central-bank question settled cleanly beats two
 *     where the second needs a human to squint.
 *   * **A CPython `v3.15.0rc2` tag question** (PEP 790 expects 2026-09-01, and
 *     that cycle has slipped against its own PEP more than once). Genuinely
 *     uncertain and cleanly resolvable, but the batch already carries two
 *     release-tag questions and a third makes the page look like a changelog.
 *   * **A Dutch Grand Prix winner question** for 23 August, structurally
 *     identical to the Italian Grand Prix entry that survived. One race, not
 *     two.
 *
 * Several more were rejected before they were written, and the reasons are
 * worth keeping because each is a class rather than a case: Firefox 155 and
 * Linux 7.3-rc1 are near-certainties and a near-certainty is not a market;
 * PostgreSQL 19.0 publishes only "September 2026" with no day, so "by its
 * stated date" would be doing no work; ISRO, ULA and CNSA publish no advance
 * date at all for the flights in this window, so no primary source could settle
 * them; and an Apple September event has no announcement on apple.com, which
 * would make it a rumour market.
 *
 * The two crypto spot entries are NOT duplicates of the existing three price
 * markets, and the distinction is the horizon rather than the threshold: the
 * existing BTC markets close 2026-10-01 and 2026-12-31 and the existing ETH
 * market closes 2026-12-01, the nearest of them 48 days out. These close in 25
 * and 32 days. That is a different instrument to a trader even where the
 * underlying is the same, and it is the specific gap this batch was written to
 * fill.
 *
 * ── THE GITHUB REF TRAP, MEASURED ───────────────────────────────────────────
 *
 * Two entries below ask whether a release tag exists, and both resolve from
 * `GET /repos/{owner}/{repo}/git/refs/tags/{name}`. That route does NOT behave
 * the way its name suggests, and the difference decides markets. Measured
 * against the live API on 2026-08-14:
 *
 *   * `bitcoin/bitcoin` `v31.0`, where the exact tag exists → HTTP 200 and the
 *     body is a JSON **object**, `{"ref":"refs/tags/v31.0", "object":{...}}`.
 *   * `kubernetes/kubernetes` `v1.37.0`, where the exact tag does NOT exist but
 *     `v1.37.0-alpha.0`, `v1.37.0-alpha.1` … `v1.37.0-rc.0` do → **HTTP 200**,
 *     and the body is a JSON **array** of those prefix matches.
 *   * `bitcoin/bitcoin` `v32.0rc1`, where nothing shares the prefix → HTTP 404.
 *
 * So "404 means the tag does not exist" is FALSE in general. It happens to hold
 * for `v32.0rc1` today only because no tag currently begins with that string,
 * and it is already false for `v1.37.0`, which answers 200 this minute while
 * Kubernetes 1.37 is unreleased. A criterion written as "YES on 200, NO on 404"
 * would settle the Kubernetes market YES on the day it opened.
 *
 * Both entries therefore require **HTTP 200 AND a JSON object AND `ref` equal
 * to the exact string `refs/tags/<tag>`**, and both say in terms that an array
 * response is a NO. This was very nearly shipped the wrong way round, so it is
 * written down here rather than left in the criteria alone.
 *
 * The neighbouring `git/matching-refs/tags/<tag>` route is prefix-matching by
 * documented design and must not be substituted for either.
 *
 * ── CATEGORIES ARE THE SERVICE'S, NOT THIS FILE'S ────────────────────────────
 *
 * `category` and `resolutionSourceKind` are checked against `../src/
 * categories.ts` at create time, and a wrong pairing is a 400 `bad_source_kind`
 * (`../src/markets.ts`). `src/seedquestions.test.ts` checks the same pairing
 * here, so the 400 is a red build rather than a failed seeding run.
 *
 * Two placements are worth defending. The **CPI** entry sits under
 * `market_prices` with `price_index`, which is the one entry in this file where
 * the category's own sentence fits without argument — the CPI is a price index.
 * The **unemployment rate** entry does NOT: it is not a price and no source
 * kind under `market_prices` describes it. It sits under
 * `scheduled_public_events` with `primary_source_publication`, because what is
 * actually being asked is what a named body will publish in a release whose
 * date and time are fixed in advance. The **ECB** entry follows the precedent
 * the existing FOMC markets set: `regulator_publication` is permitted under
 * `market_prices` and under nothing else, so the allowlist itself places
 * central-bank rate decisions there.
 */

/** @typedef {import('./questions-short-202608.d.mts').SeedQuestion} SeedQuestion */

/** Machine-readable instant: the number is there or it is not. */
const ONE_DAY = 86_400

/** Human-published document: a week for somebody to read it and object. */
const ONE_WEEK = 604_800

/** The estate's standard, taken from the losing pool. Matches both existing batches. */
const FEE_BPS = 200

/** @type {readonly SeedQuestion[]} */
export const FORESIGHT_QUESTIONS_SHORT_202608 = [
  // ── protocol_network ───────────────────────────────────────────────────────
  {
    question:
      'Will the Bitcoin mining difficulty in effect at block height 963,648 be below 124,000,000,000,000?',
    cover:
      'a heavy mechanical governor with weights on hinged arms, settling to a lower position',
    resolutionCriteria:
      'YES if the difficulty in effect for the retarget epoch beginning at block height 963,648 is ' +
      'strictly less than 124000000000000. NO if it is equal to or greater than that figure. The ' +
      'reading is taken from the source endpoint, which returns an array of retarget records: take ' +
      'the element whose second field equals 963648 and read its third field, the difficulty. If ' +
      'that element is absent, the same difficulty as reported by the block at height 963,648 on ' +
      'any two independent Bitcoin block explorers settles it, because difficulty is a property of ' +
      'the chain and not of the endpoint. Only Bitcoin mainnet counts; no testnet and no fork.',
    category: 'protocol_network',
    resolutionSourceKind: 'block_explorer',
    resolutionSourceRef: 'https://mempool.space/api/v1/mining/difficulty-adjustments/3m',
    closeTime: '2026-08-28T00:00:00.000Z',
    disputeWindowSeconds: ONE_DAY,
    feeBps: FEE_BPS,
    observed:
      'Read 2026-08-14: tip height 962,462; difficulty 127,479,855,693,691.4, set at height 961,632 ' +
      'on 2026-08-08. The epoch was 41.2% elapsed with 1,186 blocks left and mempool.space projected ' +
      'the next adjustment at -2.61%, which lands ABOVE the threshold; Luxor\'s Hashrate Index ' +
      'roundup of 2026-08-10 projected -3.07%, which lands below it. The threshold of 124T is -2.73% ' +
      'from current and therefore sits BETWEEN the two published forecasts. In block-time terms YES ' +
      'needs the remaining blocks to average 617.4s or slower; the epoch to date had averaged 616.8s. ' +
      'A tenth of a percent of headroom, with two reputable forecasts on opposite sides of it.',
  },
  {
    question: 'Will the Solana mainnet-beta cluster be in epoch 1025 or higher at 2026-09-01T00:00:00Z?',
    cover: 'a ring of evenly spaced notches with a single marker advancing around it',
    resolutionCriteria:
      'YES if a getEpochInfo call to the Solana mainnet-beta JSON-RPC endpoint named as the source, ' +
      'made once at or after the close time, returns a result.epoch of 1025 or higher. NO if it ' +
      'returns 1024 or lower. Equivalently and identically, YES if result.absoluteSlot is at least ' +
      '442800000, since epoch N begins at slot N times 432000; the two readings cannot disagree. ' +
      'Only the mainnet-beta cluster counts; devnet and testnet do not. If that endpoint does not ' +
      'answer, the same epoch number from any two independent Solana RPC providers settles it, ' +
      'because the epoch is a property of the cluster and not of the endpoint.',
    category: 'protocol_network',
    resolutionSourceKind: 'chain_rpc',
    resolutionSourceRef: 'https://api.mainnet-beta.solana.com',
    closeTime: '2026-09-01T00:00:00.000Z',
    disputeWindowSeconds: ONE_DAY,
    feeBps: FEE_BPS,
    observed:
      'Read 2026-08-14T17:48Z from that endpoint: epoch 1016, absoluteSlot 439,272,053, slotIndex ' +
      '360,053 of 432,000. Epoch 1025 begins at slot 442,800,000, so 3,527,947 slots have to pass in ' +
      'the 1,491,084 seconds to close — an average of 0.42264 s/slot. Measured over the last ten ' +
      'full epochs the cluster ran at 0.42143 s/slot, which is faster than required by 0.29%, or ' +
      'about 1.2 hours of slack across a 17-day horizon. Nine of the last ten epoch windows would ' +
      'have made it and one would not. Slot time is not a constant here: it moves with client ' +
      'releases, and Anza shipped agave v4.2.0 on 2026-08-07 and v4.2.1 on 2026-08-13.',
  },
  {
    question:
      'Will the tag v32.0rc1 exist in the bitcoin/bitcoin GitHub repository at 2026-09-12T00:00:00Z?',
    cover: 'a paper tag on a short string, tied to the topmost of a stack of layered plates',
    resolutionCriteria:
      'YES if the source endpoint, read once at or after the close time, answers HTTP 200 AND the ' +
      'response body is a JSON object whose ref field is exactly the string refs/tags/v32.0rc1. NO ' +
      'in every other case, which specifically includes HTTP 404 and includes an HTTP 200 whose body ' +
      'is a JSON ARRAY: that route returns an array of prefix matches when the exact tag is absent, ' +
      'so a 200 alone does not mean the tag exists. The neighbouring git/matching-refs route ' +
      'prefix-matches by design and does not substitute for this one. A tag that exists and is ' +
      'deleted before the close reads NO, and a tag created after the close does not count, because ' +
      'the question asks about the state of the repository at one named instant. If GitHub cannot be ' +
      'reached for 48 hours after the close, the same tag listed on any two independent mirrors of ' +
      'the repository settles it.',
    category: 'protocol_network',
    resolutionSourceKind: 'protocol_publication',
    resolutionSourceRef: 'https://api.github.com/repos/bitcoin/bitcoin/git/refs/tags/v32.0rc1',
    closeTime: '2026-09-12T00:00:00.000Z',
    disputeWindowSeconds: ONE_DAY,
    feeBps: FEE_BPS,
    observed:
      'Read 2026-08-14: that endpoint answers HTTP 404 — the tag does not exist — and the repository ' +
      'has branches 28.x through 31.x with no 32.x. Bitcoin Core issue #35122 ("Release Schedule for ' +
      '32.0", opened 2026-04-20) states under the heading 2026-09-10: "Split off 32.x branch from ' +
      'master" and "Start RC cycle, tag and release v32.0rc1". The close is two days after that ' +
      'target, and the project\'s record against its own published rc1 dates is the reason this is ' +
      'uncertain rather than decided: 28.0 shipped rc1 on the day, 29.0 slipped 7 days, 30.0 shipped ' +
      'on the day, 31.0 slipped 2 days. Two of the last four cycles would have resolved YES here.',
  },

  // ── market_prices ──────────────────────────────────────────────────────────
  {
    question:
      'Will the US Consumer Price Index for All Urban Consumers (CPI-U, all items, US city average, not seasonally adjusted) for the August 2026 reference month be at or above 334.667?',
    cover: 'a shopping basket drawn as simple stacked geometric solids, rising on one side of a beam',
    resolutionCriteria:
      'YES if the value the Bureau of Labor Statistics publishes for series CUUR0000SA0 at year 2026 ' +
      'period M08 is greater than or equal to 334.667. NO if it is strictly less. The figure is read ' +
      'from the source API as the value field of the matching element of Results.series[0].data. ' +
      '334.667 is exactly a 3.3 percent twelve-month increase on the published August 2025 value of ' +
      '323.976; the question is asked in index points rather than as a percentage because BLS rounds ' +
      'the published percentage change to one decimal and the index is published to three, so the ' +
      'index cannot be argued about. The FIRST value published for August 2026 settles the market; a ' +
      'later revision or a rebasing does not reopen it. If BLS delays the release beyond 2026-10-11 ' +
      'or does not publish an August 2026 value at all, as happened during the 2025 lapse in ' +
      'appropriations, the market is voided and stakes are returned.',
    category: 'market_prices',
    resolutionSourceKind: 'price_index',
    resolutionSourceRef: 'https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0',
    closeTime: '2026-09-11T12:29:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'Read 2026-08-14 from that API: July 2026 = 333.918, August 2025 = 323.976, giving a July ' +
      'twelve-month change of 3.365% which BLS printed as 3.4%. The threshold needs the August index ' +
      'to reach 334.667, a rise of 0.224% on the month. For scale: July 2026 was -0.010% on the ' +
      'month and August 2025 was +0.287%, so the threshold sits inside the recent monthly range ' +
      'rather than at the edge of it. The 2026 path so far: 2.4, 2.4, 3.3, 3.8, 4.2, 3.5, 3.4. Close ' +
      'is 12:29:00Z on 2026-09-11, one minute before the 08:30 America/New_York release confirmed on ' +
      'the BLS CPI schedule page for the August 2026 reference month.',
  },
  {
    question: 'Will the Coinbase Exchange BTC-USD spot price be at or above 66,000 USD at 2026-09-08T16:00:00Z?',
    cover: 'a single thick disc standing on edge, held at the left of a wide empty field',
    resolutionCriteria:
      'YES if the price field returned by the source endpoint, on the first successful read at or ' +
      'after 2026-09-08T16:00:00Z, parses to a number greater than or equal to 66000. NO if it is ' +
      'strictly less. The figure is Coinbase Exchange\'s published USD spot price for the BTC-USD ' +
      'product and no other venue, index or pair is consulted; another exchange printing a different ' +
      'number does not change the answer, because the question names the venue. If Coinbase does not ' +
      'answer for 24 hours after that instant, the market is voided and stakes are returned rather ' +
      'than settled from a substitute venue, because a substitute venue is a different question.',
    category: 'market_prices',
    resolutionSourceKind: 'exchange_api',
    resolutionSourceRef: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    closeTime: '2026-09-08T15:59:00.000Z',
    disputeWindowSeconds: ONE_DAY,
    feeBps: FEE_BPS,
    observed:
      'Read 2026-08-14T17:49:50Z from that endpoint: 63,053.23 USD, corroborated the same minute by ' +
      'Kraken XXBTZUSD at 63,131.70. The threshold is 4.7% above spot over 25 days — roughly half a ' +
      'standard deviation at BTC\'s recent realised volatility, which is the band where a question ' +
      'is genuinely open. Coinbase 24-hour stats at the reading: open 63,070.02, high 63,635.97, low ' +
      '62,468.21. Motivated by CoinDesk on 2026-08-14 reporting bitcoin slipping after the US ' +
      'inflation print with ETFs seeing August\'s first two-day drawdown.',
  },
  {
    question: 'Will the Coinbase Exchange ETH-USD spot price be at or above 2,000 USD at 2026-09-15T16:00:00Z?',
    cover: 'two slim tetrahedra meeting point to point, standing in a wide empty field',
    resolutionCriteria:
      'YES if the price field returned by the source endpoint, on the first successful read at or ' +
      'after 2026-09-15T16:00:00Z, parses to a number greater than or equal to 2000. NO if it is ' +
      'strictly less. The figure is Coinbase Exchange\'s published USD spot price for the ETH-USD ' +
      'product and no other venue, index or pair is consulted. If Coinbase does not answer for 24 ' +
      'hours after that instant, the market is voided and stakes are returned rather than settled ' +
      'from a substitute venue.',
    category: 'market_prices',
    resolutionSourceKind: 'exchange_api',
    resolutionSourceRef: 'https://api.exchange.coinbase.com/products/ETH-USD/ticker',
    closeTime: '2026-09-15T15:59:00.000Z',
    disputeWindowSeconds: ONE_DAY,
    feeBps: FEE_BPS,
    observed:
      'Read 2026-08-14T17:49:49Z from that endpoint: 1,881.50 USD, corroborated the same minute by ' +
      'Kraken XETHZUSD at 1,883.56. The threshold is 6.3% above spot over 32 days. It is a round ' +
      'number currently BELOW spot\'s reach rather than a level far above it, and ETH\'s higher ' +
      'realised volatility makes this a comparable proposition to the BTC entry despite the larger ' +
      'percentage gap. Coinbase 24-hour stats at the reading: open 1,874.94, high 1,891.26, low ' +
      '1,862.09.',
  },
  {
    question:
      'Will the European Central Bank deposit facility rate be at or above 2.50 percent following the Governing Council monetary policy decision of 10 September 2026?',
    cover: 'a set of stepped blocks of increasing height, with the topmost one separated by a gap',
    resolutionCriteria:
      'YES if, after the Governing Council\'s monetary policy decision of 10 September 2026, the ' +
      'deposit facility rate shown on the ECB key interest rates page named as the source is 2.50 ' +
      'percent or higher. NO if it is below 2.50 percent, including the case where the Governing ' +
      'Council leaves the rate unchanged at its current 2.25 percent. Only the DEPOSIT FACILITY rate ' +
      'settles this; the main refinancing operations rate and the marginal lending facility rate are ' +
      'not consulted. If the decision is postponed past 2026-09-30 or the meeting does not take ' +
      'place, the market is voided and stakes are returned. If the page cannot be read, the rate ' +
      'stated in the ECB\'s own monetary policy decisions press release for that date settles it.',
    category: 'market_prices',
    resolutionSourceKind: 'regulator_publication',
    resolutionSourceRef:
      'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/key_ecb_interest_rates/html/index.en.html',
    closeTime: '2026-09-10T12:14:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'Read 2026-08-14 from that page: deposit facility 2.25%, main refinancing operations 2.40%, ' +
      'marginal lending 2.65%, all effective 17 June 2026 — a hike from 2.00% and the first since ' +
      '2023. Rates were held at the 23 July meeting. The threshold is therefore exactly one 25bp ' +
      'step away. This is the most consensus-favoured question in the batch and is included as such ' +
      'rather than as a coin flip: a Reuters poll of economists published 2026-08-13 has the ECB ' +
      'hiking to 2.50% in September, and Lagarde signalled at the July press conference that a move ' +
      'was possible. It is here because it is unambiguous and settles from a table, and because a ' +
      'book of nothing but 50/50s is its own kind of distortion. Close is 12:14:00Z, one minute ' +
      'before the 14:15 Europe/Frankfurt publication time the ECB states for monetary policy ' +
      'decisions; the ECB calendar confirms the 9-10 September Governing Council meeting.',
  },

  // ── scheduled_public_events ────────────────────────────────────────────────
  {
    question:
      'Will the US unemployment rate for the August 2026 reference month, as published by the Bureau of Labor Statistics in series LNS14000000, be 4.2 percent or higher?',
    cover: 'a row of upright rectangular markers with one gap left open near the middle',
    resolutionCriteria:
      'YES if the value the Bureau of Labor Statistics publishes for series LNS14000000 — the ' +
      'seasonally adjusted civilian unemployment rate — at year 2026 period M08 is greater than or ' +
      'equal to 4.2. NO if it is 4.1 or lower. BLS publishes this series to one decimal place, so ' +
      'there is no rounding to resolve. The figure is read from the source API as the value field of ' +
      'the matching element of Results.series[0].data, and is cross-checkable against Table A of the ' +
      'Employment Situation news release for that month. The FIRST value published for August 2026 ' +
      'settles the market; the annual seasonal-adjustment revision does not reopen it. If BLS delays ' +
      'the release beyond 2026-10-04 or does not publish an August 2026 value at all, as happened ' +
      'during the 2025 lapse in appropriations, the market is voided and stakes are returned.',
    category: 'scheduled_public_events',
    resolutionSourceKind: 'primary_source_publication',
    resolutionSourceRef: 'https://api.bls.gov/publicAPI/v2/timeseries/data/LNS14000000',
    closeTime: '2026-09-04T12:29:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'Read 2026-08-14 from that API: July 2026 = 4.1, and before it June 4.2, May 4.3, April 4.3, ' +
      'March 4.3, February 4.4, January 4.3. The threshold is one tenth above the last print and is ' +
      'exactly where the published consensus sits — Trading Economics carries a forecast of 4.2% for ' +
      'August against a 4.1% prior. A threshold sitting on consensus is as close to an even question ' +
      'as this category offers. The tension is real rather than statistical: July payrolls came in ' +
      'at -23,000 against a +80,000 consensus on 2026-08-07, so the household survey rate fell in ' +
      'the same month the establishment survey shed jobs. Close is 12:29:00Z on 2026-09-04, one ' +
      'minute before the 08:30 America/New_York release of the Employment Situation for August 2026.',
  },
  {
    question:
      'Will the MTG-I2 weather satellite lift off aboard an Ariane 6 from Europe\'s Spaceport in French Guiana on or before 2026-09-03T23:59:59Z?',
    cover: 'a tall slender tapering form on a launch table, with a broad calm field of sky beside it',
    resolutionCriteria:
      'YES if the European Space Agency reports, on the Meteosat Third Generation mission page named ' +
      'as the source, that MTG-I2 launched on an Ariane 6 from Europe\'s Spaceport with a liftoff at ' +
      'or before 2026-09-03T23:59:59Z. NO if that page reports no MTG-I2 launch by then, or reports ' +
      'a liftoff after that instant, or reports a launch failure in which the vehicle did not leave ' +
      'the pad. Lift-off is the criterion and mission outcome is not: a vehicle that leaves the pad ' +
      'and is subsequently lost still resolves YES, because the question asks whether it flew and ' +
      'not whether it worked. Only this launch counts; a different MTG spacecraft does not. If that ' +
      'page cannot be read, an ESA press release on the ESA newsroom index reporting the liftoff ' +
      'settles it, since ESA is the body that owns the fact either way.',
    category: 'scheduled_public_events',
    resolutionSourceKind: 'official_announcement',
    resolutionSourceRef:
      'https://www.esa.int/Applications/Observing_the_Earth/Meteorological_missions/meteosat_third_generation',
    closeTime: '2026-08-27T14:00:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'Read 2026-08-14: ESA press release N° 38-2026 of 10 August 2026 states "On 27 August, MTG-I2 ' +
      'will be launched on board an Ariane 6 rocket from Europe\'s Spaceport in French Guiana", and ' +
      'the MTG programme page lists "MTG-I2: 27 August 2026 from Kourou, French Guiana on Ariane 6". ' +
      'Neither ESA nor Arianespace publishes a liftoff TIME, which is itself a signal the timeline is ' +
      'not fully locked; Spaceflight Now\'s schedule gives a window opening 20:10Z. This is Ariane ' +
      '6\'s ninth flight and its FIRST to geostationary transfer orbit — a new profile with a long ' +
      'coast and an upper-stage reignition — into squally late-August weather at Kourou. The deadline ' +
      'is a week past the target, so an ordinary scrub-and-recycle still resolves YES and only a ' +
      'real stand-down resolves NO. Close is 14:00:00Z on launch day, 11:00 local, hours before any ' +
      'plausible window: the published time is third-party, so the margin is sized for that.',
  },
  {
    question:
      'Will the Kubernetes project publish a release tagged exactly v1.37.0 on or before 2026-08-31T23:59:59Z?',
    cover: 'seven identical hexagonal tiles laid flush in a row, with an eighth being set into place',
    resolutionCriteria:
      'YES if the source endpoint, read once at or after 2026-08-31T23:59:59Z, answers HTTP 200 AND ' +
      'the response body is a JSON object whose ref field is exactly the string refs/tags/v1.37.0. ' +
      'NO in every other case, which specifically includes HTTP 404 and includes an HTTP 200 whose ' +
      'body is a JSON ARRAY: that route returns an array of prefix matches when the exact tag is ' +
      'absent, and it answers 200 with such an array today because the v1.37.0-alpha and ' +
      'v1.37.0-rc.0 tags exist. A pre-release tag therefore never settles this YES, which is the ' +
      'whole question. If GitHub cannot be reached for 48 hours after the close, a v1.37.0 entry on ' +
      'the Kubernetes project\'s own releases page settles it.',
    category: 'scheduled_public_events',
    resolutionSourceKind: 'primary_source_publication',
    resolutionSourceRef: 'https://api.github.com/repos/kubernetes/kubernetes/git/refs/tags/v1.37.0',
    closeTime: '2026-08-25T20:00:00.000Z',
    disputeWindowSeconds: ONE_DAY,
    feeBps: FEE_BPS,
    observed:
      'Read 2026-08-14: the newest 1.37 artefact is v1.37.0-rc.0, published 2026-08-06, and the ' +
      'latest stable is v1.36.3. No rc.1 exists yet. The SIG Release schedule for the cycle lists ' +
      '"v1.37.0 released ... Wednesday 26th August 2026", preceded by rc.0 on 5 August and rc.1 on ' +
      '19 August, and describes itself as "The v1.37 release cycle is proposed as follows" — the ' +
      'project\'s own hedge. rc.0 already slipped a day against that schedule and rc.1 had not ' +
      'appeared as of the reading. The deadline of 31 August is placed so that shipping on time or a ' +
      'few days late resolves YES, while the project\'s documented remedy for a release-blocking ' +
      'failure during RC burndown — a one-week slip, which would land on 2 September — resolves NO.',
  },
  {
    question:
      'Will the winner of the 2026 Formula 1 Italian Grand Prix at Monza be a Mercedes driver?',
    cover: 'a long banked curve of track drawn as one flat ribbon, with a chequered band across one end',
    resolutionCriteria:
      'YES if the official Formula 1 race results for the 2026 Italian Grand Prix record the ' +
      'classified first-place finisher as driving for Mercedes. NO if they record any other ' +
      'constructor, or if no result is classified. The team named in the results table is what ' +
      'settles this, so a post-race disqualification or penalty that changes the classified winner ' +
      'changes the answer, and the classification standing at the end of the FIA\'s appeal period is ' +
      'the one used. The question is about a constructor and not about any individual driver: which ' +
      'of Mercedes\' drivers wins is irrelevant. If the race is cancelled or not held in 2026, the ' +
      'market is voided and stakes are returned.',
    category: 'scheduled_public_events',
    resolutionSourceKind: 'primary_source_publication',
    resolutionSourceRef: 'https://www.formula1.com/en/results/2026/races',
    closeTime: '2026-09-06T10:30:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'Read 2026-08-14 from formula1.com: the Italian Grand Prix runs 4-6 September 2026 at Monza ' +
      'with the race session listed at 13:00 on 6 September. Constructors\' standings after 11 ' +
      'rounds: Mercedes 379, Ferrari 307, McLaren 220, Red Bull 177; race wins by team: Mercedes 8, ' +
      'Ferrari 2, McLaren 1. Mercedes has won eight of eleven but is not sweeping — Ferrari and ' +
      'McLaren have both beaten them, McLaren took the most recent round in Hungary on 26 July, and ' +
      'Monza is a low-downforce power circuit and Ferrari\'s home race. That prices nearer 65/35 ' +
      'than 95/5. Distinct from the existing Mercedes constructors\'-championship market: one race ' +
      'is a different event with a different answer, and this one closes in three weeks rather than ' +
      'at the end of the season. Close is 10:30:00Z because the site renders session times in a ' +
      'selectable timezone and the 13:00 figure is ambiguous between UTC and track time (CEST, ' +
      'i.e. 11:00Z); 10:30Z is before the earlier of the two readings.',
  },
  {
    question:
      'Will Vega-C flight VV30, carrying FLEX and Copernicus Sentinel-3C, lift off from Europe\'s Spaceport on or before 2026-09-22T23:59:59Z?',
    cover: 'a broad flat leaf shape beside a small satellite bus with two straight panels extended',
    resolutionCriteria:
      'YES if the European Space Agency reports, on the FLEX mission page named as the source, that ' +
      'FLEX launched on a Vega-C from Europe\'s Spaceport with a liftoff at or before ' +
      '2026-09-22T23:59:59Z. NO if that page reports no launch by then, or a liftoff after that ' +
      'instant, or a failure in which the vehicle did not leave the pad. Lift-off is the criterion ' +
      'and mission outcome is not: a vehicle that leaves the pad and is subsequently lost still ' +
      'resolves YES. If the two satellites are separated onto different flights, the flight carrying ' +
      'FLEX is the one that counts, because FLEX is the mission the source page reports on. If that ' +
      'page cannot be read, an ESA press release on the ESA newsroom index reporting the liftoff ' +
      'settles it.',
    category: 'scheduled_public_events',
    resolutionSourceKind: 'official_announcement',
    resolutionSourceRef: 'https://www.esa.int/Applications/Observing_the_Earth/FLEX',
    closeTime: '2026-09-14T20:00:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'Read 2026-08-14: the ESA FLEX mission page fact box states "Date: 15 September 2026", "Site: ' +
      'Kourou, French Guiana", "Rocket: Vega-C", and ESA press release N° 35-2026 of 20 July 2026, ' +
      'updated 30 July to confirm the date, says liftoff "is expected to take place on 14 September ' +
      '2026 (22:21 local time, 03.21 CEST on 15 September)" — 01:21Z on 15 September. Vega-C is the ' +
      'vehicle that failed on VV22 in December 2022 and was grounded for two years; its cadence is ' +
      'low and its record thin. This is a dual-payload night launch from the same range that flies ' +
      'an Ariane 6 GTO campaign two weeks earlier, so range and team availability are a real ' +
      'constraint rather than a theoretical one. The deadline is a week past the target, so a scrub ' +
      'still resolves YES. Close is 20:00:00Z on 14 September, over five hours before the published ' +
      'liftoff instant.',
  },
]
