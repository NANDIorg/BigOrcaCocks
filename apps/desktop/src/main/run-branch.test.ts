// Запуск: pnpm --filter @orca-board/desktop test. Ветка глобальной задачи на настоящем git: временный репозиторий
// и bare-remote в отдельной папке, рабочий репозиторий не трогается.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, normalizeRunBranchSettings, pipelineWorkflow, type RunBranchSettings, type Task, type WfNode, type Workflow } from '@orca-board/core'
import { ensureRunBranch, mergeRunBranch, mergeTarget, reviewBase, RunBranchSync, runWorktreePath, workflowPushes } from './run-branch'
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

const settings = (patch: Partial<RunBranchSettings> = {}): RunBranchSettings => ({ ...normalizeRunBranchSettings(undefined), ...patch })
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

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail(`не дождались: ${what}`)
}

describe('ensureRunBranch', () => {
  it('заводит ветку фичи от базы в своём worktree; корень не меняется, upstream на базу нет', () => {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'Группы проектов' })
    const g = ensureRunBranch(store, repo, run.id, settings({ base: 'origin/develop' }))!
    assert.equal(g.branch, `feature/${run.id}-gruppy-proektov`)
    assert.equal(g.base, 'origin/develop')
    assert.equal(g.worktree, runWorktreePath(repo, run.id))
    assert.equal(head(g.worktree!), g.branch)
    assert.equal(head(repo), 'master', 'ветку корня никто не переключал')
    assert.throws(() => git(g.worktree!, 'rev-parse', '--abbrev-ref', '@{u}'), 'без upstream: голый push не уйдёт в базу')
    assert.deepEqual(store.getRun(run.id)!.git, g)
    assert.deepEqual(ensureRunBranch(store, repo, run.id, settings()), g, 'повторный вызов — та же ветка')
  })

  it('база не задана — текущая ветка корня', () => {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'A' })
    assert.equal(ensureRunBranch(store, repo, run.id, settings())!.base, 'master')
  })

  it('база на remote — сначала fetch: фича ответвляется от свежего origin/develop', () => {
    const other = path.join(tmp, 'other')
    execFileSync('git', ['clone', '-q', '-b', 'develop', remote, other])
    writeFileSync(path.join(other, 'news.md'), 'новое\n')
    git(other, 'add', '-A')
    git(other, 'commit', '-qm', 'чужой коммит в develop')
    git(other, 'push', '-q', 'origin', 'develop')

    const store = newStore()
    const run = store.createGlobalTask({ title: 'A' })
    const g = ensureRunBranch(store, repo, run.id, settings({ base: 'origin/develop' }))!
    assert.equal(existsSync(path.join(g.worktree!, 'news.md')), true)
  })

  it('без ветки: «Входящие», выключенная настройка, прогон, уже работавший без неё', () => {
    const store = newStore()
    const loose = store.createTask({ title: 'без прогона' })
    assert.equal(ensureRunBranch(store, repo, loose.runId, settings()), undefined)
    assert.equal(ensureRunBranch(store, repo, undefined, settings()), undefined)
    const off = store.createGlobalTask({ title: 'выкл' })
    assert.equal(ensureRunBranch(store, repo, off.id, settings({ enabled: false })), undefined)
    const old = store.createGlobalTask({ title: 'старый' })
    workedTask(store, old.id, 'old.md')
    assert.equal(ensureRunBranch(store, repo, old.id, settings()), undefined, 'половина фичи уже в корне')
    assert.equal(store.getRun(old.id)!.git, undefined)
  })

  it('битая база — понятная ошибка, ветки нет', () => {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'A' })
    assert.throws(() => ensureRunBranch(store, repo, run.id, settings({ base: 'origin/nope' })), /не удалось завести ветку .* от «origin\/nope»/)
    assert.equal(store.getRun(run.id)!.git, undefined)
  })

  it('worktree убран — возвращается на ту же ветку', () => {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'A' })
    const g = ensureRunBranch(store, repo, run.id, settings())!
    rmSync(g.worktree!, { recursive: true, force: true })
    const again = ensureRunBranch(store, repo, run.id, settings())!
    assert.equal(again.branch, g.branch)
    assert.equal(head(again.worktree!), g.branch)
  })
})

