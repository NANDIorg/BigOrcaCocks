// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Состояние воркфлоу в store: снимок графа в прогоне, advanceStage, миграция задач в ревью, рестарт.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { STATUS_HISTORY_LIMIT } from './status-history.ts'
import { TaskStore, EVENT_ANSWER_LIMIT, type Persistence, type StoreSnapshot } from './store.ts'
import { DEFAULT_COLUMNS } from './types.ts'
import { defaultWorkflow, describeWorkflow, pipelineWorkflow, type Workflow } from './workflow.ts'
import { presetTaskType, runTypeInput, snapshotTaskType, type TaskType } from './task-types.ts'

/** Хранилище в памяти: снапшот проходит через JSON, как файл на диске. */
function memory(initial?: Partial<StoreSnapshot>): Persistence & { data: Partial<StoreSnapshot> | null } {
  const p = {
    data: initial ? (JSON.parse(JSON.stringify(initial)) as Partial<StoreSnapshot>) : null,
    load: () => p.data,
    save: (s: StoreSnapshot) => { p.data = JSON.parse(JSON.stringify(s)) as StoreSnapshot }
  }
  return p
}

const store = (p?: Persistence) => new TaskStore(p, () => DEFAULT_COLUMNS)

/** Дефолт с ролью reviewer плюс лимит: третий заход в работу уходит человеку. */
function withLimit(): Workflow {
  const wf = defaultWorkflow([{ id: 'reviewer' }])
  wf.nodes.push(
    { id: 'limit', type: 'condition', test: { kind: 'attempts', node: 'work', atLeast: 3 }, x: 0, y: 0 },
    { id: 'boss', type: 'human', x: 0, y: 0 }
  )
  wf.edges = wf.edges.map((e) => (e.id === 'e_review_reject' ? { ...e, to: 'limit' } : e))
  wf.edges.push(
    { id: 'e_limit_yes', from: 'limit', outcome: 'yes', to: 'boss' },
    { id: 'e_limit_no', from: 'limit', outcome: 'no', to: 'work' },
    { id: 'e_boss_accept', from: 'boss', outcome: 'accept', to: 'merge' },
    { id: 'e_boss_reject', from: 'boss', outcome: 'reject', to: 'work' }
  )
  return wf
}

describe('снимок воркфлоу в прогоне', () => {
  it('createRun хранит копию графа: правка исходника снимок не меняет', () => {
    const s = store()
    const wf = defaultWorkflow([{ id: 'reviewer' }])
    const run = s.createRun('цель', undefined, wf)
    wf.nodes[0].title = 'изменили'
    wf.edges.pop()
    const saved = s.getRun(run.id)!.workflow!
    assert.deepEqual(saved, defaultWorkflow([{ id: 'reviewer' }]))
    assert.deepEqual(s.runWorkflow(run.id), saved)
  })

  it('createGlobalTask тоже снимает граф', () => {
    const s = store()
    const g = s.createGlobalTask({ title: 'Фича', workflow: withLimit() })
    assert.deepEqual(s.getRun(g.id)!.workflow, withLimit())
  })

  it('прогон без снимка читается как дефолтный граф по ролям проекта', () => {
    const s = store()
    const run = s.createRun('цель')
    assert.equal(s.getRun(run.id)!.workflow, undefined)
    assert.deepEqual(s.runWorkflow(run.id), defaultWorkflow([]))
    assert.deepEqual(s.runWorkflow(run.id, ['developer', 'reviewer']), defaultWorkflow([{ id: 'reviewer' }]))
    assert.deepEqual(s.runWorkflow(undefined), defaultWorkflow([]))
  })
})

