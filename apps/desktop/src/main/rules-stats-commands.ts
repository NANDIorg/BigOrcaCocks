import type { StatsRange } from '@orca-board/core'
import type { ProjectCommandContext, RuleCommands, RuleFileName, StatsCommands } from '@orca-board/contracts'
import { OrcaError } from './i18n'
import { createDesktopProjectCommandAdapter, type DesktopCommandHandle, type DesktopProjectCommandHost } from './project-command-adapter'

export interface DesktopRulesStatsCommandHost<Event> extends DesktopProjectCommandHost<Event> {
  rules: RuleCommands
  stats: StatsCommands
}

export function registerDesktopRulesStatsCommands<Event>(handle: DesktopCommandHandle<Event>, host: DesktopRulesStatsCommandHost<Event>): void {
  const { context, invoke } = createDesktopProjectCommandAdapter(host)
  function explicit(event: Event, projectId: string): ProjectCommandContext {
    const clientId = host.clientId(event)
    if (typeof clientId !== 'string' || !clientId.trim()) throw new OrcaError('command.forbidden')
    return { projectId, clientId, actor: { kind: 'operator', id: 'local-user' } }
  }
  handle('rules:list', event => invoke(() => host.rules.list(context(event))))
  handle('rules:save', (event, name: RuleFileName, text: string) => invoke(() => host.rules.save(context(event), name, text)))
  handle('stats:project', (event, projectId: string, range: StatsRange) => invoke(() => host.stats.project(explicit(event, projectId), range)))
  handle('stats:task', (event, projectId: string, taskId: string) => invoke(() => host.stats.task(explicit(event, projectId), taskId)))
  handle('stats:global', (event, projectId: string, runId: string) => invoke(() => host.stats.global(explicit(event, projectId), runId)))
}
