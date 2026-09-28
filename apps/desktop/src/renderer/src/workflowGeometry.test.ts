import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type WfNode, type Workflow } from '@orca-board/core'
import {
  LAYOUT_DX, LAYOUT_DY, NODE_H, NODE_W, PORT_HIT_R, PORT_STEP, autoLayout, graphBounds, nodeHeight, nodeRect, curvePoint, distanceToCurve, edgeCurve, edgeCurveOf, fitView,
  hitEdge, hitNode, hitPort, inputPoint, panBy, portPoint, screenToWorld, zoomAt
} from './workflowGeometry'
import { graphWithMerge } from './workflowFixture'

const wf = graphWithMerge([{ id: 'reviewer' }])
const node = (id: string) => wf.nodes.find((n) => n.id === id)!
const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`)

test('порты — на правой стороне, делят высоту поровну; вход — середина левой стороны', () => {
  const review = node('review')
  const accept = portPoint(review, 'accept')
  const reject = portPoint(review, 'reject')
  assert.equal(accept.x, review.x + NODE_W)
  close(accept.y, review.y + NODE_H / 3)
  close(reject.y, review.y + (NODE_H * 2) / 3)
  assert.deepEqual(portPoint(node('work'), 'next'), { x: node('work').x + NODE_W, y: node('work').y + NODE_H / 2 })
  assert.deepEqual(inputPoint(review), { x: review.x, y: review.y + NODE_H / 2 })
})

test('кривая начинается в порту, кончается во входе, касательная в конце горизонтальна', () => {
  const from = { x: 0, y: 0 }
  const to = { x: 300, y: 100 }
  const c = edgeCurve(from, to)
  assert.deepEqual(curvePoint(c, 0), from)
  const end = curvePoint(c, 1)
  close(end.x, to.x)
  close(end.y, to.y)
  assert.equal(c[2].y, to.y)
  assert.ok(c[2].x < to.x)
})

test('ребро назад уходит петлёй ниже обеих нод, а не сквозь них', () => {
  const c = edgeCurveOf(wf, wf.edges.find((e) => e.id === 'e_review_reject')!)!
  const mid = curvePoint(c, 0.5)
  assert.ok(mid.y > node('review').y + NODE_H, 'середина петли ниже нод')
  assert.equal(edgeCurveOf(wf, { id: 'x', from: 'work', outcome: 'next', to: 'нет' }), undefined)
})

test('hit-test: нода, порт, ребро', () => {
  const work = node('work')
  assert.equal(hitNode(wf, { x: work.x + 5, y: work.y + 5 }), 'work')
  assert.equal(hitNode(wf, { x: -500, y: -500 }), undefined)

  const p = portPoint(node('review'), 'reject')
  assert.deepEqual(hitPort(wf, { x: p.x + 3, y: p.y - 2 }), { nodeId: 'review', outcome: 'reject' })
  assert.equal(hitPort(wf, { x: p.x + 30, y: p.y }), undefined)

  const edge = wf.edges.find((e) => e.id === 'e_merge_ok')!
  const mid = curvePoint(edgeCurveOf(wf, edge)!, 0.5)
  assert.equal(hitEdge(wf, { x: mid.x, y: mid.y + 3 }), 'e_merge_ok')
  assert.equal(hitEdge(wf, { x: mid.x, y: mid.y + 40 }), undefined)
})

test('расстояние до прямой «кривой» совпадает с расстоянием до отрезка', () => {
  const line = edgeCurve({ x: 0, y: 0 }, { x: 400, y: 0 })
  close(distanceToCurve(line, { x: 200, y: 7 }), 7)
})

test('авторасстановка: слои по кратчайшему пути от старта, возвраты слои не сдвигают', () => {
  const scrambled: Workflow = { ...wf, nodes: wf.nodes.map((n) => ({ ...n, x: 999, y: 999 })) }
  const laid = autoLayout(scrambled)
  const at = (id: string) => laid.nodes.find((n) => n.id === id)!
  assert.deepEqual([at('start').x, at('work').x, at('review').x, at('merge').x], [0, LAYOUT_DX, 2 * LAYOUT_DX, 3 * LAYOUT_DX])
  // У merge два исхода: ok (end) раньше conflict в WF_PORTS — end в первой строке слоя.
  assert.deepEqual([at('end').x, at('end').y], [4 * LAYOUT_DX, 0])
  assert.deepEqual([at('conflict').x, at('conflict').y], [4 * LAYOUT_DX, LAYOUT_DY])
  assert.equal(scrambled.nodes[0].x, 999, 'исходный граф не меняется')
})

test('авторасстановка: недостижимые ноды — отдельным слоем справа', () => {
  const g: Workflow = { ...wf, nodes: [...wf.nodes, { id: 'lost', type: 'merge', x: 0, y: 0 }] }
  const lost = autoLayout(g).nodes.find((n) => n.id === 'lost')!
  assert.equal(lost.x, 5 * LAYOUT_DX)
  const noStart = autoLayout({ version: 1, nodes: [{ id: 'a', type: 'end', x: 50, y: 50 }], edges: [] })
  assert.deepEqual([noStart.nodes[0].x, noStart.nodes[0].y], [0, 0])
})

test('зум колесом держит точку под курсором на месте и ограничен', () => {
  const v = { x: 100, y: 50, scale: 1 }
  const at = { x: 200, y: 120 }
  const before = screenToWorld(v, at)
  const z = zoomAt(v, at, 1.5)
  const after = screenToWorld(z, at)
  close(after.x, before.x)
  close(after.y, before.y)
  assert.equal(z.scale, 1.5)
  assert.equal(zoomAt(v, at, 100).scale, 2.5)
  assert.equal(zoomAt(v, at, 0.001).scale, 0.3)
})

test('панорама двигает вид против движения мыши с учётом масштаба', () => {
  assert.deepEqual(panBy({ x: 0, y: 0, scale: 2 }, 20, -10), { x: -10, y: 5, scale: 2 })
})

test('вписать граф: вся рамка видна, крупнее 1:1 не увеличивает', () => {
  const v = fitView(wf, 600, 300)
  const tl = screenToWorld(v, { x: 0, y: 0 })
  const br = screenToWorld(v, { x: 600, y: 300 })
  for (const n of wf.nodes) {
    assert.ok(n.x >= tl.x && n.x + NODE_W <= br.x, n.id)
    assert.ok(n.y >= tl.y && n.y + NODE_H <= br.y, n.id)
  }
  assert.equal(fitView({ version: 1, nodes: [{ id: 's', type: 'start', x: 0, y: 0 }], edges: [] }, 2000, 2000).scale, 1)
})

// ---------- decision: порты по вариантам, высота по числу портов ----------

const decision = (count: number, x = 0, y = 0): Extract<WfNode, { type: 'decision' }> => ({
  id: 'd', type: 'decision', x, y, question: 'q', roleId: 'analyst',
  options: Array.from({ length: count }, (_, i) => ({ id: `o${i}`, label: `v${i}` }))
})

test('высота ноды: фиксированные типы — NODE_H, decision растёт с числом вариантов', () => {
  for (const n of wf.nodes) assert.equal(nodeHeight(n), NODE_H, n.id)
  assert.equal(nodeHeight(decision(2)), NODE_H)
  assert.equal(nodeHeight(decision(8)), PORT_STEP * 9)
  assert.deepEqual(nodeRect(decision(8, 10, 20)), { x: 10, y: 20, w: NODE_W, h: PORT_STEP * 9 })
  assert.deepEqual(inputPoint(decision(8, 10, 20)), { x: 10, y: 20 + (PORT_STEP * 9) / 2 })
  assert.ok(PORT_STEP >= 2 * PORT_HIT_R, 'соседние порты не перекрываются зонами попадания')
})

test('порты decision — по вариантам в их порядке, с шагом не меньше PORT_STEP; hit-test по id варианта', () => {
  const d = decision(8, 100, 100)
  const ys = d.options.map((o) => portPoint(d, o.id).y)
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= PORT_STEP - 1e-9, `шаг ${i}`)
  assert.ok(ys[0] > d.y && ys.at(-1)! < d.y + nodeHeight(d), 'все порты на стороне ноды')
  const g: Workflow = { version: 2, nodes: [d], edges: [] }
  const p = portPoint(d, 'o5')
  assert.deepEqual(hitPort(g, { x: p.x + 2, y: p.y + 3 }), { nodeId: 'd', outcome: 'o5' })
  assert.equal(hitNode(g, { x: d.x + 5, y: d.y + nodeHeight(d) - 5 }), 'd', 'низ высокой ноды — тоже нода')
})

test('петля назад из высокой ноды уходит ниже её низа; рамка графа включает высокую ноду', () => {
  const d = decision(8, 300, 0)
  const g: Workflow = {
    version: 2,
    nodes: [{ id: 'w', type: 'work', x: 0, y: 0 }, d],
    edges: [{ id: 'back', from: 'd', outcome: 'o0', to: 'w' }]
  }
  const mid = curvePoint(edgeCurveOf(g, g.edges[0])!, 0.5)
  assert.ok(mid.y > d.y + nodeHeight(d), `петля ${mid.y} ниже ${d.y + nodeHeight(d)}`)
  const b = graphBounds(g)!
  assert.ok(b.y + b.h >= d.y + nodeHeight(d) + NODE_H, 'под нодой есть место для петель')
})

test('авторасстановка: под высокой нодой decision следующая нода слоя не налезает', () => {
  const g: Workflow = {
    version: 2,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 's2', type: 'work', x: 0, y: 0 },
      decision(8),
      { id: 'a', type: 'work', x: 0, y: 0 },
      { id: 'b', type: 'work', x: 0, y: 0 }
    ],
    edges: [
      { id: 'e0', from: 'start', outcome: 'next', to: 's2' },
      { id: 'e1', from: 's2', outcome: 'next', to: 'd' },
      { id: 'e2', from: 'd', outcome: 'o0', to: 'a' },
      { id: 'e3', from: 'd', outcome: 'o1', to: 'b' }
    ]
  }
  const laid = autoLayout(g)
  const at = (id: string) => laid.nodes.find((n) => n.id === id)!
  assert.deepEqual([at('a').y, at('b').y], [0, LAYOUT_DY], 'обычные ноды — прежний шаг')
  // Высокая нода первой в слое: следующая — ниже её низа на тот же зазор, что между обычными нодами.
  const hub: Workflow = {
    version: 2,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'hub', type: 'condition', x: 0, y: 0, test: { kind: 'attempts', node: 'd', atLeast: 1 } },
      decision(8),
      { id: 'w', type: 'work', x: 0, y: 0 }
    ],
    edges: [
      { id: 'e0', from: 'start', outcome: 'next', to: 'hub' },
      { id: 'e1', from: 'hub', outcome: 'yes', to: 'd' },
      { id: 'e2', from: 'hub', outcome: 'no', to: 'w' }
    ]
  }
  const l2 = autoLayout(hub)
  const [d, w] = ['d', 'w'].map((id) => l2.nodes.find((n) => n.id === id)!)
  assert.deepEqual([d.x, d.y, w.x], [2 * LAYOUT_DX, 0, 2 * LAYOUT_DX])
  assert.equal(w.y, nodeHeight(d) + LAYOUT_DY - NODE_H)
})
