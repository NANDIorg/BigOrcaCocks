import { useEffect, useRef, useState } from 'react'

import { ipcErrorMessage } from './ipcError'

export { ipcErrorCode, ipcErrorMessage } from './ipcError'

const DEBOUNCE_MS = 300

/** Отложенное сохранение: значение и колбэк, захваченный на момент ввода (с id проекта того времени). */
interface Pending<T> {
  value: T
  save: (value: T) => Promise<void>
}

/**
 * Локальный черновик редактора с автосохранением: текстовый ввод сохраняется с задержкой,
 * остальные изменения — сразу. Ошибка сохранения не сбрасывает введённое.
 * Черновик переинициализируется при смене `key` (id активного проекта); отложенное
 * сохранение при этом (и при размонтировании) сбрасывается на диск, а не теряется.
 */
export function useAutoSave<T>(
  key: string,
  initial: T,
  onSave: (value: T) => Promise<void>
): { draft: T; error: string | null; update: (value: T, debounce?: boolean) => void } {
  const [draft, setDraft] = useState<T>(initial)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef<Pending<T> | null>(null)

  /** Сохранить отложенное значение немедленно. Ошибку показать некуда (редактор уходит) — глушим. */
  function flush(): void {
    window.clearTimeout(timer.current)
    const p = pending.current
    pending.current = null
    if (p) void p.save(p.value).catch(() => {})
  }

  useEffect(() => {
    setDraft(initial)
    setError(null)
    // cleanup срабатывает и при смене key, и при размонтировании — в обоих случаях сбрасываем черновик на диск
    return flush
  }, [key])

  async function persist(value: T, save: (value: T) => Promise<void>): Promise<void> {
    try {
      await save(value)
      setError(null)
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
  }

  function update(value: T, debounce = false): void {
    setDraft(value)
    window.clearTimeout(timer.current)
    pending.current = null
    if (debounce) {
      // Запоминаем onSave текущего рендера: он привязан к проекту, в котором шёл ввод
      const p: Pending<T> = { value, save: onSave }
      pending.current = p
      timer.current = window.setTimeout(() => {
        pending.current = null
        void persist(p.value, p.save)
      }, DEBOUNCE_MS)
    } else {
      void persist(value, onSave)
    }
  }

  return { draft, error, update }
}
