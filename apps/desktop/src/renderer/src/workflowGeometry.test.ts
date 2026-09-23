import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultWorkflow, type Workflow } from '@orca-board/core'
import {
  LAYOUT_DX, LAYOUT_DY, NODE_H, NODE_W, autoLayout, curvePoint, distanceToCurve, edgeCurve, edgeCurveOf, fitView,
  hitEdge, hitNode, hitPort, inputPoint, panBy, portPoint, screenToWorld, zoomAt
} from './workflowGeometry'

const wf = defaultWorkflow([{ id: 'reviewer' }])
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
