import { createAsyncProjectCommandExecutor, type AsyncProjectCommandHost } from './async-project-commands.ts'
import { executionSource } from './execution-context.ts'
import type { WorkerCommands, WorkerCommandName } from '@orca-board/contracts'
import { CommandError, createProjectCommandExecutor } from './project-commands.ts'
import { commandDimensionsFrom, commandFields, commandString } from './command-input.ts'
import { createWorkerOperations, type WorkerOperationHost, type WorkerProject } from './worker-operations.ts'

export interface WorkerCommandHost extends AsyncProjectCommandHost<WorkerProject, WorkerCommandName>, WorkerOperationHost {}

function taskIn(project: WorkerProject, taskId: string): void {
  if (!project.store.getTask(taskId)) throw new CommandError('command.taskNotFound', { taskId })
}

/** Context/policy/payload предшествуют project/task lookup, Git и остановке процессов. */
export function createWorkerCommands(host: WorkerCommandHost): WorkerCommands {
  const execute = createAsyncProjectCommandExecutor(host)
  const executeSync = createProjectCommandExecutor(host)
  const operations = createWorkerOperations(host)
  return {
    start: (context, rawId, raw) => execute(context, 'workers.start', () => {
      const taskId = commandString(rawId, 'taskId')
      const input = raw === undefined ? {} : commandFields(raw, ['cols', 'rows', 'roleId'])
      const launch = { ...commandDimensionsFrom(input), roleId: input.roleId === undefined ? undefined : commandString(input.roleId, 'roleId') }
      return (project, context, scope) => { taskIn(project, taskId); return operations.start({ ...project, projectId: context.projectId, isCurrent: () => { scope.guard(); return true }, source: executionSource(context.actor.kind) }, taskId, launch) }
    }),
    stop: (context, rawId) => executeSync(context, 'workers.stop', () => {
      const taskId = commandString(rawId, 'taskId')
      return (project, context) => { taskIn(project, taskId); return operations.stop({ ...project, projectId: context.projectId }, taskId) }
    })
  }
}
