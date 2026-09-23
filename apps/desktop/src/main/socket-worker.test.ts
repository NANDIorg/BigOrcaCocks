// Запуск: pnpm --filter @orca-board/desktop test. Хендлеры сокета `worker stop`, `worker restart`,
// `task reopen` на настоящем TaskStore через настоящий сокет. PTY и git не участвуют: startWorker и
// stopWorker — фейки, повторяющие контракт из main/index.ts (stopTaskWorker, closeTaskWorkers).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { connect, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskStore, DEFAULT_COLUMNS, DEFAULT_ROLES, type AgentInfo, type GlobalTask, type Role, type Task } from '@orca-board/core'
import { startSocketServer, type ProjectDeps } from './socket'

let tmp: string
let sockPath: string
let server: Server
let store: TaskStore
let roles: Role[]
let agents: AgentInfo[]
/** Порядок вызовов фейков: restart должен сначала остановить, потом запустить. */
let calls: string[]

function fakeDeps(): ProjectDeps {
  let pty = 0
  return {
    store,
    startWorker(taskId) {
      calls.push(`start:${taskId}`)
      const d = store.startDispatch(taskId, `pty_${++pty}`)
      return { ptyId: d.ptyId, dispatchId: d.id, worktree: '/wt', branch: `orca/${taskId}` }
    },
    // Как stopTaskWorker: dispatch'и закрыть до kill PTY, kill (ptyExited) не должен эскалировать,
    // задача из in_progress — в ready.
    stopWorker(taskId) {
      calls.push(`stop:${taskId}`)
      const closed = store.closeDispatches(taskId)
      for (const d of closed) store.ptyExited(d.ptyId, 1)
      const task = store.getTask(taskId)
      if (task && store.columnKind(task.status) === 'in_progress') store.moveTask(taskId, store.columnId('ready'))
      return { stopped: closed.map((d) => d.id) }
    },
    review: () => ({}),
    accept: () => undefined,
    resolveRequest: () => ({}),
    startCoordinator: () => 'pty_coord',
    deleteGlobalTask: () => ({ deleted: '', tasks: [] }),
    agents: () => agents,
    roles: () => roles,
    setRoles: (next) => (roles = next),
    agentRules: () => '',
    setAgentRules: (text) => text,
    columns: () => DEFAULT_COLUMNS
  }
}

/** Поля ответов этих хендлеров, которые проверяют тесты. */
interface Reply {
  ok: boolean
  error?: string
  result: {
    status?: string
    feedback?: string
    stopped?: string[]
    dispatchId?: string
    task?: { status: string; feedback?: string }
    worker?: { dispatchId: string }
  }
}

function call(method: string, params: Record<string, unknown>): Promise<Reply> {
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
      resolve(JSON.parse(buf.slice(0, nl)))
    })
    sock.on('error', reject)
  })
}

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'orca-sock-'))
  sockPath = process.platform === 'win32' ? `\\\\.\\pipe\\orca-sock-test-${process.pid}-${Date.now()}` : path.join(tmp, 'orca.sock')
  store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  roles = DEFAULT_ROLES
  agents = [{ id: 'claude', title: 'Claude Code', installed: true, enabled: true, models: [], defaults: {} }]
  calls = []
  server = startSocketServer(sockPath, { resolve: () => fakeDeps(), projects: () => [] })
  await new Promise((r) => server.once('listening', r))
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  rmSync(tmp, { recursive: true, force: true })
})

const escalations = (taskId: string) => store.listEvents().filter((e) => e.type === 'escalation' && e.taskId === taskId)

describe('worker stop', () => {
  it('задача в работе → ready, dispatch закрыт без эскалации и без запроса в Инбокс', async () => {
    const task = store.createTask({ title: 'Логин', roleId: 'developer' })
    const d = store.startDispatch(task.id, 'pty_w')
    const res = await call('worker.stop', { task: task.id })
    assert.equal(res.ok, true, res.error)
    assert.deepEqual(res.result.stopped, [d.id])
    assert.equal(res.result.task!.status, 'ready')
    assert.equal(escalations(task.id).length, 0)
    assert.equal(store.pendingRequests().filter((r) => r.taskId === task.id).length, 0)
  })

  it('задачу не в работе не двигает', async () => {
    const task = store.createTask({ title: 'Логин', roleId: 'developer' })
    const d = store.startDispatch(task.id, 'pty_w')
    store.finishDispatch(d.id, 'сделал', [])
    const res = await call('worker.stop', { task: task.id })
    assert.equal(res.ok, true, res.error)
    assert.deepEqual(res.result.stopped, [])
    assert.equal(res.result.task!.status, 'review')
  })

  it('без --task и с неизвестной задачей — ошибка', async () => {
    assert.match((await call('worker.stop', {})).error!, /--task обязателен/)
    assert.match((await call('worker.stop', { task: 'task_nope' })).error!, /task not found/)
  })
})

