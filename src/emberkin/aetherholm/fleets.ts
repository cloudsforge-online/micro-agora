/**
 * Fleets: launch, travel, arrival, battle, loot, return.
 *
 * The load-bearing decisions:
 *
 *   - **A launch is charged, never clamped.** Aether lift for the whole round trip — and the
 *     cargo a transfer carries — comes out of the origin's lazy stocks through the same `settle`
 *     every other spend uses; a launch the treasury cannot cover throws `InsufficientStockError`
 *     and the transaction rolls back. The `cities_stocks_settled_within_caps` CHECK stands
 *     behind it, exactly as it does behind a building queue.
 *   - **Arrival is a leased job keyed `fleet:<id>`** (src/jobs.ts). Two replicas racing one
 *     arrival serialise three times over: the job lease, the fleet row's `for update` +
 *     status guard, and — the structural floor — `battles_fleet_uniq`, which makes the second
 *     battle unrepresentable (20-aetherholm.md §9.3).
 *   - **A contested siege leases on `plot:<islandId>:<n>`.** Arrival only marks a siege fleet
 *     `besieging` and enqueues the plot's job; every battle for that plot then happens under one
 *     lease, in arrival order, against a garrison that shrinks as it loses.
 *   - **Loot rides only in Haulers** (the freight classes, src/content.ts). Capacity is counted
 *     over the SURVIVORS, so a raid that loses its haulers wins nothing; the defender's Vault
 *     protects its stated floor per resource. Loot moves between cities' stocks under the same
 *     CHECKs as everything else.
 */

import { randomUUID } from 'node:crypto';
import {
  AIRSHIPS,
  FREIGHT_CLASSES,
  RESOURCES,
  VAULT_PROTECTION_PER_LEVEL,
  isAirshipClass,
  type AirshipClass,
  type Resource,
  type Stocks,
} from './content.ts';
import { settle, stocksWire, snapshotAt, type CityEconomyRow } from './economy.ts';
import { battleDigest, resolveBattle, windAdvantageBp, type OrderOfBattle } from './battles.ts';
import { ensureLattice, shortestPath, type LaneRow } from './lattice.ts';
import {
  IdempotencyConflictError,
  NotFoundError,
  NotOwnerError,
  ValidationError,
} from './cities.ts';
import { assertNotSealed, isUniqueViolation, SeasonSealedError } from './seasons.ts';
import { withOutbox, type Db, type Tx } from './outbox.ts';

export { SeasonSealedError };

export const BATTLE_RESOLVED_TOPIC = 'aetherholm.battle.resolved';

/** Alliance shared lanes: a lane whose BOTH endpoints are claimed by your alliance flies 10%
 *  faster. Convenience on friendly ground, never a weapon — it cannot touch a battle. */
export const SHARED_LANE_DISCOUNT_BP = 9000;

export class InsufficientShipsError extends Error {
  constructor(cls: string, wanted: number) {
    super(`the garrison does not hold ${wanted} ${cls}`);
    this.name = 'InsufficientShipsError';
  }
}
export class AegisError extends Error {
  constructor(until: Date) {
    super(`the target city is under its aegis until ${until.toISOString()}`);
    this.name = 'AegisError';
  }
}
export class NoRouteError extends Error {
  constructor() {
    super('no wind lane reaches that island');
    this.name = 'NoRouteError';
  }
}

export type Mission = 'transfer' | 'raid' | 'siege';

export interface LaunchInput {
  readonly cityId: string;
  readonly userId: string;
  readonly mission: Mission;
  readonly ships: Readonly<Record<string, number>>;
  readonly cargo?: Readonly<Partial<Record<Resource, bigint>>>;
  readonly targetIslandId: string;
  /** Required for raid and siege; ignored for transfer (the target is your own city there). */
  readonly targetCityId?: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly now?: Date;
}

export interface FleetView {
  readonly id: string;
  readonly originCityId: string;
  readonly userId: string;
  readonly mission: Mission;
  readonly status: string;
  readonly targetIslandId: string;
  readonly targetCityId: string | null;
  readonly ships: Readonly<Record<string, string>>;
  readonly cargo: Record<string, string>;
  readonly aetherLift: string;
  readonly departedAt: Date;
  readonly arrivesAt: Date;
  readonly returnsAt: Date | null;
  readonly travelSeconds: number;
}

