/**
 * The image backends, and the fallback chain between them.
 *
 * The model is **FLUX 2 Pro from Black Forest Labs, served by Azure AI Foundry**. Not Azure
 * OpenAI: the route, the request body and the error vocabulary are all different, and an
 * OpenAI-shaped client against this endpoint fails in ways that read like outages.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE VERIFIED CONTRACT.** Every line here was confirmed against the live resource, and three
 * of them contradict what the URL implies.
 *
 *     POST {endpoint}{imagePath}?api-version={apiVersion}
 *                                         e.g. …/providers/blackforestlabs/v1/flux-2-pro
 *                                              ?api-version=2025-04-01-preview
 *     api-key: <key>
 *     content-type: application/json
 *     {"model":"FLUX.2-pro","prompt":"…","output_format":"png","width":1024,"height":384}
 *
 *     200 {"created":…,"data":[{"b64_json":"…"}],"request_meta":{"cost":3,"output_mp":0.38,…}}
 *
 *     The cost is NOT flat at every size: 3 per image up to roughly 1MP, measured at 4.5 for a
 *     1920×768 (the Aetherholm hero). Read request_meta.cost rather than assuming.
 *
 * 0. **`api-version` IS MANDATORY, AND OMITTING IT IS WHY THIS SERVICE HAD NEVER GENERATED AN
 *    IMAGE.** It is numbered zero because it precedes every other trap here: without the query
 *    parameter the resource answers **`404`** to a correctly-spelled model at a correctly-spelled
 *    path with a valid key — indistinguishable, from the client's side, from a model that was
 *    never deployed. That is exactly how it was read. `preflight.ts` reported "no configured model
 *    is deployed", the placeholder backend took over as designed, and **all 40 assets this estate
 *    ever produced were placeholders with an empty `model` column** while every test stayed green.
 *
 *    Proved by driving it: ten model spellings across three hosts and five routes all returned
 *    404, and the control plane simultaneously reported `FLUX.2-pro` deployed, `Succeeded`, with
 *    `imageGenerations: true`. The single difference between the failing call and the working one
 *    is `?api-version=2025-04-01-preview`.
 *
 *    It is CONFIGURABLE rather than hardcoded because Azure retires preview versions on a
 *    schedule, and a pinned constant here would turn a deprecation into an outage nobody could
 *    fix without a release. It is REQUIRED rather than optional because the failure it prevents is
 *    silent.
 *
 * 1. **`model` is REQUIRED in the body**, even though the path already names the model. Omitting
 *    it is `400 {"error":{"code":"no_model_name"}}`. This is the single most surprising thing
 *    about the API and `bodyFor` below exists so it cannot be omitted by construction.
 *
 * 2. **The body spelling and the path spelling differ.** The path segment is `flux-2-pro`; the
 *    model name is `FLUX.2-pro`, with dots. Sending the path spelling as the model is
 *    `404 DeploymentNotFound` — which looks exactly like a model that was never deployed.
 *
 * 3. **`width`/`height` are honoured; `aspect_ratio` and `size` are silently IGNORED.** Probed:
 *    `aspect_ratio` of 1:1, 8:3, 21:9 and 40:21 all returned 1024x1024, and `size:"1024x384"`
 *    returned 1024x1024, while `width:1024,height:384` returned exactly 1024x384. A parameter
 *    that is accepted and ignored is worse than one that is rejected, because nothing fails.
 *
 * 4. **Delivered dimensions floor to a multiple of 16.** `1200x630` returns `1200x624` and
 *    `1200x632` also returns `1200x624`, while `1280x640` is exact. See `requestSizeFor` in
 *    specs.ts for what this service asks for instead, and sizing.ts for what it records.
 *
 * 5. **`output_format:"png"` is required for a PNG.** Without it the response is JPEG.
 *
 * 6. Every image carries **C2PA provenance and a Microsoft invisible watermark**, roughly 100KB
 *    of it. That is a licensing and disclosure fact, so it is recorded on the asset rather than
 *    left as a surprise in the bytes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## THE FALLBACK RULE
 *
 * The primary model falls back to the secondary on **404, 429 and 5xx**, and on a transport
 * fault. It does **not** fall back on 400.
 *
 * A 400 is the service telling us the request was wrong: a prompt the safety filter refused, a
 * missing `model` field. That request is wrong at the fallback model too, for exactly the same
 * reason, so retrying it cannot succeed — it can only spend the fallback's quota and turn one
 * clear refusal into two, with a misleading "trying fallback model" line in between.
 * `asset-forge` removed its own gpt-image-2 → gpt-image-1 chain over precisely this
 * (`model.ts`: "every asset paid for a failed request and printed a warning that read like a
 * real fault before the fallback quietly succeeded").
 *
 * 401 and 403 do not fall back either, for a different reason: authentication is a property of the
 * **resource**, not of the model. A revoked key is revoked for both, and retrying makes a
 * credential problem look like a capacity problem.
 *
 * A transport fault DOES fall back. We do not know whether the request was even received, and one
 * more request cannot double-charge for an image that was never returned.
 *
 * ## Two response shapes
 *
 * FLUX answers `b64_json` today. The `url` shape is handled anyway because it is the shape the
 * dall-e family returns and the one `asset-forge` shipped a bug against for months —
 * `res.data?.[0]?.b64_json` threw *after* the image was billed. The image is billed either way,
 * so a `url` response is fetched rather than thrown away.
 */

