/**
 * The HTTP surface: aetherholm's routes, each handler closed over aetherholm's dependency bag.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * Two routes ARE the title contract `worlds` calls (worlds/src/titleclient.ts, :134):
 *
 *   `GET  /v1/title`      — the descriptor. Public and unauthenticated: it is a capability
 *                           statement, not data, and worlds' conformance suite reads it before
 *                           anything is provisioned.
 *   `POST /v1/provision`  — service-token only, scope `aetherholm:provision`. An unauthenticated
 *                           or foreign-credential call is refused (conformance checks 8 and 9: a
 *                           provisioning endpoint anybody can reach is a free-worlds endpoint).
 *                           Idempotent on the entitlement id; an unknown SKU is 422 `unsupported`,
 *                           an ANSWER the bridge records as terminal rather than retrying.
 *
 * Everything else is city play. Queue submissions REQUIRE an `Idempotency-Key` and replay rather
 * than 409 on retry — the emberkin battle-submission pattern, for the same reason: a retried
 * mutation must read what the first attempt did, not do it again.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WAVE M3: THIS FILE MOVED, AND EVERY HANDLER LOST ITS `deps` PARAMETER.**
 *
 * micro-deploy `docs/service-merge-plan.md`: emberkin absorbs this title, so these routes are
 * mounted beside emberkin's in one process. `createRoutes` is called once with THIS module's
 * dependency bag and returns specs the kernel can mount without ever seeing it — which is what
 * makes two bags in one process a scope rather than a convention.
 *
 * It is not decoration. `deps.queue` is a handle on ONE database's `jobs` table and `deps.producer`
 * is the name stamped on every outbox row; a shared bag would have this title's `city.queue` jobs
 * landing in emberkin's database, where nothing will ever claim them.
 *
 * The route bodies below are unchanged. `buildRoutes()` became `createRoutes(deps)`, the per-route
 * error mapping moved from one `handle()` around the whole dispatch into `guarded()` around each
 * handler — so this title's twelve domain errors still map through THIS file and never through
 * emberkin's — and the request lifecycle went to `../kernel.ts`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { IncomingMessage } from 'node:http';
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireScope,
  statusFor,
  type Principal,
} from '@cloudsforge/auth';
import type { Lifecycle } from '@cloudsforge/lifecycle';
import type { JobQueue } from '@cloudsforge/jobs';
import { SIGNATURE_HEADER, verifyEventSignature, withInbox, type Db } from './outbox.ts';
import { USER_DELETED_TOPIC, eraseUser } from './erasure.ts';
import {
  IdempotencyConflictError,
  NotFoundError,
  NotOwnerError,
  PlotTakenError,
  QueueFullError,
  ValidationError,
  foundCity,
  getCity,
  listCitiesFor,
  queueWork,
} from './cities.ts';
import { stocksWire, InsufficientStockError } from './economy.ts';
import { ensureOpenSeason, listIslands, openSeason } from './seasons.ts';
import {
  PROVISION_PATH,
  TITLE_DESCRIPTOR_PATH,
  UNSUPPORTED_CODE,
  UNSUPPORTED_STATUS,
  parseProvisionRequest,
  serialiseProvisionResult,
  serialiseTitleDescriptor,
  type Capability,
  type TitleDescriptor,
} from '@cloudsforge/contracts-worlds';
import { UnsupportedSkuError, listArchipelagosOwnedBy, provisionSkerry } from './provisioning.ts';
import { CITY_QUEUE_KIND, FLEET_KIND, cityQueueKey, fleetKey } from './jobs.ts';
import {
  AIRSHIPS,
  AIRSHIP_CLASSES,
  BUILDING_TYPES,
  RESEARCH_BRANCHES,
  RESEARCH_NODES,
  RESOURCES,
  buildingCost,
  buildingDurationSeconds,
  researchCost,
  researchDurationSeconds,
  type Resource,
} from './content.ts';
import { ensureLattice } from './lattice.ts';
import { archipelagoVisibleTo } from './visibility.ts';
import {
  AegisError,
  InsufficientShipsError,
  NoRouteError,
  SeasonSealedError,
  getFleet,
  launchFleet,
  listFleetsFor,
  type Mission,
} from './fleets.ts';
import {
  AlreadyAlignedError,
  ClaimTakenError,
  NotMemberError,
  claimIsland,
  foundAlliance,
  getAlliance,
  joinAlliance,
  leaveAlliance,
  listAlliances,
} from './alliances.ts';
import { listBattlesFor } from './battles.ts';
import { getChronicle, listChronicles, listSealedBattles } from './sealing.ts';
import {
  errorReply,
  headerOf,
  type MountDeps,
  type Reply,
  type RequestContext,
  type RouteSpec,
} from '../../kernel.ts';

export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>;
}

/** This title's slug in worlds' registry — the one place it is spelled. */
export const TITLE_SLUG = 'aetherholm';

