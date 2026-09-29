import type { AgentInfo } from '@orca-board/core'
import { ipcErrorMessage } from './ipcError'

export interface OnboardingScanState {
  agents: AgentInfo[] | null
  busy: boolean
  error: string | null
}

/** Оболочка есть всегда и не помогает понять, какие CLI-агенты установлены. Порядок реестра сохраняется. */
export function onboardingAgentGroups(agents: readonly AgentInfo[] | null): { installed: AgentInfo[]; missing: AgentInfo[] } {
  const list = (agents ?? []).filter(agent => agent.id !== 'shell')
  return { installed: list.filter(agent => agent.installed), missing: list.filter(agent => !agent.installed) }
}

/** Проверка живёт весь мастер: возврат на шаг не сбрасывает результат; закрытый мастер не получает поздний ответ. */
export function createOnboardingScanner(load: () => Promise<AgentInfo[]>, onChange: (state: OnboardingScanState) => void): {
  scan(): Promise<void>
  dispose(): void
} {
  let state: OnboardingScanState = { agents: null, busy: false, error: null }
  let pending: Promise<void> | null = null
  let disposed = false
  const publish = (patch: Partial<OnboardingScanState>): void => {
    if (disposed) return
    state = { ...state, ...patch }
    onChange(state)
  }
  return {
    scan() {
      if (disposed) return Promise.resolve()
      if (pending) return pending
      publish({ busy: true, error: null })
      pending = (async () => {
        try { publish({ agents: await load(), error: null }) }
        catch (error) { publish({ error: ipcErrorMessage(error) }) }
        finally { publish({ busy: false }) }
      })().finally(() => { pending = null })
      return pending
    },
    dispose() { disposed = true }
  }
}
