// Запуск: pnpm --filter @orca-board/desktop test. Сквозные сценарии разветвления графа глобальной задачи (`fork` … `join`,
// docs/workflow.md → «Разветвление»): настоящий git-репозиторий во временной папке, настоящие ProjectManager (тип с ролями и
// графом, доска в boards/), store, исполнитель `workflow-run.ts` и настоящий сокет. PTY нет: воркеры и терминал координатора —
// фейки, повторяющие контракт main (index.ts: `runWorker`, `startCoordinator`, `runWorkflowDeps`, подписка
// `runWorkflowEvents`). «Координатор» в тесте делает то же, что по skills/coordinator.md, — но командами CLI по сокету:
// `task create [--stage]`, `stage finish [--stage]`, `workflow show`; решения человека и проверяющих — тем, что зовёт
// приложение (`request resolve`, `review accept|reject`, `decision choose|escalate`, «Подтвердить» на карточке).
// Граф общий для большинства сценариев (`forkWorkflow`): Анализ → разветвление «Бэк и фронт» → пути → слияние → проверка ветки →
// человек → merge → end; остальные — урезанные под один сценарий.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  DEFAULT_ROLES, DEFAULT_COLUMNS, RunApprovalAmbiguousError, TaskStore, validateWorkflow,
  type AgentInfo, type GlobalTask, type HumanRequest, type OrcaEvent, type RequestResolution, type Role, type Run, type StageChange, type Task,
  type WfEdge, type WfNode, type WfSubflow, type Workflow
} from '@orca-board/core'
import {
  acceptRun, escalateDecision, finishRunStage, handleRunRequest, handleRunWorkflowEvents, hasIdleStage, isRunGate, returnRun, runDecision,
  runGateDecision, settleIdleRunStages, startRunWorkflow, type RunWorkflowDeps
} from './workflow-run'
import { approvalResolved, enterWork, handleWorkflowEvents, reviewAccept, reviewReject, type WorkflowDeps } from './workflow'
import { resolveHumanRequest } from './review'
import { resumeObjective } from './coordinator-resume'
import { ensureRunBranch, mergeTarget } from './run-branch'
import { taskWorktreePath } from './git'
import { OrcaError } from './i18n'
import { ProjectManager, runnableWorkflow } from './projects'
import { startSocketServer, type ProjectDeps } from './socket'
import { NOT_NEEDED_APP_SETTINGS_DEPS, NOT_NEEDED_SETTINGS_DEPS } from './socket-test-deps'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const ROLES: Role[] = DEFAULT_ROLES
const AGENTS: AgentInfo[] = [{ id: 'claude', title: 'Claude Code', installed: true, enabled: true, models: [], defaults: {} }]

const node = (n: Partial<WfNode> & { id: string; type: WfNode['type'] }): WfNode => ({ x: 0, y: 0, ...n }) as WfNode
const edge = (from: string, outcome: WfEdge['outcome'], to: string): WfEdge => ({ id: `e_${from}_${outcome}`, from, outcome, to })

const BRANCHES = [{ id: 'backend', label: 'Бэкенд' }, { id: 'frontend', label: 'Фронтенд' }]

/**
 * start → Анализ (work) → fork «Бэк и фронт»:
 *   backend  — «Бэкенд» (work) → «Ревью API» (gate; reject → Бэкенд) → «Приёмка API» (human; reject → Бэкенд) → слияние;
 *   frontend — «Фронтенд» (work) → «Макет» (human; reject → Фронтенд) → слияние;
 * слияние → «Ревью ветки» (gate; reject → fork) → «Проверка» (human; reject → fork) → merge (ok → end, conflict → человек) → end.
 */
function forkWorkflow(): Workflow {
  return {
    version: 2,
    nodes: [
      node({ id: 'start', type: 'start' }),
      node({ id: 'analysis', type: 'work', title: 'Анализ', instructions: 'Разбери задачу' }),
      node({ id: 'split', type: 'fork', title: 'Бэк и фронт', branches: BRANCHES }),
      node({ id: 'be', type: 'work', title: 'Бэкенд' }),
      node({ id: 'revApi', type: 'gate', title: 'Ревью API', roleId: 'reviewer' }),
      node({ id: 'humBe', type: 'human', title: 'Приёмка API' }),
      node({ id: 'fe', type: 'work', title: 'Фронтенд' }),
      node({ id: 'humFe', type: 'human', title: 'Макет' }),
      node({ id: 'merge_paths', type: 'join', forkId: 'split' }),
      node({ id: 'revAll', type: 'gate', title: 'Ревью ветки', roleId: 'reviewer' }),
      node({ id: 'check', type: 'human', title: 'Проверка', instructions: 'Проверьте результат обоих путей' }),
      node({ id: 'merge', type: 'merge' }),
      node({ id: 'conflict', type: 'human', title: 'Конфликт мержа' }),
      node({ id: 'end', type: 'end' })
    ],
    edges: [
      edge('start', 'next', 'analysis'), edge('analysis', 'next', 'split'),
      edge('split', 'backend', 'be'), edge('split', 'frontend', 'fe'),
      edge('be', 'next', 'revApi'), edge('revApi', 'accept', 'humBe'), edge('revApi', 'reject', 'be'),
      edge('humBe', 'accept', 'merge_paths'), edge('humBe', 'reject', 'be'),
      edge('fe', 'next', 'humFe'), edge('humFe', 'accept', 'merge_paths'), edge('humFe', 'reject', 'fe'),
      edge('merge_paths', 'next', 'revAll'), edge('revAll', 'accept', 'check'), edge('revAll', 'reject', 'split'),
      edge('check', 'accept', 'merge'), edge('check', 'reject', 'split'),
      edge('merge', 'ok', 'end'), edge('merge', 'conflict', 'conflict'),
      edge('conflict', 'accept', 'merge'), edge('conflict', 'reject', 'split')
    ]
  }
}

/** Линейный граф без `fork`: Анализ (work) → Ревью (gate; reject → Анализ) → Проверка (human) → merge → end. */
function linearWorkflow(): Workflow {
  return {
    version: 2,
    nodes: [
      node({ id: 'start', type: 'start' }),
      node({ id: 'analysis', type: 'work', title: 'Анализ', instructions: 'Разбери задачу' }),
      node({ id: 'review', type: 'gate', title: 'Ревью', roleId: 'reviewer' }),
      node({ id: 'check', type: 'human', title: 'Проверка' }),
      node({ id: 'merge', type: 'merge' }),
      node({ id: 'conflict', type: 'human', title: 'Конфликт мержа' }),
      node({ id: 'end', type: 'end' })
    ],
    edges: [
      edge('start', 'next', 'analysis'), edge('analysis', 'next', 'review'),
      edge('review', 'accept', 'check'), edge('review', 'reject', 'analysis'),
      edge('check', 'accept', 'merge'), edge('check', 'reject', 'analysis'),
      edge('merge', 'ok', 'end'), edge('merge', 'conflict', 'conflict'), edge('conflict', 'accept', 'merge'), edge('conflict', 'reject', 'analysis')
    ]
  }
}

interface Launch {
  taskId: string
  roleId: string
}

interface App {
  pm: ProjectManager
  store: TaskStore
  deps: RunWorkflowDeps
  launches: Launch[]
  coordinatorStarts: string[]
  alive: Set<string>
  /** Запуск воркеров не удаётся (агент недоступен): эффект ноды встаёт в `workflow_blocked`, задача остаётся в ready. */
  workersDown: boolean
}

let tmp: string
let sockDir: string
let sockPath: string
let server: Server
let repo: string
let typeId: string | undefined
let pid: string | undefined
/** Приложение, которому сейчас отвечает сокет: «перезапуск» (`startApp`) подменяет его. */
let current: App

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-wffork-e2e-')))
  // Сокет — в своей короткой папке: путь unix-сокета ограничен ~100 символами.
  sockDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ow-')))
  sockPath = process.platform === 'win32' ? `\\\\.\\pipe\\orca-wffork-${process.pid}-${Date.now()}` : path.join(sockDir, 's.sock')
  repo = path.join(tmp, 'repo')
  typeId = undefined
  pid = undefined
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  writeFileSync(path.join(repo, 'README.md'), 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  server = startSocketServer(sockPath, { resolve: () => projectDeps(current), projects: () => [], ...NOT_NEEDED_APP_SETTINGS_DEPS })
  await new Promise((r) => server.once('listening', r))
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  rmSync(tmp, { recursive: true, force: true })
  rmSync(sockDir, { recursive: true, force: true })
})

/** Приложение над каталогом данных `tmp/user`: повторный вызов — «перезапуск» (тот же projects.json и доска, новые объекты). */
function startApp(workflow: Workflow = forkWorkflow(), roles: Role[] = ROLES): App {
  const pm = new ProjectManager(path.join(tmp, 'user'))
  if (pid === undefined || !pm.get(pid)) {
    pid = pm.add(repo).id
    typeId = pm.saveTaskType({ title: 'Фича', settings: { roles, workflow } }).id
  }
  const projectId = pid
  const store = pm.store(projectId)
  const app: App = { pm, store, launches: [], coordinatorStarts: [], alive: new Set(), workersDown: false, deps: undefined as never }
  app.deps = {
    store,
    repoRoot: repo,
    // Как runWorkflowDeps в index.ts: роли и граф типа прогона.
    run(runId) {
      const t = pm.resolveRun(projectId, runId)
      const wf = runnableWorkflow(t.workflow)
      return { roles: t.roles, ...(wf ? { workflow: wf } : {}) }
    },
    // Как runWorker + startWorker: подзадача входит в путь (`enterWork`), ветка задачи — от ветки прогона, dispatch с ролью.
    startWorker(taskId) {
      if (app.workersDown) throw new Error('агент недоступен')
      enterWork(app.deps as unknown as WorkflowDeps, taskId)
      const t = store.getTask(taskId)!
      const role = app.deps.run(t.runId).roles.find((r) => r.id === t.roleId)
      if (!role) throw new Error(`воркер не запустится: роли «${t.roleId}» нет в типе задачи`)
      const runGit = ensureRunBranch(store, repo, t.runId)
      const branch = t.branch ?? `orca/${taskId}`
      const worktree = t.worktree ?? taskWorktreePath(repo, taskId)
      if (!existsSync(worktree)) git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, ...(runGit ? [runGit.branch] : []))
      store.updateTask(taskId, { worktree, branch })
      app.launches.push({ taskId, roleId: role.id })
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
    mergeTarget: (t) => mergeTarget(store, repo, t)
  }
  current = app
  return app
}

/** Решение запроса человеком (Инбокс / `request resolve`), как `resolveRequest` в index.ts. */
function resolveRequest(app: App, id: string, resolution: RequestResolution): void {
  resolveHumanRequest(app.store, repo, id, resolution, app.deps.startWorker, (r) => {
    if (!handleRunRequest(app.deps, r)) approvalResolved(app.deps as unknown as WorkflowDeps, r)
  }, app.deps.mergeTarget)
}

/** Решение проверки (`review accept|reject`), как `reviewDecision` в index.ts: проверка ветки прогона или подзадачи. */
function reviewDecision(app: App, taskId: string, decision: 'accept' | 'reject', text?: string): Task | undefined {
  const legacy = app.deps as unknown as WorkflowDeps
  if (isRunGate(app.store.getTask(taskId))) runGateDecision(app.deps, taskId, decision, text)
  else if (decision === 'accept') reviewAccept(legacy, taskId, text)
  else reviewReject(legacy, taskId, text ?? '')
  return app.store.getTask(taskId)
}

/** То, что main отдаёт сокету проекта (`ProjectDeps` в index.ts); не нужное сценариям — заглушки. */
function projectDeps(app: App): ProjectDeps {
  const unneeded = (): never => { throw new Error('не нужен в сквозном тесте') }
  return {
    store: app.store,
    startWorker: (taskId) => {
      const w = app.deps.startWorker(taskId)
      const t = app.store.getTask(taskId)!
      return { ...w, worktree: t.worktree!, branch: t.branch! }
    },
    stopWorker: () => ({ stopped: [] }),
    review: unneeded,
    accept: (taskId, decision) => void reviewDecision(app, taskId, 'accept', decision),
    reject: (taskId, feedback) => reviewDecision(app, taskId, 'reject', feedback),
    finishStage: (runId, summary, nodeId) => finishRunStage(app.deps, runId, summary, nodeId),
    decide: (taskId, option, reason) => runDecision(app.deps, taskId, option, reason),
    escalateDecision: (taskId, reason) => escalateDecision(app.deps, taskId, reason),
    resolveRequest: (id, resolution) => resolveRequest(app, id, resolution),
    startCoordinator: unneeded,
    deleteGlobalTask: unneeded,
    agents: () => AGENTS,
    resolveRun: (runId) => app.pm.resolveRun(pid!, runId),
    taskTypes: () => ({ taskTypes: app.pm.taskTypes(), defaultTypeId: app.pm.projectDefaultTypeId(pid!) }),
    runType: unneeded,
    saveTaskTypeRules: unneeded,
    columns: () => app.store.columns(),
    workflow: unneeded,
    ...NOT_NEEDED_SETTINGS_DEPS
  }
}

// ---------- CLI по сокету ----------

interface Reply<T> {
  ok: boolean
  error?: string
  result: T
}

function call<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<Reply<T>> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ id: '1', method, params }) + '\n'))
    sock.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      sock.destroy()
      resolve(JSON.parse(buf.slice(0, nl)) as Reply<T>)
    })
    sock.on('error', reject)
  })
}

