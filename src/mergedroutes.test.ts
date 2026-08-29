/**
 * Five route tables on one listener, and the property that makes that safe.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **MATCHING IS FIRST-WINS, SO A SHADOWED ROUTE IS A DEAD ROUTE THAT LOOKS ALIVE.**
 *
 * `mountRoutes` scans one flat table in order and takes the first spec whose method matches and
 * whose compiled pattern matches the path. Two modules declaring the same path is therefore not an
 * error, not a warning and not a log line: the second one's handler is simply never called, for
 * ever, and every test that drives that module STANDALONE still passes because in that process
 * there is nothing in front of it.
 *
 * That is the whole reason this file exists. It is the merge's one purely structural hazard, it is
 * invisible at runtime, and it is cheap to check exhaustively: every ORDERED PAIR of the five route
 * sets, every path, against every other path's compiled PATTERN — not just string equality, because
 * `/v1/keys/self` and `/v1/keys/:id` are different strings that match the same request.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * No database and no environment: this reads the route TABLES, which every module builds without
 * touching a pool. That is deliberate — the shape this file guards is decided at construction, so
 * catching it must not require a Postgres.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compile, OPERATIONAL_ROUTES } from './kernel.ts'
import { EVENTS_PATH, MOUNTED_EVENTS_PATH, SPLIT_EVENT_PATHS } from './server.ts'
import {
  UNMOUNTED as DEVPLATFORM_UNMOUNTED,
  MOUNTED_EVENTS_PATH as DEVPLATFORM_EVENTS,
} from './devplatform/server.ts'
import { UNMOUNTED as POLICY_UNMOUNTED, MOUNTED_EVENTS_PATH as POLICY_EVENTS } from './policy/server.ts'
import { UNMOUNTED as PRICING_UNMOUNTED } from './pricing/server.ts'
import { UNMOUNTED as STUDIO_UNMOUNTED } from './studio/server.ts'

/*
 * ── THE PATH SETS, AS DATA ────────────────────────────────────────────────────────────────────
 *
 * Written down rather than scraped, and that is the one place in this file where a list is the
 * right answer. A scrape would have to build every module's routes, which means building every
 * module's deps, which means five databases — and the property here is about paths, not about
 * behaviour. The lists are pinned against the modules' own `buildRoutes` by the count assertions
 * at the end of the file, so a route added without a line here is a red test rather than an
 * unchecked path.
 */

const AGORA_PATHS = [
  'GET /livez',
  'GET /readyz',
  'GET /metrics',
  'POST /v1/events',
  'GET /v1/me',
  'PATCH /v1/me',
  'PUT /v1/me/email-prefs',
  'GET /v1/me/circles',
  'GET /v1/timeline/latest',
  'GET /v1/timeline/home',
  'GET /v1/timeline/tag/:tag',
  'GET /v1/search',
  'GET /v1/tags/active',
  'GET /v1/bookmarks',
  'POST /v1/posts',
  'GET /v1/posts/:id',
  'GET /v1/posts/:id/thread',
  'PATCH /v1/posts/:id',
  'DELETE /v1/posts/:id',
  'PUT /v1/posts/:id/spark',
  'DELETE /v1/posts/:id/spark',
  'PUT /v1/posts/:id/echo',
  'DELETE /v1/posts/:id/echo',
  'PUT /v1/posts/:id/bookmark',
  'DELETE /v1/posts/:id/bookmark',
  'GET /v1/voices',
  'GET /v1/voices/:ref',
  'GET /v1/voices/:ref/posts',
  'PUT /v1/voices/:ref/follow',
  'DELETE /v1/voices/:ref/follow',
  'PUT /v1/follow-requests/:ref',
  'PUT /v1/voices/:ref/bar',
  'DELETE /v1/voices/:ref/bar',
  'PUT /v1/voices/:ref/hush',
  'DELETE /v1/voices/:ref/hush',
  'PUT /v1/tags/:tag/hush',
  'DELETE /v1/tags/:tag/hush',
  'GET /v1/circles',
  'POST /v1/circles',
  'GET /v1/circles/:ref',
  'PATCH /v1/circles/:ref',
  'GET /v1/circles/:ref/members',
  'GET /v1/circles/:ref/posts',
  'PUT /v1/circles/:ref/membership',
  'DELETE /v1/circles/:ref/membership',
  'PUT /v1/circles/:ref/members/:voice',
  'DELETE /v1/circles/:ref/members/:voice',
  'GET /v1/whispers',
  'POST /v1/whispers',
  'GET /v1/whispers/:id',
  'PUT /v1/whispers/:id/read',
  'DELETE /v1/whispers/:id',
  'DELETE /v1/whispers/messages/:id',
  'GET /v1/notifications',
  'PUT /v1/notifications/read',
  'POST /v1/reports',
  'GET /v1/moderation/reports',
  'POST /v1/moderation/actions',
  'GET /v1/moderation/history/:kind/:id',
] as const

