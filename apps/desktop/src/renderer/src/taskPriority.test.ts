import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priorityBadge, priorityEditable, taskPriorityOf } from './taskPriority'

test('taskPriorityOf: нет поля или мусор — normal', () => {
  assert.equal(taskPriorityOf({}), 'normal')
  assert.equal(taskPriorityOf({ priority: 'x' }), 'normal')
  assert.equal(taskPriorityOf({ priority: 'urgent' }), 'urgent')
})

test('priorityBadge: normal и старые задачи без бейджа', () => {
  assert.equal(priorityBadge({ priority: 'normal' }), null)
  assert.equal(priorityBadge({}), null)
  assert.deepEqual(priorityBadge({ priority: 'high' }), { priority: 'high', title: 'высокий' })
  assert.deepEqual(priorityBadge({ priority: 'low' }), { priority: 'low', title: 'низкий' })
})

test('priorityEditable: только если main знает приоритет', () => {
  assert.equal(priorityEditable({}), false)
  assert.equal(priorityEditable({ priority: 'normal' }), true)
})
