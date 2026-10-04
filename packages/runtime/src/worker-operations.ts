import { statusSource, type AgentInfo, type TaskStore } from '@orca-board/core'
import type { WorkerLaunchInput, WorkerLaunchResult, WorkerStopResult } from '@orca-board/contracts'
import type { WorkerEnvContext, WorkerServices } from './workers.ts'
import type { WorkflowDeps, TaskWorkflowServices } from './workflow.ts'
import type { createWorkerPreflight } from './worker-preflight.ts'
import type { TaskWorkerLifecycle } from './task-worker-lifecycle.ts'
import type { ExecutionResources } from './execution-resources.ts'
import { executionContext, executionProject, type ExecutionContext, type ExecutionMethods } from './execution-context.ts'
import type { EffectScope } from './effect-scope.ts'

export interface WorkerProject extends ExecutionContext {
  store: TaskStore
  root: string
  environment(runId?: string): WorkerEnvContext
  agents(): AgentInfo[]
  workflow: WorkflowDeps
}

export interface WorkerOperationHost {
  workers: ExecutionMethods<Pick<WorkerServices, 'startWorker'>>
  workflow: ExecutionMethods<Pick<TaskWorkflowServices, 'enterWork'>>
  preflight: Pick<ReturnType<typeof createWorkerPreflight>, 'validate'>
  lifecycle: Pick<TaskWorkerLifecycle, 'closeTaskWorkers'>
  resources: Pick<ExecutionResources, 'effects'>
}

/** Trusted путь socket/workflow: guards и effects едины с public owner commands. */
export function createWorkerOperations(host: WorkerOperationHost) {
  return {
    async start(project: WorkerProject, taskId: string, input: WorkerLaunchInput = {}): Promise<WorkerLaunchResult> {
      project = { ...project, source: project.source ?? statusSource() }
      const task = project.store.getTask(taskId)
      if (!task) {
        // Старый socket различает глобальную карточку и неизвестную подзадачу в WorkerServices.
        return host.workers.startWorker(project.store, project.root, project.environment(), taskId, input.cols, input.rows)
      }
      if (project.store.columnKind(task.status) === 'in_progress') throw new Error(`task already in progress: ${taskId}`)
      const environment = project.environment(task.runId)
      const agents = project.agents()
      let prepared: EffectScope | undefined
      try {
        const entered = await host.workflow.enterWork({ ...project.workflow, ...executionContext(project) }, taskId, { roleId: input.roleId,
          validateRole: roleId => { host.preflight.validate({ title: environment.typeTitle, roles: environment.roles }, agents, roleId) },
          onPrepared: () => { prepared = host.resources.effects.capture(executionProject(project.store, project.root, project), { taskId }, { source: project.source }) } })
        const scope = prepared ?? host.resources.effects.capture(executionProject(project.store, project.root, project), { taskId }, { source: project.source })
        prepared = scope
        scope.commit(() => host.lifecycle.closeTaskWorkers(project.store, taskId))
        scope.guard()
        return await host.workers.startWorker(project.store, project.root, { ...environment, ...executionContext(project) }, taskId, input.cols, input.rows, input.roleId ?? entered.roleId)
      } finally { prepared?.close() }
    },
    stop(project: Pick<WorkerProject, 'store'> & ExecutionContext & { root?: string }, taskId: string): WorkerStopResult {
      host.resources.effects.cancelTask(project.projectId ?? project.root ?? '', taskId)
      const stopped = project.store.activeDispatches().filter(dispatch => dispatch.taskId === taskId).map(dispatch => dispatch.id)
      host.lifecycle.closeTaskWorkers(project.store, taskId)
      const task = project.store.getTask(taskId)
      if (task && project.store.columnKind(task.status) === 'in_progress') project.store.moveTask(taskId, project.store.columnId('ready'))
      return { stopped }
    }
  }
}

export type WorkerOperations = ReturnType<typeof createWorkerOperations>