describe('мерж подзадач в ветку глобальной задачи', () => {
  it('две глобальные задачи параллельно: каждая подзадача — в свою ветку фичи, master не меняется', () => {
    const store = newStore()
    const a = store.createGlobalTask({ title: 'Фича A' })
    const b = store.createGlobalTask({ title: 'Фича B' })
    const s = settings()
    const ga = ensureRunBranch(store, repo, a.id, s)!
    const gb = ensureRunBranch(store, repo, b.id, s)!
    const ta = workedTask(store, a.id, 'a.md')
    const tb = workedTask(store, b.id, 'b.md')
    const masterBefore = git(repo, 'rev-parse', 'master')

    assert.equal(reviewBase(store, repo, ta), ga.branch)
    assert.deepEqual(mergeTaskBranch(repo, ta, mergeTarget(store, repo, ta, s)), { ok: true })
    assert.deepEqual(mergeTaskBranch(repo, tb, mergeTarget(store, repo, tb, s)), { ok: true })

    assert.equal(git(repo, 'rev-parse', 'master'), masterBefore, 'в master ничего не попало')
    assert.equal(existsSync(path.join(ga.worktree!, 'a.md')), true)
    assert.equal(existsSync(path.join(ga.worktree!, 'b.md')), false, 'фичи не смешались')
    assert.equal(existsSync(path.join(gb.worktree!, 'b.md')), true)
    assert.equal(hasBranch(ta.branch!), false, 'служебная ветка подзадачи убрана')
  })

  it('без ветки фичи: в защищённую ветку корня не сливает, в рабочую — сливает', () => {
    const store = newStore()
    const task = workedTask(store, store.createTask({ title: 'x' }).runId!, 'x.md')
    assert.throws(() => mergeTarget(store, repo, task, settings()), /мерж в «master» запрещён/)
    assert.throws(() => acceptReview(store, repo, task.id, undefined, (t) => mergeTarget(store, repo, t, settings())), /запрещён/)
    assert.equal(existsSync(task.worktree!), true, 'отказ до git-части: worktree и ветка на месте')
    assert.notEqual(store.getTask(task.id)!.status, 'done')

    git(repo, 'switch', '-q', '-c', 'feature/manual')
    assert.deepEqual(mergeTarget(store, repo, task, settings()), { cwd: repo, branch: 'feature/manual' })
    assert.deepEqual(mergeTarget(store, repo, task, settings({ protected: [] })), { cwd: repo, branch: 'feature/manual' })
  })
})

