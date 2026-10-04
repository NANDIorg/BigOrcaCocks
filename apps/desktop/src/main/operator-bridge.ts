import { createOperatorUploads, createOperatorWriter, readOperatorBinary, readOperatorSnapshot, type OperatorSession, type ObserverSubscription, type createOperatorApi } from '@orca-board/runtime'
import type { BoardCommands, ClientCommandContext, DialogCommands, FileCommands, GlobalTaskCommands, ProfileCommands, SessionCommands } from '@orca-board/contracts'
import type { createSessionWriterLeases } from '@orca-board/runtime'

export interface DesktopOperatorHost<E> {
  handle(channel: string, handler: (event: E, ...args: unknown[]) => unknown): void
  clientId(event: E): string | null
  onDestroyed(event: E, callback: () => void): void
  api: ReturnType<typeof createOperatorApi>
  profile: ProfileCommands
  board: BoardCommands
  dialog: DialogCommands
  session: SessionCommands
  files: FileCommands
  globalTask: GlobalTaskCommands
  leases: ReturnType<typeof createSessionWriterLeases>
  revision(): number
}
/** IPC проверяет main frame до lookup/session создания; close отсоединяет клиента, сохраняя owner. */
export function registerDesktopOperator<E>(host: DesktopOperatorHost<E>) {
  const clients = new Map<string, { session: OperatorSession; subscription?: ObserverSubscription }>()
  const uploads = createOperatorUploads(); const writer = createOperatorWriter({ sessions: host.session, leases: host.leases })
  let closed = false
  const detach = (id: string) => { const entry = clients.get(id); if (entry) { entry.session.close(); clients.delete(id) } }
  const context = (event: E): ClientCommandContext => {
    const clientId = host.clientId(event)
    if (closed || !clientId) throw new Error('Operator IPC доступен только главному окну')
    return { clientId, actor: { kind: 'operator', id: 'local-user' } }
  }
  const require = (event: E) => { const ctx = context(event); const entry = clients.get(ctx.clientId); if (!entry) throw new Error('Требуется operator handshake'); return { ctx, entry } }
  host.handle('operator:hello', (event, hello) => {
    const ctx = context(event); const existing = clients.get(ctx.clientId)
    if (existing) return existing.session.hello(hello)
    if (clients.size >= 8) throw new Error('Достигнут лимит operator clients')
    const session = host.api.operator(ctx)
    try { const metadata = session.hello(hello); clients.set(ctx.clientId, { session }); host.onDestroyed(event, () => detach(ctx.clientId)); return metadata }
    catch (error) { session.close(); throw error }
  })
  host.handle('operator:call', (event, input) => { const { ctx, entry } = require(event); return entry.session.call(input, id => uploads.get(ctx.clientId, id)) })
  host.handle('operator:select', (event, input) => { const { entry } = require(event); entry.session.select(input); entry.subscription?.close(); entry.subscription = undefined })
  host.handle('operator:snapshot', event => {
    const { entry } = require(event); entry.subscription?.close()
    const result = entry.session.snapshot((ctx, selection) => readOperatorSnapshot(host, ctx, selection))
    entry.subscription = result.subscription; return { snapshot: result.snapshot, cursor: result.cursor }
  })
  host.handle('operator:events', event => require(event).entry.subscription?.take() ?? [])
  host.handle('operator:close', event => detach(context(event).clientId))
  host.handle('operator:upload', (event, raw) => uploads.add(require(event).ctx.clientId, raw))
  host.handle('operator:binary', (event, raw) => readOperatorBinary(host, require(event).ctx, raw))
  host.handle('operator:writer', (event, raw) => { writer.send(require(event).ctx, raw) })
  return { stop() { closed = true; for (const id of clients.keys()) detach(id); uploads.clear(); writer.clear() } }
}
