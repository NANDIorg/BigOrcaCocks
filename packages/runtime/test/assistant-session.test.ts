import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantSettings } from '@orca-board/core'
import type { ConversationUpdate } from '@orca-board/contracts'
import type { AssistantConversation, AssistantSessionDependencies } from '../src/index.ts'
import * as runtime from '../src/index.ts'
import { fixture as providerFixture, services, until } from './conversation-fixture.ts'
function fixture(prefix = 's', errors: AssistantSessionDependencies['errors'] = { unknownPty: () => Object.assign(new Error('unknown conversation'), { key: 'assistantChat.unknownPty' }), emptyText: () => new Error('empty text') }) {
  assert.equal(typeof runtime.AssistantSession, 'function')
  let settings: AssistantSettings = { agent: 'claude' }
  const children: { disposed: boolean; emit(update: ConversationUpdate): void; sent: { text: string; context?: string }[] }[] = []
  const events: unknown[] = []
  let exit: ((id: string) => void) | undefined
  let killed = ''
  const manager = new runtime.AssistantSession({ errors, settings: () => settings, assertUsable: (agent) => { if (agent === 'gemini') throw new Error('missing CLI') }, create: (input, onUpdate) => {
    const id = `${prefix}${children.length}`
    const child = { disposed: false, emit: onUpdate, sent: [] as { text: string; context?: string }[] }; children.push(child)
    return { id, snapshot: () => ({ id, agent: input.agent, messages: [], status: 'done', interactions: [] }), send: async (text, context) => { child.sent.push({ text, context }) }, interrupt: async () => {}, respond: async () => {}, dispose: () => { child.disposed = true } } satisfies AssistantConversation
  }, startTerminal: (_settings, _cols, _rows, onExit) => { exit = onExit; return 'pty1' }, isAlive: () => true, killTerminal: (id) => { killed = id }, onUpdate: (event) => events.push(event) })
  return { manager, children, events, setSettings: (value: AssistantSettings) => { settings = value }, killed: () => killed, exit: () => exit?.('pty1') }
}
it('повторное открытие возвращает тот же диалог', () => {
  const f = fixture(); assert.deepEqual(f.manager.open(80, 30, false), { ptyId: 's0' }); assert.deepEqual(f.manager.open(100, 40, false), { ptyId: 's0' }); assert.equal(f.children.length, 1); f.manager.dispose()
})
it('reset закрывает старый диалог и отбрасывает его поздние события', () => {
  const f = fixture(); f.manager.open(80, 30, false); f.children[0].emit({ type: 'state', status: 'thinking' }); assert.equal(f.manager.snapshot('s0').revision, 1)
  f.manager.open(80, 30, true); assert.equal(f.children[0].disposed, true); f.children[0].emit({ type: 'state', status: 'error' }); assert.equal(f.events.length, 1); assert.equal(f.manager.snapshot('s1').revision, 0); assert.throws(() => f.manager.snapshot('s0')); f.manager.dispose()
})
it('отсутствующий новый агент не уничтожает живой диалог', () => {
  const f = fixture(); f.manager.open(80, 30, false); f.setSettings({ agent: 'gemini' }); assert.throws(() => f.manager.open(80, 30, true), /missing CLI/); assert.equal(f.children[0].disposed, false); assert.equal(f.manager.snapshot('s0').agent, 'claude'); f.manager.dispose()
})
it('Amp использует терминал; завершённый PTY исчезает, dispose закрывает собственный PTY', () => {
  const f = fixture(); f.setSettings({ agent: 'amp' }); f.manager.open(80, 30, false); assert.equal(f.children.length, 0); assert.equal(f.manager.snapshot('pty1').transport, 'terminal'); f.exit(); assert.throws(() => f.manager.snapshot('pty1')); f.manager.open(80, 30, false); f.manager.dispose(); assert.equal(f.killed(), 'pty1')
})

it('session передаёт скрытый контекст без замены текста и не отправляет в старый диалог', async () => {
  const f = fixture()
  f.manager.open(80, 30, false)
  await f.manager.send('s0', 'Текст человека', 'Скрытая база')
  assert.deepEqual(f.children[0].sent, [{ text: 'Текст человека', context: 'Скрытая база' }])
  f.manager.open(80, 30, true)
  assert.throws(() => f.manager.send('s0', 'Повтор', 'База'), { key: 'assistantChat.unknownPty' })
  await f.manager.send('s1', 'Обычный текст')
  assert.deepEqual(f.children[1].sent, [{ text: 'Обычный текст', context: undefined }])
  f.manager.dispose()
})

it('два экземпляра сессии не смешивают события, revisions и reset', () => {
  const a = fixture('left')
  const b = fixture('right')
  a.manager.open(80, 30, false)
  b.manager.open(80, 30, false)
  a.children[0].emit({ type: 'state', status: 'thinking' })
  assert.equal(a.manager.snapshot('left0').revision, 1)
  assert.equal(b.manager.snapshot('right0').revision, 0)
  assert.equal(b.events.length, 0)
  a.manager.open(80, 30, true)
  a.children[0].emit({ type: 'state', status: 'error' })
  assert.equal(a.events.length, 1)
  assert.equal(b.children[0].disposed, false)
  assert.throws(() => a.manager.snapshot('right0'))
  a.manager.dispose()
  b.manager.dispose()
})

it('shared session возвращает ошибки host и не принимает пустой send', () => {
  const unknown = new Error('host A: unknown conversation')
  const empty = new Error('host A: empty text')
  const f = fixture('s', { unknownPty: () => unknown, emptyText: () => empty })
  assert.throws(() => f.manager.snapshot('missing'), error => error === unknown)
  f.manager.open(80, 30, false)
  for (const text of ['', '   ', null, 42]) assert.throws(() => f.manager.send('s0', text), error => error === empty)
  assert.deepEqual(f.children[0].sent, [])
  f.manager.dispose()
})

it('shared session проводит реальный provider permission и сохраняет v2 snapshot/revision', async t => {
  assert.equal(typeof runtime.AssistantSession, 'function')
  const factory = services()
  const events: { ptyId: string; revision?: number }[] = []
  const manager = new runtime.AssistantSession({
    errors: { unknownPty: () => new Error('unknown'), emptyText: () => new Error('empty') },
    settings: () => ({ agent: 'claude' }), assertUsable: () => {},
    create: (_settings, onUpdate) => providerFixture(t, 'claude', 'claude', {}, options => factory.create({ ...options, onUpdate })).engine,
    startTerminal: () => { throw new Error('terminal must not start') },
    isAlive: () => false, killTerminal: () => {}, onUpdate: event => events.push(event)
  })
  t.after(() => manager.dispose())
  const { ptyId } = manager.open(80, 30, false)
  await manager.send(ptyId, 'permission')
  await until(() => manager.snapshot(ptyId).status === 'waiting')
  const snapshot = manager.snapshot(ptyId)
  assert.equal(snapshot.protocolVersion, 2)
  assert.equal(snapshot.transport, 'chat')
  assert.equal(snapshot.agent, 'claude')
  assert.ok(snapshot.revision! > 0)
  assert.ok(events.every(event => event.ptyId === ptyId))
  await manager.respond(ptyId, snapshot.interactions![0].id, { kind: 'option', optionId: 'deny' })
  await until(() => manager.snapshot(ptyId).status === 'done')
  assert.equal(manager.snapshot(ptyId).messages.at(-1)!.text, 'deny')
  manager.dispose()
  assert.throws(() => manager.snapshot(ptyId), /unknown/)
})
