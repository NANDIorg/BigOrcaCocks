import type { TaskStore, AgentInfo } from '@orca-board/core'
import type { BoardCommands, BoardCommandName } from '@orca-board/contracts'
import type { AgentSelectionServices } from './agent-selection.ts'
import type { RoleSource } from './launch-policy.ts'
import { CommandError, createProjectCommandExecutor, type ProjectCommandHost } from './project-commands.ts'
import { commandString, taskCreateFrom, taskPatchFrom } from './command-input.ts'
export { CommandError as BoardCommandError } from './project-commands.ts'

export interface BoardCommandProject {
  store: TaskStore
  roles(): RoleSource
  agents(): AgentInfo[]
}

export interface BoardCommandHost extends ProjectCommandHost<BoardCommandProject, BoardCommandName> {
  selection: AgentSelectionServices
}

/** Каждая команда адресуется явно; host проверяет доступ прежде, чем откроется доска. */
export function createBoardCommands(host: BoardCommandHost): BoardCommands {
  const execute = createProjectCommandExecutor(host)

  function existing(project: BoardCommandProject, taskId: string): TaskStore {
    if (!project.store.getTask(taskId)) throw new CommandError('command.taskNotFound', { taskId })
    return project.store
  }

  return {
    get: context => execute(context, 'board.get', () => project => project.store.snapshot()),
    createTask: (context, raw) => execute(context, 'tasks.create', () => {
      const input = taskCreateFrom(raw)
      return project => {
        const role = host.selection.pickRole(project.roles(), project.agents(), input.roleId)
        return project.store.createTask({ ...input, roleId: role.id, agent: role.agent })
      }
    }),
    updateTask: (context, id, raw) => execute(context, 'tasks.update', () => {
      const taskId = commandString(id, 'taskId')
      const patch = taskPatchFrom(raw)
      return project => existing(project, taskId).editTask(taskId, patch)
    }),
    moveTask: (context, id, raw) => execute(context, 'tasks.move', () => {
      const taskId = commandString(id, 'taskId')
      const status = commandString(raw, 'status')
      return project => existing(project, taskId).moveTask(taskId, status)
    }),
    removeTask: (context, id) => execute(context, 'tasks.remove', () => {
      const taskId = commandString(id, 'taskId')
      return project => existing(project, taskId).deleteTask(taskId)
    })
  }
}
