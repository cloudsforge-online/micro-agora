/**
 * The database harness, and the fakes.
 *
 * **A database test runs only against a database whose name says it is a test database.**
 *
 * Not a convenience: `resetCommunity` truncates every table this service owns, and requiring
 * "test" in the name is the difference between a red build and an erased governance record. What
 * is in these tables is not recomputable from anything — `votes` is the only record of how a
 * community decided, `executions` is the only link between a decision and the ledger entry it
 * produced, and `proposals` is the only place the rules a vote was held under are written down. A
 * ledger entry survives; the mandate for it does not.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE VARIABLE IS `COMMUNITY_TEST_DATABASE_URL`, SPELLED EXACTLY.**
 *
 * The reusable workflow at `cloudsforge-online/micro-org/.github/workflows/service-ci.yml` derives
 * it from the `database-env-var` input by substituting `_DATABASE_URL` → `_TEST_DATABASE_URL`, and
 * then GREPS the test output for a skip — if the database-backed suite skipped, the build FAILS
 * rather than going green on nothing. A different spelling here reads no DSN, skips silently, and
 * turns that guard into the exact false-green it exists to prevent (18-build-status.md §3.3). So
 * the name is not negotiable, and `env.test.ts` asserts it.
 *
 * A skipped suite would be worse here than in most repositories: every property this service
 * exists to hold is a DATABASE property. One member one counted vote, a refused delegation cycle,
 * a timelock that a handler cannot bypass, one execution per proposal — not one of them exists in
 * a fake, and a green build with this suite skipped would be proving the tally arithmetic and
 * nothing that matters.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import postgres from 'postgres'
import { migrate, type Sql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { MIGRATIONS, TABLES } from './migrations.ts'
import { registerServiceMetrics } from './server.ts'
import type { Db, Emit, Tx } from './outbox.ts'
import {
  createCommunity,
  joinCommunity,
  declareTreasuryAccount,
  type Community,
  type CommunityKind,
  type GovernanceModel,
  type Membership,
  type Role,
  type TokenGate,
} from './communities.ts'
import { createProposal, type Proposal, type ProposalKind } from './proposals.ts'
import type { HoldingsOracle } from './gating.ts'
import type { PolicyClient, PolicyVerdict } from './policyclient.ts'
import type { LedgerClient, PostEntryRequest, PostedEntry } from './ledgerclient.ts'

// Named `TEST_DSN_VAR` rather than spelling `..._DATABASE_URL` in an identifier: the estate's
// Rule 1 CI check greps source for any `*_DATABASE_URL` token that is not this service's own, and a
// constant NAMED after the variable would trip it. The value is the honest spelling.
export const TEST_DSN_VAR = 'COMMUNITY_TEST_DATABASE_URL'

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
 * would let the constraints drift out of the tests that prove they fire — and
 * `votes_proposal_subject_uniq`, `community_refuse_delegation_cycle`,
 * `community_assert_execution_timelock` and `executions_proposal_uniq` are the four most important
 * lines in this repository.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as Sql, MIGRATIONS, { service: 'community-test' })
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetCommunity(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`)
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'community-test', sink: () => {} })
}

export function testMetrics(): Metrics {
  return registerServiceMetrics(new Metrics())
}

/** Collect emitted events instead of writing them, for the pure-domain tests. */
export function collector(): { emit: Emit; events: Array<Parameters<Emit>[0]> } {
  const events: Array<Parameters<Emit>[0]> = []
  return { emit: (event) => events.push(event), events }
}

/* ------------------------------------------------------------------ fixtures */

let counter = 0

/** A slug unique within a run that still passes `communities_slug_shape`. */
export function uniqueSlug(prefix = 'guild'): string {
  counter += 1
  return `${prefix}-${counter}-${Math.floor(Math.random() * 1e6)}`
}

export function subject(name: string): string {
  return `user:${name}`
}

export interface SeedCommunityOptions {
  readonly kind?: CommunityKind
  readonly governanceModel?: GovernanceModel
  readonly ownerSubject?: string
  readonly gate?: TokenGate
  readonly gateGraceHours?: number
}

export async function seedCommunity(
  sql: postgres.Sql,
  options: SeedCommunityOptions = {},
): Promise<Community> {
  const outcome = await sql.begin(async (tx) => ({
    value: await createCommunity(tx as unknown as Tx, () => {}, {
      slug: uniqueSlug(),
      name: 'The Guild',
      kind: options.kind ?? 'guild',
      ownerSubject: options.ownerSubject ?? subject('owner'),
      joinPolicy: 'open',
      governanceModel: options.governanceModel ?? 'one_member_one_vote',
      ...(options.gate ? { gate: options.gate } : {}),
      ...(options.gateGraceHours !== undefined ? { gateGraceHours: options.gateGraceHours } : {}),
    }),
  }))
  return outcome.value
}

