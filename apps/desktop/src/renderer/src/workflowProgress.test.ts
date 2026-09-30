import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateWorkflow, type GlobalTask, type StageChange, type Task, type WfNode, type Workflow } from '@orca-board/core'
import {
  defaultProgressNode, entryEdges, isPassThrough, nodeVisits, passExits, pathProgress, progressLayout, returnReason, runProgress, subtaskPathSteps, visitTasks,
  walkHistory, workPath
} from './workflowProgress'
import { setLocale } from './i18n'
import { runGraphWithFork } from './workflowFixture'

setLocale('ru')

/** Граф макета: Старт → Анализ → Реализация → Ревью (принять → Проверка, вернуть → Реализация) → Проверка → Конец. */
const WF: Workflow = {
  version: 2,
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'analysis', type: 'work', title: 'Анализ', x: 220, y: 0 },
    { id: 'impl', type: 'work', title: 'Реализация', x: 440, y: 0 },
    { id: 'review', type: 'gate', title: 'Ревью', roleId: 'reviewer', x: 660, y: 0 },
    { id: 'human', type: 'human', title: 'Проверка человеком', x: 880, y: 0 },
    { id: 'end', type: 'end', x: 1100, y: 0 }
  ] as WfNode[],
  edges: [
    { id: 'e_start', from: 'start', outcome: 'next', to: 'analysis' },
    { id: 'e_an', from: 'analysis', outcome: 'next', to: 'impl' },
    { id: 'e_impl', from: 'impl', outcome: 'next', to: 'review' },
    { id: 'e_rev_ok', from: 'review', outcome: 'accept', to: 'human' },
    { id: 'e_rev_back', from: 'review', outcome: 'reject', to: 'impl' },
    { id: 'e_hum_ok', from: 'human', outcome: 'accept', to: 'end' },
    { id: 'e_hum_back', from: 'human', outcome: 'reject', to: 'impl' }
  ]
}

const H: StageChange[] = [
  { nodeId: 'analysis', at: 100, outcome: 'next', visit: 1 },
  { nodeId: 'impl', from: 'analysis', outcome: 'next', at: 200, visit: 1, summary: 'Требования собраны' },
  { nodeId: 'review', from: 'impl', outcome: 'next', at: 300, visit: 1, summary: 'API и кнопка слиты' },
  { nodeId: 'impl', from: 'review', outcome: 'reject', at: 400, visit: 2 },
  { nodeId: 'review', from: 'impl', outcome: 'next', at: 500, visit: 2 },
  { nodeId: 'human', from: 'review', outcome: 'accept', at: 600, visit: 1 },
  { nodeId: 'end', from: 'human', outcome: 'accept', at: 700, visit: 1 }
]

/** Снимок задачи на шаге `upto` истории: позиция — последняя запись, заходы — по номерам в истории. */
function at(upto: number, over: Partial<GlobalTask> = {}): Partial<GlobalTask> {
  const history = H.slice(0, upto)
  const visits: Record<string, number> = {}
  for (const h of history) visits[h.nodeId] = h.visit ?? 1
  return { stage: { nodeId: history[history.length - 1].nodeId, visits }, stageHistory: history, ...over }
}

test('runProgress: 1-й заход «Реализации» — пройдены старт и «Анализ», сейчас «Реализация», дальше впереди', () => {
  const p = runProgress(at(2), WF)
  assert.equal(p.current, 'impl')
  assert.equal(p.currentVisit, 1)
  assert.equal(p.returned, false)
  assert.equal(p.closed, false)
  assert.deepEqual(Object.fromEntries(Object.entries(p.nodes).map(([id, n]) => [id, n.state])), {
    start: 'done', analysis: 'done', impl: 'current', review: 'todo', human: 'todo', end: 'todo'
  })
  assert.deepEqual(p.edges, { e_start: 1, e_an: 1 })
})

test('runProgress: возврат после reject — 2-й заход, плашка красная, возврат пройден один раз', () => {
  const p = runProgress(at(4), WF)
  assert.equal(p.current, 'impl')
  assert.equal(p.currentVisit, 2)
  assert.equal(p.returned, true)
  assert.equal(p.nodes.review.state, 'done')
  assert.equal(p.nodes.impl.visits, 2)
  assert.deepEqual(p.edges, { e_start: 1, e_an: 1, e_impl: 1, e_rev_back: 1 })
})

