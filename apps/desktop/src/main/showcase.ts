import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { TaskStore } from '@orca-board/core'
import type { ShowcaseFileData } from '../shared/ipc'
import { SHOWCASE_READ_MAX_BYTES, showcaseFileType } from '../shared/showcase'
import { isInside } from './docs'

// Файлы показа человеку (Dispatch.showcase) для renderer: IPC showcase:read / open / reveal. Путь приходит из
// renderer (не доверенного) и от агента (тем более) — проверки как у resolveDocPath, но корень — worktree задачи,
// а вместо «только .md» — белый список SHOWCASE_FILE_TYPES.

/** Worktree задачи, из которого читаются файлы показа. Нет задачи или worktree уже убран (мерж) — ошибка с подсказкой. */
export function showcaseRoot(store: TaskStore, taskId: unknown): string {
  const task = typeof taskId === 'string' ? store.getTask(taskId) : undefined
  if (!task) throw new Error(`показ: задача не найдена: ${String(taskId)}`)
  if (!task.worktree || !existsSync(task.worktree)) {
    throw new Error(`показ: у задачи ${task.id} нет worktree${task.branch ? ` — файлы остались в ветке ${task.branch}` : ''}`)
  }
  return task.worktree
}

/**
 * Абсолютный путь к файлу показа внутри `root`. Ошибка, если путь пустой или абсолютный, расширение не из белого
 * списка, путь выходит из `root` (через `..` или симлинк — сравниваются реальные пути) или это не файл.
 */
export function resolveShowcasePath(root: string, relPath: unknown): string {
  if (typeof relPath !== 'string' || relPath.trim() === '' || relPath.includes('\0')) throw new Error('показ: путь к файлу не задан')
  if (isAbsolute(relPath)) throw new Error(`показ: путь должен быть от корня репозитория задачи: ${relPath}`)
  if (!showcaseFileType(relPath)) throw new Error(`показ: такой тип файла не открывается: ${relPath}`)
  const abs = resolve(root, relPath)
  if (!isInside(resolve(root), abs)) throw new Error(`показ: путь вне worktree задачи: ${relPath}`)
  let real: string
  try {
    real = realpathSync(abs)
  } catch {
    throw new Error(`показ: файл не найден: ${relPath} (агент не закоммитил его или удалил)`)
  }
  if (!isInside(realpathSync(root), real)) throw new Error(`показ: путь вне worktree задачи: ${relPath}`)
  if (!showcaseFileType(real)) throw new Error(`показ: такой тип файла не открывается: ${relPath}`)
  if (!statSync(real).isFile()) throw new Error(`показ: не файл: ${relPath}`)
  return real
}

/**
 * Байты файла для превью в renderer: только картинки и markdown (HTML и PDF — только «Открыть»), не больше
 * SHOWCASE_READ_MAX_BYTES. `Uint8Array`, а не base64: IPC передаёт его структурным клонированием.
 */
export function readShowcaseFile(root: string, relPath: unknown): ShowcaseFileData {
  const real = resolveShowcasePath(root, relPath)
  const type = showcaseFileType(real)!
  if (type.preview === 'open') throw new Error(`показ: ${String(relPath)} не превьюится — откройте его кнопкой «Открыть»`)
  const size = statSync(real).size
  if (size > SHOWCASE_READ_MAX_BYTES) throw new Error(`показ: файл больше ${SHOWCASE_READ_MAX_BYTES / 1024 / 1024} МБ: ${String(relPath)}`)
  return { mime: type.mime, bytes: new Uint8Array(readFileSync(real)) }
}
