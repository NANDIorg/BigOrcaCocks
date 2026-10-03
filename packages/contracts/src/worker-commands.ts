import type { ProjectCommandContext } from './project-commands.ts'

export type WorkerCommandName = 'workers.start' | 'workers.stop'

export interface WorkerLaunchInput {
  cols?: number
  rows?: number
  /** Роль только этого запуска, например агента этапа ask. */
  roleId?: string
}

export interface WorkerLaunchResult { ptyId: string; dispatchId: string; worktree: string; branch: string }
export interface WorkerStopResult { stopped: string[] }

/** Owner выбирает проект явно; principal устанавливает проверивший соединение host. */
export interface WorkerCommands {
  start(context: ProjectCommandContext, taskId: string, input?: WorkerLaunchInput): WorkerLaunchResult
  stop(context: ProjectCommandContext, taskId: string): WorkerStopResult
}
