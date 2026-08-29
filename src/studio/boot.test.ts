/**
 * Boot, driven by booting.
 *
 * Every other test in this repository constructs the pieces `src/index.ts` constructs and asserts
 * something about them. That is the right way to test the pieces and it proves nothing at all
 * about the composition root, which is the one file no unit test imports: it has no exports, it
 * calls `process.exit`, and it is the only place the ORDER of the twelve construction steps is
 * expressed. So this file runs it, as a process, and reads what it did.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY BOOT ASSERTS THE ASSET ROOT AT ALL, GIVEN THERE IS A READINESS PROBE FOR IT.**
 *
 * Because the probe answers a question nobody asks until the balancer asks it. A replica with an
 * unwritable root and no boot check starts, binds, reports `starting`, and is a running container
 * in the deploy's view — and the deploy's view is what a rollout waits on. Refusing to start is
 * what makes the rollout stop, the same argument the schema assertion above it makes in its own
 * comment. The probe is for the root that was fine at boot and is not fine now; the two cover
 * different halves and neither replaces the other.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Needs a database, for the same reason the service does: `index.ts` asserts the schema version
 * before it reaches the asset root, so without one every case here would pass for the wrong
 * reason — which is exactly the failure mode this estate has been finding all day.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import type postgres from 'postgres'
import { migrateTestDb, openDb } from './testsupport.ts'
// The other four modules' harnesses. Each opens ITS OWN database from ITS OWN `_TEST_` variable
// and applies ITS OWN migrations; nothing here ever holds two modules' handles at once.
import { migrateTestDb as migrateAgoraDb, openDb as openAgoraDb } from '../testsupport.ts'
import {
  migrateTestDb as migrateDevplatformDb,
  openDb as openDevplatformDb,
} from '../devplatform/testsupport.ts'
import { migrateTestDb as migratePolicyDb, openDb as openPolicyDb } from '../policy/testsupport.ts'
import { migrateTestDb as migratePricingDb, openDb as openPricingDb } from '../pricing/testsupport.ts'
// Wave M5b's seven. Same shape: each opens its OWN database from its OWN `_TEST_`
// variable and applies its OWN migrations — the merged boot asserts all twelve.
import { migrateTestDb as migrateCommunityDb, openDb as openCommunityDb } from '../community/testsupport.ts'
import { migrateTestDb as migrateMarketDb, openDb as openMarketDb } from '../market/testsupport.ts'
import { migrateTestDb as migrateBillingDb, openDb as openBillingDb } from '../billing/testsupport.ts'
import { migrateTestDb as migrateMintDb, openDb as openMintDb } from '../mint/testsupport.ts'
import { migrateTestDb as migrateForesightDb, openDb as openForesightDb } from '../foresight/testsupport.ts'
import { migrateTestDb as migrateWorldsDb, openDb as openWorldsDb } from '../worlds/testsupport.ts'
import { migrateTestDb as migrateTesseraDb, openDb as openTesseraDb } from '../tessera/testsupport.ts'

/*
 * ── WAVE M5a: THIS BOOTS THE MERGED PROCESS, NOT THIS MODULE ──────────────────────────────────
 *
 * micro-deploy `docs/service-merge-plan.md`. There is no `index.ts` in this directory any more:
 * this service's composition root became `./module.ts`, and the process that runs it is
 * `../index.ts`, which builds twelve modules on one listener.
 *
 * REPOINTED RATHER THAN DROPPED, and it is a stronger test than it was. What it exists to prove is
 * that the asset-root check and probe are WIRED — `server.test.ts` proves the probe works when it
 * is handed to a Lifecycle, and cannot prove anybody hands it one. In the merged process that
 * wiring passes through two more hands (`createStudioModule` returns a probe LIST, `../index.ts`
 * registers it in a loop), so there is strictly more to lose and this is still the only thing
 * watching it.
 *
 * It also became the only test anywhere that boots all twelve modules against twelve real databases,
 * which is why it now needs all twelve DSNs — see `skip` below.
 */
const here = dirname(fileURLToPath(import.meta.url))
const entrypoint = join(here, '..', 'index.ts')

/**
 * Every database the merged process asserts at boot, and the gate on this file.
 *
 * `../index.ts` calls `assertSchemaAtLeast` for each module before it listens, so a missing DSN is
 * an `exit(1)` with a message about a schema — the precise shape of a check that graded an early
 * return rather than the thing it named. All twelve or nothing.
 *
 * The names are the `_TEST_` spellings `service-ci.yml` exports, one CI database per declared
 * `database-env-var` entry.
 */
