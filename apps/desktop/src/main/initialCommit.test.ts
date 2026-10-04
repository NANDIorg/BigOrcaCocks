// Начальный коммит в репозитории без коммитов (IPC `projects:createInitialCommit`). Фикстуры — только во временной папке.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS } from '@orca-board/core'
import { createInitialCommit, projectBranchInfo } from './git'
import { ensureRunBranch } from './run-branch'
import { OrcaError } from './i18n'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let tmp: string
let repo: string
/** Окружение git до теста: восстанавливается целиком в afterEach. */
const savedGitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GIT_CONFIG')))

/**
 * CI задаёт identity через `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` (`.github/workflows/ci.yml`), а они сильнее
 * глобального конфига. Убираем из них только `user.*`: остальные ключи (autocrlf, safe.directory) фикстурам нужны.
 */
function dropEnvIdentity(): void {
  const count = Number(savedGitEnv.GIT_CONFIG_COUNT ?? 0)
  const kept: Array<[string, string]> = []
  for (let i = 0; i < count; i++) {
    const key = savedGitEnv[`GIT_CONFIG_KEY_${i}`] ?? ''
    if (!key.toLowerCase().startsWith('user.')) kept.push([key, savedGitEnv[`GIT_CONFIG_VALUE_${i}`] ?? ''])
    delete process.env[`GIT_CONFIG_KEY_${i}`]
    delete process.env[`GIT_CONFIG_VALUE_${i}`]
  }
  kept.forEach(([key, value], i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = key
    process.env[`GIT_CONFIG_VALUE_${i}`] = value
  })
  if (count > 0) process.env.GIT_CONFIG_COUNT = String(kept.length)
}

/** Идентичность — через временный глобальный конфиг: тест не зависит от настроек машины и не трогает их. */
function useGlobalConfig(content: string): void {
  const file = path.join(tmp, 'gitconfig')
  writeFileSync(file, content)
  process.env.GIT_CONFIG_GLOBAL = file
  process.env.GIT_CONFIG_NOSYSTEM = '1'
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-initial-commit-')))
  repo = path.join(tmp, 'repo')
  dropEnvIdentity()
  useGlobalConfig('[user]\n\tname = Human\n\temail = human@example.com\n')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
})

afterEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_CONFIG')) delete process.env[key]
  Object.assign(process.env, savedGitEnv)
  rmSync(tmp, { recursive: true, force: true })
})

describe('createInitialCommit', () => {
  it('empty: HEAD появился, дерево пустое, индекс и рабочее дерево как были', async () => {
    writeFileSync(path.join(repo, 'staged.txt'), 's\n')
    writeFileSync(path.join(repo, 'untracked.txt'), 'u\n')
    git(repo, 'add', 'staged.txt')
    const before = git(repo, 'status', '--porcelain')
    assert.equal(projectBranchInfo(repo).unborn, true)
    const info = await createInitialCommit(repo, 'empty')
    assert.deepEqual(info, { isGitRepo: true, branch: 'main', detached: false })
    assert.equal(git(repo, 'ls-tree', '-r', 'HEAD'), '')
    assert.equal(git(repo, 'log', '--format=%s|%an', 'main'), 'chore: начальный коммит (orca-board)|Human')
    // staged-файл остаётся staged (теперь «A» относительно пустого HEAD), untracked — untracked
    assert.equal(git(repo, 'status', '--porcelain'), before)
  })

  it('snapshot: файлы закоммичены, игнорируемые — нет', async () => {
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
    writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    mkdirSync(path.join(repo, 'node_modules'))
    writeFileSync(path.join(repo, 'node_modules', 'x.js'), 'x\n')
    const info = await createInitialCommit(repo, 'snapshot')
    assert.equal(info.unborn, undefined)
    assert.deepEqual(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').sort(), ['.gitignore', 'a.txt'])
    assert.equal(git(repo, 'status', '--porcelain'), '')
  })

  it('повторный вызов на репозитории с коммитами — без изменений и без ошибки', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    await createInitialCommit(repo, 'snapshot')
    const head = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    assert.deepEqual(await createInitialCommit(repo, 'snapshot'), { isGitRepo: true, branch: 'main', detached: false })
    assert.deepEqual(await createInitialCommit(repo, 'empty'), { isGitRepo: true, branch: 'main', detached: false })
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head)
    assert.equal(git(repo, 'status', '--porcelain'), '?? b.txt')
  })

  it('нет идентичности у человека — автор orca-board (оба режима)', async () => {
    useGlobalConfig('')
    await createInitialCommit(repo, 'empty')
    assert.equal(git(repo, 'log', '--format=%an <%ae>|%cn', 'HEAD'), 'orca-board <orca@local>|orca-board')
    const other = path.join(tmp, 'other')
    execFileSync('git', ['init', '-q', '-b', 'main', other])
    writeFileSync(path.join(other, 'a.txt'), 'a\n')
    await createInitialCommit(other, 'snapshot')
    assert.equal(git(other, 'log', '--format=%an <%ae>', 'HEAD'), 'orca-board <orca@local>')
  })

  it('не репозиторий — git.notRepo', async () => {
    const dir = path.join(tmp, 'plain')
    mkdirSync(dir)
    await assert.rejects(createInitialCommit(dir, 'empty'), (e: unknown) => e instanceof OrcaError && e.key === 'git.notRepo')
  })

  it('отказ хука — git.opFailed со stderr, HEAD остаётся unborn', async () => {
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 })
    writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    await assert.rejects(
      createInitialCommit(repo, 'snapshot'),
      (e: unknown) => e instanceof OrcaError && e.key === 'git.opFailed' && e.message.includes('hook says no')
    )
    assert.equal(projectBranchInfo(repo).unborn, true)
  })

  it('после snapshot ensureRunBranch проходит, worktree содержит файлы', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    await createInitialCommit(repo, 'snapshot')
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const run = store.createGlobalTask({ title: 'Фича' })
    const worktree = (await ensureRunBranch(store, repo, run.id))?.worktree
    assert.ok(worktree)
    assert.equal(existsSync(path.join(worktree, 'a.txt')), true)
  })
})
