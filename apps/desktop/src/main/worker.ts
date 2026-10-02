import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { app } from 'electron'
import { createWorkerServices, type WorkerServices, type Win32LaunchEnv } from '@orca-board/runtime'
import { BUILTIN_PROMPTS } from './prompts'
import { defaultShell, isAlive, killPty, spawnPty } from './pty'
import { extraPathDirs } from './agents'
import { launchAgent } from './agent-launch'
import { OrcaError, mainLocale } from './i18n'
import { executionResources } from './execution-resources'

export type { PermissionMode, WorkerEnvContext, AssistantContext } from '@orca-board/runtime'

/** Путь к bin CLI. В dev — из monorepo, в сборке — рядом с ресурсами. */
export function cliBinDir(): string {
  const dev = resolve(app.getAppPath(), '../../packages/cli/bin')
  if (existsSync(dev)) return dev
  return join(process.resourcesPath, 'cli')
}

function launchTempDir(): string {
  return join(app.getPath('userData'), 'tmp', 'system-prompts')
}

/** Electron executable и место длинного system prompt остаются в host. */
function agentLaunchOptions(): Win32LaunchEnv {
  return {
    electronNode: app.isPackaged ? process.execPath : undefined,
    systemPromptFile: () => {
      mkdirSync(launchTempDir(), { recursive: true })
      return join(launchTempDir(), `${randomUUID()}.md`)
    }
  }
}

/** Только при startup, до живых агентов: остатки прошлого Desktop instance. */
export function pruneLaunchTempFiles(): void {
  if (process.platform === 'win32') rmSync(launchTempDir(), { recursive: true, force: true })
}

let services: WorkerServices | undefined
/** Пути читаются при первом использовании, сохраняя прежний lifecycle импорта Desktop. */
function workerServices(): WorkerServices {
  services ??= createWorkerServices({
    host: {
      dataDir: app.getPath('userData'), cliBinDir: cliBinDir(),
      nodePath: app.isPackaged ? process.execPath : undefined,
      prompts: BUILTIN_PROMPTS, language: mainLocale, shell: defaultShell,
      extraPathDirs, launchOptions: agentLaunchOptions
    },
    resources: executionResources,
    messages: { error: (key, params) => new OrcaError(key, params) },
    sessions: { spawnPty, isAlive, killPty }, launcher: { launchAgent }
  })
  return services
}

export const startWorker = (...args: Parameters<WorkerServices['startWorker']>) => workerServices().startWorker(...args)
export const startCoordinator = (...args: Parameters<WorkerServices['startCoordinator']>) => workerServices().startCoordinator(...args)
export const returnToWork = (...args: Parameters<WorkerServices['returnToWork']>) => workerServices().returnToWork(...args)
export const startAssistant = (...args: Parameters<WorkerServices['startAssistant']>) => workerServices().startAssistant(...args)
export const workerPath = () => workerServices().workerPath()
