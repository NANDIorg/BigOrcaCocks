import type { ClientCommandContext } from './project-commands.ts'
import type { AssistantChatSnapshot } from './assistant-chat.ts'
import type { InteractionAnswer } from './conversation.ts'

/** Совместимость с одним выбранным ассистентом Desktop. Новые клиенты адресуют DialogCommands. */
export interface AssistantCommands {
  open(context: ClientCommandContext, cols: number, rows: number): { ptyId: string }
  reset(context: ClientCommandContext, cols: number, rows: number): { ptyId: string }
  available(context: ClientCommandContext, id: string): boolean
  snapshot(context: ClientCommandContext, id: string): AssistantChatSnapshot
  send(context: ClientCommandContext, id: string, text: string, workflowContext?: unknown): Promise<void>
  interrupt(context: ClientCommandContext, id: string): Promise<void>
  respond(context: ClientCommandContext, id: string, requestId: string, answer: InteractionAnswer): Promise<void>
}
export type AssistantCommandName = `assistant.${keyof AssistantCommands}`
