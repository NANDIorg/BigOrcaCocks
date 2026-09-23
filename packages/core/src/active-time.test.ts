// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Время работы задачи: копится только в kind=in_progress (active-time.ts, TaskStore.setStatus).
import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, type Persistence, type StoreSnapshot } from './store.ts'
import { DEFAULT_COLUMNS, type Task } from './types.ts'
import { activeDuration, taskActiveTime, trackActiveTime } from './active-time.ts'
import { toGlobalTask, globalOwnDuration, globalSubtasksDuration, type GlobalTask } from './global-tasks.ts'

const MIN = 60_000

/** Подменяем Date.now: время двигаем руками через tick. */
function clock(t: TestContext, start = 1_000_000): (ms: number) => void {
  t.mock.timers.enable({ apis: ['Date'], now: start })
  return (ms) => t.mock.timers.tick(ms)
}

function duration(task: Task, now = Date.now()): number | undefined {
  const a = taskActiveTime(task)
  return a && activeDuration(a, now)
}

describe('taskActiveTime / activeDuration', () => {
  it('не бывала в работе — undefined', () => {
    assert.equal(taskActiveTime({}), undefined)
  })

  it('закрытые отрезки плюс текущий до now', () => {
    assert.deepEqual(taskActiveTime({ activeMs: 5 * MIN }), { closedMs: 5 * MIN })
    const a = taskActiveTime({ activeMs: 5 * MIN, activeSince: 100 })!
    assert.equal(activeDuration(a, 100 + 2 * MIN), 7 * MIN)
    // Часы откатились назад — отрезок не уходит в минус.
    assert.equal(activeDuration(a, 50), 5 * MIN)
  })

  it('задача от старого main (без новых полей) — прежний расчёт от startedAt', () => {
    assert.deepEqual(taskActiveTime({ startedAt: 1000, doneAt: 5000 }), { closedMs: 4000 })
    assert.deepEqual(taskActiveTime({ startedAt: 1000 }), { closedMs: 0, since: 1000 })
  })

  it('trackActiveTime: вход открывает отрезок, повторный вход его не сдвигает, выход прибавляет', () => {
    const t: Pick<Task, 'activeMs' | 'activeSince'> = {}
    trackActiveTime(t, true, 100)
    trackActiveTime(t, true, 500)
    assert.deepEqual(t, { activeMs: 0, activeSince: 100 })
    trackActiveTime(t, false, 1100)
    assert.equal(t.activeMs, 1000)
    assert.equal(t.activeSince, undefined)
    trackActiveTime(t, false, 9999)
    assert.equal(t.activeMs, 1000)
  })
})

