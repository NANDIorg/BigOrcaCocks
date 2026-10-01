// Типы задач (TaskType, docs/architecture.md → «Типы задач»): тип выбирается у глобальной задачи и задаёт её
// роли, воркфлоу, правила агентов доски и режим разрешений. У проекта остаются колонки и агенты.
// Здесь — модель типа, заготовки типов и единое правило «какой тип у прогона» (`resolveRunType`);
// хранение библиотеки и миграция projects.json — в main.
// Модуль импортирует renderer, поэтому без node-импортов; значения импортируются с расширением .ts.
import type { Role, Run } from './types'
import type { WfMigrationNote, Workflow } from './workflow'
import { DEFAULT_ROLES } from './types.ts'
import { defaultWorkflow } from './workflow.ts'
import { makeTaskTypePresets } from './task-type-presets.ts'
import { ASSISTANT_ROLE_ID } from './prompts.ts'

/** Режим разрешений типа задачи; адаптер CLI переводит его в свои настройки. Список совпадает с `PermissionMode` в desktop. */
export type TaskTypePermissionMode = 'auto' | 'bypassPermissions' | 'acceptEdits'

/**
 * Настройки типа. Колонок и агентов тут нет — они у проекта. Пустое поле — встроенное значение:
 * DEFAULT_ROLES, дефолтный граф по ролям, без правил, режим `auto`.
 */
export interface TaskTypeSettings {
  permissionMode?: TaskTypePermissionMode
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
 * Тип задачи. Связь живая: прогон берёт роли типа из библиотеки при каждом запуске агента, так что смена
 * модели роли действует со следующего запуска во всех проектах.
 */
export interface TaskType {
  /**
   * У заготовок (`presetTaskTypes`) — осмысленные ('frontend'; совпадают с id бывших встроенных шаблонов проектов,
   * поэтому старые проекты мигрируют без таблицы соответствий), у созданных человеком — сгенерированные.
   */
  id: string
  title: string
  /** Одна строка в списке выбора типа. */
  description?: string
  settings: TaskTypeSettings
  /**
   * Что изменила автомиграция графа типа при загрузке (v1 → v2: снят `merge`, `condition: role`…) — предупреждения
   * человеку, по-русски, для показа как есть. Живут, пока граф не правят (или пока человек их не убрал), и в прогоны
   * не копируются: это состояние типа, а не его настройка.
   */
  workflowNotes?: WfMigrationNote[]
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
  permissionMode?: TaskTypePermissionMode
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
  permissionMode: TaskTypePermissionMode
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

/**
 * Id заготовки «Программирование»: предпочтительный запасной тип, если тип по умолчанию удалён. Сам тип тоже
 * можно удалить — тогда запасной тип первый в библиотеке (`resolveRunType`, `defaultTaskTypeId` в main).
 */
export const GENERAL_TASK_TYPE_ID = 'general'

/** Описание типа, созданного миграцией из настроек проекта (`taskTypeFromLegacyProject`). */
export const LEGACY_TASK_TYPE_DESCRIPTION = 'Перенесён из настроек проекта при переходе на типы задач'

/**
 * Заготовки типов — обычные типы, которые main один раз кладёт в библиотеку нового пользователя (`seededTaskTypes`
 * в apps/desktop/src/main/projects.ts). Дальше они живут в projects.json наравне с созданными человеком: правятся,
 * удаляются и не возвращаются после удаления; новая версия приложения их не перетирает. Функция, а не константа:
 * каждый вызов отдаёт свежие объекты. Порядок — порядок в библиотеке после засева. Id менять нельзя: на них
 * ссылаются старые проекты и прогоны, а засев сверяет по ним уже существующие типы.
 */
export function presetTaskTypes(): TaskType[] {
  return makeTaskTypePresets(GENERAL_TASK_TYPE_ID)
}

/** Заготовка по id (свежая копия) или undefined. */
export function presetTaskType(id: string): TaskType | undefined {
  return presetTaskTypes().find((t) => t.id === id)
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
 * `run.typeId` → тип из библиотеки `types` → снимок `run.taskType` → тип проекта по умолчанию → «Программирование»
 * → первый тип библиотеки. Заготовка «Программирование» из кода — только если библиотека пуста (main этого не
 * допускает, но renderer со старым main может передать пустой список).
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
      // Снимки прогонов до переноса ассистента в настройки приложения ещё несут роль assistant — ролью типа она не бывает.
      const roles = copy(snap.roles.filter((r) => r.id !== ASSISTANT_ROLE_ID))
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
    types[0] ??
    presetTaskType(GENERAL_TASK_TYPE_ID)!
  return { ...resolveTaskType(fallback), source: 'default' }
}

/**
 * Проект старого формата (роли, граф, правила и разрешения в самом проекте) → пользовательский тип
 * «<имя проекта>». Незаданный граф фиксируется как дефолтный по ролям проекта: иначе он «поехал» бы при
 * правке ролей типа. Уникальность `title` в библиотеке обеспечивает вызывающая миграция в main.
 */
export function taskTypeFromLegacyProject(
  p: { name: string; roles?: Role[]; workflow?: Workflow; agentRules?: string; permissionMode?: TaskTypePermissionMode },
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