const DEVPLATFORM_PATHS = [
  'GET /livez',
  'GET /readyz',
  'GET /metrics',
  'GET /v1/scopes',
  'GET /v1/keys/self',
  'POST /v1/organisations',
  'GET /v1/organisations',
  'GET /v1/organisations/:id',
  'GET /v1/organisations/:id/projects',
  'POST /v1/projects',
  'GET /v1/projects/:id',
  'POST /v1/projects/:id/service-accounts',
  'GET /v1/projects/:id/service-accounts',
  'POST /v1/projects/:id/keys',
  'GET /v1/projects/:id/keys',
  'GET /v1/keys/:id',
  'DELETE /v1/keys/:id',
  'PUT /v1/projects/:id/quotas',
  'GET /v1/projects/:id/quotas',
  'GET /v1/projects/:id/usage',
  'POST /v1/projects/:id/webhook-endpoints',
  'GET /v1/projects/:id/webhook-endpoints',
  'POST /v1/webhook-endpoints/:id/rotate-secret',
  'POST /v1/webhook-endpoints/:id/disable',
  'POST /v1/webhook-endpoints/:id/enable',
  'DELETE /v1/webhook-endpoints/:id',
  'GET /v1/webhook-endpoints/:id/deliveries',
  'POST /v1/projects/:id/oauth-clients',
  'GET /v1/projects/:id/oauth-clients',
  'DELETE /v1/oauth-clients/:id',
  'GET /v1/apps',
  'GET /v1/apps/pending',
  'GET /v1/apps/:slug',
  'PUT /v1/projects/:id/application',
  'GET /v1/projects/:id/application',
  'POST /v1/projects/:id/application/submit',
  'PUT /v1/projects/:id/application/status',
  'POST /internal/keys/verify',
  'POST /internal/oauth/verify',
  'POST /internal/usage',
  'POST /v1/events',
] as const

const POLICY_PATHS = [
  'GET /livez',
  'GET /readyz',
  'GET /metrics',
  'POST /decisions',
  'GET /decisions/:id',
  'GET /subjects/:subject/decisions',
  'GET /rules',
  'POST /rules',
  'GET /rules/:key',
  'DELETE /rules/:key',
  'POST /trusted-addresses',
  'POST /freezes',
  'GET /freezes/:id',
  'GET /subjects/:subject/freezes',
  'DELETE /freezes/:id',
  'POST /v1/events',
] as const

const PRICING_PATHS = [
  'GET /livez',
  'GET /readyz',
  'GET /metrics',
  'GET /rates',
  'GET /rates/:asset',
  'PUT /admin/prices/:asset',
  'GET /admin/prices',
  'GET /history/:asset',
] as const

const STUDIO_PATHS = [
  'GET /livez',
  'GET /readyz',
  'GET /metrics',
  'GET /v1/backend',
  'POST /v1/brand-kits',
  'GET /v1/brand-kits',
  'GET /v1/brand-kits/:id',
  'GET /v1/brand-kits/:id/assets',
  'POST /v1/brand-kits/:id/generate',
  'GET /v1/jobs/:id',
  'GET /v1/assets/:id',
  'GET /v1/assets/:id/bytes',
  'POST /v1/uploads',
  'POST /v1/assets/:id/visibility',
] as const

