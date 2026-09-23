import {
  DEFAULT_COLUMNS, DEFAULT_ROLES, TEMPLATE_SECTIONS, applySections, sectionDiffLine, sectionsDiff,
  type AgentInfo, type ProjectTemplate, type ProjectTemplateSettings, type Role, type SectionSettings,
  type TemplateSection, type Workflow
} from '@orca-board/core'
import type { OrcaApi, Project, TemplatesState } from '../../shared/ipc'
import { removalConsequences } from './roleRemoval'

// «Тип проекта» в «О проекте → Обзор»: с каким шаблоном сравнивать проект, строки отличий с кнопкой
// «Взять из шаблона» и последствия применения до клика. Применяет main (`projects:applyTemplate`),
// здесь — только предпросмотр теми же функциями core, что и в main (`applySections`, `sectionsDiff`).

/** Как `STALE_APP_MESSAGE` в docLinks.ts: renderer пришёл по HMR, а main/preload ещё без шаблонов. */
export const TEMPLATES_STALE_MESSAGE =
  'Приложение запущено со старой версией main/preload, где ещё нет шаблонов проектов. Перезапустите приложение.'

/** API шаблонов, если его знает preload; null — старый preload, показывать прежний блок «Дефолт для новых проектов». */
export function templatesApi(api: Partial<OrcaApi> | undefined): {
  templates: OrcaApi['templates']
  applyTemplate: OrcaApi['projects']['applyTemplate']
} | null {
  const templates = api?.templates
  const applyTemplate = api?.projects?.applyTemplate
  return templates && applyTemplate ? { templates, applyTemplate } : null
}

/** Preload новый, а main старый — invoke падает с «No handler registered for 'templates:…'». */
export function isStaleTemplatesError(message: string): boolean {
  return /No handler registered for '(templates:|projects:applyTemplate)/.test(message)
}

/** С чем сравнивается проект и что написать рядом с типом. */
export interface ProjectBase {
  /** База сравнения: шаблон проекта, а если его нет или он удалён — шаблон по умолчанию (как `baseTemplate` в main). */
  template: ProjectTemplate
  /** Тип проекта — его собственный шаблон (не подставленный по умолчанию). */
  own: boolean
  /** Пояснение, почему база — шаблон по умолчанию; undefined — у проекта свой живой шаблон. */
  note?: string
}

export function projectBase(project: Pick<Project, 'templateId'>, state: TemplatesState): ProjectBase | null {
  const byId = (id: string): ProjectTemplate | undefined => state.templates.find((t) => t.id === id)
  const own = project.templateId ? byId(project.templateId) : undefined
  if (own) return { template: own, own: true }
  const def = byId(state.defaultTemplateId)
  if (!def) return null
  const note = project.templateId
    ? `Шаблон проекта удалён (${project.templateId}) — сравнение с шаблоном по умолчанию «${def.title}».`
    : `Тип не задан — сравнение с шаблоном по умолчанию «${def.title}».`
  return { template: def, own: false, note }
}

/** Отличие одной роли; «Взять из шаблона» для неё — `applyTemplate(…, ['roles'], [id])`. */
export interface RoleDiffRow {
  id: string
  title: string
  /** added — только в проекте (из шаблона роль удалится), removed — только в шаблоне (добавится), changed — заменится. */
  change: 'added' | 'removed' | 'changed'
  hint: string
}

/** Строка отличий «Обзора»: раздел, текст («роли (+1 «Дизайнер»)») и, для ролей, отличия по одной. */
export interface TemplateDiffRow {
  section: TemplateSection
  line: string
  roles?: RoleDiffRow[]
}

const ROLE_HINTS: Record<RoleDiffRow['change'], string> = {
  added: 'только в проекте — из шаблона роль удалится',
  removed: 'есть в шаблоне — роль добавится',
  changed: 'отличается от шаблона — роль заменится шаблонной'
}

/** Отличия проекта от шаблона по разделам (`sectionsDiff` из core); пустой массив — совпадают. */
export function templateDiffRows(project: SectionSettings, template: ProjectTemplateSettings, agents: AgentInfo[]): TemplateDiffRow[] {
  return sectionsDiff(project, template, agents).map((d) => {
    const line = sectionDiffLine(d, agents)
    if (d.section !== 'roles') return { section: d.section, line }
    const row = (r: Role, change: RoleDiffRow['change']): RoleDiffRow => ({ id: r.id, title: r.title, change, hint: ROLE_HINTS[change] })
    return {
      section: d.section,
      line,
      roles: [...d.changed.map((r) => row(r, 'changed')), ...d.removed.map((r) => row(r, 'removed')), ...d.added.map((r) => row(r, 'added'))]
    }
  })
}

