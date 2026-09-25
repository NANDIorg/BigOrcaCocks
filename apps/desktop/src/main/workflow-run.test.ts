// Запуск: pnpm --filter @orca-board/desktop test. Исполнитель воркфлоу глобальной задачи (`workflow-run.ts`) на настоящем
// git-репозитории во временной папке. PTY нет: координатор и воркеры — фейки, повторяющие контракт `startCoordinator` /
// `runWorker` (setRunPty, worktree на ветке от ветки прогона, startDispatch).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES, defaultWorkflow, normalizeRunBranchSettings, pipelineWorkflow,
  type OrcaEvent, type RunBranchSettings, type Task, type WfEdge, type WfNode, type WfSubflow, type Workflow
} from '@orca-board/core'
import {
  SUBTASK_MERGE_NODE, acceptRun, advanceRun, finishRunStage, handleRunApproval, handleRunWorkflowEvents, returnRun, runGateDecision,
  settleIdleRunStages, startRunWorkflow, type RunWorkflowDeps
} from './workflow-run'
import { approvalResolved, enterWork, handleWorkflowEvents, reviewAccept, reviewReject, taskEngine, type WorkflowDeps } from './workflow'
import { resolveHumanRequest } from './review'
import { resumeObjective } from './coordinator-resume'
import { ensureRunBranch, mergeTarget } from './run-branch'
import { taskWorktreePath } from './git'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let tmp: string
let repo: string
let remote: string
let store: TaskStore
let settings: RunBranchSettings
let started: string[]
let coordinatorStarts: string[]
let coordinatorFails: boolean
let alive: Set<string>
let deps: RunWorkflowDeps

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-wfrun-')))
  remote = path.join(tmp, 'remote.git')
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote])
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  writeFileSync(path.join(repo, 'README.md'), 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'remote', 'add', 'origin', remote)
  store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  // По умолчанию — как в проекте: `master` защищён. Тесты слияния в базу снимают защиту.
  settings = normalizeRunBranchSettings(undefined)
  started = []
  coordinatorStarts = []
  coordinatorFails = false
  alive = new Set()
  deps = {
    store,
    repoRoot: repo,
    run: () => ({ roles: DEFAULT_ROLES }),
    // Как runWorker + startWorker: подзадача входит в путь (`enterWork`), ветка задачи от ветки прогона, worktree, dispatch с ролью задачи.
    startWorker(taskId) {
      enterWork(deps as unknown as WorkflowDeps, taskId)
      const t = task(taskId)
      const runGit = ensureRunBranch(store, repo, t.runId, settings)
      const branch = t.branch ?? `orca/${taskId}`
      const worktree = t.worktree ?? taskWorktreePath(repo, taskId)
      if (!existsSync(worktree)) git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, ...(runGit ? [runGit.branch] : []))
      store.updateTask(taskId, { worktree, branch })
      started.push(taskId)
      const d = store.startDispatch(taskId, `pty_${taskId}_${started.length}`, undefined, { roleId: t.roleId })
      return { ptyId: d.ptyId, dispatchId: d.id }
    },
    isAlive: (ptyId) => alive.has(ptyId),
    startCoordinator(runId) {
      if (coordinatorFails) throw new Error('агент не установлен')
      coordinatorStarts.push(runId)
      const pty = `pty_coord_${coordinatorStarts.length}`
      alive.add(pty)
      store.setRunPty(runId, pty)
    },
    gitSettings: () => settings,
    mergeTarget: (t) => mergeTarget(store, repo, t, settings)
  }
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const task = (id: string): Task => store.getTask(id)!
const events = (type: string) => store.listEvents().filter((e) => e.type === type)
const lastEvent = (type: string): OrcaEvent => events(type).at(-1)!
const run = (id: string) => store.getRun(id)!
const branchExists = (branch: string): boolean => git(repo, 'branch', '--list', branch) !== ''
const reviewer = DEFAULT_ROLES.find((r) => r.id === 'reviewer')!

/** Прогон нового формата с веткой и живым координатором — как «Запустить координатора»: enter в граф. */
function newRun(wf: Workflow = defaultWorkflow(DEFAULT_ROLES), title = 'Фича'): string {
  const g = store.createGlobalTask({ title, description: 'сделать фичу', workflow: wf })
  ensureRunBranch(store, repo, g.id, settings)
  const pty = `pty_coord_start_${g.id}`
  alive.add(pty)
  store.setRunPty(g.id, pty)
  startRunWorkflow(deps, g.id)
  return g.id
}

/** Доставка событий, появившихся после `before`, исполнителю — как подписка `runWorkflowEvents` в index.ts (оба движка). */
function deliver(before: number): void {
  const fresh = store.listEvents().slice(before)
  handleWorkflowEvents(deps as unknown as WorkflowDeps, fresh)
  handleRunWorkflowEvents(deps, fresh)
}

/** Координатор: `task create` (store привязывает к этапу) + `worker start`. */
function spawn(runId: string, title: string, roleId = 'developer'): Task {
  const t = store.createTask({ title, roleId, runId })
  deps.startWorker(t.id)
  return task(t.id)
}

/** Воркер коммитит файл в своей ветке. */
function commit(t: Task, file: string, text = `${file}\n`): void {
  writeFileSync(path.join(t.worktree!, file), text)
  git(t.worktree!, 'add', '-A')
  git(t.worktree!, 'commit', '-qm', file)
}

/** `orca-board done` текущего запуска + доставка событий исполнителю. */
function done(taskId: string, summary = 'сделал'): void {
  const before = store.listEvents().length
  store.finishDispatch(task(taskId).dispatchId!, summary, [])
  deliver(before)
}

/** Одна подзадача этапа «Работа»: создана, файл закоммичен, `done` (автомерж в ветку прогона). */
function work(runId: string, file: string, title = file): Task {
  const t = spawn(runId, title)
  commit(t, file)
  done(t.id)
  return task(t.id)
}

/** Решение запроса человеком (Инбокс / `request resolve`), как `resolveRequest` в index.ts. */
function resolve(requestId: string, action: 'accept' | 'reject', text?: string): void {
  resolveHumanRequest(store, repo, requestId, { action, ...(text ? { text } : {}) }, deps.startWorker, (r) => {
    if (!handleRunApproval(deps, r)) approvalResolved(deps as unknown as WorkflowDeps, r)
  }, deps.mergeTarget)
}