describe('global list/get: coordinatorAlive', () => {
  it('вычисляется из реестра PTY: чужой/мёртвый ptyId — false, без координатора — false', async () => {
    const g = store.createGlobalTask({ title: 'Цель' })
    const get = await call('global.get', { global: g.id })
    assert.equal(get.ok, true, get.error)
    assert.equal((get.result as { coordinatorAlive?: boolean }).coordinatorAlive, false)
    store.setRunPty(g.id, 'pty_dead')
    const list = (await call('global.list', {})).result as unknown as Array<{ id: string; coordinatorPtyId?: string; coordinatorAlive?: boolean }>
    const card = list.find((c) => c.id === g.id)!
    assert.equal(card.coordinatorPtyId, 'pty_dead')
    assert.equal(card.coordinatorAlive, false)
  })
})

describe('worker restart', () => {
  it('на задаче в работе: stop, затем start; feedback записан', async () => {
    const task = store.createTask({ title: 'Логин', roleId: 'developer' })
    const old = store.startDispatch(task.id, 'pty_w')
    const res = await call('worker.restart', { task: task.id, feedback: '  добавь тесты  ' })
    assert.equal(res.ok, true, res.error)
    assert.deepEqual(calls, [`stop:${task.id}`, `start:${task.id}`])
    assert.deepEqual(res.result.stopped, [old.id])
    assert.notEqual(res.result.dispatchId, old.id)
    assert.equal(store.getTask(task.id)!.feedback, 'добавь тесты')
    assert.equal(store.getTask(task.id)!.status, 'in_progress')
    assert.equal(escalations(task.id).length, 0)
  })

  it('роль с выключенным агентом — ошибка до остановки: живой воркер не тронут', async () => {
    const task = store.createTask({ title: 'Логин', roleId: 'developer' })
    store.startDispatch(task.id, 'pty_w')
    agents = [{ ...agents[0], enabled: false }]
    const res = await call('worker.restart', { task: task.id })
    assert.equal(res.ok, false)
    assert.match(res.error!, /выключен/)
    assert.deepEqual(calls, [])
    assert.equal(store.getTask(task.id)!.status, 'in_progress')
  })

  it('--feedback без текста — ошибка', async () => {
    const task = store.createTask({ title: 'Логин', roleId: 'developer' })
    assert.match((await call('worker.restart', { task: task.id, feedback: true })).error!, /--feedback требует текста/)
    assert.deepEqual(calls, [])
  })

  it('задача в review или done — отказ с подсказкой task reopen --start, воркер не запущен', async () => {
    const task = store.createTask({ title: 'Логин', roleId: 'developer' })
    const d = store.startDispatch(task.id, 'pty_w')
    store.finishDispatch(d.id, 'сделал', [])
    assert.equal(store.getTask(task.id)!.status, 'review')
    const inReview = await call('worker.restart', { task: task.id })
    assert.equal(inReview.ok, false)
    assert.match(inReview.error!, /task reopen .*--start/)
    store.moveTask(task.id, 'done')
    const done = await call('worker.restart', { task: task.id, feedback: 'ещё' })
    assert.equal(done.ok, false)
    assert.match(done.error!, /task reopen .*--start/)
    assert.deepEqual(calls, [])
    assert.equal(store.getTask(task.id)!.status, 'done')
    assert.equal(store.getTask(task.id)!.feedback, undefined)
  })
})

describe('task reopen', () => {
  it('done → ready с feedback, без --start воркер не запускается', async () => {
    const task = store.createTask({ title: 'Логин', roleId: 'developer' })
    const d = store.startDispatch(task.id, 'pty_w')
    store.finishDispatch(d.id, 'сделал', [])
    store.moveTask(task.id, 'done')
    const res = await call('task.reopen', { task: task.id, feedback: 'поправь вёрстку' })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.result.status, 'ready')
    assert.equal(res.result.feedback, 'поправь вёрстку')
    assert.deepEqual(calls, [])
  })

  it('--start — переоткрыть и сразу запустить воркера', async () => {
    const task = store.createTask({ title: 'Логин', roleId: 'developer' })
    const d = store.startDispatch(task.id, 'pty_w')
    store.finishDispatch(d.id, 'сделал', [])
    const res = await call('task.reopen', { task: task.id, feedback: 'ещё', start: true })
    assert.equal(res.ok, true, res.error)
    // task в ответе — тот же объект store, сериализуется после старта: статус уже in_progress.
    assert.equal(res.result.task!.feedback, 'ещё')
    assert.ok(res.result.worker!.dispatchId)
    assert.deepEqual(calls, [`start:${task.id}`])
    assert.equal(store.getTask(task.id)!.status, 'in_progress')
  })

  it('--start с неиспользуемой ролью — ошибка до переоткрытия', async () => {
    const task = store.createTask({ title: 'Логин', roleId: 'developer' })
    store.moveTask(task.id, 'done')
    agents = [{ ...agents[0], installed: false }]
    const res = await call('task.reopen', { task: task.id, start: true })
    assert.equal(res.ok, false)
    assert.match(res.error!, /не установлен/)
    assert.equal(store.getTask(task.id)!.status, 'done')
  })

  it('ждёт решения по ответу: без feedback — ошибка, с feedback — «Уточнить»', async () => {
    const task = store.createTask({ title: 'Макеты', roleId: 'developer', answerFor: 'human' })
    const d = store.startDispatch(task.id, 'pty_w')
    store.finishDispatch(d.id, 'итог', [], 'ответ')
    const noFeedback = await call('task.reopen', { task: task.id })
    assert.equal(noFeedback.ok, false)
    assert.match(noFeedback.error!, /уточнение не может быть пустым/)
    const res = await call('task.reopen', { task: task.id, feedback: 'подробнее' })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.result.status, 'ready')
    assert.ok(store.listEvents().some((e) => e.type === 'answer_clarified' && e.taskId === task.id))
    assert.equal(store.pendingRequests().filter((r) => r.taskId === task.id).length, 0)
  })

  it('задача в работе — ошибка с подсказкой worker restart', async () => {
    const task = store.createTask({ title: 'Логин', roleId: 'developer' })
    store.startDispatch(task.id, 'pty_w')
    const res = await call('task.reopen', { task: task.id, feedback: 'x' })
    assert.equal(res.ok, false)
    assert.match(res.error!, /worker restart/)
  })

  it('--feedback без текста — ошибка', async () => {
    const task = store.createTask({ title: 'Логин', roleId: 'developer' })
    assert.match((await call('task.reopen', { task: task.id, feedback: true })).error!, /--feedback требует текста/)
  })
})

