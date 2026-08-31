/**
 * The lazy economy: stocks are computed on read and settled on write. There is no world tick.
 *
 * The whole design is one function, `accrue`, pure over `(stock, ratePerHour, cap, elapsedMs)`:
 * the read path calls it to answer "what do you have now", and the write path calls it inside a
 * transaction to move `last_settled_at` forward before spending. Because both paths share the
 * function, the number a player was shown and the number a spend is charged against cannot be
 * computed two different ways.
 *
 * Everything is `bigint`. Accrual is integer floor arithmetic — `rate * seconds / 3600` — so two
 * replicas settling at the same instant write the same value, and the schema's
 * `cities_stocks_settled_within_caps` CHECK re-asserts the clamp this module promises
 * (src/migrations.ts, version 5). The CHECK is not redundancy: it holds against the settlement
 * bug not yet written, which this module by definition cannot.
 */

import { RESOURCES, type Resource, type Stocks } from './content.ts';
import type { Db, Tx } from './outbox.ts';

export class InsufficientStockError extends Error {
  constructor(resource: string, needed: bigint, held: bigint) {
    super(`not enough ${resource}: need ${needed}, hold ${held}`);
    this.name = 'InsufficientStockError';
  }
}

/**
 * What `stock` has become after `elapsedMs` at `ratePerHour`, clamped to `[0, cap]`.
 *
 * Negative elapsed time — a clock stepped backwards between writes — accrues NOTHING rather than
 * throwing or (far worse) subtracting: settlement must be monotonic, and the next honest clock
 * reading resumes accrual from the stored `last_settled_at`.
 */
export function accrue(stock: bigint, ratePerHour: bigint, cap: bigint, elapsedMs: number): bigint {
  const seconds = elapsedMs > 0 ? BigInt(Math.floor(elapsedMs / 1000)) : 0n;
  const grown = stock + (ratePerHour * seconds) / 3600n;
  const clamped = grown > cap ? cap : grown;
  return clamped < 0n ? 0n : clamped;
}

export interface CityEconomyRow {
  readonly id: string;
  readonly last_settled_at: Date;
  readonly aether: string;
  readonly cloudstone: string;
  readonly skysteel: string;
  readonly provisions: string;
  readonly storage_cap: string;
  readonly rate_aether: string;
  readonly rate_cloudstone: string;
  readonly rate_skysteel: string;
  readonly rate_provisions: string;
}

export interface EconomySnapshot {
  readonly stocks: Stocks;
  readonly rates: Stocks;
  readonly cap: bigint;
  readonly settledAt: Date;
}

const ECONOMY_COLUMNS = `
  id, last_settled_at,
  aether::text, cloudstone::text, skysteel::text, provisions::text,
  storage_cap::text,
  rate_aether::text, rate_cloudstone::text, rate_skysteel::text, rate_provisions::text
`;

function ratesOf(row: CityEconomyRow): Stocks {
  return {
    aether: BigInt(row.rate_aether),
    cloudstone: BigInt(row.rate_cloudstone),
    skysteel: BigInt(row.rate_skysteel),
    provisions: BigInt(row.rate_provisions),
  };
}

function stocksOf(row: CityEconomyRow): Stocks {
  return {
    aether: BigInt(row.aether),
    cloudstone: BigInt(row.cloudstone),
    skysteel: BigInt(row.skysteel),
    provisions: BigInt(row.provisions),
  };
}

/** The stocks a row holds at `now`, computed, not written. The read path. */
export function snapshotAt(row: CityEconomyRow, now: Date): EconomySnapshot {
  const cap = BigInt(row.storage_cap);
  const rates = ratesOf(row);
  const stored = stocksOf(row);
  const elapsedMs = now.getTime() - row.last_settled_at.getTime();
  const stocks = Object.fromEntries(
    RESOURCES.map((resource) => [resource, accrue(stored[resource], rates[resource], cap, elapsedMs)]),
  ) as Record<Resource, bigint>;
  return { stocks, rates, cap, settledAt: row.last_settled_at };
}

/** Read a city's economy row without settling. */
export async function economyRow(sql: Db | Tx, cityId: string): Promise<CityEconomyRow | null> {
  const rows = await sql<CityEconomyRow[]>`
    select ${sql.unsafe(ECONOMY_COLUMNS)} from cities where id = ${cityId} and abandoned_at is null
  `;
  return rows[0] ?? null;
}

/**
 * Settle a city up to `now` and optionally spend, in ONE update guarded by the row lock.
 *
 * The row is locked `for update` first so two concurrent settlements serialise: each computes
 * from what the previous one wrote, which is what makes floor-arithmetic accrual safe to run
 * from any number of replicas. A spend that would go negative throws `InsufficientStockError`
 * and the transaction rolls back — and even if this function were wrong, the CHECK would refuse
 * the write.
 */
export async function settle(
  tx: Tx,
  cityId: string,
  now: Date,
  spend?: Partial<Stocks>,
): Promise<EconomySnapshot> {
  const rows = await tx<CityEconomyRow[]>`
    select ${tx.unsafe(ECONOMY_COLUMNS)} from cities
     where id = ${cityId} and abandoned_at is null
     for update
  `;
  const row = rows[0];
  if (!row) throw new Error(`city ${cityId} does not exist or is abandoned`);

  const current = snapshotAt(row, now);
  const settled: Record<Resource, bigint> = { ...current.stocks };
  if (spend) {
    for (const resource of RESOURCES) {
      const cost = spend[resource] ?? 0n;
      if (cost === 0n) continue;
      const held = settled[resource];
      if (cost > held) throw new InsufficientStockError(resource, cost, held);
      settled[resource] = held - cost;
    }
  }

  // `last_settled_at` never moves backwards: settling with a stale clock would re-accrue the
  // interval on the next honest settlement.
  const settleTo = now.getTime() > row.last_settled_at.getTime() ? now : row.last_settled_at;
  await tx`
    update cities
       set aether = ${settled.aether.toString()}::bigint,
           cloudstone = ${settled.cloudstone.toString()}::bigint,
           skysteel = ${settled.skysteel.toString()}::bigint,
           provisions = ${settled.provisions.toString()}::bigint,
           last_settled_at = ${settleTo}
     where id = ${cityId}
  `;
  return { stocks: settled, rates: current.rates, cap: current.cap, settledAt: settleTo };
}

/** Serialise stocks for the wire: decimal strings, never floats — the estate's money rule applied
 *  to resources, and for the same reason. */
export function stocksWire(stocks: Stocks): Record<Resource, string> {
  return Object.fromEntries(
    RESOURCES.map((resource) => [resource, stocks[resource].toString()]),
  ) as Record<Resource, string>;
}
