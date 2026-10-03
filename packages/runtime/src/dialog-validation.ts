import { isAgentKind } from '@orca-board/core'
import { CONVERSATION_MESSAGE_LIMIT } from '@orca-board/contracts'
import type { DialogRecord } from '@orca-board/contracts'

export class DialogRepositoryError extends Error {
  readonly code: 'dialog.invalid' | 'dialog.schemaUnsupported' | 'dialog.conflict'
  constructor(code: DialogRepositoryError['code'], message: string) {
    super(message)
    this.name = 'DialogRepositoryError'
    this.code = code
  }
}

export interface DialogDocument extends Record<string, unknown> {
  schemaVersion: 1
  dialogs: DialogRecord[]
}

type Check = (value: unknown) => boolean
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const string: Check = value => typeof value === 'string'
const id: Check = value => typeof value === 'string' && value.trim().length > 0
const integer: Check = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const boolean: Check = value => typeof value === 'boolean'
const optional = (check: Check): Check => value => value === undefined || check(value)
const oneOf = (...values: string[]): Check => value => typeof value === 'string' && values.includes(value)
const array = (check: Check, limit = Infinity): Check => value => Array.isArray(value) && value.length <= limit && value.every(check)
const fields = (checks: Record<string, Check>): Check => value => object(value) && Object.entries(checks).every(([key, check]) => check(value[key]))

const tool = fields({ id: optional(id), name: string, input: string, status: oneOf('running', 'ok', 'error', 'cancelled') })
const message = fields({ id, role: oneOf('human', 'agent', 'tool'), text: string, at: integer, toolCalls: optional(array(tool)) })
const option = fields({ id, label: string, description: optional(string), kind: optional(oneOf('allow_once', 'allow_always', 'reject_once', 'reject_always')) })
const question = fields({ id, question: string, header: optional(string), options: array(option), multiSelect: boolean, allowFreeform: boolean })
const interaction = fields({
  id, kind: oneOf('permission', 'question', 'confirmation'), title: string, text: optional(string),
  tool: optional(fields({ name: string, input: string })), options: optional(array(option)), questions: optional(array(question))
})
const binding = fields({ transport: oneOf('claude-stream-json', 'codex-app-server', 'acp'), sessionId: optional(id) })
const conversationFields = fields({
  id, agent: value => typeof value === 'string' && isAgentKind(value),
  status: oneOf('starting', 'thinking', 'waiting', 'done', 'interrupted', 'error'),
  messages: array(message, CONVERSATION_MESSAGE_LIMIT), interactions: array(interaction),
  providerBinding: optional(binding), error: optional(string)
})
const conversation: Check = value => {
  if (!object(value) || !conversationFields(value)) return false
  if (value.providerBinding === undefined) return true
  if (!object(value.providerBinding)) return false
  // Terminal-only agents не имеют structured provider session.
  if (value.agent === 'amp' || value.agent === 'shell') return false
  const transport = value.agent === 'claude' ? 'claude-stream-json' : value.agent === 'codex' ? 'codex-app-server' : 'acp'
  return value.providerBinding.transport === transport
}
const dialog = fields({ id, projectId: optional(id), createdAt: integer, updatedAt: integer, revision: integer, conversation })

export function assertDialogRecord(value: unknown): asserts value is DialogRecord {
  if (!dialog(value)) throw new DialogRepositoryError('dialog.invalid', 'Невалидная запись диалога')
}

/** Проверяем весь документ: пропуск одного плохого record при следующем save потерял бы историю. */
export function assertDialogDocument(value: unknown): asserts value is DialogDocument {
  if (!object(value) || !integer(value.schemaVersion)) throw new DialogRepositoryError('dialog.invalid', 'Невалидный формат истории диалогов')
  if (value.schemaVersion !== 1) throw new DialogRepositoryError('dialog.schemaUnsupported', 'Версия истории диалогов не поддерживается')
  if (!Array.isArray(value.dialogs)) throw new DialogRepositoryError('dialog.invalid', 'Невалидный список диалогов')
  const ids = new Set<string>()
  for (const record of value.dialogs) {
    assertDialogRecord(record)
    if (ids.has(record.id)) throw new DialogRepositoryError('dialog.invalid', 'Повтор id в истории диалогов')
    ids.add(record.id)
  }
}
