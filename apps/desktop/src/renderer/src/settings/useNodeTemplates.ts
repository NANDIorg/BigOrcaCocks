import { useEffect, useState } from 'react'
import type { WfNodeTemplate } from '@orca-board/core'
import { ipcErrorMessage } from '../ipcError'
import { nodeTemplatesApi, nodeTemplatesError, nodeTemplatesStaleMessage, withTemplate, type NodeTemplatesHook } from '../nodeTemplates'

/** Ошибка IPC по-человечески: нет хендлера в старом main — «перезапустите приложение». */
function failure(e: unknown): Error {
  return new Error(nodeTemplatesError(ipcErrorMessage(e)))
}

/**
 * Библиотека шаблонов нод (`nodeTemplates:*`) для «Настроек»: одно состояние на редактор воркфлоу (палитра «Свои ноды»,
 * инспектор) и список в разделе «Свои ноды». Записи обновляют локальный список ответом main, отдельного чтения нет.
 */
export function useNodeTemplates(): NodeTemplatesHook {
  const stale = !window.orca.nodeTemplates
  const [templates, setTemplates] = useState<WfNodeTemplate[] | null>(null)
  const [error, setError] = useState<string | null>(stale ? nodeTemplatesStaleMessage() : null)

  useEffect(() => {
    if (stale) return
    nodeTemplatesApi(window.orca).list().then(
      (list) => { setTemplates(list); setError(null) },
      (e: unknown) => setError(failure(e).message)
    )
  }, [])

  return {
    templates,
    error,
    stale,
    async save(input) {
      let saved: WfNodeTemplate
      try {
        saved = await nodeTemplatesApi(window.orca).save(input)
      } catch (e) {
        throw failure(e)
      }
      setTemplates((list) => (list ? withTemplate(list, saved) : list))
      setError(null)
      return saved
    },
    async remove(id) {
      try {
        setTemplates(await nodeTemplatesApi(window.orca).delete(id))
      } catch (e) {
        throw failure(e)
      }
    }
  }
}
