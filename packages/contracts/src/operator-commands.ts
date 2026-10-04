import type { ProfileCommands } from './profile-commands.ts'
import type { ProjectConfigCommands } from './project-config-commands.ts'
import type { BoardCommands } from './board-commands.ts'
import type { GlobalTaskCommands } from './global-task-commands.ts'
import type { CoordinatorCommands } from './coordinator-commands.ts'
import type { WorkerCommands } from './worker-commands.ts'
import type { ReviewCommands } from './review-commands.ts'
import type { HumanRequestCommands } from './human-request-commands.ts'
import type { ProjectGitCommands } from './project-git-commands.ts'
import type { RunCommands } from './run-commands.ts'
import type { AgentCommands } from './agent-commands.ts'
import type { SessionCommands } from './session-commands.ts'
import type { RecoveryCommands } from './recovery.ts'
import type { RuleCommands } from './rule-commands.ts'
import type { StatsCommands } from './stats-commands.ts'
import type { FileCommands } from './file-commands.ts'
import type { DialogCommands } from './dialog-commands.ts'
import type { BuiltinPrompts } from '@orca-board/core'
import type { ClientCommandContext } from './project-commands.ts'

/** Binary и PTY stream отделены от JSON RPC; native actions задаёт PlatformAdapter. */
export interface OperatorCommands {
  profile: ProfileCommands
  projectConfig: ProjectConfigCommands
  board: BoardCommands
  globalTask: Omit<GlobalTaskCommands, 'image' | 'attachment'>
  coordinator: CoordinatorCommands
  worker: WorkerCommands
  review: ReviewCommands
  humanRequest: HumanRequestCommands
  projectGit: ProjectGitCommands
  run: RunCommands
  agent: AgentCommands
  session: Omit<SessionCommands, 'write' | 'resize'>
  recovery: RecoveryCommands
  rules: RuleCommands
  stats: StatsCommands
  files: Omit<FileCommands, 'openDoc' | 'revealDoc' | 'revealFile' | 'openShowcase' | 'revealShowcase' | 'docBytes' | 'downloadDoc' | 'readShowcase'>
  dialog: DialogCommands
  resources: {
    builtinPrompts(context: ClientCommandContext): BuiltinPrompts
    assistantTerminal(context: ClientCommandContext, cols: number, rows: number): string
  }
}
export type OperatorArgs<F> = F extends (...args: infer A) => unknown ? A extends [unknown, ...infer Rest] ? Rest : never : never
export type OperatorResult<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never
