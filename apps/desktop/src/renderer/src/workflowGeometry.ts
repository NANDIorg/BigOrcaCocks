import { WF_PORTS, wfPorts, type WfEdge, type WfNode, type WfOutcome, type WfPort, type Workflow } from '@orca-board/core'

// Геометрия нодового редактора воркфлоу. Координаты — мировые (те же, что `WfNode.x/y`), холст переводит
// в них экранные через `screenToWorld`. Логика вынесена из WorkflowCanvas.tsx, чтобы её можно было тестировать.

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Размер ноды. Один на все типы: порты (до двух) помещаются по высоте, подписи исходов — снаружи справа. */
export const NODE_W = 150
export const NODE_H = 60
/** Радиус порта при попадании курсором — больше нарисованного кружка, чтобы не целиться в пиксель. */
export const PORT_HIT_R = 9
/** Шаг авторасстановки: по X — между слоями, по Y — между нодами слоя. Совпадает с шагом defaultWorkflow. */
export const LAYOUT_DX = 220
export const LAYOUT_DY = 110

export function nodeRect(node: Pick<WfNode, 'x' | 'y'>): Rect {
  return { x: node.x, y: node.y, w: NODE_W, h: NODE_H }
}

/** Вход ноды — середина левой стороны: все рёбра входят сюда. */
export function inputPoint(node: Pick<WfNode, 'x' | 'y'>): Point {
  return { x: node.x, y: node.y + NODE_H / 2 }
}

/** Порт исхода — на правой стороне, порты делят высоту поровну в порядке `wfPorts`. */
export function portPoint(node: WfNode, outcome: WfPort): Point {
  const ports = wfPorts(node)
  const i = Math.max(0, ports.indexOf(outcome))
  return { x: node.x + NODE_W, y: node.y + (NODE_H * (i + 1)) / (ports.length + 1) }
}

/** Кубическая кривая Безье: начало, две контрольные точки, конец. */
export type Curve = [Point, Point, Point, Point]

/**
 * Кривая ребра от порта к входу. Вперёд — плавная S-кривая. Назад (отказ «обратно в работу») и в себя —
 * петля, уходящая вниз: иначе кривая прошла бы сквозь ноды между источником и целью.
 * Касательная в конце всегда горизонтальна слева направо — стрелку можно рисовать без поворота.
 */
export function edgeCurve(from: Point, to: Point): Curve {
  const dx = to.x - from.x
  if (dx >= 40) {
    const c = Math.max(40, dx / 2)
    return [from, { x: from.x + c, y: from.y }, { x: to.x - c, y: to.y }, to]
  }
  const c = Math.max(80, Math.abs(dx) / 4)
  const drop = Math.max(from.y, to.y) + NODE_H + 30
  return [from, { x: from.x + c, y: drop }, { x: to.x - c, y: drop }, to]
}

export function curvePath([p0, c1, c2, p3]: Curve): string {
  const f = (n: number): string => String(Math.round(n * 10) / 10)
  return `M ${f(p0.x)} ${f(p0.y)} C ${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(p3.x)} ${f(p3.y)}`
}

export function curvePoint([p0, c1, c2, p3]: Curve, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p3.x, y: a * p0.y + b * c1.y + c * c2.y + d * p3.y }
}

/** Кривая ребра графа; нет какой-то из нод — `undefined` (ребро битое, его подсветит валидация). */
export function edgeCurveOf(wf: Workflow, edge: WfEdge): Curve | undefined {
  const from = wf.nodes.find((n) => n.id === edge.from)
  const to = wf.nodes.find((n) => n.id === edge.to)
  if (!from || !to) return undefined
  return edgeCurve(portPoint(from, edge.outcome), inputPoint(to))
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2))
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy))
}

/** Расстояние от точки до кривой — по ломаной из `steps` отрезков: для hit-test точности хватает. */
export function distanceToCurve(curve: Curve, p: Point, steps = 24): number {
  let best = Infinity
  let prev = curve[0]
  for (let i = 1; i <= steps; i++) {
    const cur = curvePoint(curve, i / steps)
    best = Math.min(best, distToSegment(p, prev, cur))
    prev = cur
  }
  return best
}

/** Нода под точкой. Ноды, нарисованные позже, лежат сверху — ищем с конца. */
export function hitNode(wf: Workflow, p: Point): string | undefined {
  for (let i = wf.nodes.length - 1; i >= 0; i--) {
    const r = nodeRect(wf.nodes[i])
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return wf.nodes[i].id
  }
  return undefined
}

/** Порт под точкой (ближайший в пределах `PORT_HIT_R`). */
export function hitPort(wf: Workflow, p: Point): { nodeId: string; outcome: WfOutcome } | undefined {
  let best: { nodeId: string; outcome: WfOutcome; d: number } | undefined
  for (const n of wf.nodes) {
    for (const outcome of WF_PORTS[n.type]) {
      const pt = portPoint(n, outcome)
      const d = Math.hypot(p.x - pt.x, p.y - pt.y)
      if (d <= PORT_HIT_R && (!best || d < best.d)) best = { nodeId: n.id, outcome, d }
    }
  }
  return best && { nodeId: best.nodeId, outcome: best.outcome }
}

