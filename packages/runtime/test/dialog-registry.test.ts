import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantSettings } from '@orca-board/core'
import type { ConversationSnapshot, ConversationUpdate } from '@orca-board/contracts'
import type { AssistantConversation, DialogRegistryDependencies } from '../src/index.ts'
import { DialogRegistry, createDialogRepository } from '../src/index.ts'
import { fixture as providerFixture, services, until } from './conversation-fixture.ts'

function fixture(t: { after(fn: () => void): void }, create?: DialogRegistryDependencies['create']) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-dialog-registry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'dialogs.json')
  const repository = createDialogRepository(file)
  const children: { disposed: boolean; update(update: ConversationUpdate): void; state: ConversationSnapshot }[] = []
  const reported: Error[] = []
  const registry = new DialogRegistry({ repository, errors: {
    unknown: () => new Error('unknown dialog'), readOnly: () => new Error('history only'),
    emptyText: () => new Error('empty text'), storage: () => new Error('history storage failed')
  }, onError: error => reported.push(error), create: create ?? ((settings, onUpdate) => {
    const id = `d${children.length}`
    const state: ConversationSnapshot = { id, agent: settings.agent, status: 'done', messages: [], interactions: [] }
    const child = { disposed: false, state, update(update: ConversationUpdate) {
      if (update.type === 'state') { state.status = update.status; state.error = update.error }
      else if (update.type === 'message') state.messages.push(update.message)
      else if (update.type === 'interaction') state.interactions.push(update.interaction)
      onUpdate(update)
    } }
    children.push(child)
    return { id, snapshot: () => structuredClone(state), send: async (text, context) => child.update({ type: 'message', message: { id: `${id}-m`, role: 'human', text: context ? `${text}:${context}` : text, at: 12 } }), interrupt: async () => child.update({ type: 'state', status: 'interrupted' }), respond: async () => {}, dispose: () => { child.disposed = true } } satisfies AssistantConversation
  }) })
  t.after(() => registry.dispose())
  return { dir, file, repository, children, registry, reported }
}

it('реестр сохраняет событие до публикации; snapshot и observer copies не меняют данные', async t => {
  const f = fixture(t)
  const id = f.registry.create({ agent: 'claude' })
  const seen: number[] = []
  f.registry.subscribe(id, event => {
    seen.push(f.repository.get(id)!.revision)
    if (event.update.type === 'message') event.update.message.text = 'observer mutation'
  })
  await f.registry.send(id, 'hello', 'hidden')
  assert.deepEqual(seen, [1])
  assert.equal(f.repository.get(id)!.conversation.messages[0].text, 'hello:hidden')
  const snapshot = f.registry.snapshot(id)
  snapshot.dialog.conversation.messages[0].text = 'snapshot mutation'
  assert.equal(f.registry.snapshot(id).dialog.conversation.messages[0].text, 'hello:hidden')
})

it('detach наблюдателя не завершает driver; stop закрывает только выбранный диалог', async t => {
  const f = fixture(t)
  const a = f.registry.create({ agent: 'claude' }, 'project-a')
  const b = f.registry.create({ agent: 'codex' }, 'project-b')
  let seen = 0
  const detach = f.registry.subscribe(a, () => { seen++ })
  detach()
  await f.registry.send(a, 'a')
  assert.equal(seen, 0)
  assert.equal(f.children[0].disposed, false)
  f.registry.stop(a)
  const before = readFileSync(f.file, 'utf8')
  f.children[0].update({ type: 'state', status: 'error' })
  assert.equal(readFileSync(f.file, 'utf8'), before)
  assert.equal(f.children[0].disposed, true)
  assert.equal(f.children[1].disposed, false)
  await f.registry.send(b, 'b')
  assert.equal(f.repository.get(b)!.conversation.messages[0].text, 'b')
  assert.equal(f.registry.snapshot(a).readOnly, true)
})

it('reload только читает history: незавершённый turn нормализован без create и записи', t => {
  const f = fixture(t)
  const id = f.registry.create({ agent: 'claude' })
  f.children[0].update({ type: 'state', status: 'waiting' })
  f.children[0].update({ type: 'interaction', interaction: { id: 'permission', kind: 'permission', title: 'Run?' } })
  f.children[0].update({ type: 'message', message: { id: 'tool', role: 'tool', text: '', at: 12, toolCalls: [{ name: 'bash', input: 'pwd', status: 'running' }] } })
  const bytes = readFileSync(f.file, 'utf8')
  const restored = new DialogRegistry({ repository: f.repository, create: () => { throw new Error('must not launch') }, errors: {
    unknown: () => new Error('unknown'), readOnly: () => new Error('history only'), emptyText: () => new Error('empty'), storage: () => new Error('storage')
  } })
  const history = restored.snapshot(id)
  assert.equal(history.readOnly, true)
  assert.equal(history.requiresNewConversation, true)
  assert.equal(history.dialog.conversation.status, 'interrupted')
  assert.deepEqual(history.dialog.conversation.interactions, [])
  assert.equal(history.dialog.conversation.messages[0].toolCalls![0].status, 'cancelled')
  assert.throws(() => restored.send(id, 'hello'), /history only/)
  assert.throws(() => restored.interrupt(id), /history only/)
  assert.throws(() => restored.respond(id, 'permission', { kind: 'cancel' }), /history only/)
  assert.equal(readFileSync(f.file, 'utf8'), bytes)
  restored.dispose()
})

