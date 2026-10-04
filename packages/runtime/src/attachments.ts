import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ATTACHMENT_LIMITS, DEFAULT_ATTACHMENT_OBJECTIVE, attachmentFileName, validateAttachments, type Attachment, type RequestResolution, type Task, type TaskStore } from '@orca-board/core'
import type { AttachmentCapabilities } from '@orca-board/contracts'
import type { ExecutionMessages, ExecutionLogger } from './execution-messages.ts'
import { executionProject, type ExecutionContext } from './execution-context.ts'
import type { EffectScope, EffectScopeService, EffectTarget } from './effect-scope.ts'
import type { createRunBranchServices } from './run-branch.ts'

export type PtyAlive = (ptyId: string) => boolean

export interface ReturnImagesPlace {
  cwd: string
  ownerId: string
  subdir: string
}

/** Экземпляр общих ресурсов без глобального состояния Desktop. */
export function createAttachmentServices({ messages, logger, branches, effects }: { messages: ExecutionMessages; logger: ExecutionLogger; branches: Pick<ReturnType<typeof createRunBranchServices>, 'ensureRunBranch'>; effects: EffectScopeService }) {
  const { ensureRunBranch } = branches
  const capture = (store: TaskStore, root: string, target: EffectTarget, context?: ExecutionContext) =>
    () => effects.capture(executionProject(store, root, context), target, { source: context?.source })

  /**
   * Файлы (картинки и любые другие), приложенные человеком: к цели координатора (`startCoordinator`) и к замечаниям при возврате в
   * работу (`review:reject`, `requests:resolve`, `globalTasks:returnToWork`). Всё лежит в `<cwd читателя>/.orca-attachments`:
   * внутри cwd агент читает файл без запроса разрешения. Модуль без electron и node-pty — тестируется в node.
   */

  const ATTACHMENTS_DIR = '.orca-attachments'

  /** Подпапка возвратов внутри папки прогона координатора: старт с новой целью (`clearStartImages`) её не трогает. */
  const RETURNS_DIR = 'returns'

  /**
   * Ответ на `attachments:capabilities`: main принимает любые файлы (`validateAttachments`) в лимитах `ATTACHMENT_LIMITS`.
   * Старый main метода не имеет — renderer тогда остаётся в режиме «только картинки».
   */
  function attachmentCapabilities(): AttachmentCapabilities {
    return { files: true, limits: { ...ATTACHMENT_LIMITS } }
  }

  /**
   * Цель нового координатора (`coordinator:start`): текст человека, а без текста — `DEFAULT_ATTACHMENT_OBJECTIVE`, если
   * приложены вложения (картинки или файлы). Ни текста, ни вложений — `coordinator.noObjective`.
   */
  function coordinatorObjective(objective: unknown, attachments: readonly Attachment[]): string {
    const text = typeof objective === 'string' ? objective.trim() : ''
    if (text) return text
    if (attachments.length === 0) throw messages.error('coordinator.noObjective')
    return DEFAULT_ATTACHMENT_OBJECTIVE
  }

  /** Живость терминала: `isAlive` из `pty.ts`, параметром — чтобы модуль не тянул node-pty. */

  /**
   * Папка вложений: `<cwd>/.orca-attachments`. Внутри лежит свой `.gitignore` с `*`: папка не попадает в
   * `git status`/`git add -A` (файлы не уйдут в коммит и мерж), не мешает `git worktree remove` без `--force`,
   * а .gitignore репозитория не трогаем.
   */
  function attachmentsRoot(cwd: string): string {
    const root = join(cwd, ATTACHMENTS_DIR)
    try {
      mkdirSync(root, { recursive: true })
      const ignore = join(root, '.gitignore')
      if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
      return root
    } catch (e) {
      throw messages.error('attachments.saveFailed', { error: (e as Error).message })
    }
  }

  /** Удаляет папки вложений закрытых прогонов, чей координатор уже не работает. */
  function pruneAttachments(store: TaskStore, root: string, alive: PtyAlive): void {
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
        logger.warn(`[orca] не удалось удалить вложения прогона ${id}:`, (e as Error).message)
      }
    }
  }

  /**
   * Пишет вложения в `dir` (создаёт) и возвращает абсолютные пути: картинки — `image-N.ext`, файлы — `file-N-<slug>[.ext]`
   * (`attachmentFileName`; номер — позиция в списке, так одноимённые файлы не сталкиваются). Не вышло — созданные файлы
   * удаляются, чужое в папке (вложения возвратов рядом) не трогаем. Исходное имя попадает в путь только очищенным слагом.
   */
  function writeAttachmentFiles(dir: string, attachments: readonly Attachment[]): string[] {
    const written: string[] = []
    try {
      mkdirSync(dir, { recursive: true })
      for (const [i, att] of attachments.entries()) {
        const file = join(dir, attachmentFileName(i, att))
        writeFileSync(file, att.data, { flag: 'wx', mode: 0o600 })
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
      throw messages.error('attachments.saveFailed', { error: (e as Error).message })
    }
  }

  /** Вложения цели координатора: `<root>/<runId>/image-N.ext` и `file-N-<slug>.ext`. */
  function writeAttachments(root: string, runId: string, attachments: readonly Attachment[]): string[] {
    return writeAttachmentFiles(join(root, runId), attachments)
  }

  /** Имена вложений старта в корне папки прогона (`attachmentFileName`): `image-N.ext`, `file-N-<slug>[.ext]`. */
  const START_FILE = /^(image|file)-\d+[.-]/

  /**
   * Убирает вложения старта прогона (`image-N.ext` и `file-N-*` в корне его папки) перед записью новых или при неудачном запуске.
   * Возвраты (`returns/`) остаются: на них ссылаются `Run.stageInput.images` и `Run.returns`, они нужны перезапущенному
   * координатору. `whole` — прогон новый и без возвратов: папка целиком.
   */
  function clearStartImages(root: string, runId: string, whole = false): void {
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
    for (const name of names) if (START_FILE.test(name)) rmSync(join(dir, name), { force: true })
  }

  /**
   * Сохраняет вложения одного возврата в новую уникальную папку `<cwd>/.orca-attachments/<ownerId>/[<subdir>/]ret_XXXXXX/`
   * (`mkdtemp`: два возврата подряд не сталкиваются, `image-N`/`file-N-*` не перезаписываются) и возвращает абсолютные пути.
   * Владелец — задача (папка внутри её worktree; уходит вместе с ним) или прогон (`subdir` — `returns`).
   */
  function saveReturnImages(cwd: string, ownerId: string, subdir: string, attachments: readonly Attachment[]): string[] {
    const parent = subdir ? join(attachmentsRoot(cwd), ownerId, subdir) : join(attachmentsRoot(cwd), ownerId)
    let dir: string
    try {
      mkdirSync(parent, { recursive: true })
      dir = mkdtempSync(join(parent, 'ret_'))
    } catch (e) {
      throw messages.error('attachments.saveFailed', { error: (e as Error).message })
    }
    try {
      return writeAttachmentFiles(dir, attachments)
    } catch (e) {
      rmSync(dir, { recursive: true, force: true })
      throw e
    }
  }

  /** Удаляет папку возврата (`ret_*`), созданную `saveReturnImages`; путь не оттуда — ничего не трогает. */
  function discardReturnImages(paths: readonly string[]): void {
    const dir = paths[0] ? dirname(paths[0]) : undefined
    if (!dir || !basename(dir).startsWith('ret_') || !dir.includes(ATTACHMENTS_DIR)) return
    rmSync(dir, { recursive: true, force: true })
  }

  /** На эти файлы уже ссылается состояние (замечания задачи, возврат/этап прогона, решение запроса): удалять их нельзя. */
  function imagesReferenced(store: TaskStore, paths: readonly string[]): boolean {
    if (paths.length === 0) return false
    const first = paths[0]
    const has = (list: readonly string[] | undefined): boolean => list?.includes(first) ?? false
    if (store.listTasks().some((t) => has(t.feedbackImages))) return true
    if (store.listRuns().some((r) => has(r.stageInput?.images) || (r.returns ?? []).some((x) => has(x.images)))) return true
    return store.listRequests().some((r) => has(r.resolution?.images))
  }

  // ---------- куда класть и как вызывать ----------

  /** Где читатель вложений видит файлы: его cwd и владелец папки. */

  /**
   * Воркер читает вложения в своём worktree. Нет worktree на диске (задачу приняли, worktree убрали) — ошибка до
   * записи в store: текст замечания остаётся в форме.
   */
  function workerImagesPlace(task: Pick<Task, 'id' | 'worktree'> | undefined): ReturnImagesPlace {
    if (!task?.worktree || !existsSync(task.worktree)) throw messages.error('attachments.noWorktree')
    return { cwd: task.worktree, ownerId: task.id, subdir: '' }
  }

  /**
   * Координатор читает вложения в своём cwd: worktree ветки глобальной задачи, а без неё — корень репозитория
   * (то же считает `startCoordinator`). `ensureRunBranch` идемпотентен: убранный worktree восстанавливает.
   */
  async function coordinatorImagesPlace(store: TaskStore, repoRoot: string, runId: string, context?: ExecutionContext): Promise<ReturnImagesPlace> {
    const cwd = (await ensureRunBranch(store, repoRoot, runId, context))?.worktree ?? repoRoot
    return { cwd, ownerId: runId, subdir: RETURNS_DIR }
  }

  /**
   * Возврат в работу с вложениями из IPC: проверка (`validateAttachments` — любой тип файла, лимиты `ATTACHMENT_LIMITS`),
   * запись в cwd читателя и вызов `apply` с абсолютными путями (`apply` меняет store). Вложений нет — `apply([])`, файлы
   * не создаются. Упал `apply`, и store не успел сослаться на файлы (`imagesReferenced`), — папка этого возврата удаляется,
   * текст остаётся в форме. Вложения без текста замечаний не принимаются: текст — то, к чему они приложены, и он обязателен.
   */
  async function withReturnImages<T>(
    store: TaskStore,
    place: () => ReturnImagesPlace | Promise<ReturnImagesPlace>,
    input: unknown,
    text: string | undefined,
    apply: (paths: string[]) => T | Promise<T>,
    captureScope?: () => EffectScope
  ): Promise<T> {
    let images: Attachment[]
    try {
      images = validateAttachments(input)
    } catch (e) {
      throw messages.error('attachments.invalid', { error: (e as Error).message })
    }
    if (images.length === 0) return apply([])
    if (!text?.trim()) throw messages.error('attachments.needText')
    const scope = captureScope?.()
    try {
      const at = scope ? await scope.wait(() => Promise.resolve(place())) : await place()
      scope?.guard()
      const paths = saveReturnImages(at.cwd, at.ownerId, at.subdir, images)
      try {
        scope?.guard()
        return await apply(paths)
      } catch (e) {
        if (!imagesReferenced(store, paths)) { scope?.guard(); discardReturnImages(paths) }
        throw e
      }
    } finally { scope?.close() }
  }

  /** Чужие пути в решении: renderer и сокет присылают `resolution.images`, но пути ставит только main после записи файлов. */
  function stripResolutionImages<T extends { images?: string[] }>(resolution: T): T {
    const rest = { ...resolution }
    delete rest.images
    return rest
  }

  /** Renderer прислал вложения: не `undefined`/`null` и не пустой массив. Мусор вместо массива тоже «прислал» — его отвергнет валидация. */
  function hasImageInput(images: unknown): boolean {
    return images !== undefined && images !== null && !(Array.isArray(images) && images.length === 0)
  }

  /**
   * «Уточнить» / «Вернуть» запроса к человеку с вложениями (IPC `requests:resolve`). Пути в `resolution.images` из IPC и сокета
   * вырезаются всегда — их ставит только main после записи файлов. Читатель: «Уточнить» и «Вернуть» по запросу на задаче —
   * воркер (её worktree), «Вернуть» по approval прогона (без задачи) — координатор. Вложения к другим действиям — ошибка.
   * Запроса нет или он уже решён — обычная ошибка `run`: до записи файлов на диск.
   */
  async function resolveWithImages<T>(
    store: TaskStore,
    repoRoot: string,
    id: string,
    resolution: RequestResolution,
    images: unknown,
    run: (resolution: RequestResolution) => T | Promise<T>,
    context?: ExecutionContext
  ): Promise<T> {
    const clean = stripResolutionImages(resolution)
    const request = store.getRequest(id)
    if (!hasImageInput(images) || request?.status !== 'pending') return run(clean)
    if (clean.action !== 'clarify' && clean.action !== 'reject') throw messages.error('attachments.notForAction')
    const place = (): ReturnImagesPlace | Promise<ReturnImagesPlace> => (request.taskId !== undefined ? workerImagesPlace(store.getTask(request.taskId)) : coordinatorImagesPlace(store, repoRoot, request.runId, context))
    return withReturnImages(store, place, images, clean.text, (paths) => run(paths.length > 0 ? { ...clean, images: paths } : clean),
      capture(store, repoRoot, request.taskId !== undefined ? { taskId: request.taskId } : { runId: request.runId }, context))
  }

  /**
   * «Вернуть» задачи из ревью с вложениями (IPC `review:reject`). Проверка ветки глобальной задачи — замечания читает координатор
   * (cwd прогона), остальные задачи — воркер в своём worktree. `run` получает пути сохранённых файлов (пусто — без вложений).
   */
  async function rejectWithImages<T>(
    store: TaskStore,
    repoRoot: string,
    taskId: string,
    images: unknown,
    text: string,
    run: (paths: string[]) => T | Promise<T>,
    context?: ExecutionContext
  ): Promise<T> {
    const task = store.getTask(taskId)
    const runId = task?.gateFor?.runId
    const place = (): ReturnImagesPlace | Promise<ReturnImagesPlace> => (runId !== undefined ? coordinatorImagesPlace(store, repoRoot, runId, context) : workerImagesPlace(task))
    return withReturnImages(store, place, images, text, run, capture(store, repoRoot, { taskId }, context))
  }

  /** «Вернуть в работу» глобальной задачи с вложениями (IPC `globalTasks:returnToWork`): читает координатор в cwd прогона. */
  async function returnRunWithImages<T>(
    store: TaskStore,
    repoRoot: string,
    runId: string,
    images: unknown,
    text: string,
    run: (paths: string[]) => T | Promise<T>,
    context?: ExecutionContext
  ): Promise<T> {
    return withReturnImages(store, () => coordinatorImagesPlace(store, repoRoot, runId, context), images, text, run, capture(store, repoRoot, { runId }, context))
  }

  return { ATTACHMENTS_DIR, attachmentCapabilities, coordinatorObjective, attachmentsRoot, pruneAttachments, writeAttachments, clearStartImages, saveReturnImages, discardReturnImages, imagesReferenced, workerImagesPlace, coordinatorImagesPlace, withReturnImages, stripResolutionImages, hasImageInput, resolveWithImages, rejectWithImages, returnRunWithImages }
}
