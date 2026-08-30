/**
 * The Kiln's upstream: `micro-studio`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS CLIENT USED TO POST `/v1/generations`. MICRO-STUDIO HAS NEVER SERVED THAT ROUTE.
 *
 * Driven, not read: against a running micro-studio on this estate, with a real
 * `service:tessera` token holding `studio:write`,
 *
 *     POST /v1/generations
 *     404 {"error":{"code":"not_found","message":"no route for POST /v1/generations"}}
 *
 * So Tessera's central creation mechanic — firing an object from a prompt — had never once been
 * able to succeed, and could not have been: the body it sent had a `prompt` field, a `kind` and a
 * `userId`, and studio's real generate route takes none of those three.
 *
 * The route table is `studio/src/server.ts` and it is nine routes long. The two that
 * matter here are `POST /v1/brand-kits` and `POST /v1/brand-kits/:id/generate`,
 * and the shape of the second is the reason firing is TWO calls rather than one:
 *
 *   **studio takes no prompt.** `POST /v1/brand-kits/:id/generate` reads `kind`, `width`,
 *   `height`, `format` and `backend` from the body and nothing else. The prompt is BUILT by
 *   studio, in `buildPrompt` (`studio/src/prompt.ts`), out of the kind's own style
 *   paragraph and the BRAND KIT's `stylePrompt` — and it is built once and stored on the job, so
 *   that "editing prompt.ts changes what a delivered asset claims to have been generated from"
 *   cannot happen. A caller therefore does not send a prompt; it puts the player's description on
 *   a kit, and the kit is what it generates against.
 *
 * That is not a workaround, it is the deliberate design of the service, and for `world_object` it
 * is better than what this client was doing: studio's `WORLD_OBJECT_STYLE`
 * (`studio/src/prompt.ts`) is the projection, the light and the ground, written once, on
 * studio's side, where every consumer gets the same one. This client used to keep its own copy of
 * that paragraph — two spellings of one brief, in two repositories, with nothing comparing them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * §9.1's flow, corrected against the source and then against the running service:
 *
 *   1. Tessera calls studio with a service token holding `studio:write`. A **service** principal
 *      skips ownership narrowing entirely — `assertOwned` returns early at
 *      `studio/src/server.ts` — and names the acting user via `body.userId` (`subjectOf`,
 *      `studio/src/server.ts`). So a title generates on a player's behalf without
 *      impersonating them. `subjectUserId` (`runtime/packages/auth/src/index.ts`) throws
 *      `no_subject_user` — a 401 — when a service omits it, so the kit CANNOT accidentally be
 *      owned by `service:tessera`; the brand kit belongs to the player, and it is checked below.
 *   2. Generate answers **202 with a `statusUrl`** (`studio/src/server.ts`). Generation is
 *      a leased job on studio's side too, so this client polls that URL rather than holding a
 *      socket open for a minute of diffusion.
 *   3. The status body is `{ job, provenance }` — **nested**, both halves. `job.status` is the
 *      state (`queued | running | succeeded | failed`, `generation.ts`) and the checksum is on
 *      `provenance`, not on `job`: `wireJob` (`server.ts`) does not carry it and
 *      `provenanceOf` (`generation.ts`) does. A client reading a flat body — which this
 *      one used to — sees neither field and waits until its deadline.
 *   4. The checksum comes back `sha256:<hex>` (`studio/src/assets.ts`) and IS the object's
 *      identity.
 *
 * **The polling here is inside a leased job, not a timer.** It is a bounded `await` loop with an
 * `AbortSignal`, run by `kiln.fire`, which is a leased job claimed `for update skip locked`. That
 * is a different thing from a `setInterval`: it holds a lease, it stops when the lease is lost or
 * the process drains, and exactly one replica is doing it.
 */

import { HttpClient } from '@cloudsforge/http'
import type { Logger } from '@cloudsforge/telemetry'
import { OBJECT_CANVAS, STUDIO_ASSET_KIND } from './kiln.ts'

