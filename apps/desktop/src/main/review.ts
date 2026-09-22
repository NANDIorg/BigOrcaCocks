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
 * Задача-ответ ничего не сливает: её результат — ответ, а файлы в worktree — черновики воркера.
 */
export function acceptReview(store: TaskStore, repoRoot: string, taskId: string): void {
  const task = store.getTask(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  if (task.answerFor && task.worktree && task.branch) {
    removeWorktree(repoRoot, task.worktree, task.branch)
  } else if (task.worktree && task.branch) {
    commitWorktree(task.worktree, `orca: ${task.title}`)
    const info = reviewInfo(repoRoot, task.worktree, task.branch)
    if (info.commits.length > 0) mergeBranch(repoRoot, task.branch, `Merge orca task: ${task.title}`)
    removeWorktree(repoRoot, task.worktree, task.branch)
  }
  // Ответ для человека: store шлёт координатору answer_accepted.
  store.acceptTask(taskId)
}