const MERGED_TEST_DSNS = {
  AGORA_DATABASE_URL: 'AGORA_TEST_DATABASE_URL',
  DEVPLATFORM_DATABASE_URL: 'DEVPLATFORM_TEST_DATABASE_URL',
  POLICY_DATABASE_URL: 'POLICY_TEST_DATABASE_URL',
  PRICING_DATABASE_URL: 'PRICING_TEST_DATABASE_URL',
  STUDIO_DATABASE_URL: 'STUDIO_TEST_DATABASE_URL',
  // Wave M5b added the commerce/games tier. `../index.ts` asserts EVERY module's
  // schema before it listens, so this boot must carry all twelve DSNs or the
  // merged process exits 1 on the first missing one — which is why the five
  // studio boot tests fail with only the M5a five here.
  COMMUNITY_DATABASE_URL: 'COMMUNITY_TEST_DATABASE_URL',
  MARKET_DATABASE_URL: 'MARKET_TEST_DATABASE_URL',
  BILLING_DATABASE_URL: 'BILLING_TEST_DATABASE_URL',
  MINT_DATABASE_URL: 'MINT_TEST_DATABASE_URL',
  FORESIGHT_DATABASE_URL: 'FORESIGHT_TEST_DATABASE_URL',
  WORLDS_DATABASE_URL: 'WORLDS_TEST_DATABASE_URL',
  TESSERA_DATABASE_URL: 'TESSERA_TEST_DATABASE_URL',
} as const

const missingDsn = Object.values(MERGED_TEST_DSNS).filter((name) => {
  const value = process.env[name]
  return !(value && /test/i.test(value))
})

/**
 * This file's own gate, replacing `testsupport.ts`'s single-database one.
 *
 * The reason for the replacement rather than an `&&`: `skip` from `./testsupport.ts` names only
 * `STUDIO_TEST_DATABASE_URL`, and a merged boot that skipped because devplatform's database was
 * absent would report the wrong variable — which is exactly the kind of message that sends
 * somebody to fix a thing that was never broken. It names every missing one.
 *
 * `service-ci.yml`'s skip scan reads this line: a message naming variables THIS job exported is
 * fatal, which is what it must be, because all twelve are declared in `database-env-var`.
 */
const mergedSkip = missingDsn.length === 0 ? false : `set ${missingDsn.join(', ')}`

interface Boot {
  readonly code: number | null
  readonly output: string
  readonly listened: boolean
}

/** The real process, with the smallest environment `src/env.ts` will accept. */
function spawnService(
  env: Record<string, string>,
  onOutput: (all: string, child: ChildProcess) => void = () => {},
): {
  child: ChildProcess
  read: () => string
  closed: Promise<number | null>
} {
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
    env: {
      ...process.env,
      // EVERY module's database, because `../index.ts` asserts every schema before it listens.
      ...Object.fromEntries(
        Object.entries(MERGED_TEST_DSNS).map(([slot, test]) => [slot, process.env[test] ?? '']),
      ),
      IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
      IDENTITY_ISSUER: 'http://127.0.0.1:4001',
      // devplatform REQUIRES its own inbound secret list and refuses to start without one — the
      // one secret in this process that is not the estate-wide key. Generated per run for the same
      // reason as the one below.
      DEVPLATFORM_INGEST_SECRETS: randomBytes(48).toString('base64'),
      // agora reads a POLICY_URL and warns loudly when it is unset. Named at a port nothing is
      // listening on: the boot must not depend on a peer, and nothing here publishes a post.
      POLICY_URL: 'http://127.0.0.1:4101',
      // GENERATED per run. This is the one test that boots the real `src/env.ts` in a real
      // process, so a written fixture here would be a boot the deploy cannot reproduce —
      // the literal that used to sit here reads as a placeholder and is now refused
      // (micro-org #142).
      OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
      LOG_LEVEL: 'info',
      // No Foundry credential: booting must never depend on a spend credential, and a boot test
      // that could spend money is a boot test nobody runs.
      AZURE_FOUNDRY_ENDPOINT: '',
      AZURE_FOUNDRY_API_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // A hung boot must fail the case rather than the whole run. `AbortSignal.timeout` rather than
    // a hand-rolled timer, deliberately — rule 8 is about src/, but the habit is the point.
    signal: AbortSignal.timeout(60_000),
  })

  let output = ''
  const collect = (chunk: Buffer) => {
    output += chunk.toString('utf8')
    onOutput(output, child)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (status) => resolve(status))
  })
  return { child, read: () => output, closed }
}

/**
 * Start the real service and report what happened.
 *
 * Killed the moment it says `listening`, rather than drained: `Lifecycle` holds a SIGTERM for
 * `drainDelayMs` — 5 seconds here, correctly — and waiting that out in four cases would add twenty
 * seconds to the suite to observe a shutdown path `server.test.ts` already covers.
 */
