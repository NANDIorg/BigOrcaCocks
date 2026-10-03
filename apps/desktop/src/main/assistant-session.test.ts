import { it } from 'node:test'
import assert from 'node:assert/strict'
import { AssistantSession } from './assistant-session'
import { ipcError, OrcaError, setMainLocale } from './i18n'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDialogRepository } from '@orca-board/runtime'
import type { DialogRepository } from '@orca-board/runtime'
import type { AssistantChatUpdate, ConversationSnapshot } from '@orca-board/contracts'

function fixture(repository?: DialogRepository, onUpdate: (event: AssistantChatUpdate) => void = () => {}) {
  let sent = 0
  const manager = new AssistantSession({
    repository,
    settings: () => ({ agent: 'claude' }), assertUsable: () => {},
    create: (_settings, update) => {
      const state: ConversationSnapshot = { id: 'chat', agent: 'claude', messages: [], status: 'done', interactions: [] }
      return { id: 'chat', snapshot: () => state,
        send: async text => { sent++; const message = { id: 'm', role: 'human' as const, text, at: 1 }; state.messages.push(message); update({ type: 'message', message }) }, interrupt: async () => {}, respond: async () => {}, dispose: () => {} }
    },
    startTerminal: () => { throw new Error('terminal must not start') },
    isAlive: () => false, killTerminal: () => {}, onUpdate
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

it('storage failure snapshot/event переводятся на текущий язык Desktop, rejection сохраняет OrcaError', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-desktop-write-fault-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }); setMainLocale('ru') })
  const file = join(dir, 'dialogs.json')
  const events: AssistantChatUpdate[] = []
  const { manager } = fixture(createDialogRepository(file), event => events.push(event))
  t.after(() => manager.dispose())
  manager.open(80, 30, false)
  mkdirSync(`${file}.tmp`)
  setMainLocale('en')
  await assert.rejects(manager.send('chat', 'unsaved'), error => error instanceof OrcaError && error.key === 'assistantChat.historyStorage')
  assert.match(manager.snapshot('chat').error!, /^Could not save history\./)
  assert.match(events.at(-1)!.snapshot!.error!, /^Could not save history\./)
  assert.equal(events.at(-1)!.snapshot!.messages[0].text, 'unsaved')
  setMainLocale('ru')
  assert.match(manager.snapshot('chat').error!, /^Не удалось сохранить историю\./)
})

it('Desktop history ошибки имеют локализуемые ключи, CLI не запускается при повреждённом файле', t => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-desktop-history-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }); setMainLocale('ru') })
  const file = join(dir, 'dialogs.json')
  const repository = createDialogRepository(file)
  repository.save({ id: 'old', createdAt: 1, updatedAt: 1, revision: 0,
    conversation: { id: 'old', agent: 'claude', status: 'done', messages: [], interactions: [] } }, null)
  const { manager, sent } = fixture(repository)
  t.after(() => manager.dispose())
  assert.equal(manager.open(80, 30, false).ptyId, 'old')
  assert.throws(() => manager.send('old', 'hello'), error => {
    assert.ok(error instanceof OrcaError)
    assert.equal(error.key, 'assistantChat.historyOnly')
    setMainLocale('en')
    assert.equal((ipcError(error) as Error).message, 'Saved conversations are read-only. Start a new conversation.')
    return true
  })
  assert.equal(sent(), 0)
  manager.dispose()
  writeFileSync(file, 'corrupt')
  assert.throws(() => manager.open(80, 30, false), error => error instanceof OrcaError && error.key === 'assistantChat.historyLoad')
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
