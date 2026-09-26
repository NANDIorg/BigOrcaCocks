import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultWorkflow, type Task, type Workflow } from '@orca-board/core'
import { runStageLabel, splitByStage, stageGroups, taskStageKey } from './runStage'
import { wfNodeTitles } from './cardState'
import { setLocale } from './i18n'

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
