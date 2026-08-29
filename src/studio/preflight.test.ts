import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Preflight, imageBackendProbe } from './preflight.ts'
import { fluxBackend, ImageBackendError, type Attempt } from './backend.ts'
import { startFakeFlux } from './fakeflux.ts'
import { fluxConfigFor } from './testsupport.ts'

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  backend: 'flux',
  model: 'FLUX.2-pro',
  outcome: 'ok',
  status: 200,
  detail: 'b64_json',
  durationMs: 1,
  ...over,
})

test('an unconfigured backend reports not-configured, and it is not a failure', () => {
  const report = new Preflight(null).report()
  assert.equal(report.selected, 'placeholder')
  assert.equal(report.usable, false)
  assert.equal(report.endpoint, null)
  assert.equal(report.model, null)
  assert.equal(report.placeholderAvailable, true)
  assert.match(report.reason, /AZURE_FOUNDRY_ENDPOINT/)
})

test('a configured backend is optimistic and SAYS it is unverified', () => {
  // Reporting `usable: false` until something proves otherwise would put every correctly
  // configured service into `degraded` for as long as it happened to be idle. Saying `unverified`
  // is how the optimism stays honest.
  const report = new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com')).report()
  assert.equal(report.selected, 'flux')
  assert.equal(report.usable, true)
  assert.equal(report.evidence, 'unverified')
  assert.equal(report.endpoint, 'test01eastus01.services.ai.azure.com')
  assert.equal(report.model, 'FLUX.2-pro')
  assert.equal(report.fallbackModel, null, 'no fallback model is deployed on this resource')
  assert.match(report.reason, /no call has been made yet/)
})

test('the report never carries the key', () => {
  const config = fluxConfigFor('https://test01eastus01.services.ai.azure.com')
  const report = new Preflight(config).report()
  assert.equal(JSON.stringify(report).includes(config.apiKey), false)
})

test('a real call teaches the report, so the traffic is the probe', () => {
  const preflight = new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com'))
  preflight.observe([attempt()])

  const report = preflight.report()
  assert.equal(report.usable, true)
  assert.equal(report.evidence, 'observed')
  assert.match(report.reason, /generated an image/)
})

test('an observed 404 flips usable to false and names the spelling trap first', () => {
  // The likeliest cause of DeploymentNotFound here is not a missing deployment: it is sending the
  // hyphenated path spelling as the model name.
  const preflight = new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com'))
  preflight.observe([attempt({ outcome: 'not_found', status: 404, detail: 'DeploymentNotFound' })])

  const report = preflight.report()
  assert.equal(report.usable, false)
  assert.equal(report.evidence, 'observed')
  assert.match(report.reason, /dots/)
  assert.match(report.reason, /flux-2-pro/)
})

test('an observed 401 is reported as a credential problem, not a missing model', () => {
  const preflight = new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com'))
  preflight.observe([attempt({ outcome: 'unauthorised', status: 401 })])
  assert.match(preflight.report().reason, /refused the key/)
})

test('a placeholder attempt teaches nothing about the model', () => {
  const preflight = new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com'))
  preflight.observe([attempt({ backend: 'placeholder', model: null })])
  assert.equal(preflight.report().evidence, 'unverified')
})

test('the on-demand probe makes a real call and records what happened', async () => {
  const fake = await startFakeFlux()
  try {
    fake.script('FLUX.2-pro', { status: 200 })
    const preflight = new Preflight(fluxConfigFor(fake.url))
    const report = await preflight.probe()

    assert.equal(report.usable, true)
    assert.equal(report.evidence, 'probe')
    // Small on purpose: the probe is a real charge.
    assert.equal(fake.requests[0]?.body['width'], 256)
    assert.equal(fake.requests[0]?.body['model'], 'FLUX.2-pro')
  } finally {
    await fake.close()
  }
})

test('a probe against an undeployed model reports unusable rather than throwing', async () => {
  const fake = await startFakeFlux()
  try {
    const preflight = new Preflight(fluxConfigFor(fake.url))
    const report = await preflight.probe()
    assert.equal(report.usable, false)
    assert.match(report.reason, /no configured model is deployed/)
  } finally {
    await fake.close()
  }
})

/* --------------------------------------------------------------- readiness */

test('THE DIFFERENCE BETWEEN BROKEN AND DEGRADED: no model is 200 + degraded, never 503', async () => {
  // This is the requirement in one assertion. With no usable model the service still creates
  // brand kits, reads them and generates placeholders; taking it out of the balancer would turn
  // a missing model into an outage of everything else.
  const preflight = new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com'))
  preflight.observe([attempt({ outcome: 'not_found', status: 404 })])

  const lifecycle = new Lifecycle({ cacheMs: 0 })
  lifecycle.addProbe(imageBackendProbe(preflight))
  lifecycle.markReady()

  const report = await lifecycle.readyz()
  assert.equal(report.ready, true, 'the replica stays in the balancer')
  assert.equal(report.state, 'degraded')
  const check = report.checks.find((c) => c.name === 'image-backend')
  assert.equal(check?.kind, 'soft')
  assert.equal(check?.state, 'warn')
})

test('a rejected credential is a fail rather than a warn, and still only degrades', async () => {
  const preflight = new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com'))
  preflight.observe([attempt({ outcome: 'unauthorised', status: 401 })])

  const lifecycle = new Lifecycle({ cacheMs: 0 })
  lifecycle.addProbe(imageBackendProbe(preflight))
  lifecycle.markReady()

  const report = await lifecycle.readyz()
  assert.equal(report.checks.find((c) => c.name === 'image-backend')?.state, 'fail')
  // Soft, so a rejected image key still does not remove the service from rotation.
  assert.equal(report.ready, true)
  assert.equal(report.state, 'degraded')
})

test('a usable backend passes and the service is plain ready', async () => {
  const preflight = new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com'))
  preflight.observe([attempt()])

  const lifecycle = new Lifecycle({ cacheMs: 0 })
  lifecycle.addProbe(imageBackendProbe(preflight))
  lifecycle.markReady()

  const report = await lifecycle.readyz()
  assert.equal(report.state, 'ready')
  assert.equal(report.checks.find((c) => c.name === 'image-backend')?.state, 'pass')
})

test('the probe performs no I/O, so it can never spend money or hang readyz', async () => {
  // Constructed against an endpoint that would take a network timeout to fail. The probe must
  // still answer immediately, because it only reads cached state.
  const preflight = new Preflight(fluxConfigFor('https://192.0.2.1'))
  const probe = imageBackendProbe(preflight)
  const startedAt = Date.now()
  await probe.check(AbortSignal.timeout(30_000))
  assert.ok(Date.now() - startedAt < 100, 'the probe must not reach the network')
})

test('a failing generation feeds the report through observe', async () => {
  const fake = await startFakeFlux()
  try {
    const preflight = new Preflight(fluxConfigFor(fake.url))
    const backend = fluxBackend(fluxConfigFor(fake.url))
    const err = await backend
      .generate(
        {
          prompt: 'x',
          spec: { kind: 'mark', width: 1024, height: 1024, format: 'png' },
          requestWidth: 1024,
          requestHeight: 1024,
          kitName: 'k',
          accent: '#ff4d00',
        },
        AbortSignal.timeout(10_000),
      )
      .then(
        () => null,
        (e: unknown) => e,
      )
    assert.ok(err instanceof ImageBackendError)
    preflight.observe(err.attempts)
    assert.equal(preflight.report().usable, false)
  } finally {
    await fake.close()
  }
})
