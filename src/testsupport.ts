/**
 * The database harness, and the fakes.
 *
 * **A database test runs only against a database whose name says it is a test database.**
 *
 * Not a convenience. `resetAgora` truncates every table this service owns, and the "test" check is
 * the difference between a red build and a public square with nothing in it. What is in these
 * tables is not recomputable from anything else in the estate: `posts` is the only copy of what
 * people wrote, `whispers` is the only copy of what they said to each other privately, and `bars`
 * is the only record of who has decided they want nothing to do with whom. Losing that last one is
 * the worst of the three — a ledger entry can be replayed from the outbox, but a bar that vanishes
 * silently reconnects somebody to a person they blocked, and neither of them is told.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE VARIABLE IS `AGORA_TEST_DATABASE_URL`, SPELLED EXACTLY.**
 *
 * The reusable workflow at `cloudsforge-online/micro-org/.github/workflows/service-ci.yml` derives
 * it from the `database-env-var` input by substituting `_DATABASE_URL` → `_TEST_DATABASE_URL`, and
 * then GREPS the test output for a skip — if the database-backed suite skipped, the build FAILS
 * rather than going green on nothing. A different spelling here reads no DSN, skips silently, and
 * turns that guard into the exact false-green it exists to prevent (18-build-status.md §3.3).
 *
 * A skipped suite would be worse here than in most repositories, because almost every rule this
 * service is built around is a DATABASE rule rather than a function: the symmetric bar index, the
 * alt-text CHECK, the one-thread-per-pair unique constraint, the visibility predicate that decides
 * who can read a post. None of them exists in a fake. A green build with this suite skipped would
 * be proving the text normaliser and nothing that keeps anybody safe.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## AND WHY THE SUITE IS SERIAL
 *
 * `package.json` runs the tests with `--test-concurrency=1`, and that is load-bearing rather than
 * cautious. `resetAgora` issues a TRUNCATE, which takes an AccessExclusiveLock on every table it
 * names; two files resetting at once deadlock (40P01) against each other's locks in whatever order
 * postgres happens to grant them. The failure is intermittent, it names a table rather than a
 * test, and it looks exactly like a flake in the code under test.
 */

