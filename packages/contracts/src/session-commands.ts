import type { ClientCommandContext } from './project-commands.ts'
import type { PtySpawnOptions, TerminalSnapshot } from './sessions.ts'

export interface WriterLease { id: string; ptyId: string; clientId: string; expiresAt: number }
export interface SessionCommands {
  spawn(context: ClientCommandContext, options: PtySpawnOptions): string
  list(context: ClientCommandContext): TerminalSnapshot[]
  writer(context: ClientCommandContext, ptyId: string): WriterLease | null
  claimWriter(context: ClientCommandContext, ptyId: string): WriterLease
  renewWriter(context: ClientCommandContext, ptyId: string, leaseId: string): WriterLease
  releaseWriter(context: ClientCommandContext, ptyId: string, leaseId: string): void
  write(context: ClientCommandContext, ptyId: string, data: string, leaseId: string): void
  resize(context: ClientCommandContext, ptyId: string, cols: number, rows: number, leaseId: string): void
  kill(context: ClientCommandContext, ptyId: string): void
}
export type SessionCommandName = `sessions.${keyof SessionCommands}`