/**
 * The kit's accent, which for a world object is not a colour anybody sees.
 *
 * `POST /v1/brand-kits` requires one and validates it against `ACCENT_PATTERN`
 * (`studio/src/brandkits.ts`). `buildPrompt` interpolates the accent only into
 * `brandStyle()`, and `world_object` takes `WORLD_OBJECT_STYLE` instead
 * (`studio/src/prompt.ts`) — "the accent is not interpolated into it at all — a world
 * object wears no product colour, because it is not chrome".
 *
 * So this is the estate's pinned GROUND (`brand/normalise_ground.py`, §2.1) rather than a
 * product accent, deliberately: a brand colour here would be a brand colour that is one edit to
 * somebody else's prompt file away from ending up on a player's chair.
 */
export const KIT_ACCENT = '#12100f'

/**
 * The clauses studio's world-object brief must still contain, checked against what studio SAYS it
 * generated from rather than against a copy of the paragraph kept here.
 *
 * These are §1.1's and §2.1's load-bearing claims: the projection is what makes one player's chair
 * sit in the same room as another's, and `#12100f` is what the cutout step keys against, so a
 * generation on any other ground cannot be given transparency at all.
 *
 * Checked, and NOT enforced. The prompt is returned on `provenance` after the bytes exist and
 * after the owner's cap has been settled — refusing there would throw away something already paid
 * for over a brief the player did not choose. So a mismatch is a loud warning on the firing and a
 * red assertion in `kiln.live.test.ts`, which is the place that can still act on it.
 *
 * Matched case-INSENSITIVELY, and that is a correction made by running it rather than a
 * precaution: the first version of this list matched exactly and went red against a real firing on
 * `painterly gouache` and `no outline`. Studio's paragraph is prose, and both happen to begin
 * sentences — "Painterly gouache with visible brush economy…", "No outline, no bevel, no gloss".
 * A capital letter at a sentence boundary is not a change to the brief, and a check that treats it
 * as one is a check that will be edited away the first time it cries wolf. `containsBrief` below
 * is the one place the comparison is made, so the test and the warning cannot disagree about it.
 */
export const REQUIRED_PROMPT_CLAUSES: readonly string[] = Object.freeze([
  'painterly gouache',
  '2:1 dimetric',
  '#12100f',
  'no outline',
  'no bevel',
  'no gloss',
])

/** The clauses of `REQUIRED_PROMPT_CLAUSES` a prompt does NOT contain. Empty is the good answer. */
export function briefClausesMissingFrom(prompt: string): readonly string[] {
  const haystack = prompt.toLowerCase()
  return REQUIRED_PROMPT_CLAUSES.filter((clause) => !haystack.includes(clause.toLowerCase()))
}

export interface KitInput {
  readonly objectId: string
  /** `user:<uuid>` — the AUTHOR, read off the object row and never off a token. */
  readonly authorSubject: string
  /** The player's own words. Studio composes the brief around them; this client does not. */
  readonly description: string
}

export interface StartInput {
  readonly brandKitId: string
}

export interface AwaitInput {
  readonly statusUrl: string
  readonly signal: AbortSignal
}

export interface StartedGeneration {
  readonly generationJobId: string
  readonly statusUrl: string
}

export interface GenerateOutcome {
  /** `sha256:<64 hex>` — studio's own spelling, carried through without reformatting. */
  readonly checksum: string
  /** The prompt studio built and stored. Recorded so what was asked for is auditable. */
  readonly prompt: string
  /**
   * MEASURED off the bytes by studio (`outcome.bytes.includes(C2PA_MARKER)`,
   * `studio/src/backend.ts`) — and **not published on the job status**.
   *
   * `wireJob` and `provenanceOf` both omit it; it exists on the ASSET
   * (the `Asset` interface, `studio/src/assets.ts`) and on the `studio.asset.created` event,
   * neither of which this service can reach. So this is `null` — "not measured here" — rather than
   * `false`. `false` is an assertion, and it would be an assertion that was wrong in the invisible
   * direction on every single firing, which is precisely §2.2's "a repo that asserts it is a repo
   * that will be wrong quietly". The read below is by field name, so the day studio publishes it
   * the value flows through with no change here.
   */
  readonly c2pa: boolean | null
}

export interface StudioClient {
  /** `POST /v1/brand-kits`. The kit the player's description lives on. */
  createKit(input: KitInput): Promise<{ brandKitId: string }>
  /** `POST /v1/brand-kits/:id/generate`. Answers 202; returns where to poll. */
  startGeneration(input: StartInput): Promise<StartedGeneration>
  /** Polls `GET /v1/jobs/:id` until the job is `succeeded` or `failed`. */
  awaitGeneration(input: AwaitInput): Promise<GenerateOutcome>
}

