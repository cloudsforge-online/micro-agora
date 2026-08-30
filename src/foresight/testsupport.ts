/**
 * The database harness, and the fakes.
 *
 * **A database test runs only against a database whose name says it is a test database.**
 *
 * Not a convenience: `resetForesight` truncates every table this service owns, and requiring "test"
 * in the name is the difference between a red build and an emptied environment. The mechanism is
 * `micro-beacon/src/testsupport.ts`, copied exactly — the same `enabled`/`skip` pair, the same
 * refusal, the same reason.
 *
 * The variable is `FORESIGHT_TEST_DATABASE_URL`, spelled exactly as `micro-org`'s reusable workflow
 * exports it. That workflow FAILS the build if the database-backed suite skipped, so a mismatch
 * here is a red build rather than a green one that proved nothing.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import postgres from 'postgres'
import { migrate, type Sql } from '@cloudsforge/db'
import { RATE_SCALE } from '@cloudsforge/contracts-chain'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { MIGRATIONS, TABLES } from './migrations.ts'
import { registerServiceMetrics } from './server.ts'
import { CATEGORY_VERSION } from './categories.ts'
import { SeedPolicyUnavailableError, type EngagementPolicyClient, type SeedPolicy } from './adminapiclient.ts'
import type { CustodyClient, SignRequest } from './custodyclient.ts'
import type { ActivityItem, IndexerClient, TransactionView } from './indexerclient.ts'
import type { PolicyClient, PolicyVerdict } from './policyclient.ts'
import { RateUnavailableError, type PricingClient } from './pricingclient.ts'
import {
  LedgerRefusedError,
  LedgerUnavailableError,
  type EntryRequest,
  type LedgerBalance,
  type LedgerClient,
  type PostedEntry,
} from './ledgerclient.ts'
import type { Proposer, ProposalRun } from './proposer.ts'
import type { SourceProbe } from './resolve.ts'
import type { JsonRpc } from './evm.ts'
import type { Db } from './outbox.ts'
import { insertIdea, type Idea } from './ideas.ts'
import { createDraft, type Market } from './markets.ts'

const url = process.env['FORESIGHT_TEST_DATABASE_URL']

export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set FORESIGHT_TEST_DATABASE_URL (name must contain "test")'

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the constraints drift out of the tests that are supposed to prove they fire — and
 * `markets_unapproved_never_opens` and `positions_source_uniq` are the two most important lines in
 * this repository.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as Sql, MIGRATIONS, { service: 'foresight-test' })
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetForesight(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`)
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'foresight-test', sink: () => {} })
}

export function testMetrics(): Metrics {
  return registerServiceMetrics(new Metrics())
}

export const db = (sql: postgres.Sql): Db => sql as unknown as Db

/* ------------------------------------------------------------------ fixtures */

export const OPERATOR = 'operator:00000000-0000-4000-8000-000000000001'
export const ORACLE = '0x1111111111111111111111111111111111111111'
export const TREASURY = '0x2222222222222222222222222222222222222222'
export const DEPLOYER = '0x3333333333333333333333333333333333333333'

export const FUTURE = (): Date => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

export async function seedIdea(
  sql: postgres.Sql,
  overrides: Partial<Parameters<typeof insertIdea>[1]> = {},
): Promise<Idea> {
  return insertIdea(
    db(sql),
    {
      question: 'Will Hearth mainnet reach block height 5,000,000 before 2027-01-01T00:00:00Z?',
      resolutionCriteria:
        'YES if the block at height 5,000,000 on Hearth mainnet has a timestamp strictly before ' +
        '2027-01-01T00:00:00Z as reported by the named explorer. NO otherwise.',
      category: 'protocol_network',
      categoryVersion: CATEGORY_VERSION,
      resolutionSourceKind: 'block_explorer',
      resolutionSourceRef: 'https://explorer.cloudsforge.online/#/block/5000000',
      suggestedCloseTime: FUTURE(),
      origin: 'model',
      searchQuery: 'hearth block height milestones',
      sources: [{ url: 'https://example.invalid/a', title: 'A', retrievedAt: new Date().toISOString() }],
      modelId: 'test-model-1',
      promptSha256: 'a'.repeat(64),
      ...overrides,
    },
    new Date(),
  )
}

