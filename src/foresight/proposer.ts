/**
 * The idea pipeline's outside world: a web search, and a model that drafts questions.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **UNCONFIGURED IS A SUPPORTED MODE.**
 *
 * Same discipline as `micro-notify`'s SMTP: a deployment with no search endpoint and no model
 * endpoint is a working deployment. The pipeline runs, records that it had nothing to propose, and
 * the operator queue stays empty. It does not crash, it does not retry into a dead-letter, and it
 * does not log an error every six hours for a thing nobody has configured yet.
 *
 * The reason this matters more here than for email: the AI is the least essential part of this
 * product and the most likely to be unavailable. An operator can write a market question by hand —
 * `POST /ideas` with `origin: 'operator'` is the same path — and every market this platform ever
 * runs could be authored that way. The pipeline is a convenience that suggests; a service that fell
 * over when its suggester was absent would have the dependency exactly backwards.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## One interface, and the adapter behind it is replaceable
 *
 * There is no vendor name in this file and no vendor SDK in `package.json`. What the pipeline needs
 * is: give me some recent public material about these topics, and turn it into candidate questions
 * with resolution criteria. Both are HTTP calls to endpoints named in the environment, with the
 * request and response shapes below. A deployment points them at whatever it uses.
 *
 * ## What comes back is DATA, not instructions
 *
 * The text a search returns and the text a model returns are untrusted input. They are stored,
 * shown to an operator and never executed, never used to select a code path, and never allowed to
 * name a category that is not in the allowlist — `validateProposal` runs on every candidate before
 * it is stored, and a candidate that fails is dropped with a counted reason rather than repaired.
 * A model that returns `{"category": "anything"}` produces no row.
 */

import { createHash } from 'node:crypto'
import { HttpClient } from '@cloudsforge/http'
import { NO_SCOPES_REQUIRED } from '@cloudsforge/contracts-auth'
import { CATEGORIES, CATEGORY_VERSION } from './categories.ts'
import type { IdeaSource, ProposalInput } from './ideas.ts'

/**
 * **None, and there is no scope in the estate that could apply to either peer.**
 *
 * This is the one token-bearing client in foresight whose peers are not CloudsForge services. Both
 * `HttpClient`s below (:184, :191) are pointed at endpoints named in the environment — a web search
 * API and a model endpoint — and the bearers they present, `searchToken` and `proposerToken`, are
 * third-party API keys an operator pasted in. Neither is minted by `micro-identity`, neither is
 * validated against `@cloudsforge/contracts-auth`, and neither is checked against any scope by the
 * far end. Granting foresight something here would not change one byte that leaves this file; it
 * would only put a real capability on a real token that nothing will ever consult, which is the
 * least-privilege rule broken in the one direction that is silent (AD-05).
 *
 * The header above is why this is stable rather than an accident of the current deployment: there
 * is no vendor name in this file and no vendor SDK in `package.json` deliberately, so the peers are
 * whatever a deployment points them at, and "whatever a deployment points them at" is never
 * something identity can mint for. Foresight's real outbound demands are declared by the modules
 * that have the call sites — its admin-api, custody, indexer, ledger and policy clients — and are
 * derived from those.
 *
 * It is stated out loud rather than left silent because `micro-deploy`'s `derive-grants.mjs` reads
 * any module that builds an `HttpClient` and names a bearer ANYWHERE in the file as one presenting
 * an estate credential (`NAMES_A_BEARER`, `deploy/scripts/derive-grants.mjs:280`), and by that test
 * this file qualifies twice over. The test is deliberately loose and should stay that way:
 * narrowing it to the constructor call once missed `admin-api/src/upstreams.ts`, which attaches its
 * bearer sixteen lines after building the client, and a false negative there produces NO grant at
 * all rather than a wrong one. So the module that knows the answer is the one that says it.
 *
 * Until now the answer lived in another repository. `micro-deploy` carried a hand-written entry for
 * this file in `compose/estate/grant-gaps.json` reading `"scopes": []`, describing it as "the one
 * token-bearing client in the estate whose peers are NOT CloudsForge services". That is a copy of a
 * fact that lives here, and copies rot — the entry is deleted in the same window as this line
 * lands, so the estate is never in a state where a gap is recorded for a module that no longer has
 * one. `./pricingclient.ts:73` is the same verdict in this repository for the opposite reason: its
 * peer IS a CloudsForge service, and the route it calls is ungated.
 */
export const PROPOSER_SCOPES = NO_SCOPES_REQUIRED