describe('RunBranchSync', () => {
  it('закрытая глобальная задача — push ветки на remote; «Сделано» — worktree убран, ветка осталась', async () => {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'Фича' })
    const s = settings({ push: true })
    const g = ensureRunBranch(store, repo, run.id, s)!
    const task = workedTask(store, run.id, 'f.md')
    mergeTaskBranch(repo, task, mergeTarget(store, repo, task, s))
    const sync = new RunBranchSync({ isAlive: () => false })

    sync.sync(store, repo, s)
    assert.equal(store.getRun(run.id)!.git!.pushedAt, undefined, 'открытую не пушим')

    store.moveGlobalTask(run.id, 'review')
    sync.sync(store, repo, s)
    await waitFor(() => store.getRun(run.id)!.git!.pushedAt !== undefined, 'push')
    assert.equal(git(remote, 'rev-parse', g.branch), git(repo, 'rev-parse', g.branch))
    assert.equal(store.getRun(run.id)!.git!.worktree, g.worktree, 'на «Проверке» worktree на месте')

    store.moveGlobalTask(run.id, 'done')
    sync.sync(store, repo, s)
    assert.equal(existsSync(g.worktree!), false)
    assert.equal(store.getRun(run.id)!.git!.worktree, undefined)
    assert.equal(hasBranch(g.branch), true, 'ветка фичи остаётся')
  })

  it('ошибка push — в Run.git, не повторяется на каждом изменении; грязный worktree не удаляется', async () => {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'Фича' })
    const s = settings({ push: true, remote: 'nope' })
    const g = ensureRunBranch(store, repo, run.id, s)!
    const sync = new RunBranchSync({ isAlive: () => false })
    store.moveGlobalTask(run.id, 'review')
    sync.sync(store, repo, s)
    await waitFor(() => store.getRun(run.id)!.git!.pushError !== undefined, 'ошибка push')
    const err = store.getRun(run.id)!.git!.pushError
    sync.sync(store, repo, s)
    assert.equal(store.getRun(run.id)!.git!.pushError, err)

    writeFileSync(path.join(g.worktree!, 'руками.md'), 'правка\n')
    store.moveGlobalTask(run.id, 'done')
    sync.sync(store, repo, s)
    assert.equal(existsSync(path.join(g.worktree!, 'руками.md')), true, 'без --force: правки не теряем')
  })

  it('живой координатор — worktree не трогаем', () => {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'Фича' })
    const g = ensureRunBranch(store, repo, run.id, settings())!
    store.setRunPty(run.id, 'pty-coord')
    store.moveGlobalTask(run.id, 'done')
    new RunBranchSync({ isAlive: (id) => id === 'pty-coord' }).sync(store, repo, settings())
    assert.equal(existsSync(g.worktree!), true)
  })
})

/** Ветка фичи с одним коммитом (`f.md`) от `master`, worktree на ней. */
function featureBranch(store: TaskStore, base = 'master'): { runId: string; branch: string; worktree: string } {
  const run = store.createGlobalTask({ title: 'Фича' })
  const g = ensureRunBranch(store, repo, run.id, settings({ base }))!
  writeFileSync(path.join(g.worktree!, 'f.md'), 'f\n')
  git(g.worktree!, 'add', '-A')
  git(g.worktree!, 'commit', '-qm', 'f')
  return { runId: run.id, branch: g.branch, worktree: g.worktree! }
}

