import type { ClientCommandContext, EffectResolution, RecoveryCommands } from '@orca-board/contracts'
import { OrcaError } from './i18n'
import { invokeDesktopCommand, type DesktopCommandHandle } from './project-command-adapter'

export function registerDesktopRecoveryCommands<Event>(handle: DesktopCommandHandle<Event>, host: { commands: RecoveryCommands; clientId(event: Event): string | null }): void {
  const context = (event: Event): ClientCommandContext => {
    const clientId = host.clientId(event)
    if (!clientId) throw new OrcaError('command.forbidden')
    return { clientId, actor: { kind: 'operator', id: 'local-user' } }
  }
  handle('recovery:list', (event, projectId?: string) => invokeDesktopCommand(() => host.commands.list(context(event), projectId)))
  handle('recovery:inspect', (event, projectId: string) => invokeDesktopCommand(() => host.commands.inspect(context(event), projectId)))
  handle('recovery:resolve', (event, id: string, revision: number, resolution: EffectResolution) => invokeDesktopCommand(() => host.commands.resolve(context(event), id, revision, resolution)))
}
