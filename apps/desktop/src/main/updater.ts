// Обновление приложения: `Updater` — единственный источник правды `UpdateState`. Он ведёт расписание проверок,
// фоновую загрузку и отложенную установку; «как» на конкретной ОС знает `PlatformUpdater` (winUpdater.ts, macOS —
// отдельная задача), а сами переходы и решения — чистый updateMachine.ts.
// Модуль не импортирует electron (всё окружение приходит через `UpdaterHost`), поэтому тестируется в node:test.
// См. docs/architecture.md → «Обновление».
import type { UpdateInfo, UpdateInstallWhen, UpdateSettings, UpdateState } from '../shared/ipc'
import {
  CHECK_INTERVAL_MS,
  IDLE_POLL_MS,
  INITIAL_CHECK_DELAY_MS,
  canCheck,
  canDownload,
  checkFailed,
  checkFinished,
  checkStarted,
  downloadDone,
  downloadFailed,
  downloadProgress,
  downloadStarted,
  errorText,
  idleAction,
  initialUpdateState,
  installFailed,
  installStarted,
  installsOnQuit,
  isNewer,
  manualInfo,
  pendingAfterReady,
  shouldAutoDownload,
  withPending,
  type UpdateSupport
} from './updateMachine'

export { initialUpdateState, type UpdateSupport }

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
   * успешного `download()`. К этому моменту `Updater` уже снял перехват выхода (`UpdaterHost.lockQuit`), после
   * возврата сам добивает выход (`UpdaterHost.quit`) — бэкенду выходить самому не обязательно.
   */
  install(): Promise<void>
  /**
   * Версия, с которой обновились, по собственному маркеру бэкенда (macOS: `pending.json` установщика); null — маркера нет.
   * Заодно убирает остатки скачивания. `Updater.getJustUpdated` зовёт всегда, а не только когда хост ничего не знает.
   */
  consumeJustUpdated?(): string | null
}

/** Кто и почему просит подтвердить установку — от этого зависит текст диалога в main. */
export interface InstallRequest {
  /** `user` — человек нажал «установить»; `idle-reached` — ждали агентов, они закончили. */
  reason: 'user' | 'idle-reached'
  /** Сколько живых сессий агентов остановит выход. */
  workers: number
  /** Версия, до которой обновляемся. */
  version: string
}

/**
 * Ответ человека. `now` — обновить сейчас (агенты остановятся); `idle` — когда агенты закончат;
 * `cancel` — не сейчас (при `idle-reached` установка переходит на «при выходе»).
 */
export type InstallChoice = 'now' | 'idle' | 'cancel'

/** Планировщик; в тестах подменяется, чтобы не ждать настоящих часов. Возвращаемая функция отменяет таймер. */
export interface UpdaterTimers {
  after(ms: number, fn: () => void): () => void
  every(ms: number, fn: () => void): () => void
}

const realTimers: UpdaterTimers = {
  after: (ms, fn) => {
    const t = setTimeout(fn, ms)
    t.unref()
    return () => clearTimeout(t)
  },
  every: (ms, fn) => {
    const t = setInterval(fn, ms)
    t.unref()
    return () => clearInterval(t)
  }
}

/** Всё, что `Updater` берёт у приложения: настройки, число агентов, диалоги и выход. Реализация — `main/index.ts`. */
export interface UpdaterHost {
  /** Текущие настройки (читаются при каждом решении: человек может переключить их на ходу). */
  settings(): UpdateSettings
  /** Живые сессии агентов, которые остановит выход (`liveWorkerCount`). */
  liveWorkerCount(): number
  /** Диалог подтверждения установки. Вызывается, только если он нужен (есть агенты или ждали их). */
  confirmInstall(req: InstallRequest): Promise<InstallChoice>
  /** Выход подтверждён: `before-quit` больше не перехватываем (иначе `quitAndInstall` упрётся в диалог выхода). */
  lockQuit(): void
  /** Установка не удалась — снова спрашивать при выходе. */
  unlockQuit(): void
  /** Остановить агентов и выйти (без диалога). */
  quit(): void
  /** Версия, с которой обновились (из бэкапа при смене версии); null — старт обычный. */
  takeJustUpdated?(): string | null
  timers?: UpdaterTimers
}

/** Как `install()` вызывается изнутри: чем закончится сбой. */
interface InstallRun {
  /** Выход уже был запрошен человеком: если установка не удалась — выйти всё равно. */
  quitOnFailure: boolean
}