export interface LaunchResult {
  readonly fleet: FleetView;
  readonly replayed: boolean;
  readonly stocks: Record<string, string>;
}

interface FleetRow {
  readonly id: string;
  readonly origin_city_id: string;
  readonly user_id: string;
  readonly mission: Mission;
  readonly status: string;
  readonly target_island_id: string;
  readonly target_city_id: string | null;
  readonly approach_lane_id: string | null;
  readonly departed_at: Date;
  readonly arrives_at: Date;
  readonly travel_seconds: number;
  readonly return_seconds: number;
  readonly returns_at: Date | null;
  readonly aether_lift: string;
  readonly cargo_aether: string;
  readonly cargo_cloudstone: string;
  readonly cargo_skysteel: string;
  readonly cargo_provisions: string;
}

const FLEET_COLUMNS = `
  id, origin_city_id, user_id, mission, status, target_island_id, target_city_id,
  approach_lane_id, departed_at, arrives_at, travel_seconds, return_seconds, returns_at,
  aether_lift::text,
  cargo_aether::text, cargo_cloudstone::text, cargo_skysteel::text, cargo_provisions::text
`;

function cargoOf(row: FleetRow): Stocks {
  return {
    aether: BigInt(row.cargo_aether),
    cloudstone: BigInt(row.cargo_cloudstone),
    skysteel: BigInt(row.cargo_skysteel),
    provisions: BigInt(row.cargo_provisions),
  };
}

async function fleetView(sql: Db | Tx, row: FleetRow): Promise<FleetView> {
  const ships = await sql<{ class: string; count: string }[]>`
    select class, count::text from fleet_ships where fleet_id = ${row.id} order by class
  `;
  return {
    id: row.id,
    originCityId: row.origin_city_id,
    userId: row.user_id,
    mission: row.mission,
    status: row.status,
    targetIslandId: row.target_island_id,
    targetCityId: row.target_city_id,
    ships: Object.fromEntries(ships.map((ship) => [ship.class, ship.count])),
    cargo: stocksWire(cargoOf(row)),
    aetherLift: row.aether_lift,
    departedAt: row.departed_at,
    arrivesAt: row.arrives_at,
    returnsAt: row.returns_at,
    travelSeconds: row.travel_seconds,
  };
}

export async function getFleet(sql: Db, fleetId: string): Promise<FleetView | null> {
  const rows = await sql<FleetRow[]>`
    select ${sql.unsafe(FLEET_COLUMNS)} from fleets where id = ${fleetId}
  `;
  const row = rows[0];
  return row ? fleetView(sql, row) : null;
}

export async function listFleetsFor(sql: Db, userId: string): Promise<FleetView[]> {
  const rows = await sql<FleetRow[]>`
    select ${sql.unsafe(FLEET_COLUMNS)} from fleets
     where user_id = ${userId}
     order by departed_at desc
     limit 100
  `;
  const fleets: FleetView[] = [];
  for (const row of rows) fleets.push(await fleetView(sql, row));
  return fleets;
}

/** The caller's alliance-claimed islands on this archipelago, for the shared-lane discount. */
async function claimedIslandsOf(tx: Tx, archipelagoId: string, userId: string): Promise<ReadonlySet<string>> {
  const rows = await tx<{ island_id: string }[]>`
    select c.island_id
      from alliance_members m
      join alliance_claims c on c.alliance_id = m.alliance_id
     where m.archipelago_id = ${archipelagoId} and m.user_id = ${userId}
  `;
  return new Set(rows.map((row) => row.island_id));
}

function effectiveLaneSeconds(claimed: ReadonlySet<string>): (lane: LaneRow) => number {
  return (lane) =>
    claimed.has(lane.fromIslandId) && claimed.has(lane.toIslandId)
      ? Math.max(1, Math.floor((lane.travelSeconds * SHARED_LANE_DISCOUNT_BP) / 10000))
      : lane.travelSeconds;
}

/**
 * Launch a fleet. Idempotent on `(origin city, Idempotency-Key)`; the fingerprint compared on
 * replay is `(mission, targetIslandId)` — never the correlation id.
 */
