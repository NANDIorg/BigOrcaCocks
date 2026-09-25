// Запуск: pnpm --filter @orca-board/desktop test. Нода воркфлоу «Git» на настоящем git-репозитории во временной папке
// (docs/workflow.md → «Нода Git»). PTY нет: startWorker — фейк, повторяющий runWorker + startWorker
// (enterWork, worktree на Task.branch/Task.worktree, dispatch).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES, WORKFLOW_VERSION, validateWorkflow,
  type Task, type Workflow, type WfNode
} from '@orca-board/core'
import { enterWork, handleWorkflowEvents, approvalResolved, type WorkflowDeps } from './workflow'
import { resolveHumanRequest } from './review'
import { gitCreateBranch, gitCheckout, gitCommit, taskWorktreePath } from './git'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

let tmp: string
let repo: string
let store: TaskStore
let started: string[]
let deps: WorkflowDeps

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-wfgit-')))
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  writeFileSync(path.join(repo, 'README.md'), 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  started = []
  deps = {
    store,
    repoRoot: repo,
    run: () => ({ roles: DEFAULT_ROLES }),
    startWorker(taskId, opts) {
      enterWork(deps, taskId)
      const t = task(taskId)
      // Как startWorker (worker.ts): ветка и worktree, уже назначенные нодой git, — приоритет над orca/<id>.
      const branch = t.branch ?? `orca/${taskId}`
      const worktree = t.worktree ?? taskWorktreePath(repo, taskId)
      if (!existsSync(worktree)) {
        const exists = git(repo, 'branch', '--list', branch) !== ''
        git(repo, ...(exists ? ['worktree', 'add', '-q', worktree, branch] : ['worktree', 'add', '-q', '-b', branch, worktree]))
      }
      store.updateTask(taskId, { worktree, branch })
      started.push(taskId)
      const d = store.startDispatch(taskId, `pty_${taskId}_${started.length}`, undefined, { roleId: opts?.roleId ?? t.roleId })
      return { ptyId: d.ptyId, dispatchId: d.id }
    }
  }
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const task = (id: string): Task => store.getTask(id)!
const branchExists = (branch: string): boolean => git(repo, 'branch', '--list', branch) !== ''
const events = (type: string, taskId?: string) => store.listEvents().filter((e) => e.type === type && (taskId === undefined || e.taskId === taskId))
const headOf = (worktree: string): string => git(worktree, 'symbolic-ref', '--short', 'HEAD')

/** Рабочая задача в прогоне с графом: задача создана, `worker start` (enterWork → git → воркер) — как координатор. */
function startTask(wf: Workflow, title = 'Логин через SSO'): Task {
  const run = store.createRun('цель', undefined, wf)
  const t = store.createTask({ title, roleId: 'developer', runId: run.id })
  deps.startWorker(t.id)
  return task(t.id)
}

const node = (n: Partial<WfNode> & { id: string; type: WfNode['type'] }): WfNode => ({ x: 0, y: 0, ...n }) as WfNode

/** start → git(<params>) → work → merge → end; `error` — к человеку. */
function graph(gitNode: Record<string, unknown>, opts: { errorTo?: 'human' | 'work' | 'none'; tail?: 'merge' | 'end' } = {}): Workflow {
  const errorTo = opts.errorTo ?? 'human'
  const nodes: WfNode[] = [
    node({ id: 'start', type: 'start' }),
    node({ id: 'git', type: 'git', ...gitNode } as never),
    node({ id: 'work', type: 'work' }),
    node({ id: 'merge', type: 'merge' }),
    node({ id: 'end', type: 'end', merged: true }),
    node({ id: 'human', type: 'human', title: 'Не удалось' })
  ]
  const edges: Workflow['edges'] = [
    { id: 'e1', from: 'start', outcome: 'next', to: 'git' },
    { id: 'e2', from: 'git', outcome: 'ok', to: 'work' },
    { id: 'e3', from: 'work', outcome: 'next', to: 'merge' },
    { id: 'e4', from: 'merge', outcome: 'ok', to: 'end' },
    { id: 'e4c', from: 'merge', outcome: 'conflict', to: 'human' },
    { id: 'e5', from: 'human', outcome: 'accept', to: 'git' },
    { id: 'e6', from: 'human', outcome: 'reject', to: 'work' }
  ]
  if (errorTo !== 'none') edges.push({ id: 'e7', from: 'git', outcome: 'error', to: errorTo })
  return { version: WORKFLOW_VERSION, nodes, edges }
}

/** worker `done` текущего запуска + доставка событий исполнителю (как подписка в index.ts). */
function done(taskId: string): void {
  const before = store.listEvents().length
  store.finishDispatch(task(taskId).dispatchId!, 'сделал', [])
  handleWorkflowEvents(deps, store.listEvents().slice(before))
}

function commitFile(t: Task, file: string, text: string): void {
  writeFileSync(path.join(t.worktree!, file), text)
  git(t.worktree!, 'add', '-A')
  git(t.worktree!, 'commit', '-qm', `add ${file}`)
}

describe('нода «Git»: create_branch до первой «Работы»', () => {
  it('worktree создаётся сразу на новой ветке от текущей ветки корня; orca/<id> не заводится; воркер стартует один раз', () => {
    const t = startTask(graph({ operation: 'create_branch', branch: 'feature/{taskId}-{slug}' }))
    const branch = `feature/${t.id}-login-cherez-sso`
    assert.equal(t.branch, branch)
    assert.equal(t.worktree, taskWorktreePath(repo, t.id))
    assert.equal(headOf(t.worktree!), branch)
    assert.equal(branchExists(`orca/${t.id}`), false)
    assert.equal(t.stage?.nodeId, 'work')
    assert.equal(t.branchForeign, undefined)
    assert.deepEqual(started, [t.id], 'enterWork не запустил воркера второй раз')
    assert.equal(events('workflow_blocked', t.id).length, 0)
  })

  it('merge после смены ветки сливает актуальную ветку и убирает её; в корне — коммиты задачи', () => {
    const t = startTask(graph({ operation: 'create_branch', branch: 'feature/{taskId}' }))
    commitFile(t, 'sso.ts', 'export {}\n')
    done(t.id)
    assert.equal(task(t.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'sso.ts')), true)
    assert.equal(branchExists(`feature/${t.id}`), false, 'своя ветка убрана как обычно')
    assert.equal(existsSync(t.worktree!), false)
    assert.equal(task(t.id).branch, undefined)
    assert.match(git(repo, 'log', '--oneline', '-3'), /Merge orca task: Логин через SSO/)
  })

  it('base: ветка создаётся от указанной, а не от текущей ветки корня', () => {
    git(repo, 'branch', 'develop')
    git(repo, 'switch', '-q', 'develop')
    writeFileSync(path.join(repo, 'dev.txt'), 'dev\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'dev')
    git(repo, 'switch', '-q', 'master')
    const t = startTask(graph({ operation: 'create_branch', branch: 'feature/x', base: 'develop' }))
    assert.equal(existsSync(path.join(t.worktree!, 'dev.txt')), true)
  })

  it('detached HEAD корня: базой служит его коммит, а не слово HEAD', () => {
    const sha = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'switch', '-q', '--detach')
    const t = startTask(graph({ operation: 'create_branch', branch: 'feature/detached' }))
    assert.equal(git(t.worktree!, 'rev-parse', 'HEAD'), sha)
  })

  it('ветка уже есть → исход error: feedback с текстом, запрос человеку с причиной, воркер не запущен', () => {
    git(repo, 'branch', 'feature/busy')
    const run = store.createRun('цель', undefined, graph({ operation: 'create_branch', branch: 'feature/busy' }))
    const t = store.createTask({ title: 'Занято', roleId: 'developer', runId: run.id })
    assert.throws(() => deps.startWorker(t.id), /воркер не запущен: до работы задача остановилась на этапе «Не удалось»/)
    assert.equal(started.length, 0)
    assert.equal(task(t.id).stage?.nodeId, 'human')
    assert.match(task(t.id).feedback ?? '', /ветка «feature\/busy» уже существует/)
    const request = store.pendingRequests().find((r) => r.taskId === t.id)!
    assert.equal(request.kind, 'approval')
    assert.match(request.body ?? '', /Git-операция «create_branch» не удалась/)
    assert.match(request.body ?? '', /уже существует/)
    assert.equal(task(t.id).worktree, undefined, 'worktree не создан')
  })

  it('error ведёт в «Работу»: воркер стартует на ветке orca/<id>, причина — в feedback (попадёт в промпт)', () => {
    git(repo, 'branch', 'feature/busy')
    const t = startTask(graph({ operation: 'create_branch', branch: 'feature/busy' }, { errorTo: 'work' }))
    assert.equal(t.stage?.nodeId, 'work')
    assert.equal(t.branch, `orca/${t.id}`)
    assert.match(t.feedback ?? '', /уже существует/)
  })

  it('нет перехода «error» → workflow_blocked с причиной git по-русски, задача остаётся на ноде', () => {
    git(repo, 'branch', 'feature/busy')
    const run = store.createRun('цель', undefined, graph({ operation: 'create_branch', branch: 'feature/busy' }, { errorTo: 'none' }))
    const t = store.createTask({ title: 'Занято', roleId: 'developer', runId: run.id })
    assert.throws(() => deps.startWorker(t.id), /воркер не запущен/)
    const blocked = events('workflow_blocked', t.id)
    assert.equal(blocked.length, 1)
    assert.match(String(blocked[0].payload.reason), /нет перехода «error»/)
    assert.match(String(blocked[0].payload.reason), /уже существует/)
    assert.equal(task(t.id).stage?.nodeId, 'git')
  })

  it('недопустимое имя ветки после подстановки — workflow_blocked (настройка), git не запускался', () => {
    const run = store.createRun('цель', undefined, graph({ operation: 'create_branch', branch: 'feature/{slug}.' }))
    const t = store.createTask({ title: 'Плохое имя', roleId: 'developer', runId: run.id })
    assert.throws(() => deps.startWorker(t.id), /воркер не запущен/)
    const blocked = events('workflow_blocked', t.id)
    assert.match(String(blocked[0].payload.reason), /имя ветки «feature\/plohoe-imya\.» после подстановки недопустимо для git/)
    assert.equal(task(t.id).feedback, undefined)
    assert.equal(branchExists('feature/plohoe-imya.'), false)
  })

  it('повторный заход (worker start на возвращённой задаче): create_branch на своей же ветке — не ошибка', () => {
    const t = startTask(graph({ operation: 'create_branch', branch: 'feature/again' }))
    commitFile(t, 'a.ts', 'a\n')
    // Задача ушла на «Работе» в done, воркер перезапущен вручную: этап сбрасывается на первый (git).
    store.finishDispatch(task(t.id).dispatchId!, 'сделал', [])
    store.moveTask(t.id, store.columnId('ready'))
    const entered = enterWork(deps, t.id)
    assert.deepEqual(entered, {})
    assert.equal(task(t.id).stage?.nodeId, 'work')
    assert.equal(task(t.id).branch, 'feature/again')
    assert.equal(events('workflow_blocked', t.id).length, 0)
    assert.equal(task(t.id).feedback, undefined)
  })
})

