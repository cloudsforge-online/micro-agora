/**
 * The idea queue: what a machine proposed, and what a person did about it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **NOTHING A MODEL PRODUCES CAN OPEN A MARKET.**
 *
 * 19-new-products.md §2.3.3 states why, and the reason is not squeamishness about language models:
 * a market is a financial instrument and its resolution criteria are a contract with strangers.
 * Those get authored by someone accountable. A model that writes "will the price of X exceed Y"
 * without saying which venue, at which timestamp, in which currency, has written a question that
 * cannot be settled — and the person who discovers that is a bettor who has already staked.
 *
 * So the pipeline's output is a PROPOSAL. An operator approves, edits, or discards it, and the
 * approval is what a market is built from. This file is the proposal half; `markets.ts` is the
 * other half, and `migrations.ts` version 5 is the constraint that holds when both are wrong.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Provenance is stored because it is shown
 *
 * Query, sources, model id, prompt hash, timestamp — all five, on the row. Not for an audit nobody
 * reads: the sources are carried through to the PUBLIC market page, so a bettor can see why the
 * market exists and check the reasoning for themselves. A proposal whose provenance is missing is
 * not reviewable, and the `ideas_model_has_provenance` constraint means it cannot be stored.
 */

import { createHash } from 'node:crypto'
import { isCategory, isRefusal, isSourceKindFor } from './categories.ts'
import { imageView, type ImageReference } from './images.ts'
import { IDEA_IMAGED, type Db, type Emit, type Tx } from './outbox.ts'

export type IdeaStatus = 'proposed' | 'approved' | 'discarded'
export type IdeaOrigin = 'model' | 'operator'

/** One thing the search step found, kept exactly as it was found. */
export interface IdeaSource {
  readonly url: string
  readonly title: string
  /** When the pipeline retrieved it. A source that has since changed is still evidence. */
  readonly retrievedAt: string
}

export interface Idea {
  readonly id: string
  readonly status: IdeaStatus
  readonly question: string
  readonly resolutionCriteria: string
  readonly category: string
  readonly categoryVersion: number
  readonly resolutionSourceKind: string
  readonly resolutionSourceRef: string
  readonly suggestedCloseTime: Date
  readonly origin: IdeaOrigin
  readonly searchQuery: string | null
  readonly sources: readonly IdeaSource[]
  readonly modelId: string | null
  readonly promptSha256: string | null
  readonly proposedAt: Date
  readonly decidedBy: string | null
  readonly decidedAt: Date | null
  readonly decisionNote: string | null
  readonly refusalId: string | null
  /**
   * The proposal's header image, as a micro-studio reference. Both or neither —
   * `ideas_image_is_whole`.
   *
   * An image on an IDEA is not carried forward into the market built from it, and that omission is
   * deliberate. `createDraft` copies the fields the question is made of; a picture chosen while a
   * proposal was being judged is not one of them, and copying it would silently publish an
   * operator's working sketch on a page that takes money. A market's image is set on the market.
   */
  readonly imageAssetId: string | null
  readonly imageChecksum: string | null
}

export class IdeaError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'IdeaError'
    this.code = code
  }
}

/**
 * The prompt hash, so a proposal can be tied to the exact instructions that produced it.
 *
 * The prompt itself is deliberately NOT stored on the row. It is long, it is the same for every
 * proposal in a run, and — the reason that matters — a prompt is the one field of the provenance a
 * future author might paste a credential into. The hash answers "was this the prompt we published"
 * without the row ever holding the text.
 */
export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex')
}

/* ------------------------------------------------------------------ validation */

const MAX_QUESTION = 500
const MAX_CRITERIA = 4_000

export interface ProposalInput {
  readonly question: string
  readonly resolutionCriteria: string
  readonly category: string
  readonly categoryVersion: number
  readonly resolutionSourceKind: string
  readonly resolutionSourceRef: string
  readonly suggestedCloseTime: Date
  readonly origin: IdeaOrigin
  readonly searchQuery?: string | undefined
  readonly sources?: readonly IdeaSource[] | undefined
  readonly modelId?: string | undefined
  readonly promptSha256?: string | undefined
}

