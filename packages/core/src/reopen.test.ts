// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Переоткрытие задачи (`orca-board task reopen`, TaskStore.reopenTask).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from './store.ts'
import { DEFAULT_COLUMNS } from './types.ts'

function setup(answerFor?: 'human') {
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  const task = store.createTask({ title: 'Сделай', ...(answerFor ? { answerFor } : {}) })
  const dispatch = store.startDispatch(task.id, 'pty_w')
  return { store, task, dispatch }
}

describe('reopenTask', () => {
  it('done → ready с feedback, doneAt сброшен', () => {
    const { store, task, dispatch } = setup()
    store.finishDispatch(dispatch.id, 'сделал', [])
    store.moveTask(task.id, 'done')
    assert.ok(store.getTask(task.id)!.doneAt)
    const t = store.reopenTask(task.id, '  поправь тесты  ')
    assert.equal(t.status, 'ready')
    assert.equal(t.feedback, 'поправь тесты')
    assert.equal(t.doneAt, undefined)
  })

  it('без feedback — прежний feedback не трогается', () => {
    const { store, task, dispatch } = setup()
    store.finishDispatch(dispatch.id, 'сделал', [])
    store.rejectReview(task.id, 'старое')
    store.moveTask(task.id, 'backlog')
    assert.equal(store.reopenTask(task.id).feedback, 'старое')
    assert.equal(store.getTask(task.id)!.status, 'ready')
  })

  it('из review и backlog — в ready', () => {
    const { store, task, dispatch } = setup()
    store.finishDispatch(dispatch.id, 'сделал', [])
    assert.equal(store.getTask(task.id)!.status, 'review')
    assert.equal(store.reopenTask(task.id, 'ещё').status, 'ready')
    const other = store.createTask({ title: 'Другая' })
    store.moveTask(other.id, 'backlog')
    assert.equal(store.reopenTask(other.id).status, 'ready')
  })

  it('задачу в работе (живой воркер) переоткрыть нельзя', () => {
    const { store, task } = setup()
    assert.throws(() => store.reopenTask(task.id, 'x'), /worker restart/)
    assert.equal(store.getTask(task.id)!.status, 'in_progress')
  })

  it('ждущий ответ для человека — как «Уточнить»: запрос решён, answer_clarified', () => {
    const { store, task, dispatch } = setup('human')
    store.finishDispatch(dispatch.id, 'итог', [], 'ответ')
    const req = store.pendingRequests().find((r) => r.taskId === task.id && r.kind === 'answer')!
    assert.ok(req)
    assert.throws(() => store.reopenTask(task.id), /уточнение не может быть пустым/)
    const t = store.reopenTask(task.id, 'подробнее')
    assert.equal(t.status, 'ready')
    assert.equal(t.feedback, 'подробнее')
    const closed = store.getRequest(req.id)!
    assert.equal(closed.status, 'resolved')
    assert.equal(closed.resolution?.action, 'clarify')
    assert.ok(store.listEvents().some((e) => e.type === 'answer_clarified' && e.taskId === task.id))
  })

  it('needs_input с вопросом без живого воркера — в ready, запрос отменён', () => {
    const { store, task, dispatch } = setup()
    store.ask({ taskId: task.id, dispatchId: dispatch.id, question: 'Какую БД?' })
    store.closeDispatches(task.id)
    assert.equal(store.getTask(task.id)!.status, 'needs_input')
    assert.equal(store.reopenTask(task.id, 'бери Postgres').status, 'ready')
    assert.equal(store.pendingRequests().filter((r) => r.taskId === task.id).length, 0)
  })
})
