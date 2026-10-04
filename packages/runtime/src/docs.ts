import { isInside } from './path-safety.ts'
import { createGitProcessService, GitProcessError, type GitProcessService } from './git-process.ts'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { TaskStore } from '@orca-board/core'
import { DOCS_LIST_LIMIT } from '@orca-board/contracts'
import type { DocFile, DocGroup } from '@orca-board/contracts'
import type { FileMessages } from './file-messages.ts'
import { PROJECT_FILES_FALLBACK_HIDDEN, PROJECT_FILES_OS_NOISE } from './project-files.ts'

/** Список файлов проекта (`docs:list`, группа `project`). */
export interface ProjectFileList {
  files: DocFile[]
  /** Файлов больше лимита — отданы сначала отслеживаемые, затем неотслеживаемые (или первые по обходу папок). */
  truncated: boolean
}

export interface DocTask {
  id: string
  title: string
  worktree: string
  branch?: string
}

/** Больше не читаем: просмотрщик не для логов и дампов. */
export const DOC_MAX_BYTES = 2 * 1024 * 1024
/** Источник документов «Проект» (остальные источники — id задач). */
export const PROJECT_SOURCE = 'project'
/** Сколько `lstat` одновременно: больше не ускоряет (упор в диск), а очередь libuv растёт. */
export const DOCS_STAT_CONCURRENCY = 64