test('runProgress: на «Проверке» ревью пройдено дважды (×2), в «Реализацию» пришли не возвратом', () => {
  const p = runProgress(at(6), WF)
  assert.equal(p.current, 'human')
  assert.equal(p.returned, false)
  assert.equal(p.nodes.review.visits, 2)
  assert.equal(p.edges.e_impl, 2)
  assert.equal(p.edges.e_rev_ok, 1)
  assert.equal(p.edges.e_hum_back, undefined)
})

test('runProgress: граф на конце или задача закрыта — текущей ноды нет, конец пройден', () => {
  const p = runProgress(at(7), WF)
  assert.equal(p.current, undefined)
  assert.equal(p.closed, true)
  assert.equal(p.nodes.end.state, 'done')
  assert.equal(p.currentVisit, 0)
  const closed = runProgress(at(4, { closedAt: 999 }), WF)
  assert.equal(closed.current, undefined)
  assert.equal(closed.nodes.impl.state, 'done')
})

test('runProgress: граф не начат (старый main без полей) — всё впереди', () => {
  const p = runProgress({}, WF)
  assert.equal(p.current, undefined)
  assert.equal(p.closed, false)
  assert.ok(Object.values(p.nodes).every((n) => n.state === 'todo' && n.visits === 0))
  assert.deepEqual(p.edges, {})
})

test('entryEdges: через условие — оба ребра; restart — без рёбер; нет ребра с исходом — любое из источника', () => {
  const graph = {
    nodes: [
      { id: 'a', type: 'work', x: 0, y: 0 },
      { id: 'c', type: 'condition', test: { kind: 'role', roleId: 'x' }, x: 0, y: 0 },
      { id: 'b', type: 'work', x: 0, y: 0 }
    ] as WfNode[],
    edges: [
      { id: 'a_c', from: 'a', outcome: 'next', to: 'c' },
      { id: 'c_b', from: 'c', outcome: 'yes', to: 'b' },
      { id: 'c_a', from: 'c', outcome: 'no', to: 'a' }
    ]
  }
  assert.deepEqual(entryEdges(graph, 'a', { nodeId: 'b', outcome: 'yes' }), ['a_c', 'c_b'])
  assert.deepEqual(entryEdges(graph, 'a', { nodeId: 'b', outcome: 'next' }), ['a_c', 'c_b'])
  assert.deepEqual(entryEdges(graph, 'b', { nodeId: 'a', outcome: 'restart' }), [])
  assert.deepEqual(entryEdges(WF, 'review', { nodeId: 'human', outcome: 'accept' }), ['e_rev_ok'])
  // Первая запись без `from` приходит из старта.
  assert.deepEqual(walkHistory(WF, [{ nodeId: 'analysis' }]).edges, { e_start: 1 })
})

test('nodeVisits: заходы «Реализации» — откуда пришли, куда ушли, причина возврата из returns, сводка', () => {
  const g = { ...at(4), returns: [{ at: 401, text: 'Нет теста на пустой отчёт' }, { at: 90_000, text: 'чужое' }] }
  const vs = nodeVisits(g, 'impl', 'impl')
  assert.equal(vs.length, 2)
  assert.deepEqual(
    { visit: vs[0].visit, from: vs[0].from, to: vs[0].to, leftWith: vs[0].leftWith, returned: vs[0].returned, current: vs[0].current, summary: vs[0].summary },
    { visit: 1, from: 'analysis', to: 'review', leftWith: 'next', returned: false, current: false, summary: 'Требования собраны' }
  )
  assert.equal(vs[1].visit, 2)
  assert.equal(vs[1].returned, true)
  assert.equal(vs[1].reason, 'Нет теста на пустой отчёт')
  assert.equal(vs[1].current, true)
  assert.equal(vs[1].till, undefined)
  const review = nodeVisits(g, 'review', 'impl')
  assert.equal(review[0].leftWith, 'reject')
  assert.equal(review[0].leftReason, 'Нет теста на пустой отчёт')
  assert.equal(review[0].current, false)
})

test('returnReason: ближайшее уточнение в окне, пустое и далёкое — нет', () => {
  assert.equal(returnReason([{ at: 1000, text: '  ' }, { at: 1500, text: 'б' }, { at: 1100, text: 'а' }], 1000), 'а')
  assert.equal(returnReason([{ at: 100_000, text: 'а' }], 1000), undefined)
  assert.equal(returnReason(undefined, 1000), undefined)
})

