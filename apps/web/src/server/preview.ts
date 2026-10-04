import { createServer, type Server } from 'node:http'
import { Readable } from 'node:stream'
import type { PreviewAddress, OperatorHttpRuntime } from '@orca-board/runtime'
import type { WebConfig } from './config.ts'

export function httpPreviewAddress(origin: string): PreviewAddress {
  const prefix = `${origin}/`
  const base = (token: string) => `${prefix}${token}/`
  return { cspSource: origin, base, urlFor: (token, segments) => `${base(token)}${segments.map(encodeURIComponent).join('/')}`,
    parse: raw => {
      if (!raw.startsWith(prefix)) return undefined
      const match = /^([a-f0-9]{32})(\/[^?#]*)(?:\?[^#]*)?$/.exec(raw.slice(prefix.length))
      return match ? { token: match[1], path: match[2] } : undefined
    } }
}
export function createPreviewServer(config: WebConfig, runtime: OperatorHttpRuntime): Server {
  const server = createServer((request, response) => {
    if (request.headers.host !== new URL(config.previewOrigin).host || config.mode === 'proxy' && request.headers['x-forwarded-proto'] !== 'https') { response.statusCode = 403; response.end(); return }
    // Проверяем raw URL до Request/URL: они нормализуют encoded dot segments.
    const url = `${config.previewOrigin}${request.url ?? ''}`
    const resolved = runtime.preview.resolvePreviewRequest({ method: request.method ?? 'GET', url }, runtime.previewTokens)
    if (!resolved.ok) { response.statusCode = resolved.status; response.end(); return }
    const result = runtime.preview.handlePreviewRequest(new Request(url, { method: request.method, headers: request.headers.range ? { range: request.headers.range } : {} }), runtime.previewTokens)
    response.statusCode = result.status; result.headers.forEach((value, key) => response.setHeader(key, value))
    if (!result.body) { response.end(); return }
    const stream = Readable.fromWeb(result.body as ReadableStream<Uint8Array>)
    response.once('close', () => stream.destroy()); stream.once('error', () => response.destroy()); stream.pipe(response)
  })
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32
  return server
}
