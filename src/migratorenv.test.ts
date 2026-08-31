/**
 * The migrate Job carries every variable the modules it imports REQUIRE at import.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Wave M5d's first deploy died in wave 30, on a cluster, with:
 *
 *     fatal  service=admin-api  step=env  MARKET_URL is required — admin-api refuses to start
 *
 * A migrator does not call market. It does not call any of admin's peers. But `./migrator.ts`
 * imports `./admin/module.ts` to ask it for `adminMigrationTargets()`, and `./admin/env.ts`
 * VALIDATES THE WHOLE CONFIG AT IMPORT — not the part the caller is about to use. So absorbing a
 * module into this process adds that module's entire required set to a Job whose author is
 * thinking about databases.
 *
 * The failure was loud, named the variable, and applied nothing downstream — the estate was
 * unchanged and the cost was a deploy rather than an outage. That is the machinery working. What
 * it is not is CHEAP: the only place it can be discovered is a cluster with twenty-two databases,
 * fifteen minutes after the image is built. This file moves the discovery to the suite.
 *
 * ── WHAT IT READS, AND WHY THAT SIDE ──────────────────────────────────────────────────────────
 *
 * The RENDERED manifest in the sibling `deploy` checkout, not its compose file. Compose resolves
 * `<<: *common-env` anchors that a regex cannot follow — half this Job's environment arrives that
 * way, `IDENTITY_URL` among it — whereas the rendered Job lists every name flat. `deploy`'s own
 * `check-k8s-render-matches-compose.py` is what keeps the two agreeing, so reading the rendered
 * side is reading compose with the anchors already applied.
 *
 * ── AND WHY IT LIVES HERE RATHER THAN IN `deploy` ─────────────────────────────────────────────
 *
 * The requirement is derived from THIS repository's source — twenty-one `env.ts` files — and the
 * obligation is one manifest's. `micro-org`'s cross-repo workflow runs a reader's own suite
 * whenever a repository it reads changes, and it finds the readers by scanning for exactly the
 * kind of sibling path this file opens. So putting the check here runs it on both sides.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

// TWO levels: `agora/src/migratorenv.test.ts` -> `agora/` -> the directory the checkouts sit in.
const ESTATE = new URL('../../', import.meta.url)
const MANIFEST = new URL('deploy/k8s/estate/mainnet/30-migrate-jobs.yaml', ESTATE)
const estateRootIsReal = existsSync(new URL('runtime/packages/telemetry/package.json', ESTATE))
const deployPresent = existsSync(MANIFEST)

test('the sibling scan is pointed at the directory the siblings are actually in', () => {
  // The guard `activity/notify/catalogue.test.ts` learned the hard way: a wrong relative depth and
  // a missing checkout look identical from here, and the skip below would then hide this check
  // for ever while reporting a legitimate-sounding reason.
  assert.ok(
    estateRootIsReal,
    `${ESTATE.pathname} does not contain runtime/packages/telemetry, so it is not the directory ` +
      'the sibling checkouts are in. This file has moved and the depth above is stale.',
  )
})

/** Comments stripped, because `market/env.ts` writes `required(…)` inside prose about it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * Every module `./migrator.ts` imports, including the nested ones it reaches through them.
 *
 * Derived rather than listed: `emberkinMigrationTargets()` returns three titles' targets from one
 * call and `activityMigrationTargets()` two, so a hand-written list would be missing the modules
 * whose env is hardest to remember. hub is correctly absent — it declares no migration targets, so
 * the migrator never imports it and needs none of its eight upstream URLs.
 */
function importedModules(): readonly string[] {
  const found = new Set<string>()
  const queue: string[] = []
  const push = (dir: string, source: string): void => {
    for (const match of source.matchAll(/from '\.\/([a-z]+)\/module\.ts'/g)) {
      const child = dir === '' ? (match[1] as string) : `${dir}/${match[1] as string}`
      if (!found.has(child)) {
        found.add(child)
        queue.push(child)
      }
    }
  }
  push('', readFileSync(new URL('./migrator.ts', import.meta.url), 'utf8'))
  while (queue.length > 0) {
    const dir = queue.pop() as string
    const module = new URL(`./${dir}/module.ts`, import.meta.url)
    if (existsSync(module)) push(dir, readFileSync(module, 'utf8'))
  }
  return [...found].sort()
}

/**
 * The variable names one module's `env.ts` refuses to start without.
 *
 * THIS THROWS ON ANYTHING IT CANNOT CLASSIFY, and that is the load-bearing part. A scraper that
 * silently skipped a call shape it did not recognise would report a module as needing nothing —
 * which is indistinguishable from a module that is fully wired, and is the exact failure this
 * whole file exists to prevent. Three shapes are legal:
 *
 *   `required(source, 'NAME')`   the call sites
 *   `required(source, NAME)`     one of them, where the name is a local constant (analytics)
 *   `required(source, name)`     a helper calling the base helper
 *
 * plus the `function required…(` definitions themselves.
 */
