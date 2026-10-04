import { isAgentKind, parseExtraArgs, type AgentKind, type AssistantSettings } from '@orca-board/core'
import type { ClientCommandContext, DialogCommands, DialogCommandName, Project } from '@orca-board/contracts'
import { CommandError, createClientCommandExecutor, type ClientCommandHost } from './project-commands.ts'
import { createAsyncClientCommandExecutor } from './async-client-commands.ts'
import { commandObject, commandOptionalString, commandString, invalidCommandField } from './profile-command-input.ts'
import { conversationText, interactionAnswer } from './conversation-command-input.ts'
import type { DialogRegistry } from './dialog-registry.ts'

export interface DialogCommandHost extends ClientCommandHost<DialogCommandName> {
  registry: Pick<DialogRegistry, 'list' | 'create' | 'snapshot' | 'send' | 'interrupt' | 'respond' | 'stop'>
  project(id: string): Project | undefined
  settings(): AssistantSettings
  assertUsable(agent: AgentKind): void
}
function settingsFrom(raw: unknown): Partial<AssistantSettings> {
  const value = commandObject(raw, ['agent', 'model', 'effort', 'systemPrompt', 'extraArgs'], 'settings')
  const result: Partial<AssistantSettings> = {}
  if (value.agent !== undefined) { if (typeof value.agent !== 'string' || !isAgentKind(value.agent)) invalidCommandField('settings.agent'); result.agent = value.agent }
  for (const key of ['model', 'effort', 'systemPrompt', 'extraArgs'] as const) {
    const text = commandOptionalString(value[key], `settings.${key}`, false)
    if (text !== undefined) result[key] = text
  }
  if (result.extraArgs !== undefined && !parseExtraArgs(result.extraArgs).ok) invalidCommandField('settings.extraArgs')
  return result
}
export function createDialogCommands(host: DialogCommandHost): DialogCommands {
  const execute = createClientCommandExecutor(host)
  const asyncExecute = createAsyncClientCommandExecutor(host)
  const project = (id: string | undefined) => {
    if (id === undefined) return undefined
    const value = host.project(id)
    if (!value) throw new CommandError('command.projectNotFound', { projectId: id })
    return value
  }
  function change(ctx: ClientCommandContext, name: DialogCommandName, rawId: string,
    validate: () => (id: string) => Promise<void>): Promise<void> {
    return asyncExecute(ctx, name, () => {
      const id = commandString(rawId, 'id'); const operation = validate()
      return async (_context, scope) => {
        const before = host.registry.snapshot(id)
        const registration = project(before.dialog.projectId); const root = registration?.root
        const assertCurrent = () => {
          if (registration && (host.project(registration.id) !== registration || registration.root !== root)) throw new CommandError('command.stale', { projectId: registration.id })
          if (!before.readOnly && host.registry.snapshot(id).readOnly) throw new CommandError('command.stale')
        }
        assertCurrent()
        await scope.commit(() => operation(id))
        assertCurrent()
      }
    })
  }
  return {
    create: (ctx, input = {}) => execute(ctx, 'dialogs.create', () => {
      const value = commandObject(input, ['projectId', 'settings'], 'input')
      const projectId = commandOptionalString(value.projectId, 'projectId')
      const overrides = value.settings === undefined ? {} : settingsFrom(value.settings)
      return () => {
        project(projectId)
        const settings = { ...host.settings(), ...overrides }
        if (!isAgentKind(settings.agent) || settings.agent === 'amp' || settings.agent === 'shell') invalidCommandField('settings.agent')
        host.assertUsable(settings.agent)
        return host.registry.create(settings, projectId)
      }
    }),
    list: (ctx, raw) => execute(ctx, 'dialogs.list', () => {
      const projectId = commandOptionalString(raw, 'projectId')
      return () => { project(projectId); return host.registry.list(projectId) }
    }),
    snapshot: (ctx, raw) => execute(ctx, 'dialogs.snapshot', () => { const id = commandString(raw, 'id'); return () => host.registry.snapshot(id) }),
    send: (ctx, id, raw, context) => change(ctx, 'dialogs.send', id, () => {
      const text = conversationText(raw); const workflow = context === undefined ? undefined : conversationText(context, 'workflowContext')
      return id => host.registry.send(id, text, workflow)
    }),
    interrupt: (ctx, id) => change(ctx, 'dialogs.interrupt', id, () => id => host.registry.interrupt(id)),
    respond: (ctx, id, rawRequest, rawAnswer) => change(ctx, 'dialogs.respond', id, () => {
      const request = commandString(rawRequest, 'requestId'); const answer = interactionAnswer(rawAnswer)
      return id => host.registry.respond(id, request, answer)
    }),
    stop: (ctx, raw) => execute(ctx, 'dialogs.stop', () => { const id = commandString(raw, 'id'); return () => host.registry.stop(id) })
  }
}
