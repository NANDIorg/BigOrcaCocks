// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
// Разветвление графа глобальной задачи в store: позиции путей (`Run.lanes`), барьер `join`, решения по `nodeId`.
// Контракт — docs/workflow.md, «Разветвление».
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, RunApprovalAmbiguousError, type Persistence, type StoreSnapshot } from './store.ts'
import { DEFAULT_COLUMNS, type OrcaEvent } from './types.ts'
import { defaultWorkflow, validateWorkflow, type Workflow } from './workflow.ts'

function memory(): Persistence & { data: Partial<StoreSnapshot> | null } {
  const p = {
    data: null as Partial<StoreSnapshot> | null,
    load: () => p.data,
    save: (s: StoreSnapshot) => { p.data = JSON.parse(JSON.stringify(s)) as StoreSnapshot }
  }
  return p
}

const store = (p?: Persistence) => new TaskStore(p, () => DEFAULT_COLUMNS)
const opts = { roleIds: ['developer', 'reviewer', 'frontend', 'backend'] }
const n = { x: 0, y: 0 }

/**
 * start → «Разветвление» (backend | frontend) → слияние → «Приёмка» (human) → конец; «Вернуть» с приёмки — снова в fork.
 * Путь backend: «API» (work) → «Ревью API» (gate) → «Приёмка API» (human) → слияние; frontend: «UI» (work) → «Макет» (human).
 */
const forkWorkflow: Workflow = {
  version: 2,
  nodes: [
    { id: 'start', type: 'start', ...n },
    { id: 'split', type: 'fork', title: 'Бэк и фронт', branches: [{ id: 'backend', label: 'Бэкенд' }, { id: 'frontend', label: 'Фронтенд' }], ...n },
    { id: 'be', type: 'work', title: 'API', roleIds: ['backend'], ...n },
    { id: 'rev', type: 'gate', title: 'Ревью API', roleId: 'reviewer', ...n },
    { id: 'humBe', type: 'human', title: 'Приёмка API', ...n },
    { id: 'fe', type: 'work', title: 'UI', roleIds: ['frontend'], ...n },
    { id: 'hum', type: 'human', title: 'Макет', ...n },
    { id: 'merge_paths', type: 'join', forkId: 'split', ...n },
    { id: 'check', type: 'human', title: 'Приёмка', ...n },
    { id: 'end', type: 'end', ...n }
  ],
  edges: [
    { id: 'e1', from: 'start', outcome: 'next', to: 'split' },
    { id: 'e2', from: 'split', outcome: 'backend', to: 'be' },
    { id: 'e3', from: 'split', outcome: 'frontend', to: 'fe' },
    { id: 'e4', from: 'be', outcome: 'next', to: 'rev' },
    { id: 'e5', from: 'rev', outcome: 'accept', to: 'humBe' },
    { id: 'e6', from: 'rev', outcome: 'reject', to: 'be' },
    { id: 'e7', from: 'humBe', outcome: 'accept', to: 'merge_paths' },
    { id: 'e8', from: 'humBe', outcome: 'reject', to: 'be' },
    { id: 'e9', from: 'fe', outcome: 'next', to: 'hum' },
    { id: 'e10', from: 'hum', outcome: 'accept', to: 'merge_paths' },
    { id: 'e11', from: 'hum', outcome: 'reject', to: 'fe' },
    { id: 'e12', from: 'merge_paths', outcome: 'next', to: 'check' },
    { id: 'e13', from: 'check', outcome: 'accept', to: 'end' },
    { id: 'e14', from: 'check', outcome: 'reject', to: 'split' }
  ]
}

function forked(p?: Persistence) {
  const s = store(p)
  const run = s.createRun('цель', undefined, forkWorkflow)
  s.setRunPty(run.id, 'pty_c', 'claude')
  const entered = s.enterRunStage(run.id, { ...opts, commit: 'abc' })
  return { s, run, entered }
}

