import type { ConversationSnapshot } from './conversation.ts'

/** Сохранённая история; env/credentials и process lifecycle сюда не входят. */
export interface DialogRecord {
  id: string
  projectId?: string
  createdAt: number
  updatedAt: number
  revision: number
  conversation: ConversationSnapshot
}

export interface DialogHistorySnapshot {
  dialog: DialogRecord
  readOnly: true
  requiresNewConversation: true
}

/** Старый permission/tool нельзя продолжить чтением файла: процесс и turn уже не живы. */
export function dialogHistory(record: DialogRecord): DialogHistorySnapshot {
  const dialog = JSON.parse(JSON.stringify(record)) as DialogRecord
  const conversation = dialog.conversation
  if (conversation.status === 'starting' || conversation.status === 'thinking' || conversation.status === 'waiting') conversation.status = 'interrupted'
  conversation.interactions = []
  for (const message of conversation.messages) for (const tool of message.toolCalls ?? []) if (tool.status === 'running') tool.status = 'cancelled'
  return { dialog, readOnly: true, requiresNewConversation: true }
}
