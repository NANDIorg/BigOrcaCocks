import { useEffect, useState } from 'react'
import type { UpdateInfo, UpdateState } from '../../shared/ipc'
import { useT } from './i18n'
import type { UpdatesController } from './useUpdates'

export const UPDATE_PREVIEW_SCENARIOS = ['available', 'downloading', 'ready', 'idle'] as const
export type UpdatePreviewScenario = (typeof UPDATE_PREVIEW_SCENARIOS)[number]

/** Временная демонстрация по просьбе пользователя. Живёт только в разделе настроек, не вызывает IPC. */
export function useUpdatePreview(): {
  controller: UpdatesController
  currentRelease?: Pick<UpdateInfo, 'version' | 'releaseNotes'>
  select(scenario: UpdatePreviewScenario): void
} | null {
  const t = useT()
  const [status, setStatus] = useState<UpdateState['status']>('available')
  const [percent, setPercent] = useState(42)
  const [pending, setPending] = useState<UpdateState['installPending']>('quit')
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    if (!__ORCA_UPDATES_PREVIEW__ || status !== 'downloading') return
    const timer = window.setInterval(() => setPercent((value) => Math.min(100, value + 3)), 350)
    return () => window.clearInterval(timer)
  }, [status])

  useEffect(() => {
    if (status === 'downloading' && percent === 100) setStatus('ready')
  }, [status, percent])

  useEffect(() => {
    if (!__ORCA_UPDATES_PREVIEW__ || (status !== 'checking' && status !== 'installing')) return
    const timer = window.setTimeout(() => {
      if (status === 'installing') { setInstalled(true); setStatus('idle') }
      else setStatus('available')
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [status])

  if (!__ORCA_UPDATES_PREVIEW__) return null
  const notes = t('settings.updates.preview.notes')
  const found = status !== 'idle'
  const state: UpdateState = {
    status, currentVersion: installed ? '1.1.1' : '1.1.0', availableVersion: found ? '1.1.1' : null,
    releaseNotes: found ? notes : null, releaseUrl: null,
    percent: status === 'downloading' ? percent : null, installPending: status === 'ready' ? pending : null,
    mode: 'auto', unsupportedReason: null, error: null
  }
  return {
    currentRelease: installed ? { version: state.currentVersion, releaseNotes: notes } : undefined,
    select: (scenario) => { setStatus(scenario); setPercent(42); setPending('quit'); setInstalled(false) },
    controller: {
      state, stale: false, error: null, checking: status === 'checking', lastCheckedAt: status === 'idle' ? Date.now() : null,
      check: () => setStatus('checking'),
      download: () => { setPercent(0); setStatus('downloading') },
      install: (when) => { if (when === 'now') setStatus('installing'); else setPending(when) },
      cancelPending: () => setPending(null)
    }
  }
}
