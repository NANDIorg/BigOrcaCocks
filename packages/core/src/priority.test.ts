// Запуск: node --test (type stripping Node ≥ 22.6). Приоритет задач: дефолт, валидация, правка, миграция.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, type Persistence, type StoreSnapshot } from './store.ts'
import { DEFAULT_COLUMNS, PRIORITY_TITLES, TASK_PRIORITIES, priorityRank, type Task, type TaskPriority } from './types.ts'

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
