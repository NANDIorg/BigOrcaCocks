import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Dispatch, TaskStore } from '@orca-board/core'
import type { ShowcaseFileData, ShowcasePreviewUrl } from '../shared/ipc'
import { SHOWCASE_READ_MAX_BYTES, showcaseFileType } from '../shared/showcase'
import { isInside } from './docs'
import { OrcaError } from './i18n'
import { showcaseSnapshotDir, type ShowcaseSnapshots } from './showcase-snapshot'

// Файлы показа человеку (Dispatch.showcase) для renderer: IPC showcase:read / open / reveal. Путь приходит из
// renderer (не доверенного) и от агента (тем более) — проверки как у resolveDocPath, но корень — снимок запуска
// или worktree задачи (showcaseSource), а вместо «только .md» — белый список SHOWCASE_FILE_TYPES.

/**
 * Worktree с файлами показа задачи: её собственный, а после мержа (свой убран) — worktree ветки глобальной задачи,
 * куда её слили, пока тот жив. Ничего нет — ошибка с подсказкой, где файлы: в ветке прогона или в ветке, куда
 * слита задача (своя ветка `orca/<id>` после мержа удалена — её имя не подсказываем).
 */
export function showcaseRoot(store: TaskStore, taskId: unknown): string {
  const task = typeof taskId === 'string' ? store.getTask(taskId) : undefined
  if (!task) throw new OrcaError('showcase.taskNotFound', { id: String(taskId) })
  if (task.worktree && existsSync(task.worktree)) return task.worktree
  const git = task.runId ? store.getRun(task.runId)?.git : undefined
  if (git?.worktree && existsSync(git.worktree)) return git.worktree
  throw git
    ? new OrcaError('showcase.noWorktreeBranch', { id: task.id, branch: git.branch })
    : new OrcaError('showcase.noWorktree', { id: task.id })
}

/**
 * Корень, из которого читаются файлы показа запуска `dispatchId` задачи `taskId` (IPC showcase:read/open/reveal):
 * снимок запуска в userData, если он снят при `done` и лежит на диске, иначе `showcaseRoot` (worktree задачи →
 * worktree прогона → ошибка) — так читаются показы, сданные до снимков. Без `dispatchId` (старый renderer) — снимок
 * последнего запуска задачи. `dispatchId` чужой задачи — ошибка: renderer не прочитает чужой показ под видом своего.
 */
export function showcaseSource(store: TaskStore, taskId: unknown, dispatchId?: unknown, snapshots?: ShowcaseSnapshots): string {
  let dispatch: Dispatch | undefined
  if (dispatchId !== undefined && dispatchId !== null) {
    dispatch = typeof dispatchId === 'string' ? store.getDispatch(dispatchId) : undefined
    if (!dispatch || dispatch.taskId !== taskId) throw new OrcaError('showcase.dispatchNotFound', { id: String(dispatchId) })
  } else {
    const task = typeof taskId === 'string' ? store.getTask(taskId) : undefined
    dispatch = task?.dispatchId ? store.getDispatch(task.dispatchId) : undefined
  }
  const snapshot = snapshots && dispatch ? snapshotRoot(store, snapshots, dispatch) : undefined
  return snapshot ?? showcaseRoot(store, taskId)
}

/** Папка снимка запуска, если он снят и не удалён с диска; иначе undefined. */
export function snapshotRoot(store: TaskStore, snapshots: ShowcaseSnapshots, dispatch: Dispatch): string | undefined {
  if (!dispatch.showcase?.snapshot) return undefined
  const runId = store.getTask(dispatch.taskId)?.runId
  const dir = showcaseSnapshotDir(snapshots.root, snapshots.projectId, runId, dispatch.id)
  return existsSync(dir) ? dir : undefined
}

/**
 * Адрес страницы показа для изолированного фрейма (IPC showcase:previewUrl). TODO(T2): выдать токен протокола
 * `orca-preview://` на корень снимка запуска (T1) и вернуть `{url, mime, base}`; `opts.network` — отдельный токен
 * с открытой сетью. Пока протокола нет — честный отказ: renderer показывает «Открыть» как раньше.
 */
export function showcasePreviewUrl(store: TaskStore, dispatchId: unknown, path: unknown, _opts?: unknown): ShowcasePreviewUrl {
  const dispatch = typeof dispatchId === 'string' ? store.getDispatch(dispatchId) : undefined
  if (!dispatch) throw new OrcaError('showcase.dispatchNotFound', { id: String(dispatchId) })
  throw new OrcaError('showcase.noPreview', { path: String(path) })
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
 * Байты файла для превью в renderer: только картинки и markdown (HTML — по протоколу показа, PDF — «Открыть»), не больше
 * SHOWCASE_READ_MAX_BYTES. `Uint8Array`, а не base64: IPC передаёт его структурным клонированием.
 */
export function readShowcaseFile(root: string, relPath: unknown): ShowcaseFileData {
  const real = resolveShowcasePath(root, relPath)
  const type = showcaseFileType(real)!
  // HTML — только через протокол показа (previewUrl): байты страницы renderer не получает.
  if (type.preview !== 'image' && type.preview !== 'markdown') throw new OrcaError('showcase.noPreview', { path: String(relPath) })
  const size = statSync(real).size
  if (size > SHOWCASE_READ_MAX_BYTES) throw new OrcaError('showcase.tooBig', { mb: SHOWCASE_READ_MAX_BYTES / 1024 / 1024, path: String(relPath) })
  return { mime: type.mime, bytes: new Uint8Array(readFileSync(real)) }
}
