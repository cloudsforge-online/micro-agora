/**
 * The HTTP surface: emberkin's routes, each handler closed over emberkin's dependency bag.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * `POST /v1/events` is SIGNATURE-CHECKED BEFORE IT IS PARSED. An event webhook with no MAC lets
 * anyone who can reach the port assert a customer bought a season pass and get the reward paid, so
 * the body is verified against `OUTBOX_ACCEPT_SECRETS` over the exact bytes received, with a
 * timing-safe comparison, before `JSON.parse`. The handler then dedupes on the source event id via
 * `withInbox` and enqueues a leased reward job — it never posts to the ledger inline, so a ledger
 * outage cannot make the producer's relay redeliver.
 *
 * The SCHEME is `@cloudsforge/contracts-events`', not this repository's. It used to be a local
 * `sha256=<hmac>` under a locally-spelled header, which no producer in the estate sends, so every
 * inbound delivery answered 403 and every event this service emitted was refused by its consumers.
 * `outbox.ts` holds the measurement and the reason there is still a second, legacy arm.
 *
 * It serves TWO topics on that one route, `SUBSCRIBED_TOPICS`: `billing.entitlement.granted` and
 * `identity.user.deleted` (rule 6 of 03 §2 — see `erasure.ts` for what erasure means per table).
 * Anything else is 202'd and ignored, because a 4xx makes the producer's relay retry for ever.
 *
 * The fail-open / fail-closed split on cosmetics:
 *   `GET /v1/saves/me`            fails OPEN — it runs on every app load and reads only our own data.
 *   `PUT /v1/saves/me/cosmetics`  fails CLOSED with a 503 on a billing outage — "ask again later",
 *                                 never "wear it anyway".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY HANDLER CLOSES OVER `deps`; NONE TAKES IT AS A PARAMETER.** `createRoutes` is called once
 * with this module's dependency bag and returns specs the kernel can mount without ever seeing the
 * verifier, the queues or the game data. That is what lets aetherholm's routes be mounted beside
 * these in one process with a bag of its own — see `kernel.ts` and `aetherholm/module.ts`.
 *
 * It is also what removed `forRequest`. The per-network job queue used to be swapped into a copy
 * of `deps` on the way in, SYNCHRONOUSLY, in the request listener — and `queueFor` throws for a
 * network this deployment does not hold, so that throw was an uncaught exception in a listener and
 * node exits on those. It is now `deps.queueFor(ctx.network)` at the two places that enqueue,
 * inside the handler, where a throw is a rejected promise the kernel already catches.
 * `ownnetwork.test.ts` asserts both halves of that.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { IncomingMessage } from 'node:http';
import { ForbiddenError, TokenError, bearerFrom, requireScope, statusFor, type Principal } from '@cloudsforge/auth';
import type { Lifecycle } from '@cloudsforge/lifecycle';
import type { Network } from '@cloudsforge/http';
import type { JobQueue } from '@cloudsforge/jobs';
import {
  LEGACY_SIGNATURE_HEADER,
  SIGNATURE_HEADER,
  verifyInbound,
  withInbox,
  type Db,
} from './outbox.ts';
import type { GameData } from './content/gamedata.ts';
import type { EntitlementReader } from './billingclient.ts';
import { NotFoundError, ValidationError, findSave, startGame } from './savegame.ts';
import { eraseUser } from './erasure.ts';
import { resolveBattle } from './battles.ts';
import { CosmeticNotOwnedError, equipCosmetic } from './cosmetics.ts';
import { withOutbox } from './outbox.ts';
import { ACH_SWEEP_KIND, SEASON_REWARD_KIND } from './jobs.ts';
import type { KinSpec, ScriptAction } from './engine/replay.ts';
import {
  errorReply,
  headerOf,
  type MountDeps,
  type Reply,
  type RequestContext,
  type RouteSpec,
} from '../kernel.ts';
import { eraseEveryPlane } from '../erasureplanes.ts';

export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>;
}

export const EMBERKIN_WRITE_SCOPE = 'emberkin:write';

/** Billing SKUs whose grant pays a season welcome reward. */
const SEASON_PASS_SKUS = new Set(['emberkin_season_pass', 'season_pass']);
const GRANTED_TOPIC = 'billing.entitlement.granted';
/** Rule 6 of docs/ecosystem/03 §2 — a service storing a `user_id` subscribes to this. See erasure.ts. */
const DELETED_TOPIC = 'identity.user.deleted';
/**
 * The topics THIS MODULE acts on. Anything else is ACKNOWLEDGED and ignored — never 4xx'd, because
 * a 4xx makes the producer's relay retry the same event for ever.
 *
 * The route's ignore decision is taken against the UNION of this and every mounted module's set;
 * see `InboundSink` and the handler below.
 */
