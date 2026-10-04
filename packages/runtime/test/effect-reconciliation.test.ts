import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '@orca-board/core'
import * as runtime from '../src/index.ts'

test('reconciliation видит dirty foreign/orphan worktree и старую task generation без мутаций', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-reconcile-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'repo'); const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
  execFileSync('git', ['init', '-q', '-b', 'main', root]); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@local')
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'initial')
  const orphan = join(dir, 'foreign'); git('worktree', 'add', '-q', '-b', 'foreign', orphan); writeFileSync(join(orphan, 'keep.txt'), 'keep')
  const store = new TaskStore(); const task = store.createTask({ title: 'task' })
  const journal = runtime.createEffectJournal({ dataDir: join(dir, 'profile'), ownerId: 'old' })
  journal.begin({ projectId: 'p', repoRoot: root, taskId: task.id, taskCreatedAt: task.createdAt - 1 }, { kind: 'git', operation: 'worktree', cwd: root })
  const before = readFileSync(join(dir, 'profile', 'effect-journal.json'), 'utf8'); const refs = git('show-ref')
  const processes = runtime.createGitProcessService(); t.after(() => processes.stop())
  const report = await runtime.inspectEffectRecovery(journal, { id: 'p', root, store }, processes)
  assert.equal(report.records.length, 1); assert.equal(report.records[0].current, false)
  const worktree = report.worktrees.find(w => realpathSync.native(w.path) === realpathSync.native(orphan))!
  assert.equal(worktree.branch, 'foreign'); assert.equal(worktree.dirty, true); assert.equal(worktree.referenced, false)
  assert.equal(readFileSync(join(orphan, 'keep.txt'), 'utf8'), 'keep'); assert.equal(git('show-ref'), refs)
  assert.equal(readFileSync(join(dir, 'profile', 'effect-journal.json'), 'utf8'), before)
  // Git и metadata могут представлять один каталог разными строками (Windows slash/8.3).
  const alternate = `${realpathSync.native(root)}/../repo`
  const spelling: runtime.GitProcessService = { stop: processes.stop, async run(cwd, args, options) {
    const result = await processes.run(cwd, args, options)
    return args[0] === 'worktree' ? { ...result, stdout: result.stdout.replace(/^worktree [^\0]+/, `worktree ${alternate}`) } : result
  } }
  const sameResources = await runtime.inspectEffectRecovery(journal, { id: 'p', root, store }, spelling)
  assert.equal(sameResources.worktrees[0].referenced, true)
  await processes.stop(); await assert.rejects(runtime.inspectEffectRecovery(journal, { id: 'p', root, store }, processes), e => e instanceof runtime.GitProcessError && e.cancelled)
})
