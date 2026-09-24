import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priorityBadge, priorityEditable, priorityMark, runsKnowPriority, taskPriorityOf } from './taskPriority'

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

test('runsKnowPriority: старый main не проставляет priority прогонам', () => {
  assert.equal(runsKnowPriority([{}, {}]), false)
  assert.equal(runsKnowPriority([{ priority: 'normal' }, { priority: 'high' }]), true)
  assert.equal(runsKnowPriority([]), true)
})

test('priorityMark: короткая метка для карточки доски, normal без метки', () => {
  assert.equal(priorityMark({ priority: 'urgent' })?.mark, '!!')
  assert.equal(priorityMark({ priority: 'high' })?.mark, 'выс')
  assert.equal(priorityMark({ priority: 'low' })?.mark, 'низ')
  assert.equal(priorityMark({ priority: 'low' })?.title, 'низкий')
  assert.equal(priorityMark({ priority: 'normal' }), null)
  assert.equal(priorityMark({}), null)
})