/** What one pipeline run produced. `proposals` may be empty, and empty is not an error. */
export interface ProposalRun {
  readonly proposals: readonly ProposalInput[]
  /** Why there was nothing, when there was nothing. Recorded, shown, and counted. */
  readonly reason: 'ok' | 'not_configured' | 'no_results' | 'no_candidates' | 'upstream_failed'
  readonly searchQuery: string | null
  readonly modelId: string | null
}

export interface Proposer {
  /** True when a deployment has actually wired this up. `/readyz` reports it as a soft probe. */
  readonly configured: boolean
  propose(input: { readonly topic: string; readonly count: number; readonly now: Date }): Promise<ProposalRun>
}

/**
 * The prompt, in one place, versioned by its own hash.
 *
 * `promptSha256` on every idea is the hash of exactly this text with the topic substituted, so a
 * proposal can always be traced to the instructions that produced it. Changing the wording changes
 * every subsequent hash, which is the point: two proposals with different prompt hashes were not
 * asked the same thing, and an operator reviewing a suspicious batch can see that at a glance.
 *
 * The allowlist is stated INSIDE the prompt as well as enforced after it. Not because the model can
 * be trusted to obey — `validateProposal` is the enforcement — but because a model told the rules
 * produces far fewer candidates that have to be thrown away, and a queue of rejects is a queue an
 * operator stops reading.
 */
export const PROMPT_TEMPLATE = [
  'You are drafting candidate questions for a parimutuel prediction market.',
  '',
  'Return ONLY a JSON array. Each element must be an object with exactly these keys:',
  '  question               a yes/no question about a future event',
  '  resolutionCriteria     what exactly makes it YES, and what makes it NO, in full',
  '  category               one of the allowed categories, listed below',
  '  resolutionSourceKind   one of the source kinds allowed for that category',
  '  resolutionSourceRef    the specific source — a URL, an endpoint, a named index',
  '  closeTimeIso           an ISO-8601 UTC instant after which no stake is accepted',
  '',
  'Allowed categories and their permitted source kinds:',
  ...CATEGORIES.map((c) => `  ${c.id}: ${c.description} Source kinds: ${c.sourceKinds.join(', ')}.`),
  '',
  'Absolute refusals. Do not produce a question that:',
  '  - names a private individual',
  '  - concerns a death, an injury or an act of violence',
  '  - could not be settled from a public source you have named above',
  '',
  'The resolution criteria are a contract with strangers who will stake money on your wording.',
  'Name the venue, the timezone, the exact figure and the tie-break. If you cannot, do not',
  'produce the question.',
  '',
  'Topic: {{TOPIC}}',
  'Produce at most {{COUNT}} questions. Fewer is better than vague.',
].join('\n')

export function renderPrompt(topic: string, count: number): string {
  return PROMPT_TEMPLATE.replace('{{TOPIC}}', topic).replace('{{COUNT}}', String(count))
}

/** The proposer a deployment with nothing configured gets. Not a stub — the supported mode. */
export const UNCONFIGURED_PROPOSER: Proposer = Object.freeze({
  configured: false,
  propose: async () =>
    Object.freeze({
      proposals: Object.freeze([]),
      reason: 'not_configured' as const,
      searchQuery: null,
      modelId: null,
    }),
})