/** Команда, которая должна пройти: результат или провал теста с текстом ошибки сокета. */
async function cli<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await call<T>(method, params)
  assert.equal(res.ok, true, `${method}: ${res.error}`)
  return res.result
}

/** Команда, которую приложение должно отвергнуть: текст ошибки сокета. */
async function cliError(method: string, params: Record<string, unknown>): Promise<string> {
  const res = await call(method, params)
  assert.equal(res.ok, false, `${method} должен был отказать, ответ: ${JSON.stringify(res.result)}`)
  return res.error!
}

interface StageReply {
  run: string
  finished?: string
  stage?: { nodeId: string; visits: number }
  lanes?: Array<{ nodeId: string; lane: string; arrived: boolean }>
  next: { type: string; nodeId: string; reason?: string }
}

interface ShowInfo {
  nodeId: string
  type: string
  title: string
  visit: number
  lane?: string
  laneTitle?: string
  arrived?: boolean
  feedback?: string
  answers?: string
  decision?: string
  tasks: string[]
  tasksDoneAt?: number
}

interface ShowReply {
  scope: string
  stage?: ShowInfo
  lanes?: ShowInfo[]
  stages: Array<{ id: string; branches?: Array<{ id: string; label?: string }>; forkId?: string }>
  history?: Array<{ nodeId: string; lane?: string; from?: string; outcome?: string }>
}

// ---------- помощники сценариев ----------

/** Новая глобальная задача типа «Фича», как «Создать» + «Запустить координатора» (ветка, терминал, вход в граф). */
function startRun(app: App, title = 'Фича'): string {
  const g = app.store.createGlobalTask({ title, description: `цель: ${title}`, type: app.pm.runType(pid!, typeId) })
  assert.equal(app.store.getRun(g.id)!.workflowScope, 'run', 'граф типа версии 2 — прогон идёт по глобальной задаче')
  ensureRunBranch(app.store, repo, g.id)
  const coordinator = `pty_coord_start_${g.id}`
  app.alive.add(coordinator)
  app.store.setRunPty(g.id, coordinator)
  startRunWorkflow(app.deps, g.id)
  return g.id
}

/** События прогона по типу: переходы подзадач по пути (`stage_changed` с `taskId`) — не в счёт. */
const events = (app: App, type: string): OrcaEvent[] => app.store.listEvents().filter((e) => e.type === type && e.payload.taskId === undefined)
const lastEvent = (app: App, type: string): OrcaEvent => events(app, type).at(-1)!
const task = (app: App, id: string): Task => app.store.getTask(id)!
const run = (app: App, runId: string): Run => app.store.getRun(runId)!
const stageId = (app: App, runId: string): string | undefined => run(app, runId).stage?.nodeId
const branchOf = (app: App, runId: string): string => run(app, runId).git!.branch
const inRunBranch = (app: App, runId: string, file: string): boolean => existsSync(path.join(run(app, runId).git!.worktree!, file))
const global = (app: App, runId: string): GlobalTask => app.store.getGlobalTask(runId)
/** Где стоит каждый путь: `{ backend: 'be', frontend: 'humFe' }`. */
const lanesAt = (app: App, runId: string): Record<string, string> =>
  Object.fromEntries((run(app, runId).lanes ?? []).map((l) => [l.branchId, l.nodeId]))
const approvals = (app: App, runId: string): HumanRequest[] =>
  app.store.pendingRequests(runId).filter((r) => r.kind === 'approval' && r.taskId === undefined)
const approvalAt = (app: App, runId: string, nodeId: string): HumanRequest => {
  const r = approvals(app, runId).find((x) => x.nodeId === nodeId)
  assert.ok(r, `нет ждущего approval ноды «${nodeId}»`)
  return r
}
const gateOf = (app: App, runId: string, nodeId: string): Task => {
  const g = app.store.listTasks().filter((t) => t.gateFor?.runId === runId && t.gateFor.nodeId === nodeId).at(-1)
  assert.ok(g, `нет задачи-проверки/решателя ноды «${nodeId}»`)
  return g
}
const historyOf = (app: App, runId: string, lane?: string): StageChange[] =>
  (run(app, runId).stageHistory ?? []).filter((h) => h.lane === lane)

/** Событие в одну строку — чтобы порядок сверять одним `deepEqual`. */
function brief(e: OrcaEvent): string {
  const p = e.payload
  const lane = typeof p.lane === 'string' ? ` [${p.lane}]` : ''
  switch (e.type) {
    case 'stage_changed': return `changed ${p.from ?? '∅'}→${p.to} (${p.outcome})${lane}`
    case 'stage_started': return `started ${p.nodeId}#${p.visit}${lane}`
    case 'stage_tasks_done': return `tasks_done ${p.nodeId}${lane}`
    case 'workflow_blocked': return `blocked ${p.nodeId ?? '∅'}${lane}`
    default: return e.type
  }
}

const FLOW = new Set(['stage_changed', 'stage_started', 'stage_tasks_done', 'workflow_blocked', 'run_done'])
/** События движка, появившиеся после `before`, в порядке появления. */
const flowSince = (app: App, before: number): string[] =>
  app.store.listEvents().slice(before).filter((e) => FLOW.has(e.type) && e.payload.taskId === undefined).map(brief)
const mark = (app: App): number => app.store.listEvents().length

/** События, появившиеся после `before`, — исполнителю обоих движков (подписка `runWorkflowEvents` в index.ts). */
function deliver(app: App, before: number): void {
  const fresh = app.store.listEvents().slice(before)
  handleWorkflowEvents(app.deps as unknown as WorkflowDeps, fresh)
  handleRunWorkflowEvents(app.deps, fresh)
}

/** Координатор: `task create [--stage]` по сокету (store привязывает к этапу) + `worker start`. */
async function spawn(app: App, runId: string, title: string, o: { stage?: string; role?: string } = {}): Promise<Task> {
  const created = await cli<Task>('task.create', { run: runId, title, role: o.role ?? 'developer', ...(o.stage !== undefined ? { stage: o.stage } : {}) })
  app.deps.startWorker(created.id)
  return task(app, created.id)
}

/** Воркер коммитит файл в своей ветке. */
function commitFile(t: Task, file: string, text = `${file}\n`): void {
  writeFileSync(path.join(t.worktree!, file), text)
  git(t.worktree!, 'add', '-A')
  git(t.worktree!, 'commit', '-qm', file)
}

/** `orca-board done` воркера: приложение сливает ветку подзадачи в ветку прогона (путь подзадачи). */
function finishWorker(app: App, taskId: string, summary = 'сделал'): void {
  const before = mark(app)
  app.store.finishDispatch(task(app, taskId).dispatchId!, summary, [])
  deliver(app, before)
}

/** Воркер коммитит файл и сдаёт `done`. */
function deliverFile(app: App, t: Task, file: string, text?: string): void {
  commitFile(t, file, text)
  finishWorker(app, t.id)
}

/** Одна подзадача этапа: создана (`--stage`), файл закоммичен, `done` (автомерж в ветку прогона). */
async function work(app: App, runId: string, stage: string | undefined, file: string): Promise<Task> {
  const t = await spawn(app, runId, file, stage !== undefined ? { stage } : {})
  deliverFile(app, t, file)
  return task(app, t.id)
}

/** Анализ закрыт (`stage finish` без `--stage`): прогон вошёл в разветвление, пути стоят на «Бэкенд» и «Фронтенд». */
async function toLanes(app: App): Promise<string> {
  const runId = startRun(app)
  await work(app, runId, undefined, 'analysis.md')
  await cli<StageReply>('stage.finish', { run: runId, summary: 'анализ готов' })
  assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'fe' })
  return runId
}

/** Ключи всех вложенных объектов — чтобы искать «лишние» ключи пути в структурах, где их быть не должно. */
function keysDeep(v: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, into))
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      into.add(k)
      keysDeep(x, into)
    }
  }
  return into
}

/**
 * Оба пути от «Работы» до слияния: «Бэкенд» (подзадача, stage finish, проверка принята, человек принял) и «Фронтенд»
 * (подзадача, stage finish, человек принял) — граф на проверке общей ветки (`revAll`). Сводки — `API: <tag>` и `UI: <tag>`.
 */
async function throughLanes(app: App, runId: string, files: { be: string; fe: string }, tag: string): Promise<void> {
  await work(app, runId, 'be', files.be)
  await cli('stage.finish', { run: runId, stage: 'be', summary: `API: ${tag}` })
  await cli('review.accept', { task: gateOf(app, runId, 'revApi').id })
  await work(app, runId, 'fe', files.fe)
  await cli('stage.finish', { run: runId, stage: 'fe', summary: `UI: ${tag}` })
  await cli('request.resolve', { request: approvalAt(app, runId, 'humBe').id, accept: true })
  await cli('request.resolve', { request: approvalAt(app, runId, 'humFe').id, accept: true })
  assert.equal(run(app, runId).lanes, undefined, 'оба пути пришли — разветвление закрыто')
  assert.equal(stageId(app, runId), 'revAll')
}

const LANE_KEYS = ['lane', 'lanes', 'laneTitle', 'forkVisit', 'branchId', 'forkId', 'arrivedAt', 'arrived', 'branches']
const laneKeysIn = (v: unknown): string[] => LANE_KEYS.filter((k) => keysDeep(v).has(k))

describe('разветвление fork/join: граф сценариев', () => {
  it('граф валиден: пути с gate и human, слияние, возврат после слияния — через fork', () => {
    assert.deepEqual(validateWorkflow(forkWorkflow(), { roles: ROLES }).errors, [])
  })
})

describe('(1) регрессия: прогон без fork', () => {
  it('линейный граф: состояние и события — без ключей разветвления, payload ровно прежний', async () => {
    const app = startApp(linearWorkflow())
    const runId = startRun(app)
    const shown = await cli<ShowReply>('workflow.show', { run: runId })
    assert.equal(shown.scope, 'run')
    assert.equal(shown.stage?.nodeId, 'analysis')
    assert.equal('lanes' in shown, false, 'workflow show без разветвления — без lanes')

    // Анализ → stage finish без `--stage` (один открытый этап) → проверка ветки; reject с замечаниями → снова Анализ.
    await work(app, runId, undefined, 'a.md')
    const finished = await cli<StageReply>('stage.finish', { run: runId, summary: 'разобрал' })
    assert.deepEqual(finished.stage, { nodeId: 'review', visits: 1 })
    assert.equal('lanes' in finished, false, 'ответ stage finish без разветвления — без lanes')
    assert.deepEqual(finished.next, { type: 'create_gate', nodeId: 'review' })
    await cli('review.reject', { task: gateOf(app, runId, 'review').id, feedback: 'нет выводов' })
    assert.equal(stageId(app, runId), 'analysis')
    await work(app, runId, undefined, 'b.md')
    await cli('stage.finish', { run: runId, summary: 'дополнил' })
    await cli('review.accept', { task: gateOf(app, runId, 'review').id })
    assert.equal(stageId(app, runId), 'check')
    acceptRun(app.deps, runId)
    assert.equal(stageId(app, runId), 'end')
    assert.equal(events(app, 'run_done').length, 1)

    // Ни одного ключа пути: ни в событиях, ни в прогоне, ни в карточке, ни в истории, ни в возвратах.
    const r = run(app, runId)
    assert.equal('lanes' in r, false)
    assert.equal('lanes' in global(app, runId), false)
    for (const e of app.store.listEvents()) assert.deepEqual(laneKeysIn(e.payload), [], `событие ${e.type}: ключи пути без разветвления`)
    assert.deepEqual(laneKeysIn({ ...r, workflow: undefined }), [], 'Run без fork не несёт ключей пути')
    assert.deepEqual(laneKeysIn(global(app, runId)), [])
    assert.deepEqual(laneKeysIn(await cli('global.get', { global: runId })), [])
    assert.deepEqual(laneKeysIn(app.store.pendingRequests(runId)), [])
    for (const h of r.stageHistory!) assert.equal('lane' in h, false, `запись истории «${h.nodeId}» без lane`)
    assert.ok(r.returns?.length, 'замечание reject записано')
    for (const x of r.returns!) assert.equal('nodeId' in x, false, 'Run.returns без nodeId: у линейного прогона нода возврата не нужна')

    // Payload событий — ровно прежние наборы ключей.
    const keys = (type: string): string[] => Object.keys(events(app, type)[0].payload).sort()
    assert.deepEqual(keys('stage_started'), ['instructions', 'nodeId', 'roleIds', 'runId', 'title', 'visit'])
    assert.deepEqual(Object.keys(events(app, 'stage_started')[1].payload).sort(), ['feedback', 'instructions', 'nodeId', 'roleIds', 'runId', 'title', 'visit'], 'возврат несёт замечания, без ключей пути')
    assert.deepEqual(keys('stage_tasks_done'), ['nodeId', 'runId'])
    assert.deepEqual(keys('stage_changed'), ['nodeType', 'outcome', 'runId', 'title', 'to'], 'первый переход — без from')
    assert.deepEqual(Object.keys(events(app, 'stage_changed')[1].payload).sort(), ['from', 'nodeType', 'outcome', 'runId', 'title', 'to'])
    assert.deepEqual(keys('run_done'), ['nodeId', 'objective', 'runId'])
    assert.deepEqual(app.store.listEvents().filter((e) => e.type === 'workflow_blocked'), [])
    // Порядок этапов: как у линейного прогона, записи общие.
    assert.deepEqual(r.stageHistory!.map((h) => h.nodeId), ['analysis', 'review', 'analysis', 'review', 'check', 'merge', 'end'])
  })
})

