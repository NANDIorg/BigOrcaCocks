import { wfPorts, type GlobalTask, type StageChange, type Task, type WfEdge, type WfNode, type WfNodeType, type WfPort, type WfSubflow, type Workflow } from '@orca-board/core'
import { autoLayout } from './workflowGeometry'
import { pathGraph, pathNodeName, pathOwner } from './subtaskPath'
import { runStagePositions } from './runStage'

// Прогресс графа воркфлоу на вкладке «Граф» глобальной задачи (docs/workflow.md → «Renderer»): какие ноды и переходы
// пройдены, где граф стоит сейчас, заходы в ноду с причинами возвратов и где подзадачи этапа в своём пути. Чистые функции
// без React: только то, что уже есть в снимке (`stage`, `stageHistory`, `returns`, `Task.stageOf` / `gateFor`). Всё
// необязательно — старый main этих полей не отдаёт, тогда граф просто весь «впереди». Внутри разветвления (`lanes`) граф
// стоит сразу на нескольких нодах, записи истории разных путей перемешаны по времени — последовательность внутри пути
// восстанавливается по `StageChange.lane`.

/**
 * Запись прихода пути в слияние (`StageChange.arrived`): отметка «путь пришёл и ждёт», а не заход в `join` — заход у
 * слияния один на поколение путей. Запись пути на ноде `join` без флага (снимок до поля, если миграция main не прошла) —
 * тоже приход: других записей пути на `join` не бывает.
 */
export function isArrival(h: Pick<StageChange, 'arrived' | 'lane' | 'nodeId'>, graph?: Pick<WfSubflow, 'nodes'>): boolean {
  if (h.arrived === true) return true
  return h.lane !== undefined && graph?.nodes.find((n) => n.id === h.nodeId)?.type === 'join'
}

/** Слияние путей в истории (`joinMerges`). */
export interface JoinMerge {
  joinId: string
  /** Индекс записи основного хода, вышедшей из слияния: своей записи у слияния нет. */
  index: number
  /** Номер слияния (заход в `join`): `visit` записей прихода, у записей до поля — порядковый у этой ноды. */
  visit: number
}

/**
 * Слияния по истории. Пока пути идут, основной ход стоит на `fork` и записей без `lane` не пишет; первая запись без
 * `lane` после приходов путей — выход из слияния (`from: join`; у записей без `from` — тоже он).
 */
export function joinMerges(history: readonly StageChange[], graph?: Pick<WfSubflow, 'nodes'>): JoinMerge[] {
  const out: JoinMerge[] = []
  let pending: StageChange | undefined
  history.forEach((h, index) => {
    if (isArrival(h, graph)) pending = h
    else if (h.lane === undefined && pending) {
      const joinId = pending.nodeId
      out.push({ joinId, index, visit: pending.visit ?? out.filter((m) => m.joinId === joinId).length + 1 })
      pending = undefined
    }
  })
  return out
}

/** Состояние ноды на графе: пройдена, стоит сейчас, слияние ждёт остальные пути, впереди. */
export type ProgressNodeState = 'done' | 'current' | 'waiting' | 'todo'

/** Граф для обхода: граф прогона или путь подзадачи — у обоих одинаковые ноды и рёбра. */
type Graph = Pick<WfSubflow, 'nodes' | 'edges'>

/** Запись истории, по которой восстанавливается пройденный путь. */
type Entry = Pick<StageChange, 'nodeId' | 'from' | 'outcome' | 'lane'>

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
 * Обход истории по графу. Источник записи — `from`, иначе прошлая запись того же пути (`lane`; у основного хода — прошлая
 * основная), иначе старт графа: первая запись приходит из старта без `from`. Записи путей перемешаны по времени, поэтому
 * «прошлая запись» считается по пути: первая запись пути без `from` идёт от ноды, где стоял основной ход (`fork`), а
 * путь, пришедший в `join`, становится источником основного хода после слияния.
 */
