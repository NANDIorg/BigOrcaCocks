import type { PlatformAdapter } from '@orca-board/client'
import type { UpdateState } from '@orca-board/client/desktop-settings'
import { t } from '@orca-board/ui'

export function createWebUpdates(options: { request<T>(path: string, method?: string, value?: unknown): Promise<T>; onError(error: unknown): void }) {
  let state: UpdateState | undefined
  let closed = false
  let polling = false
  let timer: ReturnType<typeof setInterval> | undefined
  const listeners = new Set<(value: UpdateState) => void>()
  function publish(value: UpdateState): UpdateState {
    state = { ...value, error: value.error ? t(value.error === 'check' ? 'shell.web.updateError.check' : value.error === 'download' ? 'shell.web.updateError.download' : value.error === 'interrupted' ? 'shell.web.updateError.interrupted' : 'shell.web.updateError.install') : null }
    if (!closed) for (const listener of listeners) listener(state)
    return state
  }
  async function getState(): Promise<UpdateState> { return publish(await options.request<UpdateState>('/updates')) }
  async function action(kind: 'check' | 'download' | 'install'): Promise<UpdateState> {
    if (closed) throw new Error('protocol.closed')
    const current = state ?? await getState()
    return publish(await options.request<UpdateState>(`/updates/${kind}`, 'POST', kind === 'check' ? {} : { version: current.availableVersion }))
  }
  const api: PlatformAdapter['updates'] = {
    getState, check: () => action('check'), download: () => action('download'),
    install: async ({ when }) => {
      const current = state ?? await getState()
      if (when !== 'now' || current.status !== 'ready' || !window.confirm(t('shell.web.updateConfirm'))) return current
      return action('install')
    },
    cancelPending: getState, getJustUpdated: async () => null,
    onChanged(listener) {
      listeners.add(listener)
      if (!timer && !closed) timer = setInterval(() => {
        if (polling || closed) return
        polling = true
        void getState().catch(options.onError).finally(() => { polling = false })
      }, 2000)
      return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = undefined } }
    }
  }
  return { api, dispose() { closed = true; listeners.clear(); if (timer) clearInterval(timer); timer = undefined } }
}