export async function launchFleet(
  sql: Db,
  producer: string,
  input: LaunchInput,
  outbox: typeof withOutbox = withOutbox,
): Promise<LaunchResult> {
  const now = input.now ?? new Date();

  const shipEntries = Object.entries(input.ships).filter(([, count]) => count !== 0);
  if (shipEntries.length === 0) throw new ValidationError('a fleet needs at least one ship');
  for (const [cls, count] of shipEntries) {
    if (!isAirshipClass(cls)) throw new ValidationError(`unknown airship class: ${cls}`);
    if (!Number.isInteger(count) || count < 1 || count > 1_000_000) {
      throw new ValidationError(`ship counts must be whole and positive (${cls}: ${count})`);
    }
  }
  const cargo: Partial<Record<Resource, bigint>> = {};
  for (const resource of RESOURCES) {
    const amount = input.cargo?.[resource] ?? 0n;
    if (amount < 0n) throw new ValidationError('cargo cannot be negative');
    if (amount > 0n) cargo[resource] = amount;
  }
  if (Object.keys(cargo).length > 0 && input.mission !== 'transfer') {
    throw new ValidationError('only a transfer departs loaded; a raid fills its holds out there');
  }

  return outbox(sql, producer, async (tx, emit) => {
    void emit;
    const cities = await tx<{ id: string; user_id: string; island_id: string }[]>`
      select id, user_id, island_id from cities
       where id = ${input.cityId} and abandoned_at is null
       for update
    `;
    const origin = cities[0];
    if (!origin) throw new NotFoundError('no such city');
    if (origin.user_id !== input.userId) throw new NotOwnerError('not your city');

    const islandRows = await tx<{ archipelago_id: string }[]>`
      select archipelago_id from islands where id = ${origin.island_id}
    `;
    const archipelagoId = islandRows[0]!.archipelago_id;
    await assertNotSealed(tx, archipelagoId);

    // Replay before anything is charged.
    const replays = await tx<FleetRow[]>`
      select ${tx.unsafe(FLEET_COLUMNS)} from fleets
       where origin_city_id = ${input.cityId} and idempotency_key = ${input.idempotencyKey}
    `;
    const replay = replays[0];
    if (replay) {
      if (replay.mission !== input.mission || replay.target_island_id !== input.targetIslandId) {
        throw new IdempotencyConflictError('this Idempotency-Key was already used for a different launch');
      }
      const economy = await settle(tx, input.cityId, now);
      return { fleet: await fleetView(tx, replay), replayed: true, stocks: stocksWire(economy.stocks) };
    }

    const targets = await tx<{ id: string; archipelago_id: string }[]>`
      select id, archipelago_id from islands where id = ${input.targetIslandId}
    `;
    const targetIsland = targets[0];
    if (!targetIsland) throw new NotFoundError('no such island');
    if (targetIsland.archipelago_id !== archipelagoId) {
      throw new ValidationError('no lane crosses between archipelagos');
    }
    if (targetIsland.id === origin.island_id && input.mission === 'transfer') {
      throw new ValidationError('the fleet is already home');
    }

    // The route. Lanes are ensured here so pre-lattice phase-1 worlds grow theirs on first use.
    const lanes = await ensureLattice(tx, archipelagoId);
    const claimed = await claimedIslandsOf(tx, archipelagoId, input.userId);
    const seconds = effectiveLaneSeconds(claimed);
    const outboundPath = shortestPath(lanes, origin.island_id, input.targetIslandId, seconds);
    const returnPath = shortestPath(lanes, input.targetIslandId, origin.island_id, seconds);
    if (!outboundPath || !returnPath || outboundPath.lanes.length === 0) throw new NoRouteError();

    // The fleet flies at its slowest ship's pace.
    let speedBp = 0;
    for (const [cls] of shipEntries) speedBp = Math.max(speedBp, AIRSHIPS[cls as AirshipClass].speedBp);
    const travelSeconds = Math.max(1, Math.floor((outboundPath.seconds * speedBp) / 10000));
    const returnSeconds = Math.max(1, Math.floor((returnPath.seconds * speedBp) / 10000));
    const arrivesAt = new Date(now.getTime() + travelSeconds * 1000);
    const approachLane = outboundPath.lanes[outboundPath.lanes.length - 1]!;

    // Mission targets.
    let targetCityId: string | null = null;
    if (input.mission === 'transfer') {
      const own = await tx<{ id: string }[]>`
        select id from cities
         where island_id = ${input.targetIslandId} and user_id = ${input.userId}
           and abandoned_at is null
      `;
      if (!own[0]) throw new ValidationError('a transfer lands at your own city, and you hold none there');
      targetCityId = own[0].id;
    } else {
      if (!input.targetCityId) throw new ValidationError(`a ${input.mission} must name its target city`);
      const target = await tx<{ id: string; user_id: string; aegis_until: Date }[]>`
        select id, user_id, aegis_until from cities
         where id = ${input.targetCityId} and island_id = ${input.targetIslandId}
           and abandoned_at is null
      `;
      const targetCity = target[0];
      if (!targetCity) throw new NotFoundError('no such city on that island');
      if (targetCity.user_id === input.userId) throw new ValidationError('you cannot attack your own city');
      // The free aegis holds against the ATTACK, so it is judged at arrival time: launching a
      // slow fleet at a shield about to lapse is legitimate strategy; landing on one is not.
      if (targetCity.aegis_until.getTime() > arrivesAt.getTime()) {
        throw new AegisError(targetCity.aegis_until);
      }
      if (input.mission === 'siege' && !shipEntries.some(([cls]) => AIRSHIPS[cls as AirshipClass].role === 'siege')) {
        throw new ValidationError('a siege needs at least one Breaker');
      }
      targetCityId = targetCity.id;
    }

    // Lift for the round trip, charged now: a fleet that cannot afford to come home does not
    // leave. Ceiling arithmetic so no leg is ever free.
    let liftPerHour = 0n;
    for (const [cls, count] of shipEntries) {
      liftPerHour += AIRSHIPS[cls as AirshipClass].liftPerHour * BigInt(count);
    }
    const lift = (liftPerHour * BigInt(travelSeconds + returnSeconds) + 3599n) / 3600n;

    // Settle-and-charge: lift plus the transfer's cargo, one UPDATE, refused — never clamped —
    // when the stocks cannot cover it.
    const spend: Partial<Stocks> = { ...cargo, aether: (cargo.aether ?? 0n) + lift };
    const economy = await settle(tx, input.cityId, now, spend);

    // Ships out of the garrison, guarded per class: the CHECK refuses a negative count even if
    // this guard were mis-written.
    for (const [cls, count] of shipEntries) {
      const taken = await tx<{ count: string }[]>`
        update city_ships set count = count - ${count}
         where city_id = ${input.cityId} and class = ${cls} and count >= ${count}
        returning count::text
      `;
      if (taken.length === 0) throw new InsufficientShipsError(cls, count);
    }

    let fleetId: string;
    try {
      const inserted = await tx<{ id: string }[]>`
        insert into fleets (
          origin_city_id, user_id, mission, status, target_island_id, target_city_id,
          approach_lane_id, departed_at, arrives_at, travel_seconds, return_seconds,
          aether_lift, cargo_aether, cargo_cloudstone, cargo_skysteel, cargo_provisions,
          idempotency_key
        ) values (
          ${input.cityId}, ${input.userId}, ${input.mission}, 'outbound',
          ${input.targetIslandId}, ${targetCityId}, ${approachLane.id}, ${now}, ${arrivesAt},
          ${travelSeconds}, ${returnSeconds}, ${lift.toString()}::bigint,
          ${(cargo.aether ?? 0n).toString()}::bigint,
          ${(cargo.cloudstone ?? 0n).toString()}::bigint,
          ${(cargo.skysteel ?? 0n).toString()}::bigint,
          ${(cargo.provisions ?? 0n).toString()}::bigint,
          ${input.idempotencyKey}
        )
        returning id
      `;
      fleetId = inserted[0]!.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new IdempotencyConflictError('this Idempotency-Key was already used for a different launch');
      }
      throw err;
    }
    const shipRows = shipEntries.map(([cls, count]) => ({ fleet_id: fleetId, class: cls, count }));
    // The deferred `fleets_cargo_within_hold` judges cargo against these rows at COMMIT: a
    // transfer loaded past its holds fails here, whatever order the two inserts ran in.
    await tx`insert into fleet_ships ${tx(shipRows)}`;

    const rows = await tx<FleetRow[]>`
      select ${tx.unsafe(FLEET_COLUMNS)} from fleets where id = ${fleetId}
    `;
    return { fleet: await fleetView(tx, rows[0]!), replayed: false, stocks: stocksWire(economy.stocks) };
  });
}

