import { networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { SignJWT, generateKeyPair } from 'jose'
import { AUDIENCE, Verifier } from '@cloudsforge/auth'
import { Lifecycle, type Probe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics } from '@cloudsforge/telemetry'
import {
  READ_SCOPE,
  WRITE_SCOPE,
  createServer,
  registerServiceMetrics,
  type GenerationRequester,
  type ReadModel,
  type UploadReceiver,
} from './server.ts'
import { UploadRejected } from './imagebytes.ts'
import { UploadQuotaError, type SetVisibilityInput, type UploadInput } from './uploads.ts'
import { assetRootProbe, checkAssetRoot } from './assets.ts'
import { BrandKitConflictError, type BrandKit, type BrandKitStore, type CreateBrandKit } from './brandkits.ts'
import { CreditCapError } from './credits.ts'
import { buildPrompt } from './prompt.ts'
import { SpecError, specFor } from './specs.ts'
import { Preflight, imageBackendProbe } from './preflight.ts'
import { fluxConfigFor } from './testsupport.ts'
import type { GenerationJob, RequestGenerationInput } from './generation.ts'
import type { Asset } from './assets.ts'
import type { Attempt } from './backend.ts'

const ISSUER = 'https://identity.test'
const USER = '11111111-1111-4111-8111-111111111111'
const SUBJECT = `user:${USER}`

const keys = await generateKeyPair('RS256', { extractable: true })

const sign = (payload: Record<string, unknown>) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('15m')
    .sign(keys.privateKey)

/** A real `Verifier` over a local key set. Nothing here stubs the decision under test. */
const workingVerifier = () =>
  new Verifier({ jwksUrl: 'http://unused', issuer: ISSUER, keySet: (async () => keys.publicKey) as never })

const unreachableVerifier = () =>
  new Verifier({
    jwksUrl: 'http://down',
    issuer: ISSUER,
    keySet: (async () => {
      throw new Error('getaddrinfo EAI_AGAIN identity')
    }) as never,
  })

const KIT: BrandKit = {
  id: 'kit-1',
  ownerSubject: SUBJECT,
  name: 'CloudsForge',
  accent: '#ff4d00',
  palette: ['#12100f'],
  typography: {},
  stylePrompt: 'an anvil under a cloud arc',
  status: 'draft',
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
}

const JOB: GenerationJob = {
  id: 'job-1',
  brandKitId: KIT.id,
  ownerSubject: SUBJECT,
  spec: { kind: 'mark', width: 1024, height: 1024, format: 'png' },
  status: 'succeeded',
  prompt: 'a flat geometric mark in #ff4d00',
  backendChoice: 'auto',
  backend: 'flux',
  model: 'FLUX.2-pro',
  requestedSize: '1024x1024',
  attempts: [
    { backend: 'flux', model: 'FLUX.2-pro', outcome: 'ok', status: 200, detail: 'b64_json', durationMs: 20_000 },
  ],
  costEstimateUsdMicros: 60_000n,
  costActualUsdMicros: 60_000n,
  providerCostUnits: 3,
  creditState: 'settled',
  checksum: 'sha256:abc',
  errorCode: null,
  errorDetail: null,
  createdAt: '1970-01-01T00:00:00.000Z',
  startedAt: '1970-01-01T00:00:00.000Z',
  finishedAt: '1970-01-01T00:00:01.000Z',
}

const ASSET: Asset = {
  id: 'asset-1',
  origin: 'generated',
  brandKitId: KIT.id,
  generationJobId: JOB.id,
  ownerSubject: JOB.ownerSubject,
  kind: 'mark',
  format: 'png',
  mediaType: 'image/png',
  declaredWidth: 1024,
  declaredHeight: 1024,
  actualWidth: 1024,
  actualHeight: 1024,
  sizing: 'exact',
  storageUrl: 'memory://sha256:abc.png',
  checksum: 'sha256:abc',
  byteSize: 629_074,
  licence: 'cloudsforge-generated: commercial use permitted; AI-generated, C2PA provenance retained',
  c2pa: true,
  visibility: 'private',
  publishedAt: null,
  // Unanchored, because nothing can anchor it: Hearth has no Registry of Authorship contract.
  anchor: { state: 'unanchored', transactionHash: null, blockNumber: null, anchoredAt: null },
  createdAt: '1970-01-01T00:00:01.000Z',
}

/**
 * An uploaded asset owned by the same subject. No brand kit, no generation job — the shape
 * `assets_origin_consistent` permits for `origin='upload'`.
 */
const UPLOAD: Asset = {
  id: 'asset-upload-1',
  origin: 'upload',
  brandKitId: null,
  generationJobId: null,
  ownerSubject: JOB.ownerSubject,
  kind: 'upload',
  format: 'jpeg',
  mediaType: 'image/jpeg',
  declaredWidth: 64,
  declaredHeight: 48,
  actualWidth: 64,
  actualHeight: 48,
  sizing: 'exact',
  storageUrl: 'memory://sha256:def.jpeg',
  checksum: 'sha256:def',
  byteSize: 1_024,
  licence: 'cloudsforge-uploaded: supplied by the uploader',
  c2pa: false,
  visibility: 'private',
  publishedAt: null,
  anchor: { state: 'unanchored', transactionHash: null, blockNumber: null, anchoredAt: null },
  createdAt: '1970-01-01T00:00:02.000Z',
}

/**
 * The same asset, published. Its bytes are fetchable with NO token at all — which is the whole
 * reason visibility exists, because a browser sends no Authorization header on an `<img>` tag.
 */
const PUBLISHED: Asset = {
  ...UPLOAD,
  id: 'asset-public-1',
  visibility: 'public',
  publishedAt: '1970-01-01T00:00:03.000Z',
}

/** The stored bytes the `/bytes` route serves in these tests. */
const UPLOAD_BYTES = Buffer.from('not-a-real-jpeg-but-the-route-does-not-decode')

function memoryKits(): BrandKitStore & { rows: BrandKit[] } {
  const rows: BrandKit[] = []
  return {
    rows,
    async create(input: CreateBrandKit) {
      if (rows.some((r) => r.ownerSubject === input.ownerSubject && r.name === input.name)) {
        throw new BrandKitConflictError(`a brand kit named "${input.name}" already exists`)
      }
      const kit: BrandKit = {
        ...KIT,
        id: `kit-${rows.length + 1}`,
        ownerSubject: input.ownerSubject,
        name: input.name,
        accent: input.accent,
        palette: input.palette,
        typography: input.typography,
        stylePrompt: input.stylePrompt,
      }
      rows.push(kit)
      return kit
    },
    async find(id) {
      return rows.find((r) => r.id === id) ?? (id === KIT.id ? KIT : null)
    },
    async listForOwner(ownerSubject) {
      return rows.filter((r) => r.ownerSubject === ownerSubject)
    },
  }
}

const okAttempt: Attempt = {
  backend: 'flux',
  model: 'FLUX.2-pro',
  outcome: 'ok',
  status: 200,
  detail: 'b64_json',
  durationMs: 1,
}

interface Options {
  readonly probes?: Probe[]
  readonly ready?: boolean
  readonly verifier?: Verifier
  readonly preflight?: Preflight
  /** Injected into the generation port, to drive the refusal mappings. */
  readonly refuseWith?: Error
  /** Injected into the upload port, to drive the upload refusal mappings. */
  readonly uploadRefuseWith?: Error
}

interface Harness {
  readonly url: string
  readonly lifecycle: Lifecycle
  readonly metrics: Metrics
  readonly kits: BrandKitStore & { rows: BrandKit[] }
  readonly accepted: RequestGenerationInput[]
  /** Every upload the port received, so a test can assert what reached the pipeline. */
  readonly uploaded: UploadInput[]
  readonly visibilityChanges: SetVisibilityInput[]
}

async function withServer(options: Options, fn: (h: Harness) => Promise<void>): Promise<void> {
  const lifecycle = new Lifecycle({ cacheMs: 0 })
  for (const probe of options.probes ?? []) lifecycle.addProbe(probe)
  const metrics = registerServiceMetrics(registerHttpMetrics(new Metrics()))
  const kits = memoryKits()
  const accepted: RequestGenerationInput[] = []

  // Logs are discarded rather than silenced, so a serialisation failure in a log line still
  // surfaces as a thrown error rather than being hidden by a null logger.
  const logger = new Logger({ service: 'test', sink: () => {} })

  const reads: ReadModel = {
    async findJob(id) {
      return id === JOB.id ? JOB : null
    },
    async findAsset(id) {
      if (id === ASSET.id) return ASSET
      if (id === UPLOAD.id) return UPLOAD
      if (id === PUBLISHED.id) return PUBLISHED
      return null
    },
    async readBlob(checksum, format) {
      return checksum === UPLOAD.checksum && format === UPLOAD.format ? UPLOAD_BYTES : null
    },
    async listAssetsForKit(brandKitId) {
      return brandKitId === KIT.id ? [ASSET] : []
    },
  }

  // The generation port. These tests are about the HTTP surface; `generation.test.ts` drives the
  // real pipeline against a real database and a real endpoint.
  const generation: GenerationRequester = {
    async request(input) {
      if (options.refuseWith) throw options.refuseWith
      accepted.push(input)
      return {
        ...JOB,
        id: `job-${accepted.length}`,
        status: 'queued',
        spec: input.spec,
        backendChoice: input.choice,
        backend: null,
        model: null,
        checksum: null,
        creditState: 'reserved',
        costActualUsdMicros: 0n,
        finishedAt: null,
      }
    },
  }

  /**
   * The upload port. Deliberately does NOT re-run `normalise` — the validator has its own
   * exhaustive suite in `imagebytes.test.ts`, and the seam these tests exercise is the HTTP one:
   * status codes, headers, auth and the mapping of a refusal onto a response.
   */
  const uploaded: UploadInput[] = []
  const visibilityChanges: SetVisibilityInput[] = []
  const uploads: UploadReceiver = {
    async store(input) {
      if (options.uploadRefuseWith) throw options.uploadRefuseWith
      uploaded.push(input)
      return {
        asset: input.visibility === 'public' ? PUBLISHED : UPLOAD,
        deduplicated: false,
        strippedBytes: 12,
      }
    },
    async setVisibility(input) {
      visibilityChanges.push(input)
      return input.visibility === 'public' ? PUBLISHED : UPLOAD
    },
  }

  const server: Server = createServer({
    lifecycle,
    logger,
    metrics,
    verifier: options.verifier ?? workingVerifier(),
    kits,
    kitsFor: () => kits,
    sql: networkSql({ mainnet: {} as RuntimeSql }),
    singleNetwork: 'mainnet' as const,
    reads,
    generation,
    uploads,
    preflight: options.preflight ?? new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com')),
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  if (options.ready !== false) lifecycle.markReady()
  const { port } = server.address() as AddressInfo
  try {
    await fn({
      url: `http://127.0.0.1:${port}`,
      lifecycle,
      metrics,
      kits,
      accepted,
      uploaded,
      visibilityChanges,
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const failingProbe = (name: string, kind: 'hard' | 'soft'): Probe => ({
  name,
  kind,
  check: async () => ({ state: 'fail', detail: 'connection refused' }),
})

/* --------------------------------------------------------------- health */

test('livez is static and stays 200 while the service is unready', async () => {
  await withServer({ ready: false, probes: [failingProbe('postgres', 'hard')] }, async (h) => {
    const res = await fetch(`${h.url}/livez`)
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { state: string }).state, 'starting')
    assert.equal((await fetch(`${h.url}/readyz`)).status, 503)
  })
})

test('readyz is 503 when a hard probe fails', async () => {
  await withServer({ probes: [failingProbe('postgres', 'hard')] }, async (h) => {
    const res = await fetch(`${h.url}/readyz`)
    assert.equal(res.status, 503)
    assert.equal(((await res.json()) as { ready: boolean }).ready, false)
  })
})

test('THE DIFFERENCE: no usable image model is 200 + degraded, not 503', async () => {
  const preflight = new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com'))
  preflight.observe([{ ...okAttempt, outcome: 'not_found', status: 404 }])

  await withServer({ preflight, probes: [imageBackendProbe(preflight)] }, async (h) => {
    const res = await fetch(`${h.url}/readyz`)
    assert.equal(res.status, 200, 'the replica stays in the balancer')
    const body = (await res.json()) as { ready: boolean; state: string; checks: { name: string; state: string }[] }
    assert.equal(body.ready, true)
    assert.equal(body.state, 'degraded')
    assert.equal(body.checks.find((c) => c.name === 'image-backend')?.state, 'warn')
  })
})

/* --------------------------------------------------------------- the asset root */

/**
 * The defect these four cases exist for: `STUDIO_ASSET_ROOT` unset, the fallback resolving to a
 * root-owned `/app/out` under `USER node`, every generation failing EACCES — and `/readyz`
 * answering **200** throughout.
 *
 * Each case asserts the STATUS CODE, not the body. A probe that reports an unwritable root in the
 * `/readyz` payload while still answering 200 leaves the replica in the balancer, which is the
 * original defect with a paragraph of explanation attached.
 */

/** A temporary directory, removed afterwards even if the case leaves it unreadable. */
async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'studio-asset-root-'))
  try {
    await fn(root)
  } finally {
    await chmod(root, 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}

const rootProbeCheck = (body: unknown) =>
  (body as { checks: { name: string; kind: string; state: string; detail?: string }[] }).checks.find(
    (c) => c.name === 'asset-root',
  )

test('a writable asset root passes, and the check leaves nothing behind', async () => {
  await withTempRoot(async (root) => {
    // Twice, because the second run is the one that matters: the check must need the same
    // permission on the second call as on the first, which is only true if it tears its own
    // scratch directory down. See WRITE_CHECK_DIR.
    await checkAssetRoot(root)
    await checkAssetRoot(root)

    assert.deepEqual(await readdir(root), [], 'the check removes both the file and the directory')

    await withServer({ probes: [assetRootProbe(root)] }, async (h) => {
      const res = await fetch(`${h.url}/readyz`)
      assert.equal(res.status, 200)
      assert.equal(rootProbeCheck(await res.json())?.state, 'pass')
    })
  })
})

test('THE POINT: an unwritable asset root is 503, not a 200 that mentions it', async () => {
  // Runs as any uid: `mkdir` under a path that goes through a regular FILE is ENOTDIR for root
  // too. The permission case below is the incident's own errno and needs a non-root uid.
  await withTempRoot(async (dir) => {
    const notADirectory = join(dir, 'this-is-a-file')
    await writeFile(notADirectory, 'x')

    await withServer({ probes: [assetRootProbe(notADirectory)] }, async (h) => {
      const res = await fetch(`${h.url}/readyz`)
      assert.equal(res.status, 503, 'the replica must leave the balancer, not merely complain')

      const body = (await res.json()) as { ready: boolean; state: string }
      assert.equal(body.ready, false)

      const check = rootProbeCheck(body)
      assert.equal(check?.state, 'fail')
      // HARD is the assertion. A soft probe reports exactly the same `fail` here and still answers
      // 200, so the kind — not the state — is what makes the status code correct.
      assert.equal(check?.kind, 'hard')
      assert.match(String(check?.detail), /not a directory/)
    })
  })
})

test('THE INCIDENT: a root the process cannot write to is EACCES and 503', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  // Announced rather than silent. Root ignores the mode bits, so this case cannot be run as root
  // and a green run that skipped it must say which one it was.
  if (uid === 0) {
    console.log('skipped as root: chmod cannot make a directory unwritable to uid 0')
    return
  }

  await withTempRoot(async (root) => {
    // r-x: exactly the state `/app/out` was in — the directory exists, is readable, is listable,
    // and cannot be written to by the uid the image runs as.
    await chmod(root, 0o500)

    await withServer({ probes: [assetRootProbe(root)] }, async (h) => {
      const res = await fetch(`${h.url}/readyz`)
      assert.equal(res.status, 503)

      const check = rootProbeCheck(await res.json())
      assert.equal(check?.state, 'fail')
      assert.equal(check?.kind, 'hard')
      // The sentence an operator gets: the errno's real cause, not `chmod` on a correct path.
      assert.match(String(check?.detail), /not writable by uid/)
      assert.match(String(check?.detail), /EVERY generation of every kind/)
    })
  })
})

test('a root that is fine at boot and unwritable later still goes 503', async () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  if (uid === 0) {
    console.log('skipped as root: chmod cannot make a directory unwritable to uid 0')
    return
  }

  // This is the case the boot assertion in index.ts cannot cover, and the reason the probe exists
  // as well as the boot check: a volume remounted read-only, or a disk that fills, at 03:00.
  await withTempRoot(async (root) => {
    await withServer({ probes: [assetRootProbe(root)] }, async (h) => {
      assert.equal((await fetch(`${h.url}/readyz`)).status, 200)
      await chmod(root, 0o500)
      // THE REGRESSION THIS PINS. A check that kept a scratch directory around would still be
      // writing into it here and would answer 200 — the root is unwritable and the probe cannot
      // tell, which is the original defect reintroduced by a check that looked correct.
      assert.equal((await fetch(`${h.url}/readyz`)).status, 503)
      await chmod(root, 0o700)
      assert.equal((await fetch(`${h.url}/readyz`)).status, 200, 'and it recovers without a restart')
    })
  })
})

/* --------------------------------------------------------------- /v1/backend */

test('GET /v1/backend reports endpoint, model, fallbackModel, usable and reason', async () => {
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/backend`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body['endpoint'], 'test01eastus01.services.ai.azure.com')
    assert.equal(body['model'], 'FLUX.2-pro')
    assert.equal(body['fallbackModel'], null)
    assert.equal(body['usable'], true)
    assert.equal(body['evidence'], 'unverified')
    assert.ok(typeof body['reason'] === 'string' && body['reason'].length > 0)
    assert.equal(body['placeholderAvailable'], true)
  })
})

test('GET /v1/backend is unauthenticated but never leaks the key', async () => {
  // A capability a caller cannot discover without a token is one they will discover by having a
  // job fail instead. It names no customer and carries no credential.
  const config = fluxConfigFor('https://test01eastus01.services.ai.azure.com')
  await withServer({ preflight: new Preflight(config) }, async (h) => {
    const text = await (await fetch(`${h.url}/v1/backend`)).text()
    assert.equal(text.includes(config.apiKey), false)
  })
})

test('GET /v1/backend honestly reports a resource with no deployed model', async () => {
  const preflight = new Preflight(fluxConfigFor('https://test01eastus01.services.ai.azure.com'))
  preflight.observe([{ ...okAttempt, outcome: 'not_found', status: 404 }])

  await withServer({ preflight }, async (h) => {
    const body = (await (await fetch(`${h.url}/v1/backend`)).json()) as Record<string, unknown>
    assert.equal(body['usable'], false)
    assert.equal(body['evidence'], 'observed')
    assert.match(String(body['reason']), /no configured model is deployed/)
    // And the service is still usable for everything else.
    assert.equal(body['placeholderAvailable'], true)
  })
})

test('?probe=1 requires a token, because it makes a real image call', async () => {
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/backend?probe=1`)
    assert.equal(res.status, 401)
  })
})

