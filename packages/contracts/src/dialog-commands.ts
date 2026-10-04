import type { AssistantSettings } from '@orca-board/core'
import type { ClientCommandContext } from './project-commands.ts'
import type { DialogRecord, DialogSnapshot } from './dialogs.ts'
import type { InteractionAnswer } from './conversation.ts'

export interface DialogCreateInput {
  projectId?: string
  settings?: Partial<AssistantSettings>
}
export interface DialogCommands {
  create(context: ClientCommandContext, input?: DialogCreateInput): string
  list(context: ClientCommandContext, projectId?: string): DialogRecord[]
  snapshot(context: ClientCommandContext, id: string): DialogSnapshot
  send(context: ClientCommandContext, id: string, text: string, workflowContext?: string): Promise<void>
  interrupt(context: ClientCommandContext, id: string): Promise<void>
  respond(context: ClientCommandContext, id: string, requestId: string, answer: InteractionAnswer): Promise<void>
  stop(context: ClientCommandContext, id: string): void
}
export type DialogCommandName = `dialogs.${keyof DialogCommands}`
