/**
 * Картинки глобальной задачи на диске (контракт — docs/nested-kanban.md → «Картинки задачи»).
 *
 * Файлы лежат рядом с данными проекта: `<userData>/run-images/<projectId>/<runId>/<imageId>.<ext>` — не в worktree и
 * не в репозитории пользователя, чтобы не попасть в `git status`. Метаданные (`RunImage`) — в store (`Run.images`),
 * байты в store и снапшот не попадают. Имя файла строится только из `RunImage.id` (его генерирует main) и `ext`
 * из белого списка типов: то, что прислал renderer, в путь не попадает. Читать можно только картинку, чьи метаданные
 * есть у задачи, поэтому `imageId` из IPC не даёт выйти из папки задачи.
 *
 * Функции принимают корень явно (без electron), чтобы тестироваться в временной папке.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  IMAGE_ATTACHMENT_TYPES, assertImageBudget, newId,
  type GlobalTask, type ImageAttachment, type Run, type RunImage, type TaskStore
} from '@orca-board/core'
import { OrcaError } from './i18n'

const ROOT_DIR = 'run-images'
/** Идентификаторы проекта, прогона и картинки в путях — только такие символы (см. `newId`). */
const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** Корень хранилища картинок: `<userData>/run-images`. */
export function runImagesRoot(userData: string): string {
  return join(userData, ROOT_DIR)
}

function safe(id: string, what: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`${what}: недопустимый идентификатор «${id}»`)
  return id
}

/** Папка картинок задачи: `<root>/<projectId>/<runId>`. */
export function runImagesDir(root: string, projectId: string, runId: string): string {
  return join(root, safe(projectId, 'проект'), safe(runId, 'задача'))
}

/** Путь файла картинки; расширение — только из белого списка типов, иначе метаданные повреждены. */
export function runImageFile(dir: string, meta: RunImage): string {
  const known = (Object.values(IMAGE_ATTACHMENT_TYPES) as string[]).includes(meta.ext)
  if (!known) throw new Error(`изображение ${meta.id}: недопустимое расширение «${meta.ext}»`)
  return join(dir, `${safe(meta.id, 'изображение')}.${meta.ext}`)
}

/** Проверенные вложения → метаданные (id генерирует main) и байты для записи. Порядок сохраняется. */
export function prepareRunImages(valid: readonly ImageAttachment[], now = Date.now()): Array<{ meta: RunImage; data: Uint8Array }> {
  return valid.map((v) => ({ meta: { id: newId('img'), mime: v.mime, ext: v.ext, bytes: v.data.byteLength, addedAt: now }, data: v.data }))
}

/** Пишет файлы картинок (`wx` — существующий файл не перезаписывается). При сбое сам ничего не откатывает. */
export function writeRunImages(dir: string, prepared: ReadonlyArray<{ meta: RunImage; data: Uint8Array }>): void {
  mkdirSync(dir, { recursive: true })
  for (const { meta, data } of prepared) writeFileSync(runImageFile(dir, meta), data, { flag: 'wx', mode: 0o600 })
}

/** Удаляет файл картинки; нет файла — не ошибка. */
export function removeRunImageFile(dir: string, meta: RunImage): void {
  rmSync(runImageFile(dir, meta), { force: true })
}

/**
 * Удаляет все файлы задачи (`runId`) или всего проекта (без `runId`) — при удалении глобальной задачи и проекта.
 * Ошибку файловой системы не бросает: задача уже удалена, остаток на диске не должен ломать удаление.
 */
export function removeRunImagesDir(root: string, projectId: string, runId?: string): void {
  try {
    const dir = runId === undefined ? join(root, safe(projectId, 'проект')) : runImagesDir(root, projectId, runId)
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.error(`[orca] не удалось удалить изображения ${runId ?? projectId}:`, (e as Error).message)
  }
}

/**
 * Читает картинки для запуска координатора. Файл, которого нет на диске (удалили руками), пропускается и
 * возвращается в `missing`: ошибка запуска оставила бы задачу без координатора навсегда, ведь картинки после
 * начала работы не правятся.
 */
