import {
  DEFAULT_COLUMNS, DEFAULT_ROLES, GENERAL_TASK_TYPE_ID,
  type AgentInfo, type BoardColumn, type Role, type TaskType, type TaskTypeSettings, type Workflow
} from '@orca-board/core'
import type { OrcaApi, PermissionMode, Project, ProjectTaskTypesInput, TaskTypeInput, TaskTypesState } from '../../shared/ipc'
import { t } from './i18n'

// Логика «Настройки → Типы задач» (settings/TaskTypePane.tsx) и «О проекте → Типы задач»
// (about/TaskTypesSection.tsx): без React, чтобы тестировать node --test.

/**
 * Renderer приходит по HMR, а main и preload остаются старыми до перезапуска: у старого preload нет
 * `window.orca.taskTypes` и `projects.setTaskTypes`, у старого main — хендлеров `taskTypes:*`.
 */
export function taskTypesStaleMessage(): string {
  return t('config.taskType.stale')
}

/** `window.orca.taskTypes` или понятная ошибка вместо «Cannot read properties of undefined». */
export function taskTypeLibraryApi(api: Partial<OrcaApi> | undefined): OrcaApi['taskTypes'] {
  if (!api?.taskTypes) throw new Error(taskTypesStaleMessage())
  return api.taskTypes
}

/** Есть ли у preload выбор типов проекта (`projects.setTaskTypes`). */
export function hasProjectTaskTypes(api: Partial<OrcaApi> | undefined): boolean {
  return !!api?.taskTypes && typeof api.projects?.setTaskTypes === 'function'
}

/** Текст ошибки IPC для раздела: preload новый, а main старый — «перезапустите приложение». */
export function taskTypesError(message: string): string {
  return /No handler registered for '(taskTypes:|projects:setTaskTypes)/.test(message) ? taskTypesStaleMessage() : message
}

/** Ключ запомненного раздела «Настроек»; «О проекте → Типы задач» ставит в него тип кнопкой «Изменить в Настройках». */
export const SETTINGS_SECTION_KEY = 'orca.settingsSection'

/** Раздел «Настроек» с типом `id`. */
export function settingsTypeSection(id: string): `type:${string}` {
  return `type:${id}`
}

/** Вкладки редактора типа. Колонок и агентов у типа нет — они у проекта («О проекте»). */
export type TaskTypeTab = 'roles' | 'workflow' | 'perm' | 'rules'
export const TASK_TYPE_TABS: readonly TaskTypeTab[] = ['roles', 'workflow', 'perm', 'rules']

/** Настройки типа с встроенными значениями вместо незаданных — то, с чем пойдёт глобальная задача. */
export interface ResolvedTypeSettings {
  permissionMode: PermissionMode
  roles: Role[]
  /** Нет правил — ''. */
  agentRules: string
  /** Нет своего графа — дефолтный по ролям типа (его строит редактор). */
  workflow?: Workflow
}

export function resolveTypeSettings(s: TaskTypeSettings): ResolvedTypeSettings {
  return {
    permissionMode: s.permissionMode ?? 'auto',
    roles: s.roles ?? DEFAULT_ROLES,
    agentRules: s.agentRules ?? '',
    ...(s.workflow ? { workflow: s.workflow } : {})
  }
}

/** Правка настроек типа: null удаляет поле (= встроенное значение), undefined — не трогать. */
export type TaskTypePatch = { [K in keyof TaskTypeSettings]?: TaskTypeSettings[K] | null }

/**
 * `taskTypes:save` заменяет тип целиком — собираем полный TaskTypeInput из текущего типа и правки.
 * Правила из одних пробелов удаляют поле.
 */
export function patchedTaskType(t: TaskType, patch: TaskTypePatch): TaskTypeInput {
  const settings: Record<string, unknown> = { ...t.settings }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v === null || (k === 'agentRules' && typeof v === 'string' && !v.trim())) delete settings[k]
    else settings[k] = v
  }
  return {
    id: t.id, title: t.title, ...(t.description ? { description: t.description } : {}),
    settings: settings as TaskTypeSettings
  }
}