describe('тип задачи в прогоне', () => {
  const docs: TaskType = {
    id: 'type_docs',
    title: 'Документация',
    settings: {
      roles: [{ id: 'writer', title: 'Автор', agent: 'claude' }],
      agentRules: 'Пиши по-русски.',
      workflow: pipelineWorkflow([{ type: 'human', id: 'eyes', title: 'Глазами' }])
    }
  }

  it('createRun и createGlobalTask пишут typeId, снимок и граф типа — копии', () => {
    const s = store()
    const input = runTypeInput(docs)
    const run = s.createRun('цель', undefined, input)
    const g = s.createGlobalTask({ title: 'Фича', type: input })
    input.snapshot.roles[0].model = 'изменили'
    input.workflow!.nodes.length = 0
    for (const id of [run.id, g.id]) {
      const saved = s.getRun(id)!
      assert.equal(saved.typeId, 'type_docs')
      assert.deepEqual(saved.taskType, snapshotTaskType(docs))
      assert.deepEqual(saved.workflow, docs.settings.workflow)
    }
    assert.equal(g.typeId, 'type_docs')
    assert.equal(g.typeTitle, 'Документация')
  })

  it('тип без графа (граф будущей версии) — прогон без снимка графа', () => {
    const s = store()
    const { workflow: _wf, ...input } = runTypeInput(docs)
    const run = s.createRun('цель', undefined, input)
    assert.equal(s.getRun(run.id)!.typeId, 'type_docs')
    assert.equal(s.getRun(run.id)!.workflow, undefined)
  })

  it('две задачи разных прогонов идут разными графами', () => {
    const s = store()
    const review = s.createRun('код', undefined, runTypeInput(presetTaskType('general')!))
    const eyes = s.createRun('доки', undefined, runTypeInput(docs))
    const a = s.createTask({ title: 'Код', runId: review.id })
    const b = s.createTask({ title: 'Доки', runId: eyes.id })
    for (const t of [a, b]) s.advanceStage(t.id, 'next')
    assert.deepEqual(s.advanceStage(a.id, 'next').action, { type: 'create_gate', nodeId: 'review', roleId: 'reviewer' })
    assert.deepEqual(s.advanceStage(b.id, 'next').action, { type: 'request_human', nodeId: 'eyes' })
  })

  it('прогон без снимка графа идёт по графу типа из fallback, а не по дефолтному', () => {
    const s = store()
    const task = s.createTask({ title: 'Во «Входящих»' })
    const opts = { roleIds: ['writer'], workflow: docs.settings.workflow }
    assert.deepEqual(s.runWorkflow(task.runId, opts), docs.settings.workflow)
    s.enterWork(task.id, opts)
    assert.deepEqual(s.advanceStage(task.id, 'next', opts).action, { type: 'request_human', nodeId: 'eyes' })
  })

  it('assignRunTypes: прогоны без типа получают тип и снимок; inbox, Run.workflow и чужой тип не трогаются; идемпотентна', () => {
    const p = memory()
    const s = store(p)
    const old = s.createRun('старый', undefined, withLimit())
    const bare = s.createRun('до воркфлоу')
    const typed = s.createRun('с типом', undefined, runTypeInput(presetTaskType('backend')!))
    const task = s.createTask({ title: 'Во «Входящих»' })
    const legacy = { typeId: 'type_p1', snapshot: snapshotTaskType(docs) }

    assert.equal(s.assignRunTypes(legacy), 2)
    assert.equal(s.getRun(old.id)!.typeId, 'type_p1')
    assert.deepEqual(s.getRun(old.id)!.taskType, snapshotTaskType(docs))
    assert.deepEqual(s.getRun(old.id)!.workflow, withLimit())
    assert.equal(s.getRun(bare.id)!.typeId, 'type_p1')
    assert.equal(s.getRun(bare.id)!.workflow, undefined)
    assert.equal(s.getRun(typed.id)!.typeId, 'backend')
    const inbox = s.getRun(task.runId!)!
    assert.equal(inbox.inbox, true)
    assert.equal(inbox.typeId, undefined)
    assert.equal(inbox.taskType, undefined)

    const saved = JSON.stringify(p.data)
    assert.equal(s.assignRunTypes(legacy), 0)
    assert.equal(s.assignRunTypes({ typeId: 'type_other', snapshot: snapshotTaskType(docs) }), 0)
    assert.equal(JSON.stringify(p.data), saved)
  })

  it('перезагрузка снапшота сохраняет typeId и снимок типа', () => {
    const p = memory()
    const s = store(p)
    const g = s.createGlobalTask({ title: 'Фича', type: runTypeInput(docs) })
    const reloaded = store(memory(p.data!))
    assert.equal(reloaded.getRun(g.id)!.typeId, 'type_docs')
    assert.deepEqual(reloaded.getRun(g.id)!.taskType, snapshotTaskType(docs))
    assert.deepEqual(reloaded.getRun(g.id)!.workflow, docs.settings.workflow)
    assert.equal(reloaded.getGlobalTask(g.id).typeTitle, 'Документация')
  })
})