/* ------------------------------------------------------------------ deposits */

/**
 * Settle a city and add to its stocks, clamped at the warehouse cap — arriving cargo obeys the
 * same ceiling as accrual, and the overflow spills into the sky. Returns what was actually kept.
 */
export async function depositInto(
  tx: Tx,
  cityId: string,
  now: Date,
  amounts: Stocks,
): Promise<Stocks> {
  const settled = await settle(tx, cityId, now);
  const kept: Record<Resource, bigint> = { aether: 0n, cloudstone: 0n, skysteel: 0n, provisions: 0n };
  const next: Record<Resource, bigint> = { ...settled.stocks };
  for (const resource of RESOURCES) {
    const room = settled.cap - next[resource];
    kept[resource] = amounts[resource] > room ? room : amounts[resource];
    if (kept[resource] < 0n) kept[resource] = 0n;
    next[resource] += kept[resource];
  }
  await tx`
    update cities
       set aether = ${next.aether.toString()}::bigint,
           cloudstone = ${next.cloudstone.toString()}::bigint,
           skysteel = ${next.skysteel.toString()}::bigint,
           provisions = ${next.provisions.toString()}::bigint
     where id = ${cityId}
  `;
  return kept;
}

/* ------------------------------------------------------------------ arrival */

export interface ArrivalInstruction {
  readonly kind: 'siege' | 'return' | 'none';
  readonly islandId?: string;
  readonly plot?: number;
  readonly returnsAt?: Date;
  /** Set by `resolveSieges`, whose caller must know which fleet each instruction re-arms. */
  readonly fleetId?: string;
}

