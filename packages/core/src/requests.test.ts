// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// HumanRequest — запрос к человеку: создание из четырёх источников, решения, отмена, миграция снапшота.
// «Нужен ответ» здесь проверяется только через status === 'pending'.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, EVENT_TITLE_LIMIT, type StoreSnapshot } from './store.ts'
import { WORKFLOW_VERSION, type Workflow } from './workflow.ts'
import { DEFAULT_COLUMNS, REQUEST_ACTIONS, type HumanRequest, type ResolutionAction } from './types.ts'

/** Глобальная задача с двумя подзадачами (вторая не даёт прогону закрыться) и живым воркером первой. */
function setup(opts: { answerFor?: 'human' } = {}) {
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  const g = store.createGlobalTask({ title: 'G' })
  store.setRunPty(g.id, 'pty_coord')
  const task = store.createTask({ title: 't', runId: g.id, ...(opts.answerFor ? { answerFor: opts.answerFor } : {}) })
  store.createTask({ title: 'other', runId: g.id })
  const dispatch = store.startDispatch(task.id, 'pty_w')
  return { store, g, task, dispatch }
}

const pending = (store: TaskStore, runId?: string): HumanRequest[] =>
  store.listRequests().filter((r) => r.status === 'pending' && (runId === undefined || r.runId === runId))

/** Инвариант: колонка подзадачи и глобальная карточка в «Нужен ответ» ⇔ есть pending-запрос. */
function assertWaiting(store: TaskStore, runId: string, taskId: string, waiting: boolean): void {
  assert.equal(pending(store, runId).length > 0, waiting, 'pending-запросы прогона')
  assert.equal(store.getGlobalTask(runId).status === 'needs_input', waiting, 'глобальная карточка')
  assert.equal(store.getTask(taskId)!.status === 'needs_input', waiting, 'колонка подзадачи')
}

interface Source {
  name: string
  kind: HumanRequest['kind']
  /** Воркер после создания запроса ещё жив (для answer/escalation — всегда нет). */
  workerLive: boolean
  create(): { store: TaskStore; g: { id: string }; task: { id: string }; request: HumanRequest }
}

function questionSource(name: string, coordinatorAlive: boolean, workerLive: boolean, route: 'ask' | 'forward' | 'coordinator_died'): Source {
  return {
    name, kind: 'question', workerLive,
    create() {
      const { store, g, task, dispatch } = setup()
      const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: 'Какую БД?', options: ['sqlite', 'postgres'] }, { coordinatorAlive })
      if (route === 'forward') store.forwardQuestion(q.id, 'я за sqlite')
      if (route === 'coordinator_died') store.escalateOpenQuestions(g.id)
      if (!workerLive) store.ptyExited('pty_w', 0)
      const [request] = pending(store, g.id)
      return { store, g, task, request }
    }
  }
}

const SOURCES: Source[] = [
  questionSource('ask без координатора, воркер жив', false, true, 'ask'),
  questionSource('ask без координатора, воркер умер', false, false, 'ask'),
  questionSource('forward живым координатором, воркер жив', true, true, 'forward'),
  questionSource('forward живым координатором, воркер умер', true, false, 'forward'),
  questionSource('координатор умер (escalateOpenQuestions), воркер жив', true, true, 'coordinator_died'),
  questionSource('координатор умер (escalateOpenQuestions), воркер умер', true, false, 'coordinator_died'),
  {
    name: 'сданный ответ для человека', kind: 'answer', workerLive: false,
    create() {
      const { store, g, task, dispatch } = setup({ answerFor: 'human' })
      store.finishDispatch(dispatch.id, 'суть', [], '# Ответ')
      return { store, g, task, request: pending(store, g.id)[0] }
    }
  },
  {
    name: 'воркер вышел без done', kind: 'escalation', workerLive: false,
    create() {
      const { store, g, task } = setup()
      store.ptyExited('pty_w', 1)
      return { store, g, task, request: pending(store, g.id)[0] }
    }
  }
]

