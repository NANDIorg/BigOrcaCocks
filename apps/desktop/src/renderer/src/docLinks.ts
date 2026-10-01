import type { DocFile, OrcaApi } from '../../shared/ipc'
import { resolveMarkdownLink, type MarkdownLink } from './markdownAssets'
import { t } from './i18n'
import { formatFixed } from './i18n/format'

/**
 * main и preload собираются только при запуске: после обновления кода в `electron-vite dev`
 * renderer приходит по HMR, а `window.orca` остаётся старым — без `docs` (или без хендлеров в main).
 */
export function staleAppMessage(): string {
  return t('config.docs.staleApp')
}

/** `window.orca.docs` или понятная ошибка вместо «Cannot read properties of undefined». */
export function docsApi(api: Partial<OrcaApi> | undefined): OrcaApi['docs'] {
  if (!api?.docs) throw new Error(staleAppMessage())
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
 * Относительная ссылка из документа `from` на любой файл того же источника (`.ts`, картинку, другой `.md`) — путь от
 * корня источника и `#якорь`, чтобы открыть файл и прокрутить к разделу. Правила — как у ссылок markdown в «Документах»
 * (`resolveMarkdownLink`, режим `project`): точечные файлы можно, `.git` — нет. Внешние (со схемой), только якорь,
 * абсолютные пути, выход за корень и битое кодирование — null.
 */
export function resolveDocLink(from: string, href: string): MarkdownLink | null {
  return resolveMarkdownLink({ path: from, links: 'project' }, href) ?? null
}

/** Поиск по пути без учёта регистра; пробелы разделяют слова, нужны все. */
export function matchesQuery(file: DocFile, query: string): boolean {
  const path = file.path.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => path.includes(w))
}

/** Размер для списка: байты → КБ/МБ. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return t('config.docs.size.b', { n: bytes })
  if (bytes < 1024 * 1024) return t('config.docs.size.kb', { n: Math.round(bytes / 1024) })
  return t('config.docs.size.mb', { n: formatFixed(bytes / 1024 / 1024, 1) })
}
