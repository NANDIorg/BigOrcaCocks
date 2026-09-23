// Разделы настроек проекта, которые можно сравнить с шаблоном и выборочно взять из него.
// Чистые функции без node-импортов: модуль импортируют и main (применение), и renderer («Обзор»).
import type { AgentInfo, AgentKind } from './agents'
import { DEFAULT_COLUMNS, DEFAULT_ROLES, type BoardColumn, type Role } from './types.ts'
import { defaultWorkflow, validateWorkflow, type WfIssue, type Workflow } from './workflow.ts'

export type TemplateSection = 'agents' | 'roles' | 'columns' | 'workflow' | 'permissions' | 'agentRules'

/** Порядок разделов — как строки отличий в «Обзоре». */
export const TEMPLATE_SECTIONS: readonly TemplateSection[] = ['agents', 'roles', 'columns', 'permissions', 'agentRules', 'workflow']

export const TEMPLATE_SECTION_TITLES: Record<TemplateSection, string> = {
  agents: 'агенты',
  roles: 'роли',
  columns: 'колонки',
  workflow: 'воркфлоу',
  permissions: 'разрешения',
  agentRules: 'правила доски'
}

/**
 * Настройки по разделам — общее у проекта, дефолта и `settings` шаблона. Отсутствующее поле — встроенное
 * значение (роли — `DEFAULT_ROLES`, колонки — `DEFAULT_COLUMNS`, разрешения — `auto`, агенты — все
 * установленные, воркфлоу — `defaultWorkflow(roles)`), поэтому проект без полей равен пустому шаблону.
 * Режим разрешений — параметр: его тип живёт в desktop (`PermissionMode`), core о нём не знает.
 */
export interface SectionSettings<M extends string = string> {
  permissionMode?: M
  enabledAgents?: AgentKind[]
  roles?: Role[]
  columns?: BoardColumn[]
  agentRules?: string
  workflow?: Workflow
}

/** JSON с отсортированными ключами: сравнение ролей/колонок/графа не зависит от порядка полей. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/** Отличие списка проекта от шаблона по id. added/changed — объекты проекта, removed — объекты шаблона. */
export interface ItemsDiff<T> {
  added: T[]
  removed: T[]
  changed: T[]
  /** Тот же набор id в другом порядке. */
  reordered: boolean
}

export type SectionDiff =
  | { section: 'agents'; enabled: AgentKind[]; disabled: AgentKind[] }
  | ({ section: 'roles' } & ItemsDiff<Role>)
  | ({ section: 'columns' } & ItemsDiff<BoardColumn>)
  | { section: 'workflow' | 'permissions' | 'agentRules' }

type AgentsInfo = readonly Pick<AgentInfo, 'id' | 'title' | 'installed'>[]

function itemsDiff<T extends { id: string }>(mine: readonly T[], base: readonly T[]): ItemsDiff<T> | null {
  const baseById = new Map(base.map((x) => [x.id, x]))
  const mineIds = new Set(mine.map((x) => x.id))
  const added = mine.filter((x) => !baseById.has(x.id))
  const removed = base.filter((x) => !mineIds.has(x.id))
  const changed = mine.filter((x) => {
    const b = baseById.get(x.id)
    return b !== undefined && stableJson(x) !== stableJson(b)
  })
  const reordered =
    !added.length && !removed.length && mine.map((x) => x.id).join('\n') !== base.map((x) => x.id).join('\n')
  return added.length || removed.length || changed.length || reordered ? { added, removed, changed, reordered } : null
}

/** Включённые установленные агенты: undefined — все установленные. */
function enabledSet(list: readonly AgentKind[] | undefined, agents: AgentsInfo): Set<AgentKind> {
  return new Set(agents.filter((a) => a.installed && (list === undefined || list.includes(a.id))).map((a) => a.id))
}

/** Граф, который реально исполнится: без своего — дефолтный по ролям. */
function effectiveWorkflow(s: SectionSettings): Workflow {
  return s.workflow ?? defaultWorkflow(s.roles ?? DEFAULT_ROLES)
}

/**
 * Чем настройки проекта отличаются от шаблона — по разделам, в порядке `TEMPLATE_SECTIONS`.
 * Пустой массив — совпадают. Агенты сравниваются только среди установленных (`agents`).
 */
export function sectionsDiff(project: SectionSettings, template: SectionSettings, agents: AgentsInfo): SectionDiff[] {
  const out: SectionDiff[] = []
  const mine = enabledSet(project.enabledAgents, agents)
  const base = enabledSet(template.enabledAgents, agents)
  const enabled = [...mine].filter((id) => !base.has(id))
  const disabled = [...base].filter((id) => !mine.has(id))
  if (enabled.length || disabled.length) out.push({ section: 'agents', enabled, disabled })
  const roles = itemsDiff(project.roles ?? DEFAULT_ROLES, template.roles ?? DEFAULT_ROLES)
  if (roles) out.push({ section: 'roles', ...roles })
  const columns = itemsDiff(project.columns ?? DEFAULT_COLUMNS, template.columns ?? DEFAULT_COLUMNS)
  if (columns) out.push({ section: 'columns', ...columns })
  if ((project.permissionMode ?? 'auto') !== (template.permissionMode ?? 'auto')) out.push({ section: 'permissions' })
  if ((project.agentRules ?? '').trim() !== (template.agentRules ?? '').trim()) out.push({ section: 'agentRules' })
  // Без своих графов оба дефолтные по ролям, а отличие ролей уже показано строкой выше.
  if ((project.workflow || template.workflow) && stableJson(effectiveWorkflow(project)) !== stableJson(effectiveWorkflow(template))) {
    out.push({ section: 'workflow' })
  }
  return out
}

