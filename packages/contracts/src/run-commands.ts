import type { Run } from '@orca-board/core'
import type { ProjectCommandContext } from './project-commands.ts'

export interface RunSummary extends Run { tasks: number; done: number }
export interface RunCommands {
  list(context: ProjectCommandContext): Run[]
  listWithCounts(context: ProjectCommandContext): RunSummary[]
  close(context: ProjectCommandContext, runId: string): Run
}
export type RunCommandName = `runs.${keyof RunCommands}`
