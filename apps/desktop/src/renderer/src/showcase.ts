import type { ColumnKind, Dispatch, DispatchShowcase, HumanRequest, Task } from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'
import { showcaseFileType, showcaseMarkdown, type ShowcasePreview } from '../../shared/showcase'
import { ipcErrorCode, ipcErrorMessage } from './ipcError'
import { t } from './i18n'

// Блок «Показ» (ShowcaseBlock.tsx) и просмотрщик (ShowcaseViewer.tsx): чей показ выводить, как показать каждый файл,
// порядок файлов, вписывание страницы и что убрать из body approval. Файлы читает main — из снимка запуска или worktree
// задачи (IPC showcase:*), страницы отдаёт протокол orca-preview://; здесь — только решения без React и IPC.

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

/** Файлы показа в порядке воркера с видом показа по расширению (`SHOWCASE_FILE_TYPES`). */
export function showcaseFiles(files: readonly string[]): ShowcaseFileItem[] {
  return files.map((path) => ({
    path,
    name: path.split('/').filter(Boolean).pop() ?? path,
    view: showcaseFileType(path)?.preview ?? 'none'
  }))
}

/** Состояние подзадачи показа — цвет полосы и чип блока (вариант 2 макета): готово, на проверке или ещё в работе. */
export type ShowcaseTaskState = 'done' | 'review' | 'work'

/** Показ одного запуска, выведенный в запросе: чей он, откуда читать файлы и как подписать блок. */
export interface RequestShowcase {
  /** Запуск, сдавший показ: по нему main находит снимок (`showcase:*`, `previewUrl`). */
  dispatchId: string
  /** Задача показа: из её worktree читается старый показ без снимка. */
  taskId: string
  showcase: DispatchShowcase
  /** Approval прогона: название подзадачи — заголовок блока и группы просмотрщика. У запроса задачи — нет. */
  title?: string
  /** Approval прогона: состояние подзадачи по колонке (`kindOf`); вид колонки неизвестен — нет. */
  state?: ShowcaseTaskState
}

/** Вид колонки → состояние подзадачи блока показа; колонка неизвестна — undefined. */
export function showcaseTaskState(kind: ColumnKind | undefined): ShowcaseTaskState | undefined {
  if (kind === undefined) return undefined
  return kind === 'done' ? 'done' : kind === 'review' ? 'review' : 'work'
}

/**
 * Чьи запуски показать в запросе. approval — `showcaseDispatchIds` (approval прогона: по одному на подзадачу), а у
 * старых запросов и approval задачи — одиночный `showcaseDispatchId`; answer — показ запуска, сдавшего ответ
 * (`dispatchId`: `done --answer-file … --show …`). Остальные виды показа не несут.
 */
function showcaseDispatchIdsOf(request: HumanRequest): string[] {
  if (request.kind === 'approval') {
    if (request.showcaseDispatchIds?.length) return request.showcaseDispatchIds
    return request.showcaseDispatchId ? [request.showcaseDispatchId] : []
  }
  if (request.kind === 'answer' && request.dispatchId) return [request.dispatchId]
  return []
}

/**
 * Показы, выведенные в запросе, в порядке подзадач (`showcaseDispatchIdsOf`). Запуск не найден или без показа —
 * пропускается (снимок проекта ещё не пришёл, запуск удалён). У approval прогона (запрос без `taskId`) — заголовок
 * подзадачи из `tasks` и её состояние по `kindOf`; у запроса задачи блок один и без заголовка.
 */
export function requestShowcases(
  request: HumanRequest,
  dispatches: readonly Dispatch[] | undefined,
  tasks?: readonly Pick<Task, 'id' | 'title' | 'status'>[],
  kindOf?: (status: string) => ColumnKind | undefined
): RequestShowcase[] {
  if (!dispatches) return []
  const byId = new Map(dispatches.map((d) => [d.id, d]))
  const runLevel = request.taskId === undefined
  const out: RequestShowcase[] = []
  for (const id of showcaseDispatchIdsOf(request)) {
    const d = byId.get(id)
    if (!d?.showcase || out.some((x) => x.dispatchId === id)) continue
    const item: RequestShowcase = { dispatchId: d.id, taskId: request.taskId ?? d.taskId, showcase: d.showcase }
    if (runLevel) {
      const task = tasks?.find((t) => t.id === d.taskId)
      item.title = task?.title ?? d.taskId
      const state = task && kindOf ? showcaseTaskState(kindOf(task.status)) : undefined
      if (state) item.state = state
    }
    out.push(item)
  }
  return out
}