describe('нода «Git»: checkout', () => {
  it('существующая ветка: worktree на ней, ветка «чужая» — после merge она остаётся, слияние идёт в текущую ветку корня', () => {
    git(repo, 'branch', 'develop')
    const t = startTask(graph({ operation: 'checkout', branch: 'develop' }))
    assert.equal(headOf(t.worktree!), 'develop')
    assert.equal(t.branch, 'develop')
    assert.equal(t.branchForeign, true)
    assert.equal(branchExists(`orca/${t.id}`), false)
    commitFile(t, 'on-develop.ts', 'x\n')
    done(t.id)
    assert.equal(task(t.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'on-develop.ts')), true, 'влито в master')
    assert.equal(branchExists('develop'), true, 'чужую ветку уборка не удаляет')
    assert.equal(existsSync(t.worktree!), false)
    assert.equal(task(t.id).branchForeign, undefined)
    assert.equal(task(t.id).branch, undefined)
  })

  it('ветки нет → error', () => {
    const run = store.createRun('цель', undefined, graph({ operation: 'checkout', branch: 'nope' }))
    const t = store.createTask({ title: 'Нет ветки', roleId: 'developer', runId: run.id })
    assert.throws(() => deps.startWorker(t.id), /воркер не запущен/)
    assert.match(task(t.id).feedback ?? '', /ветки «nope» нет/)
  })

  it('ветка занята другим worktree (текущая ветка корня) → error, а не тихое переключение', () => {
    const run = store.createRun('цель', undefined, graph({ operation: 'checkout', branch: 'master' }))
    const t = store.createTask({ title: 'Занято корнем', roleId: 'developer', runId: run.id })
    assert.throws(() => deps.startWorker(t.id), /воркер не запущен/)
    assert.match(task(t.id).feedback ?? '', /^git worktree add .*master/)
    assert.equal(task(t.id).branchForeign, undefined)
  })
})