describe('advanceStage', () => {
  function setup(wf?: Workflow) {
    const s = store()
    const run = s.createRun('цель', undefined, wf)
    const task = s.createTask({ title: 'Сделай', runId: run.id })
    return { s, run, task }
  }

  it('вход из старта в работу, затем в гейт ревью; события stage_changed', () => {
    const { s, run, task } = setup(defaultWorkflow([{ id: 'reviewer' }]))
    const entered = s.advanceStage(task.id, 'next')
    assert.deepEqual(entered.action, { type: 'start_worker', nodeId: 'work' })
    assert.deepEqual(s.getTask(task.id)!.stage, { nodeId: 'work', visits: { start: 1, work: 1 } })

    const review = s.advanceStage(task.id, 'next')
    assert.deepEqual(review.action, { type: 'create_gate', nodeId: 'review', roleId: 'reviewer' })
    assert.equal(s.getTask(task.id)!.stage!.nodeId, 'review')

    const events = s.listEvents().filter((e) => e.type === 'stage_changed')
    assert.equal(events.length, 2)
    assert.deepEqual(events[0].payload, { taskId: task.id, runId: run.id, to: 'work', outcome: 'next', nodeType: 'work', title: 'Работа' })
    assert.deepEqual(events[1].payload, { taskId: task.id, runId: run.id, from: 'work', to: 'review', outcome: 'next', nodeType: 'gate', title: 'Ревью' })
    assert.equal(events[1].taskId, task.id)
  })

  it('reject возвращает в работу, accept ведёт в мерж; visits копятся', () => {
    const { s, task } = setup(defaultWorkflow([{ id: 'reviewer' }]))
    s.advanceStage(task.id, 'next')
    s.advanceStage(task.id, 'next')
    assert.deepEqual(s.advanceStage(task.id, 'reject').action, { type: 'start_worker', nodeId: 'work' })
    s.advanceStage(task.id, 'next')
    assert.deepEqual(s.advanceStage(task.id, 'accept').action, { type: 'merge', nodeId: 'merge' })
    assert.deepEqual(s.getTask(task.id)!.stage!.visits, { start: 1, work: 2, review: 2, merge: 1 })
    assert.deepEqual(s.advanceStage(task.id, 'ok').action, { type: 'done', nodeId: 'end', merged: true })
  })

  it('лимит повторов через условие attempts', () => {
    const { s, task } = setup(withLimit())
    s.advanceStage(task.id, 'next')
    s.advanceStage(task.id, 'next')
    assert.equal(s.advanceStage(task.id, 'reject').action.type, 'start_worker')
    s.advanceStage(task.id, 'next')
    assert.equal(s.advanceStage(task.id, 'reject').action.type, 'start_worker')
    s.advanceStage(task.id, 'next')
    assert.deepEqual(s.advanceStage(task.id, 'reject').action, { type: 'request_human', nodeId: 'boss' })
  })

  it('исход без перехода: этап не меняется, событие workflow_blocked', () => {
    const { s, task } = setup()
    s.advanceStage(task.id, 'next')
    const before = s.getTask(task.id)!.stage
    const r = s.advanceStage(task.id, 'accept')
    assert.equal(r.action.type, 'blocked')
    assert.deepEqual(s.getTask(task.id)!.stage, before)
    const blocked = s.listEvents().filter((e) => e.type === 'workflow_blocked')
    assert.equal(blocked.length, 1)
    assert.equal(blocked[0].payload.nodeId, 'work')
    assert.match(String(blocked[0].payload.reason), /нет перехода для accept/)
    assert.equal(s.listEvents().filter((e) => e.type === 'stage_changed').length, 1)
  })

  it('роль гейта удалена: этап сменился, но дальше blocked', () => {
    const { s, task } = setup(defaultWorkflow([{ id: 'reviewer' }]))
    s.advanceStage(task.id, 'next', { roleIds: ['developer'] })
    const r = s.advanceStage(task.id, 'next', { roleIds: ['developer'] })
    assert.equal(r.action.type, 'blocked')
    assert.equal(s.getTask(task.id)!.stage!.nodeId, 'review')
    assert.deepEqual(s.listEvents().filter((e) => e.type !== 'task_ready').map((e) => e.type), ['stage_changed', 'stage_changed', 'workflow_blocked'])
  })

  it('прогон без снимка: дефолт по переданным ролям', () => {
    const { s, task } = setup()
    s.advanceStage(task.id, 'next', { roleIds: ['developer'] })
    assert.deepEqual(s.advanceStage(task.id, 'next', { roleIds: ['developer'] }).action, { type: 'request_human', nodeId: 'review' })
  })

  it('задача вне воркфлоу входит только исходом next; ответы и гейты — ошибка', () => {
    const { s, run, task } = setup()
    assert.throws(() => s.advanceStage(task.id, 'accept'), /только исходом next/)
    const answer = s.createTask({ title: 'Разберись', runId: run.id, answerFor: 'human' })
    assert.throws(() => s.advanceStage(answer.id, 'next'), /задача-ответ/)
    const gate = s.createTask({ title: 'Ревью', runId: run.id, roleId: 'reviewer' })
    s.updateTask(gate.id, { gateFor: { taskId: task.id, nodeId: 'review' } })
    assert.throws(() => s.advanceStage(gate.id, 'next'), /проверка задачи/)
    assert.throws(() => s.advanceStage('task_nope', 'next'))
  })

  it('колонку и поведение задачи не меняет — исполнитель выключен', () => {
    const { s, task } = setup()
    const status = s.getTask(task.id)!.status
    s.advanceStage(task.id, 'next')
    s.advanceStage(task.id, 'next')
    assert.equal(s.getTask(task.id)!.status, status)
    // Старые переходы идут как раньше и stage не трогают.
    const d = s.startDispatch(task.id, 'pty_w')
    s.finishDispatch(d.id, 'сделал', [])
    assert.equal(s.getTask(task.id)!.status, 'review')
    s.rejectReview(task.id, 'поправь')
    assert.equal(s.getTask(task.id)!.status, 'ready')
    assert.equal(s.getTask(task.id)!.stage!.nodeId, 'review')
  })
})

