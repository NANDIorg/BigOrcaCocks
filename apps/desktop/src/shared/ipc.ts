import type { Task, TaskStatus, AgentKind, OrcaEvent } from '@orca-board/core'

export interface PtySpawnOptions {
  cwd?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cols: number
  rows: number
}

/** Контракт между renderer и main. Реализуется в preload как window.orca. */
export interface OrcaApi {
  tasks: {
    list(): Promise<Task[]>
    create(input: { title: string; spec?: string; deps?: string[]; agent?: AgentKind }): Promise<Task>
    move(id: string, status: TaskStatus): Promise<Task>
    remove(id: string): Promise<void>
    onChange(cb: (tasks: Task[]) => void): () => void
  }
  events: {
    list(): Promise<OrcaEvent[]>
  }
  pty: {
    spawn(opts: PtySpawnOptions): Promise<string>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(id: string, cb: (data: string) => void): () => void
    onExit(id: string, cb: (code: number) => void): () => void
  }
  /** Запустить воркера для задачи: worktree + PTY + dispatch. */
  worker: {
    start(taskId: string, cols: number, rows: number): Promise<{ ptyId: string; dispatchId: string }>
  }
}
