// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Задачи-ответы и колонка «Нужен ответ» глобального канбана (docs/nested-kanban.md, «Ответы и ожидание человека»).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from './store.ts'
import { questionForHuman, waitingForHuman } from './global-tasks.ts'
import { workerTaskPrompt } from './prompts.ts'
import { DEFAULT_COLUMNS, MAX_ANSWER_LENGTH } from './types.ts'

/** Глобальная задача с живым координатором (как после global start) и двумя подзадачами. */
function setup(answerFor?: 'human' | 'coordinator') {
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  const g = store.createGlobalTask({ title: 'Разобраться' })
  store.setRunPty(g.id, 'pty_coord')
  const task = store.createTask({ title: 'Посмотри логи', runId: g.id, ...(answerFor ? { answerFor } : {}) })
  // Вторая подзадача не даёт прогону закрыться, когда первая уйдёт в done.
  const other = store.createTask({ title: 'Другое', runId: g.id })
  const dispatch = store.startDispatch(task.id, 'pty_w')
  return { store, g, task, other, dispatch }
}

describe('задача-ответ', () => {
  it('answerFor сохраняется; неизвестное значение — ошибка', () => {
    const { store, task } = setup('human')
    assert.equal(store.getTask(task.id)!.answerFor, 'human')
    assert.throws(() => store.createTask({ title: 'x', answerFor: 'boss' as never }), /answerFor/)
    assert.equal('answerFor' in store.createTask({ title: 'код' }), false)
  })

  it('done без ответа — ошибка, задача остаётся в работе', () => {
    const { store, task, dispatch } = setup('human')
    assert.throws(() => store.finishDispatch(dispatch.id, 'итог', [], '  \n'), /--answer-file/)
    assert.equal(store.getTask(task.id)!.status, 'in_progress')
    assert.equal(store.getDispatch(dispatch.id)!.endedAt, undefined)
  })

  it('слишком длинный ответ — ошибка', () => {
    const { store, dispatch } = setup('human')
    assert.throws(() => store.finishDispatch(dispatch.id, 'итог', [], 'x'.repeat(MAX_ANSWER_LENGTH + 1)), /длиннее/)
  })

  it('ответ сохраняется в dispatch и уходит в worker_done вместе с answerFor', () => {
    const { store, task, dispatch } = setup('coordinator')
    store.finishDispatch(dispatch.id, 'нашёл причину', [], '# Причина\n\n- таймаут')
    assert.equal(store.getDispatch(dispatch.id)!.answer, '# Причина\n\n- таймаут')
    assert.equal(store.getTask(task.id)!.status, 'review')
    const e = store.listEvents().find((x) => x.type === 'worker_done')!
    assert.equal(e.payload.answerFor, 'coordinator')
    assert.equal(e.payload.answer, '# Причина\n\n- таймаут')
  })

  it('обычная задача: ответ необязателен, в событии полей ответа нет', () => {
    const { store, dispatch } = setup()
    store.finishDispatch(dispatch.id, 'сделал', ['a.ts'])
    const e = store.listEvents().find((x) => x.type === 'worker_done')!
    assert.equal('answerFor' in e.payload, false)
    assert.equal('answer' in e.payload, false)
  })
})

