import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DialogRecord } from '@orca-board/contracts'
import * as runtime from '../src/index.ts'

function directory(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-dialog-repository-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function record(id = 'dialog-A', projectId = 'project-A'): DialogRecord {
  return { id, projectId, revision: 0, createdAt: 10, updatedAt: 20, conversation: {
    id: `conversation-${id}`, agent: 'codex', status: 'waiting', providerBinding: { transport: 'codex-app-server', sessionId: 'thread-native' },
    messages: [{ id: 'human-1', role: 'human', text: 'Привет 🌊', at: 12 }, { id: 'agent-1', role: 'agent', text: '', at: 14,
      toolCalls: [{ id: 'tool-1', name: 'Bash', input: '{}', status: 'running' }] }],
    interactions: [{ id: 'permission-1', kind: 'permission', title: 'Bash', text: '', tool: { name: 'Bash', input: '{}' },
      options: [{ id: 'deny', label: 'Deny', description: '', kind: 'reject_once' }],
      questions: [{ id: 'q1', question: 'Choose?', header: '', options: [{ id: 'a', label: 'A' }], multiSelect: false, allowFreeform: true }] }]
  } }
}
function code(expected: string): (error: unknown) => boolean {
  return error => error instanceof runtime.DialogRepositoryError && error.code === expected
}

test('factory требует абсолютный file, чтение отсутствующего файла не создаёт каталог', t => {
  const dir = directory(t)
  assert.equal(typeof runtime.createDialogRepository, 'function')
  assert.throws(() => runtime.createDialogRepository('relative.json'), code('dialog.invalid'))
  const file = join(dir, 'not-created', 'dialogs.json')
  const repo = runtime.createDialogRepository(file)
  assert.deepEqual(repo.list(), [])
  assert.equal(repo.get('missing'), undefined)
  assert.equal(repo.history('missing'), undefined)
  assert.equal(existsSync(join(dir, 'not-created')), false)
})

test('диск сохраняет Unicode/native id; reload, revision update, history-only и delete', t => {
  const file = join(directory(t), 'dialogs.json')
  const repo = runtime.createDialogRepository(file)
  const first = record()
  repo.save(first, null)
  const next = runtime.createDialogRepository(file)
  assert.deepEqual(next.get(first.id), first)
  const history = next.history(first.id)!
  assert.equal(history.readOnly, true)
  assert.equal(history.requiresNewConversation, true)
  assert.equal(history.dialog.conversation.status, 'interrupted')
  assert.deepEqual(history.dialog.conversation.interactions, [])
  assert.equal(history.dialog.conversation.messages[1].toolCalls![0].status, 'cancelled')
  history.dialog.conversation.messages[0].text = 'changed locally'
  assert.deepEqual(next.get(first.id), first)
  next.save({ ...first, revision: 1, updatedAt: 30 }, 0)
  assert.equal(repo.get(first.id)!.revision, 1)
  repo.remove(first.id, 1)
  assert.deepEqual(next.list(), [])
})

test('opaque ids не становятся путями, проекты и отдельные profiles не смешиваются', t => {
  const dir = directory(t)
  const a = runtime.createDialogRepository(join(dir, 'profile-A', 'dialogs.json'))
  const b = runtime.createDialogRepository(join(dir, 'profile-B', 'dialogs.json'))
  a.save(record('../outside'), null)
  a.save(record('second', 'project-B'), null)
  b.save(record('../outside', 'project-B'), null)
  assert.deepEqual(a.list('project-A').map(r => r.id), ['../outside'])
  assert.deepEqual(a.list('project-B').map(r => r.id), ['second'])
  assert.deepEqual(b.list('project-A'), [])
  assert.equal(b.get('../outside')!.projectId, 'project-B')
  assert.equal(existsSync(join(dir, 'outside')), false)
})

test('устаревшие save/delete и неверный next revision не меняют байты', t => {
  const file = join(directory(t), 'dialogs.json')
  const repo = runtime.createDialogRepository(file)
  const r = record()
  repo.save(r, null)
  repo.save({ ...r, revision: 1 }, 0)
  const bytes = readFileSync(file, 'utf8')
  for (const mutate of [
    () => repo.save({ ...r, revision: 1 }, 0), () => repo.save(r, null),
    () => repo.save({ ...r, revision: 3 }, 1), () => repo.remove(r.id, 0),
    () => repo.remove('missing', 0), () => repo.save({ ...r, id: 'new', revision: 1 }, null),
    () => repo.save({ ...r, id: 'missing', revision: 2 }, 1), () => repo.remove(r.id, NaN)
  ]) {
    assert.throws(mutate, code('dialog.conflict'))
    assert.equal(readFileSync(file, 'utf8'), bytes)
  }
})

const invalidRecords: [string, (r: DialogRecord) => void][] = [
  ['empty id', r => { r.id = '' }], ['project id', r => { r.projectId = '' }],
  ['fractional revision', r => { r.revision = 0.5 }], ['negative timestamp', r => { r.createdAt = -1 }],
  ['infinite timestamp', r => { r.updatedAt = Infinity }],
  ['agent', r => { Object.assign(r.conversation, { agent: 'unknown' }) }],
  ['status', r => { Object.assign(r.conversation, { status: 'unknown' }) }],
  ['message id', r => { r.conversation.messages[0].id = '' }],
  ['message role', r => { Object.assign(r.conversation.messages[0], { role: 'system' }) }],
  ['message text', r => { Object.assign(r.conversation.messages[0], { text: 42 }) }],
  ['message timestamp', r => { r.conversation.messages[0].at = Number.MAX_SAFE_INTEGER + 1 }],
  ['message limit', r => { r.conversation.messages = Array.from({ length: 301 }, (_, i) => ({ id: `m${i}`, role: 'human', text: '', at: 0 })) }],
  ['tool status', r => { Object.assign(r.conversation.messages[1].toolCalls![0], { status: 'unknown' }) }],
  ['tool input', r => { Object.assign(r.conversation.messages[1].toolCalls![0], { input: {} }) }],
  ['interaction id', r => { r.conversation.interactions[0].id = '' }],
  ['option kind', r => { Object.assign(r.conversation.interactions[0].options![0], { kind: 'unknown' }) }],
  ['question bool', r => { Object.assign(r.conversation.interactions[0].questions![0], { multiSelect: 'yes' }) }],
  ['question option', r => { Object.assign(r.conversation.interactions[0].questions![0].options![0], { label: 42 }) }],
  ['binding mismatch', r => { r.conversation.providerBinding!.transport = 'acp' }],
  ['binding session id', r => { r.conversation.providerBinding!.sessionId = '' }],
  ['diagnostic', r => { Object.assign(r.conversation, { error: [] }) }],
  ['toJSON output', r => { Object.assign(r, { toJSON: () => ({ id: r.id }) }) }]
]
for (const [name, mutate] of invalidRecords) test(`невалидный DTO (${name}) не повреждает уже сохранённые диалоги`, t => {
  const file = join(directory(t), 'dialogs.json')
  const repo = runtime.createDialogRepository(file)
  repo.save(record(), null)
  const bytes = readFileSync(file, 'utf8')
  const invalid = record('bad')
  mutate(invalid)
  assert.throws(() => repo.save(invalid, null), code('dialog.invalid'))
  assert.equal(readFileSync(file, 'utf8'), bytes)
})

for (const [name, bytes, errorCode] of [
  ['future schema', JSON.stringify({ schemaVersion: 2, dialogs: [record()] }), 'dialog.schemaUnsupported'],
  ['invalid JSON', '{ broken', 'dialog.invalid'],
  ['missing envelope', JSON.stringify([record()]), 'dialog.invalid'],
  ['partial invalid', JSON.stringify({ schemaVersion: 1, dialogs: [record(), { ...record('bad'), conversation: null }] }), 'dialog.invalid'],
  ['duplicate ids', JSON.stringify({ schemaVersion: 1, dialogs: [record(), record()] }), 'dialog.invalid']
] as const) test(`${name}: чтение/save/delete отказывают, исходный файл сохранён`, t => {
  const file = join(directory(t), 'dialogs.json')
  writeFileSync(file, bytes)
  const repo = runtime.createDialogRepository(file)
  for (const op of [() => repo.list(), () => repo.get('dialog-A'), () => repo.history('dialog-A'), () => repo.save(record('new'), null), () => repo.remove('dialog-A', 0)]) {
    assert.throws(op, code(errorCode))
    assert.equal(readFileSync(file, 'utf8'), bytes)
  }
})

test('unknown JSON metadata сохраняются после обновления и удаления соседнего record', t => {
  const file = join(directory(t), 'dialogs.json')
  const original = record()
  Object.assign(original, { custom: { tag: 'record' } })
  Object.assign(original.conversation, { custom: ['conversation'] })
  Object.assign(original.conversation.providerBinding!, { region: 'native' })
  Object.assign(original.conversation.messages[0], { custom: { tag: 'message' } })
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, custom: { owner: 'future' }, dialogs: [original, record('other')] }))
  const repo = runtime.createDialogRepository(file)
  const update = repo.get('dialog-A')!
  update.revision = 1
  update.conversation.messages[0].text = 'Новый текст'
  repo.save(update, 0)
  repo.remove('other', 0)
  const expected = JSON.parse(JSON.stringify(original))
  expected.revision = 1
  expected.conversation.messages[0].text = 'Новый текст'
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schemaVersion: 1, custom: { owner: 'future' }, dialogs: [expected], retiredDialogIds: ['other'] })
  assert.deepEqual(repo.history('dialog-A')!.dialog.conversation.providerBinding, original.conversation.providerBinding)
})

