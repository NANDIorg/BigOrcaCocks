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

test('projectBranchInfo: не репозиторий', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-nogit-'))
  assert.deepEqual(projectBranchInfo(dir), { isGitRepo: false, branch: null, detached: false })
})

test('projectBranchInfo: ветка, репозиторий без коммитов и detached HEAD', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-git-'))
  git(dir, 'init', '-b', 'main')
  assert.deepEqual(projectBranchInfo(dir), { isGitRepo: true, branch: 'main', detached: false, unborn: true })
  writeFileSync(join(dir, 'a.txt'), 'a')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'init')
  git(dir, 'checkout', '-b', 'feature/x')
  assert.deepEqual(projectBranchInfo(dir), { isGitRepo: true, branch: 'feature/x', detached: false })
  const sha = git(dir, 'rev-parse', '--short', 'HEAD')
  git(dir, 'checkout', '--detach')
  assert.deepEqual(projectBranchInfo(dir), { isGitRepo: true, branch: null, detached: true, sha })
})

test('projectBranchInfo: папка проекта удалена — не исключение', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'orca-gone-')), 'missing')
  assert.deepEqual(projectBranchInfo(dir), { isGitRepo: false, branch: null, detached: false })
})

test('projectBranchInfo: git недоступен (пустой PATH) — не исключение', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-nopath-'))
  const saved = process.env.PATH
  process.env.PATH = ''
  try {
    assert.deepEqual(projectBranchInfo(dir), { isGitRepo: false, branch: null, detached: false })
  } finally {
    process.env.PATH = saved
  }
})

test('currentBranch и hasCommits: unborn, ветка, detached, не репозиторий', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-git-'))
  git(dir, 'init', '-b', 'main')
  assert.equal(currentBranch(dir), 'main', 'unborn HEAD — имя ветки, а не падение rev-parse')
  assert.equal(hasCommits(dir), false)
  assert.throws(() => assertHasCommits(dir), (e: unknown) => e instanceof OrcaError && e.key === 'git.noCommits' && e.message.includes('«main»'))
  writeFileSync(join(dir, 'a.txt'), 'a')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'init')
  assert.equal(hasCommits(dir), true)
  assert.doesNotThrow(() => assertHasCommits(dir))
  git(dir, 'checkout', '-b', 'feature/x')
  assert.equal(currentBranch(dir), 'feature/x')
  assert.equal(headBase(dir), 'feature/x')
  git(dir, 'checkout', '--detach')
  assert.equal(currentBranch(dir), 'HEAD')
  assert.equal(headBase(dir), git(dir, 'rev-parse', 'HEAD'), 'detached — хеш коммита')
  assert.equal(hasCommits(dir), true)

  const nogit = mkdtempSync(join(tmpdir(), 'orca-nogit-'))
  assert.throws(() => currentBranch(nogit), 'не репозиторий — не превращается в HEAD')
  assert.throws(() => hasCommits(nogit))
})

test('addTaskWorktree: без коммитов — git.noCommits и никакой сироты; с коммитом — ветка от HEAD', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-git-'))
  git(dir, 'init', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a')
  const wt = join(dir, '..', `${basename(dir)}-wt`)
  assert.throws(() => addTaskWorktree(dir, wt, 'orca/t1'), (e: unknown) => e instanceof OrcaError && e.key === 'git.noCommits')
  assert.equal(existsSync(wt), false)
  assert.equal(git(dir, 'branch', '--list', 'orca/t1'), '')
  assert.throws(() => gitCreateBranch(dir, wt, 'feature/y', undefined, false), (e: unknown) => e instanceof GitOpError && /нет ни одного коммита/.test(e.message))

  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'init')
  addTaskWorktree(dir, wt, 'orca/t1')
  assert.equal(existsSync(join(wt, 'a.txt')), true)
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'orca/t1')
})
