import { execFile, execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { DOCS_LIST_LIMIT } from '../shared/docs-view'
import type { DocFile, DocGroup } from '../shared/ipc'
import { OrcaError, mt } from './i18n'
import { PROJECT_FILES_FALLBACK_HIDDEN, PROJECT_FILES_OS_NOISE } from './project-files'

/** Больше не читаем: просмотрщик не для логов и дампов. */
export const DOC_MAX_BYTES = 2 * 1024 * 1024

/** Источник документов «Проект» (остальные источники — id задач). */
export const PROJECT_SOURCE = 'project'

const MD = /\.md$/i
/** Pathspec git: `*` в нём совпадает и с `/`, так что это .md на любой глубине, без учёта регистра. */
const MD_SPEC = ':(icase)*.md'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** Пути из `git <cmd> -z ...`: разделитель NUL, имена с пробелами и кириллицей приходят как есть. */
function gitPaths(cwd: string, [cmd, ...args]: string[]): string[] {
  return git(cwd, [cmd, '-z', ...args]).split('\0').filter(Boolean)
}

export const isInside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Абсолютный путь к .md внутри root для относительного `relPath` от renderer (не доверенного).
 * Ошибка, если путь абсолютный, не .md, выходит из root (через `..` или симлинк — сравниваются
 * реальные пути), не файл или больше DOC_MAX_BYTES.
 */
export function resolveDocPath(root: string, relPath: unknown): string {
  if (typeof relPath !== 'string' || relPath.trim() === '' || relPath.includes('\0')) throw new OrcaError('docs.noPath')
  if (isAbsolute(relPath)) throw new OrcaError('docs.notRelative', { path: relPath })
  if (!MD.test(relPath)) throw new OrcaError('docs.notMarkdown', { path: relPath })
  const abs = resolve(root, relPath)
  if (!isInside(resolve(root), abs)) throw new OrcaError('docs.outside', { path: relPath })
  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    throw new OrcaError('docs.notFound', { path: relPath })
  }
  if (!isInside(realpathSync(root), real)) throw new OrcaError('docs.outside', { path: relPath })
  if (!MD.test(real)) throw new OrcaError('docs.notMarkdown', { path: relPath })
  const st = statSync(real)
  if (!st.isFile()) throw new OrcaError('docs.notFile', { path: relPath })
  if (st.size > DOC_MAX_BYTES) throw new OrcaError('docs.tooBig', { mb: DOC_MAX_BYTES / 1024 / 1024, path: relPath })
  return real
}

/** Содержимое документа с проверкой пути (см. resolveDocPath). */
export function readDoc(root: string, relPath: unknown): string {
  return readFileSync(resolveDocPath(root, relPath), 'utf8')
}

/** Размер и mtime обычного файла; симлинки и пропавшие файлы — null (в список не попадают). */
function fileInfo(root: string, path: string, untracked: boolean): DocFile | null {
  try {
    const st = lstatSync(resolve(root, path))
    if (!st.isFile()) return null
    return { path: path.split(sep).join('/'), size: st.size, mtime: st.mtimeMs, untracked }
  } catch {
    return null
  }
}

/**
 * Свежие сверху, при равном mtime — по коду символов: `localeCompare` на 100 000 файлов с одинаковым mtime (свежий
 * checkout) держал event loop десятки миллисекунд, а порядок внутри дерева renderer всё равно задаёт сам.
 */
const byMtime = (a: DocFile, b: DocFile): number => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

const execFileAsync = promisify(execFile)
/** Сколько ждать `git ls-files`: локальная операция, таймаут — только против зависшего git. */
const LIST_TIMEOUT_MS = 30_000
/** Сколько `lstat` одновременно: больше не ускоряет (упор в диск), а очередь libuv растёт. */
export const DOCS_STAT_CONCURRENCY = 64

/** Список файлов проекта (`docs:list`, группа `project`). */
export interface ProjectFileList {
  files: DocFile[]
  /** Файлов больше лимита — отданы первые по порядку git (или обхода папок). */
  truncated: boolean
}

const GIT_SEGMENT = /(^|\/)\.git(\/|$)/i

/** Последний сегмент — шум ОС, любой сегмент — `.git` (по построению его нет, но фолбэк и чужой git могут отдать). */
function hiddenPath(rel: string): boolean {
  return PROJECT_FILES_OS_NOISE.includes(rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()) || GIT_SEGMENT.test(rel)
}

/** Сколько записей разбирать между уступками event loop: разбор 100 000 путей одним куском — десятки миллисекунд. */
const PARSE_BATCH = 5000
const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Все файлы рабочей копии одним процессом: отслеживаемые (`H`, `S`, `M` — их видно, даже если они попали под
 * `.gitignore`, как в `git status`) и неотслеживаемые не игнорируемые (`?`). Асинхронно: на большом репозитории
 * синхронный вызов заморозил бы PTY и сокет. Подмодули — одна запись-папка (её отсеет `lstat`), вложенные репозитории
 * в `--others` — путь с `/` в конце.
 */
async function gitWorkingFiles(root: string): Promise<Map<string, boolean>> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    timeout: LIST_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  // путь → неотслеживаемый; Map ещё и убирает повторы (конфликт слияния — по записи на стадию).
  const out = new Map<string, boolean>()
  const entries = stdout.split('\0')
  for (let i = 0; i < entries.length; i++) {
    if (i > 0 && i % PARSE_BATCH === 0) await yieldLoop()
    const entry = entries[i]
    if (entry.length < 3 || entry[1] !== ' ') continue
    const rel = entry.slice(2)
    if (rel.endsWith('/') || hiddenPath(rel)) continue
    if (!out.has(rel)) out.set(rel, entry[0] === '?')
  }
  return out
}

