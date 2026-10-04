import { withStatusSource, type StatusSource } from '@orca-board/core'
import type { ProjectCommandContext } from '@orca-board/contracts'
import { CommandError, projectCommandContextFrom, type ProjectCommandHost } from './project-commands.ts'

export interface AsyncProjectCommandHost<Project, Name extends string> extends ProjectCommandHost<Project, Name> {
  /** Проверяет захваченную identity без создания нового store. */
  isCurrent(project: Project, context: ProjectCommandContext): boolean
}
export interface AsyncCommandScope {
  isCurrent(): boolean
  guard(): void
  /** Только синхронные изменения после повторной проверки ownership/policy. */
  commit<T>(operation: () => T): T
}

export function createAsyncProjectCommandExecutor<Project, Name extends string>(host: AsyncProjectCommandHost<Project, Name>) {
  return async function execute<T>(raw: unknown, command: Name,
    validate: () => (project: Project, context: ProjectCommandContext, scope: AsyncCommandScope) => T | Promise<T>): Promise<T> {
    try {
      const context = projectCommandContextFrom(raw)
      const allowed = () => host.authorize(structuredClone(context), command) === true
      if (!allowed()) throw new CommandError('command.forbidden')
      const operation = validate()
      const project = host.project(context.projectId)
      if (!project) throw new CommandError('command.projectNotFound', { projectId: context.projectId })
      const current = () => host.isCurrent(project, structuredClone(context)) === true
      const assertCurrent = () => {
        if (!allowed()) throw new CommandError('command.forbidden')
        if (!current()) throw new CommandError('command.stale', { projectId: context.projectId })
      }
      const source: StatusSource = context.actor.kind === 'operator' ? 'human' : context.actor.kind === 'agent' ? 'cli' : 'app'
      const scope: AsyncCommandScope = { isCurrent: () => current() && allowed(), guard: assertCurrent, commit: operation => {
        assertCurrent(); return withStatusSource(source, operation)
      } }
      assertCurrent()
      const result = await operation(project, context, scope)
      assertCurrent()
      return structuredClone(result)
    } catch (error) {
      if (error instanceof CommandError) throw error
      throw new CommandError('command.rejected', { reason: error instanceof Error ? error.message : String(error) }, error)
    }
  }
}
