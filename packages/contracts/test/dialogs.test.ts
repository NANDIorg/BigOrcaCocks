import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as contracts from '../src/index.ts'
import type { DialogRecord } from '../src/index.ts'

function record(status: DialogRecord['conversation']['status'] = 'waiting'): DialogRecord {
  return { id: 'dialog-A', projectId: 'project-A', revision: 4, createdAt: 10, updatedAt: 20, conversation: {
    id: 'conversation-A', agent: 'codex', status, providerBinding: { transport: 'codex-app-server', sessionId: 'thread-native' },
    messages: [{ id: 'human-1', role: 'human', text: 'Привет 🌊', at: 12 }, { id: 'agent-1', role: 'agent', text: 'Работа', at: 14,
      toolCalls: [{ id: 'run', name: 'Bash', input: '{"command":"echo hi"}', status: 'running' }, { id: 'ok', name: 'Read', input: '{}', status: 'ok' }] }],
    interactions: [{ id: 'permission-old', kind: 'permission', title: 'Bash', options: [{ id: 'allow', label: 'Allow once' }] }]
  } }
}

test('история прерванного turn не предлагает отвечать старому provider и не запускает tools', () => {
  assert.equal(typeof contracts.dialogHistory, 'function')
  for (const status of ['starting', 'thinking', 'waiting'] as const) {
    const source = record(status)
    const history = contracts.dialogHistory(source)
    assert.equal(history.readOnly, true)
    assert.equal(history.requiresNewConversation, true)
    assert.equal(history.dialog.conversation.status, 'interrupted')
    assert.deepEqual(history.dialog.conversation.interactions, [])
    assert.deepEqual(history.dialog.conversation.messages[1].toolCalls!.map(tool => tool.status), ['cancelled', 'ok'])
    assert.equal(history.dialog.conversation.messages[0].text, 'Привет 🌊')
    assert.equal(history.dialog.revision, 4)
    assert.equal(source.conversation.status, status)
    assert.equal(source.conversation.interactions.length, 1)
    assert.equal(source.conversation.messages[1].toolCalls![0].status, 'running')
  }
})

test('завершённое состояние и diagnostic сохраняются в history-only', () => {
  assert.equal(typeof contracts.dialogHistory, 'function')
  for (const status of ['done', 'interrupted', 'error'] as const) {
    const source = record(status)
    source.conversation.error = 'provider refused'
    const history = contracts.dialogHistory(source)
    assert.equal(history.dialog.conversation.status, status)
    assert.equal(history.dialog.conversation.error, 'provider refused')
    assert.deepEqual(history.dialog.conversation.providerBinding, { transport: 'codex-app-server', sessionId: 'thread-native' })
  }
})

test('history snapshot не разделяет вложенные сообщения/binding с сохранённым record', () => {
  assert.equal(typeof contracts.dialogHistory, 'function')
  const source = record()
  const history = contracts.dialogHistory(source)
  history.dialog.conversation.messages[0].text = 'changed'
  history.dialog.conversation.providerBinding!.sessionId = 'changed'
  history.dialog.conversation.messages[1].toolCalls![1].input = 'changed'
  assert.equal(source.conversation.messages[0].text, 'Привет 🌊')
  assert.equal(source.conversation.providerBinding!.sessionId, 'thread-native')
  assert.equal(source.conversation.messages[1].toolCalls![1].input, '{}')
})
