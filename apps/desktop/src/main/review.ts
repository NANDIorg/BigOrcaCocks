import type { TaskStore, HumanRequest, RequestResolution } from '@orca-board/core'
import { reviewInfo, commitWorktree, mergeBranch, removeWorktree, type ReviewInfo } from './git'

export function getReview(store: TaskStore, repoRoot: string, taskId: string): ReviewInfo {
  const task = store.getTask(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  if (!task.worktree || !task.branch) throw new Error('у задачи нет ветки')
  return reviewInfo(repoRoot, task.worktree, task.branch)
}

/**
 * Принять: закоммитить хвосты, слить в текущую ветку, убрать worktree, задача → done.
 * Задача-ответ незакоммиченное не коммитит (это черновики воркера), но коммиты в её ветке
 * (например, макеты по заданию) сливает так же, как у рабочей задачи, — иначе они пропали бы с веткой.
 * `decision` — решение человека по ответу, уходит координатору в answer_accepted.
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
  } else if (task.worktree && task.branch) {
    commitWorktree(task.worktree, `orca: ${task.title}`)
    const info = reviewInfo(repoRoot, task.worktree, task.branch)
    if (info.commits.length > 0) mergeBranch(repoRoot, task.branch, `Merge orca task: ${task.title}`)
    removeWorktree(repoRoot, task.worktree, task.branch)
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
 * - остальное — resolveRequest.
 */
export function resolveHumanRequest(
  store: TaskStore,
  repoRoot: string,
  id: string,
  resolution: RequestResolution,
  startWorker: (taskId: string) => { ptyId: string; dispatchId: string }
): ResolveOutcome {
  const pending = store.getRequest(id)
  if (!pending) throw new Error(`request not found: ${id}`)
  if (pending.status !== 'pending') throw new Error(`уже решено: запрос ${id} ${pending.status === 'cancelled' ? 'отменён' : 'решён'}`)
  if (resolution.action === 'accept' && pending.kind === 'answer') {
    acceptReview(store, repoRoot, pending.taskId, resolution.text)
    return { request: store.getRequest(id)! }
  }
  const request = store.resolveRequest(id, resolution)
  if (resolution.action !== 'clarify' && resolution.action !== 'restart') return { request }
  try {
    const w = startWorker(request.taskId)
    return { request, worker: { ptyId: w.ptyId, dispatchId: w.dispatchId } }
  } catch (e) {
    const startError = (e as Error).message
    const what = resolution.action === 'clarify' ? 'уточнение принято' : 'перезапуск'
    store.escalate(request.taskId, `${what}, но воркер не запустился: ${startError}`, { requestId: request.id, startFailed: true })
    return { request, startError }
  }
}
