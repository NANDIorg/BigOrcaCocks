// Запуск: node --test (type stripping Node ≥ 22.6). Из tsc исключён — в core нет @types/node.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { forkBranchIds, forkBranches, laneId, laneRegions, nodeLane, runPositionAt, runPositions } from './run-lanes.ts'
import type { Run, RunLane } from './types.ts'
import type { WfNode, Workflow } from './workflow.ts'

/** старт → анализ → fork (бэкенд: работа ⇄ ревью; фронтенд: работа ⇄ макет) → join → проверка → конец. */
const forkGraph = (): Workflow => ({
  version: 2,
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'analysis', type: 'work', x: 0, y: 0 },
    { id: 'split', type: 'fork', x: 0, y: 0, branches: [{ id: 'backend', label: 'Бэкенд' }, { id: 'frontend', label: 'Фронтенд' }] },
    { id: 'be', type: 'work', x: 0, y: 0 },
    { id: 'rev', type: 'gate', roleId: 'reviewer', x: 0, y: 0 },
    { id: 'fe', type: 'work', x: 0, y: 0 },
    { id: 'mock', type: 'human', x: 0, y: 0 },
    { id: 'join', type: 'join', forkId: 'split', x: 0, y: 0 },
    { id: 'check', type: 'human', x: 0, y: 0 },
    { id: 'end', type: 'end', x: 0, y: 0 }
  ],
  edges: [
    { id: 'e1', from: 'start', outcome: 'next', to: 'analysis' },
    { id: 'e2', from: 'analysis', outcome: 'next', to: 'split' },
    { id: 'e3', from: 'split', outcome: 'backend', to: 'be' },
    { id: 'e4', from: 'split', outcome: 'frontend', to: 'fe' },
    { id: 'e5', from: 'be', outcome: 'next', to: 'rev' },
    { id: 'e6', from: 'rev', outcome: 'accept', to: 'join' },
    { id: 'e7', from: 'rev', outcome: 'reject', to: 'be' },
    { id: 'e8', from: 'fe', outcome: 'next', to: 'mock' },
    { id: 'e9', from: 'mock', outcome: 'accept', to: 'join' },
    { id: 'e10', from: 'mock', outcome: 'reject', to: 'fe' },
    { id: 'e11', from: 'join', outcome: 'next', to: 'check' },
    { id: 'e12', from: 'check', outcome: 'accept', to: 'end' },
    { id: 'e13', from: 'check', outcome: 'reject', to: 'split' }
  ]
})
const fork = (wf: Workflow): Extract<WfNode, { type: 'fork' }> => wf.nodes.find((n) => n.id === 'split') as Extract<WfNode, { type: 'fork' }>

describe('пути ноды fork', () => {
  it('laneId, id путей и нормализованные названия', () => {
    assert.equal(laneId('split', 'backend'), 'split:backend')
    const wf = forkGraph()
    assert.deepEqual(forkBranchIds(fork(wf)), ['backend', 'frontend'])
    ;(fork(wf) as { branches: unknown }).branches = [{ id: 'a', label: '  A  ' }, { id: 'b' }, { id: 'c', label: ' ' }, null, { id: 1 }]
    assert.deepEqual(forkBranches(fork(wf)), [{ id: 'a', label: 'A' }, { id: 'b', label: 'b' }, { id: 'c', label: 'c' }])
    ;(fork(wf) as { branches: unknown }).branches = 'x'
    assert.deepEqual(forkBranchIds(fork(wf)), [])
  })
})

