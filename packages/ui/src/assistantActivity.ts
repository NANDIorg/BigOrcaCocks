import type { ChatState } from './assistantChat'

/** Оболочке нужны смены состояния, а не каждый фрагмент ответа. */
export interface AssistantActivity {
  ptyId: string
  revision: number
  status: ChatState['status']
  responseReady: boolean
  terminal: boolean
}

export type AssistantReadMarker = Pick<AssistantActivity, 'ptyId' | 'revision' | 'status'>
export type AssistantRailState = 'idle' | 'working' | 'unread' | 'waiting' | 'error'

export function assistantActivityOf(chat: ChatState): AssistantActivity {
  const status = chat.status === 'thinking' && chat.interactions.length ? 'waiting' : chat.status
  let responseReady = false
  if (status === 'done') {
    for (let index = chat.messages.length - 1; index >= 0; index--) {
      const message = chat.messages[index]
      if (message.role === 'human') break
      if (message.role === 'agent' && (message.text.trim() || message.hasImage)) { responseReady = true; break }
    }
  }
  return {
    ptyId: chat.ptyId,
    revision: status === 'done' || status === 'error' ? chat.revision : -1,
    status,
    responseReady,
    terminal: chat.transport === 'terminal'
  }
}

/** Прочитанность относится к конкретному диалогу и ревизии готового ответа. */
export function assistantRailState(
  activity: AssistantActivity | null,
  read: AssistantReadMarker | null,
  visible: boolean,
  starting = false
): AssistantRailState {
  if (visible) return 'idle'
  if (starting) return 'working'
  if (!activity || activity.terminal) return 'idle'
  if (activity.status === 'starting' || activity.status === 'thinking') return 'working'
  if (activity.status === 'waiting') return 'waiting'
  const seen = read?.ptyId === activity.ptyId && read.revision === activity.revision && read.status === activity.status
  if (!seen && activity.status === 'error') return 'error'
  if (!seen && activity.responseReady) return 'unread'
  return 'idle'
}
