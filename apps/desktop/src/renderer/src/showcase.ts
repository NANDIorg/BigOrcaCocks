import type { Dispatch, DispatchShowcase, HumanRequest } from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'
import { showcaseFileType, showcaseMarkdown, type ShowcasePreview } from '../../shared/showcase'
import { t } from './i18n'

// Блок «Показ» (ShowcaseBlock.tsx): чей показ выводить, как показать каждый файл и что убрать из body approval.
// Файлы читает main из worktree задачи (IPC showcase:*), здесь — только решения без React и IPC.

/**
 * main и preload собираются только при запуске: после обновления кода в `electron-vite dev` renderer приходит
 * по HMR, а `window.orca` остаётся старым — без `showcase` (или без хендлеров в main). Как `STALE_APP_MESSAGE`
 * в docLinks.ts.
 */
export function showcaseStaleMessage(): string {
  return t('board.showcase.stale')
}

/** `window.orca.showcase` или понятная ошибка вместо «Cannot read properties of undefined». */
export function showcaseApi(api: Partial<OrcaApi> | undefined): OrcaApi['showcase'] {
  if (!api?.showcase) throw new Error(showcaseStaleMessage())
  return api.showcase
}

/** Текст ошибки IPC (`ipcErrorMessage`) для человека: preload новый, а main старый — «No handler registered for 'showcase:…'». */
export function showcaseErrorText(message: string): string {
  return /No handler registered for 'showcase:/.test(message) ? showcaseStaleMessage() : message
}

/** Как показать файл: `none` — тип не из белого списка, main его не откроет, остаётся только путь. */
export type ShowcaseFileView = ShowcasePreview | 'none'

export interface ShowcaseFileItem {
  path: string
  /** Имя файла без папок — подпись в списке. */
  name: string
  view: ShowcaseFileView
}

/** Сколько картинок превьюить сразу: остальные — по кнопке, чтобы 50 скриншотов не читались при открытии Инбокса. */
export const SHOWCASE_AUTO_PREVIEWS = 6

/** Файлы показа в порядке воркера с видом показа по расширению (`SHOWCASE_FILE_TYPES`). */
export function showcaseFiles(files: readonly string[]): ShowcaseFileItem[] {
  return files.map((path) => ({
    path,
    name: path.split('/').filter(Boolean).pop() ?? path,
    view: showcaseFileType(path)?.preview ?? 'none'
  }))
}

/** Картинки, превью которых грузится сразу: первые `SHOWCASE_AUTO_PREVIEWS` по порядку воркера. */
export function autoPreviewPaths(items: readonly ShowcaseFileItem[], limit = SHOWCASE_AUTO_PREVIEWS): Set<string> {
  return new Set(items.filter((f) => f.view === 'image').slice(0, limit).map((f) => f.path))
}

/** Показ, выведенный в approval: dispatch из `showcaseDispatchId`. У старых запросов и других видов — нет. */
export function requestShowcase(request: HumanRequest, dispatches: readonly Dispatch[] | undefined): DispatchShowcase | undefined {
  if (request.kind !== 'approval' || !request.showcaseDispatchId || !dispatches) return undefined
  return dispatches.find((d) => d.id === request.showcaseDispatchId)?.showcase
}

/** Последний сданный показ задачи (модалка задачи): тот же, что увидит человек на ноде «Человек». */
export function latestShowcase(dispatches: readonly Dispatch[], taskId: string): Dispatch | undefined {
  return dispatches
    .filter((d) => d.taskId === taskId && d.outcome === 'done' && d.showcase)
    .reduce<Dispatch | undefined>((best, d) => (!best || d.startedAt > best.startedAt ? d : best), undefined)
}

/**
 * Body approval без раздела «## Показ»: его выводит блок «Показ» развёрнутым, а body свёрнут — второй раз тот же
 * текст не нужен. main собирает body частями через пустую строку (`requestHuman`), раздел — `showcaseMarkdown`.
 * Не нашли точного совпадения (запрос от другой версии) — body как есть: лучше дубль, чем потерять текст.
 */
export function bodyWithoutShowcase(body: string | undefined, showcase: DispatchShowcase | undefined): string | undefined {
  if (!body || !showcase) return body
  const section = showcaseMarkdown(showcase)
  let start = body.indexOf(section)
  if (start < 0) return body
  let end = start + section.length
  // Вместе с разделителем частей: перед разделом, а если он первый — после.
  if (start >= 2 && body.startsWith('\n\n', start - 2)) start -= 2
  else if (body.startsWith('\n\n', end)) end += 2
  const rest = body.slice(0, start) + body.slice(end)
  return rest.trim() ? rest : undefined
}