interface DefenderContext {
  readonly cityId: string;
  readonly userId: string;
  readonly cityName: string;
  readonly islandId: string;
  readonly plot: number;
  readonly garrison: Partial<Record<AirshipClass, number>>;
  readonly bulwarkLevel: number;
  readonly vaultLevel: number;
}

async function defenderContext(tx: Tx, cityId: string): Promise<DefenderContext | null> {
  const cities = await tx<
    { id: string; user_id: string; name: string; island_id: string; plot: number; aegis_until: Date }[]
  >`
    select id, user_id, name, island_id, plot, aegis_until from cities
     where id = ${cityId} and abandoned_at is null
     for update
  `;
  const city = cities[0];
  if (!city) return null;
  const shipRows = await tx<{ class: AirshipClass; count: string }[]>`
    select class, count::text from city_ships where city_id = ${cityId} and count > 0
  `;
  const garrison: Partial<Record<AirshipClass, number>> = {};
  for (const row of shipRows) garrison[row.class] = Number(row.count);
  const works = await tx<{ type: string; level: number }[]>`
    select type, level from buildings
     where city_id = ${cityId} and type in ('bulwark_ring', 'vault')
  `;
  const levelOf = (type: string): number => works.find((w) => w.type === type)?.level ?? 0;
  return {
    cityId: city.id,
    userId: city.user_id,
    cityName: city.name,
    islandId: city.island_id,
    plot: city.plot,
    garrison,
    bulwarkLevel: levelOf('bulwark_ring'),
    vaultLevel: levelOf('vault'),
  };
}

async function fleetShips(tx: Tx, fleetId: string): Promise<Partial<Record<AirshipClass, number>>> {
  const rows = await tx<{ class: AirshipClass; count: string }[]>`
    select class, count::text from fleet_ships where fleet_id = ${fleetId}
  `;
  const ships: Partial<Record<AirshipClass, number>> = {};
  for (const row of rows) ships[row.class] = Number(row.count);
  return ships;
}

async function writeFleetShips(
  tx: Tx,
  fleetId: string,
  remaining: Readonly<Partial<Record<AirshipClass, number>>>,
): Promise<void> {
  await tx`delete from fleet_ships where fleet_id = ${fleetId}`;
  const rows = Object.entries(remaining)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([cls, count]) => ({ fleet_id: fleetId, class: cls, count: count! }));
  if (rows.length > 0) await tx`insert into fleet_ships ${tx(rows)}`;
}

async function writeGarrison(
  tx: Tx,
  cityId: string,
  before: Readonly<Partial<Record<AirshipClass, number>>>,
  remaining: Readonly<Partial<Record<AirshipClass, number>>>,
): Promise<void> {
  for (const cls of Object.keys(before) as AirshipClass[]) {
    await tx`
      update city_ships set count = ${remaining[cls] ?? 0}
       where city_id = ${cityId} and class = ${cls}
    `;
  }
}

