import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultWorkflow, type Task, type Workflow } from '@orca-board/core'
import { activeStageNodes, laneTitle, runStageLabel, runStagePositions, splitByStage, stageGroups, taskStageKey } from './runStage'
import { wfNodeTitles } from './cardState'
import { setLocale } from './i18n'
import { graphWithFork } from './workflowFixture'

/** Дефолтный граф глобальной задачи: «Реализация» → «Ревью» (gate) → «Проверка человеком» → конец. */
const wf: Workflow = defaultWorkflow([{ id: 'developer' }, { id: 'reviewer' }])
const nodeId = (type: string): string => wf.nodes.find((n) => n.type === type)!.id

const stage = (id: string, visits: Record<string, number> = {}) => ({ workflowScope: 'run' as const, stage: { nodeId: id, visits } })

test('runStageLabel: название ноды графа прогона и «N-й заход» со второго', () => {
  const work = nodeId('work')
  assert.equal(runStageLabel(stage(work, { [work]: 1 }), wf)?.text, 'Реализация')
  assert.equal(runStageLabel(stage(work, { [work]: 2 }), wf)?.text, 'Реализация · 2-й заход')
  assert.equal(runStageLabel(stage(work), wf)?.text, 'Реализация', 'без visits — как первый заход')
  assert.equal(runStageLabel(stage(work), wf)?.kind, 'stage')
})

test('runStageLabel: гейт — отдельный вид, подсказка по типу ноды называет этап', () => {
  const gate = runStageLabel(stage(nodeId('gate')), wf)
  assert.equal(gate?.kind, 'gate')
  assert.match(gate!.title, /агент-проверяющий смотрит ветку глобальной задачи/)
  assert.match(runStageLabel(stage(nodeId('work')), wf)!.title, /координатор набирает агентов/)
  assert.match(runStageLabel(stage(nodeId('human')), wf)!.title, /ждёт решения человека/)
})

test('runStageLabel: нода «Решение ИИ» — обычная пилюля этапа с подсказкой, что агент выбирает ветку', () => {
  const decision: Workflow = {
    ...wf,
    nodes: [...wf.nodes, { id: 'd1', x: 0, y: 0, type: 'decision', title: 'Нужен ли дизайн?', question: 'Нужен ли дизайн?', roleId: 'reviewer', options: [{ id: 'yes', label: 'Да' }, { id: 'no', label: 'Нет' }] }]
  }
  const label = runStageLabel(stage('d1'), decision)
  assert.equal(label?.kind, 'stage')
  assert.equal(label?.text, 'Нужен ли дизайн?')
  assert.match(label!.title, /агент выбирает, по какой ветке идти дальше/)
})

test('runStageLabel: прогон старого формата, граф не начат, нет графа, неизвестная нода, старт и конец — пилюли нет', () => {
  const work = nodeId('work')
  assert.equal(runStageLabel({ stage: { nodeId: work, visits: {} } }, wf), null, 'без workflowScope: движок подзадач')
  assert.equal(runStageLabel({ workflowScope: 'run' }, wf), null)
  assert.equal(runStageLabel(stage(work), undefined), null)
  assert.equal(runStageLabel(stage('zzz'), wf), null)
  assert.equal(runStageLabel(stage(nodeId('start')), wf), null)
  assert.equal(runStageLabel(stage(nodeId('end')), wf), null)
})

test('runStageLabel: на английском — переведены и название встроенной ноды, и подсказка', () => {
  setLocale('en')
  try {
    const l = runStageLabel(stage(nodeId('work'), { [nodeId('work')]: 3 }), wf)
    assert.equal(l?.text, 'Implementation · pass 3')
    assert.match(l!.title, /the coordinator recruits agents/)
  } finally {
    setLocale('ru')
  }
})

const task = (id: string, createdAt: number, status: string, stageOf?: Task['stageOf']): Pick<Task, 'stageOf' | 'createdAt' | 'status'> & { id: string } =>
  ({ id, createdAt, status, ...(stageOf ? { stageOf } : {}) })
const titles = wfNodeTitles(wf)
const isDone = (s: string): boolean => s === 'done'
const work = nodeId('work')

test('taskStageKey: этап и заход; без stageOf — пустой ключ', () => {
  assert.equal(taskStageKey({ stageOf: { nodeId: 'work', visit: 2 } }), 'work#2')
  assert.equal(taskStageKey({}), '')
})

test('stageGroups: подписи с прогрессом «сделано / всего», порядок — по появлению этапов, а не по id', () => {
  const tasks = [
    task('c', 300, 'done', { nodeId: work, visit: 2 }),
    task('a', 100, 'done', { nodeId: work, visit: 1 }),
    task('b', 200, 'ready', { nodeId: work, visit: 1 }),
    task('x', 50, 'done')
  ]
  const groups = stageGroups(tasks, titles, isDone)!
  assert.deepEqual([...groups.values()].sort((p, q) => p.order - q.order).map((g) => g.label), [
    'Без этапа · 1/1', 'Реализация · 1/2', 'Реализация · 2-й заход · 1/1'
  ])
})

test('stageGroups: группировать нечего — один этап, нет привязок, нет названий нод (старый main)', () => {
  assert.equal(stageGroups([task('a', 1, 'done', { nodeId: work, visit: 1 }), task('b', 2, 'ready', { nodeId: work, visit: 1 })], titles, isDone), null)
  assert.equal(stageGroups([task('a', 1, 'done'), task('b', 2, 'ready')], titles, isDone), null)
  assert.equal(stageGroups([task('a', 1, 'done', { nodeId: work, visit: 1 }), task('b', 2, 'ready')], undefined, isDone), null)
  assert.equal(stageGroups([], titles, isDone), null)
})

