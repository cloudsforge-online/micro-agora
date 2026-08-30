/**
 * Twelve route tables on one listener, and the property that makes that safe.
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
 * invisible at runtime, and it is cheap to check exhaustively.
 *
 * ── WHY WAVE M5b MADE THIS FILE SCRAPE RATHER THAN LIST ────────────────────────────────────────
 *
 * M5a's five modules had DISJOINT paths, so a hand-maintained list was reviewable and enough.
 * M5b's commerce/games tier does NOT: community and devplatform both mount `GET /v1/scopes`,
 * community and agora both mount `DELETE /v1/posts/:id`, and market and tessera both mount four
 * `/v1/listings…` routes. Those are real collisions — the estate's public API guarantees no
 * public↔public overlap (`deploy/gateway/dynamic/public-api.yml`), but these are public↔internal.
 * They are resolved the same way the event webhooks are: the module the gateway does NOT route to
 * (the internal one — community, tessera) remounts its colliding routes under a namespace inside
 * `mountableRoutes`, so the public owner keeps the bare path. See `REMOUNTED_PATHS` in
 * `./community/server.ts` and `./tessera/server.ts`.
 *
 * With that many rewrites in play, a transcribed list is a transcription bug waiting to happen. So
 * the twelve tables are SCRAPED from each module's own `mountableRoutes` — which needs no database:
 * `mountableRoutes` builds the spec array (method, path and a handler CLOSURE) without issuing a
 * query, and this file never calls a handler. What it reads is exactly what `index.ts` mounts.
 * agora is the host and builds its table in `createRoutes` rather than a `mountableRoutes`, so its
 * paths are the one written-down set, transformed here exactly as `createMergedServer` transforms
 * them (its webhook onto `/v1/events/agora`, plus the bare-path 410).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { compile } from './kernel.ts'
import type { RouteSpec } from './kernel.ts'
import type { Db } from './outbox.ts'
import {
  EVENTS_PATH,
  MOUNTED_EVENTS_PATH as AGORA_EVENTS,
  SPLIT_EVENT_PATHS,
} from './server.ts'
import { mountableRoutes as devplatform, MOUNTED_EVENTS_PATH as DEVPLATFORM_EVENTS } from './devplatform/server.ts'
import { mountableRoutes as policy, MOUNTED_EVENTS_PATH as POLICY_EVENTS } from './policy/server.ts'
import { mountableRoutes as pricing } from './pricing/server.ts'
import { mountableRoutes as studio } from './studio/server.ts'
import {
  mountableRoutes as community,
  MOUNTED_EVENTS_PATH as COMMUNITY_EVENTS,
  REMOUNTED_PATHS as COMMUNITY_REMOUNTS,
} from './community/server.ts'
import { mountableRoutes as market, MOUNTED_EVENTS_PATH as MARKET_EVENTS } from './market/server.ts'
import { mountableRoutes as billing, MOUNTED_EVENTS_PATH as BILLING_EVENTS } from './billing/server.ts'
import { mountableRoutes as mint, MOUNTED_EVENTS_PATH as MINT_EVENTS } from './mint/server.ts'
import { mountableRoutes as foresight } from './foresight/server.ts'
import { mountableRoutes as worlds, MOUNTED_EVENTS_PATH as WORLDS_EVENTS } from './worlds/server.ts'
import {
  mountableRoutes as tessera,
  MOUNTED_EVENTS_PATH as TESSERA_EVENTS,
  REMOUNTED_PATHS as TESSERA_REMOUNTS,
} from './tessera/server.ts'
// ── WAVE M5c: FOUR MORE TABLES, AND TWO OF THEM ARRIVE NESTED ─────────────────────────────────
//
// activity and lantern were already merged processes, so each contributes TWO tables: its own and
// the one nested inside it. They are scraped SEPARATELY here rather than through their host
// modules' concatenation, because the property this file measures is pairwise — notify shadowing
// market would be just as dead as notify shadowing activity, and a host that handed up one merged
// array would hide which half of it collided.
//
// `mountableRoutes` is imported from each module's `server.ts` and NEVER from its `module.ts`.
// That is not style: `activity/notify/module.ts` and `lantern/analytics/module.ts` import their own
// `env.ts`, which validates at import and calls `process.exit(1)` on an incomplete configuration —
// so importing either here would kill this runner outright, in a suite that deliberately needs no
// database and no secrets. Wave M5c moved both functions to `server.ts` for exactly this reason.
import { mountableRoutes as activity, INGEST_PATHS } from './activity/server.ts'
import { mountableRoutes as notify, NOTIFY_INGEST_PATH } from './activity/notify/server.ts'
import { mountableRoutes as lantern } from './lantern/server.ts'
import {
  mountableRoutes as analytics,
  MOUNTED_INGEST_PATH as ANALYTICS_INGEST,
} from './lantern/analytics/server.ts'
import { ACTIVITY_INGEST_PATH } from './activity/routes.ts'

interface Entry {
  readonly method: string
  readonly path: string
  /**
   * A fallback is NEVER matched by path — `mountRoutes` lifts it out of the matching table and runs
   * it only when nothing else answered. It is carried here so the shadow check can skip it (a
   * fallback cannot shadow anything, and `compile('unmatched')` would be a meaningless pattern) and
   * so the case at the end can assert there is exactly one in the process.
   */
  readonly fallback?: true
}

