import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  TaskStore, isAgentKind, DEFAULT_ROLES, withDefaultDescriptions, DEFAULT_COLUMNS, SYSTEM_COLUMN_KINDS, COLUMN_COLORS,
  WORKFLOW_VERSION, defaultWorkflow, migrateWorkflow, validateWorkflow,
  BUILTIN_TEMPLATES, GENERAL_TEMPLATE_ID, TEMPLATE_SECTIONS, builtinTemplate, builtinTemplates, isBuiltinExecutorEdit,
  applySections, stableJson,
  type OrcaEvent, type AgentKind, type Role, type BoardColumn, type Workflow, type WfValidationContext,
  type ProjectTemplate, type ProjectTemplateSettings, type TemplateSection
} from '@orca-board/core'
import { jsonPersistence } from './persistence'
import { detectTemplate } from './template-detect'
import type { AppSettings, AppSettingsPatch, TaskRef, TemplateInput, TemplatesState, TemplateDetection } from '../shared/ipc'
import { DEFAULT_NOTIFICATION_SETTINGS, mergeNotificationSettings, normalizeNotificationSettings } from '../shared/notifications'

export type PermissionMode = 'auto' | 'bypassPermissions' | 'acceptEdits'

const PERMISSION_MODES: PermissionMode[] = ['auto', 'bypassPermissions', 'acceptEdits']

function isPermissionMode(v: unknown): v is PermissionMode {
  return (PERMISSION_MODES as unknown[]).includes(v)
}

export interface Project {
  id: string
  root: string
  name: string
  /** Режим разрешений Claude Code для координатора и воркеров. По умолчанию auto. */
  permissionMode?: PermissionMode
  /** Включённые агенты. undefined — все установленные. */
  enabledAgents?: AgentKind[]
  /** Роли проекта. undefined — DEFAULT_ROLES. */
  roles?: Role[]
  /** Колонки доски в порядке показа. undefined — DEFAULT_COLUMNS. */
  columns?: BoardColumn[]
  /**
   * Правила проекта для агентов доски (markdown): блок «Правила проекта» в системном промпте воркеров всех ролей
   * и координатора (`withAgentRules`). Не попадают в CLAUDE.md/AGENTS.md и обычные сессии агентов.
   * Пусто — поля нет. Правила отдельной роли — её `systemPrompt`.
   */
  agentRules?: string
  /**
   * Воркфлоу задач проекта (граф этапов). undefined — `defaultWorkflow(roles)`, см. `ProjectManager.workflow(id)`.
   * Граф из будущей версии формата хранится как есть, но не исполняется.
   */
  workflow?: Workflow
  /**
   * Шаблон («тип проекта»), из которого проект создан или который последним применён целиком. Живой связи нет:
   * только база для сравнения в «Обзоре». Нет поля (проект до шаблонов) или шаблон удалён — сравнивается
   * с шаблоном по умолчанию (`baseTemplate`).
   */
  templateId?: string
}

/** Настройки, которые копируются в каждый новый проект. */
export interface ProjectDefaults {
  permissionMode: PermissionMode
  /** undefined — все установленные агенты. */
  enabledAgents?: AgentKind[]
  roles: Role[]
  columns: BoardColumn[]
  /** Правила проекта для агентов доски, копируются в новый проект; пусто — поля нет. */
  agentRules?: string
  /** Воркфлоу для новых проектов; нет — у нового проекта тоже нет (= дефолтный граф по его ролям). */
  workflow?: Workflow
}

interface ProjectsFile {
  projects: Project[]
  activeId: string | null
  /**
   * Старый глобальный дефолт для новых проектов. Только читается: `load()` переносит его в пользовательский
   * шаблон «Общий» (`general`), при следующем сохранении поля в файле уже нет.
   */
  defaults?: Partial<ProjectDefaults>
  /**
   * Пользовательские шаблоны. Встроенные (`BUILTIN_TEMPLATES`) не хранятся — обновляются вместе с приложением.
   * Пользовательский шаблон с id встроенного подменяет его: так живёт «Общий» после миграции `defaults`.
   */
  templates?: ProjectTemplate[]
  /** Шаблон, предвыбранный при добавлении проекта (и источник ролей ассистента); нет или удалён — `general`. */
  defaultTemplateId?: string
  /** Глобальные настройки приложения; незаданные поля — DEFAULT_APP_SETTINGS. */
  settings?: Partial<AppSettings>
}

export const DEFAULT_APP_SETTINGS: AppSettings = { keepInBackground: true, notifications: DEFAULT_NOTIFICATION_SETTINGS }

/**
 * Список репозиториев и по TaskStore на каждый. Доска хранится в userData/boards/<id>.json.
 * Активный проект — тот, что выбран в сайдбаре; CLI может адресовать любой через ORCA_PROJECT.
 */
