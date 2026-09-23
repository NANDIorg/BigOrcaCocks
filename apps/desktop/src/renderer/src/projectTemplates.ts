import {
  BUILTIN_EDITABLE_ROLE_FIELDS, BUILTIN_TEMPLATES, DEFAULT_COLUMNS, DEFAULT_ROLES,
  type AgentInfo, type AgentKind, type BoardColumn, type ProjectTemplate, type ProjectTemplateSettings, type Role, type Workflow
} from '@orca-board/core'
import type { OrcaApi, PermissionMode, Project, TemplateInput, TemplatesState } from '../../shared/ipc'

// Логика «Настройки → Шаблоны проектов» (settings/TemplatesPane.tsx): без React, чтобы тестировать node --test.

/**
 * Renderer приходит по HMR, а main и preload остаются старыми до перезапуска: у старого preload нет
 * `window.orca.templates`, у старого main — хендлеров `templates:*`.
 */
export const TEMPLATES_STALE_MESSAGE =
  'Приложение запущено со старой версией main/preload, где ещё нет шаблонов проектов. Перезапустите приложение.'

/** `window.orca.templates` или понятная ошибка вместо «Cannot read properties of undefined». */
export function templatesApi(api: Partial<OrcaApi> | undefined): OrcaApi['templates'] {
  if (!api?.templates) throw new Error(TEMPLATES_STALE_MESSAGE)
  return api.templates
}

/** Preload новый, а main старый — invoke падает с «No handler registered for 'templates:…'». */
export function isStaleTemplatesError(message: string): boolean {
  return /No handler registered for 'templates:/.test(message)
}

/**
 * Старый main не даёт сохранить встроенный шаблон вовсе (в новом без копии меняются модель и усилие ролей) —
 * его ошибку узнаём по прежнему тексту.
 */
export const BUILTIN_MODELS_STALE_MESSAGE =
  'Приложение запущено со старой версией main, где у встроенного шаблона нельзя менять модели. Перезапустите приложение.'

/** Текст ошибки IPC для раздела: старый main — «перезапустите приложение». */
export function templatesError(message: string): string {
  if (isStaleTemplatesError(message)) return TEMPLATES_STALE_MESSAGE
  if (/встроенный и только для чтения — сделайте копию/.test(message)) return BUILTIN_MODELS_STALE_MESSAGE
  return message
}

/** Вкладки редактора шаблона — те же разделы, что в «О проекте». */
export type TemplateTab = 'agents' | 'roles' | 'columns' | 'workflow' | 'perm' | 'rules'
export const TEMPLATE_TABS: readonly TemplateTab[] = ['agents', 'roles', 'columns', 'workflow', 'perm', 'rules']

/** Настройки шаблона с встроенными значениями вместо незаданных — то, что получит новый проект. */
export interface ResolvedTemplateSettings {
  permissionMode: PermissionMode
  /** undefined — все установленные агенты. */
  enabledAgents?: AgentKind[]
  roles: Role[]
  columns: BoardColumn[]
  /** Нет правил — ''. */
  agentRules: string
  /** Нет своего графа — дефолтный по ролям шаблона (его строит редактор). */
  workflow?: Workflow
}

export function resolveTemplateSettings(s: ProjectTemplateSettings): ResolvedTemplateSettings {
  return {
    permissionMode: s.permissionMode ?? 'auto',
    ...(s.enabledAgents ? { enabledAgents: s.enabledAgents } : {}),
    roles: s.roles ?? DEFAULT_ROLES,
    columns: s.columns ?? DEFAULT_COLUMNS,
    agentRules: s.agentRules ?? '',
    ...(s.workflow ? { workflow: s.workflow } : {})
  }
}

/** Правка настроек шаблона: null удаляет поле (= встроенное значение), undefined — не трогать. */
export type TemplatePatch = { [K in keyof ProjectTemplateSettings]?: ProjectTemplateSettings[K] | null }

/**
 * `templates:save` заменяет шаблон целиком — собираем полный TemplateInput из текущего шаблона и правки.
 * Правила из одних пробелов удаляют поле, как у проекта.
 */
export function patchedTemplate(t: ProjectTemplate, patch: TemplatePatch): TemplateInput {
  const settings: Record<string, unknown> = { ...t.settings }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v === null || (k === 'agentRules' && typeof v === 'string' && !v.trim())) delete settings[k]
    else settings[k] = v
  }
  return {
    id: t.id, title: t.title, ...(t.description ? { description: t.description } : {}),
    settings: settings as ProjectTemplateSettings
  }
}

/** Переименование: пустое название — ошибка (текст для формы), пустое описание убирает поле. */
export function renamedTemplate(t: ProjectTemplate, title: string, description: string): TemplateInput | { error: string } {
  const name = title.trim()
  if (!name) return { error: 'Название шаблона не может быть пустым' }
  const desc = description.trim()
  return { id: t.id, title: name, ...(desc ? { description: desc } : {}), settings: t.settings }
}