/**
 * Everything that must be true of a proposal before it is even stored.
 *
 * Run at the pipeline's edge rather than at approval, deliberately: a queue full of proposals an
 * operator cannot approve is a queue an operator stops reading, and the fastest way to fill one is
 * to accept whatever a model returned.
 */
export function validateProposal(input: ProposalInput, now: Date): void {
  const question = input.question.trim()
  if (question.length < 10 || question.length > MAX_QUESTION) {
    throw new IdeaError('bad_question', `question must be between 10 and ${MAX_QUESTION} characters`)
  }
  if (input.resolutionCriteria.trim().length < 20 || input.resolutionCriteria.length > MAX_CRITERIA) {
    throw new IdeaError(
      'bad_criteria',
      `resolution criteria must be between 20 and ${MAX_CRITERIA} characters — a question whose ` +
        'criteria fit in a sentence is usually a question that cannot be settled',
    )
  }
  if (!isCategory(input.category)) {
    // The allowlist is the enforcement, and it is an allowlist rather than a ban list for the
    // reason set out in categories.ts. An unknown category is refused, never defaulted.
    throw new IdeaError('bad_category', `${input.category} is not an allowed market category`)
  }
  if (!isSourceKindFor(input.category, input.resolutionSourceKind)) {
    throw new IdeaError(
      'bad_source_kind',
      `${input.resolutionSourceKind} is not a resolution source this category can be settled from`,
    )
  }
  if (input.resolutionSourceRef.trim().length === 0) {
    throw new IdeaError('no_source', 'a market must name its resolution source at open')
  }
  if (input.suggestedCloseTime.getTime() <= now.getTime()) {
    throw new IdeaError('bad_close_time', 'the suggested close time is already past')
  }
  if (input.origin === 'model') {
    if (!input.modelId || !input.promptSha256 || !input.searchQuery) {
      throw new IdeaError(
        'no_provenance',
        'a model-authored proposal must carry its model id, prompt hash and search query — a ' +
          'proposal an operator cannot trace is a proposal an operator cannot approve',
      )
    }
    if ((input.sources ?? []).length === 0) {
      throw new IdeaError('no_sources', 'a model-authored proposal must cite at least one source')
    }
  }
}

/* ------------------------------------------------------------------ store */

interface IdeaRow {
  readonly id: string
  readonly status: string
  readonly question: string
  readonly resolution_criteria: string
  readonly category: string
  readonly category_version: number
  readonly resolution_source_kind: string
  readonly resolution_source_ref: string
  readonly suggested_close_time: Date
  readonly origin: string
  readonly search_query: string | null
  readonly sources: unknown
  readonly model_id: string | null
  readonly prompt_sha256: string | null
  readonly proposed_at: Date
  readonly decided_by: string | null
  readonly decided_at: Date | null
  readonly decision_note: string | null
  readonly refusal_id: string | null
  readonly image_asset_id: string | null
  readonly image_checksum: string | null
}

const COLUMNS = `id, status, question, resolution_criteria, category, category_version,
  resolution_source_kind, resolution_source_ref, suggested_close_time, origin, search_query,
  sources, model_id, prompt_sha256, proposed_at, decided_by, decided_at, decision_note, refusal_id,
  image_asset_id, image_checksum`

function toIdea(row: IdeaRow): Idea {
  return {
    id: row.id,
    status: row.status as IdeaStatus,
    question: row.question,
    resolutionCriteria: row.resolution_criteria,
    category: row.category,
    categoryVersion: row.category_version,
    resolutionSourceKind: row.resolution_source_kind,
    resolutionSourceRef: row.resolution_source_ref,
    suggestedCloseTime: row.suggested_close_time,
    origin: row.origin as IdeaOrigin,
    searchQuery: row.search_query,
    sources: Array.isArray(row.sources) ? (row.sources as IdeaSource[]) : [],
    modelId: row.model_id,
    promptSha256: row.prompt_sha256,
    proposedAt: row.proposed_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    refusalId: row.refusal_id,
    imageAssetId: row.image_asset_id,
    imageChecksum: row.image_checksum,
  }
}

/**
 * What an idea looks like in a response.
 *
 * A view rather than the row, and it exists for one reason: `bytesUrl` is built from this
 * deployment's `STUDIO_PUBLIC_URL`, which the `Idea` value has no business knowing. The two raw
 * columns are dropped in favour of the composed `image`, so a client has one shape to read rather
 * than three fields it has to reassemble — and cannot reassemble them wrongly into half a
 * reference.
 */
