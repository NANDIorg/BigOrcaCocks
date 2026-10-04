import { statusSource, type TaskStore } from '@orca-board/core'
import { executionProject, obsoleteEffect, type ExecutionContext } from './execution-context.ts'
import { CommandError } from './project-commands.ts'
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
  return async function remove(project: { id: string; store: TaskStore; root: string } & ExecutionContext, runId: string, cascade: boolean) {
    const run = project.store.getRun(runId)
    if (run?.coordinatorPtyId && sessions.isAlive(run.coordinatorPtyId)) throw messages.error('global.coordinatorAlive')
    const ptyIds = project.store.snapshot().dispatches
      .filter(d => project.store.getTask(d.taskId)?.runId === runId && sessions.isAlive(d.ptyId)).map(d => d.ptyId)
    // Store сначала проверяет cascade/незакрытые dispatch: при отказе cleanup не начинается.
    const scope = resources.effects.capture(executionProject(project.store, project.root, { ...project, projectId: project.id }), {}, { source: project.source ?? statusSource() })
    try {
      const result = scope.commit(() => project.store.deleteGlobalTask(runId, { cascade }))
      scope.guard()
      resources.effects.cancelRun(project.id, runId)
      removeRunImagesDir(runImagesRoot(dataDir), project.id, runId)
      removeShowcaseDir(showcaseSnapshotsRoot(dataDir), project.id, runId)
      ptyIds.forEach(id => sessions.kill(id))
      if (run?.git?.worktree) {
        const worktree = run.git.worktree
        const guard = () => { scope.guard(); if (project.store.getRun(runId)) throw new CommandError('command.stale', { globalTaskId: runId }) }
        try { await scope.wait(() => resources.git.workflowGit.transaction(project.root, repo => repo.removeCleanWorktree(worktree), { guard, signal: scope.signal })) }
        catch (error) { if (obsoleteEffect(error)) throw error; guard(); resources.logger.warn(`[orca] не удалось убрать worktree удалённого прогона ${runId}: ${error instanceof Error ? error.message : String(error)}`) }
      }
      return result
    } finally { scope.close() }
  }
}
