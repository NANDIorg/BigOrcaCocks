// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Задачи-ответы и колонка «Нужен ответ» глобального канбана (docs/nested-kanban.md, «Ответы и ожидание человека»).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore } from './store.ts'
import { questionForHuman, waitingForHuman } from './global-tasks.ts'
import { workerTaskPrompt, questionAnswerMessage } from './prompts.ts'
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
    assert.equal(store.getTask(task.id)!.status, 'needs_input', 'подзадача ждёт человека, не ревью')
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
    assert.equal(store.getTask(task.id)!.status, 'ready')
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
    assert.match(workerTaskPrompt(store.getTask(task.id)!, 'ответ'), /# Прошлый ответ\n\nответ\n\n# Уточнение к прошлому ответу\n\nподробнее про БД/)
  })

  it('ответ для координатора человека не ждёт', () => {
    const { store, g, dispatch } = setup('coordinator')
    store.finishDispatch(dispatch.id, 'итог', [], 'ответ')
    assert.equal(store.getTask(dispatch.taskId)!.status, 'review')
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
    assert.equal(store.getGlobalTask(g.id).waiting, 0)
  })

  it('вопрос воркера ждёт координатора; forward — ждёт человека; ответ — обратно в работу', () => {
    const { store, g, task, dispatch } = setup()
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: 'Какую БД?' })
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress', 'координатор ещё решает, кому вопрос')
    store.forwardQuestion(q.id)
    assert.equal(store.getTask(task.id)!.status, 'needs_input')
    assert.equal(store.getGlobalTask(g.id).status, 'needs_input')
    store.answer(q.id, 'Postgres')
    assert.equal(store.getTask(task.id)!.status, 'in_progress', 'воркер жив — работает дальше')
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
    assert.throws(() => store.forwardQuestion(q.id), /уже ответили/)
    assert.throws(() => store.forwardQuestion('q_none'), /not found/)
  })

  it('forward возвращает в needs_input, даже если задачу успели сдвинуть', () => {
    const { store, task, dispatch } = setup()
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?' })
    store.moveTask(task.id, 'in_progress')
    store.forwardQuestion(q.id)
    assert.equal(store.getTask(task.id)!.status, 'needs_input')
  })

  it('ответ на вопрос без живого воркера — задача в ready', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const t = store.createTask({ title: 't' })
    const q = store.ask({ taskId: t.id, question: '?' })
    store.answer(q.id, 'да')
    assert.equal(store.getTask(t.id)!.status, 'ready')
  })

  it('сданный ответ для человека: ответ на старый вопрос не уводит задачу из needs_input', () => {
    const { store, task, dispatch } = setup('human')
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?' })
    store.finishDispatch(dispatch.id, 'итог', [], 'ответ')
    store.answer(q.id, 'поздно')
    assert.equal(store.getTask(task.id)!.status, 'needs_input')
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

  it('waitingForHuman: ответ для человека в needs_input (и review — старые данные)', () => {
    const run = { coordinatorPtyId: 'p' }
    assert.equal(waitingForHuman({ id: 't', answerFor: 'human' }, 'needs_input', [], run), true)
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

/** События прогона, как их видит координатор через `check --run <runId>`. */
function coordinatorEvents(store: TaskStore, runId: string) {
  return store.consumeEvents(['worker_done', 'question', 'escalation', 'task_ready', 'question_answered', 'answer_accepted', 'run_done'], runId, runId)
}

describe('после ответа человека процесс идёт дальше сам', () => {
  it('человек принял ответ → answer_accepted с текстом ответа в прогон координатора, задача в done', () => {
    const { store, g, task, dispatch } = setup('human')
    store.finishDispatch(dispatch.id, 'суть', [], '# Варианты\n\n- A')
    coordinatorEvents(store, g.id)
    store.acceptTask(task.id)
    assert.equal(store.getTask(task.id)!.status, 'done')
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress', 'карточка ушла из «Нужен ответ»')
    const events = coordinatorEvents(store, g.id)
    assert.deepEqual(events.map((e) => e.type), ['answer_accepted'])
    assert.equal(events[0].taskId, task.id)
    assert.equal(events[0].payload.answer, '# Варианты\n\n- A')
    assert.equal(events[0].payload.summary, 'суть')
    // Повторная приёмка события не шлёт.
    store.acceptTask(task.id)
    assert.deepEqual(coordinatorEvents(store, g.id), [])
  })

  it('принятый ответ был последней задачей — answer_accepted приходит раньше run_done', () => {
    const { store, g, task, other, dispatch } = setup('human')
    store.moveTask(other.id, 'done')
    store.finishDispatch(dispatch.id, 'суть', [], 'ответ')
    coordinatorEvents(store, g.id)
    store.acceptTask(task.id)
    assert.deepEqual(coordinatorEvents(store, g.id).map((e) => e.type), ['answer_accepted', 'run_done'])
    // Координатор решил продолжить по ответу: новая подзадача переоткрывает прогон.
    store.createTask({ title: 'Сделать вариант A', runId: g.id })
    assert.equal(store.getRun(g.id)!.closedAt, undefined)
  })

  it('ответ координатору и обычная задача: accept без answer_accepted (решает сам координатор)', () => {
    const { store, g, task, dispatch } = setup('coordinator')
    store.finishDispatch(dispatch.id, 'суть', [], 'ответ')
    coordinatorEvents(store, g.id)
    store.acceptTask(task.id)
    assert.deepEqual(coordinatorEvents(store, g.id), [])
  })

  it('уточнение: задача уходит из «Нужен ответ» в ready, перезапуск — снова worker_done в прогон', () => {
    const { store, g, task, dispatch } = setup('human')
    store.finishDispatch(dispatch.id, 'суть', [], 'ответ')
    store.rejectReview(task.id, 'подробнее')
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
    const again = store.startDispatch(task.id, 'pty_w2')
    store.finishDispatch(again.id, 'суть 2', [], 'ответ 2')
    const done = coordinatorEvents(store, g.id).filter((e) => e.type === 'worker_done').at(-1)!
    assert.equal(done.payload.answer, 'ответ 2')
  })

  it('ответ человека на переданный вопрос — question_answered в прогон координатора, воркер жив', () => {
    const { store, g, task, dispatch } = setup()
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: 'Какую БД?' })
    store.forwardQuestion(q.id)
    coordinatorEvents(store, g.id)
    store.answer(q.id, 'Postgres')
    const [e] = coordinatorEvents(store, g.id)
    assert.equal(e.type, 'question_answered')
    assert.equal(e.payload.workerLive, true)
    assert.equal(e.payload.question, 'Какую БД?')
    assert.equal(e.payload.answer, 'Postgres')
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
  })

  it('ответ, когда воркер уже вышел, — workerLive: false, задача в ready, ответ в промпте перезапуска', () => {
    const { store, g, task, dispatch } = setup()
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: 'Какую БД?' })
    store.forwardQuestion(q.id)
    store.ptyExited('pty_w', 0)
    coordinatorEvents(store, g.id)
    store.answer(q.id, 'Postgres')
    const [e] = coordinatorEvents(store, g.id)
    assert.equal(e.payload.workerLive, false)
    assert.equal(e.payload.status, 'ready')
    assert.equal(store.getTask(task.id)!.status, 'ready')
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
    const answered = store.snapshot().questions.filter((x) => x.taskId === task.id && x.answeredAt)
    assert.match(workerTaskPrompt(store.getTask(task.id)!, undefined, answered), /# Ответы на твои вопросы\n\n- Какую БД\?\n  Ответ: Postgres/)
  })
})

describe('questionAnswerMessage', () => {
  it('одна строка: вопрос, ответ и просьба продолжить', () => {
    const text = questionAnswerMessage({ question: 'Какую\nБД?', answer: 'Postgres,\n  версии 16' })
    assert.equal(text, '[orca] Ответ на твой вопрос «Какую БД?»: Postgres, версии 16 — продолжай задачу с учётом ответа.')
    assert.doesNotMatch(text, /\n/)
  })

  it('промпт без ответов на вопросы — без раздела', () => {
    assert.doesNotMatch(workerTaskPrompt({ title: 'T', spec: 'S' }, undefined, [{ question: '?' }]), /Ответы на твои вопросы/)
  })
})
