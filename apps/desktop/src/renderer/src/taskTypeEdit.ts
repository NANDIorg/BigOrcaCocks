import {
  DEFAULT_COLUMNS, DEFAULT_ROLES, GENERAL_TASK_TYPE_ID, builtinTaskType, builtinTaskTypes,
  type AgentInfo, type BoardColumn, type Role, type TaskType, type TaskTypeSettings, type Workflow
} from '@orca-board/core'
import type { OrcaApi, PermissionMode, Project, ProjectTaskTypesInput, TaskTypeInput, TaskTypesState } from '../../shared/ipc'

// Логика «Настройки → Типы задач» (settings/TaskTypePane.tsx) и «О проекте → Типы задач»
// (about/TaskTypesSection.tsx): без React, чтобы тестировать node --test.

/**
 * Renderer приходит по HMR, а main и preload остаются старыми до перезапуска: у старого preload нет
 * `window.orca.taskTypes` и `projects.setTaskTypes`, у старого main — хендлеров `taskTypes:*`.
 */
export const TASK_TYPES_STALE_MESSAGE =
  'Приложение запущено со старой версией main/preload, где ещё нет типов задач. Перезапустите приложение.'

/** `window.orca.taskTypes` или понятная ошибка вместо «Cannot read properties of undefined». */
export function taskTypeLibraryApi(api: Partial<OrcaApi> | undefined): OrcaApi['taskTypes'] {
  if (!api?.taskTypes) throw new Error(TASK_TYPES_STALE_MESSAGE)
  return api.taskTypes
}

/** Есть ли у preload выбор типов проекта (`projects.setTaskTypes`). */
export function hasProjectTaskTypes(api: Partial<OrcaApi> | undefined): boolean {
  return !!api?.taskTypes && typeof api.projects?.setTaskTypes === 'function'
}

/** Текст ошибки IPC для раздела: preload новый, а main старый — «перезапустите приложение». */
export function taskTypesError(message: string): string {
  return /No handler registered for '(taskTypes:|projects:setTaskTypes)/.test(message) ? TASK_TYPES_STALE_MESSAGE : message
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
export function renamedTaskType(t: TaskType, title: string, description: string): TaskTypeInput | { error: string } {
  const name = title.trim()
  if (!name) return { error: 'Название типа не может быть пустым' }
  const desc = description.trim()
  return { id: t.id, title: name, ...(desc ? { description: desc } : {}), settings: t.settings }
}

const BUILTIN_IDS = builtinTaskTypes().map((t) => t.id)

/**
 * Пользовательская копия встроенного с тем же id («изменённый встроенный» — после любой правки встроенного):
 * удаление — «Сбросить к системному», оно вернёт встроенный, а не уберёт тип из списка.
 */
export function overridesBuiltinType(t: Pick<TaskType, 'id' | 'builtin'>): boolean {
  return !t.builtin && BUILTIN_IDS.includes(t.id)
}

/** Встроенный или его изменённая копия: удалить нельзя, можно сбросить к системному. */
export function isBuiltinLike(t: Pick<TaskType, 'id' | 'builtin'>): boolean {
  return !!t.builtin || overridesBuiltinType(t)
}

/**
 * Группы меню: встроенные (и изменённые встроенные — на своём месте, чтобы правка встроенного не уносила пункт
 * в «Свои») и свои. Порядок внутри групп — как отдал main.
 */
export function splitTaskTypes(types: readonly TaskType[]): { builtin: TaskType[]; own: TaskType[] } {
  return { builtin: types.filter(isBuiltinLike), own: types.filter((t) => !isBuiltinLike(t)) }
}

/**
 * Ключ черновиков редакторов типа (`useAutoSave`, `key` компонентов). Для встроенного и его изменённой копии
 * ключ один: первая правка превращает встроенный в копию с тем же id, и черновик не должен сбрасываться посреди
 * быстрых кликов. После «Сбросить к системному» редакторы пересоздаёт `rev` (см. TaskTypePane).
 */
export function typeEditorKey(t: Pick<TaskType, 'id' | 'builtin'>, rev = 0): string {
  return `type:${t.id}:${isBuiltinLike(t) ? 'b' : 'u'}:${rev}`
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

/** Подтверждение удаления типа или сброса изменённого встроенного — панель в шапке типа, не `confirm()`. */
export interface TypeRemovalConfirm {
  title: string
  /** Последствия, по пункту на строку. */
  lines: string[]
  /** Надпись кнопки подтверждения. */
  action: string
}

/**
 * Что станет с проектами и глобальными задачами после удаления типа. Для изменённого встроенного это «Сбросить
 * к системному»: id тот же, проекты остаются на нём, а задачи сразу получают системные роли — тип-то жив.
 */
export function typeRemovalConfirm(t: TaskType, state: TaskTypesState, usage: TypeUsage | undefined): TypeRemovalConfirm {
  if (overridesBuiltinType(t)) {
    const system = builtinTaskType(t.id)?.title ?? t.id
    return {
      title: `Сбросить «${t.title}» к системному?`,
      lines: [
        `Ваши правки пропадут: название, описание, роли, воркфлоу, разрешения и правила вернутся к встроенному типу «${system}» из текущей версии приложения.`,
        'Проекты, где он доступен или выбран по умолчанию, останутся на нём.',
        'Уже созданные глобальные задачи идут по своему воркфлоу, а роли и правила возьмут системные со следующего запуска агента.'
      ],
      action: 'Сбросить'
    }
  }
  const lines: string[] = []
  if (state.defaultTaskTypeId === t.id) lines.push(`Это тип по умолчанию библиотеки — им станет «${builtinTaskType(GENERAL_TASK_TYPE_ID)?.title ?? GENERAL_TASK_TYPE_ID}».`)
  if (usage?.asDefault) lines.push(`Он тип по умолчанию в проектах (${usage.asDefault}): они перейдут на тип библиотеки по умолчанию.`)
  lines.push('Уже созданные глобальные задачи этого типа доработают по снимку ролей, сохранённому при создании.')
  return { title: `Удалить тип «${t.title}»?`, lines, action: 'Удалить' }
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
  if (!on && id === def) return { error: 'Тип по умолчанию нельзя выключить — сначала сделайте по умолчанию другой тип.' }
  if (!next.length) return { error: 'В проекте должен остаться хотя бы один тип.' }
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
