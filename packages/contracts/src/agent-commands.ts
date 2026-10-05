import type { AgentInfo, Role } from '@orca-board/core'
import type { ClientCommandContext, ProjectCommandContext } from './project-commands.ts'

export interface AgentCommands {
  /** В JSON-позиционных аргументах отсутствие значения передаётся как null. */
  list(context: ClientCommandContext, projectId?: string | null, refresh?: boolean | null): AgentInfo[]
  preflight(context: ProjectCommandContext, roleId: string, runId?: string): Role
}
export type AgentCommandName = `agents.${keyof AgentCommands}`