const quoted = (titles: string[]): string => titles.map((t) => `«${t}»`).join(', ')

function itemsLine<T extends { title: string }>(d: ItemsDiff<T>): string {
  const parts: string[] = []
  if (d.added.length) parts.push(`+${d.added.length} ${quoted(d.added.map((x) => x.title))}`)
  if (d.removed.length) parts.push(`−${d.removed.length} ${quoted(d.removed.map((x) => x.title))}`)
  if (d.changed.length) parts.push(`изменено ${d.changed.length}`)
  if (d.reordered) parts.push('порядок')
  return parts.join(', ')
}

/** Строка отличия для «Обзора»: «роли (+1 «Дизайнер», изменено 2)», «агенты (−Codex)», «разрешения». */
export function sectionDiffLine(d: SectionDiff, agents: AgentsInfo): string {
  const title = TEMPLATE_SECTION_TITLES[d.section]
  switch (d.section) {
    case 'agents': {
      const name = (id: AgentKind): string => agents.find((a) => a.id === id)?.title ?? id
      return `${title} (${[...d.enabled.map((id) => `+${name(id)}`), ...d.disabled.map((id) => `−${name(id)}`)].join(', ')})`
    }
    case 'roles':
    case 'columns':
      return `${title} (${itemsLine<{ title: string }>(d)})`
    default:
      return title
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/**
 * Обновить одну роль из шаблона: роль с тем же id заменяется на месте, новой — добавляется в конец.
 * Остальные роли проекта не трогаются. Возвращает новый массив.
 */
export function mergeRole(projectRoles: readonly Role[], templateRole: Role): Role[] {
  const role = clone(templateRole)
  const i = projectRoles.findIndex((r) => r.id === role.id)
  return i === -1 ? [...projectRoles, role] : projectRoles.map((r, j) => (j === i ? role : r))
}

/**
 * Итоговые настройки проекта после того, как разделы `sections` взяты из шаблона; на диск ничего не пишет.
 * Раздел, которого в шаблоне нет, у проекта тоже удаляется — действует встроенное значение, как у шаблона.
 * `roleIds` с разделом `roles` — взять из шаблона только эти роли (`mergeRole`); роль, которой в шаблоне
 * нет, из проекта удаляется. Граф проверяется по итоговым ролям и колонкам: если он ломается,
 * бросается ошибка с подсказкой, какой раздел применить вместе (`appliedWorkflowErrors` — без исключения).
 */
export function applySections<M extends string, P extends SectionSettings<M>>(
  project: P,
  template: SectionSettings<M>,
  sections: readonly TemplateSection[],
  roleIds?: readonly string[]
): P {
  const out: P = { ...project }
  const take = <K extends keyof SectionSettings<M>>(key: K): void => {
    const v = template[key]
    if (v === undefined) delete out[key]
    else out[key] = clone(v) as P[K]
  }
  const has = (s: TemplateSection): boolean => sections.includes(s)
  if (has('agents')) take('enabledAgents')
  if (has('roles')) {
    if (roleIds === undefined) take('roles')
    else {
      const tplRoles = template.roles ?? DEFAULT_ROLES
      let roles: Role[] = [...(project.roles ?? DEFAULT_ROLES)]
      for (const id of roleIds) {
        const tpl = tplRoles.find((r) => r.id === id)
        roles = tpl ? mergeRole(roles, tpl) : roles.filter((r) => r.id !== id)
      }
      out.roles = roles
    }
  }
  if (has('columns')) take('columns')
  if (has('permissions')) take('permissionMode')
  if (has('agentRules')) take('agentRules')
  if (has('workflow')) take('workflow')
  // Граф ссылается на роли и колонки: проверяем, только если трогали их или сам граф —
  // иначе уже битый граф проекта мешал бы применить, например, разрешения.
  if (has('roles') || has('columns') || has('workflow')) {
    const errors = appliedWorkflowErrors(out)
    if (errors.length) throw new Error(appliedWorkflowMessage(errors, sections))
  }
  return out
}

/** Ошибки графа итоговых настроек (по их ролям и колонкам); без своего графа — дефолтный, он всегда валиден. */
export function appliedWorkflowErrors(s: SectionSettings): WfIssue[] {
  if (!s.workflow) return []
  return validateWorkflow(s.workflow, { roles: s.roles ?? DEFAULT_ROLES, columns: s.columns ?? DEFAULT_COLUMNS }).errors
}

function appliedWorkflowMessage(errors: WfIssue[], sections: readonly TemplateSection[]): string {
  // Взяли граф — ему не хватает ролей/колонок шаблона; взяли роли или колонки — нужен граф шаблона под них.
  const missing = sections.includes('workflow')
    ? (['roles', 'columns'] as const).filter((s) => !sections.includes(s))
    : (['workflow'] as const)
  const hint = missing.length
    ? `; примените вместе с разделами: ${missing.map((s) => TEMPLATE_SECTION_TITLES[s]).join(', ')}`
    : ''
  return `после применения шаблона воркфлоу проекта ломается: ${errors.map((e) => e.message).join('; ')}${hint}`
}