export async function seedDraft(
  sql: postgres.Sql,
  overrides: Partial<Parameters<typeof createDraft>[1]> = {},
): Promise<Market> {
  return createDraft(
    db(sql),
    {
      question: 'Will Hearth mainnet reach block height 5,000,000 before 2027-01-01T00:00:00Z?',
      resolutionCriteria:
        'YES if the block at height 5,000,000 on Hearth mainnet has a timestamp strictly before ' +
        '2027-01-01T00:00:00Z as reported by the named explorer. NO otherwise.',
      category: 'protocol_network',
      resolutionSourceKind: 'block_explorer',
      resolutionSourceRef: 'https://explorer.cloudsforge.online/#/block/5000000',
      closeTime: FUTURE(),
      disputeWindowSeconds: 86_400,
      feeBps: 200,
      network: 'testnet',
      chain: 'ember',
      ...overrides,
    },
    new Date(),
  )
}

/** Approve a market the way the routes do, so a test does not have to know the column names. */
export async function approveDirect(sql: postgres.Sql, marketId: string, operator = OPERATOR): Promise<void> {
  await sql`
    update markets set status = 'approved', approved_by = ${operator}, approved_at = now()
     where id = ${marketId}
  `
}

/**
 * Put a market in `open` with a contract, for tests about what happens after that.
 *
 * The transaction hash and the deployer are DERIVED FROM THE MARKET ID rather than constant.
 * Sharing them collides with `markets_deploy_tx_hash_uniq` and `markets_contract_uniq` the moment a
 * test opens two markets — which is the constraints doing their job, and a fixture that has to be
 * worked around is a fixture that is wrong.
 */
export async function openDirect(
  sql: postgres.Sql,
  marketId: string,
  contractAddress?: string,
): Promise<void> {
  // A uuid without its dashes is 32 hex characters; an address needs 40 and a hash needs 64, so
  // both are padded rather than sliced short. A 32-character "address" is not one, and the codec
  // says so — which is how this fixture was caught the first time.
  const seed = marketId.replace(/-/g, '')
  const contract = contractAddress ?? `0x${seed.padEnd(40, '0')}`
  const txHash = `0x${seed.repeat(2).slice(0, 64)}`
  const deployer = `0x${(seed.slice(8) + seed.slice(0, 8)).padEnd(40, 'f')}`
  await approveDirect(sql, marketId)
  await sql`
    update markets
       set deploy_state = 'deployed', deployer_address = ${deployer},
           contract_address = ${contract}, deploy_nonce = 0,
           raw_tx = '0xdead', deploy_tx_hash = ${txHash},
           status = 'open', opened_at = now()
     where id = ${marketId}
  `
}

/* ------------------------------------------------------------------ the fakes */

export interface FakeCustody extends CustodyClient {
  readonly signed: readonly SignRequest[]
  /** Make the next `sign` throw. Used for the refusal and unavailability paths. */
  failNextSign(err: Error): void
  /** What `sign` returns. Defaults to a deterministic fake transaction per call. */
  setSignature(signedTx: string): void
}

export function fakeCustody(address = DEPLOYER): FakeCustody {
  const signed: SignRequest[] = []
  let nextError: Error | null = null
  let signature: string | null = null
  let counter = 0
  return {
    signed,
    failNextSign(err) {
      nextError = err
    },
    setSignature(value) {
      signature = value
    },
    async provisionDeployer() {
      return { address, chain: 'ember', network: 'testnet', family: 'ember' }
    },
    async sign(request) {
      if (nextError) {
        const err = nextError
        nextError = null
        throw err
      }
      signed.push(request)
      counter += 1
      // Deterministic per call, and DIFFERENT per call, so a test that accidentally signs twice
      // produces two hashes and the duplicate is visible rather than hidden by identical bytes.
      return {
        signedTx: signature ?? `0x${counter.toString(16).padStart(2, '0')}${'cd'.repeat(40)}`,
        auditId: `audit-${counter}`,
      }
    },
  }
}

