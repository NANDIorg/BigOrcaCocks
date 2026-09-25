// Запуск: pnpm --filter @orca-board/desktop test. Сквозной сценарий воркфлоу глобальной задачи (`Run.workflowScope: 'run'`)
// на настоящем git-репозитории во временной папке, настоящем ProjectManager (тип задачи с ролями и графом, доска в
// boards/) и исполнителе `workflow-run.ts`. PTY нет: координатор и воркеры — фейки, повторяющие контракт main
// (index.ts: `runWorker`, `startCoordinator`, `workflowDeps`, подписка `runWorkflowEvents`). «Координатор» в тесте — код,
// который читает события `stage_started` / `stage_tasks_done` и делает то же, что по skills/coordinator.md:
// `task create` + `worker start`, а на `stage_tasks_done` — `stage finish`.
// Граф: Анализ (роль planner) → человек «Выбор варианта» → Реализация (роли не заданы, 2 подзадачи) → проверка
// (reject → Реализация → accept) → человек «Проверка» → merge → end.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_ROLES, normalizeRunBranchSettings,
  type OrcaEvent, type Role, type RunBranchSettings, type Task, type TaskStore, type WfEdge, type WfNode, type Workflow
} from '@orca-board/core'
import {
  finishRunStage, handleRunApproval, handleRunWorkflowEvents, runGateDecision, startRunWorkflow, type RunWorkflowDeps
} from './workflow-run'
import { handleWorkflowEvents, type WorkflowDeps } from './workflow'
import { resolveHumanRequest } from './review'
import { ensureRunBranch, mergeTarget } from './run-branch'
import { taskWorktreePath } from './git'
import { ProjectManager, runnableWorkflow } from './projects'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const PLANNER: Role = { id: 'planner', title: 'Планировщик', agent: 'claude', description: 'Анализирует задачу и пишет план.' }
const ROLES: Role[] = [...DEFAULT_ROLES, PLANNER]

const node = (n: Partial<WfNode> & { id: string; type: WfNode['type'] }): WfNode => ({ x: 0, y: 0, ...n }) as WfNode
const edge = (from: string, outcome: WfEdge['outcome'], to: string): WfEdge => ({ id: `e_${from}_${outcome}`, from, outcome, to })

/** Граф из задания: Анализ (planner) → human → Реализация (без ролей) → gate (reject → Реализация) → human → merge → end. */
function featureWorkflow(): Workflow {
  return {
    version: 2,
    nodes: [
      node({ id: 'start', type: 'start' }),
      node({ id: 'analysis', type: 'work', title: 'Анализ', roleIds: ['planner'], instructions: 'Опиши варианты решения в analysis.md' }),
      node({ id: 'choice', type: 'human', title: 'Выбор варианта', instructions: 'Выберите вариант реализации' }),
      node({ id: 'impl', type: 'work', title: 'Реализация', instructions: 'Реализуй выбранный вариант' }),
      node({ id: 'review', type: 'gate', title: 'Ревью', roleId: 'reviewer' }),
      node({ id: 'check', type: 'human', title: 'Проверка', instructions: 'Проверьте результат' }),
      node({ id: 'merge', type: 'merge' }),
      node({ id: 'conflict', type: 'human', title: 'Конфликт мержа', instructions: 'Разрешите конфликт' }),
      node({ id: 'end', type: 'end' })
    ],
    edges: [
      edge('start', 'next', 'analysis'), edge('analysis', 'next', 'choice'),
      edge('choice', 'accept', 'impl'), edge('choice', 'reject', 'analysis'),
      edge('impl', 'next', 'review'), edge('review', 'accept', 'check'), edge('review', 'reject', 'impl'),
      edge('check', 'accept', 'merge'), edge('check', 'reject', 'impl'),
      edge('merge', 'ok', 'end'), edge('merge', 'conflict', 'conflict'),
      edge('conflict', 'accept', 'merge'), edge('conflict', 'reject', 'impl')
    ]
  }
}

interface Launch {
  taskId: string
  roleId: string
  agent: string
}

interface App {
  pm: ProjectManager
  store: TaskStore
  deps: RunWorkflowDeps
  launches: Launch[]
  coordinatorStarts: string[]
  alive: Set<string>
  settings: RunBranchSettings
}

