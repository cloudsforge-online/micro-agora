/**
 * The EVM half of this service: addresses, quantities, ABI encoding and decoding, and the two
 * derivations that make the deploy recovery path possible.
 *
 * ## There is no chain library here, and that is a decision rather than an omission
 *
 * This service builds ONE transaction shape — a legacy zero-value contract creation — and hands it
 * to custody as a JSON object. Custody is the only place a private key exists and therefore the
 * only place a serialiser is needed. What is left is keccak256 and RLP, and both exist here rather
 * than as a dependency because they sit on the one path where a wrong answer deploys a market to an
 * address nobody can find, holding other people's stakes.
 *
 * Carried forward from `micro-mint/src/evm.ts`, which is the precedent this repository was told to
 * follow. Two things are added: `decodeAbi`, because a market has views to read and a mirror has
 * logs to decode, and `topic0`, because that is how a log is told from another log.
 *
 * ## The two derivations, and why both are DERIVED rather than remembered
 *
 *   1. **`evmTxHash`** — `keccak256(rawTx)` is the id a chain will know the bytes by. A node
 *      answers a re-broadcast of a transaction it already holds with an ERROR, not with the hash.
 *      So a crash between broadcasting and recording would otherwise leave a deploy that landed on
 *      chain with no id to poll — re-sending for ever, and eventually declared failed while the
 *      market sat there fully deployed with stakes arriving. This is the function that makes
 *      "record the broadcast before awaiting confirmation" implementable at all: the hash is
 *      knowable BEFORE the send.
 *
 *   2. **`createAddress`** — a contract created by an EOA lands at
 *      `keccak256(rlp([sender, nonce]))[12:]`, and that is a total function of two values this
 *      service already holds. So the market's address is known before the transaction is sent.
 *      **The contract computes the same function on chain** — `ForesightMarket.computeCreateAddress`
 *      — because that derivation is how the market recognises its own oracle. The two
 *      implementations are asserted equal on a corpus in `contracts.test.ts`, including at the
 *      0x7f/0x80 nonce boundary where RLP changes shape and a naive version is silently wrong.
 */

import { keccak256, toChecksumAddress } from '@cloudsforge/evm'

const EVM_SHAPE = /^0x[0-9a-fA-F]{40}$/
const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export class ChainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChainError'
  }
}

/* ------------------------------------------------------------------ addresses */

/**
 * Validate and produce the display form, or throw.
 *
 * A mixed-case address is CLAIMING a checksum and is held to it. An all-lowercase or all-uppercase
 * address is not claiming one and is accepted — refusing it would reject the form every block
 * explorer's copy button used to produce and the form the indexer stores.
 */
export function canonicaliseEvm(raw: string): string {
  const trimmed = raw.trim()
  if (!EVM_SHAPE.test(trimmed)) {
    throw new ChainError('address must be 0x followed by 40 hex characters')
  }
  const lower = trimmed.toLowerCase()
  const isAllOneCase = trimmed === lower || trimmed === `0x${trimmed.slice(2).toUpperCase()}`
  if (!isAllOneCase && toChecksumAddress(lower) !== trimmed) {
    throw new ChainError('address fails its EIP-55 checksum; check for a mistyped character')
  }
  if (lower === ZERO_ADDRESS) {
    // Not a judgement about an address's worth, but 0x0 is the one account from which nothing can
    // ever be recovered — a market whose treasury is the zero address burns every fee it takes.
    throw new ChainError('the zero address cannot be used here')
  }
  return toChecksumAddress(lower)
}

export function isEvmAddress(value: unknown): value is string {
  return typeof value === 'string' && EVM_SHAPE.test(value)
}

/* ------------------------------------------------------------------ quantities */

/** Hex quantity → BigInt, refusing anything that is not one rather than reading it as zero. */
export function quantity(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !HEX_QUANTITY.test(value)) {
    throw new ChainError(`${what}: expected a hex quantity, got ${JSON.stringify(value)}`)
  }
  return BigInt(value)
}

export const hexQuantity = (value: bigint): string => `0x${value.toString(16)}`

/* ------------------------------------------------------------------ RLP, encoding side */

function toBytes(value: bigint): Buffer {
  if (value === 0n) return Buffer.alloc(0)
  let hex = value.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  return Buffer.from(hex, 'hex')
}

function rlpItem(payload: Buffer): Buffer {
  if (payload.length === 1 && payload[0]! <= 0x7f) return payload
  if (payload.length <= 55) return Buffer.concat([Buffer.from([0x80 + payload.length]), payload])
  const length = toBytes(BigInt(payload.length))
  return Buffer.concat([Buffer.from([0xb7 + length.length]), length, payload])
}

function rlpList(items: readonly Buffer[]): Buffer {
  const body = Buffer.concat(items)
  if (body.length <= 55) return Buffer.concat([Buffer.from([0xc0 + body.length]), body])
  const length = toBytes(BigInt(body.length))
  return Buffer.concat([Buffer.from([0xf7 + length.length]), length, body])
}

