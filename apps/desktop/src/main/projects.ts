import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  TaskStore, isAgentKind, DEFAULT_ROLES, DEFAULT_COLUMNS, SYSTEM_COLUMN_KINDS, COLUMN_COLORS,
  type OrcaEvent, type AgentKind, type Role, type BoardColumn
} from '@orca-board/core'
import { jsonPersistence } from './persistence'

export type PermissionMode = 'auto' | 'bypassPermissions' | 'acceptEdits'

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
}

interface ProjectsFile {
  projects: Project[]
  activeId: string | null
}

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
      return JSON.parse(readFileSync(this.file, 'utf8')) as ProjectsFile
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
    const project: Project = { id, root, name: basename(root) }
    this.data.projects.push(project)
    this.data.activeId = id
    this.save()
    return project
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
      s = created
    }
    return s
  }

  activeStore(): TaskStore {
    const p = this.active()
    if (!p) throw new Error('нет проектов: добавьте репозиторий')
    return this.store(p.id)
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

/** Роли: непустые уникальные id, непустые названия, известный агент, модель — строка или отсутствует. */
function validateRoles(roles: Role[]): Role[] {
  if (!Array.isArray(roles) || roles.length === 0) throw new Error('нужна хотя бы одна роль')
  const seen = new Set<string>()
  return roles.map((r, i) => {
    if (!nonEmpty(r.id)) throw new Error(`роль №${i + 1}: пустой id`)
    if (seen.has(r.id)) throw new Error(`роль «${r.id}» указана дважды`)
    seen.add(r.id)
    if (!nonEmpty(r.title)) throw new Error(`роль «${r.id}»: пустое название`)
    if (!isAgentKind(r.agent)) throw new Error(`роль «${r.id}»: неизвестный агент ${String(r.agent)}`)
    if (r.model !== undefined && typeof r.model !== 'string') throw new Error(`роль «${r.id}»: модель должна быть строкой`)
    const model = r.model?.trim()
    return { id: r.id, title: r.title.trim(), agent: r.agent, ...(model ? { model } : {}) }
  })
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
