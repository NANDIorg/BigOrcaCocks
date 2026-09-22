import { useEffect, useState } from 'react'
import type { ProjectDefaults } from '../../../shared/ipc'
import { ipcErrorMessage } from '../useAutoSave'

/** Подписчики всех смонтированных useProjectDefaults: сохранение в одном месте обновляет остальные. */
const listeners = new Set<(d: ProjectDefaults) => void>()

/**
 * Дефолт для новых проектов (projects:getDefaults/setDefaults). Нужен и «О проекте» (сравнение,
 * «Сделать дефолтом»), и «Настройкам» (редактирование) — сохранение в одном обновляет другое.
 */
export function useProjectDefaults(): {
  defaults: ProjectDefaults | null
  error: string | null
  setError(e: string | null): void
  /** Патч дефолта; ошибка — в setError раздела, а без него — наружу (автосохранению редактора). */
  save(patch: Partial<ProjectDefaults>, setError?: (e: string | null) => void): Promise<void>
} {
  const [defaults, setDefaults] = useState<ProjectDefaults | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listeners.add(setDefaults)
    window.orca.projects.getDefaults().then(
      (d) => {
        setDefaults(d)
        setError(null)
      },
      (e) => setError(ipcErrorMessage(e))
    )
    return () => {
      listeners.delete(setDefaults)
    }
  }, [])

  async function save(patch: Partial<ProjectDefaults>, setSectionError?: (e: string | null) => void): Promise<void> {
    try {
      const next = await window.orca.projects.setDefaults(patch)
      for (const l of listeners) l(next)
      setSectionError?.(null)
    } catch (e) {
      if (!setSectionError) throw e
      setSectionError(ipcErrorMessage(e))
    }
  }

  return { defaults, error, setError, save }
}
