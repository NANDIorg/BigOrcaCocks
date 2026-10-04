import { createAsyncProjectCommandExecutor, type AsyncProjectCommandHost } from './async-project-commands.ts'
import { executionSource } from './execution-context.ts'
import type { ReviewCommands, ReviewCommandName } from '@orca-board/contracts'
import { CommandError } from './project-commands.ts'
import { commandAttachmentsFrom, commandInputError, commandString } from './command-input.ts'
import { createReviewOperations, type ReviewOperationHost, type ReviewProject } from './review-operations.ts'

export interface ReviewCommandHost extends ReviewOperationHost, AsyncProjectCommandHost<ReviewProject, ReviewCommandName> {}

export function createReviewCommands(host: ReviewCommandHost): ReviewCommands {
  const execute = createAsyncProjectCommandExecutor(host)
  const operations = createReviewOperations(host)
  function taskIn(project: ReviewProject, id: string): void {
    if (!project.store.getTask(id)) throw new CommandError('command.taskNotFound', { taskId: id })
  }
  return {
    info: (context, rawId) => execute(context, 'review.info', () => {
      const id = commandString(rawId, 'taskId')
      return (project, context, scope) => { taskIn(project, id); return operations.info({ ...project, projectId: context.projectId, isCurrent: () => { scope.guard(); return true }, source: executionSource(context.actor.kind) }, id) }
    }),
    accept: (context, rawId, text) => execute(context, 'review.accept', () => {
      const id = commandString(rawId, 'taskId')
      if (text !== undefined && typeof text !== 'string') commandInputError('text')
      return (project, context, scope) => { taskIn(project, id); return operations.decide({ ...project, projectId: context.projectId, isCurrent: () => { scope.guard(); return true }, source: executionSource(context.actor.kind) }, id, 'accept', text) }
    }),
    reject: (context, rawId, feedback, rawImages) => execute(context, 'review.reject', () => {
      const id = commandString(rawId, 'taskId')
      if (typeof feedback !== 'string') commandInputError('feedback')
      const images = commandAttachmentsFrom(rawImages)
      return (project, context, scope) => { taskIn(project, id); return operations.decide({ ...project, projectId: context.projectId, isCurrent: () => { scope.guard(); return true }, source: executionSource(context.actor.kind) }, id, 'reject', feedback, images) }
    })
  }
}
