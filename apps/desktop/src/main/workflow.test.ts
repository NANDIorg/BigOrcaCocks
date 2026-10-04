// Запуск: pnpm --filter @orca-board/desktop test. Исполнитель воркфлоу на настоящем git-репозитории:
// PTY не участвуют — startWorker фейк, повторяющий контракт runWorker (enterWork + startDispatch).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES, WORKFLOW_VERSION_TASK_SCOPE, workerTaskPrompt, defaultWorkflow, legacyDefaultWorkflow, migrateWorkflow, toTaskScopeWorkflow, validateWorkflow,
  type Role, type RunTypeInput, type Workflow, type Task, type Persistence, type StoreSnapshot
} from '@orca-board/core'
import { enterWork, handleWorkflowEvents, resumeStuckStages, reviewAccept, reviewReject, approvalResolved, type WorkflowDeps } from './workflow'
import { OrcaError } from './i18n'
import { resolveHumanRequest } from './review'
import { ProjectManager } from './projects'
import { describeEvent } from './notify'
import { addRetryLimit } from '@orca-board/ui/modules/workflowForm'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

let tmp: string
let repo: string
let store: TaskStore
let roles: Role[]
let started: string[]
/** Роль каждого запуска (Dispatch.roleId) в порядке `started`. */
let startedRoles: string[]
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
  startedRoles = []
  deps = {
    store,
    repoRoot: repo,
    run: () => ({ roles }),
    // Как runWorker: задача входит в воркфлоу / на этап «Работа», затем dispatch; роль этапа «Вопрос человеку»
    // едет в запуск, а не в роль задачи.
    async startWorker(taskId, opts) {
      const entered = await enterWork(deps, taskId)
      const roleId = opts?.roleId ?? entered.roleId ?? task(taskId).roleId
      started.push(taskId)
      startedRoles.push(roleId)
      const d = store.startDispatch(taskId, `pty_${taskId}_${started.length}`, undefined, { roleId })
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
async function workTask(title: string, runId?: string): Promise<Task> {
  const t = store.createTask({ title, roleId: 'developer', ...(runId ? { runId } : {}) })
  const branch = `orca/${t.id}`
  const worktree = path.join(tmp, t.id)
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktree)
  store.updateTask(t.id, { worktree, branch })
  await deps.startWorker(t.id)
  return task(t.id)
}

/** Коммит в ветке задачи. */
function commit(t: Task, file: string, text: string): void {
  writeFileSync(path.join(t.worktree!, file), text)
  git(t.worktree!, 'add', '-A')
  git(t.worktree!, 'commit', '-qm', file)
}

/** Решение запроса человеком (Инбокс / `request resolve`), как `resolveRequest` в index.ts. */
async function resolve(requestId: string, action: 'accept' | 'reject', text?: string): Promise<void> {
  await resolveHumanRequest(store, repo, requestId, { action, ...(text ? { text } : {}) }, deps.startWorker, async (r) => await approvalResolved(deps, r))
}

/** `orca-board done` текущего запуска + доставка событий исполнителю (как подписка в index.ts). */
async function done(taskId: string, summary = 'сделал'): Promise<void> {
  const before = store.listEvents().length
  store.finishDispatch(task(taskId).dispatchId!, summary, [])
  await handleWorkflowEvents(deps, store.listEvents().slice(before))
}

describe('дефолтный граф с reviewer = прежнее поведение', () => {
  it('done → проверка стартует сама; review accept → мерж, done; done проверки → она закрыта', async () => {
    const a = await workTask('Логин')
    commit(a, 'login.ts', 'export {}\n')
    await done(a.id)

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
    await reviewAccept(deps, a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(task(a.id).stage?.nodeId, 'end')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true, 'ветка слита в master')
    assert.equal(branchExists(`orca/${a.id}`), false)
    assert.equal(task(a.id).worktree, undefined)

    await done(gate.id, 'принято')
    assert.equal(task(gate.id).status, 'done', 'проверка закрыта')
    const doneEvent = events('worker_done', gate.id)[0]
    assert.equal(doneEvent.payload.gateFor, a.id)
  })

  it('review reject с картинками → feedbackImages и промпт воркера; следующий reject без картинок их сбрасывает', async () => {
    const a = await workTask('Логин')
    commit(a, 'login.ts', 'v1\n')
    await done(a.id)
    const shot = path.join(task(a.id).worktree!, '.orca-attachments', a.id, 'ret_x1', 'image-1.png')
    await reviewReject(deps, a.id, 'кнопка не там', [shot])
    assert.deepEqual(task(a.id).feedbackImages, [shot])
    assert.ok(workerTaskPrompt(task(a.id)).includes(`\`${shot}\``))
    assert.equal(started.at(-1), a.id, 'воркер перезапущен с картинкой в замечаниях')

    commit(a, 'login.ts', 'v2\n')
    await done(a.id)
    await reviewReject(deps, a.id, 'ещё раз, без скриншота')
    assert.equal(task(a.id).feedbackImages, undefined)
    assert.ok(!workerTaskPrompt(task(a.id)).includes(shot))
  })

  it('review reject → замечания и сразу новый запуск воркера; повторный done → новая проверка', async () => {
    const a = await workTask('Логин')
    commit(a, 'login.ts', 'v1\n')
    await done(a.id)
    const [first] = gatesOf(a.id)

    await reviewReject(deps, a.id, 'нет тестов')
    assert.equal(task(a.id).feedback, 'нет тестов')
    assert.equal(task(a.id).stage?.nodeId, 'work')
    assert.equal(task(a.id).stage?.visits.work, 2)
    assert.equal(task(a.id).status, 'in_progress')
    assert.equal(started.at(-1), a.id, 'воркер перезапущен приложением, не координатором')

    await done(first.id, 'отклонено')
    assert.equal(task(first.id).status, 'done', 'старая проверка закрыта')

    await done(a.id)
    const gates = gatesOf(a.id)
    assert.equal(gates.length, 2)
    assert.equal(task(a.id).stage?.nodeId, 'review')
  })

  it('проверка сдала done без решения — workflow_blocked, проверка остаётся на ревью', async () => {
    const a = await workTask('Логин')
    await done(a.id)
    const [gate] = gatesOf(a.id)
    await done(gate.id, 'забыл решить')
    assert.equal(task(a.id).stage?.nodeId, 'review')
    assert.equal(task(gate.id).status, 'review')
    const [blocked] = events('workflow_blocked', a.id)
    assert.match(String(blocked.payload.reason), new RegExp(`task reopen --task ${gate.id} --start`))
  })

  it('проверка вышла без done, но решение уже есть — закрывается сама', async () => {
    const a = await workTask('Логин')
    await done(a.id)
    const [gate] = gatesOf(a.id)
    await reviewAccept(deps, a.id)
    const before = store.listEvents().length
    store.ptyExited(store.getDispatch(task(gate.id).dispatchId!)!.ptyId, 1)
    await handleWorkflowEvents(deps, store.listEvents().slice(before))
    assert.equal(task(gate.id).status, 'done')
    assert.equal(store.pendingRequests().length, 0, 'эскалация проверки снята')
  })

  it('проверка не запустилась — workflow_blocked с командой перезапуска, рабочая задача ждёт на ревью', async () => {
    const a = await workTask('Логин')
    const origStart = deps.startWorker
    deps.startWorker = async (id) => {
      if (task(id).gateFor) throw new Error('агент claude выключен в проекте')
      return await origStart(id)
    }
    await done(a.id)
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

  it('done → запрос approval; «Принять» → мерж и done', async () => {
    const a = await workTask('Логин')
    commit(a, 'login.ts', 'export {}\n')
    await done(a.id, 'логин готов')
    const [request] = store.pendingRequests()
    assert.equal(request.kind, 'approval')
    assert.equal(request.nodeId, 'review')
    assert.equal(request.title, 'Ревью человеком: Логин')
    assert.match(request.body ?? '', /логин готов/)
    assert.equal(task(a.id).status, 'needs_input')
    assert.equal(gatesOf(a.id).length, 0)

    await resolveHumanRequest(store, repo, request.id, { action: 'accept' }, deps.startWorker, async (r) => await approvalResolved(deps, r))
    assert.equal(store.getRequest(request.id)!.status, 'resolved')
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true)
  })

  it('«Вернуть» с замечаниями → снова в работу с feedback; review reject из UI решает тот же запрос', async () => {
    const a = await workTask('Логин')
    await done(a.id)
    const [request] = store.pendingRequests()
    await resolveHumanRequest(store, repo, request.id, { action: 'reject', text: 'поправь' }, deps.startWorker, async (r) => await approvalResolved(deps, r))
    assert.equal(task(a.id).feedback, 'поправь')
    assert.equal(task(a.id).status, 'in_progress')
    assert.equal(task(a.id).stage?.nodeId, 'work')

    await done(a.id)
    const [second] = store.pendingRequests()
    await reviewReject(deps, a.id, 'ещё раз')
    assert.equal(store.getRequest(second.id)!.resolution?.action, 'reject')
    assert.equal(task(a.id).feedback, 'ещё раз')
    assert.equal(task(a.id).status, 'in_progress')
  })

  it('конфликт мержа → запрос «Конфликт мержа» с текстом ошибки; после разрешения «Принять» сливает', async () => {
    const a = await workTask('Логин')
    commit(a, 'README.md', 'из ветки\n')
    writeFileSync(path.join(repo, 'README.md'), 'из master\n')
    git(repo, 'commit', '-qam', 'master')
    await done(a.id)
    const [review] = store.pendingRequests()
    await resolveHumanRequest(store, repo, review.id, { action: 'accept' }, deps.startWorker, async (r) => await approvalResolved(deps, r))

    assert.equal(task(a.id).stage?.nodeId, 'conflict')
    const [conflict] = store.pendingRequests()
    assert.equal(conflict.kind, 'approval')
    assert.equal(conflict.nodeId, 'conflict')
    assert.match(conflict.body ?? '', /Мерж не удался/)
    assert.equal(branchExists(`orca/${a.id}`), true, 'ветка на месте')

    // Человек разрешил конфликт в ветке задачи.
    git(a.worktree!, 'merge', '-q', 'master', '-X', 'ours', '-m', 'resolve')
    await resolveHumanRequest(store, repo, conflict.id, { action: 'accept' }, deps.startWorker, async (r) => await approvalResolved(deps, r))
    assert.equal(task(a.id).status, 'done')
    assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), 'из ветки\n')
  })
})