export const SUBSCRIBED_TOPICS: ReadonlySet<string> = new Set([GRANTED_TOPIC, DELETED_TOPIC]);

/**
 * The fan-out contract, now shared with the host.
 *
 * These two types were defined here and are defined in `../inboundsink.ts` since 2026-09-02,
 * because `agora/src/server.ts` fans out to `studio`, `foresight` and `wallet` on the same
 * argument this file made for the titles (micro-org#534). Re-exported rather than moved-and-fixed
 * everywhere, so every existing importer of `./routes.ts` keeps working and there is exactly one
 * definition.
 */
import type { InboundOutcome, InboundSink } from '../inboundsink.ts';
export type { InboundOutcome, InboundSink };

/**
 * Everything the routes need. Extends the kernel's `MountDeps` — which carries the logger, the
 * metrics and the per-network selector — so the same bag serves both `createRoutes` and
 * `mountRoutes` while the kernel's own type still cannot see anything below.
 */
export interface ServerDeps extends MountDeps {
  readonly lifecycle: Lifecycle;
  readonly verifier: PrincipalVerifier;
  readonly producer: string;
  readonly data: GameData;
  readonly billing: EntitlementReader;
  /**
   * The per-network queues, selected inside the handler that enqueues.
   *
   * A testnet request that enqueued into the mainnet queue would be picked up by a handler reading
   * mainnet rows: a cross-network write that succeeds, with a job row to prove it was deliberate.
   */
  readonly queueFor: (network: Network) => Pick<JobQueue, 'enqueue'>;
  /**
   * Every key an inbound delivery may have been signed with, newest first — `OUTBOX_ACCEPT_SECRETS`,
   * defaulting to `[OUTBOX_SIGNING_SECRET]`. A LIST rather than a value because the estate's outbox
   * key is one secret shared by 24 services and swapping it partitions delivery; see `verifyInbound`.
   */
  readonly eventAcceptSecrets: readonly string[];
  /**
   * The modules mounted beside this one that also consume the event bus. Empty for the standalone
   * listener, two entries (aetherholm, nda) in the merged process. See `InboundSink`.
   */
  readonly inbound?: readonly InboundSink[];
  readonly beforeScrape?: () => Promise<void>;
}

const MAX_BODY_BYTES = 256 * 1024;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SEED_RE = /^\d{1,20}$/;

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/**
 * Wrap one handler so a thrown failure becomes the reply it deserves.
 *
 * This is the former `handle`: it used to sit between the kernel and the dispatch, and it wrapped
 * ROUTING as well as the route. Now that a spec is one closure, the wrap is per handler — and it
 * is per MODULE, which is the point. aetherholm's twelve domain errors and nda's fifteen map
 * through their own copies of this and never through emberkin's.
 */
