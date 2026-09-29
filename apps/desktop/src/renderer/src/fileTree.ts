import type { ProjectFileEntry, ProjectFileKind, ProjectFilesListing } from '../../shared/ipc'

/**
 * Состояние вкладки «Файлы» (FilesView.tsx): ленивое дерево корня проекта. Чистые функции — загрузку по IPC,
 * фокус и localStorage делает компонент. Пути — от корня проекта через `/`, '' — сам корень.
 *
 * Загрузка устроена одним механизмом: раскрытие, «Повторить», «Обновить» и восстановление раскрытых папок только
 * меняют состояние, а какие папки читать — решает `pendingLoads`. Так нет второго пути, где забыли бы про лимит
 * параллельных запросов или про защиту от двойной загрузки.
 */

/** Отказ чтения папки: текст уже на языке интерфейса (`filesErrorMessage`), код — для решений в логике. */
export interface FileError {
  code?: string
  message: string
  /** Старый main/preload: «Повторить» бесполезно, нужен перезапуск. */
  stale?: boolean
}

export interface DirState {
  /** null — ещё не прочитана (или последняя попытка — ошибка). */
  entries: ProjectFileEntry[] | null
  truncated: boolean
  error: FileError | null
  /** Запрос в полёте; пока он идёт, второй на ту же папку не отправляется. */
  loading: boolean
  /** Попросили перечитать («Обновить», пропала вложенная папка). */
  stale: boolean
  /** Номер последнего запроса: ответ на другой (папку закрыли и открыли заново) отбрасывается. */
  req: number
}

export interface FileTreeState {
  projectId: string
  dirs: Record<string, DirState>
  /** Раскрытые папки. Корень раскрыт всегда и в наборе не хранится. */
  open: Set<string>
  selected: string | null
}

/** Сколько папок читаем одновременно: «Обновить» с сотней раскрытых папок не должно заваливать main. */
export const LOAD_CONCURRENCY = 4
/** Сколько раскрытых папок помним между запусками. */
export const OPEN_LIMIT = 200
/** Перечитывать дерево при возврате фокуса окну не чаще. */
export const FOCUS_REFRESH_MS = 5000

export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name)

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Глубина: корень — 0, запись корня — 1. */
export const depthOf = (path: string): number => (path === '' ? 0 : path.split('/').length)

/** `path` — сама папка `dir` или что-то внутри неё. */
const within = (path: string, dir: string): boolean => dir === '' || path === dir || path.startsWith(`${dir}/`)

export function initialTree(projectId: string, open: Iterable<string> = []): FileTreeState {
  return { projectId, dirs: {}, open: new Set([...open].filter((p) => p !== '')), selected: null }
}

const isOpen = (s: FileTreeState, path: string): boolean => path === '' || s.open.has(path)

/** Запись по пути или undefined, если её родитель не прочитан или записи в нём нет. */
export function findEntry(s: FileTreeState, path: string): ProjectFileEntry | undefined {
  if (path === '') return undefined
  const name = baseName(path)
  return s.dirs[parentPath(path)]?.entries?.find((e) => e.name === name)
}

/** Папка видна: все её предки раскрыты, и каждая есть папкой в прочитанном родителе. */
function isVisibleDir(s: FileTreeState, path: string): boolean {
  if (path === '') return true
  if (!isOpen(s, parentPath(path)) || !isVisibleDir(s, parentPath(path))) return false
  return findEntry(s, path)?.kind === 'dir'
}

/**
 * Какие папки прочитать сейчас: видимые раскрытые, которые ещё не читали или попросили перечитать, без тех, что
 * уже в полёте. Родители раньше детей (восстановление раскрытых — по глубине), не больше свободных слотов из
 * `LOAD_CONCURRENCY`.
 */
export function pendingLoads(s: FileTreeState, limit = LOAD_CONCURRENCY): string[] {
  const inFlight = Object.values(s.dirs).filter((d) => d.loading).length
  const free = limit - inFlight
  if (free <= 0) return []
  return ['', ...s.open]
    .filter((p) => {
      const d = s.dirs[p]
      if (d?.loading) return false
      if (d && !d.stale && (d.entries !== null || d.error !== null)) return false
      return isVisibleDir(s, p)
    })
    .sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, free)
}

export interface LoadRequest {
  path: string
  /** Номер запроса — уникальный в пределах вкладки; выдаёт компонент, чтобы обновление состояния оставалось чистым. */
  req: number
}

/**
 * Отметить запросы отправленными: по номеру `applyListing` / `applyError` узнают свой ответ. Папку, которая уже в
 * полёте, не трогаем — ответ на лишний запрос отбросится по номеру.
 */
export function markLoading(s: FileTreeState, reqs: readonly LoadRequest[]): FileTreeState {
  const fresh = reqs.filter((r) => !s.dirs[r.path]?.loading)
  if (fresh.length === 0) return s
  const dirs = { ...s.dirs }
  for (const { path, req } of fresh) {
    const prev = dirs[path]
    dirs[path] = { entries: prev?.entries ?? null, truncated: prev?.truncated ?? false, error: prev?.error ?? null, loading: true, stale: false, req }
  }
  return { ...s, dirs }
}