describe('миграция и рестарт', () => {
  it('задача в review без stage получает этап ревью дефолтного графа; ответы и гейты — нет', () => {
    const s = store()
    const work = s.createTask({ title: 'Код' })
    const answer = s.createTask({ title: 'Ответ', answerFor: 'coordinator' })
    const gate = s.createTask({ title: 'Ревью', roleId: 'reviewer' })
    const ready = s.createTask({ title: 'Ещё не сдана' })
    s.updateTask(gate.id, { gateFor: { taskId: work.id, nodeId: 'review' } })
    for (const t of [work, answer, gate]) s.moveTask(t.id, 'review')
    const p = memory(s.snapshot())

    const loaded = store(p)
    assert.deepEqual(loaded.getTask(work.id)!.stage, { nodeId: 'review', visits: { start: 1, work: 1, review: 1 } })
    assert.equal(loaded.getTask(answer.id)!.stage, undefined)
    assert.equal(loaded.getTask(gate.id)!.stage, undefined)
    assert.equal(loaded.getTask(ready.id)!.stage, undefined)
    // Миграция сохранена сразу и событий не шлёт.
    assert.deepEqual(p.data!.tasks!.find((t) => t.id === work.id)!.stage!.nodeId, 'review')
    assert.equal(loaded.listEvents().filter((e) => e.type === 'stage_changed').length, 0)
  })

  it('уже заданный stage миграция не трогает', () => {
    const s = store()
    const run = s.createRun('цель', undefined, withLimit())
    const t = s.createTask({ title: 'Код', runId: run.id })
    s.advanceStage(t.id, 'next')
    s.moveTask(t.id, 'review')
    const loaded = store(memory(s.snapshot()))
    assert.deepEqual(loaded.getTask(t.id)!.stage, { nodeId: 'work', visits: { start: 1, work: 1 } })
  })

  it('stage, gateFor и снимок графа переживают рестарт, переходы продолжаются', () => {
    const p = memory()
    const s = store(p)
    const run = s.createRun('цель', undefined, withLimit())
    const t = s.createTask({ title: 'Код', runId: run.id })
    const g = s.createTask({ title: 'Проверка', runId: run.id, roleId: 'reviewer' })
    s.updateTask(g.id, { gateFor: { taskId: t.id, nodeId: 'review' } })
    s.advanceStage(t.id, 'next')
    s.advanceStage(t.id, 'next')

    const loaded = store(p)
    assert.deepEqual(loaded.getRun(run.id)!.workflow, withLimit())
    assert.deepEqual(loaded.getTask(g.id)!.gateFor, { taskId: t.id, nodeId: 'review' })
    assert.deepEqual(loaded.getTask(t.id)!.stage, { nodeId: 'review', visits: { start: 1, work: 1, review: 1 } })
    assert.equal(loaded.advanceStage(t.id, 'reject').action.type, 'start_worker')
    assert.equal(loaded.getTask(t.id)!.stage!.visits.limit, 1)
  })
})

