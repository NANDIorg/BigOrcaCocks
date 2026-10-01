import { wfPorts, NODE_H, PORT_STEP, nodeHeight, type WfEdge, type WfNode, type WfPort, type Workflow } from '@orca-board/core'
// Совместимые экспорты: геометрия редактора и создаваемые ассистентом графы используют общую раскладку core.
export { autoLayout, NODE_H, PORT_STEP, LAYOUT_DX, LAYOUT_DY, nodeHeight } from '@orca-board/core'

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

/**
 * Размер ноды. Ширина одна на все типы, `NODE_H` — высота ноды с портами фиксированных типов (до двух): подписи исходов
 * снаружи справа. Нода `decision` с большим числом вариантов (`fork` с тремя-четырьмя путями) выше — см. `nodeHeight`.
 */
export const NODE_W = 150
/** Радиус порта при попадании курсором — больше нарисованного кружка, чтобы не целиться в пиксель. */
export const PORT_HIT_R = 9

/**
 * Сколько символов подписи порта видно на холсте. Подпись стоит снаружи справа над портом; у ноды с тремя и больше
 * портами (пути `fork`, варианты `decision`) рёбра верхних портов уходят вниз прямо через подписи нижних — короткая
 * подпись там не перекрывается рёбрами. Полная — в подсказке порта и в инспекторе.
 */
export function portLabelMax(node: WfNode): number {
  return wfPorts(node).length > 2 ? 10 : 16
}

export function nodeRect(node: WfNode): Rect {
  return { x: node.x, y: node.y, w: NODE_W, h: nodeHeight(node) }
}

/** Вход ноды — середина левой стороны: все рёбра входят сюда. */
export function inputPoint(node: WfNode): Point {
  return { x: node.x, y: node.y + nodeHeight(node) / 2 }
}

/** Порт исхода — на правой стороне, порты делят высоту поровну в порядке `wfPorts`. */
export function portPoint(node: WfNode, outcome: WfPort): Point {
  const ports = wfPorts(node)
  const i = Math.max(0, ports.indexOf(outcome))
  return { x: node.x + NODE_W, y: node.y + (nodeHeight(node) * (i + 1)) / (ports.length + 1) }
}

/** Кубическая кривая Безье: начало, две контрольные точки, конец. */
export type Curve = [Point, Point, Point, Point]

/**
 * Кривая ребра от порта к входу. Вперёд — плавная S-кривая. Назад (отказ «обратно в работу») и в себя —
 * петля, уходящая вниз: иначе кривая прошла бы сквозь ноды между источником и целью.
 * Касательная в конце всегда горизонтальна слева направо — стрелку можно рисовать без поворота.
 * `bottom` — низ самой низкой из двух нод: у высокой ноды (`decision` со многими вариантами) петля опускается так,
 * чтобы её середина прошла под этим низом. Без него (черновик ребра к курсору) — ниже точек на высоту обычной ноды.
 */
export function edgeCurve(from: Point, to: Point, bottom?: number): Curve {
  const dx = to.x - from.x
  if (dx >= 40) {
    const c = Math.max(40, dx / 2)
    return [from, { x: from.x + c, y: from.y }, { x: to.x - c, y: to.y }, to]
  }
  const c = Math.max(80, Math.abs(dx) / 4)
  const base = Math.max(from.y, to.y) + NODE_H + 30
  // Середина кривой по y — (from.y + to.y) / 8 + 3/4 · drop: отсюда глубина, при которой середина на 20 ниже `bottom`.
  const drop = bottom === undefined ? base : Math.max(base, (bottom + 20 - (from.y + to.y) / 8) / 0.75)
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
  const bottom = Math.max(from.y + nodeHeight(from), to.y + nodeHeight(to))
  return edgeCurve(portPoint(from, edge.outcome), inputPoint(to), bottom)
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
export function hitPort(wf: Workflow, p: Point): { nodeId: string; outcome: WfPort } | undefined {
  let best: { nodeId: string; outcome: WfPort; d: number } | undefined
  for (const n of wf.nodes) {
    for (const outcome of wfPorts(n)) {
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
  const x = Math.min(...xs)
  const y = Math.min(...wf.nodes.map((n) => n.y))
  const bottom = Math.max(...wf.nodes.map((n) => n.y + nodeHeight(n)))
  return { x, y, w: Math.max(...xs) + NODE_W + 60 - x, h: bottom + NODE_H + 30 - y }
}

/** Подпись ребра для раскладки (`placeEdgeLabels`): кривая ребра, ширина текста и где подпись у петли возврата. */
export interface EdgeLabelInput {
  id: string
  curve: Curve
  /** Ширина подписи в мировых координатах (оценка по числу символов). */
  width: number
  /** Петля назад: подпись под кривой, иначе над ней. */
  back: boolean
}

/** Высота строки подписи ребра и отступ базовой линии от кривой (над кривой у прямого, под — у петли). */
const LABEL_H = 12
const LABEL_ABOVE = 6
const LABEL_BELOW = 14
/** Где на кривой пробовать подпись: середина, потом ближе к концам. */
const LABEL_TS = [0.5, 0.38, 0.62, 0.27, 0.73, 0.18, 0.82]

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Точки подписей рёбер (центр по X, базовая линия по Y) без наложений: подпись идёт в середину кривой, а если там уже
 * стоит другая подпись или нода (петли возврата двух параллельных путей проходят рядом), — сдвигается вдоль кривой.
 * Свободного места нет — точка с наименьшим перекрытием. Порядок входа — приоритет: ранние подписи стоят в середине.
 * `extra` — что ещё занято (плашки над нодами).
 */
export function placeEdgeLabels(labels: readonly EdgeLabelInput[], nodes: readonly WfNode[], extra: readonly Rect[] = []): Record<string, Point> {
  const blocked: Rect[] = [...nodes.map(nodeRect), ...extra]
  const out: Record<string, Point> = {}
  for (const l of labels) {
    let best: { p: Point; box: Rect; cost: number } | undefined
    for (const t of LABEL_TS) {
      const c = curvePoint(l.curve, t)
      const p = { x: c.x, y: l.back ? c.y + LABEL_BELOW : c.y - LABEL_ABOVE }
      const box = { x: p.x - l.width / 2 - 2, y: p.y - LABEL_H + 2, w: l.width + 4, h: LABEL_H }
      const cost = blocked.reduce((sum, r) => sum + overlap(box, r), 0)
      if (!best || cost < best.cost) best = { p, box, cost }
      if (cost === 0) break
    }
    if (!best) continue
    out[l.id] = best.p
    blocked.push(best.box)
  }
  return out
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
