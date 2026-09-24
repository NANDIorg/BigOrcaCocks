import { useCallback, useEffect, useRef, useState } from 'react'
import { ipcErrorMessage } from './useAutoSave'
import { STATS_REFRESH_MS, isStatsStale } from './taskStatsFormat'

/** Пауза перед перечиткой после смены `key`: пачка событий store (запуск, статус, запрос) — один вызов. */
const RELOAD_DEBOUNCE_MS = 400

export interface StatsLoad<T> {
  stats: T | null
  /** main/preload старые: время посчитано в renderer (`fallback`), токенов нет. */
  stale: boolean
  error: string | null
  loading: boolean
  reload(): void
}

interface Options<T> {
  /** Вызов IPC; бросает `STATS_STALE_MESSAGE` при старом preload. */
  load(): Promise<T>
  /** Запасной расчёт без токенов — при старом main. */
  fallback(): T
  /** Пока не меняется, статистика не перечитывается (`taskStatsKey` / `globalStatsKey`). */
  key: string
  /** Есть ли что-то идущее: тогда перечитываем раз в `STATS_REFRESH_MS`. */
  running(stats: T): boolean
}

/**
 * Загрузка статистики задачи или глобальной задачи: один запрос при открытии, потом при смене `key` и раз в минуту,
 * пока что-то идёт. Устаревший ответ (быстро сменили `key` или задачу) не затирает свежий. Старый main —
 * запасной расчёт `fallback` и флаг `stale`.
 */
export function useStatsLoad<T>(options: Options<T>): StatsLoad<T> {
  const { key } = options
  const opts = useRef(options)
  opts.current = options
  const [stats, setStats] = useState<T | null>(null)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const req = useRef(0)
  const staleRef = useRef(false)

  const reload = useCallback(() => {
    const id = ++req.current
    setLoading(true)
    setError(null)
    const done = (s: T, isStale: boolean): void => {
      if (id !== req.current) return
      staleRef.current = isStale
      setStats(s)
      setStale(isStale)
      setLoading(false)
    }
    if (staleRef.current) {
      done(opts.current.fallback(), true)
      return
    }
    opts.current.load().then(
      (s) => done(s, false),
      (e: unknown) => {
        if (id !== req.current) return
        const msg = ipcErrorMessage(e)
        if (isStatsStale(msg)) {
          try {
            done(opts.current.fallback(), true)
            return
          } catch (fe) {
            setError(ipcErrorMessage(fe))
          }
        } else setError(msg)
        setLoading(false)
      }
    )
  }, [])

  // Первая загрузка — сразу, дальше по смене `key` с паузой.
  const loadedOnce = useRef(false)
  useEffect(() => {
    const t = setTimeout(() => {
      loadedOnce.current = true
      reload()
    }, loadedOnce.current ? RELOAD_DEBOUNCE_MS : 0)
    return () => clearTimeout(t)
  }, [key, reload])

  // Пока что-то идёт, токены и роли растут в транскриптах — перечитываем раз в минуту.
  const running = stats !== null && opts.current.running(stats)
  useEffect(() => {
    if (!running) return
    const t = setInterval(reload, STATS_REFRESH_MS)
    return () => clearInterval(t)
  }, [running, reload])

  // Ушли на другую задачу (компонент с новым key размонтируется в вызывающем коде) — ответы старых запросов игнорируем.
  useEffect(() => () => { req.current++ }, [])

  return { stats, stale, error, loading, reload }
}
