/**
 * City play: found, read, queue a building, queue research, complete what is due.
 *
 * The load-bearing decisions:
 *
 *   - **Founding is idempotent by construction.** The `cities_one_per_player_per_island` partial
 *     unique index makes the second city unrepresentable; a retry that trips it is answered with
 *     the city that already exists, never a 500 and never a duplicate.
 *   - **Every spend settles first.** `settle` moves `last_settled_at` forward with the rates in
 *     force and then subtracts the cost in the same UPDATE, inside the same transaction as the
 *     queue row — so a crash between "charged" and "queued" cannot exist.
 *   - **Completion is a leased job keyed `city:<id>`** (src/jobs.ts). Two replicas racing a
 *     completion serialise on the job lease AND on the queue row's `status = 'queued'` guard, so
 *     a level is applied exactly once.
 */

import {
  AEGIS_DAYS,
  AIRSHIPS,
  BASE_BUILD_SLOTS,
  BASE_RESEARCH_SLOTS,
  BASE_SHIP_SLOTS,
  buildingCost,
  buildingDurationSeconds,
  isAirshipClass,
  isBuildingType,
  isResearchNode,
  ratesFor,
  researchCost,
  researchDurationSeconds,
  storageCapFor,
  STARTING_STOCKS,
  type BuildingType,
  type Stocks,
} from './content.ts';
import { settle, snapshotAt, stocksWire, type CityEconomyRow } from './economy.ts';
import { assertNotSealed, isUniqueViolation } from './seasons.ts';
import { withOutbox, type Db, type Emit, type Tx } from './outbox.ts';

export const CITY_FOUNDED_TOPIC = 'aetherholm.city.founded';
export const BUILDING_COMPLETED_TOPIC = 'aetherholm.building.completed';
export const RESEARCH_COMPLETED_TOPIC = 'aetherholm.research.completed';

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
export class NotOwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotOwnerError';
  }
}
export class PlotTakenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlotTakenError';
  }
}
export class QueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueFullError';
  }
}
export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/* ------------------------------------------------------------------ founding */

export interface FoundCityInput {
  readonly userId: string;
  readonly islandId: string;
  readonly plot: number;
  readonly name: string;
  readonly correlationId: string;
  readonly now?: Date;
}

export interface CityView {
  readonly id: string;
  readonly islandId: string;
  readonly archipelagoId: string;
  readonly band: string;
  readonly userId: string;
  readonly plot: number;
  readonly name: string;
  readonly foundedAt: Date;
  readonly aegisUntil: Date;
  readonly stocks: Record<string, string>;
  readonly rates: Record<string, string>;
  readonly storageCap: string;
  readonly settledAt: Date;
  readonly buildings: ReadonlyArray<{ type: string; level: number }>;
  readonly ships: ReadonlyArray<{ class: string; count: string }>;
  readonly queue: ReadonlyArray<QueueItemView>;
}

export interface QueueItemView {
  readonly id: string;
  readonly kind: 'building' | 'research' | 'ship';
  readonly target: string;
  readonly status: 'queued' | 'done';
  readonly startedAt: Date;
  readonly completesAt: Date;
}

export interface FoundResult {
  readonly city: CityView;
  readonly created: boolean;
}

/**
 * Found a city on a plot. One per player per island; the schema enforces it, this function makes
 * the refusal polite: a re-found on the same island returns the existing city (`created: false`),
 * a taken plot is `PlotTakenError`.
 */
