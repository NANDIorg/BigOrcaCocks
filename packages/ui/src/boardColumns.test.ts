import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_COLUMNS, type BoardColumn, type ColumnKind, type Task } from '@orca-board/core'
import { compareInColumn, dropStatus, localBoardColumns, pendingDeps } from './boardColumns'

const kindOf = (status: string): ColumnKind | undefined => DEFAULT_COLUMNS.find((c) => c.id === status)?.kind

test('«Готовы» скрыта, её карточки — в «Бэклоге»', () => {
  const view = localBoardColumns(DEFAULT_COLUMNS)
  assert.deepEqual(view.map((v) => v.column.id), ['backlog', 'in_progress', 'needs_input', 'review', 'done'])
  assert.deepEqual(view[0].statuses, ['backlog', 'ready'])
  assert.deepEqual(view[1].statuses, ['in_progress'])
})

test('нет бэклога — «Готовы» показывается как есть', () => {
  const columns: BoardColumn[] = DEFAULT_COLUMNS.filter((c) => c.kind !== 'backlog')
  const view = localBoardColumns(columns)
  assert.deepEqual(view.map((v) => v.column.id), columns.map((c) => c.id))
  assert.deepEqual(view[0].statuses, ['ready'])
})

test('колонки с произвольными id: объединение по kind', () => {
  const columns: BoardColumn[] = [
    { id: 'plan', title: 'План', color: '#000', kind: 'custom' },
    { id: 'todo', title: 'Todo', color: '#000', kind: 'ready' },
    { id: 'wait', title: 'Ждут', color: '#000', kind: 'backlog' }
  ]
  assert.deepEqual(localBoardColumns(columns), [
    { column: columns[0], statuses: ['plan'] },
    { column: columns[2], statuses: ['wait', 'todo'] }
  ])
})

test('drop: внутри объединённой колонки статус не меняется, снаружи — backlog', () => {
  const [merged, work] = localBoardColumns(DEFAULT_COLUMNS)
  assert.equal(dropStatus(merged, 'ready'), undefined)
  assert.equal(dropStatus(merged, 'backlog'), undefined)
  assert.equal(dropStatus(merged, 'review'), 'backlog')
  assert.equal(dropStatus(work, 'ready'), 'in_progress')
  assert.equal(dropStatus(work, 'in_progress'), undefined)
})

const task = (id: string, status: string, createdAt: number, deps: string[] = []): Task =>
  ({ id, status, createdAt, updatedAt: createdAt, deps }) as unknown as Task

test('готовые к запуску выше ждущих, внутри — обычная сортировка', () => {
  const items = [task('b1', 'backlog', 1), task('r2', 'ready', 3), task('b2', 'backlog', 2), task('r1', 'ready', 4)]
  const byCreated = (a: Task, b: Task): number => a.createdAt - b.createdAt
  assert.deepEqual(items.sort(compareInColumn(kindOf, byCreated)).map((t) => t.id), ['r2', 'r1', 'b1', 'b2'])
})

test('pendingDeps: незакрытые и неизвестные зависимости', () => {
  const statuses = new Map([['a', 'done'], ['b', 'in_progress']])
  const statusOf = (id: string): string | undefined => statuses.get(id)
  assert.equal(pendingDeps({ deps: [] }, statusOf, kindOf), 0)
  assert.equal(pendingDeps({ deps: ['a'] }, statusOf, kindOf), 0)
  assert.equal(pendingDeps({ deps: ['a', 'b', 'x'] }, statusOf, kindOf), 2)
})
