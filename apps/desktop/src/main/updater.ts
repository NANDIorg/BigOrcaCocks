// Обновление приложения: машина состояний `UpdateState` и интерфейс платформенного бэкенда.
// Сейчас — заглушка: логики проверки/загрузки/установки нет, состояние idle (или unsupported в dev).
// Windows (electron-updater) и macOS (свой установщик) подключаются отдельными задачами через `PlatformUpdater`.
// См. docs/architecture.md → «Обновление».
import type { UpdateInfo, UpdateInstallWhen, UpdateMode, UpdateState, UpdateUnsupportedReason } from '../shared/ipc'

/**
 * Платформенный бэкенд обновления. Знает только «как» на своей ОС; когда проверять, какие состояния показывать,
 * отложенную установку и настройки решает `Updater`. Ошибки бэкенд бросает исключением (по-русски, с контекстом) —
 * `Updater` переведёт их в `status: 'error'`.
 */
export interface PlatformUpdater {
  /**
   * Спросить у GitHub Releases, есть ли версия новее `app.getVersion()`.
   * Возвращает её описание или null, если новее нет. Ничего не скачивает.
   */
  check(): Promise<UpdateInfo | null>
  /**
   * Скачать версию, найденную последним `check()`, и проверить её целостность (sha512 из манифеста релиза; на macOS ещё
   * codesign). `onProgress` — процент 0–100, вызывается по ходу скачивания. Резолвится, когда всё готово к `install()`;
   * бросает при сетевой ошибке или несовпадении суммы. Вызов без предшествующего `check()` — ошибка.
   */
  download(onProgress: (percent: number) => void): Promise<void>
  /**
   * Установить скачанное. Для приложения это значит «подготовить замену и выйти»: Windows — `quitAndInstall`,
   * macOS — detached-скрипт, который после выхода подменяет .app и перезапускает его. Вызывается только после
   * успешного `download()`. Сам выход из приложения идёт через обычный путь подтверждения (`requestQuit`).
   */
  install(): Promise<void>
}

/** Что умеет платформа: `mode` и, если обновлять нельзя, почему. Определяется при старте, не меняется. */
export interface UpdateSupport {
  mode: UpdateMode
  /** null — обновление возможно. */
  unsupportedReason: UpdateUnsupportedReason | null
}

/** Начальное состояние: `unsupported` с причиной или `idle`. */
export function initialUpdateState(currentVersion: string, support: UpdateSupport): UpdateState {
  return {
    status: support.unsupportedReason ? 'unsupported' : 'idle',
    currentVersion,
    availableVersion: null,
    releaseNotes: null,
    releaseUrl: null,
    percent: null,
    installPending: null,
    mode: support.mode,
    unsupportedReason: support.unsupportedReason,
    error: null
  }
}

/**
 * Обновление — заглушка. Держит состояние и рассылает `onChanged`; методы состояние не меняют.
 * Настоящую реализацию (выбор бэкенда по платформе, расписание проверок, отложенная установка) делают отдельные задачи.
 */
export class Updater {
  private state: UpdateState
  private listeners = new Set<(s: UpdateState) => void>()
  /** Версия, с которой обновились, — отдаётся один раз (`getJustUpdated`). Заглушка её не знает. */
  private justUpdated: string | null = null

  constructor(currentVersion: string, support: UpdateSupport) {
    this.state = initialUpdateState(currentVersion, support)
  }

  getState(): UpdateState {
    return this.state
  }

  async check(): Promise<UpdateState> {
    return this.state
  }

  async download(): Promise<UpdateState> {
    return this.state
  }

  async install(_opts: { when: UpdateInstallWhen }): Promise<UpdateState> {
    return this.state
  }

  async cancelPending(): Promise<UpdateState> {
    return this.state
  }

  getJustUpdated(): string | null {
    const v = this.justUpdated
    this.justUpdated = null
    return v
  }

  onChanged(cb: (s: UpdateState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Положить новое состояние и оповестить подписчиков (для будущей реализации). */
  protected setState(next: UpdateState): void {
    this.state = next
    for (const cb of this.listeners) cb(next)
  }
}

/**
 * Заглушка-фабрика. `version` и `isPackaged` — `app.getVersion()` / `app.isPackaged`: модуль не импортирует electron,
 * чтобы тестироваться в node:test. В dev (`!isPackaged`) обновление выключено; в собранном приложении пока тоже ничего не делает.
 */
export function createUpdater(env: { version: string; isPackaged: boolean }): Updater {
  return new Updater(env.version, { mode: 'auto', unsupportedReason: env.isPackaged ? null : 'dev' })
}
