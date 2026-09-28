import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectBranches, projectFetch, projectPull, checkoutProjectBranch } from './git'
import { OrcaError } from './i18n'

// git корня проекта: ветки, fetch, pull, checkout. Фикстуры — только во временной папке: bare remote,
// «корень проекта» (clone) и второй clone, которым «коллега» пушит в remote.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commit(cwd: string, file: string, text: string): void {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', `edit ${file}`)
}

/** Код отказа `OrcaError`; любая другая ошибка — провал теста. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof OrcaError, `не OrcaError: ${String(e)}`)
    return e.key
  }
  return assert.fail('ожидался отказ')
}

let tmp: string
let seq = 0

interface Fixture {
  remote: string
  root: string
  other: string
}

/** Свежая тройка: remote с `main` и `feature/a`, корень на `main` (с upstream), второй clone. */
function fixture(): Fixture {
  seq += 1
  const base = join(tmp, `f${seq}`)
  const remote = join(base, 'remote.git')
  const seed = join(base, 'seed')
  const root = join(base, 'root')
  const other = join(base, 'other')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'ignore' })
  execFileSync('git', ['clone', '-q', remote, seed], { stdio: 'ignore' })
  git(seed, 'checkout', '-q', '-b', 'main')
  commit(seed, 'a.txt', 'a')
  git(seed, 'push', '-q', '-u', 'origin', 'main')
  git(seed, 'checkout', '-q', '-b', 'feature/a')
  commit(seed, 'f.txt', 'f')
  git(seed, 'push', '-q', '-u', 'origin', 'feature/a')
  execFileSync('git', ['clone', '-q', remote, root], { stdio: 'ignore' })
  execFileSync('git', ['clone', '-q', remote, other], { stdio: 'ignore' })
  return { remote, root, other }
}

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orca-git-root-')))
})
after(() => rmSync(tmp, { recursive: true, force: true }))

describe('projectBranches', () => {
  it('не репозиторий — isGitRepo: false, без исключения', async () => {
    const dir = mkdtempSync(join(tmp, 'nogit-'))
    assert.deepEqual(await projectBranches(dir), { isGitRepo: false, current: { isGitRepo: false, branch: null, detached: false }, local: [], remote: [], dirty: false })
  })

  it('локальные, удалённые без HEAD, upstream и чистое дерево', async () => {
    const { root } = fixture()
    const list = await projectBranches(root)
    assert.equal(list.isGitRepo, true)
    assert.deepEqual(list.current, { isGitRepo: true, branch: 'main', detached: false })
    assert.deepEqual(list.local, [{ name: 'main', current: true, busy: false }])
    assert.deepEqual(list.remote, ['origin/feature/a', 'origin/main'])
    assert.deepEqual(list.upstream, { name: 'origin/main', ahead: 0, behind: 0, gone: false })
    assert.equal(list.dirty, false)
  })

  it('ahead/behind, грязное дерево (в том числе untracked) и ветка в другом worktree', async () => {
    const { root, other } = fixture()
    commit(root, 'local.txt', 'l')
    commit(other, 'remote.txt', 'r')
    git(other, 'push', '-q')
    git(root, 'fetch', '-q')
    git(root, 'branch', 'side')
    git(root, 'worktree', 'add', '-q', join(root, '..', 'wt'), 'side')
    writeFileSync(join(root, 'untracked.txt'), 'u')
    const list = await projectBranches(root)
    assert.deepEqual(list.upstream, { name: 'origin/main', ahead: 1, behind: 1, gone: false })
    assert.equal(list.dirty, true)
    assert.deepEqual(list.local, [{ name: 'main', current: true, busy: false }, { name: 'side', current: false, busy: true }])
  })

  it('upstream исчез с remote — gone; detached HEAD — без upstream', async () => {
    const { root, other } = fixture()
    git(root, 'checkout', '-q', 'feature/a')
    git(other, 'push', '-q', 'origin', '--delete', 'feature/a')
    git(root, 'fetch', '-q', '--prune')
    assert.deepEqual((await projectBranches(root)).upstream, { name: 'origin/feature/a', ahead: 0, behind: 0, gone: true })
    git(root, 'checkout', '-q', '--detach')
    const detached = await projectBranches(root)
    assert.equal(detached.current.detached, true)
    assert.equal(detached.upstream, undefined)
  })
})