/* --------------------------------------------------------------- auth */

test('an unauthenticated request is 401 and the body carries the request id', async () => {
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1`)
    assert.equal(res.status, 401)
    const body = (await res.json()) as { error: { code: string; requestId: string } }
    assert.equal(body.error.code, 'unauthenticated')
    assert.equal(body.error.requestId, res.headers.get('x-request-id'))
  })
})

test('THE RULE: an unreachable JWKS is 503, never 401', async () => {
  // Answering 401 here signs every user in the estate out because identity is having a bad minute.
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({ verifier: unreachableVerifier() }, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 503)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'verifier_unavailable')
  })
})

test('a service token needs the scope', async () => {
  const unscoped = await sign({ sub: 'service:hub-api', scopes: ['something:else'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1`, {
      headers: { authorization: `Bearer ${unscoped}` },
    })
    assert.equal(res.status, 403)
    assert.match(((await res.json()) as { error: { message: string } }).error.message, new RegExp(READ_SCOPE))
  })
})

test("another user's brand kit is 404, not 403, so ids cannot be enumerated", async () => {
  const other = await sign({ sub: '22222222-2222-4222-8222-222222222222', handle: 'other', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1`, {
      headers: { authorization: `Bearer ${other}` },
    })
    assert.equal(res.status, 404)
  })
})

/* --------------------------------------------------------------- brand kits */

test('a brand kit is created and the accent is validated', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'CloudsForge', accent: '#ff4d00', palette: ['#12100f'] }),
    })
    assert.equal(res.status, 201)
    const body = (await res.json()) as { brandKit: BrandKit }
    assert.equal(body.brandKit.accent, '#ff4d00')
    assert.equal(body.brandKit.ownerSubject, SUBJECT)
    assert.match(h.metrics.render(), /studio_brand_kits_created_total\{actor_kind="user"\} 1/)

    const bad = await fetch(`${h.url}/v1/brand-kits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', accent: 'orange' }),
    })
    assert.equal(bad.status, 400)
  })
})

