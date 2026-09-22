// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Счётчик «в работе» для списка проектов: считается по kind колонки, а не по её id.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from './store.ts'
import { DEFAULT_COLUMNS, type BoardColumn } from './types.ts'

describe('inProgressCount', () => {
  it('пустая доска — 0; растёт и падает при перемещении задач', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    assert.equal(store.inProgressCount(), 0)
    const a = store.createTask({ title: 'a' })
    const b = store.createTask({ title: 'b' })
    store.moveTask(a.id, store.columnId('in_progress'))
    store.moveTask(b.id, store.columnId('in_progress'))
    assert.equal(store.inProgressCount(), 2)
    store.moveTask(a.id, store.columnId('done'))
    assert.equal(store.inProgressCount(), 1)
  })

  it('кастомная колонка с kind=in_progress и другим id', () => {
    const columns: BoardColumn[] = DEFAULT_COLUMNS.map((c) => (c.kind === 'in_progress' ? { ...c, id: 'doing' } : c))
    const store = new TaskStore(undefined, () => columns)
    const t = store.createTask({ title: 't' })
    store.moveTask(t.id, 'doing')
    assert.equal(store.inProgressCount(), 1)
  })
})