/** Показ approval (первый из `requestShowcases`): для пунктов ленты и мест, где нужен ответ «есть ли показ». */
export function requestShowcase(request: HumanRequest, dispatches: readonly Dispatch[] | undefined): DispatchShowcase | undefined {
  return request.kind === 'approval' ? requestShowcases(request, dispatches)[0]?.showcase : undefined
}

/**
 * Задача, из worktree которой main читает файлы показа approval. У approval задачи — она сама; у approval уровня
 * прогона (нода `human` воркфлоу глобальной задачи, без `taskId`) — подзадача первого запуска из `showcaseDispatchIds`.
 */
export function requestShowcaseTaskId(request: HumanRequest, dispatches: readonly Dispatch[] | undefined): string | undefined {
  if (request.taskId !== undefined) return request.taskId
  const [id] = showcaseDispatchIdsOf(request)
  return id && dispatches ? dispatches.find((d) => d.id === id)?.taskId : undefined
}

/** Группы просмотрщика из показов запроса: заголовок группы — подзадача (у approval прогона). */
export function requestShowcaseGroups(items: readonly RequestShowcase[]): ShowcaseGroup[] {
  return items.map((x) => showcaseGroup(x.taskId, x.dispatchId, x.showcase, x.title))
}

/** Последний сданный показ задачи (модалка задачи): тот же, что увидит человек на ноде «Человек». */
export function latestShowcase(dispatches: readonly Dispatch[], taskId: string): Dispatch | undefined {
  return dispatches
    .filter((d) => d.taskId === taskId && d.outcome === 'done' && d.showcase)
    .reduce<Dispatch | undefined>((best, d) => (!best || d.startedAt > best.startedAt ? d : best), undefined)
}

/**
 * Body approval без разделов «## Показ»: их выводят блоки «Показ» развёрнутыми, а body свёрнут — второй раз тот же
 * текст не нужен. main собирает body частями через пустую строку (`requestHuman`), раздел — `showcaseMarkdown`, у
 * approval прогона перед ним — заголовок подзадачи `### <название>` (main/workflow-run.ts). Не нашли точного совпадения
 * (запрос от другой версии) — эта часть остаётся: лучше дубль, чем потерять текст.
 */
export function bodyWithoutShowcases(body: string | undefined, items: readonly Pick<RequestShowcase, 'showcase' | 'title'>[]): string | undefined {
  let rest = body
  for (const x of items) {
    const section = showcaseMarkdown(x.showcase)
    const titled = x.title !== undefined ? `### ${x.title}\n\n${section}` : undefined
    rest = (titled !== undefined ? cutPart(rest, titled) : undefined) ?? cutPart(rest, section) ?? rest
  }
  return rest?.trim() ? rest : undefined
}

/** `body` без части `part` вместе с разделителем частей: перед ней, а если она первая — после; нет части — undefined. */
function cutPart(body: string | undefined, part: string): string | undefined {
  if (!body) return undefined
  let start = body.indexOf(part)
  if (start < 0) return undefined
  let end = start + part.length
  if (start >= 2 && body.startsWith('\n\n', start - 2)) start -= 2
  else if (body.startsWith('\n\n', end)) end += 2
  return body.slice(0, start) + body.slice(end)
}

/** Body approval без раздела «## Показ» одного показа (approval задачи). */
export function bodyWithoutShowcase(body: string | undefined, showcase: DispatchShowcase | undefined): string | undefined {
  return showcase ? bodyWithoutShowcases(body, [{ showcase }]) : body
}

// ---------- просмотрщик показа (ShowcaseViewer.tsx, PreviewFrame.tsx) ----------

/** Схема протокола показа (main/preview-protocol.ts): только такой адрес renderer ставит во фрейм или `<img>`. */
const PREVIEW_SCHEME = 'orca-preview:'

/**
 * Адрес от `showcase:previewUrl` действительно `orca-preview://…`. Проверка перед `src`: подменённый или кривой ответ
 * IPC (`https://…`, `javascript:`, `file://`) не должен попасть во фрейм — там страница уже не изолирована снимком.
 */
export function isPreviewUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.startsWith(`${PREVIEW_SCHEME}//`)) return false
  try {
    return new URL(url).protocol === PREVIEW_SCHEME
  } catch {
    return false
  }
}

/** Старый main/preload без просмотра показа: просмотрщик сразу говорит «перезапустите», а не падает. */
export class ShowcaseStaleError extends Error {
  constructor() {
    super(t('board.showcase.viewer.stale'))
    this.name = 'ShowcaseStaleError'
  }
}

/**
 * `showcase.previewUrl` или `ShowcaseStaleError`: метод появился позже остальных `showcase.*`, в старом preload его нет.
 * Хендлера нет в старом main — это уже ошибка invoke, её узнаёт `showcaseFailure`.
 */
