import type { HumanRequestCommands, HumanRequestCommandName, HumanResolutionInput, RequestListOptions } from '@orca-board/contracts'
import { CommandError, createProjectCommandExecutor, type ProjectCommandHost } from './project-commands.ts'
import { commandAttachmentsFrom, commandFields, commandInputError, commandString } from './command-input.ts'
import { createReviewOperations, type ReviewOperationHost, type ReviewProject } from './review-operations.ts'

export interface HumanRequestCommandHost extends ReviewOperationHost, ProjectCommandHost<ReviewProject, HumanRequestCommandName> {}

function resolutionFrom(raw: unknown): HumanResolutionInput {
  const input = commandFields(raw, ['action', 'text', 'optionId'])
  const action = input.action
  if (action !== 'answer' && action !== 'accept' && action !== 'clarify' && action !== 'restart' && action !== 'dismiss' && action !== 'reject') commandInputError('action')
  if (input.text !== undefined && typeof input.text !== 'string') commandInputError('text')
  return { action, ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.optionId === undefined ? {} : { optionId: commandString(input.optionId, 'optionId') }) }
}

export function createHumanRequestCommands(host: HumanRequestCommandHost): HumanRequestCommands {
  const execute = createProjectCommandExecutor(host)
  const operations = createReviewOperations(host)
  return {
    list: (context, raw) => execute(context, 'requests.list', () => {
      const input = raw === undefined ? {} : commandFields(raw, ['runId', 'pending'])
      if (input.pending !== undefined && typeof input.pending !== 'boolean') commandInputError('pending')
      const options: RequestListOptions = { ...(input.runId === undefined ? {} : { runId: commandString(input.runId, 'runId') }),
        ...(input.pending === undefined ? {} : { pending: input.pending }) }
      return project => project.store.listRequests().filter(request =>
        (!options.runId || request.runId === options.runId) && (!options.pending || request.status === 'pending'))
    }),
    resolve: (context, rawId, raw, rawImages) => execute(context, 'requests.resolve', () => {
      const id = commandString(rawId, 'requestId')
      const resolution = resolutionFrom(raw)
      const images = commandAttachmentsFrom(rawImages)
      return project => {
        if (!project.store.getRequest(id)) throw new CommandError('command.requestNotFound', { requestId: id })
        return operations.resolve(project, id, resolution, images)
      }
    }),
    answer: (context, rawId, rawAnswer) => execute(context, 'questions.answer', () => {
      const id = commandString(rawId, 'questionId'); const answer = commandString(rawAnswer, 'answer')
      return project => {
        if (!project.store.getQuestion(id)) throw new CommandError('command.questionNotFound', { questionId: id })
        return operations.answer(project, id, answer)
      }
    })
  }
}
