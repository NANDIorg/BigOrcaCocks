import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { imageAttachmentFileName, validateImageAttachments, type ImageAttachment, type RequestResolution, type Task, type TaskStore } from '@orca-board/core'
import { OrcaError } from './i18n'
import { ensureRunBranch } from './run-branch'

/**
 * Файлы изображений, приложенных человеком: к цели координатора (`startCoordinator`) и к замечаниям при возврате в
 * работу (`review:reject`, `requests:resolve`, `globalTasks:returnToWork`). Всё лежит в `<cwd читателя>/.orca-attachments`:
 * внутри cwd агент читает файл без запроса разрешения. Модуль без electron и node-pty — тестируется в node.
 */

export const ATTACHMENTS_DIR = '.orca-attachments'

/** Подпапка возвратов внутри папки прогона координатора: старт с новой целью (`clearStartImages`) её не трогает. */
const RETURNS_DIR = 'returns'

/** Живость терминала: `isAlive` из `pty.ts`, параметром — чтобы модуль не тянул node-pty. */
export type PtyAlive = (ptyId: string) => boolean

/**
 * Папка изображений: `<cwd>/.orca-attachments`. Внутри лежит свой `.gitignore` с `*`: папка не попадает в
 * `git status`/`git add -A` (картинки не уйдут в коммит и мерж), не мешает `git worktree remove` без `--force`,
 * а .gitignore репозитория не трогаем.
 */
export function attachmentsRoot(cwd: string): string {
  const root = join(cwd, ATTACHMENTS_DIR)
  try {
    mkdirSync(root, { recursive: true })
    const ignore = join(root, '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
    return root
  } catch (e) {
    throw new OrcaError('attachments.saveFailed', { error: (e as Error).message })
  }
}

/** Удаляет папки изображений закрытых прогонов, чей координатор уже не работает. */
export function pruneAttachments(store: TaskStore, root: string, alive: PtyAlive): void {
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return
  }
  for (const id of dirs) {
    if (id === '.gitignore') continue
    const run = store.getRun(id)
    if (!run?.closedAt || (run.coordinatorPtyId && alive(run.coordinatorPtyId))) continue
    try {
      rmSync(join(root, id), { recursive: true, force: true })
    } catch (e) {
      console.error(`[orca] не удалось удалить вложения прогона ${id}:`, (e as Error).message)
    }
  }
}

/**
 * Пишет файлы `image-N.ext` в `dir` (создаёт) и возвращает абсолютные пути. Не вышло — созданные файлы удаляются,
 * чужое в папке (изображения возвратов рядом) не трогаем. Имя из буфера обмена в путь не попадает.
 */
function writeImageFiles(dir: string, images: readonly ImageAttachment[]): string[] {
  const written: string[] = []
  try {
    mkdirSync(dir, { recursive: true })
    for (const [i, img] of images.entries()) {
      const file = join(dir, imageAttachmentFileName(i, img.ext))
      writeFileSync(file, img.data, { flag: 'wx', mode: 0o600 })
      written.push(file)
    }
    return written
  } catch (e) {
    for (const f of written) rmSync(f, { force: true })
    try {
      rmdirSync(dir)
    } catch {
      /* папка не пуста или её нет — оставляем как есть */
    }
    throw new OrcaError('attachments.saveFailed', { error: (e as Error).message })
  }
}

/** Изображения цели координатора: `<root>/<runId>/image-N.ext`. */
export function writeAttachments(root: string, runId: string, images: readonly ImageAttachment[]): string[] {
  return writeImageFiles(join(root, runId), images)
}

/**
 * Убирает изображения старта прогона (`image-N.ext` в корне его папки) перед записью новых или при неудачном запуске.
 * Возвраты (`returns/`) остаются: на них ссылаются `Run.stageInput.images` и `Run.returns`, они нужны перезапущенному
 * координатору. `whole` — прогон новый и без возвратов: папка целиком.
 */