describe('laneRegions', () => {
  it('области путей: вход, ноды по порядку обхода, парный join; чужих нод нет', () => {
    assert.deepEqual(laneRegions(forkGraph(), 'split'), {
      forkId: 'split', joinId: 'join', joins: ['join'],
      lanes: [
        { laneId: 'split:backend', branchId: 'backend', entry: 'be', nodes: ['be', 'rev'], leaked: [] },
        { laneId: 'split:frontend', branchId: 'frontend', entry: 'fe', nodes: ['fe', 'mock'], leaked: [] }
      ]
    })
  })

  it('не fork или нет ноды — undefined; пустой путь — вход в join и пустая область', () => {
    const wf = forkGraph()
    assert.equal(laneRegions(wf, 'be'), undefined)
    assert.equal(laneRegions(wf, 'nope'), undefined)
    wf.edges.find((e) => e.id === 'e4')!.to = 'join'
    const lane = laneRegions(wf, 'split')!.lanes[1]
    assert.deepEqual(lane, { laneId: 'split:frontend', branchId: 'frontend', entry: 'join', nodes: [], leaked: [] })
  })

  it('утечка: путь, ушедший в конец или после слияния, дотягивается до чужих нод — они в leaked', () => {
    const toEnd = forkGraph()
    toEnd.edges.find((e) => e.id === 'e6')!.to = 'end'
    assert.deepEqual(laneRegions(toEnd, 'split')!.lanes[0], { laneId: 'split:backend', branchId: 'backend', entry: 'be', nodes: ['be', 'rev'], leaked: ['end'] })
    const after = forkGraph()
    after.edges.find((e) => e.id === 'e6')!.to = 'check'
    assert.deepEqual(laneRegions(after, 'split')!.lanes[0].leaked, ['check', 'end'])
  })

  it('без join — joinId нет, joins пуст; два join — оба в joins', () => {
    const wf = forkGraph()
    ;(wf.nodes.find((n) => n.id === 'join') as { forkId: string }).forkId = 'other'
    const none = laneRegions(wf, 'split')!
    assert.equal(none.joinId, undefined)
    assert.deepEqual(none.joins, [])
    const two = forkGraph()
    two.nodes.push({ id: 'join2', type: 'join', forkId: 'split', x: 0, y: 0 })
    assert.deepEqual(laneRegions(two, 'split')!.joins, ['join', 'join2'])
  })

  it('nodeLane: путь ноды; вне разветвления, fork и join — undefined', () => {
    const wf = forkGraph()
    assert.deepEqual(nodeLane(wf, 'rev'), { forkId: 'split', branchId: 'backend', laneId: 'split:backend' })
    assert.deepEqual(nodeLane(wf, 'mock'), { forkId: 'split', branchId: 'frontend', laneId: 'split:frontend' })
    for (const id of ['analysis', 'split', 'join', 'check', 'end']) assert.equal(nodeLane(wf, id), undefined, id)
  })
})

describe('позиции прогона', () => {
  type Source = Pick<Run, 'stage' | 'lanes' | 'stageInput' | 'stageTasksDoneAt'>
  const lane = (branchId: string, nodeId: string, extra: Partial<RunLane> = {}): RunLane =>
    ({ id: laneId('split', branchId), forkId: 'split', branchId, forkVisit: 1, nodeId, ...extra })

  it('граф не начат — позиций нет', () => {
    assert.deepEqual(runPositions({}), [])
    assert.equal(runPositionAt({}), undefined)
  })

  it('линейный прогон — одна основная позиция с входом этапа и меткой закрытия', () => {
    const run: Source = { stage: { nodeId: 'be', visits: { be: 2 } }, stageInput: { feedback: 'поправь' }, stageTasksDoneAt: 5 }
    const main = { nodeId: 'be', visit: 2, input: { feedback: 'поправь' }, tasksDoneAt: 5 }
    assert.deepEqual(runPositions(run), [main])
    assert.deepEqual(runPositionAt(run), main)
    assert.deepEqual(runPositionAt(run, 'be'), main)
    assert.equal(runPositionAt(run, 'rev'), undefined, 'граф ушёл дальше')
    // Пустой список путей — то же, что без путей.
    assert.deepEqual(runPositions({ ...run, lanes: [] }), [main])
    assert.deepEqual(runPositions({ stage: { nodeId: 'x', visits: {} } }), [{ nodeId: 'x', visit: 1 }])
  })

  it('разветвление — по позиции на путь в порядке Run.lanes; основная позиция — на fork', () => {
    const run: Source = {
      stage: { nodeId: 'split', visits: { split: 1, be: 2, fe: 1, join: 1 } },
      lanes: [
        lane('backend', 'be', { stageInput: { feedback: 'API' }, stageTasksDoneAt: 7 }),
        lane('frontend', 'join', { arrivedAt: 9 })
      ]
    }
    const be = { nodeId: 'be', lane: 'split:backend', visit: 2, input: { feedback: 'API' }, tasksDoneAt: 7 }
    const fe = { nodeId: 'join', lane: 'split:frontend', visit: 1, arrived: true }
    assert.deepEqual(runPositions(run), [be, fe])
    assert.deepEqual(runPositionAt(run, 'be'), be)
    assert.deepEqual(runPositionAt(run, 'join'), fe)
    assert.deepEqual(runPositionAt(run), { nodeId: 'split', visit: 1 })
    assert.deepEqual(runPositionAt(run, 'split'), { nodeId: 'split', visit: 1 })
    assert.equal(runPositionAt(run, 'fe'), undefined)
  })
})