/**
 * The mounted table of one module, scraped from its own `mountableRoutes`.
 *
 * `mountableRoutes` closes each handler over the deps it is given but never TOUCHES them at
 * construction — it maps `buildRoutes()` into specs — so a placeholder is safe and no database is
 * opened. This is the exact object `index.ts` concatenates into the process's one route table.
 */
type Mountable = (deps: never, sql: never) => readonly RouteSpec<Db>[]
const PLACEHOLDER = {} as never
function scrape(mountable: Mountable): Entry[] {
  return mountable(PLACEHOLDER, PLACEHOLDER).map((spec) => ({
    method: spec.method,
    path: spec.path,
    ...(spec.fallback ? { fallback: spec.fallback } : {}),
  }))
}


/*
 * ── AGORA, THE HOST ───────────────────────────────────────────────────────────────────────────
 *
 * Written down rather than scraped, because agora builds its table in `createRoutes` (it is the
 * host, not a mounted module) and driving that needs its deps. Transformed here exactly as
 * `createMergedServer` transforms it: it KEEPS all three operational paths (Prometheus scrapes this
 * target under agora's job and kubelet probes this pod), its own `POST /v1/events` becomes
 * `/v1/events/agora`, and the bare path gains the 410 that names the split. The count assertion at
 * the end pins this list against agora's real `define(...)` calls.
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

function agoraMounted(): Entry[] {
  const own = AGORA_PATHS.map((entry) => {
    const method = entry.slice(0, entry.indexOf(' '))
    const path = entry.slice(entry.indexOf(' ') + 1)
    return { method, path: path === EVENTS_PATH ? AGORA_EVENTS : path }
  })
  // The host's extra route: the bare path, answering 410. Nobody's `buildRoutes` declares it.
  return [...own, { method: 'POST', path: EVENTS_PATH }]
}

/** The whole process's route table, module by module, in the order `index.ts` concatenates them. */
const TABLES: ReadonlyArray<readonly [string, Entry[]]> = [
  ['agora', agoraMounted()],
  ['devplatform', scrape(devplatform)],
  ['policy', scrape(policy)],
  ['pricing', scrape(pricing)],
  ['studio', scrape(studio)],
  ['community', scrape(community)],
  ['market', scrape(market)],
  ['billing', scrape(billing)],
  ['mint', scrape(mint)],
  ['foresight', scrape(foresight)],
  ['worlds', scrape(worlds)],
  ['tessera', scrape(tessera)],
  ['activity', scrape(activity)],
  ['notify', scrape(notify)],
  ['lantern', scrape(lantern as never)],
  ['analytics', scrape(analytics as never)],
]

