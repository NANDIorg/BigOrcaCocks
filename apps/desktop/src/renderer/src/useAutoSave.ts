import { useEffect, useRef, useState } from 'react'

/** Сообщение ошибки из main без обёртки ipcRenderer («Error invoking remote method '...': Error: ...»). */
export function ipcErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}

const DEBOUNCE_MS = 300

/**
 * Локальный черновик редактора с автосохранением: текстовый ввод сохраняется с задержкой,
 * остальные изменения — сразу. Ошибка сохранения не сбрасывает введённое.
 * Черновик переинициализируется при смене `key` (id активного проекта).
 */
export function useAutoSave<T>(
  key: string,
  initial: T,
  onSave: (value: T) => Promise<void>
): { draft: T; error: string | null; update: (value: T, debounce?: boolean) => void } {
  const [draft, setDraft] = useState<T>(initial)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    window.clearTimeout(timer.current)
    setDraft(initial)
    setError(null)
  }, [key])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function persist(value: T): Promise<void> {
    try {
      await onSave(value)
      setError(null)
    } catch (e) {
      setError(ipcErrorMessage(e))
    }
  }

  function update(value: T, debounce = false): void {
    setDraft(value)
    window.clearTimeout(timer.current)
    if (debounce) timer.current = window.setTimeout(() => void persist(value), DEBOUNCE_MS)
    else void persist(value)
  }

  return { draft, error, update }
}