/**
 * A scripted JSON-RPC.
 *
 * Methods are answered from a table and every call is recorded. A method with no entry THROWS
 * rather than returning undefined: a test that silently got `undefined` for `eth_gasPrice` would
 * pass for the wrong reason.
 */
export interface FakeRpc {
  readonly calls: readonly { method: string; params: readonly unknown[] }[]
  readonly rpc: JsonRpc
  set(method: string, value: unknown | (() => unknown)): void
  /** Make the next call to `method` throw. For the lost-broadcast test. */
  failNext(method: string, err: Error): void
}

export function fakeRpc(initial: Record<string, unknown> = {}): FakeRpc {
  const calls: { method: string; params: readonly unknown[] }[] = []
  const table = new Map<string, unknown>(Object.entries(initial))
  const failures = new Map<string, Error>()
  return {
    calls,
    set(method, value) {
      table.set(method, value)
    },
    failNext(method, err) {
      failures.set(method, err)
    },
    rpc: async (method, params) => {
      calls.push({ method, params })
      const failure = failures.get(method)
      if (failure) {
        failures.delete(method)
        throw failure
      }
      if (!table.has(method)) throw new Error(`fakeRpc has no answer for ${method}`)
      const value = table.get(method)
      return typeof value === 'function' ? (value as () => unknown)() : value
    },
  }
}

export interface FakeIndexer extends IndexerClient {
  setActivity(items: readonly ActivityItem[], tipHeight?: number): void
  setTransaction(hash: string, view: TransactionView | null): void
  /** Make every call throw, to exercise the degraded path. */
  setDown(down: boolean): void
  /**
   * Answer with more pages outstanding. A truncated page is the one case where the mirror has NOT
   * covered the address up to the tip, and `syncMarket` records a different `last_block` for it.
   */
  setTruncated(cursor: string | null): void
}

export function fakeIndexer(): FakeIndexer {
  let items: readonly ActivityItem[] = []
  let tip: number | null = 100
  let down = false
  let nextCursor: string | null = null
  const transactions = new Map<string, TransactionView | null>()
  const guard = () => {
    if (down) throw new Error('indexer is down')
  }
  return {
    setActivity(next, tipHeight) {
      items = next
      if (tipHeight !== undefined) tip = tipHeight
    },
    setTransaction(hash, view) {
      transactions.set(hash.toLowerCase(), view)
    },
    setDown(value) {
      down = value
    },
    setTruncated(cursor) {
      nextCursor = cursor
    },
    async watch() {
      guard()
    },
    async activity() {
      guard()
      return { tipHeight: tip, requiredConfirmations: 60, items, nextCursor }
    },
    async transaction(_chain, _network, hash) {
      guard()
      return transactions.get(hash.toLowerCase()) ?? null
    },
    async status() {
      guard()
      return { tipHeight: tip }
    },
  }
}

export interface FakePolicy extends PolicyClient {
  setVerdict(verdict: PolicyVerdict): void
  /** Make policy unreachable. The whole point of the fail-closed test. */
  setDown(down: boolean): void
  readonly calls: readonly { subject: string; marketId: string; amount: string }[]
}

export function fakePolicy(): FakePolicy {
  const calls: { subject: string; marketId: string; amount: string }[] = []
  let down = false
  let verdict: PolicyVerdict = { decision: 'allow', reasons: [], degraded: false, decisionId: 'd1' }
  return {
    calls,
    setVerdict(next) {
      verdict = next
    },
    setDown(value) {
      down = value
    },
    async evaluateStake(input) {
      calls.push({ subject: input.subject, marketId: input.marketId, amount: input.amount })
      // The REAL client's behaviour when it cannot reach policy, restated here so the fake cannot
      // be kinder than the thing it stands in for. `UNAVAILABLE_VERDICT` is `deny` + `degraded`.
      if (down) return { decision: 'deny', reasons: ['policy_unavailable'], degraded: true, decisionId: null }
      return verdict
    },
  }
}