export function walkHistory(graph: Graph, history: readonly Entry[]): Walk {
  const edges: Record<string, number> = {}
  const entered = new Set<string>()
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const start = graph.nodes.find((n) => n.type === 'start')?.id
  let trunk: string | undefined
  let lanes = new Map<string, string>()
  for (const h of history) {
    const prev = h.lane !== undefined ? lanes.get(h.lane) ?? trunk : trunk
    const source = h.from ?? prev ?? start
    if (source !== undefined && source !== h.nodeId) {
      for (const id of entryEdges(graph, source, h)) {
        edges[id] = (edges[id] ?? 0) + 1
        const e = graph.edges.find((x) => x.id === id)
        if (e) entered.add(e.from)
      }
    }
    if (byId.has(h.nodeId)) entered.add(h.nodeId)
    if (h.lane === undefined) {
      // Основной ход: новое разветвление начинает пути заново.
      trunk = h.nodeId
      lanes = new Map()
    } else {
      lanes.set(h.lane, h.nodeId)
      if (byId.get(h.nodeId)?.type === 'join') trunk = h.nodeId
    }
  }
  return { edges, entered }
}

/** Нода на графе прогресса. */
export interface ProgressNode {
  state: ProgressNodeState
  /** Сколько раз заходили (`stage.visits`, иначе по истории); 0 — не заходили. */
  visits: number
}

/** Нода, на которой граф стоит сейчас (без путей — одна, внутри разветвления — по одной на путь). */
export interface ProgressCurrent {
  nodeId: string
  /** Заход в ноду. */
  visit: number
  /** Сюда вернули (reject, перезапуск этапа) — плашка «сейчас» красная. */
  returned: boolean
  /** Путь разветвления (`GlobalTaskLane.id`); нет — основной ход. */
  lane?: string
}

/** Путь разветвления на графе: где стоит и пришёл ли в слияние. */
export interface ProgressLane {
  id: string
  forkId: string
  nodeId: string
  arrived: boolean
}

/** Прогресс графа глобальной задачи. */
export interface RunProgress {
  /**
   * Где граф стоит сейчас — первая из `currents` (прежнее поле: одна текущая нода); нет — не начат, пройден (стоит на
   * конце, задача закрыта) или все пути разветвления уже в слиянии.
   */
  current?: string
  /** Заход в `current`. */
  currentVisit: number
  /** В `current` вернули (reject, перезапуск этапа) — плашка «сейчас» красная. */
  returned: boolean
  /** Все ноды «сейчас»: без путей — одна (`current`), внутри разветвления — по одной на путь, ещё не пришедший в слияние. */
  currents: ProgressCurrent[]
  /** Пути разветвления, пока граф внутри него (`GlobalTask.lanes`); без путей — пусто. */
  lanes: ProgressLane[]
  /** Граф пройден или задача закрыта. */
  closed: boolean
  nodes: Record<string, ProgressNode>
  /** Сколько раз прошли ребро; нет ключа — не проходили. */
  edges: Record<string, number>
}

type RunSource = Partial<Pick<GlobalTask, 'stage' | 'stageHistory' | 'closedAt' | 'lanes'>>

/**
 * Прогресс графа прогона: пройденные ноды и рёбра по `stageHistory`, текущая нода — `stage.nodeId`, а внутри разветвления
 * — нода каждого пути (`lanes`); путь, пришедший в `join`, делает слияние «ждёт остальные». На конце графа или у закрытой
 * задачи текущей ноды нет — всё пройденное просто пройдено.
 */
