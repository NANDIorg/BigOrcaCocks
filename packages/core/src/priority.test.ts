// Запуск: node --test (type stripping Node ≥ 22.6). Приоритет задач и глобальных задач: дефолт, валидация, правка, миграция.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, type Persistence, type StoreSnapshot } from './store.ts'
import { DEFAULT_COLUMNS, PRIORITY_TITLES, TASK_PRIORITIES, priorityRank, type Run, type Task, type TaskPriority } from './types.ts'
import { toGlobalTask } from './global-tasks.ts'

/** Хранилище в памяти: снапшот проходит через JSON, как файл на диске. */
function memory(initial?: Partial<StoreSnapshot>): Persistence & { data: Partial<StoreSnapshot> | null } {
  const p = {
    data: initial ? (JSON.parse(JSON.stringify(initial)) as Partial<StoreSnapshot>) : null,
    load: () => p.data,
    save: (s: StoreSnapshot) => { p.data = JSON.parse(JSON.stringify(s)) as StoreSnapshot }
  }
  return p
}

const store = (p?: Persistence) => new TaskStore(p, () => DEFAULT_COLUMNS)

describe('приоритет задачи', () => {
  it('ранг: urgent выше всех, нет поля и мусор — как normal; подписи у каждого значения', () => {
    assert.deepEqual(TASK_PRIORITIES.map(priorityRank), [0, 1, 2, 3])
    assert.equal(priorityRank(undefined), priorityRank('normal'))
    assert.equal(priorityRank('nope' as TaskPriority), priorityRank('normal'))
    assert.deepEqual(Object.keys(PRIORITY_TITLES), TASK_PRIORITIES)
  })

  it('createTask: по умолчанию normal, явный приоритет сохраняется', () => {
    const s = store()
    assert.equal(s.createTask({ title: 'A' }).priority, 'normal')
    assert.equal(s.createTask({ title: 'B', priority: 'high' }).priority, 'high')
  })

  it('createTask: неизвестный приоритет — ошибка по-русски, задача не создаётся', () => {
    const s = store()
    assert.throws(() => s.createTask({ title: 'A', priority: 'asap' as TaskPriority }), /приоритет: ожидается urgent, high, normal, low, получено «asap»/)
    assert.equal(s.listTasks().length, 0)
  })

  it('editTask: приоритет меняется и в работе, название в работе — нет', () => {
    const s = store()
    const t = s.createTask({ title: 'A' })
    s.moveTask(t.id, 'in_progress')
    assert.equal(s.editTask(t.id, { priority: 'urgent' }).priority, 'urgent')
    assert.throws(() => s.editTask(t.id, { title: 'B', priority: 'low' }), /задача в работе/)
    assert.equal(s.getTask(t.id)!.priority, 'urgent')
    assert.equal(s.getTask(t.id)!.status, 'in_progress')
  })

  it('editTask/updateTask: неизвестное значение отвергается, старое остаётся', () => {
    const s = store()
    const t = s.createTask({ title: 'A', priority: 'low' })
    assert.throws(() => s.editTask(t.id, { priority: 'HIGH' as TaskPriority }), /приоритет: ожидается/)
    assert.throws(() => s.updateTask(t.id, { priority: '' as TaskPriority }), /приоритет: ожидается/)
    assert.equal(s.getTask(t.id)!.priority, 'low')
  })

  it('миграция: старые задачи без поля и с мусором грузятся с normal и сразу сохраняются', () => {
    const s = store()
    const a = s.createTask({ title: 'A', priority: 'high' })
    const b = s.createTask({ title: 'B' })
    const c = s.createTask({ title: 'C' })
    const snap = s.snapshot()
    const tasks = snap.tasks.map((t): Task => {
      if (t.id === b.id) {
        const { priority: _drop, ...legacy } = t
        return legacy as Task
      }
      return t.id === c.id ? { ...t, priority: 'zzz' as TaskPriority } : t
    })
    const p = memory({ ...snap, tasks })
    const loaded = store(p)
    assert.equal(loaded.getTask(a.id)!.priority, 'high')
    assert.equal(loaded.getTask(b.id)!.priority, 'normal')
    assert.equal(loaded.getTask(c.id)!.priority, 'normal')
    assert.deepEqual(p.data!.tasks!.map((t) => t.priority), ['high', 'normal', 'normal'])
  })
})

describe('приоритет глобальной задачи', () => {
  it('createGlobalTask: по умолчанию normal, явный приоритет сохраняется; прогон координатора — normal', () => {
    const s = store()
    assert.equal(s.createGlobalTask({ title: 'A' }).priority, 'normal')
    const g = s.createGlobalTask({ title: 'B', priority: 'urgent' })
    assert.equal(g.priority, 'urgent')
    assert.equal(s.getRun(g.id)!.priority, 'urgent')
    assert.equal(s.getGlobalTask(s.createRun('цель').id).priority, 'normal')
  })

  it('createGlobalTask: неизвестный приоритет — ошибка по-русски, карточка не создаётся', () => {
    const s = store()
    assert.throws(() => s.createGlobalTask({ title: 'A', priority: 'asap' as TaskPriority }), /приоритет: ожидается urgent, high, normal, low, получено «asap»/)
    assert.equal(s.listGlobalTasks().length, 0)
  })

  it('updateGlobalTask: приоритет меняется в любой колонке, подзадачи не трогает; мусор — карточка не меняется', () => {
    const s = store()
    const g = s.createGlobalTask({ title: 'A', status: 'in_progress' })
    const sub = s.createTask({ title: 'sub', runId: g.id })
    assert.equal(s.updateGlobalTask(g.id, { priority: 'high' }).priority, 'high')
    assert.equal(s.getTask(sub.id)!.priority, 'normal')
    assert.throws(() => s.updateGlobalTask(g.id, { title: 'B', priority: 'HIGH' as TaskPriority }), /приоритет: ожидается/)
    assert.equal(s.getGlobalTask(g.id).title, 'A')
    assert.equal(s.getGlobalTask(g.id).priority, 'high')
    assert.throws(() => s.updateGlobalTask(g.id, {}), /укажи название, описание и\/или приоритет/)
  })

  it('миграция: прогоны без поля и с мусором грузятся с normal и сразу сохраняются', () => {
    const s = store()
    const a = s.createGlobalTask({ title: 'A', priority: 'low' })
    const b = s.createGlobalTask({ title: 'B' })
    const c = s.createGlobalTask({ title: 'C' })
    const snap = s.snapshot()
    const runs = snap.runs.map((r): Run => {
      if (r.id === b.id) {
        const { priority: _drop, ...legacy } = r
        return legacy
      }
      return r.id === c.id ? { ...r, priority: 'zzz' as TaskPriority } : r
    })
    const p = memory({ ...snap, runs })
    const loaded = store(p)
    assert.deepEqual([a, b, c].map((g) => loaded.getGlobalTask(g.id).priority), ['low', 'normal', 'normal'])
    assert.deepEqual(p.data!.runs!.map((r) => r.priority), ['low', 'normal', 'normal'])
  })

  it('toGlobalTask: прогон без поля (снапшот от старого main) — normal', () => {
    const run: Run = { id: 'run_1', objective: 'цель', status: 'backlog', createdAt: 0 }
    assert.equal(toGlobalTask(run, [], DEFAULT_COLUMNS).priority, 'normal')
  })
})
