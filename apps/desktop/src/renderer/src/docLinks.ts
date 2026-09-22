import type { DocFile, OrcaApi } from '../../shared/ipc'

/**
 * main и preload собираются только при запуске: после обновления кода в `electron-vite dev`
 * renderer приходит по HMR, а `window.orca` остаётся старым — без `docs` (или без хендлеров в main).
 */
export const STALE_APP_MESSAGE = 'Приложение запущено со старой версией main/preload, где ещё нет «Документов». Перезапустите приложение.'

/** `window.orca.docs` или понятная ошибка вместо «Cannot read properties of undefined». */
export function docsApi(api: Partial<OrcaApi> | undefined): OrcaApi['docs'] {
  if (!api?.docs) throw new Error(STALE_APP_MESSAGE)
  return api.docs
}

/** Preload новый, а main старый — invoke падает с «No handler registered for 'docs:…'». */
export function isStaleDocsError(message: string): boolean {
  return /No handler registered for 'docs:/.test(message)
}

/** «Новый/изменён»: не отслеживается git'ом или менялся за последние сутки. */
export const RECENT_MS = 24 * 60 * 60 * 1000

export function isRecent(file: DocFile, now: number): boolean {
  return file.untracked || now - file.mtime < RECENT_MS
}

/**
 * Относительная ссылка из документа `from` на другой .md — путь от корня того же источника.
 * Внешние ссылки (со схемой), якоря, абсолютные пути, не-.md и выход за корень — null.
 */
export function resolveDocLink(from: string, href: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) return null
  let target: string
  try {
    target = decodeURIComponent(href.split(/[?#]/)[0])
  } catch {
    return null
  }
  if (!/\.md$/i.test(target)) return null
  const parts = from.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/')
}

/** Якорь ссылки на документ: «b.md#Раздел» → «Раздел». Нет якоря — undefined. */
export function docLinkHash(href: string): string | undefined {
  const i = href.indexOf('#')
  if (i < 0) return undefined
  try {
    return decodeURIComponent(href.slice(i + 1)) || undefined
  } catch {
    return undefined
  }
}

/** Поиск по пути без учёта регистра; пробелы разделяют слова, нужны все. */
export function matchesQuery(file: DocFile, query: string): boolean {
  const path = file.path.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => path.includes(w))
}

/** Размер для списка: байты → КБ/МБ. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}
