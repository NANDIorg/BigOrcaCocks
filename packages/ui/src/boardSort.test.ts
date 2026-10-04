import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_SORT_OPTIONS, compareByDates, compareByPriority, compareGlobals, compareSorted, globalSortDates, isBoardSort, readSort, type BoardSort, type GlobalSortable, type Prioritized, type SortDates } from './boardSort'

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

test('readSort/isBoardSort принимают priority', () => {
  assert.equal(isBoardSort('priority'), true)
})

type P = Prioritized & SortDates & { id: string }
const card = (id: string, createdAt: number, priority?: Prioritized['priority']): P =>
  ({ id, createdAt, updatedAt: 100 - createdAt, ...(priority ? { priority } : {}) })
const byPriority = (items: P[]): string[] => [...items].sort((x, y) => compareSorted('priority', x, y)).map((x) => x.id)

test('priority — сначала выше приоритет', () => {
  assert.deepEqual(
    byPriority([card('low', 1, 'low'), card('normal', 2, 'normal'), card('urgent', 3, 'urgent'), card('high', 4, 'high')]),
    ['urgent', 'high', 'normal', 'low']
  )
})

test('priority — при равном приоритете порядок по созданию', () => {
  assert.deepEqual(byPriority([card('c', 3, 'high'), card('a', 1, 'high'), card('b', 2, 'high')]), ['a', 'b', 'c'])
})

test('priority — задача без поля считается normal', () => {
  assert.deepEqual(
    byPriority([card('old', 1), card('low', 0, 'low'), card('norm', 2, 'normal'), card('high', 3, 'high')]),
    ['high', 'old', 'norm', 'low']
  )
  assert.equal(compareByPriority({}, { priority: 'normal' }), 0)
})

test('в режимах по датам приоритет не влияет', () => {
  assert.deepEqual(
    [card('b', 2, 'urgent'), card('a', 1, 'low')].sort((x, y) => compareSorted('created', x, y)).map((x) => x.id),
    ['a', 'b']
  )
})

type G = GlobalSortable & { id: string }
const global = (id: string, createdAt: number, priority?: Prioritized['priority']): G =>
  ({ id, createdAt, activityAt: 100 - createdAt, ...(priority ? { priority } : {}) })
const globalsBy = (sort: BoardSort, items: G[]): string[] => [...items].sort((x, y) => compareGlobals(sort, x, y)).map((x) => x.id)

test('глобальная доска предлагает сортировку по приоритету', () => {
  assert.ok(BOARD_SORT_OPTIONS.some((o) => o.value === 'priority' && o.title === 'по приоритету'))
})

test('compareGlobals priority — сначала выше приоритет', () => {
  assert.deepEqual(
    globalsBy('priority', [global('low', 1, 'low'), global('normal', 2, 'normal'), global('urgent', 3, 'urgent'), global('high', 4, 'high')]),
    ['urgent', 'high', 'normal', 'low']
  )
})

test('compareGlobals priority — при равном приоритете порядок по созданию', () => {
  assert.deepEqual(globalsBy('priority', [global('c', 3, 'urgent'), global('a', 1, 'urgent'), global('b', 2, 'urgent')]), ['a', 'b', 'c'])
})

test('compareGlobals priority — карточка без поля (старый main) считается normal', () => {
  assert.deepEqual(
    globalsBy('priority', [global('old', 1), global('low', 0, 'low'), global('norm', 2, 'normal'), global('high', 3, 'high')]),
    ['high', 'old', 'norm', 'low']
  )
})

test('compareGlobals по датам приоритет не учитывает', () => {
  assert.deepEqual(globalsBy('created', [global('b', 2, 'urgent'), global('a', 1, 'low')]), ['a', 'b'])
  assert.deepEqual(globalsBy('updated', [global('a', 1, 'low'), global('b', 2, 'urgent')]), ['a', 'b'])
})