export function runProgress(g: RunSource, workflow: Pick<Workflow, 'nodes' | 'edges'>): RunProgress {
  const history = g.stageHistory ?? []
  const walk = walkHistory(workflow, history)
  const has = (id: string): boolean => workflow.nodes.some((n) => n.id === id)
  const stageNode = workflow.nodes.find((n) => n.id === g.stage?.nodeId)
  const positions = runStagePositions(g).filter((p) => has(p.nodeId))
  if (stageNode) walk.entered.add(stageNode.id)
  for (const p of positions) walk.entered.add(p.nodeId)
  const closed = g.closedAt !== undefined || stageNode?.type === 'end'
  const lanes: ProgressLane[] = (g.lanes ?? []).map((l) => ({ id: l.id, forkId: l.forkId, nodeId: l.nodeId, arrived: l.arrivedAt !== undefined }))
  const active = closed ? [] : positions.filter((p) => !p.arrived)
  const waiting = new Set(closed ? [] : positions.filter((p) => p.arrived).map((p) => p.nodeId))
  const currentIds = new Set(active.map((p) => p.nodeId))
  // Заходы по истории (нет `stage.visits`): приход пути в слияние — не заход; заход в `join` — само слияние (`joinMerges`).
  const counted: Record<string, number> = {}
  for (const h of history) if (!isArrival(h, workflow)) counted[h.nodeId] = (counted[h.nodeId] ?? 0) + 1
  for (const m of joinMerges(history, workflow)) counted[m.joinId] = (counted[m.joinId] ?? 0) + 1
  const nodes: Record<string, ProgressNode> = {}
  for (const n of workflow.nodes) {
    // Условие в истории не пишется: сколько раз через него прошли — по пройденным рёбрам из него.
    const passed = n.type === 'condition' ? passExits(workflow, walk.edges, n.id).reduce((sum, x) => sum + x.count, 0) : 0
    const visits = g.stage?.visits?.[n.id] ?? counted[n.id] ?? passed
    const state: ProgressNodeState = currentIds.has(n.id) ? 'current' : waiting.has(n.id) ? 'waiting' : walk.entered.has(n.id) ? 'done' : 'todo'
    nodes[n.id] = { state, visits: state === 'todo' ? 0 : Math.max(visits, n.type === 'start' ? 0 : 1) }
  }
  const currents = active.map((p): ProgressCurrent => {
    // Ноды разных путей не пересекаются: последняя запись этой ноды — вход именно этого пути.
    const lastHere = [...history].reverse().find((h) => h.nodeId === p.nodeId)
    return {
      nodeId: p.nodeId,
      visit: Math.max(1, nodes[p.nodeId]?.visits ?? 1),
      returned: lastHere?.outcome !== undefined && RETURN_OUTCOMES.includes(lastHere.outcome),
      ...(p.lane !== undefined ? { lane: p.lane } : {})
    }
  })
  const [first] = currents
  return {
    ...(first ? { current: first.nodeId } : {}),
    currentVisit: first?.visit ?? 0,
    returned: first?.returned ?? false,
    currents,
    lanes: closed ? [] : lanes,
    closed,
    nodes,
    edges: walk.edges
  }
}

/**
 * Нода, которую панель показывает по умолчанию: текущая (первая из путей), иначе слияние, где ждут пути, иначе последняя,
 * куда заходили, иначе старт.
 */
export function defaultProgressNode(p: RunProgress, g: RunSource, workflow: Pick<Workflow, 'nodes'>): string | undefined {
  if (p.current) return p.current
  const waiting = p.lanes.find((l) => l.arrived)?.nodeId
  if (waiting) return waiting
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
  /** Путь разветвления, в котором был заход (`StageChange.lane`); нет — основной ход. */
  lane?: string
  /**
   * Только у слияния (`join`): заход — одно слияние, а это приходы путей в него, по времени. `at` захода — приход первого
   * пути, `till` — само слияние (выход основного хода из `join`); пока пришли не все — «ждёт», `till` нет.
   */
  arrivals?: LaneArrival[]
}

/** Путь пришёл в слияние (запись `arrived`). */
export interface LaneArrival {
  index: number
  /** Путь (`StageChange.lane`); нет — у старой записи без поля. */
  lane?: string
  at: number
  /** Откуда пришёл: последняя нода пути. */
  from?: string
}

type VisitSource = RunSource & Partial<Pick<GlobalTask, 'returns'>>

/**
 * Уточнение из `returns`, записанное вместе с переходом в момент `at`; ближайшее в пределах `RETURN_MATCH_MS`. `nodeId` —
 * нода, с которой вернули: два пути разветвления могут вернуться почти одновременно, и уточнение с другой нодой
 * (`returns[].nodeId`) не подходит. Уточнение без ноды (старый main, возврат без ноды) сопоставляется по времени.
 */
export function returnReason(returns: GlobalTask['returns'], at: number, nodeId?: string): string | undefined {
  let best: { text: string; d: number } | undefined
  for (const r of returns ?? []) {
    if (nodeId !== undefined && r.nodeId !== undefined && r.nodeId !== nodeId) continue
    const d = Math.abs(r.at - at)
    if (d <= RETURN_MATCH_MS && r.text.trim() && (!best || d < best.d)) best = { text: r.text.trim(), d }
  }
  return best?.text
}

/**
 * Следующая запись после `index` в том же ходе графа: записи путей разветвления перемешаны по времени. У основного хода —
 * следующая основная или первая запись, пришедшая прямо отсюда (вход пути из `fork`); у пути — следующая запись пути или
 * основной ход, вышедший отсюда (из `join` после слияния). Без путей — просто следующая запись.
 */
