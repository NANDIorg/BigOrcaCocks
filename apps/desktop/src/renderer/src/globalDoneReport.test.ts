import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globalDoneReport } from './globalDoneReport'

const tasks = [
  { id: 't2', title: 'Ревью', status: 'done', createdAt: 2 },
  { id: 't1', title: 'Сделать A', status: 'done', createdAt: 1 },
  { id: 't3', title: 'Отменённая', status: 'backlog', createdAt: 3 }
]
const dispatches = [
  { taskId: 't1', startedAt: 10, summary: 'старый запуск' },
  { taskId: 't1', startedAt: 20, summary: ' сделал A \n' },
  { taskId: 't3', startedAt: 30, summary: 'не в done' }
]
const isDone = (s: string): boolean => s === 'done'

test('globalDoneReport: есть сводка координатора — показываем её', () => {
  assert.deepEqual(globalDoneReport({ summary: { at: 5, text: '## Итог' } }, tasks, dispatches, isDone), { kind: 'coordinator', text: '## Итог', at: 5 })
})

test('globalDoneReport: сводки нет (старый main, ручной перенос) — done-подзадачи по порядку со сводкой последнего запуска', () => {
  assert.deepEqual(globalDoneReport({}, tasks, dispatches, isDone), {
    kind: 'subtasks',
    items: [
      { taskId: 't1', title: 'Сделать A', summary: 'сделал A' },
      { taskId: 't2', title: 'Ревью' }
    ]
  })
})

test('globalDoneReport: сводка старше последнего возврата — прошлый заход, фоллбэк на подзадачи', () => {
  const g = { summary: { at: 5, text: 'прошлый итог' }, returns: [{ at: 3, text: 'a' }, { at: 7, text: 'доделай' }] }
  assert.equal(globalDoneReport(g, tasks, dispatches, isDone).kind, 'subtasks')
  const fresh = { ...g, summary: { at: 9, text: 'новый итог' } }
  assert.deepEqual(globalDoneReport(fresh, tasks, dispatches, isDone), { kind: 'coordinator', text: 'новый итог', at: 9 })
})

test('globalDoneReport: пустая сводка не считается, нет сделанных подзадач — пустой список', () => {
  assert.deepEqual(globalDoneReport({ summary: { at: 1, text: '  ' } }, [], [], isDone), { kind: 'subtasks', items: [] })
})
