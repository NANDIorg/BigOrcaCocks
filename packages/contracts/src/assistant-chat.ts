import type { AgentKind } from '@orca-board/core'
import type { ConversationMessage, ConversationStatus, ConversationToolCall, ConversationInteraction } from './conversation.ts'

// ---------- Чат-режим ассистента (docs/assistant-chat.md) ----------
//
// Модель сообщений канала `assistantChat` (`OrcaApi` выше) — панель ассистента как чат поверх того же PTY.
// Разбор транскрипта в эти типы — `main/assistant-chat.ts`, IPC — `registerIpc` в `main/index.ts`,
// мост — `preload/index.ts`. Настройки приложения/проекта из `docs/assistant-chat.md` → «1–2» в этот канал
// не входят: они остаются в общих методах `settings`/`types`/`roles`/`node-templates`/`project rules`.

/** Нормализованный поток ассистента. Старый парсер транскриптов использует эти же типы. */
export type AssistantChatRole = ConversationMessage['role']

export type AssistantChatStatus = ConversationStatus

export type AssistantChatToolCall = ConversationToolCall

export interface AssistantChatMessage extends ConversationMessage { hasImage?: boolean }

export interface AssistantChatSnapshot {
  ptyId: string
  messages: AssistantChatMessage[]
  status: AssistantChatStatus
  protocolVersion?: 2
  revision?: number
  agent?: AgentKind
  transport?: 'chat' | 'terminal'
  interactions?: ConversationInteraction[]
  error?: string
}

export type AssistantChatUpdate = { ptyId: string; revision?: number } & (
  | { message: AssistantChatMessage }
  | { status: AssistantChatStatus; error?: string }
  | { interaction: ConversationInteraction }
  | { resolvedRequestId: string }
)
