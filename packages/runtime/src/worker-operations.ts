import type { AgentInfo, TaskStore } from '@orca-board/core'
import type { WorkerLaunchInput, WorkerLaunchResult, WorkerStopResult } from '@orca-board/contracts'
import type { WorkerEnvContext, WorkerServices } from './workers.ts'
import type { WorkflowDeps, TaskWorkflowServices } from './workflow.ts'
import type { createWorkerPreflight } from './worker-preflight.ts'
import type { TaskWorkerLifecycle } from './task-worker-lifecycle.ts'

export interface WorkerProject {
  store: TaskStore
  root: string
  environment(runId?: string): WorkerEnvContext
  agents(): AgentInfo[]
  workflow: WorkflowDeps
}

export interface WorkerOperationHost {
  workers: Pick<WorkerServices, 'startWorker'>
  workflow: Pick<TaskWorkflowServices, 'enterWork'>
  preflight: Pick<ReturnType<typeof createWorkerPreflight>, 'validate'>
  lifecycle: Pick<TaskWorkerLifecycle, 'closeTaskWorkers'>
}

/** Trusted путь socket/workflow: guards и effects едины с public owner commands. */
export function createWorkerOperations(host: WorkerOperationHost) {
  return {
    start(project: WorkerProject, taskId: string, input: WorkerLaunchInput = {}): WorkerLaunchResult {
      const task = project.store.getTask(taskId)
      if (!task) {
        // Старый socket различает глобальную карточку и неизвестную подзадачу в WorkerServices.
        return host.workers.startWorker(project.store, project.root, project.environment(), taskId, input.cols, input.rows)
      }
      if (project.store.columnKind(task.status) === 'in_progress') throw new Error(`task already in progress: ${taskId}`)
      const environment = project.environment(task.runId)
      const agents = project.agents()
      const entered = host.workflow.enterWork(project.workflow, taskId, { roleId: input.roleId,
        validateRole: roleId => { host.preflight.validate({ title: environment.typeTitle, roles: environment.roles }, agents, roleId) } })
      host.lifecycle.closeTaskWorkers(project.store, taskId)
      return host.workers.startWorker(project.store, project.root, environment, taskId, input.cols, input.rows, input.roleId ?? entered.roleId)
    },
    stop(project: Pick<WorkerProject, 'store'>, taskId: string): WorkerStopResult {
      const stopped = project.store.activeDispatches().filter(dispatch => dispatch.taskId === taskId).map(dispatch => dispatch.id)
      host.lifecycle.closeTaskWorkers(project.store, taskId)
      const task = project.store.getTask(taskId)
      if (task && project.store.columnKind(task.status) === 'in_progress') project.store.moveTask(taskId, project.store.columnId('ready'))
      return { stopped }
    }
  }
}

export type WorkerOperations = ReturnType<typeof createWorkerOperations>
