/**
 * A fake FLUX endpoint — a real HTTP server, not a stubbed `fetch`.
 *
 * The difference matters. A stubbed `fetch` proves that the code calls a function; a real socket
 * proves that the URL is built correctly, that the headers are sent, that the JSON body is what we
 * think it is, and that a non-2xx is read the way `fetch` actually presents it. Every bug this
 * file exists to catch — a missing `model` field, a doubled slash in the path, a 404 body that is
 * HTML rather than JSON — is invisible to a stub.
 *
 * It records every request it receives, so a test can assert on what was sent and, crucially, on
 * what was **not** sent: the credit-cap test passes because this server's `requests` array is
 * still empty.
 *
 * Not a test file: it contains no `test()` call and is excluded from the build.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: Record<string, unknown>
}

/** What the fake should do for the Nth call to a given model. */
export interface Scripted {
  readonly status: number
  /** A JSON body. When absent, a default success or error envelope is produced. */
  readonly body?: unknown
  /** Serve `{data:[{url}]}` pointing at this server's own blob route instead of `b64_json`. */
  readonly shape?: 'b64_json' | 'url'
  /** Answer with something that is not JSON, to exercise the parse failure path. */
  readonly raw?: string
}

export interface FakeFlux {
  readonly url: string
  readonly requests: RecordedRequest[]
  /** Queue an outcome for the next call to `model`. Falls back to `defaultFor`. */
  script(model: string, ...outcomes: Scripted[]): void
  close(): Promise<void>
}

/**
 * One tiny PNG, base64. A real 1x1 PNG with a valid IHDR, so `pngDimensions` reads 1x1 from it
 * rather than being handed bytes that happen to be the right length.
 */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * A PNG of a stated size, built by hand so a test can assert that the DELIVERED dimensions are
 * read from the bytes rather than assumed from the request.
 *
 * Only the signature and the IHDR chunk are real; the image data is not a decodable image. That is
 * exactly right for what is under test — `sizing.ts` reads the header and never decodes — and it
 * keeps this helper to twenty lines instead of pulling in an encoder.
 */
export function pngOfSize(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr.writeUInt8(8, 16) // bit depth
  ihdr.writeUInt8(6, 17) // colour type: RGBA
  return Buffer.concat([signature, ihdr, Buffer.from('IEND')])
}

function successBody(shape: 'b64_json' | 'url', origin: string, png: string): unknown {
  return {
    created: 1_785_435_307,
    data: [shape === 'b64_json' ? { b64_json: png } : { url: `${origin}/blob.png` }],
    // The provider's own accounting, in the shape the live endpoint returns it.
    request_meta: { cost: 3, input_mp: 0, output_mp: 1, total_pixels: 1_048_576 },
  }
}

const ERRORS: Readonly<Record<number, { code: string; message: string }>> = {
  400: {
    code: 'no_model_name',
    message:
      "Could not find a reference to a model in the request. Please provide a model name as a string under the 'model' parameter in the request body.",
  },
  401: { code: 'Unauthorized', message: 'Access denied due to invalid subscription key.' },
  404: {
    code: 'DeploymentNotFound',
    message: 'The API deployment for this resource does not exist.',
  },
  429: { code: 'TooManyRequests', message: 'Rate limit is exceeded. Try again later.' },
  500: { code: 'InternalServerError', message: 'The server had an error.' },
}

export async function startFakeFlux(
  options: { readonly png?: string } = {},
): Promise<FakeFlux> {
  const requests: RecordedRequest[] = []
  const scripts = new Map<string, Scripted[]>()
  const png = options.png ?? TINY_PNG_BASE64
  let origin = ''

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/blob.png') {
      // The `url` response shape. Served as bytes, exactly as a real pre-signed blob URL would be.
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from(png, 'base64'))
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        body = {}
      }
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body })

      const model = typeof body['model'] === 'string' ? body['model'] : ''

      // The live endpoint's most surprising behaviour, reproduced: the model is in the URL path
      // and it is STILL required in the body. Omitting it is a 400, never a 404.
      if (!model) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: ERRORS[400] }))
        return
      }

      const queued = scripts.get(model)
      const next = queued?.shift()

      if (!next) {
        // Unscripted models 404, which is what the live resource does for every FLUX name except
        // the one that is deployed.
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: ERRORS[404] }))
        return
      }

      if (next.raw !== undefined) {
        res.writeHead(next.status, { 'content-type': 'text/html' })
        res.end(next.raw)
        return
      }

      const payload =
        next.body !== undefined
          ? next.body
          : next.status >= 200 && next.status < 300
            ? successBody(next.shape ?? 'b64_json', origin, png)
            : { error: ERRORS[next.status] ?? { code: 'Unknown', message: 'unknown' } }

      res.writeHead(next.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  origin = `http://127.0.0.1:${port}`

  return {
    url: origin,
    requests,
    script(model, ...outcomes) {
      scripts.set(model, [...(scripts.get(model) ?? []), ...outcomes])
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
