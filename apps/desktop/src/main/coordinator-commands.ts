import type { CoordinatorCommands } from '@orca-board/contracts'
import type { AttachmentInput } from '@orca-board/core'
import { CommandError } from '@orca-board/runtime'
import { OrcaError } from './i18n'
import { createDesktopProjectCommandAdapter, type DesktopCommandHandle, type DesktopProjectCommandHost } from './project-command-adapter'

export interface DesktopCoordinatorCommandHost<Event> extends DesktopProjectCommandHost<Event> { commands: CoordinatorCommands }

/** Старые IPC signatures/DTO; selection и локальные defaults остаются на Desktop границе. */
export function registerDesktopCoordinatorCommands<Event>(handle: DesktopCommandHandle<Event>, host: DesktopCoordinatorCommandHost<Event>): void {
  const { context, invoke } = createDesktopProjectCommandAdapter(host)
  handle('coordinator:start', (event, objective: unknown, cols?: number, rows?: number, images?: AttachmentInput[] | null) =>
    invoke(() => host.commands.start(context(event), { objective: typeof objective === 'string' ? objective : '', cols, rows, images }).then(result => result.ptyId)))
  handle('globalTasks:startCoordinator', (event, id: string, cols?: number, rows?: number, images?: AttachmentInput[] | null) =>
    invoke(() => host.commands.startCoordinator(context(event), id, { cols, rows, images }).then(result => result.ptyId)))
  handle('globalTasks:accept', (event, id: string, decision?: unknown) =>
    invoke(() => host.commands.accept(context(event), id, typeof decision === 'string' ? decision : undefined)))
  handle('globalTasks:returnToWork', (event, id: string, text: unknown, cols?: number, rows?: number, images?: AttachmentInput[] | null) =>
    invoke(() => {
      const ctx = context(event)
      return host.commands.returnToWork(ctx, id, { text: typeof text === 'string' ? text : '', cols, rows, images }).then(result => result.ptyId).catch(error => {
        // Старый returnRunWithImages оборачивал validation reason локализованным attachments.invalid.
        if (error instanceof CommandError && error.code === 'command.invalidInput' && error.details.field === 'images' && error.cause instanceof Error) {
          throw new OrcaError('attachments.invalid', { error: error.cause.message })
        }
        throw error
      })
    }))
}
