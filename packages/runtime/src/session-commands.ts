import type { ClientCommandContext, Project, PtySpawnOptions, SessionCommands, SessionCommandName } from '@orca-board/contracts'
import { CommandError, createClientCommandExecutor, type ClientCommandHost } from './project-commands.ts'
import { commandInputError } from './command-input.ts'
import { commandObject, commandOptionalString, commandString } from './profile-command-input.ts'
import type { createSessionRegistry } from './sessions.ts'
import type { SessionWriterLeases } from './session-writer-leases.ts'

export interface SessionCommandHost extends ClientCommandHost<SessionCommandName> {
  project(id: string): Project | undefined
  sessions: Pick<ReturnType<typeof createSessionRegistry>, 'spawnPty' | 'terminalSnapshots' | 'writePty' | 'resizePty' | 'killPty'>
  leases: SessionWriterLeases
  defaultCwd: string
  env(project?: Project): Record<string, string>
  onExit?(id: string, exitCode: number): void
}
function dimension(raw: unknown, field: string, minimum: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum || raw > 1000) commandInputError(field)
  return raw
}
function spawnOptions(raw: unknown): PtySpawnOptions {
  const value = commandObject(raw, ['cols', 'rows', 'cwd', 'command', 'args', 'env', 'projectId', 'label'], 'options')
  const options: PtySpawnOptions = { cols: dimension(value.cols, 'cols', 2), rows: dimension(value.rows, 'rows', 1) }
  for (const key of ['cwd', 'command', 'projectId', 'label'] as const) {
    const text = commandOptionalString(value[key], key, key !== 'label')
    if (text !== undefined) { if (text.includes('\0') || Buffer.byteLength(text) > 4096) commandInputError(key); options[key] = text }
  }
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.length > 64) commandInputError('args')
    options.args = value.args.map((raw, index) => {
      const arg = commandString(raw, `args[${index}]`, false)
      if (arg.includes('\0') || Buffer.byteLength(arg) > 4096) commandInputError('args')
      return arg
    })
  }
  if (value.env !== undefined) {
    const keys = value.env !== null && typeof value.env === 'object' ? Object.keys(value.env) : []
    if (keys.length > 128) commandInputError('env')
    const env = commandObject(value.env, keys, 'env'); options.env = {}
    for (const [key, raw] of Object.entries(env)) {
      const text = commandString(raw, `env.${key}`, false)
      if (!key.length || key.includes('=') || key.includes('\0') || key.length > 256 || text.includes('\0') || Buffer.byteLength(text) > 4096) commandInputError('env')
      options.env[key] = text
    }
  }
  return options
}
export function createSessionCommands(host: SessionCommandHost): SessionCommands {
  const execute = createClientCommandExecutor(host)
  function session<T>(ctx: ClientCommandContext, name: SessionCommandName, ptyId: string,
    validate: () => (id: string, ctx: ClientCommandContext) => T): T {
    return execute(ctx, name, () => { const id = commandString(ptyId, 'ptyId'); const operation = validate(); return context => operation(id, context) })
  }
  const token = (raw: unknown) => commandString(raw, 'leaseId')
  return {
    spawn: (context, raw) => execute(context, 'sessions.spawn', () => {
      const { projectId, label, ...options } = spawnOptions(raw)
      return () => {
        const project = projectId === undefined ? undefined : host.project(projectId)
        if (projectId !== undefined && !project) throw new CommandError('command.projectNotFound', { projectId })
        host.leases.prune()
        return host.sessions.spawnPty({ ...options, cwd: options.cwd ?? project?.root ?? host.defaultCwd,
          env: { ...host.env(project), ...options.env }, meta: { role: 'shell', label: label ?? 'терминал', ...(project ? { projectId: project.id } : {}) } }, host.onExit)
      }
    }),
    list: context => execute(context, 'sessions.list', () => () => { host.leases.prune(); return host.sessions.terminalSnapshots() }),
    writer: (context, id) => session(context, 'sessions.writer', id, () => id => host.leases.current(id)),
    claimWriter: (context, id) => session(context, 'sessions.claimWriter', id, () => (id, ctx) => host.leases.claim(id, ctx.clientId)),
    renewWriter: (context, id, leaseId) => session(context, 'sessions.renewWriter', id, () => { const lease = token(leaseId); return (id, ctx) => host.leases.renew(id, ctx.clientId, lease) }),
    releaseWriter: (context, id, leaseId) => session(context, 'sessions.releaseWriter', id, () => { const lease = token(leaseId); return (id, ctx) => host.leases.release(id, ctx.clientId, lease) }),
    write: (context, id, raw, leaseId) => session(context, 'sessions.write', id, () => {
      const data = commandString(raw, 'data', false); const lease = token(leaseId)
      if (Buffer.byteLength(data) > 64 * 1024) commandInputError('data')
      return (id, ctx) => { host.leases.require(id, ctx.clientId, lease); host.sessions.writePty(id, data) }
    }),
    resize: (context, id, cols, rows, leaseId) => session(context, 'sessions.resize', id, () => {
      const width = dimension(cols, 'cols', 2); const height = dimension(rows, 'rows', 1); const lease = token(leaseId)
      return (id, ctx) => { host.leases.require(id, ctx.clientId, lease); host.sessions.resizePty(id, width, height) }
    }),
    kill: (context, id) => session(context, 'sessions.kill', id, () => id => { host.leases.dropSession(id); host.sessions.killPty(id) })
  }
}
