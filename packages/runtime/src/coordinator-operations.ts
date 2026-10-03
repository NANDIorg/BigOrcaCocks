import type { Attachment, TaskStore } from '@orca-board/core'
import type { CoordinatorLaunchResult } from '@orca-board/contracts'
import type { WorkerEnvContext, WorkerServices } from './workers.ts'
import type { RunWorkflowDeps, RunWorkflowServices } from './workflow-run.ts'
import type { ExecutionResources } from './execution-resources.ts'
import { CommandError } from './project-commands.ts'

export interface CoordinatorProject {
  store: TaskStore
  root: string
  environment(runId?: string): WorkerEnvContext
  newRunEnvironment(typeId?: string): WorkerEnvContext
  workflow: RunWorkflowDeps
}

export interface CoordinatorOperationHost {
  workers: Pick<WorkerServices, 'startCoordinator' | 'returnToWork'>
  workflow: Pick<RunWorkflowServices, 'isRunScope' | 'startRunWorkflow' | 'acceptRun' | 'returnRun'>
  resources: Pick<ExecutionResources, 'coordinatorObjective' | 'returnRunWithImages'>
  messages: { error(key: 'workflow.runFinished' | 'workflow.coordinatorNotRunning'): Error }
}

/** Trusted orchestration для owner commands и старого agent socket; проект уже выбран host. */
export function createCoordinatorOperations(host: CoordinatorOperationHost) {
  function existing(project: CoordinatorProject, runId: string) {
    const run = project.store.getRun(runId)
    if (!run) throw new CommandError('command.globalTaskNotFound', { globalTaskId: runId })
    return run
  }

  function start(project: CoordinatorProject, objective: string, cols?: number, rows?: number, images: Attachment[] = [], runId?: string, typeId?: string): CoordinatorLaunchResult {
    if (runId !== undefined) {
      const run = existing(project, runId)
      if (run.workflowScope === 'run' && run.stage && project.store.runWorkflow(runId).nodes.find(node => node.id === run.stage!.nodeId)?.type === 'end') {
        throw host.messages.error('workflow.runFinished')
      }
    }
    const env = runId === undefined ? project.newRunEnvironment(typeId) : project.environment(runId)
    const started = host.workers.startCoordinator(project.store, project.root, env, objective, cols, rows, images, runId)
    host.workflow.startRunWorkflow(project.workflow, started.runId)
    return started
  }

  return {
    start,
    accept(project: CoordinatorProject, runId: string, decision?: string) {
      existing(project, runId)
      return host.workflow.acceptRun(project.workflow, runId, decision)
    },
    returnToWork(project: CoordinatorProject, runId: string, text: string, cols?: number, rows?: number, images: Attachment[] = []): CoordinatorLaunchResult {
      existing(project, runId)
      if (host.workflow.isRunScope(project.store, runId)) {
        host.resources.returnRunWithImages(project.store, project.root, runId, images, text,
          paths => host.workflow.returnRun(project.workflow, runId, text, paths))
        // Human решение уже durable: при failed launch referenced файлы сохраняются для возобновления.
        const ptyId = project.store.getRun(runId)?.coordinatorPtyId
        if (!ptyId || !project.workflow.isAlive(ptyId)) throw host.messages.error('workflow.coordinatorNotRunning')
        return { ptyId, runId }
      }
      return host.resources.returnRunWithImages(project.store, project.root, runId, images, text,
        paths => host.workers.returnToWork(project.store, project.root, project.environment(runId), runId, text, cols, rows, paths))
    }
  }
}

export type CoordinatorOperations = ReturnType<typeof createCoordinatorOperations>
