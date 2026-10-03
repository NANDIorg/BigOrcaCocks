import type { ProjectCommandContext } from '@orca-board/contracts'
import { CommandError } from '@orca-board/runtime'
import { OrcaError } from './i18n'

export interface DesktopProjectCommandHost<Event> {
  activeProjectId(): string | undefined
  /** null для чужого webContents/frame; clientId устанавливает main. */
  clientId(event: Event): string | null
}

export type DesktopCommandHandle<Event> = <Args extends unknown[]>(channel: string, callback: (event: Event, ...args: Args) => unknown) => void

function translateCommandError(error: unknown): never {
  if (!(error instanceof CommandError)) throw error
  if (error.code === 'command.rejected' && error.cause instanceof Error) throw error.cause
  if (error.code === 'command.invalidInput' && error.details.field === 'images' && error.cause instanceof Error) throw error.cause
  throw new OrcaError(error.code, error.details)
}

export function invokeDesktopCommand<T>(operation: () => T): T {
  try {
    const result = operation()
    return result instanceof Promise ? result.catch(translateCommandError) as T : result
  } catch (error) {
    return translateCommandError(error)
  }
}

/** Legacy selection существует только на IPC границе; runtime всегда получает явный проект. */
export function createDesktopProjectCommandAdapter<Event>(host: DesktopProjectCommandHost<Event>) {
  function selected(event: Event): ProjectCommandContext | undefined {
    const clientId = host.clientId(event)
    if (typeof clientId !== 'string' || !clientId.trim()) throw new OrcaError('command.forbidden')
    const projectId = host.activeProjectId()
    return projectId ? { projectId, clientId, actor: { kind: 'operator', id: 'local-user' } } : undefined
  }
  return {
    selected,
    context(event: Event): ProjectCommandContext {
      const ctx = selected(event)
      if (!ctx) throw new OrcaError('projects.none')
      return ctx
    },
    invoke: invokeDesktopCommand
  }
}