function requiredNames(dir: string): readonly string[] {
  const text = code(readFileSync(new URL(`./${dir}/env.ts`, import.meta.url), 'utf8'))
  const names = new Set<string>()
  for (const call of text.matchAll(/(function\s+)?required[A-Za-z]*\(/g)) {
    if (call[1]) continue
    const tail = text.slice(call.index + call[0].length, call.index + call[0].length + 80)
    const literal = /^\s*source\s*,\s*'([A-Z][A-Z0-9_]*)'/.exec(tail)
    if (literal) {
      names.add(literal[1] as string)
      continue
    }
    if (/^\s*source\s*,\s*name\s*[,)]/.test(tail)) continue
    const identifier = /^\s*source\s*,\s*([A-Z][A-Z0-9_]*)\s*[,)]/.exec(tail)
    const constant = identifier
      ? new RegExp(`const ${identifier[1] as string}\\s*=\\s*'([^']+)'`).exec(text)
      : null
    if (constant) {
      names.add(constant[1] as string)
      continue
    }
    throw new Error(`${dir}/env.ts: a required*() call this scraper cannot read: ${tail.slice(0, 60)}`)
  }
  return [...names].sort()
}

/**
 * Names the Job gets from a mounted secret file rather than an `env:` entry, and which file.
 *
 * `envFrom` lists three Secrets and Kubernetes does not say what is in them, so this is the one
 * place a literal list is unavoidable. It is CHECKED rather than trusted: the case below asserts
 * the Job still mounts each named Secret, so an entry that stops being provided fails here instead
 * of on a cluster.
 */
const FROM_A_MOUNTED_SECRET: Readonly<Record<string, string>> = {
  OUTBOX_SIGNING_SECRET: 'secret-outbox',
  INBOUND_SIGNING_SECRET: 'secret-outbox',
  ACTIVITY_INGEST_SECRETS: 'secret-outbox',
  COMMUNITY_INGEST_SECRETS: 'secret-outbox',
  DEVPLATFORM_INGEST_SECRETS: 'secret-outbox',
  ANALYTICS_DELIVERY_SECRETS: 'secret-outbox',
  ANALYTICS_PSEUDONYM_KEY: 'secret-analytics-pepper',
}

function migrateJob(): { env: ReadonlySet<string>; secrets: ReadonlySet<string> } {
  const documents = readFileSync(MANIFEST, 'utf8').split('\n---\n')
  const job = documents.find((d) => /^ {2}name: agora-migrate/m.test(d))
  assert.ok(job, `no agora-migrate document in ${MANIFEST.pathname} — the Job was renamed or the render is stale`)
  return {
    env: new Set([...job.matchAll(/- name: ([A-Z][A-Z0-9_]+)/g)].map((m) => m[1] as string)),
    secrets: new Set([...job.matchAll(/secretRef:\n\s+name: (\S+)/g)].map((m) => m[1] as string)),
  }
}

test('the scraper reads the modules the migrator really imports', () => {
  const modules = importedModules()
  // A floor, not an equality: the point is that a scan finding two modules cannot pass as clean.
  assert.ok(modules.length >= 20, `only ${modules.length} module(s) scraped: ${modules.join(', ')}`)
  assert.ok(modules.includes('emberkin/nda'), 'the nested titles must be reached through emberkin')
  assert.ok(modules.includes('lantern/analytics'), 'and analytics through lantern')
  assert.ok(
    !modules.includes('hub'),
    'hub declares no migration targets and must not be imported here — if it now is, its eight ' +
      'upstream URLs have just become this Job’s problem too',
  )
  for (const dir of modules) {
    assert.ok(requiredNames(dir).length > 0, `${dir}/env.ts requires nothing at all — the scraper missed it`)
  }
})

test(
  'every variable an imported module requires is on the rendered migrate Job',
  {
    // A REAL skip, reported as skipped: this repository's own CI checks it out alone.
    skip: deployPresent ? false : 'micro-deploy is not checked out beside this repository',
  },
  () => {
    const job = migrateJob()
    assert.ok(job.env.size > 60, `only ${job.env.size} env names parsed out of the Job — the shape changed`)

    const missing: string[] = []
    for (const dir of importedModules()) {
      for (const name of requiredNames(dir)) {
        if (job.env.has(name)) continue
        const secret = FROM_A_MOUNTED_SECRET[name]
        if (secret && job.secrets.has(secret)) continue
        missing.push(
          `${name} — required by ${dir}/env.ts, absent from the agora-migrate Job` +
            (secret ? ` and its declared Secret ${secret} is no longer mounted` : ''),
        )
      }
    }
    assert.deepEqual(
      missing,
      [],
      'the migrate Job would exit 1 at import, before touching a schema:\n  ' + missing.join('\n  '),
    )
  },
)

test(
  'the mounted-secret allowance is not a way to pass',
  { skip: deployPresent ? false : 'micro-deploy is not checked out beside this repository' },
  () => {
    const job = migrateJob()
    // Each declared Secret is really mounted…
    for (const [name, secret] of Object.entries(FROM_A_MOUNTED_SECRET)) {
      assert.ok(job.secrets.has(secret), `${name} is excused via ${secret}, which the Job does not mount`)
    }
    // …and each excused name is really required by something, so the list cannot rot into a
    // blanket exemption that quietly covers a variable nobody needs any more.
    const required = new Set(importedModules().flatMap((dir) => requiredNames(dir)))
    for (const name of Object.keys(FROM_A_MOUNTED_SECRET)) {
      assert.ok(required.has(name), `${name} is excused here but no module requires it — a stale entry`)
    }
  },
)