function guarded(
  handle: (ctx: RequestContext<Db>) => Promise<Reply>,
  deps: ServerDeps,
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
      if (err instanceof CosmeticNotOwnedError) {
        deps.metrics.increment('emberkin_cosmetic_refusals_total');
        return errorReply(403, 'cosmetic_not_owned', err.message, ctx.requestId);
      }
      if (err instanceof NotFoundError) return errorReply(404, 'not_found', err.message, ctx.requestId);
      if (err instanceof BadRequestError || err instanceof ValidationError || err instanceof RangeError) {
        return errorReply(400, 'bad_request', err.message, ctx.requestId);
      }
      if (err instanceof Error && err.name === 'LedgerUnavailableError') {
        return errorReply(503, 'ledger_unavailable', 'the reward could not be paid; retry', ctx.requestId);
      }
      if (err instanceof Error && err.name === 'BillingUnavailableError') {
        // FAIL CLOSED. "Ask again later", not "wear it anyway".
        return errorReply(503, 'entitlements_unavailable', 'we cannot check your purchases right now — try again shortly', ctx.requestId);
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
  ): RouteSpec<Db> => ({ method, path, handle: guarded(handler, deps) });

  const sinks = deps.inbound ?? [];

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
      return { status: 200, text: deps.metrics.render(), contentType: 'text/plain; version=0.0.4; charset=utf-8' };
    }),

    /* --------------------------------------------------------------- the inbound webhook */

    define('POST', '/v1/events', async (ctx) => {
      const raw = await readRaw(ctx.req);
      // Verified over the RAW BYTES, before `JSON.parse` — parsing first would let an
      // unauthenticated caller reach the parser. Two header names because this service's two
      // producers are on two schemes: identity signs the contract's `cf-signature`, billing still
      // sends the legacy `x-cloudsforge-signature`. `verifyInbound` carries the whole argument.
      //
      // ONE verification for the whole process. EVERY module reads the same estate-wide
      // `OUTBOX_SIGNING_SECRET` / `OUTBOX_ACCEPT_SECRETS`, from one file, so a delivery that
      // verifies for one verifies for the other — which is what makes a single webhook honest
      // rather than a shortcut. If that ever stops being true this route must verify per sink.
      const scheme = verifyInbound(raw.toString('utf8'), deps.eventAcceptSecrets, {
        contract: headerOf(ctx.req, SIGNATURE_HEADER) ?? '',
        legacy: headerOf(ctx.req, LEGACY_SIGNATURE_HEADER) ?? '',
      });
      if (scheme === null) {
        deps.metrics.increment('emberkin_events_rejected_total', { reason: 'bad_signature' });
        ctx.log.warn('an inbound event failed its signature check');
        // NOT 401. This is not a bearer-token surface, and a 401 invites the caller to go and find
        // a token — there isn't one to find. The MAC is the credential.
        return errorReply(403, 'bad_signature', 'the event signature did not verify', ctx.requestId);
      }
      // Reported so the legacy arm is deleted on evidence rather than on a belief: when this stops
      // reading `legacy`, `micro-billing`'s relay has moved and the arm can go.
      deps.metrics.increment('emberkin_events_accepted_total', { scheme });

      let envelope: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new BadRequestError('an event envelope must be a JSON object');
        }
        envelope = parsed as Record<string, unknown>;
      } catch {
        deps.metrics.increment('emberkin_events_rejected_total', { reason: 'malformed' });
        throw new BadRequestError('the event body is not valid JSON');
      }

      const topic = typeof envelope['topic'] === 'string' ? envelope['topic'] : '';
      const eventId = typeof envelope['id'] === 'string' ? envelope['id'] : '';
      if (!UUID.test(eventId)) {
        deps.metrics.increment('emberkin_events_rejected_total', { reason: 'malformed' });
        throw new BadRequestError('an event envelope must carry a uuid id');
      }

      // THE IGNORE DECISION IS TAKEN AGAINST THE UNION, never against this module's set alone.
      // A topic only aetherholm consumes would otherwise be 202'd as "ignored" here and never
      // reach it — the producer would record a successful delivery of an event nothing processed.
      const interested = sinks.filter((sink) => sink.topics.has(topic));
      const mine = SUBSCRIBED_TOPICS.has(topic);
      if (!mine && interested.length === 0) {
        deps.metrics.increment('emberkin_events_rejected_total', { reason: 'not_subscribed' });
        return { status: 202, body: { status: 'ignored', topic } };
      }

      const payload =
        typeof envelope['payload'] === 'object' && envelope['payload'] !== null
          ? (envelope['payload'] as Record<string, unknown>)
          : {};

      const done = deps.lifecycle.track();
      try {
        // ── THE MOUNTED MODULES FIRST, THEN THIS ONE ──────────────────────────────────────────
        //
        // Order matters only for the refusal: a sink that REJECTS the payload (a `userId` that is
        // not a uuid on an erasure) must stop this module from writing its own inbox row and
        // answering 202, because a redelivery is the only thing that will ever make the other half
        // happen. Running the sinks first makes that a plain early return rather than a
        // compensation.
        const fanout: Record<string, string> = {};
        for (const sink of interested) {
          const outcome = await sink.deliver(ctx.network, topic, eventId, payload);
          if (outcome.status === 'rejected') {
            deps.metrics.increment('emberkin_events_rejected_total', { reason: 'malformed' });
            throw new BadRequestError(`${sink.module}: ${outcome.reason}`);
          }
          fanout[sink.module] = outcome.status;
          if (outcome.status === 'processed' && outcome.detail) {
            // Counts, never an id — on this topic the id is the thing we were asked to forget.
            ctx.log.info('a mounted module handled an inbound event', {
              module: sink.module,
              topic,
              eventId,
              ...outcome.detail,
            });
          }
        }
        // A field that is ABSENT for the standalone listener and present in the merged process, so
        // nothing about this module's own reply shape changed when aetherholm was mounted beside it.
        const withFanout = <T extends Record<string, unknown>>(body: T): T | (T & { fanout: typeof fanout }) =>
          interested.length > 0 ? { ...body, fanout } : body;

        if (!mine) return { status: 202, body: withFanout({ status: 'accepted' }) };

        if (topic === DELETED_TOPIC) {
          // A BARE uuid, taken as it stands: every `user_id` column in this schema is a uuid, so
          // there is no `user:` prefix to strip here. That conversion belongs to billing's
          // `subject` below and the two must not be confused — stripping a prefix that is not there
          // would erase nobody and answer 202.
          const erasedUserId = typeof payload['userId'] === 'string' ? payload['userId'] : '';
          if (!UUID.test(erasedUserId)) {
            deps.metrics.increment('emberkin_events_rejected_total', { reason: 'malformed' });
            // 400 rather than a quiet 202: a deletion we cannot perform must not be acknowledged as
            // performed. That silence is the defect this handler exists to fix.
            throw new BadRequestError('identity.user.deleted requires a uuid userId');
          }
          // EVERY plane, from the SELECTOR — not `ctx.sql`, which is ONE handle and, for a
          // delivery that carries no `CF-Network`, always mainnet's. The entitlement branch below
          // deliberately keeps `ctx.sql`: an entitlement belongs to the estate it was bought in,
          // while a person does not belong to an estate at all. See `../erasureplanes.ts`.
          const sweep = await eraseEveryPlane(deps.sql, (handle: Db) =>
            withInbox(handle, topic, eventId, (tx) => eraseUser(tx, erasedUserId)),
          );
          if (sweep.processed === 0) return { status: 202, body: withFanout({ status: 'duplicate' }) };
          for (const plane of sweep.planes) {
            if (plane.value && plane.value.battlesNotCascaded > 0) {
              ctx.log.error('battles did not cascade from saves — the foreign key has changed', {
                eventId,
                network: plane.network,
                battles: plane.value.battlesNotCascaded,
              });
            }
            // Counts, never the id: it is the thing we were just asked to forget.
            if (plane.value) {
              ctx.log.info('erased a user on identity.user.deleted', {
                eventId,
                network: plane.network,
                ...plane.value,
              });
            }
          }
          return { status: 202, body: withFanout({ status: 'accepted', erased: true }) };
        }

        const sku = typeof payload['sku'] === 'string' ? payload['sku'] : '';
        const subject = typeof payload['subject'] === 'string' ? payload['subject'] : '';
        const entitlementId = typeof payload['entitlementId'] === 'string' ? payload['entitlementId'] : eventId;
        const userId = subject.startsWith('user:') ? subject.slice('user:'.length) : '';

        // Deduped on the source event id. A failed handler leaves no inbox row, so a redelivery is
        // reprocessed rather than swallowed.
        const outcome = await withInbox(ctx.sql, topic, eventId, async () => {
          return { qualifies: SEASON_PASS_SKUS.has(sku) && userId.length > 0 };
        });
        if (outcome.status === 'duplicate') return { status: 202, body: withFanout({ status: 'duplicate' }) };
        if (outcome.value.qualifies) {
          await deps.queueFor(ctx.network).enqueue({
            kind: SEASON_REWARD_KIND,
            key: entitlementId,
            payload: { userId, entitlementId },
            onConflict: 'keep',
          });
          return { status: 202, body: withFanout({ status: 'accepted', reward: 'queued' }) };
        }
        return { status: 202, body: withFanout({ status: 'accepted' }) };
      } finally {
        done();
      }
    }),

    /* --------------------------------------------------------------- saves */

    define('POST', '/v1/saves', async (ctx) => {
      const userId = await requireUser(ctx, deps);
      const body = await readJson(ctx.req);
      const wardenName = requireString(body, 'wardenName');
      const starter = requireString(body, 'starter');
      const seed = readOptionalSeed(body['seed']);
      const { save, created } = await startGame(
        ctx.sql,
        deps.producer,
        deps.data,
        { userId, wardenName, starter, ...(seed !== null ? { seed } : {}), correlationId: ctx.requestId },
        withOutbox,
      );
      return { status: created ? 201 : 200, body: serializeSave(save) };
    }),

    define('GET', '/v1/saves/me', async (ctx) => {
      const userId = await requireUser(ctx, deps);
      const save = await findSave(ctx.sql, userId);
      if (!save) return errorReply(404, 'not_found', 'no save for this account', ctx.requestId);
      return { status: 200, body: serializeSave(save) };
    }),

    define('POST', '/v1/saves/me/battles', async (ctx) => {
      const userId = await requireUser(ctx, deps);
      const key = headerOf(ctx.req, 'idempotency-key');
      if (!key || key.length < 1 || key.length > 200) {
        throw new BadRequestError('an Idempotency-Key header is required for a battle submission');
      }
      const body = await readJson(ctx.req);
      const enemy = parseEnemy(body['enemy']);
      const script = parseScript(body['script']);
      const seed = readOptionalSeed(body['seed']);
      const maxTurns = typeof body['maxTurns'] === 'number' ? body['maxTurns'] : undefined;

      const result = await resolveBattle(
        ctx.sql,
        deps.producer,
        deps.data,
        {
          userId,
          idempotencyKey: key,
          enemy,
          script,
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          ...(seed !== null ? { seed } : {}),
          correlationId: ctx.requestId,
        },
        withOutbox,
      );

      deps.metrics.increment('emberkin_battles_resolved_total', { outcome: result.replayed ? 'replayed' : result.outcome });
      if (result.unlocked.length > 0) {
        deps.metrics.increment('emberkin_achievements_unlocked_total');
        // Nudge the sweep so the badges reach worlds promptly; it would pick them up anyway.
        await deps.queueFor(ctx.network).enqueue({ kind: ACH_SWEEP_KIND, key: 'stream', onConflict: 'keep' });
      }
      return {
        status: 200,
        body: {
          battleId: result.id,
          outcome: result.outcome,
          turns: result.turns,
          replayed: result.replayed,
          log: result.log,
          unlocked: result.unlocked,
        },
      };
    }),

    define('PUT', '/v1/saves/me/cosmetics', async (ctx) => {
      const userId = await requireUser(ctx, deps);
      const body = await readJson(ctx.req);
      const slot = requireString(body, 'slot');
      const itemUrn = body['itemUrn'] === null ? null : typeof body['itemUrn'] === 'string' ? body['itemUrn'] : undefined;
      if (itemUrn === undefined) throw new BadRequestError('itemUrn must be a string or null');
      const equipped = await equipCosmetic(
        ctx.sql,
        deps.producer,
        deps.billing,
        deps.data,
        { userId, slot, itemUrn, correlationId: ctx.requestId },
        withOutbox,
      );
      return { status: 200, body: { equippedCosmetics: equipped } };
    }),

    define('GET', '/v1/saves/me/achievements', async (ctx) => {
      const userId = await requireUser(ctx, deps);
      const rows = await ctx.sql<{ code: string; name: string; points: number; unlocked_at: Date; delivered_at: Date | null }[]>`
        select code, name, points, unlocked_at, delivered_at from player_achievements
         where user_id = ${userId} order by unlocked_at desc
      `;
      return {
        status: 200,
        body: {
          achievements: rows.map((r) => ({
            code: r.code,
            name: r.name,
            points: r.points,
            unlockedAt: r.unlocked_at.toISOString(),
            delivered: r.delivered_at !== null,
          })),
        },
      };
    }),

    /* --------------------------------------------------------------- content (public, read) */

    define('GET', '/v1/content/dex', async () => ({
      status: 200,
      body: {
        dex: deps.data.dex.map((s) => ({ id: s.id, dexNumber: s.dexNumber, name: s.name, types: s.types })),
      },
    })),
  ];
}