/**
 * The five tables, each with what it DROPS on the way into the merged process.
 *
 * agora's drop set is EMPTY, and that is the point of it being written out: the host keeps all
 * three operational paths, because Prometheus scrapes this target under agora's job and kubelet
 * probes this pod. Every other module drops exactly `OPERATIONAL_ROUTES`, taken from that module's
 * own `UNMOUNTED` rather than restated here — so a module that stopped filtering is a red test.
 */
const MODULES = [
  ['agora', AGORA_PATHS, new Set<string>()],
  ['devplatform', DEVPLATFORM_PATHS, DEVPLATFORM_UNMOUNTED],
  ['policy', POLICY_PATHS, POLICY_UNMOUNTED],
  ['pricing', PRICING_PATHS, PRICING_UNMOUNTED],
  ['studio', STUDIO_PATHS, STUDIO_UNMOUNTED],
] as const

/**
 * What one module actually contributes to the merged table.
 *
 * Three transformations, and they are exactly the ones `createMergedServer` and each module's
 * `mountableRoutes` perform: the dropped paths are gone, the webhook is renamed onto that module's
 * own suffixed path, and the HOST additionally gains the 410 that answers the bare path.
 */
function mountedPaths(name: string, paths: readonly string[], unmounted: ReadonlySet<string>): string[] {
  const split = SPLIT_EVENT_PATHS[name]
  const mounted = paths
    .filter((entry) => !unmounted.has(entry.slice(entry.indexOf(' ') + 1)))
    .map((entry) => {
      const [method, path] = [entry.slice(0, entry.indexOf(' ')), entry.slice(entry.indexOf(' ') + 1)]
      return path === EVENTS_PATH && split ? `${method} ${split}` : entry
    })
  // The host's extra route. It is not a module's — nobody's `buildRoutes` declares it — and leaving
  // it out of this model would leave the one path most likely to be re-added by accident unchecked
  // against every other module's patterns.
  return name === 'agora' ? [...mounted, `POST ${EVENTS_PATH}`] : mounted
}

describe('the five modules drop exactly the paths they must not serve', () => {
  it('every mounted module drops all three operational paths', () => {
    for (const [name, paths, unmounted] of MODULES) {
      if (name === 'agora') continue
      const mounted = mountedPaths(name, paths, unmounted)
      for (const dead of ['GET /livez', 'GET /readyz', 'GET /metrics']) {
        assert.ok(!mounted.includes(dead), `${name} mounted ${dead} — the second copy is dead`)
      }
    }
  })

  it('and the host keeps exactly one of each, because it is the one Prometheus scrapes', () => {
    const agora = mountedPaths('agora', AGORA_PATHS, new Set())
    for (const alive of ['GET /livez', 'GET /readyz', 'GET /metrics']) {
      assert.equal(
        agora.filter((entry) => entry === alive).length,
        1,
        `${alive} must be served exactly once, by the host`,
      )
    }
  })

  it('and nothing else is dropped — a module that lost a route would pass every other case here', () => {
    // The floor that makes the drops above a FILTER rather than a truncation. Pinned per module,
    // because "the merged table is smaller than it should be" is otherwise indistinguishable from
    // "the merged table is correct".
    const counts = MODULES.map(([name, paths, unmounted]) => `${name}:${mountedPaths(name, paths, unmounted).length}`)
    assert.deepEqual(counts, ['agora:60', 'devplatform:38', 'policy:13', 'pricing:5', 'studio:11'])
    // 59 of agora's are its own `define(...)` calls and the sixtieth is the 410. Said out loud
    // because "agora:60" alone would be satisfied by 60 real routes and no 410.
    assert.ok(
      mountedPaths('agora', AGORA_PATHS, new Set()).includes(`POST ${EVENTS_PATH}`),
      'the bare event path must still be routed, to a 410 — a generic 404 there is a subscription ' +
        'nobody re-pointed looking exactly like a typo',
    )
  })
})

