import { isAgentKind, type AgentKind, type BoardColumn } from '@orca-board/core'
import type { ProjectConfigCommands, ProjectConfigCommandName, ProjectTaskTypesInput } from '@orca-board/contracts'
import type { RuntimeProjectManager } from './projects.ts'
import { createProjectCommandExecutor, type ProjectCommandHost } from './project-commands.ts'
import { commandArray, commandObject, commandOptionalString, commandString, invalidCommandField } from './profile-command-input.ts'

type Manager = Pick<RuntimeProjectManager, 'get' | 'setEnabledAgents' | 'setColumns' | 'setProjectTaskTypes' | 'setProjectGroup'>
export interface ProjectConfigCommandHost extends Pick<ProjectCommandHost<unknown, ProjectConfigCommandName>, 'authorize'> {
  manager(): Manager
}

export function createProjectConfigCommands(host: ProjectConfigCommandHost): ProjectConfigCommands {
  const execute = createProjectCommandExecutor<Manager, ProjectConfigCommandName>({ authorize: host.authorize,
    project: id => { const manager = host.manager(); return manager.get(id) ? manager : undefined } })
  return {
    setEnabledAgents: (ctx, input) => execute(ctx, 'project.setEnabledAgents', () => {
      const agents = commandArray(input, 'agents', (agent, field) => {
        if (typeof agent !== 'string' || !isAgentKind(agent)) return invalidCommandField(field)
        return agent as AgentKind
      })
      return (pm, context) => pm.setEnabledAgents(context.projectId, agents)
    }),
    setColumns: (ctx, input) => execute(ctx, 'project.setColumns', () => {
      const columns = commandArray(input, 'columns', (column, field) => {
        const value = commandObject(column, ['id', 'title', 'kind', 'color'], field)
        for (const key of ['id', 'title', 'kind']) commandString(value[key], `${field}.${key}`)
        commandOptionalString(value.color, `${field}.color`)
        return value as unknown as BoardColumn
      })
      return (pm, context) => pm.setColumns(context.projectId, columns)
    }),
    setTaskTypes: (ctx, input) => execute(ctx, 'project.setTaskTypes', () => {
      const value = commandObject(input, ['typeIds', 'defaultTypeId'], 'types')
      commandString(value.defaultTypeId, 'defaultTypeId')
      if (value.typeIds != null) value.typeIds = commandArray(value.typeIds, 'typeIds', commandString)
      return (pm, context) => pm.setProjectTaskTypes(context.projectId, value as unknown as ProjectTaskTypesInput)
    }),
    setGroup: (ctx, groupId) => execute(ctx, 'project.setGroup', () => {
      const id = groupId === null ? null : commandString(groupId, 'groupId')
      return (pm, context) => pm.setProjectGroup(context.projectId, id)
    })
  }
}