/* --------------------------------------------------------------- auth + parsing helpers */

async function authenticate(ctx: RequestContext<Db>, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'));
  if (!token) throw new TokenError('no bearer token presented', 'missing');
  return deps.verifier.principal(token);
}

/** A user acting on their own save. A service principal must carry emberkin:write and name a user. */
async function requireUser(ctx: RequestContext<Db>, deps: ServerDeps): Promise<string> {
  const principal = await authenticate(ctx, deps);
  if (principal.kind === 'user') return principal.userId;
  // A service may act for a user it names in a header, but only with the write scope.
  requireScope(principal, EMBERKIN_WRITE_SCOPE);
  const onBehalf = headerOf(ctx.req, 'x-user-id');
  if (!onBehalf || !UUID.test(onBehalf)) throw new ForbiddenError('x-user-id (a service must name a user)');
  return onBehalf;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) throw new BadRequestError(`${field} is required`);
  return value.trim();
}

function readOptionalSeed(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && SEED_RE.test(value)) {
    const s = BigInt(value);
    if (s < 0n || s > 18446744073709551615n) throw new BadRequestError('seed out of range');
    return s;
  }
  throw new BadRequestError('seed must be a decimal string ulong');
}

function parseEnemy(value: unknown): { name: string; isWild: boolean; party: KinSpec[] } {
  if (typeof value !== 'object' || value === null) throw new BadRequestError('enemy is required');
  const e = value as Record<string, unknown>;
  const name = typeof e['name'] === 'string' ? e['name'] : 'Wild';
  const isWild = e['isWild'] === true;
  const rawParty = Array.isArray(e['party']) ? e['party'] : [];
  if (rawParty.length === 0) throw new BadRequestError('enemy.party must be a non-empty array');
  const party: KinSpec[] = rawParty.map((m) => {
    const k = m as Record<string, unknown>;
    if (typeof k['species'] !== 'string' || typeof k['level'] !== 'number') {
      throw new BadRequestError('each enemy party member needs species (string) and level (number)');
    }
    const spec: KinSpec = { species: k['species'], level: k['level'] };
    return {
      ...spec,
      ...(typeof k['resonance'] === 'number' ? { resonance: k['resonance'] } : {}),
      ...(typeof k['temperament'] === 'number' ? { temperament: k['temperament'] } : {}),
      ...(typeof k['nickname'] === 'string' ? { nickname: k['nickname'] } : {}),
    };
  });
  return { name, isWild, party };
}

