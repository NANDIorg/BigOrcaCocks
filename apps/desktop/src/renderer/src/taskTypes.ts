import {
  DEFAULT_ROLES, resolveRunType,
  type AgentInfo, type GlobalTask, type Role, type Run, type TaskType, type Workflow
} from '@orca-board/core'
import type { OrcaApi, Project, TaskTypesState } from '../../shared/ipc'

/**
 * Типы задач в renderer (docs/architecture.md → «Типы задач»): тип выбирается у глобальной задачи и задаёт
 * её роли. Здесь — загрузка библиотеки и правило «какие роли у задачи» с запасным путём для старого main.
 */

/**
 * `window.orca.taskTypes` или undefined: в `pnpm dev` renderer приходит по HMR, а preload может быть старым —
 * без типов. Тогда выбора типа нет, подписи ролей — встроенные (`DEFAULT_ROLES`), а разделы «Типы задач»
 * просят перезапустить приложение (`TASK_TYPES_STALE_MESSAGE`).
 */
export function taskTypesApi(api: TaskTypesHost | undefined): Pick<OrcaApi['taskTypes'], 'list'> | undefined {
  const types = api?.taskTypes
  const list = types?.list
  return typeof list === 'function' ? { list: () => list.call(types) } : undefined
}

/** Часть `window.orca` с типами; поля необязательные — preload может быть старым. */
export interface TaskTypesHost {
  taskTypes?: Partial<Pick<OrcaApi['taskTypes'], 'list'>>
}

/** Preload новый, а main старый — invoke падает с «No handler registered for 'taskTypes:…'». */
export function isStaleTaskTypesError(message: string): boolean {
  return /No handler registered for '(taskTypes:|projects:detectTaskType)/.test(message)
}

/**
 * Библиотека типов или null, если main/preload её не знают (старая версия). Прочие ошибки пробрасываются —
 * молча откатываться на встроенные роли при живых типах нельзя: подписи ролей разошлись бы с тем, что запустит main.
 */
export async function loadTaskTypes(api: TaskTypesHost | undefined): Promise<TaskTypesState | null> {
  const types = taskTypesApi(api)
  if (!types) return null
  try {
    return await types.list()
  } catch (e) {
    if (isStaleTaskTypesError(e instanceof Error ? e.message : String(e))) return null
    throw e
  }
}

/**
 * Тип проекта по умолчанию — то же правило, что `projectDefaultTypeId` в main: свой (если он есть в библиотеке),
 * иначе тип библиотеки по умолчанию, если он доступен проекту, иначе первый доступный.
 */
export function projectDefaultTypeId(project: Pick<Project, 'defaultTaskTypeId' | 'taskTypeIds'>, state: TaskTypesState): string {
  const exists = (id: string | undefined): id is string => !!id && state.taskTypes.some((t) => t.id === id)
  if (exists(project.defaultTaskTypeId)) return project.defaultTaskTypeId
  const ids = project.taskTypeIds
  if (!ids || ids.includes(state.defaultTaskTypeId)) return state.defaultTaskTypeId
  return state.taskTypes.find((t) => ids.includes(t.id))?.id ?? state.defaultTaskTypeId
}

/**
 * Типы, из которых выбирают при создании глобальной задачи: `taskTypeIds` проекта (undefined — вся
 * библиотека; висячие id пропускаются). Не осталось ни одного — тип проекта по умолчанию, как в main.
 */
export function availableTypes(project: Pick<Project, 'defaultTaskTypeId' | 'taskTypeIds'>, state: TaskTypesState): TaskType[] {
  const ids = project.taskTypeIds
  if (!ids) return state.taskTypes
  const own = state.taskTypes.filter((t) => ids.includes(t.id))
  if (own.length) return own
  const fallback = state.taskTypes.find((t) => t.id === projectDefaultTypeId(project, state))
  return fallback ? [fallback] : []
}

/**
 * Роли задачи прогона `runId` (подзадача глобальной задачи, «Входящие») — по типу прогона через общее правило
 * `resolveRunType`; нет прогона — тип проекта по умолчанию. Старый main без типов (state null) — встроенные роли:
 * ролей у проекта больше нет, а до перезапуска приложения точнее не узнать.
 */
export function rolesForRun(
  runId: string | undefined,
  runs: readonly Pick<Run, 'id' | 'typeId' | 'taskType'>[],
  project: Pick<Project, 'defaultTaskTypeId' | 'taskTypeIds'> | null | undefined,
  state: TaskTypesState | null
): Role[] {
  if (!state) return DEFAULT_ROLES
  const run = runId ? runs.find((r) => r.id === runId) : undefined
  const defaultId = project ? projectDefaultTypeId(project, state) : state.defaultTaskTypeId
  return resolveRunType(run, state.taskTypes, defaultId).roles
}

/**
 * Воркфлоу прогона `runId` — для названий этапов на карточках: снимок графа прогона (`Run.workflow`), а без него
 * граф типа по тому же правилу, что и роли. Нет типов (старый main) и нет снимка — undefined: этапы не подписываем.
 */
export function workflowForRun(
  runId: string | undefined,
  runs: readonly Pick<Run, 'id' | 'typeId' | 'taskType' | 'workflow'>[],
  project: Pick<Project, 'defaultTaskTypeId' | 'taskTypeIds'> | null | undefined,
  state: TaskTypesState | null
): Workflow | undefined {
  const run = runId ? runs.find((r) => r.id === runId) : undefined
  if (run?.workflow) return run.workflow
  if (!state) return undefined
  const defaultId = project ? projectDefaultTypeId(project, state) : state.defaultTaskTypeId
  return resolveRunType(run, state.taskTypes, defaultId).workflow
}

/** Роли типа библиотеки по умолчанию — с ними main запускает ассистента приложения. */
export function libraryDefaultRoles(state: TaskTypesState): Role[] {
  return resolveRunType(undefined, state.taskTypes, state.defaultTaskTypeId).roles
}

/**
 * Название типа для бейджа глобальной задачи: из библиотеки (тип могли переименовать), тип удалён — из снимка
 * (`GlobalTask.typeTitle`). Нет типа («Входящие», старый main) — undefined, бейдж не показывается.
 */
export function globalTypeTitle(global: Pick<GlobalTask, 'typeId' | 'typeTitle' | 'inbox'>, state: TaskTypesState | null): string | undefined {
  if (global.inbox || global.typeId === undefined) return undefined
  return state?.taskTypes.find((t) => t.id === global.typeId)?.title ?? global.typeTitle ?? global.typeId
}

/**
 * Роли типа, чей агент в проекте выключен или не установлен: тип создаётся, но воркер такой роли не
 * стартует (`assertAgentUsable` в main) — предупреждение в выборе типа. Список агентов ещё не пришёл — [].
 */
export function rolesWithDisabledAgent(type: TaskType, agents: readonly Pick<AgentInfo, 'id' | 'installed' | 'enabled'>[]): Role[] {
  if (!agents.length) return []
  const usable = new Set(agents.filter((a) => a.installed && a.enabled).map((a) => a.id))
  return (type.settings.roles ?? DEFAULT_ROLES).filter((r) => !usable.has(r.agent))
}