export const HOUSE = '0x4444444444444444444444444444444444444444'

/** The published platform address a custodial position is staked from. See `custodialstakes.ts`. */
export const CUSTODIAL = '0x5555555555555555555555555555555555555555'

/**
 * Rates the tests choose, at contracts-chain's RATE_SCALE.
 *
 * BTC at $60,000 and EMBER at $0.25 are the numbers every arithmetic assertion in this repository
 * is written against, so 0.01 BTC is $600 is 2,400 EMBER — a figure a reader can check in their
 * head, which is the only reason a test's constants matter.
 */
export const BTC_USD_SCALED = 60_000_000_000n
export const EMBER_USD_SCALED = 250_000n

export interface FakePricing extends PricingClient {
  setRate(asset: string, usdScaled: bigint): void
  /** Make a leg unreadable. The fail-closed path is the point of the seam. */
  setUnavailable(asset: string, unavailable: boolean): void
  readonly reads: readonly string[]
}

export function fakePricing(): FakePricing {
  const reads: string[] = []
  const rates = new Map<string, bigint>([
    ['BTC', BTC_USD_SCALED],
    ['ETH', 3_000_000_000n],
    ['EMBER', EMBER_USD_SCALED],
  ])
  const down = new Set<string>()
  return {
    reads,
    setRate(asset, usdScaled) {
      rates.set(asset, usdScaled)
    },
    setUnavailable(asset, unavailable) {
      if (unavailable) down.add(asset)
      else down.delete(asset)
    },
    async stakeRates(stakeAsset) {
      reads.push(stakeAsset)
      // The REAL client's shortcut, restated so the fake cannot be kinder than the thing it stands
      // in for: staking the pool asset applies no rate, so no rate is read.
      if (stakeAsset === 'EMBER') {
        if (down.has('EMBER')) throw new RateUnavailableError('EMBER', 'the EMBER rate is not usable: test')
        return { stakeUsdScaled: RATE_SCALE, poolUsdScaled: RATE_SCALE }
      }
      for (const asset of [stakeAsset, 'EMBER']) {
        if (down.has(asset)) {
          throw new RateUnavailableError(asset, `the ${asset} rate is not usable: test`)
        }
      }
      const stakeUsdScaled = rates.get(stakeAsset)
      const poolUsdScaled = rates.get('EMBER')
      if (stakeUsdScaled === undefined || poolUsdScaled === undefined) {
        throw new RateUnavailableError(stakeAsset, `no test rate for ${stakeAsset}`)
      }
      return { stakeUsdScaled, poolUsdScaled }
    },
  }
}

export interface FakeLedger extends LedgerClient {
  /** Every entry this service tried to post, in order. The seam money is checked at. */
  readonly entries: readonly EntryRequest[]
  /** Refuse like the real ledger does when it has LOOKED and said no — an overdraft is this. */
  setRefusal(refusal: { status: number; code: string; message: string } | null): void
  /** Unreachable. We do not know whether the entry posted, so the caller must retry. */
  setDown(down: boolean): void
  /** Forget everything. A fake shared across a file's cases must be reset like the database is. */
  reset(): void
  /** What the next `balances()` answers with. Empty by default: a user who holds nothing. */
  setBalances(balances: readonly LedgerBalance[]): void
}

