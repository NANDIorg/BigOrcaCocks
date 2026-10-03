import type { AttachmentInput, HumanRequest, Question, RequestResolution } from '@orca-board/core'
import type { RequestListOptions, RequestResolveResult } from './tasks.ts'
import type { ProjectCommandContext } from './project-commands.ts'

export type HumanRequestCommandName = 'requests.list' | 'requests.resolve' | 'questions.answer'
/** Серверные пути вложений устанавливает только owner после проверки bytes. */
export type HumanResolutionInput = Omit<RequestResolution, 'images'>

export interface HumanRequestCommands {
  list(context: ProjectCommandContext, options?: RequestListOptions): HumanRequest[]
  resolve(context: ProjectCommandContext, id: string, resolution: HumanResolutionInput, images?: AttachmentInput[]): RequestResolveResult
  answer(context: ProjectCommandContext, questionId: string, answer: string): Question
}
