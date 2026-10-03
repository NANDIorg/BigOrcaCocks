import { isTaskPriority, withStatusSource, type TaskStore, type AgentInfo, type StatusSource } from '@orca-board/core'
import type {
  BoardCommands, BoardCommandName, BoardCommandErrorCode, BoardCommandErrorData,
  ProjectCommandContext, TaskCreateInput, TaskPatch
} from '@orca-board/contracts'
import type { AgentSelectionServices } from './agent-selection.ts'
import type { RoleSource } from './launch-policy.ts'

const messages: Record<BoardCommandErrorCode, string> = {
  'command.invalidContext': 'Невалидный контекст команды',
  'command.forbidden': 'Нет доступа к команде',
  'command.invalidInput': 'Невалидные параметры команды',
  'command.projectNotFound': 'Проект не найден',
  'command.taskNotFound': 'Задача не найдена',
  'command.rejected': 'Команда не выполнена'
}

export class BoardCommandError extends Error implements BoardCommandErrorData {
  readonly code: BoardCommandErrorCode
  readonly details: BoardCommandErrorData['details']

  constructor(code: BoardCommandErrorCode, details: BoardCommandErrorData['details'] = {}, cause?: unknown) {
    super(`${messages[code]}${details.reason ? `: ${details.reason}` : ''}`, { cause })
    this.name = 'BoardCommandError'
    this.code = code
    this.details = { ...details }
  }

  toJSON(): BoardCommandErrorData {
    return { code: this.code, details: { ...this.details } }
  }
}

export interface BoardCommandProject {
  store: TaskStore
  roles(): RoleSource
  agents(): AgentInfo[]
}

export interface BoardCommandHost {
  project(id: string): BoardCommandProject | undefined
  authorize(context: ProjectCommandContext, command: BoardCommandName): boolean
  selection: AgentSelectionServices
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function contextFrom(raw: unknown): ProjectCommandContext {
  if (!object(raw) || !nonempty(raw.projectId) || !nonempty(raw.clientId) || !object(raw.actor)
    || !nonempty(raw.actor.id) || (raw.actor.kind !== 'operator' && raw.actor.kind !== 'agent' && raw.actor.kind !== 'system')) {
    throw new BoardCommandError('command.invalidContext')
  }
  return { projectId: raw.projectId, clientId: raw.clientId,
    actor: { kind: raw.actor.kind, id: raw.actor.id } }
}

function inputError(field: string): never {
  throw new BoardCommandError('command.invalidInput', { field })
}

function fields(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!object(raw)) inputError('input')
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) inputError(key)
  return raw
}

function patchFrom(raw: unknown): TaskPatch {
  const input = fields(raw, ['title', 'spec', 'priority'])
  const patch: TaskPatch = {}
  if (input.title !== undefined) {
    if (!nonempty(input.title)) inputError('title')
    patch.title = input.title
  }
  if (input.spec !== undefined) {
    if (typeof input.spec !== 'string') inputError('spec')
    patch.spec = input.spec
  }
  if (input.priority !== undefined) {
    if (!isTaskPriority(input.priority)) inputError('priority')
    patch.priority = input.priority
  }
  return patch
}

function createFrom(raw: unknown): TaskCreateInput {
  const input = fields(raw, ['title', 'spec', 'priority', 'roleId', 'deps'])
  if (!nonempty(input.title)) inputError('title')
  const result: TaskCreateInput = { title: input.title, ...patchFrom({ title: input.title, spec: input.spec, priority: input.priority }) }
  if (input.roleId !== undefined) {
    if (!nonempty(input.roleId)) inputError('roleId')
    result.roleId = input.roleId
  }
  if (input.deps !== undefined) {
    if (!Array.isArray(input.deps) || !input.deps.every(nonempty)) inputError('deps')
    result.deps = [...input.deps]
  }
  return result
}

/** Каждая команда адресуется явно; host проверяет доступ прежде, чем откроется доска. */
export function createBoardCommands(host: BoardCommandHost): BoardCommands {
  function execute<T>(raw: unknown, command: BoardCommandName, validate: () => (project: BoardCommandProject) => T): T {
    try {
      const context = contextFrom(raw)
      // Отделённая копия исключает подмену проекта/attribution внутри host callback.
      if (host.authorize(structuredClone(context), command) !== true) throw new BoardCommandError('command.forbidden')
      const operation = validate()
      const project = host.project(context.projectId)
      if (!project) throw new BoardCommandError('command.projectNotFound', { projectId: context.projectId })
      const source: StatusSource = context.actor.kind === 'operator' ? 'human' : context.actor.kind === 'agent' ? 'cli' : 'app'
      return withStatusSource(source, () => structuredClone(operation(project)))
    } catch (error) {
      if (error instanceof BoardCommandError) throw error
      throw new BoardCommandError('command.rejected', { reason: error instanceof Error ? error.message : String(error) }, error)
    }
  }

  function taskIdFrom(raw: unknown): string {
    if (!nonempty(raw)) inputError('taskId')
    return raw
  }

  function existing(project: BoardCommandProject, taskId: string): TaskStore {
    if (!project.store.getTask(taskId)) throw new BoardCommandError('command.taskNotFound', { taskId })
    return project.store
  }

  return {
    get: context => execute(context, 'board.get', () => project => project.store.snapshot()),
    createTask: (context, raw) => execute(context, 'tasks.create', () => {
      const input = createFrom(raw)
      return project => {
        const role = host.selection.pickRole(project.roles(), project.agents(), input.roleId)
        return project.store.createTask({ ...input, roleId: role.id, agent: role.agent })
      }
    }),
    updateTask: (context, id, raw) => execute(context, 'tasks.update', () => {
      const taskId = taskIdFrom(id)
      const patch = patchFrom(raw)
      return project => existing(project, taskId).editTask(taskId, patch)
    }),
    moveTask: (context, id, raw) => execute(context, 'tasks.move', () => {
      const taskId = taskIdFrom(id)
      if (!nonempty(raw)) inputError('status')
      return project => existing(project, taskId).moveTask(taskId, raw)
    }),
    removeTask: (context, id) => execute(context, 'tasks.remove', () => {
      const taskId = taskIdFrom(id)
      return project => existing(project, taskId).deleteTask(taskId)
    })
  }
}
