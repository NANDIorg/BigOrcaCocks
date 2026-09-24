// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// История статусов задач и глобальных задач (status-history.ts, TaskStore.setStatus / setRunStatus).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, type Persistence, type StoreSnapshot } from './store.ts'
import { DEFAULT_COLUMNS, type Task } from './types.ts'
import { STATUS_HISTORY_LIMIT, recordStage, recordStatus, statusSource, withStatusSource } from './status-history.ts'

const statuses = (h: { statusHistory?: { status: string }[] }): string[] => (h.statusHistory ?? []).map((e) => e.status)

describe('recordStage', () => {
  it('пишет вход в этап; та же нода подряд — отдельная запись', () => {
    const e: Parameters<typeof recordStage>[0] = {}
    recordStage(e, { nodeId: 'work', at: 1, outcome: 'next' })
    recordStage(e, { nodeId: 'work', at: 2, outcome: 'restart', from: 'work' })
    assert.deepEqual(e.stageHistory!.map((x) => [x.nodeId, x.outcome]), [['work', 'next'], ['work', 'restart']])
  })

  it('источник — из withStatusSource, вне — app', () => {
    const e: Parameters<typeof recordStage>[0] = {}
    recordStage(e, { nodeId: 'a', at: 1 })
    withStatusSource('workflow', () => recordStage(e, { nodeId: 'b', at: 2 }))
    assert.deepEqual(e.stageHistory!.map((x) => x.by), ['app', 'workflow'])
  })

  it(`хранится не больше ${STATUS_HISTORY_LIMIT} последних`, () => {
    const e: Parameters<typeof recordStage>[0] = {}
    for (let i = 0; i < STATUS_HISTORY_LIMIT + 5; i += 1) recordStage(e, { nodeId: 'n', at: i })
    assert.equal(e.stageHistory!.length, STATUS_HISTORY_LIMIT)
    assert.equal(e.stageHistory![0].at, 5)
  })
})

describe('recordStatus', () => {
  it('тот же статус подряд не пишется', () => {
    const e: { statusHistory?: { status: string; at: number; by: 'app' }[] } = {}
    assert.equal(recordStatus(e, 'ready', 1), true)
    assert.equal(recordStatus(e, 'ready', 2), false)
    assert.equal(recordStatus(e, 'done', 3), true)
    assert.deepEqual(statuses(e), ['ready', 'done'])
  })

  it(`хранится не больше ${STATUS_HISTORY_LIMIT} последних`, () => {
    const e = {}
    for (let i = 0; i < STATUS_HISTORY_LIMIT + 5; i += 1) recordStatus(e, i % 2 ? 'a' : 'b', i)
    const h = (e as { statusHistory: { at: number }[] }).statusHistory
    assert.equal(h.length, STATUS_HISTORY_LIMIT)
    assert.equal(h[0].at, 5)
    assert.equal(h.at(-1)!.at, STATUS_HISTORY_LIMIT + 4)
  })

  it('источник — из withStatusSource, вложенный перекрывает внешний, вне — app', () => {
    assert.equal(statusSource(), 'app')
    withStatusSource('human', () => {
      assert.equal(statusSource(), 'human')
      withStatusSource('workflow', () => assert.equal(statusSource(), 'workflow'))
      assert.equal(statusSource(), 'human')
    })
    assert.throws(() => withStatusSource('cli', () => { throw new Error('x') }))
    assert.equal(statusSource(), 'app')
  })
})