describe('(2) fork → два пути → слияние → gate → human → end', () => {
  it('порядок событий, task create --stage, stage finish --stage, stage_tasks_done на путь, общая ветка в слиянии', async () => {
    const app = startApp()
    const runId = startRun(app)
    assert.equal(stageId(app, runId), 'analysis')
    assert.equal(events(app, 'stage_started').length, 1)
    assert.equal('lane' in lastEvent(app, 'stage_started').payload, false, 'до разветвления — без lane')

    // --- Анализ (один открытый этап): task create и stage finish без --stage, как раньше ---
    const analysis = await spawn(app, runId, 'Анализ')
    assert.deepEqual(analysis.stageOf, { nodeId: 'analysis', visit: 1 })
    deliverFile(app, analysis, 'analysis.md')
    assert.deepEqual(lastEvent(app, 'stage_tasks_done').payload, { runId, nodeId: 'analysis' })

    // --- вход в разветвление: по stage_started на путь, порядок — как в branches ---
    const before = mark(app)
    const entered = await cli<StageReply>('stage.finish', { run: runId, summary: 'анализ готов' })
    assert.equal(entered.finished, 'analysis')
    assert.deepEqual(entered.stage, { nodeId: 'split', visits: 1 }, 'основная позиция запаркована на fork')
    assert.deepEqual(entered.lanes, [
      { nodeId: 'be', lane: 'split:backend', arrived: false }, { nodeId: 'fe', lane: 'split:frontend', arrived: false }
    ])
    assert.deepEqual(entered.next, { type: 'start_stage', nodeId: 'be' })
    assert.deepEqual(flowSince(app, before), [
      'changed analysis→split (next)',
      'changed split→be (backend) [split:backend]', 'started be#1 [split:backend]',
      'changed split→fe (frontend) [split:frontend]', 'started fe#1 [split:frontend]'
    ])
    const startedBe = events(app, 'stage_started').at(-2)!.payload
    const startedFe = events(app, 'stage_started').at(-1)!.payload
    assert.equal(startedBe.laneTitle, 'Бэкенд')
    assert.equal(startedFe.laneTitle, 'Фронтенд')
    assert.equal(app.coordinatorStarts.length, 0, 'координатор жив: два stage_started ему, перезапуска нет')
    assert.equal(global(app, runId).status, app.store.columnId('in_progress'))
    assert.deepEqual(global(app, runId).lanes!.map((l) => [l.id, l.forkId, l.branchId, l.nodeId, l.arrivedAt]), [
      ['split:backend', 'split', 'backend', 'be', undefined], ['split:frontend', 'split', 'frontend', 'fe', undefined]
    ], 'карточка глобальной задачи несёт позиции путей')
    assert.deepEqual((await cli<GlobalTask>('global.get', { global: runId })).lanes!.map((l) => l.nodeId), ['be', 'fe'], 'и global get по сокету')

    // --- workflow show: оба открытых этапа, stage — первая «Работа», fork/join описаны ---
    const shown = await cli<ShowReply>('workflow.show', { run: runId })
    assert.deepEqual(shown.lanes!.map((l) => [l.nodeId, l.lane, l.laneTitle, l.arrived]), [
      ['be', 'split:backend', 'Бэкенд', false], ['fe', 'split:frontend', 'Фронтенд', false]
    ])
    assert.equal(shown.stage!.nodeId, 'be')
    assert.deepEqual(shown.stages.find((s) => s.id === 'split')!.branches, BRANCHES)
    assert.equal(shown.stages.find((s) => s.id === 'merge_paths')!.forkId, 'split')
    assert.deepEqual(shown.history!.filter((h) => h.lane).map((h) => `${h.lane}:${h.nodeId}`), ['split:backend:be', 'split:frontend:fe'])

    // --- --stage обязателен, пока открыто два этапа «Работа»; чужой и не «Работа» этап отвергаются ---
    assert.match(await cliError('task.create', { run: runId, title: 'X', role: 'developer' }), /--stage обязателен: открыты этапы «Бэкенд» \(be\), «Фронтенд» \(fe\)/)
    assert.match(await cliError('task.create', { run: runId, title: 'X', role: 'developer', stage: 'humFe' }), /этап «humFe».*не открыт/)
    assert.match(await cliError('task.create', { run: runId, title: 'X', role: 'developer', stage: 'split' }), /только на этапе «Работа»/)
    assert.match(await cliError('stage.finish', { run: runId }), /--stage обязателен/)
    assert.match(await cliError('stage.finish', { run: runId, stage: 'be' }), /нет подзадач/)
    assert.match(await cliError('task.create', { run: runId, title: 'X', stage: true }), /--stage требует id этапа/)
    assert.equal(app.store.listTasks().filter((t) => t.title === 'X').length, 0, 'отказы ничего не создали')

    // --- подзадачи на каждый путь; stage_tasks_done приходит на путь, а не на прогон ---
    const api1 = await spawn(app, runId, 'API-1', { stage: 'be' })
    const api2 = await spawn(app, runId, 'API-2', { stage: 'be' })
    const ui = await spawn(app, runId, 'UI', { stage: 'fe' })
    assert.deepEqual([api1.stageOf, api2.stageOf, ui.stageOf], [{ nodeId: 'be', visit: 1 }, { nodeId: 'be', visit: 1 }, { nodeId: 'fe', visit: 1 }])
    assert.deepEqual((await cli<ShowReply>('workflow.show', { run: runId })).lanes!.map((l) => l.tasks), [[api1.id, api2.id], [ui.id]])
    const doneBefore = events(app, 'stage_tasks_done').length
    deliverFile(app, api1, 'api1.ts')
    assert.equal(events(app, 'stage_tasks_done').length, doneBefore, 'вторая подзадача «Бэкенда» ещё в работе')
    deliverFile(app, ui, 'ui.html')
    assert.equal(events(app, 'stage_tasks_done').length, doneBefore + 1)
    assert.deepEqual(lastEvent(app, 'stage_tasks_done').payload, { runId, nodeId: 'fe', lane: 'split:frontend' }, 'закрыт путь «Фронтенд», «Бэкенд» не задет')
    deliverFile(app, api2, 'api2.ts')
    assert.deepEqual(lastEvent(app, 'stage_tasks_done').payload, { runId, nodeId: 'be', lane: 'split:backend' })
    assert.equal(events(app, 'stage_tasks_done').length, doneBefore + 2, 'по одному stage_tasks_done на путь')
    assert.equal(stageId(app, runId), 'split', 'закрывает этап координатор (stage finish), а не done воркера')

    // --- stage finish --stage fe: путь идёт к «Макету» (human), «Бэкенд» остаётся на «Работе» ---
    const feDone = await cli<StageReply>('stage.finish', { run: runId, stage: 'fe', summary: 'UI готов' })
    assert.equal(feDone.finished, 'fe')
    assert.deepEqual(feDone.lanes, [{ nodeId: 'be', lane: 'split:backend', arrived: false }, { nodeId: 'humFe', lane: 'split:frontend', arrived: false }])
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'humFe' })
    const macet = approvalAt(app, runId, 'humFe')
    assert.match(macet.body!, /Итог этапа:\*\* UI готов/)
    assert.equal(run(app, runId).status, app.store.columnId('in_progress'), '«Бэкенд» ещё работает — карточка не на «Проверке»')
    assert.equal(global(app, runId).status, app.store.columnId('needs_input'), 'но ждущий approval поднимает её в «Нужен ответ»')

    // Открыт один этап «Работа» — команды без --stage работают как раньше и берут именно его.
    const finishedBe = await cli<StageReply>('stage.finish', { run: runId, summary: 'API готово' })
    assert.equal(finishedBe.finished, 'be')
    assert.deepEqual(lanesAt(app, runId), { backend: 'revApi', frontend: 'humFe' })
    const gateApi = gateOf(app, runId, 'revApi')
    assert.match(gateApi.spec, /«Бэкенд»/, 'проверка внутри пути знает свой путь')
    assert.match(gateApi.spec, new RegExp(`git diff master\\.\\.\\.${branchOf(app, runId)}`), 'проверяется общая ветка прогона')
    assert.equal(app.launches.at(-1)!.taskId, gateApi.id, 'проверку запустило приложение')
    assert.match(await cliError('stage.finish', { run: runId }), /сейчас не на этапе «Работа»/)
    assert.match(await cliError('task.create', { run: runId, title: 'X', role: 'developer' }), /только на этапе «Работа»/, 'открытых «Работ» нет — подзадачи негде создавать')

    // --- обе приёмки ждут человека; слияние ждёт все пути ---
    await cli('review.accept', { task: gateApi.id })
    assert.deepEqual(lanesAt(app, runId), { backend: 'humBe', frontend: 'humFe' })
    assert.deepEqual(approvals(app, runId).map((r) => r.nodeId).sort(), ['humBe', 'humFe'])
    const mergeBefore = mark(app)
    await cli('request.resolve', { request: macet.id, accept: true })
    assert.deepEqual(lanesAt(app, runId), { backend: 'humBe', frontend: 'merge_paths' }, 'путь «Фронтенд» пришёл в слияние и ждёт')
    assert.equal(stageId(app, runId), 'split')
    assert.deepEqual(flowSince(app, mergeBefore), ['changed humFe→merge_paths (accept) [split:frontend]'], 'у пришедшего пути нет эффектов и stage_started')
    assert.equal(app.store.listTasks().filter((t) => t.gateFor?.nodeId === 'revAll').length, 0, 'проверка ветки ждёт оба пути')
    const joinBefore = mark(app)
    await cli('request.resolve', { request: approvalAt(app, runId, 'humBe').id, accept: true })

    // --- слияние: разветвление закрыто, gate — на объединённой ветке ---
    assert.equal(run(app, runId).lanes, undefined, 'пришли все пути — разветвление закрыто')
    assert.equal('lanes' in global(app, runId), false, 'карточка после слияния — без путей')
    assert.equal(stageId(app, runId), 'revAll')
    assert.deepEqual(flowSince(app, joinBefore), ['changed humBe→merge_paths (accept) [split:backend]', 'changed merge_paths→revAll (next)'])
    for (const f of ['api1.ts', 'api2.ts', 'ui.html']) assert.equal(inRunBranch(app, runId, f), true, `${f} — в общей ветке прогона`)
    const gateAll = gateOf(app, runId, 'revAll')
    assert.match(gateAll.spec, /API готово[\s\S]*UI готов|UI готов[\s\S]*API готово/, 'проверка ветки видит сводки обоих путей')
    assert.doesNotMatch(gateAll.spec, /## Путь разветвления/, 'после слияния контекста пути нет')
    assert.match(run(app, runId).summary!.text, /### Путь «Бэкенд»\n\nAPI готово/)
    assert.match(run(app, runId).summary!.text, /### Путь «Фронтенд»\n\nUI готов/)

    // --- проверка → человек (одно ждущее approval: «Подтвердить» на карточке) → merge → end ---
    await cli('review.accept', { task: gateAll.id })
    assert.equal(stageId(app, runId), 'check')
    assert.equal(approvals(app, runId).length, 1)
    assert.match(approvalAt(app, runId, 'check').body!, /Итог этапа:\*\* ### Путь «Бэкенд»/)
    assert.equal(global(app, runId).status, app.store.columnId('review'))
    acceptRun(app.deps, runId)
    assert.equal(stageId(app, runId), 'end')
    for (const f of ['analysis.md', 'api1.ts', 'api2.ts', 'ui.html']) assert.equal(existsSync(path.join(repo, f)), true, `${f} слит в master`)
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'master', 'корень не переключался')
    assert.equal(git(repo, 'status', '--porcelain'), '')
    assert.equal(events(app, 'run_done').length, 1)
    assert.notEqual(run(app, runId).closedAt, undefined)
    assert.equal(events(app, 'workflow_blocked').length, 0)

    // --- история: общие записи, записи путей с lane, первая запись пути — ребро от fork ---
    assert.deepEqual(historyOf(app, runId).map((h) => h.nodeId), ['analysis', 'split', 'revAll', 'check', 'merge', 'end'])
    assert.deepEqual(historyOf(app, runId, 'split:backend').map((h) => h.nodeId), ['be', 'revApi', 'humBe', 'merge_paths'])
    assert.deepEqual(historyOf(app, runId, 'split:frontend').map((h) => h.nodeId), ['fe', 'humFe', 'merge_paths'])
    const firstBe = historyOf(app, runId, 'split:backend')[0]
    assert.deepEqual([firstBe.from, firstBe.outcome], ['split', 'backend'], 'первая запись пути — ребро от fork, walkHistory восстановит ребро')
    const afterJoin = historyOf(app, runId).find((h) => h.nodeId === 'revAll')!
    assert.deepEqual([afterJoin.from, afterJoin.outcome], ['merge_paths', 'next'], 'после слияния запись без lane от join')
  })
})

describe('(3) reject внутри пути возвращает только его', () => {
  it('reject проверки пути: stage_started с замечаниями только ему; соседний путь, его подзадачи и события не тронуты', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    const api = await work(app, runId, 'be', 'api.ts')
    const ui = await work(app, runId, 'fe', 'ui.html')
    const feDone = events(app, 'stage_tasks_done').find((e) => e.payload.nodeId === 'fe')!
    await cli('stage.finish', { run: runId, stage: 'be', summary: 'API готово' })
    const gate1 = gateOf(app, runId, 'revApi')

    const before = mark(app)
    await cli('review.reject', { task: gate1.id, feedback: 'нет тестов' })
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'fe' }, 'вернулся только «Бэкенд»')
    assert.deepEqual(flowSince(app, before), ['changed revApi→be (reject) [split:backend]', 'started be#2 [split:backend]'])
    const again = lastEvent(app, 'stage_started').payload
    assert.equal(again.feedback, 'нет тестов')
    assert.equal(again.visit, 2)
    assert.equal(again.lane, 'split:backend')
    assert.equal(again.laneTitle, 'Бэкенд')

    // Замечания — у пути, а не у прогона; у соседа их нет.
    const shown = await cli<ShowReply>('workflow.show', { run: runId })
    const [be, fe] = shown.lanes!
    assert.deepEqual([be.nodeId, be.visit, be.feedback, be.tasks], ['be', 2, 'нет тестов', []])
    assert.deepEqual([fe.nodeId, fe.visit, fe.feedback, fe.tasks], ['fe', 1, undefined, [ui.id]], 'сосед: заход, замечания и подзадачи прежние')
    assert.notEqual(fe.tasksDoneAt, undefined, 'подзадачи соседа закрыты — метка «всё сделано» не сбита')
    assert.equal(feDone.consumedBy, undefined, 'непрочитанный stage_tasks_done соседа координатору остался')
    assert.deepEqual(run(app, runId).returns!.map((x) => [x.text, x.nodeId]), [['нет тестов', 'revApi']], 'замечание помнит ноду возврата')
    assert.equal(task(app, ui.id).status, 'done')
    assert.equal(approvals(app, runId).length, 0)

    // Подзадачи прошлого захода в счёт нового не идут: этап ждёт новых.
    assert.match(await cliError('stage.finish', { run: runId, stage: 'be' }), /нет подзадач/)
    const api2 = await spawn(app, runId, 'Тесты API', { stage: 'be' })
    assert.deepEqual(api2.stageOf, { nodeId: 'be', visit: 2 })
    assert.equal(api.stageOf!.visit, 1)
    const doneBefore = events(app, 'stage_tasks_done').length
    deliverFile(app, api2, 'api.test.ts')
    assert.deepEqual(lastEvent(app, 'stage_tasks_done').payload, { runId, nodeId: 'be', lane: 'split:backend' }, 'второй заход закрыт отдельным stage_tasks_done')
    assert.equal(events(app, 'stage_tasks_done').length, doneBefore + 1)
    await cli('stage.finish', { run: runId, stage: 'be', summary: 'тесты добавлены' })

    // Старая проверка уже не решает: граф ушёл на новую.
    const gate2 = gateOf(app, runId, 'revApi')
    assert.notEqual(gate2.id, gate1.id)
    assert.match(gate2.spec, /API готово[\s\S]*тесты добавлены/, 'новая проверка видит сводки обоих заходов пути')
    assert.match(await cliError('review.accept', { task: gate1.id }), /уже не актуальна/)
    await cli('review.accept', { task: gate2.id })
    assert.deepEqual(lanesAt(app, runId), { backend: 'humBe', frontend: 'fe' })
  })

  it('reject человека в пути: соседний путь уже в слиянии — его позиция, время прихода и события не меняются', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    await work(app, runId, 'be', 'api.ts')
    await cli('stage.finish', { run: runId, stage: 'be', summary: 'API готово' })
    await cli('review.accept', { task: gateOf(app, runId, 'revApi').id })
    await cli('request.resolve', { request: approvalAt(app, runId, 'humBe').id, accept: true })
    assert.deepEqual(lanesAt(app, runId), { backend: 'merge_paths', frontend: 'fe' })
    const arrivedAt = run(app, runId).lanes!.find((l) => l.branchId === 'backend')!.arrivedAt
    assert.notEqual(arrivedAt, undefined)

    await work(app, runId, 'fe', 'ui.html')
    await cli('stage.finish', { run: runId, summary: 'UI готов' })
    const before = mark(app)
    await cli('request.resolve', { request: approvalAt(app, runId, 'humFe').id, reject: 'перерисуй кнопки' })
    assert.deepEqual(lanesAt(app, runId), { backend: 'merge_paths', frontend: 'fe' }, 'вернулся «Фронтенд», «Бэкенд» ждёт в слиянии')
    assert.deepEqual(flowSince(app, before), ['changed humFe→fe (reject) [split:frontend]', 'started fe#2 [split:frontend]'])
    assert.equal(lastEvent(app, 'stage_started').payload.feedback, 'перерисуй кнопки')
    assert.equal(run(app, runId).lanes!.find((l) => l.branchId === 'backend')!.arrivedAt, arrivedAt)
    assert.equal(run(app, runId).lanes!.find((l) => l.branchId === 'backend')!.stageInput, undefined, 'замечания — не пришедшему пути')
    assert.deepEqual(run(app, runId).returns!.map((x) => x.nodeId), ['humFe'])
    assert.equal(stageId(app, runId), 'split', 'разветвление не закрылось')
    // Решать на пути, который уже в слиянии, нечего: граф не двигается от чужого решения.
    assert.match(await cliError('review.accept', { task: gateOf(app, runId, 'revApi').id }), /уже не актуальна/)

    // Вторая попытка «Фронтенда» проходит до слияния — разветвление закрывается, как обычно.
    await work(app, runId, undefined, 'ui2.html')
    await cli('stage.finish', { run: runId, summary: 'UI переделан' })
    await cli('request.resolve', { request: approvalAt(app, runId, 'humFe').id, accept: true })
    assert.equal(run(app, runId).lanes, undefined)
    assert.equal(stageId(app, runId), 'revAll')
  })
})

