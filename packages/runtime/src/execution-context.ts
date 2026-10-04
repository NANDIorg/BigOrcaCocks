import type { StatusSource, TaskStore } from '@orca-board/core'
import type { EffectProject } from './effect-scope.ts'
import { CommandError } from './project-commands.ts'

/** Контекст доверенного host: автор из входного DTO здесь не принимается. */
export interface ExecutionContext {
  projectId?: string
  isCurrent?: () => boolean
  source?: StatusSource
}
export function executionSource(kind: 'operator' | 'agent' | 'system'): StatusSource {
  return kind === 'operator' ? 'human' : kind === 'agent' ? 'cli' : 'app'
}
export function executionContext(context: ExecutionContext): ExecutionContext {
  return { ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
    ...(context.isCurrent === undefined ? {} : { isCurrent: context.isCurrent }),
    ...(context.source === undefined ? {} : { source: context.source }) }
}
export function executionProject(store: TaskStore, root: string, context: ExecutionContext = {}): EffectProject {
  return { id: context.projectId ?? root, root, store, isCurrent: context.isCurrent }
}
export function obsoleteEffect(error: unknown): boolean {
  return error instanceof CommandError && (error.code === 'command.stale' || error.code === 'command.forbidden')
}

/** Доверенный host может иметь синхронный тестовый launcher; оркестрация всегда ожидает результат. */
export type ExecutionMethods<T> = { [Key in keyof T]: T[Key] extends (...args: infer Args) => infer Result
  ? (...args: Args) => Result | Awaited<Result> : T[Key] }
