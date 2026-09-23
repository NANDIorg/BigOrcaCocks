import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDuration, globalTaskDuration, globalTaskTicking, globalTimeLabel, taskDuration, taskTicking } from './duration'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

test('formatDuration: меньше минуты, отрицательное и NaN — «<1 мин»', () => {
  assert.equal(formatDuration(0), '<1 мин')
  assert.equal(formatDuration(59_999), '<1 мин')
  assert.equal(formatDuration(-5 * MIN), '<1 мин')
  assert.equal(formatDuration(NaN), '<1 мин')
})

test('formatDuration: минуты, часы, дни; секунды отбрасываются', () => {
  assert.equal(formatDuration(MIN), '1 мин')
  assert.equal(formatDuration(5 * MIN + 59_000), '5 мин')
  assert.equal(formatDuration(HOUR), '1 ч')
  assert.equal(formatDuration(2 * HOUR + 15 * MIN), '2 ч 15 мин')
  assert.equal(formatDuration(DAY), '1 д')
  assert.equal(formatDuration(3 * DAY + 4 * HOUR + 30 * MIN), '3 д 4 ч')
})

test('taskDuration: накопленное время работы плюс идущий отрезок до now', () => {
  assert.equal(taskDuration({ activeMs: 5 * MIN, activeSince: 1000 }, 1000 + 2 * MIN), 7 * MIN)
  assert.ok(taskTicking({ activeMs: 5 * MIN, activeSince: 1000 }))
})

test('taskDuration: не в работе — застывшее значение, от now не зависит', () => {
  const t = { activeMs: 3 * MIN, startedAt: 0 }
  assert.equal(taskDuration(t, 10 * DAY), 3 * MIN)
  assert.equal(taskDuration(t, 0), 3 * MIN)
  assert.equal(taskTicking(t), false)
})

test('taskDuration: не бывала в работе — undefined', () => {
  assert.equal(taskDuration({}, 7000), undefined)
  assert.equal(taskTicking({}), false)
})

test('taskDuration: задача от старого main — от startedAt до doneAt, не done — до now', () => {
  assert.equal(taskDuration({ startedAt: 1000, doneAt: 5000 }, 99_999), 4000)
  assert.equal(taskDuration({ startedAt: 1000 }, 7000), 6000)
  assert.equal(taskDuration({ doneAt: 5000 }, 7000), undefined)
})

test('globalTaskDuration subtasks: сумма подзадач; тикает только идущими отрезками', () => {
  const stopped = { subtasksActiveMs: 10 * MIN, subtasksActiveSince: [] }
  assert.equal(globalTaskDuration(stopped, 'subtasks', 5 * HOUR), 10 * MIN)
  assert.equal(globalTaskTicking(stopped, 'subtasks'), false)
  const running = { subtasksActiveMs: 10 * MIN, subtasksActiveSince: [0, MIN] }
  assert.equal(globalTaskDuration(running, 'subtasks', 3 * MIN), 10 * MIN + 3 * MIN + 2 * MIN)
  assert.equal(globalTaskTicking(running, 'subtasks'), true)
})

test('globalTaskDuration own: своё время тикает независимо от подзадач', () => {
  const g = { ownActiveMs: 5 * MIN, ownActiveSince: HOUR, subtasksActiveMs: 0, subtasksActiveSince: [] }
  assert.equal(globalTaskDuration(g, 'own', HOUR + 2 * MIN), 7 * MIN)
  assert.equal(globalTaskTicking(g, 'own'), true)
  assert.equal(globalTaskTicking(g, 'subtasks'), false)
  const paused = { ownActiveMs: 5 * MIN, subtasksActiveMs: 3 * MIN, subtasksActiveSince: [0] }
  assert.equal(globalTaskDuration(paused, 'own', 10 * DAY), 5 * MIN)
  assert.equal(globalTaskTicking(paused, 'own'), false)
})

test('своё время неизвестно (старый прогон) — undefined, подписи нет', () => {
  const g = { subtasksActiveMs: 3 * MIN, subtasksActiveSince: [] }
  assert.equal(globalTaskDuration(g, 'own', HOUR), undefined)
  assert.equal(globalTimeLabel(g, 'own', HOUR, 'chip'), undefined)
  assert.equal(globalTimeLabel(g, 'subtasks', HOUR, 'chip'), 'Σ ⏸ 3 мин')
})

test('карточка от старого main: activeMs/activeSince — сумма подзадач, основного нет', () => {
  const legacy = { activeMs: 10 * MIN, activeSince: [0] }
  assert.equal(globalTaskDuration(legacy, 'subtasks', 2 * MIN), 12 * MIN)
  assert.equal(globalTaskTicking(legacy, 'subtasks'), true)
  assert.equal(globalTaskDuration(legacy, 'own', 2 * MIN), undefined)
  assert.equal(globalTaskDuration({}, 'subtasks', HOUR), 0)
})

test('globalTimeLabel: иконки хода и паузы, закрытая — «за …», строка для шапки', () => {
  const g = { ownActiveMs: HOUR, ownActiveSince: 0, subtasksActiveMs: 2 * HOUR, subtasksActiveSince: [] }
  assert.equal(globalTimeLabel(g, 'own', 5 * MIN, 'chip'), '⏱ 1 ч 5 мин')
  assert.equal(globalTimeLabel(g, 'subtasks', 5 * MIN, 'chip'), 'Σ ⏸ 2 ч')
  assert.equal(globalTimeLabel(g, 'own', 5 * MIN, 'line'), 'Время работы: ⏱ 1 ч 5 мин')
  assert.equal(globalTimeLabel(g, 'subtasks', 5 * MIN, 'line'), 'Σ подзадач: ⏸ 2 ч')
  const closed = { ownActiveMs: HOUR, subtasksActiveMs: 2 * HOUR, subtasksActiveSince: [], closedAt: 1 }
  assert.equal(globalTimeLabel(closed, 'own', 0, 'chip'), 'за 1 ч')
  assert.equal(globalTimeLabel(closed, 'subtasks', 0, 'chip'), 'Σ 2 ч')
})