function nextInLane(history: readonly StageChange[], index: number): StageChange | undefined {
  const h = history[index]
  for (let i = index + 1; i < history.length; i++) {
    const r = history[i]
    if (r.lane === h.lane || r.from === h.nodeId) return r
  }
  return undefined
}

/** Прошлая запись того же хода графа: того же пути, иначе основного хода. */
function prevInLane(history: readonly StageChange[], index: number): StageChange | undefined {
  const lane = history[index].lane
  for (const own of lane !== undefined ? [true, false] : [true]) {
    for (let i = index - 1; i >= 0; i--) if (own ? history[i].lane === lane : history[i].lane === undefined) return history[i]
  }
  return undefined
}

/**
 * Заходы в ноду по `stageHistory`, от старых к новым: когда пришли и ушли, откуда и с каким исходом, почему вернули.
 * Номер захода — `StageChange.visit`, у записей до поля — порядковый. `current` — нода «сейчас» или все ноды «сейчас»
 * (`RunProgress.currents`): у разветвления их несколько. «Ушли» считается внутри своего пути (`nextInLane`). У слияния —
 * заход на слияние, приходы путей внутри него (`joinVisits`); `graph` узнаёт приход у записи без флага `arrived`.
 */
export function nodeVisits(g: VisitSource, nodeId: string, current?: string | readonly string[], graph?: Pick<WfSubflow, 'nodes'>): NodeVisit[] {
  const history = g.stageHistory ?? []
  if (history.some((h) => h.nodeId === nodeId && isArrival(h, graph))) return joinVisits(g, nodeId, graph)
  const out: NodeVisit[] = []
  const closedAt = g.closedAt
  const isCurrent = current === undefined ? false : typeof current === 'string' ? current === nodeId : current.includes(nodeId)
  let ordinal = 0
  history.forEach((h, index) => {
    if (h.nodeId !== nodeId) return
    ordinal++
    const next = nextInLane(history, index)
    const from = h.from ?? prevInLane(history, index)?.nodeId
    const returned = h.outcome !== undefined && RETURN_OUTCOMES.includes(h.outcome)
    const reason = returned ? returnReason(g.returns, h.at, from) : undefined
    const leftReason = next?.outcome !== undefined && RETURN_OUTCOMES.includes(next.outcome) ? returnReason(g.returns, next.at, nodeId) : undefined
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
      current: !next && !closed && isCurrent,
      ...(h.lane !== undefined ? { lane: h.lane } : {})
    })
  })
  return out
}

/**
 * Заходы в слияние: по одному на слияние поколения путей, а не на приход каждого пути (приходы — `arrivals`). Номер —
 * `visit` записей прихода (номер слияния, которого ждут пути; у одного поколения общий), у записей до поля — порядковый.
 * Слияние закрывает выход основного хода из `join` (`joinMerges`). Незакрытое — «ждёт» (`current`), пока прогон не закрыт.
 */
function joinVisits(g: VisitSource, nodeId: string, graph?: Pick<WfSubflow, 'nodes'>): NodeVisit[] {
  const history = g.stageHistory ?? []
  const merged = new Map(joinMerges(history, graph).filter((m) => m.joinId === nodeId).map((m) => [m.index, m]))
  const out: NodeVisit[] = []
  let open: NodeVisit | undefined
  history.forEach((h, index) => {
    if (h.nodeId === nodeId && isArrival(h, graph)) {
      const from = h.from ?? prevInLane(history, index)?.nodeId
      if (!open) {
        open = { index, visit: h.visit ?? out.length + 1, at: h.at, closed: false, returned: false, current: false, arrivals: [] }
        out.push(open)
      }
      open.arrivals?.push({ index, at: h.at, ...(h.lane !== undefined ? { lane: h.lane } : {}), ...(from !== undefined ? { from } : {}) })
      return
    }
    if (open && merged.has(index)) {
      open.till = h.at
      open.to = h.nodeId
      if (h.outcome !== undefined) open.leftWith = h.outcome
      open = undefined
    }
  })
  const last = out.at(-1)
  if (last && last.till === undefined) {
    if (g.closedAt !== undefined) {
      last.closed = true
      if (g.closedAt >= last.at) last.till = g.closedAt
    } else last.current = true
  }
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
