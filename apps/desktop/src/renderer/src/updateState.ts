import type { OrcaApi, UpdateState, UpdateUnsupportedReason } from '../../shared/ipc'
import { t } from './i18n'
import { formatPercent } from './i18n/format'

/**
 * Что показывать при каком состоянии обновления (`UpdateState` из main). Без React и без побочных эффектов:
 * компоненты (`UpdateBanner.tsx`, `settings/UpdatesSection.tsx`) только рисуют то, что вернули функции отсюда.
 */

/** Действие, которое плашка предлагает человеку. */
export type UpdateAction = 'whatsNew' | 'download' | 'install' | 'retry' | 'openRelease' | 'cancelPending'

export type UpdateBannerKind = 'available' | 'downloading' | 'ready' | 'installing' | 'error' | 'manual'

export interface UpdateBannerView {
  kind: UpdateBannerKind
  title: string
  /** Вторая строка: причина, ошибка, «установится при выходе». */
  detail?: string
  /** Прогресс 0–100 (`downloading`); null — размер ещё неизвестен, полоса без значения. */
  percent?: number | null
  /** Кнопки по порядку показа. */
  actions: UpdateAction[]
  /** Главная кнопка (акцент) — то, ради чего плашка появилась; не всегда первая («Что нового» идёт раньше «Скачать»). */
  primary?: UpdateAction
}

/** `0.4.2` → `v0.4.2`. */
export function versionLabel(version: string): string {
  return version.startsWith('v') ? version : `v${version}`
}

/** Причина недоступности обновления по-человечески; неизвестная (новый main) — общий текст. */
export function unsupportedText(reason: UpdateUnsupportedReason | null): string {
  switch (reason) {
    case 'dev':
    case 'portable':
    case 'not-in-applications':
    case 'no-write-access':
    case 'translocated':
      return t(`shell.update.reason.${reason}`)
    default:
      return t('shell.update.reason.other')
  }
}

/** Что запланировано на установку: подпись под «X готова». */
export function pendingText(pending: UpdateState['installPending']): string | undefined {
  if (pending === 'quit') return t('shell.update.pending.quit')
  if (pending === 'idle') return t('shell.update.pending.idle')
  return undefined
}

/**
 * Плашка в сайдбаре. null — показывать нечего: нет новой версии, идёт тихая проверка, dev-запуск.
 * Проверку (`checking`) не показываем: фоновая, без результата человеку не нужна.
 */
export function bannerView(s: UpdateState | null): UpdateBannerView | null {
  if (!s) return null
  const version = s.availableVersion ? versionLabel(s.availableVersion) : ''
  const notes: UpdateAction[] = s.releaseNotes ? ['whatsNew'] : []
  switch (s.status) {
    case 'available':
      return { kind: 'available', title: t('shell.update.available', { version }), actions: [...notes, 'download'], primary: 'download' }
    case 'downloading':
      return { kind: 'downloading', title: t('shell.update.downloading', { version }), percent: s.percent, actions: [] }
    case 'ready':
      return {
        kind: 'ready',
        title: t('shell.update.ready', { version }),
        detail: pendingText(s.installPending),
        // «Отменить» — только пока установка отложена; иначе главная кнопка — «Перезапустить и обновить».
        actions: s.installPending ? ['install', 'cancelPending', ...notes] : ['install', ...notes],
        primary: 'install'
      }
    case 'installing':
      return { kind: 'installing', title: t('shell.update.installing', { version }), actions: [] }
    case 'error':
      return { kind: 'error', title: t('shell.update.error'), detail: s.error ?? undefined, actions: ['retry'], primary: 'retry' }
    case 'unsupported': {
      // Найденная версия при unsupported бывает только в manual-download (portable, macOS вне «Программ»): ставить нельзя, скачать — можно.
      if (s.mode !== 'manual-download' || !s.availableVersion || !s.releaseUrl) return null
      return {
        kind: 'manual',
        title: t('shell.update.available', { version }),
        detail: unsupportedText(s.unsupportedReason),
        actions: [...notes, 'openRelease'],
        primary: 'openRelease'
      }
    }
    default:
      return null
  }
}

/** Кнопку «Проверить сейчас» можно нажать: main в этих состояниях проверку игнорирует или она не нужна. */
export function canCheck(s: UpdateState | null): boolean {
  if (!s) return false
  return s.status === 'idle' || s.status === 'available' || s.status === 'error'
}

/** Статус одной строкой для «Настройки → Обновления». */
export function statusLine(s: UpdateState): string {
  const version = s.availableVersion ? versionLabel(s.availableVersion) : ''
  switch (s.status) {
    case 'checking':
      return t('settings.updates.status.checking')
    case 'available':
      return t('settings.updates.status.available', { version })
    case 'downloading':
      return t('settings.updates.status.downloading', { version, percent: formatPercent(s.percent ?? 0) })
    case 'ready':
      return [t('settings.updates.status.ready', { version }), pendingText(s.installPending)].filter(Boolean).join(' ')
    case 'installing':
      return t('settings.updates.status.installing', { version })
    case 'error':
      return s.error ? t('settings.updates.status.error', { error: s.error }) : t('settings.updates.status.errorNoText')
    case 'unsupported':
      return s.availableVersion
        ? `${t('settings.updates.status.available', { version })} ${unsupportedText(s.unsupportedReason)}`
        : unsupportedText(s.unsupportedReason)
    default:
      return t('settings.updates.status.idle')
  }
}

/** Плашка или настройки просят внимания человека (точка на шестерёнке, когда сайдбар скрыт). */
export function needsAttention(s: UpdateState | null): boolean {
  const view = bannerView(s)
  return view !== null && view.kind !== 'downloading' && view.kind !== 'installing'
}

/** Ссылка на релиз безопасна для открытия во внешнем браузере: только http(s). */
export function isReleaseUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

/**
 * `window.orca.updates` или null. В `pnpm dev` main и preload обновляются только перезапуском, поэтому у старого
 * preload API нет — вместо падения UI показывает `common.staleApp` (тот же приём, что `docsApi` в docLinks.ts).
 */
export function updatesApi(api: Partial<OrcaApi> | undefined): OrcaApi['updates'] | null {
  const u = api?.updates
  return u && typeof u.getState === 'function' ? u : null
}

/** Preload новый, а main старый — invoke падает с «No handler registered for 'updates:…'». */
export function isStaleUpdatesError(message: string): boolean {
  return /No handler registered for 'updates:/.test(message)
}