test('a duplicate kit name for one owner is 409', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const body = JSON.stringify({ name: 'CloudsForge', accent: '#ff4d00' })
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    assert.equal((await fetch(`${h.url}/v1/brand-kits`, { method: 'POST', headers, body })).status, 201)
    const second = await fetch(`${h.url}/v1/brand-kits`, { method: 'POST', headers, body })
    assert.equal(second.status, 409)
    assert.equal(((await second.json()) as { error: { code: string } }).error.code, 'brand_kit_exists')
  })
})

/* --------------------------------------------------------------- generate */

test('generate answers 202 with a status URL and reaches no model', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'mark' }),
    })
    assert.equal(res.status, 202)
    const body = (await res.json()) as { accepted: boolean; statusUrl: string; job: { status: string } }
    assert.equal(body.accepted, true)
    assert.match(body.statusUrl, /^\/v1\/jobs\//)
    assert.equal(res.headers.get('location'), body.statusUrl)
    assert.equal(body.job.status, 'queued')
    assert.match(h.metrics.render(), /studio_generations_requested_total\{kind="mark",backend_choice="auto"\} 1/)
  })
})

test('an unknown kind or backend is 400 before anything is reserved', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const badKind = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'sticker' }),
    })
    assert.equal(badKind.status, 400)

    const badBackend = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'mark', backend: 'midjourney' }),
    })
    assert.equal(badBackend.status, 400)
  })
})