describe('удалённая системная роль', () => {
  it('task create --role reviewer без роли reviewer — ошибка со списком ролей и подсказкой вернуть', async () => {
    roles = DEFAULT_ROLES.filter((r) => r.id !== 'reviewer')
    const res = await call('task.create', { title: 'Ревью', role: 'reviewer' })
    assert.equal(res.ok, false)
    assert.match(res.error!, /роли «reviewer» нет в проекте\. Роли: coordinator, assistant, developer, qa\./)
    assert.match(res.error!, /Вернуть системные роли/)
    assert.equal(store.listTasks().length, 0)
  })

  it('пользовательская роль — без подсказки про системные', async () => {
    const res = await call('task.create', { title: 'X', role: 'role_nope' })
    assert.equal(res.error, 'роли «role_nope» нет в проекте. Роли: coordinator, assistant, developer, reviewer, qa.')
  })

  it('worker start задачи на удалённой роли — понятная ошибка, воркер не запускается', async () => {
    const task = store.createTask({ title: 'Тесты', roleId: 'qa' })
    roles = DEFAULT_ROLES.filter((r) => r.id !== 'qa')
    const res = await call('worker.start', { task: task.id })
    assert.equal(res.ok, false)
    assert.match(res.error!, /^воркер не запустится: роли «qa» нет в проекте/)
    assert.deepEqual(calls, [])
  })
})

describe('приоритет задачи через сокет', () => {
  it('task create --priority high создаёт задачу с priority high, без флага — normal', async () => {
    const res = await call('task.create', { title: 'Срочно', role: 'developer', priority: 'high' })
    assert.equal(res.ok, true)
    assert.equal((res.result as Task).priority, 'high')
    const plain = await call('task.create', { title: 'Обычная', role: 'developer' })
    assert.equal((plain.result as Task).priority, 'normal')
  })

  it('task update --priority меняет приоритет задачи в работе; флаг без значения и мусор — ошибки', async () => {
    const task = store.createTask({ title: 'Логин', roleId: 'developer' })
    store.moveTask(task.id, 'in_progress')
    assert.equal(((await call('task.update', { task: task.id, priority: 'urgent' })).result as Task).priority, 'urgent')
    assert.match((await call('task.update', { task: task.id, priority: true })).error!, /--priority требует значения: urgent, high, normal, low/)
    assert.match((await call('task.create', { title: 'X', role: 'developer', priority: 'asap' })).error!, /приоритет: ожидается/)
    assert.match((await call('task.update', { task: task.id })).error!, /укажи --title, --spec и\/или --priority/)
  })

  it('global create / update --priority: приоритет глобальной задачи; без флага — normal', async () => {
    const created = await call('global.create', { title: 'x', priority: 'urgent' })
    assert.equal(created.ok, true)
    const g = created.result as GlobalTask
    assert.equal(g.priority, 'urgent')
    assert.equal(((await call('global.create', { title: 'y' })).result as GlobalTask).priority, 'normal')
    assert.equal(((await call('global.update', { global: g.id, priority: 'low' })).result as GlobalTask).priority, 'low')
    assert.match((await call('global.update', { global: g.id, priority: true })).error!, /--priority требует значения/)
    assert.match((await call('global.create', { title: 'z', priority: 'asap' })).error!, /приоритет: ожидается/)
    assert.equal(((await call('global.get', { global: g.id })).result as GlobalTask).priority, 'low')
  })
})
