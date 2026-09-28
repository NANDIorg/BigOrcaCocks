import type { OrcaApi, Project, ProjectGroup } from '../../shared/ipc'
import { t } from './i18n'

/** Группа в меню вместе с проектами и итогами для заголовка. */
export interface SidebarGroup {
  group: ProjectGroup
  /** Проекты группы в порядке `projects`. */
  projects: Project[]
  collapsed: boolean
  /** Сумма бейджей «в работе» по проектам группы — виден в свёрнутом заголовке. */
  inProgress: number
  /** Активный проект лежит в этой группе: свёрнутая группа подсвечивается. */
  hasActive: boolean
}

export interface SidebarModel {
  groups: SidebarGroup[]
  /** Проекты без группы (и с id несуществующей группы) — показываются как раньше. */
  ungrouped: Project[]
}

/**
 * Список проектов для левого меню. Порядок групп и проектов — как пришёл из main; проект с `groupId`
 * неизвестной группы читается как «без группы» (контракт `Project.groupId`). Пустая группа остаётся в меню:
 * в неё можно перенести проект, её можно переименовать и удалить.
 */
export function buildSidebar(
  projects: readonly Project[],
  groups: readonly ProjectGroup[],
  inProgress: Readonly<Record<string, number>>,
  activeId: string | undefined
): SidebarModel {
  const byGroup = new Map<string, SidebarGroup>()
  const result: SidebarGroup[] = []
  for (const group of groups) {
    if (byGroup.has(group.id)) continue
    const entry: SidebarGroup = { group, projects: [], collapsed: group.collapsed === true, inProgress: 0, hasActive: false }
    byGroup.set(group.id, entry)
    result.push(entry)
  }
  const ungrouped: Project[] = []
  for (const p of projects) {
    const entry = p.groupId === undefined ? undefined : byGroup.get(p.groupId)
    if (!entry) {
      ungrouped.push(p)
      continue
    }
    entry.projects.push(p)
    entry.inProgress += inProgress[p.id] ?? 0
    if (p.id === activeId) entry.hasActive = true
  }
  return { groups: result, ungrouped }
}

/** Имя группы как его сохранит main: без пробелов по краям. Пустое — undefined (сохранять нечего). */
export function normalizeGroupName(raw: string): string | undefined {
  const name = raw.trim()
  return name === '' ? undefined : name
}

/** Группа, в которой лежит проект (`undefined` — без группы или группа неизвестна). */
export function projectGroupId(project: Project, groups: readonly ProjectGroup[]): string | undefined {
  return groups.some((g) => g.id === project.groupId) ? project.groupId : undefined
}

/** Методы групп, без которых действия невозможны: старый preload их не знает. */
const GROUP_METHODS = ['createGroup', 'renameGroup', 'removeGroup', 'setGroupCollapsed', 'setProjectGroup'] as const

export function staleGroupsMessage(): string {
  return t('shell.projects.staleApp')
}

/** `list()` старого main отдаёт только `projects` и `active` — тогда меню рисуется без групп. */
export function groupsFromList(res: { groups?: ProjectGroup[] }): ProjectGroup[] {
  return Array.isArray(res.groups) ? res.groups : []
}

/** `window.orca.projects` с методами групп или понятная ошибка вместо «is not a function». */
export function groupsApi(api: Partial<OrcaApi> | undefined): OrcaApi['projects'] {
  const projects = api?.projects
  if (!projects || GROUP_METHODS.some((m) => typeof projects[m] !== 'function')) throw new Error(staleGroupsMessage())
  return projects
}

/** Preload новый, а main старый — invoke падает с «No handler registered for 'projects:createGroup'». */
export function isStaleGroupsError(message: string): boolean {
  return /No handler registered for 'projects:(?:createGroup|renameGroup|removeGroup|setGroupCollapsed|setProjectGroup|reorderGroups)'/.test(message)
}

/** Пункт меню «Группа» проекта. `groupId: null` — «Без группы» (имя пустое, подпись подставляет UI). */
export interface GroupTarget {
  groupId: string | null
  name: string
  /** Проект уже здесь: пункт отмечен и недоступен. */
  current: boolean
}

/**
 * Куда можно перенести проект: «без группы» (если он в группе) и все группы. Текущее место — `current`.
 * «Без группы» для проекта без группы не предлагается: переносить некуда.
 */
export function groupTargets(project: Project, groups: readonly ProjectGroup[]): GroupTarget[] {
  const current = projectGroupId(project, groups)
  const targets: GroupTarget[] = groups.map((g) => ({ groupId: g.id, name: g.name, current: g.id === current }))
  if (current !== undefined) targets.unshift({ groupId: null, name: '', current: false })
  return targets
}
