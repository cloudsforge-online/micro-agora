/**
 * The listener, aetherholm's routes only — and the module's own domain metrics.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS FILE USED TO BE THE WHOLE HTTP SURFACE. Wave M3 (micro-deploy `docs/service-merge-plan.md`)
 * split it in three:
 *
 *   - `../kernel.ts` — the request lifecycle and the reply shapes. Knows no route and no service.
 *   - `./routes.ts`  — the routes, each handler CLOSED OVER `deps` rather than handed it.
 *   - this file      — `createServer`, `registerServiceMetrics`, and the re-exports the rest of
 *                      the repository has always imported from here.
 *
 * `createServer` KEEPS ITS SIGNATURE AND ITS BEHAVIOUR, and that is load-bearing rather than
 * courteous: `server.test.ts`, `titlecontract.test.ts`, `erasure.test.ts` and `visibility.test.ts`
 * all drive this listener, and a merged process is not the thing they are testing. Every one of
 * them passes unchanged, which is the only way to know the merge did not quietly alter this
 * title's own surface while adding a second one beside it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Server } from 'node:http';
import { Metrics } from '@cloudsforge/telemetry';
import type { NetworkSql } from '@cloudsforge/db';
import { OPERATIONAL_ROUTES, mountRoutes, type RouteSpec } from '../../kernel.ts';
import { createRoutes, type ServerDeps } from './routes.ts';
import type { Db } from './outbox.ts';
// The two FROZEN contract paths, imported rather than spelled, so `REMOUNTED_PATHS` below cannot
// drift from what `worlds` appends to a title's base URL.
import { PROVISION_PATH, TITLE_DESCRIPTOR_PATH } from '@cloudsforge/contracts-worlds';

export { createRoutes } from './routes.ts';
export {
  AETHERHOLM_PROVISION_SCOPE,
  AETHERHOLM_READ_SCOPE,
  SUBSCRIBED_TOPICS,
  TITLE_DESCRIPTOR,
  TITLE_SLUG,
  AETHERHOLM_WRITE_SCOPE,
} from './routes.ts';
export type { PrincipalVerifier, ServerDeps } from './routes.ts';

export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'aetherholm_provisions_total',
      help: 'Title-contract provisions, by outcome. `replayed` is the idempotent second ask.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'aetherholm_cities_founded_total',
      help: 'Cities founded. A refound of an existing city does not count.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'aetherholm_queue_submissions_total',
      help: 'Queue submissions accepted, by kind. `replayed` marks idempotent retries.',
      kind: 'counter',
      labels: ['kind', 'replayed'],
    })
    .register({
      name: 'aetherholm_fleets_launched_total',
      help: 'Fleets launched, by mission. `replayed` marks idempotent retries.',
      kind: 'counter',
      labels: ['mission', 'replayed'],
    });
}

/**
 * This title's routes on a listener of their own.
 *
 * Not what the deployed process runs — that is `createMergedServer` in `../server.ts`, which
 * mounts these beside emberkin's — but it is what this title's whole suite drives, and keeping it
 * buildable alone is what makes the merged listener a composition rather than a rewrite.
 */
export function createServer(deps: ServerDeps): Server {
  return mountRoutes(createRoutes(deps), deps);
}

/** The prefix this module's FROZEN title-contract paths carry inside the merged process. */
export const TITLE_MOUNT_PREFIX = '/aetherholm';

