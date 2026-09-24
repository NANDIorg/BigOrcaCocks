import { canChangeRunType, type ColumnKind, type GlobalTask, type TaskType } from '@orca-board/core'
import type { OrcaApi } from '../../shared/ipc'

/**
 * Смена типа глобальной задачи в модалке правки (docs/nested-kanban.md → «Тип задачи»): пока задача не начата
 * (`canChangeRunType` из core — то же правило, что проверит main), тип — селект; после — только бейдж.
 */

export const STALE_TYPE_CHANGE_MESSAGE = 'Приложение запущено со старой версией main/preload, где тип задачи ещё нельзя сменить. Перезапустите приложение.'

/**
 * Варианты селекта типа при правке или undefined — тип только показывается (задача начата, «Входящие», старый main
 * без типов). Текущий тип, которого нет среди доступных проекту (убрали из проекта или удалили), остаётся первым
 * вариантом с названием из снимка — иначе селект молча показал бы чужой тип.
 */
export function typeChangeOptions(
  global: Pick<GlobalTask, 'inbox' | 'startedAt' | 'coordinatorPtyId' | 'progress' | 'typeId'>,
  statusKind: ColumnKind | undefined,
  types: readonly TaskType[] | undefined,
  currentTitle?: string
): { id: string; title: string }[] | undefined {
  if (!types || types.length === 0) return undefined
  const allowed = canChangeRunType({
    inbox: global.inbox,
    startedAt: global.startedAt,
    coordinatorPtyId: global.coordinatorPtyId,
    subtasks: global.progress.total,
    statusKind
  })
  if (!allowed) return undefined
  const options = types.map((t) => ({ id: t.id, title: t.title }))
  const cur = global.typeId
  if (cur !== undefined && !options.some((o) => o.id === cur)) options.unshift({ id: cur, title: currentTitle ?? cur })
  return options
}

/**
 * `globalTasks.changeType` или ошибка «перезапустите приложение»: renderer обновляется по HMR раньше preload и main.
 * Новый preload со старым main падает на invoke «No handler registered» — её тоже переводим в понятное сообщение.
 */
export function changeTypeApi(api: { globalTasks?: Partial<OrcaApi['globalTasks']> } | undefined): OrcaApi['globalTasks']['changeType'] {
  const globalTasks = api?.globalTasks
  const fn = globalTasks?.changeType
  if (typeof fn !== 'function') throw new Error(STALE_TYPE_CHANGE_MESSAGE)
  return async (id, typeId) => {
    try {
      return await fn.call(globalTasks, id, typeId)
    } catch (e) {
      if (/No handler registered for 'globalTasks:changeType'/.test(e instanceof Error ? e.message : String(e))) {
        throw new Error(STALE_TYPE_CHANGE_MESSAGE)
      }
      throw e
    }
  }
}