describe('(4) два human в путях', () => {
  it('решение одного не двигает другой; «Подтвердить»/«Вернуть» с карточки при двух ждущих — отказ с кодом, при одном — работает', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    await work(app, runId, 'be', 'api.ts')
    await cli('stage.finish', { run: runId, stage: 'be', summary: 'API готово' })
    await cli('review.accept', { task: gateOf(app, runId, 'revApi').id })
    await work(app, runId, undefined, 'ui.html')
    await cli('stage.finish', { run: runId, summary: 'UI готов' })
    assert.deepEqual(lanesAt(app, runId), { backend: 'humBe', frontend: 'humFe' })
    const [humBe, humFe] = [approvalAt(app, runId, 'humBe'), approvalAt(app, runId, 'humFe')]
    assert.notEqual(humBe.id, humFe.id, 'по запросу на ноду')
    assert.equal(global(app, runId).status, app.store.columnId('review'), 'все пути ждут человека — карточка на «Проверке»')
    assert.equal(run(app, runId).lanes!.length, 2)

    // Карточка не знает, чей путь: отказ с кодом, ничего не решено и не сдвинуто.
    const before = mark(app)
    for (const attempt of [() => acceptRun(app.deps, runId), () => returnRun(app.deps, runId, 'переделать')]) {
      assert.throws(attempt, (e: unknown) => {
        assert.ok(e instanceof RunApprovalAmbiguousError)
        assert.equal(e.code, 'runApprovalAmbiguous')
        assert.deepEqual([...e.requestIds].sort(), [humBe.id, humFe.id].sort())
        return true
      })
    }
    assert.deepEqual(flowSince(app, before), [])
    assert.equal(app.store.getRequest(humBe.id)!.status, 'pending')
    assert.equal(app.store.getRequest(humFe.id)!.status, 'pending')
    assert.deepEqual(lanesAt(app, runId), { backend: 'humBe', frontend: 'humFe' })

    // Решение по «Приёмке API» (вернуть) двигает только «Бэкенд»; «Макет» ждёт как ждал.
    await cli('request.resolve', { request: humBe.id, reject: 'добавь валидацию' })
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'humFe' })
    assert.equal(app.store.getRequest(humFe.id)!.status, 'pending', 'approval соседа не тронут')
    assert.equal(approvals(app, runId).length, 1)
    assert.equal(lastEvent(app, 'stage_started').payload.lane, 'split:backend')
    assert.equal(run(app, runId).status, app.store.columnId('in_progress'), '«Бэкенд» снова работает — карточка не на «Проверке»')

    // Ждущий один — «Подтвердить» с карточки решает именно его: «Фронтенд» приходит в слияние.
    acceptRun(app.deps, runId, 'выглядит хорошо')
    assert.equal(app.store.getRequest(humFe.id)!.status, 'resolved')
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'merge_paths' })
    assert.equal(stageId(app, runId), 'split')
    assert.throws(() => acceptRun(app.deps, runId), /нет запроса на проверку/, 'ждущих нет — понятная ошибка, а не молчаливый успех')

    // «Бэкенд» снова до человека; теперь ждёт один approval — «Вернуть» с карточки работает.
    await work(app, runId, undefined, 'api2.ts')
    await cli('stage.finish', { run: runId, summary: 'валидация добавлена' })
    await cli('review.accept', { task: gateOf(app, runId, 'revApi').id })
    assert.equal(approvals(app, runId).length, 1)
    returnRun(app.deps, runId, 'ещё правки')
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'merge_paths' })
    assert.equal(lastEvent(app, 'stage_started').payload.feedback, 'ещё правки')
  })
})

describe('(5) заблокированный путь', () => {
  it('проверка пути не запустилась → workflow_blocked с lane; соседний путь идёт; повтор запускает её без дублей', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    await work(app, runId, 'be', 'api.ts')
    const before = mark(app)
    // Агент-проверяющий недоступен ровно в момент закрытия этапа: переход состоялся, эффект — нет.
    app.workersDown = true
    const finished = await cli<StageReply>('stage.finish', { run: runId, stage: 'be', summary: 'API готово' })
    app.workersDown = false
    assert.equal(finished.next.type, 'create_gate', 'сам переход прошёл — блокируется только эффект ноды')
    assert.deepEqual(lanesAt(app, runId), { backend: 'revApi', frontend: 'fe' })
    const blocked = events(app, 'workflow_blocked')
    assert.equal(blocked.length, 1)
    assert.equal(blocked[0].payload.nodeId, 'revApi')
    assert.equal(blocked[0].payload.lane, 'split:backend', 'блок принадлежит пути, а не прогону целиком')
    assert.match(String(blocked[0].payload.reason), /проверка .* не запустилась: агент недоступен/)
    assert.deepEqual(flowSince(app, before), ['changed be→revApi (next) [split:backend]', 'blocked revApi [split:backend]'])
    const gate = gateOf(app, runId, 'revApi')
    assert.equal(app.launches.some((l) => l.taskId === gate.id), false, 'воркер проверки не стартовал')

    // Соседний путь идёт как шёл: работа, закрытие этапа, человек, приход в слияние.
    await work(app, runId, undefined, 'ui.html')
    await cli('stage.finish', { run: runId, summary: 'UI готов' })
    await cli('request.resolve', { request: approvalAt(app, runId, 'humFe').id, accept: true })
    assert.deepEqual(lanesAt(app, runId), { backend: 'revApi', frontend: 'merge_paths' })
    assert.equal(events(app, 'workflow_blocked').length, 1, 'соседний путь новых блоков не породил')

    // Повтор при всё ещё сломанной причине: блок только у заблокированного пути (у «Фронтенда» в слиянии эффектов нет).
    app.workersDown = true
    startRunWorkflow(app.deps, runId)
    assert.deepEqual(events(app, 'workflow_blocked').map((e) => e.payload.lane), ['split:backend', 'split:backend'])
    assert.equal(app.store.listTasks().filter((t) => t.gateFor?.nodeId === 'revApi').length, 1, 'задача проверки не дублируется')

    // Причину исправили — повтор (как «Запустить заново» / перезапуск) снимает блок: воркер проверки стартует, блока нет.
    app.workersDown = false
    startRunWorkflow(app.deps, runId)
    assert.equal(events(app, 'workflow_blocked').length, 2, 'новых блоков нет')
    assert.equal(app.launches.filter((l) => l.taskId === gate.id).length, 1, 'воркер проверки запущен ровно один раз')
    assert.equal(app.store.listTasks().filter((t) => t.gateFor?.nodeId === 'revApi').length, 1)
    startRunWorkflow(app.deps, runId)
    assert.equal(app.launches.filter((l) => l.taskId === gate.id).length, 1, 'ещё повтор — идущая проверка не перезапускается')

    // Путь пошёл: проверка принята, человек принял — слияние закрывается, граф идёт дальше.
    await cli('review.accept', { task: gate.id })
    await cli('request.resolve', { request: approvalAt(app, runId, 'humBe').id, accept: true })
    assert.equal(run(app, runId).lanes, undefined)
    assert.equal(stageId(app, runId), 'revAll')
  })

  it('проверка пути сдала done без решения → workflow_blocked этого пути; решение «Принять» после блока проходит, соседний путь не затронут', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    await work(app, runId, 'be', 'api.ts')
    await cli('stage.finish', { run: runId, stage: 'be', summary: 'API готово' })
    const gate = gateOf(app, runId, 'revApi')
    const before = mark(app)
    finishWorker(app, gate.id, 'проверил, но решения не вынес')
    assert.deepEqual(flowSince(app, before), ['blocked revApi [split:backend]'])
    assert.match(String(lastEvent(app, 'workflow_blocked').payload.reason), /сдана без решения/)
    assert.deepEqual(lanesAt(app, runId), { backend: 'revApi', frontend: 'fe' }, 'позиции не сдвинулись')
    assert.equal(task(app, gate.id).status, app.store.columnId('review'), 'проверка осталась на ревью — её можно решить или перезапустить')

    await cli('review.accept', { task: gate.id })
    assert.deepEqual(lanesAt(app, runId), { backend: 'humBe', frontend: 'fe' })
    assert.equal(task(app, gate.id).status, app.store.columnId('done'), 'решение закрыло задачу проверки')
    assert.equal(events(app, 'workflow_blocked').length, 1)
  })

  it('git-нода в пути: push не удался → исход error ведёт к человеку этого пути (блока нет); после исправления «Принять» повторяет push', async () => {
    const wf: Workflow = {
      version: 2,
      nodes: [
        node({ id: 'start', type: 'start' }),
        node({ id: 'split', type: 'fork', title: 'Два пути', branches: BRANCHES }),
        node({ id: 'be', type: 'work', title: 'Бэкенд' }),
        node({ id: 'fe', type: 'work', title: 'Фронтенд' }),
        node({ id: 'pushFe', type: 'git', title: 'Push фронтенда', operation: 'push' }),
        node({ id: 'pushFail', type: 'human', title: 'Push не удался' }),
        node({ id: 'join', type: 'join', forkId: 'split' }),
        node({ id: 'check', type: 'human', title: 'Проверка' }),
        node({ id: 'end', type: 'end' })
      ],
      edges: [
        edge('start', 'next', 'split'), edge('split', 'backend', 'be'), edge('split', 'frontend', 'fe'),
        edge('be', 'next', 'join'), edge('fe', 'next', 'pushFe'), edge('pushFe', 'ok', 'join'), edge('pushFe', 'error', 'pushFail'),
        edge('pushFail', 'accept', 'pushFe'), edge('pushFail', 'reject', 'fe'),
        edge('join', 'next', 'check'), edge('check', 'accept', 'end'), edge('check', 'reject', 'split')
      ]
    }
    const v = validateWorkflow(wf, { roles: ROLES })
    assert.deepEqual(v.errors, [])
    assert.ok(v.warnings.some((w) => w.code === 'forkPushInBranch'), 'push внутри пути — предупреждение, не ошибка')
    const app = startApp(wf)
    const runId = startRun(app)
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'fe' })
    await work(app, runId, 'fe', 'ui.html')
    await work(app, runId, 'be', 'api.ts')

    // «Фронтенд»: push в origin, которого нет → git отказал → исход error, путь стоит у человека со своим запросом.
    const finishedFe = await cli<StageReply>('stage.finish', { run: runId, stage: 'fe', summary: 'UI готов' })
    assert.equal(finishedFe.next.type, 'git')
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'pushFail' })
    const fail = approvalAt(app, runId, 'pushFail')
    assert.match(fail.body!, /Git-операция «push» не удалась/)
    assert.equal(events(app, 'workflow_blocked').length, 0, 'ошибка git с переходом error — не блок')

    // «Бэкенд» закрывается штатно и приходит в слияние — git-путь соседа его не держит.
    await cli('stage.finish', { run: runId, summary: 'API готово' })
    assert.deepEqual(lanesAt(app, runId), { backend: 'join', frontend: 'pushFail' })
    assert.notEqual(run(app, runId).lanes!.find((l) => l.branchId === 'backend')!.arrivedAt, undefined)

    // Remote появился — человек «Принимает»: граф возвращается в git-ноду этого пути, push проходит, путь приходит в слияние.
    const remote = path.join(tmp, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote])
    git(repo, 'remote', 'add', 'origin', remote)
    await cli('request.resolve', { request: fail.id, accept: true })
    assert.equal(run(app, runId).lanes, undefined, 'оба пути в слиянии — разветвление закрыто')
    assert.equal(stageId(app, runId), 'check')
    assert.equal(events(app, 'workflow_blocked').length, 0)
    assert.match(git(remote, 'branch', '--list', branchOf(app, runId)), /feature\//, 'ветка прогона запушена')
    assert.deepEqual(historyOf(app, runId, 'split:frontend').map((h) => h.nodeId), ['fe', 'pushFe', 'pushFail', 'pushFe', 'join'])
  })
})

