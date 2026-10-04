import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationUpdate, ClientCommandContext } from '@orca-board/contracts'
import type { AssistantSettings } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import { profileFixture, operator } from './profile-command-test-host.ts'
import { fixture as providerFixture, services, until } from './conversation-fixture.ts'

const code = (value: string) => (e: unknown) => e instanceof runtime.CommandError && e.code === value
const two: ClientCommandContext = { clientId: 'two', actor: { kind: 'operator', id: 'second' } }
function fixture(t: { after(fn: () => void): void }, mode = 'claude') {
  assert.equal(typeof runtime.createDialogCommands, 'function')
  assert.equal(typeof runtime.createAssistantCommands, 'function')
  const f = profileFixture()
  const file = join(f.dir, 'dialogs.json'); const repository = runtime.createDialogRepository(file)
  const providers: ReturnType<typeof providerFixture>[] = []
  const create = (settings: AssistantSettings, onUpdate: (update: ConversationUpdate) => void, projectId?: string) => {
    const port = providerFixture(t, settings.agent === 'codex' ? mode : 'claude', settings.agent, {}, options => services().create({
      ...options, projectId,
      onUpdate: update => { options.onUpdate(update); onUpdate(update) }
    }))
    providers.push(port); return port.engine
  }
  const registry = new runtime.DialogRegistry({ repository, create, errors: { unknown: () => new Error('unknown-dialog'),
    emptyText: () => new Error('empty-text'), readOnly: () => new Error('read-only'), storage: error => error instanceof Error ? error : new Error('storage') } })
  t.after(() => { registry.dispose(); f.close() })
  let lookups = 0; let allow = true
  const authorize = (context: ClientCommandContext) => allow && context.actor.kind === 'operator'
  const commands = runtime.createDialogCommands({ registry, authorize, project: id => { lookups++; return f.manager.get(id) },
    settings: () => ({ agent: 'claude' }), assertUsable: () => {} })
  return { ...f, file, registry, repository, commands, providers, create, authorize, lookups: () => lookups, deny: () => { allow = false } }
}

