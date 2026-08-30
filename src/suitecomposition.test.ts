/**
 * The test suite's own composition: what runs, in what order, and against which database.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THREE PROPERTIES OF THE SUITE ITSELF, AND ALL THREE FAIL SILENTLY WHEN THEY BREAK.**
 *
 * This repository is now sixteen modules with sixteen databases and roughly three thousand cases,
 * and the suite that runs them has acquired three failure modes that no case can report, because in
 * each of them the case does not run, or runs against the wrong rows, and the build is GREEN:
 *
 *   1. **A module's suites are never loaded.** `node --test` does not recurse: it runs the files
 *      the command line names. Every module's glob is written out in `package.json`, and a module
 *      whose glob is missing simply does not run — and `skipped 0` does not say so, because
 *      node:test does not count cases inside a `describe` it never entered. Wave M5c makes this
 *      sharper than it has ever been: it introduces the first TWO-LEVEL nesting
 *      (`src/activity/notify/`, `src/lantern/analytics/`), and a glob shape that covered every
 *      module before it — `src/<module>/*.test.ts` — covers neither.
 *
 *   2. **The files stop being serialised.** `--test-concurrency=1` is not caution. Every
 *      database-backed file in this repository truncates its module's tables between cases, a
 *      TRUNCATE takes an AccessExclusiveLock, and two files resetting at once deadlock (40P01)
 *      against each other's locks in whatever order postgres grants them. The failure is
 *      intermittent, it names a table rather than a test, and it reads exactly like a flake in the
 *      code under test. Removing the flag is a one-character edit that no other test would notice.
 *
 *   3. **Two modules point at one database.** Sixteen schemas own a table called `jobs` and fifteen
 *      own an `inbox`; if two harnesses read one DSN, one module's reset empties another module's
 *      rows mid-file. `migratortargets.ts` refuses that at MIGRATE time and `migratortargets.test.ts`
 *      measures the overlap that makes it dangerous — this is the same claim for the TEST harnesses,
 *      which the migrator never sees.
 *
 * All three are read from source rather than observed at runtime, because each is an OMISSION and
 * an omission has no behaviour to test. The vacuous-green guards at the end are what stop this file
 * passing because it found nothing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const SRC = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../', import.meta.url))

const manifest = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as {
  scripts: Record<string, string>
}
const TEST_SCRIPT = manifest.scripts['test'] ?? ''

/** Every directory under `src/` that actually holds test files, as a `src/`-relative prefix. */
function directoriesWithTests(): readonly string[] {
  const found: string[] = []
  const walk = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true })
    if (entries.some((e) => e.isFile() && e.name.endsWith('.test.ts'))) found.push(prefix)
    for (const entry of entries) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`, `${prefix}${entry.name}/`)
    }
  }
  walk(SRC, '')
  return found.sort()
}

/** Every test file, as a `src/`-relative path. */
function testFiles(): readonly string[] {
  const found: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`, `${prefix}${entry.name}/`)
      else if (entry.name.endsWith('.test.ts')) found.push(`${prefix}${entry.name}`)
    }
  }
  walk(SRC, '')
  return found.sort()
}

/** The globs the script names, as `src/`-relative directory prefixes. */
function globbedDirectories(): readonly string[] {
  return [...TEST_SCRIPT.matchAll(/src\/((?:[\w.-]+\/)*)\*\.test\.ts/g)].map((m) => m[1] ?? '')
}

describe('every module’s suites are actually named, because node:test does not recurse', () => {
  it('names a glob for every directory that holds tests', () => {
    const globbed = new Set(globbedDirectories())
    const missing = directoriesWithTests().filter((dir) => !globbed.has(dir))
    assert.deepEqual(
      missing,
      [],
      'these directories hold test files that `pnpm test` never loads. Their cases do not run, ' +
        '`skipped 0` does not say so — node:test cannot count cases in a describe it never entered ' +
        '— and the build is green on nothing:\n  ' +
        missing.map((d) => `src/${d}*.test.ts`).join('\n  '),
    )
  })

  it('and names no glob that matches nothing, which is how a rename goes unnoticed', () => {
    const real = new Set(directoriesWithTests())
    const dead = globbedDirectories().filter((dir) => !real.has(dir))
    assert.deepEqual(
      dead,
      [],
      `the script names a directory that holds no tests: ${dead.join(', ')}. Either it was renamed ` +
        'and its suites are now unreferenced, or the glob is a leftover — both read as green.',
    )
  })

  it('and every test file is matched exactly once, so nothing runs twice', () => {
    // A file matched by two globs is RUN twice, against one database, with two truncating resets
    // interleaved — which is the deadlock in property 2 arriving from inside a single-threaded run.
    const globbed = globbedDirectories()
    for (const file of testFiles()) {
      const dir = file.slice(0, file.lastIndexOf('/') + 1)
      const matches = globbed.filter((g) => g === dir).length
      assert.equal(matches, 1, `src/${file} is matched by ${matches} globs; it must be exactly one`)
    }
  })

  it('and the nested modules are covered, which is the shape M5c introduced', () => {
    // Named explicitly rather than left to the walk, because these two are the whole reason this
    // file exists: they are two levels deep, and every glob shape that worked for the first twelve
    // modules misses them.
    const globbed = new Set(globbedDirectories())
    for (const nested of ['activity/notify/', 'lantern/analytics/']) {
      assert.ok(globbed.has(nested), `src/${nested}*.test.ts is not in the test script`)
    }
  })
})

