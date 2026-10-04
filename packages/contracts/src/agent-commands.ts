import type { AgentInfo, Role } from '@orca-board/core'
import type { ClientCommandContext, ProjectCommandContext } from './project-commands.ts'

export interface AgentCommands {
  list(context: ClientCommandContext, projectId?: string, refresh?: boolean): AgentInfo[]
  preflight(context: ProjectCommandContext, roleId: string, runId?: string): Role
}
export type AgentCommandName = `agents.${keyof AgentCommands}`
