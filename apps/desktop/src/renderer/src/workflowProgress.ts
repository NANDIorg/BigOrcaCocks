import { wfPorts, type GlobalTask, type StageChange, type Task, type WfEdge, type WfNode, type WfNodeType, type WfPort, type WfSubflow, type Workflow } from '@orca-board/core'
import { autoLayout } from './workflowGeometry'
import { pathGraph, pathNodeName, pathOwner } from './subtaskPath'

// Прогресс графа воркфлоу на вкладке «Граф» глобальной задачи (docs/workflow.md → «Renderer»): какие ноды и переходы
// пройдены, где граф стоит сейчас, заходы в ноду с причинами возвратов и где подзадачи этапа в своём пути. Чистые функции
// без React: только то, что уже есть в снимке (`stage`, `stageHistory`, `returns`, `Task.stageOf` / `gateFor`). Всё
// необязательно — старый main этих полей не отдаёт, тогда граф просто весь «впереди».

/** Состояние ноды на графе: пройдена, стоит сейчас, впереди. */
export type ProgressNodeState = 'done' | 'current' | 'todo'

/** Граф для обхода: граф прогона или путь подзадачи — у обоих одинаковые ноды и рёбра. */
type Graph = Pick<WfSubflow, 'nodes' | 'edges'>

/** Запись истории, по которой восстанавливается пройденный путь. */
type Entry = Pick<StageChange, 'nodeId' | 'from' | 'outcome'>

/** Ноды, на которых задача не стоит: в истории их нет, но через них граф проходит. */
const PASS_THROUGH: readonly WfNodeType[] = ['start', 'condition']

/** Исходы, которыми задачу вернули назад: захода с таким входом подсвечиваются красным. */
const RETURN_OUTCOMES: readonly string[] = ['reject', 'restart']

/**
 * Замечания при возврате пишутся в `Run.returns` в тот же момент, что и запись истории (`TaskStore.advanceRun`). Окно —
 * запас на запись с другим `Date.now()` (возврат с «Проверки»): сам переход и уточнение разнесены на миллисекунды.
 */
export const RETURN_MATCH_MS = 5_000

/**
 * Рёбра, по которым граф пришёл из `source` в `h.nodeId`. Обычно это одно ребро с исходом `h.outcome`; между ними могут
 * стоять ноды, на которых задача не задерживается (старт, условие) — тогда путь через них, кратчайший. `restart` — прыжок
 * на первый этап без ребра: пройденных рёбер нет. Ребро с нужным исходом не нашлось (граф правили) — любое из `source`.
 */
export function entryEdges(graph: Graph, source: string, h: Entry): string[] {
  if (h.outcome === 'restart') return []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const firstHop = (strict: boolean): WfEdge[] =>
    graph.edges.filter((e) => e.from === source && (!strict || h.outcome === undefined || e.outcome === h.outcome))
  for (const strict of [true, false]) {
    const queue: { at: string; path: string[] }[] = firstHop(strict).map((e) => ({ at: e.to, path: [e.id] }))
    const seen = new Set<string>()
    while (queue.length) {
      const { at, path } = queue.shift() as { at: string; path: string[] }
      if (at === h.nodeId) return path
      const node = byId.get(at)
      if (!node || seen.has(at) || !PASS_THROUGH.includes(node.type)) continue
      seen.add(at)
      for (const e of graph.edges) if (e.from === at) queue.push({ at: e.to, path: [...path, e.id] })
    }
  }
  return []
}

/** Пройденный путь по истории: сколько раз прошли каждое ребро и в какие ноды заходили (включая старт и условия). */
export interface Walk {
  edges: Record<string, number>
  entered: Set<string>
}

/**
 * Обход истории по графу. Источник записи — `from`, иначе прошлая запись, иначе старт графа: первая запись приходит
 * из старта без `from`.
 */