describe('stageHistory', () => {
  const history = (s: TaskStore, id: string) => s.getTask(id)!.stageHistory!.map((e) => [e.nodeId, e.outcome, e.from])
  /** Снапшот «от старого кода»: у задач нет stageHistory. */
  function legacy(s: TaskStore, p: Persistence & { data: Partial<StoreSnapshot> | null }) {
    const snap = s.snapshot()
    for (const t of snap.tasks) delete t.stageHistory
    p.save(snap)
  }

  it('advanceStage и enterWork пишут вход в этап с исходом; reject и restart различимы', () => {
    const s = store()
    const run = s.createRun('цель', undefined, defaultWorkflow([{ id: 'reviewer' }]))
    const t = s.createTask({ title: 'Код', runId: run.id })
    s.advanceStage(t.id, 'next')
    s.advanceStage(t.id, 'next')
    s.advanceStage(t.id, 'reject')
    s.advanceStage(t.id, 'next')
    s.moveTask(t.id, 'review')
    s.enterWork(t.id)
    assert.deepEqual(history(s, t.id), [
      ['work', 'next', undefined], ['review', 'next', 'work'], ['work', 'reject', 'review'],
      ['review', 'next', 'work'], ['work', 'restart', 'review']
    ])
    const first = s.getTask(t.id)!.stageHistory![0]
    assert.equal(first.title, 'Работа')
    assert.equal(first.by, 'app')
  })

  it('этап не сменился — записи нет; задачи-ответы и гейты без истории', () => {
    const s = store()
    const t = s.createTask({ title: 'Код' })
    s.enterWork(t.id)
    s.enterWork(t.id)
    assert.equal(t.stageHistory?.length, 1)
    const ans = s.createTask({ title: 'Q', answerFor: 'human' })
    assert.equal(s.getTask(ans.id)!.stageHistory, undefined)
  })

  it(`хранится не больше ${STATUS_HISTORY_LIMIT} последних`, () => {
    const s = store()
    const run = s.createRun('цель', undefined, defaultWorkflow([{ id: 'reviewer' }]))
    const t = s.createTask({ title: 'Код', runId: run.id })
    s.advanceStage(t.id, 'next')
    for (let i = 0; i < STATUS_HISTORY_LIMIT; i += 1) {
      s.advanceStage(t.id, 'next')
      s.advanceStage(t.id, 'reject')
    }
    const h = s.getTask(t.id)!.stageHistory!
    assert.equal(h.length, STATUS_HISTORY_LIMIT)
    assert.equal(h.at(-1)!.outcome, 'reject')
  })

  it('миграция: история восстанавливается из событий stage_changed', () => {
    const p = memory()
    const s = store(p)
    const run = s.createRun('цель', undefined, defaultWorkflow([{ id: 'reviewer' }]))
    const t = s.createTask({ title: 'Код', runId: run.id })
    s.advanceStage(t.id, 'next')
    s.advanceStage(t.id, 'next')
    s.advanceStage(t.id, 'reject')
    const expected = s.getTask(t.id)!.stageHistory!.map((e) => ({ nodeId: e.nodeId, outcome: e.outcome, from: e.from, title: e.title }))
    legacy(s, p)

    const loaded = store(p)
    const got = loaded.getTask(t.id)!.stageHistory!
    assert.deepEqual(got.map((e) => ({ nodeId: e.nodeId, outcome: e.outcome, from: e.from, title: e.title })), expected)
    assert.ok(got.every((e) => e.migrated === undefined))
    assert.equal(p.data!.tasks!.find((x) => x.id === t.id)!.stageHistory!.length, 3, 'миграция сохранена сразу')
    // Повторная загрузка ничего не дописывает.
    assert.equal(store(p).getTask(t.id)!.stageHistory!.length, 3)
  })

  it('миграция: событий нет — одна запись migrated; без stage поля нет', () => {
    const p = memory()
    const s = store(p)
    const t = s.createTask({ title: 'Код' })
    s.moveTask(t.id, 'review')
    const ans = s.createTask({ title: 'Q', answerFor: 'human' })
    const idle = s.createTask({ title: 'Ещё не в графе' })
    legacy(s, p)

    const loaded = store(p)
    const got = loaded.getTask(t.id)!
    assert.equal(got.stageHistory!.length, 1)
    assert.deepEqual([got.stageHistory![0].nodeId, got.stageHistory![0].migrated, got.stageHistory![0].at], ['review', true, got.updatedAt])
    assert.equal(loaded.getTask(ans.id)!.stageHistory, undefined)
    assert.equal(loaded.getTask(idle.id)!.stageHistory, undefined)
  })

  it('уже записанная история миграцией не трогается', () => {
    const p = memory()
    const s = store(p)
    const t = s.createTask({ title: 'Код' })
    s.enterWork(t.id)
    p.save(s.snapshot())
    assert.deepEqual(history(store(p), t.id), [['work', 'next', undefined]])
  })
})

