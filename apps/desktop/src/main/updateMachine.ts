// Чистая логика обновления: переходы `UpdateState` и решения «что делать сейчас». Без electron, таймеров и I/O —
// `Updater` (updater.ts) только вызывает эти функции и рассылает результат, поэтому всё покрыто node:test.
// Схема переходов — docs/architecture.md → «Обновление».
import type { UpdateInfo, UpdateSettings, UpdateState, UpdateUnsupportedReason, UpdateMode } from '../shared/ipc'

/** Что умеет платформа: `mode` и, если обновлять нельзя, почему. Определяется при старте, не меняется. */
export interface UpdateSupport {
  mode: UpdateMode
  /** null — обновление возможно. */
  unsupportedReason: UpdateUnsupportedReason | null
}

/** Как часто искать обновление в фоне. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60_000
/** Первая фоновая проверка после старта: не тормозим запуск и даём окну подняться. */
export const INITIAL_CHECK_DELAY_MS = 10_000
/** Как часто смотреть, освободились ли агенты, пока ждём `installPending = 'idle'`. */
export const IDLE_POLL_MS = 5_000

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
 * Сравнение semver-версий по числовым компонентам: -1 / 0 / 1. Префикс `v` и суффикс после `-`/`+` (beta, сборка)
 * отбрасываются: каналов нет, релизы — только чистые X.Y.Z. Недостающие компоненты — 0 (`1.2` = `1.2.0`).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parts = (v: string): number[] =>
    v.trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** Найденная версия действительно новее запущенной. Бэкенд уже фильтрует, но лишняя защита от «даунгрейда» дёшева. */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/** Ошибка → текст для пользователя: «<что делали>: <причина>». */
export function errorText(action: string, e: unknown): string {
  const reason = e instanceof Error ? e.message : String(e)
  return `${action}: ${reason}`
}

// ── Переходы. Каждая функция возвращает новое состояние; `unsupported` они не трогают (кроме manualInfo). ──

/** Поля «найденной версии» — сбрасываются, когда новее ничего нет. */
const NO_VERSION = { availableVersion: null, releaseNotes: null, releaseUrl: null } as const

function withInfo(s: UpdateState, info: UpdateInfo): UpdateState {
  return { ...s, availableVersion: info.version, releaseNotes: info.releaseNotes, releaseUrl: info.releaseUrl }
}

/** Можно ли запускать проверку из этого состояния (и вручную, и по расписанию). */
export function canCheck(s: UpdateState): boolean {
  return s.status === 'idle' || s.status === 'available' || s.status === 'error'
}

/** Можно ли качать: версия найдена и не скачивается. Из `error` — повтор после сбоя загрузки (`availableVersion` сохраняется). */
export function canDownload(s: UpdateState): boolean {
  return s.status === 'available' || (s.status === 'error' && s.availableVersion !== null)
}

export function checkStarted(s: UpdateState): UpdateState {
  return { ...s, status: 'checking', error: null }
}

/** Проверка закончилась: `info` — новее нашлась, null — нет. */
export function checkFinished(s: UpdateState, info: UpdateInfo | null): UpdateState {
  if (!info) return { ...s, status: 'idle', ...NO_VERSION, percent: null, installPending: null, error: null }
  return { ...withInfo(s, info), status: 'available', percent: null, installPending: null, error: null }
}

export function checkFailed(s: UpdateState, message: string): UpdateState {
  return { ...s, status: 'error', percent: null, error: message }
}

/**
 * Проверка в режиме `manual-download` (portable): статус остаётся `unsupported`, но версия и ссылка на релиз
 * заполняются — UI показывает «доступна X, скачать». null — новее нет, поля очищаются.
 */
export function manualInfo(s: UpdateState, info: UpdateInfo | null): UpdateState {
  return info ? withInfo(s, info) : { ...s, ...NO_VERSION }
}

export function downloadStarted(s: UpdateState): UpdateState {
  return { ...s, status: 'downloading', percent: 0, error: null }
}

/** Прогресс; тот же объект, если целый процент не изменился (событий бывает сотни в секунду). */
export function downloadProgress(s: UpdateState, percent: number): UpdateState {
  if (s.status !== 'downloading') return s
  const p = Math.max(0, Math.min(100, Math.round(percent)))
  return p === s.percent ? s : { ...s, percent: p }
}

/** Скачано и проверено. `pending` — что запланировано по умолчанию (см. `pendingAfterReady`). */
export function downloadDone(s: UpdateState, pending: 'idle' | 'quit'): UpdateState {
  return { ...s, status: 'ready', percent: null, installPending: pending, error: null }
}

export function downloadFailed(s: UpdateState, message: string): UpdateState {
  return { ...s, status: 'error', percent: null, installPending: null, error: message }
}

export function installStarted(s: UpdateState): UpdateState {
  return { ...s, status: 'installing', installPending: null, error: null }
}

export function installFailed(s: UpdateState, message: string): UpdateState {
  return { ...s, status: 'error', percent: null, installPending: null, error: message }
}

/** Отложенная установка меняется только в `ready`. */
export function withPending(s: UpdateState, pending: UpdateState['installPending']): UpdateState {
  return s.status === 'ready' && s.installPending !== pending ? { ...s, installPending: pending } : s
}

// ── Решения ──

/**
 * Что запланировано, когда обновление скачано. По умолчанию — поставить при выходе (`quit`): установка при выходе
 * действует всегда, пока человек её не снял (`cancelPending`). С `installWhenIdle` — как только агенты освободятся.
 */
export function pendingAfterReady(settings: UpdateSettings): 'idle' | 'quit' {
  return settings.installWhenIdle ? 'idle' : 'quit'
}

/** Скачивать найденное автоматически. */
export function shouldAutoDownload(s: UpdateState, settings: UpdateSettings): boolean {
  return settings.autoDownload && s.status === 'available'
}

/** Ставить ли скачанное при обычном выходе из приложения. */
export function installsOnQuit(s: UpdateState): boolean {
  return s.status === 'ready' && s.installPending !== null
}

/** Что делать, пока `installPending = 'idle'`. */
export type IdleAction =
  /** Не тот статус/не ждём или агенты ещё работают. */
  | 'wait'
  /** Агенты освободились, `installWhenIdle` включён — ставить без вопросов. */
  | 'install'
  /** Агенты освободились, автоустановки нет — спросить человека. */
  | 'ask'

export function idleAction(s: UpdateState, settings: UpdateSettings, liveWorkers: number): IdleAction {
  if (s.status !== 'ready' || s.installPending !== 'idle' || liveWorkers > 0) return 'wait'
  return settings.installWhenIdle ? 'install' : 'ask'
}