test('ошибка atomic tmp не удаляет чужой каталог, прежние байты и revision; retry работает', t => {
  const file = join(directory(t), 'dialogs.json')
  const repo = runtime.createDialogRepository(file)
  const r = record()
  repo.save(r, null)
  const bytes = readFileSync(file, 'utf8')
  mkdirSync(`${file}.tmp`)
  const sentinel = join(`${file}.tmp`, 'foreign.txt')
  writeFileSync(sentinel, 'keep')
  assert.throws(() => repo.save({ ...r, revision: 1 }, 0))
  assert.equal(readFileSync(file, 'utf8'), bytes)
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep')
  assert.equal(repo.get(r.id)!.revision, 0)
  rmSync(`${file}.tmp`, { recursive: true })
  repo.save({ ...r, revision: 1 }, 0)
  assert.equal(repo.get(r.id)!.revision, 1)
})

test('I/O ошибка чтения не подменяется отсутствующим файлом', t => {
  const file = join(directory(t), 'directory.json')
  mkdirSync(file)
  const repo = runtime.createDialogRepository(file)
  assert.throws(() => repo.list())
  assert.throws(() => repo.save(record(), null))
  assert.equal(existsSync(file), true)
})

for (const operation of ['save', 'remove'] as const) test(`удалённый id не переиспользуется после reload: stale ${operation} не повреждает замену`, t => {
  const file = join(directory(t), 'dialogs.json')
  const repo = runtime.createDialogRepository(file)
  repo.save(record(), null)
  const stale = repo.get('dialog-A')!
  repo.remove(stale.id, 0)
  const restarted = runtime.createDialogRepository(file)
  const replacement = record('dialog-new')
  replacement.conversation.messages[0].text = 'Новый разговор'
  // Старый id относится к старому lifecycle: даже explicit create не сбрасывает revision.
  assert.throws(() => restarted.save({ ...replacement, id: stale.id }, null), code('dialog.conflict'))
  restarted.save(replacement, null)
  const bytes = readFileSync(file, 'utf8')
  assert.throws(() => operation === 'save' ? restarted.save({ ...stale, revision: 1 }, 0) : restarted.remove(stale.id, 0), code('dialog.conflict'))
  assert.equal(readFileSync(file, 'utf8'), bytes)
  assert.deepEqual(runtime.createDialogRepository(file).get(replacement.id), replacement)
  assert.throws(() => runtime.createDialogRepository(file).save(stale, null), code('dialog.conflict'))
})

for (const retiredDialogIds of [[42], [''], ['old', 'old'], ['dialog-A']]) test(`невалидные retired ids ${JSON.stringify(retiredDialogIds)} блокируют все записи`, t => {
  const file = join(directory(t), 'dialogs.json')
  const bytes = JSON.stringify({ schemaVersion: 1, dialogs: [record()], retiredDialogIds })
  writeFileSync(file, bytes)
  const repo = runtime.createDialogRepository(file)
  assert.throws(() => repo.save(record('new'), null), code('dialog.invalid'))
  assert.throws(() => repo.remove('dialog-A', 0), code('dialog.invalid'))
  assert.equal(readFileSync(file, 'utf8'), bytes)
})
