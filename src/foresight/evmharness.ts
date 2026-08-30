/**
 * An EVM, for testing the contract.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THERE IS AN EVM IN THIS REPOSITORY AT ALL, AND WHY IT IS ONE DEPENDENCY.
 *
 * The invariants that matter here are statements about EXECUTED BYTECODE. "A pool sums exactly",
 * "a second claim reverts", "resolution before close is impossible", "only the oracle resolves" —
 * none of those can be checked by reading an ABI or hashing a source file. They need something that
 * runs the code.
 *
 * The alternatives were weighed and are worse:
 *
 *   * **Hardhat or Foundry.** Each brings a whole toolchain and a second build system into a
 *     repository whose entire compile step is one 90-line script and one exact-pinned `solc`. The
 *     estate's rule is that a service has one build; this would give it two.
 *   * **A real Hearth node.** `micro-indexer` does exactly this and is right to — but its Hearth
 *     test SKIPS when no node is reachable (`indexer/src/hearth.test.ts`), and a suite whose
 *     contract invariants skip on the one machine that matters is a suite that proves nothing. CI
 *     has no chain.
 *   * **Not testing the contract.** Not available. It holds other people's money.
 *
 * So: `@ethereumjs/evm`, a devDependency, used only here. It executes the same committed bytecode
 * `deploy.ts` sends to custody — `FORESIGHTMARKET_BYTECODE` from `generated.ts`, the artefact CI
 * recompiles and diffs — so what the tests run is what the chain would run.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## What it does NOT prove, said plainly
 *
 * That Hearth's own EVM behaves identically. It is an Ethereum-compatible chain and the contract is
 * compiled for `paris` precisely to stay inside what it implements, but "compatible" is a claim
 * about a node this harness does not run. The integration that would close that gap is a deploy to
 * the Hearth testnet, which belongs in a deployment rehearsal rather than in a unit suite.
 */

import { EVM } from '@ethereumjs/evm'
import { DefaultStateManager } from '@ethereumjs/statemanager'
import { Chain, Common, Hardfork } from '@ethereumjs/common'
import { Account, Address, hexToBytes, bytesToHex } from '@ethereumjs/util'
import { decodeAbi, encodeAbi, selector, type AbiType, type AbiValue } from './evm.ts'

export interface CallResult {
  readonly reverted: boolean
  /** The custom-error selector or revert string when it reverted, else ''. */
  readonly revertData: string
  readonly returnData: string
  readonly logs: readonly { address: string; topics: readonly string[]; data: string }[]
  readonly createdAddress: string | null
}

export interface Harness {
  /** Advance the block clock. The dispute window and the close time are both timestamps. */
  setTime(seconds: bigint): void
  time(): bigint
  fund(address: string, wei: bigint): Promise<void>
  balanceOf(address: string): Promise<bigint>
  /** Deploy creation bytecode from `from`, returning the new address. */
  create(from: string, data: string, value?: bigint): Promise<CallResult>
  /** Call a deployed contract. `signature` is canonical: `stake(uint8)`. */
  call(
    from: string,
    to: string,
    signature: string,
    args?: readonly AbiValue[],
    value?: bigint,
  ): Promise<CallResult>
  /** A view call, decoded. Throws if it reverted, because a view that reverts is a test bug. */
  view(to: string, signature: string, returns: readonly AbiType[], args?: readonly AbiValue[]): Promise<readonly (string | bigint | boolean)[]>
  /** The nonce of an account, so a test can derive the address its next creation will occupy. */
  nonceOf(address: string): Promise<bigint>
}

/** A fixed 30M gas limit and a zero base fee: this harness prices nothing, it only executes. */
const BLOCK_GAS_LIMIT = 30_000_000n
const CALL_GAS_LIMIT = 20_000_000n