test('dialog context/options/text guards precede project lookup and actual CLI startup', t => {
  const f = fixture(t)
  assert.throws(() => f.commands.create({ ...operator, actor: { kind: 'agent', id: 'forged' } }), code('command.forbidden'))
  assert.throws(() => f.commands.create(operator, { projectId: '' }), code('command.invalidInput'))
  assert.throws(() => f.commands.create(operator, { settings: { agent: 'unknown' } } as unknown as { settings: AssistantSettings }), code('command.invalidInput'))
  assert.throws(() => f.commands.create(operator, { settings: { agent: 'claude', extraArgs: 'unsafe positional' } }), code('command.invalidInput'))
  assert.equal(f.lookups(), 0); assert.equal(f.providers.length, 0)
})
test('two dialogs retain actual CLI project env, transcript and provider binding independently', async t => {
  const f = fixture(t)
  const a = f.commands.create(operator, { projectId: f.a.id }); const b = f.commands.create(two, { projectId: f.b.id })
  await f.commands.send(operator, a, 'one'); await until(() => f.registry.snapshot(a).dialog.conversation.status === 'done')
  await f.commands.send(two, b, 'two'); await until(() => f.registry.snapshot(b).dialog.conversation.status === 'done')
  for (const [index, id] of [f.a.id, f.b.id].entries()) {
    const spawn = f.providers[index].wire().find(value => value.fixtureSpawn)?.fixtureSpawn as { env: Record<string, string> }
    assert.equal(spawn.env.ORCA_PROJECT, id)
  }
  assert.equal(f.commands.snapshot(operator, a).dialog.conversation.messages.find(m => m.role === 'human')?.text, 'one')
  assert.equal(f.commands.snapshot(two, b).dialog.conversation.messages.find(m => m.role === 'human')?.text, 'two')
  assert.deepEqual(f.commands.list(operator, f.a.id).map(d => d.id), [a]); assert.deepEqual(f.commands.list(two, f.b.id).map(d => d.id), [b])
  const dto = f.commands.snapshot(operator, a); dto.dialog.projectId = 'forged'
  assert.equal(f.repository.get(a)?.projectId, f.a.id); assert.equal(f.repository.get(a)?.conversation.providerBinding?.transport, 'claude-stream-json')
  assert.equal(f.manager.active()?.id, f.a.id)
})
test('unknown project never starts CLI; unknown dialog remains a domain cause', async t => {
  const f = fixture(t)
  assert.throws(() => f.commands.create(operator, { projectId: 'foreign' }), code('command.projectNotFound'))
  assert.throws(() => f.commands.list(operator, 'foreign'), code('command.projectNotFound'))
  assert.equal(f.providers.length, 0)
  await assert.rejects(f.commands.send(operator, 'missing', 'hello'), error => error instanceof runtime.CommandError && error.cause instanceof Error && error.cause.message === 'unknown-dialog')
})
test('malformed answers leave real permission pending; accepted answer cannot be applied twice', async t => {
  const f = fixture(t); const id = f.commands.create(operator)
  await f.commands.send(operator, id, 'permission'); await until(() => f.registry.snapshot(id).dialog.conversation.status === 'waiting')
  const request = f.commands.snapshot(operator, id).dialog.conversation.interactions[0]
  const before = readFileSync(f.file, 'utf8')
  await assert.rejects(f.commands.respond(operator, id, request.id, { kind: 'answers', answers: [{ questionId: '', optionIds: [7] }] } as unknown as { kind: 'cancel' }), code('command.invalidInput'))
  assert.equal(readFileSync(f.file, 'utf8'), before)
  const option = request.options!.find(value => value.kind === 'allow_once')!
  await f.commands.respond(operator, id, request.id, { kind: 'option', optionId: option.id })
  await until(() => f.registry.snapshot(id).dialog.conversation.status === 'done')
  const responses = f.providers[0].wire().filter(value => value.type === 'control_response')
  assert.equal(responses.length, 1)
  const response = responses[0].response as { response: { behavior: string } }; assert.equal(response.response.behavior, 'allow')
  await assert.rejects(f.commands.respond(two, id, request.id, { kind: 'option', optionId: option.id }), code('command.rejected'))
  assert.equal(f.providers[0].wire().filter(value => value.type === 'control_response').length, 1)
})
test('stop/history snapshot cannot replay previous permission or execute stored tool calls', async t => {
  const f = fixture(t); const id = f.commands.create(operator)
  await f.commands.send(operator, id, 'permission'); await until(() => f.registry.snapshot(id).dialog.conversation.status === 'waiting')
  f.commands.stop(operator, id)
  const restored = new runtime.DialogRegistry({ repository: f.repository, create: f.create,
    errors: { unknown: () => new Error('unknown'), emptyText: () => new Error('empty'), readOnly: () => new Error('read-only'), storage: () => new Error('storage') } })
  const commands = runtime.createDialogCommands({ registry: restored, authorize: f.authorize, project: id => f.manager.get(id), settings: () => ({ agent: 'claude' }), assertUsable: () => {} })
  const history = commands.snapshot(operator, id)
  assert.equal(history.readOnly, true); assert.equal(history.requiresNewConversation, true); assert.deepEqual(history.dialog.conversation.interactions, [])
  await assert.rejects(commands.send(operator, id, 'replay'), error => error instanceof runtime.CommandError && error.cause instanceof Error && error.cause.message === 'read-only')
  assert.equal(f.providers.length, 1); restored.dispose()
})
test('revoked client during actual ACK wait rejects result without touching another dialog', async t => {
  const f = fixture(t, 'codex-hold-ack'); const a = f.commands.create(operator, { projectId: f.a.id, settings: { agent: 'codex' } })
  const b = f.commands.create(two, { projectId: f.b.id })
  await until(() => f.registry.snapshot(b).dialog.conversation.status === 'done')
  const before = f.repository.get(b)
  const pending = f.commands.send(operator, a, 'hello', 'hidden-context')
  await until(() => f.providers[0].wire().some(value => value.method === 'turn/start'))
  f.deny(); f.providers[0].release()
  await assert.rejects(pending, code('command.forbidden'))
  assert.deepEqual(f.repository.get(b), before)
})
test('legacy AssistantCommands preserve native terminal fallback and selected identity', async t => {
  const f = fixture(t); const sessions = runtime.createSessionRegistry({ spawn: () => ({ onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} }) })
  let settings: AssistantSettings = { agent: 'shell' }
  const session = new runtime.AssistantSession({ settings: () => settings, assertUsable: () => {}, create: f.create,
    errors: { unknownPty: () => new Error('unknown-pty'), emptyText: () => new Error('empty-text') },
    startTerminal: (_settings, cols, rows) => sessions.spawnPty({ cols, rows, meta: { role: 'assistant', label: 'assistant' } }),
    isAlive: sessions.isAlive, killTerminal: sessions.killPty, onUpdate: () => {} })
  t.after(() => { session.dispose(); sessions.killAll() })
  const commands = runtime.createAssistantCommands({ session, authorize: f.authorize, buildWorkflowContext: () => 'context' })
  const terminal = commands.open(operator, 80, 24); assert.equal(commands.snapshot(operator, terminal.ptyId).transport, 'terminal')
  settings = { agent: 'claude' }; const chat = commands.reset(operator, 80, 24)
  assert.equal(commands.available(operator, chat.ptyId), true); assert.equal(sessions.isAlive(terminal.ptyId), false)
  await commands.send(operator, chat.ptyId, 'hello'); await until(() => commands.snapshot(operator, chat.ptyId).status === 'done')
  assert.equal(commands.snapshot(operator, chat.ptyId).messages.find(m => m.role === 'human')?.text, 'hello')
  await assert.rejects(commands.send(operator, terminal.ptyId, 'late'), error => error instanceof runtime.CommandError && error.cause instanceof Error && error.cause.message === 'unknown-pty')
})

test('removed project registration during actual ACK wait makes result stale', async t => {
  const f = fixture(t, 'codex-hold-ack')
  const id = f.commands.create(operator, { projectId: f.a.id, settings: { agent: 'codex' } })
  const pending = f.commands.send(operator, id, 'hello', 'hidden-context')
  await until(() => f.providers[0].wire().some(value => value.method === 'turn/start'))
  f.manager.remove(f.a.id); f.providers[0].release()
  await assert.rejects(pending, code('command.stale'))
  assert.equal(f.repository.get(id)?.projectId, f.a.id)
})