export const AETHERHOLM_READ_SCOPE = 'aetherholm:read';
export const AETHERHOLM_WRITE_SCOPE = 'aetherholm:write';
/**
 * The scope worlds' credential must carry to provision. Checked, not assumed — conformance 8/9.
 *
 * **A LITERAL on purpose, and it must stay one.** The obvious tidy-up is
 * `provisionScopeFor(TITLE_SLUG)`, which is where this started; the estate's scope audit rejects it
 * — "'AETHERHOLM_PROVISION_SCOPE' resolves to no string constant in this repository — fail, do not guess". It
 * is right to. That audit proves every scope a gate demands exists in `contracts-auth`, so identity
 * can actually mint it, and a scope it cannot resolve is a gate it cannot check. Making the audit
 * blind here to make the code prettier would trade a real guarantee for a cosmetic one.
 *
 * The agreement with the contract is kept anyway, in `titlecontract.test.ts`, which asserts this
 * equals `provisionScopeFor(TITLE_SLUG)`. So a drift still fails a test — it just fails it
 * somewhere the audit can still read this file.
 */
export const AETHERHOLM_PROVISION_SCOPE = 'aetherholm:provision';

/**
 * The descriptor `GET /v1/title` serves. `private_world` is the one capability phase 1 delivers;
 * declaring more would be the typo'd-capability defect worlds' conformance check 4 exists for.
 *
 * **`capabilities` is typed `Capability[]` now, not `string[]`.** It used to be a bare string
 * literal with nothing to check it against, while `worlds/src/titles.ts` held the closed union it
 * is checked against on arrival — the same vocabulary in two repositories, one of them unchecked.
 * A typo here was a registration worlds refuses, or worse, a capability claim that is accepted and
 * silently never delivered: a purchase taken for something this title cannot make. The contract's
 * union makes the typo a compile error at the end where it is actually made.
 */
export const TITLE_DESCRIPTOR: TitleDescriptor = Object.freeze({
  slug: TITLE_SLUG,
  name: 'Aetherholm',
  capabilities: Object.freeze<Capability[]>(['private_world']),
});

/**
 * Everything the routes need. Extends the kernel's `MountDeps` — which carries the logger, the
 * metrics and the per-network selector — so the same bag serves both `createRoutes` and
 * `mountRoutes` while the kernel's own type still cannot see anything below.
 */
export interface ServerDeps extends MountDeps {
  readonly lifecycle: Lifecycle;
  readonly verifier: PrincipalVerifier;
  readonly producer: string;
  readonly queue: Pick<JobQueue, 'enqueue'>;
  /**
   * The secrets `POST /v1/events` will accept, newest first — `env.acceptSecrets`.
   *
   * Required rather than optional with a default: an inbound webhook whose credential can be
   * omitted at the composition root is an inbound webhook that will one day be composed without
   * one, and the failure is silent until somebody posts an unsigned erasure.
   */
  readonly eventAcceptSecrets: readonly string[];
  readonly beforeScrape?: () => Promise<void>;
}

/**
 * The topics this title subscribes to.
 *
 * Rule 6 of docs/ecosystem/03 §2: every service that stores a `user_id` subscribes to
 * `identity.user.deleted` and erases. This one stores it in nine places — see src/erasure.ts for
 * what happens to each and why.
 *
 * **IT IS EXPORTED NOW**, because in the merged process the webhook is emberkin's and it has to be
 * able to ask this module whether a topic is one of these. `identity.user.deleted` is on BOTH
 * titles' lists, and one endpoint routing it to one module is a deletion that answers 202 and
 * leaves every city that person founded standing — see `aetherholm/module.ts`'s `inbound`.
 */
export const SUBSCRIBED_TOPICS: ReadonlySet<string> = new Set([USER_DELETED_TOPIC]);

const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/**
 * Wrap one handler so a thrown failure becomes the reply it deserves.
 *
 * This is the former `handle`: it used to sit between the listener and the dispatch, and it
 * wrapped ROUTING as well as the route. Now that a spec is one closure, the wrap is per handler —
 * and per MODULE, which is the point. `PlotTakenError`, `AegisError` and the ten others below are
 * this title's vocabulary; emberkin's copy of this function has never heard of them, and a shared
 * mapper would answer 500 for what is a 409.
 */
function guarded(
  handle: (ctx: RequestContext<Db>) => Promise<Reply>,
): (ctx: RequestContext<Db>) => Promise<Reply> {
  return async (ctx) => {
  try {
    return await handle(ctx);
  } catch (err) {
    const authStatus = statusFor(err);
    if (authStatus === 401) {
      ctx.log.info('unauthenticated request', { err });
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId);
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown';
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId);
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err });
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId);
    }
    if (err instanceof UnsupportedSkuError) {
      // 422 with code 'unsupported' — the ANSWER worlds' bridge records as terminal
      // (worlds/src/titleclient.ts, worlds/src/conformance.ts check 7). Both halves of that
      // agreement are now the contract's constants rather than a literal at each end.
      return errorReply(UNSUPPORTED_STATUS, UNSUPPORTED_CODE, err.message, ctx.requestId);
    }
    if (err instanceof NotFoundError) return errorReply(404, 'not_found', err.message, ctx.requestId);
    if (err instanceof NotOwnerError) return errorReply(403, 'not_owner', err.message, ctx.requestId);
    if (err instanceof PlotTakenError) return errorReply(409, 'plot_taken', err.message, ctx.requestId);
    if (err instanceof QueueFullError) return errorReply(409, 'queue_full', err.message, ctx.requestId);
    if (err instanceof IdempotencyConflictError) {
      return errorReply(409, 'idempotency_conflict', err.message, ctx.requestId);
    }
    if (err instanceof InsufficientStockError) {
      return errorReply(409, 'insufficient_stock', err.message, ctx.requestId);
    }
    if (err instanceof InsufficientShipsError) {
      return errorReply(409, 'insufficient_ships', err.message, ctx.requestId);
    }
    if (err instanceof AegisError) return errorReply(409, 'aegis', err.message, ctx.requestId);
    if (err instanceof SeasonSealedError) {
      return errorReply(409, 'season_sealed', err.message, ctx.requestId);
    }
    if (err instanceof NoRouteError) return errorReply(409, 'no_route', err.message, ctx.requestId);
    if (err instanceof AlreadyAlignedError) {
      return errorReply(409, 'already_aligned', err.message, ctx.requestId);
    }
    if (err instanceof ClaimTakenError) return errorReply(409, 'claim_taken', err.message, ctx.requestId);
    if (err instanceof NotMemberError) return errorReply(403, 'not_member', err.message, ctx.requestId);
    if (err instanceof BadRequestError || err instanceof ValidationError || err instanceof RangeError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId);
    }
    ctx.log.error('unhandled request failure', { err });
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId);
    }
  };
}