let tmp: string
let repo: string
let typeId: string
let pid: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-wfrun-e2e-')))
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  writeFileSync(path.join(repo, 'README.md'), 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

/** Приложение над каталогом данных `tmp/user`: повторный вызов — «перезапуск» (тот же projects.json и доска, новые объекты). */
function startApp(settings: RunBranchSettings = normalizeRunBranchSettings(undefined)): App {
  const pm = new ProjectManager(path.join(tmp, 'user'))
  if (pid === undefined || !pm.get(pid)) {
    pid = pm.add(repo).id
    typeId = pm.saveTaskType({ title: 'Фича', settings: { roles: ROLES, workflow: featureWorkflow() } }).id
  }
  const store = pm.store(pid)
  const app: App = { pm, store, launches: [], coordinatorStarts: [], alive: new Set(), settings, deps: undefined as never }
  app.deps = {
    store,
    repoRoot: repo,
    // Как workflowDeps в index.ts: роли и граф типа прогона.
    run(runId) {
      const t = pm.resolveRun(pid, runId)
      const workflow = runnableWorkflow(t.workflow)
      return { roles: t.roles, ...(workflow ? { workflow } : {}) }
    },
    // Как runWorker + startWorker: роль задачи должна быть в типе, ветка задачи — от ветки прогона, dispatch с ролью.
    startWorker(taskId) {
      const t = store.getTask(taskId)!
      const role = app.deps.run(t.runId).roles.find((r) => r.id === t.roleId)
      if (!role) throw new Error(`воркер не запустится: роли «${t.roleId}» нет в типе задачи`)
      const runGit = ensureRunBranch(store, repo, t.runId, app.settings)
      const branch = t.branch ?? `orca/${taskId}`
      const worktree = t.worktree ?? taskWorktreePath(repo, taskId)
      if (!existsSync(worktree)) git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, ...(runGit ? [runGit.branch] : []))
      store.updateTask(taskId, { worktree, branch })
      app.launches.push({ taskId, roleId: role.id, agent: role.agent })
      const d = store.startDispatch(taskId, `pty_${taskId}_${app.launches.length}`, undefined, { roleId: t.roleId })
      return { ptyId: d.ptyId, dispatchId: d.id }
    },
    isAlive: (ptyId) => app.alive.has(ptyId),
    startCoordinator(runId) {
      app.coordinatorStarts.push(runId)
      const pty = `pty_coord_${app.coordinatorStarts.length}`
      app.alive.add(pty)
      store.setRunPty(runId, pty)
    },
    gitSettings: () => app.settings,
    mergeTarget: (t) => mergeTarget(store, repo, t, app.settings)
  }
  return app
}

/** Новая глобальная задача типа «Фича», как «Создать» + «Запустить координатора» (ветка, терминал, вход в граф). */
function startRun(app: App, title: string): string {
  const g = app.store.createGlobalTask({ title, description: `цель: ${title}`, type: app.pm.runType(pid, typeId) })
  assert.equal(app.store.getRun(g.id)!.workflowScope, 'run', 'граф типа версии 2 — прогон идёт по глобальной задаче')
  ensureRunBranch(app.store, repo, g.id, app.settings)
  const pty = `pty_coord_start_${g.id}`
  app.alive.add(pty)
  app.store.setRunPty(g.id, pty)
  startRunWorkflow(app.deps, g.id)
  return g.id
}

const events = (app: App, type: string): OrcaEvent[] => app.store.listEvents().filter((e) => e.type === type)
const lastEvent = (app: App, type: string): OrcaEvent => events(app, type).at(-1)!
const task = (app: App, id: string): Task => app.store.getTask(id)!
const stageId = (app: App, runId: string): string | undefined => app.store.getRun(runId)!.stage?.nodeId
const branchOf = (app: App, runId: string): string => app.store.getRun(runId)!.git!.branch
const approvalOf = (app: App, runId: string) => app.store.pendingRequests(runId).find((r) => r.kind === 'approval' && r.taskId === undefined)
const gateOf = (app: App, runId: string): Task => app.store.listTasks().filter((t) => t.gateFor?.runId === runId).at(-1)!
const inRunBranch = (app: App, runId: string, file: string): boolean => existsSync(path.join(app.store.getRun(runId)!.git!.worktree!, file))

/** События, появившиеся после `before`, — исполнителю обоих движков (подписка `runWorkflowEvents` в index.ts). */
function deliver(app: App, before: number): void {
  const fresh = app.store.listEvents().slice(before)
  handleWorkflowEvents(app.deps as unknown as WorkflowDeps, fresh)
  handleRunWorkflowEvents(app.deps, fresh)
}

