import type { ClientCommandContext, OperatorCall, OperatorMetadata, OperatorReply } from '@orca-board/contracts'
import { clientCommandContextFrom } from './project-commands.ts'
import { assertOperatorHello, protocolError, protocolObject, protocolText } from './operator-handshake.ts'
import { operatorError, type MutationLedger } from './mutation-ledger.ts'
import type { ObserverEvents, ObserverSubscription } from './observer-events.ts'

export interface OperatorCommandDescriptor {
  capability: string
  mutation: boolean
  scope?: 'project' | 'dialog' | 'profile'
  invoke(context: ClientCommandContext, args: unknown[], projectId?: string): unknown | Promise<unknown>
}
export interface OperatorSessionOptions {
  context: ClientCommandContext
  metadata: OperatorMetadata
  ledger: MutationLedger
  events: ObserverEvents
  commands: Record<string, OperatorCommandDescriptor>
  getRevision(projectId?: string, dialogId?: string): number
  authorizeProject?: (context: ClientCommandContext, projectId: string) => boolean
  onDetach?: (context: ClientCommandContext) => void
}
function callFrom(raw: unknown): OperatorCall {
  if (!protocolObject(raw) || Object.keys(raw).some(k => !['id', 'issuedAt', 'method', 'args', 'projectId', 'revision'].includes(k))) protocolError('protocol.invalidInput', 'Некорректная команда')
  const id = protocolText(raw.id, 'id'); const method = protocolText(raw.method, 'method')
  if (typeof raw.issuedAt !== 'number' || !Number.isSafeInteger(raw.issuedAt) || raw.issuedAt < 0 || !Array.isArray(raw.args) || raw.args.length > 32) protocolError('protocol.invalidInput', 'Некорректные args/issuedAt')
  let text: string; try { text = JSON.stringify(raw) } catch { protocolError('protocol.invalidInput', 'Команда должна быть JSON') }
  if (Buffer.byteLength(text) > 64 * 1024) protocolError('protocol.invalidInput', 'Команда превышает 64KiB')
  if (raw.revision !== undefined && (typeof raw.revision !== 'number' || !Number.isSafeInteger(raw.revision) || raw.revision < 0)) protocolError('protocol.invalidInput', 'Некорректная revision')
  return { id, method, issuedAt: raw.issuedAt, args: structuredClone(raw.args), ...(raw.projectId === undefined ? {} : { projectId: protocolText(raw.projectId, 'projectId', 8192) }), ...(raw.revision === undefined ? {} : { revision: raw.revision as number }) }
}

/** Context приходит только от проверившего соединение host. Selection не меняет профиль/active project. */
export function createOperatorSession(options: OperatorSessionOptions) {
  const context = clientCommandContextFrom(options.context)
  if (context.actor.kind !== 'operator') protocolError('command.forbidden', 'Operator endpoint доступен только operator principal')
  const commands = new Map(Object.entries(options.commands)); const subscriptions = new Set<ObserverSubscription>()
  let ready = false; let closed = false; let selection: { projectId?: string; dialogId?: string } = {}
  const guard = () => { if (closed) protocolError('protocol.closed', 'Соединение закрыто'); if (!ready) protocolError('protocol.handshakeRequired', 'Сначала требуется handshake') }
  const projectAllowed = (projectId: string) => { if (options.authorizeProject?.(structuredClone(context), projectId) === false) protocolError('command.forbidden', 'Нет доступа к проекту') }
  const filter = (event: { projectId?: string }) => !event.projectId || (!selection.projectId || event.projectId === selection.projectId) && options.authorizeProject?.(structuredClone(context), event.projectId) !== false
  return {
    hello(raw: unknown): OperatorMetadata {
      if (closed) protocolError('protocol.closed', 'Соединение закрыто')
      const metadata = assertOperatorHello(raw, options.metadata); ready = true; return metadata
    },
    get selection() { return structuredClone(selection) },
    select(raw: unknown): void {
      guard()
      if (!protocolObject(raw) || Object.keys(raw).some(k => !['projectId', 'dialogId'].includes(k))) protocolError('protocol.invalidInput', 'Некорректный выбор клиента')
      const next = { ...(raw.projectId === undefined ? {} : { projectId: protocolText(raw.projectId, 'projectId', 8192) }), ...(raw.dialogId === undefined ? {} : { dialogId: protocolText(raw.dialogId, 'dialogId') }) }
      if (next.projectId) projectAllowed(next.projectId)
      selection = next
    },
    async call(raw: unknown): Promise<OperatorReply> {
      let id = ''
      try {
        guard(); const call = callFrom(raw); id = call.id; const descriptor = commands.get(call.method)
        if (!descriptor || !options.metadata.capabilities.includes(descriptor.capability)) protocolError('protocol.capabilityMissing', 'Команда недоступна этому соединению')
        if (descriptor.scope === 'project' && !call.projectId) protocolError('protocol.invalidInput', 'Требуется явный projectId')
        if (call.projectId) projectAllowed(call.projectId)
        const invoke = async () => {
          guard(); if (call.projectId) projectAllowed(call.projectId)
          if (descriptor.mutation && call.revision !== options.getRevision(call.projectId, descriptor.scope === 'dialog' ? String(call.args[0]) : undefined)) protocolError('command.stale', 'Revision изменилась; обновите snapshot')
          return await descriptor.invoke(structuredClone(context), call.args, call.projectId)
        }
        if (!descriptor.mutation) return { id, ok: true, result: structuredClone(await invoke()) }
        const outcome = await options.ledger.execute({ ...call, clientId: context.clientId, actorId: context.actor.id }, invoke)
        if (outcome.status === 'applied') return { id, ok: true, result: outcome.result }
        return { id, ok: false, error: outcome.status === 'rejected' ? outcome.error : { code: 'protocol.outcomeUncertain' } }
      } catch (error) { return { id, ok: false, error: operatorError(error) } }
    },
    subscribe(cursor: unknown): ObserverSubscription { guard(); const sub = options.events.subscribe(cursor, filter); subscriptions.add(sub); return sub },
    snapshot<T>(read: (context: ClientCommandContext, selection: { projectId?: string; dialogId?: string }) => T) {
      guard(); const result = options.events.snapshot(() => read(structuredClone(context), structuredClone(selection)), filter)
      subscriptions.add(result.subscription); return result
    },
    close(): void {
      if (closed) return; closed = true
      for (const sub of subscriptions) sub.close(); subscriptions.clear()
      options.onDetach?.(structuredClone(context))
    }
  }
}
export type OperatorSession = ReturnType<typeof createOperatorSession>
