// Совместимые Desktop-пути DTO и host-интерфейсов диалога.
export { CONVERSATION_MESSAGE_LIMIT } from '@orca-board/contracts'
export type { ConversationStatus, ConversationToolCall, ConversationMessage, InteractionOption, InteractionQuestion, ConversationInteraction, InteractionAnswer, ConversationSnapshot, ConversationUpdate } from '@orca-board/contracts'
// Временный host-типовой bridge: только pure leaf, без Node/Electron dependency graph runtime barrel.
export type { AssistantConversation, ConversationOptions } from '../../../../packages/runtime/src/assistant-conversation-types.ts'
