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
export function groupMessages(messages: AssistantChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  for (const message of messages) {
    const speaker = message.role === 'human' ? 'human' : 'assistant'
    const last = groups.at(-1)
    if (last?.speaker === speaker) last.messages.push(message)
    else groups.push({ speaker, messages: [message] })
  }
  return groups
}
