import { CONVERSATION_MESSAGE_LIMIT } from '../../shared/assistant-conversation'
import type { AssistantChatMessage, AssistantChatSnapshot, AssistantChatUpdate, OrcaApi } from '../../shared/ipc'

export interface ChatState extends AssistantChatSnapshot {
  revision: number
  interactions: NonNullable<AssistantChatSnapshot['interactions']>
}

export function emptyChatState(ptyId = ''): ChatState {
  return { ptyId, messages: [], status: 'starting', interactions: [], revision: -1 }
}

export function chatStateFromSnapshot(snapshot: AssistantChatSnapshot): ChatState {
  return { ...snapshot, revision: snapshot.revision ?? -1, interactions: snapshot.interactions ?? [] }
}

/** Ревизия исключает откат свежего текста событиями, уже включёнными в снимок. */
export function applyChatUpdate(state: ChatState, update: AssistantChatUpdate): ChatState {
  if (update.ptyId !== state.ptyId || (update.revision !== undefined && update.revision <= state.revision)) return state
  const next = { ...state, revision: update.revision ?? state.revision }
  if ('status' in update) return { ...next, status: update.status, error: update.error }
  if ('interaction' in update) {
    return { ...next, interactions: [...state.interactions.filter((item) => item.id !== update.interaction.id), update.interaction] }
  }
  if ('resolvedRequestId' in update) return { ...next, interactions: state.interactions.filter((item) => item.id !== update.resolvedRequestId) }
  const exists = state.messages.some((message) => message.id === update.message.id)
  return { ...next, messages: exists ? state.messages.map((message) => message.id === update.message.id ? update.message : message) : [...state.messages, update.message].slice(-CONVERSATION_MESSAGE_LIMIT) }
}

/** Подписка устанавливается до чтения снимка. Закрытый клиент никогда не публикует поздний ответ IPC. */
export function subscribeAssistantChat(
  api: Pick<OrcaApi, 'assistantChat'> | undefined,
  ptyId: string,
  onState: (state: ChatState) => void,
  onError: (error: string) => void
): { ready: Promise<void>; dispose(): void } {
  let disposed = false
  let state: ChatState | undefined
  const buffered: AssistantChatUpdate[] = []
  let unsubscribe: (() => void) | undefined
  const dispose = (): void => { disposed = true; unsubscribe?.(); buffered.length = 0 }
  const ready = (async () => {
    try {
      const chat = api?.assistantChat
      if (!chat || typeof chat.interrupt !== 'function' || typeof chat.respond !== 'function') {
        if (!disposed) onError('stale')
        return
      }
      unsubscribe = chat.onMessage(ptyId, (update) => {
        if (disposed) return
        if (!state) { buffered.push(update); return }
        const next = applyChatUpdate(state, update)
        if (next !== state) { state = next; onState(state) }
      })
      const snapshot = await chat.getMessages(ptyId)
      if (disposed) return
      if (snapshot.protocolVersion !== 2 || snapshot.ptyId !== ptyId) { onError('stale'); return }
      state = chatStateFromSnapshot(snapshot)
      for (const update of buffered) state = applyChatUpdate(state, update)
      buffered.length = 0
      onState(state)
    } catch (error) {
      if (!disposed) onError(error instanceof Error ? error.message : String(error))
    }
  })()
  return { ready, dispose }
}

export interface MessageGroup { speaker: 'human' | 'assistant'; messages: AssistantChatMessage[] }

function hasVisibleContent(message: AssistantChatMessage): boolean {
  return Boolean(message.text.trim() || message.hasImage)
}

/** Лента получает только описание вызова: найденные данные остаются в модели протокола. */
export function groupMessages(messages: AssistantChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  for (const message of messages) {
    if (message.role === 'tool' ? !message.toolCalls?.length : !hasVisibleContent(message)) continue
    const visible = message.role === 'tool' ? { ...message, text: '', hasImage: false } : message
    const speaker = message.role === 'human' ? 'human' : 'assistant'
    const last = groups.at(-1)
    if (last?.speaker === speaker) last.messages.push(visible)
    else groups.push({ speaker, messages: [visible] })
  }
  return groups
}

/** Ждём только первый видимый ответ на текущую реплику, а не конец работы CLI. */
export function isAssistantThinking(state: Pick<ChatState, 'messages' | 'status' | 'interactions'>): boolean {
  if (state.status !== 'thinking' || state.interactions.length > 0) return false
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index]
    if (message.role === 'human') break
    if (message.role === 'tool' && message.toolCalls?.some((call) => call.status === 'running')) return false
    if (message.role === 'agent' && hasVisibleContent(message)) return false
  }
  return true
}

/** В превью могут быть аргументы записи файла; в строку действия берём только его цель. */
export function toolActivityDetail(input: string): string {
  const fields = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const text = (value: unknown): string => typeof value === 'string' ? value : ''
  let parts: string[]
  try {
    const value: unknown = JSON.parse(input)
    if (typeof value === 'string') parts = [value]
    else if (Array.isArray(value)) parts = value.slice(0, 3).map((item) => text(fields(item).path) || text(fields(item).file_path))
    else {
      const data = fields(value)
      const description = text(data.description) || text(data.command)
      parts = description ? [description] : [text(data.pattern) || text(data.query) || text(data.url), text(data.file_path) || text(data.path)]
    }
  } catch {
    // Обрезанный JSON не раскрываем как текст; main уже отдаёт обычные команды/пути без JSON.
    parts = /^\s*[\[{]/u.test(input) ? [] : [input]
  }
  const detail = parts.filter(Boolean).join(' · ').replace(/\s+/gu, ' ').trim()
  return detail.length > 180 ? `${detail.slice(0, 179)}…` : detail
}