describe('исполнитель: переходы store', () => {
  const REVIEWER = ['developer', 'reviewer']

  it('enterWork: задача без этапа входит в граф, этап «Работа» не трогается, этап проверки сбрасывается с накоплением заходов', () => {
    const s = store()
    const t = s.createTask({ title: 'A' })
    assert.deepEqual(s.enterWork(t.id, { roleIds: REVIEWER }), { type: 'start_worker', nodeId: 'work' })
    assert.equal(s.getTask(t.id)!.stage!.nodeId, 'work')
    assert.equal(s.enterWork(t.id, { roleIds: REVIEWER }), undefined, 'уже в работе — без изменений')
    s.advanceStage(t.id, 'next', { roleIds: REVIEWER })
    assert.equal(s.getTask(t.id)!.stage!.nodeId, 'review')
    const action = s.enterWork(t.id, { roleIds: REVIEWER })
    assert.equal(action?.type, 'start_worker')
    assert.equal(s.getTask(t.id)!.stage!.nodeId, 'work')
    assert.equal(s.getTask(t.id)!.stage!.visits.work, 2)
    const last = s.listEvents().filter((e) => e.type === 'stage_changed').at(-1)!
    assert.deepEqual([last.payload.from, last.payload.to, last.payload.outcome], ['review', 'work', 'restart'])
  })

  it('enterWork: задачи-ответы и гейты — мимо', () => {
    const s = store()
    const ans = s.createTask({ title: 'Q', answerFor: 'human' })
    const work = s.createTask({ title: 'A' })
    const gate = s.createTask({ title: 'Ревью: A', roleId: 'reviewer', gateFor: { taskId: work.id, nodeId: 'review' } })
    assert.equal(s.enterWork(ans.id), undefined)
    assert.equal(s.enterWork(gate.id), undefined)
    assert.equal(s.getTask(ans.id)!.stage, undefined)
    assert.equal(s.getTask(gate.id)!.stage, undefined)
  })

  it('задача-гейт: task_ready не шлётся, чужая проверяемая задача — ошибка', () => {
    const s = store()
    const work = s.createTask({ title: 'A' })
    const gate = s.createTask({ title: 'Ревью: A', roleId: 'reviewer', gateFor: { taskId: work.id, nodeId: 'review' } })
    assert.equal(s.getTask(gate.id)!.status, 'ready')
    assert.deepEqual(s.listEvents().filter((e) => e.type === 'task_ready').map((e) => e.taskId), [work.id])
    assert.throws(() => s.createTask({ title: 'x', gateFor: { taskId: 'task_nope', nodeId: 'review' } }), /проверяемой задачи task_nope нет/)
    const d = s.startDispatch(gate.id, 'pty')
    s.finishDispatch(d.id, 'принято', [])
    assert.equal(s.listEvents().find((e) => e.type === 'worker_done')!.payload.gateFor, work.id)
  })

  it('approval: запрос с нодой, needs_input; reject — замечания в feedback, request_resolved; повтор не дублирует', () => {
    const s = store()
    const t = s.createTask({ title: 'A' })
    const r = s.requestApproval(t.id, { nodeId: 'review', title: 'Ревью человеком: A', body: 'проверь' })
    assert.equal(s.requestApproval(t.id, { nodeId: 'review', title: 'дубль' }).id, r.id)
    assert.equal(r.kind, 'approval')
    assert.equal(r.nodeId, 'review')
    assert.equal(s.getTask(t.id)!.status, 'needs_input')
    assert.throws(() => s.resolveRequest(r.id, { action: 'clarify', text: 'x' }), /accept, reject/)
    s.resolveRequest(r.id, { action: 'reject', text: 'поправь' })
    assert.equal(s.getRequest(r.id)!.status, 'resolved')
    assert.equal(s.getTask(t.id)!.feedback, 'поправь')
    assert.equal(s.getTask(t.id)!.status, 'ready', 'из «Нужен ответ» — дальше ведёт исполнитель')
    const e = s.listEvents().find((x) => x.type === 'request_resolved')!
    assert.deepEqual([e.payload.kind, e.payload.action, e.payload.nodeId], ['approval', 'reject', 'review'])
  })

  it('approval accept не трогает ответ и ветку: задача не в done, answer_accepted нет', () => {
    const s = store()
    const t = s.createTask({ title: 'A' })
    s.updateTask(t.id, { branch: 'orca/x', worktree: '/wt' })
    const r = s.requestApproval(t.id, { nodeId: 'review', title: 'A' })
    s.resolveRequest(r.id, { action: 'accept' })
    assert.notEqual(s.getTask(t.id)!.status, 'done')
    assert.equal(s.getTask(t.id)!.branch, 'orca/x')
    assert.equal(s.listEvents().some((e) => e.type === 'answer_accepted'), false)
  })

  it('blockStage: workflow_blocked с этапом и причиной', () => {
    const s = store()
    const t = s.createTask({ title: 'A' })
    s.enterWork(t.id)
    s.blockStage(t.id, 'воркер не запустился')
    const e = s.listEvents().find((x) => x.type === 'workflow_blocked')!
    assert.deepEqual([e.taskId, e.payload.nodeId, e.payload.reason], [t.id, 'work', 'воркер не запустился'])
  })
})

