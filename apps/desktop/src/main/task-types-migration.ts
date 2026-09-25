// Миграция projects.json на типы задач (docs/architecture.md → «Типы задач»): роли, граф, правила агентов
// и разрешения уходят из проекта в пользовательский тип «<имя проекта>», шаблоны проектов становятся типами.
// Чистая функция без ФС — её вызывает `ProjectManager.load()` после нормализации старого формата, а тесты — напрямую.
import {
  DEFAULT_ROLES, WORKFLOW_VERSION, migrateWorkflowReport, presetTaskTypes, taskTypeFromLegacyProject,
  type Role, type TaskType, type TaskTypePermissionMode, type WfMigrationNote, type Workflow
} from '@orca-board/core'
import type { Project, ProjectsFile } from './projects'

/** Версия формата projects.json с типами задач; нет поля или меньше — старый формат, его переводит миграция. */
export const PROJECTS_FILE_VERSION = 2

/**
 * Поля проекта старого формата — после миграции они живут в его типе «<имя проекта>». Ещё было поле id
 * шаблона проекта: оно не переносится и отбрасывается вместе с прочими неизвестными полями (`stripLegacy`).
 */
export interface LegacyProjectFields {
  permissionMode?: TaskTypePermissionMode
  roles?: Role[]
  agentRules?: string
  workflow?: Workflow
}

/**
 * projects.json старого формата после нормализации в `load()`: пользовательские шаблоны уже проверены и
 * без колонок и агентов (это готовые типы), старый `defaults` уже перенесён в тип `general`.
 */
export interface LegacyProjectsFile extends Omit<ProjectsFile, 'projects'> {
  projects: Array<Project & LegacyProjectFields>
  templates?: TaskType[]
  defaultTemplateId?: string
}

/**
 * Id типа, в который переносятся настройки проекта. Id проекта — sha1 корня репозитория, так что id типа
 * стабилен (повторная миграция того же проекта даёт тот же тип) и не пересекается с другими.
 */
export function legacyTaskTypeId(projectId: string): string {
  return `type_${projectId}`
}

/**
 * Перевести файл на типы задач. Уже переведённый (`version` 2) возвращается как есть с `changed: false`.
 * - шаблоны → типы с теми же id (копии встроенных при засеве заменят одноимённые заготовки, `seededTaskTypes`), `defaultTemplateId` →
 *   `defaultTaskTypeId`;
 * - каждый проект → тип «<имя проекта>» (роли, граф, правила, разрешения; незаданное — встроенные значения,
 *   граф фиксируется, см. `taskTypeFromLegacyProject`). Тип становится типом проекта по умолчанию и
 *   запоминается в `legacyTypeId` — его получат старые прогоны доски при её загрузке (`assignRunTypes`).
 *   Доступны проекту все типы библиотеки (`taskTypeIds` не задаётся). Старые поля проекта удаляются.
 * Правило одно для всех проектов, даже без своих настроек: так у любой старой доски есть тип для её прогонов.
 */
export function migrateProjectsFile(input: LegacyProjectsFile): { data: ProjectsFile; changed: boolean } {
  if (input.version !== undefined && input.version >= PROJECTS_FILE_VERSION) {
    const { templates: _t, defaultTemplateId: _d, ...rest } = input
    return { data: { ...rest, projects: input.projects.map(stripLegacy) }, changed: false }
  }
  const types: TaskType[] = [...(input.taskTypes ?? [])]
  for (const t of input.templates ?? []) if (!types.some((x) => x.id === t.id)) types.push(t)
  // Названия заготовок тоже заняты (их засеет `load()`): тип «Программирование» из проекта с таким именем путал бы выбор типа.
  const titles = new Set([...presetTaskTypes().map((t) => t.title), ...types.map((t) => t.title)])
  const projects = input.projects.map((p) => {
    const id = legacyTaskTypeId(p.id)
    if (!types.some((t) => t.id === id)) {
      const type = taskTypeFromLegacyProject(
        { name: uniqueTitle(p.name, titles), roles: p.roles, workflow: p.workflow, agentRules: p.agentRules, permissionMode: p.permissionMode },
        id
      )
      titles.add(type.title)
      types.push(type)
    }
    return { ...stripLegacy(p), defaultTaskTypeId: id, legacyTypeId: id }
  })
  const { templates: _templates, defaultTemplateId, ...rest } = input
  const defaultTaskTypeId = input.defaultTaskTypeId ?? defaultTemplateId
  return {
    data: {
      ...rest,
      projects,
      ...(types.length ? { taskTypes: types } : {}),
      ...(defaultTaskTypeId ? { defaultTaskTypeId } : {}),
      version: PROJECTS_FILE_VERSION
    },
    changed: true
  }
}