describe('история статусов в store', () => {
  it('переходы задачи пишутся с источником; повтор статуса — нет', () => {
    const store = new TaskStore()
    const task = withStatusSource('cli', () => store.createTask({ title: 't' }))
    // Без зависимостей задача сразу в ready — это сделало приложение, а не создавший её.
    assert.deepEqual(task.statusHistory!.map((e) => [e.status, e.by]), [['backlog', 'cli'], ['ready', 'app']])
    withStatusSource('human', () => store.moveTask(task.id, 'ready'))
    assert.equal(store.getTask(task.id)!.statusHistory!.length, 2)
    const d = store.startDispatch(task.id, 'pty_1')
    withStatusSource('worker', () => store.finishDispatch(d.id, 'готово'))
    withStatusSource('human', () => store.moveTask(task.id, 'done'))
    const h = store.getTask(task.id)!.statusHistory!
    assert.deepEqual(h.map((e) => [e.status, e.by]), [
      ['backlog', 'cli'], ['ready', 'app'], ['in_progress', 'app'], ['review', 'worker'], ['done', 'human']
    ])
    assert.ok(h.every((e, i) => i === 0 || e.at >= h[i - 1].at))
  })

  it('этап воркфлоу попадает в запись', () => {
    const store = new TaskStore()
    const task = store.createTask({ title: 't' })
    store.advanceStage(task.id, 'next')
    const stage = store.getTask(task.id)!.stage!.nodeId
    withStatusSource('workflow', () => store.moveTask(task.id, 'in_progress'))
    assert.deepEqual(store.getTask(task.id)!.statusHistory!.at(-1), {
      status: 'in_progress', at: store.getTask(task.id)!.statusHistory!.at(-1)!.at, by: 'workflow', stage
    })
  })

  it('глобальная задача: создание, перенос, приёмка; в GlobalTask — копия истории', () => {
    const store = new TaskStore()
    const g = withStatusSource('human', () => store.createGlobalTask({ title: 'g' }))
    withStatusSource('human', () => store.moveGlobalTask(g.id, 'in_progress'))
    withStatusSource('human', () => store.moveGlobalTask(g.id, 'in_progress'))
    withStatusSource('cli', () => store.moveGlobalTask(g.id, 'review'))
    withStatusSource('human', () => store.acceptGlobalTask(g.id))
    const got = store.getGlobalTask(g.id)
    assert.deepEqual(got.statusHistory!.map((e) => [e.status, e.by]), [
      ['backlog', 'human'], ['in_progress', 'human'], ['review', 'cli'], ['done', 'human']
    ])
    got.statusHistory![0].status = 'x'
    assert.equal(store.getRun(g.id)!.statusHistory![0].status, 'backlog')
  })

  it('автозакрытие прогона пишется от приложения', () => {
    const store = new TaskStore()
    const g = store.createGlobalTask({ title: 'g' })
    const task = store.createTask({ title: 't', runId: g.id })
    withStatusSource('human', () => store.moveTask(task.id, 'done'))
    const h = store.getRun(g.id)!.statusHistory!
    assert.deepEqual(h.map((e) => e.status), ['backlog', 'review'])
    assert.equal(h.at(-1)!.by, 'app')
  })
})

describe('миграция истории статусов', () => {
  function load(snap: Partial<StoreSnapshot>): { store: TaskStore; saved: StoreSnapshot[] } {
    const saved: StoreSnapshot[] = []
    const persistence: Persistence = { load: () => snap, save: (s) => saved.push(s) }
    return { store: new TaskStore(persistence, () => DEFAULT_COLUMNS), saved }
  }

  function oldTask(id: string, status: string, extra: Partial<Task> = {}): Task {
    return { id, title: id, spec: '', status, priority: 'normal', deps: [], roleId: 'worker', agent: 'claude', runId: 'run_1', createdAt: 0, updatedAt: 0, ...extra }
  }

  it('старые задачи и прогоны — стартовая запись с migrated на updatedAt; следующий переход — после неё', () => {
    const { store, saved } = load({
      runs: [{ id: 'run_1', objective: 'цель', createdAt: 0, updatedAt: 7, status: 'in_progress', priority: 'normal', startedAt: 0 }],
      tasks: [oldTask('t', 'ready', { updatedAt: 42 })]
    })
    assert.ok(saved.length > 0, 'миграция сохраняется сразу')
    assert.deepEqual(store.getTask('t')!.statusHistory, [{ status: 'ready', at: 42, by: 'app', migrated: true }])
    assert.deepEqual(store.getRun('run_1')!.statusHistory, [{ status: 'in_progress', at: 7, by: 'app', migrated: true }])
    withStatusSource('human', () => store.moveTask('t', 'done'))
    assert.deepEqual(statuses(store.getTask('t')!), ['ready', 'done'])
  })

  it('задача «В работе» с умершим воркером: стартовая запись, затем возврат в ready от приложения', () => {
    const { store } = load({
      runs: [{ id: 'run_1', objective: 'цель', createdAt: 0, status: 'in_progress' }],
      tasks: [oldTask('t', 'in_progress', { dispatchId: 'd1' })],
      dispatches: [{ id: 'd1', taskId: 't', ptyId: 'p1', startedAt: 0 }]
    })
    const h = store.getTask('t')!.statusHistory!
    assert.deepEqual(h.map((e) => [e.status, e.by, e.migrated]), [['in_progress', 'app', true], ['ready', 'app', undefined]])
  })

  it('история уже есть — не трогается', () => {
    const history = [{ status: 'backlog', at: 1, by: 'cli' as const }, { status: 'ready', at: 2, by: 'app' as const }]
    const { store } = load({
      runs: [{ id: 'run_1', objective: 'цель', createdAt: 0, status: 'in_progress', statusHistory: [{ status: 'in_progress', at: 3, by: 'human' }] }],
      tasks: [oldTask('t', 'ready', { statusHistory: history })]
    })
    assert.deepEqual(store.getTask('t')!.statusHistory, history)
    assert.deepEqual(statuses(store.getRun('run_1')!), ['in_progress'])
  })
})
