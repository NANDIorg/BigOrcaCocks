import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { PROJECT_FILES_DIR_LIMIT, type ProjectFileEntry, type ProjectFileKind, type ProjectFilesListing } from '../shared/ipc'
import { isInside } from './docs'
import { gitCheckIgnore } from './git'
import { OrcaError } from './i18n'

/**
 * Вкладка «Файлы»: чтение одной папки корня проекта (docs/architecture.md → «IPC», `files:*`). Только имена и типы
 * записей — содержимое не читается, поэтому точечные файлы (`.env`, `.github`) показываются. Кэша и watcher'а нет:
 * каждое раскрытие — свежий `readdir`, обновляет человек.
 */

/** Шум ОС: не отдаётся никогда, в том числе вне git-репозитория. Сравнение без учёта регистра. */
export const PROJECT_FILES_OS_NOISE = ['.ds_store', 'thumbs.db', 'desktop.ini']
/** Скрыт, когда фильтра git нет (не репозиторий, «dubious ownership», git не найден): иначе дерево тонет в зависимостях. */
export const PROJECT_FILES_FALLBACK_HIDDEN = ['node_modules']
/**
 * Сколько записей одной папки уходит в `git check-ignore`. Без предела стоимость фильтра непредсказуема (неигнорируемый
 * `node_modules` на сотню тысяч записей); сверх него — `truncated`.
 */
export const PROJECT_FILES_IGNORE_INPUT_LIMIT = 20_000

/**
 * `.git` — папка репозитория или файл-указатель worktree/подмодуля. Регистр не важен: macOS и Windows регистронезависимы,
 * `.GIT` открыл бы тот же каталог. Windows ещё и молча отрезает точки и пробелы в конце имени (`.git.` — это `.git`).
 */
function isGitName(name: string, win32: boolean): boolean {
  const n = win32 ? name.replace(/[. ]+$/, '') : name
  return n.toLowerCase() === '.git'
}

/**
 * Сегменты относительного пути из renderer (не доверенного). Принимаем только `/`: `\` в сегменте (на Windows
 * `a\..\..\x`) и `:` на win32 (`C:x` — путь от текущей папки диска, `file:stream` — альтернативный поток NTFS) обошли бы
 * проверку `..`. `''` — корень. `p` — `path` платформы: тесты подставляют `path.win32`.
 */
export function splitSafeSegments(rel: unknown, p: path.PlatformPath = path): string[] {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new OrcaError('files.badPath', { path: String(rel) })
  if (rel === '') return []
  const win32 = p.sep === '\\'
  if (p.isAbsolute(rel) || rel.includes('\\') || (win32 && rel.includes(':'))) throw new OrcaError('files.badPath', { path: rel })
  const segments = rel.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw new OrcaError('files.badPath', { path: rel })
  if (segments.some((s) => isGitName(s, win32))) throw new OrcaError('files.hidden', { path: rel })
  return segments
}

const WIN32 = process.platform === 'win32'

async function realRoot(root: string): Promise<string> {
  try {
    return await realpath(root)
  } catch {
    throw new OrcaError('files.rootMissing', { path: root })
  }
}

/** Код ошибки fs без абсолютного пути в тексте: наружу не отдаём, где лежит проект у человека. */
function fsCode(e: unknown): string {
  const err = e as NodeJS.ErrnoException
  return err.code ?? (err.message || String(e))
}

function readFailed(rel: string, e: unknown): OrcaError {
  return new OrcaError('files.readFailed', { path: rel || '/', error: fsCode(e) })
}

/** Реальный путь внутри корня: снаружи — `files.outside`, внутри `.git` (симлинк на него) — `files.hidden`. */
function assertInside(root: string, real: string, rel: string): void {
  if (!isInside(root, real)) throw new OrcaError('files.outside', { path: rel })
  const inner = path.relative(root, real)
  if (inner && inner.split(path.sep).some((s) => isGitName(s, WIN32))) throw new OrcaError('files.hidden', { path: rel })
}

