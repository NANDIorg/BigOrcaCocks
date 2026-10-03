import type { BoardCommands, TaskCreateInput, TaskPatch } from '@orca-board/contracts'
import { createDesktopProjectCommandAdapter, type DesktopCommandHandle, type DesktopProjectCommandHost } from './project-command-adapter'

export interface DesktopBoardCommandHost<Event> extends DesktopProjectCommandHost<Event> { commands: BoardCommands }

/** Legacy selection остаётся только в IPC adapter; runtime адресует проект явно. */
export function registerDesktopBoardCommands<Event>(handle: DesktopCommandHandle<Event>, host: DesktopBoardCommandHost<Event>): void {
  const { context, selected, invoke } = createDesktopProjectCommandAdapter(host)
  handle('board:get', event => invoke(() => {
    const ctx = selected(event)
    return ctx ? host.commands.get(ctx)
      : { tasks: [], dispatches: [], events: [], questions: [], runs: [] }
  }))
  handle('tasks:create', (event, input: TaskCreateInput) => invoke(() => host.commands.createTask(context(event), input)))
  handle('tasks:update', (event, id: string, patch?: TaskPatch | null) => invoke(() => host.commands.updateTask(context(event), id, patch ?? {})))
  handle('tasks:move', (event, id: string, status: string) => invoke(() => host.commands.moveTask(context(event), id, status)))
  handle('tasks:remove', (event, id: string) => invoke(() => host.commands.removeTask(context(event), id)))
}