/** start → work → merge → end: без ревью. */
const noReview: Workflow = {
  version: WORKFLOW_VERSION_TASK_SCOPE,
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

describe('свой граф прогона', () => {
  it('без ревью: done сразу сливает ветку по снимку прогона', async () => {
    const run = store.createRun('цель', undefined, noReview)
    const a = await workTask('Логин', run.id)
    commit(a, 'login.ts', 'x\n')
    await done(a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true)
    assert.equal(gatesOf(a.id).length, 0)
  })

  it('конец без мержа: задача в done, worktree убран, ветка сохранена', async () => {
    const wf: Workflow = {
      version: WORKFLOW_VERSION_TASK_SCOPE,
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
    const a = await workTask('Черновик', run.id)
    const worktree = a.worktree!
    writeFileSync(path.join(worktree, 'draft.md'), 'черновик\n')
    await done(a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(worktree), false)
    assert.equal(task(a.id).branch, `orca/${a.id}`)
    assert.equal(branchExists(`orca/${a.id}`), true)
    assert.equal(existsSync(path.join(repo, 'draft.md')), false, 'в master не попало')
    assert.match(git(repo, 'log', '--oneline', `orca/${a.id}`), /orca: Черновик/, 'хвосты закоммичены в ветку')
  })
})

/** start → «Дизайн» (work с обязательным показом) → «Выбрать вариант» (human) → merge → end. */
const design: Workflow = {
  version: WORKFLOW_VERSION_TASK_SCOPE,
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'work', type: 'work', title: 'Дизайн', x: 0, y: 0, instructions: 'Сделай макеты', showcase: { what: '2 варианта макета', required: true } },
    { id: 'pick', type: 'human', title: 'Выбрать вариант', x: 0, y: 0 },
    { id: 'merge', type: 'merge', x: 0, y: 0 },
    { id: 'end', type: 'end', merged: true, x: 0, y: 0 }
  ],
  edges: [
    { id: 'e1', from: 'start', outcome: 'next', to: 'work' },
    { id: 'e2', from: 'work', outcome: 'next', to: 'pick' },
    { id: 'e3', from: 'pick', outcome: 'accept', to: 'merge' },
    { id: 'e4', from: 'pick', outcome: 'reject', to: 'work' },
    { id: 'e5', from: 'merge', outcome: 'ok', to: 'end' }
  ]
}

