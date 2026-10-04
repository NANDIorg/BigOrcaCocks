import type { GlobalTaskCommands, GlobalTaskInput, GlobalTaskPatch, ProjectCommandContext, SubtaskInput } from '@orca-board/contracts'
import type { AttachmentInput } from '@orca-board/core'
import { createDesktopProjectCommandAdapter, type DesktopCommandHandle, type DesktopProjectCommandHost } from './project-command-adapter'

export interface DesktopGlobalTaskCommandHost<Event> extends DesktopProjectCommandHost<Event> {
  commands: GlobalTaskCommands
  attachments?: {
    reveal(context: ProjectCommandContext, id: string, imageId: string): void
    open(context: ProjectCommandContext, id: string, imageId: string): Promise<void>
  }
}

/** Прежние channels/preload получают общий service; sender и selection фиксируются один раз за вызов. */
export function registerDesktopGlobalTaskCommands<Event>(handle: DesktopCommandHandle<Event>, host: DesktopGlobalTaskCommandHost<Event>): void {
  const { context, selected, invoke } = createDesktopProjectCommandAdapter(host)
  handle('globalTasks:list', event => invoke(() => {
    const ctx = selected(event)
    return ctx ? host.commands.list(ctx) : []
  }))
  handle('globalTasks:get', (event, id: string) => invoke(() => host.commands.get(context(event), id)))
  handle('globalTasks:create', (event, input?: GlobalTaskInput | null, images?: AttachmentInput[] | null) =>
    invoke(() => host.commands.create(context(event), input ?? {}, images)))
  handle('globalTasks:update', (event, id: string, patch?: GlobalTaskPatch | null) =>
    invoke(() => host.commands.update(context(event), id, patch ?? {})))
  handle('globalTasks:changeType', (event, id: string, typeId: string) => invoke(() => host.commands.changeType(context(event), id, typeId)))
  handle('globalTasks:move', (event, id: string, status: string) => invoke(() => host.commands.move(context(event), id, status)))
  handle('globalTasks:remove', (event, id: string, options?: { cascade?: boolean } | null) =>
    invoke(() => host.commands.remove(context(event), id, options ?? undefined)))
  handle('globalTasks:tasks', (event, id: string) => invoke(() => host.commands.tasks(context(event), id)))
  handle('globalTasks:createTask', (event, id: string, input: SubtaskInput) => invoke(() => host.commands.createTask(context(event), id, input)))
  handle('globalTasks:addImages', (event, id: string, images?: AttachmentInput[] | null) => invoke(() => host.commands.addImages(context(event), id, images)))
  handle('globalTasks:removeImage', (event, id: string, imageId: string) => invoke(() => host.commands.removeImage(context(event), id, imageId)))
  handle('globalTasks:image', (event, id: string, imageId: string) => invoke(() => host.commands.image(context(event), id, imageId)))
  if (host.attachments) {
    const attachments = host.attachments
    handle('globalTasks:revealAttachment', (event, id: string, imageId: string) => invoke(() => attachments.reveal(context(event), id, imageId)))
    handle('globalTasks:openAttachment', (event, id: string, imageId: string) => invoke(() => attachments.open(context(event), id, imageId)))
  }
}
