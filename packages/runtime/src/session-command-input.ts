import { commandInputError } from './command-input.ts'
import { commandString } from './profile-command-input.ts'

export function sessionDimension(raw: unknown, field: string, minimum: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum || raw > 1000) commandInputError(field)
  return raw
}
/** Legacy transport проверяет данные до auto claim; общая команда повторяет тот же guard. */
export function sessionInput(raw: unknown): string {
  const data = commandString(raw, 'data', false)
  if (Buffer.byteLength(data) > 64 * 1024) commandInputError('data')
  return data
}