test('defaultProgressNode: текущая, у пройденного графа — последняя, у не начатого — старт', () => {
  assert.equal(defaultProgressNode(runProgress(at(4), WF), at(4), WF), 'impl')
  assert.equal(defaultProgressNode(runProgress(at(7), WF), at(7), WF), 'end')
  assert.equal(defaultProgressNode(runProgress({}, WF), {}, WF), 'start')
})

const task = (over: Partial<Task>): Task => ({
  id: 't', title: 'Подзадача', status: 'in_progress', roleId: 'dev', createdAt: 250, stageOf: { nodeId: 'impl', visit: 1 }, ...over
} as Task)

test('visitTasks: подзадачи захода по stageOf, проверки гейта — по времени захода', () => {
  const tasks = [
    task({ id: 'a', createdAt: 260 }),
    task({ id: 'b', createdAt: 210 }),
    task({ id: 'c', stageOf: { nodeId: 'impl', visit: 2 } }),
    task({ id: 'g1', stageOf: undefined, gateFor: { nodeId: 'review', runId: 'r' }, createdAt: 310 }),
    task({ id: 'g2', stageOf: undefined, gateFor: { nodeId: 'review', runId: 'r' }, createdAt: 510 })
  ]
  assert.deepEqual(visitTasks(tasks, 'impl', { visit: 1, at: 200, till: 300 }).map((t) => t.id), ['b', 'a'])
  assert.deepEqual(visitTasks(tasks, 'review', { visit: 1, at: 300, till: 400 }).map((t) => t.id), ['g1'])
  assert.deepEqual(visitTasks(tasks, 'review', { visit: 2, at: 500 }).map((t) => t.id), ['g2'])
})

test('subtaskPathSteps: путь по умолчанию — Работа › Мерж › Конец, текущий шаг выделен', () => {
  const onMerge = task({ stage: { nodeId: 'merge', visits: { merge: 1 } }, stageHistory: [{ nodeId: 'work', at: 1 }, { nodeId: 'merge', at: 2, from: 'work' }] })
  assert.deepEqual(subtaskPathSteps(onMerge, WF)?.map((s) => [s.name, s.state, s.bad]), [
    ['Реализация', 'done', false], ['Мерж', 'current', false], ['Конец', 'todo', false]
  ])
  const conflict = task({
    stage: { nodeId: 'conflict', visits: { conflict: 1 } },
    stageHistory: [{ nodeId: 'work', at: 1 }, { nodeId: 'merge', at: 2 }, { nodeId: 'conflict', at: 3, outcome: 'conflict' }]
  })
  const steps = subtaskPathSteps(conflict, WF)
  assert.equal(steps?.find((s) => s.state === 'current')?.name, 'Конфликт мержа')
  assert.equal(steps?.find((s) => s.state === 'current')?.bad, true)
  const done = task({ stage: { nodeId: 'end', visits: { end: 1 } }, stageHistory: [{ nodeId: 'work', at: 1 }, { nodeId: 'merge', at: 2 }, { nodeId: 'end', at: 3 }] })
  assert.ok(subtaskPathSteps(done, WF)?.every((s) => s.state === 'done'))
  const fresh = task({})
  assert.deepEqual(subtaskPathSteps(fresh, WF)?.map((s) => s.state), ['todo', 'todo', 'todo'])
  assert.equal(subtaskPathSteps(task({ answerFor: 'human' }), WF), null)
  assert.equal(subtaskPathSteps(task({ stageOf: { nodeId: 'review', visit: 1 } }), WF), null)
})

test('pathProgress: сводка по подзадачам захода — где стоят, что пройдено', () => {
  const tasks = [
    task({ id: 'a', stage: { nodeId: 'merge', visits: { merge: 1 } }, stageHistory: [{ nodeId: 'work', at: 1 }, { nodeId: 'merge', at: 2 }] }),
    task({ id: 'b', stage: { nodeId: 'work', visits: { work: 1 } }, stageHistory: [{ nodeId: 'work', at: 1 }] }),
    task({ id: 'q', answerFor: 'human' })
  ]
  const p = pathProgress(tasks, WF, 'impl')
  assert.ok(p)
  assert.deepEqual(p.nodes.merge.here, ['a'])
  assert.deepEqual(p.nodes.work.here, ['b'])
  assert.equal(p.nodes.work.state, 'current')
  assert.equal(p.nodes.start.state, 'done')
  assert.equal(p.nodes.end.state, 'todo')
  assert.equal(p.edges.e_start_next, 2)
  assert.equal(p.edges.e_work_next, 1)
  assert.equal(pathProgress(tasks, WF, 'review'), undefined)
})