export function clearStartImages(root: string, runId: string, whole = false): void {
  const dir = join(root, runId)
  if (whole) {
    rmSync(dir, { recursive: true, force: true })
    return
  }
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) if (/^image-\d+\./.test(name)) rmSync(join(dir, name), { force: true })
}

/**
 * Сохраняет изображения одного возврата в новую уникальную папку `<cwd>/.orca-attachments/<ownerId>/[<subdir>/]ret_XXXXXX/`
 * (`mkdtemp`: два возврата подряд не сталкиваются, `image-N` не перезаписываются) и возвращает абсолютные пути.
 * Владелец — задача (папка внутри её worktree; уходит вместе с ним) или прогон (`subdir` — `returns`).
 */
export function saveReturnImages(cwd: string, ownerId: string, subdir: string, images: readonly ImageAttachment[]): string[] {
  const parent = subdir ? join(attachmentsRoot(cwd), ownerId, subdir) : join(attachmentsRoot(cwd), ownerId)
  let dir: string
  try {
    mkdirSync(parent, { recursive: true })
    dir = mkdtempSync(join(parent, 'ret_'))
  } catch (e) {
    throw new OrcaError('attachments.saveFailed', { error: (e as Error).message })
  }
  try {
    return writeImageFiles(dir, images)
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

/** Удаляет папку возврата (`ret_*`), созданную `saveReturnImages`; путь не оттуда — ничего не трогает. */
export function discardReturnImages(paths: readonly string[]): void {
  const dir = paths[0] ? dirname(paths[0]) : undefined
  if (!dir || !basename(dir).startsWith('ret_') || !dir.includes(ATTACHMENTS_DIR)) return
  rmSync(dir, { recursive: true, force: true })
}

/** На эти файлы уже ссылается состояние (замечания задачи, возврат/этап прогона, решение запроса): удалять их нельзя. */
export function imagesReferenced(store: TaskStore, paths: readonly string[]): boolean {
  if (paths.length === 0) return false
  const first = paths[0]
  const has = (list: readonly string[] | undefined): boolean => list?.includes(first) ?? false
  if (store.listTasks().some((t) => has(t.feedbackImages))) return true
  if (store.listRuns().some((r) => has(r.stageInput?.images) || (r.returns ?? []).some((x) => has(x.images)))) return true
  return store.listRequests().some((r) => has(r.resolution?.images))
}

// ---------- куда класть и как вызывать ----------

/** Где читатель картинок видит файлы: его cwd и владелец папки. */
export interface ReturnImagesPlace {
  cwd: string
  ownerId: string
  subdir: string
}

/**
 * Воркер читает картинки в своём worktree. Нет worktree на диске (задачу приняли, worktree убрали) — ошибка до
 * записи в store: текст замечания остаётся в форме.
 */
export function workerImagesPlace(task: Pick<Task, 'id' | 'worktree'> | undefined): ReturnImagesPlace {
  if (!task?.worktree || !existsSync(task.worktree)) throw new OrcaError('attachments.noWorktree')
  return { cwd: task.worktree, ownerId: task.id, subdir: '' }
}

/**
 * Координатор читает картинки в своём cwd: worktree ветки глобальной задачи, а без неё — корень репозитория
 * (то же считает `startCoordinator`). `ensureRunBranch` идемпотентен: убранный worktree восстанавливает.
 */
export function coordinatorImagesPlace(store: TaskStore, repoRoot: string, runId: string): ReturnImagesPlace {
  const cwd = ensureRunBranch(store, repoRoot, runId)?.worktree ?? repoRoot
  return { cwd, ownerId: runId, subdir: RETURNS_DIR }
}

/**
 * Возврат в работу с картинками из IPC: проверка (`validateImageAttachments`), запись в cwd читателя и вызов `apply` с
 * абсолютными путями (`apply` меняет store). Картинок нет — `apply([])`, файлы не создаются. Упал `apply`, и store не
 * успел сослаться на файлы (`imagesReferenced`), — папка этого возврата удаляется, текст остаётся в форме.
 * Картинки без текста замечаний не принимаются: текст — то, к чему они приложены, и он обязателен.
 */
export function withReturnImages<T>(
  store: TaskStore,
  place: () => ReturnImagesPlace,
  input: unknown,
  text: string | undefined,
  apply: (paths: string[]) => T
): T {
  let images: ImageAttachment[]
  try {
    images = validateImageAttachments(input)
  } catch (e) {
    throw new OrcaError('attachments.invalid', { error: (e as Error).message })
  }
  if (images.length === 0) return apply([])
  if (!text?.trim()) throw new OrcaError('attachments.needText')
  const at = place()
  const paths = saveReturnImages(at.cwd, at.ownerId, at.subdir, images)
  try {
    return apply(paths)
  } catch (e) {
    if (!imagesReferenced(store, paths)) discardReturnImages(paths)
    throw e
  }
}

/** Чужие пути в решении: renderer и сокет присылают `resolution.images`, но пути ставит только main после записи файлов. */
export function stripResolutionImages<T extends { images?: string[] }>(resolution: T): T {
  const rest = { ...resolution }
  delete rest.images
  return rest
}

/** Renderer прислал вложения: не `undefined`/`null` и не пустой массив. Мусор вместо массива тоже «прислал» — его отвергнет валидация. */
export function hasImageInput(images: unknown): boolean {
  return images !== undefined && images !== null && !(Array.isArray(images) && images.length === 0)
}

/**
 * «Уточнить» / «Вернуть» запроса к человеку с картинками (IPC `requests:resolve`). Пути в `resolution.images` из IPC и сокета
 * вырезаются всегда — их ставит только main после записи файлов. Читатель: «Уточнить» и «Вернуть» по запросу на задаче —
 * воркер (её worktree), «Вернуть» по approval прогона (без задачи) — координатор. Картинки к другим действиям — ошибка.
 * Запроса нет или он уже решён — обычная ошибка `run`: до записи файлов на диск.
 */
export function resolveWithImages<T>(
  store: TaskStore,
  repoRoot: string,
  id: string,
  resolution: RequestResolution,
  images: unknown,
  run: (resolution: RequestResolution) => T
): T {
  const clean = stripResolutionImages(resolution)
  const request = store.getRequest(id)
  if (!hasImageInput(images) || request?.status !== 'pending') return run(clean)
  if (clean.action !== 'clarify' && clean.action !== 'reject') throw new OrcaError('attachments.notForAction')
  const place = (): ReturnImagesPlace => (request.taskId !== undefined ? workerImagesPlace(store.getTask(request.taskId)) : coordinatorImagesPlace(store, repoRoot, request.runId))
  return withReturnImages(store, place, images, clean.text, (paths) => run(paths.length > 0 ? { ...clean, images: paths } : clean))
}

/**
 * «Вернуть» задачи из ревью с картинками (IPC `review:reject`). Проверка ветки глобальной задачи — замечания читает координатор
 * (cwd прогона), остальные задачи — воркер в своём worktree. `run` получает пути сохранённых файлов (пусто — без картинок).
 */
export function rejectWithImages<T>(
  store: TaskStore,
  repoRoot: string,
  taskId: string,
  images: unknown,
  text: string,
  run: (paths: string[]) => T
): T {
  const task = store.getTask(taskId)
  const runId = task?.gateFor?.runId
  const place = (): ReturnImagesPlace => (runId !== undefined ? coordinatorImagesPlace(store, repoRoot, runId) : workerImagesPlace(task))
  return withReturnImages(store, place, images, text, run)
}

/** «Вернуть в работу» глобальной задачи с картинками (IPC `globalTasks:returnToWork`): читает координатор в cwd прогона. */
export function returnRunWithImages<T>(
  store: TaskStore,
  repoRoot: string,
  runId: string,
  images: unknown,
  text: string,
  run: (paths: string[]) => T
): T {
  return withReturnImages(store, () => coordinatorImagesPlace(store, repoRoot, runId), images, text, run)
}