describe('«Нужен ответ» на глобальном канбане', () => {
  it('ответ для человека готов → карточка в needs_input; принят → обратно в работу', () => {
    const { store, g, task, dispatch } = setup('human')
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
    store.finishDispatch(dispatch.id, 'итог', [], 'ответ')
    const waiting = store.getGlobalTask(g.id)
    assert.equal(waiting.status, 'needs_input')
    assert.equal(waiting.waiting, 1)
    // Хранимый статус не меняется: needs_input только вычисляется.
    assert.equal(store.getRun(g.id)!.status, 'in_progress')
    store.moveTask(task.id, 'done')
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
    assert.equal(store.getGlobalTask(g.id).waiting, 0)
  })

  it('уточнение (reject) — воркер снова работает, карточка в работе', () => {
    const { store, g, task, dispatch } = setup('human')
    store.finishDispatch(dispatch.id, 'итог', [], 'ответ')
    store.rejectReview(task.id, 'подробнее про БД')
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
    assert.match(workerTaskPrompt(store.getTask(task.id)!, 'ответ'), /# Прошлый ответ\n\nответ\n\n# Уточнение к прошлому ответу\n\nподробнее про БД/)
  })

  it('ответ для координатора человека не ждёт', () => {
    const { store, g, dispatch } = setup('coordinator')
    store.finishDispatch(dispatch.id, 'итог', [], 'ответ')
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
    assert.equal(store.getGlobalTask(g.id).waiting, 0)
  })

  it('вопрос воркера ждёт координатора; forward — ждёт человека; ответ — обратно в работу', () => {
    const { store, g, task, dispatch } = setup()
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: 'Какую БД?' })
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress', 'координатор ещё решает, кому вопрос')
    store.forwardQuestion(q.id)
    assert.equal(store.getGlobalTask(g.id).status, 'needs_input')
    store.answer(q.id, 'Postgres')
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
    assert.throws(() => store.forwardQuestion(q.id), /уже ответили/)
    assert.throws(() => store.forwardQuestion('q_none'), /not found/)
  })

  it('без координатора вопрос сразу адресован человеку — и из бэклога карточка тоже уходит в needs_input', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const g = store.createGlobalTask({ title: 'Руками' })
    const t = store.createTask({ title: 't', runId: g.id })
    store.ask({ taskId: t.id, question: '?' })
    assert.equal(store.getRun(g.id)!.status, 'backlog')
    assert.equal(store.getGlobalTask(g.id).status, 'needs_input')
  })

  it('координатор закончил (runs finish) или «Входящие» — вопросы человеку', () => {
    const run = { coordinatorPtyId: 'p' }
    assert.equal(questionForHuman({}, run), false)
    assert.equal(questionForHuman({ forHuman: true }, run), true)
    assert.equal(questionForHuman({}, { ...run, finishedAt: 1 }), true)
    assert.equal(questionForHuman({}, { inbox: true }), true)
    assert.equal(questionForHuman({}, undefined), true)
  })

  it('waitingForHuman: ответ для человека только в review', () => {
    const run = { coordinatorPtyId: 'p' }
    assert.equal(waitingForHuman({ id: 't', answerFor: 'human' }, 'review', [], run), true)
    assert.equal(waitingForHuman({ id: 't', answerFor: 'human' }, 'in_progress', [], run), false)
    assert.equal(waitingForHuman({ id: 't', answerFor: 'coordinator' }, 'review', [], run), false)
    assert.equal(waitingForHuman({ id: 't' }, 'review', [], run), false)
  })

  it('сделанная глобальная задача в needs_input не уходит', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const g = store.createGlobalTask({ title: 'G' })
    const t = store.createTask({ title: 't', runId: g.id })
    store.moveGlobalTask(g.id, 'done')
    store.ask({ taskId: t.id, question: '?' })
    assert.equal(store.getGlobalTask(g.id).status, 'done')
  })
})

describe('workerTaskPrompt задачи-ответа', () => {
  it('без уточнения — блок про ответ и --answer-file, адресат', () => {
    const text = workerTaskPrompt({ title: 'T', spec: 'S', answerFor: 'human' })
    assert.match(text, /^# Задача: T\n\nS\n\n# Результат — ответ, а не код/)
    assert.match(text, /читает человек/)
    assert.match(text, /--answer-file/)
    assert.doesNotMatch(text, /Уточнение/)
  })

  it('уточнение без прошлого ответа — только уточнение', () => {
    const text = workerTaskPrompt({ title: 'T', spec: 'S', answerFor: 'coordinator', feedback: 'F' })
    assert.match(text, /читает координатор/)
    assert.doesNotMatch(text, /Прошлый ответ/)
    assert.match(text, /# Уточнение к прошлому ответу\n\nF/)
  })
})
