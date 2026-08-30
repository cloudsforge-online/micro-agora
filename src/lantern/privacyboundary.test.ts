/**
 * The pseudonymisation pepper is reachable from the analytics module and from nowhere else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THIS FILE EXISTS, AND WHY IT READS SOURCE.**
 *
 * Wave M1b put two services in one process. `deploy/docs/service-merge-plan.md` promises that the
 * privacy boundary "survives as a module boundary instead of a process boundary", and that promise
 * is the whole licence for the merge: `ANALYTICS_PSEUDONYM_KEY` is the one secret in this estate
 * whose disclosure is not "an attacker can act as us" but "the pseudonymisation was never real".
 * With it and a candidate user id, anyone can compute a lookup key and learn whether that person is
 * in the store, and while their salt exists, recover their behavioural history.
 *
 * A process boundary enforced that for free. A module boundary does not — one heap, one import
 * graph, and one careless `deps` spread away from a lantern handler closing over a `PepperRing`.
 *
 * **The defect this guards is an OMISSION, and an omission has no behaviour to test.** Nothing
 * observable changes the day somebody adds `peppers` to lantern's `ServerDeps`: every test still
 * passes, every route still answers, and the boundary is simply gone. So this asserts the SHAPE of
 * the source — the same reasoning `routeidempotency.test.ts` records for the same class of
 * failure, and the same reasoning that made `network.test.ts` a source assertion.
 *
 * **It is written so it cannot pass by finding nothing.** The `the detector is looking at real
 * code` block is the counterpart to `routeidempotency.test.ts`'s vacuous-green case: a scanner
 * pointed at a moved file, or a regex that stopped matching, would otherwise report an empty set
 * as a clean one — which is exactly what happened to that file during wave M1a.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { createRoutes, type ServerDeps } from './routes.ts'

const SRC = fileURLToPath(new URL('.', import.meta.url))

/** Source with comments blanked. Prose that NAMES the pepper must not fail its own guard. */
function code(path: string): string {
  return readFileSync(`${SRC}${path}`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** Every lantern-side source file: `src/*.ts`, tests excluded. `src/analytics/**` is NOT one. */
function lanternSideFiles(): readonly string[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
}

/**
 * Anything whose presence in lantern-side code would mean the pepper had crossed the boundary.
 *
 * Names rather than values, obviously — this file never holds a secret.
 *
 * **IDENTIFIERS, NOT ENGLISH.** The first version of this list held the bare word `pseudonym`, and
 * it fired on `lantern/src/migrations.ts` — which says, in a SQL comment inside a migration, that a
 * RUM session id is "a pseudonymous per-tab identifier". That is lantern correctly describing its
 * own privacy property, and a guard that fails a service for documenting one is a guard somebody
 * deletes. (`--` comments inside a template literal survive the comment stripper above, and should:
 * blanking them would blank migration DDL.) Every entry below is a spelling that exists only as an
 * identifier in the analytics module, and `the words it looks for` pins that each is still real.
 *
 * `minCohort` is here for a different reason and a real one: the k-anonymity floor is the OTHER
 * half of the guarantee the plan names, and a lantern handler that could read it could also serve
 * an aggregate below it.
 */
const ANALYTICS_ONLY = [
  'PepperRing',
  'peppers',
  'pseudonymKey',
  'pseudonymVersion',
  'PSEUDONYM_KEY',
  'minCohort',
  'deliverySecrets',
]

/** The only file under `src/analytics/` a lantern-side file may import. */
const THE_SEAM = './analytics/module.ts'

/**
 * EVERY source file agora compiles — all sixteen modules — with comments blanked.
 *
 * Wave M5c. `lanternSideFiles()` covers this module's own directory, which was the whole
 * lantern-side of a two-module process. The pepper now sits in a process with fourteen more
 * modules, and the promise the merge plan makes is about the process.
 *
 * Paths are returned relative to `src/`, so a failure names the file the way an import would.
 */
function monolithSources(): ReadonlyArray<readonly [string, string]> {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const out: Array<readonly [string, string]> = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${dir}${entry.name}`
      if (entry.isDirectory()) {
        walk(`${path}/`, `${prefix}${entry.name}/`)
        continue
      }
      // Tests excluded, for the reason the estate's own Rule 1 scan excludes them: a test is where
      // a module legitimately names another's identifier in order to prove it cannot reach it.
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      out.push([
        `${prefix}${entry.name}`,
        readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, ''),
      ] as const)
    }
  }
  walk(root, '')
  return out
}

describe('the pepper cannot be reached from lantern-side code', () => {
  it('no lantern-side file imports past the module seam', () => {
    const offenders: string[] = []
    for (const file of lanternSideFiles()) {
      for (const match of code(file).matchAll(/from\s+'(\.\/analytics\/[^']+)'/g)) {
        if (match[1] !== THE_SEAM) offenders.push(`${file} imports ${match[1]}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `${THE_SEAM} is the only door into the analytics module, and it hands back four things none ` +
        'of which names a secret. An import past it is a lantern-side file that can now construct ' +
        `a PepperRing:\n  ${offenders.join('\n  ')}`,
    )
  })

  it('no lantern-side file so much as names the pepper in code', () => {
    const offenders: string[] = []
    for (const file of lanternSideFiles()) {
      const source = code(file)
      for (const name of ANALYTICS_ONLY) {
        if (source.includes(name)) offenders.push(`${file} names ${name}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a lantern-side file names something only the analytics module may see. What a handler ' +
        'cannot name it cannot pass to a logger, a metric label or an error body by accident — ' +
        `and that is the entire mechanism:\n  ${offenders.join('\n  ')}`,
    )
  })

  it("lantern's ServerDeps declares no field that could carry one", () => {
    // The type is the contract every lantern handler closes over. A field here is reachable from
    // every one of them at once, which is why this is the exact line to guard.
    const source = code('routes.ts')
    const at = source.indexOf('export interface ServerDeps')
    assert.notEqual(at, -1, 'ServerDeps must be declared in routes.ts — this guard reads it there')
    const body = source.slice(at, source.indexOf('\n}', at))
    for (const name of ANALYTICS_ONLY) {
      assert.ok(!body.includes(name), `ServerDeps declares ${name}; the pepper is now in scope for every lantern route`)
    }
    assert.ok(!/\bingest\b/.test(body), "ServerDeps declares an `ingest` bag — analytics' IngestDeps is what holds the peppers")
  })

  it('the module seam hands back nothing that names a secret', () => {
    const source = code('analytics/module.ts')
    const at = source.indexOf('export interface AnalyticsModule')
    assert.notEqual(at, -1, 'AnalyticsModule must be declared in analytics/module.ts')
    const body = source.slice(at, source.indexOf('\n}', at))
    const fields = [...body.matchAll(/^\s+(?:readonly\s+)?([A-Za-z][\w]*)[?]?[(:]/gm)].map((m) => m[1])
    assert.deepEqual(
      [...fields].sort(),
      ['beforeScrape', 'probe', 'routes', 'schemaVersion', 'start', 'stop'],
      'the seam returns exactly what the host process needs and nothing else. A field added here is ' +
        'a value the host can then hand anywhere, which is how a scope boundary becomes a convention.',
    )
    for (const field of fields) {
      assert.doesNotMatch(
        field ?? '',
        /pepper|pseudonym|secret|token|key/i,
        `AnalyticsModule.${field} reads like a credential; the host must never be handed one`,
      )
    }
  })

  /*
   * ── WAVE M5c WIDENED THIS FROM ONE DIRECTORY TO SIXTEEN MODULES ────────────────────────────────
   *
   * Everything above scans `src/lantern/*.ts` — which was the whole lantern-side of the process when
   * this file was written. It is now one sixteenth of agora's, and the pepper's guarantee is a claim
   * about the PROCESS: one heap, one import graph, and fifteen other modules' handlers that must
   * also be unable to name a `PepperRing`.
   *
   * Without this case, a market or billing handler could take `peppers` in its deps bag and every
   * assertion above would still be green, because the offending file is not in this directory. That
   * is the same vacuous-green failure the block below exists for, one level up.
   *
   * The pepper is the one secret here with NO remediation: rotating it orphans every subject key
   * derived under it, so history cannot be re-derived. Prevention is the whole control.
   */
  it('and no OTHER module in this process names the pepper either', () => {
    const offenders: string[] = []
    for (const [name, source] of monolithSources()) {
      if (name.startsWith('lantern/analytics/')) continue
      for (const term of ANALYTICS_ONLY) {
        if (source.includes(term)) offenders.push(`${name} names ${term}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'a module outside src/lantern/analytics/ names something only the analytics module may see. ' +
        'What a handler cannot name it cannot pass to a logger, a metric label or an error body by ' +
        `accident — and that is the entire mechanism:\n  ${offenders.join('\n  ')}`,
    )
  })

  it('and the widened scan is looking at the whole process, not at this directory again', () => {
    // The vacuous guard on the case above: an empty offender list is also what a walker that found
    // nothing reports. These are files it must have reached, in three different modules.
    const names = monolithSources().map(([name]) => name)
    assert.ok(names.length > 200, `expected the whole monolith's sources, found ${names.length}`)
    for (const expected of ['index.ts', 'migrator.ts', 'lantern/module.ts', 'market/server.ts', 'activity/notify/env.ts']) {
      assert.ok(names.includes(expected), `${expected} is not in the scanned set — the walk has lost the source`)
    }
    // And it can still see the other side of the boundary, or "nothing outside names it" would be
    // true because the scanner cannot see anything at all.
    const analytics = monolithSources().filter(([name]) => name.startsWith('lantern/analytics/'))
    assert.ok(analytics.length >= 12, `expected the analytics module's sources, found ${analytics.length}`)
    assert.ok(
      analytics.some(([, source]) => source.includes('PepperRing')),
      'the walk must be able to see a PepperRing where one legitimately is',
    )
  })

  it('every lantern route handler takes only ctx, so there is no deps parameter to reach through', () => {
    // Wave M1a's seam, asserted rather than assumed. `handle(ctx, deps)` is what would put the
    // WHOLE process's dependency record in every handler's signature the moment a second module is
    // mounted beside these — see kernel.ts's note on RouteSpec.
    const specs = createRoutes(DEPS)
    assert.ok(specs.length > 5, `expected lantern to declare many routes, found ${specs.length}`)
    for (const spec of specs) {
      assert.equal(
        spec.handle.length,
        1,
        `${spec.method} ${spec.path} takes ${spec.handle.length} parameters; a handler takes only ctx`,
      )
    }
  })
})

describe('the detector is looking at real code', () => {
  /*
   * The vacuous-green guards. Every assertion above is of the form "this set is empty", and an
   * empty set is also what a scanner that has stopped finding files reports. These are the cases
   * that fail when that happens — `routeidempotency.test.ts` records what it cost to learn that.
   */
  it('sees the lantern-side files', () => {
    const files = lanternSideFiles()
    assert.ok(files.length >= 8, `expected many lantern-side sources, found ${files.length}`)
    // `kernel.ts` and `migrator.ts` are deliberately NOT here since wave M5c: this module lives in
    // agora's process now, and a module in somebody else's process has neither a request lifecycle
    // of its own nor an entry-point script. `module.ts` is the seam that replaced `index.ts`.
    for (const expected of ['module.ts', 'routes.ts', 'server.ts', 'env.ts', 'jobs.ts']) {
      assert.ok(files.includes(expected), `${expected} is not in the scanned set — the scan has lost the source`)
    }
    for (const gone of ['index.ts', 'migrator.ts', 'kernel.ts']) {
      assert.ok(
        !files.includes(gone),
        `${gone} is a second entry point (or a second request lifecycle) in a merged process — its ` +
          'work belongs to agora’s src/index.ts, src/migrator.ts and src/kernel.ts',
      )
    }
  })

  it('sees the merged composition root, and it is the merged one', () => {
    // `module.ts` since wave M5c. Still the file that mounts both route tables and builds the
    // analytics module — it hands the result up to agora rather than to a listener of its own.
    const source = code('module.ts')
    assert.match(source, /mountableRoutes\(/, 'module.ts must contribute lantern’s own route table')
    assert.match(source, /\.\.\.analytics\.routes/, 'module.ts must mount the analytics table beside it')
    assert.match(source, /createAnalyticsModule\(/, 'module.ts must build the analytics module')
  })

  it('finds a real pepper on the other side of the boundary', () => {
    // Without this, every assertion above would still pass on the day somebody deleted the pepper
    // ring entirely — a boundary around nothing.
    const module = code('analytics/module.ts')
    assert.match(module, /new PepperRing\(/, 'the module seam is where the pepper ring is constructed')
    assert.match(module, /from '\.\/env\.ts'/, "the module seam is where analytics' env is imported")
  })

  it('the words it looks for are the words the pepper is spelled with', () => {
    // A guard whose vocabulary drifts away from the thing it guards is a guard that passes. Every
    // term must still be a real identifier ON THE ANALYTICS SIDE — a spelling nothing uses any more
    // forbids nothing, and silently shrinks this file to a list of dead strings.
    const analyticsSide = readdirSync(`${SRC}analytics`)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => code(`analytics/${name}`))
      .join('\n')
    for (const term of ANALYTICS_ONLY) {
      assert.ok(
        analyticsSide.includes(term),
        `'${term}' appears nowhere in the analytics module any more — this guard forbids a spelling ` +
          'that no longer exists, which is a guard that cannot fire. Update it to what the pepper ' +
          'is called now.',
      )
    }
    assert.match(code('analytics/pseudonym.ts'), /class PepperRing/, 'PepperRing must still be the type this guards')
    assert.ok(ANALYTICS_ONLY.includes('minCohort'), 'the k-anonymity floor is the other half of the promise')
  })
})

/* ------------------------------------------------------------------ fixtures */

/**
 * A lantern `ServerDeps` good enough to build the route table. Nothing here is called: `createRoutes`
 * only closes over it, which is precisely the property under test.
 */
const DEPS = {
  lifecycle: {},
  logger: {},
  metrics: {},
  verifier: {},
  sql: {},
  token: '',
  limits: {},
  rumOrigins: [],
  rumQuota: {},
  traceUrlTemplate: '',
} as unknown as ServerDeps
