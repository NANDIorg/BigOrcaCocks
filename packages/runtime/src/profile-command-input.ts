import { CommandError } from './project-commands.ts'

export function invalidCommandField(field: string): never { throw new CommandError('command.invalidInput', { field }) }

/** Payload — данные, а не экземпляр класса/объект с наследуемыми управляющими полями. */
export function commandObject(raw: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
    || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
    || Object.keys(raw).some(key => !keys.includes(key))) return invalidCommandField(field)
  return structuredClone(raw) as Record<string, unknown>
}

export function commandString(raw: unknown, field: string, nonempty = true): string {
  if (typeof raw !== 'string' || (nonempty && !raw.trim())) return invalidCommandField(field)
  return raw
}
export function commandOptionalString(raw: unknown, field: string, nonempty = true): string | undefined {
  return raw === undefined ? undefined : commandString(raw, field, nonempty)
}
export function commandBoolean(raw: unknown, field: string): boolean {
  if (typeof raw !== 'boolean') return invalidCommandField(field)
  return raw
}
export function commandArray<T>(raw: unknown, field: string, item: (value: unknown, field: string) => T): T[] {
  if (!Array.isArray(raw)) return invalidCommandField(field)
  const result: T[] = []
  for (let i = 0; i < raw.length; i++) {
    if (!Object.hasOwn(raw, i)) return invalidCommandField(field)
    result.push(item(raw[i], `${field}[${i}]`))
  }
  return result
}