/** Ответ относится к текущему состоянию: тот же проект, та же папка, тот же запрос. */
function current(s: FileTreeState, projectId: string, dir: string, req: number): DirState | undefined {
  const d = s.dirs[dir]
  return s.projectId === projectId && d?.loading && d.req === req ? d : undefined
}

/** Убрать из состояния папку `path` целиком (её саму и всё внутри): она пропала с диска. */
function dropSubtree(s: FileTreeState, path: string): FileTreeState {
  const dirs: Record<string, DirState> = {}
  for (const [k, v] of Object.entries(s.dirs)) if (!within(k, path)) dirs[k] = v
  const open = new Set([...s.open].filter((p) => !within(p, path)))
  const selected = s.selected !== null && within(s.selected, path) ? null : s.selected
  return { ...s, dirs, open, selected }
}

/**
 * Применить ответ `files:list`. Чужой ответ (другой проект, другая папка в эхе `listing.dir`, устаревший запрос)
 * не меняет состояние. Пропавшие записи молча выпадают: вложенные папки — из раскрытых, запись — из выделения.
 */
export function applyListing(s: FileTreeState, projectId: string, dir: string, req: number, listing: ProjectFilesListing): FileTreeState {
  if (listing.dir !== dir || !current(s, projectId, dir, req)) return s
  let next: FileTreeState = { ...s, dirs: { ...s.dirs, [dir]: { entries: listing.entries, truncated: listing.truncated, error: null, loading: false, stale: false, req } } }
  const kinds = new Map(listing.entries.map((e) => [e.name, e.kind]))
  const gone = new Set<string>()
  for (const p of [...next.open, ...Object.keys(next.dirs)]) {
    if (p !== '' && parentPath(p) === dir && kinds.get(baseName(p)) !== 'dir') gone.add(p)
  }
  for (const p of gone) next = dropSubtree(next, p)
  if (next.selected !== null && parentPath(next.selected) === dir && !kinds.has(baseName(next.selected))) next = { ...next, selected: null }
  return next
}

/**
 * Применить отказ `files:list`. `files.notFound` у вложенной папки — её удалили после чтения родителя: родителя
 * перечитываем (он и уберёт папку из дерева).
 */
export function applyError(s: FileTreeState, projectId: string, dir: string, req: number, error: FileError): FileTreeState {
  if (!current(s, projectId, dir, req)) return s
  const dirs = { ...s.dirs, [dir]: { entries: null, truncated: false, error, loading: false, stale: false, req } }
  if (error.code === 'files.notFound' && dir !== '') {
    const parent = dirs[parentPath(dir)]
    if (parent && !parent.loading) dirs[parentPath(dir)] = { ...parent, stale: true }
  }
  return { ...s, dirs }
}

/** Раскрыть или свернуть папку. Содержимое свёрнутых остаётся: повторное раскрытие берёт его из состояния. */
export function toggleDir(s: FileTreeState, path: string): FileTreeState {
  if (path === '') return s
  const open = new Set(s.open)
  if (open.has(path)) open.delete(path)
  else open.add(path)
  return { ...s, open }
}

/** «Повторить» после ошибки: папка снова считается непрочитанной, `pendingLoads` отправит запрос. */
export function retryDir(s: FileTreeState, path: string): FileTreeState {
  const d = s.dirs[path]
  if (!d || d.loading) return s
  return { ...s, dirs: { ...s.dirs, [path]: { ...d, error: null, stale: true } } }
}

/**
 * «Обновить»: перечитать корень и все раскрытые папки, сохранив раскрытость и выделение. Свёрнутые с прочитанным
 * содержимым перечитаются при следующем раскрытии (`pendingLoads` берёт только видимые). Папки в полёте не трогаем —
 * поэтому второй клик подряд не даёт второй загрузки.
 */
export function refreshAll(s: FileTreeState): FileTreeState {
  let changed = false
  const dirs = { ...s.dirs }
  for (const [p, d] of Object.entries(s.dirs)) {
    if (d.loading || d.stale) continue
    dirs[p] = { ...d, stale: true }
    changed = true
  }
  return changed ? { ...s, dirs } : s
}

export const isBusy = (s: FileTreeState): boolean => Object.values(s.dirs).some((d) => d.loading)

export type TreeRow =
  | { type: 'entry'; path: string; name: string; kind: ProjectFileKind; depth: number; open: boolean }
  | { type: 'loading'; dir: string; depth: number }
  | { type: 'empty'; dir: string; depth: number }
  | { type: 'error'; dir: string; depth: number; error: FileError }
  | { type: 'truncated'; dir: string; depth: number; count: number }

/**
 * Видимые строки дерева сверху вниз: записи раскрытых папок и служебные строки («Загрузка…», ошибка, пусто,
 * обрезано) на глубине содержимого папки. `depth` — отступ: записи корня — 0.
 */
