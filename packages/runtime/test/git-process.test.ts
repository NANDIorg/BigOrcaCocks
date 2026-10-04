import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as runtime from '../src/index.ts'
import { gitQueueFixture, git } from './git-queue-fixture.ts'
import { heldGitHook, pidAlive } from './git-process-fixture.ts'
import { until } from './conversation-fixture.ts'

function processes(t: { after(fn: () => Promise<void>): void }) {
  assert.equal(typeof runtime.createGitProcessService, 'function', 'Отсутствует общий GitProcessService')
  const service = runtime.createGitProcessService(); t.after(() => service.stop()); return service
}
const commit = ['commit', '-q', '--allow-empty', '-m', 'held']

test('async Git hook preserves heartbeat and independent repo then abort kills owned descendants', async t => {
  const service = processes(t); const f = gitQueueFixture(t); const hook = heldGitHook(f.dir, f.unborn, 'abort')
  const control = new AbortController()
  const pending = service.run(f.unborn, commit, { signal: control.signal })
  const failed = assert.rejects(pending, e => e instanceof runtime.GitProcessError && e.cancelled && !e.timedOut)
  const pids = await hook.entered(); assert.equal(pids.length, 2); assert.ok(pids.every(pidAlive))
  let beats = 0; const timer = setInterval(() => beats++, 5); t.after(() => clearInterval(timer))
  await service.run(f.other, ['update-ref', 'refs/heads/parallel', 'HEAD'])
  await until(() => beats > 0); assert.equal(git(f.other, 'rev-parse', 'parallel'), git(f.other, 'rev-parse', 'HEAD'))
  assert.equal(git(f.unborn, 'ls-files'), ''); const cancelledAt = Date.now(); control.abort(); await failed
  assert.ok(Date.now() - cancelledAt < 2000, 'Отмена должна завершить hook до его собственного deadline 6 с')
  await until(() => pids.every(pid => !pidAlive(pid))); assert.throws(() => git(f.unborn, 'rev-parse', '--verify', 'HEAD'))
})
test('Git timeout kills hook tree and releases commonDir for next actual mutation', async t => {
  const service = processes(t); const f = gitQueueFixture(t); const hook = heldGitHook(f.dir, f.unborn, 'timeout')
  const key = await runtime.canonicalGitCommonDir(f.unborn)
  const startedAt = Date.now()
  const pending = f.queue.enqueue(key, () => service.run(f.unborn, commit, { timeoutMs: 1000 }))
  const failed = assert.rejects(pending, e => e instanceof runtime.GitProcessError && e.timedOut && e.killed && !e.cancelled)
  const pids = await hook.entered(); await failed
  assert.ok(Date.now() - startedAt < 3000, 'Таймаут должен остановить дерево, а не ждать deadline hook')
  await until(() => pids.every(pid => !pidAlive(pid)))
  await f.queue.enqueue(key, () => service.run(f.unborn, ['hash-object', '-w', '--stdin'], { input: 'after timeout' }))
  assert.throws(() => git(f.unborn, 'rev-parse', '--verify', 'HEAD'))
})
test('already cancelled Git has no effect; stop is idempotent and rejects new commands', async t => {
  const service = processes(t); const f = gitQueueFixture(t); const control = new AbortController(); control.abort()
  await assert.rejects(service.run(f.unborn, commit, { signal: control.signal }), e => e instanceof runtime.GitProcessError && e.cancelled)
  await service.stop(); await service.stop()
  await assert.rejects(service.run(f.unborn, commit), e => e instanceof runtime.GitProcessError && e.cancelled)
  assert.throws(() => git(f.unborn, 'rev-parse', '--verify', 'HEAD'))
})
test('owner stop waits for all active Git hook trees and keeps unrelated Git repo usable', async t => {
  const service = processes(t); const f = gitQueueFixture(t)
  const a = heldGitHook(f.dir, f.root, 'stop-a'); const b = heldGitHook(f.dir, f.other, 'stop-b')
  const first = service.run(f.root, commit); const second = service.run(f.other, commit)
  const failed = Promise.all([first, second].map(p => assert.rejects(p, e => e instanceof runtime.GitProcessError && e.cancelled)))
  const pids = (await Promise.all([a.entered(), b.entered()])).flat()
  const before = git(f.root, 'rev-parse', 'HEAD'); const stoppedAt = Date.now(); await service.stop(); await failed
  assert.ok(Date.now() - stoppedAt < 2000, 'stop должен завершить все деревья до deadline hooks')
  await until(() => pids.every(pid => !pidAlive(pid))); assert.equal(git(f.root, 'rev-parse', 'HEAD'), before)
  assert.equal(git(f.linked, 'rev-parse', '--is-inside-work-tree'), 'true')
})
test('stdin closes for Git hash-object and early Git failure consumes large input without uncaught EPIPE', async t => {
  const service = processes(t); const f = gitQueueFixture(t)
  const hash = await service.run(f.root, ['hash-object', '-w', '--stdin'], { input: 'hello\n' })
  assert.equal(hash.stdout.trim(), 'ce013625030ba8dba906f756967f9e9ca394464a'); assert.equal(hash.code, 0)
  const empty = await service.run(f.root, ['hash-object', '--stdin'])
  assert.equal(empty.stdout.trim(), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  await assert.rejects(service.run(f.root, ['definitely-invalid-orca-command'], { input: 'x'.repeat(2 * 1024 * 1024) }),
    e => e instanceof runtime.GitProcessError && e.code === 1 && !e.cancelled && !e.killed)
})
test('allowed Git exit 1 preserves output while ordinary errors retain actual stderr/code', async t => {
  const service = processes(t); const f = gitQueueFixture(t)
  const result = await service.run(f.unborn, ['rev-parse', '--verify', '--quiet', 'HEAD'], { acceptedExitCodes: [1] })
  assert.deepEqual(result, { stdout: '', stderr: '', code: 1 })
  await assert.rejects(service.run(f.root, ['rev-parse', '--verify', 'missing']),
    e => e instanceof runtime.GitProcessError && e.code === 128 && e.stderr.length > 0 && !e.killed)
})
test('Git output limit is bounded and following command still runs', async t => {
  const service = processes(t); const f = gitQueueFixture(t); writeFileSync(join(f.root, 'large'), 'x'.repeat(10000))
  const sha = git(f.root, 'hash-object', '-w', 'large')
  await assert.rejects(service.run(f.root, ['cat-file', 'blob', sha], { maxBuffer: 64 }),
    e => e instanceof runtime.GitProcessError && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && e.stdout.length <= 64)
  assert.equal((await service.run(f.root, ['rev-parse', '--is-inside-work-tree'])).stdout.trim(), 'true')
})
test('actual Git factory consumes owned process service and preserves stop cancellation instead of timeout', async t => {
  const service = processes(t); const f = gitQueueFixture(t); const hook = heldGitHook(f.dir, f.unborn, 'factory')
  const operations = runtime.createGitOperations({ error: key => new Error(key), untrackedLabel: () => 'untracked' }, f.queue, service)
  const pending = operations.createInitialCommit(f.unborn, 'snapshot')
  const failed = assert.rejects(pending, e => e instanceof runtime.GitProcessError && e.cancelled && !e.timedOut)
  const pids = await hook.entered(); await service.stop(); await failed
  await until(() => pids.every(pid => !pidAlive(pid))); assert.throws(() => git(f.unborn, 'rev-parse', '--verify', 'HEAD'))
  await assert.rejects(operations.projectFetch(f.root), e => e instanceof runtime.GitProcessError && e.cancelled)
})