/**
 * `world_object` is the one kind whose subject cannot be defaulted. Every other kind falls back to
 * the kit's name; "a Tessera" is not an object anybody asked for, so `buildPrompt` throws — and a
 * bare `Error` maps to **500**. The route is where the caller's mistake becomes the caller's
 * answer, and until this check existed the route did not look at the description at all.
 */
test('THE 400: world_object on a kit with no stylePrompt is refused, not 500', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    // A kit created without one. `POST /v1/brand-kits` accepts that, correctly: a mark built
    // around the name alone is legitimate, so the refusal belongs at generate time, per kind.
    const created = await fetch(`${h.url}/v1/brand-kits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Undescribed', accent: '#ff4d00' }),
    })
    assert.equal(created.status, 201)
    const kitId = ((await created.json()) as { brandKit: BrandKit }).brandKit.id
    assert.equal(h.kits.rows.find((r) => r.id === kitId)?.stylePrompt, '')

    const res = await fetch(`${h.url}/v1/brand-kits/${kitId}/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'world_object' }),
    })
    // Without the route check this is 202 HERE and 500 in production, because this harness injects
    // a fake generation port. The real port's first statement is `buildPrompt`, which throws. The
    // next case pins that 500 with the actual error object rather than describing it.
    assert.equal(res.status, 400, 'the route accepted an undescribed world_object')
    const body = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'bad_request')
    assert.match(body.error.message, /stylePrompt/)

    // THE REFUSAL IS BEFORE THE PIPELINE. `accepted` is the generation port's own record, and
    // `requestGeneration` calls `buildPrompt` as its first statement — so an empty `accepted` is
    // the proof that nothing reached `prompt.ts`, that no credit was reserved and that no
    // `generation_jobs` row was written.
    assert.deepEqual(h.accepted, [])
  })
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `cover` IS NOT A BRAND ARTEFACT, AND THESE ASSERT THAT THE PROMPT KNOWS IT.
 *
 * The first attempt at Foresight's market covers used `banner`, which is a brand kind carrying
 * `brandStyle()` AND lettering of the kit name — so a market about a BTC price came back as a
 * corporate logo with `seed:foresight-8f3a1c` set across it. Nothing in this service reads a
 * prompt for meaning, so that would have been wrong quietly. These are the assertions that read it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('a cover prompt is an illustration brief, NOT the brand-mark brief', () => {
  const prompt = buildPrompt({
    kitName: 'seed:foresight-8f3a1c',
    accent: '#ff4d00',
    stylePrompt: 'Will the Coinbase BTC-USD spot price be at or above 70,000 USD',
    spec: { kind: 'cover', width: 1536, height: 512, format: 'png' },
  })
  assert.doesNotMatch(prompt, /Brand mark for a software company/, 'a cover got the brand brief')
  assert.match(prompt, /Editorial illustration/)
  // The subject reaches the model.
  assert.match(prompt, /BTC-USD spot price/)
})