function lootCapacity(remaining: Readonly<Partial<Record<AirshipClass, number>>>): bigint {
  let capacity = 0n;
  for (const cls of FREIGHT_CLASSES) capacity += AIRSHIPS[cls].cargo * BigInt(remaining[cls] ?? 0);
  return capacity;
}

/**
 * Fight one battle for an arrived fleet against a defended city, inside the caller's
 * transaction: resolve deterministically, persist the immutable report, apply losses, take loot
 * if the attacker won and has holds left, and emit `aetherholm.battle.resolved`.
 *
 * Returns the surviving attacker ships and whether the attacker won.
 */
async function fightBattle(
  tx: Tx,
  emit: (event: {
    topic: string;
    key: string;
    payload: Record<string, unknown>;
    actor?: string;
  }) => void,
  fleet: FleetRow,
  defender: DefenderContext,
  archipelagoId: string,
  seed: bigint,
  now: Date,
): Promise<{ attackerWon: boolean; remaining: Partial<Record<AirshipClass, number>>; razed: boolean }> {
  const laneRows = fleet.approach_lane_id
    ? await tx<{ multiplier_bp: number }[]>`
        select multiplier_bp from lanes where id = ${fleet.approach_lane_id}
      `
    : [];
  const windBp = laneRows[0] ? windAdvantageBp(laneRows[0].multiplier_bp) : 10000;

  const attackerOob: OrderOfBattle = { ships: await fleetShips(tx, fleet.id), bulwarkLevel: 0 };
  const defenderOob: OrderOfBattle = { ships: defender.garrison, bulwarkLevel: defender.bulwarkLevel };

  const battleId = randomUUID();
  const input = { battleId, seed, attacker: attackerOob, defender: defenderOob, windBp };
  const result = resolveBattle(input);
  const digest = battleDigest(input, result);

  // The immutable report. `battles_fleet_uniq` is what makes a second battle for this arrival
  // unrepresentable, whatever raced.
  await tx`
    insert into battles (
      id, archipelago_id, island_id, plot, fleet_id, mission, lane_id,
      attacker_user_id, defender_user_id, seed, wind_bp,
      attacker_oob, defender_oob, result, digest, occurred_at
    ) values (
      ${battleId}, ${archipelagoId}, ${defender.islandId}, ${defender.plot}, ${fleet.id},
      ${fleet.mission}, ${fleet.approach_lane_id}, ${fleet.user_id}, ${defender.userId},
      ${seed.toString()}, ${windBp},
      ${tx.json(JSON.parse(JSON.stringify(attackerOob)) as never)},
      ${tx.json(JSON.parse(JSON.stringify(defenderOob)) as never)},
      ${tx.json(JSON.parse(JSON.stringify(result)) as never)},
      ${digest}, ${now}
    )
  `;

  await writeFleetShips(tx, fleet.id, result.attackerRemaining);
  await writeGarrison(tx, defender.cityId, defender.garrison, result.defenderRemaining);

  const attackerWon = result.winner === 'attacker';
  let loot: Stocks = { aether: 0n, cloudstone: 0n, skysteel: 0n, provisions: 0n };
  let razed = false;

  if (attackerWon) {
    // Loot rides only in the freight holds that SURVIVED; the Vault's floor is untouchable.
    let capacity = lootCapacity(result.attackerRemaining);
    if (capacity > 0n) {
      const settled = await settle(tx, defender.cityId, now);
      const taken: Record<Resource, bigint> = { aether: 0n, cloudstone: 0n, skysteel: 0n, provisions: 0n };
      const floor = VAULT_PROTECTION_PER_LEVEL * BigInt(defender.vaultLevel);
      for (const resource of RESOURCES) {
        if (capacity <= 0n) break;
        const open = settled.stocks[resource] - floor;
        if (open <= 0n) continue;
        taken[resource] = open > capacity ? capacity : open;
        capacity -= taken[resource];
      }
      loot = taken;
      if (RESOURCES.some((resource) => taken[resource] > 0n)) {
        await settle(tx, defender.cityId, now, taken);
        await tx`
          update fleets
             set cargo_aether = ${loot.aether.toString()}::bigint,
                 cargo_cloudstone = ${loot.cloudstone.toString()}::bigint,
                 cargo_skysteel = ${loot.skysteel.toString()}::bigint,
                 cargo_provisions = ${loot.provisions.toString()}::bigint
           where id = ${fleet.id}
        `;
      }
    }
    if (fleet.mission === 'siege') {
      // The city falls. `abandoned_at` frees the plot under the partial uniques without
      // deleting history — exactly what the phase-1 schema left the column for.
      await tx`update cities set abandoned_at = ${now} where id = ${defender.cityId}`;
      razed = true;
    }
  }

  emit({
    topic: BATTLE_RESOLVED_TOPIC,
    key: battleId,
    payload: {
      battleId,
      fleetId: fleet.id,
      mission: fleet.mission,
      islandId: defender.islandId,
      plot: defender.plot,
      cityId: defender.cityId,
      cityName: defender.cityName,
      attackerUserId: fleet.user_id,
      defenderUserId: defender.userId,
      outcome: razed ? 'razed' : attackerWon ? 'raided' : 'repelled',
      loot: stocksWire(loot),
      digest,
      occurredAt: now.toISOString(),
    },
    actor: `user:${fleet.user_id}`,
  });

  return { attackerWon, remaining: result.attackerRemaining, razed };
}