export function createRoutes(deps: ServerDeps): RouteSpec<Db>[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext<Db>) => Promise<Reply>,
  ): RouteSpec<Db> => ({ method, path, handle: guarded(handler) });

  return [
    define('GET', '/livez', async () => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async () => {
      const report = await deps.lifecycle.readyz();
      return { status: report.ready ? 200 : 503, body: report };
    }),

    define('GET', '/metrics', async (ctx) => {
      try {
        await deps.beforeScrape?.();
      } catch (err) {
        ctx.log.warn('gauge refresh failed; serving the previous values', { err });
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      };
    }),

    /* --------------------------------------------------------------- the title contract */

    // Both paths come from the contract, so this service cannot serve a route worlds does not
    // call. That is the exact failure the achievement bridge suffered in the other direction: two
    // title clients POSTed `/internal/achievements` for months and worlds never served it.
    define('GET', TITLE_DESCRIPTOR_PATH, async () => ({
      status: 200,
      body: serialiseTitleDescriptor(TITLE_DESCRIPTOR),
    })),

    define('POST', PROVISION_PATH, async (ctx) => {
      const principal = await authenticate(ctx, deps);
      if (principal.kind !== 'service') {
        // Provisioning is the platform's act, driven by a paid entitlement. A user token here is
        // someone trying to raise a world without buying one.
        throw new ForbiddenError(AETHERHOLM_PROVISION_SCOPE);
      }
      requireScope(principal, AETHERHOLM_PROVISION_SCOPE);

      // Parsed by the CONTRACT's parser, not by six hand-written `requireString` calls. The
      // correlation id is passed in rather than read from the body because it travels as the
      // request id header and is deliberately not a wire field — a receiver that made it a required
      // body field would 400 every real request from the bridge and pass every test written from
      // the interface. That asymmetry is exactly what a types-only package cannot express.
      const parsed = parseProvisionRequest(await readJson(ctx.req), ctx.requestId);
      if (!parsed.ok) throw new BadRequestError(parsed.errors.join('; '));

      const done = deps.lifecycle.track();
      try {
        const outcome = await provisionSkerry(ctx.sql, deps.producer, parsed.value);
        deps.metrics.increment('aetherholm_provisions_total', {
          outcome: outcome.replayed ? 'replayed' : 'provisioned',
        });
        ctx.log.info('provisioned', {
          entitlementId: parsed.value.entitlementId,
          urn: outcome.urn,
          replayed: outcome.replayed,
        });
        return {
          status: outcome.replayed ? 200 : 201,
          body: serialiseProvisionResult(outcome),
        };
      } finally {
        done();
      }
    }),

    /* --------------------------------------------------------------- the world, read */

    define('GET', '/v1/seasons/current', async (ctx) => {
      const principal = await authenticate(ctx, deps);
      if (principal.kind === 'service') requireScope(principal, AETHERHOLM_READ_SCOPE);
      const season = await openSeason(ctx.sql);
      if (!season) return errorReply(404, 'no_open_season', 'no season is open yet', ctx.requestId);
      return {
        status: 200,
        body: {
          id: season.id,
          name: season.name,
          seed: season.seed.toString(),
          status: season.status,
          openedAt: season.openedAt.toISOString(),
          endsAt: season.endsAt.toISOString(),
          archipelagoId: season.archipelagoId,
        },
      };
    }),

    // The user-token sibling of POST /v1/provision: the write mints a world, this names the ones
    // you own. Without it a buyer held a row nothing could address — every other archipelago route
    // takes an :id in its path, and the only id any client was ever handed came from
    // /v1/seasons/current, which is the PUBLIC world (micro-org#332, measured 2026-08-10).
    //
    // Declared above /v1/archipelagos/:id/islands only for reading order; the router is
    // first-match-wins over whole segments, so `/v1/archipelagos` cannot shadow a two-segment path.
    define('GET', '/v1/archipelagos', async (ctx) => {
      // The owner pattern of GET /v1/cities and GET /v1/battles, verbatim.
      const principal = await authenticate(ctx, deps);
      const requested = ctx.url.searchParams.get('userId') ?? undefined;
      let ownerId: string;
      if (principal.kind === 'user') {
        if (requested && requested !== principal.userId && !isAdmin(principal)) {
          throw new ForbiddenError('role:admin');
        }
        ownerId = requested ?? principal.userId;
      } else {
        requireScope(principal, AETHERHOLM_READ_SCOPE);
        if (!requested) throw new BadRequestError('a service must name a userId');
        ownerId = requested;
      }
      const archipelagos = await listArchipelagosOwnedBy(ctx.sql, ownerId);
      return {
        status: 200,
        body: {
          archipelagos: archipelagos.map((a) => ({
            id: a.id,
            kind: a.kind,
            name: a.name,
            urn: a.urn,
            createdAt: a.createdAt.toISOString(),
          })),
        },
      };
    }),

    define('GET', '/v1/archipelagos/:id/islands', async (ctx) => {
      const principal = await authenticate(ctx, deps);
      if (principal.kind === 'service') requireScope(principal, AETHERHOLM_READ_SCOPE);
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('archipelago id must be a uuid');
      // The public season world passes; a skerry admits its owner, its guests, an admin and a
      // service (src/visibility.ts). A refusal is the SAME 404 as an id that names nothing —
      // micro-org#341: a 403 here would confirm that a stranger's uuid is a real private world.
      if (!(await archipelagoVisibleTo(ctx.sql, id, principal))) {
        return errorReply(404, 'not_found', 'no such archipelago, or it has no islands', ctx.requestId);
      }
      const islands = await listIslands(ctx.sql, id);
      if (islands.length === 0) {
        return errorReply(404, 'not_found', 'no such archipelago, or it has no islands', ctx.requestId);
      }
      return { status: 200, body: { islands } };
    }),

    /* --------------------------------------------------------------- city play */

    define('POST', '/v1/cities', async (ctx) => {
      const userId = await requireUser(ctx, deps);
      const body = await readJson(ctx.req);
      const islandId = requireString(body, 'islandId');
      const name = requireString(body, 'name');
      const plot = body['plot'];
      if (typeof plot !== 'number') throw new BadRequestError('plot must be a number from 1 to 12');
      if (!UUID.test(islandId)) throw new BadRequestError('islandId must be a uuid');

      const done = deps.lifecycle.track();
      try {
        const result = await foundCity(ctx.sql, deps.producer, {
          userId,
          islandId,
          plot,
          name,
          correlationId: ctx.requestId,
        });
        if (result.created) deps.metrics.increment('aetherholm_cities_founded_total');
        return { status: result.created ? 201 : 200, body: { city: result.city } };
      } finally {
        done();
      }
    }),

    define('GET', '/v1/cities', async (ctx) => {
      const principal = await authenticate(ctx, deps);
      const requested = ctx.url.searchParams.get('userId') ?? undefined;
      let ownerId: string;
      if (principal.kind === 'user') {
        // An admin may read anyone; a player reads only their own list.
        if (requested && requested !== principal.userId && !isAdmin(principal)) {
          throw new ForbiddenError('role:admin');
        }
        ownerId = requested ?? principal.userId;
      } else {
        requireScope(principal, AETHERHOLM_READ_SCOPE);
        if (!requested) throw new BadRequestError('a service must name a userId');
        ownerId = requested;
      }
      const cities = await listCitiesFor(ctx.sql, ownerId);
      return { status: 200, body: { cities } };
    }),

    define('GET', '/v1/cities/:id', async (ctx) => {
      const principal = await authenticate(ctx, deps);
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('city id must be a uuid');
      const city = await getCity(ctx.sql, id);
      if (!city) return errorReply(404, 'not_found', 'no such city', ctx.requestId);
      if (principal.kind === 'service') requireScope(principal, AETHERHOLM_READ_SCOPE);
      else if (city.userId !== principal.userId && !isAdmin(principal)) {
        // A city's stocks and queues are its owner's plan. 403 rather than 404: plots are public
        // on the island list anyway, so existence is not the secret — the economy is.
        throw new ForbiddenError('role:admin');
      }
      return { status: 200, body: { city } };
    }),

    define('POST', '/v1/cities/:id/buildings', async (ctx) => {
      return queueRoute(ctx, deps, 'building');
    }),

    define('POST', '/v1/cities/:id/research', async (ctx) => {
      return queueRoute(ctx, deps, 'research');
    }),

    define('POST', '/v1/cities/:id/ships', async (ctx) => {
      return queueRoute(ctx, deps, 'ship');
    }),

    /* --------------------------------------------------------------- the lattice */

    // Static content, like /v1/title: what the classes ARE is a capability statement, and the
    // client renders the shipyard from it. Bigints travel as decimal strings.
    // Building and research cost curves, public like the airship table and for the same reason:
    // the queue forms must show real numbers BEFORE commit, mirrored from the one source the
    // engine itself charges from. micro-aetherholm-web shipped those forms honestly blank and
    // reported the gap; this closes it without a second copy of any formula.
    define('GET', '/v1/content/buildings', async () => ({
      status: 200,
      body: {
        buildings: Object.fromEntries(
          BUILDING_TYPES.map((type) => [
            type,
            {
              // cost(level) = base × level; served as the base with the rule named, and the
              // level-1 values exact, so a client renders truth without restating arithmetic.
              baseCost: stocksWire(buildingCost(type, 1)),
              costRule: 'base × level',
              durationSecondsPerLevel: buildingDurationSeconds(type, 1),
            },
          ]),
        ),
      },
    })),

    define('GET', '/v1/content/research', async () => ({
      status: 200,
      body: {
        research: Object.fromEntries(
          RESEARCH_BRANCHES.flatMap((branch) =>
            RESEARCH_NODES[branch].map((node) => [
              node,
              {
                branch,
                cost: stocksWire(researchCost(node)),
                durationSeconds: researchDurationSeconds(node),
              },
            ]),
          ),
        ),
      },
    })),

    define('GET', '/v1/content/airships', async () => ({
      status: 200,
      body: {
        airships: Object.fromEntries(
          AIRSHIP_CLASSES.map((cls) => {
            const spec = AIRSHIPS[cls];
            return [
              cls,
              {
                role: spec.role,
                initiative: spec.initiative,
                attack: spec.attack.toString(),
                hull: spec.hull.toString(),
                speedBp: spec.speedBp,
                cargo: spec.cargo.toString(),
                liftPerHour: spec.liftPerHour.toString(),
                aerodock: spec.aerodock,
                cost: Object.fromEntries(
                  RESOURCES.map((resource) => [resource, spec.cost[resource].toString()]),
                ),
                buildSeconds: spec.buildSeconds,
              },
            ];
          }),
        ),
      },
    })),

    define('GET', '/v1/archipelagos/:id/lanes', async (ctx) => {
      const principal = await authenticate(ctx, deps);
      if (principal.kind === 'service') requireScope(principal, AETHERHOLM_READ_SCOPE);
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('archipelago id must be a uuid');
      // BEFORE ensureLattice, and the order is the whole point. This route WRITES on first touch,
      // so an unscoped read of a stranger's skerry did not merely observe a paid private world —
      // asking generated its winds (micro-org#341). The gate has to precede the side effect, and
      // `visibility.test.ts` asserts the lane count is unchanged after a refused read.
      if (!(await archipelagoVisibleTo(ctx.sql, id, principal))) {
        return errorReply(404, 'not_found', 'no such archipelago, or it has no lanes', ctx.requestId);
      }
      // ensureLattice, not listLanes: a phase-1 world grows its winds the first time anyone asks.
      const lanes = await ensureLattice(ctx.sql, id);
      if (lanes.length === 0) {
        return errorReply(404, 'not_found', 'no such archipelago, or it has no lanes', ctx.requestId);
      }
      return { status: 200, body: { lanes } };
    }),

    /* --------------------------------------------------------------- fleets */

    define('POST', '/v1/fleets', async (ctx) => {
      const userId = await requireUser(ctx, deps);
      const key = headerOf(ctx.req, 'idempotency-key');
      if (!key || key.length < 1 || key.length > 200) {
        throw new BadRequestError('an Idempotency-Key header is required to launch a fleet');
      }
      const body = await readJson(ctx.req);
      const cityId = requireString(body, 'cityId');
      const mission = requireString(body, 'mission');
      const targetIslandId = requireString(body, 'targetIslandId');
      if (!UUID.test(cityId)) throw new BadRequestError('cityId must be a uuid');
      if (!UUID.test(targetIslandId)) throw new BadRequestError('targetIslandId must be a uuid');
      if (mission !== 'transfer' && mission !== 'raid' && mission !== 'siege') {
        throw new BadRequestError('mission must be transfer, raid or siege');
      }
      const targetCityId =
        typeof body['targetCityId'] === 'string' && body['targetCityId'].length > 0
          ? body['targetCityId']
          : undefined;
      if (targetCityId !== undefined && !UUID.test(targetCityId)) {
        throw new BadRequestError('targetCityId must be a uuid');
      }
      const rawShips = body['ships'];
      if (typeof rawShips !== 'object' || rawShips === null || Array.isArray(rawShips)) {
        throw new BadRequestError('ships must be an object of class → count');
      }
      const ships: Record<string, number> = {};
      for (const [cls, count] of Object.entries(rawShips as Record<string, unknown>)) {
        if (typeof count !== 'number') throw new BadRequestError(`ships.${cls} must be a number`);
        ships[cls] = count;
      }
      const cargo: Partial<Record<Resource, bigint>> = {};
      const rawCargo = body['cargo'];
      if (rawCargo !== undefined) {
        if (typeof rawCargo !== 'object' || rawCargo === null || Array.isArray(rawCargo)) {
          throw new BadRequestError('cargo must be an object of resource → decimal string');
        }
        for (const resource of RESOURCES) {
          const value = (rawCargo as Record<string, unknown>)[resource];
          if (value === undefined) continue;
          if (typeof value !== 'string' || !/^\d+$/.test(value)) {
            throw new BadRequestError(`cargo.${resource} must be a decimal string — never a float`);
          }
          cargo[resource] = BigInt(value);
        }
      }

      const done = deps.lifecycle.track();
      try {
        const result = await launchFleet(ctx.sql, deps.producer, {
          cityId,
          userId,
          mission: mission as Mission,
          ships,
          cargo,
          targetIslandId,
          ...(targetCityId !== undefined ? { targetCityId } : {}),
          idempotencyKey: key,
          correlationId: ctx.requestId,
        });
        deps.metrics.increment('aetherholm_fleets_launched_total', {
          mission,
          replayed: String(result.replayed),
        });
        if (!result.replayed) {
          // The arrival, keyed on the fleet. 'earliest' can only pull the run forward.
          await deps.queue.enqueue({
            kind: FLEET_KIND,
            key: fleetKey(result.fleet.id),
            payload: { fleetId: result.fleet.id },
            runAt: result.fleet.arrivesAt,
            onConflict: 'earliest',
          });
        }
        return {
          status: result.replayed ? 200 : 201,
          body: { fleet: wireFleet(result.fleet), replayed: result.replayed, stocks: result.stocks },
        };
      } finally {
        done();
      }
    }),

    define('GET', '/v1/fleets', async (ctx) => {
      const principal = await authenticate(ctx, deps);
      const requested = ctx.url.searchParams.get('userId') ?? undefined;
      let ownerId: string;
      if (principal.kind === 'user') {
        if (requested && requested !== principal.userId && !isAdmin(principal)) {
          throw new ForbiddenError('role:admin');
        }
        ownerId = requested ?? principal.userId;
      } else {
        requireScope(principal, AETHERHOLM_READ_SCOPE);
        if (!requested) throw new BadRequestError('a service must name a userId');
        ownerId = requested;
      }
      const fleets = await listFleetsFor(ctx.sql, ownerId);
      return { status: 200, body: { fleets: fleets.map(wireFleet) } };
    }),

    define('GET', '/v1/fleets/:id', async (ctx) => {
      const principal = await authenticate(ctx, deps);
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('fleet id must be a uuid');
      const fleet = await getFleet(ctx.sql, id);
      if (!fleet) return errorReply(404, 'not_found', 'no such fleet', ctx.requestId);
      if (principal.kind === 'service') requireScope(principal, AETHERHOLM_READ_SCOPE);
      else if (fleet.userId !== principal.userId && !isAdmin(principal)) {
        // A fleet in the air is its owner's plan; even its existence stays theirs until the
        // battle report says otherwise.
        throw new ForbiddenError('role:admin');
      }
      return { status: 200, body: { fleet: wireFleet(fleet) } };
    }),

    define('GET', '/v1/battles', async (ctx) => {
      // The owner pattern of GET /v1/fleets, verbatim: a user sees their own history, an admin
      // anyone's, a service names a userId under the read scope.
      const principal = await authenticate(ctx, deps);
      const requested = ctx.url.searchParams.get('userId') ?? undefined;
      let ownerId: string;
      if (principal.kind === 'user') {
        if (requested && requested !== principal.userId && !isAdmin(principal)) {
          throw new ForbiddenError('role:admin');
        }
        ownerId = requested ?? principal.userId;
      } else {
        requireScope(principal, AETHERHOLM_READ_SCOPE);
        if (!requested) throw new BadRequestError('a service must name a userId');
        ownerId = requested;
      }
      const battles = await listBattlesFor(ctx.sql, ownerId, 50);
      return {
        status: 200,
        body: {
          battles: battles.map((b) => ({
            id: b.id,
            mission: b.mission,
            islandId: b.islandId,
            attackerUserId: b.attackerUserId,
            defenderUserId: b.defenderUserId,
            outcome: b.outcome,
            digest: b.digest,
            occurredAt: b.occurredAt.toISOString(),
          })),
        },
      };
    }),

    define('GET', '/v1/battles/:id', async (ctx) => {
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('battle id must be a uuid');
      const rows = await ctx.sql<
        {
          id: string;
          archipelago_id: string;
          island_id: string;
          plot: number | null;
          mission: string;
          wind_bp: number;
          attacker_user_id: string;
          defender_user_id: string;
          attacker_oob: unknown;
          defender_oob: unknown;
          result: unknown;
          digest: string;
          occurred_at: Date;
          season_status: string | null;
        }[]
      >`
        select b.id, b.archipelago_id, b.island_id, b.plot, b.mission, b.wind_bp,
               b.attacker_user_id, b.defender_user_id, b.attacker_oob, b.defender_oob,
               b.result, b.digest, b.occurred_at, s.status as season_status
          from battles b
          join archipelagos a on a.id = b.archipelago_id
          left join seasons s on s.id = a.season_id
         where b.id = ${id}
      `;
      const battle = rows[0];
      if (!battle) return errorReply(404, 'not_found', 'no such battle', ctx.requestId);
      // SEALED history is public — the chronicle rule. A LIVE battle is the participants' own.
      if (battle.season_status !== 'sealed') {
        const principal = await authenticate(ctx, deps);
        if (principal.kind === 'service') requireScope(principal, AETHERHOLM_READ_SCOPE);
        else if (
          principal.userId !== battle.attacker_user_id &&
          principal.userId !== battle.defender_user_id &&
          !isAdmin(principal)
        ) {
          throw new ForbiddenError('role:admin');
        }
      }
      return {
        status: 200,
        body: {
          battle: {
            id: battle.id,
            islandId: battle.island_id,
            plot: battle.plot,
            mission: battle.mission,
            windBp: battle.wind_bp,
            attackerUserId: battle.attacker_user_id,
            defenderUserId: battle.defender_user_id,
            attackerOob: battle.attacker_oob,
            defenderOob: battle.defender_oob,
            result: battle.result,
            digest: battle.digest,
            occurredAt: battle.occurred_at.toISOString(),
          },
        },
      };
    }),

    /* --------------------------------------------------------------- alliances */

    define('POST', '/v1/alliances', async (ctx) => {
      const userId = await requireUser(ctx, deps);
      const body = await readJson(ctx.req);
      const archipelagoId = requireString(body, 'archipelagoId');
      // Required, never minted: an alliance IS a micro-community community. This service does
      // not create one and will not paper over its absence (20-aetherholm.md §6).
      const communityId = requireString(body, 'communityId');
      const name = requireString(body, 'name');
      if (!UUID.test(archipelagoId)) throw new BadRequestError('archipelagoId must be a uuid');
      if (!UUID.test(communityId)) {
        throw new BadRequestError('communityId must be the uuid of an existing micro-community community');
      }
      const done = deps.lifecycle.track();
      try {
        const alliance = await foundAlliance(ctx.sql, deps.producer, {
          archipelagoId,
          communityId,
          name,
          userId,
          correlationId: ctx.requestId,
        });
        return { status: 201, body: { alliance } };
      } finally {
        done();
      }
    }),

    define('GET', '/v1/alliances', async (ctx) => {
      const principal = await authenticate(ctx, deps);
      if (principal.kind === 'service') requireScope(principal, AETHERHOLM_READ_SCOPE);
      const season = await ensureOpenSeason(ctx.sql, deps.producer, new Date());
      const viewer = principal.kind === 'user' ? principal.userId : null;
      const alliances = await listAlliances(ctx.sql, season.archipelagoId, viewer);
      return { status: 200, body: { alliances } };
    }),

    define('GET', '/v1/alliances/:id', async (ctx) => {
      const principal = await authenticate(ctx, deps);
      if (principal.kind === 'service') requireScope(principal, AETHERHOLM_READ_SCOPE);
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('alliance id must be a uuid');
      const alliance = await getAlliance(ctx.sql, id);
      if (!alliance) return errorReply(404, 'not_found', 'no such alliance', ctx.requestId);
      return { status: 200, body: { alliance } };
    }),

    define('POST', '/v1/alliances/:id/members', async (ctx) => {
      const userId = await requireUser(ctx, deps);
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('alliance id must be a uuid');
      const done = deps.lifecycle.track();
      try {
        await joinAlliance(ctx.sql, deps.producer, id, userId);
        return { status: 200, body: { joined: true } };
      } finally {
        done();
      }
    }),

    define('DELETE', '/v1/alliances/:id/members', async (ctx) => {
      const userId = await requireUser(ctx, deps);
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('alliance id must be a uuid');
      const done = deps.lifecycle.track();
      try {
        await leaveAlliance(ctx.sql, deps.producer, id, userId);
        return { status: 200, body: { left: true } };
      } finally {
        done();
      }
    }),

    define('POST', '/v1/alliances/:id/claims', async (ctx) => {
      const userId = await requireUser(ctx, deps);
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('alliance id must be a uuid');
      const body = await readJson(ctx.req);
      const islandId = requireString(body, 'islandId');
      if (!UUID.test(islandId)) throw new BadRequestError('islandId must be a uuid');
      const done = deps.lifecycle.track();
      try {
        await claimIsland(ctx.sql, deps.producer, id, islandId, userId);
        return { status: 201, body: { claimed: true } };
      } finally {
        done();
      }
    }),

    /* --------------------------------------------------------------- the chronicle */

    // Anonymous by design, and ONLY here: sealed seasons are public history (doc §10.1), while
    // everything above requires a bearer. The queries themselves are scoped `status = 'sealed'`,
    // so a live season cannot leak through this surface even by id.

    define('GET', '/v1/chronicle/seasons', async (ctx) => {
      const seasons = await listChronicles(ctx.sql);
      return {
        status: 200,
        body: {
          seasons: seasons.map((season) => ({
            seasonId: season.seasonId,
            name: season.name,
            seed: season.seed,
            sealedAt: season.sealedAt.toISOString(),
            digest: season.digest,
          })),
        },
      };
    }),

    define('GET', '/v1/chronicle/seasons/:id', async (ctx) => {
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('season id must be a uuid');
      const chronicle = await getChronicle(ctx.sql, id);
      if (!chronicle) {
        return errorReply(404, 'not_found', 'no sealed season with that id', ctx.requestId);
      }
      return {
        status: 200,
        body: {
          summary: chronicle.summary,
          digest: chronicle.digest,
          sealedAt: chronicle.sealedAt.toISOString(),
        },
      };
    }),

    define('GET', '/v1/chronicle/seasons/:id/battles', async (ctx) => {
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('season id must be a uuid');
      const battles = await listSealedBattles(ctx.sql, id);
      if (!battles) {
        return errorReply(404, 'not_found', 'no sealed season with that id', ctx.requestId);
      }
      return { status: 200, body: { battles } };
    }),

    /**
     * The inbound event webhook — `http://aetherholm:4120/v1/events`.
     *
     * The signature is checked over the RAW BYTES before anything is parsed, with the contract's
     * timing-safe verifier: a byte-at-a-time comparison of a MAC is a byte-at-a-time forgery
     * oracle, and parsing first means an unauthenticated caller reaches the JSON parser.
     *
     * A topic this service does not subscribe to is acknowledged and IGNORED, never 4xx'd — a 4xx
     * makes the producer's relay retry the same event for ever.
     */
    define('POST', '/v1/events', async (ctx) => {
      const raw = await readRaw(ctx.req);
      const presented = headerOf(ctx.req, SIGNATURE_HEADER);
      if (!presented || !verifyEventSignature(raw, deps.eventAcceptSecrets, presented)) {
        // 403 and not 401: this is not a bearer-token surface, and a 401 would invite the caller
        // to go and find a token. The MAC is the credential, and it was wrong.
        return errorReply(403, 'bad_signature', 'the event signature did not verify', ctx.requestId);
      }
      let envelope: { id?: unknown; topic?: unknown; payload?: Record<string, unknown> };
      try {
        envelope = JSON.parse(raw) as typeof envelope;
      } catch {
        throw new BadRequestError('the event body is not valid JSON');
      }
      const topic = typeof envelope.topic === 'string' ? envelope.topic : '';
      const eventId = typeof envelope.id === 'string' ? envelope.id : '';
      if (!UUID.test(eventId)) throw new BadRequestError('the event id must be a uuid');
      if (!SUBSCRIBED_TOPICS.has(topic)) return { status: 202, body: { status: 'ignored' } };

      const outcome = await withInbox(ctx.sql, topic, eventId, async (tx) => {
        const userId = envelope.payload?.['userId'];
        if (typeof userId !== 'string' || !UUID.test(userId)) {
          throw new BadRequestError(`${USER_DELETED_TOPIC} requires a uuid userId`);
        }
        return eraseUser(tx, userId);
      });
      // Counts only. The erased id is never logged — writing it into the log would recreate, in
      // the one store nothing erases, exactly what the request was to remove.
      ctx.log.info('inbound event', {
        topic,
        eventId,
        outcome: outcome.status,
        ...(outcome.status === 'processed' ? outcome.value : {}),
      });
      return {
        status: 202,
        body: { status: outcome.status === 'duplicate' ? 'duplicate' : 'recorded' },
      };
    }),
  ];
}
/** Dates to ISO strings for the wire; everything countable is already a decimal string. */
function wireFleet(fleet: import('./fleets.ts').FleetView): Record<string, unknown> {
  return {
    id: fleet.id,
    originCityId: fleet.originCityId,
    userId: fleet.userId,
    mission: fleet.mission,
    status: fleet.status,
    targetIslandId: fleet.targetIslandId,
    targetCityId: fleet.targetCityId,
    ships: fleet.ships,
    cargo: fleet.cargo,
    aetherLift: fleet.aetherLift,
    departedAt: fleet.departedAt.toISOString(),
    arrivesAt: fleet.arrivesAt.toISOString(),
    returnsAt: fleet.returnsAt ? fleet.returnsAt.toISOString() : null,
    travelSeconds: fleet.travelSeconds,
  };
}