describe('(6) рестарт приложения посреди разветвления', () => {
  /** Состояние всех путей, как оно лежит в снимке: по нему видно, что рестарт ничего не потерял и не добавил. */
  const lanesSnapshot = (app: App, runId: string): string => JSON.stringify(run(app, runId).lanes)

  it('пути на проверке и у человека: рестарт и повторы эффектов не дублируют задачи, запросы и события; решения после рестарта идут по путям', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    await work(app, runId, 'be', 'api.ts')
    await cli('stage.finish', { run: runId, stage: 'be', summary: 'API готово' })
    await work(app, runId, undefined, 'ui.html')
    await cli('stage.finish', { run: runId, summary: 'UI готов' })
    assert.deepEqual(lanesAt(app, runId), { backend: 'revApi', frontend: 'humFe' })
    const gate = gateOf(app, runId, 'revApi')
    const request = approvalAt(app, runId, 'humFe')
    const snapshot = lanesSnapshot(app, runId)
    const tasks = app.store.listTasks().length
    const eventsBefore = app.store.listEvents().length

    // Приложение закрыли и открыли снова: новые ProjectManager и store, терминалов нет.
    const again = startApp()
    assert.equal(lanesSnapshot(again, runId), snapshot, 'позиции путей пережили рестарт байт в байт')
    assert.equal(stageId(again, runId), 'split')
    assert.equal(again.alive.size, 0)
    assert.equal(again.store.columnKind(task(again, gate.id).status), 'ready', 'воркер проверки умер вместе с приложением — задача вернулась в очередь')
    for (let i = 0; i < 3; i += 1) {
      startRunWorkflow(again.deps, runId)
      assert.equal(again.store.listTasks().length, tasks, `повтор эффектов №${i + 1}: задачи проверки не дублируются`)
      assert.equal(approvals(again, runId).length, 1, 'approval «Макета» один')
      assert.equal(approvalAt(again, runId, 'humFe').id, request.id, 'тот же запрос')
      assert.equal(gateOf(again, runId, 'revApi').id, gate.id)
      // Убитого воркера проверки повтор поднимает один раз — ту же задачу; approval ничего не запускает.
      assert.deepEqual(again.launches, [{ taskId: gate.id, roleId: 'reviewer' }], `повтор №${i + 1}: воркер проверки запущен ровно один раз`)
      assert.deepEqual(again.coordinatorStarts, [], 'открытых «Работ» нет — координатор не поднимается')
      assert.equal(again.store.listEvents().length, eventsBefore, 'ни stage_started, ни stage_changed, ни блоков')
    }

    // Решения после рестарта: проверка — из снимка, approval — из Инбокса; слияние закрывается по путям.
    await cli('review.accept', { task: gate.id })
    assert.deepEqual(lanesAt(again, runId), { backend: 'humBe', frontend: 'humFe' })
    await cli('request.resolve', { request: request.id, accept: true })
    await cli('request.resolve', { request: approvalAt(again, runId, 'humBe').id, accept: true })
    assert.equal(run(again, runId).lanes, undefined)
    assert.equal(stageId(again, runId), 'revAll')
    assert.equal(again.store.listTasks().filter((t) => t.gateFor?.nodeId === 'revAll').length, 1)
  })

  it('оба пути на «Работе», координатор мёртв: один запуск на оба этапа, цель несёт блок на каждый, подзадачи и метки сохранены', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    const api = await work(app, runId, 'be', 'api.ts')
    const ui = await spawn(app, runId, 'UI', { stage: 'fe' })
    const snapshot = lanesSnapshot(app, runId)
    assert.notEqual(run(app, runId).lanes!.find((l) => l.branchId === 'backend')!.stageTasksDoneAt, undefined, 'подзадачи «Бэкенда» закрыты — метка есть')
    const started = events(app, 'stage_started').length

    const again = startApp()
    assert.equal(lanesSnapshot(again, runId), snapshot, 'метки stageTasksDoneAt и заходы пережили рестарт')
    startRunWorkflow(again.deps, runId)
    assert.deepEqual(again.coordinatorStarts, [runId], 'один запуск на оба открытых этапа')
    assert.equal(events(again, 'stage_started').length, started, 'stage_started не дублируются: обе «Работы» получает цель координатора')
    assert.equal(events(again, 'workflow_blocked').length, 0)
    startRunWorkflow(again.deps, runId)
    assert.deepEqual(again.coordinatorStarts, [runId], 'координатор жив — повтор его не трогает')

    // Цель перезапущенного координатора: по блоку «# Этап» на каждую «Работу», у своего пути — свои подзадачи.
    again.alive.clear()
    const { objective } = resumeObjective(again.store, runId, (p) => again.alive.has(p))
    assert.match(objective, /# Этап: Бэкенд \(путь «Бэкенд»\)/)
    assert.match(objective, /# Этап: Фронтенд \(путь «Фронтенд»\)/)
    assert.equal((objective.match(/^# Этап:/gm) ?? []).length, 2, 'по блоку-заголовку на каждую открытую «Работу»')
    assert.ok(objective.indexOf(api.id) < objective.indexOf('# Этап: Фронтенд'), 'подзадача «Бэкенда» — в блоке «Бэкенда»')

    // Работа продолжается после рестарта: воркер «Фронтенда» из снимка, `--stage` по-прежнему обязателен.
    assert.match(await cliError('stage.finish', { run: runId }), /--stage обязателен/)
    deliverFile(again, task(again, ui.id), 'ui.html')
    assert.deepEqual(lastEvent(again, 'stage_tasks_done').payload, { runId, nodeId: 'fe', lane: 'split:frontend' })
  })

  it('проверка пути не успела запуститься до рестарта: повтор запускает именно её, задача и approval соседа не дублируются', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    await work(app, runId, 'be', 'api.ts')
    app.workersDown = true
    await cli('stage.finish', { run: runId, stage: 'be', summary: 'API готово' })
    app.workersDown = false
    await work(app, runId, undefined, 'ui.html')
    await cli('stage.finish', { run: runId, summary: 'UI готов' })
    const gate = gateOf(app, runId, 'revApi')
    const request = approvalAt(app, runId, 'humFe')
    assert.equal(app.launches.some((l) => l.taskId === gate.id), false)

    const again = startApp()
    startRunWorkflow(again.deps, runId)
    assert.deepEqual(again.launches, [{ taskId: gate.id, roleId: 'reviewer' }], 'запущена только недостартовавшая проверка')
    assert.equal(again.store.listTasks().filter((t) => t.gateFor?.nodeId === 'revApi').length, 1)
    assert.equal(approvals(again, runId).length, 1)
    assert.equal(approvalAt(again, runId, 'humFe').id, request.id)
    assert.equal(events(again, 'workflow_blocked').length, 1, 'блок остался от первой попытки, новых нет')
  })
})

describe('(7) смерть координатора: страховка по путям', () => {
  it('закрытые подзадачи обоих путей: settleIdleStages закрывает каждый путь без сводки и делает эффекты его следующей ноды', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    await work(app, runId, 'be', 'api.ts')
    await work(app, runId, 'fe', 'ui.html')
    assert.equal(hasIdleStage(run(app, runId)), true)

    // Координатор жив — страховка не вмешивается: этапы закрывает он.
    const before = mark(app)
    settleIdleRunStages(app.deps)
    assert.equal(app.store.listEvents().length, before)
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'fe' })

    app.alive.clear()
    settleIdleRunStages(app.deps)
    assert.deepEqual(lanesAt(app, runId), { backend: 'revApi', frontend: 'humFe' })
    assert.deepEqual(flowSince(app, before), ['changed be→revApi (next) [split:backend]', 'changed fe→humFe (next) [split:frontend]'])
    assert.equal(gateOf(app, runId, 'revApi').gateFor!.nodeId, 'revApi', 'проверка первого пути создана')
    const macet = approvalAt(app, runId, 'humFe')
    assert.match(macet.body!, /Итоги подзадач:\*\*\n- ui\.html: сделал/, 'сводки stage finish нет — в approval итоги подзадач')
    assert.equal(hasIdleStage(run(app, runId)), false, 'этапы закрыты — страховке больше нечего делать')
    const after = mark(app)
    settleIdleRunStages(app.deps)
    assert.equal(mark(app), after, 'повтор ничего не меняет')
  })

  it('закрыты подзадачи только одного пути: закрывается он, второй путь остаётся на «Работе»', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    await work(app, runId, 'be', 'api.ts')
    const ui = await spawn(app, runId, 'UI', { stage: 'fe' })
    app.alive.clear()
    assert.equal(hasIdleStage(run(app, runId)), true)
    settleIdleRunStages(app.deps)
    assert.deepEqual(lanesAt(app, runId), { backend: 'revApi', frontend: 'fe' })
    assert.equal(hasIdleStage(run(app, runId)), false, 'у «Фронтенда» подзадача ещё в работе')
    assert.equal(task(app, ui.id).status, 'in_progress')
    assert.equal(app.coordinatorStarts.length, 0, 'страховка координатора не запускает')

    // «Фронтенд» дорабатывает, координатора всё ещё нет — теперь закрывается и он.
    deliverFile(app, task(app, ui.id), 'ui.html')
    assert.equal(hasIdleStage(run(app, runId)), true)
    settleIdleRunStages(app.deps)
    assert.deepEqual(lanesAt(app, runId), { backend: 'revApi', frontend: 'humFe' })
  })
})