/** Что ждём после решения: колонка подзадачи и единственное событие. */
const EXPECT: Record<ResolutionAction, (workerLive: boolean) => { status: string; event: string }> = {
  answer: (live) => ({ status: live ? 'in_progress' : 'ready', event: 'question_answered' }),
  accept: () => ({ status: 'done', event: 'answer_accepted' }),
  clarify: () => ({ status: 'ready', event: 'answer_clarified' }),
  restart: () => ({ status: 'ready', event: 'request_resolved' }),
  dismiss: () => ({ status: 'ready', event: 'request_resolved' })
}

const RESOLUTION: Record<ResolutionAction, { action: ResolutionAction; optionId?: string; text?: string }> = {
  answer: { action: 'answer', optionId: '1' },
  accept: { action: 'accept', text: 'делаем A' },
  clarify: { action: 'clarify', text: 'подробнее' },
  restart: { action: 'restart' },
  dismiss: { action: 'dismiss' }
}

const ALL_ACTIONS: ResolutionAction[] = ['answer', 'accept', 'clarify', 'restart', 'dismiss']

describe('HumanRequest: таблица переходов', () => {
  for (const src of SOURCES) {
    describe(src.name, () => {
      it(`создаётся pending-запрос ${src.kind}, «Нужен ответ» на обеих досках`, () => {
        const { store, g, task, request } = src.create()
        assert.equal(request.kind, src.kind)
        assert.equal(request.status, 'pending')
        assert.equal(request.taskId, task.id)
        assert.equal(request.runId, g.id)
        assert.equal(pending(store, g.id).length, 1, 'ровно один запрос')
        assertWaiting(store, g.id, task.id, true)
        assert.ok(store.listEvents().some((e) => e.type === 'request_created' && e.payload.requestId === request.id))
      })

      for (const action of REQUEST_ACTIONS[src.kind]) {
        it(`${action}: одна транзакция, одно событие, запрос решён, «Нужен ответ» снят`, () => {
          const { store, g, task, request } = src.create()
          const before = store.listEvents().length
          let commits = 0
          store.subscribe(() => commits++)
          store.resolveRequest(request.id, RESOLUTION[action])
          const expected = EXPECT[action](src.workerLive)
          assert.equal(commits, 1)
          const events = store.listEvents().slice(before)
          assert.deepEqual(events.map((e) => e.type), [expected.event])
          assert.equal(events[0].payload.requestId, request.id)
          const after = store.getRequest(request.id)!
          assert.equal(after.status, 'resolved')
          assert.equal(after.resolution?.action, action)
          assert.ok(after.resolvedAt)
          assert.equal(store.getTask(task.id)!.status, expected.status)
          assert.equal(pending(store, g.id).length, 0)
          assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
          assert.throws(() => store.resolveRequest(request.id, RESOLUTION[action]), /уже решено/)
        })
      }

      it('недопустимые действия — ошибка, запрос остаётся pending', () => {
        const { store, request } = src.create()
        for (const action of ALL_ACTIONS.filter((a) => !REQUEST_ACTIONS[src.kind].includes(a))) {
          assert.throws(() => store.resolveRequest(request.id, RESOLUTION[action]), /недопустимо/)
        }
        assert.equal(store.getRequest(request.id)!.status, 'pending')
      })
    })
  }

  it('координатор жив — вопрос ждёт его: запроса нет, подзадача в работе', () => {
    const { store, g, task, dispatch } = setup()
    store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?' }, { coordinatorAlive: true })
    assertWaiting(store, g.id, task.id, false)
    assert.equal(store.getTask(task.id)!.status, 'in_progress')
    const e = store.listEvents().find((x) => x.type === 'question')!
    assert.equal('forHuman' in e.payload, false)
    assert.equal(store.listEvents().some((x) => x.type === 'request_created'), false)
  })

  it('forceHuman (этап «Вопрос человеку»): вопрос человеку даже при живом координаторе, нода этапа — в вопросе и запросе', () => {
    const { store, g, task, dispatch } = setup()
    const wf: Workflow = {
      version: WORKFLOW_VERSION,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'ask', type: 'ask', instructions: 'Спроси', x: 0, y: 0 },
        { id: 'end', type: 'end', x: 0, y: 0 }
      ],
      edges: [{ id: 'e1', from: 'start', outcome: 'next', to: 'ask' }, { id: 'e2', from: 'ask', outcome: 'next', to: 'end' }]
    }
    store.enterWork(task.id, { workflow: wf })
    assert.equal(store.getTask(task.id)!.stage!.nodeId, 'ask')
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: 'Какую БД?' }, { coordinatorAlive: true, forceHuman: true })
    assert.equal(q.forHuman, true)
    assert.equal(q.nodeId, 'ask')
    const [request] = pending(store, g.id)
    assert.equal(request.kind, 'question')
    assert.equal(request.nodeId, 'ask')
    assert.equal(request.questionId, q.id)
    assertWaiting(store, g.id, task.id, true)
    assert.equal(store.listEvents().find((x) => x.type === 'question')!.payload.forHuman, true)
    assert.equal(store.listEvents().filter((x) => x.type === 'request_created').length, 1)
    store.resolveRequest(request.id, { action: 'answer', text: 'sqlite' })
    assert.equal(store.getQuestion(q.id)!.answer, 'sqlite')
  })

  it('без forceHuman вопрос обычного воркера не получает nodeId, даже если у задачи есть этап', () => {
    const { store, task, dispatch } = setup()
    store.enterWork(task.id)
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?' }, { coordinatorAlive: true })
    assert.equal(q.nodeId, undefined)
    assert.equal(q.forHuman, undefined)
    assert.equal(store.listRequests().length, 0)
  })

  it('ответ координатора на свой вопрос: запроса не было — событий запроса нет', () => {
    const { store, g, task, dispatch } = setup()
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?' }, { coordinatorAlive: true })
    store.answer(q.id, 'да')
    assert.equal(store.getTask(task.id)!.status, 'in_progress')
    assert.equal(store.listRequests().length, 0)
    assert.equal(store.getGlobalTask(g.id).status, 'in_progress')
  })
})

