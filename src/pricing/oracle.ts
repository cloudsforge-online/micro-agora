/**
 * One refresh round.
 *
 * The shape is carried forward from `repos/forge-pay/services/pay/src/pricing.ts`, which gets
 * the important things right: settle every source independently, require a minimum count, reject
 * the round on divergence, take the median. What changes:
 *
 *   1. **`Promise.allSettled`, not `Promise.all` over try/catch.** The old file wraps each fetch in
 *      a try and returns an empty map on failure, which works but hides the distinction between
 *      "answered with nothing" and "threw" — and the reason a source failed is exactly what an
 *      operator needs when three of four are down.
 *   2. **The result lands in a table, not a Map.** See `quotes.ts`.
 *   3. **A round runs once for the estate**, under the `price.refresh` / `global` lease, rather
 *      than once per replica on a `setInterval` (`pricing.ts`). N replicas on a timer is N
 *      times the exchange rate-limit consumption and N different answers.
 *   4. **Never a float.** Sources yield decimal strings and `parseScaled` reads their digits.
 */

import type { AssetCode } from '@cloudsforge/contracts-chain'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { MARKET_ASSETS, decideRound, parseScaled, type RoundOutcome } from './rates.ts'
import { recordAccepted, recordFailure, syncAdministeredQuotes } from './quotes.ts'
import type { PriceSource, SourceQuotes } from './sources.ts'
import type { Db } from './outbox.ts'

export interface OracleDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly sources: readonly PriceSource[]
  readonly minSources: number
  readonly maxDivergenceBps: number
  /** Injected so a round can be recorded at a controlled instant in a test. */
  readonly now?: () => Date
}

export interface AssetRoundReport {
  readonly asset: AssetCode
  readonly outcome: RoundOutcome
  readonly sourceCount: number
  readonly divergenceBps: string
  readonly reason?: string
  /** Fixed point at RATE_SCALE, as a string. Never a number, at any point in this file. */
  readonly usdScaled?: string
}

export interface RoundReport {
  readonly sourcesAttempted: number
  readonly sourcesAnswered: number
  readonly sourceFailures: ReadonlyArray<{ readonly source: string; readonly error: string }>
  readonly assets: readonly AssetRoundReport[]
  readonly administeredSynced: number
}

/**
 * Fetch every source, decide every market asset, and write the outcome.
 *
 * **This function never throws for a price reason.** A round in which every source failed is a
 * recorded failure per asset, not an exception: throwing would fail the leased job, burn its
 * attempt budget and eventually dead-letter the refresh — which would stop the oracle entirely
 * because one exchange had a bad afternoon. It throws only if the database is unreachable, which
 * is a fault the job runner's retry is the right answer to.
 */
export async function refreshRound(deps: OracleDeps): Promise<RoundReport> {
  const settled = await Promise.allSettled(deps.sources.map((source) => source.fetch()))

  const answered: Array<{ name: string; quotes: SourceQuotes }> = []
  const sourceFailures: Array<{ source: string; error: string }> = []

  settled.forEach((result, index) => {
    const name = deps.sources[index]?.name ?? `source-${index}`
    if (result.status === 'fulfilled') {
      answered.push({ name, quotes: result.value })
      return
    }
    const error = result.reason instanceof Error ? result.reason.message : String(result.reason)
    sourceFailures.push({ source: name, error })
    // Warn, not error: one source failing is the condition this design exists to tolerate, and
    // paging on it would page four times a week for nothing.
    deps.logger.warn('price source failed', { source: name, err: error })
  })

  const assets: AssetRoundReport[] = []
  const observedAt = deps.now?.() ?? new Date()

  for (const asset of MARKET_ASSETS) {
    const quotes: Array<{ source: string; usdScaled: bigint }> = []
    for (const { name, quotes: sourceQuotes } of answered) {
      const text = sourceQuotes[asset]
      if (text === undefined) continue
      const usdScaled = parseScaled(text)
      if (usdScaled === null) {
        // A malformed field costs this source its vote on this asset, and nothing more. It is
        // logged because a source that has changed its response shape will otherwise quietly
        // reduce the round to three sources for ever.
        deps.logger.warn('price source returned an unparseable quote', { source: name, asset, text })
        continue
      }
      quotes.push({ source: name, usdScaled })
    }

    const decision = decideRound({
      quotes,
      minSources: deps.minSources,
      maxDivergenceBps: deps.maxDivergenceBps,
    })

    deps.metrics.increment('pricing_round_total', { asset, outcome: decision.outcome })
    deps.metrics.set('pricing_sources_ok', decision.sourceCount, { asset })
    deps.metrics.set('pricing_divergence_bps', Number(decision.divergenceBps), { asset })

    if (decision.outcome === 'accepted') {
      await recordAccepted(deps.sql, {
        asset,
        usdScaled: decision.usdScaled,
        sourceCount: decision.sourceCount,
        divergenceBps: decision.divergenceBps,
        observedAt,
      })
      assets.push({
        asset,
        outcome: 'accepted',
        sourceCount: decision.sourceCount,
        divergenceBps: decision.divergenceBps.toString(),
        usdScaled: decision.usdScaled.toString(),
      })
      continue
    }

    await recordFailure(deps.sql, asset, decision.reason)
    if (decision.outcome === 'rejected_divergence') {
      // Loud. Divergence past the threshold means one venue is printing a price the others do not
      // agree with, and the honest reading of that is that we do not know this asset's price.
      deps.logger.error('price sources diverged — round rejected', {
        asset,
        divergenceBps: decision.divergenceBps.toString(),
        limit: deps.maxDivergenceBps,
        quotes: quotes.map((q) => ({ source: q.source, usdScaled: q.usdScaled.toString() })),
      })
    } else {
      deps.logger.warn('too few price sources', {
        asset,
        got: decision.sourceCount,
        need: deps.minSources,
      })
    }
    assets.push({
      asset,
      outcome: decision.outcome,
      sourceCount: decision.sourceCount,
      divergenceBps: decision.divergenceBps.toString(),
      reason: decision.reason,
    })
  }

  // Administered assets have no round of their own; what they need is for a price set directly in
  // the table to reach the quote a rate lookup reads.
  const administeredSynced = await syncAdministeredQuotes(deps.sql)

  return {
    sourcesAttempted: deps.sources.length,
    sourcesAnswered: answered.length,
    sourceFailures,
    assets,
    administeredSynced,
  }
}