export function readRunImages(dir: string, metas: readonly RunImage[]): { images: ImageAttachment[]; missing: RunImage[] } {
  const images: ImageAttachment[] = []
  const missing: RunImage[] = []
  for (const meta of [...metas].sort((a, b) => a.addedAt - b.addedAt)) {
    const file = runImageFile(dir, meta)
    if (!existsSync(file)) {
      missing.push(meta)
      continue
    }
    images.push({ mime: meta.mime, ext: meta.ext, data: new Uint8Array(readFileSync(file)) })
  }
  return { images, missing }
}

/**
 * Картинки для запуска координатора: сохранённые у задачи (`Run.images`) первыми, затем вставленные при запуске
 * (`pasted`, уже проверенные `validateImageAttachments`). Сумма — в тех же лимитах `IMAGE_ATTACHMENT_LIMITS`:
 * превышение — ошибка (`assertImageBudget`, контекст `launch`) до старта агента, а не молчаливая потеря чьих-то
 * картинок. Пропавшие с диска файлы — в `missing` (см. `readRunImages`).
 */
export function coordinatorImages(
  root: string, projectId: string, run: Run, pasted: readonly ImageAttachment[]
): { images: ImageAttachment[]; missing: RunImage[] } {
  const saved = run.images && run.images.length > 0 ? readRunImages(runImagesDir(root, projectId, run.id), run.images) : { images: [], missing: [] }
  assertImageBudget(saved.images, pasted, 'launch')
  return { images: [...saved.images, ...pasted], missing: saved.missing }
}

/** Метаданные картинки задачи по данным из IPC (не доверенным): нет задачи или картинки — `OrcaError`. */
function findImage(store: TaskStore, runId: unknown, imageId: unknown): RunImage {
  const run = typeof runId === 'string' ? store.getRun(runId) : undefined
  if (!run) throw new OrcaError('global.notFound', { id: String(runId) })
  const meta = typeof imageId === 'string' ? run.images?.find((i) => i.id === imageId) : undefined
  if (!meta) throw new OrcaError('global.imageNotFound', { imageId: String(imageId) })
  return meta
}

/** Создаёт задачу с картинками. Сбой записи файлов — задача не остаётся (метаданные без файлов не оставляем). */
export function createTaskWithImages(
  store: TaskStore, root: string, projectId: string,
  input: Parameters<TaskStore['createGlobalTask']>[0], valid: readonly ImageAttachment[]
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
    throw new OrcaError('global.imagesSaveFailed', { reason: (e as Error).message })
  }
  return task
}

/**
 * Добавляет картинки к задаче: store проверяет правило «до начала работы» и суммарные лимиты (ничего не
 * меняя при отказе), затем пишутся файлы; сбой записи откатывает метаданные и уже записанные файлы.
 */
export function addTaskImages(
  store: TaskStore, root: string, projectId: string, runId: string, valid: readonly ImageAttachment[]
): GlobalTask {
  if (valid.length === 0) throw new OrcaError('global.imagesEmpty')
  if (!store.getRun(runId)) throw new OrcaError('global.notFound', { id: String(runId) })
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
    throw new OrcaError('global.imagesSaveFailed', { reason: (e as Error).message })
  }
  return task
}

/** Удаляет картинку: метаданные (с проверкой правила и существования) и файл. */
export function removeTaskImage(store: TaskStore, root: string, projectId: string, runId: string, imageId: string): GlobalTask {
  const meta = findImage(store, runId, imageId)
  const task = store.removeRunImage(runId, meta.id)
  try {
    removeRunImageFile(runImagesDir(root, projectId, runId), meta)
  } catch (e) {
    console.error(`[orca] не удалось удалить файл изображения ${meta.id}:`, (e as Error).message)
  }
  return task
}

/** Байты картинки для превью. Только картинка из метаданных задачи; нет задачи, картинки или файла — `OrcaError`. */
export function loadTaskImage(store: TaskStore, root: string, projectId: string, runId: string, imageId: string): { mime: string; data: Uint8Array } {
  const meta = findImage(store, runId, imageId)
  const file = runImageFile(runImagesDir(root, projectId, runId), meta)
  if (!existsSync(file)) throw new OrcaError('global.imageFileMissing', { imageId: meta.id })
  return { mime: meta.mime, data: new Uint8Array(readFileSync(file)) }
}