describe('вопросы: исправления аудита', () => {
  it('ask идемпотентен: повторный вопрос того же запуска возвращает открытый, запрос один', () => {
    const { store, g, task, dispatch } = setup()
    const a = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: 'Какую БД?' })
    const b = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: 'Какую БД взять?' })
    assert.equal(b.id, a.id)
    assert.equal(store.openQuestions().length, 1)
    assert.equal(pending(store, g.id).length, 1)
    assert.equal(store.listEvents().filter((e) => e.type === 'request_created').length, 1)
    store.answer(a.id, 'sqlite')
    // После ответа можно спросить снова.
    assert.notEqual(store.ask({ taskId: task.id, dispatchId: dispatch.id, question: 'Ещё?' }).id, a.id)
  })

  it('второй ответ на вопрос — ошибка; решение запроса после ответа координатора — «уже решено»', () => {
    const { store, g, task, dispatch } = setup()
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?' })
    const [request] = pending(store, g.id)
    store.answer(q.id, 'A')
    assert.equal(store.getRequest(request.id)!.status, 'resolved')
    assert.throws(() => store.answer(q.id, 'B'), /уже ответили: A/)
    assert.throws(() => store.resolveRequest(request.id, { action: 'answer', text: 'B' }), /уже решено/)
    assert.equal(store.getQuestion(q.id)!.answer, 'A')
    assertWaiting(store, g.id, task.id, false)
  })

  it('спрашивать может только текущий живой запуск; done не сдвигается', () => {
    const { store, task, dispatch } = setup()
    store.finishDispatch(dispatch.id, 'сделал')
    assert.throws(() => store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?' }), /текущий живой запуск/)
    store.acceptTask(task.id)
    assert.throws(() => store.ask({ taskId: task.id, question: '?' }), /уже сделана/)
    assert.equal(store.getTask(task.id)!.status, 'done')
    const other = setup()
    const old = other.dispatch
    other.store.closeDispatches(other.task.id)
    const fresh = other.store.startDispatch(other.task.id, 'pty_w2')
    assert.throws(() => other.store.ask({ taskId: other.task.id, dispatchId: old.id, question: '?' }), /текущий живой запуск/)
    assert.ok(other.store.ask({ taskId: other.task.id, dispatchId: fresh.id, question: '?' }))
  })

  it('варианты: строки → RequestOption, ответ вариантом — его метка, неизвестный вариант — ошибка', () => {
    const { store, g, task, dispatch } = setup()
    const q = store.ask({
      taskId: task.id, dispatchId: dispatch.id, question: 'БД?',
      options: [{ id: 'sqlite', label: 'SQLite, без сервера', hint: 'проще', recommended: true }, 'postgres'],
      context: 'нужен шаринг?'
    })
    assert.deepEqual(q.options, [{ id: 'sqlite', label: 'SQLite, без сервера', hint: 'проще', recommended: true }, { id: '2', label: 'postgres' }])
    const [request] = pending(store, g.id)
    assert.deepEqual(request.options, q.options)
    assert.equal(request.body, 'нужен шаринг?')
    assert.throws(() => store.resolveRequest(request.id, { action: 'answer', optionId: 'mysql' }), /варианта/)
    assert.throws(() => store.resolveRequest(request.id, { action: 'answer', text: '  ' }), /вариант или текст/)
    store.resolveRequest(request.id, { action: 'answer', optionId: 'sqlite', text: 'версии 3' })
    assert.equal(store.getQuestion(q.id)!.answer, 'SQLite, без сервера — версии 3')
    assert.deepEqual(store.getRequest(request.id)!.resolution, { action: 'answer', optionId: 'sqlite', text: 'версии 3' })
  })

  it('варианты: повтор id и пустая метка — ошибка', () => {
    const { store, task, dispatch } = setup()
    assert.throws(() => store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?', options: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] }), /повторяется/)
    assert.throws(() => store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?', options: [' '] }), /пустая метка/)
  })

  it('forward: заметка координатора в теле запроса, повторный forward — без второго запроса', () => {
    const { store, g, task, dispatch } = setup()
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?', context: 'контекст' }, { coordinatorAlive: true })
    store.forwardQuestion(q.id, 'моё мнение: sqlite')
    store.forwardQuestion(q.id, 'ещё раз')
    const requests = pending(store, g.id)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body, 'контекст\n\n**Координатор:** моё мнение: sqlite')
    assert.equal(requests[0].questionId, q.id)
  })

  it('escalateOpenQuestions: только вопросы координатору текущих запусков этого прогона', () => {
    const { store, g, task, dispatch } = setup()
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?' }, { coordinatorAlive: true })
    const other = store.createGlobalTask({ title: 'G2' })
    const t2 = store.createTask({ title: 't2', runId: other.id })
    store.ask({ taskId: t2.id, question: '?' }, { coordinatorAlive: true })
    const created = store.escalateOpenQuestions(g.id)
    assert.deepEqual(created.map((r) => r.questionId), [q.id])
    assert.deepEqual(store.escalateOpenQuestions(g.id), [], 'повторно — ничего')
    assert.equal(store.getGlobalTask(other.id).status === 'needs_input', false)
    assert.throws(() => store.escalateOpenQuestions('run_none'), /not found/)
  })
})

