import { useEffect, useRef, useState } from 'react'
import type { TaskType } from '@orca-board/core'
import type { TaskTypeInput, TaskTypesState } from '../../../shared/ipc'
import { ipcErrorMessage } from '../useAutoSave'
import {
  TASK_TYPES_STALE_MESSAGE, patchedTaskType, renamedTaskType, taskTypeLibraryApi, taskTypesError, type TaskTypePatch
} from '../taskTypeEdit'

/** Ошибка IPC типов по-человечески: нет API или хендлера в старом main — «перезапустите приложение». */
function message(e: unknown): string {
  return taskTypesError(ipcErrorMessage(e))
}

export interface TaskTypesHook {
  state: TaskTypesState | null
  /** Ошибка загрузки списка (в том числе старый main/preload). */
  error: string | null
  /** Нет `window.orca.taskTypes` — preload старый, раздел работать не может. */
  stale: boolean
  /** Создать тип; ошибка — наружу. */
  create(input: TaskTypeInput): Promise<TaskType>
  /** Правка настроек типа поверх последней сохранённой версии; ошибка — наружу (автосохранению редактора). */
  patch(id: string, patch: TaskTypePatch): Promise<void>
  rename(id: string, title: string, description: string): Promise<void>
  duplicate(id: string): Promise<TaskType>
  remove(id: string): Promise<void>
  setDefault(id: string): Promise<void>
}

/**
 * Библиотека типов задач (taskTypes:*) для «Настроек». После каждой записи список перечитывается целиком (порядок
 * и копии встроенных решает main), а ещё — проекты приложения (`onChanged`): удаление типа меняет их тип по
 * умолчанию, а доске нужны свежие роли типов.
 */
export function useTaskTypes(onChanged?: () => Promise<void>): TaskTypesHook {
  const stale = !window.orca.taskTypes
  const [state, setState] = useState<TaskTypesState | null>(null)
  const [error, setError] = useState<string | null>(stale ? TASK_TYPES_STALE_MESSAGE : null)
  /**
   * Последняя сохранённая версия каждого типа. taskTypes:save заменяет тип целиком, а редакторы разделов
   * сохраняются с задержкой: без этого правка ролей, досохранённая после смены вкладки, затёрла бы
   * только что выбранный режим разрешений старым значением из замыкания.
   */
  const latest = useRef(new Map<string, TaskType>())

  async function reload(): Promise<TaskTypesState> {
    const next = await taskTypeLibraryApi(window.orca).list()
    latest.current = new Map(next.taskTypes.map((t) => [t.id, t]))
    setState(next)
    setError(null)
    return next
  }

  useEffect(() => {
    if (stale) return
    reload().catch((e: unknown) => setError(message(e)))
  }, [])

  /** Запись + перечитать список и проекты; ошибка — с текстом «перезапустите» для старого main. */
  async function write<T>(action: () => Promise<T>): Promise<T> {
    let result: T
    try {
      result = await action()
    } catch (e) {
      throw new Error(message(e))
    }
    await reload().catch((e: unknown) => setError(message(e)))
    void onChanged?.().catch(() => undefined)
    return result
  }

  /** Очередь правок: следующая собирается из результата предыдущей, а не из той же старой версии. */
  const queue = useRef<Promise<void>>(Promise.resolve())

  /** Сохранить тип, собранный из его последней версии. */
  function update(id: string, build: (t: TaskType) => TaskTypeInput): Promise<void> {
    const run = queue.current.then(async () => {
      const base = latest.current.get(id)
      if (!base) throw new Error(`тип задачи не найден: ${id}`)
      const saved = await write(() => taskTypeLibraryApi(window.orca).save(build(base)))
      latest.current.set(id, saved)
    })
    queue.current = run.catch(() => undefined)
    return run
  }

  return {
    state,
    error,
    stale,
    create: (input) => write(() => taskTypeLibraryApi(window.orca).save(input)),
    patch: (id, p) => update(id, (t) => patchedTaskType(t, p)),
    rename: (id, title, description) =>
      update(id, (t) => {
        const input = renamedTaskType(t, title, description)
        if ('error' in input) throw new Error(input.error)
        return input
      }),
    duplicate: (id) => write(() => taskTypeLibraryApi(window.orca).duplicate(id)),
    remove: (id) => write(async () => { await taskTypeLibraryApi(window.orca).delete(id) }),
    setDefault: (id) => write(async () => { await taskTypeLibraryApi(window.orca).setDefault(id) })
  }
}