function parseScript(value: unknown): ScriptAction[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestError('script must be an array');
  return value.map((a) => {
    const s = a as Record<string, unknown>;
    const kind = s['kind'];
    if (kind !== 'move' && kind !== 'art' && kind !== 'catch' && kind !== 'flee' && kind !== 'switch' && kind !== 'item') {
      throw new BadRequestError(`unknown script action kind '${String(kind)}'`);
    }
    return {
      kind,
      ...(typeof s['slot'] === 'number' ? { slot: s['slot'] } : {}),
      ...(typeof s['move'] === 'string' ? { move: s['move'] } : {}),
      ...(typeof s['item'] === 'string' ? { item: s['item'] } : {}),
      ...(typeof s['index'] === 'number' ? { index: s['index'] } : {}),
    };
  });
}

function serializeSave(save: import('./savegame.ts').SaveState): Record<string, unknown> {
  return {
    userId: save.userId,
    wardenName: save.wardenName,
    seed: save.seed.toString(),
    currentRegion: save.currentRegion,
    storyProgress: save.storyProgress,
    playtimeSeconds: save.playtimeSeconds,
    party: save.party,
    box: save.box,
    inventory: save.inventory,
    seals: save.seals,
    dexSeen: save.dexSeen,
    equippedCosmetics: save.equippedCosmetics,
    saveVersion: save.saveVersion,
  };
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError('request body is not valid JSON');
  }
}
