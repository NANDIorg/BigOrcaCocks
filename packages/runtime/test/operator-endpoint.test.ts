import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as runtime from '../src/index.ts'

test('private endpoint handshake/reconnect, forged context и disconnect без kill', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-endpoint-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const owner = await runtime.createOrcaRuntime({ dataDir, socketPath: join(dataDir, 'agent.sock'), cliBinDir: dataDir,
    product: { name: 'test', version: '0.0.1' }, prompts: { worker: '', coordinator: '', assistant: '' }, agentSocket: false,
    native: { spawn: () => { throw new Error('Не должен запускаться') } }, authorize: ctx => ctx.actor.kind === 'operator' })
  t.after(() => owner.stop())
  const endpoint = await runtime.startOperatorEndpoint({ runtime: owner.value, token: 'private-token' }); t.after(() => endpoint.stop())
  const headers = { authorization: 'Bearer private-token', 'x-orca-client': 'client-a', 'content-type': 'application/json' }
  const post = async (path: string, body: unknown, custom = headers) => {
    const response = await fetch(endpoint.url + path, { method: 'POST', headers: custom, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  assert.equal((await post('/hello', { protocolMajor: 99, schemaVersion: 1, product: { name: 'web', version: '9' } })).status, 409)
  assert.equal((await post('/hello', { protocolMajor: 1, schemaVersion: 1, product: { name: 'web', version: '9' } }, { ...headers, authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await post('/hello', { protocolMajor: 1, schemaVersion: 1, product: { name: 'web', version: '9' } })).status, 200)
  const call = { id: 'same', issuedAt: Date.now(), method: 'profile.createGroup', args: ['one'], revision: owner.value.revision }
  const first = await post('/call', call); assert.equal(first.body.ok, true)
  assert.deepEqual((await post('/call', call)).body, first.body); assert.equal(owner.value.projects.groups().length, 1)
  assert.equal((await post('/call', { ...call, id: 'forged', actor: { kind: 'system', id: 'admin' } })).body.ok, false)
  await fetch(endpoint.url + '/session', { method: 'DELETE', headers })
  assert.equal(owner.value.projects.groups().length, 1)
  await post('/hello', { protocolMajor: 1, schemaVersion: 1, product: { name: 'cli', version: '2' } })
  assert.deepEqual((await post('/call', call)).body, first.body)
})
