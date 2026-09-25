// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Состояние воркфлоу в store: снимок графа в прогоне, advanceStage, миграция задач в ревью, рестарт.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { STATUS_HISTORY_LIMIT } from './status-history.ts'
import { TaskStore, EVENT_ANSWER_LIMIT, type Persistence, type StoreSnapshot } from './store.ts'
import { DEFAULT_COLUMNS } from './types.ts'
import {
  WORKFLOW_VERSION, WORKFLOW_VERSION_TASK_SCOPE, defaultSubflow, defaultWorkflow, legacyDefaultWorkflow, describeWorkflow, legacyPipelineWorkflow,
  type WfSubflow, type Workflow
} from './workflow.ts'
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
  const wf = legacyDefaultWorkflow([{ id: 'reviewer' }])
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
    const wf = legacyDefaultWorkflow([{ id: 'reviewer' }])
    const run = s.createRun('цель', undefined, wf)
    wf.nodes[0].title = 'изменили'
    wf.edges.pop()
    const saved = s.getRun(run.id)!.workflow!
    assert.deepEqual(saved, legacyDefaultWorkflow([{ id: 'reviewer' }]))
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
    assert.deepEqual(s.runWorkflow(run.id), legacyDefaultWorkflow([]))
    assert.deepEqual(s.runWorkflow(run.id, ['developer', 'reviewer']), legacyDefaultWorkflow([{ id: 'reviewer' }]))
    assert.deepEqual(s.runWorkflow(undefined), legacyDefaultWorkflow([]))
  })
})

