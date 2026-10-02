import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitOperations, MergeError, GitOpError, type GitErrorCode, type GitMessageParams } from '../src/git.ts'

class HostError extends Error {
  readonly key: GitErrorCode
  readonly params: GitMessageParams | undefined
  readonly host: string

  constructor(host: string, key: GitErrorCode, params?: GitMessageParams) {
    super(`${host}: ${key} ${JSON.stringify(params ?? {})}`)
    this.host = host
    this.key = key
    this.params = params
  }
}

const operations = (host: string, label = () => 'Untracked:') => createGitOperations({
  error: (key, params) => new HostError(host, key, params),
  untrackedLabel: label
})

let dir: string
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-runtime-git-'))) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function repository(commit = true): string {
  const root = join(dir, 'проект с пробелами')
  git(dir, 'init', '-q', '-b', 'main', root)
  git(root, 'config', 'user.name', 'runtime test')
  git(root, 'config', 'user.email', 'runtime@test.local')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.hooksPath', join(dir, 'hooks'))
  if (commit) {
    writeFileSync(join(root, 'base.txt'), 'base')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'base')
  }
  return root
}

it('Git runtime запускается обычным Node без Electron и видит unborn HEAD', () => {
  const root = repository(false)
  const ops = operations('headless')
  assert.equal(ops.currentBranch(root), 'main')
  assert.equal(ops.hasCommits(root), false)
  assert.deepEqual(ops.projectBranchInfo(root), { isGitRepo: true, branch: 'main', detached: false, unborn: true })
  assert.throws(() => ops.assertHasCommits(root), (e: unknown) => e instanceof HostError && e.host === 'headless' && e.key === 'git.noCommits' && e.params?.branch === 'main')
})

it('empty initial commit сохраняет staged-файлы и рабочее дерево', async () => {
  const root = repository(false)
  writeFileSync(join(root, 'staged.txt'), 'staged')
  git(root, 'add', 'staged.txt')
  writeFileSync(join(root, 'loose.txt'), 'loose')
  const ops = operations('headless')
  assert.deepEqual(await ops.createInitialCommit(root, 'empty'), { isGitRepo: true, branch: 'main', detached: false })
  assert.equal(git(root, 'ls-tree', '-r', '--name-only', 'HEAD'), '')
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'staged.txt')
  assert.equal(readFileSync(join(root, 'loose.txt'), 'utf8'), 'loose')
  const head = git(root, 'rev-parse', 'HEAD')
  await ops.createInitialCommit(root, 'snapshot')
  assert.equal(git(root, 'rev-parse', 'HEAD'), head)
})

it('две реализации host errors не смешиваются при отказе Git', async () => {
  const a = operations('a')
  const b = operations('b')
  await assert.rejects(a.projectFetch(dir), (e: unknown) => e instanceof HostError && e.host === 'a' && e.key === 'git.notRepo')
  await assert.rejects(b.projectFetch(dir), (e: unknown) => e instanceof HostError && e.host === 'b' && e.key === 'git.notRepo')
  await assert.rejects(a.projectFetch(dir), (e: unknown) => e instanceof HostError && e.host === 'a')
})

it('подпись untracked принадлежит host и читается при каждом review', () => {
  const root = repository()
  let label = 'Files A:'
  const a = operations('a', () => label)
  const b = operations('b', () => 'Files B:')
  writeFileSync(join(root, 'new.txt'), 'new')
  assert.match(a.reviewInfo(root, root, 'main').stat, /Files A:\nnew\.txt/)
  assert.match(b.reviewInfo(root, root, 'main').stat, /Files B:\nnew\.txt/)
  label = 'Files A changed:'
  assert.match(a.reviewInfo(root, root, 'main').stat, /Files A changed:\nnew\.txt/)
})

it('worktree, commit, merge и remove сохраняют изменения задачи', () => {
  const root = repository()
  const wt = join(dir, 'worktree с пробелами')
  const ops = operations('headless')
  ops.addTaskWorktree(root, wt, 'orca/task')
  writeFileSync(join(wt, 'answer.txt'), 'answer')
  ops.commitWorktree(wt, 'task')
  const review = ops.reviewInfo(root, wt, 'orca/task', 'main')
  assert.equal(review.dirty, false)
  assert.equal(review.commits.length, 1)
  assert.match(review.stat, /answer\.txt/)
  ops.mergeBranch(root, 'orca/task', 'merge task')
  assert.equal(readFileSync(join(root, 'answer.txt'), 'utf8'), 'answer')
  ops.removeWorktree(root, wt, 'orca/task')
  assert.equal(existsSync(wt), false)
  assert.equal(ops.localBranchExists(root, 'orca/task'), false)
})

it('MergeError при несуществующей ветке отличает отказ от конфликта', () => {
  const root = repository()
  assert.throws(() => operations('headless').mergeBranch(root, 'missing', 'merge'), (e: unknown) => e instanceof MergeError && !e.conflict)
  assert.equal(existsSync(join(root, '.git', 'MERGE_HEAD')), false)
})

it('GitOpError сохраняется у workflow Git без worktree', () => {
  assert.throws(() => operations('headless').gitCommit(join(dir, 'missing'), 'commit'), (e: unknown) => e instanceof GitOpError && /нет worktree/.test(e.message))
})

it('checkout отказывает с host error и не переносит грязные файлы в другую ветку', async () => {
  const root = repository()
  git(root, 'branch', 'side')
  writeFileSync(join(root, 'loose.txt'), 'loose')
  await assert.rejects(operations('headless').checkoutProjectBranch(root, 'side', 0), (e: unknown) => e instanceof HostError && e.key === 'git.dirtyTree')
  assert.equal(git(root, 'branch', '--show-current'), 'main')
  assert.equal(readFileSync(join(root, 'loose.txt'), 'utf8'), 'loose')
})

it('Git check-ignore получает пути с пробелами через stdin', async () => {
  const root = repository()
  writeFileSync(join(root, '.gitignore'), 'ignored file.txt\ncache/\n')
  const ignored = await operations('headless').gitCheckIgnore(root, ['ignored file.txt', 'normal.txt', 'cache/'])
  assert.deepEqual([...ignored].sort(), ['cache/', 'ignored file.txt'])
})

it('отказ commit hook приходит в host error с исходной причиной', async () => {
  const root = repository(false)
  mkdirSync(join(dir, 'hooks'))
  writeFileSync(join(dir, 'hooks', 'pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 })
  writeFileSync(join(root, 'a.txt'), 'a')
  await assert.rejects(operations('headless').createInitialCommit(root, 'snapshot'), (e: unknown) => e instanceof HostError && e.key === 'git.opFailed' && e.message.includes('hook says no'))
  assert.equal(operations('headless').hasCommits(root), false)
})
