import type { AttachmentInput, GlobalTask } from '@orca-board/core'
import type { ProjectCommandContext } from './project-commands.ts'

export type CoordinatorCommandName = 'coordinator.start' | 'globalTasks.startCoordinator' | 'globalTasks.accept' | 'globalTasks.returnToWork'

export interface CoordinatorLaunchInput {
  cols?: number
  rows?: number
  images?: AttachmentInput[] | null
}

export interface CoordinatorStartInput extends CoordinatorLaunchInput { objective: string; typeId?: string }
export interface CoordinatorReturnInput extends CoordinatorLaunchInput { text: string }
export interface CoordinatorLaunchResult { ptyId: string; runId: string }

/** Owner API запуска и human workflow actions. Контекст задаёт host, пути вложений не принимаются. */
export interface CoordinatorCommands {
  start(context: ProjectCommandContext, input: CoordinatorStartInput): Promise<CoordinatorLaunchResult>
  startCoordinator(context: ProjectCommandContext, globalTaskId: string, input?: CoordinatorLaunchInput): Promise<CoordinatorLaunchResult>
  accept(context: ProjectCommandContext, globalTaskId: string, decision?: string): Promise<GlobalTask>
  returnToWork(context: ProjectCommandContext, globalTaskId: string, input: CoordinatorReturnInput): Promise<CoordinatorLaunchResult>
}
