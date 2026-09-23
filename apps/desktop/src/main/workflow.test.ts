// Запуск: pnpm --filter @orca-board/desktop test. Исполнитель воркфлоу на настоящем git-репозитории:
// PTY не участвуют — startWorker фейк, повторяющий контракт runWorker (enterWork + startDispatch).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES, WORKFLOW_VERSION, type Role, type Workflow, type Task
} from '@orca-board/core'
import { enterWork, handleWorkflowEvents, reviewAccept, reviewReject, approvalResolved, type WorkflowDeps } from './workflow'
import { resolveHumanRequest } from './review'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

let tmp: string
let repo: string
let store: TaskStore
let roles: Role[]
let started: string[]
let deps: WorkflowDeps

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-wf-')))
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  writeFileSync(path.join(repo, 'README.md'), 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  roles = DEFAULT_ROLES
  started = []
  deps = {
    store,
    repoRoot: repo,
    roles: () => roles,
    // Как runWorker: задача входит в воркфлоу / на этап «Работа», затем dispatch.
    startWorker(taskId) {
      enterWork(deps, taskId)
      started.push(taskId)
      const d = store.startDispatch(taskId, `pty_${taskId}_${started.length}`)
      return { ptyId: d.ptyId, dispatchId: d.id }
    }
  }
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const task = (id: string): Task => store.getTask(id)!
const branchExists = (branch: string): boolean => git(repo, 'branch', '--list', branch) !== ''
const events = (type: string, taskId?: string) => store.listEvents().filter((e) => e.type === type && (taskId === undefined || e.taskId === taskId))
const gatesOf = (taskId: string): Task[] => store.listTasks().filter((t) => t.gateFor?.taskId === taskId)

/** Рабочая задача в своём worktree на orca/<id>, запущенная (как `worker start` координатора). */
function workTask(title: string, runId?: string): Task {
  const t = store.createTask({ title, roleId: 'developer', ...(runId ? { runId } : {}) })
  const branch = `orca/${t.id}`
  const worktree = path.join(tmp, t.id)
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree)
  store.updateTask(t.id, { worktree, branch })
  deps.startWorker(t.id)
  return task(t.id)
}

/** Коммит в ветке задачи. */
function commit(t: Task, file: string, text: string): void {
  writeFileSync(path.join(t.worktree!, file), text)
  git(t.worktree!, 'add', '-A')
  git(t.worktree!, 'commit', '-qm', file)
}

/** `orca-board done` текущего запуска + доставка событий исполнителю (как подписка в index.ts). */
function done(taskId: string, summary = 'сделал'): void {
  const before = store.listEvents().length
  store.finishDispatch(task(taskId).dispatchId!, summary, [])
  handleWorkflowEvents(deps, store.listEvents().slice(before))
}

