import type { TaskStore } from '@orca-board/core'
import type { createSessionRegistry } from './sessions.ts'

/** Dispatch закрывается прежде kill: callback выхода не должен считать остановку падением. */
export function createTaskWorkerLifecycle(sessions: Pick<ReturnType<typeof createSessionRegistry>, 'isAlive' | 'killPty'>) {
  function closeTaskWorkers(store: TaskStore, taskId: string): void {
    const ptyIds = new Set(store.closeDispatches(taskId).map(dispatch => dispatch.ptyId))
    // После done dispatch уже закрыт, но терминал агента ещё может оставаться живым.
    for (const dispatch of store.snapshot().dispatches) {
      if (dispatch.taskId === taskId && sessions.isAlive(dispatch.ptyId)) ptyIds.add(dispatch.ptyId)
    }
    for (const ptyId of ptyIds) sessions.killPty(ptyId)
  }

  return {
    closeTaskWorkers,
    closeDoneWorkers(store: TaskStore): void {
      const doneTasks = new Set<string>()
      for (const dispatch of store.snapshot().dispatches) {
        if (dispatch.endedAt && !sessions.isAlive(dispatch.ptyId)) continue
        const task = store.getTask(dispatch.taskId)
        if (task && store.columnKind(task.status) === 'done') doneTasks.add(task.id)
      }
      for (const taskId of doneTasks) closeTaskWorkers(store, taskId)
    },
    syncWorkerLiveness(store: TaskStore, taskId: string): void {
      const active = store.activeDispatches().filter(dispatch => dispatch.taskId === taskId)
      if (active.length > 0 && active.every(dispatch => !sessions.isAlive(dispatch.ptyId))) store.closeDispatches(taskId)
    }
  }
}

export type TaskWorkerLifecycle = ReturnType<typeof createTaskWorkerLifecycle>