const events = (s: TaskStore, type: OrcaEvent['type']): OrcaEvent[] => s.listEvents().filter((e) => e.type === type)
const finish = (s: TaskStore, taskId: string): void => { s.updateTask(taskId, { status: 'done' }) }

/** Подзадача этапа `stage`, сразу закрытая. */
function doneTask(s: TaskStore, runId: string, stage: string, roleId: string): string {
  const t = s.createTask({ title: `задача ${stage}`, runId, stage, roleId })
  finish(s, t.id)
  return t.id
}

/** Оба пути дошли до своих human: backend — через ревью, frontend — после «Работы». */
function bothOnHuman() {
  const ctx = forked()
  const { s, run } = ctx
  doneTask(s, run.id, 'be', 'backend')
  doneTask(s, run.id, 'fe', 'frontend')
  s.finishStage(run.id, { ...opts, nodeId: 'be', summary: 'API готово' })
  s.advanceRunStage(run.id, 'accept', { ...opts, nodeId: 'rev' })
  s.finishStage(run.id, { ...opts, nodeId: 'fe', summary: 'UI готов' })
  return ctx
}

describe('разветвление: вход в fork', () => {
  it('граф примера валиден', () => {
    const roles = ['reviewer', 'frontend', 'backend'].map((id) => ({ id, title: id, agent: 'claude' as const }))
    assert.deepEqual(validateWorkflow(forkWorkflow, { roles }).errors, [])
  })

  it('Run.stage на fork, по пути на порт, два действия start_stage с lane, stage_started ×2 с lane и laneTitle', () => {
    const { s, run, entered } = forked()
    const r = s.getRun(run.id)!
    assert.equal(r.stage!.nodeId, 'split')
    assert.deepEqual(r.stage!.visits, { start: 1, split: 1, be: 1, fe: 1 })
    assert.deepEqual(r.lanes, [
      { id: 'split:backend', forkId: 'split', branchId: 'backend', forkVisit: 1, nodeId: 'be' },
      { id: 'split:frontend', forkId: 'split', branchId: 'frontend', forkVisit: 1, nodeId: 'fe' }
    ])
    assert.deepEqual(entered.actions, [
      { nodeId: 'be', lane: 'split:backend', action: { type: 'start_stage', nodeId: 'be', roleIds: ['backend'] } },
      { nodeId: 'fe', lane: 'split:frontend', action: { type: 'start_stage', nodeId: 'fe', roleIds: ['frontend'] } }
    ])
    assert.deepEqual(entered.action, entered.actions[0].action)
    // Порядок: вход в fork, затем по каждому пути (в порядке branches) — переход и stage_started.
    const flow = s.listEvents().filter((e) => e.type === 'stage_changed' || e.type === 'stage_started')
    assert.deepEqual(flow.map((e) => [e.type, e.payload.to ?? e.payload.nodeId, e.payload.lane]), [
      ['stage_changed', 'split', undefined],
      ['stage_changed', 'be', 'split:backend'],
      ['stage_started', 'be', 'split:backend'],
      ['stage_changed', 'fe', 'split:frontend'],
      ['stage_started', 'fe', 'split:frontend']
    ])
    assert.equal('lane' in flow[0].payload, false, 'вход в сам fork — без lane')
    assert.deepEqual(flow[1].payload, { runId: run.id, from: 'split', to: 'be', outcome: 'backend', nodeType: 'work', title: 'API', lane: 'split:backend' })
    assert.deepEqual(flow[2].payload, {
      runId: run.id, nodeId: 'be', title: 'API', roleIds: ['backend'], visit: 1, lane: 'split:backend', laneTitle: 'Бэкенд'
    })
    assert.equal(flow[4].payload.laneTitle, 'Фронтенд')
    // История: вход в fork — обычная запись, первая запись пути — с lane, from = fork, outcome = id пути.
    assert.deepEqual(r.stageHistory!.map((h) => [h.nodeId, h.from, h.outcome, h.lane, h.commit]), [
      ['split', undefined, 'next', undefined, 'abc'],
      ['be', 'split', 'backend', 'split:backend', 'abc'],
      ['fe', 'split', 'frontend', 'split:frontend', 'abc']
    ])
    assert.equal(r.status, 'in_progress')
  })

  it('рестарт: enterRunStage без переходов отдаёт действия по всем позициям и новых событий не шлёт', () => {
    const { s, run } = forked()
    const before = s.listEvents().length
    const again = s.enterRunStage(run.id, opts)
    assert.deepEqual(again.actions.map((a) => [a.nodeId, a.lane, a.action.type]), [
      ['be', 'split:backend', 'start_stage'],
      ['fe', 'split:frontend', 'start_stage']
    ])
    assert.equal(s.listEvents().length, before)
  })
})

