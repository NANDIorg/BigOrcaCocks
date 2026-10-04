import { createServer } from 'node:http'
import { createOperatorHttpHandler, type OperatorHttpOptions } from './operator-http.ts'

/** Приватный listener остаётся loopback; Web монтирует тот же handler в свой router. */
export async function startOperatorEndpoint(options: OperatorHttpOptions) {
  const handler = createOperatorHttpHandler(options)
  const server = createServer(handler.handle)
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  } catch (error) { await handler.stop(); throw error }
  const address = server.address()
  if (!address || typeof address === 'string') { await handler.stop(); throw new Error('Не удалось открыть operator endpoint') }
  let shutdown: Promise<void> | undefined
  let serverClosed = false
  return { url: `http://127.0.0.1:${address.port}`, stop(): Promise<void> {
    if (shutdown) return shutdown
    shutdown = (async () => {
      if (!serverClosed) {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        serverClosed = true
      }
      await handler.stop()
    })()
    void shutdown.catch(() => { shutdown = undefined })
    return shutdown
  } }
}