export class Updater {
  private state: UpdateState
  private listeners = new Set<(s: UpdateState) => void>()
  /** Идёт проверка или загрузка — второй такой же вызов ничего не делает. */
  private busy = false
  /** Диалог подтверждения открыт — второй не показываем. */
  private confirming = false
  private justUpdatedTaken = false
  private stopIdlePoll: (() => void) | null = null
  private stops: Array<() => void> = []
  private readonly timers: UpdaterTimers

  constructor(
    currentVersion: string,
    private readonly support: UpdateSupport,
    private readonly backend: PlatformUpdater | null,
    private readonly host: UpdaterHost
  ) {
    this.state = initialUpdateState(currentVersion, support)
    this.timers = host.timers ?? realTimers
  }

  getState(): UpdateState {
    return this.state
  }

  /** Запустить расписание: проверка через `INITIAL_CHECK_DELAY_MS` после старта и затем раз в `CHECK_INTERVAL_MS`. */
  start(): void {
    if (!this.canRun() || this.stops.length) return
    const auto = (): void => void this.runCheck(true)
    this.stops.push(this.timers.after(INITIAL_CHECK_DELAY_MS, auto), this.timers.every(CHECK_INTERVAL_MS, auto))
  }

  /** Остановить все таймеры (выход, тесты). */
  dispose(): void {
    for (const stop of this.stops) stop()
    this.stops = []
    this.stopIdlePoll?.()
    this.stopIdlePoll = null
  }

  async check(): Promise<UpdateState> {
    await this.runCheck(false)
    return this.state
  }

  async download(): Promise<UpdateState> {
    await this.runDownload()
    return this.state
  }

  async install(opts: { when: UpdateInstallWhen }): Promise<UpdateState> {
    const s = this.state
    if (s.status === 'unsupported' || s.status === 'installing') return s
    if (s.status !== 'ready') {
      throw new Error(`Обновление ещё не готово к установке (состояние: ${s.status}): дождитесь окончания загрузки`)
    }
    if (opts.when === 'quit') {
      this.setState(withPending(s, 'quit'))
    } else if (opts.when === 'idle' && this.host.liveWorkerCount() > 0) {
      this.setState(withPending(s, 'idle'))
    } else {
      // `now`, а также `idle` без живых агентов: ждать нечего.
      await this.installNow('user')
    }
    return this.state
  }

  async cancelPending(): Promise<UpdateState> {
    this.setState(withPending(this.state, null))
    return this.state
  }

  /** Версия, с которой обновились, — один раз после старта. */
  getJustUpdated(): string | null {
    if (this.justUpdatedTaken) return null
    this.justUpdatedTaken = true
    // Оба источника читаем всегда: бэкенд заодно чистит остатки скачивания, а бэкап знает о смене версии и без него.
    const fromBackend = this.backend?.consumeJustUpdated?.() ?? null
    return this.host.takeJustUpdated?.() ?? fromBackend
  }

