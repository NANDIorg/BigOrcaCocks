import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantSettings } from '@orca-board/core'
import type { ConversationSnapshot } from '@orca-board/contracts'
import { AssistantSession, createDialogRepository } from '../src/index.ts'

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-session-history-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'dialogs.json')
  const repository = createDialogRepository(file)
  const history: ConversationSnapshot = { id: 'saved', agent: 'codex', status: 'waiting',
    messages: [{ id: 'm', role: 'human', text: 'Saved text', at: 1 }],
    interactions: [{ id: 'request', kind: 'permission', title: 'Run?' }], providerBinding: { transport: 'codex-app-server', sessionId: 'native-id' } }
  repository.save({ id: 'saved', createdAt: 1, updatedAt: 2, revision: 0, conversation: history }, null)
  let settings: AssistantSettings = { agent: 'claude' }
  let created = 0
  let forbidden = false
  const manager = new AssistantSession({ repository,
    errors: { unknownPty: () => new Error('unknown'), emptyText: () => new Error('empty'), readOnly: () => new Error('history only'), storage: () => new Error('storage failure') },
    settings: () => { if (forbidden) throw new Error('settings unavailable'); return settings },
    assertUsable: () => { if (forbidden) throw new Error('CLI unavailable') },
    create: (_settings, onUpdate) => {
      const id = `new-${created++}`
      const state: ConversationSnapshot = { id, agent: settings.agent, status: 'done', messages: [], interactions: [] }
      return { id, snapshot: () => state, send: async text => { state.messages.push({ id: 'n', role: 'human', text, at: 10 }); onUpdate({ type: 'message', message: state.messages[0] }) }, respond: async () => {}, interrupt: async () => {}, dispose: () => {} }
    }, startTerminal: () => 'pty', isAlive: () => true, killTerminal: () => {}, onUpdate: () => {}
  })
  t.after(() => manager.dispose())
  return { file, repository, manager, created: () => created, forbid: () => { forbidden = true }, settings: (value: AssistantSettings) => { settings = value } }
}

it('Desktop-compatible open восстанавливает global history без settings, discovery и CLI', t => {
  const f = fixture(t)
  f.forbid()
  const bytes = readFileSync(f.file, 'utf8')
  assert.deepEqual(f.manager.open(80, 30, false), { ptyId: 'saved' })
  assert.equal(f.manager.available('saved'), true)
  const snapshot = f.manager.snapshot('saved')
  assert.equal(snapshot.readOnly, true)
  assert.equal(snapshot.requiresNewConversation, true)
  assert.equal(snapshot.transport, 'chat')
  assert.equal(snapshot.protocolVersion, 2)
  assert.equal(snapshot.status, 'interrupted')
  assert.deepEqual(snapshot.interactions, [])
  assert.deepEqual(snapshot.providerBinding, { transport: 'codex-app-server', sessionId: 'native-id' })
  assert.equal(snapshot.messages[0].text, 'Saved text')
  assert.equal(f.created(), 0)
  assert.equal(readFileSync(f.file, 'utf8'), bytes)
  for (const operation of [() => f.manager.send('saved', 'continue'), () => f.manager.interrupt('saved'), () => f.manager.respond('saved', 'request', { kind: 'cancel' })]) assert.throws(operation, /history only/)
})

it('reset после history запускает новый диалог; старый DTO и metadata остаются в repository', async t => {
  const f = fixture(t)
  f.manager.open(80, 30, false)
  assert.deepEqual(f.manager.open(80, 30, true), { ptyId: 'new-0' })
  assert.equal(f.manager.snapshot('new-0').readOnly, undefined)
  assert.throws(() => f.manager.snapshot('saved'), /unknown/)
  await f.manager.send('new-0', 'hello')
  assert.equal(f.repository.get('new-0')!.conversation.messages[0].text, 'hello')
  assert.equal(f.repository.get('saved')!.conversation.messages[0].text, 'Saved text')
})

it('failed history reset сохраняет прежний выбор и байты файла', t => {
  const f = fixture(t)
  f.manager.open(80, 30, false)
  const bytes = readFileSync(f.file, 'utf8')
  mkdirSync(`${f.file}.tmp`)
  assert.throws(() => f.manager.open(80, 30, true), /storage failure/)
  assert.equal(f.manager.snapshot('saved').messages[0].text, 'Saved text')
  assert.deepEqual(f.manager.open(80, 30, false), { ptyId: 'saved' })
  assert.equal(readFileSync(f.file, 'utf8'), bytes)
  rmSync(`${f.file}.tmp`, { recursive: true })
})

it('project history не подменяет global Desktop чат; Amp остаётся терминальным', t => {
  const f = fixture(t)
  f.repository.remove('saved', 0)
  f.repository.save({ id: 'project', projectId: 'p', createdAt: 3, updatedAt: 4, revision: 0,
    conversation: { id: 'project', agent: 'claude', status: 'done', messages: [], interactions: [] } }, null)
  f.settings({ agent: 'amp' })
  assert.deepEqual(f.manager.open(80, 30, false), { ptyId: 'pty' })
  assert.equal(f.manager.snapshot('pty').transport, 'terminal')
  assert.equal(f.created(), 0)
  assert.equal(f.repository.list().length, 1)
})
