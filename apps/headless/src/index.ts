import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createOrcaRuntime, startOperatorEndpoint, getProfileLocation, type PtyFactory, type OrcaRuntimeOptions } from '@orca-board/runtime'
import { homedir } from 'node:os'

export { createOrcaRuntime, startOperatorEndpoint } from '@orca-board/runtime'
export type { OrcaRuntimeOptions, PtyFactory } from '@orca-board/runtime'

/** Installed resources и native dependency находятся только в каталоге этого Node host. */
export async function startHeadless(options: { dataDir: string; resourceDir?: string; warn?: OrcaRuntimeOptions['warn'] }) {
  const resourceDir = options.resourceDir ?? dirname(fileURLToPath(import.meta.url))
  const manifest: { version: string } = JSON.parse(readFileSync(join(resourceDir, 'package.json'), 'utf8'))
  const native = createRequire(join(resourceDir, 'package.json'))('node-pty') as { spawn: PtyFactory }
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 })
  const location = await getProfileLocation(options.dataDir)
  const socketPath = process.platform === 'win32' ? `\\.\pipe\orca-agent-${location.profileId.slice(0, 32)}` : join(homedir(), '.orca-board', 'run', `${location.profileId.slice(0, 32)}.sock`)
  const runtime = await createOrcaRuntime({ dataDir: location.dataDir, socketPath,
    cliBinDir: join(resourceDir, 'cli'), product: { name: 'orca-headless', version: manifest.version },
    prompts: { worker: readFileSync(join(resourceDir, 'skills', 'worker.md'), 'utf8'), coordinator: readFileSync(join(resourceDir, 'skills', 'coordinator.md'), 'utf8'), assistant: readFileSync(join(resourceDir, 'skills', 'assistant.md'), 'utf8') },
    native, authorize: context => context.actor.kind === 'operator' && context.actor.id === 'local-user', warn: options.warn })
  let endpoint: Awaited<ReturnType<typeof startOperatorEndpoint>> | undefined
  try {
    const token = randomBytes(32).toString('hex'); endpoint = await startOperatorEndpoint({ runtime: runtime.value, token })
    const file = join(runtime.owner.dataDir, 'operator-endpoint.json')
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, url: endpoint.url, token, socketPath, ownerId: runtime.owner.instanceId }), { mode: 0o600 }); chmodSync(file, 0o600)
  } catch (error) { await endpoint?.stop(); await runtime.stop(); throw error }
  const activeEndpoint = endpoint
  let shutdown: Promise<void> | undefined
  return { runtime, endpoint: activeEndpoint, stop() {
    if (shutdown) return shutdown
    shutdown = (async () => { await Promise.all([activeEndpoint.stop(), runtime.value.beginStop()]); await runtime.stop() })()
    void shutdown.catch(() => { shutdown = undefined })
    return shutdown
  } }
}
