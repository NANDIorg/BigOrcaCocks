import { it } from 'node:test'
import assert from 'node:assert/strict'
import { AssistantSession } from './assistant-session'
import { ipcError, OrcaError, setMainLocale } from './i18n'

function fixture() {
  let sent = 0
  const manager = new AssistantSession({
    settings: () => ({ agent: 'claude' }), assertUsable: () => {},
    create: () => ({ id: 'chat', snapshot: () => ({ id: 'chat', agent: 'claude', messages: [], status: 'done', interactions: [] }),
      send: async () => { sent++ }, interrupt: async () => {}, respond: async () => {}, dispose: () => {} }),
    startTerminal: () => { throw new Error('terminal must not start') },
    isAlive: () => false, killTerminal: () => {}, onUpdate: () => {}
  })
  return { manager, sent: () => sent }
}

it('Desktop session сохраняет OrcaError с прежними ключами для socket/IPC', async () => {
  const { manager, sent } = fixture()
  const isUnknown = (error: unknown) => error instanceof OrcaError && error.key === 'assistantChat.unknownPty'
  assert.throws(() => manager.snapshot('missing'), isUnknown)
  assert.throws(() => manager.send('missing', 'hello'), isUnknown)
  assert.throws(() => manager.interrupt('missing'), isUnknown)
  assert.throws(() => manager.respond('missing', 'request', { kind: 'cancel' }), isUnknown)
  manager.open(80, 30, false)
  for (const text of ['', '   ', null, 42]) assert.throws(() => manager.send('chat', text), error => error instanceof OrcaError && error.key === 'assistantChat.emptyText')
  assert.equal(sent(), 0)
  await manager.send('chat', 'hello')
  assert.equal(sent(), 1)
  manager.dispose()
})

it('IPC переводит ошибку сессии на текущий язык, сохраняя код и русский socket message', t => {
  t.after(() => setMainLocale('ru'))
  const { manager } = fixture()
  let unknown: OrcaError | undefined
  try { manager.snapshot('missing') } catch (error) {
    assert.ok(error instanceof OrcaError)
    unknown = error
  }
  assert.ok(unknown)
  assert.equal(unknown.message, "Этот диалог ассистента больше не активен.")
  setMainLocale('en')
  const english = ipcError(unknown)
  assert.ok(english instanceof Error)
  assert.equal(english.name, 'OrcaError[assistantChat.unknownPty]')
  assert.equal(english.message, "This assistant conversation is no longer active.")
  setMainLocale('ru')
  const russian = ipcError(unknown)
  assert.ok(russian instanceof Error)
  assert.equal(russian.name, english.name)
  assert.equal(russian.message, unknown.message)
  manager.dispose()
})