describe('разветвление: подзадачи и закрытие этапов по пути', () => {
  it('task create без stage при двух открытых «Работах» — ошибка со списком; со stage — stageOf своего этапа', () => {
    const { s, run } = forked()
    assert.throws(() => s.createTask({ title: 'X', runId: run.id, roleId: 'backend' }), /--stage обязателен: открыты этапы «API» \(be\), «UI» \(fe\)/)
    assert.throws(() => s.assertStageAcceptsTasks(run.id), /--stage обязателен/)
    assert.equal(s.stageDefaultRole(run.id), undefined, 'несколько этапов — роль по умолчанию не угадываем')
    assert.equal(s.stageDefaultRole(run.id, 'fe'), 'frontend')
    const be = s.createTask({ title: 'ручка', runId: run.id, stage: 'be' })
    assert.deepEqual(be.stageOf, { nodeId: 'be', visit: 1 })
    assert.equal(be.roleId, 'backend')
    const fe = s.createTask({ title: 'экран', runId: run.id, stage: 'fe' })
    assert.deepEqual(fe.stageOf, { nodeId: 'fe', visit: 1 })
    assert.throws(() => s.createTask({ title: 'Y', runId: run.id, stage: 'fe', roleId: 'backend' }), /роль «backend» не разрешена на этапе «UI»/)
  })

  it('stage_tasks_done пути приходит с lane и не гасится переходом соседнего пути (в обе стороны)', () => {
    const { s, run } = forked()
    const be = s.createTask({ title: 'ручка', runId: run.id, stage: 'be' })
    const fe = s.createTask({ title: 'экран', runId: run.id, stage: 'fe' })
    finish(s, be.id)
    finish(s, fe.id)
    const done = events(s, 'stage_tasks_done')
    assert.deepEqual(done.map((e) => e.payload), [
      { runId: run.id, nodeId: 'be', lane: 'split:backend' },
      { runId: run.id, nodeId: 'fe', lane: 'split:frontend' }
    ])
    assert.ok(s.getRun(run.id)!.lanes!.every((l) => l.stageTasksDoneAt !== undefined))
    assert.equal(s.getRun(run.id)!.stageTasksDoneAt, undefined, 'у основной позиции метки нет')
    s.finishStage(run.id, { ...opts, nodeId: 'fe' })
    const after = events(s, 'stage_tasks_done')
    assert.equal(after[0].consumedBy, undefined, 'событие пути backend живо после перехода frontend')
    assert.equal(after[1].consumedBy, 'stage')
    s.finishStage(run.id, { ...opts, nodeId: 'be' })
    assert.equal(events(s, 'stage_tasks_done')[0].consumedBy, 'stage')

    // Обратный порядок: закрывается backend, событие frontend остаётся.
    const other = forked()
    const b2 = other.s.createTask({ title: 'ручка', runId: other.run.id, stage: 'be' })
    const f2 = other.s.createTask({ title: 'экран', runId: other.run.id, stage: 'fe' })
    finish(other.s, f2.id)
    finish(other.s, b2.id)
    other.s.finishStage(other.run.id, { ...opts, nodeId: 'be' })
    const ev = events(other.s, 'stage_tasks_done')
    assert.deepEqual(ev.map((e) => [e.payload.nodeId, e.consumedBy]), [['fe', undefined], ['be', 'stage']])
  })

  it('подзадача, ушедшая из done, снимает метку только своего пути и гасит только его событие', () => {
    const { s, run } = forked()
    const be = doneTask(s, run.id, 'be', 'backend')
    doneTask(s, run.id, 'fe', 'frontend')
    s.updateTask(be, { status: 'in_progress' })
    const lanes = s.getRun(run.id)!.lanes!
    assert.equal(lanes[0].stageTasksDoneAt, undefined)
    assert.notEqual(lanes[1].stageTasksDoneAt, undefined)
    assert.deepEqual(events(s, 'stage_tasks_done').map((e) => [e.payload.nodeId, e.consumedBy]), [['be', 'stage'], ['fe', undefined]])
  })

  it('finishStage с nodeId закрывает только свой путь; без nodeId при двух открытых — ошибка, при одном — закрывает его', () => {
    const { s, run } = forked()
    doneTask(s, run.id, 'be', 'backend')
    doneTask(s, run.id, 'fe', 'frontend')
    assert.throws(() => s.finishStage(run.id, opts), /--stage обязателен: открыты этапы «API» \(be\), «UI» \(fe\)/)
    const moved = s.finishStage(run.id, { ...opts, nodeId: 'be', summary: 'API готово' })
    assert.deepEqual(moved.actions, [{ nodeId: 'rev', lane: 'split:backend', action: { type: 'create_gate', nodeId: 'rev', roleId: 'reviewer' } }])
    const r = s.getRun(run.id)!
    assert.deepEqual(r.lanes!.map((l) => l.nodeId), ['rev', 'fe'])
    assert.equal(r.stage!.nodeId, 'split')
    assert.equal(r.summary, undefined, 'сводка пути — только в историю, Run.summary — при слиянии')
    assert.equal(r.stageHistory!.find((h) => h.nodeId === 'be')!.summary, 'API готово')
    assert.throws(() => s.finishStage(run.id, { ...opts, nodeId: 'be' }), /граф ушёл дальше/)
    // Открыт один этап «Работа» — без --stage закрывается он.
    const second = s.finishStage(run.id, opts)
    assert.equal(second.actions[0].nodeId, 'hum')
    assert.equal(second.actions[0].lane, 'split:frontend')
    assert.throws(() => s.finishStage(run.id, opts), /не на этапе «Работа»/)
  })

  it('решение без nodeId внутри разветвления — ошибка, по чужой ноде — «граф ушёл дальше»', () => {
    const { s, run } = bothOnHuman()
    assert.throws(() => s.advanceRunStage(run.id, 'accept', opts), /идёт по путям разветвления — нужна нода решения/)
    assert.throws(() => s.advanceRunStage(run.id, 'accept', { ...opts, nodeId: 'rev' }), /граф ушёл дальше/)
  })
})

