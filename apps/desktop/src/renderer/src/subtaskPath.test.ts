import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultWorkflow, type StageChange, type Task, type WfNode, type Workflow } from '@orca-board/core'
import { cardStageLabel, pathGraph, pathHistoryRows, pathNodeTitles, pathOwner, pathSummary, stageHold, visiblePathRows } from './subtaskPath'
import { setLocale } from './i18n'

/** Граф прогона: «Реализация» (work) с путём по умолчанию и «Ревью» (work) со своим путём «работа → проверка → мерж». */
const base: Workflow = defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }])
const outerId = base.nodes.find((n) => n.type === 'work')!.id

const reviewedPath = {
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'w', type: 'work', x: 0, y: 0 },
    { id: 'rev', type: 'gate', title: 'Ревью кода', roleId: 'reviewer', x: 0, y: 0 },
    { id: 'ok', type: 'human', title: 'Решение', x: 0, y: 0 },
    { id: 'm', type: 'merge', x: 0, y: 0 },
    { id: 'end', type: 'end', x: 0, y: 0 }
  ] as WfNode[],
  edges: []
}
const withPath: Workflow = { ...base, nodes: base.nodes.map((n) => (n.id === outerId && n.type === 'work' ? { ...n, subflow: reviewedPath } : n)) }

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1', title: 'Подзадача', status: 'in_progress', runId: 'run1', stageOf: { nodeId: outerId, visit: 1 }, ...over
} as Task)

test('pathOwner: рабочая подзадача этапа «Работа»; ответ, проверка, задача без stageOf, чужая нода — нет', () => {
  assert.equal(pathOwner(task(), base)?.id, outerId)
  assert.equal(pathOwner(task({ answerFor: 'human' }), base), undefined)
  assert.equal(pathOwner(task({ gateFor: { nodeId: 'x', taskId: 't0' } }), base), undefined)
  assert.equal(pathOwner(task({ stageOf: undefined }), base), undefined)
  assert.equal(pathOwner(task({ stageOf: { nodeId: 'zzz', visit: 1 } }), base), undefined)
  assert.equal(pathOwner(task(), undefined), undefined)
})

test('pathGraph: subflow ноды или путь по умолчанию', () => {
  assert.equal(pathGraph(task(), withPath), reviewedPath)
  assert.deepEqual(pathGraph(task(), base)?.nodes.map((n) => n.id), ['start', 'work', 'merge', 'end', 'conflict'])
})

test('cardStageLabel: на пути — «этап › шаг»; шаг «Работа» без названия — просто этап; со второго захода — «N-й заход»', () => {
  const at = (nodeId: string, visits: Record<string, number> = {}) => task({ stage: { nodeId, visits: { [nodeId]: 1, ...visits } } })
  const byId = () => undefined
  assert.equal(cardStageLabel(at('rev'), withPath, {}, byId)?.text, 'Реализация › Ревью кода')
  assert.equal(cardStageLabel(at('w'), withPath, {}, byId)?.text, 'Реализация')
  assert.equal(cardStageLabel(at('merge'), base, {}, byId)?.text, 'Реализация › Мерж')
  assert.equal(cardStageLabel(at('work', { work: 2 }), base, {}, byId)?.text, 'Реализация · 2-й заход')
  const label = cardStageLabel(at('rev'), withPath, {}, byId)
  assert.equal(label?.kind, 'stage')
  assert.match(label!.title, /Этап «Реализация», шаг пути подзадачи: Ревью кода/)
})

test('cardStageLabel: id ноды пути не спутать с нодой графа прогона (одинаковые id у разных графов)', () => {
  // В пути по умолчанию есть нода «work», в графе прогона у такого id может быть другая нода — заголовок берётся из пути.
  const titles = { work: 'Совсем другая нода' }
  const label = cardStageLabel(task({ stage: { nodeId: 'work', visits: { work: 1 } } }), base, titles, () => undefined)
  assert.equal(label?.text, 'Реализация')
})

test('cardStageLabel: подзадача ещё не в пути — прежняя пилюля по stageOf; без графа — нет пилюли', () => {
  const titles = { [outerId]: 'Реализация' }
  assert.equal(cardStageLabel(task(), base, titles, () => undefined)?.text, 'Реализация')
  assert.equal(cardStageLabel(task(), undefined, undefined, () => undefined), null)
})

test('cardStageLabel: проверка ветки подзадачи называет ноду пути проверяемой задачи', () => {
  const target = task({ id: 'tgt', title: 'Цель', stage: { nodeId: 'rev', visits: { rev: 1 } } })
  const gate = task({ id: 'g1', stageOf: undefined, gateFor: { nodeId: 'rev', taskId: 'tgt' } })
  const label = cardStageLabel(gate, withPath, {}, (id) => (id === 'tgt' ? target : undefined))
  assert.equal(label?.kind, 'gate')
  assert.equal(label?.text, '⛉ Гейт «Ревью кода» → Цель')
})

test('cardStageLabel: на английском — тексты шага пути переведены', () => {
  setLocale('en')
  try {
    const label = cardStageLabel(task({ stage: { nodeId: 'merge', visits: { merge: 1 } } }), base, {}, () => undefined)
    assert.equal(label?.text, 'Implementation › Merge')
    assert.match(label!.title, /Stage “Implementation”, subtask path step: Merge/)
  } finally {
    setLocale('ru')
  }
})

const run = (nodeId: string, visit = 1) => ({ workflowScope: 'run' as const, stage: { nodeId, visits: { [nodeId]: visit } } })
const notDone = (s: string): boolean => s === 'done'

