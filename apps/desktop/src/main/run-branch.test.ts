// Запуск: pnpm --filter @orca-board/desktop test. Ветка глобальной задачи на настоящем git: временный репозиторий
// и bare-remote в отдельной папке, рабочий репозиторий не трогается.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, type Task } from '@orca-board/core'
import { ensureRunBranch, mergeRunBranch, mergeTarget, reviewBase, RunBranchSync, runWorktreePath } from './run-branch'
import { acceptReview, mergeTaskBranch } from './review'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let tmp: string
let repo: string
let remote: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-run-branch-')))
  remote = path.join(tmp, 'remote.git')
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote])
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  writeFileSync(path.join(repo, 'README.md'), 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', 'origin', 'master', 'master:develop')
  git(repo, 'fetch', '-q', 'origin')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const newStore = (): TaskStore => new TaskStore(undefined, () => DEFAULT_COLUMNS)
const head = (cwd: string): string => git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
const hasBranch = (branch: string): boolean => git(repo, 'branch', '--list', branch) !== ''

/** Подзадача с воркером: ветка `orca/<id>` от ветки глобальной задачи (как `startWorker`), файл закоммичен. */
function workedTask(store: TaskStore, runId: string, file: string): Task {
  const task = store.createTask({ title: file, runId })
  const branch = `orca/${task.id}`
  const worktree = path.join(tmp, task.id)
  const base = store.getRun(runId)!.git?.branch
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, ...(base ? [base] : []))
  store.startDispatch(task.id, 'pty')
  writeFileSync(path.join(worktree, file), `${file}\n`)
  git(worktree, 'add', '-A')
  git(worktree, 'commit', '-qm', file)
  return store.updateTask(task.id, { worktree, branch })
}

describe('ensureRunBranch', () => {
  it('заводит ветку фичи от текущей ветки корня в своём worktree; корень не меняется, upstream на базу нет', () => {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'Группы проектов' })
    const g = ensureRunBranch(store, repo, run.id)!
    assert.equal(g.branch, `feature/${run.id}-gruppy-proektov`)
    assert.equal(g.base, 'master')
    assert.equal(g.worktree, runWorktreePath(repo, run.id))
    assert.equal(head(g.worktree!), g.branch)
    assert.equal(head(repo), 'master', 'ветку корня никто не переключал')
    assert.throws(() => git(g.worktree!, 'rev-parse', '--abbrev-ref', '@{u}'), 'без upstream: голый push не уйдёт в базу')
    assert.deepEqual(store.getRun(run.id)!.git, g)
    assert.deepEqual(ensureRunBranch(store, repo, run.id), g, 'повторный вызов — та же ветка')
  })

  it('корень на другой ветке или в detached HEAD — база оттуда', () => {
    const store = newStore()
    git(repo, 'switch', '-q', '-c', 'develop')
    assert.equal(ensureRunBranch(store, repo, store.createGlobalTask({ title: 'A' }).id)!.base, 'develop')
    const sha = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'switch', '-q', '--detach')
    assert.equal(ensureRunBranch(store, repo, store.createGlobalTask({ title: 'B' }).id)!.base, sha)
  })

  it('без ветки: «Входящие» и прогон, уже работавший без неё', () => {
    const store = newStore()
    const loose = store.createTask({ title: 'без прогона' })
    assert.equal(ensureRunBranch(store, repo, loose.runId), undefined)
    assert.equal(ensureRunBranch(store, repo, undefined), undefined)
    const old = store.createGlobalTask({ title: 'старый' })
    workedTask(store, old.id, 'old.md')
    assert.equal(ensureRunBranch(store, repo, old.id), undefined, 'половина фичи уже в корне')
    assert.equal(store.getRun(old.id)!.git, undefined)
  })

  it('worktree убран — возвращается на ту же ветку', () => {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'A' })
    const g = ensureRunBranch(store, repo, run.id)!
    rmSync(g.worktree!, { recursive: true, force: true })
    const again = ensureRunBranch(store, repo, run.id)!
    assert.equal(again.branch, g.branch)
    assert.equal(head(again.worktree!), g.branch)
  })
})

