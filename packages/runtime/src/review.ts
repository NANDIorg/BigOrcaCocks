import type { TaskStore, HumanRequest, RequestResolution, Task } from '@orca-board/core'
import { existsSync } from 'node:fs'
import { MergeError, type ReviewInfo } from './git.ts'
import type { MergeTarget } from './run-branch.ts'
import type { ExecutionResources } from './execution-resources.ts'
import type { WorkflowMessages } from './workflow-messages.ts'

export type MergeTargetOf = (task: Task) => MergeTarget
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
  const { reviewInfo, commitWorktree, currentBranch, hasCommits, localBranchExists, mergeBranch, removeWorktree } = resources.git
  const { reviewBase } = resources

  function getReview(store: TaskStore, repoRoot: string, taskId: string): ReviewInfo {
    const task = store.getTask(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    if (!task.worktree || !task.branch) throw messages.error('review.noBranch')
    return reviewInfo(repoRoot, task.worktree, task.branch, reviewBase(store, repoRoot, task))
  }

  /**
   * Цель мержа задачи (`mergeTarget` в `run-branch.ts`: ветка глобальной задачи с защитой общих веток). Нет —
   * текущая ветка корня без проверок: так вызывают тесты и код, которому настройки проекта не нужны.
   */

  function rootTarget(repoRoot: string): MergeTarget {
    return { cwd: repoRoot, branch: currentBranch(repoRoot) }
  }

  /**
   * Ветка, в которую сливаем, должна существовать до коммита хвостов и удаления worktree. Иначе (корень без коммитов,
   * база пропала) `reviewInfo` молча отдаёт `commits=[]`, мерж пропускается, и `removeWorktree` удалил бы ветку задачи
   * с коммитами воркера — тихая потеря работы. `HEAD` — корень в detached HEAD: сливаем в него, если есть коммит.
   */
  function assertMergeTarget(repoRoot: string, target: MergeTarget): void {
    if (target.branch === 'HEAD' ? hasCommits(repoRoot) : localBranchExists(repoRoot, target.branch)) return
    if (!hasCommits(repoRoot)) throw messages.error('git.noCommits', { branch: target.branch })
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
  function mergeTaskBranch(
    repoRoot: string,
    task: Pick<Task, 'title' | 'worktree' | 'branch' | 'branchForeign'>,
    target: MergeTarget = rootTarget(repoRoot)
  ): MergeResult {
    if (!task.worktree || !task.branch) return { ok: true }
    assertMergeTarget(repoRoot, target)
    if (existsSync(task.worktree)) commitWorktree(task.worktree, `orca: ${task.title}`)
    if (localBranchExists(repoRoot, task.branch)) {
      const info = reviewInfo(repoRoot, task.worktree, task.branch, target.branch)
      if (info.commits.length > 0) {
        try {
          mergeBranch(target.cwd, task.branch, `Merge orca task: ${task.title}`)
        } catch (e) {
          if (e instanceof MergeError && e.conflict) return { ok: false, conflict: true, error: e.message }
          throw e
        }
      }
    }
    // Ветку, которую создала не orca (нода git → checkout), не удаляем: снимается только worktree.
    removeWorktree(repoRoot, task.worktree, task.branch, task.branchForeign === true)
    return { ok: true }
  }

  /**
   * Принять вне воркфлоу: задача-ответ или задача без этапа (создана до воркфлоу). Рабочую задачу — слить
   * (`mergeTaskBranch`), конфликт — ошибка, задача остаётся где была. Задача-ответ незакоммиченное не
   * коммитит (это черновики воркера), но коммиты в её ветке (например, макеты по заданию) сливает так же,
   * как у рабочей задачи, — иначе они пропали бы с веткой.
   * `decision` — решение человека по ответу, уходит координатору в answer_accepted.
   * Задачу на этапе воркфлоу принимает `reviewAccept` (`src/main/workflow.ts`).
   */
  function acceptReview(store: TaskStore, repoRoot: string, taskId: string, decision?: string, targetOf?: MergeTargetOf): void {
    const task = store.getTask(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    // Устаревший ответ (последний запуск его не сдал) не принимаем — до git-части, ветку не трогаем.
    store.assertAnswerAcceptable(taskId)
    // Цель — до git-части: пропавшая ветка фичи (`git.runBranchMissing`) останавливает приёмку, ничего не тронув.
    const target = task.worktree && task.branch ? (targetOf?.(task) ?? rootTarget(repoRoot)) : undefined
    if (task.answerFor && task.worktree && task.branch && target) {
      assertMergeTarget(repoRoot, target)
      const info = reviewInfo(repoRoot, task.worktree, task.branch, target.branch)
      if (info.commits.length > 0) mergeBranch(target.cwd, task.branch, `Merge orca answer: ${task.title}`)
      removeWorktree(repoRoot, task.worktree, task.branch)
    } else {
      const merged = mergeTaskBranch(repoRoot, task, target)
      if (!merged.ok) throw new Error(merged.error)
    }
    // Ответ для человека: store шлёт координатору answer_accepted.
    store.acceptTask(taskId, decision)
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
  function resolveHumanRequest(
    store: TaskStore,
    repoRoot: string,
    id: string,
    resolution: RequestResolution,
    startWorker: (taskId: string) => { ptyId: string; dispatchId: string },
    approved?: (request: HumanRequest) => void,
    targetOf?: MergeTargetOf
  ): ResolveOutcome {
    const pending = store.getRequest(id)
    if (!pending) throw new Error(`request not found: ${id}`)
    if (pending.status !== 'pending') throw messages.error(pending.status === 'cancelled' ? 'request.alreadyCancelled' : 'request.alreadyResolved', { id })
    if (resolution.action === 'accept' && pending.kind === 'answer' && pending.taskId !== undefined) {
      acceptReview(store, repoRoot, pending.taskId, resolution.text, targetOf)
      return { request: store.getRequest(id)! }
    }
    const request = store.resolveRequest(id, resolution)
    if (request.kind === 'approval' || request.kind === 'decision') {
      approved?.(request)
      return { request: store.getRequest(id)! }
    }
    // Запрос без задачи (approval прогона) воркера не перезапускает: clarify и restart к нему не относятся.
    const taskId = request.taskId
    if ((resolution.action !== 'clarify' && resolution.action !== 'restart') || taskId === undefined) return { request }
    try {
      const w = startWorker(taskId)
      return { request, worker: { ptyId: w.ptyId, dispatchId: w.dispatchId } }
    } catch (e) {
      // В журнал задачи (его читает координатор) — по-русски, человеку в UI — на языке интерфейса.
      const startError = messages.displayError(e)
      const reason = e instanceof Error ? e.message : String(e)
      const what = resolution.action === 'clarify' ? 'уточнение принято' : 'перезапуск'
      store.escalate(taskId, `${what}, но воркер не запустился: ${reason}`, { requestId: request.id, startFailed: true })
      return { request, startError }
    }
  }

  return { getReview, mergeTaskBranch, acceptReview, resolveHumanRequest }
}

export type ReviewServices = ReturnType<typeof createReviewServices>