describe('projectFetch', () => {
  it('подтягивает новые ветки и коммиты, --prune убирает удалённые; HEAD не двигается', async () => {
    const { root, other } = fixture()
    const head = git(root, 'rev-parse', 'HEAD')
    git(other, 'checkout', '-q', '-b', 'feature/new')
    commit(other, 'n.txt', 'n')
    git(other, 'push', '-q', '-u', 'origin', 'feature/new')
    git(other, 'push', '-q', 'origin', '--delete', 'feature/a')
    const res = await projectFetch(root)
    assert.deepEqual(res.branch, { isGitRepo: true, branch: 'main', detached: false })
    assert.match(res.output, /feature\/new/)
    assert.deepEqual((await projectBranches(root)).remote, ['origin/feature/new', 'origin/main'])
    assert.equal(git(root, 'rev-parse', 'HEAD'), head)
  })

  it('не репозиторий — git.notRepo; недоступный remote — git.opFailed со stderr git', async () => {
    assert.equal(await codeOf(projectFetch(mkdtempSync(join(tmp, 'nogit-')))), 'git.notRepo')
    const { root, remote } = fixture()
    rmSync(remote, { recursive: true, force: true })
    const err = await projectFetch(root).catch((e: unknown) => e)
    assert.ok(err instanceof OrcaError)
    assert.equal(err.key, 'git.opFailed')
    assert.match(err.message, /^git fetch --all --prune: .+/)
  })
})

