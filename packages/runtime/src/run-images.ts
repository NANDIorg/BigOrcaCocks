/**
 * Вложения глобальной задачи на диске — картинки и любые файлы (контракт — docs/nested-kanban.md → «Картинки задачи»;
 * имена `image*` исторические).
 *
 * Файлы лежат рядом с данными проекта: `<userData>/run-images/<projectId>/<runId>/<imageId>[.<ext>]` — не в worktree и
 * не в репозитории пользователя, чтобы не попасть в `git status`. Метаданные (`RunImage`) — в store (`Run.images`),
 * байты в store и снапшот не попадают. Имя файла строится только из `RunImage.id` (его генерирует main) и `ext`
 * (у картинки — из белого списка типов, у файла — `[a-z0-9]{0,10}`): исходное имя файла хранится только в метаданных
 * (`RunImage.name`) и в путь не попадает. Читать и показывать в папке можно только вложение, чьи метаданные есть
 * у задачи, поэтому `imageId` из IPC не даёт выйти из папки задачи.
 *
 * Функции принимают корень явно (без electron), чтобы тестироваться в временной папке.
 */
import { constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, fstatSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import {
  IMAGE_ATTACHMENT_TYPES, ATTACHMENT_LIMITS, assertAttachmentBudget, newId,
  type Attachment, type GlobalTask, type Run, type RunImage, type TaskStore
} from '@orca-board/core'
import { attachmentOpenable } from '@orca-board/contracts'
import { runImagesRoot, runImagesDir, removeRunImagesDir, safeArtifactId as safe } from './artifact-paths.ts'
import type { ExecutionMessages, ExecutionLogger } from './execution-messages.ts'

/** Экземпляр общих ресурсов без глобального состояния Desktop. */
export function createRunImageServices({ messages, logger }: { messages: ExecutionMessages; logger: ExecutionLogger }) {

  /** Нет `kind` — картинка: так записаны вложения до появления файлов. */
  function isImage(meta: Pick<RunImage, 'kind'>): boolean {
    return (meta.kind ?? 'image') === 'image'
  }

  /** Расширение файла-вложения: как у `sanitizeAttachmentName` (может быть пустым); точек и разделителей нет. */
  const FILE_EXT = /^[a-z0-9]{0,10}$/

  /**
   * Путь файла вложения: `<id>.<ext>`, у файла без расширения — `<id>`. Расширение картинки — только из белого списка
   * типов, файла — `[a-z0-9]{0,10}`; иное (и неизвестный `kind`) — метаданные повреждены.
   */
  function runImageFile(dir: string, meta: RunImage): string {
    const id = safe(meta.id, 'вложение')
    const ext = typeof meta.ext === 'string' ? meta.ext : ''
    const known = isImage(meta)
      ? (Object.values(IMAGE_ATTACHMENT_TYPES) as string[]).includes(ext)
      : meta.kind === 'file' && FILE_EXT.test(ext)
    if (!known) throw new Error(`вложение ${meta.id}: недопустимое расширение «${ext}»`)
    return join(dir, ext ? `${id}.${ext}` : id)
  }

  /** Проверенные вложения → метаданные (id генерирует main; `kind` и имя — для UI) и байты для записи. Порядок сохраняется. */
  function prepareRunImages(valid: readonly Attachment[], now = Date.now()): Array<{ meta: RunImage; data: Uint8Array }> {
    return valid.map((v) => ({
      meta: {
        id: newId('img'), kind: v.kind, ...(v.name ? { name: v.name } : {}),
        mime: v.mime, ext: v.ext, bytes: v.data.byteLength, addedAt: now
      },
      data: v.data
    }))
  }

  /** Пишет файлы вложений (`wx` — существующий файл не перезаписывается). При сбое сам ничего не откатывает. */
  function writeRunImages(dir: string, prepared: ReadonlyArray<{ meta: RunImage; data: Uint8Array }>): void {
    mkdirSync(dir, { recursive: true })
    for (const { meta, data } of prepared) writeFileSync(runImageFile(dir, meta), data, { flag: 'wx', mode: 0o600 })
  }

  /** Удаляет файл вложения; нет файла — не ошибка. */
  function removeRunImageFile(dir: string, meta: RunImage): void {
    rmSync(runImageFile(dir, meta), { force: true })
  }

  /**
   * Читает вложения для запуска координатора. `kind` и `name` переносятся: по ним файл получит в папке координатора
   * имя `file-N-<slug>.ext`, а не `image-N`. Файл, которого нет на диске (удалили руками), пропускается и
   * возвращается в `missing`: ошибка запуска оставила бы задачу без координатора навсегда, ведь вложения после
   * начала работы не правятся.
   */
  function readRunImages(dir: string, metas: readonly RunImage[]): { images: Attachment[]; missing: RunImage[] } {
    const images: Attachment[] = []
    const missing: RunImage[] = []
    for (const meta of [...metas].sort((a, b) => a.addedAt - b.addedAt)) {
      const file = runImageFile(dir, meta)
      if (!existsSync(file)) {
        missing.push(meta)
        continue
      }
      images.push({ kind: isImage(meta) ? 'image' : 'file', mime: meta.mime, ext: meta.ext, name: meta.name ?? '', data: new Uint8Array(readFileSync(file)) })
    }
    return { images, missing }
  }

  /**
   * Вложения для запуска координатора: сохранённые у задачи (`Run.images`) первыми, затем приложенные при запуске
   * (`pasted`, уже проверенные `validateAttachments`). Сумма — в тех же лимитах `ATTACHMENT_LIMITS`:
   * превышение — ошибка (`assertAttachmentBudget`, контекст `launch`) до старта агента, а не молчаливая потеря чьих-то
   * файлов. Пропавшие с диска файлы — в `missing` (см. `readRunImages`).
   */
  function coordinatorImages(
    root: string, projectId: string, run: Run, pasted: readonly Attachment[]
  ): { images: Attachment[]; missing: RunImage[] } {
    const saved = run.images && run.images.length > 0 ? readRunImages(runImagesDir(root, projectId, run.id), run.images) : { images: [], missing: [] }
    assertAttachmentBudget(saved.images, pasted, 'launch')
    return { images: [...saved.images, ...pasted], missing: saved.missing }
  }

  /** Метаданные вложения задачи по данным из IPC (не доверенным): нет задачи или вложения — `OrcaError`. */
  function findImage(store: TaskStore, runId: unknown, imageId: unknown): RunImage {
    const run = typeof runId === 'string' ? store.getRun(runId) : undefined
    if (!run) throw messages.error('global.notFound', { id: String(runId) })
    const meta = typeof imageId === 'string' ? run.images?.find((i) => i.id === imageId) : undefined
    if (!meta) throw messages.error('global.imageNotFound', { imageId: String(imageId) })
    return meta
  }

  /** Создаёт задачу с вложениями. Сбой записи файлов — задача не остаётся (метаданные без файлов не оставляем). */
  function createTaskWithImages(
    store: TaskStore, root: string, projectId: string,
    input: Parameters<TaskStore['createGlobalTask']>[0], valid: readonly Attachment[]
  ): GlobalTask {
    const prepared = prepareRunImages(valid)
    const task = store.createGlobalTask({ ...input, ...(prepared.length > 0 ? { images: prepared.map((p) => p.meta) } : {}) })
    if (prepared.length === 0) return task
    const dir = runImagesDir(root, projectId, task.id)
    try {
      writeRunImages(dir, prepared)
    } catch (e) {
      store.deleteGlobalTask(task.id)
      rmSync(dir, { recursive: true, force: true })
      throw messages.error('global.imagesSaveFailed', { reason: (e as Error).message })
    }
    return task
  }

  /**
   * Добавляет вложения к задаче: store проверяет правило «до начала работы» и суммарные лимиты (ничего не
   * меняя при отказе), затем пишутся файлы; сбой записи откатывает метаданные и уже записанные файлы.
   */
  function addTaskImages(
    store: TaskStore, root: string, projectId: string, runId: string, valid: readonly Attachment[]
  ): GlobalTask {
    if (valid.length === 0) throw messages.error('global.imagesEmpty')
    if (!store.getRun(runId)) throw messages.error('global.notFound', { id: String(runId) })
    const prepared = prepareRunImages(valid)
    const task = store.addRunImages(runId, prepared.map((p) => p.meta))
    const dir = runImagesDir(root, projectId, runId)
    try {
      writeRunImages(dir, prepared)
    } catch (e) {
      for (const { meta } of prepared) {
        try {
          store.removeRunImage(runId, meta.id)
        } catch {
          // задача уже не редактируется или метаданных нет — откатывать нечего
        }
        try {
          removeRunImageFile(dir, meta)
        } catch {
          // файла нет или недоступен — остаток не критичен
        }
      }
      throw messages.error('global.imagesSaveFailed', { reason: (e as Error).message })
    }
    return task
  }

  /** Удаляет вложение: метаданные (с проверкой правила и существования) и файл. */
  function removeTaskImage(store: TaskStore, root: string, projectId: string, runId: string, imageId: string): GlobalTask {
    const meta = findImage(store, runId, imageId)
    const task = store.removeRunImage(runId, meta.id)
    try {
      removeRunImageFile(runImagesDir(root, projectId, runId), meta)
    } catch (e) {
      logger.warn(`[orca] не удалось удалить файл вложения ${meta.id}:`, (e as Error).message)
    }
    return task
  }

  /** Файл вложения из метаданных задачи, который есть на диске; нет задачи, вложения или файла — `OrcaError`. */
  function existingFile(store: TaskStore, root: string, projectId: string, runId: string, imageId: string): { meta: RunImage; file: string } {
    const meta = findImage(store, runId, imageId)
    const file = runImageFile(runImagesDir(root, projectId, runId), meta)
    if (!existsSync(file)) throw messages.error('global.imageFileMissing', { imageId: meta.id })
    return { meta, file }
  }

  /**
   * Байты картинки для превью (`<img>` из blob). Только картинка из метаданных задачи: файл (`kind: 'file'`) превью
   * не имеет — `global.notAnImage`, его байты в renderer не отдаём. Нет задачи, вложения или файла — `OrcaError`.
   */
  function loadTaskImage(store: TaskStore, root: string, projectId: string, runId: string, imageId: string): { mime: string; data: Uint8Array } {
    const meta = findImage(store, runId, imageId)
    if (!isImage(meta)) throw messages.error('global.notAnImage', { imageId: meta.id })
    const { file } = existingFile(store, root, projectId, runId, imageId)
    return { mime: meta.mime, data: new Uint8Array(readFileSync(file)) }
  }

  /** Скачивание любого вложения по метаданным задачи, без открытия файла на сервере. */
  function loadTaskAttachment(store: TaskStore, root: string, projectId: string, runId: string, imageId: string): { mime: string; data: Uint8Array } {
    const { meta, file } = existingFile(store, root, projectId, runId, imageId)
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size !== meta.bytes || stat.size > ATTACHMENT_LIMITS.maxTotalBytes) throw new Error('Некорректный файл вложения')
      return { mime: meta.mime, data: new Uint8Array(readFileSync(fd)) }
    } finally { closeSync(fd) }
  }

  /**
   * Абсолютный путь вложения для «Показать в папке» (`shell.showItemInFolder`). Только вложение из метаданных этой
   * задачи (`imageId` из IPC путь не задаёт), идентификаторы проверены `safe`. Файл не открывается и не запускается.
   */
  function revealTaskAttachment(store: TaskStore, root: string, projectId: string, runId: string, imageId: string): string {
    return existingFile(store, root, projectId, runId, imageId).file
  }

  /**
   * Абсолютный путь вложения для «Открыть» (`shell.openPath`) — только расширение из белого списка
   * (`attachmentOpenable`: картинки, Markdown, PDF; без HTML и SVG). Остальное приложение не открывает и не запускает —
   * `global.attachmentNotOpenable`, его можно только показать в папке. Как и `revealTaskAttachment`, путь строится из
   * метаданных этой задачи.
   */
  function openTaskAttachment(store: TaskStore, root: string, projectId: string, runId: string, imageId: string): string {
    const meta = findImage(store, runId, imageId)
    if (!attachmentOpenable(meta.ext)) throw messages.error('global.attachmentNotOpenable', { imageId: meta.id })
    return existingFile(store, root, projectId, runId, imageId).file
  }

  return { runImageFile, prepareRunImages, writeRunImages, removeRunImageFile, readRunImages, coordinatorImages, createTaskWithImages, addTaskImages, removeTaskImage, loadTaskImage, loadTaskAttachment, revealTaskAttachment, openTaskAttachment, runImagesRoot, runImagesDir, removeRunImagesDir }
}