describe('мерж подзадач в ветку глобальной задачи', () => {
  it('две глобальные задачи параллельно: каждая подзадача — в свою ветку фичи, master не меняется', () => {
    const store = newStore()
    const a = store.createGlobalTask({ title: 'Фича A' })
    const b = store.createGlobalTask({ title: 'Фича B' })
    const ga = ensureRunBranch(store, repo, a.id)!
    const gb = ensureRunBranch(store, repo, b.id)!
    const ta = workedTask(store, a.id, 'a.md')
    const tb = workedTask(store, b.id, 'b.md')
    const masterBefore = git(repo, 'rev-parse', 'master')

    assert.equal(reviewBase(store, repo, ta), ga.branch)
    assert.deepEqual(mergeTaskBranch(repo, ta, mergeTarget(store, repo, ta)), { ok: true })
    assert.deepEqual(mergeTaskBranch(repo, tb, mergeTarget(store, repo, tb)), { ok: true })

    assert.equal(git(repo, 'rev-parse', 'master'), masterBefore, 'в master ничего не попало')
    assert.equal(existsSync(path.join(ga.worktree!, 'a.md')), true)
    assert.equal(existsSync(path.join(ga.worktree!, 'b.md')), false, 'фичи не смешались')
    assert.equal(existsSync(path.join(gb.worktree!, 'b.md')), true)
    assert.equal(hasBranch(ta.branch!), false, 'служебная ветка подзадачи убрана')
  })

  it('без ветки фичи («Входящие») — в текущую ветку корня, какой бы она ни была', () => {
    const store = newStore()
    const task = workedTask(store, store.createTask({ title: 'x' }).runId!, 'x.md')
    assert.deepEqual(mergeTarget(store, repo, task), { cwd: repo, branch: 'master' })
    acceptReview(store, repo, task.id, undefined, (t) => mergeTarget(store, repo, t))
    assert.equal(existsSync(path.join(repo, 'x.md')), true)
  })
})

describe('RunBranchSync', () => {
  it('«Сделано» — worktree убран, ветка осталась; на remote приложение ничего не отправляет', () => {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'Фича' })
    const g = ensureRunBranch(store, repo, run.id)!
    const task = workedTask(store, run.id, 'f.md')
    mergeTaskBranch(repo, task, mergeTarget(store, repo, task))
    const sync = new RunBranchSync({ isAlive: () => false })

    store.moveGlobalTask(run.id, 'review')
    sync.sync(store, repo)
    assert.equal(store.getRun(run.id)!.git!.worktree, g.worktree, 'на «Проверке» worktree на месте')

    store.moveGlobalTask(run.id, 'done')
    sync.sync(store, repo)
    assert.equal(existsSync(g.worktree!), false)
    assert.equal(store.getRun(run.id)!.git!.worktree, undefined)
    assert.equal(hasBranch(g.branch), true, 'ветка фичи остаётся')
    assert.equal(git(remote, 'branch', '--list', g.branch), '', 'push не делается — что делать с веткой, решает человек')
  })

  it('грязный worktree не удаляется', () => {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'Фича' })
    const g = ensureRunBranch(store, repo, run.id)!
    writeFileSync(path.join(g.worktree!, 'руками.md'), 'правка\n')
    store.moveGlobalTask(run.id, 'done')
    new RunBranchSync({ isAlive: () => false }).sync(store, repo)
    assert.equal(existsSync(path.join(g.worktree!, 'руками.md')), true, 'без --force: правки не теряем')
  })

  it('живой координатор — worktree не трогаем', () => {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'Фича' })
    const g = ensureRunBranch(store, repo, run.id)!
    store.setRunPty(run.id, 'pty-coord')
    store.moveGlobalTask(run.id, 'done')
    new RunBranchSync({ isAlive: (id) => id === 'pty-coord' }).sync(store, repo)
    assert.equal(existsSync(g.worktree!), true)
  })
})

/**
 * Ветка фичи с одним коммитом (`f.md`) от `master`, worktree на ней. `base` — база в `Run.git`: ветка заводится от
 * ветки корня, поэтому другую базу проставляем после (все базы в тестах указывают на тот же коммит, что и `master`).
 */
