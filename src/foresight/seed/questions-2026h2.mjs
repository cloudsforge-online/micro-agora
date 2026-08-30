/**
 * Eleven more questions, researched 2026-08-11.
 *
 * ── WHY THIS FILE IS HERE AND NOT WHERE THE FIRST NINE ARE ───────────────────
 *
 * The estate's opening nine live in `micro-deploy` at `scripts/seed/
 * foresight-questions.mjs`, and its header gives the reason they are a data
 * file rather than literals inside the seeder: **everything in one of these
 * entries is RESEARCH, and research is the expensive part.** The twenty lines
 * that POST them can be rewritten in an hour; the close dates, the resolution
 * sources and the readings taken to make each question genuinely uncertain
 * cannot.
 *
 * That argument is why this batch is committed HERE, in the service that owns
 * the rules the entries have to satisfy. `categories.ts` decides which
 * categories exist and which source kind may settle each of them; `markets.ts`
 * decides that a close time in the past is a 400 and that a fee above 1,000bps
 * is a 400. A question file sitting next to those files can be — and is —
 * CHECKED against them by this repository's own suite (`src/seedquestions.
 * test.ts`), on every push, without a database, a chain or a running estate. In
 * the deploy repository the same array is unverifiable prose until the day
 * somebody posts it and reads a 400 off the wire.
 *
 * The shape is deliberately byte-compatible with `FORESIGHT_QUESTIONS`, down to
 * the `cover` brief and the `observed` note, so the estate seeder consumes this
 * batch by spreading it and nothing else changes. The export is NAMED for the
 * batch rather than for the concept precisely so that both arrays can be in
 * scope at once.
 *
 * ── THE BAR, WHICH IS THE ONE THE FIRST NINE SET ─────────────────────────────
 *
 *   1. **A close time genuinely in the future**, and — where the resolving
 *      event happens at a known INSTANT — genuinely before it. The Fed
 *      publishes at 18:00Z and this file closes that market at 17:59Z; the
 *      S&P 500 prints its year-end level at the 21:00Z bell and this file
 *      closes an hour earlier; the World Series market closes before the first
 *      pitch of the postseason, not after the pennants are decided. A market
 *      still open when its answer is public is not a market.
 *
 *      Questions of the form "will X have happened BY <date>" close AT that
 *      date, which is the shape the first nine already use for Glamsterdam and
 *      for block height. The event can land early and the pool is one-sided
 *      afterwards; that is inherent to a deadline question and is not fixable
 *      by moving the close.
 *
 *   2. **A question nobody can argue about afterwards.** No "significant", no
 *      "major", no "widely regarded". Every threshold is a number and every
 *      subject is a named body. `resolutionCriteria` always says what NO means
 *      rather than leaving it to be inferred, and always says what happens when
 *      the source cannot be read.
 *
 *   3. **A named source of truth, recorded before the market opens.** foresight
 *      hashes `resolutionSourceRef` into `question_hash` and commits that to
 *      the contract (`../src/markets.ts`, `../src/questiondoc.ts`), so the
 *      source cannot be changed afterwards even by an operator with a database
 *      connection. That is what makes naming it worth doing.
 *
 *   4. **A reading, written down.** "Above 8,000" means nothing without "7,760
 *      on the day". Each entry's `observed` gives the value, its date and the
 *      endpoint, so a reader can check that the threshold was set to be
 *      UNCERTAIN rather than set to be already true. A market whose answer was
 *      known at open is not a market; it is an advertisement.
 *
 * All readings were taken on **2026-08-11** from the sources named in each
 * entry. Several entries name a corroborating second source in `observed` and
 * say when the authoring reading was second-hand, which is a fact about the
 * reading and never about the settlement: the resolution source is always the
 * body that owns the number.
 *
 * ── NO DUPLICATES OF THE FIRST NINE, CHECKED ONE BY ONE ──────────────────────
 *
 * Three candidates were written and then dropped because the estate already
 * runs the question:
 *
 *   * a September FOMC market — `FORESIGHT_QUESTIONS` already asks whether that
 *     meeting LOWERS the range. This batch asks about the **December 8-9**
 *     meeting instead, and asks about the upper limit rather than the
 *     direction, so the two are independent rather than complementary.
 *   * a Glamsterdam market with a 2027-03-31 deadline — the existing one has a
 *     2027-01-01 deadline, and one strictly implies the other. Two nested
 *     questions on one upgrade is a page that looks padded.
 *   * an ETH-USD price market — the existing one is 2,500 USD at 2026-12-01 and
 *     a second at a different threshold weeks later adds a row, not an idea.
 *     The BTC-USD entry below survives because the existing BTC market closes
 *     2026-10-01 and this one is a year-end question.
 *
 * ── AND ONE REFUSED OUTRIGHT ─────────────────────────────────────────────────
 *
 * A market on whether the SEC's "Regulation Crypto" proposing release reaches
 * the Federal Register by 2026-10-15 was researched and is NOT here. The
 * Federal Register API is the best machine-readable source in the whole batch,
 * and that is exactly the problem: the condition is a TITLE MATCH, and a
 * commission that files under "Offers and Sales of Certain Crypto Assets"
 * settles a market NO on a technicality while every reader can see the rule was
 * published. `REFUSALS[2]` — a question the operator could not settle from a
 * source it would cite in public — is engaged by the settlement mechanism even
 * though it is not engaged by the subject.
 *
 * ── CATEGORIES ARE THE SERVICE'S, NOT THIS FILE'S ────────────────────────────
 *
 * `category` and `resolutionSourceKind` are checked against `../src/
 * categories.ts` at create time, and a wrong pairing is a 400 `bad_source_kind`
 * (`../src/markets.ts`). `src/seedquestions.test.ts` checks the same pairing
 * here, so the 400 is a red build rather than a failed seeding run.
 *
 * The federal funds entry is under `market_prices` and it is worth saying why,
 * because a target range is not a traded instrument on a literal reading of
 * that category's sentence. `regulator_publication` is a permitted source kind
 * under `market_prices` and under NOTHING ELSE, so the allowlist itself places
 * rate decisions here. The existing September FOMC market makes the same call.
 *
 * ── DISPUTE WINDOWS ARE NOT ALL THE SAME, DELIBERATELY ───────────────────────
 *
 * A question settled off a machine-readable endpoint read at a single instant
 * needs a day. One settled off a document a human body publishes on its own
 * schedule needs longer, because the window has to outlive the gap between the
 * event and its publication. 86,400s for the first kind, 604,800s for the
 * second. The ceiling is 2,592,000s (`../src/server.ts`).
 *
 * ── OUTCOMES ARE BINARY BECAUSE THE SERVICE IS ───────────────────────────────
 *
 * `stake(uint8)` takes 0 = YES and 1 = NO and there is no N-ary form
 * (`../src/server.ts`, `../src/migrations.ts`). Every question below is phrased
 * so that YES and NO are exhaustive and mutually exclusive.
 */