export function walkHistory(graph: Graph, history: readonly Entry[]): Walk {
  const edges: Record<string, number> = {}
  const entered = new Set<string>()
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const start = graph.nodes.find((n) => n.type === 'start')?.id
  let prev: string | undefined
  for (const h of history) {
    const source = h.from ?? prev ?? start
    if (source !== undefined && source !== h.nodeId) {
      for (const id of entryEdges(graph, source, h)) {
        edges[id] = (edges[id] ?? 0) + 1
        const e = graph.edges.find((x) => x.id === id)
        if (e) entered.add(e.from)
      }
    }
    if (byId.has(h.nodeId)) entered.add(h.nodeId)
    prev = h.nodeId
  }
  return { edges, entered }
}

/** Нода на графе прогресса. */
export interface ProgressNode {
  state: ProgressNodeState
  /** Сколько раз заходили (`stage.visits`, иначе по истории); 0 — не заходили. */
  visits: number
}

/** Прогресс графа глобальной задачи. */
export interface RunProgress {
  /** Где граф стоит сейчас; нет — не начат или пройден (стоит на конце, задача закрыта). */
  current?: string
  /** Заход в текущую ноду. */
  currentVisit: number
  /** В текущую ноду вернули (reject, перезапуск этапа) — плашка «сейчас» красная. */
  returned: boolean
  /** Граф пройден или задача закрыта. */
  closed: boolean
  nodes: Record<string, ProgressNode>
  /** Сколько раз прошли ребро; нет ключа — не проходили. */
  edges: Record<string, number>
}

type RunSource = Partial<Pick<GlobalTask, 'stage' | 'stageHistory' | 'closedAt'>>

/**
 * Прогресс графа прогона: пройденные ноды и рёбра по `stageHistory`, текущая нода — `stage.nodeId`. На конце графа или у
 * закрытой задачи текущей ноды нет — всё пройденное просто пройдено.
 */
export function runProgress(g: RunSource, workflow: Pick<Workflow, 'nodes' | 'edges'>): RunProgress {
  const history = g.stageHistory ?? []
  const walk = walkHistory(workflow, history)
  const stageId = g.stage?.nodeId
  const stageNode = workflow.nodes.find((n) => n.id === stageId)
  if (stageNode) walk.entered.add(stageNode.id)
  const closed = g.closedAt !== undefined || stageNode?.type === 'end'
  const current = !closed && stageNode ? stageNode.id : undefined
  const counted: Record<string, number> = {}
  for (const h of history) counted[h.nodeId] = (counted[h.nodeId] ?? 0) + 1
  const nodes: Record<string, ProgressNode> = {}
  for (const n of workflow.nodes) {
    // Условие в истории не пишется: сколько раз через него прошли — по пройденным рёбрам из него.
    const passed = n.type === 'condition' ? passExits(workflow, walk.edges, n.id).reduce((sum, x) => sum + x.count, 0) : 0
    const visits = g.stage?.visits?.[n.id] ?? counted[n.id] ?? passed
    const state: ProgressNodeState = n.id === current ? 'current' : walk.entered.has(n.id) ? 'done' : 'todo'
    nodes[n.id] = { state, visits: state === 'todo' ? 0 : Math.max(visits, n.type === 'start' ? 0 : 1) }
  }
  const lastHere = current !== undefined ? [...history].reverse().find((h) => h.nodeId === current) : undefined
  return {
    ...(current !== undefined ? { current } : {}),
    currentVisit: current !== undefined ? Math.max(1, nodes[current]?.visits ?? 1) : 0,
    returned: lastHere?.outcome !== undefined && RETURN_OUTCOMES.includes(lastHere.outcome),
    closed,
    nodes,
    edges: walk.edges
  }
}

/** Нода, которую панель показывает по умолчанию: текущая, иначе последняя, куда заходили, иначе старт. */
export function defaultProgressNode(p: RunProgress, g: RunSource, workflow: Pick<Workflow, 'nodes'>): string | undefined {
  if (p.current) return p.current
  const last = g.stageHistory?.at(-1)?.nodeId
  if (last && workflow.nodes.some((n) => n.id === last)) return last
  return workflow.nodes.find((n) => n.type === 'start')?.id ?? workflow.nodes[0]?.id
}