test('stageHold: подзадача текущего захода на gate/human пути держит этап', () => {
  const onGate = task({ stage: { nodeId: 'rev', visits: { rev: 1 } } })
  const hold = stageHold(onGate, run(outerId), withPath, notDone)
  assert.equal(hold?.reason, 'review')
  assert.match(hold!.text, /ждёт проверки/)
  assert.match(hold!.title, /«Реализация» не закроется.*«Ревью кода»/)
  assert.equal(stageHold(task({ stage: { nodeId: 'ok', visits: {} } }), run(outerId), withPath, notDone)?.reason, 'human')
  const conflict = stageHold(task({ stage: { nodeId: 'conflict', visits: {} } }), run(outerId), base, notDone)
  assert.equal(conflict?.reason, 'human', 'конфликт мержа пути по умолчанию — ожидание человека')
})

test('stageHold: работа, мерж, закрытая, прошлый заход, граф не на этапе, старый прогон — не держат', () => {
  const on = (nodeId: string, over: Partial<Task> = {}) => task({ stage: { nodeId, visits: {} }, ...over })
  assert.equal(stageHold(on('w'), run(outerId), withPath, notDone), null)
  assert.equal(stageHold(on('m'), run(outerId), withPath, notDone), null)
  assert.equal(stageHold(on('rev', { status: 'done' }), run(outerId), withPath, notDone), null)
  assert.equal(stageHold(on('rev'), run(outerId, 2), withPath, notDone), null, 'прогон уже на втором заходе, подзадача — с первого')
  assert.equal(stageHold(on('rev'), run('other'), withPath, notDone), null)
  assert.equal(stageHold(on('rev'), { stage: run(outerId).stage }, withPath, notDone), null, 'без workflowScope: движок подзадач')
  assert.equal(stageHold(on('rev'), undefined, withPath, notDone), null)
  assert.equal(stageHold(task(), run(outerId), withPath, notDone), null, 'не вошла в путь')
})

const entry = (nodeId: string, at: number, extra: Partial<StageChange> = {}): StageChange => ({ nodeId, at, ...extra })

test('pathHistoryRows: шаги пути с названиями, заходами, заметными исходами и длительностью; старт не показываем', () => {
  const history: StageChange[] = [
    entry('start', 1000),
    entry('w', 1000, { by: 'workflow', outcome: 'next' }),
    entry('rev', 61_000, { by: 'worker', outcome: 'next' }),
    entry('w', 121_000, { by: 'workflow', outcome: 'reject', visit: 2 }),
    entry('rev', 181_000, { visit: 2 })
  ]
  const rows = pathHistoryRows(task({ stageHistory: history }), withPath, 241_000)
  assert.deepEqual(rows.map((r) => r.name), ['Реализация', 'Ревью кода', 'Реализация', 'Ревью кода'])
  assert.deepEqual(rows.map((r) => r.durationMs), [60_000, 60_000, 60_000, 60_000])
  assert.deepEqual(rows.map((r) => r.current), [false, false, false, true])
  assert.equal(rows[2]!.visit, 2)
  assert.equal(rows[2]!.outcome, 'возврат на доработку')
  assert.equal(rows[1]!.outcome, undefined, 'next — обычное движение, не называем')
  assert.equal(rows[1]!.source, 'воркер')
})

test('pathHistoryRows: конец пути без длительности; шаг, которого нет в графе, — название из записи', () => {
  const rows = pathHistoryRows(task({ stageHistory: [entry('gone', 1000, { title: 'Ревью' }), entry('end', 2000)] }), base, 9000)
  assert.equal(rows[0]!.name, 'Ревью')
  assert.equal(rows[1]!.type, 'end')
  assert.equal(rows[1]!.durationMs, 0)
})

test('pathHistoryRows: нет истории (старый main), нет пути, нет графа — пусто', () => {
  assert.deepEqual(pathHistoryRows(task(), base, 1), [])
  assert.deepEqual(pathHistoryRows(task({ stageHistory: [entry('w', 1)], stageOf: undefined }), base, 1), [])
  assert.deepEqual(pathHistoryRows(task({ stageHistory: [entry('w', 1)] }), undefined, 1), [])
})

test('visiblePathRows: свёрнутый блок — последние пять, развёрнутый — все', () => {
  const rows = pathHistoryRows(task({ stageHistory: Array.from({ length: 8 }, (_, i) => entry(i % 2 ? 'rev' : 'w', 1000 * (i + 1))) }), withPath, 99_000)
  assert.equal(rows.length, 8)
  assert.equal(visiblePathRows(rows, false).length, 5)
  assert.equal(visiblePathRows(rows, false)[0], rows[3])
  assert.equal(visiblePathRows(rows, true).length, 8)
})

test('pathSummary: этап, шаг и заход; не вошла в путь — только этап; не подзадача пути — null', () => {
  assert.deepEqual(pathSummary(task({ stage: { nodeId: 'rev', visits: {} } }), withPath), { stage: 'Реализация', step: 'Ревью кода', visit: 1 })
  assert.deepEqual(pathSummary(task({ stageOf: { nodeId: outerId, visit: 2 } }), base), { stage: 'Реализация', visit: 2 })
  assert.equal(pathSummary(task({ answerFor: 'human' }), base), null)
})

test('pathNodeTitles: названия нод пути (у «Работы» без названия — этап); не подзадача пути — undefined', () => {
  assert.deepEqual(pathNodeTitles(task(), withPath), { start: 'Старт', w: 'Реализация', rev: 'Ревью кода', ok: 'Решение', m: 'Мерж', end: 'Конец' })
  assert.equal(pathNodeTitles(task({ stageOf: undefined }), withPath), undefined)
})