describe('дефолтный граф с reviewer = прежнее поведение', () => {
  it('done → проверка стартует сама; review accept → мерж, done; done проверки → она закрыта', () => {
    const a = workTask('Логин')
    commit(a, 'login.ts', 'export {}\n')
    done(a.id)

    assert.equal(task(a.id).stage?.nodeId, 'review')
    assert.equal(task(a.id).status, 'review')
    const [gate] = gatesOf(a.id)
    assert.ok(gate, 'задача-проверка создана')
    assert.equal(gate.roleId, 'reviewer')
    assert.equal(gate.title, 'Ревью: Логин')
    assert.match(gate.spec, new RegExp(`review accept --task ${a.id}`))
    assert.equal(started.at(-1), gate.id, 'воркер проверки запущен приложением')
    assert.equal(events('task_ready', gate.id).length, 0, 'координатору task_ready по проверке не шлётся')

    // Ревьюер: review accept по рабочей задаче, потом свой done.
    reviewAccept(deps, a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(task(a.id).stage?.nodeId, 'end')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true, 'ветка слита в master')
    assert.equal(branchExists(`orca/${a.id}`), false)
    assert.equal(task(a.id).worktree, undefined)

    done(gate.id, 'принято')
    assert.equal(task(gate.id).status, 'done', 'проверка закрыта')
    const doneEvent = events('worker_done', gate.id)[0]
    assert.equal(doneEvent.payload.gateFor, a.id)
  })

  it('review reject → замечания и сразу новый запуск воркера; повторный done → новая проверка', () => {
    const a = workTask('Логин')
    commit(a, 'login.ts', 'v1\n')
    done(a.id)
    const [first] = gatesOf(a.id)

    reviewReject(deps, a.id, 'нет тестов')
    assert.equal(task(a.id).feedback, 'нет тестов')
    assert.equal(task(a.id).stage?.nodeId, 'work')
    assert.equal(task(a.id).stage?.visits.work, 2)
    assert.equal(task(a.id).status, 'in_progress')
    assert.equal(started.at(-1), a.id, 'воркер перезапущен приложением, не координатором')

    done(first.id, 'отклонено')
    assert.equal(task(first.id).status, 'done', 'старая проверка закрыта')

    done(a.id)
    const gates = gatesOf(a.id)
    assert.equal(gates.length, 2)
    assert.equal(task(a.id).stage?.nodeId, 'review')
  })

  it('проверка сдала done без решения — workflow_blocked, проверка остаётся на ревью', () => {
    const a = workTask('Логин')
    done(a.id)
    const [gate] = gatesOf(a.id)
    done(gate.id, 'забыл решить')
    assert.equal(task(a.id).stage?.nodeId, 'review')
    assert.equal(task(gate.id).status, 'review')
    const [blocked] = events('workflow_blocked', a.id)
    assert.match(String(blocked.payload.reason), new RegExp(`task reopen --task ${gate.id} --start`))
  })

  it('проверка вышла без done, но решение уже есть — закрывается сама', () => {
    const a = workTask('Логин')
    done(a.id)
    const [gate] = gatesOf(a.id)
    reviewAccept(deps, a.id)
    const before = store.listEvents().length
    store.ptyExited(store.getDispatch(task(gate.id).dispatchId!)!.ptyId, 1)
    handleWorkflowEvents(deps, store.listEvents().slice(before))
    assert.equal(task(gate.id).status, 'done')
    assert.equal(store.pendingRequests().length, 0, 'эскалация проверки снята')
  })

  it('проверка не запустилась — workflow_blocked с командой перезапуска, рабочая задача ждёт на ревью', () => {
    const a = workTask('Логин')
    const origStart = deps.startWorker
    deps.startWorker = (id) => {
      if (task(id).gateFor) throw new Error('агент claude выключен в проекте')
      return origStart(id)
    }
    done(a.id)
    const [gate] = gatesOf(a.id)
    assert.equal(task(gate.id).status, 'ready')
    assert.equal(task(a.id).status, 'review')
    const [blocked] = events('workflow_blocked', a.id)
    assert.match(String(blocked.payload.reason), new RegExp(`worker start --task ${gate.id}`))
  })
})

describe('дефолтный граф без reviewer — решает человек в Инбоксе', () => {
  beforeEach(() => {
    roles = DEFAULT_ROLES.filter((r) => r.id !== 'reviewer')
  })

  it('done → запрос approval; «Принять» → мерж и done', () => {
    const a = workTask('Логин')
    commit(a, 'login.ts', 'export {}\n')
    done(a.id, 'логин готов')
    const [request] = store.pendingRequests()
    assert.equal(request.kind, 'approval')
    assert.equal(request.nodeId, 'review')
    assert.equal(request.title, 'Ревью человеком: Логин')
    assert.match(request.body ?? '', /логин готов/)
    assert.equal(task(a.id).status, 'needs_input')
    assert.equal(gatesOf(a.id).length, 0)

    resolveHumanRequest(store, repo, request.id, { action: 'accept' }, deps.startWorker, (r) => approvalResolved(deps, r))
    assert.equal(store.getRequest(request.id)!.status, 'resolved')
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true)
  })

  it('«Вернуть» с замечаниями → снова в работу с feedback; review reject из UI решает тот же запрос', () => {
    const a = workTask('Логин')
    done(a.id)
    const [request] = store.pendingRequests()
    resolveHumanRequest(store, repo, request.id, { action: 'reject', text: 'поправь' }, deps.startWorker, (r) => approvalResolved(deps, r))
    assert.equal(task(a.id).feedback, 'поправь')
    assert.equal(task(a.id).status, 'in_progress')
    assert.equal(task(a.id).stage?.nodeId, 'work')

    done(a.id)
    const [second] = store.pendingRequests()
    reviewReject(deps, a.id, 'ещё раз')
    assert.equal(store.getRequest(second.id)!.resolution?.action, 'reject')
    assert.equal(task(a.id).feedback, 'ещё раз')
    assert.equal(task(a.id).status, 'in_progress')
  })

  it('конфликт мержа → запрос «Конфликт мержа» с текстом ошибки; после разрешения «Принять» сливает', () => {
    const a = workTask('Логин')
    commit(a, 'README.md', 'из ветки\n')
    writeFileSync(path.join(repo, 'README.md'), 'из master\n')
    git(repo, 'commit', '-qam', 'master')
    done(a.id)
    const [review] = store.pendingRequests()
    resolveHumanRequest(store, repo, review.id, { action: 'accept' }, deps.startWorker, (r) => approvalResolved(deps, r))

    assert.equal(task(a.id).stage?.nodeId, 'conflict')
    const [conflict] = store.pendingRequests()
    assert.equal(conflict.kind, 'approval')
    assert.equal(conflict.nodeId, 'conflict')
    assert.match(conflict.body ?? '', /Мерж не удался/)
    assert.equal(branchExists(`orca/${a.id}`), true, 'ветка на месте')

    // Человек разрешил конфликт в ветке задачи.
    git(a.worktree!, 'merge', '-q', 'master', '-X', 'ours', '-m', 'resolve')
    resolveHumanRequest(store, repo, conflict.id, { action: 'accept' }, deps.startWorker, (r) => approvalResolved(deps, r))
    assert.equal(task(a.id).status, 'done')
    assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), 'из ветки\n')
  })
})

