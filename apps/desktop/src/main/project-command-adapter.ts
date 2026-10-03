import type { ProjectCommandContext } from '@orca-board/contracts'
import { CommandError } from '@orca-board/runtime'
import { OrcaError } from './i18n'

export interface DesktopProjectCommandHost<Event> {
  activeProjectId(): string | undefined
  /** null для чужого webContents/frame; clientId устанавливает main. */
  clientId(event: Event): string | null
}

export type DesktopCommandHandle<Event> = <Args extends unknown[]>(channel: string, callback: (event: Event, ...args: Args) => unknown) => void

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
    invoke<T>(operation: () => T): T {
      try { return operation() } catch (error) {
        if (!(error instanceof CommandError)) throw error
        // Существующий перевод host ошибок и тексты core guards сохраняются в старом IPC.
        if (error.code === 'command.rejected' && error.cause instanceof Error) throw error.cause
        // Старый IPC показывает оператору конкретную причину отказа вложений (лимиты, пустой файл).
        if (error.code === 'command.invalidInput' && error.details.field === 'images' && error.cause instanceof Error) throw error.cause
        throw new OrcaError(error.code, error.details)
      }
    }
  }
}