const OPERATIONAL = ['GET /livez', 'GET /readyz', 'GET /metrics'] as const
const asString = (e: Entry): string => `${e.method} ${e.path}`

describe('the fifteen mounted modules drop exactly the paths they must not serve', () => {
  it('every mounted module drops all three operational paths', () => {
    for (const [name, entries] of TABLES) {
      if (name === 'agora') continue
      for (const dead of OPERATIONAL) {
        assert.ok(!entries.map(asString).includes(dead), `${name} mounted ${dead} — the second copy is dead`)
      }
    }
  })

  it('and the host keeps exactly one of each, because it is the one Prometheus scrapes', () => {
    const all = TABLES.flatMap(([, entries]) => entries.map(asString))
    for (const alive of OPERATIONAL) {
      assert.equal(all.filter((e) => e === alive).length, 1, `${alive} must be served exactly once, by the host`)
    }
  })

  it('and each module contributes the number of routes it should — a filter, not a truncation', () => {
    // Pinned per module, because "the merged table is smaller than it should be" is otherwise
    // indistinguishable from "correct". Scraped counts, so a route added or lost in a module is a
    // red test here rather than an unchecked path. agora is 59 own `define(...)` + the 410 = 60.
    const counts = TABLES.map(([name, entries]) => `${name}:${entries.length}`)
    assert.deepEqual(counts, [
      'agora:60',
      'devplatform:38',
      'policy:13',
      'pricing:5',
      'studio:11',
      'community:29',
      'market:30',
      'billing:7',
      'mint:9',
      'foresight:27',
      'worlds:19',
      'tessera:37',
      // Wave M5c. activity's four are `/feed`, `/feed/:id`, `POST /ingest/activity` and the bare
      // `POST /ingest` 410 — the only 410 in the process for that path family, and the reason it is
      // MOUNTED rather than filtered. lantern's eight include its `fallback`, which is a spec in the
      // array but never a row in the matching table.
      'activity:4',
      'notify:8',
      'lantern:8',
      'analytics:11',
    ])
    assert.ok(
      TABLES.find(([n]) => n === 'agora')![1].some((e) => e.method === 'POST' && e.path === EVENTS_PATH),
      'the bare event path must still be routed, to a 410 — a generic 404 there is a subscription ' +
        'nobody re-pointed looking exactly like a typo',
    )
  })
})

