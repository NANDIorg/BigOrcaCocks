import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'
import { gitQueueFixture, git, commitGate } from './git-queue-fixture.ts'

function fixture(t: TestContext) {
  const processes = runtime.createGitProcessService(); t.after(() => processes.stop())
  const f = gitQueueFixture(t)
  const operations = runtime.createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'untracked' }, f.queue, processes)
  assert.equal(typeof operations.workflowGit?.transaction, 'function', 'Отсутствует scoped async Git workflow service')
  return { ...f, operations, service: operations.workflowGit }
}

test('scoped branch/worktree/commit/review/merge/cleanup executes actual effects without nested queue', { timeout: 15000 }, async t => {
  const f = fixture(t); const wt = join(f.dir, 'task')
  await f.service.transaction(f.root, async repo => {
    assert.equal(await repo.currentBranch(), 'main'); assert.equal(await repo.headBase(), 'main')
    await repo.gitCreateBranch(wt, 'feature/task', undefined, false)
    writeFileSync(join(wt, 'result.txt'), 'result')
    await repo.commitWorktree(wt, 'result')
    const review = await repo.reviewInfo(wt, 'feature/task'); assert.equal(review.base, 'main'); assert.equal(review.commits.length, 1); assert.equal(review.dirty, false)
    await repo.mergeBranch(f.root, 'feature/task', 'merge task')
    await repo.removeWorktree(wt, 'feature/task')
  })
  assert.equal(readFileSync(join(f.root, 'result.txt'), 'utf8'), 'result'); assert.equal(existsSync(wt), false)
  assert.throws(() => git(f.root, 'rev-parse', '--verify', 'refs/heads/feature/task'))
})
test('scoped reads preserve unborn/detached and unborn branch cannot create orphan worktree', async t => {
  const f = fixture(t); const wt = join(f.dir, 'orphan')
  assert.equal(await f.service.read(f.unborn, repo => repo.hasCommits()), false)
  await assert.rejects(f.service.transaction(f.unborn, repo => repo.addTaskWorktree(wt, 'topic')), { message: 'git.noCommits' })
  assert.equal(existsSync(wt), false); assert.throws(() => git(f.unborn, 'rev-parse', '--verify', 'refs/heads/topic'))
  const head = git(f.root, 'rev-parse', 'HEAD'); git(f.root, 'checkout', '-q', '--detach')
  await f.service.read(f.root, async repo => { assert.equal(await repo.currentBranch(), 'HEAD'); assert.equal(await repo.headBase(), head) })
})
test('actual conflicting merge aborts index and preserves both branches/worktree', async t => {
  const f = fixture(t); const wt = join(f.dir, 'conflict')
  writeFileSync(join(f.root, 'same.txt'), 'base\n'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'base')
  await f.service.transaction(f.root, async repo => {
    await repo.addTaskWorktree(wt, 'topic'); writeFileSync(join(wt, 'same.txt'), 'topic\n'); await repo.gitCommit(wt, 'topic')
  })
  writeFileSync(join(f.root, 'same.txt'), 'main\n'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'main')
  const before = git(f.root, 'rev-parse', 'HEAD')
  await assert.rejects(f.service.transaction(f.root, repo => repo.mergeBranch(f.root, 'topic', 'merge')),
    e => e instanceof runtime.MergeError && e.conflict)
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before); assert.equal(git(f.root, 'diff', '--name-only', '--diff-filter=U'), '')
  assert.throws(() => git(f.root, 'rev-parse', '--verify', 'MERGE_HEAD')); assert.equal(readFileSync(join(wt, 'same.txt'), 'utf8'), 'topic\n')
})
test('dirty checkout preserves bytes; foreign worktree cleanup preserves branch/ref', async t => {
  const f = fixture(t); const wt = join(f.dir, 'foreign'); git(f.root, 'branch', 'foreign'); git(f.root, 'branch', 'next')
  const head = git(f.root, 'rev-parse', 'foreign')
  await f.service.transaction(f.root, repo => repo.addTaskWorktree(wt, 'foreign'))
  writeFileSync(join(wt, 'dirty.txt'), 'keep')
  await assert.rejects(f.service.transaction(f.root, repo => repo.gitCheckout(wt, 'next')), runtime.GitOpError)
  assert.equal(readFileSync(join(wt, 'dirty.txt'), 'utf8'), 'keep'); assert.equal(git(wt, 'branch', '--show-current'), 'foreign')
  await f.service.transaction(f.root, repo => repo.removeWorktree(wt, 'foreign', true))
  assert.equal(existsSync(wt), false); assert.equal(git(f.root, 'rev-parse', 'foreign'), head)
})
test('held transaction shares owner queue with aliases/project fetch; stale guard prevents following effect', { timeout: 15000 }, async t => {
  const f = fixture(t); const gate = commitGate(t, f.dir, f.root); const late = join(f.dir, 'late'); let current = true
  writeFileSync(join(f.root, 'saved.txt'), 'external effect')
  const pending = f.service.transaction(f.root, async repo => { await repo.gitCommit(f.root, 'held'); await repo.gitCreateBranch(late, 'late', undefined, false) },
    { guard: () => { if (!current) throw new runtime.CommandError('command.stale') } })
  const failed = assert.rejects(pending, e => e instanceof runtime.CommandError && e.code === 'command.stale')
  await gate.entered(); let fetched = false
  const fetch = f.operations.projectFetch(f.alias).then(() => { fetched = true })
  const alias = f.service.transaction(f.linked, repo => repo.addTaskWorktree(join(f.dir, 'alias-next'), 'alias-next'))
  await f.service.transaction(f.other, repo => repo.addTaskWorktree(join(f.dir, 'parallel'), 'parallel'))
  assert.equal(fetched, false); assert.equal(existsSync(join(f.dir, 'alias-next')), false)
  current = false; gate.release(); await failed; await Promise.all([fetch, alias])
  assert.equal(git(f.root, 'show', 'HEAD:saved.txt'), 'external effect'); assert.equal(existsSync(late), false)
  assert.throws(() => git(f.root, 'rev-parse', '--verify', 'refs/heads/late')); assert.equal(fetched, true)
})
test('scoped push updates actual local bare remote and upstream without force', async t => {
  const f = fixture(t); const remote = join(f.dir, 'remote.git'); const wt = join(f.dir, 'push')
  git(f.dir, 'init', '--bare', '-q', remote); git(f.root, 'remote', 'add', 'origin', remote)
  await f.service.transaction(f.root, async repo => { await repo.gitCreateBranch(wt, 'topic', undefined, false); await repo.gitPush(wt, 'origin', 'topic') })
  assert.equal(git(remote, 'rev-parse', 'refs/heads/topic'), git(wt, 'rev-parse', 'HEAD'))
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'), 'origin/topic')
})
test('escaped scoped port cannot mutate after transaction releases owner queue', async t => {
  const f = fixture(t); let escaped: runtime.GitWorkflowRepository | undefined
  await f.service.transaction(f.root, async repo => { escaped = repo })
  assert.ok(escaped)
  await assert.rejects(escaped.addTaskWorktree(join(f.dir, 'escaped'), 'escaped'))
  assert.equal(existsSync(join(f.dir, 'escaped')), false); assert.throws(() => git(f.root, 'rev-parse', '--verify', 'refs/heads/escaped'))
})
test('scoped mutation in another repo is rejected before touching its HEAD/refs', async t => {
  const f = fixture(t); const before = git(f.other, 'rev-parse', 'HEAD'); git(f.other, 'checkout', '-qb', 'candidate')
  writeFileSync(join(f.other, 'foreign.txt'), 'foreign commit'); git(f.other, 'add', '.'); git(f.other, 'commit', '-qm', 'candidate')
  const candidate = git(f.other, 'rev-parse', 'HEAD'); git(f.other, 'checkout', '-q', 'main')
  await assert.rejects(f.service.transaction(f.root, repo => repo.mergeBranch(f.other, 'candidate', 'foreign')))
  assert.equal(git(f.other, 'rev-parse', 'HEAD'), before); assert.equal(git(f.other, 'rev-parse', 'candidate'), candidate)
  assert.equal(existsSync(join(f.other, 'foreign.txt')), false)
})
test('review rejects unrelated history instead of reporting zero commits eligible for cleanup', async t => {
  const f = fixture(t); const wt = join(f.dir, 'review-failure')
  git(f.root, 'checkout', '-q', '--orphan', 'topic')
  writeFileSync(join(f.root, 'valuable.txt'), 'valuable'); git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'disconnected')
  git(f.root, 'checkout', '-q', 'main')
  await f.service.transaction(f.root, repo => repo.addTaskWorktree(wt, 'topic'))
  await assert.rejects(f.service.read(f.root, repo => repo.reviewInfo(wt, 'topic')), e => e instanceof runtime.GitProcessError && /merge base/.test(e.stderr))
  assert.equal(readFileSync(join(wt, 'valuable.txt'), 'utf8'), 'valuable')
  const missing = await f.service.read(f.root, repo => repo.reviewInfo(wt, 'missing'))
  assert.deepEqual(missing.commits, []); assert.equal(missing.dirty, false)
})
