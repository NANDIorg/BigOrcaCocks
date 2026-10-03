import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, createConnection, type Server } from 'node:net'
import * as runtime from '../src/index.ts'

async function acquire(dataDir: string) {
  assert.equal(typeof runtime.acquireProfileOwnership, 'function', 'нужен общий владелец профиля')
  return runtime.acquireProfileOwnership({ dataDir })
}

function profile(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-owner-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

test('один owner: повторный startup не меняет record; handshake проверяет nonce', async t => {
  const dir = profile(t)
  const owner = await acquire(dir)
  t.after(() => owner.release())
  const location = await runtime.getProfileLocation(dir)
  const bytes = readFileSync(location.file, 'utf8')
  assert.equal(await runtime.probeProfileOwner(owner.info), true)
  assert.equal(await runtime.probeProfileOwner({ ...owner.info, instanceId: 'чужой nonce' }), false)
  await assert.rejects(acquire(dir), { code: 'ownership.busy' })
  assert.equal(readFileSync(location.file, 'utf8'), bytes)
  // Изменение возвращённого DTO не меняет identity сервера или cleanup.
  const copy = owner.info
  copy.instanceId = 'изменённая копия'
  assert.equal(await runtime.probeProfileOwner(owner.info), true)
  await owner.release()
  await owner.release()
  assert.equal(existsSync(location.file), false)
  const replacement = await acquire(dir)
  await replacement.release()
})

test('alias одного каталога не создаёт второго owner', async t => {
  const base = profile(t)
  const dir = join(base, 'data')
  const alias = join(base, 'alias')
  mkdirSync(dir)
  symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const owner = await acquire(dir)
  t.after(() => owner.release())
  await assert.rejects(acquire(alias), { code: 'ownership.busy' })
  assert.equal((await runtime.getProfileLocation(alias)).profileId, owner.info.profileId)
})

test('разные физические profiles независимы', async t => {
  const base = profile(t)
  const a = await acquire(join(base, 'A'))
  t.after(() => a.release())
  const b = await acquire(join(base, 'B'))
  t.after(() => b.release())
  assert.notEqual(a.info.profileId, b.info.profileId)
  await a.release()
  assert.equal(await runtime.probeProfileOwner(b.info), true)
})

for (const [name, contents, code] of [
  ['повреждённый', '{broken', 'ownership.invalid'],
  ['будущая schema', '{"schemaVersion":999}', 'ownership.schemaUnsupported'],
  ['слишком большой', 'x'.repeat(16385), 'ownership.invalid']
] as const) {
  test(`${name} record не заменяется; failed startup освобождает guard`, async t => {
    const dir = profile(t)
    const first = await acquire(dir)
    const location = await runtime.getProfileLocation(dir)
    await first.release()
    writeFileSync(location.file, contents)
    await assert.rejects(acquire(dir), { code })
    assert.equal(readFileSync(location.file, 'utf8'), contents)
    rmSync(location.file)
    const next = await acquire(dir)
    await next.release()
  })
}

test('owner metadata symlink не читает/не заменяет target', async t => {
  const dir = profile(t)
  const first = await acquire(dir)
  const location = await runtime.getProfileLocation(dir)
  await first.release()
  const target = join(dir, 'original.json')
  writeFileSync(target, 'original bytes')
  // На Windows file symlink может требовать Developer Mode; junction на каталог
  // также обязан отвергаться до чтения, без платформенного пропуска теста.
  if (process.platform === 'win32') symlinkSync(dir, location.file, 'junction')
  else symlinkSync(target, location.file)
  await assert.rejects(acquire(dir), { code: 'ownership.invalid' })
  assert.equal(readFileSync(target, 'utf8'), 'original bytes')
  rmSync(location.file)
  const next = await acquire(dir)
  await next.release()
})

test('чужой live endpoint не закрывается и record не меняется', async t => {
  const dir = profile(t)
  const owner = await acquire(dir)
  const location = await runtime.getProfileLocation(dir)
  const bytes = readFileSync(location.file, 'utf8')
  await owner.release()
  writeFileSync(location.file, bytes)
  const foreign = createServer(socket => { socket.resume(); socket.end('{"foreign":true}\n') })
  const endpoint = location.endpoint
  await new Promise<void>((resolve, reject) => {
    foreign.once('error', reject)
    foreign.listen(endpoint.kind === 'ipc' ? { path: endpoint.path, exclusive: true } : { host: endpoint.host, port: endpoint.port, exclusive: true }, resolve)
  })
  t.after(() => close(foreign))
  await assert.rejects(acquire(dir), { code: 'ownership.unavailable' })
  assert.equal(foreign.listening, true)
  assert.equal(readFileSync(location.file, 'utf8'), bytes)
})

test('release не удаляет подменённый record; следующий startup сохраняет unknown metadata', async t => {
  const dir = profile(t)
  const owner = await acquire(dir)
  const location = await runtime.getProfileLocation(dir)
  const stored = JSON.parse(readFileSync(location.file, 'utf8')) as Record<string, unknown>
  stored.instanceId = 'replacement'
  stored.future = { retained: [1, 2] }
  writeFileSync(location.file, JSON.stringify(stored))
  await owner.release()
  assert.equal(existsSync(location.file), true)
  const next = await acquire(dir)
  t.after(() => next.release())
  assert.deepEqual((JSON.parse(readFileSync(location.file, 'utf8')) as Record<string, unknown>).future, { retained: [1, 2] })
  assert.notEqual(next.info.instanceId, owner.info.instanceId)
})

test('stale record после смены hostname не блокирует тот же физический profile', async t => {
  const dir = profile(t)
  const former = await acquire(dir)
  const identity = former.info
  await former.release()
  const file = join(dir, runtime.PROFILE_OWNER_FILE)
  writeFileSync(file, JSON.stringify({ ...identity, hostname: `former-${identity.hostname}`, retained: { value: 42 } }))
  const next = await acquire(dir)
  t.after(() => next.release())
  assert.equal(next.info.hostname, identity.hostname)
  assert.equal(next.info.profileId, identity.profileId)
  assert.notEqual(next.info.instanceId, identity.instanceId)
  assert.equal(await runtime.probeProfileOwner(next.info), true)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).retained, { value: 42 })
  await next.release()
})

test('guard ограничивает frame и закрывает idle clients', async t => {
  const dir = profile(t)
  const owner = await acquire(dir)
  t.after(() => owner.release())
  const endpoint = owner.info.endpoint
  for (const payload of ['x'.repeat(4097), '']) {
    const closed = await new Promise<boolean>((resolve, reject) => {
      const socket = createConnection(endpoint.kind === 'ipc' ? { path: endpoint.path } : { host: endpoint.host, port: endpoint.port })
      const deadline = setTimeout(() => { socket.destroy(); reject(new Error('guard не закрывает клиента')) }, 4000)
      socket.on('error', () => {})
      socket.once('close', () => { clearTimeout(deadline); resolve(true) })
      socket.once('connect', () => { if (payload) socket.write(payload) })
    })
    assert.equal(closed, true)
    assert.equal(await runtime.probeProfileOwner(owner.info), true)
  }
})

test('относительный dataDir отказывается без создания каталога', async () => {
  await assert.rejects(acquire('relative-profile'), { code: 'ownership.invalid' })
  assert.equal(existsSync('relative-profile'), false)
})