/** The shared queue-submission handler: building, research and ship differ only in target set. */
async function queueRoute(
  ctx: RequestContext<Db>,
  deps: ServerDeps,
  kind: 'building' | 'research' | 'ship',
): Promise<Reply> {
  const userId = await requireUser(ctx, deps);
  const cityId = ctx.params['id'] ?? '';
  if (!UUID.test(cityId)) throw new BadRequestError('city id must be a uuid');

  const key = headerOf(ctx.req, 'idempotency-key');
  if (!key || key.length < 1 || key.length > 200) {
    throw new BadRequestError(`an Idempotency-Key header is required to queue a ${kind}`);
  }
  const body = await readJson(ctx.req);
  const target = requireString(body, kind === 'building' ? 'type' : kind === 'ship' ? 'class' : 'node');

  const done = deps.lifecycle.track();
  try {
    const result = await queueWork(ctx.sql, deps.producer, {
      cityId,
      userId,
      kind,
      target,
      idempotencyKey: key,
      correlationId: ctx.requestId,
    });
    deps.metrics.increment('aetherholm_queue_submissions_total', {
      kind,
      replayed: String(result.replayed),
    });
    if (!result.replayed) {
      // The completion job, keyed on the city. 'earliest' can only pull the run forward.
      await deps.queue.enqueue({
        kind: CITY_QUEUE_KIND,
        key: cityQueueKey(cityId),
        payload: { cityId },
        runAt: result.item.completesAt,
        onConflict: 'earliest',
      });
    }
    return {
      status: 200,
      body: {
        item: {
          id: result.item.id,
          kind: result.item.kind,
          target: result.item.target,
          startedAt: result.item.startedAt.toISOString(),
          completesAt: result.item.completesAt.toISOString(),
        },
        replayed: result.replayed,
        stocks: result.stocks,
      },
    };
  } finally {
    done();
  }
}

