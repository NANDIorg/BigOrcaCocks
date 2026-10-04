import type { AssistantCommands, InteractionAnswer, PtySpawnOptions, SessionCommands } from '@orca-board/contracts'
import { sessionDimension, sessionInput } from '@orca-board/runtime'
import { createDesktopProjectCommandAdapter, type DesktopCommandHandle, type DesktopProjectCommandHost } from './project-command-adapter'

export interface DesktopSessionAssistantHost<Event> extends DesktopProjectCommandHost<Event> {
  sessions: SessionCommands
  assistant: AssistantCommands
  onEventError(error: unknown, channel: string): void
}
export function registerDesktopSessionAssistantCommands<Event>(handle: DesktopCommandHandle<Event>, on: DesktopCommandHandle<Event>, host: DesktopSessionAssistantHost<Event>): void {
  const { client, invoke } = createDesktopProjectCommandAdapter(host)
  handle('pty:spawn', (event, options: PtySpawnOptions) => invoke(() => {
    const ctx = client(event)
    const projectId = options?.projectId ?? host.activeProjectId()
    return host.sessions.spawn(ctx, { ...options, ...(projectId === undefined ? {} : { projectId }) })
  }))
  handle('terminals:list', event => invoke(() => host.sessions.list(client(event))))
  function event<Args extends unknown[]>(channel: string, operation: (event: Event, ...args: Args) => void): void {
    on(channel, (event, ...args: Args) => {
      try { invoke(() => operation(event, ...args)) }
      catch (error) { host.onEventError(error, channel) }
    })
  }
  event('pty:write', (event, id: string, raw: string) => {
    const ctx = client(event); const data = sessionInput(raw)
    const lease = host.sessions.claimWriter(ctx, id)
    host.sessions.write(ctx, id, data, lease.id)
  })
  event('pty:resize', (event, id: string, cols: number, rows: number) => {
    const ctx = client(event); const width = sessionDimension(cols, 'cols', 2); const height = sessionDimension(rows, 'rows', 1)
    const lease = host.sessions.claimWriter(ctx, id)
    host.sessions.resize(ctx, id, width, height, lease.id)
  })
  event('pty:kill', (event, id: string) => host.sessions.kill(client(event), id))
  handle('assistant:open', (event, cols: number, rows: number) => invoke(() => host.assistant.open(client(event), cols, rows)))
  handle('assistant:reset', (event, cols: number, rows: number) => invoke(() => host.assistant.reset(client(event), cols, rows)))
  handle('assistantChat:available', (event, id: string) => invoke(() => host.assistant.available(client(event), id)))
  handle('assistantChat:getMessages', (event, id: string) => invoke(() => host.assistant.snapshot(client(event), id)))
  handle('assistantChat:sendWithWorkflow', (event, id: string, text: string, context: unknown) => invoke(() => host.assistant.send(client(event), id, text, context)))
  handle('assistantChat:send', (event, id: string, text: string) => invoke(() => host.assistant.send(client(event), id, text)))
  handle('assistantChat:interrupt', (event, id: string) => invoke(() => host.assistant.interrupt(client(event), id)))
  handle('assistantChat:respond', (event, id: string, requestId: string, answer: InteractionAnswer) => invoke(() => host.assistant.respond(client(event), id, requestId, answer)))
}
