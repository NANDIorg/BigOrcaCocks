import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  TaskStore, isAgentKind, DEFAULT_ROLES, withDefaultDescriptions, DEFAULT_COLUMNS, SYSTEM_COLUMN_KINDS, COLUMN_COLORS,
  WORKFLOW_VERSION, defaultWorkflow, migrateWorkflow, validateWorkflow,
  type OrcaEvent, type AgentKind, type Role, type BoardColumn, type Workflow, type WfValidationContext
} from '@orca-board/core'
import { jsonPersistence } from './persistence'
import type { AppSettings, AppSettingsPatch } from '../shared/ipc'
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
  /** Глобальный дефолт для новых проектов; незаданные поля — встроенные значения. */
  defaults?: Partial<ProjectDefaults>
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

  /** Добавить репозиторий. Путь нормализуется до корня git. */
  add(path: string): Project {
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
    const id = createHash('sha1').update(root).digest('hex').slice(0, 10)
    const d = this.defaults()
    const project: Project = {
      id, root, name: basename(root),
      permissionMode: d.permissionMode,
      ...(d.enabledAgents ? { enabledAgents: d.enabledAgents } : {}),
      roles: d.roles,
      columns: d.columns,
      ...(d.agentRules ? { agentRules: d.agentRules } : {}),
      ...(d.workflow ? { workflow: d.workflow } : {})
    }
    this.data.projects.push(project)
    this.data.activeId = id
    this.save()
    return project
  }

  /** Глобальный дефолт; незаданные поля — встроенные значения. Массивы — копии. */
  defaults(): ProjectDefaults {
    const d = this.data.defaults ?? {}
    return {
      permissionMode: d.permissionMode ?? 'auto',
      ...(d.enabledAgents ? { enabledAgents: [...d.enabledAgents] } : {}),
      roles: (d.roles ?? DEFAULT_ROLES).map((r) => ({ ...r })),
      columns: (d.columns ?? DEFAULT_COLUMNS).map((c) => ({ ...c })),
      ...(d.agentRules ? { agentRules: d.agentRules } : {}),
      ...(d.workflow ? { workflow: cloneWorkflow(d.workflow) } : {})
    }
  }

  /**
   * Смержить патч в дефолт. Роли и колонки проходят ту же валидацию, что у проекта;
   * enabledAgents: null/undefined в патче с явным ключом — «все установленные».
   */
  setDefaults(patch: Partial<ProjectDefaults>): ProjectDefaults {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('настройки по умолчанию: ожидается объект')
    const next: Partial<ProjectDefaults> = { ...(this.data.defaults ?? {}) }
    if (patch.permissionMode !== undefined) {
      if (!isPermissionMode(patch.permissionMode)) throw new Error(`неизвестный режим разрешений: ${String(patch.permissionMode)}`)
      next.permissionMode = patch.permissionMode
    }
    if ('enabledAgents' in patch) {
      if (patch.enabledAgents == null) delete next.enabledAgents
      else if (!Array.isArray(patch.enabledAgents)) throw new Error('enabledAgents должен быть массивом')
      else next.enabledAgents = patch.enabledAgents.filter((a) => isAgentKind(a))
    }
    if (patch.roles !== undefined) next.roles = validateRoles(patch.roles)
    if (patch.columns !== undefined) next.columns = validateColumns(patch.columns)
    if ('agentRules' in patch) {
      const rules = validateAgentRules(patch.agentRules ?? '')
      if (rules) next.agentRules = rules
      else delete next.agentRules
    }
    if ('workflow' in patch) {
      // Граф проверяется по ролям и колонкам дефолта с учётом этого же патча.
      if (patch.workflow == null) delete next.workflow
      else next.workflow = checkedWorkflow(patch.workflow, {
        roles: next.roles ?? DEFAULT_ROLES, columns: next.columns ?? DEFAULT_COLUMNS, enabledAgents: next.enabledAgents
      })
    }
    this.data.defaults = next
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

  /** Переписать настройки проекта дефолтом. Задачи из исчезнувших колонок уходят в backlog. */
  applyDefaults(id: string): Project {
    const p = this.get(id)
    if (!p) throw new Error(`project not found: ${id}`)
    const d = this.defaults()
    p.permissionMode = d.permissionMode
    if (d.enabledAgents) p.enabledAgents = d.enabledAgents
    else delete p.enabledAgents
    if (d.agentRules) p.agentRules = d.agentRules
    else delete p.agentRules
    // Без повторной проверки: граф дефолта проверен по ролям дефолта, а они сейчас же станут ролями проекта.
    if (d.workflow) p.workflow = d.workflow
    else delete p.workflow
    this.setRoles(id, d.roles)
    return this.setColumns(id, d.columns)
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
    const next = validateColumns(columns)
    const store = this.store(id)
    // Сначала применяем новый набор: store читает колонки через this.columns(id),
    // и перенос задач должен считать doneAt/ready уже по новым колонкам.
    p.columns = next
    this.save()
    const backlogId = next.find((c) => c.kind === 'backlog')!.id
    const keep = new Set(next.map((c) => c.id))
    const orphaned = new Set(store.listTasks().map((t) => t.status).filter((s) => !keep.has(s)))
    for (const oldId of orphaned) store.reassignColumn(oldId, backlogId)
    return p
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
