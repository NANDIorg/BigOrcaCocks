import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { addTaskWorktree, assertHasCommits, currentBranch, gitCreateBranch, GitOpError, hasCommits, headBase, projectBranchInfo } from './git'
import { OrcaError } from './i18n'

// Фикстуры — только во временной папке, не в рабочем репозитории.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
}

test('projectBranchInfo: не репозиторий', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-nogit-'))
  assert.deepEqual((await projectBranchInfo(dir)), { isGitRepo: false, branch: null, detached: false })
})

test('projectBranchInfo: ветка, репозиторий без коммитов и detached HEAD', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-git-'))
  git(dir, 'init', '-b', 'main')
  assert.deepEqual((await projectBranchInfo(dir)), { isGitRepo: true, branch: 'main', detached: false, unborn: true })
  writeFileSync(join(dir, 'a.txt'), 'a')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'init')
  git(dir, 'checkout', '-b', 'feature/x')
  assert.deepEqual((await projectBranchInfo(dir)), { isGitRepo: true, branch: 'feature/x', detached: false })
  const sha = git(dir, 'rev-parse', '--short', 'HEAD')
  git(dir, 'checkout', '--detach')
  assert.deepEqual((await projectBranchInfo(dir)), { isGitRepo: true, branch: null, detached: true, sha })
})

test('projectBranchInfo: папка проекта удалена — не исключение', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'orca-gone-')), 'missing')
  assert.deepEqual((await projectBranchInfo(dir)), { isGitRepo: false, branch: null, detached: false })
})

test('projectBranchInfo: git недоступен (пустой PATH) — не исключение', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-nopath-'))
  const saved = process.env.PATH
  process.env.PATH = ''
  try {
    assert.deepEqual((await projectBranchInfo(dir)), { isGitRepo: false, branch: null, detached: false })
  } finally {
    process.env.PATH = saved
  }
})

test('currentBranch и hasCommits: unborn, ветка, detached, не репозиторий', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-git-'))
  git(dir, 'init', '-b', 'main')
  assert.equal((await currentBranch(dir)), 'main', 'unborn HEAD — имя ветки, а не падение rev-parse')
  assert.equal((await hasCommits(dir)), false)
  await assert.rejects(async () => (await assertHasCommits(dir)), (e: unknown) => e instanceof OrcaError && e.key === 'git.noCommits' && e.message.includes('«main»'))
  writeFileSync(join(dir, 'a.txt'), 'a')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'init')
  assert.equal((await hasCommits(dir)), true)
  await assert.doesNotReject(async () => (await assertHasCommits(dir)))
  git(dir, 'checkout', '-b', 'feature/x')
  assert.equal((await currentBranch(dir)), 'feature/x')
  assert.equal((await headBase(dir)), 'feature/x')
  git(dir, 'checkout', '--detach')
  assert.equal((await currentBranch(dir)), 'HEAD')
  assert.equal((await headBase(dir)), git(dir, 'rev-parse', 'HEAD'), 'detached — хеш коммита')
  assert.equal((await hasCommits(dir)), true)

  const nogit = mkdtempSync(join(tmpdir(), 'orca-nogit-'))
  await assert.rejects(async () => (await currentBranch(nogit)), 'не репозиторий — не превращается в HEAD')
  await assert.rejects(async () => (await hasCommits(nogit)))
})

test('addTaskWorktree: без коммитов — git.noCommits и никакой сироты; с коммитом — ветка от HEAD', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-git-'))
  git(dir, 'init', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a')
  const wt = join(dir, '..', `${basename(dir)}-wt`)
  await assert.rejects(async () => (await addTaskWorktree(dir, wt, 'orca/t1')), (e: unknown) => e instanceof OrcaError && e.key === 'git.noCommits')
  assert.equal(existsSync(wt), false)
  assert.equal(git(dir, 'branch', '--list', 'orca/t1'), '')
  await assert.rejects(async () => (await gitCreateBranch(dir, wt, 'feature/y', undefined, false)), (e: unknown) => e instanceof GitOpError && /нет ни одного коммита/.test(e.message))

  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'init')
  await addTaskWorktree(dir, wt, 'orca/t1')
  assert.equal(existsSync(join(wt, 'a.txt')), true)
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'orca/t1')
})
