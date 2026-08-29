/**
 * Footfall, dwell, and the whole ranking function.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **TWO SIGNALS. THERE IS NO THIRD, AND SPECIFICALLY THERE IS NO PAID ONE — EVER.**
 *
 * §6.5, and §7.1's first refusal, which is the one the design says matters most:
 *
 * > "This is the one that matters most, because it is the one every virtual world eventually
 * > sells and it is unambiguously advantage over another player: a promoted parcel takes footfall
 * > *from* an unpromoted one, and footfall is the only scarce resource in the design. So: **no
 * > promoted placement, no paid ranking, no sponsored beacons, no boost.** The feed is ordered by
 * > footfall, dwell and recency, and by nothing else, forever. If Tessera ever needs money badly
 * > enough to sell discovery, it needs to be shut down instead."
 *
 * §12's test 12 asks for "a test on the ranking function's signature, so that adding a third —
 * paid or otherwise — cannot happen quietly". `RankingInputs` below is that surface: it is a
 * closed interface with exactly three fields, `rank()` takes nothing else, and
 * `discovery.test.ts` asserts the key set. A fourth input cannot be added without editing a test
 * that says, in its name, what adding it would mean.
 *
 * Recency is the third ORDERING term and not a third SIGNAL: it is a property of the row rather
 * than something a parcel can accrue, nobody can buy more of it, and without it a world's feed is
 * a permanent leaderboard of whoever arrived first.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Db } from './outbox.ts'

export interface VisitInput {
  readonly parcelId: string
  readonly visitorSubject: string
  readonly dwellSeconds: number
}

/**
 * Record a visit.
 *
 * `on conflict … do update` on `(parcel_id, day, visitor_subject)`, so a second visit by the same
 * person on the same day extends their dwell rather than counting as a second body. That is what
 * makes footfall "**distinct** accounts that entered the parcel, per day" a property of the table
 * rather than of a `count(distinct …)` somebody has to remember to write.
 *
 * A visit by `platform`, `platform:engagement-treasury` or any `engagement:<service>` subject is
 * refused by `tessera_footfall_is_never_synthetic` — §8.6's rule, in the schema, because a
 * platform that can fake footfall is a platform rigging its own discovery.
 */
export async function recordVisit(sql: Db, input: VisitInput): Promise<void> {
  const dwell = Math.max(0, Math.floor(input.dwellSeconds))
  await sql`
    insert into visits (parcel_id, day, visitor_subject, dwell_seconds)
    values (${input.parcelId}, current_date, ${input.visitorSubject}, ${dwell})
    on conflict (parcel_id, day, visitor_subject) do update
      set dwell_seconds = visits.dwell_seconds + ${dwell},
          last_seen_at = now()
  `
}

/**
 * The three inputs to the ranking function, and the only three there will ever be.
 *
 * A `readonly` interface with three fields, closed on purpose. Adding `promotedBps`, `boost`,
 * `sponsoredUntil` or anything else named like them means editing this type — and
 * `discovery.test.ts` asserts its key set against a literal list, so the edit cannot be quiet.
 */
export interface RankingInputs {
  /** Distinct accounts that entered, per day. §6.5. */
  readonly footfall: number
  /** The MEDIAN seconds those accounts stayed. §6.5. Median, not mean — see `rank`. */
  readonly medianDwellSeconds: number
  /** Days since the parcel was last active. A property of the row; nobody can buy more of it. */
  readonly ageDays: number
}

/**
 * The ranking score.
 *
 * Footfall times the log of dwell: footfall alone rewards a doorway that tricks people in, and
 * dwell alone rewards one person asleep in an empty room. The log is what stops a single
 * enormously long session dominating — dwell is evidence that footfall was not a trick, not a
 * quantity to maximise.
 *
 * **Median dwell, not mean**, and that is a real decision rather than a statistical nicety: a mean
 * is moved arbitrarily far by one visitor who left a tab open overnight, so a mean would be
 * buyable with one confederate and a long afternoon. A median needs half the visitors to stay,
 * which is the thing the signal is trying to measure.
 *
 * Recency decays over 30 days and never reaches zero, so an old, still-visited place stays
 * findable — the reference's dead continents were partly a discovery failure, not only a land one.
 */