describe('projectPull', () => {
  it('ff-pull подтягивает коммиты remote в текущую ветку', async () => {
    const { root, other } = fixture()
    commit(other, 'remote.txt', 'r')
    git(other, 'push', '-q')
    const res = await projectPull(root)
    assert.equal(git(root, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'))
    assert.deepEqual(res.branch, { isGitRepo: true, branch: 'main', detached: false })
    assert.deepEqual((await projectBranches(root)).upstream, { name: 'origin/main', ahead: 0, behind: 0, gone: false })
    // повтор — «уже актуально», не ошибка
    await projectPull(root)
  })

  it('разошедшаяся ветка — git.notFastForward, ветка не тронута', async () => {
    const { root, other } = fixture()
    commit(root, 'local.txt', 'l')
    const head = git(root, 'rev-parse', 'HEAD')
    commit(other, 'remote.txt', 'r')
    git(other, 'push', '-q')
    assert.equal(await codeOf(projectPull(root)), 'git.notFastForward')
    assert.equal(git(root, 'rev-parse', 'HEAD'), head)
  })

  it('своих непушенных коммитов впереди remote — не «разошлась», а «уже актуально»', async () => {
    const { root } = fixture()
    commit(root, 'local.txt', 'l')
    await projectPull(root)
  })

  it('нет upstream, detached HEAD и upstream пропал — git.noUpstream', async () => {
    const { root, other } = fixture()
    git(root, 'checkout', '-q', '-b', 'lonely')
    assert.equal(await codeOf(projectPull(root)), 'git.noUpstream')
    git(root, 'checkout', '-q', '--detach')
    assert.equal(await codeOf(projectPull(root)), 'git.noUpstream')
    git(root, 'checkout', '-q', 'feature/a')
    git(other, 'push', '-q', 'origin', '--delete', 'feature/a')
    git(root, 'fetch', '-q', '--prune')
    assert.equal(await codeOf(projectPull(root)), 'git.noUpstream')
  })

  it('правка в дереве мешает обновлению — git.opFailed (не notFastForward)', async () => {
    const { root, other } = fixture()
    commit(other, 'a.txt', 'changed remotely')
    git(other, 'push', '-q')
    writeFileSync(join(root, 'a.txt'), 'local edit')
    assert.equal(await codeOf(projectPull(root)), 'git.opFailed')
    assert.equal(git(root, 'show', 'HEAD:a.txt'), 'a')
  })

  it('не репозиторий — git.notRepo', async () => {
    assert.equal(await codeOf(projectPull(mkdtempSync(join(tmp, 'nogit-')))), 'git.notRepo')
  })
})

describe('checkoutProjectBranch', () => {
  it('удалённая origin/x — создаёт локальную x с tracking; повтор на локальную — простое переключение', async () => {
    const { root } = fixture()
    const info = await checkoutProjectBranch(root, 'origin/feature/a', 0)
    assert.deepEqual(info, { isGitRepo: true, branch: 'feature/a', detached: false })
    assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'feature/a@{upstream}'), 'origin/feature/a')
    assert.equal((await checkoutProjectBranch(root, 'main', 0)).branch, 'main')
    // локальная feature/a уже есть: origin/feature/a переключает на неё, не пересоздаёт
    assert.equal((await checkoutProjectBranch(root, 'origin/feature/a', 0)).branch, 'feature/a')
  })

  it('та же ветка — не ошибка, даже при живых воркерах и грязном дереве', async () => {
    const { root } = fixture()
    writeFileSync(join(root, 'dirty.txt'), 'd')
    assert.equal((await checkoutProjectBranch(root, 'main', 3)).branch, 'main')
  })

  it('нет такой ветки — git.branchNotFound (в том числе имя, похожее на опцию)', async () => {
    const { root } = fixture()
    assert.equal(await codeOf(checkoutProjectBranch(root, 'nope', 0)), 'git.branchNotFound')
    assert.equal(await codeOf(checkoutProjectBranch(root, 'origin/nope', 0)), 'git.branchNotFound')
    assert.equal(await codeOf(checkoutProjectBranch(root, 'origin/HEAD', 0)), 'git.branchNotFound')
    assert.equal(await codeOf(checkoutProjectBranch(root, '--orphan=x', 0)), 'git.branchNotFound')
    assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  })

  it('грязное дерево (tracked и untracked) — git.dirtyTree, ветка не меняется', async () => {
    const { root } = fixture()
    writeFileSync(join(root, 'untracked.txt'), 'u')
    assert.equal(await codeOf(checkoutProjectBranch(root, 'origin/feature/a', 0)), 'git.dirtyTree')
    assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
    rmSync(join(root, 'untracked.txt'))
    writeFileSync(join(root, 'a.txt'), 'edit')
    assert.equal(await codeOf(checkoutProjectBranch(root, 'origin/feature/a', 0)), 'git.dirtyTree')
  })

  it('живые воркеры или координаторы — git.workersActive', async () => {
    const { root } = fixture()
    assert.equal(await codeOf(checkoutProjectBranch(root, 'origin/feature/a', 2)), 'git.workersActive')
    assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  })

  it('ветка открыта в другом worktree — git.branchBusy с путём', async () => {
    const { root } = fixture()
    git(root, 'branch', 'orca/task_1')
    const wt = join(root, '..', 'wt')
    git(root, 'worktree', 'add', '-q', wt, 'orca/task_1')
    const err = await checkoutProjectBranch(root, 'orca/task_1', 0).catch((e: unknown) => e)
    assert.ok(err instanceof OrcaError)
    assert.equal(err.key, 'git.branchBusy')
    assert.match(err.message, /orca\/task_1/)
    assert.match(err.message, /wt/)
  })

  it('не репозиторий — git.notRepo', async () => {
    assert.equal(await codeOf(checkoutProjectBranch(mkdtempSync(join(tmp, 'nogit-')), 'main', 0)), 'git.notRepo')
  })

  it('операции над одним корнем идут по очереди: параллельные checkout не ломают друг друга', async () => {
    const { root } = fixture()
    const results = await Promise.all([
      checkoutProjectBranch(root, 'origin/feature/a', 0),
      checkoutProjectBranch(root, 'main', 0),
      checkoutProjectBranch(root, 'origin/feature/a', 0)
    ])
    assert.deepEqual(results.map((r) => r.branch), ['feature/a', 'main', 'feature/a'])
  })
})
