import type { OperatorMetadata } from '@orca-board/contracts'

export class OperatorProtocolError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = 'OperatorProtocolError'; this.code = code }
}
export function protocolError(code: string, message: string): never { throw new OperatorProtocolError(code, message) }
export const protocolObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export function protocolText(value: unknown, field: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) protocolError('protocol.invalidInput', `Некорректное поле ${field}`)
  return value
}
/** Product version не является версией протокола; peer не получает capabilities, которых нет у host. */
export function assertOperatorHello(raw: unknown, metadata: OperatorMetadata): OperatorMetadata {
  if (!protocolObject(raw) || Object.keys(raw).some(k => !['protocolMajor', 'schemaVersion', 'product', 'requiredCapabilities'].includes(k))) protocolError('protocol.invalidInput', 'Некорректное рукопожатие')
  if (raw.protocolMajor !== metadata.protocolMajor) protocolError('protocol.incompatible', 'Несовместимая версия operator protocol')
  if (raw.schemaVersion !== metadata.schemaVersion) protocolError('protocol.incompatible', 'Несовместимая версия схемы; обновите клиент')
  if (!protocolObject(raw.product) || Object.keys(raw.product).some(k => !['name', 'version'].includes(k))) protocolError('protocol.invalidInput', 'Некорректный продукт клиента')
  protocolText(raw.product.name, 'product.name'); protocolText(raw.product.version, 'product.version')
  if (raw.requiredCapabilities !== undefined) {
    if (!Array.isArray(raw.requiredCapabilities) || raw.requiredCapabilities.length > 64) protocolError('protocol.invalidInput', 'Некорректные capabilities')
    for (const capability of raw.requiredCapabilities) {
      const name = protocolText(capability, 'capability')
      if (!metadata.capabilities.includes(name)) protocolError('protocol.capabilityMissing', `Host не поддерживает capability ${name}`)
    }
  }
  return structuredClone(metadata)
}
