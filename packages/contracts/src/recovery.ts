import type { ClientCommandContext } from './project-commands.ts'

export interface EffectPosition {
  repoRoot: string
  projectId?: string
  taskId?: string
  runId?: string
  nodeId?: string
  visit?: number
  laneId?: string
  forkVisit?: number
  dispatchId?: string
  taskCreatedAt?: number
  runCreatedAt?: number
}
export interface NativeEffect { kind: 'git' | 'pty' | 'files'; operation: string; cwd: string; resource?: string }
export type EffectResolution = 'retry' | 'acknowledge' | 'abandon'
export interface EffectRecord {
  id: string
  revision: number
  ownerId: string
  position: EffectPosition
  effect: NativeEffect
  phase: 'intent' | 'native-complete' | 'applied' | 'resolved'
  outcome?: 'ok' | 'failed'
  resolution?: EffectResolution
  createdAt: number
  updatedAt: number
}
export interface RecoveryWorktree { path: string; head?: string; branch?: string; dirty?: boolean; available: boolean; referenced: boolean }
export interface EffectRecoveryReport { records: Array<{ record: EffectRecord; current: boolean }>; worktrees: RecoveryWorktree[]; gitAvailable: boolean }
export interface RecoveryCommands {
  list(context: ClientCommandContext, projectId?: string): EffectRecord[]
  inspect(context: ClientCommandContext, projectId: string): Promise<EffectRecoveryReport>
  resolve(context: ClientCommandContext, id: string, revision: number, resolution: EffectResolution): EffectRecord
}
export type RecoveryCommandName = `recovery.${keyof RecoveryCommands}`