describe('no path in the merged table shadows another', () => {
  /*
   * EVERY ORDERED PAIR, AND AGAINST THE COMPILED PATTERN RATHER THAN THE STRING — `/v1/keys/self`
   * and `/v1/keys/:id` are different strings that match the same request. A concrete value is
   * substituted for each `:name`, because a pattern is tested against a URL.
   */
  const concrete = (path: string): string => path.replace(/:[a-zA-Z]+/g, 'x')

  it('no module can answer a request the merged table routes to another', () => {
    const tables = TABLES.map(([name, entries]) => ({
      name,
      // Fallbacks are excluded because the kernel excludes them: `mountRoutes` lifts a fallback out
      // of the matching loop entirely, so it can neither shadow nor be shadowed. Including it would
      // compile `unmatched` into a pattern that means nothing and could only produce noise.
      entries: entries
        .filter((e) => !e.fallback)
        .map((e) => ({ method: e.method, path: e.path, pattern: compile(e.path) })),
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
      [...new Set(clashes)],
      [],
      'a shadowed route is a handler that is never called, in a process where the module that owns ' +
        'it still passes every one of its own tests. The commerce/games collisions are resolved by ' +
        'REMOUNTED_PATHS in community/server.ts and tessera/server.ts.',
    )
  })

  it('and the check is capable of finding one, or the case above proves nothing', () => {
    const a = { method: 'GET', path: '/v1/keys/self', pattern: compile('/v1/keys/self') }
    const b = { method: 'GET', path: '/v1/keys/:id', pattern: compile('/v1/keys/:id') }
    assert.ok(b.pattern.test(a.path), 'a literal must be shadowed by a parameter at the same depth')
    assert.ok(!a.pattern.test('/v1/keys/other'), 'and the literal must not answer for the parameter')
  })

  it('and every module keeps its own table free of duplicates too', () => {
    for (const [name, entries] of TABLES) {
      const strings = entries.map(asString)
      assert.equal(new Set(strings).size, strings.length, `${name} declares a path twice`)
    }
  })
})

describe('the commerce/games path collisions are resolved by remounting the internal module', () => {
  /*
   * The three collisions M5b introduced, each between a PUBLIC owner (which the gateway routes to
   * and which keeps the bare path) and an INTERNAL module (which remounts). This is the same
   * mechanism as the event split, applied to resource routes. If a remount were dropped the shadow
   * check above would already be red; these cases name WHICH module keeps which path, so a
   * regression reads as a sentence rather than a pattern clash.
   */
  const pathsOf = (name: string): Set<string> =>
    new Set(TABLES.find(([n]) => n === name)![1].map(asString))

  it('GET /v1/scopes stays devplatform’s (public); community’s remounts under /v1/community', () => {
    assert.ok(pathsOf('devplatform').has('GET /v1/scopes'), 'the public owner keeps the bare path')
    assert.ok(!pathsOf('community').has('GET /v1/scopes'), 'community must not shadow it')
    assert.ok(pathsOf('community').has('GET /v1/community/scopes'), 'community serves the namespaced path')
    assert.equal(COMMUNITY_REMOUNTS['/v1/scopes'], '/v1/community/scopes')
  })

  it('DELETE /v1/posts/:id stays agora’s (public); community’s remounts', () => {
    assert.ok(pathsOf('agora').has('DELETE /v1/posts/:id'), 'the square keeps its own post deletion')
    assert.ok(!pathsOf('community').has('DELETE /v1/posts/:id'), 'community must not shadow it')
    assert.ok(pathsOf('community').has('DELETE /v1/community/posts/:id'))
    assert.equal(COMMUNITY_REMOUNTS['/v1/posts/:id'], '/v1/community/posts/:id')
  })

  it('the four /v1/listings routes stay market’s (public); tessera’s remount under /v1/tessera', () => {
    const m = pathsOf('market')
    const t = pathsOf('tessera')
    for (const bare of ['GET /v1/listings', 'GET /v1/listings/:id', 'POST /v1/listings', 'POST /v1/listings/:id/activate']) {
      assert.ok(m.has(bare), `market keeps ${bare}`)
      assert.ok(!t.has(bare), `tessera must not shadow ${bare}`)
    }
    for (const moved of ['GET /v1/tessera/listings', 'GET /v1/tessera/listings/:id', 'POST /v1/tessera/listings', 'POST /v1/tessera/listings/:id/activate']) {
      assert.ok(t.has(moved), `tessera serves ${moved}`)
    }
    assert.deepEqual(TESSERA_REMOUNTS, {
      '/v1/listings': '/v1/tessera/listings',
      '/v1/listings/:id': '/v1/tessera/listings/:id',
      '/v1/listings/:id/activate': '/v1/tessera/listings/:id/activate',
    })
  })

  it('and tessera keeps the FROZEN title contract paths bare — the M5d collision is a future wave', () => {
    // aetherholm also mounts /v1/title and /v1/provision, but it arrives in the separate emberkin
    // pod in M5d, so there is no in-process collision now. Left bare deliberately.
    const t = pathsOf('tessera')
    assert.ok(t.has('GET /v1/title'), 'the title descriptor stays on its frozen contract path')
    assert.ok(t.has('POST /v1/provision'), 'provisioning stays on its frozen contract path')
  })
})

describe('the nine webhook paths, which are the only split routes in the process', () => {
  it('every module that ingests events gets its own suffixed path, and no two are the same', () => {
    const paths = [
      AGORA_EVENTS,
      DEVPLATFORM_EVENTS,
      POLICY_EVENTS,
      COMMUNITY_EVENTS,
      MARKET_EVENTS,
      BILLING_EVENTS,
      MINT_EVENTS,
      WORLDS_EVENTS,
      TESSERA_EVENTS,
    ]
    assert.equal(new Set(paths).size, paths.length, `two modules serve one webhook path: ${paths.join(', ')}`)
    for (const path of paths) {
      assert.notEqual(path, EVENTS_PATH, 'no module may keep the bare path — see server.ts')
      assert.ok(path.startsWith(`${EVENTS_PATH}/`), `${path} is not under the bare path`)
    }
  })

  it('and the host’s 410 body names exactly those nine, with no literal left behind', () => {
    // `SPLIT_EVENT_PATHS` is written as literals in `server.ts`; this is the check that keeps them
    // honest — a module that renamed its path and left the host's table behind is red here.
    assert.deepEqual(SPLIT_EVENT_PATHS, {
      agora: AGORA_EVENTS,
      devplatform: DEVPLATFORM_EVENTS,
      policy: POLICY_EVENTS,
      community: COMMUNITY_EVENTS,
      market: MARKET_EVENTS,
      billing: BILLING_EVENTS,
      mint: MINT_EVENTS,
      worlds: WORLDS_EVENTS,
      tessera: TESSERA_EVENTS,
    })
  })

  it('and the three modules with no webhook are absent from the split, which is a claim', () => {
    // pricing, studio and foresight consume nothing: no `/v1/events`, no inbox delivery path.
    // Listing them in the 410 body would send a producer at a route that does not exist.
    assert.equal(Object.keys(SPLIT_EVENT_PATHS).sort().join(','), 'agora,billing,community,devplatform,market,mint,policy,tessera,worlds')
    for (const name of ['pricing', 'studio', 'foresight']) {
      const entries = TABLES.find(([n]) => n === name)![1].map(asString)
      assert.ok(!entries.some((e) => e.endsWith(EVENTS_PATH)), `${name} has no webhook`)
      assert.ok(!(name in SPLIT_EVENT_PATHS), `${name} must not be in the split`)
    }
  })
})

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WAVE M5c: THE PROCESS HAS A SECOND SPLIT PATH FAMILY, AND IT IS NOT `/v1/events`.
 *
 * The nine webhooks above are the `POST /v1/events/*` family — the estate's event bus, signed with
 * `OUTBOX_SIGNING_SECRET` and its per-module variants. The four modules M5c brought in do not use
 * that family at all: activity, notify and analytics each consume the bus over a path under
 * `/ingest`, with a signing secret of their own, and lantern serves a browser RUM sink under the
 * same prefix with no signature at all.
 *
 * So the same rule is enforced twice over two disjoint families. Every ingesting module has its OWN
 * path, its OWN accept-list and its OWN inbox; the bare `POST /ingest` answers 410 naming them; and
 * nothing verifies once and fans out. `activity/routes.ts`'s `INGEST_PATHS` carries the four-part
 * argument for why one shared mount would be a downgrade rather than compatibility.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe('the ingest paths, which are the process’s OTHER split family', () => {
  const pathsOf = (name: string): Set<string> =>
    new Set(TABLES.find(([n]) => n === name)![1].map(asString))

  it('each of the three signed inboxes is served by exactly one module, on a path of its own', () => {
    const inboxes = [
      ['activity', ACTIVITY_INGEST_PATH, 'ACTIVITY_INGEST_SECRETS'],
      ['notify', NOTIFY_INGEST_PATH, 'NOTIFY_INGEST_SIGNING_SECRET'],
      ['analytics', ANALYTICS_INGEST, 'ANALYTICS_DELIVERY_SECRETS'],
    ] as const

    assert.equal(
      new Set(inboxes.map(([, path]) => path)).size,
      inboxes.length,
      'two modules share an ingest path, so one accept-list now decides for another module',
    )
    for (const [owner, path, secret] of inboxes) {
      assert.ok(pathsOf(owner).has(`POST ${path}`), `${owner} must serve its own ${path} (${secret})`)
      const others = TABLES.filter(([name]) => name !== owner).flatMap(([name, entries]) =>
        entries.filter((e) => asString(e) === `POST ${path}`).map(() => name),
      )
      assert.deepEqual(others, [], `${path} is also served by ${others.join(', ')} — one of them is dead`)
      assert.ok(path.startsWith('/ingest/'), `${path} must be suffixed, not the bare path`)
    }
  })

  it('the bare POST /ingest is activity’s 410 and nobody else’s, and it is still routed', () => {
    // A route rather than a fall-through, for the same reason the bare `/v1/events` is one: without
    // it the path is a generic 404 and a subscription nobody re-pointed looks exactly like a typo.
    // A 410 is "this existed and was deliberately withdrawn", and it names the successors.
    const owners = TABLES.filter(([, entries]) => entries.some((e) => asString(e) === 'POST /ingest'))
    assert.deepEqual(
      owners.map(([name]) => name),
      ['activity'],
      'exactly one module may answer the retired shared ingest path, and it must answer 410',
    )
  })

  it('and the 410 body names exactly the three signed inboxes — not the browser sink', () => {
    assert.deepEqual(
      [...INGEST_PATHS],
      [`POST ${ACTIVITY_INGEST_PATH}`, `POST ${NOTIFY_INGEST_PATH}`, `POST ${ANALYTICS_INGEST}`],
      'the 410 must name every inbox that verifies a delivery signature, and no others',
    )
    // `/ingest/client` is lantern's browser sink: no signature, an origin allowlist instead, and a
    // payload that is not an event envelope. Naming it here would send a producer holding a signed
    // delivery at a path that would refuse it for a reason having nothing to do with its key.
    assert.ok(pathsOf('lantern').has('POST /ingest/client'), 'the RUM sink is still served')
    assert.ok(
      !INGEST_PATHS.some((entry) => entry.includes('/ingest/client')),
      'the browser sink is not an event inbox and must not be offered as one',
    )
  })
})

describe('the process has exactly ONE fallback, and it is lantern’s', () => {
  /*
   * `mountRoutes` takes the FIRST fallback in the flat table and matches none of them by path, so a
   * second one is silently dead — the same hazard as a shadowed route, one level up, and invisible
   * for the same reason: the module that owns it still passes every one of its own tests, because
   * in its own process there is nothing in front of it.
   *
   * lantern's is the one that matters: an unknown `/ingest/*` from an allowlisted browser origin is
   * answered with CORS headers, which is what turns `net::ERR_FAILED` — indistinguishable from the
   * host being down — into a readable 404 naming the paths that do exist. Every frontend in the
   * estate posted to `/ingest/browser` for months and nobody could see it failing.
   */
  it('one module declares one, and it is lantern', () => {
    const declared = TABLES.flatMap(([name, entries]) =>
      entries.filter((e) => e.fallback).map(() => name),
    )
    assert.deepEqual(declared, ['lantern'], 'a second fallback would be dead on arrival')
  })

  it('and it answers the same bare 404 the kernel does, so the other fifteen are unchanged', () => {
    // Read from the source, because the alternative is booting sixteen modules to observe one
    // string. The last line of lantern's `unmatched` must be the kernel's own 404 — if it drifts,
    // mounting it changes what a mistyped path in market or billing answers with.
    const kernel = readFileSync(new URL('./kernel.ts', import.meta.url), 'utf8')
    const routes = readFileSync(new URL('./lantern/routes.ts', import.meta.url), 'utf8')
    const miss = /errorReply\(404, 'not_found', `no route for \$\{ctx\.req\.method\} \$\{ctx\.url\.pathname\}`, ctx\.requestId\)/
    assert.match(kernel, miss, "the kernel's own bare 404 must still be this shape")
    assert.match(routes, miss, "lantern's fallback must end in exactly the kernel's 404")
  })
})
