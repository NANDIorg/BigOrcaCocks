// Запуск: pnpm --filter @orca-board/desktop test. Хендлеры сокета воркфлоу глобальной задачи (`scope: 'run'`):
// `stage finish`, `workflow show` по прогону, `review accept/reject` по проверке ветки прогона, ошибки `task create`,
// `runs finish`, запросы без `taskId`. Настоящий TaskStore и сокет; PTY и git не участвуют.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { connect, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES, defaultWorkflow, legacyDefaultWorkflow, pipelineWorkflow, presetTaskType, resolveTaskType,
  runTypeInput, type AgentInfo, type HumanRequest, type OrcaEvent, type Role, type Run, type Task, type Workflow
} from '@orca-board/core'
import { startSocketServer, type ProjectDeps } from './socket'
import { handleWorkflowEvents, reviewAccept, reviewReject, type WorkflowDeps } from './workflow'

let tmp: string
let sockPath: string
let server: Server
let store: TaskStore
let roles: Role[]
let agents: AgentInfo[]
/** Граф типа прогона в `resolveRun` (нужен прогону без снимка и при перезапуске приложения). */
let typeWorkflow: Workflow

function workflowDeps(): WorkflowDeps {
  return {
    store,
    repoRoot: tmp,
    run: () => ({ roles, workflow: typeWorkflow }),
    startWorker: (taskId) => {
      const d = store.startDispatch(taskId, `pty_${taskId}`)
      return { ptyId: d.ptyId, dispatchId: d.id }
    }
  }
}

function fakeDeps(): ProjectDeps {
  return {
    store,
    startWorker: (taskId) => {
      const d = store.startDispatch(taskId, `pty_${taskId}`)
      return { ptyId: d.ptyId, dispatchId: d.id, worktree: '/wt', branch: `orca/${taskId}` }
    },
    stopWorker: () => ({ stopped: [] }),
    review: () => ({}),
    accept: (taskId, decision) => reviewAccept(workflowDeps(), taskId, decision),
    reject: (taskId, feedback) => reviewReject(workflowDeps(), taskId, feedback),
    resolveRequest: (id, resolution) => store.resolveRequest(id, resolution),
    startCoordinator: () => 'pty_coord',
    deleteGlobalTask: () => ({ deleted: '', tasks: [] }),
    agents: () => agents,
    resolveRun: () => ({ ...resolveTaskType(presetTaskType('general')!), roles, workflow: typeWorkflow, source: 'default' }),
    taskTypes: () => ({ taskTypes: [], defaultTypeId: 'general' }),
    runType: () => runTypeInput(presetTaskType('general')!),
    saveTaskTypeRules: () => { throw new Error('не нужен') },
    columns: () => DEFAULT_COLUMNS,
    workflow: () => ({ typeId: 'general', title: 'Программирование', workflow: typeWorkflow, custom: false })
  }
}

interface Reply<T> {
  ok: boolean
  error?: string
  result: T
}

/** Поля ответов, которые проверяют тесты. */
interface StageReply { run: string; finished?: string; stage?: { nodeId: string; visits: number }; next: { type: string; nodeId: string } }
interface ShowReply {
  scope: string
  stage?: { nodeId: string; type: string; visit: number; roleIds?: string[]; instructions?: string; tasks: string[] }
  stages: Array<{ id: string }>
}
interface GlobalReply { stage?: { nodeId: string; visits: Record<string, number> }; stageHistory?: Array<{ nodeId: string }> }

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

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'orca-sock-stage-'))
  sockPath = process.platform === 'win32' ? `\\\\.\\pipe\\orca-sock-stage-${process.pid}-${Date.now()}` : path.join(tmp, 'orca.sock')
  store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  roles = DEFAULT_ROLES
  agents = [{ id: 'claude', title: 'Claude Code', installed: true, enabled: true, models: [], defaults: {} }]
  typeWorkflow = defaultWorkflow(roles)
  server = startSocketServer(sockPath, { resolve: () => fakeDeps(), projects: () => [] })
  await new Promise((r) => server.once('listening', r))
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  rmSync(tmp, { recursive: true, force: true })
})

/** Глобальная задача с воркфлоу прогона, граф начат: стоит на этапе «Работа». */
function startedRun(wf: Workflow = typeWorkflow): Run {
  typeWorkflow = wf
  const run = store.createRun('цель', 'pty_coord', wf)
  store.enterRunStage(run.id, { roleIds: roles.map((r) => r.id), workflow: wf })
  return run
}

