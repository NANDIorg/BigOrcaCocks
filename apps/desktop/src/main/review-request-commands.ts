import type { AttachmentInput, RequestResolution } from '@orca-board/core'
import type { HumanRequestCommands, HumanResolutionInput, RequestListOptions, ReviewCommands } from '@orca-board/contracts'
import { CommandError } from '@orca-board/runtime'
import { OrcaError } from './i18n'
import { createDesktopProjectCommandAdapter, type DesktopCommandHandle, type DesktopProjectCommandHost } from './project-command-adapter'

export interface DesktopReviewRequestCommandHost<Event> extends DesktopProjectCommandHost<Event> {
  review: ReviewCommands
  requests: HumanRequestCommands
}

function cleanResolution(input: RequestResolution): HumanResolutionInput {
  // Невалидный RPC payload проверит общий parser; spread не должен превращать массив/строку в object.
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const clean = { ...input }
  delete clean.images
  return clean
}

function attachments<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof CommandError && error.code === 'command.invalidInput' && error.details.field === 'images' && error.cause instanceof Error) {
      throw new OrcaError('attachments.invalid', { error: error.cause.message })
    }
    throw error
  }
}

/** Прежние IPC payload/selection остаются здесь; выполнение общее для любого host. */
export function registerDesktopReviewRequestCommands<Event>(handle: DesktopCommandHandle<Event>, host: DesktopReviewRequestCommandHost<Event>): void {
  const { context, selected, invoke } = createDesktopProjectCommandAdapter(host)
  handle('review:info', (event, taskId: string) => invoke(() => host.review.info(context(event), taskId)))
  handle('review:accept', (event, taskId: string, text?: string) => invoke(() => { host.review.accept(context(event), taskId, text) }))
  handle('review:reject', (event, taskId: string, feedback: string, images?: AttachmentInput[]) =>
    invoke(() => attachments(() => host.review.reject(context(event), taskId, feedback, images))))
  handle('questions:answer', (event, id: string, answer: string) => invoke(() => host.requests.answer(context(event), id, answer)))
  handle('requests:list', (event, options?: RequestListOptions) => invoke(() => {
    const ctx = selected(event)
    return ctx ? host.requests.list(ctx, options) : []
  }))
  handle('requests:resolve', (event, id: string, resolution: RequestResolution, images?: AttachmentInput[]) =>
    invoke(() => attachments(() => host.requests.resolve(context(event), id, cleanResolution(resolution), images))))
}