describe('разветвление: слияние (join)', () => {
  it('пришёл один путь — ждёт; пришли оба — lanes очищены, Run.stage на следующей ноде, одно действие', () => {
    const { s, run } = bothOnHuman()
    const first = s.advanceRunStage(run.id, 'accept', { ...opts, nodeId: 'hum', decision: 'макет ок' })
    assert.deepEqual(first.actions, [{ nodeId: 'merge_paths', lane: 'split:frontend', action: { type: 'join', nodeId: 'merge_paths', forkId: 'split' } }])
    let r = s.getRun(run.id)!
    assert.equal(r.lanes![1].nodeId, 'merge_paths')
    assert.notEqual(r.lanes![1].arrivedAt, undefined)
    assert.equal(r.lanes![0].arrivedAt, undefined)
    assert.equal(s.runStages(run.id, opts)[1].arrived, true)
    assert.throws(() => s.advanceRunStage(run.id, 'next', { ...opts, nodeId: 'merge_paths' }), /уже пришёл в слияние/)

    const closed = s.advanceRunStage(run.id, 'accept', { ...opts, nodeId: 'humBe' })
    assert.deepEqual(closed.actions, [{ nodeId: 'check', action: { type: 'request_human', nodeId: 'check' } }])
    r = s.getRun(run.id)!
    assert.equal('lanes' in r, false)
    assert.equal(r.stage!.nodeId, 'check')
    assert.equal(r.stageInput, undefined, 'решение последнего пути в этап после слияния не переносится')
    const last = r.stageHistory![r.stageHistory!.length - 1]
    assert.deepEqual([last.nodeId, last.from, last.outcome, last.lane], ['check', 'merge_paths', 'next', undefined])
    const joins = r.stageHistory!.filter((h) => h.nodeId === 'merge_paths')
    assert.deepEqual(joins.map((h) => h.lane), ['split:frontend', 'split:backend'])
    assert.equal(r.summary!.text, '### Путь «Бэкенд»\n\nAPI готово\n\n### Путь «Фронтенд»\n\nUI готов')
    assert.equal(r.status, 'review', 'после слияния колонка — по ноде human')
    assert.deepEqual(s.getGlobalTask(run.id).lanes, undefined)
  })

  it('пустой путь (fork сразу в join) приходит сразу; все пустые — разветвление проходит насквозь', () => {
    const wf: Workflow = {
      version: 2,
      nodes: [
        { id: 'start', type: 'start', ...n },
        { id: 'split', type: 'fork', branches: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], ...n },
        { id: 'wa', type: 'work', title: 'A', ...n },
        { id: 'j', type: 'join', forkId: 'split', ...n },
        { id: 'end', type: 'end', ...n }
      ],
      edges: [
        { id: 'e1', from: 'start', outcome: 'next', to: 'split' },
        { id: 'e2', from: 'split', outcome: 'a', to: 'wa' },
        { id: 'e3', from: 'split', outcome: 'b', to: 'j' },
        { id: 'e4', from: 'wa', outcome: 'next', to: 'j' },
        { id: 'e5', from: 'j', outcome: 'next', to: 'end' }
      ]
    }
    const s = store()
    const run = s.createRun('цель', undefined, wf)
    const entered = s.enterRunStage(run.id, opts)
    assert.deepEqual(entered.actions.map((a) => [a.nodeId, a.action.type]), [['wa', 'start_stage'], ['j', 'join']])
    assert.equal(s.getRun(run.id)!.lanes![1].arrivedAt !== undefined, true)
    // Единственный открытый этап — подзадача без --stage попадает в него.
    const t = s.createTask({ title: 'A', runId: run.id, roleId: 'developer' })
    assert.deepEqual(t.stageOf, { nodeId: 'wa', visit: 1 })
    finish(s, t.id)
    const done = s.finishStage(run.id, opts)
    assert.deepEqual(done.actions, [{ nodeId: 'end', action: { type: 'done', nodeId: 'end', merged: false } }])
    assert.notEqual(s.getRun(run.id)!.closedAt, undefined)
    assert.equal(events(s, 'run_done').length, 1)

    const empty: Workflow = { ...wf, edges: wf.edges.map((e) => (e.id === 'e2' ? { ...e, to: 'j' } : e)) }
    const s2 = store()
    const r2 = s2.createRun('цель', undefined, empty)
    const through = s2.enterRunStage(r2.id, opts)
    assert.deepEqual(through.actions.map((a) => a.action.type), ['done'])
    assert.equal('lanes' in s2.getRun(r2.id)!, false)
  })
})

