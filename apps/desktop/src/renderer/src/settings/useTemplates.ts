import { useEffect, useRef, useState } from 'react'
import type { ProjectTemplate } from '@orca-board/core'
import type { TemplateInput, TemplatesState } from '../../../shared/ipc'
import { ipcErrorMessage } from '../useAutoSave'
import { refreshProjectDefaults } from '../about/useProjectDefaults'
import {
  TEMPLATES_STALE_MESSAGE, patchedTemplate, renamedTemplate, templatesApi, templatesError, type TemplatePatch
} from '../projectTemplates'

/** Ошибка IPC шаблонов по-человечески: нет API или хендлера в старом main — «перезапустите приложение». */
function message(e: unknown): string {
  return templatesError(ipcErrorMessage(e))
}

export interface TemplatesHook {
  state: TemplatesState | null
  /** Ошибка загрузки списка (в том числе старый main/preload). */
  error: string | null
  /** Нет `window.orca.templates` — preload старый, раздел работать не может. */
  stale: boolean
  /** Создать шаблон; ошибка — наружу. */
  create(input: TemplateInput): Promise<ProjectTemplate>
  /** Правка настроек шаблона поверх последней сохранённой версии; ошибка — наружу (автосохранению редактора). */
  patch(id: string, patch: TemplatePatch): Promise<void>
  rename(id: string, title: string, description: string): Promise<void>
  duplicate(id: string): Promise<ProjectTemplate>
  remove(id: string): Promise<void>
  setDefault(id: string): Promise<void>
}

/**
 * Список шаблонов проектов (templates:*) для «Настроек». После каждой записи список перечитывается целиком
 * (порядок и копии встроенных решает main), а шаблон по умолчанию — ещё и в useProjectDefaults
 * (сравнение в «О проекте», роли ассистента), потому что правка могла задеть именно его.
 */
export function useTemplates(): TemplatesHook {
  const stale = !window.orca.templates
  const [state, setState] = useState<TemplatesState | null>(null)
  const [error, setError] = useState<string | null>(stale ? TEMPLATES_STALE_MESSAGE : null)
  /**
   * Последняя сохранённая версия каждого шаблона. templates:save заменяет шаблон целиком, а редакторы разделов
   * сохраняются с задержкой: без этого правка ролей, досохранённая после смены вкладки, затёрла бы
   * только что выбранный режим разрешений старым значением из замыкания.
   */
  const latest = useRef(new Map<string, ProjectTemplate>())

  async function reload(): Promise<TemplatesState> {
    const next = await templatesApi(window.orca).list()
    latest.current = new Map(next.templates.map((t) => [t.id, t]))
    setState(next)
    setError(null)
    return next
  }

  useEffect(() => {
    if (stale) return
    reload().catch((e: unknown) => setError(message(e)))
  }, [])

  /** Запись + перечитать список и шаблон по умолчанию; ошибка — с текстом «перезапустите» для старого main. */
  async function write<T>(action: () => Promise<T>): Promise<T> {
    let result: T
    try {
      result = await action()
    } catch (e) {
      throw new Error(message(e))
    }
    await reload().catch((e: unknown) => setError(message(e)))
    void refreshProjectDefaults()
    return result
  }

  /** Очередь правок: следующая собирается из результата предыдущей, а не из той же старой версии. */
  const queue = useRef<Promise<void>>(Promise.resolve())

  /** Сохранить шаблон, собранный из его последней версии. */
  function update(id: string, build: (t: ProjectTemplate) => TemplateInput): Promise<void> {
    const run = queue.current.then(async () => {
      const base = latest.current.get(id)
      if (!base) throw new Error(`шаблон не найден: ${id}`)
      const saved = await write(() => templatesApi(window.orca).save(build(base)))
      latest.current.set(id, saved)
    })
    queue.current = run.catch(() => undefined)
    return run
  }

  return {
    state,
    error,
    stale,
    create: (input) => write(() => templatesApi(window.orca).save(input)),
    patch: (id, p) => update(id, (t) => patchedTemplate(t, p)),
    rename: (id, title, description) =>
      update(id, (t) => {
        const input = renamedTemplate(t, title, description)
        if ('error' in input) throw new Error(input.error)
        return input
      }),
    duplicate: (id) => write(() => templatesApi(window.orca).duplicate(id)),
    remove: (id) => write(async () => { await templatesApi(window.orca).delete(id) }),
    setDefault: (id) => write(async () => { await templatesApi(window.orca).setDefault(id) })
  }
}
