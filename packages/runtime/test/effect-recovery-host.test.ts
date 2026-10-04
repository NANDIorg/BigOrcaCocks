import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'
import { TaskStore } from '@orca-board/core'
import { gitQueueFixture } from './git-queue-fixture.ts'
import { workflowMessages } from './workflow-test-host.ts'

test('owned startup отвергает future journal до backup/store и освобождает lease', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-journal-start-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const file = join(dataDir, 'effect-journal.json'); const before = '{"version":99,"records":[]}'; writeFileSync(file, before)
  const marker = join(dataDir, 'backup-started')
  await assert.rejects(runtime.startProfileRuntime({ dataDir, start: ctx => {
    runtime.createEffectJournal({ dataDir: ctx.dataDir, ownerId: ctx.owner.instanceId }); writeFileSync(marker, 'bad')
  } }), /схем/)
  assert.equal(existsSync(marker), false); assert.equal(readFileSync(file, 'utf8'), before)
  const owner = await runtime.startProfileRuntime({ dataDir, start: () => 'lease available' }); assert.equal(owner.value, 'lease available'); await owner.stop()
})
test('session spawn имеет intent до native callback, checkpoint после регистрации и kill при I/O failure', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-journal-pty-')); t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const file = join(dataDir, 'effect-journal.json'); const journal = runtime.createEffectJournal({ dataDir, ownerId: 'one' })
  let killed = 0; let failCheckpoint = false
  const sessions = runtime.createSessionRegistry({ spawn: () => {
    const records = JSON.parse(readFileSync(file, 'utf8')).records
    assert.equal(records.at(-1).phase, 'intent')
    if (failCheckpoint) mkdirSync(`${file}.tmp`)
    return { onData() {}, onExit() {}, write() {}, resize() {}, kill() { killed++ } }
  } })
  const leases = runtime.createSessionWriterLeases({ isAlive: sessions.isAlive })
  const commands = runtime.createSessionCommands({ journal: () => journal, authorize: () => true, project: () => undefined,
    sessions, leases, defaultCwd: dataDir, env: () => ({ API_KEY: 'DO-NOT-STORE' }) })
  const context = { clientId: 'one', actor: { kind: 'operator' as const, id: 'me' } }
  const first = commands.spawn(context, { cols: 80, rows: 24 }); assert.ok(sessions.isAlive(first)); assert.equal(journal.pending().length, 0)
  failCheckpoint = true; assert.throws(() => commands.spawn(context, { cols: 80, rows: 24 }))
  assert.equal(killed, 1); assert.equal(sessions.listTerminals().length, 1); assert.equal(journal.pending().length, 1)
  assert.equal(readFileSync(file, 'utf8').includes('DO-NOT-STORE'), false); sessions.killAll()
})

test('automatic workflow resume блокирует uncertain stage и сохраняет его native ресурсы', async t => {
  const f = gitQueueFixture(t); const store = new TaskStore(); const task = store.createTask({ title: 'uncertain' })
  task.stage = { nodeId: 'merge', visits: { merge: 1 } }
  const dataDir = join(f.dir, 'profile'); const old = runtime.createEffectJournal({ dataDir, ownerId: 'old' })
  old.begin({ repoRoot: f.root, projectId: 'p', taskId: task.id, taskCreatedAt: task.createdAt, nodeId: 'merge', visit: 1 }, { kind: 'git', operation: 'merge', cwd: f.root })
  const journal = runtime.createEffectJournal({ dataDir, ownerId: 'new' }); const processes = runtime.createGitProcessService(); t.after(() => processes.stop())
  const git = runtime.createGitOperations({ error: key => new Error(key), untrackedLabel: () => '' }, f.queue, processes)
  const resources = runtime.createExecutionResources({ journal: () => journal, git, messages: { error: key => new Error(key) }, logger: { warn() {} } })
  const workflow = runtime.createWorkflowServices({ resources, messages: workflowMessages() })
  await workflow.task.resumeStuckStages({ projectId: 'p', store, repoRoot: f.root, isCurrent: () => true, run: () => ({ roles: [] }), startWorker: () => { throw new Error('unexpected launch') } })
  assert.match(store.getTask(task.id)!.stageBlock?.reason ?? '', /неопределён/); assert.equal(journal.pending().length, 1)
})