describe('mergeRunBranch: ветка глобальной задачи → её база', () => {
  it('база выгружена в корне и там чисто — сливаем прямо в корне, ветку корня не переключаем', () => {
    const store = newStore()
    const f = featureBranch(store)
    const r = mergeRunBranch(repo, store.getRun(f.runId)!.git!, settings({ protected: [] }), 'Merge orca run: Фича')
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
    const r = mergeRunBranch(repo, store.getRun(f.runId)!.git!, settings({ protected: [] }), 'Merge orca run: Фича')
    assert.deepEqual(r, { kind: 'ok', into: 'integration' })
    assert.equal(git(repo, 'ls-tree', '-r', '--name-only', 'integration').includes('f.md'), true)
    assert.equal(existsSync(path.join(repo, 'f.md')), false, 'корень остался на master')
    assert.equal(git(repo, 'worktree', 'list', '--porcelain'), before, 'временный worktree убран')
  })

  it('база на remote (origin/develop) — сливаем в локальную develop', () => {
    const store = newStore()
    git(repo, 'branch', 'develop', 'origin/develop')
    const f = featureBranch(store, 'origin/develop')
    const r = mergeRunBranch(repo, store.getRun(f.runId)!.git!, settings({ protected: [] }), 'm')
    assert.deepEqual(r, { kind: 'ok', into: 'develop' })
    assert.equal(git(repo, 'ls-tree', '-r', '--name-only', 'develop').includes('f.md'), true)
  })

  it('защищённая база — blocked с подсказкой про push и PR, ничего не слито', () => {
    const store = newStore()
    const f = featureBranch(store)
    const before = git(repo, 'rev-parse', 'master')
    const r = mergeRunBranch(repo, store.getRun(f.runId)!.git!, settings(), 'm')
    assert.equal(r.kind, 'blocked')
    assert.match((r as { reason: string }).reason, /защищённую ветку «master» запрещено[\s\S]*git push/)
    assert.equal(git(repo, 'rev-parse', 'master'), before)
    // remote-база защищена по локальному имени: origin/develop → develop
    const g = { ...store.getRun(f.runId)!.git!, base: 'origin/develop' }
    assert.equal(mergeRunBranch(repo, g, settings(), 'm').kind, 'blocked')
  })

  it('в корне с базой — незакоммиченные правки: blocked, а не мерж в грязное дерево', () => {
    const store = newStore()
    const f = featureBranch(store)
    writeFileSync(path.join(repo, 'wip.md'), 'wip\n')
    const r = mergeRunBranch(repo, store.getRun(f.runId)!.git!, settings({ protected: [] }), 'm')
    assert.equal(r.kind, 'blocked')
    assert.match((r as { reason: string }).reason, /незакоммиченными изменениями/)
  })

  it('конфликт — conflict с текстом git, база и корень чистые (merge --abort)', () => {
    const store = newStore()
    const f = featureBranch(store)
    writeFileSync(path.join(repo, 'f.md'), 'другое\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'конфликтующий')
    const r = mergeRunBranch(repo, store.getRun(f.runId)!.git!, settings({ protected: [] }), 'm')
    assert.equal(r.kind, 'conflict')
    assert.match((r as { error: string }).error, /мерж не удался/)
    assert.equal(git(repo, 'status', '--porcelain'), '')
  })

  it('база — не ветка (коммит) или локальной ветки нет — blocked', () => {
    const store = newStore()
    const f = featureBranch(store)
    const g = store.getRun(f.runId)!.git!
    const sha = git(repo, 'rev-parse', 'master')
    assert.match((mergeRunBranch(repo, { ...g, base: sha }, settings({ protected: [] }), 'm') as { reason: string }).reason, /не ветка/)
    assert.match((mergeRunBranch(repo, { ...g, base: 'origin/nowhere' }, settings({ protected: [] }), 'm') as { reason: string }).reason, /локальной ветки «nowhere» нет/)
  })
})

describe('workflowPushes: push в графе выключает авто-push при закрытии', () => {
  const graph = (op: 'commit' | 'push'): Workflow => {
    const wf = pipelineWorkflow([])
    const git: WfNode = op === 'push' ? { id: 'push', type: 'git', operation: 'push', x: 0, y: 0 } : { id: 'commit', type: 'git', operation: 'commit', message: 'm', x: 0, y: 0 }
    return { ...wf, nodes: [...wf.nodes, git] }
  }

  it('только у прогона нового формата и только при push', () => {
    const store = newStore()
    assert.equal(workflowPushes(store.getRun(store.createGlobalTask({ title: 'a', workflow: graph('push') }).id)!), true)
    assert.equal(workflowPushes(store.getRun(store.createGlobalTask({ title: 'b', workflow: graph('commit') }).id)!), false)
    assert.equal(workflowPushes(store.getRun(store.createGlobalTask({ title: 'c' }).id)!), false)
  })

  it('RunBranchSync не пушит закрытый прогон с git push в графе, а без него — пушит', async () => {
    const store = newStore()
    const s = settings({ push: true })
    const withPush = store.createGlobalTask({ title: 'с пушем', workflow: graph('push') })
    const plain = store.createGlobalTask({ title: 'без пуша', workflow: graph('commit') })
    const a = ensureRunBranch(store, repo, withPush.id, s)!
    const b = ensureRunBranch(store, repo, plain.id, s)!
    store.moveGlobalTask(withPush.id, 'review')
    store.moveGlobalTask(plain.id, 'review')
    new RunBranchSync({ isAlive: () => false }).sync(store, repo, s)
    await waitFor(() => store.getRun(plain.id)!.git!.pushedAt !== undefined, 'push прогона без git push в графе')
    assert.equal(store.getRun(withPush.id)!.git!.pushedAt, undefined)
    assert.equal(git(repo, 'ls-remote', 'origin', a.branch), '')
    assert.notEqual(git(repo, 'ls-remote', 'origin', b.branch), '')
  })
})
