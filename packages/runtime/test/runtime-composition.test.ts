import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as runtime from '../src/index.ts'
import { createServer, createConnection } from 'node:net'
import { once } from 'node:events'
import { listenPrivateSocket } from '../src/private-socket.ts'

test('profile preflight не перезаписывает будущие schemas до backup/migrations', t => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-schema-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [name, field] of [['projects.json', 'version'], ['boards/project.json', 'formatVersion'], ['dialogs.json', 'schemaVersion']] as const) {
    const file = join(dir, name); mkdirSync(join(file, '..'), { recursive: true }); const bytes = JSON.stringify({ [field]: 999 })
    writeFileSync(file, bytes); assert.throws(() => runtime.assertProfileSchemas(dir), /схем/i); assert.equal(readFileSync(file, 'utf8'), bytes); rmSync(file)
  }
})

test('registry stop ждёт настоящий exit callback и запрещает новый spawn', async () => {
  let exit!: (event: { exitCode: number }) => void; let killed = 0
  const sessions = runtime.createSessionRegistry({ spawn: () => ({ onData: () => {}, onExit: fn => { exit = fn }, write: () => {}, resize: () => {}, kill: () => { killed++ } }) })
  sessions.spawnPty({ cols: 80, rows: 24, meta: { role: 'shell', label: 'test' } })
  let stopped = false; const pending = sessions.stop().then(() => { stopped = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false); assert.equal(killed, 1)
  assert.throws(() => sessions.spawnPty({ cols: 80, rows: 24, meta: { role: 'shell', label: 'late' } }), /останов/i)
  exit({ exitCode: 0 }); await pending; assert.equal(stopped, true)
})

test('headless backup не меняет Desktop version и не сравнивает версии разных продуктов', t => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-product-backup-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'projects.json'), '{"lastRunVersion":"1.1.3","projects":[]}')
  const first = runtime.backupOnProductVersionChange(dir, { name: 'orca-headless', version: '0.0.1' })
  assert.equal(first.updated, false); assert.ok(first.backupDir); assert.equal(JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8')).lastRunVersion, '1.1.3')
  assert.equal(runtime.backupOnProductVersionChange(dir, { name: 'orca-headless', version: '0.0.1' }).backupDir, undefined)
  assert.equal(runtime.backupOnProductVersionChange(dir, { name: 'orca-headless', version: '0.0.2' }).updated, true)
  const file = join(dir, 'product-versions.json'); const future = '{"schemaVersion":99,"versions":{}}'; writeFileSync(file, future)
  assert.throws(() => runtime.backupOnProductVersionChange(dir, { name: 'orca-headless', version: '0.0.3' }), /схем/i); assert.equal(readFileSync(file, 'utf8'), future)
})

test('agent socket не удаляет живой foreign endpoint', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-foreign-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'agent.sock'); const foreign = createServer(socket => socket.end('foreign'))
  foreign.listen(path); await once(foreign, 'listening'); t.after(() => new Promise<void>(resolve => foreign.close(() => resolve())))
  await assert.rejects(listenPrivateSocket(createServer(), path), /живым/)
  const client = createConnection(path); const [data] = await once(client, 'data'); assert.equal(String(data), 'foreign'); client.destroy()
})