import { placeholderSvg } from './placeholder.ts'
import type { AssetSpec } from './specs.ts'
import type { FluxConfig } from './env.ts'

export type BackendName = 'flux' | 'placeholder'

export interface ImageRequest {
  readonly prompt: string
  readonly spec: AssetSpec
  /**
   * The pixel size to ASK for, which is not always the spec's size: FLUX floors each dimension to
   * a multiple of 16, so `requestSizeFor` rounds up. `specs.ts` owns that arithmetic.
   */
  readonly requestWidth: number
  readonly requestHeight: number
  /** Carried for the placeholder backend, which draws the kit rather than the prompt. */
  readonly kitName: string
  readonly accent: string
}

/**
 * What happened on one attempt against one model.
 *
 * Recorded whether it succeeded or not. A job that shows `[FLUX.2-pro not_found, FLUX.1-pro
 * not_found]` has told an operator, months later and without a log search, that neither model was
 * deployed on the day that asset was made.
 */
export type AttemptOutcome =
  | 'ok'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'bad_request'
  | 'unauthorised'
  | 'transport_error'
  | 'bad_response'

export interface Attempt {
  readonly backend: BackendName
  readonly model: string | null
  readonly outcome: AttemptOutcome
  readonly status: number | null
  /** Operator-facing. Truncated, and never carries a key: see `redact` below. */
  readonly detail: string
  readonly durationMs: number
}

/** The provider's own accounting of one call, recorded verbatim as provenance. */
export interface ProviderMeta {
  /** `request_meta.cost`, in provider units. Flat 3 per image at every size probed. */
  readonly cost: number | null
  readonly outputMegapixels: number | null
  readonly totalPixels: number | null
}

export interface ImageResult {
  readonly bytes: Buffer
  readonly format: 'png' | 'svg'
  readonly backend: BackendName
  readonly model: string | null
  /** `1024x384` — what was ASKED for, which the delivered image may floor away from. */
  readonly requestedSize: string | null
  readonly costUsdMicros: bigint
  readonly providerMeta: ProviderMeta | null
  /** True when the bytes carry C2PA provenance. A disclosure fact, not a curiosity. */
  readonly c2pa: boolean
  readonly attempts: readonly Attempt[]
}

/**
 * Why a generation could not happen, in a code a client can branch on.
 *
 * The distinction between `no_backend_available` and `backend_unavailable` is the one that
 * matters operationally: the first means nothing is configured or deployed and a human must go
 * and create something, the second means what is configured did not answer and retrying is
 * reasonable. `asset-forge` reports both as "asset-forge failed:" plus a sentence.
 */
export type ImageErrorCode =
  | 'no_backend_available'
  | 'backend_unavailable'
  | 'bad_request'
  | 'unauthorised'

export class ImageBackendError extends Error {
  readonly code: ImageErrorCode
  readonly attempts: readonly Attempt[]