describe('тип задачи в прогоне', () => {
  const docs: TaskType = {
    id: 'type_docs',
    title: 'Документация',
    settings: {
      roles: [{ id: 'writer', title: 'Автор', agent: 'claude' }],
      agentRules: 'Пиши по-русски.',
      workflow: legacyPipelineWorkflow([{ type: 'human', id: 'eyes', title: 'Глазами' }])
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
    const eyes = s.createRun('доки', undefined, runTypeInput(presetTaskType('docs')!))
    assert.deepEqual(s.enterRunStage(review.id).action, { type: 'start_stage', nodeId: 'work', roleIds: [] })
    assert.deepEqual(s.enterRunStage(eyes.id).action, { type: 'start_stage', nodeId: 'work', roleIds: ['writer'] })
    assert.deepEqual(s.advanceRunStage(review.id, 'next').action, { type: 'create_gate', nodeId: 'review', roleId: 'reviewer' })
    assert.deepEqual(s.advanceRunStage(eyes.id, 'next').action, { type: 'request_human', nodeId: 'review' })
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
    const { s, run, task } = setup(legacyDefaultWorkflow([{ id: 'reviewer' }]))
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
    const { s, task } = setup(legacyDefaultWorkflow([{ id: 'reviewer' }]))
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
    const { s, task } = setup(legacyDefaultWorkflow([{ id: 'reviewer' }]))
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
    const run = s.createRun('цель', undefined, legacyDefaultWorkflow([{ id: 'reviewer' }]))
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
    const run = s.createRun('цель', undefined, legacyDefaultWorkflow([{ id: 'reviewer' }]))
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
    const run = s.createRun('цель', undefined, legacyDefaultWorkflow([{ id: 'reviewer' }]))
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

  it('enterWork: этап «Вопрос человеку» не сбрасывается, taskWorkStage и taskStageNode отдают его', () => {
    const s = store()
    const wf: Workflow = {
      version: WORKFLOW_VERSION_TASK_SCOPE,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'ask', type: 'ask', roleId: 'analyst', title: 'Уточнить', instructions: 'Спроси про БД', x: 0, y: 0 },
        { id: 'work', type: 'work', x: 0, y: 0 },
        { id: 'end', type: 'end', x: 0, y: 0 }
      ],
      edges: [
        { id: 'e1', from: 'start', outcome: 'next', to: 'ask' },
        { id: 'e2', from: 'ask', outcome: 'next', to: 'work' },
        { id: 'e3', from: 'work', outcome: 'next', to: 'end' }
      ]
    }
    const run = s.createRun('цель', undefined, wf)
    const t = s.createTask({ title: 'A', runId: run.id })
    assert.equal(s.taskStageNode(t.id), undefined, 'без этапа ноды нет')
    assert.deepEqual(s.enterWork(t.id), { type: 'start_worker', nodeId: 'ask', roleId: 'analyst' }, 'первый заход — сразу в ask')
    assert.equal(s.enterWork(t.id), undefined, 'повторный старт агента (автоперезапуск) этап не сбрасывает')
    assert.equal(s.getTask(t.id)!.stage!.nodeId, 'ask')
    assert.deepEqual(s.getTask(t.id)!.stage!.visits, { start: 1, ask: 1 }, 'заходы не растут')
    assert.equal(s.taskStageNode(t.id)?.type, 'ask')
    assert.deepEqual(s.taskWorkStage(t.id), { nodeId: 'ask', type: 'ask', title: 'Уточнить', roleId: 'analyst', instructions: 'Спроси про БД' })
    assert.equal(s.listEvents().filter((e) => e.type === 'stage_changed' && e.payload.outcome === 'restart').length, 0)
    s.advanceStage(t.id, 'next')
    assert.equal(s.taskWorkStage(t.id)!.type, 'work')
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
    const wf = legacyPipelineWorkflow([{ type: 'human', id: 'pick', title: 'Выбрать вариант' }])
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

describe('путь подзадачи: подзадача прогона ходит по графу ноды «Работа»', () => {
  const opts = { roleIds: ['developer', 'reviewer'] }
  /** Путь «работа → проверка агентом → мерж»: отказ — в работу. */
  const reviewPath = (): WfSubflow => ({
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'impl', type: 'work', instructions: 'внутри пути', x: 0, y: 0 },
      { id: 'rev', type: 'gate', roleId: 'reviewer', x: 0, y: 0 },
      { id: 'merge', type: 'merge', x: 0, y: 0 },
      { id: 'conflict', type: 'human', title: 'Конфликт мержа', x: 0, y: 0 },
      { id: 'end', type: 'end', merged: true, x: 0, y: 0 }
    ],
    edges: [
      { id: 'e1', from: 'start', outcome: 'next', to: 'impl' },
      { id: 'e2', from: 'impl', outcome: 'next', to: 'rev' },
      { id: 'e3', from: 'rev', outcome: 'accept', to: 'merge' },
      { id: 'e4', from: 'rev', outcome: 'reject', to: 'impl' },
      { id: 'e5', from: 'merge', outcome: 'ok', to: 'end' },
      { id: 'e6', from: 'merge', outcome: 'conflict', to: 'conflict' },
      { id: 'e7', from: 'conflict', outcome: 'accept', to: 'merge' },
      { id: 'e8', from: 'conflict', outcome: 'reject', to: 'impl' }
    ]
  })
  /** Прогон «Работа → человек → конец» с начатым графом; `subflow` — путь «Работы» (нет — по умолчанию). */
  function started(subflow?: WfSubflow, p?: Persistence) {
    const s = store(p)
    const wf = defaultWorkflow([{ id: 'developer' }])
    const work = wf.nodes.find((n) => n.id === 'work')!
    work.type === 'work' && Object.assign(work, { instructions: 'снаружи', showcase: { what: 'макеты', required: true } })
    if (subflow) Object.assign(work, { subflow })
    const run = s.createRun('цель', undefined, wf)
    s.setRunPty(run.id, 'pty_c', 'claude')
    s.enterRunStage(run.id, opts)
    const task = s.createTask({ title: 'Подзадача', runId: run.id, roleId: 'developer' })
    return { s, run, task }
  }
  const events = (s: TaskStore, type: string) => s.listEvents().filter((e) => e.type === type)

  it('taskWorkflow: путь ноды или путь по умолчанию; вне пути — граф прогона', () => {
    const { s, task } = started()
    const path = s.taskWorkflow(s.getTask(task.id)!)
    assert.equal(path.version, WORKFLOW_VERSION)
    assert.deepEqual({ nodes: path.nodes, edges: path.edges }, defaultSubflow())

    const own = started(reviewPath())
    const ownPath = own.s.taskWorkflow(own.s.getTask(own.task.id)!)
    assert.deepEqual(ownPath.nodes.map((n) => n.id), reviewPath().nodes.map((n) => n.id))

    // Задача старого движка и «Входящие» — граф прогона, как runWorkflow.
    const legacy = store()
    const old = legacy.createRun('старый', undefined, legacyDefaultWorkflow([]))
    const t = legacy.createTask({ title: 'A', runId: old.id })
    assert.deepEqual(legacy.taskWorkflow(legacy.getTask(t.id)!), legacy.runWorkflow(old.id))
    const orphan = legacy.createTask({ title: 'Во «Входящих»' })
    assert.deepEqual(legacy.taskWorkflow(legacy.getTask(orphan.id)!), legacy.runWorkflow(orphan.runId))
  })

  it('advanceStage ведёт подзадачу по пути: вход, проверка, отказ, мерж, конец; позиция прогона не двигается', () => {
    const { s, run, task } = started(reviewPath())
    const before = structuredClone(s.getRun(run.id)!.stage)

    let step = s.advanceStage(task.id, 'next', opts)
    assert.deepEqual(step.action, { type: 'start_worker', nodeId: 'impl' })
    assert.equal(s.getTask(task.id)!.stage!.nodeId, 'impl')
    assert.equal(events(s, 'stage_changed').at(-1)!.payload.taskId, task.id)
    assert.equal(events(s, 'stage_changed').at(-1)!.payload.to, 'impl')

    step = s.advanceStage(task.id, 'next', opts)
    assert.deepEqual(step.action, { type: 'create_gate', nodeId: 'rev', roleId: 'reviewer' })
    step = s.advanceStage(task.id, 'reject', opts)
    assert.deepEqual(step.action, { type: 'start_worker', nodeId: 'impl' })
    assert.equal(s.getTask(task.id)!.stage!.visits.impl, 2)
    s.advanceStage(task.id, 'next', opts)
    step = s.advanceStage(task.id, 'accept', opts)
    assert.deepEqual(step.action, { type: 'merge', nodeId: 'merge' })
    step = s.advanceStage(task.id, 'ok', opts)
    assert.deepEqual(step.action, { type: 'done', nodeId: 'end', merged: true })

    assert.deepEqual(s.getRun(run.id)!.stage, before, 'Run.stage независим от Task.stage')
    assert.deepEqual(s.getTask(task.id)!.stageHistory!.map((h) => h.nodeId), ['impl', 'rev', 'impl', 'rev', 'merge', 'end'])
    assert.equal(s.getTask(task.id)!.stageOf!.nodeId, 'work', 'stageOf по-прежнему указывает на «Работу» прогона')
  })

  it('без subflow — путь по умолчанию: работа → мерж → конец, конфликт — человеку', () => {
    const { s, task } = started()
    assert.deepEqual(s.advanceStage(task.id, 'next', opts).action, { type: 'start_worker', nodeId: 'work' })
    assert.deepEqual(s.advanceStage(task.id, 'next', opts).action, { type: 'merge', nodeId: 'merge' })
    assert.deepEqual(s.advanceStage(task.id, 'conflict', opts).action, { type: 'request_human', nodeId: 'conflict' })
    assert.deepEqual(s.advanceStage(task.id, 'reject', opts).action, { type: 'start_worker', nodeId: 'work' })
    s.advanceStage(task.id, 'next', opts)
    assert.deepEqual(s.advanceStage(task.id, 'ok', opts).action, { type: 'done', nodeId: 'end', merged: true })
  })

  it('«Вопрос человеку» в пути — blocked с событием (граф с ask в пути отвергает валидация, но исполнитель не падает)', () => {
    const path = reviewPath()
    path.nodes.push({ id: 'q', type: 'ask', roleId: 'developer', instructions: 'вопрос', x: 0, y: 0 })
    path.edges = path.edges.map((e) => (e.id === 'e2' ? { ...e, to: 'q' } : e))
    path.edges.push({ id: 'eq', from: 'q', outcome: 'next', to: 'rev' })
    const { s, task } = started(path)
    s.advanceStage(task.id, 'next', opts)
    const step = s.advanceStage(task.id, 'next', opts)
    assert.equal(step.action.type, 'blocked')
    assert.equal(events(s, 'workflow_blocked').at(-1)!.payload.nodeId, 'q')
  })

  it('enterWork: первый вход — путь; на «Работе» пути — ничего; с проверки — назад в работу с копящимися заходами', () => {
    const { s, task } = started(reviewPath())
    assert.deepEqual(s.enterWork(task.id, opts), { type: 'start_worker', nodeId: 'impl' })
    assert.equal(s.getTask(task.id)!.stage!.nodeId, 'impl')
    assert.equal(s.enterWork(task.id, opts), undefined, 'уже на «Работе» пути')
    s.advanceStage(task.id, 'next', opts)
    assert.equal(s.getTask(task.id)!.stage!.nodeId, 'rev')
    assert.deepEqual(s.enterWork(task.id, opts), { type: 'start_worker', nodeId: 'impl' })
    assert.equal(s.getTask(task.id)!.stage!.visits.impl, 2)
    assert.equal(events(s, 'stage_changed').at(-1)!.payload.outcome, 'restart')
  })

  it('запрет остаётся: проверки, задачи-ответы и задачи этапа ask, подзадачи вне «Работы»', () => {
    const s = store()
    const wf: Workflow = {
      version: WORKFLOW_VERSION,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'ask', type: 'ask', roleId: 'developer', instructions: 'о чём спросить', x: 0, y: 0 },
        { id: 'work', type: 'work', x: 0, y: 0 },
        { id: 'end', type: 'end', x: 0, y: 0 }
      ],
      edges: [
        { id: 'e1', from: 'start', outcome: 'next', to: 'ask' },
        { id: 'e2', from: 'ask', outcome: 'next', to: 'work' },
        { id: 'e3', from: 'work', outcome: 'next', to: 'end' }
      ]
    }
    const run = s.createRun('цель', undefined, wf)
    s.setRunPty(run.id, 'pty_c', 'claude')
    // Пока граф не начат, подзадачи можно заготовить: к этапу они не привязаны.
    const answer = s.createTask({ title: 'Ответ', runId: run.id, roleId: 'developer', answerFor: 'human' })
    const free = s.createTask({ title: 'Заготовка', runId: run.id, roleId: 'developer' })
    s.enterRunStage(run.id, opts)
    const question = s.createTask({ title: 'Вопросы', runId: run.id, roleId: 'developer', stageOf: { nodeId: 'ask', visit: 1 } })
    assert.throws(() => s.advanceStage(question.id, 'next', opts), /вне этапа «Работа»/)
    assert.equal(s.enterWork(question.id, opts), undefined)
    assert.equal(s.getTask(question.id)!.stage, undefined)
    assert.equal(s.taskWorkflow(s.getTask(question.id)!), s.runWorkflow(run.id), 'у задачи этапа ask граф прогона')

    assert.throws(() => s.advanceStage(answer.id, 'next', opts), /задача-ответ/)
    assert.equal(s.enterWork(answer.id, opts), undefined)

    // Подзадача без привязки к «Работе» (stageOf нет) тоже мимо пути.
    assert.throws(() => s.advanceStage(free.id, 'next', opts), /вне этапа «Работа»/)
  })

  it('проверка подзадачи и проверка ветки прогона: advanceStage запрещён по-прежнему', () => {
    const { s, run, task } = started(reviewPath())
    s.advanceStage(task.id, 'next', opts)
    s.advanceStage(task.id, 'next', opts)
    const gate = s.createTask({ title: 'Проверка', runId: run.id, roleId: 'reviewer', gateFor: { taskId: task.id, nodeId: 'rev' } })
    assert.throws(() => s.advanceStage(gate.id, 'next', opts), /проверка задачи/)
    assert.equal(s.enterWork(gate.id, opts), undefined)
    const runGate = s.createTask({ title: 'Ревью ветки', runId: run.id, roleId: 'reviewer', gateFor: { runId: run.id, nodeId: 'review' } })
    assert.throws(() => s.advanceStage(runGate.id, 'next', opts), /проверка глобальной задачи/)
  })

  it('taskWorkStage и taskStageNode: до входа — «Работа» прогона, в пути — нода пути с наследованием инструкций и показа', () => {
    const { s, task } = started(reviewPath())
    const outer = s.taskWorkStage(task.id, opts)!
    assert.equal(outer.nodeId, 'work')
    assert.equal(outer.instructions, 'снаружи')
    assert.equal(s.taskStageNode(task.id, opts)!.id, 'work')

    s.advanceStage(task.id, 'next', opts)
    const inner = s.taskWorkStage(task.id, opts)!
    assert.equal(inner.nodeId, 'impl')
    assert.equal(inner.instructions, 'внутри пути', 'заданное нодой пути перекрывает внешнее')
    assert.deepEqual(inner.showcase, { what: 'макеты', required: true }, 'показ наследуется от внешней «Работы»')
    assert.equal(s.taskStageNode(task.id, opts)!.id, 'impl')

    s.advanceStage(task.id, 'next', opts)
    assert.equal(s.taskWorkStage(task.id, opts), undefined, 'на проверке этапа «Работа» нет')
    assert.equal(s.taskStageNode(task.id, opts)!.type, 'gate')

    // Путь по умолчанию: у ноды пути своих инструкций нет — действуют внешние.
    const def = started()
    def.s.advanceStage(def.task.id, 'next', opts)
    assert.equal(def.s.taskWorkStage(def.task.id, opts)!.instructions, 'снаружи')

    // Заголовок: путь по умолчанию без title у ноды — название внешней «Работы», а не «Работа».
    assert.equal(def.s.taskWorkStage(def.task.id, opts)!.title, outer.title)
    assert.notEqual(outer.title, 'Работа')
    assert.equal(def.s.taskWorkStage(def.task.id, opts)!.nodeId, 'work')
  })

  it('taskWorkStage: заголовок пути — явный title ноды пути, иначе название внешней «Работы»', () => {
    const before = started()
    const outerTitle = before.s.taskWorkStage(before.task.id, opts)!.title
    assert.equal(outerTitle, 'Реализация')
    before.s.enterWork(before.task.id, opts)
    assert.equal(before.s.taskWorkStage(before.task.id, opts)!.title, outerTitle, 'путь по умолчанию: заголовок не меняется на «Работа»')

    const path = reviewPath()
    Object.assign(path.nodes.find((n) => n.id === 'impl')!, { title: 'Кодинг' })
    const own = started(path)
    assert.equal(own.s.taskWorkStage(own.task.id, opts)!.title, outerTitle)
    own.s.advanceStage(own.task.id, 'next', opts)
    assert.equal(own.s.taskWorkStage(own.task.id, opts)!.title, 'Кодинг', 'явный title ноды пути перекрывает внешний')

    // Нода пути без title при заданном пути: заголовок внешней «Работы».
    const noTitle = started(reviewPath())
    noTitle.s.advanceStage(noTitle.task.id, 'next', opts)
    assert.equal(noTitle.s.taskWorkStage(noTitle.task.id, opts)!.title, outerTitle)
  })

  it('рестарт: Task.stage и Run.stage переживают перезагрузку, путь продолжается', () => {
    const p = memory()
    const first = started(reviewPath(), p)
    first.s.advanceStage(first.task.id, 'next', opts)
    first.s.advanceStage(first.task.id, 'next', opts)
    const runStage = structuredClone(first.s.getRun(first.run.id)!.stage)

    const s2 = store(p)
    const task = s2.getTask(first.task.id)!
    assert.equal(task.stage!.nodeId, 'rev')
    assert.deepEqual(s2.getRun(first.run.id)!.stage, runStage)
    assert.equal(s2.taskWorkflow(task).nodes.some((n) => n.id === 'rev'), true)
    assert.deepEqual(s2.advanceStage(task.id, 'accept', opts).action, { type: 'merge', nodeId: 'merge' })
  })

  it('этап прогона закрывается, когда подзадачи дошли до конца пути (kind=done) — как раньше', () => {
    const { s, run, task } = started()
    s.advanceStage(task.id, 'next', opts)
    s.advanceStage(task.id, 'next', opts)
    s.advanceStage(task.id, 'ok', opts)
    assert.equal(events(s, 'stage_tasks_done').length, 0, 'путь пройден, но задача ещё не в done')
    s.updateTask(task.id, { status: 'done' })
    assert.equal(events(s, 'stage_tasks_done').length, 1)
    assert.notEqual(s.getRun(run.id)!.stageTasksDoneAt, undefined)
  })
})
