import type { Task, Dispatch, OrcaEvent, Question, Run, HumanRequest, TaskPriority } from '@orca-board/core'
import type { TaskPatch } from './tasks.ts'

/** Host устанавливает автора после проверки соединения; поля JSON клиента не доказывают его полномочия. */
export interface ProjectCommandContext {
  projectId: string
  clientId: string
  actor: { kind: 'operator' | 'agent' | 'system'; id: string }
}

export interface TaskCreateInput {
  title: string
  spec?: string
  deps?: string[]
  roleId?: string
  priority?: TaskPriority
}

/** DTO отделён от mutable store и не предоставляет клиенту persistence API. */
export interface BoardSnapshot {
  tasks: Task[]
  dispatches: Dispatch[]
  events: OrcaEvent[]
  questions: Question[]
  runs: Run[]
  requests?: HumanRequest[]
  formatVersion?: number
}

export type BoardCommandName = 'board.get' | 'tasks.create' | 'tasks.update' | 'tasks.move' | 'tasks.remove'
export type BoardCommandErrorCode = 'command.invalidContext' | 'command.forbidden' | 'command.invalidInput'
  | 'command.projectNotFound' | 'command.taskNotFound' | 'command.rejected'

export interface BoardCommandErrorData {
  code: BoardCommandErrorCode
  details: { field?: string; projectId?: string; taskId?: string; reason?: string }
}

/** Синхронный application API владельца; сетевой client/transport оборачивает его отдельно. */
export interface BoardCommands {
  get(context: ProjectCommandContext): BoardSnapshot
  createTask(context: ProjectCommandContext, input: TaskCreateInput): Task
  updateTask(context: ProjectCommandContext, taskId: string, patch: TaskPatch): Task
  moveTask(context: ProjectCommandContext, taskId: string, status: string): Task
  removeTask(context: ProjectCommandContext, taskId: string): void
}