describe('TaskStore: время работы по переходам статуса', () => {
  it('тикает только в in_progress: пауза в review и ready, накопление по нескольким запускам', (t) => {
    const tick = clock(t)
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const task = store.createTask({ title: 'Сделай' })
    tick(10 * MIN)
    assert.equal(duration(store.getTask(task.id)!), undefined, 'в backlog/ready до запуска времени нет')

    const d1 = store.startDispatch(task.id, 'pty_1')
    tick(3 * MIN)
    assert.equal(duration(store.getTask(task.id)!), 3 * MIN)
    store.finishDispatch(d1.id, 'сделал', [])
    assert.equal(store.getTask(task.id)!.status, 'review')
    tick(60 * MIN)
    assert.equal(duration(store.getTask(task.id)!), 3 * MIN, 'в review не тикает')
    assert.equal(store.getTask(task.id)!.activeSince, undefined)

    store.rejectReview(task.id, 'поправь')
    tick(30 * MIN)
    assert.equal(duration(store.getTask(task.id)!), 3 * MIN, 'в ready не тикает')

    store.startDispatch(task.id, 'pty_2')
    tick(2 * MIN)
    assert.equal(duration(store.getTask(task.id)!), 5 * MIN, 'продолжает от набранного')
    store.moveTask(task.id, 'done')
    tick(60 * MIN)
    assert.equal(store.getTask(task.id)!.activeMs, 5 * MIN)
    assert.equal(duration(store.getTask(task.id)!), 5 * MIN, 'в done не тикает')
  })

  it('needs_input (вопрос к человеку) — пауза; ответ вернул в работу — снова тикает', (t) => {
    const tick = clock(t)
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const task = store.createTask({ title: 'Сделай' })
    store.startDispatch(task.id, 'pty_1')
    tick(4 * MIN)
    store.moveTask(task.id, 'needs_input')
    tick(20 * MIN)
    assert.equal(duration(store.getTask(task.id)!), 4 * MIN)
    store.moveTask(task.id, 'in_progress')
    tick(1 * MIN)
    assert.equal(duration(store.getTask(task.id)!), 5 * MIN)
    // Воркер упал без done: задача уходит из in_progress (эскалация) — время встаёт.
    store.ptyExited('pty_1', 1)
    assert.notEqual(store.columnKind(store.getTask(task.id)!.status), 'in_progress')
    tick(10 * MIN)
    assert.equal(duration(store.getTask(task.id)!), 5 * MIN)
  })

  it('reopen из done и повторный запуск — время копится дальше', (t) => {
    const tick = clock(t)
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const task = store.createTask({ title: 'Сделай' })
    const d = store.startDispatch(task.id, 'pty_1')
    tick(2 * MIN)
    store.finishDispatch(d.id, 'сделал', [])
    store.moveTask(task.id, 'done')
    tick(5 * MIN)
    store.reopenTask(task.id, 'ещё')
    store.startDispatch(task.id, 'pty_2')
    tick(3 * MIN)
    assert.equal(duration(store.getTask(task.id)!), 5 * MIN)
  })

  it('правка задачи не сбивает накопленное', (t) => {
    const tick = clock(t)
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const task = store.createTask({ title: 'Сделай' })
    const d = store.startDispatch(task.id, 'pty_1')
    tick(2 * MIN)
    store.finishDispatch(d.id, 'сделал', [])
    store.updateTask(task.id, { activeMs: 0, activeSince: 1 } as Partial<Task>)
    assert.equal(store.getTask(task.id)!.activeMs, 2 * MIN)
    assert.equal(store.getTask(task.id)!.activeSince, undefined)
  })

  it('глобальная задача: сумма подзадач тикает, пока хоть одна в работе', (t) => {
    const tick = clock(t)
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const run = store.createRun('цель')
    const a = store.createTask({ title: 'A', runId: run.id })
    const b = store.createTask({ title: 'B', runId: run.id })
    const da = store.startDispatch(a.id, 'pty_a')
    tick(2 * MIN)
    store.startDispatch(b.id, 'pty_b')
    tick(3 * MIN)
    store.finishDispatch(da.id, 'сделал', [])
    const g1 = toGlobalTask(store.getRun(run.id)!, store.listTasks(), DEFAULT_COLUMNS)
    assert.equal(g1.subtasksActiveMs, 5 * MIN)
    assert.equal(g1.subtasksActiveSince.length, 1)
    assert.equal(globalSubtasksDuration(g1, Date.now()), 8 * MIN)
    store.moveTask(b.id, 'ready')
    tick(60 * MIN)
    const g2 = toGlobalTask(store.getRun(run.id)!, store.listTasks(), DEFAULT_COLUMNS)
    assert.deepEqual(g2.subtasksActiveSince, [])
    assert.equal(globalSubtasksDuration(g2, Date.now()), 8 * MIN)
  })
})

