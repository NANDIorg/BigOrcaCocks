import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskStore } from './store.ts'
import type { Workflow } from './types.ts'

test('idle settlement skips rejected host candidate while advancing another current run', () => {
  const store = new TaskStore(); const workflow: Workflow = { version: 2,
    nodes: [{ id: 's', type: 'start', x: 0, y: 0 }, { id: 'w', type: 'work', x: 0, y: 0 }, { id: 'e', type: 'end', x: 0, y: 0 }],
    edges: [{ id: 'a', from: 's', outcome: 'next', to: 'w' }, { id: 'b', from: 'w', outcome: 'next', to: 'e' }] }
  const one = store.createRun('one', undefined, workflow); const two = store.createRun('two', undefined, workflow)
  store.enterRunStage(one.id); store.enterRunStage(two.id)
  const first = store.createTask({ title: 'first', runId: one.id }); const second = store.createTask({ title: 'second', runId: two.id })
  store.acceptTask(first.id); store.acceptTask(second.id)
  assert.ok(one.stageTasksDoneAt); assert.ok(two.stageTasksDoneAt)
  const before = structuredClone(one)
  const settled = store.settleIdleStages(() => false, () => ({}), run => run.id === two.id)
  assert.deepEqual(store.getRun(one.id), before)
  assert.deepEqual(settled.map(result => result.runId), [two.id]); assert.equal(store.getRun(two.id)!.stage!.nodeId, 'e')
})