export function createDocServices(deps: { messages: FileMessages & { text(key: 'docs.project'): string }; processes?: GitProcessService }) {
  const OrcaError = deps.messages.Error
  const mt = deps.messages.text
  const processes = deps.processes ?? createGitProcessService()
  const preserveCancellation = (error: unknown) => { if (error instanceof GitProcessError && error.cancelled) throw error }

  const MD = /\.md$/i
  /** Pathspec git: `*` в нём совпадает и с `/`, так что это .md на любой глубине, без учёта регистра. */
  const MD_SPEC = ':(icase)*.md'

  async function git(cwd: string, args: string[]): Promise<string> {
    return (await processes.run(cwd, args, { maxBuffer: 64 * 1024 * 1024 })).stdout
  }

  /** Пути из `git <cmd> -z ...`: разделитель NUL, имена с пробелами и кириллицей приходят как есть. */
  async function gitPaths(cwd: string, [cmd, ...args]: string[]): Promise<string[]> {
    return (await git(cwd, [cmd, '-z', ...args])).split('\0').filter(Boolean)
  }

  /**
   * Абсолютный путь к .md внутри root для относительного `relPath` от renderer (не доверенного).
   * Ошибка, если путь абсолютный, не .md, выходит из root (через `..` или симлинк — сравниваются
   * реальные пути), не файл или больше DOC_MAX_BYTES.
   */
  function resolveDocPath(root: string, relPath: unknown): string {
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
  function readDoc(root: string, relPath: unknown): string {
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

  /** Сколько ждать `git ls-files`: локальная операция, таймаут — только против зависшего git. */
  const LIST_TIMEOUT_MS = 30_000

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
    const { stdout } = await processes.run(root, ['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard'], {
      timeoutMs: LIST_TIMEOUT_MS,
      maxBuffer: 512 * 1024 * 1024
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
   * Первые `limit` записей: сначала отслеживаемые, потом неотслеживаемые. `ls-files -t --cached --others` отдаёт
   * неотслеживаемые (`?`) первыми, и при обрезке по порядку git терялись README и исходники, а `.env` и сборочный мусор
   * оставались. Пачками, с уступками event loop, как разбор вывода git.
   */
  async function trackedFirst(paths: Map<string, boolean>, limit: number): Promise<[string, boolean][]> {
    const tracked: [string, boolean][] = []
    const untracked: [string, boolean][] = []
    let i = 0
    for (const entry of paths) {
      if (++i % PARSE_BATCH === 0) await yieldLoop()
      if (!entry[1]) {
        tracked.push(entry)
        if (tracked.length >= limit) break
      } else if (untracked.length < limit) untracked.push(entry)
    }
    return [...tracked, ...untracked].slice(0, limit)
  }

  /**
   * Все файлы проекта (группа `project` в `docs:list`), уважая `.gitignore`; свежие сверху. Больше `limit` — `limit`
   * файлов, отслеживаемые в приоритете (`trackedFirst`), и `truncated`. `limit` параметризуется ради теста.
   */
  async function listProjectFiles(root: string, limit = DOCS_LIST_LIMIT): Promise<ProjectFileList> {
    let paths: Map<string, boolean>
    try {
      paths = await gitWorkingFiles(root)
    } catch (error) {
      preserveCancellation(error)
      paths = await walkFiles(root, limit)
    }
    const truncated = paths.size > limit
    const entries = truncated ? await trackedFirst(paths, limit) : [...paths]
    const infos = await mapLimit(entries, DOCS_STAT_CONCURRENCY, ([rel, untracked]) => projectFileInfo(root, rel, untracked))
    return { files: infos.filter((f): f is DocFile => f !== null).sort(byMtime), truncated }
  }

  /**
   * .md, добавленные или изменённые в worktree задачи относительно базовой ветки: коммиты ветки
   * (`base...HEAD`), незакоммиченные правки и неотслеживаемые файлы. Удалённые не попадают.
   */
  async function listWorktreeDocs(worktree: string, base: string): Promise<DocFile[]> {
    const untracked = new Set(await gitPaths(worktree, ['ls-files', '--others', '--exclude-standard', '--', MD_SPEC]))
    let committed: string[] = []
    try {
      committed = await gitPaths(worktree, ['diff', '--name-only', '--relative', '--diff-filter=d', `${base}...HEAD`, '--', MD_SPEC])
    } catch (error) {
      preserveCancellation(error)
      // базовой ветки нет (переименовали) — показываем только незакоммиченное
    }
    let dirty: string[] = []
    try {
      dirty = await gitPaths(worktree, ['diff', '--name-only', '--relative', '--diff-filter=d', 'HEAD', '--', MD_SPEC])
    } catch (error) {
      preserveCancellation(error)
      // unborn HEAD (в репозитории нет коммитов) — сравнивать не с чем, новые файлы видны как неотслеживаемые
    }
    const all = new Set([...committed, ...dirty, ...untracked])
    return [...all].flatMap((p) => fileInfo(worktree, p, untracked.has(p)) ?? []).sort(byMtime)
  }

  /** Задача с worktree, из которой берутся документы. */

  /**
   * Задачи в работе для «Документов»: у задачи есть worktree на диске и она не в колонке kind=done.
   * После принятия ревью worktree удаляется — документы задачи уже в проекте.
   */
  function docTasks(store: Pick<TaskStore, 'snapshot' | 'columnKind'>): DocTask[] {
    return store
      .snapshot()
      .tasks.filter((t) => t.worktree && store.columnKind(t.status) !== 'done' && existsSync(t.worktree))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({ id: t.id, title: t.title, worktree: t.worktree!, branch: t.branch }))
  }

  /** Одна source без повторного обхода/сортировки всей доски при каждой проверке capture. */
  function docTask(store: Pick<TaskStore, 'getTask' | 'columnKind'>, id: string): DocTask | undefined {
    const task = store.getTask(id)
    if (!task?.worktree || store.columnKind(task.status) === 'done' || !existsSync(task.worktree)) return undefined
    return { id: task.id, title: task.title, worktree: task.worktree, branch: task.branch }
  }

  /**
   * Корень источника `docs:*`: проект или worktree его задачи в работе (`tasks` — из `docTasks`). Задача в done, без
   * worktree, чужая или несуществующая — `docs.noTaskSource`: читать файлы вне проекта по произвольному id нельзя.
   */
  function docSourceRoot(source: unknown, projectRoot: string, tasks: DocTask[]): string {
    if (source === PROJECT_SOURCE) return projectRoot
    const task = tasks.find((t) => t.id === source)
    if (!task) throw new OrcaError('docs.noTaskSource', { id: String(source) })
    return task.worktree
  }

  /**
   * Группы просмотрщика: «Проект» (все файлы, см. listProjectFiles) и по группе на задачу в работе (только с
   * изменёнными .md — «Документы» не превращаются в diff задачи). Ошибка git в worktree одной задачи не ломает
   * список — задача пропускается.
   */
  async function listDocGroups(root: string, base: string, tasks: DocTask[], limit = DOCS_LIST_LIMIT): Promise<DocGroup[]> {
    const project = await listProjectFiles(root, limit)
    const groups: DocGroup[] = [{
      source: PROJECT_SOURCE,
      title: mt('docs.project'),
      files: project.files,
      ...(project.truncated ? { truncated: true } : {})
    }]
    for (const t of tasks) {
      try {
        const files = await listWorktreeDocs(t.worktree, base)
        if (files.length > 0) groups.push({ source: t.id, title: t.title, branch: t.branch, files })
      } catch (error) {
        preserveCancellation(error)
        /* worktree удалён или сломан */
      }
    }
    return groups
  }

  return { resolveDocPath, readDoc, listProjectFiles, listWorktreeDocs, docTasks, docTask, docSourceRoot, listDocGroups }
}
export type DocServices = ReturnType<typeof createDocServices>