describe('ответ для человека: исправления аудита', () => {
  it('«Уточнить» через rejectReview — тот же переход: запрос решён, answer_clarified', () => {
    const { store, g, task, dispatch } = setup({ answerFor: 'human' })
    store.finishDispatch(dispatch.id, 'суть', [], 'ответ')
    const [request] = pending(store, g.id)
    store.rejectReview(task.id, '  подробнее  ')
    assert.equal(store.getRequest(request.id)!.status, 'resolved')
    assert.deepEqual(store.getRequest(request.id)!.resolution, { action: 'clarify', text: 'подробнее' })
    const e = store.listEvents().at(-1)!
    assert.equal(e.type, 'answer_clarified')
    assert.deepEqual(Object.keys(e.payload), ['taskId', 'feedback', 'requestId', 'dispatchId'])
    assert.equal(store.getTask(task.id)!.feedback, 'подробнее')
    assertWaiting(store, g.id, task.id, false)
  })

  it('«Принять» — только если последний запуск сдал ответ (перезапуск после уточнения упал)', () => {
    const { store, g, task, dispatch } = setup({ answerFor: 'human' })
    store.finishDispatch(dispatch.id, 'суть', [], 'ответ')
    store.resolveRequest(pending(store, g.id)[0].id, { action: 'clarify', text: 'подробнее' })
    store.startDispatch(task.id, 'pty_w2')
    store.ptyExited('pty_w2', 1)
    const [escalation] = pending(store, g.id)
    assert.equal(escalation.kind, 'escalation', 'упавший воркер — эскалация, а не «ответ готов»')
    assert.throws(() => store.assertAnswerAcceptable(task.id), /не сдал ответ/)
    assert.throws(() => store.acceptTask(task.id), /не сдал ответ/)
    assert.notEqual(store.getTask(task.id)!.status, 'done')
    assert.equal(store.listEvents().some((e) => e.type === 'answer_accepted'), false)
  })

  it('accept через resolveRequest: задача в done, ветка забыта, answer_accepted раньше run_done', () => {
    const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
    const g = store.createGlobalTask({ title: 'G' })
    const task = store.createTask({ title: 't', runId: g.id, answerFor: 'human' })
    const d = store.startDispatch(task.id, 'pty_w')
    store.updateTask(task.id, { worktree: '/wt', branch: 'orca/t' })
    store.finishDispatch(d.id, 'суть', [], 'ответ')
    store.resolveRequest(pending(store, g.id)[0].id, { action: 'accept', text: 'делаем A' })
    const t = store.getTask(task.id)!
    assert.equal(t.status, 'done')
    assert.equal(t.worktree, undefined)
    assert.equal(t.branch, undefined)
    assert.deepEqual(store.listEvents().slice(-2).map((e) => e.type), ['answer_accepted', 'run_done'])
    assert.equal(store.taskAnswer(task.id).decision, 'делаем A')
  })

  it('acceptTask (старый путь main) закрывает pending-запрос answer', () => {
    const { store, g, task, dispatch } = setup({ answerFor: 'human' })
    store.finishDispatch(dispatch.id, 'суть', [], 'ответ')
    const [request] = pending(store, g.id)
    store.acceptTask(task.id, 'ok')
    assert.deepEqual(store.getRequest(request.id)!.resolution, { action: 'accept', text: 'ok' })
    assertWaiting(store, g.id, task.id, false)
  })

  it('события: worker_done с requestId до ответа, request_created после worker_done и без тела', () => {
    const { store, dispatch } = setup({ answerFor: 'human' })
    store.finishDispatch(dispatch.id, 'x'.repeat(EVENT_TITLE_LIMIT + 50), [], 'большой ответ')
    const [done, created] = store.listEvents().slice(-2)
    assert.equal(done.type, 'worker_done')
    assert.equal(created.type, 'request_created')
    assert.equal(done.payload.requestId, created.payload.requestId)
    assert.deepEqual(Object.keys(created.payload), ['taskId', 'requestId', 'kind', 'title', 'runId', 'dispatchId'])
    assert.equal((created.payload.title as string).length, EVENT_TITLE_LIMIT)
    assert.equal(store.getRequest(created.payload.requestId as string)!.body, 'большой ответ')
  })
})