function featureBranch(store: TaskStore, base = 'master'): { runId: string; branch: string; worktree: string } {
  const run = store.createGlobalTask({ title: 'Фича' })
  const g = ensureRunBranch(store, repo, run.id)!
  if (base !== g.base) store.setRunGit(run.id, { base })
  writeFileSync(path.join(g.worktree!, 'f.md'), 'f\n')
  git(g.worktree!, 'add', '-A')
  git(g.worktree!, 'commit', '-qm', 'f')
  return { runId: run.id, branch: g.branch, worktree: g.worktree! }
}

describe('mergeRunBranch: ветка глобальной задачи → её база', () => {
  it('база выгружена в корне и там чисто — сливаем прямо в корне, ветку корня не переключаем (master тоже: защиты нет)', () => {
    const store = newStore()
    const f = featureBranch(store)
    const r = mergeRunBranch(repo, store.getRun(f.runId)!.git!, 'Merge orca run: Фича')
    assert.deepEqual(r, { kind: 'ok', into: 'master' })
    assert.equal(existsSync(path.join(repo, 'f.md')), true)
    assert.equal(head(repo), 'master')
    assert.match(git(repo, 'log', '-1', '--format=%s'), /Merge orca run: Фича/)
  })

  it('база не выгружена нигде — временный worktree: корень не тронут, worktree и папка убраны', () => {
    const store = newStore()
    git(repo, 'branch', 'integration')
    const f = featureBranch(store, 'integration')
    const before = git(repo, 'worktree', 'list', '--porcelain')
    const r = mergeRunBranch(repo, store.getRun(f.runId)!.git!, 'Merge orca run: Фича')
    assert.deepEqual(r, { kind: 'ok', into: 'integration' })
    assert.equal(git(repo, 'ls-tree', '-r', '--name-only', 'integration').includes('f.md'), true)
    assert.equal(existsSync(path.join(repo, 'f.md')), false, 'корень остался на master')
    assert.equal(git(repo, 'worktree', 'list', '--porcelain'), before, 'временный worktree убран')
  })

  it('база на remote (origin/develop) — сливаем в локальную develop', () => {
    const store = newStore()
    git(repo, 'branch', 'develop', 'origin/develop')
    const f = featureBranch(store, 'origin/develop')
    const r = mergeRunBranch(repo, store.getRun(f.runId)!.git!, 'm')
    assert.deepEqual(r, { kind: 'ok', into: 'develop' })
    assert.equal(git(repo, 'ls-tree', '-r', '--name-only', 'develop').includes('f.md'), true)
  })

  it('в корне с базой — незакоммиченные правки: blocked, а не мерж в грязное дерево', () => {
    const store = newStore()
    const f = featureBranch(store)
    writeFileSync(path.join(repo, 'wip.md'), 'wip\n')
    const r = mergeRunBranch(repo, store.getRun(f.runId)!.git!, 'm')
    assert.equal(r.kind, 'blocked')
    assert.match((r as { reason: string }).reason, /незакоммиченными изменениями/)
  })

  it('конфликт — conflict с текстом git, база и корень чистые (merge --abort)', () => {
    const store = newStore()
    const f = featureBranch(store)
    writeFileSync(path.join(repo, 'f.md'), 'другое\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'конфликтующий')
    const r = mergeRunBranch(repo, store.getRun(f.runId)!.git!, 'm')
    assert.equal(r.kind, 'conflict')
    assert.match((r as { error: string }).error, /мерж не удался/)
    assert.equal(git(repo, 'status', '--porcelain'), '')
  })

  it('база — не ветка (коммит) или локальной ветки нет — blocked', () => {
    const store = newStore()
    const f = featureBranch(store)
    const g = store.getRun(f.runId)!.git!
    const sha = git(repo, 'rev-parse', 'master')
    assert.match((mergeRunBranch(repo, { ...g, base: sha }, 'm') as { reason: string }).reason, /не ветка/)
    assert.match((mergeRunBranch(repo, { ...g, base: 'origin/nowhere' }, 'm') as { reason: string }).reason, /локальной ветки «nowhere» нет/)
  })
})
