import type { BoardCommands, ProjectCommandContext, TaskCreateInput, TaskPatch } from '@orca-board/contracts'
import { BoardCommandError } from '@orca-board/runtime'
import { OrcaError } from './i18n'

export interface DesktopBoardCommandHost<Event> {
  commands: BoardCommands
  activeProjectId(): string | undefined
  /** null для чужого webContents/frame; clientId устанавливает main, а не renderer. */
  clientId(event: Event): string | null
}

type Handle<Event> = <Args extends unknown[]>(channel: string, callback: (event: Event, ...args: Args) => unknown) => void

/** Legacy selection остаётся только здесь; runtime и будущие transport adapters всегда адресуют проект явно. */
export function registerDesktopBoardCommands<Event>(handle: Handle<Event>, host: DesktopBoardCommandHost<Event>): void {
  function client(event: Event): string {
    const id = host.clientId(event)
    if (typeof id !== 'string' || !id.trim()) throw new OrcaError('command.forbidden')
    return id
  }

  function context(event: Event): ProjectCommandContext {
    const clientId = client(event)
    const projectId = host.activeProjectId()
    if (!projectId) throw new OrcaError('projects.none')
    return { projectId, clientId, actor: { kind: 'operator', id: 'local-user' } }
  }

  function invoke<T>(operation: () => T): T {
    try { return operation() } catch (error) {
      if (!(error instanceof BoardCommandError)) throw error
      // Существующий перевод выбора роли и тексты core guards сохраняются для старого IPC.
      if (error.code === 'command.rejected' && error.cause instanceof Error) throw error.cause
      throw new OrcaError(error.code, error.details)
    }
  }

  handle('board:get', event => invoke(() => {
    const clientId = client(event)
    const projectId = host.activeProjectId()
    return projectId ? host.commands.get({ projectId, clientId, actor: { kind: 'operator', id: 'local-user' } })
      : { tasks: [], dispatches: [], events: [], questions: [], runs: [] }
  }))
  handle('tasks:create', (event, input: TaskCreateInput) => invoke(() => host.commands.createTask(context(event), input)))
  handle('tasks:update', (event, id: string, patch?: TaskPatch | null) => invoke(() => host.commands.updateTask(context(event), id, patch ?? {})))
  handle('tasks:move', (event, id: string, status: string) => invoke(() => host.commands.moveTask(context(event), id, status)))
  handle('tasks:remove', (event, id: string) => invoke(() => host.commands.removeTask(context(event), id)))
}