const done = (taskId: string): void => { store.updateTask(taskId, { status: 'done' }) }
const events = (type: OrcaEvent['type']): OrcaEvent[] => store.listEvents().filter((e) => e.type === type)

/** Прогон на этапе-проверке `review`: подзадача закрыта, `stage finish` сделан, задача-проверка создана и запущена. */
async function atGate(): Promise<{ run: Run; gate: Task }> {
  const run = startedRun()
  const work = store.createTask({ title: 'Работа', roleId: 'developer', runId: run.id })
  done(work.id)
  assert.equal((await call('stage.finish', { run: run.id, summary: 'сделано' })).ok, true)
  const gate = store.createTask({ title: 'Проверка', roleId: 'reviewer', runId: run.id, gateFor: { runId: run.id, nodeId: 'review' } })
  store.startDispatch(gate.id, 'pty_gate')
  return { run, gate }
}

describe('stage finish', () => {
  it('закрывает этап «Работа»: граф идёт дальше, ответ говорит, что будет дальше', async () => {
    const run = startedRun()
    const work = store.createTask({ title: 'Работа', roleId: 'developer', runId: run.id })
    done(work.id)
    const res = await call<StageReply>('stage.finish', { run: run.id, summary: '## Сделано' })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.result.run, run.id)
    assert.equal(res.result.finished, 'work')
    assert.deepEqual(res.result.stage, { nodeId: 'review', visits: 1 })
    assert.deepEqual(res.result.next, { type: 'create_gate', nodeId: 'review' })
    assert.equal(store.getRun(run.id)!.stage!.nodeId, 'review')
    assert.equal(store.getRun(run.id)!.summary!.text, '## Сделано')
    assert.equal(events('stage_changed').length >= 2, true, 'переход отмечен событием stage_changed')
  })

  it('без подзадач и с незакрытой подзадачей — ошибка с подсказкой, этап не сдвинут', async () => {
    const run = startedRun()
    assert.match((await call('stage.finish', { run: run.id })).error!, /нет подзадач.*task create/)
    const work = store.createTask({ title: 'Работа', roleId: 'developer', runId: run.id })
    const open = await call('stage.finish', { run: run.id })
    assert.equal(open.ok, false)
    assert.match(open.error!, new RegExp(`не закрыты подзадачи \\(${work.id}\\).*stage_tasks_done`))
    assert.equal(store.getRun(run.id)!.stage!.nodeId, 'work')
  })

  it('вне этапа «Работа» — ошибка «дождись stage_started»', async () => {
    const { run } = await atGate()
    const res = await call('stage.finish', { run: run.id })
    assert.equal(res.ok, false)
    assert.match(res.error!, /сейчас не на этапе «Работа».*дождись stage_started/)
  })

  it('прогон старого формата — понятная ошибка про воркфлоу подзадач; без --run и --summary без текста — ошибки', async () => {
    const legacy = store.createRun('старый', undefined, legacyDefaultWorkflow([]))
    assert.match((await call('stage.finish', { run: legacy.id })).error!, /старый формат/)
    assert.match((await call('stage.finish', {})).error!, /--run обязателен/)
    const run = startedRun()
    assert.match((await call('stage.finish', { run: run.id, summary: true })).error!, /--summary требует текста/)
    assert.match((await call('stage.finish', { run: 'run_nope' })).error!, /run not found|нет/)
  })
})

describe('runs finish у прогона с воркфлоу глобальной задачи', () => {
  it('до run_done — ошибка с подсказкой stage finish; прогон старого формата — как раньше', async () => {
    const run = startedRun()
    const work = store.createTask({ title: 'Работа', roleId: 'developer', runId: run.id })
    done(work.id)
    const res = await call('runs.finish', { run: run.id })
    assert.equal(res.ok, false)
    assert.match(res.error!, /stage finish/)
    assert.equal(store.getRun(run.id)!.finishedAt, undefined)

    const legacy = store.createRun('старый', 'pty_c', legacyDefaultWorkflow([]))
    const t = store.createTask({ title: 'Старая', roleId: 'developer', runId: legacy.id })
    done(t.id)
    const ok = await call('runs.finish', { run: legacy.id, summary: 'итог' })
    assert.equal(ok.ok, true, ok.error)
    assert.equal(store.getRun(legacy.id)!.summary!.text, 'итог')
  })
})