describe('показ человеку: finishDispatch и решение approval', () => {
  /** Прогон с графом «Работа (показ) → человек → мерж». */
  function showcaseRun(required: boolean) {
    const s = store()
    const wf = pipelineWorkflow([{ type: 'human', id: 'pick', title: 'Выбрать вариант' }])
    Object.assign(wf.nodes.find((n) => n.id === 'work')!, { title: 'Дизайн', showcase: { what: 'варианты макета', ...(required ? { required } : {}) } })
    const run = s.createRun('цель', undefined, wf)
    const t = s.createTask({ title: 'A', runId: run.id })
    s.enterWork(t.id)
    return { s, t, d: s.startDispatch(t.id, 'pty') }
  }

  it('обязательный показ: done без него — ошибка с подсказкой, dispatch не закрыт', () => {
    const { s, t, d } = showcaseRun(true)
    assert.deepEqual(s.taskWorkStage(t.id), { nodeId: 'work', type: 'work', title: 'Дизайн', showcase: { what: 'варианты макета', required: true } })
    assert.throws(() => s.finishDispatch(d.id, 'готово'), /этап «Дизайн» требует показ человеку: варианты макета[\s\S]*--show-file[\s\S]*--show/)
    assert.equal(s.getDispatch(d.id)!.endedAt, undefined)
    s.finishDispatch(d.id, 'готово', ['a.html'], undefined, { showcase: { text: '# Варианты', files: [' design\\a.html ', 'design/a.html', '', 'design/a.png'] } })
    assert.deepEqual(s.getDispatch(d.id)!.showcase, { text: '# Варианты', files: ['design/a.html', 'design/a.png'] })
  })

  it('необязательный показ и задача вне воркфлоу: done без показа проходит, поля нет', () => {
    const { s, d } = showcaseRun(false)
    assert.equal(s.finishDispatch(d.id, 'готово').showcase, undefined)
    const plain = store()
    const t = plain.createTask({ title: 'B' })
    const d2 = plain.startDispatch(t.id, 'pty')
    assert.equal(plain.taskWorkStage(t.id), undefined)
    assert.equal(plain.finishDispatch(d2.id, 'ok', [], undefined, { showcase: { text: '  ', files: [] } }).showcase, undefined)
  })

  it('файлы показа: абсолютный путь и выход из репозитория — ошибка', () => {
    const { s, d } = showcaseRun(false)
    assert.throws(() => s.finishDispatch(d.id, 'x', [], undefined, { showcase: { files: ['/etc/passwd'] } }), /не абсолютный/)
    assert.throws(() => s.finishDispatch(d.id, 'x', [], undefined, { showcase: { files: ['C:\\x.png'] } }), /не абсолютный/)
    assert.throws(() => s.finishDispatch(d.id, 'x', [], undefined, { showcase: { files: ['a/../../x.png'] } }), /выходить из репозитория/)
  })

  it('approval: текст решения — decision в request_resolved, длинный обрезан; без текста поля нет', () => {
    const s = store()
    const t = s.createTask({ title: 'A' })
    const r1 = s.requestApproval(t.id, { nodeId: 'pick', title: 'A' })
    s.resolveRequest(r1.id, { action: 'accept', text: '  вариант 2  ' })
    let e = s.listEvents().filter((x) => x.type === 'request_resolved').at(-1)!
    assert.equal(e.payload.decision, 'вариант 2')
    assert.equal(Object.keys(e.payload).at(-1), 'decision', 'решение — последним полем')
    const r2 = s.requestApproval(t.id, { nodeId: 'pick', title: 'A' })
    s.resolveRequest(r2.id, { action: 'reject', text: 'x'.repeat(EVENT_ANSWER_LIMIT + 10) })
    e = s.listEvents().filter((x) => x.type === 'request_resolved').at(-1)!
    assert.equal((e.payload.decision as string).length, EVENT_ANSWER_LIMIT)
    assert.equal(e.payload.decisionTruncated, true)
    assert.equal(s.getRequest(r2.id)!.resolution!.text!.length, EVENT_ANSWER_LIMIT + 10, 'полный текст — в запросе')
    const r3 = s.requestApproval(t.id, { nodeId: 'pick', title: 'A' })
    s.resolveRequest(r3.id, { action: 'accept' })
    e = s.listEvents().filter((x) => x.type === 'request_resolved').at(-1)!
    assert.equal('decision' in e.payload, false)
  })
})

describe('describeWorkflow', () => {
  it('этапы в порядке обхода от старта, переходы — названием и id, условие словами', () => {
    const stages = describeWorkflow(withLimit())
    assert.deepEqual(stages.map((x) => x.id), ['start', 'work', 'review', 'merge', 'limit', 'end', 'conflict', 'boss'])
    const review = stages.find((x) => x.id === 'review')!
    assert.deepEqual(review, { id: 'review', type: 'gate', title: 'Ревью', roleId: 'reviewer', next: { accept: 'Мерж (merge)', reject: 'Условие (limit)' } })
    assert.equal(stages.find((x) => x.id === 'limit')!.condition, 'задача заходила в «Работа» не меньше 3 раз')
    assert.match(stages.find((x) => x.id === 'conflict')!.instructions!, /Разрешите конфликт/)
    assert.deepEqual(stages.find((x) => x.id === 'end')!.next, {})
  })
})
