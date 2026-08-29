/**
 * The chain, as three vocabularies that have to agree.
 *
 * This service runs on Hearth and nothing else in v1, which makes every table here one row long.
 * They are tables anyway, for the reason `micro-mint`'s `chains.ts` gives and `micro-settlement`
 * lost time to: `eth` versus `ethereum` is a 403 `binding_mismatch` from custody whose message
 * deliberately does not say which field was wrong, and a `toLowerCase()` that happens to work for
 * today's one chain is a landmine for tomorrow's second.
 *
 * **Nothing here redefines a chain constant.** Confirmation depth, decimals and the chain id all
 * come from `@cloudsforge/contracts-chain`, which is exact-pinned in `package.json` precisely so
 * that this service and custody cannot disagree about a chain id. A skew there is not a 500 — it is
 * a market contract bound to the wrong network, holding stakes nobody can claim.
 */

import { CHAINS, chainSpec, isConfirmed, type AssetCode, type ChainFamily, type Network } from '@cloudsforge/contracts-chain'

/** This service's own slug for a chain. One, today. */
export type ChainId = 'ember'

export const CHAIN_IDS: readonly ChainId[] = Object.freeze(['ember'])

export function isChainId(value: unknown): value is ChainId {
  return typeof value === 'string' && (CHAIN_IDS as readonly string[]).includes(value)
}

/** This service's slug → the asset code `contracts-chain` publishes constants under. */
const ASSET_OF: Readonly<Record<ChainId, AssetCode>> = Object.freeze({ ember: 'EMBER' })

/** This service's slug → custody's chain NAME. See the header, and `custodyclient.ts`. */
const CUSTODY_CHAIN_OF: Readonly<Record<ChainId, string>> = Object.freeze({ ember: 'ember' })

/** This service's slug → the indexer's chain path segment. */
const INDEXER_CHAIN_OF: Readonly<Record<ChainId, string>> = Object.freeze({ ember: 'ember' })

export function assetOf(chain: ChainId): AssetCode {
  return ASSET_OF[chain]
}

export function custodyChainOf(chain: ChainId): string {
  return CUSTODY_CHAIN_OF[chain]
}

export function indexerChainOf(chain: ChainId): string {
  return INDEXER_CHAIN_OF[chain]
}

export function familyOf(chain: ChainId): ChainFamily {
  return chainSpec(assetOf(chain)).family
}

/**
 * The EIP-155 chain id, or a throw.
 *
 * Never defaulted. A transaction signed with no chain id is replayable on every EVM network, and a
 * transaction signed with the WRONG one deploys a market to a chain the operator did not choose.
 * Custody refuses a chain-id-less signature at gate 3 (`custody/src/keys.ts`); this is the same
 * refusal on the near side, where the error message can still be useful.
 */
export function chainIdOf(chain: ChainId, network: Network): number {
  const ids = CHAINS[assetOf(chain)].chainId
  const id = ids?.[network]
  if (id === undefined) {
    throw new Error(`no EIP-155 chain id is published for ${chain} ${network}`)
  }
  return id
}

/** Smallest-unit exponent. EMBER is 18 — from the package, never restated here. */
export function decimalsOf(chain: ChainId): number {
  return chainSpec(assetOf(chain)).decimals
}

/**
 * Is a transaction at this depth safe to mirror as final?
 *
 * `contracts-chain` publishes EMBER at 60 confirmations, which is high because Hearth is a young
 * CPU-mined chain with no finality gadget and depth is the only defence available. The mirror uses
 * exactly this: below it, a position is recorded and shown with its `asOf`, and a reorg may still
 * take it back.
 */
export function confirmedAt(chain: ChainId, confirmations: number): boolean {
  return isConfirmed(assetOf(chain), confirmations)
}

/** How deep the chain wants before a mirror row stops being provisional. */
export function requiredConfirmations(chain: ChainId): number {
  return chainSpec(assetOf(chain)).confirmations
}

/** `ember:testnet` — the lease key for anything contended per chain. Settlement's spelling. */
export function chainKey(chain: ChainId, network: Network): string {
  return `${chain}:${network}`
}