/**
 * The two frozen contract paths, and the wave that finally had to move them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE COLLISION WAVE M3 REFUSED TESSERA OVER, ARRIVING FROM THE OTHER DIRECTION.**
 *
 * `../index.ts`'s header — the one this module was written under — said it plainly: `GET
 * /v1/title` and `POST /v1/provision` are frozen constants in `@cloudsforge/contracts-worlds`, and
 * BOTH aetherholm and tessera mount them. Matching is first-wins, so in one process the second
 * title's descriptor and provision handler are simply dead, and a paid `world.private.small`
 * provision would be answered with a 200 by the wrong game. It refused tessera into emberkin on
 * exactly that ground and said the fix was out of that repository's scope.
 *
 * Wave M5d puts them in one process anyway — tessera has been a module of agora since M5b — so the
 * fix has to exist. It is this, and it needs no contracts change:
 *
 *   * `worlds/titleclient.ts`'s `pathOf` PREPENDS the pathname of the title's registered base URL
 *     to the frozen suffix, and `clientFor` uses only the ORIGIN as the base. A title registered
 *     at `http://agora:4000/aetherholm` is therefore addressed at `/aetherholm/v1/title` and
 *     `/aetherholm/v1/provision` — computed from the registry row, not from a constant.
 *   * So the CONTRACT is unchanged: the suffix `worlds` appends is still exactly
 *     `TITLE_DESCRIPTOR_PATH` and `PROVISION_PATH`. What moves is this title's base URL, which is
 *     a row in `worlds`, not a published path.
 *   * tessera keeps both paths BARE, because it is the title `worlds` addresses at an origin with
 *     no path. Same rule as everywhere else in this process: the module a caller already addresses
 *     keeps the path, and the one that can be re-registered moves.
 *
 * **THE DEPLOY HALF IS NOT OPTIONAL.** aetherholm's row in `worlds`' title registry must name
 * `http://agora:4000/aetherholm` in the same release. Left at an origin-only base URL, `worlds`
 * asks `/v1/title`, tessera answers, and a player who paid for an aetherholm archipelago is
 * provisioned a tessera ward — with a 200, silently. `../mergedroutes.test.ts` asserts the split;
 * only the registry row can make it true at run time.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const REMOUNTED_PATHS: Readonly<Record<string, string>> = Object.freeze({
  [TITLE_DESCRIPTOR_PATH]: `${TITLE_MOUNT_PREFIX}${TITLE_DESCRIPTOR_PATH}`,
  [PROVISION_PATH]: `${TITLE_MOUNT_PREFIX}${PROVISION_PATH}`,
});

/**
 * The four paths this module does NOT mount, and the two it mounts under a prefix.
 *
 * ── WHY THE DROP, AND WHY IT IS A FILTER RATHER THAN A DELETION ────────────────────────────────
 *
 * One process serves ONE `/livez`, ONE `/readyz` and ONE `/metrics`; mounting two of each would
 * make the second unreachable — first-wins matching — which is a shadowed handler nobody would
 * ever notice was dead. In wave M3 those were emberkin's; since wave M5d they are agora's, and
 * emberkin drops them too.
 *
 * `POST /v1/events` is the fourth, and it is the one that is not merely about shadowing. All three
 * titles subscribe to `identity.user.deleted`. Mounted second, this module's copy would be
 * SHADOWED by emberkin's and every erasure would silently stop reaching this database — a deletion
 * that answers 202 while every city that person founded stays standing. So the route is dropped
 * here and this module joins emberkin's single webhook through `inbound` instead, which fans out
 * to every title that subscribes.
 *
 * It is a filter and NOT a deletion from `routes.ts` because that table is also the standalone
 * listener's, which `server.test.ts`, `titlecontract.test.ts` and `erasure.test.ts` all drive —
 * and those suites are the only evidence that the merge did not alter this title's own surface.
 */
export const UNMOUNTED: ReadonlySet<string> = new Set([...OPERATIONAL_ROUTES, '/v1/events']);

/**
 * Every route this module contributes to the merged listener, in the shape the host's kernel takes.
 *
 * Three things happen here and each is load-bearing:
 *
 *   1. **The four paths above are filtered out.** See `UNMOUNTED`.
 *   2. **The two FROZEN contract paths are remounted.** See `REMOUNTED_PATHS`. This is the wave
 *      M5d half of the collision wave M3 refused tessera over.
 *   3. **Every spec carries `sql`.** The kernel resolves ONE handle per request from ONE selector,
 *      and the host's is agora's. Mounted without the stamp, `select … from seasons` would run
 *      against a `seasons` table belonging to another game — a table that EXISTS, with the same
 *      columns — and succeed. Stamped once here, over the whole table, so no handler had to change.
 */
export function mountableRoutes(deps: ServerDeps, sql: NetworkSql): readonly RouteSpec<Db>[] {
  return createRoutes(deps)
    .filter((spec) => !UNMOUNTED.has(spec.path))
    .map((spec) => ({
      method: spec.method,
      path: REMOUNTED_PATHS[spec.path] ?? spec.path,
      handle: spec.handle,
      sql,
    }));
}