describe('свой граф прогона', () => {
  /** start → work → merge → end: без ревью. */
  const noReview: Workflow = {
    version: WORKFLOW_VERSION,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'work', type: 'work', x: 0, y: 0 },
      { id: 'merge', type: 'merge', x: 0, y: 0 },
      { id: 'end', type: 'end', merged: true, x: 0, y: 0 },
      { id: 'h', type: 'human', x: 0, y: 0 }
    ],
    edges: [
      { id: 'e1', from: 'start', outcome: 'next', to: 'work' },
      { id: 'e2', from: 'work', outcome: 'next', to: 'merge' },
      { id: 'e3', from: 'merge', outcome: 'ok', to: 'end' },
      { id: 'e4', from: 'merge', outcome: 'conflict', to: 'h' },
      { id: 'e5', from: 'h', outcome: 'accept', to: 'merge' },
      { id: 'e6', from: 'h', outcome: 'reject', to: 'work' }
    ]
  }

  it('без ревью: done сразу сливает ветку по снимку прогона', () => {
    const run = store.createRun('цель', undefined, noReview)
    const a = workTask('Логин', run.id)
    commit(a, 'login.ts', 'x\n')
    done(a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true)
    assert.equal(gatesOf(a.id).length, 0)
  })

  it('конец без мержа: задача в done, worktree убран, ветка сохранена', () => {
    const wf: Workflow = {
      version: WORKFLOW_VERSION,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'work', type: 'work', x: 0, y: 0 },
        { id: 'end', type: 'end', x: 0, y: 0 }
      ],
      edges: [
        { id: 'e1', from: 'start', outcome: 'next', to: 'work' },
        { id: 'e2', from: 'work', outcome: 'next', to: 'end' }
      ]
    }
    const run = store.createRun('цель', undefined, wf)
    const a = workTask('Черновик', run.id)
    writeFileSync(path.join(a.worktree!, 'draft.md'), 'черновик\n')
    done(a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(a.worktree!), false)
    assert.equal(task(a.id).branch, `orca/${a.id}`)
    assert.equal(branchExists(`orca/${a.id}`), true)
    assert.equal(existsSync(path.join(repo, 'draft.md')), false, 'в master не попало')
    assert.match(git(repo, 'log', '--oneline', `orca/${a.id}`), /orca: Черновик/, 'хвосты закоммичены в ветку')
  })
})

describe('мимо воркфлоу и возвраты', () => {
  it('задача-ответ: done не трогает воркфлоу, review accept — прежняя приёмка', () => {
    const t = store.createTask({ title: 'Разберись', answerFor: 'coordinator' })
    deps.startWorker(t.id)
    const before = store.listEvents().length
    store.finishDispatch(task(t.id).dispatchId!, 'суть', [], 'ответ')
    handleWorkflowEvents(deps, store.listEvents().slice(before))
    assert.equal(task(t.id).stage, undefined)
    assert.equal(gatesOf(t.id).length, 0)
    reviewAccept(deps, t.id)
    assert.equal(task(t.id).status, 'done')
  })

  it('worker start задачи на этапе проверки возвращает её на «Работу», старая проверка закроется по done', () => {
    const a = workTask('Логин')
    done(a.id)
    const [gate] = gatesOf(a.id)
    deps.startWorker(a.id)
    assert.equal(task(a.id).stage?.nodeId, 'work')
    assert.equal(events('stage_changed', a.id).at(-1)!.payload.outcome, 'restart')
    done(gate.id, 'принято')
    assert.equal(task(gate.id).status, 'done', 'решение проверки уже не нужно')
  })

  it('accept на этапе «Работа» — ошибка с названием этапа', () => {
    const a = workTask('Логин')
    assert.throws(() => reviewAccept(deps, a.id), /этапе «Работа»/)
  })
})