describe('показ человеку: «Работа» с showcase → «человек»', () => {
  /** `done` с показом, как `orca-board done --show-file … --show …`. */
  async function doneWithShowcase(taskId: string, showcase: { text?: string; files: string[] }): Promise<string> {
    const before = store.listEvents().length
    const dispatchId = task(taskId).dispatchId!
    store.finishDispatch(dispatchId, 'макеты готовы', [], undefined, { showcase })
    await handleWorkflowEvents(deps, store.listEvents().slice(before))
    return dispatchId
  }

  it('показ последнего done — в body approval и showcaseDispatchId; «Принять» с выбором — decision в событии, мерж', async () => {
    const run = store.createRun('цель', undefined, design)
    const a = await workTask('Лендинг', run.id)
    assert.throws(() => store.finishDispatch(task(a.id).dispatchId!, 'без показа', []), /требует показ человеку/)
    commit(a, 'a.html', '<p>A</p>\n')
    const dispatchId = await doneWithShowcase(a.id, { text: '## Варианты\n\nA — строгий, B — яркий', files: ['a.html', 'b.png'] })

    const [request] = store.pendingRequests()
    assert.equal(request.kind, 'approval')
    assert.equal(request.nodeId, 'pick')
    assert.equal(request.showcaseDispatchId, dispatchId)
    const body = request.body ?? ''
    assert.match(body, /## Показ/)
    assert.match(body, /A — строгий, B — яркий/)
    assert.match(body, /- `a\.html`\n- `b\.png`/)
    assert.ok(body.indexOf('макеты готовы') < body.indexOf('## Показ'), 'итог воркера — перед показом')

    await resolve(request.id, 'accept', 'вариант B')
    const resolved = events('request_resolved', a.id).at(-1)!
    assert.equal(resolved.payload.decision, 'вариант B')
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'a.html')), true, 'ветка слита')
  })

  it('«Вернуть» → новый done: в новом approval показ нового запуска', async () => {
    const run = store.createRun('цель', undefined, design)
    const a = await workTask('Лендинг', run.id)
    await doneWithShowcase(a.id, { files: ['v1.png'] })
    const [first] = store.pendingRequests()
    await resolve(first.id, 'reject', 'ярче')
    const second = await doneWithShowcase(a.id, { files: ['v2.png'] })
    const [request] = store.pendingRequests()
    assert.notEqual(request.id, first.id)
    assert.equal(request.showcaseDispatchId, second)
    assert.match(request.body ?? '', /v2\.png/)
    assert.doesNotMatch(request.body ?? '', /v1\.png/)
  })

  it('без показа (нода без showcase) — body как раньше, showcaseDispatchId нет', async () => {
    roles = DEFAULT_ROLES.filter((r) => r.id !== 'reviewer')
    const a = await workTask('Логин')
    await done(a.id, 'логин готов')
    const [request] = store.pendingRequests()
    assert.equal(request.showcaseDispatchId, undefined)
    assert.doesNotMatch(request.body ?? '', /## Показ/)
  })
})

describe('мимо воркфлоу и возвраты', () => {
  it('задача-ответ: done не трогает воркфлоу, review accept — прежняя приёмка', async () => {
    const t = store.createTask({ title: 'Разберись', answerFor: 'coordinator' })
    await deps.startWorker(t.id)
    const before = store.listEvents().length
    store.finishDispatch(task(t.id).dispatchId!, 'суть', [], 'ответ')
    await handleWorkflowEvents(deps, store.listEvents().slice(before))
    assert.equal(task(t.id).stage, undefined)
    assert.equal(gatesOf(t.id).length, 0)
    await reviewAccept(deps, t.id)
    assert.equal(task(t.id).status, 'done')
  })

  it('worker start задачи на этапе проверки возвращает её на «Работу», старая проверка закроется по done', async () => {
    const a = await workTask('Логин')
    await done(a.id)
    const [gate] = gatesOf(a.id)
    await deps.startWorker(a.id)
    assert.equal(task(a.id).stage?.nodeId, 'work')
    assert.equal(events('stage_changed', a.id).at(-1)!.payload.outcome, 'restart')
    await done(gate.id, 'принято')
    assert.equal(task(gate.id).status, 'done', 'решение проверки уже не нужно')
  })

  it('accept и reject на этапе «Работа» при живом воркере — review.notReviewable с названием этапа', async () => {
    const a = await workTask('Логин')
    await assert.rejects(async () => await reviewAccept(deps, a.id), (e: unknown) => e instanceof OrcaError && e.key === 'review.notReviewable' && /этапе «Работа»/.test(e.message))
    await assert.rejects(async () => await reviewReject(deps, a.id, 'нет'), (e: unknown) => e instanceof OrcaError && e.key === 'review.notReviewable')
    assert.equal(task(a.id).stage?.nodeId, 'work')
  })
})

/** start → «Уточнить» (ask, роль qa) → «Работа» → мерж → конец. */
const askFirst: Workflow = {
  version: WORKFLOW_VERSION_TASK_SCOPE,
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'ask', type: 'ask', roleId: 'qa', title: 'Уточнить', instructions: 'Спроси, какую БД брать', x: 0, y: 0 },
    { id: 'work', type: 'work', x: 0, y: 0 },
    { id: 'merge', type: 'merge', x: 0, y: 0 },
    { id: 'end', type: 'end', merged: true, x: 0, y: 0 }
  ],
  edges: [
    { id: 'e1', from: 'start', outcome: 'next', to: 'ask' },
    { id: 'e2', from: 'ask', outcome: 'next', to: 'work' },
    { id: 'e3', from: 'work', outcome: 'next', to: 'merge' },
    { id: 'e4', from: 'merge', outcome: 'ok', to: 'end' }
  ]
}

