import type { Task, TaskStatus, AgentKind, StoreSnapshot } from '@orca-board/core'

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
  label: string
}

/** Контракт между renderer и main. Реализуется в preload как window.orca. */
export interface OrcaApi {
  app: {
    info(): Promise<{ repoRoot: string; repoName: string; socketPath: string }>
  }
  board: {
    get(): Promise<StoreSnapshot>
    onChange(cb: (snapshot: StoreSnapshot) => void): () => void
  }
  tasks: {
    create(input: { title: string; spec?: string; deps?: string[]; agent?: AgentKind }): Promise<Task>
    move(id: string, status: TaskStatus): Promise<Task>
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
  /** Запустить воркера для задачи: worktree + PTY + dispatch. */
  worker: {
    start(taskId: string, cols: number, rows: number): Promise<{ ptyId: string; dispatchId: string }>
    /** Терминал открыт извне (через CLI координатора). */
    onOpened(cb: (t: TerminalOpened) => void): () => void
  }
}
