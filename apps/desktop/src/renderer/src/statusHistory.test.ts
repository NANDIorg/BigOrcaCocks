import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BoardColumn, StatusChange, StatusSource } from '@orca-board/core'
import { STATUS_HISTORY_COLLAPSED, statusDurationLabel, statusHistoryRows, visibleStatusRows } from './statusHistory'

const MIN = 60_000
const HOUR = 60 * MIN

const columns: BoardColumn[] = [
  { id: 'backlog', title: 'Бэклог', color: '#888', kind: 'backlog' },
  { id: 'wip', title: 'В работе', color: '#4a8', kind: 'in_progress' },
  { id: 'done', title: 'Готово', color: '#6c6', kind: 'done' }
]

test('statusHistoryRows: нет поля или пусто — пустой список', () => {
  assert.deepEqual(statusHistoryRows(undefined, columns, 0), [])
  assert.deepEqual(statusHistoryRows([], columns, 0), [])
})

test('statusHistoryRows: колонка, цвет, источник и длительность до следующего перехода', () => {
  const history: StatusChange[] = [
    { status: 'backlog', at: 0, by: 'human' },
    { status: 'wip', at: 10 * MIN, by: 'worker' },
    { status: 'done', at: 2 * HOUR, by: 'workflow' }
  ]
  const rows = statusHistoryRows(history, columns, 3 * HOUR)
  assert.deepEqual(rows.map((r) => [r.title, r.color, r.source, r.durationMs, r.current]), [
    ['Бэклог', '#888', 'человек', 10 * MIN, false],
    ['В работе', '#4a8', 'воркер', 2 * HOUR - 10 * MIN, false],
    ['Готово', '#6c6', 'воркфлоу', HOUR, true]
  ])
})

test('statusHistoryRows: удалённая колонка — id без цвета; неизвестный источник — как есть', () => {
  const history = [{ status: 'gone', at: 0, by: 'robot' as StatusSource }]
  const [row] = statusHistoryRows(history, columns, MIN)
  assert.equal(row.title, 'gone')
  assert.equal(row.color, undefined)
  assert.equal(row.source, 'robot')
})

test('statusHistoryRows: cli — координатор или человек в терминале, app — приложение', () => {
  const rows = statusHistoryRows([{ status: 'backlog', at: 0, by: 'cli' }, { status: 'wip', at: 1, by: 'app' }], columns, 2)
  assert.deepEqual(rows.map((r) => r.source), ['координатор / CLI', 'приложение'])
})

test('statusHistoryRows: часы разъехались (now раньше записи) — длительность не отрицательная', () => {
  const [row] = statusHistoryRows([{ status: 'wip', at: HOUR, by: 'human' }], columns, 0)
  assert.equal(row.durationMs, 0)
})

test('statusDurationLabel: текущий — «сейчас», миграция — «≈»', () => {
  assert.equal(statusDurationLabel({ durationMs: 2 * HOUR, current: false, migrated: false }), '2 ч')
  assert.equal(statusDurationLabel({ durationMs: 5 * MIN, current: true, migrated: false }), 'сейчас · ⏱ 5 мин')
  const [migrated] = statusHistoryRows([{ status: 'wip', at: 0, by: 'app', migrated: true }], columns, HOUR)
  assert.equal(migrated.migrated, true)
  assert.equal(statusDurationLabel(migrated), 'сейчас · ⏱ ≈ 1 ч')
})

test('visibleStatusRows: свёрнутый — последние записи, развёрнутый и короткий — все', () => {
  const history: StatusChange[] = Array.from({ length: STATUS_HISTORY_COLLAPSED + 3 }, (_, i) => ({
    status: i % 2 ? 'wip' : 'backlog', at: i * MIN, by: 'human' as const
  }))
  const rows = statusHistoryRows(history, columns, HOUR)
  const collapsed = visibleStatusRows(rows, false)
  assert.equal(collapsed.length, STATUS_HISTORY_COLLAPSED)
  assert.equal(collapsed.at(-1)?.current, true)
  assert.equal(collapsed[0].index, 3)
  assert.equal(visibleStatusRows(rows, true).length, rows.length)
  assert.equal(visibleStatusRows(rows.slice(0, 2), false).length, 2)
})
