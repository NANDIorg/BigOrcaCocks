import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startHeadless, type HeadlessHost } from '@orca-board/headless'
import { createOperatorHttpHandler, ProfileRuntimeStartupError, type OrcaRuntimeOptions } from '@orca-board/runtime'
import { parseWebConfig, type WebConfig } from './config.ts'
import { loadWebAccounts } from './accounts.ts'
import { createWebSessions } from './sessions.ts'
import { createWebRouter, type WebRouter } from './http.ts'
import { record } from './private-json.ts'
import { createProjectRootPolicy } from './project-roots.ts'
import { createStaticHandler } from './static.ts'
import { httpPreviewAddress, createPreviewServer } from './preview.ts'
import { createBrowserUpdates, managedWebInstallation } from './browser-updates.ts'

export { createWebAccount, initializeWebAccount, addWebAccount } from './accounts.ts'
export { parseWebConfig, loadWebConfig } from './config.ts'
export interface StartWebOptions {
  config: WebConfig
  resourceDir: string
  warn?: OrcaRuntimeOptions['warn']
  startHost?: typeof startHeadless
  listenPort?: number
}
export async function startWeb(options: StartWebOptions): Promise<{ url: string; host: HeadlessHost; stop(): Promise<void> }> {
  const config = parseWebConfig(options.config)
  const accounts = await loadWebAccounts(join(config.configDir, 'accounts.json'))
  const manifest: unknown = JSON.parse(await readFile(join(options.resourceDir, 'package.json'), 'utf8'))
  if (!record(manifest) || typeof manifest.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) throw new Error('Некорректный installed Web manifest')
  const accountIds = new Set(accounts.map(account => `web:${account.id}`))
  const roots = await createProjectRootPolicy(config.projectRoots)
  const host = await (options.startHost ?? startHeadless)({ dataDir: config.dataDir, resourceDir: options.resourceDir,
    product: { name: 'orca-web', version: manifest.version }, warn: options.warn,
    previewAddress: httpPreviewAddress(config.previewOrigin),
    operatorAuthorize: context => accountIds.has(context.actor.id) })
  let router: WebRouter | undefined
  const sessions = createWebSessions({ onRevoke: session => router?.revokeClients(session) })
  const operator = createOperatorHttpHandler({ runtime: host.runtime.value, maxClients: 64, authenticate: request => router?.authenticateOperator(request) ?? null, beforeCall: roots.beforeCall })
  const updates = createBrowserUpdates({ version: manifest.version, managed: await managedWebInstallation(options.resourceDir) })
  router = createWebRouter({ config, accounts, sessions, operator, updates, version: manifest.version, directories: roots.list, static: createStaticHandler(join(options.resourceDir, 'browser'), config.previewOrigin) })
  const server = createServer({ maxHeaderSize: 16 * 1024 }, router.handle)
  const previewServer = createPreviewServer(config, host.runtime.value)
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32
  let shutdown: Promise<void> | undefined; let stopped = false; let serverClosed = false
  function stop(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (shutdown) return shutdown
    shutdown = (async () => {
      updates.stop()
      const serverStop = !serverClosed && server.listening ? new Promise<void>((resolve, reject) => {
        server.close(error => { if (error) reject(error); else { serverClosed = true; resolve() } }); server.closeAllConnections()
      }) : Promise.resolve()
      const previewStop = previewServer.listening ? new Promise<void>((resolve, reject) => { previewServer.close(error => error ? reject(error) : resolve()); previewServer.closeAllConnections() }) : Promise.resolve()
      const results = await Promise.allSettled([serverStop, previewStop, router!.stop(), operator.stop(), host.runtime.value.beginStop()])
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (failures.length) throw new AggregateError(failures, 'Не удалось остановить Web ресурсы')
      await host.stop(); stopped = true
    })()
    void shutdown.catch(() => { shutdown = undefined })
    return shutdown
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.listenPort ?? config.port, '127.0.0.1', resolve) })
    await new Promise<void>((resolve, reject) => { previewServer.once('error', reject); previewServer.listen(config.previewPort, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Не удалось открыть Web listener')
    void updates.check().catch(() => {})
    return { url: `http://127.0.0.1:${address.port}`, host, stop }
  } catch (error) {
    try { await stop() } catch (cleanup) { throw new ProfileRuntimeStartupError(error, cleanup, stop) }
    throw error
  }
}
