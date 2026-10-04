import type { Task, Dispatch, OrcaEvent, Question, Run, HumanRequest, TaskPriority } from '@orca-board/core'
import type { TaskPatch } from './tasks.ts'
import type { ProjectCommandContext } from './project-commands.ts'
export type { ProjectCommandContext, CommandErrorCode as BoardCommandErrorCode, CommandErrorData as BoardCommandErrorData } from './project-commands.ts'

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

/** Синхронный application API владельца; сетевой client/transport оборачивает его отдельно. */
export interface BoardCommands {
  get(context: ProjectCommandContext): BoardSnapshot
  createTask(context: ProjectCommandContext, input: TaskCreateInput): Task
  updateTask(context: ProjectCommandContext, taskId: string, patch: TaskPatch): Task
  moveTask(context: ProjectCommandContext, taskId: string, status: string): Task
  removeTask(context: ProjectCommandContext, taskId: string): void
}
