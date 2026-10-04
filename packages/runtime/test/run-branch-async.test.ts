import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TaskStore, DEFAULT_COLUMNS } from '@orca-board/core'
import * as runtime from '../src/index.ts'
import { gitQueueFixture, git, commitGate } from './git-queue-fixture.ts'

const stale = (e: unknown) => e instanceof runtime.CommandError && e.code === 'command.stale'
function fixture(t: TestContext) {
  assert.equal(typeof runtime.createAsyncRunBranchServices, 'function', 'Отсутствует async RunBranchServices')
  const f = gitQueueFixture(t); const effects = runtime.createEffectScopeService(); t.after(() => effects.stop())
  const processes = runtime.createGitProcessService(); t.after(() => processes.stop())
  const operations = runtime.createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'untracked' }, f.queue, processes)
  const messages = { error: (key: runtime.ExecutionMessageKey) => new Error(key) }
  const service = runtime.createAsyncRunBranchServices({ messages, git: operations, effects })
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS); const run = store.createGlobalTask({ title: 'Feature' })
  let current = true
  const project: runtime.EffectProject = { id: 'P', root: f.root, store, isCurrent: () => current }
  return { ...f, effects, operations, messages, service, store, run, project, unregister: () => { current = false } }
}
test('feature branch is isolated, no upstream/root switch; repeated preparation and review target agree', async t => {
  const f = fixture(t); const head = git(f.root, 'rev-parse', 'HEAD'); const g = await f.service.ensureRunBranch(f.project, f.run.id)
  assert.ok(g?.worktree); assert.equal(g.base, 'main'); assert.equal(git(f.root, 'branch', '--show-current'), 'main')
  assert.equal(git(g.worktree, 'rev-parse', 'HEAD'), head); assert.throws(() => git(g.worktree!, 'rev-parse', '--abbrev-ref', '@{upstream}'))
  assert.deepEqual(await f.service.ensureRunBranch(f.project, f.run.id), g)
  assert.deepEqual(await f.service.mergeTarget(f.project, { runId: f.run.id }), { cwd: g.worktree, branch: g.branch })
  assert.equal(await f.service.reviewBase(f.project, { runId: f.run.id }), g.branch)
  assert.deepEqual(await f.service.mergeTarget(f.project, {}), { cwd: f.root, branch: 'main' })
  const common = runtime.createExecutionResources({ messages: f.messages, git: f.operations, logger: { warn: () => {} } })
  t.after(() => common.effects.stop()); assert.deepEqual(await common.ensureRunBranch(f.store, f.root, f.run.id), g)
})
test('detached base is actual SHA; unborn rejects before refs/worktree/store changes', async t => {
  const f = fixture(t); const head = git(f.root, 'rev-parse', 'HEAD'); git(f.root, 'checkout', '-q', '--detach')
  assert.equal((await f.service.ensureRunBranch(f.project, f.run.id))!.base, head)
  const empty = f.store.createGlobalTask({ title: 'empty' }); const project = { ...f.project, root: f.unborn }
  await assert.rejects(f.service.ensureRunBranch(project, empty.id), { message: 'git.noCommits' })
  assert.equal(f.store.getRun(empty.id)!.git, undefined); assert.equal(existsSync(f.service.runWorktreePath(f.unborn, empty.id)), false)
})
test('inbox and old run with dispatch never acquire new feature branch', async t => {
  const f = fixture(t); assert.equal(await f.service.ensureRunBranch(f.project, undefined), undefined)
  const old = f.store.createRun('old'); const task = f.store.createTask({ title: 'old task', runId: old.id }); f.store.startDispatch(task.id, 'old-pty')
  assert.equal(await f.service.ensureRunBranch(f.project, old.id), undefined); assert.equal(old.git, undefined)
  const loose = f.store.createTask({ title: 'loose' }); assert.ok(loose.runId)
  assert.equal(await f.service.ensureRunBranch(f.project, loose.runId), undefined)
})
test('removed worktree restored; missing feature branch rejects without recreating new history', async t => {
  const f = fixture(t); const g = (await f.service.ensureRunBranch(f.project, f.run.id))!; const head = git(f.root, 'rev-parse', g.branch)
  rmSync(g.worktree!, { recursive: true, force: true }); const restored = (await f.service.ensureRunBranch(f.project, f.run.id))!
  assert.equal(git(restored.worktree!, 'rev-parse', 'HEAD'), head)
  await f.service.removeRunWorktree(f.project, f.run.id); git(f.root, 'branch', '-D', g.branch)
  await assert.rejects(f.service.ensureRunBranch(f.project, f.run.id), { message: 'git.runBranchMissing' })
  assert.equal(existsSync(g.worktree!), false); assert.throws(() => git(f.root, 'rev-parse', '--verify', g.branch))
})
for (const target of ['checked out', 'temporary', 'remote base'] as const) test(`actual run merge into ${target} preserves feature ref and root branch`, async t => {
  const f = fixture(t); const g = (await f.service.ensureRunBranch(f.project, f.run.id))!
  writeFileSync(join(g.worktree!, 'feature.txt'), 'feature'); await f.operations.workflowGit.transaction(f.root, repo => repo.gitCommit(g.worktree!, 'feature'))
  const featureHead = git(f.root, 'rev-parse', g.branch)
  if (target === 'temporary') git(f.root, 'checkout', '-qb', 'other-root')
  if (target === 'remote base') {
    git(f.root, 'remote', 'add', 'origin', f.other); f.store.setRunGit(f.run.id, { base: 'origin/main' })
  }
  assert.deepEqual(await f.service.mergeRunBranch(f.project, f.run.id, 'merge feature'), { kind: 'ok', into: 'main' })
  assert.equal(git(f.root, 'show', 'main:feature.txt'), 'feature'); assert.equal(git(f.root, 'rev-parse', g.branch), featureHead)
  assert.equal(git(f.root, 'branch', '--show-current'), target === 'temporary' ? 'other-root' : 'main')
  if (target === 'temporary') assert.equal(existsSync(join(f.root, 'feature.txt')), false)
})
test('dirty target and nonbranch base block without touching root/files/refs', async t => {
  const f = fixture(t); const g = (await f.service.ensureRunBranch(f.project, f.run.id))!; const head = git(f.root, 'rev-parse', 'HEAD')
  writeFileSync(join(f.root, 'dirty.txt'), 'preserve')
  assert.equal((await f.service.mergeRunBranch(f.project, f.run.id, 'dirty')).kind, 'blocked')
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head); assert.equal(readFileSync(join(f.root, 'dirty.txt'), 'utf8'), 'preserve')
  f.store.setRunGit(f.run.id, { base: head }); assert.equal((await f.service.mergeRunBranch(f.project, f.run.id, 'sha base')).kind, 'blocked')
  assert.equal(git(f.root, 'rev-parse', g.branch), head)
})
test('real conflict aborts merge and retains feature worktree/ref', async t => {
  const f = fixture(t); writeFileSync(join(f.root, 'same.txt'), 'base\n'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'base')
  const g = (await f.service.ensureRunBranch(f.project, f.run.id))!
  writeFileSync(join(g.worktree!, 'same.txt'), 'feature\n'); await f.operations.workflowGit.transaction(f.root, repo => repo.gitCommit(g.worktree!, 'feature'))
  writeFileSync(join(f.root, 'same.txt'), 'main\n'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'main')
  const head = git(f.root, 'rev-parse', 'HEAD'); assert.equal((await f.service.mergeRunBranch(f.project, f.run.id, 'conflict')).kind, 'conflict')
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head); assert.throws(() => git(f.root, 'rev-parse', '--verify', 'MERGE_HEAD'))
  assert.equal(readFileSync(join(g.worktree!, 'same.txt'), 'utf8'), 'feature\n')
})
test('nonforce cleanup preserves dirty work and feature ref; clean idle done sync handles observer reentry', { timeout: 15000 }, async t => {
  const f = fixture(t); const g = (await f.service.ensureRunBranch(f.project, f.run.id))!; const head = git(f.root, 'rev-parse', g.branch)
  writeFileSync(join(g.worktree!, 'dirty.txt'), 'preserve'); assert.equal(await f.service.removeRunWorktree(f.project, f.run.id), false)
  assert.equal(readFileSync(join(g.worktree!, 'dirty.txt'), 'utf8'), 'preserve')
  await f.operations.workflowGit.transaction(f.root, repo => repo.gitCommit(g.worktree!, 'preserve'))
  const sync = new f.service.RunBranchSync({ isAlive: () => false }); const nested: Promise<void>[] = []
  f.store.moveGlobalTask(f.run.id, 'done'); const unsubscribe = f.store.subscribe(() => { nested.push(sync.sync(f.project)) }); t.after(unsubscribe)
  await Promise.all([sync.sync(f.project), sync.sync(f.project)]); await Promise.all(nested)
  assert.equal(existsSync(g.worktree!), false); assert.equal(f.store.getRun(f.run.id)!.git!.worktree, undefined)
  assert.notEqual(git(f.root, 'rev-parse', g.branch), head)
})
test('cleanup skips live/reopened run and remembers dirty refusal until restart', async t => {
  const f = fixture(t); const g = (await f.service.ensureRunBranch(f.project, f.run.id))!
  const live = new f.service.RunBranchSync({ isAlive: () => true }); f.store.moveGlobalTask(f.run.id, 'done'); f.store.setRunPty(f.run.id, 'live')
  await live.sync(f.project); assert.equal(existsSync(g.worktree!), true)
  f.store.coordinatorExited(f.run.id, 'live'); f.store.moveGlobalTask(f.run.id, 'backlog'); await live.sync(f.project); assert.equal(existsSync(g.worktree!), true)
  f.store.moveGlobalTask(f.run.id, 'done'); writeFileSync(join(g.worktree!, 'dirty.txt'), 'preserve')
  const sync = new f.service.RunBranchSync({ isAlive: () => false }); await sync.sync(f.project)
  await f.operations.workflowGit.transaction(f.root, repo => repo.gitCommit(g.worktree!, 'save')); await sync.sync(f.project)
  assert.equal(existsSync(g.worktree!), true)
  await new f.service.RunBranchSync({ isAlive: () => false }).sync(f.project); assert.equal(existsSync(g.worktree!), false)
})
test('scoped head/remotes/checked-out path primitives preserve raw path and nonforce dirty worktree', async t => {
  const f = fixture(t); const wt = join(f.dir, process.platform === 'win32' ? 'with spaces' : 'with\nquote" and spaces')
  await f.operations.workflowGit.transaction(f.root, repo => repo.addTaskWorktree(wt, 'raw-path'))
  git(f.root, 'remote', 'add', 'origin', f.other)
  await f.operations.workflowGit.read(f.root, async repo => {
    assert.equal(await repo.head('refs/heads/raw-path'), git(wt, 'rev-parse', 'HEAD')); assert.equal(await repo.head('missing'), undefined)
    assert.deepEqual(await repo.remotes(), ['origin']); assert.equal(await repo.checkedOutAt('raw-path'), git(wt, 'rev-parse', '--show-toplevel')); assert.equal(await repo.checkedOutAt('missing'), undefined)
    writeFileSync(join(wt, 'dirty.txt'), 'preserve'); assert.equal(await repo.isDirty(wt), true)
  })
  assert.equal(await f.operations.workflowGit.transaction(f.root, repo => repo.removeCleanWorktree(wt)), false)
  assert.equal(readFileSync(join(wt, 'dirty.txt'), 'utf8'), 'preserve')
})
test('held worktree hook allows heartbeat/other repo; replaced run metadata cannot overwrite new binding', { timeout: 15000 }, async t => {
  const f = fixture(t); const gate = commitGate(t, f.dir, f.root); renameSync(join(f.dir, 'hooks', 'pre-commit'), join(f.dir, 'hooks', 'post-checkout'))
  let ticks = 0; const timer = setInterval(() => ticks++, 5); t.after(() => clearInterval(timer))
  const pending = f.service.ensureRunBranch(f.project, f.run.id); const failed = assert.rejects(pending, stale)
  await gate.entered(); const other = { ...f.project, id: 'other', root: f.other, store: new TaskStore() }; const run = other.store.createGlobalTask({ title: 'parallel' })
  assert.ok((await f.service.ensureRunBranch(other, run.id))?.worktree); assert.ok(ticks > 0)
  const following = f.operations.projectFetch(f.alias)
  f.store.setRunGit(f.run.id, { branch: 'replacement', base: 'main' }); gate.release(); await failed; await following
  assert.equal(f.store.getRun(f.run.id)!.git!.branch, 'replacement'); assert.equal(git(f.root, 'branch', '--show-current'), 'main')
})
test('sibling feature Git metadata preparation does not invalidate the domain lane token', t => {
  const effects = runtime.createEffectScopeService(); t.after(() => effects.stop())
  const store = new TaskStore(); const global = store.createGlobalTask({ title: 'fork' }); const run = store.getRun(global.id)!
  run.stage = { nodeId: 'fork', visits: { fork: 1, left: 1 } }
  run.lanes = [{ id: 'fork:left', forkId: 'fork', branchId: 'left', forkVisit: 1, nodeId: 'left' }]
  const scope = effects.capture({ id: 'P', root: '/fixture', store }, { runId: run.id, laneId: 'fork:left' })
  store.setRunGit(run.id, { branch: 'feature/one', base: 'main', worktree: '/fixture/feature' })
  assert.equal(scope.commit(() => 'current'), 'current')
})
test('concurrent feature preparation shares actual worktree/ref and each caller gets the same binding', async t => {
  const f = fixture(t)
  const [first, second] = await Promise.all([f.service.ensureRunBranch(f.project, f.run.id), f.service.ensureRunBranch(f.project, f.run.id)])
  assert.deepEqual(first, second); assert.ok(first?.worktree)
  assert.equal(git(first.worktree, 'branch', '--show-current'), first.branch)
  assert.equal(f.store.getRun(f.run.id)!.git!.worktree, first.worktree)
})
test('rejected cleanup capture does not retain pending flag that skips future authorized cleanup', async t => {
  const f = fixture(t); const g = (await f.service.ensureRunBranch(f.project, f.run.id))!; f.store.moveGlobalTask(f.run.id, 'done')
  let allowed = false; const project = { ...f.project, isCurrent: () => allowed }
  const sync = new f.service.RunBranchSync({ isAlive: () => false })
  await assert.rejects(sync.sync(project), stale); assert.equal(existsSync(g.worktree!), true)
  allowed = true; await sync.sync(project)
  assert.equal(existsSync(g.worktree!), false); assert.equal(f.store.getRun(f.run.id)!.git!.worktree, undefined)
})
