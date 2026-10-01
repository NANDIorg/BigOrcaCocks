import { useEffect, useRef, useState } from 'react'
import { defaultWorkflow, type TaskType, type Workflow } from '@orca-board/core'
import type { TaskTypeExportResult, TaskTypeInput, TaskTypesState } from '../../../shared/ipc'
import { ipcErrorMessage } from '../useAutoSave'
import {
  resolveTypeSettings, taskTypeExportApi, taskTypeLibraryApi, taskTypesError, taskTypesStaleMessage, type TaskTypePatch
} from '../taskTypeEdit'
import { workflowAssistantApi, workflowAssistantError } from '../workflowAssistant'

/** Ошибка IPC типов по-человечески: нет API или хендлера в старом main — «перезапустите приложение». */
function message(e: unknown): string {
  return workflowAssistantError(taskTypesError(ipcErrorMessage(e)))
}

export interface TaskTypesHook {
  state: TaskTypesState | null
  /** Порядок полученных списков: новый перечит авторитетен и при прежнем содержимом графа. */
  observation: number
  /** Ошибка загрузки списка (в том числе старый main/preload). */
  error: string | null
  /** Нет `window.orca.taskTypes` — preload старый, раздел работать не может. */
  stale: boolean
  /** Перечитать список (например, по `app:changed` — тип мог поменять CLI/ассистент, пока окно открыто). */
  reload(): Promise<void>
  /** Создать тип; ошибка — наружу. */
  create(input: TaskTypeInput): Promise<TaskType>
  /** Правка настроек типа поверх последней сохранённой версии; ошибка — наружу (автосохранению редактора). */
  patch(id: string, patch: TaskTypePatch): Promise<void>
  rename(id: string, title: string, description: string): Promise<void>
  saveWorkflow(id: string, baseline: Workflow, workflow: Workflow | null): Promise<WorkflowSaveSnapshot | undefined>
  duplicate(id: string): Promise<TaskType>
  remove(id: string): Promise<void>
  setDefault(id: string): Promise<void>
  /**
   * Сохранить тип целиком в файл (диалог «Сохранить как» в main). В файл идёт сохранённая версия типа, а не черновики
   * редакторов. Диалог закрыли — null; ошибка — наружу.
   */
  exportType(id: string): Promise<TaskTypeExportResult | null>
}

/** Эффективный граф из обязательного перечита после записи, а не предполагаемый результат Save/Reset. */
export interface WorkflowSaveSnapshot { workflow: Workflow; observation: number }
interface TaskTypesSnapshot { state: TaskTypesState; observation: number }

/**
 * Библиотека типов задач (taskTypes:*) для «Настроек». После каждой записи список перечитывается целиком (порядок
 * и копии встроенных решает main), а ещё — проекты приложения (`onChanged`): удаление типа меняет их тип по
 * умолчанию, а доске нужны свежие роли типов. `reload()` — тот же перечит по внешней правке (CLI/ассистент,
 * `app:changed`), пока окно открыто; узкие патчи применяются в main к последней сохранённой версии типа.
 */
export function useTaskTypes(onChanged?: () => Promise<void>): TaskTypesHook {
  const stale = !window.orca.taskTypes
  const [{ state, observation }, setSnapshot] = useState<{ state: TaskTypesState | null; observation: number }>({ state: null, observation: 0 })
  const observations = useRef(0)
  const [error, setError] = useState<string | null>(stale ? taskTypesStaleMessage() : null)
  async function reload(): Promise<TaskTypesSnapshot> {
    const next = await taskTypeLibraryApi(window.orca).list()
    const snapshot = { state: next, observation: ++observations.current }
    setSnapshot(snapshot)
    setError(null)
    return snapshot
  }

  useEffect(() => {
    if (stale) return
    reload().catch((e: unknown) => setError(message(e)))
  }, [])

  /** Запись + перечитать список и проекты; ошибка — с текстом «перезапустите» для старого main. */
  async function write<T>(action: () => Promise<T>, onReload?: (snapshot: TaskTypesSnapshot) => void): Promise<T> {
    let result: T
    try {
      result = await action()
    } catch (e) {
      throw new Error(message(e))
    }
    const snapshot = await reload().catch((e: unknown) => setError(message(e)))
    if (snapshot) onReload?.(snapshot)
    await onChanged?.().catch(() => undefined)
    return result
  }

  /** Очередь правок ждёт запись, перечит списка и обновление проектов. */
  const queue = useRef<Promise<void>>(Promise.resolve())

  /** Очередь сохраняет порядок, но каждый узкий патч main применяет к свежему типу. */
  function update(action: () => Promise<unknown>, onReload?: (snapshot: TaskTypesSnapshot) => void): Promise<void> {
    const run = queue.current.then(async () => { await write(action, onReload) })
    queue.current = run.catch(() => undefined)
    return run
  }

  return {
    state,
    observation,
    error,
    stale,
    reload: () => (stale ? Promise.resolve() : reload().then(() => undefined, (e: unknown) => setError(message(e)))),
    create: (input) => write(() => taskTypeLibraryApi(window.orca).save(input)),
    patch: (id, patch) => update(() => {
      const api = taskTypeLibraryApi(window.orca)
      if (typeof api.patch !== 'function') throw new Error(taskTypesStaleMessage())
      return api.patch(id, patch)
    }),
    rename: (id, title, description) => update(() => {
      const api = taskTypeLibraryApi(window.orca)
      if (typeof api.rename !== 'function') throw new Error(taskTypesStaleMessage())
      return api.rename(id, title, description)
    }),
    saveWorkflow: (id, baseline, workflow) => {
      let saved: WorkflowSaveSnapshot | undefined
      return update(() => workflowAssistantApi(window.orca).save(id, baseline, workflow), (snapshot) => {
        const type = snapshot.state.taskTypes.find((type) => type.id === id)
        if (!type) return
        const settings = resolveTypeSettings(type.settings)
        saved = { workflow: settings.workflow ?? defaultWorkflow(settings.roles), observation: snapshot.observation }
      }).then(() => saved)
    },
    duplicate: (id) => write(() => taskTypeLibraryApi(window.orca).duplicate(id)),
    remove: (id) => write(async () => { await taskTypeLibraryApi(window.orca).delete(id) }),
    setDefault: (id) => write(async () => { await taskTypeLibraryApi(window.orca).setDefault(id) }),
    // Не через write(): тип не меняется, перечитывать нечего. Очередь ждём, чтобы в файл попали уже запущенные
    // автосохранения редакторов.
    exportType: async (id) => {
      await queue.current
      try {
        return await taskTypeExportApi(window.orca)(id)
      } catch (e) {
        throw new Error(message(e))
      }
    }
  }
}
