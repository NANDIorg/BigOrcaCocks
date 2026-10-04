import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'
import { gitQueueFixture, git, asyncGit, deferred, commitGate } from './git-queue-fixture.ts'
import { until } from './conversation-fixture.ts'
import { profileFixture, operator } from './profile-command-test-host.ts'

test('root/linked worktree/symlink resolve one canonical commonDir', async t => {
  const f = gitQueueFixture(t); const expected = realpathSync(join(f.root, '.git'))
  assert.deepEqual(await Promise.all([f.root, f.linked, f.alias].map(root => runtime.canonicalGitCommonDir(root))), [expected, expected, expected])
  assert.notEqual(await runtime.canonicalGitCommonDir(f.other), expected)
})
test('one repo FIFO across aliases; independent repo mutation proceeds while first waits', async t => {
  const f = gitQueueFixture(t); const release = deferred(); const entered = deferred()
  const [a, linked, alias, b] = await Promise.all([f.root, f.linked, f.alias, f.other].map(root => runtime.canonicalGitCommonDir(root)))
  t.after(release.resolve)
  const first = f.queue.enqueue(a, async () => { entered.resolve(); await release.promise; await asyncGit(f.root, 'update-ref', 'refs/heads/first', 'HEAD') })
  await entered.promise
  const second = f.queue.enqueue(linked, () => asyncGit(f.linked, 'update-ref', 'refs/heads/second', 'refs/heads/first'))
  const third = f.queue.enqueue(alias, () => asyncGit(f.alias, 'update-ref', 'refs/heads/third', 'refs/heads/second'))
  await f.queue.enqueue(b, () => asyncGit(f.other, 'update-ref', 'refs/heads/parallel', 'HEAD'))
  assert.equal(git(f.other, 'rev-parse', 'parallel'), git(f.other, 'rev-parse', 'HEAD'))
  assert.throws(() => git(f.root, 'rev-parse', '--verify', 'first')); assert.throws(() => git(f.root, 'rev-parse', '--verify', 'second'))
  release.resolve(); await Promise.all([first, second, third])
  assert.equal(git(f.root, 'rev-parse', 'third'), git(f.root, 'rev-parse', 'HEAD'))
})
test('failed actual Git operation releases queue for next ref mutation', async t => {
  const f = gitQueueFixture(t); const key = await runtime.canonicalGitCommonDir(f.root)
  const failed = f.queue.enqueue(key, () => asyncGit(f.root, 'merge', 'missing-branch'))
  const next = f.queue.enqueue(key, () => asyncGit(f.root, 'update-ref', 'refs/heads/after-failure', 'HEAD'))
  await assert.rejects(failed); await next
  assert.equal(git(f.root, 'rev-parse', 'after-failure'), git(f.root, 'rev-parse', 'HEAD'))
})
test('actual blocked Git hook preserves heartbeat/session output and independent repo progress', async t => {
  const f = gitQueueFixture(t); const gate = commitGate(t, f.dir, f.unborn)
  const operations = runtime.createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'untracked' }, f.queue)
  const pending = operations.createInitialCommit(f.unborn, 'snapshot')
  await gate.entered()
  const sessions = runtime.createSessionRegistry({ spawn: () => { let output: (data: string) => void = () => {}; return {
    onData: fn => { output = fn }, onExit: () => {}, write: data => output(data), resize: () => {}, kill: () => {} } } })
  t.after(sessions.killAll); const ptyId = sessions.spawnPty({ cols: 80, rows: 24, meta: { role: 'shell', label: 'heartbeat' } })
  await new Promise<void>(resolve => setTimeout(() => { sessions.writePty(ptyId, 'alive'); resolve() }, 10))
  assert.equal(sessions.ptyTail(ptyId), 'alive'); assert.equal((await operations.hasCommits(f.unborn)), false)
  await f.queue.enqueue(await runtime.canonicalGitCommonDir(f.other), () => asyncGit(f.other, 'update-ref', 'refs/heads/independent', 'HEAD'))
  assert.equal(git(f.other, 'rev-parse', 'independent'), git(f.other, 'rev-parse', 'HEAD'))
  gate.release(); await pending; assert.equal((await operations.hasCommits(f.unborn)), true)
})
test('Git factory rejects invalid/missing repo with existing domain error before mutation', async t => {
  const f = gitQueueFixture(t); const plain = join(f.dir, 'plain'); mkdirSync(plain)
  const operations = runtime.createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'untracked' }, f.queue)
  for (const root of [plain, join(f.dir, 'missing')]) await assert.rejects(operations.createInitialCommit(root, 'empty'), { message: 'git.notRepo' })
})
test('factory project mutations use owner queue; stale principal cannot commit after waiting', async t => {
  const f = gitQueueFixture(t); const profile = profileFixture(); t.after(profile.close)
  const project = profile.manager.add(f.unborn); const release = deferred(); const entered = deferred(); const admitted: string[] = []
  t.after(release.resolve)
  const key = await runtime.canonicalGitCommonDir(f.unborn)
  const first = f.queue.enqueue(key, async () => { entered.resolve(); await release.promise }); await entered.promise
  const operations = runtime.createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'untracked' }, {
    enqueue: (key, operation) => { admitted.push(key); return f.queue.enqueue(key, operation) }
  })
  let allowed = true
  const commands = runtime.createProjectGitCommands({ authorize: () => allowed, project: id => profile.manager.get(id),
    isCurrent: p => profile.manager.get(p.id) === p, git: operations, liveAgents: () => 0 })
  const pending = commands.initialCommit({ ...operator, projectId: project.id }, 'empty')
  await until(() => admitted.length > 0); assert.equal(admitted[0], realpathSync(join(f.unborn, '.git')))
  assert.equal((await operations.hasCommits(f.unborn)), false); allowed = false; release.resolve(); await first
  await assert.rejects(pending, e => e instanceof runtime.CommandError && e.code === 'command.forbidden')
  assert.equal((await operations.hasCommits(f.unborn)), false); assert.equal(git(f.unborn, 'ls-files', '--stage'), '')
})
