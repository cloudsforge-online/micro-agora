/**
 * The market document, and the hash of it that goes on chain.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE RESOLUTION SOURCE IS NAMED AT OPEN, AND THE CHAIN REMEMBERS THAT IT WAS.**
 *
 * 19-new-products.md §2.3.5 calls this "resolution honesty is structural", and structural is the
 * operative word: a promise that the operator will not shop for a friendlier source at resolution
 * time is worth nothing, and a database column recording the source is worth only as much as the
 * database's write history. So the whole document — question, criteria, source, close time, dispute
 * window — is serialised canonically here, hashed, and handed to the market's constructor as
 * `questionHash`. It is immutable from the moment the market exists.
 *
 * A bettor can therefore check, without asking anybody, that the criteria on the public page are
 * the criteria the market was deployed with. An operator who edited them afterwards would produce a
 * page whose hash does not match a contract nobody can change.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Canonical, which is the entire difficulty
 *
 * Two serialisations of one document that differ by a space produce two hashes, and the second one
 * makes the market page look forged. So the encoding here is deliberately rigid and deliberately
 * NOT `JSON.stringify` of an object literal: field order is fixed by the code rather than by
 * insertion order, every value is length-prefixed so that no pair of adjacent fields can be
 * confused with another pair (the classic concatenation ambiguity — `"ab"+"c"` and `"a"+"bc"`), and
 * strings are UTF-8 with no normalisation surprises left implicit.
 */

import { keccak256 } from '@cloudsforge/evm'

export interface QuestionDocument {
  /** The question, as a bettor reads it. Must be answerable YES or NO. */
  readonly question: string
  /** What exactly makes it YES, and what makes it NO. The contract with strangers. */
  readonly resolutionCriteria: string
  /** The allowlist category. `categories.ts`. */
  readonly category: string
  /** Which allowlist version was in force. */
  readonly categoryVersion: number
  /** The kind of source, from the category's own list. */
  readonly resolutionSourceKind: string
  /** The source itself — a URL, an endpoint, an index name. Named here, at open. */
  readonly resolutionSourceRef: string
  /** Unix seconds. No stake is accepted at or after this. */
  readonly closeTime: number
  /** Seconds between resolution and the first possible claim. */
  readonly disputeWindowSeconds: number
  /** Basis points of the losing pool taken on settlement. */
  readonly feeBps: number
}

/** The versioned envelope. A change to the encoding bumps this and produces different hashes. */
export const DOCUMENT_VERSION = 'cloudsforge.foresight.market/1'

function field(value: string): string {
  // Length-prefixed. Without this, `question` ending in a newline and `resolutionCriteria`
  // beginning with one would produce the same bytes as the fields shifted by a character, and two
  // different markets could share a hash.
  const bytes = Buffer.byteLength(value, 'utf8')
  return `${bytes}:${value}`
}

/**
 * The exact bytes that get hashed. Exported so the public market page can show them and a reader
 * can recompute the hash themselves rather than take the platform's word for it.
 */
export function canonicalDocument(doc: QuestionDocument): string {
  return [
    field(DOCUMENT_VERSION),
    field(doc.question),
    field(doc.resolutionCriteria),
    field(doc.category),
    field(String(doc.categoryVersion)),
    field(doc.resolutionSourceKind),
    field(doc.resolutionSourceRef),
    field(String(doc.closeTime)),
    field(String(doc.disputeWindowSeconds)),
    field(String(doc.feeBps)),
  ].join('')
}

/** `keccak256(canonicalDocument(doc))`, 0x-prefixed. This is the contract's `questionHash`. */
export function questionHash(doc: QuestionDocument): string {
  return `0x${Buffer.from(keccak256(Buffer.from(canonicalDocument(doc), 'utf8'))).toString('hex')}`
}