export function ideaView(idea: Idea, studioPublicUrl?: string): Record<string, unknown> {
  const { imageAssetId, imageChecksum, ...rest } = idea
  return {
    ...rest,
    // Recorded, not verified — `images.ts`. The operator queue must not present a proposal's
    // picture as anything the platform has checked beyond its shape.
    image: imageView(imageAssetId, imageChecksum, studioPublicUrl),
  }
}

export async function insertIdea(sql: Db | Tx, input: ProposalInput, now: Date): Promise<Idea> {
  validateProposal(input, now)
  const rows = await sql<IdeaRow[]>`
    insert into ideas (
      question, resolution_criteria, category, category_version, resolution_source_kind,
      resolution_source_ref, suggested_close_time, origin, search_query, sources, model_id,
      prompt_sha256
    ) values (
      ${input.question.trim()},
      ${input.resolutionCriteria.trim()},
      ${input.category},
      ${input.categoryVersion},
      ${input.resolutionSourceKind},
      ${input.resolutionSourceRef.trim()},
      ${input.suggestedCloseTime},
      ${input.origin},
      ${input.searchQuery ?? null},
      ${sql.json((input.sources ?? []) as unknown as Record<string, never>)},
      ${input.modelId ?? null},
      ${input.promptSha256 ?? null}
    )
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new IdeaError('insert_failed', 'the proposal was not stored')
  return toIdea(row)
}

export async function findIdea(sql: Db | Tx, id: string): Promise<Idea | null> {
  const rows = await sql<IdeaRow[]>`select ${sql.unsafe(COLUMNS)} from ideas where id = ${id}`
  const row = rows[0]
  return row ? toIdea(row) : null
}

export async function listIdeas(
  sql: Db,
  status: IdeaStatus,
  limit: number,
): Promise<readonly Idea[]> {
  const rows = await sql<IdeaRow[]>`
    select ${sql.unsafe(COLUMNS)} from ideas
     where status = ${status}
     order by proposed_at desc
     limit ${limit}
  `
  return rows.map(toIdea)
}

/**
 * An operator approves a proposal.
 *
 * `operator` must be an `operator:<id>` subject and the conditional UPDATE is what makes this a
 * transition rather than an assignment: a proposal already decided is not re-decided, and the
 * caller is told so rather than silently overwriting somebody else's judgement.
 *
 * The `operator:` prefix is checked here AND by `ideas_decision_is_a_person` in the schema. Two
 * enforcements, the beacon discipline: this one gives a readable error, that one survives a future
 * code path that forgets to call this function.
 */
export async function approveIdea(
  sql: Db | Tx,
  id: string,
  operator: string,
  note: string | null,
  now: Date,
): Promise<Idea> {
  requireOperator(operator)
  const rows = await sql<IdeaRow[]>`
    update ideas
       set status = 'approved', decided_by = ${operator}, decided_at = ${now},
           decision_note = ${note}, updated_at = now()
     where id = ${id} and status = 'proposed'
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new IdeaError('not_proposed', 'no proposal with that id is awaiting a decision')
  return toIdea(row)
}