describe('TaskStore: собственное время глобальной задачи', () => {
  function global(store: TaskStore, id: string): GlobalTask {
    return store.getGlobalTask(id)
  }

  it('тикает только в in_progress: бэклог и done стоят, несколько отрезков складываются', (t) => {
    const tick = clock(t)
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const g = store.createGlobalTask({ title: 'Цель' })
    tick(10 * MIN)
    assert.equal(globalOwnDuration(global(store, g.id), Date.now()), undefined, 'в бэклоге не бывала в работе')
    store.moveGlobalTask(g.id, 'in_progress')
    tick(3 * MIN)
    assert.equal(global(store, g.id).ownActiveSince !== undefined, true)
    assert.equal(globalOwnDuration(global(store, g.id), Date.now()), 3 * MIN)
    store.moveGlobalTask(g.id, 'backlog')
    tick(60 * MIN)
    assert.equal(global(store, g.id).ownActiveSince, undefined)
    assert.equal(globalOwnDuration(global(store, g.id), Date.now()), 3 * MIN)
    store.moveGlobalTask(g.id, 'in_progress')
    tick(2 * MIN)
    store.moveGlobalTask(g.id, 'done')
    tick(60 * MIN)
    assert.equal(global(store, g.id).ownActiveMs, 5 * MIN)
    assert.equal(globalOwnDuration(global(store, g.id), Date.now()), 5 * MIN)
  })

  it('не зависит от подзадач: подзадачи стоят — своё идёт, и наоборот', (t) => {
    const tick = clock(t)
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const run = store.createRun('цель')
    store.setRunPty(run.id, 'pty_c')
    const a = store.createTask({ title: 'A', runId: run.id })
    tick(4 * MIN)
    const da = store.startDispatch(a.id, 'pty_a')
    tick(1 * MIN)
    store.finishDispatch(da.id, 'сделал', [])
    tick(5 * MIN)
    const g = global(store, run.id)
    assert.equal(globalOwnDuration(g, Date.now()), 10 * MIN)
    assert.equal(globalSubtasksDuration(g, Date.now()), 1 * MIN)
  })

  it('«Нужен ответ» — время стоит, после ответа идёт снова', (t) => {
    const tick = clock(t)
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const run = store.createRun('цель')
    store.setRunPty(run.id, 'pty_c')
    const a = store.createTask({ title: 'A', runId: run.id })
    const d = store.startDispatch(a.id, 'pty_a')
    tick(2 * MIN)
    const q = store.ask({ taskId: a.id, dispatchId: d.id, question: 'как быть?' })
    assert.equal(global(store, run.id).status, 'needs_input')
    assert.equal(global(store, run.id).ownActiveSince, undefined)
    tick(30 * MIN)
    assert.equal(globalOwnDuration(global(store, run.id), Date.now()), 2 * MIN)
    store.answer(q.id, 'так')
    tick(1 * MIN)
    assert.equal(globalOwnDuration(global(store, run.id), Date.now()), 3 * MIN)
  })
})

