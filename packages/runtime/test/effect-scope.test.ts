import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, statusSource, type RunLane, type StatusSource } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import { gitQueueFixture, git, commitGate, deferred } from './git-queue-fixture.ts'

const stale = (e: unknown) => e instanceof runtime.CommandError && e.code === 'command.stale'
function fixture(t: TestContext) {
  assert.equal(typeof runtime.createEffectScopeService, 'function', 'Отсутствует общий EffectToken service')
  const owner = runtime.createEffectScopeService(); t.after(() => owner.stop())
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  const run = store.createRun('Feature'); const task = store.createTask({ title: 'Task', runId: run.id })
  task.stage = { nodeId: 'commit', visits: { commit: 1 } }; run.stage = { nodeId: 'parent', visits: { parent: 1 } }
  let registered = true
  const project: runtime.EffectProject = { id: 'P', root: '/fixture/repo', store, isCurrent: () => registered }
  return { owner, store, run, task, project, target: { taskId: task.id }, unregister: () => { registered = false } }
}
const mutations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ['task node', f => { f.task.stage!.nodeId = 'next' }],
  ['task visit on the same mutable stage', f => { f.task.stage!.visits.commit = 2 }],
  ['task status', f => { f.store.moveTask(f.task.id, 'review') }],
  ['dispatch', f => { f.store.startDispatch(f.task.id, 'new-pty') }],
  ['task run', f => { f.task.runId = f.store.createRun('Other').id }],
  ['task branch', f => { f.store.updateTask(f.task.id, { branch: 'different' }) }],
  ['task worktree', f => { f.store.updateTask(f.task.id, { worktree: '/different' }) }],
  ['run node', f => { f.run.stage!.nodeId = 'next' }],
  ['run visit', f => { f.run.stage!.visits.parent = 2 }],
  ['run closed', f => { f.run.closedAt = 123 }],
  ['project registration', f => { f.unregister() }],
  ['project root', f => { f.project.root = '/other' }],
  ['same ids from reloaded store', f => { const snapshot = structuredClone(f.store.snapshot()); f.project.store = new TaskStore({ load: () => snapshot, save: () => {} }, () => DEFAULT_COLUMNS) }]
]
for (const [name, mutate] of mutations) test(`${name} makes awaited scope stale before store/process effect`, async t => {
  const f = fixture(t); const scope = f.owner.capture(f.project, f.target); const gate = deferred(); let effects = 0
  const pending = scope.wait(() => gate.promise).then(() => scope.commit(() => { effects++; f.store.updateTask(f.task.id, { title: 'late' }) }))
  const failed = assert.rejects(pending, stale); mutate(f); gate.resolve(); await failed
  assert.equal(effects, 0); assert.equal(f.store.getTask(f.task.id)!.title, 'Task')
})
test('token snapshots primitives; exposed token cannot revive changed mutable stage', t => {
  const f = fixture(t); const scope = f.owner.capture(f.project, f.target)
  assert.equal(scope.token.projectId, 'P'); assert.equal(scope.token.repoRoot, '/fixture/repo'); assert.equal(scope.token.nodeId, 'commit'); assert.equal(scope.token.visit, 1)
  f.task.stage!.visits.commit = 2; assert.equal(scope.token.visit, 1)
  assert.throws(() => Object.assign(scope.token, { visit: 2 }), TypeError); assert.throws(() => scope.commit(() => f.store.updateTask(f.task.id, { title: 'late' })), stale)
})
function lanes(f: ReturnType<typeof fixture>) {
  f.run.stage = { nodeId: 'fork', visits: { fork: 1, left: 1, right: 1 } }
  f.run.lanes = [{ id: 'fork:left', forkId: 'fork', branchId: 'left', forkVisit: 1, nodeId: 'left' },
    { id: 'fork:right', forkId: 'fork', branchId: 'right', forkVisit: 1, nodeId: 'right' }] satisfies RunLane[]
}
test('own lane is stable when neighbor advances; reused fork generation is stale', t => {
  const f = fixture(t); lanes(f)
  const scope = f.owner.capture(f.project, { runId: f.run.id, nodeId: 'left', laneId: 'fork:left' })
  f.run.lanes![1].nodeId = 'join'; f.run.stage!.visits.right = 2
  assert.equal(scope.commit(() => 'current'), 'current'); assert.equal(scope.token.forkVisit, 1)
  f.run.lanes![0].forkVisit = 2
  assert.throws(() => scope.commit(() => f.store.updateGlobalTask(f.run.id, { title: 'late' })), stale)
})
for (const [name, mutate] of [
  ['lane node', (f: ReturnType<typeof fixture>) => { f.run.lanes![0].nodeId = 'join' }],
  ['lane visit', (f: ReturnType<typeof fixture>) => { f.run.stage!.visits.left = 2 }],
  ['lane arrival', (f: ReturnType<typeof fixture>) => { f.run.lanes![0].arrivedAt = 123 }],
  ['lane removed', (f: ReturnType<typeof fixture>) => { f.run.lanes = [] }]
] as const) test(`${name} prevents stale lane commit`, t => {
  const f = fixture(t); lanes(f); const scope = f.owner.capture(f.project, { runId: f.run.id, laneId: 'fork:left' })
  mutate(f); assert.throws(() => scope.commit(() => 'late'), stale)
})
test('ambiguous join and mismatched task/run/node/lane fail before effects', t => {
  const f = fixture(t); lanes(f); for (const lane of f.run.lanes!) lane.nodeId = 'join'
  for (const target of [{ runId: f.run.id, nodeId: 'join' }, { runId: f.run.id, laneId: 'missing' },
    { runId: f.run.id, nodeId: 'elsewhere', laneId: 'fork:left' }, { taskId: f.task.id, runId: f.store.createRun('other').id }]) {
    assert.throws(() => f.owner.capture(f.project, target), e => e instanceof runtime.CommandError && e.code === 'command.conflict')
  }
  const explicit = f.owner.capture(f.project, { runId: f.run.id, nodeId: 'join', laneId: 'fork:left' }); explicit.guard()
  assert.throws(() => f.owner.capture(f.project, { taskId: 'missing' }), e => e instanceof runtime.CommandError && e.code === 'command.taskNotFound')
  assert.throws(() => f.owner.capture(f.project, { runId: 'missing' }), e => e instanceof runtime.CommandError && e.code === 'command.globalTaskNotFound')
})
test('checked failure preserves current cause and rejects stale cause after awaited stage change', async t => {
  const f = fixture(t); const current = f.owner.capture(f.project, f.target); const cause = new Error('native error')
  await assert.rejects(current.wait(async () => { throw cause }), e => e === cause)
  const gate = deferred(); const pending = current.wait(async () => { await gate.promise; throw cause })
  const failed = assert.rejects(pending, stale); f.task.stage!.visits.commit = 2; gate.resolve(); await failed
})
test('concurrent commits keep own attribution across await and release global source', async t => {
  const f = fixture(t); const second = f.store.createTask({ title: 'second' }); const third = f.store.createTask({ title: 'third' })
  const firstGate = deferred(); const secondGate = deferred()
  const captures = (id: string, source: StatusSource) => f.owner.capture(f.project, { taskId: id }, { source })
  const a = captures(f.task.id, 'workflow'); const b = captures(second.id, 'human')
  const pendingA = a.wait(() => firstGate.promise).then(() => a.commit(() => f.store.moveTask(f.task.id, 'review')))
  const pendingB = b.wait(() => secondGate.promise).then(() => b.commit(() => f.store.moveTask(second.id, 'review')))
  f.store.moveTask(third.id, 'review'); secondGate.resolve(); await pendingB; firstGate.resolve(); await pendingA
  assert.equal(f.task.statusHistory!.at(-1)!.by, 'workflow'); assert.equal(second.statusHistory!.at(-1)!.by, 'human')
  assert.equal(third.statusHistory!.at(-1)!.by, 'app'); assert.equal(statusSource(), 'app')
})
test('close/cancelRun/cancelTask/stop/parent abort invalidate only matching open scopes', t => {
  const f = fixture(t); const other = f.store.createTask({ title: 'other' }); const scopes = () => f.owner.capture(f.project, f.target)
  const a = scopes(); const b = f.owner.capture(f.project, { taskId: other.id }); const parent = new AbortController()
  const c = f.owner.capture(f.project, {}, { signal: parent.signal }); parent.abort(); assert.throws(c.guard, stale)
  f.owner.cancelTask('different-project', f.task.id); a.guard(); f.owner.cancelTask('P', f.task.id); assert.throws(a.guard, stale); b.guard()
  const run = scopes(); f.owner.cancelRun('P', f.run.id); assert.throws(run.guard, stale); b.guard()
  b.close(); b.close(); assert.throws(b.guard, stale)
  f.owner.stop(); f.owner.stop(); assert.throws(() => scopes(), stale)
})
test('closed/pre-cancelled scope never invokes work callback', async t => {
  const f = fixture(t); const scope = f.owner.capture(f.project, f.target); let count = 0; scope.close()
  await assert.rejects(scope.wait(async () => { count++ }), stale); assert.equal(count, 0)
  const parent = new AbortController(); parent.abort()
  assert.throws(() => f.owner.capture(f.project, f.target, { signal: parent.signal }), stale)
})
function gitFixture(t: TestContext) {
  const f = fixture(t); const repos = gitQueueFixture(t); f.project.root = repos.root
  const processes = runtime.createGitProcessService(); t.after(() => processes.stop())
  const operations = runtime.createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'untracked' }, repos.queue, processes)
  return { ...f, ...repos, operations }
}
test('stale actual Git commit may exist but next branch/process/store effect never runs', { timeout: 15000 }, async t => {
  const f = gitFixture(t); const scope = f.owner.capture(f.project, f.target); const gate = commitGate(t, f.dir, f.root); let spawned = false
  writeFileSync(join(f.root, 'saved.txt'), 'valuable')
  const pending = scope.transaction(f.operations.workflowGit, async repo => { await repo.gitCommit(f.root, 'held'); await repo.gitCreateBranch(join(f.dir, 'late'), 'late', undefined, false); spawned = true })
    .then(() => scope.commit(() => f.store.updateTask(f.task.id, { title: 'late' })))
  const failed = assert.rejects(pending, stale); await gate.entered()
  await f.operations.workflowGit.transaction(f.other, repo => repo.addTaskWorktree(join(f.dir, 'parallel'), 'parallel'))
  const following = f.operations.projectFetch(f.alias)
  f.task.stage!.visits.commit = 2; gate.release(); await failed; await following
  assert.equal(git(f.root, 'show', 'HEAD:saved.txt'), 'valuable'); assert.equal(spawned, false); assert.equal(f.task.title, 'Task')
  assert.equal(existsSync(join(f.dir, 'late')), false); assert.throws(() => git(f.root, 'rev-parse', '--verify', 'refs/heads/late'))
})
test('cancel while already ready kills actual held Git and releases queue without deleting dirty work', { timeout: 15000 }, async t => {
  const f = gitFixture(t); const scope = f.owner.capture(f.project, f.target); const gate = commitGate(t, f.dir, f.root)
  writeFileSync(join(f.root, 'dirty.txt'), 'preserve'); const before = git(f.root, 'rev-parse', 'HEAD')
  const pending = scope.transaction(f.operations.workflowGit, repo => repo.gitCommit(f.root, 'cancelled'))
  const failed = assert.rejects(pending, stale); await gate.entered(); assert.equal(f.task.status, 'ready')
  const next = f.operations.projectFetch(f.alias); f.owner.cancelTask('P', f.task.id); await failed; await next
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before); assert.equal(readFileSync(join(f.root, 'dirty.txt'), 'utf8'), 'preserve')
})
test('cancel queued scope prevents native branch effect on promotion; fresh scope reads actual branch', { timeout: 15000 }, async t => {
  const f = gitFixture(t); const gate = commitGate(t, f.dir, f.root); writeFileSync(join(f.root, 'held.txt'), 'held')
  const held = f.operations.workflowGit.transaction(f.root, repo => repo.gitCommit(f.root, 'held')); await gate.entered()
  const scope = f.owner.capture(f.project, f.target)
  const pending = scope.transaction(f.operations.workflowGit, repo => repo.addTaskWorktree(join(f.dir, 'queued'), 'queued'))
  const failed = assert.rejects(pending, stale); f.owner.cancelRun('P', f.run.id); gate.release(); await held; await failed
  assert.equal(existsSync(join(f.dir, 'queued')), false); assert.throws(() => git(f.root, 'rev-parse', '--verify', 'refs/heads/queued'))
  const fresh = f.owner.capture(f.project, f.target); assert.equal(await fresh.read(f.operations.workflowGit, repo => repo.currentBranch()), 'main')
})