test('workPath и progressLayout: путь «Работы» по умолчанию; граф без координат раскладывается', () => {
  assert.deepEqual(workPath(WF, 'impl')?.nodes.map((n) => n.id), ['start', 'work', 'merge', 'end', 'conflict'])
  assert.equal(workPath(WF, 'review'), undefined)
  const flat = { nodes: WF.nodes.map((n) => ({ ...n, x: 0, y: 0 })), edges: WF.edges }
  const laid = progressLayout(flat)
  assert.equal(new Set(laid.nodes.map((n) => n.x)).size > 1, true)
  assert.equal(progressLayout(WF), WF)
})

test('условие: сквозная нода пройдена — выход с исходом и число проходов по рёбрам, заходов в истории нет', () => {
  const wf: Workflow = {
    version: 2,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'a', type: 'work', x: 200, y: 0 },
      { id: 'c', type: 'condition', test: { kind: 'role', roleId: 'x' }, x: 400, y: 0 },
      { id: 'b', type: 'work', x: 600, y: 0 },
      { id: 'end', type: 'end', x: 800, y: 0 }
    ] as WfNode[],
    edges: [
      { id: 's_a', from: 'start', outcome: 'next', to: 'a' },
      { id: 'a_c', from: 'a', outcome: 'next', to: 'c' },
      { id: 'c_b', from: 'c', outcome: 'yes', to: 'b' },
      { id: 'c_a', from: 'c', outcome: 'no', to: 'a' },
      { id: 'b_end', from: 'b', outcome: 'accept', to: 'end' },
      { id: 'b_a', from: 'b', outcome: 'reject', to: 'a' }
    ]
  }
  const g: Partial<GlobalTask> = {
    stage: { nodeId: 'b', visits: { a: 2, b: 2 } },
    stageHistory: [
      { nodeId: 'a', at: 100, visit: 1 },
      { nodeId: 'b', from: 'a', outcome: 'yes', at: 200, visit: 1 },
      { nodeId: 'a', from: 'b', outcome: 'reject', at: 300, visit: 2 },
      { nodeId: 'b', from: 'a', outcome: 'yes', at: 400, visit: 2 }
    ]
  }
  const p = runProgress(g, wf)
  assert.equal(isPassThrough(wf.nodes[2]), true)
  assert.equal(isPassThrough(wf.nodes[1]), false)
  assert.equal(p.nodes.c.state, 'done')
  assert.equal(p.nodes.c.visits, 2)
  // Исход «нет» не выбирался — его в выходах нет.
  assert.deepEqual(passExits(wf, p.edges, 'c'), [{ edgeId: 'c_b', outcome: 'yes', to: 'b', count: 2 }])
  // Панель условия не строит «Заходы» из истории: там его нет.
  assert.deepEqual(nodeVisits(g, 'c', p.current), [])
  // Граф до условия не дошёл — выходов нет.
  assert.deepEqual(passExits(wf, runProgress({ stage: { nodeId: 'a', visits: { a: 1 } }, stageHistory: [{ nodeId: 'a', at: 100 }] }, wf).edges, 'c'), [])
})

test('закрытый вручную прогон: последний заход без «сейчас» — граница по closedAt, без плашки текущей ноды', () => {
  const g = { ...at(4), closedAt: 450 }
  const p = runProgress(g, WF)
  assert.equal(p.current, undefined)
  assert.equal(p.currentVisit, 0)
  assert.equal(p.returned, false)
  assert.equal(p.nodes.impl.state, 'done')
  const vs = nodeVisits(g, 'impl', p.current)
  assert.equal(vs[1].closed, true)
  assert.equal(vs[1].current, false)
  assert.equal(vs[1].till, 450)
  assert.equal(vs[1].to, undefined)
  // Первый заход закрыт переходом, а не закрытием прогона.
  assert.equal(vs[0].closed, false)
  assert.equal(vs[0].till, 300)
  // Время закрытия раньше входа (часы разъехались) — правой границы нет, но и «сейчас» тоже.
  const odd = nodeVisits({ ...at(4), closedAt: 10 }, 'impl')
  assert.equal(odd[1].closed, true)
  assert.equal(odd[1].till, undefined)
  // Открытый прогон — заход идёт.
  const open = nodeVisits(at(4), 'impl', 'impl')
  assert.equal(open[1].closed, false)
  assert.equal(open[1].till, undefined)
  assert.equal(open[1].current, true)
})