describe('(8) оба пути правят один файл', () => {
  it('конфликт слияния подзадачи — нода conflict на задаче; соседний путь идёт; после решения join срабатывает', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    // Обе подзадачи отведены от ветки прогона до первого слияния и правят один файл.
    const a = await spawn(app, runId, 'API', { stage: 'be' })
    const b = await spawn(app, runId, 'UI', { stage: 'fe' })
    commitFile(a, 'README.md', 'из бэкенда\n')
    commitFile(b, 'README.md', 'из фронтенда\n')
    finishWorker(app, a.id)
    assert.equal(task(app, a.id).status, 'done', 'первая подзадача слилась в общую ветку')
    assert.equal(readFileSync(path.join(run(app, runId).git!.worktree!, 'README.md'), 'utf8'), 'из бэкенда\n')
    finishWorker(app, b.id)

    // Вторая не слилась: конфликт держит её на ноде conflict её собственного пути подзадачи.
    assert.equal(task(app, b.id).stage?.nodeId, 'conflict')
    assert.notEqual(task(app, b.id).status, 'done')
    assert.equal(git(repo, 'branch', '--list', task(app, b.id).branch!) !== '', true, 'ветка подзадачи на месте — конфликт разрешают в ней')
    const conflict = app.store.pendingRequests(runId).find((r) => r.taskId === b.id)!
    assert.equal(conflict.kind, 'approval')
    assert.equal(conflict.nodeId, 'conflict')
    assert.match(conflict.body ?? '', /Мерж не удался/)
    assert.equal(approvals(app, runId).length, 0, 'это approval задачи, а не ноды human прогона')
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'fe' }, 'конфликт на задаче пути графа прогона не двигает')
    assert.deepEqual(events(app, 'stage_tasks_done').filter((e) => e.payload.lane).map((e) => e.payload.nodeId), ['be'], 'закрыт только «Бэкенд»: подзадача «Фронтенда» не done')

    // Соседний путь идёт: «Бэкенд» доходит до слияния, пока «Фронтенд» стоит на конфликте.
    await cli('stage.finish', { run: runId, stage: 'be', summary: 'API: правки README' })
    await cli('review.accept', { task: gateOf(app, runId, 'revApi').id })
    await cli('request.resolve', { request: approvalAt(app, runId, 'humBe').id, accept: true })
    assert.deepEqual(lanesAt(app, runId), { backend: 'merge_paths', frontend: 'fe' })
    assert.equal(stageId(app, runId), 'split', 'слияние ждёт конфликтующий путь')
    assert.equal(app.store.listTasks().filter((t) => t.gateFor?.nodeId === 'revAll').length, 0)
    assert.match(await cliError('stage.finish', { run: runId }), new RegExp(`не закрыты подзадачи \\(${b.id}\\)`))
    assert.throws(() => acceptRun(app.deps, runId), /нет запроса на проверку/, '«Подтвердить» на карточке не решает конфликт подзадачи')
    assert.equal(app.store.getRequest(conflict.id)!.status, 'pending')

    // Человек разрешил конфликт в ветке подзадачи и принял: подзадача слита, этап «Фронтенд» закрыт — join срабатывает.
    git(task(app, b.id).worktree!, 'merge', '-q', branchOf(app, runId), '-X', 'ours', '-m', 'resolve')
    await cli('request.resolve', { request: conflict.id, accept: true })
    assert.equal(task(app, b.id).status, 'done')
    assert.equal(readFileSync(path.join(run(app, runId).git!.worktree!, 'README.md'), 'utf8'), 'из фронтенда\n', 'общая ветка получила решение человека')
    assert.deepEqual(lastEvent(app, 'stage_tasks_done').payload, { runId, nodeId: 'fe', lane: 'split:frontend' })
    await cli('stage.finish', { run: runId, summary: 'UI: README' })
    await cli('request.resolve', { request: approvalAt(app, runId, 'humFe').id, accept: true })
    assert.equal(run(app, runId).lanes, undefined, 'оба пути пришли — слияние сработало')
    assert.equal(stageId(app, runId), 'revAll')
    assert.equal(app.store.listTasks().filter((t) => t.gateFor?.nodeId === 'revAll').length, 1)
    assert.equal(events(app, 'workflow_blocked').length, 0)
    assert.equal(git(run(app, runId).git!.worktree!, 'status', '--porcelain'), '', 'в worktree ветки прогона нет недослитого')
  })
})

describe('(9) reject после слияния', () => {
  it('reject проверки ветки и человека → повторный проход через fork: новое поколение путей, замечания обоим, задачи прошлого захода не в счёте', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    await throughLanes(app, runId, { be: 'api1.ts', fe: 'ui1.html' }, 'заход 1')
    const gateAll1 = gateOf(app, runId, 'revAll')
    const gateApi1 = gateOf(app, runId, 'revApi')
    const pass1 = app.store.listTasks().filter((t) => t.stageOf?.nodeId === 'be' || t.stageOf?.nodeId === 'fe').map((t) => t.id)
    assert.equal(pass1.length, 2)
    assert.match(run(app, runId).summary!.text, /API: заход 1/)

    // --- reject ветки после слияния: назад на fork, оба пути стартуют заново ---
    const before = mark(app)
    await cli('review.reject', { task: gateAll1.id, feedback: 'контракты не сходятся' })
    assert.deepEqual(flowSince(app, before), [
      'changed revAll→split (reject)',
      'changed split→be (backend) [split:backend]', 'started be#2 [split:backend]',
      'changed split→fe (frontend) [split:frontend]', 'started fe#2 [split:frontend]'
    ])
    const [startedBe, startedFe] = events(app, 'stage_started').slice(-2).map((e) => e.payload)
    assert.equal(startedBe.feedback, 'контракты не сходятся', 'замечания получает каждый путь')
    assert.equal(startedFe.feedback, 'контракты не сходятся')
    assert.deepEqual(run(app, runId).stage!.visits.split, 2)
    assert.deepEqual([run(app, runId).stage!.visits.be, run(app, runId).stage!.visits.fe], [2, 2])
    assert.deepEqual(run(app, runId).lanes!.map((l) => [l.id, l.forkVisit, l.nodeId, l.arrivedAt]), [
      ['split:backend', 2, 'be', undefined], ['split:frontend', 2, 'fe', undefined]
    ], 'новое поколение путей: прошлый приход в слияние не воскресает')
    assert.equal(stageId(app, runId), 'split')

    // Задачи прошлого захода в счёт не идут: этапы ждут новых подзадач.
    const shown = await cli<ShowReply>('workflow.show', { run: runId })
    assert.deepEqual(shown.lanes!.map((l) => [l.nodeId, l.visit, l.tasks, l.tasksDoneAt, l.feedback]), [
      ['be', 2, [], undefined, 'контракты не сходятся'], ['fe', 2, [], undefined, 'контракты не сходятся']
    ])
    assert.match(await cliError('stage.finish', { run: runId, stage: 'be' }), /нет подзадач/)
    assert.match(await cliError('stage.finish', { run: runId, stage: 'fe' }), /нет подзадач/)
    // Решения по проверкам и approval прошлого захода уже не актуальны.
    assert.match(await cliError('review.accept', { task: gateAll1.id }), /уже не актуальна/)
    assert.match(await cliError('review.accept', { task: gateApi1.id }), /уже не актуальна/)
    assert.equal(approvals(app, runId).length, 0)

    // --- заход 2 до слияния: подзадачи привязаны к заходу 2, сводки и итог — только этого захода ---
    await throughLanes(app, runId, { be: 'api2.ts', fe: 'ui2.html' }, 'заход 2')
    const tasks = app.store.listTasks().filter((t) => t.stageOf?.nodeId === 'be' || t.stageOf?.nodeId === 'fe')
    assert.deepEqual(tasks.filter((t) => !pass1.includes(t.id)).map((t) => t.stageOf!.visit), [2, 2])
    const gateAll2 = gateOf(app, runId, 'revAll')
    assert.notEqual(gateAll2.id, gateAll1.id)
    assert.notEqual(gateOf(app, runId, 'revApi').id, gateApi1.id, 'проверка пути — новая задача захода 2')
    assert.match(run(app, runId).summary!.text, /### Путь «Бэкенд»\n\nAPI: заход 2/)
    assert.doesNotMatch(run(app, runId).summary!.text, /заход 1/, 'итог слияния — сводки только нового поколения путей')

    // --- «Вернуть» человека после слияния — ещё один проход ---
    await cli('review.accept', { task: gateAll2.id })
    await cli('request.resolve', { request: approvalAt(app, runId, 'check').id, reject: 'добавь логирование' })
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'fe' })
    assert.equal(run(app, runId).stage!.visits.split, 3)
    assert.equal(lastEvent(app, 'stage_started').payload.feedback, 'добавь логирование')
    assert.deepEqual(run(app, runId).returns!.map((x) => x.text), ['контракты не сходятся', 'добавь логирование'])
    await throughLanes(app, runId, { be: 'api3.ts', fe: 'ui3.html' }, 'заход 3')
    await cli('review.accept', { task: gateOf(app, runId, 'revAll').id })
    acceptRun(app.deps, runId)
    assert.equal(stageId(app, runId), 'end')
    assert.equal(events(app, 'run_done').length, 1)
    for (const f of ['api1.ts', 'api2.ts', 'api3.ts', 'ui1.html', 'ui2.html', 'ui3.html']) assert.equal(existsSync(path.join(repo, f)), true, `${f} слит в master`)
    assert.deepEqual(historyOf(app, runId, 'split:backend').filter((h) => h.nodeId === 'be').map((h) => h.visit), [1, 2, 3])
    assert.equal(events(app, 'workflow_blocked').length, 0)
  })
})

/**
 * start → fork: «Бэкенд» (work) → «Нужна доработка?» (decision: ok → слияние, redo → Бэкенд);
 * «Сроки» (ask) → «Фронтенд» (work) → слияние → «Проверка» (human) → end.
 */
function askDecisionWorkflow(): Workflow {
  return {
    version: 2,
    nodes: [
      node({ id: 'start', type: 'start' }),
      node({ id: 'split', type: 'fork', title: 'Бэк и фронт', branches: BRANCHES }),
      node({ id: 'be', type: 'work', title: 'Бэкенд' }),
      node({
        id: 'bdec', type: 'decision', title: 'Нужна доработка?', roleId: 'reviewer', question: 'Бэкенд готов к слиянию?',
        options: [{ id: 'ok', label: 'Готов' }, { id: 'redo', label: 'Переделать' }]
      }),
      node({ id: 'fask', type: 'ask', title: 'Сроки', roleId: 'reviewer', instructions: 'Спроси про сроки' }),
      node({ id: 'fe', type: 'work', title: 'Фронтенд' }),
      node({ id: 'join', type: 'join', forkId: 'split' }),
      node({ id: 'check', type: 'human', title: 'Проверка' }),
      node({ id: 'end', type: 'end' })
    ],
    edges: [
      edge('start', 'next', 'split'), edge('split', 'backend', 'be'), edge('split', 'frontend', 'fask'),
      edge('be', 'next', 'bdec'), edge('bdec', 'ok', 'join'), edge('bdec', 'redo', 'be'),
      edge('fask', 'next', 'fe'), edge('fe', 'next', 'join'),
      edge('join', 'next', 'check'), edge('check', 'accept', 'end'), edge('check', 'reject', 'split')
    ]
  }
}

