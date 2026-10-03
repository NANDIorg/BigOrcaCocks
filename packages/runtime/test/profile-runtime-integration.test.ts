import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProjectServices, createRuntimeSettings, createDialogRepository, probeProfileOwner, PROFILE_OWNER_FILE,
  type ProfileOwnerInfo, type ProjectMessageKey, type ProjectMessageParams } from '../src/index.ts'

interface Frame { type: 'waiting' | 'ready' | 'error' | 'stopped'; owner?: ProfileOwnerInfo; code?: string }
class HostError extends Error { constructor(key: ProjectMessageKey, _params?: ProjectMessageParams) { super(key) } }

function host(t: TestContext, dataDir: string, mode = 'normal') {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: '' }
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  delete env.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/profile-host.mjs', import.meta.url)), dataDir, mode], { env, stdio: 'pipe' })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const reader = createInterface({ input: child.stdout })
  const iterator = reader[Symbol.asyncIterator]()
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    reader.close()
  })
  return {
    child, exited,
    async next(): Promise<Frame> {
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([iterator.next(), new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error(`host timeout: ${stderr}`)), 10000)
        })])
        assert.equal(result.done, false, `host ended: ${stderr}`)
        return JSON.parse(result.value as string) as Frame
      } finally { clearTimeout(deadline) }
    },
    async start() {
      assert.equal((await this.next()).type, 'waiting')
      child.stdin.write('start\n')
      return this.next()
    },
    async stop() {
      child.stdin.write('stop\n')
      assert.equal((await this.next()).type, 'stopped')
      assert.deepEqual(await exited, { code: 0, signal: null })
    }
  }
}

test('два Node startup одного profile выполняют только один initializer', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-host-race-'))
  // Этот hook регистрируется после hosts, чтобы сначала остановить процессы.
  const a = host(t, dir)
  const b = host(t, dir)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await Promise.all([a.next().then(frame => assert.equal(frame.type, 'waiting')), b.next().then(frame => assert.equal(frame.type, 'waiting'))])
  a.child.stdin.write('start\n')
  b.child.stdin.write('start\n')
  const outcomes = await Promise.all([a.next(), b.next()])
  assert.deepEqual(outcomes.map(f => f.type).sort(), ['error', 'ready'])
  const winner = outcomes[0].type === 'ready' ? a : b
  const loser = winner === a ? b : a
  assert.ok(['ownership.busy', 'ownership.unavailable'].includes(outcomes.find(f => f.type === 'error')!.code!))
  assert.deepEqual(await loser.exited, { code: 1, signal: null })
  assert.equal(readFileSync(join(dir, 'initializer.log'), 'utf8'), 'init\n')
  await winner.stop()
  assert.equal(existsSync(join(dir, PROFILE_OWNER_FILE)), false)
})

test('disconnect не останавливает owner; crash/restart сохраняет проекты, доску и диалоги', async t => {
  const base = mkdtempSync(join(tmpdir(), 'orca-host-restart-'))
  const dir = join(base, 'profile')
  mkdirSync(dir)
  const repo = join(base, 'repo')
  execFileSync('git', ['init', '-q', repo])
  const messages = { Error: HostError, text: (key: ProjectMessageKey) => key }
  const { ProjectManager } = createProjectServices({ messages, settings: createRuntimeSettings(messages) })
  const manager = new ProjectManager(dir)
  const project = manager.add(repo)
  const run = manager.store(project.id).createRun('сохранённая задача')
  manager.markRun('1.1.3')
  const dialogs = createDialogRepository(join(dir, 'dialogs.json'))
  dialogs.save({ id: 'saved', createdAt: 1, updatedAt: 1, revision: 0,
    conversation: { id: 'saved', agent: 'codex', status: 'done', messages: [{ id: 'm', role: 'agent', text: 'сохранённый ответ', at: 1 }], interactions: [] } }, null)
  const files = [join(dir, 'projects.json'), join(dir, 'boards', `${project.id}.json`), join(dir, 'dialogs.json')]
  const before = files.map(file => readFileSync(file, 'utf8'))
  const first = host(t, dir)
  const ready = await first.start()
  assert.equal(ready.type, 'ready')
  assert.ok(ready.owner)
  first.child.stdin.end()
  assert.equal(await probeProfileOwner(ready.owner), true)
  first.child.kill('SIGKILL')
  const exit = await first.exited
  assert.notEqual(exit.code, 0)
  const stale = JSON.parse(readFileSync(join(dir, PROFILE_OWNER_FILE), 'utf8')) as ProfileOwnerInfo
  assert.equal(stale.instanceId, ready.owner.instanceId)
  const second = host(t, dir)
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const restored = await second.start()
  assert.equal(restored.type, 'ready')
  assert.ok(restored.owner)
  assert.notEqual(restored.owner.instanceId, stale.instanceId)
  assert.deepEqual(files.map(file => readFileSync(file, 'utf8')), before)
  assert.equal(new ProjectManager(dir).store(project.id).getRun(run.id)?.objective, 'сохранённая задача')
  assert.equal(dialogs.get('saved')!.conversation.messages[0].text, 'сохранённый ответ')
  await second.stop()
})

test('ошибка initializer закрывает ресурс и естественно завершает Node; следующий host стартует', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-host-failed-'))
  const failed = host(t, dir, 'fail')
  const result = await failed.start()
  assert.equal(result.type, 'error')
  assert.deepEqual(await failed.exited, { code: 1, signal: null })
  assert.equal(existsSync(join(dir, 'resource')), false)
  assert.equal(existsSync(join(dir, PROFILE_OWNER_FILE)), false)
  const next = host(t, dir)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal((await next.start()).type, 'ready')
  await next.stop()
})