export function rank(inputs: RankingInputs): number {
  const footfall = Math.max(0, inputs.footfall)
  const dwell = Math.max(0, inputs.medianDwellSeconds)
  const age = Math.max(0, inputs.ageDays)
  const engagement = footfall * Math.log1p(dwell)
  const recency = 1 / (1 + age / 30)
  return engagement * recency
}

export interface RankedParcel {
  readonly parcelId: string
  readonly wardId: string
  readonly ownerSubject: string
  readonly inputs: RankingInputs
  readonly score: number
}

/**
 * The feed.
 *
 * Every input to `rank` comes from this query, and the query touches `visits` and `parcels` and
 * nothing else. There is no join to `entitlements`, no join to `listings`, and no `promoted`
 * column to join to — the absence is the guarantee, and it is checked by
 * `discovery.test.ts`'s source scan rather than by this comment.
 *
 * `percentile_cont(0.5)` is the median, computed by Postgres over the day's visitors, so the
 * number this ranks by is the number the page shows.
 */
export async function rankParcels(sql: Db, wardId: string | null, limit = 50): Promise<RankedParcel[]> {
  const rows = await sql<
    {
      parcel_id: string
      ward_id: string
      owner_subject: string
      footfall: number
      median_dwell: number
      age_days: number
    }[]
  >`
    select p.id as parcel_id,
           p.ward_id,
           p.owner_subject,
           coalesce(v.footfall, 0)::int    as footfall,
           coalesce(v.median_dwell, 0)::int as median_dwell,
           greatest(0, extract(day from now() - p.last_active_at))::int as age_days
      from parcels p
      left join (
        select parcel_id,
               count(*)::int as footfall,
               percentile_cont(0.5) within group (order by dwell_seconds) as median_dwell
          from visits
         where day > current_date - 7
         group by parcel_id
      ) v on v.parcel_id = p.id
     where p.status = 'held'
       and p.gate_open = true
       and (${wardId}::uuid is null or p.ward_id = ${wardId}::uuid)
     order by coalesce(v.footfall, 0) desc, coalesce(v.median_dwell, 0) desc, p.last_active_at desc
     limit ${limit}
  `
  return rows
    .map((r) => {
      const inputs: RankingInputs = {
        footfall: r.footfall,
        medianDwellSeconds: r.median_dwell,
        ageDays: r.age_days,
      }
      return {
        parcelId: r.parcel_id,
        wardId: r.ward_id,
        ownerSubject: r.owner_subject,
        inputs,
        score: rank(inputs),
      }
    })
    .sort((a, b) => b.score - a.score)
}

export interface Beacon {
  readonly id: string
  readonly parcelId: string
  readonly headline: string
  readonly litAt: string
}

/**
 * Light a beacon on a Venue.
 *
 * Free, and rate-limited to 3 per parcel per 7 days by `beacons_within_rate_limit`. §6.5: "a limit
 * that exists so that a Beacon means something, and which cannot be raised by paying." The trigger
 * reads no entitlement and takes no subject — the limit is the same integer for every account in
 * the world, which is what makes it a limit rather than a price.
 */
export async function lightBeacon(
  sql: Db,
  parcelId: string,
  litBy: string,
  headline: string,
): Promise<Beacon> {
  const rows = await sql<{ id: string; parcel_id: string; headline: string; lit_at: Date }[]>`
    insert into beacons (parcel_id, lit_by, headline)
    values (${parcelId}, ${litBy}, ${headline})
    returning id, parcel_id, headline, lit_at
  `
  const row = rows[0]
  if (!row) throw new Error('the beacon did not light')
  return {
    id: row.id,
    parcelId: row.parcel_id,
    headline: row.headline,
    litAt: row.lit_at.toISOString(),
  }
}