describe('the files are serialised, and that is load-bearing', () => {
  it('the test script still passes --test-concurrency=1', () => {
    assert.match(
      TEST_SCRIPT,
      /--test-concurrency=1\b/,
      'without it node:test runs FILES in parallel. Every database-backed file here truncates its ' +
        "module's tables between cases; a TRUNCATE takes an AccessExclusiveLock, and two files " +
        'resetting at once deadlock (40P01). It is intermittent, it names a table rather than a ' +
        'test, and it reads as a flake in the code under test.',
    )
  })

  it('and the reasoning is written down beside it, not only here', () => {
    // `_test` is a documentation key in package.json. A flag with no reason recorded next to it is
    // a flag somebody removes to make the suite faster, and they would be right to, not knowing.
    const why = manifest.scripts['_test'] ?? ''
    assert.match(why, /--test-concurrency=1/, 'package.json must record why the flag is there')
    assert.match(why, /TRUNCATE|AccessExclusiveLock|40P01/, 'the reason must name the actual failure')
  })
})

describe('no two modules’ harnesses can point at one database', () => {
  /**
   * Every `testsupport.ts` and the `_TEST_DATABASE_URL` variable it reads.
   *
   * Read from source rather than imported: importing sixteen harnesses would open nothing, but it
   * would also mean this check could only see the modules whose harness happened to load.
   */
  function harnesses(): ReadonlyArray<readonly [string, string]> {
    const out: Array<readonly [string, string]> = []
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(`${dir}${entry.name}/`, `${prefix}${entry.name}/`)
          continue
        }
        if (entry.name !== 'testsupport.ts') continue
        const source = readFileSync(`${dir}${entry.name}`, 'utf8')
        const named = [...source.matchAll(/'([A-Z][A-Z0-9_]*_TEST_DATABASE_URL)'/g)].map((m) => m[1]!)
        assert.ok(named.length > 0, `${prefix}testsupport.ts names no test DSN variable`)
        assert.equal(
          new Set(named).size,
          1,
          `${prefix}testsupport.ts names more than one test DSN variable: ${named.join(', ')}`,
        )
        out.push([`${prefix}testsupport.ts`, named[0]!] as const)
      }
    }
    walk(SRC, '')
    return out.sort((a, b) => a[0].localeCompare(b[0]))
  }

  it('sixteen harnesses, sixteen different variables', () => {
    const found = harnesses()
    const vars = found.map(([, name]) => name)
    assert.equal(
      new Set(vars).size,
      vars.length,
      'two modules read one test DSN variable, so one module’s reset truncates the other’s rows ' +
        `mid-file: ${found.map(([file, name]) => `${file} → ${name}`).join(', ')}`,
    )
    // One per module, and the module list is the one `src/index.ts` builds.
    assert.equal(found.length, 16, `expected sixteen harnesses, found ${found.length}`)
  })

  it('and each names the variable its own module owns', () => {
    // A harness reading a NEIGHBOUR's variable is the same fault as sharing one, and it is what a
    // copied file produces. Derived from the path rather than listed, so a new module is covered.
    for (const [file, name] of harnesses()) {
      const at = file.lastIndexOf('/')
      // The host module's own harness is `src/testsupport.ts`, with no directory at all.
      const dir = at === -1 ? '' : file.slice(0, at)
      const owner = (dir === '' ? 'agora' : dir.slice(dir.lastIndexOf('/') + 1)).toUpperCase()
      assert.equal(name, `${owner}_TEST_DATABASE_URL`, `${file} reads ${name}, which is not its own`)
    }
  })

  it('and every one of those variables is declared to CI, or its suites skip in silence', () => {
    // `service-ci.yml` derives `X_TEST_DATABASE_URL` from each name in `database-env-var` and then
    // FAILS the build if a suite it provided a database for reports a skip. A module absent from
    // that list gets no database, skips, and is filed as "a cross-service tier stood down".
    const workflow = readFileSync(`${ROOT}.github/workflows/ci.yml`, 'utf8')
    const declared = new Set(
      [...workflow.matchAll(/\b([A-Z][A-Z0-9_]*)_DATABASE_URL\b/g)].map((m) => `${m[1]!}_TEST_DATABASE_URL`),
    )
    const undeclaredNames = harnesses()
      .map(([, name]) => name)
      .filter((name) => !declared.has(name))
    assert.deepEqual(
      undeclaredNames,
      [],
      `these modules' suites have a harness but no CI database: ${undeclaredNames.join(', ')}`,
    )
  })
})

describe('the detector is looking at real files', () => {
  /*
   * The vacuous-green guards. Every assertion above is "this set is empty", and an empty set is
   * also what a walker that has stopped finding files reports.
   */
  it('finds the test files, in all sixteen modules', () => {
    const files = testFiles()
    assert.ok(files.length > 200, `expected the whole suite, found ${files.length} files`)
    for (const expected of [
      'mergedroutes.test.ts',
      'studio/boot.test.ts',
      'activity/moduleboundary.test.ts',
      'activity/notify/pipeline.test.ts',
      'lantern/privacyboundary.test.ts',
      'lantern/analytics/pseudonym.test.ts',
    ]) {
      assert.ok(files.includes(expected), `src/${expected} is not in the scanned set`)
    }
  })

  it('and reads a test script that actually names globs', () => {
    const globbed = globbedDirectories()
    assert.ok(globbed.length >= 16, `expected a glob per module, found ${globbed.length}`)
    assert.ok(globbed.includes(''), 'the host module’s own suites must be named too')
  })
})
