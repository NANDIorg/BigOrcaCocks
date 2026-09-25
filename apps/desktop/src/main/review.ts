import type { TaskStore, HumanRequest, RequestResolution, Task } from '@orca-board/core'
import { reviewInfo, commitWorktree, mergeBranch, removeWorktree, type ReviewInfo } from './git'
import { OrcaError, mt } from './i18n'

export function getReview(store: TaskStore, repoRoot: string, taskId: string): ReviewInfo {
  const task = store.getTask(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  if (!task.worktree || !task.branch) throw new OrcaError('review.noBranch')
  return reviewInfo(repoRoot, task.worktree, task.branch)
}

/** Итог мержа ветки задачи: `conflict` — git не слил ветку (текст ошибки в `error`), ветка и worktree на месте. */
export type MergeResult = { ok: true } | { ok: false; conflict: true; error: string }

/**
 * Git-часть приёмки рабочей задачи: закоммитить хвосты worktree, слить ветку в текущую ветку репозитория
 * (если в ней есть коммиты), убрать worktree и ветку. Store не трогает — задачу в done переводит вызывающий
 * (приёмка вне воркфлоу — `acceptReview`, нода `merge` — исполнитель воркфлоу, `src/main/workflow.ts`).
 * Не слилось — `conflict`, ничего не удалено: конфликт разрешают в ветке и сливают снова.
 * Ошибка коммита или удаления worktree — исключение (это не конфликт, повтор мержа не поможет).
 */
export function mergeTaskBranch(repoRoot: string, task: Pick<Task, 'title' | 'worktree' | 'branch' | 'branchForeign'>): MergeResult {
  if (!task.worktree || !task.branch) return { ok: true }
  commitWorktree(task.worktree, `orca: ${task.title}`)
  const info = reviewInfo(repoRoot, task.worktree, task.branch)
  if (info.commits.length > 0) {
    try {
      mergeBranch(repoRoot, task.branch, `Merge orca task: ${task.title}`)
    } catch (e) {
      return { ok: false, conflict: true, error: (e as Error).message }
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
export function acceptReview(store: TaskStore, repoRoot: string, taskId: string, decision?: string): void {
  const task = store.getTask(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  // Устаревший ответ (последний запуск его не сдал) не принимаем — до git-части, ветку не трогаем.
  store.assertAnswerAcceptable(taskId)
  if (task.answerFor && task.worktree && task.branch) {
    const info = reviewInfo(repoRoot, task.worktree, task.branch)
    if (info.commits.length > 0) mergeBranch(repoRoot, task.branch, `Merge orca answer: ${task.title}`)
    removeWorktree(repoRoot, task.worktree, task.branch)
  } else {
    const merged = mergeTaskBranch(repoRoot, task)
    if (!merged.ok) throw new Error(merged.error)
  }
  // Ответ для человека: store шлёт координатору answer_accepted.
  store.acceptTask(taskId, decision)
}

/** Итог решения запроса: для «Уточнить»/«Перезапустить» — запущенный воркер или причина, почему не запустился. */
export interface ResolveOutcome {
  request: HumanRequest
  worker?: { ptyId: string; dispatchId: string }
  /** Запрос решён, но воркер не стартовал: координатору ушла escalation с этой причиной. */
  startError?: string
}

/**
 * Решение человека по запросу (IPC requests:resolve и `orca-board request resolve`) — одним вызовом main:
 * - answer + accept — приёмка с git-частью (acceptReview), решение `text` уходит в answer_accepted;
 * - answer + clarify, escalation + restart — resolveRequest и сразу старт воркера. Упал старт — запрос
 *   всё равно решён (задача в ready с уточнением), координатору — escalation с причиной;
 * - approval + accept / reject — resolveRequest, затем переход воркфлоу по этому исходу (`approved`:
 *   мерж, запуск воркера — исполнитель в `src/main/workflow.ts`);
 * - остальное — resolveRequest.
 */
export function resolveHumanRequest(
  store: TaskStore,
  repoRoot: string,
  id: string,
  resolution: RequestResolution,
  startWorker: (taskId: string) => { ptyId: string; dispatchId: string },
  approved?: (request: HumanRequest) => void
): ResolveOutcome {
  const pending = store.getRequest(id)
  if (!pending) throw new Error(`request not found: ${id}`)
  if (pending.status !== 'pending') throw new OrcaError(pending.status === 'cancelled' ? 'request.alreadyCancelled' : 'request.alreadyResolved', { id })
  if (resolution.action === 'accept' && pending.kind === 'answer') {
    acceptReview(store, repoRoot, pending.taskId, resolution.text)
    return { request: store.getRequest(id)! }
  }
  const request = store.resolveRequest(id, resolution)
  if (request.kind === 'approval') {
    approved?.(request)
    return { request: store.getRequest(id)! }
  }
  if (resolution.action !== 'clarify' && resolution.action !== 'restart') return { request }
  try {
    const w = startWorker(request.taskId)
    return { request, worker: { ptyId: w.ptyId, dispatchId: w.dispatchId } }
  } catch (e) {
    // В журнал задачи (его читает координатор) — по-русски, человеку в UI — на языке интерфейса.
    const startError = e instanceof OrcaError ? mt(e.key, e.params) : (e as Error).message
    const what = resolution.action === 'clarify' ? 'уточнение принято' : 'перезапуск'
    store.escalate(request.taskId, `${what}, но воркер не запустился: ${(e as Error).message}`, { requestId: request.id, startFailed: true })
    return { request, startError }
  }
}