describe('нода «Git»: commit и push в середине графа', () => {
  /** start → work → git(commit) → git(push) → end (без мержа). */
  const pushGraph = (remote?: string): Workflow => ({
    version: WORKFLOW_VERSION,
    nodes: [
      node({ id: 'start', type: 'start' }),
      node({ id: 'work', type: 'work' }),
      node({ id: 'commit', type: 'git', operation: 'commit', message: 'feat: {title} ({taskId})' } as never),
      node({ id: 'push', type: 'git', operation: 'push', ...(remote ? { remote } : {}) } as never),
      node({ id: 'end', type: 'end' }),
      node({ id: 'human', type: 'human', title: 'Не запушилось' })
    ],
    edges: [
      { id: 'e1', from: 'start', outcome: 'next', to: 'work' },
      { id: 'e2', from: 'work', outcome: 'next', to: 'commit' },
      { id: 'e3', from: 'commit', outcome: 'ok', to: 'push' },
      { id: 'e4', from: 'commit', outcome: 'error', to: 'human' },
      { id: 'e5', from: 'push', outcome: 'ok', to: 'end' },
      { id: 'e6', from: 'push', outcome: 'error', to: 'human' },
      { id: 'e7', from: 'human', outcome: 'accept', to: 'push' },
      { id: 'e8', from: 'human', outcome: 'reject', to: 'work' }
    ]
  })

  it('пушит коммит на remote и выставляет upstream; конец без мержа сохраняет ветку', () => {
    const remote = path.join(tmp, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    git(repo, 'remote', 'add', 'origin', remote)
    const t = startTask(pushGraph())
    writeFileSync(path.join(t.worktree!, 'draft.ts'), 'draft\n')
    done(t.id)
    assert.equal(task(t.id).status, 'done')
    assert.match(git(remote, 'log', '--format=%s', `orca/${t.id}`), /feat: Логин через SSO \(task_/)
    assert.equal(git(repo, 'config', `branch.orca/${t.id}.remote`), 'origin', 'upstream выставлен')
    assert.equal(branchExists(`orca/${t.id}`), true)
  })

  it('нет remote → error: запрос человеку с текстом git; «Принять» после исправления повторяет push', () => {
    const t = startTask(pushGraph())
    commitFile(t, 'a.ts', 'a\n')
    done(t.id)
    assert.equal(task(t.id).stage?.nodeId, 'human')
    const request = store.pendingRequests().find((r) => r.taskId === t.id)!
    assert.match(request.body ?? '', /Git-операция «push» не удалась/)
    assert.match(request.body ?? '', /git push -u origin orca\/task_/)
    assert.match(task(t.id).feedback ?? '', /origin/)
    // Человек добавил remote и принял: push повторяется и доходит до конца.
    const remote = path.join(tmp, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    git(repo, 'remote', 'add', 'origin', remote)
    resolveHumanRequest(store, repo, request.id, { action: 'accept' }, deps.startWorker, (r) => approvalResolved(deps, r))
    assert.equal(task(t.id).status, 'done')
    assert.match(git(remote, 'log', '--format=%s', `orca/${t.id}`), /add a.ts/)
  })

  it('commit: нечего коммитить — тоже ok; изменения коммитятся от orca-board', () => {
    const t = startTask(pushGraph('origin'))
    assert.equal(git(t.worktree!, 'status', '--porcelain'), '')
    const before = git(t.worktree!, 'rev-list', '--count', 'HEAD')
    gitCommit(t.worktree!, 'noop')
    assert.equal(git(t.worktree!, 'rev-list', '--count', 'HEAD'), before, 'пустой коммит не создан')
    writeFileSync(path.join(t.worktree!, 'b.ts'), 'b\n')
    gitCommit(t.worktree!, 'feat: b')
    assert.equal(git(t.worktree!, 'log', '--format=%an %s', '-1'), 'orca-board feat: b')
  })

  it('push до создания ветки (нода первой): error «нет ветки», а не падение', () => {
    const wf: Workflow = {
      version: WORKFLOW_VERSION,
      nodes: [node({ id: 'start', type: 'start' }), node({ id: 'push', type: 'git', operation: 'push' } as never), node({ id: 'work', type: 'work' }), node({ id: 'human', type: 'human' })],
      edges: [
        { id: 'e1', from: 'start', outcome: 'next', to: 'push' },
        { id: 'e2', from: 'push', outcome: 'ok', to: 'work' },
        { id: 'e3', from: 'push', outcome: 'error', to: 'human' }
      ]
    }
    const run = store.createRun('цель', undefined, wf)
    const t = store.createTask({ title: 'Рано', roleId: 'developer', runId: run.id })
    assert.throws(() => deps.startWorker(t.id), /воркер не запущен/)
    assert.match(task(t.id).feedback ?? '', /у задачи нет ветки/)
  })
})

describe('нода «Git»: смена ветки посреди работы и защита данных', () => {
  it('create_branch на грязном worktree → error, ветка не переключена, правки на месте', () => {
    const wf: Workflow = {
      version: WORKFLOW_VERSION,
      nodes: [
        node({ id: 'start', type: 'start' }), node({ id: 'work', type: 'work' }),
        node({ id: 'git', type: 'git', operation: 'create_branch', branch: 'feature/late' } as never),
        node({ id: 'human', type: 'human' }), node({ id: 'end', type: 'end' })
      ],
      edges: [
        { id: 'e1', from: 'start', outcome: 'next', to: 'work' },
        { id: 'e2', from: 'work', outcome: 'next', to: 'git' },
        { id: 'e3', from: 'git', outcome: 'ok', to: 'end' },
        { id: 'e4', from: 'git', outcome: 'error', to: 'human' }
      ]
    }
    const run = store.createRun('цель', undefined, wf)
    const t0 = store.createTask({ title: 'Поздно', roleId: 'developer', runId: run.id })
    deps.startWorker(t0.id)
    const t = task(t0.id)
    writeFileSync(path.join(t.worktree!, 'wip.ts'), 'wip\n')
    done(t.id)
    assert.equal(task(t.id).stage?.nodeId, 'human')
    assert.match(task(t.id).feedback ?? '', /незакоммиченные изменения/)
    assert.equal(headOf(t.worktree!), `orca/${t.id}`)
    assert.equal(existsSync(path.join(t.worktree!, 'wip.ts')), true)
    assert.equal(task(t.id).branch, `orca/${t.id}`)
  })

  it('create_branch посреди работы на чистом worktree: Task.branch обновлена, дальше review/merge идут по ней', () => {
    const wf: Workflow = {
      version: WORKFLOW_VERSION,
      nodes: [
        node({ id: 'start', type: 'start' }), node({ id: 'work', type: 'work' }),
        node({ id: 'git', type: 'git', operation: 'create_branch', branch: 'release/{taskId}' } as never),
        node({ id: 'human', type: 'human' }), node({ id: 'merge', type: 'merge' }), node({ id: 'end', type: 'end', merged: true })
      ],
      edges: [
        { id: 'e1', from: 'start', outcome: 'next', to: 'work' },
        { id: 'e2', from: 'work', outcome: 'next', to: 'git' },
        { id: 'e3', from: 'git', outcome: 'ok', to: 'merge' },
        { id: 'e4', from: 'git', outcome: 'error', to: 'human' },
        { id: 'e5', from: 'merge', outcome: 'ok', to: 'end' }
      ]
    }
    const run = store.createRun('цель', undefined, wf)
    const t0 = store.createTask({ title: 'Середина', roleId: 'developer', runId: run.id })
    deps.startWorker(t0.id)
    commitFile(task(t0.id), 'mid.ts', 'x\n')
    done(t0.id)
    assert.equal(task(t0.id).status, 'done')
    // Без `base` ветвимся от места, где стоит worktree: коммит с orca/<id> уехал в release/<id> и слит.
    assert.equal(existsSync(path.join(repo, 'mid.ts')), true)
    assert.equal(branchExists(`release/${t0.id}`), false, 'ветка, созданная нодой, убрана как своя')
    assert.equal(branchExists(`orca/${t0.id}`), true, 'прежняя orca/<id> остаётся на месте')
  })
})

describe('git.ts: функции ноды', () => {
  it('create_branch на существующем worktree: чистый — переключает; грязный — отказ с подсказкой про commit', () => {
    const wt = path.join(tmp, 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'orca/t', wt)
    gitCreateBranch(repo, wt, 'feature/a', undefined, false)
    assert.equal(headOf(wt), 'feature/a')
    writeFileSync(path.join(wt, 'dirty.ts'), 'x\n')
    assert.throws(() => gitCreateBranch(repo, wt, 'feature/b', undefined, false), /незакоммиченные изменения.*commit/)
    assert.equal(headOf(wt), 'feature/a')
    assert.equal(branchExists('feature/b'), false)
  })

  it('своя ветка без worktree (конец без мержа) — worktree ставится на неё; чужая существующая — отказ', () => {
    git(repo, 'branch', 'feature/kept')
    const wt = path.join(tmp, 'wt2')
    assert.throws(() => gitCreateBranch(repo, wt, 'feature/kept', undefined, false), /уже существует/)
    gitCreateBranch(repo, wt, 'feature/kept', undefined, true)
    assert.equal(headOf(wt), 'feature/kept')
  })

  it('нет базовой ветки → понятная ошибка; checkout несуществующей — тоже', () => {
    assert.throws(() => gitCreateBranch(repo, path.join(tmp, 'wt3'), 'feature/z', 'no-such-base', false), /базовой ветки «no-such-base» нет/)
    assert.throws(() => gitCheckout(repo, path.join(tmp, 'wt4'), 'no-such'), /ветки «no-such» нет/)
  })

  it('не git-репозиторий → ошибка git, а не исключение другого рода', () => {
    const plain = path.join(tmp, 'plain')
    execFileSync('mkdir', [plain])
    assert.throws(() => gitCommit(path.join(plain, 'nope'), 'm'), /у задачи нет worktree/)
    assert.throws(() => gitCreateBranch(plain, path.join(tmp, 'wt5'), 'f/x', undefined, false), /git|нет/)
  })

  it('граф с нодой git проходит validateWorkflow (проверка тестового графа)', () => {
    const { errors } = validateWorkflow(graph({ operation: 'create_branch', branch: 'feature/{taskId}-{slug}' }), { roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS })
    assert.deepEqual(errors, [])
  })
})
