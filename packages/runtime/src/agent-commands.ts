import type { ResolvedRunType, TaskStore } from '@orca-board/core'
import type { AgentCommands, AgentCommandName, Project } from '@orca-board/contracts'
import { CommandError, createClientCommandExecutor, createProjectCommandExecutor, type ClientCommandHost } from './project-commands.ts'
import { commandInputError, commandString } from './command-input.ts'
import type { AgentDiscovery } from './agent-discovery.ts'
import type { createWorkerPreflight } from './worker-preflight.ts'

export interface AgentCommandHost extends ClientCommandHost<AgentCommandName> {
  project(id: string): Project | undefined
  discovery: Pick<AgentDiscovery, 'agentInfos'>
  preflight: ReturnType<typeof createWorkerPreflight>
  resolveRun(projectId: string, runId?: string): ResolvedRunType
  store(projectId: string): TaskStore
}
export function createAgentCommands(host: AgentCommandHost): AgentCommands {
  const client = createClientCommandExecutor(host)
  const project = createProjectCommandExecutor(host)
  return {
    list: (context, projectId, refresh = false) => client(context, 'agents.list', () => {
      const id = projectId == null ? undefined : commandString(projectId, 'projectId')
      if (refresh != null && typeof refresh !== 'boolean') commandInputError('refresh')
      return () => {
        const p = id === undefined ? undefined : host.project(id)
        if (id !== undefined && !p) throw new CommandError('command.projectNotFound', { projectId: id })
        return host.discovery.agentInfos(p?.enabledAgents, refresh ?? false)
      }
    }),
    preflight: (context, roleId, runId) => project(context, 'agents.preflight', () => {
      const role = commandString(roleId, 'roleId'); const run = runId === undefined ? undefined : commandString(runId, 'runId')
      return p => {
        if (run && !host.store(p.id).getRun(run)) throw new CommandError('command.globalTaskNotFound', { globalTaskId: run })
        return host.preflight.validate(host.resolveRun(p.id, run), host.discovery.agentInfos(p.enabledAgents), role)
      }
    })
  }
}