/** Пометки миграции графа при повторном заходе не дублируются: одинаковые (код, нода, текст) склеиваются. */
function mergedNotes(old: readonly WfMigrationNote[] | undefined, added: readonly WfMigrationNote[]): WfMigrationNote[] {
  const out = [...(old ?? [])]
  for (const n of added) {
    if (!out.some((x) => x.code === n.code && x.nodeId === n.nodeId && x.message === n.message)) out.push(n)
  }
  return out
}

/**
 * Перевести графы типов на `WORKFLOW_VERSION` (v1 «по подзадачам» → v2 «по глобальной задаче», `migrateWorkflowReport`)
 * и записать, что при этом изменилось, в `TaskType.workflowNotes` — человек увидит это в редакторе типа. Роли для
 * миграции — роли самого типа (`settings.roles`, нет — встроенные): по ним `ask` без роли получает рабочую.
 * Граф текущей или будущей версии не трогается (будущий не исполним — «обновите приложение»), тип без графа —
 * тоже: его граф строится по ролям в рантайме. Идемпотентна: повторный вызов ничего не меняет. `changed` — есть ли
 * что записать в projects.json. Копии графа в прогонах (`Run.workflow`) сюда не входят и остаются как были:
 * идущие прогоны без `workflowScope` доживают на старом движке.
 */
export function migrateTypeWorkflows(types: readonly TaskType[]): { types: TaskType[]; changed: boolean } {
  let changed = false
  const out = types.map((t) => {
    const wf = t.settings.workflow
    if (!wf || !(wf.version < WORKFLOW_VERSION)) return t
    const { workflow, notes } = migrateWorkflowReport(wf, t.settings.roles ?? DEFAULT_ROLES)
    changed = true
    const workflowNotes = mergedNotes(t.workflowNotes, notes)
    const { workflowNotes: _old, ...rest } = t
    return { ...rest, settings: { ...t.settings, workflow }, ...(workflowNotes.length ? { workflowNotes } : {}) }
  })
  return { types: out, changed }
}

/**
 * Проект только с полями нового формата. Белый список, а не удаление старых полей по именам: так из файла
 * уходят и поля, о которых новая версия не знает (id шаблона проекта и т. п.).
 */
function stripLegacy(p: Project & LegacyProjectFields): Project {
  const { id, root, name, groupId, enabledAgents, columns, taskTypeIds, defaultTaskTypeId, legacyTypeId } = p
  return {
    id, root, name,
    ...(groupId !== undefined ? { groupId } : {}),
    ...(enabledAgents !== undefined ? { enabledAgents } : {}),
    ...(columns !== undefined ? { columns } : {}),
    ...(taskTypeIds !== undefined ? { taskTypeIds } : {}),
    ...(defaultTaskTypeId !== undefined ? { defaultTaskTypeId } : {}),
    ...(legacyTypeId !== undefined ? { legacyTypeId } : {})
  }
}

/** `name`, а если занято — `name (2)`, `name (3)`… */
function uniqueTitle(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  let n = 2
  while (taken.has(`${name} (${n})`)) n += 1
  return `${name} (${n})`
}
