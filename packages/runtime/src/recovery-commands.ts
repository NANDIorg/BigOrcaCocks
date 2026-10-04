import type { RecoveryCommands, RecoveryCommandName } from '@orca-board/contracts'
import { CommandError, createClientCommandExecutor, type ClientCommandHost } from './project-commands.ts'
import { createAsyncClientCommandExecutor } from './async-client-commands.ts'
import { commandInputError, commandString } from './command-input.ts'
import type { EffectProject } from './effect-scope.ts'
import type { EffectJournal } from './effect-journal.ts'
import type { GitProcessService } from './git-process.ts'
import { inspectEffectRecovery } from './effect-reconciliation.ts'

export interface RecoveryCommandHost extends ClientCommandHost<RecoveryCommandName> {
  journal(): EffectJournal
  project(id: string): EffectProject | undefined
  isCurrent(project: EffectProject): boolean
  processes: GitProcessService
}
/** Решение оператора разрешает следующие действия, но само не повторяет native effect. */
export function createRecoveryCommands(host: RecoveryCommandHost): RecoveryCommands {
  const authorized = { authorize: (ctx: Parameters<typeof host.authorize>[0], name: RecoveryCommandName) => ctx.actor.kind === 'operator' && host.authorize(ctx, name) }
  const execute = createClientCommandExecutor(authorized); const asyncExecute = createAsyncClientCommandExecutor(authorized)
  return {
    list: (context, projectId) => execute(context, 'recovery.list', () => {
      const id = projectId === undefined ? undefined : commandString(projectId, 'projectId')
      return () => host.journal().pending().filter(r => id === undefined || r.position.projectId === id)
    }),
    inspect: (context, projectId) => asyncExecute(context, 'recovery.inspect', () => {
      const id = commandString(projectId, 'projectId')
      return async (_ctx, scope) => {
        const project = host.project(id)
        if (!project) throw new CommandError('command.projectNotFound', { projectId: id })
        const { root, store } = project
        const report = await inspectEffectRecovery(host.journal(), project, host.processes)
        scope.guard()
        if (!host.isCurrent(project) || project.root !== root || project.store !== store) throw new CommandError('command.stale', { projectId: id })
        return report
      }
    }),
    resolve: (context, id, revision, resolution) => execute(context, 'recovery.resolve', () => {
      const key = commandString(id, 'id')
      if (!Number.isSafeInteger(revision) || revision < 1) commandInputError('revision')
      if (resolution !== 'retry' && resolution !== 'acknowledge' && resolution !== 'abandon') commandInputError('resolution')
      return () => host.journal().resolve(key, revision, resolution)
    })
  }
}
