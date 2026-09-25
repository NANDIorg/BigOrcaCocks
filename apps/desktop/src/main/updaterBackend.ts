// Выбор платформенного бэкенда обновления. Отдельный от updater.ts модуль: он импортирует electron-updater,
// а `Updater` должен тестироваться в node:test без electron.
import type { PlatformUpdater } from './updater'
import type { UpdateSupport } from './updateMachine'
import { createMacUpdater, macUpdateSupport, type ElectronLike } from './macUpdater'
import { createWinUpdater } from './winUpdater'

export interface BackendEnv {
  version: string
  /** `app.isPackaged`. */
  isPackaged: boolean
  platform: NodeJS.Platform
  /** `process.env.PORTABLE_EXECUTABLE_FILE` — задан только в portable-сборке Windows. */
  portableExe: string | undefined
  /** `{ app, net }` из electron: нужны macOS-бэкенду (`net.fetch` учитывает системный прокси). */
  electron: ElectronLike
}

/** Бэкенд null — обновлять нельзя (`support.unsupportedReason` объясняет почему). */
export function createPlatformUpdater(env: BackendEnv): { support: UpdateSupport; backend: PlatformUpdater | null } {
  // В dev обновление выключено: electron-updater без app-update.yml падает, а подменять .app из `pnpm dev` нечем.
  if (!env.isPackaged) return { support: { mode: 'auto', unsupportedReason: 'dev' }, backend: null }
  switch (env.platform) {
    case 'win32':
      return createWinUpdater({ version: env.version, portableExe: env.portableExe })
    case 'darwin': {
      // Свой установщик (macUpdater.ts): dmg, App Translocation и каталог без права записи дают unsupported с причиной.
      const support = macUpdateSupport({ isPackaged: env.isPackaged })
      return { support, backend: support.unsupportedReason === null ? createMacUpdater(env.electron) : null }
    }
    default:
      return { support: { mode: 'auto', unsupportedReason: 'platform' }, backend: null }
  }
}