test('a cover is never lettered, so it cannot invent a price or a date', () => {
  const prompt = buildPrompt({
    kitName: 'seed:foresight-8f3a1c',
    accent: '#ff4d00',
    stylePrompt: 'Will the Coinbase BTC-USD spot price be at or above 70,000 USD',
    spec: { kind: 'cover', width: 1536, height: 512, format: 'png' },
  })
  // The kit name must NOT be requested as type — that was the visible half of the defect.
  assert.doesNotMatch(prompt, /Any lettering must read exactly/)
  assert.doesNotMatch(prompt, /seed:foresight-8f3a1c" — that spelling/)
  // And numerals are forbidden outright. A generated "$70,000" beside a real market is a figure a
  // user could act on that nobody wrote and no contract backs.
  assert.match(prompt, /No text, no lettering, no numerals, no currency symbols/)
})

test('a cover refuses the outcome, and refuses charts, faces and crests', () => {
  const prompt = buildPrompt({
    kitName: 'k',
    accent: '#ff4d00',
    stylePrompt: 'Will Arsenal win the 2026-27 English Premier League title?',
    spec: { kind: 'cover', width: 1536, height: 512, format: 'png' },
  })
  // A prediction market must not be illustrated with a line going up: that is a claim about an
  // outcome nobody has decided, rendered next to real money.
  assert.match(prompt, /No charts, no graphs, no arrows, no trend lines/)
  // Several seeded questions name clubs, parties and teams. A hallucinated crest is a trademark
  // problem, not a stylistic one.
  assert.match(prompt, /no logos, no brand marks, no flags, no crests/)
  assert.match(prompt, /without depicting any outcome/)
})

test('a cover with no subject is refused rather than drawing the kit slug', () => {
  assert.throws(
    () =>
      buildPrompt({
        kitName: 'seed:foresight-8f3a1c',
        accent: '#ff4d00',
        stylePrompt: '   ',
        spec: { kind: 'cover', width: 1536, height: 512, format: 'png' },
      }),
    /no subject/,
  )
})

test('and the 500 it replaces was real, not a story about one', async () => {
  // The error is CAUGHT from the real `buildPrompt` rather than reconstructed, so this cannot go
  // stale the way the comment in prompt.ts did. It is a bare `Error`: not SpecError, not
  // BadRequestError, so it lands in `handle`'s final branch — 500, `internal`, "the request could
  // not be completed", which tells the caller to open a support ticket about their own typo.
  let thrown: unknown = null
  try {
    buildPrompt({ kitName: 'Undescribed', accent: '#ff4d00', stylePrompt: '', spec: specFor('world_object') })
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown instanceof Error, 'buildPrompt must refuse an undescribed world_object')
  assert.equal(thrown instanceof SpecError, false, 'a SpecError would already have been a 400')

  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  // Injected into the port on a kit that DOES have a description, so the route's own check passes
  // and the mapping — not the check — is what is under test.
  await withServer({ refuseWith: thrown }, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'world_object' }),
    })
    assert.equal(res.status, 500)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'internal')
  })
})

test('a world_object on a kit that HAS a description is still 202', async () => {
  // The property that made the defect invisible: Tessera's Kiln always sets `stylePrompt`, so the
  // only caller that exists today never met it. This case is what stops the fix refusing that
  // caller too.
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const created = await fetch(`${h.url}/v1/brand-kits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Kiln', accent: '#ff4d00', stylePrompt: 'a three-legged oak stool' }),
    })
    const kitId = ((await created.json()) as { brandKit: BrandKit }).brandKit.id

    const res = await fetch(`${h.url}/v1/brand-kits/${kitId}/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'world_object' }),
    })
    assert.equal(res.status, 202)
    assert.equal(h.accepted[0]?.spec.kind, 'world_object')
    // 512x512 from 23-tessera.md §2.1, already on the 16-pixel grid FLUX floors to.
    assert.equal(h.accepted[0]?.spec.width, 512)
    assert.equal(h.accepted[0]?.spec.height, 512)
  })
})

