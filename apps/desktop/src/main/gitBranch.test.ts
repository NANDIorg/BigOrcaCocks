import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectBranchInfo } from './git'

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
  assert.deepEqual(projectBranchInfo(dir), { isGitRepo: true, branch: 'main', detached: false })
  writeFileSync(join(dir, 'a.txt'), 'a')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'init')
  git(dir, 'checkout', '-b', 'feature/x')
  assert.deepEqual(projectBranchInfo(dir), { isGitRepo: true, branch: 'feature/x', detached: false })
  const sha = git(dir, 'rev-parse', '--short', 'HEAD')
  git(dir, 'checkout', '--detach')
  assert.deepEqual(projectBranchInfo(dir), { isGitRepo: true, branch: null, detached: true, sha })
})
