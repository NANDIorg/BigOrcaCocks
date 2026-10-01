import { it } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantSettings } from '@orca-board/core'
import type { AssistantConversation, ConversationUpdate } from '../shared/assistant-conversation'
import { AssistantSession } from './assistant-session'
function fixture() {
  let settings: AssistantSettings = { agent: 'claude' }
  const children: { disposed: boolean; emit(update: ConversationUpdate): void; sent: { text: string; context?: string }[] }[] = []
  const events: unknown[] = []
  let exit: ((id: string) => void) | undefined
  let killed = ''
  const manager = new AssistantSession({ settings: () => settings, assertUsable: (agent) => { if (agent === 'gemini') throw new Error('missing CLI') }, create: (input, onUpdate) => {
    const id = `s${children.length}`
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
