import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TaskStore } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import { gitQueueFixture, git, commitGate } from './git-queue-fixture.ts'

test('настоящий hook/stale оставляет native completion без metadata checkpoint', { timeout: 15000 }, async t => {
  const f = gitQueueFixture(t); const processes = runtime.createGitProcessService(); t.after(() => processes.stop())
  const journal = runtime.createEffectJournal({ dataDir: join(f.dir, 'profile'), ownerId: 'one' })
  const store = new TaskStore(); const task = store.createTask({ title: 'task' })
  const effects = runtime.createEffectScopeService({ journal: () => journal })
  const scope = effects.capture({ id: 'p', root: f.root, store }, { taskId: task.id })
  const operations = runtime.createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'untracked' }, f.queue, processes)
  assert.equal(await scope.read(operations.workflowGit, repo => repo.currentBranch()), 'main')
  await assert.rejects(scope.transaction(operations.workflowGit, repo => repo.gitCheckout(f.root, 'missing')), /ветки.*нет/)
  assert.equal(journal.pending().length, 0)
  writeFileSync(join(f.root, 'answer.txt'), 'answer'); const hook = commitGate(t, f.dir, f.root)
  const pending = scope.transaction(operations.workflowGit, repo => repo.gitCommit(f.root, 'answer'))
  const rejected = assert.rejects(pending, e => e instanceof runtime.CommandError && e.code === 'command.stale')
  try {
    await hook.entered(); assert.equal(journal.pending().filter(r => r.phase === 'intent').length, 1)
    store.updateTask(task.id, { branch: 'another' }); hook.release(); await rejected
    assert.equal(git(f.root, 'show', 'HEAD:answer.txt'), 'answer')
    assert.equal(journal.pending().filter(r => r.phase === 'native-complete').length, 2)
  } finally { hook.release(); scope.close() }
})
test('авария после реального commit: новый owner отказывает до Git, явное решение не запускает effect', async t => {
  const f = gitQueueFixture(t); const dataDir = join(f.dir, 'profile'); const board = join(dataDir, 'board.json')
  const store = new TaskStore(runtime.jsonPersistence(board)); const task = store.createTask({ title: 'task' })
  writeFileSync(join(f.root, 'crash.txt'), 'kept')
  const script = join(f.dir, 'crash.mjs')
  writeFileSync(script, `import {TaskStore} from ${JSON.stringify(new URL('../../core/src/index.ts', import.meta.url).href)};
import * as r from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
const store=new TaskStore(r.jsonPersistence(${JSON.stringify(board)}));
const journal=r.createEffectJournal({dataDir:${JSON.stringify(dataDir)},ownerId:'old'});
const effects=r.createEffectScopeService({journal:()=>journal});
const scope=effects.capture({id:'p',root:${JSON.stringify(f.root)},store},{taskId:${JSON.stringify(task.id)}});
const git=r.createGitOperations({error:key=>new Error(key),untrackedLabel:()=>''});
await scope.transaction(git.workflowGit,repo=>repo.gitCommit(${JSON.stringify(f.root)},'before crash'));
process.exit(0);
`)
  execFileSync(process.execPath, [script], { stdio: 'pipe' })
  const head = git(f.root, 'rev-parse', 'HEAD'); const journal = runtime.createEffectJournal({ dataDir, ownerId: 'new' })
  const effects = runtime.createEffectScopeService({ journal: () => journal }); const scope = effects.capture({ id: 'p', root: f.root, store }, { taskId: task.id })
  const processes = runtime.createGitProcessService(); t.after(() => processes.stop())
  const operations = runtime.createGitOperations({ error: key => new Error(key), untrackedLabel: () => '' }, f.queue, processes)
  await assert.rejects(scope.transaction(operations.workflowGit, repo => repo.gitCommit(f.root, 'duplicate')), /неопределён/)
  for (const record of journal.pending()) journal.resolve(record.id, record.revision, 'retry')
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head); assert.equal(readFileSync(join(f.root, 'crash.txt'), 'utf8'), 'kept')
  scope.close()
})
test('другой scope не подтверждает чужой effect, явная передача связывает nested checkpoint', t => {
  const f = gitQueueFixture(t); const journal = runtime.createEffectJournal({ dataDir: join(f.dir, 'profile'), ownerId: 'one' })
  const store = new TaskStore(); const task = store.createTask({ title: 'task' }); const project = { id: 'p', root: f.root, store }
  const effects = runtime.createEffectScopeService({ journal: () => journal })
  const first = effects.capture(project, { taskId: task.id }); const second = effects.capture(project, { taskId: task.id })
  first.external({ kind: 'files', operation: 'placement', cwd: f.root }, () => writeFileSync(join(f.root, 'kept.txt'), 'kept'))
  second.commit(() => undefined); assert.equal(journal.pending().length, 1)
  first.transferTo(second); second.commit(() => store.updateTask(task.id, { title: 'saved' }))
  assert.equal(journal.pending().length, 0); first.close(); second.close()
})
test('capture flags фиксируются; ошибочная запись intent не вызывает native callback', t => {
  const f = gitQueueFixture(t); const dataDir = join(f.dir, 'profile'); mkdirSync(dataDir)
  const journal = runtime.createEffectJournal({ dataDir, ownerId: 'one' }); const store = new TaskStore(); const task = store.createTask({ title: 'task' })
  const target: runtime.EffectTarget = { taskId: task.id, taskResources: false }
  const effects = runtime.createEffectScopeService({ journal: () => journal }); const scope = effects.capture({ id: 'p', root: f.root, store }, target)
  delete target.taskResources; store.updateTask(task.id, { branch: 'prepared' }); assert.doesNotThrow(scope.guard)
  mkdirSync(join(dataDir, 'effect-journal.json.tmp')); let called = false
  assert.throws(() => scope.external({ kind: 'pty', operation: 'spawn', cwd: f.root }, () => { called = true }))
  assert.equal(called, false); rmSync(join(dataDir, 'effect-journal.json.tmp'), { recursive: true })
  let rolledBack: string | undefined
  assert.throws(() => scope.external({ kind: 'pty', operation: 'spawn', cwd: f.root }, () => {
    mkdirSync(join(dataDir, 'effect-journal.json.tmp')); return 'created-pty'
  }, id => { rolledBack = id }))
  assert.equal(rolledBack, 'created-pty'); assert.equal(journal.pending().length, 1); scope.close()
})