describe('workflow show и global get по прогону', () => {
  it('scope run: граф и текущий этап с ролями, инструкциями и подзадачами захода', async () => {
    const wf = pipelineWorkflow([], { work: [{ id: 'work', roleIds: ['developer', 'qa'], instructions: 'Сделай фичу' }] })
    const run = startedRun(wf)
    const task = store.createTask({ title: 'Работа', roleId: 'developer', runId: run.id })
    const res = await call<ShowReply>('workflow.show', { run: run.id })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.result.scope, 'run')
    assert.equal(res.result.stage!.nodeId, 'work')
    assert.equal(res.result.stage!.type, 'work')
    assert.equal(res.result.stage!.visit, 1)
    assert.deepEqual(res.result.stage!.roleIds, ['developer', 'qa'])
    assert.equal(res.result.stage!.instructions, 'Сделай фичу')
    assert.deepEqual(res.result.stage!.tasks, [task.id])
    assert.equal(res.result.stages[0].id, 'start')
    assert.equal(res.result.stages.some((x) => x.id === 'end'), true)
  })

  it('граф не начат — scope run без stage; прогон старого формата — scope task', async () => {
    const fresh = store.createRun('цель', undefined, typeWorkflow)
    const a = await call<ShowReply>('workflow.show', { run: fresh.id })
    assert.equal(a.result.scope, 'run')
    assert.equal('stage' in a.result, false)
    const legacy = store.createRun('старый', undefined, legacyDefaultWorkflow([]))
    const b = await call<ShowReply>('workflow.show', { run: legacy.id })
    assert.equal(b.result.scope, 'task')
    assert.equal('stage' in b.result, false)
  })

  it('global get отдаёт stage и stageHistory; у старого формата их нет', async () => {
    const run = startedRun()
    const g = await call<GlobalReply>('global.get', { global: run.id })
    assert.equal(g.ok, true, g.error)
    assert.equal(g.result.stage!.nodeId, 'work')
    assert.equal(g.result.stage!.visits.work, 1)
    assert.equal(g.result.stageHistory![0].nodeId, 'work')
    const legacy = store.createRun('старый', undefined, legacyDefaultWorkflow([]))
    assert.equal('stage' in (await call('global.get', { global: legacy.id })).result, false)
  })
})

describe('task create в воркфлоу глобальной задачи', () => {
  it('вне этапа «Работа» — ошибка про stage_started, а не про --role', async () => {
    const { run } = await atGate()
    const res = await call('task.create', { title: 'Лишняя', run: run.id })
    assert.equal(res.ok, false)
    assert.match(res.error!, /только на этапе «Работа».*дождись stage_started/)
    const withRole = await call('task.create', { title: 'Лишняя', run: run.id, role: 'developer' })
    assert.match(withRole.error!, /дождись stage_started/)
  })

  it('роль вне списка этапа — ошибка со списком ролей; роль этапа и подзадача привязана к заходу', async () => {
    const run = startedRun(pipelineWorkflow([], { work: [{ id: 'work', roleIds: ['developer', 'qa'] }] }))
    const foreign = await call('task.create', { title: 'Чужая', run: run.id, role: 'reviewer' })
    assert.equal(foreign.ok, false)
    assert.match(foreign.error!, /роль «reviewer» не разрешена на этапе «Реализация».*«developer», «qa»/)
    const ok = await call<Task>('task.create', { title: 'Своя', run: run.id, role: 'qa' })
    assert.equal(ok.ok, true, ok.error)
    assert.deepEqual(ok.result.stageOf, { nodeId: 'work', visit: 1 })
  })

  it('у этапа несколько ролей и нет --role — ошибка со списком ролей этапа; одна роль берётся сама', async () => {
    const many = startedRun(pipelineWorkflow([], { work: [{ id: 'work', roleIds: ['developer', 'qa'] }] }))
    const res = await call('task.create', { title: 'Без роли', run: many.id })
    assert.equal(res.ok, false)
    assert.match(res.error!, /--role обязателен: этап «Реализация» ведут роли developer, qa/)
    const single = startedRun(pipelineWorkflow([], { work: [{ id: 'work', roleIds: ['qa'] }] }))
    const auto = await call<Task>('task.create', { title: 'Сама', run: single.id })
    assert.equal(auto.ok, true, auto.error)
    assert.equal(auto.result.roleId, 'qa')
  })
})

