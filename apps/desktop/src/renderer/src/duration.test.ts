import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDuration, globalTaskDuration, taskDuration } from './duration'

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

test('taskDuration: done — от startedAt до doneAt', () => {
  assert.equal(taskDuration({ startedAt: 1000, doneAt: 5000 }, 99_999), 4000)
})

test('taskDuration: не done — до now', () => {
  assert.equal(taskDuration({ startedAt: 1000 }, 7000), 6000)
})

test('taskDuration: без startedAt — undefined', () => {
  assert.equal(taskDuration({}, 7000), undefined)
  assert.equal(taskDuration({ doneAt: 5000 }, 7000), undefined)
})

test('globalTaskDuration: закрыта — до closedAt, открыта — до now', () => {
  assert.equal(globalTaskDuration({ createdAt: 100, closedAt: 600 }, 9999), 500)
  assert.equal(globalTaskDuration({ createdAt: 100 }, 900), 800)
})
