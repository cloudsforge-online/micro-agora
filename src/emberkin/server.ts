/**
 * The server: this title's routes, mounted on the kernel.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE USED TO BE THE WHOLE HTTP SURFACE. It is now the seam between two halves:
 *
 *   - `kernel.ts` — the request lifecycle and the reply shapes. Knows no route and no service.
 *   - `routes.ts` — the routes, each handler CLOSED OVER `deps` rather than handed it.
 *
 * `createServer` keeps its signature, its export and its behaviour; every path, status, header,
 * cache directive and auth check is what it was. What changed is that the routes can now be
 * mounted by a process that also mounts somebody else's — the precondition for wave M3 of
 * micro-deploy `docs/service-merge-plan.md`, where emberkin absorbs aetherholm.
 *
 * `ServerDeps`, `PrincipalVerifier` and `EMBERKIN_WRITE_SCOPE` are re-exported here because that is where
 * `index.ts`, the tests and the rest of the estate have always imported them from. They are
 * DECLARED in `routes.ts`, beside the handlers that read them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Server } from 'node:http';
import { Metrics } from '@cloudsforge/telemetry';
import type { NetworkSql } from '@cloudsforge/db';
import { OPERATIONAL_ROUTES, mountRoutes, type RouteSpec } from '../kernel.ts';
import { createRoutes, type ServerDeps } from './routes.ts';
import type { Db } from './outbox.ts';

export { EMBERKIN_WRITE_SCOPE, SUBSCRIBED_TOPICS, createRoutes } from './routes.ts';
export type { PrincipalVerifier, ServerDeps, InboundSink, InboundOutcome } from './routes.ts';

export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'emberkin_battles_resolved_total',
      help: 'Battles resolved server-side, by outcome. `replayed` is an idempotent retry.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'emberkin_events_rejected_total',
      help: 'Inbound events refused, by reason. A climbing `bad_signature` is somebody probing the webhook.',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      name: 'emberkin_events_accepted_total',
      help: 'Inbound events whose signature verified, by scheme. `legacy` reaching zero is what says billing has migrated and the legacy arm may be deleted.',
      kind: 'counter',
      labels: ['scheme'],
    })
    .register({
      name: 'emberkin_cosmetic_refusals_total',
      help: 'Attempts to equip a cosmetic the account does not own. Non-zero means a client believes it may.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'emberkin_achievements_unlocked_total',
      help: 'Achievements newly unlocked, bridged to the worlds shared profile.',
      kind: 'counter',
      labels: [],
    })
    .register({
      // THE CHECK THAT DID NOT EXIST WHILE THE TOKEN WAS DEAD (micro-org #228). `/livez` makes no
      // outbound call, so it answered 200 throughout — there was no signal anywhere that this
      // container could no longer authenticate to billing, the ledger or worlds. Sampled on every
      // scrape from the provider's own snapshot, which dials nobody.
      //
      // Deliberately NOT "is a token present": an expired token is retained after it dies, because
      // it is the most useful thing to show a diagnosing operator, and a gauge that read presence
      // as health would report 1 across exactly the outage it exists to reveal.
      name: 'emberkin_service_token_usable',
      help: '1 when this replica holds a service token it could present right now. 0 means every outbound call is answering 503.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      // 1 while this replica is running on a pre-minted `EMBERKIN_SERVICE_TOKEN`, which expires ten
      // minutes after the boot that read it. This reaching zero across the estate is what says the
      // compose change has landed everywhere and the variable may be deleted.
      name: 'emberkin_service_token_static',
      help: '1 when authenticating with a pre-minted token that cannot be renewed (micro-org #228). Should be 0 everywhere.',
      kind: 'gauge',
      labels: [],
    });
}

/**
 * The listener, emberkin's routes only.
 *
 * One line, and it says the whole design: build this title's routes against this title's
 * dependencies, then hand them to a kernel that cannot see either. Kept as its own export because
 * every one of `server.test.ts`'s cases drives exactly this surface, and because a merged listener
 * that could not also be built without the second module would make emberkin untestable alone.
 */
export function createServer(deps: ServerDeps): Server {
  return mountRoutes(createRoutes(deps), deps);
}

