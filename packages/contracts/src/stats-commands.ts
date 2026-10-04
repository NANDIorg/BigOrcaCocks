import type { GlobalTaskStats, ProjectStats, StatsRange, TaskStats } from '@orca-board/core'
import type { ProjectCommandContext } from './project-commands.ts'

export interface StatsCommands {
  project(context: ProjectCommandContext, range: StatsRange): Promise<ProjectStats>
  task(context: ProjectCommandContext, taskId: string): Promise<TaskStats>
  global(context: ProjectCommandContext, runId: string): Promise<GlobalTaskStats>
}
export type StatsCommandName = `stats.${keyof StatsCommands}`
