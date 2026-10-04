import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as api from '../src/index.ts'

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-bootstrap-'))
  const cleanup: Array<() => Promise<void>> = []
  t.after(async () => { try { for (const fn of cleanup.reverse()) await fn() } finally { rmSync(dir, { recursive: true, force: true }) } })
  return { dir, track: (fn: () => Promise<void>) => cleanup.push(fn) }
}

test('busy profile отказывается до initializer и записи данных', async t => {
  const { dir, track } = setup(t)
  assert.equal(typeof api.startProfileRuntime, 'function')
  const owner = await api.acquireProfileOwnership({ dataDir: dir })
  track(() => owner.release())
  const record = readFileSync(join(dir, api.PROFILE_OWNER_FILE), 'utf8')
  const state = join(dir, 'state.json')
  await assert.rejects(api.startProfileRuntime({ dataDir: dir, start: () => writeFileSync(state, 'wrong writer') }), { code: 'ownership.busy' })
  assert.equal(existsSync(state), false)
  assert.equal(readFileSync(join(dir, api.PROFILE_OWNER_FILE), 'utf8'), record)
})

test('initializer получает canonical profile; cleanup выполняется LIFO до release', async t => {
  const { dir, track } = setup(t)
  assert.equal(typeof api.startProfileRuntime, 'function')
  const alias = join(dir, 'alias')
  symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const log = join(dir, 'cleanup.log')
  const runtime = await api.startProfileRuntime({ dataDir: alias, start: ctx => {
    assert.equal(ctx.dataDir, ctx.owner.dataDir)
    assert.notEqual(resolve(ctx.dataDir), resolve(alias))
    ctx.deferCleanup(() => appendFileSync(log, 'first\n'))
    ctx.deferCleanup(async () => {
      assert.equal(await api.probeProfileOwner(ctx.owner), true)
      appendFileSync(log, 'second\n')
    })
    return { file: join(ctx.dataDir, 'board.json') }
  } })
  track(() => runtime.stop())
  assert.equal(runtime.value.file, join(runtime.owner.dataDir, 'board.json'))
  await runtime.stop()
  assert.equal(readFileSync(log, 'utf8'), 'second\nfirst\n')
  assert.equal(existsSync(join(dir, api.PROFILE_OWNER_FILE)), false)
  await runtime.stop()
  assert.equal(readFileSync(log, 'utf8'), 'second\nfirst\n')
})

test('failed startup убирает реальные ресурсы и возвращает исходную ошибку', async t => {
  const { dir, track } = setup(t)
  assert.equal(typeof api.startProfileRuntime, 'function')
  const original = new Error('startup failed')
  const resource = join(dir, 'resource')
  await assert.rejects(api.startProfileRuntime({ dataDir: dir, start: ctx => {
    writeFileSync(resource, 'opened')
    ctx.deferCleanup(() => rmSync(resource))
    throw original
  } }), error => error === original)
  assert.equal(existsSync(resource), false)
  const next = await api.acquireProfileOwnership({ dataDir: dir })
  track(() => next.release())
})

test('медленный shutdown удерживает lease; concurrent stop не повторяет cleanup', async t => {
  const { dir, track } = setup(t)
  assert.equal(typeof api.startProfileRuntime, 'function')
  let continueCleanup: () => void = () => {}
  const barrier = new Promise<void>(resolve => { continueCleanup = resolve })
  const log = join(dir, 'cleanup.log')
  const runtime = await api.startProfileRuntime({ dataDir: dir, start: ctx => {
    ctx.deferCleanup(async () => { appendFileSync(log, 'started\n'); await barrier; appendFileSync(log, 'done\n') })
    return 42
  } })
  track(async () => { continueCleanup(); await runtime.stop() })
  const first = runtime.stop()
  const second = runtime.stop()
  await assert.rejects(api.acquireProfileOwnership({ dataDir: dir }), { code: 'ownership.busy' })
  assert.equal(readFileSync(log, 'utf8'), 'started\n')
  continueCleanup()
  await Promise.all([first, second])
  assert.equal(readFileSync(log, 'utf8'), 'started\ndone\n')
  assert.equal(runtime.value, 42)
})

test('reentrant stop из cleanup удерживает owner до завершения исходного ресурса', async t => {
  const { dir, track } = setup(t)
  let continueCleanup: () => void = () => {}
  const barrier = new Promise<void>(resolve => { continueCleanup = resolve })
  let entered: () => void = () => {}
  const started = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  let nested: Promise<void> | undefined
  const runtime = await api.startProfileRuntime({ dataDir: dir, start: ctx => {
    ctx.deferCleanup(async () => {
      calls++
      if (calls === 1) {
        nested = runtime.stop()
        entered()
        await barrier
      }
      appendFileSync(join(dir, 'closed.log'), 'closed\n')
    })
    return null
  } })
  track(async () => { continueCleanup(); await runtime.stop(); await nested })
  const stopping = runtime.stop()
  await started
  try {
    assert.equal(await api.probeProfileOwner(runtime.owner), true)
    await assert.rejects(api.acquireProfileOwnership({ dataDir: dir }), { code: 'ownership.busy' })
    assert.equal(calls, 1)
    assert.equal(nested, stopping)
  } finally {
    continueCleanup()
    await Promise.all([stopping, nested])
  }
  assert.equal(readFileSync(join(dir, 'closed.log'), 'utf8'), 'closed\n')
  const successor = await api.acquireProfileOwnership({ dataDir: dir })
  await successor.release()
})

test('failed cleanup сохраняет ownership; retry повторяет только незавершённый ресурс', async t => {
  const { dir, track } = setup(t)
  assert.equal(typeof api.startProfileRuntime, 'function')
  const log = join(dir, 'cleanup.log')
  const blocked = join(dir, 'blocked')
  writeFileSync(blocked, 'still in use')
  const runtime = await api.startProfileRuntime({ dataDir: dir, start: ctx => {
    ctx.deferCleanup(() => { if (existsSync(blocked)) throw new Error('resource busy'); appendFileSync(log, 'first\n') })
    ctx.deferCleanup(() => appendFileSync(log, 'second\n'))
    return null
  } })
  track(async () => { rmSync(blocked, { force: true }); await runtime.stop() })
  await assert.rejects(runtime.stop(), AggregateError)
  assert.equal(readFileSync(log, 'utf8'), 'second\n')
  await assert.rejects(api.acquireProfileOwnership({ dataDir: dir }), { code: 'ownership.busy' })
  rmSync(blocked)
  await runtime.stop()
  assert.equal(readFileSync(log, 'utf8'), 'second\nfirst\n')
})

test('failed partial startup cleanup возвращает recovery handle и не допускает второго writer', async t => {
  const { dir, track } = setup(t)
  assert.equal(typeof api.startProfileRuntime, 'function')
  const original = new Error('startup error')
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'busy')
  let failure: unknown
  try {
    await api.startProfileRuntime({ dataDir: dir, start: ctx => {
      ctx.deferCleanup(() => { if (existsSync(blocker)) throw new Error('cleanup error') })
      throw original
    } })
  } catch (error) { failure = error }
  assert.ok(failure instanceof api.ProfileRuntimeStartupError)
  const recovery = failure
  track(async () => { rmSync(blocker, { force: true }); await recovery.retryCleanup() })
  assert.equal(failure.cause, original)
  await assert.rejects(api.acquireProfileOwnership({ dataDir: dir }), { code: 'ownership.busy' })
  rmSync(blocker)
  await recovery.retryCleanup()
  const next = await api.acquireProfileOwnership({ dataDir: dir })
  await next.release()
})
