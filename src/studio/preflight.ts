/**
 * Backend preflight — what `GET /v1/backend` answers, and what the readiness probe reads.
 *
 * ## Why this is not a deployment-list call
 *
 * An Azure **OpenAI** resource has `GET /openai/deployments`, which lists what it can serve. Azure
 * **AI Foundry** serving a partner model does not: the FLUX route is a provider path
 * (`/providers/blackforestlabs/v1/flux-2-pro`) and there is no cheap endpoint that enumerates the
 * models behind it. Asking for one and treating a 404 as "no models" would be an invented fact.
 *
 * So this file reports what it actually knows, and is explicit about how it knows it:
 *
 *   * `unverified` — the resource and model are configured, and nothing has called them yet. This
 *     is the honest state at boot, and it is deliberately NOT reported as a failure.
 *   * `observed`   — a real generation has happened and its outcome is reflected here. This is the
 *     best evidence available and it costs nothing, because the call was going to happen anyway.
 *   * `probe`      — a minimal generation was made on purpose, on demand.
 *
 * ## Why boot does not probe
 *
 * A probe is a real image and a real charge. A service that generated one on every boot would
 * spend money on every rolling restart, and a crash-looping replica would spend it repeatedly.
 * Probing is therefore opt-in (`GET /v1/backend?probe=1`), and the ordinary path learns from
 * traffic instead. Rule 8 also applies: there is no `setInterval` here, and a readiness scrape is
 * already periodic, so the scrape is when to re-read.
 *
 * ## Degraded, not failed
 *
 * The probe this file exports is **soft**. With no usable model the service still creates brand
 * kits, reads them, serves its own health, and generates through the placeholder backend; only
 * real art is unavailable. A hard probe would take the whole service out of the load balancer over
 * a dependency most of its routes never touch, turning a missing model into an outage. `/readyz`
 * answers **200 with `state: "degraded"`**, and `/v1/backend` carries the detail.
 */

import { fluxBackend, type Attempt, type BackendDeps, type ImageRequest } from './backend.ts'
import { ImageBackendError } from './backend.ts'
import type { FluxConfig } from './env.ts'
import type { Probe, ProbeResult } from '@cloudsforge/lifecycle'

/** How the report's `usable` was arrived at. Stated so nobody reads a guess as a measurement. */
export type Evidence = 'unverified' | 'observed' | 'probe'

export interface BackendReport {
  /** Which backend `auto` would reach first. */
  readonly selected: 'flux' | 'placeholder'
  /** The Foundry resource host. Never the key. */
  readonly endpoint: string | null
  readonly model: string | null
  /** Null when no fallback model is configured — which is the case on this resource. */
  readonly fallbackModel: string | null
  readonly usable: boolean
  readonly evidence: Evidence
  /** Why, in a sentence an operator can act on. Always populated, including when usable. */
  readonly reason: string
  readonly checkedAt: string
  /** The placeholder backend is always available; it is what runs when `usable` is false. */
  readonly placeholderAvailable: true
}

export interface PreflightDeps extends BackendDeps {
  /** A minimal image for the on-demand probe. Small on purpose: it is a real charge. */
  readonly probeWidth?: number
  readonly probeHeight?: number
}

function hostOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).host
  } catch {
    return null
  }
}

/**
 * Holds what is known about the image backend.
 *
 * Constructed with the Foundry config or without: a service with no resource still answers
 * `/v1/backend` with a truthful "not configured", which is a different sentence from "configured
 * and refusing" and needs to be.
 */
export class Preflight {
  readonly #config: FluxConfig | null
  readonly #deps: PreflightDeps
  readonly #now: () => number
  #usable: boolean
  #evidence: Evidence = 'unverified'
  #reason: string
  #checkedAt: number

  constructor(config: FluxConfig | null, deps: PreflightDeps = {}) {
    this.#config = config
    this.#deps = deps
    this.#now = deps.now ?? (() => Date.now())
    this.#checkedAt = this.#now()
    // Optimistic when configured, and labelled `unverified` so the optimism is visible. The
    // alternative — reporting `usable: false` until something proves otherwise — would put every
    // correctly configured service into `degraded` for as long as it happened to be idle.
    this.#usable = config !== null
    this.#reason = config
      ? `configured for ${config.model} on ${hostOf(config.endpoint) ?? 'the resource'}; no call has been made yet, so this is not a verified answer`
      : 'no image backend is configured — set AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_API_KEY and STUDIO_IMAGE_MODEL. The placeholder backend is available and may be requested by name.'
  }

