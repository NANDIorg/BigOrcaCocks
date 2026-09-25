// Запуск: pnpm --filter @orca-board/desktop test. Ветка глобальной задачи на настоящем git: временный репозиторий
// и bare-remote в отдельной папке, рабочий репозиторий не трогается.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, normalizeRunBranchSettings, type RunBranchSettings, type Task } from '@orca-board/core'
import { ensureRunBranch, mergeTarget, reviewBase, RunBranchSync, runWorktreePath } from './run-branch'
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

describe('RunBranchSync: PR через gh', () => {
  type GhCall = { args: string[]; cwd: string; body?: string }

  /** Поддельный gh: `view` отвечает по `view`, `create` — по `create`; тело PR читается до удаления файла. */
  function fakeGh(behavior: { view?: () => string; create?: () => string } = {}): { calls: GhCall[]; gh: (args: string[], cwd: string) => Promise<string> } {
    const calls: GhCall[] = []
    const gh = async (args: string[], cwd: string): Promise<string> => {
      const call: GhCall = { args, cwd }
      const bf = args.indexOf('--body-file')
      if (bf >= 0) call.body = readFileSync(args[bf + 1], 'utf8')
      calls.push(call)
      if (args[1] === 'view') {
        if (!behavior.view) throw Object.assign(new Error('no pull requests found'), { stderr: 'no pull requests found for branch' })
        return behavior.view()
      }
      return behavior.create ? behavior.create() : 'https://github.com/o/r/pull/7\n'
    }
    return { calls, gh }
  }

  const arg = (c: GhCall, name: string): string => c.args[c.args.indexOf(name) + 1]

  /** Глобальная задача с веткой; push включён, `pr` — по умолчанию тоже. */
  function closedRun(patch: Partial<RunBranchSettings> = {}): { store: TaskStore; runId: string; s: RunBranchSettings } {
    const store = newStore()
    const run = store.createGlobalTask({ title: 'Фича', description: 'Описание задачи' })
    const s = settings({ push: true, pr: true, base: 'origin/develop', ...patch })
    ensureRunBranch(store, repo, run.id, s)
    return { store, runId: run.id, s }
  }

  it('PR открывается только после успешного push, база — из RunGit.base без префикса remote', async () => {
    const { store, runId, s } = closedRun()
    const { calls, gh } = fakeGh()
    const sync = new RunBranchSync({ isAlive: () => false, gh })

    sync.sync(store, repo, s)
    assert.equal(calls.length, 0, 'ветка не закрыта и не отправлена — PR не нужен')

    store.moveGlobalTask(runId, 'review')
    sync.sync(store, repo, s)
    await waitFor(() => store.getRun(runId)!.git!.prUrl !== undefined, 'prUrl')
    const g = store.getRun(runId)!.git!
    assert.equal(g.prUrl, 'https://github.com/o/r/pull/7')
    assert.equal(g.prError, undefined)
    assert.notEqual(g.pushedAt, undefined)
    const create = calls.find((c) => c.args[1] === 'create')!
    assert.equal(arg(create, '--head'), g.branch)
    assert.equal(arg(create, '--base'), 'develop')
    assert.equal(arg(create, '--title'), 'Фича')
    assert.equal(create.args.includes('--draft'), false, 'обычный PR')
    assert.equal(create.body, 'Описание задачи', 'без сводки координатора — описание глобальной задачи')
    assert.equal(existsSync(arg(create, '--body-file')), false, 'временный файл удалён')
  })

  it('неудачный push — gh не вызывается', async () => {
    const { store, runId, s } = closedRun({ remote: 'nope' })
    const { calls, gh } = fakeGh()
    const sync = new RunBranchSync({ isAlive: () => false, gh })
    store.moveGlobalTask(runId, 'review')
    sync.sync(store, repo, s)
    await waitFor(() => store.getRun(runId)!.git!.pushError !== undefined, 'ошибка push')
    assert.equal(calls.length, 0)
  })

  it('тело PR — итоговая сводка координатора', async () => {
    const { store, runId, s } = closedRun()
    const { calls, gh } = fakeGh()
    const sync = new RunBranchSync({ isAlive: () => false, gh })
    store.moveGlobalTask(runId, 'review')
    store.finishRun(runId, 'Итог работы')
    sync.sync(store, repo, s)
    await waitFor(() => store.getRun(runId)!.git!.prUrl !== undefined, 'prUrl')
    assert.equal(calls.find((c) => c.args[1] === 'create')!.body, 'Итог работы')
  })

  it('ошибка gh — в prError и не повторяется на каждом изменении доски; после нового push — повтор', async () => {
    const { store, runId, s } = closedRun()
    let fail = true
    const { calls, gh } = fakeGh({ create: () => { if (fail) throw Object.assign(new Error('x'), { stderr: 'GraphQL: forbidden' }); return 'https://github.com/o/r/pull/8\n' } })
    const sync = new RunBranchSync({ isAlive: () => false, gh })
    store.moveGlobalTask(runId, 'review')
    sync.sync(store, repo, s)
    await waitFor(() => store.getRun(runId)!.git!.prError !== undefined, 'prError')
    assert.equal(store.getRun(runId)!.git!.prError, 'GraphQL: forbidden')
    const n = calls.length
    sync.sync(store, repo, s)
    sync.sync(store, repo, s)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(calls.length, n, 'повтора нет')

    // Новый push (новый pushedAt) снимает запрет.
    fail = false
    store.setRunGit(runId, { pushedAt: Date.now() + 1000 })
    sync.sync(store, repo, s)
    await waitFor(() => store.getRun(runId)!.git!.prUrl !== undefined, 'prUrl после повтора')
    assert.equal(store.getRun(runId)!.git!.prError, undefined)
  })

  it('уже открытый PR подхватывается без create; закрытый — нет', async () => {
    const { store, runId, s } = closedRun()
    const open = fakeGh({ view: () => JSON.stringify({ url: 'https://github.com/o/r/pull/3', state: 'OPEN' }) })
    const sync = new RunBranchSync({ isAlive: () => false, gh: open.gh })
    store.moveGlobalTask(runId, 'review')
    sync.sync(store, repo, s)
    await waitFor(() => store.getRun(runId)!.git!.prUrl !== undefined, 'prUrl')
    assert.equal(store.getRun(runId)!.git!.prUrl, 'https://github.com/o/r/pull/3')
    assert.equal(open.calls.some((c) => c.args[1] === 'create'), false)

    const b = closedRun()
    const closed = fakeGh({ view: () => JSON.stringify({ url: 'https://github.com/o/r/pull/2', state: 'MERGED' }) })
    const sync2 = new RunBranchSync({ isAlive: () => false, gh: closed.gh })
    b.store.moveGlobalTask(b.runId, 'review')
    sync2.sync(b.store, repo, b.s)
    await waitFor(() => b.store.getRun(b.runId)!.git!.prUrl !== undefined, 'prUrl нового PR')
    assert.equal(b.store.getRun(b.runId)!.git!.prUrl, 'https://github.com/o/r/pull/7')
  })

  it('без базы PR (пустая база — текущая ветка корня, не ветка на remote) — prError, gh create не вызывается', async () => {
    const { store, runId, s } = closedRun()
    store.setRunGit(runId, { base: 'deadbeef1234' })
    const { calls, gh } = fakeGh()
    const sync = new RunBranchSync({ isAlive: () => false, gh })
    store.moveGlobalTask(runId, 'review')
    sync.sync(store, repo, s)
    await waitFor(() => store.getRun(runId)!.git!.prError !== undefined, 'prError')
    assert.match(store.getRun(runId)!.git!.prError!, /не удалось определить базу PR/)
    assert.equal(calls.some((c) => c.args[1] === 'create'), false)
  })

  it('gh не установлен (ENOENT) — понятная подсказка в prError', async () => {
    const { store, runId, s } = closedRun()
    const sync = new RunBranchSync({ isAlive: () => false, gh: async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) } })
    store.moveGlobalTask(runId, 'review')
    sync.sync(store, repo, s)
    await waitFor(() => store.getRun(runId)!.git!.prError !== undefined, 'prError')
    assert.equal(store.getRun(runId)!.git!.prError, 'gh не установлен (https://cli.github.com)')
  })

  it('pr выключен — gh не вызывается; уже отправленная ветка получает PR по включению настройки', async () => {
    const { store, runId, s } = closedRun({ pr: false })
    const { calls, gh } = fakeGh()
    const sync = new RunBranchSync({ isAlive: () => false, gh })
    store.moveGlobalTask(runId, 'review')
    sync.sync(store, repo, s)
    await waitFor(() => store.getRun(runId)!.git!.pushedAt !== undefined, 'push')
    assert.equal(calls.length, 0)

    sync.sync(store, repo, { ...s, pr: true })
    await waitFor(() => store.getRun(runId)!.git!.prUrl !== undefined, 'prUrl')
  })
})
