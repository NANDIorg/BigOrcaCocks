import type { WorkerCommands, WorkerCommandName } from '@orca-board/contracts'
import { CommandError, createProjectCommandExecutor, type ProjectCommandHost } from './project-commands.ts'
import { commandDimensionsFrom, commandFields, commandString } from './command-input.ts'
import { createWorkerOperations, type WorkerOperationHost, type WorkerProject } from './worker-operations.ts'

export interface WorkerCommandHost extends ProjectCommandHost<WorkerProject, WorkerCommandName>, WorkerOperationHost {}

function taskIn(project: WorkerProject, taskId: string): void {
  if (!project.store.getTask(taskId)) throw new CommandError('command.taskNotFound', { taskId })
}

/** Context/policy/payload предшествуют project/task lookup, Git и остановке процессов. */
export function createWorkerCommands(host: WorkerCommandHost): WorkerCommands {
  const execute = createProjectCommandExecutor(host)
  const operations = createWorkerOperations(host)
  return {
    start: (context, rawId, raw) => execute(context, 'workers.start', () => {
      const taskId = commandString(rawId, 'taskId')
      const input = raw === undefined ? {} : commandFields(raw, ['cols', 'rows', 'roleId'])
      const launch = { ...commandDimensionsFrom(input), roleId: input.roleId === undefined ? undefined : commandString(input.roleId, 'roleId') }
      return project => { taskIn(project, taskId); return operations.start(project, taskId, launch) }
    }),
    stop: (context, rawId) => execute(context, 'workers.stop', () => {
      const taskId = commandString(rawId, 'taskId')
      return project => { taskIn(project, taskId); return operations.stop(project, taskId) }
    })
  }
}