/** Переименование: пустое название — ошибка (текст для формы), пустое описание убирает поле. */
export function renamedTaskType(type: TaskType, title: string, description: string): TaskTypeInput | { error: string } {
  const name = title.trim()
  if (!name) return { error: t('config.taskType.emptyTitle') }
  const desc = description.trim()
  return { id: type.id, title: name, ...(desc ? { description: desc } : {}), settings: type.settings }
}

/**
 * Ключ черновиков редакторов типа (`useAutoSave`, `key` компонентов): свой у каждого типа, чтобы черновик одного
 * типа не попал в другой при переключении.
 */
export function typeEditorKey(t: Pick<TaskType, 'id'>): string {
  return `type:${t.id}`
}

/** Где тип используется: по умолчанию в проектах и доступен в проектах (`taskTypeIds` нет — доступны все). */
export interface TypeUsage {
  asDefault: number
  available: number
}

/**
 * Использование типов проектами: тип проекта по умолчанию — по тому же правилу, что в main
 * (`projectDefaultTypeId`), доступность — по `taskTypeIds`.
 */
export function taskTypeUsage(projects: readonly Project[], state: TaskTypesState): Record<string, TypeUsage> {
  const usage: Record<string, TypeUsage> = {}
  const ids = state.taskTypes.map((t) => t.id)
  for (const id of ids) usage[id] = { asDefault: 0, available: 0 }
  for (const p of projects) {
    const def = projectDefaultTypeId(p, state)
    if (usage[def]) usage[def].asDefault++
    for (const id of ids) if (!p.taskTypeIds || p.taskTypeIds.includes(id)) usage[id].available++
  }
  return usage
}

/** Выбранный тип: запомненный, если он ещё есть, иначе тип библиотеки по умолчанию. */
export function pickTaskTypeId(state: TaskTypesState, wanted: string | null | undefined): string {
  return wanted && state.taskTypes.some((t) => t.id === wanted) ? wanted : state.defaultTaskTypeId
}

/** Агенты реестра с «включённостью» во всех проектах сразу: у типа своих агентов нет, включены — установленные. */
export function libraryAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.map((a) => ({ ...a, enabled: a.installed }))
}

/**
 * Колонки для выбора в нодах графа типа: встроенные и колонки всех проектов без повторов по id. Проверка «колонки
 * нет на доске» для типа не делается — тип общий для проектов с разными досками.
 */
export function typeColumnChoices(projects: readonly Project[]): BoardColumn[] {
  const out: BoardColumn[] = [...DEFAULT_COLUMNS]
  for (const p of projects) for (const c of p.columns ?? []) if (!out.some((x) => x.id === c.id)) out.push(c)
  return out
}

/** Подтверждение удаления типа — панель в шапке типа, не `confirm()`. */
export interface TypeRemovalConfirm {
  title: string
  /** Последствия, по пункту на строку. */
  lines: string[]
  /** Надпись кнопки подтверждения. */
  action: string
}

/**
 * Что станет с проектами и глобальными задачами после удаления типа. Одинаково для любого типа, включая заготовки:
 * удалённый тип не вернётся и после перезапуска. Новый тип по умолчанию — по правилу main (`defaultTaskTypeId`):
 * «Программирование», а без него — первый оставшийся.
 */
export function typeRemovalConfirm(type: TaskType, state: TaskTypesState, usage: TypeUsage | undefined): TypeRemovalConfirm {
  const lines: string[] = []
  if (state.defaultTaskTypeId === type.id) {
    const rest = state.taskTypes.filter((x) => x.id !== type.id)
    const next = rest.find((x) => x.id === GENERAL_TASK_TYPE_ID) ?? rest[0]
    if (next) lines.push(t('config.taskType.remove.newDefault', { title: next.title }))
  }
  if (usage?.asDefault) lines.push(t('config.taskType.remove.projects', { n: usage.asDefault }))
  lines.push(t('config.taskType.remove.snapshot'))
  lines.push(t('config.taskType.remove.permanent'))
  return { title: t('config.taskType.remove.title', { title: type.title }), lines, action: t('config.taskType.remove.action') }
}