export function fakeLedger(): FakeLedger {
  const entries: EntryRequest[] = []
  const posted = new Map<string, PostedEntry>()
  let refusal: { status: number; code: string; message: string } | null = null
  let down = false
  let balances: readonly LedgerBalance[] = []
  return {
    entries,
    setRefusal(next) {
      refusal = next
    },
    setDown(value) {
      down = value
    },
    setBalances(next) {
      balances = next
    },
    async balances(_subject) {
      // Down means down for reads too. A panel that showed a balance while a stake could not be
      // posted would be telling somebody they can act when they cannot.
      if (down) throw new LedgerUnavailableError('the ledger did not answer')
      return balances
    },
    reset() {
      entries.length = 0
      posted.clear()
      refusal = null
      down = false
      balances = []
    },
    async postEntry(request) {
      if (down) throw new LedgerUnavailableError('the ledger did not answer')
      if (refusal) throw new LedgerRefusedError(refusal.status, refusal.code, refusal.message)
      entries.push(request)
      // Idempotent, like the real one. A retry on the same key replays rather than posting twice —
      // a fake that posted twice would let a double-charge pass every test in this repository.
      const already = posted.get(request.idempotencyKey)
      if (already) return { ...already, replayed: true }
      const entry: PostedEntry = {
        id: `entry-${posted.size + 1}`,
        kind: request.kind,
        recordedAt: new Date().toISOString(),
        replayed: false,
      }
      posted.set(request.idempotencyKey, entry)
      return entry
    },
  }
}

export interface FakeSeedPolicyClient extends EngagementPolicyClient {
  /** The policy admin-api answers with; null is "no seed sizes raised". */
  setPolicy(policy: SeedPolicy | null): void
  /** Make admin-api unreachable — the fail-closed path is the point of the seam. */
  setDown(down: boolean): void
  readonly reads: number
}

export function fakeSeedPolicy(initial: SeedPolicy | null = null): FakeSeedPolicyClient {
  let policy = initial
  let down = false
  let reads = 0
  return {
    get reads() {
      return reads
    },
    setPolicy(next) {
      policy = next
    },
    setDown(value) {
      down = value
    },
    async foresightSeedPolicy() {
      reads += 1
      if (down) throw new SeedPolicyUnavailableError('admin-api could not be reached')
      return policy
    },
  }
}

/**
 * Put the house's symmetric stake into the mirror, as the mirror itself would after indexing the
 * Staked logs. Tx hashes are derived from the market id so two seeded markets never collide with
 * `positions_source_uniq`.
 */
export async function mirrorHouseStake(
  sql: postgres.Sql,
  marketId: string,
  perOutcomeWei: bigint,
  houseAddress = HOUSE,
): Promise<{ txYes: string; txNo: string }> {
  const seed = marketId.replace(/-/g, '')
  const txYes = `0x${`aa${seed}`.repeat(3).slice(0, 64)}`
  const txNo = `0x${`bb${seed}`.repeat(3).slice(0, 64)}`
  await sql`
    insert into positions (market_id, staker, outcome, amount, tx_hash, log_index, block_height, block_hash)
    values
      (${marketId}, ${houseAddress.toLowerCase()}, 0, ${perOutcomeWei.toString()}, ${txYes}, 0, 10, '0xblock10'),
      (${marketId}, ${houseAddress.toLowerCase()}, 1, ${perOutcomeWei.toString()}, ${txNo}, 1, 10, '0xblock10')
  `
  return { txYes, txNo }
}

/** A source probe with a switch. Being able to make a source vanish is the point of the interface. */
export function fakeSourceProbe(reachable = true): SourceProbe & { set(value: boolean): void } {
  let value = reachable
  return {
    set(next) {
      value = next
    },
    async reachable() {
      return value
    },
  }
}

export function fakeProposer(run: ProposalRun, configured = true): Proposer {
  return { configured, propose: async () => run }
}

/* ------------------------------------------------------------------ a real HTTP target */

export interface FakeTarget {
  readonly baseUrl: string
  readonly hits: readonly string[]
  setStatus(status: number): void
  close(): Promise<void>
}

/**
 * A real socket, for the source probe.
 *
 * Real rather than a stub because the rule under test is "the named source is gone", and the
 * difference between a 404 and a refused connection is exactly the kind of thing a stub gets wrong.
 */
export async function fakeTarget(): Promise<FakeTarget> {
  const hits: string[] = []
  let status = 200
  const open = new Set<import('node:net').Socket>()

  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '/')
    const payload = `${JSON.stringify({ ok: status < 400 })}\n`
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  })
  server.on('connection', (socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    setStatus(value) {
      status = value
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