// --- Разветвление (fork/join): несколько «сейчас», слияние ждёт, история путей перемешана по времени ---

const FORK = runGraphWithFork()

/** Вход в разветвление: основной ход на fork, затем первые записи путей (`from: fork`, исход — id пути). */
const FH: StageChange[] = [
  { nodeId: 'analysis', at: 100, visit: 1 },
  { nodeId: 'split', from: 'analysis', outcome: 'next', at: 200, visit: 1 },
  { nodeId: 'be', from: 'split', outcome: 'backend', lane: 'split:backend', at: 201, visit: 1 },
  { nodeId: 'fe', from: 'split', outcome: 'frontend', lane: 'split:frontend', at: 202, visit: 1 }
]

/** Снимок внутри разветвления: `stage` запаркован на fork, пути — где стоят (`arrivedAt` у пришедших в join). */
function forkAt(history: StageChange[], lanes: Array<[string, string, number?]>, over: Partial<GlobalTask> = {}): Partial<GlobalTask> {
  const visits: Record<string, number> = {}
  for (const h of history) visits[h.nodeId] = h.visit ?? 1
  return {
    stage: { nodeId: 'split', visits },
    stageHistory: history,
    lanes: lanes.map(([branch, nodeId, arrivedAt]) => ({
      id: `split:${branch}`, forkId: 'split', branchId: branch, nodeId, ...(arrivedAt !== undefined ? { arrivedAt } : {})
    })),
    ...over
  }
}

const states = (p: ReturnType<typeof runProgress>): Record<string, string> => Object.fromEntries(Object.entries(p.nodes).map(([id, n]) => [id, n.state]))

test('runGraphWithFork: фикстура — валидный граф глобальной задачи', () => {
  assert.deepEqual(validateWorkflow(FORK, { roles: [{ id: 'reviewer', title: 'Reviewer', agent: 'claude' }] }).errors, [])
})

test('runProgress: внутри разветвления «сейчас» — нода каждого пути, fork пройден, рёбра портов fork пройдены', () => {
  const p = runProgress(forkAt(FH, [['backend', 'be'], ['frontend', 'fe']]), FORK)
  assert.deepEqual(p.currents.map((c) => [c.nodeId, c.lane, c.visit]), [['be', 'split:backend', 1], ['fe', 'split:frontend', 1]])
  assert.equal(p.current, 'be', 'прежнее поле — первая из «сейчас»')
  assert.equal(p.currentVisit, 1)
  assert.deepEqual(states(p), {
    start: 'done', analysis: 'done', split: 'done', be: 'current', be_review: 'todo', fe: 'current', fe_mock: 'todo', join: 'todo', human: 'todo', end: 'todo'
  })
  assert.deepEqual(p.edges, { e_start: 1, e_an: 1, e_be: 1, e_fe: 1 })
  assert.deepEqual(p.lanes.map((l) => [l.id, l.arrived]), [['split:backend', false], ['split:frontend', false]])
})

test('runProgress: путь пришёл в join — слияние «ждёт остальные», «сейчас» только у второго пути', () => {
  const history: StageChange[] = [
    ...FH,
    { nodeId: 'be_review', from: 'be', outcome: 'next', lane: 'split:backend', at: 300, visit: 1 },
    { nodeId: 'fe_mock', from: 'fe', outcome: 'next', lane: 'split:frontend', at: 310, visit: 1 },
    { nodeId: 'join', from: 'be_review', outcome: 'accept', lane: 'split:backend', at: 320, visit: 1 }
  ]
  const p = runProgress(forkAt(history, [['backend', 'join', 320], ['frontend', 'fe_mock']]), FORK)
  assert.deepEqual(p.currents.map((c) => c.nodeId), ['fe_mock'])
  assert.equal(p.nodes.join.state, 'waiting')
  assert.equal(p.nodes.be_review.state, 'done')
  assert.equal(p.edges.e_be_ok, 1, 'путь бэкенда дошёл до слияния по accept')
  assert.equal(p.edges.e_fe_mock, 1)
  assert.equal(p.edges.e_fe_ok, undefined, 'фронтенд ещё у человека')
  assert.deepEqual(p.lanes.map((l) => l.arrived), [true, false])
})

