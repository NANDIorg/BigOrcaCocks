import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { TaskStore } from '@orca-board/core'
import type { ShowcaseFileData } from '../shared/ipc'
import { SHOWCASE_READ_MAX_BYTES, showcaseFileType } from '../shared/showcase'
import { isInside } from './docs'
import { OrcaError } from './i18n'

// Файлы показа человеку (Dispatch.showcase) для renderer: IPC showcase:read / open / reveal. Путь приходит из
// renderer (не доверенного) и от агента (тем более) — проверки как у resolveDocPath, но корень — worktree задачи,
// а вместо «только .md» — белый список SHOWCASE_FILE_TYPES.

/** Worktree задачи, из которого читаются файлы показа. Нет задачи или worktree уже убран (мерж) — ошибка с подсказкой. */
export function showcaseRoot(store: TaskStore, taskId: unknown): string {
  const task = typeof taskId === 'string' ? store.getTask(taskId) : undefined
  if (!task) throw new OrcaError('showcase.taskNotFound', { id: String(taskId) })
  if (!task.worktree || !existsSync(task.worktree)) {
    throw task.branch
      ? new OrcaError('showcase.noWorktreeBranch', { id: task.id, branch: task.branch })
      : new OrcaError('showcase.noWorktree', { id: task.id })
  }
  return task.worktree
}

/**
 * Абсолютный путь к файлу показа внутри `root`. Ошибка, если путь пустой или абсолютный, расширение не из белого
 * списка, путь выходит из `root` (через `..` или симлинк — сравниваются реальные пути) или это не файл.
 */
export function resolveShowcasePath(root: string, relPath: unknown): string {
  if (typeof relPath !== 'string' || relPath.trim() === '' || relPath.includes('\0')) throw new OrcaError('showcase.noPath')
  if (isAbsolute(relPath)) throw new OrcaError('showcase.notRelative', { path: relPath })
  if (!showcaseFileType(relPath)) throw new OrcaError('showcase.badType', { path: relPath })
  const abs = resolve(root, relPath)
  if (!isInside(resolve(root), abs)) throw new OrcaError('showcase.outside', { path: relPath })
  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    throw new OrcaError('showcase.notFound', { path: relPath })
  }
  if (!isInside(realpathSync(root), real)) throw new OrcaError('showcase.outside', { path: relPath })
  if (!showcaseFileType(real)) throw new OrcaError('showcase.badType', { path: relPath })
  if (!statSync(real).isFile()) throw new OrcaError('showcase.notFile', { path: relPath })
  return real
}

/**
 * Байты файла для превью в renderer: только картинки и markdown (HTML и PDF — только «Открыть»), не больше
 * SHOWCASE_READ_MAX_BYTES. `Uint8Array`, а не base64: IPC передаёт его структурным клонированием.
 */
export function readShowcaseFile(root: string, relPath: unknown): ShowcaseFileData {
  const real = resolveShowcasePath(root, relPath)
  const type = showcaseFileType(real)!
  if (type.preview === 'open') throw new OrcaError('showcase.noPreview', { path: String(relPath) })
  const size = statSync(real).size
  if (size > SHOWCASE_READ_MAX_BYTES) throw new OrcaError('showcase.tooBig', { mb: SHOWCASE_READ_MAX_BYTES / 1024 / 1024, path: String(relPath) })
  return { mime: type.mime, bytes: new Uint8Array(readFileSync(real)) }
}
