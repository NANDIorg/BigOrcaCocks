import { withStatusSource, type StatusSource } from '@orca-board/core'
import type { CommandErrorCode, CommandErrorData, ProjectCommandContext } from '@orca-board/contracts'

const messages: Record<CommandErrorCode, string> = {
  'command.invalidContext': 'Невалидный контекст команды',
  'command.forbidden': 'Нет доступа к команде',
  'command.invalidInput': 'Невалидные параметры команды',
  'command.projectNotFound': 'Проект не найден',
  'command.taskNotFound': 'Задача не найдена',
  'command.globalTaskNotFound': 'Глобальная задача не найдена',
  'command.requestNotFound': 'Запрос не найден',
  'command.questionNotFound': 'Вопрос не найден',
  'command.rejected': 'Команда не выполнена'
}

export class CommandError extends Error implements CommandErrorData {
  readonly code: CommandErrorCode
  readonly details: CommandErrorData['details']

  constructor(code: CommandErrorCode, details: CommandErrorData['details'] = {}, cause?: unknown) {
    super(`${messages[code]}${details.reason ? `: ${details.reason}` : ''}`, { cause })
    this.name = 'CommandError'
    this.code = code
    this.details = { ...details }
  }

  toJSON(): CommandErrorData { return { code: this.code, details: { ...this.details } } }
}

export interface ProjectCommandHost<Project, Name extends string> {
  project(id: string): Project | undefined
  authorize(context: ProjectCommandContext, command: Name): boolean
}

function contextFrom(raw: unknown): ProjectCommandContext {
  const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new CommandError('command.invalidContext')
  const value = raw as Record<string, unknown>
  if (!nonempty(value.projectId) || !nonempty(value.clientId) || typeof value.actor !== 'object'
    || value.actor === null || Array.isArray(value.actor)) throw new CommandError('command.invalidContext')
  const actor = value.actor as Record<string, unknown>
  if (!nonempty(actor.id) || (actor.kind !== 'operator' && actor.kind !== 'agent' && actor.kind !== 'system')) {
    throw new CommandError('command.invalidContext')
  }
  return { projectId: value.projectId, clientId: value.clientId, actor: { kind: actor.kind, id: actor.id } }
}

/** Синхронная граница: проверенный context и policy предшествуют payload, lookup и любым эффектам. */
export function createProjectCommandExecutor<Project, Name extends string>(host: ProjectCommandHost<Project, Name>) {
  return function execute<T>(raw: unknown, command: Name, validate: () => (project: Project, context: ProjectCommandContext) => T): T {
    try {
      const context = contextFrom(raw)
      if (host.authorize(structuredClone(context), command) !== true) throw new CommandError('command.forbidden')
      const operation = validate()
      const project = host.project(context.projectId)
      if (!project) throw new CommandError('command.projectNotFound', { projectId: context.projectId })
      const source: StatusSource = context.actor.kind === 'operator' ? 'human' : context.actor.kind === 'agent' ? 'cli' : 'app'
      return withStatusSource(source, () => structuredClone(operation(project, context)))
    } catch (error) {
      if (error instanceof CommandError) throw error
      throw new CommandError('command.rejected', { reason: error instanceof Error ? error.message : String(error) }, error)
    }
  }
}