export function showcasePreviewApi(api: Partial<OrcaApi> | undefined): OrcaApi['showcase']['previewUrl'] {
  const showcase = api?.showcase
  if (!showcase || typeof showcase.previewUrl !== 'function') throw new ShowcaseStaleError()
  return (dispatchId, path, opts) => showcase.previewUrl(dispatchId, path, opts)
}

/** Подписка на Esc из фрейма показа (`showcase:escape`); в старом preload подписки нет — Esc работает только вне фрейма. */
export function onShowcaseFrameEscape(api: Partial<OrcaApi> | undefined, cb: () => void): () => void {
  const on = api?.showcase?.onFrameEscape
  return typeof on === 'function' ? on(cb) : () => {}
}

/**
 * Почему файл не показан — состояние просмотрщика (docs/design/showcase-viewer/README.md → «Состояния»): `missing` —
 * файла нет ни в снимке, ни в worktree; `big` — больше `SHOWCASE_READ_MAX_BYTES`; `stale` — старый main/preload; `error` —
 * остальное, текст из main как есть.
 */
export type ShowcaseFailureKind = 'missing' | 'big' | 'stale' | 'error'

export interface ShowcaseFailure {
  kind: ShowcaseFailureKind
  message: string
}

const MISSING_CODES = new Set(['showcase.notFound', 'showcase.noWorktree', 'showcase.noWorktreeBranch', 'showcase.dispatchNotFound', 'showcase.taskNotFound'])

