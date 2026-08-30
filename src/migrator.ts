/**
 * The one-shot migrator, for every database this deployable owns.
 *
 * A separate process, run as an init container or a Kubernetes Job, and **never** called from
 * `index.ts`. Three reasons, in increasing order of seriousness:
 *
 *   1. A slow migration would stall every service that waits on this one's health.
 *   2. Two replicas booting together race on `pg_type`, one raises 23505 and crash-loops — which
 *      is why the estate cannot scale a service past one replica today.
 *   3. Migrating from inside the service means the service decides when the schema changes, so a
 *      rollback of the image is not a rollback of the database.
 *
 * Safe to run concurrently from N processes: `@cloudsforge/db` serialises them on an advisory
 * lock derived from the service name, and the losers observe an empty pending set.
 *
 * For agora's own schema point 3 is the sharp one. `post_media_alt_required` and
 * `whisper_threads_pair_uniq` are the two constraints that make "an image nobody can read" and
 * "two conversations between the same two people" unrepresentable. A service that could create
 * them at boot is a service that could start without them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WAVES M5a + M5b: TWELVE MODULES, TWELVE MIGRATION LEDGERS, AND WHY THEY CANNOT BE CONFUSED.**
 *
 * This process now migrates agora's databases, devplatform's, policy's, pricing's, studio's, and
 * the M5b seven — community's, market's, billing's, mint's, foresight's, worlds' and tessera's.
 * Every ledger is a table called `schema_migrations` — the name is a literal inside
 * `@cloudsforge/db` and takes no option — so the ONLY thing keeping agora's version 6 from being
 * read as studio's version 6 is that they are in different DATABASES. Nothing about the merge
 * changes that, and nothing may:
 *
 *   * `AGORA_DATABASE_URL`, `DEVPLATFORM_DATABASE_URL`, `POLICY_DATABASE_URL`,
 *     `PRICING_DATABASE_URL`, `STUDIO_DATABASE_URL`, `COMMUNITY_DATABASE_URL`,
 *     `MARKET_DATABASE_URL`, `BILLING_DATABASE_URL`, `MINT_DATABASE_URL`,
 *     `FORESIGHT_DATABASE_URL`, `WORLDS_DATABASE_URL` and `TESSERA_DATABASE_URL` name different
 *     databases. `assertDistinct` below REFUSES to run if they do not, before a single statement is
 *     issued. That refusal is
 *     cheap and the alternative is not: `inbox` and `jobs` exist in ALL FIVE schemas, and
 *     `outbox`, `event_subscriptions` and `outbox_deliveries` in four of them. One shared database
 *     is two `create table inbox` racing, and then — because the ledger would already record the
 *     first module's version — the later modules' tables never created at all, with a green
 *     migrator.
 *   * The `service` name each `migrate()` call passes is distinct, so the runs take DIFFERENT
 *     advisory locks and cannot serialise against each other. That is correct only because they
 *     are also in different databases; the assertion above is what makes it correct rather than
 *     lucky.
 *   * No module's `MIGRATIONS` array is imported by another. Each is applied only to the DSNs of
 *     the module that declares it, and each module names its own targets through a function that
 *     returns four scalars — so this file never comes into possession of a DSN, an ingest secret
 *     or an image-model key.
 *
 * `migratortargets.test.ts` pins all five and MEASURES the table overlap rather than asserting it,
 * including the fact that every module numbers its migrations from 1.
 *
 * Every target still runs — the loop records a failure and carries on — so one run reports EVERY
 * database that is wrong. An operator who fixes one and rediscovers the next on the following
 * deploy has been given the same information twice at twice the cost.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import postgres from 'postgres'
import { migrate, type Sql } from '@cloudsforge/db'
import { Logger } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { BASELINE_VERSION, MIGRATIONS } from './migrations.ts'
// FOUR imports, and each returns four scalars and an array of DDL per database. They deliberately
// do NOT reach for the modules' `env.ts`: a second entry point holding a DSN it has no other reason
// to hold is a hole, and this way the migrator cannot name one.
import { devplatformMigrationTargets } from './devplatform/module.ts'
import { policyMigrationTargets } from './policy/module.ts'
import { pricingMigrationTargets } from './pricing/module.ts'
import { studioMigrationTargets } from './studio/module.ts'
// The M5b seven, each naming its OWN databases through a function that returns scalars — so this
// file never comes into possession of a DSN it has no other reason to hold.
import { communityMigrationTargets } from './community/module.ts'
import { marketMigrationTargets } from './market/module.ts'
import { billingMigrationTargets } from './billing/module.ts'
import { mintMigrationTargets } from './mint/module.ts'
import { foresightMigrationTargets } from './foresight/module.ts'
import { worldsMigrationTargets } from './worlds/module.ts'
import { tesseraMigrationTargets } from './tessera/module.ts'
import { assertDistinct, type Target } from './migratortargets.ts'

const log = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
}).child({ step: 'migrate' })

// ── EVERY DATABASE THIS DEPLOYMENT HOLDS ──────────────────────────────────────────────────────
//
// One entry PER MODULE PER NETWORK. The testnet halves are conditional until each module's testnet
// database is adopted into this cluster (`docs/network-consolidation.md` §6). Migrating only the
// first is the failure that would not show up here: the migrator exits 0, the deploy goes green,
// and the NEXT release's boot-time schema assertion finds the second database behind and refuses
// to serve testnet.
const targets: readonly Target[] = [
  {
    module: SERVICE,
    network: 'primary',
    url: env.databaseUrl,
    migrations: MIGRATIONS,
    baselineVersion: BASELINE_VERSION,
  },
  ...(env.databaseUrlTestnet
    ? [
        {
          module: SERVICE,
          network: 'testnet',
          url: env.databaseUrlTestnet,
          migrations: MIGRATIONS,
          baselineVersion: BASELINE_VERSION,
        } satisfies Target,
      ]
    : []),
  // Each mounted module names its own, because only it may read its own configuration.
  ...devplatformMigrationTargets(),
  ...policyMigrationTargets(),
  ...pricingMigrationTargets(),
  ...studioMigrationTargets(),
  ...communityMigrationTargets(),
  ...marketMigrationTargets(),
  ...billingMigrationTargets(),
  ...mintMigrationTargets(),
  ...foresightMigrationTargets(),
  ...worldsMigrationTargets(),
  ...tesseraMigrationTargets(),
]

// BEFORE ANY STATEMENT. Two modules pointed at one database is not a migration that fails halfway;
// it is two ledgers in one table, which is a database nobody can reason about afterwards.
try {
  assertDistinct(targets)
} catch (err) {
  log.fatal('the declared databases are not distinct', { err })
  process.exit(1)
}

let failed = false
// SEQUENTIAL: two migrations racing for one advisory lock is exactly the contention
// `@cloudsforge/db` was written to remove.
for (const target of targets) {
  // A tiny pool: the whole run happens on one reserved connection, and a wide pool here only makes
  // a migration that has to wait for a lock hold more of the database's connection budget.
  const sql = postgres(target.url, { max: 2, onnotice: () => {} })
  try {
    const result = await migrate(sql as unknown as Sql, target.migrations, {
      // The MODULE's name, not this repository's. It names the advisory lock, and two modules must
      // not share one. It is also what makes the log line say which schema moved, in a process that
      // now moves five.
      service: target.module,
      // See the note on BASELINE_VERSION. Zero for a new service, which makes this a no-op.
      baselineVersion: target.baselineVersion,
      onLog: (message, fields) => log.info(message, { ...fields, module: target.module, network: target.network }),
    })
    log.info('migrations complete', {
      module: target.module,
      network: target.network,
      from: result.alreadyAt,
      to: result.nowAt,
      applied: result.applied.map((a) => `${a.version}:${a.name}`),
    })
  } catch (err) {
    // Recorded and carried on, so one run reports EVERY database that is wrong rather than the
    // first. An operator who fixes one and rediscovers the next on the following deploy has been
    // given the same information twice at twice the cost.
    log.fatal('migration failed', { err, module: target.module, network: target.network })
    failed = true
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}

// Exit non-zero and loudly. The deploy must stop here: a service started against a schema its
// migrator could not reach is the failure this whole arrangement exists to prevent.
process.exit(failed ? 1 : 0)