test('a blank-but-present stylePrompt is refused too, not just a missing one', async () => {
  // `"   "` is a description in the JSON sense and no description at all in the only sense that
  // matters. `buildPrompt` trims; a route check that did not would hand it a prompt reading
  // "The object is:" and generate whatever the model felt like.
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const created = await fetch(`${h.url}/v1/brand-kits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Whitespace', accent: '#ff4d00', stylePrompt: '   \n  ' }),
    })
    const kitId = ((await created.json()) as { brandKit: BrandKit }).brandKit.id

    const res = await fetch(`${h.url}/v1/brand-kits/${kitId}/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'world_object' }),
    })
    assert.equal(res.status, 400)
    assert.deepEqual(h.accepted, [])
  })
})

test('every OTHER kind still generates from a kit with no stylePrompt', async () => {
  // The check must be scoped to `world_object`. A mark built around the name alone is exactly what
  // `buildPrompt`'s "Built around the name … and nothing else" branch is for, and refusing it here
  // would be a fix that broke eight kinds to repair one.
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const created = await fetch(`${h.url}/v1/brand-kits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Undescribed', accent: '#ff4d00' }),
    })
    const kitId = ((await created.json()) as { brandKit: BrandKit }).brandKit.id

    for (const kind of ['mark', 'wordmark', 'favicon', 'og', 'social', 'banner', 'icon', 'tile']) {
      const res = await fetch(`${h.url}/v1/brand-kits/${kitId}/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind }),
      })
      assert.equal(res.status, 202, `${kind} must not need a description`)
    }
  })
})

test('a credit cap refusal is 402 and says that no image call was made', async () => {
  // Not 403 (which sends a user to check their permissions) and not 500 (which sends an engineer
  // to read logs). The cap decided; this is an answer, and the client's remedy is a bigger cap.
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  const refuseWith = new CreditCapError(
    { ownerSubject: SUBJECT, capUsdMicros: 1_000_000n, spentUsdMicros: 990_000n, reservedUsdMicros: 0n },
    60_000n,
  )
  await withServer({ refuseWith }, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'mark' }),
    })
    assert.equal(res.status, 402)
    const body = (await res.json()) as { error: Record<string, unknown> }
    assert.equal(body.error['code'], 'credit_cap_exceeded')
    assert.equal(body.error['capUsd'], '$1.000')
    assert.equal(body.error['remainingUsd'], '$0.010')
    assert.equal(body.error['requestedUsd'], '$0.060')
    // The fact a caller most needs and cannot otherwise know: being refused cost them nothing.
    assert.equal(body.error['imageCallMade'], false)
    assert.equal(h.accepted.length, 0)
    assert.match(h.metrics.render(), /studio_generations_refused_total\{reason="credit_cap"\} 1/)
  })
})

test('the spec the route builds is the one the pipeline is handed', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'og', backend: 'placeholder' }),
    })
    const input = h.accepted[0]
    assert.deepEqual(input?.spec, { kind: 'og', width: 1200, height: 630, format: 'png' })
    assert.equal(input?.choice, 'placeholder')
    assert.equal(input?.kit.id, 'kit-1')
  })
})

/* --------------------------------------------------------------- reads */

test('GET /v1/jobs/:id returns the job and its complete provenance', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/jobs/job-1`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { job: Record<string, unknown>; provenance: Record<string, unknown> }

    assert.equal(body.job['backend'], 'flux')
    assert.equal(body.job['model'], 'FLUX.2-pro')
    // Money crosses the wire as a decimal string, never a JSON number.
    assert.equal(body.job['costActualUsdMicros'], '60000')

    for (const field of ['backend', 'model', 'prompt', 'spec', 'attempts', 'checksum', 'requestedSize']) {
      assert.ok(body.provenance[field] !== undefined, `provenance.${field} is missing`)
    }
  })
})

test('GET /v1/assets/:id returns the asset and the provenance of the job that made it', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/assets/asset-1`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { asset: Asset; provenance: Record<string, unknown> }
    assert.equal(body.asset.checksum, 'sha256:abc')
    assert.equal(body.asset.sizing, 'exact')
    assert.equal(body.asset.c2pa, true, 'a disclosure fact, carried on the asset')
    assert.equal(body.provenance['generationJobId'], JOB.id)
  })
})

test('an unknown job or asset is 404', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const headers = { authorization: `Bearer ${token}` }
    assert.equal((await fetch(`${h.url}/v1/jobs/nope`, { headers })).status, 404)
    assert.equal((await fetch(`${h.url}/v1/assets/nope`, { headers })).status, 404)
  })
})

/* --------------------------------------------------------------- uploads */

test('POST /v1/uploads with no token is 401, before any byte is read', async () => {
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/uploads`, { method: 'POST', body: Buffer.from('x') })
    assert.equal(res.status, 401)
    assert.equal(h.uploaded.length, 0, 'an unauthenticated body reached the pipeline')
  })
})

test('POST /v1/uploads stores the bytes and answers with the asset and its bytes URL', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: Buffer.from('the-bytes'),
    })
    assert.equal(res.status, 201)
    const body = (await res.json()) as { asset: Asset; bytesUrl: string; deduplicated: boolean }
    assert.equal(body.asset.origin, 'upload')
    assert.equal(body.bytesUrl, `/v1/assets/${UPLOAD.id}/bytes`)
    assert.equal(body.deduplicated, false)

    // The bytes reached the pipeline intact, and were attributed to the authenticated subject.
    assert.equal(h.uploaded.length, 1)
    assert.deepEqual(h.uploaded[0]?.bytes, Buffer.from('the-bytes'))
    assert.equal(h.uploaded[0]?.ownerSubject, SUBJECT)
  })
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE REFUSAL MAPPINGS. `imagebytes.test.ts` proves the validator refuses; these prove the refusal
 * becomes the right STATUS with the reason a client can branch on — the half that would otherwise
 * be a 500 in front of a user.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('a refused upload is 400 carrying the reason, not a 500', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  const refusal = new UploadRejected('svg_refused', 'SVG and XML uploads are refused')
  await withServer({ uploadRefuseWith: refusal }, async (h) => {
    const res = await fetch(`${h.url}/v1/uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: Buffer.from('<svg/>'),
    })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { code: string; reason: string } }
    assert.equal(body.error.code, 'upload_svg_refused')
    assert.equal(body.error.reason, 'svg_refused')
    // And the refusal is counted under its own label, so a run of probes is visible on a dashboard.
    assert.match(h.metrics.render(), /studio_uploads_refused_total\{reason="svg_refused"\} 1/)
  })
})

