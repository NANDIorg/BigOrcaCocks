import type { AgentKind, BoardColumn } from '@orca-board/core'
import type { ProjectCommandContext } from './project-commands.ts'
import type { Project } from './projects.ts'
import type { ProjectTaskTypesInput } from './tasks.ts'

export interface ProjectConfigCommands {
  setEnabledAgents(context: ProjectCommandContext, agents: AgentKind[]): Project
  setColumns(context: ProjectCommandContext, columns: BoardColumn[]): Project
  setTaskTypes(context: ProjectCommandContext, input: ProjectTaskTypesInput): Project
  setGroup(context: ProjectCommandContext, groupId: string | null): Project
}
export type ProjectConfigCommandName = `project.${keyof ProjectConfigCommands}`
