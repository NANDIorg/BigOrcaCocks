import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrcaClient, type OperatorTransport } from '../src/index.ts'
import type { OperatorCall } from '@orca-board/contracts'

function transport() {
  const calls: OperatorCall[] = []; const results = new Map<string, unknown>(); let effects = 0; let lose = true
  const port: OperatorTransport = {
    hello: async () => ({ protocolMajor: 1, schemaVersion: 1, runtimeRevision: 'owner', product: { name: 'server', version: '9.0.0' }, capabilities: ['profile', 'method:profile.createGroup', 'board', 'method:board.get'] }),
    select: async () => {}, snapshot: async () => ({ snapshot: { revision: 1 }, cursor: { epoch: 'owner', sequence: 0, at: 1 } }),
    events: async () => [], close: async () => {},
    call: async request => {
      calls.push(structuredClone(request))
      if (!results.has(request.id)) results.set(request.id, { id: String(++effects), name: request.args[0] })
      if (lose) { lose = false; throw new TypeError('lost reply') }
      return { id: request.id, ok: true, result: results.get(request.id) }
    }
  }
  return { port, calls, effects: () => effects }
}

test('reconnect повторяет ту же mutation identity; язык/selection не меняют другой client', async () => {
  const host = transport(); const client = createOrcaClient({ transport: host.port, product: { name: 'desktop', version: '1.1.3' }, pollMs: 0, sleep: async () => {} })
  await client.connect(); const other = createOrcaClient({ transport: transport().port, product: { name: 'cli', version: '0.0.1' }, pollMs: 0 })
  await other.connect(); await client.select({ projectId: 'project-a' }); client.setLanguage('en')
  const result = await client.call('profile', 'createGroup', ['group'], { revision: 1 })
  assert.equal(result.name, 'group'); assert.equal(host.effects(), 1); assert.deepEqual(host.calls[0], host.calls[1])
  assert.equal(other.state.selection.projectId, undefined); assert.equal(other.state.language, 'ru')
  await Promise.all([client.close(), other.close()])
})

test('поздний read после смены selection не перезаписывает состояние нового клиента', async () => {
  const host = transport(); let finish!: (value: Awaited<ReturnType<OperatorTransport['call']>>) => void
  host.port.call = request => new Promise(resolve => { finish = value => resolve({ ...value, id: request.id }) })
  const client = createOrcaClient({ transport: host.port, product: { name: 'desktop', version: '1.1.3' }, pollMs: 0 })
  await client.connect(); await client.select({ projectId: 'a' })
  const pending = client.call('board', 'get', [], { projectId: 'a' }); await new Promise(resolve => setImmediate(resolve))
  await client.select({ projectId: 'b' }); finish({ id: '', ok: true, result: { tasks: [] } })
  await assert.rejects(pending, error => error instanceof Error && 'code' in error && error.code === 'client.staleResponse')
  assert.equal(client.state.selection.projectId, 'b'); await client.close()
})