describe('разветвление: human, gate и возвраты по пути', () => {
  it('два approval на разных нодах — два запроса; карточка — ошибка с кодом; решение одного двигает только свой путь', () => {
    const { s, run } = bothOnHuman()
    assert.equal(s.getRun(run.id)!.status, 'review', 'все идущие пути ждут человека — «Проверка»')
    const a = s.requestRunApproval(run.id, { nodeId: 'humBe', title: 'Приёмка API' })
    const b = s.requestRunApproval(run.id, { nodeId: 'hum', title: 'Макет' })
    assert.notEqual(a.id, b.id)
    assert.equal(s.requestRunApproval(run.id, { nodeId: 'hum', title: 'Макет' }).id, b.id, 'та же нода — тот же запрос')
    assert.throws(() => s.acceptGlobalTask(run.id), (e: unknown) => {
      assert.ok(e instanceof RunApprovalAmbiguousError)
      assert.equal(e.code, 'runApprovalAmbiguous')
      assert.deepEqual(e.requestIds, [a.id, b.id])
      assert.match(e.message, /ждут решения 2 запроса/)
      return true
    })
    assert.throws(() => s.returnGlobalTask(run.id, 'переделать'), RunApprovalAmbiguousError)
    s.resolveRequest(b.id, { action: 'accept' })
    s.advanceRunStage(run.id, 'accept', { ...opts, nodeId: 'hum' })
    const r = s.getRun(run.id)!
    assert.deepEqual(r.lanes!.map((l) => [l.nodeId, l.arrivedAt !== undefined]), [['humBe', false], ['merge_paths', true]])
    // Остался один ждущий approval — карточка решает его.
    s.acceptGlobalTask(run.id)
    assert.equal(s.getRequest(a.id)!.status, 'resolved')
  })

  it('колонка: пока хоть один путь работает — «В работе»', () => {
    const { s, run } = forked()
    doneTask(s, run.id, 'fe', 'frontend')
    s.finishStage(run.id, { ...opts, nodeId: 'fe' })
    assert.equal(s.getRun(run.id)!.status, 'in_progress')
  })

  it('reject пути — новый заход только этого пути: visits, stage_started.feedback с lane, lane.stageInput, returns с нодой', () => {
    const { s, run } = bothOnHuman()
    const beStartedBefore = events(s, 'stage_started').filter((e) => e.payload.nodeId === 'be').length
    const back = s.advanceRunStage(run.id, 'reject', { ...opts, nodeId: 'hum', feedback: 'цвета не те', images: ['/tmp/a.png'] })
    assert.deepEqual(back.actions, [{ nodeId: 'fe', lane: 'split:frontend', action: { type: 'start_stage', nodeId: 'fe', roleIds: ['frontend'] } }])
    const r = s.getRun(run.id)!
    assert.equal(r.stage!.visits.fe, 2)
    assert.equal(r.stage!.visits.be, 1)
    assert.deepEqual(r.lanes![1].stageInput, { feedback: 'цвета не те', images: ['/tmp/a.png'] })
    assert.equal(r.lanes![0].stageInput, undefined)
    assert.equal(r.stageInput, undefined)
    assert.deepEqual(r.returns!.map((x) => [x.text, x.nodeId]), [['цвета не те', 'hum']])
    const started = events(s, 'stage_started').at(-1)!
    assert.deepEqual(started.payload, {
      runId: run.id, nodeId: 'fe', title: 'UI', roleIds: ['frontend'], visit: 2, feedback: 'цвета не те', images: ['/tmp/a.png'],
      lane: 'split:frontend', laneTitle: 'Фронтенд'
    })
    assert.equal(events(s, 'stage_started').filter((e) => e.payload.nodeId === 'be').length, beStartedBefore, 'соседний путь не тронут')
    assert.equal(r.lanes![0].nodeId, 'humBe')
    assert.deepEqual(s.runStage(run.id, opts, 'fe')!.tasks, [], 'подзадачи прошлого захода не в счёт')
    assert.equal(s.runStage(run.id, opts, 'fe')!.feedback, 'цвета не те')
    assert.equal(s.getRun(run.id)!.status, 'in_progress')
  })

  it('повторный проход через fork — новое поколение путей, замечания получают все пути, прошлые подзадачи не считаются', () => {
    const { s, run } = bothOnHuman()
    s.advanceRunStage(run.id, 'accept', { ...opts, nodeId: 'hum' })
    s.advanceRunStage(run.id, 'accept', { ...opts, nodeId: 'humBe' })
    const again = s.advanceRunStage(run.id, 'reject', { ...opts, nodeId: 'check', feedback: 'не сходится' })
    assert.deepEqual(again.actions.map((a) => [a.nodeId, a.lane]), [['be', 'split:backend'], ['fe', 'split:frontend']])
    const r = s.getRun(run.id)!
    assert.equal(r.stage!.nodeId, 'split')
    assert.equal(r.stage!.visits.split, 2)
    assert.deepEqual(r.lanes!.map((l) => [l.forkVisit, l.nodeId, l.arrivedAt, l.stageInput?.feedback]), [
      [2, 'be', undefined, 'не сходится'],
      [2, 'fe', undefined, 'не сходится']
    ])
    assert.equal(r.stageInput, undefined)
    assert.deepEqual(r.returns!.at(-1), { at: r.returns!.at(-1)!.at, text: 'не сходится' }, 'возврат после слияния — основная позиция, без nodeId')
    assert.deepEqual(s.runStages(run.id, opts).map((x) => [x.nodeId, x.visit, x.tasks.length]), [['be', 2, 0], ['fe', 2, 0]])
    // Старое событие stage_tasks_done прошлого захода погашено, новое придёт только по подзадачам нового захода.
    assert.ok(events(s, 'stage_tasks_done').every((e) => e.consumedBy !== undefined))
    assert.throws(() => s.finishStage(run.id, { ...opts, nodeId: 'be' }), /нет подзадач/)
    const started = events(s, 'stage_started').slice(-2)
    assert.deepEqual(started.map((e) => [e.payload.nodeId, e.payload.visit, e.payload.feedback]), [['be', 2, 'не сходится'], ['fe', 2, 'не сходится']])
  })
})