/** Заход в ноду для панели «Заходы». */
export interface NodeVisit {
  /** Индекс записи в `stageHistory` — ключ React. */
  index: number
  visit: number
  at: number
  /** Когда ушли: вход в следующую ноду, у закрытого прогона — `closedAt`; нет — ещё здесь (или время закрытия неизвестно). */
  till?: number
  /** Заход оборвало закрытие прогона (`closeRun` посреди графа): «сейчас» тут уже нет. */
  closed: boolean
  /** Откуда пришли; нет — из старта. */
  from?: string
  /** С каким исходом пришли (порт прошлой ноды). */
  cameWith?: string
  /** Пришли возвратом (reject, перезапуск этапа). */
  returned: boolean
  /** Куда ушли и с каким исходом. */
  to?: string
  leftWith?: string
  /** Замечания, с которыми сюда вернули (`Run.returns`). */
  reason?: string
  /** Замечания, с которыми отсюда вернули назад. */
  leftReason?: string
  /** Сводка, с которой этап сдан (`StageChange.summary`). */
  summary?: string
  /** Выбранная ветка ноды `decision`. */
  decision?: string
  /** Это текущий заход: граф стоит здесь. */
  current: boolean
}

type VisitSource = RunSource & Partial<Pick<GlobalTask, 'returns'>>

/** Уточнение из `returns`, записанное вместе с переходом в момент `at`; ближайшее в пределах `RETURN_MATCH_MS`. */
export function returnReason(returns: GlobalTask['returns'], at: number): string | undefined {
  let best: { text: string; d: number } | undefined
  for (const r of returns ?? []) {
    const d = Math.abs(r.at - at)
    if (d <= RETURN_MATCH_MS && r.text.trim() && (!best || d < best.d)) best = { text: r.text.trim(), d }
  }
  return best?.text
}

/**
 * Заходы в ноду по `stageHistory`, от старых к новым: когда пришли и ушли, откуда и с каким исходом, почему вернули.
 * Номер захода — `StageChange.visit`, у записей до поля — порядковый.
 */
export function nodeVisits(g: VisitSource, nodeId: string, current?: string): NodeVisit[] {
  const history = g.stageHistory ?? []
  const out: NodeVisit[] = []
  const closedAt = g.closedAt
  let ordinal = 0
  history.forEach((h, index) => {
    if (h.nodeId !== nodeId) return
    ordinal++
    const next = history[index + 1]
    const prev = index > 0 ? history[index - 1] : undefined
    const from = h.from ?? prev?.nodeId
    const returned = h.outcome !== undefined && RETURN_OUTCOMES.includes(h.outcome)
    const reason = returned ? returnReason(g.returns, h.at) : undefined
    const leftReason = next?.outcome !== undefined && RETURN_OUTCOMES.includes(next.outcome) ? returnReason(g.returns, next.at) : undefined
    const decision = h.decision && typeof h.decision === 'object' ? h.decision.label || h.decision.optionId : undefined
    // Прогон закрыли посреди графа: `stage` остался, но граф здесь больше не стоит — правая граница захода — закрытие.
    const closed = !next && closedAt !== undefined
    out.push({
      index,
      visit: h.visit ?? ordinal,
      at: h.at,
      ...(next ? { till: next.at, to: next.nodeId } : closed && closedAt >= h.at ? { till: closedAt } : {}),
      closed,
      ...(from !== undefined ? { from } : {}),
      ...(h.outcome !== undefined ? { cameWith: h.outcome } : {}),
      returned,
      ...(next?.outcome !== undefined ? { leftWith: next.outcome } : {}),
      ...(reason ? { reason } : {}),
      ...(leftReason ? { leftReason } : {}),
      ...(h.summary?.trim() ? { summary: h.summary.trim() } : {}),
      ...(decision ? { decision } : {}),
      current: !next && !closed && current === nodeId
    })
  })
  return out
}

/** Выход из сквозной ноды: по какому исходу и куда граф прошёл и сколько раз. */
export interface PassExit {
  edgeId: string
  outcome: WfPort
  to: string
  count: number
}