describe('эскалация и отмена запросов', () => {
  it('воркер упал, пока ждал ответа человека, — отдельной эскалации нет, ответ вернёт задачу в ready', () => {
    const { store, g, task, dispatch } = setup()
    store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?' })
    store.ptyExited('pty_w', 1)
    assert.deepEqual(pending(store, g.id).map((r) => r.kind), ['question'])
    assert.ok(store.listEvents().some((e) => e.type === 'escalation'), 'координатор всё равно узнаёт о падении')
  })

  it('перезапуск воркера отменяет эскалацию и запросы прошлого запуска', () => {
    const { store, g, task } = setup()
    store.ptyExited('pty_w', 1)
    const [request] = pending(store, g.id)
    store.startDispatch(task.id, 'pty_w2')
    assert.equal(store.getRequest(request.id)!.status, 'cancelled')
    assertWaiting(store, g.id, task.id, false)
    assert.throws(() => store.resolveRequest(request.id, { action: 'restart' }), /уже решено/)
  })

  it('перенос глобальной задачи в done вручную отменяет её pending-запросы', () => {
    const { store, g, task, dispatch } = setup()
    store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?' })
    const other = store.createGlobalTask({ title: 'G2' })
    const t2 = store.createTask({ title: 't2', runId: other.id })
    store.ask({ taskId: t2.id, question: '?' })
    store.moveGlobalTask(g.id, 'done')
    assert.equal(pending(store, g.id).length, 0)
    assert.equal(store.listRequests().find((r) => r.runId === g.id)!.status, 'cancelled')
    assert.equal(pending(store, other.id).length, 1, 'чужие запросы не трогаются')
  })

  it('подзадача в done (руками) — её запросы отменены', () => {
    const { store, g, task } = setup()
    store.ptyExited('pty_w', 1)
    store.moveTask(task.id, 'done')
    assert.equal(pending(store, g.id).length, 0)
  })

  it('удаление задачи и глобальной задачи удаляет их запросы', () => {
    const { store, g, task } = setup()
    store.ptyExited('pty_w', 1)
    store.deleteTask(task.id)
    assert.equal(store.listRequests().length, 0)
    const b = setup()
    b.store.ptyExited('pty_w', 1)
    b.store.deleteGlobalTask(b.g.id, { cascade: true })
    assert.equal(b.store.listRequests().length, 0)
    void g
  })
})