/* --------------------------------------------------------------- auth + parsing helpers */

async function authenticate(ctx: RequestContext<Db>, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'));
  if (!token) throw new TokenError('no bearer token presented', 'missing');
  return deps.verifier.principal(token);
}

/** A user acting on their own cities. A service must carry aetherholm:write and name a user. */
async function requireUser(ctx: RequestContext<Db>, deps: ServerDeps): Promise<string> {
  const principal = await authenticate(ctx, deps);
  if (principal.kind === 'user') return principal.userId;
  requireScope(principal, AETHERHOLM_WRITE_SCOPE);
  const onBehalf = headerOf(ctx.req, 'x-user-id');
  if (!onBehalf || !UUID.test(onBehalf)) {
    throw new ForbiddenError('x-user-id (a service must name a user)');
  }
  return onBehalf;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${field} is required`);
  }
  return value.trim();
}

/**
 * The body as the bytes that arrived.
 *
 * Separate from `readJson` because the event webhook must verify a MAC over exactly what was sent
 * before it parses: re-serialising a parsed object changes key order and whitespace, and the
 * signature is over the sender's bytes, not over a shape that happens to mean the same thing.
 */
async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    // Capped before buffering rather than after: an unbounded body is a memory-exhaustion
    // primitive, and on this route an unauthenticated caller can reach it.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError('request body is not valid JSON');
  }
}