test('runProgress: все пути в join — «сейчас» нет, панель по умолчанию на слиянии', () => {
  const history: StageChange[] = [
    ...FH,
    { nodeId: 'join', from: 'be', outcome: 'next', lane: 'split:backend', at: 300, visit: 1 },
    { nodeId: 'join', from: 'fe', outcome: 'next', lane: 'split:frontend', at: 310, visit: 1 }
  ]
  const g = forkAt(history, [['backend', 'join', 300], ['frontend', 'join', 310]])
  const p = runProgress(g, FORK)
  assert.deepEqual(p.currents, [])
  assert.equal(p.current, undefined)
  assert.equal(p.nodes.join.state, 'waiting')
  assert.equal(defaultProgressNode(p, g, FORK), 'join')
})

test('runProgress: возврат внутри пути — «сейчас» этого пути красная, соседний путь не затронут', () => {
  const history: StageChange[] = [
    ...FH,
    { nodeId: 'be_review', from: 'be', outcome: 'next', lane: 'split:backend', at: 300, visit: 1 },
    { nodeId: 'fe_mock', from: 'fe', outcome: 'next', lane: 'split:frontend', at: 305, visit: 1 },
    { nodeId: 'be', from: 'be_review', outcome: 'reject', lane: 'split:backend', at: 310, visit: 2 }
  ]
  const p = runProgress(forkAt(history, [['backend', 'be'], ['frontend', 'fe_mock']]), FORK)
  assert.deepEqual(p.currents.map((c) => [c.nodeId, c.visit, c.returned]), [['be', 2, true], ['fe_mock', 1, false]])
  assert.equal(p.edges.e_be_back, 1)
})

test('walkHistory: запись пути без from идёт от прошлой записи своего пути, а не от соседнего', () => {
  // Записи путей перемешаны: у второй записи бэкенда нет from, прошлая запись вообще — фронтенд.
  const history: StageChange[] = [
    ...FH,
    { nodeId: 'fe_mock', lane: 'split:frontend', outcome: 'next', at: 300 },
    { nodeId: 'be_review', lane: 'split:backend', outcome: 'next', at: 310 }
  ]
  const w = walkHistory(FORK, history)
  assert.equal(w.edges.e_be_rev, 1)
  assert.equal(w.edges.e_fe_mock, 1)
  // Первая запись пути без from — от fork, на котором стоит основной ход.
  const noFrom = walkHistory(FORK, [FH[0], FH[1], { nodeId: 'be', lane: 'split:backend', outcome: 'backend', at: 201 }])
  assert.equal(noFrom.edges.e_be, 1)
})

test('runProgress: после слияния основной ход идёт от join, пути закрыты', () => {
  const history: StageChange[] = [
    ...FH,
    { nodeId: 'join', from: 'be', outcome: 'next', lane: 'split:backend', at: 300, visit: 1 },
    { nodeId: 'join', from: 'fe', outcome: 'next', lane: 'split:frontend', at: 310, visit: 1 },
    { nodeId: 'human', outcome: 'next', at: 320, visit: 1 }
  ]
  const visits: Record<string, number> = { analysis: 1, split: 1, be: 1, fe: 1, join: 1, human: 1 }
  const p = runProgress({ stage: { nodeId: 'human', visits }, stageHistory: history }, FORK)
  assert.deepEqual(p.currents.map((c) => c.nodeId), ['human'])
  assert.deepEqual(p.lanes, [])
  assert.equal(p.nodes.join.state, 'done')
  assert.equal(p.edges.e_join, 1, 'запись без from после слияния — из join')
})

