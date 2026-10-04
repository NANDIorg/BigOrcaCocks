import { isTaskPriority, validateAttachments } from '@orca-board/core'
import type { TaskCreateInput, TaskPatch } from '@orca-board/contracts'
import { CommandError } from './project-commands.ts'

export function commandInputError(field: string): never { throw new CommandError('command.invalidInput', { field }) }

export function commandDimensionsFrom(input: Record<string, unknown>): { cols?: number; rows?: number } {
  const size = (raw: unknown, field: string): number | undefined => {
    if (raw === undefined) return undefined
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) commandInputError(field)
    return raw
  }
  return { cols: size(input.cols, 'cols'), rows: size(input.rows, 'rows') }
}

export function commandAttachmentsFrom(raw: unknown) {
  try {
    // Core map не посещает holes; на transport границе они равнозначны отсутствующим bytes.
    if (Array.isArray(raw)) for (let i = 0; i < raw.length; i++) if (!(i in raw)) commandInputError('images')
    return validateAttachments(raw)
  } catch (error) {
    if (error instanceof CommandError) throw error
    throw new CommandError('command.invalidInput', { field: 'images' }, error)
  }
}

export function commandString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim()) commandInputError(field)
  return raw
}

export function commandFields(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) commandInputError('input')
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) if (!allowed.includes(key)) commandInputError(key)
  return input
}

export function taskPatchFrom(raw: unknown): TaskPatch {
  const input = commandFields(raw, ['title', 'spec', 'priority'])
  const patch: TaskPatch = {}
  if (input.title !== undefined) patch.title = commandString(input.title, 'title')
  if (input.spec !== undefined) {
    if (typeof input.spec !== 'string') commandInputError('spec')
    patch.spec = input.spec
  }
  if (input.priority !== undefined) {
    if (!isTaskPriority(input.priority)) commandInputError('priority')
    patch.priority = input.priority
  }
  return patch
}

export function taskCreateFrom(raw: unknown): TaskCreateInput {
  const input = commandFields(raw, ['title', 'spec', 'priority', 'roleId', 'deps'])
  const result: TaskCreateInput = { title: commandString(input.title, 'title'),
    ...taskPatchFrom({ title: input.title, spec: input.spec, priority: input.priority }) }
  if (input.roleId !== undefined) result.roleId = commandString(input.roleId, 'roleId')
  if (input.deps !== undefined) {
    if (!Array.isArray(input.deps)) commandInputError('deps')
    // Array.from посещает holes: every на исходном sparse массиве пропускает недостающие элементы.
    result.deps = Array.from(input.deps, item => commandString(item, 'deps'))
  }
  return result
}