/** Нода, на которой задача не стоит (условие): в истории её нет, заходы — это проходы по её рёбрам. */
export function isPassThrough(node: Pick<WfNode, 'type'>): boolean {
  return PASS_THROUGH.includes(node.type)
}

/**
 * Куда граф вышел из сквозной ноды: пройденные рёбра из неё (`RunProgress.edges`) — исход условия, который выбрал граф.
 * Порядок — как рёбра в графе.
 */
export function passExits(graph: Graph, edges: Readonly<Record<string, number>>, nodeId: string): PassExit[] {
  return graph.edges
    .filter((e) => e.from === nodeId && (edges[e.id] ?? 0) > 0)
    .map((e) => ({ edgeId: e.id, outcome: e.outcome, to: e.to, count: edges[e.id] }))
}

type VisitTask = Pick<Task, 'stageOf' | 'gateFor' | 'createdAt'>

/**
 * Подзадачи захода: привязанные к этапу (`stageOf` — нода и заход) и проверки ноды `gate` прогона (`gateFor.runId`),
 * созданные, пока граф стоял в этом заходе. В порядке создания.
 */
export function visitTasks<T extends VisitTask>(tasks: readonly T[], nodeId: string, v: Pick<NodeVisit, 'visit' | 'at' | 'till'>): T[] {
  return tasks
    .filter((t) =>
      t.stageOf
        ? t.stageOf.nodeId === nodeId && t.stageOf.visit === v.visit
        : t.gateFor?.runId !== undefined && t.gateFor.nodeId === nodeId && t.createdAt >= v.at && (v.till === undefined || t.createdAt < v.till))
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** Шаг пилюли пути подзадачи. */
export interface PathStep {
  nodeId: string
  name: string
  state: ProgressNodeState
  /** Текущий шаг — беда: ждёт человека (конфликт мержа) или вернули на доработку. */
  bad: boolean
}

/** Исходы «вперёд» — по ним пилюля достраивает путь от текущего шага до конца. */
const FORWARD: readonly string[] = ['next', 'accept', 'ok', 'yes']

function forwardEdge(graph: Graph, node: WfNode): WfEdge | undefined {
  const out = graph.edges.filter((e) => e.from === node.id)
  const ports = wfPorts(node)
  for (const port of [...FORWARD, ...ports]) {
    const e = out.find((x) => x.outcome === port)
    if (e) return e
  }
  return out[0]
}

type PathTask = Pick<Task, 'answerFor' | 'gateFor' | 'stageOf' | 'stage' | 'stageHistory'>

/**
 * Пилюля пути подзадачи «Работа › Мерж › Конец»: шаги, где подзадача уже была (в порядке первого захода), текущий
 * шаг и дальше — путь «вперёд» до конца. Не подзадача пути (ответ, проверка, старый движок) — null.
 */
export function subtaskPathSteps(task: PathTask, workflow: Workflow | undefined): PathStep[] | null {
  const owner = pathOwner(task, workflow)
  const graph = pathGraph(task, workflow)
  if (!owner || !graph) return null
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const stays = (id: string | undefined): WfNode | undefined => {
    const n = id !== undefined ? byId.get(id) : undefined
    return n && !PASS_THROUGH.includes(n.type) ? n : undefined
  }
  const history = (task.stageHistory ?? []).filter((h) => stays(h.nodeId))
  const cur = stays(task.stage?.nodeId)
  const listed: string[] = []
  for (const h of history) if (!listed.includes(h.nodeId)) listed.push(h.nodeId)
  if (cur && !listed.includes(cur.id)) listed.push(cur.id)
  const ahead: string[] = []
  let at = cur ?? (listed.length ? byId.get(listed[listed.length - 1]) : graph.nodes.find((n) => n.type === 'start'))
  const seen = new Set<string>(listed)
  while (at && at.type !== 'end') {
    const e = forwardEdge(graph, at)
    const next = e ? byId.get(e.to) : undefined
    if (!next || seen.has(next.id)) break
    seen.add(next.id)
    if (!PASS_THROUGH.includes(next.type)) ahead.push(next.id)
    at = next
  }
  const lastOutcome = history.at(-1)?.outcome
  const step = (id: string, state: ProgressNodeState): PathStep => {
    const node = byId.get(id) as WfNode
    const isCur = state === 'current'
    return {
      nodeId: id,
      name: pathNodeName(node, owner),
      state: isCur && node.type === 'end' ? 'done' : state,
      bad: isCur && node.type !== 'end' && (node.type === 'human' || (lastOutcome !== undefined && ['reject', 'conflict', 'error'].includes(lastOutcome)))
    }
  }
  return [
    ...listed.map((id) => step(id, cur?.id === id ? 'current' : 'done')),
    ...ahead.map((id) => step(id, 'todo'))
  ]
}

/** Путь подзадачи ноды «Работа» графа прогона: свой `subflow` или путь по умолчанию. Не «Работа» — undefined. */
export function workPath(workflow: Workflow | undefined, nodeId: string): WfSubflow | undefined {
  const node = workflow?.nodes.find((n) => n.id === nodeId)
  if (node?.type !== 'work') return undefined
  return pathGraph({ stageOf: { nodeId, visit: 1 } }, workflow)
}

/** Нода пути с подзадачами, которые на ней стоят. */
export interface PathNodeProgress extends ProgressNode {
  /** Id подзадач, стоящих на ноде сейчас (на конце — никто не «стоит»: дошли). */
  here: string[]
}

/** Прогресс пути подзадачи этапа: сводка по подзадачам захода. */
export interface PathProgress {
  nodes: Record<string, PathNodeProgress>
  edges: Record<string, number>
}

/**
 * Прогресс пути подзадачи по всем подзадачам захода: нода пройдена, если через неё прошла хоть одна подзадача, «сейчас» —
 * если на ней стоит хоть одна (метка с их числом). Подзадачи не этого пути (ответы, проверки) не считаются.
 */
export function pathProgress(tasks: readonly (PathTask & Pick<Task, 'id'>)[], workflow: Workflow | undefined, nodeId: string): PathProgress | undefined {
  const graph = workPath(workflow, nodeId)
  if (!graph) return undefined
  const edges: Record<string, number> = {}
  const entered = new Set<string>()
  const here = new Map<string, string[]>()
  const visits: Record<string, number> = {}
  for (const task of tasks) {
    if (pathOwner(task, workflow)?.id !== nodeId) continue
    const history = task.stageHistory ?? []
    const walk = walkHistory(graph, history)
    for (const [id, n] of Object.entries(walk.edges)) edges[id] = (edges[id] ?? 0) + n
    for (const id of walk.entered) entered.add(id)
    for (const h of history) visits[h.nodeId] = Math.max(visits[h.nodeId] ?? 0, task.stage?.visits?.[h.nodeId] ?? 1)
    const at = task.stage?.nodeId
    const node = graph.nodes.find((n) => n.id === at)
    if (node) {
      entered.add(node.id)
      if (node.type !== 'end') here.set(node.id, [...(here.get(node.id) ?? []), task.id])
    }
  }
  const nodes: Record<string, PathNodeProgress> = {}
  for (const n of graph.nodes) {
    const ids = here.get(n.id) ?? []
    const state: ProgressNodeState = ids.length ? 'current' : entered.has(n.id) ? 'done' : 'todo'
    nodes[n.id] = { state, visits: state === 'todo' ? 0 : visits[n.id] ?? 1, here: ids }
  }
  return { nodes, edges }
}

/**
 * Граф с координатами для показа. Координаты — из самого графа (как их расставили в редакторе); у графа, где все ноды
 * в одной точке (собран кодом без раскладки), — авторасстановка `autoLayout`.
 */
export function progressLayout<G extends Graph>(graph: G): G {
  const [first] = graph.nodes
  const placed = graph.nodes.some((n) => n.x !== first?.x || n.y !== first?.y)
  if (graph.nodes.length < 2 || placed) return graph
  const laid = autoLayout({ version: 2, nodes: graph.nodes, edges: graph.edges })
  return { ...graph, nodes: laid.nodes }
}
