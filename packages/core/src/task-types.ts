// Типы задач (TaskType, docs/architecture.md → «Типы задач»): тип выбирается у глобальной задачи и задаёт её
// роли, воркфлоу, правила агентов доски и режим разрешений. У проекта остаются колонки и агенты.
// Здесь — модель типа, встроенные типы (пока строятся из встроенных шаблонов, templates.ts) и единое правило
// «какой тип у прогона» (`resolveRunType`); хранение библиотеки и миграция projects.json — в main.
// Модуль импортирует renderer, поэтому без node-импортов; значения импортируются с расширением .ts.
import type { Role, Run } from './types'
import type { Workflow } from './workflow'
import type { TemplatePermissionMode } from './templates'
import { DEFAULT_ROLES } from './types.ts'
import { defaultWorkflow } from './workflow.ts'
import { GENERAL_TEMPLATE_ID, builtinTemplates } from './templates.ts'
import { stableJson } from './template-sections.ts'

/**
 * Настройки типа — разделы шаблона проекта без проектных (колонок и агентов). Пустое поле — встроенное
 * значение: DEFAULT_ROLES, дефолтный граф по ролям, без правил, режим `auto`.
 */
export interface TaskTypeSettings {
  permissionMode?: TemplatePermissionMode
  roles?: Role[]
  /** Правила агентов доски: блок `# Правила проекта` в системном промпте (`withAgentRules`). */
  agentRules?: string
  /**
   * Граф воркфлоу. Колонки нод (`node.column`) по доске не проверяются: тип общий для проектов с разными
   * колонками, переход в неизвестную колонку исполнитель пропускает.
   */
  workflow?: Workflow
}

/**
 * Тип задачи. В отличие от шаблона проекта связь живая: прогон берёт роли типа из библиотеки при каждом
 * запуске агента, так что смена модели роли действует со следующего запуска во всех проектах.
 */
export interface TaskType {
  /** Встроенные — осмысленные ('frontend', совпадают с id встроенных шаблонов), пользовательские — сгенерированные. */
  id: string
  title: string
  /** Одна строка в списке выбора типа. */
  description?: string
  /**
   * Встроенный тип из кода: без копии меняются только поля `BUILTIN_EDITABLE_TYPE_ROLE_FIELDS` и правила
   * (`isBuiltinTypeInPlaceEdit`); обновляется вместе с приложением.
   */
  builtin?: boolean
  settings: TaskTypeSettings
}

/**
 * Снимок типа в прогоне (`Run.taskType`) — страховка, если тип удалят из библиотеки: прогон доработает на
 * ролях и правилах, с которыми был создан. Граф сюда не входит — его снимок лежит в `Run.workflow`.
 */
export interface TaskTypeSnapshot {
  id: string
  title: string
  roles: Role[]
  agentRules?: string
  permissionMode?: TemplatePermissionMode
}

/** Тип нового прогона для store (`createRun`, `createGlobalTask`): id, снимок и граф для `Run.workflow`. */
export interface RunTypeInput {
  typeId: string
  snapshot: TaskTypeSnapshot
  /** Нет — прогон без снимка графа (граф из будущей версии): пойдёт по графу типа из `runWorkflow`. */
  workflow?: Workflow
}

/** Тип с раскрытыми значениями по умолчанию — то, что нужно воркеру, координатору, воркфлоу и UI. */
export interface ResolvedTaskType {
  typeId: string
  title: string
  roles: Role[]
  /** Пусто — правил нет. */
  agentRules: string
  permissionMode: TemplatePermissionMode
  /** Граф типа — для прогонов без снимка графа (`Run.workflow`). */
  workflow: Workflow
}

/** Итог разрешения типа прогона (`resolveRunType`). */
export interface ResolvedRunType extends ResolvedTaskType {
  /**
   * Откуда взяли: `type` — тип прогона из библиотеки, `snapshot` — тип удалён, взят снимок `Run.taskType`,
   * `default` — у прогона нет типа («Входящие», старый прогон), взят тип проекта по умолчанию.
   */
  source: 'type' | 'snapshot' | 'default'
}

/** Id встроенного типа «Общий» — последний запасной тип, если тип проекта по умолчанию не найден. */
export const GENERAL_TASK_TYPE_ID = GENERAL_TEMPLATE_ID

/** Описание типа, созданного миграцией из настроек проекта (`taskTypeFromLegacyProject`). */
export const LEGACY_TASK_TYPE_DESCRIPTION = 'Перенесён из настроек проекта при переходе на типы задач'

/**
 * Встроенные типы — встроенные шаблоны без колонок и агентов, с теми же id: `templateId` старых проектов и
 * подсказка `detectTemplate` переходят в id типа без таблицы соответствий. Каждый вызов — свежие объекты.
 */
export function builtinTaskTypes(): TaskType[] {
  return builtinTemplates().map((t) => {
    const { columns: _columns, enabledAgents: _agents, ...settings } = t.settings
    return {
      id: t.id,
      title: t.title,
      ...(t.description !== undefined ? { description: t.description } : {}),
      builtin: true,
      settings
    }
  })
}

/** Встроенный тип по id (свежая копия) или undefined. */
export function builtinTaskType(id: string): TaskType | undefined {
  return builtinTaskTypes().find((t) => t.id === id)
}

/**
 * Поля роли, которые у встроенного типа правятся на месте, без «Дублировать»: исполнитель (агент, модель,
 * усилие) и системный промпт роли. Вместе с правилами агентов доски это то, что человек подгоняет под себя,
 * не меняя устройство типа (состав ролей, граф, разрешения) — поэтому `rules set` на встроенном типе не ошибка.
 */
