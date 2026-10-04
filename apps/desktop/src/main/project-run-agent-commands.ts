import type { AgentCommands, ProjectGitCommands, RunCommands } from '@orca-board/contracts'
import { CommandError } from '@orca-board/runtime'
import { createDesktopProjectCommandAdapter, type DesktopCommandHandle, type DesktopProjectCommandHost } from './project-command-adapter'

export interface DesktopProjectRunAgentHost<Event> extends DesktopProjectCommandHost<Event> {
  projects: ProjectGitCommands
  runs: RunCommands
  agents: AgentCommands
}
export function registerDesktopProjectRunAgentCommands<Event>(handle: DesktopCommandHandle<Event>, host: DesktopProjectRunAgentHost<Event>): void {
  const { client, context, explicit, selected, invoke } = createDesktopProjectCommandAdapter(host)
  handle('projects:branch', (event, id: string) => invoke(() => host.projects.branch(explicit(event, id)).catch(error => {
    if (error instanceof CommandError && error.code === 'command.projectNotFound') return { isGitRepo: false, branch: null, detached: false }
    throw error
  })))
  handle('projects:branches', (event, id: string) => invoke(() => host.projects.branches(explicit(event, id))))
  handle('projects:gitFetch', (event, id: string) => invoke(() => host.projects.fetch(explicit(event, id))))
  handle('projects:gitPull', (event, id: string) => invoke(() => host.projects.pull(explicit(event, id))))
  handle('projects:checkoutBranch', (event, id: string, branch: string) => invoke(() => host.projects.checkout(explicit(event, id), typeof branch === 'string' ? branch : '')))
  handle('projects:createInitialCommit', (event, id: string, mode: unknown) => invoke(() => host.projects.initialCommit(explicit(event, id), mode === 'snapshot' ? 'snapshot' : 'empty')))
  handle('runs:list', event => invoke(() => { const ctx = selected(event); return ctx ? host.runs.list(ctx) : [] }))
  handle('runs:close', (event, id: string) => invoke(() => host.runs.close(context(event), id)))
  handle('agents:list', (event, refresh?: boolean) => invoke(() => {
    const ctx = client(event)
    return host.agents.list(ctx, host.activeProjectId(), Boolean(refresh))
  }))
}