const stageId = (runId: string): string | undefined => run(runId).stage?.nodeId
const gateOf = (runId: string): Task => store.listTasks().filter((t) => t.gateFor?.runId === runId).at(-1)!
const approvalOf = (runId: string) => store.pendingRequests(runId).find((r) => r.kind === 'approval' && r.taskId === undefined)

const node = (n: Partial<WfNode> & { id: string; type: WfNode['type'] }): WfNode => ({ x: 0, y: 0, ...n }) as WfNode
const edge = (from: string, outcome: WfEdge['outcome'], to: string): WfEdge => ({ id: `e_${from}_${outcome}`, from, outcome, to })

describe('дефолтный граф: работа → ревью → проверка человеком → конец', () => {
  it('вход в граф шлёт stage_started, подзадачи привязаны к этапу, автомерж в ветку прогона, stage_tasks_done', () => {
    const runId = newRun()
    assert.equal(stageId(runId), 'work')
    const started1 = lastEvent('stage_started')
    assert.equal(started1.payload.runId, runId)
    assert.equal(started1.payload.nodeId, 'work')
    assert.deepEqual(started1.payload.roleIds, [], 'роли ноды не заданы — координатор выбирает сам')
    assert.equal(coordinatorStarts.length, 0, 'координатор жив — заново не запускается')

    const t = work(runId, 'login.ts')
    assert.deepEqual(t.stageOf, { nodeId: 'work', visit: 1 })
    assert.equal(t.status, 'done', 'воркер → done → автомерж → задача закрыта')
    assert.equal(t.worktree, undefined)
    assert.equal(branchExists(`orca/${t.id}`), false)
    const g = run(runId).git!
    assert.equal(existsSync(path.join(g.worktree!, 'login.ts')), true, 'файл в ветке прогона')
    assert.equal(existsSync(path.join(repo, 'login.ts')), false, 'корень не тронут')
    assert.equal(events('stage_tasks_done').length, 1)
    assert.equal(stageId(runId), 'work', 'этап закрывает координатор, а не done воркера')
  })

  it('stage finish → задача-проверка на ветку прогона против базы; accept → approval прогона; «Принять» → конец', () => {
    const runId = newRun()
    work(runId, 'login.ts')

    finishRunStage(deps, runId, 'логин сделан')
    assert.equal(stageId(runId), 'review')
    const gate = gateOf(runId)
    assert.equal(gate.roleId, 'reviewer')
    assert.deepEqual(gate.gateFor, { runId, nodeId: 'review' })
    assert.equal(gate.title, 'Ревью: Фича')
    assert.match(gate.spec, /review accept --task "\$ORCA_TASK_ID"/, 'решение — по id самой проверки из окружения')
    assert.match(gate.spec, new RegExp(`git diff master\\.\\.\\.${run(runId).git!.branch}`))
    assert.match(gate.spec, /логин сделан/, 'сводка этапа — в спеке проверки')
    assert.equal(started.at(-1), gate.id, 'воркер проверки запущен приложением')
    assert.equal(events('stage_started').length, 1, 'координатору на проверке делать нечего')
    assert.equal(run(runId).stageHistory!.find((h) => h.nodeId === 'work')!.summary, 'логин сделан')
    assert.ok(run(runId).stageHistory!.every((h) => h.commit), 'коммит ветки прогона записан на входе в каждый этап')

    runGateDecision(deps, gate.id, 'accept')
    assert.equal(stageId(runId), 'check')
    const request = approvalOf(runId)!
    assert.equal(request.taskId, undefined)
    assert.equal(request.nodeId, 'check')
    assert.match(request.body!, /логин сделан/)
    assert.match(request.body!, /Ветка: `feature\//)
    assert.equal(store.getGlobalTask(runId).status, 'review', 'карточка на «Проверке», пока approval ждёт человека')

    done(gate.id, 'принято')
    assert.equal(task(gate.id).status, 'done', 'проверка закрыта по своему done')

    resolve(request.id, 'accept', 'вариант 2')
    assert.equal(stageId(runId), 'end')
    assert.notEqual(run(runId).closedAt, undefined)
    assert.equal(events('run_done').length, 1)
    assert.equal(lastEvent('run_done').payload.runId, runId)
    assert.equal(store.columnKind(run(runId).status!), 'done')
  })

  it('finishRunStage возвращает переход store и делает эффект новой ноды', () => {
    const runId = newRun()
    work(runId, 'login.ts')
    const { run: after, action } = finishRunStage(deps, runId, 'готово')
    assert.deepEqual([action.type, action.nodeId], ['create_gate', 'review'])
    assert.equal(after.stage!.nodeId, 'review')
    assert.equal(gateOf(runId).gateFor!.nodeId, 'review', 'проверка создана тем же вызовом')
  })

  it('reject проверки → stage_started с замечаниями и новым заходом; старая проверка закрывается по done и не решает', () => {
    const runId = newRun()
    work(runId, 'login.ts')
    finishRunStage(deps, runId, 'v1')
    const first = gateOf(runId)

    runGateDecision(deps, first.id, 'reject', 'нет тестов')
    assert.equal(stageId(runId), 'work')
    assert.equal(run(runId).stage!.visits.work, 2)
    const again = lastEvent('stage_started')
    assert.equal(again.payload.feedback, 'нет тестов')
    assert.equal(again.payload.visit, 2)
    assert.deepEqual(run(runId).returns!.map((r) => r.text), ['нет тестов'])
    assert.equal(store.runStage(runId)!.feedback, 'нет тестов')

    done(first.id, 'отклонено')
    assert.equal(task(first.id).status, 'done', 'старая проверка закрыта')
    assert.throws(() => runGateDecision(deps, first.id, 'accept'), /уже не актуальна/)

    // Задачи прошлого захода в счёт нового этапа не идут; закрытие — только по задачам захода 2.
    assert.equal(store.runStage(runId)!.tasks.length, 0)
    work(runId, 'tests.ts')
    finishRunStage(deps, runId, 'v2')
    const second = gateOf(runId)
    assert.notEqual(second.id, first.id)
    assert.match(second.spec, /### «Реализация»\n\nv1\n\n### «Реализация»\n\nv2/, 'сводки обоих заходов видны новой проверке')
    runGateDecision(deps, second.id, 'accept')
    assert.equal(stageId(runId), 'check')
  })

  it('«Вернуть» на карточке проверки → reject: замечания в stage_started, координатор жив — не перезапускается', () => {
    const runId = newRun()
    work(runId, 'login.ts')
    finishRunStage(deps, runId, 'v1')
    runGateDecision(deps, gateOf(runId).id, 'accept')

    returnRun(deps, runId, 'переименуй кнопку')
    assert.equal(stageId(runId), 'work')
    assert.equal(lastEvent('stage_started').payload.feedback, 'переименуй кнопку')
    assert.equal(coordinatorStarts.length, 0)
    assert.equal(store.getGlobalTask(runId).status, 'in_progress')
  })

  it('«Подтвердить» на карточке (acceptRun) = accept ноды human → конец', () => {
    const runId = newRun(pipelineWorkflow([]))
    work(runId, 'a.ts')
    finishRunStage(deps, runId, 'ok')
    assert.equal(stageId(runId), 'check')
    acceptRun(deps, runId)
    assert.equal(stageId(runId), 'end')
    assert.equal(events('run_done').length, 1)
  })

  it('решение по approval прогона, когда граф уже ушёл дальше, ничего не двигает', () => {
    const runId = newRun(pipelineWorkflow([]))
    work(runId, 'a.ts')
    finishRunStage(deps, runId, 'ok')
    const request = approvalOf(runId)!
    resolve(request.id, 'accept')
    assert.equal(stageId(runId), 'end')
    assert.equal(handleRunApproval(deps, store.getRequest(request.id)!), true)
    assert.equal(stageId(runId), 'end')
    assert.equal(events('run_done').length, 1, 'run_done не дублируется')
  })
})

describe('координатор на «Работе»', () => {
  it('мёртвый координатор перезапускается на входе в «Работу» (reject); не запустился — workflow_blocked по runId', () => {
    const runId = newRun(pipelineWorkflow([]))
    work(runId, 'a.ts')
    finishRunStage(deps, runId, 'ok')
    // Человек долго думал: терминал координатора закрылся.
    alive.clear()

    resolve(approvalOf(runId)!.id, 'reject', 'доделай')
    assert.equal(stageId(runId), 'work')
    assert.deepEqual(coordinatorStarts, [runId], 'координатор запущен заново')
    assert.equal(lastEvent('stage_started').payload.feedback, 'доделай')
    assert.equal(events('workflow_blocked').length, 0)

    work(runId, 'b.ts')
    finishRunStage(deps, runId, 'ok2')
    alive.clear()
    coordinatorFails = true
    resolve(approvalOf(runId)!.id, 'reject', 'ещё')
    const blocked = lastEvent('workflow_blocked')
    assert.equal(blocked.payload.runId, runId)
    assert.equal(blocked.taskId, undefined, 'у прогона workflow_blocked без taskId')
    assert.match(String(blocked.payload.reason), /координатор не запустился: агент не установлен[\s\S]*global start --global/)
  })

  it('фолбэк: подзадачи закрыты, координатор умер, stage finish не пришёл — этап закрывается без сводки', () => {
    const runId = newRun(pipelineWorkflow([]))
    work(runId, 'a.ts')
    assert.equal(stageId(runId), 'work')

    settleIdleRunStages(deps)
    assert.equal(stageId(runId), 'work', 'координатор жив — ждём его stage finish')

    alive.clear()
    settleIdleRunStages(deps)
    assert.equal(stageId(runId), 'check', 'координатора нет — этап закрыт по next, эффект следующей ноды выполнен')
    assert.ok(approvalOf(runId))
    assert.equal(run(runId).stageHistory!.find((h) => h.nodeId === 'work')!.summary, undefined)
  })

  it('перезапуск координатора на графе, уже стоящем на проверке, не дублирует задачу-проверку и approval', () => {
    const runId = newRun()
    work(runId, 'a.ts')
    finishRunStage(deps, runId, 'ok')
    const gate = gateOf(runId)
    const count = store.listTasks().length

    startRunWorkflow(deps, runId)
    assert.equal(store.listTasks().length, count, 'задача-проверка одна')
    assert.equal(gateOf(runId).id, gate.id)

    runGateDecision(deps, gate.id, 'accept')
    startRunWorkflow(deps, runId)
    assert.equal(store.pendingRequests(runId).filter((r) => r.kind === 'approval').length, 1)
  })

  it('stage finish вне «Работы» и без закрытых подзадач — понятная ошибка store', () => {
    const runId = newRun()
    assert.throws(() => finishRunStage(deps, runId), /нет подзадач/)
    const t = spawn(runId, 'a')
    assert.throws(() => finishRunStage(deps, runId), new RegExp(`не закрыты подзадачи \\(${t.id}\\)`))
  })
})

describe('нода merge: ветка прогона → база', () => {
  const mergeGraph = (): Workflow => ({
    version: 2,
    nodes: [
      node({ id: 'start', type: 'start' }), node({ id: 'work', type: 'work', title: 'Реализация' }), node({ id: 'merge', type: 'merge' }),
      node({ id: 'conflict', type: 'human', title: 'Конфликт мержа', instructions: 'Разрешите конфликт' }), node({ id: 'end', type: 'end' })
    ],
    edges: [
      edge('start', 'next', 'work'), edge('work', 'next', 'merge'), edge('merge', 'ok', 'end'), edge('merge', 'conflict', 'conflict'),
      edge('conflict', 'accept', 'merge'), edge('conflict', 'reject', 'work')
    ]
  })

  it('база не защищена — слито в базу, корень не переключался, дальше end', () => {
    settings = { ...settings, protected: [] }
    const runId = newRun(mergeGraph())
    work(runId, 'login.ts')
    finishRunStage(deps, runId, 'ok')
    assert.equal(stageId(runId), 'end')
    assert.equal(existsSync(path.join(repo, 'login.ts')), true, 'корень стоял на базе — слито в него')
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'master')
    assert.equal(events('run_done').length, 1)
  })

  it('защищённая база — workflow_blocked по runId с подсказкой, позиция остаётся; после снятия защиты «повторить» проходит', () => {
    const runId = newRun(mergeGraph())
    work(runId, 'login.ts')
    const masterBefore = git(repo, 'rev-parse', 'master')
    finishRunStage(deps, runId, 'ok')
    assert.equal(stageId(runId), 'merge')
    const blocked = lastEvent('workflow_blocked')
    assert.equal(blocked.payload.runId, runId)
    assert.match(String(blocked.payload.reason), /защищённую ветку «master» запрещено[\s\S]*git push/)
    assert.equal(git(repo, 'rev-parse', 'master'), masterBefore)

    settings = { ...settings, protected: [] }
    startRunWorkflow(deps, runId)
    assert.equal(stageId(runId), 'end')
  })

  it('конфликт → human «Конфликт мержа» с текстом git; «Принять» повторяет мерж', () => {
    settings = { ...settings, protected: [] }
    const runId = newRun(mergeGraph())
    work(runId, 'f.md')
    // Кто-то другой изменил тот же файл в базе.
    writeFileSync(path.join(repo, 'f.md'), 'чужое\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'чужой коммит')

    finishRunStage(deps, runId, 'ok')
    assert.equal(stageId(runId), 'conflict')
    const request = approvalOf(runId)!
    assert.match(request.body!, /Мерж не удался/)
    assert.match(request.body!, /Разрешите конфликт/)
    assert.equal(git(repo, 'status', '--porcelain'), '', 'база не осталась в полуслитом состоянии')

    // Человек разрешил конфликт в ветке прогона: слил в неё базу и выбрал своё.
    const wt = run(runId).git!.worktree!
    try {
      git(wt, 'merge', 'master')
    } catch {
      writeFileSync(path.join(wt, 'f.md'), 'общее\n')
      git(wt, 'add', '-A')
      git(wt, 'commit', '-qm', 'разрешён конфликт')
    }
    resolve(request.id, 'accept')
    assert.equal(stageId(runId), 'end')
    assert.equal(git(repo, 'show', 'master:f.md'), 'общее')
  })
})

describe('нода git: commit и push в worktree ветки прогона', () => {
  const gitGraph = (ops: Array<Record<string, unknown>>): Workflow => {
    const nodes: WfNode[] = [node({ id: 'start', type: 'start' }), node({ id: 'work', type: 'work' })]
    const edges: WfEdge[] = [edge('start', 'next', 'work')]
    let prev = 'work'
    ops.forEach((op, i) => {
      const id = `git${i}`
      nodes.push(node({ id, type: 'git', ...op } as never))
      edges.push(edge(prev, prev === 'work' ? 'next' : 'ok', id))
      prev = id
    })
    nodes.push(node({ id: 'end', type: 'end' }))
    edges.push(edge(prev, prev === 'work' ? 'next' : 'ok', 'end'))
    return { version: 2, nodes, edges }
  }

  it('commit (с {title}) и push на remote; в Run.git — pushedAt; конец', () => {
    const runId = newRun(gitGraph([{ operation: 'commit', message: 'feat: {title}' }, { operation: 'push' }]), 'Логин')
    work(runId, 'a.ts')
    const wt = run(runId).git!.worktree!
    writeFileSync(path.join(wt, 'tail.md'), 'хвост\n')

    finishRunStage(deps, runId, 'ok')
    assert.equal(stageId(runId), 'end')
    assert.equal(git(wt, 'log', '-1', '--format=%s'), 'feat: Логин')
    assert.equal(git(remote, 'rev-parse', run(runId).git!.branch), git(repo, 'rev-parse', run(runId).git!.branch))
    assert.notEqual(run(runId).git!.pushedAt, undefined)
  })

  it('push не удался (нет remote) — исход error без ребра: workflow_blocked с текстом git, ошибка в Run.git', () => {
    const runId = newRun(gitGraph([{ operation: 'push', remote: 'nope' }]))
    work(runId, 'a.ts')
    finishRunStage(deps, runId, 'ok')
    assert.equal(stageId(runId), 'git0')
    assert.match(String(lastEvent('workflow_blocked').payload.reason), /у ноды нет перехода «error»/)
    assert.notEqual(run(runId).git!.pushError, undefined)
  })

  it('error ведёт к человеку — текст git в approval', () => {
    const wf = gitGraph([{ operation: 'push', remote: 'nope' }])
    wf.nodes.push(node({ id: 'human', type: 'human', title: 'Не удалось запушить' }))
    wf.edges.push(edge('git0', 'error', 'human'), edge('human', 'accept', 'end'), edge('human', 'reject', 'work'))
    const runId = newRun(wf)
    work(runId, 'a.ts')
    finishRunStage(deps, runId, 'ok')
    assert.equal(stageId(runId), 'human')
    assert.match(approvalOf(runId)!.body!, /Git-операция «push» не удалась/)
  })
})

describe('нода ask: одна задача роли, вопросы идут человеку, ответы — в следующую «Работу»', () => {
  it('задача создаётся приложением, done → next с answers', () => {
    const wf: Workflow = {
      version: 2,
      nodes: [
        node({ id: 'start', type: 'start' }), node({ id: 'ask', type: 'ask', roleId: 'reviewer', instructions: 'Спроси про сроки' }),
        node({ id: 'work', type: 'work' }), node({ id: 'end', type: 'end' })
      ],
      edges: [edge('start', 'next', 'ask'), edge('ask', 'next', 'work'), edge('work', 'next', 'end')]
    }
    const runId = newRun(wf)
    assert.equal(stageId(runId), 'ask')
    const asker = store.listTasks().find((t) => t.stageOf?.nodeId === 'ask')!
    assert.equal(asker.roleId, 'reviewer')
    assert.equal(asker.title, 'Вопрос человеку: Фича')
    assert.match(asker.spec, /## Что нужно выяснить\n\nСпроси про сроки/, 'спека ask — из runAskTaskSpec с инструкциями ноды')
    assert.match(asker.spec, /## Как спрашивать/)
    assert.equal(started.at(-1), asker.id)
    assert.equal(events('stage_started').length, 0, 'координатору вопрос человеку не адресован')

    // Вопрос идёт человеку (worker.ask → forceHuman по типу ноды), человек отвечает.
    const q = store.ask({ taskId: asker.id, dispatchId: asker.dispatchId, question: 'К какому сроку?' }, { forceHuman: true })
    store.resolveRequest(store.pendingRequests(runId).find((r) => r.questionId === q.id)!.id, { action: 'answer', text: 'к пятнице' })
    done(asker.id, 'выяснил')

    assert.equal(task(asker.id).status, 'done')
    assert.equal(stageId(runId), 'work')
    assert.match(String(lastEvent('stage_started').payload.answers), /К какому сроку\?\n {2}Ответ: к пятнице/)
    assert.match(store.runStage(runId)!.answers!, /к пятнице/)
  })

  it('повтор эффекта задачу не дублирует; падение агента после ответа — автоперезапуск', () => {
    const wf: Workflow = {
      version: 2,
      nodes: [node({ id: 'start', type: 'start' }), node({ id: 'ask', type: 'ask', roleId: 'reviewer', instructions: 'Спроси' }), node({ id: 'end', type: 'end' })],
      edges: [edge('start', 'next', 'ask'), edge('ask', 'next', 'end')]
    }
    const runId = newRun(wf)
    const asker = store.listTasks().find((t) => t.stageOf?.nodeId === 'ask')!
    startRunWorkflow(deps, runId)
    assert.equal(store.listTasks().filter((t) => t.stageOf?.nodeId === 'ask').length, 1)

    // Воркер спросил и упал; человек отвечает — приложение поднимает воркера само.
    const q = store.ask({ taskId: asker.id, dispatchId: asker.dispatchId, question: 'Как?' }, { forceHuman: true })
    store.ptyExited(task(asker.id).dispatchId ? store.getDispatch(task(asker.id).dispatchId!)!.ptyId : '', 1)
    const before = store.listEvents().length
    store.resolveRequest(store.pendingRequests(runId).find((r) => r.questionId === q.id)!.id, { action: 'answer', text: 'так' })
    const startsBefore = started.length
    deliver(before)
    assert.equal(started.length, startsBefore + 1)
    assert.equal(started.at(-1), asker.id)
  })
})

describe('подзадачи: автомерж и конфликт', () => {
  it('конфликт мержа подзадачи → approval «Конфликт мержа» на задаче; «Принять» после правки — мерж и done', () => {
    const runId = newRun()
    const a = spawn(runId, 'A')
    const b = spawn(runId, 'B')
    commit(a, 'shared.md', 'от A\n')
    commit(b, 'shared.md', 'от B\n')
    done(a.id)
    assert.equal(task(a.id).status, 'done')

    done(b.id)
    assert.notEqual(task(b.id).status, 'done')
    const request = store.pendingRequests(runId).find((r) => r.taskId === b.id)!
    assert.equal(request.kind, 'approval')
    assert.equal(request.nodeId, 'conflict', 'конфликт — нода пути подзадачи, а не запрос прогона')
    assert.match(request.title, /Конфликт мержа: B/)
    assert.match(request.body!, /Мерж не удался/)
    assert.equal(task(b.id).status, 'needs_input')
    assert.equal(events('stage_tasks_done').length, 0, 'этап не закрыт, пока конфликт не разрешён')

    // Человек правит ветку задачи: сливает в неё ветку прогона и выбирает своё.
    try {
      git(task(b.id).worktree!, 'merge', run(runId).git!.branch)
    } catch {
      writeFileSync(path.join(task(b.id).worktree!, 'shared.md'), 'общее\n')
      git(task(b.id).worktree!, 'add', '-A')
      git(task(b.id).worktree!, 'commit', '-qm', 'разрешён')
    }
    assert.equal(task(b.id).stage?.nodeId, 'conflict', 'подзадача стоит на ноде «Конфликт мержа» своего пути')
    resolve(request.id, 'accept')
    assert.equal(task(b.id).status, 'done')
    assert.equal(task(b.id).stage?.nodeId, 'end')
    assert.equal(git(run(runId).git!.worktree!, 'show', 'HEAD:shared.md'), 'общее')
    assert.equal(events('stage_tasks_done').length, 1)
  })

  it('«Вернуть» по конфликту — воркер стартует заново с замечаниями', () => {
    const runId = newRun()
    const a = spawn(runId, 'A')
    const b = spawn(runId, 'B')
    commit(a, 'shared.md', 'от A\n')
    commit(b, 'shared.md', 'от B\n')
    done(a.id)
    done(b.id)
    const request = store.pendingRequests(runId).find((r) => r.taskId === b.id)!
    const startsBefore = started.length
    resolve(request.id, 'reject', 'переделай поверх A')
    assert.equal(started.length, startsBefore + 1)
    assert.equal(started.at(-1), b.id)
    assert.equal(task(b.id).feedback, 'переделай поверх A')
    assert.equal(task(b.id).status, 'in_progress')
  })

  it('подзадачи прогонов старого формата новым движком не трогаются', () => {
    // Прогон без графа и типа — старый движок: worker_done не даёт автомержа.
    const legacy = store.createRun('старая цель')
    assert.equal(legacy.workflowScope, undefined)
    const t = store.createTask({ title: 'старая', runId: legacy.id })
    deps.startWorker(t.id)
    commit(task(t.id), 'old.ts')
    done(t.id)
    assert.equal(task(t.id).stage?.nodeId, 'review', 'прежний движок довёл задачу до этапа проверки')
    assert.equal(events('workflow_blocked').length, 0)
  })
})

/** Путь подзадачи с ревью: работа → проверка (reject → работа) → мерж (конфликт → человек) → конец. */
function reviewedPath(): WfSubflow {
  return {
    nodes: [
      node({ id: 'start', type: 'start' }), node({ id: 'w', type: 'work' }),
      node({ id: 'rev', type: 'gate', title: 'Ревью подзадачи', roleId: 'reviewer' }), node({ id: 'm', type: 'merge' }),
      node({ id: 'c', type: 'human', title: 'Конфликт мержа' }), node({ id: 'end', type: 'end', merged: true })
    ],
    edges: [
      edge('start', 'next', 'w'), edge('w', 'next', 'rev'), edge('rev', 'accept', 'm'), edge('rev', 'reject', 'w'),
      edge('m', 'ok', 'end'), edge('m', 'conflict', 'c'), edge('c', 'accept', 'm'), edge('c', 'reject', 'w')
    ]
  }
}

/** Граф прогона: «Реализация» с путём `reviewedPath` → человек «Проверка» (reject → снова «Реализация») → конец. */
function reviewedRun(): Workflow {
  return {
    version: 2,
    nodes: [
      node({ id: 'start', type: 'start' }),
      node({ id: 'impl', type: 'work', title: 'Реализация', subflow: reviewedPath() } as Partial<WfNode> & { id: string; type: 'work' }),
      node({ id: 'check', type: 'human', title: 'Проверка' }), node({ id: 'end', type: 'end' })
    ],
    edges: [edge('start', 'next', 'impl'), edge('impl', 'next', 'check'), edge('check', 'accept', 'end'), edge('check', 'reject', 'impl')]
  }
}

const subGateOf = (taskId: string): Task => store.listTasks().filter((t) => t.gateFor?.taskId === taskId).at(-1)!
const inRunBranch = (runId: string, file: string): boolean => existsSync(path.join(run(runId).git!.worktree!, file))
const workflowAt = (taskId: string) => deps.store.taskWorkflow(task(taskId), { roleIds: DEFAULT_ROLES.map((r) => r.id) })

describe('путь подзадачи: движок по подзадачам исполняет work.subflow', () => {
  it('без subflow — путь по умолчанию: work → merge → end, подзадача проходит его целиком, воркфлоу задачи — defaultSubflow', () => {
    const runId = newRun()
    const t = spawn(runId, 'A')
    assert.equal(task(t.id).stage?.nodeId, 'work', 'запуск воркера ввёл подзадачу в путь')
    assert.deepEqual(workflowAt(t.id).nodes.map((n) => n.id), ['start', 'work', 'merge', 'end', 'conflict'])
    commit(task(t.id), 'a.ts')
    done(t.id)
    assert.equal(task(t.id).stage?.nodeId, 'end')
    assert.equal(task(t.id).status, 'done')
    assert.deepEqual(task(t.id).stageHistory?.map((h) => h.nodeId), ['work', 'merge', 'end'])
    assert.equal(run(runId).stage?.nodeId, 'work', 'позиция прогона не сдвинулась: путь подзадачи независим')
  })

  it('gate reject → work → accept → merge: подзадача ходит по своему пути, ветка сливается только после accept', () => {
    const runId = newRun(reviewedRun())
    const t = spawn(runId, 'A')
    commit(task(t.id), 'a.ts')
    done(t.id)

    assert.equal(task(t.id).stage?.nodeId, 'rev')
    const gate1 = subGateOf(t.id)
    assert.equal(gate1.gateFor?.nodeId, 'rev')
    assert.equal(gate1.gateFor?.runId, undefined, 'проверка ветки подзадачи, а не ветки прогона')
    assert.equal(gate1.roleId, 'reviewer')
    assert.equal(inRunBranch(runId, 'a.ts'), false, 'до accept ветка подзадачи в ветку прогона не слита')
    assert.notEqual(task(t.id).status, 'done')
    assert.equal(events('stage_tasks_done').length, 0, 'этап держит подзадача на проверке')
    assert.equal(run(runId).stage?.nodeId, 'impl')

    const startsBefore = started.length
    reviewReject(deps as unknown as WorkflowDeps, t.id, 'нет тестов')
    assert.equal(task(t.id).stage?.nodeId, 'w')
    assert.equal(task(t.id).stage?.visits.w, 2)
    assert.equal(task(t.id).feedback, 'нет тестов')
    assert.equal(started.length, startsBefore + 1, 'воркер стартовал заново')
    assert.equal(started.at(-1), t.id)
    done(gate1.id)
    assert.equal(task(gate1.id).status, 'done', 'проверка, сдавшая done после решения, закрывается')

    commit(task(t.id), 'a.test.ts')
    done(t.id)
    const gate2 = subGateOf(t.id)
    assert.notEqual(gate2.id, gate1.id, 'новый заход — новая проверка')
    reviewAccept(deps as unknown as WorkflowDeps, t.id)
    assert.equal(task(t.id).stage?.nodeId, 'end')
    assert.equal(task(t.id).status, 'done')
    assert.equal(inRunBranch(runId, 'a.ts'), true)
    assert.equal(inRunBranch(runId, 'a.test.ts'), true)
    assert.equal(events('stage_tasks_done').length, 1, 'все подзадачи дошли до end пути — координатору stage_tasks_done')
    assert.deepEqual(task(t.id).stageHistory?.map((h) => h.nodeId), ['w', 'rev', 'w', 'rev', 'm', 'end'])
    done(gate2.id)
    assert.equal(task(gate2.id).status, 'done')
  })

  it('конфликт мержа после проверки: human пути; «Вернуть» — воркер заново, затем снова ревью', () => {
    const runId = newRun(reviewedRun())
    const a = spawn(runId, 'A')
    const b = spawn(runId, 'B')
    commit(task(a.id), 'shared.md', 'от A\n')
    commit(task(b.id), 'shared.md', 'от B\n')
    done(a.id)
    reviewAccept(deps as unknown as WorkflowDeps, a.id)
    done(b.id)
    reviewAccept(deps as unknown as WorkflowDeps, b.id)
    assert.equal(task(b.id).stage?.nodeId, 'c')
    const request = store.pendingRequests(runId).find((r) => r.taskId === b.id)!
    assert.equal(request.nodeId, 'c')
    assert.match(request.body!, /Мерж не удался/)

    const startsBefore = started.length
    resolve(request.id, 'reject', 'перебазируй на A')
    assert.equal(task(b.id).stage?.nodeId, 'w')
    assert.equal(started.length, startsBefore + 1)
    assert.equal(task(b.id).feedback, 'перебазируй на A')
    assert.equal(task(a.id).status, 'done')
    assert.equal(events('stage_tasks_done').length, 0)
  })

  it('повторный заход во внешний этап (visit 2): у новых подзадач путь с нуля, старые в счёт захода не входят', () => {
    const runId = newRun(reviewedRun())
    const a = spawn(runId, 'A')
    commit(task(a.id), 'a.ts')
    done(a.id)
    reviewAccept(deps as unknown as WorkflowDeps, a.id)
    assert.equal(events('stage_tasks_done').length, 1)
    finishRunStage(deps, runId, 'готово')
    assert.equal(stageId(runId), 'check')

    resolve(approvalOf(runId)!.id, 'reject', 'доработать')
    assert.equal(stageId(runId), 'impl')
    assert.equal(run(runId).stage?.visits.impl, 2)

    const b = spawn(runId, 'B')
    assert.deepEqual(b.stageOf, { nodeId: 'impl', visit: 2 })
    assert.equal(task(b.id).stage?.nodeId, 'w')
    assert.deepEqual(task(b.id).stage?.visits, { start: 1, w: 1 }, 'путь новой подзадачи начат с нуля')
    assert.equal(task(a.id).stage?.nodeId, 'end', 'путь старой подзадачи не тронут')
    assert.equal(run(runId).stageTasksDoneAt, undefined, 'заход 2 не закончен: старые подзадачи не в счёте')

    commit(task(b.id), 'b.ts')
    done(b.id)
    assert.equal(task(b.id).stage?.nodeId, 'rev')
    assert.equal(subGateOf(b.id).gateFor?.taskId, b.id)
    reviewAccept(deps as unknown as WorkflowDeps, b.id)
    assert.equal(task(b.id).status, 'done')
    assert.equal(events('stage_tasks_done').length, 2, 'заход 2 закончен — второй stage_tasks_done')
    assert.equal(inRunBranch(runId, 'b.ts'), true)
  })

  it('подзадача без привязки к этапу (создана до входа в граф) пути не имеет: workflow_blocked, приёмка вручную', () => {
    const g = store.createGlobalTask({ title: 'Ф', description: 'x', workflow: defaultWorkflow(DEFAULT_ROLES) })
    ensureRunBranch(store, repo, g.id, settings)
    const pty = `pty_coord_start_${g.id}`
    alive.add(pty)
    store.setRunPty(g.id, pty)
    const draft = store.createTask({ title: 'заготовка', runId: g.id })
    assert.equal(draft.stageOf, undefined)
    startRunWorkflow(deps, g.id)

    deps.startWorker(draft.id)
    commit(task(draft.id), 'draft.ts')
    done(draft.id)
    const blocked = lastEvent('workflow_blocked')
    assert.equal(blocked.payload.taskId, draft.id)
    assert.match(String(blocked.payload.reason), /не привязана к этапу/)
    assert.equal(task(draft.id).stage, undefined)
    assert.notEqual(task(draft.id).status, 'done')
    assert.equal(taskEngine(deps, task(draft.id)), 'run')
  })

  it('approval «Конфликт мержа» от сборки без пути (SUBTASK_MERGE_NODE): «Принять» вводит задачу в путь и сливает', () => {
    const runId = newRun()
    const t = spawn(runId, 'A')
    commit(task(t.id), 'a.ts')
    // Как при обновлении посреди конфликта: задача сдана, путь не начат, запрос старого формата ждёт человека.
    store.updateTask(t.id, { stage: undefined, stageHistory: undefined })
    store.finishDispatch(task(t.id).dispatchId!, 'сделал', [])
    const request = store.requestApproval(t.id, { nodeId: SUBTASK_MERGE_NODE, title: 'Конфликт мержа: A' })
    assert.equal(task(t.id).status, 'needs_input')
    assert.equal(task(t.id).stage, undefined)

    resolve(request.id, 'accept')
    assert.equal(task(t.id).status, 'done')
    assert.equal(task(t.id).stage?.nodeId, 'end')
    assert.equal(inRunBranch(runId, 'a.ts'), true)
  })
})

describe('путь подзадачи: событие обрабатывает ровно один исполнитель', () => {
  const only = (handler: (events: readonly OrcaEvent[]) => void, before: number): void => handler(store.listEvents().slice(before))
  const pathHandler = (e: readonly OrcaEvent[]): void => handleWorkflowEvents(deps as unknown as WorkflowDeps, e)
  const runHandler = (e: readonly OrcaEvent[]): void => handleRunWorkflowEvents(deps, e)

  it('taskEngine: подзадача этапа и её проверка — path; проверка и вопрос этапов прогона — run; прогон старого формата — legacy', () => {
    const wf: Workflow = {
      version: 2,
      nodes: [
        node({ id: 'start', type: 'start' }), node({ id: 'q', type: 'ask', roleId: 'developer' }),
        node({ id: 'impl', type: 'work', title: 'Реализация', subflow: reviewedPath() } as Partial<WfNode> & { id: string; type: 'work' }),
        node({ id: 'gate', type: 'gate', roleId: 'reviewer' }), node({ id: 'end', type: 'end' })
      ],
      edges: [
        edge('start', 'next', 'q'), edge('q', 'next', 'impl'), edge('impl', 'next', 'gate'), edge('gate', 'accept', 'end'), edge('gate', 'reject', 'impl')
      ]
    }
    const runId = newRun(wf)
    assert.equal(stageId(runId), 'q')
    const ask = store.listTasks().find((t) => t.runId === runId && t.stageOf?.nodeId === 'q')!
    assert.equal(taskEngine(deps, ask), 'run', 'задача этапа «Вопрос человеку» — движок прогона')
    done(ask.id)
    assert.equal(stageId(runId), 'impl')

    const sub = spawn(runId, 'A')
    assert.equal(taskEngine(deps, sub), 'path')
    commit(task(sub.id), 'a.ts')
    done(sub.id)
    assert.equal(taskEngine(deps, subGateOf(sub.id)), 'path', 'проверка ветки подзадачи — путь')
    reviewAccept(deps as unknown as WorkflowDeps, sub.id)
    finishRunStage(deps, runId, 'ok')
    assert.equal(stageId(runId), 'gate')
    assert.equal(taskEngine(deps, gateOf(runId)), 'run', 'проверка ветки прогона — граф прогона')

    const legacy = store.createRun('старая цель')
    assert.equal(taskEngine(deps, store.createTask({ title: 'старая', runId: legacy.id })), 'legacy')
  })

  it('worker_done подзадачи: движок прогона её пропускает, движок пути — ведёт; повторная доставка ничего не удваивает', () => {
    const runId = newRun(reviewedRun())
    const t = spawn(runId, 'A')
    commit(task(t.id), 'a.ts')
    const before = store.listEvents().length
    store.finishDispatch(task(t.id).dispatchId!, 'сделал', [])

    only(runHandler, before)
    assert.equal(task(t.id).stage?.nodeId, 'w', 'движок прогона подзадачу не трогает')
    assert.equal(store.listTasks().filter((x) => x.gateFor?.taskId === t.id).length, 0)
    assert.equal(events('workflow_blocked').length, 0)

    only(pathHandler, before)
    assert.equal(task(t.id).stage?.nodeId, 'rev')
    only(pathHandler, before)
    only(runHandler, before)
    assert.equal(store.listTasks().filter((x) => x.gateFor?.taskId === t.id).length, 1, 'проверка одна: сданный прошлый запуск переход не повторяет')
  })

  it('worker_done проверки ветки прогона: движок пути её пропускает, движок прогона — ведёт (сдана без решения → workflow_blocked)', () => {
    const runId = newRun()
    work(runId, 'a.ts')
    finishRunStage(deps, runId, 'ok')
    const gate = gateOf(runId)
    assert.equal(stageId(runId), 'review')
    const before = store.listEvents().length
    store.finishDispatch(gate.dispatchId!, 'проверил', [])

    only(pathHandler, before)
    assert.equal(events('workflow_blocked').length, 0, 'движок по подзадачам чужую проверку не трогает')
    assert.notEqual(task(gate.id).status, 'done')
    only(runHandler, before)
    assert.match(String(lastEvent('workflow_blocked').payload.reason), /сдана без решения/)
  })

  it('approval: запрос на задаче ведёт движок пути, запрос прогона — движок прогона', () => {
    const runId = newRun(reviewedRun())
    const t = spawn(runId, 'A')
    commit(task(t.id), 'a.ts')
    done(t.id)
    reviewAccept(deps as unknown as WorkflowDeps, t.id)
    finishRunStage(deps, runId, 'ok')
    const runRequest = approvalOf(runId)!
    const stageBefore = task(t.id).stage
    // Запрос прогона: движок пути (approvalResolved) его игнорирует.
    store.resolveRequest(runRequest.id, { action: 'accept' })
    approvalResolved(deps as unknown as WorkflowDeps, store.getRequest(runRequest.id)!)
    assert.equal(stageId(runId), 'check', 'approvalResolved на запросе прогона ничего не двигает')
    assert.deepEqual(task(t.id).stage, stageBefore)
    assert.equal(handleRunApproval(deps, store.getRequest(runRequest.id)!), true)
    assert.equal(stageId(runId), 'end')
  })
})

describe('advanceRun: смена этапов и легаси-граф без ролей', () => {
  it('condition attempts считает заходы прогона: лимит возвратов ведёт к human', () => {
    const wf: Workflow = {
      version: 2,
      nodes: [
        node({ id: 'start', type: 'start' }), node({ id: 'work', type: 'work' }),
        node({ id: 'gate', type: 'gate', roleId: 'reviewer' }),
        node({ id: 'limit', type: 'condition', test: { kind: 'attempts', node: 'work', atLeast: 2 } } as never),
        node({ id: 'human', type: 'human', title: 'Лимит возвратов' }), node({ id: 'end', type: 'end' })
      ],
      edges: [
        edge('start', 'next', 'work'), edge('work', 'next', 'gate'), edge('gate', 'accept', 'end'), edge('gate', 'reject', 'limit'),
        edge('limit', 'yes', 'human'), edge('limit', 'no', 'work'), edge('human', 'accept', 'end'), edge('human', 'reject', 'work')
      ]
    }
    const runId = newRun(wf)
    work(runId, 'a.ts')
    finishRunStage(deps, runId, 'v1')
    runGateDecision(deps, gateOf(runId).id, 'reject', 'плохо')
    assert.equal(stageId(runId), 'work', 'первый возврат — снова в работу')
    work(runId, 'b.ts')
    finishRunStage(deps, runId, 'v2')
    runGateDecision(deps, gateOf(runId).id, 'reject', 'всё ещё плохо')
    assert.equal(stageId(runId), 'human', 'второй заход в работу исчерпал лимит — решает человек')
    assert.ok(approvalOf(runId))
    advanceRun(deps, runId, 'accept')
    assert.equal(stageId(runId), 'end')
  })

  it('роль проверки удалили из типа — workflow_blocked, а не падение', () => {
    const runId = newRun()
    work(runId, 'a.ts')
    deps.run = () => ({ roles: DEFAULT_ROLES.filter((r) => r.id !== reviewer.id) })
    finishRunStage(deps, runId, 'ok')
    assert.equal(lastEvent('workflow_blocked').payload.runId, runId)
  })
})

describe('цель перезапущенного координатора: блок «# Этап»', () => {
  it('на «Работе»: роли, инструкции, замечания, подзадачи захода и stage finish; на проверке — цель без блока', () => {
    const wf = pipelineWorkflow([{ type: 'gate', id: 'review', roleId: 'reviewer', title: 'Ревью' }], { work: [{ id: 'work', title: 'Реализация', roleIds: ['developer', 'qa'], instructions: 'Сделай логин' }] })
    const runId = newRun(wf)
    const t = spawn(runId, 'Форма логина')
    alive.clear()

    let objective = resumeObjective(store, runId, deps.isAlive).objective
    assert.match(objective, /^сделать фичу\n\n# Этап: Реализация\n/)
    assert.match(objective, /Роли этапа: developer, qa — подзадачи создавай только с ними/)
    assert.match(objective, /## Инструкции этапа\n\nСделай логин/)
    assert.match(objective, new RegExp(`- ${t.id} \\[[^\\]]+\\] Форма логина`))
    assert.match(objective, /дождись `stage_tasks_done`/)
    assert.doesNotMatch(objective, /runs finish/, 'схема «Повторный запуск» по runs finish прогону нового формата не относится')

    commit(t, 'a.ts')
    done(t.id)
    objective = resumeObjective(store, runId, deps.isAlive).objective
    assert.match(objective, /`stage_tasks_done` уже отправлен[\s\S]*stage finish/, 'stage_tasks_done ушёл прошлому координатору — новому сказано в цели')

    finishRunStage(deps, runId, 'ok')
    objective = resumeObjective(store, runId, deps.isAlive).objective
    assert.equal(objective, 'сделать фичу', 'на проверке блока этапа нет: координатору делать нечего, он ждёт stage_started')

    runGateDecision(deps, gateOf(runId).id, 'reject', 'нет тестов')
    assert.deepEqual(coordinatorStarts, [runId], 'координатор мёртв — reject вернул в «Работу» и запустил его заново')
    alive.clear()
    objective = resumeObjective(store, runId, deps.isAlive).objective
    assert.match(objective, /# Этап: Реализация/)
    assert.match(objective, /заход 2/)
    assert.match(objective, /## Замечания проверки или человека\n\nнет тестов/)
    assert.match(objective, new RegExp(`Подзадачи прошлых заходов и этапов[^\\n]*\\n- ${t.id} `), 'подзадачи прошлого захода — списком, заново не создавать')
  })

  it('жив прежний координатор — ошибка; граф не начат — цель без изменений', () => {
    const runId = newRun()
    assert.throws(() => resumeObjective(store, runId, () => true), /уже работает/)
    const g = store.createGlobalTask({ title: 'Ещё не начата', description: 'цель', workflow: defaultWorkflow(DEFAULT_ROLES) })
    assert.equal(resumeObjective(store, g.id, () => false).objective, 'цель')
  })
})
