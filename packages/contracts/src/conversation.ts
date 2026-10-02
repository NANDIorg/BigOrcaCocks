import type { AgentKind } from '@orca-board/core'

export const CONVERSATION_MESSAGE_LIMIT = 300

export type ConversationStatus = 'starting' | 'thinking' | 'waiting' | 'done' | 'interrupted' | 'error'

export interface ConversationToolCall {
  id?: string
  name: string
  input: string
  status: 'running' | 'ok' | 'error' | 'cancelled'
}

export interface ConversationMessage {
  id: string
  role: 'human' | 'agent' | 'tool'
  text: string
  at: number
  toolCalls?: ConversationToolCall[]
}

export interface InteractionOption {
  id: string
  label: string
  description?: string
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export interface InteractionQuestion {
  id: string
  question: string
  header?: string
  options: InteractionOption[]
  multiSelect: boolean
  allowFreeform: boolean
}

export interface ConversationInteraction {
  id: string
  kind: 'permission' | 'question' | 'confirmation'
  title: string
  text?: string
  tool?: { name: string; input: string }
  options?: InteractionOption[]
  questions?: InteractionQuestion[]
}

export type InteractionAnswer =
  | { kind: 'option'; optionId: string }
  | { kind: 'answers'; answers: { questionId: string; optionIds: string[]; text?: string }[] }
  | { kind: 'cancel' }

export interface ConversationSnapshot {
  id: string
  agent: AgentKind
  messages: ConversationMessage[]
  status: ConversationStatus
  interactions: ConversationInteraction[]
  error?: string
}

export type ConversationUpdate =
  | { type: 'message'; message: ConversationMessage }
  | { type: 'state'; status: ConversationStatus; error?: string }
  | { type: 'interaction'; interaction: ConversationInteraction }
  | { type: 'interaction-resolved'; requestId: string }