export async function discardIdea(
  sql: Db | Tx,
  id: string,
  operator: string,
  refusalId: string,
  note: string | null,
  now: Date,
): Promise<Idea> {
  requireOperator(operator)
  if (!isRefusal(refusalId)) {
    // From the versioned list, never free text. "How often do we refuse a proposal for putting a
    // named person in it" has to be a countable question, or the refusals are decoration.
    throw new IdeaError('bad_refusal', `${refusalId} is not one of the recorded refusal reasons`)
  }
  const rows = await sql<IdeaRow[]>`
    update ideas
       set status = 'discarded', decided_by = ${operator}, decided_at = ${now},
           decision_note = ${note}, refusal_id = ${refusalId}, updated_at = now()
     where id = ${id} and status = 'proposed'
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new IdeaError('not_proposed', 'no proposal with that id is awaiting a decision')
  return toIdea(row)
}

/**
 * An operator may edit a proposal before approving it — §2.3.3 says "approves, edits, or discards".
 *
 * Editing is only possible while the proposal is `proposed`. Once it is approved a market can be
 * built from it, and an edit after that would change the text a market's `questionHash` was
 * computed over, which is the exact dishonesty `questiondoc.ts` exists to prevent.
 */
export async function editIdea(
  sql: Db | Tx,
  id: string,
  patch: Pick<ProposalInput, 'question' | 'resolutionCriteria' | 'category' | 'categoryVersion' | 'resolutionSourceKind' | 'resolutionSourceRef' | 'suggestedCloseTime'>,
  now: Date,
): Promise<Idea> {
  const existing = await findIdea(sql, id)
  if (!existing) throw new IdeaError('not_found', 'no proposal with that id')
  if (existing.status !== 'proposed') {
    throw new IdeaError('not_proposed', 'a decided proposal cannot be edited; propose a new one')
  }
  // Validated as the whole proposal it will become, with the ORIGINAL origin and provenance. An
  // edit does not launder a model-authored proposal into an operator-authored one: the row still
  // says a machine wrote the first draft, which is what the public page shows.
  validateProposal({ ...existing, ...patch, searchQuery: existing.searchQuery ?? undefined, sources: existing.sources, modelId: existing.modelId ?? undefined, promptSha256: existing.promptSha256 ?? undefined }, now)

  const rows = await sql<IdeaRow[]>`
    update ideas
       set question = ${patch.question.trim()},
           resolution_criteria = ${patch.resolutionCriteria.trim()},
           category = ${patch.category},
           category_version = ${patch.categoryVersion},
           resolution_source_kind = ${patch.resolutionSourceKind},
           resolution_source_ref = ${patch.resolutionSourceRef.trim()},
           suggested_close_time = ${patch.suggestedCloseTime},
           updated_at = now()
     where id = ${id} and status = 'proposed'
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new IdeaError('not_proposed', 'the proposal was decided while it was being edited')
  return toIdea(row)
}

/**
 * Set or clear a proposal's header image. `null` clears.
 *
 * `setMarketImage`'s shape, verbatim, and for its reasons — one function writing both columns from
 * one nullable argument, so half a reference is not something this file can produce and
 * `ideas_image_is_whole` is the second enforcement rather than the only one.
 *
 * **Allowed in every status, unlike `editIdea` one function up.** That difference is deliberate
 * and it is worth stating, because the two look like the same kind of act and are not. Editing a
 * decided proposal is refused because a market may have been built from it and an edit would
 * change the text a `questionHash` was computed over — `questiondoc.ts`'s whole argument. An image
 * is in no document and in no hash, is copied into no market (see `Idea.imageAssetId`), and so
 * changing one on a discarded proposal changes nothing anybody has relied on. The narrower rule
 * would only mean an operator could not remove a picture from a proposal they had just refused,
 * which is precisely the proposal most likely to need one removed.
 */
export async function setIdeaImage(
  tx: Tx,
  emit: Emit,
  id: string,
  image: ImageReference | null,
  actor: string,
  now: Date,
  correlationId: string | null,
): Promise<Idea> {
  const rows = await tx<IdeaRow[]>`
    update ideas
       set image_asset_id = ${image?.assetId ?? null}::uuid,
           image_checksum = ${image?.checksum ?? null},
           updated_at     = ${now}
     where id = ${id}
    returning ${tx.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new IdeaError('not_found', 'no proposal with that id')
  const idea = toIdea(row)
  emit({
    topic: IDEA_IMAGED,
    key: id,
    // The reference, never a URL — see `setMarketImage` for why a durable event must not carry one.
    payload: {
      id: idea.id,
      status: idea.status,
      imageAssetId: idea.imageAssetId,
      imageChecksum: idea.imageChecksum,
      cleared: image === null,
    },
    actor,
    ...(correlationId ? { correlationId } : {}),
  })
  return idea
}

const OPERATOR = /^operator:[A-Za-z0-9._:-]{1,128}$/

export function requireOperator(subject: string): void {
  if (!OPERATOR.test(subject)) {
    throw new IdeaError(
      'not_an_operator',
      'only an operator subject may decide a proposal — a service cannot approve its own output',
    )
  }
}