/**
 * The address a contract created by `sender` at `nonce` will occupy.
 *
 * `keccak256(rlp([sender, nonce]))` and take the low 20 bytes. Known BEFORE the transaction is
 * sent, which is what lets the market's address be recorded from the moment of broadcast rather
 * than from the moment of confirmation — and what lets the market contract itself recognise a
 * resolver its own oracle created.
 */
export function createAddress(sender: string, nonce: bigint): string {
  if (!EVM_SHAPE.test(sender)) throw new ChainError('sender must be an EVM address')
  if (nonce < 0n) throw new ChainError('nonce must not be negative')
  const encoded = rlpList([
    rlpItem(Buffer.from(sender.slice(2).toLowerCase(), 'hex')),
    rlpItem(toBytes(nonce)),
  ])
  const digest = Buffer.from(keccak256(encoded))
  return toChecksumAddress(`0x${digest.subarray(12).toString('hex')}`)
}

/* ------------------------------------------------------------------ the transaction id */

/** Raw bytes of a `0x`-prefixed or bare hex string, or null if it is not one. */
export function hexBytes(rawTx: string): Buffer | null {
  const body = rawTx.startsWith('0x') || rawTx.startsWith('0X') ? rawTx.slice(2) : rawTx
  if (body.length === 0 || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) return null
  return Buffer.from(body, 'hex')
}

/**
 * The id a signed EVM transaction will be known by: keccak256 of exactly its bytes.
 *
 * See the file header. This is the function the whole "record the broadcast before confirming"
 * rule rests on, because it means the hash exists before anything is sent.
 */
export function evmTxHash(rawTx: string): string | null {
  const bytes = hexBytes(rawTx)
  if (!bytes) return null
  return `0x${Buffer.from(keccak256(bytes)).toString('hex')}`
}

/* ------------------------------------------------------------------ ABI */

const WORD = 32

function padLeft(bytes: Buffer): Buffer {
  if (bytes.length > WORD) throw new ChainError('abi word overflow')
  return Buffer.concat([Buffer.alloc(WORD - bytes.length), bytes])
}

function padRight(bytes: Buffer): Buffer {
  const remainder = bytes.length % WORD
  return remainder === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(WORD - remainder)])
}

/**
 * The ABI types this service encodes and decodes. Deliberately six, and deliberately not a general
 * ABI codec: the only ABI it ever touches is `src/contracts/ForesightMarket.sol`, whose bytecode is
 * committed beside it. A general codec here would be a large amount of untested surface serving a
 * handful of call sites.
 */
export type AbiType = 'string' | 'address' | 'uint8' | 'uint16' | 'uint64' | 'uint256' | 'bool' | 'bytes32'

export interface AbiValue {
  readonly type: AbiType
  readonly value: string | bigint | boolean
}

/**
 * Encode arguments, head-and-tail.
 *
 * Static types go in the head; `string` is dynamic, so its head slot carries the offset from the
 * start of the argument block to its tail, and the tail is a length word followed by the UTF-8
 * bytes padded up to a word boundary. That is the whole of the ABI this service needs.
 */
export function encodeAbi(args: readonly AbiValue[]): Buffer {
  const heads: Buffer[] = []
  const tails: Buffer[] = []
  // The offsets are measured from the start of the argument block, so the head length has to be
  // known before any of them can be written. Every head is exactly one word, dynamic or not.
  let tailOffset = args.length * WORD

  for (const arg of args) {
    if (arg.type === 'string') {
      if (typeof arg.value !== 'string') throw new ChainError('string argument must be a string')
      const bytes = Buffer.from(arg.value, 'utf8')
      const tail = Buffer.concat([padLeft(toBytes(BigInt(bytes.length))), padRight(bytes)])
      heads.push(padLeft(toBytes(BigInt(tailOffset))))
      tails.push(tail)
      tailOffset += tail.length
      continue
    }
    if (arg.type === 'address') {
      if (typeof arg.value !== 'string' || !EVM_SHAPE.test(arg.value)) {
        throw new ChainError('address argument must be an EVM address')
      }
      heads.push(padLeft(Buffer.from(arg.value.slice(2).toLowerCase(), 'hex')))
      continue
    }
    if (arg.type === 'bytes32') {
      const bytes = typeof arg.value === 'string' ? hexBytes(arg.value) : null
      if (!bytes || bytes.length !== 32) throw new ChainError('bytes32 argument must be 32 hex bytes')
      heads.push(bytes)
      continue
    }
    if (arg.type === 'bool') {
      if (typeof arg.value !== 'boolean') throw new ChainError('bool argument must be a boolean')
      heads.push(padLeft(toBytes(arg.value ? 1n : 0n)))
      continue
    }
    // The unsigned integers. The bound is CHECKED rather than truncated: an amount silently
    // reduced mod 2^256 is a number nobody asked for on a path that moves money.
    if (typeof arg.value !== 'bigint') throw new ChainError(`${arg.type} argument must be a bigint`)
    if (arg.value < 0n) throw new ChainError(`${arg.type} argument must not be negative`)
    const bits = arg.type === 'uint8' ? 8n : arg.type === 'uint16' ? 16n : arg.type === 'uint64' ? 64n : 256n
    if (arg.value >= 1n << bits) throw new ChainError(`${arg.type} argument is out of range`)
    heads.push(padLeft(toBytes(arg.value)))
  }

  return Buffer.concat([...heads, ...tails])
}