/**
 * Фолбэк без git (не репозиторий, «dubious ownership», git не найден): обход папок без `.git`, `node_modules` и шума
 * ОС. Симлинки на папки не раскрываются (нет циклов). Обход останавливается на `limit + 1` файле — дальше только
 * `truncated`.
 */
async function walkFiles(root: string, limit: number): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  const queue: string[] = ['']
  for (let qi = 0; qi < queue.length && out.size <= limit; qi++) {
    const dir = queue[qi]
    let dirents
    try {
      dirents = await readdir(dir ? join(root, dir) : root, { withFileTypes: true })
    } catch {
      continue
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const d of dirents) {
      const rel = dir ? `${dir}/${d.name}` : d.name
      if (hiddenPath(rel)) continue
      if (d.isDirectory()) {
        if (!PROJECT_FILES_FALLBACK_HIDDEN.includes(d.name.toLowerCase())) queue.push(rel)
      } else if (d.isFile() || d.isSymbolicLink()) {
        out.set(rel, false)
        if (out.size > limit) break
      }
    }
  }
  return out
}

/** `fn` над `items` не больше `limit` одновременно, с сохранением порядка. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Запись списка по `lstat`: обычный файл — как есть; симлинк — `link: true`, размер и mtime цели, если она жива и это
 * файл, иначе самой ссылки (цель вне корня или битая выяснится при `docs:view`). Симлинк на папку не раскрывается и в
 * список не попадает: это не файл. Папки (подмодули), FIFO, сокеты и пропавшие файлы — null.
 */
async function projectFileInfo(root: string, rel: string, untracked: boolean): Promise<DocFile | null> {
  const abs = join(root, rel)
  let st: Stats
  try {
    st = await lstat(abs)
  } catch {
    return null
  }
  if (st.isFile()) return { path: rel, size: st.size, mtime: st.mtimeMs, untracked }
  if (!st.isSymbolicLink()) return null
  try {
    const target = await stat(abs)
    if (target.isDirectory()) return null
    if (target.isFile()) st = target
  } catch {
    // битая ссылка — видна в списке, при открытии будет «не найдено»
  }
  return { path: rel, size: st.size, mtime: st.mtimeMs, untracked, link: true }
}

/**
 * Все файлы проекта (группа `project` в `docs:list`), уважая `.gitignore`; свежие сверху. Больше `limit` — первые
 * `limit` по порядку git и `truncated`. `limit` параметризуется ради теста.
 */
export async function listProjectFiles(root: string, limit = DOCS_LIST_LIMIT): Promise<ProjectFileList> {
  let paths: Map<string, boolean>
  try {
    paths = await gitWorkingFiles(root)
  } catch {
    paths = await walkFiles(root, limit)
  }
  const entries = [...paths]
  const truncated = entries.length > limit
  const infos = await mapLimit(entries.slice(0, limit), DOCS_STAT_CONCURRENCY, ([rel, untracked]) => projectFileInfo(root, rel, untracked))
  return { files: infos.filter((f): f is DocFile => f !== null).sort(byMtime), truncated }
}

/**
 * .md, добавленные или изменённые в worktree задачи относительно базовой ветки: коммиты ветки
 * (`base...HEAD`), незакоммиченные правки и неотслеживаемые файлы. Удалённые не попадают.
 */
export function listWorktreeDocs(worktree: string, base: string): DocFile[] {
  const untracked = new Set(gitPaths(worktree, ['ls-files', '--others', '--exclude-standard', '--', MD_SPEC]))
  let committed: string[] = []
  try {
    committed = gitPaths(worktree, ['diff', '--name-only', '--relative', '--diff-filter=d', `${base}...HEAD`, '--', MD_SPEC])
  } catch {
    // базовой ветки нет (переименовали) — показываем только незакоммиченное
  }
  let dirty: string[] = []
  try {
    dirty = gitPaths(worktree, ['diff', '--name-only', '--relative', '--diff-filter=d', 'HEAD', '--', MD_SPEC])
  } catch {
    // unborn HEAD (в репозитории нет коммитов) — сравнивать не с чем, новые файлы видны как неотслеживаемые
  }
  const all = new Set([...committed, ...dirty, ...untracked])
  return [...all].flatMap((p) => fileInfo(worktree, p, untracked.has(p)) ?? []).sort(byMtime)
}

/** Задача с worktree, из которой берутся документы. */
export interface DocTask {
  id: string
  title: string
  worktree: string
  branch?: string
}

/**
 * Группы просмотрщика: «Проект» (все файлы, см. listProjectFiles) и по группе на задачу в работе (только с
 * изменёнными .md — «Документы» не превращаются в diff задачи). Ошибка git в worktree одной задачи не ломает
 * список — задача пропускается.
 */
export async function listDocGroups(root: string, base: string, tasks: DocTask[], limit = DOCS_LIST_LIMIT): Promise<DocGroup[]> {
  const project = await listProjectFiles(root, limit)
  const groups: DocGroup[] = [{
    source: PROJECT_SOURCE,
    title: mt('docs.project'),
    files: project.files,
    ...(project.truncated ? { truncated: true } : {})
  }]
  for (const t of tasks) {
    try {
      const files = listWorktreeDocs(t.worktree, base)
      if (files.length > 0) groups.push({ source: t.id, title: t.title, branch: t.branch, files })
    } catch {
      /* worktree удалён или сломан */
    }
  }
  return groups
}