test('runProgress: закрытая задача посреди разветвления — «сейчас» нет, пути не показываются', () => {
  const p = runProgress(forkAt(FH, [['backend', 'be'], ['frontend', 'fe']], { closedAt: 500 }), FORK)
  assert.deepEqual(p.currents, [])
  assert.deepEqual(p.lanes, [])
  assert.equal(p.nodes.be.state, 'done')
})

test('runProgress: без lanes (линейный прогон, старый main) — одна «сейчас», путей нет', () => {
  const p = runProgress(at(4), WF)
  assert.deepEqual(p.currents, [{ nodeId: 'impl', visit: 2, returned: true }])
  assert.deepEqual(p.lanes, [])
  assert.equal(p.current, 'impl')
  assert.equal(p.returned, true)
})

test('nodeVisits: «ушли» считается внутри своего пути — соседний путь не подменяет переход', () => {
  const history: StageChange[] = [
    ...FH,
    { nodeId: 'fe_mock', from: 'fe', outcome: 'next', lane: 'split:frontend', at: 300, visit: 1 },
    { nodeId: 'be_review', from: 'be', outcome: 'next', lane: 'split:backend', at: 400, visit: 1 }
  ]
  const g = forkAt(history, [['backend', 'be_review'], ['frontend', 'fe_mock']])
  const [be] = nodeVisits(g, 'be', ['be_review', 'fe_mock'])
  assert.equal(be.to, 'be_review')
  assert.equal(be.till, 400)
  assert.equal(be.lane, 'split:backend')
  assert.equal(be.current, false)
  const [mock] = nodeVisits(g, 'fe_mock', ['be_review', 'fe_mock'])
  assert.equal(mock.current, true, 'текущая — любая из «сейчас»')
  assert.equal(mock.till, undefined)
  // Вход в fork «уходит» в первый путь, а не висит «сейчас».
  const [split] = nodeVisits(g, 'split', ['be_review', 'fe_mock'])
  assert.equal(split.to, 'be')
  assert.equal(split.current, false)
})

test('nodeVisits: без путей — как раньше (следующая запись, current строкой)', () => {
  const [v1, v2] = nodeVisits(at(5), 'impl', 'review')
  assert.equal(v1.to, 'review')
  assert.equal(v2.to, 'review')
  assert.equal(v1.lane, undefined)
})

test('returnReason: уточнение с чужой ноды не подходит, без ноды — по времени', () => {
  const returns = [
    { at: 1000, text: 'бэк: поправь API', nodeId: 'be_review' },
    { at: 1001, text: 'фронт: другой цвет', nodeId: 'fe_mock' }
  ]
  assert.equal(returnReason(returns, 1001, 'be_review'), 'бэк: поправь API')
  assert.equal(returnReason(returns, 1000, 'fe_mock'), 'фронт: другой цвет')
  assert.equal(returnReason(returns, 1001), 'фронт: другой цвет', 'без ноды — ближайшее по времени')
  assert.equal(returnReason([{ at: 1000, text: 'старый main' }], 1000, 'be_review'), 'старый main')
})

test('nodeVisits: причина возврата в путь — уточнение своей ноды, даже если соседний путь вернули в ту же миллисекунду', () => {
  const history: StageChange[] = [
    ...FH,
    { nodeId: 'be_review', from: 'be', outcome: 'next', lane: 'split:backend', at: 300, visit: 1 },
    { nodeId: 'fe_mock', from: 'fe', outcome: 'next', lane: 'split:frontend', at: 305, visit: 1 },
    { nodeId: 'fe', from: 'fe_mock', outcome: 'reject', lane: 'split:frontend', at: 1000, visit: 2 },
    { nodeId: 'be', from: 'be_review', outcome: 'reject', lane: 'split:backend', at: 1000, visit: 2 }
  ]
  const g = { ...forkAt(history, [['backend', 'be'], ['frontend', 'fe']]), returns: [
    { at: 1000, text: 'бэк: поправь API', nodeId: 'be_review' },
    { at: 1000, text: 'фронт: другой цвет', nodeId: 'fe_mock' }
  ] }
  assert.equal(nodeVisits(g, 'be', ['be', 'fe']).at(-1)?.reason, 'бэк: поправь API')
  assert.equal(nodeVisits(g, 'fe', ['be', 'fe']).at(-1)?.reason, 'фронт: другой цвет')
  assert.equal(nodeVisits(g, 'fe_mock', ['be', 'fe'])[0].leftReason, 'фронт: другой цвет')
})