  report(): BackendReport {
    const config = this.#config
    return {
      selected: config ? 'flux' : 'placeholder',
      endpoint: config ? hostOf(config.endpoint) : null,
      model: config?.model ?? null,
      fallbackModel: config?.fallbackModel && config.fallbackModel.length > 0 ? config.fallbackModel : null,
      usable: this.#usable,
      evidence: this.#evidence,
      reason: this.#reason,
      checkedAt: new Date(this.#checkedAt).toISOString(),
      placeholderAvailable: true,
    }
  }

  /**
   * Learn from a real generation's attempts.
   *
   * Called by the generation pipeline after every call, successful or not. This is what makes the
   * report reflect reality without spending anything: the traffic is the probe.
   *
   * Only FLUX attempts teach anything — a placeholder attempt says nothing about the model.
   */
  observe(attempts: readonly Attempt[]): void {
    const relevant = attempts.filter((attempt) => attempt.backend === 'flux')
    const last = relevant[relevant.length - 1]
    if (!last || !this.#config) return
    this.#checkedAt = this.#now()
    this.#evidence = 'observed'

    if (relevant.some((attempt) => attempt.outcome === 'ok')) {
      this.#usable = true
      this.#reason = `${last.model ?? this.#config.model} generated an image on ${hostOf(this.#config.endpoint) ?? 'the resource'}`
      return
    }
    this.#usable = false
    this.#reason = describeFailure(this.#config, relevant)
  }

  /**
   * Make a real, minimal generation on purpose. **This costs money.** On demand only.
   *
   * Useful in exactly one situation, which is the one that matters after a configuration change:
   * proving the model answers before a customer's job discovers that it does not.
   */
  async probe(): Promise<BackendReport> {
    const config = this.#config
    if (!config) return this.report()

    const width = this.#deps.probeWidth ?? 256
    const height = this.#deps.probeHeight ?? 256
    const request: ImageRequest = {
      prompt: 'A single flat orange circle centred on a plain dark field. No text.',
      spec: { kind: 'icon', width, height, format: 'png' },
      requestWidth: width,
      requestHeight: height,
      kitName: 'preflight',
      accent: '#ff4d00',
    }

    const backend = fluxBackend(config, this.#deps)
    this.#checkedAt = this.#now()
    this.#evidence = 'probe'
    try {
      const result = await backend.generate(request, AbortSignal.timeout(this.#deps.deadlineMs ?? 120_000))
      this.#usable = true
      this.#reason = `probe generated a ${result.bytes.length} byte ${result.format} with ${result.model}`
    } catch (err) {
      this.#usable = false
      this.#reason =
        err instanceof ImageBackendError
          ? describeFailure(config, err.attempts)
          : `the probe failed: ${err instanceof Error ? err.message : String(err)}`
    }
    return this.report()
  }
}

/**
 * Turn an attempt log into an operator-actionable sentence.
 *
 * The 404 case gets its own wording because the most likely cause is not a missing deployment at
 * all — it is the spelling. The path segment is `flux-2-pro` and the model name is `FLUX.2-pro`,
 * and sending the former as the latter is a 404 that says `DeploymentNotFound`.
 */
function describeFailure(config: FluxConfig, attempts: readonly Attempt[]): string {
  const host = hostOf(config.endpoint) ?? 'the resource'
  const summary = attempts
    .map((a) => `${a.model ?? 'model'}: ${a.outcome}${a.status ? ` ${a.status}` : ''}`)
    .join(', ')

  if (attempts.every((a) => a.outcome === 'not_found')) {
    return (
      `no configured model is deployed on ${host} (${summary}). Check the spelling first: the ` +
      `model name uses dots — FLUX.2-pro — and is NOT the hyphenated path segment flux-2-pro, ` +
      `which returns DeploymentNotFound. Otherwise deploy the model in the Foundry resource.`
    )
  }
  if (attempts.some((a) => a.outcome === 'unauthorised')) {
    return `${host} refused the key — AZURE_FOUNDRY_API_KEY is wrong, revoked, or belongs to another resource`
  }
  if (attempts.some((a) => a.outcome === 'bad_request')) {
    const last = attempts[attempts.length - 1]
    return `${host} refused the request and it was deliberately not retried on a fallback model: ${last?.detail ?? ''}`
  }
  return `${host} did not serve an image (${summary})`
}

/**
 * The readiness probe. **Soft**, deliberately — see the file header.
 *
 * `warn` and `fail` both produce `degraded` and both keep the replica in the balancer. The
 * distinction is carried into the report an operator reads: "nothing is deployed" is a different
 * incident from "the credential was rejected", and only one of them is somebody's mistake now.
 *
 * Synchronous by construction: it reads cached state and performs no I/O, so a probe can never be
 * the thing that spends money or the thing that hangs `/readyz`.
 */
export function imageBackendProbe(preflight: Preflight): Probe {
  return {
    name: 'image-backend',
    kind: 'soft',
    async check(): Promise<ProbeResult> {
      const report = preflight.report()
      if (report.usable) return { state: 'pass', detail: report.reason }
      const credential = /refused the key/.test(report.reason)
      return { state: credential ? 'fail' : 'warn', detail: report.reason }
    },
  }
}
