import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGitOperations, createGitProcessService, GitProcessError } from '../src/index.ts'
import { gitQueueFixture, git, commitGate } from './git-queue-fixture.ts'
import { until } from './conversation-fixture.ts'

test('compatibility Git aliases preserve heartbeat and one commonDir queue during actual hook', { timeout: 15000 }, async t => {
  const f = gitQueueFixture(t); const processes = createGitProcessService(); t.after(() => processes.stop())
  const ops = createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'untracked' }, f.queue, processes)
  writeFileSync(join(f.root, 'answer.txt'), 'answer'); const hook = commitGate(t, f.dir, f.root)
  const pending = ops.commitWorktree(f.root, 'compatibility commit')
  assert.ok(pending instanceof Promise, 'Git alias должен возвращать Promise до завершения hook')
  await hook.entered(); let beats = 0; let queuedFinished = false
  const timer = setInterval(() => beats++, 5); t.after(() => clearInterval(timer))
  const queued = ops.gitCreateBranch(f.alias, join(f.dir, 'queued'), 'queued', 'main', false).then(() => { queuedFinished = true })
  await ops.gitCreateBranch(f.other, join(f.dir, 'parallel'), 'parallel', 'main', false)
  await until(() => beats > 0)
  assert.equal(queuedFinished, false); assert.equal(git(f.other, 'rev-parse', 'parallel'), git(f.other, 'rev-parse', 'main'))
  hook.release(); await pending; await queued
  assert.equal(git(f.root, 'show', 'HEAD:answer.txt'), 'answer')
  assert.equal(git(f.root, 'rev-parse', 'queued'), git(f.root, 'rev-parse', 'HEAD'))
})
test('compatibility read refuses stopped process owner instead of returning false or metadata', async t => {
  const f = gitQueueFixture(t); const processes = createGitProcessService(); t.after(() => processes.stop())
  const ops = createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'untracked' }, f.queue, processes)
  const result = ops.hasCommits(f.unborn)
  assert.ok(result instanceof Promise); assert.equal(await result, false)
  await processes.stop()
  await assert.rejects(ops.hasCommits(f.unborn), e => e instanceof GitProcessError && e.cancelled)
  await assert.rejects(ops.projectBranchInfo(f.root), e => e instanceof GitProcessError && e.cancelled)
  assert.equal(git(f.root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
})
