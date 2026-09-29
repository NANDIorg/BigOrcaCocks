import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { TaskStore } from '@orca-board/core'
import type { ShowcaseFileData, ShowcasePreviewUrl } from '../shared/ipc'
import { SHOWCASE_READ_MAX_BYTES, showcaseFileType } from '../shared/showcase'
import { isInside } from './docs'
import { OrcaError } from './i18n'
import { previewBase, previewSegments, previewUrlFor, type PreviewTokens } from './preview-protocol'

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
 * Корень, из которого читаются файлы показа запуска `dispatchId` задачи `taskId` (IPC showcase:read/open/reveal).
 * Шов для снимка: TODO(T1) — со `showcase.snapshot` корнем станет снимок в userData, без него — worktree задачи
 * с фоллбэком на worktree ветки прогона. Пока — как раньше: worktree задачи; `dispatchId` только сверяется, чтобы
 * renderer не прочитал показ чужой задачи под видом своей.
 */
export function showcaseSource(store: TaskStore, taskId: unknown, dispatchId?: unknown): string {
  if (dispatchId !== undefined && dispatchId !== null) {
    const dispatch = typeof dispatchId === 'string' ? store.getDispatch(dispatchId) : undefined
    if (!dispatch || dispatch.taskId !== taskId) throw new OrcaError('showcase.dispatchNotFound', { id: String(dispatchId) })
  }
  return showcaseRoot(store, taskId)
}

/**
 * Адрес файла показа для изолированного фрейма (IPC showcase:previewUrl): токен протокола `orca-preview://` на корень
 * показа запуска `dispatchId` (`showcaseSource`: снимок, а без него — worktree задачи) и путь внутри него. Отдаются
 * точки входа, которые превьюятся (HTML, картинки, SVG, markdown — ради `base` для его относительных картинок); PDF —
 * пока только «Открыть». `opts.network` — отдельный токен с открытой сетью в CSP; по умолчанию сеть закрыта.
 */
export function showcasePreviewUrl(store: TaskStore, tokens: PreviewTokens, dispatchId: unknown, path: unknown, opts?: unknown): ShowcasePreviewUrl {
  const dispatch = typeof dispatchId === 'string' ? store.getDispatch(dispatchId) : undefined
  if (!dispatch) throw new OrcaError('showcase.dispatchNotFound', { id: String(dispatchId) })
  const root = showcaseSource(store, dispatch.taskId, dispatch.id)
  const real = resolveShowcasePath(root, path)
  const type = showcaseFileType(real)!
  if (type.preview === 'open') throw new OrcaError('showcase.noPreview', { path: String(path) })
  // Сегменты — от корня по исходному пути (не realpath): так же страница просит соседние ассеты.
  const segments = previewSegments(relative(resolve(root), resolve(root, String(path))).split(sep).join('/'))
  if (!segments) throw new OrcaError('showcase.hidden', { path: String(path) })
  const network = typeof opts === 'object' && opts !== null && (opts as { network?: unknown }).network === true
  const token = tokens.issue(root, network)
  return { url: previewUrlFor(token, segments), mime: type.mime, base: previewBase(token) }
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
