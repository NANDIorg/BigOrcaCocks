import type { CoordinatorCommands, CoordinatorCommandName } from '@orca-board/contracts'
import { createProjectCommandExecutor, type ProjectCommandHost } from './project-commands.ts'
import { commandAttachmentsFrom, commandDimensionsFrom, commandFields, commandInputError, commandString } from './command-input.ts'
import { createCoordinatorOperations, type CoordinatorOperationHost, type CoordinatorProject } from './coordinator-operations.ts'

export interface CoordinatorCommandHost extends ProjectCommandHost<CoordinatorProject, CoordinatorCommandName>, CoordinatorOperationHost {}

function textFrom(raw: unknown, field: string): string {
  if (typeof raw !== 'string') commandInputError(field)
  return raw
}

function launchFrom(input: Record<string, unknown>) {
  return { ...commandDimensionsFrom(input), images: commandAttachmentsFrom(input.images) }
}

/** Policy и payload проверяются раньше lookup; все действия scoped к одному явному проекту. */
export function createCoordinatorCommands(host: CoordinatorCommandHost): CoordinatorCommands {
  const execute = createProjectCommandExecutor(host)
  const operations = createCoordinatorOperations(host)
  return {
    start: (context, raw) => execute(context, 'coordinator.start', () => {
      const input = commandFields(raw, ['objective', 'typeId', 'cols', 'rows', 'images'])
      const objective = textFrom(input.objective, 'objective')
      const typeId = input.typeId === undefined ? undefined : commandString(input.typeId, 'typeId')
      const { cols, rows, images } = launchFrom(input)
      return project => operations.start(project, host.resources.coordinatorObjective(objective, images), cols, rows, images, undefined, typeId)
    }),
    startCoordinator: (context, rawId, raw) => execute(context, 'globalTasks.startCoordinator', () => {
      const runId = commandString(rawId, 'globalTaskId')
      const { cols, rows, images } = launchFrom(raw === undefined ? {} : commandFields(raw, ['cols', 'rows', 'images']))
      return project => operations.start(project, '', cols, rows, images, runId)
    }),
    accept: (context, rawId, rawDecision) => execute(context, 'globalTasks.accept', () => {
      const runId = commandString(rawId, 'globalTaskId')
      const decision = rawDecision === undefined ? undefined : textFrom(rawDecision, 'decision')
      return project => operations.accept(project, runId, decision)
    }),
    returnToWork: (context, rawId, raw) => execute(context, 'globalTasks.returnToWork', () => {
      const runId = commandString(rawId, 'globalTaskId')
      const input = commandFields(raw, ['text', 'cols', 'rows', 'images'])
      const text = textFrom(input.text, 'text'); const { cols, rows, images } = launchFrom(input)
      return project => operations.returnToWork(project, runId, text, cols, rows, images)
    })
  }
}
