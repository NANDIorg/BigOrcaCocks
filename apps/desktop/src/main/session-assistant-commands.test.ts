import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { AssistantSettings } from '@orca-board/core'
import type { ClientCommandContext, ConversationUpdate } from '@orca-board/contracts'
import { createAssistantCommands, createSessionCommands, createSessionRegistry, createSessionWriterLeases } from '@orca-board/runtime'
import { fixture as providerFixture, services, until } from '../../../../packages/runtime/test/conversation-fixture.ts'
import { AssistantSession } from './assistant-session'
import { ProjectManager } from './projects'
import { buildWorkflowAssistantContext } from './assistant-workflow'
import { ipcError, OrcaError, setMainLocale } from './i18n'

// RED отсутствующего модуля остаётся проверкой поведения с тем же fixture после реализации.
const adapter = await import('./session-assistant-commands').catch(error => {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error
  return {} as typeof import('./session-assistant-commands')
})
type Event = { client: string | null }
const channels = ['pty:spawn', 'terminals:list', 'assistant:open', 'assistant:reset', 'assistantChat:available',
  'assistantChat:getMessages', 'assistantChat:send', 'assistantChat:sendWithWorkflow', 'assistantChat:interrupt', 'assistantChat:respond']
const events = ['pty:write', 'pty:resize', 'pty:kill']
function fixture(t: { after(fn: () => void): void }) {
  assert.equal(typeof adapter.registerDesktopSessionAssistantCommands, 'function')
  const dir = mkdtempSync(join(tmpdir(), 'orca-desktop-session-api-'))
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' })
  const manager = new ProjectManager(join(dir, 'profile'))
  let selected: string | undefined; let selections = 0; let lookups = 0; let clock = 100
  let settings: AssistantSettings = { agent: 'shell' }
  const providers: ReturnType<typeof providerFixture>[] = []
  const registry = createSessionRegistry({ spawn: (_command, _args, options) => {
    launches.push(options); let output: (data: string) => void = () => {}; let exited: (event: { exitCode: number }) => void = () => {}
    return { onData: fn => { output = fn }, onExit: fn => { exited = fn }, write: data => output(data), resize: () => {}, kill: () => exited({ exitCode: 0 }) }
  } })
  const launches: { cwd?: string; env: Record<string, string>; cols: number; rows: number }[] = []
  const leases = createSessionWriterLeases({ isAlive: registry.isAlive, now: () => clock, ttlMs: 100,
    unknownSession: () => new OrcaError('assistantChat.unknownPty') })
  const authorize = (ctx: ClientCommandContext) => ctx.clientId === 'desktop:1' && ctx.actor.kind === 'operator'
  const session = new AssistantSession({ settings: () => settings, assertUsable: () => {},
    create: (settings, onUpdate: (update: ConversationUpdate) => void) => {
      const port = providerFixture(t, 'claude', settings.agent, {}, options => services().create({ ...options,
        onUpdate: update => { options.onUpdate(update); onUpdate(update) } }))
      providers.push(port); return port.engine
    }, startTerminal: (_settings, cols, rows) => registry.spawnPty({ cols, rows, meta: { role: 'assistant', label: 'assistant' } }),
    isAlive: registry.isAlive, killTerminal: registry.killPty, onUpdate: () => {} })
  t.after(() => { session.dispose(); registry.killAll(); rmSync(dir, { recursive: true, force: true }); setMainLocale('ru') })
  const sessions = createSessionCommands({ authorize, sessions: registry, leases, project: id => { lookups++; return manager.get(id) },
    defaultCwd: dir, env: p => ({ ORCA_SOCKET: 'test-socket', ...(p ? { ORCA_PROJECT: p.id } : {}), PATH: process.env.PATH ?? '' }) })
  const assistant = createAssistantCommands({ authorize, session, buildWorkflowContext: raw => buildWorkflowAssistantContext(manager, raw) })
  const handlers = new Map<string, (e: Event, ...args: unknown[]) => unknown>()
  const listeners = new Map<string, (e: Event, ...args: unknown[]) => unknown>()
  const errors: { error: unknown; channel: string }[] = []
  adapter.registerDesktopSessionAssistantCommands<Event>((name, fn) => handlers.set(name, fn as (e: Event, ...args: unknown[]) => unknown),
    (name, fn) => listeners.set(name, fn as (e: Event, ...args: unknown[]) => unknown), {
      sessions, assistant, activeProjectId: () => { selections++; return selected }, clientId: e => e.client,
      onEventError: (error, channel) => errors.push({ error, channel })
    })
  assert.deepEqual([...handlers.keys()].sort(), [...channels].sort()); assert.deepEqual([...listeners.keys()].sort(), events.sort())
  return { dir, manager, session, sessions, registry, leases, launches, errors, providers,
    choose: (id?: string) => { selected = id }, settings: (value: AssistantSettings) => { settings = value },
    advance: () => { clock += 101 }, selections: () => selections, lookups: () => lookups,
    call: (name: string, ...args: unknown[]) => handlers.get(name)!({ client: 'desktop:1' }, ...args),
    foreign: (name: string) => handlers.get(name)!({ client: null }),
    event: (name: string, ...args: unknown[]) => listeners.get(name)!({ client: 'desktop:1' }, ...args),
    foreignEvent: (name: string) => listeners.get(name)!({ client: null }) }
}
test('verified session and assistant callers precede selection, lookup and native/CLI start', async t => {
  const f = fixture(t)
  for (const name of channels) await assert.rejects(async () => f.foreign(name), e => e instanceof OrcaError && e.key === 'command.forbidden')
  for (const name of events) assert.doesNotThrow(() => f.foreignEvent(name))
  assert.equal(f.errors.length, 3); assert.ok(f.errors.every(row => row.error instanceof OrcaError && row.error.key === 'command.forbidden'))
  assert.equal(f.selections(), 0); assert.equal(f.lookups(), 0); assert.equal(f.launches.length, 0); assert.equal(f.providers.length, 0)
})
test('legacy global/selected/explicit shell arguments preserve root, env and metadata', async t => {
  const f = fixture(t)
  const global = f.call('pty:spawn', { cols: 80, rows: 24 }) as string
  assert.equal(f.launches[0].cwd, f.dir); assert.equal(f.launches[0].env.ORCA_SOCKET, 'test-socket'); assert.equal(f.launches[0].env.ORCA_PROJECT, undefined)
  const a = (await f.manager.add(f.dir)); f.choose(a.id)
  const project = f.call('pty:spawn', { cols: 100, rows: 30, label: 'terminal', env: { CUSTOM: 'user' } }) as string
  assert.equal(f.launches[1].cwd, a.root); assert.equal(f.launches[1].env.ORCA_PROJECT, a.id); assert.equal(f.launches[1].env.CUSTOM, 'user')
  f.choose(); const explicit = f.call('pty:spawn', { cols: 70, rows: 20, projectId: a.id, cwd: f.dir }) as string
  const snapshots = f.call('terminals:list') as { ptyId: string; projectId?: string; label: string }[]
  assert.equal(snapshots.find(row => row.ptyId === global)?.projectId, undefined)
  assert.equal(snapshots.find(row => row.ptyId === project)?.label, 'terminal'); assert.equal(snapshots.find(row => row.ptyId === explicit)?.projectId, a.id)
  assert.throws(() => f.call('pty:spawn', { cols: 80, rows: 24, projectId: 'missing' }), e => e instanceof OrcaError && e.key === 'command.projectNotFound')
  assert.equal(f.launches.length, 3)
})
test('legacy PTY events claim/renew writer; conflict and unknown session are reported without throwing', t => {
  const f = fixture(t); const id = f.call('pty:spawn', { cols: 80, rows: 24 }) as string
  f.event('pty:write', id, 'first'); const lease = f.leases.current(id)!
  assert.equal(lease.clientId, 'desktop:1'); assert.equal(f.registry.ptyTail(id), 'first')
  f.advance(); f.event('pty:write', id, 'again'); assert.equal(f.registry.ptyTail(id), 'firstagain')
  assert.notEqual(f.leases.current(id)?.id, lease.id)
  f.leases.dropClient('desktop:1'); assert.equal(f.registry.isAlive(id), true); assert.equal(f.registry.ptyTail(id), 'firstagain')
  f.leases.claim(id, 'other'); assert.doesNotThrow(() => f.event('pty:write', id, 'blocked'))
  assert.doesNotThrow(() => f.event('pty:resize', id, 90, 20)); assert.equal(f.registry.ptyTail(id), 'firstagain')
  assert.equal((f.errors[0].error as OrcaError).key, 'command.conflict'); assert.equal((f.errors[1].error as OrcaError).key, 'command.conflict')
  assert.doesNotThrow(() => f.event('pty:write', 'missing', 'x')); assert.equal(f.errors[2].channel, 'pty:write')
  f.event('pty:kill', id); assert.equal(f.registry.isAlive(id), false)
})
test('invalid legacy input/resize never acquires writer or changes native session', t => {
  const f = fixture(t); const id = f.call('pty:spawn', { cols: 80, rows: 24 }) as string
  f.event('pty:write', id, 'x'.repeat(64 * 1024 + 1)); f.event('pty:resize', id, 0, 0)
  assert.equal(f.errors.length, 2); assert.equal(f.leases.current(id), null); assert.equal(f.registry.ptyTail(id), '')
})
test('legacy terminal reset/chat/workflow/permission use real providers and keep Promise locale errors', async t => {
  const f = fixture(t); const terminal = f.call('assistant:open', 80, 24) as { ptyId: string }
  assert.equal((f.call('assistantChat:getMessages', terminal.ptyId) as { transport: string }).transport, 'terminal')
  f.settings({ agent: 'claude' }); const chat = f.call('assistant:reset', 80, 24) as { ptyId: string }
  assert.equal(f.registry.isAlive(terminal.ptyId), false); assert.equal(f.call('assistantChat:available', chat.ptyId), true)
  await f.call('assistantChat:sendWithWorkflow', chat.ptyId, 'hello', { mode: 'create' })
  await until(() => f.session.snapshot(chat.ptyId).status === 'done')
  assert.equal(f.session.snapshot(chat.ptyId).messages.find(m => m.role === 'human')?.text, 'hello')
  await f.call('assistantChat:send', chat.ptyId, 'permission'); await until(() => f.session.snapshot(chat.ptyId).status === 'waiting')
  const request = f.session.snapshot(chat.ptyId).interactions?.[0]; assert.ok(request)
  await f.call('assistantChat:respond', chat.ptyId, request.id, { kind: 'option', optionId: request.options!.find(o => o.kind === 'allow_once')!.id })
  await until(() => f.session.snapshot(chat.ptyId).status === 'done')
  for (const locale of ['ru', 'en'] as const) {
    setMainLocale(locale)
    await assert.rejects(async () => f.call('assistantChat:send', 'missing', 'late'), e => {
      assert.ok(e instanceof OrcaError); assert.equal(e.key, 'assistantChat.unknownPty')
      const translated = ipcError(e); assert.ok(translated instanceof Error)
      assert.match(translated.message, locale === 'ru' ? /диалог/ : /conversation/i); return true
    })
  }
})
