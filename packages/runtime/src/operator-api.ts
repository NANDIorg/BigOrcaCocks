import type { ClientCommandContext, OperatorProduct } from '@orca-board/contracts'
import type { MutationLedger } from './mutation-ledger.ts'
import type { ObserverEvents } from './observer-events.ts'
import { createOperatorSession, type OperatorCommandDescriptor } from './operator-session.ts'
import { protocolText } from './operator-handshake.ts'
import { CommandError } from './project-commands.ts'

export interface OperatorApiOptions {
  groups: Record<string, object>
  product: OperatorProduct
  ownerId: string
  ledger: MutationLedger
  events: ObserverEvents
  preview?: boolean
  getRevision(projectId?: string, dialogId?: string): number
  authorize(context: ClientCommandContext, command: string): boolean
  authorizeProject(context: ClientCommandContext, projectId: string): boolean
  onDetach(context: ClientCommandContext): void
  onDialog?(id: string): void
}
/** Только методы известных application factories; JSON не выбирает произвольные properties host. */
export function createOperatorApi(options: OperatorApiOptions) {
  const reads = new Set(['listProjects', 'detectTaskType', 'inProgressCounts', 'groups', 'settings', 'onboardingState', 'taskTypes', 'taskTypeUsage', 'builtinPrompts', 'nodeTemplates', 'workflowGet', 'workflowValidate', 'workflowContext', 'exportTaskType', 'list', 'snapshot', 'info', 'get', 'read', 'writer', 'project', 'task', 'global', 'branches', 'preflight', 'inspect', 'listWithCounts', 'tasks', 'listDir', 'listDocs', 'readDoc', 'viewDoc', 'docPreview', 'showcasePreview', 'showcaseBase'])
  const projectGroups = new Set(['projectConfig', 'board', 'globalTask', 'coordinator', 'worker', 'review', 'humanRequest', 'projectGit', 'run', 'rules', 'stats', 'files'])
  const descriptors: Record<string, OperatorCommandDescriptor> = {}
  for (const [group, commands] of Object.entries(options.groups)) for (const [method, invoke] of Object.entries(commands)) {
    if (typeof invoke !== 'function') continue
    if (group === 'files' && (/^(open|reveal)/.test(method) || ['docBytes', 'downloadDoc', 'readShowcase'].includes(method)) || group === 'globalTask' && ['image', 'attachment'].includes(method) || group === 'session' && (method === 'write' || method === 'resize')) continue
    if (group === 'files' && !options.preview && ['docPreview', 'showcasePreview', 'showcaseBase'].includes(method)) continue
    const projectScope = projectGroups.has(group) || group === 'agent' && method === 'preflight'
    // Heartbeat меняет только bounded in-memory lease. Повтор проверяет живой token;
    // после release/expiry он не создаёт lease и не расходует durable журнал профиля.
    const leaseHeartbeat = group === 'session' && method === 'renewWriter'
    descriptors[`${group}.${method}`] = { capability: group, mutation: !reads.has(method) && !leaseHeartbeat, scope: projectScope ? 'project' : group === 'dialog' && method !== 'create' && method !== 'list' ? 'dialog' : 'profile',
      invoke: async (context, args, projectId) => {
        const commandContext: ClientCommandContext = projectScope ? Object.assign({}, context, { projectId }) : context
        const result: unknown = await (invoke as (context: ClientCommandContext, ...args: unknown[]) => unknown)(commandContext, ...args)
        if (group === 'dialog' && method === 'create' && typeof result === 'string') options.onDialog?.(result)
        if (group === 'dialog' && method === 'snapshot' && typeof args[0] === 'string') options.onDialog?.(args[0])
        return result
      } }
  }
  descriptors['recovery.pendingRequests'] = { capability: 'recovery', mutation: false, scope: 'profile', invoke: context => {
    if (!options.authorize(context, 'recovery.pendingRequests')) throw new CommandError('command.forbidden')
    return options.ledger.pending().filter(record => record.identity[0] === context.actor.id)
  } }
  descriptors['recovery.abandonRequest'] = { capability: 'recovery', mutation: true, scope: 'profile', invoke: (context, args) => {
    if (!options.authorize(context, 'recovery.abandonRequest')) throw new CommandError('command.forbidden')
    options.ledger.abandon(context.actor.id, protocolText(args[0], 'clientId'), protocolText(args[1], 'requestId')); return null
  } }
  const metadata = { protocolMajor: 1, schemaVersion: 1, runtimeRevision: options.ownerId, product: options.product,
    capabilities: [...Object.keys(options.groups), ...Object.keys(descriptors).map(name => `method:${name}`), 'binary', 'pty.stream'] }
  return { metadata, operator: (context: ClientCommandContext) => createOperatorSession({ context, metadata, commands: descriptors, ledger: options.ledger, events: options.events,
    getRevision: options.getRevision, authorizeProject: options.authorizeProject, onDetach: options.onDetach }) }
}