/** Send a fleet home, or finish it where it stands if nothing survived. */
async function turnHome(
  tx: Tx,
  fleet: FleetRow,
  survivors: Readonly<Partial<Record<AirshipClass, number>>>,
  now: Date,
): Promise<ArrivalInstruction> {
  const anyLeft = Object.values(survivors).some((count) => (count ?? 0) > 0);
  if (!anyLeft) {
    await tx`
      update fleets set status = 'done', resolved_at = ${now},
             cargo_aether = 0, cargo_cloudstone = 0, cargo_skysteel = 0, cargo_provisions = 0
       where id = ${fleet.id}
    `;
    return { kind: 'none' };
  }
  const returnsAt = new Date(now.getTime() + fleet.return_seconds * 1000);
  await tx`
    update fleets set status = 'returning', returns_at = ${returnsAt} where id = ${fleet.id}
  `;
  return { kind: 'return', returnsAt };
}

/**
 * Resolve one fleet's arrival. Called under the `fleet:<id>` lease; idempotent under any race:
 * the row is locked `for update` and the status guard means a second runner applies nothing.
 */
export async function resolveArrival(
  sql: Db,
  producer: string,
  fleetId: string,
  now = new Date(),
  outbox: typeof withOutbox = withOutbox,
): Promise<ArrivalInstruction> {
  return outbox(sql, producer, async (tx, emit) => {
    const rows = await tx<FleetRow[]>`
      select ${tx.unsafe(FLEET_COLUMNS)} from fleets
       where id = ${fleetId} and status = 'outbound' and arrives_at <= ${now}
       for update
    `;
    const fleet = rows[0];
    if (!fleet) return { kind: 'none' };

    const islands = await tx<{ archipelago_id: string }[]>`
      select archipelago_id from islands where id = ${fleet.target_island_id}
    `;
    const archipelagoId = islands[0]!.archipelago_id;

    if (fleet.mission === 'siege') {
      // The battle does NOT happen here: contested sieges serialise under the plot's own lease.
      const target = await tx<{ island_id: string; plot: number }[]>`
        select island_id, plot from cities where id = ${fleet.target_city_id}
      `;
      await tx`update fleets set status = 'besieging' where id = ${fleet.id}`;
      if (!target[0]) {
        // The city was razed or abandoned while the fleet flew; nothing to besiege.
        return turnHome(tx, fleet, await fleetShips(tx, fleet.id), now);
      }
      return { kind: 'siege', islandId: target[0].island_id, plot: target[0].plot };
    }

    if (fleet.mission === 'transfer') {
      const destination = fleet.target_city_id
        ? await defenderContext(tx, fleet.target_city_id)
        : null;
      if (destination && destination.userId === fleet.user_id) {
        await depositInto(tx, destination.cityId, now, cargoOf(fleet));
        await tx`
          update fleets set cargo_aether = 0, cargo_cloudstone = 0, cargo_skysteel = 0,
                 cargo_provisions = 0
           where id = ${fleet.id}
        `;
      }
      // Destination gone (or captured): the cargo rides home again.
      return turnHome(tx, fleet, await fleetShips(tx, fleet.id), now);
    }

    // A raid.
    const defender = fleet.target_city_id ? await defenderContext(tx, fleet.target_city_id) : null;
    if (!defender) {
      return turnHome(tx, fleet, await fleetShips(tx, fleet.id), now);
    }
    const aegis = await tx<{ aegis_until: Date }[]>`
      select aegis_until from cities where id = ${defender.cityId}
    `;
    if (aegis[0] && aegis[0].aegis_until.getTime() > now.getTime()) {
      // The shield went up after launch (a fresh refound): no battle under an aegis, ever.
      return turnHome(tx, fleet, await fleetShips(tx, fleet.id), now);
    }
    const fought = await fightBattle(tx, emit, fleet, defender, archipelagoId, await seedOf(tx, archipelagoId), now);
    return turnHome(tx, fleet, fought.remaining, now);
  });
}