describe('(10) decision и ask внутри путей', () => {
  it('вопрос человеку в одном пути и решение агента в другом идут параллельно; эскалация решения — человеку по ноде; ответы и решения — в stage_started своего пути', async () => {
    const wf = askDecisionWorkflow()
    assert.deepEqual(validateWorkflow(wf, { roles: ROLES }).errors, [])
    const app = startApp(wf)
    const runId = startRun(app)

    // Вход в разветвление прямо из старта: «Бэкенд» на «Работе» — stage_started; «Фронтенд» на вопросе — задача-вопрос запущена.
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'fask' })
    assert.deepEqual(events(app, 'stage_started').map((e) => [e.payload.nodeId, e.payload.lane]), [['be', 'split:backend']], 'координатору — только «Работа»')
    const asker = app.store.listTasks().find((t) => t.stageOf?.nodeId === 'fask')!
    assert.deepEqual(asker.stageOf, { nodeId: 'fask', visit: 1 })
    assert.deepEqual(app.launches.find((l) => l.taskId === asker.id), { taskId: asker.id, roleId: 'reviewer' })
    assert.match(asker.spec, /## Путь разветвления[\s\S]*«Фронтенд»/)

    // Открыта одна «Работа» (вопрос — не «Работа»): task create без --stage берёт её.
    const api = await spawn(app, runId, 'API')
    assert.deepEqual(api.stageOf, { nodeId: 'be', visit: 1 })
    assert.match(await cliError('task.create', { run: runId, title: 'X', role: 'developer', stage: 'fask' }), /только на этапе «Работа»/)

    // «Фронтенд»: вопрос уходит человеку и ждёт в Инбоксе, пока «Бэкенд» работает дальше.
    const q = app.store.ask({ taskId: asker.id, dispatchId: asker.dispatchId, question: 'К какому сроку?' }, { forceHuman: true })
    const questionRequest = app.store.pendingRequests(runId).find((r) => r.questionId === q.id)!
    assert.equal(questionRequest.taskId, asker.id)
    deliverFile(app, task(app, api.id), 'api.ts')
    await cli('stage.finish', { run: runId, summary: 'API v1' })
    assert.deepEqual(lanesAt(app, runId), { backend: 'bdec', frontend: 'fask' })
    const decider1 = gateOf(app, runId, 'bdec')
    assert.equal(decider1.roleId, 'reviewer')
    assert.match(decider1.spec, /Бэкенд готов к слиянию\?/)
    assert.match(decider1.spec, /API v1/)
    assert.doesNotMatch(decider1.spec, /Сроки/, 'путь по графу решателя — без записей соседнего пути')
    assert.equal(app.store.getRequest(questionRequest.id)!.status, 'pending', 'вопрос соседнего пути всё ещё ждёт человека')

    // Агент-решатель выбирает «Переделать»: «Бэкенд» снова на «Работе» с решением в stage_started; «Фронтенд» не тронут.
    const chosen = await cli<{ nodeId: string; optionId: string; to: string }>('decision.choose', { task: decider1.id, option: 'redo', reason: 'нет обработки ошибок' })
    assert.deepEqual([chosen.nodeId, chosen.optionId, chosen.to], ['bdec', 'redo', 'be'])
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'fask' })
    const redo = lastEvent(app, 'stage_started').payload
    assert.deepEqual([redo.nodeId, redo.visit, redo.lane], ['be', 2, 'split:backend'])
    assert.match(String(redo.decision), /Бэкенд готов к слиянию\?» → Переделать\. нет обработки ошибок/)
    assert.equal(app.store.getRequest(questionRequest.id)!.status, 'pending')
    assert.equal(run(app, runId).lanes!.find((l) => l.branchId === 'frontend')!.stageInput, undefined, 'решение — у пути «Бэкенд»')

    // Человек отвечает на вопрос, вопросник сдан — «Фронтенд» идёт на «Работу» с ответами, «Бэкенд» не задет.
    const beforeAnswer = mark(app)
    await cli('request.resolve', { request: questionRequest.id, text: 'к пятнице' })
    finishWorker(app, asker.id, 'выяснил')
    assert.deepEqual(lanesAt(app, runId), { backend: 'be', frontend: 'fe' })
    assert.deepEqual(flowSince(app, beforeAnswer), ['changed fask→fe (next) [split:frontend]', 'started fe#1 [split:frontend]'])
    assert.match(String(lastEvent(app, 'stage_started').payload.answers), /к пятнице/)
    assert.equal(task(app, asker.id).status, 'done')

    // «Бэкенд» доработан: новый решатель; решение старого уже не принимается; новый передаёт решение человеку.
    const api2 = await spawn(app, runId, 'API v2', { stage: 'be' })
    assert.deepEqual(api2.stageOf, { nodeId: 'be', visit: 2 })
    deliverFile(app, api2, 'api2.ts')
    await cli('stage.finish', { run: runId, stage: 'be', summary: 'API v2' })
    const decider2 = gateOf(app, runId, 'bdec')
    assert.notEqual(decider2.id, decider1.id)
    assert.match(await cliError('decision.choose', { task: decider1.id, option: 'ok', reason: 'поздно' }), /уже принято или передано человеку/)
    const escalated = await cli<{ requestId: string }>('decision.escalate', { task: decider2.id, reason: 'не хватает данных о нагрузке' })
    const decisionRequest = app.store.getRequest(escalated.requestId)!
    assert.deepEqual([decisionRequest.kind, decisionRequest.nodeId, decisionRequest.fallback, decisionRequest.status], ['decision', 'bdec', 'unsure', 'pending'])
    assert.deepEqual(decisionRequest.options!.map((o) => o.id), ['ok', 'redo'])
    assert.equal(lanesAt(app, runId).backend, 'bdec', 'путь ждёт человека, а не агента')

    // Тем временем «Фронтенд» работает и приходит в слияние; человек выбирает «Готов» — слияние закрывается.
    await work(app, runId, undefined, 'ui.html')
    await cli('stage.finish', { run: runId, summary: 'UI готов' })
    assert.deepEqual(lanesAt(app, runId), { backend: 'bdec', frontend: 'join' })
    await cli('request.resolve', { request: decisionRequest.id, option: 'ok', text: 'нагрузка небольшая' })
    assert.equal(run(app, runId).lanes, undefined)
    assert.equal(stageId(app, runId), 'check')

    // Решения в истории путей: агент — в первом заходе в развилку, человек (с фоллбэком и комментарием агента) — во втором.
    const decisions = historyOf(app, runId, 'split:backend').filter((h) => h.nodeId === 'bdec').map((h) => h.decision)
    assert.deepEqual(decisions[0], { optionId: 'redo', label: 'Переделать', reason: 'нет обработки ошибок', by: 'agent' })
    assert.deepEqual(decisions[1], {
      optionId: 'ok', label: 'Готов', reason: 'нагрузка небольшая', by: 'human', fallback: 'unsure', agentNote: 'не хватает данных о нагрузке'
    })
    acceptRun(app.deps, runId)
    assert.equal(stageId(app, runId), 'end')
    assert.equal(events(app, 'workflow_blocked').length, 0)
  })
})


// ---------- реальный CLI ----------

const execFileAsync = promisify(execFile)
const CLI_BIN = path.join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'cli', 'bin', 'orca-board.js')

/**
 * Настоящий `orca-board` (packages/cli/bin/orca-board.js) против сокета теста. Окружение — только сокет и прогон:
 * `ORCA_DISPATCH_ID`/`ORCA_TASK_ID` запустившей тест сессии в запрос не попадают. Асинхронно: сервер сокета живёт в этом же процессе.
 */
async function orca(args: string[], runId?: string): Promise<{ code: number; out: string; err: string }> {
  const env = { PATH: process.env.PATH ?? '', ORCA_SOCKET: sockPath, ...(runId ? { ORCA_RUN_ID: runId } : {}) }
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_BIN, ...args], { env })
    return { code: 0, out: stdout, err: stderr }
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof x.code === 'number' ? x.code : 1, out: x.stdout ?? '', err: x.stderr ?? '' }
  }
}

describe('(2б) реальный CLI orca-board: --stage и lanes', () => {
  it('task create --stage, stage finish --stage и workflow show доходят до сокета; $ORCA_RUN_ID подставляется, --stage без значения отвергает CLI', async () => {
    const app = startApp()
    const runId = await toLanes(app)

    const shown = await orca(['workflow', 'show'], runId)
    assert.equal(shown.code, 0, shown.err)
    const show = JSON.parse(shown.out) as ShowReply
    assert.deepEqual(show.lanes!.map((l) => [l.nodeId, l.lane, l.laneTitle]), [['be', 'split:backend', 'Бэкенд'], ['fe', 'split:frontend', 'Фронтенд']])
    assert.equal(show.stage!.nodeId, 'be')

    // Открыто два этапа: без --stage отказывает приложение, с пустым --stage — сам CLI, до сокета.
    const noStage = await orca(['task', 'create', '--title', 'API', '--role', 'developer'], runId)
    assert.equal(noStage.code, 1)
    assert.match(noStage.err, /--stage обязателен: открыты этапы «Бэкенд» \(be\), «Фронтенд» \(fe\)/)
    const emptyStage = await orca(['task', 'create', '--title', 'API', '--role', 'developer', '--stage'], runId)
    assert.equal(emptyStage.code, 1)
    assert.match(emptyStage.err, /--stage требует id этапа/)
    const emptyFinish = await orca(['stage', 'finish', '--stage'], runId)
    assert.match(emptyFinish.err, /--stage требует id этапа/)
    assert.equal(app.store.listTasks().filter((t) => t.title === 'API').length, 0, 'отказы ничего не создали')

    const created = await orca(['task', 'create', '--title', 'API', '--role', 'developer', '--stage', 'be'], runId)
    assert.equal(created.code, 0, created.err)
    const api = JSON.parse(created.out) as Task
    assert.deepEqual(api.stageOf, { nodeId: 'be', visit: 1 })
    app.deps.startWorker(api.id)
    deliverFile(app, task(app, api.id), 'api.ts')
    assert.deepEqual(lastEvent(app, 'stage_tasks_done').payload, { runId, nodeId: 'be', lane: 'split:backend' })

    const finished = await orca(['stage', 'finish', '--stage', 'be', '--summary', 'API готово'], runId)
    assert.equal(finished.code, 0, finished.err)
    const reply = JSON.parse(finished.out) as StageReply
    assert.equal(reply.finished, 'be')
    assert.deepEqual(reply.lanes, [{ nodeId: 'revApi', lane: 'split:backend', arrived: false }, { nodeId: 'fe', lane: 'split:frontend', arrived: false }])
    assert.deepEqual(reply.next, { type: 'create_gate', nodeId: 'revApi' })
    assert.equal(gateOf(app, runId, 'revApi').gateFor!.nodeId, 'revApi')

    // Закрытых «Работ» уже нет только у «Бэкенда»: «Фронтенд» открыт один — команды без --stage работают как раньше.
    const second = await orca(['task', 'create', '--title', 'UI', '--role', 'developer'], runId)
    assert.equal(second.code, 0, second.err)
    assert.deepEqual((JSON.parse(second.out) as Task).stageOf, { nodeId: 'fe', visit: 1 })
  })
})

describe('(11) старый снимок без lanes', () => {
  it('снимок линейного прогона (как писала сборка до разветвления) загружается и идёт дальше; правка типа под fork идущий прогон не трогает, новый — разветвляется', async () => {
    const app = startApp(linearWorkflow())
    const runId = startRun(app)
    await work(app, runId, undefined, 'a.md')
    await cli('stage.finish', { run: runId, summary: 'разобрал' })
    assert.equal(stageId(app, runId), 'review')
    const gate = gateOf(app, runId, 'review')

    // На диске ни ключей пути, ни нод разветвления — ровно то, что лежало бы до этой фичи.
    const board = JSON.parse(readFileSync(path.join(tmp, 'user', 'boards', `${pid}.json`), 'utf8')) as { runs: Run[] }
    assert.deepEqual(laneKeysIn(board), [])
    assert.equal(board.runs.some((r) => 'lanes' in r), false)

    // Тип перепишут под разветвление, приложение перезапустят: идущий прогон живёт на своём снимке графа.
    app.pm.saveTaskType({ id: typeId, title: 'Фича', settings: { roles: ROLES, workflow: forkWorkflow() } })
    const again = startApp()
    assert.equal(run(again, runId).lanes, undefined)
    assert.equal(run(again, runId).workflow!.nodes.some((n) => n.type === 'fork'), false, 'снимок графа прогона — линейный')
    assert.equal(stageId(again, runId), 'review')
    const tasks = again.store.listTasks().length
    startRunWorkflow(again.deps, runId)
    assert.equal(again.store.listTasks().length, tasks, 'повтор эффектов на старом снимке не дублирует проверку')
    await cli('review.accept', { task: gate.id })
    assert.equal(stageId(again, runId), 'check')
    acceptRun(again.deps, runId)
    assert.equal(stageId(again, runId), 'end')
    assert.equal(run(again, runId).lanes, undefined)
    for (const e of again.store.listEvents()) assert.deepEqual(laneKeysIn(e.payload), [], `событие ${e.type}: прогон на старом снимке без ключей пути`)

    // Новый прогон того же типа получает граф с fork и разветвляется.
    const next = startRun(again, 'Вторая')
    assert.equal(run(again, next).workflow!.nodes.some((n) => n.type === 'fork'), true)
    await work(again, next, undefined, 'b.md')
    await cli('stage.finish', { run: next, summary: 'разобрал' })
    assert.deepEqual(lanesAt(again, next), { backend: 'be', frontend: 'fe' })
    assert.equal(run(again, runId).lanes, undefined, 'первый прогон не задет')
  })
})