describe('разветвление: блокировка, решения, страховка, снимок', () => {
  it('blockRunStage с nodeId пути — workflow_blocked с lane; без nodeId — по основной позиции', () => {
    const { s, run } = forked()
    assert.deepEqual(s.blockRunStage(run.id, 'стоп', 'fe').payload, { runId: run.id, nodeId: 'fe', reason: 'стоп', lane: 'split:frontend' })
    assert.deepEqual(s.blockRunStage(run.id, 'стоп').payload, { runId: run.id, nodeId: 'split', reason: 'стоп' })
  })

  it('роль этапа пути удалена — workflow_blocked с lane, путь стоит, соседний идёт', () => {
    const s = store()
    const run = s.createRun('цель', undefined, forkWorkflow)
    const entered = s.enterRunStage(run.id, { roleIds: ['backend', 'reviewer'] })
    assert.deepEqual(entered.actions.map((a) => [a.lane, a.action.type]), [['split:backend', 'start_stage'], ['split:frontend', 'blocked']])
    const blocked = events(s, 'workflow_blocked')
    assert.equal(blocked.length, 1)
    assert.equal(blocked[0].payload.lane, 'split:frontend')
    assert.equal(blocked[0].payload.nodeId, 'fe')
  })

  it('requestRunDecision сверяет позицию по ноде пути', () => {
    const { s, run } = forked()
    const fields = { title: 'выбор', options: [{ id: 'a', label: 'A' }], fallback: 'no_choice' as const }
    assert.throws(() => s.requestRunDecision(run.id, { ...fields, nodeId: 'hum' }), /не стоит на ноде «hum»/)
    // Позиция пути на ноде есть — запрос создаётся (тип ноды проверяет исполнитель).
    assert.equal(s.requestRunDecision(run.id, { ...fields, nodeId: 'fe' }).nodeId, 'fe')
  })

  it('settleIdleStages: мёртвый координатор — закрываются только пути с закрытыми подзадачами', () => {
    const { s, run } = forked()
    doneTask(s, run.id, 'be', 'backend')
    assert.deepEqual(s.settleIdleStages(() => true), [])
    const settled = s.settleIdleStages(() => false, () => opts)
    assert.equal(settled.length, 1)
    assert.deepEqual(settled[0].actions, [{ nodeId: 'rev', lane: 'split:backend', action: { type: 'create_gate', nodeId: 'rev', roleId: 'reviewer' } }])
    assert.deepEqual(settled[0].action, settled[0].actions[0].action)
    assert.deepEqual(s.getRun(run.id)!.lanes!.map((l) => l.nodeId), ['rev', 'fe'])
    assert.deepEqual(s.settleIdleStages(() => false, () => opts), [])
  })

  it('снимок с lanes сохраняется и загружается: позиции, подзадачи этапов и ход путей продолжаются', () => {
    const p = memory()
    const { s, run } = forked(p)
    const t = s.createTask({ title: 'ручка', runId: run.id, stage: 'be' })
    finish(s, t.id)
    s.finishStage(run.id, { ...opts, nodeId: 'be' })
    const saved = p.data!.runs!.find((r) => r.id === run.id)!
    assert.deepEqual(saved.lanes!.map((l) => l.nodeId), ['rev', 'fe'])
    const loaded = store(p)
    assert.deepEqual(loaded.getRun(run.id)!.lanes, s.getRun(run.id)!.lanes)
    assert.deepEqual(loaded.runStages(run.id, opts), s.runStages(run.id, opts))
    const again = loaded.enterRunStage(run.id, opts)
    assert.deepEqual(again.actions.map((a) => [a.nodeId, a.action.type]), [['rev', 'create_gate'], ['fe', 'start_stage']])
    loaded.advanceRunStage(run.id, 'accept', { ...opts, nodeId: 'rev' })
    assert.deepEqual(loaded.getRun(run.id)!.lanes!.map((l) => l.nodeId), ['humBe', 'fe'])
  })
})