/**
 * The listener this process actually runs: emberkin's routes, then every mounted module's.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **N DEPENDENCY BAGS, NEVER ONE.** `deps` is emberkin's and nothing else; `mounted` arrived as
 * closures that had already captured bags this function has no name for. That asymmetry is the
 * merge's central safety property — this signature CANNOT be handed aetherholm's or nda's
 * database, queue or producer name, because there is no parameter one would arrive through.
 *
 * Order is first-wins, and emberkin goes first for one reason that is not a preference:
 * `/livez`, `/readyz` and `/metrics` are emberkin's in this process (see each module's `UNMOUNTED`
 * for why), and a mounted module must not be able to shadow them by accident. Order among the
 * MOUNTED modules is not load-bearing and must never become so — `mergedroutes.test.ts` asserts
 * every pair of route tables overlaps on exactly the four dropped paths, which is what makes the
 * concatenation order irrelevant rather than merely undocumented.
 *
 * Checked, not assumed: `mergedroutes.test.ts` computes the path sets and asserts each overlap is
 * EXACTLY the four paths a module filters out — the three operational ones and `POST /v1/events`,
 * which one handler serves for the whole process and fans out. A fifth collision appearing later
 * is a red test rather than a route that silently stops being reachable.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function createMergedServer(deps: ServerDeps, mounted: readonly RouteSpec<Db>[]): Server {
  return mountRoutes([...createRoutes(deps), ...mounted], deps);
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WAVE M5d: WHAT THIS MODULE MOUNTS INSIDE THE PLATFORM MONOLITH
 *
 * micro-deploy `docs/service-merge-plan.md`. Everything above this line is the STANDALONE
 * listener — emberkin alone, and emberkin plus its two nested titles — unchanged. Both suites
 * still drive it, and their passing unchanged is the evidence that the merge did not alter this
 * process's own surface. Everything below is how the same three-title route table is mounted
 * beside agora's seventeen other modules.
 *
 * **THE NESTING IS PRESERVED, NOT FLATTENED.** agora calls one factory here; this module calls
 * `createAetherholmModule` and `createNdaModule` in turn. Three modules, one factory call from the
 * host, exactly as activity/notify and lantern/analytics are arranged. What that buys is the seam
 * `./mergedupstreams.test.ts` and `./mergedroutes.test.ts` already check: the nested titles read
 * NO inbound secret of their own, which is what makes the single-webhook fan-out below honest.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * The paths this module must NOT serve in the merged process.
 *
 * `/livez`, `/readyz` and `/metrics` exist on every module of the platform monolith. Matching is
 * FIRST-WINS, so a second copy of each would be unreachable — a dead health endpoint that looks
 * exactly like a live one. agora's win, because it is the host and because Prometheus scrapes that
 * target under agora's job.
 *
 * `POST /v1/events` is NOT here, and that is the difference between this module and the other
 * eighteen: it stays MOUNTED, at a suffixed path, because it is the single webhook the three
 * titles fan out from. See `MOUNTED_EVENTS_PATH`.
 */
export const UNMOUNTED: ReadonlySet<string> = new Set(OPERATIONAL_ROUTES);

/** The webhook path this process serves STANDALONE. Ten of agora's modules mount this exact path. */
export const EVENTS_PATH = '/v1/events';

/**
 * The webhook path this module serves INSIDE the merged process — and the one fan-out agora keeps.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **ONE VERIFICATION, THREE SINKS — AND WHY THAT IS LEGITIMATE HERE AND NOWHERE ELSE.**
 *
 * `market/server.ts` records the rule this process's other webhooks follow: more than one module
 * mounts `POST /v1/events` and they do NOT verify with the same key, so each serves its own
 * suffixed path against its own inbox, and verifying once at a shared route would be one key
 * silently deciding for modules that read a different one.
 *
 * The three titles are the exception, and it is a measured one rather than a convenience. All
 * three read the SAME estate-wide `OUTBOX_SIGNING_SECRET`/`OUTBOX_ACCEPT_SECRETS` — no title
 * declares an inbound secret variable of its own, which `./mergedupstreams.test.ts` asserts by
 * reading their `env.ts` files — so a delivery that verifies for one verifies for all three. And
 * all three subscribe to `identity.user.deleted`: routing that to ONE of them would answer 202 to
 * a deletion two thirds of which never happened, with every city and homestead that person founded
 * still standing.
 *
 * So the fan-out is preserved exactly: one signature check, `inbound: [aetherholm, nda]`, and each
 * sink writing to its own database through its own handle. What changes in this wave is only the
 * PATH, from `/v1/events` to `/v1/events/emberkin`, because ten other modules of the merged
 * process now mount the bare one and none of them may decide for these three.
 *
 * `deploy/scripts/estate-bootstrap.sh` holds the `event_subscriptions` rows that point at this
 * path, and they must move in the same release. The bare path's 410 is what turns a subscription
 * nobody re-pointed into a loud failure in the producer's `outbox_deliveries.last_error`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const MOUNTED_EVENTS_PATH = '/v1/events/emberkin';

/**
 * This process's three route tables, ready to mount beside agora's.
 *
 * `mounted` is aetherholm's and nda's, ALREADY stamped with their own selectors by their own
 * factories — the same asymmetry `createMergedServer` above describes, and for the same reason:
 * this function has no name for either module's database and cannot hand one the wrong handle.
 * emberkin's own specs are stamped here, with `sql`.
 *
 * emberkin goes FIRST, as it does standalone. Order among the three is not load-bearing —
 * `./mergedroutes.test.ts` asserts the overlaps — and agora's `../mergedroutes.test.ts` asserts
 * the whole twenty-module table has no shadowed path at all.
 */
export function mountableRoutes(
  deps: ServerDeps,
  sql: NetworkSql,
  mounted: readonly RouteSpec<Db>[],
): readonly RouteSpec<Db>[] {
  return [
    ...createRoutes(deps)
      .filter((spec) => !UNMOUNTED.has(spec.path))
      .map((spec) => ({
        method: spec.method,
        path: spec.path === EVENTS_PATH ? MOUNTED_EVENTS_PATH : spec.path,
        handle: spec.handle,
        sql,
      })),
    ...mounted,
  ];
}
