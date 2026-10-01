import type { AgentKind, AssistantSettings } from '@orca-board/core'
import type { AssistantConversation, ConversationUpdate, InteractionAnswer } from '../shared/assistant-conversation'
import type { AssistantChatSnapshot, AssistantChatUpdate } from '../shared/ipc'
import { OrcaError } from './i18n'

interface Dependencies {
  settings(): AssistantSettings
  assertUsable(agent: AgentKind): void
  create(settings: AssistantSettings, onUpdate: (update: ConversationUpdate) => void): AssistantConversation
  startTerminal(settings: AssistantSettings, cols: number, rows: number, onExit: (id: string) => void): string
  isAlive(id: string): boolean
  killTerminal(id: string): void
  onUpdate(update: AssistantChatUpdate): void
}

/** Одна сессия приложения; старый процесс не может публиковать события в новый диалог. */
export class AssistantSession {
  private conversation: AssistantConversation | null = null
  private terminal: { id: string; agent: AgentKind } | null = null
  private revision = 0
  private readonly deps: Dependencies
  constructor(deps: Dependencies) { this.deps = deps }

  open(cols: number, rows: number, reset: boolean): { ptyId: string } {
    if (!reset && this.conversation) return { ptyId: this.conversation.id }
    if (!reset && this.terminal && this.deps.isAlive(this.terminal.id)) return { ptyId: this.terminal.id }
    const settings = this.deps.settings()
    // Отсутствующий новый CLI не уничтожает старый рабочий диалог.
    this.deps.assertUsable(settings.agent)
    this.dispose()
    this.revision = 0
    if (settings.agent === 'amp' || settings.agent === 'shell') {
      const id = this.deps.startTerminal(settings, cols, rows, (exited) => { if (this.terminal?.id === exited) this.terminal = null })
      this.terminal = { id, agent: settings.agent }
      return { ptyId: id }
    }
    let conversation: AssistantConversation | undefined
    conversation = this.deps.create(settings, (update) => {
      if (!conversation || this.conversation !== conversation) return
      const base = { ptyId: conversation.id, revision: ++this.revision }
      const event: AssistantChatUpdate = update.type === 'message' ? { ...base, message: update.message }
        : update.type === 'state' ? { ...base, status: update.status, error: update.error }
        : update.type === 'interaction' ? { ...base, interaction: update.interaction }
        : { ...base, resolvedRequestId: update.requestId }
      this.deps.onUpdate(event)
    })
    this.conversation = conversation
    return { ptyId: conversation.id }
  }

  available(id: string): boolean { return this.conversation?.id === id }
  snapshot(id: string): AssistantChatSnapshot {
    if (this.conversation?.id === id) return { ...this.conversation.snapshot(), ptyId: id, protocolVersion: 2, revision: this.revision, transport: 'chat' }
    if (this.terminal?.id === id) return { ptyId: id, protocolVersion: 2, revision: 0, transport: 'terminal', agent: this.terminal.agent, messages: [], status: 'done', interactions: [] }
    throw new OrcaError('assistantChat.unknownPty')
  }
  private require(id: string): AssistantConversation {
    if (!this.conversation || this.conversation.id !== id) throw new OrcaError('assistantChat.unknownPty')
    return this.conversation
  }
  send(id: string, text: unknown, context?: string): Promise<void> {
    const conversation = this.require(id)
    if (typeof text !== 'string' || !text.trim()) throw new OrcaError('assistantChat.emptyText')
    return conversation.send(text, context)
  }
  interrupt(id: string): Promise<void> { return this.require(id).interrupt() }
  respond(id: string, requestId: string, answer: InteractionAnswer): Promise<void> { return this.require(id).respond(requestId, answer) }
  dispose(): void {
    const conversation = this.conversation
    const terminal = this.terminal
    this.conversation = null
    this.terminal = null
    conversation?.dispose()
    if (terminal && this.deps.isAlive(terminal.id)) this.deps.killTerminal(terminal.id)
  }
}