export interface HttpProposerOptions {
  readonly searchUrl: string | undefined
  readonly searchToken: string | undefined
  readonly proposerUrl: string | undefined
  readonly proposerToken: string | undefined
  readonly modelId: string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

interface SearchHit {
  readonly url?: unknown
  readonly title?: unknown
  readonly snippet?: unknown
}

interface Candidate {
  readonly question?: unknown
  readonly resolutionCriteria?: unknown
  readonly category?: unknown
  readonly resolutionSourceKind?: unknown
  readonly resolutionSourceRef?: unknown
  readonly closeTimeIso?: unknown
}

/**
 * Build a proposer, or the unconfigured one.
 *
 * ALL FOUR of search url, search token, model url and model id must be present. A partially
 * configured proposer is worse than none: it fails on every run with an error that looks like an
 * outage, and an operator spends a morning on it before finding a missing variable.
 */
export function createProposer(options: HttpProposerOptions): Proposer {
  const { searchUrl, proposerUrl, modelId } = options
  if (!searchUrl || !proposerUrl || !modelId) return UNCONFIGURED_PROPOSER

  const search = new HttpClient({
    baseUrl: new URL(searchUrl).origin,
    name: 'idea-search',
    defaultDeadlineMs: options.deadlineMs,
    ...(options.searchToken ? { token: () => options.searchToken } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const model = new HttpClient({
    baseUrl: new URL(proposerUrl).origin,
    name: 'idea-model',
    defaultDeadlineMs: options.deadlineMs,
    ...(options.proposerToken ? { token: () => options.proposerToken } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const searchPath = pathOf(searchUrl)
  const modelPath = pathOf(proposerUrl)

  return {
    configured: true,
    async propose({ topic, count, now }) {
      const prompt = renderPrompt(topic, count)
      const promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex')

      let sources: IdeaSource[]
      try {
        const found = await search.request<{ results?: unknown }>(searchPath, {
          method: 'POST',
          body: { query: topic, limit: 10 },
        })
        sources = (Array.isArray(found.results) ? (found.results as SearchHit[]) : [])
          .filter((hit): hit is SearchHit & { url: string } => typeof hit.url === 'string')
          .slice(0, 10)
          .map((hit) => ({
            url: hit.url,
            title: typeof hit.title === 'string' ? hit.title.slice(0, 300) : hit.url,
            retrievedAt: now.toISOString(),
          }))
      } catch {
        // Not a throw. A search that is having a bad afternoon produces no proposals this run and
        // is tried again on the next; the job completes, so nothing backs off into a dead letter.
        return { proposals: [], reason: 'upstream_failed', searchQuery: topic, modelId }
      }
      if (sources.length === 0) {
        return { proposals: [], reason: 'no_results', searchQuery: topic, modelId }
      }

      let candidates: Candidate[]
      try {
        const answered = await model.request<{ candidates?: unknown }>(modelPath, {
          method: 'POST',
          body: {
            model: modelId,
            prompt,
            // The sources go to the model as CONTEXT and come back on the row as PROVENANCE. The
            // two are the same list on purpose: what the operator sees cited is what the model was
            // given, not a list assembled afterwards to look convincing.
            context: sources.map((s) => ({ url: s.url, title: s.title })),
            maxCandidates: count,
          },
        })
        candidates = Array.isArray(answered.candidates) ? (answered.candidates as Candidate[]) : []
      } catch {
        return { proposals: [], reason: 'upstream_failed', searchQuery: topic, modelId }
      }

      const proposals: ProposalInput[] = []
      for (const candidate of candidates.slice(0, count)) {
        const parsed = toProposal(candidate, {
          searchQuery: topic,
          sources,
          modelId,
          promptSha256,
        })
        // A candidate that does not parse is DROPPED, never patched. Filling in a missing
        // resolution source with a plausible default is how a market ends up settling from
        // somewhere nobody named.
        if (parsed) proposals.push(parsed)
      }

      if (proposals.length === 0) {
        return { proposals: [], reason: 'no_candidates', searchQuery: topic, modelId }
      }
      return { proposals, reason: 'ok', searchQuery: topic, modelId }
    },
  }
}

function pathOf(url: string): string {
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}

/**
 * Turn one untrusted candidate into a proposal, or null.
 *
 * Every field is checked for TYPE here; `validateProposal` in `ideas.ts` checks it for MEANING, and
 * is the only thing that decides whether a category is allowed. Splitting it this way means a
 * proposal an operator typed and a proposal a model produced pass through exactly the same
 * meaning-check, which is what stops the two paths drifting.
 */
export function toProposal(
  candidate: Candidate,
  provenance: {
    readonly searchQuery: string
    readonly sources: readonly IdeaSource[]
    readonly modelId: string
    readonly promptSha256: string
  },
): ProposalInput | null {
  const { question, resolutionCriteria, category, resolutionSourceKind, resolutionSourceRef, closeTimeIso } = candidate
  if (
    typeof question !== 'string' ||
    typeof resolutionCriteria !== 'string' ||
    typeof category !== 'string' ||
    typeof resolutionSourceKind !== 'string' ||
    typeof resolutionSourceRef !== 'string' ||
    typeof closeTimeIso !== 'string'
  ) {
    return null
  }
  const closeTime = new Date(closeTimeIso)
  if (Number.isNaN(closeTime.getTime())) return null

  return {
    question,
    resolutionCriteria,
    category,
    // **The version is this repository's, never the model's.** A model that returned a category
    // version would be asserting which rules it was judged under, and it does not get to.
    categoryVersion: CATEGORY_VERSION,
    resolutionSourceKind,
    resolutionSourceRef,
    suggestedCloseTime: closeTime,
    origin: 'model',
    searchQuery: provenance.searchQuery,
    sources: provenance.sources,
    modelId: provenance.modelId,
    promptSha256: provenance.promptSha256,
  }
}