describe('review accept/reject по проверке ветки глобальной задачи', () => {
  it('accept своей проверки: прогон идёт по исходу accept, --task чужого прогона не нужен', async () => {
    const { run, gate } = await atGate()
    const res = await call('review.accept', { task: gate.id })
    assert.equal(res.ok, true, res.error)
    assert.equal(store.getRun(run.id)!.stage!.nodeId, 'check', 'дальше — «Проверка человеком»')
    assert.equal(events('stage_changed').at(-1)!.payload.outcome, 'accept')
  })

  it('reject с замечаниями: граф назад в работу, stage_started несёт feedback', async () => {
    const { run, gate } = await atGate()
    const res = await call('review.reject', { task: gate.id, feedback: 'нет тестов' })
    assert.equal(res.ok, true, res.error)
    const after = store.getRun(run.id)!
    assert.equal(after.stage!.nodeId, 'work')
    assert.equal(after.stage!.visits.work, 2)
    const started = events('stage_started').at(-1)!
    assert.equal(started.payload.feedback, 'нет тестов')
    assert.equal(after.returns?.at(-1)?.text, 'нет тестов')
  })

  it('решение по неактуальной проверке — ошибка, повторно граф не двигается', async () => {
    const { run, gate } = await atGate()
    assert.equal((await call('review.accept', { task: gate.id })).ok, true)
    const again = await call('review.accept', { task: gate.id })
    assert.equal(again.ok, false)
    assert.match(again.error!, /уже не актуальна/)
    assert.equal(store.getRun(run.id)!.stage!.nodeId, 'check')
  })

  it('проверка сдала done после решения — закрывается; без решения — workflow_blocked по прогону, без taskId', async () => {
    const { run, gate } = await atGate()
    // Сдала done, решения нет: граф остаётся на проверке, человек получает workflow_blocked (без taskId).
    store.finishDispatch(store.getTask(gate.id)!.dispatchId!, 'проверил', [])
    handleWorkflowEvents(workflowDeps(), events('worker_done'))
    assert.equal(store.getRun(run.id)!.stage!.nodeId, 'review')
    const blocked = events('workflow_blocked').at(-1)!
    assert.equal(blocked.taskId, undefined)
    assert.equal(blocked.payload.runId, run.id)
    assert.match(String(blocked.payload.reason), /сдана без решения/)
    // Решение человека в приложении: проверка уже сдана — закрывается вместе с решением.
    assert.equal((await call('review.accept', { task: gate.id })).ok, true)
    assert.equal(store.columnKind(store.getTask(gate.id)!.status), 'done')
    assert.equal(store.getRun(run.id)!.stage!.nodeId, 'check')
  })

  it('живой проверяющий: решение до done не закрывает его задачу, а его done — закрывает', async () => {
    const { run, gate } = await atGate()
    assert.equal((await call('review.accept', { task: gate.id })).ok, true)
    assert.equal(store.columnKind(store.getTask(gate.id)!.status), 'in_progress')
    store.finishDispatch(store.getTask(gate.id)!.dispatchId!, 'проверил', [])
    handleWorkflowEvents(workflowDeps(), events('worker_done'))
    assert.equal(store.columnKind(store.getTask(gate.id)!.status), 'done')
    assert.equal(events('workflow_blocked').length, 0)
    assert.equal(store.getRun(run.id)!.stage!.nodeId, 'check')
  })
})

describe('запросы к человеку без задачи (approval прогона)', () => {
  function approval(): { run: Run; request: HumanRequest } {
    const run = startedRun()
    const request = store.requestRunApproval(run.id, { nodeId: 'check', title: 'Проверка человеком', body: 'Ветка готова' })
    return { run, request }
  }

  it('request list --run и request get отдают запрос с runId и nodeId, без taskId', async () => {
    const { run, request } = approval()
    const list = await call<HumanRequest[]>('request.list', { run: run.id })
    assert.equal(list.ok, true, list.error)
    assert.deepEqual(list.result.map((r) => r.id), [request.id])
    assert.equal(list.result[0].taskId, undefined)
    const get = await call<HumanRequest>('request.get', { request: request.id })
    assert.equal(get.ok, true, get.error)
    assert.equal(get.result.runId, run.id)
    assert.equal(get.result.nodeId, 'check')
    assert.equal(get.result.body, 'Ветка готова')
    assert.equal(get.result.taskId, undefined)
  })

  it('request resolve --accept решает approval прогона, --all показывает решённые', async () => {
    const { run, request } = approval()
    const res = await call('request.resolve', { request: request.id, accept: true, decision: 'ок' })
    assert.equal(res.ok, true, res.error)
    assert.equal(store.getRequest(request.id)!.status, 'resolved')
    assert.equal((await call<HumanRequest[]>('request.list', { run: run.id })).result.length, 0)
    assert.equal((await call<HumanRequest[]>('request.list', { run: run.id, all: true })).result.length, 1)
  })
})
