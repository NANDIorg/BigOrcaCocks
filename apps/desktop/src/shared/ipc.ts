import type { Task, AgentKind, AgentInfo, StoreSnapshot, Role, BoardColumn } from '@orca-board/core'

export interface PtySpawnOptions {
  cwd?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cols: number
  rows: number
}

export interface TerminalOpened {
  ptyId: string
  taskId?: string
  projectId?: string
  label: string
  role?: 'coordinator' | 'worker'
}

export type PermissionMode = 'auto' | 'bypassPermissions' | 'acceptEdits'

export const PERMISSION_MODES: Record<PermissionMode, string> = {
  auto: 'Авто — Claude сам решает, опасное спросит',
  bypassPermissions: 'Без подтверждений — полностью автономно',
  acceptEdits: 'Только правки файлов — остальное спросит в терминале'
}

export interface Project {
  id: string
  root: string
  name: string
  permissionMode?: PermissionMode
  /** Включённые агенты. undefined — все установленные. */
  enabledAgents?: AgentKind[]
  /** Роли проекта. undefined — DEFAULT_ROLES. */
  roles?: Role[]
  /** Колонки доски в порядке показа. undefined — DEFAULT_COLUMNS. */
  columns?: BoardColumn[]
}

export interface ReviewInfo {
  base: string
  branch: string
  stat: string
  commits: string[]
  dirty: boolean
}

/** Контракт между renderer и main. Реализуется в preload как window.orca. */
export interface OrcaApi {
  app: {
    info(): Promise<{ socketPath: string; active: Project | null; projects: Project[] }>
  }
  projects: {
    list(): Promise<{ active: Project | null; projects: Project[] }>
    add(): Promise<Project | null>
    remove(id: string): Promise<void>
    setActive(id: string): Promise<Project>
    setPermissionMode(id: string, mode: PermissionMode): Promise<Project>
    setEnabledAgents(id: string, agents: AgentKind[]): Promise<Project>
    setRoles(id: string, roles: Role[]): Promise<Project>
    /** Задачи из удалённых колонок переезжают в backlog. */
    setColumns(id: string, columns: BoardColumn[]): Promise<Project>
    /** Клик по уведомлению: показать этот проект. */
    onFocus(cb: (projectId: string) => void): () => void
  }
  agents: {
    /** Агенты реестра с признаками «установлен»/«включён» для активного проекта. refresh — пересканировать PATH. */
    list(refresh?: boolean): Promise<AgentInfo[]>
  }
  board: {
    get(): Promise<StoreSnapshot>
    onChange(cb: (p: { projectId: string; snapshot: StoreSnapshot }) => void): () => void
  }
  tasks: {
    /** Без roleId — единственная роль проекта, иначе ошибка. */
    create(input: { title: string; spec?: string; deps?: string[]; roleId?: string }): Promise<Task>
    /** status — id колонки. */
    move(id: string, status: string): Promise<Task>
    remove(id: string): Promise<void>
  }
  questions: {
    answer(id: string, answer: string): Promise<void>
  }
  pty: {
    spawn(opts: PtySpawnOptions): Promise<string>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(id: string, cb: (data: string) => void): () => void
    onExit(id: string, cb: (code: number) => void): () => void
  }
  worker: {
    start(taskId: string, cols: number, rows: number): Promise<{ ptyId: string; dispatchId: string }>
    /** Терминал открыт (из UI или через CLI координатора). */
    onOpened(cb: (t: TerminalOpened) => void): () => void
  }
  coordinator: {
    start(objective: string, cols: number, rows: number): Promise<string>
  }
  review: {
    info(taskId: string): Promise<ReviewInfo>
    accept(taskId: string): Promise<void>
    reject(taskId: string, feedback: string): Promise<void>
  }
}