describe('этап «Вопрос человеку» (ask)', () => {
  /** Вопрос воркера на ask при живом координаторе: адресат — человек (как `worker.ask` в socket.ts). */
  const askHuman = (t: Task, question: string): string => {
    const q = store.ask({ taskId: t.id, dispatchId: t.dispatchId, question, options: ['sqlite', 'postgres'] }, { coordinatorAlive: true, forceHuman: true })
    return q.id
  }
  /** Ответ человека в Инбоксе + доставка событий исполнителю (как подписка в index.ts). */
  const humanAnswers = async (questionId: string, text: string): Promise<void> => {
    const before = store.listEvents().length
    const request = store.pendingRequests().find((r) => r.questionId === questionId)!
    store.resolveRequest(request.id, { action: 'answer', text })
    await handleWorkflowEvents(deps, store.listEvents().slice(before))
  }

  it('сквозной: ask первым этапом → вопрос в Инбоксе → ответ → done → «Работа»; роль ask на задачу не переносится', async () => {
    const run = store.createRun('цель', undefined, askFirst)
    const a = await workTask('Хранилище', run.id)
    // Первый запуск вошёл в граф в ask, а не в work.
    assert.equal(task(a.id).stage?.nodeId, 'ask')
    assert.deepEqual(startedRoles, ['qa'], 'Dispatch.roleId — роль ноды')
    assert.equal(store.getDispatch(task(a.id).dispatchId!)!.roleId, 'qa')
    assert.equal(task(a.id).roleId, 'developer', 'роль задачи не изменилась')
    assert.equal(task(a.id).status, 'in_progress')

    const qid = askHuman(task(a.id), 'Какую БД?')
    const request = store.pendingRequests().find((r) => r.questionId === qid)!
    assert.equal(request.kind, 'question')
    assert.equal(request.nodeId, 'ask')
    assert.equal(store.getQuestion(qid)!.nodeId, 'ask')
    assert.equal(task(a.id).status, 'needs_input')

    await humanAnswers(qid, 'sqlite')
    assert.equal(store.getQuestion(qid)!.answer, 'sqlite')
    assert.equal(started.length, 1, 'воркер жив и получит ответ через ask: перезапуска нет')
    assert.equal(task(a.id).stage?.nodeId, 'ask')
    assert.equal(task(a.id).status, 'in_progress', 'ответ вернул задачу в работу')

    await done(a.id, 'выяснил')
    assert.equal(task(a.id).stage?.nodeId, 'work')
    assert.equal(started.length, 2, 'next → «Работа» запущена')
    assert.deepEqual(startedRoles, ['qa', 'developer'], 'следующая «Работа» без своей роли — роль задачи, не опросника')
    assert.equal(task(a.id).roleId, 'developer')
    assert.equal(events('workflow_blocked', a.id).length, 0)
    commit(task(a.id), 'db.ts', 'export {}\n')
    await done(a.id)
    assert.equal(task(a.id).status, 'done', 'дальше мерж и конец')
    assert.equal(existsSync(path.join(repo, 'db.ts')), true)
  })

  it('агент мёртв к моменту ответа: воркер стартует сам, этап не сброшен, роль ноды, ответ в вопросах задачи', async () => {
    const run = store.createRun('цель', undefined, askFirst)
    const a = await workTask('Хранилище', run.id)
    const qid = askHuman(task(a.id), 'Какую БД?')
    store.ptyExited(task(a.id).dispatchId ? store.getDispatch(task(a.id).dispatchId!)!.ptyId : '', 1)
    assert.equal(task(a.id).status, 'needs_input', 'открытый вопрос держит задачу в «Нужен ответ» вместо эскалации')

    await humanAnswers(qid, 'postgres')
    assert.equal(started.length, 2, 'автоперезапуск после ответа')
    assert.deepEqual(startedRoles, ['qa', 'qa'])
    assert.equal(task(a.id).stage?.nodeId, 'ask')
    assert.deepEqual(task(a.id).stage?.visits, { start: 1, ask: 1 }, 'этап не сброшен и не считается повтором')
    assert.equal(task(a.id).roleId, 'developer')
    assert.equal(task(a.id).status, 'in_progress')
    // Ответ уйдёт в промпт нового запуска (startWorker собирает отвеченные вопросы задачи).
    const answered = store.snapshot().questions.filter((q) => q.taskId === a.id && q.answeredAt)
    assert.deepEqual(answered.map((q) => q.answer), ['postgres'])
    assert.equal(events('workflow_blocked', a.id).length, 0)
  })

  it('ответ на вопрос обычного воркера на «Работе» ничего не перезапускает — координатор делает worker start', async () => {
    const a = await workTask('Логин')
    const q = store.ask({ taskId: a.id, dispatchId: task(a.id).dispatchId, question: '?' }, { coordinatorAlive: true })
    store.ptyExited(store.getDispatch(task(a.id).dispatchId!)!.ptyId, 1)
    const before = store.listEvents().length
    store.answer(q.id, 'да')
    await handleWorkflowEvents(deps, store.listEvents().slice(before))
    assert.equal(started.length, 1, 'на «Работе» воркера после ответа стартует координатор, приложение — нет')
  })

  it('автоперезапуск не сработал — workflow_blocked с командой перезапуска, этап остаётся ask', async () => {
    const run = store.createRun('цель', undefined, askFirst)
    const a = await workTask('Хранилище', run.id)
    const qid = askHuman(task(a.id), 'Какую БД?')
    store.ptyExited(store.getDispatch(task(a.id).dispatchId!)!.ptyId, 1)
    deps.startWorker = () => { throw new Error('агент роли выключен') }
    await humanAnswers(qid, 'sqlite')
    const [blocked] = events('workflow_blocked', a.id)
    assert.match(String(blocked.payload.reason), /агент роли выключен[\s\S]*worker start --task/)
    assert.equal(task(a.id).stage?.nodeId, 'ask')
  })

  it('возврат из reject в ask: этап тот же, ответы прошлого захода остаются вопросами задачи', async () => {
    const wf: Workflow = {
      ...askFirst,
      nodes: [...askFirst.nodes, { id: 'pick', type: 'human', x: 0, y: 0 }],
      edges: askFirst.edges.map((e) => (e.id === 'e3' ? { ...e, to: 'pick' } : e)).concat(
        { id: 'e5', from: 'pick', outcome: 'accept', to: 'merge' },
        { id: 'e6', from: 'pick', outcome: 'reject', to: 'ask' }
      )
    }
    const run = store.createRun('цель', undefined, wf)
    const a = await workTask('Хранилище', run.id)
    await humanAnswers(askHuman(task(a.id), 'Какую БД?'), 'sqlite')
    await done(a.id)
    await done(a.id)
    assert.equal(task(a.id).stage?.nodeId, 'pick')
    const request = store.pendingRequests().find((r) => r.kind === 'approval')!
    await resolve(request.id, 'reject', 'спроси ещё про кеш')
    assert.equal(task(a.id).stage?.nodeId, 'ask', 'reject → снова ask, воркер стартовал сразу')
    assert.equal(startedRoles.at(-1), 'qa')
    assert.equal(task(a.id).roleId, 'developer')
    assert.equal(store.snapshot().questions.filter((q) => q.taskId === a.id && q.answeredAt).length, 1, 'старый ответ доступен для промпта')
  })
})