test('an over-quota upload is 429 with a Retry-After, not 402 and not 403', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({ uploadRefuseWith: new UploadQuotaError('uploads', 200, 200, 24) }, async (h) => {
    const res = await fetch(`${h.url}/v1/uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: Buffer.from('x'),
    })
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('retry-after'), String(24 * 3600))
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'upload_quota_exceeded')
  })
})

/* --------------------------------------------------------------- serving bytes */

test('GET /v1/assets/:id/bytes serves the stored bytes under the hardened headers', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/assets/${UPLOAD.id}/bytes`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), UPLOAD_BYTES)

    // The type comes from the ROW, which was written from the sniffed bytes — never from a header
    // the uploader sent.
    assert.equal(res.headers.get('content-type'), 'image/jpeg')

    // Each of these is what stops a stored file becoming a script on this origin.
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    const csp = res.headers.get('content-security-policy') ?? ''
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /sandbox/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.equal(res.headers.get('content-disposition'), 'inline')
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin')

    // Content-addressed, so it is safe to cache hard — and the ETag is the address itself.
    assert.match(res.headers.get('cache-control') ?? '', /immutable/)
    assert.equal(res.headers.get('etag'), `"${UPLOAD.checksum}"`)
  })
})

test('the bytes route is 404 when the row exists but the blob does not', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    // ASSET's checksum has no blob in the harness store. A dangling reference is a 404 to the
    // caller rather than a 500, because "we do not have those bytes" is the whole truth.
    const res = await fetch(`${h.url}/v1/assets/${ASSET.id}/bytes`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 404)
  })
})

test("another user's uploaded asset is 404, both as metadata and as bytes", async () => {
  // 404 rather than 403 on purpose: a distinct 403 for "exists but is not yours" is an enumeration
  // oracle over every asset id in the estate.
  const stranger = await sign({
    sub: '22222222-2222-4222-8222-222222222222',
    handle: 'rook',
    roles: ['player'],
  })
  await withServer({}, async (h) => {
    const headers = { authorization: `Bearer ${stranger}` }
    assert.equal((await fetch(`${h.url}/v1/assets/${UPLOAD.id}`, { headers })).status, 404)
    assert.equal((await fetch(`${h.url}/v1/assets/${UPLOAD.id}/bytes`, { headers })).status, 404)
  })
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * VISIBILITY. The pair of tests below is the whole security boundary: a published asset is
 * fetchable by anyone, and an unpublished one is fetchable by nobody but its owner. If the first
 * fails the feature does not work; if the SECOND fails, every private upload in the estate is
 * readable by strangers.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('a PUBLISHED asset serves its bytes with no Authorization header at all', async () => {
  await withServer({}, async (h) => {
    // No token. This is what an <img src> sends.
    const res = await fetch(`${h.url}/v1/assets/${PUBLISHED.id}/bytes`)
    assert.equal(res.status, 200)
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), UPLOAD_BYTES)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    // Publicly cacheable, because it is public and content-addressed.
    assert.match(res.headers.get('cache-control') ?? '', /^public,/)
  })
})

test('an UNPUBLISHED asset is 401 without a token and 404 to a stranger', async () => {
  const stranger = await sign({
    sub: '22222222-2222-4222-8222-222222222222',
    handle: 'rook',
    roles: ['player'],
  })
  await withServer({}, async (h) => {
    // No token: the private path still demands one.
    assert.equal((await fetch(`${h.url}/v1/assets/${UPLOAD.id}/bytes`)).status, 401)
    // A valid token belonging to somebody else: 404, never 403 — see the enumeration note.
    const res = await fetch(`${h.url}/v1/assets/${UPLOAD.id}/bytes`, {
      headers: { authorization: `Bearer ${stranger}` },
    })
    assert.equal(res.status, 404)
  })
})

test('the bytes route is not an existence oracle for an anonymous caller', async () => {
  await withServer({}, async (h) => {
    // A private asset that EXISTS and an id that does not: identical answers to a caller with no
    // token. If these ever differ, a stranger can enumerate which asset ids are real.
    const existing = await fetch(`${h.url}/v1/assets/${UPLOAD.id}/bytes`)
    const absent = await fetch(`${h.url}/v1/assets/does-not-exist/bytes`)
    assert.equal(existing.status, 401)
    assert.equal(absent.status, existing.status, 'an unknown id answers differently from a private one')

    // And with a valid token belonging to somebody else, both are 404 rather than 403.
    const stranger = await sign({
      sub: '33333333-3333-4333-8333-333333333333',
      handle: 'wren',
      roles: ['player'],
    })
    const headers = { authorization: `Bearer ${stranger}` }
    const mine = await fetch(`${h.url}/v1/assets/${UPLOAD.id}/bytes`, { headers })
    const nothing = await fetch(`${h.url}/v1/assets/does-not-exist/bytes`, { headers })
    assert.equal(mine.status, 404)
    assert.equal(nothing.status, 404)
  })
})