export class StudioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudioError'
  }
}

export interface StudioClientOptions {
  readonly baseUrl: string
  /** A live service token holding `studio:write`. A function, because a token expires. */
  readonly token: () => Promise<string>
  readonly pollIntervalMs?: number
  readonly maxWaitMs?: number
  readonly logger?: Logger
  /** Test seam. */
  readonly client?: Pick<HttpClient, 'request'>
}

/**
 * The kit name for one object, and it is the object id because a retry has to find it again.
 *
 * `brand_kits_owner_name_uniq` (`studio/src/migrations.ts`) makes a repeated name a 409, and
 * studio serves no route that looks a kit up by name — so a name derived from anything varying
 * (a timestamp, a random suffix) leaks a kit per attempt, and a name that is stable but whose id
 * this service did not keep wedges the firing for ever. Hence `objects.studio_brand_kit_id`,
 * written the moment studio answers.
 */
export function kitNameFor(objectId: string): string {
  return `tessera-object-${objectId}`
}

/** `user:<uuid>` → `<uuid>`. Studio's `subjectOf` prefixes `user:` back on. */
function userIdOf(subject: string): string {
  return subject.startsWith('user:') ? subject.slice('user:'.length) : subject
}

export function createStudioClient(options: StudioClientOptions): StudioClient {
  const http = options.client ?? new HttpClient({ baseUrl: options.baseUrl, name: 'studio' })
  const pollIntervalMs = options.pollIntervalMs ?? 2_000
  const maxWaitMs = options.maxWaitMs ?? 5 * 60_000

  const authorize = async (): Promise<Record<string, string>> => ({
    authorization: `Bearer ${await options.token()}`,
  })

  return {
    async createKit(input) {
      const description = input.description.trim()
      if (description.length === 0) {
        // Refused HERE rather than discovered as a 500 inside studio: `buildPrompt` throws
        // outright on a `world_object` with an empty `stylePrompt`
        // (`studio/src/prompt.ts`), because "a firing with no description would otherwise
        // silently generate 'a Tessera', which is not an object anybody asked for".
        throw new StudioError('a firing has no description to build a prompt from')
      }
      const created = await http.request('/v1/brand-kits', {
        method: 'POST',
        deadlineMs: 15_000,
        headers: await authorize(),
        body: {
          // Names the acting user WITHOUT impersonating them — the shape studio's service lane
          // exists for (`subjectOf`, studio/src/server.ts). Omitting it is a 401, not a
          // kit quietly owned by `service:tessera`.
          userId: userIdOf(input.authorSubject),
          name: kitNameFor(input.objectId),
          accent: KIT_ACCENT,
          // The player's words, and only the player's words. Studio wraps them:
          // "The object is: <stylePrompt>" (`studio/src/prompt.ts`).
          stylePrompt: description.slice(0, 2_000),
        },
      })

      const kit = (created as { brandKit?: unknown }).brandKit
      const brandKitId = readString(kit, 'id')
      if (!brandKitId) throw new StudioError('studio created a brand kit with no id')

      // ═══════════════════════════════════════════════════════════════════════════════════════
      // THE OWNER IS READ BACK AND CHECKED, BECAUSE THE FAILURE IT CATCHES IS SILENT.
      //
      // A kit owned by `service:tessera` instead of by the player would generate, deliver and
      // look perfect, and every asset a creator ever fired would belong to the platform. This
      // estate has already shipped that exact shape once in market — a listing whose seller was
      // the literal string `service:tessera`, settling correctly, paying the creator nothing
      // (migration 11). One equality is cheaper than finding out that way twice.
      // ═══════════════════════════════════════════════════════════════════════════════════════
      const owner = readString(kit, 'ownerSubject')
      if (owner !== input.authorSubject) {
        throw new StudioError(
          `studio recorded the brand kit's owner as ${owner ?? 'nothing'}, not ${input.authorSubject}`,
        )
      }
      return { brandKitId }
    },

    async startGeneration(input) {
      const started = await http.request(`/v1/brand-kits/${encodeURIComponent(input.brandKitId)}/generate`, {
        method: 'POST',
        deadlineMs: 15_000,
        headers: await authorize(),
        body: {
          kind: STUDIO_ASSET_KIND,
          // `width`/`height`, NEVER `aspect_ratio`. FLUX ignores aspect_ratio; the wire contract
          // is pinned at studio/src/backend.ts and the lesson is repeated in all three
          // asset repos' generator headers. Both are multiples of 16 — FLUX floors to a 16-pixel
          // grid (studio/src/specs.ts) — so 512 needs no rounding.
          width: OBJECT_CANVAS,
          height: OBJECT_CANVAS,
        },
      })

      const statusUrl = readString(started, 'statusUrl')
      if (!statusUrl) throw new StudioError('studio returned no statusUrl')
      const generationJobId = readString((started as { job?: unknown }).job, 'id')
      if (!generationJobId) throw new StudioError('studio returned no generation job id')
      return { generationJobId, statusUrl }
    },

    async awaitGeneration(input) {
      const deadline = Date.now() + maxWaitMs
      while (Date.now() < deadline) {
        if (input.signal.aborted) throw new StudioError('the firing was aborted')
        const body = await http.request(pathOf(input.statusUrl), {
          method: 'GET',
          deadlineMs: 10_000,
          headers: await authorize(),
        })

        // Both halves nested, both read from where studio actually puts them.
        const job = (body as { job?: unknown }).job
        const provenance = (body as { provenance?: unknown }).provenance
        const state = readString(job, 'status')

        if (state === 'succeeded') {
          const checksum = readString(provenance, 'checksum')
          if (!checksum) throw new StudioError('studio reported success with no checksum')
          if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) {
            // Refused rather than normalised: the checksum IS the object's identity, and a client
            // that reformatted it would be the one place two spellings of one address could be
            // born. `tessera_objects_are_their_bytes` is a unique index on this exact string.
            throw new StudioError(`studio returned a checksum of an unexpected shape: ${checksum}`)
          }
          const prompt = readString(provenance, 'prompt') ?? ''
          const missing = briefClausesMissingFrom(prompt)
          if (missing.length > 0) {
            // Loud, and not fatal. See REQUIRED_PROMPT_CLAUSES: the bytes are already paid for by
            // the time this is knowable.
            options.logger?.error('studio generated a world object off the world brief', {
              missing,
              statusUrl: input.statusUrl,
            })
          }
          return {
            checksum,
            prompt,
            // Read by name from BOTH shapes, defaulted to null and never to false. See the field.
            c2pa: readBoolean(provenance, 'c2pa') ?? readBoolean(job, 'c2pa') ?? null,
          }
        }

        if (state === 'failed') {
          const code = readString(job, 'errorCode')
          const detail = readString(job, 'errorDetail')
          throw new StudioError(
            [code, detail].filter(Boolean).join(': ') || 'studio reported the generation failed',
          )
        }

        if (state !== 'queued' && state !== 'running') {
          // A state studio's own union does not have (`GenerationStatus`, generation.ts).
          // Refused rather than treated as pending, which would spin until the deadline and then
          // report a timeout for what is actually a contract change.
          throw new StudioError(`studio reported an unknown generation status: ${state ?? 'none'}`)
        }

        await sleep(pollIntervalMs, input.signal)
      }
      throw new StudioError(`studio did not finish within ${maxWaitMs}ms`)
    },
  }
}

function pathOf(statusUrl: string): string {
  try {
    const parsed = new URL(statusUrl)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return statusUrl.startsWith('/') ? statusUrl : `/${statusUrl}`
  }
}

function readString(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = (value as Record<string, unknown>)[field]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function readBoolean(value: unknown, field: string): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = (value as Record<string, unknown>)[field]
  return typeof v === 'boolean' ? v : undefined
}

/**
 * An abortable sleep.
 *
 * `setTimeout`, not `setInterval`, and it does no domain work — it waits between two polls inside
 * a leased job. The CI grep at `service-ci.yml` looks for `setInterval`; this is the
 * shape it is not looking for, and the reason is real rather than a technicality: an interval
 * fires whether or not the previous tick finished and outlives the lease that authorised it.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