/**
 * Абсолютный путь записи `rel` внутри корня проекта. `followLast` — разворачивать ли последний сегмент: `list` читает
 * папку, на которую указывает симлинк (только если она внутри корня), `reveal` показывает сам симлинк. Промежуточные
 * симлинки разворачиваются всегда и тоже не должны уводить за корень.
 */
export async function resolveProjectPath(root: string, rel: unknown, followLast: boolean): Promise<string> {
  const segments = splitSafeSegments(rel)
  const relText = segments.join('/')
  const base = await realRoot(root)
  if (segments.length === 0) return base
  const parentSegments = followLast ? segments : segments.slice(0, -1)
  let real: string
  try {
    real = await realpath(path.join(base, ...parentSegments))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new OrcaError('files.notFound', { path: relText })
    throw readFailed(relText, e)
  }
  assertInside(base, real, relText)
  if (followLast) return real
  const abs = path.join(real, segments[segments.length - 1])
  try {
    await lstat(abs)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new OrcaError('files.notFound', { path: relText })
    throw readFailed(relText, e)
  }
  return abs
}

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

/** Папки сверху, затем файлы и симлинки; по имени как в «Документах» (`byName`, `docTree.ts`), при равенстве — побайтово. */
function compareEntries(a: ProjectFileEntry, b: ProjectFileEntry): number {
  const ad = a.kind === 'dir' ? 0 : 1
  const bd = b.kind === 'dir' ? 0 : 1
  if (ad !== bd) return ad - bd
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/**
 * Одна папка корня проекта для `files:list`. Симлинки не разворачиваются (`kind: 'symlink'`): нет циклов и выхода за
 * корень, на Windows так же ведут себя junction. Сокеты, FIFO и устройства пропускаются. Сортирует main, иначе
 * обрезка по `PROJECT_FILES_DIR_LIMIT` была бы случайной.
 */
export async function listProjectDir(root: string, dir: unknown = ''): Promise<ProjectFilesListing> {
  const abs = await resolveProjectPath(root, dir ?? '', true)
  const relText = splitSafeSegments(dir ?? '').join('/')
  let dirents
  try {
    dirents = await readdir(abs, { withFileTypes: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOTDIR') throw new OrcaError('files.notDir', { path: relText })
    if (code === 'ENOENT') throw new OrcaError('files.notFound', { path: relText })
    throw readFailed(relText, e)
  }
  const entries: ProjectFileEntry[] = []
  for (const d of dirents) {
    if (isGitName(d.name, WIN32) || PROJECT_FILES_OS_NOISE.includes(d.name.toLowerCase())) continue
    const kind: ProjectFileKind | null = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : d.isFile() ? 'file' : null
    if (kind) entries.push({ name: d.name, kind })
  }
  entries.sort(compareEntries)
  let truncated = entries.length > PROJECT_FILES_IGNORE_INPUT_LIMIT
  const candidates = entries.slice(0, PROJECT_FILES_IGNORE_INPUT_LIMIT)
  // cwd — сама папка, а не корень: git находит свой репозиторий, в том числе подмодуль, и пути не идут «сквозь» симлинк.
  const keyOf = (e: ProjectFileEntry): string => (e.kind === 'dir' ? `${e.name}/` : e.name)
  let visible: ProjectFileEntry[]
  try {
    const ignored = await gitCheckIgnore(abs, candidates.map(keyOf))
    visible = candidates.filter((e) => !ignored.has(keyOf(e)))
  } catch {
    visible = candidates.filter((e) => !PROJECT_FILES_FALLBACK_HIDDEN.includes(e.name.toLowerCase()))
  }
  if (visible.length > PROJECT_FILES_DIR_LIMIT) truncated = true
  return { dir: relText, entries: visible.slice(0, PROJECT_FILES_DIR_LIMIT), truncated }
}
