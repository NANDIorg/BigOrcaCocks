import { withStatusSource, type StatusSource } from '@orca-board/core'
import type { ClientCommandContext } from '@orca-board/contracts'
import { CommandError, clientCommandContextFrom, type ClientCommandHost } from './project-commands.ts'
import type { AsyncCommandScope } from './async-project-commands.ts'

export function createAsyncClientCommandExecutor<Name extends string>(host: ClientCommandHost<Name>) {
  return async function execute<T>(raw: unknown, command: Name,
    validate: () => (context: ClientCommandContext, scope: AsyncCommandScope) => T | Promise<T>): Promise<T> {
    try {
      const context = clientCommandContextFrom(raw)
      const allowed = () => host.authorize(structuredClone(context), command) === true
      const assertAllowed = () => { if (!allowed()) throw new CommandError('command.forbidden') }
      assertAllowed()
      const operation = validate()
      const source: StatusSource = context.actor.kind === 'operator' ? 'human' : context.actor.kind === 'agent' ? 'cli' : 'app'
      const scope: AsyncCommandScope = { guard: assertAllowed, isCurrent: allowed, commit: operation => {
        assertAllowed(); return withStatusSource(source, operation)
      } }
      const result = await scope.commit(() => operation(context, scope))
      assertAllowed()
      return structuredClone(result)
    } catch (error) {
      if (error instanceof CommandError) throw error
      throw new CommandError('command.rejected', { reason: error instanceof Error ? error.message : String(error) }, error)
    }
  }
}
