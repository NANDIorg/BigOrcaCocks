import { it } from 'node:test'
import assert from 'node:assert/strict'
import { TaskStore, DEFAULT_COLUMNS, WORKFLOW_VERSION_TASK_SCOPE, WORKFLOW_VERSION, type Workflow, type WfNode } from './index.ts'

type NodeInput = WfNode extends infer N ? N extends WfNode ? Omit<N, 'x' | 'y'> : never : never
const node = (value: NodeInput): WfNode => ({ x: 0, y: 0, ...value }) as WfNode
function graph(first: 'work' | 'ask' = 'work'): Workflow {
  return {
    version: WORKFLOW_VERSION_TASK_SCOPE,
    nodes: [node({ id: 'start', type: 'start' }), node({ id: 'work', type: first, roleId: 'reviewer' }), node({ id: 'human', type: 'human' })],
    edges: [{ id: 'a', from: 'start', outcome: 'next', to: 'work' }, { id: 'b', from: 'work', outcome: 'next', to: 'human' }]
  }
}
function fixture(wf = graph()) {
  let writes = 0
  const store = new TaskStore({ load: () => null, save: () => { writes += 1 } }, () => DEFAULT_COLUMNS)
  const run = store.createRun('Goal', undefined, wf)
  const task = store.createTask({ title: 'Work', runId: run.id, roleId: 'developer' })
  return { store, task, writes: () => writes }
}

it('preview fresh entry выбирает stage-role без записи и совпадает с enterWork', () => {
  const { store, task, writes } = fixture()
  const before = structuredClone(store.snapshot()); const count = writes()
  const preview = store.previewEnterWork(task.id)
  assert.deepEqual(preview, { stage: { nodeId: 'work', visits: { start: 1, work: 1 } }, action: { type: 'start_worker', nodeId: 'work', roleId: 'reviewer' } })
  assert.deepEqual(store.previewEnterWork(task.id), preview)
  assert.deepEqual(store.snapshot(), before); assert.equal(writes(), count)
  assert.deepEqual(store.enterWork(task.id), preview!.action)
  assert.deepEqual(store.getTask(task.id)!.stage, preview!.stage)
  assert.equal(store.previewEnterWork(task.id), undefined)
})

it('preview restart сохраняет approval и block; запись накапливает те же visits', () => {
  const { store, task, writes } = fixture()
  store.enterWork(task.id); store.advanceStage(task.id, 'next')
  const request = store.requestApproval(task.id, { nodeId: 'human', title: 'Review' })
  store.blockStage(task.id, 'wait')
  const before = structuredClone(store.snapshot()); const count = writes()
  const preview = store.previewEnterWork(task.id)!
  assert.deepEqual(preview.stage, { nodeId: 'work', visits: { start: 2, work: 2, human: 1 } })
  assert.deepEqual(store.snapshot(), before); assert.equal(writes(), count)
  assert.equal(store.getRequest(request.id)!.status, 'pending')
  store.enterWork(task.id)
  assert.deepEqual(store.getTask(task.id)!.stage, preview.stage)
  assert.equal(store.getTask(task.id)!.stageBlock, undefined)
  assert.equal(store.getRequest(request.id)!.status, 'cancelled')
})

it('preview ask no-op не сбрасывает посещения', () => {
  const { store, task } = fixture(graph('ask'))
  store.enterWork(task.id)
  const before = structuredClone(store.snapshot())
  assert.equal(store.previewEnterWork(task.id), undefined)
  assert.deepEqual(store.snapshot(), before)
})

it('preview advance вычисляет condition по роли и visits без событий', () => {
  const wf = graph()
  wf.nodes.push({ id: 'condition', type: 'condition', test: { kind: 'attempts', node: 'work', atLeast: 1 }, x: 0, y: 0 })
  wf.edges = [wf.edges[0], { id: 'b', from: 'work', outcome: 'next', to: 'condition' }, { id: 'c', from: 'condition', outcome: 'yes', to: 'human' }]
  const { store, task, writes } = fixture(wf)
  store.enterWork(task.id)
  const before = structuredClone(store.snapshot()); const count = writes()
  const preview = store.previewAdvanceStage(task.id, 'next')
  assert.deepEqual(preview, { stage: { nodeId: 'human', visits: { start: 1, work: 1, condition: 1, human: 1 } }, action: { type: 'request_human', nodeId: 'human' } })
  assert.deepEqual(store.snapshot(), before); assert.equal(writes(), count)
  assert.deepEqual(store.advanceStage(task.id, 'next').action, preview.action)
  assert.deepEqual(store.getTask(task.id)!.stage, preview.stage)
})