async function seedOf(tx: Tx, archipelagoId: string): Promise<bigint> {
  const rows = await tx<{ seed: string }[]>`
    select seed::text from archipelagos where id = ${archipelagoId}
  `;
  return BigInt(rows[0]!.seed);
}

/**
 * Resolve every due siege against one plot, in arrival order, under the `plot:<islandId>:<n>`
 * lease. The garrison carries its losses forward between consecutive sieges; the first besieger
 * to win razes the city and the rest arrive to an empty plot and turn for home.
 */
export async function resolveSieges(
  sql: Db,
  producer: string,
  islandId: string,
  plot: number,
  now = new Date(),
  outbox: typeof withOutbox = withOutbox,
): Promise<readonly ArrivalInstruction[]> {
  return outbox(sql, producer, async (tx, emit) => {
    const besiegers = await tx<FleetRow[]>`
      select ${tx.unsafe(FLEET_COLUMNS)} from fleets f
       where f.status = 'besieging'
         and f.target_city_id in (
           select id from cities where island_id = ${islandId} and plot = ${plot}
         )
       order by f.arrives_at, f.id
       for update
    `;
    if (besiegers.length === 0) return [];

    const islands = await tx<{ archipelago_id: string }[]>`
      select archipelago_id from islands where id = ${islandId}
    `;
    const archipelagoId = islands[0]!.archipelago_id;
    const seed = await seedOf(tx, archipelagoId);

    const instructions: ArrivalInstruction[] = [];
    for (const fleet of besiegers) {
      const defender = fleet.target_city_id ? await defenderContext(tx, fleet.target_city_id) : null;
      if (!defender) {
        instructions.push({ ...(await turnHome(tx, fleet, await fleetShips(tx, fleet.id), now)), fleetId: fleet.id });
        continue;
      }
      const fought = await fightBattle(tx, emit, fleet, defender, archipelagoId, seed, now);
      instructions.push({ ...(await turnHome(tx, fleet, fought.remaining, now)), fleetId: fleet.id });
    }
    return instructions;
  });
}

/**
 * Complete a returning fleet: cargo into the origin's stocks (clamped at cap), survivors back
 * into the garrison. If home was razed while the fleet flew, there is nothing to land on — the
 * ships disband and the cargo is lost with the city that would have held it.
 */
export async function completeReturn(
  sql: Db,
  producer: string,
  fleetId: string,
  now = new Date(),
  outbox: typeof withOutbox = withOutbox,
): Promise<void> {
  await outbox(sql, producer, async (tx) => {
    const rows = await tx<FleetRow[]>`
      select ${tx.unsafe(FLEET_COLUMNS)} from fleets
       where id = ${fleetId} and status = 'returning' and returns_at <= ${now}
       for update
    `;
    const fleet = rows[0];
    if (!fleet) return;

    const home = await tx<{ id: string }[]>`
      select id from cities where id = ${fleet.origin_city_id} and abandoned_at is null
       for update
    `;
    if (home[0]) {
      await depositInto(tx, fleet.origin_city_id, now, cargoOf(fleet));
      const ships = await fleetShips(tx, fleet.id);
      for (const [cls, count] of Object.entries(ships)) {
        if ((count ?? 0) <= 0) continue;
        await tx`
          insert into city_ships (city_id, class, count)
          values (${fleet.origin_city_id}, ${cls}, ${count})
          on conflict (city_id, class) do update set count = city_ships.count + ${count}
        `;
      }
    }
    await tx`
      update fleets set status = 'done', resolved_at = ${now},
             cargo_aether = 0, cargo_cloudstone = 0, cargo_skysteel = 0, cargo_provisions = 0
       where id = ${fleet.id}
    `;
  });
}
