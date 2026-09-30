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
 * Что отправить вместо черновика: `saved` — последнее отправленное значение (до первой отправки — начальное).
 * Нужен, когда в черновике лежит ввод, который main не примет (негодные флаги запуска): поле уходит прежним,
 * остальные правки сохраняются.
 */
export type PrepareSave<T> = (draft: T, saved: T) => T

/**
 * Локальный черновик редактора с автосохранением: текстовый ввод сохраняется с задержкой,
 * остальные изменения — сразу. Ошибка сохранения не сбрасывает введённое.
 * Черновик переинициализируется при смене `key` (id активного проекта); отложенное
 * сохранение при этом (и при размонтировании) сбрасывается на диск, а не теряется.
 * `prepare` — что отправлять вместо черновика (`PrepareSave`); черновик и поля ввода он не меняет.
 */
export function useAutoSave<T>(
  key: string,
  initial: T,
  onSave: (value: T) => Promise<void>,
  prepare?: PrepareSave<T>
): { draft: T; error: string | null; update: (value: T, debounce?: boolean) => void } {
  const [draft, setDraft] = useState<T>(initial)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef<Pending<T> | null>(null)
  /** Последнее отправленное значение — основа для `prepare`. */
  const saved = useRef<T>(initial)

  /**
   * Отправить значение. `saved` меняется сразу, а не после ответа: следующая отправка может уйти раньше, чем
   * вернётся эта, и должна опираться уже на неё. Сбой возвращает прежнюю основу, если её не сменила отправка новее.
   */
  async function send(value: T, save: (value: T) => Promise<void>): Promise<void> {
    const prev = saved.current
    const next = prepare ? prepare(value, prev) : value
    saved.current = next
    try {
      await save(next)
    } catch (e) {
      if (saved.current === next) saved.current = prev
      throw e
    }
  }

  /** Сохранить отложенное значение немедленно. Ошибку показать некуда (редактор уходит) — глушим. */
  function flush(): void {
    window.clearTimeout(timer.current)
    const p = pending.current
    pending.current = null
    if (p) void send(p.value, p.save).catch(() => {})
  }

  useEffect(() => {
    setDraft(initial)
    setError(null)
    // Отложенное сохранение прежнего ключа уже сброшено (cleanup идёт раньше) — основа теперь от нового черновика.
    saved.current = initial
    // cleanup срабатывает и при смене key, и при размонтировании — в обоих случаях сбрасываем черновик на диск
    return flush
  }, [key])

  async function persist(value: T, save: (value: T) => Promise<void>): Promise<void> {
    try {
      await send(value, save)
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
