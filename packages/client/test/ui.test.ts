import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrcaClient } from '../src/client.ts'
import { createTypedUiClient } from '../src/ui.ts'
import type { OperatorCall, OperatorMetadata } from '@orca-board/contracts'
import type { OperatorTransport, ClientSelection } from '../src/transport.ts'

test('shared UI keeps project/locale per client and sends explicit scope with fresh revision', async () => {
  const calls: OperatorCall[] = []; const projects = [{ id: 'alpha', root: '/alpha' }, { id: 'beta', root: '/beta' }]
  const settings = { language: 'ru', notifications: {}, assistant: { agent: 'codex' } }
  const metadata: OperatorMetadata = { protocolMajor: 1, schemaVersion: 1, runtimeRevision: 'owner', product: { name: 'test', version: '1.0.0' },
    capabilities: ['profile', 'board', 'method:profile.listProjects', 'method:profile.settings', 'method:profile.setSettings', 'method:board.createTask'] }
  function transport(): OperatorTransport {
    let selection: ClientSelection = {}
    return { hello: async () => metadata, select: async value => { selection = value }, events: async () => [], close: async () => {},
      snapshot: async () => ({ cursor: { epoch: 'owner', sequence: 0, at: Date.now() }, snapshot: { revision: 7, projects: { projects }, board: selection.projectId ? { formatVersion: 1, tasks: [], runs: [], requests: [], questions: [], dispatches: [], events: [] } : null, terminals: [] } }),
      call: async request => { calls.push(request); return { id: request.id, ok: true, result: request.method === 'profile.listProjects' ? { projects, groups: [] } : request.method === 'profile.settings' ? settings : request.method === 'board.createTask' ? { id: 'task' } : settings } }
    }
  }
  const one = createOrcaClient({ transport: transport(), product: { name: 'one', version: '1.0.0' }, pollMs: 0 })
  const two = createOrcaClient({ transport: transport(), product: { name: 'two', version: '1.0.0' }, pollMs: 0 })
  const errors: unknown[] = []
  const a = createTypedUiClient(one, { onError: error => errors.push(error) }); const b = createTypedUiClient(two, { onError: error => errors.push(error) })
  try {
    await a.client.projects.list(); await b.client.projects.list(); await b.client.projects.setActive('beta')
    await a.client.tasks.create({ title: 'A' }); await b.client.tasks.create({ title: 'B' })
    const mutations = calls.filter(call => call.method === 'board.createTask')
    assert.deepEqual(mutations.map(call => [call.projectId, call.revision]), [['alpha', 7], ['beta', 7]])
    const before = calls.filter(call => call.method === 'profile.setSettings').length
    assert.equal((await a.client.app.setSettings({ language: 'en' })).language, 'en')
    assert.equal((await b.client.app.getSettings()).language, 'ru')
    assert.equal(calls.filter(call => call.method === 'profile.setSettings').length, before)
    assert.deepEqual(errors, [])
  } finally { await a.dispose(); await b.dispose() }
})

test('UI восстанавливает чат после потери событий и различает terminal assistant', async () => {
  const calls: OperatorCall[] = []; let reset = false; let status = 'thinking'; let agent = 'codex'
  const methods = ['profile.settings', 'profile.workflowContext', 'dialog.list', 'dialog.create', 'dialog.snapshot', 'dialog.send', 'dialog.stop', 'session.list', 'resources.assistantTerminal']
  const transport: OperatorTransport = {
    hello: async () => ({ protocolMajor: 1, schemaVersion: 1, runtimeRevision: 'owner', product: { name: 'web', version: '2.0.0' }, capabilities: methods.map(name => `method:${name}`) }),
    select: async () => {}, close: async () => {},
    events: async () => { if (!reset) return []; reset = false; return [{ type: 'snapshotRequired', cursor: { epoch: 'owner', sequence: 1, at: Date.now() } }] },
    snapshot: async () => ({ cursor: { epoch: 'owner', sequence: 1, at: Date.now() }, snapshot: { revision: 7, projects: { projects: [] }, board: null, terminals: [] } }),
    call: async packet => {
      calls.push(packet)
      const result = packet.method === 'profile.settings' ? { assistant: { agent } }
        : packet.method === 'dialog.create' ? 'dialog'
        : packet.method === 'resources.assistantTerminal' ? 'pty'
        : packet.method === 'dialog.snapshot' ? { dialog: { id: 'dialog', revision: 9, conversation: { messages: [], status } } }
        : packet.method === 'profile.workflowContext' ? 'workflow context' : packet.method.endsWith('.list') ? [] : null
      return { id: packet.id, ok: true, result }
    }
  }
  const operator = createOrcaClient({ transport, product: { name: 'test', version: '2.0.0' }, pollMs: 5 })
  const errors: unknown[] = []; const adapter = createTypedUiClient(operator, { onError: error => errors.push(error) })
  try {
    await adapter.client.assistant.open(80, 24)
    assert.equal(operator.state.selection.dialogId, 'dialog')
    assert.equal((await adapter.client.assistantChat.getMessages('dialog')).status, 'thinking')
    let restored = false
    const off = adapter.client.assistantChat.onMessage('dialog', update => { if ('status' in update && update.status === 'done') restored = true })
    status = 'done'; reset = true
    const deadline = Date.now() + 1000
    while (!restored && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(restored, true); off()
    await adapter.client.assistantChat.sendWithWorkflow('dialog', 'save', { mode: 'create' })
    assert.deepEqual(calls.find(call => call.method === 'dialog.send')?.args, ['dialog', 'save', 'workflow context'])
    assert.equal(calls.find(call => call.method === 'dialog.send')?.revision, 9)
    agent = 'shell'; await adapter.client.assistant.reset(80, 24)
    const before = calls.filter(call => call.method === 'dialog.snapshot').length
    assert.equal((await adapter.client.assistantChat.getMessages('pty')).transport, 'terminal')
    assert.equal(calls.filter(call => call.method === 'dialog.snapshot').length, before)
    assert.equal(operator.state.selection.dialogId, undefined); assert.deepEqual(errors, [])
  } finally { await adapter.dispose() }
})
