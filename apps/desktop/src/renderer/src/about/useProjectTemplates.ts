import { useCallback, useEffect, useState } from 'react'
import type { TemplatesState } from '../../../shared/ipc'
import { ipcErrorMessage } from '../useAutoSave'
import { TEMPLATES_STALE_MESSAGE, isStaleTemplatesError, templatesApi } from '../projectType'

/**
 * Шаблоны проектов для «О проекте → Обзор». `api` null — preload старый, без шаблонов: вызывающий показывает
 * прежний блок «Дефолт для новых проектов». Список перечитывается при каждом монтировании «Обзора» —
 * так видны шаблоны, изменённые в «Настройках».
 */
export function useProjectTemplates(): {
  api: ReturnType<typeof templatesApi>
  state: TemplatesState | null
  error: string | null
  reload(): Promise<void>
} {
  const api = templatesApi(window.orca)
  const [state, setState] = useState<TemplatesState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const templates = templatesApi(window.orca)?.templates
    if (!templates) return
    try {
      setState(await templates.list())
      setError(null)
    } catch (e) {
      const msg = ipcErrorMessage(e)
      setError(isStaleTemplatesError(msg) ? TEMPLATES_STALE_MESSAGE : msg)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { api, state, error, reload }
}