describe('загрузка снапшота', () => {
  function reload(snap: Partial<StoreSnapshot>): { loaded: TaskStore; saved: number } {
    let saved = 0
    const loaded = new TaskStore({ load: () => snap, save: () => void saved++ }, () => DEFAULT_COLUMNS)
    return { loaded, saved }
  }

  it('координаторов после перезапуска нет: их открытые вопросы уходят человеку (без событий)', () => {
    const { store, g, task, dispatch } = setup()
    const q = store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?' }, { coordinatorAlive: true })
    const events = store.listEvents().length
    const { loaded, saved } = reload(store.snapshot())
    const [request] = pending(loaded, g.id)
    assert.equal(request.questionId, q.id)
    assert.equal(loaded.listEvents().length, events)
    assert.equal(saved, 1)
    assertWaiting(loaded, g.id, task.id, true)
    loaded.resolveRequest(request.id, { action: 'answer', text: 'да' })
    assert.equal(loaded.getTask(task.id)!.status, 'ready', 'воркер после перезапуска мёртв')
  })

  it('решённые и отменённые запросы не пересоздаются', () => {
    const { store, g, task, dispatch } = setup()
    store.ask({ taskId: task.id, dispatchId: dispatch.id, question: '?' })
    store.startDispatch(task.id, 'pty_w2') // отменяет запрос, вопрос остаётся открытым
    const { loaded } = reload(store.snapshot())
    assert.equal(pending(loaded, g.id).length, 0)
  })

  it('старый снапшот: forHuman-вопросы, вопросы «Входящих», ответы в needs_input/review и эскалации → pending-запросы', () => {
    const now = Date.now()
    const snap = {
      runs: [
        { id: 'run_a', objective: 'A', status: 'in_progress', coordinatorPtyId: 'pty_c', createdAt: now },
        { id: 'run_i', objective: '', inbox: true, status: 'in_progress', createdAt: now }
      ],
      tasks: [
        { id: 't_q', title: 'q', spec: '', status: 'needs_input', deps: [], roleId: 'developer', agent: 'claude', runId: 'run_a', dispatchId: 'd_q', createdAt: now, updatedAt: now },
        { id: 't_ans', title: 'ans', spec: '', status: 'review', deps: [], roleId: 'developer', agent: 'claude', runId: 'run_a', answerFor: 'human', dispatchId: 'd_ans', createdAt: now, updatedAt: now },
        { id: 't_esc', title: 'esc', spec: '', status: 'needs_input', deps: [], roleId: 'developer', agent: 'claude', runId: 'run_a', dispatchId: 'd_esc', createdAt: now, updatedAt: now },
        { id: 't_in', title: 'in', spec: '', status: 'needs_input', deps: [], roleId: 'developer', agent: 'claude', runId: 'run_i', createdAt: now, updatedAt: now },
        { id: 't_empty', title: 'empty', spec: '', status: 'needs_input', deps: [], roleId: 'developer', agent: 'claude', runId: 'run_a', createdAt: now, updatedAt: now }
      ],
      dispatches: [
        { id: 'd_q', taskId: 't_q', ptyId: 'p1', startedAt: now, endedAt: now, outcome: 'unknown' },
        { id: 'd_ans', taskId: 't_ans', ptyId: 'p2', startedAt: now, endedAt: now, outcome: 'done', summary: 'суть', answer: '# A' },
        { id: 'd_esc', taskId: 't_esc', ptyId: 'p3', startedAt: now, endedAt: now, outcome: 'failed' }
      ],
      questions: [
        { id: 'q_1', taskId: 't_q', dispatchId: 'd_q', question: 'БД?', options: ['sqlite', 'pg'], forHuman: true, createdAt: now },
        { id: 'q_2', taskId: 't_in', question: 'Входящие?', options: [], createdAt: now }
      ],
      events: []
    } as unknown as Partial<StoreSnapshot>
    const { loaded, saved } = reload(snap)
    const byTask = Object.fromEntries(pending(loaded).map((r) => [r.taskId, r]))
    assert.deepEqual(Object.keys(byTask).sort(), ['t_ans', 't_esc', 't_in', 't_q'])
    assert.equal(byTask.t_q.kind, 'question')
    assert.deepEqual(byTask.t_q.options, [{ id: '1', label: 'sqlite' }, { id: '2', label: 'pg' }])
    assert.deepEqual(loaded.getQuestion('q_1')!.options, byTask.t_q.options)
    assert.equal(byTask.t_ans.kind, 'answer')
    assert.equal(byTask.t_ans.title, 'суть')
    assert.equal(loaded.getTask('t_ans')!.status, 'needs_input')
    assert.equal(byTask.t_esc.kind, 'escalation')
    assert.equal(byTask.t_in.kind, 'question')
    assert.equal(loaded.getTask('t_empty')!.status, 'ready', 'ждать нечего — обратно в поток')
    assert.equal(loaded.getGlobalTask('run_a').status, 'needs_input')
    assert.equal(loaded.getGlobalTask('run_a').waiting, 3)
    assert.equal(saved, 1)
    // Повторная загрузка уже мигрированного снапшота ничего не меняет.
    const again = reload(loaded.snapshot())
    assert.equal(again.saved, 0)
    assert.equal(pending(again.loaded).length, 4)
  })
})

describe('доставка событий координатору', () => {
  it('releaseEvents возвращает недоставленные события в непрочитанные', () => {
    const { store, g, task } = setup()
    store.escalate(task.id, 'воркер не запустился', { requestId: 'req_x' })
    const first = store.consumeEvents(['escalation'], g.id, g.id)
    assert.equal(first.length, 1)
    assert.deepEqual(store.consumeEvents(['escalation'], g.id, g.id), [])
    store.releaseEvents(first.map((e) => e.id))
    const again = store.consumeEvents(['escalation'], g.id, g.id)
    assert.deepEqual(again.map((e) => e.id), first.map((e) => e.id))
    assert.equal(again[0].payload.requestId, 'req_x')
  })

  it('markStuck помечает эскалацию stuck — по ней уведомление человеку', () => {
    const { store, dispatch } = setup()
    store.markStuck(dispatch.id, 20 * 60_000)
    assert.equal(store.listEvents().find((e) => e.type === 'escalation')!.payload.stuck, true)
  })
})
