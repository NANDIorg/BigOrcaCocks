import { statusSource, type TaskStore, type HumanRequest, type RequestResolution, type Task } from '@orca-board/core'
import { existsSync } from 'node:fs'
import { MergeError, type ReviewInfo } from './git.ts'
import type { MergeTarget } from './run-branch.ts'
import type { ExecutionResources } from './execution-resources.ts'
import type { WorkflowMessages } from './workflow-messages.ts'
import type { EffectScope } from './effect-scope.ts'
import type { GitWorkflowRepository } from './git-workflow.ts'
import { executionProject, obsoleteEffect, type ExecutionContext } from './execution-context.ts'

export type MergeTargetOf = (task: Task) => MergeTarget | Promise<MergeTarget>
export type MergeResult = { ok: true } | { ok: false; conflict: true; error: string }
export interface ResolveOutcome {
  request: HumanRequest
  worker?: { ptyId: string; dispatchId: string }
  /** Запрос решён, но воркер не стартовал; UI получает текст хоста, журнал — исходную причину. */
  startError?: string
}

export interface ReviewServiceDeps {
  resources: ExecutionResources
  messages: WorkflowMessages
}

/** Приёмка и решения человека без состояния окна или Electron. */
export function createReviewServices({ resources, messages }: ReviewServiceDeps) {
  const { workflowGit } = resources.git
  function capture(store: TaskStore, root: string, taskId: string | undefined, context: ExecutionContext = {}) {
    return resources.effects.capture(executionProject(store, root, context), taskId === undefined ? {} : { taskId }, { source: context.source ?? statusSource() })
  }
  async function getReview(store: TaskStore, repoRoot: string, taskId: string, context?: ExecutionContext): Promise<ReviewInfo> {
    const task = store.getTask(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    if (!task.worktree || !task.branch) throw messages.error('review.noBranch')
    const scope = capture(store, repoRoot, taskId, context)
    try {
      const base = await scope.wait(() => resources.reviewBase(store, repoRoot, task, context))
      return await scope.read(workflowGit, repo => repo.reviewInfo(task.worktree!, task.branch!, base))
    } finally { scope.close() }
  }

  /**
   * Цель мержа задачи (`mergeTarget` в `run-branch.ts`: ветка глобальной задачи с защитой общих веток). Нет —
   * текущая ветка корня без проверок: так вызывают тесты и код, которому настройки проекта не нужны.
   */

  async function rootTarget(repoRoot: string, repo: GitWorkflowRepository): Promise<MergeTarget> {
    return { cwd: repoRoot, branch: await repo.currentBranch() }
  }
  async function assertMergeTarget(repo: GitWorkflowRepository, target: MergeTarget): Promise<void> {
    if (target.branch === 'HEAD' ? await repo.hasCommits() : await repo.localBranchExists(target.branch)) return
    if (!await repo.hasCommits()) throw messages.error('git.noCommits', { branch: target.branch })
    throw messages.error('git.mergeTargetMissing', { branch: target.branch })
  }

  /** Итог мержа ветки задачи: `conflict` — git не слил ветку (текст ошибки в `error`), ветка и worktree на месте. */

  /**
   * Git-часть приёмки рабочей задачи: закоммитить хвосты worktree, слить ветку в цель — ветку глобальной задачи или
   * текущую ветку корня (если в ней есть коммиты), убрать worktree и ветку. Store не трогает — задачу в done переводит вызывающий
   * (приёмка вне воркфлоу — `acceptReview`, нода `merge` — исполнитель воркфлоу, `src/main/workflow.ts`).
   * Не слилось из-за конфликта — `conflict`, ничего не удалено: конфликт разрешают в ветке и сливают снова.
   * Остальные ошибки git (занятый `index.lock`, незакоммиченное в цели, таймаут, падение коммита или удаления worktree) —
   * исключение с причиной: это не конфликт, этап встаёт (`Task.stageBlock`), «Принять» повторяет мерж.
   * Повтор после сбоя идемпотентен: папки worktree уже нет — коммитить нечего; ветки нет или она уже слита — сливать нечего,
   * остаётся уборка.
   */
  async function mergeTaskIn(repo: GitWorkflowRepository, repoRoot: string,
    task: Pick<Task, 'title' | 'worktree' | 'branch' | 'branchForeign'>, target?: MergeTarget): Promise<MergeResult> {
    if (!task.worktree || !task.branch) return { ok: true }
    const into = target ?? await rootTarget(repoRoot, repo)
    await assertMergeTarget(repo, into)
    if (existsSync(task.worktree)) await repo.commitWorktree(task.worktree, `orca: ${task.title}`)
    if (await repo.localBranchExists(task.branch)) {
      const info = await repo.reviewInfo(task.worktree, task.branch, into.branch)
      if (info.commits.length > 0) {
        try { await repo.mergeBranch(into.cwd, task.branch, `Merge orca task: ${task.title}`) }
        catch (error) { if (error instanceof MergeError && error.conflict) return { ok: false, conflict: true, error: error.message }; throw error }
      }
    }
    await repo.removeWorktree(task.worktree, task.branch, task.branchForeign === true)
    return { ok: true }
  }
  async function mergeTaskBranch(repoRoot: string, task: Pick<Task, 'title' | 'worktree' | 'branch' | 'branchForeign'>,
    target?: MergeTarget, scope?: EffectScope): Promise<MergeResult> {
    if (!task.worktree || !task.branch) return { ok: true }
    const operation = (repo: GitWorkflowRepository) => mergeTaskIn(repo, repoRoot, task, target)
    return scope ? scope.transaction(workflowGit, operation) : workflowGit.transaction(repoRoot, operation)
  }

  /**
   * Принять вне воркфлоу: задача-ответ или задача без этапа (создана до воркфлоу). Рабочую задачу — слить
   * (`mergeTaskBranch`), конфликт — ошибка, задача остаётся где была. Задача-ответ незакоммиченное не
   * коммитит (это черновики воркера), но коммиты в её ветке (например, макеты по заданию) сливает так же,
   * как у рабочей задачи, — иначе они пропали бы с веткой.
   * `decision` — решение человека по ответу, уходит координатору в answer_accepted.
   * Задачу на этапе воркфлоу принимает `reviewAccept` (`src/main/workflow.ts`).
   */
  async function acceptReview(store: TaskStore, repoRoot: string, taskId: string, decision?: string, targetOf?: MergeTargetOf, context?: ExecutionContext): Promise<void> {
    const task = store.getTask(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    store.assertAnswerAcceptable(taskId)
    const scope = capture(store, repoRoot, taskId, context)
    try {
      const target = task.worktree && task.branch && targetOf ? await scope.wait(() => Promise.resolve(targetOf(task))) : undefined
      if (task.worktree && task.branch) await scope.transaction(workflowGit, async repo => {
        if (task.answerFor && task.worktree && task.branch) {
          const into = target ?? await rootTarget(repoRoot, repo)
          await assertMergeTarget(repo, into)
          const info = await repo.reviewInfo(task.worktree, task.branch, into.branch)
          if (info.commits.length > 0) await repo.mergeBranch(into.cwd, task.branch, `Merge orca answer: ${task.title}`)
          await repo.removeWorktree(task.worktree, task.branch)
        } else {
          const merged = await mergeTaskIn(repo, repoRoot, task, target)
          if (!merged.ok) throw new Error(merged.error)
        }
      })
      scope.commit(() => store.acceptTask(taskId, decision))
    } finally { scope.close() }
  }

  /** Итог решения запроса: для «Уточнить»/«Перезапустить» — запущенный воркер или причина, почему не запустился. */

  /**
   * Решение человека по запросу (IPC requests:resolve и `orca-board request resolve`) — одним вызовом main:
   * - answer + accept — приёмка с git-частью (acceptReview), решение `text` уходит в answer_accepted;
   * - answer + clarify, escalation + restart — resolveRequest и сразу старт воркера. Упал старт — запрос
   *   всё равно решён (задача в ready с уточнением), координатору — escalation с причиной;
   * - approval + accept / reject — resolveRequest, затем переход воркфлоу по этому исходу (`approved`:
   *   мерж, запуск воркера — исполнитель в `src/main/workflow.ts`);
   * - decision + answer (`optionId` — ветка развилки) — resolveRequest, затем тот же колбэк `approved`: граф прогона идёт
   *   по выбранной ветке (`handleRunRequest` в `src/main/workflow-run.ts`);
   * - остальное — resolveRequest.
   */
  async function resolveHumanRequest(
    store: TaskStore,
    repoRoot: string,
    id: string,
    resolution: RequestResolution,
    startWorker: (taskId: string) => { ptyId: string; dispatchId: string } | Promise<{ ptyId: string; dispatchId: string }>,
    approved?: (request: HumanRequest) => unknown | Promise<unknown>,
    targetOf?: MergeTargetOf,
    context?: ExecutionContext
  ): Promise<ResolveOutcome> {
    const pending = store.getRequest(id)
    if (!pending) throw new Error(`request not found: ${id}`)
    if (pending.status !== 'pending') throw messages.error(pending.status === 'cancelled' ? 'request.alreadyCancelled' : 'request.alreadyResolved', { id })
    if (resolution.action === 'accept' && pending.kind === 'answer' && pending.taskId !== undefined) {
      await acceptReview(store, repoRoot, pending.taskId, resolution.text, targetOf, context)
      return { request: store.getRequest(id)! }
    }
    const source = context?.source ?? statusSource()
    const scope = capture(store, repoRoot, pending.taskId, { ...context, source })
    const request = (() => { try { return scope.commit(() => store.resolveRequest(id, resolution)) } finally { scope.close() } })()
    if (request.kind === 'approval' || request.kind === 'decision') {
      await approved?.(request)
      return { request: store.getRequest(id)! }
    }
    // Запрос без задачи (approval прогона) воркера не перезапускает: clarify и restart к нему не относятся.
    const taskId = request.taskId
    if ((resolution.action !== 'clarify' && resolution.action !== 'restart') || taskId === undefined) return { request }
    const launch = resources.effects.capture(executionProject(store, repoRoot, context), { taskId, taskResources: false }, { source })
    try {
      const w = await startWorker(taskId)
      return { request, worker: { ptyId: w.ptyId, dispatchId: w.dispatchId } }
    } catch (e) {
      if (obsoleteEffect(e)) throw e
      launch.guard()
      // В журнал задачи (его читает координатор) — по-русски, человеку в UI — на языке интерфейса.
      const startError = messages.displayError(e)
      const reason = e instanceof Error ? e.message : String(e)
      const what = resolution.action === 'clarify' ? 'уточнение принято' : 'перезапуск'
      launch.commit(() => store.escalate(taskId, `${what}, но воркер не запустился: ${reason}`, { requestId: request.id, startFailed: true }))
      return { request, startError }
    } finally { launch.close() }
  }

  return { getReview, mergeTaskBranch, acceptReview, resolveHumanRequest }
}

export type ReviewServices = ReturnType<typeof createReviewServices>
