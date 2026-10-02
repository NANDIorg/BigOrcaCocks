import type { AgentKind } from '@orca-board/core'
import type { ConversationSnapshot, ConversationUpdate, InteractionAnswer } from '@orca-board/contracts'
export { CONVERSATION_MESSAGE_LIMIT } from '@orca-board/contracts'
export type { ConversationStatus, ConversationToolCall, ConversationMessage, InteractionOption, InteractionQuestion, ConversationInteraction, InteractionAnswer, ConversationSnapshot, ConversationUpdate } from '@orca-board/contracts'

export interface AssistantConversation {
  readonly id: string
  snapshot(): ConversationSnapshot
  send(text: string, context?: string): Promise<void>
  interrupt(): Promise<void>
  respond(requestId: string, answer: InteractionAnswer): Promise<void>
  dispose(): void
}

export interface ConversationOptions {
  agent: AgentKind
  system: string
  model?: string
  effort?: string
  /** Флаги настроек после разбора в argv, до флагов собственного протокола. */
  extraArgs?: readonly string[]
  cwd: string
  env: Record<string, string>
  onUpdate(update: ConversationUpdate): void
}
