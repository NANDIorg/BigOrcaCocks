import type { AssistantCommands, AssistantCommandName } from '@orca-board/contracts'
import { createClientCommandExecutor, type ClientCommandHost } from './project-commands.ts'
import { createAsyncClientCommandExecutor } from './async-client-commands.ts'
import { commandString } from './profile-command-input.ts'
import { conversationDimension, conversationText, interactionAnswer } from './conversation-command-input.ts'
import type { AssistantSession } from './assistant-session.ts'

export interface AssistantCommandHost extends ClientCommandHost<AssistantCommandName> {
  session: Pick<AssistantSession, 'open' | 'available' | 'snapshot' | 'send' | 'interrupt' | 'respond'>
  buildWorkflowContext(raw: unknown): string
}
export function createAssistantCommands(host: AssistantCommandHost): AssistantCommands {
  const execute = createClientCommandExecutor(host)
  const asyncExecute = createAsyncClientCommandExecutor(host)
  const open: AssistantCommands['open'] = (ctx, cols, rows) => execute(ctx, 'assistant.open', () => {
    const width = conversationDimension(cols, 'cols', 2); const height = conversationDimension(rows, 'rows', 1)
    return () => host.session.open(width, height, false)
  })
  return {
    open,
    reset: (ctx, cols, rows) => execute(ctx, 'assistant.reset', () => {
      const width = conversationDimension(cols, 'cols', 2); const height = conversationDimension(rows, 'rows', 1)
      return () => host.session.open(width, height, true)
    }),
    available: (ctx, raw) => execute(ctx, 'assistant.available', () => { const id = commandString(raw, 'id'); return () => host.session.available(id) }),
    snapshot: (ctx, raw) => execute(ctx, 'assistant.snapshot', () => { const id = commandString(raw, 'id'); return () => host.session.snapshot(id) }),
    send: (ctx, rawId, rawText, rawContext) => asyncExecute(ctx, 'assistant.send', () => {
      const id = commandString(rawId, 'id'); const text = conversationText(rawText)
      return () => host.session.send(id, text, rawContext === undefined ? undefined : host.buildWorkflowContext(rawContext))
    }),
    interrupt: (ctx, raw) => asyncExecute(ctx, 'assistant.interrupt', () => { const id = commandString(raw, 'id'); return () => host.session.interrupt(id) }),
    respond: (ctx, rawId, rawRequest, rawAnswer) => asyncExecute(ctx, 'assistant.respond', () => {
      const id = commandString(rawId, 'id'); const request = commandString(rawRequest, 'requestId'); const answer = interactionAnswer(rawAnswer)
      return () => host.session.respond(id, request, answer)
    })
  }
}