export async function createHarness(startTime = 1_700_000_000n): Promise<Harness> {
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Paris })
  const stateManager = new DefaultStateManager()
  const evm = await EVM.create({ common, stateManager })

  let timestamp = startTime
  const coinbase = new Address(hexToBytes(`0x${'99'.repeat(20)}`))
  const block = () => ({
    header: {
      number: 1n,
      cliqueSigner: () => coinbase,
      coinbase,
      timestamp,
      difficulty: 0n,
      prevRandao: new Uint8Array(32),
      gasLimit: BLOCK_GAS_LIMIT,
      baseFeePerGas: 0n,
      getBlobGasPrice: () => undefined,
    },
  })

  const addressOf = (hex: string) => new Address(hexToBytes(hex.toLowerCase() as `0x${string}`))

  const ensure = async (hex: string): Promise<void> => {
    const account = await stateManager.getAccount(addressOf(hex))
    if (!account) await stateManager.putAccount(addressOf(hex), new Account(0n, 0n))
  }

  const toResult = (result: Awaited<ReturnType<typeof evm.runCall>>): CallResult => {
    const exec = result.execResult
    const returnData = bytesToHex(exec.returnValue)
    return {
      reverted: exec.exceptionError !== undefined,
      revertData: exec.exceptionError !== undefined ? returnData : '',
      returnData,
      logs: (exec.logs ?? []).map((log) => ({
        address: bytesToHex(log[0]),
        topics: log[1].map((topic) => bytesToHex(topic)),
        data: bytesToHex(log[2]),
      })),
      createdAddress: result.createdAddress ? result.createdAddress.toString() : null,
    }
  }

  const harness: Harness = {
    setTime(seconds) {
      timestamp = seconds
    },
    time() {
      return timestamp
    },
    async fund(address, wei) {
      await ensure(address)
      const account = (await stateManager.getAccount(addressOf(address))) ?? new Account(0n, 0n)
      account.balance += wei
      await stateManager.putAccount(addressOf(address), account)
    },
    async balanceOf(address) {
      const account = await stateManager.getAccount(addressOf(address))
      return account?.balance ?? 0n
    },
    async nonceOf(address) {
      const account = await stateManager.getAccount(addressOf(address))
      return account?.nonce ?? 0n
    },
    async create(from, data, value = 0n) {
      await ensure(from)
      const result = await evm.runCall({
        caller: addressOf(from),
        data: hexToBytes(data as `0x${string}`),
        gasLimit: CALL_GAS_LIMIT,
        value,
        block: block(),
      })
      // `runCall` bumps the caller's nonce itself, so a sequence of creations from one account
      // lands at exactly the addresses `createAddress(from, n)` predicts — which is what
      // `ForesightMarket._isOracle` relies on, and what `contracts.test.ts` asserts directly.
      return toResult(result)
    },
    async call(from, to, signature, args = [], value = 0n) {
      await ensure(from)
      const data = `${selector(signature)}${encodeAbi(args).toString('hex')}`
      const result = await evm.runCall({
        caller: addressOf(from),
        to: addressOf(to),
        data: hexToBytes(data as `0x${string}`),
        gasLimit: CALL_GAS_LIMIT,
        value,
        block: block(),
      })
      return toResult(result)
    },
    async view(to, signature, returns, args = []) {
      const result = await harness.call(`0x${'ee'.repeat(20)}`, to, signature, args)
      if (result.reverted) throw new Error(`view ${signature} reverted: ${result.revertData}`)
      return decodeAbi(returns, result.returnData)
    },
  }
  return harness
}

/**
 * The 4-byte selector of a custom error, for asserting WHICH revert happened.
 *
 * Asserting merely that something reverted is close to worthless on a contract with fifteen
 * revert paths: a test that expects `AlreadyClaimed` and gets `NotResolved` would pass. Solidity
 * encodes a custom error exactly like a function call, so the selector is the same derivation.
 */
export function errorSelector(signature: string): string {
  return selector(signature)
}

/** Did this result revert with that specific custom error? */
export function revertedWith(result: CallResult, errorSignature: string): boolean {
  return result.reverted && result.revertData.startsWith(errorSelector(errorSignature))
}