  constructor(code: ImageErrorCode, message: string, attempts: readonly Attempt[] = []) {
    super(message)
    this.name = 'ImageBackendError'
    this.code = code
    this.attempts = attempts
  }
}

export interface ImageBackend {
  readonly name: BackendName
  /** The model names this backend will try, primary first. Empty for the placeholder. */
  readonly models: readonly string[]
  generate(request: ImageRequest, signal: AbortSignal): Promise<ImageResult>
}

/** Injected so tests drive a real HTTP server rather than a stubbed module. */
export interface BackendDeps {
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  /** Wall-clock ceiling for one attempt, including fetching a `url` response. */
  readonly deadlineMs?: number
  /** Estimated price of one image, for the credit reservation. From `env.imagePriceUsdMicros`. */
  readonly priceUsdMicros?: bigint
}

/* ------------------------------------------------------------------------ shared HTTP */

/**
 * A key can appear in an upstream error body, and an attempt detail is stored in the database and
 * rendered by `GET /v1/jobs/:id`. Anything that looks like a credential is removed before it can
 * get that far.
 *
 * Deliberately crude and deliberately over-broad: the cost of redacting a harmless string is a
 * slightly less helpful error message, and the cost of not redacting a key is the key. The bound
 * is 32 characters, and the live key is 84.
 */
