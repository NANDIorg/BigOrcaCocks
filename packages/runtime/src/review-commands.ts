import type { ReviewCommands, ReviewCommandName } from '@orca-board/contracts'
import { CommandError, createProjectCommandExecutor, type ProjectCommandHost } from './project-commands.ts'
import { commandAttachmentsFrom, commandInputError, commandString } from './command-input.ts'
import { createReviewOperations, type ReviewOperationHost, type ReviewProject } from './review-operations.ts'

export interface ReviewCommandHost extends ReviewOperationHost, ProjectCommandHost<ReviewProject, ReviewCommandName> {}

export function createReviewCommands(host: ReviewCommandHost): ReviewCommands {
  const execute = createProjectCommandExecutor(host)
  const operations = createReviewOperations(host)
  function taskIn(project: ReviewProject, id: string): void {
    if (!project.store.getTask(id)) throw new CommandError('command.taskNotFound', { taskId: id })
  }
  return {
    info: (context, rawId) => execute(context, 'review.info', () => {
      const id = commandString(rawId, 'taskId')
      return project => { taskIn(project, id); return operations.info(project, id) }
    }),
    accept: (context, rawId, text) => execute(context, 'review.accept', () => {
      const id = commandString(rawId, 'taskId')
      if (text !== undefined && typeof text !== 'string') commandInputError('text')
      return project => { taskIn(project, id); return operations.decide(project, id, 'accept', text) }
    }),
    reject: (context, rawId, feedback, rawImages) => execute(context, 'review.reject', () => {
      const id = commandString(rawId, 'taskId')
      if (typeof feedback !== 'string') commandInputError('feedback')
      const images = commandAttachmentsFrom(rawImages)
      return project => { taskIn(project, id); return operations.decide(project, id, 'reject', feedback, images) }
    })
  }
}