describe('(12) сохранение типа с fork через ProjectManager', () => {
  const mutated = (fn: (wf: Workflow) => void): Workflow => {
    const wf = forkWorkflow()
    fn(wf)
    return wf
  }
  const dropNode = (wf: Workflow, id: string): void => {
    wf.nodes = wf.nodes.filter((n) => n.id !== id)
    wf.edges = wf.edges.filter((e) => e.from !== id && e.to !== id)
  }
  const retarget = (wf: Workflow, from: string, outcome: string, to: string): void => {
    wf.edges = wf.edges.map((e) => (e.from === from && e.outcome === outcome ? { ...e, to } : e))
  }
  const forkNode = (wf: Workflow): Extract<WfNode, { type: 'fork' }> => wf.nodes.find((n) => n.id === 'split') as Extract<WfNode, { type: 'fork' }>
  const SUBFLOW_WITH_FORK: WfSubflow = {
    nodes: [
      node({ id: 'start', type: 'start' }), node({ id: 'sf', type: 'fork', title: 'Внутри', branches: [{ id: 'a', label: 'А' }, { id: 'b', label: 'Б' }] }),
      node({ id: 'wa', type: 'work' }), node({ id: 'wb', type: 'work' }), node({ id: 'sj', type: 'join', forkId: 'sf' }), node({ id: 'end', type: 'end', merged: true })
    ],
    edges: [
      edge('start', 'next', 'sf'), edge('sf', 'a', 'wa'), edge('sf', 'b', 'wb'), edge('wa', 'next', 'sj'), edge('wb', 'next', 'sj'), edge('sj', 'next', 'end')
    ]
  }

  /** Невалидные «скобки» и пути: что именно отвергает приложение при сохранении типа — сообщение ядра, по-русски. */
  const INVALID: Array<[string, Workflow, RegExp]> = [
    ['нет слияния у разветвления', mutated((wf) => dropNode(wf, 'merge_paths')), /у разветвления нет слияния/],
    ['слияние указывает на несуществующее разветвление', mutated((wf) => { (wf.nodes.find((n) => n.id === 'merge_paths') as { forkId: string }).forkId = 'nope' }), /слияние не привязано к разветвлению/],
    ['путь уходит мимо слияния', mutated((wf) => retarget(wf, 'humBe', 'accept', 'check')), /из пути можно выйти только в слияние/],
    ['путь ведёт в конец', mutated((wf) => retarget(wf, 'humFe', 'accept', 'end')), /ведёт в конец/],
    ['мерж в базу внутри пути', mutated((wf) => {
      wf.nodes.push(node({ id: 'mergeLane', type: 'merge' }))
      retarget(wf, 'humFe', 'accept', 'mergeLane')
      wf.edges.push(edge('mergeLane', 'ok', 'merge_paths'), edge('mergeLane', 'conflict', 'fe'))
    }), /мерж в базовую ветку внутри пути/],
    ['вход в путь сбоку (reject после слияния в середину пути)', mutated((wf) => retarget(wf, 'revAll', 'reject', 'be')), /войти в путь можно только через разветвление/],
    ['пути пересекаются', mutated((wf) => retarget(wf, 'be', 'next', 'fe')), /лежит сразу в путях/],
    ['вложенное разветвление', mutated((wf) => {
      wf.nodes.push(
        node({ id: 'inner', type: 'fork', title: 'Внутри пути', branches: [{ id: 'c', label: 'В' }, { id: 'd', label: 'Г' }] }),
        node({ id: 'c1', type: 'work' }), node({ id: 'd1', type: 'work' }), node({ id: 'innerJoin', type: 'join', forkId: 'inner' })
      )
      retarget(wf, 'fe', 'next', 'inner')
      wf.edges.push(edge('inner', 'c', 'c1'), edge('inner', 'd', 'd1'), edge('c1', 'next', 'innerJoin'), edge('d1', 'next', 'innerJoin'), edge('innerJoin', 'next', 'humFe'))
    }), /вложенные разветвления не поддерживаются/],
    ['один путь', mutated((wf) => { forkNode(wf).branches = [BRANCHES[0]] }), /путей 1, нужно не меньше 2/],
    ['пять путей', mutated((wf) => { forkNode(wf).branches = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: id })) }), /путей 5, можно не больше 4/],
    ['id пути недопустим', mutated((wf) => { forkNode(wf).branches = [{ id: 'Бэк', label: 'Бэкенд' }, BRANCHES[1]] }), /id пути «Бэк» недопустим/],
    ['id пути повторяется', mutated((wf) => { forkNode(wf).branches = [BRANCHES[0], { id: 'backend', label: 'Ещё бэкенд' }] }), /id пути «backend» повторяется/],
    ['путь без названия', mutated((wf) => { forkNode(wf).branches = [{ id: 'backend', label: ' ' }, BRANCHES[1]] }), /у пути «backend» нет названия/],
    ['разветвление в пути подзадачи', mutated((wf) => { (wf.nodes.find((n) => n.id === 'be') as { subflow?: WfSubflow }).subflow = SUBFLOW_WITH_FORK }), /недоступны в пути подзадачи/]
  ]

  it('граф с fork сохраняется, переживает перезапуск, доходит до нового прогона и types list', async () => {
    const app = startApp(linearWorkflow())
    const saved = app.pm.saveTaskType({ title: 'С разветвлением', settings: { roles: ROLES, workflow: forkWorkflow() } })
    assert.deepEqual(forkNode(app.pm.taskTypeWorkflow(saved.id).workflow).branches, BRANCHES)
    const file = JSON.parse(readFileSync(path.join(tmp, 'user', 'projects.json'), 'utf8')) as { taskTypes: Array<{ id: string; settings: { workflow?: Workflow } }> }
    const stored = file.taskTypes.find((t) => t.id === saved.id)!.settings.workflow!
    assert.equal(stored.version, 2, 'WORKFLOW_VERSION не менялся: fork — новый тип ноды версии 2')
    assert.ok(stored.nodes.some((n) => n.type === 'join' && n.forkId === 'split'))

    // Перезапуск менеджера: граф тот же, приложение считает его исполнимым (не будущая версия), прогон берёт его со снимка типа.
    const reloaded = new ProjectManager(path.join(tmp, 'user'))
    assert.deepEqual(reloaded.taskTypeWorkflow(saved.id).workflow, app.pm.taskTypeWorkflow(saved.id).workflow)
    assert.ok(runnableWorkflow(reloaded.taskTypeWorkflow(saved.id).workflow), 'граф с fork не отвергается как будущая версия')
    assert.ok(reloaded.runType(pid!, saved.id).workflow?.nodes.some((n) => n.type === 'fork'))

    // `types list` для координатора: в этапах типа видны пути разветвления.
    const list = await cli<Array<{ id: string; stages: Array<{ id: string; type: string; branches?: string[] }> }>>('types.list', {})
    const listed = list.find((t) => t.id === saved.id)!
    assert.deepEqual(listed.stages.find((x) => x.id === 'split'), { id: 'split', type: 'fork', title: 'Бэк и фронт', branches: ['backend', 'frontend'] })
    assert.equal(listed.stages.find((x) => x.id === 'merge_paths')!.type, 'join')
  })

  it('невалидные «скобки» и пути не сохраняются: тип не создаётся, граф существующего типа остаётся прежним', () => {
    const app = startApp(forkWorkflow())
    const { pm } = app
    const before = pm.taskTypes().length
    const good = pm.taskTypeWorkflow(typeId!).workflow
    for (const [name, wf, expected] of INVALID) {
      const refused = (e: unknown): boolean => e instanceof OrcaError && e.key === 'workflow.notSaved' && expected.test(e.message)
      assert.throws(() => pm.saveTaskType({ title: `Кривой: ${name}`, settings: { roles: ROLES, workflow: wf } }), refused, `новый тип: ${name}`)
      assert.throws(() => pm.saveTaskType({ id: typeId, title: 'Фича', settings: { roles: ROLES, workflow: wf } }), refused, `замена типа: ${name}`)
      assert.throws(() => pm.patchTaskType(typeId!, { workflow: wf }), refused, `правка графа типа: ${name}`)
    }
    assert.equal(pm.taskTypes().length, before, 'ни один кривой тип не создан')
    assert.deepEqual(pm.taskTypeWorkflow(typeId!).workflow, good, 'граф существующего типа после отказов не изменился')
    assert.deepEqual(new ProjectManager(path.join(tmp, 'user')).taskTypeWorkflow(typeId!).workflow, good, 'и на диске тоже')
  })

  it('предупреждения не мешают: пустой путь (fork сразу в слияние) сохраняется', () => {
    const app = startApp(linearWorkflow())
    const wf = mutated((x) => {
      for (const id of ['be', 'revApi', 'humBe']) dropNode(x, id)
      x.edges.push(edge('split', 'backend', 'merge_paths'))
    })
    const v = validateWorkflow(wf, { roles: ROLES })
    assert.deepEqual(v.errors, [])
    assert.ok(v.warnings.some((w) => w.code === 'forkEmptyBranch'))
    const saved = app.pm.saveTaskType({ title: 'С пустым путём', settings: { roles: ROLES, workflow: wf } })
    assert.ok(app.pm.taskTypeWorkflow(saved.id).workflow.edges.some((e) => e.from === 'split' && e.outcome === 'backend' && e.to === 'merge_paths'))
  })
})

/**
 * Два разветвления подряд: fork «Первое» (пути a, b — по «Работе») → слияние → сразу fork «Второе» (путь c — «Работа»,
 * путь d — пустой: fork ведёт прямо в слияние) → слияние → «Проверка» → end.
 */
function sequentialWorkflow(): Workflow {
  return {
    version: 2,
    nodes: [
      node({ id: 'start', type: 'start' }),
      node({ id: 'split1', type: 'fork', title: 'Первое', branches: [{ id: 'a', label: 'Первый' }, { id: 'b', label: 'Второй' }] }),
      node({ id: 'wa', type: 'work', title: 'Работа А' }), node({ id: 'wb', type: 'work', title: 'Работа Б' }),
      node({ id: 'join1', type: 'join', forkId: 'split1' }),
      node({ id: 'split2', type: 'fork', title: 'Второе', branches: [{ id: 'c', label: 'Третий' }, { id: 'd', label: 'Пустой' }] }),
      node({ id: 'wc', type: 'work', title: 'Работа В' }),
      node({ id: 'join2', type: 'join', forkId: 'split2' }),
      node({ id: 'check', type: 'human', title: 'Проверка' }), node({ id: 'end', type: 'end' })
    ],
    edges: [
      edge('start', 'next', 'split1'), edge('split1', 'a', 'wa'), edge('split1', 'b', 'wb'),
      edge('wa', 'next', 'join1'), edge('wb', 'next', 'join1'), edge('join1', 'next', 'split2'),
      edge('split2', 'c', 'wc'), edge('split2', 'd', 'join2'), edge('wc', 'next', 'join2'),
      edge('join2', 'next', 'check'), edge('check', 'accept', 'end'), edge('check', 'reject', 'split1')
    ]
  }
}

describe('(13) последовательные разветвления, пустой путь, подзадача после stage_tasks_done', () => {
  it('fork1…join1 → сразу fork2…join2: слияние первого входит во второе одним переходом; пустой путь приходит в слияние сразу', async () => {
    const wf = sequentialWorkflow()
    const v = validateWorkflow(wf, { roles: ROLES })
    assert.deepEqual(v.errors, [])
    assert.ok(v.warnings.some((w) => w.code === 'forkEmptyBranch'), 'пустой путь — предупреждение, не ошибка')
    const app = startApp(wf)
    const runId = startRun(app)
    assert.deepEqual(lanesAt(app, runId), { a: 'wa', b: 'wb' })
    assert.deepEqual(events(app, 'stage_started').map((e) => e.payload.lane), ['split1:a', 'split1:b'])

    await work(app, runId, 'wa', 'a.ts')
    await work(app, runId, 'wb', 'b.ts')
    await cli('stage.finish', { run: runId, stage: 'wa', summary: 'А готово' })
    const before = mark(app)
    const closed = await cli<StageReply>('stage.finish', { run: runId, stage: 'wb', summary: 'Б готово' })
    assert.deepEqual(flowSince(app, before), [
      'changed wb→join1 (next) [split1:b]',
      'changed join1→split2 (next)',
      'changed split2→wc (c) [split2:c]', 'started wc#1 [split2:c]',
      'changed split2→join2 (d) [split2:d]'
    ], 'слияние первого разветвления сразу входит во второе: пути прошлого поколения убраны, новые — на местах')
    assert.deepEqual(lanesAt(app, runId), { c: 'wc', d: 'join2' })
    assert.deepEqual(closed.stage, { nodeId: 'split2', visits: 1 })
    assert.deepEqual(closed.lanes, [{ nodeId: 'wc', lane: 'split2:c', arrived: false }, { nodeId: 'join2', lane: 'split2:d', arrived: true }])
    assert.equal(stageId(app, runId), 'split2')
    assert.notEqual(run(app, runId).lanes!.find((l) => l.branchId === 'd')!.arrivedAt, undefined, 'пустой путь пришёл в слияние сразу')
    assert.match(run(app, runId).summary!.text, /### Путь «Первый»\n\nА готово/, 'сводка первого слияния сложена до входа во второе')

    // Открыта одна «Работа» — команды без --stage берут её; слияние второго разветвления закрывает граф дальше.
    await work(app, runId, undefined, 'c.ts')
    await cli('stage.finish', { run: runId, summary: 'В готово' })
    assert.equal(run(app, runId).lanes, undefined)
    assert.equal(stageId(app, runId), 'check')
    assert.match(run(app, runId).summary!.text, /### Путь «Третий»\n\nВ готово/)
    assert.doesNotMatch(run(app, runId).summary!.text, /А готово/, 'итог слияния — только сводки его разветвления')
    acceptRun(app.deps, runId)
    assert.equal(stageId(app, runId), 'end')
    assert.deepEqual(historyOf(app, runId).map((h) => h.nodeId), ['split1', 'split2', 'check', 'end'])
    assert.deepEqual(historyOf(app, runId, 'split2:d').map((h) => h.nodeId), ['join2'], 'у пустого пути одна запись — приход в слияние')
    assert.equal(events(app, 'workflow_blocked').length, 0)
  })

  it('подзадача, добавленная после stage_tasks_done, снимает метку и событие только своего пути', async () => {
    const app = startApp()
    const runId = await toLanes(app)
    await work(app, runId, 'be', 'api.ts')
    await work(app, runId, 'fe', 'ui.html')
    const eventOf = (nodeId: string): OrcaEvent => events(app, 'stage_tasks_done').find((e) => e.payload.nodeId === nodeId)!
    const [beEvent, feEvent] = [eventOf('be'), eventOf('fe')]
    assert.deepEqual([beEvent.consumedBy, feEvent.consumedBy], [undefined, undefined])

    const more = await spawn(app, runId, 'Ещё API', { stage: 'be' })
    const lanes = run(app, runId).lanes!
    assert.equal(lanes.find((l) => l.branchId === 'backend')!.stageTasksDoneAt, undefined, 'у «Бэкенда» метка «всё сделано» снята')
    assert.notEqual(lanes.find((l) => l.branchId === 'frontend')!.stageTasksDoneAt, undefined, 'у «Фронтенда» осталась')
    assert.equal(beEvent.consumedBy, 'stage', 'непрочитанный stage_tasks_done «Бэкенда» погашен')
    assert.equal(feEvent.consumedBy, undefined, 'событие «Фронтенда» координатору ещё нужно')
    assert.match(await cliError('stage.finish', { run: runId, stage: 'be' }), new RegExp(`не закрыты подзадачи \\(${more.id}\\)`))

    deliverFile(app, more, 'api2.ts')
    const fresh = events(app, 'stage_tasks_done').filter((e) => e.payload.nodeId === 'be')
    assert.equal(fresh.length, 2, 'закрыли добавленную — «Бэкенд» снова шлёт stage_tasks_done')
    assert.equal(fresh[1].consumedBy, undefined)
    assert.equal(events(app, 'stage_tasks_done').filter((e) => e.payload.nodeId === 'fe').length, 1, 'у «Фронтенда» новых событий нет')
    await cli('stage.finish', { run: runId, stage: 'be', summary: 'API готово' })
    assert.deepEqual(lanesAt(app, runId), { backend: 'revApi', frontend: 'fe' })
  })
})
