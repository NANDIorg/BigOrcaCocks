import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { TaskStore, type OrcaEvent } from '@orca-board/core'
import { jsonPersistence } from './persistence'

export interface Project {
  id: string
  root: string
  name: string
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
      const created = new TaskStore(jsonPersistence(join(this.userData, 'boards', `${id}.json`)))
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