// ---------- сквозные сценарии (QA воркфлоу, docs/workflow.md) ----------

/**
 * Ошибки графа старого движка по подзадачам (версия 1) без тех, что валидация видит у любого такого графа: формат
 * версии 1. Остальное (порты, ссылки, роли гейтов) — проверка того, что тестовый граф собран верно.
 */
function structuralErrors(wf: Workflow): string[] {
  const legacy = ['versionOld']
  return validateWorkflow(wf, { roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS }).errors.filter((e) => !legacy.includes(e.code ?? '')).map((e) => e.message)
}

/** Дефолт с reviewer, после ревью — гейт QA: accept ревью → QA, accept QA → мерж, reject обоих — в работу. */
function reviewThenQa(): Workflow {
  const wf = legacyDefaultWorkflow(DEFAULT_ROLES)
  wf.nodes.push({ id: 'qa', type: 'gate', roleId: 'qa', title: 'QA', x: 550, y: 0 })
  wf.edges = wf.edges.map((e) => (e.id === 'e_review_accept' ? { ...e, to: 'qa' } : e))
  wf.edges.push(
    { id: 'e_qa_accept', from: 'qa', outcome: 'accept', to: 'merge' },
    { id: 'e_qa_reject', from: 'qa', outcome: 'reject', to: 'work' }
  )
  return wf
}

describe('сценарий: гейт QA после ревью', () => {
  it('ревью → QA → мерж; отказ QA возвращает в работу, повтор проходит оба гейта заново', async () => {
    const wf = reviewThenQa()
    assert.deepEqual(structuralErrors(wf), [])
    const run = store.createRun('цель', undefined, wf)
    const a = await workTask('Логин', run.id)
    commit(a, 'login.ts', 'v1\n')
    await done(a.id)
    const [review1] = gatesOf(a.id)
    assert.equal(review1.roleId, 'reviewer')

    await reviewAccept(deps, a.id)
    assert.equal(task(a.id).stage?.nodeId, 'qa')
    assert.equal(task(a.id).status, 'review')
    const qa1 = gatesOf(a.id)[1]
    assert.equal(qa1.roleId, 'qa')
    assert.equal(qa1.title, 'QA: Логин')
    assert.equal(started.at(-1), qa1.id, 'воркер QA запущен приложением')
    assert.equal(existsSync(path.join(repo, 'login.ts')), false, 'до QA ветка не слита')
    await done(review1.id, 'принято')
    assert.equal(task(review1.id).status, 'done')

    await reviewReject(deps, a.id, 'падает сценарий входа')
    assert.equal(task(a.id).stage?.nodeId, 'work')
    assert.equal(task(a.id).feedback, 'падает сценарий входа')
    assert.equal(started.at(-1), a.id)
    await done(qa1.id, 'отклонено')
    assert.equal(task(qa1.id).status, 'done')

    commit(task(a.id), 'login.ts', 'v2\n')
    await done(a.id)
    assert.equal(task(a.id).stage?.nodeId, 'review', 'после доработки снова с ревью, не сразу QA')
    await reviewAccept(deps, a.id)
    await reviewAccept(deps, a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(readFileSync(path.join(repo, 'login.ts'), 'utf8'), 'v2\n')
    assert.deepEqual(gatesOf(a.id).map((g) => g.roleId), ['reviewer', 'qa', 'reviewer', 'qa'])
  })
})

describe('сценарий: пресет «3 отказа → человек» (addRetryLimit редактора)', () => {
  it('два отказа — снова работа, третий — запрос человеку; «Вернуть» — ещё круг, следующий отказ — сразу человек; «Принять» — мерж', async () => {
    const preset = addRetryLimit(legacyDefaultWorkflow(DEFAULT_ROLES), 3)
    assert.ok('workflow' in preset)
    const wf = preset.workflow
    const check = validateWorkflow(wf, { roles: DEFAULT_ROLES, columns: DEFAULT_COLUMNS })
    assert.deepEqual(structuralErrors(wf), [])
    assert.equal(check.warnings.some((w) => /бесконечно/.test(w.message)), false, 'лимит снимает предупреждение о бесконечном цикле')

    const run = store.createRun('цель', undefined, wf)
    const a = await workTask('Логин', run.id)
    commit(a, 'login.ts', 'x\n')
    for (const n of [1, 2]) {
      await done(a.id)
      await reviewReject(deps, a.id, `замечание ${n}`)
      assert.equal(task(a.id).stage?.nodeId, 'work', `отказ ${n} — обратно в работу`)
      assert.equal(store.pendingRequests().length, 0)
    }
    await done(a.id)
    await reviewReject(deps, a.id, 'замечание 3')
    assert.equal(task(a.id).stage?.nodeId, 'limit_human')
    assert.equal(task(a.id).status, 'needs_input')
    const [limit] = store.pendingRequests()
    assert.equal(limit.kind, 'approval')
    assert.equal(limit.title, 'После 3 отказов: Логин')
    assert.match(limit.body ?? '', /лимит \(3\)/)

    await resolve(limit.id, 'reject', 'последний шанс')
    assert.equal(task(a.id).stage?.nodeId, 'work')
    assert.equal(task(a.id).feedback, 'последний шанс')
    assert.equal(task(a.id).status, 'in_progress')
    await done(a.id)
    await reviewReject(deps, a.id, 'опять не то')
    const [again] = store.pendingRequests()
    assert.equal(again?.kind, 'approval', 'лимит исчерпан — следующий отказ сразу к человеку')

    await resolve(again.id, 'accept')
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true, '«Принять» ведёт туда же, куда accept проверки, — в мерж')
  })
})

