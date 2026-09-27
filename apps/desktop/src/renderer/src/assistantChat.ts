// Логика чат-режима панели ассистента (docs/assistant-chat.md → «3. Контракт чат-режима»): вид панели
// (чат/терминал) и его хранение, слияние снимка/событий IPC `assistantChat.*` в ленту сообщений,
// группировка ленты для рендера и обнаружение «зависшего» ожидания (агент, вероятно, ждёт ввода в терминале).
import type { AssistantChatMessage, AssistantChatRole, AssistantChatSnapshot, AssistantChatStatus, AssistantChatUpdate, OrcaApi } from '../../shared/ipc'

export type AssistantViewMode = 'chat' | 'terminal'

const VIEW_MODE_KEY = 'orca.assistant.viewMode'

export function isAssistantViewMode(v: unknown): v is AssistantViewMode {
  return v === 'chat' || v === 'terminal'
}

/** Выбор «Чат/Терминал» помнится между открытиями панели — как сортировка доски (`boardView.ts`). */
export function readAssistantViewMode(): AssistantViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY)
    return isAssistantViewMode(v) ? v : 'chat'
  } catch {
    return 'chat'
  }
}

export function writeAssistantViewMode(mode: AssistantViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode)
  } catch {
    // localStorage недоступен — выбор просто не переживёт перезапуск.
  }
}

/**
 * Поддержка чата запущенным main для конкретного PTY: `stale` — preload новее main (нет `assistantChat.*`,
 * как `attachmentsSupport` в `imageDrafts.ts`), `unavailable` — API есть, но транскрипт не найден (агент без
 * парсера или сессия только начинается), `available` — можно показывать чат.
 */
export type ChatSupport = 'checking' | 'available' | 'unavailable' | 'stale'

export async function checkChatSupport(api: Partial<OrcaApi> | undefined, ptyId: string): Promise<'available' | 'unavailable' | 'stale'> {
  const available = api?.assistantChat?.available
  if (typeof available !== 'function') return 'stale'
  try {
    return (await available(ptyId)) ? 'available' : 'unavailable'
  } catch {
    // «No handler registered for 'assistantChat:available'» — main старый, preload новый.
    return 'stale'
  }
}

export interface ChatState {
  messages: AssistantChatMessage[]
  status: AssistantChatStatus
}

export function emptyChatState(): ChatState {
  return { messages: [], status: 'done' }
}

export function chatStateFromSnapshot(snapshot: AssistantChatSnapshot): ChatState {
  return { messages: snapshot.messages, status: snapshot.status }
}

/**
 * Применить событие `assistantChat.onMessage` к ленте: новое сообщение (незнакомый `id`) — добавляется в конец,
 * знакомое — заменяется на месте (main дописывает текст/статус tool-вызова в тот же объект), смена статуса
 * трогает только его.
 */
export function applyChatUpdate(state: ChatState, update: AssistantChatUpdate): ChatState {
  if ('status' in update) {
    return state.status === update.status ? state : { ...state, status: update.status }
  }
  const i = state.messages.findIndex((m) => m.id === update.message.id)
  const messages = i === -1 ? [...state.messages, update.message] : state.messages.map((m, idx) => (idx === i ? update.message : m))
  return { ...state, messages }
}

/** Кто говорит для целей группировки ленты: `tool` — те же реплики ассистента, что и `agent`, без текста. */
export type ChatSpeaker = 'human' | 'assistant'

export function speakerOf(role: AssistantChatRole): ChatSpeaker {
  return role === 'human' ? 'human' : 'assistant'
}

/** Подряд идущие сообщения одного собеседника — в ленте у них одна подпись, без повтора на каждой реплике. */
export interface MessageGroup {
  speaker: ChatSpeaker
  messages: AssistantChatMessage[]
}

export function groupMessages(messages: AssistantChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  for (const m of messages) {
    const speaker = speakerOf(m.role)
    const last = groups[groups.length - 1]
    if (last && last.speaker === speaker) last.messages.push(m)
    else groups.push({ speaker, messages: [m] })
  }
  return groups
}

/**
 * Сколько «думает» без новых сообщений лента считается зависшей: скорее всего, агент ждёт ввода в терминале
 * (permission-диалог TUI Claude Code — сырое взаимодействие клавишами, не запись транскрипта) — тогда чат
 * молчит, а Enter в чате его не разбудит. Панель предлагает открыть терминал, не гадая наверняка.
 */
export const STUCK_THINKING_MS = 20_000

export function isStuckThinking(status: AssistantChatStatus, lastMessageAt: number | undefined, now: number): boolean {
  if (status !== 'thinking' || lastMessageAt === undefined) return false
  return now - lastMessageAt > STUCK_THINKING_MS
}
