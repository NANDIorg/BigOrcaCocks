import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateInstallWhen, UpdateState } from '../../shared/ipc'
import { t } from './i18n'
import { isStaleUpdatesError, updatesApi } from './updateState'
import { ipcErrorMessage } from './useAutoSave'

/** Состояние обновления для UI: одно на приложение (плашка, «Настройки», тост). Источник правды — main. */
export interface UpdatesController {
  /** null — ещё не загружено или API нет (`stale`). */
  state: UpdateState | null
  /** Старый preload/main без `updates`: показываем «перезапустите приложение». */
  stale: boolean
  /** Ошибка вызова (не сбой обновления — тот приходит в `state.error`). */
  error: string | null
  /** Ручная проверка portable не меняет status в main: состояние кнопки держим до ответа invoke. */
  checking: boolean
  /** Только успешная ручная проверка в этой сессии; начальный idle не означает «последняя версия». */
  lastCheckedAt: number | null
  check(): void
  download(): void
  install(when: UpdateInstallWhen): void
  cancelPending(): void
}

/**
 * Читает `updates.getState()` при старте и подписывается на `onChanged`. Каждое действие возвращает свежее
 * состояние — применяем его сразу, не дожидаясь события.
 */
export function useUpdates(): UpdatesController {
  const [state, setState] = useState<UpdateState | null>(null)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null)
  const checkBusy = useRef(false)
  // События прогресса приходят чаще, чем ответы на invoke: не даём старому ответу затереть новое состояние.
  const seq = useRef(0)

  const apply = useCallback((s: UpdateState): void => {
    seq.current += 1
    setState(s)
  }, [])

  const fail = useCallback((e: unknown): void => {
    const msg = ipcErrorMessage(e)
    if (isStaleUpdatesError(msg)) setStale(true)
    else setError(msg)
  }, [])

  useEffect(() => {
    const api = updatesApi(window.orca)
    if (!api) {
      setStale(true)
      return
    }
    const off = api.onChanged(apply)
    const startSeq = seq.current
    api.getState().then((s) => {
      // Событие успело прийти раньше ответа — оно свежее.
      if (seq.current === startSeq) apply(s)
    }, fail)
    return off
  }, [apply, fail])

  const run = useCallback(
    (call: (api: NonNullable<ReturnType<typeof updatesApi>>) => Promise<UpdateState>): void => {
      const api = updatesApi(window.orca)
      if (!api) {
        setStale(true)
        return
      }
      setError(null)
      call(api).then(apply, fail)
    },
    [apply, fail]
  )

  const check = useCallback((): void => {
    const api = updatesApi(window.orca)
    if (!api) { setStale(true); return }
    if (checkBusy.current) return
    checkBusy.current = true
    setChecking(true)
    setError(null)
    api.check().then((s) => {
      apply(s)
      // В manual-download main подавляет сетевые ошибки: такой ответ не доказывает успешную проверку.
      if (s.status !== 'error' && s.status !== 'unsupported') setLastCheckedAt(Date.now())
    }, fail).finally(() => { checkBusy.current = false; setChecking(false) })
  }, [apply, fail])

  return {
    state,
    stale,
    error,
    checking,
    lastCheckedAt,
    check,
    download: () => run((a) => a.download()),
    install: (when) => run((a) => a.install({ when })),
    cancelPending: () => run((a) => a.cancelPending())
  }
}

/** Текст ошибки/старого приложения для показа рядом с кнопками; null — всё хорошо. */
export function updatesProblem(u: Pick<UpdatesController, 'stale' | 'error'>): string | null {
  return u.stale ? t('common.staleApp') : u.error
}