describe('регрессия: прогон без fork — ни lanes, ни lane', () => {
  it('полный проход дефолтного графа: в снимке нет lanes, в payload и истории нет lane, у returns нет nodeId', () => {
    const p = memory()
    const s = store(p)
    const run = s.createRun('цель', undefined, defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }]))
    s.setRunPty(run.id, 'pty_c', 'claude')
    const entered = s.enterRunStage(run.id, opts)
    assert.deepEqual(entered.actions, [{ nodeId: 'work', action: entered.action }])
    const a = s.createTask({ title: 'A', runId: run.id })
    finish(s, a.id)
    s.finishStage(run.id, { ...opts, summary: 'сделано' })
    s.advanceRunStage(run.id, 'reject', { ...opts, feedback: 'поправь' })
    const b = s.createTask({ title: 'B', runId: run.id })
    finish(s, b.id)
    s.finishStage(run.id, opts)
    s.advanceRunStage(run.id, 'accept', opts)
    s.advanceRunStage(run.id, 'accept', opts)
    const saved = p.data!.runs!.find((r) => r.id === run.id)!
    assert.equal('lanes' in saved, false)
    assert.ok(saved.stageHistory!.every((h) => !('lane' in h)))
    assert.ok(saved.returns!.every((x) => !('nodeId' in x)))
    assert.equal(saved.summary!.text, 'сделано')
    assert.ok(s.listEvents().every((e) => !('lane' in e.payload) && !('laneTitle' in e.payload)))
    assert.deepEqual(s.listEvents().filter((e) => e.payload.runId === run.id).map((e) => e.type), [
      'stage_changed', 'stage_started', 'stage_tasks_done', 'stage_changed', 'stage_changed', 'stage_started',
      'stage_tasks_done', 'stage_changed', 'stage_changed', 'stage_changed', 'run_done'
    ])
  })
})