test('stageGroups: название неизвестной ноды заменяется id, задача не пропадает', () => {
  const groups = stageGroups([task('a', 1, 'done', { nodeId: 'gone', visit: 1 }), task('b', 2, 'ready')], titles, isDone)!
  assert.equal(groups.get('gone#1')?.label, 'gone · 1/1')
})

test('splitByStage: карточки колонки идут группами в порядке этапов; без групп — одна безымянная', () => {
  const a = task('a', 100, 'ready', { nodeId: work, visit: 1 })
  const b = task('b', 200, 'ready', { nodeId: work, visit: 2 })
  const groups = stageGroups([a, b], titles, isDone)
  const split = splitByStage([b, a], groups)
  assert.deepEqual(split.map((g) => [g.label, g.items.map((x) => x.id)]), [
    ['Реализация · 0/1', ['a']], ['Реализация · 2-й заход · 0/1', ['b']]
  ])
  assert.deepEqual(splitByStage([b, a], null), [{ items: [b, a] }])
})

// --- Разветвление: несколько этапов сразу ---

const forkWf = graphWithFork()
const forked = (lanes: Array<[string, string, number?]>, visits: Record<string, number> = {}) => ({
  workflowScope: 'run' as const,
  stage: { nodeId: 'split', visits: { split: 1, ...visits } },
  lanes: lanes.map(([branch, node, arrivedAt]) => ({ id: `split:${branch}`, forkId: 'split', branchId: branch, nodeId: node, ...(arrivedAt !== undefined ? { arrivedAt } : {}) }))
})

test('runStageLabel: внутри разветвления — этапы всех путей через « · », подсказка называет пути', () => {
  const l = runStageLabel(forked([['backend', 'be'], ['frontend', 'fe']]), forkWf)
  assert.equal(l?.text, 'API impl · UI impl')
  assert.equal(l?.kind, 'stage')
  assert.match(l!.title, /параллельными путями \(2\)/)
  assert.match(l!.title, /Backend: этап «API impl»/)
  assert.match(l!.title, /Frontend: этап «UI impl»/)
})

test('runStageLabel: путь в слиянии в подписи не виден, но назван в подсказке; заход — у своего пути', () => {
  const l = runStageLabel(forked([['backend', 'join', 300], ['frontend', 'fe']], { fe: 2 }), forkWf)
  assert.equal(l?.text, 'UI impl · 2-й заход')
  assert.match(l!.title, /Backend: пришёл в слияние/)
  const all = runStageLabel(forked([['backend', 'join', 300], ['frontend', 'join', 310]]), forkWf)
  assert.equal(all?.text, 'Assemble', 'пришли все — название слияния')
})

test('runStageLabel: все пути на проверке — вид «гейт»; на английском — переведено', () => {
  const gated: Workflow = {
    ...forkWf,
    nodes: forkWf.nodes.map((n) => (n.id === 'fe_mock' ? { id: 'fe_mock', type: 'gate', title: 'UI review', roleId: 'reviewer', x: n.x, y: n.y } : n))
  }
  assert.equal(runStageLabel(forked([['backend', 'be_review'], ['frontend', 'fe_mock']]), gated)?.kind, 'gate')
  assert.equal(runStageLabel(forked([['backend', 'be_review'], ['frontend', 'fe']]), gated)?.kind, 'stage')
  setLocale('en')
  try {
    assert.match(runStageLabel(forked([['backend', 'be'], ['frontend', 'fe']]), forkWf)!.title, /parallel paths \(2\)[\s\S]*Backend: stage “API impl”/)
  } finally {
    setLocale('ru')
  }
})

test('runStagePositions / activeStageNodes: без путей — одна позиция stage, с путями — по пути, пришедшие не активны', () => {
  assert.deepEqual(runStagePositions({ stage: { nodeId: 'impl', visits: { impl: 2 } } }), [{ nodeId: 'impl', visit: 2, arrived: false }])
  assert.deepEqual(runStagePositions({}), [])
  const g = forked([['backend', 'join', 300], ['frontend', 'fe']], { fe: 2 })
  assert.deepEqual(runStagePositions(g).map((p) => [p.nodeId, p.lane, p.visit, p.arrived]), [
    ['join', 'split:backend', 1, true], ['fe', 'split:frontend', 2, false]
  ])
  assert.deepEqual(activeStageNodes(g).map((p) => p.nodeId), ['fe'])
})

test('laneTitle: подпись пути из fork графа; нет графа или пути — id пути без fork', () => {
  assert.equal(laneTitle(forkWf, 'split:frontend'), 'Frontend')
  assert.equal(laneTitle(undefined, 'split:frontend'), 'frontend')
  assert.equal(laneTitle(forkWf, 'gone:x'), 'x')
  assert.equal(laneTitle(forkWf, 'weird'), 'weird')
})

test('stageGroups: два этапа путей одновременно — две группы подзадач по nodeId#заход', () => {
  const tasks = [
    { stageOf: { nodeId: 'be', visit: 1 }, createdAt: 10, status: 'done' },
    { stageOf: { nodeId: 'fe', visit: 1 }, createdAt: 11, status: 'todo' },
    { stageOf: { nodeId: 'be', visit: 1 }, createdAt: 12, status: 'todo' },
    { stageOf: { nodeId: 'fe', visit: 1 }, createdAt: 13, status: 'todo' }
  ]
  const groups = stageGroups(tasks, wfNodeTitles(forkWf), (s) => s === 'done')!
  assert.deepEqual([...groups.values()].map((g) => g.label), ['API impl · 1/2', 'UI impl · 0/2'])
  const split = splitByStage(tasks, groups)
  assert.deepEqual(split.map((s) => s.items.length), [2, 2])
})