export async function seedMember(
  sql: postgres.Sql,
  community: Community,
  who: string,
  role: Role = 'member',
): Promise<Membership> {
  const outcome = await sql.begin(async (tx) => ({
    value: await joinCommunity(tx as unknown as Tx, () => {}, community, {
      communityId: community.id,
      subject: who,
      role,
      status: 'active',
    }),
  }))
  return outcome.value
}

export async function seedTreasuryAccount(
  sql: postgres.Sql,
  community: Community,
  assetCode = 'EMBER',
): Promise<void> {
  await sql.begin(async (tx) => {
    await declareTreasuryAccount(tx as unknown as Tx, community, assetCode)
    return { done: true }
  })
}

export interface SeedProposalOptions {
  readonly kind?: ProposalKind
  readonly author?: string
  readonly quorum?: bigint
  readonly thresholdBps?: number
  readonly opensAt?: Date
  readonly closesAt?: Date
  readonly timelockUntil?: Date
  readonly spend?: { assetCode: string; amount: bigint; recipient: string }
  readonly status?: string
}

/**
 * A proposal, optionally forced into a status.
 *
 * The status is applied with a raw UPDATE rather than through `transition`, because most tests want
 * a proposal in `voting` without also asserting the transition machinery — and a fixture that went
 * through the real path would make every test depend on the job scheduler. The tests that DO care
 * about transitions use `closeAndCount` directly.
 */
export async function seedProposal(
  sql: postgres.Sql,
  community: Community,
  options: SeedProposalOptions = {},
): Promise<Proposal> {
  const now = Date.now()
  const opensAt = options.opensAt ?? new Date(now - 60_000)
  const closesAt = options.closesAt ?? new Date(now + 3_600_000)
  const timelockUntil = options.timelockUntil ?? new Date(closesAt.getTime() + 3_600_000)

  const outcome = await sql.begin(async (tx) => ({
    value: await createProposal(tx as unknown as Tx, () => {}, community, {
      author: options.author ?? community.ownerSubject,
      kind: options.kind ?? 'text',
      title: 'A proposal',
      quorum: options.quorum ?? 1n,
      thresholdBps: options.thresholdBps ?? 5_000,
      opensAt,
      closesAt,
      timelockUntil,
      ...(options.spend ? { spend: options.spend } : {}),
    }),
  }))

  if (options.status !== undefined) {
    await sql`update proposals set status = ${options.status} where id = ${outcome.value.id}`
    return { ...outcome.value, status: options.status as Proposal['status'] }
  }
  return outcome.value
}

/* ------------------------------------------------------------------ the fakes */

export interface FakeLedger extends LedgerClient {
  readonly calls: readonly PostEntryRequest[]
  /** Every distinct idempotency key that reached it. Length 1 is what exactly-once looks like. */
  readonly keys: ReadonlySet<string>
  failNext(err: Error): void
}

/**
 * A ledger that records what it was asked, and replays a repeated idempotency key.
 *
 * The replay is the important half: the real ledger answers a repeated key from its stored
 * response and posts nothing (`ledger/src/idempotency.ts`), and a fake that happily posted twice
 * would let a test pass that the real ledger would have caught. `keys.size` is therefore the count
 * of actual postings, and it is what the exactly-once tests assert on.
 */
export function fakeLedger(): FakeLedger {
  const calls: PostEntryRequest[] = []
  const byKey = new Map<string, PostedEntry>()
  let pending: Error | null = null
  let seq = 0
  return {
    calls,
    get keys() {
      return new Set(byKey.keys())
    },
    failNext(err) {
      pending = err
    },
    async postEntry(request) {
      if (pending) {
        const err = pending
        pending = null
        throw err
      }
      calls.push(request)
      const existing = byKey.get(request.idempotencyKey)
      if (existing) return { ...existing, replayed: true }
      seq += 1
      const entry: PostedEntry = {
        id: `entry-${seq}`,
        kind: request.kind,
        recordedAt: new Date().toISOString(),
        replayed: false,
      }
      byKey.set(request.idempotencyKey, entry)
      return entry
    },
  }
}

export interface FakePolicy extends PolicyClient {
  readonly calls: readonly unknown[]
  answer(verdict: PolicyVerdict): void
  failWith(err: Error): void
}

/** Allows by default. The fail-closed tests set it to refuse or to throw. */
export function fakePolicy(): FakePolicy {
  const calls: unknown[] = []
  let verdict: PolicyVerdict = { decision: 'allow', reasons: [] }
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
    async evaluateSpend(input) {
      calls.push(input)
      if (failure) throw failure
      return verdict
    },
  }
}

/** An oracle with a fixed answer per subject. `undefined` means unknown. */
export function fakeOracle(balances: Record<string, bigint | undefined>): HoldingsOracle {
  return {
    holdingAt: async (_chainId, _contract, subj) => {
      const balance = balances[subj]
      return balance === undefined ? null : { balance }
    },
  }
}

export const asDb = (sql: postgres.Sql): Db => sql as unknown as Db
export const asTx = (tx: unknown): Tx => tx as Tx
