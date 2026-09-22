import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareByDates, globalSortDates, isBoardSort, readSort, type BoardSort, type SortDates } from './boardSort'

const a: SortDates = { createdAt: 1, updatedAt: 30 }
const b: SortDates = { createdAt: 2, updatedAt: 10, doneAt: 20 }
const c: SortDates = { createdAt: 3, updatedAt: 20, doneAt: 40 }
const ids = new Map([[a, 'a'], [b, 'b'], [c, 'c']])
const order = (sort: BoardSort): string[] => [c, a, b].sort((x, y) => compareByDates(sort, x, y)).map((x) => ids.get(x)!)

test('created — старые сверху', () => {
  assert.deepEqual(order('created'), ['a', 'b', 'c'])
})

test('done — свежезавершённые сверху, незавершённые в конце', () => {
  assert.deepEqual(order('done'), ['c', 'b', 'a'])
})

test('updated — свежие сверху', () => {
  assert.deepEqual(order('updated'), ['a', 'c', 'b'])
})

test('globalSortDates: обновление — activityAt, завершение — closedAt', () => {
  const g = { createdAt: 1, updatedAt: 2, activityAt: 5, closedAt: 7, finishedAt: 9 } as Parameters<typeof globalSortDates>[0]
  assert.deepEqual(globalSortDates(g), { createdAt: 1, updatedAt: 5, doneAt: 7 })
})

test('readSort без localStorage — дефолт', () => {
  assert.equal(readSort('orca.globalBoard.sort'), 'created')
  assert.equal(isBoardSort('done'), true)
  assert.equal(isBoardSort('x'), false)
})