/** @typedef {{
 *   question: string,
 *   cover: string,
 *   resolutionCriteria: string,
 *   category: 'protocol_network' | 'market_prices' | 'scheduled_public_events',
 *   resolutionSourceKind: string,
 *   resolutionSourceRef: string,
 *   closeTime: string,
 *   disputeWindowSeconds: number,
 *   feeBps: number,
 *   observed: string,
 * }} SeedQuestion
 */

/** A day, in seconds — for a question a machine answers at an instant. */
const ONE_DAY = 86_400
/** A week — for a question a human institution answers by publishing a document. */
const ONE_WEEK = 604_800

/** The estate's default fee on the losing pool, stated rather than defaulted. */
const FEE_BPS = 200

/** @type {readonly SeedQuestion[]} */
export const FORESIGHT_QUESTIONS_2026H2 = [
  /* ─────────────────────────────── market_prices ─────────────────────────────
   * Source kinds available: exchange_api, price_index, regulator_publication.
   */
  {
    question:
      'Will the Coinbase BTC-USD spot price be at or above 75,000 USD at 2026-12-31T23:59:59Z?',
    cover: 'a faceted metal disc resting on a stepped stone pedestal, with empty space above it',
    resolutionCriteria:
      'YES if the `price` field of the Coinbase Exchange BTC-USD ticker, read once at or after ' +
      '2026-12-31T23:59:59Z, is greater than or equal to 75000.00. NO if it is lower, and NO if ' +
      'the BTC-USD product is no longer listed on Coinbase Exchange at that instant. Coinbase is ' +
      'the venue named at open and no other venue settles this question, whatever it prints. If ' +
      'the endpoint does not answer, the reading is retried every 60 seconds for six hours and the ' +
      'first successful response settles it; if none succeeds in that window the market resolves ' +
      'NO, because the question asks what Coinbase printed and the answer is then that it printed ' +
      'nothing.',
    category: 'market_prices',
    resolutionSourceKind: 'exchange_api',
    resolutionSourceRef: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker — field `price`',
    closeTime: '2026-12-31T23:59:59.000Z',
    disputeWindowSeconds: ONE_DAY,
    feeBps: FEE_BPS,
    observed:
      'BTC-USD `price` was 63,918.23 at 2026-08-11T14:33:14Z, read from the endpoint named above. ' +
      'Corroborated the same day by CoinGecko (64,148 at 14:08:30Z) and by coindesk.com/price/' +
      'bitcoin (64,153.46). The threshold is 17.3% above that reading, and CoinDesk\'s markets ' +
      'blog on 2026-08-11 recorded bitcoin failing to hold 65,000 for a fourth consecutive day — ' +
      'so the asset was range-bound BELOW the threshold when the question was written. Distinct ' +
      'from the existing 70,000-at-2026-10-01 market: different threshold, and a close three ' +
      'months later.',
  },
  {
    question:
      'Will the official closing level of the S&P 500 index on the last trading day of 2026 be at ' +
      'or above 8,000.00?',
    cover: 'a rising staircase of stacked rectangular bars beneath a single thin ruled line',
    resolutionCriteria:
      'YES if S&P Dow Jones Indices publishes an official closing level for the S&P 500 (SPX) for ' +
      'the last regular NYSE trading session of calendar year 2026 that is greater than or equal ' +
      'to 8000.00. NO if that published close is below 8000.00. The figure is the index owner\'s ' +
      'own official close, not an intraday high, not a futures print and not a level quoted by a ' +
      'data vendor. If S&P Dow Jones Indices has not published it within five business days of ' +
      'that session, the closing level printed for the same session in the Wall Street Journal ' +
      'market data pages settles it; if neither is available the market resolves NO.',
    category: 'market_prices',
    resolutionSourceKind: 'price_index',
    resolutionSourceRef:
      'https://www.spglobal.com/spdji/en/indices/equity/sp-500/ — the official S&P 500 (SPX) ' +
      'closing level for the last regular NYSE trading session of 2026',
    closeTime: '2026-12-31T20:00:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'The S&P 500 stood at 7,759.57 on 2026-08-11, with an all-time high of 7,793.68 set earlier ' +
      'that month and a 20.38% year-over-year gain, read from tradingeconomics.com/united-states/' +
      'stock-market; SPY on NYSE Arca was 773.70 at 10:15 EDT the same day (stockanalysis.com/etf/' +
      'spy). The threshold is 3.1% above spot and about 2.6% above the record, which is the most ' +
      'defensible place to put it — not already true, and not a fantasy either. Both authoring ' +
      'readings are from aggregators because spglobal.com and FRED both refused an automated ' +
      'fetch; SETTLEMENT is the index owner\'s own number, so a second-hand reading at authoring ' +
      'time does not reach it. Close is 20:00Z, an hour before the 21:00Z bell, so the level ' +
      'cannot be known while the market is open.',
  },
  {
    question:
      'Will the Federal Open Market Committee\'s statement for the meeting concluding on 9 ' +
      'December 2026 specify a target range for the federal funds rate whose UPPER limit is 4.00 ' +
      'percent or higher?',
    cover: 'a columned neoclassical façade behind a level two-pan balance scale',
    resolutionCriteria:
      'YES if the FOMC statement published on federalreserve.gov at the conclusion of the meeting ' +
      'ending 9 December 2026 states a target range for the federal funds rate whose upper limit ' +
      'is 4.00 percent or more — "3-3/4 to 4 percent" is YES, and so is anything above it. NO if ' +
      'the stated upper limit is below 4.00 percent, which includes the range being left unchanged ' +
      'at 3-1/2 to 3-3/4 percent and includes any cut. The statement itself is the document, not a ' +
      'press conference, not the minutes and not the Summary of Economic Projections. If the ' +
      'meeting is rescheduled, the statement from the rescheduled meeting settles it provided it ' +
      'is issued before 2027-01-01; if no statement is issued by then the market resolves NO.',
    category: 'market_prices',
    resolutionSourceKind: 'regulator_publication',
    resolutionSourceRef:
      'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261209a.htm',
    closeTime: '2026-12-09T17:59:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'The target range was 3-1/2 to 3-3/4 percent, maintained at the meeting of 28-29 July 2026 — ' +
      'read on 2026-08-11 from federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm, ' +
      'which states the Committee "decided to maintain the target range for the federal funds rate ' +
      'at 3-1/2 to 3-3/4 percent". The vote was 9-3, with THREE dissenters favouring a quarter-' +
      'point INCREASE, which is unusual and is what makes the hawkish side of this question live ' +
      'rather than theoretical. The last actual change was a 25bp cut on 2025-12-11 ' +
      '(federalreserve.gov/monetarypolicy/openmarket.htm). The 8-9 December 2026 meeting is on the ' +
      'Board\'s own 2026 calendar (federalreserve.gov/monetarypolicy/fomccalendars.htm), and the ' +
      'statement URL follows the fixed `monetary<YYYYMMDD>a.htm` pattern, which is what lets the ' +
      'source be NAMED at open rather than described. Close is 17:59Z, one minute before the ' +
      '18:00Z (1pm ET) release. Deliberately NOT the September meeting, which the estate already ' +
      'runs a market on, and deliberately about the LEVEL rather than the direction.',
  },

  /* ─────────────────────────────── protocol_network ──────────────────────────
   * Source kinds available: chain_rpc, block_explorer, protocol_publication.
   */
  {
    question:
      'Will the Bitcoin mainnet block height be at or above 982,500 at 2027-01-01T00:00:00Z?',
    cover: 'a chain of solid rectangular blocks linked end to end, receding to one side',
    resolutionCriteria:
      'YES if the tip height of the Bitcoin mainnet chain, read once at or after ' +
      '2027-01-01T00:00:00Z, is greater than or equal to 982500. NO if it is lower. The chain is ' +
      'the one with the most cumulative proof of work as reported by the source; a fork of Bitcoin ' +
      'under any other name is not this chain, and no testnet counts. Height is a property of the ' +
      'chain rather than of the endpoint, so if the source is unreachable the same height as ' +
      'published by blockstream.info/api/blocks/tip/height, or by a `getblockcount` against any ' +
      'Bitcoin Core node the operator runs, settles it — the first successful reading within six ' +
      'hours. If none succeeds the market resolves NO.',
    category: 'protocol_network',
    resolutionSourceKind: 'chain_rpc',
    resolutionSourceRef: 'https://mempool.space/api/blocks/tip/height',
    closeTime: '2027-01-01T00:00:00.000Z',
    disputeWindowSeconds: ONE_DAY,
    feeBps: FEE_BPS,
    observed:
      'Tip height was 962,013 at 2026-08-11T14:09Z, read from the endpoint named above; ' +
      'coindesk.com/price/bitcoin showed 962,012 the same day. The threshold needs 20,487 blocks ' +
      'in the 142.4 days to close — 143.9 blocks a day, a 10.01-minute mean interval, which is the ' +
      'protocol\'s nominal rate and therefore very close to a coin flip. It is not a formality in ' +
      'either direction: mempool.space/api/v1/difficulty-adjustment on the same day gave the ' +
      'running epoch a `timeAvg` of 631,973 ms (10.53 min/block) at 18.90% progress with a -3.02% ' +
      'retarget coming, so the near-term drift is toward NO while any renewed hashrate growth over ' +
      'the autumn pushes toward YES. Distinct from the existing 969,200-at-2026-09-30 market: a ' +
      'different height, three months later.',
  },
  {
    question:
      'Will the Ethereum mainnet block height be at or above 26,750,000 at 2027-01-01T00:00:00Z?',
    cover: 'a stack of thin translucent plates rising in even increments',
    resolutionCriteria:
      'YES if the best block height of Ethereum mainnet, read once at or after ' +
      '2027-01-01T00:00:00Z, is greater than or equal to 26750000. NO if it is lower. The ' +
      'canonical chain is the one the source recognises as Ethereum mainnet; no testnet and no ' +
      'layer-2 counts. If the source is unreachable the height returned by an `eth_blockNumber` ' +
      'JSON-RPC call against any Ethereum execution client the operator runs settles it — the ' +
      'first successful reading within six hours — and if none succeeds the market resolves NO.',
    category: 'protocol_network',
    resolutionSourceKind: 'chain_rpc',
    resolutionSourceRef: 'https://api.blockchair.com/ethereum/stats — field `best_block_height`',
    closeTime: '2027-01-01T00:00:00.000Z',
    disputeWindowSeconds: ONE_DAY,
    feeBps: FEE_BPS,
    observed:
      '`best_block_height` was 25,732,339 at about 2026-08-11T14:15Z, read from the endpoint named ' +
      'above (the same response gave `market_price_usd` 1886.79, which agrees with the Coinbase ' +
      'ETH-USD ticker that day to within 0.5%). Ethereum\'s slot time is 12 seconds nominal, so a ' +
      'chain that missed no slot would gain 7,200 blocks a day; the threshold needs 7,146 a day, ' +
      'an effective 12.09-second interval, which tolerates about a 0.75% missed-slot rate. That is ' +
      'INSIDE the band the network has historically occupied rather than at its edge, which is ' +
      'what makes the question uncertain — and it is settled by one integer from one endpoint, ' +
      'which is what makes it unarguable.',
  },

  /* ───────────────────────── scheduled_public_events ─────────────────────────
   * Source kinds available: official_announcement, primary_source_publication.
   */
  {
    question:
      'Will Grand Theft Auto VI be on sale and playable on both PlayStation 5 and Xbox Series X/S ' +
      'on or before 2026-11-19T23:59:59Z?',
    cover: 'a handheld game controller resting on a folded paper road map',
    resolutionCriteria:
      'YES if, at or before 2026-11-19T23:59:59Z, the game can be bought and played on BOTH the ' +
      'PlayStation Store and the Xbox Store in at least one territory — evidenced by a Rockstar ' +
      'Games Newswire post announcing the launch, or by the two storefront listings themselves. NO ' +
      'if that is not true at that instant, which includes an announced delay, a launch on only ' +
      'one of the two platforms, and a paid-early-access or preview release that is not the full ' +
      'retail launch. Physical copies reaching shops does not settle it; being playable does. If ' +
      'the Newswire cannot be read the two storefront listings govern, and if those cannot be read ' +
      'either the market resolves NO.',
    category: 'scheduled_public_events',
    resolutionSourceKind: 'official_announcement',
    resolutionSourceRef:
      'https://www.rockstargames.com/newswire — with the PlayStation Store and Xbox Store product ' +
      'pages for Grand Theft Auto VI as the fallback evidence named in the criteria',
    closeTime: '2026-11-20T00:00:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'On 2026-08-11 the announced date was 19 November 2026 for PS5 and Xbox Series X/S, with ' +
      'physical copies (download codes rather than discs) in shops from 12 November for ' +
      'pre-loading. The date has already moved twice: an original 2025 window, then 26 May 2026 ' +
      '(announced May 2025), then 19 November 2026 (announced November 2025, attributed to further ' +
      'polish) — which is what makes a third slip a real possibility rather than a rhetorical one. ' +
      'Milestones already passed: cover art on 18 June 2026, pre-orders opened 25 June 2026 at ' +
      '79.99 USD, and an extended look scheduled to premiere on Netflix on 27 August 2026. Read ' +
      'from en.wikipedia.org/wiki/Grand_Theft_Auto_VI, because rockstargames.com refuses automated ' +
      'fetches — the resolution source is still Rockstar\'s own Newswire, and an operator should ' +
      're-read it by hand before approving.',
  },
  {
    question:
      'Will SpaceX fly the next integrated flight test of Starship on or before ' +
      '2026-09-30T23:59:59Z?',
    cover: 'a tall polished cylinder standing between two converging mechanical arms',
    resolutionCriteria:
      'YES if a Super Heavy and Starship stack lifts off from a SpaceX launch site on the next ' +
      'integrated flight test after the flight of 24 July 2026 — the one designated Flight 14, or ' +
      'whatever designation SpaceX gives that flight — at any time on or before ' +
      '2026-09-30T23:59:59Z, as recorded on spacex.com/launches. LIFTOFF settles it YES: the ' +
      'flight need not reach orbit, catch either stage, or be judged a success. NO if no such ' +
      'liftoff has occurred by that instant, for any reason including scrubs, a static-fire-only ' +
      'campaign, a vehicle change and a regulatory grounding. If spacex.com cannot be read, the ' +
      'FAA\'s commercial space launch record settles it; if that cannot be read either the market ' +
      'resolves NO.',
    category: 'scheduled_public_events',
    resolutionSourceKind: 'official_announcement',
    resolutionSourceRef: 'https://www.spacex.com/launches/',
    closeTime: '2026-10-01T00:00:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'On 2026-08-11 the next flight was listed NET late August 2026 — Block 3, Booster 21 and ' +
      'Ship 41 from Starbase OLP-2 — with the first orbital insertion and the first catch of the ' +
      'second stage as objectives (en.wikipedia.org/wiki/List_of_Starship_launches). The previous ' +
      'flight went on 2026-07-24 at 22:51Z carrying 20 Starlink V3 satellites: the launch ' +
      'succeeded, but the booster lit only 10 of 13 planned landing engines and struck the water ' +
      'hard, and that anomaly is unresolved in public. Programme totals that day: 13 launches, 8 ' +
      'successes, 5 failures, with Block 3 flown twice. Spaceflight Now\'s launch schedule, read ' +
      'the same day, listed NO Starship flight at all, which is itself a statement about how firm ' +
      '"late August" was. A five-week cushion against a cadence that has run nearer one flight per ' +
      'quarter than one per month is what makes this uncertain. Resolving on LIFTOFF rather than ' +
      'on mission success is deliberate: the objectives are ambitious enough that "did it work" ' +
      'would be the arguable question.',
  },
  {
    question:
      'Will the Nancy Grace Roman Space Telescope lift off on or before 2026-09-30T23:59:59Z?',
    cover: 'a segmented dish reflector on a boom against a field of small scattered points',
    resolutionCriteria:
      'YES if the launch vehicle carrying the Nancy Grace Roman Space Telescope lifts off on or ' +
      'before 2026-09-30T23:59:59Z, confirmed by a NASA blog post or press release. Liftoff ' +
      'settles it YES whether or not the observatory is successfully separated, deployed or later ' +
      'commissioned. NO if no liftoff has occurred by that instant, for any reason including ' +
      'scrubs, a vehicle or payload problem, a range conflict, a change of launch vehicle that ' +
      'delays the flight past the date, and a lapse in government funding. If NASA\'s pages cannot ' +
      'be read the market resolves NO.',
    category: 'scheduled_public_events',
    resolutionSourceKind: 'official_announcement',
    resolutionSourceRef:
      'https://science.nasa.gov/mission/roman-space-telescope/ and https://blogs.nasa.gov/roman/',
    closeTime: '2026-10-01T00:00:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'NASA\'s own mission page, read 2026-08-11 and last updated 2026-07-27, stated Roman is "set ' +
      'to launch August 30, 2026 at 07:26 am EDT" on a Falcon Heavy from Kennedy Space Center ' +
      'LC-39A, with status posts recording that integrated operations for launch had begun and ' +
      'that the observatory had been fuelled. Spaceflight Now\'s launch schedule independently ' +
      'gave NET 30 August, Falcon Heavy, LC-39A, 7:26 a.m. EDT the same day. The close is one ' +
      'month past the target rather than two, which is what keeps the question live: a flagship ' +
      'observatory absorbs a one-to-three-week slip routinely, and this deadline does not.',
  },
  {
    question:
      'Will Sierra Space\'s Dream Chaser spaceplane lift off on its first spaceflight on or before ' +
      '2027-03-31T23:59:59Z?',
    cover: 'a lifting-body glider with upswept wingtips resting on a launch adapter',
    resolutionCriteria:
      'YES if a Dream Chaser vehicle lifts off on an orbital launch on or before ' +
      '2027-03-31T23:59:59Z, confirmed by a Sierra Space or NASA announcement — on any launch ' +
      'vehicle, and whether or not the mission subsequently succeeds, berths with the ISS or ' +
      'returns. NO if no such liftoff has occurred by that instant, which includes a further slip, ' +
      'a cancellation and the vehicle being reassigned to a later mission. If neither named source ' +
      'can be read the market resolves NO.',
    category: 'scheduled_public_events',
    resolutionSourceKind: 'official_announcement',
    resolutionSourceRef:
      'https://www.sierraspace.com/newsroom/ and https://blogs.nasa.gov/spacestation/',
    closeTime: '2027-04-01T00:00:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'Listed NET Q4 2026 on a Vulcan Centaur in the VC4L configuration from Cape Canaveral ' +
      'SLC-41, read 2026-08-11 from spaceflightnow.com/launch-schedule/, which annotates the entry ' +
      '"Repeatedly postponed since 2022" and "Delayed from 2025" and shows it as the only Vulcan ' +
      'flight on the schedule. That history is the whole question: a vehicle that has slipped every ' +
      'year since 2022, with a target one quarter before this close. The authoring reading is from ' +
      'a trade publication because sierraspace.com could not be reached; settlement is Sierra ' +
      'Space\'s or NASA\'s own announcement, and an operator should re-read the current NET before ' +
      'approving, since a slip announced between now and open changes the fair price materially.',
  },
  {
    question:
      'Will the Milwaukee Brewers be one of the two clubs that play in the 2026 Major League ' +
      'Baseball World Series?',
    cover: 'a stitched leather ball beside a tapered wooden bat on bare ground',
    resolutionCriteria:
      'YES if the Milwaukee Brewers are one of the two clubs recorded as participants in the 2026 ' +
      'World Series on MLB.com\'s official postseason bracket, once both League Championship ' +
      'Series have concluded. NO if they are not, which includes missing the postseason and being ' +
      'eliminated in any earlier round. If the 2026 World Series is not played at all, the market ' +
      'resolves void rather than NO, because the question presupposes the fixture. If MLB.com ' +
      'cannot be read the market resolves NO.',
    category: 'scheduled_public_events',
    resolutionSourceKind: 'primary_source_publication',
    resolutionSourceRef: 'https://www.mlb.com/postseason',
    closeTime: '2026-09-29T00:00:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'Milwaukee led all of baseball at 74-45 (.622) with the best run differential in the sport at ' +
      '+140, and had gone 6-4 over their previous ten — standings dated 2026-08-11 from ' +
      'mlb.com/standings. Next best: Atlanta 71-48, the Los Angeles Dodgers 71-48 (2-8 over their ' +
      'last ten), Tampa Bay 72-46 leading the American League. The schedule is confirmed on ' +
      'en.wikipedia.org/wiki/2026_Major_League_Baseball_season, read the same day: regular season ' +
      'ends 27 September, postseason begins 29 September, World Series begins 23 October. The best ' +
      'record in the sport with seven weeks to play converts to a pennant only about a quarter to ' +
      'a third of the time under a six-team-per-league bracket, which is why this is a question ' +
      'rather than an observation. The subject is a club, not a person. Close is 29 September, ' +
      'before the first pitch of the postseason — NOT the eve of the World Series, which would ' +
      'leave the market open after the pennants were decided.',
  },
  {
    question:
      'Will the National Football Conference champion win Super Bowl LXI, scheduled for 14 ' +
      'February 2027 at SoFi Stadium?',
    cover: 'an oblong pointed ball above two opposed directional chevrons',
    resolutionCriteria:
      'YES if the club representing the National Football Conference is recorded as the winner of ' +
      'Super Bowl LXI on NFL.com. NO if the American Football Conference representative is ' +
      'recorded as the winner. A Super Bowl cannot end level, so these two outcomes are ' +
      'exhaustive. If the game is postponed, the result of the rescheduled game settles it ' +
      'provided it is played before 2027-04-30; if it is not played by then, or if NFL.com cannot ' +
      'be read at resolution, the market resolves NO.',
    category: 'scheduled_public_events',
    resolutionSourceKind: 'primary_source_publication',
    resolutionSourceRef: 'https://www.nfl.com/super-bowl/',
    closeTime: '2027-02-14T20:00:00.000Z',
    disputeWindowSeconds: ONE_WEEK,
    feeBps: FEE_BPS,
    observed:
      'Super Bowl LXI is confirmed for 14 February 2027 at SoFi Stadium, Inglewood, California, on ' +
      'ABC and ESPN — the first on Valentine\'s Day and the latest calendar date the league has ' +
      'ever held the game; venue selected 2023-12-13, logo revealed 2026-02-08 ' +
      '(en.wikipedia.org/wiki/Super_Bowl_LXI, read 2026-08-11). NO TEAMS ARE DETERMINED: the 2026 ' +
      'regular season had not begun on the authoring date. It opens 2026-09-09 with New England at ' +
      'defending champion Seattle — a Super Bowl LX rematch — runs to 2027-01-10, and the ' +
      'conference championships are 2027-01-31 (en.wikipedia.org/wiki/2026_NFL_season). ' +
      'Structurally a coin flip settled by one line on the league\'s own site, with no individual ' +
      'named anywhere in the question. Close is 20:00Z on the day, well before the expected 23:30Z ' +
      'kick-off.',
  },
]