export function visibleRows(s: FileTreeState): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number): void => {
    const d = s.dirs[dir]
    if (d?.error) {
      rows.push({ type: 'error', dir, depth, error: d.error })
      return
    }
    if (!d?.entries) {
      rows.push({ type: 'loading', dir, depth })
      return
    }
    if (d.entries.length === 0) rows.push({ type: 'empty', dir, depth })
    for (const e of d.entries) {
      const path = joinPath(dir, e.name)
      const open = e.kind === 'dir' && s.open.has(path)
      rows.push({ type: 'entry', path, name: e.name, kind: e.kind, depth, open })
      if (open) walk(path, depth + 1)
    }
    if (d.truncated) rows.push({ type: 'truncated', dir, depth, count: d.entries.length })
  }
  walk('', 0)
  return rows
}

export const entryRows = (rows: readonly TreeRow[]): Extract<TreeRow, { type: 'entry' }>[] =>
  rows.filter((r): r is Extract<TreeRow, { type: 'entry' }> => r.type === 'entry')

export type TreeKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

export function isTreeKey(key: string): key is TreeKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End'
}

/**
 * Клавиатура дерева (WAI-ARIA tree): ↑/↓ — соседняя видимая запись, → — раскрыть папку или шаг к первой записи
 * внутри, ← — свернуть или шаг к родителю, Home/End — первая/последняя. Выделение и фокус совпадают.
 * Ничего не выделено — первая запись.
 */
export function navigate(s: FileTreeState, key: TreeKey): FileTreeState {
  const rows = entryRows(visibleRows(s))
  if (rows.length === 0) return s
  const i = s.selected === null ? -1 : rows.findIndex((r) => r.path === s.selected)
  const select = (path: string | undefined): FileTreeState => (path === undefined || path === s.selected ? s : { ...s, selected: path })
  if (i < 0 || key === 'Home') return select(rows[0]!.path)
  if (key === 'End') return select(rows[rows.length - 1]!.path)
  if (key === 'ArrowUp') return select(rows[Math.max(i - 1, 0)]!.path)
  if (key === 'ArrowDown') return select(rows[Math.min(i + 1, rows.length - 1)]!.path)
  const row = rows[i]!
  if (key === 'ArrowRight') {
    if (row.kind !== 'dir') return s
    if (!row.open) return toggleDir(s, row.path)
    const next = rows[i + 1]
    return next && parentPath(next.path) === row.path ? select(next.path) : s
  }
  if (row.open) return toggleDir(s, row.path)
  const parent = parentPath(row.path)
  return parent === '' ? s : select(parent)
}

/**
 * Раскрытые папки для сохранения и восстановления: только непустые строки без дублей, по глубине (родители
 * раньше детей), не больше `OPEN_LIMIT` — лишние, самые глубокие, отбрасываются.
 */
export function restoreOrder(paths: readonly unknown[]): string[] {
  const valid = [...new Set(paths.filter((p): p is string => typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.endsWith('/')))]
  return valid.sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, OPEN_LIMIT)
}

export const openStorageKey = (projectId: string): string => `orca.files.open.${projectId}`

/** Сохранённые раскрытые папки; нет, битые или нет localStorage — пусто. */
export function readOpen(storage: Pick<Storage, 'getItem'> | undefined, projectId: string): string[] {
  try {
    const raw = storage?.getItem(openStorageKey(projectId))
    const v: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? restoreOrder(v) : []
  } catch {
    return []
  }
}

export function writeOpen(storage: Pick<Storage, 'setItem'> | undefined, projectId: string, open: Iterable<string>): void {
  try {
    storage?.setItem(openStorageKey(projectId), JSON.stringify(restoreOrder([...open])))
  } catch {
    // localStorage недоступен или переполнен — раскрытые папки просто не переживут перезапуск
  }
}

/** Перечитать при возврате фокуса окну: прошло не меньше `FOCUS_REFRESH_MS` с прошлого раза. */
export const focusRefreshDue = (last: number, now: number): boolean => now - last >= FOCUS_REFRESH_MS

export type FileIconKind = 'folder' | 'doc' | 'image' | 'link' | 'file'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?)$/i

/** Иконка строки: текст (.md/.txt), картинка, симлинк, прочий файл. */
export function fileIconKind(name: string, kind: ProjectFileKind): FileIconKind {
  if (kind === 'dir') return 'folder'
  if (kind === 'symlink') return 'link'
  if (/\.(md|markdown|txt)$/i.test(name)) return 'doc'
  if (IMAGE_EXT.test(name)) return 'image'
  return 'file'
}

/** Полный путь для подсказки: разделитель — как у корня (на Windows корень приходит с `\`). */
export function absolutePath(root: string, path: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  if (path === '') return root
  return `${root.replace(/[\\/]+$/, '')}${sep}${sep === '/' ? path : path.split('/').join(sep)}`
}
