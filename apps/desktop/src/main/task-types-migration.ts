// Миграция projects.json на типы задач (docs/architecture.md → «Типы задач»): роли, граф, правила агентов
// и разрешения уходят из проекта в пользовательский тип «<имя проекта>», шаблоны проектов становятся типами.
// Чистая функция без ФС — её вызывает `ProjectManager.load()` после нормализации старого формата, а тесты — напрямую.
import {
  builtinTaskTypes, taskTypeFromLegacyProject,
  type Role, type TaskType, type TemplatePermissionMode, type Workflow
} from '@orca-board/core'
import type { Project, ProjectsFile } from './projects'

/** Версия формата projects.json с типами задач; нет поля или меньше — старый формат, его переводит миграция. */
export const PROJECTS_FILE_VERSION = 2

/** Поля проекта старого формата — после миграции они живут в его типе «<имя проекта>». */
export interface LegacyProjectFields {
  permissionMode?: TemplatePermissionMode
  roles?: Role[]
  agentRules?: string
  workflow?: Workflow
  templateId?: string
}

/**
 * projects.json старого формата после нормализации в `load()`: пользовательские шаблоны уже проверены и
 * без колонок и агентов (это готовые типы), старый `defaults` уже перенесён в «Общий».
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
 * - шаблоны → типы с теми же id (копии встроенных остаются подменами встроенных типов), `defaultTemplateId` →
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
  // Названия встроенных тоже заняты: тип «Общий» из проекта с таким именем путал бы выбор типа.
  const titles = new Set([...builtinTaskTypes().map((t) => t.title), ...types.map((t) => t.title)])
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

/** Проект без полей старого формата. */
function stripLegacy(p: Project & LegacyProjectFields): Project {
  const { permissionMode: _pm, roles: _r, agentRules: _ar, workflow: _wf, templateId: _tpl, ...rest } = p
  return rest
}

/** `name`, а если занято — `name (2)`, `name (3)`… */
function uniqueTitle(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  let n = 2
  while (taken.has(`${name} (${n})`)) n += 1
  return `${name} (${n})`
}