it('latest различает global/project, profiles и новое создание при равных clock timestamps', t => {
  const f = fixture(t)
  const global = f.registry.create({ agent: 'claude' })
  const a = f.registry.create({ agent: 'claude' }, 'a')
  const b = f.registry.create({ agent: 'codex' }, 'b')
  assert.equal(f.registry.latest()!.id, global)
  assert.equal(f.registry.latest('a')!.id, a)
  assert.equal(f.registry.latest('b')!.id, b)
  assert.deepEqual(f.registry.list('a').map(record => record.id), [a])
  assert.equal(fixture(t).registry.latest(), undefined)
  const next = f.registry.create({ agent: 'codex' })
  assert.equal(f.registry.latest()!.id, next)
})

it('stop прежнего диалога после создания нового не делает прежний последним при reload', t => {
  let clock = 1000
  t.mock.method(Date, 'now', () => clock)
  const f = fixture(t)
  const old = f.registry.create({ agent: 'claude' })
  clock = 2000
  const next = f.registry.create({ agent: 'codex' })
  clock = 3000
  f.registry.stop(old)
  assert.equal(f.registry.latest()!.id, next)
})

it('ошибка создания записи закрывает новый driver и сохраняет чужую историю', t => {
  const f = fixture(t)
  const id = f.registry.create({ agent: 'claude' })
  const bytes = readFileSync(f.file, 'utf8')
  mkdirSync(`${f.file}.tmp`)
  writeFileSync(join(`${f.file}.tmp`, 'foreign'), 'keep')
  assert.throws(() => f.registry.create({ agent: 'codex' }), /history storage failed/)
  assert.equal(f.children[1].disposed, true)
  assert.equal(f.children[0].disposed, false)
  assert.equal(f.registry.snapshot(id).readOnly, undefined)
  assert.equal(readFileSync(f.file, 'utf8'), bytes)
  rmSync(`${f.file}.tmp`, { recursive: true })
})

it('write failure останавливает затронутый driver, сохраняет memory transcript и сообщает ошибку', async t => {
  const f = fixture(t)
  const a = f.registry.create({ agent: 'claude' })
  const b = f.registry.create({ agent: 'codex' })
  const events: string[] = []
  f.registry.subscribe(a, event => events.push(event.update.type === 'state' ? event.update.status : event.update.type))
  const bytes = readFileSync(f.file, 'utf8')
  mkdirSync(`${f.file}.tmp`)
  await assert.rejects(f.registry.send(a, 'unsaved reply'), /history storage failed/)
  assert.deepEqual(events, ['error'])
  assert.equal(readFileSync(f.file, 'utf8'), bytes)
  assert.equal(f.registry.snapshot(a).dialog.conversation.messages[0].text, 'unsaved reply')
  assert.equal(f.registry.snapshot(a).dialog.conversation.error, 'history storage failed')
  assert.equal(f.registry.snapshot(a).readOnly, true)
  assert.equal(f.children[0].disposed, true)
  assert.equal(f.children[1].disposed, false)
  assert.equal(f.reported.length, 1)
  rmSync(`${f.file}.tmp`, { recursive: true })
  await f.registry.send(b, 'survives')
  assert.equal(f.repository.get(b)!.conversation.messages[0].text, 'survives')
})

it('повреждённый/будущий файл не запускает новый CLI и остаётся неизменным', t => {
  const f = fixture(t)
  for (const bytes of ['broken', '{"schemaVersion":42,"dialogs":[]}']) {
    writeFileSync(f.file, bytes)
    assert.throws(() => f.registry.create({ agent: 'claude' }))
    assert.equal(f.children.length, 0)
    assert.equal(readFileSync(f.file, 'utf8'), bytes)
    assert.throws(() => f.registry.latest())
  }
})