/** Ребро не дальше `tolerance` от точки; из нескольких — ближайшее. */
export function hitEdge(wf: Workflow, p: Point, tolerance = 6): string | undefined {
  let best: { id: string; d: number } | undefined
  for (const e of wf.edges) {
    const curve = edgeCurveOf(wf, e)
    if (!curve) continue
    const d = distanceToCurve(curve, p)
    if (d <= tolerance && (!best || d < best.d)) best = { id: e.id, d }
  }
  return best?.id
}

/**
 * Авторасстановка по слоям: слой ноды — длина кратчайшего пути от старта (BFS), поэтому рёбра-возвраты
 * (reject → работа) слои не сдвигают. Внутри слоя порядок — порядок обхода, то есть порядок портов
 * у родителя. Недостижимые от старта ноды — отдельным слоем справа, чтобы их было видно.
 */
export function autoLayout(wf: Workflow): Workflow {
  const layer = new Map<string, number>()
  const order: string[] = []
  const start = wf.nodes.find((n) => n.type === 'start')
  if (start) {
    layer.set(start.id, 0)
    const queue = [start.id]
    while (queue.length) {
      const id = queue.shift()!
      order.push(id)
      const node = wf.nodes.find((n) => n.id === id)!
      const ports = wfPorts(node)
      const out = wf.edges
        .filter((e) => e.from === id)
        .sort((a, b) => ports.indexOf(a.outcome) - ports.indexOf(b.outcome))
      for (const e of out) {
        if (layer.has(e.to) || !wf.nodes.some((n) => n.id === e.to)) continue
        layer.set(e.to, layer.get(id)! + 1)
        queue.push(e.to)
      }
    }
  }
  const lastLayer = order.length ? Math.max(...layer.values()) + 1 : 0
  for (const n of wf.nodes) {
    if (layer.has(n.id)) continue
    layer.set(n.id, lastLayer)
    order.push(n.id)
  }
  const row = new Map<number, number>()
  const pos = new Map<string, Point>()
  for (const id of order) {
    const l = layer.get(id)!
    const r = row.get(l) ?? 0
    row.set(l, r + 1)
    pos.set(id, { x: l * LAYOUT_DX, y: r * LAYOUT_DY })
  }
  return { ...wf, nodes: wf.nodes.map((n) => ({ ...n, ...pos.get(n.id)! })) }
}

// ---------- вид холста ----------

/** Вид холста: мировая точка в левом верхнем углу и масштаб (экранных пикселей на мировую единицу). */
export interface View {
  x: number
  y: number
  scale: number
}

export const MIN_SCALE = 0.3
export const MAX_SCALE = 2.5

/** `p` — точка относительно левого верхнего угла холста в экранных пикселях. */
export function screenToWorld(view: View, p: Point): Point {
  return { x: view.x + p.x / view.scale, y: view.y + p.y / view.scale }
}

/** Масштаб в `factor` раз с неподвижной точкой под курсором `at` (экранные координаты холста). */
export function zoomAt(view: View, at: Point, factor: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor))
  const world = screenToWorld(view, at)
  return { x: world.x - at.x / scale, y: world.y - at.y / scale, scale }
}

/** Сдвиг вида на экранный вектор (перетаскивание фона). */
export function panBy(view: View, dx: number, dy: number): View {
  return { ...view, x: view.x - dx / view.scale, y: view.y - dy / view.scale }
}

export function viewBox(view: View, width: number, height: number): string {
  return `${view.x} ${view.y} ${width / view.scale} ${height / view.scale}`
}

/** Рамка всех нод (с запасом под подписи портов и петли возвратов). Пустой граф — `undefined`. */
export function graphBounds(wf: Workflow): Rect | undefined {
  if (wf.nodes.length === 0) return undefined
  const xs = wf.nodes.map((n) => n.x)
  const ys = wf.nodes.map((n) => n.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) + NODE_W + 60 - x, h: Math.max(...ys) + NODE_H * 2 + 30 - y }
}

/** Вид, в который целиком помещается граф, с полями `pad` экранных пикселей; крупнее 1:1 не увеличивает. */
export function fitView(wf: Workflow, width: number, height: number, pad = 32): View {
  const b = graphBounds(wf)
  if (!b || width <= 0 || height <= 0) return { x: -pad, y: -pad, scale: 1 }
  const scale = Math.min(1, Math.max(MIN_SCALE, Math.min((width - 2 * pad) / b.w, (height - 2 * pad) / b.h)))
  return { x: b.x + b.w / 2 - width / scale / 2, y: b.y + b.h / 2 - height / scale / 2, scale }
}

/** Привязка к сетке при перетаскивании ноды. */
export function snap(v: number, step = 10): number {
  return Math.round(v / step) * step
}
