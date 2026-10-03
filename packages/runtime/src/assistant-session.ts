import type { AgentKind, AssistantSettings } from '@orca-board/core'
import type { ConversationUpdate, InteractionAnswer, AssistantChatSnapshot, AssistantChatUpdate } from '@orca-board/contracts'
import type { AssistantConversation } from './assistant-conversation-types.ts'
import type { DialogRepository } from './dialog-repository.ts'
import { DialogRegistry } from './dialog-registry.ts'
import type { DialogRegistryUpdate, DialogSnapshot } from './dialog-registry.ts'

export interface AssistantSessionDependencies {
  errors: { unknownPty(): Error; emptyText(): Error; readOnly?(): Error; storage?(error: unknown): Error; historyLoad?(error: unknown): Error }
  repository?: DialogRepository
  onError?(error: Error): void
  settings(): AssistantSettings
  assertUsable(agent: AgentKind): void
  create(settings: AssistantSettings, onUpdate: (update: ConversationUpdate) => void): AssistantConversation
  startTerminal(settings: AssistantSettings, cols: number, rows: number, onExit: (id: string) => void): string
  isAlive(id: string): boolean
  killTerminal(id: string): void
  onUpdate(update: AssistantChatUpdate): void
}
function chatSnapshot(snapshot: DialogSnapshot): AssistantChatSnapshot {
  return { ...snapshot.dialog.conversation, ptyId: snapshot.dialog.id, protocolVersion: 2, revision: snapshot.dialog.revision, transport: 'chat',
    ...(snapshot.storageFailed ? { storageFailed: true } as const : {}),
    ...(snapshot.readOnly ? { readOnly: true, requiresNewConversation: true } as const : {}) }
}

/** Адаптер одного выбранного Desktop диалога; structured lifecycle принадлежит реестру. */
export class AssistantSession {
  private selected: string | null = null
  private unsubscribe: (() => void) | undefined
  private terminal: { id: string; agent: AgentKind } | null = null
  private readonly registry: DialogRegistry
  private readonly deps: AssistantSessionDependencies
  constructor(deps: AssistantSessionDependencies) {
    this.deps = deps
    this.registry = new DialogRegistry({ repository: deps.repository, create: deps.create, onError: deps.onError, errors: {
      unknown: deps.errors.unknownPty, emptyText: deps.errors.emptyText,
      load: deps.errors.historyLoad,
      readOnly: deps.errors.readOnly ?? (() => new Error('Сохранённый диалог доступен только для чтения. Начните новый диалог.')),
      storage: deps.errors.storage ?? (error => error instanceof Error ? error : new Error(String(error)))
    } })
  }
  private select(id: string): { ptyId: string } {
    this.selected = id
    this.unsubscribe = this.registry.subscribe(id, (event: DialogRegistryUpdate) => {
      if (this.selected !== id) return
      const update = event.update
      const base = { ptyId: id, revision: event.revision,
        ...(event.readOnly ? { readOnly: true, requiresNewConversation: true, snapshot: event.snapshot ? chatSnapshot(event.snapshot) : undefined } as const : {}) }
      const message: AssistantChatUpdate = update.type === 'message' ? { ...base, message: update.message }
        : update.type === 'state' ? { ...base, status: update.status, error: update.error }
        : update.type === 'interaction' ? { ...base, interaction: update.interaction }
        : { ...base, resolvedRequestId: update.requestId }
      this.deps.onUpdate(message)
    })
    return { ptyId: id }
  }
  open(cols: number, rows: number, reset: boolean): { ptyId: string } {
    if (!reset && this.selected) return { ptyId: this.selected }
    if (!reset && this.terminal && this.deps.isAlive(this.terminal.id)) return { ptyId: this.terminal.id }
    if (!reset && this.deps.repository) {
      const previous = this.registry.latest()
      if (previous) { this.clearSelection(); return this.select(previous.id) }
    }
    const settings = this.deps.settings()
    this.deps.assertUsable(settings.agent)
    if (settings.agent === 'amp' || settings.agent === 'shell') {
      this.clearSelection()
      const id = this.deps.startTerminal(settings, cols, rows, exited => { if (this.terminal?.id === exited) this.terminal = null })
      this.terminal = { id, agent: settings.agent }
      return { ptyId: id }
    }
    // Guard и durable create нового диалога проходят ДО остановки текущего.
    const id = this.registry.create(settings)
    this.clearSelection()
    return this.select(id)
  }
  available(id: string): boolean { return this.selected === id }
  snapshot(id: string): AssistantChatSnapshot {
    if (this.selected === id) return chatSnapshot(this.registry.snapshot(id))
    if (this.terminal?.id === id) return { ptyId: id, protocolVersion: 2, revision: 0, transport: 'terminal', agent: this.terminal.agent, messages: [], status: 'done', interactions: [] }
    throw this.deps.errors.unknownPty()
  }
  private require(id: string): void { if (this.selected !== id) throw this.deps.errors.unknownPty() }
  send(id: string, text: unknown, context?: string): Promise<void> { this.require(id); return this.registry.send(id, text, context) }
  interrupt(id: string): Promise<void> { this.require(id); return this.registry.interrupt(id) }
  respond(id: string, requestId: string, answer: InteractionAnswer): Promise<void> { this.require(id); return this.registry.respond(id, requestId, answer) }
  private clearSelection(): void {
    const selected = this.selected
    const terminal = this.terminal
    this.selected = null
    this.terminal = null
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (selected) this.registry.stop(selected)
    if (terminal && this.deps.isAlive(terminal.id)) this.deps.killTerminal(terminal.id)
  }
  dispose(): void { this.clearSelection(); this.registry.dispose() }
}
