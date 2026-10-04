import type { WorkerCommands } from '@orca-board/contracts'
import { createDesktopProjectCommandAdapter, type DesktopCommandHandle, type DesktopProjectCommandHost } from './project-command-adapter'

export interface DesktopWorkerCommandHost<Event> extends DesktopProjectCommandHost<Event> { commands: WorkerCommands }

/** Selection относится к клиенту Desktop; прежние signature и launch DTO сохраняются. */
export function registerDesktopWorkerCommands<Event>(handle: DesktopCommandHandle<Event>, host: DesktopWorkerCommandHost<Event>): void {
  const { context, invoke } = createDesktopProjectCommandAdapter(host)
  handle('worker:start', (event, taskId: string, cols?: number, rows?: number) =>
    invoke(() => host.commands.start(context(event), taskId, { cols, rows })))
}