import postgres from 'postgres'
import { migrate, type Sql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { MIGRATIONS, TABLES } from './migrations.ts'
import { registerServiceMetrics } from './server.ts'
import type { Db, Emit, Tx } from './outbox.ts'
import type { PolicyClient, PolicyVerdict, PostPolicyInput } from './policyclient.ts'
import type { PostDeps } from './posts.ts'
import type { VoiceDeps, Voice } from './voices.ts'
import type { CircleDeps } from './circles.ts'
import type { WhisperDeps } from './whispers.ts'
import type { NotificationDeps } from './notifications.ts'
import type { ModerationDeps } from './moderation.ts'
import { ensureVoice } from './voices.ts'

// Named `TEST_DSN_VAR` rather than spelling `..._DATABASE_URL` in an identifier: the estate's
// Rule 1 CI check greps source for any `*_DATABASE_URL` token that is not this service's own, and a
// constant NAMED after the variable would trip it. The value is the honest spelling.
export const TEST_DSN_VAR = 'AGORA_TEST_DATABASE_URL'

const url = process.env[TEST_DSN_VAR]

export const enabled = Boolean(url && /test/i.test(url))

/** node:test's `{ skip }` option: a string reason disables the suite; `false` runs it. */
export const skip = enabled ? false : `set ${TEST_DSN_VAR} (name must contain "test")`

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/** The `@cloudsforge/db` view of a postgres.js client. */
export const db = (sql: postgres.Sql): Sql => sql as unknown as Sql

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the constraints drift out of the tests that prove they fire — and on this service the
 * constraints ARE the product rules: `bars_symmetric_idx`, `post_media_alt_required`,
 * `whisper_threads_pair_key_uniq` and `voices_handle_lower_uniq` are four lines of DDL that each
 * replace a rule somebody would otherwise have to remember on every read path.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as Sql, MIGRATIONS, { service: 'agora-test' })
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetAgora(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`)
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'agora-test', sink: () => {} })
}

export function testMetrics(): Metrics {
  return registerServiceMetrics(new Metrics())
}

/** Collect emitted events instead of writing them, for the pure-domain tests. */
export function collector(): { emit: Emit; events: Array<Parameters<Emit>[0]> } {
  const events: Array<Parameters<Emit>[0]> = []
  return { emit: (event) => events.push(event), events }
}

/* ------------------------------------------------------------------ the fakes */

export interface FakePolicy extends PolicyClient {
  readonly calls: readonly PostPolicyInput[]
  answer(verdict: PolicyVerdict): void
  failWith(err: Error): void
}

/**
 * Allows by default.
 *
 * `failWith` is what the degraded-gate tests use, and it throws rather than returning
 * `DEGRADED_VERDICT` on purpose: the real `httpPolicyClient` converts an unreachable policy into
 * that verdict itself, so a fake that returned it directly would skip the conversion and prove
 * nothing about what happens when the network is the thing that broke.
 */
export function fakePolicy(): FakePolicy {
  const calls: PostPolicyInput[] = []
  let verdict: PolicyVerdict = { decision: 'allow', reasons: [], degraded: false }
  let failure: Error | null = null
  return {
    calls,
    answer(next) {
      verdict = next
      failure = null
    },
    failWith(err) {
      failure = err
    },
    async evaluatePost(input) {
      calls.push(input)
      if (failure) throw failure
      return verdict
    },
  }
}

/* ------------------------------------------------------------------ dependency bundles */

export const SERVICE = 'agora'

export interface DepsOptions {
  readonly policy?: PolicyClient
  readonly postsPerHour?: number
  readonly postMaxChars?: number
  readonly pageSizeMax?: number
  readonly postingEnabled?: boolean
  readonly whispersPerHour?: number
  readonly followsPerHour?: number
  readonly reportsPerHour?: number
  readonly notificationTtlDays?: number
  readonly publicUrl?: string
}

/**
 * The bundles a test needs, built from one pool.
 *
 * The limits default HIGH — a thousand an hour — because almost no test is about the rate limit,
 * and a test that trips one while proving something else fails with `429` and a message about
 * throttling. The rate-limit tests pass their own small numbers, which is the only place the real
 * production values matter.
 */
export function testDeps(sql: postgres.Sql, options: DepsOptions = {}) {
  const database = sql as unknown as Db
  const posts: PostDeps = {
    sql: database,
    producer: SERVICE,
    policy: options.policy ?? fakePolicy(),
    postsPerHour: options.postsPerHour ?? 1_000,
    postMaxChars: options.postMaxChars ?? 2_000,
    pageSizeMax: options.pageSizeMax ?? 50,
    postingEnabled: options.postingEnabled ?? true,
  }
  const voices: VoiceDeps = {
    sql: database,
    producer: SERVICE,
    followsPerHour: options.followsPerHour ?? 1_000,
  }
  const circles: CircleDeps = { sql: database, producer: SERVICE }
  const whispers: WhisperDeps = {
    sql: database,
    producer: SERVICE,
    whispersPerHour: options.whispersPerHour ?? 1_000,
    postMaxChars: options.postMaxChars ?? 2_000,
  }
  const notifications: NotificationDeps = {
    sql: database,
    producer: SERVICE,
    notificationTtlDays: options.notificationTtlDays ?? 30,
    // Empty by default, which is the production default too: a deployment that has not been told
    // its own origin omits the `url` key. A test about the link passes its own origin.
    publicUrl: options.publicUrl ?? '',
  }
  const moderation: ModerationDeps = {
    sql: database,
    producer: SERVICE,
    reportsPerHour: options.reportsPerHour ?? 1_000,
  }
  return { sql: database, posts, voices, circles, whispers, notifications, moderation }
}

/* ------------------------------------------------------------------ fixtures */

let counter = 0

/** A handle unique within a run that still passes the handle-shape CHECK. */
export function uniqueHandle(prefix = 'voice'): string {
  counter += 1
  return `${prefix}${counter}`
}

export function subject(name: string): string {
  return `user:${name}`
}

/**
 * Materialise a voice for a subject, the same way a first authenticated request does.
 *
 * Through `ensureVoice` rather than an INSERT, so a test's fixture goes down the same path as the
 * product — including the generated handle and the `email_prefs` row, whose ABSENCE is what makes
 * the mail sweep's inner join a real opt-in rather than a filter.
 */
export async function seedVoice(sql: postgres.Sql, name: string): Promise<Voice> {
  const outcome = await sql.begin(async (tx) => ({
    value: await ensureVoice(tx as unknown as Tx, subject(name)),
  }))
  return outcome.value
}

/**
 * The same, with a handle a test can type into a post body.
 *
 * `ensureVoice` DERIVES the handle from the subject — `u` plus eight hex characters — because a
 * default taken from an email address or a display name publishes something the person did not
 * choose to publish. That is the right rule and it makes `@somebody` unwriteable in a fixture, so
 * the handle is set here with a plain UPDATE.
 *
 * Deliberately not through `updateVoice`: this is a fixture, and routing it through the product
 * path would mean every mention test also depended on the rename rules, the reserved list and the
 * rate limit. `voices.test.ts` proves those where they belong. The column's CHECK still applies,
 * so a fixture cannot invent a handle the service could not store.
 */
export async function seedNamed(
  sql: postgres.Sql,
  name: string,
  handle: string = name,
): Promise<Voice> {
  const voice = await seedVoice(sql, name)
  await sql`update voices set handle = ${handle} where id = ${voice.id}`
  return { ...voice, handle }
}

export const asDb = (sql: postgres.Sql): Db => sql as unknown as Db
export const asTx = (tx: unknown): Tx => tx as Tx