export async function foundCity(
  sql: Db,
  producer: string,
  input: FoundCityInput,
  outbox: typeof withOutbox = withOutbox,
): Promise<FoundResult> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) {
    throw new ValidationError('a city name must be 1 to 60 characters');
  }
  if (!Number.isInteger(input.plot) || input.plot < 1 || input.plot > 12) {
    throw new ValidationError('plot must be a whole number from 1 to 12');
  }
  const now = input.now ?? new Date();

  try {
    const cityId = await outbox(sql, producer, async (tx, emit) => {
      const islands = await tx<{ id: string; band: string; archipelago_id: string }[]>`
        select id, band, archipelago_id from islands where id = ${input.islandId}
      `;
      const island = islands[0];
      if (!island) throw new NotFoundError('no such island');
      // A sealed archipelago is history: the chronicle already counted its final cities, and a
      // founding after the bell would make that count a lie.
      await assertNotSealed(tx, island.archipelago_id);

      const levels = new Map<BuildingType, number>([['skyhall', 1]]);
      const rates = ratesFor(levels, island.band);
      const cap = storageCapFor(levels);
      const aegisUntil = new Date(now.getTime() + AEGIS_DAYS * 24 * 60 * 60 * 1000);

      const inserted = await tx<{ id: string }[]>`
        insert into cities (
          island_id, user_id, plot, name, founded_at, aegis_until, last_settled_at,
          aether, cloudstone, skysteel, provisions, storage_cap,
          rate_aether, rate_cloudstone, rate_skysteel, rate_provisions
        ) values (
          ${island.id}, ${input.userId}, ${input.plot}, ${name}, ${now}, ${aegisUntil}, ${now},
          ${STARTING_STOCKS.aether.toString()}::bigint,
          ${STARTING_STOCKS.cloudstone.toString()}::bigint,
          ${STARTING_STOCKS.skysteel.toString()}::bigint,
          ${STARTING_STOCKS.provisions.toString()}::bigint,
          ${cap.toString()}::bigint,
          ${rates.aether.toString()}::bigint,
          ${rates.cloudstone.toString()}::bigint,
          ${rates.skysteel.toString()}::bigint,
          ${rates.provisions.toString()}::bigint
        )
        returning id
      `;
      const cityId = inserted[0]!.id;
      await tx`insert into buildings (city_id, type, level) values (${cityId}, 'skyhall', 1)`;

      emit({
        topic: CITY_FOUNDED_TOPIC,
        key: cityId,
        payload: {
          cityId,
          islandId: island.id,
          archipelagoId: island.archipelago_id,
          userId: input.userId,
          plot: input.plot,
          name,
          aegisUntil: aegisUntil.toISOString(),
        },
        actor: `user:${input.userId}`,
        correlationId: input.correlationId,
      });
      return cityId;
    });

    const city = await getCity(sql, cityId, now);
    return { city: city!, created: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('cities_one_per_player_per_island')) {
        // The player already holds this island. Idempotent: answer with what exists.
        const rows = await sql<{ id: string }[]>`
          select id from cities
           where island_id = ${input.islandId} and user_id = ${input.userId}
             and abandoned_at is null
        `;
        const existing = rows[0];
        if (existing) {
          const city = await getCity(sql, existing.id, now);
          if (city) return { city, created: false };
        }
      }
      if (message.includes('cities_one_per_plot')) {
        throw new PlotTakenError(`plot ${input.plot} on this island is already claimed`);
      }
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ reading */

interface CityRow extends CityEconomyRow {
  readonly island_id: string;
  readonly archipelago_id: string;
  readonly band: string;
  readonly user_id: string;
  readonly plot: number;
  readonly name: string;
  readonly founded_at: Date;
  readonly aegis_until: Date;
}

/** Read a city with stocks COMPUTED at `now` — the lazy read; nothing is written. */
export async function getCity(sql: Db, cityId: string, now = new Date()): Promise<CityView | null> {
  const rows = await sql<CityRow[]>`
    select c.id, c.island_id, i.archipelago_id, i.band, c.user_id, c.plot, c.name,
           c.founded_at, c.aegis_until, c.last_settled_at,
           c.aether::text, c.cloudstone::text, c.skysteel::text, c.provisions::text,
           c.storage_cap::text,
           c.rate_aether::text, c.rate_cloudstone::text, c.rate_skysteel::text,
           c.rate_provisions::text
      from cities c
      join islands i on i.id = c.island_id
     where c.id = ${cityId} and c.abandoned_at is null
  `;
  const row = rows[0];
  if (!row) return null;

  const buildings = await sql<{ type: string; level: number }[]>`
    select type, level from buildings where city_id = ${cityId} order by type
  `;
  const ships = await sql<{ class: string; count: string }[]>`
    select class, count::text from city_ships where city_id = ${cityId} and count > 0 order by class
  `;
  const queue = await sql<
    { id: string; kind: string; target: string; status: string; started_at: Date; completes_at: Date }[]
  >`
    select id, kind, target, status, started_at, completes_at
      from queue_items where city_id = ${cityId} and status = 'queued'
     order by completes_at
  `;

  const snapshot = snapshotAt(row, now);
  return {
    id: row.id,
    islandId: row.island_id,
    archipelagoId: row.archipelago_id,
    band: row.band,
    userId: row.user_id,
    plot: row.plot,
    name: row.name,
    foundedAt: row.founded_at,
    aegisUntil: row.aegis_until,
    ships,
    stocks: stocksWire(snapshot.stocks),
    rates: stocksWire(snapshot.rates),
    storageCap: snapshot.cap.toString(),
    settledAt: snapshot.settledAt,
    buildings,
    queue: queue.map((item) => ({
      id: item.id,
      kind: item.kind as QueueItemView['kind'],
      target: item.target,
      status: item.status as QueueItemView['status'],
      startedAt: item.started_at,
      completesAt: item.completes_at,
    })),
  };
}

export async function listCitiesFor(sql: Db, userId: string, now = new Date()): Promise<CityView[]> {
  const rows = await sql<{ id: string }[]>`
    select id from cities where user_id = ${userId} and abandoned_at is null
     order by founded_at
  `;
  const cities: CityView[] = [];
  for (const row of rows) {
    const city = await getCity(sql, row.id, now);
    if (city) cities.push(city);
  }
  return cities;
}

/* ------------------------------------------------------------------ queueing */

export interface QueueInput {
  readonly cityId: string;
  readonly userId: string;
  readonly kind: 'building' | 'research' | 'ship';
  readonly target: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly now?: Date;
}

export interface QueueResult {
  readonly item: QueueItemView;
  readonly replayed: boolean;
  readonly stocks: Record<string, string>;
}

/**
 * Queue a building level or a research node: verify, replay-or-insert on the Idempotency-Key,
 * settle-and-charge, and schedule sequentially after the last queued item of the same kind.
 */
export async function queueWork(
  sql: Db,
  producer: string,
  input: QueueInput,
  outbox: typeof withOutbox = withOutbox,
): Promise<QueueResult> {
  const now = input.now ?? new Date();

  return outbox(sql, producer, async (tx) => {
    const cities = await tx<{ id: string; user_id: string; island_id: string }[]>`
      select id, user_id, island_id from cities
       where id = ${input.cityId} and abandoned_at is null
       for update
    `;
    const city = cities[0];
    if (!city) throw new NotFoundError('no such city');
    if (city.user_id !== input.userId) throw new NotOwnerError('not your city');

    // Replay before anything is charged. The fingerprint is (kind, target) — never the
    // correlation id, which differs per attempt by design.
    const replays = await tx<
      { id: string; kind: string; target: string; status: string; started_at: Date; completes_at: Date }[]
    >`
      select id, kind, target, status, started_at, completes_at from queue_items
       where city_id = ${input.cityId} and idempotency_key = ${input.idempotencyKey}
    `;
    const replay = replays[0];
    if (replay) {
      if (replay.kind !== input.kind || replay.target !== input.target) {
        throw new IdempotencyConflictError(
          'this Idempotency-Key was already used for a different request',
        );
      }
      const economy = await settle(tx, input.cityId, now);
      return {
        item: viewOf(replay),
        replayed: true,
        stocks: stocksWire(economy.stocks),
      };
    }

    const islandRows = await tx<{ band: string; archipelago_id: string }[]>`
      select band, archipelago_id from islands where id = ${city.island_id}
    `;
    const island = islandRows[0]!;
    await assertNotSealed(tx, island.archipelago_id);

    let cost: Stocks;
    let durationSeconds: number;
    if (input.kind === 'building') {
      if (!isBuildingType(input.target)) throw new ValidationError(`unknown building: ${input.target}`);
      const levelRows = await tx<{ level: number }[]>`
        select level from buildings where city_id = ${input.cityId} and type = ${input.target}
      `;
      const queuedSame = await tx<{ n: number }[]>`
        select count(*)::int as n from queue_items
         where city_id = ${input.cityId} and status = 'queued'
           and kind = 'building' and target = ${input.target}
      `;
      const nextLevel = (levelRows[0]?.level ?? 0) + (queuedSame[0]?.n ?? 0) + 1;
      cost = buildingCost(input.target, nextLevel);
      durationSeconds = buildingDurationSeconds(input.target, nextLevel);
    } else if (input.kind === 'ship') {
      if (!isAirshipClass(input.target)) throw new ValidationError(`unknown airship class: ${input.target}`);
      const spec = AIRSHIPS[input.target];
      // The keel needs the dock. Checked against the BUILT level, not the queue: a hull laid on
      // the promise of a dock still under construction is a hull laid on nothing.
      const dockRows = await tx<{ level: number }[]>`
        select level from buildings where city_id = ${input.cityId} and type = 'aerodock'
      `;
      if ((dockRows[0]?.level ?? 0) < spec.aerodock) {
        throw new ValidationError(
          `${input.target} needs aerodock level ${spec.aerodock} (built: ${dockRows[0]?.level ?? 0})`,
        );
      }
      cost = spec.cost;
      durationSeconds = spec.buildSeconds;
    } else {
      if (!isResearchNode(input.target)) throw new ValidationError(`unknown research node: ${input.target}`);
      const done = await tx<{ n: number }[]>`
        select count(*)::int as n from research
         where archipelago_id = ${island.archipelago_id}
           and user_id = ${input.userId} and node = ${input.target}
      `;
      if ((done[0]?.n ?? 0) > 0) throw new ValidationError(`${input.target} is already researched`);
      const queuedSame = await tx<{ n: number }[]>`
        select count(*)::int as n from queue_items
         where city_id = ${input.cityId} and status = 'queued'
           and kind = 'research' and target = ${input.target}
      `;
      if ((queuedSame[0]?.n ?? 0) > 0) throw new ValidationError(`${input.target} is already queued`);
      cost = researchCost(input.target);
      durationSeconds = researchDurationSeconds(input.target);
    }

    // The slot check. Base slots only; the Charter's +2 is a billing entitlement read
    // that lands with the monetisation wiring (README, known gaps).
    const slots =
      input.kind === 'building'
        ? BASE_BUILD_SLOTS
        : input.kind === 'ship'
          ? BASE_SHIP_SLOTS
          : BASE_RESEARCH_SLOTS;
    const queued = await tx<{ n: number; last: Date | null }[]>`
      select count(*)::int as n, max(completes_at) as last from queue_items
       where city_id = ${input.cityId} and status = 'queued' and kind = ${input.kind}
    `;
    if ((queued[0]?.n ?? 0) >= slots) {
      throw new QueueFullError(`the ${input.kind} queue holds ${slots} item(s)`);
    }

    // Settle with the rates in force, then charge — one UPDATE, same transaction as the queue row.
    const economy = await settle(tx, input.cityId, now, cost);

    // Sequential per kind: work starts when the previous item finishes.
    const lastEnd = queued[0]?.last;
    const startedAt = lastEnd && lastEnd.getTime() > now.getTime() ? lastEnd : now;
    const completesAt = new Date(startedAt.getTime() + durationSeconds * 1000);

    const items = await tx<
      { id: string; kind: string; target: string; status: string; started_at: Date; completes_at: Date }[]
    >`
      insert into queue_items (city_id, kind, target, started_at, completes_at, idempotency_key)
      values (${input.cityId}, ${input.kind}, ${input.target}, ${startedAt}, ${completesAt},
              ${input.idempotencyKey})
      returning id, kind, target, status, started_at, completes_at
    `;
    return {
      item: viewOf(items[0]!),
      replayed: false,
      stocks: stocksWire(economy.stocks),
    };
  });
}

function viewOf(row: {
  id: string;
  kind: string;
  target: string;
  status: string;
  started_at: Date;
  completes_at: Date;
}): QueueItemView {
  return {
    id: row.id,
    kind: row.kind as QueueItemView['kind'],
    target: row.target,
    status: row.status as QueueItemView['status'],
    startedAt: row.started_at,
    completesAt: row.completes_at,
  };
}

/* ------------------------------------------------------------------ completion */

/**
 * Complete every due queue item for one city. Called by the `city.queue` leased job.
 *
 * Idempotent under any race: the `status = 'queued'` guard on the UPDATE means a second runner
 * that somehow holds the same rows applies nothing. Settlement happens BEFORE the new rates are
 * written, so the elapsed interval accrues at the rates that were actually in force — settling
 * after would retroactively apply the new economy to the past.
 *
 * Returns when the next queued item is due, so the job can re-arm itself, or null.
 */
export async function completeDue(
  sql: Db,
  producer: string,
  cityId: string,
  now = new Date(),
  outbox: typeof withOutbox = withOutbox,
): Promise<Date | null> {
  return outbox(sql, producer, async (tx, emit) => {
    const due = await tx<
      { id: string; kind: string; target: string; completes_at: Date }[]
    >`
      select id, kind, target, completes_at from queue_items
       where city_id = ${cityId} and status = 'queued' and completes_at <= ${now}
       order by completes_at
       for update
    `;

    if (due.length > 0) {
      const cities = await tx<{ id: string; user_id: string; island_id: string }[]>`
        select id, user_id, island_id from cities
         where id = ${cityId} and abandoned_at is null for update
      `;
      const city = cities[0];
      if (!city) return null;
      const islands = await tx<{ band: string; archipelago_id: string }[]>`
        select band, archipelago_id from islands where id = ${city.island_id}
      `;
      const island = islands[0]!;

      let economyChanged = false;
      for (const item of due) {
        const marked = await tx<{ id: string }[]>`
          update queue_items
             set status = 'done', completed_at = ${now}
           where id = ${item.id} and status = 'queued'
          returning id
        `;
        if (marked.length === 0) continue; // another completion already took it

        if (item.kind === 'building') {
          const applied = await tx<{ level: number }[]>`
            insert into buildings (city_id, type, level)
            values (${cityId}, ${item.target}, 1)
            on conflict (city_id, type) do update
              set level = buildings.level + 1, updated_at = now()
            returning level
          `;
          economyChanged = true;
          emit({
            topic: BUILDING_COMPLETED_TOPIC,
            key: cityId,
            payload: { cityId, userId: city.user_id, type: item.target, level: applied[0]!.level },
            actor: `service:${producer}`,
          });
        } else if (item.kind === 'ship') {
          // One hull per queue item, into the garrison. No event: a ship joining its own
          // harbour is the player's plan proceeding, not news — the battles it fights are.
          await tx`
            insert into city_ships (city_id, class, count)
            values (${cityId}, ${item.target}, 1)
            on conflict (city_id, class) do update set count = city_ships.count + 1
          `;
        } else {
          await tx`
            insert into research (archipelago_id, user_id, node)
            values (${island.archipelago_id}, ${city.user_id}, ${item.target})
            on conflict (archipelago_id, user_id, node) do nothing
          `;
          emit({
            topic: RESEARCH_COMPLETED_TOPIC,
            key: cityId,
            payload: {
              cityId,
              archipelagoId: island.archipelago_id,
              userId: city.user_id,
              node: item.target,
            },
            actor: `service:${producer}`,
          });
        }
      }

      if (economyChanged) {
        // Settle the past at the OLD rates, then write the new economy the finished buildings earn.
        await settle(tx, cityId, now);
        const levelRows = await tx<{ type: string; level: number }[]>`
          select type, level from buildings where city_id = ${cityId}
        `;
        const levels = new Map(levelRows.map((row) => [row.type as BuildingType, row.level]));
        const rates = ratesFor(levels, island.band);
        const cap = storageCapFor(levels);
        await tx`
          update cities
             set rate_aether = ${rates.aether.toString()}::bigint,
                 rate_cloudstone = ${rates.cloudstone.toString()}::bigint,
                 rate_skysteel = ${rates.skysteel.toString()}::bigint,
                 rate_provisions = ${rates.provisions.toString()}::bigint,
                 storage_cap = ${cap.toString()}::bigint
           where id = ${cityId}
        `;
      }
    }

    const next = await tx<{ next: Date | null }[]>`
      select min(completes_at) as next from queue_items
       where city_id = ${cityId} and status = 'queued'
    `;
    return next[0]?.next ?? null;
  });
}