describe('миграция времени работы при загрузке', () => {
  function load(snap: Partial<StoreSnapshot>): { store: TaskStore; saved: StoreSnapshot[] } {
    const saved: StoreSnapshot[] = []
    const persistence: Persistence = { load: () => snap, save: (s) => saved.push(s) }
    return { store: new TaskStore(persistence, () => DEFAULT_COLUMNS), saved }
  }

  /** Задача от старого кода: без полей, которые проставляют миграции (priority, activeMs…). */
  function oldTask(id: string, status: string, extra: Partial<Task> = {}): Task {
    return { id, title: id, spec: '', status, deps: [], roleId: 'worker', agent: 'claude', runId: 'run_1', createdAt: 0, updatedAt: 0, ...extra }
  }

  it('старые задачи: время — сумма закрытых запусков; не запускавшиеся — без полей', (t) => {
    clock(t, 100 * MIN)
    const { store, saved } = load({
      runs: [{ id: 'run_1', objective: 'цель', createdAt: 0, status: 'in_progress' }],
      tasks: [
        oldTask('t_done', 'done', { startedAt: 0, doneAt: 50 * MIN }),
        oldTask('t_review', 'review', { startedAt: 0 }),
        oldTask('t_new', 'ready')
      ],
      dispatches: [
        { id: 'd1', taskId: 't_done', ptyId: 'p1', startedAt: 0, endedAt: 3 * MIN, outcome: 'done' },
        { id: 'd2', taskId: 't_done', ptyId: 'p2', startedAt: 10 * MIN, endedAt: 12 * MIN, outcome: 'done' },
        { id: 'd3', taskId: 't_review', ptyId: 'p3', startedAt: 0, endedAt: 7 * MIN, outcome: 'done' }
      ]
    })
    assert.ok(saved.length > 0, 'миграция сохраняется сразу')
    assert.equal(store.getTask('t_done')!.activeMs, 5 * MIN)
    assert.equal(store.getTask('t_review')!.activeMs, 7 * MIN)
    assert.equal(store.getTask('t_review')!.activeSince, undefined)
    assert.equal(taskActiveTime(store.getTask('t_new')!), undefined)
  })

  it('задача в in_progress от старого кода: отрезок от начала живого запуска, закрыт при возврате в ready', (t) => {
    clock(t, 100 * MIN)
    const { store } = load({
      runs: [{ id: 'run_1', objective: 'цель', createdAt: 0, status: 'in_progress' }],
      tasks: [oldTask('t_run', 'in_progress', { startedAt: 0, dispatchId: 'd2' })],
      dispatches: [
        { id: 'd1', taskId: 't_run', ptyId: 'p1', startedAt: 0, endedAt: 4 * MIN, outcome: 'unknown' },
        { id: 'd2', taskId: 't_run', ptyId: 'p2', startedAt: 90 * MIN }
      ]
    })
    // Живой запуск не пережил перезапуск: closeStaleDispatches вернул задачу в ready и закрыл отрезок.
    const task = store.getTask('t_run')!
    assert.equal(task.status, 'ready')
    assert.equal(task.activeSince, undefined)
    assert.equal(task.activeMs, 4 * MIN + 10 * MIN)
  })

  it('задача в in_progress без запусков (перенесли руками) — тикает от updatedAt', (t) => {
    clock(t, 100 * MIN)
    const { store } = load({
      runs: [{ id: 'run_1', objective: 'цель', createdAt: 0, status: 'in_progress' }],
      tasks: [oldTask('t_manual', 'in_progress', { updatedAt: 60 * MIN })]
    })
    const task = store.getTask('t_manual')!
    assert.equal(task.activeSince, 60 * MIN)
    assert.equal(duration(task), 40 * MIN)
  })

  it('уже мигрированные данные не трогаются', (t) => {
    clock(t, 100 * MIN)
    const { store, saved } = load({
      runs: [{ id: 'run_1', objective: 'цель', createdAt: 0, status: 'in_progress', updatedAt: 0, activeMs: 7, activeSince: 0 }],
      // stage — задача в review уже на этапе воркфлоу, иначе её мигрирует migrateStages.
      // priority — иначе задачу мигрирует migrateTaskPriority.
      tasks: [oldTask('t', 'review', { startedAt: 0, activeMs: 42, priority: 'normal', stage: { nodeId: 'review', visits: { review: 1 } } })],
      dispatches: [{ id: 'd1', taskId: 't', ptyId: 'p1', startedAt: 0, endedAt: 4 * MIN, outcome: 'done' }],
      requests: []
    })
    assert.equal(store.getTask('t')!.activeMs, 42)
    assert.equal(store.getRun('run_1')!.activeSince, 0)
    assert.equal(saved.length, 0)
  })

  it('прогон от старого кода: в работе — отрезок от updatedAt, остальные — без полей (своё время неизвестно)', (t) => {
    clock(t, 100 * MIN)
    const { store, saved } = load({
      runs: [
        { id: 'run_1', objective: 'идёт', createdAt: 0, updatedAt: 70 * MIN, status: 'in_progress' },
        { id: 'run_2', objective: 'сделана', createdAt: 0, updatedAt: 50 * MIN, status: 'done', closedAt: 50 * MIN },
        { id: 'run_3', objective: 'в бэклоге', createdAt: 0, status: 'backlog' }
      ],
      requests: []
    })
    assert.ok(saved.length > 0, 'миграция сохраняется сразу')
    assert.equal(store.getRun('run_1')!.activeSince, 70 * MIN)
    assert.equal(globalOwnDuration(store.getGlobalTask('run_1'), Date.now()), 30 * MIN)
    for (const id of ['run_2', 'run_3']) {
      assert.equal(store.getRun(id)!.activeMs, undefined)
      assert.equal(globalOwnDuration(store.getGlobalTask(id), Date.now()), undefined)
    }
  })

  it('прогон от старого кода в «Нужен ответ» — отрезок не открывается', (t) => {
    clock(t, 100 * MIN)
    const { store } = load({
      runs: [{ id: 'run_1', objective: 'ждёт', createdAt: 0, updatedAt: 70 * MIN, status: 'in_progress' }],
      tasks: [oldTask('t', 'needs_input')],
      requests: [{ id: 'req_1', runId: 'run_1', taskId: 't', kind: 'escalation', status: 'pending', title: 'упал', options: [], createdAt: 80 * MIN }]
    })
    assert.equal(store.getRun('run_1')!.activeSince, undefined)
    assert.equal(store.getRun('run_1')!.activeMs, undefined)
  })
})