test('a private asset is not publicly cacheable', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/assets/${UPLOAD.id}/bytes`, {
      headers: { authorization: `Bearer ${token}` },
    })
    // `private` keeps it out of a shared cache, which would otherwise be able to hand one user's
    // image to the next request for the same URL.
    assert.match(res.headers.get('cache-control') ?? '', /^private,/)
  })
})

test('an upload defaults to private, and is public only when explicitly asked', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const post = (query: string) =>
      fetch(`${h.url}/v1/uploads${query}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: Buffer.from('bytes'),
      })

    await post('')
    assert.equal(h.uploaded[0]?.visibility, 'private', 'an upload defaulted to public')

    await post('?visibility=public')
    assert.equal(h.uploaded[1]?.visibility, 'public')

    // An unrecognised value is refused rather than quietly treated as private: silently
    // downgrading a caller who meant to publish gives them a broken image they cannot explain.
    assert.equal((await post('?visibility=world')).status, 400)
  })
})

test('the owner can publish and unpublish an asset', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/assets/${UPLOAD.id}/visibility`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    })
    assert.equal(res.status, 200)
    assert.equal(h.visibilityChanges[0]?.visibility, 'public')
    assert.equal(h.visibilityChanges[0]?.assetId, UPLOAD.id)
  })
})

test('a stranger cannot publish somebody else\'s asset', async () => {
  const stranger = await sign({
    sub: '22222222-2222-4222-8222-222222222222',
    handle: 'rook',
    roles: ['player'],
  })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/assets/${UPLOAD.id}/visibility`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stranger}`, 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    })
    assert.equal(res.status, 404)
    assert.equal(h.visibilityChanges.length, 0, 'a stranger reached the visibility change')
  })
})

test('an uploaded asset reports no provenance and an unanchored state', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/assets/${UPLOAD.id}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { asset: Asset; provenance: unknown }
    // Null rather than an object of nulls: an upload has no generation to describe, and a shape
    // full of empty provenance fields reads like a generation that failed to record anything.
    assert.equal(body.provenance, null)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // THE HONESTY ASSERTION. Nothing may report an asset as anchored or verified while Hearth has
    // no Registry of Authorship contract to anchor it to. This is the test that fails if somebody
    // later populates the anchor columns with something plausible.
    // ══════════════════════════════════════════════════════════════════════════════════════════
    assert.equal(body.asset.anchor.state, 'unanchored')
    assert.equal(body.asset.anchor.transactionHash, null)
    assert.equal(body.asset.anchor.blockNumber, null)
  })
})

/* --------------------------------------------------------------- plumbing */

test('a malformed body is 400 rather than 500', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    const res = await fetch(`${h.url}/v1/brand-kits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(res.status, 400)
  })
})

test('a request id is propagated when safe and replaced when it is not', async () => {
  await withServer({}, async (h) => {
    const propagated = await fetch(`${h.url}/livez`, { headers: { 'x-request-id': 'abc-123_XYZ' } })
    assert.equal(propagated.headers.get('x-request-id'), 'abc-123_XYZ')

    // An unvalidated inbound id is a header-injection and a log-forgery primitive at once.
    const hostile = await fetch(`${h.url}/livez`, { headers: { 'x-request-id': 'a b"c' } })
    assert.notEqual(hostile.headers.get('x-request-id'), 'a b"c')
  })
})

test('a path parameter cannot swallow the rest of the path', async () => {
  const token = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
  await withServer({}, async (h) => {
    // `/v1/jobs/a/b` must not match `/v1/jobs/:id` with id="a/b".
    const res = await fetch(`${h.url}/v1/jobs/a/b`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 404)
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /no route for/)
  })
})

test('an unknown path is 404 and does not mint a metric series of its own', async () => {
  await withServer({}, async (h) => {
    await fetch(`${h.url}/v1/nothing-here`)
    const rendered = h.metrics.render()
    // Any caller could otherwise mint unbounded time series and take the scrape target down.
    assert.match(rendered, /route="unmatched"/)
    assert.equal(/nothing-here/.test(rendered), false)
  })
})

test('metrics render as valid Prometheus exposition', async () => {
  await withServer({}, async (h) => {
    await fetch(`${h.url}/livez`)
    const res = await fetch(`${h.url}/metrics`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain; version=0\.0\.4/)

    const comment = /^# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]* .+$/
    const sample =
      /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="[^"]*"(,[a-zA-Z_][a-zA-Z0-9_]*="[^"]*")*\})? -?(\d+(\.\d+)?([eE][-+]?\d+)?|\+Inf|NaN)$/
    for (const line of (await res.text()).split('\n').filter((l) => l.length > 0)) {
      assert.ok(comment.test(line) || sample.test(line), `not valid exposition: ${line}`)
    }
  })
})

test('health answers are never cached', async () => {
  await withServer({}, async (h) => {
    assert.equal((await fetch(`${h.url}/readyz`)).headers.get('cache-control'), 'no-store')
    assert.equal((await fetch(`${h.url}/v1/backend`)).headers.get('cache-control'), 'no-store')
  })
})

test('a drain reports unready and refuses to claim jobs before the socket closes', async () => {
  await withServer({}, async (h) => {
    assert.equal(h.lifecycle.claimingJobs, true)
    const drained = h.lifecycle.shutdown('SIGTERM')

    assert.equal((await fetch(`${h.url}/readyz`)).status, 503)
    assert.equal(h.lifecycle.claimingJobs, false)
    assert.equal((await fetch(`${h.url}/livez`)).status, 200, 'a draining process is still alive')

    await drained
  })
})

test('the write scope is required to generate', async () => {
  const reader = await sign({ sub: 'service:hub-api', scopes: [READ_SCOPE] })
  const writer = await sign({ sub: 'service:hub-api', scopes: [WRITE_SCOPE] })
  await withServer({}, async (h) => {
    const body = JSON.stringify({ kind: 'mark' })
    const refused = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reader}`, 'content-type': 'application/json' },
      body,
    })
    assert.equal(refused.status, 403)

    const allowed = await fetch(`${h.url}/v1/brand-kits/kit-1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${writer}`, 'content-type': 'application/json' },
      body,
    })
    assert.equal(allowed.status, 202)
  })
})