/**
 * Группы меню: встроенные (и изменённые встроенные — на месте своего встроенного, чтобы смена модели не уносила
 * пункт в «Свои») и свои. Порядок внутри групп — как отдал main.
 */
export function splitTemplates(templates: readonly ProjectTemplate[]): { builtin: ProjectTemplate[]; own: ProjectTemplate[] } {
  const isBuiltin = (t: ProjectTemplate): boolean => !!t.builtin || overridesBuiltin(t)
  return { builtin: templates.filter(isBuiltin), own: templates.filter((t) => !isBuiltin(t)) }
}

/**
 * Пользовательская копия встроенного с тем же id (так «Общий» переживает миграцию старого дефолта):
 * удаление вернёт встроенный, а не уберёт шаблон из списка.
 */
export function overridesBuiltin(t: Pick<ProjectTemplate, 'id' | 'builtin'>): boolean {
  return !t.builtin && BUILTIN_TEMPLATES.some((b) => b.id === t.id)
}

/**
 * Ключ черновиков редакторов шаблона (`useAutoSave`, `key` компонентов). Включает признак встроенного: после
 * удаления изменённого встроенного шаблона id тот же, и без признака редакторы показывали бы удалённую копию.
 */
export function templateEditorKey(t: Pick<ProjectTemplate, 'id' | 'builtin'>): string {
  return `tpl:${t.id}:${t.builtin ? 'b' : 'u'}`
}

/**
 * Ключ черновика редактора ролей. Смена модели во встроенном шаблоне сохраняет «изменённый встроенный» — id тот же,
 * а `templateEditorKey` меняется с `b` на `u`, и черновик сбросился бы на ответ main посреди быстрых кликов
 * (второй выбор, ещё не дошедший до main, пропал бы с экрана). Поэтому шаблон, ставший своей копией из этого
 * редактора (`promotedId`), сохраняет ключ встроенного; после удаления копии `promotedId` сбрасывается, и ключ
 * меняется, как у остальных редакторов.
 */
export function rolesEditorKey(t: Pick<ProjectTemplate, 'id' | 'builtin'>, promotedId: string | null): string {
  return promotedId === t.id && overridesBuiltin(t)
    ? templateEditorKey({ id: t.id, builtin: true })
    : templateEditorKey(t)
}

/** У встроенного шаблона роли правятся только моделью и усилием, остальное — через «Дублировать». */
export function templateRolesMode(t: Pick<ProjectTemplate, 'builtin'>): 'models' | 'full' {
  return t.builtin ? 'models' : 'full'
}

/** Правка роли в режиме «только модель и усилие»: прочие поля отбрасываются (undefined в них — сброс, сохраняется). */
export function modelOnlyPatch(p: Partial<Role>): Partial<Role> {
  const next: Partial<Role> = {}
  for (const k of BUILTIN_EDITABLE_ROLE_FIELDS) if (k in p) next[k] = p[k]
  return next
}

/**
 * Сколько проектов создано из шаблона (или получили его целиком через «Сменить тип»): по `Project.templateId`.
 * Проекты без поля или с удалённым шаблоном не считаются — они сравниваются с шаблоном по умолчанию.
 */
export function templateUsage(projects: readonly Project[]): Record<string, number> {
  const usage: Record<string, number> = {}
  for (const p of projects) if (p.templateId) usage[p.templateId] = (usage[p.templateId] ?? 0) + 1
  return usage
}

/** Выбранный шаблон: запомненный, если он ещё есть, иначе шаблон по умолчанию. */
export function pickTemplateId(state: TemplatesState, wanted: string | null | undefined): string {
  return wanted && state.templates.some((t) => t.id === wanted) ? wanted : state.defaultTemplateId
}

/** Агенты реестра с «включённостью» по шаблону, а не по активному проекту. */
export function templateAgents(agents: readonly AgentInfo[], enabledAgents: readonly AgentKind[] | undefined): AgentInfo[] {
  return agents.map((a) => ({ ...a, enabled: a.installed && (enabledAgents === undefined || enabledAgents.includes(a.id)) }))
}

/** Текст подтверждения удаления: что станет с шаблоном по умолчанию и проектами из него. */
export function deleteConfirmText(t: ProjectTemplate, state: TemplatesState, usage: number): string {
  const lines = [`Удалить шаблон «${t.title}»?`, '']
  if (overridesBuiltin(t)) lines.push('Ваши правки пропадут — вернётся встроенный шаблон с этим именем.')
  else if (state.defaultTemplateId === t.id) lines.push('Это шаблон по умолчанию — им станет «Общий».')
  if (usage > 0) {
    lines.push(`Из него созданы проекты (${usage}): их настройки не изменятся, сравниваться они будут с шаблоном по умолчанию.`)
  }
  if (lines.length === 2) lines.push('Существующие проекты не изменятся.')
  return lines.join('\n')
}