/** Creation bytecode plus encoded constructor arguments, as the `data` field of a creation. */
export function creationData(bytecode: string, args: readonly AbiValue[]): string {
  const code = hexBytes(bytecode)
  if (!code || code.length === 0) throw new ChainError('creation bytecode is not hex')
  return `0x${Buffer.concat([code, encodeAbi(args)]).toString('hex')}`
}

/** The 4-byte selector of a canonical signature — `keccak256("stake(uint8)")[0:4]`. */
export function selector(signature: string): string {
  return `0x${Buffer.from(keccak256(Buffer.from(signature, 'utf8'))).subarray(0, 4).toString('hex')}`
}

/** The 32-byte event id an EVM log carries in `topics[0]`. */
export function topic0(signature: string): string {
  return `0x${Buffer.from(keccak256(Buffer.from(signature, 'utf8'))).toString('hex')}`
}

/** Calldata for a call: selector plus head-and-tail arguments. */
export function callData(signature: string, args: readonly AbiValue[]): string {
  return `${selector(signature)}${encodeAbi(args).toString('hex')}`
}

/**
 * Decode a static-type return or log body.
 *
 * Only the static types, which is all a log body or a view return in this repository ever carries —
 * `Staked(address,uint8,uint256,uint256,uint256)` and the market's views. A dynamic decoder would
 * be a hundred lines nothing here calls.
 */
export function decodeAbi(types: readonly AbiType[], data: string): readonly (string | bigint | boolean)[] {
  const bytes = hexBytes(data)
  if (!bytes) throw new ChainError('return data is not hex')
  if (bytes.length < types.length * WORD) throw new ChainError('return data is shorter than its declared types')
  return types.map((type, index) => {
    const word = bytes.subarray(index * WORD, (index + 1) * WORD)
    if (type === 'address') return toChecksumAddress(`0x${word.subarray(12).toString('hex')}`)
    if (type === 'bool') return word[WORD - 1] === 1
    if (type === 'bytes32') return `0x${word.toString('hex')}`
    if (type === 'string') throw new ChainError('decodeAbi does not decode dynamic types')
    return BigInt(`0x${word.toString('hex')}`)
  })
}

/* ------------------------------------------------------------------ fee bounds */

export interface FeeBounds {
  readonly minGasPriceWei: bigint
  readonly maxGasPriceWei: bigint
}

export class FeeOutOfBandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeeOutOfBandError'
  }
}

/**
 * The gas price one broadcast will bid, in wei per gas.
 *
 * Read from the node rather than configured: a constant mirrored in an environment file misprices
 * every transaction the day the chain's own price moves.
 *
 * Doubled, because the price is read when the job claims and the transaction is signed and sent a
 * few seconds later. A creation that underbids its own chain does not fail — it sits in a mempool
 * being neither mined nor refunded until an operator looks at it, which is the worst of the three
 * available outcomes, and for a resolution it is the outcome that holds up every winner's claim.
 *
 * **The ceiling is checked BEFORE the doubling**, deliberately. Checking after would make every
 * broadcast fail as soon as the real price passed half the ceiling, so the bound would bite at a
 * number nobody configured.
 */
export function gasPriceBid(quoted: bigint, bounds: FeeBounds): bigint {
  const base = quoted > bounds.minGasPriceWei ? quoted : bounds.minGasPriceWei
  if (base > bounds.maxGasPriceWei) {
    throw new FeeOutOfBandError(
      `the chain quotes ${base} wei/gas, above the ${bounds.maxGasPriceWei} ceiling this service will bid`,
    )
  }
  const bid = base * 2n
  return bid > bounds.maxGasPriceWei ? bounds.maxGasPriceWei : bid
}

/** The JSON-RPC transport. The seam every test substitutes; the adapter above it is the real one. */
export type JsonRpc = (method: string, params: readonly unknown[]) => Promise<unknown>

/**
 * EIP-55 checksum encoding, from `@cloudsforge/evm`.
 *
 * Re-exported so callers keep importing it from here. The implementation moved out
 * because five services held a byte-identical copy, and a checksum computed two ways
 * is a withdrawal refused for an address copied out of our own UI.
 */
export { toChecksumAddress }
