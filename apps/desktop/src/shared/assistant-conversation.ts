// Общий UI/contracts имеют одного владельца.
export * from '@orca-board/ui/shared/assistant-conversation'
// Provider port остаётся только у trusted Desktop host.
export type { AssistantConversation, ConversationOptions } from '@orca-board/runtime'
