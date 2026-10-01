import { wfPorts, type WfNode, type Workflow } from './workflow.ts'

// Общая раскладка графа нужна и редактору, и ассистенту: одинаковая геометрия исключает ручную доводку созданного графа.
export const NODE_H = 60
/** Не меньше двух радиусов попадания в порт редактора: соседние варианты доступны раздельно. */
export const PORT_STEP = 20
/** Шаг слоёв совпадает с defaultWorkflow; высота слоя растёт для нод с несколькими портами. */
export const LAYOUT_DX = 220
export const LAYOUT_DY = 110

export function nodeHeight(node: WfNode): number {
  return Math.max(NODE_H, PORT_STEP * (wfPorts(node).length + 1))
}

function snap(value: number): number {
  return Math.round(value / 10) * 10
}

interface Point { x: number; y: number }

/**
 * Авторасстановка по слоям: слой ноды — длина кратчайшего пути от старта (BFS), поэтому рёбра-возвраты
 * (reject → работа) слои не сдвигают. Внутри слоя порядок — порядок обхода, то есть порядок портов
 * у родителя: пути `fork` встают стопкой один под другим. Слияние (`join`) ждёт все пути, поэтому встаёт правее самого
 * длинного из них: до него обход доходит, только когда разложено всё, что достижимо в обход слияний. Недостижимые от
 * старта ноды — отдельным слоем справа, чтобы их было видно. По вертикали — обход в глубину (`descend`): ветка идёт
 * рядом родителя, пути `fork` — горизонтальными рядами один под другим, слияние — посередине между ними. Ноды слоя не
 * ближе `LAYOUT_DY`, под высокой нодой (много вариантов `decision` или путей `fork`) — с тем же зазором от её низа.
 */
export function autoLayout(wf: Workflow): Workflow {
  const layer = new Map<string, number>()
  const order: string[] = []
  const start = wf.nodes.find((n) => n.type === 'start')
  if (start) {
    layer.set(start.id, 0)
    const queue = [start.id]
    /** Слияния, до которых дошёл обход: слой им назначается, когда очередь опустеет. */
    const waiting: string[] = []
    while (queue.length) {
      const id = queue.shift()!
      order.push(id)
      const node = wf.nodes.find((n) => n.id === id)!
      const ports = wfPorts(node)
      const out = wf.edges
        .filter((e) => e.from === id)
        .sort((a, b) => ports.indexOf(a.outcome) - ports.indexOf(b.outcome))
      for (const e of out) {
        const to = wf.nodes.find((n) => n.id === e.to)
        if (layer.has(e.to) || !to) continue
        if (to.type === 'join') {
          if (!waiting.includes(to.id)) waiting.push(to.id)
          continue
        }
        layer.set(e.to, layer.get(id)! + 1)
        queue.push(e.to)
      }
      if (queue.length === 0 && waiting.length > 0) {
        for (const joinId of waiting.splice(0)) {
          if (layer.has(joinId)) continue
          const before = wf.edges.filter((e) => e.to === joinId && layer.has(e.from)).map((e) => layer.get(e.from)!)
          layer.set(joinId, Math.max(...before) + 1)
          queue.push(joinId)
        }
      }
    }
  }
  const lastLayer = order.length ? Math.max(...layer.values()) + 1 : 0
  for (const n of wf.nodes) {
    if (layer.has(n.id)) continue
    layer.set(n.id, lastLayer)
    order.push(n.id)
  }
  const byId = new Map(wf.nodes.map((n) => [n.id, n]))
  const gap = LAYOUT_DY - NODE_H
  /** Первая свободная высота слоя: ноды слоя не налезают друг на друга, под высокой нодой — тот же зазор. */
  const floor = new Map<number, number>()
  const y = new Map<string, number>()
  const put = (id: string, want: number): void => {
    const l = layer.get(id)!
    const v = Math.max(want, floor.get(l) ?? 0)
    y.set(id, v)
    floor.set(l, v + Math.max(LAYOUT_DY, nodeHeight(byId.get(id)!) + gap))
  }
  /** Слияния, до которых дошёл обход: встают, когда разложены все пути их разветвления. */
  const pending: string[] = []
  const placeJoin = (id: string): void => {
    pending.splice(pending.indexOf(id), 1)
    // По вертикали — посередине между нодами, которые в него входят (последние ноды путей).
    const from = wf.edges.filter((e) => e.to === id && y.has(e.from)).map((e) => byId.get(e.from)!)
    const top = Math.min(...from.map((n) => y.get(n.id)!))
    const bottom = Math.max(...from.map((n) => y.get(n.id)! + nodeHeight(n)))
    put(id, from.length ? Math.max(0, snap((top + bottom - nodeHeight(byId.get(id)!)) / 2)) : 0)
    descend(id)
  }
  // Обход в глубину по рёбрам вперёд (в следующие слои): ветка встаёт в ряд своего родителя, а соседние ветки — ниже,
  // насколько пустят уже разложенные. Пути `fork` — полосами: каждый следующий путь начинается ниже всего, что заняли
  // предыдущие, поэтому путь идёт одним горизонтальным рядом, даже если он короче или длиннее соседнего.
  const descend = (id: string): void => {
    const node = byId.get(id)!
    const ports = wfPorts(node)
    const out = wf.edges
      .filter((e) => e.from === id && byId.has(e.to) && (layer.get(e.to) ?? -1) > layer.get(id)!)
      .sort((a, b) => ports.indexOf(a.outcome) - ports.indexOf(b.outcome))
    let lane = 0
    for (const e of out) {
      if (y.has(e.to)) continue
      if (byId.get(e.to)!.type === 'join') {
        if (!pending.includes(e.to)) pending.push(e.to)
        continue
      }
      let want = y.get(id)!
      if (node.type === 'fork' && lane++ > 0) {
        for (const [l, f] of floor) if (l > layer.get(id)!) want = Math.max(want, f)
      }
      put(e.to, want)
      descend(e.to)
    }
    if (node.type !== 'fork') return
    for (const j of [...pending]) {
      const join = byId.get(j)
      if (join?.type === 'join' && join.forkId === id) placeJoin(j)
    }
  }
  if (start) {
    put(start.id, 0)
    descend(start.id)
    // Слияния без своего разветвления (битый граф) — после всего остального.
    while (pending.length) placeJoin(pending[0])
  }
  for (const id of order) if (!y.has(id)) put(id, 0)
  const pos = new Map<string, Point>()
  for (const id of order) pos.set(id, { x: layer.get(id)! * LAYOUT_DX, y: y.get(id)! })
  return { ...wf, nodes: wf.nodes.map((n) => ({ ...n, ...pos.get(n.id)! })) }
}