/** Ошибка IPC `showcase:*` → состояние. Узнаём по коду `OrcaError`, не по тексту: текст переведён. */
export function showcaseFailure(e: unknown): ShowcaseFailure {
  if (e instanceof ShowcaseStaleError) return { kind: 'stale', message: e.message }
  const message = ipcErrorMessage(e)
  if (/No handler registered for 'showcase:/.test(message)) return { kind: 'stale', message: t('board.showcase.viewer.stale') }
  const code = ipcErrorCode(e)
  if (code && MISSING_CODES.has(code)) return { kind: 'missing', message }
  if (code === 'showcase.tooBig') return { kind: 'big', message }
  return { kind: 'error', message }
}

/**
 * Показ одной подзадачи в просмотрщике. У approval задачи группа одна; у approval прогона — по группе на
 * `showcaseDispatchIds[i]` (заголовок — подзадача), поэтому просмотрщик сразу принимает список.
 */
export interface ShowcaseGroup {
  /** Запуск, чей показ: по нему main находит снимок (`showcase:*`, `previewUrl`). */
  dispatchId: string
  /** Задача, из worktree которой читается старый показ без снимка. */
  taskId: string
  /** Заголовок группы — подзадача; у единственной группы не выводится. */
  title?: string
  files: ShowcaseFileItem[]
}

/** Группа просмотрщика из показа одного запуска. */
export function showcaseGroup(taskId: string, dispatchId: string, showcase: DispatchShowcase, title?: string): ShowcaseGroup {
  return { taskId, dispatchId, files: showcaseFiles(showcase.files), ...(title ? { title } : {}) }
}

/** Файл в просмотрщике: номер группы и номер файла в ней. */
export interface ShowcasePos {
  group: number
  file: number
}

/** Все файлы подряд — порядок вариантов, как их сдал воркер: группы по порядку, внутри — порядок `--show`. */
export function showcaseOrder(groups: readonly ShowcaseGroup[]): ShowcasePos[] {
  return groups.flatMap((g, group) => g.files.map((_, file) => ({ group, file })))
}

/** Номер файла среди всех (с 0); позиции нет — -1. */
export function showcaseIndex(groups: readonly ShowcaseGroup[], pos: ShowcasePos): number {
  return showcaseOrder(groups).findIndex((p) => p.group === pos.group && p.file === pos.file)
}

/** Соседний файл (←/→): через границы групп, без зацикливания — на краю остаётся текущий. */
export function stepShowcase(groups: readonly ShowcaseGroup[], pos: ShowcasePos, delta: number): ShowcasePos {
  const order = showcaseOrder(groups)
  const i = order.findIndex((p) => p.group === pos.group && p.file === pos.file)
  if (i < 0) return order[0] ?? pos
  return order[Math.min(Math.max(i + delta, 0), order.length - 1)]
}

/** Позиция, если она есть в группах, иначе первый файл (группы сменились, пока просмотрщик открыт). */
export function clampShowcasePos(groups: readonly ShowcaseGroup[], pos: ShowcasePos): ShowcasePos | undefined {
  return groups[pos.group]?.files[pos.file] ? pos : showcaseOrder(groups)[0]
}

/**
 * Запись списка файлов в карточке: подряд идущие картинки склеиваются в одну сетку миниатюр (3 в ряд),
 * остальные файлы — строкой. `index` — номер файла в группе: с него открывается просмотрщик.
 */
export type ShowcaseEntry =
  | { kind: 'file'; file: ShowcaseFileItem; index: number }
  | { kind: 'images'; files: { file: ShowcaseFileItem; index: number }[] }

export function showcaseEntries(items: readonly ShowcaseFileItem[]): ShowcaseEntry[] {
  const out: ShowcaseEntry[] = []
  items.forEach((file, index) => {
    const last = out[out.length - 1]
    if (file.view !== 'image') out.push({ kind: 'file', file, index })
    else if (last?.kind === 'images') last.files.push({ file, index })
    else out.push({ kind: 'images', files: [{ file, index }] })
  })
  return out
}

/** Записей в карточке до «Ещё N файлов»: сетка картинок — одна запись. */
export const SHOWCASE_CARD_ENTRIES = 5

/** То же на подзадачу в approval прогона: блоков несколько, каждый короче. */
export const SHOWCASE_GROUP_ENTRIES = 3

/** Миниатюр в сетке: больше — пять и плитка «+N», чтобы 50 скриншотов не читались при открытии Инбокса. */
export const SHOWCASE_THUMBS = 6

/** Сколько миниатюр сетки показать и сколько уходит в плитку «+N». */
export function thumbsShown(total: number, limit = SHOWCASE_THUMBS): { shown: number; more: number } {
  return total > limit ? { shown: limit - 1, more: total - (limit - 1) } : { shown: total, more: 0 }
}

/** Сколько файлов скрыто за «Ещё N файлов» при первых `limit` записях. */
export function hiddenFiles(entries: readonly ShowcaseEntry[], limit = SHOWCASE_CARD_ENTRIES): number {
  return entries.slice(limit).reduce((n, e) => n + (e.kind === 'images' ? e.files.length : 1), 0)
}

/** Ширина страницы в просмотрщике — виртуальная: страница видит её в media-query, в окно вписывается масштабом. */
export type ShowcaseViewport = 'desktop' | 'tablet' | 'mobile'

export interface FrameViewport {
  /** Ширина, которую видит страница, px. */
  width: number
  /** Высота устройства (планшет, телефон); нет — вся доступная высота. */
  height?: number
  /** Толщина рамки устройства, px. */
  bezel: number
}

export const SHOWCASE_VIEWPORTS: Readonly<Record<ShowcaseViewport, FrameViewport>> = {
  desktop: { width: 1280, bezel: 1 },
  tablet: { width: 768, height: 1024, bezel: 10 },
  mobile: { width: 375, height: 812, bezel: 8 }
}

export const SHOWCASE_VIEWPORT_ORDER: readonly ShowcaseViewport[] = ['desktop', 'tablet', 'mobile']

/** Мини-просмотрщик в карточке: десктоп — обзор 1024 px с масштабом, телефон 375 px помещается без него. */
export const INLINE_VIEWPORTS: Readonly<Record<'desktop' | 'mobile', FrameViewport>> = {
  desktop: { width: 1024, bezel: 0 },
  mobile: { width: 375, bezel: 0 }
}

/** Высота фрейма в карточке, px. */
export const INLINE_FRAME_HEIGHT = 360

export interface FrameFit {
  /** Масштаб (≤ 1): страница шире места — уменьшается целиком. */
  scale: number
  /** Размер рамки устройства на экране, px. */
  outerWidth: number
  outerHeight: number
  /** Размер фрейма до масштаба — то, что видит страница, px. */
  frameWidth: number
  frameHeight: number
}

const MIN_FRAME_HEIGHT = 120

/** Вписать виртуальную ширину в доступное место: масштаб по ширине, высота — доступная (или устройства). */
export function fitFrame(vp: FrameViewport, availWidth: number, availHeight: number): FrameFit {
  const scale = Math.max(0.1, Math.min(1, (availWidth - 2 * vp.bezel) / vp.width))
  let inner = availHeight - 2 * vp.bezel
  if (vp.height) inner = Math.min(inner, vp.height * scale)
  inner = Math.max(MIN_FRAME_HEIGHT, inner)
  return { scale, outerWidth: vp.width * scale + 2 * vp.bezel, outerHeight: inner + 2 * vp.bezel, frameWidth: vp.width, frameHeight: inner / scale }
}

/** Масштаб в процентах для подписи («масштаб 65 %»); почти 1 — 100. */
export function scalePercent(scale: number): number {
  return scale > 0.995 ? 100 : Math.round(scale * 100)
}