  onChanged(cb: (s: UpdateState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /**
   * Вызывать после изменения настроек: включили `autoDownload` при найденной версии — качаем; включили
   * `installWhenIdle` при готовом обновлении, которое ждало выхода, — переходим на ожидание агентов.
   */
  settingsChanged(): void {
    const settings = this.host.settings()
    if (shouldAutoDownload(this.state, settings)) void this.runDownload()
    if (settings.installWhenIdle && this.state.status === 'ready' && this.state.installPending === 'quit') {
      this.setState(withPending(this.state, 'idle'))
    }
  }

  /**
   * Вызывается из общего пути выхода. Если обновление готово и установка при выходе не снята — запускает установку,
   * которая сама завершит приложение, и возвращает true (вызывающий `app.quit()` не делает).
   */
  installOnQuit(): boolean {
    if (!this.backend || !installsOnQuit(this.state)) return false
    void this.runInstall({ quitOnFailure: true })
    return true
  }

  /** Есть ли что показывать в пункте трея «Перезапустить и обновить до X»: версия готовой к установке сборки. */
  readyVersion(): string | null {
    return this.state.status === 'ready' ? this.state.availableVersion : null
  }

  /** Обновление вообще может работать: не dev/чужая платформа, бэкенд есть. */
  private canRun(): boolean {
    if (!this.backend) return false
    return this.state.status !== 'unsupported' || this.support.mode === 'manual-download'
  }

  /** Положить новое состояние, оповестить подписчиков и (не)включить опрос агентов. */
  private setState(next: UpdateState): void {
    if (next === this.state) return
    this.state = next
    this.syncIdlePoll()
    for (const cb of this.listeners) cb(next)
  }

  private syncIdlePoll(): void {
    const waiting = this.state.status === 'ready' && this.state.installPending === 'idle'
    if (waiting && !this.stopIdlePoll) {
      this.stopIdlePoll = this.timers.every(IDLE_POLL_MS, () => void this.evaluateIdle())
    } else if (!waiting && this.stopIdlePoll) {
      this.stopIdlePoll()
      this.stopIdlePoll = null
    }
  }

  /**
   * Проверка обновлений. `silent` — фоновая по расписанию: уважает `autoCheck`, а сбой не превращается в `error`
   * (нет сети — не повод рисовать ошибку каждые четыре часа). Ручная проверка ошибку показывает.
   * В `manual-download` (portable) статус остаётся `unsupported`, заполняются только версия и ссылка.
   */
  private async runCheck(silent: boolean): Promise<void> {
    if (!this.backend || this.busy) return
    if (silent && !this.host.settings().autoCheck) return
    const manual = this.state.status === 'unsupported'
    if (manual ? this.support.mode !== 'manual-download' : !canCheck(this.state)) return
    const before = this.state
    this.busy = true
    if (!manual) this.setState(checkStarted(before))
    let found: UpdateInfo | null = null
    try {
      const info = await this.backend.check()
      found = info && isNewer(info.version, this.state.currentVersion) ? info : null
      this.setState(manual ? manualInfo(this.state, found) : checkFinished(this.state, found))
    } catch (e) {
      if (!manual) this.setState(silent ? before : checkFailed(this.state, errorText('Не удалось проверить обновления', e)))
    } finally {
      this.busy = false
    }
    if (found && !manual && shouldAutoDownload(this.state, this.host.settings())) await this.runDownload()
  }

  private async runDownload(): Promise<void> {
    if (!this.backend || this.busy || !canDownload(this.state)) return
    this.busy = true
    this.setState(downloadStarted(this.state))
    try {
      await this.backend.download((percent) => this.setState(downloadProgress(this.state, percent)))
      this.setState(downloadDone(this.state, pendingAfterReady(this.host.settings())))
    } catch (e) {
      this.setState(downloadFailed(this.state, errorText('Не удалось скачать обновление', e)))
    } finally {
      this.busy = false
    }
    await this.evaluateIdle()
  }

  /** Спросить (если надо) и установить сейчас. `reason` — откуда вызвали: выбирает текст диалога. */
  private async installNow(reason: InstallRequest['reason']): Promise<void> {
    if (this.confirming) return
    const workers = this.host.liveWorkerCount()
    const version = this.state.availableVersion ?? ''
    let choice: InstallChoice = 'now'
    if (workers > 0 || reason === 'idle-reached') {
      this.confirming = true
      try {
        choice = await this.host.confirmInstall({ reason, workers, version })
      } finally {
        this.confirming = false
      }
    }
    // За время диалога состояние могло уйти из ready (выход, повторная установка) — тогда ничего не делаем.
    if (this.state.status !== 'ready') return
    if (choice === 'now') await this.runInstall({ quitOnFailure: false })
    else if (choice === 'idle') this.setState(withPending(this.state, 'idle'))
    else if (reason === 'idle-reached') this.setState(withPending(this.state, 'quit'))
  }

  /** Ждём агентов: когда освободились — ставим сразу (`installWhenIdle`) или спрашиваем. */
  private async evaluateIdle(): Promise<void> {
    const action = idleAction(this.state, this.host.settings(), this.host.liveWorkerCount())
    if (action === 'install') await this.runInstall({ quitOnFailure: false })
    else if (action === 'ask') await this.installNow('idle-reached')
  }

  private async runInstall(run: InstallRun): Promise<void> {
    if (!this.backend || this.state.status !== 'ready') return
    this.host.lockQuit()
    this.setState(installStarted(this.state))
    try {
      await this.backend.install()
      this.host.quit()
    } catch (e) {
      this.setState(installFailed(this.state, errorText('Не удалось установить обновление', e)))
      if (run.quitOnFailure) this.host.quit()
      else this.host.unlockQuit()
    }
  }
}

/** Всё окружение `Updater`: версия, что умеет платформа, бэкенд (null — обновлять нельзя) и связь с приложением. */
export interface UpdaterEnv {
  version: string
  support: UpdateSupport
  backend: PlatformUpdater | null
  host: UpdaterHost
}

export function createUpdater(env: UpdaterEnv): Updater {
  return new Updater(env.version, env.support, env.backend, env.host)
}