export const BUILTIN_EDITABLE_TYPE_ROLE_FIELDS = ['agent', 'model', 'effort', 'systemPrompt'] as const

/** Роль без полей, которые у встроенного типа правятся на месте. */
function lockedTypeRolePart(r: Role): Partial<Role> {
  const rest: Partial<Role> = { ...r }
  for (const k of BUILTIN_EDITABLE_TYPE_ROLE_FIELDS) delete rest[k]
  return rest
}

/**
 * Можно ли сохранить `next` под id встроенного типа без копии: название, описание, граф и разрешения те же,
 * у ролей (тот же состав и порядок) отличаются только `BUILTIN_EDITABLE_TYPE_ROLE_FIELDS`, правила — любые.
 */
export function isBuiltinTypeInPlaceEdit(
  builtin: TaskType,
  next: Pick<TaskType, 'title' | 'description' | 'settings'>
): boolean {
  if (next.title !== builtin.title || (next.description ?? '') !== (builtin.description ?? '')) return false
  const { roles: from = DEFAULT_ROLES, agentRules: _fromRules, ...restFrom } = builtin.settings
  const { roles: to = DEFAULT_ROLES, agentRules: _toRules, ...restTo } = next.settings
  if (stableJson(restFrom) !== stableJson(restTo)) return false
  return from.length === to.length &&
    from.every((r, i) => stableJson(lockedTypeRolePart(r)) === stableJson(lockedTypeRolePart(to[i])))
}

/** Тип с раскрытыми значениями по умолчанию; роли и граф — копии, их можно править. */
export function resolveTaskType(t: TaskType): ResolvedTaskType {
  const roles = copy(t.settings.roles ?? DEFAULT_ROLES)
  return {
    typeId: t.id,
    title: t.title,
    roles,
    agentRules: t.settings.agentRules ?? '',
    permissionMode: t.settings.permissionMode ?? 'auto',
    workflow: t.settings.workflow ? copy(t.settings.workflow) : defaultWorkflow(roles)
  }
}

/** Снимок типа для `Run.taskType`. */
export function snapshotTaskType(t: TaskType): TaskTypeSnapshot {
  const r = resolveTaskType(t)
  return {
    id: r.typeId,
    title: r.title,
    roles: r.roles,
    ...(r.agentRules ? { agentRules: r.agentRules } : {}),
    ...(t.settings.permissionMode ? { permissionMode: t.settings.permissionMode } : {})
  }
}

/** Тип нового прогона для store: снимок и граф типа. */
export function runTypeInput(t: TaskType): RunTypeInput {
  return { typeId: t.id, snapshot: snapshotTaskType(t), workflow: resolveTaskType(t).workflow }
}

/**
 * Какой тип у прогона — единственное место этого правила (его зовут main и renderer):
 * `run.typeId` → тип из библиотеки `types` → снимок `run.taskType` → тип проекта по умолчанию → «Общий».
 * `types` — вся библиотека (встроенные и пользовательские); «Общий» берётся из кода, если его там нет.
 * Нет прогона («Входящие», задача без глобальной) — тип проекта по умолчанию.
 */
export function resolveRunType(
  run: Pick<Run, 'typeId' | 'taskType'> | undefined,
  types: readonly TaskType[],
  projectDefaultTypeId: string | undefined
): ResolvedRunType {
  if (run?.typeId !== undefined) {
    const own = types.find((t) => t.id === run.typeId)
    if (own) return { ...resolveTaskType(own), source: 'type' }
    if (run.taskType) {
      const snap = run.taskType
      const roles = copy(snap.roles)
      return {
        typeId: run.typeId,
        title: snap.title,
        roles,
        agentRules: snap.agentRules ?? '',
        permissionMode: snap.permissionMode ?? 'auto',
        workflow: defaultWorkflow(roles),
        source: 'snapshot'
      }
    }
  }
  const fallback =
    (projectDefaultTypeId !== undefined ? types.find((t) => t.id === projectDefaultTypeId) : undefined) ??
    types.find((t) => t.id === GENERAL_TASK_TYPE_ID) ??
    builtinTaskType(GENERAL_TASK_TYPE_ID)!
  return { ...resolveTaskType(fallback), source: 'default' }
}

/**
 * Проект старого формата (роли, граф, правила и разрешения в самом проекте) → пользовательский тип
 * «<имя проекта>». Незаданный граф фиксируется как дефолтный по ролям проекта: иначе он «поехал» бы при
 * правке ролей типа. Уникальность `title` в библиотеке обеспечивает вызывающая миграция в main.
 */
export function taskTypeFromLegacyProject(
  p: { name: string; roles?: Role[]; workflow?: Workflow; agentRules?: string; permissionMode?: TemplatePermissionMode },
  id: string
): TaskType {
  const roles = copy(p.roles ?? DEFAULT_ROLES)
  const agentRules = p.agentRules?.trim() ? p.agentRules : undefined
  return {
    id,
    title: p.name,
    description: LEGACY_TASK_TYPE_DESCRIPTION,
    settings: {
      roles,
      workflow: p.workflow ? copy(p.workflow) : defaultWorkflow(roles),
      ...(agentRules !== undefined ? { agentRules } : {}),
      ...(p.permissionMode ? { permissionMode: p.permissionMode } : {})
    }
  }
}

/** Глубокая копия JSON-данных (роли, граф): результат можно править, не портя библиотеку и снимки. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