it('unknown metadata существующего DTO переживает следующее событие', async t => {
  const f = fixture(t)
  const id = f.registry.create({ agent: 'claude' })
  const raw = JSON.parse(readFileSync(f.file, 'utf8'))
  raw.extra = { future: true }
  raw.dialogs[0].extra = { title: 'keep' }
  raw.dialogs[0].conversation.extra = ['keep']
  writeFileSync(f.file, JSON.stringify(raw))
  await f.registry.send(id, 'hello')
  const saved = JSON.parse(readFileSync(f.file, 'utf8'))
  assert.deepEqual(saved.extra, { future: true })
  assert.deepEqual(saved.dialogs[0].extra, { title: 'keep' })
  assert.deepEqual(saved.dialogs[0].conversation.extra, ['keep'])
})

it('observer exception не останавливает provider и не мешает второму observer', async t => {
  const f = fixture(t)
  const id = f.registry.create({ agent: 'claude' })
  const seen: string[] = []
  f.registry.subscribe(id, () => { throw new Error('broken observer') })
  f.registry.subscribe(id, event => seen.push(event.update.type))
  await f.registry.send(id, 'hello')
  assert.deepEqual(seen, ['message'])
  assert.equal(f.children[0].disposed, false)
  assert.equal(f.reported[0].message, 'broken observer')
})

it('реальный Codex сохраняется реестром и detach не прерывает turn/permission', async t => {
  const factory = services()
  const f = fixture(t, (settings: AssistantSettings, onUpdate) => providerFixture(t, 'codex', settings.agent, {}, options => factory.create({ ...options, onUpdate })).engine)
  const id = f.registry.create({ agent: 'codex' }, 'repo')
  const detach = f.registry.subscribe(id, () => {})
  detach()
  await f.registry.send(id, 'permission')
  await until(() => f.registry.snapshot(id).dialog.conversation.status === 'waiting')
  const current = f.registry.snapshot(id).dialog.conversation
  assert.equal(f.repository.get(id)!.conversation.providerBinding!.sessionId, 'thread-1')
  await f.registry.respond(id, current.interactions[0].id, { kind: 'option', optionId: 'decline' })
  await until(() => f.registry.snapshot(id).dialog.conversation.status === 'done')
  assert.equal(f.repository.get(id)!.conversation.messages.at(-1)!.text, 'Decision:decline')
  f.registry.stop(id)
  assert.equal(f.registry.snapshot(id).readOnly, true)
})

it('синхронное initial событие factory не читает ещё не созданный driver', t => {
  const f = fixture(t, (_settings, onUpdate) => {
    onUpdate({ type: 'state', status: 'starting' })
    return { id: 'sync', snapshot: () => ({ id: 'sync', agent: 'claude', status: 'starting', messages: [], interactions: [] }), send: async () => {}, respond: async () => {}, interrupt: async () => {}, dispose: () => {} }
  })
  assert.equal(f.registry.create({ agent: 'claude' }), 'sync')
  assert.equal(f.repository.get('sync')!.conversation.status, 'starting')
})

it('unknown metadata сообщений и tools переживает обновление driver snapshot', async t => {
  const f = fixture(t)
  const id = f.registry.create({ agent: 'claude' })
  f.children[0].update({ type: 'message', message: { id: 'tool', role: 'tool', text: '', at: 12, toolCalls: [{ id: 'call', name: 'bash', input: 'pwd', status: 'running' }] } })
  const raw = JSON.parse(readFileSync(f.file, 'utf8'))
  raw.dialogs[0].conversation.messages[0].extra = { future: true }
  raw.dialogs[0].conversation.messages[0].toolCalls[0].extra = ['keep']
  writeFileSync(f.file, JSON.stringify(raw))
  await f.registry.send(id, 'next')
  const saved = JSON.parse(readFileSync(f.file, 'utf8'))
  assert.deepEqual(saved.dialogs[0].conversation.messages[0].extra, { future: true })
  assert.deepEqual(saved.dialogs[0].conversation.messages[0].toolCalls[0].extra, ['keep'])
})

it('unknown provider binding metadata сохраняется после события и stop; исчезнувший native id очищается', async t => {
  const f = fixture(t)
  const id = f.registry.create({ agent: 'codex' })
  f.children[0].state.providerBinding = { transport: 'codex-app-server', sessionId: 'native' }
  f.children[0].update({ type: 'state', status: 'thinking' })
  const raw = JSON.parse(readFileSync(f.file, 'utf8'))
  raw.dialogs[0].conversation.providerBinding.future = { keep: true }
  writeFileSync(f.file, JSON.stringify(raw))
  await f.registry.send(id, 'hello')
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).dialogs[0].conversation.providerBinding.future, { keep: true })
  f.children[0].state.providerBinding = { transport: 'codex-app-server' }
  f.registry.stop(id)
  const binding = JSON.parse(readFileSync(f.file, 'utf8')).dialogs[0].conversation.providerBinding
  assert.deepEqual(binding, { transport: 'codex-app-server', future: { keep: true } })
})