async function boot(env: Record<string, string>): Promise<Boot> {
  await migratedSchema()
  let listened = false
  const { read, closed } = spawnService(env, (all, child) => {
    if (!listened && all.includes('"msg":"listening"')) {
      listened = true
      // SIGKILL, not SIGTERM: this asks for the process to be gone, not drained.
      child.kill('SIGKILL')
    }
  })

  const code = await closed
  return { code, output: read(), listened }
}

/**
 * Start the real service, wait until it is answering, and hand its base URL over.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE CASE NO UNIT TEST CAN COVER, AND THE ONE THE INCIDENT NEEDED.**
 *
 * `server.test.ts` proves `assetRootProbe` makes `/readyz` answer 503. It cannot prove the probe
 * is REGISTERED: delete the `.addProbe(assetRootProbe(env.assetRoot))` line from `index.ts` and
 * every case in that file still passes, because each one hands the probe to the Lifecycle itself.
 * The composition root is exactly where the original defect lived — nothing was wrong with any
 * component, the wiring was simply absent — so it has to be driven, not assembled.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function withRunningService(
  env: Record<string, string>,
  port: number,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  await migratedSchema()
  const { child, read, closed } = spawnService({ ...env, PORT: String(port) })
  try {
    const deadline = Date.now() + 30_000
    while (!read().includes('"msg":"listening"')) {
      if (child.exitCode !== null) throw new Error(`the service exited early:\n${read()}`)
      if (Date.now() > deadline) throw new Error(`the service never listened:\n${read()}`)
      await sleep(50)
    }
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    child.kill('SIGKILL')
    await closed.catch(() => null)
  }
}

/** Poll `/readyz` until it answers `expected`, so the Lifecycle's 1-second cache is not raced. */
async function readyzBecomes(url: string, expected: number): Promise<number> {
  const deadline = Date.now() + 15_000
  let status = 0
  while (Date.now() < deadline) {
    status = (await fetch(`${url}/readyz`)).status
    if (status === expected) return status
    await sleep(100)
  }
  return status
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'studio-boot-'))
  try {
    await fn(dir)
  } finally {
    await chmod(dir, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Bring the schema up, once, on first use.
 *
 * The service asserts SCHEMA_VERSION before it looks at anything else, so a database below it
 * would make every case here exit 1 for a reason that has nothing to do with the asset root — the
 * precise shape of "a check that graded an early return rather than the thing it named". Lazy
 * rather than at module scope, matching `generation.test.ts`: a connection opened while the test
 * runner is still loading files is a connection the runner does not wait for.
 */
let schema: Promise<void> | null = null
function migratedSchema(): Promise<void> {
  return (schema ??= (async () => {
    // FIVE schemas, because the merged process asserts five before it listens. Each module's own
    // `migrateTestDb` runs that module's own `MIGRATIONS` against that module's own DSN — never a
    // shared handle, for the reason `../migratortargets.ts` refuses at runtime: `inbox` and `jobs`
    // exist in all twelve, so one shared database is two `create table inbox` racing and the later
    // modules' tables never created, with a green migrator.
    const modules: ReadonlyArray<readonly [string, () => postgres.Sql, (sql: postgres.Sql) => Promise<void>]> = [
      ['agora', openAgoraDb, migrateAgoraDb],
      ['devplatform', openDevplatformDb, migrateDevplatformDb],
      ['policy', openPolicyDb, migratePolicyDb],
      ['pricing', openPricingDb, migratePricingDb],
      ['studio', openDb, migrateTestDb],
      ['community', openCommunityDb, migrateCommunityDb],
      ['market', openMarketDb, migrateMarketDb],
      ['billing', openBillingDb, migrateBillingDb],
      ['mint', openMintDb, migrateMintDb],
      ['foresight', openForesightDb, migrateForesightDb],
      ['worlds', openWorldsDb, migrateWorldsDb],
      ['tessera', openTesseraDb, migrateTesseraDb],
    ]
    for (const [name, open, migrate] of modules) {
      const sql = open()
      try {
        await migrate(sql)
      } catch (err) {
        throw new Error(`${name}'s schema could not be migrated for the merged boot: ${String(err)}`)
      } finally {
        await sql.end({ timeout: 5 })
      }
    }
  })())
}

test('a writable asset root boots all the way to listening', { skip: mergedSkip }, async () => {
  await withTempDir(async (dir) => {
    const result = await boot({ STUDIO_ASSET_ROOT: join(dir, 'out'), PORT: '45111' })
    assert.equal(result.listened, true, `never reached listen():\n${result.output}`)
    // The root did not exist. `mkdir --recursive` created it, which is the ordinary case for a
    // fresh volume and must not be mistaken for a failure.
    assert.match(result.output, /"msg":"listening"/)
  })
})

test('THE BOOT REFUSAL: an unwritable asset root exits 1 and never listens', { skip: mergedSkip }, async () => {
  // Uid-independent: a path THROUGH a regular file cannot be made a directory by anyone, root
  // included, so this case is real on a laptop and in a container that runs as root.
  await withTempDir(async (dir) => {
    const file = join(dir, 'not-a-directory')
    await writeFile(file, 'x')

    const result = await boot({ STUDIO_ASSET_ROOT: file, PORT: '45112' })
    assert.equal(result.listened, false, 'a service that cannot store an asset must not take traffic')
    assert.equal(result.code, 1)
    assert.match(result.output, /asset root is not writable/)
    assert.match(result.output, /"level":"fatal"/)
  })
})

test('THE INCIDENT AT BOOT: a root owned by somebody else exits 1', { skip: mergedSkip }, async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  if (uid === 0) {
    console.log('skipped as root: chmod cannot make a directory unwritable to uid 0')
    return
  }

  // r-x — the exact state `/app/out` was in: it existed, it was listable, and the uid the image
  // runs as could not write to it. The container reported healthy and /readyz answered 200 for an
  // hour while every generation of every kind failed EACCES.
  await withTempDir(async (dir) => {
    await chmod(dir, 0o500)

    const result = await boot({ STUDIO_ASSET_ROOT: dir, PORT: '45113' })
    assert.equal(result.listened, false)
    assert.equal(result.code, 1)
    // The operator's sentence, not the errno. `chown the mount point` is the actionable half:
    // a fresh named volume is created root:root and the image's last instruction is USER node.
    assert.match(result.output, /not writable by uid/)
    assert.match(result.output, /chown the mount point/)
  })
})

test('THE WIRING: the running service 503s when its root goes unwritable', { skip: mergedSkip }, async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  if (uid === 0) {
    console.log('skipped as root: chmod cannot make a directory unwritable to uid 0')
    return
  }

  await withTempDir(async (dir) => {
    const root = join(dir, 'out')
    await withRunningService({ STUDIO_ASSET_ROOT: root }, 45115, async (url) => {
      // Ready, with no image backend configured — `degraded` on the SOFT probe and still 200,
      // which is the behaviour the asset-root probe must not copy.
      const before = await fetch(`${url}/readyz`)
      assert.equal(before.status, 200)
      const body = (await before.json()) as {
        checks: { name: string; kind: string; state: string; detail?: string }[]
      }
      const root200 = body.checks.find((c) => c.name === 'asset-root')
      assert.ok(root200, 'index.ts must register the asset-root probe — it was not in /readyz')
      assert.equal(root200.kind, 'hard')
      assert.equal(root200.state, 'pass')

      // The incident, reproduced against a live process: the root the service is writing into
      // stops being writable by the uid it runs as.
      await chmod(root, 0o500)

      assert.equal(
        await readyzBecomes(url, 503),
        503,
        'the running service kept answering 200 with an unwritable root — the original defect',
      )
      const after = (await (await fetch(`${url}/readyz`)).json()) as {
        ready: boolean
        checks: { name: string; state: string; detail?: string }[]
      }
      assert.equal(after.ready, false)
      const failed = after.checks.find((c) => c.name === 'asset-root')
      assert.equal(failed?.state, 'fail')
      assert.match(String(failed?.detail), /not writable by uid/)

      // `/livez` stays 200 throughout: the process is alive and must not be restarted. Restarting
      // it would not make a volume writable, and a crash-loop is a worse incident than a 503.
      assert.equal((await fetch(`${url}/livez`)).status, 200)

      // And it recovers without a restart, which is what makes the probe worth having over a
      // boot check alone.
      await chmod(root, 0o700)
      assert.equal(await readyzBecomes(url, 200), 200)
    })
  })
})

test('the boot refusal happens BEFORE the socket exists, not after', { skip: mergedSkip }, async () => {
  // Ordering, asserted rather than assumed. If the check ran after `listen()` the port would be
  // taken for as long as the process lived, and a balancer probing during that window would find
  // a socket that accepts. Binding here proves nothing else did.
  await withTempDir(async (dir) => {
    const file = join(dir, 'not-a-directory')
    await writeFile(file, 'x')

    const { createServer } = await import('node:http')
    const blocker = createServer(() => {})
    await new Promise<void>((resolve) => blocker.listen(45114, '127.0.0.1', () => resolve()))
    try {
      // The port is already taken. A service that got as far as `listen()` would fail on EADDRINUSE
      // and say so; this one must fail on the asset root instead, because it never got there.
      const result = await boot({ STUDIO_ASSET_ROOT: file, PORT: '45114' })
      assert.equal(result.code, 1)
      assert.match(result.output, /asset root is not writable/)
      assert.equal(/EADDRINUSE/.test(result.output), false, 'it reached listen() — the check is too late')
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})