export class ProjectManager {
  private file: string
  private data: ProjectsFile
  private stores = new Map<string, TaskStore>()
  private listeners = new Set<(projectId: string, store: TaskStore) => void>()
  private eventListeners = new Set<(projectId: string, events: OrcaEvent[]) => void>()
  private seenEvents = new Map<string, number>()

  constructor(private userData: string) {
    this.file = join(userData, 'projects.json')
    this.data = this.load()
  }

  private load(): ProjectsFile {
    if (!existsSync(this.file)) return { projects: [], activeId: null }
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as ProjectsFile
      // Старый формат без defaults читается как есть; мусор в defaults — сбрасываем.
      if (data.defaults !== undefined && (typeof data.defaults !== 'object' || data.defaults === null)) delete data.defaults
      if (data.settings !== undefined && (typeof data.settings !== 'object' || data.settings === null || Array.isArray(data.settings))) delete data.settings
      // Системные роли без назначения (созданы до появления поля) получают назначение по умолчанию.
      for (const p of data.projects ?? []) if (Array.isArray(p.roles)) p.roles = withDefaultDescriptions(p.roles)
      if (Array.isArray(data.defaults?.roles)) data.defaults.roles = withDefaultDescriptions(data.defaults.roles)
      // Правила агентов появились позже: у старых конфигов поля нет (= правил нет), не-строку отбрасываем.
      for (const p of data.projects ?? []) if (p.agentRules !== undefined && typeof p.agentRules !== 'string') delete p.agentRules
      if (data.defaults && data.defaults.agentRules !== undefined && typeof data.defaults.agentRules !== 'string') delete data.defaults.agentRules
      // Воркфлоу: битый граф отбрасываем (= дефолтный), старую версию формата мигрируем,
      // будущую не трогаем — её отвергнет workflow(id) с просьбой обновить приложение.
      for (const p of data.projects ?? []) {
        const wf = loadedWorkflow(p.workflow)
        if (wf) p.workflow = wf
        else delete p.workflow
      }
      if (data.defaults) {
        const wf = loadedWorkflow(data.defaults.workflow)
        if (wf) data.defaults.workflow = wf
        else delete data.defaults.workflow
      }
      for (const p of data.projects ?? []) if (p.templateId !== undefined && !nonEmpty(p.templateId)) delete p.templateId
      if (data.defaultTemplateId !== undefined && !nonEmpty(data.defaultTemplateId)) delete data.defaultTemplateId
      data.templates = Array.isArray(data.templates) ? data.templates.flatMap(loadedTemplate) : []
      migrateDefaults(data)
      if (!data.templates.length) delete data.templates
      return data
    } catch {
      return { projects: [], activeId: null }
    }
  }

  private save(): void {
    mkdirSync(this.userData, { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  list(): Project[] {
    return [...this.data.projects]
  }

  get(id: string): Project | undefined {
    return this.data.projects.find((p) => p.id === id)
  }

  active(): Project | null {
    return this.data.projects.find((p) => p.id === this.data.activeId) ?? this.data.projects[0] ?? null
  }

  setActive(id: string): Project {
    const p = this.get(id)
    if (!p) throw new Error(`project not found: ${id}`)
    this.data.activeId = id
    this.save()
    return p
  }

  /**
   * Добавить репозиторий. Путь нормализуется до корня git. Новый проект получает копию шаблона `templateId`
   * (нет — шаблон по умолчанию) и запоминает его. Уже добавленный репозиторий возвращается как есть.
   */
  add(path: string, templateId?: string): Project {
    let root: string
    try {
      root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path, stdio: 'pipe' }).toString().trim()
    } catch {
      throw new Error(`${path} — не git-репозиторий`)
    }
    const existing = this.data.projects.find((p) => p.root === root)
    if (existing) {
      this.data.activeId = existing.id
      this.save()
      return existing
    }
    const template = this.requireTemplate(templateId ?? this.defaultTemplateId())
    const d = resolvedSettings(template.settings)
    const id = createHash('sha1').update(root).digest('hex').slice(0, 10)
    const project: Project = {
      id, root, name: basename(root),
      permissionMode: d.permissionMode,
      ...(d.enabledAgents ? { enabledAgents: d.enabledAgents } : {}),
      roles: d.roles,
      columns: d.columns,
      ...(d.agentRules ? { agentRules: d.agentRules } : {}),
      ...(d.workflow ? { workflow: d.workflow } : {}),
      templateId: template.id
    }
    this.data.projects.push(project)
    this.data.activeId = id
    this.save()
    return project
  }

  /**
   * Подсказка типа по файлам репозитория (`detectTemplate`) — только предвыбор в выборе типа.
   * Нет признаков или угаданного шаблона нет в списке — шаблон по умолчанию.
   */
  detectTemplate(path: string): TemplateDetection {
    const hint = detectTemplate(path)
    if (hint.templateId && this.template(hint.templateId)) return { path, templateId: hint.templateId, reason: hint.reason }
    return { path, templateId: this.defaultTemplateId(), reason: '' }
  }

  // ---------- шаблоны проектов ----------

  /** Встроенные (в их порядке; подменённые пользовательской копией с тем же id — копией), затем пользовательские. */
  templates(): ProjectTemplate[] {
    const user = this.data.templates ?? []
    const builtins = builtinTemplates().map((b) => user.find((t) => t.id === b.id) ?? b)
    return [...builtins, ...user.filter((t) => !isBuiltinId(t.id))].map(cloneTemplate)
  }

  template(id: string): ProjectTemplate | undefined {
    return this.templates().find((t) => t.id === id)
  }

  /** Шаблоны и id шаблона по умолчанию — то, что нужно выбору типа и редактору шаблонов. */
  templatesState(): TemplatesState {
    return { templates: this.templates(), defaultTemplateId: this.defaultTemplateId() }
  }

  /** Шаблон по умолчанию: заданный и существующий, иначе «Общий» (встроенный есть всегда). */
  defaultTemplateId(): string {
    const id = this.data.defaultTemplateId
    return id && this.template(id) ? id : GENERAL_TEMPLATE_ID
  }

  setDefaultTemplate(id: string): TemplatesState {
    this.requireTemplate(id)
    this.data.defaultTemplateId = id
    this.save()
    return this.templatesState()
  }

  /**
   * База сравнения проекта в «Обзоре»: его шаблон, а если поля нет или шаблон удалён — шаблон по умолчанию.
   */
  baseTemplate(projectId: string): ProjectTemplate {
    const p = this.get(projectId)
    if (!p) throw new Error(`project not found: ${projectId}`)
    return (p.templateId ? this.template(p.templateId) : undefined) ?? this.requireTemplate(this.defaultTemplateId())
  }

  /**
   * Создать (без `id` — новый id) или целиком заменить пользовательский шаблон. Настройки проходят ту же
   * валидацию, что у проекта. У встроенного шаблона без копии меняются только агент, модель и усилие ролей
   * (`isBuiltinExecutorEdit`) — сохраняется копия с его id, удаление которой вернёт встроенный; остальное —
   * ошибка с подсказкой «Дублировать».
   */
  saveTemplate(input: TemplateInput): ProjectTemplate {
    if (!isObject(input)) throw new Error('шаблон: ожидается объект')
    if (input.id !== undefined && !nonEmpty(input.id)) throw new Error('шаблон: пустой id')
    if (!nonEmpty(input.title)) throw new Error('шаблон: пустое название')
    if (input.description !== undefined && typeof input.description !== 'string') throw new Error(`шаблон «${input.title}»: описание должно быть строкой`)
    const user = [...(this.data.templates ?? [])]
    const id = input.id ?? this.newTemplateId()
    const i = user.findIndex((t) => t.id === id)
    const description = input.description?.trim()
    const template: ProjectTemplate = {
      id, title: input.title.trim(), ...(description ? { description } : {}),
      settings: validSettings(input.settings ?? {}, {}, `шаблон «${input.title.trim()}»`)
    }
    // Встроенный без своей копии: копия с тем же id («изменённый встроенный») создаётся только сменой агентов, моделей и усилий ролей.
    const builtin = i === -1 ? builtinTemplate(id) : undefined
    if (builtin && !isBuiltinExecutorEdit(builtin, template)) throw new Error(readonlyTemplateMessage(id))
    if (i === -1) user.push(template)
    else user[i] = template
    this.data.templates = user
    this.save()
    return cloneTemplate(template)
  }

  /**
   * Удалить пользовательский шаблон. Удалённый шаблон по умолчанию сбрасывается на «Общий»; `templateId`
   * проектов остаётся висячим — такие проекты сравниваются с шаблоном по умолчанию (`baseTemplate`).
   * Удаление копии встроенного (например, «Общего» после миграции) возвращает встроенный.
   */
  deleteTemplate(id: string): TemplatesState {
    const user = this.data.templates ?? []
    if (!user.some((t) => t.id === id)) {
      throw new Error(isBuiltinId(id) ? readonlyTemplateMessage(id) : `шаблон не найден: ${id}`)
    }
    this.data.templates = user.filter((t) => t.id !== id)
    if (!this.data.templates.length) delete this.data.templates
    if (this.data.defaultTemplateId === id && !isBuiltinId(id)) delete this.data.defaultTemplateId
    this.save()
    return this.templatesState()
  }

  /** Копия шаблона (в том числе встроенного) под новым id — так правят встроенные. */
  duplicateTemplate(id: string): ProjectTemplate {
    const src = this.requireTemplate(id)
    return this.saveTemplate({
      title: `${src.title} (копия)`,
      ...(src.description ? { description: src.description } : {}),
      settings: src.settings
    })
  }

  private requireTemplate(id: string): ProjectTemplate {
    const t = this.template(id)
    if (!t) throw new Error(`шаблон не найден: ${id}`)
    return t
  }

  private newTemplateId(): string {
    let id: string
    do id = `tpl_${randomBytes(4).toString('hex')}`
    while (this.template(id))
    return id
  }

  /**
   * Настройки шаблона по умолчанию; незаданные поля — встроенные значения. Массивы — копии.
   * Старое имя «глобального дефолта»: его читают «Настройки → Для новых проектов» и ассистент (роли и режим разрешений).
   */
  defaults(): ProjectDefaults {
    return resolvedSettings(this.requireTemplate(this.defaultTemplateId()).settings)
  }

  /**
   * Смержить патч в шаблон по умолчанию (роли и колонки проходят ту же валидацию, что у проекта;
   * enabledAgents: null/undefined в патче с явным ключом — «все установленные»). Встроенный «Общий»
   * при первой правке получает пользовательскую копию с тем же id — как после миграции старого `defaults`;
   * другой встроенный шаблон по умолчанию только читается.
   */
  setDefaults(patch: Partial<ProjectDefaults>): ProjectDefaults {
    const id = this.defaultTemplateId()
    const own = this.data.templates?.find((t) => t.id === id)
    if (!own && id !== GENERAL_TEMPLATE_ID) throw new Error(readonlyTemplateMessage(id))
    const base = own ?? { id, title: GENERAL_TITLE, description: GENERAL_DESCRIPTION, settings: {} }
    const settings = validSettings(patch, base.settings, 'настройки по умолчанию')
    this.data.templates = [...(this.data.templates ?? []).filter((t) => t.id !== id), { ...base, settings }]
    this.save()
    return this.defaults()
  }

  /** Настройки приложения; незаданные и некорректные поля — дефолты. */
  settings(): AppSettings {
    const s = this.data.settings ?? {}
    return {
      keepInBackground: typeof s.keepInBackground === 'boolean' ? s.keepInBackground : DEFAULT_APP_SETTINGS.keepInBackground,
      notifications: normalizeNotificationSettings(s.notifications)
    }
  }

  setSettings(patch: AppSettingsPatch): AppSettings {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('настройки приложения: ожидается объект')
    const next: Partial<AppSettings> = { ...(this.data.settings ?? {}) }
    if (patch.keepInBackground !== undefined) {
      if (typeof patch.keepInBackground !== 'boolean') throw new Error('keepInBackground должен быть boolean')
      next.keepInBackground = patch.keepInBackground
    }
    if (patch.notifications !== undefined) {
      next.notifications = mergeNotificationSettings(this.settings().notifications, patch.notifications)
    }
    this.data.settings = next
    this.save()
    return this.settings()
  }

  /**
   * Взять разделы `sections` шаблона `templateId` в проект (`applySections` из core): раздел, которого в шаблоне
   * нет, заменяется встроенным значением; `roleIds` с разделом `roles` — только эти роли. Граф проверяется по
   * итоговым ролям и колонкам, при ошибке проект не меняется. Колонки — через `setColumns` (задачи из исчезнувших
   * колонок уходят в backlog). Все разделы сразу — это «сменить тип»: проект запоминает `templateId`.
   */
  applyTemplate(id: string, templateId: string, sections: TemplateSection[], roleIds?: string[]): Project {
    const p = this.get(id)
    if (!p) throw new Error(`project not found: ${id}`)
    const template = this.requireTemplate(templateId)
    if (!Array.isArray(sections) || !sections.length) throw new Error('применение шаблона: не выбран ни один раздел')
    for (const s of sections) {
      if (!TEMPLATE_SECTIONS.includes(s)) throw new Error(`применение шаблона: неизвестный раздел ${String(s)}`)
    }
    if (roleIds !== undefined && (!Array.isArray(roleIds) || !roleIds.every(nonEmpty))) {
      throw new Error('применение шаблона: roleIds должен быть массивом id ролей')
    }
    const next = applySections<PermissionMode, Project>(p, resolvedSettings(template.settings), sections, roleIds)
    // Роли и колонки проверяем до первой записи: применение атомарное, откатывать было бы нечего.
    const roles = sections.includes('roles') ? validateRoles(next.roles ?? DEFAULT_ROLES) : undefined
    const columns = sections.includes('columns') ? validateColumns(next.columns ?? DEFAULT_COLUMNS) : undefined
    for (const key of ['permissionMode', 'enabledAgents', 'agentRules', 'workflow'] as const) {
      if (next[key] === undefined) delete p[key]
      else (p as Record<typeof key, unknown>)[key] = next[key]
    }
    if (roles) p.roles = roles
    if (TEMPLATE_SECTIONS.every((s) => sections.includes(s))) p.templateId = template.id
    if (columns) this.replaceColumns(p, columns)
    else this.save()
    return p
  }

  /** Переписать все настройки проекта шаблоном по умолчанию. Задачи из исчезнувших колонок уходят в backlog. */
  applyDefaults(id: string): Project {
    return this.applyTemplate(id, this.defaultTemplateId(), [...TEMPLATE_SECTIONS])
  }

  setPermissionMode(id: string, mode: PermissionMode): Project {
    const p = this.get(id)
    if (!p) throw new Error(`project not found: ${id}`)
    p.permissionMode = mode
    this.save()
    return p
  }

  setEnabledAgents(id: string, agents: AgentKind[]): Project {
    const p = this.get(id)
    if (!p) throw new Error(`project not found: ${id}`)
    p.enabledAgents = agents.filter((a) => isAgentKind(a))
    this.save()
    return p
  }

  /** Роли проекта; не заданы — дефолтные. */
  roles(id: string): Role[] {
    return this.get(id)?.roles ?? DEFAULT_ROLES
  }

  /** Колонки доски в порядке показа; не заданы — дефолтные. */
  columns(id: string): BoardColumn[] {
    return this.get(id)?.columns ?? DEFAULT_COLUMNS
  }

  /** Правила проекта для агентов доски; не заданы — ''. */
  agentRules(id: string): string {
    return this.get(id)?.agentRules ?? ''
  }

  /** Сохранить правила проекта как введены (без trim — иначе автосохранение съедало бы ввод); из одних пробелов — поля нет. */
  setAgentRules(id: string, text: string): Project {
    const p = this.get(id)
    if (!p) throw new Error(`project not found: ${id}`)
    const rules = validateAgentRules(text)
    if (rules) p.agentRules = rules
    else delete p.agentRules
    this.save()
    return p
  }

  /**
   * Воркфлоу проекта; не задан — дефолтный по ролям проекта (есть `reviewer` — ревью агентом, нет — человеком).
   * Граф из будущей версии формата не исполняем: ошибка с просьбой обновить приложение.
   */
  workflow(id: string): Workflow {
    const wf = this.get(id)?.workflow
    if (!wf) return defaultWorkflow(this.roles(id))
    if (wf.version > WORKFLOW_VERSION) throw new Error(futureWorkflowMessage(wf.version))
    return wf
  }

  /**
   * Сохранить воркфлоу проекта; null — вернуть дефолтный (поле удаляется). Граф с ошибками `validateWorkflow`
   * не сохраняется, предупреждения не мешают. Роли могут удалить позже — это ловит исполнитель, не сеттер.
   */
  setWorkflow(id: string, wf: Workflow | null): Project {
    const p = this.get(id)
    if (!p) throw new Error(`project not found: ${id}`)
    if (wf == null) delete p.workflow
    else p.workflow = checkedWorkflow(wf, { roles: this.roles(id), columns: this.columns(id), enabledAgents: p.enabledAgents })
    this.save()
    return p
  }

  setRoles(id: string, roles: Role[]): Project {
    const p = this.get(id)
    if (!p) throw new Error(`project not found: ${id}`)
    p.roles = validateRoles(roles)
    this.save()
    return p
  }

  /**
   * Заменить набор колонок. Задачи из удалённых колонок переезжают в backlog —
   * так на доске не остаётся задач со статусом, которого нет.
   */
  setColumns(id: string, columns: BoardColumn[]): Project {
    const p = this.get(id)
    if (!p) throw new Error(`project not found: ${id}`)
    this.replaceColumns(p, validateColumns(columns))
    return p
  }

  /** Записать уже проверенные колонки (с сохранением файла) и перенести задачи из исчезнувших колонок в backlog. */
  private replaceColumns(p: Project, next: BoardColumn[]): void {
    const store = this.store(p.id)
    // Сначала применяем новый набор: store читает колонки через this.columns(id),
    // и перенос задач должен считать doneAt/ready уже по новым колонкам.
    p.columns = next
    this.save()
    const backlogId = next.find((c) => c.kind === 'backlog')!.id
    const keep = new Set(next.map((c) => c.id))
    const orphaned = new Set(store.listTasks().map((t) => t.status).filter((s) => !keep.has(s)))
    for (const oldId of orphaned) store.reassignColumn(oldId, backlogId)
  }

  remove(id: string): void {
    this.data.projects = this.data.projects.filter((p) => p.id !== id)
    if (this.data.activeId === id) this.data.activeId = this.data.projects[0]?.id ?? null
    this.save()
  }

  store(id: string): TaskStore {
    let s = this.stores.get(id)
    if (!s) {
      const project = this.get(id)
      if (!project) throw new Error(`project not found: ${id}`)
      const created = new TaskStore(jsonPersistence(join(this.userData, 'boards', `${id}.json`)), () => this.columns(id))
      this.seenEvents.set(id, created.listEvents().length)
      created.subscribe(() => {
        this.listeners.forEach((fn) => fn(id, created))
        const all = created.listEvents()
        const seen = this.seenEvents.get(id) ?? 0
        if (all.length > seen) {
          this.seenEvents.set(id, all.length)
          this.eventListeners.forEach((fn) => fn(id, all.slice(seen)))
        }
      })
      this.stores.set(id, created)
      // После запуска приложения ни одного координатора в живых нет: вопросы, которые ждали их, — человеку.
      for (const run of created.listRuns()) created.escalateOpenQuestions(run.id)
      s = created
    }
    return s
  }

  activeStore(): TaskStore {
    const p = this.active()
    if (!p) throw new Error('нет проектов: добавьте репозиторий')
    return this.store(p.id)
  }

  /** Число задач в работе (kind=in_progress) по id каждого проекта, включая неактивные. */
  /**
   * Статус и роль каждой задачи проекта — для последствий применения шаблона к неактивному проекту
   * («Применить к проектам…» в настройках): сколько задач уедет в backlog и останется без роли.
   */
  taskRefs(id: string): TaskRef[] {
    return this.store(id).listTasks().map((t) => ({ status: t.status, roleId: t.roleId }))
  }

  inProgressCounts(): Record<string, number> {
    return Object.fromEntries(this.list().map((p) => [p.id, this.store(p.id).inProgressCount()]))
  }

  /** Все загруженные store — для детектора тишины. */
  loadedStores(): Array<[string, TaskStore]> {
    return [...this.stores.entries()]
  }

  onChange(fn: (projectId: string, store: TaskStore) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onEvents(fn: (projectId: string, events: OrcaEvent[]) => void): () => void {
    this.eventListeners.add(fn)
    return () => this.eventListeners.delete(fn)
  }
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/** Правила проекта: строка; из одних пробелов — undefined (поля нет). */
function validateAgentRules(text: unknown): string | undefined {
  if (typeof text !== 'string') throw new Error('правила проекта должны быть строкой')
  return text.trim() ? text : undefined
}

/**
 * Роли: непустые уникальные id, непустые названия, известный агент; назначение, модель, effort, системный промпт —
 * строки или отсутствуют. Пустое назначение системной роли заменяется назначением по умолчанию.
 */
function validateRoles(roles: Role[]): Role[] {
  if (!Array.isArray(roles) || roles.length === 0) throw new Error('нужна хотя бы одна роль')
  const seen = new Set<string>()
  return withDefaultDescriptions(roles.map((r, i) => {
    if (!nonEmpty(r.id)) throw new Error(`роль №${i + 1}: пустой id`)
    if (seen.has(r.id)) throw new Error(`роль «${r.id}» указана дважды`)
    seen.add(r.id)
    if (!nonEmpty(r.title)) throw new Error(`роль «${r.id}»: пустое название`)
    if (r.description !== undefined && typeof r.description !== 'string') throw new Error(`роль «${r.id}»: назначение должно быть строкой`)
    if (!isAgentKind(r.agent)) throw new Error(`роль «${r.id}»: неизвестный агент ${String(r.agent)}`)
    if (r.model !== undefined && typeof r.model !== 'string') throw new Error(`роль «${r.id}»: модель должна быть строкой`)
    if (r.effort !== undefined && typeof r.effort !== 'string') throw new Error(`роль «${r.id}»: effort должен быть строкой`)
    if (r.systemPrompt !== undefined && typeof r.systemPrompt !== 'string') throw new Error(`роль «${r.id}»: системный промпт должен быть строкой`)
    const model = r.model?.trim()
    const effort = r.effort?.trim()
    // Назначение и промпт хранятся как введены (многострочные, без trim — иначе автосохранение съедало бы ввод); из одних пробелов — поля нет.
    const description = r.description?.trim() ? r.description : undefined
    const systemPrompt = r.systemPrompt?.trim() ? r.systemPrompt : undefined
    return {
      id: r.id, title: r.title.trim(), ...(description ? { description } : {}), agent: r.agent,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(systemPrompt ? { systemPrompt } : {})
    }
  }))
}

/**
 * Колонки: непустые уникальные id и названия, каждый системный kind ровно один раз,
 * остальные — custom. Порядок массива = порядок на доске.
 */
function validateColumns(columns: BoardColumn[]): BoardColumn[] {
  if (!Array.isArray(columns) || columns.length === 0) throw new Error('нужна хотя бы одна колонка')
  const ids = new Set<string>()
  const kinds = new Map<string, number>()
  const result = columns.map((c, i) => {
    if (!nonEmpty(c.id)) throw new Error(`колонка №${i + 1}: пустой id`)
    if (ids.has(c.id)) throw new Error(`колонка «${c.id}» указана дважды`)
    ids.add(c.id)
    if (!nonEmpty(c.title)) throw new Error(`колонка «${c.id}»: пустое название`)
    const system = (SYSTEM_COLUMN_KINDS as string[]).includes(c.kind)
    if (!system && c.kind !== 'custom') throw new Error(`колонка «${c.id}»: неизвестный вид ${String(c.kind)}`)
    if (system) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1)
    const color = nonEmpty(c.color) ? c.color.trim() : COLUMN_COLORS[0].value
    return { id: c.id, title: c.title.trim(), color, kind: c.kind }
  })
  for (const kind of SYSTEM_COLUMN_KINDS) {
    const n = kinds.get(kind) ?? 0
    if (n === 0) throw new Error(`нет системной колонки «${kind}» — её нельзя удалить`)
    if (n > 1) throw new Error(`системная колонка «${kind}» должна быть одна, а их ${n}`)
  }
  return result
}

function futureWorkflowMessage(version: number): string {
  return `воркфлоу сохранён в формате версии ${version}, приложение знает только ${WORKFLOW_VERSION} — обновите приложение`
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Форма графа — то, без чего `validateWorkflow` упадёт, а не вернёт ошибку: объект, числовая версия,
 * массивы нод и рёбер, строковые id/тип/концы рёбер, числовые координаты. Возвращает копию.
 */
function parseWorkflow(v: unknown): Workflow {
  if (!isObject(v)) throw new Error('воркфлоу: ожидается объект')
  if (typeof v.version !== 'number') throw new Error('воркфлоу: нет номера версии формата')
  if (!Array.isArray(v.nodes) || !Array.isArray(v.edges)) throw new Error('воркфлоу: nodes и edges должны быть массивами')
  v.nodes.forEach((n: unknown, i) => {
    if (!isObject(n)) throw new Error(`воркфлоу: нода №${i + 1} — не объект`)
    if (typeof n.id !== 'string' || typeof n.type !== 'string') throw new Error(`воркфлоу: нода №${i + 1} — id и тип должны быть строками`)
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) throw new Error(`воркфлоу: нода «${n.id}» — координаты должны быть числами`)
  })
  v.edges.forEach((e: unknown, i) => {
    if (!isObject(e)) throw new Error(`воркфлоу: переход №${i + 1} — не объект`)
    for (const key of ['id', 'from', 'to', 'outcome'] as const) {
      if (typeof e[key] !== 'string') throw new Error(`воркфлоу: переход №${i + 1} — ${key} должен быть строкой`)
    }
  })
  // Форма проверена выше; остальное (типы нод, порты, роли) проверяет validateWorkflow.
  return cloneWorkflow(v as unknown as Workflow)
}

function cloneWorkflow(wf: Workflow): Workflow {
  return JSON.parse(JSON.stringify(wf)) as Workflow
}

/** Граф из projects.json: битый → undefined, старая версия → migrateWorkflow, будущая — как есть. */
function loadedWorkflow(v: unknown): Workflow | undefined {
  if (v === undefined) return undefined
  try {
    return migrateWorkflow(parseWorkflow(v))
  } catch {
    return undefined
  }
}

/** Граф на сохранение: форма, миграция, `validateWorkflow`; ошибки — одним сообщением. */
function checkedWorkflow(v: unknown, ctx: WfValidationContext): Workflow {
  const wf = migrateWorkflow(parseWorkflow(v))
  // Будущую версию validateWorkflow тоже отвергает («обновите приложение»).
  const { errors } = validateWorkflow(wf, ctx)
  if (errors.length) throw new Error(`воркфлоу не сохранён: ${errors.map((e) => e.message).join('; ')}`)
  return wf
}

// ---------- шаблоны проектов ----------

const GENERAL_TITLE = 'Общий'
const GENERAL_DESCRIPTION = 'Перенесён из «Настройки → Для новых проектов».'

function isBuiltinId(id: string): boolean {
  return BUILTIN_TEMPLATES.some((t) => t.id === id)
}

function readonlyTemplateMessage(id: string): string {
  const title = BUILTIN_TEMPLATES.find((t) => t.id === id)?.title ?? id
  return `шаблон «${title}» встроенный и только для чтения: без копии в нём меняются только агент, модель и усилие ролей, остальное — через «Дублировать»`
}

function cloneTemplate(t: ProjectTemplate): ProjectTemplate {
  return JSON.parse(JSON.stringify(t)) as ProjectTemplate
}

/**
 * Настройки шаблона с встроенными значениями вместо незаданных (копии). Граф, совпадающий с дефолтным по ролям
 * шаблона, не копируется: у проекта без своего графа он и так дефолтный, зато следует за правкой ролей
 * (удалили `reviewer` — ревью человеком). Так «Общий» даёт проекту то же, что старый пустой дефолт.
 */
function resolvedSettings(s: ProjectTemplateSettings): ProjectDefaults {
  const roles = (s.roles ?? DEFAULT_ROLES).map((r) => ({ ...r }))
  const workflow = s.workflow && stableJson(s.workflow) !== stableJson(defaultWorkflow(roles)) ? cloneWorkflow(s.workflow) : undefined
  return {
    permissionMode: s.permissionMode ?? 'auto',
    ...(s.enabledAgents ? { enabledAgents: [...s.enabledAgents] } : {}),
    roles,
    columns: (s.columns ?? DEFAULT_COLUMNS).map((c) => ({ ...c })),
    ...(s.agentRules ? { agentRules: s.agentRules } : {}),
    ...(workflow ? { workflow } : {})
  }
}

/**
 * Патч настроек поверх `base`: разрешения — по `PERMISSION_MODES`, роли и колонки — `validateRoles` /
 * `validateColumns`, агенты фильтруются `isAgentKind` (явный null — «все установленные»), правила из пробелов
 * удаляют поле, граф проверяется по ролям и колонкам с учётом этого же патча. `label` — начало текста ошибки.
 */
function validSettings(patch: unknown, base: ProjectTemplateSettings, label: string): ProjectTemplateSettings {
  if (!isObject(patch)) throw new Error(`${label}: ожидается объект`)
  const p = patch as Partial<ProjectDefaults>
  const next: ProjectTemplateSettings = { ...base }
  if (p.permissionMode !== undefined) {
    if (!isPermissionMode(p.permissionMode)) throw new Error(`${label}: неизвестный режим разрешений: ${String(p.permissionMode)}`)
    next.permissionMode = p.permissionMode
  }
  if ('enabledAgents' in p) {
    if (p.enabledAgents == null) delete next.enabledAgents
    else if (!Array.isArray(p.enabledAgents)) throw new Error(`${label}: enabledAgents должен быть массивом`)
    else next.enabledAgents = p.enabledAgents.filter((a) => isAgentKind(a))
  }
  if (p.roles !== undefined) next.roles = validateRoles(p.roles)
  if (p.columns !== undefined) next.columns = validateColumns(p.columns)
  if ('agentRules' in p) {
    const rules = validateAgentRules(p.agentRules ?? '')
    if (rules) next.agentRules = rules
    else delete next.agentRules
  }
  if ('workflow' in p) {
    if (p.workflow == null) delete next.workflow
    else next.workflow = checkedWorkflow(p.workflow, {
      roles: next.roles ?? DEFAULT_ROLES, columns: next.columns ?? DEFAULT_COLUMNS, enabledAgents: next.enabledAgents
    })
  }
  return next
}

/**
 * Шаблон из projects.json: без id, названия или объекта настроек — отбрасывается. Настройки проходят ту же
 * `validSettings`, что при сохранении: руками испорченный шаблон (роли, колонки, разрешения, граф) отбрасывается
 * целиком, а не по разделам — граф ссылается на роли и колонки, и «починенный» по частям шаблон молча стал бы
 * другим типом проекта. Проекты с его `templateId` сравниваются с шаблоном по умолчанию (`baseTemplate`).
 * Мусор, который терпели и раньше, чистится без отказа: нестроковые правила, граф будущей версии хранится как есть.
 */
function loadedTemplate(v: unknown): ProjectTemplate[] {
  if (!isObject(v) || !nonEmpty(v.id) || !nonEmpty(v.title) || !isObject(v.settings)) return []
  const raw = { ...v.settings }
  if (raw.agentRules !== undefined && typeof raw.agentRules !== 'string') delete raw.agentRules
  const wf = loadedWorkflow(raw.workflow)
  // Будущую версию графа validateWorkflow отвергает — её не проверяем, как и у проекта (`workflow(id)` откажет при запуске).
  const future = wf && wf.version > WORKFLOW_VERSION ? wf : undefined
  if (wf && !future) raw.workflow = wf
  else delete raw.workflow
  let settings: ProjectTemplateSettings
  try {
    settings = validSettings(raw, {}, `шаблон «${v.title}»`)
  } catch {
    return []
  }
  if (future) settings.workflow = future
  // Флаг builtin — только у шаблонов из кода; сохранённая копия встроенного — обычный пользовательский шаблон.
  return [{
    id: v.id, title: v.title,
    ...(typeof v.description === 'string' && v.description.trim() ? { description: v.description } : {}),
    settings
  }]
}

/**
 * Старый `defaults` (единственный дефолт для новых проектов) → пользовательский шаблон «Общий» с тем же
 * содержимым, он же шаблон по умолчанию. Пустой дефолт ничего не создаёт: встроенный «Общий» равен ему.
 * Проектам `templateId` не проставляется — без него они сравниваются с шаблоном по умолчанию, как раньше с дефолтом.
 */
function migrateDefaults(data: ProjectsFile): void {
  const d = data.defaults
  delete data.defaults
  const templates = data.templates ?? []
  if (!d || !Object.keys(d).length || templates.some((t) => t.id === GENERAL_TEMPLATE_ID)) return
  // Старый дефолт проверяется как любой шаблон из файла: битый не становится шаблоном по умолчанию.
  const general = loadedTemplate({ id: GENERAL_TEMPLATE_ID, title: GENERAL_TITLE, description: GENERAL_DESCRIPTION, settings: d })
  if (!general.length) return
  templates.push(...general)
  data.templates = templates
  data.defaultTemplateId ??= GENERAL_TEMPLATE_ID
}