// ---------- «О проекте → Типы задач» ----------

/** Тип проекта по умолчанию, как его видит main: свой (если есть в библиотеке и доступен), иначе библиотечный. */
export function projectDefaultTypeId(p: Pick<Project, 'defaultTaskTypeId' | 'taskTypeIds'>, state: TaskTypesState): string {
  const exists = (id: string | undefined): id is string => !!id && state.taskTypes.some((t) => t.id === id)
  if (exists(p.defaultTaskTypeId)) return p.defaultTaskTypeId
  const lib = state.defaultTaskTypeId
  if (!p.taskTypeIds || p.taskTypeIds.includes(lib)) return lib
  return state.taskTypes.find((t) => p.taskTypeIds!.includes(t.id))?.id ?? lib
}

/** Доступен ли тип проекту: `taskTypeIds` нет — доступны все типы библиотеки (висячие id не в счёт). */
export function isTypeAvailable(p: Pick<Project, 'taskTypeIds'>, id: string): boolean {
  return !p.taskTypeIds || p.taskTypeIds.includes(id)
}

/**
 * Включить или выключить тип в проекте. Первое снятие галочки при «все типы» превращает список в явный.
 * Нельзя выключить тип по умолчанию и последний доступный — ошибка с текстом для раздела.
 */
export function toggledProjectTypes(
  p: Pick<Project, 'defaultTaskTypeId' | 'taskTypeIds'>, state: TaskTypesState, id: string, on: boolean
): ProjectTaskTypesInput | { error: string } {
  const all = state.taskTypes.map((t) => t.id)
  const current = all.filter((x) => isTypeAvailable(p, x))
  const def = projectDefaultTypeId(p, state)
  const next = on ? all.filter((x) => x === id || current.includes(x)) : current.filter((x) => x !== id)
  if (!on && id === def) return { error: t('config.taskType.toggle.defaultOff') }
  if (!next.length) return { error: t('config.taskType.toggle.lastOne') }
  return { typeIds: next.length === all.length ? null : next, defaultTypeId: def }
}

/** «Все типы библиотеки» (в том числе будущие) или явный список из текущих доступных. */
export function allTypesInput(
  p: Pick<Project, 'defaultTaskTypeId' | 'taskTypeIds'>, state: TaskTypesState, all: boolean
): ProjectTaskTypesInput {
  const def = projectDefaultTypeId(p, state)
  return { typeIds: all ? null : state.taskTypes.map((t) => t.id).filter((x) => isTypeAvailable(p, x)), defaultTypeId: def }
}

/** Сделать тип типом проекта по умолчанию; недоступный — сначала включается. */
export function defaultTypeInput(p: Pick<Project, 'taskTypeIds'>, id: string): ProjectTaskTypesInput {
  const typeIds = p.taskTypeIds ? (p.taskTypeIds.includes(id) ? p.taskTypeIds : [...p.taskTypeIds, id]) : null
  return { typeIds, defaultTypeId: id }
}

/** Роли типа, чей агент выключен в проекте: такая роль не запустится в этом проекте (`assertAgentUsable`). */
export function rolesWithAgentOff(roles: readonly Role[], agents: readonly AgentInfo[]): Role[] {
  const on = new Set(agents.filter((a) => a.enabled).map((a) => a.id as string))
  return roles.filter((r) => !on.has(r.agent))
}

/** Роли для фильтра уведомлений: роли всех типов библиотеки, первый встреченный title на id. */
export function libraryRoles(types: readonly TaskType[]): Role[] {
  const out: Role[] = []
  for (const t of types) for (const r of t.settings.roles ?? DEFAULT_ROLES) if (!out.some((x) => x.id === r.id)) out.push(r)
  return out
}
