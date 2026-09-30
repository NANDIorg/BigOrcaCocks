import type { OrcaApi, UpdateInfo, UpdateState, UpdateUnsupportedReason } from '../../shared/ipc'
import { releaseVersionLabel } from '@orca-board/core'
import { t } from './i18n'
import { formatPercent } from './i18n/format'
import { marked, type Token } from 'marked'

/** Заметки относятся к показанной версии: найденной из main или установленной из самой сборки. */
export function cardRelease(state: UpdateState | null, bundled: Pick<UpdateInfo, 'version' | 'releaseNotes'>): UpdateInfo | null {
  if (!state) return null
  const version = state.availableVersion ?? state.currentVersion
  const tag = version.startsWith('v') ? version : `v${version}`
  return {
    version,
    releaseNotes: state.availableVersion
      ? state.releaseNotes?.trim() ?? ''
      : version === bundled.version ? bundled.releaseNotes : '',
    releaseUrl: (state.availableVersion ? state.releaseUrl : null)
      ?? `https://github.com/NANDIorg/BigOrcaCocks/releases/tag/${encodeURIComponent(tag)}`
  }
}

/** Анонс из первого абзаца или пункта релиза. Возвращает только текст; HTML/картинки/код не становятся анонсом. */
export function releaseSummary(notes: string | null): string {
  if (!notes?.trim()) return ''
  function plain(tokens: Token[]): string {
    return tokens.map((token) => {
      if (token.type === 'html' || token.type === 'image' || token.type === 'code') return ''
      if ('tokens' in token && token.tokens) return plain(token.tokens)
      if (token.type === 'br') return ' '
      return 'text' in token && typeof token.text === 'string' ? token.text : ''
    }).join('')
  }
  for (const token of marked.lexer(notes)) {
    const tokens = token.type === 'paragraph' ? token.tokens : token.type === 'list' ? token.items[0]?.tokens : undefined
    if (!tokens) continue
    const text = plain(tokens).replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (text.length <= 190) return text
    const start = text.slice(0, 190)
    const space = start.lastIndexOf(' ')
    return `${space > 120 ? start.slice(0, space) : start}…`
  }
  return ''
}

/** Один диапазон для ширины полосы, подписи и aria. Неизвестный размер не превращается в «0%». */
export function updateProgress(percent: number | null): number | null {
  return percent === null || !Number.isFinite(percent) ? null : Math.max(0, Math.min(100, Math.round(percent)))
}

/** Check invoke ждёт и автоматическое скачивание: реальные download/ready/installing важнее локального флага. */
export function cardStatus(s: UpdateState | null, checking: boolean): UpdateState['status'] | 'loading' {
  if (s?.status === 'downloading' || s?.status === 'ready' || s?.status === 'installing') return s.status
  return checking ? 'checking' : s?.status ?? 'loading'
}

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

/** В строках версии показываем животное; компактный счётчик навигации оставляет только SemVer. */
export function versionLabel(version: string, withCodename = true): string {
  const label = version.startsWith('v') ? version : `v${version}`
  return withCodename ? releaseVersionLabel(label) : label
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
    || (s.status === 'unsupported' && s.mode === 'manual-download')
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