describe('сценарий: конфликт мержа после ревью агентом', () => {
  it('accept ревьюера → конфликт → запрос человеку; «Вернуть» — в работу с замечаниями; после разрешения — мерж', async () => {
    const a = await workTask('Логин')
    commit(a, 'README.md', 'из ветки\n')
    writeFileSync(path.join(repo, 'README.md'), 'из master\n')
    git(repo, 'commit', '-qam', 'master')
    await done(a.id)
    await reviewAccept(deps, a.id)

    assert.equal(task(a.id).stage?.nodeId, 'conflict')
    assert.equal(task(a.id).status, 'needs_input')
    const [conflict] = store.pendingRequests()
    assert.equal(conflict.title, 'Конфликт мержа: Логин')
    assert.match(conflict.body ?? '', /CONFLICT|конфликт/i)
    assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), 'из master\n', 'master не испорчен')

    await resolve(conflict.id, 'reject', 'влей master и разреши конфликт')
    assert.equal(task(a.id).stage?.nodeId, 'work')
    assert.equal(task(a.id).feedback, 'влей master и разреши конфликт')
    assert.equal(started.at(-1), a.id)

    git(a.worktree!, 'merge', '-q', 'master', '-X', 'ours', '-m', 'resolve')
    await done(a.id)
    await reviewAccept(deps, a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), 'из ветки\n')
  })
})

/**
 * Тип прогона для движка по подзадачам: граф типа (версия 2 — граф глобальной задачи) переведён в граф подзадач, как это
 * делает store для прогонов без снимка. Прогон по типу с графом версии 2 идёт воркфлоу глобальной задачи, а тут
 * проверяется старый движок.
 */
function taskScope(t: RunTypeInput): RunTypeInput {
  return { ...t, ...(t.workflow ? { workflow: toTaskScopeWorkflow(t.workflow) } : {}) }
}

describe('сценарии с проектом: правка графа и удалённая роль', () => {
  const PID = 'p1'
  let pm: ProjectManager

  /** Граф типа проекта по умолчанию («repo» после миграции); null — дефолтный по ролям. */
  function saveWorkflow(wf: Workflow | null): void {
    pm.patchTaskType(pm.projectDefaultTypeId(PID), { workflow: wf })
  }

  beforeEach(() => {
    const userData = path.join(tmp, 'userData')
    mkdirSync(userData)
    writeFileSync(path.join(userData, 'projects.json'), JSON.stringify({
      projects: [{ id: PID, root: repo, name: 'repo', roles: DEFAULT_ROLES }], activeId: PID
    }))
    pm = new ProjectManager(userData)
    // Прогоны теста живут в своём store, не в доске pm: тип у них — тип проекта по умолчанию («repo» после миграции).
    deps.run = (runId) => {
      const t = pm.resolveRun(PID, runId)
      return { roles: t.roles, workflow: t.workflow }
    }
  })

  it('граф поменяли посреди прогона — идущая задача живёт на снимке, новый прогон — на новом графе', async () => {
    const run1 = store.createRun('первая цель', undefined, taskScope(pm.runType(PID)))
    const a = await workTask('A', run1.id)
    commit(a, 'a.ts', 'a\n')

    saveWorkflow(noReview)
    await done(a.id)
    assert.equal(task(a.id).stage?.nodeId, 'review', 'по снимку — ревью, хотя в проекте его уже нет')
    assert.equal(gatesOf(a.id).length, 1)

    const run2 = store.createRun('вторая цель', undefined, taskScope(pm.runType(PID)))
    const b = await workTask('B', run2.id)
    commit(b, 'b.ts', 'b\n')
    await done(b.id)
    assert.equal(task(b.id).status, 'done', 'новый прогон — без ревью')
    assert.equal(existsSync(path.join(repo, 'b.ts')), true)

    // Ещё одна правка (сброс к дефолту) — снимок первого прогона по-прежнему ведёт задачу A.
    saveWorkflow(null)
    await reviewAccept(deps, a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'a.ts')), true)
    // Снимок — граф типа, каким его видит движок подзадач (`toTaskScopeWorkflow` от сохранённого графа версии 2).
    assert.deepEqual(store.getRun(run1.id)!.workflow, toTaskScopeWorkflow(defaultWorkflow(DEFAULT_ROLES)))
    assert.deepEqual(store.getRun(run2.id)!.workflow, toTaskScopeWorkflow(migrateWorkflow(noReview, DEFAULT_ROLES)))
  })

  it('задача без прогона («Входящие») идёт по графу типа проекта по умолчанию', async () => {
    saveWorkflow(noReview)
    const c = await workTask('C')
    commit(c, 'c.ts', 'c\n')
    await done(c.id)
    assert.equal(task(c.id).status, 'done', 'граф типа — без ревью')
    assert.equal(gatesOf(c.id).length, 0)
  })

  it('роль гейта удалили после сохранения графа — workflow_blocked (уведомление-эскалация), человек решает сам', async () => {
    const base = legacyDefaultWorkflow(DEFAULT_ROLES)
    saveWorkflow({ ...base, nodes: base.nodes.map((n) => (n.id === 'review' ? { ...n, roleId: 'qa', title: 'QA' } : n)) })
    const run = store.createRun('цель', undefined, taskScope(pm.runType(PID)))
    pm.patchTaskType(pm.projectDefaultTypeId(PID), { roles: DEFAULT_ROLES.filter((r) => r.id !== 'qa') })
    assert.throws(() => saveWorkflow(pm.taskTypeWorkflow(pm.projectDefaultTypeId(PID)).workflow), /нет роли «qa»/, 'граф типа с удалённой ролью больше не сохранить')

    const a = await workTask('Логин', run.id)
    commit(a, 'login.ts', 'x\n')
    await done(a.id)
    assert.equal(task(a.id).stage?.nodeId, 'review')
    assert.equal(task(a.id).status, 'review')
    assert.equal(gatesOf(a.id).length, 0, 'проверка не создана')
    const [blocked] = events('workflow_blocked', a.id)
    assert.match(String(blocked.payload.reason), /нет роли «qa»/)
    assert.equal(blocked.payload.nodeId, 'review')
    assert.equal(describeEvent(blocked, task(a.id), 'P', true)?.kind, 'escalation')

    await reviewAccept(deps, a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true)
  })
})

