/**
 * The fallow clock, computed and never swept.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THERE IS NO TIMER IN THIS FILE, AND THERE MUST NOT BE ONE.**
 *
 * §4: "A non-Homestead parcel with no visitor and no edit for 90 days becomes `fallow`; after a
 * further 30 days its claim may be contested by anyone. An owner may bank a parcel once per year,
 * extending the clock to 270 days, free. This is the structural answer to the reference's dead
 * continents: there, empty land stayed empty because its owner paid rent to hold it and nobody
 * could reclaim it. Here, dead land returns to the commons and nobody pays rent at all."
 *
 * And §11.4: "Fallow is lazy — computed on read from `(lastFootfallAt, lastEditAt, bankedUntil)`
 * and settled on write, so there is no nightly sweep marking parcels dead."
 *
 * A sweep is the obvious implementation and it is forbidden twice over. Once by CI — a
 * `setInterval` doing domain work exits 1 at `org/.github/workflows/service-ci.yml`, with an
 * inline `cfctl-allow` comment as the only escape hatch, and this repository uses no escape hatch.
 * And once by arithmetic: a sweep over every parcel in every ward, nightly, to write a column that
 * is a pure function of three columns already on the row, is work that buys nothing. The index
 * `parcels_last_active_idx` makes the lazy read a range scan.
 *
 * **What "settled on write" means, precisely.** Nothing writes a `fallow` status — there is no
 * such status; migration 4's `tessera_parcel_status_known` admits only `held` and `released`. A
 * parcel is settled when somebody ACTS on its fallow state: a contest is opened (which the
 * database's own clock permits or refuses) or the owner banks it. Until then the state is a
 * question anybody may ask and nobody has to have answered.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** How long a non-Homestead parcel may be quiet before it is fallow. §4. */
export const FALLOW_DAYS = 90

/** How long after that before anyone may contest the claim. §4. */
export const CONTEST_DAYS = 30

/** What banking extends the clock to, measured from last activity. §4. */
export const BANKED_DAYS = 270

/** How often an owner may bank one parcel. §4: "once per year". */
export const BANK_INTERVAL_DAYS = 365

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * What a parcel is, right now.
 *
 * `held` — live. `fallow` — quiet past the deadline, still the owner's, and reclaimable by them
 * the instant anybody visits. `contestable` — quiet past the deadline plus thirty, and anybody
 * may open a contest.
 *
 * A Homestead is always `held`. §4: "It is never fallow, never contestable, and not tradeable."
 */
export type FallowState = 'held' | 'fallow' | 'contestable'

export interface FallowInputs {
  readonly tier: string
  readonly status: string
  readonly lastActiveAt: Date
  readonly bankedUntil: Date | null
}

/** The deadline at which a parcel becomes fallow. Banking can only push it later, never earlier. */
export function fallowAt(inputs: Pick<FallowInputs, 'lastActiveAt' | 'bankedUntil'>): Date {
  const plain = new Date(inputs.lastActiveAt.getTime() + FALLOW_DAYS * DAY_MS)
  const banked = inputs.bankedUntil
  return banked && banked.getTime() > plain.getTime() ? banked : plain
}

/** The instant a fallow parcel may be contested. */
export function contestableAt(inputs: Pick<FallowInputs, 'lastActiveAt' | 'bankedUntil'>): Date {
  return new Date(fallowAt(inputs).getTime() + CONTEST_DAYS * DAY_MS)
}

/** What `banked_until` must be set to. The trigger `parcels_banking_guard` enforces exactly this. */
export function bankedUntilFor(lastActiveAt: Date): Date {
  return new Date(lastActiveAt.getTime() + BANKED_DAYS * DAY_MS)
}

/**
 * The state of a parcel at an instant.
 *
 * `now` is a parameter rather than a call to `Date.now()`, so the function is pure and testable at
 * any point on the clock without moving the machine's. **The AUTHORITATIVE answer is Postgres's
 * `tessera_contestable_at`, evaluated on the database clock inside
 * `contests_respect_the_window`.** This is what a read serves; that is what a write is judged by.
 * They agree because they compute the same expression, and `fallow.test.ts` asserts that against a
 * real database rather than assuming it — a TypeScript clock and a Postgres clock disagreeing is
 * exactly the class of bug the trigger exists to be immune to.
 */
export function fallowStateOf(inputs: FallowInputs, now: Date): FallowState {
  if (inputs.tier === 'homestead') return 'held'
  if (inputs.status !== 'held') return 'held'
  if (now.getTime() >= contestableAt(inputs).getTime()) return 'contestable'
  if (now.getTime() >= fallowAt(inputs).getTime()) return 'fallow'
  return 'held'
}