function redact(value: string): string {
  return value
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

interface GenerationResponse {
  readonly data?: ReadonlyArray<{ readonly b64_json?: unknown; readonly url?: unknown }>
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
  readonly request_meta?: Record<string, unknown>
}

function classify(status: number): { outcome: AttemptOutcome; fallback: boolean } {
  // 404: the model is not deployed. `DeploymentNotFound` — the state seven of the eight FLUX names
  // probed on this resource are in. It must reach the fallback, and when the fallback is absent it
  // must surface as `no_backend_available`, not as a 500.
  if (status === 404) return { outcome: 'not_found', fallback: true }
  // 429: capacity. A second model usually has its own quota, so this is the case the whole
  // fallback arrangement pays for.
  if (status === 429) return { outcome: 'rate_limited', fallback: true }
  if (status >= 500) return { outcome: 'server_error', fallback: true }
  // 401/403: a property of the resource, not of the model. See the file header.
  if (status === 401 || status === 403) return { outcome: 'unauthorised', fallback: false }
  // Everything else in the 4xx range is the request being wrong, and it is wrong at both models.
  // 400 is the case that matters and the one the tests pin — `no_model_name` arrives here.
  return { outcome: 'bad_request', fallback: false }
}

/**
 * Combine the caller's cancellation with this attempt's deadline.
 *
 * Both, not either: the caller's signal is how a drain stops an in-flight generation, and the
 * deadline is what stops one hung request holding a job lease until the lease expires and a second
 * replica starts the same generation again.
 */
function attemptSignal(outer: AbortSignal, deadlineMs: number): AbortSignal {
  return AbortSignal.any([outer, AbortSignal.timeout(deadlineMs)])
}

/**
 * The request body, built in one place so `model` cannot go missing.
 *
 * Exported because the "the body always carries `model`" test asserts on it directly. That trap
 * is the most likely thing in this file to regress: the model name is already in the URL, so it
 * reads like duplication, and deleting it produces a 400 that says nothing about the URL.
 */
export function bodyFor(model: string, request: ImageRequest): Record<string, unknown> {
  return {
    // REQUIRED. See trap 1 in the file header. Never make this conditional.
    model,
    prompt: request.prompt,
    // Required for PNG; the default is JPEG, and a JPEG brand mark has no transparency and
    // visible ringing on flat vector edges.
    output_format: 'png',
    // width/height, never aspect_ratio or size — see trap 3.
    width: request.requestWidth,
    height: request.requestHeight,
  }
}

function readProviderMeta(meta: Record<string, unknown> | undefined): ProviderMeta | null {
  if (!meta) return null
  const num = (key: string): number | null => {
    const value = meta[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  return { cost: num('cost'), outputMegapixels: num('output_mp'), totalPixels: num('total_pixels') }
}

/** The C2PA box identifier, which sits in the PNG's metadata chunks. */
const C2PA_MARKER = Buffer.from('c2pa')

interface CallOutcome {
  readonly bytes: Buffer | null
  readonly meta: ProviderMeta | null
  readonly attempt: Attempt
  readonly fallback: boolean
}

/**
 * One POST to the images endpoint, and the parse of whatever came back.
 *
 * Kept separate from the model loop so the two response shapes are parsed in exactly one place;
 * a second copy is a second place for the `url`-shape bug to survive.
 */
async function callImagesApi(args: {
  readonly model: string
  readonly url: string
  readonly apiKey: string
  readonly body: Record<string, unknown>
  readonly fetchImpl: typeof globalThis.fetch
  readonly now: () => number
  readonly signal: AbortSignal
  readonly deadlineMs: number
}): Promise<CallOutcome> {
  const startedAt = args.now()
  const attempt = (outcome: AttemptOutcome, status: number | null, detail: string): Attempt => ({
    backend: 'flux',
    model: args.model,
    outcome,
    status,
    detail: redact(detail),
    durationMs: Math.max(0, args.now() - startedAt),
  })

  let response: Response
  try {
    response = await args.fetchImpl(args.url, {
      method: 'POST',
      // `api-key` rather than `Authorization: Bearer`. Both work on this resource; `api-key` is
      // the one Azure documents for Foundry and the one that does not collide with a gateway
      // rewriting Authorization.
      headers: { 'content-type': 'application/json', 'api-key': args.apiKey },
      body: JSON.stringify(args.body),
      signal: attemptSignal(args.signal, args.deadlineMs),
    })
  } catch (err) {
    // Includes the deadline firing. We do not know whether the request was received, so the
    // fallback is allowed: one more request cannot double-charge for an image never returned.
    const message = err instanceof Error ? err.message : String(err)
    return { bytes: null, meta: null, attempt: attempt('transport_error', null, message), fallback: true }
  }

  if (!response.ok) {
    const { outcome, fallback } = classify(response.status)
    // Bounded read: an upstream that answers a megabyte of HTML on a 502 must not be buffered
    // whole just to produce a one-line detail.
    const text = (await response.text().catch(() => '')).slice(0, 2_000)
    let detail = text
    try {
      const parsed = JSON.parse(text) as GenerationResponse
      const code = typeof parsed.error?.code === 'string' ? parsed.error.code : ''
      const message = typeof parsed.error?.message === 'string' ? parsed.error.message : ''
      if (code || message) detail = `${code}${code && message ? ': ' : ''}${message}`
    } catch {
      // Not JSON. The raw text, truncated, is still the most useful thing available.
    }
    return { bytes: null, meta: null, attempt: attempt(outcome, response.status, detail), fallback }
  }

  let parsed: GenerationResponse
  try {
    parsed = (await response.json()) as GenerationResponse
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // A 200 that will not parse may fall back, but it is recorded distinctly: "the API changed
    // shape" and "the model is gone" call for very different responses from a human.
    return { bytes: null, meta: null, attempt: attempt('bad_response', 200, message), fallback: true }
  }

  const meta = readProviderMeta(parsed.request_meta)
  const image = parsed.data?.[0]
  if (!image) {
    return {
      bytes: null,
      meta,
      attempt: attempt('bad_response', 200, 'the API returned no image'),
      fallback: true,
    }
  }

  if (typeof image.b64_json === 'string' && image.b64_json.length > 0) {
    return {
      bytes: Buffer.from(image.b64_json, 'base64'),
      meta,
      attempt: attempt('ok', 200, 'b64_json'),
      fallback: false,
    }
  }

  if (typeof image.url === 'string' && image.url.length > 0) {
    // The image is already billed. Fetching it is the only way not to throw the charge away, and
    // such URLs expire, so it cannot be deferred to a later job either.
    try {
      const blob = await args.fetchImpl(image.url, {
        // No credentials: the URL is pre-signed, and sending the api-key to whatever host it names
        // would leak it to a redirect.
        signal: attemptSignal(args.signal, args.deadlineMs),
      })
      if (!blob.ok) {
        return {
          bytes: null,
          meta,
          attempt: attempt('bad_response', blob.status, 'could not fetch the generated image'),
          fallback: true,
        }
      }
      return {
        bytes: Buffer.from(await blob.arrayBuffer()),
        meta,
        attempt: attempt('ok', 200, 'url'),
        fallback: false,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { bytes: null, meta, attempt: attempt('bad_response', null, message), fallback: true }
    }
  }

  return {
    bytes: null,
    meta,
    attempt: attempt('bad_response', 200, 'the API returned neither image data nor a URL'),
    fallback: true,
  }
}

/* ------------------------------------------------------------------------ flux */

/**
 * FLUX on Azure AI Foundry: primary model, then fallback, under the rule in the file header.
 *
 * The chain is over MODELS at one endpoint, which is what this resource actually offers. Only
 * `FLUX.2-pro` is deployed on it — `FLUX.1.5-pro`, `FLUX.1-pro`, `FLUX-1.1-pro`, `FLUX.1.1-pro`,
 * `FLUX.1-Kontext-pro`, `FLUX.2-flex` and `FLUX.2-dev` were all probed and all seven answer 404 —
 * so `STUDIO_IMAGE_FALLBACK_MODEL` is empty by default and the chain is one model long. It is
 * configuration rather than a hardcoded pair precisely so that adopting a second model later is
 * an environment change and not a release.
 */
export function fluxBackend(config: FluxConfig, deps: BackendDeps = {}): ImageBackend {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? (() => Date.now())
  const deadlineMs = deps.deadlineMs ?? 120_000
  const priceUsdMicros = deps.priceUsdMicros ?? 60_000n
  const models = [config.model, config.fallbackModel].filter((name): name is string => name.length > 0)
  // `api-version` is not optional. See trap 0 in the file header: without it this resource answers
  // 404 to a correctly-spelled model, which is how this service spent its entire history serving
  // placeholders while believing no model was deployed.
  const url = `${config.endpoint}${config.imagePath}?api-version=${encodeURIComponent(config.apiVersion)}`

  return {
    name: 'flux',
    models,

    async generate(request, signal) {
      const attempts: Attempt[] = []
      if (models.length === 0) {
        throw new ImageBackendError('no_backend_available', 'no image model is configured', attempts)
      }

      for (const model of models) {
        const outcome = await callImagesApi({
          model,
          url,
          apiKey: config.apiKey,
          body: bodyFor(model, request),
          fetchImpl,
          now,
          signal,
          deadlineMs,
        })
        attempts.push(outcome.attempt)

        if (outcome.bytes) {
          return {
            bytes: outcome.bytes,
            format: 'png',
            backend: 'flux',
            model,
            requestedSize: `${request.requestWidth}x${request.requestHeight}`,
            costUsdMicros: priceUsdMicros,
            providerMeta: outcome.meta,
            // Read from the bytes rather than assumed from the vendor: the disclosure obligation
            // attaches to what was actually delivered.
            c2pa: outcome.bytes.includes(C2PA_MARKER),
            attempts,
          }
        }
        // The rule. A 400, a 401 or a 403 stops here; 404, 429, 5xx and transport faults continue
        // to the next model.
        if (!outcome.fallback) break
      }

      throw fluxFailure(attempts)
    },
  }
}

/** Turn the attempt log into the one error code that best describes why nothing was produced. */
function fluxFailure(attempts: readonly Attempt[]): ImageBackendError {
  const last = attempts[attempts.length - 1]
  const describe = attempts
    .map((a) => `${a.model ?? a.backend}: ${a.outcome}${a.status ? ` ${a.status}` : ''}`)
    .join(', ')

  if (last?.outcome === 'bad_request') {
    return new ImageBackendError(
      'bad_request',
      `the image request was refused and was deliberately not retried on the fallback model — ${last.detail}`,
      attempts,
    )
  }
  if (last?.outcome === 'unauthorised') {
    return new ImageBackendError(
      'unauthorised',
      'the Foundry resource refused the key; authentication is per-resource, so the fallback model was not tried',
      attempts,
    )
  }
  // Every configured model answered 404. No retry fixes this: somebody has to deploy a model, or
  // correct the spelling — `flux-2-pro` and `FLUX.2-pro` are different strings to this API.
  if (attempts.length > 0 && attempts.every((a) => a.outcome === 'not_found')) {
    return new ImageBackendError(
      'no_backend_available',
      `no configured model is deployed (${describe}) — check the spelling (the model name uses dots, e.g. FLUX.2-pro, not the hyphenated path segment) or deploy one`,
      attempts,
    )
  }
  return new ImageBackendError(
    'backend_unavailable',
    `every configured model failed (${describe})`,
    attempts,
  )
}

/* ------------------------------------------------------------------------ placeholder */

/**
 * The deterministic labelled SVG, as `asset-forge` does offline.
 *
 * It cannot fail and it costs nothing, so it is the only backend that never appears in an error
 * path — and it is the reason a resource with no deployed model degrades rather than breaks.
 */
export function placeholderBackend(): ImageBackend {
  return {
    name: 'placeholder',
    models: [],

    async generate(request) {
      const svg = placeholderSvg({
        kitName: request.kitName,
        accent: request.accent,
        // Authored at the spec's exact pixels, which is why this is the one backend that always
        // produces `sizing = 'exact'`.
        spec: request.spec,
      })
      return {
        bytes: Buffer.from(svg, 'utf8'),
        format: 'svg',
        backend: 'placeholder',
        model: null,
        requestedSize: `${request.spec.width}x${request.spec.height}`,
        costUsdMicros: 0n,
        providerMeta: null,
        c2pa: false,
        attempts: [
          {
            backend: 'placeholder',
            model: null,
            outcome: 'ok',
            status: null,
            detail: 'deterministic offline SVG',
            durationMs: 0,
          },
        ],
      }
    },
  }
}

/* ------------------------------------------------------------------------ selection */

/** What a caller may ask for. `auto` is the chain; the others pin one backend. */
export type BackendChoice = 'auto' | BackendName

export function isBackendChoice(value: string): value is BackendChoice {
  return value === 'auto' || value === 'flux' || value === 'placeholder'
}

export interface BackendSet {
  readonly flux: ImageBackend | null
  readonly placeholder: ImageBackend
}

/**
 * Resolve a request's choice into the ordered list of backends to try.
 *
 * `auto` is FLUX, then the placeholder. Falling through to a labelled SVG is a real degradation
 * and it is what keeps the service useful while only one model is deployed — but it is never
 * silent: the asset row records `backend = 'placeholder'`, every attempt that failed on the way
 * there is stored on the job, and `GET /v1/backend` says why. A caller who must have real art
 * asks for `flux` by name and gets a typed error instead of an SVG.
 */
export function resolveChain(set: BackendSet, choice: BackendChoice): readonly ImageBackend[] {
  switch (choice) {
    case 'placeholder':
      return [set.placeholder]
    case 'flux':
      return set.flux ? [set.flux] : []
    case 'auto':
    default:
      return set.flux ? [set.flux, set.placeholder] : [set.placeholder]
  }
}

/**
 * Run a chain, in order, and report every attempt made along the whole of it.
 *
 * A backend that refuses the REQUEST (`bad_request`, `unauthorised`) stops the chain, and that
 * includes stopping it before the placeholder. A prompt the safety filter refused must surface as
 * a refusal; answering it with an SVG would hide a content decision behind a picture of a circle,
 * and a revoked key must not present as "we generated a placeholder today, and yesterday, and the
 * day before".
 */
export async function generateThrough(
  chain: readonly ImageBackend[],
  request: ImageRequest,
  signal: AbortSignal,
): Promise<ImageResult> {
  if (chain.length === 0) {
    throw new ImageBackendError(
      'no_backend_available',
      'no image backend is configured for that selection',
      [],
    )
  }
  const attempts: Attempt[] = []
  let last: ImageBackendError | null = null

  for (const backend of chain) {
    try {
      const result = await backend.generate(request, signal)
      return { ...result, attempts: [...attempts, ...result.attempts] }
    } catch (err) {
      if (!(err instanceof ImageBackendError)) throw err
      attempts.push(...err.attempts)
      last = err
      if (err.code === 'bad_request' || err.code === 'unauthorised') break
    }
  }

  throw new ImageBackendError(
    last?.code ?? 'no_backend_available',
    last?.message ?? 'no image backend produced an image',
    attempts,
  )
}