/** Хранилище в памяти: снапшот проходит через JSON, как state.json на диске. */
function memory(): Persistence {
  let data: StoreSnapshot | null = null
  return {
    load: () => (data ? (JSON.parse(JSON.stringify(data)) as StoreSnapshot) : null),
    save: (s) => { data = JSON.parse(JSON.stringify(s)) as StoreSnapshot }
  }
}

describe('сценарий: рестарт приложения посреди этапа', () => {
  let disk: Persistence
  /** Перезапуск: новый store из того же снапшота, PTY умерли. */
  const restart = (): void => {
    store = new TaskStore(disk, () => DEFAULT_COLUMNS)
    deps.store = store
  }

  beforeEach(() => {
    disk = memory()
    restart()
  })

  it('этап «Работа»: запуск закрыт как unknown, задача в ready; новый запуск не считается повтором, done ведёт на ревью', async () => {
    const a = await workTask('Логин')
    const dispatchId = task(a.id).dispatchId!
    restart()
    assert.equal(task(a.id).status, 'ready')
    assert.equal(store.getDispatch(dispatchId)!.outcome, 'unknown')
    assert.deepEqual(task(a.id).stage, { nodeId: 'work', visits: { start: 1, work: 1 } })

    await deps.startWorker(a.id)
    assert.deepEqual(task(a.id).stage, { nodeId: 'work', visits: { start: 1, work: 1 } }, 'перезапуск после рестарта — не отказ')
    await done(a.id)
    assert.equal(task(a.id).stage?.nodeId, 'review')
    assert.equal(gatesOf(a.id).length, 1)
  })

  it('этап проверки: проверка в ready, рабочая задача ждёт на ревью; перезапуск проверки и accept — мерж', async () => {
    const a = await workTask('Логин')
    commit(a, 'login.ts', 'x\n')
    await done(a.id)
    const [gate] = gatesOf(a.id)
    restart()
    assert.equal(task(gate.id).status, 'ready')
    assert.deepEqual(task(gate.id).gateFor, { taskId: a.id, nodeId: 'review' })
    assert.equal(task(a.id).stage?.nodeId, 'review')
    assert.equal(task(a.id).status, 'review')

    await deps.startWorker(gate.id)
    assert.equal(task(gate.id).stage, undefined, 'проверка в граф не входит')
    await reviewAccept(deps, a.id)
    await done(gate.id, 'принято')
    assert.equal(task(a.id).status, 'done')
    assert.equal(task(gate.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true)
  })

  it('этап «человек»: запрос approval переживает рестарт, «Принять» после него сливает ветку', async () => {
    roles = DEFAULT_ROLES.filter((r) => r.id !== 'reviewer')
    const a = await workTask('Логин')
    commit(a, 'login.ts', 'x\n')
    await done(a.id)
    restart()
    const [request] = store.pendingRequests()
    assert.equal(request?.kind, 'approval')
    assert.equal(task(a.id).status, 'needs_input')
    await resolve(request.id, 'accept')
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true)
  })

  it('снимок графа прогона переживает рестарт: задача идёт по нему, а не по дефолту', async () => {
    const run = store.createRun('цель', undefined, noReview)
    const a = await workTask('Логин', run.id)
    commit(a, 'login.ts', 'x\n')
    restart()
    await deps.startWorker(a.id)
    await done(a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(gatesOf(a.id).length, 0)
  })

  it('done сохранён, а worker_done не обработан до выхода: задача в «Ревью» на этапе «Работа», выход — перезапуск воркера', async () => {
    const a = await workTask('Логин')
    store.finishDispatch(task(a.id).dispatchId!, 'сделал', [])
    restart()
    assert.equal(task(a.id).status, 'review')
    assert.equal(task(a.id).stage?.nodeId, 'work')
    // «Принять» делает переход, который не успел сделать `worker_done`: дальше — проверка.
    await reviewAccept(deps, a.id)
    assert.equal(task(a.id).stage?.nodeId, 'review')
    assert.equal(gatesOf(a.id).length, 1)
  })

  it('добор при открытии: done без обработанного worker_done доезжает до проверки сам', async () => {
    const a = await workTask('Логин')
    store.finishDispatch(task(a.id).dispatchId!, 'сделал', [])
    restart()
    await resumeStuckStages(deps)
    assert.equal(task(a.id).stage?.nodeId, 'review')
    assert.equal(gatesOf(a.id).length, 1)
    await resumeStuckStages(deps)
    assert.equal(gatesOf(a.id).length, 1, 'повторный добор проверку не дублирует')
  })

  it('добор при открытии: этап проверки без задачи-проверки (выход до createGate) — проверка создаётся один раз', async () => {
    const a = await workTask('Логин')
    store.finishDispatch(task(a.id).dispatchId!, 'сделал', [])
    store.advanceStage(a.id, 'next', { roleIds: roles.map((r) => r.id) })
    restart()
    assert.equal(task(a.id).stage?.nodeId, 'review')
    assert.equal(gatesOf(a.id).length, 0)
    await resumeStuckStages(deps)
    await resumeStuckStages(deps)
    assert.equal(gatesOf(a.id).length, 1)
    assert.equal(started.at(-1), gatesOf(a.id)[0].id)
  })
})

describe('остановленный этап подзадачи: мерж не тупик', () => {
  let disk: Persistence
  const restart = (): void => {
    store = new TaskStore(disk, () => DEFAULT_COLUMNS)
    deps.store = store
  }

  beforeEach(() => {
    disk = memory()
    restart()
  })

  /** Задача сдала `done`, граф перешёл на «Мерж», а эффект не выполнился (приложение вышло посреди мержа). */
  async function stuckOnMerge(title: string, runId: string): Promise<Task> {
    const a = await workTask(title, runId)
    commit(a, `${title}.ts`, 'x\n')
    store.finishDispatch(task(a.id).dispatchId!, 'сделал', [])
    store.advanceStage(a.id, 'next')
    restart()
    return task(a.id)
  }

  it('(1) задача на «Мерже» после краша: «Принять» сливает ветку и закрывает задачу', async () => {
    const run = store.createRun('цель', undefined, noReview)
    const a = await stuckOnMerge('login', run.id)
    assert.equal(a.stage?.nodeId, 'merge')
    assert.equal(a.status, 'review', 'колонка «Ревью» — кнопки «Принять»/«Вернуть» видны')
    assert.equal(a.stageBlock, undefined)

    await reviewAccept(deps, a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(task(a.id).stage?.nodeId, 'end')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true, 'ветка слита')
    assert.equal(branchExists(`orca/${a.id}`), false)
  })

  it('(2) мерж упал — stageBlock с причиной; снова упал — «Принять» сообщает причину; причину убрали — «Принять» сливает', async () => {
    const run = store.createRun('цель', undefined, noReview)
    deps.mergeTarget = () => { throw new Error('ветки фичи нет в репозитории') }
    const a = await workTask('login', run.id)
    commit(a, 'login.ts', 'x\n')
    await done(a.id)
    assert.equal(task(a.id).stage?.nodeId, 'merge')
    assert.equal(task(a.id).stageBlock?.nodeId, 'merge')
    assert.match(task(a.id).stageBlock!.reason, /мерж не выполнен: ветки фичи нет/)
    assert.equal(events('workflow_blocked', a.id).length, 1)

    await assert.rejects(async () => await reviewAccept(deps, a.id), (e: unknown) => e instanceof OrcaError && e.key === 'review.stageBlocked' && /ветки фичи нет/.test(e.message))
    assert.equal(task(a.id).stage?.nodeId, 'merge')
    assert.equal(events('workflow_blocked', a.id).length, 2)

    delete deps.mergeTarget
    await reviewAccept(deps, a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(task(a.id).stageBlock, undefined, 'метка снята')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true)
  })

  it('(3) «Вернуть» на «Мерже» — замечания в feedback, этап «Работа», воркер запущен', async () => {
    const run = store.createRun('цель', undefined, noReview)
    const a = await stuckOnMerge('login', run.id)
    await reviewReject(deps, a.id, 'сначала почини тесты')
    assert.equal(task(a.id).feedback, 'сначала почини тесты')
    assert.equal(task(a.id).stage?.nodeId, 'work')
    assert.equal(task(a.id).stage?.visits.work, 2, 'возврат считается заходом')
    assert.equal(task(a.id).status, 'in_progress')
    assert.equal(started.at(-1), a.id)
    assert.equal(branchExists(`orca/${a.id}`), true, 'ветка с работой на месте')
  })

  it('(4) добор после запуска: «Мерж» без метки доезжает, с меткой — ждёт человека; повтор ничего не меняет', async () => {
    const run = store.createRun('цель', undefined, noReview)
    const a = await stuckOnMerge('a', run.id)
    const b = await workTask('b', run.id)
    commit(b, 'b.ts', 'x\n')
    deps.mergeTarget = (t) => { if (t.id === b.id) throw new Error('index.lock занят'); return { cwd: repo, branch: 'master' } }
    await done(b.id)
    delete deps.mergeTarget
    assert.equal(task(b.id).stageBlock?.nodeId, 'merge')
    restart()
    const blockedBefore = events('workflow_blocked').length

    await resumeStuckStages(deps)
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'a.ts')), true)
    assert.equal(task(b.id).stage?.nodeId, 'merge', 'остановленную задачу добор не трогает')
    assert.equal(existsSync(path.join(repo, 'b.ts')), false)
    assert.equal(events('workflow_blocked').length, blockedBefore, 'повторного уведомления нет')

    const snapshot = JSON.stringify(store.snapshot())
    await resumeStuckStages(deps)
    assert.equal(JSON.stringify(store.snapshot()), snapshot, 'идемпотентно')
  })

  it('(5) «Работа» + сданный done + «Ревью» (worker_done потерян) — добор делает переход дальше', async () => {
    const run = store.createRun('цель', undefined, noReview)
    const a = await workTask('login', run.id)
    commit(a, 'login.ts', 'x\n')
    store.finishDispatch(task(a.id).dispatchId!, 'сделал', [])
    restart()
    assert.equal(task(a.id).stage?.nodeId, 'work')
    await resumeStuckStages(deps)
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true)
  })

  it('мерж на «Мерже» без папки worktree (её убрали руками) — «Принять» сливает закоммиченное, без ENOENT', async () => {
    const run = store.createRun('цель', undefined, noReview)
    const a = await stuckOnMerge('login', run.id)
    rmSync(a.worktree!, { recursive: true, force: true })
    await reviewAccept(deps, a.id)
    assert.equal(task(a.id).status, 'done')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true)
    assert.equal(branchExists(`orca/${a.id}`), false)
  })
})

describe('сценарий: задача-ответ идёт мимо воркфлоу', () => {
  it('answerFor human в прогоне со снимком без ревью: запрос answer, этапа нет, ничего не сливается', async () => {
    const run = store.createRun('цель', undefined, noReview)
    const t = store.createTask({ title: 'Разберись', answerFor: 'human', runId: run.id })
    await deps.startWorker(t.id)
    const before = store.listEvents().length
    store.finishDispatch(task(t.id).dispatchId!, 'суть', [], 'подробный ответ')
    await handleWorkflowEvents(deps, store.listEvents().slice(before))

    assert.equal(task(t.id).stage, undefined)
    assert.equal(events('stage_changed', t.id).length, 0)
    const [answer] = store.pendingRequests()
    assert.equal(answer.kind, 'answer')
    await resolve(answer.id, 'accept')
    assert.equal(task(t.id).status, 'done')
    assert.equal(events('workflow_blocked').length, 0)
  })
})
