import { statusSource, type Attachment, type TaskStore } from '@orca-board/core'
import type { CoordinatorLaunchResult } from '@orca-board/contracts'
import type { WorkerEnvContext, WorkerServices } from './workers.ts'
import type { RunWorkflowDeps, RunWorkflowServices } from './workflow-run.ts'
import type { ExecutionResources } from './execution-resources.ts'
import { executionContext, type ExecutionContext, type ExecutionMethods } from './execution-context.ts'
import { CommandError } from './project-commands.ts'

export interface CoordinatorProject extends ExecutionContext {
  store: TaskStore
  root: string
  environment(runId?: string): WorkerEnvContext
  newRunEnvironment(typeId?: string): WorkerEnvContext
  workflow: RunWorkflowDeps
}

export interface CoordinatorOperationHost {
  workers: ExecutionMethods<Pick<WorkerServices, 'startCoordinator' | 'returnToWork'>>
  workflow: ExecutionMethods<Pick<RunWorkflowServices, 'isRunScope' | 'startRunWorkflow' | 'acceptRun' | 'returnRun'>>
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

  async function start(project: CoordinatorProject, objective: string, cols?: number, rows?: number, images: Attachment[] = [], runId?: string, typeId?: string): Promise<CoordinatorLaunchResult> {
    project = { ...project, source: project.source ?? statusSource() }
    if (runId !== undefined) {
      const run = existing(project, runId)
      if (run.workflowScope === 'run' && run.stage && project.store.runWorkflow(runId).nodes.find(node => node.id === run.stage!.nodeId)?.type === 'end') {
        throw host.messages.error('workflow.runFinished')
      }
    }
    const env = runId === undefined ? project.newRunEnvironment(typeId) : project.environment(runId)
    const started = await host.workers.startCoordinator(project.store, project.root, { ...env, ...executionContext(project) }, objective, cols, rows, images, runId)
    await host.workflow.startRunWorkflow({ ...project.workflow, ...executionContext(project) }, started.runId)
    return started
  }

  return {
    start,
    accept(project: CoordinatorProject, runId: string, decision?: string) {
      existing(project, runId)
      return host.workflow.acceptRun({ ...project.workflow, ...executionContext(project) }, runId, decision)
    },
    async returnToWork(project: CoordinatorProject, runId: string, text: string, cols?: number, rows?: number, images: Attachment[] = []): Promise<CoordinatorLaunchResult> {
      project = { ...project, source: project.source ?? statusSource() }
      existing(project, runId)
      if (host.workflow.isRunScope(project.store, runId)) {
        await host.resources.returnRunWithImages(project.store, project.root, runId, images, text,
          paths => host.workflow.returnRun({ ...project.workflow, ...executionContext(project) }, runId, text, paths), project)
        // Human решение уже durable: при failed launch referenced файлы сохраняются для возобновления.
        const ptyId = project.store.getRun(runId)?.coordinatorPtyId
        if (!ptyId || !project.workflow.isAlive(ptyId)) throw host.messages.error('workflow.coordinatorNotRunning')
        return { ptyId, runId }
      }
      return host.resources.returnRunWithImages(project.store, project.root, runId, images, text,
        paths => host.workers.returnToWork(project.store, project.root, { ...project.environment(runId), ...executionContext(project) }, runId, text, cols, rows, paths), project)
    }
  }
}

export type CoordinatorOperations = ReturnType<typeof createCoordinatorOperations>