/** Координатор: `task create` (store привязывает к этапу) + `worker start`. */
function spawn(app: App, runId: string, title: string, roleId?: string): Task {
  const t = app.store.createTask({ title, runId, ...(roleId ? { roleId } : {}) })
  app.deps.startWorker(t.id)
  return task(app, t.id)
}

/** Воркер коммитит файл в своей ветке, сдаёт `orca-board done` — приложение сливает ветку в ветку прогона. */
function deliverFile(app: App, t: Task, file: string): void {
  writeFileSync(path.join(t.worktree!, file), `${file}\n`)
  git(t.worktree!, 'add', '-A')
  git(t.worktree!, 'commit', '-qm', file)
  const before = app.store.listEvents().length
  app.store.finishDispatch(task(app, t.id).dispatchId!, 'сделал', [])
  deliver(app, before)
}

/** Решение запроса человеком (Инбокс / `request resolve`), как `resolveRequest` в index.ts. */
function resolve(app: App, requestId: string, action: 'accept' | 'reject', text?: string): void {
  resolveHumanRequest(app.store, repo, requestId, { action, ...(text ? { text } : {}) }, app.deps.startWorker, (r) => handleRunApproval(app.deps, r), app.deps.mergeTarget)
}

describe('воркфлоу глобальной задачи: сквозной сценарий', () => {
  it('анализ → человек → реализация (2 подзадачи) → ревью reject → реализация → ревью accept → человек → merge → end', () => {
    const app = startApp()
    // Старый прогон (без Run.workflowScope) живёт рядом и идёт прежним движком по подзадачам.
    const legacyRun = app.store.createRun('старая цель')
    assert.equal(legacyRun.workflowScope, undefined)
    const legacyTask = app.store.createTask({ title: 'старая', runId: legacyRun.id })
    app.deps.startWorker(legacyTask.id)

    const runId = startRun(app, 'Фича')
    assert.equal(app.store.getRun(runId)!.workflow?.version, 2)

    // --- Анализ: stage_started с ролью ноды, подзадачи только роли planner ---
    assert.equal(stageId(app, runId), 'analysis')
    const s1 = lastEvent(app, 'stage_started')
    assert.equal(s1.payload.runId, runId)
    assert.equal(s1.payload.nodeId, 'analysis')
    assert.deepEqual(s1.payload.roleIds, ['planner'])
    assert.match(String(s1.payload.instructions), /analysis\.md/)
    assert.equal(app.coordinatorStarts.length, 0, 'координатор жив — заново не запускается')
    assert.throws(() => app.store.createTask({ title: 'код на анализе', runId, roleId: 'developer' }), /роль «developer» не разрешена на этапе «Анализ»[\s\S]*«planner»/)
    const plan = spawn(app, runId, 'План')
    assert.equal(plan.roleId, 'planner', 'одна роль ноды берётся по умолчанию, если task create без --role')
    assert.deepEqual(plan.stageOf, { nodeId: 'analysis', visit: 1 })
    assert.equal(app.launches.at(-1)!.roleId, 'planner')
    assert.throws(() => finishRunStage(app.deps, runId, 'рано'), /не закрыты подзадачи/)
    deliverFile(app, plan, 'analysis.md')
    assert.equal(task(app, plan.id).status, 'done', 'воркер → done → автомерж → задача закрыта')
    assert.equal(inRunBranch(app, runId, 'analysis.md'), true, 'файл анализа в ветке прогона')
    assert.equal(existsSync(path.join(repo, 'analysis.md')), false, 'корень не тронут')
    assert.equal(events(app, 'stage_tasks_done').length, 1)
    assert.deepEqual(lastEvent(app, 'stage_tasks_done').payload.nodeId, 'analysis')
    assert.equal(stageId(app, runId), 'analysis', 'этап закрывает координатор командой stage finish, а не done воркера')
    // Автозакрытие старого движка («все подзадачи в done» + нет координатора) для прогона нового формата не работает.
    assert.deepEqual(app.store.settleIdleRuns(() => false), [])
    assert.equal(app.store.getRun(runId)!.closedAt, undefined)
    assert.equal(events(app, 'run_done').length, 0)

    // Легаси-задача прошла через свой движок и не задела прогон нового формата.
    const legacyBefore = app.store.listEvents().length
    app.store.finishDispatch(task(app, legacyTask.id).dispatchId!, 'старая сдана', [])
    deliver(app, legacyBefore)
    assert.equal(task(app, legacyTask.id).stage?.nodeId, 'review', 'прежний движок довёл подзадачу до этапа проверки')
    assert.equal(stageId(app, runId), 'analysis')

    // --- stage finish → human «Выбор варианта» (approval прогона без задачи) ---
    finishRunStage(app.deps, runId, 'варианты: A и B')
    assert.equal(stageId(app, runId), 'choice')
    const choice = approvalOf(app, runId)!
    assert.equal(choice.nodeId, 'choice')
    assert.match(choice.body!, /варианты: A и B/)
    assert.equal(app.store.getGlobalTask(runId).status, 'review', 'карточка на «Проверке», пока человек не ответил')
    assert.throws(() => app.store.createTask({ title: 'мимо', runId, roleId: 'planner' }), /подзадачи создаются только на этапе «Работа»[\s\S]*stage_started/)

    // --- Реализация: решение человека — в stage_started; роли не заданы — координатор выбирает сам ---
    resolve(app, choice.id, 'accept', 'вариант B')
    assert.equal(stageId(app, runId), 'impl')
    const s2 = lastEvent(app, 'stage_started')
    assert.equal(s2.payload.nodeId, 'impl')
    assert.deepEqual(s2.payload.roleIds, [])
    assert.equal(s2.payload.decision, 'вариант B')
    assert.throws(() => app.store.createTask({ title: 'ревью', runId, roleId: 'reviewer' }), /не разрешена на этапе «Реализация»[\s\S]*не роли проверки/)
    assert.throws(() => app.store.createTask({ title: 'коорд', runId, roleId: 'coordinator' }), /не разрешена на этапе/)
    const doneBefore = events(app, 'stage_tasks_done').length
    const a = spawn(app, runId, 'Модуль A', 'developer')
    const b = spawn(app, runId, 'Модуль B', 'qa')
    assert.deepEqual([a.stageOf, b.stageOf], [{ nodeId: 'impl', visit: 1 }, { nodeId: 'impl', visit: 1 }])
    deliverFile(app, a, 'a.ts')
    assert.equal(events(app, 'stage_tasks_done').length, doneBefore, 'вторая подзадача ещё в работе — этап не закрыт')
    deliverFile(app, b, 'b.ts')
    assert.equal(events(app, 'stage_tasks_done').length, doneBefore + 1)
    assert.equal(lastEvent(app, 'stage_tasks_done').payload.nodeId, 'impl')
    assert.equal(inRunBranch(app, runId, 'a.ts') && inRunBranch(app, runId, 'b.ts'), true, 'обе подзадачи слиты в ветку прогона')

    // --- Проверка ветки прогона целиком; reject → снова Реализация с замечаниями ---
    finishRunStage(app.deps, runId, 'модули готовы')
    assert.equal(stageId(app, runId), 'review')
    const gate1 = gateOf(app, runId)
    assert.equal(gate1.roleId, 'reviewer')
    assert.deepEqual(gate1.gateFor, { runId, nodeId: 'review' })
    assert.match(gate1.spec, new RegExp(`git diff master\\.\\.\\.${branchOf(app, runId)}`), 'проверяется ветка прогона против базы')
    assert.match(gate1.spec, /модули готовы/)
    assert.equal(app.launches.at(-1)!.taskId, gate1.id, 'проверку запустило приложение')
    assert.equal(events(app, 'stage_started').length, 2, 'на проверке координатору делать нечего')

    runGateDecision(app.deps, gate1.id, 'reject', 'нет тестов')
    assert.equal(stageId(app, runId), 'impl')
    assert.equal(app.store.getRun(runId)!.stage!.visits.impl, 2)
    const s3 = lastEvent(app, 'stage_started')
    assert.equal(s3.payload.feedback, 'нет тестов')
    assert.equal(s3.payload.visit, 2)
    // Закрытые подзадачи прошлого захода в счёт нового не идут: этап ждёт новых задач.
    assert.throws(() => finishRunStage(app.deps, runId, 'рано'), /нет подзадач/)
    const tests = spawn(app, runId, 'Тесты', 'qa')
    assert.deepEqual(tests.stageOf, { nodeId: 'impl', visit: 2 })
    deliverFile(app, tests, 'tests.ts')
    assert.equal(events(app, 'stage_tasks_done').length, 3, 'второй заход Реализации закрыт отдельным stage_tasks_done')
    finishRunStage(app.deps, runId, 'тесты добавлены')

    const gate2 = gateOf(app, runId)
    assert.notEqual(gate2.id, gate1.id)
    assert.match(gate2.spec, /модули готовы[\s\S]*тесты добавлены/, 'сводки обоих заходов видны новой проверке')
    const before = app.store.listEvents().length
    app.store.finishDispatch(task(app, gate1.id).dispatchId!, 'отклонено', [])
    deliver(app, before)
    assert.equal(task(app, gate1.id).status, 'done', 'старая проверка закрылась по своему done')
    assert.throws(() => runGateDecision(app.deps, gate1.id, 'accept'), /уже не актуальна/)
    runGateDecision(app.deps, gate2.id, 'accept')
    assert.equal(stageId(app, runId), 'check')

    // --- Человек «Проверка» → merge: защищённая master → blocked, после снятия защиты слито ---
    const check = approvalOf(app, runId)!
    assert.equal(check.nodeId, 'check')
    assert.match(check.body!, /Ветка: `feature\//)
    const masterBefore = git(repo, 'rev-parse', 'master')
    resolve(app, check.id, 'accept')
    assert.equal(stageId(app, runId), 'merge', 'позиция остаётся на merge')
    const blocked = lastEvent(app, 'workflow_blocked')
    assert.equal(blocked.payload.runId, runId)
    assert.equal(blocked.taskId, undefined, 'у прогона workflow_blocked без taskId')
    assert.match(String(blocked.payload.reason), /защищённую ветку «master» запрещено[\s\S]*git push/)
    assert.equal(git(repo, 'rev-parse', 'master'), masterBefore, 'в защищённую ветку ничего не слито')
    assert.equal(events(app, 'run_done').length, 0)

    app.settings = { ...app.settings, protected: [] }
    startRunWorkflow(app.deps, runId)
    assert.equal(stageId(app, runId), 'end')
    for (const f of ['analysis.md', 'a.ts', 'b.ts', 'tests.ts']) assert.equal(existsSync(path.join(repo, f)), true, `${f} слит в master`)
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'master', 'корень не переключался')
    assert.equal(git(repo, 'status', '--porcelain'), '')

    // --- end: run_done ровно один раз, карточка в «Сделано», история этапов ---
    assert.equal(events(app, 'run_done').length, 1)
    assert.equal(lastEvent(app, 'run_done').payload.runId, runId)
    assert.notEqual(app.store.getRun(runId)!.closedAt, undefined)
    assert.equal(app.store.columnKind(app.store.getRun(runId)!.status!), 'done')
    assert.deepEqual(
      app.store.getRun(runId)!.stageHistory!.map((h) => h.nodeId),
      ['analysis', 'choice', 'impl', 'review', 'impl', 'review', 'check', 'merge', 'end']
    )
    assert.equal(app.coordinatorStarts.length, 0, 'координатор жил весь прогон')
    // Старый прогон не задет: закрытие нового прогона не переводит его.
    assert.equal(app.store.getRun(legacyRun.id)!.closedAt, undefined)
  })

  it('перезапуск приложения на approval и мёртвый координатор: граф продолжается по сохранённой позиции', () => {
    const app = startApp()
    const runId = startRun(app, 'Фича')
    const plan = spawn(app, runId, 'План')
    deliverFile(app, plan, 'analysis.md')
    finishRunStage(app.deps, runId, 'варианты')
    const requestId = approvalOf(app, runId)!.id

    // Приложение закрыли и открыли снова: новые ProjectManager и store, терминалов нет.
    const again = startApp()
    assert.equal(stageId(again, runId), 'choice')
    assert.equal(approvalOf(again, runId)?.id, requestId, 'approval пережил перезапуск')
    assert.equal(again.alive.size, 0)

    // Решение человека после перезапуска: координатор не жив — «Работа» поднимает его заново.
    resolve(again, requestId, 'accept', 'вариант A')
    assert.equal(stageId(again, runId), 'impl')
    assert.deepEqual(again.coordinatorStarts, [runId])
    assert.equal(lastEvent(again, 'stage_started').payload.decision, 'вариант A')
    assert.equal(inRunBranch(again, runId, 'analysis.md'), true)
  })
})
