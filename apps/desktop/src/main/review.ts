import type { TaskStore } from '@orca-board/core'
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
