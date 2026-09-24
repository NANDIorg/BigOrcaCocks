import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { DocFile, DocGroup } from '../shared/ipc'

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
  if (typeof relPath !== 'string' || relPath.trim() === '' || relPath.includes('\0')) throw new Error('путь к документу не задан')
  if (isAbsolute(relPath)) throw new Error(`путь должен быть относительным: ${relPath}`)
  if (!MD.test(relPath)) throw new Error(`не markdown-файл: ${relPath}`)
  const abs = resolve(root, relPath)
  if (!isInside(resolve(root), abs)) throw new Error(`путь вне проекта: ${relPath}`)
  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    throw new Error(`файл не найден: ${relPath}`)
  }
  if (!isInside(realpathSync(root), real)) throw new Error(`путь вне проекта: ${relPath}`)
  if (!MD.test(real)) throw new Error(`не markdown-файл: ${relPath}`)
  const st = statSync(real)
  if (!st.isFile()) throw new Error(`не файл: ${relPath}`)
  if (st.size > DOC_MAX_BYTES) throw new Error(`файл больше ${DOC_MAX_BYTES / 1024 / 1024} МБ: ${relPath}`)
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

const byMtime = (a: DocFile, b: DocFile): number => b.mtime - a.mtime || a.path.localeCompare(b.path)

/**
 * .md проекта: отслеживаемые и новые неотслеживаемые, без игнорируемых git'ом (node_modules, out, …).
 * Свежие сверху.
 */
export function listProjectDocs(root: string): DocFile[] {
  const untracked = new Set(gitPaths(root, ['ls-files', '--others', '--exclude-standard', '--', MD_SPEC]))
  const tracked = gitPaths(root, ['ls-files', '--cached', '--', MD_SPEC])
  const all = new Set([...tracked, ...untracked])
  return [...all].flatMap((p) => fileInfo(root, p, untracked.has(p)) ?? []).sort(byMtime)
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
  const dirty = gitPaths(worktree, ['diff', '--name-only', '--relative', '--diff-filter=d', 'HEAD', '--', MD_SPEC])
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
 * Группы просмотрщика: «Проект» и по группе на задачу в работе (только с изменёнными .md).
 * Ошибка git в worktree одной задачи не ломает список — задача пропускается.
 */
export function listDocGroups(root: string, base: string, tasks: DocTask[]): DocGroup[] {
  const groups: DocGroup[] = [{ source: PROJECT_SOURCE, title: 'Проект', files: listProjectDocs(root) }]
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