it('preview blocked не пишет состояние; enterWork возвращает тот же отказ', () => {
  const wf = graph(); wf.edges = []
  const { store, task } = fixture(wf)
  const before = structuredClone(store.snapshot())
  const preview = store.previewEnterWork(task.id)!
  assert.equal(preview.action.type, 'blocked')
  assert.deepEqual(store.snapshot(), before)
  assert.deepEqual(store.enterWork(task.id), preview.action)
})

it('preview role condition использует роль задачи и fallback Inbox', () => {
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  const wf = graph()
  wf.nodes.push({ id: 'c', type: 'condition', test: { kind: 'role', roleIds: ['developer'] }, x: 0, y: 0 })
  wf.edges = [{ id: 'a', from: 'start', outcome: 'next', to: 'c' }, { id: 'b', from: 'c', outcome: 'yes', to: 'work' }]
  const task = store.createTask({ title: 'Inbox', roleId: 'developer' })
  const before = structuredClone(store.snapshot())
  assert.deepEqual(store.previewEnterWork(task.id, { workflow: wf })!.stage, { nodeId: 'work', visits: { start: 1, c: 1, work: 1 } })
  assert.deepEqual(store.snapshot(), before)
})

it('preview ответы/гейты не входят в граф, advance сохраняет прежние ошибки', () => {
  const { store, task } = fixture()
  const answer = store.createTask({ title: 'Answer', answerFor: 'human' })
  const gate = store.createTask({ title: 'Gate', gateFor: { taskId: task.id, nodeId: 'human' } })
  for (const t of [answer, gate]) {
    const before = structuredClone(store.snapshot())
    assert.equal(store.previewEnterWork(t.id), undefined)
    assert.throws(() => store.previewAdvanceStage(t.id, 'next'))
    assert.deepEqual(store.snapshot(), before)
  }
  assert.throws(() => store.previewAdvanceStage(task.id, 'ok'), /только исходом next/)
  assert.throws(() => store.previewEnterWork('missing'), /not found/)
})

it('preview путь подзадачи использует subflow; run scope вне work не имеет собственного входа', () => {
  const store = new TaskStore(undefined, () => DEFAULT_COLUMNS)
  const subflow = graph(); const wf: Workflow = { version: WORKFLOW_VERSION, nodes: [
    node({ id: 's', type: 'start' }), { id: 'parent', type: 'work', x: 0, y: 0, subflow: { nodes: subflow.nodes, edges: subflow.edges } },
    node({ id: 'ask', type: 'ask', roleId: 'reviewer' })
  ], edges: [{ id: 'a', from: 's', outcome: 'next', to: 'parent' }] }
  const run = store.createRun('Goal', undefined, wf)
  store.enterRunStage(run.id)
  const task = store.createTask({ title: 'Path', runId: run.id, stage: 'parent' })
  const before = structuredClone(store.snapshot())
  const preview = store.previewEnterWork(task.id)!
  assert.equal(preview.action.type, 'start_worker'); assert.equal(preview.stage.nodeId, 'work')
  assert.deepEqual(store.snapshot(), before)
  store.enterWork(task.id); assert.deepEqual(store.getTask(task.id)!.stage, preview.stage)
  const askGraph: Workflow = { ...wf, edges: [{ id: 'q', from: 's', outcome: 'next', to: 'ask' }] }
  const askRun = store.createRun('Question', undefined, askGraph)
  store.enterRunStage(askRun.id)
  const question = store.createTask({ title: 'Ask', runId: askRun.id, stageOf: { nodeId: 'ask', visit: 1 }, roleId: 'reviewer' })
  assert.equal(store.previewEnterWork(question.id), undefined)
  assert.throws(() => store.previewAdvanceStage(question.id, 'next'), /вне этапа/)
})