/** Что именно применить: разделы шаблона и, для ролей, только эти роли. */
export interface ApplyRequest {
  templateId: string
  sections: TemplateSection[]
  roleIds?: string[]
}

/** Последствия применения — для диалога подтверждения. */
export interface ApplyPreview {
  /** Колонки проекта, которых после применения не будет, и сколько задач в каждой. */
  columnsGone: { id: string; title: string; tasks: number }[]
  /** Сколько задач уедет в backlog (все, чей статус не останется колонкой, — как `setColumns` в main). */
  backlogTasks: number
  /** Роли проекта, которые пропадут: задачи на них и что ещё сломается (`removalConsequences`). */
  rolesGone: { id: string; title: string; tasks: number; consequences: string[] }[]
  /** Что поменяется без потерь, но стоит знать (воркфлоу — только для новых прогонов и т. п.). */
  notes: string[]
  /** Ошибка проверки графа по итоговым ролям и колонкам — main отвергнет применение с тем же текстом. */
  error: string | null
  /** Взяты все разделы — проект запомнит этот шаблон как свой тип. */
  setsType: boolean
}

type TaskLite = { status: string; roleId: string }

/**
 * Предпросмотр `applyTemplate`: тот же `applySections`, что в main, но без записи. Роли и колонки считаются
 * без графа, чтобы ошибка графа не прятала остальные последствия; сама ошибка — отдельным прогоном.
 */
export function applyPreview<P extends SectionSettings>(
  project: P,
  template: ProjectTemplateSettings,
  req: Pick<ApplyRequest, 'sections' | 'roleIds'>,
  tasks: readonly TaskLite[]
): ApplyPreview {
  const { sections, roleIds } = req
  const has = (s: TemplateSection): boolean => sections.includes(s)
  const next = applySections<string, SectionSettings>({ ...project, workflow: undefined }, { ...template, workflow: undefined }, sections, roleIds)
  const nextWorkflow: Workflow | undefined = has('workflow') ? template.workflow : project.workflow

  let error: string | null = null
  try {
    applySections<string, SectionSettings>(project, template, sections, roleIds)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const oldColumns = project.columns ?? DEFAULT_COLUMNS
  const nextColumnIds = new Set((next.columns ?? DEFAULT_COLUMNS).map((c) => c.id))
  const count = (pred: (t: TaskLite) => boolean): number => tasks.filter(pred).length
  const columnsGone = has('columns')
    ? oldColumns.filter((c) => !nextColumnIds.has(c.id)).map((c) => ({ id: c.id, title: c.title, tasks: count((t) => t.status === c.id) }))
    : []
  const backlogTasks = has('columns') ? count((t) => !nextColumnIds.has(t.status)) : 0

  const nextRoleIds = new Set((next.roles ?? DEFAULT_ROLES).map((r) => r.id))
  const rolesGone = has('roles')
    ? (project.roles ?? DEFAULT_ROLES).filter((r) => !nextRoleIds.has(r.id)).map((r) => {
        const n = count((t) => t.roleId === r.id)
        return { id: r.id, title: r.title, tasks: n, consequences: removalConsequences(r.id, n, nextWorkflow) }
      })
    : []

  const notes: string[] = []
  if (has('workflow') || (has('roles') && !nextWorkflow)) {
    notes.push('Воркфлоу меняется только для новых прогонов: идущие прогоны доживают на своём снимке графа.')
  }
  if (has('roles') || has('agents') || has('permissions') || has('agentRules')) {
    notes.push('Роли, агенты, разрешения и правила доски действуют со следующего запуска агента; запущенные агенты не меняются.')
  }

  return {
    columnsGone, backlogTasks, rolesGone, notes, error,
    setsType: TEMPLATE_SECTIONS.every((s) => has(s))
  }
}

/** Настройки проекта как настройки шаблона («Сохранить как шаблон…»): роли и колонки — явно, своего графа нет — без него. */
export function projectAsTemplateSettings(project: Project): ProjectTemplateSettings {
  const rules = project.agentRules?.trim()
  return {
    permissionMode: project.permissionMode ?? 'auto',
    ...(project.enabledAgents ? { enabledAgents: [...project.enabledAgents] } : {}),
    roles: project.roles ?? DEFAULT_ROLES,
    columns: project.columns ?? DEFAULT_COLUMNS,
    ...(rules ? { agentRules: project.agentRules } : {}),
    // Нет своего графа — и в шаблоне его не будет: проект из шаблона получит граф по своим ролям.
    ...(project.workflow ? { workflow: project.workflow } : {})
  }
}

/** Пользовательские шаблоны — их можно перезаписать; встроенные только читаются. */
export function writableTemplates(state: TemplatesState): ProjectTemplate[] {
  return state.templates.filter((t) => !t.builtin)
}