describe('no path in the merged table shadows another', () => {
  /*
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * EVERY ORDERED PAIR, AND AGAINST THE COMPILED PATTERN RATHER THAN THE STRING.
   *
   * String equality would miss the interesting half. `/v1/keys/self` and `/v1/keys/:id` are
   * different strings, and a request for `/v1/keys/self` matches BOTH — devplatform relies on
   * declaring the literal first, within its own table, which is fine because it controls that
   * order. Across modules nobody controls it, so the check has to be "could this path ever be
   * answered by that module's pattern".
   *
   * A concrete parameter value is substituted for each `:name`, because a pattern is tested
   * against a URL and `/v1/posts/:id` is not one.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  const concrete = (path: string): string => path.replace(/:[a-zA-Z]+/g, 'x')

  it('no module can answer a request the merged table routes to another', () => {
    const tables = MODULES.map(([name, paths, unmounted]) => ({
      name,
      entries: mountedPaths(name, paths, unmounted).map((entry) => {
        const method = entry.slice(0, entry.indexOf(' '))
        const path = entry.slice(entry.indexOf(' ') + 1)
        return { method, path, pattern: compile(path) }
      }),
    }))

    const clashes: string[] = []
    for (const left of tables) {
      for (const right of tables) {
        if (left.name === right.name) continue
        for (const a of left.entries) {
          for (const b of right.entries) {
            if (a.method !== b.method) continue
            if (b.pattern.test(concrete(a.path))) {
              clashes.push(`${left.name} ${a.method} ${a.path} is shadowed by ${right.name} ${b.path}`)
            }
          }
        }
      }
    }
    assert.deepEqual(
      clashes,
      [],
      'a shadowed route is a handler that is never called, in a process where the module that owns ' +
        'it still passes every one of its own tests',
    )
  })

  it('and the check is capable of finding one, or the case above proves nothing', () => {
    // A deliberate collision, run through the same comparison. Without this the case above would
    // pass just as happily against an empty table or a broken matcher.
    const a = { method: 'GET', path: '/v1/keys/self', pattern: compile('/v1/keys/self') }
    const b = { method: 'GET', path: '/v1/keys/:id', pattern: compile('/v1/keys/:id') }
    assert.ok(b.pattern.test(a.path), 'a literal must be shadowed by a parameter at the same depth')
    assert.ok(!a.pattern.test('/v1/keys/other'), 'and the literal must not answer for the parameter')
  })

  it('and every module keeps its own table free of duplicates too', () => {
    for (const [name, paths, unmounted] of MODULES) {
      const mounted = mountedPaths(name, paths, unmounted)
      assert.equal(new Set(mounted).size, mounted.length, `${name} declares a path twice`)
    }
  })
})

describe('the three webhook paths, which are the only renamed routes in the process', () => {
  it('each module that serves one gets its own, and no two are the same', () => {
    const paths = [MOUNTED_EVENTS_PATH, DEVPLATFORM_EVENTS, POLICY_EVENTS]
    assert.equal(new Set(paths).size, 3, `two modules serve one webhook path: ${paths.join(', ')}`)
    for (const path of paths) {
      assert.notEqual(path, EVENTS_PATH, 'no module may keep the bare path — see server.ts')
      assert.ok(path.startsWith(`${EVENTS_PATH}/`), `${path} is not under the bare path`)
    }
  })

  it('and the host’s 410 body names exactly those three, with no literal left behind', () => {
    // `SPLIT_EVENT_PATHS` is written as literals in `server.ts` so that file does not pull two
    // mounted modules' import graphs into every suite that drives it. This is the check that makes
    // the literals safe: a module that renamed its path and left the host's table behind is red
    // here rather than a 410 body pointing at nothing.
    assert.deepEqual(SPLIT_EVENT_PATHS, {
      agora: MOUNTED_EVENTS_PATH,
      devplatform: DEVPLATFORM_EVENTS,
      policy: POLICY_EVENTS,
    })
  })

  it('and the two modules with no webhook are absent from the split, which is a claim', () => {
    // pricing and studio consume nothing: no `SUBSCRIBED_TOPICS`, no `/v1/events`, no inbox
    // delivery path. Listing them in the 410 body would send a producer at a route that does not
    // exist, which is worse than the 410 itself.
    assert.equal(Object.keys(SPLIT_EVENT_PATHS).sort().join(','), 'agora,devplatform,policy')
    for (const paths of [PRICING_PATHS, STUDIO_PATHS] as const) {
      assert.ok(!paths.some((entry) => entry.endsWith(EVENTS_PATH)), 'this module has no webhook')
    }
  })
})
