import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Dispatch, TaskStore } from '@orca-board/core'
import type { ShowcaseFileData, ShowcasePreviewUrl } from '@orca-board/contracts'
import { SHOWCASE_READ_MAX_BYTES, showcaseFileType } from '@orca-board/contracts'
import { isInside } from './path-safety.ts'
import type { FileMessages } from './file-messages.ts'
import type { PreviewTokens, PreviewServices } from './preview.ts'
import { showcaseSnapshotDir, type ShowcaseSnapshots } from './showcase-snapshot.ts'

export function createShowcaseServices(deps: { messages: FileMessages; preview: PreviewServices }) {
  const OrcaError = deps.messages.Error
  const { previewBase, previewSegments, previewUrlFor } = deps.preview

  // Файлы показа человеку (Dispatch.showcase) для renderer: IPC showcase:read / open / reveal. Путь приходит из
  // renderer (не доверенного) и от агента (тем более) — проверки как у resolveDocPath, но корень — снимок запуска
  // или worktree задачи (showcaseSource), а вместо «только .md» — белый список SHOWCASE_FILE_TYPES.

  /**
   * Worktree с файлами показа задачи: её собственный, а после мержа (свой убран) — worktree ветки глобальной задачи,
   * куда её слили, пока тот жив. Ничего нет — ошибка с подсказкой, где файлы: в ветке прогона или в ветке, куда
   * слита задача (своя ветка `orca/<id>` после мержа удалена — её имя не подсказываем).
   */
  function showcaseRoot(store: TaskStore, taskId: unknown): string {
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
  function showcaseSource(store: TaskStore, taskId: unknown, dispatchId?: unknown, snapshots?: ShowcaseSnapshots): string {
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
  function snapshotRoot(store: TaskStore, snapshots: ShowcaseSnapshots, dispatch: Dispatch): string | undefined {
    if (!dispatch.showcase?.snapshot) return undefined
    const runId = store.getTask(dispatch.taskId)?.runId
    const dir = showcaseSnapshotDir(snapshots.root, snapshots.projectId, runId, dispatch.id)
    return existsSync(dir) ? dir : undefined
  }

  function mustDispatch(store: TaskStore, dispatchId: unknown): Dispatch {
    const dispatch = typeof dispatchId === 'string' ? store.getDispatch(dispatchId) : undefined
    if (!dispatch) throw new OrcaError('showcase.dispatchNotFound', { id: String(dispatchId) })
    return dispatch
  }

  /**
   * Адрес файла показа для изолированного фрейма (IPC showcase:previewUrl): токен протокола `orca-preview://` на корень
   * показа запуска `dispatchId` (`showcaseSource`: снимок, а без него — worktree задачи) и путь внутри него. Отдаются
   * точки входа, которые превьюятся (HTML, картинки, SVG, markdown — ради `base` для его относительных картинок); PDF —
   * пока только «Открыть». `opts.network` — отдельный токен с открытой сетью в CSP; по умолчанию сеть закрыта.
   *
   * Сеть — только со снимком: без него токен выдан на весь worktree, и страница с сетью могла бы прочитать `fetch`'ем
   * файлы репозитория и отправить их наружу. Показ без снимка (старый запуск, сбой снимка) с `network` — отказ
   * `showcase.networkNoSnapshot`.
   */
  function showcasePreviewUrl(
    store: TaskStore, tokens: PreviewTokens, dispatchId: unknown, path: unknown, opts?: unknown, snapshots?: ShowcaseSnapshots
  ): ShowcasePreviewUrl {
    const dispatch = mustDispatch(store, dispatchId)
    const snapshot = snapshots ? snapshotRoot(store, snapshots, dispatch) : undefined
    const root = snapshot ?? showcaseRoot(store, dispatch.taskId)
    const network = typeof opts === 'object' && opts !== null && (opts as { network?: unknown }).network === true
    if (network && !snapshot) throw new OrcaError('showcase.networkNoSnapshot')
    const real = resolveShowcasePath(root, path)
    const type = showcaseFileType(real)!
    if (type.preview === 'open') throw new OrcaError('showcase.noPreview', { path: String(path) })
    // Сегменты — от корня по исходному пути (не realpath): так же страница просит соседние ассеты.
    const segments = previewSegments(relative(resolve(root), resolve(root, String(path))).split(sep).join('/'))
    if (!segments) throw new OrcaError('showcase.hidden', { path: String(path) })
    const token = tokens.issue(root, network)
    return { url: previewUrlFor(token, segments), mime: type.mime, base: previewBase(token) }
  }

  /**
   * База `orca-preview://<токен>/` для относительных картинок описания показа запуска `dispatchId` (IPC
   * showcase:previewBase, `DispatchShowcase.text`): пути в описании — от корня репозитория, а картинки из него
   * снимаются при `done` в корень снимка. Токен — на корень показа (`showcaseSource`: снимок, без него — worktree),
   * всегда без сети. Ни снимка, ни worktree — null: картинкам описания взяться неоткуда. Запуска нет — ошибка.
   */
  function showcasePreviewBase(store: TaskStore, tokens: PreviewTokens, dispatchId: unknown, snapshots?: ShowcaseSnapshots): string | null {
    const dispatch = mustDispatch(store, dispatchId)
    let root = snapshots ? snapshotRoot(store, snapshots, dispatch) : undefined
    if (!root) {
      try {
        root = showcaseRoot(store, dispatch.taskId)
      } catch {
        return null
      }
    }
    return previewBase(tokens.issue(root, false))
  }

  /**
   * Абсолютный путь к файлу показа внутри `root`. Ошибка, если путь пустой или абсолютный, расширение не из белого
   * списка, путь выходит из `root` (через `..` или симлинк — сравниваются реальные пути) или это не файл.
   */
  function resolveShowcasePath(root: string, relPath: unknown): string {
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
  function readShowcaseFile(root: string, relPath: unknown): ShowcaseFileData {
    const real = resolveShowcasePath(root, relPath)
    const type = showcaseFileType(real)!
    // HTML — только через протокол показа (previewUrl): байты страницы renderer не получает.
    if (type.preview !== 'image' && type.preview !== 'markdown') throw new OrcaError('showcase.noPreview', { path: String(relPath) })
    const size = statSync(real).size
    if (size > SHOWCASE_READ_MAX_BYTES) throw new OrcaError('showcase.tooBig', { mb: SHOWCASE_READ_MAX_BYTES / 1024 / 1024, path: String(relPath) })
    return { mime: type.mime, bytes: new Uint8Array(readFileSync(real)) }
  }

  return { showcaseRoot, showcaseSource, snapshotRoot, resolveShowcasePath, readShowcaseFile, showcasePreviewUrl, showcasePreviewBase }
}
export type ShowcaseServices = ReturnType<typeof createShowcaseServices>
