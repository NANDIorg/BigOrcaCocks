import type { TaskStore } from '@orca-board/core'
import type { ExecutionResources } from './execution-resources.ts'
import { runImagesRoot, removeRunImagesDir, showcaseSnapshotsRoot, removeShowcaseDir } from './artifact-paths.ts'

export interface GlobalTaskRemovalDeps {
  resources: ExecutionResources
  dataDir: string
  messages: { error(key: 'global.coordinatorAlive'): Error }
  sessions: { isAlive(ptyId: string): boolean; kill(ptyId: string): void }
}

/** Trusted операция для command service и legacy socket; transport авторизует вызов отдельно. */
export function createGlobalTaskRemoval({ resources, dataDir, sessions, messages }: GlobalTaskRemovalDeps) {
  return function remove(project: { id: string; store: TaskStore; root: string }, runId: string, cascade: boolean) {
    const run = project.store.getRun(runId)
    if (run?.coordinatorPtyId && sessions.isAlive(run.coordinatorPtyId)) throw messages.error('global.coordinatorAlive')
    const ptyIds = project.store.snapshot().dispatches
      .filter(d => project.store.getTask(d.taskId)?.runId === runId && sessions.isAlive(d.ptyId)).map(d => d.ptyId)
    // Store сначала проверяет cascade/незакрытые dispatch: при отказе cleanup не начинается.
    const result = project.store.deleteGlobalTask(runId, { cascade })
    removeRunImagesDir(runImagesRoot(dataDir), project.id, runId)
    removeShowcaseDir(showcaseSnapshotsRoot(dataDir), project.id, runId)
    ptyIds.forEach(id => sessions.kill(id))
    if (run?.git?.worktree) resources.removeRunWorktree(project.root, run.git.worktree)
    return result
  }
}
